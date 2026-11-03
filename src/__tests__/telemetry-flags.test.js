/**
 * Telemetry reports only option names the CLI defines. A value that starts
 * with `-` and is given as a separate argument is parsed as a flag named after
 * the value, so it must never reach the `flags` list of a telemetry event.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const trackSucceeded = vi.fn();
const trackFailed = vi.fn();
const trackAuth = vi.fn();

vi.mock('../telemetry.js', async (importOriginal) => ({
  ...(await importOriginal()),
  trackCommandSucceeded: trackSucceeded,
  trackCommandFailed: trackFailed,
  trackAuthCommand: trackAuth,
  trackPerpOrderCompleted: vi.fn(),
  getAnonymousId: () => 'test-anon-id',
  getSessionId: () => 'test-session-id',
}));

const { runCLI, SCHEMA, VALUELESS_FLAGS } = await import('../cli.js');
const { telemetryFlagNames, UNKNOWN_FLAG } = await import('../telemetry-flags.js');

function MockAPI() {
  return new Proxy({}, {
    get: (_target, prop) => {
      if (typeof prop === 'string' && prop !== 'then') {
        return vi.fn().mockResolvedValue({ data: [] });
      }
    },
  });
}

function deps(overrides = {}) {
  return {
    output: () => {},
    errorOutput: () => {},
    log: () => {},
    exit: () => {},
    NansenAPIClass: MockAPI,
    ...overrides,
  };
}

function trackedFlags() {
  const calls = [...trackSucceeded.mock.calls, ...trackFailed.mock.calls];
  expect(calls).toHaveLength(1);
  return calls[0][0].flags;
}

describe('telemetry flag names', () => {
  beforeEach(() => {
    trackSucceeded.mockClear();
    trackFailed.mockClear();
    trackAuth.mockClear();
  });

  it('does not send a dash-leading option value on a failed run', async () => {
    await runCLI(
      ['alerts', 'create', '--name', 'x', '--type', 'sm-token-flows', '--webhook-secret', '-secretvalue'],
      deps(),
    );
    expect(trackFailed).toHaveBeenCalledTimes(1);
    const flags = trackedFlags();
    expect(flags.join(' ')).not.toContain('secretvalue');
    expect(flags).toContain('--webhook-secret');
    expect(flags).toContain('--name');
    expect(flags).toContain('--type');
    expect(flags).toContain(UNKNOWN_FLAG);
  });

  it('does not send a dash-leading option value on a successful run', async () => {
    await runCLI(['changelog', '--since', '-secretvalue'], deps());
    expect(trackSucceeded).toHaveBeenCalledTimes(1);
    const flags = trackedFlags();
    expect(flags.join(' ')).not.toContain('secretvalue');
    expect(flags).toContain(UNKNOWN_FLAG);
  });

  it('replaces an unknown flag name on a research command', async () => {
    await runCLI(['research', 'token', 'screener', '--chain', 'ethereum', '--not-an-option-xyz', 'v'], deps());
    const flags = trackedFlags();
    expect(flags.join(' ')).not.toContain('not-an-option-xyz');
    expect(flags).toContain('--chain');
    expect(flags).toContain(UNKNOWN_FLAG);
  });

  it('reports known command, global and switch flags unchanged', async () => {
    await runCLI(['research', 'token', 'screener', '--chain', 'ethereum', '--timeframe', '24h', '--limit', '5', '--pretty'], deps());
    expect(trackSucceeded).toHaveBeenCalledTimes(1);
    expect(trackedFlags()).toEqual(['--pretty', '--chain', '--timeframe', '--limit']);
  });

  it('resolves aliases, deprecated top-level commands and option aliases', () => {
    const run = (command, subArgs, names) =>
      telemetryFlagNames({ schema: SCHEMA, command, subArgs, switches: VALUELESS_FLAGS }, names);
    // Category alias and deprecated top-level form of `research token holders`.
    expect(run('research', ['tgm', 'holders'], ['--token-address', '--smart-money'])).toEqual(['--token-address', '--smart-money']);
    expect(run('token', ['holders'], ['--token', '--abc'])).toEqual(['--token', UNKNOWN_FLAG]);
    // `perp screener` runs a research command; `perp order` is a trading command.
    expect(run('perp', ['screener'], ['--days'])).toEqual(['--days']);
    expect(run('perp', ['order'], ['--coin', '--days'])).toEqual(['--coin', UNKNOWN_FLAG]);
    // Deprecated `quote` runs `trade quote`; nested `trade limit-order list`.
    expect(run('quote', [], ['--slippage'])).toEqual(['--slippage']);
    expect(run('trade', ['limit-order', 'list'], ['--state', '--y', '--yes'])).toEqual(['--state', '--y', '--yes']);
    // Help and short switches stay; free text in a positional is never a lookup hit.
    expect(run('agent', ['what is --pretty'], ['--help', '--h', '--expert', '--secret'])).toEqual(['--help', '--h', '--expert', UNKNOWN_FLAG]);
    // Unknown command or subcommand: only global options and switches are known.
    expect(run('nope', [], ['--pretty', '--chain'])).toEqual(['--pretty', UNKNOWN_FLAG]);
    expect(run('research', ['nope'], ['--fields', '--secret'])).toEqual(['--fields', UNKNOWN_FLAG]);
    // Prototype keys are not schema entries.
    expect(run('research', ['token', 'constructor'], ['--toString'])).toEqual([UNKNOWN_FLAG]);
  });
});
