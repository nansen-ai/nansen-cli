/**
 * Tests for the `nansen status` command
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildCommands, runCLI } from '../cli.js';
import { NansenError, ErrorCode } from '../api.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('status command', () => {
  let commands;
  let logs;
  let tempDir;
  let originalHome;

  beforeEach(() => {
    logs = [];
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nansen-status-test-'));
    originalHome = process.env.HOME;
    process.env.HOME = tempDir;

    commands = buildCommands({
      log: (msg) => logs.push(msg),
      exit: vi.fn(),
      promptFn: vi.fn(),
      saveConfigFn: vi.fn(),
      deleteConfigFn: vi.fn(),
      getConfigFileFn: vi.fn(),
      NansenAPIClass: vi.fn(),
      isTTY: false
    });
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should return correct shape with all fields', async () => {
    const mockApi = {
      apiKey: 'test-key',
      request: vi.fn().mockResolvedValue({ data: [] })
    };

    const result = await commands.status([], mockApi, {}, {});

    expect(result).toHaveProperty('ready');
    expect(result).toHaveProperty('auth');
    expect(result).toHaveProperty('api');
    expect(result).toHaveProperty('wallet');
    expect(result).toHaveProperty('cli');

    // Auth fields
    expect(result.auth).toHaveProperty('configured');
    expect(result.auth).toHaveProperty('valid');
    expect(result.auth).toHaveProperty('error');
    expect(result.auth).toHaveProperty('code');

    // API fields
    expect(result.api).toHaveProperty('reachable');
    expect(result.api).toHaveProperty('latency_ms');
    expect(result.api).toHaveProperty('error');
    expect(result.api).toHaveProperty('code');

    // Wallet fields
    expect(result.wallet).toHaveProperty('count');
    expect(result.wallet).toHaveProperty('default');
    expect(result.wallet).toHaveProperty('names');

    // CLI fields
    expect(result.cli).toHaveProperty('version');
    expect(result.cli).toHaveProperty('update_available');
    expect(result.cli).toHaveProperty('latest_version');
  });

  it('should report auth configured and valid when API key works', async () => {
    const mockApi = {
      apiKey: 'valid-key',
      request: vi.fn().mockResolvedValue({ data: [] })
    };

    const result = await commands.status([], mockApi, {}, {});

    expect(result.ready).toBe(true);
    expect(result.auth.configured).toBe(true);
    expect(result.auth.valid).toBe(true);
    expect(result.auth.error).toBeNull();
    expect(result.auth.code).toBeNull();
    expect(result.api.reachable).toBe(true);
    expect(typeof result.api.latency_ms).toBe('number');
    expect(result.api.error).toBeNull();
    expect(result.api.code).toBeNull();
  });

  it('should report auth not configured when no API key', async () => {
    const mockApi = {
      apiKey: null,
      request: vi.fn()
    };

    const result = await commands.status([], mockApi, {}, {});

    expect(result.ready).toBe(false);
    expect(result.auth.configured).toBe(false);
    expect(result.auth.valid).toBe(false);
    expect(result.auth.error).toContain('No API key configured');
    expect(result.auth.code).toBe(ErrorCode.UNAUTHORIZED);
    expect(result.api.reachable).toBeNull();
    expect(result.api.code).toBeNull();
    expect(mockApi.request).not.toHaveBeenCalled();
  });

  it('should report API reachable but auth invalid on auth error', async () => {
    const mockApi = {
      apiKey: 'bad-key',
      request: vi.fn().mockRejectedValue(
        new NansenError('Invalid API key', ErrorCode.UNAUTHORIZED, 401)
      )
    };

    const result = await commands.status([], mockApi, {}, {});

    expect(result.ready).toBe(false);
    expect(result.auth.configured).toBe(true);
    expect(result.auth.valid).toBe(false);
    expect(result.auth.error).toContain('Invalid API key');
    expect(result.auth.code).toBe(ErrorCode.UNAUTHORIZED);
    expect(result.api.reachable).toBe(true);
    expect(result.api.code).toBeNull();
    expect(typeof result.api.latency_ms).toBe('number');
  });

  it('should report update_available false when cached version equals current', async () => {
    const mockApi = { apiKey: null, request: vi.fn() };
    // First call to get the current version
    const probe = await commands.status([], mockApi, {}, {});
    const currentVersion = probe.cli.version;

    // Write cache file with latest === current version
    const nansenDir = path.join(tempDir, '.nansen');
    fs.mkdirSync(nansenDir, { recursive: true });
    fs.writeFileSync(
      path.join(nansenDir, 'update-check.json'),
      JSON.stringify({ latest: currentVersion, checkedAt: Date.now() })
    );

    const result = await commands.status([], mockApi, {}, {});

    expect(result.cli.update_available).toBe(false);
    expect(result.cli.latest_version).toBe(currentVersion);
  });

  it('should handle malformed update-check.json gracefully', async () => {
    const nansenDir = path.join(tempDir, '.nansen');
    fs.mkdirSync(nansenDir, { recursive: true });
    fs.writeFileSync(path.join(nansenDir, 'update-check.json'), '{not valid json!!!');

    const mockApi = { apiKey: null, request: vi.fn() };
    const result = await commands.status([], mockApi, {}, {});

    expect(result.cli.update_available).toBe(false);
    expect(result.cli.latest_version).toBeNull();
  });

  it('should report API not reachable on network error', async () => {
    const mockApi = {
      apiKey: 'some-key',
      request: vi.fn().mockRejectedValue(
        new NansenError('Network error: fetch failed', ErrorCode.NETWORK_ERROR)
      )
    };

    const result = await commands.status([], mockApi, {}, {});

    expect(result.ready).toBe(false);
    expect(result.auth.configured).toBe(true);
    expect(result.auth.valid).toBe(false);
    expect(result.auth.error).toBeDefined();
    expect(result.api.reachable).toBe(false);
    expect(result.api.error).toContain('Network error');
    expect(result.api.code).toBe(ErrorCode.NETWORK_ERROR);
  });

  it('should report zero wallets when no wallet dir exists', async () => {
    const mockApi = { apiKey: null, request: vi.fn() };

    const result = await commands.status([], mockApi, {}, {});

    expect(result.wallet.count).toBe(0);
    expect(result.wallet.default).toBeNull();
    expect(result.wallet.names).toEqual([]);
  });

  it('should report wallets when they exist', async () => {
    // Set up wallet dir with test wallets
    const walletsDir = path.join(tempDir, '.nansen', 'wallets');
    fs.mkdirSync(walletsDir, { recursive: true });
    fs.writeFileSync(path.join(walletsDir, 'config.json'), JSON.stringify({ defaultWallet: 'main' }));
    fs.writeFileSync(path.join(walletsDir, 'main.json'), JSON.stringify({
      name: 'main', evm: { address: '0x123' }, solana: { address: 'abc' }, createdAt: '2024-01-01'
    }));
    fs.writeFileSync(path.join(walletsDir, 'burner.json'), JSON.stringify({
      name: 'burner', evm: { address: '0x456' }, solana: { address: 'def' }, createdAt: '2024-01-02'
    }));

    const mockApi = { apiKey: null, request: vi.fn() };
    const result = await commands.status([], mockApi, {}, {});

    expect(result.wallet.count).toBe(2);
    expect(result.wallet.default).toBe('main');
    expect(result.wallet.names).toContain('main');
    expect(result.wallet.names).toContain('burner');
  });

  it('should report CLI version', async () => {
    const mockApi = { apiKey: null, request: vi.fn() };
    const result = await commands.status([], mockApi, {}, {});

    expect(typeof result.cli.version).toBe('string');
    expect(result.cli.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('should detect update available from cache file', async () => {
    const nansenDir = path.join(tempDir, '.nansen');
    fs.mkdirSync(nansenDir, { recursive: true });
    fs.writeFileSync(
      path.join(nansenDir, 'update-check.json'),
      JSON.stringify({ latest: '99.99.99', checkedAt: Date.now() })
    );

    const mockApi = { apiKey: null, request: vi.fn() };
    const result = await commands.status([], mockApi, {}, {});

    expect(result.cli.update_available).toBe(true);
    expect(result.cli.latest_version).toBe('99.99.99');
  });

  it('should handle missing update cache gracefully', async () => {
    const mockApi = { apiKey: null, request: vi.fn() };
    const result = await commands.status([], mockApi, {}, {});

    expect(result.cli.update_available).toBe(false);
    expect(result.cli.latest_version).toBeNull();
  });

  it('should call API with retry disabled', async () => {
    const mockApi = {
      apiKey: 'test-key',
      request: vi.fn().mockResolvedValue({ data: [] })
    };

    await commands.status([], mockApi, {}, {});

    expect(mockApi.request).toHaveBeenCalledWith(
      '/api/v1/smart-money/netflow',
      { chains: ['ethereum'], pagination: { page: 1, per_page: 1 } },
      expect.objectContaining({ retry: false, skipX402: true, signal: expect.any(AbortSignal) })
    );
  });

  it('should pass AbortSignal to api.request()', async () => {
    let capturedOptions;
    const mockApi = {
      apiKey: 'test-key',
      request: vi.fn().mockImplementation((_endpoint, _body, opts) => {
        capturedOptions = opts;
        return Promise.resolve({ data: [] });
      })
    };

    await commands.status([], mockApi, {}, {});

    expect(capturedOptions).toBeDefined();
    expect(capturedOptions.signal).toBeInstanceOf(AbortSignal);
  });

  it('should treat empty-string API key as not configured', async () => {
    const mockApi = {
      apiKey: '',
      request: vi.fn()
    };

    const result = await commands.status([], mockApi, {}, {});

    expect(result.auth.configured).toBe(false);
    expect(result.auth.valid).toBe(false);
    expect(result.auth.code).toBe(ErrorCode.UNAUTHORIZED);
    expect(result.api.reachable).toBeNull();
    expect(mockApi.request).not.toHaveBeenCalled();
  });

  it('should handle health check timeout', async () => {
    const mockApi = {
      apiKey: 'test-key',
      request: vi.fn().mockImplementation(() => new Promise(() => {})) // never resolves
    };

    // Use fake timers to avoid waiting 5 real seconds
    vi.useFakeTimers();
    const statusPromise = commands.status([], mockApi, {}, {});
    await vi.advanceTimersByTimeAsync(5000);
    const result = await statusPromise;
    vi.useRealTimers();

    expect(result.ready).toBe(false);
    expect(result.auth.configured).toBe(true);
    expect(result.auth.valid).toBe(false);
    expect(result.auth.error).toContain('timed out');
    expect(result.api.reachable).toBe(false);
    expect(result.api.error).toContain('timed out');
    expect(result.api.code).toBe(ErrorCode.TIMEOUT);
  });

  it('should include error field when listWallets throws', async () => {
    // Create a corrupt wallet file to trigger a parse error
    const walletsDir = path.join(tempDir, '.nansen', 'wallets');
    fs.mkdirSync(walletsDir, { recursive: true });
    fs.writeFileSync(path.join(walletsDir, 'config.json'), JSON.stringify({}));
    fs.writeFileSync(path.join(walletsDir, 'corrupt.json'), 'NOT VALID JSON{{{');

    const mockApi = { apiKey: null, request: vi.fn() };
    const result = await commands.status([], mockApi, {}, {});

    expect(result.wallet.count).toBe(0);
    expect(result.wallet.default).toBeNull();
    expect(result.wallet.names).toEqual([]);
    expect(result.wallet.error).toBeDefined();
    expect(typeof result.wallet.error).toBe('string');
  });
});

describe('status command via runCLI', () => {
  it('should wrap result in success envelope', async () => {
    const outputs = [];
    const result = await runCLI(['status'], {
      output: (msg) => outputs.push(msg),
      errorOutput: () => {},
      exit: vi.fn(),
      NansenAPIClass: function MockAPI() {
        this.apiKey = 'test-key';
        this.request = vi.fn().mockResolvedValue({ data: [] });
      }
    });

    expect(result.type).toBe('success');
    const parsed = JSON.parse(outputs[0]);
    expect(parsed.success).toBe(true);
    expect(parsed.data).toHaveProperty('ready');
    expect(parsed.data).toHaveProperty('auth');
    expect(parsed.data).toHaveProperty('api');
    expect(parsed.data).toHaveProperty('wallet');
    expect(parsed.data).toHaveProperty('cli');
  });

  it('should respect --pretty flag', async () => {
    const outputs = [];
    await runCLI(['status', '--pretty'], {
      output: (msg) => outputs.push(msg),
      errorOutput: () => {},
      exit: vi.fn(),
      NansenAPIClass: function MockAPI() {
        this.apiKey = null;
        this.request = vi.fn();
      }
    });

    // Pretty output has indentation
    expect(outputs[0]).toContain('\n');
    const parsed = JSON.parse(outputs[0]);
    expect(parsed.success).toBe(true);
  });

  it('should respect --fields flag', async () => {
    const outputs = [];
    await runCLI(['status', '--fields', 'auth,cli'], {
      output: (msg) => outputs.push(msg),
      errorOutput: () => {},
      exit: vi.fn(),
      NansenAPIClass: function MockAPI() {
        this.apiKey = null;
        this.request = vi.fn();
      }
    });

    const parsed = JSON.parse(outputs[0]);
    expect(parsed.success).toBe(true);
    expect(parsed.data).toHaveProperty('auth');
    expect(parsed.data).toHaveProperty('cli');
    expect(parsed.data.ready).toBeUndefined();
    expect(parsed.data.api).toBeUndefined();
    expect(parsed.data.wallet).toBeUndefined();
  });
});
