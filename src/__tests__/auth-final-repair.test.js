import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { afterEach, it, expect, vi } from 'vitest';
import { browserLogin, cleanupMessage } from '../auth-login.js';
import { createDeviceClient, pairDevice } from '../auth-device.js';
import { createAuthState } from '../auth-state.js';
import { createAuthStore } from '../auth-store.js';
import { runCLI } from '../cli.js';
import { sessionFixture, memoryOperation } from './fixtures/auth-fixture.js';
const dirs = [];
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-final-')); dirs.push(home);
  const directory = path.join(home, '.nansen'); fs.mkdirSync(directory);
  const store = createAuthStore(memoryOperation());
  const retire = vi.fn().mockResolvedValue({ remote: 'unconfirmed' });
  return { home, directory, retire, store, state: createAuthState({ directory, store, retire }) };
}
const grant = { device_code: 'SYNTHETIC-PRIVATE-DEVICE', user_code: 'ABCD-EFGH', verification_uri: 'https://idp.nansen.ai/device', verification_uri_complete: 'https://idp.nansen.ai/device?user_code=ABCD-EFGH', expires_in: 600, interval: 1 };
for (const machine of [true, false]) {
  it.each(['before', 'pending', 'slow_down', 'during', 'network', 'server', 'unknown'])('actual pairing cancellation %s, machine=' + machine, async scenario => {
    const f = fixture(); const signals = new EventEmitter(); const log = vi.fn(), errorOutput = vi.fn();
    const outbound = vi.fn().mockRejectedValue(new Error('Outbound forbidden')); vi.stubGlobal('fetch', outbound);
    fs.writeFileSync(path.join(f.directory, 'config.json'), JSON.stringify({ apiKey: 'PREVIOUS-KEY' }));
    let polls = 0, waits = 0;
    const fetchFn = vi.fn(async (url, options) => {
      if (url.endsWith('/authorize')) return new Response(JSON.stringify(grant));
      expect(url).toBe('https://idp.nansen.ai/auth/device/token');
      polls++;
      if (scenario === 'during') { signals.emit('SIGINT'); options.signal.throwIfAborted(); }
      if (scenario === 'network' && polls === 1) throw new Error('synthetic lost response');
      if (scenario === 'server' && polls === 1) return new Response(JSON.stringify({ error: 'authorization_pending' }), { status: 503 });
      if (scenario === 'unknown') { signals.emit('SIGINT'); return new Response(JSON.stringify({ error: 'SYNTHETIC-UNKNOWN' }), { status: 400 }); }
      return new Response(JSON.stringify({ error: scenario === 'slow_down' ? 'slow_down' : 'authorization_pending' }), { status: 400 });
    });
    const pair = (client, options) => pairDevice(client, { ...options, wait: async (_ms, signal) => {
      waits++;
      if ((scenario === 'before' && waits === 1) || (['pending', 'slow_down'].includes(scenario) && waits === 2) || (['network', 'server'].includes(scenario) && waits === 3)) signals.emit('SIGINT');
      signal.throwIfAborted();
    } });
    let failure;
    await runCLI(['login', '--no-browser'], {
      env: { HOME: f.home }, authState: f.state, isTTY: !machine, log, output: log, errorOutput, exit: vi.fn(),
      browserLoginFn: async options => {
        try { return await browserLogin({ ...options, retire: f.retire, clientFactory: opts => createDeviceClient({ ...opts, fetchFn }), pair, signals }); }
        catch (error) { failure = error; throw error; }
      },
    });
    expect(failure).toMatchObject({ code: 'PAIRING_CANCELLED' });
    const uncertain = ['during', 'network', 'server', 'unknown'].includes(scenario);
    const printed = JSON.stringify([log.mock.calls, errorOutput.mock.calls]);
    expect(printed.includes('Remote revocation unconfirmed')).toBe(uncertain);
    expect(printed).not.toContain(grant.device_code);
    if (machine) {
      const events = log.mock.calls.map(([line]) => JSON.parse(line));
      expect(events.map(e => e.event)).toEqual(['pending', 'cancelled']);
      expect(events[1].cleanup).toContainEqual({ local: 'removed', remote: uncertain ? 'unconfirmed' : 'not_needed' });
    }
    expect(JSON.parse(fs.readFileSync(path.join(f.directory, 'config.json'))).apiKey).toBe('PREVIOUS-KEY');
    expect(outbound).not.toHaveBeenCalled(); expect(f.retire).not.toHaveBeenCalled();
  });
}
it.each(['{ "SECRET-CORRUPT', 'null', '{"id":"wrong"}'])('preserves malformed recognized journals and redacts parse contents: %s', async contents => {
  const f = fixture(); const dir = path.join(f.directory, 'auth-operations'); fs.mkdirSync(dir);
  const file = path.join(dir, `${randomUUID()}.json`); fs.writeFileSync(file, contents);
  await expect(f.state.begin()).rejects.toMatchObject({ code: 'AUTH_JOURNAL_INVALID' });
  const error = await f.state.begin().catch(e => e);
  expect(error.message).toContain('auth-operations'); expect(error.message).not.toContain('SECRET-CORRUPT');
  const result = await f.state.logout();
  expect(result.cleanup).toContainEqual({ local: 'incomplete', remote: 'unconfirmed', code: 'AUTH_JOURNAL_INVALID' });
  expect(cleanupMessage(result.cleanup).join(' ')).toContain('Preserve its files');
  expect(fs.readFileSync(file, 'utf8')).toBe(contents); expect(f.retire).not.toHaveBeenCalled();
});
it('foreign JSON is preserved and reported without blocking admission or pretending it was cleaned', async () => {
  const f = fixture(); const dir = path.join(f.directory, 'auth-operations'); fs.mkdirSync(dir);
  for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(dir, `foreign-${i}.json`), 'SECRET-FOREIGN');
  const attempt = await f.state.begin();
  expect(attempt.cleanup).toContainEqual({ local: 'unrecognized', remote: 'not_attempted' });
  await f.state.finish(attempt);
  const result = await f.state.logout();
  expect(result.cleanup).toEqual([{ local: 'unrecognized', remote: 'not_attempted' }]);
  expect(fs.readdirSync(dir).filter(n => n.startsWith('foreign-'))).toHaveLength(10);
});
it('does not expose the store and preserves the original pre-journal failure', async () => {
  const f = fixture(); const original = new Error('synthetic flush failure');
  const state = createAuthState({ directory: f.directory, store: f.store, barrier: async () => { throw original; } });
  expect(state).not.toHaveProperty('store');
  await expect(state.begin()).rejects.toBe(original);
});

it('actual issued candidate verification failure retires only through the injected boundary', async () => {
  const f = fixture(); const bundle = sessionFixture();
  const outbound = vi.fn().mockRejectedValue(new Error('Outbound forbidden')); vi.stubGlobal('fetch', outbound);
  const fetchFn = vi.fn(async url => {
    if (url.endsWith('/authorize')) return new Response(JSON.stringify(grant));
    if (url.endsWith('/token')) return new Response(JSON.stringify({ access_token: bundle.accessToken, refresh_token: bundle.refreshToken, scope: bundle.scope, token_type: 'Bearer', expires_in: 600 }));
    expect(url).toBe('https://api.nansen.ai/api/v1/account'); return new Response('{}', { status: 500 });
  });
  await expect(browserLogin({ env: { HOME: f.home }, state: f.state, retire: f.retire, flags: { 'no-browser': true }, log: vi.fn(), errorOutput: vi.fn(), signals: new EventEmitter(),
    clientFactory: options => createDeviceClient({ ...options, privateJwk: bundle.privateJwk, fetchFn }),
    pair: (client, options) => pairDevice(client, { ...options, wait: async () => {} }),
  })).rejects.toMatchObject({ code: 'SESSION_VERIFICATION_FAILED' });
  expect(f.retire).toHaveBeenCalledOnce(); expect(f.retire.mock.calls[0][0].refreshToken).toBe(bundle.refreshToken);
  expect(outbound).not.toHaveBeenCalled();
});
it('public corruption error is fixed and cleanup authority survives until a valid journal is restored', async () => {
  const f = fixture(); const id = randomUUID(); const dir = path.join(f.directory, 'auth-operations'); fs.mkdirSync(dir);
  const file = path.join(dir, `${id}.json`); const bundle = sessionFixture();
  await f.store.write(id, bundle);
  fs.writeFileSync(file, '{"SYNTHETIC-PRIVATE-PARSE-CONTENT');
  const output = vi.fn();
  await runCLI(['login', '--no-browser'], { env: { HOME: f.home }, authState: f.state, isTTY: false, log: output, output, errorOutput: vi.fn(), exit: vi.fn() });
  expect(JSON.parse(output.mock.calls[0][0])).toMatchObject({ event: 'error', code: 'AUTH_JOURNAL_INVALID' });
  expect(JSON.stringify(output.mock.calls)).not.toContain('SYNTHETIC-PRIVATE-PARSE-CONTENT');
  expect((await f.store.read(id)).refreshToken).toBe(bundle.refreshToken);
  // Operator restoration of a known-valid journal is explicit, never automatic.
  fs.writeFileSync(file, JSON.stringify({ id, generations: [id], unissued: false }));
  expect((await f.state.logout()).cleanup).toContainEqual({ local: 'removed', remote: 'unconfirmed' });
  expect(f.retire).toHaveBeenCalledOnce(); expect(fs.existsSync(file)).toBe(false);
  await expect(f.store.read(id)).rejects.toMatchObject({ code: 'AUTH_STORE_UNAVAILABLE' });
});
it('an already durable no-op still observes cancellation and a failed first marker remains retryable', async () => {
  const f = fixture(); let fail = false;
  const state = createAuthState({ directory: f.directory, store: f.store, barrier: async phase => { if (fail && phase === 'before-rename') throw new Error('synthetic marker failure'); } });
  const attempt = await state.begin(); fail = true;
  await expect(state.markIssuancePossible(attempt)).rejects.toThrow('synthetic marker failure');
  expect(attempt.journal.unissued).toBe(true);
  expect(JSON.parse(fs.readFileSync(path.join(f.directory, 'auth-operations', `${attempt.id}.json`))).unissued).toBe(true);
  fail = false; await state.markIssuancePossible(attempt);
  const abort = new AbortController(); abort.abort();
  await expect(state.markIssuancePossible(attempt, abort.signal)).rejects.toThrow();
  expect(attempt.journal.unissued).toBe(false); await state.finish(attempt);
});
