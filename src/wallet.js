/**
 * Nansen CLI - Wallet Management
 * Local key generation and storage for EVM and Solana chains.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import * as readline from 'readline';
import { base58 } from '@scure/base';
import { keychainAvailable, keychainStore, keychainGet } from './keychain.js';

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
const _AUTH_TAG_LEN = 16;

import { keccak256 } from './crypto.js';

// ============= Base58 Encoding (for Solana) =============

/**
 * Encode a Buffer to base58 string.
 */
export function base58Encode(buf) {
  return base58.encode(buf instanceof Uint8Array ? buf : Uint8Array.from(buf));
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
  if (password === null) {
    return { data: privateKeyHex, encrypted: false };
  }

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
 * For unencrypted wallets (encrypted: false), password is ignored and
 * plaintext data is returned directly.
 */
export function decryptKey(encryptedData, password) {
  const ENCRYPTED_FIELDS = ['salt', 'iv', 'authTag', 'ciphertext'];
  const hasEncryptionFields = ENCRYPTED_FIELDS.some(f => f in encryptedData);

  // Unencrypted blob
  if (encryptedData.encrypted === false) {
    if (hasEncryptionFields) {
      throw new Error('Wallet data corrupted or tampered');
    }
    return encryptedData.data;
  }

  // Encrypted blob with missing fields
  if (!ENCRYPTED_FIELDS.every(f => f in encryptedData)) {
    throw new Error('Wallet data corrupted or tampered');
  }

  // Encrypted blob but no password provided
  if (password === null || password === undefined) {
    throw new Error('Wallet is encrypted. Set NANSEN_WALLET_PASSWORD.');
  }

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

/**
 * Generate a cryptographically strong password and persist it.
 *
 * Priority: OS keychain (preferred) > .credentials file (fallback with warning).
 *
 * Security notes:
 *   - 24 bytes = 192 bits of entropy (base64url). Brute force is not viable.
 *   - OS keychain: password never written to the local filesystem.
 *   - .credentials fallback: written at mode 0o600 (user read/write only).
 *     Risk: a process with same-user filesystem access can read both the
 *     encrypted wallet and the password file.
 *   - Do NOT log the return value of this function or the content of .credentials.
 */
async function generateAndSavePassword() {
  ensureWalletsDir();
  const password = crypto.randomBytes(24).toString('base64url');

  // Try OS keychain first (preferred: password not on local filesystem)
  if (await keychainAvailable()) {
    try {
      await keychainStore(password);
      return { password, backend: 'keychain', credPath: null, securityWarning: null };
    } catch (_e) { /* intentional: fall through to .credentials */ }
  }

  // Fallback: write to .credentials
  const credPath = path.join(getWalletsDir(), '.credentials');
  fs.writeFileSync(credPath, `NANSEN_WALLET_PASSWORD=${password}\n`, { mode: 0o600 });
  return {
    password,
    backend: 'credentials-file',
    credPath,
    securityWarning: '.credentials is stored on the local filesystem alongside your encrypted wallet. A process with same-user access can read both. Use NANSEN_WALLET_PASSWORD env var or enable OS keychain for better security.',
  };
}

function resolveTTY(deps = {}) {
  return deps.isTTY !== undefined ? deps.isTTY : process.stdout.isTTY;
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
  if (password === null || password === undefined) return false;
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

async function getPassword(deps = {}, context = 'operation') {
  // Try OS keychain (managed storage, preferred)
  try {
    const kcPassword = await keychainGet();
    if (kcPassword) return kcPassword;
  } catch (_e) { /* intentional */ }

  // Try env var (user-provided override for CI/scripts)
  if (process.env.NANSEN_WALLET_PASSWORD) return process.env.NANSEN_WALLET_PASSWORD;

  // Try .credentials file (auto-generated fallback)
  try {
    const credFilePath = path.join(getWalletsDir(), '.credentials');
    const credContent = fs.readFileSync(credFilePath, 'utf8');
    const credMatch = credContent?.match(/^NANSEN_WALLET_PASSWORD=(.+)$/m);
    if (credMatch) return credMatch[1];
  } catch (_e) { /* intentional: missing .credentials is not an error */ }

  // Prompt if TTY available
  if (!resolveTTY(deps)) {
    const err = {
      success: false,
      error: `Password required for ${context}`,
      code: 'PASSWORD_REQUIRED',
      hint: 'Set NANSEN_WALLET_PASSWORD env var or store password in OS keychain',
    };
    throw Object.assign(new Error(err.error), { structured: err });
  }
  return deps.promptFn ? deps.promptFn('Password: ', true) : promptPassword('Password: ', deps);
}

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
 * Health-check: returns wallet security status without side effects.
 */
export async function checkWallets(_deps = {}) {
  const issues = [];
  ensureWalletsDir();

  const configPath = getWalletConfigPath();
  let config = { defaultWallet: null, passwordHash: null };
  if (fs.existsSync(configPath)) {
    try {
      config = getWalletConfig();
    } catch (_e) {
      issues.push('config.json is present but could not be parsed');
    }
  }

  const encrypted = !!(config.passwordHash);
  const walletFiles = fs.readdirSync(getWalletsDir())
    .filter(f => f.endsWith('.json') && f !== 'config.json');
  const walletCount = walletFiles.length;

  let keychainInUse = false;
  let keychainPassword = null;
  try { keychainPassword = await keychainGet(); } catch (_e) { /* intentional */ }
  if (keychainPassword) keychainInUse = true;

  let passwordSource = 'none';
  if (process.env.NANSEN_WALLET_PASSWORD) {
    passwordSource = 'env';
  } else if (keychainInUse) {
    passwordSource = 'keychain';
  } else {
    const credPath = path.join(getWalletsDir(), '.credentials');
    if (fs.existsSync(credPath)) passwordSource = 'credentials-file';
  }

  let permissionsOk = true;
  try {
    const st = fs.statSync(configPath);
    if ((st.mode & 0o077) !== 0) {
      permissionsOk = false;
      issues.push(`config.json permissions insecure: ${(st.mode & 0o777).toString(8)}`);
    }
  } catch (_e) { /* intentional: config.json may not exist */ }
  for (const f of walletFiles) {
    try {
      const st = fs.statSync(path.join(getWalletsDir(), f));
      if ((st.mode & 0o077) !== 0) {
        permissionsOk = false;
        issues.push(`${f} permissions insecure: ${(st.mode & 0o777).toString(8)}`);
      }
    } catch (_e) { /* intentional: file may be removed between listing and stat */ }
  }
  if (encrypted && passwordSource === 'none') {
    issues.push('Wallets are encrypted but no password source found (no keychain entry, NANSEN_WALLET_PASSWORD not set, no .credentials file)');
  }

  // Check .credentials permissions — it holds the plaintext password and must be user-only (0o600)
  const credPath = path.join(getWalletsDir(), '.credentials');
  try {
    const credStat = fs.statSync(credPath);
    if ((credStat.mode & 0o077) !== 0) {
      permissionsOk = false;
      issues.push(`.credentials permissions insecure: ${(credStat.mode & 0o777).toString(8)} — file holds plaintext password and must be 0600`);
    }
  } catch (_e) { /* intentional: .credentials may not exist (env var path) */ }

  return { encrypted, permissionsOk, passwordSource, keychainInUse, walletCount, issues };
}

/**
 * Create a new wallet pair (EVM + Solana).
 */
export function createWallet(name, password, options = {}) {
  const { force = false, unsafeNoPassword = false, iUnderstandThisIsUnsafe = false } = options;
  ensureWalletsDir();

  // Prerequisites check: prevent accidental multi-wallet creation (lightweight count, no JSON reads)
  const existingFiles = fs.readdirSync(getWalletsDir())
    .filter(f => f.endsWith('.json') && f !== 'config.json');
  if (existingFiles.length > 0 && !force) {
    throw Object.assign(new Error('Wallets already exist. Use --force to add another.'), {
      code: 'WALLETS_EXIST',
      structured: {
        success: false,
        error: 'Wallets already exist. Use --force to add another.',
        code: 'WALLETS_EXIST',
        hint: 'Pass --force to proceed',
        walletCount: existingFiles.length,
      },
    });
  }

  // Null/undefined password without --unsafe-no-password is a contract violation
  if ((password === null || password === undefined) && !unsafeNoPassword) {
    throw Object.assign(new Error('Password is required. Use --unsafe-no-password to create an unencrypted wallet.'), {
      code: 'PASSWORD_REQUIRED',
    });
  }

  // --unsafe-no-password requires explicit second confirmation
  if (unsafeNoPassword && !iUnderstandThisIsUnsafe) {
    throw Object.assign(new Error('--unsafe-no-password requires --i-understand-this-is-unsafe'), {
      code: 'UNSAFE_CONFIRMATION_REQUIRED',
    });
  }

  const config = getWalletConfig();
  // Snapshot for rollback if post-creation permission check fails
  const configExisted = fs.existsSync(getWalletConfigPath());
  const originalConfig = JSON.parse(JSON.stringify(config));
  const walletFile = getWalletFile(name);

  if (fs.existsSync(walletFile)) {
    throw new Error(`Wallet "${name}" already exists`);
  }

  if (password === null) {
    // Passwordless mode: reject if existing wallets are encrypted
    if (config.passwordHash) {
      throw new Error('Existing wallets are password-protected. Set NANSEN_WALLET_PASSWORD.');
    }
  } else {
    // Encrypted mode
    if (!config.passwordHash) {
      // First encrypted wallet: reject if passwordless wallets exist
      const existingWallets = fs.readdirSync(getWalletsDir())
        .filter(f => f.endsWith('.json') && f !== 'config.json');
      if (existingWallets.length > 0) {
        throw new Error('Existing wallets are passwordless. Cannot mix encrypted and unencrypted wallets.');
      }
      config.passwordHash = hashPassword(password);
    } else if (!verifyPassword(password, config)) {
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

  // Post-creation permission check: hard-fail and clean up on insecure perms
  const walletStat = fs.statSync(walletFile);
  const configStat = fs.statSync(getWalletConfigPath());
  if ((walletStat.mode & 0o077) !== 0 || (configStat.mode & 0o077) !== 0) {
    try { fs.unlinkSync(walletFile); } catch (_e) { /* intentional: best-effort cleanup */ }
    try {
      if (configExisted) {
        saveWalletConfig(originalConfig);     // restore pre-call state
      } else {
        fs.unlinkSync(getWalletConfigPath()); // config was newly created — delete it
      }
    } catch (_e) { /* intentional: best-effort config rollback */ }
    throw Object.assign(new Error('SECURITY: Wallet file created with insecure permissions. Best-effort cleanup attempted — verify wallet store integrity.'), {
      code: 'INSECURE_PERMISSIONS',
    });
  }

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
  if (config.passwordHash && !verifyPassword(password, config)) {
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
  if (config.passwordHash && !verifyPassword(password, config)) {
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
  const { log = console.log, exit = process.exit } = deps;

  return {
    'wallet': async (args, apiInstance, flags, options) => {
      const subcommand = args[0] || 'help';

      const handlers = {
        'create': async () => {
          const name = options.name || args[1] || 'default';
          const force = !!flags.force;
          const unsafeNoPassword = !!flags['unsafe-no-password'];
          const iUnderstand = !!flags['i-understand-this-is-unsafe'];
          const isTTY = resolveTTY(deps);
          const jsonMode = flags.json || !isTTY;

          let password;
          let passwordSource;
          let credPath = null;
          let securityWarning = null;
          let passwordBackend = null;

          if (unsafeNoPassword) {
            if (!iUnderstand) {
              const errObj = { success: false, error: '--unsafe-no-password requires --i-understand-this-is-unsafe', code: 'UNSAFE_CONFIRMATION_REQUIRED' };
              log(JSON.stringify(errObj, null, 2));
              exit(1);
              return;
            }
            process.stderr.write('WARNING: --unsafe-no-password is set. Private keys will be stored UNENCRYPTED on disk.\nAnyone with access to this machine can steal your funds.\n');
            password = null;
            passwordSource = 'none';
          } else if (process.env.NANSEN_WALLET_PASSWORD) {
            password = process.env.NANSEN_WALLET_PASSWORD;
            passwordSource = 'env';
          } else if (isTTY || deps.promptFn) {
            password = await promptPassword('Enter wallet password: ', deps);
            if (!password || password.length < 12) {
              log('❌ Password must be at least 12 characters');
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
            passwordSource = 'prompt';
          } else {
            // Non-TTY, no env var
            const existingConfig = getWalletConfig();
            if (existingConfig.passwordHash) {
              // Existing encrypted wallets: resolve the existing password, never generate a new one
              // Priority: keychain > .credentials file
              let resolved = false;
              try {
                const kcPassword = await keychainGet();
                if (kcPassword) {
                  password = kcPassword;
                  passwordSource = 'keychain';
                  passwordBackend = 'keychain';
                  resolved = true;
                }
              } catch (_e) { /* intentional */ }
              if (!resolved) {
                const credFilePath = path.join(getWalletsDir(), '.credentials');
                let credContent;
                try { credContent = fs.readFileSync(credFilePath, 'utf8'); } catch (_e) { /* intentional: missing .credentials treated as no password */ }
                const credMatch = credContent?.match(/^NANSEN_WALLET_PASSWORD=(.+)$/m);
                if (credMatch) {
                  password = credMatch[1];
                  passwordSource = 'credentials-file';
                  passwordBackend = 'credentials-file';
                  securityWarning = '.credentials is stored on the local filesystem alongside your encrypted wallet. A process with same-user access can read both. Use NANSEN_WALLET_PASSWORD env var or enable OS keychain for better security.';
                } else {
                  log(JSON.stringify({ success: false, error: 'Password required for create', code: 'PASSWORD_REQUIRED', hint: 'Set NANSEN_WALLET_PASSWORD env var' }, null, 2));
                  exit(1);
                  return;
                }
              }
            } else {
              // No existing encrypted wallets: auto-generate a fresh password
              const gen = await generateAndSavePassword();
              password = gen.password;
              credPath = gen.credPath;
              passwordBackend = gen.backend;
              securityWarning = gen.securityWarning;
              passwordSource = gen.backend === 'keychain' ? 'keychain' : 'credentials-file';
            }
          }

          try {
            const result = createWallet(name, password, { force, unsafeNoPassword, iUnderstandThisIsUnsafe: iUnderstand });
            if (jsonMode) {
              log(JSON.stringify({
                success: true,
                name: result.name,
                addresses: { evm: result.evm, solana: result.solana },
                passwordSource,
                passwordBackend: passwordBackend || passwordSource,
                credentialsFile: credPath,
                securityWarning,
              }, null, 2));
            } else {
              log(`\n✓ Wallet "${result.name}" created\n`);
              log(`  EVM:    ${result.evm}`);
              log(`  Solana: ${result.solana}`);
              if (result.isDefault) log(`  ★ Set as default wallet`);
              log('');
              log('  Fund this wallet to start making API calls or trading:');
              log(`    Base: send USDC to ${result.evm}`);
              log(`    Solana: send USDC to ${result.solana}`);
              log('');
              if (passwordBackend === 'keychain') {
                log('  Password stored in OS keychain (not written to disk).');
              } else if (credPath) {
                log(`  Password stored at: ${credPath}`);
                log('  ⚠ Security notice: .credentials is on the local filesystem alongside your');
                log('    encrypted wallet. Any process running as you can read both.');
                log('    For better security: use NANSEN_WALLET_PASSWORD env var or enable OS keychain.');
                log('    Do not sync ~/.nansen/ to cloud storage.');
              }
              if (password === null) {
                log('  ⚠️  This is an UNENCRYPTED hot wallet — private keys are stored in plaintext on disk.');
              } else {
                log('  ⚠️  This is a hot wallet and is fundamentally insecure — do not deposit more than you can afford to lose.');
                log('     Store and handle your password securely, e.g. using a secrets manager or system keychain.');
              }
              log('');
            }
          } catch (err) {
            if (jsonMode) {
              log(JSON.stringify(err.structured || { success: false, error: err.message, code: err.code }, null, 2));
            } else {
              log(`❌ ${err.message}`);
            }
            exit(1);
          }
        },

        'list': async () => {
          const result = listWallets();
          if (result.wallets.length === 0) {
            log('No wallets found. Create one with: nansen wallet create');
            return;
          }
          log('');
          for (const w of result.wallets) {
            const star = w.isDefault ? ' ★' : '';
            log(`  ${w.name}${star}`);
            log(`    EVM:    ${w.evm}`);
            log(`    Solana: ${w.solana}`);
            log('');
          }
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
            return;
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
          try {
            const config = getWalletConfig();
            const password = config.passwordHash ? await getPassword(deps, 'export') : null;
            const result = exportWallet(name, password);
            log(`\n⚠️  Private keys for "${result.name}" — do not share!\n`);
            log(`  EVM:`);
            log(`    Address:     ${result.evm.address}`);
            log(`    Private Key: ${result.evm.privateKey}`);
            log(`  Solana:`);
            log(`    Address:     ${result.solana.address}`);
            log(`    Private Key: ${result.solana.privateKey}`);
            log('');
          } catch (err) {
            if (err.structured) {
              log(JSON.stringify(err.structured, null, 2));
            } else {
              log(`❌ ${err.message}`);
            }
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
            return;
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
          try {
            const config = getWalletConfig();
            const password = config.passwordHash ? await getPassword(deps, 'delete') : null;
            const result = deleteWallet(name, password);
            log(`✓ Wallet "${result.deleted}" deleted`);
            if (result.newDefault) {
              log(`  New default: ${result.newDefault}`);
            }
          } catch (err) {
            if (err.structured) {
              log(JSON.stringify(err.structured, null, 2));
            } else {
              log(`❌ ${err.message}`);
            }
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

          const isWalletConnect = options.wallet === 'walletconnect' || options.wallet === 'wc';
          let password;
          if (isWalletConnect) {
            password = null;
          } else {
            const sendConfig = getWalletConfig();
            password = sendConfig.passwordHash
              ? (process.env.NANSEN_WALLET_PASSWORD || await promptPassword('Enter wallet password: ', deps))
              : null;
          }
          const dryRun = flags['dry-run'] || flags.dryRun;

          try {
            const sendOpts = {
              to: options.to,
              amount: isMax ? '0' : String(options.amount),
              chain: options.chain,
              token: options.token || null,
              wallet: isWalletConnect ? null : (options.wallet || null),
              max: isMax,
              password,
              dryRun,
              walletconnect: isWalletConnect,
            };

            if (dryRun) {
              // Build the transaction but don't broadcast
              const result = await sendTokens(sendOpts);
              log(`\nDry run — transaction not broadcast\n`);
              log(`  From:   ${result.from}`);
              log(`  To:     ${options.to}`);
              log(`  Amount: ${result.amount || (isMax ? 'max' : String(options.amount))}`);
              log(`  Token:  ${options.token || '(native)'}`);
              log(`  Chain:  ${options.chain}`);
              if (result.estimatedFee) log(`  Fee:    ${result.estimatedFee}`);
              log('');
              return;
            }

            const result = await sendTokens(sendOpts);
            log(`\n✓ Transaction sent\n`);
            log(`  Tx Hash: ${result.transactionHash}`);
            log(`  Chain:   ${result.chain}`);
            log(`  From:    ${result.from}`);
            log(`  To:      ${result.to}`);
            log(`  Amount:  ${result.amount}`);
            log(`  Token:   ${result.token}`);
            if (result.blockNumber) log(`  Block:   ${result.blockNumber}`);
            log(`  Status:  ${result.confirmed ? 'confirmed' : 'pending'}`);
            log(`  Explorer: ${result.explorer}`);
            log('');
            return;
          } catch (err) {
            log(`Error: ${err.message}`);
            exit(1);
          }
        },

        'check': async () => {
          const result = await checkWallets(deps);
          log(JSON.stringify(result, null, 2));
          if (result.issues.length > 0) exit(1);
        },

        'help': async () => {
          log(`
Wallet Management - Local key storage for EVM and Solana

USAGE:
  nansen wallet <command> [options]

COMMANDS:
  create [--name <label>] [--force] [--unsafe-no-password --i-understand-this-is-unsafe] [--json]
                             Create a new wallet pair (EVM + Solana)
  check                      Show wallet security status (exits 1 if issues found)
  list                       List all wallets
  show <name>                Show wallet addresses
  export <name>              Export private keys (requires password)
  default <name>             Set the default wallet
  delete <name>              Delete a wallet (requires password)
  send --to <address> --amount <number> --chain <evm|solana> [--token <address>] [--wallet <name>] [--max] [--dry-run]
                             Send tokens or native currency (--max sends entire balance, --dry-run previews without sending)

OPTIONS:
  --name <label>             Wallet name (default: "default")
  --force                    Allow creating additional wallets when one already exists (create only)
  --unsafe-no-password       Skip encryption — private keys stored UNENCRYPTED on disk (create only)
  --i-understand-this-is-unsafe  Required confirmation for --unsafe-no-password
  --json                     Force JSON output (create only)
  --to <address>             Recipient address (required for send)
  --amount <number>          Amount to send in human-readable format (required unless --max)
  --chain <evm|solana>       Blockchain to use (required for send)
  --token <address>          Token contract/mint address (optional, sends native if omitted)
  --wallet <name>            Wallet to use (optional, uses default if omitted; use "walletconnect" or "wc" for WalletConnect, EVM only)
  --max                      Send entire balance (deducts gas for native transfers)

ENVIRONMENT:
  NANSEN_WALLET_PASSWORD     Password for non-interactive use (e.g. CI/scripts)
  NANSEN_EVM_RPC            Custom EVM RPC endpoint
  NANSEN_SOLANA_RPC         Custom Solana RPC endpoint

EXAMPLES:
  nansen wallet create --name trading
  nansen wallet check
  nansen wallet list
  nansen wallet export trading
  nansen wallet default trading
  nansen wallet send --to 0x742d35Cc... --amount 1.5 --chain evm
  nansen wallet send --to 9WzDXw... --amount 0.1 --chain solana --token So11...
`);
        },
      };

      if (!handlers[subcommand]) {
        log(`Unknown subcommand: ${subcommand}. Available: ${Object.keys(handlers).join(', ')}`);
        exit(1);
        return;
      }

      // --help on any wallet subcommand shows wallet help instead of executing
      if (flags.help || flags.h) {
        return handlers['help']();
      }

      return handlers[subcommand]();
    },
  };
}
