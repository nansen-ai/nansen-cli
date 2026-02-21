/**
 * Nansen CLI - Wallet Management
 * Local key generation and storage for EVM and Solana chains.
 * Zero external dependencies — uses Node.js built-in crypto only.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import * as readline from 'readline';

// ============= Constants =============

function getWalletsDir() {
  const configDir = path.join(process.env.HOME || process.env.USERPROFILE || '', '.nansen');
  return path.join(configDir, 'wallets');
}
function getWalletConfigPath() {
  return path.join(getWalletsDir(), 'config.json');
}

// Encryption parameters
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;
const SALT_LEN = 16;
const IV_LEN = 12;
const AUTH_TAG_LEN = 16;

// ============= Keccak-256 (minimal, zero-dep) =============

// Keccak-256 for EVM address derivation. Uses a flat 25-element state array
// (lanes indexed as state[x + 5*y]) with BigInt64 arithmetic.

const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

// Rotation offsets for ρ step, indexed by [x + 5*y]
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
    // θ
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

    // ρ + π (combined)
    const t = new Array(25);
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        const src = x + 5 * y;
        const dst = y + 5 * ((2 * x + 3 * y) % 5);
        t[dst] = rot64(s[src], ROT[src]);
      }
    }

    // χ
    for (let y = 0; y < 25; y += 5) {
      const t0 = t[y], t1 = t[y+1], t2 = t[y+2], t3 = t[y+3], t4 = t[y+4];
      s[y]   = (t0 ^ ((~t1 & M) & t2)) & M;
      s[y+1] = (t1 ^ ((~t2 & M) & t3)) & M;
      s[y+2] = (t2 ^ ((~t3 & M) & t4)) & M;
      s[y+3] = (t3 ^ ((~t4 & M) & t0)) & M;
      s[y+4] = (t4 ^ ((~t0 & M) & t1)) & M;
    }

    // ι
    s[0] = (s[0] ^ RC[round]) & M;
  }
}

/**
 * Keccak-256 hash (NOT SHA3-256; Ethereum uses original Keccak with 0x01 padding).
 * @param {Buffer} input
 * @returns {Buffer} 32-byte hash
 */
export function keccak256(input) {
  const rate = 136;
  const s = new Array(25).fill(0n);

  // Pad: input || 0x01 || 0x00…0x00 || 0x80  (to fill a rate-sized block)
  const blocks = Math.max(1, Math.ceil((input.length + 1) / rate));
  const padded = Buffer.alloc(blocks * rate);
  input.copy(padded);
  padded[input.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;

  // Absorb
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < 17; i++) { // 17 lanes × 8 bytes = 136 = rate
      s[i] ^= padded.readBigUInt64LE(off + i * 8);
    }
    keccakF(s);
  }

  // Squeeze 32 bytes
  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) {
    out.writeBigUInt64LE(s[i] & M, i * 8);
  }
  return out;
}

// ============= Base58 Encoding (for Solana) =============

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/**
 * Encode a Buffer to base58 string.
 */
export function base58Encode(buf) {
  let num = 0n;
  for (const byte of buf) {
    num = num * 256n + BigInt(byte);
  }

  let str = '';
  while (num > 0n) {
    const rem = Number(num % 58n);
    num = num / 58n;
    str = BASE58_ALPHABET[rem] + str;
  }

  // Leading zeros → leading '1's
  for (const byte of buf) {
    if (byte === 0) str = '1' + str;
    else break;
  }

  return str || '1';
}

// ============= Encryption =============

/**
 * Derive encryption key from password using scrypt.
 */
function deriveKey(password, salt) {
  return crypto.scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
}

/**
 * Encrypt a private key with a password.
 * Returns a JSON-serializable object with all params needed for decryption.
 */
export function encryptKey(privateKeyHex, password) {
  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const key = deriveKey(password, salt);

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(privateKeyHex, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    cipher: 'aes-256-gcm',
    kdf: 'scrypt',
    kdfParams: { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P },
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
    ciphertext: encrypted.toString('hex'),
  };
}

/**
 * Decrypt a private key with a password.
 * @returns {string} Private key hex string
 * @throws {Error} If password is wrong
 */
export function decryptKey(encryptedData, password) {
  const salt = Buffer.from(encryptedData.salt, 'hex');
  const iv = Buffer.from(encryptedData.iv, 'hex');
  const authTag = Buffer.from(encryptedData.authTag, 'hex');
  const ciphertext = Buffer.from(encryptedData.ciphertext, 'hex');
  const key = deriveKey(password, salt);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  try {
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    throw new Error('Incorrect password');
  }
}

// ============= Key Generation =============

/**
 * Generate an EVM wallet (secp256k1).
 * Returns { privateKey, address } where address is checksummed.
 */
export function generateEvmWallet() {
  // Generate a random 32-byte private key
  const privateKey = crypto.randomBytes(32);

  // Derive public key (uncompressed, 65 bytes: 0x04 + x + y)
  const ecdh = crypto.createECDH('secp256k1');
  ecdh.setPrivateKey(privateKey);
  const publicKey = ecdh.getPublicKey(null, 'uncompressed');

  // Address = last 20 bytes of keccak256(publicKey without 0x04 prefix)
  const hash = keccak256(publicKey.subarray(1));
  const addressBytes = hash.subarray(12);
  const addressHex = addressBytes.toString('hex');

  // EIP-55 checksum
  const addressHash = keccak256(Buffer.from(addressHex, 'utf8')).toString('hex');
  let checksummed = '0x';
  for (let i = 0; i < 40; i++) {
    checksummed += parseInt(addressHash[i], 16) >= 8
      ? addressHex[i].toUpperCase()
      : addressHex[i];
  }

  return {
    privateKey: privateKey.toString('hex'),
    address: checksummed,
  };
}

/**
 * Generate a Solana wallet (Ed25519).
 * Returns { privateKey, address } where address is base58 public key.
 */
export function generateSolanaWallet() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });

  // Extract raw 32-byte keys from DER encoding
  // PKCS8 Ed25519 private key: last 32 bytes of the inner octet string
  // The raw private seed is at a fixed offset in the DER structure
  const rawPrivate = privateKey.subarray(privateKey.length - 32);
  // SPKI Ed25519 public key: last 32 bytes
  const rawPublic = publicKey.subarray(publicKey.length - 32);

  // Solana keypair format: 64 bytes = private seed (32) + public key (32)
  const keypair = Buffer.concat([rawPrivate, rawPublic]);

  return {
    privateKey: keypair.toString('hex'),
    address: base58Encode(rawPublic),
  };
}

// ============= Storage =============

function ensureWalletsDir() {
  if (!fs.existsSync(getWalletsDir())) {
    fs.mkdirSync(getWalletsDir(), { mode: 0o700, recursive: true });
  }
}

function getWalletConfig() {
  if (!fs.existsSync(getWalletConfigPath())) {
    return { defaultWallet: null, passwordHash: null };
  }
  return JSON.parse(fs.readFileSync(getWalletConfigPath(), 'utf8'));
}

function saveWalletConfig(config) {
  ensureWalletsDir();
  fs.writeFileSync(getWalletConfigPath(), JSON.stringify(config, null, 2), { mode: 0o600 });
}

function getWalletFile(name) {
  return path.join(getWalletsDir(), `${name}.json`);
}

/**
 * Verify the global password against stored hash.
 */
export function verifyPassword(password, config) {
  if (!config.passwordHash) return true; // No password set yet
  const { salt, hash } = config.passwordHash;
  const derived = crypto.scryptSync(password, Buffer.from(salt, 'hex'), 32, {
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P,
  });
  return derived.toString('hex') === hash;
}

/**
 * Create a password hash for storage (NOT the encryption key, just for verification).
 */
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32, {
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P,
  });
  return { salt: salt.toString('hex'), hash: hash.toString('hex') };
}

// ============= Prompt Helper =============

async function promptPassword(question, deps = {}) {
  const promptFn = deps.promptFn;
  if (promptFn) {
    return promptFn(question, true);
  }
  // Fallback to readline
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    if (process.stdout.isTTY) {
      process.stdout.write(question);
      let input = '';
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding('utf8');
      const onData = (char) => {
        if (char === '\n' || char === '\r') {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.removeListener('data', onData);
          process.stdout.write('\n');
          rl.close();
          resolve(input);
        } else if (char === '\u0003') {
          process.exit();
        } else if (char === '\u007F' || char === '\b') {
          input = input.slice(0, -1);
        } else {
          input += char;
          process.stdout.write('*');
        }
      };
      process.stdin.on('data', onData);
    } else {
      rl.question(question, (answer) => { rl.close(); resolve(answer); });
    }
  });
}

// ============= Public API =============

/**
 * List all wallets.
 */
export function listWallets() {
  ensureWalletsDir();
  const config = getWalletConfig();
  const files = fs.readdirSync(getWalletsDir()).filter(f => f.endsWith('.json') && f !== 'config.json');

  const wallets = files.map(f => {
    const data = JSON.parse(fs.readFileSync(path.join(getWalletsDir(), f), 'utf8'));
    return {
      name: data.name,
      evm: data.evm?.address || null,
      solana: data.solana?.address || null,
      createdAt: data.createdAt,
      isDefault: data.name === config.defaultWallet,
    };
  });

  return { wallets, defaultWallet: config.defaultWallet };
}

/**
 * Create a new wallet pair (EVM + Solana).
 */
export function createWallet(name, password) {
  ensureWalletsDir();
  const config = getWalletConfig();
  const walletFile = getWalletFile(name);

  if (fs.existsSync(walletFile)) {
    throw new Error(`Wallet "${name}" already exists`);
  }

  // If this is the first wallet, set the password hash
  if (!config.passwordHash) {
    config.passwordHash = hashPassword(password);
  } else {
    if (!verifyPassword(password, config)) {
      throw new Error('Incorrect password');
    }
  }

  const evm = generateEvmWallet();
  const solana = generateSolanaWallet();

  const wallet = {
    name,
    createdAt: new Date().toISOString(),
    evm: {
      address: evm.address,
      encrypted: encryptKey(evm.privateKey, password),
    },
    solana: {
      address: solana.address,
      encrypted: encryptKey(solana.privateKey, password),
    },
  };

  fs.writeFileSync(walletFile, JSON.stringify(wallet, null, 2), { mode: 0o600 });

  // Set as default if it's the first wallet
  if (!config.defaultWallet) {
    config.defaultWallet = name;
  }
  saveWalletConfig(config);

  return {
    name,
    evm: evm.address,
    solana: solana.address,
    isDefault: config.defaultWallet === name,
  };
}

/**
 * Show wallet details (addresses only, no keys).
 */
export function showWallet(name) {
  const walletFile = getWalletFile(name);
  if (!fs.existsSync(walletFile)) {
    throw new Error(`Wallet "${name}" not found`);
  }

  const data = JSON.parse(fs.readFileSync(walletFile, 'utf8'));
  const config = getWalletConfig();

  return {
    name: data.name,
    evm: data.evm?.address || null,
    solana: data.solana?.address || null,
    createdAt: data.createdAt,
    isDefault: data.name === config.defaultWallet,
  };
}

/**
 * Export private keys for a wallet (requires password).
 */
export function exportWallet(name, password) {
  const walletFile = getWalletFile(name);
  if (!fs.existsSync(walletFile)) {
    throw new Error(`Wallet "${name}" not found`);
  }

  const config = getWalletConfig();
  if (!verifyPassword(password, config)) {
    throw new Error('Incorrect password');
  }

  const data = JSON.parse(fs.readFileSync(walletFile, 'utf8'));

  return {
    name: data.name,
    evm: {
      address: data.evm?.address,
      privateKey: data.evm ? decryptKey(data.evm.encrypted, password) : null,
    },
    solana: {
      address: data.solana?.address,
      privateKey: data.solana ? decryptKey(data.solana.encrypted, password) : null,
    },
  };
}

/**
 * Set the default wallet.
 */
export function setDefaultWallet(name) {
  const walletFile = getWalletFile(name);
  if (!fs.existsSync(walletFile)) {
    throw new Error(`Wallet "${name}" not found`);
  }

  const config = getWalletConfig();
  config.defaultWallet = name;
  saveWalletConfig(config);

  return { defaultWallet: name };
}

/**
 * Delete a wallet.
 */
export function deleteWallet(name, password) {
  const walletFile = getWalletFile(name);
  if (!fs.existsSync(walletFile)) {
    throw new Error(`Wallet "${name}" not found`);
  }

  const config = getWalletConfig();
  if (!verifyPassword(password, config)) {
    throw new Error('Incorrect password');
  }

  fs.unlinkSync(walletFile);

  if (config.defaultWallet === name) {
    // Pick another wallet as default, or null
    const remaining = fs.readdirSync(getWalletsDir()).filter(f => f.endsWith('.json') && f !== 'config.json');
    config.defaultWallet = remaining.length > 0 ? remaining[0].replace('.json', '') : null;
    saveWalletConfig(config);
  }

  return { deleted: name, newDefault: config.defaultWallet };
}

/**
 * Get the default wallet's address for a given chain type.
 */
export function getDefaultAddress(chainType = 'evm') {
  const config = getWalletConfig();
  if (!config.defaultWallet) {
    throw new Error('No default wallet set. Run: nansen wallet create');
  }

  const wallet = showWallet(config.defaultWallet);
  const field = chainType === 'solana' ? 'solana' : 'evm';
  return wallet[field];
}

// ============= CLI Command Builder =============

/**
 * Build wallet command handlers for integration into CLI.
 */
export function buildWalletCommands(deps = {}) {
  const { log = console.log, promptFn, exit = process.exit } = deps;

  return {
    'wallet': async (args, apiInstance, flags, options) => {
      const subcommand = args[0] || 'help';

      const handlers = {
        'create': async () => {
          const name = options.name || args[1] || 'default';
          const password = options.password || await promptPassword('Enter wallet password: ', deps);
          if (!password || password.length < 8) {
            log('❌ Password must be at least 8 characters');
            exit(1);
            return;
          }

          // Confirm password for first wallet
          const config = getWalletConfig();
          if (!config.passwordHash) {
            const confirm = await promptPassword('Confirm password: ', deps);
            if (password !== confirm) {
              log('❌ Passwords do not match');
              exit(1);
              return;
            }
          }

          try {
            const result = createWallet(name, password);
            log(`\n✓ Wallet "${result.name}" created\n`);
            log(`  EVM:    ${result.evm}`);
            log(`  Solana: ${result.solana}`);
            if (result.isDefault) log(`  ★ Set as default wallet`);
            log('');
            return result;
          } catch (err) {
            log(`❌ ${err.message}`);
            exit(1);
          }
        },

        'list': async () => {
          const result = listWallets();
          if (result.wallets.length === 0) {
            log('No wallets found. Create one with: nansen wallet create');
            return result;
          }
          log('');
          for (const w of result.wallets) {
            const star = w.isDefault ? ' ★' : '';
            log(`  ${w.name}${star}`);
            log(`    EVM:    ${w.evm}`);
            log(`    Solana: ${w.solana}`);
            log('');
          }
          return result;
        },

        'show': async () => {
          const name = options.name || args[1];
          if (!name) {
            log('Usage: nansen wallet show <name>');
            exit(1);
            return;
          }
          try {
            const result = showWallet(name);
            const star = result.isDefault ? ' ★' : '';
            log(`\n  ${result.name}${star}`);
            log(`    EVM:    ${result.evm}`);
            log(`    Solana: ${result.solana}`);
            log(`    Created: ${result.createdAt}\n`);
            return result;
          } catch (err) {
            log(`❌ ${err.message}`);
            exit(1);
          }
        },

        'export': async () => {
          const name = options.name || args[1];
          if (!name) {
            log('Usage: nansen wallet export <name>');
            exit(1);
            return;
          }
          const password = options.password || await promptPassword('Enter wallet password: ', deps);
          try {
            const result = exportWallet(name, password);
            log(`\n⚠️  Private keys for "${result.name}" — do not share!\n`);
            log(`  EVM:`);
            log(`    Address:     ${result.evm.address}`);
            log(`    Private Key: ${result.evm.privateKey}`);
            log(`  Solana:`);
            log(`    Address:     ${result.solana.address}`);
            log(`    Private Key: ${result.solana.privateKey}`);
            log('');
            return result;
          } catch (err) {
            log(`❌ ${err.message}`);
            exit(1);
          }
        },

        'default': async () => {
          const name = options.name || args[1];
          if (!name) {
            log('Usage: nansen wallet default <name>');
            exit(1);
            return;
          }
          try {
            const result = setDefaultWallet(name);
            log(`✓ Default wallet set to "${result.defaultWallet}"`);
            return result;
          } catch (err) {
            log(`❌ ${err.message}`);
            exit(1);
          }
        },

        'delete': async () => {
          const name = options.name || args[1];
          if (!name) {
            log('Usage: nansen wallet delete <name>');
            exit(1);
            return;
          }
          const password = options.password || await promptPassword('Enter wallet password: ', deps);
          try {
            const result = deleteWallet(name, password);
            log(`✓ Wallet "${result.deleted}" deleted`);
            if (result.newDefault) {
              log(`  New default: ${result.newDefault}`);
            }
            return result;
          } catch (err) {
            log(`❌ ${err.message}`);
            exit(1);
          }
        },

        'help': async () => {
          log(`
Wallet Management - Local key storage for EVM and Solana

USAGE:
  nansen wallet <command> [options]

COMMANDS:
  create [--name <label>]    Create a new wallet pair (EVM + Solana)
  list                       List all wallets
  show <name>                Show wallet addresses
  export <name>              Export private keys (requires password)
  default <name>             Set the default wallet
  delete <name>              Delete a wallet (requires password)

OPTIONS:
  --name <label>             Wallet name (default: "default")
  --password <pass>          Password (or enter interactively)

EXAMPLES:
  nansen wallet create --name trading
  nansen wallet list
  nansen wallet export trading
  nansen wallet default trading
`);
          return {
            commands: ['create', 'list', 'show', 'export', 'default', 'delete'],
            description: 'Local wallet management for EVM and Solana',
          };
        },
      };

      if (!handlers[subcommand]) {
        return { error: `Unknown subcommand: ${subcommand}`, available: Object.keys(handlers) };
      }

      return handlers[subcommand]();
    },
  };
}
