/**
 * Opt-in HTTP request tracing for the CLI.
 *
 * Turned on by the global `--debug` flag (which calls setDebugEnabled) or by
 * `NANSEN_DEBUG=1` in the environment. A bare `DEBUG` is honored too: a few
 * x402 wallet-lookup notes were already keyed on it before this module
 * existed, and they now route through trace() so there is one switch, one
 * output stream, and one redaction pass.
 *
 * Everything is written to **stderr**, never stdout. stdout carries the JSON
 * or CSV that callers pipe into other programs, and a trace line in that
 * stream would corrupt it.
 *
 * Nothing here ever prints a credential. Request and response bodies are never
 * traced at all, header values are never traced, URLs go through redactUrl(),
 * and every value handed to trace() goes through redact() first. Redaction is
 * deliberately over-eager: an over-redacted value costs one support round
 * trip, a leaked one costs a key rotation.
 */

/** Placeholder written in place of anything that might be a credential. */
export const REDACTED = '[redacted]';

/** Longest traced value; anything longer is cut and marked. */
export const MAX_VALUE_LENGTH = 200;

/**
 * Field/parameter/header names whose value is never safe to print.
 * Matches substrings, so `apikey`, `X-Api-Key`, `authorization`,
 * `payment-signature` and `token_address` are all covered — the last one is
 * not a secret, but fail-closed is the right side to err on here.
 */
const SECRET_NAME = /key|token|secret|signature|password|passphrase|mnemonic|seed|auth|credential|cookie|private/i;

/**
 * A credential carried inline in a header-ish string, e.g. `Bearer eyJ...`.
 * Two copies on purpose: a /g regex carries lastIndex between .test() calls,
 * so the matcher and the replacer must not be the same object.
 */
// Only `Bearer`/`Basic` introduce an inline credential in text we trace. `Payment`
// and `Signature` are ordinary English words here, and header-name matching plus the
// value-shape rules below already cover a real payment signature — keeping them in
// this pattern only garbled prose like "payment was transmitted".
// The value must look like a credential (8+ chars) so "Bearer token" stays readable.
const INLINE_SCHEME = /\b(Bearer|Basic)\s+[\w.~+/=-]{8,}/i;
const INLINE_SCHEME_ALL = new RegExp(INLINE_SCHEME.source, 'gi');

/** Request ids and other UUIDs are identifiers, not secrets — keep them readable. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Private-key shaped: 32 bytes of hex, with or without the 0x prefix. */
const HEX_32_BYTES = /^(0x)?[0-9a-fA-F]{64}$/;

/** BIP-39 shaped: 12 or more lowercase words separated by single spaces. */
const MNEMONIC = /^([a-z]{3,10} ){11,23}[a-z]{3,10}$/;

/** JWT shaped: three dot-separated base64url segments starting with a JSON header. */
const JWT = /^ey[\w-]{8,}\.[\w-]{4,}\.[\w-]+$/;

/** Base58 secret-key shaped (Solana keypairs are ~88 chars; addresses are ≤44). */
const LONG_BASE58 = /^[1-9A-HJ-NP-Za-km-z]{80,}$/;

/**
 * Long opaque blob — an encoded payment payload, an API key, a session token.
 * The 64-character floor keeps public identifiers readable: EVM addresses are
 * 42 characters and base58 mint addresses at most 44.
 */
const LONG_OPAQUE = /^[A-Za-z0-9_\-+/=.]{64,}$/;

let forcedEnabled = null;
let writer = null;

/**
 * Force tracing on or off for the process, overriding the environment.
 * Pass undefined to hand control back to NANSEN_DEBUG / DEBUG.
 */
export function setDebugEnabled(enabled) {
  forcedEnabled = enabled === undefined ? null : Boolean(enabled);
}

/** Replace the stderr sink. Pass undefined to restore it. Tests only. */
export function setDebugWriter(fn) {
  writer = typeof fn === 'function' ? fn : null;
}

function envEnabled(value) {
  if (value === undefined || value === null) return false;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === '') return false;
  return !['0', 'false', 'no', 'off'].includes(normalized);
}

export function isDebugEnabled() {
  if (forcedEnabled !== null) return forcedEnabled;
  return envEnabled(process.env.NANSEN_DEBUG) || envEnabled(process.env.DEBUG);
}

/** Cut a value to MAX_VALUE_LENGTH, marking that it was cut. */
export function truncate(value, max = MAX_VALUE_LENGTH) {
  const text = String(value);
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…(+${text.length - max} more)`;
}

/** Whether a field, query parameter, or header name names a credential. */
export function isSecretName(name) {
  return SECRET_NAME.test(String(name ?? ''));
}

/**
 * Whether a value looks like a credential regardless of what it is called —
 * a private key, a mnemonic, a JWT, an encoded payment payload.
 */
export function looksLikeSecretValue(value) {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (text === '' || UUID.test(text)) return false;
  return (
    HEX_32_BYTES.test(text) ||
    MNEMONIC.test(text) ||
    JWT.test(text) ||
    LONG_BASE58.test(text) ||
    LONG_OPAQUE.test(text) ||
    INLINE_SCHEME.test(text)
  );
}

function redactString(value) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return redactUrl(value);
  // Drop inline credentials first, keeping the scheme label ("Bearer …") so
  // the trace still says what kind of credential was in play. Doing this
  // before the shape checks keeps the surrounding prose readable.
  const neutralized = value.replace(INLINE_SCHEME_ALL, (_match, kind) => `${kind} ${REDACTED}`);
  if (neutralized !== value) return truncate(neutralized);
  return looksLikeSecretValue(neutralized) ? REDACTED : truncate(neutralized);
}

/**
 * Redact a string, array, or (possibly nested) object for tracing.
 * Values under a secret-looking key are replaced wholesale; every other value
 * is still checked for credential-shaped content and truncated.
 */
export function redact(value, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return `${value}`;
  if (Array.isArray(value)) return value.map((item) => redact(item, seen));
  if (typeof value === 'object') {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = isSecretName(key) ? REDACTED : redact(item, seen);
    }
    return out;
  }
  return truncate(String(value));
}

/**
 * Redact a URL: drop any userinfo, blank out query values whose parameter is
 * credential-named, and blank out any remaining value that looks like a
 * credential. Path and host are kept — they are what makes a trace useful.
 */
export function redactUrl(raw) {
  const text = String(raw ?? '');
  let url;
  try {
    url = new URL(text);
  } catch {
    // Not parseable (a relative path, or a malformed URL). Fall back to a
    // textual pass over the query string so nothing leaks from the odd case.
    const [base, query] = text.split('?');
    if (!query) return truncate(text);
    return truncate(`${base}?${redactQueryText(query)}`);
  }

  const parts = [];
  for (const [key, value] of url.searchParams.entries()) {
    const safe = isSecretName(key) || looksLikeSecretValue(value);
    parts.push(`${encodeURIComponent(key)}=${safe ? REDACTED : encodeURIComponent(value)}`);
  }

  const credentials = url.username || url.password ? `${REDACTED}@` : '';
  const query = parts.length ? `?${parts.join('&')}` : '';
  return truncate(`${url.protocol}//${credentials}${url.host}${url.pathname}${query}${url.hash}`);
}

function redactQueryText(query) {
  return query
    .split('&')
    .map((pair) => {
      const index = pair.indexOf('=');
      if (index === -1) return pair;
      const key = pair.slice(0, index);
      const value = pair.slice(index + 1);
      return `${key}=${isSecretName(key) || looksLikeSecretValue(decodeURIComponent(value)) ? REDACTED : value}`;
    })
    .join('&');
}

/**
 * Redact a header bag (plain object, Map, or fetch Headers) down to names
 * only. Header values are never traced: even the innocuous ones carry nothing
 * worth the risk of a rule that misses one.
 */
export function redactHeaders(headers) {
  const entries = typeof headers?.entries === 'function' ? [...headers.entries()] : Object.entries(headers ?? {});
  const out = {};
  for (const [name] of entries) out[name] = REDACTED;
  return out;
}

function formatValue(key, value) {
  const safe = key === 'url' ? redactUrl(value) : redact(value);
  const text = typeof safe === 'object' ? JSON.stringify(safe) : String(safe);
  return /[\s"]/.test(text) ? JSON.stringify(text) : text;
}

function write(line) {
  if (writer) writer(line);
  else process.stderr.write(line);
}

/**
 * Emit one trace line. No-op unless tracing is enabled.
 * Fields are rendered as `key=value`, in the order given, with null and
 * undefined fields dropped.
 */
export function trace(event, fields = {}) {
  if (!isDebugEnabled()) return;
  const parts = [`[nansen:debug] ${event}`];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    parts.push(`${key}=${formatValue(key, value)}`);
  }
  write(`${parts.join(' ')}\n`);
}

/** An HTTP request is about to go out. */
export function traceRequest({ method, url, attempt, maxAttempts, payment }) {
  trace('http.request', {
    method,
    url,
    attempt: maxAttempts ? `${attempt}/${maxAttempts}` : attempt,
    payment,
  });
}

/** A response came back. `status` and `duration_ms` are the point of this line. */
export function traceResponse({ method, url, status, durationMs, requestId, attempt, payment }) {
  trace('http.response', {
    method,
    url,
    status,
    duration_ms: durationMs,
    request_id: requestId,
    attempt,
    payment,
  });
}

/** The request never produced a response. */
export function traceError({ method, url, durationMs, attempt, error }) {
  trace('http.error', { method, url, duration_ms: durationMs, attempt, error });
}

/** A retry was decided on: which attempt failed, why, and how long we wait. */
export function traceRetry({ method, url, status, attempt, reason, delayMs, retryAfterMs }) {
  trace('http.retry', {
    method,
    url,
    status,
    attempt,
    reason,
    delay_ms: delayMs === undefined || delayMs === null ? null : Math.round(delayMs),
    retry_after_ms: retryAfterMs,
  });
}

/** The response came from the local cache, so no request was made at all. */
export function traceCacheHit({ method, url }) {
  trace('http.cache_hit', { method, url });
}
