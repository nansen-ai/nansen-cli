/**
 * wallet export must never disclose private keys unless explicitly
 * acknowledged (--reveal) or routed to a 0600 file (--file). These tests also
 * prove key material stays out of ordinary errors, debug stderr output, and
 * telemetry payloads.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ── Mock telemetry before cli.js is imported ──
const trackSucceeded = vi.fn();
const trackFailed = vi.fn();

vi.mock('../telemetry.js', async (importOriginal) => ({
  ...(await importOriginal()),
  trackCommandSucceeded: trackSucceeded,
  trackCommandFailed: trackFailed,
  trackPerpOrderCompleted: vi.fn(),
  getAnonymousId: () => 'test-anon-id',
  getSessionId: () => 'test-session-id',
}));

const { runCLI, parseArgs } = await import('../cli.js');
const { createWallet, exportWallet, buildWalletCommands } = await import('../wallet.js');

const PASSWORD = 'correct-horse-battery-staple';

let tempDir;
let originalHome;
let originalPassword;

beforeEach(() => {
  originalHome = process.env.HOME;
  originalPassword = process.env.NANSEN_WALLET_PASSWORD;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nansen-export-guard-'));
  process.env.HOME = tempDir;
  process.env.NANSEN_WALLET_PASSWORD = PASSWORD;
  trackSucceeded.mockClear();
  trackFailed.mockClear();
});

afterEach(() => {
  process.env.HOME = originalHome;
  if (originalPassword === undefined) delete process.env.NANSEN_WALLET_PASSWORD;
  else process.env.NANSEN_WALLET_PASSWORD = originalPassword;
  delete process.env.NANSEN_DEBUG;
  delete process.env.DEBUG;
  fs.rmSync(tempDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

/** Create a wallet and return its actual decrypted private keys. */
function createWalletWithKeys(name) {
  createWallet(name, PASSWORD);
  const exported = exportWallet(name, PASSWORD);
  return { evmKey: exported.evm.privateKey, solanaKey: exported.solana.privateKey };
}

function assertNoKeyMaterial(text, keys) {
  expect(text).not.toContain(keys.evmKey);
  expect(text).not.toContain(keys.solanaKey);
}

/** Run the export handler; returns { logs, error }. */
async function runExport(args, flags = {}, options = {}, deps = {}) {
  const logs = [];
  const cmds = buildWalletCommands({ log: (m) => logs.push(String(m)), ...deps });
  let error = null;
  try {
    await cmds['wallet'](['export', ...args], null, flags, options);
  } catch (err) {
    error = err;
  }
  return { logs, error };
}

describe('wallet export — redacted default', () => {
  it('prints addresses but never key material, without needing a password', async () => {
    const keys = createWalletWithKeys('guard');
    delete process.env.NANSEN_WALLET_PASSWORD; // proves the default path never decrypts

    const { logs, error } = await runExport(['guard']);
    expect(error).toBeNull();
    const out = logs.join('\n');
    expect(out).toContain('[REDACTED]');
    expect(out).toContain('--reveal');
    expect(out).toContain('--file');
    assertNoKeyMaterial(out, keys);
    // No key-shaped blob of any kind (EVM keys are 64 hex, Solana keypairs 128 hex)
    expect(out).not.toMatch(/[0-9a-fA-F]{64}/);
  });

  it('still rejects non-local wallets', async () => {
    fs.mkdirSync(path.join(tempDir, '.nansen', 'wallets'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, '.nansen', 'wallets', 'privy-w.json'),
      JSON.stringify({ name: 'privy-w', provider: 'privy', evm: { address: '0xabc' }, solana: { address: 'So1' } })
    );
    const { error } = await runExport(['privy-w']);
    expect(error).toBeTruthy();
    expect(error.message).toContain("don't support key export");
  });
});

describe('wallet export --reveal', () => {
  it('prints plaintext keys to stdout', async () => {
    const keys = createWalletWithKeys('revealed');
    const { logs, error } = await runExport(['revealed'], { reveal: true });
    expect(error).toBeNull();
    const out = logs.join('\n');
    expect(out).toContain(keys.evmKey);
    expect(out).toContain(keys.solanaKey);
  });

  it('warns on stderr when stdout is a TTY, without leaking keys into the warning', async () => {
    const keys = createWalletWithKeys('tty-warn');
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await runExport(['tty-warn'], { reveal: true }, {}, { isTTY: true });
    const warnings = stderrSpy.mock.calls.map((c) => String(c[0]));
    stderrSpy.mockRestore();

    const ttyWarning = warnings.find((w) => w.includes('interactive terminal'));
    expect(ttyWarning).toBeTruthy();
    assertNoKeyMaterial(warnings.join('\n'), keys);
  });

  it('does not warn when stdout is not a TTY', async () => {
    createWalletWithKeys('no-tty');
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await runExport(['no-tty'], { reveal: true }, {}, { isTTY: false });
    const warnings = stderrSpy.mock.calls.map((c) => String(c[0]));
    stderrSpy.mockRestore();

    expect(warnings.find((w) => w.includes('interactive terminal'))).toBeUndefined();
  });

  it('keeps wallet export on the stdout TTY signal when stdin is interactive', async () => {
    createWalletWithKeys('split-tty');
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await runCLI(['wallet', 'export', 'split-tty', '--reveal'], {
      output: () => {},
      log: () => {},
      errorOutput: () => {},
      exit: () => {},
      isTTY: false,
      isInputTTY: true,
    });
    const warnings = stderrSpy.mock.calls.map((c) => String(c[0]));
    stderrSpy.mockRestore();

    expect(warnings.find((w) => w.includes('interactive terminal'))).toBeUndefined();
  });
});

describe('wallet export --file', () => {
  it('writes keys to a 0600 file and keeps stdout clean', async () => {
    const keys = createWalletWithKeys('filed');
    const outFile = path.join(tempDir, 'export.json');

    const { logs, error } = await runExport(['filed'], {}, { file: outFile });
    expect(error).toBeNull();

    const mode = fs.statSync(outFile).mode & 0o777;
    expect(mode).toBe(0o600);
    const written = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    expect(written.evm.privateKey).toBe(keys.evmKey);
    expect(written.solana.privateKey).toBe(keys.solanaKey);

    assertNoKeyMaterial(logs.join('\n'), keys);
  });

  it('refuses to overwrite an existing file, leaking nothing (post-decryption failure)', async () => {
    const keys = createWalletWithKeys('no-clobber');
    const outFile = path.join(tempDir, 'existing.json');
    fs.writeFileSync(outFile, 'precious');

    const { logs, error } = await runExport(['no-clobber'], {}, { file: outFile });
    expect(error).toBeTruthy();
    expect(error.message).toContain('refusing to overwrite');
    expect(error.code).toBe('FILE_EXISTS');
    expect(error.cause?.code).toBe('EEXIST');
    expect(fs.readFileSync(outFile, 'utf8')).toBe('precious');

    // Keys were already decrypted when the write failed — the error envelope,
    // its details, its cause, and everything logged must still be key-free.
    assertNoKeyMaterial(JSON.stringify({ message: error.message, details: error.details ?? null, cause: String(error.cause) }), keys);
    assertNoKeyMaterial(logs.join('\n'), keys);
  });

  it('reports a non-EEXIST create failure as FILE_WRITE_FAILED, leaking nothing', async () => {
    const keys = createWalletWithKeys('no-parent');
    const outFile = path.join(tempDir, 'missing-dir', 'export.json'); // parent does not exist → ENOENT

    const { logs, error } = await runExport(['no-parent'], {}, { file: outFile });
    expect(error).toBeTruthy();
    expect(error.code).toBe('FILE_WRITE_FAILED');
    expect(error.cause?.code).toBe('ENOENT');
    expect(error.message).toContain('Nothing was written');
    expect(fs.existsSync(outFile)).toBe(false);
    assertNoKeyMaterial(JSON.stringify({ m: error.message, d: error.details ?? null, c: String(error.cause) }), keys);
    assertNoKeyMaterial(logs.join('\n'), keys);
  });

  it('keeps EXPORT_FAILED for decryption failures on the --file path and creates no file', async () => {
    const keys = createWalletWithKeys('file-wrong-pw');
    const outFile = path.join(tempDir, 'never.json');
    process.env.NANSEN_WALLET_PASSWORD = 'wrong-password-123';

    const { logs, error } = await runExport(['file-wrong-pw'], {}, { file: outFile });
    expect(error).toBeTruthy();
    expect(error.code).toBe('EXPORT_FAILED');
    expect(fs.existsSync(outFile)).toBe(false);
    assertNoKeyMaterial(JSON.stringify({ m: error.message, d: error.details ?? null }) + logs.join('\n'), keys);
  });

  it('surfaces FILE_EXISTS as the machine-readable code in the JSON error envelope', async () => {
    const keys = createWalletWithKeys('envelope');
    const outFile = path.join(tempDir, 'taken.json');
    fs.writeFileSync(outFile, 'precious');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const outputs = [];

    await runCLI(['wallet', 'export', 'envelope', '--file', outFile], {
      output: (m) => outputs.push(String(m)),
      log: () => {},
      errorOutput: () => {},
      exit: () => {},
      isTTY: false,
    });

    const envelope = JSON.parse(outputs.join(''));
    expect(envelope.success).toBe(false);
    expect(envelope.code).toBe('FILE_EXISTS');
    expect(fs.readFileSync(outFile, 'utf8')).toBe('precious');
    const tracked = JSON.stringify(trackFailed.mock.calls);
    expect(tracked).toContain('FILE_EXISTS');
    assertNoKeyMaterial(outputs.join('\n') + tracked, keys);
  });

  it('pins the file to exactly 0600 under a restrictive umask', async () => {
    const keys = createWalletWithKeys('umask');
    const outFile = path.join(tempDir, 'umask.json');
    // 0277 strips the owner write bit from the 0o600 passed to openSync, so
    // without the fchmod pin the file would land on disk as 0400.
    const previousUmask = process.umask(0o277);
    let run;
    try {
      run = await runExport(['umask'], {}, { file: outFile });
    } finally {
      process.umask(previousUmask);
    }

    expect(run.error).toBeNull();
    expect(fs.statSync(outFile).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(outFile, 'utf8')).evm.privateKey).toBe(keys.evmKey);
    assertNoKeyMaterial(run.logs.join('\n'), keys);
  });

  it('removes the created file and writes no key bytes when pinning 0600 fails', async () => {
    const keys = createWalletWithKeys('chmod-fail');
    const outFile = path.join(tempDir, 'chmod-fail.json');
    const chmodSpy = vi.spyOn(fs, 'fchmodSync').mockImplementation(() => {
      const err = new Error('operation not permitted');
      err.code = 'EPERM';
      throw err;
    });
    const writeSpy = vi.spyOn(fs, 'writeFileSync'); // pass-through, records calls

    const { logs, error } = await runExport(['chmod-fail'], {}, { file: outFile });
    const fdWrites = writeSpy.mock.calls.filter((c) => typeof c[0] === 'number');
    chmodSpy.mockRestore();
    writeSpy.mockRestore();

    expect(error).toBeTruthy();
    expect(error.code).toBe('FILE_WRITE_FAILED');
    expect(error.cause?.code).toBe('EPERM');
    expect(error.message).toContain('Nothing was left on disk');
    expect(fdWrites).toHaveLength(0); // the write never ran, so no key bytes touched the fd
    expect(fs.existsSync(outFile)).toBe(false);
    assertNoKeyMaterial(JSON.stringify({ m: error.message, d: error.details ?? null, c: String(error.cause) }) + logs.join('\n'), keys);
  });

  it('removes a partially written file when the write fails mid-way', async () => {
    const keys = createWalletWithKeys('partial');
    const outFile = path.join(tempDir, 'partial.json');
    const realWrite = fs.writeFileSync.bind(fs);
    // The handler exclusively creates the file, then writes to the open fd.
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation((target, data, opts) => {
      if (typeof target === 'number') {
        realWrite(target, String(data).slice(0, 24)); // simulate partial flush...
        const err = new Error('no space left on device');
        err.code = 'ENOSPC';
        throw err; // ...then the disk fills up
      }
      return realWrite(target, data, opts);
    });

    const { error } = await runExport(['partial'], {}, { file: outFile });
    spy.mockRestore();

    expect(error).toBeTruthy();
    expect(error.code).toBe('FILE_WRITE_FAILED');
    expect(error.cause?.code).toBe('ENOSPC');
    expect(error.message).toContain('Nothing was left on disk');
    expect(fs.existsSync(outFile)).toBe(false);
    assertNoKeyMaterial(JSON.stringify({ m: error.message, d: error.details ?? null, c: String(error.cause) }), keys);
  });

  it('rejects a bare --file (parsed as a boolean flag) before decrypting', async () => {
    createWalletWithKeys('bare-file');
    const { error } = await runExport(['bare-file'], { file: true }, {});
    expect(error).toBeTruthy();
    expect(error.code).toBe('INVALID_INPUT');
  });

  it('rejects a non-string --file value (JSON-parsed by parseArgs) before decrypting', async () => {
    createWalletWithKeys('bool-file');
    const { error } = await runExport(['bool-file'], {}, { file: true });
    expect(error).toBeTruthy();
    expect(error.code).toBe('INVALID_INPUT');
  });

  it('rejects an empty-string --file before decrypting', async () => {
    createWalletWithKeys('empty-file');
    // With no password available, reaching the decrypt stage would surface
    // PASSWORD_REQUIRED instead — so INVALID_INPUT proves the guard ran first.
    delete process.env.NANSEN_WALLET_PASSWORD;
    const direct = await runExport(['empty-file'], {}, { file: '' });
    expect(direct.error?.code).toBe('INVALID_INPUT');

    // parseArgs keeps an explicit "" as the option value (e.g. --file "$UNSET_VAR").
    const parsed = parseArgs(['export', 'empty-file', '--file', '']);
    expect(parsed.options.file).toBe('');
    const viaParser = await runExport(['empty-file'], parsed.flags, parsed.options);
    expect(viaParser.error?.code).toBe('INVALID_INPUT');
  });

  it('refuses when --file points at an existing directory', async () => {
    const keys = createWalletWithKeys('dir-target');
    const { logs, error } = await runExport(['dir-target'], {}, { file: tempDir });
    expect(error).toBeTruthy();
    expect(error.message).toContain('refusing to overwrite');
    expect(error.code).toBe('FILE_EXISTS');
    // Linux reports a directory target as EEXIST, macOS may report EISDIR.
    expect(['EEXIST', 'EISDIR']).toContain(error.cause?.code);
    expect(error.message).not.toContain('Delete');
    expect(fs.statSync(tempDir).isDirectory()).toBe(true);
    assertNoKeyMaterial(logs.join('\n') + error.message, keys);
  });

  it('maps an EISDIR from the exclusive create to FILE_EXISTS (macOS directory target)', async () => {
    const keys = createWalletWithKeys('eisdir-target');
    const outFile = path.join(tempDir, 'is-a-dir.json');
    const realOpen = fs.openSync.bind(fs);
    // Only the 'wx' create is intercepted; every other open in the flow is real.
    const spy = vi.spyOn(fs, 'openSync').mockImplementation((target, flags, mode) => {
      if (target === outFile && flags === 'wx') {
        const err = new Error('illegal operation on a directory');
        err.code = 'EISDIR';
        throw err;
      }
      return realOpen(target, flags, mode);
    });

    const { logs, error } = await runExport(['eisdir-target'], {}, { file: outFile });
    spy.mockRestore();

    expect(error).toBeTruthy();
    expect(error.code).toBe('FILE_EXISTS');
    expect(error.message).toContain('refusing to overwrite');
    expect(error.message).not.toContain('Nothing was written');
    expect(error.message).not.toContain('Delete');
    expect(error.cause?.code).toBe('EISDIR');
    expect(fs.existsSync(outFile)).toBe(false);
    assertNoKeyMaterial(JSON.stringify({ m: error.message, d: error.details ?? null, c: String(error.cause) }) + logs.join('\n'), keys);
  });

  it('rejects --reveal combined with --file', async () => {
    createWalletWithKeys('both');
    const { error } = await runExport(['both'], { reveal: true }, { file: path.join(tempDir, 'x.json') });
    expect(error).toBeTruthy();
    expect(error.code).toBe('INVALID_INPUT');
  });
});

describe('wallet export — parser interaction', () => {
  it('parses --reveal as a boolean flag so it never swallows the wallet name', () => {
    const { _: positional, flags } = parseArgs(['wallet', 'export', '--reveal', 'alice']);
    expect(flags.reveal).toBe(true);
    expect(positional).toEqual(['wallet', 'export', 'alice']);
  });

  it('"--file --reveal" ordering is rejected by the bare --file guard before any decryption', async () => {
    const keys = createWalletWithKeys('ordering');
    // With no password available, reaching the decryption path could only fail
    // with PASSWORD_REQUIRED — so an INVALID_INPUT proves the guard fired first.
    delete process.env.NANSEN_WALLET_PASSWORD;

    // `reveal` is a valueless flag, so `--file` gets no value: the parser yields
    // flags.file = true and no options.file. That trips the bare-`--file` guard,
    // which intentionally runs before the --reveal/--file conflict guard, so
    // this ordering never reaches the "not both" message. Both guards throw
    // INVALID_INPUT without decrypting; this test pins which one fires.
    const parsed = parseArgs(['export', 'ordering', '--file', '--reveal']);
    expect(parsed.flags).toEqual({ file: true, reveal: true });
    expect(parsed.options.file).toBeUndefined();

    const { logs, error } = await runExport(['ordering'], parsed.flags, parsed.options);
    expect(error).toBeTruthy();
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toContain('--file requires a path');
    expect(error.message).not.toContain('not both');
    expect(logs).toEqual([]);
    assertNoKeyMaterial(
      JSON.stringify({ m: error.message, d: error.details ?? null, c: String(error.cause ?? '') }),
      keys
    );
  });

  it('"--file <path> --reveal" ordering is rejected by the conflict guard before any decryption', async () => {
    const keys = createWalletWithKeys('ordering-conflict');
    delete process.env.NANSEN_WALLET_PASSWORD;
    const outFile = path.join(tempDir, 'conflict.json');

    const parsed = parseArgs(['export', 'ordering-conflict', '--file', outFile, '--reveal']);
    expect(parsed.options.file).toBe(outFile);
    expect(parsed.flags.reveal).toBe(true);

    const { logs, error } = await runExport(['ordering-conflict'], parsed.flags, parsed.options);
    expect(error).toBeTruthy();
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toContain('not both');
    expect(fs.existsSync(outFile)).toBe(false);
    expect(logs).toEqual([]);
    assertNoKeyMaterial(
      JSON.stringify({ m: error.message, d: error.details ?? null, c: String(error.cause ?? '') }),
      keys
    );
  });
});

describe('wallet export — secrecy of errors, debug logs, and telemetry', () => {
  it('wrong-password and missing-wallet errors carry no key material', async () => {
    const keys = createWalletWithKeys('err-clean');

    process.env.NANSEN_WALLET_PASSWORD = 'wrong-password-123';
    const wrongPw = await runExport(['err-clean'], { reveal: true });
    expect(wrongPw.error).toBeTruthy();
    assertNoKeyMaterial(JSON.stringify({ m: wrongPw.error.message, d: wrongPw.error.details ?? null }), keys);

    process.env.NANSEN_WALLET_PASSWORD = PASSWORD;
    const missing = await runExport(['does-not-exist'], { reveal: true });
    expect(missing.error).toBeTruthy();
    assertNoKeyMaterial(JSON.stringify({ m: missing.error.message, d: missing.error.details ?? null }), keys);
  });

  it('telemetry payloads never contain key material, even on a successful --reveal', async () => {
    const keys = createWalletWithKeys('tele');
    const outputs = [];
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchSpy);

    await runCLI(['wallet', 'export', 'tele', '--reveal'], {
      output: (m) => outputs.push(String(m)),
      log: (m) => outputs.push(String(m)), // wallet handlers print via deps.log
      errorOutput: () => {},
      exit: () => {},
      isTTY: false,
    });

    // The command actually revealed keys on stdout...
    expect(outputs.join('\n')).toContain(keys.evmKey);

    // ...but what telemetry tracked carries only names/codes, never values.
    const tracked = JSON.stringify([...trackSucceeded.mock.calls, ...trackFailed.mock.calls]);
    assertNoKeyMaterial(tracked, keys);
    expect(tracked).not.toContain(PASSWORD);
    // and any raw network payload sent during the run is clean too
    const fetched = JSON.stringify(fetchSpy.mock.calls);
    assertNoKeyMaterial(fetched, keys);
  });

  it('telemetry on a failed export carries only the error code', async () => {
    const keys = createWalletWithKeys('tele-fail');
    process.env.NANSEN_WALLET_PASSWORD = 'wrong-password-123';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));

    await runCLI(['wallet', 'export', 'tele-fail', '--reveal'], {
      output: () => {},
      log: () => {},
      errorOutput: () => {},
      exit: () => {},
      isTTY: false,
    });

    expect(trackFailed).toHaveBeenCalled();
    const tracked = JSON.stringify(trackFailed.mock.calls);
    expect(tracked).toContain('EXPORT_FAILED');
    assertNoKeyMaterial(tracked, keys);
    expect(tracked).not.toContain('wrong-password-123');
  });

  it('NANSEN_DEBUG=1 runs write no key material to stderr', async () => {
    const keys = createWalletWithKeys('dbg');
    process.env.NANSEN_DEBUG = '1';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const errorOutputs = [];

    await runCLI(['wallet', 'export', 'dbg', '--reveal'], {
      output: () => {},
      log: () => {},
      errorOutput: (m) => errorOutputs.push(String(m)),
      exit: () => {},
      isTTY: false,
    });

    const stderr = stderrSpy.mock.calls.map((c) => String(c[0])).join('\n');
    stderrSpy.mockRestore();
    assertNoKeyMaterial(stderr, keys);
    assertNoKeyMaterial(errorOutputs.join('\n'), keys);
  });
});
