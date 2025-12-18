import { Contract, ethers } from 'ethers';
import { Logger } from '../utils/Logger';
import { MultiAssetPriceData, PriceData, SUPPORTED_ASSETS } from '../types';

const AGGREGATOR_V3_ABI = [
  'function decimals() view returns (uint8)',
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
];

type FeedMeta = {
  contract: Contract;
  decimals: number;
};

export class ChainlinkPriceService {
  private logger: Logger;
  private provider: ethers.JsonRpcProvider;

  private currentPrices: MultiAssetPriceData = {};
  private priceUpdateCallbacks: ((prices: MultiAssetPriceData) => void)[] = [];

  private pollIntervalMs: number;
  private maxPriceAgeSec: number;
  private pollTimer: NodeJS.Timeout | null = null;

  private feeds: Map<string, FeedMeta> = new Map();

  constructor() {
    this.logger = new Logger('ChainlinkPriceService');

    // Allow using a different RPC for Chainlink feeds than the trading/contract RPC.
    // This is useful when your contracts are on Base Sepolia but you want to read
    // mainnet Chainlink feeds (or vice versa).
    const rpcUrl = process.env.CHAINLINK_RPC_URL || process.env.RPC_URL || 'https://sepolia.base.org';
    this.provider = new ethers.JsonRpcProvider(rpcUrl);

    this.pollIntervalMs = Number(process.env.CHAINLINK_POLL_INTERVAL_MS || 2500);
    // Chainlink price feeds often update on heartbeat/deviation thresholds (not every few seconds like Pyth),
    // so the default max-age must be relatively high to avoid rejecting valid data as "stale".
    this.maxPriceAgeSec = Number(process.env.CHAINLINK_MAX_PRICE_AGE_SEC || 3600);
  }

  async initialize(): Promise<void> {
    this.logger.info('dYs? Initializing Chainlink Price Service...');
    this.logger.info(`dY"S Monitoring ${SUPPORTED_ASSETS.length} assets via Chainlink Price Feeds`);
    this.logger.info(`dY"н RPC (Chainlink): ${process.env.CHAINLINK_RPC_URL || process.env.RPC_URL || 'https://sepolia.base.org'}`);

    try {
      const network = await this.provider.getNetwork();
      this.logger.info(`dY"н Chainlink network: chainId=${network.chainId.toString()}`);
    } catch (error) {
      this.logger.error('Failed to detect Chainlink RPC network (provider.getNetwork)', error);
    }

    await this.loadFeeds();

    if (this.feeds.size === 0) {
      this.logger.warn('ƒsÿ‹,? No Chainlink feeds configured; set CHAINLINK_FEEDS or CHAINLINK_FEED_<SYMBOL> env vars');
    }

    this.startPolling();
    this.logger.success('ƒo. Chainlink Price Service initialized successfully');
  }

  private async loadFeeds(): Promise<void> {
    const feedsFromEnv = this.readFeedsFromEnv();

    const assetsWithFeeds = SUPPORTED_ASSETS.map((asset) => {
      const address =
        asset.chainlinkFeedAddress ||
        feedsFromEnv[this.normalizeSymbolKey(asset.symbol)] ||
        feedsFromEnv[asset.symbol.toUpperCase()];
      return { asset, address };
    });

    for (const { asset, address } of assetsWithFeeds) {
      if (!address) {
        this.logger.warn(`ƒsÿ‹,? Missing Chainlink feed for ${asset.symbol} (set CHAINLINK_FEED_${this.normalizeSymbolKey(asset.symbol)})`);
        continue;
      }
      const trimmed = address.trim();
      if (!ethers.isAddress(trimmed)) {
        this.logger.warn(`ƒsÿ‹,? Invalid Chainlink feed address for ${asset.symbol}: ${address}`);
        continue;
      }

      try {
        const contract = new Contract(trimmed, AGGREGATOR_V3_ABI, this.provider);
        const decimals = asset.chainlinkFeedDecimals ?? Number(await contract.decimals());

        this.feeds.set(asset.symbol, { contract, decimals });
        this.logger.success(`ƒo. Loaded Chainlink feed for ${asset.symbol} (${address}, decimals=${decimals})`);
      } catch (error) {
        this.logger.error(`Failed to load Chainlink feed for ${asset.symbol} (${address}):`, error);
      }
    }
  }

  private readFeedsFromEnv(): Record<string, string> {
    const feeds: Record<string, string> = {};

    const json = process.env.CHAINLINK_FEEDS;
    if (json) {
      try {
        const parsed = JSON.parse(json);
        if (parsed && typeof parsed === 'object') {
          for (const [key, value] of Object.entries(parsed)) {
            if (typeof value === 'string') {
              feeds[key.toUpperCase()] = value.trim();
            }
          }
        }
      } catch (error) {
        this.logger.warn('ƒsÿ‹,? Failed to parse CHAINLINK_FEEDS (must be JSON object of { SYMBOL: address }): ' + (error instanceof Error ? error.message : String(error)));
      }
    }

    for (const [key, value] of Object.entries(process.env)) {
      if (!key.startsWith('CHAINLINK_FEED_') || !value) continue;
      const symbolKey = key.replace('CHAINLINK_FEED_', '').toUpperCase();
      feeds[symbolKey] = value.trim();
    }

    return feeds;
  }

  private normalizeSymbolKey(symbol: string): string {
    return symbol.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  }

  private startPolling(): void {
    if (this.pollTimer) return;

    const tick = async () => {
      try {
        await this.pollOnce();
      } catch (error) {
        this.logger.error('Error polling Chainlink feeds:', error);
      }
    };

    void tick();
    this.pollTimer = setInterval(tick, this.pollIntervalMs);
  }

  private async pollOnce(): Promise<void> {
    if (this.feeds.size === 0) return;

    const nowMs = Date.now();
    const updates = await Promise.allSettled(
      Array.from(this.feeds.entries()).map(async ([symbol, feed]) => {
        const result = await feed.contract.latestRoundData();
        const roundId = BigInt(result[0]);
        const answer = BigInt(result[1]);
        const updatedAt = BigInt(result[3]);
        const answeredInRound = BigInt(result[4]);

        if (answer <= 0n) {
          throw new Error(`Invalid answer for ${symbol}: ${answer.toString()}`);
        }
        if (updatedAt === 0n) {
          throw new Error(`updatedAt is 0 for ${symbol}`);
        }
        if (answeredInRound < roundId) {
          throw new Error(`Stale round data for ${symbol} (answeredInRound < roundId)`);
        }

        const updatedAtMs = Number(updatedAt) * 1000;
        const ageSec = (nowMs - updatedAtMs) / 1000;
        if (ageSec > this.maxPriceAgeSec) {
          throw new Error(`Stale price for ${symbol}: ${ageSec.toFixed(1)}s old`);
        }

        const priceStr = ethers.formatUnits(answer, feed.decimals);
        const priceNum = Number(priceStr);
        if (!Number.isFinite(priceNum) || priceNum <= 0) {
          throw new Error(`Non-finite price for ${symbol}: ${priceStr}`);
        }

        const priceData: PriceData = {
          symbol,
          price: priceNum,
          expo: -feed.decimals,
          timestamp: updatedAtMs,
          source: 'chainlink',
          publishTime: updatedAtMs,
          rawPrice: answer.toString(),
          decimals: feed.decimals,
        };

        return { symbol, priceData };
      })
    );

    let changed = false;
    for (const update of updates) {
      if (update.status !== 'fulfilled') continue;
      const { symbol, priceData } = update.value;

      const prev = this.currentPrices[symbol];
      if (!prev || prev.timestamp !== priceData.timestamp || prev.rawPrice !== priceData.rawPrice) {
        this.currentPrices[symbol] = priceData;
        changed = true;
      }
    }

    if (changed) {
      this.notifyPriceUpdate();
    }
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
        status: this.feeds.size > 0 ? 'initializing' : 'disconnected',
        lastUpdate: 0,
        assetsMonitored: 0,
      };
    }

    const latestUpdate = Math.max(...prices.map((p) => p.timestamp));
    const timeSinceLastUpdate = Date.now() - latestUpdate;
    const isHealthy = timeSinceLastUpdate < this.maxPriceAgeSec * 1000;

    return {
      status: isHealthy ? 'connected' : 'stale',
      lastUpdate: latestUpdate,
      assetsMonitored: prices.length,
    };
  }

  async shutdown(): Promise<void> {
    this.logger.info('Shutting down Chainlink Price Service...');

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    this.priceUpdateCallbacks = [];
    this.currentPrices = {};
    this.feeds.clear();

    this.logger.success('ƒo. Chainlink Price Service shut down successfully');
  }
}
