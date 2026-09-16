/**
 * Tests for src/x402-ledger.js
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'x402-ledger-test-'));
  process.env.HOME = tmpDir;
  vi.resetModules();
  delete process.env.NANSEN_X402_DAILY_MAX_AMOUNT;
  delete process.env.NANSEN_X402_SESSION_MAX_AMOUNT;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.NANSEN_X402_DAILY_MAX_AMOUNT;
  delete process.env.NANSEN_X402_SESSION_MAX_AMOUNT;
});

describe('resolveDailySpendCapUsd', () => {
  it('returns the default (10.00) when env var is unset', async () => {
    const { resolveDailySpendCapUsd, DEFAULT_DAILY_MAX_AMOUNT_USD } = await import('../x402-ledger.js');
    expect(resolveDailySpendCapUsd()).toBe(DEFAULT_DAILY_MAX_AMOUNT_USD);
    expect(DEFAULT_DAILY_MAX_AMOUNT_USD).toBe(10.0);
  });

  it('returns Infinity for "unlimited"', async () => {
    process.env.NANSEN_X402_DAILY_MAX_AMOUNT = 'unlimited';
    const { resolveDailySpendCapUsd } = await import('../x402-ledger.js');
    expect(resolveDailySpendCapUsd()).toBe(Infinity);
  });

  it('parses a numeric env var', async () => {
    process.env.NANSEN_X402_DAILY_MAX_AMOUNT = '25.00';
    const { resolveDailySpendCapUsd } = await import('../x402-ledger.js');
    expect(resolveDailySpendCapUsd()).toBe(25);
  });

  it('falls back to default on an invalid env var', async () => {
    process.env.NANSEN_X402_DAILY_MAX_AMOUNT = 'garbage';
    const { resolveDailySpendCapUsd, DEFAULT_DAILY_MAX_AMOUNT_USD } = await import('../x402-ledger.js');
    expect(resolveDailySpendCapUsd()).toBe(DEFAULT_DAILY_MAX_AMOUNT_USD);
  });

  it('treats an empty-string env var as unset', async () => {
    process.env.NANSEN_X402_DAILY_MAX_AMOUNT = '';
    const { resolveDailySpendCapUsd, DEFAULT_DAILY_MAX_AMOUNT_USD } = await import('../x402-ledger.js');
    expect(resolveDailySpendCapUsd()).toBe(DEFAULT_DAILY_MAX_AMOUNT_USD);
  });

  it('treats a whitespace-only env var as unset', async () => {
    process.env.NANSEN_X402_DAILY_MAX_AMOUNT = '   ';
    const { resolveDailySpendCapUsd, DEFAULT_DAILY_MAX_AMOUNT_USD } = await import('../x402-ledger.js');
    expect(resolveDailySpendCapUsd()).toBe(DEFAULT_DAILY_MAX_AMOUNT_USD);
  });
});

describe('assertCumulativeSpendAllowed — daily cap', () => {
  it('allows a payment when no ledger exists yet', async () => {
    const { assertCumulativeSpendAllowed } = await import('../x402-ledger.js');
    const result = assertCumulativeSpendAllowed({ amountUsd: 1.0 });
    expect(result.ok).toBe(true);
  });

  it('allows when existing spend + new amount is exactly at the daily cap (inclusive)', async () => {
    process.env.NANSEN_X402_DAILY_MAX_AMOUNT = '10.00';
    const { assertCumulativeSpendAllowed, finalizePaymentAttempt, recordPaymentAttempt, _resetSessionSpend } = await import('../x402-ledger.js');
    _resetSessionSpend();
    const id = recordPaymentAttempt({ provider: 'local', amountUsd: 9.0, network: 'eip155:8453', asset: '0xtest', symbol: 'USDC', amountRaw: '9000000', payTo: '0xrec', requestUrl: 'https://api.nansen.ai/test' });
    finalizePaymentAttempt(id, { status: 'accepted' });
    // $1.00 more hits cap exactly → allowed (cap check is >, not >=)
    const result = assertCumulativeSpendAllowed({ amountUsd: 1.0 });
    expect(result.ok).toBe(true);
  });

  it('refuses when existing spend + new amount exceeds the daily cap', async () => {
    process.env.NANSEN_X402_DAILY_MAX_AMOUNT = '10.00';
    const { assertCumulativeSpendAllowed, finalizePaymentAttempt, recordPaymentAttempt, _resetSessionSpend } = await import('../x402-ledger.js');
    _resetSessionSpend();
    const id = recordPaymentAttempt({ provider: 'local', amountUsd: 9.5, network: 'eip155:8453', asset: '0xtest', symbol: 'USDC', amountRaw: '9500000', payTo: '0xrec', requestUrl: 'https://api.nansen.ai/test' });
    finalizePaymentAttempt(id, { status: 'accepted' });
    const result = assertCumulativeSpendAllowed({ amountUsd: 1.0 });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/daily x402 spend cap/i);
    expect(result.reason).toMatch(/NANSEN_X402_DAILY_MAX_AMOUNT/);
  });

  it('unlimited disables the daily cap', async () => {
    process.env.NANSEN_X402_DAILY_MAX_AMOUNT = 'unlimited';
    const { assertCumulativeSpendAllowed } = await import('../x402-ledger.js');
    const result = assertCumulativeSpendAllowed({ amountUsd: 999 });
    expect(result.ok).toBe(true);
  });

  it('fails closed with a clear message on a corrupt ledger file', async () => {
    const { assertCumulativeSpendAllowed } = await import('../x402-ledger.js');
    const ledgerDir = path.join(tmpDir, '.nansen', 'x402');
    fs.mkdirSync(ledgerDir, { recursive: true });
    const today = new Date();
    const yyyy = today.getUTCFullYear();
    const mm = String(today.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(today.getUTCDate()).padStart(2, '0');
    fs.writeFileSync(path.join(ledgerDir, `spend-${yyyy}-${mm}-${dd}.json`), 'NOT VALID JSON');
    expect(() => assertCumulativeSpendAllowed({ amountUsd: 1.0 })).toThrow(/corrupt/i);
  });
});

describe('recordPaymentAttempt and audit log', () => {
  it('writes a signed entry to the audit log without secrets', async () => {
    const { recordPaymentAttempt } = await import('../x402-ledger.js');
    const id = recordPaymentAttempt({
      provider: 'local',
      walletLabel: 'local wallet test',
      network: 'eip155:8453',
      asset: '0xtoken',
      symbol: 'USDC',
      amountUsd: 0.01,
      amountRaw: '10000',
      payTo: '0xrecipient',
      requestUrl: 'https://api.nansen.ai/v1/endpoint?key=secret&addr=0xabc',
    });

    expect(typeof id).toBe('string');
    expect(id).toHaveLength(32);

    const auditFile = path.join(tmpDir, '.nansen', 'x402', 'payments.jsonl');
    const lines = fs.readFileSync(auditFile, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]);

    expect(record.id).toBe(id);
    expect(record.status).toBe('signed');
    expect(record.provider).toBe('local');
    expect(record.amountUsd).toBe(0.01);
    // Query string must be stripped
    expect(record.requestUrl).toBe('https://api.nansen.ai/v1/endpoint');
    expect(record.requestUrl).not.toContain('secret');
    // Must not contain sensitive fields
    expect(record).not.toHaveProperty('signature');
    expect(record).not.toHaveProperty('apiKey');
    expect(record).not.toHaveProperty('privateKey');
  });

  it('finalizePaymentAttempt appends an accepted update and increments daily spend', async () => {
    const { recordPaymentAttempt, finalizePaymentAttempt, assertCumulativeSpendAllowed, _resetSessionSpend } = await import('../x402-ledger.js');
    _resetSessionSpend();
    process.env.NANSEN_X402_DAILY_MAX_AMOUNT = '1.00';

    const id = recordPaymentAttempt({ provider: 'local', amountUsd: 0.50, network: 'eip155:8453', asset: '0xt', symbol: 'USDC', amountRaw: '500000', payTo: '0xr', requestUrl: 'https://api.nansen.ai/test' });
    finalizePaymentAttempt(id, { status: 'accepted' });

    // Spending another $0.51 should now exceed the $1.00 cap
    const result = assertCumulativeSpendAllowed({ amountUsd: 0.51 });
    expect(result.ok).toBe(false);
  });

  it('rejected outcome does not increment daily spend', async () => {
    const { recordPaymentAttempt, finalizePaymentAttempt, assertCumulativeSpendAllowed, _resetSessionSpend } = await import('../x402-ledger.js');
    _resetSessionSpend();
    process.env.NANSEN_X402_DAILY_MAX_AMOUNT = '1.00';

    const id = recordPaymentAttempt({ provider: 'local', amountUsd: 0.99, network: 'eip155:8453', asset: '0xt', symbol: 'USDC', amountRaw: '990000', payTo: '0xr', requestUrl: 'https://api.nansen.ai/test' });
    finalizePaymentAttempt(id, { status: 'rejected' });

    // Rejected: ledger not incremented, $0.99 still fits under $1.00
    const result = assertCumulativeSpendAllowed({ amountUsd: 0.99 });
    expect(result.ok).toBe(true);
  });

  it('ambiguous outcome counts against the daily cap', async () => {
    const { recordPaymentAttempt, finalizePaymentAttempt, assertCumulativeSpendAllowed, _resetSessionSpend } = await import('../x402-ledger.js');
    _resetSessionSpend();
    process.env.NANSEN_X402_DAILY_MAX_AMOUNT = '1.00';

    const id = recordPaymentAttempt({ provider: 'local', amountUsd: 0.99, network: 'eip155:8453', asset: '0xt', symbol: 'USDC', amountRaw: '990000', payTo: '0xr', requestUrl: 'https://api.nansen.ai/test' });
    finalizePaymentAttempt(id, { status: 'ambiguous' });

    const result = assertCumulativeSpendAllowed({ amountUsd: 0.02 });
    expect(result.ok).toBe(false);
  });

  it('stores accepted spend as exact integer micro-dollars', async () => {
    const { recordPaymentAttempt, finalizePaymentAttempt, assertCumulativeSpendAllowed, getDailySpendState, _resetSessionSpend } = await import('../x402-ledger.js');
    _resetSessionSpend();
    process.env.NANSEN_X402_DAILY_MAX_AMOUNT = '1.00';

    const first = recordPaymentAttempt({ provider: 'local', amountUsd: 0.1, network: 'eip155:8453', asset: '0xt', symbol: 'USDC', amountRaw: '100000', payTo: '0xr', requestUrl: 'https://api.nansen.ai/test' });
    finalizePaymentAttempt(first, { status: 'accepted' });
    const second = recordPaymentAttempt({ provider: 'local', amountUsd: 0.2, network: 'eip155:8453', asset: '0xt', symbol: 'USDC', amountRaw: '200000', payTo: '0xr', requestUrl: 'https://api.nansen.ai/test' });
    finalizePaymentAttempt(second, { status: 'accepted' });

    const ledgerDir = path.join(tmpDir, '.nansen', 'x402');
    const spendFile = fs.readdirSync(ledgerDir).find((name) => name.startsWith('spend-'));
    const stored = JSON.parse(fs.readFileSync(path.join(ledgerDir, spendFile), 'utf8'));
    expect(stored).toMatchObject({ totalUsdMicros: '300000' });
    expect(stored).not.toHaveProperty('totalUsd');
    expect(getDailySpendState().totalUsd).toBe(0.3);
    expect(assertCumulativeSpendAllowed({ amountUsd: 0.7 }).ok).toBe(true);
    expect(assertCumulativeSpendAllowed({ amountUsd: 0.700001 }).ok).toBe(false);
  });

  it('reads legacy totalUsd ledger files for compatibility', async () => {
    process.env.NANSEN_X402_DAILY_MAX_AMOUNT = '1.00';
    const { assertCumulativeSpendAllowed, getDailySpendState } = await import('../x402-ledger.js');
    const ledgerDir = path.join(tmpDir, '.nansen', 'x402');
    fs.mkdirSync(ledgerDir, { recursive: true });
    const today = new Date();
    const yyyy = today.getUTCFullYear();
    const mm = String(today.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(today.getUTCDate()).padStart(2, '0');
    fs.writeFileSync(path.join(ledgerDir, `spend-${yyyy}-${mm}-${dd}.json`), JSON.stringify({ totalUsd: 0.3 }));

    expect(getDailySpendState().totalUsd).toBe(0.3);
    expect(assertCumulativeSpendAllowed({ amountUsd: 0.7 }).ok).toBe(true);
    expect(assertCumulativeSpendAllowed({ amountUsd: 0.700001 }).ok).toBe(false);
  });

  it('does not overwrite a corrupt ledger while finalizing an accepted payment', async () => {
    const { recordPaymentAttempt, finalizePaymentAttempt, _resetSessionSpend } = await import('../x402-ledger.js');
    _resetSessionSpend();
    const ledgerDir = path.join(tmpDir, '.nansen', 'x402');
    fs.mkdirSync(ledgerDir, { recursive: true });
    const today = new Date();
    const yyyy = today.getUTCFullYear();
    const mm = String(today.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(today.getUTCDate()).padStart(2, '0');
    const spendPath = path.join(ledgerDir, `spend-${yyyy}-${mm}-${dd}.json`);
    fs.writeFileSync(spendPath, 'NOT VALID JSON');

    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const id = recordPaymentAttempt({ provider: 'local', amountUsd: 0.01, network: 'eip155:8453', asset: '0xt', symbol: 'USDC', amountRaw: '10000', payTo: '0xr', requestUrl: 'https://api.nansen.ai/test' });
    finalizePaymentAttempt(id, { status: 'accepted' });

    expect(fs.readFileSync(spendPath, 'utf8')).toBe('NOT VALID JSON');
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/could not update daily spend ledger/));
    warn.mockRestore();
  });
});
