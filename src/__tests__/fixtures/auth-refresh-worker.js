// Test-only child command driver and persistent synthetic secret store.
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns';
const nativeFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Unintercepted child fetch'); };
const { createAuthState } = await import('../../auth-state.js');
const { createAuthStore } = await import('../../auth-store.js');
const { refreshSession } = await import('../../auth-device.js');
const { resolveCredential } = await import('../../auth-credentials.js');
const { NansenAPI } = await import('../../api.js');
const { buildCommands } = await import('../../cli.js');
let dnsFailure = false;
let state, selection, directory, target, resume, attempt, time;
const responses = new Map(); let sequence = 0;
async function barrier(phase, file) {
  if (target?.phase === phase && (!target.file || target.file === file)) {
    target = null; process.send({ event: 'barrier', phase });
    await new Promise(resolve => { resume = resolve; });
  }
}
async function transport(url, options) {
  if (dnsFailure && url.endsWith('/token/refresh')) {
    if (new URL(url).origin !== 'http://localhost:54321') throw new Error('Native fixture requires loopback');
    return nativeFetch(url, options);
  }
  const id = ++sequence;
  process.send({ event: 'request', id, url, method: options.method, headers: options.headers, body: options.body });
  const reply = await new Promise((resolve, reject) => {
    const abort = () => { responses.delete(id); reject(new Error('transport aborted')); };
    options.signal?.addEventListener('abort', abort, { once: true });
    responses.set(id, message => { options.signal?.removeEventListener('abort', abort); resolve(message); });
  });
  if (reply.lost) throw new Error('synthetic response lost');
  return new Response(JSON.stringify(reply.body), { status: reply.status, headers: reply.headers });
}
process.on('message', async message => {
  if (message.action === 'response') { responses.get(message.id)?.(message); responses.delete(message.id); return; }
  if (message.action === 'resume') { resume?.(); return; }
  try {
    let result;
    if (message.action === 'init') {
      directory = message.directory; time = message.now;
      const storeDir = path.join(directory, 'synthetic-store'); fs.mkdirSync(storeDir, { recursive: true });
      const store = createAuthStore({ barrier, operation: async (op, account, bytes) => {
        const file = path.join(storeDir, account);
        if (op === 'set') { fs.writeFileSync(file, bytes); return true; }
        if (op === 'get') return fs.existsSync(file) ? fs.readFileSync(file) : null;
        if (fs.existsSync(file)) fs.unlinkSync(file); return true;
      } });
      state = createAuthState({ directory, store, barrier, now: () => time, waitMs: 1000,
        refresh: (bundle, options) => refreshSession(bundle, { ...options, fetchFn: transport }),
        retire: async bundle => { process.send({ event: 'retire', token: bundle.refreshToken }); return { remote: 'recorded_pending' }; },
      });
      globalThis.fetch = transport;
    } else if (message.action === 'dns-failure') {
      dnsFailure = true;
      // Native lifecycle, loopback fixture only; preload independently blocks all production hosts.
      dns.lookup = (hostname, options, callback) => {
        if (typeof options === 'function') callback = options;
        callback(Object.assign(new Error('synthetic lookup failure'), { code: 'ENOTFOUND', syscall: 'getaddrinfo', hostname, errno: -3008 }));
      };
    } else if (message.action === 'seed') {
      const a = await state.begin(); await state.install(a, { bundle: message.bundle, baseUrl: message.bundle.audience }); await state.finish(a);
    } else if (message.action === 'select') {
      selection = resolveCredential({ env: {}, snapshot: { config: JSON.parse(fs.readFileSync(path.join(directory, 'config.json'))) } });
      result = { epoch: selection.selectionEpoch, generation: selection.generation };
    } else if (message.action === 'account') {
      target = message.target;
      const api = new NansenAPI(undefined, selection.audience, { credential: selection, authState: state, retry: { maxRetries: 0 } });
      result = await buildCommands().account([], api, {}, {});
    } else if (message.action === 'logout') { target = message.target; result = await state.logout(); }
    else if (message.action === 'begin') attempt = await state.begin();
    else if (message.action === 'replace') { await state.install(attempt, { bundle: message.bundle }); await state.finish(attempt); }
    else if (message.action === 'time') time = message.now;
    process.send({ id: message.id, result });
  } catch (error) { process.send({ id: message.id, error: { code: error.code || 'ERROR' } }); }
});
