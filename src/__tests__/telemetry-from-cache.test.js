/**
 * End-to-end cover for the `from_cache` telemetry field, driven through the
 * real NansenAPI with a mocked fetch and a temp HOME.
 *
 * Two separate ways this metric has been wrong:
 *
 *  1. The tracking sites read a bare `result.fromCache`, which nothing sets —
 *     getCachedResponse() records the hit one level down, on `_meta`.
 *  2. `_meta` on its own isn't enough either. A handler is free to rebuild its
 *     result and `alerts list` does (it filters the array into a fresh one), so
 *     the marker is gone before tracking runs — and that path didn't pass the
 *     field at all.
 *
 * These run the same `--cache` command twice and assert on the tracked event,
 * so a real cache hit is what's being measured rather than a stubbed flag.
 * `fetch` call counts prove the second run never touched the network.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const trackSucceeded = vi.fn();
const trackFailed = vi.fn();

vi.mock('../telemetry.js', async (importOriginal) => ({
  ...(await importOriginal()),
  trackCommandSucceeded: trackSucceeded,
  trackCommandFailed: trackFailed,
  trackPerpOrderCompleted: vi.fn(),
  getAnonymousId: () => 'test-anon-id',
  getSessionId: () => 'test-session-id',
}));

let tempHome;
const saved = {};

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nansen-from-cache-'));
  for (const name of ['HOME', 'USERPROFILE', 'NANSEN_API_KEY']) saved[name] = process.env[name];
  // CONFIG_DIR (and so the response cache) is resolved from HOME at api.js load
  // time, hence the resetModules + dynamic import in loadCli below.
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  process.env.NANSEN_API_KEY = 'test-key';
  trackSucceeded.mockClear();
  trackFailed.mockClear();
});

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  fs.rmSync(tempHome, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.resetModules();
});

/** Load cli.js and the real NansenAPI against a mocked network. */
async function loadCli(payload) {
  vi.resetModules();
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    // Fresh clone per call so a handler mutating the body can't leak across runs.
    json: async () => JSON.parse(JSON.stringify(payload)),
  })));
  const { runCLI } = await import('../cli.js');
  const { NansenAPI } = await import('../api.js');
  return {
    runCLI,
    deps: { output: () => {}, errorOutput: () => {}, exit: () => {}, NansenAPIClass: NansenAPI },
  };
}

/** The two `from_cache` values tracked across a miss-then-hit pair. */
function trackedFromCache() {
  expect(trackSucceeded).toHaveBeenCalledTimes(2);
  return trackSucceeded.mock.calls.map(c => c[0].from_cache);
}

describe('from_cache telemetry', () => {
  it('reports the cache hit on the second identical --cache call', async () => {
    const { runCLI, deps } = await loadCli({ data: [{ symbol: 'ETH' }] });
    const argv = ['research', 'token', 'screener', '--cache'];

    await runCLI(argv, deps);
    await runCLI(argv, deps);

    expect(trackedFromCache()).toEqual([false, true]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('reports the cache hit when --fields has stripped _meta off the payload', async () => {
    const { runCLI, deps } = await loadCli({ data: [{ symbol: 'ETH' }] });
    const argv = ['research', 'token', 'screener', '--cache', '--fields', 'symbol'];

    await runCLI(argv, deps);
    await runCLI(argv, deps);

    expect(trackedFromCache()).toEqual([false, true]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('reports the cache hit on the --stream output path', async () => {
    const { runCLI, deps } = await loadCli({ data: [{ symbol: 'ETH' }] });
    const argv = ['research', 'token', 'screener', '--cache', '--stream'];

    await runCLI(argv, deps);
    await runCLI(argv, deps);

    expect(trackedFromCache()).toEqual([false, true]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  // `alerts list` with any filter runs the array through .filter(), producing a
  // fresh array that no longer carries the `_meta` marker — the case the
  // instance flag exists for. Unfiltered, the cached array itself comes back
  // with `_meta` still on it, so the filter flag is what makes these bite.
  it('reports the cache hit when the handler has rebuilt the result', async () => {
    const { runCLI, deps } = await loadCli([{ id: 'a1', name: 'whale moves', isEnabled: true }]);
    const argv = ['alerts', 'list', '--cache', '--enabled'];

    await runCLI(argv, deps);
    await runCLI(argv, deps);

    expect(trackedFromCache()).toEqual([false, true]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('reports the cache hit on the alerts list --table path', async () => {
    const { runCLI, deps } = await loadCli([{ id: 'a1', name: 'whale moves', isEnabled: true }]);
    const argv = ['alerts', 'list', '--table', '--cache', '--enabled'];

    await runCLI(argv, deps);
    await runCLI(argv, deps);

    // This path previously never passed the field at all, so it read undefined.
    expect(trackedFromCache()).toEqual([false, true]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('reports a live response as a miss', async () => {
    const { runCLI, deps } = await loadCli({ data: [{ symbol: 'ETH' }] });
    const argv = ['research', 'token', 'screener'];

    await runCLI(argv, deps);
    await runCLI(argv, deps);

    // No --cache, so both calls go to the network and neither is a hit.
    expect(trackedFromCache()).toEqual([false, false]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
