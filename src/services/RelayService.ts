/**
 * Relay Service for Gasless Transactions
 * 
 * Allows users to pay gas in USDC instead of ETH
 * Backend relays transactions and charges USDC from paymaster deposits
 */

import { ethers, Contract } from 'ethers';
import { Logger } from '../utils/Logger';
import { NonceManager } from '../utils/NonceManager';

export class RelayService {
  private logger: Logger;
  private provider: ethers.JsonRpcProvider;
  private relayWallet: ethers.Wallet;
  private paymasterContract: Contract;
  
  // Contract addresses (from .env)
  private PAYMASTER_ADDRESS: string;
  private MARKET_EXECUTOR_ADDRESS: string;
  private LIMIT_EXECUTOR_ADDRESS: string;
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
    this.LIMIT_EXECUTOR_ADDRESS = process.env.LIMIT_EXECUTOR_ADDRESS || '';
    this.POSITION_MANAGER_ADDRESS = process.env.POSITION_MANAGER_ADDRESS || '';
    this.TREASURY_MANAGER_ADDRESS = process.env.TREASURY_MANAGER_ADDRESS || '';
    
    if (!this.PAYMASTER_ADDRESS || !this.MARKET_EXECUTOR_ADDRESS || !this.LIMIT_EXECUTOR_ADDRESS || !this.POSITION_MANAGER_ADDRESS || !this.TREASURY_MANAGER_ADDRESS) {
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

    // Initialize NonceManager
    NonceManager.getInstance().init(this.relayWallet).catch(err => {
      this.logger.error('Failed to initialize NonceManager', err);
    });
    
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
      this.logger.warn('⚠️  Paymaster unavailable, using fallback gas calculation');
      // FALLBACK: Rough estimate for Base Sepolia
      // Assume: 0.001 Gwei gas price, 1 ETH = 3000 USDC
      // Gas cost in ETH = estimatedGas * gasPrice
      // Gas cost in USDC = Gas cost in ETH * ETH price
      
      // Base Sepolia typical gas price: ~0.001 Gwei = 1000000 wei
      const gasPriceWei = 1000000n; // 0.001 Gwei
      const gasCostWei = estimatedGas * gasPriceWei;
      
      // Convert Wei to ETH (1 ETH = 10^18 Wei)
      // Then ETH to USDC (assume 3000 USDC per ETH)
      // Then to USDC base units (6 decimals)
      // Formula: (gasCostWei * 3000 * 10^6) / 10^18
      //        = (gasCostWei * 3000) / 10^12
      const usdcCost = (gasCostWei * 3000n) / 1000000000000n;
      
      // Minimum 0.01 USDC to cover small transactions
      const minCost = 10000n; // 0.01 USDC (6 decimals)
      return usdcCost > minCost ? usdcCost : minCost;
    }
  }
  
  private isNonceError(err: any): boolean {
    if (!err) return false;
    const msg = err.message?.toLowerCase() || '';
    const code = err.code;
    const infoMsg = err.info?.error?.message?.toLowerCase() || '';
    
    return (
      code === 'NONCE_EXPIRED' ||
      msg.includes('nonce') ||
      msg.includes('replacement transaction underpriced') ||
      infoMsg.includes('nonce') ||
      infoMsg.includes('replacement transaction underpriced')
    );
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
  ): Promise<{ txHash: string; gasUsed: bigint; usdcCharged: bigint; positionId?: number }> {
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
      
      let tx;
      let attempt = 0;
      const MAX_RETRIES = 3;

      while (attempt < MAX_RETRIES) {
        try {
          // Get next nonce from manager
          const nonce = await NonceManager.getInstance().getNonce();
          
          // Send transaction (relayer pays gas in ETH)
          tx = await this.relayWallet.sendTransaction({
            to,
            data,
            value,
            gasLimit: gasEstimate * 120n / 100n, // 20% buffer
            nonce: nonce // Use managed nonce
          });
          
          this.logger.info(`🚀 Fire & Forget: Transaction sent: ${tx.hash} (Nonce: ${nonce})`);
          break; // Success

        } catch (err: any) {
          if (this.isNonceError(err)) {
             attempt++;
             this.logger.warn(`⚠️ Nonce error detected (Attempt ${attempt}/${MAX_RETRIES}). Resyncing...`);
             await NonceManager.getInstance().resync();
             continue;
          }
          throw err; // Rethrow other errors
        }
      }

      if (!tx) throw new Error('Failed to send transaction after retries');
      
      // Do NOT wait for receipt. Return immediately.
      // We return 0/dummy values for gasUsed/usdcCharged because we don't know them yet.
      
      return {
        txHash: tx.hash,
        gasUsed: 0n, // Pending
        usdcCharged: usdcCost, // Estimated cost
        positionId: 0 // Unknown
      };
      
    } catch (error) {
      this.logger.error('Error relaying meta-transaction:', error);
      // If error occurs before sending, we might want to resync nonce just in case
      // but if getNonce() was called and tx failed, we might have a gap. 
      // For now, assume simple errors don't consume nonce unless sendTransaction was called.
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
    let attempt = 0;
    const MAX_RETRIES = 3;

    while (attempt < MAX_RETRIES) {
      try {
        this.logger.info(`🔥 GASLESS CLOSE (Attempt ${attempt + 1}): Position ${positionId} for ${userAddress}`);
        
        // Get price from local backend API
        const backendUrl = process.env.BACKEND_URL || 'http://localhost:3001';
        const priceResponse = await fetch(`${backendUrl}/api/price/signed/${symbol}`);
        if (!priceResponse.ok) {
          throw new Error(`Failed to get price for ${symbol}`);
        }
        const priceData: any = await priceResponse.json();
        const signedPrice = priceData.data;
        
        this.logger.info(`   🔥 CALLING POSITIONMANAGER DIRECTLY (with fee split!)`);
        
        // First, get position details to calculate settlement
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
        
        this.logger.info(`   📊 Position details:`);
        this.logger.info(`   - Collateral: ${position.collateral.toString()}`);
        this.logger.info(`   - Size: ${position.size.toString()}`);
        this.logger.info(`   - Leverage: ${position.leverage.toString()}`);
        this.logger.info(`   - PnL: ${pnl.toString()}`);
        
        // Prepare Close Position Transaction
        const closeIface = new ethers.Interface([
          'function closePosition(uint256 positionId, uint256 exitPrice)'
        ]);
        
        const closeData = closeIface.encodeFunctionData('closePosition', [
          BigInt(positionId),
          BigInt(signedPrice.price)
        ]);

        // Calculate Fees and Refunds
        // Fee is 0.05% of COLLATERAL (not size!)
        const TRADING_FEE_BPS = 5n; // 0.05%
        const tradingFee = (position.collateral * TRADING_FEE_BPS) / 10000n;
        
        // Split fee: 20% to relayer (0.01% of collateral), 80% to treasury (0.04% of collateral)
        const relayerFee = (tradingFee * 2000n) / 10000n; // 20% of total fee = 0.01% of collateral
        const treasuryFee = tradingFee - relayerFee; // 80% of total fee = 0.04% of collateral
        
        this.logger.info(`💰 Fee breakdown (from collateral):`);
        this.logger.info(`   Total fee: ${tradingFee.toString()}`);
        this.logger.info(`   Relayer fee: ${relayerFee.toString()}`);
        this.logger.info(`   Treasury fee: ${treasuryFee.toString()}`);
        
        // Calculate refund amount
        let refundAmount: bigint;
        
        if (pnl >= 0) {
          refundAmount = position.collateral + BigInt(pnl) - tradingFee;
        } else {
          const absLoss = BigInt(-pnl);
          if (position.collateral > absLoss + tradingFee) {
            refundAmount = position.collateral - absLoss - tradingFee;
          } else {
            refundAmount = 0n; // Total loss
          }
        }
        
        this.logger.info(`💰 Refund to trader: ${refundAmount.toString()}`);
        
        // Reserve Nonces: We need up to 4 nonces (Close + Treasury + Relayer + Refund)
        // Count required transactions
        let txCount = 1; // Close is always 1
        if (treasuryFee > 0n) txCount++;
        if (relayerFee > 0n) txCount++;
        if (refundAmount > 0n) txCount++;
        
        const startNonce = await NonceManager.getInstance().getNonceBatch(txCount);
        let currentNonce = startNonce;

        // 1. Send Close Position TX
        this.logger.info(`🚀 [1/${txCount}] Sending Close TX (Nonce: ${currentNonce})`);
        const closeTx = await this.relayWallet.sendTransaction({
          to: this.POSITION_MANAGER_ADDRESS,
          data: closeData,
          gasLimit: 500000n,
          nonce: currentNonce++
        });
        
        // Prepare interfaces for settlement
        const treasuryIface = new ethers.Interface([
          'function refundCollateral(address to, uint256 amount)',
          'function collectFee(address from, uint256 amount)'
        ]);

        // 2. Send Treasury Fee TX
        if (treasuryFee > 0n) {
          const feeData = treasuryIface.encodeFunctionData('collectFee', [
            position.trader,
            treasuryFee
          ]);
          
          this.logger.info(`🚀 [2/${txCount}] Sending Treasury Fee TX (Nonce: ${currentNonce})`);
          this.relayWallet.sendTransaction({
            to: this.TREASURY_MANAGER_ADDRESS,
            data: feeData,
            gasLimit: 200000n,
            nonce: currentNonce++
          }).then(tx => this.logger.info(`   -> Treasury Fee Hash: ${tx.hash}`))
            .catch(e => this.logger.error('Treasury Fee Failed', e));
        }
        
        // 3. Send Relayer Fee TX
        if (relayerFee > 0n) {
          // Relayer fee is taken from treasury (as collateral is there) via refundCollateral
          // effectively "refunding" to the relayer wallet
          const relayerFeeData = treasuryIface.encodeFunctionData('refundCollateral', [
              this.relayWallet.address,
              relayerFee
          ]);

          this.logger.info(`🚀 [3/${txCount}] Sending Relayer Fee TX (Nonce: ${currentNonce})`);
          this.relayWallet.sendTransaction({
            to: this.TREASURY_MANAGER_ADDRESS,
            data: relayerFeeData,
            gasLimit: 200000n,
            nonce: currentNonce++
          }).then(tx => this.logger.info(`   -> Relayer Fee Hash: ${tx.hash}`))
            .catch(e => this.logger.error('Relayer Fee Failed', e));
        }
        
        // 4. Send Refund TX
        if (refundAmount > 0n) {
          const refundData = treasuryIface.encodeFunctionData('refundCollateral', [
            position.trader,
            refundAmount
          ]);
          
          this.logger.info(`🚀 [4/${txCount}] Sending Refund TX (Nonce: ${currentNonce})`);
          this.relayWallet.sendTransaction({
            to: this.TREASURY_MANAGER_ADDRESS,
            data: refundData,
            gasLimit: 200000n,
            nonce: currentNonce++
          }).then(tx => this.logger.info(`   -> Refund Hash: ${tx.hash}`))
            .catch(e => this.logger.error('Refund Failed', e));
        }
        
        this.logger.success(`✅ Sequence initiated! Close TX: ${closeTx.hash}`);
        
        return {
          txHash: closeTx.hash
        };
        
      } catch (error: any) {
        if (this.isNonceError(error)) {
          attempt++;
          this.logger.warn(`⚠️ Nonce error detected during closePositionGasless (Attempt ${attempt}/${MAX_RETRIES}). Resyncing...`);
          await NonceManager.getInstance().resync();
          continue;
        }
        this.logger.error('Error closing position gasless:', error);
        throw error;
      }
    }
    
    throw new Error(`Failed to close position after ${MAX_RETRIES} attempts`);
  }
  
  /**
   * GASLESS CANCEL ORDER - Keeper pays gas
   */
  async cancelOrderGasless(
    userAddress: string,
    orderId: string,
    userSignature: string
  ): Promise<{ txHash: string }> {
    let attempt = 0;
    const MAX_RETRIES = 3;

    while (attempt < MAX_RETRIES) {
      try {
        this.logger.info(`❌ GASLESS CANCEL (Attempt ${attempt + 1}): Order ${orderId} for ${userAddress}`);
        
        // Get user's current nonce
        const limitExecutorContract = new Contract(
          this.LIMIT_EXECUTOR_ADDRESS,
          ['function getUserCurrentNonce(address) view returns (uint256)'],
          this.provider
        );
        
        const userNonce = await limitExecutorContract.getUserCurrentNonce(userAddress);
        this.logger.info(`   User nonce: ${userNonce.toString()}`);
        
        // Call LimitExecutor.cancelOrderGasless
        const iface = new ethers.Interface([
          'function cancelOrderGasless(address trader, uint256 orderId, uint256 nonce, bytes calldata userSignature)'
        ]);
        
        const data = iface.encodeFunctionData('cancelOrderGasless', [
          userAddress,
          BigInt(orderId),
          userNonce,
          userSignature
        ]);
        
        this.logger.info(`   🔥 Calling cancelOrderGasless (keeper pays gas)`);
        
        const nonce = await NonceManager.getInstance().getNonce();

        const tx = await this.relayWallet.sendTransaction({
          to: this.LIMIT_EXECUTOR_ADDRESS,
          data: data,
          gasLimit: 200000n,
          nonce: nonce
        });
        
        this.logger.info(`🚀 Fire & Forget: Cancel TX sent: ${tx.hash}`);
        
        return {
          txHash: tx.hash
        };
        
      } catch (error: any) {
        if (this.isNonceError(error)) {
          attempt++;
          this.logger.warn(`⚠️ Nonce error detected during cancelOrderGasless (Attempt ${attempt}/${MAX_RETRIES}). Resyncing...`);
          await NonceManager.getInstance().resync();
          continue;
        }
        this.logger.error('Error cancelling order gasless:', error);
        throw error;
      }
    }

    throw new Error(`Failed to cancel order after ${MAX_RETRIES} attempts`);
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
