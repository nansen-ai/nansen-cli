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
const { telemetryFlagNames, telemetryChain, telemetryErrorCode, API_TELEMETRY_ERROR_CODES, UNKNOWN_FLAG, UNKNOWN_CHAIN } = await import('../telemetry-flags.js');
const { readFileSync } = await import('node:fs');

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

describe('telemetry chain and error code', () => {
  beforeEach(() => {
    trackSucceeded.mockClear();
    trackFailed.mockClear();
  });

  const tracked = () => [...trackSucceeded.mock.calls, ...trackFailed.mock.calls];

  it('does not send a --chain value the CLI does not know', async () => {
    const address = '0x' + 'de'.repeat(20);
    await runCLI(['research', 'token', 'screener', '--chain', address], deps());
    expect(tracked()).toHaveLength(1);
    expect(tracked()[0][0].chain).toBe(UNKNOWN_CHAIN);
    expect(JSON.stringify(tracked()[0][0])).not.toContain(address);
  });

  it('sends a known --chain as its canonical name', async () => {
    await runCLI(['research', 'token', 'screener', '--chain', 'BSC'], deps());
    expect(tracked()[0][0].chain).toBe('bnb');
  });

  it('does not send free text given as --chain to a command without --chain', async () => {
    await runCLI(['changelog', '--chain', 'my secret text'], deps());
    expect(tracked()[0][0].chain).toBe(UNKNOWN_CHAIN);
  });

  it('maps chain values', () => {
    expect(telemetryChain(SCHEMA, undefined)).toBeNull();
    expect(telemetryChain(SCHEMA, '')).toBeNull();
    expect(telemetryChain(SCHEMA, 'solana')).toBe('solana');
    expect(telemetryChain(SCHEMA, ' ETH ')).toBe('ethereum');
    expect(telemetryChain(SCHEMA, 'all')).toBe('all');
    expect(telemetryChain(SCHEMA, 'evm')).toBe('evm');
    expect(telemetryChain(SCHEMA, 'hyperliquid')).toBe('hyperliquid');
    expect(telemetryChain(SCHEMA, 'notachain')).toBe(UNKNOWN_CHAIN);
    expect(telemetryChain(SCHEMA, 'constructor')).toBe(UNKNOWN_CHAIN);
    expect(telemetryChain(SCHEMA, true)).toBe(UNKNOWN_CHAIN);
    expect(telemetryChain(SCHEMA, ['solana'])).toBe(UNKNOWN_CHAIN);
  });

  it('sends only registered error codes', async () => {
    expect(telemetryErrorCode('UNAUTHORIZED')).toBe('UNAUTHORIZED');
    expect(telemetryErrorCode('unknown_field')).toBe('unknown_field');
    expect(telemetryErrorCode('feedback_blocked')).toBe('feedback_blocked');
    expect(telemetryErrorCode('LIMIT_ORDER_ERROR')).toBe('LIMIT_ORDER_ERROR');
    for (const code of [undefined, null, 'ENOENT', 'user typed text', 'some_new_api_code', 'constructor', ['UNAUTHORIZED'], { toString: () => 'UNAUTHORIZED' }]) {
      expect(telemetryErrorCode(code)).toBe('UNKNOWN');
    }

    const err = new Error('boom');
    err.code = 'ERR_SOME_LIBRARY_0xdeadbeef';
    function FailAPI() {
      return new Proxy({}, {
        get: (_target, prop) => (typeof prop === 'string' && prop !== 'then' ? vi.fn().mockRejectedValue(err) : undefined),
      });
    }
    await runCLI(['research', 'smart-money', 'netflow'], deps({ NansenAPIClass: FailAPI }));
    expect(trackFailed).toHaveBeenCalledTimes(1);
    expect(trackFailed.mock.calls[0][0].error_code).toBe('UNKNOWN');
  });
});

it('allows every error code and reason in the feedback API contract', () => {
  const contract = JSON.parse(readFileSync(new URL('./fixtures/feedback-v1.json', import.meta.url), 'utf8'));
  const codes = new Set();
  (function walk(node) {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if ((key === 'code' || key === 'reason') && typeof value === 'string') codes.add(value);
      else walk(value);
    }
  })(contract);
  expect(codes.size).toBeGreaterThan(5);
  for (const code of codes) expect([code, telemetryErrorCode(code)]).toEqual([code, code]);
  for (const code of API_TELEMETRY_ERROR_CODES) expect(code).toMatch(/^[a-z][a-z_]+$/);
});

it('allows every feedback code the CLI sets itself', () => {
  const codes = new Set();
  for (const file of ['../commands/feedback.js', '../feedback-journal.js']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    for (const [, code] of source.matchAll(/'(feedback_[a-z_]+|submission_outcome_unknown)'/g)) codes.add(code);
  }
  codes.delete('feedback_id'); // a response field name, not a code
  expect(codes.size).toBeGreaterThan(5);
  for (const code of codes) expect([code, telemetryErrorCode(code)]).toEqual([code, code]);
});
