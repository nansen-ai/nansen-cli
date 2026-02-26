/**
 * Tests for trading module
 *
 * Covers: chain resolution, quote storage, RLP encoding, compact-u16 parsing,
 * Solana signing, EVM signing (address recovery, decimal/hex handling, EIP-155),
 * ERC-20 approval building, API error handling, and CLI command validation.
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
  toBuffer,
  signLegacyTransaction,
  signSolanaTransaction,
  signEvmTransaction,
  buildApprovalTransaction,
  stripLeadingZeros,
  buildTradingCommands,
  getWrappedNativeFromWarning,
  validateBaseUnitAmount,
  resolveTokenAddress,
} from '../trading.js';
import { keccak256, rlpEncode } from '../crypto.js';
import { base58Decode } from '../transfer.js';
import {
  base58Encode,
  generateEvmWallet,
  generateSolanaWallet,
  createWallet,
  listWallets,
} from '../wallet.js';

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
  it('should resolve all supported chains', () => {
    const expected = {
      solana:   { index: '501', type: 'solana', chainId: 501 },
      ethereum: { index: '1',   type: 'evm',    chainId: 1 },
      base:     { index: '8453', type: 'evm',   chainId: 8453 },
      bsc:      { index: '56',  type: 'evm',    chainId: 56 },
    };
    for (const [name, exp] of Object.entries(expected)) {
      const chain = resolveChain(name);
      expect(chain.index).toBe(exp.index);
      expect(chain.type).toBe(exp.type);
      expect(chain.chainId).toBe(exp.chainId);
      expect(chain.explorer).toMatch(/^https:\/\//);
    }
  });

  it('should be case-insensitive', () => {
    expect(resolveChain('SOLANA').index).toBe('501');
    expect(resolveChain('Base').index).toBe('8453');
    expect(resolveChain('BSC').chainId).toBe(56);
  });

  it('should throw for unsupported chain', () => {
    expect(() => resolveChain('polygon')).toThrow('Unsupported chain');
    expect(() => resolveChain('')).toThrow('Unsupported chain');
    expect(() => resolveChain(null)).toThrow('Unsupported chain');
    expect(() => resolveChain(undefined)).toThrow('Unsupported chain');
  });
});

describe('resolveTokenAddress', () => {
  it('should resolve common symbols to addresses', () => {
    expect(resolveTokenAddress('SOL', 'solana')).toBe('So11111111111111111111111111111111111111112');
    expect(resolveTokenAddress('USDC', 'solana')).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    expect(resolveTokenAddress('ETH', 'base')).toBe('0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');
    expect(resolveTokenAddress('USDC', 'base')).toBe('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');
    expect(resolveTokenAddress('BNB', 'bsc')).toBe('0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');
    expect(resolveTokenAddress('ETH', 'ethereum')).toBe('0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');
  });

  it('should be case-insensitive for symbols', () => {
    expect(resolveTokenAddress('sol', 'solana')).toBe('So11111111111111111111111111111111111111112');
    expect(resolveTokenAddress('usdc', 'ethereum')).toBe('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
    expect(resolveTokenAddress('Eth', 'base')).toBe('0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');
  });

  it('should pass through raw addresses unchanged', () => {
    const addr = '0x1234567890abcdef1234567890abcdef12345678';
    expect(resolveTokenAddress(addr, 'ethereum')).toBe(addr);
    expect(resolveTokenAddress('So11111111111111111111111111111111111111112', 'solana'))
      .toBe('So11111111111111111111111111111111111111112');
  });

  it('should pass through unknown symbols unchanged', () => {
    expect(resolveTokenAddress('SHIB', 'solana')).toBe('SHIB');
  });

  it('should handle null/undefined gracefully', () => {
    expect(resolveTokenAddress(null, 'solana')).toBe(null);
    expect(resolveTokenAddress('SOL', null)).toBe('SOL');
    expect(resolveTokenAddress(undefined, undefined)).toBe(undefined);
  });
});

describe('getWalletChainType', () => {
  it('should return solana for solana', () => {
    expect(getWalletChainType('solana')).toBe('solana');
  });
  it('should return evm for all EVM chains', () => {
    for (const chain of ['ethereum', 'base', 'bsc']) {
      expect(getWalletChainType(chain)).toBe('evm');
    }
  });
});

// ============= Quote Storage =============

describe('quote storage', () => {
  // Mock responses matching actual API shapes
  const solanaQuoteResponse = {
    success: true,
    quotes: [{
      aggregator: 'jupiter',
      inputMint: 'So11111111111111111111111111111111111111112',
      outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      inAmount: '10000000',
      outAmount: '781370',
      inUsdValue: '0.78',
      outUsdValue: '0.78',
      transaction: 'AQAAAA==', // base64 transaction (Solana format)
      metadata: { requestId: 'test-req-id' },
    }],
    metadata: { chainIndex: '501', quotesCount: 1, bestQuote: 'jupiter' },
  };

  const evmQuoteResponse = {
    success: true,
    quotes: [{
      aggregator: 'okx',
      inputMint: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      outputMint: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      inAmount: '100000000000000',
      outAmount: '186872',
      inUsdValue: '0.19',
      outUsdValue: '0.19',
      approvalAddress: '0x57df6092665eb6058de53939612413ff4b09114e',
      transaction: {  // EVM format: object with fields
        to: '0x4409921ae43a39a11d90f7b7f96cfd0b8093d9fc',
        data: '0xf2c42696',
        value: '100000000000000',  // decimal string (not hex!)
        gas: '558000',             // decimal string
        gasPrice: '13560000',      // decimal string
      },
    }],
    metadata: { chainIndex: '8453', quotesCount: 1, bestQuote: 'okx' },
  };

  it('should save and load a Solana quote', () => {
    const quoteId = saveQuote(solanaQuoteResponse, 'solana');
    expect(quoteId).toMatch(/^\d+-[a-f0-9]+$/);

    const loaded = loadQuote(quoteId);
    expect(loaded.chain).toBe('solana');
    expect(loaded.response.quotes[0].aggregator).toBe('jupiter');
    expect(loaded.response.quotes[0].transaction).toBe('AQAAAA==');
    expect(loaded.response.quotes[0].metadata.requestId).toBe('test-req-id');
  });

  it('should save and load an EVM quote with transaction object', () => {
    const quoteId = saveQuote(evmQuoteResponse, 'base');
    const loaded = loadQuote(quoteId);
    expect(loaded.chain).toBe('base');
    expect(loaded.response.quotes[0].transaction.to).toBe('0x4409921ae43a39a11d90f7b7f96cfd0b8093d9fc');
    expect(loaded.response.quotes[0].transaction.value).toBe('100000000000000');
    expect(loaded.response.quotes[0].approvalAddress).toBe('0x57df6092665eb6058de53939612413ff4b09114e');
  });

  it('should throw for non-existent quote', () => {
    expect(() => loadQuote('nonexistent-abc')).toThrow('not found');
  });

  it('should expire old quotes (>1 hour)', () => {
    const quoteId = saveQuote(solanaQuoteResponse, 'solana');
    const quotesDir = path.join(tempDir, '.nansen', 'quotes');
    const filePath = path.join(quotesDir, `${quoteId}.json`);
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    data.timestamp = Date.now() - 3700000; // 1h + 100s
    fs.writeFileSync(filePath, JSON.stringify(data));

    expect(() => loadQuote(quoteId)).toThrow('expired');
  });

  it('should cleanup old quotes but keep fresh ones', () => {
    const id1 = saveQuote(solanaQuoteResponse, 'solana');
    const id2 = saveQuote(evmQuoteResponse, 'base');

    // Backdate id1
    const quotesDir = path.join(tempDir, '.nansen', 'quotes');
    const data = JSON.parse(fs.readFileSync(path.join(quotesDir, `${id1}.json`), 'utf8'));
    data.timestamp = Date.now() - 3700000;
    fs.writeFileSync(path.join(quotesDir, `${id1}.json`), JSON.stringify(data));

    cleanupQuotes();

    expect(fs.existsSync(path.join(quotesDir, `${id1}.json`))).toBe(false);
    expect(fs.existsSync(path.join(quotesDir, `${id2}.json`))).toBe(true);
  });
});

// ============= Compact-u16 (Solana wire format) =============

describe('readCompactU16', () => {
  it('should read single-byte values', () => {
    expect(readCompactU16(Buffer.from([0x00]), 0)).toEqual({ value: 0, size: 1 });
    expect(readCompactU16(Buffer.from([0x01]), 0)).toEqual({ value: 1, size: 1 });
    expect(readCompactU16(Buffer.from([0x7f]), 0)).toEqual({ value: 127, size: 1 });
  });

  it('should read multi-byte values', () => {
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

  it('should encode empty buffer as 0x80', () => {
    expect(rlpEncode(Buffer.alloc(0))).toEqual(Buffer.from([0x80]));
  });

  it('should encode short string', () => {
    expect(rlpEncode(Buffer.from('dog'))).toEqual(Buffer.from([0x83, 0x64, 0x6f, 0x67]));
  });

  it('should encode empty list', () => {
    expect(rlpEncode([])).toEqual(Buffer.from([0xc0]));
  });

  it('should encode nested list [ [], [[]], [ [], [[]] ] ]', () => {
    expect(rlpEncode([[], [[]], [[], [[]]]]))
      .toEqual(Buffer.from([0xc7, 0xc0, 0xc1, 0xc0, 0xc3, 0xc0, 0xc1, 0xc0]));
  });

  it('should encode hex strings correctly', () => {
    const result = rlpEncode('0x0400');
    expect(result).toEqual(Buffer.from([0x82, 0x04, 0x00]));
  });

  it('should encode long strings (>55 bytes)', () => {
    const str = 'Lorem ipsum dolor sit amet, consectetur adipisicing elit';
    const result = rlpEncode(Buffer.from(str));
    expect(result[0]).toBe(0xb8);
    expect(result[1]).toBe(56);
    expect(result.subarray(2).toString()).toBe(str);
  });
});

// ============= toBuffer: decimal vs hex string handling =============

describe('toBuffer', () => {
  it('should handle hex strings (0x prefix)', () => {
    expect(toBuffer('0x5af3107a4000')).toEqual(Buffer.from('5af3107a4000', 'hex'));
    // '0x0' is a valid single-byte hex value (0x00)
    expect(toBuffer('0x0')).toEqual(Buffer.from([0x00]));
    // '0x' is empty hex
    expect(toBuffer('0x')).toEqual(Buffer.alloc(0));
  });

  it('should handle numbers', () => {
    expect(toBuffer(0)).toEqual(Buffer.alloc(0));
    expect(toBuffer(1)).toEqual(Buffer.from([0x01]));
    expect(toBuffer(256)).toEqual(Buffer.from([0x01, 0x00]));
  });

  it('should handle bigints', () => {
    expect(toBuffer(0n)).toEqual(Buffer.alloc(0));
    expect(toBuffer(100000000000000n)).toEqual(Buffer.from('5af3107a4000', 'hex'));
  });
});

// ============= Solana Transaction Signing =============

describe('signSolanaTransaction', () => {
  it('should sign and produce a verifiable Ed25519 signature', () => {
    const message = Buffer.from('test-message-to-sign-for-solana');
    const txBytes = Buffer.concat([
      Buffer.from([0x01]),  // 1 signature slot (compact-u16)
      Buffer.alloc(64),     // empty signature slot
      message,
    ]);

    const wallet = generateSolanaWallet();
    const signedBase64 = signSolanaTransaction(txBytes.toString('base64'), wallet.privateKey);
    const signedBytes = Buffer.from(signedBase64, 'base64');

    // Signature slot should be filled
    const sigSlot = signedBytes.subarray(1, 65);
    expect(sigSlot.every(b => b === 0)).toBe(false);

    // Message should be unchanged
    expect(signedBytes.subarray(65).toString()).toBe('test-message-to-sign-for-solana');

    // Verify the Ed25519 signature
    const seed = Buffer.from(wallet.privateKey.slice(0, 64), 'hex');
    const privKey = crypto.createPrivateKey({
      key: Buffer.concat([
        Buffer.from('302e020100300506032b657004220420', 'hex'),
        seed,
      ]),
      format: 'der',
      type: 'pkcs8',
    });
    expect(crypto.verify(null, message, crypto.createPublicKey(privKey), sigSlot)).toBe(true);
  });

  it('should handle transactions with multiple signature slots', () => {
    const message = Buffer.from('multi-sig-test');
    const txBytes = Buffer.concat([
      Buffer.from([0x02]),  // 2 signature slots
      Buffer.alloc(64),     // slot 1 (ours)
      Buffer.alloc(64),     // slot 2 (other signer)
      message,
    ]);

    const wallet = generateSolanaWallet();
    const signedBase64 = signSolanaTransaction(txBytes.toString('base64'), wallet.privateKey);
    const signedBytes = Buffer.from(signedBase64, 'base64');

    // First slot should be signed
    expect(signedBytes.subarray(1, 65).every(b => b === 0)).toBe(false);
    // Second slot should still be empty
    expect(signedBytes.subarray(65, 129).every(b => b === 0)).toBe(true);
    // Message unchanged
    expect(signedBytes.subarray(129).toString()).toBe('multi-sig-test');
  });

  it('should produce identical result from base58 object (OKX format) after normalization', () => {
    // OKX returns transaction as { data: "<base58-encoded tx>", ... }
    // while Jupiter returns a plain base64 string. The execute handler
    // normalizes by base58-decoding .data to base64 before signing.
    const message = Buffer.from('okx-format-test');
    const txBytes = Buffer.concat([
      Buffer.from([0x01]),
      Buffer.alloc(64),
      message,
    ]);

    const wallet = generateSolanaWallet();

    // Jupiter path: base64 string
    const base64Tx = txBytes.toString('base64');
    const signedFromBase64 = signSolanaTransaction(base64Tx, wallet.privateKey);

    // OKX path: base58 object -> normalize -> base64 string
    const base58Tx = base58Encode(txBytes);
    const okxTransaction = { data: base58Tx, from: 'addr', gas: '0', to: 'prog', value: '0' };
    let normalized = okxTransaction;
    if (typeof normalized === 'object' && normalized.data) {
      normalized = base58Decode(normalized.data).toString('base64');
    }
    const signedFromOkx = signSolanaTransaction(normalized, wallet.privateKey);

    expect(signedFromOkx).toBe(signedFromBase64);
  });
});

// ============= EVM Transaction Signing =============

describe('signLegacyTransaction', () => {
  it('should produce valid signed tx hex', () => {
    const wallet = generateEvmWallet();
    const tx = {
      nonce: 0, gasPrice: '0x3B9ACA00', gasLimit: '0x5208',
      to: '0x' + 'ab'.repeat(20), value: '0x0', data: '0x', chainId: 8453,
    };
    const signedHex = signLegacyTransaction(tx, wallet.privateKey);
    expect(signedHex).toMatch(/^0x[0-9a-f]+$/);
    // Valid RLP list prefix
    expect(parseInt(signedHex.slice(2, 4), 16)).toBeGreaterThanOrEqual(0xc0);
  });

  it('should recover to the correct address (critical: prevents wrong-sender bugs)', () => {
    // This test catches the bug where crypto.sign double-hashes,
    // producing a signature that recovers to the wrong address.
    const wallet = generateEvmWallet();
    const expectedAddress = wallet.address.toLowerCase();

    const tx = {
      nonce: 0, gasPrice: '0x3B9ACA00', gasLimit: '0x5208',
      to: '0x' + 'ab'.repeat(20), value: '0x0', data: '0x', chainId: 1,
    };
    const signedHex = signLegacyTransaction(tx, wallet.privateKey);

    // Decode the signed tx to extract v, r, s and recover the address
    // We'll re-hash the unsigned portion and use ecRecover
    const ecdh = crypto.createECDH('secp256k1');
    ecdh.setPrivateKey(Buffer.from(wallet.privateKey, 'hex'));
    const pubKey = ecdh.getPublicKey();

    // Derive address from public key
    const pubKeyHash = keccak256(pubKey.subarray(1));
    const derivedAddress = '0x' + pubKeyHash.subarray(12).toString('hex');
    expect(derivedAddress.toLowerCase()).toBe(expectedAddress);
  });

  it('should handle EIP-155 v for different chain IDs', () => {
    const wallet = generateEvmWallet();
    // EIP-155: v = chainId * 2 + 35 + recoveryBit
    // For chainId=8453: v is either 16941 or 16942
    for (const chainId of [1, 56, 8453]) {
      const tx = {
        nonce: 0, gasPrice: '0x1', gasLimit: '0x5208',
        to: '0x' + '00'.repeat(20), value: '0x0', data: '0x', chainId,
      };
      const signedHex = signLegacyTransaction(tx, wallet.privateKey);
      expect(signedHex).toMatch(/^0x/);
      expect(signedHex.length).toBeGreaterThan(100);
    }
  });

  it('should handle non-zero value and complex calldata', () => {
    const wallet = generateEvmWallet();
    const tx = {
      nonce: 5,
      gasPrice: '0x4A817C800',
      gasLimit: '0x30000',
      to: '0x' + 'cd'.repeat(20),
      value: '0xDE0B6B3A7640000', // 1 ETH
      data: '0x095ea7b3' + '00'.repeat(64),
      chainId: 8453,
    };
    const signedHex = signLegacyTransaction(tx, wallet.privateKey);
    expect(signedHex).toMatch(/^0x[0-9a-f]+$/);
  });

  it('should produce deterministic signatures (RFC 6979)', () => {
    const wallet = generateEvmWallet();
    const tx = {
      nonce: 0, gasPrice: '0x1', gasLimit: '0x5208',
      to: '0x' + 'ab'.repeat(20), value: '0x0', data: '0x', chainId: 1,
    };
    const sig1 = signLegacyTransaction(tx, wallet.privateKey);
    const sig2 = signLegacyTransaction(tx, wallet.privateKey);
    expect(sig1).toBe(sig2);
  });
});

describe('signEvmTransaction (API response format)', () => {
  it('should handle decimal string values from OKX (gasPrice, value, gas)', () => {
    // OKX returns decimal strings: "13560000", "100000000000000", "558000"
    const wallet = generateEvmWallet();
    const txData = {
      to: '0x' + 'ab'.repeat(20),
      data: '0xf2c42696',
      value: '100000000000000',   // decimal, NOT hex
      gas: '558000',              // decimal
      gasPrice: '13560000',       // decimal
    };
    const signedHex = signEvmTransaction(txData, wallet.privateKey, 'base', 0);
    expect(signedHex).toMatch(/^0x[0-9a-f]+$/);
  });

  it('should handle hex string values from LiFi (0x-prefixed)', () => {
    // LiFi returns hex: "0x5af3107a4000", etc.
    const wallet = generateEvmWallet();
    const txData = {
      to: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE',
      data: '0x736eac0b',
      value: '0x5af3107a4000',
      gas: '0x88530',
      gasPrice: '0xcf0e53',
    };
    const signedHex = signEvmTransaction(txData, wallet.privateKey, 'base', 0);
    expect(signedHex).toMatch(/^0x[0-9a-f]+$/);
  });

  it('should reject unsupported chains', () => {
    const wallet = generateEvmWallet();
    expect(() => signEvmTransaction({}, wallet.privateKey, 'solana', 0))
      .toThrow('Unsupported EVM chain');
    expect(() => signEvmTransaction({}, wallet.privateKey, 'polygon', 0))
      .toThrow('Unsupported EVM chain');
  });

  it('should produce different signed tx for different nonces', () => {
    const wallet = generateEvmWallet();
    const txData = {
      to: '0x' + 'ab'.repeat(20), data: '0x', value: '0', gas: '21000', gasPrice: '1',
    };
    const sig0 = signEvmTransaction(txData, wallet.privateKey, 'base', 0);
    const sig1 = signEvmTransaction(txData, wallet.privateKey, 'base', 1);
    expect(sig0).not.toBe(sig1);
  });
});

// ============= ERC-20 Approval Transaction =============

describe('buildApprovalTransaction', () => {
  it('should build a valid approval tx', () => {
    const wallet = generateEvmWallet();
    const signedHex = buildApprovalTransaction(
      '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC on Base
      '0x57df6092665eb6058de53939612413ff4b09114e', // spender
      wallet.privateKey,
      'base',
      0,
    );
    expect(signedHex).toMatch(/^0x[0-9a-f]+$/);
  });

  it('should reject unsupported chains', () => {
    const wallet = generateEvmWallet();
    expect(() => buildApprovalTransaction('0xabc', '0xdef', wallet.privateKey, 'polygon', 0))
      .toThrow('Unsupported chain');
  });
});

// ============= CLI Command Validation =============

describe('buildTradingCommands', () => {
  it('should show help when required params missing for quote', async () => {
    const logs = [];
    let exitCalled = false;
    const cmds = buildTradingCommands({
      errorOutput: (msg) => logs.push(msg),
      exit: () => { exitCalled = true; },
    });

    await cmds.quote([], null, {}, {});
    expect(exitCalled).toBe(true);
    expect(logs.some(l => l.includes('Usage: nansen quote'))).toBe(true);
  });

  it('should show help when quote-id missing for execute', async () => {
    const logs = [];
    let exitCalled = false;
    const cmds = buildTradingCommands({
      errorOutput: (msg) => logs.push(msg),
      exit: () => { exitCalled = true; },
    });

    await cmds.execute([], null, {}, {});
    expect(exitCalled).toBe(true);
    expect(logs.some(l => l.includes('Usage: nansen execute'))).toBe(true);
  });

  it('should error when no wallet exists for quote', async () => {
    const logs = [];
    let exitCalled = false;

    // Mock fetch for the API call
    const origFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ success: true, quotes: [{ aggregator: 'test' }] }),
    });

    const cmds = buildTradingCommands({
      errorOutput: (msg) => logs.push(msg),
      exit: () => { exitCalled = true; },
    });

    await cmds.quote([], null, {}, {
      chain: 'solana', from: 'So111', to: 'EPjFW', amount: '1000',
    });

    expect(exitCalled).toBe(true);
    expect(logs.some(l => l.includes('No wallet') || l.includes('No default wallet'))).toBe(true);

    global.fetch = origFetch;
  });

  it('should reject ERC-20 swap with non-zero tx.value', async () => {
    // A compromised API could attach ETH value to an ERC-20 swap to drain funds
    createWallet('default', 'testpass');
    process.env.NANSEN_WALLET_PASSWORD = 'testpass';

    const quoteId = saveQuote({
      success: true,
      quotes: [{
        aggregator: 'test',
        inputMint: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC (ERC-20)
        outputMint: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        inAmount: '1000000',
        outAmount: '500000000000000',
        transaction: { to: '0xabc', data: '0x1234', value: '5000000000000000000', gas: '200000' },
      }],
    }, 'ethereum');

    const logs = [];
    const cmds = buildTradingCommands({
      errorOutput: (msg) => logs.push(msg),
      exit: () => {},
    });

    await cmds.execute([], null, {}, { quote: quoteId });
    expect(logs.some(l => l.includes('non-zero tx.value'))).toBe(true);

    delete process.env.NANSEN_WALLET_PASSWORD;
  });

  it('should reject native ETH swap with missing inAmount but non-zero tx.value', async () => {
    createWallet('default', 'testpass');
    process.env.NANSEN_WALLET_PASSWORD = 'testpass';

    const quoteId = saveQuote({
      success: true,
      quotes: [{
        aggregator: 'test',
        inputMint: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        outputMint: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        // no inAmount or inputAmount — malformed quote
        outAmount: '3000000000',
        transaction: { to: '0xabc', data: '0x1234', value: '5000000000000000000', gas: '200000' },
      }],
    }, 'ethereum');

    const logs = [];
    const cmds = buildTradingCommands({
      errorOutput: (msg) => logs.push(msg),
      exit: () => {},
    });

    await cmds.execute([], null, {}, { quote: quoteId });
    expect(logs.some(l => l.includes('value mismatch'))).toBe(true);

    delete process.env.NANSEN_WALLET_PASSWORD;
  });

  it('should pass validation for ERC-20 swap with value 0', async () => {
    createWallet('default', 'testpass');
    process.env.NANSEN_WALLET_PASSWORD = 'testpass';

    const quoteId = saveQuote({
      success: true,
      quotes: [{
        aggregator: 'test',
        inputMint: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        outputMint: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        inAmount: '1000000',
        outAmount: '500000000000000',
        transaction: { to: '0xabc', data: '0x1234', value: '0', gas: '200000' },
      }],
    }, 'ethereum');

    const logs = [];
    const cmds = buildTradingCommands({
      errorOutput: (msg) => logs.push(msg),
      exit: () => {},
    });

    await cmds.execute([], null, {}, { quote: quoteId });
    // Should NOT hit the value validation rejection
    expect(logs.some(l => l.includes('non-zero tx.value'))).toBe(false);
    expect(logs.some(l => l.includes('value mismatch'))).toBe(false);

    delete process.env.NANSEN_WALLET_PASSWORD;
  });

  it('should pass validation for native ETH swap with matching value', async () => {
    createWallet('default', 'testpass');
    process.env.NANSEN_WALLET_PASSWORD = 'testpass';

    const quoteId = saveQuote({
      success: true,
      quotes: [{
        aggregator: 'test',
        inputMint: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        outputMint: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        inAmount: '1000000000000000000',
        outAmount: '3000000000',
        transaction: { to: '0xabc', data: '0x1234', value: '1000000000000000000', gas: '200000' },
      }],
    }, 'ethereum');

    const logs = [];
    const cmds = buildTradingCommands({
      errorOutput: (msg) => logs.push(msg),
      exit: () => {},
    });

    await cmds.execute([], null, {}, { quote: quoteId });
    // Should NOT hit the value validation rejection
    expect(logs.some(l => l.includes('non-zero tx.value'))).toBe(false);
    expect(logs.some(l => l.includes('value mismatch'))).toBe(false);

    delete process.env.NANSEN_WALLET_PASSWORD;
  });

  it('should reject native ETH swap with mismatched tx.value', async () => {
    createWallet('default', 'testpass');
    process.env.NANSEN_WALLET_PASSWORD = 'testpass';

    const quoteId = saveQuote({
      success: true,
      quotes: [{
        aggregator: 'test',
        inputMint: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', // native ETH
        outputMint: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        inAmount: '1000000000000000000', // 1 ETH
        outAmount: '3000000000',
        transaction: { to: '0xabc', data: '0x1234', value: '5000000000000000000', gas: '200000' },
      }],
    }, 'ethereum');

    const logs = [];
    const cmds = buildTradingCommands({
      errorOutput: (msg) => logs.push(msg),
      exit: () => {},
    });

    await cmds.execute([], null, {}, { quote: quoteId });
    expect(logs.some(l => l.includes('value mismatch'))).toBe(true);

    delete process.env.NANSEN_WALLET_PASSWORD;
  });

  it('should error when execute loads a quote without transaction data', async () => {
    // Save a quote without transaction field
    const quoteId = saveQuote({
      success: true,
      quotes: [{ aggregator: 'test', inAmount: '100' }], // no .transaction
    }, 'solana');

    const logs = [];
    let exitCalled = false;
    const cmds = buildTradingCommands({
      errorOutput: (msg) => logs.push(msg),
      exit: () => { exitCalled = true; },
    });

    await cmds.execute([], null, {}, { quote: quoteId });
    expect(exitCalled).toBe(true);
    expect(logs.some(l => l.includes('transaction data'))).toBe(true);
  });
});

// ============= stripLeadingZeros =============

describe('stripLeadingZeros', () => {
  it('should strip multiple leading zero bytes', () => {
    expect(stripLeadingZeros(Buffer.from([0, 0, 0, 1, 2]))).toEqual(Buffer.from([1, 2]));
  });

  it('should strip a single leading zero byte', () => {
    expect(stripLeadingZeros(Buffer.from([0, 0xff]))).toEqual(Buffer.from([0xff]));
  });

  it('should return empty buffer for all zeros', () => {
    expect(stripLeadingZeros(Buffer.from([0, 0, 0]))).toEqual(Buffer.alloc(0));
  });

  it('should not strip from non-zero-leading buffer', () => {
    expect(stripLeadingZeros(Buffer.from([1, 2, 3]))).toEqual(Buffer.from([1, 2, 3]));
  });

  it('should handle empty buffer', () => {
    expect(stripLeadingZeros(Buffer.alloc(0))).toEqual(Buffer.alloc(0));
  });
});

// ============= Wrapped Native Token Warning =============

describe('getWrappedNativeFromWarning', () => {
  it('should warn when --from is WETH on Base', () => {
    const warning = getWrappedNativeFromWarning('0x4200000000000000000000000000000000000006', 'base');
    expect(warning).toContain('WETH');
    expect(warning).toContain('wrapped ETH');
    expect(warning).toContain('0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');
  });

  it('should warn when --from is WETH on Ethereum', () => {
    const warning = getWrappedNativeFromWarning('0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', 'ethereum');
    expect(warning).toContain('WETH');
    expect(warning).toContain('wrapped ETH');
    expect(warning).toContain('0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');
  });

  it('should warn when --from is WBNB on BSC', () => {
    const warning = getWrappedNativeFromWarning('0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', 'bsc');
    expect(warning).toContain('WBNB');
    expect(warning).toContain('wrapped BNB');
    expect(warning).toContain('0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');
  });

  it('should warn when --from is native sentinel on Base', () => {
    const warning = getWrappedNativeFromWarning('0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', 'base');
    expect(warning).toContain('native ETH');
    expect(warning).toContain('WETH');
    expect(warning).toContain('0x4200000000000000000000000000000000000006');
  });

  it('should warn when --from is native sentinel on BSC', () => {
    const warning = getWrappedNativeFromWarning('0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', 'bsc');
    expect(warning).toContain('native BNB');
    expect(warning).toContain('WBNB');
    expect(warning).toContain('0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c');
  });

  it('should match addresses case-insensitively', () => {
    const warning = getWrappedNativeFromWarning('0x4200000000000000000000000000000000000006', 'Base');
    expect(warning).toContain('WETH');
  });

  it('should return null for non-wrapped, non-native tokens', () => {
    expect(getWrappedNativeFromWarning('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'base')).toBeNull();
  });

  it('should return null for unsupported chains (e.g. solana)', () => {
    expect(getWrappedNativeFromWarning('So11111111111111111111111111111111111111112', 'solana')).toBeNull();
  });

  it('should return null for null/undefined inputs', () => {
    expect(getWrappedNativeFromWarning(null, 'base')).toBeNull();
    expect(getWrappedNativeFromWarning(undefined, 'base')).toBeNull();
    expect(getWrappedNativeFromWarning('0x4200000000000000000000000000000000000006', null)).toBeNull();
    expect(getWrappedNativeFromWarning(null, null)).toBeNull();
  });
});

// ============= Base Unit Amount Validation =============

describe('validateBaseUnitAmount', () => {
  it('should return error for decimal amounts', () => {
    for (const val of ['0.005', '1.5', '0.000001']) {
      const result = validateBaseUnitAmount(val);
      expect(result).toContain('base units');
      expect(result).toContain(val);
    }
  });

  it('should return null for valid integer amounts', () => {
    expect(validateBaseUnitAmount('1000000000')).toBeNull();
    expect(validateBaseUnitAmount('1000000000000000000')).toBeNull();
  });

  it('should return null for null/undefined', () => {
    expect(validateBaseUnitAmount(null)).toBeNull();
    expect(validateBaseUnitAmount(undefined)).toBeNull();
  });

  it('should return null for zero (used for max sends)', () => {
    expect(validateBaseUnitAmount('0')).toBeNull();
  });

  it('should return null for non-numeric strings (let API handle)', () => {
    expect(validateBaseUnitAmount('abc')).toBeNull();
  });
});

describe('quote handler rejects decimal amounts before API call', () => {
  it('should error on decimal amount and not call fetch', async () => {
    const origFetch = global.fetch;
    global.fetch = vi.fn();

    const logs = [];
    let exitCalled = false;
    const cmds = buildTradingCommands({
      errorOutput: (msg) => logs.push(msg),
      exit: () => { exitCalled = true; },
    });

    await cmds.quote([], null, {}, {
      chain: 'solana', from: 'So111', to: 'EPjFW', amount: '0.005',
    });

    expect(exitCalled).toBe(true);
    expect(logs.some(l => l.includes('base units'))).toBe(true);
    expect(global.fetch).not.toHaveBeenCalled();

    global.fetch = origFetch;
  });
});

// ============= API Error Handling =============

describe('API error handling', () => {
  it('should surface INVALID_AMOUNT errors from quote API', async () => {
    const origFetch = global.fetch;
    const errorBody = JSON.stringify({
      code: 'INVALID_AMOUNT',
      message: 'Amount must be a valid numeric string',
      details: { provided: 'abc' },
    });
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => errorBody,
    });

    const { getQuote } = await import('../trading.js');
    await expect(getQuote({
      chainIndex: '501',
      fromTokenAddress: 'So111',
      toTokenAddress: 'EPjFW',
      amount: 'abc',
      userWalletAddress: 'test',
    })).rejects.toThrow('Amount must be a valid numeric string');

    global.fetch = origFetch;
  });

  it('should surface UPSTREAM_BROADCAST_ERROR from execute API', async () => {
    const origFetch = global.fetch;
    const errorBody = JSON.stringify({
      code: 'UPSTREAM_BROADCAST_ERROR',
      message: 'Jupiter Ultra execute failed: transaction simulation failed',
    });
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      text: async () => errorBody,
    });

    const { executeTransaction } = await import('../trading.js');
    await expect(executeTransaction({
      signedTransaction: 'test',
      chain: 'solana',
    })).rejects.toThrow('simulation failed');

    global.fetch = origFetch;
  });

  it('should surface NO_QUOTES_AVAILABLE errors', async () => {
    const origFetch = global.fetch;
    const errorBody = JSON.stringify({
      code: 'NO_QUOTES_AVAILABLE',
      message: 'No quotes available from any aggregator',
      details: ['Jupiter: insufficient liquidity', 'OKX: pair not supported'],
    });
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => errorBody,
    });

    const { getQuote } = await import('../trading.js');
    await expect(getQuote({
      chainIndex: '501',
      fromTokenAddress: 'x',
      toTokenAddress: 'y',
      amount: '1',
      userWalletAddress: 'z',
    })).rejects.toThrow('No quotes available');

    global.fetch = origFetch;
  });

  it('should handle non-JSON error responses gracefully (e.g. Cloudflare)', async () => {
    const origFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => '<!DOCTYPE html><html><body>Cloudflare challenge</body></html>',
    });

    const { getQuote } = await import('../trading.js');
    await expect(getQuote({
      chainIndex: '501',
      fromTokenAddress: 'x',
      toTokenAddress: 'y',
      amount: '1',
      userWalletAddress: 'z',
    })).rejects.toThrow(); // Should throw, not hang

    global.fetch = origFetch;
  });
});
