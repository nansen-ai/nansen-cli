import { generateKeyPairSync, createPrivateKey, createPublicKey, createHash, randomUUID, sign } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import { channel } from 'node:diagnostics_channel';
import { isIP } from 'node:net';
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
const lifetimeError = () => new AuthError('BROWSER_SESSION_SETUP_REQUIRED', 'The issuer returned a session lifetime above the supported 3600 seconds. Ask the session operator to reconcile issuer lifetime configuration and CLI compatibility before pairing again.');
const transportError = () => new AuthError('AUTH_NETWORK_ERROR', 'Authentication service unavailable or timed out. Retry later. If token issuance completed but its response was lost, run nansen login again; remote cleanup may be unconfirmed.');
// Only native Undici lifecycle evidence for this exact invocation can establish
// a pre-connection failure. Proxy CONNECTs, retries, wrappers without evidence,
// response-body errors and arbitrary injected cause codes remain ambiguous.
const dispatchScope = new AsyncLocalStorage();
const connectionFailures = new WeakSet();
async function fetchWithDispatchEvidence(fetchFn, url, options) {
  const scope = {}; const requests = new Map();
  const created = ({ request }) => { if (dispatchScope.getStore() === scope) requests.set(request, { sent: false }); };
  const sent = ({ request }) => { if (requests.has(request)) requests.get(request).sent = true; };
  const failed = ({ request, error }) => { if (requests.has(request)) requests.get(request).error = error; };
  const listeners = [['undici:request:create', created], ['undici:client:sendHeaders', sent], ['undici:request:error', failed]];
  for (const [name, listener] of listeners) channel(name).subscribe(listener);
  try { return await dispatchScope.run(scope, () => fetchFn(url, options)); }
  catch (error) {
    const target = new URL(url); const [entry] = requests;
    const [request, outcome] = entry || [];
    const cause = error?.cause;
    const direct = requests.size === 1 && request.origin === target.origin && request.path === target.pathname && request.method === 'POST' && !outcome.sent && outcome.error === cause;
    const lookup = ['ENOTFOUND', 'EAI_AGAIN'].includes(cause?.code) && cause.syscall === 'getaddrinfo' && cause.hostname === target.hostname;
    const refused = cause?.code === 'ECONNREFUSED' && cause.syscall === 'connect' && isIP(cause.address || '') && cause.port === Number(target.port || (target.protocol === 'https:' ? 443 : 80));
    if (direct && error instanceof TypeError && error.message === 'fetch failed' && cause instanceof Error && Number.isInteger(cause.errno) && (lookup || refused)) {
      const failure = new AuthError('AUTH_CONNECT_UNAVAILABLE', 'Could not establish a connection to the authentication service. Check connectivity and retry later.');
      connectionFailures.add(failure); throw failure;
    }
    throw error;
  } finally { for (const [name, listener] of listeners) channel(name).unsubscribe(listener); }
}
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
    const deadline = performance.now() + timeout;
    for (let attempt = 0; attempt < 2; attempt++) {
      signal?.throwIfAborted();
      if (performance.now() >= deadline) throw transportError();
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, Math.max(1, deadline - performance.now()));
      try {
        const url = issuer + route;
        const response = await fetchWithDispatchEvidence(fetchFn, url, { method: 'POST', redirect: 'error', signal: controller.signal, headers: { 'Content-Type': 'application/json', DPoP: deviceProof(privateJwk, url, nonce, now()) }, body: JSON.stringify(body) });
        const data = await readResponse(response);
        const nextNonce = response.headers.get('dpop-nonce');
        if (nextNonce && nextNonce.length <= 1024) nonce = nextNonce;
        if (response.status === 401 && data?.error === 'use_dpop_nonce' && nextNonce && nextNonce.length <= 1024 && attempt === 0) continue;
        return { response, data };
      } catch (error) {
        signal?.throwIfAborted();
        if (connectionFailures.has(error)) throw error;
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
export function validateSession(bundle, now = Date.now(), { allowExpired = false } = {}) {
  try {
    if (bundle.issuer !== trustedIssuer(bundle.audience) || bundle.scope !== 'nansen:read' || typeof bundle.refreshToken !== 'string' || !bundle.refreshToken || bundle.refreshToken.length > 4096 || typeof bundle.accessToken !== 'string') throw new Error();
    const [header, payload, signature, extra] = bundle.accessToken.split('.');
    const h = JSON.parse(Buffer.from(header, 'base64url'));
    const claims = JSON.parse(Buffer.from(payload, 'base64url'));
    const publicJwk = createPublicKey(createPrivateKey({ key: bundle.privateJwk, format: 'jwk' })).export({ format: 'jwk' });
    const jkt = createHash('sha256').update(JSON.stringify({ crv: publicJwk.crv, kty: publicJwk.kty, x: publicJwk.x, y: publicJwk.y })).digest('base64url');
    if (extra || !signature || h.alg !== 'ES256' || publicJwk.crv !== 'P-256' || claims.iss !== bundle.issuer || claims.aud !== bundle.audience || claims.scope !== 'nansen:read' || claims.cnf?.jkt !== jkt || !Number.isFinite(claims.exp) || !Number.isFinite(bundle.expiresAt) || bundle.expiresAt > claims.exp * 1000) throw new Error();
    if (claims.session_access_revocation_version !== 1) throw new AuthError('BROWSER_SESSION_SETUP_REQUIRED', 'The session lacks supported revocation coverage. Browser login may not be enabled for this cohort. Ask the operator to verify issuer SESSION_ACCESS_REVOCATION_ENABLED and API BROWSER_SESSION_ACCOUNT_ENABLED before retrying; repeated pairing will not repair server setup.');
    if (!Number.isFinite(claims.iat) || !Number.isFinite(claims.nbf) || claims.exp <= claims.iat || typeof claims.sub !== 'string' || !claims.sub || (bundle.accountId !== undefined && claims.sub !== bundle.accountId)) throw new Error();
    if (claims.exp - claims.iat > 3600) throw lifetimeError();
    if (claims.nbf > now / 1000 + 60) throw new AuthError('SESSION_CLOCK_SKEW', 'Session time is ahead of the local clock. Synchronize system time and check issuer clock configuration before retrying login.');
    if (!allowExpired && bundle.expiresAt <= now) throw new AuthError('SESSION_EXPIRED', 'The browser access token has expired. Check system time and issuer lifetime configuration; run nansen login if renewal cannot recover.');
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
        if (!['AUTH_NETWORK_ERROR', 'AUTH_CONNECT_UNAVAILABLE'].includes(error.code) || ++failures > 2) throw error;
        interval = Math.min(interval * 2, 60000); continue;
      }
      const { response: poll, data: tokens } = result;
      if (poll.ok) {
        const bundle = { issuer: client.issuer, audience: client.audience, privateJwk: client.privateJwk, accessToken: tokens.access_token, refreshToken: tokens.refresh_token, scope: tokens.scope };
        // Retain cleanup authority even if the rest of the issuance is malformed.
        onIssued?.(bundle);
        if (tokens.token_type !== 'Bearer' || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0) throw new AuthError('PAIRING_FAILED', 'Invalid token response. Run nansen login again.');
        if (tokens.expires_in > 3600) throw lifetimeError();
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
    const { response, data } = await client.request('/token/revoke', { refresh_token: bundle.refreshToken }, options.signal);
    if (!response.ok || data.refresh_family_revoked !== true) return { remote: 'unconfirmed' };
    if (data.access_revocation?.status === 'recorded' && data.access_revocation.coverage === 'complete_family' && data.access_revocation.propagation === 'pending' && data.access_revocation.version === 1) return { remote: 'recorded_pending' };
    // Only the pinned recorded/pending and legacy refresh-only receipts are
    // supported. An invented access_tokens_revoked:true is not proof of
    // gateway propagation; unknown/future shapes remain unconfirmed.
    if (data.access_tokens_revoked === false) return { remote: 'refresh_only' };
  } catch { /* bounded best effort, never expose transport or proof material */ }
  return { remote: 'unconfirmed' };
}

// Only the owner calls this after durably recording possible consumption.
export async function refreshSession(bundle, { signal, now = Date.now, fetchFn = globalThis.fetch } = {}) {
  const uncertain = () => new AuthError('SESSION_RENEWAL_UNCERTAIN', 'Session renewal outcome is unknown. Run: nansen login. The saved refresh credential was not retried.');
  const started = now();
  const client = createDeviceClient({ audience: bundle.audience, privateJwk: bundle.privateJwk, now, fetchFn });
  let result;
  try { result = await client.request('/token/refresh', { refresh_token: bundle.refreshToken, audience: bundle.audience }, signal, 20000); }
  catch (error) {
    if (connectionFailures.has(error)) throw Object.assign(new AuthError('SESSION_REFRESH_RETRYABLE', error.message), { retryNotBefore: now() + 1000 });
    throw uncertain();
  }
  const { response, data } = result;
  if (!response.ok) {
    if (response.status === 401 && data?.error === 'invalid_refresh_token') throw new AuthError('SESSION_REFRESH_REJECTED', 'The saved session cannot be renewed. Run: nansen login.');
    if (response.status === 400 && data?.error === 'invalid_request') throw new AuthError('SESSION_REFRESH_PROTOCOL_ERROR', 'The issuer rejected the refresh request format. Check CLI/issuer compatibility with the operator before running nansen login.');
    if ((response.status === 429 && data?.error === 'rate_limited') ||
        (response.status === 401 && ['use_dpop_nonce', 'use_dpop_proof', 'invalid_dpop_proof'].includes(data?.error))) {
      const seconds = Number(response.headers.get('retry-after'));
      throw Object.assign(new AuthError('SESSION_REFRESH_RETRYABLE', 'Session renewal was refused before rotation. Check connectivity and system time, then retry later.'), {
        retryNotBefore: now() + (Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 86400) * 1000 : 1000),
      });
    }
    throw uncertain();
  }
  try {
    if (data.token_type !== 'Bearer' || !Number.isFinite(data.expires_in) || data.expires_in <= 0 || data.refresh_token === bundle.refreshToken || data.access_token === bundle.accessToken) throw new Error();
    if (data.expires_in > 3600) throw lifetimeError();
    const exp = JSON.parse(Buffer.from(data.access_token.split('.')[1], 'base64url')).exp * 1000;
    const replacement = { ...bundle, accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt: Math.min(started + data.expires_in * 1000, exp) };
    validateSession(replacement, now());
    return replacement;
  } catch (error) {
    if (error instanceof AuthError && ['BROWSER_SESSION_SETUP_REQUIRED', 'SESSION_CLOCK_SKEW', 'SESSION_EXPIRED'].includes(error.code)) throw error;
    throw uncertain();
  }
}
