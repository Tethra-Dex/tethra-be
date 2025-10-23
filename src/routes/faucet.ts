import { Router, Request, Response } from 'express';
import { Logger } from '../utils/Logger';
import { createWalletClient, http, parseUnits, PublicClient, createPublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

const logger = new Logger('FaucetRoute');

// Simple ERC20 Mint ABI for testing/mock tokens
const MOCK_USDC_ABI = [
  {
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' }
    ],
    name: 'mint',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;

export function createFaucetRoute(): Router {
  const router = Router();

  /**
   * POST /api/faucet/claim
   * Claim mock USDC from faucet
   */
  router.post('/claim', async (req: Request, res: Response) => {
    try {
      const { address, amount = '100' } = req.body;

      if (!address) {
        return res.status(400).json({
          success: false,
          error: 'Address is required',
          timestamp: Date.now()
        });
      }

      // Validate address format
      if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid address format',
          timestamp: Date.now()
        });
      }

      // Get configuration from environment
      const usdcAddress = process.env.NEXT_PUBLIC_USDC_ADDRESS || '0x9d660c5d4BFE4b7fcC76f327b22ABF7773DD48c1';
      const faucetPrivateKey = process.env.FAUCET_PRIVATE_KEY;
      const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL || 'https://sepolia.base.org';

      if (!faucetPrivateKey) {
        logger.error('FAUCET_PRIVATE_KEY not configured in environment');
        return res.status(500).json({
          success: false,
          error: 'Faucet not configured. Please contact administrator.',
          timestamp: Date.now()
        });
      }

      // Create account from private key
      const account = privateKeyToAccount(faucetPrivateKey as `0x${string}`);

      // Create wallet client
      const walletClient = createWalletClient({
        account,
        chain: baseSepolia,
        transport: http(rpcUrl),
      });

      // Create public client for waiting transaction
      const publicClient = createPublicClient({
        chain: baseSepolia,
        transport: http(rpcUrl),
      });

      // Parse amount (USDC has 6 decimals)
      const amountToMint = parseUnits(amount, 6);

      logger.info(`Minting ${amount} USDC to ${address}...`);

      // Call mint function on the mock USDC contract
      const hash = await walletClient.writeContract({
        address: usdcAddress as `0x${string}`,
        abi: MOCK_USDC_ABI,
        functionName: 'mint',
        args: [address as `0x${string}`, amountToMint],
      });

      logger.info(`Transaction submitted: ${hash}`);

      // Wait for transaction confirmation
      const receipt = await publicClient.waitForTransactionReceipt({
        hash,
        confirmations: 1
      });

      logger.success(`Successfully minted ${amount} USDC to ${address}`);

      return res.json({
        success: true,
        data: {
          transactionHash: hash,
          amount: amount,
          recipient: address,
          status: receipt.status,
          blockNumber: receipt.blockNumber.toString(),
          explorerUrl: `https://sepolia.basescan.org/tx/${hash}`
        },
        message: `Successfully claimed ${amount} USDC`,
        timestamp: Date.now()
      });

    } catch (error: any) {
      logger.error('Error claiming from faucet:', error);

      let errorMessage = 'Failed to claim USDC from faucet';

      if (error?.message?.includes('mint')) {
        errorMessage = 'This contract does not support minting. Please use a different faucet.';
      } else if (error?.message?.includes('insufficient funds')) {
        errorMessage = 'Faucet has insufficient funds. Please contact administrator.';
      } else if (error?.message) {
        errorMessage = error.message;
      }

      return res.status(500).json({
        success: false,
        error: errorMessage,
        timestamp: Date.now()
      });
    }
  });

  /**
   * GET /api/faucet/status
   * Get faucet status and configuration
   */
  router.get('/status', async (req: Request, res: Response) => {
    try {
      const faucetPrivateKey = process.env.FAUCET_PRIVATE_KEY;

      if (!faucetPrivateKey) {
        return res.json({
          success: true,
          data: {
            enabled: false,
            message: 'Faucet not configured'
          },
          timestamp: Date.now()
        });
      }

      const account = privateKeyToAccount(faucetPrivateKey as `0x${string}`);
      const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL || 'https://sepolia.base.org';

      const publicClient = createPublicClient({
        chain: baseSepolia,
        transport: http(rpcUrl),
      });

      // Get faucet ETH balance
      const balance = await publicClient.getBalance({
        address: account.address,
      });

      return res.json({
        success: true,
        data: {
          enabled: true,
          faucetAddress: account.address,
          ethBalance: (Number(balance) / 1e18).toFixed(6),
          defaultAmount: '100',
          network: 'Base Sepolia',
          chainId: 84532
        },
        timestamp: Date.now()
      });

    } catch (error: any) {
      logger.error('Error getting faucet status:', error);
      return res.status(500).json({
        success: false,
        error: error.message || 'Failed to get faucet status',
        timestamp: Date.now()
      });
    }
  });

  return router;
}
