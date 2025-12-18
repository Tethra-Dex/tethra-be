export interface PriceData {
  symbol: string;
  price: number;
  confidence?: number;
  expo?: number;
  timestamp: number;
  source: 'pyth' | 'binance' | 'fallback' | 'frontend';
  publishTime?: number;
}

export interface MultiAssetPriceData {
  [symbol: string]: PriceData;
}

export interface PythPriceFeed {
  id: string;
  price: {
    price: string;
    conf: string;
    expo: number;
    publish_time: number;
  };
  ema_price: {
    price: string;
    conf: string;
    expo: number;
    publish_time: number;
  };
}

export interface AssetConfig {
  symbol: string;
  pythPriceId: string;
  binanceSymbol?: string;
  tradingViewSymbol?: string;
}

export const DEFAULT_ASSETS: AssetConfig[] = [
  {
    symbol: 'BTC',
    pythPriceId: '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
    binanceSymbol: 'BTCUSDT',
    tradingViewSymbol: 'BITSTAMP:BTCUSD'
  },
  {
    symbol: 'ETH',
    pythPriceId: '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
    binanceSymbol: 'ETHUSDT',
    tradingViewSymbol: 'BITSTAMP:ETHUSD'
  },
  {
    symbol: 'SOL',
    pythPriceId: '0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
    binanceSymbol: 'SOLUSDT',
    tradingViewSymbol: 'BINANCE:SOLUSDT'
  },
  {
    symbol: 'AVAX',
    pythPriceId: '0x93da3352f9f1d105fdfe4971cfa80e9dd777bfc5d0f683ebb6e1294b92137bb7',
    binanceSymbol: 'AVAXUSDT',
    tradingViewSymbol: 'BINANCE:AVAXUSDT'
  },
  {
    symbol: 'BNB',
    pythPriceId: '0x2f95862b045670cd22bee3114c39763a4a08beeb663b145d283c31d7d1101c4f',
    binanceSymbol: 'BNBUSDT',
    tradingViewSymbol: 'BINANCE:BNBUSDT'
  },
  {
    symbol: 'XRP',
    pythPriceId: '0xec5d399846a9209f3fe5881d70aae9268c94339ff9817e8d18ff19fa05eea1c8',
    binanceSymbol: 'XRPUSDT',
    tradingViewSymbol: 'BITSTAMP:XRPUSD'
  },
  {
    symbol: 'DOGE',
    pythPriceId: '0xdcef50dd0a4cd2dcc17e45df1676dcb336a11a61c69df7a0299b0150c672d25c',
    binanceSymbol: 'DOGEUSDT',
    tradingViewSymbol: 'BINANCE:DOGEUSDT'
  },
  {
    symbol: 'LINK',
    pythPriceId: '0x8ac0c70fff57e9aefdf5edf44b51d62c2d433653cbb2cf5cc06bb115af04d221',
    binanceSymbol: 'LINKUSDT',
    tradingViewSymbol: 'BINANCE:LINKUSDT'
  }
];

// Backward compatible alias (older services import this symbol).
export const SUPPORTED_ASSETS: AssetConfig[] = DEFAULT_ASSETS;

// TP/SL Types
export interface TPSLConfig {
  positionId: number;
  trader: string;
  symbol: string;
  isLong: boolean;
  entryPrice: bigint;
  takeProfit?: bigint;  // Price in 8 decimals (e.g., 100000000 = $1.00)
  stopLoss?: bigint;    // Price in 8 decimals
  createdAt: number;
  updatedAt: number;
}

export interface TPSLCreateRequest {
  positionId: number;
  takeProfit?: string;  // Price as string to avoid JS number precision issues
  stopLoss?: string;    // Price as string
}

export interface TPSLResponse {
  success: boolean;
  message: string;
  data?: TPSLConfig;
  error?: string;
}
