import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { addToDailySpend, subtractFromDailySpend, utcDay, x402SpendLedgerPath } from '../x402-spend-ledger.js';

const posix = process.platform !== 'win32';
const mode = file => fs.statSync(file).mode & 0o777;
const NOW = new Date('2026-10-16T12:00:00Z');
const readLedger = (now = NOW) => JSON.parse(fs.readFileSync(x402SpendLedgerPath(now), 'utf8'));
const lockPath = () => path.join(path.dirname(x402SpendLedgerPath(NOW)), 'spend.lock');
const makeStale = file => {
  const minuteAgo = new Date(Date.now() - 60_000);
  fs.utimesSync(file, minuteAgo, minuteAgo);
};

describe('x402 daily spend ledger', () => {
  let originalHome;
  let home;

  beforeEach(() => {
    originalHome = process.env.HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'nansen-x402-ledger-'));
    process.env.HOME = home;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('keeps one file per UTC day under ~/.nansen/x402', () => {
    expect(x402SpendLedgerPath(NOW)).toBe(path.join(home, '.nansen', 'x402', 'spend-2026-10-16.json'));
    // 23:30 on the 16th in UTC-5 is already the 17th in UTC.
    expect(utcDay(new Date('2026-10-16T23:30:00-05:00'))).toBe('2026-10-17');
  });

  it('records the running total and releases the lock', () => {
    expect(addToDailySpend(10_000n, 1_000_000n, NOW)).toEqual({ ok: true, spent: 10_000n });
    expect(addToDailySpend(20_000n, 1_000_000n, NOW)).toEqual({ ok: true, spent: 30_000n });

    expect(readLedger()).toEqual({ date: '2026-10-16', spentMicroUsd: '30000' });
    expect(fs.existsSync(lockPath())).toBe(false);
    expect(fs.readdirSync(path.dirname(lockPath()))).toEqual(['spend-2026-10-16.json']);
  });

  it.runIf(posix)('creates the directory as 0700 and the ledger as 0600', () => {
    addToDailySpend(1n, 10n, NOW);
    expect(mode(path.dirname(x402SpendLedgerPath(NOW)))).toBe(0o700);
    expect(mode(x402SpendLedgerPath(NOW))).toBe(0o600);
  });

  it('allows a payment that reaches the cap exactly, then refuses without changing the total', () => {
    expect(addToDailySpend(600_000n, 1_000_000n, NOW).ok).toBe(true);
    expect(addToDailySpend(400_000n, 1_000_000n, NOW)).toEqual({ ok: true, spent: 1_000_000n });
    expect(addToDailySpend(1n, 1_000_000n, NOW)).toEqual({ ok: false, spent: 1_000_000n });
    expect(readLedger().spentMicroUsd).toBe('1000000');
  });

  it('takes a payment back off the day it was counted on, never below zero', () => {
    const lastSecond = new Date('2026-10-16T23:59:59.999Z');
    expect(addToDailySpend(30_000n, 1_000_000n, lastSecond).ok).toBe(true);
    expect(addToDailySpend(5_000n, 1_000_000n, new Date('2026-10-17T00:00:00Z')).ok).toBe(true);

    subtractFromDailySpend(10_000n, lastSecond);
    expect(readLedger(lastSecond).spentMicroUsd).toBe('20000');
    expect(readLedger(new Date('2026-10-17T00:00:00Z')).spentMicroUsd).toBe('5000');

    subtractFromDailySpend(50_000n, lastSecond);
    expect(readLedger(lastSecond).spentMicroUsd).toBe('0');
    expect(fs.existsSync(lockPath())).toBe(false);
  });

  it('starts a new total when the UTC day changes', () => {
    const lastSecond = new Date('2026-10-16T23:59:59.999Z');
    const midnight = new Date('2026-10-17T00:00:00.000Z');
    expect(addToDailySpend(1_000_000n, 1_000_000n, lastSecond).ok).toBe(true);
    expect(addToDailySpend(1n, 1_000_000n, lastSecond).ok).toBe(false);

    expect(addToDailySpend(1_000_000n, 1_000_000n, midnight)).toEqual({ ok: true, spent: 1_000_000n });
    expect(readLedger(lastSecond).spentMicroUsd).toBe('1000000');
    expect(readLedger(midnight)).toEqual({ date: '2026-10-17', spentMicroUsd: '1000000' });
  });

  it.each([
    ['not JSON', 'garbage'],
    ['a negative total', JSON.stringify({ date: '2026-10-16', spentMicroUsd: '-5' })],
    ['a numeric total', JSON.stringify({ date: '2026-10-16', spentMicroUsd: 5 })],
    ["another day's total", JSON.stringify({ date: '2026-10-15', spentMicroUsd: '0' })],
  ])('refuses, naming the file, when the ledger holds %s', (_label, contents) => {
    addToDailySpend(1n, 10n, NOW);
    fs.writeFileSync(x402SpendLedgerPath(NOW), contents);

    expect(() => addToDailySpend(1n, 10n, NOW)).toThrow(
      `Refusing to auto-pay: the x402 daily spend ledger ${x402SpendLedgerPath(NOW)} is malformed. ` +
      "Fix it, or delete it to reset today's total. No signature was produced.",
    );
    expect(fs.existsSync(lockPath())).toBe(false);
  });

  it.runIf(posix)('refuses a symlinked ledger instead of following it', () => {
    addToDailySpend(1n, 10n, NOW);
    const elsewhere = path.join(home, 'elsewhere.json');
    fs.writeFileSync(elsewhere, JSON.stringify({ date: '2026-10-16', spentMicroUsd: '0' }));
    fs.rmSync(x402SpendLedgerPath(NOW));
    fs.symlinkSync(elsewhere, x402SpendLedgerPath(NOW));

    expect(() => addToDailySpend(1n, 10n, NOW)).toThrow(/^Refusing to auto-pay: could not read the x402 daily spend ledger .*spend-2026-10-16\.json/);
  });

  it.runIf(posix)('refuses a symlinked x402 directory', () => {
    const elsewhere = fs.mkdtempSync(path.join(home, 'elsewhere-'));
    fs.mkdirSync(path.join(home, '.nansen'));
    fs.symlinkSync(elsewhere, path.join(home, '.nansen', 'x402'));

    expect(() => addToDailySpend(1n, 10n, NOW)).toThrow(/^Refusing to auto-pay: could not prepare the x402 daily spend ledger/);
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });

  it('times out on a lock another process holds, naming the lock file', () => {
    addToDailySpend(1n, 10n, NOW);
    fs.writeFileSync(lockPath(), '');

    const started = Date.now();
    expect(() => addToDailySpend(1n, 10n, NOW)).toThrow(
      `Refusing to auto-pay: timed out waiting for the x402 spend ledger lock ${lockPath()}. ` +
      'If no other nansen process is paying, delete that file and retry. No signature was produced.',
    );
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_900);
    expect(fs.existsSync(lockPath())).toBe(true); // not ours to remove
    expect(readLedger().spentMicroUsd).toBe('1');
  });

  it('takes over a stale lock left by a process that died holding it', () => {
    addToDailySpend(1n, 10n, NOW);
    fs.writeFileSync(lockPath(), '');
    makeStale(lockPath());

    expect(addToDailySpend(1n, 10n, NOW)).toEqual({ ok: true, spent: 2n });
    expect(fs.readdirSync(path.dirname(lockPath()))).toEqual(['spend-2026-10-16.json']);
  });

  it('leaves a stale lock alone while another process is taking it over', () => {
    addToDailySpend(1n, 10n, NOW);
    fs.writeFileSync(lockPath(), '');
    makeStale(lockPath());
    fs.writeFileSync(`${lockPath()}.break`, '');

    expect(() => addToDailySpend(1n, 10n, NOW)).toThrow(/timed out waiting for the x402 spend ledger lock/);
    expect(fs.existsSync(lockPath())).toBe(true);
    expect(readLedger().spentMicroUsd).toBe('1');
  });

  it('removes a takeover lock left by a process that died taking over', () => {
    addToDailySpend(1n, 10n, NOW);
    fs.writeFileSync(lockPath(), '');
    makeStale(lockPath());
    fs.writeFileSync(`${lockPath()}.break`, '');
    makeStale(`${lockPath()}.break`);

    expect(addToDailySpend(1n, 10n, NOW)).toEqual({ ok: true, spent: 2n });
    expect(fs.readdirSync(path.dirname(lockPath()))).toEqual(['spend-2026-10-16.json']);
  });

  it('never lets concurrent processes together pass the cap when taking over a stale lock', async () => {
    const run = promisify(execFile);
    const ledger = new URL('../x402-spend-ledger.js', import.meta.url).href;
    addToDailySpend(0n, 1n, NOW);
    fs.writeFileSync(lockPath(), '');
    makeStale(lockPath());
    const script = `
      const { addToDailySpend } = await import(${JSON.stringify(ledger)});
      const result = addToDailySpend(1000000n, 5000000n, new Date(${JSON.stringify(NOW.toISOString())}));
      process.stdout.write(String(result.ok));
    `;
    const outputs = await Promise.all(Array.from({ length: 8 }, () =>
      run(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, HOME: home } })));

    expect(outputs.map(o => o.stdout).filter(ok => ok === 'true')).toHaveLength(5);
    expect(readLedger().spentMicroUsd).toBe('5000000');
  });

  it('never lets concurrent processes together pass the cap', async () => {
    const run = promisify(execFile);
    const ledger = new URL('../x402-spend-ledger.js', import.meta.url).href;
    // Each process tries to add $1 under a $5 cap.
    const script = `
      const { addToDailySpend } = await import(${JSON.stringify(ledger)});
      const result = addToDailySpend(1000000n, 5000000n, new Date(${JSON.stringify(NOW.toISOString())}));
      process.stdout.write(String(result.ok));
    `;
    const outputs = await Promise.all(Array.from({ length: 8 }, () =>
      run(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, HOME: home } })));

    expect(outputs.map(o => o.stdout).filter(ok => ok === 'true')).toHaveLength(5);
    expect(readLedger().spentMicroUsd).toBe('5000000');
  });
});
