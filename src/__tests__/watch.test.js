/**
 * Watch Command Tests
 * Tests for the nansen watch command: polling, NDJSON output, retries,
 * state persistence, interval clamping, heartbeats, timeouts, shutdown.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runWatch, clampInterval, loadWatchState, saveWatchState, buildWatchCommand } from '../watch.js';
import { runCLI } from '../cli.js';
import fs from 'fs';
import path from 'path';
import { getConfigDir } from '../api.js';

const STATE_DIR = path.join(getConfigDir(), 'watch-state');
const STATE_FILE = path.join(STATE_DIR, 'watch-state.json');

// Helper: collect NDJSON output lines as parsed objects
function createOutputCollector() {
  const lines = [];
  const output = (line) => lines.push(JSON.parse(line));
  return { lines, output };
}

// Helper: create a mock API
function createMockApi(responses = []) {
  let callCount = 0;
  return {
    addressTransactions: vi.fn(async () => {
      const resp = responses[callCount] || responses[responses.length - 1] || { data: [] };
      callCount++;
      if (resp instanceof Error) throw resp;
      return resp;
    }),
    tokenDexTrades: vi.fn(async () => {
      const resp = responses[callCount] || responses[responses.length - 1] || { data: [] };
      callCount++;
      if (resp instanceof Error) throw resp;
      return resp;
    })
  };
}

describe('clampInterval', () => {
  it('should return interval unchanged when within bounds', () => {
    const { interval, warning } = clampInterval(30, null);
    expect(interval).toBe(30);
    expect(warning).toBeNull();
  });

  it('should clamp interval below minimum to 10', () => {
    const warns = [];
    const { interval, warning } = clampInterval(5, (msg) => warns.push(msg));
    expect(interval).toBe(10);
    expect(warning).toContain('below minimum');
    expect(warns).toHaveLength(1);
  });

  it('should clamp interval above maximum to 3600', () => {
    const warns = [];
    const { interval, warning } = clampInterval(5000, (msg) => warns.push(msg));
    expect(interval).toBe(3600);
    expect(warning).toContain('above maximum');
  });

  it('should handle exact boundaries', () => {
    expect(clampInterval(10, null).interval).toBe(10);
    expect(clampInterval(3600, null).interval).toBe(3600);
  });
});

describe('State Persistence', () => {
  beforeEach(() => {
    // Clean up state file
    try { fs.unlinkSync(STATE_FILE); } catch {}
  });

  afterEach(() => {
    try { fs.unlinkSync(STATE_FILE); } catch {}
  });

  it('should return empty object when no state file exists', () => {
    const state = loadWatchState();
    expect(state).toEqual({});
  });

  it('should save and load state', () => {
    const state = { 'wallet:ethereum:0x123': { seenKeys: ['tx1', 'tx2'], lastPoll: '2025-01-01T00:00:00Z' } };
    saveWatchState(state);
    const loaded = loadWatchState();
    expect(loaded).toEqual(state);
  });

  it('should handle corrupted state file gracefully', () => {
    if (!fs.existsSync(STATE_DIR)) {
      fs.mkdirSync(STATE_DIR, { recursive: true });
    }
    fs.writeFileSync(STATE_FILE, 'not json');
    const state = loadWatchState();
    expect(state).toEqual({});
  });
});

describe('runWatch - wallet', () => {
  beforeEach(() => {
    try { fs.unlinkSync(STATE_FILE); } catch {}
  });
  afterEach(() => {
    try { fs.unlinkSync(STATE_FILE); } catch {}
  });

  it('should emit started event and stop with --once', async () => {
    const { lines, output } = createOutputCollector();
    const api = createMockApi([{ data: [] }]);

    await runWatch({
      watchType: 'wallet',
      address: '0x' + 'a'.repeat(40),
      chain: 'ethereum',
      interval: 30,
      once: true,
      api,
      output,
      errorOutput: () => {},
    });

    expect(lines.length).toBeGreaterThanOrEqual(2); // started + stopped
    expect(lines[0].type).toBe('started');
    expect(lines[0].watchType).toBe('wallet');
    expect(lines[0].chain).toBe('ethereum');
    expect(lines[0].interval).toBe(30);
    expect(lines[lines.length - 1].type).toBe('stopped');
    expect(lines[lines.length - 1].reason).toBe('once');
  });

  it('should emit wallet_activity events for new records', async () => {
    const { lines, output } = createOutputCollector();
    const api = createMockApi([{
      data: [
        { transaction_hash: 'tx1', value_usd: 100 },
        { transaction_hash: 'tx2', value_usd: 200 }
      ]
    }]);

    await runWatch({
      watchType: 'wallet',
      address: '0x' + 'b'.repeat(40),
      chain: 'ethereum',
      interval: 30,
      once: true,
      api,
      output,
      errorOutput: () => {},
    });

    const dataEvents = lines.filter(l => l.type === 'wallet_activity');
    expect(dataEvents).toHaveLength(2);
    expect(dataEvents[0].data.transaction_hash).toBe('tx1');
    expect(dataEvents[1].data.transaction_hash).toBe('tx2');
    expect(dataEvents[0].address).toBe('0x' + 'b'.repeat(40));
    expect(dataEvents[0].chain).toBe('ethereum');
  });

  it('should deduplicate records using state persistence across runs', async () => {
    const address = '0x' + 'c'.repeat(40);

    // First run: see tx1
    const { lines: lines1, output: output1 } = createOutputCollector();
    await runWatch({
      watchType: 'wallet',
      address,
      chain: 'ethereum',
      once: true,
      api: createMockApi([{ data: [{ transaction_hash: 'tx1', value_usd: 100 }] }]),
      output: output1,
      errorOutput: () => {},
    });

    const run1Data = lines1.filter(l => l.type === 'wallet_activity');
    expect(run1Data).toHaveLength(1);
    expect(run1Data[0].data.transaction_hash).toBe('tx1');

    // Second run: tx1 already seen (via state persistence), only tx3 is new
    const { lines: lines2, output: output2 } = createOutputCollector();
    await runWatch({
      watchType: 'wallet',
      address,
      chain: 'ethereum',
      once: true,
      api: createMockApi([{ data: [
        { transaction_hash: 'tx1', value_usd: 100 },
        { transaction_hash: 'tx3', value_usd: 300 }
      ] }]),
      output: output2,
      errorOutput: () => {},
    });

    const run2Data = lines2.filter(l => l.type === 'wallet_activity');
    expect(run2Data).toHaveLength(1);
    expect(run2Data[0].data.transaction_hash).toBe('tx3');
  });

  it('should emit heartbeat events between polls', async () => {
    const { lines, output } = createOutputCollector();
    let pollCount = 0;
    let signalHandler = null;

    const api = {
      addressTransactions: vi.fn(async () => {
        pollCount++;
        if (pollCount >= 2) signalHandler();
        return { data: [] };
      })
    };

    await runWatch({
      watchType: 'wallet',
      address: '0x' + 'd'.repeat(40),
      chain: 'ethereum',
      interval: 10,
      api,
      output,
      errorOutput: () => {},
      onSignal: (handler) => { signalHandler = handler; }
    });

    const heartbeats = lines.filter(l => l.type === 'heartbeat');
    expect(heartbeats.length).toBeGreaterThanOrEqual(1);
    expect(heartbeats[0].nextPollIn).toBe(10);
  });

  it('should emit error event on missing address', async () => {
    const { lines, output } = createOutputCollector();

    const result = await runWatch({
      watchType: 'wallet',
      address: '',
      chain: 'ethereum',
      api: createMockApi(),
      output,
      errorOutput: () => {},
    });

    expect(result.exitCode).toBe(1);
    const errors = lines.filter(l => l.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].fatal).toBe(true);
  });

  it('should emit error event on invalid address', async () => {
    const { lines, output } = createOutputCollector();

    const result = await runWatch({
      watchType: 'wallet',
      address: 'not-an-address',
      chain: 'ethereum',
      api: createMockApi(),
      output,
      errorOutput: () => {},
    });

    expect(result.exitCode).toBe(1);
    const errors = lines.filter(l => l.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].fatal).toBe(true);
    expect(errors[0].error).toContain('Invalid EVM address');
  });

  it('should emit error event on unknown watch type', async () => {
    const { lines, output } = createOutputCollector();

    const result = await runWatch({
      watchType: 'something',
      address: '0x' + 'a'.repeat(40),
      chain: 'ethereum',
      api: createMockApi(),
      output,
      errorOutput: () => {},
    });

    expect(result.exitCode).toBe(1);
    const errors = lines.filter(l => l.type === 'error');
    expect(errors[0].error).toContain('Unknown watch type');
  });
});

describe('runWatch - token', () => {
  beforeEach(() => {
    try { fs.unlinkSync(STATE_FILE); } catch {}
  });
  afterEach(() => {
    try { fs.unlinkSync(STATE_FILE); } catch {}
  });

  it('should poll tokenDexTrades for token watch type', async () => {
    const { lines, output } = createOutputCollector();
    const api = createMockApi([{
      data: [
        { tx_hash: 'dex1', value_usd: 500 }
      ]
    }]);

    await runWatch({
      watchType: 'token',
      address: 'So11111111111111111111111111111111111111112',
      chain: 'solana',
      interval: 30,
      once: true,
      api,
      output,
      errorOutput: () => {},
    });

    expect(api.tokenDexTrades).toHaveBeenCalled();
    const dataEvents = lines.filter(l => l.type === 'token_activity');
    expect(dataEvents).toHaveLength(1);
    expect(dataEvents[0].data.tx_hash).toBe('dex1');
  });
});

describe('runWatch - retries', () => {
  beforeEach(() => {
    try { fs.unlinkSync(STATE_FILE); } catch {}
  });
  afterEach(() => {
    try { fs.unlinkSync(STATE_FILE); } catch {}
  });

  it('should retry on API failure and emit error after exhausting retries', async () => {
    const { lines, output } = createOutputCollector();

    const api = {
      addressTransactions: vi.fn(async () => {
        throw new Error('API timeout');
      })
    };

    await runWatch({
      watchType: 'wallet',
      address: '0x' + 'e'.repeat(40),
      chain: 'ethereum',
      once: true,
      api,
      output,
      errorOutput: () => {},
    });

    // Should have been called 3 times (retry attempts)
    expect(api.addressTransactions).toHaveBeenCalledTimes(3);

    const errors = lines.filter(l => l.type === 'error' && l.error.includes('API call failed'));
    expect(errors).toHaveLength(1);
    expect(errors[0].fatal).toBe(false);
    expect(errors[0].error).toContain('3 retries');
  });
});

describe('runWatch - timeout', () => {
  beforeEach(() => {
    try { fs.unlinkSync(STATE_FILE); } catch {}
  });
  afterEach(() => {
    try { fs.unlinkSync(STATE_FILE); } catch {}
  });

  it('should stop after timeout seconds', async () => {
    const { lines, output } = createOutputCollector();
    const api = createMockApi([{ data: [] }]);

    const start = Date.now();
    await runWatch({
      watchType: 'wallet',
      address: '0x' + 'f'.repeat(40),
      chain: 'ethereum',
      interval: 10,
      timeout: 2, // 2 seconds
      api,
      output,
      errorOutput: () => {},
    });
    const elapsed = Date.now() - start;

    const stopped = lines.filter(l => l.type === 'stopped');
    expect(stopped).toHaveLength(1);
    expect(stopped[0].reason).toBe('timeout');
    expect(elapsed).toBeLessThan(10000); // should stop well before 10s
  });
});

describe('runWatch - interval clamping', () => {
  beforeEach(() => {
    try { fs.unlinkSync(STATE_FILE); } catch {}
  });
  afterEach(() => {
    try { fs.unlinkSync(STATE_FILE); } catch {}
  });

  it('should clamp interval below minimum and emit warning', async () => {
    const { lines, output } = createOutputCollector();
    const api = createMockApi([{ data: [] }]);
    const warnings = [];

    await runWatch({
      watchType: 'wallet',
      address: '0x' + 'a'.repeat(40),
      chain: 'ethereum',
      interval: 3, // below minimum
      once: true,
      api,
      output,
      errorOutput: (msg) => warnings.push(msg),
    });

    // Should have emitted an error event about clamping
    const clampErrors = lines.filter(l => l.type === 'error' && l.error.includes('Clamped'));
    expect(clampErrors).toHaveLength(1);

    // Started event should show clamped interval
    const started = lines.find(l => l.type === 'started');
    expect(started.interval).toBe(10);
  });
});

describe('runWatch - state persistence', () => {
  beforeEach(() => {
    try { fs.unlinkSync(STATE_FILE); } catch {}
  });
  afterEach(() => {
    try { fs.unlinkSync(STATE_FILE); } catch {}
  });

  it('should persist seen keys and skip them on restart', async () => {
    const address = '0x' + 'a'.repeat(40);

    // First run - see tx1
    const { lines: lines1, output: output1 } = createOutputCollector();
    await runWatch({
      watchType: 'wallet',
      address,
      chain: 'ethereum',
      once: true,
      api: createMockApi([{ data: [{ transaction_hash: 'tx1', value_usd: 100 }] }]),
      output: output1,
      errorOutput: () => {},
    });

    const firstRunData = lines1.filter(l => l.type === 'wallet_activity');
    expect(firstRunData).toHaveLength(1);

    // Second run - same tx1 should be skipped, tx2 should be new
    const { lines: lines2, output: output2 } = createOutputCollector();
    await runWatch({
      watchType: 'wallet',
      address,
      chain: 'ethereum',
      once: true,
      api: createMockApi([{ data: [{ transaction_hash: 'tx1', value_usd: 100 }, { transaction_hash: 'tx2', value_usd: 200 }] }]),
      output: output2,
      errorOutput: () => {},
    });

    const secondRunData = lines2.filter(l => l.type === 'wallet_activity');
    expect(secondRunData).toHaveLength(1);
    expect(secondRunData[0].data.transaction_hash).toBe('tx2');
  });
});

describe('runWatch - graceful shutdown', () => {
  beforeEach(() => {
    try { fs.unlinkSync(STATE_FILE); } catch {}
  });
  afterEach(() => {
    try { fs.unlinkSync(STATE_FILE); } catch {}
  });

  it('should emit stopped event on signal', async () => {
    const { lines, output } = createOutputCollector();
    let signalHandler = null;
    let pollCount = 0;

    const api = {
      addressTransactions: vi.fn(async () => {
        pollCount++;
        if (pollCount >= 1) signalHandler();
        return { data: [] };
      })
    };

    await runWatch({
      watchType: 'wallet',
      address: '0x' + 'a'.repeat(40),
      chain: 'ethereum',
      interval: 10,
      api,
      output,
      errorOutput: () => {},
      onSignal: (handler) => { signalHandler = handler; }
    });

    const stopped = lines.filter(l => l.type === 'stopped');
    expect(stopped).toHaveLength(1);
    expect(stopped[0].reason).toBe('signal');
  });
});

describe('runWatch - various response shapes', () => {
  beforeEach(() => {
    try { fs.unlinkSync(STATE_FILE); } catch {}
  });
  afterEach(() => {
    try { fs.unlinkSync(STATE_FILE); } catch {}
  });

  it('should handle nested results shape', async () => {
    const { lines, output } = createOutputCollector();
    const api = createMockApi([{
      data: {
        results: [
          { transaction_hash: 'nested1', value_usd: 50 }
        ]
      }
    }]);

    await runWatch({
      watchType: 'wallet',
      address: '0x' + 'a'.repeat(40),
      chain: 'ethereum',
      once: true,
      api,
      output,
      errorOutput: () => {},
    });

    const data = lines.filter(l => l.type === 'wallet_activity');
    expect(data).toHaveLength(1);
    expect(data[0].data.transaction_hash).toBe('nested1');
  });

  it('should handle array response shape', async () => {
    const { lines, output } = createOutputCollector();
    const api = createMockApi([[
      { transaction_hash: 'arr1', value_usd: 10 }
    ]]);

    await runWatch({
      watchType: 'wallet',
      address: '0x' + 'a'.repeat(40),
      chain: 'ethereum',
      once: true,
      api,
      output,
      errorOutput: () => {},
    });

    const data = lines.filter(l => l.type === 'wallet_activity');
    expect(data).toHaveLength(1);
  });
});

describe('buildWatchCommand', () => {
  it('should output help when no subcommand given', async () => {
    const outputLines = [];
    const cmd = buildWatchCommand({ output: (l) => outputLines.push(l) });
    await cmd([], null, {}, {});

    const help = JSON.parse(outputLines[0]);
    expect(help.command).toBe('watch');
    expect(help.subcommands.wallet).toBeDefined();
    expect(help.subcommands.token).toBeDefined();
  });

  it('should output help for "help" subcommand', async () => {
    const outputLines = [];
    const cmd = buildWatchCommand({ output: (l) => outputLines.push(l) });
    await cmd(['help'], null, {}, {});

    const help = JSON.parse(outputLines[0]);
    expect(help.command).toBe('watch');
  });
});

describe('runCLI watch integration', () => {
  it('should route watch command and emit NDJSON', async () => {
    const outputLines = [];
    const mockApi = createMockApi([{ data: [{ transaction_hash: 'cli_tx1' }] }]);

    const result = await runCLI(
      ['watch', 'wallet', '--address', '0x' + 'a'.repeat(40), '--chain', 'ethereum', '--once'],
      {
        output: (line) => outputLines.push(line),
        errorOutput: () => {},
        exit: () => {},
        NansenAPIClass: class {
          constructor() { return mockApi; }
        }
      }
    );

    expect(result.type).toBe('watch');
    // Should have NDJSON lines
    const parsed = outputLines.map(l => JSON.parse(l));
    expect(parsed.some(e => e.type === 'started')).toBe(true);
    expect(parsed.some(e => e.type === 'stopped')).toBe(true);
  });

  it('should handle watch help', async () => {
    const outputLines = [];

    await runCLI(
      ['watch'],
      {
        output: (line) => outputLines.push(line),
        errorOutput: () => {},
        exit: () => {},
        NansenAPIClass: class {
          constructor() { return createMockApi(); }
        }
      }
    );

    const help = JSON.parse(outputLines[0]);
    expect(help.command).toBe('watch');
  });
});
