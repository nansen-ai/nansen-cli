/**
 * Nansen CLI - Trading Commands
 * Quote and execute DEX swaps via the Nansen Trading API.
 * Supports Solana and EVM chains (Ethereum, Base, BSC).
 * Zero external dependencies — uses Node.js built-in crypto only.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { exportWallet, getDefaultAddress, showWallet, keccak256, listWallets } from './wallet.js';

// ============= Constants =============

const TRADING_API_URL = process.env.NANSEN_TRADING_API_URL || 'https://trading-api.nansen.ai';

const CHAIN_MAP = {
  solana:   { index: '501', type: 'solana', chainId: 501,  name: 'Solana',   explorer: 'https://solscan.io/tx/' },
  ethereum: { index: '1',   type: 'evm',    chainId: 1,    name: 'Ethereum', explorer: 'https://etherscan.io/tx/' },
  base:     { index: '8453', type: 'evm',   chainId: 8453, name: 'Base',     explorer: 'https://basescan.org/tx/' },
  bsc:      { index: '56',  type: 'evm',    chainId: 56,   name: 'BSC',      explorer: 'https://bscscan.com/tx/' },
};

// Default public RPC endpoints (used for nonce fetching)
const EVM_RPC_URLS = {
  ethereum: process.env.NANSEN_RPC_ETHEREUM || 'https://eth.llamarpc.com',
  base:     process.env.NANSEN_RPC_BASE     || 'https://mainnet.base.org',
  bsc:      process.env.NANSEN_RPC_BSC      || 'https://bsc-dataseed.binance.org',
};

function getQuotesDir() {
  const configDir = path.join(process.env.HOME || process.env.USERPROFILE || '', '.nansen');
  return path.join(configDir, 'quotes');
}

// ============= Trading API Client =============

/**
 * Get a trading quote from the Nansen Trading API.
 * Returns quotes with transaction data ready for signing.
 *
 * @param {object} params - Query parameters for GET /quote
 * @returns {Promise<object>} Quote response with quotes[].transaction
 */
export async function getQuote(params) {
  const url = new URL('/quote', TRADING_API_URL);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }

  const headers = { 'Accept': 'application/json' };
  if (process.env.NANSEN_API_KEY) {
    headers['Authorization'] = `Bearer ${process.env.NANSEN_API_KEY}`;
  }

  const res = await fetch(url.toString(), { headers });

  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw Object.assign(
      new Error(`Quote API returned non-JSON response (status ${res.status}). This may be a Cloudflare challenge or server error.`),
      { code: 'NON_JSON_RESPONSE', status: res.status, details: text.slice(0, 200) }
    );
  }

  if (!res.ok) {
    const code = body.code || 'QUOTE_ERROR';
    const msg = body.message || `Quote request failed with status ${res.status}`;
    throw Object.assign(new Error(msg), { code, status: res.status, details: body.details });
  }

  return body;
}

/**
 * Broadcast a signed transaction via the Nansen Trading API.
 *
 * @param {object} params
 * @param {string} params.signedTransaction - Base64 (Solana) or 0x hex (EVM)
 * @param {string} [params.chain] - Target chain name
 * @param {string} [params.requestId] - Optional Jupiter request ID (Solana only)
 * @param {boolean} [params.simulate] - Run pre-broadcast simulation
 * @returns {Promise<object>} Execution result
 */
export async function executeTransaction(params) {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
  if (process.env.NANSEN_API_KEY) {
    headers['Authorization'] = `Bearer ${process.env.NANSEN_API_KEY}`;
  }

  const res = await fetch(`${TRADING_API_URL}/execute`, {
    method: 'POST',
    headers,
    body: JSON.stringify(params),
  });

  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw Object.assign(
      new Error(`Execute API returned non-JSON response (status ${res.status}). This may be a Cloudflare challenge or server error.`),
      { code: 'NON_JSON_RESPONSE', status: res.status, details: text.slice(0, 200) }
    );
  }

  if (!res.ok) {
    const code = body.code || 'EXECUTE_ERROR';
    const msg = body.message || `Execute request failed with status ${res.status}`;
    throw Object.assign(new Error(msg), { code, status: res.status, details: body.details });
  }

  return body;
}

// ============= Quote Storage =============

/**
 * Save a quote response to disk for later execution.
 * @returns {string} Quote ID
 */
export function saveQuote(quoteResponse, chain) {
  const dir = getQuotesDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const timestamp = Date.now();
  const hash = crypto.randomBytes(4).toString('hex');
  const quoteId = `${timestamp}-${hash}`;

  const data = { quoteId, chain, timestamp, response: quoteResponse };

  fs.writeFileSync(path.join(dir, `${quoteId}.json`), JSON.stringify(data, null, 2), { mode: 0o600 });
  cleanupQuotes();
  return quoteId;
}

/**
 * Load a saved quote by ID.
 */
export function loadQuote(quoteId) {
  const filePath = path.join(getQuotesDir(), `${quoteId}.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Quote "${quoteId}" not found. Quotes expire after 1 hour.`);
  }
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (Date.now() - data.timestamp > 3600000) {
    fs.unlinkSync(filePath);
    throw new Error('Quote has expired. Please request a new quote.');
  }
  return data;
}

/**
 * Remove quotes older than 1 hour.
 */
export function cleanupQuotes() {
  const dir = getQuotesDir();
  if (!fs.existsSync(dir)) return;
  const now = Date.now();
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      if (now - data.timestamp > 3600000) fs.unlinkSync(path.join(dir, file));
    } catch { /* ignore */ }
  }
}

// ============= Transaction Signing =============

// ----------------------------------------------------------------
// TODO: SECURITY REVIEW REQUIRED
// The signing functions below construct and sign raw transactions.
// They MUST be audited before any production/mainnet use.
// ----------------------------------------------------------------

/**
 * Sign a Solana transaction from quote data.
 *
 * The trading API returns a base64-encoded serialized VersionedTransaction
 * in quote.transaction. We deserialize, sign with Ed25519, re-serialize.
 *
 * Based on the e2e test pattern:
 *   const serializedTx = Buffer.from(quote.transaction, 'base64')
 *   const tx = VersionedTransaction.deserialize(serializedTx)
 *   tx.sign([signer])
 *
 * We replicate this without @solana/web3.js using raw crypto.
 *
 * @param {string} transactionBase64 - Base64-encoded serialized VersionedTransaction
 * @param {string} privateKeyHex - 128-char hex (64 bytes: seed + pubkey)
 * @returns {string} Base64-encoded signed transaction
 */
// ⚠️ SECURITY: Solana transaction signing - requires thorough review before production use
export function signSolanaTransaction(transactionBase64, privateKeyHex) {
  const txBytes = Buffer.from(transactionBase64, 'base64');

  // Extract Ed25519 seed (first 32 bytes of the 64-byte keypair)
  const seed = Buffer.from(privateKeyHex.slice(0, 64), 'hex');

  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([
      Buffer.from('302e020100300506032b657004220420', 'hex'), // PKCS8 Ed25519 prefix
      seed,
    ]),
    format: 'der',
    type: 'pkcs8',
  });

  // VersionedTransaction wire format:
  // [signatures_count (compact-u16)] [signatures (64 bytes each)...] [message_bytes...]
  const { value: sigCount, size: sigCountSize } = readCompactU16(txBytes, 0);
  const messageOffset = sigCountSize + (sigCount * 64);
  const messageBytes = txBytes.subarray(messageOffset);

  // Sign the message bytes
  const signature = crypto.sign(null, messageBytes, privateKey);

  // Write signature into the first slot (fee payer = our wallet)
  const signedTx = Buffer.from(txBytes);
  signature.copy(signedTx, sigCountSize);

  return signedTx.toString('base64');
}

/**
 * Sign an EVM transaction from quote data.
 *
 * The trading API returns transaction fields in quote.transaction:
 *   { to, data, value?, gas?, gasPrice? }
 *
 * The nonce must be fetched from the chain RPC.
 * Signs as a legacy (type 0) transaction with gasPrice (matching the e2e tests).
 *
 * @param {object} txData - Transaction fields from quote.transaction { to, data, value, gas, gasPrice }
 * @param {string} privateKeyHex - 64-char hex (32-byte secp256k1 private key)
 * @param {string} chain - Chain name (ethereum, base, bsc)
 * @param {number} nonce - Account nonce
 * @returns {string} 0x-prefixed signed transaction hex
 */
// ⚠️ SECURITY: EVM transaction signing - requires thorough review before production use
export function signEvmTransaction(txData, privateKeyHex, chain, nonce) {
  const chainConfig = CHAIN_MAP[chain];
  if (!chainConfig || chainConfig.type !== 'evm') {
    throw new Error(`Unsupported EVM chain: ${chain}`);
  }

  const tx = {
    nonce,
    gasPrice: toHex(txData.gasPrice || txData.maxFeePerGas || '1'),
    gasLimit: toHex(txData.gas || txData.gasLimit || '210000'),
    to: txData.to,
    value: toHex(txData.value || '0'),
    data: txData.data || '0x',
    chainId: chainConfig.chainId,
  };

  return signLegacyTransaction(tx, privateKeyHex);
}

/**
 * Fetch the pending nonce for an EVM address.
 * @param {string} chain - Chain name
 * @param {string} address - 0x address
 * @returns {Promise<number>} Nonce
 */
export async function getEvmNonce(chain, address) {
  const rpcUrl = EVM_RPC_URLS[chain];
  if (!rpcUrl) throw new Error(`No RPC URL configured for chain: ${chain}`);

  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_getTransactionCount',
      params: [address, 'pending'],
    }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`RPC error: ${body.error.message}`);
  return parseInt(body.result, 16);
}

/**
 * Wait for an EVM transaction to be confirmed on-chain.
 * Polls eth_getTransactionReceipt until receipt is available or timeout.
 *
 * @param {string} chain - Chain name
 * @param {string} txHash - Transaction hash (0x...)
 * @param {number} [timeoutMs=30000] - Max wait time
 * @param {number} [pollMs=2000] - Poll interval
 * @returns {Promise<object>} Transaction receipt
 */
export async function waitForReceipt(chain, txHash, timeoutMs = 30000, pollMs = 2000) {
  const rpcUrl = EVM_RPC_URLS[chain];
  if (!rpcUrl) throw new Error(`No RPC URL configured for chain: ${chain}`);

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getTransactionReceipt',
        params: [txHash],
      }),
    });
    const body = await res.json();
    if (body.result) {
      const status = parseInt(body.result.status, 16);
      if (status !== 1) {
        throw new Error(`Transaction reverted on-chain (status: 0x${body.result.status}). Tx: ${txHash}`);
      }
      return body.result;
    }
    // Receipt not yet available — wait and retry
    await new Promise(r => setTimeout(r, pollMs));
  }
  throw new Error(`Transaction receipt not found after ${timeoutMs}ms. Tx: ${txHash}`);
}

/**
 * Send an ERC-20 approval transaction.
 * Required before swapping non-native EVM tokens.
 *
 * @param {string} tokenAddress - ERC-20 token contract
 * @param {string} spenderAddress - Approval target (from quote.approvalAddress)
 * @param {string} privateKeyHex - Wallet private key
 * @param {string} chain - Chain name
 * @param {number} nonce - Account nonce
 * @returns {string} 0x-prefixed signed approval tx hex
 */
// ⚠️ SECURITY: ERC-20 approval signing - requires thorough review
export function buildApprovalTransaction(tokenAddress, spenderAddress, privateKeyHex, chain, nonce, gasPrice) {
  const chainConfig = CHAIN_MAP[chain];
  if (!chainConfig) throw new Error(`Unsupported chain: ${chain}`);

  // ERC-20 approve(address spender, uint256 amount) selector = 0x095ea7b3
  // Approve max uint256
  const MAX_UINT256_HEX = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
  const data = '0x095ea7b3'
    + spenderAddress.slice(2).toLowerCase().padStart(64, '0')
    + MAX_UINT256_HEX;

  const tx = {
    nonce,
    gasPrice: toHex(gasPrice || '1000000'),
    gasLimit: '0x186a0', // 100000
    to: tokenAddress,
    value: '0x0',
    data,
    chainId: chainConfig.chainId,
  };

  return signLegacyTransaction(tx, privateKeyHex);
}

// ============= Legacy (Type 0) EVM Transaction Signing =============
// ⚠️ SECURITY: Legacy EVM transaction signing - requires thorough review before production use

/**
 * Sign a legacy (type 0) EVM transaction.
 *
 * @param {object} tx - { nonce, gasPrice, gasLimit, to, value, data, chainId }
 * @param {string} privateKeyHex - 32-byte private key as hex
 * @returns {string} 0x-prefixed signed transaction hex
 */
export function signLegacyTransaction(tx, privateKeyHex) {
  // EIP-155 unsigned: RLP([nonce, gasPrice, gasLimit, to, value, data, chainId, 0, 0])
  const unsignedFields = [
    rlpNormalize(tx.nonce),
    rlpNormalize(tx.gasPrice),
    rlpNormalize(tx.gasLimit),
    toBuffer(tx.to),
    rlpNormalize(tx.value),
    toBuffer(tx.data || '0x'),
    rlpNormalize(tx.chainId),
    Buffer.alloc(0), // EIP-155: empty for signing
    Buffer.alloc(0), // EIP-155: empty for signing
  ];

  const unsignedPayload = rlpEncode(unsignedFields);
  const msgHash = keccak256(unsignedPayload);

  // Sign with secp256k1
  const { r, s, v: recoveryBit } = ecdsaSign(msgHash, Buffer.from(privateKeyHex, 'hex'));

  // EIP-155 v = chainId * 2 + 35 + recoveryBit
  const v = tx.chainId * 2 + 35 + recoveryBit;

  // Signed: RLP([nonce, gasPrice, gasLimit, to, value, data, v, r, s])
  const signedFields = [
    rlpNormalize(tx.nonce),
    rlpNormalize(tx.gasPrice),
    rlpNormalize(tx.gasLimit),
    toBuffer(tx.to),
    rlpNormalize(tx.value),
    toBuffer(tx.data || '0x'),
    rlpNormalize(v),
    r.length > 0 && r[0] === 0 ? r.subarray(1) : r, // strip leading zero
    s.length > 0 && s[0] === 0 ? s.subarray(1) : s,
  ];

  return '0x' + rlpEncode(signedFields).toString('hex');
}

// ============= ECDSA Signing (secp256k1) =============
// ⚠️ SECURITY: Raw ECDSA implementation - requires thorough review

/**
 * Sign a 32-byte hash with secp256k1 using pure BigInt math.
 * No additional hashing — signs the pre-hashed message directly.
 *
 * Uses RFC 6979 deterministic k generation for safety.
 *
 * ⚠️ SECURITY: Pure JS ECDSA implementation - requires thorough review.
 *
 * @param {Buffer} msgHash - 32-byte keccak256 hash
 * @param {Buffer} privKeyBuf - 32-byte private key
 * @returns {{ r: Buffer, s: Buffer, v: number }} Signature components
 */
function ecdsaSign(msgHash, privKeyBuf) {
  const d = BigInt('0x' + privKeyBuf.toString('hex'));
  const z = BigInt('0x' + msgHash.toString('hex'));
  const G = [Gx, Gy];

  // Compute public key for recovery verification
  const Q = pointMul(G, d);
  const pubKeyUncompressed = Buffer.from(
    '04' + Q[0].toString(16).padStart(64, '0') + Q[1].toString(16).padStart(64, '0'), 'hex'
  );

  // RFC 6979 deterministic k
  const k = generateK(msgHash, privKeyBuf);

  // R = k * G
  const R = pointMul(G, k);
  const rBn = R[0] % N_EC;
  if (rBn === 0n) throw new Error('Invalid k: r is zero');

  // s = k⁻¹ * (z + r * d) mod n
  const kInv = modInv(k, N_EC);
  let sBn = (kInv * ((z + rBn * d) % N_EC)) % N_EC;
  if (sBn === 0n) throw new Error('Invalid k: s is zero');

  // Low-S normalization (EIP-2)
  const halfN = N_EC >> 1n;
  let sFlipped = false;
  if (sBn > halfN) {
    sBn = N_EC - sBn;
    sFlipped = true;
  }

  const r = Buffer.from(rBn.toString(16).padStart(64, '0'), 'hex');
  const s = Buffer.from(sBn.toString(16).padStart(64, '0'), 'hex');

  // Determine recovery ID by trial
  for (let tryV = 0; tryV <= 1; tryV++) {
    const recovered = ecRecover(msgHash, r, s, tryV);
    if (recovered && recovered.equals(pubKeyUncompressed)) {
      return { r, s, v: tryV };
    }
  }

  // Should not reach here with valid keys
  return { r, s, v: 0 };
}

/**
 * RFC 6979 deterministic k generation for secp256k1.
 * ⚠️ SECURITY: Simplified implementation — review before production use.
 */
function generateK(msgHash, privKey) {
  // HMAC-based deterministic k per RFC 6979
  let v = Buffer.alloc(32, 0x01);
  let kk = Buffer.alloc(32, 0x00);

  const x = privKey;
  const h1 = msgHash;

  // Step D
  kk = crypto.createHmac('sha256', kk).update(Buffer.concat([v, Buffer.from([0x00]), x, h1])).digest();
  // Step E
  v = crypto.createHmac('sha256', kk).update(v).digest();
  // Step F
  kk = crypto.createHmac('sha256', kk).update(Buffer.concat([v, Buffer.from([0x01]), x, h1])).digest();
  // Step G
  v = crypto.createHmac('sha256', kk).update(v).digest();

  // Step H
  while (true) {
    v = crypto.createHmac('sha256', kk).update(v).digest();
    const candidate = BigInt('0x' + v.toString('hex'));
    if (candidate >= 1n && candidate < N_EC) {
      return candidate;
    }
    kk = crypto.createHmac('sha256', kk).update(Buffer.concat([v, Buffer.from([0x00])])).digest();
    v = crypto.createHmac('sha256', kk).update(v).digest();
  }
}

// ============= EC Point Recovery (secp256k1) =============
// ⚠️ SECURITY: Modular arithmetic for secp256k1 - requires review

const P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2Fn;
const N_EC = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
const Gx = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798n;
const Gy = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8n;

function modPow(base, exp, mod) {
  let result = 1n;
  base = ((base % mod) + mod) % mod;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod;
    exp >>= 1n;
    base = (base * base) % mod;
  }
  return result;
}

function modInv(a, mod) {
  return modPow(a, mod - 2n, mod);
}

// Point addition on secp256k1 (affine coordinates, null = point at infinity)
function pointAdd(p1, p2) {
  if (!p1) return p2;
  if (!p2) return p1;
  const [x1, y1] = p1;
  const [x2, y2] = p2;
  if (x1 === x2 && y1 === y2) {
    // Point doubling
    const lam = (3n * x1 * x1 * modInv(2n * y1, P)) % P;
    const x3 = ((lam * lam - 2n * x1) % P + P) % P;
    const y3 = ((lam * (x1 - x3) - y1) % P + P) % P;
    return [x3, y3];
  }
  if (x1 === x2) return null; // point at infinity
  const lam = ((y2 - y1) * modInv(((x2 - x1) % P + P) % P, P)) % P;
  const x3 = ((lam * lam - x1 - x2) % P + P) % P;
  const y3 = ((lam * (x1 - x3) - y1) % P + P) % P;
  return [x3, y3];
}

// Scalar multiplication (double-and-add)
function pointMul(point, scalar) {
  let result = null;
  let current = point;
  scalar = ((scalar % N_EC) + N_EC) % N_EC;
  while (scalar > 0n) {
    if (scalar & 1n) result = pointAdd(result, current);
    current = pointAdd(current, current);
    scalar >>= 1n;
  }
  return result;
}

/**
 * Recover the uncompressed public key from an ECDSA signature.
 * @param {Buffer} msgHash - 32-byte hash
 * @param {Buffer} r - 32-byte r
 * @param {Buffer} s - 32-byte s
 * @param {number} v - recovery id (0 or 1)
 * @returns {Buffer|null} 65-byte uncompressed public key, or null on failure
 */
export function ecRecover(msgHash, r, s, v) {
  try {
    const rBn = BigInt('0x' + r.toString('hex'));
    const sBn = BigInt('0x' + s.toString('hex'));
    const z = BigInt('0x' + msgHash.toString('hex'));

    // Recover R point: x = r, solve y from curve equation y² = x³ + 7
    const x = rBn;
    const ySquared = (modPow(x, 3n, P) + 7n) % P;
    let y = modPow(ySquared, (P + 1n) / 4n, P); // sqrt via Tonelli (p ≡ 3 mod 4)

    // Check parity matches v
    if ((y & 1n) !== BigInt(v)) {
      y = P - y;
    }

    // Verify point is on curve
    if ((y * y % P) !== ySquared) return null;

    const R = [x, y];
    const rInv = modInv(rBn, N_EC);

    // Q = r⁻¹ * (s*R - z*G)
    const sR = pointMul(R, sBn);
    const zG = pointMul([Gx, Gy], z);
    const negZG = zG ? [zG[0], (P - zG[1]) % P] : null;
    const sum = pointAdd(sR, negZG);
    const Q = pointMul(sum, rInv);

    if (!Q) return null;

    // Encode as uncompressed: 04 || x (32 bytes) || y (32 bytes)
    const xHex = Q[0].toString(16).padStart(64, '0');
    const yHex = Q[1].toString(16).padStart(64, '0');
    return Buffer.from('04' + xHex + yHex, 'hex');
  } catch {
    return null;
  }
}

// ============= RLP Encoding =============
// ⚠️ SECURITY: RLP encoding - requires review for edge cases

/**
 * RLP-encode a value (Buffer, string, number, or array).
 */
export function rlpEncode(input) {
  if (Array.isArray(input)) {
    const encoded = Buffer.concat(input.map(rlpEncode));
    return Buffer.concat([encodeLength(encoded.length, 0xc0), encoded]);
  }
  const buf = toBuffer(input);
  if (buf.length === 1 && buf[0] < 0x80) return buf;
  return Buffer.concat([encodeLength(buf.length, 0x80), buf]);
}

function encodeLength(len, offset) {
  if (len < 56) return Buffer.from([offset + len]);
  const hexLen = len.toString(16);
  const lenBytes = Buffer.from(hexLen.padStart(hexLen.length + (hexLen.length % 2), '0'), 'hex');
  return Buffer.concat([Buffer.from([offset + 55 + lenBytes.length]), lenBytes]);
}

export function toBuffer(v) {
  if (Buffer.isBuffer(v)) return v;
  if (typeof v === 'string') {
    if (v.startsWith('0x')) {
      const hex = v.slice(2);
      if (hex.length === 0) return Buffer.alloc(0);
      return Buffer.from(hex.padStart(hex.length + (hex.length % 2), '0'), 'hex');
    }
    return Buffer.from(v);
  }
  if (typeof v === 'number' || typeof v === 'bigint') {
    if (v === 0 || v === 0n) return Buffer.alloc(0);
    const hex = BigInt(v).toString(16);
    return Buffer.from(hex.padStart(hex.length + (hex.length % 2), '0'), 'hex');
  }
  return Buffer.alloc(0);
}

/**
 * Convert a value to 0x hex string. Handles decimal strings, hex strings, and numbers.
 */
function toHex(val) {
  if (val === undefined || val === null || val === '' || val === '0' || val === 0) return '0x0';
  if (typeof val === 'string' && val.startsWith('0x')) return val;
  // Decimal string or number → hex
  return '0x' + BigInt(val).toString(16);
}

function rlpNormalize(val) {
  if (val === undefined || val === null || val === '0x0' || val === '0x' || val === 0 || val === '0') {
    return Buffer.alloc(0);
  }
  return toBuffer(val);
}

// ============= Compact-u16 (Solana) =============

/**
 * Read a compact-u16 from a buffer (Solana transaction format).
 */
export function readCompactU16(buf, offset) {
  let value = 0;
  let size = 0;
  for (let i = 0; i < 3; i++) {
    const byte = buf[offset + i];
    value |= (byte & 0x7f) << (7 * i);
    size++;
    if ((byte & 0x80) === 0) break;
  }
  return { value, size };
}

// ============= Chain Utilities =============

/**
 * Resolve chain name to config.
 */
export function resolveChain(chainName) {
  const chain = CHAIN_MAP[chainName?.toLowerCase()];
  if (!chain) {
    throw new Error(`Unsupported chain "${chainName}". Supported: ${Object.keys(CHAIN_MAP).join(', ')}`);
  }
  return chain;
}

/**
 * Get wallet chain type for address lookup.
 */
export function getWalletChainType(chainName) {
  return resolveChain(chainName).type;
}

// ============= CLI Helpers =============

async function promptPassword(prompt, deps = {}) {
  if (deps.promptFn) return deps.promptFn(prompt);
  const readline = await import('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    process.stderr.write(prompt);
    let input = '';
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    if (stdin.setRawMode) stdin.setRawMode(true);
    stdin.resume();
    const onData = (ch) => {
      const c = ch.toString();
      if (c === '\n' || c === '\r') {
        if (stdin.setRawMode) stdin.setRawMode(wasRaw || false);
        stdin.removeListener('data', onData);
        process.stderr.write('\n');
        rl.close();
        resolve(input);
      } else if (c === '\u0003') { rl.close(); process.exit(1); }
      else if (c === '\u007f' || c === '\b') { input = input.slice(0, -1); }
      else { input += c; }
    };
    stdin.on('data', onData);
  });
}

function formatQuote(quote, index) {
  const lines = [];
  const label = index !== undefined ? `  Quote #${index + 1}` : '  Best Quote';
  lines.push(`${label} (${quote.aggregator || 'unknown'})`);
  lines.push(`    Input:        ${quote.inAmount} → ${quote.inputMint?.slice(0, 12)}...`);
  lines.push(`    Output:       ${quote.outAmount} → ${quote.outputMint?.slice(0, 12)}...`);
  if (quote.inUsdValue)  lines.push(`    In USD:       $${quote.inUsdValue}`);
  if (quote.outUsdValue) lines.push(`    Out USD:      $${quote.outUsdValue}`);
  if (quote.priceImpactPct) lines.push(`    Price Impact: ${quote.priceImpactPct}%`);
  if (quote.tradingFeeInUsd) lines.push(`    Trading Fee:  $${quote.tradingFeeInUsd}`);
  if (quote.networkFeeInUsd) lines.push(`    Network Fee:  $${quote.networkFeeInUsd}`);
  if (quote.approvalAddress) lines.push(`    ⚠ Requires token approval to: ${quote.approvalAddress}`);
  return lines.join('\n');
}

// ============= CLI Command Builder =============

/**
 * Build trading command handlers for CLI integration.
 */
export function buildTradingCommands(deps = {}) {
  const { log = console.log, exit = process.exit } = deps;

  return {
    'quote': async (args, apiInstance, flags, options) => {
      const chain = options.chain || args[0];
      const from = options.from || options['from-token'] || args[1];
      const to = options.to || options['to-token'] || args[2];
      const amount = options.amount || args[3];
      const walletName = options.wallet;
      const slippage = options.slippage;
      const autoSlippage = flags['auto-slippage'] || flags.autoSlippage;
      const maxAutoSlippage = options['max-auto-slippage'];
      const swapMode = options['swap-mode'] || 'exactIn';

      if (!chain || !from || !to || !amount) {
        log(`
Usage: nansen quote --chain <chain> --from <token> --to <token> --amount <baseUnits>

OPTIONS:
  --chain <chain>           Chain: solana, ethereum, base, bsc
  --from <address>          Input token address
  --to <address>            Output token address
  --amount <units>          Amount in BASE UNITS (e.g. lamports, wei)
  --wallet <name>           Wallet name (default: default wallet)
  --slippage <pct>          Slippage as decimal (e.g. 0.03 for 3%). Default: 0.03
  --auto-slippage           Enable auto slippage calculation
  --max-auto-slippage <pct> Max auto slippage when auto-slippage enabled
  --swap-mode <mode>        exactIn (default) or exactOut

EXAMPLES:
  nansen quote --chain solana --from So11111111111111111111111111111111111111112 --to EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --amount 1000000000
  nansen quote --chain base --from 0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee --to 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 --amount 1000000000000000000
`);
        exit(1);
        return;
      }

      try {
        const chainConfig = resolveChain(chain);
        const chainType = chainConfig.type === 'evm' ? 'evm' : 'solana';

        let walletAddress;
        if (walletName) {
          const wallet = showWallet(walletName);
          walletAddress = chainType === 'solana' ? wallet.solana : wallet.evm;
        } else {
          walletAddress = getDefaultAddress(chainType);
        }

        if (!walletAddress) {
          log('❌ No wallet found. Create one with: nansen wallet create');
          exit(1);
          return;
        }

        log(`\nFetching quote on ${chainConfig.name}...`);
        log(`  Wallet: ${walletAddress}`);

        const params = {
          chainIndex: chainConfig.index,
          fromTokenAddress: from,
          toTokenAddress: to,
          amount,
          userWalletAddress: walletAddress,
        };
        if (slippage) params.slippagePercent = slippage;
        if (autoSlippage) params.autoSlippage = true;
        if (maxAutoSlippage) params.maxAutoSlippagePercent = maxAutoSlippage;
        if (swapMode !== 'exactIn') params.swapMode = swapMode;

        const response = await getQuote(params);

        if (!response.success || !response.quotes?.length) {
          log('❌ No quotes available');
          if (response.warnings?.length) {
            response.warnings.forEach(w => log(`  ⚠ ${w}`));
          }
          exit(1);
          return;
        }

        log('');
        response.quotes.forEach((q, i) => log(formatQuote(q, i)));

        const quoteId = saveQuote(response, chain);
        log(`\n  Quote ID: ${quoteId}`);
        log(`  Execute:  nansen execute --quote ${quoteId}`);

        if (response.quotes[0]?.approvalAddress) {
          log(`\n  ⚠ This token swap requires an ERC-20 approval step.`);
          log(`    The execute command will handle this automatically.`);
        }

        log('');
        return undefined; // Output already printed above

      } catch (err) {
        log(`❌ ${err.message}`);
        if (err.details) log(`  Details: ${JSON.stringify(err.details)}`);
        exit(1);
      }
    },

    'execute': async (args, apiInstance, flags, options) => {
      const quoteId = options.quote || options['quote-id'] || args[0];
      const walletName = options.wallet;
      const noSimulate = flags['no-simulate'] || flags.noSimulate;

      if (!quoteId) {
        log(`
Usage: nansen execute --quote <quoteId> [options]

OPTIONS:
  --quote <id>              Quote ID from 'nansen quote'
  --wallet <name>           Wallet name (default: default wallet)
  --no-simulate             Skip pre-broadcast simulation

EXAMPLES:
  nansen execute --quote 1708900000000-abc123
`);
        exit(1);
        return;
      }

      try {
        const quoteData = loadQuote(quoteId);
        const chain = quoteData.chain;
        const chainConfig = resolveChain(chain);
        const chainType = chainConfig.type;

        const bestQuote = quoteData.response.quotes?.[0];
        if (!bestQuote) {
          log('❌ No quote data found');
          exit(1);
          return;
        }

        // Verify transaction data exists
        if (!bestQuote.transaction) {
          log('❌ Quote does not contain transaction data.');
          log('  Ensure userWalletAddress was provided when fetching the quote.');
          exit(1);
          return;
        }

        log(`\nExecuting trade on ${chainConfig.name}...`);
        log(formatQuote(bestQuote));
        log('');

        // Get wallet credentials
        const password = process.env.NANSEN_WALLET_PASSWORD || await promptPassword('Enter wallet password: ', deps);

        let effectiveWalletName = walletName;
        if (!effectiveWalletName) {
          const list = listWallets();
          effectiveWalletName = list.defaultWallet;
        }
        if (!effectiveWalletName) {
          log('❌ No wallet found. Create one with: nansen wallet create');
          exit(1);
          return;
        }

        const exported = exportWallet(effectiveWalletName, password);

        let signedTransaction;
        let requestId;

        if (chainType === 'solana') {
          // Solana: quote.transaction is base64 serialized VersionedTransaction
          log('  Signing Solana transaction...');
          signedTransaction = signSolanaTransaction(bestQuote.transaction, exported.solana.privateKey);
          requestId = bestQuote.metadata?.requestId;

        } else {
          // EVM: quote.transaction is { to, data, value, gas, gasPrice }
          const walletAddress = exported.evm.address;

          // Handle approval if needed (OKX may require approval even for native tokens)
          if (bestQuote.approvalAddress) {
            log(`  ⚠ Approval required → ${bestQuote.approvalAddress}`);
            log(`  Sending approval tx...`);
            const approvalNonce = await getEvmNonce(chain, walletAddress);

            // Use the same gasPrice as the swap tx for the approval
            const approvalGasPrice = bestQuote.transaction?.gasPrice || bestQuote.transaction?.maxFeePerGas || '1000000';
            const approvalTxHex = buildApprovalTransaction(
              bestQuote.inputMint,
              bestQuote.approvalAddress,
              exported.evm.privateKey,
              chain,
              approvalNonce,
              approvalGasPrice,
            );

            const approvalResult = await executeTransaction({
              signedTransaction: approvalTxHex,
              chain,
              simulate: !noSimulate,
            });

            if (approvalResult.status !== 'Success') {
              log(`  ❌ Approval transaction failed: ${approvalResult.error || 'unknown error'}`);
              exit(1);
              return;
            }

            // Wait for approval to be confirmed on-chain before proceeding
            log(`  Waiting for approval confirmation...`);
            try {
              const receipt = await waitForReceipt(chain, approvalResult.txHash);
              log(`  ✓ Approval confirmed in block ${parseInt(receipt.blockNumber, 16)}: ${approvalResult.txHash}`);
            } catch (receiptErr) {
              log(`  ❌ Approval may not have confirmed: ${receiptErr.message}`);
              exit(1);
              return;
            }
            log('');
          }

          log('  Fetching nonce...');
          const nonce = await getEvmNonce(chain, walletAddress);
          log(`  Nonce: ${nonce}`);

          log('  Signing EVM transaction...');
          signedTransaction = signEvmTransaction(
            bestQuote.transaction,
            exported.evm.privateKey,
            chain,
            nonce
          );
        }

        log('  Broadcasting...');
        const execParams = {
          signedTransaction,
          chain,
          simulate: !noSimulate,
        };
        if (requestId) execParams.requestId = requestId;

        const result = await executeTransaction(execParams);

        if (result.status === 'Success') {
          const txId = result.signature || result.txHash;
          const explorerUrl = chainConfig.explorer + txId;

          log(`\n  ✓ Transaction successful!`);
          log(`    Status:      ${result.status}`);
          log(`    ${result.signature ? 'Signature' : 'Tx Hash'}:   ${txId}`);
          log(`    Chain:       ${chainConfig.name} (${result.chainType})`);
          log(`    Broadcaster: ${result.broadcaster}`);
          log(`    Explorer:    ${explorerUrl}`);

          if (result.swapEvents?.length) {
            log(`    Swaps:`);
            result.swapEvents.forEach(e => {
              log(`      ${e.inputAmount} ${e.inputMint?.slice(0, 8)}... → ${e.outputAmount} ${e.outputMint?.slice(0, 8)}...`);
            });
          }
        } else {
          log(`\n  ✗ Transaction failed`);
          log(`    Status: ${result.status}`);
          if (result.error) log(`    Error:  ${result.error}`);
        }
        log('');
        return undefined; // Output already printed above

      } catch (err) {
        log(`❌ ${err.message}`);
        if (err.details) log(`  Details: ${JSON.stringify(err.details)}`);
        exit(1);
      }
    },
  };
}
