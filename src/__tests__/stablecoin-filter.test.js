/**
 * Stablecoin Filter Tests
 *
 * Tests for the token screener stablecoin filtering feature:
 * - Stablecoins excluded by default
 * - --include-stables keeps them
 * - Non-stablecoins never filtered
 * - Wrapped tokens like WETH not filtered
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildCommands } from '../cli.js';

const STABLECOIN_TOKENS = [
  { token_symbol: 'USDC', token_name: 'USD Coin', price_usd: 1.0, price_change_24h: 0.001 },
  { token_symbol: 'USDT', token_name: 'Tether', price_usd: 1.0, price_change_24h: 0.0005 },
  { token_symbol: 'DAI', token_name: 'Dai', price_usd: 1.0, price_change_24h: 0.0 },
  { token_symbol: 'FRAX', token_name: 'Frax', price_usd: 0.999, price_change_24h: 0.001 },
  { token_symbol: 'BUSD', token_name: 'Binance USD', price_usd: 1.001, price_change_24h: 0.0 },
  { token_symbol: 'USDe', token_name: 'USDe', price_usd: 1.0, price_change_24h: 0.0 },
  { token_symbol: 'GHO', token_name: 'GHO', price_usd: 1.0, price_change_24h: 0.0 },
  { token_symbol: 'EURS', token_name: 'EURS', price_usd: 1.07, price_change_24h: 0.002 },
];

const NON_STABLECOIN_TOKENS = [
  { token_symbol: 'SOL', token_name: 'Solana', price_usd: 150.0, price_change_24h: 3.5 },
  { token_symbol: 'PEPE', token_name: 'Pepe', price_usd: 0.000012, price_change_24h: 12.0 },
  { token_symbol: 'WETH', token_name: 'Wrapped Ether', price_usd: 2800.0, price_change_24h: 1.5 },
  { token_symbol: 'CBBTC', token_name: 'Coinbase BTC', price_usd: 65000.0, price_change_24h: 0.5 },
  { token_symbol: 'BONK', token_name: 'Bonk', price_usd: 0.00003, price_change_24h: 8.0 },
];

describe('Stablecoin Filtering - token screener', () => {
  let commands;

  beforeEach(() => {
    commands = buildCommands({
      log: () => {},
      exit: vi.fn(),
      promptFn: vi.fn(),
      saveConfigFn: vi.fn(),
      deleteConfigFn: vi.fn(),
      getConfigFileFn: vi.fn(() => '/home/user/.nansen/config.json'),
      NansenAPIClass: vi.fn()
    });
  });

  describe('default behaviour (stablecoins excluded)', () => {
    it('filters known stablecoin symbols from flat data', async () => {
      const mockApi = {
        tokenScreener: vi.fn().mockResolvedValue({
          data: [...STABLECOIN_TOKENS, ...NON_STABLECOIN_TOKENS]
        })
      };
      const result = await commands['token'](['screener'], mockApi, {}, {});
      const symbols = result.data.map(t => t.token_symbol);
      expect(symbols).not.toContain('USDC');
      expect(symbols).not.toContain('USDT');
      expect(symbols).not.toContain('DAI');
      expect(symbols).not.toContain('FRAX');
      expect(symbols).not.toContain('USDe');
      expect(symbols).not.toContain('GHO');
    });

    it('keeps all non-stablecoin tokens', async () => {
      const mockApi = {
        tokenScreener: vi.fn().mockResolvedValue({
          data: [...STABLECOIN_TOKENS, ...NON_STABLECOIN_TOKENS]
        })
      };
      const result = await commands['token'](['screener'], mockApi, {}, {});
      const symbols = result.data.map(t => t.token_symbol);
      expect(symbols).toContain('SOL');
      expect(symbols).toContain('PEPE');
      expect(symbols).toContain('BONK');
    });

    it('does not filter WETH (wrapped token, not a stablecoin)', async () => {
      const mockApi = {
        tokenScreener: vi.fn().mockResolvedValue({
          data: [
            { token_symbol: 'WETH', token_name: 'Wrapped Ether', price_usd: 2800.0, price_change_24h: 1.5 }
          ]
        })
      };
      const result = await commands['token'](['screener'], mockApi, {}, {});
      expect(result.data.map(t => t.token_symbol)).toContain('WETH');
    });

    it('does not filter CBBTC (high-value non-stablecoin)', async () => {
      const mockApi = {
        tokenScreener: vi.fn().mockResolvedValue({
          data: [
            { token_symbol: 'CBBTC', token_name: 'Coinbase BTC', price_usd: 65000.0, price_change_24h: 0.5 }
          ]
        })
      };
      const result = await commands['token'](['screener'], mockApi, {}, {});
      expect(result.data.map(t => t.token_symbol)).toContain('CBBTC');
    });

    it('filters stablecoins from nested data shape', async () => {
      const mockApi = {
        tokenScreener: vi.fn().mockResolvedValue({
          data: {
            data: [...STABLECOIN_TOKENS, ...NON_STABLECOIN_TOKENS],
            pagination: { page: 1 }
          }
        })
      };
      const result = await commands['token'](['screener'], mockApi, {}, {});
      const symbols = result.data.data.map(t => t.token_symbol);
      expect(symbols).not.toContain('USDC');
      expect(symbols).not.toContain('USDT');
      expect(symbols).toContain('SOL');
      expect(result.data.pagination.page).toBe(1);
    });

    it('filters by price heuristic when symbol is unknown but price is pegged', async () => {
      const mockApi = {
        tokenScreener: vi.fn().mockResolvedValue({
          data: [
            // Unknown symbol but price and change look like a stablecoin
            { token_symbol: 'NEWUSD', token_name: 'New USD', price_usd: 1.005, price_change_24h: 0.003 },
            { token_symbol: 'VOLATILE', token_name: 'Volatile', price_usd: 1.005, price_change_24h: 5.0 },
          ]
        })
      };
      const result = await commands['token'](['screener'], mockApi, {}, {});
      const symbols = result.data.map(t => t.token_symbol);
      // NEWUSD: price within 2% of 1.0 AND abs(change) < 0.01 => filtered
      expect(symbols).not.toContain('NEWUSD');
      // VOLATILE: price within 2% of 1.0 but change is large => NOT filtered
      expect(symbols).toContain('VOLATILE');
    });
  });

  describe('--include-stables flag', () => {
    it('keeps stablecoins when --include-stables option is set', async () => {
      const mockApi = {
        tokenScreener: vi.fn().mockResolvedValue({
          data: [...STABLECOIN_TOKENS, ...NON_STABLECOIN_TOKENS]
        })
      };
      const result = await commands['token'](['screener'], mockApi, {}, { 'include-stables': true });
      const symbols = result.data.map(t => t.token_symbol);
      expect(symbols).toContain('USDC');
      expect(symbols).toContain('USDT');
      expect(symbols).toContain('DAI');
    });

    it('keeps stablecoins when --include-stables flag is set', async () => {
      const mockApi = {
        tokenScreener: vi.fn().mockResolvedValue({
          data: [...STABLECOIN_TOKENS, ...NON_STABLECOIN_TOKENS]
        })
      };
      const result = await commands['token'](['screener'], mockApi, { 'include-stables': true }, {});
      const symbols = result.data.map(t => t.token_symbol);
      expect(symbols).toContain('USDC');
      expect(symbols).toContain('USDT');
    });
  });

  describe('interaction with --search', () => {
    it('filters stablecoins before applying search', async () => {
      const mockApi = {
        tokenScreener: vi.fn().mockResolvedValue({
          data: [
            { token_symbol: 'USDC', token_name: 'USD Coin', price_usd: 1.0, price_change_24h: 0.001 },
            { token_symbol: 'PEPE', token_name: 'Pepe', price_usd: 0.001, price_change_24h: 5.0 },
            { token_symbol: 'PEPEFORK', token_name: 'Pepe Fork', price_usd: 0.0001, price_change_24h: 3.0 },
          ]
        })
      };
      // search for 'USD' - without include-stables, USDC should be filtered out
      const result = await commands['token'](['screener'], mockApi, {}, { search: 'USD' });
      const symbols = result.data.map(t => t.token_symbol);
      expect(symbols).not.toContain('USDC');
    });

    it('keeps stablecoins in search when --include-stables is set', async () => {
      const mockApi = {
        tokenScreener: vi.fn().mockResolvedValue({
          data: [
            { token_symbol: 'USDC', token_name: 'USD Coin', price_usd: 1.0, price_change_24h: 0.001 },
            { token_symbol: 'PEPE', token_name: 'Pepe', price_usd: 0.001, price_change_24h: 5.0 },
          ]
        })
      };
      const result = await commands['token'](['screener'], mockApi, {}, { search: 'USD', 'include-stables': true });
      const symbols = result.data.map(t => t.token_symbol);
      expect(symbols).toContain('USDC');
    });
  });

  describe('SCHEMA', () => {
    it('defines include-stables option on screener subcommand', async () => {
      const { SCHEMA } = await import('../cli.js');
      const screener = SCHEMA.commands['token'].subcommands['screener'];
      expect(screener.options['include-stables']).toBeDefined();
      expect(screener.options['include-stables'].type).toBe('boolean');
    });
  });
});
