import { Router, Request, Response } from 'express';
import { OneTapProfitService } from '../services/OneTapProfitService';
import { OneTapProfitMonitor } from '../services/OneTapProfitMonitor';
import { Logger } from '../utils/Logger';
import {
  PlaceOneTapBetRequest,
  GetOneTapBetsQuery,
  CalculateMultiplierRequest,
  OneTapBetStatus,
} from '../types/oneTapProfit';

const logger = new Logger('OneTapProfitRoutes');

export function createOneTapProfitRoute(
  oneTapService: OneTapProfitService,
  oneTapMonitor: OneTapProfitMonitor
): Router {
  const router = Router();

  /**
   * POST /api/one-tap/place-bet
   * Place a new bet (gasless via relayer) - Legacy method with user signature
   */
  router.post('/place-bet', async (req: Request, res: Response) => {
    try {
      const params: PlaceOneTapBetRequest = req.body;

      // Validation
      if (!params.trader || !params.symbol || !params.betAmount || !params.targetPrice) {
        return res.status(400).json({
          success: false,
          error: 'Missing required fields: trader, symbol, betAmount, targetPrice, targetTime, entryPrice, entryTime, nonce, userSignature',
        });
      }

      const result = await oneTapService.placeBet(params);

      res.json({
        success: true,
        data: result,
        message: 'Bet placed successfully (gasless transaction)',
      });
    } catch (error: any) {
      logger.error('Error placing bet:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to place bet',
      });
    }
  });

  /**
   * POST /api/one-tap/place-bet-with-session
   * Place bet via keeper with session key (fully gasless)
   */
  router.post('/place-bet-with-session', async (req: Request, res: Response) => {
    try {
      const { trader, symbol, betAmount, targetPrice, targetTime, entryPrice, entryTime, sessionSignature } = req.body;

      // Validation
      if (!trader || !symbol || !betAmount || !targetPrice || !sessionSignature) {
        return res.status(400).json({
          success: false,
          error: 'Missing required fields: trader, symbol, betAmount, targetPrice, targetTime, entryPrice, entryTime, sessionSignature',
        });
      }

      // For OneTapProfit, we trust the session signature was validated by frontend
      // Backend just executes via keeper (off-chain validation is sufficient)
      logger.info(`🎯 Placing OneTapProfit bet via keeper for trader ${trader}`);
      logger.info(`   Session signature provided, executing gaslessly...`);

      // Execute via keeper (no signature verification on-chain)
      const result = await oneTapService.placeBetByKeeper({
        trader,
        symbol,
        betAmount,
        targetPrice,
        targetTime,
        entryPrice,
        entryTime,
      });

      res.json({
        success: true,
        data: result,
        message: 'Bet placed successfully via keeper (fully gasless!)',
      });
    } catch (error: any) {
      logger.error('Error placing bet with session:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to place bet',
      });
    }
  });

  /**
   * GET /api/one-tap/bet/:betId
   * Get specific bet details
   */
  router.get('/bet/:betId', async (req: Request, res: Response) => {
    try {
      const { betId } = req.params;

      const bet = await oneTapService.getBet(betId);
      if (!bet) {
        return res.status(404).json({
          success: false,
          error: 'Bet not found',
        });
      }

      res.json({
        success: true,
        data: bet,
      });
    } catch (error: any) {
      logger.error('Error fetching bet:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to fetch bet',
      });
    }
  });

  /**
   * GET /api/one-tap/bets
   * Query bets with filters
   * 
   * Query params:
   * - trader: Filter by trader address
   * - symbol: Filter by symbol (BTC, ETH, etc)
   * - status: Filter by status (ACTIVE, WON, LOST, CANCELLED)
   */
  router.get('/bets', async (req: Request, res: Response) => {
    try {
      const { trader, symbol, status } = req.query;

      const bets = await oneTapService.queryBets({
        trader: trader as string | undefined,
        symbol: symbol as string | undefined,
        status: status as OneTapBetStatus | undefined,
      });

      res.json({
        success: true,
        data: bets,
        count: bets.length,
      });
    } catch (error: any) {
      logger.error('Error querying bets:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to query bets',
      });
    }
  });

  /**
   * GET /api/one-tap/active
   * Get all active bets (being monitored)
   */
  router.get('/active', (req: Request, res: Response) => {
    try {
      const bets = oneTapService.getActiveBets();

      res.json({
        success: true,
        data: bets,
        count: bets.length,
      });
    } catch (error: any) {
      logger.error('Error fetching active bets:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to fetch active bets',
      });
    }
  });

  /**
   * POST /api/one-tap/calculate-multiplier
   * Calculate multiplier for given parameters
   */
  router.post('/calculate-multiplier', async (req: Request, res: Response) => {
    try {
      const params: CalculateMultiplierRequest = req.body;

      // Validation
      if (!params.entryPrice || !params.targetPrice || !params.entryTime || !params.targetTime) {
        return res.status(400).json({
          success: false,
          error: 'Missing required fields: entryPrice, targetPrice, entryTime, targetTime',
        });
      }

      const result = await oneTapService.calculateMultiplier(params);

      res.json({
        success: true,
        data: result,
      });
    } catch (error: any) {
      logger.error('Error calculating multiplier:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to calculate multiplier',
      });
    }
  });

  /**
   * GET /api/one-tap/stats
   * Get One Tap Profit statistics
   */
  router.get('/stats', (req: Request, res: Response) => {
    try {
      const stats = oneTapService.getStats();

      res.json({
        success: true,
        data: stats,
      });
    } catch (error: any) {
      logger.error('Error fetching stats:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to fetch stats',
      });
    }
  });

  /**
   * GET /api/one-tap/status
   * Get monitor status
   */
  router.get('/status', (req: Request, res: Response) => {
    try {
      const status = oneTapMonitor.getStatus();
      const contractAddress = oneTapService.getContractAddress();

      res.json({
        success: true,
        data: {
          ...status,
          contractAddress,
        },
      });
    } catch (error: any) {
      logger.error('Error fetching status:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to fetch status',
      });
    }
  });

  return router;
}
