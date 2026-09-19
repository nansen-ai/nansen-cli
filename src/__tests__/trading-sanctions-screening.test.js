/**
 * `nansen trade quote` / `nansen trade execute` compliance gate.
 *
 * Both commands talk to the trading backend directly, so the client-side screen
 * (the same `screenOrThrow` that `bridge` and `perp` use) is the only pre-trade
 * sanctions check on this path. These tests pin the contract mirrored from
 * bridge-quote.test.js: the signing wallet (plus any distinct destination
 * wallet) is screened BEFORE a quote is requested or anything is signed, a
 * flagged address aborts with an actionable error and no transaction goes out,
 * and a screening call that fails aborts too (fail closed). Every network call
 * is mocked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildTradingCommands, saveQuote, evmTxHash, getQuotesDir, tradeScreeningAddresses } from '../trading.js';
import { createWallet, showWallet } from '../wallet.js';
import * as wcTrading from '../walletconnect-trading.js';

const BASE_ETH = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const LIFI_ROUTER = '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae';
// Destination wallet for cross-chain cases (a Solana address, as `--to-chain
// solana` would take).
const SOL_DEST = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';

let originalHome;
let tempDir;

beforeEach(() => {
  originalHome = process.env.HOME;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nansen-trade-screen-'));
  process.env.HOME = tempDir;
});

afterEach(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tempDir, { recursive: true, force: true });
  delete process.env.NANSEN_WALLET_PASSWORD;
  delete process.env.PRIVY_APP_ID;
  delete process.env.PRIVY_APP_SECRET;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// API double: `screen` decides the verdict; every screen call is appended to
// `events` so ordering against the trading backend can be asserted.
function mockApi(screen, events = []) {
  return {
    request: async (endpoint, body) => {
      if (endpoint.startsWith('/api/v1/sanctions/screen')) {
        events.push({ kind: 'screen', addresses: body.addresses });
        return screen(body);
      }
      throw new Error(`unexpected endpoint ${endpoint}`);
    },
  };
}
const clean = (body) => ({ results: body.addresses.map(address => ({ address, sanctioned: false })) });
const flagged = (hit) => (body) => ({
  results: body.addresses.map(address => ({ address, sanctioned: address === hit })),
});

const lower = (addresses) => addresses.map(a => String(a).toLowerCase());

function quoteFilesOnDisk() {
  return fs.existsSync(getQuotesDir()) ? fs.readdirSync(getQuotesDir()) : [];
}

function setupLocalWallet() {
  createWallet('default', 'testpass');
  process.env.NANSEN_WALLET_PASSWORD = 'testpass';
  return showWallet('default').evm;
}

const cmds = () => buildTradingCommands({ log: () => {}, exit: () => {} });

describe('tradeScreeningAddresses', () => {
  it('drops blanks and de-duplicates EVM addresses case-insensitively, keeping the first spelling', () => {
    expect(tradeScreeningAddresses(
      '0x8CB9c3F23C7d600fB430bbd171a313D9ea61cEBc',
      null,
      undefined,
      '',
      '0x8cb9c3f23c7d600fb430bbd171a313d9ea61cebc',
    )).toEqual(['0x8CB9c3F23C7d600fB430bbd171a313D9ea61cEBc']);
  });

  it('keeps base58 addresses distinct by exact spelling (Solana addresses are case-sensitive)', () => {
    expect(tradeScreeningAddresses(SOL_DEST, SOL_DEST, SOL_DEST.toLowerCase())).toEqual([
      SOL_DEST,
      SOL_DEST.toLowerCase(),
    ]);
  });

  it('keeps a distinct destination alongside the signer', () => {
    expect(tradeScreeningAddresses(BASE_USDC, SOL_DEST)).toEqual([BASE_USDC, SOL_DEST]);
  });
});

describe('trade quote compliance gate', () => {
  // The quote backend is stubbed to return "no quotes" so each run stops right
  // after the request goes out, having proven the screen ran first.
  function stubQuoteBackend(events) {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('trading-api') && urlStr.includes('/quote')) {
        events.push({ kind: 'quote', url: urlStr });
        return Promise.resolve({ ok: true, text: () => Promise.resolve(JSON.stringify({ success: false, quotes: [] })) });
      }
      return Promise.reject(new Error(`unexpected network call ${urlStr}`));
    }));
  }

  const sameChain = { chain: 'base', from: 'ETH', to: 'USDC', amount: '1000000000000000000', wallet: 'default' };
  const crossChain = {
    chain: 'base', 'to-chain': 'solana', from: 'USDC', to: 'USDC', amount: '1000000',
    wallet: 'default', 'to-wallet': SOL_DEST,
  };

  it('screens the signing wallet before requesting a quote', async () => {
    const wallet = setupLocalWallet();
    const events = [];
    stubQuoteBackend(events);
    const api = mockApi(clean, events);

    await expect(cmds().quote([], api, {}, sameChain)).rejects.toThrow(/No quotes available/);

    expect(events.map(e => e.kind)).toEqual(['screen', 'quote']);
    expect(lower(events[0].addresses)).toEqual(lower([wallet]));
  });

  it('screens the --to-wallet destination of a cross-chain swap alongside the signer', async () => {
    const wallet = setupLocalWallet();
    const events = [];
    stubQuoteBackend(events);
    const api = mockApi(clean, events);

    await expect(cmds().quote([], api, {}, crossChain)).rejects.toThrow(/No quotes available/);

    expect(events.map(e => e.kind)).toEqual(['screen', 'quote']);
    expect(events[0].addresses).toHaveLength(2);
    expect(lower(events[0].addresses)).toEqual(lower([wallet, SOL_DEST]));
  });

  it('refuses a flagged wallet with an actionable error and never requests a quote', async () => {
    const wallet = setupLocalWallet();
    const events = [];
    stubQuoteBackend(events);
    const api = mockApi(flagged(wallet), events);

    await expect(cmds().quote([], api, {}, sameChain)).rejects.toMatchObject({
      code: 'SANCTIONED',
      message: expect.stringMatching(/compliance blocklist/),
    });

    expect(events.map(e => e.kind)).toEqual(['screen']);
    expect(fetch).not.toHaveBeenCalled();
    expect(quoteFilesOnDisk()).toEqual([]);
  });

  it('refuses a flagged destination wallet on a cross-chain swap', async () => {
    setupLocalWallet();
    const events = [];
    stubQuoteBackend(events);
    const api = mockApi(flagged(SOL_DEST), events);

    await expect(cmds().quote([], api, {}, crossChain)).rejects.toThrow(new RegExp(`compliance blocklist.*${SOL_DEST}`));

    expect(fetch).not.toHaveBeenCalled();
    expect(quoteFilesOnDisk()).toEqual([]);
  });

  it('fails closed when screening is unavailable', async () => {
    setupLocalWallet();
    const events = [];
    stubQuoteBackend(events);
    const api = mockApi(() => { throw new Error('503 snapshot unavailable'); }, events);

    await expect(cmds().quote([], api, {}, sameChain)).rejects.toMatchObject({
      code: 'SCREENING_UNAVAILABLE',
      message: expect.stringMatching(/screening is unavailable/),
    });

    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails closed when the screening response omits the wallet (unverifiable)', async () => {
    setupLocalWallet();
    const events = [];
    stubQuoteBackend(events);
    const api = mockApi(() => ({ results: [] }), events);

    await expect(cmds().quote([], api, {}, sameChain)).rejects.toThrow(/did not cover all addresses/);

    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('trade execute compliance gate', () => {
  function evmIntent({ walletAddress, toChain = null, recipient = null }) {
    return {
      chain: 'base',
      toChain,
      walletAddress,
      recipient,
      fromToken: BASE_ETH,
      toToken: BASE_USDC,
      swapMode: 'exactIn',
      amount: '1000000000000000000',
      maxInputAmount: '1000000000000000000',
    };
  }

  function saveEvmQuote({ walletAddress, signerType = 'local', privyWalletIds = null, toChain = null, recipient = null, request } = {}) {
    return saveQuote({
      success: true,
      quotes: [{
        aggregator: 'lifi',
        inputMint: BASE_ETH,
        outputMint: BASE_USDC,
        inAmount: '1000000000000000000',
        outAmount: '3000000000',
        transaction: {
          to: LIFI_ROUTER,
          data: '0x12345678',
          value: '1000000000000000000',
          gas: '210000',
          maxFeePerGas: '1000000',
          maxPriorityFeePerGas: '1000000',
        },
      }],
    }, 'base', signerType, privyWalletIds, toChain, {
      swapMode: 'exactIn',
      request: request === undefined ? evmIntent({ walletAddress, toChain, recipient }) : request,
    });
  }

  // RPC + trading backend double for the local EVM path. `/execute` calls are
  // appended to `events` so the screen can be proven to come first.
  function stubEvmBackend(events) {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url, opts) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      const body = opts?.body ? JSON.parse(opts.body) : {};

      if (urlStr.includes('trading-api') && urlStr.endsWith('/execute')) {
        events.push({ kind: 'execute' });
        const txHash = evmTxHash(body.signedTransaction);
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve(JSON.stringify({ status: 'Success', chainType: 'evm', broadcaster: 'test', txHash })),
        });
      }
      if (body.method === 'eth_getCode') {
        return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x6080604052' })) });
      }
      if (body.method === 'eth_getTransactionCount') {
        return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x5' })) });
      }
      if (body.method === 'eth_getTransactionReceipt') {
        return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { status: '0x1', blockNumber: '0x100' } })) });
      }
      return Promise.resolve({ ok: true, text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id || 1, result: null })) });
    }));
  }

  const flags = { 'no-simulate': true, 'no-verify-outcome': true };

  function quoteFile(quoteId) {
    return JSON.parse(fs.readFileSync(path.join(getQuotesDir(), `${quoteId}.json`), 'utf8'));
  }

  const broadcastAttempted = () =>
    fetch.mock.calls.some(([url]) => (typeof url === 'string' ? url : url.toString()).endsWith('/execute'));

  it('screens the signing wallet before broadcasting', async () => {
    const wallet = setupLocalWallet();
    const events = [];
    stubEvmBackend(events);
    const api = mockApi(clean, events);
    const quoteId = saveEvmQuote({ walletAddress: wallet });

    await cmds().execute([], api, flags, { quote: quoteId });

    expect(events.map(e => e.kind)).toEqual(['screen', 'execute']);
    // Signer and the wallet the quote was built for are the same address —
    // screened once, not twice.
    expect(lower(events[0].addresses)).toEqual(lower([wallet]));
    expect(quoteFile(quoteId).executedAt).toBeTypeOf('number');
  });

  it('refuses a flagged wallet with an actionable error; nothing is signed or broadcast', async () => {
    const wallet = setupLocalWallet();
    const events = [];
    stubEvmBackend(events);
    const api = mockApi(flagged(wallet), events);
    const quoteId = saveEvmQuote({ walletAddress: wallet });

    await expect(cmds().execute([], api, flags, { quote: quoteId })).rejects.toMatchObject({
      code: 'SANCTIONED',
      message: expect.stringMatching(/compliance blocklist/),
    });

    expect(events.map(e => e.kind)).toEqual(['screen']);
    expect(broadcastAttempted()).toBe(false);
    // Refused before the signing loop, so no nonce lookup or any other RPC ran.
    expect(fetch).not.toHaveBeenCalled();
    // The quote stays unconsumed — nothing went out.
    expect(quoteFile(quoteId).executedAt).toBeUndefined();
  });

  it('fails closed when screening is unavailable', async () => {
    const wallet = setupLocalWallet();
    const events = [];
    stubEvmBackend(events);
    const api = mockApi(() => { throw new Error('503 snapshot unavailable'); }, events);
    const quoteId = saveEvmQuote({ walletAddress: wallet });

    await expect(cmds().execute([], api, flags, { quote: quoteId })).rejects.toMatchObject({
      code: 'SCREENING_UNAVAILABLE',
      message: expect.stringMatching(/screening is unavailable/),
    });

    expect(broadcastAttempted()).toBe(false);
    expect(quoteFile(quoteId).executedAt).toBeUndefined();
  });

  it('fails closed when the screening response omits the wallet (unverifiable)', async () => {
    const wallet = setupLocalWallet();
    const events = [];
    stubEvmBackend(events);
    const api = mockApi(() => ({ results: [] }), events);
    const quoteId = saveEvmQuote({ walletAddress: wallet });

    await expect(cmds().execute([], api, flags, { quote: quoteId })).rejects.toThrow(/did not cover all addresses/);

    expect(broadcastAttempted()).toBe(false);
    expect(quoteFile(quoteId).executedAt).toBeUndefined();
  });

  it('screens the destination wallet of a cross-chain swap and refuses when it is flagged', async () => {
    const wallet = setupLocalWallet();
    const events = [];
    stubEvmBackend(events);
    const api = mockApi(flagged(SOL_DEST), events);
    const quoteId = saveEvmQuote({ walletAddress: wallet, toChain: 'solana', recipient: SOL_DEST });

    await expect(cmds().execute([], api, flags, { quote: quoteId }))
      .rejects.toThrow(new RegExp(`compliance blocklist.*${SOL_DEST}`));

    expect(events[0].addresses).toHaveLength(2);
    expect(lower(events[0].addresses)).toEqual(lower([wallet, SOL_DEST]));
    expect(broadcastAttempted()).toBe(false);
    expect(quoteFile(quoteId).executedAt).toBeUndefined();
  });

  it('WalletConnect: screens the connected address and refuses before asking the wallet to sign', async () => {
    const wallet = '0x8CB9c3F23C7d600fB430bbd171a313D9ea61cEBc';
    vi.spyOn(wcTrading, 'getWalletConnectAddress').mockResolvedValue(wallet);
    const send = vi.spyOn(wcTrading, 'sendTransactionViaWalletConnect').mockResolvedValue({});
    const events = [];
    stubEvmBackend(events);
    const api = mockApi(flagged(wallet), events);
    const quoteId = saveEvmQuote({ walletAddress: wallet, signerType: 'walletconnect' });

    await expect(cmds().execute([], api, flags, { quote: quoteId })).rejects.toThrow(/compliance blocklist/);

    expect(lower(events[0].addresses)).toEqual(lower([wallet]));
    expect(send).not.toHaveBeenCalled();
    expect(broadcastAttempted()).toBe(false);
  });

  it('Privy: screens the wallet the quote was built for before contacting the signing provider', async () => {
    process.env.PRIVY_APP_ID = 'test-app-id';
    process.env.PRIVY_APP_SECRET = 'test-secret';
    // No pre-loop signer for Privy (its address is fetched from the provider
    // inside the loop), so the gate falls on the quote's recorded wallet —
    // the only wallet the loop will agree to sign with.
    const wallet = '0x8CB9c3F23C7d600fB430bbd171a313D9ea61cEBc';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('unexpected network call')));
    const events = [];
    const api = mockApi(flagged(wallet), events);
    const quoteId = saveEvmQuote({
      walletAddress: wallet,
      signerType: 'privy',
      privyWalletIds: { evm: 'wl_evm_1', solana: 'wl_sol_1' },
    });

    await expect(cmds().execute([], api, flags, { quote: quoteId })).rejects.toThrow(/compliance blocklist/);

    expect(events.map(e => e.kind)).toEqual(['screen']);
    expect(lower(events[0].addresses)).toEqual(lower([wallet]));
    expect(fetch).not.toHaveBeenCalled();
  });

  it('Privy: refuses a quote that records no wallet at all rather than skipping the screen', async () => {
    process.env.PRIVY_APP_ID = 'test-app-id';
    process.env.PRIVY_APP_SECRET = 'test-secret';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('unexpected network call')));
    const events = [];
    const api = mockApi(clean, events);
    const quoteId = saveEvmQuote({
      signerType: 'privy',
      privyWalletIds: { evm: 'wl_evm_1', solana: 'wl_sol_1' },
      request: null,
    });

    await expect(cmds().execute([], api, flags, { quote: quoteId })).rejects.toMatchObject({
      code: 'SCREENING_UNAVAILABLE',
      message: expect.stringMatching(/cannot be screened/),
    });

    expect(events).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
});
