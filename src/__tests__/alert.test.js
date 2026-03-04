/**
 * Tests for alert module
 *
 * Covers: payload builders, table formatter, alertRequest error handling,
 * and buildAlertCommands handler (create/list/delete/toggle/help).
 * All HTTP calls are mocked — no real network requests.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildSmFlowsPayload, alertsTable, buildAlertCommands } from '../alert.js';
import { NansenError, ErrorCode } from '../api.js';

// ============= Mock fetch globally =============

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function mockApiKey(key = 'test-api-key') {
  return { apiKey: key, baseUrl: 'https://api.nansen.ai' };
}

function mockJsonResponse(data, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
  });
}

function mockNetworkError(message = 'connection refused') {
  return Promise.reject(new Error(message));
}

beforeEach(() => {
  mockFetch.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ============= buildSmFlowsPayload =============

describe('buildSmFlowsPayload', () => {
  it('should build a basic sm-token-flows payload', () => {
    const p = buildSmFlowsPayload({ chain: 'ethereum', 'netflow-24h-min': '500000', telegram: '-123' });
    expect(p.type).toBe('sm-token-flows');
    expect(p.data.chains).toEqual(['ethereum']);
    expect(p.data.netflow_1d).toEqual({ min: 500000 });
    expect(p.channels).toEqual([{ type: 'telegram', data: { chatId: '-123' } }]);
  });

  it('should auto-generate name from thresholds', () => {
    const p = buildSmFlowsPayload({ chain: 'ethereum', 'netflow-24h-min': '500000', telegram: '-123' });
    expect(p.name).toContain('SM flows');
    expect(p.name).toContain('ethereum');
    expect(p.name).toContain('$500K');
  });

  it('should use provided name when set', () => {
    const p = buildSmFlowsPayload({ name: 'My Alert', chain: 'ethereum', telegram: '-123' });
    expect(p.name).toBe('My Alert');
  });

  it('should map timewindow aliases correctly', () => {
    expect(buildSmFlowsPayload({ chain: 'ethereum', timewindow: '24h', telegram: '-1' }).timeWindow).toBe('1d');
    expect(buildSmFlowsPayload({ chain: 'ethereum', timewindow: '7d', telegram: '-1' }).timeWindow).toBe('1w');
    expect(buildSmFlowsPayload({ chain: 'ethereum', timewindow: '1h', telegram: '-1' }).timeWindow).toBe('1h');
  });

  it('should default timeWindow to 1d', () => {
    const p = buildSmFlowsPayload({ chain: 'ethereum', telegram: '-1' });
    expect(p.timeWindow).toBe('1d');
  });

  it('should support multiple channels', () => {
    const p = buildSmFlowsPayload({
      chain: 'ethereum',
      telegram: '-123',
      slack: 'https://hooks.slack.com/test',
    });
    expect(p.channels).toHaveLength(2);
    expect(p.channels[0].type).toBe('telegram');
    expect(p.channels[1].type).toBe('slack');
  });

  it('should support multiple chains as array', () => {
    const p = buildSmFlowsPayload({ chain: ['ethereum', 'solana'], telegram: '-1' });
    expect(p.data.chains).toEqual(['ethereum', 'solana']);
  });

  it('should throw NansenError for non-numeric netflow threshold', () => {
    expect(() =>
      buildSmFlowsPayload({ chain: 'ethereum', 'netflow-24h-min': 'abc', telegram: '-1' }),
    ).toThrow(NansenError);

    expect(() =>
      buildSmFlowsPayload({ chain: 'ethereum', 'netflow-24h-min': 'abc', telegram: '-1' }),
    ).toThrow('Invalid number: abc');
  });

  it('should produce empty threshold objects when no thresholds set', () => {
    const p = buildSmFlowsPayload({ chain: 'ethereum', telegram: '-1' });
    expect(p.data.netflow_1d).toEqual({});
    expect(p.data.netflow_1h).toEqual({});
    expect(p.data.netflow_7d).toEqual({});
  });

  it('should set createdBy to agent', () => {
    const p = buildSmFlowsPayload({ chain: 'ethereum', telegram: '-1' });
    expect(p.createdBy).toBe('agent');
  });
});

// ============= alertsTable =============

describe('alertsTable', () => {
  it('should return a placeholder for empty arrays', () => {
    expect(alertsTable([])).toBe('(no alerts found)');
    expect(alertsTable(null)).toBe('(no alerts found)');
    expect(alertsTable(undefined)).toBe('(no alerts found)');
  });

  it('should render a table with header and rows', () => {
    const alerts = [{
      id: 'abc123', name: 'My Alert', type: 'sm-token-flows',
      isEnabled: true, channels: [{ type: 'telegram' }], createdAt: '2026-01-01T00:00:00Z',
    }];
    const table = alertsTable(alerts);
    expect(table).toContain('ID');
    expect(table).toContain('abc123');
    expect(table).toContain('My Alert');
    expect(table).toContain('✓');
    expect(table).toContain('telegram');
    expect(table).toContain('2026-01-01');
  });

  it('should handle disabled alerts', () => {
    const alerts = [{ id: '1', isEnabled: false }];
    expect(alertsTable(alerts)).toContain('✗');
  });

  it('should safely convert non-string id to string', () => {
    const alerts = [{ id: 12345 }];
    expect(() => alertsTable(alerts)).not.toThrow();
    expect(alertsTable(alerts)).toContain('12345');
  });

  it('should truncate long names to 32 chars', () => {
    const longName = 'A'.repeat(50);
    const alerts = [{ id: '1', name: longName }];
    const table = alertsTable(alerts);
    expect(table).toContain('A'.repeat(32));
    expect(table).not.toContain('A'.repeat(33));
  });

  it('should use — for missing fields', () => {
    const alerts = [{ id: null, name: null }];
    const table = alertsTable(alerts);
    expect(table).toContain('—');
  });
});

// ============= alertRequest (via buildAlertCommands) =============

describe('alertRequest error handling', () => {
  it('should throw NansenError with UNAUTHORIZED when no api key', async () => {
    const { alert } = buildAlertCommands({ log: vi.fn(), errorOutput: vi.fn() });
    const api = { apiKey: null, baseUrl: 'https://api.nansen.ai' };

    const result = await alert(['list'], api, {}, {});
    expect(result.type).toBe('error');
  });

  it('should throw NansenError on 401 response', async () => {
    mockFetch.mockResolvedValue({
      ok: false, status: 401,
      json: () => Promise.resolve({ message: 'Unauthorized' }),
    });

    const logs = [];
    const errors = [];
    const { alert } = buildAlertCommands({ log: m => logs.push(m), errorOutput: m => errors.push(m) });

    const result = await alert(['list'], mockApiKey(), {}, {});
    expect(result.type).toBe('error');
    expect(errors.some(e => e.includes('Error'))).toBe(true);
  });

  it('should handle network errors gracefully', async () => {
    mockFetch.mockRejectedValue(new Error('connection refused'));

    const errors = [];
    const { alert } = buildAlertCommands({ log: vi.fn(), errorOutput: m => errors.push(m) });

    const result = await alert(['list'], mockApiKey(), {}, {});
    expect(result.type).toBe('error');
    expect(errors.some(e => e.includes('Error'))).toBe(true);
  });

  it('should include X-Client-Type and X-Client-Version headers', async () => {
    mockFetch.mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve([]),
    });

    const { alert } = buildAlertCommands({ log: vi.fn(), errorOutput: vi.fn() });
    await alert(['list'], mockApiKey(), {}, {});

    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers['X-Client-Type']).toBe('nansen-cli');
    expect(opts.headers['X-Client-Version']).toMatch(/^\d+\.\d+\.\d+/);
    expect(opts.headers['apikey']).toBe('test-api-key');
  });
});

// ============= buildAlertCommands — help =============

describe('buildAlertCommands help', () => {
  it('should show top-level help when no subcommand', async () => {
    const logs = [];
    const { alert } = buildAlertCommands({ log: m => logs.push(m), errorOutput: vi.fn() });

    const result = await alert([], mockApiKey(), {}, {});
    expect(result.type).toBe('help');
    expect(result.command).toBe('alert');
    expect(logs.some(l => l.includes('SUBCOMMANDS'))).toBe(true);
    expect(logs.some(l => l.includes('NansenBot'))).toBe(true);
  });

  it('should show top-level help for --help flag', async () => {
    const logs = [];
    const { alert } = buildAlertCommands({ log: m => logs.push(m), errorOutput: vi.fn() });

    const result = await alert([], mockApiKey(), { help: true }, {});
    expect(result.type).toBe('help');
    expect(logs.some(l => l.includes('TELEGRAM SETUP'))).toBe(true);
  });

  it('should show create-specific help for create --help', async () => {
    const logs = [];
    const { alert } = buildAlertCommands({ log: m => logs.push(m), errorOutput: vi.fn() });

    const result = await alert(['create'], mockApiKey(), { help: true }, {});
    expect(result.command).toBe('alert create');
    expect(logs.some(l => l.includes('SM-FLOWS OPTIONS'))).toBe(true);
  });
});

// ============= buildAlertCommands — create =============

describe('buildAlertCommands create', () => {
  it('should error when no delivery channel provided', async () => {
    const errors = [];
    const { alert } = buildAlertCommands({ log: vi.fn(), errorOutput: m => errors.push(m) });

    const result = await alert(['create'], mockApiKey(), { chain: 'ethereum', 'netflow-24h-min': '500000' }, {});
    expect(result.type).toBe('error');
    expect(result.error).toBe('no channel');
    expect(errors.some(e => e.includes('channel'))).toBe(true);
    expect(errors.some(e => e.includes('NansenBot'))).toBe(true);
  });

  it('should error for unsupported alert type', async () => {
    const errors = [];
    const { alert } = buildAlertCommands({ log: vi.fn(), errorOutput: m => errors.push(m) });

    const result = await alert(['create'], mockApiKey(), { type: 'unknown-type', telegram: '-123' }, {});
    expect(result.type).toBe('error');
    expect(errors.some(e => e.includes('unsupported'))).toBe(true);
  });

  it('should create alert and show success with id', async () => {
    mockFetch.mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({ id: 'alert-abc-123', name: 'test' }),
    });

    const logs = [];
    const { alert } = buildAlertCommands({ log: m => logs.push(m), errorOutput: vi.fn() });

    const result = await alert(
      ['create'], mockApiKey(),
      { chain: 'ethereum', 'netflow-24h-min': '500000', telegram: '-5201043873' },
      {},
    );
    expect(result.type).toBe('alert-created');
    expect(logs.some(l => l.includes('alert-abc-123'))).toBe(true);
  });

  it('should warn about NansenBot when Telegram channel used', async () => {
    mockFetch.mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({ id: 'x' }),
    });

    const logs = [];
    const { alert } = buildAlertCommands({ log: m => logs.push(m), errorOutput: vi.fn() });

    await alert(['create'], mockApiKey(), { telegram: '-123', 'netflow-24h-min': '1000' }, {});
    expect(logs.some(l => l.includes('NansenBot'))).toBe(true);
  });

  it('should error when payload builder throws (invalid threshold)', async () => {
    const errors = [];
    const { alert } = buildAlertCommands({ log: vi.fn(), errorOutput: m => errors.push(m) });

    const result = await alert(
      ['create'], mockApiKey(),
      { telegram: '-123', 'netflow-24h-min': 'not-a-number' },
      {},
    );
    expect(result.type).toBe('error');
    expect(errors.some(e => e.includes('Invalid number'))).toBe(true);
  });

  it('should POST to /smart-alert/v3/', async () => {
    mockFetch.mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({ id: 'x' }),
    });

    const { alert } = buildAlertCommands({ log: vi.fn(), errorOutput: vi.fn() });
    await alert(['create'], mockApiKey(), { telegram: '-1', 'netflow-24h-min': '1000' }, {});

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain('/smart-alert/v3/');
    expect(opts.method).toBe('POST');
  });
});

// ============= buildAlertCommands — list =============

describe('buildAlertCommands list', () => {
  it('should print table when alerts returned', async () => {
    mockFetch.mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve([
        { id: 'abc', name: 'ETH Alert', type: 'sm-token-flows', isEnabled: true, channels: [], createdAt: '2026-01-01T00:00:00Z' },
      ]),
    });

    const logs = [];
    const { alert } = buildAlertCommands({ log: m => logs.push(m), errorOutput: vi.fn() });

    const result = await alert(['list'], mockApiKey(), {}, {});
    expect(result.type).toBe('alert-list');
    expect(result.data).toHaveLength(1);
    expect(logs.some(l => l.includes('abc'))).toBe(true);
  });

  it('should show empty message when no alerts', async () => {
    mockFetch.mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve([]),
    });

    const logs = [];
    const { alert } = buildAlertCommands({ log: m => logs.push(m), errorOutput: vi.fn() });

    const result = await alert(['list'], mockApiKey(), {}, {});
    expect(result.type).toBe('alert-list');
    expect(result.data).toEqual([]);
    expect(logs.some(l => l.includes('No alerts'))).toBe(true);
  });

  it('should GET /smart-alert/v3/list', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve([]) });

    const { alert } = buildAlertCommands({ log: vi.fn(), errorOutput: vi.fn() });
    await alert(['list'], mockApiKey(), {}, {});

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain('/smart-alert/v3/list');
    expect(opts.method).toBe('GET');
  });
});

// ============= buildAlertCommands — delete =============

describe('buildAlertCommands delete', () => {
  it('should error when no id provided', async () => {
    const errors = [];
    const { alert } = buildAlertCommands({ log: vi.fn(), errorOutput: m => errors.push(m) });

    const result = await alert(['delete'], mockApiKey(), {}, {});
    expect(result.error).toBe('missing id');
    expect(errors.some(e => e.includes('delete <id>'))).toBe(true);
  });

  it('should DELETE /smart-alert/v3/:id', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}) });

    const logs = [];
    const { alert } = buildAlertCommands({ log: m => logs.push(m), errorOutput: vi.fn() });

    const result = await alert(['delete', 'alert-123'], mockApiKey(), {}, {});
    expect(result.type).toBe('alert-deleted');
    expect(result.id).toBe('alert-123');
    expect(logs.some(l => l.includes('alert-123'))).toBe(true);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain('/smart-alert/v3/alert-123');
    expect(opts.method).toBe('DELETE');
  });
});

// ============= buildAlertCommands — toggle =============

describe('buildAlertCommands toggle', () => {
  it('should error when no id provided', async () => {
    const errors = [];
    const { alert } = buildAlertCommands({ log: vi.fn(), errorOutput: m => errors.push(m) });

    const result = await alert(['toggle'], mockApiKey(), { enable: true }, {});
    expect(result.error).toBe('missing id');
  });

  it('should error when neither --enable nor --disable provided', async () => {
    const errors = [];
    const { alert } = buildAlertCommands({ log: vi.fn(), errorOutput: m => errors.push(m) });

    const result = await alert(['toggle', 'alert-123'], mockApiKey(), {}, {});
    expect(result.error).toBe('missing --enable/--disable');
    expect(errors.some(e => e.includes('--enable'))).toBe(true);
  });

  it('should PATCH /smart-alert/v3/toggle with isEnabled=true', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}) });

    const logs = [];
    const { alert } = buildAlertCommands({ log: m => logs.push(m), errorOutput: vi.fn() });

    const result = await alert(['toggle', 'alert-123'], mockApiKey(), { enable: true }, {});
    expect(result.type).toBe('alert-toggled');
    expect(result.isEnabled).toBe(true);
    expect(logs.some(l => l.includes('enabled'))).toBe(true);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain('/smart-alert/v3/toggle');
    expect(opts.method).toBe('PATCH');
    expect(JSON.parse(opts.body)).toMatchObject({ id: 'alert-123', isEnabled: true });
  });

  it('should PATCH with isEnabled=false for --disable', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}) });

    const { alert } = buildAlertCommands({ log: vi.fn(), errorOutput: vi.fn() });
    const result = await alert(['toggle', 'alert-123'], mockApiKey(), { disable: true }, {});
    expect(result.isEnabled).toBe(false);
  });
});

// ============= buildAlertCommands — unknown subcommand =============

describe('buildAlertCommands unknown subcommand', () => {
  it('should return error for unknown subcommand', async () => {
    const errors = [];
    const { alert } = buildAlertCommands({ log: vi.fn(), errorOutput: m => errors.push(m) });

    const result = await alert(['foobar'], mockApiKey(), {}, {});
    expect(result.type).toBe('error');
    expect(errors.some(e => e.includes('foobar'))).toBe(true);
  });
});
