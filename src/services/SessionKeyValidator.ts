import { ethers } from 'ethers';
import { Logger } from '../utils/Logger';

/**
 * Session Key Validator
 *
 * Validates session key signatures for tap-to-trade orders.
 * Session keys allow users to sign once and trade multiple times without popups.
 */
export class SessionKeyValidator {
  private logger: Logger;

  constructor() {
    this.logger = new Logger('SessionKeyValidator');
  }

  /**
   * Validate a tap-to-trade order with session key
   */
  validateOrderWithSession(params: {
    // Order details
    trader: string;
    symbol: string;
    isLong: boolean;
    collateral: string;
    leverage: number;
    nonce: string;
    signature: string;
    marketExecutor: string;

    // Session key
    sessionKey: {
      address: string;
      expiresAt: number;
      authorizedBy: string;
      authSignature: string;
    };
  }): { valid: boolean; error?: string } {
    try {
      const { trader, symbol, isLong, collateral, leverage, nonce, signature, marketExecutor, sessionKey } = params;

      // 1. Check if session expired
      const now = Date.now();
      if (sessionKey.expiresAt <= now) {
        return { valid: false, error: 'Session expired' };
      }

      // 2. Verify authorizedBy matches trader
      if (sessionKey.authorizedBy.toLowerCase() !== trader.toLowerCase()) {
        return { valid: false, error: 'Session not authorized by trader' };
      }

      // 3. Verify session authorization signature
      const expiresAtSeconds = Math.floor(sessionKey.expiresAt / 1000);
      const authMessage = `Authorize session key ${sessionKey.address} for Tethra Tap-to-Trade until ${expiresAtSeconds}`;
      const authMessageHash = ethers.keccak256(ethers.toUtf8Bytes(authMessage));

      const recoveredAuthSigner = ethers.verifyMessage(
        ethers.getBytes(authMessageHash),
        sessionKey.authSignature
      );

      if (recoveredAuthSigner.toLowerCase() !== trader.toLowerCase()) {
        this.logger.error('Session auth signature invalid', {
          expected: trader,
          recovered: recoveredAuthSigner,
          authMessage,
        });
        return { valid: false, error: 'Invalid session authorization signature' };
      }

      // 4. Verify order signature was created by session key
      const messageHash = ethers.solidityPackedKeccak256(
        ['address', 'string', 'bool', 'uint256', 'uint256', 'uint256', 'address'],
        [trader, symbol, isLong, collateral, leverage, nonce, marketExecutor]
      );

      const recoveredSigner = ethers.verifyMessage(ethers.getBytes(messageHash), signature);

      if (recoveredSigner.toLowerCase() !== sessionKey.address.toLowerCase()) {
        this.logger.error('Order signature not from session key', {
          expected: sessionKey.address,
          recovered: recoveredSigner,
        });
        return { valid: false, error: 'Order signature not from session key' };
      }

      this.logger.info('✅ Session key validation successful', {
        trader,
        sessionKey: sessionKey.address,
        expiresIn: Math.round((sessionKey.expiresAt - now) / 1000 / 60) + ' minutes',
      });

      return { valid: true };
    } catch (err: any) {
      this.logger.error('Session validation error:', err);
      return { valid: false, error: err.message || 'Session validation failed' };
    }
  }

  /**
   * Validate a traditional order (without session key)
   * This ensures backward compatibility with non-session orders
   */
  validateOrderWithoutSession(params: {
    trader: string;
    symbol: string;
    isLong: boolean;
    collateral: string;
    leverage: number;
    nonce: string;
    signature: string;
    marketExecutor: string;
  }): { valid: boolean; error?: string } {
    try {
      const { trader, symbol, isLong, collateral, leverage, nonce, signature, marketExecutor } = params;

      // Verify signature was created by trader
      const messageHash = ethers.solidityPackedKeccak256(
        ['address', 'string', 'bool', 'uint256', 'uint256', 'uint256', 'address'],
        [trader, symbol, isLong, collateral, leverage, nonce, marketExecutor]
      );

      const recoveredSigner = ethers.verifyMessage(ethers.getBytes(messageHash), signature);

      if (recoveredSigner.toLowerCase() !== trader.toLowerCase()) {
        this.logger.error('Order signature invalid', {
          expected: trader,
          recovered: recoveredSigner,
        });
        return { valid: false, error: 'Invalid order signature' };
      }

      this.logger.info('✅ Traditional order validation successful', { trader });

      return { valid: true };
    } catch (err: any) {
      this.logger.error('Order validation error:', err);
      return { valid: false, error: err.message || 'Order validation failed' };
    }
  }
}
