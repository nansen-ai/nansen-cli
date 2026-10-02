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

  it('tightens permissions on an existing audit log before appending', async () => {
    const ledgerDir = path.join(tmpDir, '.nansen', 'x402');
    const auditFile = path.join(ledgerDir, 'payments.jsonl');
    fs.mkdirSync(ledgerDir, { recursive: true });
    fs.writeFileSync(auditFile, '');
    fs.chmodSync(auditFile, 0o644);

    const { recordPaymentAttempt } = await import('../x402-ledger.js');
    recordPaymentAttempt({
      provider: 'local',
      amountUsd: 0.01,
      network: 'eip155:8453',
      asset: '0xt',
      symbol: 'USDC',
      amountRaw: '10000',
      payTo: '0xr',
      requestUrl: 'https://api.nansen.ai/test',
    });

    expect(fs.statSync(auditFile).mode & 0o777).toBe(0o600);
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

  it('writes daily spend through a process-qualified temp file', async () => {
    const writeSpy = vi.spyOn(fs, 'writeFileSync');
    const { recordPaymentAttempt, finalizePaymentAttempt, _resetSessionSpend } = await import('../x402-ledger.js');
    _resetSessionSpend();

    const id = recordPaymentAttempt({ provider: 'local', amountUsd: 0.50, network: 'eip155:8453', asset: '0xt', symbol: 'USDC', amountRaw: '500000', payTo: '0xr', requestUrl: 'https://api.nansen.ai/test' });
    finalizePaymentAttempt(id, { status: 'accepted' });

    expect(writeSpy).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`spend-\\d{4}-\\d{2}-\\d{2}\\.json\\.${process.pid}\\.tmp$`)),
      expect.any(String),
      { mode: 0o600 },
    );
    writeSpy.mockRestore();
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

  it('fails closed on later payments after a daily ledger write failure, without advancing session spend', async () => {
    // Unlimited daily cap so the cap check itself skips the (corrupt) daily
    // file read and only the session accumulator is exercised.
    process.env.NANSEN_X402_DAILY_MAX_AMOUNT = 'unlimited';
    process.env.NANSEN_X402_SESSION_MAX_AMOUNT = '1.00';
    const { recordPaymentAttempt, finalizePaymentAttempt, assertCumulativeSpendAllowed, _resetSessionSpend, _clearLedgerWriteFailure } = await import('../x402-ledger.js');
    _resetSessionSpend();

    // Corrupt daily file makes incrementDailySpend throw during finalize.
    const ledgerDir = path.join(tmpDir, '.nansen', 'x402');
    fs.mkdirSync(ledgerDir, { recursive: true });
    const today = new Date();
    const yyyy = today.getUTCFullYear();
    const mm = String(today.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(today.getUTCDate()).padStart(2, '0');
    fs.writeFileSync(path.join(ledgerDir, `spend-${yyyy}-${mm}-${dd}.json`), 'NOT VALID JSON');

    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const id = recordPaymentAttempt({ provider: 'local', amountUsd: 0.9, network: 'eip155:8453', asset: '0xt', symbol: 'USDC', amountRaw: '900000', payTo: '0xr', requestUrl: 'https://api.nansen.ai/test' });
    finalizePaymentAttempt(id, { status: 'accepted' });
    warn.mockRestore();

    // The $0.90 is on the wire but uncounted, so the daily cap can no longer be
    // enforced: every later payment this process attempts must fail closed.
    expect(() => assertCumulativeSpendAllowed({ amountUsd: 0.9 })).toThrow(/spend accounting is incomplete/i);
    try {
      assertCumulativeSpendAllowed({ amountUsd: 0.9 });
    } catch (err) {
      expect(err.failClosedX402).toBe(true);
    }

    // Behind that latch, the session total must still be $0 — the $0.90 never
    // durably recorded. If session spend had advanced, a fresh $0.90 payment
    // would exceed the $1.00 session cap instead of fitting under it.
    _clearLedgerWriteFailure();
    expect(assertCumulativeSpendAllowed({ amountUsd: 0.9 }).ok).toBe(true);
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

describe('reservations — concurrent cap enforcement', () => {
  const ledgerPath = () => {
    const today = new Date();
    const yyyy = today.getUTCFullYear();
    const mm = String(today.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(today.getUTCDate()).padStart(2, '0');
    return path.join(tmpDir, '.nansen', 'x402', `spend-${yyyy}-${mm}-${dd}.json`);
  };

  it('holds budget at the cap check, so a second check cannot clear the same headroom', async () => {
    // The race this closes: both checks read the same total, both clear the
    // cap, both sign, and the serialized increments land above the limit.
    process.env.NANSEN_X402_DAILY_MAX_AMOUNT = '1.00';
    const { assertCumulativeSpendAllowed, _resetSessionSpend } = await import('../x402-ledger.js');
    _resetSessionSpend();

    const first = assertCumulativeSpendAllowed({ amountUsd: 0.6 });
    expect(first.ok).toBe(true);
    expect(first.reservationId).toMatch(/^\d{4}-\d{2}-\d{2}-[0-9a-f]{32}$/);

    // Nothing has settled yet — the daily total is still $0 — but $0.60 of the
    // $1.00 is spoken for, so a second $0.60 payment must be refused.
    const second = assertCumulativeSpendAllowed({ amountUsd: 0.6 });
    expect(second.ok).toBe(false);
    expect(second.reason).toMatch(/daily x402 spend cap/);
    expect(second.reservationId).toBeUndefined();

    // What still fits does clear.
    expect(assertCumulativeSpendAllowed({ amountUsd: 0.4 }).ok).toBe(true);
  });

  it('counts budget another process is holding', async () => {
    // Stand in for a concurrent CLI run: its reservation is already in the
    // file when this process reads it.
    process.env.NANSEN_X402_DAILY_MAX_AMOUNT = '1.00';
    const { assertCumulativeSpendAllowed, _resetSessionSpend } = await import('../x402-ledger.js');
    _resetSessionSpend();

    fs.mkdirSync(path.dirname(ledgerPath()), { recursive: true });
    fs.writeFileSync(ledgerPath(), JSON.stringify({
      totalUsdMicros: '200000',
      reservations: { 'other-process': { micros: '700000', expiresAt: new Date(Date.now() + 60_000).toISOString() } },
    }));

    // $0.20 settled + $0.70 held = $0.90 of $1.00.
    expect(assertCumulativeSpendAllowed({ amountUsd: 0.2 }).ok).toBe(false);
    expect(assertCumulativeSpendAllowed({ amountUsd: 0.1 }).ok).toBe(true);
  });

  it('reclaims budget from a reservation whose process died', async () => {
    // The TTL backstop: without it a crash between signing and finalizing
    // would hold that budget for the rest of the UTC day.
    process.env.NANSEN_X402_DAILY_MAX_AMOUNT = '1.00';
    const { assertCumulativeSpendAllowed, getDailySpendState, _resetSessionSpend } = await import('../x402-ledger.js');
    _resetSessionSpend();

    fs.mkdirSync(path.dirname(ledgerPath()), { recursive: true });
    fs.writeFileSync(ledgerPath(), JSON.stringify({
      totalUsdMicros: '0',
      reservations: { stale: { micros: '900000', expiresAt: new Date(Date.now() - 1_000).toISOString() } },
    }));

    expect(getDailySpendState().reservedUsd).toBe(0);
    expect(assertCumulativeSpendAllowed({ amountUsd: 0.9 }).ok).toBe(true);
  });

  it('converts the reservation to settled spend exactly once when the payment is accepted', async () => {
    process.env.NANSEN_X402_DAILY_MAX_AMOUNT = '1.00';
    const { assertCumulativeSpendAllowed, recordPaymentAttempt, finalizePaymentAttempt, getDailySpendState, _resetSessionSpend } = await import('../x402-ledger.js');
    _resetSessionSpend();

    const capCheck = assertCumulativeSpendAllowed({ amountUsd: 0.6 });
    const id = recordPaymentAttempt({
      provider: 'local', amountUsd: 0.6, authorizedAt: capCheck.authorizedAt, reservationId: capCheck.reservationId,
      network: 'eip155:8453', asset: '0xt', symbol: 'USDC', amountRaw: '600000', payTo: '0xr', requestUrl: 'https://api.nansen.ai/test',
    });
    finalizePaymentAttempt(id, { status: 'accepted' });

    // Settled once, not counted twice as held + spent.
    const state = getDailySpendState();
    expect(state.totalUsd).toBe(0.6);
    expect(state.reservedUsd).toBe(0);
    expect(JSON.parse(fs.readFileSync(ledgerPath(), 'utf8')).reservations).toBeUndefined();
  });

  it('hands budget back when the payment is rejected', async () => {
    process.env.NANSEN_X402_DAILY_MAX_AMOUNT = '1.00';
    const { assertCumulativeSpendAllowed, recordPaymentAttempt, finalizePaymentAttempt, getDailySpendState, _resetSessionSpend } = await import('../x402-ledger.js');
    _resetSessionSpend();

    const capCheck = assertCumulativeSpendAllowed({ amountUsd: 0.9 });
    const id = recordPaymentAttempt({
      provider: 'local', amountUsd: 0.9, authorizedAt: capCheck.authorizedAt, reservationId: capCheck.reservationId,
      network: 'eip155:8453', asset: '0xt', symbol: 'USDC', amountRaw: '900000', payTo: '0xr', requestUrl: 'https://api.nansen.ai/test',
    });
    finalizePaymentAttempt(id, { status: 'rejected' });

    // A rejected payment spent nothing, so the whole cap is available again
    // rather than staying held until the reservation expires.
    expect(getDailySpendState()).toEqual({ totalUsd: 0, reservedUsd: 0 });
    expect(assertCumulativeSpendAllowed({ amountUsd: 1.0 }).ok).toBe(true);
  });

  it('releases budget for an attempt that was abandoned before signing', async () => {
    // Providers call this when they give up after the cap check — a wallet
    // without the right key, a missing Permit2 allowance, a signing failure.
    process.env.NANSEN_X402_DAILY_MAX_AMOUNT = '1.00';
    const { assertCumulativeSpendAllowed, releasePaymentReservation, getDailySpendState, _resetSessionSpend } = await import('../x402-ledger.js');
    _resetSessionSpend();

    const capCheck = assertCumulativeSpendAllowed({ amountUsd: 0.9 });
    expect(getDailySpendState().reservedUsd).toBe(0.9);

    releasePaymentReservation(capCheck.reservationId);
    expect(getDailySpendState().reservedUsd).toBe(0);
    expect(assertCumulativeSpendAllowed({ amountUsd: 1.0 }).ok).toBe(true);
  });

  it('reserves against the day the check cleared, not the day it runs', async () => {
    process.env.NANSEN_X402_DAILY_MAX_AMOUNT = '1.00';
    const { assertCumulativeSpendAllowed, _resetSessionSpend } = await import('../x402-ledger.js');
    _resetSessionSpend();

    const now = new Date('2026-03-01T23:59:55Z');
    expect(assertCumulativeSpendAllowed({ amountUsd: 0.6, now }).ok).toBe(true);

    const ledgerDir = path.join(tmpDir, '.nansen', 'x402');
    expect(fs.readdirSync(ledgerDir).filter((n) => n.startsWith('spend-'))).toEqual(['spend-2026-03-01.json']);
    // Day 2 is untouched, so its own cap is whole.
    expect(assertCumulativeSpendAllowed({ amountUsd: 1.0, now: new Date('2026-03-02T00:00:05Z') }).ok).toBe(true);
  });

  it('refuses to sign rather than guess when a reservation entry is malformed', async () => {
    process.env.NANSEN_X402_DAILY_MAX_AMOUNT = '1.00';
    const { assertCumulativeSpendAllowed } = await import('../x402-ledger.js');

    fs.mkdirSync(path.dirname(ledgerPath()), { recursive: true });
    fs.writeFileSync(ledgerPath(), JSON.stringify({
      totalUsdMicros: '0',
      reservations: { bad: { micros: 'not-a-number', expiresAt: new Date(Date.now() + 60_000).toISOString() } },
    }));

    expect(() => assertCumulativeSpendAllowed({ amountUsd: 0.1 })).toThrow(/corrupt/i);
  });
});

describe('session cap — in-flight reservations', () => {
  it('holds session budget at the cap check, so a second concurrent check cannot clear the same headroom', async () => {
    // The race this closes: both checks read the same session total (incremented
    // only at finalize), both clear the per-process cap, both sign, and the sum
    // exceeds NANSEN_X402_SESSION_MAX_AMOUNT. Daily unlimited so only the session
    // accumulator is exercised.
    process.env.NANSEN_X402_DAILY_MAX_AMOUNT = 'unlimited';
    process.env.NANSEN_X402_SESSION_MAX_AMOUNT = '1.00';
    const { assertCumulativeSpendAllowed, _resetSessionSpend } = await import('../x402-ledger.js');
    _resetSessionSpend();

    const first = assertCumulativeSpendAllowed({ amountUsd: 0.6 });
    expect(first.ok).toBe(true);
    expect(first.reservationId).toMatch(/^\d{4}-\d{2}-\d{2}-[0-9a-f]{32}$/);

    // Nothing has settled yet — session spend is still $0 — but $0.60 of the
    // $1.00 session cap is spoken for, so a second $0.60 payment must be refused.
    const second = assertCumulativeSpendAllowed({ amountUsd: 0.6 });
    expect(second.ok).toBe(false);
    expect(second.reason).toMatch(/session x402 spend cap/);
    expect(second.reservationId).toBeUndefined();

    // What still fits under the held budget does clear.
    expect(assertCumulativeSpendAllowed({ amountUsd: 0.4 }).ok).toBe(true);
  });

  it('frees the session hold when the payment is rejected', async () => {
    process.env.NANSEN_X402_DAILY_MAX_AMOUNT = 'unlimited';
    process.env.NANSEN_X402_SESSION_MAX_AMOUNT = '1.00';
    const { assertCumulativeSpendAllowed, recordPaymentAttempt, finalizePaymentAttempt, _resetSessionSpend } = await import('../x402-ledger.js');
    _resetSessionSpend();

    const capCheck = assertCumulativeSpendAllowed({ amountUsd: 0.9 });
    const id = recordPaymentAttempt({
      provider: 'local', amountUsd: 0.9, authorizedAt: capCheck.authorizedAt, reservationId: capCheck.reservationId,
      network: 'eip155:8453', asset: '0xt', symbol: 'USDC', amountRaw: '900000', payTo: '0xr', requestUrl: 'https://api.nansen.ai/test',
    });
    finalizePaymentAttempt(id, { status: 'rejected' });

    // Rejected spent nothing, so the whole session cap is available again rather
    // than staying held behind the in-flight reservation.
    expect(assertCumulativeSpendAllowed({ amountUsd: 1.0 }).ok).toBe(true);
  });

  it('frees the session hold for an attempt abandoned before signing', async () => {
    process.env.NANSEN_X402_DAILY_MAX_AMOUNT = 'unlimited';
    process.env.NANSEN_X402_SESSION_MAX_AMOUNT = '1.00';
    const { assertCumulativeSpendAllowed, releasePaymentReservation, _resetSessionSpend } = await import('../x402-ledger.js');
    _resetSessionSpend();

    const capCheck = assertCumulativeSpendAllowed({ amountUsd: 0.9 });
    expect(assertCumulativeSpendAllowed({ amountUsd: 0.2 }).ok).toBe(false);

    releasePaymentReservation(capCheck.reservationId);
    expect(assertCumulativeSpendAllowed({ amountUsd: 1.0 }).ok).toBe(true);
  });

  it('converts the session hold to settled spend exactly once when accepted', async () => {
    process.env.NANSEN_X402_DAILY_MAX_AMOUNT = 'unlimited';
    process.env.NANSEN_X402_SESSION_MAX_AMOUNT = '1.00';
    const { assertCumulativeSpendAllowed, recordPaymentAttempt, finalizePaymentAttempt, _resetSessionSpend } = await import('../x402-ledger.js');
    _resetSessionSpend();

    const capCheck = assertCumulativeSpendAllowed({ amountUsd: 0.6 });
    const id = recordPaymentAttempt({
      provider: 'local', amountUsd: 0.6, authorizedAt: capCheck.authorizedAt, reservationId: capCheck.reservationId,
      network: 'eip155:8453', asset: '0xt', symbol: 'USDC', amountRaw: '600000', payTo: '0xr', requestUrl: 'https://api.nansen.ai/test',
    });
    finalizePaymentAttempt(id, { status: 'accepted' });

    // $0.60 is now settled session spend, counted once (not held + spent). A
    // refused check reserves nothing, so both directions prove single-counting:
    // $0.41 exceeds the $0.40 remaining, $0.40 fits exactly.
    expect(assertCumulativeSpendAllowed({ amountUsd: 0.41 }).ok).toBe(false);
    expect(assertCumulativeSpendAllowed({ amountUsd: 0.4 }).ok).toBe(true);
  });
});

describe('fail-closed edge cases', () => {
  it('fails closed when no home directory can be resolved', async () => {
    process.env.NANSEN_X402_DAILY_MAX_AMOUNT = '10.00';
    const savedHome = process.env.HOME;
    const savedProfile = process.env.USERPROFILE;
    delete process.env.HOME;
    delete process.env.USERPROFILE;
    try {
      const { assertCumulativeSpendAllowed } = await import('../x402-ledger.js');
      expect(() => assertCumulativeSpendAllowed({ amountUsd: 1.0 })).toThrow(/home directory/i);
      // Must carry the fail-closed marker so callers surface it instead of
      // silently disabling the cap.
      try {
        assertCumulativeSpendAllowed({ amountUsd: 1.0 });
      } catch (err) {
        expect(err.failClosedX402).toBe(true);
      }
    } finally {
      process.env.HOME = savedHome;
      if (savedProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = savedProfile;
    }
  });

  it('attributes spend to the day the payment was recorded, not the day it finalizes', async () => {
    process.env.NANSEN_X402_DAILY_MAX_AMOUNT = '10.00';
    const { recordPaymentAttempt, finalizePaymentAttempt, _resetSessionSpend } = await import('../x402-ledger.js');
    _resetSessionSpend();

    vi.useFakeTimers();
    try {
      // Record just before UTC midnight on day 1.
      vi.setSystemTime(new Date('2026-03-01T23:59:55Z'));
      const id = recordPaymentAttempt({ provider: 'local', amountUsd: 0.5, network: 'eip155:8453', asset: '0xt', symbol: 'USDC', amountRaw: '500000', payTo: '0xr', requestUrl: 'https://api.nansen.ai/test' });

      // Finalize just after midnight, now on day 2.
      vi.setSystemTime(new Date('2026-03-02T00:00:05Z'));
      finalizePaymentAttempt(id, { status: 'accepted' });
    } finally {
      vi.useRealTimers();
    }

    const ledgerDir = path.join(tmpDir, '.nansen', 'x402');
    const files = fs.readdirSync(ledgerDir).filter((n) => n.startsWith('spend-'));
    // Spend lands on day 1 (record/authorization day), not day 2.
    expect(files).toEqual(['spend-2026-03-01.json']);
    const stored = JSON.parse(fs.readFileSync(path.join(ledgerDir, files[0]), 'utf8'));
    expect(stored.totalUsdMicros).toBe('500000');
  });

  it('returns the authorization time so the caller can pin the day it cleared', async () => {
    process.env.NANSEN_X402_DAILY_MAX_AMOUNT = '10.00';
    const { assertCumulativeSpendAllowed } = await import('../x402-ledger.js');
    const now = new Date('2026-03-01T23:59:55Z');
    expect(assertCumulativeSpendAllowed({ amountUsd: 0.5, now })).toMatchObject({ ok: true, authorizedAt: now });

    // Also on the short-circuit path, or an unlimited daily cap would drop the
    // day and send the spend to whatever day finalization happens to land on.
    // A reservationId still comes back there: with no daily budget to hold it
    // carries the per-process session hold, which finalize/release settle by id.
    process.env.NANSEN_X402_DAILY_MAX_AMOUNT = 'unlimited';
    const unlimited = assertCumulativeSpendAllowed({ amountUsd: 0.5, now });
    expect(unlimited).toMatchObject({ ok: true, authorizedAt: now });
    expect(unlimited.reservationId).toMatch(/^\d{4}-\d{2}-\d{2}-[0-9a-f]{32}$/);
  });

  it('charges spend to the day the cap check cleared, even when signing crosses midnight', async () => {
    process.env.NANSEN_X402_DAILY_MAX_AMOUNT = '10.00';
    const { assertCumulativeSpendAllowed, recordPaymentAttempt, finalizePaymentAttempt, _resetSessionSpend } = await import('../x402-ledger.js');
    _resetSessionSpend();

    vi.useFakeTimers();
    try {
      // Cap check clears against day 1, seconds before UTC midnight.
      vi.setSystemTime(new Date('2026-03-01T23:59:55Z'));
      const capCheck = assertCumulativeSpendAllowed({ amountUsd: 0.5 });
      expect(capCheck.ok).toBe(true);

      // Signing takes long enough to cross midnight — minutes of wallet
      // approval is routine on the WalletConnect path — so both the record and
      // the finalize land on day 2.
      vi.setSystemTime(new Date('2026-03-02T00:00:30Z'));
      const id = recordPaymentAttempt({
        provider: 'walletconnect', amountUsd: 0.5, authorizedAt: capCheck.authorizedAt,
        network: 'eip155:8453', asset: '0xt', symbol: 'USDC', amountRaw: '500000', payTo: '0xr',
        requestUrl: 'https://api.nansen.ai/test',
      });
      finalizePaymentAttempt(id, { status: 'accepted' });
    } finally {
      vi.useRealTimers();
    }

    const ledgerDir = path.join(tmpDir, '.nansen', 'x402');
    const files = fs.readdirSync(ledgerDir).filter((n) => n.startsWith('spend-'));
    // Day 1 authorized it, so day 1 pays for it — day 2's budget is untouched.
    expect(files).toEqual(['spend-2026-03-01.json']);
    expect(JSON.parse(fs.readFileSync(path.join(ledgerDir, files[0]), 'utf8')).totalUsdMicros).toBe('500000');

    // The audit record carries both times so the attribution is checkable.
    const audit = JSON.parse(fs.readFileSync(path.join(ledgerDir, 'payments.jsonl'), 'utf8').trim().split('\n')[0]);
    expect(audit.authorizedAt).toBe('2026-03-01T23:59:55.000Z');
    expect(audit.timestamp).toBe('2026-03-02T00:00:30.000Z');
  });

  it('keeps failing closed in a new process after a daily ledger write failure', async () => {
    // The in-memory latch dies with the process, and the daily reservation that
    // stands in for the uncounted payment expires after its TTL. Without a
    // durable marker the next CLI run reads the under-counted total, reclaims
    // that budget and spends past the cap — which is the whole failure this
    // guards against.
    process.env.NANSEN_X402_DAILY_MAX_AMOUNT = '1.00';
    const first = await import('../x402-ledger.js');
    first._resetSessionSpend();
    first._clearLedgerWriteFailure();

    const ledgerDir = path.join(tmpDir, '.nansen', 'x402');
    fs.mkdirSync(ledgerDir, { recursive: true });
    const today = new Date();
    const yyyy = today.getUTCFullYear();
    const mm = String(today.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(today.getUTCDate()).padStart(2, '0');
    const spendPath = path.join(ledgerDir, `spend-${yyyy}-${mm}-${dd}.json`);

    const capCheck = first.assertCumulativeSpendAllowed({ amountUsd: 0.9 });
    expect(capCheck.ok).toBe(true);

    // The daily file turns unreadable between the reservation and the commit,
    // so the $0.90 goes out but is never counted.
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    fs.writeFileSync(spendPath, 'NOT VALID JSON');
    const id = first.recordPaymentAttempt({
      provider: 'local', amountUsd: 0.9, authorizedAt: capCheck.authorizedAt,
      reservationId: capCheck.reservationId, network: 'eip155:8453', asset: '0xt',
      symbol: 'USDC', amountRaw: '900000', payTo: '0xr', requestUrl: 'https://api.nansen.ai/test',
    });
    first.finalizePaymentAttempt(id, { status: 'accepted' });
    warn.mockRestore();

    const markerPath = path.join(ledgerDir, 'accounting-failure.jsonl');
    expect(fs.existsSync(markerPath)).toBe(true);
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8').trim().split('\n')[0]);
    expect(marker.amountUsd).toBe(0.9);
    expect(marker.paymentId).toBe(id);

    // A second CLI process: fresh module state, so no in-memory latch and no
    // session spend. Clear the corrupt daily file and drop the reservation too,
    // standing in for its TTL expiring — the marker alone must hold the line.
    fs.rmSync(spendPath, { force: true });
    vi.resetModules();
    const second = await import('../x402-ledger.js');
    second._resetSessionSpend();
    expect(() => second.assertCumulativeSpendAllowed({ amountUsd: 0.9 }))
      .toThrow(/spend accounting is incomplete/i);
    expect(() => second.assertCumulativeSpendAllowed({ amountUsd: 0.9 }))
      .toThrow(new RegExp(markerPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    // Reconciling (deleting the marker) is what lets payments resume.
    fs.rmSync(markerPath, { force: true });
    expect(second.assertCumulativeSpendAllowed({ amountUsd: 0.9 }).ok).toBe(true);
  });

  it('finalizeIfPending settles an unfinalized payment once and no-ops afterwards', async () => {
    process.env.NANSEN_X402_DAILY_MAX_AMOUNT = 'unlimited';
    const { recordPaymentAttempt, finalizePaymentAttempt, finalizeIfPending, getDailySpendState, _resetSessionSpend } =
      await import('../x402-ledger.js');
    _resetSessionSpend();

    const abandoned = recordPaymentAttempt({
      provider: 'local', amountUsd: 0.4, network: 'eip155:8453', asset: '0xt',
      symbol: 'USDC', amountRaw: '400000', payTo: '0xr', requestUrl: 'https://api.nansen.ai/test',
    });
    expect(finalizeIfPending(abandoned, { status: 'ambiguous', reason: 'abandoned' })).toBe(true);
    expect(getDailySpendState().totalUsd).toBeCloseTo(0.4, 6);

    // The ordinary path: the consumer already settled it, so the generator's
    // cleanup must neither double-count the spend nor append a second,
    // contradictory audit line.
    const settled = recordPaymentAttempt({
      provider: 'local', amountUsd: 0.4, network: 'eip155:8453', asset: '0xt',
      symbol: 'USDC', amountRaw: '400000', payTo: '0xr', requestUrl: 'https://api.nansen.ai/test',
    });
    finalizePaymentAttempt(settled, { status: 'accepted' });
    const auditLines = () => fs.readFileSync(path.join(tmpDir, '.nansen', 'x402', 'payments.jsonl'), 'utf8')
      .trim().split('\n').length;
    const before = auditLines();
    expect(finalizeIfPending(settled, { status: 'ambiguous', reason: 'abandoned' })).toBe(false);
    expect(auditLines()).toBe(before);
    expect(getDailySpendState().totalUsd).toBeCloseTo(0.8, 6);
  });

  it('releases a reservation from the day that authorized it, not the day cleanup runs', async () => {
    // A cap check at 23:59:55 writes its reservation into day 1's ledger. If the
    // payment is then abandoned a few seconds later — after midnight — cleanup
    // must still open day 1's file. Locating it by the current time would leave
    // the real reservation holding budget until its 15-minute TTL and refuse
    // otherwise-valid payments on the day that authorized them.
    process.env.NANSEN_X402_DAILY_MAX_AMOUNT = '1.00';
    const { assertCumulativeSpendAllowed, releasePaymentReservation, getDailySpendState, _resetSessionSpend } =
      await import('../x402-ledger.js');
    _resetSessionSpend();

    const ledgerDir = path.join(tmpDir, '.nansen', 'x402');
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-03-01T23:59:55Z'));
      const capCheck = assertCumulativeSpendAllowed({ amountUsd: 0.8 });
      expect(capCheck.ok).toBe(true);
      expect(capCheck.reservationId.startsWith('2026-03-01-')).toBe(true);
      expect(getDailySpendState().reservedUsd).toBeCloseTo(0.8, 6);

      // Signing fails just after midnight; the caller releases without knowing
      // which day's file holds the reservation.
      vi.setSystemTime(new Date('2026-03-02T00:00:05Z'));
      releasePaymentReservation(capCheck.reservationId);

      // Day 1's reservation is gone, so day 1's headroom is free again.
      const dayOne = JSON.parse(fs.readFileSync(path.join(ledgerDir, 'spend-2026-03-01.json'), 'utf8'));
      expect(dayOne.reservations).toBeUndefined();

      // And cleanup did not invent a day-2 file to delete a reservation from.
      expect(fs.existsSync(path.join(ledgerDir, 'spend-2026-03-02.json'))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('commits spend to the authorizing day when the reservation id is the only day left', async () => {
    // Same crossing, settled instead of abandoned: recordPaymentAttempt is called
    // without an explicit authorizedAt, so the id is what keeps the charge on the
    // day whose cap cleared it.
    process.env.NANSEN_X402_DAILY_MAX_AMOUNT = '1.00';
    const { assertCumulativeSpendAllowed, recordPaymentAttempt, finalizePaymentAttempt, _resetSessionSpend } =
      await import('../x402-ledger.js');
    _resetSessionSpend();

    const ledgerDir = path.join(tmpDir, '.nansen', 'x402');
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-03-01T23:59:55Z'));
      const capCheck = assertCumulativeSpendAllowed({ amountUsd: 0.5 });

      vi.setSystemTime(new Date('2026-03-02T00:00:30Z'));
      const id = recordPaymentAttempt({
        provider: 'local', amountUsd: 0.5, reservationId: capCheck.reservationId,
        network: 'eip155:8453', asset: '0xt', symbol: 'USDC', amountRaw: '500000',
        payTo: '0xr', requestUrl: 'https://api.nansen.ai/test',
      });
      finalizePaymentAttempt(id, { status: 'accepted' });
    } finally {
      vi.useRealTimers();
    }

    const files = fs.readdirSync(ledgerDir).filter((n) => n.startsWith('spend-'));
    expect(files).toEqual(['spend-2026-03-01.json']);
    const dayOne = JSON.parse(fs.readFileSync(path.join(ledgerDir, files[0]), 'utf8'));
    expect(dayOne.totalUsdMicros).toBe('500000');
    expect(dayOne.reservations).toBeUndefined();
  });

  it('getDailySpendState throws a typed X402LedgerError on a corrupt ledger', async () => {
    const { getDailySpendState, X402LedgerError } = await import('../x402-ledger.js');
    const ledgerDir = path.join(tmpDir, '.nansen', 'x402');
    fs.mkdirSync(ledgerDir, { recursive: true });
    const today = new Date();
    const yyyy = today.getUTCFullYear();
    const mm = String(today.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(today.getUTCDate()).padStart(2, '0');
    fs.writeFileSync(path.join(ledgerDir, `spend-${yyyy}-${mm}-${dd}.json`), 'NOT VALID JSON');

    expect(() => getDailySpendState()).toThrow(X402LedgerError);
    expect(() => getDailySpendState()).toThrow(/corrupt/i);
  });
});
