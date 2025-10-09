import { Router, Request, Response } from 'express';
import { PythPriceService } from '../services/PythPriceService';

export function createPriceRoute(priceService: PythPriceService): Router {
  const router = Router();

  // Get all current prices
  router.get('/all', (req: Request, res: Response) => {
    try {
      const currentPrices = priceService.getCurrentPrices();
      
      if (Object.keys(currentPrices).length === 0) {
        return res.status(404).json({
          success: false,
          error: 'No price data available',
          timestamp: Date.now()
        });
      }

      res.json({
        success: true,
        data: currentPrices,
        count: Object.keys(currentPrices).length,
        timestamp: Date.now()
      });

    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'Failed to get prices',
        message: error instanceof Error ? error.message : 'Unknown error',
        timestamp: Date.now()
      });
    }
  });

  // Get current price for specific symbol
  router.get('/current/:symbol', (req: Request, res: Response) => {
    try {
      const symbol = req.params.symbol.toUpperCase();
      const currentPrice = priceService.getCurrentPrice(symbol);
      
      if (!currentPrice) {
        return res.status(404).json({
          success: false,
          error: `No price data available for ${symbol}`,
          timestamp: Date.now()
        });
      }

      res.json({
        success: true,
        data: currentPrice,
        timestamp: Date.now()
      });

    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'Failed to get price',
        message: error instanceof Error ? error.message : 'Unknown error',
        timestamp: Date.now()
      });
    }
  });

  // Get price service health
  router.get('/health', (req: Request, res: Response) => {
    try {
      const healthStatus = priceService.getHealthStatus();

      res.json({
        success: true,
        data: healthStatus,
        timestamp: Date.now()
      });

    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'Failed to get price service health',
        message: error instanceof Error ? error.message : 'Unknown error',
        timestamp: Date.now()
      });
    }
  });

  return router;
}
