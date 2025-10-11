/**
 * Relay Service for Gasless Transactions
 * 
 * Allows users to pay gas in USDC instead of ETH
 * Backend relays transactions and charges USDC from paymaster deposits
 */

import { ethers, Contract } from 'ethers';
import { Logger } from '../utils/Logger';

export class RelayService {
  private logger: Logger;
  private provider: ethers.JsonRpcProvider;
  private relayWallet: ethers.Wallet;
  private paymasterContract: Contract;
  
  // Contract addresses (from .env)
  private PAYMASTER_ADDRESS: string;
  private MARKET_EXECUTOR_ADDRESS: string;
  private POSITION_MANAGER_ADDRESS: string;
  private TREASURY_MANAGER_ADDRESS: string;
  
  constructor() {
    this.logger = new Logger('RelayService');
    
    // Initialize provider
    const RPC_URL = process.env.RPC_URL || 'https://sepolia.base.org';
    this.provider = new ethers.JsonRpcProvider(RPC_URL);
    
    // Initialize relay wallet (backend wallet that pays gas)
    const RELAY_PRIVATE_KEY = process.env.RELAY_PRIVATE_KEY;
    if (!RELAY_PRIVATE_KEY) {
      throw new Error('RELAY_PRIVATE_KEY not configured');
    }
    this.relayWallet = new ethers.Wallet(RELAY_PRIVATE_KEY, this.provider);
    
    // Contract addresses
    this.PAYMASTER_ADDRESS = process.env.USDC_PAYMASTER_ADDRESS || '';
    this.MARKET_EXECUTOR_ADDRESS = process.env.MARKET_EXECUTOR_ADDRESS || '';
    this.POSITION_MANAGER_ADDRESS = process.env.POSITION_MANAGER_ADDRESS || '';
    this.TREASURY_MANAGER_ADDRESS = process.env.TREASURY_MANAGER_ADDRESS || '';
    
    if (!this.PAYMASTER_ADDRESS || !this.MARKET_EXECUTOR_ADDRESS || !this.POSITION_MANAGER_ADDRESS || !this.TREASURY_MANAGER_ADDRESS) {
      throw new Error('Contract addresses not configured');
    }
    
    // Initialize paymaster contract
    const paymasterABI = [
      'function validateGasPayment(address user, uint256 estimatedGas) view returns (bool)',
      'function processGasPayment(address user, uint256 gasUsed) returns (uint256)',
      'function userDeposits(address) view returns (uint256)',
      'function calculateUsdcCost(uint256 gasAmount) view returns (uint256)'
    ];
    
    this.paymasterContract = new Contract(
      this.PAYMASTER_ADDRESS,
      paymasterABI,
      this.relayWallet
    );
    
    this.logger.info('🔄 Relay Service initialized');
    this.logger.info(`   Relay Wallet: ${this.relayWallet.address}`);
  }
  
  /**
   * Check if user can pay for gas via paymaster
   */
  async canUserPayGas(userAddress: string, estimatedGas: bigint): Promise<boolean> {
    try {
      const canPay = await this.paymasterContract.validateGasPayment(
        userAddress,
        estimatedGas
      );
      return canPay;
    } catch (error) {
      this.logger.error('Error checking gas payment:', error);
      return false;
    }
  }
  
  /**
   * Get user's USDC deposit balance in paymaster
   */
  async getUserDeposit(userAddress: string): Promise<bigint> {
    try {
      const deposit = await this.paymasterContract.userDeposits(userAddress);
      return deposit;
    } catch (error) {
      this.logger.error('Error getting user deposit:', error);
      return 0n;
    }
  }
  
  /**
   * Calculate USDC cost for estimated gas
   */
  async calculateGasCost(estimatedGas: bigint): Promise<bigint> {
    try {
      const usdcCost = await this.paymasterContract.calculateUsdcCost(estimatedGas);
      return usdcCost;
    } catch (error) {
      this.logger.error('Error calculating gas cost:', error);
      return 0n;
    }
  }
  
  /**
   * Relay a transaction (pay gas with backend wallet, charge user USDC)
   * NOTE: For meta-transactions, data should already be encoded with user signature
   */
  async relayTransaction(
    to: string,
    data: string,
    userAddress: string,
    value: bigint = 0n
  ): Promise<{ txHash: string; gasUsed: bigint; usdcCharged: bigint }> {
    try {
      this.logger.info(`🔄 Relaying meta-transaction for ${userAddress}`);
      this.logger.info(`   Relayer: ${this.relayWallet.address}`);
      this.logger.info(`   Target: ${to}`);
      
      // Estimate gas (from relayer address)
      const gasEstimate = await this.provider.estimateGas({
        from: this.relayWallet.address,
        to,
        data,
        value
      });
      
      this.logger.info(`⛽ Estimated gas: ${gasEstimate.toString()}`);
      
      // Check if user can pay
      const canPay = await this.canUserPayGas(userAddress, gasEstimate);
      if (!canPay) {
        throw new Error('User has insufficient USDC deposit for gas');
      }
      
      // Calculate USDC cost
      const usdcCost = await this.calculateGasCost(gasEstimate);
      this.logger.info(`💵 USDC cost for user: ${usdcCost.toString()}`);
      
      // Send transaction (relayer pays gas in ETH)
      const tx = await this.relayWallet.sendTransaction({
        to,
        data,
        value,
        gasLimit: gasEstimate * 120n / 100n // 20% buffer
      });
      
      this.logger.info(`📤 Meta-transaction sent: ${tx.hash}`);
      
      // Wait for confirmation
      const receipt = await tx.wait();
      if (!receipt) {
        throw new Error('Transaction receipt not found');
      }
      
      this.logger.info(`✅ Meta-transaction confirmed: ${receipt.hash}`);
      this.logger.info(`   Gas used: ${receipt.gasUsed.toString()}`);
      this.logger.info(`   Gas price: ${receipt.gasPrice?.toString() || 'N/A'}`);
      
      // Charge user USDC via paymaster
      // TODO: Implement full paymaster integration with proper nonce management
      // For now, skip charging to avoid nonce collision
      const gasUsed = receipt.gasUsed;
      // const gasCost = gasUsed * (receipt.gasPrice || 0n);
      
      // this.logger.info(`💰 Charging user ${userAddress} for gas...`);
      // const chargeTx = await this.paymasterContract.processGasPayment(
      //   userAddress,
      //   gasCost
      // );
      // 
      // await chargeTx.wait();
      // 
      // this.logger.success(`✅ Charged user ${usdcCost.toString()} USDC for gas`);
      
      this.logger.info(`💰 Gas cost: ${usdcCost.toString()} USDC (not charged - paymaster disabled for now)`);
      
      return {
        txHash: receipt.hash,
        gasUsed,
        usdcCharged: usdcCost
      };
      
    } catch (error) {
      this.logger.error('Error relaying meta-transaction:', error);
      throw error;
    }
  }
  
  /**
   * HACKATHON MODE: Close position gaslessly (relayer pays gas)
   */
  async closePositionGasless(
    userAddress: string,
    positionId: string,
    symbol: string
  ): Promise<{ txHash: string }> {
    try {
      this.logger.info(`🔥 GASLESS CLOSE: Position ${positionId} for ${userAddress}`);
      
      // Get price from local backend API
      const backendUrl = process.env.BACKEND_URL || 'http://localhost:3001';
      const priceResponse = await fetch(`${backendUrl}/api/price/signed/${symbol}`);
      if (!priceResponse.ok) {
        throw new Error(`Failed to get price for ${symbol}`);
      }
      const priceData: any = await priceResponse.json();
      const signedPrice = priceData.data;
      
      this.logger.info(`   Calling MarketExecutor.closeMarketPosition...`);
      this.logger.info(`   Position ID: ${positionId}`);
      this.logger.info(`   Exit Price: ${signedPrice.price}`);
      
      // Call PositionManager.closePosition DIRECTLY (relayer has EXECUTOR_ROLE!)
      const iface = new ethers.Interface([
        'function closePosition(uint256 positionId, uint256 exitPrice)'
      ]);
      
      const data = iface.encodeFunctionData('closePosition', [
        BigInt(positionId),
        BigInt(signedPrice.price)
      ]);
      
      this.logger.info(`   Encoded data: ${data.substring(0, 66)}...`);
      this.logger.info(`   🔥 CALLING POSITIONMANAGER DIRECTLY!`);
      
      // First, get position details to calculate refund
      const positionIface = new ethers.Interface([
        'function getPosition(uint256) view returns (tuple(uint256 id, address trader, string symbol, bool isLong, uint256 collateral, uint256 size, uint256 leverage, uint256 entryPrice, uint256 openTimestamp, uint8 status))',
        'function calculatePnL(uint256, uint256) view returns (int256)'
      ]);
      
      const positionContract = new Contract(
        this.POSITION_MANAGER_ADDRESS,
        positionIface,
        this.provider
      );
      
      const positionData = await positionContract.getPosition(BigInt(positionId));
      // positionData is a tuple, access by index
      const position = {
        id: positionData[0],
        trader: positionData[1],
        symbol: positionData[2],
        isLong: positionData[3],
        collateral: positionData[4],
        size: positionData[5],
        leverage: positionData[6],
        entryPrice: positionData[7],
        openTimestamp: positionData[8],
        status: positionData[9]
      };
      const pnl = await positionContract.calculatePnL(BigInt(positionId), BigInt(signedPrice.price));
      
      this.logger.info(`   Collateral: ${position.collateral.toString()}`);
      this.logger.info(`   PnL: ${pnl.toString()}`);
      
      // Send close transaction
      const tx = await this.relayWallet.sendTransaction({
        to: this.POSITION_MANAGER_ADDRESS,
        data: data,
        gasLimit: 500000n
      });
      
      this.logger.info(`📤 Close TX sent: ${tx.hash}`);
      const receipt = await tx.wait();
      if (!receipt) {
        throw new Error('Transaction receipt not found');
      }
      
      this.logger.success(`✅ Position ${positionId} CLOSED! TX: ${receipt.hash}`);
      
      // Wait 2 seconds to ensure nonce is updated on-chain
      this.logger.info('⏳ Waiting for nonce to update...');
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Now settle: refund collateral +/- PnL
      const fee = 0n; // No fee for now (hackathon mode!)
      let refundAmount: bigint;
      
      if (pnl >= 0) {
        // Profit: collateral + PnL - fee
        refundAmount = position.collateral + BigInt(pnl) - fee;
      } else {
        // Loss: collateral - abs(PnL) - fee
        const absLoss = BigInt(-pnl);
        if (position.collateral > absLoss + fee) {
          refundAmount = position.collateral - absLoss - fee;
        } else {
          refundAmount = 0n; // Total loss
        }
      }
      
      this.logger.info(`💰 Refunding ${refundAmount.toString()} to trader...`);
      
      if (refundAmount > 0n) {
        // Call TreasuryManager.refundCollateral
        const treasuryIface = new ethers.Interface([
          'function refundCollateral(address to, uint256 amount)'
        ]);
        
        const withdrawData = treasuryIface.encodeFunctionData('refundCollateral', [
          position.trader,
          refundAmount
        ]);
        
        // Get FRESH nonce after waiting (use 'pending' to get latest including mempool)
        const nonce = await this.provider.getTransactionCount(this.relayWallet.address, 'pending');
        this.logger.info(`   Using nonce: ${nonce}`);
        
        const withdrawTx = await this.relayWallet.sendTransaction({
          to: this.TREASURY_MANAGER_ADDRESS,
          data: withdrawData,
          gasLimit: 200000n,
          nonce: nonce
        });
        
        this.logger.info(`📤 Withdrawal TX sent: ${withdrawTx.hash}`);
        const withdrawReceipt = await withdrawTx.wait();
        
        this.logger.success(`✅ Refunded ${refundAmount.toString()} USDC to trader!`);
      }
      
      return {
        txHash: receipt.hash
      };
      
    } catch (error) {
      this.logger.error('Error closing position gasless:', error);
      throw error;
    }
  }
  
  /**
   * Check relay wallet balance
   */
  async getRelayBalance(): Promise<{ eth: bigint; ethFormatted: string }> {
    const balance = await this.provider.getBalance(this.relayWallet.address);
    return {
      eth: balance,
      ethFormatted: ethers.formatEther(balance)
    };
  }
}
