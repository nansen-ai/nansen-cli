import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
const controls = vi.hoisted(() => ({ answers: [], prompts: [], spawn: vi.fn(), exec: vi.fn() }));
vi.mock('readline', () => ({ createInterface: () => {
  const rl = new EventEmitter(); rl.close = () => rl.emit('close');
  rl.question = (q, cb) => { controls.prompts.push(q); cb(controls.answers.shift() ?? ''); };
  return rl;
} }));
vi.mock('child_process', () => ({ execFileSync: controls.exec, spawn: controls.spawn }));
import { main } from '../../scripts/postinstall.js';
const config = () => path.join(process.env.HOME, '.nansen/config.json');
let output;
const ttyDescriptors = [process.stdin, process.stderr].map(stream => Object.getOwnPropertyDescriptor(stream, 'isTTY'));
function tty(stream, value) { Object.defineProperty(stream, 'isTTY', { configurable: true, value }); }
beforeEach(() => {
  vi.stubEnv('npm_lifecycle_event', 'postinstall'); vi.stubEnv('npm_config_global', 'true');
  delete process.env.NANSEN_API_KEY;
  controls.answers = []; controls.prompts = []; controls.spawn.mockReset(); controls.exec.mockReset();
  controls.spawn.mockImplementation(() => { const child = new EventEmitter(); queueMicrotask(() => child.emit('close', 0)); return child; });
  fs.mkdirSync(path.dirname(config()), { recursive: true }); fs.rmSync(config(), { force: true });
  fs.mkdirSync(path.join(process.env.HOME, '.claude/skills/nansen-cli'), { recursive: true });
  output = '';
  vi.spyOn(process.stderr, 'write').mockImplementation(text => { output += text; return true; });
  tty(process.stdin, true);
  tty(process.stderr, true);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network forbidden'); }));
});
afterEach(() => { [process.stdin, process.stderr].forEach((stream, i) => { if (ttyDescriptors[i]) Object.defineProperty(stream, 'isTTY', ttyDescriptors[i]); else delete stream.isTTY; }); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
function save(value) { fs.writeFileSync(config(), typeof value === 'string' ? value : JSON.stringify(value)); }
const pointer = version => ({ auth: { version, selectionEpoch: '00000000-0000-0000-0000-000000000001', active: { kind: 'session', generation: '00000000-0000-0000-0000-000000000002', issuer: 'https://idp.nansen.ai', audience: 'https://api.nansen.ai', accountId: 'synthetic-account', expiresAt: Date.now() + 3600000 } } });
describe('offline postinstall selection with shared resolver', () => {
  it.each(['', 'n', 'maybe', 'yes please', 'y', 'YES'])('requires explicit consent to install the skill for %j', async answer => {
    fs.rmSync(path.join(process.env.HOME, '.claude/skills/nansen-cli'), { recursive: true });
    controls.answers.push(answer);
    await main();
    expect(controls.prompts).toHaveLength(1);
    expect(controls.prompts[0]).toContain('Install Nansen skill for your AI coding agent? [y/N]');
    if (answer === 'y' || answer === 'YES') {
      const args = ['-y', 'skills', 'add', 'nansen-ai/nansen-cli'];
      expect(controls.spawn).toHaveBeenCalledTimes(1);
      expect(controls.spawn).toHaveBeenCalledWith(
        process.platform === 'win32' ? 'cmd.exe' : 'npx',
        process.platform === 'win32' ? ['/c', 'npx', ...args] : args,
        { stdio: 'inherit', shell: false },
      );
    } else {
      expect(controls.spawn).not.toHaveBeenCalled();
      expect(output).toContain('Skipped. You can install it later');
    }
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it.each([
    ['environment only', null, 'synthetic-env-secret', 'API key is configured', true],
    ['legacy key', { apiKey: 'synthetic-key-secret' }, undefined, 'API key is configured', true],
    ['v1 session', pointer(1), undefined, 'cached metadata is unverified', true],
    ['v2 session', pointer(2), undefined, 'cached metadata is unverified', true],
    ['env overrides session', pointer(2), 'synthetic-env-secret', 'API key is configured', true],
    ['empty env overrides key', { apiKey: 'synthetic-key-secret' }, '', 'needs attention', false],
    ['tombstone suppresses legacy', { apiKey: 'synthetic-key-secret', auth: { version: 1, active: { kind: 'none' } } }, undefined, 'browser approval', false],
    ['corrupt config', '{invalid', undefined, 'needs attention', false],
    ['missing config', null, undefined, 'browser approval', false],
    ['unsupported snake case', { api_key: 'synthetic-key-secret' }, undefined, 'browser approval', false],
  ])('%s is classified without verification or mutation', async (_name, value, envKey, message, prompt) => {
    if (value !== null) save(value);
    if (envKey !== undefined) vi.stubEnv('NANSEN_API_KEY', envKey);
    const before = fs.existsSync(config()) ? fs.readFileSync(config(), 'utf8') : null;
    await main();
    expect(output).toContain(message); expect(controls.prompts.length).toBe(prompt ? 1 : 0);
    expect(controls.spawn).not.toHaveBeenCalled(); expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(fs.existsSync(config()) ? fs.readFileSync(config(), 'utf8') : null).toBe(before);
    for (const secret of ['synthetic-key-secret','synthetic-env-secret','synthetic-account']) expect(output).not.toContain(secret);
  });
  it.each(['', 'n', 'maybe', 'yes please'])('does not verify for %j', async answer => {
    save(pointer(2)); controls.answers.push(answer); await main(); expect(controls.spawn).not.toHaveBeenCalled();
  });
  it.each(['y','YES'])('only explicit %s launches the free account command', async answer => {
    save(pointer(2)); controls.answers.push(answer); await main();
    expect(controls.spawn).toHaveBeenCalledWith(process.execPath, [expect.stringMatching(/src\/index.js$/), 'account', '--pretty'], { stdio: 'inherit', shell: false });
    expect(controls.prompts[0]).toContain('free; may renew a session');
  });
  it('keeps account child failure recoverable and secret-free', async () => {
    save(pointer(2)); controls.answers.push('y');
    controls.spawn.mockImplementation(() => { const child = new EventEmitter(); queueMicrotask(() => child.emit('error', new Error('secret-child-error'))); return child; });
    await main(); expect(output).toContain('Account check failed'); expect(output).not.toContain('secret-child-error');
  });
  it('gives an offline repair tip when HOME is invalid', async () => {
    vi.stubEnv('HOME', 'relative-home');
    controls.exec.mockImplementation(() => { throw new Error('npx unavailable'); });
    await expect(main()).resolves.toBeUndefined();
    expect(output).toContain('Run: nansen auth status');
    expect(controls.prompts).toEqual([]); expect(controls.spawn).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it('preserves local-install and non-TTY guards', async () => {
    vi.stubEnv('npm_config_global', 'false'); await main(); expect(output).toBe('');
    vi.stubEnv('npm_config_global', 'true'); tty(process.stdin, false);
    await main(); expect(output).toContain('nansen login'); expect(controls.prompts).toEqual([]); expect(controls.spawn).not.toHaveBeenCalled();
  });
});
