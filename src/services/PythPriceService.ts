import WebSocket from 'ws';
import { Logger } from '../utils/Logger';
import { PriceData, MultiAssetPriceData, SUPPORTED_ASSETS, AssetConfig } from '../types';
import { normalizePythPriceId, resolvePythAssetsFromEnv } from '../config/pythFeeds';

export class PythPriceService {
  private logger: Logger;
  private currentPrices: MultiAssetPriceData = {};
  private priceUpdateCallbacks: ((prices: MultiAssetPriceData) => void)[] = [];
  private pythWs: WebSocket | null = null;
  private readonly PYTH_HERMES_WS = 'wss://hermes.pyth.network/ws';
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private assets: AssetConfig[] = [];
  private assetByFeedId: Map<string, AssetConfig> = new Map();

  constructor() {
    this.logger = new Logger('PythPriceService');
  }

  async initialize(): Promise<void> {
    this.logger.info('🚀 Initializing Pyth Price Service...');

    const resolved = resolvePythAssetsFromEnv(SUPPORTED_ASSETS, process.env);

    for (const warning of resolved.warnings) {
      this.logger.warn(warning);
    }

    this.assetByFeedId = new Map();
    for (const asset of resolved.assets) {
      const normalized = normalizePythPriceId(asset.pythPriceId);
      if (!normalized) {
        this.logger.warn(
          `Skipping asset ${asset.symbol}: invalid pythPriceId "${asset.pythPriceId}"`
        );
        continue;
      }

      const normalizedAsset = { ...asset, pythPriceId: normalized };
      this.assetByFeedId.set(normalized, normalizedAsset);
    }

    this.assets = Array.from(this.assetByFeedId.values());

    this.logger.info(
      `📊 Monitoring ${this.assets.length} assets via Pyth Network${resolved.usedCustomFeeds ? ' (custom feeds from env)' : ''}`
    );
    this.logger.info(`📡 Connecting to: ${this.PYTH_HERMES_WS}`);
    
    // Connect to Pyth WebSocket
    this.connectPythWebSocket();
    
    this.logger.success('✅ Pyth Price Service initialized successfully');
  }

  private connectPythWebSocket(): void {
    try {
      this.logger.info('🔗 Connecting to Pyth WebSocket...');
      
      this.pythWs = new WebSocket(this.PYTH_HERMES_WS);
      
      this.pythWs.on('open', () => {
        this.logger.success('✅ Pyth WebSocket connected');
        this.reconnectAttempts = 0;
        
        // Subscribe to all price feeds
        const priceIds = this.assets.map(asset => asset.pythPriceId);
        const subscribeMessage = {
          type: 'subscribe',
          ids: priceIds
        };
        
        this.pythWs!.send(JSON.stringify(subscribeMessage));
        this.logger.info(`📡 Subscribed to ${this.assets.length} price feeds`);
      });
      
      this.pythWs.on('message', (data: WebSocket.Data) => {
        try {
          const message = JSON.parse(data.toString());
          
          // Pyth sends different message types
          if (message.type === 'price_update') {
            this.processPriceUpdate(message);
          } else if (message.type === 'response') {
            // Log subscription responses (success/error)
            if (message.status === 'error') {
              this.logger.error(`❌ Pyth subscription error: ${message.error}`);
            } else {
              this.logger.debug(`📬 Subscription response: ${JSON.stringify(message)}`);
            }
          }
        } catch (error) {
          this.logger.error('Error parsing Pyth message:', error);
        }
      });
      
      this.pythWs.on('error', (error) => {
        this.logger.error('❌ Pyth WebSocket error:', error);
      });
      
      this.pythWs.on('close', () => {
        this.logger.warn('🔌 Pyth WebSocket disconnected');
        this.attemptReconnect();
      });
      
    } catch (error) {
      this.logger.error('Failed to connect to Pyth WebSocket:', error);
      this.attemptReconnect();
    }
  }

  private processPriceUpdate(message: any): void {
    try {
      const priceFeed = message.price_feed;
      if (!priceFeed || !priceFeed.price) {
        return;
      }
      
      // Find the asset by price feed ID
      // Pyth sends ID without 0x prefix, so normalize both for comparison
      const feedIdWithPrefix = priceFeed.id.startsWith('0x') ? priceFeed.id : `0x${priceFeed.id}`;
      const normalizedFeedId = normalizePythPriceId(feedIdWithPrefix);
      const asset = normalizedFeedId ? this.assetByFeedId.get(normalizedFeedId) : undefined;
      
      if (!asset) {
        return;
      }
      
      const priceData = priceFeed.price;
      
      // Parse Pyth price format
      const priceRaw = parseFloat(priceData.price);
      const expo = priceData.expo;
      const confidenceRaw = parseFloat(priceData.conf);
      const publishTime = parseInt(priceData.publish_time) * 1000; // Convert to milliseconds
      
      // Convert price with exponential
      const price = priceRaw * Math.pow(10, expo);
      const confidence = confidenceRaw * Math.pow(10, expo);

      const now = Date.now();
      const age = now - publishTime;
      const currentPrice = this.currentPrices[asset.symbol];

      // If data is older than 60s and we already have a price, keep the last known value
      if (age > 60000 && currentPrice) {
        return;
      }

      // Ignore out-of-order updates that are not newer than what we already have
      if (currentPrice && currentPrice.publishTime !== undefined && publishTime <= currentPrice.publishTime) {
        return;
      }

      // Update price cache (may use stale data only when we have nothing yet)
      this.currentPrices[asset.symbol] = {
        symbol: asset.symbol,
        price: price,
        confidence: confidence,
        expo: expo,
        timestamp: publishTime,
        source: 'pyth',
        publishTime: publishTime
      };
      
      // Log occasionally to avoid spam (1% chance)
      if (Math.random() < 0.01) {
        const confidencePercent = (confidence / price) * 100;
        this.logger.info(`📊 ${asset.symbol}: $${price.toFixed(2)} (±${confidencePercent.toFixed(4)}%)`);
      }
      
      // Notify callbacks
      this.notifyPriceUpdate();
      
    } catch (error) {
      this.logger.error('Error processing price update:', error);
    }
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.logger.error(`❌ Max reconnect attempts (${this.maxReconnectAttempts}) reached`);
      return;
    }
    
    this.reconnectAttempts++;
    const delay = 5000 * this.reconnectAttempts; // Exponential backoff
    
    this.logger.info(`♻️ Attempting to reconnect in ${delay/1000}s... (${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
    
    setTimeout(() => {
      this.connectPythWebSocket();
    }, delay);
  }

  private notifyPriceUpdate(): void {
    this.priceUpdateCallbacks.forEach(callback => {
      try {
        callback(this.currentPrices);
      } catch (error) {
        this.logger.error('Error in price update callback:', error);
      }
    });
  }

  getCurrentPrices(): MultiAssetPriceData {
    return { ...this.currentPrices };
  }

  getCurrentPrice(symbol: string): PriceData | null {
    return this.currentPrices[symbol] || null;
  }

  onPriceUpdate(callback: (prices: MultiAssetPriceData) => void): void {
    this.priceUpdateCallbacks.push(callback);
  }

  removePriceUpdateCallback(callback: (prices: MultiAssetPriceData) => void): void {
    const index = this.priceUpdateCallbacks.indexOf(callback);
    if (index > -1) {
      this.priceUpdateCallbacks.splice(index, 1);
    }
  }

  getHealthStatus(): { status: string; lastUpdate: number; assetsMonitored: number } {
    const prices = Object.values(this.currentPrices);
    if (prices.length === 0) {
      return {
        status: 'disconnected',
        lastUpdate: 0,
        assetsMonitored: 0
      };
    }

    const latestUpdate = Math.max(...prices.map(p => p.timestamp));
    const timeSinceLastUpdate = Date.now() - latestUpdate;
    const isHealthy = timeSinceLastUpdate < 30000; // 30 seconds

    return {
      status: isHealthy ? 'connected' : 'stale',
      lastUpdate: latestUpdate,
      assetsMonitored: prices.length
    };
  }

  async shutdown(): Promise<void> {
    this.logger.info('Shutting down Pyth Price Service...');
    
    if (this.pythWs) {
      this.pythWs.close();
      this.pythWs = null;
    }
    
    this.priceUpdateCallbacks = [];
    this.currentPrices = {};
    
    this.logger.success('✅ Pyth Price Service shut down successfully');
  }
}
