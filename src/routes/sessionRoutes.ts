import { Router, Request, Response } from 'express';
import { ethers } from 'ethers';
import { Logger } from '../utils/Logger';
import TapToTradeExecutorABI from '../abis/TapToTradeExecutor.json';

const router = Router();
const logger = new Logger('SessionRoutes');

/**
 * POST /api/session/authorize
 * 
 * Backend authorizes session key on-chain (relayer pays gas!)
 */
router.post('/authorize', async (req: Request, res: Response) => {
  try {
    const { trader, sessionKeyAddress, duration, authSignature, expiresAt } = req.body;

    if (!trader || !sessionKeyAddress || !duration || !authSignature) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: trader, sessionKeyAddress, duration, authSignature',
      });
    }

    logger.info('🔑 Authorizing session key on-chain...', {
      trader,
      sessionKeyAddress,
      duration,
    });

    // Initialize provider and relayer wallet
    const RPC_URL = process.env.RPC_URL || 'https://sepolia.base.org';
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    
    const relayerPrivateKey = process.env.RELAY_PRIVATE_KEY;
    if (!relayerPrivateKey) {
      throw new Error('RELAY_PRIVATE_KEY not configured');
    }
    
    const relayerWallet = new ethers.Wallet(relayerPrivateKey, provider);
    
    const tapToTradeExecutorAddress = process.env.TAP_TO_TRADE_EXECUTOR_ADDRESS || '0x841f70066ba831650c4D97BD59cc001c890cf6b6';
    
    // Create contract instance
    const tapToTradeExecutor = new ethers.Contract(
      tapToTradeExecutorAddress,
      TapToTradeExecutorABI.abi,
      relayerWallet
    );

    logger.info('💰 Relayer paying gas:', relayerWallet.address);

    // Verify signature locally before sending to chain
    // IMPORTANT: Use expiresAt from frontend to match signature!
    const expiresAtSeconds = expiresAt ? Math.floor(expiresAt / 1000) : Math.floor(Date.now() / 1000) + duration;
    
    logger.info('🕒 Authorization timing:', {
      expiresAtMs: expiresAt,
      expiresAtSeconds,
      duration,
    });
    const messageHash = ethers.solidityPackedKeccak256(
      ['string', 'address', 'string', 'uint256'],
      [
        'Authorize session key ',
        sessionKeyAddress,
        ' for Tethra Tap-to-Trade until ',
        expiresAtSeconds
      ]
    );
    
    const digest = ethers.hashMessage(ethers.getBytes(messageHash));
    const recoveredSigner = ethers.recoverAddress(digest, authSignature);
    
    if (recoveredSigner.toLowerCase() !== trader.toLowerCase()) {
      logger.error('❌ Invalid signature:', {
        expected: trader,
        recovered: recoveredSigner,
      });
      return res.status(400).json({
        success: false,
        error: `Invalid signature: recovered ${recoveredSigner}, expected ${trader}`,
      });
    }

    logger.info('✅ Signature verified locally');

    // Call authorizeSessionKey on contract (relayer pays gas!)
    const tx = await tapToTradeExecutor.authorizeSessionKey(
      sessionKeyAddress,
      duration,
      authSignature,
      { gasLimit: 300000 } // Set generous gas limit
    );

    logger.info('📤 Authorization tx sent:', tx.hash);

    // Wait for confirmation
    const receipt = await tx.wait();

    if (receipt.status === 0) {
      throw new Error('Transaction reverted');
    }

    logger.info('✅ Session key authorized on-chain!', {
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
    });

    res.json({
      success: true,
      txHash: receipt.hash,
      receipt: {
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString(),
        status: receipt.status,
      },
    });
  } catch (error: any) {
    logger.error('❌ Failed to authorize session key:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Authorization failed',
    });
  }
});

/**
 * GET /api/session/status
 * 
 * Check status of authorization transaction
 */
router.get('/status', async (req: Request, res: Response) => {
  try {
    const { txHash } = req.query;

    if (!txHash) {
      return res.status(400).json({
        success: false,
        error: 'Missing txHash parameter',
      });
    }

    const RPC_URL = process.env.RPC_URL || 'https://sepolia.base.org';
    const provider = new ethers.JsonRpcProvider(RPC_URL);

    const receipt = await provider.getTransactionReceipt(txHash as string);

    if (!receipt) {
      return res.json({
        success: true,
        confirmed: false,
        pending: true,
      });
    }

    res.json({
      success: true,
      confirmed: true,
      blockNumber: receipt.blockNumber,
      status: receipt.status,
      gasUsed: receipt.gasUsed.toString(),
    });
  } catch (error: any) {
    logger.error('❌ Failed to check status:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Status check failed',
    });
  }
});

export default router;
