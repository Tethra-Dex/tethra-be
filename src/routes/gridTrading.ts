import { Router, Request, Response } from 'express';
import { GridTradingService } from '../services/GridTradingService';
import { LimitOrderService } from '../services/LimitOrderService';
import { Logger } from '../utils/Logger';
import {
  CreateGridSessionRequest,
  PlaceGridOrdersRequest,
} from '../types/gridTrading';

const logger = new Logger('GridTradingRoutes');

export function createGridTradingRoute(
  gridService: GridTradingService,
  limitOrderService: LimitOrderService
): Router {
  const router = Router();

  /**
   * POST /api/grid/create-session
   * Create a new grid trading session
   */
  router.post('/create-session', async (req: Request, res: Response) => {
    try {
      const params: CreateGridSessionRequest = req.body;

      // Validation
      if (!params.trader || !params.symbol || !params.marginTotal) {
        return res.status(400).json({
          success: false,
          error: 'Missing required fields: trader, symbol, marginTotal',
        });
      }

      const session = gridService.createGridSession(params);

      res.json({
        success: true,
        data: session,
        message: 'Grid session created successfully',
      });
    } catch (error: any) {
      logger.error('Error creating grid session:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to create grid session',
      });
    }
  });

  /**
   * POST /api/grid/place-orders
   * Place orders for grid cells (batch creation)
   *
   * This endpoint:
   * 1. Creates grid cells in memory
   * 2. For each cell, creates N on-chain orders (N = clickCount)
   * 3. Links order IDs back to cells
   */
  router.post('/place-orders', async (req: Request, res: Response) => {
    try {
      const params: PlaceGridOrdersRequest = req.body;

      // Validation
      if (!params.gridSessionId || !params.cells || params.cells.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'Missing required fields: gridSessionId, cells',
        });
      }

      const session = gridService.getGridSession(params.gridSessionId);
      if (!session) {
        return res.status(404).json({
          success: false,
          error: 'Grid session not found',
        });
      }

      if (!session.isActive) {
        return res.status(400).json({
          success: false,
          error: 'Grid session is not active',
        });
      }

      const results: any[] = [];

      // Process each cell
      for (let i = 0; i < params.cells.length; i++) {
        const cellParams = params.cells[i];
        const cellSignatures = params.signatures.find((s) => s.cellIndex === i);

        if (!cellSignatures) {
          logger.error(`No signatures provided for cell at index ${i}`);
          continue;
        }

        if (cellSignatures.orderSignatures.length !== cellParams.clickCount) {
          logger.error(
            `Signature count mismatch for cell ${i}: expected ${cellParams.clickCount}, got ${cellSignatures.orderSignatures.length}`
          );
          continue;
        }

        // Create grid cell in memory
        const cell = gridService.createGridCell(cellParams);

        // Create N on-chain orders (N = clickCount)
        const orderIds: string[] = [];
        for (let j = 0; j < cellParams.clickCount; j++) {
          try {
            const signature = cellSignatures.orderSignatures[j];
            const nonce = cellSignatures.nonces[j];

            // Calculate expiration (use cell's endTime)
            const expiresAt = cellParams.endTime.toString();

            // Create order on-chain via LimitExecutorV2
            const orderResult = await limitOrderService.createLimitOpenOrder({
              trader: session.trader,
              symbol: session.symbol,
              isLong: cellParams.isLong,
              collateral: cellParams.collateralPerOrder,
              leverage: session.leverage.toString(),
              triggerPrice: cellParams.triggerPrice,
              nonce,
              expiresAt,
              signature,
              metadata: {
                collateralUsd: cellParams.collateralPerOrder,
                triggerPriceUsd: cellParams.triggerPrice,
              },
            });

            // Link order to cell
            gridService.addOrderToCell(cell.id, orderResult.orderId);
            orderIds.push(orderResult.orderId);

            logger.info(
              `✅ Created order ${j + 1}/${cellParams.clickCount} for cell ${cell.id}: ${orderResult.orderId}`
            );
          } catch (error: any) {
            logger.error(`Failed to create order ${j + 1} for cell ${i}:`, error);
            // Continue with other orders even if one fails
          }
        }

        results.push({
          cellId: cell.id,
          position: { x: cellParams.cellX, y: cellParams.cellY },
          ordersCreated: orderIds.length,
          expectedOrders: cellParams.clickCount,
          orderIds,
        });
      }

      res.json({
        success: true,
        data: {
          gridSessionId: params.gridSessionId,
          cellsProcessed: results.length,
          results,
        },
        message: 'Grid orders placed successfully',
      });
    } catch (error: any) {
      logger.error('Error placing grid orders:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to place grid orders',
      });
    }
  });

  /**
   * GET /api/grid/session/:gridId
   * Get grid session with all cells
   */
  router.get('/session/:gridId', (req: Request, res: Response) => {
    try {
      const { gridId } = req.params;

      const sessionData = gridService.getGridSessionWithCells(gridId);
      if (!sessionData) {
        return res.status(404).json({
          success: false,
          error: 'Grid session not found',
        });
      }

      res.json({
        success: true,
        data: sessionData,
      });
    } catch (error: any) {
      logger.error('Error fetching grid session:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to fetch grid session',
      });
    }
  });

  /**
   * GET /api/grid/user/:trader
   * Get all grid sessions for a user
   */
  router.get('/user/:trader', (req: Request, res: Response) => {
    try {
      const { trader } = req.params;

      const sessions = gridService.getUserGrids(trader);

      res.json({
        success: true,
        data: sessions,
        count: sessions.length,
      });
    } catch (error: any) {
      logger.error('Error fetching user grids:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to fetch user grids',
      });
    }
  });

  /**
   * POST /api/grid/cancel-session
   * Cancel entire grid session
   */
  router.post('/cancel-session', (req: Request, res: Response) => {
    try {
      const { gridId, trader } = req.body;

      if (!gridId || !trader) {
        return res.status(400).json({
          success: false,
          error: 'Missing required fields: gridId, trader',
        });
      }

      gridService.cancelGridSession(gridId, trader);

      res.json({
        success: true,
        message: 'Grid session cancelled successfully',
      });
    } catch (error: any) {
      logger.error('Error cancelling grid session:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to cancel grid session',
      });
    }
  });

  /**
   * POST /api/grid/cancel-cell
   * Cancel individual cell
   */
  router.post('/cancel-cell', (req: Request, res: Response) => {
    try {
      const { cellId, trader } = req.body;

      if (!cellId || !trader) {
        return res.status(400).json({
          success: false,
          error: 'Missing required fields: cellId, trader',
        });
      }

      gridService.cancelGridCell(cellId, trader);

      res.json({
        success: true,
        message: 'Grid cell cancelled successfully',
      });
    } catch (error: any) {
      logger.error('Error cancelling grid cell:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to cancel grid cell',
      });
    }
  });

  /**
   * GET /api/grid/stats
   * Get grid trading statistics
   */
  router.get('/stats', (req: Request, res: Response) => {
    try {
      const stats = gridService.getStats();

      res.json({
        success: true,
        data: stats,
      });
    } catch (error: any) {
      logger.error('Error fetching grid stats:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to fetch grid stats',
      });
    }
  });

  /**
   * GET /api/grid/active-cells
   * Get all active cells (for monitoring/debugging)
   */
  router.get('/active-cells', (req: Request, res: Response) => {
    try {
      const cells = gridService.getActiveCells();

      res.json({
        success: true,
        data: cells,
        count: cells.length,
      });
    } catch (error: any) {
      logger.error('Error fetching active cells:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to fetch active cells',
      });
    }
  });

  return router;
}
