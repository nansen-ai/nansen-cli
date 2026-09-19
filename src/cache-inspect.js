/**
 * Cache inspection and invalidation — the read and clear side of the caches
 * the CLI already keeps under ~/.nansen. This module owns no cache of its own
 * and never writes an entry; it only reports and deletes.
 *
 *   responses     ~/.nansen/cache/<digest>.json  (api.js)          TTL --cache-ttl, default 300s
 *   cost-map      ~/.nansen/cost-map.json        (cost-cache.js)   TTL 24h
 *   update-check  ~/.nansen/update-check.json    (update-check.js) TTL 24h
 *
 * Privacy: stats are built from directory listings and stat(2) alone. No cache
 * file is ever opened, so a cached response body, an API key, a wallet address
 * or a request parameter cannot reach the output by construction. Response
 * cache filenames are digests of the request, and they are not printed either.
 *
 * Safety: clearing only ever unlinks regular files at the three paths above —
 * `.json` entries directly inside the response cache directory, and the two
 * named files. Directories and symlinks are skipped rather than followed, so a
 * clear cannot reach outside the cache it was pointed at. Everything else under
 * ~/.nansen (config.json, wallets/, quotes/, telemetry-id, saved auth) is never
 * read and never deleted.
 */

import fs from 'fs';
import path from 'path';

import { getCacheDir, getConfigDir, DEFAULT_CACHE_TTL } from './api.js';
import { getCostMapFile, COST_MAP_TTL_MS } from './cost-cache.js';
import { getUpdateCheckFile, UPDATE_CHECK_TTL_MS } from './update-check.js';

const SECOND = 1000;

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
      ttlSeconds: COST_MAP_TTL_MS / SECOND,
    },
    {
      name: 'update-check',
      label: 'update check',
      description: 'latest published CLI version, for the upgrade notice',
      kind: 'file',
      dirOrFile: getUpdateCheckFile(),
      ttlSeconds: UPDATE_CHECK_TTL_MS / SECOND,
    },
  ];
}

/**
 * Regular `.json` files directly inside `dir`, with size and mtime. A missing
 * directory is an empty cache, not an error. lstat (not stat) means a symlink
 * is reported as what it is and then skipped, so neither stats nor clear can be
 * walked out of the cache directory.
 */
function listDirEntries(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const entries = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile()) continue;
      entries.push({ file, bytes: stat.size, mtimeMs: stat.mtimeMs });
    } catch {
      // Raced with another process removing it — treat as already gone.
    }
  }
  return entries;
}

/** The single file of a one-file cache, or nothing if it is absent. */
function listFileEntry(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) return [];
    return [{ file, bytes: stat.size, mtimeMs: stat.mtimeMs }];
  } catch {
    return [];
  }
}

function listEntries(ns) {
  return ns.kind === 'dir' ? listDirEntries(ns.dirOrFile) : listFileEntry(ns.dirOrFile);
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
    const entries = listEntries(ns);
    const ttlSeconds = ns.name === 'responses' ? responseTtlSeconds : ns.ttlSeconds;
    // A file stamped in the future (clock skew) is 0s old, never negative.
    const ages = entries.map(e => Math.max(0, Math.round((now - e.mtimeMs) / SECOND)));
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
      oldest_age_seconds: ages.length ? Math.max(...ages) : null,
      newest_age_seconds: ages.length ? Math.min(...ages) : null,
      // A TTL of 0 disables cache reads, so every entry is already dead.
      expired_entries: ages.filter(age => ttlSeconds <= 0 || age > ttlSeconds).length,
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
    throw new Error(`Unknown cache target: ${target}. Use one of: ${CLEAR_TARGETS.join(', ')}`);
  }

  const wanted = target === 'all' ? CACHE_NAMES : [target];
  const removed = [];
  let totalEntries = 0;
  let totalBytes = 0;

  for (const ns of namespaces()) {
    if (!wanted.includes(ns.name)) continue;
    let entries = 0;
    let bytes = 0;
    for (const entry of listEntries(ns)) {
      try {
        fs.unlinkSync(entry.file);
      } catch {
        // Already gone, or not ours to remove — do not count it as removed.
        continue;
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
    cache => `✓ Cleared ${entryCount(cache.entries)} (${formatBytes(cache.bytes)}) from the ${cache.label}\n  ${cache.path}`
  );
  if (result.removed.length > 1) {
    lines.push(`  Total: ${entryCount(result.total_entries)}, ${formatBytes(result.total_bytes)}`);
  }
  return lines.join('\n');
}
