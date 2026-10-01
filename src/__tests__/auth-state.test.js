import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createAuthState } from '../auth-state.js';
import { createAuthStore } from '../auth-store.js';
import { sessionFixture, memoryOperation } from './fixtures/auth-fixture.js';
const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture(barrier) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-state-')); dirs.push(directory);
  const memory = memoryOperation();
  const store = createAuthStore(memory);
  const retire = vi.fn().mockResolvedValue({ remote: 'recorded_pending' });
  return { directory, memory, store, retire, state: createAuthState({ directory, store, retire, barrier }) };
}
describe('secure custody', () => {
  it('roundtrips UTF-8 material above the Windows blob limit using bounded byte chunks', async () => {
    const { store, memory } = fixture(); const id = randomUUID();
    const bundle = sessionFixture({ padding: '雪'.repeat(2000) });
    await store.write(id, bundle);
    expect((await store.read(id)).accessToken).toBe(bundle.accessToken);
    expect([...memory.entries.values()].every(b => b.length <= 2048)).toBe(true);
    expect(memory.entries.size).toBeGreaterThan(2);
    await store.remove(id); expect(memory.entries.size).toBe(0);
  });
  it('rejects over-cap and partial generations without mixing secrets', async () => {
    const { store, memory } = fixture(); const id = randomUUID();
    await expect(store.write(id, { secret: 'x'.repeat(16384) })).rejects.toMatchObject({ code: 'AUTH_BUNDLE_TOO_LARGE' });
    expect(memory.entries.size).toBe(0);
    await store.write(id, sessionFixture()); memory.entries.delete(`${id}.0`);
    await expect(store.read(id)).rejects.toMatchObject({ code: 'AUTH_STORE_UNAVAILABLE' });
  });
  it('switches atomically, removes legacy copy, preserves wallets/settings, and never revives a key', async () => {
    const { directory, state, retire, memory } = fixture();
    const file = path.join(directory, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ apiKey: 'old-key', setting: 42 }));
    fs.mkdirSync(path.join(directory, 'wallets')); fs.writeFileSync(path.join(directory, 'wallets', 'owned'), 'wallet-untouched');
    const attempt = await state.begin();
    await state.install(attempt, { bundle: sessionFixture(), baseUrl: 'https://api.nansen.ai' }); await state.finish(attempt);
    expect(JSON.parse(fs.readFileSync(file))).not.toHaveProperty('apiKey');
    const result = await state.logout();
    expect(result.cleanup).toContainEqual({ remote: 'recorded_pending', local: 'removed' });
    expect(retire).toHaveBeenCalledTimes(1); expect(memory.entries.size).toBe(0);
    expect(JSON.parse(fs.readFileSync(file))).toMatchObject({ setting: 42, auth: { active: { kind: 'none' } } });
    expect(fs.readFileSync(path.join(directory, 'wallets', 'owned'), 'utf8')).toBe('wallet-untouched');
  });
  it('logout and a successful replacement defeat delayed installs', async () => {
    const { state } = fixture();
    const a = await state.begin(); const b = await state.begin();
    await state.install(b, { apiKey: 'B' }); await state.finish(b);
    await expect(state.install(a, { apiKey: 'A' })).rejects.toMatchObject({ code: 'AUTH_SELECTION_CHANGED' }); await state.finish(a);
    const c = await state.begin(); await state.logout();
    await expect(state.install(c, { apiKey: 'C' })).rejects.toMatchObject({ code: 'AUTH_SELECTION_CHANGED' }); await state.finish(c);
  });
  it('rereads the pointer after commit acknowledgement is lost', async () => {
    const f = fixture(async (phase, file) => {
      if (phase === 'after-rename' && file === 'config.json') throw new Error('ack lost');
    });
    const attempt = await f.state.begin();
    await f.state.install(attempt, { bundle: sessionFixture() });
    expect(attempt.committed).toBe(true);
    await f.state.finish(attempt);
    expect(f.retire).not.toHaveBeenCalled();
    expect(f.memory.entries.size).toBeGreaterThan(0);
  });
  it('does not retire a possibly active generation when commit readback is unavailable', async () => {
    let f;
    f = fixture(async (phase, file) => {
      if (phase === 'after-rename' && file === 'config.json') {
        fs.writeFileSync(path.join(f.directory, 'config.json'), '{');
        throw new Error('readback unavailable');
      }
    });
    const attempt = await f.state.begin();
    await expect(f.state.install(attempt, { bundle: sessionFixture() })).rejects.toMatchObject({ code: 'AUTH_STATE_INVALID' });
    expect(attempt.uncertain).toBe(true);
    expect(await f.state.finish(attempt)).toEqual([{ local: 'incomplete', remote: 'unconfirmed' }]);
    expect(f.retire).not.toHaveBeenCalled();
    expect(f.memory.entries.size).toBeGreaterThan(0);
  });
  it('reports incomplete secure deletion after clearing selection and retries on logout', async () => {
    const f = fixture(); const attempt = await f.state.begin();
    await f.state.install(attempt, { bundle: sessionFixture() }); await f.state.finish(attempt);
    const remove = vi.spyOn(f.store, 'remove').mockRejectedValueOnce(new Error('locked'));
    expect((await f.state.logout()).cleanup).toContainEqual({ remote: 'recorded_pending', local: 'incomplete' });
    expect(JSON.parse(fs.readFileSync(path.join(f.directory, 'config.json'))).auth.active.kind).toBe('none');
    remove.mockRestore();
    await f.state.logout(); expect(f.memory.entries.size).toBe(0);
  });

});

describe('bounded recovery under journal pressure', () => {
  it('recovers eight failed preflights through repeated logout and unlock without a ninth empty journal', async () => {
    const f = fixture(); let unavailable = true;
    const store = {
      preflight: async () => { if (unavailable) throw new Error('locked'); },
      read: f.store.read,
      remove: async id => { if (unavailable) throw new Error('locked'); return f.store.remove(id); },
    };
    const state = createAuthState({ directory: f.directory, store, retire: f.retire });
    const journals = () => fs.readdirSync(path.join(f.directory, 'auth-operations')).filter(n => n.endsWith('.json'));
    for (let i = 0; i < 8; i++) await expect(state.begin()).rejects.toThrow('locked');
    expect(journals()).toHaveLength(8);
    await expect(state.begin()).rejects.toMatchObject({ code: 'AUTH_CLEANUP_REQUIRED' });
    for (let i = 0; i < 2; i++) {
      expect((await state.logout()).cleanup).toContainEqual({ local: 'pending', remote: 'not_attempted' });
      expect(journals()).toHaveLength(8);
      expect(JSON.parse(fs.readFileSync(path.join(f.directory, 'config.json'))).auth.active.kind).toBe('none');
    }
    unavailable = false;
    await state.logout(); expect(journals()).toHaveLength(0); expect(f.retire).not.toHaveBeenCalled();
  });
  it('drains pre-existing over-limit journals in bounded batches while preserving live attempts', async () => {
    const f = fixture(); const live = await f.state.begin();
    for (let i = 0; i < 10; i++) {
      const id = randomUUID();
      fs.writeFileSync(path.join(f.directory, 'auth-operations', `${id}.json`), JSON.stringify({ id, generations: [id] }), { mode: 0o600 });
    }
    await f.state.logout();
    expect(fs.existsSync(path.join(f.directory, 'auth-operations', `${live.id}.json`))).toBe(true);
    await f.state.logout();
    await expect(f.state.install(live, { bundle: sessionFixture() })).rejects.toMatchObject({ code: 'AUTH_SELECTION_CHANGED' });
    await f.state.finish(live); await f.state.logout();
    expect(fs.readdirSync(path.join(f.directory, 'auth-operations')).filter(n => n.endsWith('.json'))).toEqual([]);
  });
  it('marks possible issuance durably before polling and never infers unissued from a missing manifest', async () => {
    const f = fixture(); const a = await f.state.begin(); await f.state.markIssuancePossible(a);
    expect(JSON.parse(fs.readFileSync(path.join(f.directory, 'auth-operations', `${a.id}.json`))).unissued).toBe(false);
    expect(await f.state.finish(a)).toContainEqual({ local: 'removed', remote: 'unconfirmed' });
  });
});
it('logout under pressure retires the displaced session without deleting a live pending attempt', async () => {
  const f = fixture(); const active = await f.state.begin();
  await f.state.install(active, { bundle: sessionFixture() }); await f.state.finish(active);
  const pending = await f.state.begin();
  let unavailable = true;
  const state = createAuthState({ directory: f.directory, retire: f.retire, store: {
    preflight: async () => { throw new Error('locked'); },
    read: async id => { if (unavailable) throw new Error('locked'); return f.store.read(id); },
    remove: async id => { if (unavailable) throw new Error('locked'); return f.store.remove(id); },
  } });
  for (let i = 0; i < 7; i++) await expect(state.begin()).rejects.toThrow('locked');
  expect((await state.logout()).removed).toBe(true);
  expect(f.retire).not.toHaveBeenCalled();
  expect(fs.existsSync(path.join(f.directory, 'auth-operations', `${pending.id}.json`))).toBe(true);
  unavailable = false;
  await state.logout(); await state.logout();
  expect(f.retire).toHaveBeenCalledOnce();
  await expect(f.state.install(pending, { bundle: sessionFixture() })).rejects.toMatchObject({ code: 'AUTH_SELECTION_CHANGED' });
  await f.state.finish(pending); await state.logout();
  expect(f.memory.entries.size).toBe(0);
});
