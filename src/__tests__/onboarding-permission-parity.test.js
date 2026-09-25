import { it, expect, vi, afterEach } from 'vitest';
import { NansenAPI } from '../api.js';
import { runCLI } from '../cli.js';
import { buildAgentCommands } from '../commands/agent.js';
import { sessionFixture } from './fixtures/auth-fixture.js';
vi.mock('../update-check.js', () => ({ getUpdateNotification: () => null, getUpgradeNotice: () => null, scheduleUpdateCheck: vi.fn() }));
vi.mock('../cost-cache.js', () => ({ refreshCostMapIfStale: vi.fn(), getCostForEndpoint: () => null, creditsCharged: () => null }));
afterEach(() => vi.unstubAllGlobals());
function client(kind) {
  const bundle = sessionFixture();
  const credential = { kind: 'session', source: 'session', issuer: bundle.issuer, audience: bundle.audience, accountId: bundle.accountId, generation: 'synthetic', selectionEpoch: 'synthetic' };
  const api = new NansenAPI(kind === 'api-key' ? 'synthetic-key' : undefined, bundle.audience, { ...(kind === 'session' && { credential, authState: { acquireSession: async () => ({ ...bundle, generation: 'synthetic' }) } }), retry: { maxRetries: 0 } });
  return { api, bundle };
}
it.each(['api-key','session'])('public commands share transport permissions for %s', async kind => {
  const { api, bundle } = client(kind); const calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url, options) => {
    expect(new URL(url).origin).toBe(bundle.audience);
    expect(options.headers.Authorization).toBe(kind === 'session' ? `Bearer ${bundle.accessToken}` : undefined);
    expect(options.headers.apikey).toBe(kind === 'api-key' ? 'synthetic-key' : undefined);
    expect(options.headers['Payment-Signature']).toBeUndefined();
    calls.push(`${options.method || 'GET'} ${new URL(url).pathname}`);
    if (url.includes('/agent/')) return new Response('data: {"type":"delta","text":"synthetic answer"}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    return new Response(JSON.stringify({ data: [], credits: 0 }));
  }));
  class SelectedAPI { constructor() { return api; } }
  for (const args of [['account'],['research','portfolio','defi','--wallet','0x0000000000000000000000000000000000000001'],['alerts','list']]) {
    const result = await runCLI(args, { NansenAPIClass: SelectedAPI, isTTY: false, output: () => {}, errorOutput: () => {}, log: () => {}, exit: code => { throw new Error(`exit ${code}`); } });
    expect(result.type).toBe('success');
  }
  await api.alertsCreate({ name: 'synthetic' }); await api.alertsGet('synthetic'); await api.alertsUpdate({ id: 'synthetic' }); await api.alertsToggle({ id: 'synthetic' }); await api.alertsDelete('synthetic');
  await api.webSearch({ queries: ['synthetic'] }); await api.webFetch({ urls: ['https://example.test'], question: 'synthetic' }); await api.researchDexTrades();
  const agent = buildAgentCommands({ log: () => {}, errorLog: () => {}, write: () => {} }).agent;
  for (const expert of [false,true]) await agent(['synthetic'], api, { expert, json: true }, {});
  for (const route of ['GET /api/v1/account','POST /api/v1/portfolio/defi-holdings','GET /api/v1/smart-alert/list','POST /api/v1/smart-alert','PATCH /api/v1/smart-alert','DELETE /api/v1/smart-alert/synthetic','POST /api/v1/search/web-search','POST /api/v1/search/web-fetch','POST /api/v1beta1/tgm/historical-dex-trades','POST /api/v1/agent/fast','POST /api/v1/agent/expert']) expect(calls).toContain(route);
});
it.each([401,402,403,404,405,429])('preserves endpoint HTTP%s refusal without payment fallback for either credential', async status => {
  for (const kind of ['api-key','session']) {
    const { api } = client(kind); const fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'synthetic refusal' }), { status })); vi.stubGlobal('fetch', fetch);
    await expect(api.request('/api/v1/unknown-operation', {}, { method: 'PATCH', cache: false })).rejects.toMatchObject({ status });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1].headers['Payment-Signature']).toBeUndefined();
  }
});
