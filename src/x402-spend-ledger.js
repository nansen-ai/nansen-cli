/**
 * Persisted daily total of x402 auto-payments: ~/.nansen/x402/spend-YYYY-MM-DD.json.
 *
 * Shared by every CLI process on the machine, so the daily cap holds across
 * many short runs. A payment is counted when it is about to be signed, and
 * refunded only when nothing can settle it: signing failed or the server
 * cleanly rejected it. An abandoned or ambiguous payment stays counted, which
 * over-counts, the safe direction for a safety cap.
 *
 * Unlike the audit log, this is a safety control: any problem reading or
 * writing the ledger refuses the payment instead of skipping the cap.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { authDirectory } from './auth-credentials.js';
import { openLocalFile } from './local-file.js';
import { ensureDirectory, tightenDirectory, tightenIfOpen, withPrivateUmask } from './x402-audit.js';

const LOCK_TIMEOUT_MS = 2_000;
const LOCK_RETRY_MS = 10;
// The lock is held for a few synchronous file operations, so a lock this old
// was left by a process that died while holding it.
const STALE_LOCK_MS = 30_000;
const MAX_LEDGER_BYTES = 4_096;
const sleepCell = new Int32Array(new SharedArrayBuffer(4));

const refusal = message => new Error(`Refusing to auto-pay: ${message} No signature was produced.`);

/** "2026-10-16": the UTC day `now` falls in. */
export function utcDay(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/** Throws when no absolute home directory is known. */
export function x402SpendLedgerPath(now = new Date()) {
  return path.join(authDirectory(), 'x402', `spend-${utcDay(now)}.json`);
}

function x402SpendLockPath() {
  return path.join(authDirectory(), 'x402', 'spend.lock');
}

/** Create ~/.nansen/x402 as a private, link-free directory. */
function prepareDirectory(dir) {
  const stat = withPrivateUmask(() => {
    ensureDirectory(path.dirname(dir));
    return ensureDirectory(dir);
  });
  tightenDirectory(dir, stat);
}

const isStale = stat => stat && Date.now() - stat.mtimeMs > STALE_LOCK_MS;

/** Create `file` exclusively. O_EXCL never follows a symlink at that path. */
function createExclusive(file) {
  return withPrivateUmask(() => fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600));
}

/**
 * Remove the lock at `file` if it is stale. Checking and removing are two
 * steps, so two processes could both see the same stale lock, and the slower
 * one would remove the lock the faster one has just taken. Only the holder of
 * a second lock, `file`.break, may check and remove, so that can't happen.
 * Returns whether the lock was removed.
 */
function removeStaleLock(file) {
  const breaker = `${file}.break`;
  let fd;
  try {
    fd = createExclusive(breaker);
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    // Held for two file operations, so a stale one was left by a process that
    // died in between. Removing it is unguarded, but it needs that crash first.
    if (isStale(fs.lstatSync(breaker, { throwIfNoEntry: false }))) fs.rmSync(breaker, { force: true });
    return false;
  }
  try {
    if (!isStale(fs.lstatSync(file, { throwIfNoEntry: false }))) return false;
    fs.rmSync(file, { force: true });
    return true;
  } finally {
    releaseLock(breaker, fd);
  }
}

/**
 * Take the cross-process lock by creating the lock file exclusively, waiting
 * up to LOCK_TIMEOUT_MS. Returns the descriptor, which identifies this
 * holder's lock file.
 */
function acquireLock(file) {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      return createExclusive(file);
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    if (isStale(fs.lstatSync(file, { throwIfNoEntry: false })) && removeStaleLock(file)) continue;
    if (Date.now() >= deadline) {
      throw refusal(
        `timed out waiting for the x402 spend ledger lock ${file}. ` +
        'If no other nansen process is paying, delete that file and retry.',
      );
    }
    Atomics.wait(sleepCell, 0, 0, LOCK_RETRY_MS);
  }
}

/**
 * Remove the lock file only if it is still the one this holder created. It is
 * closed first: Windows can't fully remove a file that is still open, and a
 * process creating the lock meanwhile would get EPERM instead of EEXIST.
 */
function releaseLock(file, fd) {
  let mine;
  try {
    mine = fs.fstatSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const current = fs.lstatSync(file, { throwIfNoEntry: false });
  if (current && current.ino === mine.ino && current.dev === mine.dev) fs.rmSync(file, { force: true });
}

/** The day's total in micro-USD; 0 when no payment was counted yet. */
function readTotal(file, day) {
  let text;
  try {
    const fd = openLocalFile(file, { root: path.dirname(authDirectory()), maxBytes: MAX_LEDGER_BYTES });
    try { text = fs.readFileSync(fd, 'utf8'); } finally { fs.closeSync(fd); }
  } catch (err) {
    if (err.code === 'ENOENT') return 0n;
    throw refusal(`could not read the x402 daily spend ledger ${file} (${err.message}).`);
  }
  let data;
  try { data = JSON.parse(text); } catch { data = null; }
  if (!data || data.date !== day || typeof data.spentMicroUsd !== 'string' || !/^\d+$/.test(data.spentMicroUsd)) {
    throw refusal(
      `the x402 daily spend ledger ${file} is malformed. ` +
      "Fix it, or delete it to reset today's total.",
    );
  }
  return BigInt(data.spentMicroUsd);
}

/**
 * Flush a rename in `dir` to disk, so a crash can't bring back an older,
 * smaller total. Windows can't open a directory and doesn't need this.
 */
function syncDirectory(dir) {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(dir, fs.constants.O_RDONLY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/** Replace the ledger through a temp file and rename, so a reader never sees half a write. */
function writeTotal(file, day, total) {
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    const fd = withPrivateUmask(() => fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600));
    try {
      tightenIfOpen(fd, 0o600);
      fs.writeFileSync(fd, `${JSON.stringify({ date: day, spentMicroUsd: total.toString() })}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, file);
    syncDirectory(path.dirname(file));
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw refusal(`could not update the x402 daily spend ledger ${file} (${err.message}).`);
  }
}

/**
 * Run `update(spent)` on the total for the UTC day of `now`, as one critical
 * section under the lock, and save the total it returns, if any.
 */
function withDailyTotal(now, update) {
  let file;
  let lockFile;
  try {
    file = x402SpendLedgerPath(now);
    lockFile = x402SpendLockPath();
    prepareDirectory(path.dirname(file));
  } catch (err) {
    throw refusal(`could not prepare the x402 daily spend ledger${file ? ` ${file}` : ''} (${err.message}).`);
  }
  let lock;
  try {
    lock = acquireLock(lockFile);
  } catch (err) {
    if (err.message.startsWith('Refusing')) throw err;
    throw refusal(`could not lock the x402 daily spend ledger ${lockFile} (${err.message}).`);
  }
  try {
    const day = utcDay(now);
    const result = update(readTotal(file, day));
    if (result.save !== undefined) writeTotal(file, day, result.save);
    return result;
  } finally {
    // The outcome is decided and saved by now. A lock this fails to remove
    // goes stale and is taken over later.
    try { releaseLock(lockFile, lock); } catch { /* see above */ }
  }
}

/**
 * Add `micro` to the day's total unless that would exceed `cap`. Synchronous,
 * so the caller can start signing in the same tick. The UTC day is the one
 * `now` falls in.
 *
 * Returns { ok: true, spent } with the new total, or { ok: false, spent }
 * with the unchanged total when the cap refuses. Throws an Error with a
 * refusal message naming the file when the ledger can't be used.
 */
export function addToDailySpend(micro, cap, now = new Date()) {
  const { ok, spent } = withDailyTotal(now, spent =>
    spent + micro > cap ? { ok: false, spent } : { ok: true, spent: spent + micro, save: spent + micro });
  return { ok, spent };
}

/**
 * Take back `micro` added by addToDailySpend with the same `now`, for a
 * payment that can no longer settle. Never goes below zero. Throws like
 * addToDailySpend when the ledger can't be used.
 */
export function subtractFromDailySpend(micro, now) {
  withDailyTotal(now, spent => ({ save: spent > micro ? spent - micro : 0n }));
}
