/**
 * Persisted daily total of x402 auto-payments: ~/.nansen/x402/spend-YYYY-MM-DD.json.
 *
 * Shared by every CLI process on the machine, so the daily cap holds across
 * many short runs. A payment is counted when it is about to be signed and is
 * never refunded: a payment that is later rejected, abandoned or fails to sign
 * still counts. That over-counts by design, the safe direction for a safety
 * cap. Exact accounting would need reservations and settle-time refunds.
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

/**
 * Take the cross-process lock by creating the lock file exclusively, waiting
 * up to LOCK_TIMEOUT_MS. O_EXCL never follows a symlink at the lock path.
 * Returns the descriptor, which identifies this holder's lock file.
 */
function acquireLock(file) {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      return withPrivateUmask(() => fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600));
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    const held = fs.lstatSync(file, { throwIfNoEntry: false });
    if (held && Date.now() - held.mtimeMs > STALE_LOCK_MS) {
      // Two processes can both find the same stale lock; the inode check
      // keeps either one from removing a lock the other has just taken.
      const current = fs.lstatSync(file, { throwIfNoEntry: false });
      if (current && current.ino === held.ino) fs.rmSync(file, { force: true });
      continue;
    }
    if (Date.now() >= deadline) {
      throw refusal(
        `timed out waiting for the x402 spend ledger lock ${file}. ` +
        'If no other nansen process is paying, delete that file and retry.',
      );
    }
    Atomics.wait(sleepCell, 0, 0, LOCK_RETRY_MS);
  }
}

/** Remove the lock file only if it is still the one this holder created. */
function releaseLock(file, fd) {
  try {
    const mine = fs.fstatSync(fd);
    const current = fs.lstatSync(file, { throwIfNoEntry: false });
    if (current && current.ino === mine.ino && current.dev === mine.dev) fs.rmSync(file, { force: true });
  } finally {
    fs.closeSync(fd);
  }
}

/** The day's total in micro-USD; 0 when no payment was counted yet. */
function readTotal(file, day) {
  let text;
  try {
    const fd = openLocalFile(file, { root: path.dirname(path.dirname(path.dirname(file))), maxBytes: MAX_LEDGER_BYTES });
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
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw refusal(`could not update the x402 daily spend ledger ${file} (${err.message}).`);
  }
}

/**
 * Add `micro` to today's total unless that would exceed `cap`, as one
 * critical section under the lock. Synchronous, so the caller can start
 * signing in the same tick. The UTC day is fixed when the lock is taken.
 *
 * Returns { ok: true, spent } with the new total, or { ok: false, spent }
 * with the unchanged total when the cap refuses. Throws an Error with a
 * refusal message naming the file when the ledger can't be used.
 */
export function addToDailySpend(micro, cap, now = new Date()) {
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
    const spent = readTotal(file, day);
    if (spent + micro > cap) return { ok: false, spent };
    writeTotal(file, day, spent + micro);
    return { ok: true, spent: spent + micro };
  } finally {
    releaseLock(lockFile, lock);
  }
}
