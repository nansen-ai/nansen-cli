import { describe, it, expect, vi } from 'vitest';
import { createPublicKey, verify } from 'node:crypto';
import { createDeviceClient, pairDevice, retireSession, validateSession } from '../auth-device.js';
import { issuedFixture, sessionFixture } from './fixtures/auth-fixture.js';
const response = (status, data, headers = {}) => new Response(JSON.stringify(data), { status, headers });
function grant() { return { device_code: 'PRIVATE_DEVICE_CODE', user_code: 'ABCD-EFGH', verification_uri: 'https://idp.nansen.ai/device', verification_uri_complete: 'https://idp.nansen.ai/device?user_code=ABCD-EFGH', expires_in: 600, interval: 5 }; }

describe('device contract', () => {
  it('uses fresh ES256 proofs and one key, rotates nonces, backs off cumulatively, verifies B without ambient A', async () => {
    let now = 1800000000000;
    const times = [];
    const requests = [];
    let polls = 0;
    let key;
    const jtis = new Set();
    process.env.NANSEN_API_KEY = 'ENV_ACCOUNT_A';
    const fetchFn = vi.fn(async (url, options) => {
      requests.push({ url, options });
      expect(options.redirect).toBe('error');
      if (url.endsWith('/account')) {
        expect(Object.keys(options.headers)).toEqual(['Authorization']);
        expect(options.headers.Authorization).not.toContain('ENV_ACCOUNT_A');
        return response(200, { user_id: 'account-B', credits_remaining: 0 });
      }
      const [h, p, s] = options.headers.DPoP.split('.');
      const header = JSON.parse(Buffer.from(h, 'base64url'));
      const payload = JSON.parse(Buffer.from(p, 'base64url'));
      expect(header).toMatchObject({ alg: 'ES256', typ: 'dpop+jwt' });
      expect(header.jwk.d).toBeUndefined();
      expect(verify('sha256', Buffer.from(`${h}.${p}`), { key: createPublicKey({ key: header.jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'))).toBe(true);
      expect(payload.htm).toBe('POST'); expect(payload.htu).toBe(url);
      expect(jtis.has(payload.jti)).toBe(false); jtis.add(payload.jti);
      key ||= header.jwk; expect(header.jwk).toEqual(key);
      if (requests.length === 1) return response(401, { error: 'use_dpop_nonce' }, { 'DPoP-Nonce': 'nonce-1' });
      expect(payload.nonce).toBe(`nonce-${requests.length - 1}`);
      const headers = { 'DPoP-Nonce': `nonce-${requests.length}` };
      if (url.endsWith('/authorize')) {
        expect(JSON.parse(options.body)).toEqual({ audience: 'https://api.nansen.ai', scope: 'nansen:read', client_label: 'nansen CLI' });
        return response(200, grant(), headers);
      }
      if (++polls <= 2) return response(400, { error: 'slow_down' }, headers);
      const bundle = issuedFixture(client.privateJwk, { now });
      return response(200, { access_token: bundle.accessToken, refresh_token: bundle.refreshToken, token_type: 'Bearer', scope: 'nansen:read', expires_in: 3600 }, headers);
    });
    const client = createDeviceClient({ audience: 'https://api.nansen.ai', fetchFn, now: () => now });
    const events = [];
    const result = await pairDevice(client, { now: () => now, wait: async ms => { times.push(ms); now += ms; }, onPending: value => events.push(value) });
    expect(times).toEqual([5000, 10000, 15000]);
    expect(result.accountId).toBe('account-B');
    expect(JSON.stringify(events)).not.toContain('PRIVATE_DEVICE_CODE');
    expect(createDeviceClient({ audience: client.audience }).privateJwk).not.toEqual(client.privateJwk);
  });
  it.each(['access_denied', 'expired_token', 'invalid_dpop_proof'])('terminates %s without automatic pairing', async error => {
    const fetchFn = vi.fn().mockResolvedValueOnce(response(200, grant())).mockResolvedValue(response(400, { error }));
    await expect(pairDevice(createDeviceClient({ audience: 'https://api.nansen.ai', fetchFn }), { wait: async () => {}, onPending: () => {} })).rejects.toThrow();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
  it('rejects hostile browser destinations before pending output', async () => {
    const onPending = vi.fn();
    const fetchFn = vi.fn().mockResolvedValue(response(200, { ...grant(), verification_uri_complete: 'https://evil.invalid/device' }));
    await expect(pairDevice(createDeviceClient({ audience: 'https://api.nansen.ai', fetchFn }), { onPending })).rejects.toThrow('untrusted');
    expect(onPending).not.toHaveBeenCalled();
  });
  it('uses old family authority for retirement and reports pending propagation', async () => {
    const old = sessionFixture();
    const fetchFn = vi.fn().mockResolvedValue(response(200, { refresh_family_revoked: true, access_revocation: { status: 'recorded', coverage: 'complete_family', propagation: 'pending', version: 1 } }));
    expect(await retireSession(old, { fetchFn })).toEqual({ remote: 'recorded_pending' });
    const [url, options] = fetchFn.mock.calls[0];
    expect(url).toBe(old.issuer + '/token/revoke');
    expect(JSON.parse(options.body)).toEqual({ refresh_token: old.refreshToken });
    expect(options.headers.Authorization).toBeUndefined();
  });
  it('keeps infrastructure failures redacted and does not validate through env A', async () => {
    const fetchFn = vi.fn().mockResolvedValue(response(503, { error: 'echo-secret' }));
    const client = createDeviceClient({ audience: 'https://api.nansen.ai', fetchFn });
    await expect(client.verify('candidate-B')).rejects.toMatchObject({ code: 'SESSION_VERIFICATION_FAILED' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

it('treats an unsupported immediate-revocation receipt conservatively', async () => {
  expect(await retireSession(sessionFixture(), { fetchFn: async () => response(200, { refresh_family_revoked: true, access_tokens_revoked: true }) })).toEqual({ remote: 'unconfirmed' });
});
it.each(['access_denied', 'expired_token'])('classifies %s as unissued only without an ambiguous response', async error => {
  for (const uncertain of [false, true]) {
    const fetchFn = vi.fn().mockResolvedValueOnce(response(200, grant()));
    if (uncertain) fetchFn.mockRejectedValueOnce(new Error('lost response'));
    fetchFn.mockResolvedValue(response(400, { error }));
    const beforePoll = vi.fn();
    await expect(pairDevice(createDeviceClient({ audience: 'https://api.nansen.ai', fetchFn }), { wait: async () => {}, onPending: () => {}, onBeforePoll: beforePoll })).rejects.toMatchObject({ provenUnissued: !uncertain });
    expect(beforePoll).toHaveBeenCalled();
  }
});

it('names cohort setup gates without inferring their actual server values', () => {
  const bundle = sessionFixture(); const parts = bundle.accessToken.split('.');
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url')); delete claims.session_access_revocation_version;
  parts[1] = Buffer.from(JSON.stringify(claims)).toString('base64url'); bundle.accessToken = parts.join('.');
  expect(() => validateSession(bundle)).toThrow('may not be enabled');
  expect(() => validateSession(bundle)).toThrow('SESSION_ACCESS_REVOCATION_ENABLED');
  expect(() => validateSession(bundle)).toThrow('BROWSER_SESSION_ACCOUNT_ENABLED');
});
it.each(['not-a-jwt', 'e30.e30.signature'])('reports malformed issued expiry as a token-response failure (%s)', async access_token => {
  const onIssued = vi.fn();
  const fetchFn = vi.fn().mockResolvedValueOnce(response(200, grant())).mockResolvedValueOnce(response(200, { access_token, refresh_token: 'synthetic-cleanup-authority', token_type: 'Bearer', scope: 'nansen:read', expires_in: 3600 }));
  await expect(pairDevice(createDeviceClient({ audience: 'https://api.nansen.ai', fetchFn }), { wait: async () => {}, onPending: () => {}, onIssued })).rejects.toMatchObject({ code: 'PAIRING_FAILED', message: 'Invalid token response. Run nansen login again.' });
  expect(onIssued).toHaveBeenCalledOnce();
  expect(onIssued.mock.calls[0][0].refreshToken).toBe('synthetic-cleanup-authority');
  expect(onIssued.mock.calls[0][0]).not.toHaveProperty('expiresAt');
});
