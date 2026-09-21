/**
 * Redaction and request-trace tests.
 *
 * The bar every case here defends: a credential handed to the tracer must not
 * come out the other side. Fixtures are deliberately fake — `test-key-…`,
 * `test-token-…`, the all-zero wallet — so nothing in this file is worth
 * stealing even if it leaked.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  REDACTED,
  isDebugEnabled,
  isSecretName,
  looksLikeSecretValue,
  redact,
  redactHeaders,
  redactUrl,
  setDebugEnabled,
  setDebugWriter,
  trace,
  traceRequest,
  traceRetry,
  truncate,
} from '../debug.js';

// Obviously fake, but shaped like the real thing.
const FAKE_API_KEY = 'test-key-00000000000000000000000000000000';
const FAKE_PRIVATE_KEY = '0x' + '1'.repeat(64);
const FAKE_MNEMONIC = 'test test test test test test test test test test test junk';
const FAKE_PAYMENT_SIGNATURE = 'ZmFrZS14NDAyLXBheW1lbnQtc2lnbmF0dXJlLWZvci10ZXN0cy1vbmx5LW5vdC1yZWFs';
const FAKE_BEARER = 'Bearer test-token-000000000000000000';

let lines;
let prevNansenDebug;
let prevDebug;

beforeEach(() => {
  lines = [];
  prevNansenDebug = process.env.NANSEN_DEBUG;
  prevDebug = process.env.DEBUG;
  delete process.env.NANSEN_DEBUG;
  delete process.env.DEBUG;
  setDebugEnabled(undefined);
  setDebugWriter((line) => lines.push(line));
});

afterEach(() => {
  setDebugWriter(undefined);
  setDebugEnabled(undefined);
  if (prevNansenDebug === undefined) delete process.env.NANSEN_DEBUG;
  else process.env.NANSEN_DEBUG = prevNansenDebug;
  if (prevDebug === undefined) delete process.env.DEBUG;
  else process.env.DEBUG = prevDebug;
});

describe('redact', () => {
  it('blanks a key passed in a URL query string', () => {
    const url = redactUrl(`https://api.example.test/v1/holders?apikey=${FAKE_API_KEY}&chain=solana`);

    expect(url).not.toContain(FAKE_API_KEY);
    expect(url).toContain(`apikey=${REDACTED}`);
    expect(url).toContain('chain=solana');
    expect(url).toContain('/v1/holders');
  });

  it('blanks a key passed in a header bag and never prints header values', () => {
    const headers = redactHeaders({
      apikey: FAKE_API_KEY,
      Authorization: FAKE_BEARER,
      'Payment-Signature': FAKE_PAYMENT_SIGNATURE,
      'X-Client-Type': 'nansen-cli',
    });

    expect(JSON.stringify(headers)).not.toContain(FAKE_API_KEY);
    expect(JSON.stringify(headers)).not.toContain(FAKE_PAYMENT_SIGNATURE);
    expect(headers).toEqual({
      apikey: REDACTED,
      Authorization: REDACTED,
      'Payment-Signature': REDACTED,
      // Even a harmless header value is withheld — one rule, no exceptions.
      'X-Client-Type': REDACTED,
    });
  });

  it('blanks a secret nested several levels deep', () => {
    const redacted = redact({
      request: { headers: { apikey: FAKE_API_KEY }, chain: 'solana' },
      wallets: [{ label: 'main', privateKey: FAKE_PRIVATE_KEY }],
    });

    const printed = JSON.stringify(redacted);
    expect(printed).not.toContain(FAKE_API_KEY);
    expect(printed).not.toContain(FAKE_PRIVATE_KEY);
    expect(redacted.request.chain).toBe('solana');
    expect(redacted.wallets[0].label).toBe('main');
  });

  it('blanks a Bearer token while keeping the scheme visible', () => {
    expect(redact(FAKE_BEARER)).toBe(`Bearer ${REDACTED}`);
    expect(redact(`authorization header was ${FAKE_BEARER}`)).toBe(`authorization header was Bearer ${REDACTED}`);
    expect(redact(FAKE_BEARER)).not.toContain('test-token');
  });

  it('blanks an x402 payment signature even under an innocent-looking field name', () => {
    const redacted = redact({ payload: FAKE_PAYMENT_SIGNATURE });

    expect(redacted.payload).toBe(REDACTED);
  });

  it('blanks mnemonic- and private-key-shaped values whatever they are called', () => {
    expect(redact({ notes: FAKE_MNEMONIC }).notes).toBe(REDACTED);
    expect(redact({ value: FAKE_PRIVATE_KEY }).value).toBe(REDACTED);
    expect(looksLikeSecretValue(FAKE_MNEMONIC)).toBe(true);
    expect(looksLikeSecretValue(FAKE_PRIVATE_KEY)).toBe(true);
  });

  it('blanks a secret-adjacent name even when the value is public', () => {
    // `token_address` is not a credential, but the name matches — fail closed.
    const url = redactUrl('https://api.example.test/v1/holders?token_address=0x0000000000000000000000000000000000000001');

    expect(url).toContain(`token_address=${REDACTED}`);
    expect(isSecretName('token_address')).toBe(true);
  });

  it('keeps public identifiers and prose readable', () => {
    const url = redactUrl('https://api.example.test/v1/balances?address=0x0000000000000000000000000000000000000001&chain=base');

    expect(url).toContain('address=0x0000000000000000000000000000000000000001');
    expect(url).toContain('chain=base');
    // A request id is an identifier, not a secret — support needs to read it.
    expect(looksLikeSecretValue('6f1c0f2a-0000-4000-8000-0000000000aa')).toBe(false);
    // Prose that merely mentions a credential is not itself one.
    expect(redact({ hint: 'set the password in the environment' }).hint).toBe('set the password in the environment');
  });

  it('drops URL credentials, paths, fragments, and survives an unparseable URL', () => {
    expect(redactUrl(`https://user:${FAKE_API_KEY}@api.example.test/v1/x`)).not.toContain(FAKE_API_KEY);
    expect(redactUrl(`https://api.example.test/reset/${FAKE_API_KEY}#apikey=${FAKE_API_KEY}`)).toBe(`https://api.example.test/reset/${REDACTED}`);
    expect(redactUrl(`/v1/x?secret=${FAKE_API_KEY}&chain=base`)).toBe(`/v1/x?secret=${REDACTED}&chain=base`);
    expect(redactUrl('/v1/x?note=%ZZ&chain=base')).toBe('/v1/x?note=%ZZ&chain=base');
  });

  it('blanks credentials embedded in diagnostic prose', () => {
    const cases = [
      `request to https://api.example.test/v1/x?apikey=${FAKE_API_KEY} failed`,
      `signing failed for ${FAKE_PRIVATE_KEY}`,
      `upstream said api_key=${FAKE_API_KEY}`,
      'JWT eyJhbGciOiJIUzI1NiJ9.payload.signature',
    ];

    for (const message of cases) {
      const printed = redact(message);
      expect(printed).not.toContain(FAKE_API_KEY);
      expect(printed).not.toContain(FAKE_PRIVATE_KEY);
      expect(printed).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    }
  });

  it('truncates long values and tolerates cycles', () => {
    expect(truncate('x'.repeat(400))).toHaveLength(`${'x'.repeat(200)}…(+200 more)`.length);
    expect(truncate('short')).toBe('short');

    const cyclic = { chain: 'base' };
    cyclic.self = cyclic;
    expect(redact(cyclic)).toEqual({ chain: 'base', self: '[circular]' });
  });
});

describe('inline credential schemes', () => {
  it('redacts a Bearer credential inside a longer string', () => {
    expect(redact('Authorization was Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig')).not.toContain('eyJhbGciOiJIUzI1NiJ9');
  });

  it('leaves ordinary prose about payments and signatures readable', () => {
    // These words are not credential introducers; a real payment signature is
    // caught by header-name and value-shape matching instead.
    expect(redact('payment outcome unknown')).toBe('payment outcome unknown');
    expect(redact('signed payment was transmitted')).toBe('signed payment was transmitted');
    expect(redact('Signature verification failed for header')).toBe('Signature verification failed for header');
  });

  it('leaves a short word after a scheme keyword alone', () => {
    expect(redact('Bearer token')).toBe('Bearer token');
  });
});

describe('debug switch', () => {
  it('is off by default and prints nothing', () => {
    expect(isDebugEnabled()).toBe(false);
    traceRequest({ method: 'POST', url: 'https://api.example.test/v1/x', attempt: 1 });
    expect(lines).toEqual([]);
  });

  it('turns on only from NANSEN_DEBUG or the explicit flag', () => {
    process.env.NANSEN_DEBUG = '1';
    expect(isDebugEnabled()).toBe(true);

    process.env.NANSEN_DEBUG = '0';
    expect(isDebugEnabled()).toBe(false);

    delete process.env.NANSEN_DEBUG;
    process.env.DEBUG = '1';
    expect(isDebugEnabled()).toBe(false);

    process.env.NANSEN_DEBUG = '0';
    expect(isDebugEnabled()).toBe(false);

    delete process.env.DEBUG;
    delete process.env.NANSEN_DEBUG;
    setDebugEnabled(true);
    expect(isDebugEnabled()).toBe(true);
  });

  it('bounds structured and binary fields after serialization', () => {
    setDebugEnabled(true);
    trace('probe', { blob: Buffer.alloc(4096, 255), nested: { values: Array.from({ length: 100 }, (_, i) => `item ${i}`) } });

    expect(lines[0].length).toBeLessThan(500);
    expect(lines[0]).toContain('Buffer 4096 bytes');
    expect(lines[0]).toContain('…(+');
  });

  it('formats a request, a response and a retry decision', () => {
    setDebugEnabled(true);
    traceRequest({ method: 'POST', url: 'https://api.example.test/v1/x', attempt: 1, maxAttempts: 4 });
    traceRetry({ method: 'POST', url: 'https://api.example.test/v1/x', status: 429, attempt: 1, reason: 'retry-after', delayMs: 1100.6, retryAfterMs: 1000 });

    expect(lines[0]).toBe('[nansen:debug] http.request method=POST url=https://api.example.test/v1/x attempt=1/4\n');
    expect(lines[1]).toContain('http.retry');
    expect(lines[1]).toContain('status=429');
    expect(lines[1]).toContain('reason=retry-after');
    expect(lines[1]).toContain('delay_ms=1101');
    expect(lines[1]).toContain('retry_after_ms=1000');
  });

  it('writes to stderr, never stdout', () => {
    setDebugWriter(undefined);
    setDebugEnabled(true);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    trace('http.request', { method: 'POST', url: `https://api.example.test/v1/x?apikey=${FAKE_API_KEY}` });

    const written = stderrSpy.mock.calls.map((call) => String(call[0])).join('');
    expect(written).toContain('[nansen:debug] http.request');
    expect(written).not.toContain(FAKE_API_KEY);
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();

    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('drops null and undefined fields instead of printing them', () => {
    setDebugEnabled(true);
    trace('http.response', { method: 'GET', status: 200, request_id: null, attempt: undefined });

    expect(lines[0]).toBe('[nansen:debug] http.response method=GET status=200\n');
  });
});
