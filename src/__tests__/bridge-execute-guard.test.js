/**
 * --dry-run / --yes gate on `bridge execute`.
 *
 * A bridge quote can carry several steps, so the gate sits before the FIRST
 * one: a dry run and a declined confirmation must not sign or send anything.
 * Both signing seams (signEvmTransaction, eth_sendRawTransaction) throw here,
 * so reaching either fails the test instead of passing quietly.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../wallet.js', () => ({
  showWallet: vi.fn(),
  getWalletConfig: vi.fn(() => ({})),
  exportWallet: vi.fn(),
}));

vi.mock('../keychain.js', () => ({
  retrievePassword: vi.fn(() => ({ password: null, source: null })),
}));

const { evmRpcCall, getEvmNonce, signEvmTransaction, waitForReceipt } = vi.hoisted(() => ({
  evmRpcCall: vi.fn(),
  getEvmNonce: vi.fn(async () => 7),
  signEvmTransaction: vi.fn(() => {
    throw new Error('signEvmTransaction must not be reached');
  }),
  waitForReceipt: vi.fn(async () => ({ status: '0x1', blockNumber: '0x1' })),
}));

vi.mock('../trading.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, evmRpcCall, getEvmNonce, signEvmTransaction, waitForReceipt };
});

import fs from 'fs';
import os from 'os';
import path from 'path';

import { exportWallet, getWalletConfig, showWallet } from '../wallet.js';
import { buildBridgeCommands } from '../bridge.js';

const ADDR = '0x' + 'ab'.repeat(20);
// Real Base -> Hyperliquid deposit router/selector — the preflight rejects
// anything else, so the fixture needs well-formed deposit calldata.
const ROUTER = '0x4cd00e387622c35bddb9b4c962c136462338bc31';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const REQUESTED_AMOUNT = 2000000n;
const word = h => h.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const depositCalldata = (depositor, amount = REQUESTED_AMOUNT) =>
  '0xe8017952' + word(depositor) + word(USDC) + word(amount.toString(16)) + word('0x'.padEnd(66, 'a'));

describe('bridge execute --dry-run / --yes', () => {
  let tmpHome;
  let prevHome;
  let quotesDir;

  const api = {
    request: vi.fn(async (endpoint) => {
      if (String(endpoint).includes('/bridge/status')) return { status: 'success', destination_tx_hashes: [] };
      return { results: [{ address: ADDR, sanctioned: false }] };
    }),
  };

  function writeQuote(quoteId) {
    const data = {
      quoteId,
      type: 'bridge',
      originChain: 'base',
      destinationChain: 'hyperliquid',
      walletProvider: 'local',
      walletAddress: ADDR,
      requestedAmountBaseUnits: REQUESTED_AMOUNT.toString(),
      timestamp: Date.now(),
      response: {
        execution_type: 'evm_transaction',
        request_id: 'r1',
        details: {
          currencyIn: { amountFormatted: '2.0', currency: { symbol: 'USDC' } },
          currencyOut: { amountFormatted: '1.99', currency: { symbol: 'USDC' } },
        },
        fees: { relayer: { amountUsd: '0.01' } },
        steps: [{
          id: 'deposit',
          kind: 'transaction',
          items: [{
            status: 'incomplete',
            data: { from: ADDR, to: ROUTER, data: depositCalldata(ADDR), value: '0', maxFeePerGas: '1000000' },
          }],
        }],
      },
    };
    fs.writeFileSync(path.join(quotesDir, `${quoteId}.json`), JSON.stringify(data, null, 2));
    return quoteId;
  }

  function readQuote(quoteId) {
    return JSON.parse(fs.readFileSync(path.join(quotesDir, `${quoteId}.json`), 'utf8'));
  }

  // Let the deposit actually go out: sign returns bytes and the node accepts
  // them. Only the tests that expect a broadcast call this.
  function allowBroadcast() {
    signEvmTransaction.mockReturnValue('0xsigned');
    evmRpcCall.mockImplementation(async (_chain, method) => {
      if (method === 'eth_getBlockByNumber') return { baseFeePerGas: '0x1' };
      if (method === 'eth_sendRawTransaction') return '0xdeposithash';
      return '0x0';
    });
  }

  const sendCalls = () =>
    evmRpcCall.mock.calls.filter(([, method]) => method === 'eth_sendRawTransaction');

  beforeEach(() => {
    vi.clearAllMocks();
    prevHome = process.env.HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nansen-bridge-guard-'));
    process.env.HOME = tmpHome;
    delete process.env.NANSEN_YES;
    quotesDir = path.join(tmpHome, '.nansen', 'quotes');
    fs.mkdirSync(quotesDir, { recursive: true });
    getWalletConfig.mockReturnValue({});
    showWallet.mockReturnValue({ name: 'w', evm: ADDR, provider: 'local' });
    exportWallet.mockReturnValue({ evm: { privateKey: '11'.repeat(32) } });
    getEvmNonce.mockResolvedValue(7);
    signEvmTransaction.mockImplementation(() => {
      throw new Error('signEvmTransaction must not be reached');
    });
    evmRpcCall.mockImplementation(async (_chain, method) => {
      if (method === 'eth_getBlockByNumber') return { baseFeePerGas: '0x1' };
      if (method === 'eth_sendRawTransaction') throw new Error('eth_sendRawTransaction must not be reached');
      return '0x0';
    });
    api.request.mockImplementation(async (endpoint) => {
      if (String(endpoint).includes('/bridge/status')) return { status: 'success', destination_tx_hashes: [] };
      return { results: [{ address: ADDR, sanctioned: false }] };
    });
  });

  afterEach(() => {
    process.env.HOME = prevHome;
    delete process.env.NANSEN_YES;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('--dry-run prints the transfer plan and signs nothing', async () => {
    const quoteId = writeQuote('bridge-dry-run');
    const logs = [];
    const promptFn = vi.fn();
    const cmds = buildBridgeCommands({ log: m => logs.push(m), promptFn, isTTY: true, env: {} });

    await cmds.execute([], api, { 'dry-run': true }, { quote: quoteId, wallet: 'w' });

    const out = logs.join('\n');
    expect(out).toContain('Bridge plan — base → hyperliquid');
    expect(out).toContain('2.0 USDC');
    expect(out).toContain('~1.99 USDC');
    expect(out).toContain('deposit (transaction)');
    expect(out).toContain(ADDR);
    expect(out).toContain('DRY RUN — nothing was broadcast');
    expect(signEvmTransaction).not.toHaveBeenCalled();
    expect(sendCalls()).toHaveLength(0);
    expect(promptFn).not.toHaveBeenCalled();
    // The quote is untouched, so the user can execute it afterwards.
    expect(readQuote(quoteId).executedAt).toBeUndefined();
  });

  it('--dry-run uses the validated quote wallet without resolving a configured wallet', async () => {
    const quoteId = writeQuote('bridge-dry-run-quote-wallet');
    const logs = [];
    getWalletConfig.mockImplementation(() => {
      throw new Error('wallet configuration must not be read');
    });
    showWallet.mockImplementation(() => {
      throw new Error('wallet lookup must not be reached');
    });
    const cmds = buildBridgeCommands({ log: m => logs.push(m), promptFn: vi.fn(), isTTY: false, env: {} });

    await cmds.execute([], api, { 'dry-run': true }, { quote: quoteId });

    expect(logs.join('\n')).toContain(ADDR);
    expect(getWalletConfig).not.toHaveBeenCalled();
    expect(showWallet).not.toHaveBeenCalled();
    expect(exportWallet).not.toHaveBeenCalled();
    expect(signEvmTransaction).not.toHaveBeenCalled();
    expect(sendCalls()).toHaveLength(0);
  });

  it('--dry-run rejects a malformed persisted quote wallet before wallet resolution', async () => {
    const quoteId = writeQuote('bridge-dry-run-invalid-quote-wallet');
    const quote = readQuote(quoteId);
    quote.walletAddress = 'not-an-evm-address';
    fs.writeFileSync(path.join(quotesDir, `${quoteId}.json`), JSON.stringify(quote, null, 2));
    const cmds = buildBridgeCommands({ log: () => {}, promptFn: vi.fn(), isTTY: false, env: {} });

    await expect(cmds.execute([], api, { 'dry-run': true }, { quote: quoteId }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });

    expect(getWalletConfig).not.toHaveBeenCalled();
    expect(showWallet).not.toHaveBeenCalled();
    expect(exportWallet).not.toHaveBeenCalled();
    expect(signEvmTransaction).not.toHaveBeenCalled();
    expect(sendCalls()).toHaveLength(0);
  });

  it('--dry-run reports the fee/nonce overrides that would be applied', async () => {
    const quoteId = writeQuote('bridge-dry-run-overrides');
    const logs = [];
    const cmds = buildBridgeCommands({ log: m => logs.push(m), promptFn: vi.fn(), isTTY: false, env: {} });

    await cmds.execute([], api, { 'dry-run': true }, {
      quote: quoteId, wallet: 'w', 'priority-fee': '0.05', nonce: '20',
    });

    expect(logs.join('\n')).toMatch(/Overrides:.*priority fee 50000000 wei, starting nonce 20/);
    expect(sendCalls()).toHaveLength(0);
  });

  it('--dry-run preflights a tampered later step before credentials', async () => {
    const quoteId = writeQuote('bridge-dry-run-tampered');
    const quote = readQuote(quoteId);
    quote.response.steps.push({
      id: 'second-deposit',
      kind: 'transaction',
      items: [{
        status: 'incomplete',
        data: { from: ADDR, to: ROUTER, data: depositCalldata(ADDR), value: '0', maxFeePerGas: '1000000' },
      }],
    });
    fs.writeFileSync(path.join(quotesDir, `${quoteId}.json`), JSON.stringify(quote, null, 2));

    const promptFn = vi.fn();
    const cmds = buildBridgeCommands({ log: () => {}, promptFn, isTTY: true, env: {} });
    await expect(cmds.execute([], api, { 'dry-run': true }, { quote: quoteId, wallet: 'w' }))
      .rejects.toMatchObject({ code: 'UNEXPECTED_ACTION' });

    expect(promptFn).not.toHaveBeenCalled();
    expect(exportWallet).not.toHaveBeenCalled();
    expect(signEvmTransaction).not.toHaveBeenCalled();
    expect(sendCalls()).toHaveLength(0);
  });

  it('screens before dry-run or confirmation and loads no credentials when blocked', async () => {
    const quoteId = writeQuote('bridge-sanctioned');
    api.request.mockResolvedValueOnce({ results: [{ address: ADDR, sanctioned: true }] });
    const promptFn = vi.fn();
    const cmds = buildBridgeCommands({ log: () => {}, promptFn, isTTY: true, env: {} });

    await expect(cmds.execute([], api, { 'dry-run': true }, { quote: quoteId, wallet: 'w' }))
      .rejects.toThrow(/compliance blocklist/i);

    expect(promptFn).not.toHaveBeenCalled();
    expect(exportWallet).not.toHaveBeenCalled();
    expect(signEvmTransaction).not.toHaveBeenCalled();
    expect(sendCalls()).toHaveLength(0);
  });

  it('aborts with nothing sent when an interactive user declines', async () => {
    const quoteId = writeQuote('bridge-declined');
    const promptFn = vi.fn(async () => 'n');
    const logs = [];
    const cmds = buildBridgeCommands({ log: m => logs.push(m), promptFn, isTTY: true, env: {} });

    await expect(cmds.execute([], api, {}, { quote: quoteId, wallet: 'w' }))
      .rejects.toMatchObject({ code: 'CONFIRMATION_DECLINED' });

    expect(promptFn).toHaveBeenCalledWith('Broadcast this transaction? [y/N] ');
    expect(logs.join('\n')).toContain('Bridge plan — base → hyperliquid');
    expect(signEvmTransaction).not.toHaveBeenCalled();
    expect(exportWallet).not.toHaveBeenCalled();
    expect(sendCalls()).toHaveLength(0);
    expect(readQuote(quoteId).executedAt).toBeUndefined();
  });

  it('broadcasts after an interactive "yes"', async () => {
    allowBroadcast();
    const quoteId = writeQuote('bridge-confirmed');
    const promptFn = vi.fn(async () => 'yes');
    const cmds = buildBridgeCommands({ log: () => {}, promptFn, isTTY: true, env: {} });

    await cmds.execute([], api, {}, { quote: quoteId, wallet: 'w' });

    expect(promptFn).toHaveBeenCalledTimes(1);
    expect(sendCalls()).toHaveLength(1);
  });

  it('broadcasts without prompting when --yes is passed on a terminal', async () => {
    allowBroadcast();
    const quoteId = writeQuote('bridge-yes-flag');
    const promptFn = vi.fn();
    const cmds = buildBridgeCommands({ log: () => {}, promptFn, isTTY: true, env: {} });

    await cmds.execute([], api, { yes: true }, { quote: quoteId, wallet: 'w' });

    expect(promptFn).not.toHaveBeenCalled();
    expect(sendCalls()).toHaveLength(1);
  });

  it('broadcasts unprompted when stdin is not a terminal (agents, CI, pipes)', async () => {
    allowBroadcast();
    const quoteId = writeQuote('bridge-non-tty');
    const promptFn = vi.fn();
    const logs = [];
    const cmds = buildBridgeCommands({ log: m => logs.push(m), promptFn, isTTY: false, env: {} });

    await cmds.execute([], api, {}, { quote: quoteId, wallet: 'w' });

    expect(promptFn).not.toHaveBeenCalled();
    expect(sendCalls()).toHaveLength(1);
    expect(logs.join('\n')).not.toContain('Bridge plan');
  });

  it('treats NANSEN_YES=1 like --yes on a terminal', async () => {
    allowBroadcast();
    const quoteId = writeQuote('bridge-env-yes');
    const promptFn = vi.fn();
    const cmds = buildBridgeCommands({
      log: () => {}, promptFn, isTTY: true, env: { NANSEN_YES: '1' },
    });

    await cmds.execute([], api, {}, { quote: quoteId, wallet: 'w' });

    expect(promptFn).not.toHaveBeenCalled();
    expect(sendCalls()).toHaveLength(1);
  });
});
