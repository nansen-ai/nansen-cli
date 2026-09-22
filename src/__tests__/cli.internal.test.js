/**
 * CLI Internal Tests - Tests CLI functions directly for coverage
 * These tests import functions from cli.js and test them directly,
 * allowing V8 coverage to track execution.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseArgs,
  resolveBooleanOption,
  formatValue,
  formatTable,
  formatOutput,
  formatError,
  formatStream,
  formatCsv,
  parseSort,
  buildCommands,
  prompt,
  runCLI,
  DEPRECATED_TO_RESEARCH,
  DEPRECATED_TO_TRADE,
  HELP,
  SCHEMA,
  filterFields,
  parseFields,
  batchProfile,
  traceCounterparties,
  compareWallets,
  buildPagination,
  parseAddressList
} from '../cli.js';
import { parseCsvOption, parseObjectOption } from '../query-options.js';
import { enableAutoPagination, MAX_PAGES_LIMIT } from '../auto-paginate.js';
import {
  formatAlertsTable,
  buildAlertData,
  buildSmTokenFlowsData,
  buildCommonTokenTransferData,
  buildSmartContractCallData,
  buildAlertsCommands,
  validateAlertData,
} from '../commands/alerts.js';
import { getCachedResponse, setCachedResponse, clearCache, getCacheDir, NansenError, ErrorCode, computeIdentityDigest, COUNTERPARTIES_BATCH_CHAINS } from '../api.js';
import { EVM_CHAINS, EVM_CHAIN_IDS } from '../chain-ids.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('parseArgs', () => {
  it('should parse positional arguments', () => {
    const result = parseArgs(['token', 'screener']);
    expect(result._).toEqual(['token', 'screener']);
  });

  it('should parse boolean flags', () => {
    const result = parseArgs(['--pretty', '--table', '--no-retry']);
    expect(result.flags).toEqual({ pretty: true, table: true, 'no-retry': true });
  });

  it('should parse short flags', () => {
    const result = parseArgs(['-p', '-t']);
    expect(result.flags).toEqual({ p: true, t: true });
  });

  it('should parse options with values', () => {
    const result = parseArgs(['--chain', 'solana', '--limit', '10']);
    expect(result.options).toEqual({ chain: 'solana', limit: '10' }); // numbers kept as strings to avoid scientific notation
  });

  it('should parse JSON options', () => {
    const result = parseArgs(['--filters', '{"only_smart_money":true}']);
    expect(result.options.filters).toEqual({ only_smart_money: true });
  });

  it('should keep true/false/null option values as strings instead of JSON keywords', () => {
    const result = parseArgs(['--sort', 'true', '--search', 'false', '--label', 'null']);
    expect(result.options).toEqual({ sort: 'true', search: 'false', label: 'null' });
    expect(result.flags).toEqual({});
  });

  it('should keep true/false/null as strings inside repeated options too', () => {
    const result = parseArgs(['--token', 'true', '--token', '0xabc:base']);
    expect(result.options.token).toEqual(['true', '0xabc:base']);
  });

  it('should still parse object and array option values as JSON', () => {
    const result = parseArgs(['--filters', '{}', '--order-by', '[{"field":"x"}]']);
    expect(result.options.filters).toEqual({});
    expect(result.options['order-by']).toEqual([{ field: 'x' }]);
  });

  it('should keep numeric option values as strings exactly as before', () => {
    const result = parseArgs(['--limit', '10', '--amount', '1000000000000000000000', '--slippage', '0.5', '--days', '-7']);
    expect(result.options).toEqual({ limit: '10', amount: '1000000000000000000000', slippage: '0.5', days: '-7' });
  });

  it('should handle mixed args', () => {
    const result = parseArgs(['token', 'screener', '--chain', 'solana', '--pretty', '--limit', '5']);
    expect(result._).toEqual(['token', 'screener']);
    expect(result.options.chain).toBe('solana');
    expect(result.options.limit).toBe('5'); // numbers kept as strings to avoid scientific notation
    expect(result.flags.pretty).toBe(true);
  });

  it('should treat flag without value as boolean', () => {
    const result = parseArgs(['--help']);
    expect(result.flags.help).toBe(true);
  });

  it('rejects inline values for valueless flags instead of creating stale flag names', () => {
    for (const arg of ['--help=false', '--pretty=true', '--no-cache=1', '--help=']) {
      expect(() => parseArgs([arg])).toThrowError(
        expect.objectContaining({ code: 'INVALID_PARAMS' })
      );
    }
  });

  it('always consumes an explicitly inline value even when it starts with a dash', () => {
    const result = parseArgs(['changelog', '--since=--bad']);
    expect(result._).toEqual(['changelog']);
    expect(result.options.since).toBe('--bad');
    expect(result.flags.since).toBeUndefined();
  });

  it('keeps repeated valueless flags strictly boolean and idempotent', () => {
    const result = parseArgs(['--help', '--help', '--pretty', '--pretty']);
    expect(result.flags.help).toBe(true);
    expect(result.flags.pretty).toBe(true);
  });

  it('should handle flag followed by another flag', () => {
    const result = parseArgs(['--verbose', '--debug']);
    expect(result.flags.verbose).toBe(true);
    expect(result.flags.debug).toBe(true);
  });

  it('should consume an explicit empty-string value instead of leaking it into positionals', () => {
    const result = parseArgs(['--foo', '']);
    expect(result.options.foo).toBe('');
    expect(result.flags.foo).toBeUndefined();
    expect(result._).toEqual([]);
  });

  it('should keep positionals intact when an option is given an empty-string value', () => {
    const result = parseArgs(['web', 'fetch', 'https://nansen.ai', '--question', '']);
    expect(result._).toEqual(['web', 'fetch', 'https://nansen.ai']);
    expect(result.options.question).toBe('');
    expect(result.flags.question).toBeUndefined();
  });

  it('should accumulate repeated empty-string option values', () => {
    const result = parseArgs(['--token', '', '--token', '0xabc:base']);
    expect(result.options.token).toEqual(['', '0xabc:base']);
    expect(result._).toEqual([]);
  });

  it('should still treat a valueless flag followed by an empty string as boolean', () => {
    const result = parseArgs(['--pretty', '']);
    expect(result.flags.pretty).toBe(true);
    expect(result.options.pretty).toBeUndefined();
    expect(result._).toEqual(['']);
  });

  it('should keep boolean switches read only via flags out of options', () => {
    // Handlers such as perp.js `flags.all` and trading.js `flags.gasless` never
    // look at options, so a switch missing from VALUELESS_FLAGS would go dead
    // the moment it is followed by any token.
    for (const flag of ['all', 'max', 'gasless', 'auto-slippage', 'unsafe-no-password']) {
      const empty = parseArgs([`--${flag}`, '']);
      expect(empty.flags[flag]).toBe(true);
      expect(empty.options[flag]).toBeUndefined();

      const positional = parseArgs([`--${flag}`, 'BTC']);
      expect(positional.flags[flag]).toBe(true);
      expect(positional.options[flag]).toBeUndefined();
      expect(positional._).toEqual(['BTC']);
    }
  });

  it('should not swallow a following positional arg as the value of a trade execute boolean flag', () => {
    for (const flag of ['no-simulate', 'no-verify-outcome', 'no-revoke-excessive-allowance']) {
      const result = parseArgs(['trade', 'execute', `--${flag}`, '1708900000000-abc123']);
      expect(result.flags[flag]).toBe(true);
      expect(result.options[flag]).toBeUndefined();
      expect(result._).toEqual(['trade', 'execute', '1708900000000-abc123']);
    }
  });
});

describe('resolveBooleanOption', () => {
  const resolve = (argv, key = 'premium-labels') => {
    const { flags, options } = parseArgs(argv);
    return resolveBooleanOption(options, flags, key);
  };

  it('treats a bare --flag as true', () => {
    expect(resolve(['--premium-labels'])).toBe(true);
    expect(resolve(['--premium-labels', '--chain', 'solana'])).toBe(true);
  });

  it('treats --flag true as true', () => {
    expect(resolve(['--premium-labels', 'true'])).toBe(true);
    expect(resolve(['--premium-labels', 'TRUE'])).toBe(true);
    expect(resolve(['--premium-labels', '1'])).toBe(true);
  });

  it('treats --flag false as false', () => {
    expect(resolve(['--premium-labels', 'false'])).toBe(false);
    expect(resolve(['--premium-labels', 'False'])).toBe(false);
    expect(resolve(['--premium-labels', '0'])).toBe(false);
  });

  it('returns undefined when the option is absent', () => {
    expect(resolve([])).toBeUndefined();
    expect(resolve(['--chain', 'solana'])).toBeUndefined();
  });
});

describe('formatValue', () => {
  it('should return empty string for null/undefined', () => {
    expect(formatValue(null)).toBe('');
    expect(formatValue(undefined)).toBe('');
  });

  it('should format large numbers with M suffix', () => {
    expect(formatValue(1500000)).toBe('1.50M');
    expect(formatValue(-2000000)).toBe('-2.00M');
  });

  it('should format thousands with K suffix', () => {
    expect(formatValue(5000)).toBe('5.00K');
    expect(formatValue(-1500)).toBe('-1.50K');
  });
  it('should promote K to M at the rounding boundary', () => {
    expect(formatValue(999990)).toBe('999.99K');
    expect(formatValue(999999.995)).toBe('1.00M');
    expect(formatValue(999999.999)).toBe('1.00M');
    expect(formatValue(-999999.995)).toBe('-1.00M');
  });

  it('should format integers without decimals', () => {
    expect(formatValue(42)).toBe('42');
    expect(formatValue(0)).toBe('0');
  });

  it('should format floats with 2 decimals', () => {
    expect(formatValue(3.14159)).toBe('3.14');
  });

  it('should stringify objects', () => {
    expect(formatValue({ a: 1 })).toBe('{"a":1}');
  });

  it('should convert other types to string', () => {
    expect(formatValue('hello')).toBe('hello');
    expect(formatValue(true)).toBe('true');
  });
});

describe('formatTable', () => {
  it('should return "No data" for empty array', () => {
    expect(formatTable([])).toBe('No data');
  });

  it('should format array of objects as table', () => {
    const data = [
      { name: 'Token1', value_usd: 1000 },
      { name: 'Token2', value_usd: 2000 }
    ];
    const result = formatTable(data);
    expect(result).toContain('name');
    expect(result).toContain('value_usd');
    expect(result).toContain('Token1');
    expect(result).toContain('Token2');
  });

  it('should extract data from nested response', () => {
    const response = {
      data: [{ symbol: 'SOL', price_usd: 100 }]
    };
    const result = formatTable(response);
    expect(result).toContain('SOL');
  });

  it('should extract data from results field', () => {
    const response = {
      results: [{ symbol: 'ETH', price_usd: 3000 }]
    };
    const result = formatTable(response);
    expect(result).toContain('ETH');
  });

  it('should extract data from nested data.results', () => {
    const response = {
      data: {
        results: [{ symbol: 'BTC', price_usd: 50000 }]
      }
    };
    const result = formatTable(response);
    expect(result).toContain('BTC');
  });

  it('should handle single object', () => {
    const data = { name: 'Single', value: 123 };
    const result = formatTable(data);
    expect(result).toContain('Single');
  });

  it('should limit to 50 rows', () => {
    const data = Array.from({ length: 60 }, (_, i) => ({ id: i }));
    const result = formatTable(data);
    expect(result).toContain('... and 10 more rows');
  });

  it('should prioritize common fields', () => {
    const data = [{ zebra: 1, token_symbol: 'ABC', apple: 2 }];
    const result = formatTable(data);
    const lines = result.split('\n');
    const header = lines[0];
    // token_symbol should come before zebra (priority field)
    expect(header.indexOf('token_symbol')).toBeLessThan(header.indexOf('zebra'));
  });

  it('should keep wallet_address when a batch row exceeds the column limit', () => {
    // A batch counterparties row has 9 keys; without priority, wallet_address
    // sorts last alphabetically and is cut by the 8-column limit — losing the
    // key that says which input wallet the row belongs to.
    const data = [{
      counterparty_address: '0xcp',
      counterparty_address_label: ['Exchange'],
      interaction_count: 12,
      total_volume_usd: 1000,
      volume_in_usd: 600,
      volume_out_usd: 400,
      tokens_info: [],
      wallet_address: '0xwallet',
      chain: 'ethereum'
    }];
    const header = formatTable(data).split('\n')[0];
    expect(header).toContain('wallet_address');
    expect(header.indexOf('wallet_address')).toBeLessThan(header.indexOf('counterparty_address'));
  });
});

describe('formatAlertsTable', () => {
  it('should return "No alerts" for empty array', () => {
    expect(formatAlertsTable([])).toBe('No alerts');
  });

  it('should format alerts as table with ID, NAME, TYPE, ENABLED, CHANNELS columns', () => {
    const alerts = [
      { id: 'a1', name: 'ETH Whale Alert', type: 'sm-token-flows', isEnabled: true, channels: [{ type: 'telegram' }] },
      { id: 'a2', name: 'USDC Transfer Alert', type: 'common-token-transfer', isEnabled: false, channels: [{ type: 'slack' }, { type: 'discord' }] }
    ];
    const result = formatAlertsTable(alerts);
    expect(result).toContain('ID');
    expect(result).toContain('NAME');
    expect(result).toContain('TYPE');
    expect(result).toContain('ENABLED');
    expect(result).toContain('CHANNELS');
    expect(result).toContain('a1');
    expect(result).toContain('a2');
    expect(result).toContain('ETH Whale Alert');
    expect(result).toContain('sm-token-flows');
    expect(result).toContain('✓');
    expect(result).toContain('✗');
    expect(result).toContain('telegram');
    expect(result).toContain('slack, discord');
  });

  it('should handle alerts with no channels', () => {
    const alerts = [
      { id: 'a1', name: 'Test Alert', type: 'sm-token-flows', isEnabled: true, channels: [] }
    ];
    const result = formatAlertsTable(alerts);
    expect(result).toContain('Test Alert');
    expect(result).not.toContain('undefined');
  });

  it('should truncate long names', () => {
    const alerts = [
      { id: 'a1', name: 'A very long alert name that exceeds the column width and should be truncated', type: 'sm-token-flows', isEnabled: true, channels: [] }
    ];
    const result = formatAlertsTable(alerts);
    expect(result).toContain('…');
  });

  it('should show full ID without truncation', () => {
    const alerts = [
      { id: 'very-long-alert-id-that-should-not-be-truncated', name: 'Test', type: 'sm-token-flows', isEnabled: true, channels: [] }
    ];
    const result = formatAlertsTable(alerts);
    expect(result).toContain('very-long-alert-id-that-should-not-be-truncated');
  });
});

describe('buildSmTokenFlowsData', () => {
  it('should build data with inflow range flags', () => {
    const result = buildSmTokenFlowsData({
      chains: 'ethereum',
      'inflow-1h-min': '5000000',
    });
    expect(result.chains).toEqual(['ethereum']);
    expect(result.inflow_1h).toEqual({ min: 5000000 });
  });

  it('should build data with multiple flow ranges', () => {
    const result = buildSmTokenFlowsData({
      'inflow-1h-min': '1000000',
      'outflow-7d-max': '500000',
    });
    expect(result.inflow_1h).toEqual({ min: 1000000 });
    expect(result.outflow_7d).toEqual({ max: 500000 });
  });

  it('should parse --token into inclusion.tokens', () => {
    const result = buildSmTokenFlowsData({
      token: '0xabc123:ethereum',
    });
    expect(result.inclusion).toEqual({ tokens: [{ address: '0xabc123', chain: 'ethereum' }] });
  });

  it('should parse repeated --token into inclusion.tokens array', () => {
    const result = buildSmTokenFlowsData({
      token: ['0xabc:ethereum', '0xdef:base'],
    });
    expect(result.inclusion).toEqual({
      tokens: [
        { address: '0xabc', chain: 'ethereum' },
        { address: '0xdef', chain: 'base' },
      ],
    });
  });

  it('should parse --exclude-token into exclusion.tokens', () => {
    const result = buildSmTokenFlowsData({
      'exclude-token': '0xbad:ethereum',
    });
    expect(result.exclusion).toEqual({ tokens: [{ address: '0xbad', chain: 'ethereum' }] });
  });

  it('should return empty object when no flags provided', () => {
    const result = buildSmTokenFlowsData({});
    expect(result).toEqual({});
  });
});

describe('buildCommonTokenTransferData', () => {
  it('should build data with events and USD range', () => {
    const result = buildCommonTokenTransferData({
      chains: 'ethereum',
      events: 'send,receive',
      'usd-min': '1000000',
    });
    expect(result.chains).toEqual(['ethereum']);
    expect(result.events).toEqual(['send', 'receive']);
    expect(result.usdValue).toEqual({ min: 1000000 });
  });

  it('should build data with token amount range', () => {
    const result = buildCommonTokenTransferData({
      'token-amount-min': '100',
      'token-amount-max': '5000',
    });
    expect(result.tokenAmount).toEqual({ min: 100, max: 5000 });
  });

  it('should parse --subject into subjects array', () => {
    const result = buildCommonTokenTransferData({
      subject: 'label:Centralized Exchange',
    });
    expect(result.subjects).toEqual([{ type: 'label', value: 'Centralized Exchange' }]);
  });

  it('should parse repeated --subject values', () => {
    const result = buildCommonTokenTransferData({
      subject: ['label:CEX', 'label:DEX'],
    });
    expect(result.subjects).toEqual([
      { type: 'label', value: 'CEX' },
      { type: 'label', value: 'DEX' },
    ]);
  });

  it('should parse --token into inclusion.tokens', () => {
    const result = buildCommonTokenTransferData({
      token: '0xusdc:ethereum',
    });
    expect(result.inclusion).toEqual({ tokens: [{ address: '0xusdc', chain: 'ethereum' }] });
  });
});

describe('buildAlertData', () => {
  it('should dispatch to buildSmTokenFlowsData for sm-token-flows type', () => {
    const result = buildAlertData({
      type: 'sm-token-flows',
      chains: 'ethereum',
      'inflow-1h-min': '5000000',
    });
    expect(result.chains).toEqual(['ethereum']);
    expect(result.inflow_1h).toEqual({ min: 5000000 });
  });

  it('should dispatch to buildCommonTokenTransferData for common-token-transfer type', () => {
    const result = buildAlertData({
      type: 'common-token-transfer',
      chains: 'ethereum',
      events: 'send,receive',
      'usd-min': '1000000',
    });
    expect(result.chains).toEqual(['ethereum']);
    expect(result.events).toEqual(['send', 'receive']);
    expect(result.usdValue).toEqual({ min: 1000000 });
  });

  it('should fall back to chains-only for unknown type', () => {
    const result = buildAlertData({
      type: 'unknown-type',
      chains: 'solana',
    });
    expect(result).toEqual({ chains: ['solana'] });
  });

  it('should not process --data (handled by handlers)', () => {
    const result = buildAlertData({
      type: 'sm-token-flows',
      chains: 'ethereum',
      data: '{"chains":["base"]}',
    });
    // buildAlertData ignores --data; handlers apply it post-merge
    expect(result.chains).toEqual(['ethereum']);
  });

  it('should work with no type (no flags)', () => {
    const result = buildAlertData({});
    expect(result).toEqual({});
  });

  it('should apply sm-token-flows defaults for all required fields', () => {
    const result = buildAlertData({ type: 'sm-token-flows' });
    expect(result.chains).toEqual([]);
    expect(result.events).toEqual(['sm-token-flows']);
    expect(result.inflow_1h).toEqual({});
    expect(result.inflow_1d).toEqual({});
    expect(result.inflow_7d).toEqual({});
    expect(result.outflow_1h).toEqual({});
    expect(result.outflow_1d).toEqual({});
    expect(result.outflow_7d).toEqual({});
    expect(result.netflow_1h).toEqual({});
    expect(result.netflow_1d).toEqual({});
    expect(result.netflow_7d).toEqual({});
    expect(result.inclusion).toEqual({});
    expect(result.exclusion).toEqual({});
  });

  it('should apply common-token-transfer defaults for all required fields', () => {
    const result = buildAlertData({ type: 'common-token-transfer' });
    expect(result.chains).toEqual([]);
    expect(result.events).toEqual([]);
    expect(result.subjects).toEqual([]);
    expect(result.counterparties).toEqual([]);
    expect(result.usdValue).toEqual({});
    expect(result.tokenAmount).toEqual({});
    expect(result.inclusion).toEqual({});
    expect(result.exclusion).toEqual({});
  });

  it('should apply smart-contract-call defaults for all required fields', () => {
    const result = buildAlertData({ type: 'smart-contract-call' });
    expect(result.chains).toEqual([]);
    expect(result.events).toEqual(['smart-contract-call']);
    expect(result.usdValue).toEqual({});
    expect(result.signatureHash).toEqual([]);
    expect(result.inclusion).toEqual({ caller: [], smartContract: [] });
    expect(result.exclusion).toEqual({ caller: [], smartContract: [] });
  });

  it('should deep-merge inclusion/exclusion so partial flags keep sibling defaults (smart-contract-call)', () => {
    const result = buildAlertData({
      type: 'smart-contract-call',
      chains: 'ethereum',
      caller: 'address:0xabc',
    });
    // --caller sets inclusion.caller, but smartContract should still be present from defaults
    expect(result.inclusion.caller).toEqual([{ type: 'address', value: '0xabc' }]);
    expect(result.inclusion.smartContract).toEqual([]);
    // exclusion untouched — both sub-fields from defaults
    expect(result.exclusion).toEqual({ caller: [], smartContract: [] });
  });

  it('should not share mutable references between calls', () => {
    const result1 = buildAlertData({ type: 'smart-contract-call' });
    const result2 = buildAlertData({ type: 'smart-contract-call' });
    result1.inclusion.caller.push({ type: 'address', value: '0x1' });
    expect(result2.inclusion.caller).toEqual([]);
  });

  it('should let user flags override defaults', () => {
    const result = buildAlertData({
      type: 'common-token-transfer',
      chains: 'ethereum,base',
      events: 'send',
      'usd-min': '500',
    });
    expect(result.chains).toEqual(['ethereum', 'base']);
    expect(result.events).toEqual(['send']);
    expect(result.usdValue).toEqual({ min: 500 });
    // Defaults still present for unset fields
    expect(result.counterparties).toEqual([]);
    expect(result.tokenAmount).toEqual({});
    expect(result.inclusion).toEqual({});
    expect(result.exclusion).toEqual({});
  });

  it('should skip defaults when applyDefaults is false (update path)', () => {
    const result = buildAlertData({ type: 'common-token-transfer', chains: 'ethereum' }, { applyDefaults: false });
    expect(result.chains).toEqual(['ethereum']);
    expect(result.counterparties).toBeUndefined();
    expect(result.usdValue).toBeUndefined();
    expect(result.tokenAmount).toBeUndefined();
  });

  it('should not wipe subjects when updating common-token-transfer without --subject', () => {
    // Simulates: user created alert with --subject label:CEX, then updates with only --usd-min 5000
    const result = buildAlertData({ type: 'common-token-transfer', 'usd-min': '5000' }, { applyDefaults: false });
    expect(result.subjects).toBeUndefined();
    expect(result.usdValue).toEqual({ min: 5000 });
  });

  it('should not apply --data (handled by handlers)', () => {
    const result = buildAlertData({
      type: 'sm-token-flows',
      data: '{"events":["custom"]}',
    });
    // --data is ignored by buildAlertData; defaults apply normally
    expect(result.events).toEqual(['sm-token-flows']);
  });
});

describe('buildSmTokenFlowsData netflow fields', () => {
  it('should include netflow-1h range', () => {
    const result = buildSmTokenFlowsData({ 'netflow-1h-min': '100000' });
    expect(result.netflow_1h).toEqual({ min: 100000 });
  });

  it('should include netflow-1d and netflow-7d ranges', () => {
    const result = buildSmTokenFlowsData({ 'netflow-1d-min': '500000', 'netflow-7d-max': '2000000' });
    expect(result.netflow_1d).toEqual({ min: 500000 });
    expect(result.netflow_7d).toEqual({ max: 2000000 });
  });
});

describe('buildCommonTokenTransferData counterparty', () => {
  it('should add counterparties when --counterparty is provided', () => {
    const result = buildCommonTokenTransferData({ counterparty: 'address:0xabc' });
    expect(result.counterparties).toEqual([{ type: 'address', value: '0xabc' }]);
  });

  it('should handle repeated --counterparty flags as array', () => {
    const result = buildCommonTokenTransferData({ counterparty: ['address:0xabc', 'label:Whale'] });
    expect(result.counterparties).toEqual([
      { type: 'address', value: '0xabc' },
      { type: 'label', value: 'Whale' },
    ]);
  });

  it('should not add counterparties when flag is absent', () => {
    const result = buildCommonTokenTransferData({ chains: 'ethereum' });
    expect(result.counterparties).toBeUndefined();
  });
});

describe('buildSmartContractCallData', () => {
  it('should build data with chains and usd range', () => {
    const result = buildSmartContractCallData({ chains: 'ethereum,base', 'usd-min': '1000', 'usd-max': '9999' });
    expect(result.chains).toEqual(['ethereum', 'base']);
    expect(result.usdValue).toEqual({ min: 1000, max: 9999 });
  });

  it('should build signatureHash as array from single value', () => {
    const result = buildSmartContractCallData({ 'signature-hash': '0xa9059cbb' });
    expect(result.signatureHash).toEqual(['0xa9059cbb']);
  });

  it('should build signatureHash as array from repeated flags', () => {
    const result = buildSmartContractCallData({ 'signature-hash': ['0xa9059cbb', '0x23b872dd'] });
    expect(result.signatureHash).toEqual(['0xa9059cbb', '0x23b872dd']);
  });

  it('should build inclusion.caller from --caller', () => {
    const result = buildSmartContractCallData({ caller: 'address:0xabc' });
    expect(result.inclusion.caller).toEqual([{ type: 'address', value: '0xabc' }]);
  });

  it('should build inclusion.smartContract from --contract', () => {
    const result = buildSmartContractCallData({ contract: 'address:0xdef' });
    expect(result.inclusion.smartContract).toEqual([{ type: 'address', value: '0xdef' }]);
  });

  it('should build exclusion.caller from --exclude-caller', () => {
    const result = buildSmartContractCallData({ 'exclude-caller': 'label:Bot' });
    expect(result.exclusion.caller).toEqual([{ type: 'label', value: 'Bot' }]);
  });

  it('should build exclusion.smartContract from --exclude-contract', () => {
    const result = buildSmartContractCallData({ 'exclude-contract': 'address:0x999' });
    expect(result.exclusion.smartContract).toEqual([{ type: 'address', value: '0x999' }]);
  });

  it('should dispatch to buildSmartContractCallData for smart-contract-call type', () => {
    const result = buildAlertData({ type: 'smart-contract-call', chains: 'ethereum', 'signature-hash': '0xa9059cbb' });
    expect(result.chains).toEqual(['ethereum']);
    expect(result.signatureHash).toEqual(['0xa9059cbb']);
  });
});

describe('buildSmTokenFlowsData new inclusion/exclusion flags', () => {
  it('should add token-sector to inclusion.tokenSectors', () => {
    const result = buildSmTokenFlowsData({ 'token-sector': 'DeFi' });
    expect(result.inclusion.tokenSectors).toEqual(['DeFi']);
  });

  it('should handle repeated --token-sector', () => {
    const result = buildSmTokenFlowsData({ 'token-sector': ['DeFi', 'NFT'] });
    expect(result.inclusion.tokenSectors).toEqual(['DeFi', 'NFT']);
  });

  it('should add exclude-token-sector to exclusion.tokenSectors', () => {
    const result = buildSmTokenFlowsData({ 'exclude-token-sector': 'Meme' });
    expect(result.exclusion.tokenSectors).toEqual(['Meme']);
  });

  it('should add token-age-max to inclusion.tokenAge', () => {
    const result = buildSmTokenFlowsData({ 'token-age-max': '30' });
    expect(result.inclusion.tokenAge).toEqual({ max: 30 });
  });

  it('should add market-cap range to inclusion.marketCap', () => {
    const result = buildSmTokenFlowsData({ 'market-cap-min': '1000000', 'market-cap-max': '9000000' });
    expect(result.inclusion.marketCap).toEqual({ min: 1000000, max: 9000000 });
  });

  it('should add fdv range to inclusion.fdvUsd', () => {
    const result = buildSmTokenFlowsData({ 'fdv-min': '500000' });
    expect(result.inclusion.fdvUsd).toEqual({ min: 500000 });
  });

  it('should merge token-sector with existing inclusion.tokens', () => {
    const result = buildSmTokenFlowsData({ token: '0xabc:ethereum', 'token-sector': 'DeFi' });
    expect(result.inclusion.tokens).toEqual([{ address: '0xabc', chain: 'ethereum' }]);
    expect(result.inclusion.tokenSectors).toEqual(['DeFi']);
  });
});

describe('buildCommonTokenTransferData new inclusion/exclusion flags', () => {
  it('should add token-sector to inclusion.tokenSectors', () => {
    const result = buildCommonTokenTransferData({ 'token-sector': 'DeFi' });
    expect(result.inclusion.tokenSectors).toEqual(['DeFi']);
  });

  it('should add exclude-token-sector to exclusion.tokenSectors', () => {
    const result = buildCommonTokenTransferData({ 'exclude-token-sector': ['Meme', 'GameFi'] });
    expect(result.exclusion.tokenSectors).toEqual(['Meme', 'GameFi']);
  });

  it('should add token-age-min and token-age-max to inclusion.tokenAge', () => {
    const result = buildCommonTokenTransferData({ 'token-age-min': '7', 'token-age-max': '90' });
    expect(result.inclusion.tokenAge).toEqual({ min: 7, max: 90 });
  });

  it('should add token-age-max only', () => {
    const result = buildCommonTokenTransferData({ 'token-age-max': '30' });
    expect(result.inclusion.tokenAge).toEqual({ max: 30 });
  });

  it('should add market-cap range to inclusion.marketCap', () => {
    const result = buildCommonTokenTransferData({ 'market-cap-min': '1000000' });
    expect(result.inclusion.marketCap).toEqual({ min: 1000000 });
  });

  it('should add exclude-from to exclusion.fromTargets', () => {
    const result = buildCommonTokenTransferData({ 'exclude-from': 'address:0xbad' });
    expect(result.exclusion.fromTargets).toEqual([{ type: 'address', value: '0xbad' }]);
  });

  it('should add exclude-to to exclusion.toTargets', () => {
    const result = buildCommonTokenTransferData({ 'exclude-to': ['label:Bot', 'label:Scammer'] });
    expect(result.exclusion.toTargets).toEqual([
      { type: 'label', value: 'Bot' },
      { type: 'label', value: 'Scammer' },
    ]);
  });

  it('should merge token-sector with existing inclusion.tokens', () => {
    const result = buildCommonTokenTransferData({ token: '0xabc:base', 'token-sector': 'DeFi' });
    expect(result.inclusion.tokens).toEqual([{ address: '0xabc', chain: 'base' }]);
    expect(result.inclusion.tokenSectors).toEqual(['DeFi']);
  });

  it('should merge exclude-from with existing exclusion.tokens', () => {
    const result = buildCommonTokenTransferData({ 'exclude-token': '0xbad:ethereum', 'exclude-from': 'label:Bot' });
    expect(result.exclusion.tokens).toEqual([{ address: '0xbad', chain: 'ethereum' }]);
    expect(result.exclusion.fromTargets).toEqual([{ type: 'label', value: 'Bot' }]);
  });
});

describe('alerts list — client-side filtering', () => {
  const ALERTS = [
    { id: '1', name: 'A', type: 'sm-token-flows', isEnabled: true, data: { chains: ['ethereum'], inclusion: { tokens: [{ address: '0xabc', chain: 'ethereum' }] } } },
    { id: '2', name: 'B', type: 'common-token-transfer', isEnabled: false, data: { chains: ['solana'] } },
    { id: '3', name: 'C', type: 'sm-token-flows', isEnabled: true, data: { chains: ['ethereum', 'base'] } },
    { id: '4', name: 'D', type: 'smart-contract-call', isEnabled: true, data: { chains: ['all'] } },
    { id: '5', name: 'E', type: 'sm-token-flows', isEnabled: true, data: { chains: ['ethereum'], exclusion: { tokens: [{ address: '0xdef', chain: 'ethereum' }] } } },
  ];

  function setup() {
    const mockApi = { alertsList: vi.fn().mockResolvedValue(ALERTS) };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    return { mockApi, cmd };
  }

  it('should return all alerts with no filters', async () => {
    const { mockApi, cmd } = setup();
    const result = await cmd(['list'], mockApi, {}, {});
    expect(result).toHaveLength(5);
  });

  it('should filter by --type', async () => {
    const { mockApi, cmd } = setup();
    const result = await cmd(['list'], mockApi, {}, { type: 'sm-token-flows' });
    expect(result).toHaveLength(3);
    expect(result.every(a => a.type === 'sm-token-flows')).toBe(true);
  });

  it('should filter by --enabled', async () => {
    const { mockApi, cmd } = setup();
    const result = await cmd(['list'], mockApi, { enabled: true }, {});
    expect(result).toHaveLength(4);
    expect(result.every(a => a.isEnabled)).toBe(true);
  });

  it('should filter by --disabled', async () => {
    const { mockApi, cmd } = setup();
    const result = await cmd(['list'], mockApi, { disabled: true }, {});
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('2');
  });

  it('should reject --enabled and --disabled together', async () => {
    const { mockApi, cmd } = setup();
    await expect(cmd(['list'], mockApi, { enabled: true, disabled: true }, {}))
      .rejects.toThrow('Cannot specify both --enabled and --disabled');
  });

  it('should filter by --token-address (case-insensitive)', async () => {
    const { mockApi, cmd } = setup();
    const result = await cmd(['list'], mockApi, {}, { 'token-address': '0xABC' });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('1');
  });

  it('should match --token-address in exclusion tokens', async () => {
    const { mockApi, cmd } = setup();
    const result = await cmd(['list'], mockApi, {}, { 'token-address': '0xdef' });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('5');
  });

  it('should not false-positive --token-address against chain names', async () => {
    const { mockApi, cmd } = setup();
    const result = await cmd(['list'], mockApi, {}, { 'token-address': 'ethereum' });
    expect(result).toHaveLength(0);
  });

  it('should not false-positive --token-address against chains: ["all"]', async () => {
    const { mockApi, cmd } = setup();
    const result = await cmd(['list'], mockApi, {}, { 'token-address': 'all' });
    expect(result).toHaveLength(0);
  });

  it('should filter by --chain (includes "all" matches)', async () => {
    const { mockApi, cmd } = setup();
    const result = await cmd(['list'], mockApi, {}, { chain: 'solana' });
    expect(result).toHaveLength(2);
    expect(result.map(a => a.id)).toEqual(['2', '4']);
  });

  it('should match --chain against "all" even when no explicit match', async () => {
    const { mockApi, cmd } = setup();
    const result = await cmd(['list'], mockApi, {}, { chain: 'arbitrum' });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('4');
  });

  it('should reject a non-string --token-address instead of crashing on .toLowerCase()', async () => {
    const { mockApi, cmd } = setup();
    await expect(cmd(['list'], mockApi, {}, { 'token-address': true }))
      .rejects.toThrow('--token-address must be a string');
    expect(mockApi.alertsList).not.toHaveBeenCalled();
  });

  it('should reject a non-string --chain instead of crashing on .toLowerCase()', async () => {
    const { mockApi, cmd } = setup();
    await expect(cmd(['list'], mockApi, {}, { chain: false }))
      .rejects.toThrow('--chain must be a string');
    expect(mockApi.alertsList).not.toHaveBeenCalled();
  });

  it('should apply --limit', async () => {
    const { mockApi, cmd } = setup();
    const result = await cmd(['list'], mockApi, {}, { limit: 2 });
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('1');
  });

  it('should apply --offset', async () => {
    const { mockApi, cmd } = setup();
    const result = await cmd(['list'], mockApi, {}, { offset: 2 });
    expect(result).toHaveLength(3);
    expect(result[0].id).toBe('3');
  });

  it('should apply --offset and --limit together', async () => {
    const { mockApi, cmd } = setup();
    const result = await cmd(['list'], mockApi, {}, { offset: 1, limit: 2 });
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('2');
    expect(result[1].id).toBe('3');
  });

  it('should honor --limit 0 (return zero results) instead of treating it as unset', async () => {
    const { mockApi, cmd } = setup();
    const result = await cmd(['list'], mockApi, {}, { limit: 0 });
    expect(result).toHaveLength(0);
  });

  it('should honor --offset 0 (a no-op, not "unset") without erroring', async () => {
    const { mockApi, cmd } = setup();
    const result = await cmd(['list'], mockApi, {}, { offset: 0 });
    expect(result).toHaveLength(5);
  });

  it('should reject a non-numeric --limit instead of silently returning zero results', async () => {
    const { mockApi, cmd } = setup();
    await expect(cmd(['list'], mockApi, {}, { limit: 'abc' }))
      .rejects.toThrow('--limit must be a non-negative integer');
    expect(mockApi.alertsList).not.toHaveBeenCalled();
  });

  it('should reject a non-numeric --offset instead of silently no-op-ing', async () => {
    const { mockApi, cmd } = setup();
    await expect(cmd(['list'], mockApi, {}, { offset: 'abc' }))
      .rejects.toThrow('--offset must be a non-negative integer');
    expect(mockApi.alertsList).not.toHaveBeenCalled();
  });

  it('should reject a negative --limit', async () => {
    const { mockApi, cmd } = setup();
    await expect(cmd(['list'], mockApi, {}, { limit: -1 }))
      .rejects.toThrow('--limit must be a non-negative integer');
    expect(mockApi.alertsList).not.toHaveBeenCalled();
  });

  it('should reject a negative --offset instead of silently slicing from the end', async () => {
    const { mockApi, cmd } = setup();
    await expect(cmd(['list'], mockApi, {}, { offset: -1 }))
      .rejects.toThrow('--offset must be a non-negative integer');
    expect(mockApi.alertsList).not.toHaveBeenCalled();
  });

  it('should reject a non-integer --limit (e.g. "2.5")', async () => {
    const { mockApi, cmd } = setup();
    await expect(cmd(['list'], mockApi, {}, { limit: '2.5' }))
      .rejects.toThrow('--limit must be a non-negative integer');
    expect(mockApi.alertsList).not.toHaveBeenCalled();
  });

  it('should combine type + chain filters', async () => {
    const { mockApi, cmd } = setup();
    const result = await cmd(['list'], mockApi, {}, { type: 'sm-token-flows', chain: 'base' });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('3');
  });
});

describe('alerts create does not require --time-window', () => {
  it('should throw only for missing --name, --type, and channel (not --time-window)', async () => {
    const logs = [];
    const mockApi = { alertsCreate: vi.fn().mockResolvedValue({ id: 'new' }) };
    const cmd = buildAlertsCommands({ log: (...a) => logs.push(a) })['alerts'];
    // Missing --name and --type but has channel — should complain about name and type, not time-window
    let err;
    try {
      await cmd(['create'], mockApi, {}, { telegram: '123' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.message).toContain('--name');
    expect(err.message).toContain('--type');
    expect(err.message).not.toContain('--time-window');
  });

  it('should use TIME_WINDOW_BY_TYPE for sm-token-flows', async () => {
    const mockApi = { alertsCreate: vi.fn().mockResolvedValue({ id: 'new' }) };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await cmd(['create'], mockApi, {}, { name: 'Test', type: 'sm-token-flows', chains: 'ethereum', telegram: '123', 'inflow-1h-min': 1000000 });
    expect(mockApi.alertsCreate).toHaveBeenCalledWith(expect.objectContaining({ timeWindow: '1h' }));
  });

  it('should use realtime for common-token-transfer', async () => {
    const mockApi = { alertsCreate: vi.fn().mockResolvedValue({ id: 'new' }) };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await cmd(['create'], mockApi, {}, { name: 'Test', type: 'common-token-transfer', chains: 'ethereum', telegram: '123', subject: 'label:CEX' });
    expect(mockApi.alertsCreate).toHaveBeenCalledWith(expect.objectContaining({ timeWindow: 'realtime' }));
  });
});

describe('alerts create — webhook channel', () => {
  it('should include webhook channel in alertsCreate payload', async () => {
    const mockApi = { alertsCreate: vi.fn().mockResolvedValue({ id: 'new' }) };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await cmd(
      ['create'],
      mockApi,
      {},
      { name: 'Webhook Alert', type: 'sm-token-flows', chains: 'ethereum', webhook: 'https://example.com/hook', 'inflow-1h-min': 1000000 },
    );
    expect(mockApi.alertsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        channels: expect.arrayContaining([
          { type: 'webhook', data: { webhookUrl: 'https://example.com/hook' } },
        ]),
      }),
    );
  });

  it('should combine webhook with other channels', async () => {
    const mockApi = { alertsCreate: vi.fn().mockResolvedValue({ id: 'new' }) };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await cmd(
      ['create'],
      mockApi,
      {},
      { name: 'Multi-channel', type: 'sm-token-flows', chains: 'ethereum', telegram: '123', webhook: 'https://example.com/hook', 'inflow-1h-min': 500000 },
    );
    const call = mockApi.alertsCreate.mock.calls[0][0];
    expect(call.channels).toHaveLength(2);
    expect(call.channels).toEqual(
      expect.arrayContaining([
        { type: 'telegram', data: { chatId: '123' } },
        { type: 'webhook', data: { webhookUrl: 'https://example.com/hook' } },
      ]),
    );
  });

  it('should satisfy channel requirement with --webhook alone', async () => {
    const mockApi = { alertsCreate: vi.fn().mockResolvedValue({ id: 'new' }) };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    // Should NOT throw "a channel" missing error
    await expect(
      cmd(
        ['create'],
        mockApi,
        {},
        { name: 'Webhook Only', type: 'sm-token-flows', chains: 'ethereum', webhook: 'https://example.com/hook', 'inflow-1h-min': 1000000 },
      ),
    ).resolves.toBeDefined();
  });

  it('should include webhook in update channels', async () => {
    const mockApi = {
      alertsGet: vi.fn().mockResolvedValue({ type: 'sm-token-flows', data: { chains: ['ethereum'], inflow_1h: { min: 1000000 } } }),
      alertsUpdate: vi.fn().mockResolvedValue({ id: 'abc123' }),
    };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await cmd(['update', 'abc123'], mockApi, {}, { webhook: 'https://example.com/hook' });
    expect(mockApi.alertsUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        channels: [{ type: 'webhook', data: { webhookUrl: 'https://example.com/hook' } }],
      }),
    );
  });

  it('should mention --webhook in the missing-channel error message', async () => {
    const mockApi = { alertsCreate: vi.fn() };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    let err;
    try {
      await cmd(['create'], mockApi, {}, { name: 'Test', type: 'sm-token-flows', chains: 'ethereum', 'inflow-1h-min': 1000000 });
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.message).toContain('--webhook');
  });

  it('should include secret in webhook channel when --webhook-secret provided', async () => {
    const mockApi = { alertsCreate: vi.fn().mockResolvedValue({ id: 'new' }) };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await cmd(
      ['create'],
      mockApi,
      {},
      { name: 'Webhook Secret', type: 'sm-token-flows', chains: 'ethereum', webhook: 'https://example.com/hook', "webhook-secret": 'my-secret-key-1234', 'inflow-1h-min': 1000000 },
    );
    expect(mockApi.alertsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        channels: [{ type: 'webhook', data: { webhookUrl: 'https://example.com/hook', secret: 'my-secret-key-1234' } }],
      }),
    );
  });

  it('should not include secret when --webhook-secret is omitted', async () => {
    const mockApi = { alertsCreate: vi.fn().mockResolvedValue({ id: 'new' }) };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await cmd(
      ['create'],
      mockApi,
      {},
      { name: 'No Secret', type: 'sm-token-flows', chains: 'ethereum', webhook: 'https://example.com/hook', 'inflow-1h-min': 1000000 },
    );
    const channel = mockApi.alertsCreate.mock.calls[0][0].channels[0];
    expect(channel.data).toEqual({ webhookUrl: 'https://example.com/hook' });
    expect(channel.data).not.toHaveProperty('secret');
  });

  it('should include secret in webhook channel on update', async () => {
    const mockApi = {
      alertsGet: vi.fn().mockResolvedValue({ type: 'sm-token-flows', data: { chains: ['ethereum'], inflow_1h: { min: 1000000 } } }),
      alertsUpdate: vi.fn().mockResolvedValue({ id: 'abc123' }),
    };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await cmd(['update', 'abc123'], mockApi, {}, { webhook: 'https://example.com/hook', "webhook-secret": 'update-secret-1234' });
    expect(mockApi.alertsUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        channels: [{ type: 'webhook', data: { webhookUrl: 'https://example.com/hook', secret: 'update-secret-1234' } }],
      }),
    );
  });

  it('should reject --webhook-secret shorter than 16 characters', async () => {
    const mockApi = { alertsCreate: vi.fn().mockResolvedValue({ id: 'new' }) };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await expect(cmd(
      ['create'],
      mockApi,
      {},
      { name: 'Short Secret', type: 'sm-token-flows', chains: 'ethereum', webhook: 'https://example.com/hook', "webhook-secret": 'short', 'inflow-1h-min': 1000000 },
    )).rejects.toThrow('--webhook-secret must be at least 16 characters');
    expect(mockApi.alertsCreate).not.toHaveBeenCalled();
  });

  it('should reject --webhook-secret when --webhook is not provided', async () => {
    const mockApi = { alertsCreate: vi.fn().mockResolvedValue({ id: 'new' }) };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await expect(cmd(
      ['create'],
      mockApi,
      {},
      { name: 'Secret No Webhook', type: 'sm-token-flows', chains: 'ethereum', telegram: '123456', "webhook-secret": 'mysupersecretkey123', 'inflow-1h-min': 1000000 },
    )).rejects.toThrow('--webhook-secret requires --webhook');
    expect(mockApi.alertsCreate).not.toHaveBeenCalled();
  });

  it('should reject --webhook-secret without --webhook on update', async () => {
    const mockApi = {
      alertsGet: vi.fn().mockResolvedValue({ type: 'sm-token-flows', data: { chains: ['ethereum'], inflow_1h: { min: 1000000 }, inflow_1d: {}, inflow_7d: {}, outflow_1h: {}, outflow_1d: {}, outflow_7d: {}, netflow_1h: {}, netflow_1d: {}, netflow_7d: {}, inclusion: {}, exclusion: {}, events: ['sm-token-flows'] } }),
      alertsUpdate: vi.fn().mockResolvedValue({ id: 'abc123' }),
    };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await expect(cmd(
      ['update', 'abc123'],
      mockApi,
      {},
      { telegram: '123456', "webhook-secret": 'mysupersecretkey123' },
    )).rejects.toThrow('--webhook-secret requires --webhook');
    expect(mockApi.alertsUpdate).not.toHaveBeenCalled();
  });

  it('should rewrite API error for webhook channel index 0', async () => {
    const { NansenError, ErrorCode } = await import('../api.js');
    const mockApi = {
      alertsCreate: vi.fn().mockRejectedValue(
        new NansenError('Failed to send a welcome message to the channel index 0', ErrorCode.INVALID_PARAMS),
      ),
    };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    let err;
    try {
      await cmd(
        ['create'],
        mockApi,
        {},
        { name: 'Test', type: 'sm-token-flows', chains: 'ethereum', webhook: 'https://example.com/hook', 'inflow-1h-min': 1000000 },
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.message).toContain('https://example.com/hook');
    expect(err.message).toContain('2xx');
  });
});

describe('alerts update — type inference', () => {
  it('should call alertsGet to infer type when type-specific flags used without --type', async () => {
    const mockApi = {
      alertsGet: vi.fn().mockResolvedValue({ type: 'sm-token-flows' }),
      alertsUpdate: vi.fn().mockResolvedValue({ id: 'abc123' }),
    };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await cmd(['update', 'abc123'], mockApi, {}, { 'inflow-1h-min': 500000 });
    expect(mockApi.alertsGet).toHaveBeenCalledWith('abc123');
    expect(mockApi.alertsUpdate).toHaveBeenCalledWith(expect.objectContaining({
      id: 'abc123',
      type: 'sm-token-flows',
      timeWindow: '1h',
    }));
  });

  it('should reject --type that differs from existing alert type', async () => {
    const mockApi = {
      alertsGet: vi.fn().mockResolvedValue({ type: 'common-token-transfer' }),
      alertsUpdate: vi.fn(),
    };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await expect(cmd(['update', 'abc123'], mockApi, {}, { type: 'sm-token-flows', 'inflow-1h-min': 500000 }))
      .rejects.toThrow('Cannot change alert type');
    expect(mockApi.alertsUpdate).not.toHaveBeenCalled();
  });

  it('should allow --type that matches existing alert type', async () => {
    const mockApi = {
      alertsGet: vi.fn().mockResolvedValue({ type: 'sm-token-flows', data: { chains: ['ethereum'] } }),
      alertsUpdate: vi.fn().mockResolvedValue({ id: 'abc123' }),
    };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await cmd(['update', 'abc123'], mockApi, {}, { type: 'sm-token-flows', 'inflow-1h-min': 500000 });
    expect(mockApi.alertsUpdate).toHaveBeenCalledWith(expect.objectContaining({ type: 'sm-token-flows' }));
  });

  it('should always call alertsGet even for simple field updates like rename', async () => {
    const mockApi = {
      alertsGet: vi.fn().mockResolvedValue({ type: 'sm-token-flows', data: { chains: ['ethereum'], inflow_1h: { min: 1000 } } }),
      alertsUpdate: vi.fn().mockResolvedValue({ id: 'abc123' }),
    };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await cmd(['update', 'abc123'], mockApi, {}, { name: 'New Name' });
    expect(mockApi.alertsGet).toHaveBeenCalledWith('abc123');
    expect(mockApi.alertsUpdate).toHaveBeenCalledWith(expect.objectContaining({ name: 'New Name' }));
  });

  it('should infer type from nested data field if top-level type is absent', async () => {
    const mockApi = {
      alertsGet: vi.fn().mockResolvedValue({ data: { type: 'common-token-transfer', subjects: [{ type: 'label', value: 'SM' }] } }),
      alertsUpdate: vi.fn().mockResolvedValue({ id: 'abc123' }),
    };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await cmd(['update', 'abc123'], mockApi, {}, { 'usd-min': 1000 });
    expect(mockApi.alertsUpdate).toHaveBeenCalledWith(expect.objectContaining({
      type: 'common-token-transfer',
      timeWindow: 'realtime',
    }));
  });

  it('should throw if --id is missing', async () => {
    const mockApi = { alertsGet: vi.fn(), alertsUpdate: vi.fn() };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await expect(cmd(['update'], mockApi, {}, {})).rejects.toThrow('Required: <id>');
  });

  it('should throw if alert is not found', async () => {
    const mockApi = { alertsGet: vi.fn().mockResolvedValue(null), alertsUpdate: vi.fn() };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await expect(cmd(['update', 'nonexistent'], mockApi, {}, { name: 'X' })).rejects.toThrow('Alert not found');
    expect(mockApi.alertsUpdate).not.toHaveBeenCalled();
  });

  it('should merge inclusion/exclusion so adding --token does not drop tokenSectors', async () => {
    const mockApi = {
      alertsGet: vi.fn().mockResolvedValue({
        type: 'sm-token-flows',
        data: {
          chains: ['ethereum'],
          inflow_1h: { min: 1000, max: 50000 },
          inclusion: { tokens: [{ address: '0xA', chain: 'ethereum' }], tokenSectors: ['DeFi'] },
        },
      }),
      alertsUpdate: vi.fn().mockResolvedValue({ id: 'abc123' }),
    };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await cmd(['update', 'abc123'], mockApi, {}, { token: '0xB:ethereum' });
    const sentData = mockApi.alertsUpdate.mock.calls[0][0].data;
    // New token replaces the tokens array
    expect(sentData.inclusion.tokens).toEqual([{ address: '0xB', chain: 'ethereum' }]);
    // But tokenSectors from existing data is preserved
    expect(sentData.inclusion.tokenSectors).toEqual(['DeFi']);
    // Top-level fields also preserved
    expect(sentData.chains).toEqual(['ethereum']);
  });

  it('should deep-merge range fields so updating only min preserves existing max', async () => {
    const mockApi = {
      alertsGet: vi.fn().mockResolvedValue({
        type: 'sm-token-flows',
        data: {
          chains: ['ethereum'],
          inflow_1h: { min: 1000000, max: 50000000 },
          outflow_1d: { min: 500, max: 10000 },
          inclusion: {},
          exclusion: {},
        },
      }),
      alertsUpdate: vi.fn().mockResolvedValue({ id: 'abc123' }),
    };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await cmd(['update', 'abc123'], mockApi, {}, { 'inflow-1h-min': '2000000' });
    const sentData = mockApi.alertsUpdate.mock.calls[0][0].data;
    expect(sentData.inflow_1h).toEqual({ min: 2000000, max: 50000000 });
    expect(sentData.outflow_1d).toEqual({ min: 500, max: 10000 });
  });

  it('should deep-merge range fields for common-token-transfer usdValue', async () => {
    const mockApi = {
      alertsGet: vi.fn().mockResolvedValue({
        type: 'common-token-transfer',
        data: {
          chains: ['ethereum'],
          usdValue: { min: 100, max: 999999 },
          tokenAmount: { min: 10, max: 500 },
          subjects: [{ type: 'label', value: 'smart_money' }],
          inclusion: {},
          exclusion: {},
        },
      }),
      alertsUpdate: vi.fn().mockResolvedValue({ id: 'abc123' }),
    };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await cmd(['update', 'abc123'], mockApi, {}, { 'usd-max': '5000000' });
    const sentData = mockApi.alertsUpdate.mock.calls[0][0].data;
    expect(sentData.usdValue).toEqual({ min: 100, max: 5000000 });
    expect(sentData.tokenAmount).toEqual({ min: 10, max: 500 });
  });

  it('should deep-merge inclusion-nested marketCap range on sm-token-flows', async () => {
    const mockApi = {
      alertsGet: vi.fn().mockResolvedValue({
        type: 'sm-token-flows',
        data: {
          chains: ['ethereum'],
          inflow_1h: { min: 1000, max: 50000 },
          inclusion: { marketCap: { min: 1000000, max: 10000000 }, tokens: [{ address: '0xabc', chain: 'ethereum' }] },
          exclusion: {},
        },
      }),
      alertsUpdate: vi.fn().mockResolvedValue({ id: 'abc123' }),
    };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await cmd(['update', 'abc123'], mockApi, {}, { 'market-cap-min': '5000000' });
    const sentData = mockApi.alertsUpdate.mock.calls[0][0].data;
    // marketCap.max must survive even though only min was updated
    expect(sentData.inclusion.marketCap).toEqual({ min: 5000000, max: 10000000 });
    // sibling inclusion keys preserved
    expect(sentData.inclusion.tokens).toEqual([{ address: '0xabc', chain: 'ethereum' }]);
    // top-level range untouched
    expect(sentData.inflow_1h).toEqual({ min: 1000, max: 50000 });
  });

  it('should deep-merge inclusion-nested fdvUsd range on sm-token-flows', async () => {
    const mockApi = {
      alertsGet: vi.fn().mockResolvedValue({
        type: 'sm-token-flows',
        data: {
          chains: ['base'],
          inflow_1h: { min: 1000, max: 50000 },
          inclusion: { fdvUsd: { min: 500000, max: 2000000 } },
          exclusion: {},
        },
      }),
      alertsUpdate: vi.fn().mockResolvedValue({ id: 'abc123' }),
    };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await cmd(['update', 'abc123'], mockApi, {}, { 'fdv-max': '9000000' });
    const sentData = mockApi.alertsUpdate.mock.calls[0][0].data;
    expect(sentData.inclusion.fdvUsd).toEqual({ min: 500000, max: 9000000 });
  });

  it('should apply --data as post-merge override (named flags preserved)', async () => {
    const mockApi = {
      alertsGet: vi.fn().mockResolvedValue({
        type: 'sm-token-flows',
        data: {
          chains: ['ethereum'],
          inflow_1h: { min: 1000, max: 50000 },
          inclusion: {},
          exclusion: {},
        },
      }),
      alertsUpdate: vi.fn().mockResolvedValue({ id: 'abc123' }),
    };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    // Named flag sets min, --data sets max on the same range
    await cmd(['update', 'abc123'], mockApi, {}, {
      'inflow-1h-min': '2000',
      data: '{"inflow_1h":{"max":99999}}',
    });
    const sentData = mockApi.alertsUpdate.mock.calls[0][0].data;
    // Both named flag and --data compose correctly
    expect(sentData.inflow_1h).toEqual({ min: 2000, max: 99999 });
  });

  it('should apply --data after merge so it can clear a range bound with null', async () => {
    const mockApi = {
      alertsGet: vi.fn().mockResolvedValue({
        type: 'sm-token-flows',
        data: {
          chains: ['ethereum'],
          inflow_1h: { min: 1000, max: 50000 },
          inclusion: {},
          exclusion: {},
        },
      }),
      alertsUpdate: vi.fn().mockResolvedValue({ id: 'abc123' }),
    };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await cmd(['update', 'abc123'], mockApi, {}, {
      data: '{"inflow_1h":{"max":null}}',
    });
    const sentData = mockApi.alertsUpdate.mock.calls[0][0].data;
    expect(sentData.inflow_1h).toEqual({ min: 1000, max: null });
  });

  it('should let --data add fields to inclusion without losing named-flag tokens', async () => {
    const mockApi = {
      alertsGet: vi.fn().mockResolvedValue({
        type: 'sm-token-flows',
        data: {
          chains: ['ethereum'],
          inflow_1h: { min: 1000, max: 50000 },
          inclusion: { tokens: [{ address: '0xold', chain: 'ethereum' }] },
          exclusion: {},
        },
      }),
      alertsUpdate: vi.fn().mockResolvedValue({ id: 'abc123' }),
    };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await cmd(['update', 'abc123'], mockApi, {}, {
      token: '0xnew:base',
      data: '{"inclusion":{"marketCap":{"min":5000}}}',
    });
    const sentData = mockApi.alertsUpdate.mock.calls[0][0].data;
    // Named flag replaces tokens, --data adds marketCap, both coexist
    expect(sentData.inclusion.tokens).toEqual([{ address: '0xnew', chain: 'base' }]);
    expect(sentData.inclusion.marketCap).toEqual({ min: 5000 });
  });

  it('should replace arrays entirely on update (not merge elements)', async () => {
    const mockApi = {
      alertsGet: vi.fn().mockResolvedValue({
        type: 'common-token-transfer',
        data: {
          chains: ['ethereum', 'base'],
          subjects: [{ type: 'label', value: 'old' }],
          usdValue: {},
          inclusion: {},
          exclusion: {},
        },
      }),
      alertsUpdate: vi.fn().mockResolvedValue({ id: 'abc123' }),
    };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await cmd(['update', 'abc123'], mockApi, {}, {
      chains: 'solana',
      subject: 'address:0xabc',
    });
    const sentData = mockApi.alertsUpdate.mock.calls[0][0].data;
    expect(sentData.chains).toEqual(['solana']);
    expect(sentData.subjects).toEqual([{ type: 'address', value: '0xabc' }]);
  });

  it('should preserve fields the user does not mention', async () => {
    const mockApi = {
      alertsGet: vi.fn().mockResolvedValue({
        type: 'sm-token-flows',
        data: {
          chains: ['ethereum'],
          inflow_1h: { min: 1000, max: 50000 },
          outflow_7d: { min: 100, max: 999 },
          inclusion: { tokenSectors: ['defi'] },
          exclusion: { tokens: [{ address: '0xskip', chain: 'base' }] },
          unknownFutureField: 'preserved',
        },
      }),
      alertsUpdate: vi.fn().mockResolvedValue({ id: 'abc123' }),
    };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await cmd(['update', 'abc123'], mockApi, {}, { 'inflow-1h-min': '2000' });
    const sentData = mockApi.alertsUpdate.mock.calls[0][0].data;
    expect(sentData.inflow_1h).toEqual({ min: 2000, max: 50000 });
    expect(sentData.outflow_7d).toEqual({ min: 100, max: 999 });
    expect(sentData.inclusion.tokenSectors).toEqual(['defi']);
    expect(sentData.exclusion.tokens).toEqual([{ address: '0xskip', chain: 'base' }]);
    expect(sentData.unknownFutureField).toBe('preserved');
  });

  it('should throw on invalid --data JSON during update', async () => {
    const mockApi = {
      alertsGet: vi.fn().mockResolvedValue({
        type: 'sm-token-flows',
        data: { chains: [] },
      }),
      alertsUpdate: vi.fn(),
    };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await expect(cmd(['update', 'abc123'], mockApi, {}, { data: 'not-json' }))
      .rejects.toThrow('--data must be valid JSON');
  });

  it('should apply --data only via update handler when no named flags provided', async () => {
    const mockApi = {
      alertsGet: vi.fn().mockResolvedValue({
        type: 'sm-token-flows',
        data: {
          chains: ['ethereum'],
          inflow_1h: { min: 1000, max: 50000 },
        },
      }),
      alertsUpdate: vi.fn().mockResolvedValue({ id: 'abc123' }),
    };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await cmd(['update', 'abc123'], mockApi, {}, {
      data: '{"chains":["base","solana"]}',
    });
    const sentData = mockApi.alertsUpdate.mock.calls[0][0].data;
    expect(sentData.chains).toEqual(['base', 'solana']);
    expect(sentData.inflow_1h).toEqual({ min: 1000, max: 50000 });
  });

  // ── smart-contract-call update edge cases ──

  it('should deep-merge usdValue range on smart-contract-call', async () => {
    const mockApi = {
      alertsGet: vi.fn().mockResolvedValue({
        type: 'smart-contract-call',
        data: {
          chains: ['ethereum'],
          usdValue: { min: 5000, max: 100000 },
          signatureHash: ['0xa9059cbb'],
          inclusion: { caller: [{ type: 'label', value: 'SM' }], smartContract: [] },
          exclusion: { caller: [], smartContract: [] },
        },
      }),
      alertsUpdate: vi.fn().mockResolvedValue({ id: 'abc123' }),
    };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await cmd(['update', 'abc123'], mockApi, {}, { 'usd-min': '25000' });
    const sentData = mockApi.alertsUpdate.mock.calls[0][0].data;
    expect(sentData.usdValue).toEqual({ min: 25000, max: 100000 });
    expect(sentData.signatureHash).toEqual(['0xa9059cbb']);
  });

  it('should replace signatureHash array on smart-contract-call without dropping other fields', async () => {
    const mockApi = {
      alertsGet: vi.fn().mockResolvedValue({
        type: 'smart-contract-call',
        data: {
          chains: ['ethereum'],
          usdValue: { min: 5000, max: 100000 },
          signatureHash: ['0xa9059cbb', '0x23b872dd'],
          inclusion: { caller: [{ type: 'label', value: 'SM' }], smartContract: [] },
          exclusion: { caller: [], smartContract: [] },
        },
      }),
      alertsUpdate: vi.fn().mockResolvedValue({ id: 'abc123' }),
    };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await cmd(['update', 'abc123'], mockApi, {}, { 'signature-hash': '0xffffffff' });
    const sentData = mockApi.alertsUpdate.mock.calls[0][0].data;
    expect(sentData.signatureHash).toEqual(['0xffffffff']);
    expect(sentData.usdValue).toEqual({ min: 5000, max: 100000 });
    expect(sentData.inclusion.caller).toEqual([{ type: 'label', value: 'SM' }]);
  });

  it('should preserve smartContract when updating caller on smart-contract-call', async () => {
    const mockApi = {
      alertsGet: vi.fn().mockResolvedValue({
        type: 'smart-contract-call',
        data: {
          chains: ['ethereum'],
          usdValue: {},
          inclusion: { caller: [{ type: 'label', value: 'old' }], smartContract: [{ type: 'address', value: '0xdead' }] },
          exclusion: { caller: [], smartContract: [] },
        },
      }),
      alertsUpdate: vi.fn().mockResolvedValue({ id: 'abc123' }),
    };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await cmd(['update', 'abc123'], mockApi, {}, { caller: 'entity:Binance' });
    const sentData = mockApi.alertsUpdate.mock.calls[0][0].data;
    expect(sentData.inclusion.caller).toEqual([{ type: 'entity', value: 'Binance' }]);
    expect(sentData.inclusion.smartContract).toEqual([{ type: 'address', value: '0xdead' }]);
  });

  // ── common-token-transfer update edge cases ──

  it('should deep-merge inclusion-nested marketCap range on common-token-transfer', async () => {
    const mockApi = {
      alertsGet: vi.fn().mockResolvedValue({
        type: 'common-token-transfer',
        data: {
          chains: ['ethereum'],
          usdValue: { min: 100, max: 999999 },
          subjects: [{ type: 'label', value: 'SM' }],
          inclusion: { marketCap: { min: 50000, max: 5000000 } },
          exclusion: {},
        },
      }),
      alertsUpdate: vi.fn().mockResolvedValue({ id: 'abc123' }),
    };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await cmd(['update', 'abc123'], mockApi, {}, { 'market-cap-max': '20000000' });
    const sentData = mockApi.alertsUpdate.mock.calls[0][0].data;
    expect(sentData.inclusion.marketCap).toEqual({ min: 50000, max: 20000000 });
    expect(sentData.usdValue).toEqual({ min: 100, max: 999999 });
    expect(sentData.subjects).toEqual([{ type: 'label', value: 'SM' }]);
  });

  // ── cross-type edge cases ──

  it('should handle existing null range bounds correctly', async () => {
    const mockApi = {
      alertsGet: vi.fn().mockResolvedValue({
        type: 'common-token-transfer',
        data: {
          chains: ['ethereum'],
          usdValue: { min: null, max: 999999 },
          tokenAmount: { min: null, max: null },
          subjects: [{ type: 'label', value: 'SM' }],
          inclusion: {},
          exclusion: {},
        },
      }),
      alertsUpdate: vi.fn().mockResolvedValue({ id: 'abc123' }),
    };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await cmd(['update', 'abc123'], mockApi, {}, { 'usd-min': '5000' });
    const sentData = mockApi.alertsUpdate.mock.calls[0][0].data;
    expect(sentData.usdValue).toEqual({ min: 5000, max: 999999 });
    expect(sentData.tokenAmount).toEqual({ min: null, max: null });
  });

  it('should clear entire sub-object via --data null', async () => {
    const mockApi = {
      alertsGet: vi.fn().mockResolvedValue({
        type: 'sm-token-flows',
        data: {
          chains: ['ethereum'],
          inflow_1h: { min: 1000, max: 50000 },
          inclusion: { marketCap: { min: 100, max: 999 }, tokenSectors: ['defi'] },
          exclusion: { tokens: [{ address: '0xskip', chain: 'base' }] },
        },
      }),
      alertsUpdate: vi.fn().mockResolvedValue({ id: 'abc123' }),
    };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await cmd(['update', 'abc123'], mockApi, {}, { data: '{"inclusion":null}' });
    const sentData = mockApi.alertsUpdate.mock.calls[0][0].data;
    expect(sentData.inclusion).toBeNull();
    expect(sentData.inflow_1h).toEqual({ min: 1000, max: 50000 });
    expect(sentData.exclusion).toEqual({ tokens: [{ address: '0xskip', chain: 'base' }] });
  });

  it('should deep-merge --data + named flags on common-token-transfer', async () => {
    const mockApi = {
      alertsGet: vi.fn().mockResolvedValue({
        type: 'common-token-transfer',
        data: {
          chains: ['ethereum'],
          usdValue: { min: 100, max: 999999 },
          tokenAmount: { min: 10, max: 500 },
          subjects: [{ type: 'label', value: 'SM' }],
          inclusion: {},
          exclusion: {},
        },
      }),
      alertsUpdate: vi.fn().mockResolvedValue({ id: 'abc123' }),
    };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await cmd(['update', 'abc123'], mockApi, {}, {
      'token-amount-min': '50',
      data: '{"tokenAmount":{"max":2000}}',
    });
    const sentData = mockApi.alertsUpdate.mock.calls[0][0].data;
    expect(sentData.tokenAmount).toEqual({ min: 50, max: 2000 });
    expect(sentData.usdValue).toEqual({ min: 100, max: 999999 });
  });

  it('should deep-merge --data + named flags on smart-contract-call', async () => {
    const mockApi = {
      alertsGet: vi.fn().mockResolvedValue({
        type: 'smart-contract-call',
        data: {
          chains: ['ethereum'],
          usdValue: { min: 5000, max: 100000 },
          signatureHash: ['0xa9059cbb'],
          inclusion: { caller: [], smartContract: [] },
          exclusion: { caller: [], smartContract: [] },
        },
      }),
      alertsUpdate: vi.fn().mockResolvedValue({ id: 'abc123' }),
    };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await cmd(['update', 'abc123'], mockApi, {}, {
      'usd-min': '10000',
      data: '{"usdValue":{"max":null}}',
    });
    const sentData = mockApi.alertsUpdate.mock.calls[0][0].data;
    expect(sentData.usdValue).toEqual({ min: 10000, max: null });
    expect(sentData.signatureHash).toEqual(['0xa9059cbb']);
  });

  it('should clear range bound with null on common-token-transfer', async () => {
    const mockApi = {
      alertsGet: vi.fn().mockResolvedValue({
        type: 'common-token-transfer',
        data: {
          chains: ['ethereum'],
          usdValue: { min: 1000, max: 500000 },
          subjects: [{ type: 'label', value: 'SM' }],
          inclusion: {},
          exclusion: {},
        },
      }),
      alertsUpdate: vi.fn().mockResolvedValue({ id: 'abc123' }),
    };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await cmd(['update', 'abc123'], mockApi, {}, { data: '{"usdValue":{"min":null}}' });
    const sentData = mockApi.alertsUpdate.mock.calls[0][0].data;
    expect(sentData.usdValue).toEqual({ min: null, max: 500000 });
  });
});

describe('alerts create — --data as post-merge override', () => {
  it('should deep-merge --data on top of named flags and defaults', async () => {
    const mockApi = { alertsCreate: vi.fn().mockResolvedValue({ id: 'new' }) };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await cmd(['create'], mockApi, {}, {
      name: 'Test',
      type: 'sm-token-flows',
      chains: 'ethereum',
      telegram: '123',
      'inflow-1h-min': '1000',
      data: '{"inflow_1h":{"max":9999},"events":["custom"]}',
    });
    const sentData = mockApi.alertsCreate.mock.calls[0][0].data;
    expect(sentData.inflow_1h).toEqual({ min: 1000, max: 9999 });
    expect(sentData.events).toEqual(['custom']);
    // Defaults for unset fields still present
    expect(sentData.outflow_1d).toEqual({});
  });

  it('should throw on invalid --data JSON during create', async () => {
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await expect(cmd(['create'], {}, {}, {
      name: 'Test',
      type: 'sm-token-flows',
      chains: 'ethereum',
      telegram: '123',
      data: '{bad}',
    })).rejects.toThrow('--data must be valid JSON');
  });

  it('should accept --data as object (not string) during create', async () => {
    const mockApi = { alertsCreate: vi.fn().mockResolvedValue({ id: 'new' }) };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await cmd(['create'], mockApi, {}, {
      name: 'Test',
      type: 'sm-token-flows',
      chains: 'ethereum',
      telegram: '123',
      'inflow-1h-min': '1000',
      data: { chains: ['solana'] },
    });
    const sentData = mockApi.alertsCreate.mock.calls[0][0].data;
    expect(sentData.chains).toEqual(['solana']);
  });
});

describe('parseArgs repeatable flags', () => {
  it('should accumulate repeated options into arrays', () => {
    const result = parseArgs(['--token', '0xabc:ethereum', '--token', '0xdef:base']);
    expect(result.options.token).toEqual(['0xabc:ethereum', '0xdef:base']);
  });

  it('should keep single option as string', () => {
    const result = parseArgs(['--token', '0xabc:ethereum']);
    expect(result.options.token).toBe('0xabc:ethereum');
  });
});

describe('parseArgs negative numbers', () => {
  it('should treat negative numbers as option values, not flags', () => {
    const result = parseArgs(['--telegram', '-4583755198']);
    expect(result.options.telegram).toBe('-4583755198');
    expect(result.flags).toEqual({});
  });

  it('should still treat non-numeric dashes as flags', () => {
    const result = parseArgs(['--verbose', '-v']);
    expect(result.flags.verbose).toBe(true);
    expect(result.flags.v).toBe(true);
  });
});

describe('formatOutput', () => {
  it('should return compact JSON by default', () => {
    const result = formatOutput({ a: 1 });
    expect(result.type).toBe('json');
    expect(result.text).toBe('{"a":1}');
  });

  it('should return pretty JSON when pretty=true', () => {
    const result = formatOutput({ a: 1 }, { pretty: true });
    expect(result.type).toBe('json');
    expect(result.text).toContain('\n');
  });

  it('should return table when table=true', () => {
    const result = formatOutput({ data: [{ x: 1 }] }, { table: true });
    expect(result.type).toBe('table');
  });

  it('should return error text for failed response in table mode', () => {
    const result = formatOutput({ success: false, error: 'Oops' }, { table: true });
    expect(result.type).toBe('error');
    expect(result.text).toBe('Error: Oops');
  });

  it('should keep code, status and details as key/value lines in table mode', () => {
    const envelope = formatError(new NansenError('Rate limited', ErrorCode.RATE_LIMITED, 429, { rateLimit: { resetSeconds: 30 } }));
    const result = formatOutput(envelope, { table: true });
    expect(result.type).toBe('error');
    expect(result.text.split('\n')).toEqual([
      'Error: Rate limited',
      'code: RATE_LIMITED',
      'status: 429',
      'details: {"rateLimit":{"resetSeconds":30}}',
    ]);
  });

  it('should omit null fields from table error output', () => {
    const envelope = formatError(new NansenError('Bad input', ErrorCode.INVALID_PARAMS));
    const result = formatOutput(envelope, { table: true });
    expect(result.text).toBe('Error: Bad input\ncode: INVALID_PARAMS');
  });

  it('should render the error envelope as a CSV header and row in csv mode', () => {
    const envelope = formatError(new NansenError('Rate limited', ErrorCode.RATE_LIMITED, 429, { rateLimit: { resetSeconds: 30 } }));
    const result = formatOutput(envelope, { csv: true });
    expect(result.type).toBe('error');
    expect(result.text.split('\n')).toEqual([
      'success,error,code,status,details',
      'false,Rate limited,RATE_LIMITED,429,"{""rateLimit"":{""resetSeconds"":30}}"',
    ]);
  });
});

describe('formatError', () => {
  it('should format error object', () => {
    const error = new Error('Test error');
    error.code = 'TEST_CODE';
    error.status = 500;
    error.details = { detail: 'extra info' };
    
    const result = formatError(error);
    expect(result).toEqual({
      success: false,
      error: 'Test error',
      code: 'TEST_CODE',
      status: 500,
      details: { detail: 'extra info' }
    });
  });

  it('should use defaults for missing fields', () => {
    const error = new Error('Simple error');
    const result = formatError(error);
    expect(result.code).toBe('UNKNOWN');
    expect(result.status).toBeNull();
    expect(result).not.toHaveProperty('details');
  });

  it('should surface .details from trading-style errors (NO_QUOTES with warnings)', () => {
    const error = Object.assign(new Error('No quotes available'), {
      code: 'NO_QUOTES',
      status: 404,
      details: { warnings: ['Low liquidity', 'Slippage too high'] }
    });
    const result = formatError(error);
    expect(result.success).toBe(false);
    expect(result.error).toBe('No quotes available');
    expect(result.code).toBe('NO_QUOTES');
    expect(result.details).toEqual({ warnings: ['Low liquidity', 'Slippage too high'] });
  });

  it('should surface .details from NansenError (which stores as .details)', () => {
    const error = new NansenError('Rate limited', ErrorCode.RATE_LIMITED, 429, { retry_after: 60 });
    const result = formatError(error);
    expect(result.success).toBe(false);
    expect(result.code).toBe('RATE_LIMITED');
    expect(result.details).toEqual({ retry_after: 60 });
  });

  it('should omit details when null', () => {
    const error = Object.assign(new Error('fail'), { code: 'ERR', details: null });
    const result = formatError(error);
    expect(result).not.toHaveProperty('details');
  });

  it('should omit details when undefined', () => {
    const error = Object.assign(new Error('fail'), { code: 'ERR' });
    const result = formatError(error);
    expect(result).not.toHaveProperty('details');
  });

  it('should omit details when empty object', () => {
    const error = Object.assign(new Error('fail'), { code: 'ERR', details: {} });
    const result = formatError(error);
    expect(result).not.toHaveProperty('details');
  });

  it('hoists requestId to the top level so it survives details pruning', () => {
    const error = new NansenError('Server error', 'SERVER_ERROR', 500, {
      requestId: 'req-deadbeef',
      attempt: 1,
    });
    const result = formatError(error);
    expect(result.requestId).toBe('req-deadbeef');
    expect(result.details.requestId).toBe('req-deadbeef');
  });

  it('omits top-level requestId when the error carries none', () => {
    const error = new NansenError('Server error', 'SERVER_ERROR', 500, { attempt: 1 });
    const result = formatError(error);
    expect(result).not.toHaveProperty('requestId');
  });

  it('should fall back to .data if .details is not set (backward compat)', () => {
    const error = new Error('legacy error');
    error.code = 'LEGACY';
    error.data = { info: 'from data property' };
    const result = formatError(error);
    expect(result.details).toEqual({ info: 'from data property' });
  });
});

describe('parseObjectOption', () => {
  it('returns an empty object when the option is absent or blank', () => {
    expect(parseObjectOption(undefined, 'filters')).toEqual({});
    expect(parseObjectOption('', 'filters')).toEqual({});
  });

  it('passes a plain object through', () => {
    const filters = { chain: 'solana', min_usd: 100 };
    expect(parseObjectOption(filters, 'filters')).toBe(filters);
  });

  it('rejects arrays, primitives, null and repeated values with INVALID_PARAMS', () => {
    for (const bad of [[], [{ a: 1 }, { b: 2 }], 'abc', 'true', 42, null]) {
      let error;
      try { parseObjectOption(bad, 'filters'); } catch (e) { error = e; }
      expect(error).toBeInstanceOf(NansenError);
      expect(error.code).toBe(ErrorCode.INVALID_PARAMS);
      expect(error.message).toContain('--filters must be a JSON object');
    }
  });
});

describe('--filters reaches handlers only as an object', () => {
  const commands = buildCommands({});
  const cases = [
    ['smart-money', ['netflow'], 'smartMoneyNetflow', { chain: 'solana' }],
    ['profiler', ['transactions'], 'addressTransactions', { address: '0x0000000000000000000000000000000000000001', chain: 'ethereum' }],
    ['token', ['screener'], 'tokenScreener', { chain: 'solana' }],
  ];

  for (const [group, args, method, base] of cases) {
    it(`${group} ${args[0]} rejects --filters '[]' before calling the API`, async () => {
      const mockApi = { [method]: vi.fn().mockResolvedValue({ data: [] }) };
      await expect(commands[group](args, mockApi, {}, { ...base, filters: [] }))
        .rejects.toMatchObject({ code: ErrorCode.INVALID_PARAMS });
      expect(mockApi[method]).not.toHaveBeenCalled();
    });

    it(`${group} ${args[0]} still forwards an object --filters`, async () => {
      const mockApi = { [method]: vi.fn().mockResolvedValue({ data: [] }) };
      await commands[group](args, mockApi, {}, { ...base, filters: { min_usd: 1 } });
      expect(mockApi[method]).toHaveBeenCalledWith(expect.objectContaining({ filters: { min_usd: 1 } }));
    });
  }
});

describe('parseCsvOption', () => {
  it('splits a single comma-separated value', () => {
    expect(parseCsvOption('defi, nft ,,sports', 'tags')).toEqual(['defi', 'nft', 'sports']);
  });

  it('flattens a repeated flag whose values are themselves comma-separated', () => {
    const { options } = parseArgs(['--tags', 'defi,nft', '--tags', 'sports']);
    expect(options.tags).toEqual(['defi,nft', 'sports']);
    expect(parseCsvOption(options.tags, 'tags')).toEqual(['defi', 'nft', 'sports']);
  });

  it('keeps repeated single values and trims them', () => {
    expect(parseCsvOption([' defi ', 'nft', ''], 'tags')).toEqual(['defi', 'nft']);
  });

  it('still rejects non-string values', () => {
    expect(() => parseCsvOption(['defi', 1], 'tags')).toThrow('--tags values must be strings');
    expect(() => parseCsvOption({ a: 1 }, 'tags')).toThrow('--tags must be a string');
  });
});

describe('parseSort', () => {
  it('should return undefined when no sort option', () => {
    expect(parseSort(undefined, undefined)).toBeUndefined();
  });

  it('should prefer orderBy when provided', () => {
    const orderBy = [{ field: 'price', direction: 'ASC' }];
    const result = parseSort('value:desc', orderBy);
    expect(result).toBe(orderBy);
  });

  it('should parse field:direction format', () => {
    const result = parseSort('value_usd:asc', undefined);
    expect(result).toEqual([{ field: 'value_usd', direction: 'ASC' }]);
  });

  it('should default to DESC when direction not specified', () => {
    const result = parseSort('timestamp', undefined);
    expect(result).toEqual([{ field: 'timestamp', direction: 'DESC' }]);
  });

  it('should treat the words true/false/null as literal field names', () => {
    expect(parseSort('true', undefined)).toEqual([{ field: 'true', direction: 'DESC' }]);
    expect(parseSort('false', undefined)).toEqual([{ field: 'false', direction: 'DESC' }]);
    expect(parseSort('null:asc', undefined)).toEqual([{ field: 'null', direction: 'ASC' }]);
  });

  it('should reject a non-string value with an actionable error instead of a TypeError', () => {
    for (const bad of [true, ['a', 'b'], { field: 'x' }]) {
      let error;
      try { parseSort(bad, undefined); } catch (e) { error = e; }
      expect(error).toBeInstanceOf(NansenError);
      expect(error.code).toBe(ErrorCode.INVALID_PARAMS);
      expect(error.message).toBe('--sort must be "field" or "field:direction"');
    }
  });
});

describe('HELP', () => {
  it('should contain usage information', () => {
    expect(HELP).toContain('USAGE:');
    expect(HELP).toContain('COMMANDS:');
    expect(HELP).toContain('EXAMPLES:');
  });

  it('should list top-level commands in help text', () => {
    expect(HELP).toContain('research');
    expect(HELP).toContain('trade');
    expect(HELP).toContain('wallet');
    expect(HELP).toContain('schema');
    expect(HELP).toContain('account');
    expect(HELP).toContain('login');
    expect(HELP).toContain('logout');
  });

  it('should surface trading capabilities in top-level help text', () => {
    expect(HELP).toContain('DEX swaps/bridges');
    expect(HELP).toContain('bridge-status');
    expect(HELP).toContain('limit-order');
    expect(HELP).toContain('nansen trade execute --quote <quoteId>');
    expect(HELP).toContain('nansen trade limit-order create');
    expect(HELP).toContain('nansen trade limit-order create --from SOL --to USDC --amount 1.5 --trigger-mint SOL --trigger-condition below --trigger-price 80');
    expect(HELP.indexOf('trade')).toBeLessThan(HELP.indexOf('research'));
  });
});

describe('prompt', () => {
  it('keeps hidden input masked when stdout is redirected', async () => {
    let onData;
    const input = {
      isTTY: true,
      setRawMode: vi.fn(),
      resume: vi.fn(),
      pause: vi.fn(),
      setEncoding: vi.fn(),
      on: vi.fn((_event, handler) => { onData = handler; }),
      removeListener: vi.fn(),
    };
    const output = { isTTY: false, write: vi.fn() };
    const secret = 'REDIRECTED_OUTPUT_TEST_KEY';

    const result = prompt('Enter key: ', true, { input, output });
    onData(secret);
    onData('\n');

    await expect(result).resolves.toBe(secret);
    expect(input.setRawMode.mock.calls).toEqual([[true], [false]]);
    expect(output.write.mock.calls.flat().join('')).not.toContain(secret);
  });

  it('defaults masked output to stderr, never a redirected stdout', async () => {
    let onData;
    const input = {
      isTTY: true,
      setRawMode: vi.fn(), resume: vi.fn(), pause: vi.fn(), setEncoding: vi.fn(),
      on: vi.fn((_e, h) => { onData = h; }), removeListener: vi.fn(),
    };
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const result = prompt('Enter key: ', true, { input });   // no output → default stderr
      onData('K'); onData('\n');
      await expect(result).resolves.toBe('K');
      // Prompt + mask went to stderr; stdout (which a user may redirect) untouched.
      expect(errSpy.mock.calls.flat().join('')).toContain('*');
      expect(outSpy).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
      outSpy.mockRestore();
    }
  });
});

describe('buildCommands', () => {
  let mockDeps;
  let commands;
  let logs;

  beforeEach(() => {
    logs = [];
    mockDeps = {
      log: (msg) => logs.push(msg),
      exit: vi.fn(),
      promptFn: vi.fn(),
      saveConfigFn: vi.fn(),
      deleteConfigFn: vi.fn(),
      getConfigFileFn: vi.fn(() => '/home/user/.nansen/config.json'),
      NansenAPIClass: vi.fn(),
      isTTY: true,
      env: {}
    };
    commands = buildCommands(mockDeps);
  });

  describe('help command', () => {
    it('should output help text', async () => {
      await commands.help([], null, {}, {});
      expect(logs[0]).toContain('USAGE:');
    });
  });

  describe('logout command', () => {
    it('should report success when config deleted', async () => {
      mockDeps.deleteConfigFn.mockReturnValue(true);
      await commands.logout([], null, {}, {});
      expect(logs).toEqual(['✓ Removed /home/user/.nansen/config.json']);
    });

    it('should report when no config found', async () => {
      mockDeps.deleteConfigFn.mockReturnValue(false);
      await commands.logout([], null, {}, {});
      expect(logs).toEqual(['No saved credentials found']);
    });

    it('should warn when NANSEN_API_KEY remains active', async () => {
      mockDeps.env.NANSEN_API_KEY = 'test-key';
      mockDeps.deleteConfigFn.mockReturnValue(true);

      await commands.logout([], null, {}, {});

      expect(logs).toEqual([
        '✓ Removed /home/user/.nansen/config.json',
        'Warning: NANSEN_API_KEY remains active. Run: unset NANSEN_API_KEY'
      ]);
      expect(mockDeps.NansenAPIClass).not.toHaveBeenCalled();
    });
  });

  describe('login command', () => {
    it('should exit when no API key provided', async () => {
      const savedEnv = process.env.NANSEN_API_KEY;
      delete process.env.NANSEN_API_KEY;
      try {
        await expect(commands.login([], null, {}, {})).rejects.toThrow(/API key/);
      } finally {
        if (savedEnv !== undefined) process.env.NANSEN_API_KEY = savedEnv;
      }
    });

    it('should exit when API key is whitespace', async () => {
      const savedEnv = process.env.NANSEN_API_KEY;
      delete process.env.NANSEN_API_KEY;
      try {
        await expect(commands.login([], null, {}, { 'api-key': '   ' })).rejects.toThrow(/API key/);
      } finally {
        if (savedEnv !== undefined) process.env.NANSEN_API_KEY = savedEnv;
      }
    });

    it('does not relay verification error text', async () => {
      const key = 'VERIFICATION_TEST_KEY';
      const encodedKey = Buffer.from(key).toString('base64');
      const mockApi = { getAccount: vi.fn().mockRejectedValue(
        Object.assign(new Error(`upstream echoed ${key} and ${encodedKey}`), { code: 'SOMETHING_ELSE' })
      ) };
      mockDeps.NansenAPIClass.mockImplementation(function() { return mockApi; });

      const thrown = await commands.login([], null, {}, { 'api-key': key }).catch(e => e);

      expect(thrown.message).toBe('Could not verify API key.');
      expect(thrown.message).not.toContain(key);
      expect(JSON.stringify(thrown.data ?? {})).not.toContain(encodedKey);
    });

    it('restores signal from the structured code without relaying the message', async () => {
      const key = 'RATE_LIMIT_TEST_KEY';
      const mockApi = { getAccount: vi.fn().mockRejectedValue(
        // A transient rate-limit whose message still echoes the key: the branch
        // must key off error.code, never interpolate the message.
        Object.assign(new Error(`429 for ${key}`), { code: ErrorCode.RATE_LIMITED })
      ) };
      mockDeps.NansenAPIClass.mockImplementation(function() { return mockApi; });

      const thrown = await commands.login([], null, {}, { 'api-key': key }).catch(e => e);

      expect(thrown.code).toBe('VERIFICATION_FAILED');
      expect(thrown.message).toMatch(/rate limited/i);
      expect(thrown.message).not.toBe('Could not verify API key.'); // not the misleading generic
      expect(JSON.stringify(thrown.data ?? {})).not.toContain(key);   // no message relay
    });

    it('invalid-key resolution points at the key management view, never agent-setup', async () => {
      const mockApi = { getAccount: vi.fn().mockRejectedValue(
        Object.assign(new Error('unauthorized'), { code: ErrorCode.UNAUTHORIZED })
      ) };
      mockDeps.NansenAPIClass.mockImplementation(function() { return mockApi; });

      let thrown;
      try {
        await commands.login([], null, {}, { 'api-key': 'some-invalid-key' });
      } catch (e) { thrown = e; }
      expect(thrown).toBeDefined();
      const resolution = JSON.stringify(thrown.data?.resolution ?? []);
      expect(resolution).toContain('https://app.nansen.ai/api?tab=api');
      expect(resolution).not.toContain('/auth/agent-setup');
    });

    it('login help warns that literal keys land in shell history', async () => {
      const logs = [];
      const localCommands = buildCommands({ ...mockDeps, log: (m) => logs.push(m) });
      await localCommands.login([], null, { help: true }, {});
      const out = logs.join('\n');
      expect(out).toContain('--human');
      expect(out).toContain('uses NANSEN_API_KEY when already set');
      expect(out).not.toContain('security find-generic-password');
      expect(out).toMatch(/recorded in shell history/i);
      // the safe path is listed before the history-recording one
      expect(out.indexOf('--human')).toBeLessThan(out.indexOf('--api-key <key>'));
    });

    it('should save config with --api-key option after verification', async () => {
      const mockApi = { getAccount: vi.fn().mockResolvedValue({ plan: 'pro', credits_remaining: 9800 }) };
      mockDeps.NansenAPIClass.mockImplementation(function() { return mockApi; });

      await commands.login([], null, {}, { 'api-key': 'valid-api-key' });

      expect(mockApi.getAccount).toHaveBeenCalledOnce();
      expect(mockDeps.saveConfigFn).toHaveBeenCalledWith({
        apiKey: 'valid-api-key',
        baseUrl: 'https://api.nansen.ai'
      });
    });

    it('should exit when no API key available', async () => {
      const savedEnv = process.env.NANSEN_API_KEY;
      delete process.env.NANSEN_API_KEY;
      try {
        const err = await commands.login([], null, {}, {}).catch(e => e);
        expect(err.code).toBe('API_KEY_REQUIRED');
      } finally {
        if (savedEnv !== undefined) process.env.NANSEN_API_KEY = savedEnv;
      }
    });

    it('should reject invalid API key (401)', async () => {
      const mockApi = { getAccount: vi.fn().mockRejectedValue({ code: 'UNAUTHORIZED', message: 'Unauthorized' }) };
      mockDeps.NansenAPIClass.mockImplementation(function() { return mockApi; });

      const err = await commands.login([], null, {}, { 'api-key': 'invalid-key' }).catch(e => e);

      expect(err.code).toBe('INVALID_API_KEY');
      expect(mockDeps.saveConfigFn).not.toHaveBeenCalled();
    });

    it('should handle network errors during verification', async () => {
      const mockApi = { getAccount: vi.fn().mockRejectedValue({ code: 'NETWORK_ERROR', message: 'Network error' }) };
      mockDeps.NansenAPIClass.mockImplementation(function() { return mockApi; });

      const err = await commands.login([], null, {}, { 'api-key': 'some-key' }).catch(e => e);

      expect(err.code).toBe('VERIFICATION_FAILED');
      expect(mockDeps.saveConfigFn).not.toHaveBeenCalled();
    });

    it('should display account info on successful login', async () => {
      const mockApi = { getAccount: vi.fn().mockResolvedValue({ plan: 'enterprise', credits_remaining: 50000 }) };
      mockDeps.NansenAPIClass.mockImplementation(function() { return mockApi; });

      await commands.login([], null, {}, { 'api-key': 'valid-key' });

      expect(logs.some(l => l.includes('Plan: enterprise'))).toBe(true);
      expect(logs.some(l => l.includes('Credits remaining: 50000'))).toBe(true);
    });

  });

  describe('account command', () => {
    it('should return account data from apiInstance.getAccount()', async () => {
      const mockApi = {
        getAccount: vi.fn().mockResolvedValue({ plan: 'pro', credits_remaining: 9800 }),
      };
      const result = await commands.account([], mockApi, {}, {});
      expect(mockApi.getAccount).toHaveBeenCalledOnce();
      expect(result).toEqual({ plan: 'pro', credits_remaining: 9800 });
    });
  });

  describe('smart-money command', () => {
    it('should return help for unknown subcommand', async () => {
      const mockApi = {};
      const result = await commands['smart-money'](['unknown'], mockApi, {}, {});
      expect(result.error).toContain('Unknown subcommand');
      expect(result.available).toContain('netflow');
    });

    it('should return help object for help subcommand', async () => {
      const result = await commands['smart-money'](['help'], null, {}, {});
      expect(result.commands).toContain('netflow');
      expect(result.description).toBeDefined();
    });

    it('should call netflow with correct params', async () => {
      const mockApi = {
        smartMoneyNetflow: vi.fn().mockResolvedValue({ data: [] })
      };
      await commands['smart-money'](['netflow'], mockApi, {}, { chain: 'ethereum', limit: 10 });
      
      expect(mockApi.smartMoneyNetflow).toHaveBeenCalledWith({
        chains: ['ethereum'],
        filters: {},
        orderBy: undefined,
        pagination: { page: 1, per_page: 10 }
      });
    });

    it('should preserve explicit false for --only-new-positions after parsing', async () => {
      const mockApi = {
        smartMoneyPerpTrades: vi.fn().mockResolvedValue({ data: [] })
      };
      const { _: args, flags, options } = parseArgs(['perp-trades', '--only-new-positions', 'false']);
      await commands['smart-money'](args, mockApi, flags, options);

      expect(mockApi.smartMoneyPerpTrades).toHaveBeenCalledWith(
        expect.objectContaining({ onlyNewPositions: false })
      );
    });

    it('should treat --sort true as a literal field name instead of crashing', async () => {
      const mockApi = {
        smartMoneyNetflow: vi.fn().mockResolvedValue({ data: [] })
      };
      const { _: args, flags, options } = parseArgs(['netflow', '--chain', 'solana', '--sort', 'true']);
      await commands['smart-money'](args, mockApi, flags, options);

      expect(mockApi.smartMoneyNetflow).toHaveBeenCalledWith(
        expect.objectContaining({
          chains: ['solana'],
          orderBy: [{ field: 'true', direction: 'DESC' }],
        })
      );
    });

    it('should reject a repeated --sort instead of sending a joined field name', async () => {
      const mockApi = {
        smartMoneyNetflow: vi.fn().mockResolvedValue({ data: [] })
      };
      const { _: args, flags, options } = parseArgs(['netflow', '--sort', 'a', '--sort', 'b']);
      await expect(commands['smart-money'](args, mockApi, flags, options))
        .rejects.toThrow('--sort must be "field" or "field:direction"');
      expect(mockApi.smartMoneyNetflow).not.toHaveBeenCalled();
    });

    it('should add smart money labels filter', async () => {
      const mockApi = {
        smartMoneyNetflow: vi.fn().mockResolvedValue({ data: [] })
      };
      await commands['smart-money'](['netflow'], mockApi, {}, { labels: 'Fund' });
      
      expect(mockApi.smartMoneyNetflow).toHaveBeenCalledWith(
        expect.objectContaining({
          filters: { include_smart_money_labels: ['Fund'] }
        })
      );
    });
  });

  describe('--days validation', () => {
    it.each(['-1', '1.5', 'NaN', 'Infinity', '9007199254740992', '7abc'])(
      'should reject invalid --days value %s instead of truncating or forwarding it',
      async (days) => {
        const mockApi = {
          smartMoneyHistoricalHoldings: vi.fn().mockResolvedValue({ data: [] }),
        };
        const commands = buildCommands({});

        await expect(commands['smart-money'](['historical-holdings'], mockApi, {}, { days }))
          .rejects.toMatchObject({
            code: ErrorCode.INVALID_PARAMS,
            message: `--days must be a non-negative safe integer; received: ${days}`,
          });

        expect(mockApi.smartMoneyHistoricalHoldings).not.toHaveBeenCalled();
      },
    );

    it('should reject a safe integer that cannot form a valid date range', async () => {
      const mockApi = {
        smartMoneyHistoricalHoldings: vi.fn().mockResolvedValue({ data: [] }),
      };
      const commands = buildCommands({});

      await expect(commands['smart-money'](
        ['historical-holdings'],
        mockApi,
        {},
        { days: '9007199254740991' },
      )).rejects.toMatchObject({
        code: ErrorCode.INVALID_PARAMS,
        message: '--days is outside the supported date range; received: 9007199254740991',
      });

      expect(mockApi.smartMoneyHistoricalHoldings).not.toHaveBeenCalled();
    });

    it('should reject bare and repeated --days values clearly', async () => {
      const mockApi = {
        smartMoneyHistoricalHoldings: vi.fn().mockResolvedValue({ data: [] }),
      };
      const commands = buildCommands({});

      await expect(commands['smart-money'](
        ['historical-holdings'],
        mockApi,
        { days: true },
        {},
      )).rejects.toThrow('--days requires a non-negative safe integer value');

      await expect(commands['smart-money'](
        ['historical-holdings'],
        mockApi,
        {},
        { days: ['7', '30'] },
      )).rejects.toThrow('--days may only be specified once');

      expect(mockApi.smartMoneyHistoricalHoldings).not.toHaveBeenCalled();
    });

    it('should preserve valid zero and integer --days values', async () => {
      const mockApi = {
        smartMoneyHistoricalHoldings: vi.fn().mockResolvedValue({ data: [] }),
      };
      const commands = buildCommands({});

      await commands['smart-money'](['historical-holdings'], mockApi, {}, { days: '0' });
      expect(mockApi.smartMoneyHistoricalHoldings).toHaveBeenLastCalledWith(
        expect.objectContaining({ days: 0 }),
      );

      await commands['smart-money'](['historical-holdings'], mockApi, {}, { days: '365' });
      expect(mockApi.smartMoneyHistoricalHoldings).toHaveBeenLastCalledWith(
        expect.objectContaining({ days: 365 }),
      );
    });

    it('should apply strict --days parsing across analytics namespaces', async () => {
      const address = '0x0000000000000000000000000000000000000001';
      const mockApi = {
        smartMoneyHistoricalHoldings: vi.fn().mockResolvedValue({ data: [] }),
        addressHistoricalBalances: vi.fn().mockResolvedValue({ data: [] }),
        tokenFlows: vi.fn().mockResolvedValue({ data: [] }),
        perpLeaderboard: vi.fn().mockResolvedValue({ data: [] }),
      };
      const commands = buildCommands({});

      const calls = [
        () => commands['smart-money'](['historical-holdings'], mockApi, {}, { days: '7abc' }),
        () => commands['profiler'](['historical-balances'], mockApi, {}, {
          address, chain: 'ethereum', days: '7abc',
        }),
        () => commands['token'](['flows'], mockApi, {}, {
          token: address, chain: 'ethereum', days: '7abc',
        }),
        () => commands['perp'](['leaderboard'], mockApi, {}, { days: '7abc' }),
      ];

      for (const call of calls) {
        await expect(call()).rejects.toMatchObject({
          code: ErrorCode.INVALID_PARAMS,
          message: '--days must be a non-negative safe integer; received: 7abc',
        });
      }

      expect(mockApi.smartMoneyHistoricalHoldings).not.toHaveBeenCalled();
      expect(mockApi.addressHistoricalBalances).not.toHaveBeenCalled();
      expect(mockApi.tokenFlows).not.toHaveBeenCalled();
      expect(mockApi.perpLeaderboard).not.toHaveBeenCalled();
    });

    it('should dispatch profiler counterparties-batch with parsed --days and list it in help', async () => {
      const addressA = '0x0000000000000000000000000000000000000001';
      const addressB = '0x0000000000000000000000000000000000000002';
      const mockApi = {
        addressCounterpartiesBatch: vi.fn().mockResolvedValue({ data: [] }),
      };
      const commands = buildCommands({});

      await commands['profiler'](['counterparties-batch'], mockApi, {}, {
        addresses: `${addressA},${addressB}`,
        chain: 'ethereum',
        days: '7',
      });

      expect(mockApi.addressCounterpartiesBatch).toHaveBeenCalledWith(
        expect.objectContaining({
          addresses: [addressA, addressB],
          chain: 'ethereum',
          days: 7,
        }),
      );

      const help = await commands['profiler'](['help'], mockApi, {}, {});
      expect(help.commands).toContain('counterparties-batch');
    });

    it('should read profiler counterparties-batch addresses from --file', async () => {
      const addressA = '0x0000000000000000000000000000000000000001';
      const addressB = '0x0000000000000000000000000000000000000002';
      const file = `.counterparties-batch-${process.pid}.txt`;
      const mockApi = {
        addressCounterpartiesBatch: vi.fn().mockResolvedValue({ data: [] }),
      };
      const commands = buildCommands({});

      fs.writeFileSync(file, `${addressA}\n${addressB}\n`, 'utf8');
      try {
        await commands['profiler'](['counterparties-batch'], mockApi, {}, {
          file,
          chain: 'ethereum',
          days: '7',
        });
      } finally {
        fs.unlinkSync(file);
      }

      expect(mockApi.addressCounterpartiesBatch).toHaveBeenCalledWith(
        expect.objectContaining({
          addresses: [addressA, addressB],
          chain: 'ethereum',
          days: 7,
        }),
      );
    });

    it('should reject malformed --days for profiler counterparties-batch', async () => {
      const mockApi = {
        addressCounterpartiesBatch: vi.fn().mockResolvedValue({ data: [] }),
      };
      const commands = buildCommands({});

      await expect(commands['profiler'](['counterparties-batch'], mockApi, {}, {
        addresses: '0x0000000000000000000000000000000000000001',
        chain: 'ethereum',
        days: '7abc',
      })).rejects.toMatchObject({
        code: ErrorCode.INVALID_PARAMS,
        message: '--days must be a non-negative safe integer; received: 7abc',
      });

      expect(mockApi.addressCounterpartiesBatch).not.toHaveBeenCalled();
    });

    it('should leave --days ignored on subcommands that do not support it', async () => {
      const mockApi = {
        smartMoneyNetflow: vi.fn().mockResolvedValue({ data: [] }),
      };
      const commands = buildCommands({});

      await commands['smart-money'](['netflow'], mockApi, {}, { days: 'not-used' });

      expect(mockApi.smartMoneyNetflow).toHaveBeenCalledOnce();
    });

    it('should describe supported --days options as bounded integers in the schema', () => {
      const examples = [
        SCHEMA.commands.research.subcommands['smart-money'].subcommands['historical-holdings'].options.days,
        SCHEMA.commands.research.subcommands.profiler.subcommands.transactions.options.days,
        SCHEMA.commands.research.subcommands.profiler.subcommands['counterparties-batch'].options.days,
        SCHEMA.commands.research.subcommands.token.subcommands.flows.options.days,
        SCHEMA.commands.research.subcommands.perp.subcommands.leaderboard.options.days,
      ];

      for (const option of examples) {
        expect(option).toMatchObject({
          type: 'integer',
          minimum: 0,
          default: 30,
        });
      }
    });
  });

  describe('profiler command', () => {
    it('should return help for unknown subcommand', async () => {
      const result = await commands['profiler'](['unknown'], {}, {}, {});
      expect(result.error).toContain('Unknown subcommand');
    });

    it('should call balance with address', async () => {
      const mockApi = {
        addressBalance: vi.fn().mockResolvedValue({ data: [] })
      };
      await commands['profiler'](['balance'], mockApi, {}, { address: '0x123', chain: 'ethereum' });
      
      expect(mockApi.addressBalance).toHaveBeenCalledWith(
        expect.objectContaining({ address: '0x123', chain: 'ethereum' })
      );
    });

    it('should call search with query', async () => {
      const mockApi = {
        entitySearch: vi.fn().mockResolvedValue({ results: [] })
      };
      await commands['profiler'](['search'], mockApi, {}, { query: 'Vitalik' });
      
      expect(mockApi.entitySearch).toHaveBeenCalledWith(
        expect.objectContaining({ query: 'Vitalik' })
      );
    });

    it('should resolve ENS names for the other profiler subcommands when --chain is omitted', async () => {
      const ens = await import('../ens.js');
      vi.spyOn(ens, 'isEnsName').mockReturnValue(true);
      vi.spyOn(ens, 'resolveAddress').mockResolvedValue({
        address: '0x0000000000000000000000000000000000000001',
        ensName: 'vitalik.eth'
      });
      const mockApi = {
        addressLabels: vi.fn().mockResolvedValue({ data: [] }),
        addressBalance: vi.fn().mockResolvedValue({ data: [] }),
      };

      await commands['profiler'](['labels'], mockApi, {}, { address: 'vitalik.eth' });
      await commands['profiler'](['balance'], mockApi, {}, { address: 'vitalik.eth' });

      // The shared handler defaults --chain to 'all'; the resolver must accept it.
      expect(ens.resolveAddress).toHaveBeenCalledWith('vitalik.eth', 'all');
      expect(mockApi.addressLabels).toHaveBeenCalledWith(
        expect.objectContaining({ address: '0x0000000000000000000000000000000000000001', chain: 'all' })
      );
      expect(mockApi.addressBalance).toHaveBeenCalledWith(
        expect.objectContaining({ address: '0x0000000000000000000000000000000000000001', chain: 'all' })
      );
      vi.restoreAllMocks();
    });

    it('should resolve ENS names for first-funder using an EVM chain', async () => {
      const ens = await import('../ens.js');
      vi.spyOn(ens, 'isEnsName').mockReturnValue(true);
      vi.spyOn(ens, 'resolveAddress').mockResolvedValue({
        address: '0x0000000000000000000000000000000000000001',
        ensName: 'vitalik.eth'
      });

      const mockApi = {
        addressFirstFunder: vi.fn().mockResolvedValue({ data: [] })
      };

      const result = await commands['profiler'](['first-funder'], mockApi, {}, { address: 'vitalik.eth' });

      expect(ens.resolveAddress).toHaveBeenCalledWith('vitalik.eth', 'ethereum');
      expect(mockApi.addressFirstFunder).toHaveBeenCalledWith({
        address: '0x0000000000000000000000000000000000000001'
      });
      expect(result._ens).toEqual({
        name: 'vitalik.eth',
        resolvedAddress: '0x0000000000000000000000000000000000000001'
      });

      vi.restoreAllMocks();
    });
  });

  describe('token command', () => {
    it('should return help for unknown subcommand', async () => {
      const result = await commands['token'](['unknown'], {}, {}, {});
      expect(result.error).toContain('Unknown subcommand');
    });

    it('should pass top-tokens --limit as a safe integer', async () => {
      const mockApi = {
        topTokens: vi.fn().mockResolvedValue({ data: [] })
      };
      await commands['token'](['top-tokens'], mockApi, {}, { limit: '10' });

      expect(mockApi.topTokens).toHaveBeenCalledWith({ marketCapGroup: undefined, limit: 10 });
    });

    it.each(['500abc', '2.5', 'abc'])(
      'should reject malformed top-tokens --limit value %s before the handler runs',
      async (limit) => {
        const mockApi = {
          topTokens: vi.fn().mockResolvedValue({ data: [] })
        };

        await expect(commands['token'](['top-tokens'], mockApi, {}, { limit })).rejects.toMatchObject({
          code: ErrorCode.INVALID_PARAMS,
        });

        expect(mockApi.topTokens).not.toHaveBeenCalled();
      },
    );

    it('should reject unsafe top-tokens --limit before calling the API', async () => {
      const mockApi = {
        topTokens: vi.fn().mockResolvedValue({ data: [] })
      };

      await expect(commands['token'](['top-tokens'], mockApi, {}, { limit: '9007199254740992' }))
        .rejects.toMatchObject({
          code: ErrorCode.INVALID_PARAMS,
          message: '--limit must be a non-negative safe integer; received: 9007199254740992',
        });

      expect(mockApi.topTokens).not.toHaveBeenCalled();
    });

    it('should reject negative top-tokens --limit before calling the API', async () => {
      const mockApi = {
        topTokens: vi.fn().mockResolvedValue({ data: [] })
      };

      await expect(commands['token'](['top-tokens'], mockApi, {}, { limit: '-5' }))
        .rejects.toMatchObject({
          code: ErrorCode.INVALID_PARAMS,
        });

      expect(mockApi.topTokens).not.toHaveBeenCalled();
    });

    it('should reject bare top-tokens --limit', async () => {
      const mockApi = {
        topTokens: vi.fn().mockResolvedValue({ data: [] })
      };

      await expect(commands['token'](['top-tokens'], mockApi, { limit: true }, {}))
        .rejects.toThrow('--limit requires a non-negative safe integer value');

      expect(mockApi.topTokens).not.toHaveBeenCalled();
    });

    it('should call screener with chains and timeframe', async () => {
      const mockApi = {
        tokenScreener: vi.fn().mockResolvedValue({ data: [] })
      };
      await commands['token'](['screener'], mockApi, {}, { chain: 'solana', timeframe: '1h' });
      
      expect(mockApi.tokenScreener).toHaveBeenCalledWith(
        expect.objectContaining({ chains: ['solana'], timeframe: '1h' })
      );
    });

    it('should set smart money filter from flag', async () => {
      const mockApi = {
        tokenScreener: vi.fn().mockResolvedValue({ data: [] })
      };
      await commands['token'](['screener'], mockApi, { 'smart-money': true }, {});

      expect(mockApi.tokenScreener).toHaveBeenCalledWith(
        expect.objectContaining({ filters: { include_smart_money_labels: ['Fund', 'Smart Trader', '30D Smart Trader', '90D Smart Trader', '180D Smart Trader'] } })
      );
    });

    it('should set include_stablecoins filter from --include-stablecoins flag', async () => {
      const mockApi = {
        tokenScreener: vi.fn().mockResolvedValue({ data: [] })
      };
      await commands['token'](['screener'], mockApi, { 'include-stablecoins': false }, {});

      expect(mockApi.tokenScreener).toHaveBeenCalledWith(
        expect.objectContaining({ filters: { include_stablecoins: false } })
      );
    });

    it('should set include_smart_money_labels and include_stablecoins when --smart-money and --include-stablecoins are combined', async () => {
      const mockApi = {
        tokenScreener: vi.fn().mockResolvedValue({ data: [] })
      };
      await commands['token'](['screener'], mockApi, { 'smart-money': true, 'include-stablecoins': false }, {});

      expect(mockApi.tokenScreener).toHaveBeenCalledWith(
        expect.objectContaining({
          filters: expect.objectContaining({
            include_smart_money_labels: expect.any(Array),
            include_stablecoins: false
          })
        })
      );
    });

    it('should preserve explicit false boolean option values after parsing', async () => {
      const mockApi = {
        tokenScreener: vi.fn().mockResolvedValue({ data: [] })
      };
      const { flags, options } = parseArgs(['--smart-money', 'false', '--include-stablecoins', 'false']);
      await commands['token'](['screener'], mockApi, flags, options);

      expect(mockApi.tokenScreener).toHaveBeenCalledWith(
        expect.objectContaining({ filters: { include_stablecoins: false } })
      );
    });

    it('should reject non-string --search values before calling the API', async () => {
      const mockApi = { tokenScreener: vi.fn().mockResolvedValue({ data: [] }) };
      // parseArgs still turns `--search '[]'`, `--search '{}'` and a repeated --search into non-strings
      for (const bad of [[], {}, ['pepe', 'wif']]) {
        await expect(commands['token'](['screener'], mockApi, {}, { chain: 'ethereum', search: bad }))
          .rejects.toMatchObject({ code: ErrorCode.INVALID_PARAMS, message: '--search must be a string' });
      }
      expect(mockApi.tokenScreener).not.toHaveBeenCalled();
    });

    it('should filter screener results by search option (client-side, flat)', async () => {
      const mockApi = {
        tokenScreener: vi.fn().mockResolvedValue({ data: [
          { token_symbol: 'PEPE', token_name: 'Pepe', price_usd: 0.001 },
          { token_symbol: 'USDC', token_name: 'USD Coin', price_usd: 1.0 },
          { token_symbol: 'PEPEFORK', token_name: 'Pepe Fork', price_usd: 0.0001 },
        ] })
      };
      const result = await commands['token'](['screener'], mockApi, {}, { chain: 'ethereum', search: 'PEPE' });
      
      expect(result.data).toHaveLength(2);
      expect(result.data[0].token_symbol).toBe('PEPE');
      expect(result.data[1].token_symbol).toBe('PEPEFORK');
    });

    it('should filter screener results by search option (client-side, nested)', async () => {
      const mockApi = {
        tokenScreener: vi.fn().mockResolvedValue({ data: { data: [
          { token_symbol: 'PEPE', price_usd: 0.001 },
          { token_symbol: 'USDC', price_usd: 1.0 },
          { token_symbol: 'PEPEFORK', price_usd: 0.0001 },
        ], pagination: { page: 1 } } })
      };
      const result = await commands['token'](['screener'], mockApi, {}, { chain: 'ethereum', search: 'PEPE' });
      
      expect(result.data.data).toHaveLength(2);
      expect(result.data.data[0].token_symbol).toBe('PEPE');
      expect(result.data.pagination.page).toBe(1);
    });

    it('should page the client-side search results with --page and --limit', async () => {
      const data = Array.from({ length: 30 }, (_, i) => ({ token_symbol: `PEPE${i}`, price_usd: i }));
      const mockApi = { tokenScreener: vi.fn().mockResolvedValue({ data }) };

      const page1 = await commands['token'](['screener'], mockApi, {}, { chain: 'ethereum', search: 'pepe', limit: '10', page: '1' });
      const page2 = await commands['token'](['screener'], mockApi, {}, { chain: 'ethereum', search: 'pepe', limit: '10', page: '2' });
      const page4 = await commands['token'](['screener'], mockApi, {}, { chain: 'ethereum', search: 'pepe', limit: '10', page: '4' });

      expect(page1.data.map(t => t.token_symbol)).toEqual(data.slice(0, 10).map(t => t.token_symbol));
      expect(page2.data.map(t => t.token_symbol)).toEqual(data.slice(10, 20).map(t => t.token_symbol));
      expect(page4.data).toEqual([]);
      // The upstream fetch still starts at page 1 and covers every page up to the requested one.
      expect(mockApi.tokenScreener).toHaveBeenLastCalledWith(
        expect.objectContaining({ pagination: { page: 1, per_page: 500 } })
      );
    });

    it('should page nested client-side search results with --page and --limit', async () => {
      const data = Array.from({ length: 30 }, (_, i) => ({ token_symbol: 'PEPE' + i, price_usd: i }));
      const mockApi = { tokenScreener: vi.fn().mockResolvedValue({ data: { data, pagination: { page: 1 } } }) };

      const page2 = await commands['token'](['screener'], mockApi, {}, { chain: 'ethereum', search: 'pepe', limit: '10', page: '2' });

      expect(page2.data.data.map(t => t.token_symbol)).toEqual(data.slice(10, 20).map(t => t.token_symbol));
      expect(page2.data.pagination.page).toBe(1);
    });

    it('returns every matching client-side search result with --paginate', async () => {
      const data = Array.from({ length: 30 }, (_, i) => ({ token_symbol: `PEPE${i}`, price_usd: i }));
      const pagination = { page: 1, pages_fetched: 3, next_page: null, complete: true };
      const mockApi = { tokenScreener: vi.fn().mockResolvedValue({ data, pagination }) };

      const result = await commands['token'](
        ['screener'],
        mockApi,
        { paginate: true },
        { chain: 'ethereum', search: 'pepe', limit: '10', page: '1' },
      );

      expect(result.data).toEqual(data);
      expect(result.pagination).toBe(pagination);
      expect(mockApi.tokenScreener).toHaveBeenCalledWith(
        expect.objectContaining({ pagination: { page: 1, per_page: 10 } }),
      );
    });

    it('starts paginated client-side search traversal at the requested page', async () => {
      const mockApi = { tokenScreener: vi.fn().mockResolvedValue({ data: [] }) };

      await commands['token'](
        ['screener'],
        mockApi,
        { paginate: true },
        { chain: 'ethereum', search: 'pepe', limit: '10', page: '3' },
      );

      expect(mockApi.tokenScreener).toHaveBeenCalledWith(
        expect.objectContaining({ pagination: { page: 3, per_page: 10 } }),
      );
    });

    it('should widen the search candidate fetch when the requested page is past the default 500', async () => {
      const mockApi = { tokenScreener: vi.fn().mockResolvedValue({ data: [] }) };
      await commands['token'](['screener'], mockApi, {}, { chain: 'ethereum', search: 'pepe', limit: '100', page: '7' });
      expect(mockApi.tokenScreener).toHaveBeenCalledWith(
        expect.objectContaining({ pagination: { page: 1, per_page: 700 } })
      );
    });

    it('should call holders with token address', async () => {
      const mockApi = {
        tokenHolders: vi.fn().mockResolvedValue({ data: [] })
      };
      await commands['token'](['holders'], mockApi, {}, { token: '0xabc' });

      expect(mockApi.tokenHolders).toHaveBeenCalledWith(
        expect.objectContaining({ tokenAddress: '0xabc' })
      );
    });

    it('should call ohlcv with token address and timeframe', async () => {
      const mockApi = {
        tokenOhlcv: vi.fn().mockResolvedValue({ candles: [] })
      };
      await commands['token'](['ohlcv'], mockApi, {}, { token: '0xabc', chain: 'solana', timeframe: '4h' });

      expect(mockApi.tokenOhlcv).toHaveBeenCalledWith(
        expect.objectContaining({ tokenAddress: '0xabc', chain: 'solana', timeframe: '4h' })
      );
    });

    it('should warn to stderr when ohlcv price fields are null but volume is present', async () => {
      const nullPriceCandles = [
        { interval_start: '2026-02-01T00:00:00', open: null, high: null, low: null, close: null, volume: 167913267, volume_usd: null, market_cap: { open: null, high: null, low: null, close: null } },
        { interval_start: '2026-02-02T00:00:00', open: null, high: null, low: null, close: null, volume: 125748386, volume_usd: null, market_cap: { open: null, high: null, low: null, close: null } },
      ];
      const mockApi = {
        tokenOhlcv: vi.fn().mockResolvedValue({ data: nullPriceCandles })
      };
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      await commands['token'](['ohlcv'], mockApi, {}, { token: '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed', chain: 'base', timeframe: '1d' });

      expect(stderrSpy).toHaveBeenCalledTimes(1);
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Price data unavailable'));
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('0x4ed4e862860bed51a9570b96d89af5e1b0efefed'));
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('open/high/low/close'));
      stderrSpy.mockRestore();
    });

    it('should not warn to stderr when ohlcv price fields are populated', async () => {
      const fullCandles = [
        { interval_start: '2026-02-01T00:00:00', open: 0.0000071, high: 0.0000073, low: 0.0000069, close: 0.0000070, volume: 112998122501, volume_usd: 806705, market_cap: { open: 631010924, high: 620085355, low: 620085355, close: 620085355 } },
      ];
      const mockApi = {
        tokenOhlcv: vi.fn().mockResolvedValue({ data: fullCandles })
      };
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      await commands['token'](['ohlcv'], mockApi, {}, { token: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', chain: 'solana', timeframe: '1d' });

      expect(stderrSpy).not.toHaveBeenCalledWith(expect.stringContaining('Price data unavailable'));
      stderrSpy.mockRestore();
    });

    it('should warn to stderr when ohlcv returns empty candles array', async () => {
      const mockApi = {
        tokenOhlcv: vi.fn().mockResolvedValue({ data: [] })
      };
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      await commands['token'](['ohlcv'], mockApi, {}, { token: '0xdeadbeef', chain: 'base', timeframe: '1d' });

      expect(stderrSpy).toHaveBeenCalledTimes(1);
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('No OHLCV data returned'));
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('0xdeadbeef'));
      stderrSpy.mockRestore();
    });

    it('should pass days to flows handler', async () => {
      const mockApi = {
        tokenFlows: vi.fn().mockResolvedValue({ data: [] })
      };
      await commands['token'](['flows'], mockApi, {}, { token: '0xabc', days: '7' });

      expect(mockApi.tokenFlows).toHaveBeenCalledWith(
        expect.objectContaining({ days: 7 })
      );
    });

    it('should pass days to who-bought-sold handler', async () => {
      const mockApi = {
        tokenWhoBoughtSold: vi.fn().mockResolvedValue({ data: [] })
      };
      await commands['token'](['who-bought-sold'], mockApi, {}, { token: '0xabc', days: '7' });

      expect(mockApi.tokenWhoBoughtSold).toHaveBeenCalledWith(
        expect.objectContaining({ days: 7 })
      );
    });

    it('should reject non-string buy-or-sell values before calling the API', async () => {
      const mockApi = { tokenWhoBoughtSold: vi.fn().mockResolvedValue({ data: [] }) };
      for (const bad of [[], {}, ['BUY', 'SELL']]) {
        await expect(commands['token'](['who-bought-sold'], mockApi, {}, { token: '0xabc', 'buy-or-sell': bad }))
          .rejects.toMatchObject({ code: ErrorCode.INVALID_PARAMS, message: '--buy-or-sell must be BUY or SELL' });
      }
      expect(mockApi.tokenWhoBoughtSold).not.toHaveBeenCalled();
    });

    it('should reject buy-or-sell values outside the BUY/SELL enum', async () => {
      const mockApi = { tokenWhoBoughtSold: vi.fn().mockResolvedValue({ data: [] }) };
      await expect(commands['token'](['who-bought-sold'], mockApi, {}, { token: '0xabc', 'buy-or-sell': 'hold' }))
        .rejects.toMatchObject({ code: ErrorCode.INVALID_PARAMS });
      expect(mockApi.tokenWhoBoughtSold).not.toHaveBeenCalled();
    });

    it('should still accept lowercase buy-or-sell values', async () => {
      const mockApi = { tokenWhoBoughtSold: vi.fn().mockResolvedValue({ data: [] }) };
      await commands['token'](['who-bought-sold'], mockApi, {}, { token: '0xabc', 'buy-or-sell': 'sell' });
      expect(mockApi.tokenWhoBoughtSold).toHaveBeenCalledWith(expect.objectContaining({ buyOrSell: 'SELL' }));
    });

    it('should pass buy-or-sell to who-bought-sold handler', async () => {
      const mockApi = {
        tokenWhoBoughtSold: vi.fn().mockResolvedValue({ data: [] })
      };
      await commands['token'](['who-bought-sold'], mockApi, {}, { token: '0xabc', 'buy-or-sell': 'SELL' });

      expect(mockApi.tokenWhoBoughtSold).toHaveBeenCalledWith(
        expect.objectContaining({ buyOrSell: 'SELL' })
      );
    });

    it('should default buy-or-sell to BUY in who-bought-sold handler', async () => {
      const mockApi = {
        tokenWhoBoughtSold: vi.fn().mockResolvedValue({ data: [] })
      };
      await commands['token'](['who-bought-sold'], mockApi, {}, { token: '0xabc' });

      expect(mockApi.tokenWhoBoughtSold).toHaveBeenCalledWith(
        expect.objectContaining({ buyOrSell: 'BUY' })
      );
    });

    it('should pass timeframe to flow-intelligence handler', async () => {
      const mockApi = {
        tokenFlowIntelligence: vi.fn().mockResolvedValue({ data: [] })
      };
      await commands['token'](['flow-intelligence'], mockApi, {}, { token: '0xabc', timeframe: '7d' });

      expect(mockApi.tokenFlowIntelligence).toHaveBeenCalledWith(
        expect.objectContaining({ timeframe: '7d' })
      );
    });
  });

  describe('profiler command - days passthrough', () => {
    it('should pass days to transactions handler', async () => {
      const mockApi = {
        addressTransactions: vi.fn().mockResolvedValue({ data: [] })
      };
      await commands['profiler'](['transactions'], mockApi, {}, { address: '0x123', days: '7' });

      expect(mockApi.addressTransactions).toHaveBeenCalledWith(
        expect.objectContaining({ days: 7 })
      );
    });
  });

  describe('portfolio command', () => {
    it('should return help for unknown subcommand', async () => {
      const result = await commands['portfolio'](['unknown'], {}, {}, {});
      expect(result.error).toContain('Unknown subcommand');
    });

    it('should call defi-holdings with wallet', async () => {
      const mockApi = {
        portfolioDefiHoldings: vi.fn().mockResolvedValue({ data: [] })
      };
      await commands['portfolio'](['defi'], mockApi, {}, { wallet: '0xdef' });
      
      expect(mockApi.portfolioDefiHoldings).toHaveBeenCalledWith({ walletAddress: '0xdef' });
    });
  });
});

describe('runCLI', () => {
  let outputs;
  let errors;
  let exitCode;

  beforeEach(() => {
    outputs = [];
    errors = [];
    exitCode = null;
  });

  const mockDeps = () => ({
    output: (msg) => outputs.push(msg),
    errorOutput: (msg) => errors.push(msg),
    exit: (code) => { exitCode = code; }
  });

  it('should show help when no command', async () => {
    const result = await runCLI([], mockDeps());
    expect(result.type).toBe('help');
    expect(outputs[0]).toContain('USAGE:');
  });

  it('should show help when --help flag', async () => {
    const result = await runCLI(['--help'], mockDeps());
    expect(result.type).toBe('help');
  });

  it('should show help when -h flag', async () => {
    const result = await runCLI(['-h'], mockDeps());
    expect(result.type).toBe('help');
  });

  it('should error on unknown command', async () => {
    const result = await runCLI(['unknown-cmd'], mockDeps());
    expect(result.type).toBe('error');
    expect(exitCode).toBe(1);
  });

  it('should run help command without API', async () => {
    const result = await runCLI(['help'], mockDeps());
    // 'help' is handled early in runCLI, returning type: 'help'
    expect(result.type).toBe('help');
  });

  it('should configure no-retry when flag set', async () => {
    let apiOptions;
    const deps = {
      ...mockDeps(),
      NansenAPIClass: function MockAPI(key, url, opts) {
        apiOptions = opts;
        this.smartMoneyNetflow = vi.fn().mockResolvedValue({ data: [] });
      }
    };
    
    await runCLI(['smart-money', 'netflow', '--no-retry'], deps);
    expect(apiOptions.retry.maxRetries).toBe(0);
  });

  it('should use custom retries count', async () => {
    let apiOptions;
    const deps = {
      ...mockDeps(),
      NansenAPIClass: function MockAPI(key, url, opts) {
        apiOptions = opts;
        this.smartMoneyNetflow = vi.fn().mockResolvedValue({ data: [] });
      }
    };
    
    await runCLI(['smart-money', 'netflow', '--retries', '5'], deps);
    expect(apiOptions.retry.maxRetries).toBe(5);
  });

  it('should output pretty JSON when --pretty', async () => {
    const deps = {
      ...mockDeps(),
      NansenAPIClass: function MockAPI() {
        this.smartMoneyNetflow = vi.fn().mockResolvedValue({ x: 1 });
      }
    };
    
    await runCLI(['smart-money', 'netflow', '--pretty'], deps);
    expect(outputs[0]).toContain('\n'); // pretty JSON has newlines
  });

  it('should output table when --table', async () => {
    const deps = {
      ...mockDeps(),
      NansenAPIClass: function MockAPI() {
        this.smartMoneyNetflow = vi.fn().mockResolvedValue([{ token: 'SOL', value: 100 }]);
      }
    };
    
    await runCLI(['smart-money', 'netflow', '--table'], deps);
    expect(outputs[0]).toContain('│'); // table has column separators
  });

  it('should handle API errors', async () => {
    const deps = {
      ...mockDeps(),
      NansenAPIClass: function MockAPI() {
        this.smartMoneyNetflow = vi.fn().mockRejectedValue(new Error('API Error'));
      }
    };
    
    const result = await runCLI(['smart-money', 'netflow'], deps);
    expect(result.type).toBe('error');
    expect(exitCode).toBe(1);
  });

  it('writes exactly one credits line to stderr after notices without changing stdout', async () => {
    const deps = {
      ...mockDeps(),
      NansenAPIClass: function MockAPI() {
        this.lastResponseMeta = {
          credits: { used: 5, remaining: 100, cost: 7 },
          notices: { planNotice: 'Plan notice' },
        };
        this.lastEndpoint = '/api/v1/smart-money/netflow';
        this.smartMoneyNetflow = vi.fn().mockResolvedValue({ data: [] });
      },
    };

    await runCLI(['smart-money', 'netflow'], deps);

    expect(errors).toEqual(['ℹ️  Plan notice', 'Credits: 7 (this call)']);
    expect(outputs).toHaveLength(1);
    expect(JSON.parse(outputs[0])).toEqual({ success: true, data: { data: [] } });
  });

  it('does not duplicate response metadata when post-request formatting fails', async () => {
    const deps = {
      ...mockDeps(),
      NansenAPIClass: function MockAPI() {
        this.lastResponseMeta = { credits: { used: 5, remaining: 100, cost: 7 } };
        this.lastEndpoint = '/api/v1/smart-money/netflow';
        this.smartMoneyNetflow = vi.fn().mockResolvedValue({ data: [] });
      },
    };

    const result = await runCLI(['smart-money', 'netflow', '--fields', '[]'], deps);

    expect(result.type).toBe('error');
    expect(errors).toEqual(['Credits: 7 (this call)']);
    expect(outputs).toHaveLength(1);
  });
});

// =================== P1: --table Output Formatting ===================

describe('--table output formatting', () => {
  it('should format token data with priority columns', () => {
    const data = [
      { token_symbol: 'SOL', token_name: 'Solana', value_usd: 1500000, random_field: 'ignored' },
      { token_symbol: 'ETH', token_name: 'Ethereum', value_usd: 2500000, random_field: 'also ignored' }
    ];
    const result = formatTable(data);
    
    // Should have headers
    expect(result).toContain('token_symbol');
    expect(result).toContain('token_name');
    expect(result).toContain('value_usd');
    
    // Should format large numbers with M suffix
    expect(result).toContain('1.50M');
    expect(result).toContain('2.50M');
    
    // Should have table separators
    expect(result).toContain('│');
    expect(result).toContain('─');
  });

  it('should format address and chain columns', () => {
    const data = [
      { address: '0x1234...', chain: 'ethereum', label: 'Whale', pnl_usd: 50000 }
    ];
    const result = formatTable(data);
    
    expect(result).toContain('address');
    expect(result).toContain('chain');
    expect(result).toContain('label');
    expect(result).toContain('0x1234...');
    expect(result).toContain('ethereum');
    expect(result).toContain('Whale');
    expect(result).toContain('50.00K');
  });

  it('should handle nested API response with data wrapper', () => {
    const response = {
      success: true,
      data: [
        { symbol: 'BTC', price_usd: 45000, volume_usd: 1000000000 }
      ]
    };
    const formatted = formatOutput(response, { table: true });
    
    expect(formatted.type).toBe('table');
    expect(formatted.text).toContain('symbol');
    expect(formatted.text).toContain('BTC');
    expect(formatted.text).toContain('1000.00M');
  });

  it('should truncate long values to column width', () => {
    const data = [
      { address: '0x1234567890abcdef1234567890abcdef12345678', name: 'A very long name that exceeds thirty characters easily' }
    ];
    const result = formatTable(data);
    
    // Values should be truncated (max 30 chars per column)
    const lines = result.split('\n');
    lines.forEach(line => {
      // Each cell shouldn't exceed reasonable width
      expect(line.length).toBeLessThan(300);
    });
  });

  it('should handle empty values gracefully', () => {
    const data = [
      { symbol: 'TEST', value: null, amount: undefined, label: '' }
    ];
    const result = formatTable(data);
    
    expect(result).toContain('TEST');
    // Empty values should not cause errors
    expect(result).not.toContain('null');
    expect(result).not.toContain('undefined');
  });

  it('should format error response in table mode', () => {
    const errorResponse = { success: false, error: 'Rate limited' };
    const formatted = formatOutput(errorResponse, { table: true });
    
    expect(formatted.type).toBe('error');
    expect(formatted.text).toBe('Error: Rate limited');
  });
});

// =================== P1: --no-retry and --retries Flags ===================

describe('--no-retry and --retries flags', () => {
  let outputs, _exitCode;

  const mockDeps = () => ({
    output: (msg) => outputs.push(msg),
    errorOutput: (msg) => outputs.push(msg),
    exit: (code) => { _exitCode = code; }
  });

  beforeEach(() => {
    outputs = [];
    _exitCode = null;
  });

  it('should set maxRetries to 0 when --no-retry is used', async () => {
    let capturedOptions;
    const deps = {
      ...mockDeps(),
      NansenAPIClass: function MockAPI(key, url, opts) {
        capturedOptions = opts;
        this.smartMoneyNetflow = vi.fn().mockResolvedValue({ data: [] });
      }
    };
    
    await runCLI(['smart-money', 'netflow', '--no-retry'], deps);
    
    expect(capturedOptions.retry.maxRetries).toBe(0);
  });

  it('should use default maxRetries of 3 without flags', async () => {
    let capturedOptions;
    const deps = {
      ...mockDeps(),
      NansenAPIClass: function MockAPI(key, url, opts) {
        capturedOptions = opts;
        this.smartMoneyNetflow = vi.fn().mockResolvedValue({ data: [] });
      }
    };
    
    await runCLI(['smart-money', 'netflow'], deps);
    
    expect(capturedOptions.retry.maxRetries).toBe(3);
  });

  it('should use custom maxRetries when --retries is specified', async () => {
    let capturedOptions;
    const deps = {
      ...mockDeps(),
      NansenAPIClass: function MockAPI(key, url, opts) {
        capturedOptions = opts;
        this.smartMoneyNetflow = vi.fn().mockResolvedValue({ data: [] });
      }
    };
    
    await runCLI(['smart-money', 'netflow', '--retries', '7'], deps);
    
    expect(capturedOptions.retry.maxRetries).toBe(7);
  });

  it('should allow --retries 0 to disable retries', async () => {
    let capturedOptions;
    const deps = {
      ...mockDeps(),
      NansenAPIClass: function MockAPI(key, url, opts) {
        capturedOptions = opts;
        this.smartMoneyNetflow = vi.fn().mockResolvedValue({ data: [] });
      }
    };
    
    await runCLI(['smart-money', 'netflow', '--retries', '0'], deps);
    
    expect(capturedOptions.retry.maxRetries).toBe(0);
  });

  it.each(['-1', '1.5', 'NaN', 'Infinity', '9007199254740992'])(
    'should reject invalid --retries value %s before constructing the API client',
    async (value) => {
      const NansenAPIClass = vi.fn();

      const result = await runCLI(
        ['smart-money', 'netflow', '--retries', value],
        { ...mockDeps(), NansenAPIClass },
      );

      expect(result).toMatchObject({
        type: 'error',
        data: {
          error: `--retries must be a non-negative safe integer; received: ${value}`,
          code: ErrorCode.INVALID_PARAMS,
        },
      });
      expect(NansenAPIClass).not.toHaveBeenCalled();
      expect(_exitCode).toBe(1);
    },
  );

  it('should reject --retries without a value before constructing the API client', async () => {
    const NansenAPIClass = vi.fn();

    const result = await runCLI(
      ['smart-money', 'netflow', '--retries'],
      { ...mockDeps(), NansenAPIClass },
    );

    expect(result.data.error).toBe('--retries requires a non-negative safe integer value');
    expect(result.data.code).toBe(ErrorCode.INVALID_PARAMS);
    expect(NansenAPIClass).not.toHaveBeenCalled();
    expect(_exitCode).toBe(1);
  });

  it.each([
    ['--retries', '2', '--retries'],
    ['--retries', '--retries', '2'],
  ])('should reject a valueless repeated --retries occurrence: %s %s %s', async (...retryArgs) => {
    const NansenAPIClass = vi.fn();

    const result = await runCLI(
      ['smart-money', 'netflow', ...retryArgs],
      { ...mockDeps(), NansenAPIClass },
    );

    expect(result.data.error).toBe('--retries requires a non-negative safe integer value');
    expect(result.data.code).toBe(ErrorCode.INVALID_PARAMS);
    expect(NansenAPIClass).not.toHaveBeenCalled();
  });

  it('should reject repeated valued --retries options clearly', async () => {
    const NansenAPIClass = vi.fn();

    const result = await runCLI(
      ['smart-money', 'netflow', '--retries', '2', '--retries', '3'],
      { ...mockDeps(), NansenAPIClass },
    );

    expect(result.data.error).toBe('--retries may only be specified once');
    expect(result.data.code).toBe(ErrorCode.INVALID_PARAMS);
    expect(NansenAPIClass).not.toHaveBeenCalled();
  });

  it.each(['', '   '])('should reject empty --retries value %#', async (value) => {
    const NansenAPIClass = vi.fn();

    const result = await runCLI(
      ['smart-money', 'netflow', '--retries', value],
      { ...mockDeps(), NansenAPIClass },
    );

    expect(result.data.error).toBe('--retries requires a non-negative safe integer value');
    expect(result.data.code).toBe(ErrorCode.INVALID_PARAMS);
    expect(NansenAPIClass).not.toHaveBeenCalled();
  });

  it('should validate --retries even when --no-retry overrides it', async () => {
    const NansenAPIClass = vi.fn();

    const result = await runCLI(
      ['smart-money', 'netflow', '--no-retry', '--retries', '-1'],
      { ...mockDeps(), NansenAPIClass },
    );

    expect(result.data.error).toBe('--retries must be a non-negative safe integer; received: -1');
    expect(result.data.code).toBe(ErrorCode.INVALID_PARAMS);
    expect(NansenAPIClass).not.toHaveBeenCalled();
  });

  it('should allow the largest safe integer for --retries', async () => {
    let capturedOptions;
    const deps = {
      ...mockDeps(),
      NansenAPIClass: function MockAPI(key, url, opts) {
        capturedOptions = opts;
        this.smartMoneyNetflow = vi.fn().mockResolvedValue({ data: [] });
      },
    };

    await runCLI(['smart-money', 'netflow', '--retries', '9007199254740991'], deps);

    expect(capturedOptions.retry.maxRetries).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('should describe retry numeric boundaries in the schema', () => {
    expect(SCHEMA.globalOptions.retries).toMatchObject({
      type: 'integer',
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
    });
  });
});

// =================== P2: parseSort with Special Characters ===================

describe('parseSort with special characters', () => {
  it('should handle field names with underscores', () => {
    const result = parseSort('value_usd:asc', undefined);
    expect(result).toEqual([{ field: 'value_usd', direction: 'ASC' }]);
  });

  it('should handle field names with numbers', () => {
    const result = parseSort('pnl_30d:desc', undefined);
    expect(result).toEqual([{ field: 'pnl_30d', direction: 'DESC' }]);
  });

  it('should handle field names with dots', () => {
    const result = parseSort('token.price:asc', undefined);
    expect(result).toEqual([{ field: 'token.price', direction: 'ASC' }]);
  });

  it('should handle field names with hyphens', () => {
    const result = parseSort('net-flow:desc', undefined);
    expect(result).toEqual([{ field: 'net-flow', direction: 'DESC' }]);
  });

  it('should handle multiple colons in field name', () => {
    // Edge case: field:with:colons:asc should split on first colon only
    const result = parseSort('field:asc', undefined);
    expect(result).toEqual([{ field: 'field', direction: 'ASC' }]);
  });

  it('should reject an empty field name instead of sending it upstream', () => {
    expect(() => parseSort(':asc', undefined)).toThrow(NansenError);
    expect(() => parseSort(':asc', undefined)).toThrow('--sort needs a field name');
    expect(() => parseSort(' :desc', undefined)).toThrow('--sort needs a field name');
  });

  it('should reject a direction other than asc/desc instead of sending it upstream', () => {
    for (const bad of ['pnl_usd:sideways', 'pnl_usd:up', 'pnl_usd:descending']) {
      let error;
      try { parseSort(bad, undefined); } catch (e) { error = e; }
      expect(error).toBeInstanceOf(NansenError);
      expect(error.code).toBe(ErrorCode.INVALID_PARAMS);
      expect(error.message).toContain('asc or desc');
    }
  });

  it('should quote the trimmed direction in the error message', () => {
    expect(() => parseSort('field:  sideways  ', undefined)).toThrow('got "sideways"');
  });

  it('should still accept a trailing colon as the default direction', () => {
    expect(parseSort('pnl_usd:', undefined)).toEqual([{ field: 'pnl_usd', direction: 'DESC' }]);
  });

  it('should handle case-insensitive direction', () => {
    expect(parseSort('field:ASC', undefined)).toEqual([{ field: 'field', direction: 'ASC' }]);
    expect(parseSort('field:Desc', undefined)).toEqual([{ field: 'field', direction: 'DESC' }]);
    expect(parseSort('field:DESC', undefined)).toEqual([{ field: 'field', direction: 'DESC' }]);
  });
});

// =================== P2: formatTable with Nested Objects ===================

describe('formatTable with nested objects', () => {
  it('should stringify nested objects', () => {
    const data = [
      { name: 'Test', metadata: { chain: 'ethereum', protocol: 'uniswap' } }
    ];
    const result = formatTable(data);
    
    expect(result).toContain('name');
    expect(result).toContain('Test');
    expect(result).toContain('metadata');
    // Nested object should be stringified
    expect(result).toContain('chain');
  });

  it('should handle deeply nested objects', () => {
    const data = [
      { 
        id: 1, 
        deep: { 
          level1: { 
            level2: { 
              value: 'deep value' 
            } 
          } 
        } 
      }
    ];
    const result = formatTable(data);
    
    expect(result).toContain('id');
    expect(result).toContain('1');
    // Deep nesting should be JSON stringified
    expect(result).toContain('level1');
  });

  it('should handle arrays in fields', () => {
    const data = [
      { name: 'Multi', tags: ['defi', 'nft', 'gaming'] }
    ];
    const result = formatTable(data);
    
    expect(result).toContain('name');
    expect(result).toContain('Multi');
    expect(result).toContain('tags');
    expect(result).toContain('defi');
  });

  it('should handle mixed nested and flat fields', () => {
    const data = [
      { 
        symbol: 'ETH',
        price_usd: 3000,
        volume: { h24: 1000000, h7d: 5000000 },
        labels: ['whale', 'smart money']
      }
    ];
    const result = formatTable(data);
    
    expect(result).toContain('symbol');
    expect(result).toContain('ETH');
    expect(result).toContain('3.00K'); // price formatted
    expect(result).toContain('volume');
    expect(result).toContain('labels');
  });

  it('should handle null nested values', () => {
    const data = [
      { name: 'Test', nested: null, deep: { value: null } }
    ];
    const result = formatTable(data);
    
    // Should not crash on null nested values
    expect(result).toContain('name');
    expect(result).toContain('Test');
  });
});

// =================== P2: Mock Login/Logout Flow ===================

describe('login/logout flow', () => {
  let mockDeps;
  let commands;
  let logs;

  beforeEach(() => {
    logs = [];
    mockDeps = {
      log: (msg) => logs.push(msg),
      exit: vi.fn(),
      promptFn: vi.fn(),
      saveConfigFn: vi.fn(),
      deleteConfigFn: vi.fn(),
      getConfigFileFn: vi.fn(() => '/home/user/.nansen/config.json'),
      NansenAPIClass: vi.fn(),
      isTTY: true
    };
    commands = buildCommands(mockDeps);
  });

  describe('login command', () => {
    it('should prompt for API key with --human flag in TTY mode', async () => {
      const mockApi = { getAccount: vi.fn().mockResolvedValue({ plan: 'pro', credits_remaining: 100 }) };
      mockDeps.NansenAPIClass.mockImplementation(function() { return mockApi; });
      mockDeps.promptFn.mockResolvedValue('test-key');
      const savedEnv = process.env.NANSEN_API_KEY;
      delete process.env.NANSEN_API_KEY;

      await commands.login([], null, { human: true }, {});

      if (savedEnv !== undefined) process.env.NANSEN_API_KEY = savedEnv;
      expect(mockDeps.promptFn).toHaveBeenCalledWith('Enter your API key: ', true);
    });

    it('should trim whitespace from API key', async () => {
      const mockApi = { getAccount: vi.fn().mockResolvedValue({ plan: 'pro', credits_remaining: 100 }) };
      mockDeps.NansenAPIClass.mockImplementation(function() { return mockApi; });

      await commands.login([], null, {}, { 'api-key': '  api-key-with-spaces  ' });

      expect(mockDeps.saveConfigFn).toHaveBeenCalledWith({
        apiKey: 'api-key-with-spaces',
        baseUrl: 'https://api.nansen.ai'
      });
    });

    it('should display login instructions with --human flag', async () => {
      const mockApi = { getAccount: vi.fn().mockResolvedValue({ plan: 'pro', credits_remaining: 100 }) };
      mockDeps.NansenAPIClass.mockImplementation(function() { return mockApi; });
      mockDeps.promptFn.mockResolvedValue('some-key');
      const savedEnv = process.env.NANSEN_API_KEY;
      delete process.env.NANSEN_API_KEY;

      await commands.login([], null, { human: true }, {});

      if (savedEnv !== undefined) process.env.NANSEN_API_KEY = savedEnv;
      expect(logs.some(l => l.includes('Nansen CLI Login'))).toBe(true);
      expect(logs.some(l => l.includes('https://app.nansen.ai/auth/agent-setup'))).toBe(true);
    });

    it('should save config with --api-key option', async () => {
      const mockApi = { getAccount: vi.fn().mockResolvedValue({ plan: 'pro', credits_remaining: 100 }) };
      mockDeps.NansenAPIClass.mockImplementation(function() { return mockApi; });

      await commands.login([], null, {}, { 'api-key': 'test-key' });

      expect(mockDeps.saveConfigFn).toHaveBeenCalledWith({
        apiKey: 'test-key',
        baseUrl: 'https://api.nansen.ai'
      });
      expect(logs.some(l => l.includes('Saved to'))).toBe(true);
    });

    it('should exit when no API key available', async () => {
      const savedEnv = process.env.NANSEN_API_KEY;
      delete process.env.NANSEN_API_KEY;
      try {
        const err = await commands.login([], null, {}, {}).catch(e => e);
        expect(err.code).toBe('API_KEY_REQUIRED');
      } finally {
        if (savedEnv !== undefined) process.env.NANSEN_API_KEY = savedEnv;
      }
    });
  });

  describe('logout command', () => {
    it('should call deleteConfig', async () => {
      mockDeps.deleteConfigFn.mockReturnValue(true);
      await commands.logout([], null, {}, {});
      
      expect(mockDeps.deleteConfigFn).toHaveBeenCalled();
    });

    it('should show success message when config deleted', async () => {
      mockDeps.deleteConfigFn.mockReturnValue(true);
      await commands.logout([], null, {}, {});
      
      expect(logs.some(l => l.includes('Removed'))).toBe(true);
      expect(logs.some(l => l.includes('/home/user/.nansen/config.json'))).toBe(true);
    });

    it('should show message when no config exists', async () => {
      mockDeps.deleteConfigFn.mockReturnValue(false);
      await commands.logout([], null, {}, {});
      
      expect(logs.some(l => l.includes('No saved credentials'))).toBe(true);
    });
  });
});

// =================== Schema Command ===================

describe('SCHEMA', () => {
  it('should have version number', () => {
    expect(SCHEMA.version).toBeDefined();
    expect(SCHEMA.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('should define all main commands under research', () => {
    const r = SCHEMA.commands.research.subcommands;
    expect(r['smart-money']).toBeDefined();
    expect(r['profiler']).toBeDefined();
    expect(r['token']).toBeDefined();
    expect(r['portfolio']).toBeDefined();
    expect(r['prediction-market']).toBeDefined();
  });

  it('should define subcommands for smart-money', () => {
    const sm = SCHEMA.commands.research.subcommands['smart-money'];
    expect(sm.subcommands['netflow']).toBeDefined();
    expect(sm.subcommands['dex-trades']).toBeDefined();
    expect(sm.subcommands['holdings']).toBeDefined();
    expect(sm.subcommands['perp-trades']).toBeDefined();
    expect(sm.subcommands['dcas']).toBeDefined();
    expect(sm.subcommands['historical-holdings']).toBeDefined();
  });

  it('should define subcommands for profiler', () => {
    const profiler = SCHEMA.commands.research.subcommands['profiler'];
    expect(profiler.subcommands['balance']).toBeDefined();
    expect(profiler.subcommands['labels']).toBeDefined();
    expect(profiler.subcommands['transactions']).toBeDefined();
    expect(profiler.subcommands['pnl']).toBeDefined();
    expect(profiler.subcommands['search']).toBeDefined();
  });

  it('should define subcommands for token', () => {
    const token = SCHEMA.commands.research.subcommands['token'];
    expect(token.subcommands['screener']).toBeDefined();
    expect(token.subcommands['holders']).toBeDefined();
    expect(token.subcommands['flows']).toBeDefined();
    expect(token.subcommands['pnl']).toBeDefined();
    expect(token.subcommands['perp-trades']).toBeDefined();
  });

  it('should define subcommands for prediction-market', () => {
    const pm = SCHEMA.commands.research.subcommands['prediction-market'];
    expect(pm.subcommands['ohlcv']).toBeDefined();
    expect(pm.subcommands['orderbook']).toBeDefined();
    expect(pm.subcommands['top-holders']).toBeDefined();
    expect(pm.subcommands['trades-by-market']).toBeDefined();
    expect(pm.subcommands['trades-by-address']).toBeDefined();
    expect(pm.subcommands['market-screener']).toBeDefined();
    expect(pm.subcommands['event-screener']).toBeDefined();
    expect(pm.subcommands['pnl-by-market']).toBeDefined();
    expect(pm.subcommands['pnl-by-address']).toBeDefined();
    expect(pm.subcommands['position-detail']).toBeDefined();
    expect(pm.subcommands['categories']).toBeDefined();
  });

  it('should have required market-id option for pm market endpoints', () => {
    const ohlcv = SCHEMA.commands.research.subcommands['prediction-market'].subcommands['ohlcv'];
    expect(ohlcv.options['market-id'].required).toBe(true);
    // Note: type removed in minimal schema (skills document types)
  });

  it('should have required address option for pm address endpoints', () => {
    const trades = SCHEMA.commands.research.subcommands['prediction-market'].subcommands['trades-by-address'];
    expect(trades.options.address.required).toBe(true);
  });

  it('splits --tags CSV into an array for market-screener', async () => {
    const mockApi = { pmMarketScreener: vi.fn().mockResolvedValue({ markets: [] }) };
    const commands = buildCommands({});
    await commands['prediction-market'](['market-screener'], mockApi, {}, { tags: 'defi,nft' });
    expect(mockApi.pmMarketScreener).toHaveBeenCalledWith(expect.objectContaining({
      tags: ['defi', 'nft'],
    }));
  });

  it('rejects non-string --tags (JSON-primitive) with INVALID_PARAMS instead of crashing', async () => {
    const mockApi = { pmMarketScreener: vi.fn().mockResolvedValue({ markets: [] }) };
    const commands = buildCommands({});
    await expect(
      commands['prediction-market'](['market-screener'], mockApi, {}, { tags: true })
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_PARAMS });
  });

  it('accepts a repeated --tags flag (parseArgs array) instead of rejecting it as non-string', async () => {
    const mockApi = { pmMarketScreener: vi.fn().mockResolvedValue({ markets: [] }) };
    const commands = buildCommands({});
    await commands['prediction-market'](['market-screener'], mockApi, {}, { tags: ['defi', 'nft'] });
    expect(mockApi.pmMarketScreener).toHaveBeenCalledWith(expect.objectContaining({
      tags: ['defi', 'nft'],
    }));
  });

  it('rejects a non-string element in a repeated --tags flag', async () => {
    const mockApi = { pmMarketScreener: vi.fn().mockResolvedValue({ markets: [] }) };
    const commands = buildCommands({});
    await expect(
      commands['prediction-market'](['market-screener'], mockApi, {}, { tags: ['defi', true] })
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_PARAMS });
  });

  // Note: returns removed in minimal schema (skills document output fields)

  it('should include option defaults', () => {
    const netflow = SCHEMA.commands.research.subcommands['smart-money'].subcommands['netflow'];
    // Note: type removed in minimal schema (skills document types)
    expect(netflow.options.chain.default).toBe('solana');
  });

  it('should include required flag for required options', () => {
    const balance = SCHEMA.commands.research.subcommands['profiler'].subcommands['balance'];
    expect(balance.options.address.required).toBe(true);
  });

  // Note: returns removed in minimal schema (skills document output fields)

  it('should define global options', () => {
    expect(SCHEMA.globalOptions.pretty).toBeDefined();
    expect(SCHEMA.globalOptions.table).toBeDefined();
    expect(SCHEMA.globalOptions.fields).toBeDefined();
    expect(SCHEMA.globalOptions['no-retry']).toBeDefined();

  });

  it('should list supported chains', () => {
    expect(SCHEMA.chains).toContain('ethereum');
    expect(SCHEMA.chains).toContain('solana');
    expect(SCHEMA.chains).toContain('base');
    expect(SCHEMA.chains.length).toBeGreaterThan(10);
  });

  it('schema.json chains should be a superset of EVM_CHAINS', () => {
    for (const chain of EVM_CHAINS) {
      expect(SCHEMA.chains, `EVM_CHAINS has "${chain}" but schema.json does not`).toContain(chain);
    }
  });

  it('EVM transfer chain IDs should only contain recognized EVM chains', () => {
    for (const chain of Object.keys(EVM_CHAIN_IDS)) {
      expect(EVM_CHAINS, `EVM_CHAIN_IDS has orphaned "${chain}"`).toContain(chain);
    }
  });

  it('schema.json chains should cover the batch counterparties endpoint', () => {
    for (const chain of COUNTERPARTIES_BATCH_CHAINS) {
      if (chain === 'all') continue;
      expect(SCHEMA.chains, `COUNTERPARTIES_BATCH_CHAINS has "${chain}" but schema.json does not`).toContain(chain);
    }
  });

  it('should list smart money labels', () => {
    expect(SCHEMA.smartMoneyLabels).toContain('Fund');
    expect(SCHEMA.smartMoneyLabels).toContain('Smart Trader');
  });
});

describe('schema command', () => {
  let outputs;
  let mockDeps;

  beforeEach(() => {
    outputs = [];
    mockDeps = {
      output: (msg) => outputs.push(msg),
      errorOutput: (msg) => outputs.push(msg),
      exit: vi.fn()
    };
  });

  it('should return full schema without subcommand', async () => {
    const result = await runCLI(['schema'], mockDeps);
    
    expect(result.type).toBe('schema');
    expect(result.data.version).toBeDefined();
    expect(result.data.commands).toBeDefined();
  });

  it('should return specific command schema', async () => {
    const commands = buildCommands({});
    const result = await commands.schema(['smart-money'], null, {}, {});
    
    expect(result.command).toBe('smart-money');
    expect(result.subcommands).toBeDefined();
    expect(result.globalOptions).toBeDefined();
  });

  it('should return full schema for unknown command', async () => {
    const commands = buildCommands({});
    const result = await commands.schema(['unknown'], null, {}, {});
    
    // Returns full schema when command not found
    expect(result.version).toBeDefined();
    expect(result.commands).toBeDefined();
  });

  it('should output JSON', async () => {
    await runCLI(['schema'], mockDeps);
    
    const output = outputs[0];
    expect(() => JSON.parse(output)).not.toThrow();
    const parsed = JSON.parse(output);
    expect(parsed.version).toBeDefined();
  });

  it('should output pretty JSON with --pretty', async () => {
    await runCLI(['schema', '--pretty'], mockDeps);
    
    const output = outputs[0];
    expect(output).toContain('\n'); // Pretty JSON has newlines
  });

});

// =================== Field Filtering ===================

describe('parseFields', () => {
  it('should parse comma-separated fields', () => {
    const result = parseFields('address,value_usd,pnl_usd');
    expect(result).toEqual(['address', 'value_usd', 'pnl_usd']);
  });

  it('should trim whitespace', () => {
    const result = parseFields('address , value_usd , pnl_usd');
    expect(result).toEqual(['address', 'value_usd', 'pnl_usd']);
  });

  it('should filter empty fields', () => {
    const result = parseFields('address,,value_usd,');
    expect(result).toEqual(['address', 'value_usd']);
  });

  it('should return null for undefined input', () => {
    expect(parseFields(undefined)).toBeNull();
  });

  it('should return null for empty string', () => {
    expect(parseFields('')).toBeNull();
  });

  it('should handle single field', () => {
    const result = parseFields('address');
    expect(result).toEqual(['address']);
  });

  it('rejects a non-string value (JSON-primitive) with INVALID_PARAMS instead of crashing', () => {
    expect(() => parseFields(true)).toThrowError(
      expect.objectContaining({ code: ErrorCode.INVALID_PARAMS })
    );
  });

  it('rejects falsy non-string values (--fields false / --fields null) instead of silently returning null', () => {
    expect(() => parseFields(false)).toThrowError(
      expect.objectContaining({ code: ErrorCode.INVALID_PARAMS })
    );
    expect(() => parseFields(null)).toThrowError(
      expect.objectContaining({ code: ErrorCode.INVALID_PARAMS })
    );
  });
});

describe('filterFields', () => {
  it('should filter object to specified fields', () => {
    const data = { address: '0x123', value_usd: 1000, pnl_usd: 50, extra: 'ignored' };
    const result = filterFields(data, ['address', 'value_usd']);
    
    expect(result).toEqual({ address: '0x123', value_usd: 1000 });
    expect(result.extra).toBeUndefined();
    expect(result.pnl_usd).toBeUndefined();
  });

  it('should filter array of objects', () => {
    const data = [
      { address: '0x1', value: 100, extra: 'a' },
      { address: '0x2', value: 200, extra: 'b' }
    ];
    const result = filterFields(data, ['address', 'value']);
    
    expect(result).toEqual([
      { address: '0x1', value: 100 },
      { address: '0x2', value: 200 }
    ]);
  });

  it('should handle nested objects', () => {
    const data = {
      results: [
        { address: '0x1', value: 100 },
        { address: '0x2', value: 200 }
      ],
      pagination: { page: 1 }
    };
    const result = filterFields(data, ['address', 'value']);
    
    expect(result.results).toBeDefined();
    expect(result.results[0].address).toBe('0x1');
    expect(result.results[0].value).toBe(100);
  });

  it('should return original data when fields is empty', () => {
    const data = { a: 1, b: 2 };
    expect(filterFields(data, [])).toEqual(data);
  });

  it('should return original data when fields is null', () => {
    const data = { a: 1, b: 2 };
    expect(filterFields(data, null)).toEqual(data);
  });

  it('should handle null values', () => {
    const data = { address: '0x1', value: null };
    const result = filterFields(data, ['address', 'value']);
    expect(result).toEqual({ address: '0x1', value: null });
  });

  it('should handle deeply nested structures', () => {
    const data = {
      data: {
        results: [
          { token_symbol: 'ETH', price_usd: 3000, ignored: true }
        ]
      }
    };
    const result = filterFields(data, ['token_symbol', 'price_usd']);
    
    expect(result.data.results[0].token_symbol).toBe('ETH');
    expect(result.data.results[0].price_usd).toBe(3000);
    expect(result.data.results[0].ignored).toBeUndefined();
  });
});

describe('filterFields with dotted paths', () => {
  const data = {
    data: {
      results: [
        { address: '0x1', value: 100, meta: { chain: 'ethereum', tag: 'a' } },
        { address: '0x2', value: 200, meta: { chain: 'base', tag: 'b' } },
      ],
      total: 2,
    },
    pagination: { page: 1, address: 'not-a-wallet' },
  };

  it('selects a nested path exactly, dropping its siblings', () => {
    expect(filterFields(data, ['data.results'])).toEqual({ data: { results: data.data.results } });
  });

  it('selects a field inside array items by path without touching same-named keys elsewhere', () => {
    expect(filterFields(data, ['data.results.address'])).toEqual({
      data: { results: [{ address: '0x1' }, { address: '0x2' }] },
    });
  });

  it('accepts sibling paths and deeper paths together', () => {
    expect(filterFields(data, ['data.results.value', 'data.results.meta.chain', 'data.total'])).toEqual({
      data: {
        results: [
          { value: 100, meta: { chain: 'ethereum' } },
          { value: 200, meta: { chain: 'base' } },
        ],
        total: 2,
      },
    });
  });

  it('keeps matching a bare name at any depth', () => {
    expect(filterFields(data, ['address'])).toEqual({
      data: { results: [{ address: '0x1' }, { address: '0x2' }] },
      pagination: { address: 'not-a-wallet' },
    });
  });

  it('does not match a path at a different depth', () => {
    expect(filterFields(data, ['results.address'])).toEqual({});
    expect(filterFields(data, ['data.results.meta.address'])).toEqual({});
  });

  it('mixes bare names and paths', () => {
    expect(filterFields(data, ['data.total', 'page'])).toEqual({
      data: { total: 2 },
      pagination: { page: 1 },
    });
  });
});

describe('--fields flag integration', () => {
  let outputs;
  let errors;
  let _exitCode;

  const mockDeps = () => ({
    output: (msg) => outputs.push(msg),
    errorOutput: (msg) => errors.push(msg),
    exit: (code) => { _exitCode = code; }
  });

  beforeEach(() => {
    outputs = [];
    errors = [];
    _exitCode = null;
  });

  it('should filter response fields', async () => {
    const deps = {
      ...mockDeps(),
      NansenAPIClass: function MockAPI() {
        this.smartMoneyNetflow = vi.fn().mockResolvedValue([
          { token_symbol: 'SOL', value_usd: 1000, extra_field: 'ignored', chain: 'solana' }
        ]);
      }
    };
    
    await runCLI(['smart-money', 'netflow', '--fields', 'token_symbol,value_usd'], deps);
    
    const output = JSON.parse(outputs[0]);
    expect(output.success).toBe(true);
    expect(output.data[0].token_symbol).toBe('SOL');
    expect(output.data[0].value_usd).toBe(1000);
    expect(output.data[0].extra_field).toBeUndefined();
    expect(output.data[0].chain).toBeUndefined();
  });

  it('should work with nested response data', async () => {
    const deps = {
      ...mockDeps(),
      NansenAPIClass: function MockAPI() {
        this.smartMoneyNetflow = vi.fn().mockResolvedValue({
          results: [
            { symbol: 'BTC', price: 50000, volume: 1000000 }
          ],
          meta: { page: 1 }
        });
      }
    };
    
    await runCLI(['smart-money', 'netflow', '--fields', 'symbol,price'], deps);
    
    const output = JSON.parse(outputs[0]);
    expect(output.data.results[0].symbol).toBe('BTC');
    expect(output.data.results[0].price).toBe(50000);
    expect(output.data.results[0].volume).toBeUndefined();
  });

  it('should work with --pretty flag', async () => {
    const deps = {
      ...mockDeps(),
      NansenAPIClass: function MockAPI() {
        this.smartMoneyNetflow = vi.fn().mockResolvedValue([{ symbol: 'ETH' }]);
      }
    };
    
    await runCLI(['smart-money', 'netflow', '--fields', 'symbol', '--pretty'], deps);
    
    expect(outputs[0]).toContain('\n'); // Pretty formatting
  });
});

// =================== Response Caching ===================

describe('Response Caching', () => {
  const testEndpoint = '/test/endpoint';
  const testBody = { test: true };
  const testData = { result: 'cached data' };

  beforeEach(() => {
    // Clear cache before each test
    clearCache();
  });

  afterEach(() => {
    // Clean up after tests
    clearCache();
  });

  describe('getCachedResponse', () => {
    it('should return null for uncached endpoint', () => {
      const result = getCachedResponse('/uncached/endpoint', {});
      expect(result).toBeNull();
    });

    it('should return cached data when valid', () => {
      setCachedResponse(testEndpoint, testBody, testData);
      const result = getCachedResponse(testEndpoint, testBody, 300);
      
      expect(result.result).toBe('cached data');
      expect(result._meta.fromCache).toBe(true);
      expect(result._meta.cacheAge).toBeDefined();
    });

    it('should return null for expired cache', async () => {
      setCachedResponse(testEndpoint, testBody, testData);
      
      // Use very short TTL to simulate expiry
      const result = getCachedResponse(testEndpoint, testBody, 0);
      expect(result).toBeNull();
    });

    it('should use different keys for different bodies', () => {
      setCachedResponse(testEndpoint, { a: 1 }, { data: 'first' });
      setCachedResponse(testEndpoint, { a: 2 }, { data: 'second' });
      
      const result1 = getCachedResponse(testEndpoint, { a: 1 }, 300);
      const result2 = getCachedResponse(testEndpoint, { a: 2 }, 300);
      
      expect(result1.data).toBe('first');
      expect(result2.data).toBe('second');
    });
  });

  describe('setCachedResponse', () => {
    it('should create cache directory if not exists', () => {
      const cacheDir = getCacheDir();
      // Clear the directory first
      if (fs.existsSync(cacheDir)) {
        fs.rmSync(cacheDir, { recursive: true });
      }
      
      setCachedResponse(testEndpoint, testBody, testData);
      
      expect(fs.existsSync(cacheDir)).toBe(true);
    });

    it('should write cache file', () => {
      setCachedResponse(testEndpoint, testBody, testData);
      
      const cacheDir = getCacheDir();
      const files = fs.readdirSync(cacheDir).filter(f => f.endsWith('.json'));
      expect(files.length).toBeGreaterThan(0);
    });
  });

  describe('clearCache', () => {
    it('should remove all cached responses', () => {
      setCachedResponse('/endpoint/1', {}, { data: 1 });
      setCachedResponse('/endpoint/2', {}, { data: 2 });
      setCachedResponse('/endpoint/3', {}, { data: 3 });
      
      const count = clearCache();
      
      expect(count).toBe(3);
      expect(getCachedResponse('/endpoint/1', {}, 300)).toBeNull();
    });

    it('should return 0 for empty cache', () => {
      const count = clearCache();
      expect(count).toBe(0);
    });
  });
});

describe('cache isolation by request context', () => {
  afterEach(() => {
    clearCache();
  });

  const endpoint = '/api/v1/some/endpoint';
  const body = { foo: 'bar' };

  const contextA = {
    baseUrl: 'https://a.example',
    method: 'POST',
    identity: 'identity-a',
  };
  const contextB = {
    baseUrl: 'https://b.example',
    method: 'POST',
    identity: 'identity-b',
  };

  it('does not serve one identity\'s cached response to another', () => {
    setCachedResponse(endpoint, body, { secret: 'A' }, contextA);

    expect(getCachedResponse(endpoint, body, 300, contextB)).toBeNull();

    const hit = getCachedResponse(endpoint, body, 300, contextA);
    expect(hit.secret).toBe('A');
  });

  it('treats a different base URL as a different cache entry', () => {
    setCachedResponse(endpoint, body, { origin: 'A' }, contextA);
    const differentOrigin = { ...contextA, baseUrl: 'https://other.example' };
    expect(getCachedResponse(endpoint, body, 300, differentOrigin)).toBeNull();
  });

  it('treats a different HTTP method as a different cache entry', () => {
    setCachedResponse(endpoint, body, { m: 'POST' }, contextA);
    const differentMethod = { ...contextA, method: 'GET' };
    expect(getCachedResponse(endpoint, body, 300, differentMethod)).toBeNull();
  });
});

describe('computeIdentityDigest', () => {
  it('returns distinct digests for distinct API keys', () => {
    const a = computeIdentityDigest('key-a');
    const b = computeIdentityDigest('key-b');
    expect(a).not.toBe(b);
  });

  it('returns the same digest for the same API key (deterministic)', () => {
    expect(computeIdentityDigest('key-x')).toBe(computeIdentityDigest('key-x'));
  });

  it('ignores auth header insertion order', () => {
    const first = computeIdentityDigest(null, {
      apikey: 'key-x',
      authorization: 'Bearer token',
      'payment-signature': 'signature',
    });
    const second = computeIdentityDigest(null, {
      'payment-signature': 'signature',
      authorization: 'Bearer token',
      apikey: 'key-x',
    });
    expect(first).toBe(second);
  });

  it('returns distinct digests for distinct auth headers', () => {
    const a = computeIdentityDigest(null, { apikey: 'hdr-a' });
    const b = computeIdentityDigest(null, { apikey: 'hdr-b' });
    expect(a).not.toBe(b);
  });

  it('does not include the raw API key in the digest string', () => {
    const digest = computeIdentityDigest('super-secret-key');
    expect(digest).not.toContain('super-secret-key');
  });
});

// compareSemver's own unit tests live in src/__tests__/semver.test.js
// (its canonical home, src/semver.js). What belongs here is the CLI
// command's behavior — that --since is validated and filters correctly —
// not a re-test of the comparison function's arithmetic.
describe('changelog command --since', () => {
  function runChangelog(options) {
    const logs = [];
    const commands = buildCommands({ log: (m) => logs.push(m), exit: vi.fn() });
    return commands.changelog([], null, {}, options).then(() => logs.join('\n'));
  }

  it('rejects a non-numeric --since value with a clear error instead of silently matching nothing', async () => {
    await expect(runChangelog({ since: 'abc' })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      message: 'Invalid --since value "abc": expected a version like 1.43 or 1.43.0.',
    });
  });

  it('rejects a malformed --since value like "1.2.3.4"', async () => {
    await expect(runChangelog({ since: '1.2.3.4' })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      message: 'Invalid --since value "1.2.3.4": expected a version like 1.43 or 1.43.0.',
    });
  });

  it('a --since value missing the patch component reads as .0, not as always-less-than-everything (regression for the "1.43 vs 1.43.1" bug)', async () => {
    // Read the real CHANGELOG.md the command itself reads, and use whatever
    // its current newest version's major.minor happens to be, so this
    // doesn't hardcode a version number that goes stale as new releases
    // land. The exact patch number doesn't matter here — only that a
    // major.minor-only --since behaves like its explicit ".0" form.
    const changelogPath = new URL('../../CHANGELOG.md', import.meta.url).pathname;
    const content = fs.readFileSync(changelogPath, 'utf8');
    const headingMatch = content.match(/^## \[?(\d+\.\d+)\.\d+\]?/m);
    expect(headingMatch).not.toBeNull();
    const [, majorMinor] = headingMatch;

    const explicitZeroForm = await runChangelog({ since: `${majorMinor}.0` });
    const partialForm = await runChangelog({ since: majorMinor });

    // Before the fix this always fell through to the "No changelog entries
    // found" message, because compareSemver compared the real patch number
    // against `undefined` and that is never >= 0 in either direction — so a
    // major.minor-only --since matched nothing, even entries for that exact
    // major.minor.
    //
    // Assert on structure (the newest version's heading is present) rather
    // than on the absence of the no-match sentinel string: a real changelog
    // entry's prose can legitimately quote "No changelog entries found"
    // (e.g. the entry that documents this very fix), so checking for that
    // substring is a false positive waiting to happen. The heading only
    // appears when entries were actually included, and the no-match message
    // is a single line with no "## " heading.
    expect(partialForm).toContain(`## ${majorMinor}.`);
    expect(partialForm).toBe(explicitZeroForm);
  });

  it('a --since value far in the future still reports the no-match message clearly (not an error)', async () => {
    const out = await runChangelog({ since: '9999.0.0' });
    expect(out).toBe('No changelog entries found for versions >= 9999.0.0');
  });
});

describe('cache command', () => {
  it('should clear cache with clear subcommand', async () => {
    const logs = [];
    const mockDeps = {
      log: (msg) => logs.push(msg),
      exit: vi.fn()
    };
    const commands = buildCommands(mockDeps);
    
    // Add some cache entries first
    setCachedResponse('/test/1', {}, { data: 1 });
    setCachedResponse('/test/2', {}, { data: 2 });
    
    await commands.cache(['clear'], null, {}, {});
    
    expect(logs.some(l => l.includes('Cleared 2'))).toBe(true);
  });

  it('should show help for unknown subcommand', async () => {
    const logs = [];
    const mockDeps = {
      log: (msg) => logs.push(msg),
      exit: vi.fn()
    };
    const commands = buildCommands(mockDeps);
    
    await commands.cache(['unknown'], null, {}, {});
    
    expect(logs.some(l => l.includes('Unknown cache subcommand'))).toBe(true);
  });
});

describe('--cache flag integration', () => {
  let outputs;
  let _exitCode;

  const mockDeps = () => ({
    output: (msg) => outputs.push(msg),
    errorOutput: (msg) => outputs.push(msg),
    exit: (code) => { _exitCode = code; }
  });

  beforeEach(() => {
    outputs = [];
    _exitCode = null;
    clearCache();
  });

  afterEach(() => {
    clearCache();
  });

  it('should pass cache options to API when --cache flag used', async () => {
    let capturedOptions;
    const deps = {
      ...mockDeps(),
      NansenAPIClass: function MockAPI(key, url, opts) {
        capturedOptions = opts;
        this.smartMoneyNetflow = vi.fn().mockResolvedValue({ data: [] });
      }
    };
    
    await runCLI(['smart-money', 'netflow', '--cache'], deps);
    
    expect(capturedOptions.cache.enabled).toBe(true);
  });

  it('should use custom TTL when --cache-ttl specified', async () => {
    let capturedOptions;
    const deps = {
      ...mockDeps(),
      NansenAPIClass: function MockAPI(key, url, opts) {
        capturedOptions = opts;
        this.smartMoneyNetflow = vi.fn().mockResolvedValue({ data: [] });
      }
    };
    
    await runCLI(['smart-money', 'netflow', '--cache', '--cache-ttl', '60'], deps);
    
    expect(capturedOptions.cache.ttl).toBe(60);
  });

  it.each(['-1', '1.5', 'NaN', 'Infinity', '9007199254740992'])(
    'should reject invalid --cache-ttl value %s before constructing the API client',
    async (value) => {
      const NansenAPIClass = vi.fn();

      const result = await runCLI(
        ['smart-money', 'netflow', '--cache', '--cache-ttl', value],
        { ...mockDeps(), NansenAPIClass },
      );

      expect(result).toMatchObject({
        type: 'error',
        data: {
          error: `--cache-ttl must be a non-negative safe integer; received: ${value}`,
          code: ErrorCode.INVALID_PARAMS,
        },
      });
      expect(NansenAPIClass).not.toHaveBeenCalled();
      expect(_exitCode).toBe(1);
    },
  );

  it('should reject --cache-ttl without a value before constructing the API client', async () => {
    const NansenAPIClass = vi.fn();

    const result = await runCLI(
      ['smart-money', 'netflow', '--cache', '--cache-ttl'],
      { ...mockDeps(), NansenAPIClass },
    );

    expect(result.data.error).toBe('--cache-ttl requires a non-negative safe integer value');
    expect(result.data.code).toBe(ErrorCode.INVALID_PARAMS);
    expect(NansenAPIClass).not.toHaveBeenCalled();
    expect(_exitCode).toBe(1);
  });

  it.each([
    ['--cache-ttl', '60', '--cache-ttl'],
    ['--cache-ttl', '--cache-ttl', '60'],
  ])('should reject a valueless repeated --cache-ttl occurrence: %s %s %s', async (...ttlArgs) => {
    const NansenAPIClass = vi.fn();

    const result = await runCLI(
      ['smart-money', 'netflow', '--cache', ...ttlArgs],
      { ...mockDeps(), NansenAPIClass },
    );

    expect(result.data.error).toBe('--cache-ttl requires a non-negative safe integer value');
    expect(result.data.code).toBe(ErrorCode.INVALID_PARAMS);
    expect(NansenAPIClass).not.toHaveBeenCalled();
  });

  it('should reject repeated valued --cache-ttl options clearly', async () => {
    const NansenAPIClass = vi.fn();

    const result = await runCLI(
      ['smart-money', 'netflow', '--cache', '--cache-ttl', '60', '--cache-ttl', '120'],
      { ...mockDeps(), NansenAPIClass },
    );

    expect(result.data.error).toBe('--cache-ttl may only be specified once');
    expect(result.data.code).toBe(ErrorCode.INVALID_PARAMS);
    expect(NansenAPIClass).not.toHaveBeenCalled();
  });

  it.each(['', '   '])('should reject empty --cache-ttl value %#', async (value) => {
    const NansenAPIClass = vi.fn();

    const result = await runCLI(
      ['smart-money', 'netflow', '--cache', '--cache-ttl', value],
      { ...mockDeps(), NansenAPIClass },
    );

    expect(result.data.error).toBe('--cache-ttl requires a non-negative safe integer value');
    expect(result.data.code).toBe(ErrorCode.INVALID_PARAMS);
    expect(NansenAPIClass).not.toHaveBeenCalled();
  });

  it('should validate --cache-ttl even when cache is not enabled', async () => {
    const NansenAPIClass = vi.fn();

    const result = await runCLI(
      ['smart-money', 'netflow', '--cache-ttl', 'Infinity'],
      { ...mockDeps(), NansenAPIClass },
    );

    expect(result.data.code).toBe(ErrorCode.INVALID_PARAMS);
    expect(NansenAPIClass).not.toHaveBeenCalled();
  });

  it('should validate --cache-ttl even when --no-cache overrides it', async () => {
    const NansenAPIClass = vi.fn();

    const result = await runCLI(
      ['smart-money', 'netflow', '--no-cache', '--cache-ttl', '-1'],
      { ...mockDeps(), NansenAPIClass },
    );

    expect(result.data.error).toBe('--cache-ttl must be a non-negative safe integer; received: -1');
    expect(result.data.code).toBe(ErrorCode.INVALID_PARAMS);
    expect(NansenAPIClass).not.toHaveBeenCalled();
  });

  it.each([
    ['0', 0],
    ['9007199254740991', Number.MAX_SAFE_INTEGER],
  ])('should allow --cache-ttl boundary value %s', async (value, expected) => {
    let capturedOptions;
    const deps = {
      ...mockDeps(),
      NansenAPIClass: function MockAPI(key, url, opts) {
        capturedOptions = opts;
        this.smartMoneyNetflow = vi.fn().mockResolvedValue({ data: [] });
      },
    };

    await runCLI(['smart-money', 'netflow', '--cache', '--cache-ttl', value], deps);

    expect(capturedOptions.cache.ttl).toBe(expected);
  });

  it('should describe cache TTL numeric boundaries in the schema', () => {
    expect(SCHEMA.globalOptions['cache-ttl']).toMatchObject({
      type: 'integer',
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
    });
  });

  it('should not enable cache by default', async () => {
    let capturedOptions;
    const deps = {
      ...mockDeps(),
      NansenAPIClass: function MockAPI(key, url, opts) {
        capturedOptions = opts;
        this.smartMoneyNetflow = vi.fn().mockResolvedValue({ data: [] });
      }
    };
    
    await runCLI(['smart-money', 'netflow'], deps);
    
    expect(capturedOptions.cache.enabled).toBeFalsy();
  });
});

// =================== Streaming Output (NDJSON) ===================

describe('formatStream', () => {
  it('should output array as JSON lines', () => {
    const data = [
      { symbol: 'SOL', value: 100 },
      { symbol: 'ETH', value: 200 },
      { symbol: 'BTC', value: 300 }
    ];
    const result = formatStream(data);
    const lines = result.split('\n');
    
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0])).toEqual({ symbol: 'SOL', value: 100 });
    expect(JSON.parse(lines[1])).toEqual({ symbol: 'ETH', value: 200 });
    expect(JSON.parse(lines[2])).toEqual({ symbol: 'BTC', value: 300 });
  });

  it('should extract data from nested response', () => {
    const response = {
      data: [
        { token: 'A' },
        { token: 'B' }
      ]
    };
    const result = formatStream(response);
    const lines = result.split('\n');
    
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).token).toBe('A');
  });

  it('should extract from results field', () => {
    const response = {
      results: [{ id: 1 }, { id: 2 }]
    };
    const result = formatStream(response);
    const lines = result.split('\n');
    
    expect(lines).toHaveLength(2);
  });

  it('should extract from nested data.results', () => {
    const response = {
      data: {
        results: [{ x: 1 }]
      }
    };
    const result = formatStream(response);
    expect(JSON.parse(result).x).toBe(1);
  });

  it('should handle single object', () => {
    const data = { single: true, value: 42 };
    const result = formatStream(data);
    
    expect(JSON.parse(result)).toEqual({ single: true, value: 42 });
  });

  it('should keep a failed envelope with row-like data on one JSON line', () => {
    const failure = { success: false, error: 'partial failure', data: [{ id: 1 }, { id: 2 }] };
    const result = formatStream(failure);

    expect(result).toBe(JSON.stringify(failure));
    expect(result.split('\n')).toHaveLength(1);
  });

  it('should return empty string for empty array', () => {
    expect(formatStream([])).toBe('');
  });

  it('should handle null/undefined', () => {
    expect(formatStream(null)).toBe('');
    expect(formatStream(undefined)).toBe('');
  });
});

describe('--stream flag integration', () => {
  let outputs;
  let errors;
  let _exitCode;

  const mockDeps = () => ({
    output: (msg) => outputs.push(msg),
    errorOutput: (msg) => errors.push(msg),
    exit: (code) => { _exitCode = code; }
  });

  beforeEach(() => {
    errors = [];
    outputs = [];
    _exitCode = null;
  });

  it('should output NDJSON when --stream flag used', async () => {
    const deps = {
      ...mockDeps(),
      NansenAPIClass: function MockAPI() {
        this.smartMoneyNetflow = vi.fn().mockResolvedValue([
          { symbol: 'SOL', value: 100 },
          { symbol: 'ETH', value: 200 }
        ]);
      }
    };
    
    const result = await runCLI(['smart-money', 'netflow', '--stream'], deps);
    
    expect(result.type).toBe('stream');
    const lines = outputs[0].split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).symbol).toBe('SOL');
    expect(JSON.parse(lines[1]).symbol).toBe('ETH');
  });

  it('should work with nested API response', async () => {
    const deps = {
      ...mockDeps(),
      NansenAPIClass: function MockAPI() {
        this.smartMoneyNetflow = vi.fn().mockResolvedValue({
          data: [{ token: 'ABC' }, { token: 'XYZ' }]
        });
      }
    };
    
    await runCLI(['smart-money', 'netflow', '--stream'], deps);
    
    const lines = outputs[0].split('\n');
    expect(lines).toHaveLength(2);
  });

  it('should apply field filtering before streaming', async () => {
    const deps = {
      ...mockDeps(),
      NansenAPIClass: function MockAPI() {
        this.smartMoneyNetflow = vi.fn().mockResolvedValue([
          { symbol: 'SOL', value: 100, extra: 'ignored' }
        ]);
      }
    };
    
    await runCLI(['smart-money', 'netflow', '--stream', '--fields', 'symbol'], deps);
    
    const record = JSON.parse(outputs[0]);
    expect(record.symbol).toBe('SOL');
    expect(record.extra).toBeUndefined();
  });

  it('should not wrap in success envelope', async () => {
    const deps = {
      ...mockDeps(),
      NansenAPIClass: function MockAPI() {
        this.smartMoneyNetflow = vi.fn().mockResolvedValue([{ a: 1 }]);
      }
    };
    
    await runCLI(['smart-money', 'netflow', '--stream'], deps);
    
    // Stream output should NOT have success wrapper
    const record = JSON.parse(outputs[0]);
    expect(record.success).toBeUndefined();
    expect(record.a).toBe(1);
  });
});

// =================== --from/--to Filters on Token Transfers ===================

describe('--from/--to filters on token transfers', () => {
  it('should inject --from into filters', async () => {
    const mockApi = {
      tokenTransfers: vi.fn().mockResolvedValue({ transfers: [] })
    };
    const commands = buildCommands({});
    await commands['token'](['transfers'], mockApi, {}, { token: '0xabc', from: '0xsender' });

    expect(mockApi.tokenTransfers).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: expect.objectContaining({ from_address: '0xsender' })
      })
    );
  });

  it('should inject --to into filters', async () => {
    const mockApi = {
      tokenTransfers: vi.fn().mockResolvedValue({ transfers: [] })
    };
    const commands = buildCommands({});
    await commands['token'](['transfers'], mockApi, {}, { token: '0xabc', to: '0xrecipient' });

    expect(mockApi.tokenTransfers).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: expect.objectContaining({ to_address: '0xrecipient' })
      })
    );
  });

  it('should inject both --from and --to into filters', async () => {
    const mockApi = {
      tokenTransfers: vi.fn().mockResolvedValue({ transfers: [] })
    };
    const commands = buildCommands({});
    await commands['token'](['transfers'], mockApi, {}, { token: '0xabc', from: '0xA', to: '0xB' });

    expect(mockApi.tokenTransfers).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: expect.objectContaining({ from_address: '0xA', to_address: '0xB' })
      })
    );
  });

  it('should appear in SCHEMA for token.transfers', () => {
    const transfers = SCHEMA.commands.research.subcommands['token'].subcommands['transfers'];
    expect(transfers).toBeDefined();
    // Note: from/to options removed from minimal schema (no required/default)
    // but still work at runtime via extraParams
  });
});

// =================== profiler batch ===================

describe('profiler batch command', () => {
  it('should appear in SCHEMA', () => {
    const batch = SCHEMA.commands.research.subcommands['profiler'].subcommands['batch'];
    expect(batch).toBeDefined();
    // Note: option details removed from minimal schema (skills document these)
    // but addresses/file/include still work at runtime
  });

  it('should parse comma-separated addresses', async () => {
    const mockApi = {
      addressLabels: vi.fn().mockResolvedValue({ labels: [] }),
      addressBalance: vi.fn().mockResolvedValue({ balances: [] }),
    };
    const commands = buildCommands({});
    const result = await commands['profiler'](['batch'], mockApi, {}, {
      addresses: '0x0000000000000000000000000000000000000001,0x0000000000000000000000000000000000000002',
      chain: 'ethereum',
      delay: '0'
    });

    expect(result.total).toBe(2);
    expect(mockApi.addressLabels).toHaveBeenCalledTimes(2);
    expect(mockApi.addressBalance).toHaveBeenCalledTimes(2);
  });

  it.each(['500abc', '2.5', 'abc', '9007199254740992'])(
    'should reject malformed --delay value %s before running profiler batch',
    async (delay) => {
      const mockApi = {
        addressLabels: vi.fn().mockResolvedValue({ labels: [] }),
        addressBalance: vi.fn().mockResolvedValue({ balances: [] }),
      };
      const commands = buildCommands({});

      await expect(commands['profiler'](['batch'], mockApi, {}, {
        addresses: '0x0000000000000000000000000000000000000001',
        delay,
      })).rejects.toMatchObject({
        code: ErrorCode.INVALID_PARAMS,
        message: '--delay must be a non-negative safe integer; received: ' + delay,
      });

      expect(mockApi.addressLabels).not.toHaveBeenCalled();
      expect(mockApi.addressBalance).not.toHaveBeenCalled();
    },
  );

  it('should reject negative --delay before running profiler batch', async () => {
    const mockApi = {
      addressLabels: vi.fn().mockResolvedValue({ labels: [] }),
      addressBalance: vi.fn().mockResolvedValue({ balances: [] }),
    };
    const commands = buildCommands({});

    await expect(commands['profiler'](['batch'], mockApi, {}, {
      addresses: '0x0000000000000000000000000000000000000001',
      delay: '-5',
    })).rejects.toMatchObject({
      code: ErrorCode.INVALID_PARAMS,
      message: '--delay must be a non-negative safe integer; received: -5',
    });

    expect(mockApi.addressLabels).not.toHaveBeenCalled();
    expect(mockApi.addressBalance).not.toHaveBeenCalled();
  });

  it('should reject bare --delay before running profiler batch', async () => {
    const mockApi = {
      addressLabels: vi.fn().mockResolvedValue({ labels: [] }),
      addressBalance: vi.fn().mockResolvedValue({ balances: [] }),
    };
    const commands = buildCommands({});

    await expect(commands['profiler'](['batch'], mockApi, { delay: true }, {
      addresses: '0x0000000000000000000000000000000000000001',
    })).rejects.toThrow('--delay requires a non-negative safe integer value');

    expect(mockApi.addressLabels).not.toHaveBeenCalled();
    expect(mockApi.addressBalance).not.toHaveBeenCalled();
  });

  it('should parse custom include parameter', async () => {
    const mockApi = {
      addressLabels: vi.fn().mockResolvedValue({ labels: [] }),
      addressPnl: vi.fn().mockResolvedValue({ pnl: 0 }),
    };
    const commands = buildCommands({});
    const result = await commands['profiler'](['batch'], mockApi, {}, {
      addresses: '0x0000000000000000000000000000000000000001',
      include: 'labels,pnl',
      delay: '0'
    });

    expect(result.total).toBe(1);
    expect(mockApi.addressLabels).toHaveBeenCalled();
    expect(mockApi.addressPnl).toHaveBeenCalled();
  });

  it('should be listed in profiler help', async () => {
    const commands = buildCommands({});
    const result = await commands['profiler'](['help'], null, {}, {});
    expect(result.commands).toContain('batch');
  });

  it('rejects non-string --include (JSON-primitive) with INVALID_PARAMS instead of crashing', async () => {
    const mockApi = {
      addressLabels: vi.fn().mockResolvedValue({ labels: [] }),
      addressBalance: vi.fn().mockResolvedValue({ balances: [] }),
    };
    const commands = buildCommands({});
    await expect(
      commands['profiler'](['batch'], mockApi, {}, {
        addresses: '0x0000000000000000000000000000000000000001',
        include: true,
        delay: '0'
      })
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_PARAMS });
  });

  it('falls back to the default include (labels,balance) for an empty --include, not an empty set', async () => {
    const mockApi = {
      addressLabels: vi.fn().mockResolvedValue({ labels: [] }),
      addressBalance: vi.fn().mockResolvedValue({ balances: [] }),
    };
    const commands = buildCommands({});
    await commands['profiler'](['batch'], mockApi, {}, {
      addresses: '0x0000000000000000000000000000000000000001',
      include: '',
      delay: '0'
    });
    expect(mockApi.addressLabels).toHaveBeenCalled();
    expect(mockApi.addressBalance).toHaveBeenCalled();
  });

  it('falls back to the default include for an all-commas --include (splits to blank tokens)', async () => {
    const mockApi = {
      addressLabels: vi.fn().mockResolvedValue({ labels: [] }),
      addressBalance: vi.fn().mockResolvedValue({ balances: [] }),
    };
    const commands = buildCommands({});
    await commands['profiler'](['batch'], mockApi, {}, {
      addresses: '0x0000000000000000000000000000000000000001',
      include: ',,',
      delay: '0'
    });
    expect(mockApi.addressLabels).toHaveBeenCalled();
    expect(mockApi.addressBalance).toHaveBeenCalled();
  });
});

// =================== profiler trace ===================

describe('profiler trace command', () => {
  it('should appear in SCHEMA', () => {
    const trace = SCHEMA.commands.research.subcommands['profiler'].subcommands['trace'];
    expect(trace).toBeDefined();
    expect(trace.options.address.required).toBe(true);
    expect(trace.options.depth).toMatchObject({ type: 'integer' });
    expect(trace.options.width).toBeDefined();
  });

  it('should call traceCounterparties with correct params', async () => {
    const mockApi = {
      addressCounterparties: vi.fn().mockResolvedValue({ counterparties: [] }),
    };
    const commands = buildCommands({});
    const result = await commands['profiler'](['trace'], mockApi, {}, {
      address: '0x0000000000000000000000000000000000000001',
      chain: 'ethereum',
      depth: '3',
      width: '5',
      delay: '0'
    });

    expect(result.root).toBe('0x0000000000000000000000000000000000000001');
    expect(result.depth).toBe(3);
    expect(mockApi.addressCounterparties).toHaveBeenCalledWith(expect.objectContaining({
      pagination: { page: 1, per_page: 5 },
    }));
  });

  it.each(['500abc', '2.5', 'abc', '9007199254740992'])(
    'should reject malformed --delay value %s before tracing counterparties',
    async (delay) => {
      const mockApi = {
        addressCounterparties: vi.fn().mockResolvedValue({ counterparties: [] }),
      };
      const commands = buildCommands({});

      await expect(commands['profiler'](['trace'], mockApi, {}, {
        address: '0x0000000000000000000000000000000000000001',
        delay,
      })).rejects.toMatchObject({
        code: ErrorCode.INVALID_PARAMS,
        message: '--delay must be a non-negative safe integer; received: ' + delay,
      });

      expect(mockApi.addressCounterparties).not.toHaveBeenCalled();
    },
  );

  it('should reject negative --delay before tracing counterparties', async () => {
    const mockApi = {
      addressCounterparties: vi.fn().mockResolvedValue({ counterparties: [] }),
    };
    const commands = buildCommands({});

    await expect(commands['profiler'](['trace'], mockApi, {}, {
      address: '0x0000000000000000000000000000000000000001',
      delay: '-5',
    })).rejects.toMatchObject({
      code: ErrorCode.INVALID_PARAMS,
      message: '--delay must be a non-negative safe integer; received: -5',
    });

    expect(mockApi.addressCounterparties).not.toHaveBeenCalled();
  });

  it('should reject bare --delay before tracing counterparties', async () => {
    const mockApi = {
      addressCounterparties: vi.fn().mockResolvedValue({ counterparties: [] }),
    };
    const commands = buildCommands({});

    await expect(commands['profiler'](['trace'], mockApi, { delay: true }, {
      address: '0x0000000000000000000000000000000000000001',
    })).rejects.toThrow('--delay requires a non-negative safe integer value');

    expect(mockApi.addressCounterparties).not.toHaveBeenCalled();
  });

  it('should clamp depth to 1-5 range', async () => {
    const mockApi = {
      addressCounterparties: vi.fn().mockResolvedValue({ counterparties: [] }),
    };
    const commands = buildCommands({});

    const result1 = await commands['profiler'](['trace'], mockApi, {}, {
      address: '0x0000000000000000000000000000000000000001',
      depth: '10',
      delay: '0'
    });
    expect(result1.depth).toBe(5);

    const result2 = await commands['profiler'](['trace'], mockApi, {}, {
      address: '0x0000000000000000000000000000000000000001',
      depth: '0',
      delay: '0'
    });
    expect(result2.depth).toBe(1);
  });

  it.each(['abc', '2.5', 'Infinity', '9007199254740992'])(
    'should reject malformed --depth value %s before querying counterparties',
    async (depth) => {
      const mockApi = {
        addressCounterparties: vi.fn().mockResolvedValue({ counterparties: [] }),
      };
      const commands = buildCommands({});

      await expect(commands['profiler'](['trace'], mockApi, {}, {
        address: '0x0000000000000000000000000000000000000001',
        depth,
        delay: '0',
      })).rejects.toMatchObject({
        code: ErrorCode.INVALID_PARAMS,
        message: `--depth must be a safe integer; received: ${depth}`,
      });

      expect(mockApi.addressCounterparties).not.toHaveBeenCalled();
    },
  );

  it('should reject repeated valued --depth options clearly', async () => {
    const mockApi = {
      addressCounterparties: vi.fn().mockResolvedValue({ counterparties: [] }),
    };
    const commands = buildCommands({});

    await expect(commands['profiler'](['trace'], mockApi, {}, {
      address: '0x0000000000000000000000000000000000000001',
      depth: ['2', '3'],
      delay: '0',
    })).rejects.toThrow('--depth may only be specified once');

    expect(mockApi.addressCounterparties).not.toHaveBeenCalled();
  });

  it('should reject bare --depth instead of silently using the default', async () => {
    const mockApi = {
      addressCounterparties: vi.fn().mockResolvedValue({ counterparties: [] }),
    };
    const commands = buildCommands({});

    await expect(commands['profiler'](['trace'], mockApi, { depth: true }, {
      address: '0x0000000000000000000000000000000000000001',
      delay: '0',
    })).rejects.toThrow('--depth requires a safe integer value');

    expect(mockApi.addressCounterparties).not.toHaveBeenCalled();
  });

  it.each(['abc', '2.5', 'Infinity', '9007199254740992'])(
    'should reject malformed --width value %s before querying counterparties',
    async (width) => {
      const mockApi = {
        addressCounterparties: vi.fn().mockResolvedValue({ counterparties: [] }),
      };
      const commands = buildCommands({});

      await expect(commands['profiler'](['trace'], mockApi, {}, {
        address: '0x0000000000000000000000000000000000000001',
        width,
        delay: '0',
      })).rejects.toMatchObject({
        code: ErrorCode.INVALID_PARAMS,
        message: '--width must be a non-negative safe integer; received: ' + width,
      });

      expect(mockApi.addressCounterparties).not.toHaveBeenCalled();
    },
  );

  it('should reject repeated valued --width options clearly', async () => {
    const mockApi = {
      addressCounterparties: vi.fn().mockResolvedValue({ counterparties: [] }),
    };
    const commands = buildCommands({});

    await expect(commands['profiler'](['trace'], mockApi, {}, {
      address: '0x0000000000000000000000000000000000000001',
      width: ['2', '3'],
      delay: '0',
    })).rejects.toThrow('--width may only be specified once');

    expect(mockApi.addressCounterparties).not.toHaveBeenCalled();
  });

  it('should reject negative --width before querying counterparties', async () => {
    const mockApi = {
      addressCounterparties: vi.fn().mockResolvedValue({ counterparties: [] }),
    };
    const commands = buildCommands({});

    await expect(commands['profiler'](['trace'], mockApi, {}, {
      address: '0x0000000000000000000000000000000000000001',
      width: '-1',
      delay: '0',
    })).rejects.toMatchObject({
      code: ErrorCode.INVALID_PARAMS,
      message: '--width must be a non-negative safe integer; received: -1',
    });

    expect(mockApi.addressCounterparties).not.toHaveBeenCalled();
  });

  it('should reject bare --width instead of silently using the default', async () => {
    const mockApi = {
      addressCounterparties: vi.fn().mockResolvedValue({ counterparties: [] }),
    };
    const commands = buildCommands({});

    await expect(commands['profiler'](['trace'], mockApi, { width: true }, {
      address: '0x0000000000000000000000000000000000000001',
      delay: '0',
    })).rejects.toThrow('--width requires a non-negative safe integer value');

    expect(mockApi.addressCounterparties).not.toHaveBeenCalled();
  });

  it('should be listed in profiler help', async () => {
    const commands = buildCommands({});
    const result = await commands['profiler'](['help'], null, {}, {});
    expect(result.commands).toContain('trace');
  });
});

// =================== profiler compare ===================

describe('profiler compare command', () => {
  it('should appear in SCHEMA', () => {
    const compare = SCHEMA.commands.research.subcommands['profiler'].subcommands['compare'];
    expect(compare).toBeDefined();
    expect(compare.options.addresses.required).toBe(true);
  });

  it('should parse two comma-separated addresses', async () => {
    const mockApi = {
      addressCounterparties: vi.fn().mockResolvedValue({ counterparties: [] }),
      addressBalance: vi.fn().mockResolvedValue({ balances: [] }),
    };
    const commands = buildCommands({});
    const result = await commands['profiler'](['compare'], mockApi, {}, {
      addresses: '0x0000000000000000000000000000000000000001,0x0000000000000000000000000000000000000002',
      chain: 'ethereum',
      delay: '0'
    });

    expect(result.addresses).toHaveLength(2);
    expect(mockApi.addressCounterparties).toHaveBeenCalledTimes(2);
    expect(mockApi.addressBalance).toHaveBeenCalledTimes(2);
  });

  it('should be listed in profiler help', async () => {
    const commands = buildCommands({});
    const result = await commands['profiler'](['help'], null, {}, {});
    expect(result.commands).toContain('compare');
  });
});

// =================== profiler counterparties-batch ===================

describe('profiler counterparties-batch command', () => {
  const ADDR_A = '0x0000000000000000000000000000000000000001';
  const ADDR_B = '0x0000000000000000000000000000000000000002';

  function mockBatchApi() {
    return { addressCounterpartiesBatch: vi.fn().mockResolvedValue({ pagination: {}, data: [] }) };
  }

  it('should appear in SCHEMA', () => {
    const batch = SCHEMA.commands.research.subcommands['profiler'].subcommands['counterparties-batch'];
    expect(batch).toBeDefined();
    expect(batch.endpoint).toBe('/api/v1/profiler/address/counterparties/batch');
    expect(batch.options.addresses.required).toBeUndefined();
    expect(batch.options.addresses.description).toContain('--file <path>');
    expect(batch.options.days.default).toBe(30);
    // The dispatch default is 'all', so the schema must document that, not 'ethereum'
    expect(batch.options.chain.default).toBe('all');
  });

  it('should pass comma-separated --addresses through to the batch method', async () => {
    const mockApi = mockBatchApi();
    const commands = buildCommands({});
    await commands['profiler'](['counterparties-batch'], mockApi, {}, {
      addresses: `${ADDR_A}, ${ADDR_B}`,
      chain: 'ethereum',
      days: '7',
      page: '1',
      limit: '2'
    });

    expect(mockApi.addressCounterpartiesBatch).toHaveBeenCalledWith(expect.objectContaining({
      addresses: [ADDR_A, ADDR_B],
      chain: 'ethereum',
      days: 7,
      pagination: { page: 1, per_page: 2 }
    }));
  });

  it('should send chain "all" when --chain is omitted', async () => {
    const mockApi = mockBatchApi();
    const commands = buildCommands({});
    await commands['profiler'](['counterparties-batch'], mockApi, {}, { addresses: ADDR_A });

    expect(mockApi.addressCounterpartiesBatch).toHaveBeenCalledWith(expect.objectContaining({
      addresses: [ADDR_A],
      chain: 'all'
    }));
  });

  it('should read addresses from --file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nansen-cli-test-'));
    const file = path.join(dir, 'addresses.txt');
    fs.writeFileSync(file, `${ADDR_A}\n${ADDR_B}\n`);

    try {
      const mockApi = mockBatchApi();
      const commands = buildCommands({});
      await commands['profiler'](['counterparties-batch'], mockApi, {}, { file, chain: 'ethereum' });

      expect(mockApi.addressCounterpartiesBatch).toHaveBeenCalledWith(expect.objectContaining({
        addresses: [ADDR_A, ADDR_B]
      }));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('should return the response unchanged so rows keep their wallet_address', async () => {
    const response = {
      pagination: { page: 1, per_page: 2, total_pages: 1 },
      data: [
        { wallet_address: ADDR_A, counterparty_address: '0xaaa', chain: 'ethereum', interaction_count: 3 },
        { wallet_address: ADDR_B, counterparty_address: '0xbbb', chain: 'ethereum', interaction_count: 1 }
      ]
    };
    const mockApi = {
      addressCounterpartiesBatch: vi.fn().mockResolvedValue(response),
    };
    const commands = buildCommands({});
    const result = await commands['profiler'](['counterparties-batch'], mockApi, {}, {
      addresses: `${ADDR_A},${ADDR_B}`,
      chain: 'ethereum'
    });

    expect(result).toEqual(response);
    expect(result.data.map(row => row.wallet_address)).toEqual([ADDR_A, ADDR_B]);
  });

  it('should raise an actionable error when --file does not exist', async () => {
    const missing = path.join(os.tmpdir(), 'nansen-cli-test-missing-addresses.txt');
    const commands = buildCommands({});

    await expect(
      commands['profiler'](['counterparties-batch'], mockBatchApi(), {}, { file: missing })
    ).rejects.toThrow(/Could not read --file .*: no such file/);
  });

  it('should be listed in profiler help', async () => {
    const commands = buildCommands({});
    const result = await commands['profiler'](['help'], null, {}, {});
    expect(result.commands).toContain('counterparties-batch');
  });
});

// =================== parseAddressList ===================

describe('parseAddressList', () => {
  it('should parse a JSON array string', () => {
    const result = parseAddressList('["0xAAA","0xBBB"]');
    expect(result).toEqual(['0xAAA', '0xBBB']);
  });

  it('should handle a pre-parsed array from arg parser', () => {
    const result = parseAddressList(['0xAAA', '0xBBB']);
    expect(result).toEqual(['0xAAA', '0xBBB']);
  });

  it('should parse comma-separated string', () => {
    const result = parseAddressList('0xAAA,0xBBB,0xCCC');
    expect(result).toEqual(['0xAAA', '0xBBB', '0xCCC']);
  });

  it('should trim whitespace and filter empty entries', () => {
    const result = parseAddressList(' 0xAAA , 0xBBB , ');
    expect(result).toEqual(['0xAAA', '0xBBB']);
  });

  it('should handle malformed JSON by falling back to comma split', () => {
    const result = parseAddressList('[invalid json');
    expect(result).toEqual(['[invalid json']);
  });

  it('should throw on non-array JSON values (object)', () => {
    expect(() => parseAddressList('{"a":"0xAAA"}')).toThrow('--addresses must be a comma-separated list or JSON array');
  });

  it('should throw on non-array JSON values (string)', () => {
    expect(() => parseAddressList('"0xAAA"')).toThrow('--addresses must be a comma-separated list or JSON array');
  });

  it('should throw on non-array JSON values (number)', () => {
    expect(() => parseAddressList('42')).toThrow('--addresses must be a comma-separated list or JSON array');
  });

  it('should throw on non-array JSON values (boolean)', () => {
    expect(() => parseAddressList('true')).toThrow('--addresses must be a comma-separated list or JSON array');
  });

  it('should return empty array for empty/undefined input', () => {
    expect(parseAddressList('')).toEqual([]);
    expect(parseAddressList(undefined)).toEqual([]);
  });

  it('should coerce non-string array elements to strings', () => {
    const result = parseAddressList([123, '0xBBB']);
    expect(result).toEqual(['123', '0xBBB']);
  });
});

// =================== profiler batch address parsing ===================

describe('profiler batch address parsing', () => {
  it('should handle pre-parsed array from arg parser', async () => {
    const mockApi = {
      addressLabels: vi.fn().mockResolvedValue({ labels: [] }),
      addressBalance: vi.fn().mockResolvedValue({ balances: [] }),
    };
    const commands = buildCommands({});
    const result = await commands['profiler'](['batch'], mockApi, {}, {
      addresses: ['0x0000000000000000000000000000000000000001', '0x0000000000000000000000000000000000000002'],
      chain: 'ethereum',
      delay: '0'
    });

    expect(result.total).toBe(2);
    expect(mockApi.addressLabels).toHaveBeenCalledTimes(2);
  });

  it('should handle JSON array string for addresses', async () => {
    const mockApi = {
      addressLabels: vi.fn().mockResolvedValue({ labels: [] }),
      addressBalance: vi.fn().mockResolvedValue({ balances: [] }),
    };
    const commands = buildCommands({});
    const result = await commands['profiler'](['batch'], mockApi, {}, {
      addresses: '["0x0000000000000000000000000000000000000001","0x0000000000000000000000000000000000000002"]',
      chain: 'ethereum',
      delay: '0'
    });

    expect(result.total).toBe(2);
  });

  it('should reject non-array JSON for addresses', async () => {
    const commands = buildCommands({});
    await expect(
      commands['profiler'](['batch'], {}, {}, {
        addresses: '{"addr":"0x0000000000000000000000000000000000000001"}',
        chain: 'ethereum',
        delay: '0'
      })
    ).rejects.toThrow('--addresses must be a comma-separated list or JSON array');
  });
});

// =================== profiler compare address parsing ===================

describe('profiler compare address parsing', () => {
  it('should handle pre-parsed array from arg parser', async () => {
    const mockApi = {
      addressCounterparties: vi.fn().mockResolvedValue({ counterparties: [] }),
      addressBalance: vi.fn().mockResolvedValue({ balances: [] }),
    };
    const commands = buildCommands({});
    const result = await commands['profiler'](['compare'], mockApi, {}, {
      addresses: ['0x0000000000000000000000000000000000000001', '0x0000000000000000000000000000000000000002'],
      chain: 'ethereum',
      delay: '0'
    });

    expect(result.addresses).toHaveLength(2);
  });

  it('should handle JSON array string for addresses', async () => {
    const mockApi = {
      addressCounterparties: vi.fn().mockResolvedValue({ counterparties: [] }),
      addressBalance: vi.fn().mockResolvedValue({ balances: [] }),
    };
    const commands = buildCommands({});
    const result = await commands['profiler'](['compare'], mockApi, {}, {
      addresses: '["0x0000000000000000000000000000000000000001","0x0000000000000000000000000000000000000002"]',
      chain: 'ethereum',
      delay: '0'
    });

    expect(result.addresses).toHaveLength(2);
  });

  it('should reject non-array JSON for addresses', async () => {
    const commands = buildCommands({});
    await expect(
      commands['profiler'](['compare'], {}, {}, {
        addresses: '{"addr":"0x0000000000000000000000000000000000000001"}',
        chain: 'ethereum',
        delay: '0'
      })
    ).rejects.toThrow('--addresses must be a comma-separated list or JSON array');
  });
});

// =================== --enrich Flag ===================

describe('--enrich flag on token transfers', () => {
  it('should appear in SCHEMA for token.transfers', () => {
    const transfers = SCHEMA.commands.research.subcommands['token'].subcommands['transfers'];
    expect(transfers).toBeDefined();
    // Note: enrich option removed from minimal schema (no required/default)
    // but still works at runtime via extraParams
  });

  it('should enrich transfers with labels when --enrich flag is set', async () => {
    const mockApi = {
      tokenTransfers: vi.fn().mockResolvedValue({
        transfers: [
          { from: '0xaaa', to: '0xbbb', amount_usd: 1000 }
        ]
      }),
      addressLabels: vi.fn().mockResolvedValue({ labels: ['Smart Trader'] })
    };
    const commands = buildCommands({});
    const result = await commands['token'](['transfers'], mockApi, { enrich: true }, { token: '0xabc' });

    expect(mockApi.addressLabels).toHaveBeenCalled();
    expect(result.transfers[0].from_labels).toEqual(['Smart Trader']);
    expect(result.transfers[0].to_labels).toEqual(['Smart Trader']);
  });

  it('should enrich transfers from the v1 labels response shape', async () => {
    const mockApi = {
      tokenTransfers: vi.fn().mockResolvedValue({
        transfers: [
          { from: '0xaaa', to: '0xbbb', amount_usd: 1000 }
        ]
      }),
      addressLabels: vi.fn().mockResolvedValue({
        pagination: { page: 1, per_page: 100, total: 1 },
        data: [{ label: 'Smart Trader', category: 'behavioral' }]
      })
    };
    const commands = buildCommands({});
    const result = await commands['token'](['transfers'], mockApi, { enrich: true }, { token: '0xabc' });

    expect(result.transfers[0].from_labels).toEqual(['Smart Trader']);
    expect(result.transfers[0].to_labels).toEqual(['Smart Trader']);
  });

  it('should not enrich when --enrich flag is not set', async () => {
    const mockApi = {
      tokenTransfers: vi.fn().mockResolvedValue({
        transfers: [{ from: '0xaaa', to: '0xbbb', amount_usd: 1000 }]
      }),
      addressLabels: vi.fn()
    };
    const commands = buildCommands({});
    await commands['token'](['transfers'], mockApi, {}, { token: '0xabc' });

    expect(mockApi.addressLabels).not.toHaveBeenCalled();
  });
});

// =================== --format csv ===================

describe('formatCsv', () => {
  it('should produce CSV with header row', () => {
    const data = [
      { name: 'Alice', value: 100 },
      { name: 'Bob', value: 200 }
    ];
    const result = formatCsv(data);
    const lines = result.split('\n');
    expect(lines[0]).toBe('name,value');
    expect(lines[1]).toBe('Alice,100');
    expect(lines[2]).toBe('Bob,200');
  });

  it('should quote values containing commas', () => {
    const data = [{ name: 'Hello, World', value: 1 }];
    const result = formatCsv(data);
    expect(result).toContain('"Hello, World"');
  });

  it('should escape double quotes', () => {
    const data = [{ name: 'Say "hello"', value: 1 }];
    const result = formatCsv(data);
    expect(result).toContain('"Say ""hello"""');
  });

  it('should handle null/undefined values', () => {
    const data = [{ name: null, value: undefined }];
    const result = formatCsv(data);
    const lines = result.split('\n');
    expect(lines[1]).toBe(',');
  });

  it('should stringify objects', () => {
    const data = [{ meta: { chain: 'eth' } }];
    const result = formatCsv(data);
    expect(result).toContain('chain');
  });

  it('should extract from nested response', () => {
    const response = { data: [{ x: 1 }, { x: 2 }] };
    const result = formatCsv(response);
    const lines = result.split('\n');
    expect(lines).toHaveLength(3);
  });

  it('should return empty string for empty data', () => {
    expect(formatCsv([])).toBe('');
  });
});

describe('--format csv integration', () => {
  let outputs;
  let errors;
  let _exitCode;

  const mockDeps = () => ({
    output: (msg) => outputs.push(msg),
    errorOutput: (msg) => errors.push(msg),
    exit: (code) => { _exitCode = code; }
  });

  beforeEach(() => {
    outputs = [];
    errors = [];
    _exitCode = null;
  });

  it('should output CSV when --format csv is used', async () => {
    const deps = {
      ...mockDeps(),
      NansenAPIClass: function MockAPI() {
        this.smartMoneyNetflow = vi.fn().mockResolvedValue([
          { symbol: 'SOL', value: 100 },
          { symbol: 'ETH', value: 200 }
        ]);
      }
    };

    const result = await runCLI(['smart-money', 'netflow', '--format', 'csv'], deps);

    expect(result.type).toBe('csv');
    const lines = outputs[0].split('\n');
    expect(lines[0]).toContain('symbol');
    expect(lines[1]).toContain('SOL');
    expect(lines[2]).toContain('ETH');
  });
});

describe('rejected API call output in --table and --format csv', () => {
  let outputs;
  let exitCode;

  const rejectingDeps = () => ({
    output: (msg) => outputs.push(msg),
    errorOutput: () => {},
    exit: (code) => { exitCode = code; },
    NansenAPIClass: function MockAPI() {
      this.smartMoneyNetflow = vi.fn().mockRejectedValue(
        new NansenError('Rate limited', ErrorCode.RATE_LIMITED, 429, { rateLimit: { resetSeconds: 30 } })
      );
    }
  });

  beforeEach(() => {
    outputs = [];
    exitCode = null;
  });

  it('keeps code and status in --table error output', async () => {
    const result = await runCLI(['smart-money', 'netflow', '--table'], rejectingDeps());
    expect(result.type).toBe('error');
    expect(exitCode).toBe(1);
    expect(outputs[0].split('\n')).toEqual([
      'Error: Rate limited',
      'code: RATE_LIMITED',
      'status: 429',
      'details: {"rateLimit":{"resetSeconds":30}}',
    ]);
  });

  it('emits a parseable CSV error row for --format csv', async () => {
    const result = await runCLI(['smart-money', 'netflow', '--format', 'csv'], rejectingDeps());
    expect(result.type).toBe('error');
    expect(exitCode).toBe(1);
    expect(outputs[0].split('\n')).toEqual([
      'success,error,code,status,details',
      'false,Rate limited,RATE_LIMITED,429,"{""rateLimit"":{""resetSeconds"":30}}"',
    ]);
  });
});

// =================== Composite Functions ===================

describe('batchProfile', () => {
  it('should call labels and balance for each address', async () => {
    const mockApi = {
      addressLabels: vi.fn().mockResolvedValue({ labels: ['Fund'] }),
      addressBalance: vi.fn().mockResolvedValue({ balances: [{ token_symbol: 'ETH', value_usd: 100 }] }),
    };

    const result = await batchProfile(mockApi, {
      addresses: ['0x0000000000000000000000000000000000000001', '0x0000000000000000000000000000000000000002'],
      chain: 'ethereum',
      include: ['labels', 'balance'],
      delayMs: 0,
    });

    expect(result.total).toBe(2);
    expect(result.completed).toBe(2);
    expect(result.results).toHaveLength(2);
    expect(result.results[0].labels).toBeDefined();
    expect(result.results[0].balance).toBeDefined();
    expect(mockApi.addressLabels).toHaveBeenCalledWith(expect.objectContaining({
      requestOptions: { autoPaginate: false },
    }));
  });

  it('should unwrap the v1 labels response into a labels array', async () => {
    const mockApi = {
      addressLabels: vi.fn().mockResolvedValue({
        pagination: { page: 1, per_page: 100, is_last_page: true },
        data: [{ label: 'Fund', category: 'fund', kind: ['entity/fund'] }]
      }),
    };

    const result = await batchProfile(mockApi, {
      addresses: ['0x0000000000000000000000000000000000000001'],
      chain: 'ethereum',
      include: ['labels'],
      delayMs: 0,
    });

    expect(result.results[0].labels).toEqual([
      { label: 'Fund', category: 'fund', kind: ['entity/fund'] }
    ]);
  });

  it('should capture individual errors without failing batch', async () => {
    const mockApi = {
      addressLabels: vi.fn().mockRejectedValue(new Error('Not found')),
    };

    const result = await batchProfile(mockApi, {
      addresses: ['0x0000000000000000000000000000000000000001'],
      chain: 'ethereum',
      include: ['labels'],
      delayMs: 0,
    });

    expect(result.total).toBe(1);
    expect(result.results[0].error).toBeDefined();
  });

  it('should skip invalid addresses with validation error', async () => {
    const mockApi = {
      addressLabels: vi.fn().mockResolvedValue({ labels: [] }),
    };

    const result = await batchProfile(mockApi, {
      addresses: ['not-an-address'],
      chain: 'ethereum',
      include: ['labels'],
      delayMs: 0,
    });

    expect(result.total).toBe(1);
    expect(result.completed).toBe(0);
    expect(result.results[0].error).toContain('Invalid');
    expect(mockApi.addressLabels).not.toHaveBeenCalled();
  });

  it('should include pnl when requested', async () => {
    const mockApi = {
      addressPnl: vi.fn().mockResolvedValue({ pnl: 100 }),
    };

    const result = await batchProfile(mockApi, {
      addresses: ['0x0000000000000000000000000000000000000001'],
      chain: 'ethereum',
      include: ['pnl'],
      delayMs: 0,
    });

    expect(result.results[0].pnl).toBeDefined();
    expect(mockApi.addressPnl).toHaveBeenCalledWith(expect.objectContaining({
      requestOptions: { autoPaginate: false },
    }));
  });
});

describe('traceCounterparties', () => {
  it('keeps each width-bounded internal lookup to one request under the global wrapper', async () => {
    const rawRequest = vi.fn(async (_endpoint, body) => ({
      counterparties: [
        { counterparty_address: '0x0000000000000000000000000000000000000002' },
        { counterparty_address: '0x0000000000000000000000000000000000000003' },
      ],
      pagination: { page: body.pagination.page, per_page: 2, has_more: true },
    }));
    const api = {
      request: rawRequest,
      addressCounterparties({ address, chain, days, pagination, requestOptions }) {
        return this.request('/api/v1/profiler/address/counterparties', {
          address, chain, days, pagination,
        }, requestOptions);
      },
    };
    enableAutoPagination(api, { maxPages: 5 });

    const result = await traceCounterparties(api, {
      address: '0x0000000000000000000000000000000000000001',
      chain: 'ethereum',
      depth: 1,
      width: 2,
      delayMs: 0,
    });

    expect(rawRequest).toHaveBeenCalledTimes(1);
    expect(rawRequest.mock.calls[0][1].pagination).toEqual({ page: 1, per_page: 2 });
    expect(rawRequest.mock.calls[0][2]).toEqual({ autoPaginate: false });
    expect(result.edges).toHaveLength(2);
  });

  it('should return graph structure', async () => {
    const mockApi = {
      addressCounterparties: vi.fn()
        .mockResolvedValueOnce({
          counterparties: [
            { counterparty_address: '0x0000000000000000000000000000000000000002', volume_usd: 5000, transaction_count: 10 }
          ]
        })
        .mockResolvedValueOnce({ counterparties: [] }),
    };

    const result = await traceCounterparties(mockApi, {
      address: '0x0000000000000000000000000000000000000001',
      chain: 'ethereum',
      depth: 2,
      width: 5,
      days: 30,
      delayMs: 0,
    });

    expect(result.root).toBe('0x0000000000000000000000000000000000000001');
    expect(result.nodes).toContain('0x0000000000000000000000000000000000000001');
    expect(result.nodes).toContain('0x0000000000000000000000000000000000000002');
    expect(result.edges.length).toBeGreaterThanOrEqual(1);
    expect(result.stats.nodes_visited).toBeGreaterThanOrEqual(2);
  });

  it('should detect cycles', async () => {
    const mockApi = {
      addressCounterparties: vi.fn().mockResolvedValueOnce({
        counterparties: [
          { counterparty_address: '0x0000000000000000000000000000000000000001', volume_usd: 100, transaction_count: 1 }
        ]
      }),
    };

    const result = await traceCounterparties(mockApi, {
      address: '0x0000000000000000000000000000000000000001',
      chain: 'ethereum',
      depth: 3,
      delayMs: 0,
    });

    const rootCount = result.nodes.filter(n => n === '0x0000000000000000000000000000000000000001').length;
    expect(rootCount).toBe(1);
  });

  it('should clamp depth to max 5', async () => {
    const mockApi = {
      addressCounterparties: vi.fn().mockResolvedValue({ counterparties: [] }),
    };

    const result = await traceCounterparties(mockApi, {
      address: '0x0000000000000000000000000000000000000001',
      chain: 'ethereum',
      depth: 10,
      delayMs: 0,
    });

    expect(result.depth).toBe(5);
  });

  it('should reject missing address', async () => {
    const mockApi = {};
    await expect(traceCounterparties(mockApi, { chain: 'ethereum' }))
      .rejects.toThrow('address is required');
  });

  it('should reject invalid address', async () => {
    const mockApi = {};
    await expect(traceCounterparties(mockApi, { address: 'bad', chain: 'ethereum' }))
      .rejects.toThrow('Invalid');
  });
});

describe('compareWallets', () => {
  it('should require exactly 2 addresses', async () => {
    const mockApi = {};
    await expect(compareWallets(mockApi, {
      addresses: ['0x0000000000000000000000000000000000000001'],
      chain: 'ethereum',
    })).rejects.toThrow('Exactly 2 addresses');
  });

  it('should reject invalid addresses', async () => {
    const mockApi = {};
    await expect(compareWallets(mockApi, {
      addresses: ['bad-addr', '0x0000000000000000000000000000000000000002'],
      chain: 'ethereum',
    })).rejects.toThrow('Invalid');
  });

  it('should return comparison data', async () => {
    const mockApi = {
      addressCounterparties: vi.fn()
        .mockResolvedValueOnce({ counterparties: [{ counterparty_address: '0x0000000000000000000000000000000000000003', volume_usd: 100 }] })
        .mockResolvedValueOnce({ counterparties: [{ counterparty_address: '0x0000000000000000000000000000000000000003', volume_usd: 200 }] }),
      addressBalance: vi.fn()
        .mockResolvedValueOnce({ balances: [{ token_symbol: 'ETH', value_usd: 1000 }] })
        .mockResolvedValueOnce({ balances: [{ token_symbol: 'ETH', value_usd: 2000 }] }),
    };

    const result = await compareWallets(mockApi, {
      addresses: ['0x0000000000000000000000000000000000000001', '0x0000000000000000000000000000000000000002'],
      chain: 'ethereum',
      delayMs: 0,
    });

    expect(result.addresses).toHaveLength(2);
    expect(result.shared_counterparties).toContain('0x0000000000000000000000000000000000000003');
    expect(result.shared_tokens).toContain('ETH');
    expect(result.balances).toHaveLength(2);
    expect(result.balances[0].total_usd).toBe(1000);
    expect(result.balances[1].total_usd).toBe(2000);
  });
  it('should surface a failure of every request instead of returning an empty comparison', async () => {
    const reject = () => Promise.reject(new NansenError('Invalid API key', ErrorCode.UNAUTHORIZED, 401));
    const mockApi = { addressCounterparties: vi.fn(reject), addressBalance: vi.fn(reject) };

    await expect(compareWallets(mockApi, {
      addresses: ['0x0000000000000000000000000000000000000001', '0x0000000000000000000000000000000000000002'],
      chain: 'ethereum',
      delayMs: 0,
    })).rejects.toMatchObject({ code: ErrorCode.UNAUTHORIZED, status: 401 });
  });

  it('should report a partial failure instead of an empty overlap', async () => {
    const mockApi = {
      addressCounterparties: vi.fn()
        .mockResolvedValueOnce({ counterparties: [{ counterparty_address: '0x0000000000000000000000000000000000000003' }] })
        .mockRejectedValueOnce(new NansenError('Rate limited', ErrorCode.RATE_LIMITED, 429)),
      addressBalance: vi.fn()
        .mockResolvedValueOnce({ balances: [{ token_symbol: 'ETH', token_address: '0xeth', value_usd: 1000 }] })
        .mockResolvedValueOnce({ balances: [{ token_symbol: 'ETH', token_address: '0xeth', value_usd: 2000 }] }),
    };

    const result = await compareWallets(mockApi, {
      addresses: ['0x0000000000000000000000000000000000000001', '0x0000000000000000000000000000000000000002'],
      chain: 'ethereum',
      delayMs: 0,
    });

    expect(result.incomplete).toBe(true);
    expect(result.errors).toEqual([
      { address: '0x0000000000000000000000000000000000000002', source: 'counterparties', code: ErrorCode.RATE_LIMITED, message: 'Rate limited' },
    ]);
    expect(result.shared_counterparties).toBeNull();
    expect(result.shared_tokens).toEqual(['ETH']);
    expect(result.balances[0].total_usd).toBe(1000);
    expect(result.balances[1].total_usd).toBe(2000);
  });

  it('should report UNKNOWN for a failure that is not a NansenError', async () => {
    const mockApi = {
      addressCounterparties: vi.fn().mockResolvedValue({ counterparties: [] }),
      addressBalance: vi.fn()
        .mockResolvedValueOnce({ balances: [] })
        .mockRejectedValueOnce(new TypeError('fetch failed')),
    };

    const result = await compareWallets(mockApi, {
      addresses: ['0x0000000000000000000000000000000000000001', '0x0000000000000000000000000000000000000002'],
      chain: 'ethereum',
      delayMs: 0,
    });

    expect(result.errors).toEqual([
      { address: '0x0000000000000000000000000000000000000002', source: 'balance', code: 'UNKNOWN', message: 'fetch failed' },
    ]);
  });

  it('should null the balance total of a wallet whose balance request failed', async () => {
    const mockApi = {
      addressCounterparties: vi.fn().mockResolvedValue({ counterparties: [] }),
      addressBalance: vi.fn()
        .mockResolvedValueOnce({ balances: [{ token_symbol: 'ETH', token_address: '0xeth', value_usd: 1000 }] })
        .mockRejectedValueOnce(new NansenError('Server error', ErrorCode.SERVER_ERROR, 500)),
    };

    const result = await compareWallets(mockApi, {
      addresses: ['0x0000000000000000000000000000000000000001', '0x0000000000000000000000000000000000000002'],
      chain: 'ethereum',
      delayMs: 0,
    });

    expect(result.incomplete).toBe(true);
    expect(result.shared_counterparties).toEqual([]);
    expect(result.shared_tokens).toBeNull();
    expect(result.balances[0].total_usd).toBe(1000);
    expect(result.balances[1].total_usd).toBeNull();
  });

  it('should not report the same symbol on different contracts as a shared token', async () => {
    const mockApi = {
      addressCounterparties: vi.fn().mockResolvedValue({ counterparties: [] }),
      addressBalance: vi.fn()
        .mockResolvedValueOnce({ balances: [
          { token_symbol: 'ABC', token_address: '0xAAAA', value_usd: 1 },
          { token_symbol: 'USDC', token_address: '0xusdc', value_usd: 1 },
        ] })
        .mockResolvedValueOnce({ balances: [
          { token_symbol: 'ABC', token_address: '0xbbbb', value_usd: 1 },
          { token_symbol: 'USDC', token_address: '0xUSDC', value_usd: 1 },
        ] }),
    };

    const result = await compareWallets(mockApi, {
      addresses: ['0x0000000000000000000000000000000000000001', '0x0000000000000000000000000000000000000002'],
      chain: 'ethereum',
      delayMs: 0,
    });

    expect(result.shared_tokens).toEqual(['USDC']);
    expect(result.incomplete).toBeUndefined();
  });

  it('should fall back to the symbol when only one side reports a token address', async () => {
    const mockApi = {
      addressCounterparties: vi.fn().mockResolvedValue({ counterparties: [] }),
      addressBalance: vi.fn()
        .mockResolvedValueOnce({ balances: [
          { token_symbol: 'ETH', token_address: '0x0000000000000000000000000000000000000000', value_usd: 1 },
          { token_symbol: 'ABC', value_usd: 1 },
        ] })
        .mockResolvedValueOnce({ balances: [
          { token_symbol: 'ETH', value_usd: 1 },
          { token_symbol: 'ABC', token_address: '0xabc', value_usd: 1 },
        ] }),
    };

    const result = await compareWallets(mockApi, {
      addresses: ['0x0000000000000000000000000000000000000001', '0x0000000000000000000000000000000000000002'],
      chain: 'ethereum',
      delayMs: 0,
    });

    expect(result.shared_tokens).toEqual(['ETH', 'ABC']);
  });

  it('should label a shared token by its address when the symbol is empty', async () => {
    const mockApi = {
      addressCounterparties: vi.fn().mockResolvedValue({ counterparties: [] }),
      addressBalance: vi.fn()
        .mockResolvedValueOnce({ balances: [{ token_symbol: '', token_address: '0xABCD', value_usd: 1 }] })
        .mockResolvedValueOnce({ balances: [{ token_symbol: '', token_address: '0xabcd', value_usd: 1 }] }),
    };

    const result = await compareWallets(mockApi, {
      addresses: ['0x0000000000000000000000000000000000000001', '0x0000000000000000000000000000000000000002'],
      chain: 'ethereum',
      delayMs: 0,
    });

    expect(result.shared_tokens).toEqual(['0xabcd']);
  });

  it('should throw the first recorded failure when every request fails, whichever it is', async () => {
    const mockApi = {
      addressCounterparties: vi.fn()
        .mockRejectedValueOnce(new NansenError('Rate limited', ErrorCode.RATE_LIMITED, 429))
        .mockRejectedValueOnce(new NansenError('Invalid API key', ErrorCode.UNAUTHORIZED, 401)),
      addressBalance: vi.fn().mockRejectedValue(new NansenError('Invalid API key', ErrorCode.UNAUTHORIZED, 401)),
    };

    await expect(compareWallets(mockApi, {
      addresses: ['0x0000000000000000000000000000000000000001', '0x0000000000000000000000000000000000000002'],
      chain: 'ethereum',
      delayMs: 0,
    })).rejects.toMatchObject({ code: ErrorCode.RATE_LIMITED, status: 429 });
  });

  it('should match symbols case-insensitively in the fallback and report each token once', async () => {
    const mockApi = {
      addressCounterparties: vi.fn().mockResolvedValue({ counterparties: [] }),
      addressBalance: vi.fn()
        .mockResolvedValueOnce({ balances: [{ token_symbol: 'USDC', value_usd: 1 }, { token_symbol: 'usdc', value_usd: 1 }] })
        .mockResolvedValueOnce({ balances: [{ token_symbol: 'usdc', value_usd: 1 }] }),
    };

    const result = await compareWallets(mockApi, {
      addresses: ['0x0000000000000000000000000000000000000001', '0x0000000000000000000000000000000000000002'],
      chain: 'ethereum',
      delayMs: 0,
    });

    expect(result.shared_tokens).toEqual(['USDC']);
  });

  it('should fall back to the symbol when neither side reports a token address', async () => {
    const mockApi = {
      addressCounterparties: vi.fn().mockResolvedValue({ counterparties: [] }),
      addressBalance: vi.fn()
        .mockResolvedValueOnce({ balances: [{ token_symbol: 'ETH', value_usd: 1 }] })
        .mockResolvedValueOnce({ balances: [{ token_symbol: 'ETH', value_usd: 1 }] }),
    };

    const result = await compareWallets(mockApi, {
      addresses: ['0x0000000000000000000000000000000000000001', '0x0000000000000000000000000000000000000002'],
      chain: 'ethereum',
      delayMs: 0,
    });

    expect(result.shared_tokens).toEqual(['ETH']);
  });
});

describe('ENS integration in batchProfile', () => {
  it('should resolve .eth names and include ensName in results', async () => {
    const { resolveAddress: _resolveAddress } = await import('../ens.js');
    vi.spyOn(await import('../ens.js'), 'resolveAddress').mockResolvedValue({
      address: '0x0000000000000000000000000000000000000001',
      ensName: 'test.eth',
    });
    vi.spyOn(await import('../ens.js'), 'isEnsName').mockReturnValue(true);

    const mockApi = {
      addressLabels: vi.fn().mockResolvedValue({ labels: ['Fund'] }),
    };

    const result = await batchProfile(mockApi, {
      addresses: ['test.eth'],
      chain: 'ethereum',
      include: ['labels'],
      delayMs: 0,
    });

    expect(result.results[0].ensName).toBe('test.eth');
    expect(result.results[0].address).toBe('0x0000000000000000000000000000000000000001');

    vi.restoreAllMocks();
  });

  it('should capture ENS resolution failure as entry error', async () => {
    vi.spyOn(await import('../ens.js'), 'isEnsName').mockReturnValue(true);
    vi.spyOn(await import('../ens.js'), 'resolveAddress').mockRejectedValue(
      new Error('Could not resolve ENS name: bad.eth')
    );

    const mockApi = {};

    const result = await batchProfile(mockApi, {
      addresses: ['bad.eth'],
      chain: 'ethereum',
      include: ['labels'],
      delayMs: 0,
    });

    expect(result.results[0].error).toBeDefined();
    expect(result.completed).toBe(0);

    vi.restoreAllMocks();
  });
});

describe('ENS integration in traceCounterparties', () => {
  it('should reject failed ENS resolution with INVALID_ADDRESS', async () => {
    vi.spyOn(await import('../ens.js'), 'isEnsName').mockReturnValue(true);
    vi.spyOn(await import('../ens.js'), 'resolveAddress').mockRejectedValue(
      new Error('Could not resolve ENS name: bad.eth')
    );

    const mockApi = {};
    await expect(
      traceCounterparties(mockApi, { address: 'bad.eth', chain: 'ethereum', delayMs: 0 })
    ).rejects.toThrow('Could not resolve ENS name');

    vi.restoreAllMocks();
  });
});

// =================== research / trade / deprecation ===================

describe('research command routing', () => {
  it('should list categories when called with no args', async () => {
    const commands = buildCommands({});
    const result = await commands.research([], null, {}, {});
    expect(result.categories).toContain('smart-money');
    expect(result.categories).toContain('profiler');
    expect(result.categories).toContain('token');
  });

  it('should list categories for help subcommand', async () => {
    const commands = buildCommands({});
    const result = await commands.research(['help'], null, {}, {});
    expect(result.categories).toContain('smart-money');
  });

  it('should delegate to smart-money handler', async () => {
    const commands = buildCommands({});
    const result = await commands.research(['smart-money', 'help'], null, {}, {});
    expect(result.commands).toContain('netflow');
  });

  it('should resolve category aliases (tgm -> token)', async () => {
    const commands = buildCommands({});
    const result = await commands.research(['tgm', 'help'], null, {}, {});
    expect(result.commands).toContain('screener');
  });

  it('should keep research perp help analytics-only', async () => {
    const commands = buildCommands({});
    const result = await commands.research(['perp', 'help'], null, {}, {});
    expect(result.commands).toEqual(['screener', 'leaderboard']);
  });

  it.each([
    ['screener', 'perpScreener'],
    ['leaderboard', 'perpLeaderboard'],
  ])('should delegate research perp %s to the analytics handler', async (subcommand, method) => {
    const mockApi = { [method]: vi.fn().mockResolvedValue({ data: [] }) };
    const commands = buildCommands({});

    await commands.research(['perp', subcommand], mockApi, {}, {});

    expect(mockApi[method]).toHaveBeenCalledOnce();
  });

  it.each([
    'order',
    'cancel',
    'close',
    'leverage',
    'transfer',
    'approve-builder-fee',
    'positions',
    'orders',
    'account',
    'meta',
  ])(
    'should not route research perp %s to the top-level perp handler',
    async (subcommand) => {
      const commands = buildCommands({});

      await expect(commands.research(['perp', subcommand], null, {}, {}))
        .rejects.toMatchObject({
          code: 'UNKNOWN',
          message: `Unknown perp analytics subcommand: ${subcommand}. Available: screener, leaderboard`,
        });
    },
  );

  it('should error on unknown category', async () => {
    const commands = buildCommands({});
    await expect(commands.research(['unknown'], null, {}, {}))
      .rejects.toThrow('Unknown research category');
  });
});

describe('trade command routing', () => {
  it('should list subcommands when called with no args', async () => {
    const logs = [];
    const commands = buildCommands({ log: (msg) => logs.push(msg) });
    await commands.trade([], null, {}, {});
    const output = logs.join('\n');
    expect(output).toContain('quote');
    expect(output).toContain('execute');
  });

  it('should error on unknown subcommand', async () => {
    const commands = buildCommands({});
    await expect(commands.trade(['unknown'], null, {}, {}))
      .rejects.toThrow('Unknown trade subcommand');
  });
});

describe('deprecation warnings', () => {
  it('should NOT warn for deprecated research commands (warnings limited to help output)', async () => {
    const errors = [];
    const deps = {
      output: () => {},
      errorOutput: (msg) => errors.push(msg),
      exit: () => {},
      NansenAPIClass: function MockAPI() {
        this.smartMoneyNetflow = vi.fn().mockResolvedValue({ data: [] });
      }
    };
    await runCLI(['smart-money', 'netflow'], deps);
    expect(errors.some(e => e.includes('deprecated'))).toBe(false);
  });

  it('should NOT warn for deprecated trade commands (warnings limited to help output)', async () => {
    const errors = [];
    const deps = {
      output: () => {},
      errorOutput: (msg) => errors.push(msg),
      exit: () => {}
    };
    await runCLI(['quote'], deps);
    expect(errors.some(e => e.includes('deprecated'))).toBe(false);
  });

  it('should not warn for new research path', async () => {
    const errors = [];
    const deps = {
      output: () => {},
      errorOutput: (msg) => errors.push(msg),
      exit: () => {},
      NansenAPIClass: function MockAPI() {
        this.smartMoneyNetflow = vi.fn().mockResolvedValue({ data: [] });
      }
    };
    await runCLI(['research', 'smart-money', 'netflow'], deps);
    expect(errors.some(e => e.includes('deprecated'))).toBe(false);
  });

  it('should include all expected categories in DEPRECATED_TO_RESEARCH', () => {
    expect(DEPRECATED_TO_RESEARCH.has('smart-money')).toBe(true);
    expect(DEPRECATED_TO_RESEARCH.has('profiler')).toBe(true);
    expect(DEPRECATED_TO_RESEARCH.has('token')).toBe(true);
    expect(DEPRECATED_TO_RESEARCH.has('search')).toBe(true);
    expect(DEPRECATED_TO_RESEARCH.has('portfolio')).toBe(true);
    // Points is unavailable in both forms, so there is no replacement alias to suggest.
    expect(DEPRECATED_TO_RESEARCH.has('points')).toBe(false);
    // 'perp' is a top-level trading command (nansen perp order|close|...), not a
    // deprecated alias for 'research perp', so it must not be in this set.
    expect(DEPRECATED_TO_RESEARCH.has('perp')).toBe(false);
  });

  it('should include quote and execute in DEPRECATED_TO_TRADE', () => {
    expect(DEPRECATED_TO_TRADE.has('quote')).toBe(true);
    expect(DEPRECATED_TO_TRADE.has('execute')).toBe(true);
  });

  it('should route deprecated quote through to the handler', async () => {
    const outputs = [];
    const errors = [];
    const deps = {
      output: (msg) => outputs.push(msg),
      errorOutput: (msg) => errors.push(msg),
      exit: () => {}
    };
    // quote with no args throws CommandError (missing args); confirms handler was reached
    const result = await runCLI(['quote'], deps);
    // No deprecation warnings should be emitted (limited to help output only)
    expect(errors.some(e => e.includes('deprecated'))).toBe(false);
    expect(result.type).toBe('error');
  });

  it('should show deprecation note in help output for deprecated research commands', async () => {
    const outputs = [];
    const deps = {
      output: (msg) => outputs.push(msg),
      errorOutput: () => {},
      exit: () => {}
    };
    await runCLI(['smart-money', '--help'], deps);
    const combined = outputs.join('\n');
    expect(combined).toContain('deprecated');
    expect(combined).toContain('nansen research smart-money');
  });

  it('should show deprecation note in subcommand help for deprecated research commands', async () => {
    const outputs = [];
    const deps = {
      output: (msg) => outputs.push(msg),
      errorOutput: () => {},
      exit: () => {}
    };
    await runCLI(['smart-money', 'netflow', '--help'], deps);
    const combined = outputs.join('\n');
    expect(combined).toContain('deprecated');
    expect(combined).toContain('nansen research smart-money');
  });
});

describe('SCHEMA structure', () => {
  it('should have research and trade top-level commands', () => {
    expect(SCHEMA.commands.research).toBeDefined();
    expect(SCHEMA.commands.trade).toBeDefined();
  });

  it('should have research subcommands matching deprecated categories', () => {
    const researchSubs = Object.keys(SCHEMA.commands.research.subcommands);
    expect(researchSubs).toContain('smart-money');
    expect(researchSubs).toContain('profiler');
    expect(researchSubs).toContain('token');
    expect(researchSubs).toContain('search');
    expect(researchSubs).toContain('perp');
    expect(researchSubs).toContain('portfolio');
    expect(researchSubs).toContain('points');
    expect(researchSubs).toContain('prediction-market');
  });

  it('should populate research subcommands from deprecated entries', () => {
    const smSubs = SCHEMA.commands.research.subcommands['smart-money'].subcommands;
    expect(smSubs.netflow).toBeDefined();
    expect(smSubs['dex-trades']).toBeDefined();
  });

  it('should have trade subcommands', () => {
    const tradeSubs = Object.keys(SCHEMA.commands.trade.subcommands);
    expect(tradeSubs).toContain('quote');
    expect(tradeSubs).toContain('execute');
  });

  it('should not have deprecated entries at top level', () => {
    expect(SCHEMA.commands['smart-money']).toBeUndefined();
    expect(SCHEMA.commands.profiler).toBeUndefined();
    expect(SCHEMA.commands.token).toBeUndefined();
    expect(SCHEMA.commands.search).toBeUndefined();
    expect(SCHEMA.commands.portfolio).toBeUndefined();
    expect(SCHEMA.commands.points).toBeUndefined();
    // Note: `perp` IS a valid top-level command — Hyperliquid perp *trading*
    // (nansen perp order/close/...). Perp *analytics* lives under `research perp`.
  });

  it('documents perp trading as a top-level command', () => {
    expect(SCHEMA.commands.perp).toBeDefined();
    expect(SCHEMA.commands.perp.subcommands.order).toBeDefined();
    expect(SCHEMA.commands.perp.subcommands.close).toBeDefined();
    expect(SCHEMA.commands.perp.subcommands.account.endpoint).toBe('/api/v1/perp/account');
  });
});

describe('buildPagination', () => {
  it('returns undefined when neither --page nor --limit is set', () => {
    expect(buildPagination({})).toBeUndefined();
  });

  it('handles --page alone', () => {
    expect(buildPagination({ page: '2' })).toEqual({ page: 2, per_page: undefined });
  });

  it('handles --page + --limit together', () => {
    expect(buildPagination({ page: '3', limit: 10 })).toEqual({ page: 3, per_page: 10 });
  });

  it('guards against NaN --page value', () => {
    expect(buildPagination({ page: 'abc' })).toEqual({ page: 1, per_page: undefined });
  });

  it('clamps negative --page to 1', () => {
    expect(buildPagination({ page: '-5' })).toEqual({ page: 1, per_page: undefined });
  });

  it('handles --limit alone', () => {
    expect(buildPagination({ limit: 25 })).toEqual({ page: 1, per_page: 25 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// web command (search + fetch subcommands)
// ─────────────────────────────────────────────────────────────────────────────
describe('web search subcommand', () => {
  let webCmd;
  let mockApi;

  beforeEach(() => {
    mockApi = {
      webSearch: vi.fn().mockResolvedValue({ results: [] }),
    };
    const commands = buildCommands({ output: () => {}, errorOutput: () => {}, exit: () => {} });
    webCmd = (args, options = {}) => commands['web'](['search', ...args], mockApi, {}, options);
  });

  it('passes a single positional arg as query', async () => {
    await webCmd(['bitcoin price']);
    expect(mockApi.webSearch).toHaveBeenCalledWith({ queries: ['bitcoin price'], numResults: undefined });
  });

  it('passes multiple positional args as multiple queries', async () => {
    await webCmd(['bitcoin price', 'ethereum news']);
    expect(mockApi.webSearch).toHaveBeenCalledWith({ queries: ['bitcoin price', 'ethereum news'], numResults: undefined });
  });

  it('passes --query flag as query', async () => {
    await webCmd([], { query: 'solana defi' });
    expect(mockApi.webSearch).toHaveBeenCalledWith({ queries: ['solana defi'], numResults: undefined });
  });

  it('merges positional args and --query flag', async () => {
    await webCmd(['bitcoin'], { query: 'ethereum' });
    expect(mockApi.webSearch).toHaveBeenCalledWith({ queries: ['bitcoin', 'ethereum'], numResults: undefined });
  });

  it('handles --query as an array (repeated flag)', async () => {
    await webCmd([], { query: ['btc news', 'eth news'] });
    expect(mockApi.webSearch).toHaveBeenCalledWith({ queries: ['btc news', 'eth news'], numResults: undefined });
  });

  it('handles --query as a JSON array (single flag parsed to an array)', async () => {
    // parseArgs JSON.parses option values, so `--query '["btc","eth"]'` arrives
    // here as an actual array, same shape as a repeated --query flag.
    await webCmd([], { query: ['btc', 'eth'] });
    expect(mockApi.webSearch).toHaveBeenCalledWith({ queries: ['btc', 'eth'], numResults: undefined });
  });

  it('rejects --query as a JSON object with INVALID_PARAMS', async () => {
    // `--query '{"a":1}'` is JSON.parsed to a plain object before cli.js sees it.
    await expect(webCmd([], { query: { a: 1 } })).rejects.toThrow('--query values must be strings');
  });

  it('rejects --query as a JSON array of non-strings with INVALID_PARAMS', async () => {
    // `--query '[1,2]'` is JSON.parsed to an array of numbers.
    await expect(webCmd([], { query: [1, 2] })).rejects.toThrow('--query values must be strings');
  });

  it('passes --num-results as numResults (parsed as int)', async () => {
    await webCmd(['bitcoin'], { 'num-results': '5' });
    expect(mockApi.webSearch).toHaveBeenCalledWith({ queries: ['bitcoin'], numResults: 5 });
  });

  it('rejects a malformed --num-results instead of truncating it or falling back to the API default', async () => {
    for (const bad of ['abc', '5abc', '2.5', 'Infinity', 'NaN', '', ' ']) {
      await expect(webCmd(['bitcoin'], { 'num-results': bad })).rejects.toMatchObject({ code: ErrorCode.INVALID_PARAMS });
    }
    await expect(webCmd(['bitcoin'], { 'num-results': ['5', '6'] })).rejects.toThrow('--num-results may only be specified once');
    expect(mockApi.webSearch).not.toHaveBeenCalled();
  });

  it('rejects a valueless --num-results flag', async () => {
    const commands = buildCommands({ output: () => {}, errorOutput: () => {}, exit: () => {} });
    await expect(commands['web'](['search', 'bitcoin'], mockApi, { 'num-results': true }, {}))
      .rejects.toThrow('--num-results requires a whole number between 1 and 20');
  });

  it('still accepts 1 and 20', async () => {
    await webCmd(['bitcoin'], { 'num-results': '1' });
    expect(mockApi.webSearch).toHaveBeenLastCalledWith({ queries: ['bitcoin'], numResults: 1 });
    await webCmd(['bitcoin'], { 'num-results': '20' });
    expect(mockApi.webSearch).toHaveBeenLastCalledWith({ queries: ['bitcoin'], numResults: 20 });
  });

  it('throws INVALID_PARAM when --num-results is 0 (out of range)', async () => {
    await expect(webCmd(['bitcoin'], { 'num-results': '0' })).rejects.toThrow('--num-results must be between 1 and 20');
  });

  it('throws INVALID_PARAM when --num-results is 21 (out of range)', async () => {
    await expect(webCmd(['bitcoin'], { 'num-results': '21' })).rejects.toThrow('--num-results must be between 1 and 20');
  });

  it('returns the API response', async () => {
    const stub = { results: [{ query: 'bitcoin', organic: [] }] };
    mockApi.webSearch.mockResolvedValue(stub);
    const result = await webCmd(['bitcoin']);
    expect(result).toEqual(stub);
  });

  it('throws MISSING_PARAM when no query provided', async () => {
    await expect(webCmd([])).rejects.toThrow('At least one query is required');
  });

  it('filters out empty string queries', async () => {
    await webCmd(['', 'bitcoin'], {});
    expect(mockApi.webSearch).toHaveBeenCalledWith({ queries: ['bitcoin'], numResults: undefined });
  });

  it('throws MISSING_PARAM when all queries are empty/whitespace', async () => {
    await expect(webCmd(['', '   '])).rejects.toThrow('At least one query is required');
  });

  it('filters out whitespace-only queries', async () => {
    await webCmd(['  ', 'ethereum'], {});
    expect(mockApi.webSearch).toHaveBeenCalledWith({ queries: ['ethereum'], numResults: undefined });
  });
});

describe('web fetch subcommand', () => {
  let webCmd;
  let mockApi;

  beforeEach(() => {
    mockApi = {
      webFetch: vi.fn().mockResolvedValue({ analysis: 'test', urls_requested: 1, retrieved_urls: [], failed_urls: [] }),
    };
    const commands = buildCommands({ output: () => {}, errorOutput: () => {}, exit: () => {} });
    webCmd = (args, options = {}) => commands['web'](['fetch', ...args], mockApi, {}, options);
  });

  it('passes a single positional URL and --question', async () => {
    await webCmd(['https://nansen.ai'], { question: 'What is this?' });
    expect(mockApi.webFetch).toHaveBeenCalledWith({ urls: ['https://nansen.ai'], question: 'What is this?' });
  });

  it('passes multiple positional URLs', async () => {
    await webCmd(['https://a.com', 'https://b.com'], { question: 'Compare?' });
    expect(mockApi.webFetch).toHaveBeenCalledWith({ urls: ['https://a.com', 'https://b.com'], question: 'Compare?' });
  });

  it('passes --url flag as URL', async () => {
    await webCmd([], { url: 'https://nansen.ai', question: 'What?' });
    expect(mockApi.webFetch).toHaveBeenCalledWith({ urls: ['https://nansen.ai'], question: 'What?' });
  });

  it('handles --url as an array (repeated flag)', async () => {
    await webCmd([], { url: ['https://a.com', 'https://b.com'], question: 'Compare?' });
    expect(mockApi.webFetch).toHaveBeenCalledWith({ urls: ['https://a.com', 'https://b.com'], question: 'Compare?' });
  });

  it('merges positional URLs and --url flag', async () => {
    await webCmd(['https://a.com'], { url: 'https://b.com', question: 'Diff?' });
    expect(mockApi.webFetch).toHaveBeenCalledWith({ urls: ['https://a.com', 'https://b.com'], question: 'Diff?' });
  });

  it('returns the API response', async () => {
    const stub = { analysis: 'Nansen is a blockchain analytics platform.', urls_requested: 1, retrieved_urls: ['https://nansen.ai'], failed_urls: [] };
    mockApi.webFetch.mockResolvedValue(stub);
    const result = await webCmd(['https://nansen.ai'], { question: 'What?' });
    expect(result).toEqual(stub);
  });

  it('throws MISSING_PARAM when no URL provided', async () => {
    await expect(webCmd([], { question: 'What?' })).rejects.toThrow('At least one URL is required');
  });

  it('throws MISSING_PARAM when --question is missing', async () => {
    await expect(webCmd(['https://nansen.ai'])).rejects.toThrow('--question is required');
  });

  it('throws MISSING_PARAM when --question is blank/whitespace', async () => {
    await expect(webCmd(['https://nansen.ai'], { question: '   ' })).rejects.toThrow('--question is required and cannot be blank');
  });

  it('throws INVALID_PARAMS when a URL has no scheme', async () => {
    await expect(webCmd(['not-a-url'], { question: 'What?' })).rejects.toThrow('Invalid URL: "not-a-url"');
  });

  it('throws INVALID_PARAMS when a URL has no scheme (://bad)', async () => {
    await expect(webCmd(['://bad'], { question: 'What?' })).rejects.toThrow('Invalid URL');
  });

  it('throws MISSING_PARAM when both URL and question are missing', async () => {
    await expect(webCmd([])).rejects.toThrow('At least one URL is required');
  });
});

describe('web help subcommand', () => {
  it('returns available subcommands', async () => {
    const commands = buildCommands({ output: () => {}, errorOutput: () => {}, exit: () => {} });
    const result = await commands['web']([], {}, {}, {});
    expect(result).toMatchObject({ subcommands: ['search', 'fetch'] });
  });

  it('throws for unknown web subcommand', async () => {
    const commands = buildCommands({ output: () => {}, errorOutput: () => {}, exit: () => {} });
    await expect(commands['web'](['unknown'], {}, {}, {})).rejects.toThrow('Unknown web subcommand');
  });
});

// ============= Alert Validation Tests =============

describe('validateAlertData -- type-specific required fields', () => {
  it('should pass for sm-token-flows with a flow threshold set', () => {
    expect(() => validateAlertData('sm-token-flows', {
      inflow_1h: { min: 1000000 },
      inflow_1d: {},
      inflow_7d: {},
      outflow_1h: {},
      outflow_1d: {},
      outflow_7d: {},
      netflow_1h: {},
      netflow_1d: {},
      netflow_7d: {},
    })).not.toThrow();
  });

  it('should fail for sm-token-flows with no flow thresholds', () => {
    expect(() => validateAlertData('sm-token-flows', {
      inflow_1h: {},
      inflow_1d: {},
      inflow_7d: {},
      outflow_1h: {},
      outflow_1d: {},
      outflow_7d: {},
      netflow_1h: {},
      netflow_1d: {},
      netflow_7d: {},
    })).toThrow('at least one flow threshold');
  });

  it('should pass for common-token-transfer with subjects', () => {
    expect(() => validateAlertData('common-token-transfer', {
      subjects: [{ type: 'label', value: 'CEX' }],
      inclusion: {},
    })).not.toThrow();
  });

  it('should pass for common-token-transfer with inclusion tokens', () => {
    expect(() => validateAlertData('common-token-transfer', {
      subjects: [],
      inclusion: { tokens: [{ address: '0xabc', chain: 'ethereum' }] },
    })).not.toThrow();
  });

  it('should fail for common-token-transfer with neither subjects nor tokens', () => {
    expect(() => validateAlertData('common-token-transfer', {
      subjects: [],
      inclusion: { tokens: [] },
    })).toThrow('at least one --subject or --token');
  });

  it('should pass for smart-contract-call with caller', () => {
    expect(() => validateAlertData('smart-contract-call', {
      inclusion: { caller: [{ type: 'address', value: '0x123' }], smartContract: [] },
      signatureHash: [],
    })).not.toThrow();
  });

  it('should pass for smart-contract-call with signature-hash', () => {
    expect(() => validateAlertData('smart-contract-call', {
      inclusion: { caller: [], smartContract: [] },
      signatureHash: ['0xa9059cbb'],
    })).not.toThrow();
  });

  it('should fail for smart-contract-call with nothing set', () => {
    expect(() => validateAlertData('smart-contract-call', {
      inclusion: { caller: [], smartContract: [] },
      signatureHash: [],
    })).toThrow('at least one --caller, --contract, or --signature-hash');
  });

  it('should no-op when type is null', () => {
    expect(() => validateAlertData(null, { subjects: [] })).not.toThrow();
  });

  it('should no-op when data is undefined', () => {
    expect(() => validateAlertData('sm-token-flows', undefined)).not.toThrow();
  });
});

describe('alerts update -- deep-merge range fields', () => {
  it('should preserve existing max when only min is updated (sm-token-flows)', async () => {
    const mockApi = {
      alertsGet: vi.fn().mockResolvedValue({
        type: 'sm-token-flows',
        data: {
          chains: ['ethereum'],
          inflow_1h: { min: 1000000, max: 50000000 },
          outflow_1d: { min: 500, max: 10000 },
          inclusion: {},
          exclusion: {},
        },
      }),
      alertsUpdate: vi.fn().mockResolvedValue({ id: 'abc123' }),
    };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await cmd(['update', 'abc123'], mockApi, {}, { 'inflow-1h-min': '2000000' });
    const sentData = mockApi.alertsUpdate.mock.calls[0][0].data;
    expect(sentData.inflow_1h).toEqual({ min: 2000000, max: 50000000 });
    expect(sentData.outflow_1d).toEqual({ min: 500, max: 10000 });
  });

  it('should preserve existing min when only max is updated (sm-token-flows)', async () => {
    const mockApi = {
      alertsGet: vi.fn().mockResolvedValue({
        type: 'sm-token-flows',
        data: {
          chains: ['ethereum'],
          inflow_1h: { min: 1000000, max: 50000000 },
          outflow_1d: { min: 500, max: 10000 },
          inclusion: {},
          exclusion: {},
        },
      }),
      alertsUpdate: vi.fn().mockResolvedValue({ id: 'abc123' }),
    };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await cmd(['update', 'abc123'], mockApi, {}, { 'inflow-1h-max': '99000000' });
    const sentData = mockApi.alertsUpdate.mock.calls[0][0].data;
    expect(sentData.inflow_1h).toEqual({ min: 1000000, max: 99000000 });
    expect(sentData.outflow_1d).toEqual({ min: 500, max: 10000 });
  });

  it('should preserve existing max when only min is updated (common-token-transfer usdValue)', async () => {
    const mockApi = {
      alertsGet: vi.fn().mockResolvedValue({
        type: 'common-token-transfer',
        data: {
          chains: ['ethereum'],
          usdValue: { min: 100, max: 999999 },
          subjects: [{ type: 'label', value: 'smart_money' }],
          inclusion: {},
          exclusion: {},
        },
      }),
      alertsUpdate: vi.fn().mockResolvedValue({ id: 'abc123' }),
    };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await cmd(['update', 'abc123'], mockApi, {}, { 'usd-max': '5000000' });
    const sentData = mockApi.alertsUpdate.mock.calls[0][0].data;
    expect(sentData.usdValue).toEqual({ min: 100, max: 5000000 });
  });
});

describe('alerts create -- type-specific validation', () => {
  it('should reject sm-token-flows create with no flow thresholds', async () => {
    const mockApi = { alertsCreate: vi.fn() };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await expect(cmd(['create'], mockApi, {}, {
      name: 'Test',
      type: 'sm-token-flows',
      chains: 'ethereum',
      telegram: '123',
    })).rejects.toThrow('at least one flow threshold');
    expect(mockApi.alertsCreate).not.toHaveBeenCalled();
  });

  it('should reject common-token-transfer create with no subjects or tokens', async () => {
    const mockApi = { alertsCreate: vi.fn() };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await expect(cmd(['create'], mockApi, {}, {
      name: 'Test',
      type: 'common-token-transfer',
      chains: 'ethereum',
      telegram: '123',
    })).rejects.toThrow('at least one --subject or --token');
    expect(mockApi.alertsCreate).not.toHaveBeenCalled();
  });

  it('should reject smart-contract-call create with no caller/contract/signature-hash', async () => {
    const mockApi = { alertsCreate: vi.fn() };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await expect(cmd(['create'], mockApi, {}, {
      name: 'Test',
      type: 'smart-contract-call',
      chains: 'ethereum',
      telegram: '123',
    })).rejects.toThrow('at least one --caller, --contract, or --signature-hash');
    expect(mockApi.alertsCreate).not.toHaveBeenCalled();
  });

  it('should allow valid sm-token-flows create with flow threshold', async () => {
    const mockApi = { alertsCreate: vi.fn().mockResolvedValue({ id: 'new' }) };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await cmd(['create'], mockApi, {}, {
      name: 'Test',
      type: 'sm-token-flows',
      chains: 'ethereum',
      telegram: '123',
      'inflow-1h-min': '1000000',
    });
    expect(mockApi.alertsCreate).toHaveBeenCalled();
  });
});

describe('alerts update -- type-specific validation', () => {
  it('should reject update that clears last flow threshold via --data', async () => {
    const mockApi = {
      alertsGet: vi.fn().mockResolvedValue({
        type: 'sm-token-flows',
        data: {
          chains: ['ethereum'],
          inflow_1h: { min: 1000000, max: 50000000 },
          inclusion: {},
          exclusion: {},
        },
      }),
      alertsUpdate: vi.fn(),
    };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await expect(cmd(['update', 'abc123'], mockApi, {}, {
      data: JSON.stringify({
        inflow_1h: { min: null, max: null },
        outflow_1h: { min: null, max: null },
        netflow_1h: { min: null, max: null },
      }),
    })).rejects.toThrow('at least one flow threshold');
    expect(mockApi.alertsUpdate).not.toHaveBeenCalled();
  });

  it('should reject update that clears last subject via --data', async () => {
    const mockApi = {
      alertsGet: vi.fn().mockResolvedValue({
        type: 'common-token-transfer',
        data: {
          chains: ['ethereum'],
          subjects: [{ type: 'label', value: 'CEX' }],
          inclusion: {},
          exclusion: {},
        },
      }),
      alertsUpdate: vi.fn(),
    };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await expect(cmd(['update', 'abc123'], mockApi, {}, {
      data: JSON.stringify({ subjects: [] }),
    })).rejects.toThrow('at least one --subject or --token');
    expect(mockApi.alertsUpdate).not.toHaveBeenCalled();
  });

  it('should allow update when validation still passes after merge', async () => {
    const mockApi = {
      alertsGet: vi.fn().mockResolvedValue({
        type: 'sm-token-flows',
        data: {
          chains: ['ethereum'],
          inflow_1h: { min: 1000000, max: 50000000 },
          outflow_1d: { min: 500, max: 10000 },
          inclusion: {},
          exclusion: {},
        },
      }),
      alertsUpdate: vi.fn().mockResolvedValue({ id: 'abc123' }),
    };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await cmd(['update', 'abc123'], mockApi, {}, { 'inflow-1h-max': '99000000' });
    expect(mockApi.alertsUpdate).toHaveBeenCalled();
  });
});

describe('perp screener CLI handler - new filters (ECINT-6680)', () => {
  let commands;
  let mockApi;

  beforeEach(() => {
    commands = buildCommands({});
    mockApi = {
      perpScreener: vi.fn().mockResolvedValue({ data: [] }),
      perpLeaderboard: vi.fn().mockResolvedValue({ leaders: [] }),
    };
  });

  it('dispatches screener with no new options (baseline)', async () => {
    await commands['perp'](['screener'], mockApi, {}, { days: '7' });
    expect(mockApi.perpScreener).toHaveBeenCalledWith(expect.objectContaining({
      days: 7,
    }));
    const call = mockApi.perpScreener.mock.calls[0][0];
    expect(call.traderType).toBeUndefined();
    expect(call.sectorsFilter).toBeUndefined();
    expect(call.smLabelFilter).toBeUndefined();
    expect(call.traderLabelFilter).toBeUndefined();
  });

  it('passes trader-type through to perpScreener', async () => {
    await commands['perp'](['screener'], mockApi, {}, { 'trader-type': 'whale' });
    expect(mockApi.perpScreener).toHaveBeenCalledWith(expect.objectContaining({
      traderType: 'whale',
    }));
  });

  it('splits sectors-filter CSV into array', async () => {
    await commands['perp'](['screener'], mockApi, {}, { 'sectors-filter': 'Crypto:AI,Crypto:DeFi' });
    expect(mockApi.perpScreener).toHaveBeenCalledWith(expect.objectContaining({
      sectorsFilter: ['Crypto:AI', 'Crypto:DeFi'],
    }));
  });

  it('splits sm-label-filter CSV into array', async () => {
    await commands['perp'](['screener'], mockApi, {}, { 'sm-label-filter': '30D Smart Trader,Smart LP' });
    expect(mockApi.perpScreener).toHaveBeenCalledWith(expect.objectContaining({
      smLabelFilter: ['30D Smart Trader', 'Smart LP'],
    }));
  });

  it('splits trader-label-filter CSV into array', async () => {
    await commands['perp'](['screener'], mockApi, {}, { 'trader-label-filter': 'HL Perps Whale' });
    expect(mockApi.perpScreener).toHaveBeenCalledWith(expect.objectContaining({
      traderLabelFilter: ['HL Perps Whale'],
    }));
  });

  it('handles single-value sectors-filter (no comma)', async () => {
    await commands['perp'](['screener'], mockApi, {}, { 'sectors-filter': 'Crypto:AI' });
    expect(mockApi.perpScreener).toHaveBeenCalledWith(expect.objectContaining({
      sectorsFilter: ['Crypto:AI'],
    }));
  });

  it('passes all four new options together', async () => {
    await commands['perp'](['screener'], mockApi, {}, {
      'trader-type': 'sm',
      'sectors-filter': 'Crypto:AI',
      'sm-label-filter': '30D Smart Trader',
      'trader-label-filter': 'HL Perps Whale',
    });
    expect(mockApi.perpScreener).toHaveBeenCalledWith(expect.objectContaining({
      traderType: 'sm',
      sectorsFilter: ['Crypto:AI'],
      smLabelFilter: ['30D Smart Trader'],
      traderLabelFilter: ['HL Perps Whale'],
    }));
  });

  it('rejects non-string sectors-filter (JSON-primitive) with INVALID_PARAMS instead of crashing', async () => {
    await expect(
      commands['perp'](['screener'], mockApi, {}, { 'sectors-filter': true })
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_PARAMS });
  });

  it('accepts a repeated --sectors-filter flag (parseArgs array) instead of rejecting it as non-string', async () => {
    await commands['perp'](['screener'], mockApi, {}, { 'sectors-filter': ['Crypto:AI', 'Crypto:DeFi'] });
    expect(mockApi.perpScreener).toHaveBeenCalledWith(expect.objectContaining({
      sectorsFilter: ['Crypto:AI', 'Crypto:DeFi'],
    }));
  });

  it('rejects a non-string element in a repeated --sectors-filter flag', async () => {
    await expect(
      commands['perp'](['screener'], mockApi, {}, { 'sectors-filter': ['Crypto:AI', true] })
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_PARAMS });
  });

  it('trims whitespace and drops blank entries in a repeated --sectors-filter flag, matching the CSV-string path', async () => {
    await commands['perp'](['screener'], mockApi, {}, { 'sectors-filter': [' Crypto:AI ', '', 'Crypto:DeFi'] });
    expect(mockApi.perpScreener).toHaveBeenCalledWith(expect.objectContaining({
      sectorsFilter: ['Crypto:AI', 'Crypto:DeFi'],
    }));
  });

  it('rejects non-string sm-label-filter (JSON-primitive) with INVALID_PARAMS instead of crashing', async () => {
    await expect(
      commands['perp'](['screener'], mockApi, {}, { 'sm-label-filter': true })
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_PARAMS });
  });

  it('rejects non-string trader-label-filter (JSON-primitive) with INVALID_PARAMS instead of crashing', async () => {
    await expect(
      commands['perp'](['screener'], mockApi, {}, { 'trader-label-filter': true })
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_PARAMS });
  });

  it('treats an empty --sectors-filter as "no filter" (undefined), not an empty-array filter', async () => {
    await commands['perp'](['screener'], mockApi, {}, { 'sectors-filter': '' });
    const call = mockApi.perpScreener.mock.calls[0][0];
    expect(call.sectorsFilter).toBeUndefined();
  });
});

describe('--paginate / --all flag integration (API-275)', () => {
  let outputs;
  let errors;
  let exitCode;
  let requestBodies;

  // The mock mirrors NansenAPI: handler methods route through request(), which
  // is the method --paginate wraps. 23 rows served 10 per page.
  function MockAPI() {
    this.servedFromCache = false;
    this.lastResponseMeta = null;
    this.paginatedResponseMeta = null;
    this.request = vi.fn(async (endpoint, body) => {
      requestBodies.push(body);
      if (!body.pagination) return { data: [{ kind: 'single-page' }] };
      const { page, per_page = 10 } = body.pagination;
      const start = (page - 1) * per_page;
      return { data: Array.from({ length: Math.max(0, Math.min(per_page, 23 - start)) }, (_, i) => ({ id: start + i })) };
    });
    this.smartMoneyNetflow = function ({ chains, pagination }) {
      return this.request('/api/v1/smart-money/netflow', { chains, filters: {}, order_by: undefined, pagination });
    };
    this.tokenOhlcv = function ({ tokenAddress, chain, timeframe }) {
      return this.request('/api/v1/tgm/token-ohlcv', { token_address: tokenAddress, chain, timeframe });
    };
  }

  const deps = () => ({
    output: (msg) => outputs.push(msg),
    errorOutput: (msg) => errors.push(msg),
    exit: (code) => { exitCode = code; },
    NansenAPIClass: MockAPI,
  });

  beforeEach(() => { outputs = []; errors = []; exitCode = null; requestBodies = []; });

  it('keeps the default single-page behaviour without the flag', async () => {
    const d = deps();
    const result = await runCLI(['smart-money', 'netflow', '--limit', '10'], d);
    expect(result.type).toBe('success');
    expect(result.data.data).toHaveLength(10);
    expect(result.data.pagination).toBeUndefined();
  });

  it('merges every page and reports traversal metadata', async () => {
    const result = await runCLI(['smart-money', 'netflow', '--limit', '10', '--paginate'], deps());
    expect(result.type).toBe('success');
    const out = JSON.parse(outputs[0]);
    expect(out.success).toBe(true);
    expect(out.data.data.map(r => r.id)).toEqual(Array.from({ length: 23 }, (_, i) => i));
    expect(out.data.pagination).toEqual({ page: 1, pages_fetched: 3, next_page: null, complete: true });
  });

  it('accepts --all as an alias and starts from --page', async () => {
    const result = await runCLI(['smart-money', 'netflow', '--limit', '10', '--page', '2', '--all'], deps());
    expect(result.data.data.map(r => r.id)).toEqual(Array.from({ length: 13 }, (_, i) => 10 + i));
    expect(result.data.pagination.page).toBe(2);
  });

  it('bounds traversal with --max-pages and marks the result incomplete', async () => {
    const result = await runCLI(['smart-money', 'netflow', '--limit', '5', '--paginate', '--max-pages', '2'], deps());
    expect(result.data.data).toHaveLength(10);
    expect(result.data.pagination).toEqual({ page: 1, pages_fetched: 2, next_page: 3, complete: false });
  });

  it('does not paginate an endpoint whose request omits pagination', async () => {
    const result = await runCLI(['token', 'ohlcv', '--token', 'abc', '--paginate'], deps());
    expect(result.data).toEqual({ data: [{ kind: 'single-page' }] });
  });

  it('streams all merged rows as NDJSON with --stream', async () => {
    const result = await runCLI(['smart-money', 'netflow', '--limit', '10', '--paginate', '--stream'], deps());
    expect(result.type).toBe('stream');
    const lines = outputs[0].split('\n');
    expect(lines).toHaveLength(23);
    expect(JSON.parse(lines[22]).id).toBe(22);
  });

  it('formats nested data.data rows individually for stream, table, and CSV', () => {
    const nested = {
      data: { data: [{ id: 1, name: 'one' }, { id: 2, name: 'two' }] },
      pagination: { complete: true },
    };

    expect(formatStream(nested).split('\n').map(JSON.parse)).toEqual(nested.data.data);
    expect(formatTable(nested)).toContain('one  │ 1');
    expect(formatTable(nested)).toContain('two  │ 2');
    expect(formatCsv(nested)).toBe('id,name\n1,one\n2,two');
  });

  it('formats a descriptive single-array-key envelope as individual rows without --paginate', () => {
    const descriptive = {
      trades: [{ id: 1 }, { id: 2 }],
      pagination: {},
    };

    expect(formatStream(descriptive).split('\n').map(JSON.parse)).toEqual(descriptive.trades);
    expect(formatStream(descriptive)).not.toContain('trades');
    const table = formatTable(descriptive);
    expect(table.split('\n').slice(2).map(line => line.trim())).toEqual(['1', '2']);
    expect(table).not.toContain('trades');
    expect(formatCsv(descriptive)).toBe('id\n1\n2');
  });

  it.each(['0', '-1', '1.5', '9007199254740992', 'Infinity', 'false', '', '   '])(
    'rejects invalid --max-pages value %# with the machine-readable error envelope',
    async (value) => {
      const d = deps();
      const result = await runCLI(['smart-money', 'netflow', '--paginate', '--max-pages', value], d);
      expect(result.type).toBe('error');
      expect(exitCode).toBe(1);
      const out = JSON.parse(outputs[0]);
      expect(out).toMatchObject({ success: false, code: 'INVALID_PARAMS' });
      expect(out.error).toMatch(/--max-pages (requires|must be) a positive safe integer/);
    },
  );

  it('rejects valueless and repeated --max-pages options', async () => {
    let result = await runCLI(['smart-money', 'netflow', '--paginate', '--max-pages'], deps());
    expect(result.type).toBe('error');
    expect(exitCode).toBe(1);
    expect(JSON.parse(outputs[0]).error).toBe('--max-pages requires a positive safe integer value');

    outputs = [];
    exitCode = null;
    result = await runCLI([
      'smart-money', 'netflow', '--paginate', '--max-pages', '2', '--max-pages', '3',
    ], deps());
    expect(result.type).toBe('error');
    expect(exitCode).toBe(1);
    expect(JSON.parse(outputs[0]).error).toBe('--max-pages may only be specified once');
  });

  it.each([
    ['zero', ['--max-pages', '0']],
    ['non-numeric', ['--max-pages', 'not-a-number']],
    ['over-ceiling', ['--max-pages', '1001']],
    ['valueless', ['--max-pages']],
    ['repeated', ['--max-pages', '2', '--max-pages', '3']],
  ])(
    'ignores an invalid %s --max-pages when pagination is disabled without leaking it upstream',
    async (_case, maxPageArgs) => {
      const result = await runCLI(
        ['smart-money', 'netflow', '--limit', '10', ...maxPageArgs], deps(),
      );
      expect(result.type).toBe('success');
      expect(result.data.data).toHaveLength(10);
      expect(requestBodies).toHaveLength(1);
      expect(requestBodies[0]).not.toHaveProperty('max-pages');
      expect(requestBodies[0]).not.toHaveProperty('max_pages');
      expect(requestBodies[0].pagination).toEqual({ page: 1, per_page: 10 });
    },
  );

  it('caps --max-pages to bound traversal memory and billed requests', async () => {
    const result = await runCLI(['smart-money', 'netflow', '--paginate', '--max-pages', '1001'], deps());
    expect(result.type).toBe('error');
    expect(exitCode).toBe(1);
    expect(JSON.parse(outputs[0]).error).toBe('--max-pages must be at most 1000; received: 1001');
  });

  it('accepts --max-pages at the configured ceiling', async () => {
    const result = await runCLI([
      'smart-money', 'netflow', '--paginate', '--max-pages', String(MAX_PAGES_LIMIT),
    ], deps());
    expect(result.type).toBe('success');
    expect(result.data.data).toHaveLength(23);
  });

  it('reports aggregate credits and a low-credit warning for the whole traversal', async () => {
    function MetadataAPI() {
      this.servedFromCache = false;
      this.request = vi.fn(async (_endpoint, body) => {
        const { page } = body.pagination;
        this.lastResponseMeta = {
          credits: { used: 4, remaining: page === 1 ? 8 : 3, cost: 4 },
        };
        this.lastEndpoint = '/api/v1/smart-money/netflow';
        return { data: page === 1 ? [{ id: 1 }, { id: 2 }] : [{ id: 3 }] };
      });
      this.smartMoneyNetflow = ({ pagination }) => this.request('/api/v1/smart-money/netflow', { pagination });
    }
    const d = { ...deps(), NansenAPIClass: MetadataAPI };

    await runCLI(['smart-money', 'netflow', '--limit', '2', '--paginate'], d);

    expect(errors).toEqual([
      '⚠️  3 API credits left — less than the aggregate cost of 2 live page requests (8). Top up at https://app.nansen.ai/api?tab=api',
      'Credits: 8 (2 page requests)',
    ]);
    expect(JSON.parse(outputs[0]).data.data).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  });

  it('reports charges from completed pages when a later page fails', async () => {
    function FailingMetadataAPI() {
      this.servedFromCache = false;
      this.lastResponseMeta = null;
      this.request = vi.fn(async (_endpoint, body) => {
        const { page } = body.pagination;
        this.lastEndpoint = '/api/v1/smart-money/netflow';
        if (page === 1) {
          this.lastResponseMeta = { credits: { used: 2, remaining: 20, cost: 2 } };
          return { data: [{ id: 1 }, { id: 2 }] };
        }
        throw new NansenError('Page two failed', ErrorCode.RATE_LIMITED, 429, {
          credits: { used: 4, remaining: 16, cost: 4 },
          requestId: 'failed-page-2',
        });
      });
      this.smartMoneyNetflow = ({ pagination }) => this.request(
        '/api/v1/smart-money/netflow', { pagination },
      );
    }

    const result = await runCLI(['smart-money', 'netflow', '--limit', '2', '--paginate'], {
      ...deps(),
      NansenAPIClass: FailingMetadataAPI,
    });

    expect(result.type).toBe('error');
    expect(JSON.parse(outputs[0])).toMatchObject({
      success: false,
      error: 'Page two failed',
      code: 'RATE_LIMITED',
    });
    expect(errors).toEqual(['Credits: 6 (2 page requests)']);
  });

  it('labels a one-page live traversal as a page request', async () => {
    function MetadataAPI() {
      this.servedFromCache = false;
      this.request = vi.fn(async () => {
        this.lastResponseMeta = { credits: { used: 2, remaining: 20, cost: 2 } };
        this.lastEndpoint = '/api/v1/smart-money/netflow';
        return { pagination: { page: 1, total_pages: 1 }, data: [{ id: 1 }] };
      });
      this.smartMoneyNetflow = ({ pagination }) => this.request('/api/v1/smart-money/netflow', { pagination });
    }

    await runCLI(['smart-money', 'netflow', '--limit', '10', '--paginate'], {
      ...deps(),
      NansenAPIClass: MetadataAPI,
    });

    expect(errors).toContain('Credits: 2 (1 page request)');
  });

  it('labels multiple live requests within a partly cached traversal', async () => {
    function MetadataAPI() {
      this.servedFromCache = false;
      this.lastResponseMeta = null;
      this.paginatedResponseMeta = null;
      this.request = vi.fn(async (_endpoint, body) => {
        const { page } = body.pagination;
        this.servedFromCache = page === 2;
        if (!this.servedFromCache) {
          this.lastResponseMeta = { credits: { used: 2, remaining: 50, cost: 2 } };
        }
        this.lastEndpoint = '/api/v1/smart-money/netflow';
        return {
          data: [{ id: page }],
          pagination: { page, per_page: 1, total_pages: 4 },
        };
      });
      this.smartMoneyNetflow = ({ pagination }) => this.request(
        '/api/v1/smart-money/netflow', { pagination },
      );
    }

    await runCLI(['smart-money', 'netflow', '--limit', '1', '--paginate'], {
      ...deps(),
      NansenAPIClass: MetadataAPI,
    });

    expect(errors).toContain('Credits: 6 (3 live of 4 page requests)');
    expect(errors).not.toContain('Credits: 6 (3 page requests)');
  });

  it('preserves transfer traversal metadata across paginated enrichment lookups', async () => {
    let instance;
    function EnrichedTransfersAPI() {
      instance = this;
      this.servedFromCache = false;
      this.lastResponseMeta = null;
      this.paginatedResponseMeta = null;
      this.request = vi.fn(async (endpoint, body) => {
        const { page, per_page: perPage } = body.pagination;
        this.servedFromCache = false;
        this.lastEndpoint = endpoint;
        if (endpoint === '/api/v1/tgm/transfers') {
          this.lastResponseMeta = { credits: { used: 5, remaining: page === 1 ? 15 : 10, cost: 5 } };
          const transfers = page === 1
            ? [{ id: 1, from: '0xaaa', to: '0xbbb' }, { id: 2, from: '0xaaa', to: '0xbbb' }]
            : [{ id: 3, from: '0xaaa', to: '0xbbb' }];
          return { transfers };
        }
        this.lastResponseMeta = { credits: { used: 1, remaining: 9, cost: 1 } };
        return {
          data: [{ label: 'Smart Trader' }],
          pagination: { page, per_page: perPage, total_pages: 1 },
        };
      });
      this.tokenTransfers = ({ pagination }) => this.request('/api/v1/tgm/transfers', { pagination });
      this.addressLabels = ({ address, chain }) => this.request('/api/v1/profiler/address/labels', {
        address, chain, pagination: { page: 1, per_page: 100 },
      });
    }

    const result = await runCLI([
      'token', 'transfers', '--token', '0xabc', '--limit', '2', '--paginate', '--enrich',
    ], { ...deps(), NansenAPIClass: EnrichedTransfersAPI });

    expect(result.type).toBe('success');
    expect(result.data.transfers).toHaveLength(3);
    expect(result.data.transfers[0].from_labels).toEqual(['Smart Trader']);
    expect(instance.paginatedResponseMeta).toEqual({
      credits: { used: 10, remaining: 10, cost: 10 },
      pagination: { pagesFetched: 2, livePages: 2, cachedPages: 0 },
    });
    expect(instance.lastEndpoint).toBe('/api/v1/profiler/address/labels');
    expect(instance.paginatedEndpoint).toBe('/api/v1/tgm/transfers');
    expect(errors).toContain('Credits: 10 (2 page requests)');
    expect(errors).not.toContain('Credits: 1 (1 page request)');
  });
});
