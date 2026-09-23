/**
 * x402 cumulative spend ledger and payment audit log.
 * Enforces daily and session caps; records signed/accepted/rejected/ambiguous payment attempts.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export const DEFAULT_DAILY_MAX_AMOUNT_USD = 10.0;
const MICRO_USD_SCALE = 1_000_000;
const LEDGER_LOCK_RETRY_MS = 25;
const LEDGER_LOCK_TIMEOUT_MS = 5_000;
const LEDGER_LOCK_STALE_MS = 30_000;

// Session accumulator — lives in process memory only
let sessionSpendMicros = 0n;

export class X402LedgerError extends Error {
  constructor(message) {
    super(message);
    this.name = 'X402LedgerError';
    this.failClosedX402 = true;
  }
}

export function resolveDailySpendCapUsd() {
  const env = process.env.NANSEN_X402_DAILY_MAX_AMOUNT;
  if (env !== undefined && env.trim() !== '') {
    if (env.trim().toLowerCase() === 'unlimited') return Infinity;
    const n = Number(env);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return DEFAULT_DAILY_MAX_AMOUNT_USD;
}

export function resolveSessionSpendCapUsd() {
  const env = process.env.NANSEN_X402_SESSION_MAX_AMOUNT;
  if (env !== undefined && env.trim() !== '') {
    if (env.trim().toLowerCase() === 'unlimited') return Infinity;
    const n = Number(env);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return Infinity;
}

function getLedgerDir() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  // Without a home directory, path.join would produce the relative path
  // `.nansen/x402` resolved against cwd — the ledger would land somewhere
  // unpredictable and the daily cap would silently read as $0. Fail closed
  // instead of computing a wrong path.
  if (!home) {
    throw new X402LedgerError(
      'Cannot locate the x402 spend ledger: no home directory (HOME/USERPROFILE unset). ' +
      '(fail-closed: not signing this payment)',
    );
  }
  return path.join(home, '.nansen', 'x402');
}

function getDailyFileName(now) {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  return `spend-${yyyy}-${mm}-${dd}.json`;
}

/**
 * Returns { totalUsd } for the current UTC day, or { totalUsd: 0 } if no ledger exists yet.
 * @throws {X402LedgerError} if the ledger file exists but cannot be read/parsed (fail-closed,
 *   consistent with assertCumulativeSpendAllowed — a corrupt ledger is never read as $0).
 */
export function getDailySpendState(now = new Date()) {
  const dir = getLedgerDir();
  const filePath = path.join(dir, getDailyFileName(now));
  if (!fs.existsSync(filePath)) return { totalUsd: 0 };
  try {
    return { totalUsd: microsToUsd(readDailySpendMicros(filePath)) };
  } catch {
    throw new X402LedgerError(
      `x402 daily spend ledger is corrupt and cannot be read safely. ` +
      `To reset: remove ${filePath}. (fail-closed: not reporting a spend total)`,
    );
  }
}

function usdToMicros(amountUsd) {
  if (!Number.isFinite(amountUsd) || amountUsd < 0) {
    throw new X402LedgerError(`Invalid x402 spend amount: ${amountUsd}`);
  }
  // x402 USD amounts are produced from bounded token base-unit integers or cap
  // env vars; round at the micro-USD boundary to absorb IEEE-754 representation
  // drift such as 0.1 * 1_000_000.
  return BigInt(Math.round(amountUsd * MICRO_USD_SCALE));
}

function microsToUsd(micros) {
  return Number(micros) / MICRO_USD_SCALE;
}

function readSpendMicrosFromData(data) {
  if (data && data.totalUsdMicros !== undefined) {
    const raw = String(data.totalUsdMicros);
    if (/^\d+$/.test(raw)) return BigInt(raw);
    throw new Error('Invalid totalUsdMicros');
  }
  if (data && data.totalUsd !== undefined) {
    return usdToMicros(Number(data.totalUsd));
  }
  return 0n;
}

function readDailySpendMicros(filePath) {
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return readSpendMicrosFromData(data);
}

/**
 * Returns { ok: true } if cumulative caps are satisfied, { ok: false, reason } otherwise.
 * Throws on corrupt ledger (fail-closed: a corrupt ledger must not silently disable the cap).
 */
export function assertCumulativeSpendAllowed({ amountUsd, now = new Date() }) {
  const amountMicros = usdToMicros(amountUsd);
  const sessionCap = resolveSessionSpendCapUsd();
  if (Number.isFinite(sessionCap) && sessionSpendMicros + amountMicros > usdToMicros(sessionCap)) {
    return {
      ok: false,
      reason:
        `Refusing to auto-pay: this payment would exceed the $${sessionCap.toFixed(2)} session x402 spend cap. ` +
        `To authorize, raise it with NANSEN_X402_SESSION_MAX_AMOUNT=<usd> or set NANSEN_X402_SESSION_MAX_AMOUNT=unlimited.`,
    };
  }

  const dailyCap = resolveDailySpendCapUsd();
  if (!Number.isFinite(dailyCap)) return { ok: true };

  const dir = getLedgerDir();
  const filePath = path.join(dir, getDailyFileName(now));
  let dailyTotal = 0n;
  if (fs.existsSync(filePath)) {
    try {
      dailyTotal = readDailySpendMicros(filePath);
    } catch {
      throw new X402LedgerError(
        `x402 daily spend ledger is corrupt and cannot be read safely. ` +
        `To reset: remove ${filePath}. (fail-closed: not signing this payment)`,
      );
    }
  }

  if (dailyTotal + amountMicros > usdToMicros(dailyCap)) {
    const capStr = `$${dailyCap.toFixed(2)}`;
    return {
      ok: false,
      reason:
        `Refusing to auto-pay: this payment would exceed the ${capStr} daily x402 spend cap. ` +
        `To authorize, raise it with NANSEN_X402_DAILY_MAX_AMOUNT=<usd> or set NANSEN_X402_DAILY_MAX_AMOUNT=unlimited.`,
    };
  }

  return { ok: true };
}

function ensureLedgerDir() {
  fs.mkdirSync(getLedgerDir(), { mode: 0o700, recursive: true });
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withLedgerLock(lockPath, fn) {
  const startedAt = Date.now();

  while (true) {
    let fd = null;
    try {
      fd = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeFileSync(fd, String(process.pid));
      try {
        return fn();
      } finally {
        fs.closeSync(fd);
        fd = null;
        try {
          fs.unlinkSync(lockPath);
        } catch { /* best-effort lock cleanup */ }
      }
    } catch (err) {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch { /* best-effort lock cleanup */ }
      }
      if (err.code !== 'EEXIST') throw err;

      let stale = false;
      try {
        stale = Date.now() - fs.statSync(lockPath).mtimeMs > LEDGER_LOCK_STALE_MS;
      } catch (statErr) {
        if (statErr.code !== 'ENOENT') throw statErr;
      }
      if (stale) {
        try {
          fs.unlinkSync(lockPath);
          continue;
        } catch { /* another process won the race; retry below */ }
      }

      if (Date.now() - startedAt > LEDGER_LOCK_TIMEOUT_MS) {
        throw new X402LedgerError(
          `x402 daily spend ledger is locked and cannot be updated safely. ` +
          `(fail-closed: preserving existing ledger)`,
        );
      }
      sleepSync(LEDGER_LOCK_RETRY_MS);
    }
  }
}

function appendAuditLine(record) {
  const dir = getLedgerDir();
  const auditFile = path.join(dir, 'payments.jsonl');
  if (fs.existsSync(auditFile)) {
    fs.chmodSync(auditFile, 0o600);
  }
  fs.appendFileSync(auditFile, JSON.stringify(record) + '\n', { mode: 0o600 });
}

// In-memory map: paymentId → amountUsd, held between recordPaymentAttempt and
// finalizePaymentAttempt (which increments the ledger).
// Callers MUST always call finalizePaymentAttempt for every id returned by
// recordPaymentAttempt (any terminal status) — that is the only thing that clears
// the entry. There is no self-cleanup; a caller that records but never finalizes
// leaks an entry for the life of the process.
const pendingAmounts = new Map();

/**
 * Record a signed payment attempt. Returns the generated paymentId.
 * Fields logged: id, timestamp, status, provider, walletLabel, network, asset, symbol,
 * amountUsd, amountRaw, payTo, requestUrl, httpStatus, requestId, reason.
 * Never logs signatures, API keys, or request bodies.
 */
export function recordPaymentAttempt(entry) {
  const id = crypto.randomBytes(16).toString('hex');
  // Sanitize URL: store only origin + pathname; omit query string
  let requestUrl = entry.requestUrl || null;
  if (requestUrl) {
    try {
      const u = new URL(requestUrl);
      requestUrl = u.origin + u.pathname;
    } catch { requestUrl = null; }
  }

  const record = {
    id,
    timestamp: new Date().toISOString(),
    status: 'signed',
    provider: entry.provider || null,
    walletLabel: entry.walletLabel || null,
    network: entry.network || null,
    asset: entry.asset || null,
    symbol: entry.symbol || null,
    amountUsd: entry.amountUsd ?? null,
    amountRaw: entry.amountRaw != null ? String(entry.amountRaw) : null,
    payTo: entry.payTo || null,
    requestUrl,
    httpStatus: null,
    requestId: null,
    reason: null,
  };

  try {
    ensureLedgerDir();
    appendAuditLine(record);
  } catch { /* best-effort audit */ }

  // Capture the day the payment was recorded (right after the cap check) so the
  // eventual ledger increment is attributed to that UTC day, not the day the
  // response happens to land on. Finalization can arrive seconds later, across a
  // midnight boundary, and must count against the day the guard authorized.
  if (entry.amountUsd !== undefined) pendingAmounts.set(id, { amountUsd: entry.amountUsd, recordedAt: new Date() });
  return id;
}

/**
 * Finalize a payment attempt (update audit log, increment spend ledger for accepted/ambiguous).
 * patch: { status, httpStatus?, requestId?, reason? }
 */
export function finalizePaymentAttempt(id, patch) {
  try {
    ensureLedgerDir();
    appendAuditLine({ id, timestamp: new Date().toISOString(), ...patch });
  } catch { /* best-effort audit */ }

  if (patch.status === 'accepted' || patch.status === 'ambiguous') {
    const pending = pendingAmounts.get(id);
    if (pending !== undefined) {
      const { amountUsd, recordedAt } = pending;
      try {
        incrementDailySpend(amountUsd, recordedAt);
        // Only advance the in-memory session total once the durable daily file
        // has actually been written. If the write failed (ENOSPC, permissions,
        // corrupt ledger), the daily total is unchanged; advancing session spend
        // here would silently diverge the two counters and, after a restart,
        // under-count the day's spend against the cap.
        sessionSpendMicros += usdToMicros(amountUsd);
      } catch (err) {
        console.error(`[x402] Warning: could not update daily spend ledger: ${err.message}`);
      }
    }
  }
  pendingAmounts.delete(id);
}

function incrementDailySpend(amountUsd, now = new Date()) {
  const dir = getLedgerDir();
  const filePath = path.join(dir, getDailyFileName(now));
  const lockPath = filePath + '.lock';
  const tmpPath = filePath + '.' + process.pid + '.tmp';

  const amountMicros = usdToMicros(amountUsd);
  ensureLedgerDir();
  withLedgerLock(lockPath, () => {
    let current = 0n;
    if (fs.existsSync(filePath)) {
      try {
        current = readDailySpendMicros(filePath);
      } catch {
        throw new X402LedgerError(
          `x402 daily spend ledger is corrupt and cannot be updated safely. ` +
          `To reset: remove ${filePath}. (fail-closed: preserving existing ledger)`,
        );
      }
    }

    const updated = { totalUsdMicros: (current + amountMicros).toString(), updatedAt: new Date().toISOString() };
    fs.writeFileSync(tmpPath, JSON.stringify(updated), { mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
  });
}

// Exported for tests only
export function _resetSessionSpend() {
  sessionSpendMicros = 0n;
}
