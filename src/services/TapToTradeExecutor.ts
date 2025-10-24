/**
 * Tap-to-Trade Executor Service
 *
 * Background service that:
 * 1. Monitors tap-to-trade orders stored in backend (not on-chain yet)
 * 2. Checks price and time window conditions
 * 3. Directly executes via MarketExecutor.openMarketPositionMeta() when triggered
 * 4. Skips "create order on-chain" step to save gas
 */

import { ethers, Contract } from 'ethers';
import { Logger } from '../utils/Logger';
import TapToTradeExecutorABI from '../abis/TapToTradeExecutor.json';
import { TapToTradeService } from './TapToTradeService';
import { TapToTradeOrder, TapToTradeOrderStatus } from '../types/tapToTrade';

export class TapToTradeExecutor {
  private logger: Logger;
  private provider: ethers.JsonRpcProvider;
  private keeperWallet: ethers.Wallet;
  private tapToTradeExecutor: Contract;
  private tapToTradeExecutorAddress: string;
  private priceSignerWallet: ethers.Wallet;
  private priceSignerAddress: string;
  private tapToTradeService: TapToTradeService;
  private isRunning: boolean = false;
  private checkInterval: number = 3000; // Check every 3 seconds
  private currentPrices: Map<string, { price: bigint; timestamp: number }> = new Map();
  private lastCleanupTime: number = 0;
  private cleanupInterval: number = 30000; // Cleanup expired orders every 30 seconds

  constructor(pythPriceService: any, tapToTradeService: TapToTradeService) {
    this.tapToTradeService = tapToTradeService;
    this.logger = new Logger('TapToTradeExecutor');

    // Initialize provider
    const RPC_URL = process.env.RPC_URL || 'https://sepolia.base.org';
    this.provider = new ethers.JsonRpcProvider(RPC_URL);

    // Keeper wallet (executes orders)
    const keeperPrivateKey = process.env.RELAY_PRIVATE_KEY;
    if (!keeperPrivateKey) {
      throw new Error('RELAY_PRIVATE_KEY not configured');
    }
    this.keeperWallet = new ethers.Wallet(keeperPrivateKey, this.provider);

    // Price signer wallet (signs prices)
    const priceSignerKey = process.env.PRICE_SIGNER_PRIVATE_KEY || process.env.RELAY_PRIVATE_KEY;
    if (!priceSignerKey) {
      throw new Error('PRICE_SIGNER_PRIVATE_KEY not configured');
    }
    this.priceSignerWallet = new ethers.Wallet(priceSignerKey);
    this.priceSignerAddress = this.priceSignerWallet.address;

    // TapToTradeExecutor contract
    this.tapToTradeExecutorAddress = process.env.TAP_TO_TRADE_EXECUTOR_ADDRESS || '';
    if (!this.tapToTradeExecutorAddress) {
      throw new Error('TAP_TO_TRADE_EXECUTOR_ADDRESS not configured');
    }

    this.tapToTradeExecutor = new Contract(
      this.tapToTradeExecutorAddress,
      TapToTradeExecutorABI.abi,
      this.keeperWallet
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

    this.logger.info('🚀 Tap-to-Trade Executor initialized');
    this.logger.info(`   Keeper: ${this.keeperWallet.address}`);
    this.logger.info(`   Price Signer: ${this.priceSignerAddress}`);
    this.logger.info(`   TapToTradeExecutor: ${this.tapToTradeExecutorAddress}`);
  }

  /**
   * Start monitoring and executing tap-to-trade orders
   */
  start() {
    if (this.isRunning) {
      this.logger.warn('⚠️  Tap-to-Trade Executor already running');
      return;
    }

    this.isRunning = true;
    this.logger.info('▶️  Starting tap-to-trade executor...');
    this.monitorLoop();
  }

  /**
   * Stop executor
   */
  stop() {
    this.isRunning = false;
    this.logger.info('⏹️  Stopping tap-to-trade executor...');
  }

  /**
   * Main monitoring loop
   */
  private async monitorLoop() {
    while (this.isRunning) {
      try {
        await this.checkAndExecuteOrders();

        // Cleanup expired orders periodically
        if (Date.now() - this.lastCleanupTime > this.cleanupInterval) {
          await this.cleanupExpiredOrders();
          this.lastCleanupTime = Date.now();
        }
      } catch (error) {
        this.logger.error('Error in monitor loop:', error);
      }

      // Wait before next check
      await this.sleep(this.checkInterval);
    }
  }

  /**
   * Cleanup expired tap-to-trade orders
   */
  private async cleanupExpiredOrders() {
    try {
      const expiredCount = this.tapToTradeService.cleanupExpiredOrders();
      if (expiredCount > 0) {
        this.logger.info(`🧹 Cleaned up ${expiredCount} expired tap-to-trade orders`);
      }
    } catch (error) {
      this.logger.error('Error cleaning up expired orders:', error);
    }
  }

  /**
   * Check all pending tap-to-trade orders and execute if conditions met
   */
  private async checkAndExecuteOrders() {
    try {
      const pendingOrders = this.tapToTradeService.getPendingOrders();

      if (pendingOrders.length === 0) {
        return;
      }

      const now = Math.floor(Date.now() / 1000); // Unix timestamp

      for (const order of pendingOrders) {
        try {
          // Check if order is within time window
          if (now < order.startTime) {
            // Not yet in time window
            continue;
          }

          if (now > order.endTime) {
            // Time window expired - will be cleaned up by cleanupExpiredOrders()
            continue;
          }

          // Check if we have current price for this symbol
          const priceData = this.currentPrices.get(order.symbol);
          if (!priceData) {
            continue;
          }

          // Check if price is stale (older than 1 minute)
          if (Date.now() - priceData.timestamp > 60000) {
            this.logger.warn(`⏰ Stale price for ${order.symbol}`);
            continue;
          }

          const currentPrice = priceData.price;
          const triggerPrice = BigInt(order.triggerPrice);

          // Check trigger conditions
          let shouldExecute = false;

          if (order.isLong) {
            // Long: execute when price <= trigger (buy low)
            shouldExecute = currentPrice <= triggerPrice;
          } else {
            // Short: execute when price >= trigger (sell high)
            shouldExecute = currentPrice >= triggerPrice;
          }

          if (shouldExecute) {
            this.logger.info(`🎯 Tap-to-Trade trigger met for order ${order.id}!`);
            this.logger.info(`   Symbol: ${order.symbol}`);
            this.logger.info(`   Current: ${this.formatPrice(currentPrice)}, Trigger: ${this.formatPrice(triggerPrice)}`);

            await this.executeOrder(order, currentPrice);
          }
        } catch (error: any) {
          this.logger.error(`Error checking order ${order.id}:`, error);
        }
      }
    } catch (error) {
      this.logger.error('Error checking tap-to-trade orders:', error);
    }
  }

  /**
   * Execute a tap-to-trade order directly via MarketExecutor
   */
  private async executeOrder(order: TapToTradeOrder, currentPrice: bigint) {
    try {
      this.logger.info(`🚀 Executing tap-to-trade order ${order.id}...`);

      // Mark as executing
      this.tapToTradeService.markAsExecuting(order.id);

      // Sign price (subtract 60 seconds to avoid "Price in future" error)
      const timestamp = Math.floor(Date.now() / 1000) - 60;
      const signedPrice = await this.signPrice(order.symbol, currentPrice, timestamp);

      this.logger.info('Price signature details:', {
        symbol: signedPrice.symbol,
        price: this.formatPrice(signedPrice.price),
        timestamp: signedPrice.timestamp,
        signer: this.priceSignerAddress,
        signature: signedPrice.signature.substring(0, 20) + '...',
      });

      // Execute tap-to-trade order via TapToTradeExecutor.executeTapToTrade()
      // This supports both user signature AND session key signature
      // Log execution parameters for debugging
      this.logger.info('Execution parameters:', {
        trader: order.trader,
        symbol: order.symbol,
        isLong: order.isLong,
        collateral: order.collateral,
        leverage: order.leverage,
        nonce: order.nonce,
        price: this.formatPrice(signedPrice.price),
      });
      
      // Log user signature for debugging
      this.logger.info('User signature details:', {
        signature: order.signature,
        signatureLength: order.signature.length,
        contractAddress: this.tapToTradeExecutorAddress,
      });
      
      // CHECK: Validate nonce before execution
      const currentNonceOnChain = await this.tapToTradeExecutor.metaNonces(order.trader);
      this.logger.info('Nonce validation:', {
        orderNonce: order.nonce,
        currentNonceOnChain: currentNonceOnChain.toString(),
        match: order.nonce === currentNonceOnChain.toString(),
      });
      
      if (order.nonce !== currentNonceOnChain.toString()) {
        this.logger.warn('\u274c Nonce mismatch! Order signature is stale.');
        this.logger.warn(`   Order was signed with nonce ${order.nonce}, but contract nonce is now ${currentNonceOnChain.toString()}`);
        this.logger.warn('   This usually happens when another order was executed after this order was created.');
        this.logger.warn('   Marking order as NEEDS_RESIGN. Frontend will request user to re-sign...');
        
        // Mark as needs re-sign - frontend will prompt user to re-sign
        this.tapToTradeService.markAsNeedsResign(order.id, `Nonce mismatch: order nonce=${order.nonce}, contract nonce=${currentNonceOnChain.toString()}. Re-signature required.`);
        return; // Skip execution, wait for re-sign
      }
      
      // Verify signature was created with correct parameters
      const expectedMessageHash = ethers.solidityPackedKeccak256(
        ['address', 'string', 'bool', 'uint256', 'uint256', 'uint256', 'address'],
        [
          order.trader,
          order.symbol,
          order.isLong,
          BigInt(order.collateral),
          BigInt(order.leverage),
          BigInt(order.nonce),
          this.tapToTradeExecutorAddress
        ]
      );
      this.logger.info('Expected message hash for signature:', expectedMessageHash);
      
      // PRE-EXECUTION SIGNATURE VERIFICATION
      // Verify signature locally before sending to chain to catch errors early
      try {
        const digest = ethers.hashMessage(ethers.getBytes(expectedMessageHash));
        const recoveredSigner = ethers.recoverAddress(digest, order.signature);
        
        this.logger.info('🔍 Pre-execution signature verification:', {
          messageHash: expectedMessageHash,
          digest,
          recoveredSigner,
          expectedTrader: order.trader,
          hasSessionKey: !!order.sessionKey,
          sessionKeyAddress: order.sessionKey?.address,
        });
        
        // Check if recovered signer matches trader OR session key
        const isValidSigner = recoveredSigner.toLowerCase() === order.trader.toLowerCase() ||
          (order.sessionKey && recoveredSigner.toLowerCase() === order.sessionKey.address.toLowerCase());
        
        if (!isValidSigner) {
          const errorMsg = `Signature verification failed: recovered=${recoveredSigner}, expected=${order.trader}${order.sessionKey ? ` or session key ${order.sessionKey.address}` : ''}`;
          this.logger.error('❌', errorMsg);
          this.tapToTradeService.markAsFailed(order.id, errorMsg);
          return;
        }
        
        this.logger.info('✅ Pre-execution signature verification passed');
      } catch (sigErr: any) {
        this.logger.error('❌ Pre-execution signature verification error:', sigErr.message);
        this.tapToTradeService.markAsFailed(order.id, `Signature verification error: ${sigErr.message}`);
        return;
      }

      // Use different execution method based on whether order has session key
      let tx;
      
      if (order.sessionKey) {
        // Order signed with session key - use keeper-only execution (no signature verification on-chain)
        this.logger.info('🔑 Order has session key - using keeper-only execution');
        this.logger.info('⚡ Backend validated session signature off-chain, keeper executes without on-chain verification');
        
        // Call executeTapToTradeByKeeper - no signature parameter needed!
        tx = await this.tapToTradeExecutor.executeTapToTradeByKeeper(
          order.trader,
          order.symbol,
          order.isLong,
          BigInt(order.collateral),
          BigInt(order.leverage),
          signedPrice,
          { gasLimit: 800000 }
        );
        
        this.logger.info('✅ Keeper execution successful (fully gasless for user!)');
      } else {
        // Traditional flow - user signature verified on-chain
        this.logger.info('📝 Order has traditional signature - using meta-transaction flow');
        
        tx = await this.tapToTradeExecutor.executeTapToTrade(
          order.trader,
          order.symbol,
          order.isLong,
          BigInt(order.collateral),
          BigInt(order.leverage),
          signedPrice,
          order.signature,
          { gasLimit: 800000 }
        );
      }

      this.logger.info(`📤 Execution tx sent: ${tx.hash}`);

      const receipt = await tx.wait();

      // Extract positionId from events
      let positionId = '0';
      for (const log of receipt.logs) {
        try {
          const parsed = this.tapToTradeExecutor.interface.parseLog({
            topics: log.topics as string[],
            data: log.data,
          });

          if (parsed && parsed.name === 'MarketOrderExecuted') {
            positionId = parsed.args.positionId.toString();
            break;
          }
        } catch (e) {
          // Skip logs that can't be parsed
        }
      }

      // Mark as executed
      this.tapToTradeService.markAsExecuted(
        order.id,
        receipt.hash,
        positionId,
        currentPrice.toString()
      );

      this.logger.success(`✅ Tap-to-Trade order ${order.id} executed successfully!`);
      this.logger.info(`   Position ID: ${positionId}`);
      this.logger.info(`   TX: ${receipt.hash}`);
      this.logger.info(`   Gas used: ${receipt.gasUsed.toString()}`);
    } catch (error: any) {
      this.logger.error(`❌ Failed to execute tap-to-trade order ${order.id}:`, error.message);

      // Mark as failed
      this.tapToTradeService.markAsFailed(order.id, error.message || 'Execution failed');

      // Try to decode error
      if (error.receipt) {
        this.logger.error('Transaction failed on-chain:', {
          txHash: error.receipt.hash,
          status: error.receipt.status,
          gasUsed: error.receipt.gasUsed?.toString(),
          blockNumber: error.receipt.blockNumber,
        });
      }

      // Log specific common errors
      const errorText = error.message || '';
      if (errorText.includes('USDC transfer failed') || errorText.includes('ERC20: insufficient allowance')) {
        this.logger.warn('💰 User needs to approve USDC or has insufficient balance');
      } else if (errorText.includes('Invalid signature') || errorText.includes('Invalid user signature')) {
        this.logger.warn('🔏 Invalid user signature - possibly wrong nonce or signature mismatch');
        this.logger.warn(`   Expected nonce: ${order.nonce}`);
        this.logger.warn(`   Trader address: ${order.trader}`);
      } else if (errorText.includes('Trade validation failed')) {
        this.logger.warn('⚠️  RiskManager rejected the trade - check leverage/collateral limits');
      } else if (errorText.includes('Price in future')) {
        this.logger.warn('⏱️  Price timestamp is in the future (clock drift)');
      } else if (errorText.includes('execution reverted') && !error.reason) {
        this.logger.warn('❓ Transaction reverted with no reason - common causes:');
        this.logger.warn('   1. Nonce mismatch (user signature used wrong nonce)');
        this.logger.warn('   2. Insufficient USDC balance or allowance');
        this.logger.warn('   3. Invalid signature format');
        this.logger.warn('   4. RiskManager validation failed');
      }
    }
  }

  /**
   * Sign price data (backend signer)
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
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Get executor status
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      checkInterval: this.checkInterval,
      trackedPrices: Array.from(this.currentPrices.keys()),
      keeperAddress: this.keeperWallet.address,
      pendingOrders: this.tapToTradeService.getPendingOrders().length,
    };
  }
}
