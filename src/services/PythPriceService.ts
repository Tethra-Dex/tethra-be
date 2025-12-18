import WebSocket from 'ws';
import { Logger } from '../utils/Logger';
import { MultiAssetPriceData, PriceData, SUPPORTED_ASSETS } from '../types';

export class PythPriceService {
  private logger: Logger;
  private currentPrices: MultiAssetPriceData = {};
  private priceUpdateCallbacks: ((prices: MultiAssetPriceData) => void)[] = [];
  private pythWs: WebSocket | null = null;
  private readonly PYTH_HERMES_WS = 'wss://hermes.pyth.network/ws';
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;

  constructor() {
    this.logger = new Logger('PythPriceService');
  }

  async initialize(): Promise<void> {
    const pythAssets = SUPPORTED_ASSETS.filter((a) => !!a.pythPriceId);

    this.logger.info('Initializing Pyth Price Service...');
    this.logger.info(`Monitoring ${pythAssets.length} assets via Pyth Network`);
    this.logger.info(`Connecting to: ${this.PYTH_HERMES_WS}`);

    this.connectPythWebSocket();
    this.logger.success('Pyth Price Service initialized successfully');
  }

  private connectPythWebSocket(): void {
    try {
      this.logger.info('Connecting to Pyth WebSocket...');

      this.pythWs = new WebSocket(this.PYTH_HERMES_WS);

      this.pythWs.on('open', () => {
        this.logger.success('Pyth WebSocket connected');
        this.reconnectAttempts = 0;

        const priceIds = SUPPORTED_ASSETS.map((asset) => asset.pythPriceId).filter((id): id is string => !!id);
        const subscribeMessage = {
          type: 'subscribe',
          ids: priceIds,
        };

        this.pythWs!.send(JSON.stringify(subscribeMessage));
        this.logger.info(`Subscribed to ${priceIds.length} price feeds`);
      });

      this.pythWs.on('message', (data: WebSocket.Data) => {
        try {
          const message = JSON.parse(data.toString());

          if (message.type === 'price_update') {
            this.processPriceUpdate(message);
          } else if (message.type === 'response') {
            if (message.status === 'error') {
              this.logger.error(`Pyth subscription error: ${message.error}`);
            }
          }
        } catch (error) {
          this.logger.error('Error parsing Pyth message:', error);
        }
      });

      this.pythWs.on('error', (error) => {
        this.logger.error('Pyth WebSocket error:', error);
      });

      this.pythWs.on('close', () => {
        this.logger.warn('Pyth WebSocket disconnected');
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
      if (!priceFeed || !priceFeed.price) return;

      const feedIdWithPrefix = priceFeed.id.startsWith('0x') ? priceFeed.id : `0x${priceFeed.id}`;
      const asset = SUPPORTED_ASSETS.find(
        (a) => !!a.pythPriceId && a.pythPriceId.toLowerCase() === feedIdWithPrefix.toLowerCase()
      );
      if (!asset) return;

      const priceData = priceFeed.price;
      const priceRaw = parseFloat(priceData.price);
      const expo = priceData.expo;
      const confidenceRaw = parseFloat(priceData.conf);
      const publishTimeMs = parseInt(priceData.publish_time, 10) * 1000;

      const price = priceRaw * Math.pow(10, expo);
      const confidence = confidenceRaw * Math.pow(10, expo);

      const now = Date.now();
      const age = now - publishTimeMs;
      if (age > 60000) {
        return;
      }

      this.currentPrices[asset.symbol] = {
        symbol: asset.symbol,
        price,
        confidence,
        expo,
        timestamp: publishTimeMs,
        source: 'pyth',
        publishTime: publishTimeMs,
      };

      this.notifyPriceUpdate();
    } catch (error) {
      this.logger.error('Error processing price update:', error);
    }
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.logger.error(`Max reconnect attempts (${this.maxReconnectAttempts}) reached`);
      return;
    }

    this.reconnectAttempts++;
    const delay = 5000 * this.reconnectAttempts;

    this.logger.info(`Attempting to reconnect in ${delay / 1000}s... (${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
    setTimeout(() => this.connectPythWebSocket(), delay);
  }

  private notifyPriceUpdate(): void {
    const snapshot = this.getCurrentPrices();
    for (const callback of this.priceUpdateCallbacks) {
      try {
        callback(snapshot);
      } catch (error) {
        this.logger.error('Error in price update callback:', error);
      }
    }
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
        assetsMonitored: 0,
      };
    }

    const latestUpdate = Math.max(...prices.map((p) => p.timestamp));
    const timeSinceLastUpdate = Date.now() - latestUpdate;
    const isHealthy = timeSinceLastUpdate < 30000;

    return {
      status: isHealthy ? 'connected' : 'stale',
      lastUpdate: latestUpdate,
      assetsMonitored: prices.length,
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

    this.logger.success('Pyth Price Service shut down successfully');
  }
}

