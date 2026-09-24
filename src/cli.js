import { authConfigView } from './auth-credentials.js';
import { browserLogin, defaultAuthState, cleanupMessage } from './auth-login.js';
import { readApiKeyInput } from './auth-key-input.js';
/**
 * Nansen CLI - Core logic (testable)
 * Extracted from index.js for coverage
 */

import { NansenAPI, NansenError, CommandError, ErrorCode, getConfigFile, validateAddress, normalizeAddress, sleep } from './api.js';
import { buildWalletCommands, WALLET_SUBCOMMANDS } from './wallet.js';
import { buildBridgeCommands, formatBridgeRoutes } from './bridge.js';
import { buildPerpCommands } from './perp.js';
import { buildTradingCommands } from './trading.js';
import { buildLimitOrderCommands } from './limit-order.js';
import { formatAlertsTable, buildAlertsCommands } from './commands/alerts.js';
import { buildAgentCommands } from './commands/agent.js';
import { buildMcpCommands } from './commands/mcp.js';
import { buildCompletionCommands } from './commands/completion.js';
import { buildResearchCommands, RESEARCH_HISTORICAL_SUBCOMMANDS, RESEARCH_SUBCOMMANDS } from './commands/research.js';
import { buildPagination, parseSort, parseCsvOption, rejectBlankOption, parseObjectOption } from './query-options.js';
import { enableAutoPagination, DEFAULT_MAX_PAGES, MAX_PAGES_LIMIT, locateRows } from './auto-paginate.js';
export { buildPagination, parseSort };
import { resolveAddress, isEnsName } from './ens.js';
import { compareSemver } from './semver.js';
import fs from 'fs';
import { getUpdateNotification, getUpgradeNotice, scheduleUpdateCheck } from './update-check.js';
import { getAuthStatus, runDoctorChecks, runConnectivityChecks, formatDoctorReport } from './doctor.js';
import { refreshCostMapIfStale, getCostForEndpoint, creditsCharged } from './cost-cache.js';
import { collectCacheStats, clearCaches, formatCacheStats, formatCacheClear } from './cache-inspect.js';
import { creditWarning, noticeWarnings } from './response-meta.js';
import { trackCommandSucceeded, trackCommandFailed, trackAuthCommand } from './telemetry.js';
import { setDebugEnabled } from './debug.js';
import { createRequire } from 'module';
import * as readline from 'readline';

const require = createRequire(import.meta.url);
const { version: VERSION, engines: ENGINES } = require('../package.json');

// ============= Schema Definition =============

const schemaDefinition = require('./schema.json');

// SCHEMA is the static definition with version injected at runtime.
// The schema.json file is the source of truth for command metadata (returns, options, etc.)
// and should be updated whenever the API changes — do not edit returns arrays here.
export const SCHEMA = { version: VERSION, ...schemaDefinition };

// ============= Pagination =============

/**
 * Resolve a boolean CLI option that can be passed as either:
 *   --flag          (flag=true, options key absent)
 *   --flag true     (options key = 'true')
 *   --flag false    (options key = 'false')
 * Returns true/false/undefined (undefined = not supplied).
 */
export function resolveBooleanOption(options, flags, key) {
  const optionValue = options[key];
  const flagValue = flags[key];

  if (Array.isArray(optionValue) || Array.isArray(flagValue) ||
      (optionValue !== undefined && flagValue !== undefined)) {
    throw new NansenError(`--${key} cannot be repeated`, ErrorCode.INVALID_PARAMS);
  }
  if (optionValue !== undefined) {
    const val = String(optionValue).toLowerCase();
    if (val === 'true' || val === '1') return true;
    if (val === 'false' || val === '0') return false;
    throw new NansenError(`--${key} must be true or false`, ErrorCode.INVALID_PARAMS);
  }
  if (flagValue !== undefined) return Boolean(flagValue);
  return undefined;
}

// ============= Field Filtering =============

/**
 * Filter object to include only specified fields.
 *
 * A bare name ("address") matches that key at any depth. A dotted path
 * ("data.results", "results.address") matches only at that position, counted
 * from the root of the payload; array elements do not add a segment, so
 * "results.address" selects `address` inside each item of `results`.
 */
export function filterFields(data, fields) {
  if (!fields || fields.length === 0) return data;
  
  const names = new Set();
  const paths = new Set();
  for (const field of fields) {
    (field.includes('.') ? paths : names).add(field);
  }
  
  function filterObject(obj, path) {
    if (obj === null || obj === undefined) return obj;
    if (Array.isArray(obj)) {
      return obj.map(item => filterObject(item, path));
    }
    if (typeof obj !== 'object') return obj;
    
    const filtered = {};
    for (const key of Object.keys(obj)) {
      const keyPath = path ? `${path}.${key}` : key;
      if (names.has(key) || paths.has(keyPath)) {
        // Explicitly requested — include as-is
        filtered[key] = obj[key];
      } else if (typeof obj[key] === 'object' && obj[key] !== null) {
        if (Array.isArray(obj[key])) {
          // Only recurse into arrays whose elements are plain objects.
          // Primitive arrays (e.g. tags: ["a","b"]) are dropped unless the
          // key was explicitly requested (handled above).
          const hasObjectElements = obj[key].length > 0 &&
            typeof obj[key][0] === 'object' && obj[key][0] !== null;
          if (hasObjectElements) {
            const nested = obj[key].map(item => filterObject(item, keyPath))
              .filter(item => Object.keys(item).length > 0);
            if (nested.length > 0) {
              filtered[key] = nested;
            }
          }
        } else {
          // Plain object — always recurse in case it wraps requested fields
          const nested = filterObject(obj[key], keyPath);
          if (nested !== null && nested !== undefined && Object.keys(nested).length > 0) {
            filtered[key] = nested;
          }
        }
      }
    }
    return filtered;
  }
  
  return filterObject(data, '');
}

/**
 * Parse comma-separated fields string
 */
export function parseFields(fieldsOption) {
  if (fieldsOption === undefined || fieldsOption === '') return null;
  if (typeof fieldsOption !== 'string') {
    throw new NansenError('--fields must be a comma-separated string', ErrorCode.INVALID_PARAMS);
  }
  return fieldsOption.split(',').map(f => f.trim()).filter(f => f.length > 0);
}

/**
 * Produce a compact schema listing commands with params* notation.
 * Use `nansen schema --full` for the verbose version.
 */
export function compactSchema(schema) {
  function compactOptions(opts) {
    if (!opts) return '';
    return Object.entries(opts)
      .map(([name, o]) => `${name}${o.required ? '*' : ''}`)
      .join(', ');
  }

  function compactCmd(prefix, cmd) {
    const entries = [];
    if (cmd.subcommands) {
      for (const [name, sub] of Object.entries(cmd.subcommands)) {
        const path = prefix ? `${prefix} ${name}` : name;
        if (sub.subcommands) {
          entries.push(...compactCmd(path, sub));
        } else {
          const params = compactOptions(sub.options);
          entries.push({ command: path, description: sub.description, params, returns: sub.returns });
        }
      }
    } else {
      const params = compactOptions(cmd.options);
      entries.push({ command: prefix, description: cmd.description, params, returns: cmd.returns });
    }
    return entries;
  }

  const commands = [];
  for (const [name, cmd] of Object.entries(schema.commands)) {
    commands.push(...compactCmd(name, cmd));
  }

  return {
    version: schema.version,
    params_legend: '* = required',
    commands,
    globalOptions: Object.keys(schema.globalOptions).join(', '),
    // Which commands cache, and how to control it. One rule rather than a flag
    // repeated on every command — caching is a property of the request path,
    // not of the individual command.
    caching: schema.caching,
    chains: schema.chains,
    smartMoneyLabels: schema.smartMoneyLabels
  };
}

// Long options that never consume the next argument. The shell-completion
// generator needs the same list to tell an option's value apart from a
// subcommand, so it lives here rather than inline in parseArgs.
export const VALUELESS_FLAGS = new Set([
  'pretty', 'help', 'version', 'table', 'no-retry', 'cache', 'no-cache', 'stream',
  'enrich', 'full', 'human', 'no-browser', 'api-key-stdin', 'enabled', 'disabled', 'expert', 'json', 'offline',
  'no-simulate', 'no-verify-outcome', 'no-revoke-excessive-allowance', 'dry-run',
  'send-api-key', 'all', 'max', 'gasless', 'auto-slippage', 'unsafe-no-password',
  'reveal', 'yes', 'paginate', 'debug',
]);

export function parseArgs(args) {
  const result = { _: [], flags: {}, options: {} };

  const addFlag = (key) => {
    if (key in result.flags) {
      if (!Array.isArray(result.flags[key])) result.flags[key] = [result.flags[key]];
      result.flags[key].push(true);
    } else {
      result.flags[key] = true;
    }
  };
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    if (arg.startsWith('--')) {
      const equalsIndex = arg.indexOf('=');
      const inlineKey = equalsIndex === -1 ? null : arg.slice(2, equalsIndex);
      // `--help=false` is neither help nor a meaningful false value: valueless
      // switches only accept their bare spelling. Reject it instead of leaking
      // a stale `flags['help=false']` key that no handler will ever inspect.
      if (inlineKey !== null && VALUELESS_FLAGS.has(inlineKey)) {
        throw new NansenError(`--${inlineKey} does not accept a value`, ErrorCode.INVALID_PARAMS);
      }
      // Value-taking options, including boolean options handled by
      // resolveBooleanOption(), accept the conventional `--key=value` spelling.
      const hasInlineValue = inlineKey !== null;
      const key = hasInlineValue ? inlineKey : arg.slice(2);
      const next = hasInlineValue ? arg.slice(equalsIndex + 1) : args[i + 1];
      
      if (VALUELESS_FLAGS.has(key)) {
        // Repeating a switch is idempotent. Keeping the value strictly true
        // avoids leaking `[true, true]` into consumers that use `=== true`.
        result.flags[key] = true;
      // `next !== undefined` rather than a truthiness check: an explicit empty
      // string is a real value, and skipping it here left `""` dangling to be
      // picked up as a positional arg on the next iteration.
      // An inline value was explicitly supplied and is always consumed, even
      // when it begins with a dash; downstream option validation owns whether
      // that value is meaningful. The dash guard applies only to two-token
      // input, where `--key --next` denotes two separate arguments.
      } else if (hasInlineValue || (next !== undefined && (!next.startsWith('-') || /^-\d/.test(next)))) {
        // Try to parse as JSON so object/array options (`--filters '{}'`,
        // `--order-by '[...]'`) arrive structured. Numbers stay strings to
        // avoid precision loss and scientific notation for large integers
        // (e.g. 1e+21). The bare keywords true/false/null stay strings too:
        // no option takes a boolean or null *value*, so coercing them would
        // silently retype a string option (`--sort true` used to become the
        // boolean true). Boolean options read the strings 'true'/'false'
        // through resolveBooleanOption().
        let parsedValue = next;
        try {
          const parsed = JSON.parse(next);
          if (typeof parsed !== 'number' && typeof parsed !== 'boolean' && parsed !== null) {
            parsedValue = parsed;
          }
        } catch {
          // Not JSON: keep the raw string.
        }
        if (!hasInlineValue) i++;
        // Accumulate repeated options into arrays (supports repeatable flags like --token, --subject)
        if (key in result.options) {
          if (!Array.isArray(result.options[key])) {
            result.options[key] = [result.options[key]];
          }
          result.options[key].push(parsedValue);
        } else {
          result.options[key] = parsedValue;
        }
      } else {
        addFlag(key);
      }
    } else if (arg.startsWith('-')) {
      addFlag(arg.slice(1));
    } else {
      result._.push(arg);
    }
  }
  
  return result;
}

function parseSafeIntegerOption(
  name,
  options,
  flags,
  defaultValue,
  requirement = 'safe integer',
) {
  if (flags[name]) {
    throw new NansenError(
      `--${name} requires a ${requirement} value`,
      ErrorCode.INVALID_PARAMS,
    );
  }

  if (options[name] === undefined) return defaultValue;

  const rawValue = options[name];

  if (Array.isArray(rawValue)) {
    throw new NansenError(
      `--${name} may only be specified once`,
      ErrorCode.INVALID_PARAMS,
    );
  }

  if (
    typeof rawValue === 'boolean' ||
    (typeof rawValue === 'string' && rawValue.trim() === '')
  ) {
    throw new NansenError(
      `--${name} requires a ${requirement} value`,
      ErrorCode.INVALID_PARAMS,
    );
  }

  const value =
    typeof rawValue === 'string' || typeof rawValue === 'number'
      ? Number(rawValue)
      : NaN;

  if (!Number.isSafeInteger(value)) {
    throw new NansenError(
      `--${name} must be a ${requirement}; received: ${String(rawValue)}`,
      ErrorCode.INVALID_PARAMS,
    );
  }

  return value;
}

function parseFiniteNumberOption(name, options, flags) {
  if (flags[name]) {
    throw new NansenError(
      `--${name} requires a finite number`,
      ErrorCode.INVALID_PARAMS,
    );
  }
  if (options[name] === undefined) return undefined;

  const rawValue = options[name];
  if (Array.isArray(rawValue)) {
    throw new NansenError(
      `--${name} may only be specified once`,
      ErrorCode.INVALID_PARAMS,
    );
  }
  if (typeof rawValue === 'string' && rawValue.trim() === '') {
    throw new NansenError(
      `--${name} requires a finite number`,
      ErrorCode.INVALID_PARAMS,
    );
  }
  const value = typeof rawValue === 'string' || typeof rawValue === 'number'
    ? Number(rawValue)
    : NaN;
  if (!Number.isFinite(value)) {
    throw new NansenError(
      `--${name} must be a finite number; received: ${String(rawValue)}`,
      ErrorCode.INVALID_PARAMS,
    );
  }
  return value;
}

function parseNonNegativeSafeIntegerOption(name, options, flags, defaultValue) {
  const value = parseSafeIntegerOption(
    name,
    options,
    flags,
    defaultValue,
    'non-negative safe integer',
  );

  // Callers without an option or default intentionally receive undefined.
  // Do not rely on JavaScript's `undefined < 0` coercion for that contract.
  if (value === undefined) return undefined;

  if (value < 0) {
    throw new NansenError(
      `--${name} must be a non-negative safe integer; received: ${value}`,
      ErrorCode.INVALID_PARAMS,
    );
  }

  return value;
}

function parsePositiveSafeIntegerOption(name, options, flags, defaultValue, { max } = {}) {
  const value = parseSafeIntegerOption(
    name,
    options,
    flags,
    defaultValue,
    'positive safe integer',
  );

  // Keep the helper safe for future optional callers; the current pagination
  // caller supplies DEFAULT_MAX_PAGES whenever this parser is activated.
  if (value === undefined) return undefined;

  if (value < 1) {
    throw new NansenError(
      `--${name} must be a positive safe integer; received: ${value}`,
      ErrorCode.INVALID_PARAMS,
    );
  }

  if (max !== undefined && value > max) {
    throw new NansenError(
      `--${name} must be at most ${max}; received: ${value}`,
      ErrorCode.INVALID_PARAMS,
    );
  }

  return value;
}


function parseDaysOption(options, flags) {
  const days = parseNonNegativeSafeIntegerOption('days', options, flags, 30);
  // Safe integers can still exceed JavaScript Date's representable range.
  // Anchor the overflow check to the Unix epoch so the boundary is deterministic.
  const fromMs = 0 - days * 24 * 60 * 60 * 1000;
  if (Number.isNaN(new Date(fromMs).getTime())) {
    throw new NansenError(
      `--days is outside the supported date range; received: ${days}`,
      ErrorCode.INVALID_PARAMS,
    );
  }
  return days;
}

// Format a single value for table display
export function formatValue(val) {
  if (val === null || val === undefined) return '';
  if (typeof val === 'number') {
    if (Math.abs(val) >= 1000000) return (val / 1000000).toFixed(2) + 'M';
    if (Math.abs(val) >= 1000) {
      const formatted = (val / 1000).toFixed(2);
      if (Math.abs(parseFloat(formatted)) >= 1000) return (val / 1000000).toFixed(2) + 'M';
      return formatted + 'K';
    }
    if (Number.isInteger(val)) return val.toString();
    return val.toFixed(2);
  }
  if (typeof val === 'object') return JSON.stringify(val);
  return String(val);
}

// Table formatter for human-readable output
export function formatTable(data) {
  // Extract array of records from various response shapes
  const located = locateRows(data, { descriptive: true });
  let records = located?.rows || [];
  if (!located && typeof data === 'object' && data !== null) {
    // Single object - convert to array
    records = [data];
  }

  if (records.length === 0) {
    return 'No data';
  }

  // Get columns from first record, prioritize common useful fields
  const priorityFields = ['token_symbol', 'token_name', 'symbol', 'name', 'wallet_address', 'address', 'label', 'chain', 'value_usd', 'amount', 'pnl_usd', 'price_usd', 'volume_usd', 'net_flow_usd', 'timestamp', 'block_timestamp'];
  const allKeys = [...new Set(records.flatMap(r => Object.keys(r)))];

  // Sort: priority fields first, then alphabetically
  const columns = allKeys.sort((a, b) => {
    const aIdx = priorityFields.indexOf(a);
    const bIdx = priorityFields.indexOf(b);
    if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
    if (aIdx !== -1) return -1;
    if (bIdx !== -1) return 1;
    return a.localeCompare(b);
  }).slice(0, 8); // Limit to 8 columns for readability

  // Calculate column widths
  const widths = columns.map(col => {
    const headerLen = col.length;
    const maxDataLen = Math.max(...records.map(r => {
      const val = formatValue(r[col]);
      return val.length;
    }));
    return Math.min(Math.max(headerLen, maxDataLen), 30); // Cap at 30 chars
  });

  // Build table
  const separator = '─';
  const lines = [];

  // Header
  const header = columns.map((col, i) => col.padEnd(widths[i])).join(' │ ');
  lines.push(header);
  lines.push(widths.map(w => separator.repeat(w)).join('─┼─'));

  // Rows
  for (const record of records.slice(0, 50)) { // Limit to 50 rows
    const row = columns.map((col, i) => {
      const val = formatValue(record[col]);
      return val.slice(0, widths[i]).padEnd(widths[i]);
    }).join(' │ ');
    lines.push(row);
  }

  if (records.length > 50) {
    lines.push(`... and ${records.length - 50} more rows`);
  }

  return lines.join('\n');
}

/**
 * Format data as CSV with header row
 */
export function formatCsv(data) {
  // Extract array of records from various response shapes
  const located = locateRows(data, { descriptive: true });
  let records = located?.rows || [];
  if (!located && typeof data === 'object' && data !== null) {
    records = [data];
  }

  if (records.length === 0) return '';

  const columns = [...new Set(records.flatMap(r => Object.keys(r)))];

  const escape = (val) => {
    if (val === null || val === undefined) return '';
    const s = typeof val === 'object' ? JSON.stringify(val) : String(val);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  };

  const lines = [columns.join(',')];
  for (const record of records) {
    lines.push(columns.map(col => escape(record[col])).join(','));
  }
  return lines.join('\n');
}

// Render the error envelope for the non-JSON formats. CSV gets a real header
// row plus one record so the envelope stays machine-parseable; table keeps the
// leading `Error:` line and follows it with one `key: value` line per field, so
// code, status and details are not dropped on the way to the terminal.
function formatErrorText(data, { csv = false } = {}) {
  if (csv) return formatCsv(data);
  const lines = [`Error: ${data.error}`];
  for (const [key, val] of Object.entries(data)) {
    if (key === 'success' || key === 'error' || val == null) continue;
    lines.push(`${key}: ${typeof val === 'object' ? JSON.stringify(val) : val}`);
  }
  return lines.join('\n');
}

// Format output data (returns string, does not print)
export function formatOutput(data, { pretty = false, table = false, csv = false } = {}) {
  if (csv || table) {
    if (data.success === false) {
      return { type: 'error', text: formatErrorText(data, { csv }) };
    }
    const body = data.data || data;
    return csv
      ? { type: 'csv', text: formatCsv(body) }
      : { type: 'table', text: formatTable(body) };
  } else if (pretty) {
    return { type: 'json', text: JSON.stringify(data, null, 2) };
  } else {
    return { type: 'json', text: JSON.stringify(data) };
  }
}

// Codes whose message is a usage banner written for a human to read: multi-line,
// indented, with a blank line between sections. Serialising one into the error
// envelope turns every newline into a literal \n and makes it unreadable, so an
// interactive terminal gets the message as written instead. Piped or explicitly
// formatted output still gets the envelope, so agents keep one shape to branch on.
export const USAGE_ERROR_CODES = new Set(['MISSING_PARAM', 'MISSING_ARGS']);

export function isUsageError(errorData, { pretty, table, csv, stream, isTTY }) {
  if (!USAGE_ERROR_CODES.has(errorData.code)) return false;
  // API errors can map onto the same semantic code (for example the server's
  // `missing_field` becomes MISSING_PARAM), but they are not local usage
  // banners and must retain the structured envelope in every output mode.
  if (errorData.status != null) return false;
  if (pretty || table || csv || stream) return false;
  return !!isTTY;
}

// Format error data (returns object, does not exit)
export function formatError(error) {
  const details = error.details ?? error.data ?? null;
  const result = {
    success: false,
    error: error.message,
    code: error.code || 'UNKNOWN',
    status: error.status || null,
  };
  // Hoisted so the id survives even if details is omitted or later pruned.
  if (details?.requestId) {
    result.requestId = details.requestId;
  }
  if (details != null && !(typeof details === 'object' && !Array.isArray(details) && Object.keys(details).length === 0)) {
    result.details = details;
  }
  return result;
}

/**
 * Format data as JSON lines (NDJSON) for streaming output
 * Each record is output as a separate JSON line
 */
export function formatStream(data) {
  if (data?.success === false) return JSON.stringify(data);
  // Extract array of records from various response shapes
  const located = locateRows(data, { descriptive: true });
  let records = located?.rows || [];
  if (!located && typeof data === 'object' && data !== null) {
    // Single object - output as single line
    records = [data];
  }

  if (records.length === 0) {
    return '';
  }

  // Output each record as a separate JSON line
  return records.map(record => JSON.stringify(record)).join('\n');
}

/**
 * Parse --date option into {from, to} object.
 * Accepts: "YYYY-MM-DD" (single date → from=date, to=date),
 *          '{"from":"YYYY-MM-DD","to":"YYYY-MM-DD"}' (JSON object),
 *          or already-parsed object {from, to}.
 * Falls back to days-based range if no date provided.
 */
function isValidDateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function parseDateOption(dateOption, days = 30, valuelessDateFlag = false) {
  if (valuelessDateFlag) {
    throw new NansenError(
      '--date requires a value in YYYY-MM-DD format or a JSON date range',
      ErrorCode.INVALID_PARAMS,
    );
  }

  if (dateOption === undefined) {
    // Default: use days-based range only when --date was not supplied.
    const to = new Date().toISOString().split('T')[0];
    const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    return { from, to };
  }

  let parsedOption = dateOption;
  if (typeof parsedOption === 'string' && !isValidDateOnly(parsedOption)) {
    try {
      parsedOption = JSON.parse(parsedOption);
    } catch {
      // Keep the original value so the actionable validation error below is used.
    }
  }

  if (typeof parsedOption === 'string' && isValidDateOnly(parsedOption)) {
    return { from: parsedOption, to: parsedOption };
  }

  if (parsedOption && typeof parsedOption === 'object' && !Array.isArray(parsedOption)) {
    const { from, to } = parsedOption;
    if (isValidDateOnly(from) && (to === undefined || isValidDateOnly(to))) {
      return { from, to: to ?? from };
    }
  }

  throw new NansenError(
    '--date must be YYYY-MM-DD or a JSON object with a valid "from" date and optional "to" date',
    ErrorCode.INVALID_PARAMS,
  );
}

// Enrich transfers with Nansen labels for from/to addresses
async function enrichTransfers(result, apiInstance, chain) {
  const transfers = result?.data?.results || result?.transfers || result?.data || [];
  if (!Array.isArray(transfers) || transfers.length === 0) return result;

  // Collect unique addresses (cap at 50)
  const addrs = new Set();
  for (const t of transfers) {
    if (t.from) addrs.add(t.from);
    if (t.to) addrs.add(t.to);
    if (addrs.size >= 50) break;
  }

  // Batch lookup labels
  const labelMap = {};
  for (const addr of addrs) {
    try {
      const labelsResult = await apiInstance.addressLabels({
        address: addr,
        chain,
        requestOptions: { autoPaginate: false },
      });
      labelMap[addr] = Array.isArray(labelsResult?.data)
        ? labelsResult.data.map(item => item.label)
        : labelsResult?.labels || [];
    } catch {
      labelMap[addr] = [];
    }
  }

  // Merge labels into transfers
  for (const t of transfers) {
    if (t.from && labelMap[t.from]) t.from_labels = labelMap[t.from];
    if (t.to && labelMap[t.to]) t.to_labels = labelMap[t.to];
  }

  return result;
}

// ============= Address Parsing =============

/**
 * Parse an --addresses option that may arrive as:
 *  - a pre-parsed array (arg parser split it)
 *  - a JSON array string: '["0x…","0x…"]'
 *  - a comma-separated string: "0x…,0x…"
 * Non-array JSON values (objects, numbers, booleans) are rejected.
 */
export function parseAddressList(raw) {
  if (Array.isArray(raw)) {
    return raw.map(a => String(a).trim()).filter(Boolean);
  }
  if (!raw) return [];

  const s = String(raw);
  try {
    const parsed = JSON.parse(s);
    if (Array.isArray(parsed)) {
      return parsed.map(a => String(a).trim()).filter(Boolean);
    }
    throw new NansenError(
      '--addresses must be a comma-separated list or JSON array, got: ' + typeof parsed,
      ErrorCode.INVALID_PARAMS
    );
  } catch (e) {
    if (e instanceof NansenError) throw e;
    return s.split(',').map(a => a.trim()).filter(Boolean);
  }
}

/**
 * Read an address list from a file: either a JSON array of address strings or
 * one address per line. Shared by the profiler commands that accept --file.
 */
function readAddressFile(file) {
  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new NansenError(
      `Could not read --file ${file}: ${err.code === 'ENOENT' ? 'no such file' : err.message}`,
      ErrorCode.INVALID_PARAMS
    );
  }
  try {
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed) || !parsed.every(item => typeof item === 'string')) {
      throw new NansenError(
        'File must contain a JSON array of address strings or one address per line',
        ErrorCode.INVALID_PARAMS
      );
    }
    return parsed.map(a => a.trim()).filter(Boolean);
  } catch (e) {
    if (e instanceof NansenError) throw e;
    return content.split('\n').map(a => a.trim()).filter(Boolean);
  }
}

// ============= Composite Functions =============

export async function batchProfile(api, params = {}) {
  const { addresses = [], chain = 'ethereum', include = ['labels', 'balance'], delayMs = 1000 } = params;
  const results = [];
  for (let i = 0; i < addresses.length; i++) {
    let address = addresses[i].trim();
    const entry = { address, chain };

    // Resolve ENS names
    if (isEnsName(address)) {
      try {
        const resolved = await resolveAddress(address, chain);
        entry.ensName = resolved.ensName;
        address = resolved.address;
        entry.address = address;
      } catch (err) {
        entry.error = err.message;
        results.push(entry);
        if (i < addresses.length - 1) await sleep(delayMs);
        continue;
      }
    }

    const validation = validateAddress(address, chain);
    if (!validation.valid) {
      entry.error = validation.error;
      results.push(entry);
      if (i < addresses.length - 1) await sleep(delayMs);
      continue;
    }
    try {
      if (include.includes('labels')) {
        const labelsResult = await api.addressLabels({
          address,
          chain,
          requestOptions: { autoPaginate: false },
        });
        entry.labels = Array.isArray(labelsResult?.data)
          ? labelsResult.data
          : labelsResult?.labels || [];
      }
      if (include.includes('balance')) {
        entry.balance = await api.addressBalance({ address, chain });
      }
      if (include.includes('pnl')) {
        entry.pnl = await api.addressPnl({
          address,
          chain,
          requestOptions: { autoPaginate: false },
        });
      }
    } catch (err) {
      entry.error = err.message;
    }
    results.push(entry);
    if (i < addresses.length - 1) await sleep(delayMs);
  }
  return { results, total: addresses.length, completed: results.filter(r => !r.error).length };
}

function normalizeTraceDepth(raw, flags = {}) {
  const value = parseSafeIntegerOption(
    'depth',
    { depth: raw },
    flags,
  );

  return Math.max(1, Math.min(value, 5));
}

// --width is the fan-out at every hop, so it multiplies with --depth: an
// unbounded width on a hub-style address (exchange, router) turns one
// invocation into hundreds of counterparties calls and credits. Clamp it the
// way --depth is clamped, and stop expanding the graph past MAX_TRACE_NODES
// as a backstop for the depth × width product.
const MAX_TRACE_WIDTH = 50;
const MAX_TRACE_NODES = 1000;

function normalizeTraceWidth(raw) {
  const value = parseNonNegativeSafeIntegerOption(
    'width',
    { width: raw },
    {},
    10,
  );

  return Math.max(1, Math.min(value, MAX_TRACE_WIDTH));
}

export async function traceCounterparties(api, params = {}) {
  let { address, chain = 'ethereum', depth = 2, depthFlags = {}, width = 10, days = 30, delayMs = 1000 } = params;
  if (!address) {
    throw new NansenError('address is required for trace', ErrorCode.MISSING_PARAM);
  }

  // Resolve ENS names
  if (isEnsName(address)) {
    try {
      const resolved = await resolveAddress(address, chain);
      address = resolved.address;
    } catch (err) {
      throw new NansenError(err.message, ErrorCode.INVALID_ADDRESS);
    }
  }

  const validation = validateAddress(address, chain);
  if (!validation.valid) {
    throw new NansenError(validation.error, ErrorCode.INVALID_ADDRESS);
  }
  const clampedDepth = normalizeTraceDepth(depth, depthFlags);
  const clampedWidth = normalizeTraceWidth(width);
  const visited = new Set();
  const nodes = [];
  const edges = [];
  const queue = [{ addr: address, hop: 0 }];
  visited.add(address);
  nodes.push(address);
  let truncated = false;

  while (queue.length > 0) {
    const { addr, hop } = queue.shift();
    if (hop >= clampedDepth) continue;

    try {
      const result = await api.addressCounterparties({
        address: addr, chain, days,
        pagination: { page: 1, per_page: clampedWidth },
        requestOptions: { autoPaginate: false },
      });

      const counterparties = result?.data?.results || result?.counterparties || result?.data || [];
      const items = Array.isArray(counterparties) ? counterparties.slice(0, clampedWidth) : [];

      for (const cp of items) {
        const cpAddr = cp.counterparty_address || cp.address || cp.counterparty;
        if (!cpAddr) continue;

        edges.push({
          from: addr, to: cpAddr,
          volume_usd: cp.volume_usd || cp.total_volume_usd || 0,
          tx_count: cp.transaction_count || cp.tx_count || 0,
          hop: hop + 1,
        });

        if (!visited.has(cpAddr)) {
          if (nodes.length >= MAX_TRACE_NODES) {
            // The edge is still recorded; the node is just not expanded.
            truncated = true;
            continue;
          }
          visited.add(cpAddr);
          nodes.push(cpAddr);
          queue.push({ addr: cpAddr, hop: hop + 1 });
        }
      }
    } catch {
      // Skip addresses that fail (404, etc) but continue the traversal
    }

    if (queue.length > 0) await sleep(delayMs);
  }

  return {
    root: address, chain, depth: clampedDepth, width: clampedWidth,
    nodes, edges,
    stats: {
      nodes_visited: nodes.length,
      edges_found: edges.length,
      max_depth_reached: Math.max(0, ...edges.map(e => e.hop)),
      truncated,
    },
  };
}

export async function compareWallets(api, params = {}) {
  const { addresses = [], chain = 'ethereum', days = 30, delayMs = 1000 } = params;
  if (addresses.length !== 2) {
    throw new NansenError('Exactly 2 addresses are required for comparison', ErrorCode.INVALID_PARAMS);
  }
  const [addr1, addr2] = addresses;
  for (const addr of [addr1, addr2]) {
    const validation = validateAddress(addr, chain);
    if (!validation.valid) {
      throw new NansenError(validation.error, ErrorCode.INVALID_ADDRESS);
    }
  }

  // Fetch counterparties and balances for both addresses. A failed request is
  // recorded rather than treated as an empty result, so an auth or rate-limit
  // error cannot masquerade as "no overlap" / "0 USD".
  const settle = (promise) => promise.then(value => ({ value }), error => ({ error }));
  const [cp1, cp2] = await Promise.all([
    settle(api.addressCounterparties({
      address: addr1, chain, days, requestOptions: { autoPaginate: false },
    })),
    settle(api.addressCounterparties({
      address: addr2, chain, days, requestOptions: { autoPaginate: false },
    })),
  ]);
  await sleep(delayMs);
  const [bal1, bal2] = await Promise.all([
    settle(api.addressBalance({ address: addr1, chain })),
    settle(api.addressBalance({ address: addr2, chain })),
  ]);

  const outcomes = [
    [addr1, 'counterparties', cp1], [addr2, 'counterparties', cp2],
    [addr1, 'balance', bal1], [addr2, 'balance', bal2],
  ];
  const errors = [];
  const failures = [];
  for (const [address, source, outcome] of outcomes) {
    if (outcome.error) {
      failures.push(outcome.error);
      errors.push({ address, source, code: outcome.error.code ?? 'UNKNOWN', message: outcome.error.message });
    }
  }
  if (failures.length === outcomes.length) {
    throw failures[0];
  }

  // Extract counterparty addresses
  const extractCps = (result) => {
    const list = result?.data?.results || result?.counterparties || result?.data || [];
    return Array.isArray(list) ? list : [];
  };
  let sharedCpAddrs = null;
  if (!cp1.error && !cp2.error) {
    const cpAddrs1 = new Set(extractCps(cp1.value).map(c => c.counterparty_address || c.address || c.counterparty).filter(Boolean));
    const cpAddrs2 = new Set(extractCps(cp2.value).map(c => c.counterparty_address || c.address || c.counterparty).filter(Boolean));
    sharedCpAddrs = [...cpAddrs1].filter(a => cpAddrs2.has(a));
  }

  // Extract token holdings
  const extractTokens = (result) => {
    const list = result?.data?.results || result?.balances || result?.data || [];
    return Array.isArray(list) ? list : [];
  };
  const tokens1 = bal1.error ? null : extractTokens(bal1.value);
  const tokens2 = bal2.error ? null : extractTokens(bal2.value);
  let sharedTokens = null;
  if (tokens1 && tokens2) {
    // Two different contracts can share a symbol, so when both sides report a
    // token address the address decides. When either side has no address for
    // a token (some responses omit it for the native asset) the symbol is the
    // only identity available and is used instead.
    const addressOf = (t) => {
      const address = t.token_address || t.mint || t.address;
      return address ? String(address).toLowerCase() : null;
    };
    const symbolOf = (t) => (t.token_symbol ? String(t.token_symbol).toLowerCase() : null);
    const addresses2 = new Set(tokens2.map(addressOf).filter(Boolean));
    const symbols2 = new Set(tokens2.map(symbolOf).filter(Boolean));
    const symbolsWithoutAddress2 = new Set(
      tokens2.filter(t => !addressOf(t)).map(symbolOf).filter(Boolean)
    );
    const seen = new Set();
    sharedTokens = [];
    for (const t of tokens1) {
      const address = addressOf(t);
      const symbol = symbolOf(t);
      // With an address on both sides only the address counts. If either
      // side omits it (as some responses do for the native asset) a matching
      // symbol is taken as the same token.
      const matched = address
        ? addresses2.has(address) || (symbol && symbolsWithoutAddress2.has(symbol))
        : symbol && symbols2.has(symbol);
      const key = address || symbol;
      if (matched && !seen.has(key)) {
        seen.add(key);
        sharedTokens.push(t.token_symbol || address);
      }
    }
  }
  const totalUsd = (tokens) => tokens === null
    ? null
    : tokens.reduce((sum, t) => sum + (t.value_usd ?? t.balance_usd ?? 0), 0);

  return {
    addresses: [addr1, addr2], chain,
    shared_counterparties: sharedCpAddrs,
    shared_tokens: sharedTokens,
    balances: [
      { address: addr1, total_usd: totalUsd(tokens1) },
      { address: addr2, total_usd: totalUsd(tokens2) },
    ],
    ...(errors.length > 0 && { incomplete: true, errors }),
  };
}

export const BANNER = '';

export const HELP = `Nansen CLI v${VERSION} - analytics and DEX trading for AI agents.

USAGE: nansen <command> [subcommand] [options]

COMMANDS:
  trade       DEX swaps/bridges: quote, execute, bridge-status, limit-order
  bridge      Hyperliquid bridge: quote, execute, status (EVM <-> HL)
  perp        Hyperliquid perps: order, cancel, close, leverage, transfer, approve-builder-fee, positions, orders, account, meta, screener, leaderboard
  research    analytics: smart-money, profiler, token, search, perp, portfolio
  wallet      ${WALLET_SUBCOMMANDS.join(', ')}
  agent       Ask the Nansen AI research agent (fast/expert modes)
  alerts      list, create, update, toggle, delete
  web         search, fetch
  mcp         install/uninstall/verify the Nansen MCP server
  account     Check the effective credential, plan, and remaining credits (free)
  auth        status — offline credential source and cached/unverified session metadata
  login       Sign in through browser approval (--no-browser for remote terminals)
  logout      Remove saved API authentication; preserve wallets
  doctor      Diagnostics: auth, wallets, caches, connectivity (--offline --json)
  schema      JSON schema for all commands (use "nansen schema <cmd>" for one)
  completion  Shell completions: bash, zsh, fish
  cache       stats, clear
  changelog   --since <version> to filter

OPTIONS: --chain --limit --page N --sort field:dir --fields a,b --days N --filters '{}'
PAGING:  --paginate (alias --all) fetch every page, --max-pages N (default 10), --limit sets page size
FORMAT:  --pretty --table --format csv --stream (NDJSON)
RETRY:   --no-retry --retries N --cache --cache-ttl N
DEBUG:   --debug (or NANSEN_DEBUG=1) traces each request on stderr: method, URL,
         status, time-to-headers (TTFB), retries, request id. Never prints
         credentials or bodies.

AUTHENTICATION:
  nansen login                 Fresh browser approval, even with an existing key/session
  nansen login --no-browser    Same approval without opening the browser
  nansen auth status           Offline, cached/unverified; does not open session storage
  nansen account               Free live check of the effective credential
  nansen login --human         Explicit legacy key setup; also persists an injected env key
  nansen login --api-key-stdin Read a key from a pipe or file; never echo the key
  NANSEN_API_KEY overrides saved authentication. Selected credentials never auto-pay.
  Browser sessions renew automatically; uncertain renewal requires fresh login.
  Browser nansen:api sessions have API-key-equivalent account permissions; wallet signing is separate.
  Browser login needs native storage and enabled server admission; release gates remain open.
  Public API endpoints keep their usual account, plan and credit checks; MCP key export is separate.

TRADING:
  nansen trade quote --chain solana --from SOL --to USDC --amount 1000000000
  nansen trade execute --quote <quoteId>
  nansen trade bridge-status --tx-hash <hash> --from-chain base --to-chain solana
  nansen trade limit-order create --from SOL --to USDC --amount 1.5 --trigger-mint SOL --trigger-condition below --trigger-price 80
  Supports Solana/Base DEX swaps, cross-chain bridges, and Solana limit orders.

BRIDGE (Hyperliquid):
  nansen bridge quote --from-chain base --to-chain hyperliquid --from-token USDC --amount 1000000
  nansen bridge execute --quote <quoteId>
  nansen bridge status --request-id <id>
  Supports EVM chains (ethereum, base, arbitrum, polygon, bnb) <-> Hyperliquid.

EXAMPLES:
  nansen trade quote --chain base --from ETH --to USDC --amount 1000000000000000000
  nansen trade quote --chain base --to-chain solana --from USDC --to USDC --amount 1000000
  nansen research smart-money netflow --chain solana
  nansen research token screener --chain solana --timeframe 24h
  nansen research profiler balance --address 0x... --chain ethereum

DEPRECATED ALIASES (still work, will be removed in a future version):
  smart-money, profiler, token, search, portfolio → use "nansen research <command>"
  quote, execute → use "nansen trade <command>"

Research chains: ${SCHEMA.chains.join(', ')}
Trade chains: solana, base
Bridge chains: ethereum, base, arbitrum, polygon, bnb, hyperliquid
Labels: Fund, Smart Trader, 30D/90D/180D Smart Trader, Smart HL Perps Trader

Docs: https://docs.nansen.ai
Skills: npx skills add nansen-ai/nansen-cli (agent-optimised docs per command group)

Telemetry: anonymous usage stats (commands, timing, errors). Perp order/close additionally send each leg's side, outcome, order id, shared submission id, and a SHA-256 wallet identifier. Raw wallet, price, size, and exchange error text are not sent. Disable: DO_NOT_TRACK=1
`;

// Usage text for the `cache` command group. Also the answer to "which commands
// cache?" — caching is decided by the request path, so the rule lives here (and
// in schema.json under `caching`) rather than being repeated per command.
export const CACHE_HELP = `nansen cache — inspect and clear the caches this CLI keeps on disk

SUBCOMMANDS:
  stats [--json]      What each cache holds: entries, size, age, effective TTL
  clear [target]      Delete cached entries (default target: responses)

CLEAR TARGETS:
  responses     API responses saved when --cache is passed (default)
  cost-map      Per-endpoint credit costs, refreshed every 24h
  update-check  Latest published version, refreshed every 24h
  all           All three

WHAT CACHES:
  Caching is off by default and opt-in per invocation with --cache. With it on,
  every read the CLI makes through the Nansen API client is served from and
  written to the response cache — that is all of "nansen research ...", plus
  "alerts list" and "alerts get".
  Never cached: account, web search, web fetch, alerts create/update/toggle/delete,
  agent (streamed), every trade, bridge, wallet and mcp command, and perp trading.
  The analytics commands "perp screener" and "perp leaderboard" are cached.

CACHE OPTIONS (for any command):
  --cache               Enable caching for this invocation
  --no-cache            Bypass the cache for this invocation (or NANSEN_NO_CACHE=1)
  --cache-ttl <seconds> Non-negative safe integer TTL (default: 300; 0 disables reads)

EXAMPLES:
  nansen cache stats
  nansen cache stats --json --pretty
  nansen cache clear
  nansen cache clear all

Saved trade quotes are not a cache and are never touched by "cache clear": they
expire on their own, and an unexecuted quote is still spendable. Credentials,
wallets and config are never changed by this command. CLI startup loads the saved
config as usual.`;

// Usage text for the `trade` command group. Shared by the trade handler and the
// --help path in runCLI, so `nansen trade`, `nansen trade <sub> --help`, and the
// deprecated top-level `quote`/`execute --help` all show the same usage.
export const TRADE_USAGE = `nansen trade — DEX trading commands

SUBCOMMANDS:
  quote          Get a swap quote (price, route, fees)
  execute        Sign and broadcast a quoted swap
  bridge-status  Check cross-chain bridge transaction status
  limit-order    Limit order management (Solana only)

USAGE:
  nansen trade quote --chain <chain> --from <token> --to <token> --amount <units> [--wallet <name>]
  nansen trade quote --chain <chain> --to-chain <chain> --from <token> --to <token> --amount <units>
  nansen trade execute --quote <quoteId> [--wallet <name>] [--dry-run] [--yes]
  nansen trade bridge-status --tx-hash <hash> --from-chain <chain> --to-chain <chain>
  nansen trade limit-order <create|list|cancel|update> [options]

EXAMPLES:
  nansen trade quote --chain solana --from SOL --to USDC --amount 1000000000
  nansen trade quote --chain base --from ETH --to USDC --amount 1000000000000000000
  nansen trade quote --chain base --to-chain solana --from USDC --to USDC --amount 1000000
  nansen trade execute --quote 1708900000000-abc123
  nansen trade bridge-status --tx-hash 0xabc... --from-chain base --to-chain solana
  nansen trade limit-order create --from SOL --to USDC --amount 1.5 --trigger-mint SOL --trigger-condition below --trigger-price 80
  nansen trade limit-order list

WALLET:
  --wallet <name>   Use a named wallet, or "walletconnect" / "wc" for WalletConnect.
                    Defaults to the default local wallet if omitted.

BEFORE BROADCASTING (execute only):
  --dry-run         Validate and print what would be sent, then stop. Nothing is
                    signed or broadcast and the quote stays usable. Exits 0.
  --yes, -y         Skip the confirmation prompt (same as NANSEN_YES=1). The prompt
                    only appears when stdin is a terminal — agents, CI and pipes run
                    unprompted either way. Declining exits 1 with nothing signed.

SYMBOLS:
  Common tokens resolve automatically: SOL, ETH, USDC, USDT, WETH
  Raw addresses are also accepted.

CROSS-CHAIN NOTES (when using --to-chain):
  Supported combos:
    native → native (ETH <-> SOL)
    USDC → USDC (both directions)
    USDC → native (USDC → ETH or SOL)
    native → USDC (ETH/SOL → USDC)
    non-native → non-native — not supported (use USDC as intermediate)
  Bridge providers: Li.Fi or Relay (selected automatically based on best price)
  Typical bridge time: 1-5 minutes`;

// Helper to prompt for input (exported for mocking). Output defaults to stderr
// so the prompt and masked `*` characters stay on the terminal and never land
// in a redirected stdout (matching wallet.js promptPassword).
export async function prompt(question, hidden = false, { input = process.stdin, output = process.stderr } = {}) {
  return new Promise((resolve) => {
    if (hidden && input.isTTY) {
      output.write(question);
      let value = '';
      input.setRawMode(true);
      input.resume();
      input.setEncoding('utf8');
      
      const onData = (char) => {
        if (char === '\n' || char === '\r') {
          input.setRawMode(false);
          input.pause();
          input.removeListener('data', onData);
          output.write('\n');
          resolve(value);
        } else if (char === '\u0003') {
          // Ctrl+C
          process.exit();
        } else if (char === '\u007F' || char === '\b') {
          // Backspace
          if (value.length > 0) {
            value = value.slice(0, -1);
            output.write('\b \b');
          }
        } else {
          value += char;
          output.write('*');
        }
      };
      
      input.on('data', onData);
    } else {
      const rl = readline.createInterface({
        input,
        output
      });
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      });
    }
  });
}

// Confirmation prompts belong to the CLI adapter rather than trade/bridge
// core. EOF and Ctrl+C resolve as the safe default ("no") so a closed input
// cannot leave an irreversible command hanging forever.
export async function promptForConfirmation(question, { input = process.stdin, output = process.stderr } = {}) {
  const rl = readline.createInterface({ input, output });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (answer) => {
      if (settled) return;
      settled = true;
      rl.close();
      resolve(answer);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      rl.close();
      reject(error);
    };

    rl.once('close', () => finish(''));
    rl.once('SIGINT', () => finish(''));
    rl.once('error', fail);
    rl.question(question, finish);
  });
}

// `token screener --search` filters client-side, so it can only find a token
// among the candidate rows the API returned. These helpers describe that window
// as `_meta.search: { query, searched, matched, complete }` so a short or empty
// result can be told apart from "the token ranks below the rows we fetched".
function locatePaginationSummary(result) {
  const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (isObject(result?.pagination)) return result.pagination;
  if (isObject(result?.data?.pagination)) return result.data.pagination;
  return null;
}

function describeSearchWindow({ query, candidates, matched, perPage, summary }) {
  let complete;
  if (typeof summary?.complete === 'boolean') {
    // --paginate traversal summary (auto-paginate.js): false when --max-pages
    // stopped the walk before the server ran out of rows. It also carries the
    // first page's stale is_last_page, so it has to be checked first.
    complete = summary.complete;
  } else if (typeof summary?.is_last_page === 'boolean') {
    // Server metadata on the single candidate page.
    complete = summary.is_last_page;
  } else {
    // No metadata: a full page means the API may hold more rows beyond it.
    complete = candidates.length < perPage;
  }
  return { query, searched: candidates.length, matched, complete };
}

function searchWindowNote(searchMeta, summary, paginateAll) {
  const rows = `${searchMeta.searched} screener row${searchMeta.searched === 1 ? '' : 's'}`;
  if (paginateAll) {
    const pages = Number.isInteger(summary?.pages_fetched)
      ? ` after ${summary.pages_fetched} candidate page${summary.pages_fetched === 1 ? '' : 's'} (--max-pages)`
      : '';
    const resume = Number.isInteger(summary?.next_page) ? ` or resume with --page ${summary.next_page}` : '';
    return `Note: --search stopped${pages} with ${rows} checked; tokens beyond them were not searched (_meta.search.complete: false). Raise --max-pages${resume}.`;
  }
  return `Note: --search matched against only the first ${rows}; tokens ranked below them were not searched (_meta.search.complete: false). Widen the window with --limit <n> (max 1000) or --paginate, or narrow the candidates with --filters.`;
}

// Build command handlers (returns object with handler functions)
export function buildCommands(deps = {}) {
  // Allow dependency injection for testing
  const {
    api: _api = null,
    // Password/API-key input belongs to login and may be hidden. Confirmation
    // is a separate contract: callers must opt into it explicitly so this
    // prompt can never be reused for an irreversible yes/no decision.
    promptFn = prompt,
    confirmationPromptFn,
    log = console.log,
    errorOutput = console.error,
    NansenAPIClass: _NansenAPIClass = NansenAPI,
    authState = defaultAuthState(),
    browserLoginFn = browserLogin,
    getConfigFileFn = getConfigFile,
    stdoutTTY = deps.isTTY ?? process.stdout.isTTY,
    stdinTTY = deps.isTTY ?? process.stdin.isTTY,
    stdin = process.stdin,
    env = process.env
  } = deps;

  const cmds = {
    'account': async (_args, apiInstance, _flags, _options) => {
      return apiInstance.getAccount();
    },

    'auth': async (args, _apiInstance, _flags, _options) => {
      const subcommand = args[0] || 'status';
      if (subcommand !== 'status') {
        throw new NansenError(`Unknown auth subcommand: ${subcommand}. Available: status`, ErrorCode.UNKNOWN);
      }
      return getAuthStatus();
    },

    'doctor': async (_args, _apiInstance, flags, _options) => {
      const checks = runDoctorChecks({ cliVersion: VERSION, engines: ENGINES });
      if (!flags.offline) {
        checks.push(...await runConnectivityChecks());
      }
      if (flags.json) {
        return {
          version: VERSION,
          offline: Boolean(flags.offline),
          checks,
          errors: checks.filter(c => c.status === 'error').length,
          warnings: checks.filter(c => c.status === 'warn').length,
        };
      }
      log(formatDoctorReport(checks, { cliVersion: VERSION, offline: Boolean(flags.offline) }));
    },


    'web': async (args, apiInstance, flags, options) => {
      const subcommand = args[0] || 'help';
      const subArgs = args.slice(1);

      const handlers = {
        'search': async () => {
          // Accept queries as positional args or --query (repeated)
          let queries = subArgs.length > 0 ? subArgs : [];
          if (options.query !== undefined) {
            const fromOption = Array.isArray(options.query) ? options.query : [options.query];
            if (!fromOption.every(q => typeof q === 'string')) {
              throw new NansenError(
                '--query values must be strings',
                ErrorCode.INVALID_PARAMS,
              );
            }
            queries = queries.concat(fromOption);
          }
          queries = queries.filter(q => q.trim());
          if (queries.length === 0) {
            throw new NansenError('At least one query is required. Usage: nansen web search "bitcoin price" --num-results 5', ErrorCode.MISSING_PARAM);
          }
          let numResults;
          if (options['num-results'] !== undefined || flags['num-results']) {
            numResults = parseSafeIntegerOption('num-results', options, flags, undefined, 'whole number between 1 and 20');
            if (numResults < 1 || numResults > 20) {
              throw new NansenError('--num-results must be between 1 and 20', ErrorCode.INVALID_PARAMS);
            }
          }
          return apiInstance.webSearch({ queries, numResults });
        },

        'fetch': async () => {
          // Accept URLs as positional args or --url (repeated)
          let urls = subArgs.length > 0 ? subArgs : [];
          if (options.url !== undefined) {
            const fromOption = Array.isArray(options.url) ? options.url : [options.url];
            urls = urls.concat(fromOption);
          }
          if (urls.length === 0) {
            throw new NansenError('At least one URL is required. Usage: nansen web fetch https://example.com --question "What is this about?"', ErrorCode.MISSING_PARAM);
          }
          for (const u of urls) {
            try { new URL(u); } catch {
              throw new NansenError(`Invalid URL: "${u}". URLs must include a scheme, e.g. https://example.com`, ErrorCode.INVALID_PARAMS);
            }
          }
          if (Array.isArray(options.question)) {
            throw new NansenError('--question may only be specified once', ErrorCode.INVALID_PARAMS);
          }
          if (options.question !== undefined && typeof options.question !== 'string') {
            throw new NansenError('--question must be a string', ErrorCode.INVALID_PARAMS);
          }
          if (!options.question || !options.question.trim()) {
            throw new NansenError('--question is required and cannot be blank. Usage: nansen web fetch https://example.com --question "What is this about?"', ErrorCode.MISSING_PARAM);
          }
          return apiInstance.webFetch({ urls, question: options.question });
        },

        'help': async () => ({
          subcommands: ['search', 'fetch'],
          description: 'Web search and fetch commands',
          examples: [
            'nansen web search "bitcoin price"',
            'nansen web search "solana news" --num-results 5',
            'nansen web fetch https://nansen.ai --question "What does Nansen do?"',
          ],
        }),
      };

      if (!handlers[subcommand]) {
        throw new NansenError(`Unknown web subcommand: ${subcommand}. Available: search, fetch`, ErrorCode.UNKNOWN);
      }

      return handlers[subcommand]();
    },

    'login': async (args, apiInstance, flags, options) => {
      if ('api-key-stdin' in options) throw new CommandError('--api-key-stdin does not accept a value.', 'INVALID_PARAMS');
      const fromStdin = flags['api-key-stdin'] === true;
      if (fromStdin && (args.length || flags.human || flags['no-browser'] || flags['api-key'] || 'api-key' in options)) {
        throw new CommandError('--api-key-stdin cannot be combined with arguments, --api-key, --human, or --no-browser.', 'INVALID_PARAMS');
      }
      if (flags['api-key']) throw new CommandError('--api-key requires a value.', 'MISSING_PARAM');
      if ('api-key' in options && typeof options['api-key'] !== 'string') throw new CommandError('--api-key must be a single key string.', 'INVALID_PARAMS');
      if (!fromStdin && !flags.human && options['api-key'] === undefined) {
        return browserLoginFn({ flags, env, isTTY: stdoutTTY, log, errorOutput, state: authState });
      }
      if (flags['no-browser']) throw new CommandError('--no-browser cannot be combined with legacy key setup.', 'INVALID_PARAMS');
      let apiKey = fromStdin ? await readApiKeyInput(stdin, stdinTTY) : options['api-key'];

      if (apiKey === undefined) {
        apiKey = env.NANSEN_API_KEY?.trim() || undefined;
      }

      if (apiKey === undefined && flags.human) {
        if (!stdinTTY) {
          throw new CommandError('--human requires an interactive terminal. Set NANSEN_API_KEY in the environment (or pass --api-key <key>, which is recorded in shell history).', 'NOT_A_TTY', {
            error: 'NOT_A_TTY',
            message: '--human requires an interactive terminal. Set NANSEN_API_KEY in the environment (or pass --api-key <key>, which is recorded in shell history).',
          });
        }
        log('Nansen CLI Login\n');
        log('Get your API key at: https://app.nansen.ai/auth/agent-setup\n');
        apiKey = await promptFn('Enter your API key: ', true);
      }

      if (!apiKey || apiKey.trim().length === 0) {
        throw new CommandError('No API key provided.', 'API_KEY_REQUIRED', {
          error: 'API_KEY_REQUIRED',
          message: 'No API key provided.',
          resolution: [
            'Run in an interactive terminal: nansen login --human',
            'Or set NANSEN_API_KEY in the environment',
            'Get your API key at: https://app.nansen.ai/auth/agent-setup',
          ],
        });
      }

      let accountInfo;
      let cleanup;
      const baseUrl = authConfigView(env).baseUrl;
      const attempt = await authState.begin({ preflight: false });
      try {
        // Verify API key before saving
        const NansenAPIClass = _NansenAPIClass;
        const testApi = new NansenAPIClass(apiKey.trim(), baseUrl, {
          allowPayment: false,
          retry: { maxRetries: 2 },
          cache: { enabled: false }
        });

        try {
          accountInfo = await testApi.getAccount();
        } catch (error) {
          if (error.code === ErrorCode.UNAUTHORIZED) {
            throw new CommandError('The API key is not valid.', 'INVALID_API_KEY', {
              error: 'INVALID_API_KEY',
              message: 'The API key is not valid.',
              resolution: ['Check or rotate your key at https://app.nansen.ai/api?tab=api'],
            });
          }
          // Restore signal from the STRUCTURED error code only — never from
          // error.message, which can echo the upstream response body (and the key
          // with it). A transient failure shouldn't read as "check your key".
          let message = 'Could not verify API key.';
          let resolution = ['Check your internet connection', 'Try again'];
          if (error.code === ErrorCode.RATE_LIMITED) {
            message = 'Rate limited while verifying the API key.';
            resolution = ['Wait a moment, then retry explicit key setup: nansen login --human'];
          } else if (error.code === ErrorCode.SERVER_ERROR || error.code === ErrorCode.SERVICE_UNAVAILABLE) {
            message = 'The Nansen API is unavailable right now, so the key could not be verified.';
            resolution = ['Try again shortly'];
          } else if (error.code === ErrorCode.TIMEOUT) {
            message = 'Timed out verifying the API key.';
            resolution = ['Check your connection', 'Try again'];
          }
          throw new CommandError(message, 'VERIFICATION_FAILED', {
            error: 'VERIFICATION_FAILED',
            message,
            resolution,
          });
        }

        const result = await authState.install(attempt, { apiKey: apiKey.trim(), baseUrl });
        cleanup = result.cleanup;
        if (!fromStdin || !flags.json) for (const message of cleanupMessage(cleanup)) log(message);
      } finally { await authState.finish(attempt); }
      const blankEnvKey = env.NANSEN_API_KEY !== undefined && !env.NANSEN_API_KEY.trim();
      if (fromStdin && flags.json) {
        log(JSON.stringify({ event: 'saved', effective_source: env.NANSEN_API_KEY !== undefined ? 'env' : 'config', environment_key_blank: blankEnvKey, cleanup }));
        return;
      }
      if (env.NANSEN_API_KEY !== undefined) log(blankEnvKey
        ? 'NANSEN_API_KEY is blank. Commands will fail until you unset it or supply a valid environment key.'
        : 'Commands still use NANSEN_API_KEY. Unset it to use the saved credential.');

      log(`✓ Saved to ${getConfigFileFn()}\n`);
      if (accountInfo?.plan) {
        log(`Plan: ${accountInfo.plan}`);
      }
      if (accountInfo?.credits_remaining !== undefined) {
        log(`Credits remaining: ${accountInfo.credits_remaining}`);
      }
      log(blankEnvKey ? '\nUnset NANSEN_API_KEY to use the saved credential, then try:' : '\nYou can now use the Nansen CLI. Try:');
      log('  nansen research token screener --chain solana --pretty');
    },

    'logout': async (_args, _apiInstance, _flags, _options) => {
      const result = await authState.logout();
      if (result.cleanup.some(item => item.local === 'incomplete')) log('Saved authentication selection cleared; secure-store deletion incomplete.');
      else log(result.removed ? 'Local credentials removed.' : 'No saved credentials found.');
      for (const message of cleanupMessage(result.cleanup)) log(message);
      if (env.NANSEN_API_KEY !== undefined) log('Warning: NANSEN_API_KEY remains active. Run: unset NANSEN_API_KEY');
    },

    'help': async (_args, _apiInstance, _flags, _options) => {
      log(HELP);
    },

    'changelog': async (_args, _apiInstance, _flags, _options) => {
      if (_flags.help || _flags.h) {
        log('changelog — Show release history\n\nUsage:\n  nansen changelog [--since <version>]\n\nOptions:\n  --since <version>   Show only entries for versions >= this version\n\nExamples:\n  nansen changelog\n  nansen changelog --since 1.10.0');
        return;
      }
      const changelogPath = new URL('../CHANGELOG.md', import.meta.url).pathname;
      let content;
      try {
        content = fs.readFileSync(changelogPath, 'utf8');
      } catch {
        log('CHANGELOG.md not found. Visit https://github.com/nansen-ai/nansen-cli/blob/main/CHANGELOG.md');
        return;
      }
      const since = _options.since;
      if (since) {
        // compareSemver treats a missing trailing component as 0, so accept
        // "1", "1.43", and "1.43.0" alike here — but anything that isn't
        // digits-and-dots (e.g. "abc") needs a clear error instead of
        // silently comparing as if it were version 0.0.0, which would show
        // every entry rather than flag the typo.
        if (!/^v?\d+(\.\d+){0,2}$/.test(String(since))) {
          throw new NansenError(
            `Invalid --since value "${since}": expected a version like 1.43 or 1.43.0.`,
            ErrorCode.INVALID_PARAMS
          );
        }
        // Show only entries from the given version onwards
        const lines = content.split('\n');
        const filtered = [];
        let include = false;
        for (const line of lines) {
          // Match ## [x.y.z] (Keep a Changelog format) or ## x.y.z (changeset format)
          const match = line.match(/^## \[(\d+\.\d+\.\d+)\]|^## (\d+\.\d+\.\d+)\b/);
          if (match) {
            const ver = match[1] || match[2];
            // Compare: include versions >= since, stop at versions < since
            if (compareSemver(ver, since) >= 0) {
              include = true;
            } else {
              include = false;
            }
          }
          if (include) filtered.push(line);
        }
        log(filtered.join('\n') || `No changelog entries found for versions >= ${since}`);
      } else {
        log(content);
      }
    },

    'schema': async (args, _apiInstance, flags, _options) => {
      const subcommand = args[0];
      const schemaEntry = subcommand && (SCHEMA.commands[subcommand] || SCHEMA.commands.research.subcommands[subcommand]);

      if (schemaEntry) {
        return {
          command: subcommand,
          ...schemaEntry,
          globalOptions: SCHEMA.globalOptions,
          chains: SCHEMA.chains,
          smartMoneyLabels: SCHEMA.smartMoneyLabels
        };
      }

      if (flags.full) {
        return SCHEMA;
      }

      return compactSchema(SCHEMA);
    },

    'cache': async (args, _apiInstance, flags, options) => {
      const subcommand = args[0] ?? 'help';

      const handlers = {
        'stats': () => {
          // The TTL this invocation would apply, so "expired" means what the
          // next call would actually discard.
          const responseTtlSeconds = parseNonNegativeSafeIntegerOption('cache-ttl', options, flags, 300);
          const stats = collectCacheStats({ responseTtlSeconds });
          if (flags.json) return stats;
          log(formatCacheStats(stats));
        },
        'clear': () => {
          // Deleting local state needs an explicit target. The default is the
          // response cache alone — the one cache that is always safely
          // refetchable — and wiping everything requires saying "all".
          const target = args[1] ?? 'responses';
          log(formatCacheClear(clearCaches(target)));
        },
        'help': () => {
          log(CACHE_HELP);
        }
      };

      if (!Object.hasOwn(handlers, subcommand)) {
        throw new NansenError(
          `Unknown cache subcommand: ${subcommand}. Use one of: stats, clear`,
          ErrorCode.INVALID_PARAMS,
        );
      }

      const maxArgs = subcommand === 'clear' ? 2 : 1;
      if (args.length > maxArgs) {
        throw new NansenError(
          `Too many cache arguments. Use: nansen cache ${subcommand}${subcommand === 'clear' ? ' [responses|cost-map|update-check|all]' : ''}`,
          ErrorCode.INVALID_PARAMS,
        );
      }
      return handlers[subcommand]();
    },

    'smart-money': async (args, apiInstance, flags, options) => {
      rejectBlankOption(options.days, 'days', '30');
      rejectBlankOption(options.chain, 'chain', 'solana');
      rejectBlankOption(options.chains, 'chains', 'solana');
      const subcommand = args[0] || 'help';
      const chain = options.chain || 'solana';
      const chains = options.chains || [chain];
      const filters = parseObjectOption(options.filters, 'filters');
      const orderBy = parseSort(options.sort, options['order-by']);
      const pagination = buildPagination(options);

      // Add smart money label filter if specified
      if (options.labels) {
        filters.include_smart_money_labels = Array.isArray(options.labels) 
          ? options.labels 
          : [options.labels];
      }

      const days = subcommand === 'historical-holdings'
        ? parseDaysOption(options, flags)
        : 30;

      const handlers = {
        'netflow': () => apiInstance.smartMoneyNetflow({ chains, filters, orderBy, pagination }),
        'dex-trades': () => apiInstance.smartMoneyDexTrades({ chains, filters, orderBy, pagination }),
        'perp-trades': () => apiInstance.smartMoneyPerpTrades({ filters, orderBy, pagination, onlyNewPositions: resolveBooleanOption(options, flags, 'only-new-positions') }),
        'holdings': () => apiInstance.smartMoneyHoldings({ chains, filters, orderBy, pagination }),
        'dcas': () => apiInstance.smartMoneyDcas({ filters, orderBy, pagination }),
        'historical-holdings': () => apiInstance.smartMoneyHistoricalHoldings({ chains, filters, orderBy, pagination, days }),
        'help': () => ({
          commands: ['netflow', 'dex-trades', 'perp-trades', 'holdings', 'dcas', 'historical-holdings'],
          description: 'Smart Money analytics endpoints',
          example: 'nansen smart-money netflow --chain solana --labels Fund'
        })
      };

      if (!handlers[subcommand]) {
        return { error: `Unknown subcommand: ${subcommand}`, available: Object.keys(handlers) };
      }

      return handlers[subcommand]();
    },

    'profiler': async (args, apiInstance, flags, options) => {
      rejectBlankOption(options.days, 'days', '30');
      rejectBlankOption(options.chain, 'chain', 'ethereum');
      const subcommand = args[0] || 'help';
      let address = options.address;
      const entityName = options.entity || options['entity-name'];
      const chain = options.chain || 'all';

      // Resolve ENS names (e.g. vitalik.eth → 0x...)
      let ensName;
      if (address && isEnsName(address)) {
        try {
          const ensChain = subcommand === 'first-funder' ? 'ethereum' : chain;
          const resolved = await resolveAddress(address, ensChain);
          address = resolved.address;
          ensName = resolved.ensName;
        } catch (err) {
          throw new NansenError(err.message, ErrorCode.INVALID_ADDRESS);
        }
      }
      const filters = parseObjectOption(options.filters, 'filters');
      const orderBy = parseSort(options.sort, options['order-by']);
      const pagination = buildPagination(options);
      const days = [
        'transactions',
        'pnl',
        'historical-balances',
        'counterparties',
        'counterparties-batch',
        'pnl-summary',
        'perp-trades',
        'dex-trades',
        'trace',
        'compare',
      ].includes(subcommand)
        ? parseDaysOption(options, flags)
        : 30;

      const handlers = {
        'balance': () => apiInstance.addressBalance({ address, entityName, chain, filters, orderBy }),
        'labels': () => apiInstance.addressLabels({ address, chain, pagination }),
        'transactions': () => {
          const date = parseDateOption(options.date, days, flags.date);
          return apiInstance.addressTransactions({ address, chain, filters, orderBy, pagination, days, date });
        },
        'pnl': () => {
          const date = parseDateOption(options.date, days, flags.date);
          return apiInstance.addressPnl({ address, chain, date, days, filters, orderBy, pagination });
        },
        'search': () => apiInstance.entitySearch({ query: options.query }),
        'historical-balances': () => apiInstance.addressHistoricalBalances({ address, chain, filters, orderBy, pagination, days }),
        'related-wallets': () => apiInstance.addressRelatedWallets({ address, chain, orderBy, pagination }),
        'first-funder': () => apiInstance.addressFirstFunder({ address }),
        'counterparties': () => apiInstance.addressCounterparties({ address, chain, filters, orderBy, pagination, days }),
        'counterparties-batch': () => {
          const addresses = options.addresses
            ? parseAddressList(options.addresses)
            : (options.file ? readAddressFile(options.file) : []);
          return apiInstance.addressCounterpartiesBatch({ addresses, chain, filters, orderBy, pagination, days });
        },
        'pnl-summary': () => apiInstance.addressPnlSummary({ address, chain, orderBy, pagination, days }),
        'perp-positions': () => apiInstance.addressPerpPositions({ address, filters, orderBy, pagination }),
        'perp-trades': () => apiInstance.addressPerpTrades({ address, filters, orderBy, pagination, days }),
        'dex-trades': () => {
          const date = parseDateOption(options.date, days, flags.date);
          return apiInstance.addressDexTrades({ address, chain, filters, orderBy, pagination, days, date });
        },
        'batch': () => {
          rejectBlankOption(options.delay, 'delay', '1000');
          let addresses = [];
          if (options.addresses) {
            addresses = parseAddressList(options.addresses);
          } else if (options.file) {
            addresses = readAddressFile(options.file);
          }
          if (addresses.length > 100) {
            throw new NansenError('Batch is limited to 100 addresses', ErrorCode.INVALID_PARAMS);
          }
          const parsedInclude = parseCsvOption(options.include, 'include');
          const include = (parsedInclude && parsedInclude.length > 0) ? parsedInclude : ['labels', 'balance'];
          const delayMs = parseNonNegativeSafeIntegerOption('delay', options, flags, 1000);
          return batchProfile(apiInstance, { addresses, chain, include, delayMs });
        },
        'trace': () => {
          rejectBlankOption(options.delay, 'delay', '1000');
          rejectBlankOption(options.depth, 'depth', '2');
          const depth = options.depth;
          const width = parseNonNegativeSafeIntegerOption('width', options, flags, 10);
          const delayMs = parseNonNegativeSafeIntegerOption('delay', options, flags, 1000);
          return traceCounterparties(apiInstance, { address, chain, depth, depthFlags: flags, width, days, delayMs });
        },
        'compare': () => {
          const addrs = parseAddressList(options.addresses);
          return compareWallets(apiInstance, { addresses: addrs, chain, days });
        },
        'help': () => ({
          commands: ['balance', 'labels', 'transactions', 'pnl', 'search', 'historical-balances', 'related-wallets', 'first-funder', 'counterparties', 'counterparties-batch', 'pnl-summary', 'perp-positions', 'perp-trades', 'dex-trades', 'batch', 'trace', 'compare'],
          description: 'Wallet profiling endpoints',
          example: 'nansen research profiler compare --addresses "0xABC...,0xDEF..." --chain ethereum'
        })
      };

      if (!handlers[subcommand]) {
        return { error: `Unknown subcommand: ${subcommand}`, available: Object.keys(handlers) };
      }

      const result = await handlers[subcommand]();

      // Attach ENS metadata so the caller knows the name was resolved
      return ensName && result && typeof result === 'object'
        ? { ...result, _ens: { name: ensName, resolvedAddress: address } }
        : result;
    },

    'token': async (args, apiInstance, flags, options) => {
      rejectBlankOption(options.days, 'days', '30');
      rejectBlankOption(options.chain, 'chain', 'solana');
      rejectBlankOption(options.chains, 'chains', 'solana');
      rejectBlankOption(options.timeframe, 'timeframe', '1d');
      rejectBlankOption(options['buy-or-sell'], 'buy-or-sell', 'SELL');
      const subcommand = args[0] || 'help';
      const chain = options.chain || 'solana';
      const tokenAddress = normalizeAddress(options.token || options['token-address'], chain);
      const tokenSymbol = options.symbol || options['token-symbol'];
      const chains = options.chains || [chain];
      const timeframe = options.timeframe || '24h';
      const filters = parseObjectOption(options.filters, 'filters');
      const orderBy = parseSort(options.sort, options['order-by']);
      const pagination = buildPagination(options);
      const days = [
        'flows',
        'dex-trades',
        'pnl',
        'who-bought-sold',
        'transfers',
        'perp-trades',
        'perp-pnl-leaderboard',
      ].includes(subcommand)
        ? parseDaysOption(options, flags)
        : 30;

      // Convenience filter for smart money only
      const onlySmartMoney = resolveBooleanOption(options, flags, 'smart-money') ?? false;
      if (onlySmartMoney) {
        filters.include_smart_money_labels = filters.include_smart_money_labels ||
          ['Fund', 'Smart Trader', '30D Smart Trader', '90D Smart Trader', '180D Smart Trader'];
      }

      const includeStablecoins = resolveBooleanOption(options, flags, 'include-stablecoins');
      if (includeStablecoins !== undefined) {
        filters.include_stablecoins = includeStablecoins;
      }

      const handlers = {
        'indicators': () => apiInstance.tokenIndicators({ tokenAddress, chain }),
        'ohlcv': () => apiInstance.tokenOhlcv({ tokenAddress, chain, timeframe: options.timeframe || '1d' }),
        'info': () => apiInstance.tokenInformation({ tokenAddress, chain, timeframe: options.timeframe }),
        'screener': async () => {
          const search = options.search;
          if (search !== undefined && typeof search !== 'string') {
            throw new NansenError('--search must be a string', ErrorCode.INVALID_PARAMS);
          }
          // When searching, fetch more results to filter from (API has no server-side search).
          // --page/--limit are applied client-side to the filtered list, so the
          // candidate fetch has to cover every page up to the requested one.
          const requestedLimit = pagination?.per_page || 100;
          const requestedPage = pagination?.page || 1;
          const paginateAll = flags.paginate || flags.all;
          const searchPagination = search
            ? {
                page: paginateAll ? requestedPage : 1,
                // A normal client-side search widens its one candidate fetch.
                // With --paginate, keep --limit as the server page size: the
                // traversal already fetches up to --max-pages separately
                // billed pages, so silently multiplying each one to 500 would
                // make the flag much more expensive than documented.
                per_page: paginateAll
                  ? requestedLimit
                  : Math.max(500, requestedPage * requestedLimit),
              }
            : pagination;
          const result = await apiInstance.tokenScreener({ chains, timeframe, filters, orderBy, pagination: searchPagination });
          if (search) {
            const q = search.toLowerCase();
            const offset = (requestedPage - 1) * requestedLimit;
            // Handle nested response shapes: {data: [...]} or {data: {data: [...]}}
            let candidates;
            let rebuild;
            if (Array.isArray(result?.data)) {
              candidates = result.data;
              rebuild = rows => ({ ...result, data: rows });
            } else if (Array.isArray(result?.data?.data)) {
              candidates = result.data.data;
              rebuild = rows => ({ ...result, data: { ...result.data, data: rows } });
            } else {
              return result;
            }
            const matching = candidates.filter(t =>
              (t.token_symbol && t.token_symbol.toLowerCase().includes(q)) ||
              (t.token_name && t.token_name.toLowerCase().includes(q)) ||
              (t.token_address && t.token_address.toLowerCase() === q)
            );
            // Filtering only replaces the row array. With --paginate, the
            // preserved pagination metadata describes candidate traversal,
            // not the number of client-side matches.
            const filtered = rebuild(paginateAll ? matching : matching.slice(offset, offset + requestedLimit));
            // The search only saw the candidates fetched above, so say how far it
            // looked: `complete: false` means the API had more rows past the
            // window and a token that is missing here may simply rank below it.
            const summary = locatePaginationSummary(result);
            const searchMeta = describeSearchWindow({
              query: search, candidates, matched: matching.length, perPage: searchPagination.per_page, summary,
            });
            filtered._meta = { ...(result._meta || {}), search: searchMeta };
            // stderr, so --fields/--table/--csv/--stream callers that never see
            // _meta still learn the search was cut short.
            if (!searchMeta.complete) errorOutput(searchWindowNote(searchMeta, summary, paginateAll));
            return filtered;
          }
          return result;
        },
        'holders': () => apiInstance.tokenHolders({ tokenAddress, chain, labelType: onlySmartMoney ? 'smart_money' : 'all_holders', filters, orderBy, pagination, withLabels: resolveBooleanOption(options, flags, 'premium-labels') }),
        'flows': () => {
          const date = parseDateOption(options.date, days, flags.date);
          const label = options.label;
          return apiInstance.tokenFlows({ tokenAddress, chain, label, filters, orderBy, pagination, days, date });
        },
        'dex-trades': () => apiInstance.tokenDexTrades({ tokenAddress, chain, onlySmartMoney, filters, orderBy, pagination, days }),
        'pnl': () => {
          const withLabels = resolveBooleanOption(options, flags, 'premium-labels');
          return apiInstance.tokenPnlLeaderboard({ tokenAddress, chain, filters, orderBy, pagination, days, withLabels });
        },
        'who-bought-sold': () => {
          const date = parseDateOption(options.date, days, flags.date);
          const buyOrSellRaw = options['buy-or-sell'];
          if (buyOrSellRaw !== undefined && typeof buyOrSellRaw !== 'string') {
            throw new NansenError('--buy-or-sell must be BUY or SELL', ErrorCode.INVALID_PARAMS);
          }
          const buyOrSell = (buyOrSellRaw || 'BUY').toUpperCase();
          if (buyOrSell !== 'BUY' && buyOrSell !== 'SELL') {
            throw new NansenError('--buy-or-sell must be BUY or SELL', ErrorCode.INVALID_PARAMS);
          }
          return apiInstance.tokenWhoBoughtSold({ tokenAddress, chain, buyOrSell, filters, orderBy, pagination, days, date });
        },
        'flow-intelligence': () => apiInstance.tokenFlowIntelligence({ tokenAddress, chain, timeframe: options.timeframe || '1d' }),
        'transfers': () => {
          // Inject --from/--to into filters
          if (options.from) filters.from_address = options.from;
          if (options.to) filters.to_address = options.to;
          return apiInstance.tokenTransfers({ tokenAddress, chain, filters, orderBy, pagination, days });
        },
        'jup-dca': () => apiInstance.tokenJupDca({ tokenAddress, filters, orderBy, pagination }),
        'perp-trades': () => apiInstance.tokenPerpTrades({ tokenSymbol, filters, orderBy, pagination, days }),
        'perp-positions': () => apiInstance.tokenPerpPositions({ tokenSymbol, filters, orderBy, pagination }),
        'perp-pnl-leaderboard': () => {
          const withLabels = resolveBooleanOption(options, flags, 'premium-labels');
          return apiInstance.tokenPerpPnlLeaderboard({ tokenSymbol, filters, orderBy, pagination, days, withLabels });
        },
        'top-tokens': () => {
          const marketCapGroup = options['market-cap'] || options['market-cap-group'];
          const limit = parseNonNegativeSafeIntegerOption('limit', options, flags);
          return apiInstance.topTokens({ marketCapGroup, limit });
        },
        'help': () => ({
          commands: ['info', 'ohlcv', 'screener', 'holders', 'flows', 'dex-trades', 'pnl', 'who-bought-sold', 'flow-intelligence', 'transfers', 'jup-dca', 'perp-trades', 'perp-positions', 'perp-pnl-leaderboard', 'top-tokens'],
          description: 'Token God Mode endpoints',
          example: 'nansen token screener --chain solana --timeframe 24h --smart-money --include-stablecoins false'
        })
      };

      if (!handlers[subcommand]) {
        return { error: `Unknown subcommand: ${subcommand}`, available: Object.keys(handlers) };
      }

      let result = await handlers[subcommand]();

      // Warn when OHLCV price data is null (backend coverage gap)
      // Volume comes from on-chain DEX data and is always available, but price/market_cap
      // requires a price oracle — some tokens are not tracked and return all-null price fields.
      if (subcommand === 'ohlcv') {
        const candles = Array.isArray(result?.data) ? result.data : [];
        if (candles.length === 0) {
          process.stderr.write(`⚠️  No OHLCV data returned for token ${tokenAddress} on ${chain}.\n`);
        } else {
          const hasPrice = candles.some(c => c.open !== null || c.close !== null);
          const hasVolume = candles.some(c => c.volume !== null);
          if (!hasPrice && hasVolume) {
            process.stderr.write(
              `⚠️  Price data unavailable for token ${tokenAddress} on ${chain}.\n` +
              `   open/high/low/close, volume_usd, and market_cap are null.\n` +
              `   Volume (raw token units) is available. This token may not be tracked by Nansen's price oracle.\n`
            );
          } else if (!hasPrice && !hasVolume) {
            process.stderr.write(`⚠️  No OHLCV data available for token ${tokenAddress} on ${chain}.\n`);
          }
        }
      }

      // Enrich transfers with Nansen labels for from/to addresses
      if (subcommand === 'transfers' && (options.enrich || flags.enrich)) {
        // Label lookups are auxiliary requests and may themselves carry a
        // pagination body. Preserve the primary transfer traversal metadata
        // that runCLI reports after the command completes.
        const transferPaginationMeta = apiInstance.paginatedResponseMeta;
        const transferPaginationEndpoint = apiInstance.paginatedEndpoint;
        try {
          result = await enrichTransfers(result, apiInstance, chain);
        } finally {
          apiInstance.paginatedResponseMeta = transferPaginationMeta;
          apiInstance.paginatedEndpoint = transferPaginationEndpoint;
        }
      }

      return result;
    },

    'portfolio': async (args, apiInstance, flags, options) => {
      const subcommand = args[0] || 'help';
      const walletAddress = options.wallet || options.address;

      const handlers = {
        'defi': () => apiInstance.portfolioDefiHoldings({ walletAddress }),
        'defi-holdings': () => apiInstance.portfolioDefiHoldings({ walletAddress }),
        'help': () => ({
          commands: ['defi', 'defi-holdings'],
          description: 'Portfolio analytics endpoints',
          example: 'nansen portfolio defi --wallet 0x123...'
        })
      };

      if (!handlers[subcommand]) {
        return { error: `Unknown subcommand: ${subcommand}`, available: Object.keys(handlers) };
      }

      return handlers[subcommand]();
    },

    'perp': async (args, apiInstance, flags, options) => {
      rejectBlankOption(options.days, 'days', '30');
      const subcommand = args[0] || 'help';
      const filters = parseObjectOption(options.filters, 'filters');
      const orderBy = parseSort(options.sort, options['order-by']);
      const pagination = buildPagination(options);
      const days = ['screener', 'leaderboard'].includes(subcommand)
        ? parseDaysOption(options, flags)
        : 30;

      const handlers = {
        'screener': () => {
          const traderType = options['trader-type'];
          const sectorsFilter = parseCsvOption(options['sectors-filter'], 'sectors-filter');
          const smLabelFilter = parseCsvOption(options['sm-label-filter'], 'sm-label-filter');
          const traderLabelFilter = parseCsvOption(options['trader-label-filter'], 'trader-label-filter');
          return apiInstance.perpScreener({ filters, orderBy, pagination, days, traderType, sectorsFilter, smLabelFilter, traderLabelFilter });
        },
        'leaderboard': () => {
          const withLabels = resolveBooleanOption(options, flags, 'premium-labels');
          return apiInstance.perpLeaderboard({ filters, orderBy, pagination, days, withLabels });
        },
        'help': () => ({
          commands: ['screener', 'leaderboard'],
          description: 'Perpetual futures analytics endpoints',
          example: 'nansen perp screener --days 7 --limit 20'
        })
      };

      if (!handlers[subcommand]) {
        throw new NansenError(`Unknown perp analytics subcommand: ${subcommand}. Available: screener, leaderboard`, ErrorCode.UNKNOWN);
      }

      return handlers[subcommand]();
    },

    'search': async (args, apiInstance, flags, options) => {
      rejectBlankOption(options.chain, 'chain', 'solana');
      return apiInstance.generalSearch({
        query: args[0] || options.query,
        resultType: options.type,
        chain: options.chain,
        limit: options.limit
      });
    },

    'points': async () => {
      throw new CommandError('The points leaderboard endpoint has been removed. Run "nansen research" to explore other analytics commands.', 'COMMAND_UNAVAILABLE');
    },

    'prediction-market': async (args, apiInstance, flags, options) => {
      if (Date.now() < new Date('2026-03-16T00:00:00Z').getTime()) {
        process.stderr.write('⚠️  PnL data for prediction markets is temporarily unavailable while we improve accuracy. We\'ll update once resolved.\n');
      }
      const subcommand = args[0] || 'help';
      const marketId = options['market-id'];
      const address = options.address;
      const sortBy = options['sort-by'];
      const query = options.query;
      const status = options.status;
      const orderBy = parseSort(options.sort, options['order-by']);
      const pagination = buildPagination(options);

      // Screener-specific filter options
      const isScreener = subcommand === 'market-screener' || subcommand === 'event-screener';
      const tags = parseCsvOption(options.tags, 'tags');
      const minLiquidity = isScreener ? parseFiniteNumberOption('min-liquidity', options, flags) : undefined;
      const maxLiquidity = isScreener ? parseFiniteNumberOption('max-liquidity', options, flags) : undefined;
      const minUniqueTraders24h = isScreener ? parseFiniteNumberOption('min-unique-traders-24h', options, flags) : undefined;
      const maxUniqueTraders24h = isScreener ? parseFiniteNumberOption('max-unique-traders-24h', options, flags) : undefined;
      const minVolume24hr = isScreener ? parseFiniteNumberOption('min-volume-24hr', options, flags) : undefined;
      const maxVolume24hr = isScreener ? parseFiniteNumberOption('max-volume-24hr', options, flags) : undefined;
      const negRisk = resolveBooleanOption(options, flags, 'neg-risk');
      const minOpenInterest = isScreener ? parseFiniteNumberOption('min-open-interest', options, flags) : undefined;
      const maxOpenInterest = isScreener ? parseFiniteNumberOption('max-open-interest', options, flags) : undefined;
      const endDateBefore = options['end-date-before'];
      const endDateAfter = options['end-date-after'];
      const minPrice = subcommand === 'market-screener' ? parseFiniteNumberOption('min-price', options, flags) : undefined;
      const maxPrice = subcommand === 'market-screener' ? parseFiniteNumberOption('max-price', options, flags) : undefined;

      const handlers = {
        'ohlcv': () => apiInstance.pmOhlcv({ marketId, orderBy, pagination }),
        'orderbook': () => apiInstance.pmOrderbook({ marketId, pagination }),
        'top-holders': () => apiInstance.pmTopHolders({ marketId, orderBy, pagination }),
        'trades-by-market': () => apiInstance.pmTradesByMarket({ marketId, orderBy, pagination }),
        'trades-by-address': () => apiInstance.pmTradesByAddress({ address, orderBy, pagination }),
        'market-screener': () => apiInstance.pmMarketScreener({ orderBy, sortBy, query, status, tags, minLiquidity, maxLiquidity, minUniqueTraders24h, maxUniqueTraders24h, minVolume24hr, maxVolume24hr, negRisk, minOpenInterest, maxOpenInterest, endDateBefore, endDateAfter, minPrice, maxPrice, pagination }),
        'event-screener': () => apiInstance.pmEventScreener({ orderBy, sortBy, query, status, tags, minLiquidity, maxLiquidity, minUniqueTraders24h, maxUniqueTraders24h, minVolume24hr, maxVolume24hr, negRisk, minOpenInterest, maxOpenInterest, endDateBefore, endDateAfter, pagination }),
        'pnl-by-market': () => apiInstance.pmPnlByMarket({ marketId, orderBy, pagination }),
        'pnl-by-address': () => apiInstance.pmPnlByAddress({ address, orderBy, pagination }),
        'position-detail': () => apiInstance.pmPositionDetail({ marketId, pagination }),
        'categories': () => apiInstance.pmCategories({ pagination }),
        'address-summary': () => apiInstance.pmAddressSummary({ address, pagination }),
        'help': () => ({
          commands: ['ohlcv', 'orderbook', 'top-holders', 'trades-by-market', 'trades-by-address', 'market-screener', 'event-screener', 'pnl-by-market', 'pnl-by-address', 'position-detail', 'categories', 'address-summary'],
          description: 'Polymarket prediction market analytics',
          example: 'nansen research pm market-screener --sort-by volume_24hr --limit 20'
        })
      };

      if (!handlers[subcommand]) {
        throw new NansenError(`Unknown subcommand: ${subcommand}. Available: ${Object.keys(handlers).filter(k => k !== 'help').join(', ')}`, ErrorCode.UNKNOWN);
      }

      return handlers[subcommand]();
    }
  };

  // 'research' delegates to the category handlers defined above
  const RESEARCH_CATEGORIES = new Set(['smart-money', 'profiler', 'token', 'search', 'perp', 'portfolio', 'points', 'prediction-market']);

  // The analytics-only perp handler, captured before the trading wrapper below
  // replaces cmds['perp']. Both the wrapper and the research dispatch route to
  // it, so it has to be taken exactly once, here.
  const perpAnalytics = cmds['perp'];

  const researchSub = buildResearchCommands(deps).research;

  cmds['research'] = async (args, apiInstance, flags, options) => {
    const rawCategory = args[0];
    if (!rawCategory || rawCategory === 'help') {
      return {
        categories: [...RESEARCH_CATEGORIES],
        subcommands: [...RESEARCH_SUBCOMMANDS],
        historical: [...RESEARCH_HISTORICAL_SUBCOMMANDS],
        aliases: RESEARCH_CATEGORY_ALIASES,
        description: 'Research and analytics commands',
        example: 'nansen research smart-money netflow --chain solana'
      };
    }
    if (RESEARCH_SUBCOMMANDS.has(rawCategory)) {
      return researchSub(args, apiInstance, flags, options);
    }
    const category = RESEARCH_CATEGORY_ALIASES[rawCategory] || rawCategory;
    if (!RESEARCH_CATEGORIES.has(category)) {
      throw new NansenError(`Unknown research category: ${rawCategory}. Available: ${[...RESEARCH_CATEGORIES, ...RESEARCH_SUBCOMMANDS].join(', ')}`, ErrorCode.UNKNOWN);
    }
    // `research perp` reaches only the analytics half (screener/leaderboard) —
    // the trading subcommands live at the top level. Use the captured handler
    // for every subcommand because cmds['perp'] is replaced below by the
    // combined top-level trading dispatcher.
    if (category === 'perp') {
      return perpAnalytics(args.slice(1), apiInstance, flags, options);
    }
    return cmds[category](args.slice(1), apiInstance, flags, options);
  };

  // 'trade' delegates to quote/execute from buildTradingCommands and limit-order from buildLimitOrderCommands
  const executionDeps = { ...deps, promptFn: confirmationPromptFn };
  const tradingCmds = buildTradingCommands(executionDeps);
  const limitOrderCmds = buildLimitOrderCommands(deps);
  cmds['trade'] = async (args, apiInstance, flags, options) => {
    const sub = args[0];
    if (!sub || sub === 'help') {
      log(TRADE_USAGE);
      return;
    }
    if (sub === 'limit-order') {
      const loSub = args[1];
      if (!loSub || loSub === 'help') {
        log(`nansen trade limit-order — Limit order commands (Solana only)

SUBCOMMANDS:
  create    Place a new limit order
  list      List your limit orders
  cancel    Cancel an open order
  update    Update trigger price or slippage

USAGE:
  nansen trade limit-order create --from <token> --to <token> --amount <units> --trigger-mint <token> --trigger-condition <above|below> --trigger-price <usd>
  nansen trade limit-order list [--state <active|past>]
  nansen trade limit-order cancel --order <orderId>
  nansen trade limit-order update --order <orderId> --trigger-price <usd>`);
        return;
      }
      if (!limitOrderCmds[loSub]) {
        throw new NansenError(`Unknown limit-order subcommand: ${loSub}. Available: create, list, cancel, update`, ErrorCode.UNKNOWN);
      }
      return limitOrderCmds[loSub](args.slice(2), apiInstance, flags, options);
    }
    if (!tradingCmds[sub]) {
      throw new NansenError(`Unknown trade subcommand: ${sub}. Available: quote, execute, bridge-status, limit-order`, ErrorCode.UNKNOWN);
    }
    return tradingCmds[sub](args.slice(1), apiInstance, flags, options);
  };

  // 'bridge' delegates to quote/execute/status from buildBridgeCommands
  const bridgeCmds = buildBridgeCommands(executionDeps);
  cmds['bridge'] = async (args, apiInstance, flags, options) => {
    const sub = args[0];
    if (!sub || sub === 'help') {
      log(`nansen bridge — Hyperliquid bridge commands (EVM <-> Hyperliquid via Relay)

SUBCOMMANDS:
  quote     Get a bridge quote
  execute   Execute a bridge quote (sign + broadcast)
  status    Check bridge transaction status

USAGE:
  nansen bridge quote --from-chain base --to-chain hyperliquid --from-token USDC --amount 1000000
  nansen bridge execute --quote <quoteId> [--dry-run] [--yes]
  nansen bridge status --request-id <id>

BEFORE BROADCASTING (execute only):
  --dry-run   Validate and print what would be signed, then stop. Exits 0.
  --yes, -y   Skip the confirmation prompt (same as NANSEN_YES=1). The prompt only
              appears when stdin is a terminal; declining exits 1, signing nothing.

SUPPORTED ROUTES:
  ${formatBridgeRoutes()}`);
      return;
    }
    if (!bridgeCmds[sub]) {
      throw new NansenError(`Unknown bridge subcommand: ${sub}. Available: quote, execute, status`, ErrorCode.UNKNOWN);
    }
    return bridgeCmds[sub](args.slice(1), apiInstance, flags, options);
  };

  // 'perp' delegates to buildPerpCommands. The trading subcommands are added on
  // top of the pre-existing perp analytics command, so capture that handler and
  // keep screener/leaderboard reachable instead of shadowing them — both
  // `nansen perp screener` and `nansen research perp screener` route through here.
  const perpCmds = buildPerpCommands(deps);
  const PERP_ANALYTICS_SUBCOMMANDS = new Set(['screener', 'leaderboard']);
  cmds['perp'] = async (args, apiInstance, flags, options) => {
    const sub = args[0];
    if (!sub || sub === 'help') {
      log(`nansen perp — Hyperliquid perpetual trading

SUBCOMMANDS:
  order       Place a perp order (market/limit with optional TP/SL)
  cancel      Cancel an open order
  close       Close a position (reduce-only market order)
  leverage    Set leverage and margin mode
  transfer    Move USDC between Spot and Perps balances
  approve-builder-fee  Authorize the Nansen builder fee (one-time; auto-fired on first trade)
  positions   View open positions
  orders      View open orders
  account     View account state (balance, equity, margin, spot)
  meta        View available assets
  screener    Perp market screener (analytics)
  leaderboard Perp trader leaderboard (analytics)

USAGE:
  nansen perp order --coin BTC --side buy --size 0.001 --price 50000 --type limit
  nansen perp cancel --coin BTC --oid 12345
  nansen perp close --coin BTC --size 0.001 --price 100000 --side sell
  nansen perp leverage --coin BTC --leverage 10 --margin-type cross
  nansen perp transfer --direction spot-to-perp --amount 25
  nansen perp approve-builder-fee
  nansen perp positions
  nansen perp account`);
      return;
    }
    if (!perpCmds[sub]) {
      if (PERP_ANALYTICS_SUBCOMMANDS.has(sub)) {
        return perpAnalytics(args, apiInstance, flags, options);
      }
      throw new NansenError(`Unknown perp subcommand: ${sub}. Available: order, cancel, close, leverage, transfer, approve-builder-fee, positions, orders, account, meta, screener, leaderboard`, ErrorCode.UNKNOWN);
    }
    return perpCmds[sub](args.slice(1), apiInstance, flags, options);
  };

  return cmds;
}

// Categories that moved under 'research'
export const DEPRECATED_TO_RESEARCH = new Set(['smart-money', 'profiler', 'token', 'search', 'portfolio']);
// Subcommands that moved under 'trade'
export const DEPRECATED_TO_TRADE = new Set(['quote', 'execute']);

// Command aliases: top-level shortcuts that resolve before routing
export const COMMAND_ALIASES = {
  'tgm': 'token',           // Token God Mode
  'sm': 'smart-money',      // Smart Money
  'prof': 'profiler',       // Profiler
  'port': 'portfolio',      // Portfolio
  'pm': 'prediction-market' // Prediction Market
};

// Aliases used inside the 'research' namespace
export const RESEARCH_CATEGORY_ALIASES = {
  'tgm': 'token',
  'sm': 'smart-money',
  'prof': 'profiler',
  'port': 'portfolio',
  'pm': 'prediction-market'
};

// Generate help text for a specific subcommand using SCHEMA
export function generateSubcommandHelp(command, subcommand, prefix = null) {
  // `perp` is both a top-level trading command and a research category, and
  // the two have different subcommands. Look in both places and use whichever
  // actually holds this subcommand (top-level wins when both do) instead of
  // stopping at the first schema whose *name* matches — that made
  // `research perp screener --help` fall back to listing the category's
  // subcommands, i.e. telling the caller to run the command they just ran.
  const topSchema = SCHEMA.commands[command];
  const researchSchema = SCHEMA.commands.research.subcommands[command];
  const fromResearch = !topSchema?.subcommands?.[subcommand] && Boolean(researchSchema?.subcommands?.[subcommand]);
  const cmdSchema = fromResearch ? researchSchema : topSchema || researchSchema;
  if (!cmdSchema) return null;

  const subSchema = cmdSchema.subcommands?.[subcommand];
  if (!subSchema) return null;

  const lines = [];
  lines.push(`${command} ${subcommand} — ${subSchema.description || 'No description'}`);

  if (subSchema.options) {
    const params = Object.entries(subSchema.options).map(([name, opt]) => {
      const parts = [`--${name}`];
      if (opt.required) parts[0] += '*';
      if (opt.default !== undefined) parts.push(`(${opt.default})`);
      if (opt.enum) parts.push(`[${opt.enum.join('|')}]`);
      return parts.join(' ');
    });
    lines.push(`Params (* required): ${params.join(', ')}`);
  }

  if (subSchema.endpoint) {
    const cost = getCostForEndpoint(subSchema.endpoint);
    if (cost) lines.push(`Cost: ${cost.free} credit${cost.free === 1 ? '' : 's'} (Free tier) / ${cost.pro} credit${cost.pro === 1 ? '' : 's'} (Pro tier)`);
  }

  if (subSchema.returns?.length) {
    lines.push(`Returns: ${subSchema.returns.join(', ')}`);
  }

  const exampleValues = { address: '0x...', token: '0x...', query: '"term"', symbol: 'BTC', date: '2024-01-01' };
  const chain = subSchema.options?.chain?.default || 'solana';
  const cmdPrefix = prefix || (fromResearch || DEPRECATED_TO_RESEARCH.has(command) ? `research ${command}` : command);
  let example = subSchema.examples?.[0] || `nansen ${cmdPrefix} ${subcommand}`;
  if (!subSchema.examples?.length && subSchema.options) {
    for (const [name, opt] of Object.entries(subSchema.options)) {
      if (opt.required) example += ` --${name} ${exampleValues[name] || '<val>'}`;
    }
  }
  if (!subSchema.examples?.length && subSchema.options?.chain && !subSchema.options.chain.required) {
    example += ` --chain ${chain}`;
  }
  lines.push(`Example: ${example}`);

  return lines.join('\n');
}

function emitResponseMetadata(api, errorOutput) {
  if (!api) return;
  const responseMeta = api.paginatedResponseMeta || api.lastResponseMeta;
  const lowCredits = creditWarning(responseMeta);
  if (lowCredits) errorOutput(lowCredits);
  for (const notice of noticeWarnings(responseMeta)) errorOutput(notice);

  // An aggregate belongs to the primary paginated endpoint even if a composite
  // handler made auxiliary requests afterward and changed lastEndpoint.
  const endpoint = api.paginatedResponseMeta ? api.paginatedEndpoint : api.lastEndpoint;
  const charged = creditsCharged(responseMeta, endpoint);
  if (charged?.source === 'header') {
    const paginationMeta = responseMeta?.pagination;
    let scope = 'this call';
    if (paginationMeta?.cachedPages > 0 && paginationMeta.livePages > 0) {
      scope = `${paginationMeta.livePages} live of ${paginationMeta.pagesFetched} page requests`;
    } else if (paginationMeta?.livePages > 1) scope = `${paginationMeta.livePages} page requests`;
    else if (paginationMeta?.livePages === 1) scope = '1 page request';
    else if (paginationMeta?.livePages === 0) scope = 'cached traversal';
    errorOutput(`Credits: ${charged.cost} (${scope})`);
  } else if (charged?.source === 'estimate') {
    errorOutput(`Credits: ~${charged.estimate.free} free / ${charged.estimate.pro} pro (estimated)`);
  }
}

// Run CLI with given args (returns result, allows custom output/exit handlers)
export async function runCLI(rawArgs, deps = {}) {
  const {
    output = console.log,
    errorOutput = console.error,
    exit = process.exit,
    NansenAPIClass = NansenAPI,
    commandOverrides = {},
    // Output TTY controls human-vs-structured error rendering. Keep the
    // existing `isTTY` seam for callers/tests that inject both terminal states.
    isTTY = process.stdout.isTTY,
    env = process.env,
  } = deps;

  // Command-layer interactivity is intentionally governed by stdin. Besides
  // trade/bridge confirmation, buildCommands' existing `login --human` prompt
  // consumes this same signal; stdout may be redirected while a person still
  // answers either prompt on stdin. The separate `isTTY` destructured above
  // remains the stdout signal for human-vs-structured error rendering. Callers
  // can split the signals with `isInputTTY`; legacy `isTTY` injection still
  // drives both for compatibility.
  const isInputTTY = deps.isInputTTY ?? (deps.isTTY ?? process.stdin.isTTY);

  // Pass the CLI-owned terminal seams into command modules. Keeping these out
  // of core means direct/library callers are non-interactive unless they
  // explicitly provide a prompt.
  const inputInteractiveDeps = {
    ...deps,
    isTTY: isInputTTY,
    stdoutTTY: isTTY,
    stdinTTY: isInputTTY,
    promptFn: deps.promptFn ?? prompt,
    confirmationPromptFn: deps.confirmationPromptFn ?? promptForConfirmation,
    confirmationLog: deps.confirmationLog ?? errorOutput,
  };
  const topLevelTradingDeps = {
    ...inputInteractiveDeps,
    promptFn: inputInteractiveDeps.confirmationPromptFn,
  };

  let parsed;
  let api;
  let responseMetadataEmitted = false;
  const emitResponseMetadataOnce = () => {
    if (responseMetadataEmitted) return;
    responseMetadataEmitted = true;
    emitResponseMetadata(api, errorOutput);
  };
  try {
    parsed = parseArgs(rawArgs);
  } catch (error) {
    const errorData = formatError(error);
    output(formatOutput(errorData).text);
    exit(1);
    return { type: 'error', data: errorData };
  }
  const { _: positional, flags, options } = parsed;

  // Resolve command aliases
  const rawCommand = positional[0] || 'help';
  const command = COMMAND_ALIASES[rawCommand] || rawCommand;
  const subArgs = positional.slice(1);
  const subcommand = subArgs[0];

  // `--debug` turns on the request trace for the rest of the process. Set
  // before anything can make a request, and only when the flag is present so
  // NANSEN_DEBUG=1 still decides on its own when the flag is absent.
  if (flags.debug) setDebugEnabled(true);

  const pretty = flags.pretty || flags.p;
  const table = flags.table || flags.t;
  const stream = flags.stream || flags.s;
  const csv = options.format === 'csv';

  // Commands in this set promise zero network activity. That includes update
  // checks, cost-map refreshes and telemetry, not just their primary work.
  // `cache` belongs here specifically so inspecting or clearing caches cannot
  // recreate update/telemetry state during the same invocation.
  const isMcpUsage = command === 'mcp' && (subcommand !== 'verify' || flags.help || flags.h);
  const isAuthMutation = command === 'login' || command === 'logout';
  const isOfflineCommand = command === 'auth'
    || (command === 'doctor' && flags.offline)
    || isMcpUsage
    || command === 'completion'
    || command === 'cache';
  const trackSucceeded = isOfflineCommand ? async () => {} : isAuthMutation ? metadata => trackAuthCommand({ ...metadata, command }) : trackCommandSucceeded;
  const trackFailed = isOfflineCommand ? async () => {} : isAuthMutation ? metadata => trackAuthCommand({ ...metadata, command, failed: true }) : trackCommandFailed;

  // Update check (read cached result + schedule background refresh)
  const updateNotification = isOfflineCommand ? null : getUpdateNotification(VERSION);
  const upgradeNotice = isOfflineCommand ? null : getUpgradeNotice(VERSION);
  if (!isOfflineCommand && !isAuthMutation) scheduleUpdateCheck();
  const notify = () => {
    if (upgradeNotice) errorOutput(upgradeNotice);
    if (updateNotification) errorOutput(updateNotification);
  };

  // Deprecation note for help output
  const deprecationNote = (cmd) => {
    if (DEPRECATED_TO_RESEARCH.has(cmd)) return `Note: "nansen ${cmd}" is deprecated. Use "nansen research ${cmd}" instead.\n\n`;
    if (DEPRECATED_TO_TRADE.has(cmd)) return `Note: "nansen ${cmd}" is deprecated. Use "nansen trade ${cmd}" instead.\n\n`;
    return '';
  };

  // mcp prints its own output via `log`; runCLI callers inject their stdout
  // sink as `output`, so map it across (an explicit `log` dep still wins).
  // Only execute/login handlers consume the stdin-interactivity seam. Other
  // modules retain their existing deps: notably wallet export interprets
  // `isTTY` as stdout visibility when deciding whether to warn about printing
  // private keys, so substituting the stdin signal there changes its semantics.
  const commands = { ...buildCommands(inputInteractiveDeps), ...buildWalletCommands(deps), ...buildTradingCommands(topLevelTradingDeps), ...buildAlertsCommands(deps), ...buildAgentCommands(deps), ...buildMcpCommands({ ...deps, log: deps.log ?? output }), ...buildCompletionCommands({ ...deps, log: deps.log ?? output }), ...commandOverrides };

  if (flags.version || flags.v) {
    output(VERSION);
    return { type: 'version', data: VERSION };
  }

  if (command === 'help' || flags.help || flags.h) {
    // Help for an offline command still owes the zero-network contract: the
    // cost-map refresh fetches the OpenAPI spec and writes ~/.nansen/cost-map.json.
    if (!isOfflineCommand && !isAuthMutation) await refreshCostMapIfStale();
    // Check for subcommand-specific help: nansen <command> <subcommand> --help
    if (flags.help || flags.h) {
      // Handle 'research <category> <sub> --help' (3-level)
      if (command === 'research' && subcommand) {
        const category = RESEARCH_CATEGORY_ALIASES[subcommand] || subcommand;
        const deepSub = subArgs[1];
        if (deepSub) {
          const subHelp = generateSubcommandHelp(category, deepSub, `research ${subcommand}`);
          if (subHelp) {
            output(subHelp);
            notify();
            return { type: 'subcommand-help', command: category, subcommand: deepSub };
          }
        }
        // List category subcommands: 'nansen research smart-money --help'
        const researchCat = SCHEMA.commands.research.subcommands[category];
        if (researchCat) {
          const catSchema = researchCat;
          const lines = [`research ${category} — ${catSchema.description}`];
          if (catSchema.subcommands) {
            lines.push('Subcommands: ' + Object.keys(catSchema.subcommands).join(', '));
            lines.push(`Use: nansen research ${category} <subcommand> --help`);
          } else if (catSchema.options) {
            // Leaf historical subcommand: render options + example
            const params = Object.entries(catSchema.options).map(([name, opt]) => {
              const parts = [`--${name}`];
              if (opt.required) parts[0] += '*';
              if (opt.default !== undefined) parts.push(`(${opt.default})`);
              return parts.join(' ');
            });
            lines.push(`Params (* required): ${params.join(', ')}`);
            if (catSchema.endpoint) {
              const cost = getCostForEndpoint(catSchema.endpoint);
              if (cost) lines.push(`Cost: ${cost.free} credit${cost.free === 1 ? '' : 's'} (Free tier) / ${cost.pro} credit${cost.pro === 1 ? '' : 's'} (Pro tier)`);
            }
          }
          output(lines.join('\n'));
          notify();
          return { type: 'command-help', command: `research ${category}` };
        }
      }
      // First try subcommand help
      // Skip for 'trade'/'alerts' — their handlers show their own rich usage
      if (command && subcommand && command !== 'trade' && command !== 'alerts' && command !== 'agent') {
        const subHelp = generateSubcommandHelp(command, subcommand);
        if (subHelp) {
          output(deprecationNote(command) + subHelp);
          notify();
          return { type: 'subcommand-help', command, subcommand };
        }
      }
      // Then try command-level help (list subcommands)
      // Skip for 'trade'/'alerts'/'cache' — let the handler show its own usage
      const cmdSchemaLookup = command !== 'trade' && command !== 'alerts' && command !== 'agent' && command !== 'cache' && (SCHEMA.commands[command] || SCHEMA.commands.research.subcommands[command]);
      if (command && cmdSchemaLookup) {
        const cmdSchema = cmdSchemaLookup;
        const lines = [`${command} — ${cmdSchema.description}`];
        if (cmdSchema.subcommands) {
          lines.push('Subcommands: ' + Object.keys(cmdSchema.subcommands).join(', '));
          lines.push(`Use: nansen ${command} <subcommand> --help`);
        }
        if (cmdSchema.options) {
          const params = Object.entries(cmdSchema.options).map(([name, opt]) => {
            const parts = [`--${name}`];
            if (opt.required) parts[0] += '*';
            if (opt.default !== undefined) parts.push(`(default: ${opt.default})`);
            if (opt.description) parts.push(`— ${opt.description}`);
            return parts.join(' ');
          });
          lines.push(`\nOptions (* required):\n  ${params.join('\n  ')}`);
        }
        if (cmdSchema.examples?.length) {
          lines.push(`\nExamples:\n  ${cmdSchema.examples.join('\n  ')}`);
        }
        output(deprecationNote(command) + lines.join('\n'));
        notify();
        return { type: 'command-help', command };
      }
    }
    // Simple commands (logout, schema, cache) — show help instead of executing
    // Prevents destructive commands like logout from running when user just wants help
    if (commands[command]) {
      const simpleHelp = {
        'schema': 'nansen schema [command] [--pretty] — Show JSON schema for all commands (or a specific command)',
        'cache':  CACHE_HELP,
      };
      if (simpleHelp[command]) {
        output(simpleHelp[command]);
        notify();
        return { type: 'command-help', command };
      }
    }
    // The trade group (and the deprecated top-level quote/execute aliases) use
    // handler-based usage rather than schema help. Show it and exit 0, instead of
    // falling through to command execution, which would error on missing required
    // args and exit 1.
    if (command === 'trade' || DEPRECATED_TO_TRADE.has(command)) {
      output(deprecationNote(command) + TRADE_USAGE);
      notify();
      return { type: 'command-help', command };
    }
    // 'help' and unknown commands: full banner + command list
    if (command === 'help' || !commands[command]) {
      output(BANNER + HELP);
      notify();
      return { type: 'help' };
    }
  }

  // ── Telemetry setup ──
  const startTime = Date.now();
  const fullCommand = subcommand ? `${command} ${subcommand}` : command;
  const flagNames = Object.keys(flags).filter(k => flags[k]).map(k => `--${k}`);
  const optionNames = Object.keys(options).map(k => `--${k}`);
  const usedFlags = [...flagNames, ...optionNames];
  const chain = options.chain || null;

  if (!commands[command]) {
    // A command token containing whitespace almost always means a multi-word
    // invocation was passed as a single argument — e.g. `nansen "trade --help"`,
    // or an unquoted shell variable under zsh (which, unlike bash, does not
    // word-split `$var`). Point the user straight at the cause instead of a bare
    // "Unknown command" that reads like a spurious failure.
    const errorData = {
      error: /\s/.test(command)
        ? `Unknown command: "${command}". This looks like multiple words passed as one argument — check your shell quoting (use \`nansen trade --help\`, not \`nansen "trade --help"\`).`
        : `Unknown command: ${command}`,
      available: Object.keys(commands)
    };
    const formatted = formatOutput(errorData, { pretty, table });
    output(formatted.text);
    await trackFailed({ command: fullCommand, duration_ms: Date.now() - startTime, error_code: 'UNKNOWN_COMMAND', flags: usedFlags, chain });
    exit(1);
    return { type: 'error', data: errorData };
  }

  try {
    // Configure retry options
    const maxRetries = parseNonNegativeSafeIntegerOption('retries', options, flags, 3);
    const retryOptions = flags['no-retry']
      ? { maxRetries: 0 }
      : { maxRetries };

    // Configure cache options
    const cacheTtl = parseNonNegativeSafeIntegerOption('cache-ttl', options, flags, 300);
    const cacheOptions = {
      // NANSEN_NO_CACHE is the flagless form of --no-cache, for callers that
      // cannot edit the command line (a wrapper script or agent harness that
      // always passes --cache). Both are a veto, never an enable.
      enabled: flags['cache'] && !flags['no-cache'] && env.NANSEN_NO_CACHE !== '1',
      ttl: cacheTtl
    };

    const defaultHeaders = {};
    if (options['x402-payment-signature']) {
      defaultHeaders['Payment-Signature'] = options['x402-payment-signature'];
    }
    api = new NansenAPIClass(undefined, undefined, { retry: retryOptions, cache: cacheOptions, defaultHeaders, authState: inputInteractiveDeps.authState });

    // --all aliases --paginate; wrapping api.request gives every list handler
    // the same max-pages bound while leaving non-list requests untouched.
    if (flags.paginate || flags.all) {
      const maxPages = parsePositiveSafeIntegerOption(
        'max-pages', options, flags, DEFAULT_MAX_PAGES, { max: MAX_PAGES_LIMIT },
      );
      enableAutoPagination(api, { maxPages });
    }

    // Deprecated top-level aliases otherwise run silently (the notice was only
    // shown in --help). Warn on stderr so it doesn't pollute parsed stdout.
    if (DEPRECATED_TO_TRADE.has(command)) {
      process.stderr.write(`Note: "nansen ${command}" is deprecated. Use "nansen trade ${command}" instead.\n`);
    } else if (DEPRECATED_TO_RESEARCH.has(command)) {
      process.stderr.write(`Note: "nansen ${command}" is deprecated. Use "nansen research ${command}" instead.\n`);
    }

    let result = await commands[command](subArgs, api, flags, options);

    // The cache marker is hung off the payload's `_meta` by getCachedResponse(),
    // never as a top-level `fromCache`. Capture it here, before `--fields`
    // filtering below drops `_meta` along with every other unrequested key —
    // read any later and a cache hit with `--fields` reports as a live call.
    //
    // `_meta` alone isn't enough either: handlers are free to rebuild their
    // result and some do (`alerts list` filters the array into a fresh one),
    // which drops the marker before we get here. `api.servedFromCache` is set
    // on the instance next to the cache-hit early return in request(), so it
    // survives that reshaping. Compared against `true` so a stubbed API whose
    // every property is a mock function doesn't read as a hit.
    const fromCache = !!result?._meta?.fromCache || api.servedFromCache === true;

    // Credit balance warning, from the headers on the call just made. Goes to
    // stderr so it never contaminates the JSON on stdout that agents parse.
    // Placed before every return path below so it fires for operational
    // commands too, which print their own output and return undefined.
    emitResponseMetadataOnce();

    // Commands that handle their own output return undefined
    if (result === undefined) {
      await trackSucceeded({ command: fullCommand, duration_ms: Date.now() - startTime, flags: usedFlags, chain });
      return { type: 'no-output', command };
    }

    // Schema returns data directly (not wrapped in { success, data })
    if (command === 'schema') {
      const formatted = formatOutput(result, { pretty, table: false });
      output(formatted.text);
      await trackSucceeded({ command: fullCommand, duration_ms: Date.now() - startTime, flags: usedFlags, chain });
      return { type: 'schema', data: result };
    }

    // Apply field filtering if --fields is specified
    const fields = parseFields(options.fields);
    if (fields) {
      result = filterFields(result, fields);
    }

    // Alerts list with --table uses custom table format
    if (command === 'alerts' && subcommand === 'list' && table) {
      output(formatAlertsTable(result));
      await trackSucceeded({ command: fullCommand, duration_ms: Date.now() - startTime, from_cache: fromCache, flags: usedFlags, chain });
      return { type: 'success', data: result };
    }

    // Output in requested format
    if (stream) {
      // Stream mode: output each record as a JSON line (NDJSON)
      const streamOutput = formatStream(result);
      if (streamOutput) {
        output(streamOutput);
      }
      await trackSucceeded({ command: fullCommand, duration_ms: Date.now() - startTime, from_cache: fromCache, flags: usedFlags, chain });
      return { type: 'stream', data: result };
    }

    const successData = { success: true, data: result };
    const formatted = formatOutput(successData, { pretty, table, csv });
    output(formatted.text);
    await trackSucceeded({ command: fullCommand, duration_ms: Date.now() - startTime, from_cache: fromCache, flags: usedFlags, chain });
    return { type: csv ? 'csv' : 'success', data: result };
  } catch (error) {
    // A failed later page can still have incurred charges on earlier pages.
    // Emit the aggregate on stderr before serializing the unchanged error.
    emitResponseMetadataOnce();
    // Unified error envelope across all command families (perp/bridge/trade):
    // every failure serializes through formatError as
    // {success:false, error, code, status, details}. A CommandError's structured
    // data (e.g. PASSWORD_REQUIRED resolution steps) is preserved under `details`,
    // so agents get one consistent shape to branch on regardless of command.
    const errorData = formatError(error);
    if (error.reported) {
      // The command already printed its full human-readable failure output;
      // emitting the envelope too would produce two output shapes on stdout.
    } else if (isUsageError(errorData, { pretty, table, csv, stream, isTTY })) {
      output(errorData.error);
    } else {
      const formatted = formatOutput(errorData, { pretty, table, csv });
      output(formatted.text);
    }
    await trackFailed({
      command: fullCommand,
      duration_ms: Date.now() - startTime,
      error_code: error.code || 'UNKNOWN',
      status: error.status || null,
      flags: usedFlags,
      chain,
    });
    exit(1);
    return { type: 'error', data: errorData };
  }
}
