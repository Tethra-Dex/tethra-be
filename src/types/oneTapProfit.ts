/**
 * One Tap Profit Types
 * 
 * Binary option-style trading where users bet on price reaching specific targets
 */

export enum OneTapBetStatus {
  ACTIVE = 'ACTIVE',         // Bet is active, waiting for target or expiry
  WON = 'WON',              // Target reached, user won
  LOST = 'LOST',            // Expired without reaching target
  CANCELLED = 'CANCELLED',  // Cancelled by admin
}

export interface OneTapBet {
  betId: string;              // On-chain bet ID
  trader: string;             // User wallet address
  symbol: string;             // BTC, ETH, etc
  betAmount: string;          // USDC amount (6 decimals)
  targetPrice: string;        // Target price (8 decimals)
  targetTime: number;         // Target timestamp (Unix)
  entryPrice: string;         // Price when bet was placed (8 decimals)
  entryTime: number;          // Timestamp when bet was placed (Unix)
  multiplier: number;         // Payout multiplier (basis 100, e.g., 110 = 1.1x)
  status: OneTapBetStatus;
  settledAt?: number;         // When bet was settled
  settlePrice?: string;       // Price at settlement
  
  // Tracking
  createdAt: number;          // When bet was created in backend
  lastChecked?: number;       // Last time backend checked this bet
}

export interface PlaceOneTapBetRequest {
  trader: string;
  symbol: string;
  betAmount: string;
  targetPrice: string;
  targetTime: number;
  entryPrice: string;
  entryTime: number;
  nonce: string;
  userSignature: string;      // User's signature approving this bet
}

// For keeper-only execution (gasless, no nonce or signature needed)
export interface PlaceOneTapBetKeeperRequest {
  trader: string;
  symbol: string;
  betAmount: string;
  targetPrice: string;
  targetTime: number;
  entryPrice: string;
  entryTime: number;
}

export interface SettleOneTapBetRequest {
  betId: string;
  currentPrice: string;
  currentTime: number;
  won: boolean;
}

export interface GetOneTapBetsQuery {
  trader?: string;
  symbol?: string;
  status?: OneTapBetStatus;
}

export interface OneTapProfitStats {
  totalBets: number;
  activeBets: number;
  wonBets: number;
  lostBets: number;
  totalVolume: string;        // Total USDC bet
  totalPayout: string;        // Total USDC paid out
}

export interface CalculateMultiplierRequest {
  entryPrice: string;
  targetPrice: string;
  entryTime: number;
  targetTime: number;
}

export interface CalculateMultiplierResponse {
  multiplier: number;         // e.g., 150 = 1.5x
  priceDistance: string;      // Percentage price distance
  timeDistance: number;       // Seconds until target
}
