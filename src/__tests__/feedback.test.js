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

it.each([{ flags: [] }, { flags: ['--json'] }])('reports an HTML edge block as a rejection in output %j', async ({ flags }) => {
  const h = await harness([{ status: 403, headers: { 'Content-Type': 'text/html', Server: 'cloudflare' },
    raw: '<html>Blocked synthetic-key secret report body</html>' }]);
  const r = await h.run([...h.submit, ...flags]);
  expect(r.code).toBe(1); expect(r.stderr).toBe(''); expect(h.requests).toHaveLength(1);
  expect(r.stdout).toContain('blocked before reaching Nansen');
  expect(r.stdout).toContain('No report was saved'); expect(r.stdout).toContain('new submission ID');
  expect(r.stdout).not.toContain('may have been saved');
  expect(r.stdout).not.toContain('synthetic-key'); expect(r.stdout).not.toContain('secret report body');
  if (flags.length) expect(JSON.parse(r.stdout)).toMatchObject({ code: 'feedback_blocked', status: 403,
    details: { reason: 'feedback_blocked', outcome: 'rejected', submission_id: examples.accepted.body.submission_id } });
});

it.each([{ flags: [] }, { flags: ['--json'] }])('preserves uncertainty when an earlier response was lost before an edge block %j', async ({ flags }) => {
  const h = await harness(['disconnect', { status: 403, headers: { 'Content-Type': 'text/html' }, raw: '<html>Blocked</html>' }]);
  const r = await h.run([...h.submit, ...flags]);
  expect(r.code).toBe(1); expect(h.requests).toHaveLength(2);
  expect(r.stdout).toContain('may have been saved'); expect(r.stdout).not.toContain('No report was saved');
  expect(r.stdout).not.toContain('new submission ID');
  if (flags.length) expect(JSON.parse(r.stdout)).toMatchObject({ code: 'submission_outcome_unknown', details: { outcome: 'unknown' } });
});

it.each([{ flags: [] }, { flags: ['--json'] }])('keeps the outcome unknown after a JSON 500 then an edge block %j', async ({ flags }) => {
  const h = await harness([{ status: 500, body: { code: 'internal_error', message: 'Storage unconfirmed' } },
    { status: 403, headers: { 'Content-Type': 'text/html' }, raw: '<html>Blocked</html>' }]);
  const r = await h.run([...h.submit, ...flags]);
  expect(r.code).toBe(1); expect(r.stdout).toContain('may have been saved');
  expect(r.stdout).not.toContain('No report was saved'); expect(h.requests).toHaveLength(2);
  if (flags.length) expect(JSON.parse(r.stdout)).toMatchObject({ code: 'submission_outcome_unknown', details: { outcome: 'unknown' } });
});

it.each([{ flags: [] }, { flags: ['--json'] }])('removes uncertainty from erased caller-managed submissions %j', async ({ flags }) => {
  const h = await harness(['disconnect', { status: 409, body: { code: 'conflict', reason: 'feedback_erased',
    message: 'The report for this submission ID was erased and will not be saved again.' } }]);
  const r = await h.run([...h.submit, '--retries', '1', ...flags]);
  expect(r.code).toBe(1); expect(r.stdout).toContain('was erased');
  expect(r.stdout).not.toMatch(/may have been (accepted|saved)/); expect(h.requests).toHaveLength(2);
  if (flags.length) {
    const error = JSON.parse(r.stdout);
    expect(error).toMatchObject({ code: 'conflict', status: 409, details: { reason: 'feedback_erased' } });
    expect(error.details.outcome).toBeUndefined();
  }
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

it('asks for the feedback ID on get without submission recovery advice', async () => {
  const h = await harness([examples.accepted]);
  for (const flags of [[], ['--json']]) {
    const r = await h.run(['get', ...flags]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('Feedback ID is required. Use: nansen feedback get <feedback-id> [--json].');
    expect(r.stdout).not.toMatch(/submission ID|uncertain/);
  }
  const submit = await h.run(['submit', '--json']);
  expect(submit.stdout).toContain('Reuse the submission ID and unchanged file after an uncertain submission result.');
  expect(h.requests).toHaveLength(0);
});

it('traces feedback requests to stderr with --debug, without credentials or report text', async () => {
  const h = await harness(['disconnect', examples.accepted]);
  const r = await h.run([...h.submit, '--json', '--debug']);
  expect(r.code).toBe(0); expect(JSON.parse(r.stdout).data).toEqual(examples.accepted.body);
  const url = `url=http://${h.requests[0].headers.host}/api/v1/feedback`;
  const lines = r.stderr.trim().split('\n');
  expect(lines[0]).toBe(`[nansen:debug] http.request method=POST ${url} attempt=1/4`);
  expect(lines.some(line => line.startsWith(`[nansen:debug] http.error method=POST ${url}`))).toBe(true);
  expect(lines.some(line => line.startsWith(`[nansen:debug] http.retry method=POST ${url} attempt=1 reason=network-error`))).toBe(true);
  expect(lines.some(line => line.startsWith(`[nansen:debug] http.response method=POST ${url} status=201`))).toBe(true);
  for (const secret of ['synthetic-key', examples.accepted.request.body.description]) expect(r.stderr).not.toContain(secret);
  expect((await h.run([...h.submit, '--json'])).stderr).toBe('');
});

it('traces a rejected credential header without the credential', async () => {
  const key = 'synthetic-header-key';
  const h = await harness([examples.accepted]);
  for (const [args, method] of [[['preferences'], 'GET'], [h.submit, 'POST'], [['submit', '--file', h.file], 'GET']]) {
    const r = await h.run([...args, '--json', '--debug', '--no-retry'], { NANSEN_API_KEY: `${key}\ncopied text` });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(new RegExp(`http\\.error method=${method} url=\\S+ duration_ms=\\d+ attempt=1 error=TypeError`));
    expect(r.stdout + r.stderr).not.toContain(key);
  }
  expect(h.requests).toHaveLength(0);
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
  const h = await harness([examples.accepted, examples.weekly_limit,
    { status: 403, headers: { 'Content-Type': 'text/html' }, raw: '<html>Blocked</html>' }]);
  const env = { NANSEN_NO_TELEMETRY: '0', NODE_OPTIONS: `--require=${h.capture}` };
  await h.run([...h.submit, '--json', '--cache'], env);
  await h.run([...h.submit, '--json'], env);
  await h.run([...h.submit, '--json'], env);
  const events = fs.readFileSync(h.eventFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(events.map(e => e.event)).toEqual(['cli_command_succeeded', 'cli_command_failed', 'cli_command_failed']);
  expect(events[0].properties.from_cache).toBe(false);
  expect(events[1].properties).toMatchObject({ error_code: 'rate_limit_exceeded', status: 429 });
  expect(events[2].properties).toMatchObject({ error_code: 'feedback_blocked', status: 403 });
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

const preference = { automatic_reporting: 'enabled', configured: true, version: 1, updated_at: '2026-10-15T12:00:00Z', can_manage: true };
it('reads fresh account preferences in human and JSON output without caching, payments, or submission', async () => {
  const disabled = { ...preference, automatic_reporting: 'disabled', version: 2 };
  const h = await harness([{ status: 200, body: preference }, { status: 200, body: disabled }]);
  const first = await h.run(['preferences', '--json', '--cache', '--paginate']);
  expect(first.code).toBe(0); expect(JSON.parse(first.stdout).data).toEqual(preference);
  const next = await h.run(['preferences']);
  expect(next.code).toBe(0); expect(next.stdout).toContain('disabled'); expect(next.stdout).toContain('ask before sending');
  expect(h.requests).toHaveLength(2);
  for (const req of h.requests) {
    expect(req).toMatchObject({ path: '/api/v1/feedback/preferences', method: 'GET', body: '' });
    expect(req.headers.apikey).toBe('synthetic-key'); expect(req.headers['idempotency-key']).toBeUndefined();
    expect(req.headers['payment-signature']).toBeUndefined();
  }
  expect(fs.existsSync(path.join(h.home, '.nansen/cache'))).toBe(false);
  expect(fs.existsSync(path.join(h.home, '.nansen/feedback'))).toBe(false);
});
it.each([
  { automatic_reporting: 'disabled', configured: false, version: 0, updated_at: null, can_manage: false },
  { ...preference, automatic_reporting: 'disabled' },
])('reports disabled or unconfigured preferences without submitting', async body => {
  const h = await harness([{ status: 200, body }]);
  const r = await h.run(['preferences']); expect(r.code).toBe(0); expect(r.stdout).toContain('ask before sending');
  expect(h.requests).toHaveLength(1);
});
it.each([
  { status: 200, body: {} }, { status: 200, body: { ...preference, configured: false } },
  { status: 200, body: { ...preference, automatic_reporting: 'unknown' } },
  { status: 503, body: { code: 'upstream_unavailable', reason: 'preference_store_unavailable' } },
  { status: 404, body: { code: 'not_found' } },
])('fails closed on unavailable or invalid preference $status', async response => {
  const h = await harness([response]);
  for (const flags of [[], ['--json']]) {
    const r = await h.run(['preferences', '--no-retry', ...flags]);
    expect(r.code).toBe(1); expect(r.stdout).toContain('Feedback preference unavailable. Show the report and ask before sending.');
    if (flags.length) expect(JSON.parse(r.stdout)).toMatchObject({ success: false, details: { reason: 'preference_unavailable' } });
  }
  expect(h.requests).toHaveLength(2); expect(h.requests.every(r => r.method === 'GET')).toBe(true);
});

it.each([{ flags: [] }, { flags: ['--json'] }])('keeps ask-first guidance after all preference retries %j', async ({ flags }) => {
  const h = await harness([{ status: 503, body: { message: 'Service Unavailable' } }]);
  const r = await h.run(['preferences', ...flags]);
  expect(r.code).toBe(1); expect(h.requests).toHaveLength(4);
  expect(r.stdout).toContain('Feedback preference unavailable. Show the report and ask before sending.');
  if (flags.length) expect(JSON.parse(r.stdout)).toMatchObject({ code: 'SERVICE_UNAVAILABLE', status: 503,
    details: { reason: 'preference_unavailable' } });
});

it.each([401, 403])('adds preference guidance while preserving HTTP %s diagnostics', async status => {
  const h = await harness([{ status, headers: { 'X-Request-Id': 'preference-denied' }, body: { code: 'forbidden', message: 'Denied' } }]);
  for (const flags of [[], ['--json']]) {
    const r = await h.run(['preferences', ...flags]);
    expect(r.code).toBe(1); expect(r.stdout).toContain('Show the report and ask before sending.');
    if (flags.length) expect(JSON.parse(r.stdout)).toMatchObject({ code: 'forbidden', status,
      details: { reason: 'preference_unavailable', request_id: 'preference-denied' } });
  }
  expect(h.requests).toHaveLength(2);
});

it('keeps local preference recovery guidance when not logged in', async () => {
  const h = await harness([{ status: 200, body: preference }]);
  for (const flags of [[], ['--json']]) {
    const r = await h.run(['preferences', ...flags], { NANSEN_API_KEY: '' });
    expect(r.code).toBe(1); expect(r.stdout).toContain('Show the report and ask before sending.');
    expect(r.stdout).toContain('nansen login');
    if (flags.length) expect(JSON.parse(r.stdout).details.reason).toBe('preference_unavailable');
  }
  expect(h.requests).toHaveLength(0);
});

it('reports a payment signature on a preference read as a usage error, not an unavailable preference', async () => {
  const h = await harness([{ status: 200, body: preference }]);
  for (const flags of [[], ['--json']]) {
    const r = await h.run(['preferences', '--x402-payment-signature', 'synthetic-signature', ...flags]);
    expect(r.code).toBe(1); expect(r.stdout).toContain('Feedback uses account authentication only. Remove --x402-payment-signature.');
    expect(r.stdout).not.toContain('preference unavailable');
    if (flags.length) {
      const error = JSON.parse(r.stdout);
      expect(error.code).toBe('INVALID_PARAMS'); expect(error.details?.reason).toBeUndefined();
    }
  }
  expect(h.requests).toHaveLength(0);
});

it('names the rejected key on a preference read in human and JSON output', async () => {
  const h = await harness([{ status: 401, headers: { 'X-Kong-Request-Id': 'preference-key' },
    body: { message: 'Invalid API key. Manage your keys at https://app.nansen.ai/api?tab=api' } }]);
  for (const flags of [[], ['--json']]) {
    const r = await h.run(['preferences', ...flags]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('Feedback preference unavailable. Show the report and ask before sending. Invalid API key.');
    expect(r.stdout).toContain('preference-key');
    if (flags.length) expect(JSON.parse(r.stdout)).toMatchObject({ code: 'UNAUTHORIZED', status: 401,
      details: { reason: 'preference_unavailable', request_id: 'preference-key' } });
  }
  expect(h.requests).toHaveLength(2);
});
it.each([['preferences', 'enable'], ['preferences', '--file', 'report.json'], ['preferences', '--new']])('rejects preference mutations %j before sending', async args => {
  const h = await harness([{ status: 200, body: preference }]);
  expect((await h.run([...args, '--json'])).code).toBe(1); expect(h.requests).toHaveLength(0);
});
it('stops on account rollout denial and preserves an earlier lost-response outcome', async () => {
  const denial = { status: 403, body: { code: 'forbidden', reason: 'feedback_not_enabled', message: 'Feedback is not enabled.' } };
  for (const lost of [false, true]) {
    const h = await harness(lost ? ['disconnect', denial] : [denial]);
    const r = await h.run([...h.submit, '--json']); const error = JSON.parse(r.stdout);
    expect(error.code).toBe(lost ? 'submission_outcome_unknown' : 'forbidden');
    expect(error.details).toMatchObject({ reason: 'feedback_not_enabled', outcome: lost ? 'unknown' : 'rejected' });
    expect(r.stdout).toContain('Stop automatic retries'); expect(h.requests).toHaveLength(lost ? 2 : 1);
  }
});
it('keeps existing telemetry accurate for preference reads without recording preference values', async () => {
  const h = await harness([{ status: 200, body: preference }]);
  await h.run(['preferences', '--json', '--cache'], { NANSEN_NO_TELEMETRY: '0', NODE_OPTIONS: `--require=${h.capture}` });
  const event = JSON.parse(fs.readFileSync(h.eventFile, 'utf8').trim());
  expect(event).toMatchObject({ event: 'cli_command_succeeded', path: '/feedback', properties: { from_cache: false } });
  expect(JSON.stringify(event)).not.toContain('automatic_reporting');
});

it('rejects a preference response when reading a receipt with the reserved ID', async () => {
  const h = await harness([{ status: 200, body: preference }]);
  for (const mode of [[], ['--json']]) {
    const r = await h.run(['get', 'preferences', '--no-retry', ...mode]);
    expect(r.code).toBe(1); expect(r.stdout).toContain('Receipt lookup failed');
    expect(r.stdout).not.toContain('undefined'); expect(r.stdout).not.toContain('automatic_reporting');
  }
  expect(h.requests).toHaveLength(2);
  expect(h.requests.every(r => r.method === 'GET' && r.path === '/api/v1/feedback/preferences')).toBe(true);
});
it('keeps the human uncertainty warning and original ID after a rollout denial on a retry', async () => {
  const h = await harness(['disconnect', { status: 403, body: { code: 'forbidden', reason: 'feedback_not_enabled' } }]);
  const r = await h.run(h.submit);
  expect(r.code).toBe(1); expect(r.stdout).toContain('Stop automatic retries');
  expect(r.stdout).toContain('may have been saved'); expect(r.stdout).toContain('unchanged --file');
  expect(r.stdout).toContain(examples.accepted.body.submission_id);
  expect(h.requests).toHaveLength(2);
  expect(h.requests[0].headers['idempotency-key']).toBe(h.requests[1].headers['idempotency-key']);
});

it.each([
  { status: 500, reason: 'internal_error', outcome: 'unknown' },
  { status: 503, reason: 'feedback_store_unavailable', outcome: 'unknown' },
  { status: 503, reason: 'feedback_admissions_paused', outcome: 'rejected' },
])('preserves $outcome after HTTP $status $reason then rollout denial', async ({ status, reason, outcome }) => {
  for (const flags of [[], ['--json']]) {
    const h = await harness([
      { status, headers: { 'Retry-After': '0' }, body: { code: 'upstream_unavailable', reason } },
      { status: 403, body: { code: 'forbidden', reason: 'feedback_not_enabled' } },
    ]);
    const r = await h.run([...h.submit, ...flags]);
    expect(r.code).toBe(1); expect(r.stdout).toContain('Stop automatic retries');
    if (flags.length) expect(JSON.parse(r.stdout)).toMatchObject({
      code: outcome === 'unknown' ? 'submission_outcome_unknown' : 'forbidden',
      details: { outcome, reason: 'feedback_not_enabled', submission_id: examples.accepted.body.submission_id },
    });
    if (outcome === 'unknown') expect(r.stdout).toContain('may have been saved');
    else expect(r.stdout).not.toContain('may have been saved');
    expect(h.requests).toHaveLength(2);
    expect(h.requests[0].body).toBe(h.requests[1].body);
    expect(h.requests[0].headers['idempotency-key']).toBe(h.requests[1].headers['idempotency-key']);
  }
});

it.each([{ flags: [] }, { flags: ['--no-retry'] }])('reports a terminal HTTP 5xx as unknown with retry flags $flags', async ({ flags }) => {
  const h = await harness([{ status: 503, headers: { 'Retry-After': '0' },
    body: { code: 'upstream_unavailable', reason: 'feedback_store_unavailable', request_id: 'uncertain-commit' } }]);
  const r = await h.run([...h.submit, '--json', '--retries', '1', ...flags]);
  expect(r.code).toBe(1);
  expect(JSON.parse(r.stdout)).toMatchObject({ code: 'submission_outcome_unknown', status: 503,
    details: { outcome: 'unknown', reason: 'feedback_store_unavailable', request_id: 'uncertain-commit', submission_id: examples.accepted.body.submission_id } });
  expect(r.stdout).toContain('may have been saved');
  expect(h.requests).toHaveLength(flags.length ? 1 : 2);
  expect(new Set(h.requests.map(r => r.headers['idempotency-key'])).size).toBe(1);
  expect(new Set(h.requests.map(r => r.body)).size).toBe(1);
});
