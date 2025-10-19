import { ethers } from 'ethers';
import { Logger } from '../utils/Logger';
import {
  OneTapBet,
  OneTapBetStatus,
  PlaceOneTapBetRequest,
  GetOneTapBetsQuery,
  OneTapProfitStats,
  CalculateMultiplierRequest,
  CalculateMultiplierResponse,
} from '../types/oneTapProfit';

const OneTapProfitABI = [
  'function placeBetMeta(address trader, string symbol, uint256 betAmount, uint256 targetPrice, uint256 targetTime, uint256 entryPrice, uint256 entryTime, bytes userSignature) external returns (uint256)',
  'function settleBet(uint256 betId, uint256 currentPrice, uint256 currentTime, bool won) external',
  'function getBet(uint256 betId) external view returns (uint256 id, address trader, string symbol, uint256 betAmount, uint256 targetPrice, uint256 targetTime, uint256 entryPrice, uint256 entryTime, uint256 multiplier, uint8 status, uint256 settledAt, uint256 settlePrice)',
  'function getUserBets(address user) external view returns (uint256[])',
  'function getActiveBetsCount() external view returns (uint256)',
  'function calculateMultiplier(uint256 entryPrice, uint256 targetPrice, uint256 entryTime, uint256 targetTime) public pure returns (uint256)',
  'function nextBetId() external view returns (uint256)',
  'event BetPlaced(uint256 indexed betId, address indexed trader, string symbol, uint256 betAmount, uint256 targetPrice, uint256 targetTime, uint256 entryPrice, uint256 multiplier)',
  'event BetSettled(uint256 indexed betId, address indexed trader, uint8 status, uint256 payout, uint256 fee, uint256 settlePrice)',
];

/**
 * OneTapProfitService - Manages One Tap Profit bets
 * 
 * This service:
 * 1. Stores active bets in memory for monitoring
 * 2. Places bets on-chain via relayer
 * 3. Monitors price and time conditions
 * 4. Settles bets automatically
 */
export class OneTapProfitService {
  private readonly logger = new Logger('OneTapProfitService');
  private contract: ethers.Contract;
  private provider: ethers.Provider;
  private relayer: ethers.Wallet;
  
  // In-memory storage for active bets
  private bets: Map<string, OneTapBet> = new Map();
  private betsByTrader: Map<string, string[]> = new Map();
  
  constructor() {
    // Setup provider and relayer
    const rpcUrl = process.env.RPC_URL || 'https://sepolia.base.org';
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    
    const relayPrivateKey = process.env.RELAY_PRIVATE_KEY;
    if (!relayPrivateKey) {
      throw new Error('RELAY_PRIVATE_KEY not set in environment');
    }
    this.relayer = new ethers.Wallet(relayPrivateKey, this.provider);
    
    // Setup contract
    const contractAddress = process.env.ONE_TAP_PROFIT_ADDRESS;
    if (!contractAddress) {
      throw new Error('ONE_TAP_PROFIT_ADDRESS not set in environment');
    }
    
    this.contract = new ethers.Contract(contractAddress, OneTapProfitABI, this.relayer);
    
    this.logger.success(`✅ OneTapProfitService initialized`);
    this.logger.info(`📝 Contract: ${contractAddress}`);
    this.logger.info(`💰 Relayer: ${this.relayer.address}`);
  }
  
  
  /**
   * Place a bet - Execute on-chain IMMEDIATELY
   * User pays USDC now, backend settles later when conditions met
   */
  async placeBet(request: PlaceOneTapBetRequest): Promise<{ betId: string; txHash: string; }> {
    try {
      const GRID_Y_DOLLARS = 0.05; // Same as backend monitor
      const targetPriceNum = parseFloat(request.targetPrice);
      const gridBottomPrice = targetPriceNum - (GRID_Y_DOLLARS / 2);
      const gridTopPrice = targetPriceNum + (GRID_Y_DOLLARS / 2);
      
      // Convert UTC timestamps to GMT+7 for logging
      const toGMT7 = (timestamp: number) => {
        const date = new Date(timestamp * 1000);
        date.setHours(date.getHours() + 7); // Add 7 hours for GMT+7
        return date.toISOString().replace('T', ' ').substring(0, 19) + ' GMT+7';
      };
      
      this.logger.info(`🎯 Placing One Tap Profit bet on-chain for ${request.trader}`);
      this.logger.info(`   Symbol: ${request.symbol}`);
      this.logger.info(`   Entry Price: $${parseFloat(request.entryPrice).toFixed(2)} at ${toGMT7(request.entryTime)}`);
      this.logger.info(`   Grid Price Range: $${gridBottomPrice.toFixed(2)} - $${gridTopPrice.toFixed(2)} (center: $${targetPriceNum.toFixed(2)})`);
      this.logger.info(`   Time Window: ${toGMT7(request.entryTime)} → ${toGMT7(request.targetTime)}`);
      
      // Fix floating point precision
      const betAmountFixed = parseFloat(request.betAmount).toFixed(6);
      const targetPriceFixed = parseFloat(request.targetPrice).toFixed(8);
      const entryPriceFixed = parseFloat(request.entryPrice).toFixed(8);
      
      const betAmount = ethers.parseUnits(betAmountFixed, 6);
      const targetPrice = ethers.parseUnits(targetPriceFixed, 8);
      const entryPrice = ethers.parseUnits(entryPriceFixed, 8);
      
      // Place bet on-chain via relayer
      const tx = await this.contract.placeBetMeta(
        request.trader,
        request.symbol,
        betAmount,
        targetPrice,
        request.targetTime,
        entryPrice,
        request.entryTime,
        request.userSignature
      );
      
      this.logger.info(`⏳ Waiting for transaction: ${tx.hash}`);
      const receipt = await tx.wait();
      
      // Extract on-chain betId from event
      const event = receipt.logs.find((log: any) => {
        try {
          const parsed = this.contract.interface.parseLog(log);
          return parsed?.name === 'BetPlaced';
        } catch {
          return false;
        }
      });
      
      const parsedEvent = this.contract.interface.parseLog(event);
      const onChainBetId = parsedEvent?.args?.betId?.toString();
      
      // Calculate multiplier
      const multiplierResult = await this.calculateMultiplier({
        entryPrice: request.entryPrice,
        targetPrice: request.targetPrice,
        entryTime: request.entryTime,
        targetTime: request.targetTime,
      });
      
      // Store in memory for monitoring
      const bet: OneTapBet = {
        betId: onChainBetId,
        trader: request.trader.toLowerCase(),
        symbol: request.symbol,
        betAmount: request.betAmount,
        targetPrice: request.targetPrice,
        targetTime: request.targetTime,
        entryPrice: request.entryPrice,
        entryTime: request.entryTime,
        multiplier: multiplierResult.multiplier,
        status: OneTapBetStatus.ACTIVE,
        createdAt: Date.now(),
      };
      
      this.bets.set(onChainBetId, bet);
      
      const traderBets = this.betsByTrader.get(bet.trader) || [];
      traderBets.push(onChainBetId);
      this.betsByTrader.set(bet.trader, traderBets);
      
      this.logger.success(`✅ Bet placed on-chain! BetId: ${onChainBetId}, TxHash: ${tx.hash}`);
      
      return { betId: onChainBetId, txHash: tx.hash };
    } catch (error: any) {
      this.logger.error('Failed to place bet:', error);
      throw new Error(`Failed to place bet: ${error.message}`);
    }
  }
  
  /**
   * Sync bet from blockchain to local storage
   */
  async syncBetFromChain(betId: string): Promise<OneTapBet> {
    try {
      const betData = await this.contract.getBet(betId);
      
      const bet: OneTapBet = {
        betId: betData.id.toString(),
        trader: betData.trader.toLowerCase(),
        symbol: betData.symbol,
        betAmount: ethers.formatUnits(betData.betAmount, 6),
        targetPrice: ethers.formatUnits(betData.targetPrice, 8),
        targetTime: Number(betData.targetTime),
        entryPrice: ethers.formatUnits(betData.entryPrice, 8),
        entryTime: Number(betData.entryTime),
        multiplier: Number(betData.multiplier),
        status: this.mapStatus(Number(betData.status)),
        settledAt: betData.settledAt > 0 ? Number(betData.settledAt) : undefined,
        settlePrice: betData.settlePrice > 0 ? ethers.formatUnits(betData.settlePrice, 8) : undefined,
        createdAt: Date.now(),
      };
      
      // Store in memory
      this.bets.set(betId, bet);
      
      // Index by trader
      const traderBets = this.betsByTrader.get(bet.trader) || [];
      if (!traderBets.includes(betId)) {
        traderBets.push(betId);
        this.betsByTrader.set(bet.trader, traderBets);
      }
      
      return bet;
    } catch (error: any) {
      this.logger.error(`Failed to sync bet ${betId}:`, error);
      throw error;
    }
  }
  
  /**
   * Get bet by ID (from memory or fetch from chain)
   */
  async getBet(betId: string): Promise<OneTapBet | null> {
    // Check memory first
    const cachedBet = this.bets.get(betId);
    if (cachedBet) {
      return cachedBet;
    }
    
    // Fetch from chain
    try {
      return await this.syncBetFromChain(betId);
    } catch (error) {
      this.logger.error(`Failed to get bet ${betId}:`, error);
      return null;
    }
  }
  
  /**
   * Query bets with filters
   */
  async queryBets(query: GetOneTapBetsQuery): Promise<OneTapBet[]> {
    let bets = Array.from(this.bets.values());
    
    // Filter by trader
    if (query.trader) {
      const trader = query.trader.toLowerCase();
      const betIds = this.betsByTrader.get(trader) || [];
      bets = bets.filter(b => betIds.includes(b.betId));
    }
    
    // Filter by symbol
    if (query.symbol) {
      bets = bets.filter(b => b.symbol === query.symbol);
    }
    
    // Filter by status
    if (query.status) {
      bets = bets.filter(b => b.status === query.status);
    }
    
    return bets.sort((a, b) => b.createdAt - a.createdAt);
  }
  
  /**
   * Get all active bets (for monitoring)
   */
  getActiveBets(): OneTapBet[] {
    return Array.from(this.bets.values())
      .filter(b => b.status === OneTapBetStatus.ACTIVE)
      .sort((a, b) => a.targetTime - b.targetTime);
  }
  
  /**
   * Calculate multiplier (calls smart contract)
   */
  async calculateMultiplier(request: CalculateMultiplierRequest): Promise<CalculateMultiplierResponse> {
    try {
      // Fix floating point precision issues
      const entryPriceFixed = parseFloat(request.entryPrice).toFixed(8);
      const targetPriceFixed = parseFloat(request.targetPrice).toFixed(8);
      
      const entryPrice = ethers.parseUnits(entryPriceFixed, 8);
      const targetPrice = ethers.parseUnits(targetPriceFixed, 8);
      
      const multiplier = await this.contract.calculateMultiplier(
        entryPrice,
        targetPrice,
        request.entryTime,
        request.targetTime
      );
      
      // Calculate price distance
      const entryNum = parseFloat(request.entryPrice);
      const targetNum = parseFloat(request.targetPrice);
      const priceDistance = ((Math.abs(targetNum - entryNum) / entryNum) * 100).toFixed(2);
      
      // Calculate time distance
      const timeDistance = request.targetTime - request.entryTime;
      
      return {
        multiplier: Number(multiplier),
        priceDistance: `${priceDistance}%`,
        timeDistance,
      };
    } catch (error: any) {
      this.logger.error('Failed to calculate multiplier:', error);
      throw new Error(`Failed to calculate multiplier: ${error.message}`);
    }
  }
  
  /**
   * Get statistics
   */
  getStats(): OneTapProfitStats {
    const bets = Array.from(this.bets.values());
    
    return {
      totalBets: bets.length,
      activeBets: bets.filter(b => b.status === OneTapBetStatus.ACTIVE).length,
      wonBets: bets.filter(b => b.status === OneTapBetStatus.WON).length,
      lostBets: bets.filter(b => b.status === OneTapBetStatus.LOST).length,
      totalVolume: bets.reduce((sum, b) => sum + parseFloat(b.betAmount), 0).toFixed(6),
      totalPayout: '0', // TODO: Calculate from won bets
    };
  }
  
  /**
   * Get contract address
   */
  getContractAddress(): string {
    return this.contract.target as string;
  }
  
  /**
   * Settle bet on-chain (bet already placed, just settle)
   * Called by monitor when WIN/LOSE conditions are met
   */
  async settleBet(betId: string, currentPrice: string, currentTime: number, won: boolean): Promise<void> {
    try {
      // Get bet from memory
      const bet = this.bets.get(betId);
      if (!bet) {
        throw new Error('Bet not found in memory');
      }
      
      this.logger.info(`🔄 Settling bet ${betId}... (${won ? 'WON' : 'LOST'})`);
      
      // Fix floating point precision - round to 8 decimals
      const currentPriceFixed = parseFloat(currentPrice).toFixed(8);
      const priceInUnits = ethers.parseUnits(currentPriceFixed, 8);
      
      // Settle bet on-chain
      const tx = await this.contract.settleBet(
        betId,
        priceInUnits,
        currentTime,
        won
      );
      
      this.logger.info(`⏳ Waiting for settlement: ${tx.hash}`);
      await tx.wait();
      
      this.logger.success(`✅ Bet ${betId} settled! TxHash: ${tx.hash}`);
      
      // Update bet status in memory
      bet.status = won ? OneTapBetStatus.WON : OneTapBetStatus.LOST;
      (bet as any).settleTxHash = tx.hash;
    } catch (error: any) {
      this.logger.error(`Failed to settle bet ${betId}:`, error);
      throw error;
    }
  }
  
  /**
   * Map on-chain status to enum
   */
  private mapStatus(status: number): OneTapBetStatus {
    switch (status) {
      case 0: return OneTapBetStatus.ACTIVE;
      case 1: return OneTapBetStatus.WON;
      case 2: return OneTapBetStatus.LOST;
      case 3: return OneTapBetStatus.CANCELLED;
      default: return OneTapBetStatus.ACTIVE;
    }
  }
}
