// The process owns execution exclusion; only its worker thread enters keyring.
// A blocked native call cannot block this process's parent-loss/timeout watchdog.
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import locks from 'fs-native-extensions';

const stop = () => process.kill(process.pid, 'SIGKILL');
const timer = setTimeout(stop, 10000);
process.stdin.on('end', stop);
process.stdin.on('error', stop);
process.stdout.on('error', stop);
let input = '', phase = 'guard';
let fd;
function safe(file, directory = false) {
  if (!fs.existsSync(file)) return;
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) ||
      (process.platform !== 'win32' && ((stat.mode & 0o022) || stat.uid !== process.getuid()))) throw new Error();
}
function receive(line) {
  const message = JSON.parse(line);
  if (phase === 'guard') {
    const directory = message.directory;
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error();
    safe(directory, true);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, 'auth-store.lock');
    safe(file);
    fd = fs.openSync(file, 'a+', 0o600);
    // Independent acquisition: no cross-platform inherited-lock assumptions.
    // This stable inode is never unlinked, including by recovery.
    if (!locks.tryLock(fd)) throw new Error();
    phase = 'operation';
    process.stdout.write('{"ready":true}\n');
    return;
  }
  if (phase !== 'operation' || !['set', 'get', 'delete'].includes(message.operation) || !/^[a-f0-9-]{36}\.(probe|manifest|[0-7])$/.test(message.account)) throw new Error();
  phase = 'running';
  const worker = new Worker(new URL('./auth-store-native.js', import.meta.url), { workerData: message, stdout: true, stderr: true });
  worker.stdout.resume(); worker.stderr.resume();
  let result;
  worker.on('message', value => { result = value; });
  worker.on('error', stop);
  worker.on('exit', code => {
    // No response or lock release until the executor can no longer write.
    if (code !== 0 || !result || (result.error && result.error !== 'BINDING_MISSING')) return stop();
    process.stdout.write(JSON.stringify(result) + '\n', () => {
      clearTimeout(timer);
      fs.closeSync(fd);
      process.exit(0);
    });
  });
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  input += chunk;
  if (input.length > 40000) return stop();
  let end;
  while ((end = input.indexOf('\n')) !== -1) {
    const line = input.slice(0, end); input = input.slice(end + 1);
    try { receive(line); } catch { return stop(); }
  }
});
