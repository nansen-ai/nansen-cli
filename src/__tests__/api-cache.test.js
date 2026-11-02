/**
 * Response cache tests — `nansen --cache`.
 *
 * The cache has to hand back exactly what the network handed back. A cached
 * response that changes shape is worse than no cache at all: the first call
 * renders and the second one silently does not.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

let tempHome;
let prevHome;
let prevUserProfile;

/**
 * api.js resolves the cache directory from HOME at import time, so the temp
 * home has to be in place before the module is loaded.
 */
async function freshApi(payload, options = {}) {
  vi.resetModules();
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => JSON.parse(JSON.stringify(payload)),
  })));
  const { NansenAPI } = await import('../api.js');
  return new NansenAPI('test-key', 'https://api.nansen.ai', {
    cache: { enabled: true, ttl: 300 },
    ...options,
  });
}

async function freshCache() {
  vi.resetModules();
  return import('../api.js');
}

function onlyCacheFile(cacheDir) {
  const entries = fs.readdirSync(cacheDir);
  expect(entries).toHaveLength(1);
  return path.join(cacheDir, entries[0]);
}

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nansen-api-cache-'));
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
  vi.unstubAllGlobals();
});

describe('response cache preserves the payload shape', () => {
  it('returns a top-level array as an array on a cache hit', async () => {
    const rows = [{ symbol: 'ETH', volume: 1 }, { symbol: 'SOL', volume: 2 }];
    const api = await freshApi(rows);

    const live = await api.request('/api/v1/demo', { chain: 'ethereum' });
    const cached = await api.request('/api/v1/demo', { chain: 'ethereum' });

    expect(Array.isArray(live)).toBe(true);
    // Object-spreading the cached array used to yield { 0: …, 1: … }, which
    // every Array.isArray() branch in the output formatters then skipped.
    expect(Array.isArray(cached)).toBe(true);
    expect(cached).toHaveLength(2);
    expect([...cached]).toEqual(rows);
    expect(cached._meta.fromCache).toBe(true);
    expect(cached._meta.cacheAge).toBeTypeOf('number');
  });

  it('serves the cache on the second call rather than refetching', async () => {
    const api = await freshApi([{ symbol: 'ETH' }]);

    await api.request('/api/v1/demo', {});
    await api.request('/api/v1/demo', {});

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('still merges _meta into an object response', async () => {
    const body = { data: [{ symbol: 'ETH' }], total: 1 };
    const api = await freshApi(body);

    await api.request('/api/v1/demo', {});
    const cached = await api.request('/api/v1/demo', {});

    expect(Array.isArray(cached)).toBe(false);
    expect(cached.data).toEqual(body.data);
    expect(cached.total).toBe(1);
    expect(cached._meta.fromCache).toBe(true);
  });

  it('hands back a primitive response untouched', async () => {
    const api = await freshApi('plain-text-body');

    await api.request('/api/v1/demo', {});
    const cached = await api.request('/api/v1/demo', {});

    // A string cannot carry the marker; spreading one used to explode it into
    // { 0: 'p', 1: 'l', … }.
    expect(cached).toBe('plain-text-body');
  });
});

describe('response cache file safety', () => {
  it.skipIf(process.platform === 'win32')('does not read a final-component symlink', async () => {
    const { getCacheDir, getCachedResponse, setCachedResponse } = await freshCache();
    const endpoint = '/api/v1/linked-cache';
    const body = { chain: 'ethereum' };
    setCachedResponse(endpoint, body, { source: 'cache' });
    const cacheFile = onlyCacheFile(getCacheDir());
    const outsider = path.join(tempHome, 'outside.json');
    fs.writeFileSync(outsider, JSON.stringify({
      timestamp: Date.now(),
      data: { source: 'outside' },
    }));
    fs.unlinkSync(cacheFile);
    fs.symlinkSync(outsider, cacheFile);

    expect(getCachedResponse(endpoint, body)).toBeNull();
  });

  it('does not read a non-regular cache entry', async () => {
    const { getCacheDir, getCachedResponse, setCachedResponse } = await freshCache();
    const endpoint = '/api/v1/non-regular-cache';
    const body = { chain: 'ethereum' };
    setCachedResponse(endpoint, body, { source: 'cache' });
    const cacheFile = onlyCacheFile(getCacheDir());
    fs.unlinkSync(cacheFile);
    fs.mkdirSync(cacheFile);

    expect(getCachedResponse(endpoint, body)).toBeNull();
  });

  it.skipIf(process.platform === 'win32')('tightens an existing cache file to mode 0600', async () => {
    const { getCacheDir, setCachedResponse } = await freshCache();
    const endpoint = '/api/v1/cache-mode';
    const body = { chain: 'ethereum' };
    setCachedResponse(endpoint, body, { generation: 1 });
    const cacheFile = onlyCacheFile(getCacheDir());
    expect(fs.statSync(cacheFile).mode & 0o777).toBe(0o600);
    fs.chmodSync(cacheFile, 0o644);
    expect(fs.statSync(cacheFile).mode & 0o777).toBe(0o644);

    setCachedResponse(endpoint, body, { generation: 2 });

    expect(JSON.parse(fs.readFileSync(cacheFile, 'utf8')).data.generation).toBe(2);
    expect(fs.statSync(cacheFile).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === 'win32')('does not overwrite a symlink target', async () => {
    const { getCacheDir, setCachedResponse } = await freshCache();
    const endpoint = '/api/v1/linked-write';
    const body = { chain: 'ethereum' };
    setCachedResponse(endpoint, body, { generation: 1 });
    const cacheFile = onlyCacheFile(getCacheDir());
    const outsider = path.join(tempHome, 'outside-write.json');
    fs.writeFileSync(outsider, 'leave unchanged');
    fs.unlinkSync(cacheFile);
    fs.symlinkSync(outsider, cacheFile);

    setCachedResponse(endpoint, body, { generation: 2 });

    expect(fs.readFileSync(outsider, 'utf8')).toBe('leave unchanged');
    expect(fs.lstatSync(cacheFile).isFile()).toBe(true);
    expect(JSON.parse(fs.readFileSync(cacheFile, 'utf8')).data.generation).toBe(2);
  });

  it.skipIf(process.platform === 'win32')('replaces a hardlink entry without changing its outside inode', async () => {
    const { getCacheDir, setCachedResponse } = await freshCache();
    const endpoint = '/api/v1/hardlinked-write';
    const body = { chain: 'ethereum' };
    setCachedResponse(endpoint, body, { generation: 1 });
    const cacheFile = onlyCacheFile(getCacheDir());
    const outsider = path.join(tempHome, 'outside-hardlink.json');
    fs.writeFileSync(outsider, 'leave unchanged');
    fs.unlinkSync(cacheFile);
    fs.linkSync(outsider, cacheFile);

    setCachedResponse(endpoint, body, { generation: 2 });

    expect(fs.readFileSync(outsider, 'utf8')).toBe('leave unchanged');
    expect(fs.statSync(cacheFile).nlink).toBe(1);
    expect(JSON.parse(fs.readFileSync(cacheFile, 'utf8')).data.generation).toBe(2);
  });

  it('does not unlink a valid successor installed while reading an invalid entry', async () => {
    const { getCacheDir, getCachedResponse, setCachedResponse } = await freshCache();
    const endpoint = '/api/v1/replaced-invalid-cache';
    const body = { chain: 'ethereum' };
    setCachedResponse(endpoint, body, { generation: 1 });
    const cacheFile = onlyCacheFile(getCacheDir());
    fs.writeFileSync(cacheFile, '{invalid cache json');
    const successor = `${cacheFile}.successor`;
    fs.writeFileSync(successor, JSON.stringify({
      timestamp: Date.now(),
      endpoint,
      data: { generation: 2 },
    }), { mode: 0o600 });
    const originalReadFile = fs.readFileSync;
    const readFile = vi.spyOn(fs, 'readFileSync').mockImplementation((file, ...args) => {
      const contents = originalReadFile(file, ...args);
      if (typeof file === 'number') fs.renameSync(successor, cacheFile);
      return contents;
    });
    const originalClose = fs.closeSync;
    const close = vi.spyOn(fs, 'closeSync').mockImplementationOnce(fd => {
      originalClose(fd);
      throw new Error('synthetic close failure');
    });

    expect(getCachedResponse(endpoint, body)).toBeNull();
    readFile.mockRestore();
    close.mockRestore();

    expect(JSON.parse(fs.readFileSync(cacheFile, 'utf8')).data.generation).toBe(2);
  });

  it('closes the read descriptor and surfaces a close-only failure', async () => {
    const { getCachedResponse, setCachedResponse } = await freshCache();
    const endpoint = '/api/v1/cache-read-close';
    const body = { chain: 'ethereum' };
    setCachedResponse(endpoint, body, { generation: 1 });
    const originalClose = fs.closeSync;
    const close = vi.spyOn(fs, 'closeSync').mockImplementationOnce(fd => {
      originalClose(fd);
      throw new Error('synthetic close failure');
    });

    expect(() => getCachedResponse(endpoint, body)).toThrow('synthetic close failure');
    expect(close).toHaveBeenCalledOnce();
  });

  it('keeps the previous valid entry when a replacement write fails', async () => {
    const { getCacheDir, setCachedResponse } = await freshCache();
    const endpoint = '/api/v1/failed-cache-write';
    const body = { chain: 'ethereum' };
    setCachedResponse(endpoint, body, { generation: 1 });
    const cacheFile = onlyCacheFile(getCacheDir());
    const write = vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
      throw new Error('synthetic write failure');
    });

    expect(() => setCachedResponse(endpoint, body, { generation: 2 })).toThrow('synthetic write failure');
    write.mockRestore();

    expect(JSON.parse(fs.readFileSync(cacheFile, 'utf8')).data.generation).toBe(1);
    expect(fs.readdirSync(getCacheDir())).toEqual([path.basename(cacheFile)]);
  });

  it('surfaces a writer close-only failure and removes the uncommitted temp file', async () => {
    const { getCacheDir, setCachedResponse } = await freshCache();
    const endpoint = '/api/v1/cache-write-close';
    const body = { chain: 'ethereum' };
    setCachedResponse(endpoint, body, { generation: 1 });
    const cacheFile = onlyCacheFile(getCacheDir());
    const originalClose = fs.closeSync;
    const close = vi.spyOn(fs, 'closeSync').mockImplementationOnce(fd => {
      originalClose(fd);
      throw new Error('synthetic close failure');
    });

    expect(() => setCachedResponse(endpoint, body, { generation: 2 })).toThrow('synthetic close failure');
    close.mockRestore();

    expect(JSON.parse(fs.readFileSync(cacheFile, 'utf8')).data.generation).toBe(1);
    expect(fs.readdirSync(getCacheDir())).toEqual([path.basename(cacheFile)]);
  });

  it('preserves a write failure when descriptor close also fails and still removes the temp file', async () => {
    const { getCacheDir, setCachedResponse } = await freshCache();
    const endpoint = '/api/v1/failed-cache-write-and-close';
    const body = { chain: 'ethereum' };
    setCachedResponse(endpoint, body, { generation: 1 });
    const cacheFile = onlyCacheFile(getCacheDir());
    const write = vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
      throw new Error('synthetic write failure');
    });
    const originalClose = fs.closeSync;
    const close = vi.spyOn(fs, 'closeSync').mockImplementationOnce(fd => {
      originalClose(fd);
      throw new Error('synthetic close failure');
    });

    expect(() => setCachedResponse(endpoint, body, { generation: 2 })).toThrow('synthetic write failure');
    write.mockRestore();
    close.mockRestore();

    expect(JSON.parse(fs.readFileSync(cacheFile, 'utf8')).data.generation).toBe(1);
    expect(fs.readdirSync(getCacheDir())).toEqual([path.basename(cacheFile)]);
  });
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

  it('sweeps once per process, not on every write', async () => {
    const { getCacheDir, setCachedResponse } = await freshCache();
    const dir = getCacheDir();
    setCachedResponse('/api/v1/first', {}, { n: 1 });
    const readdir = vi.spyOn(fs, 'readdirSync');

    setCachedResponse('/api/v1/second', {}, { n: 2 });

    expect(readdir).not.toHaveBeenCalled();
    expect(fs.readdirSync(dir)).toHaveLength(2);
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

    clearCache();

    expect(fs.readdirSync(dir)).toEqual([liveTemp]);
    expect(fs.readdirSync(dir)).not.toContain(staleTemp);
  });
});
