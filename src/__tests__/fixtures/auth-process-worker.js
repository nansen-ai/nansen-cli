// Test-only persistent store. Never imported by production or enabled by env.
import fs from 'node:fs';
import path from 'node:path';
import { createAuthState } from '../../auth-state.js';
import { createAuthStore } from '../../auth-store.js';
import { sessionFixture } from './auth-fixture.js';
let state, attempt, target, unavailable = false;
let resume;
async function barrier(phase, file) {
  if (target?.phase === phase && (!target.file || target.file === file)) {
    target = null;
    process.send({ event: 'barrier', phase });
    await new Promise(resolve => { resume = resolve; });
  }
}
process.on('message', async msg => {
  if (msg.action === 'resume') { resume?.(); return; }
  try {
    let result;
    if (msg.action === 'init') {
      const storeDir = path.join(msg.directory, 'synthetic-store');
      fs.mkdirSync(storeDir, { recursive: true });
      const store = createAuthStore({ barrier, operation: async (op, name, bytes) => {
        if (unavailable) throw new Error('synthetic store locked');
        const file = path.join(storeDir, name);
        if (op === 'set') { fs.writeFileSync(file, bytes); return true; }
        if (op === 'get') return fs.existsSync(file) ? fs.readFileSync(file) : null;
        if (op === 'delete') { if (fs.existsSync(file)) fs.unlinkSync(file); return true; }
      } });
      state = createAuthState({ directory: msg.directory, store, barrier, retire: async () => ({ remote: 'recorded_pending' }) });
      result = true;
    } else if (msg.action === 'begin') {
      attempt = await state.begin(); result = { id: attempt.id, epoch: attempt.epoch };
    } else if (msg.action === 'store-locked') { unavailable = msg.value; result = true;
    } else if (msg.action === 'poll-marker') { target = msg.target; result = await state.markIssuancePossible(attempt);
    } else if (msg.action === 'install') {
      target = msg.target;
      result = await state.install(attempt, { bundle: sessionFixture({ accountId: msg.account || 'B', padding: 'x'.repeat(3000) }), baseUrl: 'https://api.nansen.ai' });
    } else if (msg.action === 'key') {
      target = msg.target;
      const a = await state.begin({ preflight: false });
      try { result = await state.install(a, { apiKey: 'synthetic-key' }); } finally { await state.finish(a); }
    } else if (msg.action === 'finish') { result = await state.finish(attempt); attempt = null; }
    else if (msg.action === 'logout') result = await state.logout();
    else if (msg.action === 'exit') { process.exit(0); }
    process.send({ id: msg.id, result });
  } catch (error) { process.send({ id: msg.id, error: { code: error.code || 'ERROR' } }); }
});
