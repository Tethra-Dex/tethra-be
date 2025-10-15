import { Router, Request, Response } from 'express';
import { PythPriceService } from '../services/PythPriceService';
import { PriceSignerService } from '../services/PriceSignerService';

export function createPriceRoute(
  priceService: PythPriceService,
  signerService: PriceSignerService
): Router {
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

  // ============================================
  // SIGNED PRICE ENDPOINTS (For Trading)
  // ============================================

  /**
   * Get signed price for specific asset
   * This endpoint is used by frontend before executing trades
   * 
   * Example: GET /api/price/signed/BTC
   * Returns: { assetId, price, timestamp, signature, signer }
   */
  router.get('/signed/:symbol', async (req: Request, res: Response) => {
    try {
      const symbol = req.params.symbol.toUpperCase();
      
      // Check if signer is initialized
      if (!signerService.isInitialized()) {
        return res.status(503).json({
          success: false,
          error: 'Price Signer not initialized',
          message: 'Please configure PRICE_SIGNER_PRIVATE_KEY in environment',
          timestamp: Date.now()
        });
      }

      // Get current price from Pyth
      const currentPrice = priceService.getCurrentPrice(symbol);
      
      if (!currentPrice) {
        return res.status(404).json({
          success: false,
          error: `No price data available for ${symbol}`,
          timestamp: Date.now()
        });
      }

      // Get price in 8 decimals (Pyth uses 8 decimals)
      const priceInDecimals = BigInt(Math.floor(currentPrice.price * 1e8));
      
      // CRITICAL: Use current Unix timestamp in SECONDS (not milliseconds!)
      // Subtract 2 seconds to account for network delay and ensure timestamp is in past
      const timestamp = Math.floor(Date.now() / 1000) - 2;

      // Sign the price data
      const signedData = await signerService.signPrice(
        symbol,
        priceInDecimals,
        timestamp
      );

      res.json({
        success: true,
        data: {
          symbol: symbol, // Add symbol for contract compatibility
          ...signedData,
          priceUSD: currentPrice.price, // Human readable price
          confidence: currentPrice.confidence,
          validUntil: timestamp + 300 // Valid for 5 minutes
        },
        timestamp: Date.now()
      });

    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'Failed to sign price',
        message: error instanceof Error ? error.message : 'Unknown error',
        timestamp: Date.now()
      });
    }
  });

  /**
   * Verify a signature (for testing)
   * 
   * POST /api/price/verify
   * Body: { symbol, price, timestamp, signature }
   */
  router.post('/verify', (req: Request, res: Response) => {
    try {
      const { symbol, price, timestamp, signature } = req.body;

      if (!symbol || !price || !timestamp || !signature) {
        return res.status(400).json({
          success: false,
          error: 'Missing required fields',
          required: ['symbol', 'price', 'timestamp', 'signature'],
          timestamp: Date.now()
        });
      }

      const recoveredAddress = signerService.verifySignature(
        symbol,
        price,
        timestamp,
        signature
      );

      const expectedAddress = signerService.getSignerAddress();
      const isValid = recoveredAddress.toLowerCase() === expectedAddress.toLowerCase();

      res.json({
        success: true,
        data: {
          isValid,
          recoveredAddress,
          expectedAddress,
          match: isValid
        },
        timestamp: Date.now()
      });

    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'Failed to verify signature',
        message: error instanceof Error ? error.message : 'Unknown error',
        timestamp: Date.now()
      });
    }
  });

  /**
   * Get signer status
   */
  router.get('/signer/status', (req: Request, res: Response) => {
    try {
      const status = signerService.getStatus();

      res.json({
        success: true,
        data: status,
        timestamp: Date.now()
      });

    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'Failed to get signer status',
        message: error instanceof Error ? error.message : 'Unknown error',
        timestamp: Date.now()
      });
    }
  });

  return router;
}
