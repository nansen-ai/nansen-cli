/**
 * Shared subprocess helper for WalletConnect CLI calls.
 *
 * Used by walletconnect-x402.js and walletconnect-trading.js.
 */

import { execFile } from 'child_process';

/**
 * Execute a walletconnect CLI command and return stdout.
 */
export function wcExec(cmd, args, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout, _stderr) => {
      if (err) {
        reject(new Error(err.message));
        return;
      }
      resolve(stdout.trim());
    });
  });
}
