import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { readApiKeyInput } from '../auth-key-input.js';
import { buildCommands, parseArgs, runCLI } from '../cli.js';
import { buildCompletionSpec } from '../commands/completion.js';

describe('API key stdin input', () => {
  it('accepts a key split across chunks with a trailing newline', async () => {
    expect(await readApiKeyInput(Readable.from(['example-', 'key\r\n']))).toBe('example-key');
  });

  it.each(['', '\n', '  '])('rejects empty input without falling back to another credential', async value => {
    await expect(readApiKeyInput(Readable.from([value]))).rejects.toMatchObject({ code: 'API_KEY_REQUIRED' });
  });

  it.each(['key-one\nkey-two', 'key one', 'key\0one', 'key\u007fone', 'key\u001bone'])('rejects invalid input without echoing it', async value => {
    const error = await readApiKeyInput(Readable.from([value])).catch(error => error);
    expect(error.code).toBe('INVALID_PARAMS');
    expect(error.message).not.toContain(value);
  });

  it('stops reading oversized input before verification', async () => {
    let chunks = 0;
    async function* source() {
      for (let i = 0; i < 100; i++) { chunks++; yield Buffer.alloc(4096, 'a'); }
    }
    await expect(readApiKeyInput(source(), false)).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(chunks).toBe(2);
  });

  it('sanitizes input errors', async () => {
    async function* source() { yield 'example-'; throw new Error('example-secret'); }
    const error = await readApiKeyInput(source(), false).catch(error => error);
    expect(error.code).toBe('API_KEY_INPUT_FAILED');
    expect(error.message).not.toContain('example-secret');
    expect(error.cause).toBeUndefined();
  });

  it('refuses interactive terminal input before reading', async () => {
    await expect(readApiKeyInput(null, true)).rejects.toMatchObject({ code: 'NOT_A_PIPE' });
  });

  it('times out a pipe that never closes and releases the stream', async () => {
    const input = new PassThrough();
    input.write('example-unfinished-key');
    await expect(readApiKeyInput(input, false, { timeoutMs: 10 })).rejects.toMatchObject({ code: 'API_KEY_INPUT_TIMEOUT' });
    expect(input.destroyed).toBe(true);
  });
});

describe('stdin login command', () => {
  function commands(input = 'example-stdin-key\n', extra = {}) {
    const deps = {
      stdin: Readable.from([input]), stdinTTY: false, env: { NANSEN_API_KEY: 'example-env-key' },
      browserLoginFn: vi.fn(), promptFn: vi.fn(), log: vi.fn(),
      authState: { begin: vi.fn().mockResolvedValue({}), install: vi.fn().mockResolvedValue({ cleanup: [] }), finish: vi.fn() },
      NansenAPIClass: vi.fn(function () { return { getAccount: vi.fn().mockResolvedValue({ credits_remaining: 0 }) }; }),
      ...extra,
    };
    return { deps, login: buildCommands(deps).login };
  }

  it('selects stdin explicitly, disables payments, and reports environment precedence without secrets', async () => {
    const { deps, login } = commands();
    await login([], null, { 'api-key-stdin': true }, {});
    expect(deps.NansenAPIClass).toHaveBeenCalledWith('example-stdin-key', expect.any(String), expect.objectContaining({ allowPayment: false, cache: { enabled: false } }));
    expect(deps.authState.install).toHaveBeenCalledWith({}, expect.objectContaining({ apiKey: 'example-stdin-key' }));
    expect(deps.authState.finish).toHaveBeenCalledOnce();
    expect(deps.browserLoginFn).not.toHaveBeenCalled();
    expect(deps.promptFn).not.toHaveBeenCalled();
    const output = JSON.stringify(deps.log.mock.calls);
    expect(output).toContain('Commands still use NANSEN_API_KEY');
    expect(output).not.toContain('example-stdin-key');
    expect(output).not.toContain('example-env-key');
  });

  it.each([
    ['--human'], ['--no-browser'], ['--api-key', 'example-other-key'], ['false'],
  ])('rejects incompatible arguments %j before reading or mutation', async args => {
    const { deps, login } = commands();
    const parsed = parseArgs(['--api-key-stdin', ...args]);
    await expect(login(parsed._, null, parsed.flags, parsed.options)).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(deps.stdin.readableDidRead).toBe(false);
    expect(deps.authState.begin).not.toHaveBeenCalled();
    expect(deps.browserLoginFn).not.toHaveBeenCalled();
  });

  it.each([undefined, 'example-env-key', ''])('emits one secret-free JSON event with environment key %j', async envKey => {
    const { deps, login } = commands(undefined, { env: envKey === undefined ? {} : { NANSEN_API_KEY: envKey } });
    await login([], null, { 'api-key-stdin': true, json: true }, {});
    expect(deps.log).toHaveBeenCalledOnce();
    expect(JSON.parse(deps.log.mock.calls[0][0])).toEqual({
      event: 'saved', effective_source: envKey === undefined ? 'config' : 'env', environment_key_blank: envKey === '', cleanup: [],
    });
  });

  it('never falls back to the environment key after empty stdin', async () => {
    const { deps, login } = commands('');
    await expect(login([], null, { 'api-key-stdin': true }, {})).rejects.toMatchObject({ code: 'API_KEY_REQUIRED' });
    expect(deps.NansenAPIClass).not.toHaveBeenCalled();
    expect(deps.authState.begin).not.toHaveBeenCalled();
  });

  it('preserves saved authentication on verification failure and suppresses echoed keys', async () => {
    const { deps, login } = commands(undefined, {
      NansenAPIClass: vi.fn(function () { return { getAccount: async () => { throw new Error('example-stdin-key'); } }; }),
    });
    const error = await login([], null, { 'api-key-stdin': true }, {}).catch(error => error);
    expect(error.code).toBe('VERIFICATION_FAILED');
    expect(error.message).not.toContain('example-stdin-key');
    expect(deps.authState.install).not.toHaveBeenCalled();
    expect(deps.authState.finish).toHaveBeenCalledOnce();
  });

  it('keeps help offline without reading stdin and exposes the option in completions', async () => {
    const output = vi.fn(); const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    try {
      await runCLI(['login', '--api-key-stdin', '--help'], { output, errorOutput: vi.fn(), exit: vi.fn(), stdin: null });
      expect(output.mock.calls.join('\n')).toContain('--api-key-stdin');
      expect(fetch).not.toHaveBeenCalled();
      const login = buildCompletionSpec().nodes.find(node => node.path === 'login');
      expect(login.options.map(option => option.name)).toContain('--api-key-stdin');
    } finally { vi.unstubAllGlobals(); }
  });
});
