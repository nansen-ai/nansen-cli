import { generateKeyPairSync, createPrivateKey, createPublicKey, createHash, randomUUID, sign } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { AuthError, trustedIssuer } from './auth-credentials.js';

const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
export function createDeviceKey() {
  return generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'jwk' });
}
export function deviceProof(privateJwk, url, nonce, now = Date.now()) {
  const key = createPrivateKey({ key: privateJwk, format: 'jwk' });
  const jwk = createPublicKey(key).export({ format: 'jwk' });
  const input = `${encode({ typ: 'dpop+jwt', alg: 'ES256', jwk })}.${encode({ htm: 'POST', htu: url, jti: randomUUID(), iat: Math.floor(now / 1000), ...(nonce && { nonce }) })}`;
  return `${input}.${sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}
const transportError = () => new AuthError('AUTH_NETWORK_ERROR', 'Authentication service unavailable or timed out. Retry later. If token issuance completed but its response was lost, run nansen login again; remote cleanup may be unconfirmed.');
async function readResponse(response) {
  // Read incrementally: never buffer an unbounded credential-bearing response.
  if (!response.body?.getReader) return response.json(); // injected test transports
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 32768) { await reader.cancel(); throw new Error(); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString());
  } finally { reader.releaseLock(); }
}
export function createDeviceClient({ audience, privateJwk = createDeviceKey(), fetchFn = globalThis.fetch, now = Date.now } = {}) {
  const issuer = trustedIssuer(audience);
  let nonce;
  async function request(route, body, signal, timeout = 15000) {
    for (let attempt = 0; attempt < 2; attempt++) {
      signal?.throwIfAborted();
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, Math.max(1, timeout));
      try {
        const url = issuer + route;
        const response = await fetchFn(url, { method: 'POST', redirect: 'error', signal: controller.signal, headers: { 'Content-Type': 'application/json', DPoP: deviceProof(privateJwk, url, nonce, now()) }, body: JSON.stringify(body) });
        const data = await readResponse(response);
        const nextNonce = response.headers.get('dpop-nonce');
        if (nextNonce && nextNonce.length <= 1024) nonce = nextNonce;
        if (response.status === 401 && data.error === 'use_dpop_nonce' && nextNonce && attempt === 0) continue;
        return { response, data };
      } catch {
        signal?.throwIfAborted();
        throw transportError();
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
    }
  }
  return {
    issuer, audience, privateJwk, request,
    async verify(accessToken, signal) {
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.throwIfAborted();
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, 15000);
      try {
        const response = await fetchFn(`${audience}/api/v1/account`, { method: 'GET', redirect: 'error', signal: controller.signal, headers: { Authorization: `Bearer ${accessToken}` } });
        if (!response.ok) throw new AuthError(response.status === 401 ? 'INVALID_BROWSER_SESSION' : 'SESSION_VERIFICATION_FAILED', response.status === 401 ? 'The new browser session was rejected. Run nansen login again.' : 'Could not verify the new session. The previous credential is unchanged. Retry later.');
        const data = await readResponse(response);
        if (typeof data.user_id !== 'string' || !data.user_id || data.user_id.length > 255 || [...data.user_id].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) throw new AuthError('SESSION_VERIFICATION_FAILED', 'Account verification returned an invalid account identity. The previous credential is unchanged.');
        return data.user_id;
      } catch (error) {
        signal?.throwIfAborted();
        if (error instanceof AuthError) throw error;
        throw transportError();
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
    },
  };
}
export function validateSession(bundle, now = Date.now()) {
  try {
    if (bundle.issuer !== trustedIssuer(bundle.audience) || bundle.scope !== 'nansen:read' || typeof bundle.refreshToken !== 'string' || !bundle.refreshToken || bundle.refreshToken.length > 4096 || typeof bundle.accessToken !== 'string') throw new Error();
    const [header, payload, signature, extra] = bundle.accessToken.split('.');
    const h = JSON.parse(Buffer.from(header, 'base64url'));
    const claims = JSON.parse(Buffer.from(payload, 'base64url'));
    const publicJwk = createPublicKey(createPrivateKey({ key: bundle.privateJwk, format: 'jwk' })).export({ format: 'jwk' });
    const jkt = createHash('sha256').update(JSON.stringify({ crv: publicJwk.crv, kty: publicJwk.kty, x: publicJwk.x, y: publicJwk.y })).digest('base64url');
    if (extra || !signature || h.alg !== 'ES256' || publicJwk.crv !== 'P-256' || claims.iss !== bundle.issuer || claims.aud !== bundle.audience || claims.scope !== 'nansen:read' || claims.cnf?.jkt !== jkt || !Number.isFinite(claims.exp) || !Number.isFinite(bundle.expiresAt) || bundle.expiresAt > claims.exp * 1000) throw new Error();
    if (claims.session_access_revocation_version !== 1) throw new AuthError('BROWSER_SESSION_SETUP_REQUIRED', 'The session lacks supported revocation coverage. Browser login may not be enabled for this cohort. Ask the operator to verify issuer SESSION_ACCESS_REVOCATION_ENABLED and API BROWSER_SESSION_ACCOUNT_ENABLED before retrying; repeated pairing will not repair server setup.');
    if (bundle.expiresAt <= now) throw new AuthError('SESSION_EXPIRED', 'The saved browser session has expired. Run: nansen login. Automatic renewal is not available in this prerelease.');
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AuthError('INVALID_BROWSER_SESSION', 'The selected browser session is invalid. Run: nansen login.');
  }
}
export async function pairDevice(client, { signal, onPending, onIssued, onBeforePoll, now = Date.now, wait = (ms, signal) => delay(ms, undefined, { signal }) } = {}) {
  const { response, data } = await client.request('/auth/device/authorize', { audience: client.audience, scope: 'nansen:read', client_label: 'nansen CLI' }, signal);
  if (!response.ok) throw new AuthError('PAIRING_FAILED', 'Could not start browser approval. Retry nansen login later.');
  if (typeof data.device_code !== 'string' || !data.device_code || typeof data.user_code !== 'string' || !/^[A-Za-z0-9-]{4,32}$/.test(data.user_code) || !Number.isFinite(data.expires_in) || data.expires_in <= 0 || data.expires_in > 3600 || !Number.isFinite(data.interval) || data.interval < 1 || data.interval > 600) throw new AuthError('PAIRING_FAILED', 'The pairing service returned an invalid grant. Retry later.');
  const expected = `${client.issuer}/device`;
  const complete = new URL(expected);
  complete.searchParams.set('user_code', data.user_code);
  if (data.verification_uri !== expected || data.verification_uri_complete !== complete.toString()) throw new AuthError('PAIRING_FAILED', 'The pairing service returned an untrusted verification URL.');
  const deadline = now() + data.expires_in * 1000;
  await onPending({ verification_uri: complete.toString(), user_code: data.user_code, expires_at: new Date(deadline).toISOString() });
  let interval = data.interval * 1000;
  let failures = 0;
  let pollInFlight = false;
  try {
    while (now() < deadline) {
      await wait(Math.min(interval, deadline - now()), signal);
      if (now() >= deadline) break;
      let result;
      await onBeforePoll?.();
      signal?.throwIfAborted();
      pollInFlight = true;
      try { result = await client.request('/auth/device/token', { device_code: data.device_code }, signal, Math.min(15000, deadline - now())); }
      catch (error) {
        if (error.code !== 'AUTH_NETWORK_ERROR' || ++failures > 2) throw error;
        interval = Math.min(interval * 2, 60000); continue;
      }
      const { response: poll, data: tokens } = result;
      if (poll.ok) {
        const bundle = { issuer: client.issuer, audience: client.audience, privateJwk: client.privateJwk, accessToken: tokens.access_token, refreshToken: tokens.refresh_token, scope: tokens.scope };
        // Retain cleanup authority even if the rest of the issuance is malformed.
        onIssued?.(bundle);
        if (tokens.token_type !== 'Bearer' || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0 || tokens.expires_in > 3600) throw new AuthError('PAIRING_FAILED', 'Invalid token response. Run nansen login again.');
        let exp;
        try { exp = JSON.parse(Buffer.from(tokens.access_token.split('.')[1], 'base64url')).exp * 1000; } catch { /* validation below */ }
        if (!Number.isFinite(exp)) throw new AuthError('PAIRING_FAILED', 'Invalid token response. Run nansen login again.');
        bundle.expiresAt = Math.min(now() + tokens.expires_in * 1000, exp);
        validateSession(bundle, now());
        bundle.accountId = await client.verify(bundle.accessToken, signal);
        return bundle;
      }
      const retryAfter = Number(poll.headers.get('retry-after')) * 1000;
      if (poll.status === 429 || poll.status >= 500) {
        if (++failures <= 2) { interval = Math.max(interval * 2, Number.isFinite(retryAfter) ? retryAfter : 0); continue; }
        throw transportError();
      }
      if (poll.status === 400 && tokens.error === 'authorization_pending') { pollInFlight = false; continue; }
      if (poll.status === 400 && tokens.error === 'slow_down') { pollInFlight = false; interval = Math.max(interval + 5000, Number.isFinite(retryAfter) ? retryAfter : 0); continue; }
      if (tokens.error === 'access_denied') throw Object.assign(new AuthError('PAIRING_DENIED', 'Browser approval was denied. The previous credential is unchanged.'), { provenUnissued: failures === 0 });
      if (tokens.error === 'expired_token') break;
      throw new AuthError('PAIRING_FAILED', 'Browser approval could not be redeemed. Run nansen login again.');
    }
    throw Object.assign(new AuthError('PAIRING_EXPIRED', 'The approval code expired or was consumed. Run nansen login again.'), { provenUnissued: failures === 0 });
  } catch (error) {
    // Only this live attempt can prove cancellation before issuance. Never
    // rewrite the durable marker on pending: a later crash stays conservative.
    if (signal?.aborted) error.provenUnissued = failures === 0 && !pollInFlight;
    throw error;
  }
}
export async function retireSession(bundle, options = {}) {
  try {
    if (bundle.issuer !== trustedIssuer(bundle.audience) || typeof bundle.refreshToken !== 'string' || !bundle.refreshToken) return { remote: 'unconfirmed' };
    const client = createDeviceClient({ ...options, audience: bundle.audience, privateJwk: bundle.privateJwk });
    const { response, data } = await client.request('/token/revoke', { refresh_token: bundle.refreshToken });
    if (!response.ok || data.refresh_family_revoked !== true) return { remote: 'unconfirmed' };
    if (data.access_revocation?.status === 'recorded' && data.access_revocation.coverage === 'complete_family' && data.access_revocation.propagation === 'pending' && data.access_revocation.version === 1) return { remote: 'recorded_pending' };
    // Only the pinned recorded/pending and legacy refresh-only receipts are
    // supported. An invented access_tokens_revoked:true is not proof of
    // gateway propagation; unknown/future shapes remain unconfirmed.
    if (data.access_tokens_revoked === false) return { remote: 'refresh_only' };
  } catch { /* bounded best effort, never expose transport or proof material */ }
  return { remote: 'unconfirmed' };
}
