/**
 * End-to-end swap tests — runs the actual CLI against mainnet.
 *
 * Prerequisites:
 *   - A wallet in ~/.nansen/wallets/ with ETH on Base and SOL on Solana
 *   - NANSEN_WALLET_PASSWORD env var set
 *
 * Run: npm run test:trade
 *
 * These tests execute REAL swaps with REAL funds. They are excluded
 * from the default test suite and must be run explicitly.
 *
 * Each round-trip swaps native → USDC → native so the only prerequisite
 * is having the gas token. Net cost is just gas + slippage.
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
      'trade', 'quote',
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
      'trade', 'execute',
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
      'trade', 'quote',
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
      'trade', 'execute',
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

const SOL_NATIVE = 'So11111111111111111111111111111111111111112';
const SOL_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SWAP_AMOUNT_SOL = '2000000'; // 0.002 SOL (~$0.17, 9 decimals)

describe.sequential('e2e: SOL ↔ USDC swap round-trip on Solana', () => {
  const state = {
    forwardQuoteId: null,
    forwardSignature: null,
    reverseQuoteId: null,
    reverseSignature: null,
    receivedUsdcAmount: null,
  };

  it('should have NANSEN_WALLET_PASSWORD set', () => {
    expect(
      process.env.NANSEN_WALLET_PASSWORD,
      'Set NANSEN_WALLET_PASSWORD to run e2e tests'
    ).toBeDefined();
  });

  it('should have a wallet with Solana address', () => {
    const result = runCli('wallet', 'list');
    const output = result.stdout + result.stderr;
    expect(output).toContain('Solana:');
  });

  it('quote SOL → USDC on Solana', () => {
    const result = runCli(
      'trade', 'quote',
      '--chain', 'solana',
      '--from', SOL_NATIVE,
      '--to', SOL_USDC,
      '--amount', SWAP_AMOUNT_SOL,
    );
    const output = result.stdout + result.stderr;

    const quoteMatch = output.match(/Quote ID:\s+(\S+)/);
    expect(quoteMatch, `Expected Quote ID in output:\n${output}`).toBeTruthy();
    state.forwardQuoteId = quoteMatch[1];
  });

  it('execute SOL → USDC swap', () => {
    expect(state.forwardQuoteId).toBeTruthy();

    const result = runCli(
      'trade', 'execute',
      '--quote', state.forwardQuoteId,
    );
    const output = result.stdout + result.stderr;

    expect(output).toContain('Transaction successful');

    // Solana tx signatures are base58 strings (typically 87-88 chars)
    const sigMatch = output.match(/Signature:\s+([1-9A-HJ-NP-Za-km-z]{43,})/);
    expect(sigMatch, `Expected Signature in output:\n${output}`).toBeTruthy();
    state.forwardSignature = sigMatch[1];
    console.log(`Forward swap: https://solscan.io/tx/${state.forwardSignature}`);

    // Extract received USDC amount for the reverse swap
    const swapMatch = output.match(/Output:\s+(\d+)\s+→/);
    expect(swapMatch, `Expected Output amount in output:\n${output}`).toBeTruthy();
    state.receivedUsdcAmount = swapMatch[1];
  });

  it('quote USDC → SOL on Solana (reverse)', () => {
    expect(state.receivedUsdcAmount, 'Forward swap must capture USDC amount').toBeTruthy();

    const result = runCli(
      'trade', 'quote',
      '--chain', 'solana',
      '--from', SOL_USDC,
      '--to', SOL_NATIVE,
      '--amount', state.receivedUsdcAmount,
    );
    const output = result.stdout + result.stderr;

    const quoteMatch = output.match(/Quote ID:\s+(\S+)/);
    expect(quoteMatch, `Expected Quote ID in output:\n${output}`).toBeTruthy();
    state.reverseQuoteId = quoteMatch[1];
  });

  it('execute USDC → SOL swap (reverse)', () => {
    expect(state.reverseQuoteId).toBeTruthy();

    const result = runCli(
      'trade', 'execute',
      '--quote', state.reverseQuoteId,
    );
    const output = result.stdout + result.stderr;

    expect(output).toContain('Transaction successful');

    const sigMatch = output.match(/Signature:\s+([1-9A-HJ-NP-Za-km-z]{43,})/);
    expect(sigMatch, `Expected Signature in output:\n${output}`).toBeTruthy();
    state.reverseSignature = sigMatch[1];
    console.log(`Reverse swap: https://solscan.io/tx/${state.reverseSignature}`);
  });
});
