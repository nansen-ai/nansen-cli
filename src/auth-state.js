import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { AuthError, authDirectory } from './auth-credentials.js';
import { createAuthStore } from './auth-store.js';

const queues = new Map();
const recognizedJournal = name => /^[a-f0-9-]{36}\.json$/.test(name);
const journalError = () => new AuthError('AUTH_JOURNAL_INVALID', 'Authentication recovery cannot safely read auth-operations. Preserve its files and secure-store entries. Stop all CLI authentication processes, restore only a known-valid journal backup for this state, or contact support using docs/browser-login.md#damaged-or-unrecognized-journals.');
const stateError = () => new AuthError('AUTH_STATE_INVALID', 'Saved authentication cannot be read safely. Repair config.json permissions or restore the file; no other credential was selected.');
function safePath(file, directory = false) {
  if (!fs.existsSync(file)) return;
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) ||
      (process.platform !== 'win32' && ((stat.mode & 0o022) || stat.uid !== process.getuid()))) throw stateError();
}
async function loadLocks() {
  try { return (await import('fs-native-extensions')).default; }
  catch { throw new AuthError('AUTH_LOCK_UNAVAILABLE', 'Native authentication locking is unavailable. Reinstall nansen-cli with optional dependencies to save or remove authentication. Legacy key setup and logout also require this binding. Environment API keys still work. For offline saved-key removal, stop every CLI/auth process, then follow docs/browser-login.md#offline-recovery-without-native-locking. Do not delete auth journals or wallet files.'); }
}
export function createAuthState({ directory = authDirectory(), store = createAuthStore({ directory }), retire = async () => ({ remote: 'unconfirmed' }), barrier = async () => {}, locks = loadLocks } = {}) {
  const configFile = path.join(directory, 'config.json');
  const journalDir = path.join(directory, 'auth-operations');
  function prepare() {
    safePath(directory, true);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    safePath(journalDir, true);
    fs.mkdirSync(journalDir, { mode: 0o700, recursive: true });
  }
  function read() {
    safePath(configFile);
    if (!fs.existsSync(configFile)) return {};
    try {
      const value = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value) || (value.auth && (value.auth.version !== 1 || !['none', 'api-key', 'session'].includes(value.auth.active?.kind)))) throw new Error();
      return value;
    } catch { throw stateError(); }
  }
  async function atomic(file, value) {
    safePath(file);
    const temp = `${file}.${randomUUID()}.tmp`;
    let fd;
    try {
      fd = fs.openSync(temp, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify(value, null, 2));
      await barrier('before-flush', path.basename(file));
      fs.fsyncSync(fd);
      fs.closeSync(fd); fd = undefined;
      await barrier('before-rename', path.basename(file));
      fs.renameSync(temp, file);
      await barrier('after-rename', path.basename(file));
      if (process.platform !== 'win32') {
        const dirFd = fs.openSync(path.dirname(file), 'r');
        try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
      }
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(temp); } catch { /* rename may already have committed */ }
    }
  }
  async function acquire(file, signal, wait = true) {
    const native = await locks();
    safePath(file);
    const fd = fs.openSync(file, 'a+', 0o600);
    const deadline = Date.now() + 15000;
    try {
      while (!native.tryLock(fd)) {
        if (!wait) { fs.closeSync(fd); return null; }
        if (Date.now() >= deadline) throw new AuthError('AUTH_BUSY', 'Another authentication operation is running. Retry after it finishes.');
        await delay(50, undefined, { signal });
      }
      return () => { try { native.unlock(fd); } finally { fs.closeSync(fd); } };
    } catch (error) { fs.closeSync(fd); throw error; }
  }
  async function locked(fn, signal) {
    const previous = queues.get(directory) || Promise.resolve();
    let finish;
    const tail = new Promise(resolve => { finish = resolve; });
    queues.set(directory, tail);
    await previous;
    let release;
    try { signal?.throwIfAborted(); prepare(); release = await acquire(path.join(directory, 'auth.lock'), signal); return await fn(); }
    finally { release?.(); finish(); if (queues.get(directory) === tail) queues.delete(directory); }
  }
  const journalPath = id => path.join(journalDir, `${id}.json`);
  async function cleanupGeneration(generation, knownRemote) {
    let remote = knownRemote || 'unconfirmed';
    if (!knownRemote) {
      try { remote = (await retire(await store.read(generation))).remote; } catch { /* absence alone never proves no issuance */ }
    }
    try { await store.remove(generation); return { remote, local: 'removed' }; }
    catch { return { remote, local: 'incomplete' }; }
  }
  async function cleanJournal(journal, config) {
    const outcomes = [];
    const pending = [];
    for (const generation of journal.generations) {
      if (config.auth?.active?.generation === generation) continue;
      const knownRemote = generation === journal.id ? (journal.unissued === true ? 'not_needed' : journal.candidateRemote) : undefined;
      const result = await cleanupGeneration(generation, knownRemote);
      outcomes.push(result);
      if (result.local !== 'removed') pending.push(generation);
    }
    if (pending.length) await atomic(journalPath(journal.id), { ...journal, generations: pending });
    else fs.unlinkSync(journalPath(journal.id));
    return outcomes;
  }
  async function recover() {
    const results = [];
    // The global lock proves no writer is using these same-directory staging
    // files. Remove crash leftovers, including explicit legacy-key saves.
    for (const [dir, pattern] of [
      [directory, /^config\.json\.[a-f0-9-]{36}\.tmp$/],
      [journalDir, /^[a-f0-9-]{36}\.json\.[a-f0-9-]{36}\.tmp$/],
    ]) {
      for (const file of fs.readdirSync(dir).filter(name => pattern.test(name))) {
        const target = path.join(dir, file); safePath(target); fs.unlinkSync(target);
      }
    }
    const files = fs.readdirSync(journalDir).filter(recognizedJournal);
    // Drain a bounded batch even from pre-existing over-limit directories.
    // Admission is capped separately; logout must always be able to recover.
    for (const file of files.slice(0, 8)) {
      const id = file.slice(0, -5);
      const release = await acquire(path.join(journalDir, `${id}.lock`), undefined, false);
      if (!release) continue;
      try {
        let journal;
        try {
          safePath(path.join(journalDir, file));
          journal = JSON.parse(fs.readFileSync(path.join(journalDir, file), 'utf8'));
        } catch { throw journalError(); }
        if (!journal || journal.id !== id || !Array.isArray(journal.generations) || journal.generations.length > 2 || journal.generations.some(g => typeof g !== 'string' || !/^[a-f0-9-]{36}$/.test(g)) || (journal.unissued !== undefined && typeof journal.unissued !== 'boolean') || (journal.candidateRemote !== undefined && !['unconfirmed', 'recorded_pending', 'refresh_only'].includes(journal.candidateRemote))) throw journalError();
        results.push(...await cleanJournal(journal, read()));
      } finally { release(); }
    }
    // Only the global lock owner can discover/remove attempt-lock paths. Never
    // unlink a live inode: a paused process still owns it regardless of age.
    for (const file of fs.readdirSync(journalDir).filter(f => /^[a-f0-9-]{36}\.lock$/.test(f))) {
      if (fs.existsSync(journalPath(file.slice(0, -5)))) continue;
      const lockFile = path.join(journalDir, file);
      const release = await acquire(lockFile, undefined, false);
      if (release) { release(); fs.unlinkSync(lockFile); }
    }
    if (fs.readdirSync(journalDir).some(recognizedJournal)) results.push({ local: 'pending', remote: 'not_attempted' });
    if (fs.readdirSync(journalDir).some(f => f.endsWith('.json') && !recognizedJournal(f))) results.push({ local: 'unrecognized', remote: 'not_attempted' });
    return results;
  }
  return {
    async begin({ preflight = true, signal } = {}) {
      return locked(async () => {
        const cleanup = await recover();
        if (fs.readdirSync(journalDir).filter(recognizedJournal).length >= 8) throw new AuthError('AUTH_CLEANUP_REQUIRED', 'Unlock the credential store and run nansen logout to finish cleanup.');
        const id = randomUUID();
        const epoch = read().auth?.selectionEpoch ?? null;
        const release = await acquire(path.join(journalDir, `${id}.lock`), signal);
        const journal = { id, generations: preflight ? [id] : [], unissued: true };
        const attempt = { id, epoch, release, journal, cleanup };
        try {
          await atomic(journalPath(id), journal);
          await barrier('journal');
          if (preflight) await store.preflight(id);
          return attempt;
        } catch (err) {
          try { await cleanJournal(journal, read()); } catch { /* preserve original failure and any remaining journal */ } finally { release(); }
          throw err;
        }
      }, signal);
    },
    async markIssuancePossible(attempt, signal) {
      signal?.throwIfAborted();
      if (attempt.journal.unissued === false) return;
      return locked(async () => {
        if (attempt.journal.unissued === false) return;
        const journal = { ...attempt.journal, unissued: false };
        await atomic(journalPath(attempt.id), journal);
        attempt.journal = journal;
      }, signal);
    },
    async install(attempt, { bundle, apiKey, baseUrl }, signal) {
      return locked(async () => {
        const config = read();
        if ((config.auth?.selectionEpoch ?? null) !== attempt.epoch) throw new AuthError('AUTH_SELECTION_CHANGED', 'Another login or logout changed the saved credential. This attempt was not installed.');
        signal?.throwIfAborted();
        if (bundle) {
          attempt.journal.unissued = false;
          await atomic(journalPath(attempt.id), attempt.journal);
          await store.write(attempt.id, bundle); await barrier('stored');
        }
        const old = config.auth?.active;
        attempt.journal.generations = [...(bundle ? [attempt.id] : []), ...(old?.kind === 'session' ? [old.generation] : [])];
        await atomic(journalPath(attempt.id), attempt.journal);
        const active = bundle ? { kind: 'session', generation: attempt.id, issuer: bundle.issuer, audience: bundle.audience, accountId: bundle.accountId, expiresAt: bundle.expiresAt } : { kind: 'api-key' };
        const epoch = randomUUID();
        const next = { ...config, baseUrl, auth: { version: 1, selectionEpoch: epoch, active } };
        delete next.apiKey;
        if (!bundle) next.apiKey = apiKey;
        signal?.throwIfAborted();
        try { await atomic(configFile, next); }
        catch (error) {
          // rename may have succeeded even though fsync/acknowledgement failed.
          let observed;
          try { observed = read().auth?.selectionEpoch; } catch { attempt.uncertain = true; throw stateError(); }
          if (observed !== epoch) throw error;
        }
        attempt.committed = true;
        await barrier('committed');
        return { cleanup: await cleanJournal(attempt.journal, read()), active };
      }, signal);
    },
    async finish(attempt) {
      try { if (attempt.uncertain) return [{ local: 'incomplete', remote: 'unconfirmed' }]; return await locked(async () => fs.existsSync(journalPath(attempt.id)) ? cleanJournal(attempt.journal, read()) : []); }
      finally { attempt.release(); }
    },
    async logout() {
      return locked(async () => {
        const config = read();
        const old = config.auth?.active;
        const id = randomUUID();
        if (old?.kind === 'session') await atomic(journalPath(id), { id, generations: [old.generation] });
        const next = { ...config, auth: { version: 1, selectionEpoch: randomUUID(), active: { kind: 'none' } } };
        delete next.apiKey;
        try { await atomic(configFile, next); }
        catch (error) { if (read().auth?.selectionEpoch !== next.auth.selectionEpoch) throw error; }
        let cleanup;
        try { await barrier('logout-committed'); cleanup = await recover(); }
        catch (error) { cleanup = [{ local: 'incomplete', remote: 'unconfirmed', ...(error.code === 'AUTH_JOURNAL_INVALID' && { code: error.code }) }]; }
        return { removed: Boolean(config.apiKey || old?.kind === 'session'), cleanup };
      });
    },
    async readSession(selection) {
      return locked(async () => {
        const config = read();
        const active = config.auth?.active;
        if (active?.kind !== 'session' || config.auth.selectionEpoch !== selection.selectionEpoch || active.generation !== selection.generation) throw new AuthError('AUTH_SELECTION_CHANGED', 'Saved authentication changed. Run the command again.');
        return store.read(active.generation);
      });
    },
  };
}
