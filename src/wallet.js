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
const SCRYPT_N = 131072;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;
const SALT_LEN = 16;
const IV_LEN = 12;
const AUTH_TAG_LEN = 16;

import { keccak256 } from './crypto.js';

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
    maxmem: 256 * 1024 * 1024, // 256MB — needed for N=131072
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

  const result = {
    privateKey: privateKey.toString('hex'),
    address: checksummed,
  };

  // Zero sensitive buffers (strings remain in heap — JS limitation)
  privateKey.fill(0);

  return result;
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

function warnIfInsecurePerms(filePath) {
  try {
    const mode = fs.statSync(filePath).mode & 0o777;
    if (mode & 0o077) { // group or other has any access
      console.error(`⚠️  Warning: ${filePath} has insecure permissions (${mode.toString(8)}). Run: chmod 600 ${filePath}`);
    }
  } catch { /* ignore stat errors */ }
}

export function getWalletConfig() {
  if (!fs.existsSync(getWalletConfigPath())) {
    return { defaultWallet: null, passwordHash: null };
  }
  warnIfInsecurePerms(getWalletConfigPath());
  return JSON.parse(fs.readFileSync(getWalletConfigPath(), 'utf8'));
}

function saveWalletConfig(config) {
  ensureWalletsDir();
  fs.writeFileSync(getWalletConfigPath(), JSON.stringify(config, null, 2), { mode: 0o600 });
}

const WALLET_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

function validateWalletName(name) {
  if (!name || !WALLET_NAME_RE.test(name)) {
    throw new Error('Wallet name must be 1-64 characters: letters, numbers, hyphens, underscores only');
  }
}

function getWalletFile(name) {
  validateWalletName(name);
  return path.join(getWalletsDir(), `${name}.json`);
}

/**
 * Verify the global password against stored hash.
 */
export function verifyPassword(password, config) {
  if (!config.passwordHash) return true; // No password set yet
  const { salt, hash } = config.passwordHash;
  const derived = crypto.scryptSync(password, Buffer.from(salt, 'hex'), 32, {
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 256 * 1024 * 1024,
  });
  return crypto.timingSafeEqual(derived, Buffer.from(hash, 'hex'));
}

/**
 * Create a password hash for storage (NOT the encryption key, just for verification).
 */
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32, {
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 256 * 1024 * 1024,
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
          const password = process.env.NANSEN_WALLET_PASSWORD || await promptPassword('Enter wallet password: ', deps);
          if (!password || password.length < 12) {
            log('❌ Password must be at least 12 characters');
            exit(1);
            return;
          }

          // Confirm password for first wallet (skip if set via env var)
          const config = getWalletConfig();
          if (!config.passwordHash && !process.env.NANSEN_WALLET_PASSWORD) {
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
            log('  Fund this wallet to start making API calls or trading:');
            log(`    Base (recommended, lower fees): send USDC to ${result.evm}`);
            log(`    Solana: send USDC to ${result.solana}`);
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
          const password = process.env.NANSEN_WALLET_PASSWORD || await promptPassword('Enter wallet password: ', deps);
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
          const password = process.env.NANSEN_WALLET_PASSWORD || await promptPassword('Enter wallet password: ', deps);
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

        'send': async () => {
          const { sendTokens } = await import('./transfer.js');
          
          if (!options.to) {
            log('❌ --to <address> is required');
            exit(1);
            return;
          }
          
          const isMax = flags.max || options.amount === 'max';
          if (!options.amount && !isMax) {
            log('❌ --amount <number> or --max is required');
            exit(1);
            return;
          }
          
          if (!options.chain) {
            log('❌ --chain <evm|solana> is required');
            exit(1);
            return;
          }
          
          if (!['evm', 'solana', 'ethereum', 'base'].includes(options.chain)) {
            log('❌ --chain must be one of: evm, solana, ethereum, base');
            exit(1);
            return;
          }
          
          const password = process.env.NANSEN_WALLET_PASSWORD || await promptPassword('Enter wallet password: ', deps);
          const dryRun = flags['dry-run'] || flags.dryRun;
          
          try {
            const sendOpts = {
              to: options.to,
              amount: isMax ? '0' : String(options.amount),
              chain: options.chain,
              token: options.token || null,
              wallet: options.wallet || null,
              max: isMax,
              password,
              dryRun,
            };

            if (dryRun) {
              // Build the transaction but don't broadcast
              const result = await sendTokens(sendOpts);
              const output = {
                dryRun: true,
                from: result.from,
                to: options.to,
                amount: result.amount || (isMax ? 'max' : String(options.amount)),
                token: options.token || '(native)',
                chain: options.chain,
                ...(result.estimatedFee ? { estimatedFee: result.estimatedFee } : {}),
              };
              log(JSON.stringify(output, null, 2));
              return output;
            }

            const result = await sendTokens(sendOpts);
            
            const output = {
              success: true,
              transactionHash: result.transactionHash,
              confirmed: result.confirmed,
              ...(result.blockNumber ? { blockNumber: result.blockNumber } : {}),
              from: result.from,
              to: result.to,
              amount: result.amount,
              token: result.token,
              chain: result.chain,
              explorer: result.explorer,
            };
            log(JSON.stringify(output, null, 2));
            return output;
          } catch (err) {
            log(JSON.stringify({ success: false, error: err.message }));
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
  send --to <address> --amount <number> --chain <evm|solana> [--token <address>] [--wallet <name>] [--max] [--dry-run]
                             Send tokens or native currency (--max sends entire balance, --dry-run previews without sending)

OPTIONS:
  --name <label>             Wallet name (default: "default")
  --to <address>             Recipient address (required for send)
  --amount <number>          Amount to send in human-readable format (required unless --max)
  --chain <evm|solana>       Blockchain to use (required for send)
  --token <address>          Token contract/mint address (optional, sends native if omitted)
  --wallet <name>            Wallet to use (optional, uses default if omitted)
  --max                      Send entire balance (deducts gas for native transfers)

ENVIRONMENT:
  NANSEN_WALLET_PASSWORD     Password for non-interactive use (e.g. CI/scripts)
  NANSEN_EVM_RPC            Custom EVM RPC endpoint
  NANSEN_SOLANA_RPC         Custom Solana RPC endpoint

EXAMPLES:
  nansen wallet create --name trading
  nansen wallet list
  nansen wallet export trading
  nansen wallet default trading
  nansen wallet send --to 0x742d35Cc... --amount 1.5 --chain evm
  nansen wallet send --to 9WzDXw... --amount 0.1 --chain solana --token So11...
`);
          return {
            commands: ['create', 'list', 'show', 'export', 'default', 'delete', 'send'],
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
