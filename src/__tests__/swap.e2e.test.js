/**
 * End-to-end swap tests — runs the actual CLI against mainnet.
 *
 * Prerequisites:
 *   - A wallet in ~/.nansen/wallets/ with ETH on Base (for gas + swap)
 *   - NANSEN_WALLET_PASSWORD env var set
 *
 * Run: npm run test:swap
 *
 * These tests execute REAL swaps with REAL funds. They are excluded
 * from the default test suite and must be run explicitly.
 *
 * The round-trip swaps ETH → USDC → ETH so the only prerequisite is
 * having ETH (the gas token). Net cost is just gas + slippage.
 */

import { spawnSync } from 'child_process';
import { describe, it, expect } from 'vitest';
import path from 'path';

const CLI_PATH = path.resolve('src/index.js');

/**
 * Run the CLI and return { stdout, stderr, exitCode }.
 * Captures both stdout and stderr regardless of exit code.
 */
function runCli(...args) {
  const { stdout, stderr, status } = spawnSync('node', [CLI_PATH, ...args], {
    env: process.env,
    encoding: 'utf8',
    timeout: 120_000,
  });
  return { stdout: stdout || '', stderr: stderr || '', exitCode: status ?? 1 };
}

const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BASE_ETH = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const SWAP_AMOUNT_ETH = '270000000000000'; // ~$0.50 ETH (18 decimals)

describe.sequential('e2e: ETH ↔ USDC swap round-trip on Base', () => {
  const state = {
    forwardQuoteId: null,
    forwardTxHash: null,
    reverseQuoteId: null,
    reverseTxHash: null,
    receivedUsdcAmount: null,
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

  it('quote ETH → USDC on Base', () => {
    const result = runCli(
      'quote',
      '--chain', 'base',
      '--from', BASE_ETH,
      '--to', BASE_USDC,
      '--amount', SWAP_AMOUNT_ETH,
    );
    const output = result.stdout + result.stderr;

    const quoteMatch = output.match(/Quote ID:\s+(\S+)/);
    expect(quoteMatch, `Expected Quote ID in output:\n${output}`).toBeTruthy();
    state.forwardQuoteId = quoteMatch[1];
  });

  it('execute ETH → USDC swap', () => {
    expect(state.forwardQuoteId).toBeTruthy();

    const result = runCli(
      'execute',
      '--quote', state.forwardQuoteId,
    );
    const output = result.stdout + result.stderr;

    expect(output).toContain('Transaction successful');

    const txMatch = output.match(/Tx Hash:\s+(0x[a-fA-F0-9]+)/);
    expect(txMatch, `Expected Tx Hash in output:\n${output}`).toBeTruthy();
    state.forwardTxHash = txMatch[1];
    console.log(`Forward swap: https://basescan.org/tx/${state.forwardTxHash}`);

    // Extract received USDC amount for the reverse swap (format: "Output:       500000 → 0x8335...")
    const swapMatch = output.match(/Output:\s+(\d+)\s+→/);
    expect(swapMatch, `Expected Output amount in output:\n${output}`).toBeTruthy();
    state.receivedUsdcAmount = swapMatch[1];
  });

  it('quote USDC → ETH on Base (reverse)', () => {
    expect(state.receivedUsdcAmount, 'Forward swap must capture USDC amount').toBeTruthy();

    const result = runCli(
      'quote',
      '--chain', 'base',
      '--from', BASE_USDC,
      '--to', BASE_ETH,
      '--amount', state.receivedUsdcAmount,
    );
    const output = result.stdout + result.stderr;

    const quoteMatch = output.match(/Quote ID:\s+(\S+)/);
    expect(quoteMatch, `Expected Quote ID in output:\n${output}`).toBeTruthy();
    state.reverseQuoteId = quoteMatch[1];
  });

  it('execute USDC → ETH swap (reverse)', () => {
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
    console.log(`Reverse swap: https://basescan.org/tx/${state.reverseTxHash}`);
  });
});
