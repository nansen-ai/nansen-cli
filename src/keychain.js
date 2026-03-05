/**
 * OS Keychain integration for wallet password storage.
 * Uses @napi-rs/keyring for cross-platform support:
 *   macOS:   Keychain Services
 *   Linux:   Secret Service (D-Bus / GNOME Keyring / KWallet)
 *   Windows: Credential Manager
 *
 * No native compilation needed — ships prebuilt NAPI-RS Rust binaries.
 */

const SERVICE = 'nansen-cli';
const ACCOUNT = 'wallet-password';

/**
 * Lazy singleton: import @napi-rs/keyring on first use.
 * Returns the module or null if the native addon is not available.
 */
let _mod;

async function getKeyringModule() {
  if (_mod !== undefined) return _mod;
  try {
    _mod = await import('@napi-rs/keyring');
  } catch {
    _mod = null;
  }
  return _mod;
}

function createEntry(mod) {
  return new mod.Entry(SERVICE, ACCOUNT);
}

/**
 * Async probe: is a usable OS keychain available?
 * Attempts to load the native module and probe the keychain.
 * "Not found" errors mean the keychain works but is empty — returns true.
 * Fundamental failures (e.g. no D-Bus session on headless Linux) — returns false.
 */
export async function keychainAvailable() {
  const mod = await getKeyringModule();
  if (!mod) return false;
  try {
    createEntry(mod).getPassword();
    return true;
  } catch (e) {
    const msg = e?.message || '';
    // "Not found" variants mean the keychain system works, just no entry stored yet
    if (msg.includes('No matching entry') ||
        msg.includes('not found') ||
        msg.includes('Item not found') ||
        msg.includes('The specified item could not be found')) {
      return true;
    }
    return false;
  }
}

/**
 * Store password in OS keychain.
 * Returns: { backend: 'keychain' }
 * Throws on failure.
 */
export async function keychainStore(password) {
  const mod = await getKeyringModule();
  if (!mod) throw new Error('Keychain not available');
  createEntry(mod).setPassword(password);
  return { backend: 'keychain' };
}

/**
 * Retrieve password from OS keychain.
 * Returns: string (password) or null if not found.
 */
export async function keychainGet() {
  const mod = await getKeyringModule();
  if (!mod) return null;
  try {
    return createEntry(mod).getPassword();
  } catch {
    return null;
  }
}

/**
 * Best-effort delete. Never throws.
 */
export async function keychainDelete() {
  const mod = await getKeyringModule();
  if (!mod) return;
  try {
    createEntry(mod).deleteCredential();
  } catch {
    // intentional: best-effort delete, never throws
  }
}

/**
 * Reset module cache (for testing only).
 */
export function _resetForTesting() {
  _mod = undefined;
}
