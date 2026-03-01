/**
 * Tests for x402 Solana payment module
 */

import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import {
  base58Decode,
  base58Encode,
  encodeCompactU16,
  deriveATA,
  isSvmNetwork,
  getSolanaRpcUrl,
} from '../x402-svm.js';

// Inline Solana wallet generation (from wallet.js PR #26, not yet merged)
function generateSolanaWallet() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  const rawPrivate = privateKey.subarray(privateKey.length - 32);
  const rawPublic = publicKey.subarray(publicKey.length - 32);
  const keypair = Buffer.concat([rawPrivate, rawPublic]);
  return {
    privateKey: keypair.toString('hex'),
    address: base58Encode(rawPublic),
  };
}

describe('base58Decode', () => {
  it('should round-trip with base58Encode', () => {
    const original = crypto.randomBytes(32);
    const encoded = base58Encode(original);
    const decoded = base58Decode(encoded);
    expect(decoded.toString('hex')).toBe(original.toString('hex'));
  });

  it('should handle leading zeros', () => {
    const buf = Buffer.from([0, 0, 1, 2, 3]);
    const encoded = base58Encode(buf);
    const decoded = base58Decode(encoded);
    expect(decoded.toString('hex')).toBe(buf.toString('hex'));
  });

  it('should decode known Solana addresses', () => {
    // System program: all zeros, 32 bytes
    const decoded = base58Decode('11111111111111111111111111111111');
    expect(decoded.length).toBe(32);
    expect(decoded.every(b => b === 0)).toBe(true);
  });
});

describe('encodeCompactU16', () => {
  it('should encode single-byte values', () => {
    expect(encodeCompactU16(0)).toEqual(Buffer.from([0]));
    expect(encodeCompactU16(1)).toEqual(Buffer.from([1]));
    expect(encodeCompactU16(127)).toEqual(Buffer.from([127]));
  });

  it('should encode two-byte values', () => {
    const buf = encodeCompactU16(128);
    expect(buf.length).toBe(2);
    expect(buf[0] & 0x80).toBe(0x80); // High bit set on first byte
  });

  it('should encode value 256 correctly', () => {
    const buf = encodeCompactU16(256);
    expect(buf.length).toBe(2);
    // 256 = 0x100 → low 7 bits = 0, high bit set; second byte = 2
    expect(buf[0]).toBe(0x80);
    expect(buf[1]).toBe(2);
  });
});

describe('deriveATA', () => {
  it('should produce a valid base58 address', () => {
    // Use known addresses for deterministic test
    const owner = '11111111111111111111111111111111'; // System program
    const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // USDC mainnet

    const ata = deriveATA(owner, mint);
    expect(ata).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  });

  it('should produce different ATAs for different owners', () => {
    const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const wallet1 = generateSolanaWallet();
    const wallet2 = generateSolanaWallet();

    const ata1 = deriveATA(wallet1.address, mint);
    const ata2 = deriveATA(wallet2.address, mint);
    expect(ata1).not.toBe(ata2);
  });

  it('should be deterministic', () => {
    const wallet = generateSolanaWallet();
    const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

    const ata1 = deriveATA(wallet.address, mint);
    const ata2 = deriveATA(wallet.address, mint);
    expect(ata1).toBe(ata2);
  });
});

describe('isSvmNetwork', () => {
  it('should return true for Solana networks', () => {
    expect(isSvmNetwork('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp')).toBe(true);
    expect(isSvmNetwork('solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1')).toBe(true);
  });

  it('should return false for non-Solana networks', () => {
    expect(isSvmNetwork('eip155:8453')).toBe(false);
    expect(isSvmNetwork('')).toBe(false);
    expect(isSvmNetwork(null)).toBe(false);
  });
});

describe('getSolanaRpcUrl', () => {
  it('should return mainnet URL by default', () => {
    expect(getSolanaRpcUrl('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp')).toContain('mainnet');
  });

  it('should return devnet URL', () => {
    expect(getSolanaRpcUrl('solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1')).toContain('devnet');
  });
});
