/**
 * Nansen CLI - Alerts command
 * Smart alert CRUD with type-specific named flags.
 */

import { NansenError, ErrorCode } from '../api.js';
import { parseCsvOption } from '../query-options.js';
import { unknownCommandError } from '../input-validation.js';

// ============= Channel secret redaction =============

export const REDACTED = '****';

// Webhook hosts with a known URL shape, and how many leading path segments
// identify the channel without granting access: Slack keeps /services/<team>,
// Discord keeps /api/webhooks/<id>. Any other URL keeps only its scheme and
// port, since a custom endpoint can carry a token in any part of its hostname,
// the path or the query.
const KNOWN_WEBHOOK_HOSTS = [
  { host: /^hooks\.slack\.com$/i, keepSegments: 2 },
  { host: /^(?:ptb\.|canary\.)?discord(?:app)?\.com$/i, keepSegments: 3 },
];

const SECRET_KEY_PATTERN = /url|secret|token|key|password|auth/i;

/**
 * Mask a webhook URL. Userinfo, query, hash and at least the last path segment
 * are always dropped. A value that does not parse as an http(s) URL is masked
 * entirely.
 */
export function redactUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url).replace(/\\\//g, '/'));
  } catch {
    return REDACTED;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return REDACTED;
  const known = KNOWN_WEBHOOK_HOSTS.find(h => h.host.test(parsed.hostname));
  const host = known ? parsed.hostname : REDACTED;
  const origin = `${parsed.protocol}//${host}${parsed.port ? `:${parsed.port}` : ''}`;
  const segments = parsed.pathname.split('/').filter(Boolean);
  const keep = known ? Math.min(known.keepSegments, Math.max(0, segments.length - 1)) : 0;
  return [origin, ...segments.slice(0, keep), REDACTED].join('/');
}

// Everything under a credential key is a credential, whatever its type: a
// number, a boolean, or an object whose own keys look harmless (`{ value }`).
// Only URLs get the partial, identifying mask; null stays null.
function maskSecretValue(key, value) {
  if (value == null) return value;
  if (typeof value === 'string') return /url/i.test(key) ? redactUrl(value) : REDACTED;
  if (Array.isArray(value)) return value.map(v => maskSecretValue(key, v));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskSecretValue(/url/i.test(k) ? k : key, v)]));
  }
  return REDACTED;
}

function redactChannelData(value) {
  if (Array.isArray(value)) return value.map(redactChannelData);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] = SECRET_KEY_PATTERN.test(key) ? maskSecretValue(key, v) : redactChannelData(v);
  }
  return out;
}

/**
 * Return a copy of an alerts API response with channel credentials masked:
 * Slack/Discord/webhook URLs and webhook signing secrets. Anyone holding a
 * webhook URL can post to the channel, and CLI output is routinely pasted into
 * chats, logs and tickets, so these are hidden unless --reveal is passed.
 * Works on any response shape by masking every `channels` array it finds.
 * Telegram chat IDs are not credentials and stay visible.
 */
export function redactAlertSecrets(value) {
  if (Array.isArray(value)) return value.map(redactAlertSecrets);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, v] of Object.entries(value)) {
    if (key === 'channels' && Array.isArray(v)) {
      // The whole channel, not just `data`, in case credentials sit at its top level.
      out[key] = v.map(redactChannelData);
    } else {
      out[key] = redactAlertSecrets(v);
    }
  }
  return out;
}

// Any http(s) URL in error text, including the JSON-escaped `https:\/\/` form.
// Alert errors have no reason to quote URLs other than channels and the
// Nansen links the CLI's own errors point to, so everything else is masked
// rather than guessing which are webhooks.
const URL_IN_TEXT = /https?:(?:\\?\/){2}[^\s"'<>]+/gi;
// Exact URLs, not hosts: a generic webhook can point at any host and path,
// including a nansen.ai one. A URL differing in any part (path, query, hash,
// port, userinfo) is masked. Trailing sentence punctuation is ignored.
const NANSEN_LINKS = new Set([
  'https://docs.nansen.ai/',
  'https://docs.nansen.ai/getting-started/error-handling',
  'https://app.nansen.ai/api?tab=api',
  'https://app.nansen.ai/auth/agent-setup',
]);

function isNansenLink(url) {
  try {
    return NANSEN_LINKS.has(new URL(url.replace(/\\\//g, '/').replace(/[.,;:!?)\]]+$/, '')).href);
  } catch {
    return false;
  }
}

// Keys in a request payload whose values are credentials. Narrower than
// SECRET_KEY_PATTERN so alert filters such as `tokens` or `tokenSectors`
// are not mistaken for secrets and masked out of error messages: `token` and
// `key` count only at the end of a key (`accessToken`, `apiKey`).
const CREDENTIAL_KEY_PATTERN = /url|secret|password|passphrase|credential|token$|key$|^auth/i;

const maskCredential = v => (/^https?:/i.test(v) ? redactUrl(v) : REDACTED);

// Mask credential-keyed fields anywhere in an error body, not only inside
// `channels`: an error can echo a stored secret on its own (`{ detail: { secret } }`),
// including on `list`, where there is no request payload to match it against.
// Nansen URLs (e.g. links to docs) stay readable.
function maskCredentialKeys(value) {
  if (Array.isArray(value)) return value.map(maskCredentialKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => {
    if (!CREDENTIAL_KEY_PATTERN.test(k)) return [k, maskCredentialKeys(v)];
    return [k, typeof v === 'string' && isNansenLink(v) ? v : maskSecretValue(k, v)];
  }));
}

// Credential values in a request payload (channel flags, --data, or existing
// alert data merged into an update) or in an error body. Every string or
// number under a credential key counts, at any depth, as they would be echoed
// as text. Objects already visited are skipped, so circular details are safe.
function payloadCredentials(value, underCredentialKey = false, out = [], seen = new WeakSet()) {
  if (typeof value === 'string' || typeof value === 'number') {
    if (underCredentialKey) out.push(String(value));
  } else if (value && typeof value === 'object' && !seen.has(value)) {
    seen.add(value);
    const entries = Array.isArray(value) ? value.map(v => [null, v]) : Object.entries(value);
    for (const [k, v] of entries) {
      payloadCredentials(v, underCredentialKey || (k !== null && CREDENTIAL_KEY_PATTERN.test(k)), out, seen);
    }
  }
  return out;
}

// Credentials sent or passed on this invocation, mapped to their masked form.
// They are matched by value, which covers a secret that is not a URL.
function suppliedChannelSecrets(options, payload, errorBody) {
  const secrets = [];
  // Flag values shorter than the minimum are left alone: URLs that short are
  // not valid and buildChannels rejects short --webhook-secret values. --data
  // has no minimum, so a payload credential of any length is matched; values
  // shorter than 8 characters only as a whole token, so a short secret such
  // as `abc1` does not garble unrelated words that contain it.
  const add = (value, masked, minLength) => {
    for (const v of [value].flat()) {
      if (typeof v !== 'string' || v.length < Math.max(1, minLength)) continue;
      const wholeToken = v.length < 8;
      secrets.push([v, masked(v), wholeToken]);
      const escaped = JSON.stringify(v).slice(1, -1).replace(/\//g, '\\/');
      if (escaped !== v) secrets.push([escaped, masked(v), wholeToken]);
    }
  };
  for (const flag of ['slack', 'discord', 'webhook']) add(options[flag], redactUrl, 8);
  add(options['webhook-secret'], () => REDACTED, 16);
  add(payloadCredentials(payload), maskCredential, 1);
  // A credential field in the error body names the value, so the same secret
  // is also scrubbed wherever the message quotes it (e.g. a stored secret on
  // `list`, where there is no payload to match against).
  add(payloadCredentials(errorBody).filter(v => !isNansenLink(v)), maskCredential, 1);
  // Longest first, so a value that contains another is replaced whole.
  return secrets.sort((a, b) => b[0].length - a[0].length);
}

function scrubString(text, secrets) {
  let out = text;
  for (const [value, masked, wholeToken] of secrets) {
    if (!wholeToken) {
      out = out.split(value).join(masked);
      continue;
    }
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, 'g'), () => masked);
  }
  // Sentence punctuation the URL pattern swallows (`(https://x/y).`) is kept
  // outside the mask, so the text around a masked URL stays intact.
  return out.replace(URL_IN_TEXT, match => {
    const [, url, tail] = match.match(/^(.*?)([.,;:!?)\]]*)$/);
    return isNansenLink(url) ? match : redactUrl(url) + tail;
  });
}

function scrubDeep(value, secrets) {
  if (typeof value === 'string') return scrubString(value, secrets);
  if (Array.isArray(value)) return value.map(v => scrubDeep(v, secrets));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubDeep(v, secrets)]));
}

/**
 * Return an error safe to print: the message and details have channel
 * credentials masked. API error bodies are copied into NansenError.details and
 * printed, and a validation error can echo the channels it rejected. If the
 * details cannot be walked (e.g. a circular structure), they are dropped.
 * `payload` is the request body that was sent, if any.
 */
export function redactAlertError(error, options = {}, payload = undefined) {
  const secrets = suppliedChannelSecrets(options, payload, [error?.details, error?.data]);
  const scrub = value => {
    if (value == null) return value;
    try {
      return scrubDeep(maskCredentialKeys(redactAlertSecrets(value)), secrets);
    } catch {
      return null;
    }
  };
  const message = typeof error?.message === 'string' ? scrubString(error.message, secrets) : error?.message;
  if (error instanceof NansenError) {
    return new NansenError(message, error.code, error.status, scrub(error.details));
  }
  if (error instanceof Error) {
    // formatError() reads message, code, status and details/data.
    const scrubbed = new Error(message);
    scrubbed.name = error.name;
    for (const key of ['code', 'status']) {
      if (error[key] !== undefined) scrubbed[key] = error[key];
    }
    for (const key of ['details', 'data']) {
      if (error[key] !== undefined) scrubbed[key] = scrub(error[key]);
    }
    return scrubbed;
  }
  return error;
}

// ============= Formatting =============

// Format alerts list as human-readable table
export function formatAlertsTable(alerts) {
  if (!Array.isArray(alerts) || alerts.length === 0) {
    return 'No alerts';
  }

  const formatChannels = (channels) => {
    if (!channels || !Array.isArray(channels) || channels.length === 0) return '';
    return channels.map(ch => ch.type).join(', ');
  };

  const formatEnabled = (isEnabled) => isEnabled ? '✓' : '✗';

  const truncate = (str, maxLen) => {
    if (!str) return '';
    return str.length > maxLen ? str.slice(0, maxLen - 1) + '…' : str;
  };

  const idWidth = Math.max(2, Math.max(...alerts.map(a => (a.id || '').length)));
  const nameWidth = Math.max(4, Math.min(30, Math.max(...alerts.map(a => (a.name || '').length))));
  const typeWidth = Math.max(4, Math.min(25, Math.max(...alerts.map(a => (a.type || '').length))));
  const channelsWidth = Math.max(8, Math.min(20, Math.max(...alerts.map(a => formatChannels(a.channels).length))));

  const lines = [];
  const header = `${'ID'.padEnd(idWidth)} │ ${'NAME'.padEnd(nameWidth)} │ ${'TYPE'.padEnd(typeWidth)} │ ${'ENABLED'.padEnd(7)} │ ${'CHANNELS'.padEnd(channelsWidth)}`;
  lines.push(header);
  lines.push('─'.repeat(idWidth) + '─┼─' + '─'.repeat(nameWidth) + '─┼─' + '─'.repeat(typeWidth) + '─┼─' + '─'.repeat(7) + '─┼─' + '─'.repeat(channelsWidth));

  for (const alert of alerts) {
    const id = (alert.id || '').padEnd(idWidth);
    const name = truncate(alert.name, nameWidth).padEnd(nameWidth);
    const type = truncate(alert.type, typeWidth).padEnd(typeWidth);
    const enabled = formatEnabled(alert.isEnabled).padEnd(7);
    const channels = truncate(formatChannels(alert.channels), channelsWidth).padEnd(channelsWidth);
    lines.push(`${id} │ ${name} │ ${type} │ ${enabled} │ ${channels}`);
  }

  return lines.join('\n');
}

// ============= Data Builders =============

/**
 * Parse a token string "address:chain" into { address, chain }.
 * Handles single string or array of strings (from repeated --token flags).
 */
function parseTokens(tokenArg, name) {
  if (tokenArg === undefined || tokenArg === '') return undefined;
  const tokens = Array.isArray(tokenArg) ? tokenArg : [tokenArg];
  return tokens.map(t => {
    if (typeof t !== 'string') {
      throw new NansenError(`--${name} values must be strings`, ErrorCode.INVALID_PARAMS);
    }
    const colonIdx = t.lastIndexOf(':');
    if (colonIdx === -1) throw new NansenError(`Invalid token format: "${t}". Expected address:chain`, ErrorCode.INVALID_PARAMS);
    return { address: t.slice(0, colonIdx), chain: t.slice(colonIdx + 1) };
  });
}

/**
 * Parse a subject string "type:value" into { type, value }.
 * Handles single string or array (from repeated --subject flags).
 */
function parseSubjects(subjectArg, name) {
  if (subjectArg === undefined || subjectArg === '') return undefined;
  const subjects = Array.isArray(subjectArg) ? subjectArg : [subjectArg];
  return subjects.map(s => {
    if (typeof s !== 'string') {
      throw new NansenError(`--${name} values must be strings`, ErrorCode.INVALID_PARAMS);
    }
    const colonIdx = s.indexOf(':');
    if (colonIdx === -1) throw new NansenError(`Invalid subject format: "${s}". Expected type:value`, ErrorCode.INVALID_PARAMS);
    return { type: s.slice(0, colonIdx), value: s.slice(colonIdx + 1) };
  });
}

/**
 * Recursively deep-merge two plain objects.  Arrays and non-object values in
 * `source` replace the corresponding key in `target`; plain objects are merged
 * recursively so that partial updates (e.g. only `min` on a range) don't
 * overwrite sibling keys (e.g. existing `max`).
 */
function deepMergePlain(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const oldVal = target[key];
    const newVal = source[key];
    if (oldVal && newVal && typeof oldVal === 'object' && typeof newVal === 'object'
        && !Array.isArray(oldVal) && !Array.isArray(newVal)) {
      result[key] = deepMergePlain(oldVal, newVal);
    } else {
      result[key] = newVal;
    }
  }
  return result;
}

/**
 * Normalise chains option to array.
 */
function parseChains(chainsOpt) {
  return parseCsvOption(chainsOpt, 'chains');
}

/**
 * Parse a CLI option value as a finite number, or throw a clear error.
 *
 * Plain `Number(val)` turns garbage input ("abc") into NaN, and
 * `JSON.stringify` silently turns NaN into `null` — so a typo'd
 * --usd-min/--market-cap-max/etc. would vanish from the request instead of
 * failing loudly, and the alert would ship without the filter the user
 * asked for.
 */
function parseFiniteNumber(raw, name) {
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new NansenError(`Invalid --${name} "${raw}": must be a number`, ErrorCode.INVALID_PARAMS);
  }
  return n;
}

/**
 * Validate a single-value string filter option (e.g. --chain, --token-address).
 * Empty string/undefined mean "not provided"; any other non-string value
 * (e.g. `--chain '{}'`, from parseArgs' JSON.parse of option values) is
 * rejected instead of crashing on .toLowerCase() or being silently dropped
 * by a falsy check.
 */
function parseStringFilter(val, name) {
  if (val === undefined || val === '') return undefined;
  if (typeof val !== 'string') {
    throw new NansenError(`--${name} must be a string`, ErrorCode.INVALID_PARAMS);
  }
  return val;
}

function parseNonNegativeIntegerOption(raw, name) {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new NansenError(`--${name} must be a non-negative integer, got "${raw}"`, ErrorCode.INVALID_PARAMS);
  }
  return n;
}

/**
 * Build a { min, max } range object from two option values.
 * Returns undefined if neither is provided.
 */
function buildRange(minVal, maxVal, name) {
  if (minVal === undefined && maxVal === undefined) return undefined;
  const r = {};
  if (minVal !== undefined) r.min = parseFiniteNumber(minVal, `${name}-min`);
  if (maxVal !== undefined) r.max = parseFiniteNumber(maxVal, `${name}-max`);
  return r;
}

/**
 * Build the data payload for sm-token-flows alerts from named flags.
 */
export function buildSmTokenFlowsData(options) {
  const data = {};

  const chains = parseChains(options.chains);
  if (chains) data.chains = chains;

  const flowFields = ['inflow-1h', 'inflow-1d', 'inflow-7d', 'outflow-1h', 'outflow-1d', 'outflow-7d', 'netflow-1h', 'netflow-1d', 'netflow-7d'];
  for (const field of flowFields) {
    const range = buildRange(options[`${field}-min`], options[`${field}-max`], field);
    if (range) {
      // Convert CLI key "inflow-1h" → data key "inflow_1h"
      data[field.replace(/-/g, '_')] = range;
    }
  }

  const tokens = parseTokens(options.token, 'token');
  const excludeTokens = parseTokens(options['exclude-token'], 'exclude-token');
  if (tokens) data.inclusion = { ...data.inclusion, tokens };
  if (excludeTokens) data.exclusion = { ...data.exclusion, tokens: excludeTokens };

  const sectors = parseCsvOption(options['token-sector'], 'token-sector');
  if (sectors) data.inclusion = { ...data.inclusion, tokenSectors: sectors };
  const excludeSectors = parseCsvOption(options['exclude-token-sector'], 'exclude-token-sector');
  if (excludeSectors) data.exclusion = { ...data.exclusion, tokenSectors: excludeSectors };

  if (options['token-age-max'] !== undefined) {
    data.inclusion = { ...data.inclusion, tokenAge: { max: parseFiniteNumber(options['token-age-max'], 'token-age-max') } };
  }

  const marketCapRange = buildRange(options['market-cap-min'], options['market-cap-max'], 'market-cap');
  if (marketCapRange) data.inclusion = { ...data.inclusion, marketCap: marketCapRange };

  const fdvRange = buildRange(options['fdv-min'], options['fdv-max'], 'fdv');
  if (fdvRange) data.inclusion = { ...data.inclusion, fdvUsd: fdvRange };

  return data;
}

/**
 * Build the data payload for common-token-transfer alerts from named flags.
 */
export function buildCommonTokenTransferData(options) {
  const data = {};

  const chains = parseChains(options.chains);
  if (chains) data.chains = chains;

  const events = parseCsvOption(options.events, 'events');
  if (events) data.events = events;

  const usdRange = buildRange(options['usd-min'], options['usd-max'], 'usd');
  if (usdRange) data.usdValue = usdRange;

  const amountRange = buildRange(options['token-amount-min'], options['token-amount-max'], 'token-amount');
  if (amountRange) data.tokenAmount = amountRange;

  const subjects = parseSubjects(options.subject, 'subject');
  if (subjects) data.subjects = subjects;

  const counterparties = parseSubjects(options.counterparty, 'counterparty');
  if (counterparties) data.counterparties = counterparties;

  const tokens = parseTokens(options.token, 'token');
  const excludeTokens = parseTokens(options['exclude-token'], 'exclude-token');
  if (tokens) data.inclusion = { ...data.inclusion, tokens };
  if (excludeTokens) data.exclusion = { ...data.exclusion, tokens: excludeTokens };

  const sectors = parseCsvOption(options['token-sector'], 'token-sector');
  if (sectors) data.inclusion = { ...data.inclusion, tokenSectors: sectors };
  const excludeSectors = parseCsvOption(options['exclude-token-sector'], 'exclude-token-sector');
  if (excludeSectors) data.exclusion = { ...data.exclusion, tokenSectors: excludeSectors };

  const tokenAgeMin = options['token-age-min'];
  const tokenAgeMax = options['token-age-max'];
  if (tokenAgeMin !== undefined || tokenAgeMax !== undefined) {
    const tokenAge = {};
    if (tokenAgeMin !== undefined) tokenAge.min = parseFiniteNumber(tokenAgeMin, 'token-age-min');
    if (tokenAgeMax !== undefined) tokenAge.max = parseFiniteNumber(tokenAgeMax, 'token-age-max');
    data.inclusion = { ...data.inclusion, tokenAge };
  }

  const marketCapRange = buildRange(options['market-cap-min'], options['market-cap-max'], 'market-cap');
  if (marketCapRange) data.inclusion = { ...data.inclusion, marketCap: marketCapRange };

  const excludeFrom = parseSubjects(options['exclude-from'], 'exclude-from');
  if (excludeFrom) data.exclusion = { ...data.exclusion, fromTargets: excludeFrom };
  const excludeTo = parseSubjects(options['exclude-to'], 'exclude-to');
  if (excludeTo) data.exclusion = { ...data.exclusion, toTargets: excludeTo };

  return data;
}

/**
 * Build the data payload for smart-contract-call alerts from named flags.
 */
export function buildSmartContractCallData(options) {
  const data = {};

  const chains = parseChains(options.chains);
  if (chains) data.chains = chains;

  const usdRange = buildRange(options['usd-min'], options['usd-max'], 'usd');
  if (usdRange) data.usdValue = usdRange;

  const signatureHash = parseCsvOption(options['signature-hash'], 'signature-hash');
  if (signatureHash) data.signatureHash = signatureHash;

  const callers = parseSubjects(options.caller, 'caller');
  const contracts = parseSubjects(options.contract, 'contract');
  const excludeCallers = parseSubjects(options['exclude-caller'], 'exclude-caller');
  const excludeContracts = parseSubjects(options['exclude-contract'], 'exclude-contract');

  if (callers) data.inclusion = { ...data.inclusion, caller: callers };
  if (contracts) data.inclusion = { ...data.inclusion, smartContract: contracts };
  if (excludeCallers) data.exclusion = { ...data.exclusion, caller: excludeCallers };
  if (excludeContracts) data.exclusion = { ...data.exclusion, smartContract: excludeContracts };

  return data;
}

/**
 * Type-specific defaults for required fields.
 * Applied in buildAlertData so payloads always satisfy the backend schema.
 */
const TYPE_DEFAULTS = {
  'sm-token-flows': {
    chains: [],
    events: ['sm-token-flows'],
    inflow_1h: {},
    inflow_1d: {},
    inflow_7d: {},
    outflow_1h: {},
    outflow_1d: {},
    outflow_7d: {},
    netflow_1h: {},
    netflow_1d: {},
    netflow_7d: {},
    inclusion: {},
    exclusion: {},
  },
  'common-token-transfer': {
    chains: [],
    events: [],
    subjects: [],
    counterparties: [],
    usdValue: {},
    tokenAmount: {},
    inclusion: {},
    exclusion: {},
  },
  'smart-contract-call': {
    chains: [],
    events: ['smart-contract-call'],
    usdValue: {},
    signatureHash: [],
    inclusion: { caller: [], smartContract: [] },
    exclusion: { caller: [], smartContract: [] },
  },
};

/**
 * Build the alert data payload from named flags, dispatching on type.
 * --data '<json>' is merged on top as an escape-hatch override.
 * When applyDefaults is true (default), type-specific defaults are applied
 * underneath so the payload always satisfies the backend schema.
 * Set applyDefaults to false for sparse updates.
 */
export function buildAlertData(options, { applyDefaults = true } = {}) {
  let data;

  if (options.type === 'sm-token-flows') {
    data = buildSmTokenFlowsData(options);
  } else if (options.type === 'common-token-transfer') {
    data = buildCommonTokenTransferData(options);
  } else if (options.type === 'smart-contract-call') {
    data = buildSmartContractCallData(options);
  } else {
    // No type — only --chains and --data are valid; warn if type-specific flags are present
    const typeSpecificFlags = [
      'inflow-1h-min', 'inflow-1h-max', 'inflow-1d-min', 'inflow-1d-max', 'inflow-7d-min', 'inflow-7d-max',
      'outflow-1h-min', 'outflow-1h-max', 'outflow-1d-min', 'outflow-1d-max', 'outflow-7d-min', 'outflow-7d-max',
      'netflow-1h-min', 'netflow-1h-max', 'netflow-1d-min', 'netflow-1d-max', 'netflow-7d-min', 'netflow-7d-max',
      'events', 'usd-min', 'usd-max', 'token-amount-min', 'token-amount-max',
      'token', 'exclude-token',
      'subject', 'counterparty', 'signature-hash', 'caller', 'contract',
      'exclude-caller', 'exclude-contract', 'exclude-from', 'exclude-to',
      'token-sector', 'exclude-token-sector', 'token-age-min', 'token-age-max',
      'market-cap-min', 'market-cap-max', 'fdv-min', 'fdv-max',
    ];
    const present = typeSpecificFlags.filter(f => options[f] !== undefined);
    if (present.length > 0) {
      throw new NansenError(
        `--type is required when using type-specific flags (${present.map(f => '--' + f).join(', ')})`,
        ErrorCode.MISSING_PARAM,
      );
    }
    data = {};
    const chains = parseChains(options.chains);
    if (chains) data.chains = chains;
  }

  // Apply type defaults underneath so all required fields are present.
  // Use structuredClone to avoid shared mutable references, and deep-merge
  // inclusion/exclusion so partial flags (e.g. --caller without --contract)
  // don't drop sibling required sub-fields.
  if (applyDefaults && TYPE_DEFAULTS[options.type]) {
    const defaults = structuredClone(TYPE_DEFAULTS[options.type]);
    data = { ...defaults, ...data };
    if (defaults.inclusion) {
      data.inclusion = { ...defaults.inclusion, ...data.inclusion };
    }
    if (defaults.exclusion) {
      data.exclusion = { ...defaults.exclusion, ...data.exclusion };
    }
  }

  return data;
}

/**
 * Parse the --data JSON escape-hatch option.
 * Returns the parsed object, or undefined if not provided.
 */
function parseDataOverride(options) {
  if (!options.data) return undefined;
  if (typeof options.data === 'string') {
    try {
      return JSON.parse(options.data);
    } catch {
      throw new NansenError('--data must be valid JSON', ErrorCode.INVALID_PARAMS);
    }
  }
  return options.data;
}

// ============= Validation =============

/**
 * Check whether a range object has at least one non-null bound.
 * Uses != null (loose equality) to catch both null and undefined.
 */
function isRangeSet(range) {
  if (!range || typeof range !== 'object') return false;
  return range.min != null || range.max != null;
}

/**
 * Validate alert data payload against type-specific required fields.
 * Throws NansenError with INVALID_PARAMS when the payload is missing
 * mandatory information for the given alert type.
 *
 * Gracefully no-ops when type or data is null/undefined.
 */
export function validateAlertData(type, data) {
  if (!type || !data) return;

  if (type === 'sm-token-flows') {
    const flowKeys = [
      'inflow_1h', 'inflow_1d', 'inflow_7d',
      'outflow_1h', 'outflow_1d', 'outflow_7d',
      'netflow_1h', 'netflow_1d', 'netflow_7d',
    ];
    const hasAnyFlow = flowKeys.some(k => isRangeSet(data[k]));
    if (!hasAnyFlow) {
      throw new NansenError(
        'sm-token-flows requires at least one flow threshold (--inflow-*, --outflow-*, or --netflow-*)',
        ErrorCode.INVALID_PARAMS,
      );
    }
  }

  if (type === 'common-token-transfer') {
    const hasSubjects = Array.isArray(data.subjects) && data.subjects.length > 0;
    const hasTokens = Array.isArray(data.inclusion?.tokens) && data.inclusion.tokens.length > 0;
    if (!hasSubjects && !hasTokens) {
      throw new NansenError(
        'common-token-transfer requires at least one --subject or --token',
        ErrorCode.INVALID_PARAMS,
      );
    }
  }

  if (type === 'smart-contract-call') {
    const hasCallers = Array.isArray(data.inclusion?.caller) && data.inclusion.caller.length > 0;
    const hasContracts = Array.isArray(data.inclusion?.smartContract) && data.inclusion.smartContract.length > 0;
    const hasSignatureHash = Array.isArray(data.signatureHash) && data.signatureHash.length > 0;
    if (!hasCallers && !hasContracts && !hasSignatureHash) {
      throw new NansenError(
        'smart-contract-call requires at least one --caller, --contract, or --signature-hash',
        ErrorCode.INVALID_PARAMS,
      );
    }
  }
}

// ============= Command Builder =============

const TIME_WINDOW_BY_TYPE = {
  'common-token-transfer': 'realtime',
  'smart-contract-call': 'realtime',
  'sm-token-flows': '1h',
};

export function buildAlertsCommands(deps = {}) {
  const { log = console.log } = deps;

  return {
    'alerts': async (args, apiInstance, flags, options) => {
      const sub = args[0];

      const HELP = {
        _top: `nansen alerts — Smart alert management

SUBCOMMANDS:
  list        List all alerts
  create      Create a new alert
  update      Update an existing alert
  toggle      Enable or disable an alert
  delete      Delete an alert

Channel credentials (Slack/Discord/webhook URLs, webhook signing secrets) are
redacted in output and error messages of every subcommand. Pass --reveal to
show them.

Run: nansen alerts <subcommand> --help`,

        list: `nansen alerts list — List all alerts

USAGE:
  nansen alerts list [--table] [--pretty] [--type <type>] [--enabled|--disabled] [--token-address <addr>] [--chain <chain>] [--limit <n>] [--offset <n>] [--reveal]

OPTIONS:
  --table                      Human-readable table output (columns: ID, NAME, TYPE, ENABLED, CHANNELS)
  --pretty                     Indented JSON output
  --reveal                     Show full channel webhook URLs and secrets (redacted by default)
  --type <type>                Filter by alert type (sm-token-flows, common-token-transfer, smart-contract-call)
  --enabled / --disabled       Filter by enabled state
  --token-address <addr>       Filter by token address
  --chain <chain>              Filter by chain
  --limit <n>                  Max results
  --offset <n>                 Skip first N results

EXAMPLES:
  nansen alerts list --table
  nansen alerts list --pretty
  nansen alerts list --type sm-token-flows --enabled`,

        create: `nansen alerts create — Create a new alert

USAGE:
  nansen alerts create --name <name> --type <type> --chains <chains> --telegram <chatId> [options]

REQUIRED:
  --name <name>                Alert name
  --type <type>                sm-token-flows | common-token-transfer | smart-contract-call
  At least one channel:        --telegram <chatId> | --slack <url> | --discord <url> | --webhook <url>

OPTIONS (all types):
  --chains <chains>            Comma-separated chains (e.g. ethereum,solana)
  --webhook-secret <secret>    Signing secret for webhook payload verification (webhook only)
  --token <address:chain>      Include token (repeatable)
  --exclude-token <addr:chain> Exclude token (repeatable)
  --description '<text>'       Alert description
  --disabled                   Create in disabled state
  --data '<json>'              Raw JSON merged on top of named flags (escape hatch)
  --reveal                     Show full channel URLs and secrets in the response (redacted by default)

OPTIONS (sm-token-flows):
  At least one flow threshold required (inflow, outflow, or netflow):
  --inflow-1h-min/max <usd>   --outflow-1h-min/max <usd>   --netflow-1h-min/max <usd>
  --inflow-1d-min/max <usd>   --outflow-1d-min/max <usd>   --netflow-1d-min/max <usd>
  --inflow-7d-min/max <usd>   --outflow-7d-min/max <usd>   --netflow-7d-min/max <usd>
  --token-sector <name>        --exclude-token-sector <name> (repeatable)
  --token-age-max <days>       --market-cap-min/max <usd>    --fdv-min/max <usd>

OPTIONS (common-token-transfer):
  --events <buy,sell,swap,send,receive>   Comma-separated event types
  --usd-min/max <usd>         --token-amount-min/max <n>
  --subject <type:value>       Filter by subject (repeatable, e.g. label:"Centralized Exchange")
  --counterparty <type:value>  Filter by counterparty (repeatable, requires --subject)
  --token-sector <name>        --exclude-token-sector <name> (repeatable)
  --token-age-min/max <days>   --market-cap-min/max <usd>
  --exclude-from <type:value>  --exclude-to <type:value> (repeatable)

OPTIONS (smart-contract-call):
  --usd-min/max <usd>         --signature-hash <hash> (repeatable)
  --caller <type:value>        --exclude-caller <type:value> (repeatable)
  --contract <type:value>      --exclude-contract <type:value> (repeatable)

SUBJECT TYPES: address, entity, label, custom-label
CHAIN ALIASES: Hyperliquid = hyperevm, BSC = bnb

NOTE: Use single quotes for names with $ or special chars: --name 'SM >$1M'

EXAMPLES:
  nansen alerts create --name 'ETH SM Inflow' --type sm-token-flows --chains ethereum --telegram 5238612255 --inflow-1h-min 1000000
  nansen alerts create --name 'USDC Transfers' --type common-token-transfer --chains ethereum --telegram 5238612255 --events send,receive --usd-min 1000000 --subject label:"Centralized Exchange"
  nansen alerts create --name 'Contract Calls' --type smart-contract-call --chains ethereum --telegram 5238612255 --signature-hash 0xa9059cbb --caller address:0xabc`,

        update: `nansen alerts update — Update an existing alert

USAGE:
  nansen alerts update <id> [--name <name>] [--chains <chains>] [--enabled|--disabled] [type-specific flags...]

All create options are accepted, including --reveal. Only provided fields are updated.
See: nansen alerts create --help for type-specific flags.

NOTE: --type cannot change an existing alert's type (use delete + create instead).
      Use single quotes for names with $ or special chars: --name 'SM >$1M'

EXAMPLES:
  nansen alerts update abc123 --name 'New Name'
  nansen alerts update abc123 --inflow-1h-min 2000000
  nansen alerts update abc123 --chains ethereum,base --inflow-1h-min 2000000`,

        toggle: `nansen alerts toggle — Enable or disable an alert

USAGE:
  nansen alerts toggle <id> --enabled
  nansen alerts toggle <id> --disabled

OPTIONS:
  --reveal                     Show full channel URLs and secrets in the response (redacted by default)`,

        delete: `nansen alerts delete — Delete an alert

USAGE:
  nansen alerts delete <id>`,
      };

      if (!sub || sub === 'help') {
        log(HELP._top);
        return;
      }

      // Build channels array from --telegram/--slack/--discord/--webhook flags
      function buildChannels() {
        if (options["webhook-secret"] && !options.webhook) {
          throw new NansenError('--webhook-secret requires --webhook', ErrorCode.INVALID_PARAMS);
        }
        for (const flag of ['slack', 'discord', 'webhook', 'webhook-secret']) {
          if (Array.isArray(options[flag])) {
            throw new NansenError(`--${flag} can only be passed once`, ErrorCode.INVALID_PARAMS);
          }
          if (typeof options[flag] === 'string' && options[flag].includes(REDACTED)) {
            throw new NansenError(
              `--${flag} looks like a redacted value from alerts output. Pass the full value (nansen alerts list --reveal shows it).`,
              ErrorCode.INVALID_PARAMS,
            );
          }
        }
        const channels = [];
        if (options.telegram) channels.push({ type: 'telegram', data: { chatId: String(options.telegram) } });
        if (options.slack) channels.push({ type: 'slack', data: { webhookUrl: options.slack } });
        if (options.discord) channels.push({ type: 'discord', data: { webhookUrl: options.discord } });
        if (options.webhook) {
          const webhookData = { webhookUrl: options.webhook };
          if (options["webhook-secret"]) {
            if (options["webhook-secret"].length < 16) throw new NansenError('--webhook-secret must be at least 16 characters', ErrorCode.INVALID_PARAMS);
            webhookData.secret = options["webhook-secret"];
          }
          channels.push({ type: 'webhook', data: webhookData });
        }
        return channels.length > 0 ? channels : null;
      }

      // Request body of create/update, so a failed request's error can be
      // scrubbed of every credential it carried.
      let sentPayload;

      const handlers = {
        'list': async () => {
          if (flags.enabled && flags.disabled) throw new NansenError('Cannot specify both --enabled and --disabled', ErrorCode.INVALID_PARAMS);

          const offset = parseNonNegativeIntegerOption(options.offset, 'offset');
          const limit = parseNonNegativeIntegerOption(options.limit, 'limit');
          const tokenAddress = parseStringFilter(options['token-address'], 'token-address');
          const chainFilter = parseStringFilter(options.chain, 'chain');

          const results = await apiInstance.alertsList();
          let alerts = Array.isArray(results) ? results : results?.alerts ?? results?.data ?? [];

          // Client-side filtering (server returns all alerts unfiltered)
          if (options.type) alerts = alerts.filter(a => a.type === options.type);
          if (flags.enabled) alerts = alerts.filter(a => a.isEnabled === true);
          if (flags.disabled) alerts = alerts.filter(a => a.isEnabled === false);
          if (tokenAddress) {
            const addr = tokenAddress.toLowerCase();
            alerts = alerts.filter(a => {
              const allTokens = [...(a.data?.inclusion?.tokens ?? []), ...(a.data?.exclusion?.tokens ?? [])];
              return allTokens.some(t => t.address?.toLowerCase() === addr);
            });
          }
          if (chainFilter) {
            const ch = chainFilter.toLowerCase();
            alerts = alerts.filter(a => {
              const chains = a.data?.chains;
              return Array.isArray(chains) && chains.some(c => c.toLowerCase() === ch || c === 'all');
            });
          }

          // Pagination (applied after filtering). Validate strictly rather than
          // silently misbehaving on bad input:
          //   - `if (options.offset)` / `if (options.limit)` treat 0 as "not set"
          //     (falsy), so `--offset 0` / `--limit 0` were silently ignored
          //     instead of being honored.
          //   - `Number("abc")` is NaN, and `Array.prototype.slice` coerces a NaN
          //     argument to 0 — so `--offset abc` silently became a no-op and
          //     `--limit abc` silently returned zero results, with no error
          //     telling the caller their input wasn't a number at all.
          //   - Negative values (`--offset -1`) were accepted and fed straight
          //     into `slice()`, which treats negative indices as "from the end" —
          //     silently returning the wrong slice instead of rejecting the input.
          if (offset !== undefined) {
            alerts = alerts.slice(offset);
          }
          if (limit !== undefined) {
            alerts = alerts.slice(0, limit);
          }

          return alerts;
        },
        'create': () => {
          const name = options.name;
          const type = options.type;
          const channels = buildChannels();
          const missing = [];
          if (!name) missing.push('--name');
          if (!type) missing.push('--type');
          if (!options.chains) missing.push('--chains');
          if (!channels) missing.push('a channel (--telegram, --slack, --discord, or --webhook)');
          if (missing.length > 0) {
            throw new NansenError(`Required: ${missing.join(', ')}`, ErrorCode.MISSING_PARAM);
          }
          const timeWindow = TIME_WINDOW_BY_TYPE[type] ?? 'realtime';
          let data = buildAlertData(options);
          const dataOverride = parseDataOverride(options);
          if (dataOverride) data = deepMergePlain(data, dataOverride);
          validateAlertData(type, data);
          sentPayload = {
            name,
            type,
            timeWindow,
            channels,
            data,
            ...(options.description ? { description: options.description } : {}),
            isEnabled: !flags.disabled,
          };
          return apiInstance.alertsCreate(sentPayload);
        },
        'update': async () => {
          const id = args[1];
          if (!id) throw new NansenError('Required: <id>', ErrorCode.MISSING_PARAM);

          const existing = await apiInstance.alertsGet(id);
          if (!existing) throw new NansenError(`Alert not found: ${id}`, ErrorCode.NOT_FOUND);
          const existingType = existing.type ?? existing.data?.type;
          if (options.type && options.type !== existingType) {
            throw new NansenError(
              `Cannot change alert type (${existingType} → ${options.type}). Delete and recreate the alert instead.`,
              ErrorCode.INVALID_PARAMS,
            );
          }
          const type = existingType;

          const params = { id };
          if (options.name) params.name = options.name;
          if (type) {
            params.type = type;
            params.timeWindow = TIME_WINDOW_BY_TYPE[type] ?? 'realtime';
          }
          const channels = buildChannels();
          if (channels) params.channels = channels;
          const effectiveOptions = type ? { ...options, type } : options;
          const builtData = buildAlertData(effectiveOptions, { applyDefaults: false });
          const dataOverride = parseDataOverride(options);
          if (Object.keys(builtData).length > 0 || dataOverride) {
            let merged = existing.data ? deepMergePlain(existing.data, builtData) : builtData;
            if (dataOverride) merged = deepMergePlain(merged, dataOverride);
            params.data = merged;
          }
          if (options.description) params.description = options.description;
          if (flags.enabled && flags.disabled) throw new NansenError('Cannot specify both --enabled and --disabled', ErrorCode.INVALID_PARAMS);
          if (flags.enabled) params.isEnabled = true;
          if (flags.disabled) params.isEnabled = false;
          // Validate merged data if present, otherwise validate existing data
          validateAlertData(type, params.data ?? existing.data);
          sentPayload = params;
          return apiInstance.alertsUpdate(params);
        },
        'toggle': () => {
          const id = args[1];
          if (!id) throw new NansenError('Required: <id>', ErrorCode.MISSING_PARAM);
          if (flags.enabled && flags.disabled) throw new NansenError('Cannot specify both --enabled and --disabled', ErrorCode.INVALID_PARAMS);
          const isEnabled = flags.enabled ? true : flags.disabled ? false : undefined;
          if (isEnabled === undefined) throw new NansenError('Required: --enabled or --disabled', ErrorCode.MISSING_PARAM);
          return apiInstance.alertsToggle({ id, isEnabled });
        },
        'delete': () => {
          const id = args[1];
          if (!id) throw new NansenError('Required: <id>', ErrorCode.MISSING_PARAM);
          return apiInstance.alertsDelete(id);
        },
      };

      if (!handlers[sub]) {
        throw unknownCommandError('alerts subcommand', sub, ['list', 'create', 'update', 'toggle', 'delete']);
      }

      // Subcommand-level help: --help flag or "help" as second positional arg
      if (flags.help || flags.h || args[1] === 'help') {
        log(HELP[sub] || HELP._top);
        return;
      }

      try {
        const result = await handlers[sub]();
        return flags.reveal ? result : redactAlertSecrets(result);
      } catch (err) {
        let error = err;
        // Rewrite cryptic channel validation errors from the API into actionable messages.
        // e.g. "Failed to send a welcome message to the channel index 0" → tells the user
        // which channel type failed and what to check.
        const match = typeof err.message === 'string' && err.message.match(/welcome message to the channel index (\d+)/i);
        if (match) {
          const channels = buildChannels() ?? [];
          const ch = channels[Number(match[1])];
          const hint = ch?.type === 'telegram'
            ? `Invalid Telegram chat ID (${ch.data.chatId}). Ensure the bot has been added to the chat.`
            : ch?.type === 'slack'
              ? `Invalid Slack webhook URL. Check the URL and try again.`
              : ch?.type === 'discord'
                ? `Invalid Discord webhook URL. Check the URL and try again.`
                : ch?.type === 'webhook'
                  ? `Invalid webhook URL (${ch.data.webhookUrl}). Ensure the endpoint is reachable and returns 2xx.`
                  : err.message;
          // Keep the API's details (and its request ID); they are redacted below
          // like any other error body unless --reveal is passed.
          error = new NansenError(hint, err.code ?? ErrorCode.INVALID_PARAMS, err.status, err.details ?? null);
        }
        // API error bodies (message and details) can echo the submitted channels,
        // and the hint above quotes the webhook URL; all are masked here unless
        // --reveal is passed.
        throw flags.reveal ? error : redactAlertError(error, options, sentPayload);
      }
    },
  };
}
