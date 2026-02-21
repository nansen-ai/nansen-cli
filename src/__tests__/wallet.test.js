/**
 * Tests for wallet module
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  keccak256,
  base58Encode,
  encryptKey,
  decryptKey,
  generateEvmWallet,
  generateSolanaWallet,
  createWallet,
  listWallets,
  showWallet,
  exportWallet,
  setDefaultWallet,
  deleteWallet,
  verifyPassword,
} from '../wallet.js';

// Override HOME to use temp dir for tests
let originalHome;
let tempDir;

beforeEach(() => {
  originalHome = process.env.HOME;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nansen-wallet-test-'));
  process.env.HOME = tempDir;
});

afterEach(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('keccak256', () => {
  it('should hash empty input correctly', () => {
    const hash = keccak256(Buffer.alloc(0));
    expect(hash.toString('hex')).toBe(
      'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470'
    );
  });

  it('should hash "hello" correctly', () => {
    const hash = keccak256(Buffer.from('hello'));
    expect(hash.toString('hex')).toBe(
      '1c8aff950685c2ed4bc3174f3472287b56d9517b9c948127319a09a7a36deac8'
    );
  });

  // Keccak256("transfer(address,uint256)") — the ERC-20 transfer selector
  // First 4 bytes should be 0xa9059cbb (universally known in Ethereum)
  it('should produce correct ERC-20 transfer selector', () => {
    const hash = keccak256(Buffer.from('transfer(address,uint256)'));
    expect(hash.toString('hex').slice(0, 8)).toBe('a9059cbb');
  });
});

describe('base58Encode', () => {
  it('should encode simple buffer', () => {
    const encoded = base58Encode(Buffer.from([0, 0, 1]));
    expect(encoded).toBe('112');
  });

  it('should handle leading zeros', () => {
    const encoded = base58Encode(Buffer.from([0, 0, 0]));
    expect(encoded).toBe('111');
  });
});

describe('encryption', () => {
  it('should encrypt and decrypt a key', () => {
    const key = 'a'.repeat(64); // 32 bytes as hex
    const password = 'testpassword123';

    const encrypted = encryptKey(key, password);
    expect(encrypted.cipher).toBe('aes-256-gcm');
    expect(encrypted.kdf).toBe('scrypt');

    const decrypted = decryptKey(encrypted, password);
    expect(decrypted).toBe(key);
  });

  it('should fail with wrong password', () => {
    const key = 'b'.repeat(64);
    const encrypted = encryptKey(key, 'correct-password');

    expect(() => decryptKey(encrypted, 'wrong-password')).toThrow('Incorrect password');
  });
});

describe('generateEvmWallet', () => {
  it('should generate valid EVM wallet', () => {
    const wallet = generateEvmWallet();
    expect(wallet.privateKey).toHaveLength(64); // 32 bytes hex
    expect(wallet.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it('should generate unique wallets', () => {
    const w1 = generateEvmWallet();
    const w2 = generateEvmWallet();
    expect(w1.address).not.toBe(w2.address);
    expect(w1.privateKey).not.toBe(w2.privateKey);
  });

  it('should derive correct address from known private key', () => {
    // Well-known test vector (used in Ethereum docs and ethers.js tests):
    // Private key: 0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
    // Expected address: 0xFCAd0B19bB29D4674531d6f115237E16AfCE377c (checksummed)
    //
    // We can't call generateEvmWallet with a specific key, so test the
    // underlying keccak + address derivation directly:
    
    const privKey = Buffer.from('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 'hex');
    const ecdh = crypto.createECDH('secp256k1');
    ecdh.setPrivateKey(privKey);
    const pubKey = ecdh.getPublicKey(null, 'uncompressed');
    const hash = keccak256(pubKey.subarray(1));
    const addr = '0x' + hash.subarray(12).toString('hex');
    expect(addr.toLowerCase()).toBe('0xfcad0b19bb29d4674531d6f115237e16afce377c');
  });
});

describe('generateSolanaWallet', () => {
  it('should generate valid Solana wallet', () => {
    const wallet = generateSolanaWallet();
    expect(wallet.privateKey).toHaveLength(128); // 64 bytes hex (seed + pubkey)
    expect(wallet.address).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/); // base58
    expect(wallet.address.length).toBeGreaterThanOrEqual(32);
    expect(wallet.address.length).toBeLessThanOrEqual(44);
  });
});

describe('Solana keypair integrity', () => {
  it('should produce a keypair where signing with private key verifies with public key', async () => {
    
    const wallet = generateSolanaWallet();
    const keypairHex = wallet.privateKey; // 64 bytes: seed (32) + pubkey (32)
    const seed = Buffer.from(keypairHex.slice(0, 64), 'hex'); // first 32 bytes
    const pubBytes = Buffer.from(keypairHex.slice(64), 'hex'); // last 32 bytes

    // Re-derive public key from seed and verify it matches
    const keyObj = crypto.createPrivateKey({
      key: Buffer.concat([
        Buffer.from('302e020100300506032b657004220420', 'hex'), // PKCS8 Ed25519 prefix
        seed,
      ]),
      format: 'der',
      type: 'pkcs8',
    });
    const msg = Buffer.from('nansen-test-message');
    const sig = crypto.sign(null, msg, keyObj);

    const pubKeyObj = crypto.createPublicKey({
      key: Buffer.concat([
        Buffer.from('302a300506032b6570032100', 'hex'), // SPKI Ed25519 prefix
        pubBytes,
      ]),
      format: 'der',
      type: 'spki',
    });
    const valid = crypto.verify(null, msg, pubKeyObj, sig);
    expect(valid).toBe(true);
  });

  it('should produce base58 address matching the public key bytes', () => {
    const wallet = generateSolanaWallet();
    const pubBytes = Buffer.from(wallet.privateKey.slice(64), 'hex');
    const reEncoded = base58Encode(pubBytes);
    expect(reEncoded).toBe(wallet.address);
  });
});

describe('wallet CRUD', () => {
  const PASSWORD = 'test-password-123!!';

  it('should create a wallet', () => {
    const result = createWallet('my-wallet', PASSWORD);
    expect(result.name).toBe('my-wallet');
    expect(result.evm).toMatch(/^0x/);
    expect(result.solana).toBeTruthy();
    expect(result.isDefault).toBe(true);
  });

  it('should list wallets', () => {
    createWallet('w1', PASSWORD);
    createWallet('w2', PASSWORD);
    const result = listWallets();
    expect(result.wallets).toHaveLength(2);
    expect(result.defaultWallet).toBe('w1');
  });

  it('should show a wallet', () => {
    createWallet('show-test', PASSWORD);
    const result = showWallet('show-test');
    expect(result.name).toBe('show-test');
    expect(result.evm).toMatch(/^0x/);
  });

  it('should export private keys with correct password', () => {
    createWallet('export-test', PASSWORD);
    const result = exportWallet('export-test', PASSWORD);
    expect(result.evm.privateKey).toHaveLength(64);
    expect(result.solana.privateKey).toHaveLength(128);
  });

  it('should reject export with wrong password', () => {
    createWallet('export-fail', PASSWORD);
    expect(() => exportWallet('export-fail', 'wrong')).toThrow('Incorrect password');
  });

  it('should set default wallet', () => {
    createWallet('first', PASSWORD);
    createWallet('second', PASSWORD);
    const result = setDefaultWallet('second');
    expect(result.defaultWallet).toBe('second');
  });

  it('should delete a wallet', () => {
    createWallet('to-delete', PASSWORD);
    const result = deleteWallet('to-delete', PASSWORD);
    expect(result.deleted).toBe('to-delete');
    expect(listWallets().wallets).toHaveLength(0);
  });

  it('should reject path traversal in wallet names', () => {
    expect(() => createWallet('../../etc/evil', PASSWORD)).toThrow('Wallet name must be');
    expect(() => createWallet('foo/bar', PASSWORD)).toThrow('Wallet name must be');
    expect(() => createWallet('', PASSWORD)).toThrow('Wallet name must be');
    expect(() => createWallet('.hidden', PASSWORD)).toThrow('Wallet name must be');
  });

  it('should reject duplicate wallet names', () => {
    createWallet('dupe', PASSWORD);
    expect(() => createWallet('dupe', PASSWORD)).toThrow('already exists');
  });

  it('should reject wrong password on create (second wallet)', () => {
    createWallet('first-wallet', PASSWORD);
    expect(() => createWallet('second-wallet', 'wrong-password')).toThrow('Incorrect password');
  });

  it('should round-trip: create wallet, export keys, derive same addresses', async () => {
    
    const result = createWallet('roundtrip', PASSWORD);
    const exported = exportWallet('roundtrip', PASSWORD);

    // Verify EVM: private key → address
    const privKey = Buffer.from(exported.evm.privateKey, 'hex');
    const ecdh = crypto.createECDH('secp256k1');
    ecdh.setPrivateKey(privKey);
    const pubKey = ecdh.getPublicKey(null, 'uncompressed');
    
    const hash = keccak256(pubKey.subarray(1));
    const derivedAddr = '0x' + hash.subarray(12).toString('hex');
    expect(derivedAddr.toLowerCase()).toBe(result.evm.toLowerCase());

    // Verify Solana: keypair pubkey bytes → base58 address
    const solPub = Buffer.from(exported.solana.privateKey.slice(64), 'hex');
    
    expect(base58Encode(solPub)).toBe(result.solana);
  });

  it('should update default after deleting default wallet', () => {
    createWallet('a', PASSWORD);
    createWallet('b', PASSWORD);
    setDefaultWallet('a');
    deleteWallet('a', PASSWORD);
    const list = listWallets();
    expect(list.defaultWallet).toBe('b');
  });
});
