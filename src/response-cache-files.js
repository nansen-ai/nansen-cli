/**
 * File-level housekeeping for the response cache directory (~/.nansen/cache),
 * shared by api.js (which writes entries) and cache-inspect.js (which clears
 * them). Imports nothing from either so both can use it without a cycle.
 *
 * Names in the directory:
 *   <sha256>.json                    a cache entry
 *   <sha256>.json.<pid>.<uuid>.tmp   a write in progress; renamed onto the
 *                                    entry when it completes, so a leftover one
 *                                    means the writing process was killed
 */

import fs from 'fs';
import path from 'path';

export const RESPONSE_ENTRY = /^[0-9a-f]{64}\.json$/;
export const RESPONSE_TEMP = /^[0-9a-f]{64}\.json\.\d+\.[0-9a-f-]{36}\.tmp$/;

// A write holds its temp file for milliseconds. Anything this old was left by
// a process that died before the rename.
export const STALE_TEMP_MS = 10 * 60 * 1000;

// Entries are never read back after their TTL (default 300s, set per call with
// --cache-ttl) and a read does not delete them, so without a sweep, requests
// that are never repeated leave files behind forever. The sweep after a cache
// write removes entries older than this, or older than the longest TTL the
// writing process has read with, whichever is longer.
export const ENTRY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** A temp file left behind by a write that never completed. */
export function isStaleTemp(name, stat, now = Date.now()) {
  return RESPONSE_TEMP.test(name) && now - stat.mtimeMs > STALE_TEMP_MS;
}

/**
 * Remove stale temp files and entries older than `retentionMs` (default
 * ENTRY_MAX_AGE_MS) from `dir`.
 * Only regular files whose names match the two shapes above are touched; a
 * symlinked or missing directory and symlinked entries are left alone.
 * Returns how many files were removed.
 *
 * Another process may rename a fresh entry onto a path between the lstat and
 * the unlink. That costs it one cache miss, never wrong data.
 */
export function pruneResponseCacheDir(dir, now = Date.now(), retentionMs = ENTRY_MAX_AGE_MS) {
  const dirStat = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (!dirStat || !dirStat.isDirectory()) return 0;
  let removed = 0;
  for (const name of fs.readdirSync(dir)) {
    const isEntry = RESPONSE_ENTRY.test(name);
    if (!isEntry && !RESPONSE_TEMP.test(name)) continue;
    const file = path.join(dir, name);
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat || !stat.isFile()) continue;
    const stale = isEntry ? now - stat.mtimeMs > retentionMs : isStaleTemp(name, stat, now);
    if (!stale) continue;
    try {
      fs.unlinkSync(file);
      removed += 1;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return removed;
}
