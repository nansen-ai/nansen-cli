/**
 * Acknowledgement gate shared by the commands that move funds on-chain
 * (`trade execute`, `bridge execute`).
 *
 * Two independent switches, both resolved in the command layer:
 *   --dry-run   run the validation the command normally runs, print the plan,
 *               and stop before anything is signed or broadcast (exit 0).
 *   --yes / -y  skip the confirmation. `NANSEN_YES=1` is the environment
 *               equivalent, for callers that cannot add a flag.
 *
 * The confirmation is only ever shown when stdin is an interactive terminal.
 * Agents, CI jobs and pipes (stdin not a TTY) keep today's behaviour exactly:
 * the command proceeds without asking, so no automated workflow can hang on a
 * question nobody is there to answer. `--yes` is still accepted there and is
 * simply a no-op. Declining the prompt exits 1 with nothing signed.
 */

import { CommandError } from './api.js';

// Accepted spellings for NANSEN_YES. Anything else (unset, "0", "false", an
// empty string) leaves the confirmation in place.
const TRUTHY_ENV_VALUES = new Set(['1', 'true', 'yes', 'on']);

export function isYesEnvSet(env = process.env) {
  const raw = env?.NANSEN_YES;
  return typeof raw === 'string' && TRUTHY_ENV_VALUES.has(raw.trim().toLowerCase());
}

/**
 * Read the guard's inputs off the parsed flags. `-y` arrives as `flags.y`
 * because single-dash tokens are always parsed as valueless flags.
 */
export function resolveExecuteGuard(flags = {}, { env = process.env, isTTY = false } = {}) {
  return {
    dryRun: Boolean(flags['dry-run']),
    assumeYes: Boolean(flags.yes || flags.y) || isYesEnvSet(env),
    isTTY: Boolean(isTTY),
  };
}

/**
 * Render `[label, value]` pairs as an aligned block. Pairs whose value is
 * null/undefined/'' are dropped, so callers can list optional fields inline.
 */
export function formatPlan(title, rows = [], notes = []) {
  const shown = rows.filter(([, value]) => value !== undefined && value !== null && value !== '');
  const width = shown.reduce((max, [label]) => Math.max(max, label.length + 1), 0);
  return [
    `\n  ${title}`,
    ...shown.map(([label, value]) => `    ${`${label}:`.padEnd(width)}  ${value}`),
    ...notes.map(note => `    ${note}`),
  ].join('\n');
}

function isAffirmative(answer) {
  return /^y(es)?$/i.test(String(answer ?? '').trim());
}

/**
 * Print the plan and decide whether the caller may proceed to sign/broadcast.
 *
 * Returns true to continue, false when a dry run has finished (the caller
 * returns without signing). Throws CONFIRMATION_DECLINED when an interactive
 * user answers anything but yes.
 */
export async function guardExecution({
  plan,
  dryRun = false,
  assumeYes = false,
  isTTY = false,
  promptFn,
  log = () => {},
  question = 'Broadcast this transaction? [y/N] ',
}) {
  if (dryRun) {
    log(plan);
    log('\n  DRY RUN — nothing was broadcast. No transaction was signed and the quote was not consumed.');
    log('  Re-run without --dry-run to sign and broadcast it.\n');
    return false;
  }

  // Non-interactive stdin (agents, CI, pipes): unchanged, deterministic, never
  // blocked on a prompt. --yes is accepted here and does nothing.
  if (!isTTY || assumeYes) return true;

  if (typeof promptFn !== 'function') {
    throw new CommandError(
      'Cannot request confirmation because no interactive prompt is available. Pass --yes to proceed or --dry-run to preview.',
      'CONFIRMATION_UNAVAILABLE',
    );
  }

  log(plan);
  const answer = await promptFn(question);
  if (!isAffirmative(answer)) {
    throw new CommandError(
      'Aborted at the confirmation prompt — nothing was signed or broadcast. '
        + 'Pass --yes (or set NANSEN_YES=1) to skip this confirmation, or --dry-run to preview without broadcasting.',
      'CONFIRMATION_DECLINED',
    );
  }
  return true;
}
