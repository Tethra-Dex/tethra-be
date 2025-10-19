import { Logger } from '../utils/Logger';
import {
  TapToTradeOrder,
  TapToTradeOrderStatus,
  CreateTapToTradeOrderRequest,
  GetTapToTradeOrdersQuery,
  TapToTradeOrderStats,
} from '../types/tapToTrade';
import { SessionKeyValidator } from './SessionKeyValidator';

/**
 * TapToTradeService - Backend-Only Order Storage
 *
 * This service manages tap-to-trade orders that are NOT yet on-chain.
 * Orders are stored in memory until backend executes them directly
 * when price and time conditions are met.
 *
 * Key differences from regular limit orders:
 * 1. Orders stored ONLY in backend (not on-chain)
 * 2. Backend directly executes via MarketExecutor (not LimitExecutor)
 * 3. User can cancel without on-chain transaction
 * 4. Saves gas by skipping "create order" transaction
 */
export class TapToTradeService {
  private readonly logger = new Logger('TapToTradeService');
  private readonly sessionValidator: SessionKeyValidator;

  // In-memory storage
  private orders: Map<string, TapToTradeOrder> = new Map();
  private ordersByTrader: Map<string, string[]> = new Map(); // trader => orderIds[]
  private ordersByGrid: Map<string, string[]> = new Map(); // gridSessionId => orderIds[]
  private ordersByCell: Map<string, string[]> = new Map(); // cellId => orderIds[]

  constructor() {
    this.sessionValidator = new SessionKeyValidator();
    this.logger.info('🎯 TapToTradeService initialized (in-memory storage)');
    this.logger.warn('⚠️  Data will be lost on server restart');
  }

  /**
   * Create a new tap-to-trade order (backend-only)
   */
  createOrder(params: CreateTapToTradeOrderRequest): TapToTradeOrder {
    // Validate signature before creating order
    const marketExecutor = process.env.TAP_TO_TRADE_EXECUTOR_ADDRESS || '0x841f70066ba831650c4D97BD59cc001c890cf6b6';

    if (params.sessionKey) {
      // Validate with session key
      const validation = this.sessionValidator.validateOrderWithSession({
        trader: params.trader,
        symbol: params.symbol,
        isLong: params.isLong,
        collateral: params.collateral,
        leverage: params.leverage,
        nonce: params.nonce,
        signature: params.signature,
        marketExecutor,
        sessionKey: params.sessionKey,
      });

      if (!validation.valid) {
        this.logger.error('❌ Session validation failed:', validation.error);
        throw new Error(`Invalid session signature: ${validation.error}`);
      }

      this.logger.info('✅ Order validated with session key');
    } else {
      // Validate traditional signature (backward compatibility)
      const validation = this.sessionValidator.validateOrderWithoutSession({
        trader: params.trader,
        symbol: params.symbol,
        isLong: params.isLong,
        collateral: params.collateral,
        leverage: params.leverage,
        nonce: params.nonce,
        signature: params.signature,
        marketExecutor,
      });

      if (!validation.valid) {
        this.logger.error('❌ Signature validation failed:', validation.error);
        throw new Error(`Invalid signature: ${validation.error}`);
      }

      this.logger.info('✅ Order validated with traditional signature');
    }

    const id = this.generateId('ttt');
    const order: TapToTradeOrder = {
      id,
      gridSessionId: params.gridSessionId,
      cellId: params.cellId,
      trader: params.trader.toLowerCase(),
      symbol: params.symbol,
      isLong: params.isLong,
      collateral: params.collateral,
      leverage: params.leverage,
      triggerPrice: params.triggerPrice,
      startTime: params.startTime,
      endTime: params.endTime,
      nonce: params.nonce,
      signature: params.signature,
      sessionKey: params.sessionKey,
      status: TapToTradeOrderStatus.PENDING,
      createdAt: Date.now(),
    };

    // Store order
    this.orders.set(id, order);

    // Index by trader
    const trader = order.trader;
    const traderOrders = this.ordersByTrader.get(trader) || [];
    traderOrders.push(id);
    this.ordersByTrader.set(trader, traderOrders);

    // Index by grid session
    const gridOrders = this.ordersByGrid.get(params.gridSessionId) || [];
    gridOrders.push(id);
    this.ordersByGrid.set(params.gridSessionId, gridOrders);

    // Index by cell
    const cellOrders = this.ordersByCell.get(params.cellId) || [];
    cellOrders.push(id);
    this.ordersByCell.set(params.cellId, cellOrders);

    this.logger.info(`✅ Created tap-to-trade order: ${id}`, {
      trader,
      symbol: params.symbol,
      triggerPrice: params.triggerPrice,
      timeWindow: `${params.startTime} - ${params.endTime}`,
    });

    return order;
  }

  /**
   * Batch create orders for a grid cell
   */
  batchCreateOrders(requests: CreateTapToTradeOrderRequest[]): TapToTradeOrder[] {
    return requests.map((req) => this.createOrder(req));
  }

  /**
   * Get order by ID
   */
  getOrder(orderId: string): TapToTradeOrder | undefined {
    return this.orders.get(orderId);
  }

  /**
   * Query orders with filters
   */
  queryOrders(query: GetTapToTradeOrdersQuery): TapToTradeOrder[] {
    let orders = Array.from(this.orders.values());

    // Filter by trader
    if (query.trader) {
      const trader = query.trader.toLowerCase();
      const orderIds = this.ordersByTrader.get(trader) || [];
      orders = orders.filter((o) => orderIds.includes(o.id));
    }

    // Filter by grid session
    if (query.gridSessionId) {
      const orderIds = this.ordersByGrid.get(query.gridSessionId) || [];
      orders = orders.filter((o) => orderIds.includes(o.id));
    }

    // Filter by cell
    if (query.cellId) {
      const orderIds = this.ordersByCell.get(query.cellId) || [];
      orders = orders.filter((o) => orderIds.includes(o.id));
    }

    // Filter by status
    if (query.status) {
      orders = orders.filter((o) => o.status === query.status);
    }

    return orders.sort((a, b) => a.createdAt - b.createdAt);
  }

  /**
   * Get all pending orders (for executor monitoring)
   */
  getPendingOrders(): TapToTradeOrder[] {
    return Array.from(this.orders.values())
      .filter((o) => o.status === TapToTradeOrderStatus.PENDING)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /**
   * Get orders by cell ID
   */
  getOrdersByCell(cellId: string): TapToTradeOrder[] {
    const orderIds = this.ordersByCell.get(cellId) || [];
    return orderIds
      .map((id) => this.orders.get(id))
      .filter((o): o is TapToTradeOrder => o !== undefined);
  }

  /**
   * Cancel order (backend-only, no on-chain tx)
   */
  cancelOrder(orderId: string, trader: string): void {
    const order = this.orders.get(orderId);
    if (!order) {
      throw new Error(`Order not found: ${orderId}`);
    }

    const normalizedTrader = trader.toLowerCase();
    if (order.trader !== normalizedTrader) {
      throw new Error('Not authorized to cancel this order');
    }

    if (order.status !== TapToTradeOrderStatus.PENDING && order.status !== TapToTradeOrderStatus.NEEDS_RESIGN) {
      throw new Error(`Cannot cancel order with status: ${order.status}`);
    }

    order.status = TapToTradeOrderStatus.CANCELLED;
    order.cancelledAt = Date.now();
    this.orders.set(orderId, order);

    this.logger.info(`✅ Cancelled tap-to-trade order: ${orderId}`);
  }

  /**
   * Cancel all orders in a cell
   */
  cancelOrdersByCell(cellId: string, trader: string): number {
    const orders = this.getOrdersByCell(cellId);
    let cancelledCount = 0;

    for (const order of orders) {
      try {
        if (order.status === TapToTradeOrderStatus.PENDING) {
          this.cancelOrder(order.id, trader);
          cancelledCount++;
        }
      } catch (error) {
        this.logger.error(`Failed to cancel order ${order.id}:`, error);
      }
    }

    this.logger.info(`✅ Cancelled ${cancelledCount} orders in cell ${cellId}`);
    return cancelledCount;
  }

  /**
   * Cancel all orders in a grid session
   */
  cancelOrdersByGrid(gridSessionId: string, trader: string): number {
    const orderIds = this.ordersByGrid.get(gridSessionId) || [];
    let cancelledCount = 0;

    for (const orderId of orderIds) {
      const order = this.orders.get(orderId);
      if (order && order.status === TapToTradeOrderStatus.PENDING) {
        try {
          this.cancelOrder(orderId, trader);
          cancelledCount++;
        } catch (error) {
          this.logger.error(`Failed to cancel order ${orderId}:`, error);
        }
      }
    }

    this.logger.info(`✅ Cancelled ${cancelledCount} orders in grid ${gridSessionId}`);
    return cancelledCount;
  }

  /**
   * Mark order as executing
   */
  markAsExecuting(orderId: string): void {
    const order = this.orders.get(orderId);
    if (!order) {
      throw new Error(`Order not found: ${orderId}`);
    }

    order.status = TapToTradeOrderStatus.EXECUTING;
    this.orders.set(orderId, order);

    this.logger.info(`🚀 Order ${orderId} is now executing...`);
  }

  /**
   * Mark order as executed (success)
   */
  markAsExecuted(
    orderId: string,
    txHash: string,
    positionId: string,
    executionPrice: string
  ): void {
    const order = this.orders.get(orderId);
    if (!order) {
      throw new Error(`Order not found: ${orderId}`);
    }

    order.status = TapToTradeOrderStatus.EXECUTED;
    order.executedAt = Date.now();
    order.txHash = txHash;
    order.positionId = positionId;
    order.executionPrice = executionPrice;
    this.orders.set(orderId, order);

    this.logger.success(`✅ Order ${orderId} executed successfully!`, {
      txHash,
      positionId,
      executionPrice,
    });
  }

  /**
   * Mark order as failed
   */
  markAsFailed(orderId: string, errorMessage: string): void {
    const order = this.orders.get(orderId);
    if (!order) {
      throw new Error(`Order not found: ${orderId}`);
    }

    order.status = TapToTradeOrderStatus.FAILED;
    order.errorMessage = errorMessage;
    this.orders.set(orderId, order);

    this.logger.error(`❌ Order ${orderId} failed: ${errorMessage}`);
  }

  /**
   * Mark order as needs re-sign (nonce mismatch)
   */
  markAsNeedsResign(orderId: string, errorMessage: string): void {
    const order = this.orders.get(orderId);
    if (!order) {
      throw new Error(`Order not found: ${orderId}`);
    }

    order.status = TapToTradeOrderStatus.NEEDS_RESIGN;
    order.errorMessage = errorMessage;
    this.orders.set(orderId, order);

    this.logger.warn(`\u270d\ufe0f Order ${orderId} needs re-signature: ${errorMessage}`);
  }

  /**
   * Update signature for an order (after re-sign)
   */
  updateSignature(orderId: string, nonce: string, signature: string, trader: string): void {
    const order = this.orders.get(orderId);
    if (!order) {
      throw new Error(`Order not found: ${orderId}`);
    }

    const normalizedTrader = trader.toLowerCase();
    if (order.trader !== normalizedTrader) {
      throw new Error('Not authorized to update this order');
    }

    if (order.status !== TapToTradeOrderStatus.NEEDS_RESIGN) {
      throw new Error(`Order is not in NEEDS_RESIGN status: ${order.status}`);
    }

    order.nonce = nonce;
    order.signature = signature;
    order.status = TapToTradeOrderStatus.PENDING;
    order.errorMessage = undefined;
    this.orders.set(orderId, order);

    this.logger.info(`\u2705 Updated signature for order ${orderId} with new nonce ${nonce}`);
  }

  /**
   * Cleanup expired orders (called by executor periodically)
   */
  cleanupExpiredOrders(): number {
    const now = Math.floor(Date.now() / 1000); // Unix timestamp
    let expiredCount = 0;

    for (const order of this.orders.values()) {
      if (order.status === TapToTradeOrderStatus.PENDING && now > order.endTime) {
        order.status = TapToTradeOrderStatus.EXPIRED;
        order.expiredAt = Date.now();
        this.orders.set(order.id, order);
        expiredCount++;
      }
    }

    if (expiredCount > 0) {
      this.logger.info(`🧹 Cleaned up ${expiredCount} expired tap-to-trade orders`);
    }

    return expiredCount;
  }

  /**
   * Get statistics
   */
  getStats(): TapToTradeOrderStats {
    const orders = Array.from(this.orders.values());

    return {
      totalOrders: orders.length,
      pendingOrders: orders.filter((o) => o.status === TapToTradeOrderStatus.PENDING).length,
      executedOrders: orders.filter((o) => o.status === TapToTradeOrderStatus.EXECUTED).length,
      cancelledOrders: orders.filter((o) => o.status === TapToTradeOrderStatus.CANCELLED).length,
      expiredOrders: orders.filter((o) => o.status === TapToTradeOrderStatus.EXPIRED).length,
      failedOrders: orders.filter((o) => o.status === TapToTradeOrderStatus.FAILED).length,
    };
  }

  /**
   * Generate unique ID
   */
  private generateId(prefix: string): string {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}
