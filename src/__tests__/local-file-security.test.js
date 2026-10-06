import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openLocalFile, readLocalFile } from '../local-file.js';
import { readAuthConfig, resolveCredential } from '../auth-credentials.js';
import { createAuthState, renewalStatus } from '../auth-state.js';
import { claimQuoteForExecution, getQuotesDir, loadQuote, loadTxRecord, markQuoteExecuted, safeQuotesPath, saveQuote, saveTxRecord } from '../trading.js';
import { loadBridgeQuote } from '../bridge.js';

let home, root;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nansen-file-security-'));
  root = path.join(home, '.nansen');
  fs.mkdirSync(root, { mode: 0o700 });
  vi.stubEnv('HOME', home);
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});
function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
}
function config() { return path.join(root, 'config.json'); }
function snapshot() { return readAuthConfig({ HOME: home }, path.join(home, 'dev-config.json')); }

describe('managed authentication files', () => {
  it('preserves saved-key and explicit-key precedence for ordinary files', () => {
    write(config(), { apiKey: 'saved-key', setting: 42 });
    expect(resolveCredential({ env: {}, snapshot: snapshot() })).toMatchObject({ kind: 'api-key', apiKey: 'saved-key' });
    expect(resolveCredential({ env: { NANSEN_API_KEY: 'env-key' }, snapshot: snapshot() })).toMatchObject({ apiKey: 'env-key' });
    expect(snapshot().config.setting).toBe(42);
  });

  it.each(['symlink', 'hardlink', 'dangling'])('rejects a %s config without falling back to a development key', kind => {
    const outside = path.join(home, 'secret.json');
    write(outside, { apiKey: 'outside-secret' });
    write(path.join(home, 'dev-config.json'), { apiKey: 'dev-key' });
    if (kind === 'hardlink') fs.linkSync(outside, config());
    else fs.symlinkSync(kind === 'dangling' ? path.join(home, 'missing') : outside, config());
    const result = snapshot();
    expect(result).toMatchObject({ config: {}, configFileExists: true, configError: 'unreadable' });
    expect(resolveCredential({ env: {}, snapshot: result }).kind).toBe('invalid');
  });

  it('rejects a symlinked storage directory', () => {
    const outside = path.join(home, 'outside');
    write(path.join(outside, 'config.json'), { apiKey: 'outside-secret' });
    fs.rmdirSync(root); fs.symlinkSync(outside, root, 'dir');
    expect(snapshot().configError).toBe('unreadable');
  });

  it.skipIf(process.platform === 'win32')('rejects a writable config and an unexpected file owner', () => {
    write(config(), { apiKey: 'saved-key' });
    fs.chmodSync(config(), 0o666);
    expect(snapshot().configError).toBe('unreadable');
    fs.chmodSync(config(), 0o600);
    vi.spyOn(process, 'getuid').mockReturnValue(process.getuid() + 1);
    expect(snapshot().configError).toBe('unreadable');
  });

  it.each(['symlink', 'replacement', 'hardlink'])('reads no secret bytes when config changes to a %s at open', kind => {
    write(config(), { apiKey: 'saved-key' });
    const outside = path.join(home, 'secret.json');
    write(outside, { apiKey: 'outside-secret' });
    const original = fs.openSync.bind(fs);
    vi.spyOn(fs, 'openSync').mockImplementation((file, ...args) => {
      if (file === config()) {
        fs.renameSync(file, `${file}.original-${randomUUID()}`);
        if (kind === 'symlink') fs.symlinkSync(outside, file);
        else if (kind === 'hardlink') fs.linkSync(outside, file);
        else fs.copyFileSync(outside, file);
      }
      return original(file, ...args);
    });
    const read = vi.spyOn(fs, 'readFileSync');
    expect(snapshot().configError).toBe('unreadable');
    expect(read).not.toHaveBeenCalled();
  });

  it('revalidates a legitimate atomic config update once before reading', () => {
    write(config(), { apiKey: 'old-key' });
    const original = fs.openSync.bind(fs);
    let replaced = false;
    vi.spyOn(fs, 'openSync').mockImplementation((file, ...args) => {
      if (file === config() && !replaced) {
        replaced = true;
        write(`${file}.new`, { apiKey: 'new-key' });
        fs.renameSync(`${file}.new`, file);
      }
      return original(file, ...args);
    });
    expect(snapshot()).toMatchObject({ config: { apiKey: 'new-key' }, configError: null });
  });

  it('refuses linked journal metadata and oversized journals before reading', () => {
    const id = randomUUID();
    const file = path.join(root, 'auth-operations', `${id}.json`);
    const outside = path.join(home, 'secret.json');
    write(outside, { id, generations: [] });
    fs.mkdirSync(path.dirname(file), { mode: 0o700 });
    fs.symlinkSync(outside, file);
    expect(renewalStatus(root, { selectionEpoch: id })).toBe('metadata_unreadable');
    fs.unlinkSync(file); fs.writeFileSync(file, ' '.repeat(4097), { mode: 0o600 });
    const read = vi.spyOn(fs, 'readFileSync');
    expect(renewalStatus(root, { selectionEpoch: id })).toBe('metadata_unreadable');
    expect(read).not.toHaveBeenCalled();
  });

  it('does not acquire a substituted authentication lock', async () => {
    const file = path.join(root, 'auth.lock');
    write(file, {});
    const outside = path.join(home, 'outside.lock'); write(outside, {});
    const original = fs.openSync.bind(fs);
    vi.spyOn(fs, 'openSync').mockImplementation((target, ...args) => {
      if (target === file) { fs.unlinkSync(file); fs.symlinkSync(outside, file); }
      return original(target, ...args);
    });
    const tryLock = vi.fn().mockReturnValue(true);
    const state = createAuthState({ directory: root, locks: async () => ({ tryLock, unlock: vi.fn() }), store: {} });
    await expect(state.logout()).rejects.toMatchObject({ code: 'AUTH_STATE_INVALID' });
    expect(tryLock).not.toHaveBeenCalled();
  });

  it('the real secure-store worker rejects a linked lock before accepting an operation', () => {
    const outside = path.join(home, 'outside.lock'); write(outside, {});
    fs.symlinkSync(outside, path.join(root, 'auth-store.lock'));
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../auth-store-worker.js', import.meta.url))], {
      input: `${JSON.stringify({ directory: root })}\n`, encoding: 'utf8', timeout: 3000,
    });
    expect(result.error).toBeUndefined();
    if (process.platform === 'win32') expect(result.status).toBe(1);
    else expect(result.signal).toBe('SIGKILL');
    expect(result.stdout).not.toContain('ready');
    expect(fs.readFileSync(outside, 'utf8')).toBe('{}');
  });
});

describe('managed trading files', () => {
  it('preserves quotes, bridge quotes, tx records and cache stats through a symlinked storage root', async () => {
    const storage = path.join(home, 'persistent'); fs.renameSync(root, storage); fs.symlinkSync(storage, root, 'dir');
    const id = saveQuote({ quotes: [] }, 'base');
    expect(loadQuote(id).quoteId).toBe(id);
    const claim = claimQuoteForExecution(id); claim.release();
    saveTxRecord('hash', { aggregator: 'relay' }); expect(loadTxRecord('hash').aggregator).toBe('relay');
    write(path.join(getQuotesDir(), 'bridge.json'), { type: 'bridge', timestamp: Date.now(), response: {} });
    expect(loadBridgeQuote('bridge').type).toBe('bridge');
    write(path.join(root, 'cache', `${'a'.repeat(64)}.json`), { timestamp: Date.now(), data: [] });
    vi.resetModules();
    const { collectCacheStats } = await import('../cache-inspect.js');
    expect(collectCacheStats().caches[0].entries).toBe(1);
  });

  it.each(['../config', 'nested/id', 'nested\\id', 'C:secret', 'id\0suffix'])('rejects quote path %s', id => {
    expect(safeQuotesPath(`${id}.json`)).toBeNull();
    expect(() => loadQuote(id)).toThrow('not found');
    expect(loadTxRecord(id)).toBeNull();
  });

  it.each(['symlink', 'hardlink', 'parent'])('refuses swap, bridge and tx files reached through a %s', kind => {
    const outside = path.join(home, 'outside'); fs.mkdirSync(outside);
    const file = path.join(outside, 'quote.json');
    write(file, { quoteId: 'linked', timestamp: Date.now(), response: {}, type: 'swap' });
    const dir = getQuotesDir();
    if (kind === 'parent') {
      fs.symlinkSync(outside, dir, 'dir');
      fs.copyFileSync(file, path.join(outside, 'linked.json'));
      fs.copyFileSync(file, path.join(outside, 'tx-linked.json'));
    } else {
      fs.mkdirSync(dir);
      for (const name of ['linked.json', 'tx-linked.json']) {
        if (kind === 'symlink') fs.symlinkSync(file, path.join(dir, name));
        else fs.linkSync(file, path.join(dir, name));
      }
    }
    const read = vi.spyOn(fs, 'readFileSync');
    expect(() => loadQuote('linked')).toThrow();
    expect(() => loadBridgeQuote('linked')).toThrow();
    expect(loadTxRecord('linked')).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it('keeps ordinary quote claims and transaction records working', () => {
    const id = saveQuote({ quotes: [] }, 'base');
    expect(loadQuote(id).quoteId).toBe(id);
    const claim = claimQuoteForExecution(id);
    expect(() => loadQuote(id)).toThrow('claimed');
    markQuoteExecuted(id, { broadcast: { txHash: 'hash' } });
    claim.release({ handedOff: true });
    expect(() => loadQuote(id)).toThrow('already executed');
    saveTxRecord('hash', { aggregator: 'relay', fromChain: 'base', toChain: 'solana' });
    expect(loadTxRecord('hash').aggregator).toBe('relay');
  });

  it('leaves a handed-off claim in place if its file is replaced by a symlink', () => {
    const id = saveQuote({ quotes: [] }, 'base');
    const claim = claimQuoteForExecution(id);
    const claimed = path.join(getQuotesDir(), `${id}.executing.json`);
    const outside = path.join(home, 'outside.json'); write(outside, { executedAt: Date.now() });
    fs.unlinkSync(claimed); fs.symlinkSync(outside, claimed);
    const read = vi.spyOn(fs, 'readFileSync');
    claim.release({ handedOff: true });
    expect(fs.lstatSync(claimed).isSymbolicLink()).toBe(true);
    expect(read).not.toHaveBeenCalled();
  });
});

describe('descriptor validation', () => {
  it('checks directory identity even when the file inode is unchanged', () => {
    const dir = path.join(root, 'nested'); const file = path.join(dir, 'state.json'); write(file, {});
    const original = fs.openSync.bind(fs);
    vi.spyOn(fs, 'openSync').mockImplementation((target, ...args) => {
      fs.renameSync(dir, `${dir}.original`); fs.mkdirSync(dir);
      fs.renameSync(path.join(`${dir}.original`, 'state.json'), file);
      return original(target, ...args);
    });
    const read = vi.spyOn(fs, 'readFileSync');
    expect(() => readLocalFile(file, { root })).toThrow(`at ${dir}: directory was replaced`);
    expect(read).not.toHaveBeenCalled();
  });

  it('rejects a symlink replacement even when no-follow is unavailable', () => {
    const file = config(); write(file, {});
    const original = fs.openSync.bind(fs);
    vi.spyOn(fs, 'openSync').mockImplementation((target, flags, mode) => {
      fs.renameSync(target, `${target}.original`);
      fs.symlinkSync(`${target}.original`, target);
      return original(target, flags & ~(fs.constants.O_NOFOLLOW ?? 0), mode);
    });
    const read = vi.spyOn(fs, 'readFileSync');
    expect(() => readLocalFile(file, { root })).toThrow('unsafe');
    expect(read).not.toHaveBeenCalled();
  });

  it('rejects a parent directory replaced during open', () => {
    const dir = path.join(root, 'nested'); const file = path.join(dir, 'state.json'); write(file, {});
    const outside = path.join(home, 'outside'); write(path.join(outside, 'state.json'), {});
    const original = fs.openSync.bind(fs);
    vi.spyOn(fs, 'openSync').mockImplementation((target, ...args) => {
      fs.renameSync(dir, `${dir}.original`); fs.symlinkSync(outside, dir, 'dir');
      return original(target, ...args);
    });
    const read = vi.spyOn(fs, 'readFileSync');
    expect(() => readLocalFile(file, { root })).toThrow('unsafe');
    expect(read).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32')('refuses a FIFO substituted at open without blocking', () => {
    const file = config(); write(file, {});
    const original = fs.openSync.bind(fs);
    vi.spyOn(fs, 'openSync').mockImplementation((target, ...args) => {
      fs.renameSync(target, `${target}.original`);
      expect(spawnSync('mkfifo', [target]).status).toBe(0);
      return original(target, ...args);
    });
    const read = vi.spyOn(fs, 'readFileSync');
    expect(() => readLocalFile(file, { root })).toThrow('unsafe');
    expect(read).not.toHaveBeenCalled();
  });

  it('closes a rejected descriptor and rejects traversal outside the root', () => {
    const file = config(); write(file, {});
    const original = fs.fstatSync.bind(fs);
    vi.spyOn(fs, 'fstatSync').mockImplementation(fd => ({ ...original(fd), isFile: () => false }));
    const close = vi.spyOn(fs, 'closeSync');
    expect(() => readLocalFile(file, { root })).toThrow('unsafe');
    expect(close).toHaveBeenCalledTimes(1);
    expect(() => openLocalFile(path.join(home, 'outside.json'), { root })).toThrow('unsafe');
  });
});
