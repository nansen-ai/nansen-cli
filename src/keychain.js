/**
 * OS Keychain integration for wallet password storage.
 * No native dependencies — shells out to platform CLIs.
 *
 * Platform support:
 *   macOS:  `security` (always available)
 *   Linux:  `secret-tool` (only if binary present and session bus accessible)
 *   Other:  not supported
 */

import { execFileSync } from 'child_process';
import os from 'os';

const SERVICE = 'nansen-cli';
const ACCOUNT = 'wallet-password';

const STDIO_SILENT = ['pipe', 'pipe', 'pipe'];

/**
 * Synchronous probe: is a usable OS keychain available?
 */
export function keychainAvailable() {
  const platform = os.platform();
  if (platform === 'darwin') return true;
  if (platform === 'linux') {
    try {
      execFileSync('which', ['secret-tool'], { encoding: 'utf8', stdio: STDIO_SILENT });
      return true;
    } catch (_e) {
      return false;
    }
  }
  return false;
}

/**
 * Store password in OS keychain.
 * Returns: { backend: 'keychain-macos' | 'keychain-linux' }
 * Throws on failure.
 */
export async function keychainStore(password) {
  const platform = os.platform();
  if (platform === 'darwin') {
    execFileSync('security', [
      'add-generic-password',
      '-U',              // update if exists
      '-s', SERVICE,
      '-a', ACCOUNT,
      '-w', password,
    ], { encoding: 'utf8', stdio: STDIO_SILENT });
    return { backend: 'keychain-macos' };
  }
  if (platform === 'linux') {
    execFileSync('secret-tool', [
      'store',
      '--label', SERVICE,
      'service', SERVICE,
      'account', ACCOUNT,
    ], { encoding: 'utf8', stdio: STDIO_SILENT, input: password });
    return { backend: 'keychain-linux' };
  }
  throw new Error(`Keychain not supported on ${platform}`);
}

/**
 * Retrieve password from OS keychain.
 * Returns: string (password) or null if not found.
 */
export async function keychainGet() {
  const platform = os.platform();
  try {
    if (platform === 'darwin') {
      const result = execFileSync('security', [
        'find-generic-password',
        '-s', SERVICE,
        '-a', ACCOUNT,
        '-w',
      ], { encoding: 'utf8', stdio: STDIO_SILENT });
      return result.trim();
    }
    if (platform === 'linux') {
      const result = execFileSync('secret-tool', [
        'lookup',
        'service', SERVICE,
        'account', ACCOUNT,
      ], { encoding: 'utf8', stdio: STDIO_SILENT });
      return result.trim();
    }
  } catch (_e) {
    return null;
  }
  return null;
}

/**
 * Best-effort delete. Never throws.
 */
export async function keychainDelete() {
  const platform = os.platform();
  try {
    if (platform === 'darwin') {
      execFileSync('security', [
        'delete-generic-password',
        '-s', SERVICE,
        '-a', ACCOUNT,
      ], { encoding: 'utf8', stdio: STDIO_SILENT });
    } else if (platform === 'linux') {
      execFileSync('secret-tool', [
        'clear',
        'service', SERVICE,
        'account', ACCOUNT,
      ], { encoding: 'utf8', stdio: STDIO_SILENT });
    }
  } catch (_e) {
    // intentional: best-effort delete, never throws
  }
}
