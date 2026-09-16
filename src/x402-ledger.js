/**
 * x402 cumulative spend ledger and payment audit log.
 * Enforces daily and session caps; records signed/accepted/rejected/ambiguous payment attempts.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export const DEFAULT_DAILY_MAX_AMOUNT_USD = 10.0;

// Session accumulator — lives in process memory only
let sessionSpendUsd = 0;

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
  return path.join(home, '.nansen', 'x402');
}

function getDailyFileName(now) {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  return `spend-${yyyy}-${mm}-${dd}.json`;
}

export function getDailySpendState(now = new Date()) {
  const dir = getLedgerDir();
  const filePath = path.join(dir, getDailyFileName(now));
  if (!fs.existsSync(filePath)) return { totalUsd: 0 };
  const raw = fs.readFileSync(filePath, 'utf8');
  const data = JSON.parse(raw); // intentional: callers handle thrown errors
  return { totalUsd: Number(data.totalUsd) || 0 };
}

/**
 * Returns { ok: true } if cumulative caps are satisfied, { ok: false, reason } otherwise.
 * Throws on corrupt ledger (fail-closed: a corrupt ledger must not silently disable the cap).
 */
export function assertCumulativeSpendAllowed({ amountUsd, now = new Date() }) {
  const sessionCap = resolveSessionSpendCapUsd();
  if (Number.isFinite(sessionCap) && sessionSpendUsd + amountUsd > sessionCap) {
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
  let dailyTotal = 0;
  if (fs.existsSync(filePath)) {
    let raw;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
      const data = JSON.parse(raw);
      dailyTotal = Number(data.totalUsd) || 0;
    } catch {
      throw new Error(
        `x402 daily spend ledger is corrupt and cannot be read safely. ` +
        `To reset: remove ${filePath}. (fail-closed: not signing this payment)`,
      );
    }
  }

  if (dailyTotal + amountUsd > dailyCap) {
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

function appendAuditLine(record) {
  const dir = getLedgerDir();
  const auditFile = path.join(dir, 'payments.jsonl');
  fs.appendFileSync(auditFile, JSON.stringify(record) + '\n', { mode: 0o600 });
}

// In-memory map: paymentId → amountUsd (for finalizePaymentAttempt to increment ledger)
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

  if (entry.amountUsd !== undefined) pendingAmounts.set(id, entry.amountUsd);
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
    const amountUsd = pendingAmounts.get(id);
    if (amountUsd !== undefined) {
      try {
        incrementDailySpend(amountUsd);
      } catch (err) {
        console.error(`[x402] Warning: could not update daily spend ledger: ${err.message}`);
      }
      sessionSpendUsd += amountUsd;
    }
  }
  pendingAmounts.delete(id);
}

function incrementDailySpend(amountUsd, now = new Date()) {
  const dir = getLedgerDir();
  const filePath = path.join(dir, getDailyFileName(now));
  const tmpPath = filePath + '.tmp';

  let current = 0;
  if (fs.existsSync(filePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      current = Number(data.totalUsd) || 0;
    } catch { /* start from 0 if corrupt */ }
  }

  const updated = { totalUsd: current + amountUsd, updatedAt: new Date().toISOString() };
  ensureLedgerDir();
  fs.writeFileSync(tmpPath, JSON.stringify(updated), { mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
}

// Exported for tests only
export function _resetSessionSpend() {
  sessionSpendUsd = 0;
}
