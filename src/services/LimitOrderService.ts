import { ethers, Contract } from 'ethers';
import { Logger } from '../utils/Logger';
import LimitExecutorArtifact from '../abis/LimitExecutor.json';

export interface KeeperLimitOpenOrderRequest {
  trader: string;
  symbol: string;
  isLong: boolean;
  collateral: string; // base units (USDC 6 decimals)
  leverage: string; // integer string
  triggerPrice: string; // base units (8 decimals)
  nonce: string;
  expiresAt: string;
  signature: string;
  takeProfit?: string; // optional TP price (8 decimals)
  stopLoss?: string; // optional SL price (8 decimals)
  metadata?: {
    collateralUsd?: string;
    triggerPriceUsd?: string;
  };
}

export interface KeeperLimitOrderResponse {
  orderId: string;
  txHash: string;
}

export class LimitOrderService {
  private readonly logger = new Logger('LimitOrderService');
  private readonly provider: ethers.JsonRpcProvider;
  private readonly keeperWallet: ethers.Wallet;
  private readonly limitExecutor: Contract;
  private readonly limitExecutorAddress: string;
  // Store TP/SL preferences for pending limit orders
  private orderTPSLMap: Map<string, { takeProfit?: bigint; stopLoss?: bigint }> = new Map();

  constructor() {
    const RPC_URL = process.env.RPC_URL || 'https://sepolia.base.org';
    this.provider = new ethers.JsonRpcProvider(RPC_URL);

    const keeperPrivateKey = process.env.RELAY_PRIVATE_KEY;
    if (!keeperPrivateKey) {
      throw new Error('RELAY_PRIVATE_KEY not configured');
    }

    this.keeperWallet = new ethers.Wallet(keeperPrivateKey, this.provider);

    this.limitExecutorAddress = process.env.LIMIT_EXECUTOR_ADDRESS || '';

    if (!this.limitExecutorAddress) {
      throw new Error('LIMIT_EXECUTOR_ADDRESS not configured');
    }

    this.limitExecutor = new Contract(
      this.limitExecutorAddress,
      (LimitExecutorArtifact as { abi: any }).abi,
      this.keeperWallet
    );

    this.logger.info('🔄 LimitOrderService initialized');
    this.logger.info(`   Keeper wallet: ${this.keeperWallet.address}`);
    this.logger.info(`   LimitExecutor: ${this.limitExecutorAddress}`);
  }

  private normalizeBigNumberish(value: string, label: string): bigint {
    try {
      return BigInt(value);
    } catch (error) {
      throw new Error(`Invalid ${label} value: ${value}`);
    }
  }

  async getNextOrderId(): Promise<bigint> {
    const nextId = await this.limitExecutor.nextOrderId();
    return BigInt(nextId);
  }

  async createLimitOpenOrder(request: KeeperLimitOpenOrderRequest): Promise<KeeperLimitOrderResponse> {
    const {
      trader,
      symbol,
      isLong,
      collateral,
      leverage,
      triggerPrice,
      nonce,
      expiresAt,
      signature,
      metadata,
    } = request;

    this.logger.info(`📝 Received limit order request`, {
      trader,
      symbol,
      isLong,
      leverage,
      collateral,
      triggerPrice,
      nonce,
      expiresAt,
      metadata,
    });

    const collateralBig = this.normalizeBigNumberish(collateral, 'collateral');
    const leverageBig = this.normalizeBigNumberish(leverage, 'leverage');
    const triggerPriceBig = this.normalizeBigNumberish(triggerPrice, 'triggerPrice');
    const nonceBig = this.normalizeBigNumberish(nonce, 'nonce');
    const expiresAtBig = this.normalizeBigNumberish(expiresAt, 'expiresAt');

    if (!signature || !signature.startsWith('0x')) {
      throw new Error('Invalid signature');
    }

    const nextOrderId = await this.getNextOrderId();
    this.logger.info(`➡️  Next order id: ${nextOrderId.toString()}`);

    // Store TP/SL preferences if provided
    if (request.takeProfit || request.stopLoss) {
      const tpslData: { takeProfit?: bigint; stopLoss?: bigint } = {};
      if (request.takeProfit) {
        tpslData.takeProfit = this.normalizeBigNumberish(request.takeProfit, 'takeProfit');
      }
      if (request.stopLoss) {
        tpslData.stopLoss = this.normalizeBigNumberish(request.stopLoss, 'stopLoss');
      }
      this.orderTPSLMap.set(nextOrderId.toString(), tpslData);
      this.logger.info(`💾 Stored TP/SL for order ${nextOrderId}:`, {
        takeProfit: request.takeProfit,
        stopLoss: request.stopLoss,
      });
    }

    const tx = await this.limitExecutor.createLimitOpenOrder(
      trader,
      symbol,
      isLong,
      collateralBig,
      leverageBig,
      triggerPriceBig,
      nonceBig,
      expiresAtBig,
      signature
    );

    this.logger.info(`📤 Submitted createLimitOpenOrder tx: ${tx.hash}`);
    const receipt = await tx.wait();
    if (!receipt) {
      throw new Error('Transaction receipt not found');
    }

    this.logger.success(`✅ Limit order created on-chain`, {
      orderId: nextOrderId.toString(),
      txHash: tx.hash,
    });

    return {
      orderId: nextOrderId.toString(),
      txHash: tx.hash,
    };
  }

  /**
   * Get stored TP/SL for a limit order
   */
  getOrderTPSL(orderId: string): { takeProfit?: bigint; stopLoss?: bigint } | undefined {
    return this.orderTPSLMap.get(orderId);
  }

  /**
   * Remove TP/SL data after order is executed or cancelled
   */
  clearOrderTPSL(orderId: string): void {
    this.orderTPSLMap.delete(orderId);
  }
}
