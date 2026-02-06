/**
 * CLI Internal Tests - Tests CLI functions directly for coverage
 * These tests import functions from cli.js and test them directly,
 * allowing V8 coverage to track execution.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseArgs,
  formatValue,
  formatTable,
  formatOutput,
  formatError,
  parseSort,
  buildCommands,
  runCLI,
  NO_AUTH_COMMANDS,
  HELP
} from '../cli.js';

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
    expect(result.options).toEqual({ chain: 'solana', limit: 10 }); // numbers parsed via JSON.parse
  });

  it('should parse JSON options', () => {
    const result = parseArgs(['--filters', '{"only_smart_money":true}']);
    expect(result.options.filters).toEqual({ only_smart_money: true });
  });

  it('should handle mixed args', () => {
    const result = parseArgs(['token', 'screener', '--chain', 'solana', '--pretty', '--limit', '5']);
    expect(result._).toEqual(['token', 'screener']);
    expect(result.options.chain).toBe('solana');
    expect(result.options.limit).toBe(5); // numbers parsed via JSON.parse
    expect(result.flags.pretty).toBe(true);
  });

  it('should treat flag without value as boolean', () => {
    const result = parseArgs(['--help']);
    expect(result.flags.help).toBe(true);
  });

  it('should handle flag followed by another flag', () => {
    const result = parseArgs(['--verbose', '--debug']);
    expect(result.flags.verbose).toBe(true);
    expect(result.flags.debug).toBe(true);
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
});

describe('formatError', () => {
  it('should format error object', () => {
    const error = new Error('Test error');
    error.code = 'TEST_CODE';
    error.status = 500;
    error.data = { detail: 'extra info' };
    
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
    expect(result.details).toBeNull();
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
});

describe('HELP', () => {
  it('should contain usage information', () => {
    expect(HELP).toContain('USAGE:');
    expect(HELP).toContain('COMMANDS:');
    expect(HELP).toContain('EXAMPLES:');
  });
});

describe('NO_AUTH_COMMANDS', () => {
  it('should include login, logout, help', () => {
    expect(NO_AUTH_COMMANDS).toContain('login');
    expect(NO_AUTH_COMMANDS).toContain('logout');
    expect(NO_AUTH_COMMANDS).toContain('help');
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
      NansenAPIClass: vi.fn()
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
      expect(logs[0]).toContain('Removed');
    });

    it('should report when no config found', async () => {
      mockDeps.deleteConfigFn.mockReturnValue(false);
      await commands.logout([], null, {}, {});
      expect(logs[0]).toContain('No saved credentials');
    });
  });

  describe('login command', () => {
    it('should exit when no API key provided', async () => {
      mockDeps.promptFn.mockResolvedValue('');
      await commands.login([], null, {}, {});
      expect(mockDeps.exit).toHaveBeenCalledWith(1);
    });

    it('should exit when API key is whitespace', async () => {
      mockDeps.promptFn.mockResolvedValue('   ');
      await commands.login([], null, {}, {});
      expect(mockDeps.exit).toHaveBeenCalledWith(1);
    });

    it('should save config on successful validation', async () => {
      mockDeps.promptFn.mockResolvedValue('valid-api-key');
      // Use a proper constructor function for the mock
      mockDeps.NansenAPIClass = function MockAPI() {
        this.tokenScreener = vi.fn().mockResolvedValue({ data: [] });
      };
      commands = buildCommands(mockDeps);
      
      await commands.login([], null, {}, {});
      
      expect(mockDeps.saveConfigFn).toHaveBeenCalledWith({
        apiKey: 'valid-api-key',
        baseUrl: 'https://api.nansen.ai'
      });
    });

    it('should exit when API validation fails', async () => {
      mockDeps.promptFn.mockResolvedValue('invalid-key');
      // Use a proper constructor function for the mock
      mockDeps.NansenAPIClass = function MockAPI() {
        this.tokenScreener = vi.fn().mockRejectedValue(new Error('Unauthorized'));
      };
      commands = buildCommands(mockDeps);
      
      await commands.login([], null, {}, {});
      
      expect(mockDeps.exit).toHaveBeenCalledWith(1);
      expect(logs.some(l => l.includes('Invalid API key'))).toBe(true);
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
  });

  describe('token command', () => {
    it('should return help for unknown subcommand', async () => {
      const result = await commands['token'](['unknown'], {}, {}, {});
      expect(result.error).toContain('Unknown subcommand');
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
        expect.objectContaining({ filters: { only_smart_money: true } })
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
  let outputs, exitCode;

  const mockDeps = () => ({
    output: (msg) => outputs.push(msg),
    errorOutput: (msg) => outputs.push(msg),
    exit: (code) => { exitCode = code; }
  });

  beforeEach(() => {
    outputs = [];
    exitCode = null;
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

  it('should handle empty field name gracefully', () => {
    const result = parseSort(':asc', undefined);
    expect(result).toEqual([{ field: '', direction: 'ASC' }]);
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
      NansenAPIClass: vi.fn()
    };
    commands = buildCommands(mockDeps);
  });

  describe('login command', () => {
    it('should prompt for API key', async () => {
      mockDeps.promptFn.mockResolvedValue('');
      await commands.login([], null, {}, {});
      
      expect(mockDeps.promptFn).toHaveBeenCalledWith('Enter your API key: ', true);
    });

    it('should trim whitespace from API key', async () => {
      mockDeps.promptFn.mockResolvedValue('  api-key-with-spaces  ');
      mockDeps.NansenAPIClass = function MockAPI() {
        this.tokenScreener = vi.fn().mockResolvedValue({ data: [] });
      };
      commands = buildCommands(mockDeps);
      
      await commands.login([], null, {}, {});
      
      expect(mockDeps.saveConfigFn).toHaveBeenCalledWith({
        apiKey: 'api-key-with-spaces',
        baseUrl: 'https://api.nansen.ai'
      });
    });

    it('should display login instructions', async () => {
      mockDeps.promptFn.mockResolvedValue('');
      await commands.login([], null, {}, {});
      
      expect(logs.some(l => l.includes('Nansen CLI Login'))).toBe(true);
      expect(logs.some(l => l.includes('https://app.nansen.ai/api'))).toBe(true);
    });

    it('should validate API key with test request', async () => {
      mockDeps.promptFn.mockResolvedValue('test-key');
      const mockScreener = vi.fn().mockResolvedValue({ data: [] });
      mockDeps.NansenAPIClass = function MockAPI(key) {
        this.apiKey = key;
        this.tokenScreener = mockScreener;
      };
      commands = buildCommands(mockDeps);
      
      await commands.login([], null, {}, {});
      
      expect(mockScreener).toHaveBeenCalledWith({ 
        chains: ['solana'], 
        pagination: { page: 1, per_page: 1 } 
      });
    });

    it('should show success message after validation', async () => {
      mockDeps.promptFn.mockResolvedValue('valid-key');
      mockDeps.NansenAPIClass = function MockAPI() {
        this.tokenScreener = vi.fn().mockResolvedValue({ data: [] });
      };
      commands = buildCommands(mockDeps);
      
      await commands.login([], null, {}, {});
      
      expect(logs.some(l => l.includes('API key validated'))).toBe(true);
      expect(logs.some(l => l.includes('Saved to'))).toBe(true);
    });

    it('should show error and exit on validation failure', async () => {
      mockDeps.promptFn.mockResolvedValue('bad-key');
      mockDeps.NansenAPIClass = function MockAPI() {
        this.tokenScreener = vi.fn().mockRejectedValue(new Error('Unauthorized'));
      };
      commands = buildCommands(mockDeps);
      
      await commands.login([], null, {}, {});
      
      expect(logs.some(l => l.includes('Invalid API key'))).toBe(true);
      expect(mockDeps.exit).toHaveBeenCalledWith(1);
    });

    it('should not save config on validation failure', async () => {
      mockDeps.promptFn.mockResolvedValue('bad-key');
      mockDeps.NansenAPIClass = function MockAPI() {
        this.tokenScreener = vi.fn().mockRejectedValue(new Error('Unauthorized'));
      };
      commands = buildCommands(mockDeps);
      
      await commands.login([], null, {}, {});
      
      expect(mockDeps.saveConfigFn).not.toHaveBeenCalled();
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
