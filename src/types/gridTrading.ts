export interface GridSession {
  id: string;
  trader: string;
  symbol: string;
  marginTotal: string; // USDC amount in base units (6 decimals)
  leverage: number;
  timeframeSeconds: number; // 60 for 1m, 300 for 5m, etc.
  gridSizeX: number; // X coordinate multiplier (candles per column)
  gridSizeYPercent: number; // Y coordinate in basis points (50 = 0.5%)
  referenceTime: number; // Base timestamp for grid calculation
  referencePrice: string; // Base price for grid calculation (8 decimals)
  isActive: boolean;
  createdAt: number;
  cancelledAt?: number;
}

export interface GridCell {
  id: string;
  gridSessionId: string;
  cellX: number; // Grid X position
  cellY: number; // Grid Y position (can be negative)
  triggerPrice: string; // Price in base units (8 decimals)
  startTime: number; // Time window start (unix timestamp)
  endTime: number; // Time window end (unix timestamp)
  isLong: boolean; // true = buy/long, false = sell/short
  clickCount: number; // Number of orders in this cell
  ordersCreated: number; // How many orders have been created on-chain
  orderIds: string[]; // On-chain order IDs from LimitExecutor
  collateralPerOrder: string; // USDC per order (6 decimals)
  status: GridCellStatus;
  createdAt: number;
}

export enum GridCellStatus {
  PENDING = 'PENDING', // Cell created, orders not yet on-chain
  ACTIVE = 'ACTIVE', // Orders created on-chain, monitoring
  EXPIRED = 'EXPIRED', // Time window expired
  CANCELLED = 'CANCELLED', // User cancelled
  FULLY_EXECUTED = 'FULLY_EXECUTED', // All orders executed
}

export interface CreateGridSessionRequest {
  trader: string;
  symbol: string;
  marginTotal: string;
  leverage: number;
  timeframeSeconds: number;
  gridSizeX: number;
  gridSizeYPercent: number;
  referenceTime: number;
  referencePrice: string;
}

export interface CreateGridCellRequest {
  gridSessionId: string;
  cellX: number;
  cellY: number;
  triggerPrice: string;
  startTime: number;
  endTime: number;
  isLong: boolean;
  clickCount: number;
  collateralPerOrder: string;
}

/**
 * ⚠️ DEPRECATED: PlaceGridOrdersRequest
 * This was used for on-chain order creation which is expensive.
 * For Tap-to-Trade, use BatchCreateTapToTradeOrdersRequest from tapToTrade.ts instead.
 */

export interface GridSessionResponse {
  gridSession: GridSession;
  cells: GridCell[];
  totalOrders: number;
  activeOrders: number;
  executedOrders: number;
}
