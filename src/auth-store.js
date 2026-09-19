import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { AuthError, authDirectory } from './auth-credentials.js';

export const CHUNK_BYTES = 2048;
export const MAX_BUNDLE_BYTES = 16384;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const unavailable = () => new AuthError('AUTH_STORE_UNAVAILABLE', 'Secure credential storage is unavailable or locked. Unlock your OS credential store and retry nansen login. No file fallback is used.');
export function nativeStoreOperation(operation, account, bytes, { directory = authDirectory(), signal } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./auth-store-worker.js', import.meta.url))], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      // Do not inherit debugging hooks or unrelated credentials into the helper.
      env: Object.fromEntries(['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'LOCALAPPDATA', 'APPDATA', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR'].filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]])),
    });
    let output = '';
    let ready = false, result;
    let failed = false;
    let terminationDeadline;
    const stop = () => {
      failed = true;
      try { child.kill('SIGKILL'); } catch { /* retain exclusion until OS termination */ }
      terminationDeadline ??= setTimeout(() => {
        // Never turn an unobserved termination into cleanup success. The child
        // still owns its gate; recovery must retain the journal on contention.
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
        child.unref(); signal?.removeEventListener('abort', stop); reject(unavailable());
      }, 1000);
    };
    const timer = setTimeout(stop, 10000);
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    child.stdout.on('data', chunk => {
      if (failed) return;
      output += chunk;
      if (output.length > 40000) { stop(); return; }
      let end;
      while ((end = output.indexOf('\n')) !== -1) {
        const line = output.slice(0, end); output = output.slice(end + 1);
        try {
          const message = JSON.parse(line);
          if (!ready && message.ready === true) {
            ready = true;
            // The child already holds execution/cleanup exclusion. Keep the
            // pipe open as a parent-lifetime signal; never send secrets early.
            child.stdin.write(JSON.stringify({ operation, account, ...(bytes && { data: Buffer.from(bytes).toString('base64') }) }) + '\n');
          } else if (ready && !result && Object.hasOwn(message, 'value')) result = message;
          else throw new Error();
        } catch { stop(); }
      }
    });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('error', () => { failed = true; });
    // Success requires actual close; an unobserved kill is a bounded failure.
    child.on('close', code => {
      clearTimeout(timer); clearTimeout(terminationDeadline);
      signal?.removeEventListener('abort', stop);
      try {
        if (failed || code !== 0 || !ready || !result || output) throw new Error();
        resolve(operation === 'get' && result.value !== null ? Buffer.from(result.value, 'base64') : result.value);
      } catch { reject(unavailable()); }
    });
    child.stdin.write(JSON.stringify({ directory: path.resolve(directory) }) + '\n');
  });
}
export function createAuthStore({ directory, operation = (op, account, bytes, options) => nativeStoreOperation(op, account, bytes, { directory, ...options }), barrier = async () => {} } = {}) {
  const name = (generation, suffix) => {
    if (!/^[a-f0-9-]{36}$/.test(generation)) throw unavailable();
    return `${generation}.${suffix}`;
  };
  async function invoke(op, account, bytes, options) {
    options?.signal?.throwIfAborted();
    const result = await operation(op, account, bytes, options);
    options?.signal?.throwIfAborted();
    return result;
  }
  return {
    async preflight(generation, options) {
      const account = name(generation, 'probe');
      const bytes = randomBytes(CHUNK_BYTES);
      try {
        await invoke('set', account, bytes, options);
        const actual = await invoke('get', account, undefined, options);
        if (!actual || !bytes.equals(actual)) throw unavailable();
      } finally {
        await invoke('delete', account, undefined, options);
      }
      if (await invoke('get', account, undefined, options) !== null) throw unavailable();
    },
    async write(generation, bundle, options) {
      const bytes = Buffer.from(JSON.stringify({ ...bundle, version: 1, generation }));
      if (bytes.length > MAX_BUNDLE_BYTES) throw new AuthError('AUTH_BUNDLE_TOO_LARGE', 'The issued session exceeds the 16 KiB secure-storage limit. The previous credential is unchanged.');
      const count = Math.ceil(bytes.length / CHUNK_BYTES);
      for (let i = 0; i < count; i++) {
        await invoke('set', name(generation, i), bytes.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES), options);
        await barrier(`chunk-${i}`);
      }
      await invoke('set', name(generation, 'manifest'), Buffer.from(JSON.stringify({ version: 1, count, bytes: bytes.length, digest: digest(bytes) })), options);
      await barrier('manifest');
      const loaded = await this.read(generation, options);
      if (JSON.stringify(loaded) !== bytes.toString()) throw unavailable();
    },
    async read(generation, options) {
      const manifest = await invoke('get', name(generation, 'manifest'), undefined, options);
      if (!manifest) throw Object.assign(unavailable(), { missing: true });
      try {
        const m = JSON.parse(manifest.toString());
        if (m.version !== 1 || !Number.isInteger(m.count) || m.count < 1 || m.count > 8 || !Number.isInteger(m.bytes) || m.bytes < 1 || m.bytes > MAX_BUNDLE_BYTES || Math.ceil(m.bytes / CHUNK_BYTES) !== m.count) throw new Error();
        const chunks = [];
        for (let i = 0; i < m.count; i++) {
          const bytes = await invoke('get', name(generation, i), undefined, options);
          if (!bytes) throw Object.assign(unavailable(), { missing: true });
          if (bytes.length !== Math.min(CHUNK_BYTES, m.bytes - i * CHUNK_BYTES)) throw new Error();
          chunks.push(bytes);
        }
        const bytes = Buffer.concat(chunks);
        if (digest(bytes) !== m.digest) throw new Error();
        const bundle = JSON.parse(bytes.toString());
        if (bundle.version !== 1 || bundle.generation !== generation) throw new Error();
        return bundle;
      } catch (error) { if (error instanceof AuthError) throw error; throw unavailable(); }
    },
    async remove(generation, options) {
      // Fixed bounded namespace, including interrupted writes without a manifest.
      for (const suffix of ['probe', 'manifest', ...Array.from({ length: 8 }, (_, i) => i)]) {
        const account = name(generation, suffix);
        await invoke('delete', account, undefined, options);
        if (await invoke('get', account, undefined, options) !== null) throw unavailable();
      }
    },
  };
}
