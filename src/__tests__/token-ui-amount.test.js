import { describe, test, expect } from 'vitest';
import {
  readUiAmountConfig,
  effectiveMultiplier,
  scaledUiAmountToRaw,
  scaledRawToUiAmount,
  MULTIPLIER_SWITCH_AHEAD_SEC,
  MULTIPLIER_SWITCH_BEHIND_SEC,
} from '../token-ui-amount.js';

// The parsed `info` of a mainnet xStock mint (getAccountInfo, jsonParsed),
// trimmed to the fields and extensions that matter here.
const SCALED_MINT_INFO = {
  decimals: 8,
  isInitialized: true,
  supply: '2149999994218',
  extensions: [
    { extension: 'metadataPointer', state: {} },
    { extension: 'permanentDelegate', state: {} },
    {
      extension: 'scaledUiAmountConfig',
      state: {
        authority: 'S7vYFFWH6BjJyEsdrPQpqpYTqLTrPRK6KW3VwsJuRaS',
        multiplier: '6.004667790486',
        newMultiplier: '6.008873831153126',
        newMultiplierEffectiveTimestamp: 1790382600,
      },
    },
    { extension: 'pausableConfig', state: { paused: false } },
  ],
};
const SWITCH = 1790382600;
const AFTER = SWITCH + 86400 * 30; // well after the switch: newMultiplier applies
const BEFORE = SWITCH - 86400 * 30; // well before it: multiplier applies

const scaled = (overrides = {}) => ({
  kind: 'scaled', multiplier: '6.004667790486', newMultiplier: '6.008873831153126', effectiveTimestamp: SWITCH, ...overrides,
});

describe('readUiAmountConfig', () => {
  test('reads the scaled UI amount config of a real xStock mint', () => {
    expect(readUiAmountConfig(SCALED_MINT_INFO)).toEqual(scaled());
  });

  test('a mint without extensions (classic SPL) is plain', () => {
    expect(readUiAmountConfig({ decimals: 6 })).toEqual({ kind: 'plain' });
  });

  test('a Token-2022 mint with other extensions only is plain', () => {
    expect(readUiAmountConfig({ decimals: 6, extensions: [{ extension: 'transferFeeConfig', state: {} }] })).toEqual({ kind: 'plain' });
  });

  test('an interest-bearing mint is reported, not treated as plain', () => {
    expect(readUiAmountConfig({ extensions: [{ extension: 'interestBearingConfig', state: { currentRate: 500 } }] }))
      .toEqual({ kind: 'interest-bearing' });
  });

  test.each([
    ['no state', { extension: 'scaledUiAmountConfig' }],
    ['a numeric multiplier', { extension: 'scaledUiAmountConfig', state: { multiplier: 6, newMultiplier: '6', newMultiplierEffectiveTimestamp: 0 } }],
    ['a zero multiplier', { extension: 'scaledUiAmountConfig', state: { multiplier: '0', newMultiplier: '6', newMultiplierEffectiveTimestamp: 0 } }],
    ['an exponent new multiplier', { extension: 'scaledUiAmountConfig', state: { multiplier: '6', newMultiplier: '6e0', newMultiplierEffectiveTimestamp: 0 } }],
    ['a string timestamp', { extension: 'scaledUiAmountConfig', state: { multiplier: '6', newMultiplier: '6', newMultiplierEffectiveTimestamp: '0' } }],
    ['a missing timestamp', { extension: 'scaledUiAmountConfig', state: { multiplier: '6', newMultiplier: '6' } }],
  ])('a scaled config with %s is invalid, never plain', (_label, extension) => {
    expect(readUiAmountConfig({ extensions: [extension] })).toMatchObject({ kind: 'invalid' });
  });

  test.each([
    ['an unparseableExtension entry', [{ extension: 'unparseableExtension' }]],
    ['an unparseableExtension next to known extensions', [
      { extension: 'metadataPointer', state: {} },
      { extension: 'unparseableExtension' },
      { extension: 'transferFeeConfig', state: {} },
    ]],
    ['an unparseableExtension next to a readable scaled config', [...SCALED_MINT_INFO.extensions, { extension: 'unparseableExtension' }]],
    ['a null entry', [null]],
    ['an undefined entry', [undefined]],
    ['an entry that is not an object', ['scaledUiAmountConfig']],
    ['an entry without an extension name', [{ state: {} }]],
    ['an entry with a non-string extension name', [{ extension: 7, state: {} }]],
  ])('%s is invalid, never plain', (_label, extensions) => {
    expect(readUiAmountConfig({ extensions })).toMatchObject({ kind: 'invalid', reason: expect.any(String) });
  });

  test('an interest-bearing mint is still reported next to an unparseable extension', () => {
    expect(readUiAmountConfig({ extensions: [{ extension: 'unparseableExtension' }, { extension: 'interestBearingConfig', state: {} }] }))
      .toEqual({ kind: 'interest-bearing' });
  });

  test('extensions that are not a list are invalid', () => {
    expect(readUiAmountConfig({ extensions: {} })).toMatchObject({ kind: 'invalid' });
  });

  test('missing parsed info is plain (getTokenInfo has already refused it)', () => {
    expect(readUiAmountConfig(undefined)).toEqual({ kind: 'plain' });
  });
});

describe('effectiveMultiplier', () => {
  test('uses the new multiplier from its effective time on', () => {
    expect(effectiveMultiplier(scaled(), SWITCH - 1)).toBe('6.004667790486');
    expect(effectiveMultiplier(scaled(), SWITCH)).toBe('6.008873831153126');
  });
});

describe('scaledRawToUiAmount', () => {
  test('matches the RPC uiAmountString of a real balance (truncated, not rounded)', () => {
    // getTokenAccountBalance: amount 26778680571 → uiAmountString 1609.09712915
    // (exact value 1609.0971291589…).
    expect(scaledRawToUiAmount(26778680571n, 8, scaled(), AFTER)).toBe('1609.09712915');
  });

  test('uses the old multiplier before the switch', () => {
    expect(scaledRawToUiAmount(100000000n, 8, scaled(), BEFORE)).toBe('6.00466779');
  });

  test('drops trailing zeros and handles zero decimals', () => {
    expect(scaledRawToUiAmount(100n, 2, scaled({ multiplier: '2', newMultiplier: '2' }), AFTER)).toBe('2');
    expect(scaledRawToUiAmount(5n, 0, scaled({ multiplier: '1.5', newMultiplier: '1.5' }), AFTER)).toBe('7');
  });
});

describe('scaledUiAmountToRaw', () => {
  test('divides by the multiplier in effect: 1 displayed xStock is 16642053 base units, not 1e8', () => {
    expect(scaledUiAmountToRaw('1', 8, scaled(), AFTER)).toBe(16642053n);
  });

  test('uses the old multiplier before a switch that is still far away', () => {
    // floor(1e8 / 6.004667790486)
    expect(scaledUiAmountToRaw('1', 8, scaled(), BEFORE)).toBe(16653710n);
  });

  test('a displayed balance converts back to at most that balance', () => {
    expect(scaledUiAmountToRaw('1609.09712915', 8, scaled(), AFTER)).toBe(26778680570n);
  });

  test('rounds down: what it sends never displays as more than was asked', () => {
    const config = scaled();
    for (const amount of ['1', '0.5', '3.14159265', '1000', '0.00000007', '12345.6789']) {
      const raw = scaledUiAmountToRaw(amount, 8, config, AFTER);
      const shown = scaledRawToUiAmount(raw, 8, config, AFTER);
      expect(Number(shown)).toBeLessThanOrEqual(Number(amount));
      // ...and one more base unit would display as more than was asked.
      const next = Number(amount) * 1e8 * 1e15 / 6008873831153126;
      expect(Number(raw)).toBeGreaterThan(next - 1.0001);
    }
  });

  test('a multiplier below one sends more base units than displayed', () => {
    expect(scaledUiAmountToRaw('1', 6, scaled({ multiplier: '0.5', newMultiplier: '0.5' }), AFTER)).toBe(2000000n);
  });

  test('a multiplier of one is exactly the decimals conversion', () => {
    expect(scaledUiAmountToRaw('1.5', 6, scaled({ multiplier: '1', newMultiplier: '1.0' }), AFTER)).toBe(1500000n);
  });

  test.each([
    ['an hour before the switch', SWITCH - MULTIPLIER_SWITCH_AHEAD_SEC],
    ['a second before the switch', SWITCH - 1],
    ['at the switch', SWITCH],
    ['five minutes after the switch', SWITCH + MULTIPLIER_SWITCH_BEHIND_SEC],
  ])('refuses %s', (_label, now) => {
    expect(() => scaledUiAmountToRaw('1', 8, scaled(), now, 'MINT')).toThrow(/MINT changes its display multiplier from 6.004667790486 to 6.008873831153126 at 2026-09-26T00:30:00.000Z.*Nothing was signed or sent/);
  });

  test.each([
    ['just over an hour before the switch', SWITCH - MULTIPLIER_SWITCH_AHEAD_SEC - 1, 16653710n],
    ['just over five minutes after it', SWITCH + MULTIPLIER_SWITCH_BEHIND_SEC + 1, 16642053n],
  ])('converts %s', (_label, now, raw) => {
    expect(scaledUiAmountToRaw('1', 8, scaled(), now)).toBe(raw);
  });

  test('does not refuse near the switch time when the multiplier does not change', () => {
    expect(scaledUiAmountToRaw('1', 8, scaled({ multiplier: '6.5', newMultiplier: '6.50' }), SWITCH)).toBe(15384615n);
  });

  test.each([
    ['a negative amount', '-1', /must be positive/],
    ['a malformed amount', '1e3', /valid number/],
    ['a zero amount', '0.000', /greater than zero/],
    ['an amount that floors to zero base units', '0.00000005', /below the smallest unit.*display multiplier 6.008873831153126/],
  ])('refuses %s', (_label, amount, error) => {
    expect(() => scaledUiAmountToRaw(amount, 8, scaled(), AFTER)).toThrow(error);
  });

  test('accepts an amount of exactly the u64 maximum', () => {
    expect(scaledUiAmountToRaw('18446744073709551615', 0, scaled({ multiplier: '1', newMultiplier: '1' }), AFTER)).toBe((1n << 64n) - 1n);
  });

  test('refuses an amount above the u64 range', () => {
    expect(() => scaledUiAmountToRaw('1'.padEnd(20, '0'), 8, scaled(), AFTER)).toThrow(/larger than any token balance/);
  });
});
