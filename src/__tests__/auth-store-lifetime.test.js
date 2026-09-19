import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork, spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import locks from 'fs-native-extensions';
const roots = [], children = [], orphans = [];
const src = fileURLToPath(new URL('..', import.meta.url));
afterEach(async () => {
  for (const pid of orphans.splice(0)) { try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ } }
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGKILL'); await done; }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
async function until(test, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!test()) { if (Date.now() > deadline) throw new Error('barrier timeout'); await new Promise(r => setTimeout(r, 10)); }
}
function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-lifetime-')); roots.push(root);
  fs.mkdirSync(path.join(root, 'entries'));
  for (const file of ['auth-state.js', 'auth-store.js', 'auth-store-worker.js', 'auth-credentials.js']) fs.copyFileSync(path.join(src, file), path.join(root, file));
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  fs.symlinkSync(path.join(src, '../node_modules'), path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  // Only the native backend is replaced. Dispatcher, guardian and state owner
  // are actual production source; the executor blocks synchronously before set.
  fs.writeFileSync(path.join(root, 'auth-store-native.js'), `
    import fs from 'node:fs'; import path from 'node:path';
    import {fileURLToPath} from 'node:url'; import {workerData,parentPort} from 'node:worker_threads';
    const root=path.dirname(fileURLToPath(import.meta.url));
    const {operation,account,data}=workerData; const file=path.join(root,'entries',account);
    if(operation==='set' && account.endsWith('.0') && !fs.existsSync(path.join(root,'entered'))) {
      fs.writeFileSync(path.join(root,'entered'),String(process.pid));
      const cell=new Int32Array(new SharedArrayBuffer(4));
      while(!fs.existsSync(path.join(root,'release'))) Atomics.wait(cell,0,0,20);
    }
    let value;
    if(operation==='set') {fs.writeFileSync(file,data);value=true;}
    else if(operation==='get') value=fs.existsSync(file)?fs.readFileSync(file,'utf8'):null;
    else {value=fs.existsSync(file);if(value)fs.unlinkSync(file);}
    parentPort.postMessage({value});
  `);
  fs.writeFileSync(path.join(root, 'owner.js'), `
    import {createAuthState} from './auth-state.js'; import {fileURLToPath} from 'node:url';
    const state=createAuthState({directory:fileURLToPath(new URL('./config',import.meta.url))});
    if(process.argv[2]==='logout') console.log(JSON.stringify(await state.logout()));
    else {const a=await state.begin();process.send?.({event:'begin'});await state.install(a,{bundle:{accessToken:'synthetic-access',privateJwk:{d:'synthetic-private'},refreshToken:'synthetic-refresh'}});await state.finish(a);}
  `);
  return root;
}
function start(root, action = 'install') {
  const child = fork(path.join(root, 'owner.js'), [action], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { PATH: process.env.PATH, NODE_NO_WARNINGS: '1' } }); children.push(child);
  let out = ''; child.stdout.on('data', b => { out += b; }); child.stderr.resume();
  return { child, result: once(child, 'exit').then(([code]) => { if (code !== 0) throw new Error('owner failed'); return out ? JSON.parse(out) : null; }).catch(error => ({ error: error.message })) };
}
const journals = root => fs.readdirSync(path.join(root, 'config/auth-operations')).filter(f => f.endsWith('.json'));
async function kill(child) { const done = once(child, 'exit'); child.kill('SIGKILL'); await done; }

it('parent SIGKILL cannot leave a late native writer after successful actual-owner recovery', async () => {
  const root = harness(); const owner = start(root);
  await until(() => fs.existsSync(path.join(root, 'entered')));
  const helper = Number(fs.readFileSync(path.join(root, 'entered'))); orphans.push(helper);
  const inode = fs.statSync(path.join(root, 'config/auth-store.lock')).ino;
  await kill(owner.child);
  // Parent pipe loss kills the whole guarded process, including blocked native thread.
  await until(() => { try { process.kill(helper, 0); return false; } catch { return true; } });
  const recovered = await start(root, 'logout').result;
  expect(fs.statSync(path.join(root, 'config/auth-store.lock')).ino).toBe(inode);
  expect(recovered.error).toBeUndefined(); expect(recovered.cleanup.some(r => r.local === 'incomplete')).toBe(false);
  expect(journals(root)).toEqual([]); expect(fs.readdirSync(path.join(root, 'entries'))).toEqual([]);
  fs.writeFileSync(path.join(root, 'release'), 'release');
  await new Promise(r => setTimeout(r, 100));
  expect(fs.readdirSync(path.join(root, 'entries'))).toEqual([]);
});

it.skipIf(process.platform === 'win32')('a paused helper retains exclusion after parent death; recovery reports incomplete until it dies', async () => {
  const root = harness(); const owner = start(root);
  await until(() => fs.existsSync(path.join(root, 'entered')));
  const helper = Number(fs.readFileSync(path.join(root, 'entered'))); orphans.push(helper);
  process.kill(helper, 'SIGSTOP'); await kill(owner.child);
  const before = Date.now(); const pending = await start(root, 'logout').result;
  expect(Date.now() - before).toBeLessThan(5000);
  expect(pending.cleanup).toContainEqual({ remote: 'unconfirmed', local: 'incomplete' }); expect(journals(root).length).toBeGreaterThan(0);
  fs.writeFileSync(path.join(root, 'release'), 'release'); process.kill(helper, 'SIGCONT');
  await until(() => { try { process.kill(helper, 0); return false; } catch { return true; } });
  const done = await start(root, 'logout').result; expect(done.error).toBeUndefined();
  expect(journals(root)).toEqual([]); expect(fs.readdirSync(path.join(root, 'entries'))).toEqual([]);
});

it('watchdog kills a synchronously blocked executor without a parent-side timer', async () => {
  const root = harness(); const directory = path.join(root, 'config');
  const child = spawn(process.execPath, [path.join(root, 'auth-store-worker.js')], { stdio: ['pipe', 'pipe', 'pipe'] }); children.push(child);
  child.stderr.resume(); child.stdin.on('error', () => {}); let out = '';
  child.stdout.on('data', b => { out += b; });
  const done = once(child, 'exit'); const started = Date.now();
  child.stdin.write(JSON.stringify({ directory }) + '\n'); await until(() => out.includes('ready'));
  child.stdin.write(JSON.stringify({ operation: 'set', account: '00000000-0000-4000-8000-000000000000.0', data: 'c3ludGhldGlj' }) + '\n');
  await until(() => fs.existsSync(path.join(root, 'entered')));
  await done; expect(Date.now() - started).toBeLessThan(13000);
  expect(fs.readdirSync(path.join(root, 'entries'))).toEqual([]);
  fs.writeFileSync(path.join(root, 'release'), 'release');
  expect(fs.readdirSync(path.join(root, 'entries'))).toEqual([]);
}, 20000);

it('does not accept write authority before acquiring the stable execution lock', async () => {
  const root = harness(); const directory = path.join(root, 'config'); fs.mkdirSync(directory);
  const fd = fs.openSync(path.join(directory, 'auth-store.lock'), 'a+', 0o600); expect(locks.tryLock(fd)).toBe(true);
  try {
    const child = spawn(process.execPath, [path.join(root, 'auth-store-worker.js')], { stdio: ['pipe', 'pipe', 'pipe'] }); children.push(child);
    let out = ''; child.stdout.on('data', b => { out += b; }); child.stderr.resume(); child.stdin.on('error', () => {});
    const done = once(child, 'exit');
    child.stdin.write(JSON.stringify({ directory }) + '\n');
    // No operation/credential has been supplied. A contended child must die
    // rather than queue for authority after recovery releases the lock.
    await done; expect(out).toBe(''); expect(fs.readdirSync(path.join(root, 'entries'))).toEqual([]);
  } finally { locks.unlock(fd); fs.closeSync(fd); }
});

it('parent disappears after readiness but before sending any credential', async () => {
  const root = harness(); const directory = path.join(root, 'config');
  const child = spawn(process.execPath, [path.join(root, 'auth-store-worker.js')], { stdio: ['pipe', 'pipe', 'pipe'] }); children.push(child);
  child.stderr.resume(); let out = ''; child.stdout.on('data', b => { out += b; });
  child.stdin.write(JSON.stringify({ directory }) + '\n'); await until(() => out.includes('ready'));
  const done = once(child, 'exit'); child.stdin.end(); await done;
  expect(fs.readdirSync(path.join(root, 'entries'))).toEqual([]);
  const fd = fs.openSync(path.join(directory, 'auth-store.lock'), 'a+');
  expect(locks.tryLock(fd)).toBe(true); locks.unlock(fd); fs.closeSync(fd);
});
