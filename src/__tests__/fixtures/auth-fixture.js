import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { createDeviceKey } from '../../auth-device.js';
export function sessionFixture({ audience = 'https://api.nansen.ai', accountId = 'account-B', now = Date.now(), padding = '' } = {}) {
  const privateJwk = createDeviceKey();
  return issuedFixture(privateJwk, { audience, accountId, now, padding });
}
export function issuedFixture(privateJwk, { audience = 'https://api.nansen.ai', accountId = 'account-B', now = Date.now(), padding = '' } = {}) {
  const key = createPrivateKey({ key: privateJwk, format: 'jwk' });
  const publicJwk = createPublicKey(key).export({ format: 'jwk' });
  const jkt = createHash('sha256').update(JSON.stringify({ crv: publicJwk.crv, kty: publicJwk.kty, x: publicJwk.x, y: publicJwk.y })).digest('base64url');
  const issuer = audience.replace('api.', 'idp.');
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const exp = Math.floor(now / 1000) + 3600;
  const input = `${encode({ alg: 'ES256' })}.${encode({ iss: issuer, aud: audience, sub: accountId, cnf: { jkt }, exp, iat: Math.floor(now / 1000), nbf: Math.floor(now / 1000), scope: 'nansen:api', session_access_revocation_version: 1, padding })}`;
  return { issuer, audience, privateJwk, accessToken: `${input}.${sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`, refreshToken: 'synthetic-refresh-secret', scope: 'nansen:api', expiresAt: exp * 1000, accountId };
}
export function memoryOperation() {
  const entries = new Map();
  return { entries, operation: async (op, name, bytes) => {
    if (op === 'set') { entries.set(name, Buffer.from(bytes)); return true; }
    if (op === 'get') return entries.get(name) || null;
    if (op === 'delete') return entries.delete(name);
  } };
}
