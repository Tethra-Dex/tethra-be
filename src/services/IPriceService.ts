import { MultiAssetPriceData, PriceData } from '../types';

export interface IPriceService {
  initialize(): Promise<void>;
  shutdown(): Promise<void>;

  getCurrentPrices(): MultiAssetPriceData;
  getCurrentPrice(symbol: string): PriceData | null;

  onPriceUpdate(callback: (prices: MultiAssetPriceData) => void): void;
  removePriceUpdateCallback(callback: (prices: MultiAssetPriceData) => void): void;

  getHealthStatus(): {
    status: string;
    lastUpdate: number;
    assetsMonitored: number;
  };
}

