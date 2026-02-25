/**
 * Nansen CLI - Hyperliquid Perpetuals Trading
 * Open/close positions, manage SL/TP, query prices and orderbook.
 * Zero external dependencies — uses Node.js built-in crypto only.
 */

import crypto from 'crypto';
import { keccak256, signSecp256k1 } from './crypto.js';
import { exportWallet, getDefaultAddress, listWallets } from './wallet.js';

// ============= Constants =============

const HL_INFO_URL = process.env.HL_INFO_URL || 'https://api.hyperliquid.xyz/info';
const HL_EXCHANGE_URL = process.env.HL_EXCHANGE_URL || 'https://api.hyperliquid.xyz/exchange';

// ============= Minimal MsgPack Encoder =============
// Hyperliquid uses msgpack to serialize actions before hashing.
// We implement only the subset needed: nil, bool, int, float, string, array, map.
// Follows the MessagePack spec: https://msgpack.org/index.html

export function msgpackEncode(value) {
  if (value === null || value === undefined) {
    return Buffer.from([0xc0]); // nil
  }
  if (typeof value === 'boolean') {
    return Buffer.from([value ? 0xc3 : 0xc2]);
  }
  if (typeof value === 'number') {
    if (Number.isInteger(value)) {
      return msgpackEncodeInt(value);
    }
    // 64-bit float (double)
    const buf = Buffer.allocUnsafe(9);
    buf[0] = 0xcb;
    buf.writeDoubleBE(value, 1);
    return buf;
  }
  if (typeof value === 'bigint') {
    return msgpackEncodeInt(Number(value));
  }
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8');
    const len = bytes.length;
    if (len <= 31) {
      return Buffer.concat([Buffer.from([0xa0 | len]), bytes]);
    }
    if (len <= 0xff) {
      return Buffer.concat([Buffer.from([0xd9, len]), bytes]);
    }
    if (len <= 0xffff) {
      const h = Buffer.allocUnsafe(3);
      h[0] = 0xda; h.writeUInt16BE(len, 1);
      return Buffer.concat([h, bytes]);
    }
    const h = Buffer.allocUnsafe(5);
    h[0] = 0xdb; h.writeUInt32BE(len, 1);
    return Buffer.concat([h, bytes]);
  }
  if (Array.isArray(value)) {
    const items = value.map(msgpackEncode);
    const len = value.length;
    let header;
    if (len <= 15) {
      header = Buffer.from([0x90 | len]);
    } else if (len <= 0xffff) {
      header = Buffer.allocUnsafe(3);
      header[0] = 0xdc; header.writeUInt16BE(len, 1);
    } else {
      header = Buffer.allocUnsafe(5);
      header[0] = 0xdd; header.writeUInt32BE(len, 1);
    }
    return Buffer.concat([header, ...items]);
  }
  if (typeof value === 'object') {
    // Sort keys for deterministic encoding (matches Hyperliquid SDK behavior)
    const keys = Object.keys(value).sort();
    const len = keys.length;
    let header;
    if (len <= 15) {
      header = Buffer.from([0x80 | len]);
    } else if (len <= 0xffff) {
      header = Buffer.allocUnsafe(3);
      header[0] = 0xde; header.writeUInt16BE(len, 1);
    } else {
      header = Buffer.allocUnsafe(5);
      header[0] = 0xdf; header.writeUInt32BE(len, 1);
    }
    const parts = [header];
    for (const k of keys) {
      parts.push(msgpackEncode(k));
      parts.push(msgpackEncode(value[k]));
    }
    return Buffer.concat(parts);
  }
  throw new Error(`msgpackEncode: unsupported type ${typeof value}`);
}

function msgpackEncodeInt(n) {
  if (n >= 0) {
    if (n <= 127) return Buffer.from([n]);
    if (n <= 0xff) return Buffer.from([0xcc, n]);
    if (n <= 0xffff) { const b = Buffer.allocUnsafe(3); b[0] = 0xcd; b.writeUInt16BE(n, 1); return b; }
    if (n <= 0xffffffff) { const b = Buffer.allocUnsafe(5); b[0] = 0xce; b.writeUInt32BE(n, 1); return b; }
    const b = Buffer.allocUnsafe(9); b[0] = 0xcf; b.writeBigUInt64BE(BigInt(n), 1); return b;
  } else {
    if (n >= -32) return Buffer.from([n & 0xff]);
    if (n >= -128) return Buffer.from([0xd0, n & 0xff]);
    if (n >= -32768) { const b = Buffer.allocUnsafe(3); b[0] = 0xd1; b.writeInt16BE(n, 1); return b; }
    if (n >= -2147483648) { const b = Buffer.allocUnsafe(5); b[0] = 0xd2; b.writeInt32BE(n, 1); return b; }
    const b = Buffer.allocUnsafe(9); b[0] = 0xd3; b.writeBigInt64BE(BigInt(n), 1); return b;
  }
}

// ============= Hyperliquid Signing =============

/**
 * Convert a float to Hyperliquid's wire format (normalized decimal string).
 * e.g. 1.5 → "1.5", 0.001 → "0.001", 100.0 → "100"
 */
export function floatToWire(x) {
  let s = x.toFixed(8);
  // Strip trailing zeros after decimal
  s = s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  if (s === '-0') s = '0';
  return s;
}

/**
 * Round a price to Hyperliquid's 5 significant figures wire format.
 */
export function floatToWirePrice(x) {
  if (x === 0) return '0';
  const sigFigs = 5;
  const mag = Math.floor(Math.log10(Math.abs(x)));
  const factor = Math.pow(10, sigFigs - 1 - mag);
  const rounded = Math.round(x * factor) / factor;
  return floatToWire(rounded);
}

/**
 * Compute the Hyperliquid action hash.
 * hash = keccak256(msgpack(action) || nonce_8bytes_bigendian || vault_flag [|| vault_20bytes])
 */
export function computeActionHash(action, vaultAddress, nonce) {
  const packed = msgpackEncode(action);
  const nonceBuf = Buffer.allocUnsafe(8);
  nonceBuf.writeBigUInt64BE(BigInt(nonce));

  let vaultBuf;
  if (vaultAddress == null) {
    vaultBuf = Buffer.from([0x00]);
  } else {
    const addrBytes = Buffer.from(vaultAddress.replace(/^0x/, ''), 'hex');
    vaultBuf = Buffer.concat([Buffer.from([0x01]), addrBytes]);
  }

  return keccak256(Buffer.concat([packed, nonceBuf, vaultBuf]));
}

/**
 * Build the EIP-712 domain separator for Hyperliquid (chainId=1337, zero verifyingContract).
 */
function buildDomainSeparator() {
  const typeHash = keccak256(Buffer.from(
    'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'
  ));
  const nameHash = keccak256(Buffer.from('Exchange'));
  const versionHash = keccak256(Buffer.from('1'));
  const chainId = Buffer.alloc(32);
  // chainId = 1337 — write as big-endian uint256
  const chainIdBuf = Buffer.allocUnsafe(8);
  chainIdBuf.writeBigUInt64BE(1337n);
  chainId.set(chainIdBuf, 24);
  const verifyingContract = Buffer.alloc(32); // zero address

  return keccak256(Buffer.concat([typeHash, nameHash, versionHash, chainId, verifyingContract]));
}

const DOMAIN_SEPARATOR = buildDomainSeparator();

/**
 * Build the EIP-712 typed data hash for a phantom agent.
 * Agent(string source, bytes32 connectionId)
 * The "connectionId" is the action hash.
 */
export function buildPhantomAgentHash(actionHash, isMainnet) {
  const source = isMainnet ? 'a' : 'b';
  const agentTypeHash = keccak256(Buffer.from('Agent(string source,bytes32 connectionId)'));
  const sourceHash = keccak256(Buffer.from(source, 'utf8'));
  // actionHash is already 32 bytes (bytes32)
  const structHash = keccak256(Buffer.concat([agentTypeHash, sourceHash, actionHash]));

  return keccak256(Buffer.concat([
    Buffer.from([0x19, 0x01]), // EIP-712 prefix
    DOMAIN_SEPARATOR,
    structHash,
  ]));
}

/**
 * Sign a Hyperliquid L1 action.
 * Returns { r: "0x...", s: "0x...", v: N } where v is 27 or 28.
 */
export function signL1Action(action, privateKeyHex, vaultAddress, nonce, isMainnet) {
  const actionHash = computeActionHash(action, vaultAddress, nonce);
  const phantomHash = buildPhantomAgentHash(actionHash, isMainnet);
  const privateKey = Buffer.from(privateKeyHex.replace(/^0x/, ''), 'hex');
  const { r, s, v } = signSecp256k1(phantomHash, privateKey);
  return {
    r: '0x' + r.toString('hex'),
    s: '0x' + s.toString('hex'),
    v: 27 + v, // Ethereum v convention (27 or 28)
  };
}

/**
 * Derive EVM address from a private key hex string.
 */
export function deriveEvmAddress(privateKeyHex) {
  const key = Buffer.from(privateKeyHex.replace(/^0x/, ''), 'hex');
  const ecdh = crypto.createECDH('secp256k1');
  ecdh.setPrivateKey(key);
  const pubKey = ecdh.getPublicKey(null, 'uncompressed');
  const hash = keccak256(pubKey.subarray(1));
  return '0x' + hash.subarray(12).toString('hex');
}

// ============= HTTP Helpers =============

async function hlInfo(body) {
  const res = await fetch(HL_INFO_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Hyperliquid info API error (${res.status}): ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function hlExchange(action, privateKeyHex, vaultAddress, isMainnet) {
  const nonce = Date.now();
  const signature = signL1Action(action, privateKeyHex, vaultAddress, nonce, isMainnet);
  const body = { action, nonce, signature };
  if (vaultAddress) body.vaultAddress = vaultAddress;

  const res = await fetch(HL_EXCHANGE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Hyperliquid exchange API error (${res.status}): ${text.slice(0, 300)}`);
  }
  return res.json();
}

// ============= Market Data Helpers =============

async function getMeta() {
  return hlInfo({ type: 'meta' });
}

async function getMetaAndCtxs() {
  const result = await hlInfo({ type: 'metaAndAssetCtxs' });
  // Returns [meta, contexts]
  if (Array.isArray(result)) return result;
  return [result, []];
}

/**
 * Get the asset index for a coin symbol from meta.universe.
 */
async function getAssetIndex(symbol, meta) {
  const m = meta || await getMeta();
  const universe = m.universe || [];
  const idx = universe.findIndex(a => a.name === symbol.toUpperCase());
  if (idx === -1) {
    throw new Error(`Symbol "${symbol.toUpperCase()}" not found on Hyperliquid. Use 'perps search --query ${symbol}' to find it.`);
  }
  return idx;
}

// ============= Position Parsing =============

function parsePosition(pos) {
  if (!pos || !pos.position) return null;
  const p = pos.position;
  const szi = parseFloat(p.szi || '0');
  if (szi === 0) return null;
  return {
    symbol: p.coin,
    side: szi > 0 ? 'long' : 'short',
    size: Math.abs(szi),
    entryPrice: parseFloat(p.entryPx || '0'),
    unrealizedPnl: parseFloat(p.unrealizedPnl || '0'),
    returnOnEquity: parseFloat(p.returnOnEquity || '0'),
    leverage: p.leverage ? { type: p.leverage.type, value: parseFloat(p.leverage.value || '0') } : null,
    liquidationPrice: p.liquidationPx ? parseFloat(p.liquidationPx) : null,
    marginUsed: parseFloat(p.marginUsed || '0'),
  };
}

function parseOrderResult(result, symbol, side, size) {
  if (!result) return { symbol, side, size, status: 'unknown' };
  const status = (result.status || '').toLowerCase();
  if (status === 'ok') {
    const data = result.response?.data || {};
    const statuses = data.statuses || [];
    const fills = statuses
      .filter(s => s.filled)
      .map(s => ({
        orderId: s.filled?.oid,
        totalSz: parseFloat(s.filled?.totalSz || '0'),
        avgPx: parseFloat(s.filled?.avgPx || '0'),
      }));
    const resting = statuses.filter(s => s.resting).map(s => ({ orderId: s.resting?.oid }));
    return { symbol, side, requestedSize: size, status: 'ok', fills, resting };
  }
  return { symbol, side, requestedSize: size, status, error: result.response };
}

// ============= Credential Helpers =============

/**
 * Get signing credentials.
 * Priority: HL_SECRET_KEY env > wallet system.
 */
async function getCredentials(walletName) {
  const isMainnet = !process.env.HL_TESTNET;

  if (process.env.HL_SECRET_KEY) {
    const key = process.env.HL_SECRET_KEY.replace(/^0x/, '');
    if (key.length !== 64) throw new Error('HL_SECRET_KEY must be a 32-byte (64 hex char) private key');
    const accountAddress = process.env.HL_ACCOUNT_ADDRESS || null;
    return { privateKey: key, accountAddress, isMainnet };
  }

  const password = process.env.NANSEN_WALLET_PASSWORD;
  if (!password) {
    throw new Error(
      'No credentials found. Set HL_SECRET_KEY env var, ' +
      'or set NANSEN_WALLET_PASSWORD and optionally --wallet <name>.'
    );
  }

  let effectiveName = walletName;
  if (!effectiveName) {
    const list = listWallets();
    effectiveName = list.defaultWallet;
  }
  if (!effectiveName) {
    throw new Error('No wallet found. Create one with: nansen wallet create');
  }

  const exported = exportWallet(effectiveName, password);
  const key = exported.evm.privateKey;
  if (!key) throw new Error('Wallet has no EVM private key');
  return { privateKey: key, accountAddress: null, isMainnet };
}

/**
 * Resolve the user's trading address.
 * Priority: HL_ACCOUNT_ADDRESS env > derive from private key.
 */
async function resolveUserAddress(options, walletName) {
  // Explicit address flag takes priority
  if (options.address) return options.address;
  // HL_ACCOUNT_ADDRESS env for agent wallets
  if (process.env.HL_ACCOUNT_ADDRESS) return process.env.HL_ACCOUNT_ADDRESS;

  // Derive from HL_SECRET_KEY
  if (process.env.HL_SECRET_KEY) {
    const key = process.env.HL_SECRET_KEY.replace(/^0x/, '');
    return deriveEvmAddress(key);
  }

  // Fall back to nansen wallet
  try {
    const { privateKey } = await getCredentials(walletName);
    return deriveEvmAddress(privateKey);
  } catch {
    // Last resort
    try { return getDefaultAddress('evm'); } catch { /* ignore */ }
  }
  throw new Error('Could not determine wallet address. Set HL_ACCOUNT_ADDRESS, HL_SECRET_KEY, or configure a wallet.');
}

// ============= Command Implementations =============

export async function cmdStatus(options, walletName) {
  const address = await resolveUserAddress(options, walletName);
  const state = await hlInfo({ type: 'clearinghouseState', user: address });
  const positions = (state.assetPositions || []).map(parsePosition).filter(Boolean);

  return {
    address,
    equity: parseFloat(state.marginSummary?.accountValue || '0'),
    totalMarginUsed: parseFloat(state.marginSummary?.totalMarginUsed || '0'),
    positions,
    positionCount: positions.length,
  };
}

export async function cmdBalance(options, walletName) {
  const address = await resolveUserAddress(options, walletName);
  const state = await hlInfo({ type: 'clearinghouseState', user: address });
  const summary = state.marginSummary || {};

  return {
    address,
    equity: parseFloat(summary.accountValue || '0'),
    totalNtlPos: parseFloat(summary.totalNtlPos || '0'),
    totalRawUsd: parseFloat(summary.totalRawUsd || '0'),
    totalMarginUsed: parseFloat(summary.totalMarginUsed || '0'),
  };
}

export async function cmdPrice(options) {
  const symbol = (options.symbol || '').toUpperCase();
  if (!symbol) throw new Error('--symbol is required (e.g. --symbol BTC)');

  const mids = await hlInfo({ type: 'allMids' });
  const price = mids[symbol];
  if (price == null) {
    throw new Error(`No price found for "${symbol}". Use 'perps search --query ${symbol}' to verify the symbol.`);
  }
  return { symbol, price: parseFloat(price) };
}

export async function cmdFunding(options) {
  const symbol = (options.symbol || '').toUpperCase();
  if (!symbol) throw new Error('--symbol is required (e.g. --symbol BTC)');

  const [meta, ctxs] = await getMetaAndCtxs();
  const universe = meta.universe || [];
  const idx = universe.findIndex(a => a.name === symbol);
  if (idx === -1) throw new Error(`Symbol "${symbol}" not found on Hyperliquid`);

  const ctx = (ctxs || [])[idx] || {};
  return {
    symbol,
    fundingRate: parseFloat(ctx.funding || '0'),
    openInterest: parseFloat(ctx.openInterest || '0'),
    markPrice: parseFloat(ctx.markPx || '0'),
    dayNtlVlm: parseFloat(ctx.dayNtlVlm || '0'),
    premium: parseFloat(ctx.premium || '0'),
  };
}

export async function cmdOrderbook(options) {
  const symbol = (options.symbol || '').toUpperCase();
  if (!symbol) throw new Error('--symbol is required (e.g. --symbol BTC)');
  const depth = Math.min(parseInt(options.depth || '10', 10), 50);

  const book = await hlInfo({ type: 'l2Book', coin: symbol });
  const levels = book.levels || [[], []];
  const bids = (levels[0] || []).slice(0, depth).map(l => ({
    price: parseFloat(l.px), size: parseFloat(l.sz), orders: l.n,
  }));
  const asks = (levels[1] || []).slice(0, depth).map(l => ({
    price: parseFloat(l.px), size: parseFloat(l.sz), orders: l.n,
  }));

  return { symbol, depth: Math.min(depth, Math.max(bids.length, asks.length)), bids, asks };
}

export async function cmdSearch(options) {
  const query = (options.query || '').toLowerCase();
  if (!query) throw new Error('--query is required (e.g. --query pepe)');

  const meta = await getMeta();
  const universe = meta.universe || [];
  const results = universe
    .filter(a => a.name.toLowerCase().includes(query))
    .map((a, i) => ({ symbol: a.name, assetIndex: i, szDecimals: a.szDecimals }));

  return { query, results, count: results.length };
}

export async function cmdOpen(options, walletName) {
  const symbol = (options.symbol || '').toUpperCase();
  const side = (options.side || '').toLowerCase();
  const sizeStr = options.size;
  const leverage = options.leverage != null ? parseInt(options.leverage, 10) : null;
  const isolated = !!(options.isolated || options.isIsolated);
  const limitPrice = options.price ? parseFloat(options.price) : null;

  if (!symbol) throw new Error('--symbol is required (e.g. --symbol BTC)');
  if (!['long', 'short'].includes(side)) throw new Error('--side must be "long" or "short"');
  if (!sizeStr) throw new Error('--size is required (base asset units, e.g. 0.001 for 0.001 BTC)');

  const size = parseFloat(sizeStr);
  if (isNaN(size) || size <= 0) throw new Error('--size must be a positive number');

  const { privateKey, accountAddress, isMainnet } = await getCredentials(walletName);
  const meta = await getMeta();
  const assetIndex = await getAssetIndex(symbol, meta);

  // Set leverage if specified
  if (leverage !== null && leverage > 0) {
    const leverageAction = {
      type: 'updateLeverage',
      asset: assetIndex,
      isCross: !isolated,
      leverage,
    };
    await hlExchange(leverageAction, privateKey, accountAddress, isMainnet);
  }

  const isBuy = side === 'long';
  let px;

  if (limitPrice) {
    px = floatToWirePrice(limitPrice);
  } else {
    // Market order: use current mid with slippage buffer (3%)
    const mids = await hlInfo({ type: 'allMids' });
    const mid = parseFloat(mids[symbol] || '0');
    if (!mid) throw new Error(`No price found for ${symbol}`);
    const slippage = isBuy ? mid * 1.03 : mid * 0.97;
    px = floatToWirePrice(slippage);
  }

  const orderType = limitPrice
    ? { limit: { tif: 'Gtc' } }   // limit order, resting
    : { limit: { tif: 'Ioc' } };  // "market": IOC at slippage price

  const order = {
    a: assetIndex,
    b: isBuy,
    p: px,
    s: floatToWire(size),
    r: false, // not reduce-only
    t: orderType,
  };

  const action = { type: 'order', orders: [order], grouping: 'na' };
  const result = await hlExchange(action, privateKey, accountAddress, isMainnet);
  return parseOrderResult(result, symbol, side, size);
}

export async function cmdClose(options, walletName) {
  const symbol = (options.symbol || '').toUpperCase();
  if (!symbol) throw new Error('--symbol is required (e.g. --symbol BTC)');

  const { privateKey, accountAddress, isMainnet } = await getCredentials(walletName);
  const address = accountAddress || deriveEvmAddress(privateKey);

  const state = await hlInfo({ type: 'clearinghouseState', user: address });
  const posEntry = (state.assetPositions || []).find(p => p.position?.coin === symbol);
  if (!posEntry) throw new Error(`No open position found for ${symbol}`);

  const currentSzi = parseFloat(posEntry.position?.szi || '0');
  if (currentSzi === 0) throw new Error(`Position for ${symbol} has zero size`);

  const closeSize = options.size ? parseFloat(options.size) : Math.abs(currentSzi);
  const isBuy = currentSzi < 0; // closing a short requires buying

  const meta = await getMeta();
  const assetIndex = await getAssetIndex(symbol, meta);

  const mids = await hlInfo({ type: 'allMids' });
  const mid = parseFloat(mids[symbol] || '0');
  if (!mid) throw new Error(`No price found for ${symbol}`);
  const px = isBuy ? floatToWirePrice(mid * 1.03) : floatToWirePrice(mid * 0.97);

  const order = {
    a: assetIndex,
    b: isBuy,
    p: px,
    s: floatToWire(closeSize),
    r: true, // reduce-only
    t: { limit: { tif: 'Ioc' } },
  };

  const action = { type: 'order', orders: [order], grouping: 'na' };
  const result = await hlExchange(action, privateKey, accountAddress, isMainnet);
  const side = isBuy ? 'close-short' : 'close-long';
  return parseOrderResult(result, symbol, side, closeSize);
}

export async function cmdCloseAll(options, walletName) {
  const { privateKey, accountAddress, isMainnet } = await getCredentials(walletName);
  const address = accountAddress || deriveEvmAddress(privateKey);

  const state = await hlInfo({ type: 'clearinghouseState', user: address });
  const positions = (state.assetPositions || []).map(parsePosition).filter(Boolean);

  if (positions.length === 0) return { closed: 0, message: 'No open positions to close' };

  const meta = await getMeta();
  const mids = await hlInfo({ type: 'allMids' });

  const orders = [];
  for (const pos of positions) {
    const assetIndex = await getAssetIndex(pos.symbol, meta);
    const mid = parseFloat(mids[pos.symbol] || '0');
    if (!mid) continue;
    const isBuy = pos.side === 'short';
    const px = isBuy ? floatToWirePrice(mid * 1.03) : floatToWirePrice(mid * 0.97);
    orders.push({
      a: assetIndex,
      b: isBuy,
      p: px,
      s: floatToWire(pos.size),
      r: true,
      t: { limit: { tif: 'Ioc' } },
    });
  }

  if (orders.length === 0) return { closed: 0, message: 'No closable positions found' };

  const action = { type: 'order', orders, grouping: 'na' };
  const result = await hlExchange(action, privateKey, accountAddress, isMainnet);

  return {
    attempted: positions.length,
    symbols: positions.map(p => p.symbol),
    result: parseOrderResult(result, 'all', 'close-all', 0),
  };
}

export async function cmdReduce(options, walletName) {
  const symbol = (options.symbol || '').toUpperCase();
  const percent = parseFloat(options.percent || '50');
  if (!symbol) throw new Error('--symbol is required (e.g. --symbol BTC)');
  if (isNaN(percent) || percent <= 0 || percent > 100) throw new Error('--percent must be between 1 and 100');

  const { privateKey, accountAddress } = await getCredentials(walletName);
  const address = accountAddress || deriveEvmAddress(privateKey);

  const state = await hlInfo({ type: 'clearinghouseState', user: address });
  const posEntry = (state.assetPositions || []).find(p => p.position?.coin === symbol);
  if (!posEntry) throw new Error(`No open position found for ${symbol}`);

  const currentSzi = parseFloat(posEntry.position?.szi || '0');
  if (currentSzi === 0) throw new Error(`Position for ${symbol} has zero size`);

  const reduceSize = Math.abs(currentSzi) * (percent / 100);
  return cmdClose({ symbol: options.symbol, size: String(reduceSize) }, walletName);
}

export async function cmdSetSL(options, walletName) {
  return cmdSetTpSl(options, walletName, 'sl');
}

export async function cmdSetTP(options, walletName) {
  return cmdSetTpSl(options, walletName, 'tp');
}

async function cmdSetTpSl(options, walletName, type) {
  const symbol = (options.symbol || '').toUpperCase();
  const triggerPrice = parseFloat(options.price || '0');
  if (!symbol) throw new Error('--symbol is required');
  if (!triggerPrice || isNaN(triggerPrice)) throw new Error('--price is required (e.g. --price 60000)');

  const { privateKey, accountAddress, isMainnet } = await getCredentials(walletName);
  const address = accountAddress || deriveEvmAddress(privateKey);

  const state = await hlInfo({ type: 'clearinghouseState', user: address });
  const posEntry = (state.assetPositions || []).find(p => p.position?.coin === symbol);
  if (!posEntry) throw new Error(`No open position found for ${symbol}`);

  const currentSzi = parseFloat(posEntry.position?.szi || '0');
  if (currentSzi === 0) throw new Error(`Position for ${symbol} has zero size`);

  const meta = await getMeta();
  const assetIndex = await getAssetIndex(symbol, meta);
  const isBuy = currentSzi < 0; // closing short = buy

  const mids = await hlInfo({ type: 'allMids' });
  const mid = parseFloat(mids[symbol] || '0');

  // Limit price: for TP use trigger price; for SL use slippage (stop-market)
  let limitPx;
  if (type === 'tp') {
    limitPx = floatToWirePrice(triggerPrice);
  } else {
    limitPx = isBuy ? floatToWirePrice(mid * 1.1) : floatToWirePrice(mid * 0.9);
  }

  const orderType = type === 'tp'
    ? { trigger: { triggerPx: floatToWirePrice(triggerPrice), isMarket: false, tpsl: 'tp' } }
    : { trigger: { triggerPx: floatToWirePrice(triggerPrice), isMarket: true, tpsl: 'sl' } };

  const order = {
    a: assetIndex,
    b: isBuy,
    p: limitPx,
    s: floatToWire(Math.abs(currentSzi)),
    r: true,
    t: orderType,
  };

  const action = { type: 'order', orders: [order], grouping: 'tpsl' };
  const result = await hlExchange(action, privateKey, accountAddress, isMainnet);
  return {
    type,
    symbol,
    triggerPrice,
    result: parseOrderResult(result, symbol, type, Math.abs(currentSzi)),
  };
}

export async function cmdCancel(options, walletName) {
  const symbol = (options.symbol || '').toUpperCase();
  if (!symbol) throw new Error('--symbol is required (e.g. --symbol BTC)');

  const { privateKey, accountAddress, isMainnet } = await getCredentials(walletName);
  const address = accountAddress || deriveEvmAddress(privateKey);

  const meta = await getMeta();
  const assetIndex = await getAssetIndex(symbol, meta);

  const openOrders = await hlInfo({ type: 'openOrders', user: address });
  const toCancel = (openOrders || [])
    .filter(o => o.coin === symbol)
    .map(o => ({ a: assetIndex, o: o.oid }));

  if (toCancel.length === 0) return { symbol, cancelled: 0, message: 'No open orders found for this symbol' };

  const action = { type: 'cancel', cancels: toCancel };
  const result = await hlExchange(action, privateKey, accountAddress, isMainnet);
  return { symbol, cancelled: toCancel.length, result };
}

export async function cmdCancelAll(options, walletName) {
  const { privateKey, accountAddress, isMainnet } = await getCredentials(walletName);
  const address = accountAddress || deriveEvmAddress(privateKey);

  const [openOrders, meta] = await Promise.all([
    hlInfo({ type: 'openOrders', user: address }),
    getMeta(),
  ]);

  if (!openOrders || openOrders.length === 0) return { cancelled: 0, message: 'No open orders' };

  const universe = meta.universe || [];
  const symbolToIdx = Object.fromEntries(universe.map((a, i) => [a.name, i]));

  const toCancel = (openOrders || [])
    .filter(o => symbolToIdx[o.coin] !== undefined)
    .map(o => ({ a: symbolToIdx[o.coin], o: o.oid }));

  if (toCancel.length === 0) return { cancelled: 0, message: 'No cancellable orders found' };

  const action = { type: 'cancel', cancels: toCancel };
  const result = await hlExchange(action, privateKey, accountAddress, isMainnet);
  return { cancelled: toCancel.length, result };
}

// ============= CLI Command Builder =============

export function buildPerpsCommands(deps = {}) {
  const { errorOutput = console.error, exit = process.exit } = deps;

  return {
    'perps': async (args, apiInstance, flags, options) => {
      const subcommand = args[0] || 'help';
      const walletName = options.wallet;

      const handlers = {
        'status':     () => cmdStatus(options, walletName),
        'balance':    () => cmdBalance(options, walletName),
        'price':      () => cmdPrice(options),
        'funding':    () => cmdFunding(options),
        'orderbook':  () => cmdOrderbook(options),
        'search':     () => cmdSearch(options),
        'open':       () => cmdOpen(options, walletName),
        'close':      () => cmdClose(options, walletName),
        'close-all':  () => cmdCloseAll(options, walletName),
        'reduce':     () => cmdReduce(options, walletName),
        'set-sl':     () => cmdSetSL(options, walletName),
        'set-tp':     () => cmdSetTP(options, walletName),
        'cancel':     () => cmdCancel(options, walletName),
        'cancel-all': () => cmdCancelAll(options, walletName),
        'help': () => ({
          commands: [
            'status', 'balance', 'price', 'funding', 'orderbook', 'search',
            'open', 'close', 'close-all', 'reduce', 'set-sl', 'set-tp',
            'cancel', 'cancel-all',
          ],
          description: 'Hyperliquid perpetuals trading',
          auth: 'Write commands require HL_SECRET_KEY (32-byte private key) or NANSEN_WALLET_PASSWORD + --wallet',
          network: 'Mainnet by default. Set HL_TESTNET=1 for testnet.',
          examples: [
            'nansen perps status',
            'nansen perps balance',
            'nansen perps price --symbol BTC',
            'nansen perps funding --symbol ETH',
            'nansen perps orderbook --symbol BTC --depth 5',
            'nansen perps search --query pepe',
            'nansen perps open --symbol BTC --side long --size 0.001',
            'nansen perps open --symbol ETH --side short --size 0.1 --leverage 5 --isolated',
            'nansen perps open --symbol BTC --side long --size 0.001 --price 95000',
            'nansen perps close --symbol BTC',
            'nansen perps close --symbol BTC --size 0.0005',
            'nansen perps close-all',
            'nansen perps reduce --symbol BTC --percent 50',
            'nansen perps set-sl --symbol BTC --price 60000',
            'nansen perps set-tp --symbol BTC --price 120000',
            'nansen perps cancel --symbol BTC',
            'nansen perps cancel-all',
          ],
        }),
      };

      if (!handlers[subcommand]) {
        return { error: `Unknown subcommand: ${subcommand}`, available: Object.keys(handlers) };
      }

      return handlers[subcommand]();
    },
  };
}
