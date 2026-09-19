/**
 * Package Integrity Test
 *
 * Packs the tarball, installs it in a temp directory, and runs the CLI.
 * Catches issues like missing files in the `files` field (e.g., 1.18.0 breakage).
 */

import { describe, it, expect, afterAll } from 'vitest';
import { execSync, execFileSync } from 'child_process';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

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
    execSync('npm init -y', { cwd: tmpDir, stdio: 'ignore' });
    execSync(`npm install --omit=optional --no-audit --no-fund "${tgzPath}"`, { cwd: tmpDir, stdio: 'ignore' });

    // Smoke test - if any import fails (e.g., missing src/commands/), this crashes.
    // Resolve the .cmd extension on Windows, where node_modules/.bin shims aren't extensionless.
    const binary = join(tmpDir, 'node_modules', '.bin', process.platform === 'win32' ? 'nansen.cmd' : 'nansen');
    const result = execSync(`"${binary}" --help`, {
      cwd: tmpDir,
      encoding: 'utf-8',
    });

    expect(result).toContain('nansen');
    expect(result).toContain('COMMANDS');
    expect(existsSync(join(tmpDir, 'node_modules/nansen-cli/docs/browser-login.md'))).toBe(true);
    expect(existsSync(join(tmpDir, 'node_modules/nansen-cli/src/auth-store-native.js'))).toBe(true);
    // Native auth modules must stay lazy when optional bindings are omitted.
    const apiModule = join(tmpDir, 'node_modules/nansen-cli/src/api.js');
    const stateModule = join(tmpDir, 'node_modules/nansen-cli/src/auth-state.js');
    const smoke = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { pathToFileURL } from 'node:url';
      const { NansenAPI } = await import(pathToFileURL(${JSON.stringify(apiModule)}));
      globalThis.fetch = async (_url, options) => {
        if (options.headers.apikey !== 'synthetic-key') throw new Error('wrong credential');
        return new Response(JSON.stringify({user_id:'synthetic'}));
      };
      await new NansenAPI('synthetic-key').getAccount();
      const { createAuthState } = await import(pathToFileURL(${JSON.stringify(stateModule)}));
      try { await createAuthState({directory:${JSON.stringify(join(tmpDir, 'auth'))}}).begin(); throw new Error('unexpected native availability'); }
      catch (error) { if(error.code !== 'AUTH_LOCK_UNAVAILABLE' || !error.message.includes('offline-recovery-without-native-locking')) throw error; }
      console.log('key-auth-without-native-ok');
    `], { cwd: tmpDir, encoding: 'utf8' });
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
