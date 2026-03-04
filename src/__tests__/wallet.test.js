/**
 * Tests for wallet module
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
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
  getWalletConfig,
  checkWallets,
  buildWalletCommands,
} from '../wallet.js';
import { keccak256 } from '../crypto.js';

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
    createWallet('w2', PASSWORD, { force: true });
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
    createWallet('second', PASSWORD, { force: true });
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
    expect(() => createWallet('dupe', PASSWORD, { force: true })).toThrow('already exists');
  });

  it('should reject wrong password on create (second wallet)', () => {
    createWallet('first-wallet', PASSWORD);
    expect(() => createWallet('second-wallet', 'wrong-password', { force: true })).toThrow('Incorrect password');
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
    createWallet('b', PASSWORD, { force: true });
    setDefaultWallet('a');
    deleteWallet('a', PASSWORD);
    const list = listWallets();
    expect(list.defaultWallet).toBe('b');
  });
});

describe('passwordless encryption', () => {
  it('encryptKey with null password returns plaintext wrapper', () => {
    const key = 'a'.repeat(64);
    const result = encryptKey(key, null);
    expect(result).toEqual({ data: key, encrypted: false });
  });

  it('decryptKey with unencrypted blob returns data', () => {
    const key = 'b'.repeat(64);
    const blob = { data: key, encrypted: false };
    expect(decryptKey(blob, null)).toBe(key);
    // Password is ignored for unencrypted blobs
    expect(decryptKey(blob, 'any-password')).toBe(key);
  });

  it('decryptKey throws on encrypted blob with null password', () => {
    const key = 'c'.repeat(64);
    const encrypted = encryptKey(key, 'test-password-123');
    expect(() => decryptKey(encrypted, null)).toThrow('Wallet is encrypted');
  });

  it('decryptKey throws on tampered unencrypted blob (has encryption fields)', () => {
    const blob = { data: 'x'.repeat(64), encrypted: false, salt: 'deadbeef' };
    expect(() => decryptKey(blob, null)).toThrow('corrupted or tampered');
  });

  it('decryptKey throws on encrypted blob missing required fields', () => {
    const blob = { salt: 'deadbeef' };
    expect(() => decryptKey(blob, 'some-password')).toThrow('corrupted or tampered');
  });
});

const UNSAFE_OPTS = { unsafeNoPassword: true, iUnderstandThisIsUnsafe: true };

describe('passwordless wallet CRUD', () => {
  it('should create, export, and delete a passwordless wallet', () => {
    const result = createWallet('nopass', null, UNSAFE_OPTS);
    expect(result.name).toBe('nopass');
    expect(result.evm).toMatch(/^0x/);
    expect(result.solana).toBeTruthy();

    // Config should have no passwordHash
    const config = getWalletConfig();
    expect(config.passwordHash).toBeNull();

    // Export without password
    const exported = exportWallet('nopass', null);
    expect(exported.evm.privateKey).toHaveLength(64);
    expect(exported.solana.privateKey).toHaveLength(128);

    // Delete without password
    const deleted = deleteWallet('nopass', null);
    expect(deleted.deleted).toBe('nopass');
  });

  it('should reject mixing encrypted/passwordless when passwordHash exists', () => {
    createWallet('encrypted-first', 'test-password-123!!');
    expect(() => createWallet('nopass-second', null, { force: true, ...UNSAFE_OPTS })).toThrow(
      'Existing wallets are password-protected'
    );
  });

  it('should allow multiple passwordless wallets', () => {
    createWallet('a', null, UNSAFE_OPTS);
    createWallet('b', null, { force: true, ...UNSAFE_OPTS });
    const list = listWallets();
    expect(list.wallets).toHaveLength(2);
  });

  it('should reject encrypted wallet when passwordless wallets exist', () => {
    createWallet('nopass-first', null, UNSAFE_OPTS);
    expect(() => createWallet('encrypted-second', 'test-password-123!!', { force: true })).toThrow(
      'Existing wallets are passwordless'
    );
  });
});

describe('prerequisites check (--force)', () => {
  const PASSWORD = 'test-password-123!!';

  it('first create succeeds without --force', () => {
    const result = createWallet('first', PASSWORD);
    expect(result.name).toBe('first');
  });

  it('second create without --force throws WALLETS_EXIST', () => {
    createWallet('first', PASSWORD);
    const err = (() => {
      try { createWallet('second', PASSWORD); }
      catch (e) { return e; }
    })();
    expect(err).toBeTruthy();
    expect(err.code).toBe('WALLETS_EXIST');
    expect(err.structured.walletCount).toBe(1);
  });

  it('second create with --force succeeds', () => {
    createWallet('first', PASSWORD);
    const result = createWallet('second', PASSWORD, { force: true });
    expect(result.name).toBe('second');
  });
});

describe('--unsafe-no-password gate', () => {
  it('--unsafe-no-password alone throws UNSAFE_CONFIRMATION_REQUIRED', () => {
    const err = (() => {
      try { createWallet('wallet', null, { unsafeNoPassword: true }); }
      catch (e) { return e; }
    })();
    expect(err).toBeTruthy();
    expect(err.code).toBe('UNSAFE_CONFIRMATION_REQUIRED');
  });

  it('--unsafe-no-password with --i-understand-this-is-unsafe proceeds', () => {
    const result = createWallet('wallet', null, { unsafeNoPassword: true, iUnderstandThisIsUnsafe: true });
    expect(result.name).toBe('wallet');
  });
});

describe('null password without --unsafe-no-password (Fix A)', () => {
  it('throws PASSWORD_REQUIRED when password is null and unsafeNoPassword is not set', () => {
    const err = (() => {
      try { createWallet('null-pw', null, {}); }
      catch (e) { return e; }
    })();
    expect(err).toBeTruthy();
    expect(err.code).toBe('PASSWORD_REQUIRED');
  });

  it('throws PASSWORD_REQUIRED when password is undefined', () => {
    const err = (() => {
      try { createWallet('undef-pw', undefined, {}); }
      catch (e) { return e; }
    })();
    expect(err).toBeTruthy();
    expect(err.code).toBe('PASSWORD_REQUIRED');
  });
});

describe('post-creation permission check', () => {
  it('throws INSECURE_PERMISSIONS and cleans up wallet file when perms are bad', () => {
    const originalStatSync = fs.statSync;
    let walletStatCalled = false;
    const spy = vi.spyOn(fs, 'statSync').mockImplementation((p, ...args) => {
      const result = originalStatSync(p, ...args);
      // Simulate insecure permissions on the wallet file (not config.json)
      if (!walletStatCalled && typeof p === 'string' && p.endsWith('perm-test.json')) {
        walletStatCalled = true;
        return { ...result, mode: (result.mode & ~0o777) | 0o644 };
      }
      return result;
    });

    try {
      createWallet('perm-test', 'testpassword123!!');
      expect.fail('Should have thrown INSECURE_PERMISSIONS');
    } catch (err) {
      expect(err.code).toBe('INSECURE_PERMISSIONS');
      const walletFile = path.join(tempDir, '.nansen', 'wallets', 'perm-test.json');
      expect(fs.existsSync(walletFile)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('checkWallets()', () => {
  let savedPassword;

  beforeEach(() => {
    savedPassword = process.env.NANSEN_WALLET_PASSWORD;
    delete process.env.NANSEN_WALLET_PASSWORD;
  });

  afterEach(() => {
    if (savedPassword !== undefined) process.env.NANSEN_WALLET_PASSWORD = savedPassword;
    else delete process.env.NANSEN_WALLET_PASSWORD;
  });

  it('returns clean status when no wallets exist', async () => {
    const result = await checkWallets();
    expect(result).toEqual({
      encrypted: false,
      permissionsOk: true,
      passwordSource: 'none',
      walletCount: 0,
      issues: [],
    });
  });

  it('reports passwordSource: env when NANSEN_WALLET_PASSWORD is set', async () => {
    process.env.NANSEN_WALLET_PASSWORD = 'testpassword123!!';
    const result = await checkWallets();
    expect(result.passwordSource).toBe('env');
  });

  it('reports passwordSource: generated when .credentials file exists', async () => {
    const walletsDir = path.join(tempDir, '.nansen', 'wallets');
    fs.mkdirSync(walletsDir, { recursive: true });
    fs.writeFileSync(path.join(walletsDir, '.credentials'), 'NANSEN_WALLET_PASSWORD=abc\n', { mode: 0o600 });
    const result = await checkWallets();
    expect(result.passwordSource).toBe('generated');
  });

  it('reports permissionsOk: false and issues when config.json has bad perms', async () => {
    const PASSWORD = 'testpassword123!!';
    createWallet('check-test', PASSWORD);
    const configPath = path.join(tempDir, '.nansen', 'wallets', 'config.json');
    fs.chmodSync(configPath, 0o644);

    const result = await checkWallets();
    expect(result.permissionsOk).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues[0]).toContain('config.json');
  });

  it('reports permissionsOk: false and issue when .credentials has bad perms', async () => {
    const walletsDir = path.join(tempDir, '.nansen', 'wallets');
    fs.mkdirSync(walletsDir, { recursive: true });
    const credPath = path.join(walletsDir, '.credentials');
    fs.writeFileSync(credPath, 'NANSEN_WALLET_PASSWORD=abc\n', { mode: 0o644 }); // world-readable
    const result = await checkWallets();
    expect(result.permissionsOk).toBe(false);
    expect(result.issues.some(i => i.includes('.credentials'))).toBe(true);
    expect(result.issues.some(i => i.includes('0600'))).toBe(true);
  });

  it('reports walletCount correctly', async () => {
    const PASSWORD = 'testpassword123!!';
    createWallet('w1', PASSWORD);
    createWallet('w2', PASSWORD, { force: true });
    const result = await checkWallets();
    expect(result.walletCount).toBe(2);
  });

  it('reports encrypted: true when wallets have a password hash', async () => {
    createWallet('enc-wallet', 'testpassword123!!');
    const result = await checkWallets();
    expect(result.encrypted).toBe(true);
  });

  it('reports issue when config.json exists but is malformed', async () => {
    const configPath = path.join(tempDir, '.nansen', 'wallets', 'config.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, 'not valid json', { mode: 0o600 });
    const result = await checkWallets();
    expect(result.issues.some(i => i.includes('could not be parsed'))).toBe(true);
  });
});

describe('CLI create handler: password auto-generation', () => {
  let savedPassword;

  beforeEach(() => {
    savedPassword = process.env.NANSEN_WALLET_PASSWORD;
    delete process.env.NANSEN_WALLET_PASSWORD;
  });

  afterEach(() => {
    if (savedPassword !== undefined) process.env.NANSEN_WALLET_PASSWORD = savedPassword;
    else delete process.env.NANSEN_WALLET_PASSWORD;
  });

  it('--force with existing encrypted wallets reads .credentials, does not overwrite it', async () => {
    // Create first wallet, which auto-generates .credentials
    const logs1 = [];
    const cmds = buildWalletCommands({ log: (m) => logs1.push(m), isTTY: false });
    await cmds.wallet(['create'], null, {}, { name: 'first' });

    const credPath = path.join(tempDir, '.nansen', 'wallets', '.credentials');
    const credContentBefore = fs.readFileSync(credPath, 'utf8');

    // Create second wallet with --force; should reuse existing password from .credentials
    const logs2 = [];
    let exitCode = 0;
    const cmds2 = buildWalletCommands({
      log: (m) => logs2.push(m),
      isTTY: false,
      exit: (code) => { exitCode = code; },
    });
    await cmds2.wallet(['create'], null, { force: true }, { name: 'second' });

    expect(exitCode).toBe(0);
    const output = JSON.parse(logs2[0]);
    expect(output.success).toBe(true);
    expect(output.name).toBe('second');
    // .credentials must not be overwritten
    expect(fs.readFileSync(credPath, 'utf8')).toBe(credContentBefore);
  });

  it('--force with existing encrypted wallets and no .credentials fails with PASSWORD_REQUIRED', async () => {
    // Create first wallet with env var (no .credentials generated)
    process.env.NANSEN_WALLET_PASSWORD = 'testpassword123!!';
    createWallet('first', 'testpassword123!!');
    delete process.env.NANSEN_WALLET_PASSWORD;

    const logs = [];
    let exitCode = 0;
    const cmds = buildWalletCommands({
      log: (m) => logs.push(m),
      isTTY: false,
      exit: (code) => { exitCode = code; },
    });
    await cmds.wallet(['create'], null, { force: true }, { name: 'second' });

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(logs[0]);
    expect(parsed.success).toBe(false);
    expect(parsed.code).toBe('PASSWORD_REQUIRED');
  });

  it('auto-generates .credentials when no TTY and no env var', async () => {
    const logs = [];
    const cmds = buildWalletCommands({ log: (m) => logs.push(m), isTTY: false });
    await cmds.wallet(['create'], null, {}, { name: 'auto-gen' });

    const credPath = path.join(tempDir, '.nansen', 'wallets', '.credentials');
    expect(fs.existsSync(credPath)).toBe(true);
    const content = fs.readFileSync(credPath, 'utf8');
    const match = content.match(/^NANSEN_WALLET_PASSWORD=([A-Za-z0-9_-]+)\n$/);
    expect(match).toBeTruthy();
    expect(match[1].length).toBeGreaterThanOrEqual(30);
    const stat = fs.statSync(credPath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('outputs JSON when no TTY (auto json mode)', async () => {
    const logs = [];
    const cmds = buildWalletCommands({ log: (m) => logs.push(m), isTTY: false });
    await cmds.wallet(['create'], null, {}, { name: 'json-auto' });

    expect(logs.length).toBeGreaterThanOrEqual(1);
    const output = JSON.parse(logs[0]);
    expect(output.success).toBe(true);
    expect(output.name).toBe('json-auto');
    expect(output.addresses.evm).toMatch(/^0x/);
    expect(output.addresses.solana).toBeTruthy();
    expect(output.passwordSource).toBe('generated');
    expect(output.credentialsFile).toBeTruthy();
  });

  it('outputs JSON when --json flag is set with promptFn', async () => {
    const logs = [];
    const cmds = buildWalletCommands({
      log: (m) => logs.push(m),
      promptFn: () => Promise.resolve('testpassword123!!'),
      isTTY: true,
    });
    await cmds.wallet(['create'], null, { json: true }, { name: 'json-flag' });

    expect(logs.length).toBeGreaterThanOrEqual(1);
    const output = JSON.parse(logs[0]);
    expect(output.success).toBe(true);
    expect(output.name).toBe('json-flag');
    expect(output.passwordSource).toBe('prompt');
    expect(output.credentialsFile).toBeNull();
  });
});

describe('CLI handler: no-TTY hard fail for export/delete', () => {
  const PASSWORD = 'testpassword123!!';
  let savedPassword;

  beforeEach(() => {
    savedPassword = process.env.NANSEN_WALLET_PASSWORD;
    delete process.env.NANSEN_WALLET_PASSWORD;
    createWallet('secure-wallet', PASSWORD);
  });

  afterEach(() => {
    if (savedPassword !== undefined) process.env.NANSEN_WALLET_PASSWORD = savedPassword;
    else delete process.env.NANSEN_WALLET_PASSWORD;
  });

  it('export fails with structured JSON PASSWORD_REQUIRED when no TTY and no env var', async () => {
    const logs = [];
    let exitCode;
    const cmds = buildWalletCommands({
      log: (m) => logs.push(m),
      isTTY: false,
      exit: (code) => { exitCode = code; },
    });
    await cmds.wallet(['export'], null, {}, { name: 'secure-wallet' });
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(logs[0]);
    expect(parsed.success).toBe(false);
    expect(parsed.code).toBe('PASSWORD_REQUIRED');
    expect(parsed.error).toContain('export');
  });

  it('delete fails with structured JSON PASSWORD_REQUIRED when no TTY and no env var', async () => {
    const logs = [];
    let exitCode;
    const cmds = buildWalletCommands({
      log: (m) => logs.push(m),
      isTTY: false,
      exit: (code) => { exitCode = code; },
    });
    await cmds.wallet(['delete'], null, {}, { name: 'secure-wallet' });
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(logs[0]);
    expect(parsed.success).toBe(false);
    expect(parsed.code).toBe('PASSWORD_REQUIRED');
    expect(parsed.error).toContain('delete');
  });

  it('export succeeds when NANSEN_WALLET_PASSWORD is set', async () => {
    process.env.NANSEN_WALLET_PASSWORD = PASSWORD;
    const logs = [];
    const cmds = buildWalletCommands({
      log: (m) => logs.push(m),
      isTTY: false,
    });
    await cmds.wallet(['export'], null, {}, { name: 'secure-wallet' });
    expect(logs.join('')).toContain('Private keys');
  });
});

describe('CLI check subcommand', () => {
  let savedPassword;

  beforeEach(() => {
    savedPassword = process.env.NANSEN_WALLET_PASSWORD;
    delete process.env.NANSEN_WALLET_PASSWORD;
  });

  afterEach(() => {
    if (savedPassword !== undefined) process.env.NANSEN_WALLET_PASSWORD = savedPassword;
    else delete process.env.NANSEN_WALLET_PASSWORD;
  });

  it('outputs JSON status and exits 0 when no issues', async () => {
    const logs = [];
    let exitCode = 0;
    const cmds = buildWalletCommands({
      log: (m) => logs.push(m),
      isTTY: false,
      exit: (code) => { exitCode = code; },
    });
    await cmds.wallet(['check'], null, {}, {});

    expect(exitCode).toBe(0);
    const result = JSON.parse(logs[0]);
    expect(result.walletCount).toBe(0);
    expect(result.issues).toHaveLength(0);
  });

  it('exits 1 and reports issues when permissions are bad', async () => {
    createWallet('check-cmd', 'testpassword123!!');
    const configPath = path.join(tempDir, '.nansen', 'wallets', 'config.json');
    fs.chmodSync(configPath, 0o644);

    const logs = [];
    let exitCode = 0;
    const cmds = buildWalletCommands({
      log: (m) => logs.push(m),
      isTTY: false,
      exit: (code) => { exitCode = code; },
    });
    await cmds.wallet(['check'], null, {}, {});

    expect(exitCode).toBe(1);
    const result = JSON.parse(logs[0]);
    expect(result.issues.length).toBeGreaterThan(0);
  });
});

describe('CLI create --unsafe-no-password flag forwarding (Bug 1)', () => {
  it('emits UNSAFE_CONFIRMATION_REQUIRED via CLI when --unsafe-no-password given without --i-understand-this-is-unsafe', async () => {
    const logs = [];
    let exitCode = 0;
    const cmds = buildWalletCommands({
      log: (m) => logs.push(m),
      isTTY: false,
      exit: (code) => { exitCode = code; },
    });
    await cmds.wallet(['create'], null, { 'unsafe-no-password': true }, { name: 'unsafe-test' });
    expect(exitCode).toBe(1);
    const output = JSON.parse(logs[0]);
    expect(output.code).toBe('UNSAFE_CONFIRMATION_REQUIRED');
  });

  it('creates passwordless wallet when both --unsafe-no-password and --i-understand-this-is-unsafe are given', async () => {
    const logs = [];
    let exitCode = 0;
    const cmds = buildWalletCommands({
      log: (m) => logs.push(m),
      isTTY: false,
      exit: (code) => { exitCode = code; },
    });
    await cmds.wallet(
      ['create'],
      null,
      { 'unsafe-no-password': true, 'i-understand-this-is-unsafe': true },
      { name: 'unsafe-ok' },
    );
    expect(exitCode).toBe(0);
    const output = JSON.parse(logs[0]);
    expect(output.success).toBe(true);
    expect(output.name).toBe('unsafe-ok');
    expect(output.passwordSource).toBe('none');
  });
});

describe('INSECURE_PERMISSIONS config.json rollback (Bug 2)', () => {
  it('deletes config.json on first-wallet creation when perms are bad', () => {
    const walletsDir = path.join(tempDir, '.nansen', 'wallets');
    const configPath = path.join(walletsDir, 'config.json');

    const originalStatSync = fs.statSync;
    const spy = vi.spyOn(fs, 'statSync').mockImplementation((p, ...args) => {
      const result = originalStatSync(p, ...args);
      if (typeof p === 'string' && p.endsWith('rollback-first.json')) {
        return { ...result, mode: (result.mode & ~0o777) | 0o644 };
      }
      return result;
    });

    try {
      createWallet('rollback-first', 'testpassword123!!');
      expect.fail('Should have thrown INSECURE_PERMISSIONS');
    } catch (err) {
      expect(err.code).toBe('INSECURE_PERMISSIONS');
      expect(fs.existsSync(path.join(walletsDir, 'rollback-first.json'))).toBe(false);
      expect(fs.existsSync(configPath)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('restores config.json to pre-call state on --force creation when perms are bad', () => {
    // Create the first wallet successfully
    createWallet('original-wallet', 'testpassword123!!');
    const configPath = path.join(tempDir, '.nansen', 'wallets', 'config.json');
    const configBefore = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    const originalStatSync = fs.statSync;
    const spy = vi.spyOn(fs, 'statSync').mockImplementation((p, ...args) => {
      const result = originalStatSync(p, ...args);
      if (typeof p === 'string' && p.endsWith('rollback-force.json')) {
        return { ...result, mode: (result.mode & ~0o777) | 0o644 };
      }
      return result;
    });

    try {
      createWallet('rollback-force', 'testpassword123!!', { force: true });
      expect.fail('Should have thrown INSECURE_PERMISSIONS');
    } catch (err) {
      expect(err.code).toBe('INSECURE_PERMISSIONS');
      expect(fs.existsSync(path.join(tempDir, '.nansen', 'wallets', 'rollback-force.json'))).toBe(false);
      // config.json must still exist and be restored to original state
      expect(fs.existsSync(configPath)).toBe(true);
      const configAfter = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      expect(configAfter).toEqual(configBefore);
    } finally {
      spy.mockRestore();
    }
  });
});
