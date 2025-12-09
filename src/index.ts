import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { Server as WebSocketServer } from 'ws';
import http from 'http';
import { PythPriceService } from './services/PythPriceService';
import { PriceSignerService } from './services/PriceSignerService';
import { RelayService } from './services/RelayService';
import { LimitOrderService } from './services/LimitOrderService';
import { LimitOrderExecutor } from './services/LimitOrderExecutor';
import { PositionMonitor } from './services/PositionMonitor';
import { GridTradingService } from './services/GridTradingService';
import { TPSLMonitor } from './services/TPSLMonitor';
import { TapToTradeService } from './services/TapToTradeService';
import { TapToTradeExecutor } from './services/TapToTradeExecutor';
import { OneTapProfitService } from './services/OneTapProfitService';
import { OneTapProfitMonitor } from './services/OneTapProfitMonitor';
import { StabilityFundStreamer } from './services/StabilityFundStreamer';
import { createPriceRoute } from './routes/price';
import { createRelayRoute } from './routes/relay';
import { createLimitOrderRoute } from './routes/limitOrders';
import { createGridTradingRoute } from './routes/gridTrading';
import { createTPSLRoute } from './routes/tpsl';
import { createTapToTradeRoute } from './routes/tapToTrade';
import { createOneTapProfitRoute } from './routes/oneTapProfit';
import { createFaucetRoute } from './routes/faucet';
import { Logger } from './utils/Logger';

dotenv.config();

const logger = new Logger('Main');
const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging middleware
app.use((req: Request, _res: Response, next: NextFunction) => {
  logger.info(`${req.method} ${req.path}`, {
    ip: req.ip,
    userAgent: req.get('User-Agent')
  });
  next();
});

async function main() {
  try {
    logger.info('🚀 Starting Tethra DEX Backend (Pyth Oracle Integration)...');
    
    // Initialize services
    const priceService = new PythPriceService();
    const signerService = new PriceSignerService(); // Auto-initializes in constructor
    const relayService = new RelayService(); // Initialize relay service for gasless transactions
    const limitOrderService = new LimitOrderService(); // Keeper interactions for limit orders
    const gridTradingService = new GridTradingService(); // Grid trading in-memory storage
    const tapToTradeService = new TapToTradeService(); // Tap-to-trade backend-only orders
    const oneTapProfitService = new OneTapProfitService(); // One Tap Profit betting system

    // Wait for Pyth price service to initialize
    await priceService.initialize();

    // Initialize TP/SL Monitor first (needed by LimitOrderExecutor)
    logger.info('🎯 Initializing TP/SL Monitor...');
    const tpslMonitor = new TPSLMonitor(priceService);
    tpslMonitor.start();
    tpslMonitorRef = tpslMonitor; // Store reference for graceful shutdown
    logger.success('✅ TP/SL Monitor started! Ready to execute TP/SL orders...');

    // Initialize Limit Order Executor (monitors and auto-executes orders)
    logger.info('🤖 Initializing Limit Order Executor...');
    const limitOrderExecutor = new LimitOrderExecutor(
      priceService,
      gridTradingService,
      tpslMonitor,
      limitOrderService
    );
    limitOrderExecutor.start();
    limitOrderExecutorRef = limitOrderExecutor; // Store reference for graceful shutdown
    logger.success('✅ Limit Order Executor started! Monitoring for orders...');

    // Initialize Tap-to-Trade Executor (monitors backend-only orders and executes directly)
    logger.info('🎯 Initializing Tap-to-Trade Executor...');
    const tapToTradeExecutor = new TapToTradeExecutor(priceService, tapToTradeService);
    tapToTradeExecutor.start();
    tapToTradeExecutorRef = tapToTradeExecutor; // Store reference for graceful shutdown
    logger.success('✅ Tap-to-Trade Executor started! Monitoring for tap-to-trade orders...');

      // Initialize One Tap Profit Monitor (monitors and settles bets automatically)
      logger.info('🎰 Initializing One Tap Profit Monitor...');
      const oneTapProfitMonitor = new OneTapProfitMonitor(priceService, oneTapProfitService);
      oneTapProfitMonitor.start();
      oneTapProfitMonitorRef = oneTapProfitMonitor; // Store reference for graceful shutdown
      logger.success('✅ One Tap Profit Monitor started! Monitoring for bets...');

    // Initialize Position Monitor (auto-liquidation for isolated margin)
    logger.info('🔍 Initializing Position Monitor (Auto-Liquidation)...');
    const positionMonitor = new PositionMonitor(priceService);
    positionMonitor.start();
    positionMonitorRef = positionMonitor; // Store reference for graceful shutdown
    logger.success('✅ Position Monitor started! Monitoring for liquidations...');
    
    // Initialize Stability Fund streamer (periodic streamToVault)
    logger.info('dYZ_ Initializing Stability Fund streamer...');
    const stabilityFundStreamer = new StabilityFundStreamer();
    stabilityFundStreamer.start();
    stabilityFundStreamerRef = stabilityFundStreamer;
    logger.success('✅ Stability Fund streamer scheduled (streamToVault cron running)');
    
    // Check Price Signer status
    if (signerService.isInitialized()) {
      logger.success(`✅ Price Signer ready: ${signerService.getSignerAddress()}`);
    } else {
      logger.warn('⚠️  Price Signer not available (signed price endpoints disabled)');
    }
    
    // Check Relay Service status
    const relayBalance = await relayService.getRelayBalance();
    logger.success(`✅ Relay Service ready: ${relayBalance.ethFormatted} ETH`);
    if (parseFloat(relayBalance.ethFormatted) < 0.01) {
      logger.warn('⚠️  Relay wallet has low ETH balance! Please fund for gasless transactions.');
    }
    
    // Create HTTP server for both Express and WebSocket
    const server = http.createServer(app);
    
    // Setup WebSocket Server for real-time price updates
    const wss = new WebSocketServer({ server, path: '/ws/price' });
    logger.info('📡 WebSocket server initialized on /ws/price');
    
    wss.on('connection', (ws) => {
      logger.info('✅ New WebSocket client connected');
      
      // Send current prices immediately on connection
      const currentPrices = priceService.getCurrentPrices();
      if (Object.keys(currentPrices).length > 0) {
        ws.send(JSON.stringify({
          type: 'price_update',
          data: currentPrices,
          timestamp: Date.now()
        }));
      }
      
      ws.on('error', (error) => {
        logger.error('WebSocket client error:', error);
      });
      
      ws.on('close', () => {
        logger.info('❌ WebSocket client disconnected');
      });
    });
    
    // Subscribe to price updates and broadcast to all WebSocket clients
    priceService.onPriceUpdate((prices) => {
      const message = JSON.stringify({
        type: 'price_update',
        data: prices,
        timestamp: Date.now()
      });
      
      // Broadcast to all connected clients
      wss.clients.forEach((client) => {
        if (client.readyState === 1) { // OPEN state
          client.send(message);
        }
      });
    });
    
    // Setup routes
    app.get('/', (req: Request, res: Response) => {
      res.json({
        success: true,
        message: 'Tethra DEX Backend - Pyth Oracle Price Service',
        version: '1.0.0',
        endpoints: {
          websocket: '/ws/price',
          prices: '/api/price',
          signedPrices: '/api/price/signed/:symbol',
          verifySignature: '/api/price/verify',
          signerStatus: '/api/price/signer/status',
          relay: '/api/relay',
          relayTransaction: '/api/relay/transaction',
          relayBalance: '/api/relay/balance/:address',
          relayStatus: '/api/relay/status',
          limitOrderCreate: '/api/limit-orders/create',
          gridTradingCreateSession: '/api/grid/create-session',
          gridTradingPlaceOrders: '/api/grid/place-orders',
          gridTradingUserGrids: '/api/grid/user/:trader',
          gridTradingStats: '/api/grid/stats',
          tpslSet: '/api/tpsl/set',
          tpslGet: '/api/tpsl/:positionId',
          tpslGetAll: '/api/tpsl/all',
          tpslDelete: '/api/tpsl/:positionId',
          tpslStatus: '/api/tpsl/status',
          tapToTradeCreateOrder: '/api/tap-to-trade/create-order',
          tapTotradeBatchCreate: '/api/tap-to-trade/batch-create',
          tapToTradeOrders: '/api/tap-to-trade/orders',
          tapTotradePending: '/api/tap-to-trade/pending',
          tapTotradeCancelOrder: '/api/tap-to-trade/cancel-order',
          tapToTradeStats: '/api/tap-to-trade/stats',
          oneTapPlaceBet: '/api/one-tap/place-bet',
          oneTapBets: '/api/one-tap/bets',
          oneTapActive: '/api/one-tap/active',
          oneTapCalculateMultiplier: '/api/one-tap/calculate-multiplier',
          oneTapStats: '/api/one-tap/stats',
          oneTapStatus: '/api/one-tap/status',
          faucetClaim: '/api/faucet/claim',
          faucetStatus: '/api/faucet/status',
          health: '/health'
        },
        timestamp: Date.now()
      });
    });
    
    app.get('/health', (_req: Request, res: Response) => {
      const healthStatus = priceService.getHealthStatus();
      res.json({
        success: true,
        service: 'Tethra DEX Backend',
        uptime: process.uptime(),
        priceService: healthStatus,
        timestamp: Date.now()
      });
    });
    
    app.use('/api/price', createPriceRoute(priceService, signerService));
    app.use('/api/relay', createRelayRoute(relayService));
    app.use('/api/limit-orders', createLimitOrderRoute(limitOrderService));
    app.use('/api/grid', createGridTradingRoute(gridTradingService));
    app.use('/api/tpsl', createTPSLRoute(tpslMonitor));
    app.use('/api/tap-to-trade', createTapToTradeRoute(tapToTradeService));
    app.use('/api/one-tap', createOneTapProfitRoute(oneTapProfitService, oneTapProfitMonitor));
    app.use('/api/faucet', createFaucetRoute());
    
    // Session key authorization route (relayer pays gas!)
    const sessionRoutes = require('./routes/sessionRoutes').default;
    app.use('/api/session', sessionRoutes);
    
    // Global error handler
    app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
      logger.error('Unhandled API error:', error);
      res.status(500).json({
        error: 'Internal server error',
        message: error.message,
        timestamp: Date.now()
      });
    });
    
    // 404 handler
    app.use((req: Request, res: Response) => {
      res.status(404).json({
        error: 'Not found',
        message: `Route ${req.method} ${req.path} not found`,
        timestamp: Date.now()
      });
    });
    
    // Start server
    server.listen(PORT, () => {
      logger.success(`🎉 Tethra DEX Backend running on port ${PORT}`);
      logger.info(`📡 WebSocket: ws://localhost:${PORT}/ws/price`);
      logger.info(`🌐 REST API: http://localhost:${PORT}/api/price`);
      logger.info(`💚 Health check: http://localhost:${PORT}/health`);
      logger.info(`🔥 Environment: ${process.env.NODE_ENV || 'development'}`);
    });
    
  } catch (error) {
    logger.error('Failed to start Tethra DEX Backend:', error);
    process.exit(1);
  }
}

// Graceful shutdown
let limitOrderExecutorRef: any = null;
let positionMonitorRef: any = null;
let tpslMonitorRef: any = null;
let tapToTradeExecutorRef: any = null;
let oneTapProfitMonitorRef: any = null;
let stabilityFundStreamerRef: StabilityFundStreamer | null = null;

process.on('SIGINT', () => {
  logger.info('Received SIGINT, shutting down gracefully...');
  if (limitOrderExecutorRef) {
    limitOrderExecutorRef.stop();
  }
  if (positionMonitorRef) {
    positionMonitorRef.stop();
  }
  if (tpslMonitorRef) {
    tpslMonitorRef.stop();
  }
  if (tapToTradeExecutorRef) {
    tapToTradeExecutorRef.stop();
  }
  if (oneTapProfitMonitorRef) {
    oneTapProfitMonitorRef.stop();
  }
  if (stabilityFundStreamerRef) {
    stabilityFundStreamerRef.stop();
  }
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('Received SIGTERM, shutting down gracefully...');
  if (limitOrderExecutorRef) {
    limitOrderExecutorRef.stop();
  }
  if (positionMonitorRef) {
    positionMonitorRef.stop();
  }
  if (tpslMonitorRef) {
    tpslMonitorRef.stop();
  }
  if (tapToTradeExecutorRef) {
    tapToTradeExecutorRef.stop();
  }
  if (oneTapProfitMonitorRef) {
    oneTapProfitMonitorRef.stop();
  }
  if (stabilityFundStreamerRef) {
    stabilityFundStreamerRef.stop();
  }
  process.exit(0);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at promise:', { promise: promise.toString(), reason });
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  process.exit(1);
});

main().catch((error) => {
  logger.error('Fatal error in main:', error);
  process.exit(1);
});
