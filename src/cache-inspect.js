/**
 * Cache inspection and invalidation — the read and clear side of the caches
 * the CLI already keeps under ~/.nansen. This module owns no cache of its own
 * and never writes an entry; it only reports and deletes.
 *
 *   responses     ~/.nansen/cache/<digest>.json  (api.js)          TTL --cache-ttl, default 300s
 *   cost-map      ~/.nansen/cost-map.json        (cost-cache.js)   TTL 24h
 *   update-check  ~/.nansen/update-check.json    (update-check.js) TTL 24h
 *
 * Privacy: stats extract each cache's timestamp metadata and never retain or
 * render payload fields. Response cache filenames are digests of the request,
 * and they are not printed either.
 *
 * Safety: clearing only ever unlinks regular files at the three paths above —
 * `.json` entries directly inside the response cache directory, and the two
 * named files. Directories and symlinks are skipped rather than followed, so a
 * clear cannot reach outside the cache it was pointed at. Everything else under
 * ~/.nansen (config.json, wallets/, quotes/, telemetry-id, saved auth) is never
 * read or deleted by the inspector. CLI startup loads config separately.
 */

import fs from 'fs';
import path from 'path';

import { getCacheDir, getConfigDir, DEFAULT_CACHE_TTL, NansenError, ErrorCode } from './api.js';
import { getCostMapFile, COST_MAP_TTL_MS } from './cost-cache.js';
import { getUpdateCheckFile, UPDATE_CHECK_TTL_MS } from './update-check.js';

const SECOND = 1000;
const RESPONSE_ENTRY = /^[0-9a-f]{64}\.json$/;

/** Cache names, in report order. */
export const CACHE_NAMES = ['responses', 'cost-map', 'update-check'];

/** Accepted `nansen cache clear` targets. */
export const CLEAR_TARGETS = [...CACHE_NAMES, 'all'];

/**
 * Descriptors for the known caches. Built per call rather than once at import
 * so the paths always come from the modules that own them.
 */
function namespaces() {
  return [
    {
      name: 'responses',
      label: 'response cache',
      description: 'API responses saved when --cache is passed',
      kind: 'dir',
      dirOrFile: getCacheDir(),
      // The effective TTL is chosen per invocation by --cache-ttl.
      ttlSeconds: null,
    },
    {
      name: 'cost-map',
      label: 'credit cost map',
      description: 'per-endpoint credit costs used to report what a call cost',
      kind: 'file',
      dirOrFile: getCostMapFile(),
      timestampField: 'fetchedAt',
      ttlSeconds: COST_MAP_TTL_MS / SECOND,
    },
    {
      name: 'update-check',
      label: 'update check',
      description: 'latest published CLI version, for the upgrade notice',
      kind: 'file',
      dirOrFile: getUpdateCheckFile(),
      timestampField: 'checkedAt',
      ttlSeconds: UPDATE_CHECK_TTL_MS / SECOND,
    },
  ];
}

/**
 * Regular digest-named `.json` files directly inside `dir`, with size and,
 * when requested, timestamp metadata. A missing directory is an empty cache,
 * not an error. lstat (not stat) means symlinked entries are skipped; the
 * directory itself is also rejected if it is a symlink.
 */
function fsError(action, target, error) {
  const detail = error?.code ? `[${error.code}] ${error.message}` : String(error);
  return new Error(`Cannot ${action} cache path ${target}: ${detail}`);
}

function readTimestamp(file, field) {
  let fd;
  let raw;
  try {
    // O_NOFOLLOW prevents a final-component symlink replacement after lstat.
    // Windows does not define it. There, only the earlier lstat check applies;
    // opening with O_RDONLY does not prevent this race.
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
    fd = fs.openSync(file, flags);
    if (!fs.fstatSync(fd).isFile()) return { raced: true };
    raw = fs.readFileSync(fd, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ELOOP') return { raced: true };
    throw fsError('read', file, error);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  try {
    const value = JSON.parse(raw)?.[field];
    return { timestampMs: Number.isFinite(value) ? value : null };
  } catch {
    // A corrupt cache is dead to its owner and therefore already expired.
    return { timestampMs: null };
  }
}

function listDirEntries(dir, { readMetadata = false } = {}) {
  let names;
  try {
    const dirStat = fs.lstatSync(dir);
    if (dirStat.isSymbolicLink()) {
      throw new Error(`Refusing to use symlinked response cache directory: ${dir}`);
    }
    if (!dirStat.isDirectory()) {
      throw new Error(`Response cache path is not a directory: ${dir}`);
    }
    names = fs.readdirSync(dir);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    if (error?.message?.startsWith('Refusing') || error?.message?.startsWith('Response cache')) throw error;
    throw fsError('list', dir, error);
  }
  const entries = [];
  for (const name of names) {
    // `name` comes from this directory's own listing, not from a caller. The
    // strict digest shape both identifies files written by api.js and prevents
    // path separators or traversal segments from reaching path.join(). The
    // lstat below then rejects a final-component symlink before any read/delete.
    if (!RESPONSE_ENTRY.test(name)) continue;
    const file = path.join(dir, name);
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile()) continue;
      const metadata = readMetadata ? readTimestamp(file, 'timestamp') : {};
      if (metadata.raced) continue;
      entries.push({ file, bytes: stat.size, ...metadata });
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
  }
  return entries;
}

/** The single file of a one-file cache, or nothing if it is absent. */
function listFileEntry(file, timestampField, { readMetadata = false } = {}) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) return [];
    const metadata = readMetadata ? readTimestamp(file, timestampField) : {};
    if (metadata.raced) return [];
    return [{ file, bytes: stat.size, ...metadata }];
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

function listEntries(ns, options) {
  return ns.kind === 'dir'
    ? listDirEntries(ns.dirOrFile, options)
    : listFileEntry(ns.dirOrFile, ns.timestampField, options);
}

/**
 * What every cache holds right now: entry count, bytes on disk, the age of the
 * oldest and newest entry, the effective TTL, and how many entries are already
 * past it. `responseTtlSeconds` is the TTL this invocation would apply
 * (--cache-ttl), so the expiry count matches what the next call would see.
 */
export function collectCacheStats({ responseTtlSeconds = DEFAULT_CACHE_TTL, now = Date.now() } = {}) {
  const caches = [];
  let totalEntries = 0;
  let totalBytes = 0;

  for (const ns of namespaces()) {
    const entries = listEntries(ns, { readMetadata: true });
    const ttlSeconds = ns.name === 'responses' ? responseTtlSeconds : ns.ttlSeconds;
    // A file stamped in the future (clock skew) is 0s old, never negative.
    const rawAges = entries.map(e => e.timestampMs == null ? null : Math.max(0, (now - e.timestampMs) / SECOND));
    let oldestAge = null;
    let newestAge = null;
    for (const age of rawAges) {
      if (age == null) continue;
      const roundedAge = Math.round(age);
      oldestAge = oldestAge == null ? roundedAge : Math.max(oldestAge, roundedAge);
      newestAge = newestAge == null ? roundedAge : Math.min(newestAge, roundedAge);
    }
    const bytes = entries.reduce((sum, e) => sum + e.bytes, 0);

    totalEntries += entries.length;
    totalBytes += bytes;

    caches.push({
      name: ns.name,
      description: ns.description,
      path: ns.dirOrFile,
      entries: entries.length,
      bytes,
      ttl_seconds: ttlSeconds,
      oldest_age_seconds: oldestAge,
      newest_age_seconds: newestAge,
      // A TTL of 0 disables cache reads, so every entry is already dead.
      expired_entries: rawAges.filter(age => age == null || ttlSeconds <= 0 || age > ttlSeconds).length,
    });
  }

  return {
    config_dir: getConfigDir(),
    caches,
    total_entries: totalEntries,
    total_bytes: totalBytes,
    // Hits and misses are decided in memory and nothing records them on disk,
    // so there is no hit rate to report. Reported explicitly so the absence
    // reads as a known fact rather than a missing field.
    hit_miss_recorded: false,
  };
}

/**
 * Delete one cache, or all of them. Returns exactly what was removed so the
 * caller can print it. An unknown target removes nothing.
 */
export function clearCaches(target) {
  if (!CLEAR_TARGETS.includes(target)) {
    throw new NansenError(
      `Unknown cache clear target: ${target}. Use one of: ${CLEAR_TARGETS.join(', ')}`,
      ErrorCode.INVALID_PARAMS,
    );
  }

  const wanted = target === 'all' ? CACHE_NAMES : [target];
  const removed = [];
  let totalEntries = 0;
  let totalBytes = 0;

  for (const ns of namespaces()) {
    if (!wanted.includes(ns.name)) continue;
    let entries = 0;
    let bytes = 0;
    for (const entry of listEntries(ns, { readMetadata: false })) {
      try {
        fs.unlinkSync(entry.file);
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        throw fsError('delete', entry.file, error);
      }
      entries += 1;
      bytes += entry.bytes;
    }
    totalEntries += entries;
    totalBytes += bytes;
    removed.push({ name: ns.name, label: ns.label, path: ns.dirOrFile, entries, bytes });
  }

  return { target, removed, total_entries: totalEntries, total_bytes: totalBytes };
}

// ============= Rendering =============

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatAge(seconds) {
  if (seconds == null) return '-';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  // Hours up to two days: a 24h TTL reads better as "24h" than as "1d".
  if (seconds < 172800) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

function entryCount(count) {
  return `${count} ${count === 1 ? 'entry' : 'entries'}`;
}

/**
 * Human-readable stats. Deliberately aggregate-only: no filenames, no endpoint
 * paths, no parameters, nothing read out of a cached payload.
 */
export function formatCacheStats(stats) {
  const lines = ['Cache stats', ''];

  for (const cache of stats.caches) {
    const cols = [
      cache.name.padEnd(13),
      entryCount(cache.entries).padStart(10),
      formatBytes(cache.bytes).padStart(9),
      `TTL ${formatAge(cache.ttl_seconds)}`.padEnd(8),
    ];
    if (cache.entries > 0) {
      cols.push(`oldest ${formatAge(cache.oldest_age_seconds)}`.padEnd(12));
      cols.push(`newest ${formatAge(cache.newest_age_seconds)}`.padEnd(12));
      if (cache.expired_entries > 0) cols.push(`${cache.expired_entries} expired`);
    }
    lines.push(`  ${cols.join(' ').trimEnd()}`);
  }

  lines.push('');
  lines.push(`  Total: ${entryCount(stats.total_entries)}, ${formatBytes(stats.total_bytes)} under ${stats.config_dir}`);
  lines.push('  Hits and misses are not recorded on disk, so there is no hit rate to report.');
  lines.push('');
  lines.push('  Caching is off unless --cache is passed. --no-cache (or NANSEN_NO_CACHE=1) bypasses it.');
  lines.push(`  Clear with: nansen cache clear [${CLEAR_TARGETS.join('|')}]`);

  return lines.join('\n');
}

/** What a clear actually removed, cache by cache. */
export function formatCacheClear(result) {
  const lines = result.removed.map(
    cache => cache.entries > 0
      ? `✓ Cleared ${entryCount(cache.entries)} (${formatBytes(cache.bytes)}) from the ${cache.label}\n  ${cache.path}`
      : `ℹ No entries to clear from the ${cache.label}\n  ${cache.path}`
  );
  if (result.removed.length > 1) {
    lines.push(`  Total: ${entryCount(result.total_entries)}, ${formatBytes(result.total_bytes)}`);
  }
  return lines.join('\n');
}
