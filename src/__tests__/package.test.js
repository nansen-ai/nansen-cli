/**
 * Package Integrity Test
 *
 * Packs the tarball, installs it in a temp directory, and runs the CLI.
 * Catches issues like missing files in the `files` field (e.g., 1.18.0 breakage).
 */

import { describe, it, expect, afterAll } from 'vitest';
import { execSync, execFileSync, spawnSync } from 'child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, symlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';

describe('Package Integrity', () => {
  const tmpDirs = [];

  afterAll(() => {
    // Cleanup temp directories
    for (const dir of tmpDirs) {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('should run after npm pack (catches missing files)', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'nansen-pack-test-'));
    tmpDirs.push(tmpDir);

    // Every child (including background update checks) inherits a local-only transport.
    const capture = join(tmpDir, 'capture.mjs');
    writeFileSync(capture, `globalThis.fetch = async () => { process.stderr.write('LOCAL_FETCH_CAPTURE\\n'); return new Response(JSON.stringify({data: []})); };`);
    const childEnv = { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --import=${capture}`, DO_NOT_TRACK: '1', NANSEN_NO_TELEMETRY: '1' };

    // Pack from repo root
    const packOutput = execSync('npm pack --json', {
      encoding: 'utf-8',
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const [packInfo] = JSON.parse(packOutput);
    const tgzPath = join(process.cwd(), packInfo.filename);

    // Install in isolated temp directory. --no-audit skips npm's post-install
    // vulnerability check: that network call has been hanging indefinitely
    // (not just slow) rather than failing, so nothing short of avoiding it
    // keeps this test from hanging the whole CI job.
    execSync('npm init -y', { cwd: tmpDir, stdio: 'ignore', env: childEnv });
    execSync(`npm install --omit=optional --no-audit --no-fund --fetch-retries=0 --fetch-timeout=15000 "${tgzPath}"`, { cwd: tmpDir, stdio: 'pipe', timeout: 45000, env: { ...childEnv, NANSEN_TEST_PACKAGE_INSTALL: '1' } });

    const packageRoot = join(tmpDir, 'node_modules/nansen-cli');
    const result = execFileSync(process.execPath, [join(packageRoot, 'src/index.js'), '--help'], { cwd: tmpDir, encoding: 'utf8', env: childEnv });
    // Exercise npm's installed link/shebang (or Windows shim), not only its module.
    // The relative executable and arguments are fixed; no path enters cmd syntax.
    const installed = process.platform === 'win32'
      ? execFileSync('cmd.exe', ['/d', '/s', '/c', 'node_modules\\.bin\\nansen.cmd --help'], { cwd: tmpDir, encoding: 'utf8', env: childEnv })
      : execFileSync('./node_modules/.bin/nansen', ['--help'], { cwd: tmpDir, encoding: 'utf8', env: childEnv });
    expect(installed).toContain('COMMANDS');
    expect(installed).toContain('nansen');
    const postinstall = join(packageRoot, 'scripts/postinstall.js');
    const linkedRoot = join(tmpDir, 'linked-package');
    symlinkSync(packageRoot, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
    const invoke = (args, env = {}) => spawnSync(process.execPath, args, { cwd: tmpDir, encoding: 'utf8', env: { ...childEnv, npm_lifecycle_event: 'postinstall', npm_config_global: 'true', ...env } });
    for (const entry of [postinstall, join(linkedRoot, 'scripts/postinstall.js')]) {
      const onboarding = invoke([entry]);
      expect(onboarding.status).toBe(0); expect(onboarding.stdout).toBe('');
      expect(onboarding.stderr).toContain('Nansen CLI installed!');
      expect(onboarding.stderr).toContain('nansen login');
      expect(onboarding.stderr).toContain('NANSEN_API_KEY');
      expect(onboarding.stderr).not.toContain('LOCAL_FETCH_CAPTURE');
      const local = invoke([entry], { npm_config_global: 'false' });
      expect(local.status).toBe(0); expect(local.stdout).toBe(''); expect(local.stderr).toBe('');
    }
    const importer = join(tmpDir, 'import-postinstall.mjs');
    writeFileSync(importer, `await import(${JSON.stringify(pathToFileURL(postinstall).href)});`);
    for (const args of [[importer], ['--input-type=module', '-e', `process.argv[1] = 'missing-entry.js'; await import(${JSON.stringify(pathToFileURL(postinstall).href)});`]]) {
      const imported = invoke(args);
      expect(imported.status).toBe(0); expect(imported.stdout).toBe(''); expect(imported.stderr).toBe('');
    }
    // Exercise the real entry's failure boundary without opening a terminal or network.
    mkdirSync(join(process.env.HOME, '.claude/skills/nansen-cli'), { recursive: true });
    const brokenPrompt = join(tmpDir, 'broken-prompt.mjs');
    writeFileSync(brokenPrompt, `import readline from 'node:readline'; import { syncBuiltinESMExports } from 'node:module';
      Object.defineProperty(process.stdin, 'isTTY', {value:true}); Object.defineProperty(process.stderr, 'isTTY', {value:true});
      readline.createInterface = () => { throw new Error('synthetic-onboarding-failure'); }; syncBuiltinESMExports();`);
    const failed = invoke(['--import', brokenPrompt, postinstall], { NANSEN_API_KEY: 'synthetic-key' });
    expect(failed.status).toBe(0); expect(failed.stdout).toBe('');
    expect(failed.stderr).toContain('API key is configured'); expect(failed.stderr).not.toContain('synthetic-onboarding-failure');
    const recovery = readFileSync(join(packageRoot, 'docs/browser-login.md'), 'utf8');
    expect(recovery).toContain('## Offline recovery without native locking');
    expect(recovery).toContain('v2');
    expect(existsSync(join(packageRoot, 'docs/releases/api508-evidence.json'))).toBe(false);
    expect(readFileSync(join(packageRoot, 'skills/nansen-wallet-profiler/SKILL.md'), 'utf8')).toContain('Browser rollout acceptance is still pending.');
    expect(result).toContain('nansen');
    expect(result).toContain('COMMANDS');
    expect(existsSync(join(tmpDir, 'node_modules/nansen-cli/docs/browser-login.md'))).toBe(true);
    expect(existsSync(join(tmpDir, 'node_modules/nansen-cli/src/auth-store-native.js'))).toBe(true);
    // Native auth modules must stay lazy when optional bindings are omitted.
    const apiModule = join(tmpDir, 'node_modules/nansen-cli/src/api.js');
    const stateModule = join(tmpDir, 'node_modules/nansen-cli/src/auth-state.js');
    const smoke = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { pathToFileURL } from 'node:url';
      globalThis.fetch = async (_url, options) => {
        if (options.headers.apikey !== 'synthetic-key') throw new Error('wrong credential');
        return new Response(JSON.stringify({user_id:'synthetic'}));
      };
      const { NansenAPI } = await import(pathToFileURL(${JSON.stringify(apiModule)}));
      await new NansenAPI('synthetic-key').getAccount();
      const { createAuthState } = await import(pathToFileURL(${JSON.stringify(stateModule)}));
      try { await createAuthState({directory:${JSON.stringify(join(tmpDir, 'auth'))}}).begin(); throw new Error('unexpected native availability'); }
      catch (error) { if(error.code !== 'AUTH_LOCK_UNAVAILABLE' || !error.message.includes('offline-recovery-without-native-locking')) throw error; }
      console.log('key-auth-without-native-ok');
    `], { cwd: tmpDir, encoding: 'utf8', env: childEnv });
    expect(smoke).toContain('key-auth-without-native-ok');

    // Cleanup tarball
    rmSync(tgzPath, { force: true });
  }, 60000); // real installs take a few seconds; the margin is for a cold CI runner, not the audit hang above

  it('should not include test files in package', () => {
    const packOutput = execSync('npm pack --dry-run --json', {
      encoding: 'utf-8',
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const [packInfo] = JSON.parse(packOutput);
    const files = packInfo.files.map(f => f.path);

    const testFiles = files.filter(f => f.includes('__tests__'));
    expect(testFiles).toHaveLength(0);
  });
});
