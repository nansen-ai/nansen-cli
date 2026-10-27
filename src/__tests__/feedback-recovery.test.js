import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { feedbackExpiry } from '../feedback-journal.js';
import { NansenAPI } from '../api.js';
import { buildFeedbackCommands } from '../commands/feedback.js';
import { createAuthState } from '../auth-state.js';
import { createAuthStore } from '../auth-store.js';
import { resolveCredential } from '../auth-credentials.js';
import { memoryOperation, sessionFixture } from './fixtures/auth-fixture.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const examples = JSON.parse(fs.readFileSync(new URL('./fixtures/feedback-v1.json', import.meta.url)));
const dirs = [], servers = [], children = [];
afterEach(async () => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await Promise.all(servers.splice(0).map(server => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); }));
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function harness() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-recovery-')); dirs.push(home);
  const file = path.join(home, 'report.json');
  const body = JSON.stringify(examples.accepted.request.body, null, 2) + '\n';
  fs.writeFileSync(file, body);
  const journal = path.join(home, '.nansen/feedback/recovery.json');
  const requests = [];
  let onPost = (_req, res, _body) => res.destroy();
  let onGet = (_req, res) => reply(res, 200, examples.accepted.body);
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const data = { path: req.url, method: req.method, headers: req.headers, body };
    requests.push(data);
    if (req.url === '/api/v1/account' && req.headers.apikey === 'revoked-key') {
      res.writeHead(401, { 'Content-Type': 'application/json', 'X-Kong-Request-Id': 'revoked-request' });
      return res.end(JSON.stringify({ message: 'Invalid API key. Manage your keys at https://app.nansen.ai/api?tab=api' }));
    }
    if (req.url === '/api/v1/account' && req.headers.apikey === 'refused-account') {
      res.writeHead(403, { 'Content-Type': 'application/json', 'X-Kong-Request-Id': 'refused-request' });
      return res.end(JSON.stringify({ error: 'Forbidden', message: 'Account access is not permitted.', code: 'forbidden', status: 403 }));
    }
    if (req.url === '/api/v1/account') return reply(res, 200, { user_id: req.headers.apikey === 'different-account' ? 'account-B' : 'account-A', plan: 'Free', credits_remaining: 0 });
    if (req.method === 'POST') onPost(req, res, body);
    else onGet(req, res);
  });
  servers.push(server); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const start = (args, extraEnv = {}) => {
    const child = spawn(process.execPath, [path.join(root, 'src/index.js'), 'feedback', ...args], {
      cwd: root, env: { PATH: process.env.PATH, HOME: home, NANSEN_API_KEY: 'synthetic-key', NANSEN_BASE_URL: baseUrl,
        NANSEN_NO_TELEMETRY: '1', NO_UPDATE_NOTIFIER: '1', ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let stdout = '', stderr = '';
    child.stdout.on('data', value => stdout += value); child.stderr.on('data', value => stderr += value);
    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Real CLI timed out')); }, 15000);
      child.on('error', reject);
      child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
    });
    return { child, done };
  };
  return { home, file, body, journal, requests, baseUrl, start, run: (args, env) => start(args, env).done,
    post: fn => { onPost = fn; }, get: fn => { onGet = fn; },
    read: () => JSON.parse(fs.readFileSync(journal, 'utf8')),
    submit: ['submit', '--file', file, '--json'],
    hook: code => { const p = path.join(home, 'hook.cjs'); fs.writeFileSync(p, code); return { NODE_OPTIONS: `--require=${p}` }; },
  };
}
function reply(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); }
function receipt(req, fields = {}) { return { ...examples.accepted.body, submission_id: req.headers['idempotency-key'], expires_at: feedbackExpiry(Date.now()), ...fields }; }
function posts(h) { return h.requests.filter(r => r.method === 'POST'); }
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function killedPending(h) {
  const sent = deferred(); h.post((req, res) => sent.resolve({ req, res }));
  const process = h.start(h.submit); const request = await sent.promise;
  process.child.kill('SIGKILL'); await process.done;
  return request;
}

it.skipIf(process.platform === 'win32')('persists exact account, environment, ID and bytes before POST; resumes after SIGKILL and quota exhaustion', async () => {
  const h = await harness(); let captured;
  const sent = deferred();
  h.post((req, res, body) => {
    captured = h.read();
    expect(captured).toMatchObject({ version: 1, state: 'pending', account: 'account-A', environment: h.baseUrl, body });
    expect(captured.submission_id).toBe(req.headers['idempotency-key']);
    expect(fs.statSync(h.journal).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(h.journal)).mode & 0o777).toBe(0o700);
    sent.resolve();
  });
  const first = h.start(h.submit); await sent.promise; first.child.kill('SIGKILL'); await first.done;
  fs.unlinkSync(h.file);
  h.post((req, res, body) => {
    expect(body).toBe(h.body);
    reply(res, 200, receipt(req, { replayed: true, quota: { ...examples.replayed.body.quota, remaining: 0 } }));
  });
  const result = await h.run(['resume', '--json', '--cache', '--paginate']);
  expect(result.code).toBe(0); expect(result.stderr).toBe('');
  expect(JSON.parse(result.stdout).data).toMatchObject({ submission_id: captured.submission_id, replayed: true, quota: { remaining: 0 } });
  expect(posts(h).map(r => r.headers['idempotency-key'])).toEqual([captured.submission_id, captured.submission_id]);
  expect(h.read()).toEqual({ version: 1, state: 'confirmed', submission_id: captured.submission_id, account: 'account-A', environment: h.baseUrl, expires_at: captured.expires_at, feedback_id: examples.accepted.body.feedback_id });
  expect(fs.readFileSync(h.journal, 'utf8')).not.toContain('description');
  expect(fs.existsSync(path.join(h.home, '.nansen/cache'))).toBe(false);
});

it.skipIf(process.platform === 'win32')('retains the same journal when killed before dispatch', async () => {
  const h = await harness();
  const env = h.hook(`const real = globalThis.fetch; globalThis.fetch = (url, opts) => {
    if (opts.method === 'POST' && url.endsWith('/feedback')) { process.kill(process.pid, 'SIGKILL'); return new Promise(() => {}); }
    return real(url, opts);
  };`);
  expect((await h.run(h.submit, env)).signal).toBe('SIGKILL');
  const saved = h.read(); expect(posts(h)).toHaveLength(0);
  h.post((req, res) => reply(res, 201, receipt(req)));
  expect((await h.run(['resume', '--json'])).code).toBe(0);
  expect(posts(h)[0]).toMatchObject({ body: h.body, headers: { 'idempotency-key': saved.submission_id } });
});

it.skipIf(process.platform === 'win32')('stops changed account, environment and report, but accepts a rotated key for the same canonical account', async () => {
  const h = await harness(); await killedPending(h);
  for (const args of [['resume', '--json'], h.submit]) {
    const result = await h.run(args, { NANSEN_API_KEY: 'different-account' });
    expect(JSON.parse(result.stdout).code).toBe('feedback_identity_mismatch');
  }
  expect(JSON.parse((await h.run(['resume', '--json'], { NANSEN_BASE_URL: 'http://127.0.0.1:1' })).stdout).code).toBe('feedback_identity_mismatch');
  fs.writeFileSync(h.file, JSON.stringify({ description: 'changed' }));
  expect(JSON.parse((await h.run(h.submit)).stdout).code).toBe('feedback_report_changed');
  expect(posts(h)).toHaveLength(1);
  h.post((req, res) => reply(res, 200, receipt(req, { replayed: true })));
  expect((await h.run(['resume', '--json'], { NANSEN_API_KEY: 'rotated-same-account' })).code).toBe(0);
  expect(posts(h)[1].headers.apikey).toBe('rotated-same-account');
});

it.skipIf(process.platform === 'win32')('excludes a concurrent process and recovers its OS lock after a hard kill', async () => {
  const h = await harness(); const sent = deferred(); h.post(() => sent.resolve());
  const first = h.start(h.submit); await sent.promise;
  const result = await h.run(h.submit);
  expect(JSON.parse(result.stdout).code).toBe('feedback_busy'); expect(posts(h)).toHaveLength(1);
  const id = h.read().submission_id;
  first.child.kill('SIGKILL'); await first.done;
  h.post((req, res) => reply(res, 200, receipt(req, { replayed: true })));
  expect((await h.run(['resume', '--json'])).code).toBe(0); expect(posts(h)[1].headers['idempotency-key']).toBe(id);
});

it.skipIf(process.platform === 'win32')('prints safe unknown-outcome recovery in JSON and human output without report content or credentials', async () => {
  const h = await harness(); h.post((_req, res) => res.destroy());
  const json = await h.run([...h.submit, '--no-retry']);
  const error = JSON.parse(json.stdout);
  expect(error.code).toBe('submission_outcome_unknown');
  expect(error.details).toMatchObject({ outcome: 'unknown', retry_command: 'nansen feedback resume', submission_id: h.read().submission_id });
  const human = await h.run(['resume', '--no-retry']);
  expect(human.stdout).toContain('nansen feedback resume');
  for (const result of [json, human]) {
    expect(result.stdout + result.stderr).not.toContain('synthetic-key');
    expect(result.stdout + result.stderr).not.toContain(examples.accepted.request.body.description);
  }
});

it.skipIf(process.platform === 'win32').each(['file-sync', 'rename'])('fails before POST on %s failure and preserves explicit-ID submission', async stage => {
  const h = await harness();
  const env = h.hook(`const fs = require('node:fs'); const rename = fs.renameSync;
  if (${stage === 'file-sync'}) fs.fsyncSync = () => { throw Object.assign(new Error('synthetic disk failure'), { code: 'ENOSPC' }); };
  fs.renameSync = (a, b) => {
    if (b.endsWith('/feedback/recovery.json')) throw Object.assign(new Error('synthetic disk failure'), { code: 'ENOSPC' });
    return rename(a, b);
  };`);
  const result = await h.run(h.submit, env);
  expect(JSON.parse(result.stdout).code).toBe('feedback_storage_unavailable'); expect(posts(h)).toHaveLength(0);
  expect(result.stdout).toContain('caller-managed'); expect(fs.existsSync(h.journal)).toBe(false);
  h.post((req, res) => reply(res, 201, receipt(req)));
  expect((await h.run([...h.submit, '--submission-id', 'caller-managed'], env)).code).toBe(0);
  expect(posts(h)[0].headers['idempotency-key']).toBe('caller-managed');
});

it.skipIf(process.platform === 'win32')('expires pending data before replay and keeps no identifying metadata; explicit --new starts a deliberate report', async () => {
  const h = await harness(); await killedPending(h);
  const deadline = Date.parse(h.read().expires_at);
  const env = h.hook(`Date.now = () => ${deadline};`);
  const result = await h.run(['resume', '--json'], env);
  expect(JSON.parse(result.stdout).code).toBe('feedback_recovery_unavailable');
  expect(h.read()).toEqual({ version: 1, state: 'cleared' }); expect(posts(h)).toHaveLength(1);
  expect(JSON.parse((await h.run(h.submit)).stdout).code).toBe('feedback_recovery_unavailable');
  h.post((req, res) => reply(res, 201, receipt(req)));
  expect((await h.run([...h.submit, '--new'])).code).toBe(0);
  expect(posts(h)).toHaveLength(2);
});

it.skipIf(process.platform === 'win32')('erases offline, blocks replay, and refuses --new while an entry is pending', async () => {
  const h = await harness(); await killedPending(h);
  expect(JSON.parse((await h.run([...h.submit, '--new'])).stdout).code).toBe('feedback_pending');
  const count = h.requests.length;
  const result = await h.run(['forget', '--json'], { NANSEN_API_KEY: '', NANSEN_BASE_URL: 'http://127.0.0.1:1' });
  expect(JSON.parse(result.stdout).data).toEqual({ forgotten: true });
  expect(h.requests).toHaveLength(count); expect(fs.readFileSync(h.file, 'utf8')).toBe(h.body);
  expect(h.read()).toEqual({ version: 1, state: 'cleared' });
  expect(JSON.parse((await h.run(['resume', '--json'])).stdout).code).toBe('feedback_recovery_unavailable');
});

it.skipIf(process.platform === 'win32')('clears local state after feedback_erased, then never replays it', async () => {
  const h = await harness(); await killedPending(h);
  h.post((_req, res) => reply(res, 409, { code: 'conflict', reason: 'feedback_erased', message: 'Erased' }));
  const result = await h.run(['resume', '--json']);
  expect(result.code).toBe(1); expect(JSON.parse(result.stdout).details.outcome).toBeUndefined();
  expect(h.read()).toEqual({ version: 1, state: 'cleared' });
  expect(JSON.parse((await h.run(h.submit)).stdout).code).toBe('feedback_recovery_unavailable');
  expect(posts(h)).toHaveLength(2);
});

it.skipIf(process.platform === 'win32')('reads a confirmed receipt on resume and clears it on a missing get receipt', async () => {
  const h = await harness(); h.post((req, res) => reply(res, 201, receipt(req)));
  expect((await h.run(h.submit)).code).toBe(0);
  const saved = h.read(); h.get((_req, res) => reply(res, 200, { ...examples.accepted.body, submission_id: saved.submission_id }));
  expect((await h.run(['resume', '--json'])).code).toBe(0); expect(posts(h)).toHaveLength(1);
  expect(JSON.parse((await h.run(h.submit)).stdout).code).toBe('feedback_already_confirmed');
  h.get((_req, res) => reply(res, 404, examples.not_found.body));
  expect((await h.run(['get', saved.feedback_id, '--json'])).code).toBe(1);
  expect(h.read()).toEqual({ version: 1, state: 'cleared' });
});

it.skipIf(process.platform === 'win32')('rejects unknown journal versions, world-readable data, and symlinks without POST', async () => {
  const h = await harness(); await killedPending(h); const saved = h.read();
  fs.writeFileSync(h.journal, JSON.stringify({ ...saved, version: 2 }));
  expect(JSON.parse((await h.run(['resume', '--json'])).stdout).code).toBe('feedback_storage_unavailable');
  fs.writeFileSync(h.journal, JSON.stringify(saved)); fs.chmodSync(h.journal, 0o644);
  expect(JSON.parse((await h.run(['resume', '--json'])).stdout).code).toBe('feedback_storage_unavailable');
  fs.unlinkSync(h.journal); fs.symlinkSync(h.file, h.journal);
  expect(JSON.parse((await h.run(['resume', '--json'])).stdout).code).toBe('feedback_storage_unavailable');
  expect(posts(h)).toHaveLength(1);
});

it('clamps leap-day pending expiry to February 28 of the following year', () => {
  expect(feedbackExpiry(Date.parse('2028-02-29T12:34:56Z'))).toBe('2029-02-28T12:34:56.000Z');
});

it.skipIf(process.platform === 'win32')('binds browser recovery to the canonical account and freezes credentials across retries', async () => {
  const h = await harness(); vi.stubEnv('HOME', h.home);
  const state = createAuthState({ directory: path.join(h.home, '.nansen'), store: createAuthStore(memoryOperation()) });
  const bundle = sessionFixture(); const attempt = await state.begin();
  await state.install(attempt, { bundle, baseUrl: bundle.audience }); await state.finish(attempt);
  const api = new NansenAPI(undefined, bundle.audience, { credential: resolveCredential({ env: { HOME: h.home } }), authState: state, retry: { baseDelayMs: 0 } });
  const original = api.requestCredentials.bind(api);
  const credentials = vi.spyOn(api, 'requestCredentials').mockImplementation(original);
  let sends = 0;
  const calls = [];
  vi.stubGlobal('fetch', async (url, options) => {
    calls.push(options);
    if (url.endsWith('/account')) return new Response(JSON.stringify({ user_id: bundle.accountId }));
    expect(h.read()).toMatchObject({ account: bundle.accountId, environment: bundle.audience, body: h.body });
    if (++sends === 1) throw new Error('lost response');
    return new Response(JSON.stringify({ ...examples.accepted.body, submission_id: options.headers['Idempotency-Key'], expires_at: feedbackExpiry(Date.now()) }));
  });
  const result = await buildFeedbackCommands().feedback(['submit'], api, { json: true }, { file: h.file });
  expect(result.submission_id).toBe(h.read().submission_id);
  expect(credentials).toHaveBeenCalledTimes(1);
  for (const options of calls) expect(options.headers.Authorization).toBe(`Bearer ${bundle.accessToken}`);
  for (const secret of [bundle.accessToken, bundle.refreshToken, bundle.privateJwk.d]) expect(fs.readFileSync(h.journal, 'utf8')).not.toContain(secret);
});

it.skipIf(process.platform === 'win32')('stops replay when expiry occurs during a network retry', async () => {
  const h = await harness();
  const env = h.hook(`const real = globalThis.fetch; const now = Date.now; let expired;
    Date.now = () => expired || now();
    globalThis.fetch = (url, options) => real(url, options).finally(() => {
      if (options.method === 'POST' && url.endsWith('/feedback')) expired = Date.parse(JSON.parse(require('node:fs').readFileSync(${JSON.stringify(h.journal)}, 'utf8')).expires_at);
    });`);
  h.post((_req, res) => res.destroy());
  const result = await h.run([...h.submit, '--retries', '1'], env);
  expect(JSON.parse(result.stdout).code).toBe('feedback_recovery_unavailable');
  expect(posts(h)).toHaveLength(1); expect(h.read()).toEqual({ version: 1, state: 'cleared' });
});

it('rejects malformed explicit IDs and valued --new without generating a submission', async () => {
  const h = await harness();
  for (const args of [
    [...h.submit, '--submission-id'],
    [...h.submit, '--submission-id', 'a', '--submission-id', 'b'],
    [...h.submit, '--new=false'],
  ]) {
    expect((await h.run(args)).code).toBe(1);
    expect(posts(h)).toHaveLength(0); expect(fs.existsSync(h.journal)).toBe(false);
  }
});

it.skipIf(process.platform === 'win32').each(['json', 'human'])('erases definitively rejected report bytes and explains correction in %s output', async format => {
  const h = await harness();
  fs.writeFileSync(h.file, JSON.stringify(examples.invalid_unknown_field.request.body));
  h.post((_req, res) => reply(res, examples.invalid_unknown_field.status, examples.invalid_unknown_field.body));
  const result = await h.run(format === 'json' ? h.submit : h.submit.filter(arg => arg !== '--json'));
  expect(result.code).toBe(1); expect(result.stdout).toContain('This attempt was rejected');
  expect(result.stdout).not.toContain('may have been accepted');
  if (format === 'json') expect(JSON.parse(result.stdout).details).toMatchObject({ outcome: 'rejected' });
  expect(h.read()).toEqual({ version: 1, state: 'cleared' });
  const oldId = posts(h)[0].headers['idempotency-key'];
  expect(JSON.parse((await h.run(['resume', '--json'])).stdout).code).toBe('feedback_recovery_unavailable');
  fs.writeFileSync(h.file, h.body); h.post((req, res) => reply(res, 201, receipt(req)));
  expect((await h.run([...h.submit, '--new'])).code).toBe(0);
  expect(posts(h)[1].headers['idempotency-key']).not.toBe(oldId);
});

it.skipIf(process.platform === 'win32').each([
  [400, { code: 'invalid_json', message: 'Invalid JSON' }],
  [413, { code: 'payload_too_large', message: 'Report too large' }],
  [422, { code: 'invalid_value', message: "Field 'description' appears to contain a credential. Remove secrets and resubmit." }],
  [409, examples.conflict.body],
])('clears rejected pending content on HTTP %s without an unknown-outcome label', async (status, error) => {
  const h = await harness(); fs.writeFileSync(h.file, JSON.stringify({ category: 'bug', description: '?api_key=SYNTHCRED123' }));
  h.post((_req, res) => reply(res, status, error));
  const result = await h.run(h.submit);
  expect(JSON.parse(result.stdout).details.outcome).toBe('rejected');
  expect(result.stdout).not.toContain('SYNTHCRED123');
  expect(h.read()).toEqual({ version: 1, state: 'cleared' });
});

it.skipIf(process.platform === 'win32').each(['0644', 'damaged', 'symlink'])('erases a %s journal offline without reading or following it', async damage => {
  const h = await harness(); await killedPending(h);
  if (damage === '0644') fs.chmodSync(h.journal, 0o644);
  if (damage === 'damaged') fs.writeFileSync(h.journal, '{"broken":"raw report text');
  if (damage === 'symlink') { fs.unlinkSync(h.journal); fs.symlinkSync(h.file, h.journal); }
  const count = h.requests.length;
  const result = await h.run(['forget', '--json'], h.hook(`globalThis.fetch = () => {
    require('node:fs').writeFileSync(${JSON.stringify(path.join(h.home, 'unexpected-network'))}, 'called');
    throw new Error('Forget must stay offline');
  };`));
  expect(result.code).toBe(0); expect(JSON.parse(result.stdout).data).toEqual({ forgotten: true });
  expect(fs.existsSync(path.join(h.home, 'unexpected-network'))).toBe(false);
  expect(h.read()).toEqual({ version: 1, state: 'cleared' });
  expect(fs.statSync(h.journal).mode & 0o777).toBe(0o600);
  expect(h.requests).toHaveLength(count); expect(fs.readFileSync(h.file, 'utf8')).toBe(h.body);
});

it.skipIf(process.platform === 'win32')('preserves the old entry if killed before local erasure commits', async () => {
  const h = await harness(); await killedPending(h); const saved = h.read();
  const result = await h.run(['forget', '--json'], h.hook(`const fs = require('node:fs'); const rename = fs.renameSync;
    fs.renameSync = (a, b) => { if (b.endsWith('/feedback/recovery.json')) process.kill(process.pid, 'SIGKILL'); return rename(a, b); };`));
  expect(result.signal).toBe('SIGKILL'); expect(h.read()).toEqual(saved);
  expect((await h.run(['forget', '--json'])).code).toBe(0);
  expect(h.read()).toEqual({ version: 1, state: 'cleared' });
  expect(JSON.parse((await h.run(h.submit)).stdout).code).toBe('feedback_recovery_unavailable');
  expect(posts(h)).toHaveLength(1);
});

it.skipIf(process.platform === 'win32').each(['json', 'human'])('reports quota rejection in %s output and resumes the same saved report after reset', async format => {
  const h = await harness();
  h.post((_req, res) => reply(res, examples.weekly_limit.status, examples.weekly_limit.body));
  const result = await h.run(format === 'json' ? h.submit : h.submit.filter(arg => arg !== '--json'));
  expect(result.code).toBe(1); expect(result.stdout).toContain('Wait for the weekly reset');
  expect(result.stdout).toContain(examples.weekly_limit.body.quota.resets_at);
  expect(result.stdout).not.toContain('may have been accepted');
  if (format === 'json') expect(JSON.parse(result.stdout).details).toMatchObject({
    reason: 'feedback_weekly_quota_exhausted', outcome: 'rejected', retry_command: 'nansen feedback resume',
    retry_not_before: examples.weekly_limit.body.quota.resets_at,
  });
  const saved = h.read(); expect(saved).toMatchObject({ state: 'pending', body: h.body });
  expect(posts(h)).toHaveLength(1);
  const again = await h.run(['resume', '--json']);
  expect(JSON.parse(again.stdout).details.outcome).toBe('rejected'); expect(h.read()).toEqual(saved);
  expect(posts(h)).toHaveLength(2);
  fs.unlinkSync(h.file); h.post((req, res) => reply(res, 201, receipt(req)));
  const afterReset = h.hook(`Date.now = () => ${Date.parse(examples.weekly_limit.body.quota.resets_at)};`);
  expect((await h.run(['resume', '--json'], afterReset)).code).toBe(0);
  expect(posts(h).map(req => req.body)).toEqual([h.body, h.body, h.body]);
  expect(new Set(posts(h).map(req => req.headers['idempotency-key']))).toEqual(new Set([saved.submission_id]));
  expect(h.read()).toMatchObject({ state: 'confirmed', submission_id: saved.submission_id });
});

it('preserves the saved ID on rollout denial and distinguishes prior uncertainty', async () => {
  for (const prior of [false, true]) {
    const h = await harness();
    if (prior) await killedPending(h);
    h.post((_req, res) => reply(res, 403, { code: 'forbidden', reason: 'feedback_not_enabled', message: 'Not enabled for account.' }));
    const result = await h.run(prior ? ['resume', '--json'] : h.submit);
    const error = JSON.parse(result.stdout);
    expect(error.details).toMatchObject({ reason: 'feedback_not_enabled', outcome: prior ? 'unknown' : 'rejected', submission_id: h.read().submission_id });
    expect(result.stdout).toContain('Stop automatic retries'); expect(error.details.retry_command).toBeUndefined();
    const saved = h.read(); expect(saved.state).toBe('pending'); expect(saved.body).toBe(h.body);
    h.post((req, res) => reply(res, 200, receipt(req, { replayed: prior })));
    expect((await h.run(['resume', '--json'])).code).toBe(0);
    expect(h.read().submission_id).toBe(saved.submission_id);
  }
});

it.each([{ flags: [] }, { flags: ['--json'] }])('keeps repeated rollout denials rejected across process restarts %j', async ({ flags }) => {
  const h = await harness();
  h.post((_req, res) => reply(res, 403, { code: 'forbidden', reason: 'feedback_not_enabled' }));
  for (const args of [['submit', '--file', h.file], ['resume'], ['resume']]) {
    const r = await h.run([...args, ...flags]);
    expect(r.code).toBe(1); expect(r.stdout).toContain('This report was not accepted');
    expect(r.stdout).not.toMatch(/may have been (accepted|saved)/);
    expect(h.read()).toMatchObject({ state: 'pending', uncertain: false, body: h.body });
    if (flags.length) expect(JSON.parse(r.stdout)).toMatchObject({ details: { outcome: 'rejected' } });
  }
  expect(posts(h)).toHaveLength(3);
  expect(new Set(posts(h).map(r => r.headers['idempotency-key'])).size).toBe(1);
});

it.each([{ flags: [] }, { flags: ['--json'] }])('clears a generated submission after an edge block and requires --new %j', async ({ flags }) => {
  const h = await harness();
  h.post((_req, res) => { res.writeHead(403, { 'Content-Type': 'text/html' }); res.end('<html>Blocked</html>'); });
  const r = await h.run(['submit', '--file', h.file, ...flags]);
  expect(r.code).toBe(1); expect(r.stdout).toContain('blocked before reaching Nansen');
  expect(r.stdout).toContain('use --new'); expect(r.stdout).not.toContain('may have been');
  expect(r.stdout).not.toContain('new submission ID');
  if (flags.length) expect(JSON.parse(r.stdout)).toMatchObject({ code: 'feedback_blocked', details: { outcome: 'rejected' } });
  expect(h.read()).toEqual({ version: 1, state: 'cleared' });
  expect(JSON.parse((await h.run(['resume', '--json'])).stdout).code).toBe('feedback_recovery_unavailable');
  expect(JSON.parse((await h.run(h.submit)).stdout).code).toBe('feedback_recovery_unavailable');
  const oldId = posts(h)[0].headers['idempotency-key'];
  fs.writeFileSync(h.file, JSON.stringify({ ...examples.accepted.request.body, description: 'Corrected report' }));
  h.post((req, res) => reply(res, 201, receipt(req)));
  expect((await h.run([...h.submit, '--new'])).code).toBe(0);
  expect(posts(h)).toHaveLength(2); expect(posts(h)[1].headers['idempotency-key']).not.toBe(oldId);
});

it('keeps an uncertain generated submission recoverable after an edge block', async () => {
  const h = await harness(); await killedPending(h);
  const id = h.read().submission_id;
  h.post((_req, res) => { res.writeHead(403, { 'Content-Type': 'text/html' }); res.end('<html>Blocked</html>'); });
  const r = await h.run(['resume', '--json']);
  expect(JSON.parse(r.stdout)).toMatchObject({ code: 'submission_outcome_unknown', details: { outcome: 'unknown' } });
  expect(r.stdout).not.toContain('No report was saved');
  expect(h.read()).toMatchObject({ state: 'pending', uncertain: true, submission_id: id, body: h.body });
});

it('records uncertainty when a retry is killed after a definite rollout denial', async () => {
  const h = await harness();
  const deny = (_req, res) => reply(res, 403, { code: 'forbidden', reason: 'feedback_not_enabled' });
  h.post(deny); await h.run(h.submit);
  expect(h.read().uncertain).toBe(false);
  await killedPending(h);
  expect(h.read().uncertain).toBe(true);
  h.post(deny);
  for (const args of [['resume', '--json'], ['resume']]) {
    const r = await h.run(args);
    expect(r.stdout).toContain('may have been saved'); expect(r.stdout).not.toContain('This report was not accepted');
    if (args.includes('--json')) expect(JSON.parse(r.stdout).details.outcome).toBe('unknown');
  }
});

it.each(['weekly_limit', 'invalid_unknown_field'])('retains prior uncertainty through a later %s rejection and rollout denial', async scenario => {
  const h = await harness(); let attempts = 0;
  h.post((_req, res) => {
    if (++attempts === 1) { res.destroy(); return; }
    reply(res, examples[scenario].status, examples[scenario].body);
  });
  const r = await h.run(h.submit);
  expect(JSON.parse(r.stdout).details.outcome).toBe('unknown');
  expect(h.read()).toMatchObject({ state: 'pending', uncertain: true, body: h.body });
  const id = h.read().submission_id;
  h.post((_req, res) => reply(res, 403, { code: 'forbidden', reason: 'feedback_not_enabled' }));
  const next = await h.run(['resume', '--json']);
  expect(JSON.parse(next.stdout)).toMatchObject({ details: { outcome: 'unknown', submission_id: id } });
  expect(h.read().uncertain).toBe(true);
});

it('treats a legacy pending journal as uncertain and rejects malformed uncertainty', async () => {
  const h = await harness(); await killedPending(h);
  const legacy = h.read(); delete legacy.uncertain;
  fs.writeFileSync(h.journal, JSON.stringify(legacy));
  h.post((_req, res) => reply(res, 403, { code: 'forbidden', reason: 'feedback_not_enabled' }));
  expect(JSON.parse((await h.run(['resume', '--json'])).stdout).details.outcome).toBe('unknown');
  fs.writeFileSync(h.journal, JSON.stringify({ ...h.read(), uncertain: 'false' }));
  expect(JSON.parse((await h.run(['resume', '--json'])).stdout).code).toBe('feedback_storage_unavailable');
  expect(posts(h)).toHaveLength(2);
});

it.each(['confirmation', 'rejection-state'])('keeps safe recovery guidance when the %s journal write fails', async failure => {
  for (const flags of [['--json'], []]) {
    const h = await harness();
    h.post((req, res) => failure === 'confirmation' ? reply(res, 201, receipt(req))
      : reply(res, 403, { code: 'forbidden', reason: 'feedback_not_enabled' }));
    const env = h.hook(`const fs = require('node:fs'); const rename = fs.renameSync; let writes = 0;
      fs.renameSync = (a, b) => {
        if (b.endsWith('/feedback/recovery.json') && ++writes === 3) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
        return rename(a, b);
      };`);
    const r = await h.run(['submit', '--file', h.file, ...flags], env);
    expect(r.code).toBe(1); expect(r.stdout).toContain('may have been saved');
    expect(r.stdout).toContain('nansen feedback resume'); expect(r.stdout).not.toContain('caller-managed');
    expect(h.read()).toMatchObject({ state: 'pending', uncertain: true, body: h.body });
    if (flags.length) expect(JSON.parse(r.stdout)).toMatchObject({ code: 'feedback_storage_unavailable',
      details: { outcome: 'unknown', submission_id: h.read().submission_id, retry_command: 'nansen feedback resume' } });
    const id = h.read().submission_id;
    h.post((req, res) => reply(res, 200, receipt(req, { replayed: failure === 'confirmation' })));
    expect((await h.run(['resume', '--json'])).code).toBe(0);
    expect(h.read()).toMatchObject({ state: 'confirmed', submission_id: id });
  }
});

it.each([
  { status: 402, json: false }, { status: 404, json: false }, { status: 501, json: false },
  { status: 402, json: true }, { status: 404, json: true }, { status: 501, json: true },
])('retains uncertainty after a lost reply then HTTP $status, JSON $json', async ({ status, json }) => {
  const h = await harness(); let attempts = 0;
  h.post((_req, res) => {
    if (++attempts === 1) { res.destroy(); return; }
    if (json) reply(res, status, { code: 'unavailable', message: 'Unavailable' });
    else { res.writeHead(status, { 'Content-Type': 'text/html' }); res.end('<html>Unavailable</html>'); }
  });
  const r = await h.run([...h.submit, '--retries', '1']);
  expect(JSON.parse(r.stdout)).toMatchObject({ code: 'submission_outcome_unknown', details: { outcome: 'unknown' } });
  const saved = h.read(); expect(saved.uncertain).toBe(true);
  h.post((_req, res) => { res.writeHead(403, { 'Content-Type': 'text/html' }); res.end('<html>Blocked</html>'); });
  const again = await h.run(['resume']);
  expect(again.stdout).toContain('may have been saved'); expect(again.stdout).not.toContain('No report was saved');
  expect(h.read()).toMatchObject({ state: 'pending', uncertain: true, submission_id: saved.submission_id });
});

it('keeps prior uncertainty when storage fails before a resumed dispatch', async () => {
  const h = await harness(); await killedPending(h);
  const id = h.read().submission_id;
  const env = h.hook(`const fs = require('node:fs'); const rename = fs.renameSync;
    fs.renameSync = (a, b) => {
      if (b.endsWith('/feedback/recovery.json')) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      return rename(a, b);
    };`);
  const r = await h.run(['resume', '--json'], env);
  expect(JSON.parse(r.stdout)).toMatchObject({ code: 'feedback_storage_unavailable',
    details: { outcome: 'unknown', submission_id: id, retry_command: 'nansen feedback resume' } });
  expect(r.stdout).not.toContain('caller-managed'); expect(posts(h)).toHaveLength(1);
  expect(h.read()).toMatchObject({ state: 'pending', uncertain: true, submission_id: id });
});

it.each(['fresh submit', 'rollout resume'])('keeps the saved unsent ID when the dispatch-state write fails on %s', async scenario => {
  for (const flags of [[], ['--json']]) {
    const h = await harness();
    const resumed = scenario === 'rollout resume';
    if (resumed) {
      h.post((_req, res) => reply(res, 403, { code: 'forbidden', reason: 'feedback_not_enabled' }));
      expect((await h.run(h.submit)).code).toBe(1);
    }
    const before = posts(h).length;
    const originalId = resumed ? h.read().submission_id : undefined;
    const env = h.hook(`const fs = require('node:fs'); const rename = fs.renameSync; let writes = 0;
      fs.renameSync = (a, b) => {
        if (b.endsWith('/feedback/recovery.json') && ++writes === ${resumed ? 1 : 2}) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
        return rename(a, b);
      };`);
    const r = await h.run([...(resumed ? ['resume'] : ['submit', '--file', h.file]), ...flags], env);
    const saved = h.read();
    expect(r.code).toBe(1); expect(posts(h)).toHaveLength(before);
    expect(saved).toMatchObject({ state: 'pending', uncertain: false, body: h.body });
    if (resumed) expect(saved.submission_id).toBe(originalId);
    expect(r.stdout).toContain('The report was not sent.');
    expect(r.stdout).toContain('nansen feedback resume'); expect(r.stdout).toContain(saved.submission_id);
    expect(r.stdout).not.toMatch(/caller-managed|may have been (accepted|saved)/);
    expect(r.stdout + r.stderr).not.toContain('synthetic-key');
    expect(r.stdout + r.stderr).not.toContain(examples.accepted.request.body.description);
    if (flags.length) expect(JSON.parse(r.stdout)).toMatchObject({ code: 'feedback_storage_unavailable',
      details: { outcome: 'rejected', submission_id: saved.submission_id, retry_command: 'nansen feedback resume' } });
    expect(JSON.parse((await h.run([...h.submit, '--new'])).stdout).code).toBe('feedback_pending');
    expect(posts(h)).toHaveLength(before);
    h.post((req, res) => reply(res, 201, receipt(req)));
    expect((await h.run(['resume', '--json'])).code).toBe(0);
    expect(posts(h).slice(before)).toEqual([expect.objectContaining({ body: h.body,
      headers: expect.objectContaining({ 'idempotency-key': saved.submission_id }) })]);
    expect(h.read()).toMatchObject({ state: 'confirmed', submission_id: saved.submission_id });
  }
});

it.each(['fresh', 'confirmed', 'cleared'])('keeps the saved unsent ID when initial directory sync fails after %s state', async state => {
  for (const flags of [[], ['--json']]) {
    const h = await harness(); h.post((req, res) => reply(res, 201, receipt(req)));
    if (state === 'confirmed') expect((await h.run(h.submit)).code).toBe(0);
    if (state === 'cleared') expect((await h.run(['forget', '--json'])).code).toBe(0);
    const before = posts(h).length;
    const previousId = state === 'confirmed' ? h.read().submission_id : undefined;
    const env = h.hook(`const fs = require('node:fs'); const rename = fs.renameSync; const sync = fs.fsyncSync; let replaced = false;
      fs.renameSync = (a, b) => { const result = rename(a, b); if (b.endsWith('/feedback/recovery.json')) replaced = true; return result; };
      fs.fsyncSync = descriptor => { if (replaced) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); return sync(descriptor); };`);
    const r = await h.run(['submit', '--file', h.file, ...(state === 'fresh' ? [] : ['--new']), ...flags], env);
    const saved = h.read();
    expect(r.code).toBe(1); expect(posts(h)).toHaveLength(before);
    expect(saved).toMatchObject({ state: 'pending', uncertain: false, body: h.body });
    if (previousId) expect(saved.submission_id).not.toBe(previousId);
    expect(r.stdout).toContain('The report was not sent.');
    expect(r.stdout).toContain('nansen feedback resume'); expect(r.stdout).toContain(saved.submission_id);
    expect(r.stdout).not.toMatch(/caller-managed|may have been (accepted|saved)|journalSaved/);
    expect(r.stdout + r.stderr).not.toContain('synthetic-key');
    expect(r.stdout + r.stderr).not.toContain(examples.accepted.request.body.description);
    if (flags.length) expect(JSON.parse(r.stdout)).toMatchObject({ code: 'feedback_storage_unavailable',
      details: { outcome: 'rejected', submission_id: saved.submission_id, retry_command: 'nansen feedback resume' } });
    expect(JSON.parse((await h.run([...h.submit, '--new'])).stdout).code).toBe('feedback_pending');
    expect(posts(h)).toHaveLength(before);
    fs.unlinkSync(h.file);
    expect((await h.run(['resume', '--json'])).code).toBe(0);
    expect(posts(h).slice(before)).toEqual([expect.objectContaining({ body: h.body,
      headers: expect.objectContaining({ 'idempotency-key': saved.submission_id }) })]);
    expect(h.read()).toMatchObject({ state: 'confirmed', submission_id: saved.submission_id });
    expect(fs.readFileSync(h.journal, 'utf8')).not.toContain('description');
  }
});

it.each([
  { status: 403, code: 'feedback_blocked', html: true },
  { status: 422, code: 'invalid_value', reason: 'invalid_value' },
  { status: 409, code: 'conflict', reason: 'feedback_erased' },
])('keeps a definite rejection and forget guidance when its erase write fails: $status', async ({ status, code, html, reason }) => {
  for (const flags of [[], ['--json']]) {
    const h = await harness();
    const resumed = reason === 'feedback_erased';
    if (resumed) await killedPending(h);
    h.post((_req, res) => {
      if (html) { res.writeHead(status, { 'Content-Type': 'text/html' }); res.end('<html>Blocked</html>'); }
      else reply(res, status, { code, reason, message: 'This submission was rejected.' });
    });
    const env = h.hook(`const fs = require('node:fs'); const rename = fs.renameSync; let writes = 0;
      fs.renameSync = (a, b) => {
        if (b.endsWith('/feedback/recovery.json') && ++writes === ${resumed ? 2 : 3}) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
        return rename(a, b);
      };`);
    const r = await h.run([...(resumed ? ['resume'] : ['submit', '--file', h.file]), ...flags], env);
    const id = h.read().submission_id;
    expect(r.code).toBe(1); expect(r.stdout).toContain('Local retry data could not be erased');
    expect(r.stdout).toContain('nansen feedback forget'); expect(r.stdout).toContain('--new');
    expect(r.stdout).not.toMatch(/caller-managed|may have been (accepted|saved)/);
    if (flags.length) expect(JSON.parse(r.stdout)).toMatchObject({ code, status,
      details: { outcome: 'rejected', submission_id: id, retry_command: 'nansen feedback forget' } });
    expect(h.read()).toMatchObject({ state: 'pending', body: h.body });
    const count = posts(h).length;
    expect(JSON.parse((await h.run([...h.submit, '--new'])).stdout).code).toBe('feedback_pending');
    expect(posts(h)).toHaveLength(count);
    expect((await h.run(['forget', '--json'])).code).toBe(0);
    expect(h.read()).toEqual({ version: 1, state: 'cleared' });
    fs.writeFileSync(h.file, JSON.stringify({ ...examples.accepted.request.body, description: 'Corrected report' }));
    h.post((req, res) => reply(res, 201, receipt(req)));
    expect((await h.run([...h.submit, '--new'])).code).toBe(0);
    expect(h.read()).toMatchObject({ state: 'confirmed' }); expect(h.read().submission_id).not.toBe(id);
  }
});

it.each(['resume', 'get'])('keeps confirmed-receipt recovery guidance if %s cannot clear a missing receipt', async command => {
  const h = await harness(); h.post((req, res) => reply(res, 201, receipt(req)));
  await h.run(h.submit); const saved = h.read();
  h.get((_req, res) => reply(res, 404, { code: 'not_found' }));
  const env = h.hook(`const fs = require('node:fs'); const rename = fs.renameSync;
    fs.renameSync = (a, b) => { if (b.endsWith('/feedback/recovery.json')) throw new Error('disk full'); return rename(a, b); };`);
  const args = command === 'get' ? ['get', saved.feedback_id, '--json'] : ['resume', '--json'];
  const r = await h.run(args, env);
  expect(JSON.parse(r.stdout)).toMatchObject({ code: 'feedback_storage_unavailable',
    details: { submission_id: saved.submission_id, retry_command: 'nansen feedback resume' } });
  expect(r.stdout).not.toContain('caller-managed'); expect(h.read()).toEqual(saved);
  expect((await h.run(['resume', '--json'])).code).toBe(1);
  expect(h.read()).toEqual({ version: 1, state: 'cleared' }); expect(posts(h)).toHaveLength(1);
});

it.each([401, 429, 501])('keeps the resume command after a definite retained HTTP %s rejection', async status => {
  const h = await harness(); h.post((_req, res) => reply(res, status, { code: 'rejected', message: 'Unavailable' }));
  for (const args of [[...h.submit, '--no-retry'], ['resume', '--no-retry']]) {
    const r = await h.run(args);
    expect(r.code).toBe(1); expect(r.stdout).toContain('nansen feedback resume');
    expect(r.stdout).not.toContain('may have been accepted');
    if (args.includes('--json')) expect(JSON.parse(r.stdout).details).toMatchObject({ outcome: 'rejected', retry_command: 'nansen feedback resume' });
    expect(h.read()).toMatchObject({ state: 'pending', uncertain: false });
  }
});

it.each([
  { status: 500, reason: 'internal_error', outcome: 'unknown' },
  { status: 503, reason: 'feedback_store_unavailable', outcome: 'unknown' },
  { status: 503, reason: 'feedback_admissions_paused', outcome: 'rejected' },
])('retains recoverable journal after $reason then rollout denial', async ({ status, reason, outcome }) => {
  const h = await harness(); let attempts = 0;
  h.post((_req, res) => reply(res, ++attempts === 1 ? status : 403, attempts === 1
    ? { code: 'upstream_unavailable', reason }
    : { code: 'forbidden', reason: 'feedback_not_enabled' }));
  const result = await h.run(h.submit); const saved = h.read();
  expect(JSON.parse(result.stdout)).toMatchObject({ details: { outcome, reason: 'feedback_not_enabled', submission_id: saved.submission_id } });
  expect(saved).toMatchObject({ state: 'pending', body: h.body });
  expect(posts(h)).toHaveLength(2); expect(posts(h)[0].body).toBe(posts(h)[1].body);
  expect(posts(h)[0].headers['idempotency-key']).toBe(posts(h)[1].headers['idempotency-key']);
  h.post((req, res) => reply(res, 200, receipt(req, { replayed: outcome === 'unknown' })));
  expect((await h.run(['resume', '--json'])).code).toBe(0);
  expect(h.read()).toMatchObject({ state: 'confirmed', submission_id: saved.submission_id });
});

it.each([{ flags: [] }, { flags: ['--json'] }])('gives only resume guidance after a lost response on a generated ID %j', async ({ flags }) => {
  const h = await harness(); h.post((_req, res) => res.destroy());
  for (const args of [['submit', '--file', h.file], ['resume']]) {
    const r = await h.run([...args, '--no-retry', ...flags]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('The submission may have been saved. Retry safely with: nansen feedback resume.');
    expect(r.stdout).not.toMatch(/--submission-id|--file|may have been accepted/);
    if (flags.length) expect(JSON.parse(r.stdout)).toMatchObject({ code: 'submission_outcome_unknown',
      details: { outcome: 'unknown', retry_command: 'nansen feedback resume', submission_id: h.read().submission_id } });
  }
  expect(posts(h)).toHaveLength(2);
});

it.each([{ flags: [] }, { flags: ['--json'] }])('ends the server message with a full stop before the rejection advice %j', async ({ flags }) => {
  const h = await harness();
  h.post((_req, res) => reply(res, 422, { error: 'Validation Error', message: "Required field 'body -> description' is missing",
    code: 'missing_param', status: 422, errors: [{ field: 'body.description', code: 'missing_param' }] }));
  const r = await h.run(['submit', '--file', h.file, ...flags]);
  expect(r.code).toBe(1);
  expect(r.stdout).toContain("Required field 'body -> description' is missing. This attempt was rejected. Local retry data was erased.");
  if (flags.length) expect(JSON.parse(r.stdout)).toMatchObject({ code: 'missing_param', status: 422, details: { outcome: 'rejected' } });
  else expect(r.stdout).toContain('body.description: missing_param');
  expect(h.read()).toEqual({ version: 1, state: 'cleared' });
});

it.each([{ flags: [] }, { flags: ['--json'] }])('names a revoked key when the feedback account cannot be verified %j', async ({ flags }) => {
  const h = await harness(); await killedPending(h); const saved = h.read();
  const fresh = await harness();
  for (const [target, args] of [[h, ['resume']], [fresh, ['submit', '--file', fresh.file]]]) {
    const r = await target.run([...args, ...flags], { NANSEN_API_KEY: 'revoked-key' });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('Invalid API key. Manage your keys at https://app.nansen.ai/api?tab=api. Could not verify the feedback account. No report was sent. Use a valid API key or login for the original account, then retry.');
    expect(r.stdout).toContain('revoked-request'); expect(r.stdout).not.toContain('revoked-key');
    if (flags.length) expect(JSON.parse(r.stdout)).toMatchObject({ code: 'feedback_identity_unverified', status: 401, details: { request_id: 'revoked-request' } });
  }
  expect(h.read()).toEqual(saved); expect(posts(h)).toHaveLength(1);
  expect(fs.existsSync(fresh.journal)).toBe(false); expect(posts(fresh)).toHaveLength(0);
  const offline = await fresh.run(['submit', '--file', fresh.file, ...flags], { NANSEN_BASE_URL: 'http://127.0.0.1:1' });
  expect(offline.stdout).toContain('Could not verify the feedback account. No report was sent. Retry with the original account and NANSEN_BASE_URL.');
  expect(offline.stdout).not.toContain('Invalid API key');
});

it.each([{ flags: [] }, { flags: ['--json'] }])('does not blame the key when the feedback account is refused %j', async ({ flags }) => {
  const h = await harness(); await killedPending(h); const saved = h.read();
  const fresh = await harness();
  for (const [target, args] of [[h, ['resume']], [fresh, ['submit', '--file', fresh.file]]]) {
    const r = await target.run([...args, ...flags], { NANSEN_API_KEY: 'refused-account' });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("Account access is not permitted. Could not verify the feedback account. No report was sent. Check this account's access, then retry.");
    expect(r.stdout).toContain('refused-request'); expect(r.stdout).not.toMatch(/valid API key|refused-account/);
    if (flags.length) expect(JSON.parse(r.stdout)).toMatchObject({ code: 'feedback_identity_unverified', status: 403, details: { request_id: 'refused-request' } });
  }
  expect(h.read()).toEqual(saved); expect(posts(h)).toHaveLength(1);
  expect(fs.existsSync(fresh.journal)).toBe(false); expect(posts(fresh)).toHaveLength(0);
});
