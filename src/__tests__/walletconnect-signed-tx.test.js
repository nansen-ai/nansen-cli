/**
 * `trade execute` with a WalletConnect wallet that hands back a transaction
 * other than the one the CLI checked. Every pre-sign check (target, intent
 * binding, value, fee cap, simulation) ran on the transaction sent for signing,
 * so returned bytes must never reach the execute endpoint unless they encode
 * that transaction, signed by the wallet.
 */
import { describe, it, expect, vi } from 'vitest';

// The walletconnect CLI is a subprocess; stub it so the real send functions
// (and their checks) run.
vi.mock('child_process', () => ({ execFile: vi.fn() }));
import { execFile } from 'child_process';

import { signEip1559Transaction } from '../trading.js';
import { base58Decode, base58Encode } from '../wallet.js';
import {
  ATTACKER,
  APPROVE_SELECTOR,
  BASE_USDC,
  OUT_TOKEN,
  UNLIMITED_APPROVAL_TO_ATTACKER,
  erc20SwapQuote,
  evmIntent,
  execute,
  nativeSwapQuote,
  saveQuote,
  solIntent,
  solanaQuote,
  stubNetwork,
  unsignedSolanaTx,
  useExecuteEnv,
} from './fixtures/execute-harness.js';
import {
  TEST_EVM_ADDRESS,
  TEST_EVM_KEY,
  TEST_SOL_ADDRESS,
  signSolanaSlot,
} from './fixtures/remote-signers.js';

useExecuteEnv();

/**
 * Stub the walletconnect CLI: `whoami` reports the wallet, `send-transaction`
 * answers with `reply(payload)`.
 */
function stubWalletConnect({ accounts, reply }) {
  execFile.mockImplementation((cmd, args, opts, cb) => {
    if (args[0] === 'whoami') return cb(null, JSON.stringify({ connected: true, accounts }), '');
    if (args[0] === 'send-transaction') return cb(null, JSON.stringify(reply(JSON.parse(args[1]))), '');
    return cb(new Error(`unexpected walletconnect call ${args[0]}`), '', '');
  });
}

const WC_EVM = [{ chain: 'eip155:8453', address: TEST_EVM_ADDRESS }];
const WC_SOL = [{ chain: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', address: TEST_SOL_ADDRESS }];

// The wallet picks nonce and fees; `change` rewrites what it was asked to send.
const wcSignsEvm = (change = () => ({})) => (p) => ({
  signedTransaction: signEip1559Transaction({
    chainId: 8453, nonce: 7, maxPriorityFeePerGas: 1n, maxFeePerGas: 2n, gasLimit: BigInt(p.gas),
    to: p.to, value: p.value, data: p.data, ...change(p),
  }, TEST_EVM_KEY),
});
const b58 = (base64) => base58Encode(Buffer.from(base64, 'base64'));
const asBase64 = (txBase58) => Buffer.from(base58Decode(txBase58)).toString('base64');

describe('WalletConnect: the signed transaction must be the one that was checked', () => {
  it('broadcasts an EVM swap the wallet signed as sent (control)', async () => {
    const executeBodies = stubNetwork();
    stubWalletConnect({ accounts: WC_EVM, reply: wcSignsEvm() });
    const quoteId = saveQuote(nativeSwapQuote(), 'base', 'walletconnect', null, null, { swapMode: 'exactIn', request: evmIntent(TEST_EVM_ADDRESS) });
    const { err } = await execute(quoteId);
    expect(err).toBeNull();
    expect(executeBodies).toHaveLength(1);
  });

  it('refuses an EVM swap with a substituted recipient, keeping SIGNED_TX_MISMATCH', async () => {
    const executeBodies = stubNetwork();
    stubWalletConnect({ accounts: WC_EVM, reply: wcSignsEvm(() => ({ to: ATTACKER })) });
    const quoteId = saveQuote(nativeSwapQuote(), 'base', 'walletconnect', null, null, { swapMode: 'exactIn', request: evmIntent(TEST_EVM_ADDRESS) });
    const { err, logs } = await execute(quoteId);
    expect(err).toMatchObject({ code: 'SIGNED_TX_MISMATCH', message: expect.stringMatching(/swap transaction.*to is 0x0+dead.*the wallet may have/) });
    expect(executeBodies).toHaveLength(0);
    expect(logs.some(l => l.includes('Trying next quote'))).toBe(false);
  });

  it('refuses an approval with a substituted spender, keeping SIGNED_TX_MISMATCH', async () => {
    const executeBodies = stubNetwork();
    stubWalletConnect({
      accounts: WC_EVM,
      reply: (p) => wcSignsEvm(() => (p.data.startsWith(APPROVE_SELECTOR) ? { data: UNLIMITED_APPROVAL_TO_ATTACKER } : {}))(p),
    });
    const quoteId = saveQuote(erc20SwapQuote(), 'base', 'walletconnect', null, null, {
      swapMode: 'exactIn', request: evmIntent(TEST_EVM_ADDRESS, { fromToken: BASE_USDC, toToken: OUT_TOKEN, amount: '1000000' }),
    });
    const { err } = await execute(quoteId);
    expect(err).toMatchObject({ code: 'SIGNED_TX_MISMATCH', message: expect.stringMatching(/approval transaction.*data differs/) });
    expect(executeBodies).toHaveLength(0);
  });

  it('broadcasts a Solana swap the wallet signed as sent (control)', async () => {
    const executeBodies = stubNetwork();
    stubWalletConnect({ accounts: WC_SOL, reply: (p) => ({ signedTransaction: b58(signSolanaSlot(asBase64(p.transaction))) }) });
    const quoteId = saveQuote(solanaQuote(unsignedSolanaTx(TEST_SOL_ADDRESS)), 'solana', 'walletconnect', null, null, { swapMode: 'exactIn', request: solIntent(TEST_SOL_ADDRESS) });
    const { err } = await execute(quoteId);
    expect(err).toBeNull();
    expect(executeBodies).toHaveLength(1);
  });

  it('refuses a Solana swap whose message was substituted', async () => {
    const executeBodies = stubNetwork();
    stubWalletConnect({ accounts: WC_SOL, reply: () => ({ signedTransaction: b58(signSolanaSlot(unsignedSolanaTx(TEST_SOL_ADDRESS, 9))) }) });
    const quoteId = saveQuote(solanaQuote(unsignedSolanaTx(TEST_SOL_ADDRESS)), 'solana', 'walletconnect', null, null, { swapMode: 'exactIn', request: solIntent(TEST_SOL_ADDRESS) });
    const { err } = await execute(quoteId);
    expect(err).toMatchObject({ code: 'SIGNED_TX_MISMATCH', message: expect.stringMatching(/swap transaction.*message bytes differ/) });
    expect(executeBodies).toHaveLength(0);
  });

  it('refuses a signature-only reply whose signature does not verify', async () => {
    const executeBodies = stubNetwork();
    stubWalletConnect({ accounts: WC_SOL, reply: () => ({ signature: base58Encode(Buffer.alloc(64, 7)) }) });
    const quoteId = saveQuote(solanaQuote(unsignedSolanaTx(TEST_SOL_ADDRESS)), 'solana', 'walletconnect', null, null, { swapMode: 'exactIn', request: solIntent(TEST_SOL_ADDRESS) });
    const { err } = await execute(quoteId);
    expect(err).toMatchObject({ code: 'SIGNED_TX_MISMATCH', message: expect.stringMatching(/no valid signature/) });
    expect(executeBodies).toHaveLength(0);
  });

  it('broadcasts a signature-only reply with the wallet\'s valid signature (control)', async () => {
    const executeBodies = stubNetwork();
    stubWalletConnect({
      accounts: WC_SOL,
      reply: (p) => ({ signature: base58Encode(Buffer.from(signSolanaSlot(asBase64(p.transaction)), 'base64').subarray(1, 65)) }),
    });
    const quoteId = saveQuote(solanaQuote(unsignedSolanaTx(TEST_SOL_ADDRESS)), 'solana', 'walletconnect', null, null, { swapMode: 'exactIn', request: solIntent(TEST_SOL_ADDRESS) });
    const { err } = await execute(quoteId);
    expect(err).toBeNull();
    expect(executeBodies).toHaveLength(1);
  });
});
