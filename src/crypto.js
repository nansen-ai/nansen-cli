/**
 * Shared cryptographic primitives for EVM transaction signing.
 * Exports keccak256, secp256k1 ECDSA signing, RLP encoding.
 * Zero external dependencies — uses Node.js built-in crypto only.
 */

import crypto from "crypto";

// ============= Keccak-256 =============

// Keccak-256 (NOT SHA3-256; Ethereum uses original Keccak with 0x01 padding).
// Uses a flat 25-element state array (lanes indexed as state[x + 5*y])
// with BigInt64 arithmetic.

const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

const ROT = [
   0,  1, 62, 28, 27,
  36, 44,  6, 55, 20,
   3, 10, 43, 25, 39,
  41, 45, 15, 21,  8,
  18,  2, 61, 56, 14,
];

const M = 0xffffffffffffffffn;

function rot64(v, r) {
  return r === 0 ? v : ((v << BigInt(r)) | (v >> BigInt(64 - r))) & M;
}

function keccakF(s) {
  for (let round = 0; round < 24; round++) {
    const c0 = s[0] ^ s[5] ^ s[10] ^ s[15] ^ s[20];
    const c1 = s[1] ^ s[6] ^ s[11] ^ s[16] ^ s[21];
    const c2 = s[2] ^ s[7] ^ s[12] ^ s[17] ^ s[22];
    const c3 = s[3] ^ s[8] ^ s[13] ^ s[18] ^ s[23];
    const c4 = s[4] ^ s[9] ^ s[14] ^ s[19] ^ s[24];
    const d0 = (c4 ^ rot64(c1, 1)) & M;
    const d1 = (c0 ^ rot64(c2, 1)) & M;
    const d2 = (c1 ^ rot64(c3, 1)) & M;
    const d3 = (c2 ^ rot64(c4, 1)) & M;
    const d4 = (c3 ^ rot64(c0, 1)) & M;
    for (let y = 0; y < 25; y += 5) {
      s[y]     = (s[y]     ^ d0) & M;
      s[y + 1] = (s[y + 1] ^ d1) & M;
      s[y + 2] = (s[y + 2] ^ d2) & M;
      s[y + 3] = (s[y + 3] ^ d3) & M;
      s[y + 4] = (s[y + 4] ^ d4) & M;
    }
    const t = new Array(25);
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        const src = x + 5 * y;
        const dst = y + 5 * ((2 * x + 3 * y) % 5);
        t[dst] = rot64(s[src], ROT[src]);
      }
    }
    for (let y = 0; y < 25; y += 5) {
      const t0 = t[y], t1 = t[y+1], t2 = t[y+2], t3 = t[y+3], t4 = t[y+4];
      s[y]   = (t0 ^ ((~t1 & M) & t2)) & M;
      s[y+1] = (t1 ^ ((~t2 & M) & t3)) & M;
      s[y+2] = (t2 ^ ((~t3 & M) & t4)) & M;
      s[y+3] = (t3 ^ ((~t4 & M) & t0)) & M;
      s[y+4] = (t4 ^ ((~t0 & M) & t1)) & M;
    }
    s[0] = (s[0] ^ RC[round]) & M;
  }
}

export function keccak256(input) {
  const rate = 136;
  const s = new Array(25).fill(0n);
  const blocks = Math.max(1, Math.ceil((input.length + 1) / rate));
  const padded = Buffer.alloc(blocks * rate);
  input.copy(padded);
  padded[input.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < 17; i++) {
      s[i] ^= padded.readBigUInt64LE(off + i * 8);
    }
    keccakF(s);
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) {
    out.writeBigUInt64LE(s[i] & M, i * 8);
  }
  return out;
}

// ============= secp256k1 ECDSA =============

const P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2Fn;
const N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
const Gx = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798n;
const Gy = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8n;

function modInv(a, m) {
  let [old_r, r] = [((a % m) + m) % m, m];
  let [old_s, s] = [1n, 0n];
  while (r !== 0n) {
    const q = old_r / r;
    [old_r, r] = [r, old_r - q * r];
    [old_s, s] = [s, old_s - q * s];
  }
  return ((old_s % m) + m) % m;
}

function ptAdd(x1, y1, x2, y2) {
  if (x1 === null) return [x2, y2];
  if (x2 === null) return [x1, y1];
  if (x1 === x2 && y1 === y2) {
    const lam = (3n * x1 * x1 * modInv(2n * y1, P)) % P;
    const x3 = ((lam * lam - 2n * x1) % P + P) % P;
    return [x3, ((lam * (x1 - x3) - y1) % P + P) % P];
  }
  if (x1 === x2) return [null, null];
  const lam = (((y2 - y1) % P + P) * modInv(((x2 - x1) % P + P) % P, P)) % P;
  const x3 = ((lam * lam - x1 - x2) % P + P) % P;
  return [x3, ((lam * (x1 - x3) - y1) % P + P) % P];
}

function ptMul(k, x, y) {
  let [rx, ry] = [null, null];
  let [qx, qy] = [x, y];
  while (k > 0n) {
    if (k & 1n) [rx, ry] = ptAdd(rx, ry, qx, qy);
    [qx, qy] = ptAdd(qx, qy, qx, qy);
    k >>= 1n;
  }
  return [rx, ry];
}

function rfc6979k(privBuf, hash) {
  let v = Buffer.alloc(32, 0x01);
  let k = Buffer.alloc(32, 0x00);
  k = crypto.createHmac('sha256', k).update(Buffer.concat([v, Buffer.from([0x00]), privBuf, hash])).digest();
  v = crypto.createHmac('sha256', k).update(v).digest();
  k = crypto.createHmac('sha256', k).update(Buffer.concat([v, Buffer.from([0x01]), privBuf, hash])).digest();
  v = crypto.createHmac('sha256', k).update(v).digest();
  while (true) {
    v = crypto.createHmac('sha256', k).update(v).digest();
    const candidate = BigInt('0x' + v.toString('hex'));
    if (candidate >= 1n && candidate < N) return candidate;
    k = crypto.createHmac('sha256', k).update(Buffer.concat([v, Buffer.from([0x00])])).digest();
    v = crypto.createHmac('sha256', k).update(v).digest();
  }
}

/**
 * Sign a 32-byte hash with secp256k1 ECDSA.
 * Uses RFC 6979 deterministic k and low-S normalization (EIP-2).
 * Returns { r, s, v } where v is the recovery ID (0 or 1).
 */
export function signSecp256k1(hash, privateKey) {
  const z = BigInt('0x' + hash.toString('hex'));
  const d = BigInt('0x' + privateKey.toString('hex'));
  const k = rfc6979k(privateKey, hash);
  const [rx, ry] = ptMul(k, Gx, Gy);
  const r = rx % N;
  if (r === 0n) throw new Error('Invalid signature: r=0');
  let s = (modInv(k, N) * ((z + r * d) % N)) % N;
  if (s === 0n) throw new Error('Invalid signature: s=0');
  let v = (ry % 2n === 0n) ? 0 : 1;
  if (s > N >> 1n) { s = N - s; v ^= 1; }
  return {
    r: Buffer.from(r.toString(16).padStart(64, '0'), 'hex'),
    s: Buffer.from(s.toString(16).padStart(64, '0'), 'hex'),
    v,
  };
}

// ============= RLP Encoding =============

export function bigIntToMinBuf(n) {
  if (n === 0n) return Buffer.alloc(0);
  const hex = n.toString(16);
  return Buffer.from(hex.length % 2 ? '0' + hex : hex, 'hex');
}

export function rlpEncode(input) {
  if (Array.isArray(input)) {
    const encoded = input.map(rlpEncode);
    const payload = Buffer.concat(encoded);
    if (payload.length < 56) {
      return Buffer.concat([Buffer.from([0xc0 + payload.length]), payload]);
    }
    const lenBytes = bigIntToMinBuf(BigInt(payload.length));
    return Buffer.concat([Buffer.from([0xf7 + lenBytes.length]), lenBytes, payload]);
  }

  let data;
  if (Buffer.isBuffer(input)) {
    data = input;
  } else {
    let hex = (typeof input === 'string' ? input : '').replace(/^0x/, '');
    hex = hex.replace(/^0+/, '');
    if (hex === '' || hex.length === 0) return Buffer.from([0x80]);
    if (hex.length % 2) hex = '0' + hex;
    data = Buffer.from(hex, 'hex');
  }

  if (data.length === 0) return Buffer.from([0x80]);
  if (data.length === 1 && data[0] < 0x80) return data;
  if (data.length < 56) return Buffer.concat([Buffer.from([0x80 + data.length]), data]);
  const lenBytes = bigIntToMinBuf(BigInt(data.length));
  return Buffer.concat([Buffer.from([0xb7 + lenBytes.length]), lenBytes, data]);
}
