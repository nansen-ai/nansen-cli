import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPublicKey, createPrivateKey, verify, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAuthState, renewalStatus } from '../auth-state.js';
import { createAuthStore } from '../auth-store.js';
import { refreshSession } from '../auth-device.js';
import { resolveCredential, AuthError } from '../auth-credentials.js';
import { getAuthStatus } from '../doctor.js';
import { buildAgentCommands } from '../commands/agent.js';
import { buildCommands } from '../cli.js';
import { simulateAssetChanges } from '../swap-simulation.js';
import { SIMULATION_RPCS } from '../rpc-urls.js';
import { NansenAPI } from '../api.js';
import { issuedFixture, sessionFixture, memoryOperation } from './fixtures/auth-fixture.js';
const roots = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const response = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const json = file => JSON.parse(fs.readFileSync(file));
async function fixture({ age = 3590000, barrier, operationMs, waitMs } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-refresh-')); roots.push(home);
  const directory = path.join(home, '.nansen');
  let time = Date.now();
  const now = () => time;
  const memory = memoryOperation(); const store = createAuthStore(memory);
  const old = sessionFixture({ now: time - age });
  const retire = vi.fn(async () => ({ remote: 'recorded_pending' }));
  const fetchFn = vi.fn(async () => {
    const next = issuedFixture(old.privateJwk, { now: time });
    return response(200, { access_token: next.accessToken, refresh_token: 'replacement-secret', token_type: 'Bearer', expires_in: 3600 });
  });
  const state = createAuthState({ directory, store, retire, now, barrier, waitMs, operationMs,
    refresh: (bundle, options) => refreshSession(bundle, { ...options, fetchFn }) });
  const a = await state.begin(); await state.install(a, { bundle: old, baseUrl: old.audience }); await state.finish(a);
  const selection = resolveCredential({ env: { HOME: home } });
  const acquire = (s = selection, signal) => state.acquireSession(s, { audience: old.audience, signal });
  const file = path.join(directory, 'config.json');
  const journal = () => path.join(directory, 'auth-operations', `${selection.selectionEpoch}.json`);
  return { home, directory, file, journal, state, store, memory, selection, old, fetchFn, retire, acquire, now, advance(ms) { time += ms; } };
}
describe('owner-managed renewal', () => {
  it.each([3590000, 7200000])('renews near/after expiry, retains key and epoch, and only deletes the old blob locally (%s)', async age => {
    const f = await fixture({ age }); const bundle = await f.acquire();
    expect(bundle.refreshToken).toBe('replacement-secret'); expect(bundle.privateJwk).toEqual(f.old.privateJwk);
    expect(json(f.file).auth).toMatchObject({ version: 2, selectionEpoch: f.selection.selectionEpoch, active: { generation: bundle.generation } });
    expect(bundle.generation).not.toBe(f.selection.generation); expect(f.retire).not.toHaveBeenCalled();
    expect([...f.memory.entries.keys()].every(k => k.startsWith(bundle.generation))).toBe(true);
    expect((await f.acquire()).generation).toBe(bundle.generation); expect(f.fetchFn).toHaveBeenCalledOnce();
  });
  it('uses fresh access without upgrading or calling refresh', async () => {
    const f = await fixture({ age: 0 }); expect((await f.acquire()).accessToken).toBe(f.old.accessToken);
    expect(f.fetchFn).not.toHaveBeenCalled(); expect(json(f.file).auth.version).toBe(1);
  });
  it('uses the original signing key and fresh nonce proof with the exact body protocol', async () => {
    const f = await fixture(); const proofs = [];
    f.fetchFn.mockImplementation(async (url, options) => {
      expect(url).toBe(f.old.issuer + '/token/refresh'); expect(options.redirect).toBe('error');
      expect(JSON.parse(options.body)).toEqual({ refresh_token: f.old.refreshToken, audience: f.old.audience });
      expect(options.headers.Authorization).toBeUndefined();
      const [header, payload, signature] = options.headers.DPoP.split('.');
      expect(verify('sha256', Buffer.from(`${header}.${payload}`), { key: createPublicKey(createPrivateKey({ key: f.old.privateJwk, format: 'jwk' })), dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))).toBe(true);
      proofs.push(JSON.parse(Buffer.from(payload, 'base64url')));
      if (proofs.length === 1) return response(401, { error: 'use_dpop_nonce' }, { 'DPoP-Nonce': 'fixture-nonce' });
      const next = issuedFixture(f.old.privateJwk);
      return response(200, { access_token: next.accessToken, refresh_token: 'next', token_type: 'Bearer', expires_in: 3600 });
    });
    await f.acquire(); expect(proofs[1]).toMatchObject({ nonce: 'fixture-nonce', htu: f.old.issuer + '/token/refresh', htm: 'POST' }); expect(proofs[1].jti).not.toBe(proofs[0].jti);
  });
  it.each([401, 500, 503, 200])('does not replay opaque/invalid responses (%s), including after grace and repeated restart', async status => {
    const f = await fixture(); f.fetchFn.mockResolvedValue(response(status, status === 401 ? { error: 'invalid_refresh_token' } : { echo: f.old.refreshToken }));
    const code = status === 401 ? 'SESSION_REFRESH_REJECTED' : 'SESSION_RENEWAL_UNCERTAIN';
    await expect(f.acquire()).rejects.toMatchObject({ code }); f.advance(120000);
    for (let i = 0; i < 2; i++) {
      const restarted = createAuthState({ directory: f.directory, store: f.store, now: f.now, refresh: vi.fn(() => { throw new Error('must not replay'); }) });
      await expect(restarted.acquireSession(f.selection, { audience: f.old.audience })).rejects.toMatchObject({ code });
    }
    expect(f.fetchFn).toHaveBeenCalledOnce(); expect(f.retire).not.toHaveBeenCalled();
  });
  it.each([60, 86400])('keeps definitive 429 retry state for %ss and provides login recovery without using expired access', async seconds => {
    const f = await fixture(); f.fetchFn.mockResolvedValueOnce(response(429, { error: 'rate_limited' }, { 'retry-after': String(seconds) }));
    await expect(f.acquire()).rejects.toMatchObject({ code: 'SESSION_REFRESH_RETRYABLE', message: expect.stringContaining('nansen login') });
    expect((await f.acquire()).accessToken).toBe(f.old.accessToken);
    f.advance(20000); await expect(f.acquire()).rejects.toMatchObject({ code: 'SESSION_REFRESH_RETRYABLE', message: expect.stringContaining('nansen login') });
    expect(f.fetchFn).toHaveBeenCalledOnce(); f.advance(seconds * 1000); await f.acquire(); expect(f.fetchFn).toHaveBeenCalledTimes(2);
  });
  it('lost response requires login and actual logout can retire through the retained parent', async () => {
    const f = await fixture(); f.fetchFn.mockRejectedValue(new Error('raw-secret-echo'));
    await expect(f.acquire()).rejects.toMatchObject({ code: 'SESSION_RENEWAL_UNCERTAIN' });
    const result = await f.state.logout();
    expect(result.cleanup).toContainEqual({ remote: 'recorded_pending', local: 'removed' });
    expect(f.retire.mock.calls[0][0].refreshToken).toBe(f.old.refreshToken); expect(f.memory.entries.size).toBe(0);
  });
  it.each(['manifest', 'rotation-stored', 'rotation-committed'])('recovers a complete stored target at %s without another refresh or revoke', async phase => {
    const f = await fixture(); let once = true;
    const barrier = async at => { if (at === phase && once) { once = false; throw new Error('interrupted'); } };
    const store = createAuthStore({ ...f.memory, barrier });
    const state = createAuthState({ directory: f.directory, store, barrier, retire: f.retire, now: f.now, refresh: (b, o) => refreshSession(b, { ...o, fetchFn: f.fetchFn }) });
    await expect(state.acquireSession(f.selection, { audience: f.old.audience })).rejects.toThrow();
    const renewed = await f.acquire(); expect(renewed.refreshToken).toBe('replacement-secret'); expect(f.fetchFn).toHaveBeenCalledOnce(); expect(f.retire).not.toHaveBeenCalled();
  });
  it('an inaccessible target is not classified as absent, and no secret appears in offline diagnostics', async () => {
    const f = await fixture({ barrier: async phase => { if (phase === 'rotation-received') throw new Error('interrupted'); } });
    await expect(f.acquire()).rejects.toThrow();
    const read = vi.spyOn(f.store, 'read').mockRejectedValue(new AuthError('AUTH_STORE_UNAVAILABLE', 'locked'));
    await expect(f.acquire()).rejects.toMatchObject({ code: 'AUTH_STORE_UNAVAILABLE' }); read.mockRestore();
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const status = getAuthStatus({ env: { HOME: f.home }, passwordSourceFn: () => null });
    expect(status.saved_session.renewal_state).toBe('pending_or_uncertain'); expect(status.saved_session.storage_access).toBe('not_checked_no_prompt');
    expect(fetch).not.toHaveBeenCalled();
    const output = JSON.stringify([status, json(f.file), json(f.journal())]);
    for (const secret of [f.old.accessToken, f.old.refreshToken, f.old.privateJwk.d]) expect(output).not.toContain(secret);
    await expect(f.acquire()).rejects.toMatchObject({ code: 'SESSION_RENEWAL_UNCERTAIN' });
  });
  it('cleanup failure cannot accumulate another generation or remotely retire the active family', async () => {
    const f = await fixture(); const remove = vi.spyOn(f.store, 'remove').mockRejectedValue(new Error('locked'));
    const next = await f.acquire(); expect(f.retire).not.toHaveBeenCalled(); expect(fs.existsSync(f.journal())).toBe(true);
    f.advance(3600000); await expect(f.acquire()).rejects.toMatchObject({ code: 'AUTH_CLEANUP_REQUIRED' }); expect(f.fetchFn).toHaveBeenCalledOnce();
    remove.mockRestore(); f.advance(-3600000); expect((await f.acquire()).generation).toBe(next.generation); expect(fs.existsSync(f.journal())).toBe(false);
  });
  it('pending pairing survives refresh, while account replacement rejects a stale selection', async () => {
    const f = await fixture(); const b = await f.state.begin(); await f.acquire();
    await f.state.install(b, { bundle: sessionFixture({ accountId: 'B' }) }); await f.state.finish(b);
    await expect(f.acquire()).rejects.toMatchObject({ code: 'AUTH_SELECTION_CHANGED' }); expect(f.retire).toHaveBeenCalledOnce(); expect(f.retire.mock.calls[0][0].refreshToken).toBe('replacement-secret');
  });
  it('origin mismatch prevents refresh and explicit keys bypass inactive storage', async () => {
    const f = await fixture(); await expect(f.state.acquireSession(f.selection, { audience: 'https://evil.invalid' })).rejects.toMatchObject({ code: 'AUTH_ORIGIN_MISMATCH' });
    const acquire = vi.spyOn(f.state, 'acquireSession'); const fetch = vi.fn(async () => response(200, {})); vi.stubGlobal('fetch', fetch);
    await new NansenAPI('explicit', f.old.audience, { authState: f.state }).getAccount(); expect(acquire).not.toHaveBeenCalled(); expect(f.fetchFn).not.toHaveBeenCalled();
  });
  it('queue cancellation preserves order and never runs abandoned callbacks', async () => {
    let entered, release;
    const blocked = new Promise(r => { entered = r; }); const waiting = new Promise(r => { release = r; });
    const f = await fixture({ waitMs: 30, barrier: async phase => { if (phase === 'rotation-marked') { entered(); await waiting; } } });
    const first = f.acquire(); await blocked;
    const controller = new AbortController(); const cancelled = f.acquire(f.selection, controller.signal); controller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: 'AUTH_CANCELLED' });
    await expect(f.acquire()).rejects.toMatchObject({ code: 'AUTH_BUSY' });
    release(); await first; expect((await f.acquire()).refreshToken).toBe('replacement-secret'); expect(f.fetchFn).toHaveBeenCalledOnce();
  });
  it('full owned deadline aborts transmitted refresh and preserves durable uncertainty', async () => {
    const f = await fixture({ operationMs: 40 });
    f.fetchFn.mockImplementation((_url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('secret-abort')), { once: true })));
    await expect(f.acquire()).rejects.toMatchObject({ code: 'AUTH_TIMEOUT' });
    await expect(f.acquire()).rejects.toMatchObject({ code: 'SESSION_RENEWAL_UNCERTAIN' }); expect(f.fetchFn).toHaveBeenCalledOnce();
  });
  it('malformed typed metadata fails closed, and v2 remains v2 after logout', async () => {
    const f = await fixture(); await f.acquire(); await f.state.logout(); expect(json(f.file).auth.version).toBe(2);
    fs.writeFileSync(f.journal(), JSON.stringify({ id: f.selection.selectionEpoch, kind: 'rotation', version: 99 }));
    expect(renewalStatus(f.directory, f.selection)).toBe('metadata_unreadable');
    await expect(f.state.begin()).rejects.toMatchObject({ code: 'AUTH_JOURNAL_INVALID' });
  });
});

it('the public account command reacquires headers after resource backoff crosses expiry', async () => {
  const f = await fixture(); let renewals = 0;
  vi.spyOn(Date, 'now').mockImplementation(f.now);
  f.fetchFn.mockImplementation(async () => {
    const next = issuedFixture(f.old.privateJwk, { now: f.now() });
    return response(200, { access_token: next.accessToken, refresh_token: `replacement-${++renewals}`, token_type: 'Bearer', expires_in: 3600 });
  });
  const acquire = vi.spyOn(f.state, 'acquireSession');
  const headers = [];
  vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
    headers.push(options.headers);
    if (headers.length === 1) { f.advance(3600001); return response(503, {}); }
    return response(200, { user_id: 'account-B' });
  }));
  const api = new NansenAPI(undefined, f.old.audience, { credential: f.selection, authState: f.state, retry: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1 } });
  await buildCommands().account([], api, {}, {});
  expect(acquire).toHaveBeenCalledTimes(2);
  for (const [selection, options] of acquire.mock.calls) { expect(selection.selectionEpoch).toBe(f.selection.selectionEpoch); expect(options.audience).toBe(f.old.audience); }
  expect(renewals).toBe(2); expect(headers).toHaveLength(2); expect(headers[1].Authorization).not.toBe(headers[0].Authorization);
  for (const h of headers) { expect(h.apikey).toBeUndefined(); expect(h['Payment-Signature']).toBeUndefined(); }
});
it('SSE opens once with renewed headers and holds no owner lock during the stream', async () => {
  const f = await fixture(); const api = new NansenAPI(undefined, f.old.audience, { credential: f.selection, authState: f.state });
  const fetch = vi.fn(async (_url, options) => {
    expect(options.headers.Authorization).not.toBe(`Bearer ${f.old.accessToken}`);
    // A separate owner can logout while the actual stream is being consumed.
    return { ok: true, status: 200, headers: new Headers(), body: {
      async *[Symbol.asyncIterator]() {
        await f.state.logout();
        yield new TextEncoder().encode('data: {"type":"finish","conversation_id":"c1"}\n\ndata: [DONE]\n\n');
      },
    } };
  });
  vi.stubGlobal('fetch', fetch);
  await buildAgentCommands({ log: vi.fn(), errorLog: vi.fn(), write: vi.fn() }).agent(['test'], api, {}, {});
  expect(fetch).toHaveBeenCalledOnce(); expect(f.fetchFn).toHaveBeenCalledOnce();
});
it.each(['scope', 'subject', 'key', 'audience', 'coverage', 'lifetime', 'size', 'repeat'])('rejects malformed replacement %s without publishing or echoing credentials', async kind => {
  const f = await fixture();
  let next = issuedFixture(kind === 'key' ? sessionFixture().privateJwk : f.old.privateJwk);
  const parts = next.accessToken.split('.'); const claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
  if (kind === 'scope') claims.scope = 'wallet';
  if (kind === 'subject') claims.sub = 'other-account';
  if (kind === 'audience') claims.aud = 'https://evil.invalid';
  if (kind === 'coverage') delete claims.session_access_revocation_version;
  if (kind === 'lifetime') claims.exp = claims.iat + 7200;
  parts[1] = Buffer.from(JSON.stringify(claims)).toString('base64url'); next = { ...next, accessToken: parts.join('.') };
  f.fetchFn.mockResolvedValue(response(200, { access_token: next.accessToken, refresh_token: kind === 'repeat' ? f.old.refreshToken : kind === 'size' ? 's'.repeat(4097) : 'next', token_type: 'Bearer', expires_in: 3600 }));
  const error = await f.acquire().catch(e => e);
  expect(error.code).toBe(['coverage', 'lifetime'].includes(kind) ? 'BROWSER_SESSION_SETUP_REQUIRED' : 'SESSION_RENEWAL_UNCERTAIN'); expect(JSON.stringify(error)).not.toContain(next.accessToken);
  expect(json(f.file).auth.active.generation).toBe(f.selection.generation); expect(f.retire).not.toHaveBeenCalled();
});
it('the full store budget stops a chunk sequence and a later command cannot reuse its consumed source', async () => {
  const f = await fixture(); let delayed = false;
  const operation = async (...args) => { if (args[0] === 'set' && !delayed) { delayed = true; await new Promise(r => setTimeout(r, 60)); } return f.memory.operation(...args); };
  const state = createAuthState({ directory: f.directory, store: createAuthStore({ operation }), operationMs: 30, now: f.now,
    refresh: (b, o) => refreshSession(b, { ...o, fetchFn: f.fetchFn }) });
  await expect(state.acquireSession(f.selection, { audience: f.old.audience })).rejects.toMatchObject({ code: 'AUTH_TIMEOUT' });
  expect(f.fetchFn).toHaveBeenCalledOnce();
  await expect(f.acquire()).rejects.toMatchObject({ code: 'SESSION_RENEWAL_UNCERTAIN' });
});

it('delayed pairing finish cannot retire the generation that has since refreshed', async () => {
  const f = await fixture();
  const b = await f.state.begin();
  const oldGeneration = f.selection.generation;
  const remove = vi.spyOn(f.store, 'remove').mockImplementation(async generation => {
    if (generation === oldGeneration) throw new Error('old independent family deletion blocked');
    return createAuthStore(f.memory).remove(generation);
  });
  const candidate = sessionFixture({ now: f.now() - 3590000 });
  await f.state.install(b, { bundle: candidate, baseUrl: candidate.audience });
  const choice = resolveCredential({ env: { HOME: f.home } });
  f.fetchFn.mockImplementation(async () => {
    const next = issuedFixture(candidate.privateJwk, { now: f.now() });
    return response(200, { access_token: next.accessToken, refresh_token: 'new-child', token_type: 'Bearer', expires_in: 3600 });
  });
  f.retire.mockClear();
  const renewed = await f.acquire(choice);
  await f.state.finish(b);
  expect(f.retire.mock.calls.every(([bundle]) => bundle.generation === oldGeneration)).toBe(true);
  expect((await f.acquire(choice)).generation).toBe(renewed.generation);
  remove.mockRestore();
});
it('an interrupted pairing journal is discharged before its active generation rotates', async () => {
  const f = await fixture();
  const id = f.selection.generation;
  const journal = path.join(f.directory, 'auth-operations', `${id}.json`);
  fs.writeFileSync(journal, JSON.stringify({ id, generations: [id] }));
  await f.acquire(); await f.state.begin({ preflight: false }).then(a => f.state.finish(a));
  expect(f.retire).not.toHaveBeenCalled(); expect(fs.existsSync(journal)).toBe(false);
});


it('foreign JSON cannot consume renewal admission and remains reported by cleanup', async () => {
  const f = await fixture(); const dir = path.dirname(f.journal());
  for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(dir, `foreign-${i}.json`), 'PRIVATE-FOREIGN');
  const next = await f.acquire();
  expect(next.generation).not.toBe(f.selection.generation);
  expect(f.fetchFn).toHaveBeenCalledOnce(); expect(f.retire).not.toHaveBeenCalled();
  expect((await f.state.logout()).cleanup).toContainEqual({ local: 'unrecognized', remote: 'not_attempted' });
  expect(fs.readdirSync(dir).filter(n => n.startsWith('foreign-'))).toHaveLength(10);
});

it.each(['null', '{"PRIVATE-CORRUPTION', 'x'.repeat(4097), 'broken-symlink'])('corrupt rotation metadata retains target authority until valid restoration (%#)', async contents => {
  const f = await fixture({ barrier: async phase => { if (phase === 'rotation-stored') throw new Error('crash'); } });
  await expect(f.acquire()).rejects.toThrow('crash');
  const independent = randomUUID(); const other = sessionFixture({ accountId: 'unrelated' }); await f.store.write(independent, other);
  const valid = fs.readFileSync(f.journal(), 'utf8'); const before = [...f.memory.entries.keys()];
  if (contents === 'broken-symlink') { fs.unlinkSync(f.journal()); fs.symlinkSync(path.join(f.directory, 'absent-journal'), f.journal()); }
  else fs.writeFileSync(f.journal(), contents);
  const error = await f.acquire().catch(e => e);
  expect(error).toMatchObject({ code: 'AUTH_JOURNAL_INVALID' });
  expect(error.message).toContain('auth-operations'); expect(error.message).not.toContain('PRIVATE-CORRUPTION');
  await expect(f.state.begin()).rejects.toMatchObject({ code: 'AUTH_JOURNAL_INVALID' });
  expect((await f.state.logout()).cleanup).toContainEqual({ local: 'incomplete', remote: 'unconfirmed', code: 'AUTH_JOURNAL_INVALID' });
  expect(json(f.file).auth.active.kind).toBe('none');
  await expect(f.state.begin()).rejects.toMatchObject({ code: 'AUTH_JOURNAL_INVALID' });
  await expect(f.state.begin({ preflight: false })).rejects.toMatchObject({ code: 'AUTH_JOURNAL_INVALID' });
  await expect(f.acquire()).rejects.toMatchObject({ code: 'AUTH_SELECTION_CHANGED' });
  if (contents === 'broken-symlink') expect(fs.lstatSync(f.journal()).isSymbolicLink()).toBe(true);
  else expect(fs.readFileSync(f.journal(), 'utf8')).toBe(contents);
  expect([...f.memory.entries.keys()]).toEqual(before); expect(f.retire).not.toHaveBeenCalled();
  expect(f.fetchFn).toHaveBeenCalledOnce();
  if (contents === 'broken-symlink') fs.unlinkSync(f.journal());
  fs.writeFileSync(f.journal(), valid);
  expect(f.fetchFn).toHaveBeenCalledOnce(); expect(f.retire).not.toHaveBeenCalled();
  await f.state.logout(); expect(f.retire).toHaveBeenCalledOnce();
  expect((await f.store.read(independent)).refreshToken).toBe(other.refreshToken);
  expect([...f.memory.entries.keys()].every(k => k.startsWith(independent))).toBe(true);
});


it.each(['epoch', 'generation', 'account'])('rejects malformed v1 %s before upgrade, journal or dispatch', async field => {
  const f = await fixture(); const config = json(f.file);
  if (field === 'epoch') delete config.auth.selectionEpoch;
  if (field === 'generation') config.auth.active.generation = 'invalid';
  if (field === 'account') config.auth.active.accountId = 'x'.repeat(256);
  fs.writeFileSync(f.file, JSON.stringify(config)); const before = fs.readFileSync(f.file, 'utf8');
  const selection = resolveCredential({ env: { HOME: f.home } });
  await expect(f.acquire(selection)).rejects.toMatchObject({ code: 'AUTH_STATE_INVALID' });
  expect(fs.readFileSync(f.file, 'utf8')).toBe(before); expect(f.fetchFn).not.toHaveBeenCalled();
  expect(fs.readdirSync(path.dirname(f.journal())).filter(n => n.endsWith('.json'))).toEqual([]);
});
it.each([2, 60, 61])('bounded issuer clock skew of %s seconds', async skew => {
  const f = await fixture(); const next = issuedFixture(f.old.privateJwk, { now: f.now() + skew * 1000 });
  f.fetchFn.mockResolvedValue(response(200, { access_token: next.accessToken, refresh_token: 'next', token_type: 'Bearer', expires_in: 3600 }));
  if (skew <= 60) expect((await f.acquire()).refreshToken).toBe('next');
  else {
    for (let i = 0; i < 2; i++) await expect(f.acquire()).rejects.toMatchObject({ code: 'SESSION_CLOCK_SKEW' });
    expect(json(f.journal())).toMatchObject({ phase: 'blocked', reason: 'clock' });
    expect(f.fetchFn).toHaveBeenCalledOnce();
  }
});
it.each(['setup', 'expired', 'protocol'])('retains fixed %s guidance across fresh owners without replay', async kind => {
  const f = await fixture(); let next = issuedFixture(f.old.privateJwk, { now: kind === 'expired' ? f.now() - 3600000 : f.now() });
  if (kind === 'setup') {
    const parts = next.accessToken.split('.'); const c = JSON.parse(Buffer.from(parts[1], 'base64url')); delete c.session_access_revocation_version;
    parts[1] = Buffer.from(JSON.stringify(c)).toString('base64url'); next.accessToken = parts.join('.');
  }
  f.fetchFn.mockResolvedValue(kind === 'protocol' ? response(400, { error: 'invalid_request' }) : response(200, { access_token: next.accessToken, refresh_token: 'next', token_type: 'Bearer', expires_in: 3600 }));
  const code = { setup: 'BROWSER_SESSION_SETUP_REQUIRED', expired: 'SESSION_EXPIRED', protocol: 'SESSION_REFRESH_PROTOCOL_ERROR' }[kind];
  await expect(f.acquire()).rejects.toMatchObject({ code });
  const restarted = createAuthState({ directory: f.directory, store: f.store, now: f.now, refresh: f.fetchFn, retire: f.retire });
  await expect(restarted.acquireSession(f.selection, { audience: f.old.audience })).rejects.toMatchObject({ code });
  expect(json(f.journal())).toMatchObject({ phase: 'blocked', reason: kind }); expect(f.fetchFn).toHaveBeenCalledOnce();
});
it.each(['ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'UND_ERR_CONNECT_TIMEOUT', 'ETIMEDOUT'])('an arbitrary injected %s cause cannot establish safe dispatch topology', async code => {
  const f = await fixture(); f.fetchFn.mockRejectedValue(Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('private hostname'), { code, syscall: 'connect', errno: -61, address: '127.0.0.1', port: 443 }) }));
  await expect(f.acquire()).rejects.toMatchObject({ code: 'SESSION_RENEWAL_UNCERTAIN' });
  await expect(f.acquire()).rejects.toMatchObject({ code: 'SESSION_RENEWAL_UNCERTAIN' }); expect(f.fetchFn).toHaveBeenCalledOnce();
});

it.each(['response', 'jwt'])('over-ceiling %s lifetime blocks durably with setup guidance and retained retirement authority', async kind => {
  const f = await fixture(); const next = issuedFixture(f.old.privateJwk, { now: f.now() });
  const parts = next.accessToken.split('.'); const claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
  if (kind === 'jwt') { claims.exp = claims.iat + 3601; parts[1] = Buffer.from(JSON.stringify(claims)).toString('base64url'); }
  f.fetchFn.mockResolvedValue(response(200, { access_token: parts.join('.'), refresh_token: 'rotated-lifetime', token_type: 'Bearer', expires_in: kind === 'response' ? 3601 : 3600 }));
  await expect(f.acquire()).rejects.toMatchObject({ code: 'BROWSER_SESSION_SETUP_REQUIRED', message: expect.stringContaining('3600-second lifetime') });
  expect(json(f.journal())).toMatchObject({ phase: 'blocked', reason: 'setup' });
  const replay = vi.fn(); const restarted = createAuthState({ directory: f.directory, store: f.store, now: f.now, refresh: replay, retire: f.retire });
  await expect(restarted.acquireSession(f.selection, { audience: f.old.audience })).rejects.toMatchObject({ code: 'BROWSER_SESSION_SETUP_REQUIRED', message: expect.stringContaining('3600-second lifetime') });
  expect(replay).not.toHaveBeenCalled(); expect(f.fetchFn).toHaveBeenCalledOnce(); expect(f.retire).not.toHaveBeenCalled();
  await restarted.logout(); expect(f.retire).toHaveBeenCalledOnce(); expect(f.retire.mock.calls[0][0].refreshToken).toBe(f.old.refreshToken);
});
it('logout reports pointer/journal disagreement as state invalid and retains both authorities', async () => {
  const f = await fixture({ barrier: async phase => { if (phase === 'rotation-stored') throw new Error('crash'); } });
  await expect(f.acquire()).rejects.toThrow('crash');
  const config = json(f.file); config.auth.active.generation = randomUUID(); fs.writeFileSync(f.file, JSON.stringify(config));
  const before = [...f.memory.entries.keys()]; const journal = fs.readFileSync(f.journal(), 'utf8');
  expect((await f.state.logout()).cleanup).toEqual([{ local: 'incomplete', remote: 'unconfirmed', code: 'AUTH_STATE_INVALID' }]);
  expect(json(f.file).auth.active.kind).toBe('none'); expect(fs.readFileSync(f.journal(), 'utf8')).toBe(journal);
  expect([...f.memory.entries.keys()]).toEqual(before); expect(f.retire).not.toHaveBeenCalled();
});

it.each(['nansen:read', '', undefined])('refuses refreshed JWT scope %s with durable no-replay and no fallback', async scope => {
  const f = await fixture(); const next = issuedFixture(f.old.privateJwk, { now: f.now() });
  const parts = next.accessToken.split('.'); const claims = JSON.parse(Buffer.from(parts[1], 'base64url')); claims.scope = scope;
  parts[1] = Buffer.from(JSON.stringify(claims)).toString('base64url');
  f.fetchFn.mockResolvedValue(response(200, { access_token: parts.join('.'), refresh_token: 'downgraded', token_type: 'Bearer', expires_in: 3600 }));
  const resource = vi.fn(); vi.stubGlobal('fetch', resource);
  const api = new NansenAPI(undefined, f.old.audience, { credential: f.selection, authState: f.state });
  await expect(api.alertsCreate({ name: 'fixture' })).rejects.toMatchObject({ code: 'SESSION_RENEWAL_UNCERTAIN' });
  await expect(api.getAccount()).rejects.toMatchObject({ code: 'SESSION_RENEWAL_UNCERTAIN' });
  expect(f.fetchFn).toHaveBeenCalledOnce(); expect(resource).not.toHaveBeenCalled();
  expect(json(f.file).auth.active.generation).toBe(f.selection.generation); expect(f.retire).not.toHaveBeenCalled();
});
it('rejects an explicit refresh response scope downgrade even with an api-scoped JWT', async () => {
  const f = await fixture(); const next = issuedFixture(f.old.privateJwk, { now: f.now() });
  f.fetchFn.mockResolvedValue(response(200, { access_token: next.accessToken, refresh_token: 'downgraded', token_type: 'Bearer', expires_in: 3600, scope: 'nansen:read' }));
  await expect(f.acquire()).rejects.toMatchObject({ code: 'SESSION_RENEWAL_UNCERTAIN' });
  expect(json(f.journal())).toMatchObject({ phase: 'blocked', reason: 'uncertain' });
});
it('renewed api scope reaches account, smart-alert CRUD and hosted simulation without extra authority', async () => {
  const f = await fixture(); const api = new NansenAPI(undefined, f.old.audience, { credential: f.selection, authState: f.state });
  const fetch = vi.fn(async url => url.includes('simulate-swap') ? response(200, { result: [{ calls: [{ status: '0x1', logs: [] }] }] }) : response(200, {})); vi.stubGlobal('fetch', fetch);
  await api.getAccount(); await api.alertsList(); await api.alertsCreate({ name: 'fixture' }); await api.alertsUpdate({ id: 'fixture' }); await api.alertsDelete('fixture');
  await simulateAssetChanges('base', { to: '0x2' }, { from: '0x1', api });
  expect(f.fetchFn).toHaveBeenCalledOnce(); expect(fetch).toHaveBeenCalledTimes(6); expect(f.retire).not.toHaveBeenCalled();
  for (const [, options] of fetch.mock.calls) {
    expect(options.headers.Authorization).toBe(fetch.mock.calls[0][1].headers.Authorization);
    expect(options.headers.Authorization).not.toBe(`Bearer ${f.old.accessToken}`);
    expect(options.headers.apikey).toBeUndefined(); expect(options.headers['Payment-Signature']).toBeUndefined(); expect(options.redirect).toBe('error');
    expect(JSON.stringify(options)).not.toContain(f.old.refreshToken); expect(JSON.stringify(options)).not.toContain(f.old.privateJwk.d);
  }
});
it('hosted simulation reacquires after method fallback while foreign RPC never opens expired custody', async () => {
  const f = await fixture(); vi.spyOn(Date, 'now').mockImplementation(f.now);
  let rotations = 0;
  f.fetchFn.mockImplementation(async () => {
    const next = issuedFixture(f.old.privateJwk, { now: f.now() });
    return response(200, { access_token: next.accessToken, refresh_token: `simulation-rotation-${++rotations}`, token_type: 'Bearer', expires_in: 3600 });
  });
  const api = new NansenAPI(undefined, f.old.audience, { credential: f.selection, authState: f.state });
  const fetch = vi.fn(async (_url, options) => {
    if (JSON.parse(options.body).method === 'eth_simulateV1') { f.advance(3601000); return response(200, { error: { code: -32601, message: 'method not found' } }); }
    return response(200, { result: { type: 'CALL', logs: [], calls: [] } });
  }); vi.stubGlobal('fetch', fetch);
  await simulateAssetChanges('base', { to: '0x2' }, { from: '0x1', api });
  expect(f.fetchFn).toHaveBeenCalledTimes(2); expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[0][1].headers.Authorization).not.toBe(fetch.mock.calls[1][1].headers.Authorization);
  const acquire = vi.spyOn(f.state, 'acquireSession'); const original = SIMULATION_RPCS.base;
  try {
    SIMULATION_RPCS.base = 'https://foreign.invalid'; f.advance(3601000);
    fetch.mockImplementation(async () => response(200, { result: [{ calls: [{ status: '0x1', logs: [] }] }] }));
    await simulateAssetChanges('base', { to: '0x2' }, { from: '0x1', api });
    expect(acquire).not.toHaveBeenCalled(); expect(fetch.mock.calls.at(-1)[1].headers).toEqual({ 'Content-Type': 'application/json' });
  } finally { SIMULATION_RPCS.base = original; }
});
it.each(['nansen:read', undefined])('does not refresh or upgrade a saved %s grant', async scope => {
  const f = await fixture(); const old = { ...f.old, scope }; const parts = old.accessToken.split('.');
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url')); claims.scope = scope; parts[1] = Buffer.from(JSON.stringify(claims)).toString('base64url'); old.accessToken = parts.join('.');
  await f.store.write(f.selection.generation, old);
  await expect(f.acquire()).rejects.toMatchObject({ code: 'INVALID_BROWSER_SESSION' });
  expect(f.fetchFn).not.toHaveBeenCalled(); expect(f.retire).not.toHaveBeenCalled();
});

it.each([401, 429])('bounds persistent non-consuming HTTP%s renewal refusals across owner restarts', async status => {
  const f = await fixture({ age: 7200000 });
  f.fetchFn.mockImplementation(async () => response(status, { error: status === 429 ? 'rate_limited' : 'invalid_dpop_proof' }, { 'retry-after': '60' }));
  const resource = vi.fn(); vi.stubGlobal('fetch', resource);
  for (let attempt = 1; attempt <= 5; attempt++) {
    const state = createAuthState({ directory: f.directory, store: f.store, retire: f.retire, now: f.now,
      refresh: (bundle, options) => refreshSession(bundle, { ...options, fetchFn: f.fetchFn }) });
    const api = new NansenAPI(undefined, f.old.audience, { credential: f.selection, authState: state });
    const pay = vi.spyOn(api, '_x402Retry');
    const code = attempt < 5 ? 'SESSION_REFRESH_RETRYABLE' : 'SESSION_REFRESH_RETRY_EXHAUSTED';
    await expect(api.getAccount()).rejects.toMatchObject({ code });
    expect(json(f.journal()).retryFailures).toBe(attempt);
    expect(f.fetchFn).toHaveBeenCalledTimes(attempt);
    await expect(api.getAccount()).rejects.toMatchObject({ code });
    expect(f.fetchFn).toHaveBeenCalledTimes(attempt); // Cooldown calls cannot consume budget or dispatch.
    expect(pay).not.toHaveBeenCalled(); f.advance(61000);
  }
  const refresh = vi.fn();
  const restarted = createAuthState({ directory: f.directory, store: f.store, now: f.now, refresh });
  await expect(restarted.acquireSession(f.selection, { audience: f.old.audience })).rejects.toMatchObject({ code: 'SESSION_REFRESH_RETRY_EXHAUSTED', message: expect.stringContaining('nansen login') });
  expect(refresh).not.toHaveBeenCalled(); expect(resource).not.toHaveBeenCalled();
  expect(json(f.journal())).toMatchObject({ phase: 'blocked', reason: 'retry_exhausted', retryFailures: 5 });
  expect(json(f.file).auth.active.generation).toBe(f.selection.generation);
});

it.each([undefined, null, NaN, -1, 'later', Infinity])('blocks an invalid retry timestamp %s without corrupting the journal', async retryNotBefore => {
  const f = await fixture({ age: 7200000 });
  const refresh = vi.fn(async () => { throw Object.assign(new AuthError('SESSION_REFRESH_RETRYABLE', 'synthetic refusal'), { retryNotBefore }); });
  const state = createAuthState({ directory: f.directory, store: f.store, now: f.now, refresh });
  await expect(state.acquireSession(f.selection, { audience: f.old.audience })).rejects.toMatchObject({ code: 'SESSION_RENEWAL_UNCERTAIN' });
  const restarted = createAuthState({ directory: f.directory, store: f.store, now: f.now, refresh });
  await expect(restarted.acquireSession(f.selection, { audience: f.old.audience })).rejects.toMatchObject({ code: 'SESSION_RENEWAL_UNCERTAIN' });
  expect(refresh).toHaveBeenCalledOnce(); expect(renewalStatus(f.directory, f.selection)).toBe('login_required');
  expect(json(f.journal())).toMatchObject({ phase: 'blocked', reason: 'uncertain' });
  expect(json(f.journal())).not.toHaveProperty('retryNotBefore');
});

it.each([-1, 1.5, 6, '1', null])('fails closed on a malformed persisted refusal count %s', async retryFailures => {
  const f = await fixture({ age: 7200000 }); f.fetchFn.mockResolvedValue(response(429, { error: 'rate_limited' }));
  await expect(f.acquire()).rejects.toMatchObject({ code: 'SESSION_REFRESH_RETRYABLE' });
  const damaged = { ...json(f.journal()), retryFailures }; fs.writeFileSync(f.journal(), JSON.stringify(damaged));
  f.advance(60000);
  await expect(f.acquire()).rejects.toMatchObject({ code: 'AUTH_JOURNAL_INVALID' });
  expect(f.fetchFn).toHaveBeenCalledOnce(); expect(json(f.journal())).toEqual(damaged);
  expect(renewalStatus(f.directory, f.selection)).toBe('metadata_unreadable');
});

it('preserves a legacy retry journal, then clears its refusal count after successful renewal', async () => {
  const f = await fixture({ age: 7200000 }); f.fetchFn.mockResolvedValueOnce(response(429, { error: 'rate_limited' }));
  await expect(f.acquire()).rejects.toMatchObject({ code: 'SESSION_REFRESH_RETRYABLE' });
  const legacy = json(f.journal()); delete legacy.retryFailures; fs.writeFileSync(f.journal(), JSON.stringify(legacy));
  f.advance(2000); const next = await f.acquire();
  expect(next.refreshToken).toBe('replacement-secret'); expect(fs.existsSync(f.journal())).toBe(false);
});

it('does not resend a browser credential when logout commits during resource backoff', async () => {
  const f = await fixture(); const acquire = vi.spyOn(f.state, 'acquireSession');
  const fetch = vi.fn(async () => response(503, {})); vi.stubGlobal('fetch', fetch);
  const timer = globalThis.setTimeout; let logout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn, ms, ...args) => {
    if (ms !== 17) return timer(fn, ms, ...args);
    logout = f.state.logout();
    return timer(() => { logout.then(() => fn(...args)); }, 0);
  });
  const api = new NansenAPI(undefined, f.old.audience, { credential: f.selection, authState: f.state, retry: { maxRetries: 1, baseDelayMs: 17, maxDelayMs: 17 } });
  const pay = vi.spyOn(api, '_x402Retry');
  await expect(api.getAccount()).rejects.toMatchObject({ code: 'AUTH_SELECTION_CHANGED' });
  await logout;
  expect(acquire).toHaveBeenCalledTimes(2); expect(fetch).toHaveBeenCalledOnce(); expect(pay).not.toHaveBeenCalled();
  expect(json(f.file).auth.active.kind).toBe('none');
});
