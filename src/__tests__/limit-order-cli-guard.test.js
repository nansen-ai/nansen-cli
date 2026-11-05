/**
 * CLI-level regressions for limit-order execution guards.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const mocks = vi.hoisted(() => ({
  getUpdateNotification: vi.fn(() => null),
  getUpgradeNotice: vi.fn(() => null),
  scheduleUpdateCheck: vi.fn(),
  trackSucceeded: vi.fn(),
  trackFailed: vi.fn(),
  trackAuth: vi.fn(),
  authConfigView: vi.fn(() => { throw new Error('saved Nansen credentials were accessed'); }),
  resolveCredential: vi.fn(() => { throw new Error('saved Nansen credentials were resolved'); }),
}));

vi.mock('../update-check.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getUpdateNotification: mocks.getUpdateNotification,
  getUpgradeNotice: mocks.getUpgradeNotice,
  scheduleUpdateCheck: mocks.scheduleUpdateCheck,
}));

vi.mock('../telemetry.js', async (importOriginal) => ({
  ...(await importOriginal()),
  trackCommandSucceeded: mocks.trackSucceeded,
  trackCommandFailed: mocks.trackFailed,
  trackAuthCommand: mocks.trackAuth,
  trackPerpOrderCompleted: vi.fn(),
  getAnonymousId: () => 'limit-order-guard-test',
  getSessionId: () => 'limit-order-guard-session',
}));

vi.mock('../auth-credentials.js', async (importOriginal) => ({
  ...(await importOriginal()),
  authConfigView: mocks.authConfigView,
  resolveCredential: mocks.resolveCredential,
}));

const { runCLI } = await import('../cli.js');
const { createWallet } = await import('../wallet.js');

let originalHome;
let tempDir;

beforeEach(() => {
  originalHome = process.env.HOME;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nansen-lo-cli-guard-'));
  process.env.HOME = tempDir;
  createWallet('guard-wallet', null);
  for (const mock of Object.values(mocks)) mock.mockClear();
});

afterEach(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function createArgs(extra = []) {
  return [
    'trade', 'limit-order', 'create',
    '--from', 'SOL', '--to', 'USDC', '--amount', '1',
    '--trigger-mint', 'SOL', '--trigger-condition', 'below', '--trigger-price', '80',
    '--wallet', 'guard-wallet',
    ...extra,
  ];
}

function cancelArgs(extra = []) {
  return [
    'trade', 'limit-order', 'cancel', '--order', 'order-guard',
    '--wallet', 'guard-wallet',
    ...extra,
  ];
}

describe('runCLI limit-order guard integration', () => {
  it.each([
    ['create', createArgs(['--dry-run'])],
    ['cancel', cancelArgs(['--dry-run'])],
  ])('%s --dry-run is fully offline before API construction', async (_name, args) => {
    const NansenAPIClass = vi.fn(() => { throw new Error('NansenAPI constructed'); });
    const exit = vi.fn();
    const result = await runCLI(args, {
      NansenAPIClass,
      output: vi.fn(),
      errorOutput: vi.fn(),
      log: vi.fn(),
      exit,
      env: {},
    });

    expect(result).toEqual({ type: 'no-output', command: 'trade' });
    expect(exit).not.toHaveBeenCalled();
    expect(NansenAPIClass).not.toHaveBeenCalled();
    expect(mocks.getUpdateNotification).not.toHaveBeenCalled();
    expect(mocks.getUpgradeNotice).not.toHaveBeenCalled();
    expect(mocks.scheduleUpdateCheck).not.toHaveBeenCalled();
    expect(mocks.trackSucceeded).not.toHaveBeenCalled();
    expect(mocks.trackFailed).not.toHaveBeenCalled();
    expect(mocks.trackAuth).not.toHaveBeenCalled();
  });

  it.each([
    ['create', createArgs(['--dry-run'])],
    ['cancel', cancelArgs(['--dry-run'])],
  ])('%s --dry-run does not inspect saved Nansen credentials', async (_name, args) => {
    const result = await runCLI(args, {
      output: vi.fn(), errorOutput: vi.fn(), log: vi.fn(), exit: vi.fn(), env: {},
    });

    expect(result.type).toBe('no-output');
    expect(mocks.authConfigView).not.toHaveBeenCalled();
    expect(mocks.resolveCredential).not.toHaveBeenCalled();
  });

  it('an interactive decline reaches runCLI as one unified failed command', async () => {
    const output = vi.fn();
    const confirmationLog = vi.fn();
    const exit = vi.fn();
    const result = await runCLI(createArgs(), {
      NansenAPIClass: vi.fn(function MockAPI() { return {}; }),
      output,
      errorOutput: vi.fn(),
      log: vi.fn(),
      confirmationLog,
      confirmationPromptFn: vi.fn(async () => 'no'),
      isInputTTY: true,
      exit,
      env: {},
    });

    expect(result).toMatchObject({
      type: 'error',
      data: { code: 'CONFIRMATION_DECLINED' },
    });
    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(1);
    expect(output).not.toHaveBeenCalled();
    expect(confirmationLog.mock.calls.filter(([message]) => message.includes('Aborted at the confirmation prompt'))).toHaveLength(1);
    expect(mocks.trackSucceeded).not.toHaveBeenCalled();
    expect(mocks.trackFailed).toHaveBeenCalledOnce();
    expect(mocks.trackFailed.mock.calls[0][0]).toMatchObject({
      command: 'trade limit-order',
      error_code: 'CONFIRMATION_DECLINED',
    });
  });
});
