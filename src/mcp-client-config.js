/**
 * Canonical MCP client install config (API-322).
 *
 * src/mcp-client-config.json is the one maintained source for the hosted MCP
 * endpoint, the API-key header, the server-name key, the API-key URLs and the
 * mcp-remote pin. This module loads and validates it, and builds the client
 * config shapes from it. `nansen mcp install`, `nansen mcp verify`, the
 * generated README regions (scripts/generate-mcp-docs.js), the public docs
 * page and the nansen-mcp-dxt manifest all derive from the same file.
 */

import fs from 'fs';

export const MCP_CLIENT_CONFIG_PATH = new URL('./mcp-client-config.json', import.meta.url);

// The only host that may receive the API key. This is a safety invariant, not
// a second copy of the endpoint: `install` writes the key into a config that
// sends it to `endpoint`, so a typo here must fail loudly at load time.
const MCP_HOST = 'mcp.nansen.ai';
const APP_HOST = 'app.nansen.ai';

const KNOWN_KEYS = [
  '$comment',
  'schemaVersion',
  'serverKey',
  'endpoint',
  'oauthEndpoint',
  'apiKeyHeader',
  'apiKeyEnvVar',
  'apiKeySetupUrl',
  'apiKeyManageUrl',
  'docsUrl',
  'dxtDownloadUrl',
  'mcpRemote',
];

function fail(message) {
  throw new Error(`Invalid MCP client config: ${message}`);
}

function requireString(config, key) {
  const value = config[key];
  if (typeof value !== 'string' || value.trim() === '' || value !== value.trim()) {
    fail(`"${key}" must be a non-empty string without surrounding whitespace`);
  }
  return value;
}

function requireHttpsUrl(config, key, { host, exactPath = false } = {}) {
  const value = requireString(config, key);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(`"${key}" is not a URL: ${value}`);
  }
  if (parsed.protocol !== 'https:') fail(`"${key}" must use https: ${value}`);
  if (parsed.username || parsed.password) fail(`"${key}" must not contain credentials`);
  // Docs paste these URLs into shell commands and markdown links.
  if (/[\s'"`()<>$\\]/.test(value)) fail(`"${key}" contains a character that is unsafe in docs or shell: ${value}`);
  if (parsed.hash) fail(`"${key}" must not contain a fragment: ${value}`);
  if (host && parsed.hostname !== host) fail(`"${key}" must be on ${host}: ${value}`);
  if (exactPath) {
    // MCP endpoints: no query, no trailing slash, no port. The trailing-slash
    // form was drift in the old .dxt manifest.
    if (parsed.search) fail(`"${key}" must not contain a query: ${value}`);
    if (parsed.port) fail(`"${key}" must not set a port: ${value}`);
    if (parsed.pathname.endsWith('/')) fail(`"${key}" must not end with "/": ${value}`);
    if (value !== `${parsed.origin}${parsed.pathname}`) fail(`"${key}" is not in canonical form: ${value}`);
    if (!/^\/[A-Za-z0-9/_-]+$/.test(parsed.pathname)) fail(`"${key}" path must match ^/[A-Za-z0-9/_-]+$: ${value}`);
  }
  return value;
}

/**
 * Validate a parsed config object. Returns it frozen, or throws an Error that
 * names the bad field. Unknown keys fail too, so a misspelled key cannot be
 * silently ignored by one consumer and read by another.
 */
export function validateMcpClientConfig(config) {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) fail('must be a JSON object');
  const unknown = Object.keys(config).filter(key => !KNOWN_KEYS.includes(key));
  if (unknown.length) fail(`unknown key(s): ${unknown.join(', ')}`);
  if (config.schemaVersion !== 1) fail('"schemaVersion" must be 1');

  const serverKey = requireString(config, 'serverKey');
  if (!/^[a-z][a-z0-9-]*$/.test(serverKey)) fail(`"serverKey" must match ^[a-z][a-z0-9-]*$: ${serverKey}`);
  requireHttpsUrl(config, 'endpoint', { host: MCP_HOST, exactPath: true });
  requireHttpsUrl(config, 'oauthEndpoint', { host: MCP_HOST, exactPath: true });
  if (config.endpoint === config.oauthEndpoint) fail('"endpoint" and "oauthEndpoint" must differ');

  const header = requireString(config, 'apiKeyHeader');
  // mcp-remote parses --header values with /^([A-Za-z0-9_-]+):\s*(.*)$/.
  if (!/^[A-Za-z0-9-]+$/.test(header)) fail(`"apiKeyHeader" must match ^[A-Za-z0-9-]+$: ${header}`);
  const envVar = requireString(config, 'apiKeyEnvVar');
  // NANSEN_ prefix: the key is written into the stdio `env` block under this
  // name, so it must never shadow PATH, NODE_OPTIONS or similar.
  if (!/^NANSEN_[A-Z0-9_]+$/.test(envVar)) fail(`"apiKeyEnvVar" must match ^NANSEN_[A-Z0-9_]+$: ${envVar}`);

  requireHttpsUrl(config, 'apiKeySetupUrl', { host: APP_HOST });
  requireHttpsUrl(config, 'apiKeyManageUrl', { host: APP_HOST });
  requireHttpsUrl(config, 'docsUrl', { host: 'docs.nansen.ai' });
  const dxt = requireHttpsUrl(config, 'dxtDownloadUrl', { host: 'github.com' });
  if (!dxt.startsWith('https://github.com/nansen-ai/nansen-mcp-dxt/')) fail(`"dxtDownloadUrl" must be in nansen-ai/nansen-mcp-dxt: ${dxt}`);

  const remote = config.mcpRemote;
  if (typeof remote !== 'object' || remote === null || Array.isArray(remote)) fail('"mcpRemote" must be an object');
  const remoteUnknown = Object.keys(remote).filter(key => key !== 'package' && key !== 'version');
  if (remoteUnknown.length) fail(`unknown mcpRemote key(s): ${remoteUnknown.join(', ')}`);
  if (remote.package !== 'mcp-remote') fail('"mcpRemote.package" must be "mcp-remote"');
  // Exact version only: npx must never resolve a range or a dist-tag, because
  // the bridge carries the API key on every request.
  if (typeof remote.version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(remote.version)) {
    fail(`"mcpRemote.version" must be an exact x.y.z version: ${remote.version}`);
  }

  return Object.freeze({ ...config, mcpRemote: Object.freeze({ ...remote }) });
}

export function loadMcpClientConfig(source = MCP_CLIENT_CONFIG_PATH) {
  const raw = fs.readFileSync(source, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid MCP client config: ${err.message}`, { cause: err });
  }
  return validateMcpClientConfig(parsed);
}

export const MCP_CLIENT_CONFIG = loadMcpClientConfig();

/** `mcp-remote@x.y.z`, the exact spec passed to `npx -y`. */
export function mcpRemoteSpec(config = MCP_CLIENT_CONFIG) {
  return `${config.mcpRemote.package}@${config.mcpRemote.version}`;
}

/**
 * The single `--header` value for mcp-remote. `${VAR}` is not shell syntax:
 * mcp-remote substitutes it from its own process env, so the key stays out of
 * argv. See the comment in buildServerEntry (src/commands/mcp.js).
 */
export function mcpRemoteHeaderArg(config = MCP_CLIENT_CONFIG) {
  return `${config.apiKeyHeader}:\${${config.apiKeyEnvVar}}`;
}

/** Streamable-HTTP entry. `type: 'http'` is required by Claude Code, rejected by nothing else we write. */
export function buildHttpEntry(apiKey, { withType = false, config = MCP_CLIENT_CONFIG } = {}) {
  const entry = withType ? { type: 'http' } : {};
  return { ...entry, url: config.endpoint, headers: { [config.apiKeyHeader]: apiKey } };
}

/** stdio entry that bridges through the pinned mcp-remote via npx. */
export function buildStdioEntry(apiKey, { config = MCP_CLIENT_CONFIG } = {}) {
  return {
    command: 'npx',
    args: ['-y', mcpRemoteSpec(config), config.endpoint, '--header', mcpRemoteHeaderArg(config)],
    env: { [config.apiKeyEnvVar]: apiKey },
  };
}

/** `claude mcp add` one-liner (placeholder only; never pass a real key into docs). */
export function buildClaudeCodeAddCommand(placeholder, { config = MCP_CLIENT_CONFIG } = {}) {
  return `claude mcp add --transport http ${config.serverKey} ${config.endpoint} --header "${config.apiKeyHeader}: ${placeholder}"`;
}
