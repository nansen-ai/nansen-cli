import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RLP } from '@ethereumjs/rlp';

vi.mock('../wallet.js', () => ({
  showWallet: vi.fn(),
  getWalletConfig: vi.fn(() => ({})),
  exportWallet: vi.fn(),
}));

vi.mock('../keychain.js', () => ({
  retrievePassword: vi.fn(() => ({ password: null, source: null })),
}));

vi.mock('../perp.js', () => ({
  screenOrThrow: vi.fn(),
}));

import fs from 'fs';
import os from 'os';
import path from 'path';

import { exportWallet, getWalletConfig, showWallet } from '../wallet.js';
import { retrievePassword } from '../keychain.js';
import { screenOrThrow } from '../perp.js';
import { buildBridgeCommands } from '../bridge.js';

// M6: bridge.js missed the wallet hardening perp.js had. These run through the
// real `bridge execute` so they pin the wiring, not just the shared helper.

const ADDR = '0x' + 'ab'.repeat(20);

// Real captured Base -> HL deposit-router shape (see bridge-evm-deposit-intent
// tests for the full decode). Used below to build a plan that actually passes
// preflightEvmBridgeSteps, rather than an empty `steps: []` stand-in.
const DEPOSIT_ROUTER = '0x4cd00e387622c35bddb9b4c962c136462338bc31';
const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const word = h => h.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const depositCalldata = (depositor, token, amount) =>
  '0xe8017952' + word(depositor) + word(token) + word(amount.toString(16)) + word('a');

// evmRpcCall goes through global fetch (see evm-nonce.test.js), so a test that
// actually reaches processEvmStep needs a minimal fake chain behind it.
function mockChainRpc() {
  return vi.fn(async (url, init) => {
    const body = JSON.parse(init.body);
    let result;
    switch (body.method) {
      case 'eth_getTransactionCount': result = '0x0'; break;
      case 'eth_gasPrice': result = '0x3b9aca00'; break;
      case 'eth_sendRawTransaction': result = '0x' + 'ab'.repeat(32); break;
      case 'eth_getTransactionReceipt': result = { status: '0x1', blockNumber: '0x1' }; break;
      default: throw new Error(`unexpected RPC method ${body.method}`);
    }
    const payload = JSON.stringify({ jsonrpc: '2.0', id: body.id, result });
    return { ok: true, status: 200, text: async () => payload };
  });
}

let tmpHome;
let prevHome;
let quotesDir;
let prevFetch;

function writeQuote(quoteId, overrides = {}) {
  const data = {
    quoteId,
    type: 'bridge',
    originChain: 'base',
    destinationChain: 'hyperliquid',
    walletProvider: 'local',
    walletAddress: ADDR,
    timestamp: Date.now(),
    response: { execution_type: 'evm_transaction', steps: [], request_id: 'r1' },
    ...overrides,
  };
  fs.writeFileSync(path.join(quotesDir, `${quoteId}.json`), JSON.stringify(data, null, 2));
}

// Screening has to pass for execution to reach the key-resolution step, and a
// quote with no steps runs straight into completion polling — which loops for ten
// minutes unless the status call answers.
async function respond(endpoint) {
  if (String(endpoint).includes('/bridge/status')) {
    return { status: 'success', raw_status: 'done', destination_tx_hashes: ['0x' + 'de'.repeat(32)] };
  }
  return { results: [{ address: ADDR, sanctioned: false }] };
}

const cleanApi = { request: vi.fn(respond) };

beforeEach(() => {
  vi.clearAllMocks();
  prevHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nansen-bridge-hardening-'));
  process.env.HOME = tmpHome;
  quotesDir = path.join(tmpHome, '.nansen', 'quotes');
  fs.mkdirSync(quotesDir, { recursive: true });
  getWalletConfig.mockReturnValue({});
  retrievePassword.mockReturnValue({ password: null, source: null });
  cleanApi.request.mockImplementation(respond);
  prevFetch = globalThis.fetch;
});

afterEach(() => {
  process.env.HOME = prevHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  globalThis.fetch = prevFetch;
});

describe('bridge execute wallet hardening', () => {
  it('reports PASSWORD_REQUIRED, not "Incorrect password", when nothing was entered', async () => {
    // M6.1, the item flagged as immediate support noise.
    const cmds = buildBridgeCommands({ log: () => {} });
    writeQuote('bridge-1');
    showWallet.mockReturnValue({ name: 'w', evm: ADDR, provider: 'local' });
    getWalletConfig.mockReturnValue({ passwordHash: 'h' });

    let err;
    try {
      await cmds.execute([], cleanApi, {}, { quote: 'bridge-1', wallet: 'w' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.code).toBe('PASSWORD_REQUIRED');
    expect(err.message).not.toMatch(/Incorrect password/);
    expect(exportWallet).not.toHaveBeenCalled();
  });

  it('refuses a wallet with no EVM address before any network call', async () => {
    // M6.2: this used to pass wallet.evm through as null and 422 at the API.
    const cmds = buildBridgeCommands({ log: () => {} });
    writeQuote('bridge-2');
    showWallet.mockReturnValue({ name: 'sol-only', evm: null, provider: 'local' });

    await expect(
      cmds.execute([], cleanApi, {}, { quote: 'bridge-2', wallet: 'sol-only' }),
    ).rejects.toThrow(/no valid EVM address\. Bridging requires an EVM wallet/);
    expect(cleanApi.request).not.toHaveBeenCalled();
  });

  it('resolves the wallet exactly once for the signer and its key', async () => {
    // M6.3: two resolutions could screen one wallet and sign with another if the
    // default changed in between.
    const cmds = buildBridgeCommands({ log: () => {} });
    writeQuote('bridge-3');
    showWallet.mockReturnValue({ name: 'w', evm: ADDR, provider: 'local' });
    exportWallet.mockReturnValue({ evm: { privateKey: '11'.repeat(32) } });

    await cmds.execute([], cleanApi, {}, { quote: 'bridge-3', wallet: 'w' }).catch(() => {});
    expect(showWallet).toHaveBeenCalledTimes(1);
  });

  it('does not try to export a key for a Privy wallet', async () => {
    const cmds = buildBridgeCommands({ log: () => {} });
    writeQuote('bridge-4', {
      walletProvider: 'privy',
      response: { execution_type: 'hyperliquid_signature', steps: [], request_id: 'r1' },
    });
    showWallet.mockReturnValue({
      name: 'p',
      evm: ADDR,
      provider: 'privy',
      privyWalletIds: { evm: 'pw-1' },
    });

    await cmds.execute([], cleanApi, {}, { quote: 'bridge-4', wallet: 'p' }).catch(() => {});
    expect(exportWallet).not.toHaveBeenCalled();
  });

  it('rejects a duplicated EVM deposit plan before any eth_sendRawTransaction', async () => {
    // A tampered plan with [deposit, deposit] passes per-item checks (each deposit
    // is individually valid) but fails preflightEvmBridgeSteps (exactly one deposit
    // required). This test ensures preflightEvmBridgeSteps is wired into execute:
    // if it were removed, processEvmStep would reach eth_sendRawTransaction.
    const requestedAmount = 2000000n;
    const depositData = depositCalldata(ADDR, BASE_USDC, requestedAmount);
    const cmds = buildBridgeCommands({ log: () => {} });
    showWallet.mockReturnValue({ name: 'w', evm: ADDR, provider: 'local' });
    exportWallet.mockReturnValue({ evm: { privateKey: '11'.repeat(32) } });

    const fakeFetch = mockChainRpc();
    globalThis.fetch = fakeFetch;

    writeQuote('bridge-preflight', {
      requestedAmountBaseUnits: requestedAmount.toString(),
      response: {
        execution_type: 'evm_transaction',
        steps: [
          { id: 'deposit-1', items: [{ status: 'incomplete', data: { to: DEPOSIT_ROUTER, data: depositData, value: '0' } }] },
          { id: 'deposit-2', items: [{ status: 'incomplete', data: { to: DEPOSIT_ROUTER, data: depositData, value: '0' } }] },
        ],
        request_id: 'r-preflight',
      },
    });

    let err;
    try {
      await cmds.execute([], cleanApi, {}, { quote: 'bridge-preflight', wallet: 'w' });
    } catch (e) {
      err = e;
    }

    expect(err).toBeDefined();
    expect(err.message).toMatch(/at most one approve and exactly one deposit/);

    // No broadcast must have happened.
    const calls = fakeFetch.mock.calls;
    const rpcBodies = calls.map(([, init]) => JSON.parse(init.body));
    const broadcasts = rpcBodies.filter(b => b.method === 'eth_sendRawTransaction');
    expect(broadcasts).toHaveLength(0);
  });

  it('broadcasts the normalized deposit calldata, not the dirty server bytes', async () => {
    // A single deposit whose depositor/token words carry non-zero garbage in
    // their upper 12 bytes is still individually VALID (decodeBridgeDeposit reads
    // the clean last-20-bytes), so it sails through preflightEvmBridgeSteps. The
    // only thing that strips the garbage before it reaches the wire is the
    // per-step assertEvmBridgeStepIntent inside processEvmStep, whose returned
    // `bound.data` is what gets signed. This pins THAT layer independently: if
    // processEvmStep signed txData.data instead of bound.data, the dirty bytes
    // would broadcast and this assertion would fail — even though preflight,
    // which the sibling duplicate-deposit test pins, still passes here.
    const requestedAmount = 2000000n;
    const dirtyDepositor = ('deadbeef'.repeat(3) + ADDR.slice(2)).toLowerCase();   // 12 dirty + 20 clean bytes
    const dirtyToken = ('cafebabe'.repeat(3) + BASE_USDC.slice(2)).toLowerCase();
    const dirtyDeposit = '0xe8017952' + dirtyDepositor + dirtyToken
      + word(requestedAmount.toString(16)) + word('a');
    const canonicalDeposit = depositCalldata(ADDR, BASE_USDC, requestedAmount);
    expect(dirtyDeposit).not.toBe(canonicalDeposit); // guard: the input really is dirty

    const cmds = buildBridgeCommands({ log: () => {} });
    showWallet.mockReturnValue({ name: 'w', evm: ADDR, provider: 'local' });
    exportWallet.mockReturnValue({ evm: { privateKey: '11'.repeat(32) } });

    const fakeFetch = mockChainRpc();
    globalThis.fetch = fakeFetch;

    writeQuote('bridge-normalize', {
      requestedAmountBaseUnits: requestedAmount.toString(),
      response: {
        execution_type: 'evm_transaction',
        steps: [
          { id: 'deposit-1', items: [{ status: 'incomplete', data: { to: DEPOSIT_ROUTER, data: dirtyDeposit, value: '0' } }] },
        ],
        request_id: 'r-normalize',
      },
    });

    await cmds.execute([], cleanApi, {}, { quote: 'bridge-normalize', wallet: 'w' });

    // Exactly one broadcast; decode the legacy signed tx and read its calldata
    // (RLP field 5: [nonce, gasPrice, gasLimit, to, value, data, v, r, s]).
    const broadcasts = fakeFetch.mock.calls
      .map(([, init]) => JSON.parse(init.body))
      .filter(b => b.method === 'eth_sendRawTransaction');
    expect(broadcasts).toHaveLength(1);
    const signedTx = broadcasts[0].params[0];
    const fields = RLP.decode(Buffer.from(signedTx.replace(/^0x/, ''), 'hex'));
    const broadcastData = '0x' + Buffer.from(fields[5]).toString('hex');

    expect(broadcastData).toBe(canonicalDeposit);
    expect(broadcastData).not.toBe(dirtyDeposit);
  });

  it('screens a distinct bridge recipient with the signer', async () => {
    const recipient = '0x' + 'cd'.repeat(20);
    const cmds = buildBridgeCommands({ log: () => {} });
    showWallet.mockReturnValue({ name: 'w', evm: ADDR, provider: 'local' });
    exportWallet.mockReturnValue({ evm: { privateKey: '11'.repeat(32) } });
    cleanApi.request.mockImplementation(async endpoint => {
      if (String(endpoint).includes('/bridge/quote')) {
        return {
          execution_type: 'evm_transaction',
          steps: [{
            id: 'deposit',
            items: [{
              status: 'incomplete',
              data: { to: DEPOSIT_ROUTER, data: depositCalldata(ADDR, BASE_USDC, 5000000n), value: '0' },
            }],
          }],
          request_id: 'r1',
        };
      }
      return respond(endpoint);
    });
    globalThis.fetch = mockChainRpc();

    await cmds.quote([], cleanApi, {}, {
      'from-chain': 'base',
      'to-chain': 'hyperliquid',
      'from-token': 'USDC',
      amount: '5000000',
      wallet: 'w',
      recipient,
    });
    const quoteId = path.basename(fs.readdirSync(quotesDir)[0], '.json');

    await cmds.execute([], cleanApi, {}, { quote: quoteId, wallet: 'w' });

    expect(screenOrThrow).toHaveBeenCalledWith(cleanApi, [ADDR, recipient]);
  });
});
