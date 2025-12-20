/**
 * Relay Service for Gasless Transactions
 * 
 * Allows users to pay gas in USDC instead of ETH
 * Backend relays transactions and charges USDC from paymaster deposits
 */

import { ethers, Contract } from 'ethers';
import { Logger } from '../utils/Logger';
import { NonceManager } from '../utils/NonceManager';
import MarketExecutorABI from '../abis/MarketExecutor.json';
import PositionManagerABI from '../abis/PositionManager.json';
import VaultPoolABI from '../abis/VaultPool.json';
import StabilityFundABI from '../abis/StabilityFund.json';

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
    
    if (!this.PAYMASTER_ADDRESS || !this.MARKET_EXECUTOR_ADDRESS || !this.LIMIT_EXECUTOR_ADDRESS || !this.POSITION_MANAGER_ADDRESS) {
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
    const TRADING_FEE_BPS = 5n; // 0.05% (same as MarketExecutor default)

    while (attempt < MAX_RETRIES) {
      try {
        this.logger.info(`GASLESS CLOSE (Attempt ${attempt + 1}): Position ${positionId} for ${userAddress}`);
        
        // Get price from local backend API
        const backendUrl = process.env.BACKEND_URL || 'http://localhost:3001';
        const priceResponse = await fetch(`${backendUrl}/api/price/signed/${symbol}`);
        if (!priceResponse.ok) {
          throw new Error(`Failed to get price for ${symbol}`);
        }
        const priceData: any = await priceResponse.json();
        const signedPrice = priceData.data;
        
        this.logger.info('   Closing via PositionManager + StabilityFund/VaultPool (manual settlement)');

        // Contracts (relayer must have EXECUTOR_ROLE on PositionManager and SETTLER_ROLE on StabilityFund/VaultPool)
        const positionManager = new Contract(
          this.POSITION_MANAGER_ADDRESS,
          PositionManagerABI.abi,
          this.relayWallet
        );
        const stabilityFundAddress = process.env.STABILITY_FUND_ADDRESS || '';
        const vaultPoolAddress = process.env.VAULT_POOL_ADDRESS || '';
        if (!stabilityFundAddress) {
          throw new Error('STABILITY_FUND_ADDRESS not configured');
        }
        if (!vaultPoolAddress) {
          throw new Error('VAULT_POOL_ADDRESS not configured');
        }
        const stabilityFund = new Contract(
          stabilityFundAddress,
          StabilityFundABI.abi,
          this.relayWallet
        );

        // Fetch position + PnL
        const [positionData, pnl] = await Promise.all([
          positionManager.getPosition(BigInt(positionId)),
          positionManager.calculatePnL(BigInt(positionId), BigInt(signedPrice.price))
        ]);

        const position = {
          id: positionData.id as bigint,
          trader: positionData.trader as string,
          symbol: positionData.symbol as string,
          isLong: positionData.isLong as boolean,
          collateral: positionData.collateral as bigint,
          size: positionData.size as bigint,
          leverage: positionData.leverage as bigint,
          entryPrice: positionData.entryPrice as bigint,
          status: Number(positionData.status)
        };

        const tradingFee = (position.size * TRADING_FEE_BPS) / 100000n; // size * 0.05%
        const maxAllowedLoss = -1n * (position.collateral * 9900n) / 10000n; // cap loss at 99% collateral
        const cappedPnl = pnl < maxAllowedLoss ? maxAllowedLoss : pnl;
        const payout = (() => {
          const raw = position.collateral + cappedPnl - tradingFee;
          return raw > 0n ? raw : 0n;
        })();

        this.logger.info(`   Collateral: ${position.collateral.toString()}`);
        this.logger.info(`   Size: ${position.size.toString()}`);
        this.logger.info(`   PnL raw: ${pnl.toString()} | capped: ${cappedPnl.toString()}`);
        this.logger.info(`   Trading fee: ${tradingFee.toString()}`);
        this.logger.info(`   Payout (net to trader): ${payout.toString()}`);

        // 1) close position
        const nonceClose = await NonceManager.getInstance().getNonce();
        const closeTx = await positionManager.closePosition(
          BigInt(positionId),
          BigInt(signedPrice.price),
          { gasLimit: 500000n, nonce: nonceClose }
        );
        this.logger.info(`Close tx sent: ${closeTx.hash}`);
        await closeTx.wait();

        // 2) settle trade (refund/fee) - fallback ke VaultPool kalau buffer kurang
        const usdc = new Contract(
          await stabilityFund.usdc(),
          ['function balanceOf(address) view returns (uint256)'],
          this.relayWallet
        );
        const bufferBalance: bigint = await usdc.balanceOf(stabilityFundAddress);
        this.logger.info(`   Buffer balance: ${bufferBalance.toString()}`);

        if (payout > bufferBalance) {
          const vaultPool = new Contract(vaultPoolAddress, VaultPoolABI.abi, this.relayWallet);
          const nonceCover = await NonceManager.getInstance().getNonce();
          const coverTx = await vaultPool.coverPayout(position.trader, payout, {
            gasLimit: 600000n,
            nonce: nonceCover
          });
          this.logger.info(`coverPayout via VaultPool sent: ${coverTx.hash}`);
          this.logger.warn('Buffer insufficient; paid trader directly from VaultPool. Fees not split via StabilityFund.');
        } else {
          const nonceSettle = await NonceManager.getInstance().getNonce();
          const settleTx = await stabilityFund.settleTrade(
            position.trader,
            position.collateral,
            cappedPnl,
            tradingFee,
            this.relayWallet.address,
            { gasLimit: 600000n, nonce: nonceSettle }
          );
          this.logger.info(`Settle tx sent: ${settleTx.hash}`);
        }
        
        this.logger.success(`Close flow finished. Close TX: ${closeTx.hash}`);
        
        return { txHash: closeTx.hash };
        
      } catch (error: any) {
        if (this.isNonceError(error)) {
          attempt++;
          this.logger.warn(`Nonce error detected during closePositionGasless (Attempt ${attempt}/${MAX_RETRIES}). Resyncing...`);
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

