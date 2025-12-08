/**
 * Limit Order Executor Service
 *
 * Background service that:
 * 1. Monitors all pending limit orders from smart contract
 * 2. Checks Pyth oracle prices
 * 3. Executes orders when trigger price is reached
 * 4. Monitors grid trading cells for time window validation
 */

import { ethers, Contract } from 'ethers';
import { Logger } from '../utils/Logger';
import LimitExecutorABI from '../abis/LimitExecutor.json';
import { GridTradingService } from './GridTradingService';
import { GridCell, GridCellStatus } from '../types/gridTrading';

interface PendingOrder {
  id: bigint;
  orderType: number;
  trader: string;
  symbol: string;
  isLong: boolean;
  collateral: bigint;
  leverage: bigint;
  triggerPrice: bigint;
  positionId: bigint;
  expiresAt: bigint;
}

export class LimitOrderExecutor {
  private logger: Logger;
  private provider: ethers.JsonRpcProvider;
  private keeperWallet: ethers.Wallet;
  private limitExecutor: Contract;
  private limitExecutorAddress: string;
  private priceSignerAddress: string;
  private priceSignerWallet: ethers.Wallet;
  private isRunning: boolean = false;
  private checkInterval: number = 5000; // Check every 5 seconds
  private currentPrices: Map<string, { price: bigint; timestamp: number }> = new Map();
  private gridService?: GridTradingService; // Optional grid trading service
  private tpslMonitor?: any; // TPSLMonitor for auto-setting TP/SL
  private limitOrderService?: any; // LimitOrderService for retrieving TP/SL data
  private lastCleanupTime: number = 0;
  private cleanupInterval: number = 30000; // Cleanup expired cells every 30 seconds
  private tradingPairAddress: string;

  constructor(
    pythPriceService: any,
    gridService?: GridTradingService,
    tpslMonitor?: any,
    limitOrderService?: any
  ) {
    this.gridService = gridService;
    this.tpslMonitor = tpslMonitor;
    this.limitOrderService = limitOrderService;
    this.logger = new Logger('LimitOrderExecutor');

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
    const priceSignerKey = process.env.RELAY_PRIVATE_KEY;
    if (!priceSignerKey) {
      throw new Error('RELAY_PRIVATE_KEY not configured for price signing');
    }
    this.priceSignerWallet = new ethers.Wallet(priceSignerKey);
    this.priceSignerAddress = this.priceSignerWallet.address;

    // LimitExecutor contract
    this.limitExecutorAddress = process.env.LIMIT_EXECUTOR_ADDRESS || '';
    if (!this.limitExecutorAddress) {
      throw new Error('LIMIT_EXECUTOR_ADDRESS not configured');
    }

    this.limitExecutor = new Contract(
      this.limitExecutorAddress,
      LimitExecutorABI.abi,
      this.keeperWallet
    );

    // PositionManager address for querying position IDs
    this.tradingPairAddress = process.env.POSITION_MANAGER_ADDRESS || '';
    if (!this.tradingPairAddress) {
      throw new Error('POSITION_MANAGER_ADDRESS not configured');
    }

    // Subscribe to Pyth price updates
    if (pythPriceService) {
      pythPriceService.onPriceUpdate((prices: any) => {
        // Update all prices from Pyth feed
        Object.keys(prices).forEach((symbol) => {
          const priceData = prices[symbol];
          // Convert price to 8 decimals (contract format)
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

    this.logger.info('🤖 Limit Order Executor initialized');
    this.logger.info(`   Keeper: ${this.keeperWallet.address}`);
    this.logger.info(`   Price Signer: ${this.priceSignerAddress}`);
    this.logger.info(`   LimitExecutor: ${this.limitExecutorAddress}`);
  }

  /**
   * Start monitoring and executing orders
   */
  start() {
    if (this.isRunning) {
      this.logger.warn('⚠️  Executor already running');
      return;
    }

    this.isRunning = true;
    this.logger.info('▶️  Starting limit order executor...');
    this.monitorLoop();
  }

  /**
   * Stop executor
   */
  stop() {
    this.isRunning = false;
    this.logger.info('⏹️  Stopping limit order executor...');
  }

  /**
   * Main monitoring loop
   */
  private async monitorLoop() {
    while (this.isRunning) {
      try {
        await this.checkAndExecuteOrders();

        // Grid trading: cleanup expired cells periodically
        if (this.gridService && Date.now() - this.lastCleanupTime > this.cleanupInterval) {
          await this.cleanupExpiredGridCells();
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
   * Cleanup expired grid cells (called periodically)
   */
  private async cleanupExpiredGridCells() {
    if (!this.gridService) return;

    try {
      const expiredCount = this.gridService.cleanupExpiredCells();
      if (expiredCount > 0) {
        this.logger.info(`🧹 Cleaned up ${expiredCount} expired grid cells`);
      }
    } catch (error) {
      this.logger.error('Error cleaning up expired cells:', error);
    }
  }

  /**
   * Check if order is part of grid trading and validate time window
   * Returns true if order should be executed, false if outside time window
   */
  private shouldExecuteGridOrder(orderId: string): boolean {
    if (!this.gridService) return true; // No grid service, allow all orders

    try {
      // Find grid cell that contains this order
      const activeCells = this.gridService.getActiveCells();
      const cell = activeCells.find(c => c.orderIds.includes(orderId));

      if (!cell) {
        // Not a grid order, allow execution
        return true;
      }

      const now = Math.floor(Date.now() / 1000); // Unix timestamp

      // Check if within time window
      if (now < cell.startTime) {
        this.logger.debug(`⏰ Order ${orderId} not yet in time window (starts at ${cell.startTime})`);
        return false;
      }

      if (now > cell.endTime) {
        this.logger.warn(`⏰ Order ${orderId} time window expired (ended at ${cell.endTime})`);

        // Mark cell as expired
        this.gridService.updateCellStatus(cell.id, GridCellStatus.EXPIRED);

        // TODO: Cancel order on-chain (need gasless cancel implementation)
        // For now, just prevent execution
        return false;
      }

      // Within time window, allow execution
      return true;

    } catch (error) {
      this.logger.error('Error checking grid order time window:', error);
      // On error, allow execution to be safe
      return true;
    }
  }

  /**
   * Check all pending orders and execute if trigger met
   */
  private async checkAndExecuteOrders() {
    try {
      // Get all pending orders (you might want to implement getUserPendingOrders for all users)
      // For now, we'll use a workaround: check nextOrderId and query each
      const nextOrderId = await this.limitExecutor.nextOrderId();
      const currentOrderId = Number(nextOrderId);

      if (currentOrderId === 1) {
        // No orders yet
        return;
      }

      // Check last 100 orders (or all if less)
      const startId = Math.max(1, currentOrderId - 100);
      
      for (let orderId = startId; orderId < currentOrderId; orderId++) {
        try {
          const order = await this.limitExecutor.getOrder(orderId);
          
          // Check if order is pending
          if (order.status !== 0n) continue; // 0 = PENDING
          
          // Check if not cancelled
          const isCancelled = await this.limitExecutor.cancelledOrders(orderId);
          if (isCancelled) continue;

          // Check if expired
          const now = Math.floor(Date.now() / 1000);
          if (now >= Number(order.expiresAt)) {
            this.logger.warn(`⏰ Order ${orderId} expired`);
            continue;
          }

          // Check if we have current price for this symbol
          const priceData = this.currentPrices.get(order.symbol);
          if (!priceData) {
            // this.logger.debug(`No price data for ${order.symbol}`);
            continue;
          }

          // Check if price is stale (older than 1 minute)
          if (Date.now() - priceData.timestamp > 60000) {
            this.logger.warn(`⏰ Stale price for ${order.symbol}`);
            continue;
          }

          const currentPrice = priceData.price;
          const triggerPrice = order.triggerPrice;

          // Check trigger conditions based on order type
          let shouldExecute = false;

          if (order.orderType === 0n) {
            // LIMIT_OPEN
            if (order.isLong) {
              // Long: execute when price <= trigger (buy low)
              shouldExecute = currentPrice <= triggerPrice;
            } else {
              // Short: execute when price >= trigger (sell high)
              shouldExecute = currentPrice >= triggerPrice;
            }
          } else if (order.orderType === 1n) {
            // LIMIT_CLOSE (Take Profit)
            if (order.isLong) {
              // Long TP: execute when price >= trigger (sell high)
              shouldExecute = currentPrice >= triggerPrice;
            } else {
              // Short TP: execute when price <= trigger (buy low to close)
              shouldExecute = currentPrice <= triggerPrice;
            }
          } else if (order.orderType === 2n) {
            // STOP_LOSS
            if (order.isLong) {
              // Long SL: execute when price <= trigger (cut loss)
              shouldExecute = currentPrice <= triggerPrice;
            } else {
              // Short SL: execute when price >= trigger (cut loss)
              shouldExecute = currentPrice >= triggerPrice;
            }
          }

          if (shouldExecute) {
            // Grid trading: Check time window validation
            const canExecute = this.shouldExecuteGridOrder(orderId.toString());
            if (!canExecute) {
              // Order is outside time window, skip execution
              continue;
            }

            this.logger.info(`🎯 Trigger met for order ${orderId}!`);
            this.logger.info(`   Symbol: ${order.symbol}`);
            this.logger.info(`   Current: ${this.formatPrice(currentPrice)}, Trigger: ${this.formatPrice(triggerPrice)}`);

            await this.executeOrder(order, currentPrice);
          }

        } catch (error: any) {
          if (!error.message?.includes('Order not found')) {
            this.logger.error(`Error checking order ${orderId}:`, error);
          }
        }
      }

    } catch (error) {
      this.logger.error('Error checking orders:', error);
    }
  }

  /**
   * Execute a limit order
   */
  private async executeOrder(order: any, currentPrice: bigint) {
    const orderId = Number(order.id);
    
    try {
      this.logger.info(`🚀 Executing order ${orderId}...`);

      // Sign price
      // IMPORTANT: Subtract 60 seconds from current time to avoid "Price in future" error
      // This accounts for: clock drift + transaction delay + block timestamp variations
      const timestamp = Math.floor(Date.now() / 1000) - 60;
      const signedPrice = await this.signPrice(order.symbol, currentPrice, timestamp);
      
      this.logger.info('Price signature details:', {
        symbol: signedPrice.symbol,
        price: this.formatPrice(signedPrice.price),
        timestamp: signedPrice.timestamp,
        signer: this.priceSignerAddress,
        signature: signedPrice.signature.substring(0, 20) + '...',
      });

      // Execute based on order type
      let tx;
      if (order.orderType === 0n) {
        // LIMIT_OPEN
        tx = await this.limitExecutor.executeLimitOpenOrder(
          orderId,
          signedPrice,
          { gasLimit: 600000 }
        );
      } else if (order.orderType === 1n) {
        // LIMIT_CLOSE
        tx = await this.limitExecutor.executeLimitCloseOrder(
          orderId,
          signedPrice,
          { gasLimit: 500000 }
        );
      } else if (order.orderType === 2n) {
        // STOP_LOSS
        tx = await this.limitExecutor.executeStopLossOrder(
          orderId,
          signedPrice,
          { gasLimit: 500000 }
        );
      } else {
        throw new Error(`Unknown order type: ${order.orderType}`);
      }

      this.logger.info(`📤 Execution tx sent: ${tx.hash}`);
      
      const receipt = await tx.wait();
      
      this.logger.success(`✅ Order ${orderId} executed successfully!`);
      this.logger.info(`   TX: ${receipt.hash}`);
      this.logger.info(`   Gas used: ${receipt.gasUsed.toString()}`);

      // Auto-set TP/SL if configured for this order (LIMIT_OPEN only)
      if (order.orderType === 0n && this.tpslMonitor && this.limitOrderService) {
        try {
          // Extract position ID from PositionOpened event (same as RelayService)
          let positionId: number | undefined;
          const positionOpenedTopic = ethers.id('PositionOpened(uint256,address,string,bool,uint256,uint256,uint256,uint256)');
          
          for (const log of receipt.logs) {
            // Check if log is from PositionManager contract
            if (log.address.toLowerCase() === this.tradingPairAddress.toLowerCase() && 
                log.topics[0] === positionOpenedTopic) {
              if (log.topics.length > 1) {
                // Parse position ID from indexed parameter (topic[1])
                positionId = parseInt(log.topics[1], 16);
                this.logger.info(`🎯 Extracted position ID from event: ${positionId}`);
                break;
              }
            }
          }

          if (positionId) {
            // Wait for blockchain to finalize the position data
            this.logger.info('⏳ Waiting for blockchain to finalize position data...');
            await this.sleep(2000); // Wait 2 seconds
            await this.autoSetTPSLDirect(orderId, positionId, order.trader);
          } else {
            this.logger.warn(`⚠️ Could not extract position ID from receipt for order ${orderId}`);
          }
        } catch (tpslError) {
          this.logger.error(`Failed to auto-set TP/SL for order ${orderId}:`, tpslError);
        }
      }

    } catch (error: any) {
      this.logger.error(`❌ Failed to execute order ${orderId}:`, error.message);
      
      // Try to decode error from transaction receipt
      if (error.receipt) {
        this.logger.error('Transaction failed on-chain:', {
          txHash: error.receipt.hash,
          status: error.receipt.status,
          gasUsed: error.receipt.gasUsed.toString(),
          blockNumber: error.receipt.blockNumber,
        });
      }
      
      // Try to call contract method to get better error message
      try {
        // Simulate the transaction to get revert reason
        const signedPrice = await this.signPrice(order.symbol, currentPrice, Math.floor(Date.now() / 1000));
        
        await this.limitExecutor.executeLimitOpenOrder.staticCall(
          orderId,
          signedPrice
        );
      } catch (simulateError: any) {
        // Extract revert reason
        let revertReason = 'Unknown';
        let decodedError = '';
        
        if (simulateError.data) {
          revertReason = simulateError.data;
          // Try to decode hex error message
          if (revertReason.startsWith('0x08c379a0')) {
            try {
              // Standard Error(string) format - skip function selector (4 bytes)
              const errorData = '0x' + revertReason.slice(10); // Remove '0x08c379a0'
              const decoded = ethers.AbiCoder.defaultAbiCoder().decode(['string'], errorData);
              decodedError = decoded[0];
              this.logger.info(`Decoded error: "${decodedError}"`);
            } catch (e) {
              this.logger.warn('Failed to decode error hex:', e);
            }
          }
        } else if (simulateError.reason) {
          revertReason = simulateError.reason;
        } else if (simulateError.message) {
          revertReason = simulateError.message;
        }
        
        const errorText = decodedError || revertReason;
        this.logger.error('Contract revert reason:', errorText);
        
        // Log specific common errors
        if (errorText.includes('USDC transfer failed') || errorText.includes('ERC20: insufficient allowance')) {
          this.logger.warn('💰 User needs to approve USDC or has insufficient balance');
        } else if (errorText.includes('Price not reached')) {
          this.logger.warn('📊 Price condition not met (race condition)');
        } else if (errorText.includes('Order expired')) {
          this.logger.warn('⏰ Order has expired');
        } else if (errorText.includes('Invalid signature') || errorText.includes('Invalid price signature')) {
          this.logger.warn('🔏 Invalid price signature');
        } else if (errorText.includes('Trade validation failed')) {
          this.logger.warn('⚠️  RiskManager rejected the trade - check leverage/collateral limits');
        } else if (errorText.includes('Price in future')) {
          this.logger.warn('⏱️  Price timestamp is in the future (clock drift)');
        }
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
   * Format USDC (6 decimals to readable)
   */
  private formatUsdc(amount: bigint): string {
    return (Number(amount) / 1000000).toFixed(2) + ' USDC';
  }

  /**
   * Auto-set TP/SL directly with position ID (extracted from event)
   */
  private async autoSetTPSLDirect(orderId: number, positionId: number, traderAddress: string) {
    try {
      // Check if this order has TP/SL preferences
      const tpslData = this.limitOrderService.getOrderTPSL(orderId.toString());
      if (!tpslData || (!tpslData.takeProfit && !tpslData.stopLoss)) {
        this.logger.debug(`No TP/SL configured for order ${orderId}`);
        return;
      }

      this.logger.info(`🎯 Auto-setting TP/SL for position ${positionId}...`);

      // Set TP/SL via TPSLMonitor (match function signature)
      await this.tpslMonitor.setTPSL(
        positionId,
        traderAddress,
        tpslData.takeProfit,
        tpslData.stopLoss
      );

      this.logger.success(`✅ Auto-set TP/SL for position ${positionId}!`);
      if (tpslData.takeProfit) {
        this.logger.info(`   TP: ${this.formatPrice(tpslData.takeProfit)}`);
      }
      if (tpslData.stopLoss) {
        this.logger.info(`   SL: ${this.formatPrice(tpslData.stopLoss)}`);
      }

      // Clear stored TP/SL data after setting
      this.limitOrderService.clearOrderTPSL(orderId.toString());

    } catch (error) {
      this.logger.error('Error in autoSetTPSLDirect:', error);
      throw error;
    }
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
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
    };
  }
}
