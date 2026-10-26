/**
 * Nansen CLI - Shared input validation for research commands (API-1080, API-1081).
 *
 * One path checks every research command before it spends a request:
 *   - unknown commands and subcommands (with the closest match),
 *   - options the command does not accept (including flags it would ignore,
 *     such as --limit on an endpoint without pagination),
 *   - missing required options and options given without a value,
 *   - enum, number and date values,
 *   - chains the endpoint does not accept (src/api-endpoints.json).
 *
 * src/schema.json is the source of truth for what each command accepts, so
 * `nansen schema` documents exactly what this module enforces.
 *
 * Every failure is a NansenError whose `details` mirrors the REST API's 422
 * body: `param` names the first bad option and `errors[]` lists each one as
 * { field, message, code } with the API's snake_case field codes. The wording
 * follows the API too ("... is not recognized. Did you mean ...?"), so a typo
 * reads the same from the CLI, the REST API and the MCP server.
 */

import { NansenError, ErrorCode, SERVER_CODE_MAP } from './api.js';

// ============= Suggestions =============

/** Longest common block of a[alo:ahi] and b[blo:bhi], as [i, j, size]. */
function longestMatch(a, b, alo, ahi, blo, bhi) {
  let best = [alo, blo, 0];
  let lengths = new Map();
  for (let i = alo; i < ahi; i++) {
    const next = new Map();
    for (let j = blo; j < bhi; j++) {
      if (a[i] !== b[j]) continue;
      const size = (lengths.get(j - 1) || 0) + 1;
      next.set(j, size);
      if (size > best[2]) best = [i - size + 1, j - size + 1, size];
    }
    lengths = next;
  }
  return best;
}

function matchingCharacters(a, b, alo, ahi, blo, bhi) {
  const [i, j, size] = longestMatch(a, b, alo, ahi, blo, bhi);
  if (size === 0) return 0;
  return size
    + matchingCharacters(a, b, alo, i, blo, j)
    + matchingCharacters(a, b, i + size, ahi, j + size, bhi);
}

/**
 * Similarity in [0, 1]: Python's difflib.SequenceMatcher(None, a, b).ratio().
 * The REST API and the MCP server use difflib for their "did you mean" hint,
 * so the same typo gets the same suggestion everywhere.
 */
export function similarity(a, b) {
  const total = a.length + b.length;
  if (total === 0) return 1;
  return (2 * matchingCharacters(a, b, 0, a.length, 0, b.length)) / total;
}

/**
 * The candidate closest to `input` (case-insensitive), or null below `cutoff`.
 * Like difflib.get_close_matches(n=1): highest score wins, and a tie goes to
 * the candidate that sorts last.
 */
export function closestMatch(input, candidates, cutoff = 0.6) {
  const needle = String(input).toLowerCase();
  let best = null;
  let bestScore = -1;
  for (const candidate of candidates) {
    const lowered = String(candidate).toLowerCase();
    const score = similarity(needle, lowered);
    if (score < cutoff) continue;
    if (score > bestScore || (score === bestScore && lowered > String(best).toLowerCase())) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

/** 'a', 'b' or 'c' — the REST API's list wording. */
export function quotedList(values) {
  const quoted = values.map(value => `'${value}'`);
  if (quoted.length <= 1) return quoted.join('');
  return `${quoted.slice(0, -1).join(', ')} or ${quoted[quoted.length - 1]}`;
}

// ============= Errors =============

export function fieldError(field, code, message) {
  return { field, message, code };
}

/**
 * One NansenError for a list of field errors. The first error leads, like the
 * REST API's top-level message; every error stays in details.errors.
 */
export function validationError(errors) {
  const [first] = errors;
  const code = SERVER_CODE_MAP[first.code] ?? ErrorCode.INVALID_PARAMS;
  const more = errors.length > 1 ? ` (${errors.length - 1} more error${errors.length === 2 ? '' : 's'} in details.errors)` : '';
  return new NansenError(`${first.message}${more}`, code, null, { param: first.field, errors });
}

/**
 * UNKNOWN_COMMAND with the closest valid name, e.g.
 * "Unknown token subcommand: scrrener. Did you mean 'screener'? Available: ...".
 */
export function unknownCommandError(kind, name, available) {
  const suggestion = closestMatch(name, available);
  const hint = suggestion ? ` Did you mean '${suggestion}'?` : '';
  return new NansenError(
    `Unknown ${kind}: ${name}.${hint} Available: ${available.join(', ')}`,
    ErrorCode.UNKNOWN_COMMAND,
    null,
    { available, ...(suggestion && { suggestion }) },
  );
}

// ============= Command resolution =============

// Top-level shortcuts that resolve before routing (mirrors COMMAND_ALIASES in cli.js).
const CATEGORY_ALIASES = { tgm: 'token', sm: 'smart-money', prof: 'profiler', port: 'portfolio', pm: 'prediction-market' };
// Categories that still run without the `research` prefix.
const TOP_LEVEL_CATEGORIES = new Set(['smart-money', 'profiler', 'token', 'search', 'portfolio', 'prediction-market']);
// Subcommand spellings a handler accepts besides the schema name.
const SUBCOMMAND_ALIASES = { portfolio: { 'defi-holdings': 'defi' } };
// Categories whose handler does its own routing and never calls the API.
const UNVALIDATED_CATEGORIES = new Set(['points']);

/**
 * The research schema entry a command line runs, or null when the command is
 * not a research command (or asks for help). Throws UNKNOWN_COMMAND for a
 * category or subcommand that does not exist.
 *
 * Returns { path, leaf, positional } where `positional` is the arguments after
 * the subcommand.
 */
export function resolveResearchCommand(schema, command, subArgs) {
  const research = schema.commands.research.subcommands;
  let category;
  let rest;
  let prefix;
  if (command === 'research') {
    const raw = subArgs[0];
    if (!raw || raw === 'help') return null;
    category = CATEGORY_ALIASES[raw] || raw;
    if (!research[category]) {
      throw unknownCommandError('research category', raw, Object.keys(research));
    }
    rest = subArgs.slice(1);
    prefix = `research ${category}`;
  } else if (command === 'perp' && (subArgs[0] === 'screener' || subArgs[0] === 'leaderboard')) {
    category = 'perp';
    rest = subArgs;
    prefix = 'perp';
  } else if (TOP_LEVEL_CATEGORIES.has(command)) {
    category = command;
    rest = subArgs;
    prefix = command;
  } else {
    return null;
  }
  if (UNVALIDATED_CATEGORIES.has(category)) return null;

  const entry = research[category];
  if (!entry.subcommands) {
    if (rest[0] === 'help') return null;
    return { path: `nansen ${prefix}`, leaf: entry, positional: rest };
  }
  const rawSub = rest[0];
  if (!rawSub || rawSub === 'help') return null;
  const sub = SUBCOMMAND_ALIASES[category]?.[rawSub] || rawSub;
  const leaf = entry.subcommands[sub];
  if (!leaf) {
    throw unknownCommandError(`${category} subcommand`, rawSub, Object.keys(entry.subcommands));
  }
  if (rest[1] === 'help') return null;
  return { path: `nansen ${prefix} ${sub}`, leaf, positional: rest.slice(1) };
}

// ============= Option validation =============

// Options every command accepts: output, caching, retries and debugging.
export const COMMON_OPTIONS = new Set([
  'help', 'h', 'version', 'v', 'pretty', 'p', 'table', 't', 'stream', 's', 'fields', 'format',
  'no-retry', 'retries', 'cache', 'no-cache', 'cache-ttl', 'debug', 'x402-payment-signature',
]);
// Options that only make sense on a paginated endpoint.
export const PAGINATION_OPTIONS = new Set(['limit', 'page', 'paginate', 'all', 'max-pages']);
const PAGINATION_SPECS = {
  limit: { type: 'integer', minimum: 1, description: 'Results per page' },
  page: { type: 'integer', minimum: 1, description: 'Page number (1-based)' },
};

// Chain spellings a command normalises itself instead of rejecting.
const ACCEPTED_CHAIN_ALIASES = { '/api/v1/profiler/address/counterparties/batch': ['bsc'] };
// Common chain nicknames, used only to suggest the canonical name.
const CHAIN_NICKNAMES = { bsc: 'bnb', eth: 'ethereum', sol: 'solana', arb: 'arbitrum', matic: 'polygon', avax: 'avalanche', op: 'optimism', btc: 'bitcoin', hl: 'hyperliquid' };

function isBlank(value) {
  return value === true || (typeof value === 'string' && value.trim() === '');
}

function isValidDateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Map every accepted spelling (name and aliases) to its schema option name. */
function optionNames(leaf) {
  const names = new Map();
  for (const [name, spec] of Object.entries(leaf.options || {})) {
    names.set(name, name);
    for (const alias of spec.aliases || []) names.set(alias, name);
  }
  return names;
}

function splitList(value) {
  if (Array.isArray(value)) return value.flatMap(splitList);
  if (typeof value !== 'string') return [value];
  return value.split(',').map(part => part.trim()).filter(Boolean);
}

/** Chains the command accepts for `option`, or null when unknown. */
export function supportedChains(leaf, option, endpoints) {
  const spec = leaf.options?.[option];
  if (Array.isArray(spec?.enum) && spec.enum.length) return spec.enum;
  const endpoint = endpoints?.[leaf.endpoint];
  if (!endpoint?.chains?.length) return null;
  return [...endpoint.chains, ...(ACCEPTED_CHAIN_ALIASES[leaf.endpoint] || [])];
}

// Chain typos need a closer match than option names: at 0.6, 'bitcoin' would
// suggest 'ton'.
const CHAIN_SUGGESTION_CUTOFF = 0.75;

function chainSuggestion(chain, allowed, knownChains) {
  const lowered = chain.toLowerCase();
  if (allowed.includes(lowered)) return lowered;
  const nickname = CHAIN_NICKNAMES[lowered];
  if (nickname) return allowed.includes(nickname) ? nickname : null;
  // A real chain this command does not support is not a typo.
  if (knownChains.has(lowered)) return null;
  return closestMatch(chain, allowed, CHAIN_SUGGESTION_CUTOFF);
}

function chainErrors(path, leaf, option, value, endpoints, knownChains) {
  const allowed = supportedChains(leaf, option, endpoints);
  if (!allowed) return [];
  const errors = [];
  for (const chain of splitList(value)) {
    if (typeof chain !== 'string' || allowed.includes(chain)) continue;
    const suggestion = chainSuggestion(chain, allowed, knownChains);
    const hint = suggestion ? ` Did you mean '${suggestion}'?` : '';
    const visible = allowed.filter(name => !(ACCEPTED_CHAIN_ALIASES[leaf.endpoint] || []).includes(name));
    errors.push(fieldError(
      `--${option}`,
      'invalid_field_value',
      `Chain '${chain}' is not supported by ${path}.${hint} Supported chains: ${visible.join(', ')}`,
    ));
  }
  return errors;
}

function valueErrors(name, spec, value) {
  const field = `--${name}`;
  const values = Array.isArray(value) ? value : [value];
  const errors = [];
  for (const item of values) {
    if (spec.type === 'boolean') {
      if (item === true) continue;
      if (!['true', 'false', '1', '0'].includes(String(item).toLowerCase())) {
        errors.push(fieldError(field, 'invalid_field_value', `Option '${field}' must be true or false`));
      }
      continue;
    }
    if (Array.isArray(spec.enum) && spec.enum.length && typeof item !== 'object') {
      const text = String(item);
      if (!spec.enum.some(option => String(option).toLowerCase() === text.toLowerCase())) {
        const options = spec.enum.map(String);
        const suggestion = closestMatch(text, options);
        errors.push(fieldError(field, 'invalid_field_value', suggestion
          ? `Invalid value '${text}' for ${field}. Did you mean '${suggestion}'? Valid options are: ${quotedList(options)}`
          : `Invalid value '${text}' for ${field}. Valid options are: ${quotedList(options)}`));
        continue;
      }
    }
    if (spec.type === 'number' || spec.type === 'integer') {
      const number = typeof item === 'string' && item.trim() !== '' ? Number(item) : (typeof item === 'number' ? item : NaN);
      if (!Number.isFinite(number) || (spec.type === 'integer' && !Number.isSafeInteger(number))) {
        errors.push(fieldError(field, 'invalid_field_value', `Option '${field}' must be ${spec.type === 'integer' ? 'a whole number' : 'a number'}; received: ${String(item)}`));
        continue;
      }
      if (typeof spec.minimum === 'number' && number < spec.minimum) {
        errors.push(fieldError(field, 'value_out_of_range', `Value for '${field}' is out of the allowed range (must be at least ${spec.minimum}); received: ${String(item)}`));
      } else if (typeof spec.maximum === 'number' && number > spec.maximum) {
        errors.push(fieldError(field, 'value_out_of_range', `Value for '${field}' is out of the allowed range (must be at most ${spec.maximum}); received: ${String(item)}`));
      }
      continue;
    }
    if (spec.format === 'date' && !isValidDateOnly(item)) {
      errors.push(fieldError(field, 'invalid_date_format', `Invalid date '${String(item)}' for ${field}. Expected a real calendar date as YYYY-MM-DD.`));
    }
  }
  return errors;
}

/**
 * Check a research command's options before it runs. Throws one NansenError
 * listing every problem (see validationError), or returns quietly.
 */
export function validateResearchInput(resolved, { flags = {}, options = {}, endpoints = {}, chains = [] } = {}) {
  const { path, leaf, positional = [] } = resolved;
  const names = optionNames(leaf);
  const pagination = leaf.pagination !== false;
  const errors = [];
  const given = new Map(); // schema name -> raw value
  const accepted = [...names.keys()].filter(name => names.get(name) === name);
  const visible = [...accepted, ...(pagination ? ['limit', 'page'] : [])].map(name => `--${name}`);

  const supplied = [
    ...Object.entries(options).map(([name, value]) => [name, value]),
    ...Object.entries(flags).filter(([name, value]) => value && !(name in options)).map(([name, value]) => [name, value]),
  ];
  for (const [raw, value] of supplied) {
    const canonical = names.get(raw);
    if (canonical) {
      given.set(canonical, value);
      continue;
    }
    if (COMMON_OPTIONS.has(raw)) continue;
    if (PAGINATION_OPTIONS.has(raw)) {
      if (pagination) {
        if (PAGINATION_SPECS[raw]) given.set(raw, value);
        continue;
      }
      errors.push(fieldError(`--${raw}`, 'unknown_field', `Option '--${raw}' is not supported by ${path}: this endpoint does not paginate.`));
      continue;
    }
    const field = raw.length === 1 ? `-${raw}` : `--${raw}`;
    const suggestion = closestMatch(raw, accepted);
    errors.push(fieldError(field, 'unknown_field', suggestion
      ? `Option '${field}' is not recognized by ${path}. Did you mean '--${suggestion}'?`
      : `Option '${field}' is not recognized by ${path}. Valid options are: ${visible.join(', ') || 'none'} (plus output options; see: nansen schema).`));
  }

  for (const [name, value] of given) {
    const spec = leaf.options?.[name] ?? PAGINATION_SPECS[name];
    if (!spec) continue;
    if (spec.type !== 'boolean' && isBlank(value)) {
      errors.push(fieldError(`--${name}`, 'missing_field', `Option '--${name}' requires a value.`));
      continue;
    }
    errors.push(...valueErrors(name, spec, value));
  }

  for (const [name, spec] of Object.entries(leaf.options || {})) {
    if (!spec.required || given.has(name)) continue;
    if (spec.positional && positional.length > 0) continue;
    if ((spec.requiredUnless || []).some(other => given.has(other))) continue;
    const alternatives = (spec.requiredUnless || []).map(other => `--${other}`);
    errors.push(fieldError(`--${name}`, 'missing_field', alternatives.length
      ? `Required option '--${name}' is missing (or pass ${alternatives.join(' or ')}).`
      : `Required option '--${name}' is missing.`));
  }

  for (const option of ['chain', 'chains']) {
    if (!given.has(option) || isBlank(given.get(option))) continue;
    errors.push(...chainErrors(path, leaf, option, given.get(option), endpoints, new Set(chains)));
  }

  if (errors.length) throw validationError(errors);
}

/** Reject an output format the CLI cannot write. */
export function validateOutputOptions({ flags = {}, options = {} } = {}) {
  if (flags.format === true || (typeof options.format === 'string' && options.format.trim() === '')) {
    throw validationError([fieldError('--format', 'missing_field', "Option '--format' requires a value. Valid options are: 'json' or 'csv'")]);
  }
  if (options.format === undefined) return;
  const valid = ['json', 'csv'];
  if (typeof options.format !== 'string' || !valid.includes(options.format)) {
    const text = typeof options.format === 'string' ? options.format : JSON.stringify(options.format);
    const suggestion = closestMatch(text, valid);
    throw validationError([fieldError('--format', 'invalid_field_value', suggestion
      ? `Invalid value '${text}' for --format. Did you mean '${suggestion}'? Valid options are: ${quotedList(valid)}`
      : `Invalid value '${text}' for --format. Valid options are: ${quotedList(valid)}`)]);
  }
}

// ============= --fields =============

/** Every key, and every key path counted from the root, in a response payload. */
function collectKeys(data) {
  const names = new Set();
  const paths = new Set();
  let arrays = 0;
  let rows = 0;
  (function walk(node, path, depth) {
    if (depth > 12 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      arrays++;
      for (const item of node.slice(0, 200)) {
        if (item !== null && typeof item === 'object') rows++;
        walk(item, path, depth + 1);
      }
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      const keyPath = path ? `${path}.${key}` : key;
      names.add(key);
      paths.add(keyPath);
      walk(value, keyPath, depth + 1);
    }
  })(data, '', 0);
  // Lists that are all empty: the row fields are unknown, not absent.
  return { names, paths, empty: arrays > 0 && rows === 0 };
}

/**
 * Reject --fields names that match nothing. A name is known when the response
 * has that key at any depth (a dotted path must exist at that position), or
 * when the command's schema lists it in `returns`. An empty response (no
 * rows) is never rejected: it cannot show which fields exist.
 */
export function validateFieldSelection(data, fields, { path, returns = [] } = {}) {
  if (!fields?.length) return;
  const { names, paths, empty } = collectKeys(data);
  const documented = new Set(returns);
  // With no rows there is nothing to compare against, and a schema `returns`
  // list may be incomplete, so an empty result never fails here.
  if (empty || names.size === 0) return;
  const candidates = [...new Set([...names, ...documented])].filter(name => !name.startsWith('_'));
  const errors = [];
  for (const field of fields) {
    const known = field.includes('.')
      ? paths.has(field) || documented.has(field) || names.has(field.split('.').pop())
      : names.has(field) || documented.has(field);
    if (known) continue;
    const suggestion = closestMatch(field.split('.').pop(), candidates);
    const where = path ? ` from ${path}` : '';
    errors.push(fieldError('--fields', 'unknown_field', suggestion
      ? `Field '${field}' is not in the response${where}. Did you mean '${suggestion}'?`
      : `Field '${field}' is not in the response${where}. Available fields: ${candidates.slice(0, 40).join(', ')}`));
  }
  if (errors.length) throw validationError(errors);
}

// ============= Filters =============

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Lowercase every EVM address (0x + 40 hex) inside a filters object. The API
 * stores EVM addresses lowercase, so a checksummed address in a filter
 * matched nothing and returned an empty success. Other address formats
 * (Solana, Tron, TON, ...) are case-sensitive and never match the pattern.
 */
export function normalizeFilterAddresses(value) {
  if (typeof value === 'string') return EVM_ADDRESS.test(value) ? value.toLowerCase() : value;
  if (Array.isArray(value)) return value.map(normalizeFilterAddresses);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeFilterAddresses(item)]));
  }
  return value;
}
