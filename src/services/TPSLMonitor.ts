/**
 * Take Profit / Stop Loss Monitor Service
 *
 * Monitors positions with TP/SL settings and automatically closes positions
 * when price targets are hit
 */

import { ethers, Contract } from 'ethers';
import { Logger } from '../utils/Logger';
import { TPSLConfig } from '../types';
import PositionManagerABI from '../abis/PositionManager.json';
import MarketExecutorABI from '../abis/MarketExecutor.json';
import StabilityFundABI from '../abis/StabilityFund.json';

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

export class TPSLMonitor {
  private logger: Logger;
  private provider: ethers.JsonRpcProvider;
  private keeperWallet: ethers.Wallet;
  private priceSignerWallet: ethers.Wallet;
  private positionManager: Contract;
  private marketExecutor: Contract;
  private isRunning: boolean = false;
  private checkInterval: number = 2000; // Check every 2 seconds
  private currentPrices: Map<string, { price: bigint; timestamp: number }> = new Map();
  
  // In-memory storage for TP/SL configs
  private tpslConfigs: Map<number, TPSLConfig> = new Map();

  constructor(pythPriceService: any) {
    this.logger = new Logger('TPSLMonitor');

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

    if (!positionManagerAddress || !marketExecutorAddress) {
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

    this.logger.info('🎯 TP/SL Monitor initialized');
    this.logger.info(`   Keeper: ${this.keeperWallet.address}`);
    this.logger.info(`   Position Manager: ${positionManagerAddress}`);
    this.logger.info(`   Market Executor: ${marketExecutorAddress}`);
  }

  /**
   * Start monitoring TP/SL
   */
  start() {
    if (this.isRunning) {
      this.logger.warn('⚠️  TP/SL Monitor already running');
      return;
    }

    this.isRunning = true;
    this.logger.info('▶️  Starting TP/SL monitor...');
    this.monitorLoop();
  }

  /**
   * Stop monitoring
   */
  stop() {
    this.isRunning = false;
    this.logger.info('⏹️  Stopping TP/SL monitor...');
  }

  /**
   * Main monitoring loop
   */
  private async monitorLoop() {
    while (this.isRunning) {
      try {
        await this.checkAllTPSL();
      } catch (error) {
        this.logger.error('Error in TP/SL monitor loop:', error);
      }

      // Wait before next check
      await this.sleep(this.checkInterval);
    }
  }

  /**
   * Check all positions with TP/SL
   */
  private async checkAllTPSL() {
    try {
      if (this.tpslConfigs.size === 0) {
        return; // No TP/SL configs
      }

      for (const [positionId, config] of this.tpslConfigs.entries()) {
        try {
          // Get position data
          const position = await this.getPosition(positionId);

          if (!position || position.status !== 0) {
            // Position not found or not open, remove config
            this.tpslConfigs.delete(positionId);
            this.logger.info(`🗑️  Removed TP/SL config for closed position ${positionId}`);
            continue;
          }

          // Check if TP/SL should trigger
          await this.checkTPSLTrigger(position, config);

        } catch (error: any) {
          if (!error.message?.includes('Position not found')) {
            this.logger.error(`Error checking TP/SL for position ${positionId}:`, error);
          }
        }
      }

    } catch (error) {
      this.logger.error('Error checking all TP/SL:', error);
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
        status: Number(positionData.status), // Ensure number type
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * Check if TP or SL should trigger
   */
  private async checkTPSLTrigger(position: Position, config: TPSLConfig) {
    try {
      // Get current price
      const priceData = this.currentPrices.get(position.symbol);

      if (!priceData) {
        return; // No price data
      }

      // Check if price is stale (older than 1 minute)
      if (Date.now() - priceData.timestamp > 60000) {
        return;
      }

      const currentPrice = priceData.price;
      let shouldClose = false;
      let reason = '';

      // Check Take Profit
      if (config.takeProfit) {
        if (position.isLong && currentPrice >= config.takeProfit) {
          shouldClose = true;
          reason = 'Take Profit Hit (Long)';
        } else if (!position.isLong && currentPrice <= config.takeProfit) {
          shouldClose = true;
          reason = 'Take Profit Hit (Short)';
        }
      }

      // Check Stop Loss (overrides TP if both triggered)
      if (config.stopLoss) {
        if (position.isLong && currentPrice <= config.stopLoss) {
          shouldClose = true;
          reason = 'Stop Loss Hit (Long)';
        } else if (!position.isLong && currentPrice >= config.stopLoss) {
          shouldClose = true;
          reason = 'Stop Loss Hit (Short)';
        }
      }

      if (shouldClose) {
        this.logger.warn(`🎯 ${reason} - Position ${position.id}`);
        this.logger.info(`   Entry: ${this.formatPrice(position.entryPrice)}`);
        this.logger.info(`   Current: ${this.formatPrice(currentPrice)}`);
        if (config.takeProfit) {
          this.logger.info(`   TP: ${this.formatPrice(config.takeProfit)}`);
        }
        if (config.stopLoss) {
          this.logger.info(`   SL: ${this.formatPrice(config.stopLoss)}`);
        }

        // Close position
        await this.closePosition(position, currentPrice, reason);
      }

    } catch (error) {
      this.logger.error(`Error checking TP/SL trigger for position ${position.id}:`, error);
    }
  }

  /**
   * Close a position (TP/SL triggered)
   */
  private async closePosition(position: Position, currentPrice: bigint, reason: string) {
    try {
      this.logger.info(`Closing position ${position.id} (${reason})...`);

      // Calculate PnL before closing
      const pnl = await this.positionManager.calculatePnL(position.id, currentPrice);
      
      this.logger.info('   Position details:');
      this.logger.info(`   - Collateral: ${position.collateral.toString()}`);
      this.logger.info(`   - Size: ${position.size.toString()}`);
      this.logger.info(`   - Leverage: ${position.leverage.toString()}`);
      this.logger.info(`   - PnL: ${pnl.toString()}`);

      // Close via PositionManager (manual settlement)
      const closeTx = await this.positionManager.closePosition(
        position.id,
        currentPrice,
        { gasLimit: 500000 }
      );

      this.logger.info(`Close tx sent: ${closeTx.hash}`);
      const receipt = await closeTx.wait();

      // Manual settlement (match MarketExecutor) via StabilityFund / VaultPool fallback
      const TRADING_FEE_BPS = 5n; // 0.05%
      const tradingFee = (position.size * TRADING_FEE_BPS) / 100000n;
      const maxAllowedLoss = -1n * (position.collateral * 9900n) / 10000n;
      const cappedPnl = pnl < maxAllowedLoss ? maxAllowedLoss : pnl;
      const payout = (() => {
        const raw = position.collateral + cappedPnl - tradingFee;
        return raw > 0n ? raw : 0n;
      })();

      const stabilityFundAddress = process.env.STABILITY_FUND_ADDRESS || '';
      const vaultPoolAddress = process.env.VAULT_POOL_ADDRESS || '';
      if (!stabilityFundAddress) {
        throw new Error('STABILITY_FUND_ADDRESS not configured');
      }
      if (!vaultPoolAddress) {
        throw new Error('VAULT_POOL_ADDRESS not configured');
      }

      const stabilityFund = new ethers.Contract(
        stabilityFundAddress,
        StabilityFundABI.abi,
        this.keeperWallet
      );
      const usdc = new ethers.Contract(
        await stabilityFund.usdc(),
        ['function balanceOf(address) view returns (uint256)'],
        this.keeperWallet
      );
      const bufferBalance: bigint = await usdc.balanceOf(stabilityFundAddress);

      if (payout > bufferBalance) {
        const vaultPool = new ethers.Contract(
          vaultPoolAddress,
          ['function coverPayout(address to, uint256 amount)'],
          this.keeperWallet
        );
        const coverTx = await vaultPool.coverPayout(position.trader, payout, { gasLimit: 600000 });
        this.logger.info(`coverPayout via VaultPool sent: ${coverTx.hash}`);
        this.logger.warn('Buffer insufficient; paid trader directly from VaultPool. Fees not split via StabilityFund.');
      } else {
        const settleTx = await stabilityFund.settleTrade(
          position.trader,
          position.collateral,
          cappedPnl,
          tradingFee,
          this.keeperWallet.address,
          { gasLimit: 600000 }
        );
        this.logger.info(`Settle tx sent: ${settleTx.hash}`);
      }

      this.logger.success(`Position ${position.id} closed successfully! (${reason})`);
      this.logger.info(`   TX: ${receipt.hash}`);
      this.logger.info(`   Gas used: ${receipt.gasUsed.toString()}`);

      // Remove TP/SL config
      this.tpslConfigs.delete(Number(position.id));

    } catch (error: any) {
      this.logger.error(`??O Failed to close position ${position.id}:`, error.message);
      this.logger.error('   Full error:', error);
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
   * Set or update TP/SL for a position
   */
  async setTPSL(
    positionId: number,
    trader: string,
    takeProfit?: bigint,
    stopLoss?: bigint
  ): Promise<{ success: boolean; message: string; config?: TPSLConfig }> {
    try {
      // Get position to validate
      const position = await this.getPosition(positionId);

      this.logger.info(`Validating position ${positionId}:`);
      this.logger.info(`  Position found: ${!!position}`);
      if (position) {
        this.logger.info(`  Status: ${position.status} (type: ${typeof position.status})`);
        this.logger.info(`  Status === 0: ${position.status === 0}`);
        this.logger.info(`  Status == 0: ${position.status == 0}`);
        this.logger.info(`  Trader: ${position.trader}`);
        this.logger.info(`  Symbol: ${position.symbol}`);
      }

      if (!position) {
        return {
          success: false,
          message: 'Position not found'
        };
      }

      // Use loose equality to handle type coercion
      if (position.status != 0) {
        this.logger.error(`Position ${positionId} status check failed: ${position.status} != 0`);
        return {
          success: false,
          message: `Position is not open (status: ${position.status})` 
        };
      }

      if (position.trader.toLowerCase() !== trader.toLowerCase()) {
        return {
          success: false,
          message: 'Not your position'
        };
      }

      // Validate TP/SL prices - relaxed validation
      // TP should be in profit direction
      if (takeProfit) {
        if (position.isLong && takeProfit <= position.entryPrice) {
          return {
            success: false,
            message: 'Take Profit must be above entry price for Long positions'
          };
        }
        if (!position.isLong && takeProfit >= position.entryPrice) {
          return {
            success: false,
            message: 'Take Profit must be below entry price for Short positions'
          };
        }
      }

      // SL validation - allow SL+ (trailing stop)
      // SL+ allows setting SL above entry (for Long) to lock profits
      // Only validate that it makes sense directionally vs current market
      if (stopLoss) {
        // No strict validation - allow any SL price
        // Market will determine if it triggers
        this.logger.info(`SL set at ${this.formatPrice(stopLoss)} (Entry: ${this.formatPrice(position.entryPrice)})`);
      }

      // Create or update config
      const now = Date.now();
      const existingConfig = this.tpslConfigs.get(positionId);

      const config: TPSLConfig = {
        positionId,
        trader: position.trader,
        symbol: position.symbol,
        isLong: position.isLong,
        entryPrice: position.entryPrice,
        takeProfit,
        stopLoss,
        createdAt: existingConfig?.createdAt || now,
        updatedAt: now
      };

      this.tpslConfigs.set(positionId, config);

      this.logger.success(`✅ TP/SL ${existingConfig ? 'updated' : 'set'} for position ${positionId}`);
      this.logger.info(`   Entry: ${this.formatPrice(position.entryPrice)}`);
      if (takeProfit) {
        this.logger.info(`   TP: ${this.formatPrice(takeProfit)}`);
      }
      if (stopLoss) {
        this.logger.info(`   SL: ${this.formatPrice(stopLoss)}`);
      }

      return {
        success: true,
        message: `TP/SL ${existingConfig ? 'updated' : 'set'} successfully`,
        config
      };

    } catch (error: any) {
      this.logger.error(`Error setting TP/SL for position ${positionId}:`, error);
      return {
        success: false,
        message: error.message || 'Failed to set TP/SL'
      };
    }
  }

  /**
   * Get TP/SL config for a position
   */
  getTPSL(positionId: number): TPSLConfig | undefined {
    return this.tpslConfigs.get(positionId);
  }

  /**
   * Get all TP/SL configs
   */
  getAllTPSL(): TPSLConfig[] {
    return Array.from(this.tpslConfigs.values());
  }

  /**
   * Delete TP/SL config
   */
  deleteTPSL(positionId: number, trader: string): { success: boolean; message: string } {
    const config = this.tpslConfigs.get(positionId);

    if (!config) {
      return {
        success: false,
        message: 'TP/SL config not found'
      };
    }

    if (config.trader.toLowerCase() !== trader.toLowerCase()) {
      return {
        success: false,
        message: 'Not your position'
      };
    }

    this.tpslConfigs.delete(positionId);
    this.logger.info(`🗑️  TP/SL config deleted for position ${positionId}`);

    return {
      success: true,
      message: 'TP/SL deleted successfully'
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
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get monitor status
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      checkInterval: this.checkInterval,
      activeTPSLCount: this.tpslConfigs.size,
      trackedPrices: Array.from(this.currentPrices.keys()),
      keeperAddress: this.keeperWallet.address,
    };
  }
}
