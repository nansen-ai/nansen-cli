import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [repo, home, markerDir, operation, name, password] = process.argv.slice(2);
process.env.HOME = home;
process.env.USERPROFILE = home;

const walletsDir = path.join(home, '.nansen', 'wallets');
const configPath = path.join(walletsDir, 'config.json');
const lockPath = path.join(walletsDir, '.wallet.lock');
const originalReadFileSync = fs.readFileSync.bind(fs);
const originalReaddirSync = fs.readdirSync.bind(fs);
const originalRenameSync = fs.renameSync.bind(fs);
let synchronizedConfigRead = false;

function lockExists() {
  try { return fs.lstatSync(lockPath).isDirectory(); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function rendezvous() {
  fs.writeFileSync(path.join(markerDir, `config-read-${operation}-${process.pid}`), 'ready');
  const deadline = Date.now() + 10_000;
  while (originalReaddirSync(markerDir).filter(file => file.startsWith('config-read-')).length < 2) {
    if (Date.now() > deadline) throw new Error('Timed out at config-read rendezvous');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}

fs.readFileSync = function patchedReadFileSync(file, ...args) {
  const value = originalReadFileSync(file, ...args);
  if (!synchronizedConfigRead && path.resolve(String(file)) === path.resolve(configPath)) {
    synchronizedConfigRead = true;
    if (!lockExists()) rendezvous();
  }
  return value;
};

fs.renameSync = function patchedRenameSync(from, to) {
  if (operation === 'default' && path.resolve(String(to)) === path.resolve(configPath) && !lockExists()) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  return originalRenameSync(from, to);
};

try {
  const walletUrl = pathToFileURL(path.join(repo, 'src', 'wallet.js')).href;
  const { deleteWallet, setDefaultWallet } = await import(`${walletUrl}?mutation=${process.pid}`);
  const result = operation === 'default'
    ? setDefaultWallet(name)
    : await deleteWallet(name, password);
  process.stdout.write(JSON.stringify({ ok: true, result }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: error.message }));
  process.exitCode = 1;
}
