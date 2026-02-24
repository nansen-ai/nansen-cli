/**
 * End-to-end swap tests — runs the actual CLI against mainnet.
 *
 * Prerequisites:
 *   - A wallet in ~/.nansen/wallets/ with funds on Base
 *   - NANSEN_WALLET_PASSWORD env var set
 *
 * Run: npm run test:e2e
 *
 * These tests execute REAL swaps with REAL funds. They are excluded
 * from the default test suite and must be run explicitly.
 */

import { execFileSync } from 'child_process';
import { describe, it, expect } from 'vitest';
import path from 'path';

// ============= Helpers =============

const CLI_PATH = path.resolve('src/index.js');

/**
 * Run the nansen CLI and return { stdout, stderr }.
 * Throws on non-zero exit with stderr attached.
 */
function nansen(...args) {
  try {
    const stdout = execFileSync('node', [CLI_PATH, ...args], {
      env: process.env,
      encoding: 'utf8',
      timeout: 120_000,
    });
    return { stdout, stderr: '' };
  } catch (err) {
    // execFileSync attaches stdout/stderr on failure
    if (err.status !== null) {
      const stderr = err.stderr?.toString() || '';
      const stdout = err.stdout?.toString() || '';
      throw new Error(
        `CLI exited with code ${err.status}\nstderr: ${stderr}\nstdout: ${stdout}`
      );
    }
    throw err;
  }
}

/**
 * Run the nansen CLI, capturing stderr (where output goes).
 * Returns stderr as a string. Throws on non-zero exit.
 */
function nansenStderr(...args) {
  try {
    execFileSync('node', [CLI_PATH, ...args], {
      env: process.env,
      encoding: 'utf8',
      timeout: 120_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    if (err.status === 0 || err.status === null) {
      // Node execFileSync sometimes throws even on success when capturing stderr
      return err.stderr?.toString() || '';
    }
    // For real failures: some commands exit 0 with output on stderr,
    // others exit non-zero. Check if we got useful output anyway.
    if (err.stderr) return err.stderr.toString();
    throw err;
  }
  return '';
}

/**
 * Run CLI and capture stderr properly (the CLI writes output to stderr).
 */
function runCli(...args) {
  const result = { stdout: '', stderr: '', exitCode: 0 };
  try {
    result.stdout = execFileSync('node', [CLI_PATH, ...args], {
      env: process.env,
      encoding: 'utf8',
      timeout: 120_000,
    });
  } catch (err) {
    result.exitCode = err.status ?? 1;
    result.stdout = err.stdout?.toString() || '';
    result.stderr = err.stderr?.toString() || '';
  }
  return result;
}

/** Convert human USDC amount to base units (6 decimals). */
function usdc(amount) {
  return String(Math.round(amount * 1e6));
}

// ============= Constants =============

const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BASE_ETH = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

// ============= Tests =============

describe.sequential('e2e: USDC ↔ ETH swap round-trip on Base', () => {
  // Shared state between sequential tests
  const state = {
    forwardQuoteId: null,
    forwardTxHash: null,
    reverseQuoteId: null,
    reverseTxHash: null,
    receivedEthAmount: null,
  };

  it('should have NANSEN_WALLET_PASSWORD set', () => {
    expect(
      process.env.NANSEN_WALLET_PASSWORD,
      'Set NANSEN_WALLET_PASSWORD to run e2e tests'
    ).toBeDefined();
  });

  it('should have a wallet configured', () => {
    const result = runCli('wallet', 'list');
    const output = result.stdout + result.stderr;
    expect(output).toContain('EVM:');
  });

  it('quote USDC → ETH on Base', () => {
    const result = runCli(
      'quote',
      '--chain', 'base',
      '--from', BASE_USDC,
      '--to', BASE_ETH,
      '--amount', usdc(2),
    );
    const output = result.stdout + result.stderr;

    // Extract quote ID from stderr output
    const quoteMatch = output.match(/Quote ID:\s+(\S+)/);
    expect(quoteMatch, `Expected Quote ID in output:\n${output}`).toBeTruthy();
    state.forwardQuoteId = quoteMatch[1];
  });

  it('execute USDC → ETH swap', () => {
    expect(state.forwardQuoteId).toBeTruthy();

    const result = runCli(
      'execute',
      '--quote', state.forwardQuoteId,
    );
    const output = result.stdout + result.stderr;

    // Verify transaction success
    expect(output).toContain('Transaction successful');

    // Extract tx hash
    const txMatch = output.match(/Tx Hash:\s+(0x[a-fA-F0-9]+)/);
    expect(txMatch, `Expected Tx Hash in output:\n${output}`).toBeTruthy();
    state.forwardTxHash = txMatch[1];

    // Try to extract received ETH amount for the reverse swap
    // Swap events show: inputAmount inputMint → outputAmount outputMint
    const swapMatch = output.match(/→\s+(\d+)\s/);
    if (swapMatch) {
      state.receivedEthAmount = swapMatch[1];
    }
  });

  it('quote ETH → USDC on Base (reverse)', () => {
    // Use received ETH amount if available, otherwise a small fixed amount
    const ethAmount = state.receivedEthAmount || '500000000000000'; // 0.0005 ETH fallback

    const result = runCli(
      'quote',
      '--chain', 'base',
      '--from', BASE_ETH,
      '--to', BASE_USDC,
      '--amount', ethAmount,
    );
    const output = result.stdout + result.stderr;

    const quoteMatch = output.match(/Quote ID:\s+(\S+)/);
    expect(quoteMatch, `Expected Quote ID in output:\n${output}`).toBeTruthy();
    state.reverseQuoteId = quoteMatch[1];
  });

  it('execute ETH → USDC swap (reverse)', () => {
    expect(state.reverseQuoteId).toBeTruthy();

    const result = runCli(
      'execute',
      '--quote', state.reverseQuoteId,
    );
    const output = result.stdout + result.stderr;

    expect(output).toContain('Transaction successful');

    const txMatch = output.match(/Tx Hash:\s+(0x[a-fA-F0-9]+)/);
    expect(txMatch, `Expected Tx Hash in output:\n${output}`).toBeTruthy();
    state.reverseTxHash = txMatch[1];
  });
});
