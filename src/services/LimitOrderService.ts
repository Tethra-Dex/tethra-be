import { ethers, Contract } from 'ethers';
import { Logger } from '../utils/Logger';
import LimitExecutorV2Artifact from '../../../tethra-sc/out/LimitExecutorV2.sol/LimitExecutorV2.json';

export interface KeeperLimitOpenOrderRequest {
  trader: string;
  symbol: string;
  isLong: boolean;
  collateral: string; // base units (USDC 6 decimals)
  leverage: string; // integer string
  triggerPrice: string; // base units (8 decimals)
  maxExecutionFee: string; // base units (USDC 6 decimals)
  nonce: string;
  expiresAt: string;
  signature: string;
  metadata?: {
    collateralUsd?: string;
    triggerPriceUsd?: string;
    maxExecutionFeeUsd?: string;
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

  constructor() {
    const RPC_URL = process.env.RPC_URL || 'https://sepolia.base.org';
    this.provider = new ethers.JsonRpcProvider(RPC_URL);

    const keeperPrivateKey = process.env.LIMIT_ORDER_KEEPER_PRIVATE_KEY;
    if (!keeperPrivateKey) {
      throw new Error('LIMIT_ORDER_KEEPER_PRIVATE_KEY not configured');
    }

    this.keeperWallet = new ethers.Wallet(keeperPrivateKey, this.provider);

    this.limitExecutorAddress =
      process.env.LIMIT_EXECUTOR_ADDRESS ||
      process.env.LIMIT_EXECUTOR_V2_ADDRESS ||
      '';

    if (!this.limitExecutorAddress) {
      throw new Error('LIMIT_EXECUTOR_ADDRESS not configured');
    }

    this.limitExecutor = new Contract(
      this.limitExecutorAddress,
      (LimitExecutorV2Artifact as { abi: any }).abi,
      this.keeperWallet
    );

    this.logger.info('🔄 LimitOrderService initialized');
    this.logger.info(`   Keeper wallet: ${this.keeperWallet.address}`);
    this.logger.info(`   LimitExecutorV2: ${this.limitExecutorAddress}`);
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
      maxExecutionFee,
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
      maxExecutionFee,
      nonce,
      expiresAt,
      metadata,
    });

    const collateralBig = this.normalizeBigNumberish(collateral, 'collateral');
    const leverageBig = this.normalizeBigNumberish(leverage, 'leverage');
    const triggerPriceBig = this.normalizeBigNumberish(triggerPrice, 'triggerPrice');
    const maxExecutionFeeBig = this.normalizeBigNumberish(maxExecutionFee, 'maxExecutionFee');
    const nonceBig = this.normalizeBigNumberish(nonce, 'nonce');
    const expiresAtBig = this.normalizeBigNumberish(expiresAt, 'expiresAt');

    if (!signature || !signature.startsWith('0x')) {
      throw new Error('Invalid signature');
    }

    const nextOrderId = await this.getNextOrderId();
    this.logger.info(`➡️  Next order id: ${nextOrderId.toString()}`);

    const tx = await this.limitExecutor.createLimitOpenOrder(
      trader,
      symbol,
      isLong,
      collateralBig,
      leverageBig,
      triggerPriceBig,
      maxExecutionFeeBig,
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
}
