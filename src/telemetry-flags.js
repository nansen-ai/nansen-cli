/**
 * Flag names for telemetry events.
 *
 * The argument parser turns a dash-leading value given as a separate argument
 * (`--webhook-secret -abc123`) into a flag named after the value. Telemetry
 * therefore sends only option names the CLI defines for the command being run
 * and replaces every other name with a fixed placeholder, so no user-supplied
 * text can reach analytics through the `flags` list.
 */

import { resolveResearchCommand } from './input-validation.js';

export const UNKNOWN_FLAG = '--<unknown>';

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
