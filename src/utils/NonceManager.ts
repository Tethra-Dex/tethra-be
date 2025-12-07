import { Wallet } from 'ethers';

/**
 * Nonce Manager for High-Throughput Relayer
 * 
 * Manages nonce locally to allow "Fire and Forget" transactions
 * avoiding the need to wait for block confirmation or network queries
 */
export class NonceManager {
  private static instance: NonceManager;
  private wallet: Wallet | null = null;
  private nonce: number | null = null;
  private mutex: boolean = false;
  private queue: Array<(nonce: number) => void> = [];

  private constructor() {}

  public static getInstance(): NonceManager {
    if (!NonceManager.instance) {
      NonceManager.instance = new NonceManager();
    }
    return NonceManager.instance;
  }

  /**
   * Initialize the manager with the relayer wallet
   * Must be called at startup
   */
  public async init(wallet: Wallet) {
    this.wallet = wallet;
    // Fetch initial nonce from network (pending state to account for mempool)
    if (this.wallet.provider) {
        this.nonce = await this.wallet.provider.getTransactionCount(this.wallet.address, 'pending');
    } else {
        this.nonce = await wallet.getNonce();
    }
    console.log(`[NonceManager] Initialized with nonce: ${this.nonce}`);
  }

  /**
   * Reset nonce from blockchain (used when nonce sync is lost)
   * Force syncs with 'pending' state
   */
  public async resync(): Promise<number> {
    if (!this.wallet || !this.wallet.provider) {
       throw new Error('NonceManager not initialized or missing provider');
    }
    
    const oldNonce = this.nonce;
    // Always fetch 'pending' to include mempool transactions
    this.nonce = await this.wallet.provider.getTransactionCount(this.wallet.address, 'pending');
    
    console.warn(`[NonceManager] ⚠️ Resync triggered. Nonce updated: ${oldNonce} -> ${this.nonce}`);
    return this.nonce;
  }
  public async getNonce(): Promise<number> {
    return new Promise((resolve, reject) => {
      const execute = () => {
        if (this.nonce === null) {
          reject(new Error('NonceManager not initialized'));
          return;
        }
        
        const currentNonce = this.nonce;
        this.nonce++;
        resolve(currentNonce);
      };

      // Simple queue mechanism for safety (though JS is single-threaded, 
      // this helps if we add async logic inside the critical section later)
      if (!this.mutex) {
        this.mutex = true;
        execute();
        this.mutex = false;
        this.processQueue();
      } else {
        this.queue.push(resolve as any);
      }
    });
  }

  /**
   * Reserve multiple nonces for a batch of transactions
   */
  public async getNonceBatch(count: number): Promise<number> {
    return new Promise((resolve, reject) => {
        if (this.nonce === null) {
            reject(new Error('NonceManager not initialized'));
            return;
        }

        const startNonce = this.nonce;
        this.nonce += count;
        resolve(startNonce);
    });
  }

  private processQueue() {
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) {
        // In a real mutex, we would execute next() here.
        // For this simple counter, we just rely on synchronous execution 
        // within the single JS thread.
      }
    }
  }
}
