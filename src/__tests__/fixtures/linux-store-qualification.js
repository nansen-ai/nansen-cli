// Explicit opt-in integration check. Real GNOME Keyring, synthetic issuer only.
// Never reads the invoking user's home, session bus, or credentials.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { browserLogin } from '../../auth-login.js';
import { createAuthState } from '../../auth-state.js';
import { createAuthStore } from '../../auth-store.js';
import { refreshSession } from '../../auth-device.js';
import { resolveCredential } from '../../auth-credentials.js';
import { issuedFixture, sessionFixture } from './auth-fixture.js';

globalThis.fetch = async () => { throw new Error('Qualification must not contact a real issuer'); };
const file = fileURLToPath(import.meta.url);
const mode = process.argv[2];
const execute = promisify(execFile);
if (!mode) {
  assert.equal(process.platform, 'linux', 'Requires Linux, dbus-run-session, GNOME Keyring and gdbus');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nansen-linux-store-'));
  const runtime = path.join(root, 'runtime'); fs.mkdirSync(runtime, { mode: 0o700 });
  try {
    execFileSync('dbus-run-session', ['--', process.execPath, file, 'session'], {
      stdio: 'inherit',
      env: { PATH: process.env.PATH, HOME: root, XDG_DATA_HOME: path.join(root, '.local/share'), XDG_CACHE_HOME: path.join(root, '.cache'), XDG_RUNTIME_DIR: runtime, NANSEN_NO_TELEMETRY: '1' },
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
} else if (mode === 'session') {
  const password = randomUUID(); // disposable keyring only, passed over stdin
  let daemon;
  const call = async (...args) => (await execute('gdbus', ['call', '--session', '--dest', 'org.freedesktop.secrets', ...args], { timeout: 5000 })).stdout.trim();
  const locked = () => call('--object-path', '/org/freedesktop/secrets/collection/login', '--method', 'org.freedesktop.DBus.Properties.Get', 'org.freedesktop.Secret.Collection', 'Locked');
  async function start() {
    daemon = spawn('gnome-keyring-daemon', ['--foreground', '--unlock', '--components=secrets'], { stdio: ['pipe', 'ignore', 'ignore'] });
    daemon.stdin.end(password);
    for (let i = 0; i < 50; i++) {
      try {
        const owner = (await execute('gdbus', ['call', '--session', '--dest', 'org.freedesktop.DBus', '--object-path', '/org/freedesktop/DBus', '--method', 'org.freedesktop.DBus.NameHasOwner', 'org.freedesktop.secrets'], { timeout: 5000 })).stdout;
        if (owner.includes('true') && (await locked()).includes('false')) return;
      } catch { /* service starting */ }
      await delay(100);
    }
    throw new Error('Isolated GNOME Keyring did not unlock');
  }
  async function stop() {
    const done = new Promise(resolve => daemon.once('close', resolve));
    daemon.kill('SIGTERM'); await done;
  }
  const now = Date.now();
  const run = (action, extraEnv = {}) => execute(process.execPath, [file, 'command', action, String(now)], { timeout: 60000, env: { ...process.env, ...extraEnv } });
  const config = () => fs.readFileSync(path.join(process.env.HOME, '.nansen/config.json'), 'utf8');
  try {
    await start();
    await run('login');
    await run('read');
    const before = config();
    await call('--object-path', '/org/freedesktop/secrets', '--method', 'org.freedesktop.Secret.Service.Lock', "['/org/freedesktop/secrets/collection/login']");
    assert.match(await locked(), /true/);
    await run('blocked-login-locked'); assert.equal(config(), before);
    // Unavailable bus must also fail before approval and preserve selection.
    await run('blocked-login-unavailable', { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent-nansen-test-bus' });
    assert.equal(config(), before);
    await stop(); await start();
    await run('read'); // same encrypted keyring, fresh service and CLI process
    await Promise.all([run('renew'), run('renew')]);
    assert.equal(fs.readFileSync(path.join(process.env.HOME, 'renewals'), 'utf8'), 'renewed\n');
    await stop(); await start();
    await run('read-renewed');
    await run('logout');
    await run('empty');
    console.log('PASS: real Secret Service save, fresh-process read, locked/unavailable preflight preservation, unlock/service restart, concurrent renewal, durable replacement and logout.');
    console.log('Synthetic approval/issuer only. Live browser approval, SSH and OS login/reboot remain separate qualification checks.');
  } finally { if (daemon?.exitCode === null) await stop(); }
} else if (mode === 'command') {
  const action = process.argv[3], now = Number(process.argv[4]);
  const directory = path.join(process.env.HOME, '.nansen');
  const store = createAuthStore({ directory });
  const state = createAuthState({ directory, store, now: () => now + (['renew', 'read-renewed', 'logout'].includes(action) ? 3550000 : 0),
    retire: async () => ({ remote: 'recorded_pending' }),
    refresh: (bundle, options) => refreshSession(bundle, { ...options, fetchFn: async () => {
      fs.appendFileSync(path.join(process.env.HOME, 'renewals'), 'renewed\n');
      const next = issuedFixture(bundle.privateJwk, { now: now + 3550000, padding: 'x'.repeat(3000) });
      return new Response(JSON.stringify({ access_token: next.accessToken, refresh_token: randomUUID(), token_type: 'Bearer', expires_in: 3600 }));
    } }),
  });
  if (action === 'login' || action.startsWith('blocked-login-')) {
    let paired = false;
    const login = () => browserLogin({ state, env: {}, isTTY: true, log: () => {}, errorOutput: () => {},
      pair: async (_client, hooks) => {
        paired = true;
        await hooks.onBeforePoll();
        const bundle = sessionFixture({ now, padding: 'x'.repeat(3000) });
        hooks.onIssued(bundle); return bundle;
      },
    });
    if (action.startsWith('blocked-login-')) {
      await assert.rejects(login, error => {
        assert.equal(error.code, 'AUTH_STORE_UNAVAILABLE');
        assert.match(error.message, action === 'blocked-login-locked' ? /Unlock the default collection/ : /check the user D-Bus session/);
        return true;
      }); assert.equal(paired, false);
    } else { await login(); assert.equal(paired, true); }
  } else {
    const snapshot = { config: JSON.parse(fs.readFileSync(path.join(directory, 'config.json'))) };
    const selection = resolveCredential({ env: {}, snapshot });
    if (action === 'empty') {
      assert.equal(selection.kind, 'anonymous');
      // Check that no items in this CLI's namespace survived logout.
      const found = execFileSync('gdbus', ['call', '--session', '--dest', 'org.freedesktop.secrets', '--object-path', '/org/freedesktop/secrets', '--method', 'org.freedesktop.Secret.Service.SearchItems', "{'service': 'nansen-cli-api-auth-v1'}"], { encoding: 'utf8' });
      assert.doesNotMatch(found, /\/org\/freedesktop\/secrets\/collection\//);
    } else if (action === 'logout') {
      const result = await state.logout(); assert(result.cleanup.every(item => item.local === 'removed'));
    } else {
      const bundle = await state.acquireSession(selection, { audience: selection.audience });
      assert.equal(bundle.accountId, 'account-B');
      if (action === 'read-renewed') assert.notEqual(bundle.refreshToken, 'synthetic-refresh-secret');
      else if (action === 'read') assert.equal(bundle.refreshToken, 'synthetic-refresh-secret');
      for (const name of fs.readdirSync(directory)) {
        const candidate = path.join(directory, name);
        if (fs.statSync(candidate).isFile()) {
          const text = fs.readFileSync(candidate, 'utf8');
          for (const secret of [bundle.accessToken, bundle.refreshToken, bundle.privateJwk.d]) assert(!text.includes(secret));
        }
      }
    }
  }
} else throw new Error('Unknown qualification mode');
