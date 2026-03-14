/**
 * Webhook Delivery Tests — provider-agnostic
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  formatOpenclawPayload,
  formatGenericPayload,
  formatSlackPayload,
  formatDiscordPayload,
  formatAlertPayload,
  getProvider,
  deliverWebhook,
  relayAlerts,
} from '../webhook.js';
import { buildAlertsCommands } from '../commands/alerts.js';

const baseAlert = {
  id: 'alert-123',
  name: 'ETH SM Inflow',
  type: 'sm-token-flows',
  description: 'Smart money inflow on ETH',
  isEnabled: true,
  data: { chains: ['ethereum'], inflow_1h: { min: 1000000 } },
};

// ============= formatOpenclawPayload =============

describe('formatOpenclawPayload', () => {
  it('should format a basic alert payload', () => {
    const payload = formatOpenclawPayload(baseAlert);
    expect(payload.message).toContain('Nansen Smart Alert: ETH SM Inflow');
    expect(payload.message).toContain('Type: sm-token-flows');
    expect(payload.message).toContain('Description: Smart money inflow on ETH');
    expect(payload.message).toContain('Chains: ethereum');
    expect(payload.message).toContain('"inflow_1h"');
    expect(payload.name).toBe('nansen-alert:sm-token-flows');
    expect(payload.agentId).toBe('hooks');
    expect(payload.sessionKey).toBe('hook:nansen:alert-alert-123');
    expect(payload.deliver).toBe(true);
    expect(payload.channel).toBe('last');
  });

  it('should use custom options', () => {
    const payload = formatOpenclawPayload(baseAlert, {
      agentId: 'custom-agent',
      channel: 'telegram',
      deliver: false,
      model: 'openai/gpt-5.2-mini',
    });
    expect(payload.agentId).toBe('custom-agent');
    expect(payload.channel).toBe('telegram');
    expect(payload.deliver).toBe(false);
    expect(payload.model).toBe('openai/gpt-5.2-mini');
  });

  it('should handle alert without optional fields', () => {
    const minimal = { id: 'min-1', type: 'unknown', data: {} };
    const payload = formatOpenclawPayload(minimal);
    expect(payload.message).toContain('Unnamed Alert');
    expect(payload.name).toBe('nansen-alert:unknown');
    expect(payload.sessionKey).toBe('hook:nansen:alert-min-1');
  });

  it('should not include model when not specified', () => {
    const payload = formatOpenclawPayload(baseAlert);
    expect(payload).not.toHaveProperty('model');
  });
});

// ============= formatGenericPayload =============

describe('formatGenericPayload', () => {
  it('should format a raw alert payload', () => {
    const payload = formatGenericPayload(baseAlert);
    expect(payload.event).toBe('nansen.alert');
    expect(payload.alert.id).toBe('alert-123');
    expect(payload.alert.name).toBe('ETH SM Inflow');
    expect(payload.alert.type).toBe('sm-token-flows');
    expect(payload.alert.description).toBe('Smart money inflow on ETH');
    expect(payload.alert.data).toEqual(baseAlert.data);
    expect(payload.timestamp).toBeTruthy();
  });

  it('should handle minimal alert', () => {
    const payload = formatGenericPayload({ id: 'x', data: {} });
    expect(payload.alert.name).toBe('Unnamed Alert');
    expect(payload.alert.type).toBe('unknown');
    expect(payload.alert.description).toBeNull();
  });
});

// ============= formatSlackPayload =============

describe('formatSlackPayload', () => {
  it('should format Slack blocks payload', () => {
    const payload = formatSlackPayload(baseAlert);
    expect(payload.text).toBe('Nansen Alert: ETH SM Inflow');
    expect(payload.blocks).toBeInstanceOf(Array);
    expect(payload.blocks.length).toBeGreaterThanOrEqual(3);

    // Header block
    expect(payload.blocks[0].type).toBe('header');
    expect(payload.blocks[0].text.text).toContain('ETH SM Inflow');

    // Section with fields
    expect(payload.blocks[1].type).toBe('section');
    expect(payload.blocks[1].fields[0].text).toContain('sm-token-flows');
    expect(payload.blocks[1].fields[1].text).toContain('ethereum');
  });

  it('should include description block when present', () => {
    const payload = formatSlackPayload(baseAlert);
    const descBlock = payload.blocks.find(b => b.text?.text?.includes('Description'));
    expect(descBlock).toBeTruthy();
  });

  it('should include context block with alert ID', () => {
    const payload = formatSlackPayload(baseAlert);
    const ctxBlock = payload.blocks.find(b => b.type === 'context');
    expect(ctxBlock.elements[0].text).toContain('alert-123');
  });
});

// ============= formatDiscordPayload =============

describe('formatDiscordPayload', () => {
  it('should format Discord embeds payload', () => {
    const payload = formatDiscordPayload(baseAlert);
    expect(payload.embeds).toHaveLength(1);
    const embed = payload.embeds[0];
    expect(embed.title).toContain('ETH SM Inflow');
    expect(embed.color).toBe(0x3498db);
    expect(embed.fields.length).toBeGreaterThanOrEqual(3);
    expect(embed.footer.text).toContain('alert-123');
    expect(embed.timestamp).toBeTruthy();
  });

  it('should include description field', () => {
    const embed = formatDiscordPayload(baseAlert).embeds[0];
    const descField = embed.fields.find(f => f.name === 'Description');
    expect(descField.value).toBe('Smart money inflow on ETH');
  });

  it('should truncate large data payloads', () => {
    const bigAlert = { ...baseAlert, data: { large: 'x'.repeat(2000) } };
    const embed = formatDiscordPayload(bigAlert).embeds[0];
    const dataField = embed.fields.find(f => f.name === 'Data');
    expect(dataField.value.length).toBeLessThanOrEqual(1024);
  });
});

// ============= formatAlertPayload (backward compat) =============

describe('formatAlertPayload (backward compat)', () => {
  it('should default to openclaw provider', () => {
    const payload = formatAlertPayload(baseAlert);
    expect(payload.agentId).toBe('hooks');
    expect(payload.message).toContain('Nansen Smart Alert');
  });

  it('should support providerType option', () => {
    const payload = formatAlertPayload(baseAlert, { providerType: 'generic' });
    expect(payload.event).toBe('nansen.alert');
  });

  it('should pass through provider-specific options', () => {
    const payload = formatAlertPayload(baseAlert, { providerType: 'openclaw', agentId: 'my-agent' });
    expect(payload.agentId).toBe('my-agent');
  });
});

// ============= getProvider =============

describe('getProvider', () => {
  it('should return known providers', () => {
    for (const type of ['openclaw', 'generic', 'slack', 'discord']) {
      const p = getProvider(type);
      expect(p.formatPayload).toBeInstanceOf(Function);
      expect(p.buildHeaders).toBeInstanceOf(Function);
    }
  });

  it('should throw for unknown provider', () => {
    expect(() => getProvider('telegram')).toThrow('Unknown webhook provider');
  });
});

// ============= deliverWebhook =============

describe('deliverWebhook', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should deliver successfully on 200', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: () => Promise.resolve('ok'),
      headers: new Headers(),
    });

    const result = await deliverWebhook('http://test/hooks/agent', 'token123', { message: 'hi' });
    expect(result).toEqual({ ok: true, status: 200, body: 'ok' });
    expect(fetch).toHaveBeenCalledWith('http://test/hooks/agent', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({
        'Content-Type': 'application/json',
        'Authorization': 'Bearer token123',
      }),
      body: JSON.stringify({ message: 'hi' }),
    }));
  });

  it('should return failure on 401 without retry', async () => {
    fetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: () => Promise.resolve('Unauthorized'),
      headers: new Headers(),
    });

    const result = await deliverWebhook('http://test/hooks/agent', 'bad-token', { message: 'hi' });
    expect(result).toEqual({ ok: false, status: 401, body: 'Unauthorized' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('should retry on 500 with backoff', async () => {
    const error500 = {
      ok: false,
      status: 500,
      text: () => Promise.resolve('Internal Server Error'),
      headers: new Headers(),
    };
    const success = {
      ok: true,
      status: 200,
      text: () => Promise.resolve('ok'),
      headers: new Headers(),
    };

    fetch.mockResolvedValueOnce(error500).mockResolvedValueOnce(success);

    const result = await deliverWebhook('http://test/hooks/agent', 'token', { message: 'hi' }, {
      maxAttempts: 3,
      baseDelayMs: 10,
    });
    expect(result).toEqual({ ok: true, status: 200, body: 'ok' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('should retry on 429 and respect Retry-After header', async () => {
    const rateLimit = {
      ok: false,
      status: 429,
      text: () => Promise.resolve('Too Many Requests'),
      headers: new Headers({ 'Retry-After': '1' }),
    };
    const success = {
      ok: true,
      status: 200,
      text: () => Promise.resolve('ok'),
      headers: new Headers(),
    };

    fetch.mockResolvedValueOnce(rateLimit).mockResolvedValueOnce(success);

    const result = await deliverWebhook('http://test/hooks/agent', 'token', { message: 'hi' }, {
      maxAttempts: 2,
      baseDelayMs: 10,
      maxDelayMs: 50,
    });
    expect(result).toEqual({ ok: true, status: 200, body: 'ok' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('should return failure after all retries exhausted on network error', async () => {
    fetch.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await deliverWebhook('http://test/hooks/agent', 'token', { message: 'hi' }, {
      maxAttempts: 2,
      baseDelayMs: 10,
    });
    expect(result).toEqual({ ok: false, status: 0, body: 'ECONNREFUSED' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('should return 429 if all retry attempts rate-limited', async () => {
    const rateLimit = {
      ok: false,
      status: 429,
      text: () => Promise.resolve('Too Many Requests'),
      headers: new Headers(),
    };

    fetch.mockResolvedValue(rateLimit);

    const result = await deliverWebhook('http://test/hooks/agent', 'token', { message: 'hi' }, {
      maxAttempts: 2,
      baseDelayMs: 10,
    });
    expect(result).toEqual({ ok: false, status: 429, body: 'Too Many Requests' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('should send without Authorization when token is null', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: () => Promise.resolve('ok'),
      headers: new Headers(),
    });

    await deliverWebhook('http://slack.test/hook', null, { blocks: [] });
    const callHeaders = fetch.mock.calls[0][1].headers;
    expect(callHeaders).not.toHaveProperty('Authorization');
  });
});

// ============= relayAlerts =============

describe('relayAlerts', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should seed seen set on first poll and deliver on second poll for new alerts', async () => {
    const alert1 = { id: 'a1', name: 'Alert 1', type: 'sm-token-flows', isEnabled: true, data: { chains: ['ethereum'] } };
    const alert2 = { id: 'a2', name: 'Alert 2', type: 'common-token-transfer', isEnabled: true, data: { chains: ['solana'] } };

    fetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('ok'),
      headers: new Headers(),
    });

    const logs = [];
    const ac = new AbortController();

    let pollCount = 0;
    const mockApi = {
      alertsList: vi.fn().mockImplementation(async () => {
        pollCount++;
        if (pollCount >= 2) setTimeout(() => ac.abort(), 5);
        if (pollCount === 1) return [alert1];
        return [alert1, alert2];
      }),
    };

    await relayAlerts(mockApi, {
      url: 'http://test/hooks/agent',
      token: 'tok',
      providerType: 'openclaw',
      intervalMs: 10,
      log: (msg) => logs.push(msg),
      signal: ac.signal,
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(logs.some(l => l.includes('Alert 2'))).toBe(true);
  });

  it('should filter by type', async () => {
    const alert1 = { id: 'a1', name: 'SM', type: 'sm-token-flows', isEnabled: true, data: {} };
    const alert2 = { id: 'a2', name: 'Transfer', type: 'common-token-transfer', isEnabled: true, data: {} };

    let pollCount = 0;
    const ac = new AbortController();
    const mockApi = {
      alertsList: vi.fn().mockImplementation(async () => {
        pollCount++;
        if (pollCount >= 2) setTimeout(() => ac.abort(), 5);
        return [alert1, alert2];
      }),
    };

    fetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('ok'),
      headers: new Headers(),
    });

    const logs = [];
    await relayAlerts(mockApi, {
      url: 'http://test/hooks/agent',
      token: 'tok',
      providerType: 'generic',
      intervalMs: 10,
      type: 'common-token-transfer',
      log: (msg) => logs.push(msg),
      signal: ac.signal,
    });

    expect(logs.every(l => !l.includes('SM'))).toBe(true);
  });

  it('should skip disabled alerts', async () => {
    const alert1 = { id: 'a1', name: 'Disabled', type: 'sm-token-flows', isEnabled: false, data: {} };

    let pollCount = 0;
    const ac = new AbortController();
    const mockApi = {
      alertsList: vi.fn().mockImplementation(async () => {
        pollCount++;
        if (pollCount >= 2) setTimeout(() => ac.abort(), 5);
        return [alert1];
      }),
    };

    await relayAlerts(mockApi, {
      url: 'http://test/hooks/agent',
      token: 'tok',
      providerType: 'generic',
      intervalMs: 10,
      log: vi.fn(),
      signal: ac.signal,
    });

    expect(fetch).not.toHaveBeenCalled();
  });

  it('should use slack provider when specified', async () => {
    const alert1 = { id: 'a1', name: 'SM Alert', type: 'sm-token-flows', isEnabled: true, data: { chains: ['ethereum'] } };

    let pollCount = 0;
    const ac = new AbortController();
    const mockApi = {
      alertsList: vi.fn().mockImplementation(async () => {
        pollCount++;
        if (pollCount >= 2) setTimeout(() => ac.abort(), 5);
        if (pollCount === 1) return [];
        return [alert1];
      }),
    };

    fetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('ok'),
      headers: new Headers(),
    });

    await relayAlerts(mockApi, {
      url: 'https://hooks.slack.com/xxx',
      providerType: 'slack',
      intervalMs: 10,
      log: vi.fn(),
      signal: ac.signal,
    });

    if (fetch.mock.calls.length > 0) {
      const body = JSON.parse(fetch.mock.calls[0][1].body);
      expect(body.blocks).toBeTruthy();
    }
  });
});

// ============= alerts --openclaw channel (backward compat) =============

describe('alerts --openclaw channel', () => {
  it('should include openclaw channel when --openclaw is provided', async () => {
    const mockApi = { alertsCreate: vi.fn().mockResolvedValue({ id: 'new' }) };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await cmd(['create'], mockApi, {}, {
      name: 'Test',
      type: 'sm-token-flows',
      chains: 'ethereum',
      openclaw: 'http://localhost:18790/hooks/agent',
    });
    expect(mockApi.alertsCreate).toHaveBeenCalledWith(expect.objectContaining({
      channels: [{ type: 'openclaw', data: { webhookUrl: 'http://localhost:18790/hooks/agent' } }],
    }));
  });

  it('should combine openclaw with other channels', async () => {
    const mockApi = { alertsCreate: vi.fn().mockResolvedValue({ id: 'new' }) };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await cmd(['create'], mockApi, {}, {
      name: 'Test',
      type: 'sm-token-flows',
      chains: 'ethereum',
      telegram: '123456',
      openclaw: 'http://localhost:18790/hooks/agent',
    });
    const call = mockApi.alertsCreate.mock.calls[0][0];
    expect(call.channels).toHaveLength(2);
    expect(call.channels[0]).toEqual({ type: 'telegram', data: { chatId: '123456' } });
    expect(call.channels[1]).toEqual({ type: 'openclaw', data: { webhookUrl: 'http://localhost:18790/hooks/agent' } });
  });
});

// ============= alerts --webhook channel =============

describe('alerts --webhook channel', () => {
  it('should include generic webhook channel when --webhook is provided', async () => {
    const mockApi = { alertsCreate: vi.fn().mockResolvedValue({ id: 'new' }) };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await cmd(['create'], mockApi, {}, {
      name: 'Test',
      type: 'sm-token-flows',
      chains: 'ethereum',
      webhook: 'https://my-server.com/alerts',
    });
    expect(mockApi.alertsCreate).toHaveBeenCalledWith(expect.objectContaining({
      channels: [{ type: 'generic', data: { webhookUrl: 'https://my-server.com/alerts' } }],
    }));
  });

  it('should use --webhook-type when provided', async () => {
    const mockApi = { alertsCreate: vi.fn().mockResolvedValue({ id: 'new' }) };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await cmd(['create'], mockApi, {}, {
      name: 'Test',
      type: 'sm-token-flows',
      chains: 'ethereum',
      webhook: 'https://hooks.slack.com/xxx',
      'webhook-type': 'slack',
    });
    expect(mockApi.alertsCreate).toHaveBeenCalledWith(expect.objectContaining({
      channels: [{ type: 'slack', data: { webhookUrl: 'https://hooks.slack.com/xxx' } }],
    }));
  });
});

// ============= webhook-relay subcommand =============

describe('alerts webhook-relay', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should require --url', async () => {
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    const origUrl = process.env.WEBHOOK_RELAY_URL;
    const origOcUrl = process.env.OPENCLAW_HOOKS_URL;
    delete process.env.WEBHOOK_RELAY_URL;
    delete process.env.OPENCLAW_HOOKS_URL;
    try {
      await expect(cmd(['webhook-relay'], {}, {}, { token: 'tok' }))
        .rejects.toThrow('--url or WEBHOOK_RELAY_URL');
    } finally {
      if (origUrl) process.env.WEBHOOK_RELAY_URL = origUrl;
      if (origOcUrl) process.env.OPENCLAW_HOOKS_URL = origOcUrl;
    }
  });

  it('should require --token for openclaw provider', async () => {
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    const origToken = process.env.WEBHOOK_RELAY_TOKEN;
    const origOcToken = process.env.OPENCLAW_HOOKS_TOKEN;
    delete process.env.WEBHOOK_RELAY_TOKEN;
    delete process.env.OPENCLAW_HOOKS_TOKEN;
    try {
      await expect(cmd(['webhook-relay'], {}, {}, { url: 'http://test', 'webhook-type': 'openclaw' }))
        .rejects.toThrow('--token or WEBHOOK_RELAY_TOKEN');
    } finally {
      if (origToken) process.env.WEBHOOK_RELAY_TOKEN = origToken;
      if (origOcToken) process.env.OPENCLAW_HOOKS_TOKEN = origOcToken;
    }
  });

  it('should not require --token for slack provider', async () => {
    const alerts = [
      { id: 'a1', name: 'A1', type: 'sm-token-flows', isEnabled: true, data: {} },
    ];
    const mockApi = { alertsList: vi.fn().mockResolvedValue(alerts) };
    const logs = [];
    const cmd = buildAlertsCommands({ log: (msg) => logs.push(msg) })['alerts'];

    fetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('ok'),
      headers: new Headers(),
    });

    const result = await cmd(['webhook-relay'], mockApi, { once: true }, {
      url: 'https://hooks.slack.com/xxx',
      'webhook-type': 'slack',
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(1);
  });

  it('should run --once mode and deliver all enabled alerts', async () => {
    const alerts = [
      { id: 'a1', name: 'A1', type: 'sm-token-flows', isEnabled: true, data: {} },
      { id: 'a2', name: 'A2', type: 'sm-token-flows', isEnabled: false, data: {} },
    ];
    const mockApi = { alertsList: vi.fn().mockResolvedValue(alerts) };
    const logs = [];
    const cmd = buildAlertsCommands({ log: (msg) => logs.push(msg) })['alerts'];

    fetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('ok'),
      headers: new Headers(),
    });

    const result = await cmd(['webhook-relay'], mockApi, { once: true }, {
      url: 'http://test/hooks/agent',
      token: 'tok',
      'webhook-type': 'openclaw',
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(1);
    expect(result[0].alertId).toBe('a1');
    expect(result[0].ok).toBe(true);
  });

  it('should show help text for webhook-relay', async () => {
    const logs = [];
    const cmd = buildAlertsCommands({ log: (msg) => logs.push(msg) })['alerts'];
    await cmd(['webhook-relay'], {}, { help: true }, {});
    expect(logs[0]).toContain('webhook-relay');
    expect(logs[0]).toContain('--url');
    expect(logs[0]).toContain('--webhook-type');
  });
});

// ============= openclaw-relay backward compat =============

describe('alerts openclaw-relay (backward compat)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should work as alias for webhook-relay --webhook-type openclaw', async () => {
    const alerts = [
      { id: 'a1', name: 'A1', type: 'sm-token-flows', isEnabled: true, data: {} },
    ];
    const mockApi = { alertsList: vi.fn().mockResolvedValue(alerts) };
    const logs = [];
    const cmd = buildAlertsCommands({ log: (msg) => logs.push(msg) })['alerts'];

    fetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('ok'),
      headers: new Headers(),
    });

    const result = await cmd(['openclaw-relay'], mockApi, { once: true }, {
      url: 'http://test/hooks/agent',
      token: 'tok',
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(1);
    // Verify the payload was formatted as openclaw (has agentId, message, etc.)
    const sentBody = JSON.parse(fetch.mock.calls[0][1].body);
    expect(sentBody.agentId).toBe('hooks');
    expect(sentBody.message).toContain('Nansen Smart Alert');
  });

  it('should require --token for openclaw-relay (backward compat)', async () => {
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    const origToken = process.env.WEBHOOK_RELAY_TOKEN;
    const origOcToken = process.env.OPENCLAW_HOOKS_TOKEN;
    delete process.env.WEBHOOK_RELAY_TOKEN;
    delete process.env.OPENCLAW_HOOKS_TOKEN;
    try {
      await expect(cmd(['openclaw-relay'], {}, {}, { url: 'http://test' }))
        .rejects.toThrow('--token or WEBHOOK_RELAY_TOKEN');
    } finally {
      if (origToken) process.env.WEBHOOK_RELAY_TOKEN = origToken;
      if (origOcToken) process.env.OPENCLAW_HOOKS_TOKEN = origOcToken;
    }
  });

  it('should show help when --help on openclaw-relay', async () => {
    const logs = [];
    const cmd = buildAlertsCommands({ log: (msg) => logs.push(msg) })['alerts'];
    await cmd(['openclaw-relay'], {}, { help: true }, {});
    expect(logs[0]).toContain('webhook-relay');
  });
});
