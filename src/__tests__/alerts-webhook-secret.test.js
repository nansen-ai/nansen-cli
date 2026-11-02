/**
 * Alerts command - webhook signing secret sources
 *
 * The secret can come from --webhook-secret, --webhook-secret-stdin or the
 * NANSEN_WEBHOOK_SECRET environment variable. The two flags conflict; either
 * one overrides the environment, which is read only with --webhook. The
 * secret is never printed.
 */

import { PassThrough, Readable } from 'node:stream';
import { describe, it, expect, vi } from 'vitest';
import { buildAlertsCommands, REDACTED, WEBHOOK_SECRET_ENV } from '../commands/alerts.js';
import { readWebhookSecretInput } from '../auth-key-input.js';
import { NansenError, ErrorCode } from '../api.js';
import { formatError, parseArgs, runCLI } from '../cli.js';

vi.mock('../telemetry.js', async (importOriginal) => ({
  ...(await importOriginal()),
  trackCommandSucceeded: vi.fn(),
  trackCommandFailed: vi.fn(),
}));

const HOOK = 'https://example.com/hook';
const FLAG_SECRET = 'flag-secret-0123456789';
const STDIN_SECRET = 'stdin-secret-0123456789';
const ENV_SECRET = 'env-secret-0123456789';
const CREATE = { name: 'x', type: 'sm-token-flows', chains: 'ethereum', 'inflow-1h-min': 1 };

function setup({ env = {}, stdin } = {}) {
  const api = {
    alertsCreate: vi.fn(async (p) => ({ id: 'new', ...p })),
    alertsGet: vi.fn(async () => ({ id: 'a1', type: 'sm-token-flows', data: { chains: ['ethereum'], inflow_1h: { min: 1 } } })),
    alertsUpdate: vi.fn(async (p) => ({ ...p })),
  };
  const cmd = buildAlertsCommands({ log: vi.fn(), env, stdin: stdin ?? Readable.from([]) })['alerts'];
  return { api, cmd };
}

const sentSecret = (api, method = 'alertsCreate') =>
  api[method].mock.calls[0][0].channels?.find(c => c.type === 'webhook')?.data.secret;

async function failure(promise) {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error('expected the command to fail');
}

describe('webhook secret from stdin', () => {
  it('reads the secret on create and trims the trailing newline', async () => {
    const { api, cmd } = setup({ stdin: Readable.from([`${STDIN_SECRET}\n`]) });
    const result = await cmd(['create'], api, { 'webhook-secret-stdin': true }, { ...CREATE, webhook: HOOK });
    expect(sentSecret(api)).toBe(STDIN_SECRET);
    expect(JSON.stringify(result)).not.toContain(STDIN_SECRET);
  });

  it('reads the secret on update before fetching the alert', async () => {
    const { api, cmd } = setup({ stdin: Readable.from([STDIN_SECRET, '\r\n']) });
    await cmd(['update', 'a1'], api, { 'webhook-secret-stdin': true }, { webhook: HOOK });
    expect(sentSecret(api, 'alertsUpdate')).toBe(STDIN_SECRET);
  });

  it('keeps spaces inside the secret', async () => {
    const { api, cmd } = setup({ stdin: Readable.from(['  two words secret value  \n']) });
    await cmd(['create'], api, { 'webhook-secret-stdin': true }, { ...CREATE, webhook: HOOK });
    expect(sentSecret(api)).toBe('two words secret value');
  });

  it.each(['', '\n', '   '])('rejects empty input %j without falling back to the environment', async (value) => {
    const { api, cmd } = setup({ env: { [WEBHOOK_SECRET_ENV]: ENV_SECRET }, stdin: Readable.from([value]) });
    const err = await failure(cmd(['create'], api, { 'webhook-secret-stdin': true }, { ...CREATE, webhook: HOOK }));
    expect(err.code).toBe('MISSING_PARAM');
    expect(api.alertsCreate).not.toHaveBeenCalled();
  });

  it.each([`${STDIN_SECRET}\n${STDIN_SECRET}`, `${STDIN_SECRET}\u0000x`, `${STDIN_SECRET}\u001b`])('rejects multi-line or control-character input without echoing it', async (value) => {
    const { api, cmd } = setup({ stdin: Readable.from([value]) });
    const err = await failure(cmd(['create'], api, { 'webhook-secret-stdin': true }, { ...CREATE, webhook: HOOK }));
    expect(err.code).toBe('INVALID_PARAMS');
    expect(JSON.stringify(formatError(err))).not.toContain(STDIN_SECRET);
    expect(api.alertsCreate).not.toHaveBeenCalled();
  });

  it('refuses a terminal on stdin before reading', async () => {
    const stdin = Object.assign(new PassThrough(), { isTTY: true });
    const { api, cmd } = setup({ stdin });
    const err = await failure(cmd(['create'], api, { 'webhook-secret-stdin': true }, { ...CREATE, webhook: HOOK }));
    expect(err.code).toBe('NOT_A_PIPE');
    expect(err.message).toContain('--webhook-secret-stdin');
  });

  it('rejects a secret shorter than 16 characters and names the source', async () => {
    const { api, cmd } = setup({ stdin: Readable.from(['short\n']) });
    const err = await failure(cmd(['create'], api, { 'webhook-secret-stdin': true }, { ...CREATE, webhook: HOOK }));
    expect(err.message).toBe('The webhook secret from --webhook-secret-stdin must be at least 16 characters');
  });

  it('rejects a redacted value piped back from alerts output', async () => {
    const { api, cmd } = setup({ stdin: Readable.from([REDACTED.repeat(4)]) });
    const err = await failure(cmd(['create'], api, { 'webhook-secret-stdin': true }, { ...CREATE, webhook: HOOK }));
    expect(err.message).toContain('looks like a redacted value');
  });

  it('accepts a real secret that contains asterisks', async () => {
    const { api, cmd } = setup({ stdin: Readable.from(['abc****defghijklmnop']) });
    await cmd(['create'], api, { 'webhook-secret-stdin': true }, { ...CREATE, webhook: HOOK });
    expect(sentSecret(api)).toBe('abc****defghijklmnop');
  });

  it('requires --webhook and does not read stdin without it', async () => {
    const stdin = new PassThrough();
    const { api, cmd } = setup({ stdin });
    const err = await failure(cmd(['create'], api, { 'webhook-secret-stdin': true }, { ...CREATE, telegram: '1' }));
    expect(err.message).toBe('--webhook-secret-stdin requires --webhook');
    expect(stdin.destroyed).toBe(false);
  });

  it('times out a pipe that never closes', async () => {
    const input = new PassThrough();
    input.write(STDIN_SECRET);
    const err = await readWebhookSecretInput(input, false, { timeoutMs: 10 }).catch(e => e);
    expect(err.code).toBe('INVALID_PARAMS');
    expect(err.message).not.toContain(STDIN_SECRET);
    expect(input.destroyed).toBe(true);
  });

  it('rejects input over 4096 bytes', async () => {
    const err = await readWebhookSecretInput(Readable.from([Buffer.alloc(5000, 'a')]), false).catch(e => e);
    expect(err.code).toBe('INVALID_PARAMS');
  });

  it('is parsed as a valueless flag', () => {
    const parsed = parseArgs(['alerts', 'create', '--webhook-secret-stdin', '--webhook', HOOK]);
    expect(parsed.flags['webhook-secret-stdin']).toBe(true);
    expect(parsed.options.webhook).toBe(HOOK);
    expect(() => parseArgs(['alerts', 'create', '--webhook-secret-stdin=abc'])).toThrow('does not accept a value');
  });
});

describe('webhook secret from the environment', () => {
  it('is used with --webhook on create and trimmed', async () => {
    const { api, cmd } = setup({ env: { [WEBHOOK_SECRET_ENV]: ` ${ENV_SECRET}\n` } });
    const result = await cmd(['create'], api, {}, { ...CREATE, webhook: HOOK });
    expect(sentSecret(api)).toBe(ENV_SECRET);
    expect(JSON.stringify(result)).not.toContain(ENV_SECRET);
  });

  it('is used with --webhook on update', async () => {
    const { api, cmd } = setup({ env: { [WEBHOOK_SECRET_ENV]: ENV_SECRET } });
    await cmd(['update', 'a1'], api, {}, { webhook: HOOK });
    expect(sentSecret(api, 'alertsUpdate')).toBe(ENV_SECRET);
  });

  it('is ignored without --webhook, so an exported variable does not break other channels', async () => {
    const { api, cmd } = setup({ env: { [WEBHOOK_SECRET_ENV]: ENV_SECRET } });
    await cmd(['create'], api, {}, { ...CREATE, telegram: '123' });
    expect(JSON.stringify(api.alertsCreate.mock.calls[0][0])).not.toContain(ENV_SECRET);
    await cmd(['update', 'a1'], api, {}, { name: 'renamed' });
    expect(api.alertsUpdate.mock.calls[0][0].channels).toBeUndefined();
  });

  it.each([`${ENV_SECRET}\nsecond-line`, `${ENV_SECRET}\u0007`])('rejects a multi-line or control-character value without echoing it', async (value) => {
    const { api, cmd } = setup({ env: { [WEBHOOK_SECRET_ENV]: value } });
    const err = await failure(cmd(['create'], api, {}, { ...CREATE, webhook: HOOK }));
    expect(err.code).toBe('INVALID_PARAMS');
    expect(JSON.stringify(formatError(err))).not.toContain(ENV_SECRET);
    expect(api.alertsCreate).not.toHaveBeenCalled();
  });

  it('treats a blank variable as unset', async () => {
    const { api, cmd } = setup({ env: { [WEBHOOK_SECRET_ENV]: '  ' } });
    await cmd(['create'], api, {}, { ...CREATE, webhook: HOOK });
    expect(sentSecret(api)).toBeUndefined();
  });

  it('rejects a short value and names the variable, not the value', async () => {
    const { api, cmd } = setup({ env: { [WEBHOOK_SECRET_ENV]: 'short-env' } });
    const err = await failure(cmd(['create'], api, {}, { ...CREATE, webhook: HOOK }));
    expect(err.message).toBe(`The webhook secret from ${WEBHOOK_SECRET_ENV} must be at least 16 characters`);
    expect(err.message).not.toContain('short-env');
  });
});

describe('webhook secret precedence', () => {
  it('rejects repeated bare --webhook-secret flags instead of falling back to the environment', async () => {
    const parsed = parseArgs(['alerts', 'create', '--webhook', HOOK, '--webhook-secret', '--webhook-secret']);
    const { api, cmd } = setup({ env: { [WEBHOOK_SECRET_ENV]: ENV_SECRET } });
    const err = await failure(cmd(['create'], api, parsed.flags, { ...CREATE, ...parsed.options }));
    expect(err.code).toBe('MISSING_PARAM');
    expect(api.alertsCreate).not.toHaveBeenCalled();
  });

  it('rejects --webhook-secret together with --webhook-secret-stdin', async () => {
    const stdin = new PassThrough();
    const { api, cmd } = setup({ stdin });
    const err = await failure(cmd(['create'], api, { 'webhook-secret-stdin': true }, { ...CREATE, webhook: HOOK, 'webhook-secret': FLAG_SECRET }));
    expect(err.code).toBe(ErrorCode.INVALID_PARAMS);
    expect(err.message).toBe('Use either --webhook-secret or --webhook-secret-stdin, not both.');
    expect(err.message).not.toContain(FLAG_SECRET);
    expect(api.alertsCreate).not.toHaveBeenCalled();
  });

  it('--webhook-secret overrides the environment', async () => {
    const { api, cmd } = setup({ env: { [WEBHOOK_SECRET_ENV]: ENV_SECRET } });
    await cmd(['create'], api, {}, { ...CREATE, webhook: HOOK, 'webhook-secret': FLAG_SECRET });
    expect(sentSecret(api)).toBe(FLAG_SECRET);
  });

  it('--webhook-secret-stdin overrides the environment', async () => {
    const { api, cmd } = setup({ env: { [WEBHOOK_SECRET_ENV]: ENV_SECRET }, stdin: Readable.from([STDIN_SECRET]) });
    await cmd(['create'], api, { 'webhook-secret-stdin': true }, { ...CREATE, webhook: HOOK });
    expect(sentSecret(api)).toBe(STDIN_SECRET);
  });

  it('keeps --webhook-secret working on its own', async () => {
    const { api, cmd } = setup();
    await cmd(['create'], api, {}, { ...CREATE, webhook: HOOK, 'webhook-secret': FLAG_SECRET });
    expect(sentSecret(api)).toBe(FLAG_SECRET);
  });

  it.each([
    [{ 'webhook-secret': true }, {}, 'MISSING_PARAM'],
    [{ 'webhook-secret': [true, true] }, {}, 'MISSING_PARAM'],
    [{ 'webhook-secret': true }, { 'webhook-secret': FLAG_SECRET }, 'INVALID_PARAMS'],
    [{}, { 'webhook-secret': '' }, 'INVALID_PARAMS'],
  ])('rejects --webhook-secret without a usable value (flags %j, options %j)', async (flags, opts, code) => {
    const { api, cmd } = setup({ env: { [WEBHOOK_SECRET_ENV]: ENV_SECRET } });
    const err = await failure(cmd(['create'], api, flags, { ...CREATE, webhook: HOOK, ...opts }));
    expect(err.code).toBe(code);
    expect(api.alertsCreate).not.toHaveBeenCalled();
  });
});

describe('webhook secret is never printed', () => {
  it('masks a stdin secret echoed in an API error', async () => {
    const { api, cmd } = setup({ stdin: Readable.from([STDIN_SECRET]) });
    api.alertsCreate.mockRejectedValue(new NansenError(`bad secret ${STDIN_SECRET}`, ErrorCode.INVALID_PARAMS, 422, { input: { secret: STDIN_SECRET } }));
    const err = await failure(cmd(['create'], api, { 'webhook-secret-stdin': true }, { ...CREATE, webhook: HOOK }));
    const printed = JSON.stringify(formatError(err));
    expect(printed).not.toContain(STDIN_SECRET);
    expect(formatError(err).error).toBe(`bad secret ${REDACTED}`);
  });

  it('masks an environment secret echoed in an API error', async () => {
    const { api, cmd } = setup({ env: { [WEBHOOK_SECRET_ENV]: ENV_SECRET } });
    api.alertsCreate.mockRejectedValue(new NansenError(`bad secret ${ENV_SECRET}`, ErrorCode.INVALID_PARAMS, 422));
    const err = await failure(cmd(['create'], api, {}, { ...CREATE, webhook: HOOK }));
    expect(JSON.stringify(formatError(err))).not.toContain(ENV_SECRET);
  });

  async function runCreate(extraArgs, deps) {
    const out = [];
    const record = (...a) => out.push(a.join(' '));
    const sent = [];
    class FakeAPI {
      async alertsCreate(p) { sent.push(p); return { id: 'new', ...p }; }
    }
    await runCLI(['alerts', 'create', '--name', 'x', '--type', 'sm-token-flows', '--chains', 'ethereum', '--inflow-1h-min', '1',
      '--webhook', HOOK, ...extraArgs], { output: record, errorOutput: record, exit: vi.fn(), NansenAPIClass: FakeAPI, ...deps });
    return { text: out.join('\n'), sent };
  }

  it('sends the stdin secret but does not print it through runCLI', async () => {
    const { text, sent } = await runCreate(['--webhook-secret-stdin'], { env: {}, stdin: Readable.from([`${STDIN_SECRET}\n`]) });
    expect(sent[0].channels[0].data.secret).toBe(STDIN_SECRET);
    expect(text).toContain('new');
    expect(text).not.toContain(STDIN_SECRET);
  });

  it('sends the environment secret but does not print it through runCLI', async () => {
    const { text, sent } = await runCreate([], { env: { [WEBHOOK_SECRET_ENV]: ENV_SECRET }, stdin: Readable.from([]) });
    expect(sent[0].channels[0].data.secret).toBe(ENV_SECRET);
    expect(text).toContain('new');
    expect(text).not.toContain(ENV_SECRET);
  });
});
