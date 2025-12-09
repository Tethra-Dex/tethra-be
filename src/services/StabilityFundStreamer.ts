import { ethers } from 'ethers';
import StabilityFundABI from '../abis/StabilityFund.json';
import { Logger } from '../utils/Logger';
import { NonceManager } from '../utils/NonceManager';

type StreamTrigger = 'startup' | 'interval' | 'manual';

/**
 * Periodically calls StabilityFund.streamToVault to move surplus to VaultPool.
 * Runs with the relayer/keeper wallet and is intended to be a long-lived cron job.
 */
export class StabilityFundStreamer {
  private readonly logger = new Logger('StabilityFundStreamer');
  private readonly provider: ethers.JsonRpcProvider;
  private readonly relayer: ethers.Wallet;
  private readonly stabilityFund: ethers.Contract;
  private readonly stabilityFundAddress: string;
  private readonly intervalMs: number;
  private usdcToken?: ethers.Contract;
  private intervalId?: NodeJS.Timeout;
  private isRunning = false;
  private isStreaming = false;

  constructor() {
    const rpcUrl = process.env.RPC_URL || 'https://sepolia.base.org';
    this.provider = new ethers.JsonRpcProvider(rpcUrl);

    const relayerKey = process.env.RELAY_PRIVATE_KEY;
    if (!relayerKey) {
      throw new Error('RELAY_PRIVATE_KEY not configured');
    }
    this.relayer = new ethers.Wallet(relayerKey, this.provider);

    const stabilityFundAddress = process.env.STABILITY_FUND_ADDRESS;
    if (!stabilityFundAddress) {
      throw new Error('STABILITY_FUND_ADDRESS not configured');
    }
    this.stabilityFundAddress = stabilityFundAddress;

    this.stabilityFund = new ethers.Contract(
      stabilityFundAddress,
      StabilityFundABI.abi,
      this.relayer
    );

    const defaultInterval = 6 * 60 * 60 * 1000; // 6 hours
    const intervalFromMs = Number(process.env.VAULT_STREAM_INTERVAL_MS);
    const intervalFromMinutes = Number(process.env.VAULT_STREAM_INTERVAL_MINUTES);
    this.intervalMs = !Number.isNaN(intervalFromMs) && intervalFromMs > 0
      ? intervalFromMs
      : !Number.isNaN(intervalFromMinutes) && intervalFromMinutes > 0
        ? intervalFromMinutes * 60 * 1000
        : defaultInterval;

    const keeperAddress = process.env.KEEPER_ADDRESS;
    if (keeperAddress && keeperAddress.toLowerCase() !== this.relayer.address.toLowerCase()) {
      this.logger.warn('KEEPER_ADDRESS differs from relayer wallet', {
        keeperAddress,
        relayer: this.relayer.address
      });
    }

    this.logger.info('StabilityFund streamer initialized', {
      stabilityFundAddress,
      relayer: this.relayer.address,
      intervalHours: Number((this.intervalMs / (60 * 60 * 1000)).toFixed(2))
    });
  }

  start(runImmediately = true): void {
    if (this.isRunning) {
      this.logger.warn('Streamer already running');
      return;
    }

    this.isRunning = true;

    if (runImmediately) {
      this.triggerStream('startup');
    }

    this.intervalId = setInterval(() => this.triggerStream('interval'), this.intervalMs);
    this.logger.success(`ƒo. StabilityFund streamer scheduled every ${Math.round(this.intervalMs / (60 * 60 * 1000))}h`);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
    this.isRunning = false;
    this.logger.info('StabilityFund streamer stopped');
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      intervalMs: this.intervalMs,
      relayer: this.relayer.address,
      contract: this.stabilityFund.target?.toString?.() || this.stabilityFundAddress,
      streaming: this.isStreaming
    };
  }

  private triggerStream(trigger: StreamTrigger) {
    if (!this.isRunning) return;

    this.streamToVault(trigger).catch((error) => {
      this.logger.error('StreamToVault failed', { trigger, error: error instanceof Error ? error.message : error });
    });
  }

  private async streamToVault(trigger: StreamTrigger) {
    if (this.isStreaming) {
      this.logger.warn('Previous stream still running, skipping', { trigger });
      return;
    }

    this.isStreaming = true;
    try {
      const nowSeconds = BigInt(Math.floor(Date.now() / 1000));

      try {
        const [lastStreamAt, streamInterval] = await Promise.all([
          this.stabilityFund.lastStreamAt(),
          this.stabilityFund.streamInterval()
        ]);

        if (lastStreamAt && streamInterval && nowSeconds - lastStreamAt < streamInterval) {
          const remaining = streamInterval - (nowSeconds - lastStreamAt);
          this.logger.info('Skipping streamToVault, interval not reached yet', {
            trigger,
            minutesRemaining: Number(remaining) / 60
          });
          return;
        }
      } catch (error) {
        this.logger.warn('Could not read stream interval, proceeding anyway', error);
      }

      const balance = await this.getStabilityFundBalance();
      if (balance !== null && balance === 0n) {
        this.logger.info('Skipping streamToVault, StabilityFund USDC balance is zero', {
          trigger,
          balance: balance.toString()
        });
        return;
      }

      const nonce = await this.tryGetNonce();
      const txOptions: any = { gasLimit: 300000n };
      if (nonce !== undefined) {
        txOptions.nonce = nonce;
      }

      const tx = await this.stabilityFund.streamToVault(txOptions);

      this.logger.info('streamToVault sent', {
        trigger,
        txHash: tx.hash,
        nonce: nonce ?? 'provider-managed'
      });

      const receipt = await tx.wait();
      this.logger.success('StabilityFund streamed to VaultPool', {
        txHash: receipt.hash,
        gasUsed: receipt.gasUsed?.toString()
      });
    } catch (error: any) {
      this.logger.error('Failed to stream to vault', error);
      if (this.isNonceError(error)) {
        await this.tryResyncNonce();
      }
    } finally {
      this.isStreaming = false;
    }
  }

  private async tryGetNonce(): Promise<number | undefined> {
    try {
      return await NonceManager.getInstance().getNonce();
    } catch {
      this.logger.debug('NonceManager not initialized, letting provider handle nonce');
      return undefined;
    }
  }

  private async tryResyncNonce() {
    try {
      await NonceManager.getInstance().resync();
    } catch {
      this.logger.warn('Failed to resync nonce after error');
    }
  }

  private async getStabilityFundBalance(): Promise<bigint | null> {
    try {
      if (!this.usdcToken) {
        const usdcAddress: string = await this.stabilityFund.usdc();
        this.usdcToken = new ethers.Contract(
          usdcAddress,
          ['function balanceOf(address) view returns (uint256)'],
          this.provider
        );
      }

      const fundAddress = this.stabilityFund.target?.toString?.() || this.stabilityFundAddress;
      const balance: bigint = await this.usdcToken.balanceOf(fundAddress);
      return balance;
    } catch (error) {
      this.logger.warn('Could not read StabilityFund USDC balance', error);
      return null;
    }
  }

  private isNonceError(err: any): boolean {
    if (!err) return false;
    const msg = err.message?.toLowerCase() || '';
    const code = err.code;
    const infoMsg = err.info?.error?.message?.toLowerCase() || '';

    return (
      code === 'NONCE_EXPIRED' ||
      msg.includes('nonce') ||
      msg.includes('replacement transaction underpriced') ||
      infoMsg.includes('nonce') ||
      infoMsg.includes('replacement transaction underpriced')
    );
  }
}
