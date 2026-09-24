import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';

const children = [], servers = [], directories = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close'); child.kill('SIGKILL'); await closed;
    }
  }
  for (const server of servers.splice(0)) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

async function fixture(status = 200) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stdin-login-')); directories.push(home);
  const directory = path.join(home, '.nansen'); fs.mkdirSync(directory, { mode: 0o700 });
  const file = path.join(directory, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ apiKey: 'example-previous-key' }), { mode: 0o600 });
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, headers: request.headers });
    response.writeHead(status, { 'content-type': 'application/json', 'x-request-id': 'example-piped-key' });
    response.end(JSON.stringify({ plan: 'example-piped-key', credits_remaining: 'example-piped-key', message: 'example-piped-key' }));
  });
  servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  async function run(args = [], input = 'example-piped-key\n') {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../index.js', import.meta.url)), 'login', '--api-key-stdin', ...args], {
      env: { ...process.env, HOME: home, USERPROFILE: home, NANSEN_BASE_URL: baseUrl, NANSEN_API_KEY: 'example-environment-key', NANSEN_NO_TELEMETRY: '1', NANSEN_DEBUG: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    children.push(child);
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    const closed = once(child, 'close'); child.stdin.end(input);
    const [code] = await closed;
    expect(stdout + stderr).not.toContain('example-piped-key');
    expect(stdout + stderr).not.toContain('example-environment-key');
    return { code, stdout, stderr };
  }
  return { file, requests, run };
}

it.each([{ args: [] }, { args: ['--json'] }])('runs the executable against a local account API with protected persistence: $args', async ({ args }) => {
  const f = await fixture(); const result = await f.run(args);
  expect(result.code).toBe(0);
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0]).toMatchObject({ method: 'GET', url: '/api/v1/account', headers: { apikey: 'example-piped-key' } });
  expect(f.requests[0].headers['payment-signature']).toBeUndefined();
  expect(JSON.parse(fs.readFileSync(f.file))).toMatchObject({ apiKey: 'example-piped-key', auth: { active: { kind: 'api-key' } } });
  if (process.platform !== 'win32') expect(fs.statSync(f.file).mode & 0o777).toBe(0o600);
  if (args.includes('--json')) expect(JSON.parse(result.stdout)).toMatchObject({ event: 'saved', effective_source: 'env', cleanup: [] });
  else expect(result.stdout).toContain('Commands still use NANSEN_API_KEY');
  expect(result.stderr).toContain('http.response');
});

it.each([401, 402, 403])('failed executable verification (%s) preserves the previous key without paying or reflecting secrets', async status => {
  const f = await fixture(status); const before = fs.readFileSync(f.file, 'utf8');
  const result = await f.run(['--json']);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({ success: false, code: status === 401 ? 'INVALID_API_KEY' : 'VERIFICATION_FAILED' });
  expect(fs.readFileSync(f.file, 'utf8')).toBe(before);
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0].headers['payment-signature']).toBeUndefined();
});

it.each(['', 'example-piped-key\nother-key', 'a'.repeat(4097)])('rejects invalid piped input in the executable before any request or saved-state change', async input => {
  const f = await fixture(); const before = fs.readFileSync(f.file, 'utf8');
  expect((await f.run(['--json'], input)).code).toBe(1);
  expect(f.requests).toHaveLength(0);
  expect(fs.readFileSync(f.file, 'utf8')).toBe(before);
});
