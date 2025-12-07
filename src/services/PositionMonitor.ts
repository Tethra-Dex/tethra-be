/**
 * Position Monitor Service
 *
 * Monitors all open positions and auto-liquidates when threshold is reached
 * This prevents bad debt and enforces isolated margin
 */

import { ethers, Contract } from 'ethers';
import { Logger } from '../utils/Logger';
import PositionManagerABI from '../abis/PositionManager.json';
import MarketExecutorABI from '../abis/MarketExecutor.json';
import RiskManagerABI from '../abis/RiskManager.json';

interface Position {
  id: bigint;
  trader: string;
  symbol: string;
  isLong: boolean;
  collateral: bigint;
  size: bigint;
  leverage: bigint;
  entryPrice: bigint;
  openTimestamp: bigint;
  status: number;
}

export class PositionMonitor {
  private logger: Logger;
  private provider: ethers.JsonRpcProvider;
  private keeperWallet: ethers.Wallet;
  private priceSignerWallet: ethers.Wallet;
  private positionManager: Contract;
  private marketExecutor: Contract;
  private riskManager: Contract;
  private isRunning: boolean = false;
  private checkInterval: number = 1000;
  private currentPrices: Map<string, { price: bigint; timestamp: number }> = new Map();

  constructor(pythPriceService: any) {
    this.logger = new Logger('PositionMonitor');

    // Initialize provider
    const RPC_URL = process.env.RPC_URL || 'https://sepolia.base.org';
    this.provider = new ethers.JsonRpcProvider(RPC_URL);

    // Keeper wallet
    const keeperPrivateKey = process.env.RELAY_PRIVATE_KEY;
    if (!keeperPrivateKey) {
      throw new Error('RELAY_PRIVATE_KEY not configured');
    }
    this.keeperWallet = new ethers.Wallet(keeperPrivateKey, this.provider);

    // Price signer wallet
    const priceSignerKey = process.env.RELAY_PRIVATE_KEY;
    if (!priceSignerKey) {
      throw new Error('RELAY_PRIVATE_KEY not configured for price signing');
    }
    this.priceSignerWallet = new ethers.Wallet(priceSignerKey);

    // Contract addresses
    const positionManagerAddress = process.env.POSITION_MANAGER_ADDRESS || '';
    const marketExecutorAddress = process.env.MARKET_EXECUTOR_ADDRESS || '';
    const riskManagerAddress = process.env.RISK_MANAGER_ADDRESS || '';

    if (!positionManagerAddress || !marketExecutorAddress || !riskManagerAddress) {
      throw new Error('Contract addresses not configured');
    }

    // Initialize contracts
    this.positionManager = new Contract(
      positionManagerAddress,
      PositionManagerABI.abi,
      this.keeperWallet
    );

    this.marketExecutor = new Contract(
      marketExecutorAddress,
      MarketExecutorABI.abi,
      this.keeperWallet
    );

    this.riskManager = new Contract(
      riskManagerAddress,
      RiskManagerABI.abi,
      this.provider
    );

    // Subscribe to Pyth price updates
    if (pythPriceService) {
      pythPriceService.onPriceUpdate((prices: any) => {
        Object.keys(prices).forEach((symbol) => {
          const priceData = prices[symbol];
          const priceWith8Decimals = BigInt(Math.round(priceData.price * 100000000));
          this.currentPrices.set(symbol, {
            price: priceWith8Decimals,
            timestamp: priceData.timestamp || Date.now(),
          });
        });
      });

      // Load initial prices
      const initialPrices = pythPriceService.getCurrentPrices();
      Object.keys(initialPrices).forEach((symbol) => {
        const priceData = initialPrices[symbol];
        const priceWith8Decimals = BigInt(Math.round(priceData.price * 100000000));
        this.currentPrices.set(symbol, {
          price: priceWith8Decimals,
          timestamp: priceData.timestamp || Date.now(),
        });
      });
    }

    this.logger.info('🔍 Position Monitor initialized');
    this.logger.info(`   Keeper: ${this.keeperWallet.address}`);
    this.logger.info(`   Position Manager: ${positionManagerAddress}`);
    this.logger.info(`   Market Executor: ${marketExecutorAddress}`);
    this.logger.info(`   Risk Manager: ${riskManagerAddress}`);
  }

  /**
   * Start monitoring positions
   */
  start() {
    if (this.isRunning) {
      this.logger.warn('⚠️  Monitor already running');
      return;
    }

    this.isRunning = true;
    this.logger.info('▶️  Starting position monitor...');
    this.monitorLoop();
  }

  /**
   * Stop monitoring
   */
  stop() {
    this.isRunning = false;
    this.logger.info('⏹️  Stopping position monitor...');
  }

  /**
   * Main monitoring loop
   */
  private async monitorLoop() {
    while (this.isRunning) {
      try {
        await this.checkAllPositions();
      } catch (error) {
        this.logger.error('Error in monitor loop:', error);
      }

      // Wait before next check
      await this.sleep(this.checkInterval);
    }
  }

  /**
   * Check all open positions for liquidation
   */
  private async checkAllPositions() {
    try {
      // Get next position ID
      const nextPositionId = await this.positionManager.nextPositionId();
      const totalPositions = Number(nextPositionId) - 1;

      if (totalPositions === 0) {
        return; // No positions yet
      }

      this.logger.info(`🔍 Scanning ${totalPositions} positions for liquidation...`);

      // Check ALL positions (start from 1)
      const startId = 1;

      for (let positionId = startId; positionId <= totalPositions; positionId++) {
        try {
          const position = await this.getPosition(positionId);

          if (!position || position.status !== 0) {
            continue; // Position not found or not open
          }

          // Check if should liquidate
          await this.checkPositionLiquidation(position);

        } catch (error: any) {
          if (!error.message?.includes('Position not found')) {
            this.logger.error(`Error checking position ${positionId}:`, error);
          }
        }
      }

    } catch (error) {
      this.logger.error('Error checking all positions:', error);
    }
  }

  /**
   * Get position details from contract
   */
  private async getPosition(positionId: number): Promise<Position | null> {
    try {
      const positionData = await this.positionManager.getPosition(positionId);

      return {
        id: positionData.id,
        trader: positionData.trader,
        symbol: positionData.symbol,
        isLong: positionData.isLong,
        collateral: positionData.collateral,
        size: positionData.size,
        leverage: positionData.leverage,
        entryPrice: positionData.entryPrice,
        openTimestamp: positionData.openTimestamp,
        status: positionData.status,
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * Check if position should be liquidated
   */
  private async checkPositionLiquidation(position: Position) {
    try {
      // Get current price for this symbol
      const priceData = this.currentPrices.get(position.symbol);

      if (!priceData) {
        // No price data available
        return;
      }

      // Check if price is stale (older than 1 minute)
      if (Date.now() - priceData.timestamp > 60000) {
        this.logger.warn(`⏰ Stale price for ${position.symbol}`);
        return;
      }

      const currentPrice = priceData.price;

      // 1. Calculate PnL locally to be sure
      let pnl = 0n;
      const entryPrice = BigInt(position.entryPrice);
      const size = BigInt(position.size);
      const collateral = BigInt(position.collateral);
      
      if (position.isLong) {
          pnl = ((currentPrice - entryPrice) * size) / entryPrice;
      } else {
          pnl = ((entryPrice - currentPrice) * size) / entryPrice;
      }

      // Calculate PnL percentage (based on collateral)
      // pnlPercentage = (pnl * 10000) / collateral  (basis points)
      const pnlBps = (pnl * 10000n) / collateral;

      // Log if position is in heavy loss
      if (pnlBps < -8000n) { // -80%
          this.logger.info(`📉 Position ${position.id} PnL: ${(Number(pnlBps)/100).toFixed(2)}% | Trader: ${position.trader}`);
      }

      // 2. Check if should liquidate via RiskManager
      let shouldLiquidate = false;
      try {
          shouldLiquidate = await this.riskManager.shouldLiquidate(
            position.id,
            currentPrice,
            position.collateral,
            position.size,
            position.entryPrice,
            position.isLong
          );
      } catch (err) {
          this.logger.error(`Error calling RiskManager.shouldLiquidate for ${position.id}`, err);
      }

      // 3. Force liquidation if PnL <= -99% (Contract threshold is 99%)
      // If PnL is -1000%, this will definitely be true.
      if (pnlBps <= -9900n) {
          this.logger.warn(`💀 CRITICAL: Position ${position.id} has reached ${(Number(pnlBps)/100).toFixed(2)}% PnL. FORCE LIQUIDATING.`);
          shouldLiquidate = true;
      }

      if (shouldLiquidate) {
        this.logger.warn(`⚠️  Position ${position.id} triggering liquidation!`);
        this.logger.info(`   Trader: ${position.trader}`);
        this.logger.info(`   Symbol: ${position.symbol}`);
        this.logger.info(`   Entry: ${this.formatPrice(position.entryPrice)}`);
        this.logger.info(`   Current: ${this.formatPrice(currentPrice)}`);
        this.logger.info(`   Collateral: ${this.formatUsdc(position.collateral)}`);
        this.logger.info(`   PnL: ${(Number(pnlBps)/100).toFixed(2)}%`);

        // Execute liquidation
        await this.liquidatePosition(position, currentPrice);
      }

    } catch (error) {
      this.logger.error(`Error checking liquidation for position ${position.id}:`, error);
    }
  }

  /**
   * Liquidate a position (Force Close via PositionManager)
   */
  private async liquidatePosition(position: Position, currentPrice: bigint) {
    try {
      this.logger.info(`🔥 FORCE CLOSING position ${position.id} directly via PositionManager...`);

      // Directly call PositionManager.closePosition (requires EXECUTOR_ROLE)
      // This bypasses MarketExecutor's checks and fees, ensuring the position is closed.
      const tx = await this.positionManager.closePosition(
        position.id,
        currentPrice,
        { gasLimit: 500000 }
      );

      this.logger.info(`📤 Force Close tx sent: ${tx.hash}`);

      const receipt = await tx.wait();

      this.logger.success(`✅ Position ${position.id} CLOSED successfully!`);
      this.logger.info(`   TX: ${receipt.hash}`);
      this.logger.info(`   Gas used: ${receipt.gasUsed.toString()}`);

    } catch (error: any) {
      this.logger.error(`❌ Failed to force close position ${position.id}:`, error.message);

      // Log specific errors
      if (error.message?.includes('Position not open')) {
        this.logger.warn('💡 Position already closed');
      }
    }
  }

  /**
   * Sign price data
   */
  private async signPrice(symbol: string, price: bigint, timestamp: number) {
    const messageHash = ethers.solidityPackedKeccak256(
      ['string', 'uint256', 'uint256'],
      [symbol, price, timestamp]
    );

    const signature = await this.priceSignerWallet.signMessage(ethers.getBytes(messageHash));

    return {
      symbol,
      price,
      timestamp,
      signature,
    };
  }

  /**
   * Format price (8 decimals to readable)
   */
  private formatPrice(price: bigint): string {
    return '$' + (Number(price) / 100000000).toFixed(2);
  }

  /**
   * Format USDC (6 decimals to readable)
   */
  private formatUsdc(amount: bigint): string {
    return (Number(amount) / 1000000).toFixed(2) + ' USDC';
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get monitor status
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      checkInterval: this.checkInterval,
      trackedPrices: Array.from(this.currentPrices.keys()),
      keeperAddress: this.keeperWallet.address,
    };
  }
}
