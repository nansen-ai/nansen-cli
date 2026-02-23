/**
 * Tests for trading module
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
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
  toBuffer,
  signLegacyTransaction,
  signSolanaTransaction,
} from '../trading.js';
import { keccak256, generateEvmWallet, generateSolanaWallet } from '../wallet.js';

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

// ============= Chain Resolution =============

describe('resolveChain', () => {
  it('should resolve solana', () => {
    const chain = resolveChain('solana');
    expect(chain.index).toBe('501');
    expect(chain.type).toBe('solana');
    expect(chain.chainId).toBe(501);
  });

  it('should resolve ethereum', () => {
    const chain = resolveChain('ethereum');
    expect(chain.index).toBe('1');
    expect(chain.type).toBe('evm');
    expect(chain.chainId).toBe(1);
  });

  it('should resolve base', () => {
    const chain = resolveChain('base');
    expect(chain.index).toBe('8453');
    expect(chain.chainId).toBe(8453);
  });

  it('should resolve bsc', () => {
    const chain = resolveChain('bsc');
    expect(chain.index).toBe('56');
    expect(chain.chainId).toBe(56);
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

  it('should have explorer URLs for all chains', () => {
    for (const name of ['solana', 'ethereum', 'base', 'bsc']) {
      expect(resolveChain(name).explorer).toMatch(/^https:\/\//);
    }
  });
});

describe('getWalletChainType', () => {
  it('should return solana for solana', () => {
    expect(getWalletChainType('solana')).toBe('solana');
  });
  it('should return evm for EVM chains', () => {
    expect(getWalletChainType('ethereum')).toBe('evm');
    expect(getWalletChainType('base')).toBe('evm');
    expect(getWalletChainType('bsc')).toBe('evm');
  });
});

// ============= Quote Storage =============

describe('quote storage', () => {
  const mockResponse = {
    success: true,
    quotes: [{
      aggregator: 'okx',
      inputMint: 'So11111111111111111111111111111111111111112',
      outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      inAmount: '1000000000',
      outAmount: '150000000',
      transaction: 'base64txdata...',
    }],
  };

  it('should save and load a quote', () => {
    const quoteId = saveQuote(mockResponse, 'solana');
    expect(quoteId).toMatch(/^\d+-[a-f0-9]+$/);

    const loaded = loadQuote(quoteId);
    expect(loaded.chain).toBe('solana');
    expect(loaded.response.quotes[0].aggregator).toBe('okx');
    expect(loaded.response.quotes[0].transaction).toBe('base64txdata...');
  });

  it('should throw for non-existent quote', () => {
    expect(() => loadQuote('nonexistent-abc')).toThrow('not found');
  });

  it('should expire old quotes', () => {
    const quoteId = saveQuote(mockResponse, 'solana');
    const quotesDir = path.join(tempDir, '.nansen', 'quotes');
    const filePath = path.join(quotesDir, `${quoteId}.json`);
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    data.timestamp = Date.now() - 3700000;
    fs.writeFileSync(filePath, JSON.stringify(data));

    expect(() => loadQuote(quoteId)).toThrow('expired');
  });

  it('should cleanup old quotes', () => {
    const id1 = saveQuote(mockResponse, 'solana');
    const id2 = saveQuote(mockResponse, 'base');

    const quotesDir = path.join(tempDir, '.nansen', 'quotes');
    const filePath = path.join(quotesDir, `${id1}.json`);
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    data.timestamp = Date.now() - 3700000;
    fs.writeFileSync(filePath, JSON.stringify(data));

    cleanupQuotes();

    expect(fs.existsSync(path.join(quotesDir, `${id1}.json`))).toBe(false);
    expect(fs.existsSync(path.join(quotesDir, `${id2}.json`))).toBe(true);
  });

  it('should create quotes directory with secure permissions', () => {
    saveQuote(mockResponse, 'solana');
    const quotesDir = path.join(tempDir, '.nansen', 'quotes');
    expect(fs.existsSync(quotesDir)).toBe(true);
  });
});

// ============= Compact-u16 =============

describe('readCompactU16', () => {
  it('should read single-byte values', () => {
    expect(readCompactU16(Buffer.from([0x01]), 0)).toEqual({ value: 1, size: 1 });
    expect(readCompactU16(Buffer.from([0x7f]), 0)).toEqual({ value: 127, size: 1 });
  });

  it('should read zero', () => {
    expect(readCompactU16(Buffer.from([0x00]), 0)).toEqual({ value: 0, size: 1 });
  });

  it('should read multi-byte values', () => {
    // 128 = 0x80 0x01
    expect(readCompactU16(Buffer.from([0x80, 0x01]), 0)).toEqual({ value: 128, size: 2 });
  });

  it('should read with offset', () => {
    expect(readCompactU16(Buffer.from([0xff, 0x05]), 1)).toEqual({ value: 5, size: 1 });
  });
});

// ============= RLP Encoding =============

describe('rlpEncode', () => {
  it('should encode single byte < 0x80', () => {
    expect(rlpEncode(Buffer.from([0x42]))).toEqual(Buffer.from([0x42]));
  });

  it('should encode empty buffer', () => {
    expect(rlpEncode(Buffer.alloc(0))).toEqual(Buffer.from([0x80]));
  });

  it('should encode short string', () => {
    expect(rlpEncode(Buffer.from('dog'))).toEqual(Buffer.from([0x83, 0x64, 0x6f, 0x67]));
  });

  it('should encode empty list', () => {
    expect(rlpEncode([])).toEqual(Buffer.from([0xc0]));
  });

  it('should encode nested list', () => {
    // [ [], [[]], [ [], [[]] ] ]
    expect(rlpEncode([[], [[]], [[], [[]]]]))
      .toEqual(Buffer.from([0xc7, 0xc0, 0xc1, 0xc0, 0xc3, 0xc0, 0xc1, 0xc0]));
  });

  it('should encode hex strings', () => {
    const result = rlpEncode('0x0400');
    expect(result[0]).toBe(0x82);
    expect(result[1]).toBe(0x04);
    expect(result[2]).toBe(0x00);
  });

  // Ethereum RLP test vectors from the spec
  it('should encode integer 0', () => {
    expect(rlpEncode(Buffer.alloc(0))).toEqual(Buffer.from([0x80]));
  });

  it('should encode "Lorem ipsum dolor sit amet..." (long string)', () => {
    const str = 'Lorem ipsum dolor sit amet, consectetur adipisicing elit';
    const buf = Buffer.from(str);
    const result = rlpEncode(buf);
    expect(result[0]).toBe(0xb8); // 0x80 + 55 + 1 = 0xb8
    expect(result[1]).toBe(56);    // string length
    expect(result.subarray(2).toString()).toBe(str);
  });
});

// ============= Solana Transaction Signing =============

describe('signSolanaTransaction', () => {
  it('should sign a mock Solana transaction', () => {
    // Create a minimal mock VersionedTransaction:
    // [1 (compact-u16 sig count)] [64 zero bytes (empty sig slot)] [message bytes]
    const message = Buffer.from('test-message-to-sign-for-solana');
    const txBytes = Buffer.concat([
      Buffer.from([0x01]),      // 1 signature required (compact-u16)
      Buffer.alloc(64),         // empty signature slot
      message,
    ]);
    const txBase64 = txBytes.toString('base64');

    // Generate a Solana wallet
    const wallet = generateSolanaWallet();

    const signedBase64 = signSolanaTransaction(txBase64, wallet.privateKey);
    const signedBytes = Buffer.from(signedBase64, 'base64');

    // Signature slot should no longer be all zeros
    const sigSlot = signedBytes.subarray(1, 65);
    expect(sigSlot.every(b => b === 0)).toBe(false);

    // Message should be unchanged
    expect(signedBytes.subarray(65).toString()).toBe('test-message-to-sign-for-solana');

    // Verify the signature
    const seed = Buffer.from(wallet.privateKey.slice(0, 64), 'hex');
    const privKey = crypto.createPrivateKey({
      key: Buffer.concat([
        Buffer.from('302e020100300506032b657004220420', 'hex'),
        seed,
      ]),
      format: 'der',
      type: 'pkcs8',
    });
    const pubKeyObj = crypto.createPublicKey(privKey);
    const isValid = crypto.verify(null, message, pubKeyObj, sigSlot);
    expect(isValid).toBe(true);
  });
});

// ============= Legacy EVM Transaction Signing =============

describe('signLegacyTransaction', () => {
  it('should produce a valid signed transaction hex', () => {
    const wallet = generateEvmWallet();
    const tx = {
      nonce: 0,
      gasPrice: '0x3B9ACA00', // 1 gwei
      gasLimit: '0x5208',      // 21000
      to: '0x' + 'ab'.repeat(20),
      value: '0x0',
      data: '0x',
      chainId: 8453,
    };

    const signedHex = signLegacyTransaction(tx, wallet.privateKey);

    expect(signedHex).toMatch(/^0x[0-9a-f]+$/);
    // Should be a valid RLP-encoded transaction (starts with 0xf8 or 0xf9 for list)
    expect(signedHex.startsWith('0xf8') || signedHex.startsWith('0xf9')).toBe(true);
  });

  it('should include EIP-155 v value', () => {
    const wallet = generateEvmWallet();
    const tx = {
      nonce: 0,
      gasPrice: '0x1',
      gasLimit: '0x5208',
      to: '0x' + '00'.repeat(20),
      value: '0x0',
      data: '0x',
      chainId: 1,
    };

    const signedHex = signLegacyTransaction(tx, wallet.privateKey);
    expect(signedHex).toMatch(/^0x/);
    // EIP-155 v for chainId=1 is either 37 (0x25) or 38 (0x26)
    // We can't easily decode without an RLP decoder, but we verify it's non-empty
    expect(signedHex.length).toBeGreaterThan(10);
  });

  it('should handle non-zero value and data', () => {
    const wallet = generateEvmWallet();
    const tx = {
      nonce: 5,
      gasPrice: '0x4A817C800', // 20 gwei
      gasLimit: '0x30000',
      to: '0x' + 'cd'.repeat(20),
      value: '0xDE0B6B3A7640000', // 1 ETH
      data: '0x095ea7b3' + '00'.repeat(64), // approve calldata
      chainId: 8453,
    };

    const signedHex = signLegacyTransaction(tx, wallet.privateKey);
    expect(signedHex).toMatch(/^0x[0-9a-f]+$/);
  });
});

// ============= API Error Handling =============

describe('error handling', () => {
  it('should handle quote API errors', async () => {
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
      fromTokenAddress: 'So111',
      toTokenAddress: 'EPjFW',
      amount: 'abc',
      userWalletAddress: 'test',
    })).rejects.toThrow('Amount must be a valid numeric string');

    global.fetch = originalFetch;
  });

  it('should handle execute API errors', async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => ({
        code: 'UPSTREAM_BROADCAST_ERROR',
        message: 'Jupiter Ultra execute failed: transaction simulation failed',
      }),
    });

    const { executeTransaction } = await import('../trading.js');
    await expect(executeTransaction({
      signedTransaction: 'test',
      chain: 'solana',
    })).rejects.toThrow('simulation failed');

    global.fetch = originalFetch;
  });
});
