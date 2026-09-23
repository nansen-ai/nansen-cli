/**
 * `nansen cache stats` / `nansen cache clear`.
 *
 * Two things are proved here. The numbers have to be right — entries, bytes,
 * ages and the effective TTL — and the output has to stay boring: a cache entry
 * holds a whole API response, so anything the inspector prints is a potential
 * leak. Every filesystem fixture lives in a temp HOME, never the real ~/.nansen.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Fixture payload. Everything here is invented; none of it may reach stdout.
const FAKE_API_KEY = 'test-key-00000000000000000000000000000000';
const FAKE_ADDRESS = '0x000000000000000000000000000000000000dead';
const FAKE_ENDPOINT = '/api/v1/profiler/address/balances';
const CACHE_KEY = 'a'.repeat(64);

let tempHome;
let prevHome;
let prevUserProfile;

/**
 * api.js resolves ~/.nansen from HOME at import time and cache-inspect.js reads
 * the paths back from the modules that own them, so the temp home has to be in
 * place before either module is loaded. Same mechanism as api-cache.test.js.
 */
async function freshModule(specifier) {
  vi.resetModules();
  return import(specifier);
}

function nansenDir() {
  return path.join(tempHome, '.nansen');
}

function responseCacheDir() {
  return path.join(nansenDir(), 'cache');
}

/** Write a response-cache entry of a given size, aged `ageSeconds` seconds. */
function writeResponseEntry(key, body, ageSeconds = 0) {
  fs.mkdirSync(responseCacheDir(), { recursive: true });
  const file = path.join(responseCacheDir(), `${key}.json`);
  const timestamp = Date.now() - ageSeconds * 1000;
  fs.writeFileSync(file, JSON.stringify({ timestamp, ...body }));
  const when = new Date(Date.now() - ageSeconds * 1000);
  fs.utimesSync(file, when, when);
  return file;
}

function writeConfigFixtures() {
  fs.mkdirSync(path.join(nansenDir(), 'wallets'), { recursive: true });
  fs.writeFileSync(path.join(nansenDir(), 'config.json'), JSON.stringify({ apiKey: FAKE_API_KEY }));
  fs.writeFileSync(path.join(nansenDir(), 'wallets', 'default.json'), JSON.stringify({ address: FAKE_ADDRESS }));
}

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nansen-cache-stats-'));
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
  fs.rmSync(tempHome, { recursive: true, force: true });
  vi.resetModules();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('cache stats', () => {
  it('reports an empty cache without inventing entries or failing on a missing directory', async () => {
    const { collectCacheStats, formatCacheStats } = await freshModule('../cache-inspect.js');

    const stats = collectCacheStats();

    expect(fs.existsSync(responseCacheDir())).toBe(false);
    expect(stats.total_entries).toBe(0);
    expect(stats.total_bytes).toBe(0);
    expect(stats.caches.map(c => c.name)).toEqual(['responses', 'cost-map', 'update-check']);
    for (const cache of stats.caches) {
      expect(cache.entries).toBe(0);
      expect(cache.bytes).toBe(0);
      expect(cache.oldest_age_seconds).toBeNull();
      expect(cache.newest_age_seconds).toBeNull();
      expect(cache.expired_entries).toBe(0);
    }
    // Reading stats must not create the directories it reports on.
    expect(formatCacheStats(stats)).toContain('0 entries');
    expect(fs.existsSync(responseCacheDir())).toBe(false);
  });

  it('counts entries, bytes, ages and expiry across every cache', async () => {
    writeResponseEntry('a'.repeat(64), { data: [1, 2, 3] }, 30);
    writeResponseEntry('b'.repeat(64), { data: [4] }, 600);
    fs.writeFileSync(path.join(nansenDir(), 'cost-map.json'), JSON.stringify({ costs: {}, fetchedAt: Date.now() }));

    const { collectCacheStats } = await freshModule('../cache-inspect.js');
    const stats = collectCacheStats({ responseTtlSeconds: 300 });

    const responses = stats.caches.find(c => c.name === 'responses');
    expect(responses.entries).toBe(2);
    expect(responses.bytes).toBe(
      fs.statSync(path.join(responseCacheDir(), `${'a'.repeat(64)}.json`)).size +
      fs.statSync(path.join(responseCacheDir(), `${'b'.repeat(64)}.json`)).size,
    );
    expect(responses.ttl_seconds).toBe(300);
    expect(responses.oldest_age_seconds).toBeGreaterThanOrEqual(600);
    expect(responses.newest_age_seconds).toBeGreaterThanOrEqual(30);
    expect(responses.newest_age_seconds).toBeLessThan(60);
    // The 10-minute-old entry is past a 5-minute TTL; the 30s one is not.
    expect(responses.expired_entries).toBe(1);

    const costMap = stats.caches.find(c => c.name === 'cost-map');
    expect(costMap.entries).toBe(1);
    expect(costMap.ttl_seconds).toBe(86400);

    expect(stats.caches.find(c => c.name === 'update-check').entries).toBe(0);
    expect(stats.total_entries).toBe(3);
  });

  it('evaluates expiry against the TTL this invocation would use', async () => {
    writeResponseEntry(CACHE_KEY, { data: [1] }, 120);
    const { collectCacheStats } = await freshModule('../cache-inspect.js');

    const atDefault = collectCacheStats({ responseTtlSeconds: 300 });
    const atSixty = collectCacheStats({ responseTtlSeconds: 60 });
    const atZero = collectCacheStats({ responseTtlSeconds: 0 });

    expect(atDefault.caches[0].expired_entries).toBe(0);
    expect(atSixty.caches[0].expired_entries).toBe(1);
    // A TTL of 0 disables cache reads outright, so nothing on disk is live.
    expect(atZero.caches[0].expired_entries).toBe(1);
  });

  it('uses the cache timestamp rather than mtime when deciding expiry', async () => {
    const file = writeResponseEntry(CACHE_KEY, { data: [1] }, 600);
    const now = new Date();
    fs.utimesSync(file, now, now);
    const { collectCacheStats } = await freshModule('../cache-inspect.js');

    const response = collectCacheStats({ responseTtlSeconds: 300 }).caches[0];

    expect(response.oldest_age_seconds).toBeGreaterThanOrEqual(600);
    expect(response.expired_entries).toBe(1);
  });

  it('counts corrupt entries as expired because the next read discards them', async () => {
    fs.mkdirSync(responseCacheDir(), { recursive: true });
    fs.writeFileSync(path.join(responseCacheDir(), `${CACHE_KEY}.json`), '{broken');
    const { collectCacheStats } = await freshModule('../cache-inspect.js');

    expect(collectCacheStats().caches[0].expired_entries).toBe(1);
  });

  it('ignores anything in the cache directory that is not a cache entry', async () => {
    writeResponseEntry(CACHE_KEY, { data: [1] });
    fs.writeFileSync(path.join(responseCacheDir(), 'notes.txt'), 'not an entry');
    fs.mkdirSync(path.join(responseCacheDir(), 'nested.json'));

    const { collectCacheStats } = await freshModule('../cache-inspect.js');

    expect(collectCacheStats().caches[0].entries).toBe(1);
  });

  it('renders a report with the counts, the TTL and the controls', async () => {
    writeResponseEntry(CACHE_KEY, { data: [1] }, 45);
    const { collectCacheStats, formatCacheStats } = await freshModule('../cache-inspect.js');

    const report = formatCacheStats(collectCacheStats({ responseTtlSeconds: 300 }));

    expect(report).toContain('responses');
    expect(report).toContain('1 entry');
    expect(report).toContain('TTL 5m');
    expect(report).toContain('Hits and misses are not recorded on disk');
    expect(report).toContain('nansen cache clear');
  });

  it('reports large caches without exceeding the function argument limit', async () => {
    const file = writeResponseEntry(CACHE_KEY, { data: [1] }, 60);
    const { collectCacheStats } = await freshModule('../cache-inspect.js');
    const stat = fs.lstatSync(file);
    const directoryStat = fs.lstatSync(responseCacheDir());
    const names = Array.from({ length: 150_000 }, (_, i) => `${i.toString(16).padStart(64, '0')}.json`);
    const originalLstat = fs.lstatSync.bind(fs);
    vi.spyOn(fs, 'readdirSync').mockReturnValue(names);
    vi.spyOn(fs, 'lstatSync').mockImplementation(target => {
      if (target === responseCacheDir()) return directoryStat;
      if (path.dirname(target) === responseCacheDir()) return stat;
      return originalLstat(target);
    });
    vi.spyOn(fs, 'openSync').mockReturnValue(123);
    vi.spyOn(fs, 'fstatSync').mockReturnValue(stat);
    vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify({ timestamp: Date.now() - 60_000 }));
    vi.spyOn(fs, 'closeSync').mockReturnValue(undefined);

    const response = collectCacheStats().caches[0];
    expect(response.entries).toBe(names.length);
    expect(response.bytes).toBe(stat.size * names.length);
    expect(response.oldest_age_seconds).toBeGreaterThanOrEqual(60);
    expect(response.newest_age_seconds).toBeGreaterThanOrEqual(60);
    expect(response.expired_entries).toBe(0);
  });

  it('states plainly that hit and miss counts are not recorded', async () => {
    const { collectCacheStats } = await freshModule('../cache-inspect.js');

    // Nothing on disk tracks hits or misses today. If that ever changes, this
    // field (and the report line) must change with it.
    expect(collectCacheStats().hit_miss_recorded).toBe(false);
  });
});

describe('cache stats privacy', () => {
  it('never prints a cached payload, a credential, an address, an endpoint or a cache key', async () => {
    writeResponseEntry(CACHE_KEY, {
      timestamp: Date.now(),
      endpoint: FAKE_ENDPOINT,
      data: { apikey: FAKE_API_KEY, address: FAKE_ADDRESS, rows: [{ balance_usd: 12345 }] },
    });
    writeConfigFixtures();

    const { collectCacheStats, formatCacheStats } = await freshModule('../cache-inspect.js');
    const stats = collectCacheStats();
    const rendered = `${formatCacheStats(stats)}\n${JSON.stringify(stats)}`;

    for (const secret of [FAKE_API_KEY, FAKE_ADDRESS, FAKE_ENDPOINT, 'balance_usd', '12345']) {
      expect(rendered, `stats output leaked ${secret}`).not.toContain(secret);
    }
    // Cache keys are digests of the request. Truncated or whole, they have no
    // business in a report, so no hash-shaped token may appear at all.
    expect(rendered).not.toMatch(/[0-9a-f]{32}/);
    // Reporting must not consume what it reports on.
    expect(fs.existsSync(path.join(responseCacheDir(), `${CACHE_KEY}.json`))).toBe(true);
  });
});

describe('cache clear', () => {
  it('reports an empty response cache without a success mark', async () => {
    const { clearCaches, formatCacheClear } = await freshModule('../cache-inspect.js');

    expect(formatCacheClear(clearCaches('responses'))).toBe(
      `ℹ No entries to clear from the response cache\n  ${responseCacheDir()}`,
    );
  });

  it('reports all empty caches without success marks', async () => {
    const { clearCaches, formatCacheClear } = await freshModule('../cache-inspect.js');

    expect(formatCacheClear(clearCaches('all'))).toBe([
      `ℹ No entries to clear from the response cache\n  ${responseCacheDir()}`,
      `ℹ No entries to clear from the credit cost map\n  ${path.join(nansenDir(), 'cost-map.json')}`,
      `ℹ No entries to clear from the update check\n  ${path.join(nansenDir(), 'update-check.json')}`,
      '  Total: 0 entries, 0 B',
    ].join('\n'));
  });

  it('marks only caches with deleted entries as cleared', async () => {
    const file = writeResponseEntry(CACHE_KEY, { data: [1] });
    const bytes = fs.statSync(file).size;
    const { clearCaches, formatCacheClear } = await freshModule('../cache-inspect.js');

    expect(formatCacheClear(clearCaches('all'))).toBe([
      `✓ Cleared 1 entry (${bytes} B) from the response cache\n  ${responseCacheDir()}`,
      `ℹ No entries to clear from the credit cost map\n  ${path.join(nansenDir(), 'cost-map.json')}`,
      `ℹ No entries to clear from the update check\n  ${path.join(nansenDir(), 'update-check.json')}`,
      `  Total: 1 entry, ${bytes} B`,
    ].join('\n'));
  });

  it('removes response entries and reports exactly what went', async () => {
    writeResponseEntry('a'.repeat(64), { data: [1] });
    writeResponseEntry('b'.repeat(64), { data: [2] });
    const { clearCaches, formatCacheClear } = await freshModule('../cache-inspect.js');

    const result = clearCaches('responses');

    expect(result.total_entries).toBe(2);
    expect(result.total_bytes).toBeGreaterThan(0);
    expect(fs.readdirSync(responseCacheDir())).toEqual([]);
    expect(formatCacheClear(result)).toContain('Cleared 2 entries');
  });

  it('clears one named cache and leaves the others alone', async () => {
    writeResponseEntry(CACHE_KEY, { data: [1] });
    fs.writeFileSync(path.join(nansenDir(), 'cost-map.json'), JSON.stringify({ costs: {} }));
    const { clearCaches } = await freshModule('../cache-inspect.js');

    clearCaches('cost-map');

    expect(fs.existsSync(path.join(nansenDir(), 'cost-map.json'))).toBe(false);
    expect(fs.existsSync(path.join(responseCacheDir(), `${CACHE_KEY}.json`))).toBe(true);
  });

  it('clears everything on "all" and still leaves credentials, wallets and quotes', async () => {
    writeResponseEntry(CACHE_KEY, { data: [1] });
    fs.writeFileSync(path.join(nansenDir(), 'cost-map.json'), JSON.stringify({ costs: {} }));
    fs.writeFileSync(path.join(nansenDir(), 'update-check.json'), JSON.stringify({ latest: '1.0.0' }));
    fs.mkdirSync(path.join(nansenDir(), 'quotes'), { recursive: true });
    fs.writeFileSync(path.join(nansenDir(), 'quotes', 'pending.json'), JSON.stringify({ quoteId: 'pending' }));
    writeConfigFixtures();

    const { clearCaches } = await freshModule('../cache-inspect.js');
    const result = clearCaches('all');

    expect(result.removed.map(r => r.name)).toEqual(['responses', 'cost-map', 'update-check']);
    expect(result.total_entries).toBe(3);
    // Everything the user would be upset to lose is still there.
    expect(fs.existsSync(path.join(nansenDir(), 'config.json'))).toBe(true);
    expect(fs.existsSync(path.join(nansenDir(), 'wallets', 'default.json'))).toBe(true);
    expect(fs.existsSync(path.join(nansenDir(), 'quotes', 'pending.json'))).toBe(true);
  });

  it('refuses an unknown target and removes nothing', async () => {
    writeResponseEntry(CACHE_KEY, { data: [1] });
    const { clearCaches } = await freshModule('../cache-inspect.js');

    for (const target of ['everything', '../..']) {
      let error;
      try { clearCaches(target); } catch (caught) { error = caught; }
      expect(error).toMatchObject({
        code: 'INVALID_PARAMS',
        message: expect.stringMatching(/Unknown cache clear target/),
      });
    }
    expect(fs.existsSync(path.join(responseCacheDir(), `${CACHE_KEY}.json`))).toBe(true);
  });

  it('does not follow a symlink out of the cache directory', async () => {
    const outsider = path.join(tempHome, 'important.json');
    fs.writeFileSync(outsider, JSON.stringify({ keep: true }));
    fs.mkdirSync(responseCacheDir(), { recursive: true });
    fs.symlinkSync(outsider, path.join(responseCacheDir(), 'link.json'));

    const { collectCacheStats, clearCaches } = await freshModule('../cache-inspect.js');

    expect(collectCacheStats().caches[0].entries).toBe(0);
    clearCaches('responses');
    expect(fs.existsSync(outsider)).toBe(true);
  });

  it('refuses a digest entry replaced by a symlink between lstat and read', async () => {
    const outsider = path.join(tempHome, 'important.json');
    fs.writeFileSync(outsider, JSON.stringify({ timestamp: Date.now(), keep: true }));
    fs.mkdirSync(responseCacheDir(), { recursive: true });
    const entry = path.join(responseCacheDir(), `${CACHE_KEY}.json`);
    fs.symlinkSync(outsider, entry);

    // Simulate the narrow race after listDirEntries has observed a regular
    // file but before readTimestamp opens it. O_NOFOLLOW must still prevent
    // reading the replacement symlink's target.
    const originalLstat = fs.lstatSync.bind(fs);
    const regularFileStat = originalLstat(outsider);
    vi.spyOn(fs, 'lstatSync').mockImplementation(target => (
      target === entry ? regularFileStat : originalLstat(target)
    ));

    const { collectCacheStats } = await freshModule('../cache-inspect.js');

    expect(collectCacheStats().caches[0].entries).toBe(0);
    expect(fs.existsSync(outsider)).toBe(true);
  });

  it('refuses a symlinked response cache directory', async () => {
    const outsiderDir = path.join(tempHome, 'outside');
    const outsider = path.join(outsiderDir, `${CACHE_KEY}.json`);
    fs.mkdirSync(path.dirname(responseCacheDir()), { recursive: true });
    fs.mkdirSync(outsiderDir);
    fs.writeFileSync(outsider, JSON.stringify({ keep: true }));
    fs.symlinkSync(outsiderDir, responseCacheDir());

    const { collectCacheStats, clearCaches } = await freshModule('../cache-inspect.js');

    expect(() => collectCacheStats()).toThrow(/symlinked response cache directory/);
    expect(() => clearCaches('responses')).toThrow(/symlinked response cache directory/);
    expect(fs.existsSync(outsider)).toBe(true);
  });

  it('ignores JSON files that are not response-cache digest entries', async () => {
    fs.mkdirSync(responseCacheDir(), { recursive: true });
    const unrelated = path.join(responseCacheDir(), 'important.json');
    fs.writeFileSync(unrelated, JSON.stringify({ keep: true }));
    const { collectCacheStats, clearCaches } = await freshModule('../cache-inspect.js');

    expect(collectCacheStats().caches[0].entries).toBe(0);
    clearCaches('responses');
    expect(fs.existsSync(unrelated)).toBe(true);
  });

  it('reports filesystem access failures instead of pretending the cache is empty', async () => {
    fs.mkdirSync(responseCacheDir(), { recursive: true });
    const original = fs.readdirSync.bind(fs);
    vi.spyOn(fs, 'readdirSync').mockImplementation(target => {
      if (target === responseCacheDir()) {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      }
      return original(target);
    });
    const { collectCacheStats, clearCaches } = await freshModule('../cache-inspect.js');

    expect(() => collectCacheStats()).toThrow(/Cannot list cache path.*EACCES/);
    expect(() => clearCaches('responses')).toThrow(/Cannot list cache path.*EACCES/);
  });
});

describe('cache command', () => {
  async function runCacheCommand(args, { flags = {}, options = {} } = {}) {
    const logs = [];
    const { buildCommands } = await freshModule('../cli.js');
    const commands = buildCommands({ log: msg => logs.push(msg) });
    const result = await commands.cache(args, null, flags, options);
    return { logs, text: logs.join('\n'), result };
  }

  it('prints a stats report by default and returns an object with --json', async () => {
    writeResponseEntry(CACHE_KEY, { data: [1] });

    const text = (await runCacheCommand(['stats'])).text;
    expect(text).toContain('Cache stats');
    expect(text).toContain('1 entry');

    const { result, logs } = await runCacheCommand(['stats'], { flags: { json: true } });
    expect(logs).toEqual([]);
    expect(result.total_entries).toBe(1);
    expect(result.hit_miss_recorded).toBe(false);
  });

  it('honours --cache-ttl when deciding what is expired', async () => {
    writeResponseEntry(CACHE_KEY, { data: [1] }, 120);

    const { result } = await runCacheCommand(['stats'], { flags: { json: true }, options: { 'cache-ttl': 60 } });

    expect(result.caches[0].ttl_seconds).toBe(60);
    expect(result.caches[0].expired_entries).toBe(1);
  });

  it('clears the response cache when no target is given', async () => {
    writeResponseEntry(CACHE_KEY, { data: [1] });
    fs.writeFileSync(path.join(nansenDir(), 'cost-map.json'), JSON.stringify({ costs: {} }));

    const { text } = await runCacheCommand(['clear']);

    expect(text).toContain('Cleared 1 entry');
    expect(fs.readdirSync(responseCacheDir())).toEqual([]);
    // The default target is the response cache alone — "all" has to be asked for.
    expect(fs.existsSync(path.join(nansenDir(), 'cost-map.json'))).toBe(true);
  });

  it('rejects an unrecognised clear target with an actionable error', async () => {
    writeResponseEntry(CACHE_KEY, { data: [1] });

    await expect(runCacheCommand(['clear', 'wallets'])).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      message: 'Unknown cache clear target: wallets. Use one of: responses, cost-map, update-check, all',
    });
    expect(fs.existsSync(path.join(responseCacheDir(), `${CACHE_KEY}.json`))).toBe(true);
  });

  it('documents the subcommands, the controls and which commands cache', async () => {
    const { text } = await runCacheCommand([]);

    expect(text).toContain('nansen cache');
    expect(text).toContain('stats');
    expect(text).toContain('clear');
    expect(text).toContain('--no-cache');
    expect(text).toContain('NANSEN_NO_CACHE=1');
    expect(text).toContain('WHAT CACHES');
  });

  it.each(['toString', 'constructor', '__proto__'])('rejects inherited subcommand %s', async subcommand => {
    await expect(runCacheCommand([subcommand])).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  });

  it.each([
    ['clear', 'responses', 'wallets'],
    ['clear', 'all', 'wallets'],
    ['clear', ''],
    ['stats', 'responses'],
  ])('rejects invalid arguments without deleting entries: %j', async (...args) => {
    const file = writeResponseEntry(CACHE_KEY, { data: [1] });
    await expect(runCacheCommand(args)).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(fs.existsSync(file)).toBe(true);
  });

  it('rejects an unknown subcommand', async () => {
    await expect(runCacheCommand(['nonsense'])).rejects.toThrow(
      /Unknown cache subcommand: nonsense\. Use one of: stats, clear/,
    );
  });
});

describe('caching opt-out', () => {
  async function capturedCacheOptions(args, env = {}) {
    const { runCLI } = await freshModule('../cli.js');
    let captured;
    await runCLI(args, {
      output: () => {},
      errorOutput: () => {},
      exit: () => {},
      env: { NO_UPDATE_NOTIFIER: '1', ...env },
      NansenAPIClass: function MockAPI(_key, _url, opts) {
        captured = opts;
        this.request = async () => ({ data: [] });
        this.servedFromCache = false;
      },
      commandOverrides: { account: async () => ({ ok: true }) },
    });
    return captured.cache;
  }

  // An absent flag leaves `enabled` unset rather than false; api.js reads it
  // as `?? false`, so truthiness is the contract under test here.
  it('is off unless --cache is passed', async () => {
    expect((await capturedCacheOptions(['account'])).enabled).toBeFalsy();
  });

  it('is on with --cache', async () => {
    expect((await capturedCacheOptions(['account', '--cache'])).enabled).toBe(true);
  });

  it('is vetoed by --no-cache', async () => {
    expect((await capturedCacheOptions(['account', '--cache', '--no-cache'])).enabled).toBeFalsy();
  });

  it('is vetoed by NANSEN_NO_CACHE=1 without a flag', async () => {
    expect((await capturedCacheOptions(['account', '--cache'], { NANSEN_NO_CACHE: '1' })).enabled).toBe(false);
  });

  it('treats any other NANSEN_NO_CACHE value as unset', async () => {
    expect((await capturedCacheOptions(['account', '--cache'], { NANSEN_NO_CACHE: '0' })).enabled).toBe(true);
  });
});

describe('documented cache surface stays in sync with the code', () => {
  const repoRoot = path.resolve(process.cwd());
  const schema = JSON.parse(fs.readFileSync(path.join(repoRoot, 'src', 'schema.json'), 'utf8'));

  it('registers the cache command, its subcommands and the cache flags', () => {
    expect(schema.commands.cache).toBeTruthy();
    expect(Object.keys(schema.commands.cache.subcommands)).toEqual(['stats', 'clear']);
    for (const sub of Object.values(schema.commands.cache.subcommands)) {
      expect(sub.description).toBeTruthy();
      expect(sub.examples.length).toBeGreaterThan(0);
    }
    expect(schema.globalOptions.cache).toBeTruthy();
    expect(schema.globalOptions['no-cache']).toBeTruthy();
  });

  it('names every cache subcommand on the help banner', async () => {
    const { HELP } = await freshModule('../cli.js');
    const line = HELP.split('\n').find(l => /^ {2}cache {2,}/.test(l));

    expect(line, 'the --help banner has no cache line').toBeTruthy();
    for (const name of Object.keys(schema.commands.cache.subcommands)) {
      expect(line, `--help cache line is missing "${name}"`).toContain(name);
    }
  });

  it('documents caching once, as a rule, with the controls that drive it', () => {
    expect(schema.caching.enableWith).toBe('--cache');
    expect(schema.caching.disableWith).toContain('--no-cache');
    expect(schema.caching.disableWith).toContain('NANSEN_NO_CACHE=1');
    expect(schema.caching.defaultTtlSeconds).toBe(300);
    expect(schema.caching.caches.map(c => c.name)).toEqual(['responses', 'cost-map', 'update-check']);
  });

  /**
   * The never-cached list is the one piece of the caching docs that can silently
   * go stale: a new endpoint opting out of the cache is a one-word change in
   * api.js. Pin the documented list to the opt-outs actually in the source.
   */
  it('lists every request that opts out of the cache', () => {
    const source = fs.readFileSync(path.join(repoRoot, 'src', 'api.js'), 'utf8');
    const optOuts = {
      getAccount: 'account',
      webSearch: 'web search',
      webFetch: 'web fetch',
      alertsCreate: 'alerts create',
      alertsUpdate: 'alerts update',
      alertsToggle: 'alerts toggle',
      alertsDelete: 'alerts delete',
    };

    const found = (source.match(/cache: false/g) || []).length;
    expect(
      found,
      'a request opted out of the cache without updating schema.json `caching.neverCached` and the cache help text',
    ).toBe(Object.keys(optOuts).length);

    for (const [method, command] of Object.entries(optOuts)) {
      const start = source.indexOf(`async ${method}(`);
      expect(start, `api.js no longer defines ${method}`).toBeGreaterThan(-1);
      const body = source.slice(start, start + 800).split('\n  async ')[0];
      expect(body, `${method} no longer passes cache: false`).toContain('cache: false');
      expect(schema.caching.neverCached, `schema.caching.neverCached is missing ${command}`).toContain(command);
    }
  });
});
