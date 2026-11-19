/**
 * Regression tests for NansenAPI._x402Retry
 *
 * PR #264 extracted _x402Retry from three duplicated call sites but landed
 * without tests. Two bugs were fixed within the same PR via pre-merge commits:
 *
 *   3c25a0d — null check was truthy (`if (result)`): a valid API response of
 *     `false` or `0` would wrongly be treated as payment failure, causing the
 *     caller to try additional payment methods and ultimately throw.
 *
 *   e918bdd — missing await on paidResponse.json(): the rejection from a
 *     non-JSON body may not propagate cleanly through all runtime environments
 *     without an explicit await in the async function body.
 *
 * Issue #583 — after a signed payment was transmitted, a non-ok response no
 * longer collapses everything (5xx, transport failures, unreadable bodies,
 * clean rejections) into a single `null`. Only a readable 402 rejection body
 * returns the X402_PAYMENT_REJECTED sentinel (safe to try another payment
 * option). Another 4xx means the request failed, so it throws the API's own
 * error and no other option is signed; anything else throws NansenError with
 * code PAYMENT_AMBIGUOUS, because the server may have already settled the payment
 * and trying another option would risk paying twice. The sentinel is also
 * distinct from a genuine successful response whose JSON body is `null`.
 *
 * These tests pin the contract so future changes to _x402Retry are caught
 * before they reach CI.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NansenAPI, RESPONSE_META, X402_PAYMENT_REJECTED, ErrorCode, NansenError } from '../api.js';
import { resetAuditWarningForTests, x402AuditLogPath } from '../x402-audit.js';

function makeApi() {
  return new NansenAPI('test-key', 'https://api.nansen.ai');
}

describe('NansenAPI._x402Retry', () => {
  let mockFetch;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns the X402_PAYMENT_REJECTED sentinel for a readable 402 rejection', async () => {
    // Core contract: a payment refusal the server can prove (a legible 402
    // body) is safe to treat as "try the next payment option".
    mockFetch.mockResolvedValue({
      ok: false,
      status: 402,
      json: async () => ({ error: 'payment rejected' }),
    });

    const api = makeApi();
    const result = await api._x402Retry(
      'test-sig', null, null, 'https://api.nansen.ai/test', {},
    );
    expect(result).toBe(X402_PAYMENT_REJECTED);
  });

  it.each(['insufficient_funds', 'invalid_exact_evm_insufficient_balance'])(
    'reports a %s rejection as an insufficient balance and still returns the sentinel',
    async (reason) => {
      mockFetch.mockResolvedValue({ ok: false, status: 402, json: async () => ({ error: reason }) });
      const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await makeApi()._x402Retry(
        'test-sig', 'local wallet alice', 'eip155:8453', 'https://api.nansen.ai/test', {},
      );
      expect(result).toBe(X402_PAYMENT_REJECTED);
      expect(stderr).toHaveBeenCalledWith(
        '[x402] Payment rejected: local wallet alice has an insufficient token balance on eip155:8453. Fund it on that network or use another payment option.',
      );
    },
  );

  it('reads the invalidReason field for an insufficient-balance rejection', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 402, json: async () => ({ invalidReason: 'insufficient_funds' }) });
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});

    await makeApi()._x402Retry('test-sig', null, null, 'https://api.nansen.ai/test', {});
    expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/the paying wallet has an insufficient token balance\. /));
  });

  it('does not report an insufficient balance from free text outside the reason fields', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 402,
      json: async () => ({ error: 'payment rejected', accepts: [{ description: 'insufficient_funds? top up' }] }),
    });
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});

    await makeApi()._x402Retry('test-sig', null, 'eip155:8453', 'https://api.nansen.ai/test', {});
    expect(stderr).not.toHaveBeenCalled();
  });

  it.each([
    [400, { code: 'invalid_field_value', message: 'chains: unsupported value' }, ErrorCode.INVALID_PARAMS, 'chains: unsupported value'],
    [404, { detail: 'Not found' }, ErrorCode.NOT_FOUND, 'Not found'],
    [409, { code: 'conflict', message: 'Already exists' }, ErrorCode.CONFLICT, 'Already exists'],
    [422, { message: 'Invalid date range' }, ErrorCode.INVALID_PARAMS, 'Invalid date range'],
  ])('throws the API error for a %i on the paid retry instead of returning the sentinel', async (status, body, code, message) => {
    // A non-402 4xx means the request failed, not the payment: another
    // payment option would fail the same way.
    mockFetch.mockResolvedValue({ ok: false, status, json: async () => body, headers: { get: () => 'req-9' } });

    const err = await makeApi()._x402Retry('test-sig', null, null, 'https://api.nansen.ai/test', {}).catch(e => e);

    expect(err).toBeInstanceOf(NansenError);
    expect(err).toMatchObject({ code, status, message });
    expect(err.details).toMatchObject({ requestId: 'req-9' });
  });

  describe('with a browser session', () => {
    const sessionApi = () => {
      const api = makeApi();
      api.selection = { ...api.selection, kind: 'session' };
      return api;
    };

    it('drops the body of a non-validation 4xx and uses a fixed message', async () => {
      mockFetch.mockResolvedValue({
        ok: false, status: 404, json: async () => ({ message: 'boom', echoed: 'Payment-Signature: sig-SECRET' }), headers: { get: () => 'req-9' },
      });

      const err = await sessionApi()._x402Retry('sig-SECRET', null, null, 'https://api.nansen.ai/test', {}).catch(e => e);

      expect(err).toBeInstanceOf(NansenError);
      expect(err).toMatchObject({ code: ErrorCode.NOT_FOUND, status: 404, message: 'API request failed (404).' });
      expect(JSON.stringify(err.details ?? {})).not.toContain('SECRET');
      expect(err.details ?? {}).not.toHaveProperty('echoed');
      // Still marked as a final payment outcome, so no other option is signed.
      expect(Object.getOwnPropertySymbols(err).map(sym => sym.description)).toContain('x402RequestFailed');
    });

    it('keeps only the field-level parts of a validation error that do not echo the signature', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ message: 'bad sig-SECRET', code: 'invalid_field_value', errors: [{ field: 'chains', message: 'unsupported value' }], extra: 'x' }),
        headers: { get: () => null },
      });

      const err = await sessionApi()._x402Retry('sig-SECRET', null, null, 'https://api.nansen.ai/test', {}).catch(e => e);

      expect(err).toBeInstanceOf(NansenError);
      expect(err).toMatchObject({ code: ErrorCode.INVALID_PARAMS, status: 400, message: 'unsupported value' });
      expect(err.details).toEqual({ code: 'invalid_field_value', errors: [{ field: 'chains', message: 'unsupported value' }] });
    });
  });

  it('still throws a 400 error when the body has a shape the error builders reject', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: { message: 'nested' } }) });

    const err = await makeApi()._x402Retry('test-sig', null, null, 'https://api.nansen.ai/test', {}).catch(e => e);

    expect(err).toBeInstanceOf(NansenError);
    expect(err).toMatchObject({ status: 400, message: 'API error: 400' });
  });

  it('throws PAYMENT_AMBIGUOUS on a 5xx after the payment was transmitted (issue #583)', async () => {
    // A 5xx doesn't prove the payment was rejected — the server could have
    // settled it before failing to respond. Must not be treated the same as
    // a clean rejection, or the caller would sign and send another payment.
    mockFetch.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: 'internal error' }),
    });

    const api = makeApi();
    await expect(
      api._x402Retry('test-sig', null, null, 'https://api.nansen.ai/test', {}),
    ).rejects.toMatchObject({ code: ErrorCode.PAYMENT_AMBIGUOUS });
  });

  it('throws PAYMENT_AMBIGUOUS when a non-5xx rejection body is unreadable (issue #583)', async () => {
    // A 4xx we can't even parse doesn't prove a clean rejection either.
    mockFetch.mockResolvedValue({
      ok: false,
      status: 402,
      json: vi.fn().mockRejectedValue(new SyntaxError('Unexpected token < in JSON')),
    });

    const api = makeApi();
    await expect(
      api._x402Retry('test-sig', null, null, 'https://api.nansen.ai/test', {}),
    ).rejects.toMatchObject({ code: ErrorCode.PAYMENT_AMBIGUOUS });
  });

  it('throws PAYMENT_AMBIGUOUS when the fetch itself fails after transmission (issue #583)', async () => {
    // The signature was already on the wire when the connection dropped —
    // the server may have received and settled it.
    mockFetch.mockRejectedValue(new TypeError('fetch failed'));

    const api = makeApi();
    await expect(
      api._x402Retry('test-sig', null, null, 'https://api.nansen.ai/test', {}),
    ).rejects.toMatchObject({ code: ErrorCode.PAYMENT_AMBIGUOUS });
  });

  it('returns a genuine null success body as null, not the rejection sentinel (issue #583)', async () => {
    // A successful (ok) response whose JSON body happens to be `null` must
    // not be confused with a clean rejection — that would make the caller
    // sign and transmit a second payment for an already-settled request.
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => null,
      headers: new Map(),
    });

    const api = makeApi();
    const result = await api._x402Retry(
      'test-sig', null, null, 'https://api.nansen.ai/test', {},
    );
    expect(result).toBeNull();
    expect(result).not.toBe(X402_PAYMENT_REJECTED);
  });

  it('returns the parsed JSON body with response metadata when the paid response is ok', async () => {
    // Regression for e918bdd: the resolved JSON value (not a Promise) is
    // returned so callers can use strict !== sentinel to detect success.
    const responseData = { data: { token: 'ETH', value: 1234 } };
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => responseData,
      headers: new Map([
        ['x-request-id', 'req-paid'],
        ['x-nansen-credits-remaining', '9'],
      ]),
    });

    const api = makeApi();
    const result = await api._x402Retry(
      'test-sig', null, null, 'https://api.nansen.ai/test', {},
    );
    expect(result).toBe(responseData);
    expect(result[RESPONSE_META]).toEqual({
      requestId: 'req-paid',
      credits: { used: null, remaining: 9, cost: null },
    });
    expect(api.lastResponseMeta).toEqual(result[RESPONSE_META]);
  });

  it('returns a falsy-but-valid JSON body as-is (regression for 3c25a0d)', async () => {
    // Before 3c25a0d the callers used `if (result)` — a valid response of
    // `false` would be misread as payment failure and the request would fall
    // through to the next payment option.  The fix uses `!== sentinel` instead.
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => false,
    });

    const api = makeApi();
    const result = await api._x402Retry(
      'test-sig', null, null, 'https://api.nansen.ai/test', {},
    );
    // false is a valid (if unusual) API response — must not be treated as rejected
    expect(result).toBe(false);
  });

  it('sends the Payment-Signature header in the retry request', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ success: true }) });

    const api = makeApi();
    await api._x402Retry(
      'my-payment-sig', null, null, 'https://api.nansen.ai/test', {},
    );

    expect(mockFetch).toHaveBeenCalledOnce();
    const [, requestInit] = mockFetch.mock.calls[0];
    expect(requestInit.headers['Payment-Signature']).toBe('my-payment-sig');
    expect(requestInit.method).toBe('POST');
    expect(requestInit.redirect).toBe('error');
    expect(requestInit.body).toBeDefined();
  });

  it('defaults to POST with a JSON body when options.method is omitted', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });

    const api = makeApi();
    await api._x402Retry(
      'sig', null, null, 'https://api.nansen.ai/test', { hello: 'world' },
    );

    const [, requestInit] = mockFetch.mock.calls[0];
    expect(requestInit.method).toBe('POST');
    expect(requestInit.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(requestInit.body)).toEqual({ hello: 'world' });
  });

  it('retries with GET and omits body when options.method is GET', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ account: true }) });

    const api = makeApi();
    await api._x402Retry(
      'sig', null, null, 'https://api.nansen.ai/api/v1/account', {}, { method: 'GET' },
    );

    const [, requestInit] = mockFetch.mock.calls[0];
    expect(requestInit.method).toBe('GET');
    expect(requestInit.body).toBeUndefined();
    expect(requestInit.headers['Content-Type']).toBeUndefined();
    expect(requestInit.headers['Payment-Signature']).toBe('sig');
  });

  it('retries with DELETE and omits body when options.method is DELETE', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ deleted: true }) });

    const api = makeApi();
    await api._x402Retry(
      'sig', null, null, 'https://api.nansen.ai/api/v1/smart-alert/1', { ignored: true }, { method: 'DELETE' },
    );

    const [, requestInit] = mockFetch.mock.calls[0];
    expect(requestInit.method).toBe('DELETE');
    expect(requestInit.body).toBeUndefined();
  });

  it('retries with PATCH and keeps a JSON body', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ patched: true }) });

    const api = makeApi();
    await api._x402Retry(
      'sig', null, null, 'https://api.nansen.ai/api/v1/smart-alert', { id: '1' }, { method: 'PATCH' },
    );

    const [, requestInit] = mockFetch.mock.calls[0];
    expect(requestInit.method).toBe('PATCH');
    expect(JSON.parse(requestInit.body)).toEqual({ id: '1' });
    expect(requestInit.headers['Content-Type']).toBe('application/json');
  });

  it('throws PAYMENT_AMBIGUOUS when an ok response body is not valid JSON (issue #583)', async () => {
    // Regression for e918bdd, updated for #583: the payment was accepted
    // (ok) — it settled — so a parse failure now surfaces as PAYMENT_AMBIGUOUS
    // rather than a bare SyntaxError, and must not be treated as a rejection
    // (that would risk paying again for an already-settled request).
    mockFetch.mockResolvedValue({
      ok: true,
      json: vi.fn().mockRejectedValue(new SyntaxError('Unexpected token < in JSON')),
    });

    const api = makeApi();
    await expect(
      api._x402Retry('test-sig', null, null, 'https://api.nansen.ai/test', {}),
    ).rejects.toMatchObject({ code: ErrorCode.PAYMENT_AMBIGUOUS });
  });

  it('every PAYMENT_AMBIGUOUS error is a NansenError with an actionable message', async () => {
    mockFetch.mockRejectedValue(new TypeError('network down'));
    const api = makeApi();
    try {
      await api._x402Retry('test-sig', null, null, 'https://api.nansen.ai/test', {});
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(NansenError);
      expect(err.code).toBe(ErrorCode.PAYMENT_AMBIGUOUS);
      expect(err.message).toMatch(/not attempting another payment/i);
    }
  });
});

describe('NansenAPI._x402Retry — payment audit log', () => {
  const URL_WITH_QUERY = 'https://api.nansen.ai/api/v1/profiler/address/balance?address=0xabc';
  const DECISION = {
    ok: true,
    usd: 0.01,
    symbol: 'USDC',
    network: 'eip155:8453',
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    payTo: '0xRecipient',
    amountRaw: '10000',
  };
  let mockFetch;
  let originalHome;
  let home;

  const readRecords = () => fs.readFileSync(x402AuditLogPath(), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const pay = (options = {}) => makeApi()._x402Retry(
    'secret-payment-signature', 'local wallet alice', 'eip155:8453', URL_WITH_QUERY, { address: '0xabc' },
    { method: 'POST', ...options },
    { asset: DECISION.asset, checkBalance: false, provider: 'local', decision: DECISION },
  );
  const response = (status, body, requestId = 'req-1') => ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Map([['x-request-id', requestId]]),
    json: body instanceof Error ? async () => { throw body; } : async () => body,
  });

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    originalHome = process.env.HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'nansen-x402-retry-audit-'));
    process.env.HOME = home;
    resetAuditWarningForTests();
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('records the signed payment and its acceptance under one id, without secrets', async () => {
    mockFetch.mockResolvedValue(response(200, { data: [] }));

    await pay();

    const records = readRecords();
    const base = {
      id: expect.any(String),
      timestamp: expect.any(String),
      provider: 'local',
      wallet: 'local wallet alice',
      network: 'eip155:8453',
      asset: DECISION.asset,
      symbol: 'USDC',
      amountUsd: 0.01,
      amountRaw: '10000',
      payTo: '0xRecipient',
      method: 'POST',
      requestUrl: 'https://api.nansen.ai/api/v1/profiler/address/balance',
    };
    expect(records).toEqual([
      { ...base, event: 'signed' },
      { ...base, event: 'accepted', httpStatus: 200, requestId: 'req-1' },
    ]);
    expect(records[1].id).toBe(records[0].id);
    const raw = fs.readFileSync(x402AuditLogPath(), 'utf8');
    expect(raw).not.toContain('secret-payment-signature');
    expect(raw).not.toContain('0xabc');
    expect(raw).not.toContain('test-key');
  });

  it('records an insufficient-balance rejection with its reason', async () => {
    mockFetch.mockResolvedValue(response(402, { error: 'insufficient_funds' }));

    expect(await pay()).toBe(X402_PAYMENT_REJECTED);

    expect(readRecords()[1]).toMatchObject({ event: 'rejected', httpStatus: 402, reason: 'insufficient_balance' });
  });

  it.each([
    'invalid_exact_evm_payload_signature',
    'expired',
    'INVALID_SIGNATURE',
  ])('keeps the rejection code %s', async (code) => {
    mockFetch.mockResolvedValue(response(402, { invalidReason: code }));

    await pay();

    expect(readRecords()[1]).toMatchObject({ event: 'rejected', reason: code });
  });

  it.each([
    ['free text', 'Your payment was declined, contact support@example.com'],
    ['a checksummed EVM address', '0xBEEFbeefBEEFbeefBEEFbeefBEEFbeefBEEFbeef'],
    ['a lowercase EVM address', '0xbeefbeefbeefbeefbeefbeefbeefbeefbeefbeef'],
    ['bare hex', 'beefbeef0123beefbeef0123beefbeef0123beef'],
    ['a Solana key starting with a digit', '7UX2i7SucgLMQcfZ75s3VXmZZY4YRUyJN9X1RgfMoDUi'],
    ['a Solana key starting with a letter', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'],
    ['mixed case', 'Invalid_Signature'],
  ])('never copies %s into the reason', async (_name, value) => {
    mockFetch.mockResolvedValue(response(402, { error: value }));

    await pay();

    expect(readRecords()[1]).toMatchObject({ event: 'rejected', reason: null });
    expect(fs.readFileSync(x402AuditLogPath(), 'utf8')).not.toContain(value);
  });

  it('records a request error on the paid retry as ambiguous, not as a rejection', async () => {
    mockFetch.mockResolvedValue(response(404, { detail: 'Not found' }));

    await expect(pay()).rejects.toMatchObject({ status: 404 });

    expect(readRecords().map(r => r.event)).toEqual(['signed', 'ambiguous']);
    expect(readRecords()[1]).toMatchObject({ reason: 'request_error', httpStatus: 404, requestId: 'req-1' });
  });

  it.each([
    ['a 5xx', () => response(503, {}), 'server_error', 503],
    ['an admission denial', () => response(429, {}), 'admission_denied', 429],
    ['an unreadable rejection', () => response(402, new SyntaxError('bad json')), 'unreadable_rejection', 402],
  ])('records %s as ambiguous before throwing', async (_name, makeResponse, reason, httpStatus) => {
    mockFetch.mockResolvedValue(makeResponse());

    await expect(pay()).rejects.toMatchObject({ code: ErrorCode.PAYMENT_AMBIGUOUS });

    expect(readRecords().map(r => r.event)).toEqual(['signed', 'ambiguous']);
    expect(readRecords()[1]).toMatchObject({ reason, httpStatus, requestId: 'req-1' });
  });

  it('records a transport failure after sending as ambiguous', async () => {
    mockFetch.mockRejectedValue(new TypeError('network down'));

    await expect(pay()).rejects.toMatchObject({ code: ErrorCode.PAYMENT_AMBIGUOUS });

    expect(readRecords()[1]).toMatchObject({ event: 'ambiguous', reason: 'transport_error' });
    expect(readRecords()[1]).not.toHaveProperty('httpStatus');
  });

  it('records an accepted payment whose body is unreadable as accepted', async () => {
    mockFetch.mockResolvedValue(response(200, new SyntaxError('bad json')));

    await expect(pay()).rejects.toMatchObject({ code: ErrorCode.PAYMENT_AMBIGUOUS });

    expect(readRecords().map(r => r.event)).toEqual(['signed', 'accepted']);
    expect(readRecords()[1]).toMatchObject({ httpStatus: 200 });
  });

  it('records acceptance as soon as the 2xx arrives, before the body is read', async () => {
    mockFetch.mockResolvedValue({ ...response(200, {}), json: () => new Promise(() => {}) });

    pay(); // never settles: the body never arrives
    await vi.waitFor(() => expect(readRecords().map(r => r.event)).toEqual(['signed', 'accepted']));
  });

  it('still completes the payment when the audit log cannot be written', async () => {
    fs.mkdirSync(path.join(home, '.nansen'));
    fs.writeFileSync(path.join(home, '.nansen', 'x402'), 'not a directory');
    mockFetch.mockResolvedValue(response(200, { data: [1] }));

    expect(await pay()).toMatchObject({ data: [1] });
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/could not write the payment audit log/));
  });
});
