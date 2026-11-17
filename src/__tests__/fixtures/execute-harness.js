/**
 * Harness for `trade execute` tests with a remote signer (Privy or
 * WalletConnect): quote builders, a stub for every network call that records
 * what reaches the execute endpoint, and an `execute()` that returns the logs
 * and the error instead of throwing.
 */
import { beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { saveQuote as saveQuoteRaw, buildTradingCommands, evmTxHash } from '../../trading.js';
import { SIMULATION_RPCS } from '../../rpc-urls.js';
import { base58Decode, base58Encode } from '../../wallet.js';

export const BASE_ETH = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
export const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
export const OUT_TOKEN = '0x4200000000000000000000000000000000000006';
export const LIFI_ROUTER = '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae';
export const ATTACKER = '0x000000000000000000000000000000000000dead';
export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const SOL_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const APPROVE_SELECTOR = '0x095ea7b3';

/** Calldata approving an unlimited amount to ATTACKER. */
export const UNLIMITED_APPROVAL_TO_ATTACKER = APPROVE_SELECTOR + ATTACKER.slice(2).padStart(64, '0') + 'f'.repeat(64);

const screenApi = {
  baseUrl: 'https://api.nansen.ai',
  selection: { kind: 'anonymous' },
  requestCredentials: async () => ({}),
  request: async (endpoint, body) => {
    if (endpoint.startsWith('/api/v1/sanctions/screen')) {
      return { results: (body?.addresses || []).map(address => ({ address, sanctioned: false })) };
    }
    throw new Error(`unexpected endpoint ${endpoint}`);
  },
};

export function saveQuote(resp, ...rest) {
  return saveQuoteRaw({ ...resp, metadata: { quoteId: 'backend-quote-id' } }, ...rest);
}

export function evmIntent(walletAddress, { fromToken = BASE_ETH, toToken = BASE_USDC, amount = '1000000000000000000' } = {}) {
  return {
    chain: 'base', toChain: null, walletAddress, recipient: null,
    fromToken, toToken, swapMode: 'exactIn', amount, maxInputAmount: amount,
  };
}

export function solIntent(walletAddress) {
  return {
    chain: 'solana', toChain: null, walletAddress, recipient: null,
    fromToken: SOL_MINT, toToken: SOL_USDC, swapMode: 'exactIn', amount: '1000000000', maxInputAmount: '1000000000',
  };
}

export const nativeSwapQuote = () => ({
  success: true,
  quotes: [{
    aggregator: 'lifi', inputMint: BASE_ETH, outputMint: BASE_USDC,
    inAmount: '1000000000000000000', outAmount: '3000000000',
    transaction: { to: LIFI_ROUTER, data: '0x12345678', value: '1000000000000000000', gas: '210000', maxFeePerGas: '6600000', maxPriorityFeePerGas: '1100000' },
  }],
});

export const erc20SwapQuote = () => ({
  success: true,
  quotes: [{
    aggregator: 'lifi', inputMint: BASE_USDC, outputMint: OUT_TOKEN,
    inAmount: '1000000', outAmount: '990000', inputAmount: '1000000',
    approvalAddress: LIFI_ROUTER,
    transaction: { to: LIFI_ROUTER, data: '0x12345678', value: '0', gas: '210000', maxFeePerGas: '1000000', maxPriorityFeePerGas: '1000000' },
  }],
});

/** Unsigned one-signer Solana transaction; fee payer = wallet. */
export function unsignedSolanaTx(walletAddress, blockhashByte = 3) {
  const message = Buffer.concat([
    Buffer.from([1, 0, 1, 2]),
    base58Decode(walletAddress),
    Buffer.alloc(32, 2),
    Buffer.alloc(32, blockhashByte),
    Buffer.from([1, 1, 1, 0, 1, 0]),
  ]);
  return Buffer.concat([Buffer.from([1]), Buffer.alloc(64), message]).toString('base64');
}

export const solanaQuote = (tx) => ({
  success: true,
  quotes: [{ aggregator: 'jupiter', inputMint: SOL_MINT, outputMint: SOL_USDC, inAmount: '1000000000', outAmount: '50000000', transaction: tx }],
});

/**
 * Register beforeEach/afterEach hooks that give each test its own HOME, the
 * legacy execute route, test Privy credentials and no simulation RPCs.
 */
export function useExecuteEnv() {
  let tempDir; let originalHome; let origSim;
  beforeEach(() => {
    originalHome = process.env.HOME;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nansen-remote-signer-'));
    process.env.HOME = tempDir;
    process.env.NANSEN_TRADING_EXECUTION_ROUTE = 'legacy';
    process.env.PRIVY_APP_ID = 'test-app-id';
    process.env.PRIVY_APP_SECRET = 'test-secret';
    delete process.env.NANSEN_WALLET_PASSWORD;
    origSim = { solana: SIMULATION_RPCS.solana, base: SIMULATION_RPCS.base };
    SIMULATION_RPCS.solana = null;
    SIMULATION_RPCS.base = null;
  });
  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(tempDir, { recursive: true, force: true });
    delete process.env.NANSEN_TRADING_EXECUTION_ROUTE;
    delete process.env.PRIVY_APP_ID;
    delete process.env.PRIVY_APP_SECRET;
    SIMULATION_RPCS.solana = origSim.solana;
    SIMULATION_RPCS.base = origSim.base;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
}

/**
 * Stub every network call. `privySign(body)` answers Privy's sign request;
 * every POST to the execute endpoint is recorded in the returned array.
 */
export function stubNetwork({ privyAddress, privySign } = {}) {
  const executeBodies = [];
  let allowance = 0n;
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url, opts) => {
    const u = String(url);
    const isPrivy = URL.canParse(u) && new URL(u).hostname === 'api.privy.io';
    let body = {};
    try { body = typeof opts?.body === 'string' ? JSON.parse(opts.body) : {}; } catch { /* not JSON */ }
    if (isPrivy && opts?.method === 'GET') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ id: 'w', address: privyAddress }) });
    }
    if (isPrivy && opts?.method === 'POST') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: { signed_transaction: privySign(body) } }) });
    }
    if (u.includes('trading-api')) {
      executeBodies.push(body);
      const signed = String(body.signedTransaction);
      if (signed.startsWith('0x')) {
        // An approval that lands raises the allowance the CLI re-reads.
        if (body.signedTransaction && executeBodies.length === 1 && signed.includes(APPROVE_SELECTOR.slice(2))) allowance = 10n ** 30n;
        return Promise.resolve({ ok: true, text: () => Promise.resolve(JSON.stringify({ status: 'Success', txHash: evmTxHash(signed), chainType: 'evm', broadcaster: 't' })) });
      }
      const sig = base58Encode(Buffer.from(signed, 'base64').subarray(1, 65));
      return Promise.resolve({ ok: true, text: () => Promise.resolve(JSON.stringify({ status: 'Success', signature: sig, chainType: 'solana', broadcaster: 't' })) });
    }
    const r = (result) => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result })), json: () => Promise.resolve({ jsonrpc: '2.0', id: body.id, result }) });
    switch (body.method) {
      case 'eth_getTransactionCount': return r('0x5');
      case 'eth_getCode': return r('0x6080604052');
      case 'eth_call': return r('0x' + allowance.toString(16).padStart(64, '0'));
      case 'eth_getTransactionReceipt': return r({ status: '0x1', blockNumber: '0x100' });
      case 'getSignatureStatuses': return r({ context: { slot: 1 }, value: [{ slot: 1, confirmations: 1, err: null, confirmationStatus: 'confirmed' }] });
      case 'getBalance': return r({ context: { slot: 1 }, value: 10_000_000_000 });
      default: return r(null);
    }
  }));
  return executeBodies;
}

/** Run `trade execute --quote <quoteId>`; returns the logs and the error, if any. */
export async function execute(quoteId) {
  const logs = [];
  const cmds = buildTradingCommands({ log: (m) => logs.push(m), exit: () => {} });
  let err = null;
  try { await cmds.execute([], screenApi, {}, { quote: quoteId }); } catch (e) { err = e; }
  return { logs, err };
}
