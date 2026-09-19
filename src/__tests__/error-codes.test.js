/**
 * Server error-code mapping.
 *
 * The API returns a structured error body with a stable, machine-readable
 * `code` on every error (https://docs.nansen.ai/getting-started/error-handling).
 * statusToErrorCode() prefers that code over the HTTP status, so the CLI only
 * recognises what SERVER_CODE_MAP lists — a code missing from the map leaks
 * through as a raw string and every consumer keyed on ErrorCode silently misses
 * it. These tests pin the map to the documented code set, the friendly messages
 * that hang off it, and the fact that retry decisions stay keyed on status.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NansenAPI, ErrorCode, SERVER_CODE_MAP, statusToErrorCode } from '../api.js';

// Every code documented on the error-handling page, with the status the API
// sends it on. Adding a code there without an entry in SERVER_CODE_MAP fails
// the divergence test below.
const DOCUMENTED_SERVER_CODES = [
  ['missing_field', 422, ErrorCode.MISSING_PARAM],
  ['unknown_field', 422, ErrorCode.UNSUPPORTED_FILTER],
  ['invalid_field_value', 422, ErrorCode.INVALID_PARAMS],
  ['invalid_address_format', 422, ErrorCode.INVALID_ADDRESS],
  ['invalid_date_format', 422, ErrorCode.INVALID_PARAMS],
  ['invalid_date_range', 422, ErrorCode.INVALID_PARAMS],
  ['mutually_exclusive_fields', 422, ErrorCode.INVALID_PARAMS],
  ['value_out_of_range', 422, ErrorCode.INVALID_PARAMS],
  ['too_many_items', 422, ErrorCode.INVALID_PARAMS],
  ['unauthenticated', 401, ErrorCode.UNAUTHORIZED],
  ['forbidden', 403, ErrorCode.FORBIDDEN],
  ['geo_blocked', 451, ErrorCode.GEO_BLOCKED],
  ['plan_upgrade_required', 403, ErrorCode.PLAN_UPGRADE_REQUIRED],
  ['insufficient_credits', 403, ErrorCode.CREDITS_EXHAUSTED],
  ['rate_limit_exceeded', 429, ErrorCode.RATE_LIMITED],
  ['not_found', 404, ErrorCode.NOT_FOUND],
  ['method_not_allowed', 405, ErrorCode.METHOD_NOT_ALLOWED],
  ['conflict', 409, ErrorCode.CONFLICT],
  ['payload_too_large', 413, ErrorCode.PAYLOAD_TOO_LARGE],
  ['query_timeout', 504, ErrorCode.TIMEOUT],
  ['query_too_large', 422, ErrorCode.QUERY_TOO_LARGE],
  ['upstream_unavailable', 503, ErrorCode.SERVICE_UNAVAILABLE],
  ['internal_error', 500, ErrorCode.SERVER_ERROR],
];

// Codes from earlier error-body shapes that older responses may still carry.
const LEGACY_ALIASES = [
  ['unauthorized', 401, ErrorCode.UNAUTHORIZED],
  ['payment_required', 403, ErrorCode.PAYMENT_REQUIRED],
  ['unsupported_filter', 422, ErrorCode.UNSUPPORTED_FILTER],
  ['validation_error', 422, ErrorCode.INVALID_PARAMS],
  ['invalid_params', 400, ErrorCode.INVALID_PARAMS],
];

const CLI_CODES = new Set(Object.values(ErrorCode));

describe('SERVER_CODE_MAP', () => {
  it('lists every documented server code', () => {
    const missing = DOCUMENTED_SERVER_CODES
      .map(([serverCode]) => serverCode)
      .filter(serverCode => !(serverCode in SERVER_CODE_MAP));
    expect(missing).toEqual([]);
  });

  it('maps every key onto a value of the ErrorCode enum', () => {
    for (const [serverCode, cliCode] of Object.entries(SERVER_CODE_MAP)) {
      expect(CLI_CODES.has(cliCode), `${serverCode} -> ${cliCode}`).toBe(true);
    }
  });

  it('has no keys beyond the documented codes and the legacy aliases', () => {
    // A stray key is either a typo (a documented code that will never match)
    // or a code the API does not send; both should be a deliberate change.
    const known = new Set([
      ...DOCUMENTED_SERVER_CODES.map(([serverCode]) => serverCode),
      ...LEGACY_ALIASES.map(([serverCode]) => serverCode),
    ]);
    const stray = Object.keys(SERVER_CODE_MAP).filter(serverCode => !known.has(serverCode));
    expect(stray).toEqual([]);
  });
});

describe('statusToErrorCode', () => {
  it.each(DOCUMENTED_SERVER_CODES)(
    'maps %s (HTTP %i) to %s',
    (serverCode, status, expected) => {
      expect(statusToErrorCode(status, { code: serverCode })).toBe(expected);
    },
  );

  it.each(LEGACY_ALIASES)(
    'still maps the legacy alias %s (HTTP %i) to %s',
    (serverCode, status, expected) => {
      expect(statusToErrorCode(status, { code: serverCode })).toBe(expected);
    },
  );

  it('reads the code from a nested detail object too', () => {
    expect(statusToErrorCode(401, { detail: { code: 'unauthenticated' } })).toBe(ErrorCode.UNAUTHORIZED);
  });

  it('lets the server code win over prose that would match another branch', () => {
    // Without a code, "address" in a 422 message would sniff to INVALID_ADDRESS.
    expect(statusToErrorCode(422, {
      code: 'missing_field',
      message: "Required field 'body -> address' is missing",
    })).toBe(ErrorCode.MISSING_PARAM);
    // Without a code, "credit" in a 403 message would sniff to CREDITS_EXHAUSTED.
    expect(statusToErrorCode(403, {
      code: 'plan_upgrade_required',
      message: 'This feature needs a paid plan; credits are not enough',
    })).toBe(ErrorCode.PLAN_UPGRADE_REQUIRED);
  });

  it('passes an unrecognised code through unchanged', () => {
    expect(statusToErrorCode(400, { code: 'brand_new_code' })).toBe('brand_new_code');
    expect(statusToErrorCode(500, { code: ' spaced_code ' })).toBe('spaced_code');
  });

  it('keeps a 402 as PAYMENT_REQUIRED regardless of the code', () => {
    expect(statusToErrorCode(402, { code: 'unauthenticated' })).toBe(ErrorCode.PAYMENT_REQUIRED);
  });

  describe('without a code field', () => {
    it.each([
      [401, ErrorCode.UNAUTHORIZED],
      [405, ErrorCode.METHOD_NOT_ALLOWED],
      [408, ErrorCode.TIMEOUT],
      [409, ErrorCode.CONFLICT],
      [413, ErrorCode.PAYLOAD_TOO_LARGE],
      [429, ErrorCode.RATE_LIMITED],
      [451, ErrorCode.GEO_BLOCKED],
      [503, ErrorCode.SERVICE_UNAVAILABLE],
      [504, ErrorCode.TIMEOUT],
    ])('falls back to the status: HTTP %i -> %s', (status, expected) => {
      expect(statusToErrorCode(status, {})).toBe(expected);
    });

    it('refines a 404 by the message', () => {
      expect(statusToErrorCode(404, { message: 'Token not found' })).toBe(ErrorCode.TOKEN_NOT_FOUND);
      expect(statusToErrorCode(404, { message: 'Address has no data' })).toBe(ErrorCode.ADDRESS_NOT_FOUND);
      expect(statusToErrorCode(404, { message: 'Wallet has no data' })).toBe(ErrorCode.ADDRESS_NOT_FOUND);
      expect(statusToErrorCode(404, { message: 'Not Found' })).toBe(ErrorCode.NOT_FOUND);
    });

    it('uses the range defaults for statuses it does not list', () => {
      expect(statusToErrorCode(418, {})).toBe(ErrorCode.INVALID_PARAMS);
      expect(statusToErrorCode(599, {})).toBe(ErrorCode.SERVER_ERROR);
    });
  });
});

describe('NansenAPI.request with structured server errors', () => {
  let mockFetch;

  // Shape of a real API error body; only the fields the CLI reads are needed.
  function errorResponse(status, code, message, extraHeaders = {}) {
    const map = new Map(Object.entries(extraHeaders));
    return {
      ok: false,
      status,
      headers: { get: name => (map.has(name) ? map.get(name) : null) },
      json: async () => ({
        error: 'Error',
        message,
        code,
        status,
        request_id: 'req-test',
        doc_url: `https://docs.nansen.ai/getting-started/error-handling#${code}`,
      }),
    };
  }

  async function capture(api) {
    let thrown;
    const promise = api.smartMoneyNetflow({}).catch(err => { thrown = err; });
    await vi.runAllTimersAsync();
    await promise;
    return thrown;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('shows the login hint for a 401 unauthenticated when no key is configured', async () => {
    mockFetch.mockResolvedValue(errorResponse(401, 'unauthenticated', 'Missing API key'));
    const thrown = await capture(new NansenAPI(null, 'https://api.nansen.ai'));

    expect(thrown.code).toBe(ErrorCode.UNAUTHORIZED);
    expect(thrown.message).toBe('Not logged in. Run: nansen login');
    expect(thrown.status).toBe(401);
  });

  it('keeps the server message for a 401 unauthenticated when a key is configured', async () => {
    mockFetch.mockResolvedValue(errorResponse(401, 'unauthenticated', 'Invalid API key'));
    const thrown = await capture(new NansenAPI('test-key', 'https://api.nansen.ai'));

    expect(thrown.code).toBe(ErrorCode.UNAUTHORIZED);
    expect(thrown.message).toBe('Invalid API key');
  });

  it('adds the no-retry hint for insufficient_credits', async () => {
    mockFetch.mockResolvedValue(errorResponse(403, 'insufficient_credits', 'Insufficient credits.'));
    const thrown = await capture(new NansenAPI('test-key', 'https://api.nansen.ai'));

    expect(thrown.code).toBe(ErrorCode.CREDITS_EXHAUSTED);
    expect(thrown.message).toBe('Insufficient credits. No retry will help. Check your Nansen dashboard for credit balance.');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('adds the unsupported-filter hint for unknown_field', async () => {
    mockFetch.mockResolvedValue(errorResponse(422, 'unknown_field', "Field 'only_smart_money' is not recognized"));
    const thrown = await capture(new NansenAPI('test-key', 'https://api.nansen.ai'));

    expect(thrown.code).toBe(ErrorCode.UNSUPPORTED_FILTER);
    expect(thrown.message).toContain('This filter is not supported for this token/chain combination. Do not retry.');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  describe('retry decisions stay keyed on the HTTP status', () => {
    const api = () => new NansenAPI('test-key', 'https://api.nansen.ai', { retry: { maxRetries: 2 } });

    it.each([
      ['rate_limit_exceeded', 429, ErrorCode.RATE_LIMITED],
      ['upstream_unavailable', 503, ErrorCode.SERVICE_UNAVAILABLE],
      ['query_timeout', 504, ErrorCode.TIMEOUT],
      ['internal_error', 500, ErrorCode.SERVER_ERROR],
    ])('retries %s on HTTP %i and reports %s', async (code, status, expected) => {
      mockFetch.mockResolvedValue(errorResponse(status, code, 'try later'));
      const thrown = await capture(api());

      expect(thrown.code).toBe(expected);
      expect(thrown.status).toBe(status);
      expect(mockFetch).toHaveBeenCalledTimes(3); // initial attempt + maxRetries
    });

    it.each([
      ['missing_field', 422, ErrorCode.MISSING_PARAM],
      ['plan_upgrade_required', 403, ErrorCode.PLAN_UPGRADE_REQUIRED],
      ['geo_blocked', 451, ErrorCode.GEO_BLOCKED],
      ['query_too_large', 422, ErrorCode.QUERY_TOO_LARGE],
      ['conflict', 409, ErrorCode.CONFLICT],
    ])('does not retry %s on HTTP %i and reports %s', async (code, status, expected) => {
      mockFetch.mockResolvedValue(errorResponse(status, code, 'fix the request'));
      const thrown = await capture(api());

      expect(thrown.code).toBe(expected);
      expect(thrown.status).toBe(status);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('honours retry-after on a rate_limit_exceeded response', async () => {
      mockFetch
        .mockResolvedValueOnce(errorResponse(429, 'rate_limit_exceeded', 'slow down', { 'retry-after': '2' }))
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({ netflows: [] }),
        });

      const promise = api().smartMoneyNetflow({});
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result._meta.retriedAttempts).toBe(1);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });
});
