import http from 'node:http';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { NansenAPI } from '../api.js';
import { ERROR_CODES } from '../error-codes.js';
import { sessionFixture } from './fixtures/auth-fixture.js';

// A request marked retry:false must not be sent twice (bridge execute, smart-
// alert create/update). When its connection fails after it went out, the
// server may have applied it, so the CLI must not answer NETWORK_ERROR ("could
// not reach", retryable). Only a failure before a connection exists means the
// request was not sent.

const BASE_URL = 'https://api.nansen.ai';
const FAST = { retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 1 } };

function transportError(code) {
  const cause = Object.assign(new Error(`socket ${code}`), { code });
  return new TypeError('fetch failed', { cause });
}

function okResponse(json) {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json', 'x-request-id': 'req-123' }),
    json,
    text: async () => '',
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('retry:false request whose connection fails', () => {
  it.each(['UND_ERR_SOCKET', 'ECONNRESET', 'UND_ERR_HEADERS_TIMEOUT', 'EPIPE'])(
    'after it was sent (%s) is REQUEST_INDETERMINATE, sent once',
    async code => {
      const fetchMock = vi.fn(async () => { throw transportError(code); });
      vi.stubGlobal('fetch', fetchMock);
      const api = new NansenAPI('test-key', BASE_URL, FAST);

      const err = await api.request('/api/v1/perp/bridge/execute', { a: 1 }, {
        cache: false, retry: false, indeterminateAdvice: 'Check "nansen bridge status".',
      }).catch(e => e);

      expect(err.code).toBe('REQUEST_INDETERMINATE');
      expect(err.message).toContain(`failed (${code}) after the request was sent`);
      expect(err.message).toContain('may or may not have been applied');
      expect(err.message).toContain('Check "nansen bridge status".');
      expect(err.message).not.toContain('credentials were not checked');
      expect(err.details).toEqual({ originalError: code });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it('with no failure code is REQUEST_INDETERMINATE (fails closed)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('response lost'); }));
    const api = new NansenAPI('test-key', BASE_URL, FAST);
    const err = await api.request('/api/v1/x', {}, { retry: false }).catch(e => e);
    expect(err.code).toBe('REQUEST_INDETERMINATE');
    expect(err.message).toContain('Check whether it took effect before retrying.');
  });

  it.each(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'])(
    'before a connection existed (%s) stays NETWORK_ERROR',
    async code => {
      const fetchMock = vi.fn(async () => { throw transportError(code); });
      vi.stubGlobal('fetch', fetchMock);
      const api = new NansenAPI('test-key', BASE_URL, FAST);

      const err = await api.request('/api/v1/perp/bridge/execute', {}, { retry: false }).catch(e => e);

      expect(err.code).toBe('NETWORK_ERROR');
      expect(err.message).toContain(`Could not reach the Nansen API at ${BASE_URL} (${code})`);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it('while the response body is read is REQUEST_INDETERMINATE', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(async () => { throw transportError('UND_ERR_SOCKET'); })));
    const api = new NansenAPI('test-key', BASE_URL, FAST);

    const err = await api.request('/api/v1/perp/bridge/execute', {}, { retry: false }).catch(e => e);

    expect(err.code).toBe('REQUEST_INDETERMINATE');
    expect(err.message).toContain('failed (UND_ERR_SOCKET) while its response was read');
    expect(err.details).toEqual({ originalError: 'UND_ERR_SOCKET', requestId: 'req-123' });
  });

  it('while the body is read on a browser session keeps neither reason nor request id', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(async () => { throw transportError('UND_ERR_SOCKET'); })));
    const bundle = sessionFixture();
    const credential = { kind: 'session', issuer: bundle.issuer, accountId: bundle.accountId, audience: BASE_URL, generation: 'g', expiresAt: bundle.expiresAt };
    const api = new NansenAPI(null, BASE_URL, { credential, authState: { acquireSession: vi.fn().mockResolvedValue(bundle) }, ...FAST });

    const err = await api.request('/api/v1/smart-alert', {}, { retry: false }).catch(e => e);

    expect(err.code).toBe('REQUEST_INDETERMINATE');
    expect(err.message).toContain('failed while its response was read');
    expect(err.details).toEqual({});
  });

  it('with a body that is not JSON keeps the invalid-response path', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(async () => { throw new SyntaxError('Unexpected token'); })));
    const api = new NansenAPI('test-key', BASE_URL, FAST);

    const err = await api.request('/api/v1/perp/bridge/execute', {}, { retry: false }).catch(e => e);

    expect(err.code).toBe('UNKNOWN');
    expect(err.message).toBe('Invalid response from API (status 200)');
  });

  it('PATCH counts as non-idempotent too', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw transportError('ECONNRESET'); }));
    const api = new NansenAPI('test-key', BASE_URL, FAST);
    const err = await api.request('/api/v1/smart-alert', {}, { method: 'PATCH', retry: false }).catch(e => e);
    expect(err.code).toBe('REQUEST_INDETERMINATE');
  });

  it('omits the failure reason for a browser session', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw transportError('UND_ERR_SOCKET'); }));
    const bundle = sessionFixture();
    const credential = { kind: 'session', issuer: bundle.issuer, accountId: bundle.accountId, audience: BASE_URL, generation: 'g', expiresAt: bundle.expiresAt };
    const api = new NansenAPI(null, BASE_URL, { credential, authState: { acquireSession: vi.fn().mockResolvedValue(bundle) }, ...FAST });

    const err = await api.request('/api/v1/smart-alert', {}, { retry: false }).catch(e => e);

    expect(err.code).toBe('REQUEST_INDETERMINATE');
    expect(err.message).toBe(`The connection to the Nansen API at ${BASE_URL} failed after the request was sent, so it may or may not have been applied. Check whether it took effect before retrying.`);
    expect(err.details).toEqual({});
  });
});

describe('retryable requests keep NETWORK_ERROR', () => {
  it.each([
    ['POST', {}],
    ['GET', { method: 'GET' }],
  ])('%s without retry:false retries and reports NETWORK_ERROR', async (_m, opts) => {
    const fetchMock = vi.fn(async () => { throw transportError('UND_ERR_SOCKET'); });
    vi.stubGlobal('fetch', fetchMock);
    const api = new NansenAPI('test-key', BASE_URL, FAST);

    const err = await api.request('/api/v1/x', {}, { cache: false, ...opts }).catch(e => e);

    expect(err.code).toBe('NETWORK_ERROR');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('GET with retry:false still reports NETWORK_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw transportError('UND_ERR_SOCKET'); }));
    const api = new NansenAPI('test-key', BASE_URL, FAST);
    const err = await api.request('/api/v1/x', {}, { method: 'GET', cache: false, retry: false }).catch(e => e);
    expect(err.code).toBe('NETWORK_ERROR');
  });
});

describe('REQUEST_INDETERMINATE is not retryable', () => {
  it('has no retry flag', () => {
    expect(ERROR_CODES.REQUEST_INDETERMINATE).toBeDefined();
    expect(ERROR_CODES.REQUEST_INDETERMINATE.retry).toBeUndefined();
  });
});

// Real sockets, so the failure shapes are undici's own rather than hand-built.
// The test setup replaces global fetch, so the request runs in a child process
// (its network guard still allows only localhost).
const API_MODULE = fileURLToPath(new URL('../api.js', import.meta.url));
const CHILD = `
  const { NansenAPI } = await import(process.argv[1]);
  const api = new NansenAPI('test-key', process.argv[2], { retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 1 } });
  try { await api.request('/api/v1/perp/bridge/execute', { a: 1 }, { cache: false, retry: false }); console.log('{}'); }
  catch (e) { console.log(JSON.stringify({ code: e.code, message: e.message })); }
`;

function requestInChild(url) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['--input-type=module', '-e', CHILD, API_MODULE, url], { env: { ...process.env, DO_NOT_TRACK: '1' } }, (err, stdout) => {
      if (err) return reject(err);
      resolve(JSON.parse(stdout.trim().split('\n').pop()));
    });
  });
}

describe('against a real server', () => {
  let server;
  afterEach(async () => {
    if (server) await new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); });
    server = null;
  });

  function listen(handler) {
    server = http.createServer(handler);
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
  }

  it('socket closed after the request was read → REQUEST_INDETERMINATE', async () => {
    let received = 0;
    const url = await listen((req) => {
      req.resume();
      req.on('end', () => { received += 1; req.socket.destroy(); });
    });

    const err = await requestInChild(url);

    expect(err.code).toBe('REQUEST_INDETERMINATE');
    expect(err.message).toContain('failed (UND_ERR_SOCKET) after the request was sent');
    expect(received).toBe(1);
  });

  it('body cut off after 200 headers → REQUEST_INDETERMINATE', async () => {
    const url = await listen((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': '200' });
        res.write('{"success":true,"da');
        setTimeout(() => req.socket.destroy(), 20);
      });
    });

    const err = await requestInChild(url);

    expect(err.code).toBe('REQUEST_INDETERMINATE');
    expect(err.message).toContain('while its response was read');
  });

  it('connection refused → NETWORK_ERROR (not sent)', async () => {
    const url = await listen(() => {});
    await new Promise(resolve => server.close(() => resolve()));
    server = null;

    const err = await requestInChild(url);

    expect(err.code).toBe('NETWORK_ERROR');
    expect(err.message).toContain('(ECONNREFUSED)');
  });
});
