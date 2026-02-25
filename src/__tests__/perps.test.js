/**
 * Tests for perps module — Hyperliquid perpetuals trading.
 *
 * Covers: msgpack encoding, signing helpers, read commands (with mocked fetch),
 * write command validation, and CLI command builder.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  msgpackEncode,
  floatToWire,
  floatToWirePrice,
  computeActionHash,
  buildPhantomAgentHash,
  signL1Action,
  deriveEvmAddress,
  cmdStatus,
  cmdBalance,
  cmdPrice,
  cmdFunding,
  cmdOrderbook,
  cmdSearch,
  buildPerpsCommands,
} from '../perps.js';
import { generateEvmWallet } from '../wallet.js';

// ============= Test Setup =============

let originalHome;
let tempDir;
let originalEnv;

beforeEach(() => {
  originalHome = process.env.HOME;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nansen-perps-test-'));
  process.env.HOME = tempDir;

  // Save env vars we'll modify
  originalEnv = {
    HL_SECRET_KEY: process.env.HL_SECRET_KEY,
    HL_ACCOUNT_ADDRESS: process.env.HL_ACCOUNT_ADDRESS,
    HL_TESTNET: process.env.HL_TESTNET,
    NANSEN_WALLET_PASSWORD: process.env.NANSEN_WALLET_PASSWORD,
  };
  delete process.env.HL_SECRET_KEY;
  delete process.env.HL_ACCOUNT_ADDRESS;
  delete process.env.HL_TESTNET;
  delete process.env.NANSEN_WALLET_PASSWORD;
});

afterEach(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tempDir, { recursive: true, force: true });

  // Restore env vars
  for (const [k, v] of Object.entries(originalEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// ============= MsgPack Encoding =============

describe('msgpackEncode', () => {
  it('should encode nil', () => {
    expect(msgpackEncode(null)).toEqual(Buffer.from([0xc0]));
    expect(msgpackEncode(undefined)).toEqual(Buffer.from([0xc0]));
  });

  it('should encode booleans', () => {
    expect(msgpackEncode(true)).toEqual(Buffer.from([0xc3]));
    expect(msgpackEncode(false)).toEqual(Buffer.from([0xc2]));
  });

  it('should encode positive fixint (0-127)', () => {
    expect(msgpackEncode(0)).toEqual(Buffer.from([0x00]));
    expect(msgpackEncode(127)).toEqual(Buffer.from([0x7f]));
    expect(msgpackEncode(1)).toEqual(Buffer.from([0x01]));
  });

  it('should encode uint8 (128-255)', () => {
    expect(msgpackEncode(128)[0]).toBe(0xcc);
    expect(msgpackEncode(255)[0]).toBe(0xcc);
    expect(msgpackEncode(255)[1]).toBe(255);
  });

  it('should encode uint16', () => {
    expect(msgpackEncode(256)[0]).toBe(0xcd);
  });

  it('should encode uint32', () => {
    expect(msgpackEncode(65536)[0]).toBe(0xce);
  });

  it('should encode negative fixint (-32 to -1)', () => {
    expect(msgpackEncode(-1)).toEqual(Buffer.from([0xff]));
    expect(msgpackEncode(-32)).toEqual(Buffer.from([0xe0]));
  });

  it('should encode int8', () => {
    expect(msgpackEncode(-128)[0]).toBe(0xd0);
  });

  it('should encode floats as double (64-bit)', () => {
    const encoded = msgpackEncode(3.14);
    expect(encoded[0]).toBe(0xcb);
    expect(encoded.length).toBe(9);
    expect(encoded.readDoubleBE(1)).toBeCloseTo(3.14);
  });

  it('should encode short strings (fixstr)', () => {
    const encoded = msgpackEncode('abc');
    expect(encoded[0]).toBe(0xa0 | 3);
    expect(encoded.subarray(1).toString()).toBe('abc');
  });

  it('should encode empty string', () => {
    expect(msgpackEncode('')).toEqual(Buffer.from([0xa0]));
  });

  it('should encode longer strings (str8)', () => {
    const s = 'a'.repeat(32);
    const encoded = msgpackEncode(s);
    expect(encoded[0]).toBe(0xd9);
    expect(encoded[1]).toBe(32);
  });

  it('should encode empty array', () => {
    expect(msgpackEncode([])).toEqual(Buffer.from([0x90]));
  });

  it('should encode fixarray (1-15 items)', () => {
    const encoded = msgpackEncode([1, 2, 3]);
    expect(encoded[0]).toBe(0x90 | 3);
  });

  it('should encode array16 (16+ items)', () => {
    const arr = new Array(16).fill(0);
    expect(msgpackEncode(arr)[0]).toBe(0xdc);
  });

  it('should encode empty map', () => {
    expect(msgpackEncode({})).toEqual(Buffer.from([0x80]));
  });

  it('should encode fixmap', () => {
    const encoded = msgpackEncode({ a: 1 });
    expect(encoded[0]).toBe(0x80 | 1);
  });

  it('should sort map keys deterministically', () => {
    const enc1 = msgpackEncode({ b: 2, a: 1 });
    const enc2 = msgpackEncode({ a: 1, b: 2 });
    expect(enc1).toEqual(enc2);
  });

  it('should encode a realistic Hyperliquid order action', () => {
    const action = {
      type: 'order',
      orders: [{ a: 0, b: true, p: '95000', s: '0.001', r: false, t: { limit: { tif: 'Ioc' } } }],
      grouping: 'na',
    };
    const encoded = msgpackEncode(action);
    expect(encoded).toBeInstanceOf(Buffer);
    expect(encoded.length).toBeGreaterThan(0);
  });

  it('should throw for unsupported types', () => {
    // Symbol is not supported
    expect(() => msgpackEncode(Symbol('test'))).toThrow('unsupported type');
  });
});

// ============= Wire Format Helpers =============

describe('floatToWire', () => {
  it('should format integer floats without decimal', () => {
    expect(floatToWire(100)).toBe('100');
    expect(floatToWire(0)).toBe('0');
  });

  it('should strip trailing zeros', () => {
    expect(floatToWire(1.5)).toBe('1.5');
    expect(floatToWire(0.001)).toBe('0.001');
    expect(floatToWire(1.10000000)).toBe('1.1');
  });

  it('should handle negative zero', () => {
    expect(floatToWire(-0)).toBe('0');
  });
});

describe('floatToWirePrice', () => {
  it('should round to 5 significant figures', () => {
    // 95123.456789 → 5 sig figs → 95123
    expect(floatToWirePrice(95123.456789)).toBe('95123');
    // 0.001234567 → 5 sig figs → 0.0012346
    expect(floatToWirePrice(0.001234567)).toBe('0.0012346');
    // 1.23456789 → 5 sig figs → 1.2346
    expect(floatToWirePrice(1.23456789)).toBe('1.2346');
  });

  it('should handle zero', () => {
    expect(floatToWirePrice(0)).toBe('0');
  });

  it('should handle large prices', () => {
    expect(floatToWirePrice(100000)).toBe('100000');
    expect(floatToWirePrice(99999.9)).toBe('100000');
  });
});

// ============= Action Hash =============

describe('computeActionHash', () => {
  it('should return a 32-byte buffer', () => {
    const action = { type: 'order', orders: [], grouping: 'na' };
    const hash = computeActionHash(action, null, 1234567890);
    expect(hash).toBeInstanceOf(Buffer);
    expect(hash.length).toBe(32);
  });

  it('should produce different hashes for different nonces', () => {
    const action = { type: 'order', orders: [], grouping: 'na' };
    const h1 = computeActionHash(action, null, 1000);
    const h2 = computeActionHash(action, null, 2000);
    expect(h1.toString('hex')).not.toBe(h2.toString('hex'));
  });

  it('should include vault address when provided', () => {
    const action = { type: 'order', orders: [], grouping: 'na' };
    const vaultAddr = '0x' + '12'.repeat(20);
    const h1 = computeActionHash(action, null, 1000);
    const h2 = computeActionHash(action, vaultAddr, 1000);
    expect(h1.toString('hex')).not.toBe(h2.toString('hex'));
  });

  it('should be deterministic', () => {
    const action = { type: 'cancel', cancels: [{ a: 0, o: 12345 }] };
    const h1 = computeActionHash(action, null, 9999);
    const h2 = computeActionHash(action, null, 9999);
    expect(h1.toString('hex')).toBe(h2.toString('hex'));
  });
});

// ============= Phantom Agent Hash =============

describe('buildPhantomAgentHash', () => {
  it('should return a 32-byte buffer', () => {
    const actionHash = Buffer.alloc(32, 0xab);
    const hash = buildPhantomAgentHash(actionHash, true);
    expect(hash).toBeInstanceOf(Buffer);
    expect(hash.length).toBe(32);
  });

  it('should differ for mainnet vs testnet', () => {
    const actionHash = Buffer.alloc(32, 0x42);
    const mainnetHash = buildPhantomAgentHash(actionHash, true);
    const testnetHash = buildPhantomAgentHash(actionHash, false);
    expect(mainnetHash.toString('hex')).not.toBe(testnetHash.toString('hex'));
  });

  it('should be deterministic', () => {
    const actionHash = Buffer.alloc(32, 0x77);
    const h1 = buildPhantomAgentHash(actionHash, true);
    const h2 = buildPhantomAgentHash(actionHash, true);
    expect(h1.toString('hex')).toBe(h2.toString('hex'));
  });
});

// ============= signL1Action =============

describe('signL1Action', () => {
  it('should produce a valid signature with r/s/v', () => {
    const wallet = generateEvmWallet();
    const action = { type: 'order', orders: [], grouping: 'na' };
    const sig = signL1Action(action, wallet.privateKey, null, Date.now(), true);

    expect(sig.r).toMatch(/^0x[0-9a-f]{64}$/);
    expect(sig.s).toMatch(/^0x[0-9a-f]{64}$/);
    expect([27, 28]).toContain(sig.v);
  });

  it('should produce deterministic signatures (RFC 6979)', () => {
    const wallet = generateEvmWallet();
    const action = { type: 'cancel', cancels: [{ a: 1, o: 42 }] };
    const nonce = 1234567890;
    const sig1 = signL1Action(action, wallet.privateKey, null, nonce, true);
    const sig2 = signL1Action(action, wallet.privateKey, null, nonce, true);

    expect(sig1.r).toBe(sig2.r);
    expect(sig1.s).toBe(sig2.s);
    expect(sig1.v).toBe(sig2.v);
  });

  it('should produce different signatures for mainnet vs testnet', () => {
    const wallet = generateEvmWallet();
    const action = { type: 'order', orders: [], grouping: 'na' };
    const nonce = 999;
    const mainSig = signL1Action(action, wallet.privateKey, null, nonce, true);
    const testSig = signL1Action(action, wallet.privateKey, null, nonce, false);

    expect(mainSig.r).not.toBe(testSig.r);
  });

  it('should accept 0x-prefixed private key', () => {
    const wallet = generateEvmWallet();
    const action = { type: 'order', orders: [], grouping: 'na' };
    const sig = signL1Action(action, '0x' + wallet.privateKey, null, 123, true);
    expect(sig.r).toMatch(/^0x/);
  });
});

// ============= deriveEvmAddress =============

describe('deriveEvmAddress', () => {
  it('should derive address from private key', () => {
    const wallet = generateEvmWallet();
    const derived = deriveEvmAddress(wallet.privateKey);
    expect(derived.toLowerCase()).toBe(wallet.address.toLowerCase());
  });

  it('should handle 0x-prefixed keys', () => {
    const wallet = generateEvmWallet();
    const derived = deriveEvmAddress('0x' + wallet.privateKey);
    expect(derived.toLowerCase()).toBe(wallet.address.toLowerCase());
  });

  it('should return lowercase hex address with 0x prefix', () => {
    const wallet = generateEvmWallet();
    const derived = deriveEvmAddress(wallet.privateKey);
    expect(derived).toMatch(/^0x[0-9a-f]{40}$/);
  });
});

// ============= Read Commands (mocked fetch) =============

describe('cmdPrice', () => {
  it('should return price for a symbol', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ BTC: '95000.5', ETH: '3200.0' }),
    });

    const result = await cmdPrice({ symbol: 'BTC' });
    expect(result.symbol).toBe('BTC');
    expect(result.price).toBe(95000.5);
  });

  it('should throw when symbol not found', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ BTC: '95000' }),
    });

    await expect(cmdPrice({ symbol: 'NONEXISTENT' })).rejects.toThrow('No price found');
  });

  it('should throw when --symbol missing', async () => {
    await expect(cmdPrice({})).rejects.toThrow('--symbol is required');
  });
});

describe('cmdFunding', () => {
  it('should return funding data for a symbol', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { universe: [{ name: 'BTC', szDecimals: 5 }, { name: 'ETH', szDecimals: 4 }] },
        [
          { funding: '0.0001', openInterest: '1234.5', markPx: '95000', dayNtlVlm: '100000000' },
          { funding: '-0.00005', openInterest: '5000', markPx: '3200', dayNtlVlm: '50000000' },
        ],
      ],
    });

    const result = await cmdFunding({ symbol: 'BTC' });
    expect(result.symbol).toBe('BTC');
    expect(result.fundingRate).toBe(0.0001);
    expect(result.openInterest).toBe(1234.5);
    expect(result.markPrice).toBe(95000);
  });

  it('should throw when symbol not found', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ universe: [{ name: 'BTC' }] }, [{}]],
    });

    await expect(cmdFunding({ symbol: 'PEPE' })).rejects.toThrow('not found');
  });

  it('should throw when --symbol missing', async () => {
    await expect(cmdFunding({})).rejects.toThrow('--symbol is required');
  });
});

describe('cmdOrderbook', () => {
  it('should return L2 book with bids and asks', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        levels: [
          [{ px: '94990', sz: '0.5', n: 3 }, { px: '94980', sz: '1.2', n: 5 }],
          [{ px: '95010', sz: '0.8', n: 2 }, { px: '95020', sz: '2.0', n: 7 }],
        ],
      }),
    });

    const result = await cmdOrderbook({ symbol: 'BTC', depth: '2' });
    expect(result.symbol).toBe('BTC');
    expect(result.bids).toHaveLength(2);
    expect(result.asks).toHaveLength(2);
    expect(result.bids[0].price).toBe(94990);
    expect(result.asks[0].price).toBe(95010);
  });

  it('should respect depth limit', async () => {
    const levels = new Array(20).fill(null).map((_, i) => ({ px: String(94000 - i), sz: '1', n: 1 }));
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ levels: [levels, levels] }),
    });

    const result = await cmdOrderbook({ symbol: 'BTC', depth: '5' });
    expect(result.bids).toHaveLength(5);
    expect(result.asks).toHaveLength(5);
  });

  it('should throw when --symbol missing', async () => {
    await expect(cmdOrderbook({})).rejects.toThrow('--symbol is required');
  });
});

describe('cmdSearch', () => {
  it('should find matching symbols', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        universe: [
          { name: 'BTC', szDecimals: 5 },
          { name: 'PEPE', szDecimals: 0 },
          { name: 'PEPECOIN', szDecimals: 0 },
          { name: 'ETH', szDecimals: 4 },
        ],
      }),
    });

    const result = await cmdSearch({ query: 'pepe' });
    expect(result.results).toHaveLength(2);
    expect(result.results.map(r => r.symbol)).toEqual(['PEPE', 'PEPECOIN']);
    expect(result.count).toBe(2);
  });

  it('should return empty results for no match', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ universe: [{ name: 'BTC' }, { name: 'ETH' }] }),
    });

    const result = await cmdSearch({ query: 'xyz' });
    expect(result.results).toHaveLength(0);
  });

  it('should throw when --query missing', async () => {
    await expect(cmdSearch({})).rejects.toThrow('--query is required');
  });
});

describe('cmdStatus', () => {
  it('should return positions for a given address', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        marginSummary: { accountValue: '10000.5', totalMarginUsed: '500' },
        assetPositions: [
          {
            position: {
              coin: 'BTC',
              szi: '0.1',
              entryPx: '90000',
              unrealizedPnl: '500',
              returnOnEquity: '0.05',
              leverage: { type: 'cross', value: '10' },
              liquidationPx: '80000',
              marginUsed: '100',
            },
          },
          {
            position: { coin: 'ETH', szi: '0', entryPx: '3000', unrealizedPnl: '0', marginUsed: '0' },
          },
        ],
      }),
    });

    const result = await cmdStatus({ address: '0x' + '12'.repeat(20) });
    expect(result.equity).toBe(10000.5);
    expect(result.positions).toHaveLength(1); // ETH filtered (szi=0)
    expect(result.positions[0].symbol).toBe('BTC');
    expect(result.positions[0].side).toBe('long');
    expect(result.positionCount).toBe(1);
  });

  it('should use HL_ACCOUNT_ADDRESS env if no --address', async () => {
    process.env.HL_ACCOUNT_ADDRESS = '0x' + 'ab'.repeat(20);
    let capturedBody;
    global.fetch = vi.fn().mockImplementation(async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        json: async () => ({ marginSummary: {}, assetPositions: [] }),
      };
    });

    await cmdStatus({});
    expect(capturedBody.user).toBe('0x' + 'ab'.repeat(20));
  });

  it('should throw when no address available', async () => {
    await expect(cmdStatus({})).rejects.toThrow(/address|wallet/i);
  });
});

describe('cmdBalance', () => {
  it('should return equity and margin summary', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        marginSummary: {
          accountValue: '5000',
          totalNtlPos: '1000',
          totalRawUsd: '4500',
          totalMarginUsed: '200',
        },
        assetPositions: [],
      }),
    });

    const result = await cmdBalance({ address: '0x' + '11'.repeat(20) });
    expect(result.equity).toBe(5000);
    expect(result.totalMarginUsed).toBe(200);
  });
});

// ============= CLI Builder =============

describe('buildPerpsCommands', () => {
  it('should return a handler for perps command', () => {
    const cmds = buildPerpsCommands();
    expect(typeof cmds.perps).toBe('function');
  });

  it('should return help for unknown subcommand', async () => {
    const cmds = buildPerpsCommands();
    const result = await cmds.perps(['unknown-sub'], null, {}, {});
    expect(result.error).toMatch(/Unknown subcommand/);
    expect(result.available).toContain('status');
  });

  it('should return help info for help subcommand', async () => {
    const cmds = buildPerpsCommands();
    const result = await cmds.perps(['help'], null, {}, {});
    expect(Array.isArray(result.commands)).toBe(true);
    expect(result.commands).toContain('open');
    expect(result.commands).toContain('close');
    expect(result.commands).toContain('price');
  });

  it('should require credentials for write commands', async () => {
    const cmds = buildPerpsCommands();
    // No HL_SECRET_KEY or NANSEN_WALLET_PASSWORD set
    await expect(cmds.perps(['open'], null, {}, { symbol: 'BTC', side: 'long', size: '0.001' }))
      .rejects.toThrow(/credentials|HL_SECRET_KEY/i);
  });

  it('should throw for missing --symbol on price', async () => {
    const cmds = buildPerpsCommands();
    await expect(cmds.perps(['price'], null, {}, {})).rejects.toThrow('--symbol is required');
  });

  it('should throw for missing --query on search', async () => {
    const cmds = buildPerpsCommands();
    await expect(cmds.perps(['search'], null, {}, {})).rejects.toThrow('--query is required');
  });

  it('should call price handler with mocked fetch', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ BTC: '95000', ETH: '3200' }),
    });

    const cmds = buildPerpsCommands();
    const result = await cmds.perps(['price'], null, {}, { symbol: 'ETH' });
    expect(result.symbol).toBe('ETH');
    expect(result.price).toBe(3200);
  });

  it('should handle API errors gracefully', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    });

    const cmds = buildPerpsCommands();
    await expect(cmds.perps(['price'], null, {}, { symbol: 'BTC' }))
      .rejects.toThrow(/Hyperliquid info API error/);
  });
});

// ============= Write Command Validation =============

describe('open command validation', () => {
  it('should throw for missing --symbol', async () => {
    process.env.HL_SECRET_KEY = '0x' + 'a'.repeat(64);
    const cmds = buildPerpsCommands();
    await expect(cmds.perps(['open'], null, {}, { side: 'long', size: '0.001' }))
      .rejects.toThrow('--symbol is required');
  });

  it('should throw for invalid --side', async () => {
    process.env.HL_SECRET_KEY = '0x' + 'a'.repeat(64);
    const cmds = buildPerpsCommands();
    await expect(cmds.perps(['open'], null, {}, { symbol: 'BTC', side: 'up', size: '0.001' }))
      .rejects.toThrow('--side must be "long" or "short"');
  });

  it('should throw for missing --size', async () => {
    process.env.HL_SECRET_KEY = '0x' + 'a'.repeat(64);
    const cmds = buildPerpsCommands();
    await expect(cmds.perps(['open'], null, {}, { symbol: 'BTC', side: 'long' }))
      .rejects.toThrow('--size is required');
  });

  it('should throw for invalid --size (zero)', async () => {
    process.env.HL_SECRET_KEY = '0x' + 'a'.repeat(64);

    // Mock meta and mids calls
    global.fetch = vi.fn().mockImplementation(async (url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.type === 'meta') {
        return { ok: true, json: async () => ({ universe: [{ name: 'BTC', szDecimals: 5 }] }) };
      }
      return { ok: true, json: async () => ({}) };
    });

    const cmds = buildPerpsCommands();
    await expect(cmds.perps(['open'], null, {}, { symbol: 'BTC', side: 'long', size: '0' }))
      .rejects.toThrow('positive number');
  });
});

describe('close command validation', () => {
  it('should throw for missing --symbol', async () => {
    process.env.HL_SECRET_KEY = '0x' + 'a'.repeat(64);
    const cmds = buildPerpsCommands();
    await expect(cmds.perps(['close'], null, {}, {})).rejects.toThrow('--symbol is required');
  });

  it('should throw when no position found', async () => {
    const wallet = generateEvmWallet();
    process.env.HL_SECRET_KEY = wallet.privateKey;

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ marginSummary: {}, assetPositions: [] }),
    });

    const cmds = buildPerpsCommands();
    await expect(cmds.perps(['close'], null, {}, { symbol: 'BTC' }))
      .rejects.toThrow('No open position');
  });
});

describe('cancel command validation', () => {
  it('should throw for missing --symbol', async () => {
    process.env.HL_SECRET_KEY = '0x' + 'a'.repeat(64);
    const cmds = buildPerpsCommands();
    await expect(cmds.perps(['cancel'], null, {}, {})).rejects.toThrow('--symbol is required');
  });

  it('should return 0 cancelled when no orders', async () => {
    const wallet = generateEvmWallet();
    process.env.HL_SECRET_KEY = wallet.privateKey;

    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(async (url, opts) => {
      const body = JSON.parse(opts.body);
      callCount++;
      if (body.type === 'meta') {
        return { ok: true, json: async () => ({ universe: [{ name: 'BTC', szDecimals: 5 }] }) };
      }
      if (body.type === 'openOrders') {
        return { ok: true, json: async () => [] };
      }
      return { ok: true, json: async () => ({}) };
    });

    const cmds = buildPerpsCommands();
    const result = await cmds.perps(['cancel'], null, {}, { symbol: 'BTC' });
    expect(result.cancelled).toBe(0);
    expect(result.message).toMatch(/No open orders/);
  });
});
