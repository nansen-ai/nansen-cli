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
// How long a reservation holds budget before other processes may reclaim it.
// It must comfortably exceed the slowest path from cap check to finalization —
// WalletConnect allows 120s of wallet approval before the request even goes out
// — because an early expiry would hand the same budget to a second process.
// It only matters when a process dies mid-payment: every ordinary outcome
// commits or releases the reservation explicitly.
const RESERVATION_TTL_MS = 15 * 60 * 1000;

// Session accumulators — live in process memory only.
// sessionSpendMicros is settled session spend; sessionReservations holds budget
// for in-flight payments (reservationId → micros), mirroring the daily file
// reservations but per-process. Without the reservation, two concurrent payments
// in the same process both read the same session total, both clear the cap, and
// their combined amount exceeds NANSEN_X402_SESSION_MAX_AMOUNT — the daily cap's
// reservation closes exactly this race, and the session cap needs its own.
let sessionSpendMicros = 0n;
const sessionReservations = new Map();

function sumSessionReservations() {
  let total = 0n;
  for (const micros of sessionReservations.values()) total += micros;
  return total;
}

function releaseSessionReservation(reservationId) {
  if (reservationId) sessionReservations.delete(reservationId);
}

// Set when a transmitted payment could not be written to the daily ledger. The
// amount is already on the wire but uncounted, so the daily total under-reports
// real spend and the cap can no longer be enforced. Every later cap check in
// this process fails closed until the operator resolves it.
// This latch only covers the current process; ACCOUNTING_FAILURE_FILE is its
// durable, cross-process twin.
let ledgerWriteFailure = null;

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

// Error-message helper only: getLedgerDir() throws without a home directory,
// and a cap-check failure message must never be masked by that.
function describeLedgerDirForMessage() {
  try {
    return getLedgerDir();
  } catch {
    return '~/.nansen/x402';
  }
}

function getUtcDayKey(now) {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function getDailyFileName(now) {
  return `spend-${getUtcDayKey(now)}.json`;
}

/**
 * A reservation id carries the UTC day of the cap check that created it:
 * `YYYY-MM-DD-<32 hex>`. A reservation lives in that day's ledger file, and
 * releasing or committing it must open that same file — a payment authorized
 * at 23:59:59 that is abandoned a second later would otherwise be looked up in
 * the next day's file, leaving the real reservation to hold budget until its
 * TTL and refusing valid payments on the day that actually authorized it.
 * Carrying the day in the id keeps every caller from having to pass it.
 */
function makeReservationId(now) {
  return `${getUtcDayKey(now)}-${crypto.randomBytes(16).toString('hex')}`;
}

/**
 * The UTC day a reservation id belongs to, or `fallback` for an id without one
 * (a reservation written by an older build, or a caller-supplied id in a test).
 */
function reservationDay(reservationId, fallback = new Date()) {
  const match = /^(\d{4})-(\d{2})-(\d{2})-[0-9a-f]{32}$/.exec(String(reservationId || ''));
  if (!match) return fallback;
  const parsed = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

// Durable record of spend that was transmitted but could never be counted.
// The in-memory latch above only blocks this process, and the daily reservation
// that keeps holding the budget meanwhile expires after RESERVATION_TTL_MS —
// after which another CLI process would reclaim budget for a payment that was
// really spent and exceed the cap. A line in this file outlives both, so every
// process fails closed until an operator reconciles and removes it.
const ACCOUNTING_FAILURE_FILE = 'accounting-failure.jsonl';

function getAccountingFailurePath() {
  return path.join(getLedgerDir(), ACCOUNTING_FAILURE_FILE);
}

function getAccountingFailurePathForMessage() {
  return path.join(describeLedgerDirForMessage(), ACCOUNTING_FAILURE_FILE);
}

/**
 * Append an accounting-failure line. Returns false if even this could not be
 * written. Best-effort by necessity — the write that just failed may have been
 * the disk itself — but the likelier causes (a lock timeout, a corrupt daily
 * file) leave this append perfectly possible, and then the cap survives.
 */
function recordAccountingFailure(detail) {
  try {
    ensureLedgerDir();
    fs.appendFileSync(getAccountingFailurePath(), JSON.stringify(detail) + '\n', { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns { filePath, count, uncountedUsd } if any accounting failure is on
 * record, else null. A malformed or unreadable file still counts as a failure:
 * its existence alone means spend accounting cannot be trusted.
 */
function readAccountingFailure() {
  const filePath = getAccountingFailurePath();
  if (!fs.existsSync(filePath)) return null;
  let count = 0;
  let uncountedUsd = 0;
  try {
    for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      count += 1;
      const amount = Number(JSON.parse(line).amountUsd);
      if (Number.isFinite(amount)) uncountedUsd += amount;
    }
  } catch { /* unreadable or malformed: the file being there is enough */ }
  return { filePath, count, uncountedUsd };
}

/**
 * Throws unless this machine's x402 spend accounting is known to be complete.
 * Checked before every cap decision: a cap computed from a total that is known
 * to under-count real spend is not a cap.
 */
function assertSpendAccountingIntact() {
  if (ledgerWriteFailure) {
    throw new X402LedgerError(
      `x402 spend accounting is incomplete: ${ledgerWriteFailure} ` +
      `The daily total under-counts that payment, so the daily cap cannot be enforced. ` +
      `To resume: check ${describeLedgerDirForMessage()} is writable, reconcile the daily total ` +
      `against payments.jsonl, then re-run. (fail-closed: not signing this payment)`,
    );
  }

  const failure = readAccountingFailure();
  if (failure) {
    const amount = failure.uncountedUsd > 0 ? ` totalling ~$${failure.uncountedUsd.toFixed(2)}` : '';
    throw new X402LedgerError(
      `x402 spend accounting is incomplete: ${failure.count} transmitted payment(s)${amount} could not be ` +
      `written to the daily spend ledger, so the daily total under-counts real spend and the cap cannot ` +
      `be enforced. To resume: reconcile the daily total in ${describeLedgerDirForMessage()} against ` +
      `payments.jsonl, then delete ${failure.filePath}. (fail-closed: not signing this payment)`,
    );
  }
}

/**
 * Returns { totalUsd, reservedUsd } for the current UTC day — settled spend and budget held by
 * in-flight payments — or zeros if no ledger exists yet.
 * @throws {X402LedgerError} if the ledger file exists but cannot be read/parsed (fail-closed,
 *   consistent with assertCumulativeSpendAllowed — a corrupt ledger is never read as $0).
 */
export function getDailySpendState(now = new Date()) {
  const dir = getLedgerDir();
  const filePath = path.join(dir, getDailyFileName(now));
  try {
    const { committedMicros, reservations } = readDailyLedger(filePath, now);
    return { totalUsd: microsToUsd(committedMicros), reservedUsd: microsToUsd(sumReservations(reservations)) };
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

// A ledger we wrote is always a JSON object; an array, a bare number or a
// string is not a ledger at all.
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The day's settled spend, or throw. Every shape this does not recognise is a
 * corrupt ledger, never $0: writeDailyLedger always emits `totalUsdMicros`, so
 * a file without a usable total is one we did not write, and reading it as zero
 * would silently hand back a full day's cap. `totalUsd` stays accepted for
 * ledgers written before the micro-USD field.
 */
function readSpendMicrosFromData(data) {
  if (!isPlainObject(data)) throw new Error('Ledger is not a JSON object');

  if (data.totalUsdMicros !== undefined) {
    const raw = String(data.totalUsdMicros);
    if (/^\d+$/.test(raw)) return BigInt(raw);
    throw new Error('Invalid totalUsdMicros');
  }

  if (data.totalUsd !== undefined) {
    // Not `Number(...)`: it maps null, '' and booleans onto real numbers, so a
    // `"totalUsd": null` would read as a legitimate $0.
    if (typeof data.totalUsd !== 'number' || !Number.isFinite(data.totalUsd) || data.totalUsd < 0) {
      throw new Error('Invalid totalUsd');
    }
    return usdToMicros(data.totalUsd);
  }

  throw new Error('Ledger has no spend total');
}

/**
 * Read a daily ledger file as { committedMicros, reservations }.
 * Reservations past their expiry are dropped here: a process that died between
 * reserving and finalizing must not hold budget for the rest of the day.
 * Throws (caller converts to X402LedgerError) on anything malformed.
 */
function readDailyLedger(filePath, now = new Date()) {
  if (!fs.existsSync(filePath)) return { committedMicros: 0n, reservations: new Map() };

  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const committedMicros = readSpendMicrosFromData(data);

  const reservations = new Map();
  // Absent is normal — writeDailyLedger omits the key once a day has no holds
  // left — but any other non-object value is corruption. Coercing it to "no
  // reservations" would drop every in-flight hold and hand the same headroom to
  // a concurrent process.
  if (data.reservations !== undefined && !isPlainObject(data.reservations)) {
    throw new Error('Invalid reservations');
  }
  const raw = data.reservations || {};
  for (const [reservationId, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== 'object') throw new Error('Invalid reservation');
    const micros = String(entry.micros);
    if (!/^\d+$/.test(micros)) throw new Error('Invalid reservation micros');
    const expiresAtMs = Date.parse(entry.expiresAt);
    if (!Number.isFinite(expiresAtMs)) throw new Error('Invalid reservation expiry');
    if (expiresAtMs <= now.getTime()) continue;
    reservations.set(reservationId, { micros: BigInt(micros), expiresAt: entry.expiresAt });
  }
  return { committedMicros, reservations };
}

function sumReservations(reservations) {
  let total = 0n;
  for (const reservation of reservations.values()) total += reservation.micros;
  return total;
}

function writeDailyLedger(filePath, { committedMicros, reservations }) {
  const tmpPath = filePath + '.' + process.pid + '.tmp';
  const data = { totalUsdMicros: committedMicros.toString(), updatedAt: new Date().toISOString() };
  // Omitted when empty so a settled day's file keeps its original shape.
  if (reservations.size > 0) {
    data.reservations = Object.fromEntries(
      [...reservations].map(([reservationId, r]) => [reservationId, { micros: r.micros.toString(), expiresAt: r.expiresAt }]),
    );
  }
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch { /* best-effort temp cleanup */ }
    throw err;
  }
}

/**
 * Read-modify-write the day's ledger under the lock. `mutate` receives the
 * parsed state and returns { value, write }; `write: false` leaves the file
 * untouched (used when a cap check refuses and nothing was reserved).
 *
 * `day` selects the file; `at` is the wall clock that decides which reservations
 * have expired. They are the same instant for a cap check, but not for cleanup
 * that runs after midnight on the previous day's file — pruning that file by its
 * own midnight would keep genuinely expired reservations alive.
 */
function mutateDailyLedger({ day, at = new Date(), failClosedNote, mutate }) {
  const filePath = path.join(getLedgerDir(), getDailyFileName(day));
  const lockPath = filePath + '.lock';
  ensureLedgerDir();
  return withLedgerLock(lockPath, () => {
    let state;
    try {
      state = readDailyLedger(filePath, at);
    } catch {
      throw new X402LedgerError(
        `x402 daily spend ledger is corrupt and cannot be read safely. ` +
        `To reset: remove ${filePath}. (fail-closed: ${failClosedNote})`,
      );
    }
    const { value, write } = mutate(state);
    if (write !== false) writeDailyLedger(filePath, state);
    return value;
  }, failClosedNote);
}

/**
 * Returns { ok: true, authorizedAt } if cumulative caps are satisfied, { ok: false, reason }
 * otherwise. Pass authorizedAt to recordPaymentAttempt so the spend is charged to the UTC day
 * this check cleared, not the day signing finished.
 * Throws on a corrupt ledger, an unresolvable home directory, or after a failed daily ledger
 * write (fail-closed: none of those may silently disable the cap).
 */
export function assertCumulativeSpendAllowed({ amountUsd, now = new Date() }) {
  assertSpendAccountingIntact();

  const amountMicros = usdToMicros(amountUsd);
  const sessionCap = resolveSessionSpendCapUsd();
  // Count in-flight session reservations, not just settled spend: like the daily
  // cap, checking settled spend alone is a time-of-check/time-of-use race — two
  // concurrent payments in this process both read the same total, both clear the
  // cap, and the serialized increments land above the limit the user set.
  if (Number.isFinite(sessionCap) &&
      sessionSpendMicros + sumSessionReservations() + amountMicros > usdToMicros(sessionCap)) {
    return {
      ok: false,
      reason:
        `Refusing to auto-pay: this payment would exceed the $${sessionCap.toFixed(2)} session x402 spend cap. ` +
        `To authorize, raise it with NANSEN_X402_SESSION_MAX_AMOUNT=<usd> or set NANSEN_X402_SESSION_MAX_AMOUNT=unlimited.`,
    };
  }

  const dailyCap = resolveDailySpendCapUsd();

  // One id covers both the in-memory session hold and the daily file reservation,
  // so finalize/release settle them together, and it carries the UTC day of this
  // check so both land in the ledger file that actually holds the reservation.
  const reservationId = makeReservationId(now);

  // authorizedAt pins the UTC day whose cap this check cleared. Signing can take
  // seconds (local), or minutes of user approval (WalletConnect), so the day the
  // payment is finally recorded is not reliably the day that authorized it.
  if (!Number.isFinite(dailyCap)) {
    sessionReservations.set(reservationId, amountMicros);
    return { ok: true, authorizedAt: now, reservationId };
  }

  // Check and reserve the daily budget in one locked read-modify-write, for the
  // same TOCTOU reason as the session cap above — here the race is across
  // concurrent CLI processes, which the file lock plus the reservation close.
  const result = mutateDailyLedger({
    day: now,
    at: now,
    failClosedNote: 'not signing this payment',
    mutate: (state) => {
      const committedAndHeld = state.committedMicros + sumReservations(state.reservations);
      if (committedAndHeld + amountMicros > usdToMicros(dailyCap)) {
        const capStr = `$${dailyCap.toFixed(2)}`;
        return {
          write: false,
          value: {
            ok: false,
            reason:
              `Refusing to auto-pay: this payment would exceed the ${capStr} daily x402 spend cap. ` +
              `To authorize, raise it with NANSEN_X402_DAILY_MAX_AMOUNT=<usd> or set NANSEN_X402_DAILY_MAX_AMOUNT=unlimited.`,
          },
        };
      }

      state.reservations.set(reservationId, {
        micros: amountMicros,
        expiresAt: new Date(now.getTime() + RESERVATION_TTL_MS).toISOString(),
      });
      return { value: { ok: true, authorizedAt: now, reservationId } };
    },
  });

  // Take the session hold only once the daily reservation is committed, under the
  // same id. A refused or throwing daily check leaves no session hold behind.
  if (result.ok) sessionReservations.set(reservationId, amountMicros);
  return result;
}

function ensureLedgerDir() {
  fs.mkdirSync(getLedgerDir(), { mode: 0o700, recursive: true });
}

// Node.js main thread only — Atomics.wait blocks here, but returns 'not-equal'
// without sleeping in Worker threads or non-Node runtimes.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withLedgerLock(lockPath, fn, failClosedNote = 'preserving existing ledger') {
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
          `(fail-closed: ${failClosedNote})`,
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
    try {
      fs.chmodSync(auditFile, 0o600);
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'EPERM') throw err;
    }
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
 * Fields logged: id, timestamp, authorizedAt, status, provider, walletLabel, network, asset,
 * symbol, amountUsd, amountRaw, payTo, requestUrl, httpStatus, requestId, reason.
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

  // The day the cap check cleared, not the day signing happened to finish.
  const authorizedAt = entry.authorizedAt instanceof Date ? entry.authorizedAt : new Date();

  const record = {
    id,
    timestamp: new Date().toISOString(),
    authorizedAt: authorizedAt.toISOString(),
    status: 'signed',
    provider: entry.provider || null,
    walletLabel: entry.walletLabel || null,
    reservationId: entry.reservationId || null,
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

  // Carry the authorization day through to the ledger increment so the spend is
  // attributed to the UTC day whose cap allowed it. Signing and the server
  // response can both land on the next day — with WalletConnect, minutes of user
  // approval sit between the cap check and this line — and neither may silently
  // move the charge onto a day that never authorized it.
  if (entry.amountUsd !== undefined || entry.reservationId) {
    pendingAmounts.set(id, {
      amountUsd: entry.amountUsd,
      recordedAt: authorizedAt,
      reservationId: entry.reservationId || null,
    });
  }
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

  const pending = pendingAmounts.get(id);
  if (pending !== undefined) {
    const { amountUsd, recordedAt, reservationId } = pending;
    const settled = patch.status === 'accepted' || patch.status === 'ambiguous';

    if (settled && amountUsd !== undefined) {
      try {
        commitDailySpend(amountUsd, recordedAt, reservationId);
        // Only advance the in-memory session total once the durable daily file
        // has actually been written. If the write failed (ENOSPC, permissions,
        // corrupt ledger), the daily total is unchanged; advancing session spend
        // here would silently diverge the two counters and, after a restart,
        // under-count the day's spend against the cap.
        sessionSpendMicros += usdToMicros(amountUsd);
      } catch (err) {
        // The payment is already transmitted — it cannot be unsent, so this
        // attempt cannot fail closed. The next one can, and must: the daily
        // total now under-counts real spend by this amount. The daily
        // reservation is left in place deliberately; until it expires it holds
        // roughly the right amount of budget against other processes.
        ledgerWriteFailure =
          `a $${Number(amountUsd).toFixed(2)} payment was transmitted but could not be written ` +
          `to the daily spend ledger (${err.message}).`;
        // The latch above dies with this process and the reservation that stands
        // in for it expires, so persist the failure too: without it the next CLI
        // run reclaims budget that was genuinely spent.
        const durable = recordAccountingFailure({
          at: new Date().toISOString(),
          pid: process.pid,
          amountUsd: Number(amountUsd),
          // The file commitDailySpend actually targeted, so the operator
          // reconciles against the right day's total.
          day: getDailyFileName(reservationDay(reservationId, recordedAt instanceof Date ? recordedAt : new Date())),
          reservationId: reservationId || null,
          paymentId: id,
          reason: err.message,
        });
        console.error(
          `[x402] Warning: could not update daily spend ledger: ${err.message} ` +
          (durable
            ? `Further x402 payments are blocked on this machine until ${getAccountingFailurePathForMessage()} ` +
              `is reconciled and removed, because the daily cap can no longer be enforced.`
            : `The failure could not be persisted either, so only this process is blocked; ` +
              `other x402 processes may still exceed the daily cap until the ledger is writable again.`),
        );
      } finally {
        // Resolve the per-process session hold either way: on success the spend
        // above replaces it; on failure the fail-closed latch — not this hold —
        // is what blocks further payments, so keeping it would only pin session
        // budget for the life of the process.
        releaseSessionReservation(reservationId);
      }
    } else if (reservationId) {
      // Rejected, or settled with no amount to charge: nothing was spent, so the
      // held budget — session and daily — goes back rather than waiting out its TTL.
      releaseSessionReservation(reservationId);
      try {
        releaseDailyReservation(reservationId, recordedAt);
      } catch (err) {
        console.error(
          `[x402] Warning: could not release the daily spend reservation: ${err.message} ` +
          `It expires on its own; until then this budget stays held.`,
        );
      }
    }
  }
  pendingAmounts.delete(id);
}

/**
 * Finalize `id` only if it has not been finalized already; returns whether it did.
 *
 * The payment generators hand a signed payment to their consumer and cannot see
 * what the consumer did with it: on every ordinary path the consumer settles it
 * (_x402Retry finalizes at each of its terminal branches), but a consumer that
 * walks away — `break`/`return` out of the `for await`, which cancels the
 * generator via iterator.return() — settles nothing. The generators call this on
 * the way out: a no-op after an ordinary outcome, and the ambiguous finalization
 * that releases the held budget when the payment was abandoned mid-flight.
 */
export function finalizeIfPending(id, patch) {
  if (!id || !pendingAmounts.has(id)) return false;
  finalizePaymentAttempt(id, patch);
  return true;
}

// Turn the reservation this payment holds into settled spend. Dropping the
// reservation in the same locked write keeps the budget from being counted
// twice — once as held, once as spent.
function commitDailySpend(amountUsd, now = new Date(), reservationId = null) {
  const amountMicros = usdToMicros(amountUsd);
  mutateDailyLedger({
    // Both are the authorizing day by construction; the id is the stronger of
    // the two, since it is the day the reservation was actually written under.
    day: reservationDay(reservationId, now),
    failClosedNote: 'preserving existing ledger',
    mutate: (state) => {
      if (reservationId) state.reservations.delete(reservationId);
      state.committedMicros += amountMicros;
      return { value: undefined };
    },
  });
}

// Hand budget back when a payment ends without settling (a clean rejection, or
// a provider that abandoned the attempt before signing).
function releaseDailyReservation(reservationId, now = new Date()) {
  if (!reservationId) return;
  mutateDailyLedger({
    day: reservationDay(reservationId, now),
    failClosedNote: 'preserving existing ledger',
    mutate: (state) => {
      if (!state.reservations.delete(reservationId)) return { value: false, write: false };
      return { value: true };
    },
  });
}

/**
 * Release budget held by a cap check whose payment was never attempted — a
 * provider that skipped the option or failed before signing. Without this the
 * reservation would hold budget until RESERVATION_TTL_MS elapses.
 * The day is read from the reservation id, so callers never pass `now` — it is
 * only a fallback for an id that does not carry one.
 * Best-effort: the TTL is the backstop, so a failure here is never fatal.
 */
export function releasePaymentReservation(reservationId, now = new Date()) {
  if (!reservationId) return;
  // Hand back both holds the cap check took: the in-memory session reservation
  // and the daily file reservation.
  releaseSessionReservation(reservationId);
  try {
    releaseDailyReservation(reservationId, now);
  } catch { /* best-effort: the reservation expires on its own */ }
}

// Exported for tests only
export function _resetSessionSpend() {
  sessionSpendMicros = 0n;
  sessionReservations.clear();
}

// Exported for tests only — clears the fail-closed latch set by a failed daily
// ledger write. There is deliberately no runtime path that clears it: the
// operator resolves the underlying write failure and re-runs.
export function _clearLedgerWriteFailure() {
  ledgerWriteFailure = null;
  try {
    fs.rmSync(getAccountingFailurePath(), { force: true });
  } catch { /* nothing to clear */ }
}
