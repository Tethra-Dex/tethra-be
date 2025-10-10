import { ethers } from 'ethers';
import { Logger } from '../utils/Logger';

/**
 * PriceSignerService
 * 
 * Signs price data for trading on Tethra DEX
 * - Uses ECDSA signature (off-chain, no gas needed!)
 * - Only authorized Price Signer wallet can sign
 * - Signatures verified on-chain by MarketExecutor
 */
export class PriceSignerService {
  private logger: Logger;
  private signer: ethers.Wallet | null = null;
  private signerAddress: string = '';

  constructor() {
    this.logger = new Logger('PriceSignerService');
    this.initializeSync();
  }

  /**
   * Synchronous initialization (called in constructor)
   */
  private initializeSync(): void {
    try {
      const privateKey = process.env.PRICE_SIGNER_PRIVATE_KEY;
      
      if (!privateKey || privateKey === '0xYOUR_PRIVATE_KEY_HERE') {
        this.logger.warn('⚠️  PRICE_SIGNER_PRIVATE_KEY not configured');
        return;
      }

      // Create wallet from private key (no provider needed for signing!)
      this.signer = new ethers.Wallet(privateKey);
      this.signerAddress = this.signer.address;

      this.logger.success('✅ Price Signer initialized');
      this.logger.info(`📝 Signer Address: ${this.signerAddress}`);
      this.logger.info('💡 Note: No gas needed - signing is off-chain!');

      // Verify it matches expected address
      const expectedAddress = process.env.PRICE_SIGNER_ADDRESS;
      if (expectedAddress && expectedAddress.toLowerCase() !== this.signerAddress.toLowerCase()) {
        this.logger.warn(`⚠️  Warning: Signer address ${this.signerAddress} doesn't match expected ${expectedAddress}`);
      }

    } catch (error) {
      this.logger.error('Failed to initialize Price Signer:', error);
      this.signer = null;
      this.signerAddress = '';
    }
  }

  /**
   * Initialize the Price Signer with private key
   */
  async initialize(): Promise<void> {
    try {
      const privateKey = process.env.PRICE_SIGNER_PRIVATE_KEY;
      
      if (!privateKey) {
        throw new Error('PRICE_SIGNER_PRIVATE_KEY not set in environment');
      }

      // Create wallet from private key (no provider needed for signing!)
      this.signer = new ethers.Wallet(privateKey);
      this.signerAddress = this.signer.address;

      this.logger.success('✅ Price Signer initialized');
      this.logger.info(`📝 Signer Address: ${this.signerAddress}`);
      this.logger.info('💡 Note: No gas needed - signing is off-chain!');

      // Verify it matches expected address
      const expectedAddress = process.env.PRICE_SIGNER_ADDRESS;
      if (expectedAddress && expectedAddress.toLowerCase() !== this.signerAddress.toLowerCase()) {
        this.logger.warn(`⚠️  Warning: Signer address ${this.signerAddress} doesn't match expected ${expectedAddress}`);
      }

    } catch (error) {
      this.logger.error('Failed to initialize Price Signer:', error);
      throw error;
    }
  }

  /**
   * Sign price data for trading
   * 
   * @param asset - Asset symbol (e.g., "BTC", "ETH")
   * @param price - Price in 8 decimals (e.g., 4500000000000 for $45,000)
   * @param timestamp - Unix timestamp in seconds
   * @returns Signature object with all required data
   */
  async signPrice(
    asset: string,
    price: string | bigint,
    timestamp: number
  ): Promise<{
    asset: string;
    assetId: string;
    price: string;
    timestamp: number;
    signature: string;
    signer: string;
  }> {
    if (!this.signer) {
      throw new Error('Price Signer not initialized');
    }

    try {
      // 1. Create asset ID (keccak256 hash of asset name) - for reference only
      const assetId = ethers.id(asset);

      // 2. Convert price to BigInt if it's a string
      const priceBigInt = typeof price === 'string' ? BigInt(price) : price;

      // 3. Create message hash (MUST MATCH SMART CONTRACT FORMAT!)
      // Contract uses: keccak256(abi.encodePacked(symbol, price, timestamp))
      // Where symbol is STRING, not bytes32!
      const messageHash = ethers.solidityPackedKeccak256(
        ['string', 'uint256', 'uint256'],
        [asset, priceBigInt, timestamp]
      );

      // 4. Sign the message hash (off-chain, no gas!)
      const signature = await this.signer.signMessage(ethers.getBytes(messageHash));

      this.logger.debug(`Signed price for ${asset}: $${Number(priceBigInt) / 1e8}`);

      return {
        asset,
        assetId,
        price: priceBigInt.toString(),
        timestamp,
        signature,
        signer: this.signerAddress
      };

    } catch (error) {
      this.logger.error(`Failed to sign price for ${asset}:`, error);
      throw error;
    }
  }

  /**
   * Verify a signature (for testing purposes)
   */
  verifySignature(
    symbol: string,
    price: string | bigint,
    timestamp: number,
    signature: string
  ): string {
    try {
      const priceBigInt = typeof price === 'string' ? BigInt(price) : price;

      // Recreate the message hash (MUST MATCH SMART CONTRACT!)
      const messageHash = ethers.solidityPackedKeccak256(
        ['string', 'uint256', 'uint256'],
        [symbol, priceBigInt, timestamp]
      );

      // Recover signer address from signature
      const recoveredAddress = ethers.verifyMessage(
        ethers.getBytes(messageHash),
        signature
      );

      return recoveredAddress;

    } catch (error) {
      this.logger.error('Failed to verify signature:', error);
      throw error;
    }
  }

  /**
   * Get signer address
   */
  getSignerAddress(): string {
    return this.signerAddress;
  }

  /**
   * Check if signer is initialized
   */
  isInitialized(): boolean {
    return this.signer !== null;
  }

  /**
   * Get service status
   */
  getStatus() {
    return {
      initialized: this.isInitialized(),
      signerAddress: this.signerAddress,
      timestamp: Date.now()
    };
  }
}
