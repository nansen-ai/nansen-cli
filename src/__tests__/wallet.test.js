/**
 * Tests for wallet module
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
    // Known keccak256 of empty string
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

describe('wallet CRUD', () => {
  const PASSWORD = 'test-password-123';

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

  it('should reject duplicate wallet names', () => {
    createWallet('dupe', PASSWORD);
    expect(() => createWallet('dupe', PASSWORD)).toThrow('already exists');
  });

  it('should reject wrong password on create (second wallet)', () => {
    createWallet('first-wallet', PASSWORD);
    expect(() => createWallet('second-wallet', 'wrong-password')).toThrow('Incorrect password');
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
