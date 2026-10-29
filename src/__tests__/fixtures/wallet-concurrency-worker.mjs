import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [repo, home, markerDir, name, password] = process.argv.slice(2);
process.env.HOME = home;
process.env.USERPROFILE = home;

const walletsDir = path.join(home, '.nansen', 'wallets');
const configPath = path.join(walletsDir, 'config.json');
const lockPath = path.join(walletsDir, '.wallet.lock');
const originalReadFileSync = fs.readFileSync.bind(fs);
const originalReaddirSync = fs.readdirSync.bind(fs);
let synchronizedConfigRead = false;
let synchronizedWalletScan = false;

function rendezvous(stage) {
  fs.writeFileSync(path.join(markerDir, `${stage}-${process.pid}`), name);
  const deadline = Date.now() + 10_000;
  while (originalReaddirSync(markerDir).filter(file => file.startsWith(`${stage}-`)).length < 2) {
    if (Date.now() > deadline) throw new Error(`Timed out at ${stage} rendezvous`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}

function mutationLockExists() {
  try {
    return fs.lstatSync(lockPath).isDirectory();
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

fs.readFileSync = function patchedReadFileSync(file, ...args) {
  const value = originalReadFileSync(file, ...args);
  if (!synchronizedConfigRead && path.resolve(String(file)) === path.resolve(configPath)) {
    synchronizedConfigRead = true;
    if (!mutationLockExists()) rendezvous('config-read');
  }
  return value;
};

fs.readdirSync = function patchedReaddirSync(dir, ...args) {
  const value = originalReaddirSync(dir, ...args);
  if (!synchronizedWalletScan && path.resolve(String(dir)) === path.resolve(walletsDir)) {
    synchronizedWalletScan = true;
    if (!mutationLockExists()) rendezvous('wallet-scan');
  }
  return value;
};

try {
  const walletUrl = pathToFileURL(path.join(repo, 'src', 'wallet.js')).href;
  const { createWallet } = await import(`${walletUrl}?worker=${process.pid}`);
  const result = createWallet(name, password);
  process.stdout.write(JSON.stringify({ ok: true, result }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: error.message }));
  process.exitCode = 1;
}
