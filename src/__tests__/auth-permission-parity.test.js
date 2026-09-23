import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { it, expect, vi, afterEach } from 'vitest';
import { NansenAPI } from '../api.js';
import { createAuthState } from '../auth-state.js';
import { createAuthStore } from '../auth-store.js';
import { resolveCredential } from '../auth-credentials.js';
import { validateSession } from '../auth-device.js';
import { simulateAssetChanges } from '../swap-simulation.js';
import { verifySwapOutcome, getQuote, executeTransaction } from '../trading.js';
import { getVault } from '../limit-order.js';
import { SIMULATION_RPCS } from '../rpc-urls.js';
import { sessionFixture, memoryOperation } from './fixtures/auth-fixture.js';
const dirs = []; const original = SIMULATION_RPCS.base;
afterEach(() => { vi.unstubAllGlobals(); SIMULATION_RPCS.base = original; for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
async function selected(kind, audience = 'https://api.nansen.ai') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-parity-')); dirs.push(home);
  const state = createAuthState({ directory: path.join(home, '.nansen'), store: createAuthStore(memoryOperation()), retire: async () => ({ remote: 'recorded_pending' }) });
  const bundle = sessionFixture({ audience });
  if (kind !== 'anonymous') {
    const a = await state.begin();
    await state.install(a, kind === 'session' ? { bundle, baseUrl: audience } : { apiKey: 'synthetic-api-key', baseUrl: audience }); await state.finish(a);
  }
  return { state, bundle, api: new NansenAPI(undefined, audience, { credential: resolveCredential({ env: { HOME: home } }), authState: state, retry: { maxRetries: 0 } }) };
}
const sim = () => new Response(JSON.stringify({ result: [{ calls: [{ status: '0x1', logs: [] }] }] }));
it.each(['api-key', 'session'])('smart-alert CRUD and hosted trade simulation use the same selected %s', async kind => {
  const { api, bundle } = await selected(kind);
  const fetch = vi.fn(async url => url.includes('simulate-swap') ? sim() : new Response('{}')); vi.stubGlobal('fetch', fetch);
  await api.alertsList(); await api.alertsCreate({ name: 'synthetic' }); await api.alertsUpdate({ id: 'synthetic' }); await api.alertsToggle({ id: 'synthetic' }); await api.alertsDelete('synthetic');
  SIMULATION_RPCS.base = 'https://api.nansen.ai/api/v1/trade/simulate-swap';
  await verifySwapOutcome({ chain: 'base', from: '0x0000000000000000000000000000000000000001', quote: { transaction: { to: '0x0000000000000000000000000000000000000002', data: '0x' } }, quoteData: { request: {} }, api });
  expect(fetch).toHaveBeenCalledTimes(6);
  expect(fetch.mock.calls.slice(0,5).map(([,o]) => o.method)).toEqual(['GET','POST','PATCH','PATCH','DELETE']);
  for (const [,options] of fetch.mock.calls) {
    expect(options.redirect).toBe('error');
    expect(options.headers[kind === 'session' ? 'Authorization' : 'apikey']).toBe(kind === 'session' ? `Bearer ${bundle.accessToken}` : 'synthetic-api-key');
    expect(options.headers[kind === 'session' ? 'apikey' : 'Authorization']).toBeUndefined();
    expect(JSON.stringify(options)).not.toContain(bundle.refreshToken); expect(JSON.stringify(options)).not.toContain(bundle.privateJwk.d);
  }
});
it.each(['https://rpc.example.test', 'https://api.nansen.ai.evil.test', 'http://api.nansen.ai', 'https://api.nansen.ai:8443', 'https://user:password@api.nansen.ai'])('never forwards browser custody to custom RPC %s', async url => {
  const { api, state } = await selected('session'); const read = vi.spyOn(state, 'acquireSession');
  SIMULATION_RPCS.base = url; const fetch = vi.fn(async () => sim()); vi.stubGlobal('fetch', fetch);
  await simulateAssetChanges('base', { to: '0x2' }, { from: '0x1', api });
  expect(read).not.toHaveBeenCalled(); expect(fetch.mock.calls[0][1].headers).toEqual({ 'Content-Type': 'application/json' });
});
it('rejects another trusted audience before opening credentials or sending a request', async () => {
  const { api } = await selected('session', 'https://api.banansen.dev'); const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  SIMULATION_RPCS.base = 'https://api.nansen.ai/api/v1/trade/simulate-swap';
  await expect(simulateAssetChanges('base', { to: '0x2' }, { from: '0x1', api })).rejects.toMatchObject({ code: 'AUTH_ORIGIN_MISMATCH' }); expect(fetch).not.toHaveBeenCalled();
});
it('logout invalidation and mixed credentials cannot fall back during hosted simulation', async () => {
  const { api, state } = await selected('session'); const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  api.defaultHeaders = { apikey: 'other-account' };
  await expect(simulateAssetChanges('base', { to: '0x2' }, { from: '0x1', api })).rejects.toMatchObject({ code: 'MIXED_CREDENTIALS' });
  api.defaultHeaders = {}; await state.logout();
  await expect(simulateAssetChanges('base', { to: '0x2' }, { from: '0x1', api })).rejects.toMatchObject({ code: 'AUTH_SELECTION_CHANGED' }); expect(fetch).not.toHaveBeenCalled();
});
it('rejects old read grants rather than broadening their permissions', () => {
  const b = sessionFixture(); b.scope = 'nansen:read'; expect(() => validateSession(b)).toThrow();
  b.scope = 'nansen:api'; const parts = b.accessToken.split('.'); const claims = JSON.parse(Buffer.from(parts[1], 'base64url')); claims.scope = 'nansen:read'; parts[1] = Buffer.from(JSON.stringify(claims)).toString('base64url'); b.accessToken = parts.join('.'); expect(() => validateSession(b)).toThrow();
});
it('keeps third-party trading service quote and signed-transaction submission credential-free', async () => {
  const fetch = vi.fn(async () => new Response('{}')); vi.stubGlobal('fetch', fetch);
  await getQuote({ chain: 'base' }); await executeTransaction({ signedTransaction: 'synthetic-only' }, { retries: 0 });
  for (const [,options] of fetch.mock.calls) { expect(options.headers.Authorization).toBeUndefined(); expect(options.headers.apikey).toBeUndefined(); }
});
it.each([401,403,500])('does not reflect session secrets from hosted HTTP%s errors', async status => {
  const { api, bundle } = await selected('session'); vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: bundle.accessToken }), { status })));
  const error = await simulateAssetChanges('base', { to: '0x2' }, { from: '0x1', api }).catch(e => e);
  expect(error.message).not.toContain(bundle.accessToken);
  if (status !== 500) expect(error.code).toBe('SIMULATION_ACCESS_DENIED');
});

it('limit-order API retains separate wallet authorization without exporting the browser session', async () => {
  const { bundle } = await selected('session');
  const fetch = vi.fn(async () => new Response('{}')); vi.stubGlobal('fetch', fetch);
  await getVault('synthetic-wallet-jwt', 'synthetic-wallet');
  expect(fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer synthetic-wallet-jwt');
  expect(JSON.stringify(fetch.mock.calls)).not.toContain(bundle.accessToken);
  expect(JSON.stringify(fetch.mock.calls)).not.toContain(bundle.refreshToken);
});
it('matching staging simulation resolves the staging session and refuses an extra key', async () => {
  const { api, bundle } = await selected('session', 'https://api.banansen.dev');
  SIMULATION_RPCS.base = 'https://api.banansen.dev/api/v1/trade/simulate-swap';
  const fetch = vi.fn(async () => sim()); vi.stubGlobal('fetch', fetch);
  await simulateAssetChanges('base', { to: '0x2' }, { from: '0x1', api });
  expect(fetch.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${bundle.accessToken}`);
  api.defaultHeaders = { apikey: 'other-account' };
  await expect(simulateAssetChanges('base', { to: '0x2' }, { from: '0x1', api })).rejects.toMatchObject({ code: 'MIXED_CREDENTIALS' });
  expect(fetch).toHaveBeenCalledOnce();
});

it.each(['anonymous', 'api-key', 'session'].flatMap(kind => [401, 403].map(status => [kind, status])))('actual swap verification preserves %s behavior on hosted HTTP%s', async (kind, status) => {
  const { api, state, bundle } = await selected(kind);
  expect(api.selection.kind).toBe(kind);
  const read = vi.spyOn(state, 'acquireSession');
  const payment = vi.spyOn(api, '_x402Retry');
  const fetch = vi.fn(async () => new Response(JSON.stringify({ message: 'synthetic denial' }), { status }));
  vi.stubGlobal('fetch', fetch);
  SIMULATION_RPCS.base = 'https://api.nansen.ai/api/v1/trade/simulate-swap';
  const log = vi.fn();
  const result = await verifySwapOutcome({ chain: 'base', from: '0x0000000000000000000000000000000000000001', quote: { transaction: { to: '0x0000000000000000000000000000000000000002', data: '0x' } }, quoteData: { request: {} }, api, log });
  expect(fetch).toHaveBeenCalledOnce();
  const [url, options] = fetch.mock.calls[0];
  expect(url).toBe(SIMULATION_RPCS.base);
  expect(options.headers).toEqual({ 'Content-Type': 'application/json', ...(kind === 'session' ? { Authorization: `Bearer ${bundle.accessToken}` } : kind === 'api-key' ? { apikey: 'synthetic-api-key' } : {}) });
  expect(options.redirect).toBe(kind === 'anonymous' ? 'follow' : 'error');
  expect(payment).not.toHaveBeenCalled();
  if (kind === 'anonymous') {
    expect(result).toEqual({ proceed: true });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('proceeding without it'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining(`HTTP ${status}`));
  } else {
    expect(result).toEqual({ proceed: false, reason: 'The selected account cannot access hosted simulation. Check account permissions or log in again.' });
    expect(log).not.toHaveBeenCalled();
  }
  if (kind !== 'session') expect(read).not.toHaveBeenCalled();
  expect(JSON.stringify(fetch.mock.calls)).not.toContain(bundle.refreshToken);
  expect(JSON.stringify(fetch.mock.calls)).not.toContain(bundle.privateJwk.d);
  for (const secret of [bundle.accessToken, bundle.refreshToken, bundle.privateJwk.d, 'synthetic-api-key']) expect(JSON.stringify({ result, logs: log.mock.calls })).not.toContain(secret);
});
