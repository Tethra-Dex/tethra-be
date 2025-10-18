/**
 * Tap-to-Trade Order Types
 *
 * These orders are stored ONLY in backend memory (not on-chain yet).
 * Backend monitors and directly executes them when conditions are met.
 * This saves gas by skipping the "create order on-chain" step.
 */

export enum TapToTradeOrderStatus {
  PENDING = 'PENDING',       // Waiting for price & time conditions
  NEEDS_RESIGN = 'NEEDS_RESIGN', // Nonce mismatch - needs re-signature from user
  EXECUTING = 'EXECUTING',   // Currently being executed on-chain
  EXECUTED = 'EXECUTED',     // Successfully executed and position opened
  CANCELLED = 'CANCELLED',   // Cancelled by user (no on-chain tx)
  EXPIRED = 'EXPIRED',       // Time window expired
  FAILED = 'FAILED',         // Execution failed (e.g., insufficient balance)
}

export interface TapToTradeOrder {
  id: string;                          // Backend-generated order ID (e.g., "ttt_12345_abc")
  gridSessionId: string;               // Parent grid session
  cellId: string;                      // Parent grid cell

  // Order details
  trader: string;                      // User wallet address
  symbol: string;                      // BTC, ETH, etc
  isLong: boolean;                     // true = long, false = short
  collateral: string;                  // USDC amount (6 decimals)
  leverage: number;                    // e.g., 10x
  triggerPrice: string;                // Target price (8 decimals)

  // Time window (for tap-to-trade mode)
  startTime: number;                   // Unix timestamp - order active from
  endTime: number;                     // Unix timestamp - order expires at

  // Signature for execution
  nonce: string;                       // Nonce for signature validation
  signature: string;                   // User's signature OR session key signature for market execution

  // Session key (optional - for signature-less trading)
  sessionKey?: {
    address: string;                   // Session key address
    expiresAt: number;                 // Unix timestamp - session expires at
    authorizedBy: string;              // User address who authorized this session
    authSignature: string;             // User's signature authorizing the session key
  };

  // Status tracking
  status: TapToTradeOrderStatus;
  createdAt: number;                   // When order was created in backend
  executedAt?: number;                 // When order was executed on-chain
  cancelledAt?: number;                // When order was cancelled
  expiredAt?: number;                  // When order expired

  // Execution result
  txHash?: string;                     // Transaction hash (when executed)
  positionId?: string;                 // Position ID from smart contract
  executionPrice?: string;             // Actual execution price (8 decimals)
  errorMessage?: string;               // Error message if execution failed
}

export interface CreateTapToTradeOrderRequest {
  gridSessionId: string;
  cellId: string;
  trader: string;
  symbol: string;
  isLong: boolean;
  collateral: string;
  leverage: number;
  triggerPrice: string;
  startTime: number;
  endTime: number;
  nonce: string;
  signature: string;
  sessionKey?: {
    address: string;
    expiresAt: number;
    authorizedBy: string;
    authSignature: string;
  };
}

export interface BatchCreateTapToTradeOrdersRequest {
  gridSessionId: string;
  orders: CreateTapToTradeOrderRequest[];
}

export interface CancelTapToTradeOrderRequest {
  orderId: string;
  trader: string;
}

export interface GetTapToTradeOrdersQuery {
  trader?: string;
  gridSessionId?: string;
  cellId?: string;
  status?: TapToTradeOrderStatus;
}

export interface TapToTradeOrderStats {
  totalOrders: number;
  pendingOrders: number;
  executedOrders: number;
  cancelledOrders: number;
  expiredOrders: number;
  failedOrders: number;
}
