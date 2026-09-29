// Exercise published or newly packed CLI installs, including optional bindings.
// CI runs both sources inside glibc and musl Node images.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const expected = process.env.NANSEN_EXPECT_NATIVE_LOCK;
assert.ok(['available', 'unavailable'].includes(expected), 'Set NANSEN_EXPECT_NATIVE_LOCK');
const source = process.env.NANSEN_PACKAGE_SOURCE || 'packed';
assert.ok(['packed', 'published'].includes(source), 'NANSEN_PACKAGE_SOURCE must be packed or published');
assert.equal(process.platform, 'linux');
assert.equal(process.arch, 'x64');

const repo = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const temp = mkdtempSync(path.join(tmpdir(), 'nansen-native-install-'));
const install = path.join(temp, 'install');
const home = path.join(temp, 'home');
const config = path.join(home, '.nansen', 'config.json');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const env = {
  ...process.env,
  HOME: home,
  DO_NOT_TRACK: '1',
  NANSEN_NO_TELEMETRY: '1',
  npm_config_cache: path.join(temp, 'npm-cache'),
};

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repo,
    env,
    encoding: 'utf8',
    timeout: 90_000,
    maxBuffer: 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  return result;
}

function requireSuccess(result, label) {
  assert.equal(result.status, 0, `${label} failed:\n${result.stdout}\n${result.stderr}`);
}

try {
  let packageSpec = 'nansen-cli@2.0.0';
  if (source === 'packed') {
    const packed = run(npm, ['pack', '--json', '--pack-destination', temp]);
    requireSuccess(packed, 'npm pack');
    packageSpec = path.join(temp, JSON.parse(packed.stdout)[0].filename);
  }
  const installed = run(npm, ['install', '--prefix', install, '--include=optional', '--no-audit', '--no-fund', packageSpec]);
  requireSuccess(installed, 'npm install');

  const requireInstalled = createRequire(path.join(install, 'probe.cjs'));
  assert.equal(requireInstalled('fs-native-extensions/package.json').version, '1.5.1');
  const libc = process.report.getReport().header.glibcVersionRuntime ? 'gnu' : 'musl';
  assert.ok(requireInstalled.resolve(`@napi-rs/keyring-linux-x64-${libc}`));
  assert.equal(typeof requireInstalled('@napi-rs/keyring').Entry, 'function');
  let native;
  let lockError;
  try {
    native = requireInstalled('fs-native-extensions');
  } catch (error) {
    lockError = error;
  }
  if (expected === 'available') {
    assert.equal(lockError, undefined, lockError?.message);
    assert.equal(typeof native.tryLock, 'function');
  } else {
    assert.ok(lockError, 'musl unexpectedly loaded the native lock; update this test and platform guidance');
    assert.match(lockError.message, /Cannot find addon/);
    assert.match(lockError.message, /linux-x64-musl/);
  }

  const fetchMock = path.join(temp, 'fetch-mock.mjs');
  writeFileSync(fetchMock, `globalThis.fetch = async (input) => {
    if (new URL(input).pathname !== '/api/v1/account') throw new Error('Unexpected API request');
    return new Response(JSON.stringify({ user_id: 'native-install-test', plan: 'test' }), {
      status: 200, headers: { 'content-type': 'application/json' }
    });
  };\n`);
  const cli = path.join(install, 'node_modules', 'nansen-cli', 'src', 'index.js');
  const commandEnv = { ...env, NANSEN_API_KEY: 'synthetic-test-key', NODE_OPTIONS: `--import=${fetchMock}` };
  const account = run(process.execPath, [cli, 'account'], { cwd: install, env: commandEnv });
  requireSuccess(account, 'account with environment key');
  assert.match(account.stdout, /native-install-test/);
  const login = run(process.execPath, [cli, 'login', '--human'], { cwd: install, env: commandEnv });
  const logout = run(process.execPath, [cli, 'logout'], { cwd: install, env: commandEnv });

  if (expected === 'available') {
    requireSuccess(login, 'login --human');
    assert.match(login.stdout, /Saved to/);
    requireSuccess(logout, 'logout');
    assert.match(logout.stdout, /Local credentials removed/);
    const saved = JSON.parse(readFileSync(config, 'utf8'));
    assert.equal(saved.apiKey, undefined);
    assert.equal(saved.auth.active.kind, 'none');
  } else {
    assert.equal(login.status, 1, `login unexpectedly succeeded:\n${login.stdout}\n${login.stderr}`);
    assert.match(login.stdout + login.stderr, /AUTH_LOCK_UNAVAILABLE/);
    assert.equal(logout.status, 1, `logout unexpectedly succeeded:\n${logout.stdout}\n${logout.stderr}`);
    assert.match(logout.stdout + logout.stderr, /AUTH_LOCK_UNAVAILABLE/);
    assert.equal(existsSync(config), false);
  }
  console.log(`${source} ${process.version} ${process.platform}/${process.arch}: keyring loaded, lock ${expected}, login/logout checked`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
