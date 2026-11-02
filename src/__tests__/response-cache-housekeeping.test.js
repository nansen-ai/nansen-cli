/**
 * Response cache housekeeping: entries for requests that are never repeated
 * and temp files left by a killed write must not pile up in the cache
 * directory, and cleanup must never touch a write in progress.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

let tempHome;
let prevHome;
let prevUserProfile;

/** api.js resolves the cache directory from HOME at import time. */
async function freshCache() {
  vi.resetModules();
  return import('../api.js');
}

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nansen-cache-housekeeping-'));
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
  fs.rmSync(tempHome, { recursive: true, force: true });
});

describe('response cache housekeeping', () => {
  const HOUR = 60 * 60 * 1000;

  /** Drop a file named like a cache entry or temp file, last modified `ageMs` ago. */
  function plant(dir, name, ageMs) {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    fs.writeFileSync(file, JSON.stringify({ timestamp: Date.now() - ageMs, data: { old: true } }));
    const when = new Date(Date.now() - ageMs);
    fs.utimesSync(file, when, when);
    return name;
  }
  const entryName = c => `${c.repeat(64)}.json`;
  const tempName = c => `${entryName(c)}.4242.12345678-1234-4123-8123-123456789abc.tmp`;

  it('removes entries past the retention window and abandoned temp files after a write', async () => {
    const { getCacheDir, setCachedResponse } = await freshCache();
    const dir = getCacheDir();
    const oldEntry = plant(dir, entryName('a'), 25 * HOUR);
    const recentEntry = plant(dir, entryName('b'), 1 * HOUR);
    const staleTemp = plant(dir, tempName('c'), 11 * 60 * 1000);
    const liveTemp = plant(dir, tempName('d'), 1000);
    const unrelated = plant(dir, 'notes.json', 30 * 24 * HOUR);

    setCachedResponse('/api/v1/new', {}, { fresh: true });

    const left = fs.readdirSync(dir);
    expect(left).not.toContain(oldEntry);
    expect(left).not.toContain(staleTemp);
    // A recent entry may still be read with a long --cache-ttl, a young temp
    // file may be another process's write in progress, and a file with a
    // foreign name was not written by the cache.
    expect(left).toEqual(expect.arrayContaining([recentEntry, liveTemp, unrelated]));
    expect(left.filter(name => /^[0-9a-f]{64}\.json$/.test(name))).toHaveLength(2);
  });

  it('does not sweep again within the sweep interval', async () => {
    const { getCacheDir, setCachedResponse } = await freshCache();
    const dir = getCacheDir();
    setCachedResponse('/api/v1/first', {}, { n: 1 });
    const readdir = vi.spyOn(fs, 'readdirSync');
    const start = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(start + 59 * 60 * 1000);

    setCachedResponse('/api/v1/second', {}, { n: 2 });

    expect(readdir).not.toHaveBeenCalled();
    vi.mocked(Date.now).mockRestore();
    expect(fs.readdirSync(dir)).toHaveLength(2);
  });

  it('sweeps again once the sweep interval has passed', async () => {
    const { getCacheDir, setCachedResponse } = await freshCache();
    const dir = getCacheDir();
    setCachedResponse('/api/v1/first', {}, { n: 1 });
    const start = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(start + 61 * 60 * 1000);
    const readdir = vi.spyOn(fs, 'readdirSync');

    setCachedResponse('/api/v1/second', {}, { n: 2 });

    expect(readdir).toHaveBeenCalledWith(dir);
  });

  it('keeps entries a longer --cache-ttl in this process may still read', async () => {
    const { getCacheDir, getCachedResponse, setCachedResponse } = await freshCache();
    const dir = getCacheDir();
    expect(getCachedResponse('/api/v1/long-ttl', {}, 259200)).toBeNull();
    const twoDays = plant(dir, entryName('a'), 48 * HOUR);
    const fourDays = plant(dir, entryName('b'), 96 * HOUR);

    setCachedResponse('/api/v1/new', {}, { fresh: true });

    const left = fs.readdirSync(dir);
    expect(left).toContain(twoDays);
    expect(left).not.toContain(fourDays);
  });

  it('keeps the request successful when the sweep fails', async () => {
    const { getCacheDir, getCachedResponse, setCachedResponse } = await freshCache();
    vi.spyOn(fs, 'readdirSync').mockImplementation(() => {
      throw Object.assign(new Error('synthetic readdir failure'), { code: 'EACCES' });
    });

    expect(() => setCachedResponse('/api/v1/sweep-fails', {}, { ok: true })).not.toThrow();
    vi.mocked(fs.readdirSync).mockRestore();

    expect(getCachedResponse('/api/v1/sweep-fails', {})).toEqual({ ok: true, _meta: expect.objectContaining({ fromCache: true }) });
    expect(fs.readdirSync(getCacheDir())).toHaveLength(1);
  });

  it.skipIf(process.platform === 'win32')('does not follow a symlinked entry when sweeping', async () => {
    const { getCacheDir, setCachedResponse } = await freshCache();
    const dir = getCacheDir();
    fs.mkdirSync(dir, { recursive: true });
    const outsider = path.join(tempHome, 'outside.json');
    fs.writeFileSync(outsider, '{}');
    const old = new Date(Date.now() - 48 * HOUR);
    fs.utimesSync(outsider, old, old);
    fs.symlinkSync(outsider, path.join(dir, entryName('e')));

    setCachedResponse('/api/v1/new', {}, { fresh: true });

    expect(fs.existsSync(outsider)).toBe(true);
    expect(fs.readdirSync(dir)).toContain(entryName('e'));
  });

  it('clearCache removes an abandoned temp file but not a write in progress', async () => {
    const { getCacheDir, clearCache } = await freshCache();
    const dir = getCacheDir();
    plant(dir, entryName('a'), 1000);
    const staleTemp = plant(dir, tempName('b'), 11 * 60 * 1000);
    const liveTemp = plant(dir, tempName('c'), 1000);

    expect(clearCache()).toBe(2);

    expect(fs.readdirSync(dir)).toEqual([liveTemp]);
    expect(fs.readdirSync(dir)).not.toContain(staleTemp);
  });
});
