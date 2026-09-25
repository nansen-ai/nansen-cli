import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { issuedFixture, sessionFixture } from './fixtures/auth-fixture.js';
const roots = [], children = [];
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGKILL'); await done; }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
async function kill(child) { const done = once(child, 'exit'); child.kill('SIGKILL'); await done; }
function server(local = false, lifetime = 3600) {
  const now = Date.now(); const old = sessionFixture({ now: now - 3590000, padding: 'x'.repeat(3000), ...(local && { audience: 'http://localhost:54321' }) });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'refresh-process-')); roots.push(root);
  const consumed = new Map(), revokes = [], access = []; let accepts = 0, lost = false;
  async function worker() {
    const child = fork(fileURLToPath(new URL('./fixtures/auth-refresh-worker.js', import.meta.url)), [], { execArgv: ['--require', fileURLToPath(new URL('./fixtures/network-guard.cjs', import.meta.url)), '--import', fileURLToPath(new URL('./fixtures/local-issuer-register.js', import.meta.url))], stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { PATH: process.env.PATH, NODE_NO_WARNINGS: '1', NANSEN_NO_TELEMETRY: '1' } }); children.push(child);
    let seq = 0, barrierResolve; const pending = new Map(), barriers = [];
    child.stderr.resume(); child.stdout.resume();
    child.on('message', message => {
      if (message.event === 'barrier') { if (barrierResolve) { const r = barrierResolve; barrierResolve = null; r(message); } else barriers.push(message); return; }
      if (message.event === 'retire') { revokes.push(message.token); return; }
      if (message.event === 'request') {
        let status = 200, body, headers;
        if (message.url.endsWith('/token/refresh')) {
          const proof = JSON.parse(Buffer.from(message.headers.DPoP.split('.')[1], 'base64url'));
          const token = JSON.parse(message.body).refresh_token;
          if (!proof.nonce) { status = 401; body = { error: 'use_dpop_nonce' }; headers = { 'DPoP-Nonce': 'central-nonce' }; }
          else if (consumed.has(token)) { status = 401; body = { error: 'invalid_refresh_token' }; consumed.set(token, consumed.get(token) + 1); }
          else {
            consumed.set(token, 1); accepts++;
            const next = issuedFixture(old.privateJwk, { now, audience: old.audience, padding: 'x'.repeat(3000) });
            body = { access_token: next.accessToken, refresh_token: `child-${accepts}`, token_type: 'Bearer', expires_in: lifetime };
          }
        } else { access.push(message.headers); body = { user_id: 'account-B', credits_remaining: 0 }; }
        child.send({ action: 'response', id: message.id, status, body, headers, lost: lost && message.url.endsWith('/token/refresh') && status === 200 }); return;
      }
      pending.get(message.id)?.(message); pending.delete(message.id);
    });
    const call = (action, values = {}) => new Promise(resolve => { const id = ++seq; pending.set(id, resolve); child.send({ id, action, ...values }); });
    await call('init', { directory: root, now });
    return { child, call, barrier: () => barriers.length ? Promise.resolve(barriers.shift()) : new Promise(resolve => { barrierResolve = resolve; }) };
  }
  return { root, old, now, worker, consumed, revokes, access, loseResponse() { lost = true; } };
}
it('two real command processes share one consumed refresh and the winning generation', async () => {
  const s = server(), a = await s.worker(), b = await s.worker(); await a.call('seed', { bundle: s.old });
  const choice = await a.call('select'); await b.call('select');
  const first = a.call('account', { target: { phase: 'rotation-received' } }); await a.barrier();
  const waiting = b.call('account'); a.child.send({ action: 'resume' });
  expect((await first).error).toBeUndefined(); expect((await waiting).error).toBeUndefined();
  expect(s.consumed.get(s.old.refreshToken)).toBe(1); expect(s.revokes).toEqual([]);
  expect(s.access).toHaveLength(2); expect(s.access[0].Authorization).toBe(s.access[1].Authorization);
  expect(JSON.parse(fs.readFileSync(path.join(s.root, 'config.json'))).auth.selectionEpoch).toBe(choice.result.epoch);
});
it.each(['rotation-marked', 'rotation-received', 'chunk-0', 'manifest', 'rotation-stored', 'rotation-committed'])('fresh child recovers SIGKILL at %s without parent replay or active-family revoke', async phase => {
  const s = server(), a = await s.worker(); await a.call('seed', { bundle: s.old }); await a.call('select');
  void a.call('account', { target: { phase } }); await a.barrier(); await kill(a.child);
  const b = await s.worker(); await b.call('select'); const result = await b.call('account');
  const recoverable = ['manifest', 'rotation-stored', 'rotation-committed'].includes(phase);
  if (recoverable) expect(result.error).toBeUndefined();
  else expect(result.error.code).toBe('SESSION_RENEWAL_UNCERTAIN');
  expect(s.consumed.get(s.old.refreshToken) || 0).toBe(phase === 'rotation-marked' ? 0 : 1); expect(s.revokes).toEqual([]);
  expect((await b.call('logout')).error).toBeUndefined(); expect(s.revokes).toHaveLength(1);
  expect(fs.readdirSync(path.join(s.root, 'synthetic-store'))).toEqual([]);
});
it('lost response stays blocked across multiple restarts past replay grace', async () => {
  const s = server(), a = await s.worker(); await a.call('seed', { bundle: s.old }); await a.call('select'); s.loseResponse();
  expect((await a.call('account')).error.code).toBe('SESSION_RENEWAL_UNCERTAIN'); await kill(a.child);
  for (let i = 0; i < 2; i++) { const b = await s.worker(); await b.call('select'); await b.call('time', { now: s.now + 7200000 }); expect((await b.call('account')).error.code).toBe('SESSION_RENEWAL_UNCERTAIN'); await kill(b.child); }
  expect(s.consumed.get(s.old.refreshToken)).toBe(1); expect(s.access).toEqual([]); expect(s.revokes).toEqual([]);
});
it('logout waits for rotation then retires its child and defeats a stale command', async () => {
  const s = server(), a = await s.worker(), b = await s.worker(); await a.call('seed', { bundle: s.old }); await a.call('select'); await b.call('select');
  const pending = a.call('account', { target: { phase: 'rotation-received' } }); await a.barrier(); const logout = b.call('logout');
  a.child.send({ action: 'resume' }); await pending; expect((await logout).error).toBeUndefined();
  expect(s.revokes).toEqual(['child-1']); expect((await a.call('account')).error.code).toBe('AUTH_SELECTION_CHANGED');
  expect(JSON.parse(fs.readFileSync(path.join(s.root, 'config.json'))).auth.active.kind).toBe('none');
});
it('pending browser replacement can commit after refresh without changing the rotation epoch', async () => {
  const s = server(), a = await s.worker(), b = await s.worker(); await a.call('seed', { bundle: s.old }); await a.call('select'); await b.call('begin');
  expect((await a.call('account')).error).toBeUndefined();
  expect((await b.call('replace', { bundle: sessionFixture({ accountId: 'B' }) })).error).toBeUndefined();
  expect(s.revokes).toEqual(['child-1']); expect((await a.call('account')).error.code).toBe('AUTH_SELECTION_CHANGED');
});

it.each(['before-flush', 'before-rename', 'after-rename'])('marker %s SIGKILL makes only a durable marker prohibit replay', async phase => {
  const s = server(), a = await s.worker(); await a.call('seed', { bundle: s.old }); const choice = await a.call('select');
  void a.call('account', { target: { phase, file: `${choice.result.epoch}.json` } }); await a.barrier(); await kill(a.child);
  const b = await s.worker(); await b.call('select'); const result = await b.call('account');
  if (phase === 'after-rename') { expect(result.error.code).toBe('SESSION_RENEWAL_UNCERTAIN'); expect(s.consumed.size).toBe(0); }
  else { expect(result.error).toBeUndefined(); expect(s.consumed.get(s.old.refreshToken)).toBe(1); }
  expect(s.revokes).toEqual([]);
});
it('SIGKILL after logout tombstone preserves detached rotation retirement authority', async () => {
  const s = server(), a = await s.worker(); await a.call('seed', { bundle: s.old }); await a.call('select'); s.loseResponse();
  await a.call('account'); void a.call('logout', { target: { phase: 'logout-committed' } }); await a.barrier(); await kill(a.child);
  const b = await s.worker(); expect((await b.call('logout')).error).toBeUndefined();
  expect(s.revokes).toEqual([s.old.refreshToken]); expect(fs.readdirSync(path.join(s.root, 'synthetic-store'))).toEqual([]);
});

it('real Node/Undici loopback lookup refusal remains retryable in a fresh healthy process', async () => {
  const s = server(true), a = await s.worker(); await a.call('seed', { bundle: s.old }); await a.call('select');
  await a.call('dns-failure');
  expect((await a.call('account')).error?.code).toBe('SESSION_REFRESH_RETRYABLE');
  const config = JSON.parse(fs.readFileSync(path.join(s.root, 'config.json')));
  const journal = path.join(s.root, 'auth-operations', `${config.auth.selectionEpoch}.json`);
  expect(JSON.parse(fs.readFileSync(journal)).phase).toBe('retryable'); expect(s.consumed.size).toBe(0);
  await kill(a.child);
  const b = await s.worker(); await b.call('select');
  expect((await b.call('account')).error).toBeUndefined(); expect(s.consumed.size).toBe(0); // unexpired access during cooldown
  await b.call('time', { now: s.now + 2000 });
  expect((await b.call('account')).error).toBeUndefined(); expect(s.consumed.get(s.old.refreshToken)).toBe(1);
});
it('fresh-child logout under hidden-target corruption deselects and retains authority until restoration', async () => {
  const s = server(), a = await s.worker(); await a.call('seed', { bundle: s.old }); await a.call('select');
  void a.call('account', { target: { phase: 'rotation-stored' } }); await a.barrier(); await kill(a.child);
  const configFile = path.join(s.root, 'config.json'); const config = JSON.parse(fs.readFileSync(configFile));
  const journal = path.join(s.root, 'auth-operations', `${config.auth.selectionEpoch}.json`);
  const valid = fs.readFileSync(journal); fs.writeFileSync(journal, '{damaged');
  const entries = fs.readdirSync(path.join(s.root, 'synthetic-store'));
  const b = await s.worker(); await b.call('select');
  expect((await b.call('logout')).result.cleanup).toContainEqual({ local: 'incomplete', remote: 'unconfirmed', code: 'AUTH_JOURNAL_INVALID' });
  expect(JSON.parse(fs.readFileSync(configFile)).auth.active.kind).toBe('none');
  expect((await b.call('account')).error.code).toBe('AUTH_SELECTION_CHANGED');
  expect(fs.readdirSync(path.join(s.root, 'synthetic-store'))).toEqual(entries); expect(s.revokes).toEqual([]);
  fs.writeFileSync(journal, valid); await kill(b.child);
  const c = await s.worker(); expect((await c.call('logout')).error).toBeUndefined();
  expect(s.revokes).toEqual(['child-1']); expect(fs.readdirSync(path.join(s.root, 'synthetic-store'))).toEqual([]);
});

it('over-ceiling renewal remains setup-blocked after a real process restart with parent cleanup authority', async () => {
  const s = server(false, 3601), a = await s.worker(); await a.call('seed', { bundle: s.old }); await a.call('select');
  expect((await a.call('account')).error.code).toBe('BROWSER_SESSION_SETUP_REQUIRED'); await kill(a.child);
  const b = await s.worker(); await b.call('select');
  expect((await b.call('account')).error.code).toBe('BROWSER_SESSION_SETUP_REQUIRED');
  expect(s.consumed.get(s.old.refreshToken)).toBe(1); expect(s.revokes).toEqual([]);
  expect((await b.call('logout')).error).toBeUndefined(); expect(s.revokes).toEqual([s.old.refreshToken]);
});
