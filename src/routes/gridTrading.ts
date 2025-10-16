import { Router, Request, Response } from 'express';
import { GridTradingService } from '../services/GridTradingService';
import { Logger } from '../utils/Logger';
import {
  CreateGridSessionRequest,
} from '../types/gridTrading';

const logger = new Logger('GridTradingRoutes');

export function createGridTradingRoute(
  gridService: GridTradingService
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
   * ⚠️ DEPRECATED: Use /api/tap-to-trade/batch-create instead
   *
   * This endpoint creates orders ON-CHAIN which is expensive.
   * For Tap-to-Trade, use backend-only storage to save gas.
   */
  router.post('/place-orders', async (_req: Request, res: Response) => {
    res.status(410).json({
      success: false,
      error: 'This endpoint is deprecated for Tap-to-Trade',
      message: 'Please use POST /api/tap-to-trade/batch-create instead',
      recommendation: {
        endpoint: '/api/tap-to-trade/batch-create',
        benefit: 'Backend-only storage, no gas fee for order creation',
      },
    });
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
  router.get('/stats', (_req: Request, res: Response) => {
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
  router.get('/active-cells', (_req: Request, res: Response) => {
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
