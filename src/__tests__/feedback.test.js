import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { NansenAPI } from '../api.js';
import { buildFeedbackCommands, feedbackErrorText } from '../commands/feedback.js';
import { createAuthState } from '../auth-state.js';
import { createAuthStore } from '../auth-store.js';
import { resolveCredential, AuthError } from '../auth-credentials.js';
import { memoryOperation, sessionFixture } from './fixtures/auth-fixture.js';

const examples = JSON.parse(fs.readFileSync(new URL('./fixtures/feedback-v1.json', import.meta.url)));
const root = fileURLToPath(new URL('../../', import.meta.url));
const dirs = [], servers = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))));
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function harness(responses, { keySource = 'env' } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-cli-')); dirs.push(home);
  fs.mkdirSync(path.join(home, '.nansen'), { mode: 0o700 });
  fs.writeFileSync(path.join(home, '.nansen/config.json'), JSON.stringify(keySource === 'config' ? { apiKey: 'synthetic-key' } : {}), { mode: 0o600 });
  const file = path.join(home, 'report.json');
  const body = JSON.stringify({ ...examples.accepted.request.body, workaround: null }, null, 2);
  fs.writeFileSync(file, body);
  const eventFile = path.join(home, 'events.jsonl');
  const capture = path.join(home, 'capture.cjs');
  fs.writeFileSync(capture, `const real = globalThis.fetch; globalThis.fetch = async (url, options) => {
    if (new URL(url).hostname === 'bi-data-sources.nansen.ai') {
      require('node:fs').appendFileSync(${JSON.stringify(eventFile)}, options.body + '\\n');
      return new Response('{}');
    }
    return real(url, options);
  };`);
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({ path: req.url, headers: req.headers, method: req.method, body, at: Date.now() });
    const response = responses[Math.min(requests.length - 1, responses.length - 1)];
    if (response === 'disconnect') { req.socket.destroy(); return; }
    res.writeHead(response.status, { 'Content-Type': 'application/json', ...response.headers });
    res.end(response.raw ?? JSON.stringify(response.body));
  });
  servers.push(server);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const run = (args, extraEnv = {}) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'src/index.js'), 'feedback', ...args], {
      cwd: root, env: { PATH: process.env.PATH, HOME: home, NANSEN_API_KEY: keySource === 'env' ? 'synthetic-key' : '',
        NANSEN_BASE_URL: `http://127.0.0.1:${server.address().port}`, NANSEN_NO_TELEMETRY: '1', NO_UPDATE_NOTIFIER: '1', ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
    const timer = setTimeout(() => { child.kill(); reject(new Error('CLI fixture timed out')); }, 10000);
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  return { run, requests, home, file, body, eventFile, capture, submit: ['submit', '--file', file, '--submission-id', examples.accepted.request.headers['Idempotency-Key']] };
}

it.each(['env', 'config'])('submits exact file bytes with selected %s key and no cache/payment', async keySource => {
  const h = await harness([examples.accepted], { keySource });
  for (let i = 0; i < 2; i++) {
    const result = await h.run([...h.submit, '--json', '--cache', '--paginate', '--table', '--stream', '--format', 'csv', '--fields', 'feedback_id']);
    expect(result.code).toBe(0); expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({ success: true, data: examples.accepted.body });
  }
  expect(h.requests).toHaveLength(2);
  for (const req of h.requests) {
    expect(req.path).toBe('/api/v1/feedback'); expect(req.method).toBe('POST');
    expect(req.body).toBe(h.body); expect(req.headers.apikey).toBe('synthetic-key');
    expect(req.headers.authorization).toBeUndefined(); expect(req.headers['payment-signature']).toBeUndefined();
    expect(req.headers['idempotency-key']).toBe(examples.accepted.body.submission_id);
  }
  expect(fs.existsSync(path.join(h.home, '.nansen/cache'))).toBe(false);
});

it('replays unchanged bytes and ID after a lost response with exhausted quota', async () => {
  const h = await harness(['disconnect', examples.replayed]);
  const result = await h.run([...h.submit, '--json']);
  expect(result.code).toBe(0); expect(JSON.parse(result.stdout).data).toEqual(examples.replayed.body);
  expect(h.requests).toHaveLength(2);
  expect(h.requests[1].body).toBe(h.requests[0].body);
  expect(h.requests[1].headers['idempotency-key']).toBe(h.requests[0].headers['idempotency-key']);
});

it('honors temporary Retry-After without changing payload or ID', async () => {
  const h = await harness([examples.throttled, examples.accepted]);
  expect((await h.run([...h.submit, '--json'])).code).toBe(0);
  expect(h.requests).toHaveLength(2);
  expect(h.requests[1].at - h.requests[0].at).toBeGreaterThanOrEqual(1950);
  expect(h.requests.map(r => r.body)).toEqual([h.body, h.body]);
  expect(new Set(h.requests.map(r => r.headers['idempotency-key'])).size).toBe(1);
});

it.each(['weekly_limit', 'conflict', 'denied'])('preserves structured %s errors and exits once', async scenario => {
  const h = await harness([examples[scenario]]);
  const result = await h.run([...h.submit, '--json']);
  expect(result.code).toBe(1); expect(result.stderr).toBe(''); expect(h.requests).toHaveLength(1);
  const error = JSON.parse(result.stdout);
  expect(error.details).toMatchObject({ ...examples[scenario].body, submission_id: examples.accepted.body.submission_id });
  expect(result.stdout).not.toContain('synthetic-key');
});

it('preserves every sanitized field error from the real validation envelope', async () => {
  const errors = [{ field: 'body.endpoint', code: 'value_out_of_range' }, { field: 'body.severity', code: 'unknown_field' }];
  const h = await harness([{ status: 422, body: { error: 'Validation Error', message: 'Invalid value for endpoint.',
    code: 'value_out_of_range', status: 422, param: 'endpoint', errors } }]);
  const result = await h.run([...h.submit, '--json']);
  expect(result.code).toBe(1); expect(JSON.parse(result.stdout).details.errors).toEqual(errors);
  const human = await h.run(h.submit);
  expect(human.code).toBe(1);
  for (const { field, code } of errors) expect(human.stdout).toContain(`${field}: ${code}`);
});

it('recognizes the gateway message-only auth error and its request ID', async () => {
  const h = await harness([{ status: 401, headers: { 'X-Kong-Request-Id': 'gateway-request-id' },
    body: { message: 'Invalid API key. Manage your keys at https://app.nansen.ai/api?tab=api' } }]);
  const result = await h.run([...h.submit, '--json']);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({ code: 'UNAUTHORIZED', status: 401,
    details: { request_id: 'gateway-request-id', submission_id: examples.accepted.body.submission_id } });
  expect(h.requests).toHaveLength(1);
});

it('keeps the pending submission ID when the gateway rejects a retry after a lost response', async () => {
  const h = await harness(['disconnect', { status: 401, headers: { 'X-Kong-Request-Id': 'retry-auth-id' }, body: { message: 'Invalid API key.' } }]);
  const result = await h.run([...h.submit, '--json']);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({ code: 'submission_outcome_unknown', status: 401,
    details: { submission_id: examples.accepted.body.submission_id, reason: 'submission_outcome_unknown', request_id: 'retry-auth-id' } });
  expect(result.stdout).toContain('may have been saved');
  expect(h.requests).toHaveLength(2);
  expect(h.requests[1].body).toBe(h.requests[0].body);
});

it('stops promptly on weekly exhaustion and shows reset and request/submission IDs', async () => {
  const h = await harness([examples.weekly_limit]);
  const started = Date.now(); const result = await h.run(h.submit);
  expect(result.code).toBe(1); expect(Date.now() - started).toBeLessThan(2500);
  expect(h.requests).toHaveLength(1);
  for (const value of [examples.weekly_limit.body.quota.resets_at, examples.weekly_limit.body.request_id, examples.accepted.body.submission_id]) expect(result.stdout).toContain(value);
});

it.each([examples.route_unavailable_zero_credit, { status: 402, body: { paymentRequirements: { accepts: [] } } }, { ...examples.not_found, body: { ...examples.not_found.body, message: 'Not Found' } }])('reports unavailable capability without fallback for HTTP $status', async response => {
  const h = await harness([response]);
  const result = await h.run([...h.submit, '--json']);
  expect(result.code).toBe(1); expect(JSON.parse(result.stdout).code).toBe('feedback_unavailable');
  expect(h.requests).toHaveLength(1); expect(result.stdout).not.toMatch(/top up|fund|wallet create/);
});

// The real wrapper's not_found_handler emits problem(message='Not Found'),
// without detail. Source: nansen-api cc0b5c593 wrapper/error_handlers.py:1383.
it.each(['Not Found', examples.not_found.body.message])('gives actionable GET 404 guidance for the real producer message %s', async message => {
  const response = { ...examples.not_found, body: { ...examples.not_found.body, message } };
  const h = await harness([response]);
  for (const flags of [[], ['--json']]) {
    const result = await h.run(['get', examples.accepted.body.feedback_id, ...flags]);
    expect(result.code).toBe(1); expect(result.stderr).toBe('');
    expect(result.stdout).toContain('this backend does not support feedback yet');
    expect(result.stdout).toContain('active account'); expect(result.stdout).toContain('Do not resubmit as a new report');
    expect(result.stdout).toContain(response.body.request_id);
    if (flags.length) expect(JSON.parse(result.stdout)).toMatchObject({ code: 'not_found', status: 404, details: response.body });
  }
  expect(h.requests).toHaveLength(2);
  expect(h.requests.every(r => r.method === 'GET')).toBe(true);
});

it('reports outcome uncertainty after retries and never echoes unreadable response bodies', async () => {
  const h = await harness([{ status: 201, raw: 'synthetic-key secret report body' }]);
  const result = await h.run([...h.submit, '--json', '--no-retry']);
  expect(result.code).toBe(1); expect(h.requests).toHaveLength(1);
  expect(JSON.parse(result.stdout).details).toMatchObject({ reason: 'submission_outcome_unknown', submission_id: examples.accepted.body.submission_id });
  expect(result.stdout).not.toContain('synthetic-key'); expect(result.stdout).not.toContain('secret report body');
});

it.each(['accepted', 'receipt_reviewed', 'receipt_closed'])('distinguishes %s in human output', async scenario => {
  const h = await harness([examples[scenario]]);
  const result = await h.run(scenario === 'accepted' ? h.submit : ['get', examples[scenario].body.feedback_id, '--cache']);
  expect(result.code).toBe(0); expect(result.stderr).toBe('');
  expect(result.stdout).toContain({ accepted: 'Received.', receipt_reviewed: 'Reviewed.', receipt_closed: 'Closed.' }[scenario]);
  expect(result.stdout).toContain(examples.accepted.body.submission_id);
  if (scenario !== 'accepted') { expect(h.requests[0].method).toBe('GET'); expect(h.requests[0].body).toBe(''); }
});

it('reads fresh receipt state and encodes the feedback ID as one path segment', async () => {
  const h = await harness([examples.receipt_reviewed, examples.receipt_closed]);
  for (const response of [examples.receipt_reviewed, examples.receipt_closed]) {
    const result = await h.run(['get', response.body.feedback_id, '--json', '--cache']);
    expect(JSON.parse(result.stdout).data).toEqual(response.body);
  }
  await h.run(['get', 'fb/other?x=y', '--json']);
  expect(h.requests[2].path).toBe('/api/v1/feedback/fb%2Fother%3Fx%3Dy');
  expect(fs.existsSync(path.join(h.home, '.nansen/cache'))).toBe(false);
});

it.each([['submit'], ['submit', '--submission-id', 'bad id'], ['submit', '--submission-id', 'id', '--file', '/missing'], ['get']])('rejects invalid invocation %j before sending', async args => {
  const h = await harness([examples.accepted]);
  expect((await h.run([...args, '--json'])).code).toBe(1); expect(h.requests).toHaveLength(0);
});

it('rejects payment signatures and anonymous access before sending', async () => {
  const h = await harness([examples.accepted]);
  expect((await h.run([...h.submit, '--json', '--x402-payment-signature', 'synthetic-signature'])).code).toBe(1);
  expect((await h.run([...h.submit, '--json'], { NANSEN_API_KEY: '' })).code).toBe(1);
  expect(h.requests).toHaveLength(0);
});

it('rejects extra submit arguments with a valid file and ID before sending', async () => {
  const h = await harness([examples.accepted]);
  const result = await h.run([...h.submit, 'accidental-report.json', '--json']);
  expect(result.code).toBe(1); expect(JSON.parse(result.stdout).code).toBe('INVALID_PARAMS');
  expect(h.requests).toHaveLength(0);
});

it('keeps command telemetry truthful without report content, IDs or credentials', async () => {
  const h = await harness([examples.accepted, examples.weekly_limit]);
  const env = { NANSEN_NO_TELEMETRY: '0', NODE_OPTIONS: `--require=${h.capture}` };
  await h.run([...h.submit, '--json', '--cache'], env);
  await h.run([...h.submit, '--json'], env);
  const events = fs.readFileSync(h.eventFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(events.map(e => e.event)).toEqual(['cli_command_succeeded', 'cli_command_failed']);
  expect(events[0].properties.from_cache).toBe(false);
  expect(events[1].properties).toMatchObject({ error_code: 'rate_limit_exceeded', status: 429 });
  for (const event of events) expect(event.path).toBe('/feedback/submit');
  for (const secret of ['synthetic-key', examples.accepted.body.submission_id, examples.accepted.request.body.description, h.file]) expect(JSON.stringify(events)).not.toContain(secret);
});

it.each(['Private report text about wallet 0xabc123', 'fb_private_receipt_id', '/private/reports/feedback.json'])('keeps malformed feedback argument %s out of telemetry', async argument => {
  const h = await harness([examples.accepted]);
  const result = await h.run([argument, '--json'], { NANSEN_NO_TELEMETRY: '0', NODE_OPTIONS: `--require=${h.capture}` });
  expect(result.code).toBe(1); expect(h.requests).toHaveLength(0);
  const events = fs.readFileSync(h.eventFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ event: 'cli_command_failed', path: '/feedback' });
  expect(JSON.stringify(events)).not.toContain(argument);
});

it.each([false, true])('preserves authentication guidance and uncertain outcome after a lost response: %s', async lostResponse => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-session-retry-')); dirs.push(home);
  let now = Date.now();
  const bundle = sessionFixture({ now: now - 3500000 });
  if (!lostResponse) now = bundle.expiresAt - 30000;
  const refresh = vi.fn(async () => {
    throw Object.assign(new AuthError('SESSION_REFRESH_RETRYABLE', 'Session renewal was refused. Run nansen login.'), { retryNotBefore: now + 1000 });
  });
  const state = createAuthState({ directory: path.join(home, '.nansen'), store: createAuthStore(memoryOperation()), now: () => now, refresh });
  const attempt = await state.begin(); await state.install(attempt, { bundle, baseUrl: bundle.audience }); await state.finish(attempt);
  const api = new NansenAPI(undefined, bundle.audience, { credential: resolveCredential({ env: { HOME: home } }), authState: state, retry: { baseDelayMs: 0 } });
  const file = path.join(home, 'report.json'); fs.writeFileSync(file, JSON.stringify(examples.accepted.request.body));
  const fetch = vi.fn(async () => { now = bundle.expiresAt - 30000; throw new TypeError('Lost response'); });
  vi.stubGlobal('fetch', fetch);
  let error;
  try { await buildFeedbackCommands().feedback(['submit'], api, { json: true }, { file, 'submission-id': 'retry-after-login' }); } catch (caught) { error = caught; }
  expect(refresh).toHaveBeenCalledOnce(); expect(fetch).toHaveBeenCalledTimes(lostResponse ? 1 : 0);
  expect(error.message).toContain('nansen login');
  if (lostResponse) {
    expect(error).toMatchObject({ code: 'submission_outcome_unknown', details: { reason: 'submission_outcome_unknown', submission_id: 'retry-after-login' } });
    expect(feedbackErrorText(error)).toContain('may have been saved');
    expect(feedbackErrorText(error)).toContain('unchanged --file');
  } else expect(error.code).toBe('SESSION_REFRESH_RETRYABLE');
  for (const secret of [bundle.accessToken, bundle.refreshToken, bundle.privateJwk.d]) expect(JSON.stringify(error)).not.toContain(secret);
});

it('uses the saved browser account on retries and preserves structured quota errors without exposing custody', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-session-')); dirs.push(home);
  const state = createAuthState({ directory: path.join(home, '.nansen'), store: createAuthStore(memoryOperation()) });
  const bundle = sessionFixture(); const attempt = await state.begin();
  await state.install(attempt, { bundle, baseUrl: bundle.audience }); await state.finish(attempt);
  const api = new NansenAPI(undefined, bundle.audience, { credential: resolveCredential({ env: { HOME: home } }), authState: state, retry: { baseDelayMs: 0 } });
  const file = path.join(home, 'report.json'); fs.writeFileSync(file, JSON.stringify(examples.accepted.request.body));
  const responses = [examples.admissions_paused, { ...examples.weekly_limit, body: { ...examples.weekly_limit.body, message: `Rejected ${bundle.accessToken}`, detail: bundle.refreshToken } }];
  const fetch = vi.fn(async () => { const f = responses.shift(); return new Response(JSON.stringify(f.body), { status: f.status, headers: { ...f.headers, 'Retry-After': '0' } }); });
  vi.stubGlobal('fetch', fetch);
  let error;
  try { await buildFeedbackCommands().feedback(['submit'], api, { json: true }, { file, 'submission-id': examples.accepted.body.submission_id }); } catch (caught) { error = caught; }
  expect(error.details.quota).toEqual(examples.weekly_limit.body.quota);
  expect(fetch).toHaveBeenCalledTimes(2);
  for (const [,options] of fetch.mock.calls) {
    expect(options.headers.Authorization).toBe(`Bearer ${bundle.accessToken}`); expect(options.headers.apikey).toBeUndefined();
    expect(options.redirect).toBe('error'); expect(options.cache).toBe('no-store');
  }
  expect(fetch.mock.calls[0][1].body).toBe(fetch.mock.calls[1][1].body);
  for (const secret of [bundle.accessToken, bundle.refreshToken, bundle.privateJwk.d]) expect(JSON.stringify(error)).not.toContain(secret);
});
