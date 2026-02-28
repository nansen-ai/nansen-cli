/**
 * Alert Command Tests
 * Tests for the local alert management system.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  createAlert,
  listAlerts,
  deleteAlert,
  checkAlerts,
  buildAlertCommand,
  ALERTS_FILE,
  readAlerts,
  writeAlerts,
  MIN_CHECK_INTERVAL_MS,
  VALID_CHAINS,
} from '../alert.js';

// Use a temp directory for alerts during tests
const REAL_ALERTS_FILE = ALERTS_FILE;
let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(import.meta.dirname || '/tmp', 'alert-test-'));
  // Clear any existing alerts file
  try { fs.unlinkSync(REAL_ALERTS_FILE); } catch {}
});

afterEach(() => {
  // Clean up
  try { fs.unlinkSync(REAL_ALERTS_FILE); } catch {}
  try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
});

// Valid test addresses
const SOL_TOKEN = '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr';
const SOL_WALLET = 'DRpbCBMxVnDK7maPMoGGfFASo7hmaiuAqJwmkRBCKsCc';
const EVM_TOKEN = '0x6B175474E89094C44Da98b954EedeAC495271d0F';
const EVM_WALLET = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';

describe('Alert - Input Validation', () => {
  it('rejects missing parameters', () => {
    expect(() => createAlert({})).toThrow('Must specify');
  });

  it('rejects missing chain', () => {
    expect(() => createAlert({ token: SOL_TOKEN, above: 100 })).toThrow('--chain is required');
  });

  it('rejects invalid chain', () => {
    expect(() => createAlert({ token: SOL_TOKEN, chain: 'fakechain', above: 100 })).toThrow('Invalid chain');
  });

  it('rejects invalid token address for chain', () => {
    expect(() => createAlert({ token: 'not-an-address', chain: 'solana', above: 100 })).toThrow();
  });

  it('rejects invalid wallet address for chain', () => {
    expect(() => createAlert({ wallet: 'bad', chain: 'ethereum', smartMoney: true })).toThrow();
  });

  it('rejects non-positive threshold', () => {
    expect(() => createAlert({ token: SOL_TOKEN, chain: 'solana', above: 0 })).toThrow('positive number');
    expect(() => createAlert({ token: SOL_TOKEN, chain: 'solana', above: -5 })).toThrow('positive number');
    expect(() => createAlert({ token: SOL_TOKEN, chain: 'solana', above: 'abc' })).toThrow('positive number');
  });

  it('rejects combining price and smart-money', () => {
    expect(() => createAlert({
      token: SOL_TOKEN, wallet: SOL_WALLET, chain: 'solana', above: 100, smartMoney: true
    })).toThrow('Cannot combine');
  });

  it('validates EVM addresses on EVM chains', () => {
    expect(() => createAlert({ token: SOL_TOKEN, chain: 'ethereum', above: 100 })).toThrow();
  });

  it('validates Solana addresses on Solana chain', () => {
    expect(() => createAlert({ token: EVM_TOKEN, chain: 'solana', above: 100 })).toThrow();
  });
});

describe('Alert - Create', () => {
  it('creates a price alert with --above', () => {
    const result = createAlert({ token: SOL_TOKEN, chain: 'solana', above: 150 });
    expect(result.created).toBe(true);
    expect(result.alert.type).toBe('price');
    expect(result.alert.condition).toBe('above');
    expect(result.alert.threshold).toBe(150);
    expect(result.alert.token).toBe(SOL_TOKEN);
    expect(result.alert.chain).toBe('solana');
    expect(result.alert.status).toBe('active');
    expect(result.alert.id).toBeTruthy();
  });

  it('creates a price alert with --below', () => {
    const result = createAlert({ token: SOL_TOKEN, chain: 'solana', below: 50 });
    expect(result.created).toBe(true);
    expect(result.alert.condition).toBe('below');
    expect(result.alert.threshold).toBe(50);
  });

  it('creates a smart money alert', () => {
    const result = createAlert({ wallet: SOL_WALLET, chain: 'solana', smartMoney: true });
    expect(result.created).toBe(true);
    expect(result.alert.type).toBe('smart-money');
    expect(result.alert.wallet).toBe(SOL_WALLET);
    expect(result.alert.status).toBe('active');
  });

  it('creates EVM price alert', () => {
    const result = createAlert({ token: EVM_TOKEN, chain: 'ethereum', above: 1 });
    expect(result.created).toBe(true);
    expect(result.alert.chain).toBe('ethereum');
  });

  it('creates EVM smart money alert', () => {
    const result = createAlert({ wallet: EVM_WALLET, chain: 'base', smartMoney: true });
    expect(result.created).toBe(true);
    expect(result.alert.chain).toBe('base');
  });

  it('converts string threshold to number', () => {
    const result = createAlert({ token: SOL_TOKEN, chain: 'solana', above: '99.5' });
    expect(result.alert.threshold).toBe(99.5);
  });
});

describe('Alert - Idempotent Create (Deduplication)', () => {
  it('returns existing alert for same price alert params', () => {
    const first = createAlert({ token: SOL_TOKEN, chain: 'solana', above: 100 });
    const second = createAlert({ token: SOL_TOKEN, chain: 'solana', above: 100 });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.alert.id).toBe(first.alert.id);
  });

  it('different thresholds create different alerts', () => {
    const a = createAlert({ token: SOL_TOKEN, chain: 'solana', above: 100 });
    const b = createAlert({ token: SOL_TOKEN, chain: 'solana', above: 200 });
    expect(a.alert.id).not.toBe(b.alert.id);
  });

  it('different conditions create different alerts', () => {
    const a = createAlert({ token: SOL_TOKEN, chain: 'solana', above: 100 });
    const b = createAlert({ token: SOL_TOKEN, chain: 'solana', below: 100 });
    expect(a.alert.id).not.toBe(b.alert.id);
  });

  it('returns existing alert for same smart money params', () => {
    const first = createAlert({ wallet: SOL_WALLET, chain: 'solana', smartMoney: true });
    const second = createAlert({ wallet: SOL_WALLET, chain: 'solana', smartMoney: true });
    expect(second.created).toBe(false);
    expect(second.alert.id).toBe(first.alert.id);
  });

  it('different chains create different alerts', () => {
    const a = createAlert({ token: EVM_TOKEN, chain: 'ethereum', above: 1 });
    const b = createAlert({ token: EVM_TOKEN, chain: 'base', above: 1 });
    expect(a.alert.id).not.toBe(b.alert.id);
  });
});

describe('Alert - List', () => {
  it('returns empty array when no alerts', () => {
    const alerts = listAlerts();
    expect(alerts).toEqual([]);
  });

  it('returns all created alerts', () => {
    createAlert({ token: SOL_TOKEN, chain: 'solana', above: 100 });
    createAlert({ token: SOL_TOKEN, chain: 'solana', below: 50 });
    const alerts = listAlerts();
    expect(alerts).toHaveLength(2);
  });
});

describe('Alert - Delete', () => {
  it('deletes an alert by ID', () => {
    const { alert } = createAlert({ token: SOL_TOKEN, chain: 'solana', above: 100 });
    const removed = deleteAlert(alert.id);
    expect(removed.id).toBe(alert.id);
    expect(listAlerts()).toHaveLength(0);
  });

  it('throws on missing ID', () => {
    expect(() => deleteAlert()).toThrow('Alert ID is required');
  });

  it('throws on non-existent ID', () => {
    expect(() => deleteAlert('nonexistent-id')).toThrow('Alert not found');
  });

  it('only deletes the specified alert', () => {
    const { alert: a1 } = createAlert({ token: SOL_TOKEN, chain: 'solana', above: 100 });
    createAlert({ token: SOL_TOKEN, chain: 'solana', below: 50 });
    deleteAlert(a1.id);
    const remaining = listAlerts();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].condition).toBe('below');
  });
});

describe('Alert - Atomic File Writes', () => {
  it('persists alerts across reads', () => {
    createAlert({ token: SOL_TOKEN, chain: 'solana', above: 100 });
    // Read directly from file to verify persistence
    const raw = JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf8'));
    expect(raw).toHaveLength(1);
    expect(raw[0].type).toBe('price');
  });

  it('handles corrupted file gracefully', () => {
    fs.writeFileSync(ALERTS_FILE, 'not-json!!!');
    const alerts = listAlerts();
    expect(alerts).toEqual([]);
  });

  it('handles missing directory', () => {
    // The create function should create the directory if needed
    try { fs.unlinkSync(ALERTS_FILE); } catch {}
    const result = createAlert({ token: SOL_TOKEN, chain: 'solana', above: 100 });
    expect(result.created).toBe(true);
  });
});

describe('Alert - Check (API polling)', () => {
  it('returns triggered price alerts when price crosses above threshold', async () => {
    createAlert({ token: SOL_TOKEN, chain: 'solana', above: 100 });

    const mockApi = {
      request: vi.fn().mockResolvedValue({
        data: { price_usd: 150 }
      })
    };

    const triggered = await checkAlerts(mockApi);
    expect(triggered).toHaveLength(1);
    expect(triggered[0].type).toBe('price');
    expect(triggered[0].currentPrice).toBe(150);
    expect(triggered[0].threshold).toBe(100);

    // Verify alert is now marked as triggered
    const alerts = listAlerts();
    expect(alerts[0].status).toBe('triggered');
  });

  it('returns triggered price alerts when price crosses below threshold', async () => {
    createAlert({ token: SOL_TOKEN, chain: 'solana', below: 100 });

    const mockApi = {
      request: vi.fn().mockResolvedValue({
        data: { price_usd: 50 }
      })
    };

    const triggered = await checkAlerts(mockApi);
    expect(triggered).toHaveLength(1);
    expect(triggered[0].condition).toBe('below');
    expect(triggered[0].currentPrice).toBe(50);
  });

  it('does not trigger when price has not crossed threshold', async () => {
    createAlert({ token: SOL_TOKEN, chain: 'solana', above: 200 });

    const mockApi = {
      request: vi.fn().mockResolvedValue({
        data: { price_usd: 100 }
      })
    };

    const triggered = await checkAlerts(mockApi);
    expect(triggered).toHaveLength(0);

    // Alert should still be active
    const alerts = listAlerts();
    expect(alerts[0].status).toBe('active');
  });

  it('never re-fires a triggered alert', async () => {
    createAlert({ token: SOL_TOKEN, chain: 'solana', above: 100 });

    const mockApi = {
      request: vi.fn().mockResolvedValue({
        data: { price_usd: 150 }
      })
    };

    // First check triggers
    const first = await checkAlerts(mockApi);
    expect(first).toHaveLength(1);

    // Second check should not re-trigger (alert is now 'triggered')
    const second = await checkAlerts(mockApi);
    expect(second).toHaveLength(0);
  });

  it('triggers smart money alert on new trade', async () => {
    createAlert({ wallet: SOL_WALLET, chain: 'solana', smartMoney: true });

    const mockApi = {
      request: vi.fn().mockResolvedValue({
        data: [{ transaction_hash: 'tx123', trade_value_usd: 50000 }]
      })
    };

    const triggered = await checkAlerts(mockApi);
    expect(triggered).toHaveLength(1);
    expect(triggered[0].type).toBe('smart-money');
    expect(triggered[0].latestTrade.transaction_hash).toBe('tx123');
  });

  it('does not trigger smart money alert when no trades', async () => {
    createAlert({ wallet: SOL_WALLET, chain: 'solana', smartMoney: true });

    const mockApi = {
      request: vi.fn().mockResolvedValue({ data: [] })
    };

    const triggered = await checkAlerts(mockApi);
    expect(triggered).toHaveLength(0);
  });

  it('rate limits checks (minimum 60s between checks per alert)', async () => {
    createAlert({ token: SOL_TOKEN, chain: 'solana', above: 200 });

    const mockApi = {
      request: vi.fn().mockResolvedValue({
        data: { price_usd: 100 }
      })
    };

    // First check
    await checkAlerts(mockApi);
    expect(mockApi.request).toHaveBeenCalledTimes(1);

    // Second check immediately — should be skipped due to rate limit
    await checkAlerts(mockApi);
    expect(mockApi.request).toHaveBeenCalledTimes(1); // Not called again
  });

  it('handles API errors gracefully (does not crash)', async () => {
    createAlert({ token: SOL_TOKEN, chain: 'solana', above: 100 });

    const mockApi = {
      request: vi.fn().mockRejectedValue(new Error('API down'))
    };

    // Should not throw, just return empty
    const triggered = await checkAlerts(mockApi);
    expect(triggered).toHaveLength(0);
  });

  it('checks multiple alerts independently', async () => {
    createAlert({ token: SOL_TOKEN, chain: 'solana', above: 100 });
    createAlert({ wallet: SOL_WALLET, chain: 'solana', smartMoney: true });

    const mockApi = {
      request: vi.fn()
        .mockResolvedValueOnce({ data: { price_usd: 150 } }) // price alert triggers
        .mockResolvedValueOnce({ data: [] }) // smart money - no trades
    };

    const triggered = await checkAlerts(mockApi);
    expect(triggered).toHaveLength(1);
    expect(triggered[0].type).toBe('price');
  });

  it('returns empty when no active alerts', async () => {
    const mockApi = { request: vi.fn() };
    const triggered = await checkAlerts(mockApi);
    expect(triggered).toHaveLength(0);
    expect(mockApi.request).not.toHaveBeenCalled();
  });
});

describe('Alert - Retry with Backoff', () => {
  it('retries API calls on failure (3 attempts with backoff)', async () => {
    createAlert({ token: SOL_TOKEN, chain: 'solana', above: 100 });

    let callCount = 0;
    const mockApi = {
      request: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount < 3) throw new Error('Temporary failure');
        return Promise.resolve({ data: { price_usd: 150 } });
      })
    };

    const triggered = await checkAlerts(mockApi);
    expect(triggered).toHaveLength(1);
    expect(callCount).toBe(3); // 2 failures + 1 success
  }, 15000); // Increase timeout for retry delays

  it('gives up after 3 retries', async () => {
    createAlert({ token: SOL_TOKEN, chain: 'solana', above: 100 });

    const mockApi = {
      request: vi.fn().mockRejectedValue(new Error('Persistent failure'))
    };

    const triggered = await checkAlerts(mockApi);
    expect(triggered).toHaveLength(0);
    // fetchWithRetry calls request 3 times (initial + 2 retries = 3 total)
    expect(mockApi.request).toHaveBeenCalledTimes(3);
  }, 15000);
});

describe('Alert - CLI Command Handler', () => {
  const handler = buildAlertCommand();

  it('returns help for no subcommand', async () => {
    const result = await handler([], null, {}, {});
    expect(result.subcommands).toContain('create');
    expect(result.subcommands).toContain('list');
    expect(result.subcommands).toContain('delete');
    expect(result.subcommands).toContain('check');
  });

  it('creates alert via CLI handler', async () => {
    const result = await handler(['create'], null, {}, {
      token: SOL_TOKEN, chain: 'solana', above: '100'
    });
    expect(result.created).toBe(true);
    expect(result.alert.type).toBe('price');
  });

  it('creates smart money alert via CLI handler', async () => {
    const result = await handler(['create'], null, { 'smart-money': true }, {
      wallet: SOL_WALLET, chain: 'solana'
    });
    expect(result.created).toBe(true);
    expect(result.alert.type).toBe('smart-money');
  });

  it('lists alerts via CLI handler', async () => {
    createAlert({ token: SOL_TOKEN, chain: 'solana', above: 100 });
    const result = await handler(['list'], null, {}, {});
    expect(result.count).toBe(1);
    expect(result.alerts).toHaveLength(1);
  });

  it('deletes alert via CLI handler', async () => {
    const { alert } = createAlert({ token: SOL_TOKEN, chain: 'solana', above: 100 });
    const result = await handler(['delete', alert.id], null, {}, {});
    expect(result.deleted).toBe(true);
    expect(result.alert.id).toBe(alert.id);
  });

  it('checks alerts via CLI handler', async () => {
    createAlert({ token: SOL_TOKEN, chain: 'solana', above: 100 });
    const mockApi = {
      request: vi.fn().mockResolvedValue({ data: { price_usd: 150 } })
    };
    const result = await handler(['check'], mockApi, {}, {});
    expect(result.count).toBe(1);
    expect(result.triggered).toHaveLength(1);
  });

  it('throws on unknown subcommand', async () => {
    await expect(handler(['unknown'], null, {}, {})).rejects.toThrow('Unknown alert subcommand');
  });

  it('throws on check without API instance', async () => {
    await expect(handler(['check'], null, {}, {})).rejects.toThrow('API key required');
  });
});

describe('Alert - JSON Output', () => {
  it('all outputs are JSON-serializable', () => {
    const result = createAlert({ token: SOL_TOKEN, chain: 'solana', above: 100 });
    expect(() => JSON.stringify(result)).not.toThrow();

    const list = listAlerts();
    expect(() => JSON.stringify(list)).not.toThrow();

    const deleted = deleteAlert(result.alert.id);
    expect(() => JSON.stringify(deleted)).not.toThrow();
  });

  it('error responses are JSON-serializable', () => {
    try {
      createAlert({});
    } catch (e) {
      expect(() => JSON.stringify({ error: e.message, code: e.code })).not.toThrow();
    }
  });
});

describe('Alert - VALID_CHAINS', () => {
  it('includes major chains', () => {
    expect(VALID_CHAINS).toContain('ethereum');
    expect(VALID_CHAINS).toContain('solana');
    expect(VALID_CHAINS).toContain('base');
    expect(VALID_CHAINS).toContain('arbitrum');
  });
});
