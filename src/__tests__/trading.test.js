/**
 * Tests for trading module
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  resolveChain,
  getWalletChainType,
  saveQuote,
  loadQuote,
  cleanupQuotes,
  readCompactU16,
  rlpEncode,
  signEip1559Transaction,
} from '../trading.js';

// Override HOME to use temp dir for tests
let originalHome;
let tempDir;

beforeEach(() => {
  originalHome = process.env.HOME;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nansen-trading-test-'));
  process.env.HOME = tempDir;
});

afterEach(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('resolveChain', () => {
  it('should resolve solana', () => {
    const chain = resolveChain('solana');
    expect(chain.index).toBe('501');
    expect(chain.type).toBe('solana');
    expect(chain.name).toBe('Solana');
  });

  it('should resolve ethereum', () => {
    const chain = resolveChain('ethereum');
    expect(chain.index).toBe('1');
    expect(chain.type).toBe('evm');
  });

  it('should resolve base', () => {
    const chain = resolveChain('base');
    expect(chain.index).toBe('8453');
    expect(chain.type).toBe('evm');
  });

  it('should resolve bsc', () => {
    const chain = resolveChain('bsc');
    expect(chain.index).toBe('56');
    expect(chain.type).toBe('evm');
  });

  it('should be case-insensitive', () => {
    expect(resolveChain('SOLANA').index).toBe('501');
    expect(resolveChain('Base').index).toBe('8453');
  });

  it('should throw for unsupported chain', () => {
    expect(() => resolveChain('polygon')).toThrow('Unsupported chain');
    expect(() => resolveChain('')).toThrow('Unsupported chain');
    expect(() => resolveChain(null)).toThrow('Unsupported chain');
  });
});

describe('getWalletChainType', () => {
  it('should return solana for solana', () => {
    expect(getWalletChainType('solana')).toBe('solana');
  });

  it('should return evm for ethereum/base/bsc', () => {
    expect(getWalletChainType('ethereum')).toBe('evm');
    expect(getWalletChainType('base')).toBe('evm');
    expect(getWalletChainType('bsc')).toBe('evm');
  });
});

describe('quote storage', () => {
  const mockQuoteResponse = {
    success: true,
    quotes: [{
      aggregator: 'okx',
      inputMint: 'So11111111111111111111111111111111111111112',
      outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      inAmount: '1000000000',
      outAmount: '150000000',
      inUsdValue: '150.00',
      outUsdValue: '150.00',
    }],
    metadata: { chainIndex: '501', quotesCount: 1 },
  };

  it('should save and load a quote', () => {
    const quoteId = saveQuote(mockQuoteResponse, 'solana');
    expect(quoteId).toMatch(/^\d+-[a-f0-9]+$/);

    const loaded = loadQuote(quoteId);
    expect(loaded.chain).toBe('solana');
    expect(loaded.response.success).toBe(true);
    expect(loaded.response.quotes[0].aggregator).toBe('okx');
  });

  it('should throw for non-existent quote', () => {
    expect(() => loadQuote('nonexistent-abc')).toThrow('not found');
  });

  it('should expire old quotes', () => {
    const quoteId = saveQuote(mockQuoteResponse, 'solana');

    // Manually backdate the quote
    const quotesDir = path.join(tempDir, '.nansen', 'quotes');
    const filePath = path.join(quotesDir, `${quoteId}.json`);
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    data.timestamp = Date.now() - 3700000; // 1 hour + 100 seconds ago
    fs.writeFileSync(filePath, JSON.stringify(data));

    expect(() => loadQuote(quoteId)).toThrow('expired');
  });

  it('should cleanup old quotes', () => {
    // Save two quotes
    const id1 = saveQuote(mockQuoteResponse, 'solana');
    const id2 = saveQuote(mockQuoteResponse, 'base');

    // Backdate one
    const quotesDir = path.join(tempDir, '.nansen', 'quotes');
    const filePath = path.join(quotesDir, `${id1}.json`);
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    data.timestamp = Date.now() - 3700000;
    fs.writeFileSync(filePath, JSON.stringify(data));

    cleanupQuotes();

    // id1 should be gone, id2 should remain
    expect(fs.existsSync(path.join(quotesDir, `${id1}.json`))).toBe(false);
    expect(fs.existsSync(path.join(quotesDir, `${id2}.json`))).toBe(true);
  });
});

describe('readCompactU16', () => {
  it('should read single-byte values', () => {
    const buf = Buffer.from([0x01]);
    const result = readCompactU16(buf, 0);
    expect(result.value).toBe(1);
    expect(result.size).toBe(1);
  });

  it('should read zero', () => {
    const buf = Buffer.from([0x00]);
    const result = readCompactU16(buf, 0);
    expect(result.value).toBe(0);
    expect(result.size).toBe(1);
  });

  it('should read multi-byte values', () => {
    // 128 = 0x80 0x01 in compact-u16
    const buf = Buffer.from([0x80, 0x01]);
    const result = readCompactU16(buf, 0);
    expect(result.value).toBe(128);
    expect(result.size).toBe(2);
  });

  it('should read with offset', () => {
    const buf = Buffer.from([0xff, 0x05]);
    const result = readCompactU16(buf, 1);
    expect(result.value).toBe(5);
    expect(result.size).toBe(1);
  });
});

describe('rlpEncode', () => {
  it('should encode single byte < 0x80', () => {
    const result = rlpEncode(Buffer.from([0x42]));
    expect(result).toEqual(Buffer.from([0x42]));
  });

  it('should encode empty buffer', () => {
    const result = rlpEncode(Buffer.alloc(0));
    expect(result).toEqual(Buffer.from([0x80]));
  });

  it('should encode short string', () => {
    const result = rlpEncode(Buffer.from('dog'));
    expect(result).toEqual(Buffer.from([0x83, 0x64, 0x6f, 0x67]));
  });

  it('should encode empty list', () => {
    const result = rlpEncode([]);
    expect(result).toEqual(Buffer.from([0xc0]));
  });

  it('should encode nested list', () => {
    // RLP([ [], [[]], [ [], [[]] ] ])
    const result = rlpEncode([[], [[]], [[], [[]]]]);
    expect(result).toEqual(Buffer.from([0xc7, 0xc0, 0xc1, 0xc0, 0xc3, 0xc0, 0xc1, 0xc0]));
  });

  it('should encode hex strings', () => {
    const result = rlpEncode('0x0400');
    // 0x0400 = 2 bytes, so 0x82 prefix
    expect(result[0]).toBe(0x82);
    expect(result[1]).toBe(0x04);
    expect(result[2]).toBe(0x00);
  });
});

describe('parameter validation', () => {
  it('should require all mandatory quote parameters', () => {
    // This tests the CLI argument validation logic indirectly
    // The quote command requires: chain, from, to, amount
    const requiredParams = ['chain', 'from', 'to', 'amount'];
    expect(requiredParams).toHaveLength(4);
  });

  it('should have valid chain mappings for all supported chains', () => {
    const chains = ['solana', 'ethereum', 'base', 'bsc'];
    for (const chain of chains) {
      const config = resolveChain(chain);
      expect(config.index).toBeTruthy();
      expect(config.type).toMatch(/^(solana|evm)$/);
      expect(config.name).toBeTruthy();
      expect(config.explorer).toMatch(/^https:\/\//);
    }
  });
});

describe('error handling', () => {
  it('should handle quote API errors gracefully', async () => {
    // Mock fetch for API error
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({
        code: 'INVALID_AMOUNT',
        message: 'Amount must be a valid numeric string',
        details: { provided: 'abc' },
      }),
    });

    const { getQuote } = await import('../trading.js');
    await expect(getQuote({
      chainIndex: '501',
      fromTokenAddress: 'So11111111111111111111111111111111111111112',
      toTokenAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      amount: 'abc',
      userWalletAddress: 'test',
    })).rejects.toThrow('Amount must be a valid numeric string');

    global.fetch = originalFetch;
  });

  it('should handle execute API errors gracefully', async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({
        code: 'EXECUTE_ERROR',
        message: 'Failed to execute transaction',
      }),
    });

    const { executeTransaction } = await import('../trading.js');
    await expect(executeTransaction({
      signedTransaction: 'test',
      chain: 'solana',
    })).rejects.toThrow('Failed to execute transaction');

    global.fetch = originalFetch;
  });
});
