/**
 * API-1080: API failures name the field, say it once, and tell a connection
 * failure apart from a rejected key.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { NansenAPI, ErrorCode, apiErrorDetails, sessionValidationDetails, networkErrorMessage } from '../api.js';
import { formatError } from '../cli.js';
import { createAuthState } from '../auth-state.js';
import { createAuthStore } from '../auth-store.js';
import { resolveCredential } from '../auth-credentials.js';
import { sessionFixture, memoryOperation } from './fixtures/auth-fixture.js';

// The REST API's 422 body for an unknown field.
const UNKNOWN_FIELD_BODY = {
  error: 'Unknown field',
  message: "Field 'timefrme' is not recognized. Did you mean 'timeframe'?",
  code: 'unknown_field',
  status: 422,
  request_id: 'req-422',
  doc_url: 'https://docs.nansen.ai/getting-started/error-handling#unknown_field',
  param: 'timefrme',
  errors: [{ field: 'body.timefrme', message: "Field 'timefrme' is not recognized. Did you mean 'timeframe'?", code: 'unknown_field' }],
};

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'x-request-id': 'req-422' } });
}

const dirs = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function sessionApi() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'error-envelope-')); dirs.push(home);
  const audience = 'https://api.nansen.ai';
  const state = createAuthState({ directory: path.join(home, '.nansen'), store: createAuthStore(memoryOperation()), retire: async () => ({ remote: 'recorded_pending' }) });
  const bundle = sessionFixture({ audience });
  const attempt = await state.begin();
  await state.install(attempt, { bundle, baseUrl: audience });
  await state.finish(attempt);
  const api = new NansenAPI(undefined, audience, { credential: resolveCredential({ env: { HOME: home } }), authState: state, retry: { maxRetries: 0 } });
  return { api, bundle };
}

describe('422 envelope', () => {
  it('names the field and does not repeat the message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(422, UNKNOWN_FIELD_BODY)));
    const api = new NansenAPI('test-key', 'https://api.nansen.ai', { retry: { maxRetries: 0 } });
    const error = await api.tokenInformation({ tokenAddress: 'So11111111111111111111111111111111111111112', chain: 'solana' }).catch(e => e);
    const envelope = formatError(error);

    expect(envelope).toMatchObject({
      success: false,
      error: UNKNOWN_FIELD_BODY.message,
      code: ErrorCode.INVALID_PARAMS,
      status: 422,
      requestId: 'req-422',
      details: {
        code: 'unknown_field',
        param: 'timefrme',
        errors: UNKNOWN_FIELD_BODY.errors,
        doc_url: UNKNOWN_FIELD_BODY.doc_url,
      },
    });
    expect(envelope.details).not.toHaveProperty('message');
    expect(envelope.details).not.toHaveProperty('status');
    expect(envelope.details).not.toHaveProperty('request_id');
    // The message appears once at the top and once in the per-field list.
    expect(JSON.stringify(envelope).split(UNKNOWN_FIELD_BODY.message).length - 1).toBe(2);
  });

  it('apiErrorDetails keeps fields that differ from the envelope', () => {
    expect(apiErrorDetails({ message: 'Other text', status: 400, error: 'Title' }, 'Top message', 422)).toEqual({ message: 'Other text', status: 400, error: 'Title' });
  });
});

describe('browser-session validation errors', () => {
  it('keep the field-level parts of a 422', async () => {
    const { api, bundle } = await sessionApi();
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(422, UNKNOWN_FIELD_BODY)));
    const error = await api.tokenInformation({ tokenAddress: 'So11111111111111111111111111111111111111112', chain: 'solana' }).catch(e => e);

    expect(error.code).toBe(ErrorCode.INVALID_PARAMS);
    expect(error.message).toBe(UNKNOWN_FIELD_BODY.message);
    expect(error.details).toMatchObject({ code: 'unknown_field', param: 'timefrme', errors: UNKNOWN_FIELD_BODY.errors });
    expect(JSON.stringify(error.details)).not.toContain(bundle.accessToken);
  });

  it('map the field code like an API-key request does', async () => {
    const { api } = await sessionApi();
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(422, {
      ...UNKNOWN_FIELD_BODY,
      error: 'Missing field',
      message: "Required field 'body -> token_address' is missing",
      code: 'missing_field',
      param: 'token_address',
      errors: [{ field: 'body.token_address', message: "Required field 'body -> token_address' is missing", code: 'missing_field' }],
    })));
    const error = await api.tokenInformation({ chain: 'solana' }).catch(e => e);
    expect(error.code).toBe(ErrorCode.MISSING_PARAM);
  });

  it('drop any string that echoes the credential', () => {
    const secret = 'secret-token-value';
    const result = sessionValidationDetails({
      message: `Field 'authorization' is not recognized: Bearer ${secret}`,
      code: 'unknown_field',
      errors: [{ field: 'body.x', message: `bad ${secret}`, code: 'unknown_field' }, { field: 'body.y', message: 'fine', code: 'unknown_field' }],
    }, [secret]);
    expect(result).toEqual({ message: 'fine', details: { code: 'unknown_field', errors: [{ field: 'body.y', message: 'fine', code: 'unknown_field' }] } });
  });

  it('still hide the body of a non-validation error', async () => {
    const { api } = await sessionApi();
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(500, { message: 'internal detail', code: 'internal_error' })));
    const error = await api.tokenInformation({ tokenAddress: 'So11111111111111111111111111111111111111112', chain: 'solana' }).catch(e => e);
    expect(error.message).not.toContain('internal detail');
    expect(error.details).not.toHaveProperty('message');
  });
});

describe('connection failure vs rejected key', () => {
  it('says a connection failure is not a key problem and names the cause', async () => {
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND api.nansen.ai'), { code: 'ENOTFOUND' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed', { cause }); }));
    const api = new NansenAPI('test-key', 'https://api.nansen.ai', { retry: { maxRetries: 0 } });
    const error = await api.smartMoneyNetflow({}).catch(e => e);
    expect(error.code).toBe(ErrorCode.NETWORK_ERROR);
    expect(error.message).toBe('Could not reach the Nansen API at https://api.nansen.ai (ENOTFOUND). Check your internet connection, VPN, proxy or firewall, then retry. Your credentials were not checked, so this is not an API key problem.');
  });

  it('omits the cause for a browser session', () => {
    expect(networkErrorMessage('https://api.nansen.ai/x', new Error('boom'), { redact: true })).toBe('Could not reach the Nansen API at https://api.nansen.ai. Check your internet connection, VPN, proxy or firewall, then retry. Your credentials were not checked, so this is not an API key problem.');
  });

  it('says a 401 is the key, not the connection', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401, { message: 'Invalid API key', code: 'unauthenticated' })));
    const api = new NansenAPI('bad-key', 'https://api.nansen.ai', { retry: { maxRetries: 0 } });
    const error = await api.smartMoneyNetflow({}).catch(e => e);
    expect(error.code).toBe(ErrorCode.UNAUTHORIZED);
    expect(error.message).toBe('Invalid API key. The connection works; run nansen login or rotate the key at https://app.nansen.ai/api?tab=api.');
  });

  it('does not repeat the key page when the server message links it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401, { message: 'Invalid API key. Manage your keys at https://app.nansen.ai/api?tab=api.', code: 'unauthenticated' })));
    const api = new NansenAPI('bad-key', 'https://api.nansen.ai', { retry: { maxRetries: 0 } });
    const error = await api.smartMoneyNetflow({}).catch(e => e);
    expect(error.code).toBe(ErrorCode.UNAUTHORIZED);
    expect(error.message).toBe('Invalid API key. Manage your keys at https://app.nansen.ai/api?tab=api. The connection works; run nansen login or rotate the key.');
  });
});
