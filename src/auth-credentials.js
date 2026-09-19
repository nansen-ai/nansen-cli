import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_API_ORIGIN = 'https://api.nansen.ai';
const DEV_CONFIG = fileURLToPath(new URL('../config.json', import.meta.url));
export class AuthError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export function authDirectory(env = process.env) {
  return path.join(env.HOME || env.USERPROFILE || '', '.nansen');
}
export function trustedIssuer(audience) {
  const issuer = {
    'https://api.nansen.ai': 'https://idp.nansen.ai',
    'https://api.banansen.dev': 'https://idp.banansen.dev',
  }[audience];
  if (!issuer) throw new AuthError('AUTH_ORIGIN_UNSUPPORTED', 'Browser sessions require the Nansen production or staging API origin. Check the selected origin in NANSEN_BASE_URL or config.json baseUrl; plain login preserves it.');
  return issuer;
}
export function validAuthPointer(auth) {
  if (!auth || ![1, 2].includes(auth.version) || !['none', 'api-key', 'session'].includes(auth.active?.kind)) return false;
  if (auth.version === 1) return true; // Preserve the pre-renewal reader's format contract.
  if (auth.version === 2 && (typeof auth.selectionEpoch !== 'string' || !/^[a-f0-9-]{36}$/.test(auth.selectionEpoch))) return false;
  return auth.active.kind !== 'session' || (typeof auth.active.generation === 'string' && /^[a-f0-9-]{36}$/.test(auth.active.generation) &&
    typeof auth.selectionEpoch === 'string' && /^[a-f0-9-]{36}$/.test(auth.selectionEpoch) &&
    ['issuer', 'audience', 'accountId'].every(k => typeof auth.active[k] === 'string' && auth.active[k].length > 0 && auth.active[k].length <= 255) && Number.isFinite(auth.active.expiresAt));
}
export function readAuthConfig(env = process.env, devConfigPath = DEV_CONFIG) {
  const userPath = path.join(authDirectory(env), 'config.json');
  const configPath = fs.existsSync(userPath) ? userPath : fs.existsSync(devConfigPath) ? devConfigPath : null;
  let config = {};
  let configError = null;
  if (configPath) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error();
    } catch (err) { config = {}; configError = err instanceof SyntaxError ? 'parse' : 'unreadable'; }
  }
  if (config.auth && !validAuthPointer(config.auth)) configError = 'format';
  return { config, configPath, configError, configFileExists: fs.existsSync(userPath), devConfigPath };
}
export function resolveCredential({ env = process.env, explicitKey, snapshot = readAuthConfig(env) } = {}) {
  if (explicitKey !== undefined) return explicitKey === null ? { kind: 'anonymous', source: null } : { kind: 'api-key', source: 'explicit', apiKey: explicitKey };
  if (env.NANSEN_API_KEY !== undefined) return { kind: 'api-key', source: 'env', apiKey: env.NANSEN_API_KEY };
  if (snapshot.configError) return { kind: 'invalid', source: 'config', error: snapshot.configError };
  const { config } = snapshot;
  if (config.auth?.active?.kind === 'session') return { kind: 'session', source: 'session', ...config.auth.active, selectionEpoch: config.auth.selectionEpoch };
  if (config.auth?.active?.kind === 'none') return { kind: 'anonymous', source: null };
  if (config.apiKey !== undefined && config.apiKey !== null) return { kind: 'api-key', source: snapshot.configPath === snapshot.devConfigPath ? 'dev-config' : 'config', apiKey: config.apiKey };
  if (config.auth?.active?.kind === 'api-key') return { kind: 'invalid', source: 'config' };
  return { kind: 'anonymous', source: null };
}
export function assertUsableSelection(selection) {
  if (selection.kind === 'invalid') throw new AuthError('AUTH_STATE_INVALID', 'Saved authentication is unreadable. Restore config.json or run nansen logout after repairing its permissions.');
  if (selection.kind === 'api-key' && (typeof selection.apiKey !== 'string' || !selection.apiKey.trim())) throw new AuthError('INVALID_API_KEY', 'The selected API key is empty or invalid. Correct it or unset NANSEN_API_KEY.');
}
export function authConfigView(env = process.env, devConfigPath) {
  const snapshot = readAuthConfig(env, devConfigPath);
  const selected = resolveCredential({ env, snapshot });
  return {
    ...snapshot,
    apiKey: selected.kind === 'api-key' ? selected.apiKey : null,
    apiKeySource: selected.kind === 'api-key' ? selected.source : null,
    selected,
    baseUrl: env.NANSEN_BASE_URL || snapshot.config.baseUrl || DEFAULT_API_ORIGIN,
    baseUrlSource: env.NANSEN_BASE_URL ? 'env' : snapshot.config.baseUrl ? 'config' : 'default',
  };
}
