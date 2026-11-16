/**
 * Shared cryptographic primitives for EVM transaction signing.
 * Exports keccak256, secp256k1 ECDSA signing, RLP encoding.
 * Uses audited libraries: @noble/hashes, @noble/curves, @ethereumjs/rlp.
 */

import { keccak_256 } from "@noble/hashes/sha3.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { RLP } from "@ethereumjs/rlp";

// ============= Keccak-256 =============

export function keccak256(input) {
  const hash = keccak_256(input);
  return Buffer.from(hash);
}

// ============= EIP-55 =============

/**
 * EIP-55 mixed-case checksum form of a 20-byte hex address (with or without
 * 0x, any case). Each hex letter is uppercased when the matching nibble of
 * keccak256(lowercase hex) is 8 or more.
 */
export function toChecksumAddress(address) {
  const hex = String(address).replace(/^0x/i, '').toLowerCase();
  const hash = keccak256(Buffer.from(hex, 'utf8')).toString('hex');
  let out = '0x';
  for (let i = 0; i < hex.length; i++) {
    out += parseInt(hash[i], 16) >= 8 ? hex[i].toUpperCase() : hex[i];
  }
  return out;
}

// ============= secp256k1 ECDSA =============

/**
 * Sign a 32-byte hash with secp256k1 ECDSA.
 * Uses RFC 6979 deterministic k and low-S normalization (EIP-2).
 * Returns { r, s, v } where v is the recovery ID (0 or 1).
 */
export function signSecp256k1(hash, privateKey) {
  const sigBytes = secp256k1.sign(hash, privateKey, { prehash: false, lowS: true });
  const sig = secp256k1.Signature.fromBytes(sigBytes);
  const pubKey = secp256k1.getPublicKey(privateKey, false);
  const pubKeyHex = Buffer.from(pubKey).toString("hex");

  // Determine recovery bit by trying both values
  let v = 0;
  for (const bit of [0, 1]) {
    const recovered = sig.addRecoveryBit(bit).recoverPublicKey(hash);
    if (Buffer.from(recovered.toBytes(false)).toString("hex") === pubKeyHex) {
      v = bit;
      break;
    }
  }

  return {
    r: Buffer.from(sig.r.toString(16).padStart(64, "0"), "hex"),
    s: Buffer.from(sig.s.toString(16).padStart(64, "0"), "hex"),
    v,
  };
}

// ============= RLP Encoding =============

export function bigIntToMinBuf(n) {
  if (n === 0n) return Buffer.alloc(0);
  const hex = n.toString(16);
  return Buffer.from(hex.length % 2 ? "0" + hex : hex, "hex");
}

export function rlpEncode(input) {
  return Buffer.from(RLP.encode(toRlpInput(input)));
}

/**
 * Convert our legacy input format to what @ethereumjs/rlp expects.
 * Handles: arrays (recursive), Buffers, hex strings, empty values.
 */
function toRlpInput(input) {
  if (Array.isArray(input)) {
    return input.map(toRlpInput);
  }

  if (Buffer.isBuffer(input)) {
    return Uint8Array.from(input);
  }

  if (input instanceof Uint8Array) {
    return input;
  }

  if (typeof input === "string") {
    let hex = input.replace(/^0x/, "");
    // Strip leading zeros to match legacy behavior for hex-string values
    // (chain IDs, nonces, gas prices, etc. passed as hex strings)
    hex = hex.replace(/^0+/, "");
    if (hex === "" || hex.length === 0) return Uint8Array.from([]);
    if (hex.length % 2) hex = "0" + hex;
    return Uint8Array.from(Buffer.from(hex, "hex"));
  }

  return Uint8Array.from([]);
}
