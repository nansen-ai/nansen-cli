/**
 * Flag names for telemetry events.
 *
 * The argument parser turns a dash-leading value given as a separate argument
 * (`--webhook-secret -abc123`) into a flag named after the value. Telemetry
 * therefore sends only option names the CLI defines for the command being run
 * and replaces every other name with a fixed placeholder, so no user-supplied
 * text can reach analytics through the `flags` list.
 *
 * The same rule covers the `chain` and `error_code` properties: telemetry sends
 * a chain name or an error code only when it is one the CLI defines, and a
 * fixed placeholder otherwise.
 */

import { resolveResearchCommand, canonicalChain } from './input-validation.js';
import { EVM_CHAINS } from './chain-ids.js';
import { ERROR_CODES, FIELD_ERROR_CODES } from './error-codes.js';

export const UNKNOWN_FLAG = '--<unknown>';
export const UNKNOWN_CHAIN = 'UNKNOWN_CHAIN';
export const UNKNOWN_ERROR_CODE = 'UNKNOWN';

// Single-letter switches the CLI reads directly (help, version, pretty, table,
// stream, yes). They are not listed as options in the schema.
const SHORT_SWITCHES = ['h', 'v', 'p', 't', 's', 'y'];

// Deprecated top-level commands that run a `trade` subcommand.
const TRADE_SHORTCUTS = new Set(['quote', 'execute', 'bridge-status']);

function addOptionNames(known, options) {
  if (!options || typeof options !== 'object') return;
  for (const [name, spec] of Object.entries(options)) {
    known.add(name);
    if (Array.isArray(spec?.aliases)) {
      for (const alias of spec.aliases) known.add(alias);
    }
  }
}

/** Schema entry for the command line, or null when none matches. */
function schemaLeaf(schema, command, subArgs) {
  try {
    const research = resolveResearchCommand(schema, command, subArgs);
    if (research) return research.leaf;
  } catch {
    // Unknown research category or subcommand: fall through to the plain walk.
  }
  let node = null;
  let path = subArgs;
  if (Object.hasOwn(schema.commands, command)) {
    node = schema.commands[command];
  } else if (TRADE_SHORTCUTS.has(command) && schema.commands.trade?.subcommands) {
    node = schema.commands.trade;
    path = [command, ...subArgs];
  }
  for (const arg of path) {
    const subs = node?.subcommands;
    if (!subs || typeof arg !== 'string' || !Object.hasOwn(subs, arg)) break;
    node = subs[arg];
  }
  return node;
}

/**
 * Option names (without dashes) that telemetry may report for this command:
 * the matched schema entry's options, the global options and the CLI's own
 * valueless switches.
 */
export function knownTelemetryFlags(schema, command, subArgs = [], switches = []) {
  const known = new Set([...switches, ...SHORT_SWITCHES]);
  addOptionNames(known, schema.globalOptions);
  addOptionNames(known, schemaLeaf(schema, command, subArgs)?.options);
  return known;
}

/**
 * Map `--name` entries to themselves when the CLI defines them for this
 * command, and to UNKNOWN_FLAG otherwise.
 */
export function telemetryFlagNames({ schema, command, subArgs = [], switches = [] }, names) {
  const known = knownTelemetryFlags(schema, command, subArgs, switches);
  return names.map(name => (known.has(String(name).replace(/^--/, '')) ? name : UNKNOWN_FLAG));
}

const chainSets = new WeakMap();

/**
 * Chain names telemetry may report: the schema's chain list, every research
 * endpoint's supported chains (which include `all`), every `--chain` enum
 * (trade's `solana`/`base`, wallet send's `evm`) and the EVM chains.
 */
export function knownTelemetryChains(schema) {
  let known = chainSets.get(schema);
  if (known) return known;
  known = new Set([...(schema.chains || []), ...EVM_CHAINS]);
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node.supportedChains)) node.supportedChains.forEach(chain => known.add(chain));
    if (Array.isArray(node.options?.chain?.enum)) node.options.chain.enum.forEach(chain => known.add(chain));
    for (const child of Object.values(node.subcommands || {})) walk(child);
  })({ subcommands: schema.commands });
  chainSets.set(schema, known);
  return known;
}

/**
 * The `--chain` value as telemetry reports it: null when none was given, the
 * canonical chain name (`BSC` -> `bnb`) when the CLI knows it, and
 * UNKNOWN_CHAIN for anything else, so typed text never reaches analytics.
 */
export function telemetryChain(schema, value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return UNKNOWN_CHAIN;
  const chain = canonicalChain(value);
  return knownTelemetryChains(schema).has(chain) ? chain : UNKNOWN_CHAIN;
}

// The snake_case codes `nansen feedback` reports: the REST API's own codes
// (they pass through statusToErrorCode in api.js when the CLI has no mapping;
// src/__tests__/fixtures/feedback-v1.json is their contract) and the codes
// src/commands/feedback.js and src/feedback-journal.js set themselves.
export const API_TELEMETRY_ERROR_CODES = new Set([
  'conflict', 'forbidden', 'idempotency_key_reused', 'insufficient_credits', 'not_found',
  'rate_limit_exceeded', 'request_rate_limited', 'upstream_unavailable',
  'feedback_admissions_paused', 'feedback_already_confirmed', 'feedback_blocked',
  'feedback_busy', 'feedback_erased', 'feedback_identity_mismatch', 'feedback_identity_unverified',
  'feedback_not_enabled', 'feedback_pending', 'feedback_permission_required',
  'feedback_recovery_unavailable', 'feedback_report_changed', 'feedback_storage_unavailable',
  'feedback_unavailable', 'feedback_weekly_quota_exhausted', 'submission_outcome_unknown',
]);

/**
 * The error code as telemetry reports it: a code registered in
 * src/error-codes.js (including the field-error codes) or one of the API codes
 * above, and UNKNOWN for anything else (system codes such as ENOENT, codes set
 * by dependencies, unrecognized API codes, non-string values).
 */
export function telemetryErrorCode(code) {
  if (typeof code !== 'string') return UNKNOWN_ERROR_CODE;
  const known = Object.hasOwn(ERROR_CODES, code)
    || Object.hasOwn(FIELD_ERROR_CODES, code)
    || API_TELEMETRY_ERROR_CODES.has(code);
  return known ? code : UNKNOWN_ERROR_CODE;
}
