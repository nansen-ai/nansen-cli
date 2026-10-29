/**
 * Wallet mutations run in separate processes against one ~/.nansen/wallets.
 * The worker fixtures make two processes read config.json (and scan the
 * wallets directory) at the same moment unless the lock already serialises
 * them, which is how the lost-update race reproduces without the lock.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const worker = fileURLToPath(new URL('./fixtures/wallet-concurrency-worker.mjs', import.meta.url));
const mutationWorker = fileURLToPath(new URL('./fixtures/wallet-mutation-worker.mjs', import.meta.url));
const walletUrl = pathToFileURL(path.join(repo, 'src', 'wallet.js')).href;
const roots = [];
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

function runNode(args, home) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, args, {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => resolve({ code, stderr, body: JSON.parse(stdout) }));
  });
}

const runCreate = (home, markerDir, name, password) =>
  runNode([worker, repo, home, markerDir, name, password], home);
const runMutation = (home, markerDir, operation, name, password) =>
  runNode([mutationWorker, repo, home, markerDir, operation, name, password], home);

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nansen-wallet-concurrency-'));
  roots.push(root);
  const home = path.join(root, 'home');
  const markerDir = path.join(root, 'markers');
  const walletsDir = path.join(home, '.nansen', 'wallets');
  fs.mkdirSync(walletsDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(markerDir);
  fs.writeFileSync(
    path.join(walletsDir, 'config.json'),
    JSON.stringify({ defaultWallet: null, passwordHash: null }),
    { mode: 0o600 },
  );
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return { home, markerDir, walletsDir, lockPath: path.join(walletsDir, '.wallet.lock') };
}

// The PID of a process that has already exited.
const deadPid = () => new Promise(resolve => {
  const child = spawn(process.execPath, ['-e', '']);
  child.once('close', () => resolve(child.pid));
});

// A fresh module instance per test, so it resolves the fixture's HOME.
const loadWallet = () => import(`${walletUrl}?t=${Date.now()}-${Math.random()}`);

afterEach(() => {
  process.env.HOME = originalHome;
  process.env.USERPROFILE = originalUserProfile;
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('wallet mutation concurrency', () => {
  it('does not report success for a first encrypted wallet stranded by a competing password', async () => {
    const { home, markerDir, walletsDir } = fixture();
    const entries = [
      { name: 'alpha', password: 'alpha-password-1234' },
      { name: 'beta', password: 'beta-password-5678' },
    ];

    const results = await Promise.all(entries.map(e => runCreate(home, markerDir, e.name, e.password)));
    const succeeded = results.filter(r => r.code === 0);
    const rejected = results.filter(r => r.code !== 0);

    expect(succeeded).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].body.error).toMatch(/Incorrect password/);

    const winner = entries.find(e => e.name === succeeded[0].body.result.name);
    const loser = entries.find(e => e.name !== winner.name);
    expect(fs.existsSync(path.join(walletsDir, `${loser.name}.json`))).toBe(false);
    const { exportWallet } = await loadWallet();
    expect(() => exportWallet(winner.name, winner.password)).not.toThrow();
  });

  it('allows concurrent creates that use the same password', async () => {
    const { home, markerDir } = fixture();
    const password = 'shared-password-1234';

    const results = await Promise.all(['alpha', 'beta'].map(name => runCreate(home, markerDir, name, password)));

    expect(results.map(r => r.code)).toEqual([0, 0]);
    expect(results.filter(r => r.body.result.isDefault)).toHaveLength(1);
    const { exportWallet } = await loadWallet();
    for (const name of ['alpha', 'beta']) expect(() => exportWallet(name, password)).not.toThrow();
  });

  it('reports only one success for concurrent duplicate names', async () => {
    const { home, markerDir } = fixture();

    const results = await Promise.all([
      runCreate(home, markerDir, 'duplicate', 'shared-password-1234'),
      runCreate(home, markerDir, 'duplicate', 'shared-password-1234'),
    ]);

    expect(results.filter(r => r.code === 0)).toHaveLength(1);
    expect(results.find(r => r.code !== 0).body.error).toMatch(/already exists/);
  });

  it('serializes default selection against deletion without leaving a missing default', async () => {
    const { home, markerDir, walletsDir } = fixture();
    const { createWallet } = await loadWallet();
    createWallet('alpha', 'shared-password-1234');
    createWallet('beta', 'shared-password-1234');

    const results = await Promise.all([
      runMutation(home, markerDir, 'default', 'alpha', 'shared-password-1234'),
      runMutation(home, markerDir, 'delete', 'alpha', 'shared-password-1234'),
    ]);

    expect(results.find(r => r.body.result?.deleted === 'alpha')?.code).toBe(0);
    expect(fs.existsSync(path.join(walletsDir, 'alpha.json'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(walletsDir, 'config.json'), 'utf8')).defaultWallet).toBe('beta');
  });
});

describe('withWalletLock', () => {
  it('releases the lock when the mutation throws', async () => {
    const { lockPath, walletsDir } = fixture();
    const { withWalletLock } = await loadWallet();

    expect(() => withWalletLock(() => { throw new Error('injected failure'); })).toThrow('injected failure');
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(withWalletLock(() => 'ok')).toBe('ok');
    expect(fs.readdirSync(walletsDir).filter(f => f.startsWith('.wallet.lock'))).toEqual([]);
  });

  it('reports an actionable busy error while a live lock is held', async () => {
    const { lockPath } = fixture();
    fs.mkdirSync(lockPath);
    const { withWalletLock } = await loadWallet();
    const fn = vi.fn();

    expect(() => withWalletLock(fn, { waitMs: 100 })).toThrow(/Another nansen wallet command is still running/);
    expect(fn).not.toHaveBeenCalled();
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it('leaves the lock alone on release once another process has taken it over', async () => {
    const { lockPath, walletsDir } = fixture();
    const { withWalletLock } = await loadWallet();

    withWalletLock(() => {
      // A last guard: if another process ever replaced the lock, release
      // leaves the new holder's lock in place.
      fs.rmSync(lockPath, { recursive: true });
      fs.mkdirSync(lockPath);
      fs.writeFileSync(path.join(lockPath, 'owner'), 'someone-else');
    });

    expect(fs.readFileSync(path.join(lockPath, 'owner'), 'utf8')).toBe('someone-else');
    expect(fs.readdirSync(walletsDir).filter(f => f.startsWith('.wallet.lock'))).toEqual(['.wallet.lock']);
  });

  it('does not clear a lock taken by a live owner by the time it holds the clear lock', async () => {
    const { lockPath } = fixture();
    const pid = await deadPid();
    fs.mkdirSync(lockPath);
    fs.writeFileSync(path.join(lockPath, 'owner'), `${os.hostname()}\n${pid}\nabc`);
    const { withWalletLock } = await loadWallet();
    // Between this process's first check and taking the .break lock, another
    // process clears the abandoned lock and takes its own.
    const realMkdir = fs.mkdirSync;
    vi.spyOn(fs, 'mkdirSync').mockImplementation((p, ...rest) => {
      if (String(p).endsWith('.wallet.lock.break') && fs.existsSync(lockPath)) {
        fs.writeFileSync(path.join(lockPath, 'owner'), `${os.hostname()}\n${process.pid}\nlive`);
      }
      return realMkdir(p, ...rest);
    });

    expect(() => withWalletLock(() => {}, { waitMs: 100 })).toThrow(/still running/);
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it('removes its own lock when recording the owner fails', async () => {
    const { lockPath } = fixture();
    const { withWalletLock } = await loadWallet();
    const realWrite = fs.writeFileSync;
    vi.spyOn(fs, 'writeFileSync').mockImplementation((p, ...rest) => {
      if (String(p) === path.join(lockPath, 'owner')) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      return realWrite(p, ...rest);
    });
    const fn = vi.fn();

    expect(() => withWalletLock(fn)).toThrow('disk full');
    expect(fn).not.toHaveBeenCalled();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('clears a fresh lock at once when its owner process on this machine is gone', async () => {
    const { lockPath } = fixture();
    const pid = await deadPid();
    fs.mkdirSync(lockPath);
    fs.writeFileSync(path.join(lockPath, 'owner'), `${os.hostname()}\n${pid}\nabc`);
    const { withWalletLock } = await loadWallet();

    expect(withWalletLock(() => 'ran', { waitMs: 1000 })).toBe('ran');
  });

  it.each([
    ['a live owner on this machine', () => `${os.hostname()}\n${process.pid}\nabc`],
    ['an owner on another machine', () => 'some-other-host\n999999\nabc'],
  ])('waits on a fresh lock held by %s', async (_label, owner) => {
    const { lockPath } = fixture();
    fs.mkdirSync(lockPath);
    fs.writeFileSync(path.join(lockPath, 'owner'), owner());
    const { withWalletLock } = await loadWallet();

    expect(() => withWalletLock(() => {}, { waitMs: 100 })).toThrow(/still running/);
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it('never clears an old lock whose owner on this machine is still running', async () => {
    const { lockPath } = fixture();
    fs.mkdirSync(lockPath);
    fs.writeFileSync(path.join(lockPath, 'owner'), `${os.hostname()}\n${process.pid}\nabc`);
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(lockPath, old, old);
    const { withWalletLock } = await loadWallet();
    const fn = vi.fn();

    expect(() => withWalletLock(fn, { waitMs: 100 }))
      .toThrow(`Another nansen wallet command (PID ${process.pid}) is still running`);
    expect(fn).not.toHaveBeenCalled();
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it('leaves an old lock with no owner file alone', async () => {
    const { lockPath } = fixture();
    fs.mkdirSync(lockPath);
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(lockPath, old, old);
    const { withWalletLock } = await loadWallet();
    const fn = vi.fn();

    expect(() => withWalletLock(fn, { waitMs: 100 })).toThrow(/Another nansen wallet command is still running/);
    expect(fn).not.toHaveBeenCalled();
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it('clears a .break left by a dead owner, then the dead owner\'s lock behind it', async () => {
    const { lockPath, walletsDir } = fixture();
    const pid = await deadPid();
    for (const dir of [lockPath, `${lockPath}.break`]) {
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'owner'), `${os.hostname()}\n${pid}\nabc`);
    }
    const { withWalletLock } = await loadWallet();

    expect(withWalletLock(() => 'ran', { waitMs: 1000 })).toBe('ran');
    expect(fs.readdirSync(walletsDir).filter(f => f.startsWith('.wallet.lock'))).toEqual([]);
  });

  it('leaves a .break whose owner is still running alone', async () => {
    const { lockPath } = fixture();
    const pid = await deadPid();
    fs.mkdirSync(lockPath);
    fs.writeFileSync(path.join(lockPath, 'owner'), `${os.hostname()}\n${pid}\nabc`);
    fs.mkdirSync(`${lockPath}.break`);
    fs.writeFileSync(path.join(`${lockPath}.break`, 'owner'), `${os.hostname()}\n${process.pid}\nabc`);
    const { withWalletLock } = await loadWallet();

    expect(() => withWalletLock(() => {}, { waitMs: 100 })).toThrow(/still running/);
    expect(fs.existsSync(`${lockPath}.break`)).toBe(true);
  });
});

describe('createWallet beforeCommit', () => {
  it('runs inside the lock, after the checks pass and before the wallet is written', async () => {
    const { lockPath, walletsDir } = fixture();
    const { createWallet } = await loadWallet();
    const seen = [];

    createWallet('alpha', 'shared-password-1234', {
      beforeCommit: () => seen.push({
        locked: fs.existsSync(lockPath),
        written: fs.existsSync(path.join(walletsDir, 'alpha.json')),
      }),
    });

    expect(seen).toEqual([{ locked: true, written: false }]);
  });

  it('rejects a different password with the INCORRECT_PASSWORD code', async () => {
    fixture();
    const { createWallet } = await loadWallet();
    createWallet('alpha', 'shared-password-1234');

    let err;
    try { createWallet('beta', 'other-password-5678'); } catch (e) { err = e; }
    expect(err?.code).toBe('INCORRECT_PASSWORD');
  });

  it('is not called when the create is rejected', async () => {
    fixture();
    const { createWallet } = await loadWallet();
    createWallet('alpha', 'shared-password-1234');
    const beforeCommit = vi.fn();

    expect(() => createWallet('beta', 'other-password-5678', { beforeCommit })).toThrow(/Incorrect password/);
    expect(() => createWallet('alpha', 'shared-password-1234', { beforeCommit })).toThrow(/already exists/);
    expect(beforeCommit).not.toHaveBeenCalled();
  });
});

describe('mutations on a missing wallet', () => {
  it('fail without creating the wallets directory', async () => {
    const { home } = fixture();
    fs.rmSync(path.join(home, '.nansen'), { recursive: true });
    const { setDefaultWallet, deleteWallet } = await loadWallet();

    expect(() => setDefaultWallet('ghost')).toThrow(/not found/);
    await expect(deleteWallet('ghost', 'shared-password-1234')).rejects.toThrow(/not found/);
    expect(fs.existsSync(path.join(home, '.nansen'))).toBe(false);
  });
});
