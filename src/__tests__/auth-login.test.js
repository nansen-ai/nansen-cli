import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { browserLogin, cleanupMessage } from '../auth-login.js';
import { buildCommands, runCLI } from '../cli.js';
import { NansenAPI, loadConfig } from '../api.js';
import { createAuthState } from '../auth-state.js';
import { createAuthStore } from '../auth-store.js';
import { AuthError, authConfigView, resolveCredential } from '../auth-credentials.js';
import { getAuthStatus } from '../doctor.js';
import { buildMcpCommands } from '../commands/mcp.js';
import { sessionFixture, memoryOperation } from './fixtures/auth-fixture.js';
const dirs = [];
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-login-')); dirs.push(home);
  const directory = path.join(home, '.nansen'); fs.mkdirSync(directory);
  const memory = memoryOperation();
  const store = createAuthStore(memory);
  const state = createAuthState({ directory, store, retire: async () => ({ remote: 'recorded_pending' }) });
  return { home, directory, memory, store, state, env: { HOME: home }, file: path.join(directory, 'config.json') };
}
describe('browser login public command integration', () => {
  it.each(['none', 'environment', 'saved-key', 'saved-session'])('fresh plain login from %s saves B and never prints secrets', async initial => {
    const f = fixture();
    if (initial === 'environment') f.env.NANSEN_API_KEY = 'ENV_A';
    if (initial === 'saved-key') fs.writeFileSync(f.file, JSON.stringify({ apiKey: 'SAVED_A' }));
    if (initial === 'saved-session') {
      const a = await f.state.begin(); await f.state.install(a, { bundle: sessionFixture({ accountId: 'A' }), baseUrl: 'https://api.nansen.ai' }); await f.state.finish(a);
    }
    const bundle = sessionFixture(); const log = vi.fn(); const errorOutput = vi.fn();
    const pair = vi.fn(async (_client, options) => {
      await options.onPending({ verification_uri: 'https://idp.nansen.ai/device?user_code=ABCD-EFGH', user_code: 'ABCD-EFGH', expires_at: '2026-09-19T00:00:00Z' });
      options.onIssued(bundle); return bundle;
    });
    const openBrowser = vi.fn();
    const commands = buildCommands({ authState: f.state, env: f.env, log, errorOutput, isTTY: false, browserLoginFn: options => browserLogin({ ...options, pair, openBrowser, signals: new EventEmitter() }) });
    await commands.login([], null, { 'no-browser': true }, {});
    expect(pair).toHaveBeenCalledOnce(); expect(openBrowser).not.toHaveBeenCalled();
    const events = log.mock.calls.map(([line]) => JSON.parse(line));
    expect(events.map(e => e.event)).toEqual(['pending', 'saved']);
    expect(events[1].effective_source).toBe(initial === 'environment' ? 'env' : 'session');
    expect(JSON.parse(fs.readFileSync(f.file))).not.toHaveProperty('apiKey');
    const output = JSON.stringify([log.mock.calls, errorOutput.mock.calls, fs.readFileSync(f.file, 'utf8'), fs.readdirSync(path.join(f.directory, 'auth-operations')).filter(n => n.endsWith('.json')).map(n => fs.readFileSync(path.join(f.directory, 'auth-operations', n), 'utf8'))]);
    for (const secret of [bundle.accessToken, bundle.refreshToken, bundle.privateJwk.d]) expect(output).not.toContain(secret);
    const status = getAuthStatus({ env: f.env, passwordSourceFn: () => null });
    expect(status.saved_session.account_id).toBe('account-B'); expect(status.saved_session.validity).toBe('cached_unverified');
    expect(authConfigView(f.env).selected.kind).toBe(initial === 'environment' ? 'api-key' : 'session');
  });
  it('preflight failure prevents authorize and produces exactly one machine error', async () => {
    const pair = vi.fn(); const log = vi.fn();
    await expect(browserLogin({ state: { begin: async () => { throw new Error('native secret echo'); } }, env: {}, isTTY: false, log, pair, signals: new EventEmitter() })).rejects.toMatchObject({ reported: true });
    expect(pair).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledOnce(); expect(log.mock.calls[0][0]).not.toContain('native secret echo');
  });
  it('cancels approval without replacing the previous key and emits one terminal event', async () => {
    const f = fixture(); fs.writeFileSync(f.file, JSON.stringify({ apiKey: 'A' }));
    const signals = new EventEmitter(); const log = vi.fn();
    const pair = async (_client, { signal }) => { signals.emit('SIGINT'); signal.throwIfAborted(); };
    await expect(browserLogin({ env: f.env, state: f.state, pair, signals, log, errorOutput: vi.fn(), isTTY: false })).rejects.toMatchObject({ code: 'PAIRING_CANCELLED' });
    expect(JSON.parse(fs.readFileSync(f.file)).apiKey).toBe('A');
    expect(log.mock.calls.map(([s]) => JSON.parse(s).event)).toEqual(['cancelled']);
    expect(signals.listenerCount('SIGINT')).toBe(0);
  });
  it.each(['verification', 'storage'])('preserves A and retires issued B after %s failure', async failure => {
    const f = fixture(); f.env.NANSEN_API_KEY = 'ENV_A';
    fs.writeFileSync(f.file, JSON.stringify({ apiKey: 'SAVED_A' }));
    const bundle = sessionFixture();
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ refresh_family_revoked: true, access_tokens_revoked: false })));
    vi.stubGlobal('fetch', fetch);
    if (failure === 'storage') vi.spyOn(f.store, 'write').mockRejectedValue(new Error('write failure'));
    const pair = async (_client, { onIssued }) => {
      onIssued(bundle);
      if (failure === 'verification') throw new AuthError('SESSION_VERIFICATION_FAILED', 'Candidate rejected.');
      return bundle;
    };
    const log = vi.fn();
    await expect(browserLogin({ env: f.env, state: f.state, pair, log, errorOutput: vi.fn(), isTTY: false, signals: new EventEmitter() })).rejects.toThrow();
    expect(JSON.parse(fs.readFileSync(f.file)).apiKey).toBe('SAVED_A');
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][0]).toBe('https://idp.nansen.ai/token/revoke');
    expect(fetch.mock.calls[0][1].headers.Authorization).toBeUndefined();
    expect(f.memory.entries.size).toBe(0);
    expect(log.mock.calls.map(([line]) => JSON.parse(line).event)).toEqual(['error']);
    expect(JSON.stringify(log.mock.calls)).not.toContain(bundle.refreshToken);
  });
  it('legacy --human still prefers env and uses the state owner without prompting', async () => {
    const f = fixture(); f.env.NANSEN_API_KEY = 'key-A'; const promptFn = vi.fn();
    function API() { return { getAccount: async () => ({ credits_remaining: 0 }) }; }
    await buildCommands({ authState: f.state, env: f.env, promptFn, isTTY: false, log: vi.fn(), NansenAPIClass: API }).login([], null, { human: true }, {});
    expect(promptFn).not.toHaveBeenCalled(); expect(JSON.parse(fs.readFileSync(f.file))).toMatchObject({ apiKey: 'key-A', auth: { active: { kind: 'api-key' } } });
  });
  it('logout wins while an explicit key is still being verified', async () => {
    const f = fixture(); let release, started;
    const verifying = new Promise(resolve => { started = resolve; });
    function API() { return { getAccount: async () => { started(); return new Promise(resolve => { release = resolve; }); } }; }
    const commands = buildCommands({ authState: f.state, env: f.env, log: vi.fn(), NansenAPIClass: API });
    const login = commands.login([], null, {}, { 'api-key': 'candidate' });
    await verifying; await f.state.logout(); release({ credits_remaining: 0 });
    await expect(login).rejects.toMatchObject({ code: 'AUTH_SELECTION_CHANGED' });
    expect(JSON.parse(fs.readFileSync(f.file)).auth.active.kind).toBe('none');
  });
  it('keeps status entirely offline and does not open native storage', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await runCLI(['auth', 'status'], { output: vi.fn(), errorOutput: vi.fn(), exit: vi.fn() });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('selected credential and payment boundary', () => {
  it.each([401, 402, 403, 503])('a selected key receiving %s never enters automatic payment', async status => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: 'denied' }), { status })); vi.stubGlobal('fetch', fetch);
    const api = new NansenAPI('selected-invalid-A', 'https://api.nansen.ai', { retry: { maxRetries: 0 } });
    const paid = vi.spyOn(api, '_x402Retry');
    await expect(api.getAccount()).rejects.toMatchObject({ status });
    expect(paid).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledOnce();
  });
  it('retains explicit manual payment alongside an API key', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{}')); vi.stubGlobal('fetch', fetch);
    await new NansenAPI('A', 'https://api.nansen.ai', { defaultHeaders: { 'Payment-Signature': 'manual' } }).getAccount();
    expect(fetch.mock.calls[0][1].headers).toMatchObject({ apikey: 'A', 'Payment-Signature': 'manual' });
  });
  it('never exports a browser session through key-only trading or MCP seams', async () => {
    const f = fixture(); const bundle = sessionFixture(); const attempt = await f.state.begin();
    await f.state.install(attempt, { bundle }); await f.state.finish(attempt);
    vi.stubEnv('HOME', f.home); vi.stubEnv('NANSEN_API_KEY', undefined);
    expect(loadConfig().apiKey).toBeNull(); // trading verifySwapOutcome caller
    const api = new NansenAPI(); expect(api.apiKey).toBeNull();
    const log = vi.fn();
    await expect(buildMcpCommands({ log }).mcp(['install', 'claude-code'], api, { 'dry-run': true }, {})).rejects.toMatchObject({ code: 'API_KEY_REQUIRED' });
    expect(log).not.toHaveBeenCalled();
  });
  it('expired selected sessions never use cache after uncertain renewal', async () => {
    const f = fixture(); const bundle = sessionFixture({ now: Date.now() - 7200000 });
    const attempt = await f.state.begin(); await f.state.install(attempt, { bundle, baseUrl: bundle.audience }); await f.state.finish(attempt);
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const selection = resolveCredential({ env: f.env });
    const api = new NansenAPI(null, bundle.audience, { credential: selection, authState: f.state, cache: { enabled: true } });
    await expect(api.getAccount()).rejects.toMatchObject({ code: 'SESSION_RENEWAL_UNCERTAIN' }); expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][0]).toBe(bundle.issuer + '/token/refresh');
  });
  it('browser session errors never echo tokens and never fall back', async () => {
    const f = fixture(); const bundle = sessionFixture(); const attempt = await f.state.begin(); await f.state.install(attempt, { bundle, baseUrl: bundle.audience }); await f.state.finish(attempt);
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: bundle.accessToken }), { status: 402 })); vi.stubGlobal('fetch', fetch);
    const api = new NansenAPI(null, bundle.audience, { credential: resolveCredential({ env: f.env }), authState: f.state });
    const error = await api.getAccount().catch(e => e);
    expect(JSON.stringify(error)).not.toContain(bundle.accessToken); expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][1].headers.apikey).toBeUndefined();
  });
});

describe('public CLI session error compatibility', () => {
  it.each([
    [401, 'unauthorized', 'UNAUTHORIZED'],
    [403, 'insufficient_credits', 'CREDITS_EXHAUSTED'],
    [403, 'plan_upgrade_required', 'plan_upgrade_required'],
  ])('keeps key/session code parity for %s %s without reflecting session secrets', async (status, code, expected) => {
    const f = fixture(); const bundle = sessionFixture(); const a = await f.state.begin();
    await f.state.install(a, { bundle, baseUrl: bundle.audience }); await f.state.finish(a);
    vi.stubEnv('HOME', f.home); vi.stubEnv('DO_NOT_TRACK', '1');
    for (const [session, args] of [false, true].flatMap(session => [
      [session, ['research', 'profiler', 'labels', '--address', '0x0000000000000000000000000000000000000001', '--chain', 'ethereum']],
      [session, ['agent', 'synthetic question', '--json']],
    ])) {
      const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ code, message: bundle.accessToken, detail: { code, message: bundle.privateJwk.d }, secret: bundle.refreshToken }), { status, headers: { 'content-type': 'application/json', 'x-request-id': bundle.accessToken, 'x-nansen-plan-notice': bundle.refreshToken, 'x-nansen-credits-remaining': '0' } }));
      vi.stubGlobal('fetch', fetch);
      const output = vi.fn(); const errorOutput = vi.fn(); let instance;
      class API extends NansenAPI {
        constructor() {
          super(undefined, bundle.audience, { credential: session ? resolveCredential({ env: f.env }) : { kind: 'api-key', apiKey: 'same-account-key' }, authState: f.state, retry: { maxRetries: 0 } }); instance = this;
        }
      }
      await runCLI(args, { NansenAPIClass: API, output, errorOutput, exit: vi.fn() });
      const envelope = JSON.parse(output.mock.calls.at(-1)[0]);
      expect(envelope.code).toBe(expected);
      if (session) {
        const printed = JSON.stringify([output.mock.calls, errorOutput.mock.calls, instance.lastResponseMeta]);
        for (const secret of [bundle.accessToken, bundle.refreshToken, bundle.privateJwk.d]) expect(printed).not.toContain(secret);
        if (status === 401) expect(envelope.error).toContain('selected browser session');
        expect(envelope.details.credits.remaining).toBe(0);
      }
    }
  });
  it.each(['__proto__', 'constructor', 'PRIVATE_SERVER_CODE'])('does not reflect arbitrary session code %s', async code => {
    const f = fixture(); const bundle = sessionFixture(); const a = await f.state.begin();
    await f.state.install(a, { bundle, baseUrl: bundle.audience }); await f.state.finish(a);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ code, message: bundle.accessToken }), { status: 403 })));
    const api = new NansenAPI(undefined, bundle.audience, { credential: resolveCredential({ env: f.env }), authState: f.state, retry: { maxRetries: 0 } });
    const error = await api.getAccount().catch(e => e);
    expect(error.code).toBe('FORBIDDEN'); expect(error.message).not.toContain(bundle.accessToken);
  });
  it.each([true, false])('reports remote uncertainty only when issuance was possible (%s)', async provenUnissued => {
    const f = fixture(); const log = vi.fn(); const errorOutput = vi.fn();
    const pair = async (_client, { onBeforePoll }) => {
      await onBeforePoll();
      throw Object.assign(new AuthError('PAIRING_EXPIRED', 'Expired.'), { provenUnissued });
    };
    await expect(browserLogin({ env: f.env, state: f.state, pair, log, errorOutput, isTTY: false, signals: new EventEmitter() })).rejects.toThrow('Expired');
    expect(JSON.stringify(errorOutput.mock.calls).includes('Remote revocation unconfirmed')).toBe(!provenUnissued);
  });
});
it.each(['env', 'config'])('identifies the actual unsupported origin source: %s', async source => {
  const f = fixture();
  if (source === 'env') f.env.NANSEN_BASE_URL = 'https://example.invalid';
  else fs.writeFileSync(f.file, JSON.stringify({ baseUrl: 'https://example.invalid' }));
  const pair = vi.fn();
  await expect(browserLogin({ env: f.env, state: f.state, pair, isTTY: true, log: vi.fn(), signals: new EventEmitter() })).rejects.toThrow(source === 'env' ? 'Correct NANSEN_BASE_URL' : 'Correct baseUrl in config.json');
  expect(pair).not.toHaveBeenCalled();
});
it('legacy prompting depends on stdin while redirected browser output stays machine-readable', async () => {
  const f = fixture(); const promptFn = vi.fn().mockResolvedValue('synthetic-key');
  const browserLoginFn = vi.fn();
  class API { async getAccount() { return { user_id: 'synthetic-account' }; } }
  const commands = buildCommands({ env: f.env, authState: f.state, isTTY: false, stdinTTY: true, promptFn, browserLoginFn, NansenAPIClass: API, log: vi.fn() });
  await commands.login([], null, { human: true }, {});
  expect(promptFn).toHaveBeenCalledOnce(); expect(JSON.parse(fs.readFileSync(f.file)).apiKey).toBe('synthetic-key');
  await commands.login([], null, {}, {});
  expect(browserLoginFn.mock.calls[0][0].isTTY).toBe(false);
});

it.each(['response', 'jwt'])('fresh pairing rejects over-ceiling %s lifetime with operator guidance and candidate retirement', async kind => {
  const { createDeviceClient, pairDevice } = await import('../auth-device.js');
  const f = fixture(); fs.writeFileSync(f.file, JSON.stringify({ apiKey: 'previous-key' }));
  const bundle = sessionFixture(); const parts = bundle.accessToken.split('.'); const claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
  if (kind === 'jwt') { claims.exp = claims.iat + 3601; parts[1] = Buffer.from(JSON.stringify(claims)).toString('base64url'); }
  const fetchFn = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ device_code: 'fixture', user_code: 'ABCD-EFGH', verification_uri: 'https://idp.nansen.ai/device', verification_uri_complete: 'https://idp.nansen.ai/device?user_code=ABCD-EFGH', expires_in: 600, interval: 1 })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: parts.join('.'), refresh_token: bundle.refreshToken, token_type: 'Bearer', scope: 'nansen:read', expires_in: kind === 'response' ? 3601 : 3600 })));
  const retire = vi.fn(async () => ({ remote: 'recorded_pending' }));
  const client = createDeviceClient({ audience: bundle.audience, privateJwk: bundle.privateJwk, fetchFn });
  await expect(browserLogin({ env: f.env, state: f.state, clientFactory: () => client, pair: (c, options) => pairDevice(c, { ...options, wait: async () => {} }), retire, signals: new EventEmitter(), isTTY: false, log: vi.fn(), errorOutput: vi.fn() })).rejects.toMatchObject({ code: 'BROWSER_SESSION_SETUP_REQUIRED', message: expect.stringContaining('3600 seconds') });
  expect(fetchFn).toHaveBeenCalledTimes(2); expect(retire).toHaveBeenCalledOnce(); expect(retire.mock.calls[0][0].refreshToken).toBe(bundle.refreshToken);
  expect(JSON.parse(fs.readFileSync(f.file)).apiKey).toBe('previous-key');
});

it('state disagreement guidance preserves the code and directs unconfirmed revocation to the operator', () => {
  const messages = cleanupMessage([{ local: 'incomplete', remote: 'unconfirmed', code: 'AUTH_STATE_INVALID' }]).join(' ');
  expect(messages).toContain('metadata disagree'); expect(messages).toContain('session/revocation operator');
  expect(messages).not.toContain('Unlock'); expect(messages).not.toContain('account security settings');
});
