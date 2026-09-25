import { fork } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterEach } from 'vitest';
const children = [], dirs = [];
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function directory() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-process-')); dirs.push(dir); return dir; }
async function worker(dir) {
  const child = fork(fileURLToPath(new URL('./fixtures/auth-process-worker.js', import.meta.url)), [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, NODE_NO_WARNINGS: '1' } });
  children.push(child);
  let seq = 0;
  const pending = new Map();
  const barriers = [];
  let barrierResolve;
  child.on('message', message => {
    if (message.event === 'barrier') { if (barrierResolve) { const r = barrierResolve; barrierResolve = null; r(message); } else barriers.push(message); return; }
    pending.get(message.id)?.(message); pending.delete(message.id);
  });
  const call = (action, values = {}) => new Promise(resolve => { const id = ++seq; pending.set(id, resolve); child.send({ id, action, ...values }); });
  await call('init', { directory: dir });
  return { child, call, barrier: () => barriers.length ? Promise.resolve(barriers.shift()) : new Promise(resolve => { barrierResolve = resolve; }) };
}
const read = dir => JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
async function kill(child) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }

describe('real process custody and fault injection', () => {
  it('reverse-completing logins cannot overwrite the first committed choice', async () => {
    const dir = directory(); const a = await worker(dir), b = await worker(dir);
    await a.call('begin'); await b.call('begin');
    expect((await b.call('install', { account: 'B' })).error).toBeUndefined(); await b.call('finish');
    expect((await a.call('install', { account: 'A' })).error.code).toBe('AUTH_SELECTION_CHANGED'); await a.call('finish');
    expect(read(dir).auth.active.accountId).toBe('B');
    expect((await b.call('logout')).error).toBeUndefined();
    expect(fs.readdirSync(path.join(dir, 'synthetic-store'))).toEqual([]);
  });
  it.each(['logout', 'key'])('%s wins against a pending approval without deleting its live attempt', async action => {
    const dir = directory(); const a = await worker(dir), b = await worker(dir);
    await a.call('begin'); await b.call(action);
    expect((await a.call('install')).error.code).toBe('AUTH_SELECTION_CHANGED'); await a.call('finish');
    expect(read(dir).auth.active.kind).toBe(action === 'key' ? 'api-key' : 'none');
  });
  it.each([
    { phase: 'chunk-0' }, { phase: 'manifest' }, { phase: 'stored' },
    { phase: 'before-flush', file: 'config.json' },
    { phase: 'before-rename', file: 'config.json' },
    { phase: 'after-rename', file: 'config.json' }, { phase: 'committed' },
  ])('recovers from SIGKILL at $phase using a fresh process', async target => {
    const dir = directory(); fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ apiKey: 'old-key', preserved: 42 }));
    const a = await worker(dir); await a.call('begin');
    void a.call('install', { target }); await a.barrier(); await kill(a.child);
    const committed = ['after-rename', 'committed'].includes(target.phase);
    expect(read(dir).auth?.active.kind === 'session').toBe(committed);
    const b = await worker(dir);
    expect((await b.call('begin')).error).toBeUndefined(); await b.call('finish');
    expect(read(dir).preserved).toBe(42);
    if (committed) expect(read(dir).apiKey).toBeUndefined();
    else expect(read(dir).apiKey).toBe('old-key');
    await b.call('logout');
    expect(fs.readdirSync(path.join(dir, 'synthetic-store'))).toEqual([]);
    expect(fs.readdirSync(path.join(dir, 'auth-operations')).filter(f => f.endsWith('.json'))).toEqual([]);
  });
  it('logout removes a killed legacy writer staging file without restoring its key', async () => {
    const dir = directory(); const a = await worker(dir);
    void a.call('key', { target: { phase: 'before-rename', file: 'config.json' } });
    await a.barrier(); await kill(a.child);
    expect(fs.readdirSync(dir).some(name => name.endsWith('.tmp'))).toBe(true);
    const b = await worker(dir); expect((await b.call('logout')).error).toBeUndefined();
    expect(fs.readdirSync(dir).some(name => name.endsWith('.tmp'))).toBe(false);
    expect(read(dir).auth.active.kind).toBe('none'); expect(read(dir).apiKey).toBeUndefined();
  });
  it.skipIf(process.platform === 'win32')('a paused live owner retains the lock and SIGKILL releases it', async () => {
    const dir = directory(); const a = await worker(dir), b = await worker(dir);
    await a.call('begin'); void a.call('install', { target: { phase: 'stored' } }); await a.barrier();
    a.child.kill('SIGSTOP');
    let completed = false; const pending = b.call('logout').then(result => { completed = true; return result; });
    // No timer decides ownership; this bounded observation only checks contention.
    await new Promise(resolve => setTimeout(resolve, 150)); expect(completed).toBe(false);
    await kill(a.child); expect((await pending).error).toBeUndefined();
    expect(read(dir).auth.active.kind).toBe('none');
  });
});

it('fresh children recover eight failed preflights after locked logout and process death', async () => {
  const dir = directory(); const a = await worker(dir);
  await a.call('store-locked', { value: true });
  for (let i = 0; i < 8; i++) expect((await a.call('begin')).error).toBeDefined();
  expect((await a.call('logout')).error).toBeUndefined();
  expect(read(dir).auth.active.kind).toBe('none');
  expect(fs.readdirSync(path.join(dir, 'auth-operations')).filter(n => n.endsWith('.json'))).toHaveLength(8);
  await kill(a.child);
  const b = await worker(dir); expect((await b.call('logout')).error).toBeUndefined();
  expect(fs.readdirSync(path.join(dir, 'auth-operations')).filter(n => n.endsWith('.json'))).toEqual([]);
  expect(fs.readdirSync(path.join(dir, 'synthetic-store'))).toEqual([]);
});
it.each(['before-rename', 'after-rename'])('SIGKILL at poll-marker %s preserves honest issuance classification', async phase => {
  const dir = directory(); const a = await worker(dir); const begun = await a.call('begin');
  void a.call('poll-marker', { target: { phase, file: `${begun.result.id}.json` } });
  await a.barrier(); await kill(a.child);
  const b = await worker(dir); const result = await b.call('logout');
  expect(result.error).toBeUndefined();
  expect(result.result.cleanup).toContainEqual({ local: 'removed', remote: phase === 'before-rename' ? 'not_needed' : 'unconfirmed' });
});

it('already durable poll markers bypass a competing process global lock, first markers do not', async () => {
  const dir = directory(); const a = await worker(dir), b = await worker(dir), c = await worker(dir);
  await a.call('begin'); await a.call('poll-marker'); await c.call('begin'); await b.call('begin');
  void b.call('install', { target: { phase: 'stored' } }); await b.barrier();
  const marked = a.call('poll-marker');
  expect(await Promise.race([marked, new Promise(resolve => setTimeout(() => resolve('blocked'), 1000))])).not.toBe('blocked');
  let firstDone = false; const first = c.call('poll-marker').then(result => { firstDone = true; return result; });
  await new Promise(resolve => setTimeout(resolve, 150)); expect(firstDone).toBe(false);
  await kill(b.child); expect((await first).error).toBeUndefined();
  await a.call('finish'); await c.call('finish');
});
