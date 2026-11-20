import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let NansenAPI;
let buildAlertsCommands;
let originalHome;
let tempHome;

describe('Smart Alert mutation cache isolation', () => {
  beforeAll(async () => {
    originalHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nansen-alert-cache-test-'));
    process.env.HOME = tempHome;
    vi.resetModules();
    ({ NansenAPI } = await import('../api.js'));
    ({ buildAlertsCommands } = await import('../commands/alerts.js'));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(() => {
    process.env.HOME = originalHome;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it.each([
    ['alertsCreate', [{ name: 'Cache create', type: 'sm-token-flows' }]],
    ['alertsUpdate', [{ id: 'cache-update', name: 'Updated' }]],
    ['alertsToggle', [{ id: 'cache-toggle', isEnabled: true }]],
    ['alertsDelete', ['cache-delete']],
  ])('%s bypasses the response cache', async (method, args) => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ success: true }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const api = new NansenAPI('test-api-key', 'https://api.nansen.ai', {
      cache: { enabled: true, ttl: 300 },
    });
    await api[method](...args);
    await api[method](...args);

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  // alerts update merges its flags into the alert it reads and PATCHes the
  // result. Reading that alert from a cached alerts list would send stale
  // filters back to the server and undo any change made since it was cached.
  it('alerts update merges into the live alert, not a cached alerts list', async () => {
    let inflowMin = 1000;
    const mockFetch = vi.fn(async (_url, init) => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => (init.method === 'PATCH'
        ? { success: true }
        : [{ id: 'cache-get', type: 'sm-token-flows', data: { chains: ['ethereum'], inflow_1h: { min: inflowMin } } }]),
    }));
    vi.stubGlobal('fetch', mockFetch);

    const api = new NansenAPI('test-api-key', 'https://api.nansen.ai', {
      cache: { enabled: true, ttl: 300 },
    });
    await api.alertsList();
    inflowMin = 5000; // changed on the server after the list was cached
    await buildAlertsCommands().alerts(['update', 'cache-get'], api, {}, { 'outflow-1h-min': '200' });

    const [, patch] = mockFetch.mock.calls.find(([, init]) => init.method === 'PATCH');
    expect(JSON.parse(patch.body).data).toEqual({
      chains: ['ethereum'],
      inflow_1h: { min: 5000 },
      outflow_1h: { min: 200 },
    });
  });
});
