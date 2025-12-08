import { Logger } from '../utils/Logger';
import {
  GridSession,
  GridCell,
  GridCellStatus,
  CreateGridSessionRequest,
  CreateGridCellRequest,
  GridSessionResponse,
} from '../types/gridTrading';

/**
 * GridTradingService - In-Memory Storage for Grid Trading
 *
 * This service manages grid trading sessions and cells using in-memory storage.
 * Data will be lost on server restart, but orders remain on-chain in LimitExecutor.
 *
 * For production, consider replacing with persistent storage (PostgreSQL, SQLite, etc.)
 */
export class GridTradingService {
  private readonly logger = new Logger('GridTradingService');

  // In-memory storage
  private gridSessions: Map<string, GridSession> = new Map();
  private gridCells: Map<string, GridCell> = new Map();
  private userGrids: Map<string, string[]> = new Map(); // trader => gridSessionIds[]
  private cellsByGrid: Map<string, string[]> = new Map(); // gridSessionId => cellIds[]

  constructor() {
    this.logger.info('🎯 GridTradingService initialized (in-memory storage)');
    this.logger.warn('⚠️  Data will be lost on server restart');
  }

  /**
   * Create a new grid trading session
   */
  createGridSession(params: CreateGridSessionRequest): GridSession {
    const id = this.generateId('grid');
    const session: GridSession = {
      id,
      trader: params.trader.toLowerCase(),
      symbol: params.symbol,
      marginTotal: params.marginTotal,
      leverage: params.leverage,
      timeframeSeconds: params.timeframeSeconds,
      gridSizeX: params.gridSizeX,
      gridSizeYPercent: params.gridSizeYPercent,
      referenceTime: params.referenceTime,
      referencePrice: params.referencePrice,
      isActive: true,
      createdAt: Date.now(),
    };

    this.gridSessions.set(id, session);

    // Track user's grids
    const trader = session.trader;
    const userGridsList = this.userGrids.get(trader) || [];
    userGridsList.push(id);
    this.userGrids.set(trader, userGridsList);

    // Initialize cells list for this grid
    this.cellsByGrid.set(id, []);

    this.logger.info(`✅ Created grid session: ${id}`, {
      trader,
      symbol: params.symbol,
      marginTotal: params.marginTotal,
      leverage: params.leverage,
    });

    return session;
  }

  /**
   * Create a new grid cell
   */
  createGridCell(params: CreateGridCellRequest): GridCell {
    const session = this.gridSessions.get(params.gridSessionId);
    if (!session) {
      throw new Error(`Grid session not found: ${params.gridSessionId}`);
    }

    const id = this.generateId('cell');
    const cell: GridCell = {
      id,
      gridSessionId: params.gridSessionId,
      cellX: params.cellX,
      cellY: params.cellY,
      triggerPrice: params.triggerPrice,
      startTime: params.startTime,
      endTime: params.endTime,
      isLong: params.isLong,
      clickCount: params.clickCount,
      ordersCreated: 0,
      orderIds: [],
      collateralPerOrder: params.collateralPerOrder,
      status: GridCellStatus.PENDING,
      createdAt: Date.now(),
    };

    this.gridCells.set(id, cell);

    // Track cells for this grid
    const cellsList = this.cellsByGrid.get(params.gridSessionId) || [];
    cellsList.push(id);
    this.cellsByGrid.set(params.gridSessionId, cellsList);

    this.logger.info(`✅ Created grid cell: ${id}`, {
      gridId: params.gridSessionId,
      position: `(${params.cellX}, ${params.cellY})`,
      clickCount: params.clickCount,
    });

    return cell;
  }

  /**
   * Add order ID to a cell (when order is created on-chain)
   */
  addOrderToCell(cellId: string, orderId: string): void {
    const cell = this.gridCells.get(cellId);
    if (!cell) {
      throw new Error(`Cell not found: ${cellId}`);
    }

    cell.orderIds.push(orderId);
    cell.ordersCreated++;

    // Update status to ACTIVE if first order
    if (cell.status === GridCellStatus.PENDING) {
      cell.status = GridCellStatus.ACTIVE;
    }

    this.gridCells.set(cellId, cell);
    this.logger.info(`✅ Added order ${orderId} to cell ${cellId} (${cell.ordersCreated}/${cell.clickCount})`);
  }

  /**
   * Get user's grid sessions
   */
  getUserGrids(trader: string): GridSession[] {
    const normalizedTrader = trader.toLowerCase();
    const gridIds = this.userGrids.get(normalizedTrader) || [];
    return gridIds
      .map((id) => this.gridSessions.get(id))
      .filter((s): s is GridSession => s !== undefined)
      .sort((a, b) => b.createdAt - a.createdAt); // Most recent first
  }

  /**
   * Get cells for a grid session
   */
  getGridCells(gridSessionId: string): GridCell[] {
    const cellIds = this.cellsByGrid.get(gridSessionId) || [];
    return cellIds
      .map((id) => this.gridCells.get(id))
      .filter((c): c is GridCell => c !== undefined);
  }

  /**
   * Get full grid session with cells
   */
  getGridSessionWithCells(gridSessionId: string): GridSessionResponse | null {
    const session = this.gridSessions.get(gridSessionId);
    if (!session) {
      return null;
    }

    const cells = this.getGridCells(gridSessionId);
    const totalOrders = cells.reduce((sum, cell) => sum + cell.clickCount, 0);
    const activeOrders = cells
      .filter((cell) => cell.status === GridCellStatus.ACTIVE)
      .reduce((sum, cell) => sum + (cell.clickCount - cell.ordersCreated), 0);
    const executedOrders = cells.reduce((sum, cell) => sum + cell.ordersCreated, 0);

    return {
      gridSession: session,
      cells,
      totalOrders,
      activeOrders,
      executedOrders,
    };
  }

  /**
   * Get all active cells across all grids (for keeper monitoring)
   */
  getActiveCells(): GridCell[] {
    const activeCells: GridCell[] = [];

    for (const cell of this.gridCells.values()) {
      if (cell.status === GridCellStatus.ACTIVE) {
        const session = this.gridSessions.get(cell.gridSessionId);
        if (session?.isActive) {
          activeCells.push(cell);
        }
      }
    }

    return activeCells;
  }

  /**
   * Update cell status
   */
  updateCellStatus(cellId: string, status: GridCellStatus): void {
    const cell = this.gridCells.get(cellId);
    if (!cell) {
      throw new Error(`Cell not found: ${cellId}`);
    }

    cell.status = status;
    this.gridCells.set(cellId, cell);
    this.logger.info(`✅ Updated cell ${cellId} status: ${status}`);
  }

  /**
   * Cancel entire grid session
   */
  cancelGridSession(gridId: string, trader: string): void {
    const session = this.gridSessions.get(gridId);
    if (!session) {
      throw new Error(`Grid session not found: ${gridId}`);
    }

    const normalizedTrader = trader.toLowerCase();
    if (session.trader !== normalizedTrader) {
      throw new Error('Not authorized to cancel this grid');
    }

    session.isActive = false;
    session.cancelledAt = Date.now();
    this.gridSessions.set(gridId, session);

    // Cancel all active cells in this grid
    const cells = this.getGridCells(gridId);
    for (const cell of cells) {
      if (cell.status === GridCellStatus.ACTIVE || cell.status === GridCellStatus.PENDING) {
        cell.status = GridCellStatus.CANCELLED;
        this.gridCells.set(cell.id, cell);
      }
    }

    this.logger.info(`✅ Cancelled grid session: ${gridId}`);
  }

  /**
   * Cancel individual cell
   */
  cancelGridCell(cellId: string, trader: string): void {
    const cell = this.gridCells.get(cellId);
    if (!cell) {
      throw new Error(`Cell not found: ${cellId}`);
    }

    const session = this.gridSessions.get(cell.gridSessionId);
    if (!session) {
      throw new Error(`Grid session not found for cell: ${cellId}`);
    }

    const normalizedTrader = trader.toLowerCase();
    if (session.trader !== normalizedTrader) {
      throw new Error('Not authorized to cancel this cell');
    }

    if (cell.status !== GridCellStatus.ACTIVE && cell.status !== GridCellStatus.PENDING) {
      throw new Error(`Cannot cancel cell with status: ${cell.status}`);
    }

    cell.status = GridCellStatus.CANCELLED;
    this.gridCells.set(cellId, cell);

    this.logger.info(`✅ Cancelled grid cell: ${cellId}`);
  }

  /**
   * Get grid session by ID
   */
  getGridSession(gridId: string): GridSession | undefined {
    return this.gridSessions.get(gridId);
  }

  /**
   * Get cell by ID
   */
  getGridCell(cellId: string): GridCell | undefined {
    return this.gridCells.get(cellId);
  }

  /**
   * Cleanup expired cells (called by keeper)
   */
  cleanupExpiredCells(): number {
    const now = Math.floor(Date.now() / 1000); // Unix timestamp
    let expiredCount = 0;

    for (const cell of this.gridCells.values()) {
      if (cell.status === GridCellStatus.ACTIVE && now > cell.endTime) {
        cell.status = GridCellStatus.EXPIRED;
        this.gridCells.set(cell.id, cell);
        expiredCount++;
      }
    }

    if (expiredCount > 0) {
      this.logger.info(`🧹 Cleaned up ${expiredCount} expired cells`);
    }

    return expiredCount;
  }

  /**
   * Get statistics for monitoring
   */
  getStats() {
    const activeSessions = Array.from(this.gridSessions.values()).filter(
      (s) => s.isActive
    ).length;
    const activeCells = Array.from(this.gridCells.values()).filter(
      (c) => c.status === GridCellStatus.ACTIVE
    ).length;
    const totalOrders = Array.from(this.gridCells.values()).reduce(
      (sum, cell) => sum + cell.orderIds.length,
      0
    );

    return {
      totalSessions: this.gridSessions.size,
      activeSessions,
      totalCells: this.gridCells.size,
      activeCells,
      totalOrders,
      uniqueTraders: this.userGrids.size,
    };
  }

  /**
   * Generate unique ID
   */
  private generateId(prefix: string): string {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}
