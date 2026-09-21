/**
 * Request-trace coverage for the HTTP transports in api.js.
 *
 * Two things are proved for each transport: the trace says something useful
 * (status, latency, retry decision, request id), and the credential the
 * request carried never reaches the trace. Fixtures are fake.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NansenAPI } from '../api.js';
import { runCLI, parseArgs } from '../cli.js';
import { isDebugEnabled, setDebugEnabled } from '../debug.js';

const FAKE_API_KEY = 'test-key-00000000000000000000000000000000';
const FAKE_PAYMENT_SIGNATURE = 'ZmFrZS14NDAyLXBheW1lbnQtc2lnbmF0dXJlLWZvci10ZXN0cy1vbmx5LW5vdC1yZWFs';
const BASE_URL = 'https://api.example.test';
const FAST_RETRY = { retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2 } };

let stderrSpy;
let prevNansenDebug;

function jsonResponse({ status = 200, body = { data: [] }, requestId = null } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (name === 'x-request-id' ? requestId : null) },
    json: async () => body,
  };
}

function traced() {
  return stderrSpy.mock.calls.map((call) => String(call[0])).join('');
}

beforeEach(() => {
  prevNansenDebug = process.env.NANSEN_DEBUG;
  process.env.NANSEN_DEBUG = '1';
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  setDebugEnabled(undefined);
  stderrSpy.mockRestore();
  if (prevNansenDebug === undefined) delete process.env.NANSEN_DEBUG;
  else process.env.NANSEN_DEBUG = prevNansenDebug;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('request() tracing', () => {
  it('traces method, status, latency and request id without the API key', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ requestId: '6f1c0f2a-0000-4000-8000-0000000000aa' })));
    const api = new NansenAPI(FAKE_API_KEY, BASE_URL, FAST_RETRY);

    await api.request('/api/v1/token-screener', { chain: 'solana' });

    const output = traced();
    expect(output).toContain('[nansen:debug] http.request method=POST url=https://api.example.test/api/v1/token-screener attempt=1/3');
    expect(output).toContain('[nansen:debug] http.response');
    expect(output).toContain('status=200');
    expect(output).toMatch(/duration_ms=\d+/);
    expect(output).toContain('request_id=6f1c0f2a-0000-4000-8000-0000000000aa');
    expect(output).not.toContain(FAKE_API_KEY);
  });

  it('traces the retry decision: which attempt, why, and how long it waits', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ status: 429, body: { error: 'Rate limited' } }))
      .mockResolvedValueOnce(jsonResponse());
    vi.stubGlobal('fetch', fetchMock);
    const api = new NansenAPI(FAKE_API_KEY, BASE_URL, FAST_RETRY);

    await api.request('/api/v1/demo', { chain: 'solana' });

    const output = traced();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(output).toContain('http.retry');
    expect(output).toContain('status=429');
    expect(output).toContain('reason=retryable-status');
    expect(output).toMatch(/delay_ms=\d+/);
    expect(output).toContain('attempt=2/3');
    expect(output).not.toContain(FAKE_API_KEY);
  });

  it('traces a transport failure with its duration', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connect ECONNREFUSED'); }));
    const api = new NansenAPI(FAKE_API_KEY, BASE_URL, FAST_RETRY);

    await expect(api.request('/api/v1/demo', {}, { retry: false })).rejects.toThrow(/Network error/);

    const output = traced();
    expect(output).toContain('http.error');
    expect(output).toContain('connect ECONNREFUSED');
    expect(output).toMatch(/duration_ms=\d+/);
    expect(output).not.toContain(FAKE_API_KEY);
  });

  it('does not trace anything when debug is off', async () => {
    delete process.env.NANSEN_DEBUG;
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse()));
    const api = new NansenAPI(FAKE_API_KEY, BASE_URL, FAST_RETRY);

    await api.request('/api/v1/demo', { chain: 'solana' });

    expect(traced()).not.toContain('[nansen:debug]');
  });
});

describe('x402 paid-retry tracing', () => {
  it('traces the paid attempt without the payment signature', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ requestId: '6f1c0f2a-0000-4000-8000-0000000000ab' })));
    const api = new NansenAPI(null, BASE_URL, FAST_RETRY);

    await api._x402Retry(FAKE_PAYMENT_SIGNATURE, null, null, `${BASE_URL}/api/v1/demo`, { chain: 'solana' }, {});

    const output = traced();
    expect(output).toContain('http.request');
    expect(output).toContain('payment=x402');
    expect(output).toContain('status=200');
    expect(output).toContain('request_id=6f1c0f2a-0000-4000-8000-0000000000ab');
    expect(output).not.toContain(FAKE_PAYMENT_SIGNATURE);
  });
});

describe('cache tracing', () => {
  let tempHome;
  let prevHome;
  let prevUserProfile;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nansen-debug-trace-'));
    prevHome = process.env.HOME;
    prevUserProfile = process.env.USERPROFILE;
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
    fs.rmSync(tempHome, { recursive: true, force: true });
    vi.resetModules();
  });

  it('says when an answer came from the cache instead of the network', async () => {
    vi.resetModules();
    const fetchMock = vi.fn(async () => jsonResponse());
    vi.stubGlobal('fetch', fetchMock);
    // api.js resolves the cache directory from HOME at import time.
    const { NansenAPI: FreshAPI } = await import('../api.js');
    const api = new FreshAPI(FAKE_API_KEY, BASE_URL, { ...FAST_RETRY, cache: { enabled: true, ttl: 300 } });

    await api.request('/api/v1/demo', { chain: 'solana' });
    await api.request('/api/v1/demo', { chain: 'solana' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(traced()).toContain('http.cache_hit');
  });
});

describe('--debug flag wiring', () => {
  it('turns tracing on for the rest of the run', async () => {
    delete process.env.NANSEN_DEBUG;
    setDebugEnabled(undefined);
    expect(isDebugEnabled()).toBe(false);

    // `auth status` is the offline command — it makes no request of its own,
    // so this asserts the flag alone, with nothing else in the way.
    await runCLI(['auth', 'status', '--debug'], {
      output: () => {},
      log: () => {},
      errorOutput: () => {},
      exit: () => {},
      isTTY: false,
    });

    expect(isDebugEnabled()).toBe(true);
    setDebugEnabled(undefined);
  });

  it('works before the command name, without swallowing it', async () => {
    // A global flag is naturally typed first. `--debug` must not consume the
    // command word as its value, which would leave the run undebugged and
    // dispatch a different command than the one asked for.
    delete process.env.NANSEN_DEBUG;
    setDebugEnabled(undefined);

    const parsed = parseArgs(['--debug', 'auth', 'status']);
    expect(parsed.flags.debug).toBe(true);
    expect(parsed.options.debug).toBeUndefined();
    expect(parsed._).toEqual(['auth', 'status']);

    await runCLI(['--debug', 'auth', 'status'], {
      output: () => {},
      log: () => {},
      errorOutput: () => {},
      exit: () => {},
      isTTY: false,
    });

    expect(isDebugEnabled()).toBe(true);
    setDebugEnabled(undefined);
  });
});
