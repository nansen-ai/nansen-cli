import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { AuthError, authDirectory, validAuthPointer } from './auth-credentials.js';
import { createAuthStore } from './auth-store.js';
import { refreshSession, retireSession, validateSession } from './auth-device.js';

const queues = new Map();
const recognizedJournal = name => /^[a-f0-9-]{36}\.json$/.test(name);
const journalError = () => new AuthError('AUTH_JOURNAL_INVALID', 'Authentication recovery cannot safely read auth-operations. Preserve its files and secure-store entries. Stop all CLI authentication processes, restore only a known-valid journal backup for this state, or contact support using docs/browser-login.md#damaged-or-unrecognized-journals.');
const journalExists = file => {
  try { return Boolean(fs.lstatSync(file, { throwIfNoEntry: false })); }
  catch { throw journalError(); }
};
const stateError = () => new AuthError('AUTH_STATE_INVALID', 'Saved authentication cannot be read safely. Repair config.json permissions or restore the file; no other credential was selected.');
function safePath(file, directory = false) {
  if (!fs.existsSync(file)) return;
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) ||
      (process.platform !== 'win32' && ((stat.mode & 0o022) || stat.uid !== process.getuid()))) throw stateError();
}
const uuid = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
function readJournal(file, id) {
  try {
    safePath(file);
    if (fs.statSync(file).size > 4096) throw journalError();
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value?.id !== id) throw journalError();
    if (value.kind === 'rotation') {
      if (value.version !== 2 || value.id !== value.selectionEpoch || !uuid(value.selectionEpoch) ||
          !uuid(value.sourceGeneration) || !uuid(value.targetGeneration) || value.sourceGeneration === value.targetGeneration ||
          !['in_flight', 'ready', 'blocked', 'retryable', 'retired'].includes(value.phase) ||
          (value.phase === 'blocked' ? !['uncertain', 'rejected', 'setup', 'clock', 'expired', 'protocol'].includes(value.reason) : value.reason !== undefined) ||
          (value.phase === 'retryable' ? !Number.isFinite(value.retryNotBefore) || value.retryNotBefore < 0 : value.retryNotBefore !== undefined) ||
          (value.phase === 'retired' ? !['unconfirmed', 'recorded_pending', 'refresh_only'].includes(value.remote) : value.remote !== undefined) ||
          Object.keys(value).some(k => !['version', 'id', 'kind', 'selectionEpoch', 'sourceGeneration', 'targetGeneration', 'phase', 'reason', 'retryNotBefore', 'remote'].includes(k))) throw journalError();
    } else if (value.kind !== undefined || value.version !== undefined || !Array.isArray(value.generations) || value.generations.length > 2 || value.generations.some(g => !uuid(g)) ||
        (value.blockedBy !== undefined && (!uuid(value.blockedBy) || value.blockedBy === value.id)) ||
        (value.unissued !== undefined && typeof value.unissued !== 'boolean') || (value.candidateRemote !== undefined && !['unconfirmed', 'recorded_pending', 'refresh_only'].includes(value.candidateRemote))) throw journalError();
    return value;
  } catch { throw journalError(); }
}
// Metadata-only: never locks, opens secure storage, recovers, or contacts the issuer.
export function renewalStatus(directory, selection) {
  try {
    if (!uuid(selection.selectionEpoch)) return 'metadata_unreadable';
    const file = path.join(directory, 'auth-operations', `${selection.selectionEpoch}.json`);
    safePath(directory, true); safePath(path.dirname(file), true);
    if (!journalExists(file)) return 'not_recorded';
    const journal = readJournal(file, selection.selectionEpoch);
    if (journal.kind !== 'rotation') return 'metadata_unreadable';
    return { in_flight: 'pending_or_uncertain', ready: 'ready_local_recovery', blocked: 'login_required', retryable: 'retryable' }[journal.phase] || 'metadata_unreadable';
  } catch { return 'metadata_unreadable'; }
}
function timedSignal(parent, ms, code) {
  const controller = new AbortController();
  const cancel = () => controller.abort(new AuthError('AUTH_CANCELLED', 'Authentication operation cancelled. Retry the command.'));
  parent?.addEventListener('abort', cancel, { once: true });
  if (parent?.aborted) cancel();
  const timer = setTimeout(() => controller.abort(new AuthError(code, code === 'AUTH_BUSY' ? 'Another authentication operation is running. Retry after it finishes.' : 'Authentication operation timed out. Retry the command; an uncertain renewal requires login.')), ms);
  return { signal: controller.signal, close() { clearTimeout(timer); parent?.removeEventListener('abort', cancel); } };
}
async function waitTurn(previous, signal) {
  signal.throwIfAborted();
  let cancel;
  try {
    await Promise.race([previous, new Promise((_, reject) => {
      cancel = () => reject(signal.reason);
      signal.addEventListener('abort', cancel, { once: true });
    })]);
    signal.throwIfAborted();
  } finally { signal.removeEventListener('abort', cancel); }
}
async function loadLocks() {
  try { return (await import('fs-native-extensions')).default; }
  catch { throw new AuthError('AUTH_LOCK_UNAVAILABLE', 'Native authentication locking is unavailable. Reinstall nansen-cli with optional dependencies to save or remove authentication. Legacy key setup and logout also require this binding. Environment API keys still work. For offline saved-key removal, stop every CLI/auth process, then follow docs/browser-login.md#offline-recovery-without-native-locking. Do not delete auth journals or wallet files.'); }
}
export function createAuthState({ directory = authDirectory(), store = createAuthStore({ directory }), retire = retireSession, refresh = refreshSession, now = Date.now, barrier = async () => {}, locks = loadLocks, waitMs = 15000, operationMs = 60000 } = {}) {
  let operationSignal;
  const options = () => ({ signal: operationSignal });
  const check = () => operationSignal?.throwIfAborted();
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
      if (!value || typeof value !== 'object' || Array.isArray(value) || (value.auth && !validAuthPointer(value.auth))) throw new Error();
      return value;
    } catch { throw stateError(); }
  }
  async function atomic(file, value) {
    check();
    safePath(file);
    const temp = `${file}.${randomUUID()}.tmp`;
    let fd;
    try {
      fd = fs.openSync(temp, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify(value, null, 2));
      await barrier('before-flush', path.basename(file)); check();
      fs.fsyncSync(fd);
      fs.closeSync(fd); fd = undefined;
      await barrier('before-rename', path.basename(file)); check();
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
    signal?.throwIfAborted();
    const native = await locks();
    signal?.throwIfAborted();
    safePath(file);
    const fd = fs.openSync(file, 'a+', 0o600);

    try {
      while (!native.tryLock(fd)) {
        if (!wait) { fs.closeSync(fd); return null; }
        signal?.throwIfAborted();
        await delay(50, undefined, { signal });
      }
      return () => { try { native.unlock(fd); } finally { fs.closeSync(fd); } };
    } catch (error) { fs.closeSync(fd); throw error; }
  }
  async function locked(fn, signal) {
    const previous = queues.get(directory) || Promise.resolve();
    let finish;
    const done = new Promise(resolve => { finish = resolve; });
    // A cancelled waiter must not allow a later waiter to overtake the owner.
    const tail = previous.then(() => done);
    queues.set(directory, tail);
    const waiting = timedSignal(signal, waitMs, 'AUTH_BUSY');
    let release, budget;
    try {
      await waitTurn(previous, waiting.signal);
      prepare();
      release = await acquire(path.join(directory, 'auth.lock'), waiting.signal);
      waiting.close();
      budget = timedSignal(signal, operationMs, 'AUTH_TIMEOUT');
      operationSignal = budget.signal;
      check();
      return await fn();
    } catch (error) {
      if (budget?.signal.aborted) throw budget.signal.reason;
      if (waiting.signal.aborted) throw waiting.signal.reason;
      throw error;
    } finally {
      if (budget) { budget.close(); operationSignal = undefined; }
      waiting.close(); release?.(); finish();
      tail.then(() => { if (queues.get(directory) === tail) queues.delete(directory); });
    }
  }
  const journalPath = id => path.join(journalDir, `${id}.json`);
  async function cleanupGeneration(generation, knownRemote) {
    let remote = knownRemote || 'unconfirmed';
    if (!knownRemote) {
      try { remote = (await retire(await store.read(generation, options()), options())).remote; } catch { /* absence alone never proves no issuance */ }
    }
    try { await store.remove(generation, options()); return { remote, local: 'removed' }; }
    catch { return { remote, local: 'incomplete' }; }
  }
  async function cleanJournal(journal, config) {
    if (journal.kind === 'rotation') return cleanRotation(journal, config);
    // Deselection retained this known source while damaged metadata may hide
    // another generation. Never discharge it ahead of that journal.
    if (journal.blockedBy && journalExists(journalPath(journal.blockedBy))) return [{ local: 'incomplete', remote: 'unconfirmed', code: 'AUTH_JOURNAL_INVALID' }];
    const activeRotation = config.auth?.active?.kind === 'session' ? rotationFor(config) : null;
    const outcomes = [];
    const pending = [];
    for (const generation of journal.generations) {
      check();
      if (config.auth?.active?.generation === generation || (activeRotation && [activeRotation.sourceGeneration, activeRotation.targetGeneration].includes(generation))) continue;
      const knownRemote = generation === journal.id ? (journal.unissued === true ? 'not_needed' : journal.candidateRemote) : undefined;
      const result = await cleanupGeneration(generation, knownRemote);
      outcomes.push(result);
      if (result.local !== 'removed') pending.push(generation);
    }
    if (pending.length) await atomic(journalPath(journal.id), { ...journal, generations: pending });
    else fs.unlinkSync(journalPath(journal.id));
    // A delayed finish() must not resurrect already discharged references.
    journal.generations = pending;
    return outcomes;
  }
  async function recover() {
    read(); // Reject unsupported pointers before any recovery mutation.
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
      check();
      const id = file.slice(0, -5);
      const release = await acquire(path.join(journalDir, `${id}.lock`), operationSignal, false);
      if (!release) continue;
      try {
        const journal = readJournal(path.join(journalDir, file), id);
        results.push(...await cleanJournal(journal, read()));
      } finally { release(); }
    }
    // Only the global lock owner can discover/remove attempt-lock paths. Never
    // unlink a live inode: a paused process still owns it regardless of age.
    for (const file of fs.readdirSync(journalDir).filter(f => /^[a-f0-9-]{36}\.lock$/.test(f))) {
      if (fs.existsSync(journalPath(file.slice(0, -5)))) continue;
      const lockFile = path.join(journalDir, file);
      const release = await acquire(lockFile, operationSignal, false);
      if (release) { release(); fs.unlinkSync(lockFile); }
    }
    if (fs.readdirSync(journalDir).some(recognizedJournal)) results.push({ local: 'pending', remote: 'not_attempted' });
    if (fs.readdirSync(journalDir).some(f => f.endsWith('.json') && !recognizedJournal(f))) results.push({ local: 'unrecognized', remote: 'not_attempted' });
    return results;
  }
  function rotationFor(config) {
    const epoch = config.auth?.selectionEpoch;
    if (!uuid(epoch) || !journalExists(journalPath(epoch))) return null;
    const journal = readJournal(journalPath(epoch), epoch);
    if (journal.kind !== 'rotation' || config.auth.version !== 2 || config.auth.active.kind !== 'session' || ![journal.sourceGeneration, journal.targetGeneration].includes(config.auth.active.generation)) throw stateError();
    return journal;
  }
  function assertSelection(config, selection) {
    const active = config.auth?.active;
    if (active?.kind !== 'session' || config.auth.selectionEpoch !== selection.selectionEpoch || ['accountId', 'issuer', 'audience'].some(k => active[k] !== selection[k])) throw new AuthError('AUTH_SELECTION_CHANGED', 'Saved authentication changed. Run the command again.');
  }
  const blockedReason = error => ({ SESSION_REFRESH_REJECTED: 'rejected', BROWSER_SESSION_SETUP_REQUIRED: 'setup', SESSION_CLOCK_SKEW: 'clock', SESSION_EXPIRED: 'expired', SESSION_REFRESH_PROTOCOL_ERROR: 'protocol' }[error.code] || 'uncertain');
  function renewalError(reason) {
    if (reason === 'setup') return new AuthError('BROWSER_SESSION_SETUP_REQUIRED', 'The renewed session has incompatible issuer setup. Ask the operator to verify the supported 3600-second lifetime, SESSION_ACCESS_REVOCATION_ENABLED and BROWSER_SESSION_ACCOUNT_ENABLED. Renewal may have consumed the credential; do not retry it. Pair again only after server setup is repaired.');
    if (reason === 'clock') return new AuthError('SESSION_CLOCK_SKEW', 'The renewed session is ahead of the local clock. Synchronize system time, then run nansen login. The possibly consumed refresh credential will not be retried.');
    if (reason === 'expired') return new AuthError('SESSION_EXPIRED', 'The renewed access token was already expired. Check system time and issuer configuration, then run nansen login. The possibly consumed refresh credential will not be retried.');
    if (reason === 'protocol') return new AuthError('SESSION_REFRESH_PROTOCOL_ERROR', 'The issuer rejected the refresh request format. Check CLI/issuer compatibility with the operator before running nansen login. The request will not be retried.');
    return reason === 'rejected' ? new AuthError('SESSION_REFRESH_REJECTED', 'The saved session cannot be renewed. Run: nansen login.') : new AuthError('SESSION_RENEWAL_UNCERTAIN', 'Session renewal outcome is unknown. Run: nansen login. The saved refresh credential was not retried.');
  }
  async function readBundle(generation, active) {
    const bundle = await store.read(generation, options());
    validateSession(bundle, now(), { allowExpired: true });
    if (['issuer', 'audience', 'accountId'].some(k => bundle[k] !== active[k])) throw stateError();
    return bundle;
  }
  async function publishRotation(journal, bundle, config) {
    check();
    if (config.auth.selectionEpoch !== journal.selectionEpoch || config.auth.active.generation !== journal.sourceGeneration) throw stateError();
    const next = { ...config, auth: { ...config.auth, version: 2, active: { ...config.auth.active, generation: journal.targetGeneration, expiresAt: bundle.expiresAt } } };
    try { await atomic(configFile, next); }
    catch (error) {
      const observed = read();
      if (observed.auth?.selectionEpoch !== journal.selectionEpoch || observed.auth?.active?.generation !== journal.targetGeneration) throw error;
    }
    await barrier('rotation-committed');
  }
  async function recoverSelectedRotation(journal, config) {
    if (config.auth.active.generation === journal.targetGeneration) { await cleanRotation(journal, config); return; }
    if (journal.phase === 'blocked' || journal.phase === 'retryable') return;
    let target;
    try { target = await readBundle(journal.targetGeneration, config.auth.active); }
    catch (error) {
      // An inaccessible store is not evidence that the response was lost.
      if (!error.missing && error.code === 'AUTH_STORE_UNAVAILABLE') throw error;
      if (operationSignal.aborted) throw operationSignal.reason;
      await atomic(journalPath(journal.id), { ...journal, phase: 'blocked', reason: blockedReason(error) });
      return;
    }
    const source = await readBundle(journal.sourceGeneration, config.auth.active);
    if (JSON.stringify(target.privateJwk) !== JSON.stringify(source.privateJwk) || target.refreshToken === source.refreshToken || target.accessToken === source.accessToken) throw stateError();
    await publishRotation(journal, target, config);
    await cleanRotation(journal, read());
  }
  async function cleanRotation(journal, config) {
    const sameChoice = config.auth?.selectionEpoch === journal.selectionEpoch;
    if (sameChoice && config.auth?.active?.generation === journal.sourceGeneration) return [];
    if (sameChoice && config.auth?.active?.generation !== journal.targetGeneration) throw stateError();
    let remote = 'not_needed';
    if (sameChoice && journal.phase === 'retired') throw stateError();
    if (!sameChoice && journal.phase === 'retired') remote = journal.remote;
    if (!sameChoice && journal.phase !== 'retired') {
      // Actual logout/replacement: retain both blobs until a readable authority
      // has had its retirement attempt. A consumed parent is supported by IdP.
      remote = 'unconfirmed';
      let authority;
      for (const generation of [journal.targetGeneration, journal.sourceGeneration]) {
        check();
        try { authority = await store.read(generation, options()); break; } catch { /* try retained parent */ }
      }
      if (!authority) return [{ remote, local: 'incomplete' }];
      try { remote = (await retire(authority, options())).remote; } catch { /* remote remains unconfirmed */ }
      const retired = { ...journal, phase: 'retired', remote };
      delete retired.reason; delete retired.retryNotBefore;
      await atomic(journalPath(journal.id), retired);
    }
    const generations = sameChoice ? [journal.sourceGeneration] : [journal.sourceGeneration, journal.targetGeneration];
    try {
      for (const generation of generations) { check(); await store.remove(generation, options()); }
      fs.unlinkSync(journalPath(journal.id));
      return [{ remote, local: 'removed' }];
    } catch { return [{ remote, local: 'incomplete' }]; }
  }
  return {
    async begin({ preflight = true, signal } = {}) {
      return locked(async () => {
        const cleanup = await recover();
        if (fs.readdirSync(journalDir).filter(recognizedJournal).length >= 8) throw new AuthError('AUTH_CLEANUP_REQUIRED', 'Unlock the credential store and run nansen logout to finish cleanup.');
        const id = randomUUID();
        const epoch = read().auth?.selectionEpoch ?? null;
        const release = await acquire(path.join(journalDir, `${id}.lock`), operationSignal);
        const journal = { id, generations: preflight ? [id] : [], unissued: true };
        const attempt = { id, epoch, release, journal, cleanup };
        try {
          await atomic(journalPath(id), journal);
          await barrier('journal');
          if (preflight) await store.preflight(id, options());
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
          await store.write(attempt.id, bundle, options()); await barrier('stored');
        }
        const old = config.auth?.active;
        attempt.journal.generations = [...(bundle ? [attempt.id] : []), ...(old?.kind === 'session' && !rotationFor(config) ? [old.generation] : [])];
        await atomic(journalPath(attempt.id), attempt.journal);
        const active = bundle ? { kind: 'session', generation: attempt.id, issuer: bundle.issuer, audience: bundle.audience, accountId: bundle.accountId, expiresAt: bundle.expiresAt } : { kind: 'api-key' };
        const epoch = randomUUID();
        const next = { ...config, baseUrl, auth: { version: config.auth?.version || 1, selectionEpoch: epoch, active } };
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
        const cleanup = await cleanJournal(attempt.journal, read());
        cleanup.push(...await recover());
        return { cleanup, active };
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
        let damagedRotation;
        if (old?.kind === 'session') {
          let rotation;
          try { rotation = rotationFor(config); }
          catch (error) {
            if (!['AUTH_JOURNAL_INVALID', 'AUTH_STATE_INVALID'].includes(error.code)) throw error;
            damagedRotation = error.code;
          }
          if (!rotation) await atomic(journalPath(id), { id, generations: [old.generation], ...(damagedRotation && { blockedBy: config.auth.selectionEpoch }) });
        }
        const next = { ...config, auth: { version: config.auth?.version || 1, selectionEpoch: randomUUID(), active: { kind: 'none' } } };
        delete next.apiKey;
        try { await atomic(configFile, next); }
        catch (error) { if (read().auth?.selectionEpoch !== next.auth.selectionEpoch) throw error; }
        let cleanup;
        try { await barrier('logout-committed'); cleanup = damagedRotation ? [{ local: 'incomplete', remote: 'unconfirmed', code: damagedRotation }] : await recover(); }
        catch (error) { cleanup = [{ local: 'incomplete', remote: 'unconfirmed', ...(error.code === 'AUTH_JOURNAL_INVALID' && { code: error.code }) }]; }
        return { removed: Boolean(config.apiKey || old?.kind === 'session'), cleanup };
      });
    },
    async acquireSession(selection, { audience, signal } = {}) {
      if (selection.audience !== audience) throw new AuthError('AUTH_ORIGIN_MISMATCH', 'The saved session does not match the selected API origin. Check NANSEN_BASE_URL or run nansen login.');
      return locked(async () => {
        let config = read();
        assertSelection(config, selection);
        // Validate the prospective format before any typed path or mutation.
        if (!validAuthPointer({ ...config.auth, version: 2 })) throw stateError();
        let journal = rotationFor(config);
        if (journal) await recoverSelectedRotation(journal, config);
        config = read();
        assertSelection(config, selection);
        let bundle = await readBundle(config.auth.active.generation, config.auth.active);
        journal = rotationFor(config);
        if (journal?.phase === 'blocked') throw renewalError(journal.reason);
        if (journal?.phase === 'retryable' && journal.retryNotBefore > now()) {
          if (bundle.expiresAt <= now()) throw new AuthError('SESSION_REFRESH_RETRYABLE', 'Session renewal is rate limited or temporarily refused. Retry later.');
          validateSession(bundle, now());
          return bundle;
        }
        if (bundle.expiresAt - now() > 60000) return bundle;
        // An obsolete generation must be removed before creating another one.
        if (journal && config.auth.active.generation === journal.targetGeneration) throw new AuthError('AUTH_CLEANUP_REQUIRED', 'Renewal cleanup is incomplete. Unlock secure storage and retry.');
        if (!journal) {
          // Discharge pre-renewal pairing journals while this generation is
          // still active. An old journal must never later retire it as obsolete.
          await recover();
          const files = fs.readdirSync(journalDir).filter(recognizedJournal);
          if (files.length <= 8 && files.some(file => readJournal(path.join(journalDir, file), file.slice(0, -5)).generations?.includes(config.auth.active.generation))) throw new AuthError('AUTH_BUSY', 'Login cleanup is still running. Retry after it finishes.');
          if (files.length >= 8) throw new AuthError('AUTH_CLEANUP_REQUIRED', 'Authentication cleanup is pending. Run nansen logout after unlocking secure storage.');
          if (config.auth.version !== 2) {
            config = { ...config, auth: { ...config.auth, version: 2 } };
            await atomic(configFile, config);
          }
          journal = { version: 2, kind: 'rotation', id: config.auth.selectionEpoch, selectionEpoch: config.auth.selectionEpoch, sourceGeneration: config.auth.active.generation, targetGeneration: randomUUID(), phase: 'in_flight' };
        } else {
          journal = { ...journal, phase: 'in_flight' }; delete journal.retryNotBefore;
        }
        // No consumptive call until the marker and v2 pointer barrier are durable.
        await atomic(journalPath(journal.id), journal);
        await barrier('rotation-marked'); check();
        let replacement;
        try { replacement = await refresh(bundle, { ...options(), now }); }
        catch (error) {
          const phase = error.code === 'SESSION_REFRESH_RETRYABLE' ? 'retryable' : 'blocked';
          const next = { ...journal, phase, ...(phase === 'retryable' ? { retryNotBefore: error.retryNotBefore } : { reason: blockedReason(error) }) };
          await atomic(journalPath(journal.id), next);
          if (phase === 'retryable') throw new AuthError('SESSION_REFRESH_RETRYABLE', 'Session renewal was refused before rotation. Check system time and retry later.');
          throw renewalError(next.reason);
        }
        check();
        await barrier('rotation-received');
        // The transport validated the response. Readback/restart validates again.
        try { await store.write(journal.targetGeneration, replacement, options()); }
        catch { throw new AuthError('SESSION_RENEWAL_STORAGE_ERROR', 'Could not store the renewed session. Retry the command to recover a complete replacement, or run nansen login. The old refresh credential will not be retried.'); }
        await barrier('rotation-stored'); check();
        journal.phase = 'ready';
        await atomic(journalPath(journal.id), journal);
        await publishRotation(journal, replacement, config);
        await cleanRotation(journal, read());
        bundle = { ...replacement, version: 1, generation: journal.targetGeneration };
        check(); validateSession(bundle, now());
        return bundle;
      }, signal);
    },
  };
}
