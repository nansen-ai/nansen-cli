import { describe, it, expect, vi } from 'vitest';
import { buildCommands, parseArgs, parseDateOption } from '../cli.js';

describe('parseDateOption validation', () => {
  it('keeps the days fallback when --date is absent', () => {
    const result = parseDateOption(undefined, 0);
    expect(result.from).toBe(result.to);
  });

  it('accepts a valid single date', () => {
    expect(parseDateOption('2026-09-17')).toEqual({
      from: '2026-09-17',
      to: '2026-09-17',
    });
  });

  it('accepts valid object and JSON-string date ranges', () => {
    expect(parseDateOption({ from: '2026-09-01', to: '2026-09-17' })).toEqual({
      from: '2026-09-01',
      to: '2026-09-17',
    });
    expect(parseDateOption('{"from":"2026-09-01","to":"2026-09-17"}')).toEqual({
      from: '2026-09-01',
      to: '2026-09-17',
    });
  });

  it('normalizes a from-only date range to a single day', () => {
    expect(parseDateOption({ from: '2026-09-17' })).toEqual({
      from: '2026-09-17',
      to: '2026-09-17',
    });
    expect(parseDateOption('{"from":"2026-09-17"}')).toEqual({
      from: '2026-09-17',
      to: '2026-09-17',
    });
  });

  it.each([
    'not-a-date',
    '2026-02-30',
    '',
  ])('rejects invalid date value %j instead of falling back to --days', (value) => {
    expect(() => parseDateOption(value)).toThrow(
      '--date must be YYYY-MM-DD or a JSON object with a valid "from" date and optional "to" date',
    );
  });

  it('rejects malformed date-range objects', () => {
    expect(() => parseDateOption({ from: '2026-02-30', to: '2026-09-17' })).toThrow(
      '--date must be YYYY-MM-DD or a JSON object with a valid "from" date and optional "to" date',
    );
    expect(() => parseDateOption({ to: '2026-09-17' })).toThrow(
      '--date must be YYYY-MM-DD or a JSON object with a valid "from" date and optional "to" date',
    );
  });

  it('rejects a valueless --date before an API call', async () => {
    const api = {
      addressTransactions: vi.fn(async () => ({ data: [] })),
    };
    // buildCommands exposes the top-level profiler handler directly; it receives
    // argv after the `profiler` token, so args[0] is the `transactions` subcommand.
    const { _: args, flags, options } = parseArgs([
      'transactions',
      '--address', '0x0000000000000000000000000000000000000001',
      '--date',
    ]);

    await expect(
      buildCommands({})['profiler'](args, api, flags, options),
    ).rejects.toThrow('--date requires a value');

    expect(api.addressTransactions).not.toHaveBeenCalled();
  });

  it('rejects an invalid --date before an API call', async () => {
    const api = {
      addressTransactions: vi.fn(async () => ({ data: [] })),
    };
    // Same direct profiler dispatch as above: the handler starts at subcommand args.
    const { _: args, flags, options } = parseArgs([
      'transactions',
      '--address', '0x0000000000000000000000000000000000000001',
      '--date', '2026-02-30',
    ]);

    await expect(
      buildCommands({})['profiler'](args, api, flags, options),
    ).rejects.toThrow('--date must be YYYY-MM-DD');

    expect(api.addressTransactions).not.toHaveBeenCalled();
  });
});
