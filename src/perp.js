/**
 * Nansen CLI - Hyperliquid Perpetual Trading
 * Place/cancel orders, manage leverage, view positions on Hyperliquid.
 * Zero external dependencies beyond existing project deps.
 */

import { keccak256, signSecp256k1 } from './crypto.js';
import { exportWallet, getWalletConfig, showWallet, listWallets } from './wallet.js';
import { retrievePassword } from './keychain.js';
import { NansenError, ErrorCode } from './api.js';
import { sendTokens } from './transfer.js';

// ============= Constants =============

const HL_EXCHANGE_URL = process.env.NANSEN_HL_EXCHANGE_URL || 'https://api.hyperliquid.xyz/exchange';
const HL_INFO_URL = process.env.NANSEN_HL_INFO_URL || 'https://api.hyperliquid.xyz/info';
const HL_CHAIN_ID = 1337;
const HL_VERIFYING_CONTRACT = '0x0000000000000000000000000000000000000000';

const DEFAULT_BUILDER_ADDRESS = '0x0000000000000000000000000000000000000000';
const DEFAULT_BUILDER_FEE = 1; // tenths of bps (0.1 bps)
const DEFAULT_SLIPPAGE = 0.03; // 3%

// Hyperliquid bridge on Arbitrum
const HL_BRIDGE_ADDRESS = '0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7';
const ARB_USDC_ADDRESS = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const MIN_DEPOSIT_USDC = 5; // amounts below this are permanently lost

// ============= Msgpack Encoder (minimal subset for Hyperliquid) =============

/**
 * Encode a value to msgpack binary format.
 * Supports: null, bool, int, float, string, array, map (sorted keys).
 */
export function msgpackEncode(value) {
  if (value === null || value === undefined) return Buffer.from([0xc0]);
  if (value === true) return Buffer.from([0xc3]);
  if (value === false) return Buffer.from([0xc2]);

  if (typeof value === 'number') {
    if (Number.isInteger(value)) return msgpackEncodeInt(value);
    return msgpackEncodeFloat64(value);
  }

  if (typeof value === 'string') return msgpackEncodeString(value);
  if (Array.isArray(value)) return msgpackEncodeArray(value);
  if (typeof value === 'object') return msgpackEncodeMap(value);

  throw new Error(`msgpack: unsupported type ${typeof value}`);
}

function msgpackEncodeInt(n) {
  if (n >= 0 && n <= 127) return Buffer.from([n]);
  if (n >= -32 && n < 0) return Buffer.from([n & 0xff]);
  if (n >= 0 && n <= 0xff) return Buffer.from([0xcc, n]);
  if (n >= 0 && n <= 0xffff) {
    const buf = Buffer.alloc(3);
    buf[0] = 0xcd;
    buf.writeUInt16BE(n, 1);
    return buf;
  }
  if (n >= 0 && n <= 0xffffffff) {
    const buf = Buffer.alloc(5);
    buf[0] = 0xce;
    buf.writeUInt32BE(n, 1);
    return buf;
  }
  if (n > 0xffffffff && Number.isSafeInteger(n)) {
    const buf = Buffer.alloc(9);
    buf[0] = 0xcf;
    buf.writeBigUInt64BE(BigInt(n), 1);
    return buf;
  }
  if (n >= -128 && n < 0) return Buffer.from([0xd0, n & 0xff]);
  if (n >= -32768 && n < 0) {
    const buf = Buffer.alloc(3);
    buf[0] = 0xd1;
    buf.writeInt16BE(n, 1);
    return buf;
  }
  if (n >= -2147483648 && n < 0) {
    const buf = Buffer.alloc(5);
    buf[0] = 0xd2;
    buf.writeInt32BE(n, 1);
    return buf;
  }
  // Large integers: encode as float64
  return msgpackEncodeFloat64(n);
}

function msgpackEncodeFloat64(n) {
  const buf = Buffer.alloc(9);
  buf[0] = 0xcb;
  buf.writeDoubleBE(n, 1);
  return buf;
}

function msgpackEncodeString(s) {
  const bytes = Buffer.from(s, 'utf8');
  const len = bytes.length;
  if (len <= 31) return Buffer.concat([Buffer.from([0xa0 | len]), bytes]);
  if (len <= 0xff) return Buffer.concat([Buffer.from([0xd9, len]), bytes]);
  if (len <= 0xffff) {
    const header = Buffer.alloc(3);
    header[0] = 0xda;
    header.writeUInt16BE(len, 1);
    return Buffer.concat([header, bytes]);
  }
  throw new Error(`msgpack: string too long (${len})`);
}

function msgpackEncodeArray(arr) {
  const len = arr.length;
  let header;
  if (len <= 15) {
    header = Buffer.from([0x90 | len]);
  } else if (len <= 0xffff) {
    header = Buffer.alloc(3);
    header[0] = 0xdc;
    header.writeUInt16BE(len, 1);
  } else {
    throw new Error(`msgpack: array too long (${len})`);
  }
  return Buffer.concat([header, ...arr.map(msgpackEncode)]);
}

function msgpackEncodeMap(obj) {
  const keys = Object.keys(obj); // Preserve insertion order (matches Python SDK / Rust server)
  const len = keys.length;
  let header;
  if (len <= 15) {
    header = Buffer.from([0x80 | len]);
  } else if (len <= 0xffff) {
    header = Buffer.alloc(3);
    header[0] = 0xde;
    header.writeUInt16BE(len, 1);
  } else {
    throw new Error(`msgpack: map too large (${len})`);
  }
  const parts = [header];
  for (const key of keys) {
    parts.push(msgpackEncodeString(key));
    parts.push(msgpackEncode(obj[key]));
  }
  return Buffer.concat(parts);
}

// ============= EIP-712 Helpers (adapted from x402-evm.js) =============

const DOMAIN_TYPES = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
];

function encodeType(typeName, fields) {
  return `${typeName}(${fields.map(f => `${f.type} ${f.name}`).join(',')})`;
}

function typeHash(typeName, fields) {
  return keccak256(Buffer.from(encodeType(typeName, fields), 'utf8'));
}

function encodeValue(fieldType, value) {
  if (fieldType === 'string') return keccak256(Buffer.from(value, 'utf8'));
  if (fieldType === 'bytes') {
    const buf = typeof value === 'string' ? Buffer.from(value.replace(/^0x/, ''), 'hex') : value;
    return keccak256(buf);
  }
  if (fieldType === 'bytes32') {
    if (typeof value === 'string') return Buffer.from(value.replace(/^0x/, ''), 'hex');
    return value;
  }
  if (fieldType === 'address') {
    return Buffer.from(value.replace(/^0x/, '').toLowerCase().padStart(64, '0'), 'hex');
  }
  if (fieldType.startsWith('uint') || fieldType.startsWith('int')) {
    return Buffer.from(BigInt(value).toString(16).padStart(64, '0'), 'hex');
  }
  if (fieldType === 'bool') {
    return Buffer.from((value ? '1' : '0').padStart(64, '0'), 'hex');
  }
  throw new Error(`Unsupported EIP-712 field type: ${fieldType}`);
}

function hashStruct(typeName, fields, data) {
  const parts = [typeHash(typeName, fields)];
  for (const field of fields) {
    const value = data[field.name];
    if (value === undefined || value === null) throw new Error(`Missing EIP-712 field: ${field.name}`);
    parts.push(encodeValue(field.type, value));
  }
  return keccak256(Buffer.concat(parts));
}

function hashDomain(domain) {
  return hashStruct('EIP712Domain', DOMAIN_TYPES, domain);
}

function hashTypedData(domain, primaryType, fields, message) {
  const domainSeparator = hashDomain(domain);
  const structHash = hashStruct(primaryType, fields, message);
  return keccak256(Buffer.concat([Buffer.from([0x19, 0x01]), domainSeparator, structHash]));
}

// ============= Hyperliquid Signing =============

const AGENT_TYPES = [
  { name: 'source', type: 'string' },
  { name: 'connectionId', type: 'bytes32' },
];

const HL_DOMAIN = {
  name: 'Exchange',
  version: '1',
  chainId: HL_CHAIN_ID,
  verifyingContract: HL_VERIFYING_CONTRACT,
};

// Mainnet source string for phantom agent
const MAINNET_SOURCE = 'a';

// User-signed action domain (for withdraw, approve builder fee, etc.)
const HL_USER_DOMAIN = {
  name: 'HyperliquidSignTransaction',
  version: '1',
  chainId: 421614,
  verifyingContract: HL_VERIFYING_CONTRACT,
};

/**
 * Sign a Hyperliquid exchange action using EIP-712 phantom agent signing.
 * @param {object} action - The action to sign
 * @param {string} privateKeyHex - 32-byte EVM private key as hex (with or without 0x prefix)
 * @param {number} nonce - Timestamp in ms
 * @returns {{ action, nonce, signature: {r, s, v}, vaultAddress: null }}
 */
export function signHyperliquidAction(action, privateKeyHex, nonce) {
  const encoded = msgpackEncode(action);
  const nonceBytes = Buffer.alloc(8);
  nonceBytes.writeBigUInt64BE(BigInt(nonce));
  // connectionId = keccak256(msgpack(action) || nonce_bytes || vaultAddress=0)
  const connectionId = keccak256(Buffer.concat([encoded, nonceBytes, Buffer.alloc(1)]));

  const agentMessage = {
    source: MAINNET_SOURCE,
    connectionId: '0x' + connectionId.toString('hex'),
  };

  const msgHash = hashTypedData(HL_DOMAIN, 'Agent', AGENT_TYPES, agentMessage);
  const keyBuf = Buffer.from(privateKeyHex.replace(/^0x/, ''), 'hex');
  const { r, s, v } = signSecp256k1(msgHash, keyBuf);

  return {
    action,
    nonce,
    signature: {
      r: '0x' + r.toString('hex'),
      s: '0x' + s.toString('hex'),
      v: 27 + v,
    },
    vaultAddress: null,
  };
}

/**
 * Sign a Hyperliquid user-signed action (withdraw, approve builder fee, etc.)
 * Uses a different EIP-712 domain than L1 trading actions.
 */
export function signUserAction(action, primaryType, typeFields, privateKeyHex, nonce) {
  // Message excludes 'type' and 'signatureChainId' from the action
  const message = {};
  for (const field of typeFields) {
    message[field.name] = action[field.name];
  }

  const msgHash = hashTypedData(HL_USER_DOMAIN, primaryType, typeFields, message);
  const keyBuf = Buffer.from(privateKeyHex.replace(/^0x/, ''), 'hex');
  const { r, s, v } = signSecp256k1(msgHash, keyBuf);

  return {
    action,
    nonce,
    signature: {
      r: '0x' + r.toString('hex'),
      s: '0x' + s.toString('hex'),
      v: 27 + v,
    },
    vaultAddress: null,
  };
}

// ============= Hyperliquid API Client =============

async function hlInfoRequest(body) {
  const response = await fetch(HL_INFO_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new NansenError(`Hyperliquid info error (${response.status}): ${text}`, ErrorCode.SERVER_ERROR);
  }
  return response.json();
}

async function hlExchangeRequest(payload) {
  const response = await fetch(HL_EXCHANGE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (data.status === 'err') {
    throw new NansenError(`Hyperliquid: ${data.response}`, ErrorCode.INVALID_PARAMS);
  }
  return data;
}

// Asset index cache: { universe: [...], timestamp }
let metaCache = null;
const META_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Get asset metadata from Hyperliquid and resolve symbol to asset index.
 * Caches for 5 minutes.
 */
export async function getAssetIndex(symbol) {
  const now = Date.now();
  if (!metaCache || now - metaCache.timestamp > META_CACHE_TTL) {
    const meta = await hlInfoRequest({ type: 'meta' });
    metaCache = { universe: meta.universe, timestamp: now };
  }
  const upper = symbol.toUpperCase();
  const idx = metaCache.universe.findIndex(a => a.name.toUpperCase() === upper);
  if (idx === -1) {
    const available = metaCache.universe.slice(0, 20).map(a => a.name).join(', ');
    throw new NansenError(
      `Unknown asset: ${symbol}. Available: ${available}...`,
      ErrorCode.INVALID_PARAMS
    );
  }
  return idx;
}

export async function getSzDecimals(assetIndex) {
  if (!metaCache) await getAssetIndex('BTC'); // force cache fill
  return metaCache.universe[assetIndex]?.szDecimals ?? 8;
}

export async function getAllMidPrices() {
  return hlInfoRequest({ type: 'allMids' });
}

export async function getUserState(address) {
  return hlInfoRequest({ type: 'clearinghouseState', user: address });
}

export async function getOpenOrders(address) {
  return hlInfoRequest({ type: 'frontendOpenOrders', user: address });
}

// ============= Order Helpers =============

/**
 * Round size to the asset's szDecimals.
 */
function roundSize(size, szDecimals) {
  const factor = Math.pow(10, szDecimals);
  return Math.round(size * factor) / factor;
}

/**
 * Round price to 5 significant figures (Hyperliquid convention).
 * Uses toFixed() to avoid scientific notation for very small numbers.
 */
export function roundPrice(price) {
  if (price === 0) return '0';
  const sigFigs = 5;
  const d = Math.ceil(Math.log10(Math.abs(price)));
  const power = sigFigs - d;
  const magnitude = Math.pow(10, power);
  const shifted = Math.round(price * magnitude);
  const result = shifted / magnitude;
  // Avoid scientific notation (e.g. 1e-7) — Hyperliquid expects decimal strings
  if (power > 0) {
    return result.toFixed(power);
  }
  return String(result);
}

/**
 * Build an order action for Hyperliquid.
 */
export function buildOrderAction(params) {
  const { assetIndex, isBuy, price, size, orderType, reduceOnly = false, builderAddress, builderFee } = params;
  const action = {
    type: 'order',
    orders: [{
      a: assetIndex,
      b: isBuy,
      p: price,
      s: size,
      r: reduceOnly,
      t: orderType,
    }],
    grouping: 'na',
  };
  // Only include builder if an address is provided (requires prior approveBuilderFee)
  if (builderAddress) {
    action.builder = {
      b: builderAddress.toLowerCase(),
      f: builderFee ?? DEFAULT_BUILDER_FEE,
    };
  }
  return action;
}

export function buildCancelAction(assetIndex, orderIds) {
  return {
    type: 'cancel',
    cancels: orderIds.map(o => ({ a: assetIndex, o: Number(o) })),
  };
}

export function buildLeverageAction(assetIndex, leverage, isCross) {
  return {
    type: 'updateLeverage',
    asset: assetIndex,
    isCross,
    leverage: Number(leverage),
  };
}

// ============= Wallet Helpers =============

function resolveWallet(walletName, deps) {
  const { log, exit } = deps;
  const config = getWalletConfig();
  let password = null;
  if (config.passwordHash) {
    const { password: pw, source } = retrievePassword();
    password = pw;
    if (source === 'file') {
      process.stderr.write(
        '  Password loaded from ~/.nansen/wallets/.credentials (insecure).\n' +
        '   For better security, migrate: nansen wallet secure\n'
      );
    }
    if (!password) {
      log('Wallet is encrypted and no password was found. Set NANSEN_WALLET_PASSWORD env var.');
      exit(1);
      return null;
    }
  }

  let effectiveName = walletName;
  if (!effectiveName) {
    const list = listWallets();
    effectiveName = list.defaultWallet;
  }
  if (!effectiveName) {
    log('No wallet found. Create one with: nansen wallet create');
    exit(1);
    return null;
  }

  const exported = exportWallet(effectiveName, password);
  if (!exported.evm?.privateKey) {
    log('Wallet has no EVM key. Create a new wallet: nansen wallet create');
    exit(1);
    return null;
  }

  exported._password = password;
  exported._walletName = effectiveName;
  return exported;
}

function getWalletAddress(walletName) {
  let name = walletName;
  if (!name) {
    const list = listWallets();
    name = list.defaultWallet;
  }
  if (!name) return null;
  const wallet = showWallet(name);
  return wallet?.evm;
}

// ============= CLI Command Builder =============

export function buildPerpCommands(deps = {}) {
  const { log = console.log, exit = process.exit } = deps;

  return {
    'place-order': async (args, _apiInstance, flags, options) => {
      const asset = options.asset;
      const side = options.side;
      const size = options.size;
      const type = options.type || 'market';
      const price = options.price;
      const slippage = parseFloat(options.slippage || DEFAULT_SLIPPAGE);
      const reduceOnly = flags['reduce-only'];
      const tif = (options.tif || '').toLowerCase();
      const builderAddress = options['builder-address'] || null;
      const builderFee = options['builder-fee'] ? parseInt(options['builder-fee']) : DEFAULT_BUILDER_FEE;

      if (!asset) throw new NansenError('--asset is required (e.g. BTC, ETH)', ErrorCode.INVALID_PARAMS);
      if (!side || !['buy', 'sell'].includes(side)) throw new NansenError('--side must be "buy" or "sell"', ErrorCode.INVALID_PARAMS);
      if (!size) throw new NansenError('--size is required (position size in asset units)', ErrorCode.INVALID_PARAMS);
      if (type === 'limit' && !price) throw new NansenError('--price is required for limit orders', ErrorCode.INVALID_PARAMS);

      const exported = resolveWallet(options.wallet, { log, exit });
      if (!exported) return;

      const assetIndex = await getAssetIndex(asset);
      const szDecimals = await getSzDecimals(assetIndex);
      const isBuy = side === 'buy';
      const roundedSize = String(roundSize(parseFloat(size), szDecimals));

      let orderPrice;
      let orderType;

      if (type === 'market') {
        const mids = await getAllMidPrices();
        const mid = parseFloat(mids[asset.toUpperCase()]);
        if (!mid) throw new NansenError(`No mid price available for ${asset}`, ErrorCode.INVALID_PARAMS);
        const adjusted = isBuy ? mid * (1 + slippage) : mid * (1 - slippage);
        orderPrice = roundPrice(adjusted);
        orderType = { limit: { tif: 'Ioc' } };
        log(`Market ${side} ${roundedSize} ${asset.toUpperCase()} @ ~${orderPrice} (mid: ${mid}, slippage: ${(slippage * 100).toFixed(1)}%)`);
      } else {
        orderPrice = roundPrice(parseFloat(price));
        const effectiveTif = tif === 'ioc' ? 'Ioc' : tif === 'alo' ? 'Alo' : 'Gtc';
        orderType = { limit: { tif: effectiveTif } };
        log(`Limit ${side} ${roundedSize} ${asset.toUpperCase()} @ ${orderPrice} (${effectiveTif})`);
      }

      const action = buildOrderAction({
        assetIndex, isBuy, price: orderPrice, size: roundedSize,
        orderType, reduceOnly, builderAddress, builderFee,
      });

      const nonce = Date.now();
      const payload = signHyperliquidAction(action, exported.evm.privateKey, nonce);
      const result = await hlExchangeRequest(payload);

      const statuses = result.response?.data?.statuses || [];
      for (const status of statuses) {
        if (status.filled) {
          log(`Filled: ${status.filled.totalSz} @ ${status.filled.avgPx} (oid: ${status.filled.oid})`);
        } else if (status.resting) {
          log(`Order resting (oid: ${status.resting.oid})`);
        } else if (status.error) {
          log(`Order rejected: ${status.error}`);
        } else {
          log(`Status: ${JSON.stringify(status)}`);
        }
      }
    },

    'cancel': async (args, _apiInstance, flags, options) => {
      const asset = options.asset;
      if (!asset) throw new NansenError('--asset is required', ErrorCode.INVALID_PARAMS);

      // Collect order IDs from --oid flags (can be specified multiple times)
      const oids = Array.isArray(options.oid) ? options.oid : options.oid ? [options.oid] : [];
      if (oids.length === 0) throw new NansenError('--oid is required (order ID to cancel)', ErrorCode.INVALID_PARAMS);

      const exported = resolveWallet(options.wallet, { log, exit });
      if (!exported) return;

      const assetIndex = await getAssetIndex(asset);
      const action = buildCancelAction(assetIndex, oids);
      const nonce = Date.now();
      const payload = signHyperliquidAction(action, exported.evm.privateKey, nonce);
      const result = await hlExchangeRequest(payload);

      log(`Cancelled ${oids.length} order(s) for ${asset.toUpperCase()}`);
      const statuses = result.response?.data?.statuses || [];
      for (const status of statuses) {
        if (status === 'success') {
          log('  OK');
        } else {
          log(`  ${JSON.stringify(status)}`);
        }
      }
    },

    'update-leverage': async (args, _apiInstance, flags, options) => {
      const asset = options.asset;
      const leverage = options.leverage;
      const marginType = options['margin-type'] || 'cross';

      if (!asset) throw new NansenError('--asset is required', ErrorCode.INVALID_PARAMS);
      if (!leverage) throw new NansenError('--leverage is required', ErrorCode.INVALID_PARAMS);
      if (!['cross', 'isolated'].includes(marginType)) {
        throw new NansenError('--margin-type must be "cross" or "isolated"', ErrorCode.INVALID_PARAMS);
      }

      const exported = resolveWallet(options.wallet, { log, exit });
      if (!exported) return;

      const assetIndex = await getAssetIndex(asset);
      const action = buildLeverageAction(assetIndex, leverage, marginType === 'cross');
      const nonce = Date.now();
      const payload = signHyperliquidAction(action, exported.evm.privateKey, nonce);
      await hlExchangeRequest(payload);

      log(`Leverage updated: ${asset.toUpperCase()} ${leverage}x (${marginType})`);
    },

    'tp-sl': async (args, _apiInstance, flags, options) => {
      const asset = options.asset;
      const side = options.side;
      const size = options.size;
      const triggerPrice = options['trigger-price'];
      const tpsl = options.tpsl;
      const isMarket = flags['is-market'];
      const builderAddress = options['builder-address'] || null;
      const builderFee = options['builder-fee'] ? parseInt(options['builder-fee']) : DEFAULT_BUILDER_FEE;

      if (!asset) throw new NansenError('--asset is required', ErrorCode.INVALID_PARAMS);
      if (!side || !['buy', 'sell'].includes(side)) throw new NansenError('--side must be "buy" or "sell"', ErrorCode.INVALID_PARAMS);
      if (!size) throw new NansenError('--size is required', ErrorCode.INVALID_PARAMS);
      if (!triggerPrice) throw new NansenError('--trigger-price is required', ErrorCode.INVALID_PARAMS);
      if (!tpsl || !['tp', 'sl'].includes(tpsl)) throw new NansenError('--tpsl must be "tp" or "sl"', ErrorCode.INVALID_PARAMS);

      const exported = resolveWallet(options.wallet, { log, exit });
      if (!exported) return;

      const assetIndex = await getAssetIndex(asset);
      const szDecimals = await getSzDecimals(assetIndex);
      const isBuy = side === 'buy';
      const roundedSize = String(roundSize(parseFloat(size), szDecimals));
      const rounded_trigger = roundPrice(parseFloat(triggerPrice));

      // Key order must match Python SDK: isMarket, triggerPx, tpsl
      const orderType = {
        trigger: {
          isMarket: isMarket,
          triggerPx: rounded_trigger,
          tpsl: tpsl,
        },
      };

      const action = buildOrderAction({
        assetIndex, isBuy, price: rounded_trigger, size: roundedSize,
        orderType, reduceOnly: true, // trigger orders are always reduce-only
        builderAddress, builderFee,
      });

      const nonce = Date.now();
      const payload = signHyperliquidAction(action, exported.evm.privateKey, nonce);
      const result = await hlExchangeRequest(payload);

      const label = tpsl === 'tp' ? 'Take-profit' : 'Stop-loss';
      log(`${label} set: ${side} ${roundedSize} ${asset.toUpperCase()} @ trigger ${rounded_trigger}`);

      const statuses = result.response?.data?.statuses || [];
      for (const status of statuses) {
        if (status.resting) {
          log(`  Trigger order placed (oid: ${status.resting.oid})`);
        } else if (status.error) {
          log(`  Rejected: ${status.error}`);
        } else {
          log(`  ${JSON.stringify(status)}`);
        }
      }
    },

    // Research commands — return data objects for CLI formatting
    'positions': async (args, _apiInstance, flags, options) => {
      const address = getWalletAddress(options.wallet);
      if (!address) throw new NansenError('No wallet found. Create one with: nansen wallet create', ErrorCode.INVALID_PARAMS);
      return getUserState(address);
    },

    'open-orders': async (args, _apiInstance, flags, options) => {
      const address = getWalletAddress(options.wallet);
      if (!address) throw new NansenError('No wallet found. Create one with: nansen wallet create', ErrorCode.INVALID_PARAMS);
      return getOpenOrders(address);
    },

    'deposit': async (args, _apiInstance, flags, options) => {
      const amount = options.amount;
      if (!amount) throw new NansenError('--amount is required (USDC amount to deposit)', ErrorCode.INVALID_PARAMS);

      const amountNum = parseFloat(amount);
      if (isNaN(amountNum) || amountNum <= 0) throw new NansenError('--amount must be a positive number', ErrorCode.INVALID_PARAMS);
      if (amountNum < MIN_DEPOSIT_USDC) {
        throw new NansenError(
          `Minimum deposit is ${MIN_DEPOSIT_USDC} USDC. Amounts below this are permanently lost.`,
          ErrorCode.INVALID_PARAMS
        );
      }

      const exported = resolveWallet(options.wallet, { log, exit });
      if (!exported) return;

      log(`Depositing ${amountNum} USDC to Hyperliquid via Arbitrum bridge...`);
      log(`  Bridge: ${HL_BRIDGE_ADDRESS}`);
      log(`  From:   ${exported.evm.address}`);

      await sendTokens({
        to: HL_BRIDGE_ADDRESS,
        amount: String(amountNum),
        chain: 'arbitrum',
        token: ARB_USDC_ADDRESS,
        wallet: exported._walletName,
        password: exported._password,
      });

      log('Deposit sent. Funds typically credit to Hyperliquid within 1 minute.');
    },

    'withdraw': async (args, _apiInstance, flags, options) => {
      const amount = options.amount;
      if (!amount) throw new NansenError('--amount is required (USDC amount to withdraw)', ErrorCode.INVALID_PARAMS);

      const amountNum = parseFloat(amount);
      if (isNaN(amountNum) || amountNum <= 0) throw new NansenError('--amount must be a positive number', ErrorCode.INVALID_PARAMS);

      const exported = resolveWallet(options.wallet, { log, exit });
      if (!exported) return;

      const destination = exported.evm.address;
      const nonce = Date.now();

      const action = {
        type: 'withdraw3',
        hyperliquidChain: 'Mainnet',
        signatureChainId: '0x66eee',
        destination,
        amount: String(amountNum),
        time: nonce,
      };

      const withdrawTypes = [
        { name: 'hyperliquidChain', type: 'string' },
        { name: 'destination', type: 'string' },
        { name: 'amount', type: 'string' },
        { name: 'time', type: 'uint64' },
      ];

      log(`Withdrawing ${amountNum} USDC from Hyperliquid...`);
      log(`  Destination: ${destination} (Arbitrum)`);
      log(`  Note: $1 USDC fee will be deducted by Hyperliquid`);

      const payload = signUserAction(action, 'HyperliquidTransaction:Withdraw', withdrawTypes, exported.evm.privateKey, nonce);
      await hlExchangeRequest(payload);

      log('Withdrawal submitted. Funds typically arrive on Arbitrum within 3-4 minutes.');
    },
  };
}
