/**
 * `trade execute` with a Privy wallet that hands back a transaction other than
 * the one the CLI checked. Every pre-sign check (target, intent binding, value,
 * fee cap, simulation) ran on the transaction sent for signing, so the returned
 * bytes must never reach the execute endpoint unless they encode exactly that
 * transaction, signed by the wallet.
 */
import { describe, it, expect } from 'vitest';

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
  TEST_SOL_ADDRESS,
  privySignedEvm,
  privySignedSolana,
} from './fixtures/remote-signers.js';

useExecuteEnv();

const PRIVY_IDS = { evm: 'wl_evm', solana: 'wl_sol' };

// Rewrite the transaction a Privy request carries, then sign it honestly.
const privySignsInstead = (change) => (body) => privySignedEvm({ params: { transaction: { ...body.params.transaction, ...change(body.params.transaction) } } });

describe('Privy: the signed transaction must be the one that was checked', () => {
  it('broadcasts when Privy signs exactly what it was sent (control)', async () => {
    const executeBodies = stubNetwork({ privyAddress: TEST_EVM_ADDRESS, privySign: privySignedEvm });
    const quoteId = saveQuote(nativeSwapQuote(), 'base', 'privy', PRIVY_IDS, null, { swapMode: 'exactIn', request: evmIntent(TEST_EVM_ADDRESS) });
    const { err, logs } = await execute(quoteId);
    expect(err).toBeNull();
    expect(executeBodies).toHaveLength(1);
    expect(logs.some(l => l.includes('Transaction successful'))).toBe(true);
  });

  it('refuses an EVM swap whose recipient and calldata were substituted', async () => {
    const executeBodies = stubNetwork({
      privyAddress: TEST_EVM_ADDRESS,
      privySign: privySignsInstead(() => ({ to: ATTACKER, data: '0xa9059cbb' })),
    });
    const quoteId = saveQuote(nativeSwapQuote(), 'base', 'privy', PRIVY_IDS, null, { swapMode: 'exactIn', request: evmIntent(TEST_EVM_ADDRESS) });
    const { err, logs } = await execute(quoteId);
    expect(err).toMatchObject({ code: 'SIGNED_TX_MISMATCH', message: expect.stringMatching(/swap transaction.*to is 0x0+dead/) });
    expect(executeBodies).toHaveLength(0);
    expect(logs.some(l => l.includes('Trying next quote'))).toBe(false);
  });

  it('refuses an EVM swap signed by a key other than the wallet', async () => {
    const executeBodies = stubNetwork({ privyAddress: TEST_EVM_ADDRESS, privySign: (body) => privySignedEvm(body, '22'.repeat(32)) });
    const quoteId = saveQuote(nativeSwapQuote(), 'base', 'privy', PRIVY_IDS, null, { swapMode: 'exactIn', request: evmIntent(TEST_EVM_ADDRESS) });
    const { err } = await execute(quoteId);
    expect(err).toMatchObject({ code: 'SIGNED_TX_MISMATCH', message: expect.stringMatching(/signed by 0x/) });
    expect(executeBodies).toHaveLength(0);
  });

  it('refuses an approval whose spender was substituted, before anything is broadcast', async () => {
    const executeBodies = stubNetwork({
      privyAddress: TEST_EVM_ADDRESS,
      privySign: (body) => (body.params.transaction.data.startsWith(APPROVE_SELECTOR)
        ? privySignsInstead(() => ({ data: UNLIMITED_APPROVAL_TO_ATTACKER }))(body)
        : privySignedEvm(body)),
    });
    const quoteId = saveQuote(erc20SwapQuote(), 'base', 'privy', PRIVY_IDS, null, {
      swapMode: 'exactIn', request: evmIntent(TEST_EVM_ADDRESS, { fromToken: BASE_USDC, toToken: OUT_TOKEN, amount: '1000000' }),
    });
    const { err } = await execute(quoteId);
    expect(err).toMatchObject({ code: 'SIGNED_TX_MISMATCH', message: expect.stringMatching(/approval transaction.*data differs/) });
    expect(executeBodies).toHaveLength(0);
  });

  it('broadcasts a Solana swap Privy signed as sent (control)', async () => {
    const executeBodies = stubNetwork({ privyAddress: TEST_SOL_ADDRESS, privySign: privySignedSolana });
    const quoteId = saveQuote(solanaQuote(unsignedSolanaTx(TEST_SOL_ADDRESS)), 'solana', 'privy', PRIVY_IDS, null, { swapMode: 'exactIn', request: solIntent(TEST_SOL_ADDRESS) });
    const { err } = await execute(quoteId);
    expect(err).toBeNull();
    expect(executeBodies).toHaveLength(1);
  });

  it('refuses a Solana swap whose message was substituted', async () => {
    const executeBodies = stubNetwork({
      privyAddress: TEST_SOL_ADDRESS,
      privySign: () => privySignedSolana({ params: { transaction: unsignedSolanaTx(TEST_SOL_ADDRESS, 9) } }),
    });
    const quoteId = saveQuote(solanaQuote(unsignedSolanaTx(TEST_SOL_ADDRESS)), 'solana', 'privy', PRIVY_IDS, null, { swapMode: 'exactIn', request: solIntent(TEST_SOL_ADDRESS) });
    const { err } = await execute(quoteId);
    expect(err).toMatchObject({ code: 'SIGNED_TX_MISMATCH', message: expect.stringMatching(/swap transaction.*message bytes differ/) });
    expect(executeBodies).toHaveLength(0);
  });
});
