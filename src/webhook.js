/**
 * Webhook Delivery — provider-agnostic alert relay.
 *
 * Providers:
 *   openclaw — POST /hooks/agent with agentId, sessionKey, deliver, channel
 *   generic  — simple JSON POST with raw alert data + configurable headers
 *   slack    — Slack incoming webhook (blocks)
 *   discord  — Discord webhook (embeds)
 */

/**
 * Default retry configuration.
 */
const DEFAULT_RETRY = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
};

// ============= Provider Formatters =============

/**
 * Format a Nansen alert into an OpenClaw /hooks/agent payload.
 */
export function formatOpenclawPayload(alert, options = {}) {
  const {
    agentId = 'hooks',
    channel = 'last',
    deliver = true,
    model,
  } = options;

  const lines = [`Nansen Smart Alert: ${alert.name || 'Unnamed Alert'}`];
  lines.push(`Type: ${alert.type || 'unknown'}`);
  if (alert.description) lines.push(`Description: ${alert.description}`);
  if (alert.id) lines.push(`Alert ID: ${alert.id}`);
  if (alert.data?.chains?.length) lines.push(`Chains: ${alert.data.chains.join(', ')}`);

  lines.push('');
  lines.push('Alert data:');
  lines.push('```json');
  lines.push(JSON.stringify(alert.data || {}, null, 2));
  lines.push('```');

  const payload = {
    message: lines.join('\n'),
    name: `nansen-alert:${alert.type || 'unknown'}`,
    agentId,
    sessionKey: `hook:nansen:alert-${alert.id || Date.now()}`,
    deliver,
    channel,
  };

  if (model) payload.model = model;

  return payload;
}

/**
 * Format a Nansen alert as a generic JSON payload (raw alert data).
 */
export function formatGenericPayload(alert) {
  return {
    event: 'nansen.alert',
    alert: {
      id: alert.id,
      name: alert.name || 'Unnamed Alert',
      type: alert.type || 'unknown',
      description: alert.description || null,
      isEnabled: alert.isEnabled,
      data: alert.data || {},
    },
    timestamp: new Date().toISOString(),
  };
}

/**
 * Format a Nansen alert as a Slack incoming webhook payload (blocks).
 */
export function formatSlackPayload(alert) {
  const name = alert.name || 'Unnamed Alert';
  const type = alert.type || 'unknown';
  const chains = alert.data?.chains?.length ? alert.data.chains.join(', ') : 'N/A';

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `Nansen Alert: ${name}`, emoji: true },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Type:*\n${type}` },
        { type: 'mrkdwn', text: `*Chains:*\n${chains}` },
      ],
    },
  ];

  if (alert.description) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Description:*\n${alert.description}` },
    });
  }

  if (alert.id) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `Alert ID: \`${alert.id}\`` }],
    });
  }

  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: '```' + JSON.stringify(alert.data || {}, null, 2) + '```',
    },
  });

  return { blocks, text: `Nansen Alert: ${name}` };
}

/**
 * Format a Nansen alert as a Discord webhook payload (embeds).
 */
export function formatDiscordPayload(alert) {
  const name = alert.name || 'Unnamed Alert';
  const type = alert.type || 'unknown';
  const chains = alert.data?.chains?.length ? alert.data.chains.join(', ') : 'N/A';

  const fields = [
    { name: 'Type', value: type, inline: true },
    { name: 'Chains', value: chains, inline: true },
  ];

  if (alert.description) {
    fields.push({ name: 'Description', value: alert.description });
  }

  const dataStr = JSON.stringify(alert.data || {}, null, 2);
  // Discord embed field value max 1024 chars
  const truncated = dataStr.length > 1000 ? dataStr.slice(0, 997) + '...' : dataStr;
  fields.push({ name: 'Data', value: '```json\n' + truncated + '\n```' });

  return {
    embeds: [{
      title: `Nansen Alert: ${name}`,
      color: 0x3498db,
      fields,
      footer: alert.id ? { text: `Alert ID: ${alert.id}` } : undefined,
      timestamp: new Date().toISOString(),
    }],
  };
}

// ============= Provider Registry =============

const PROVIDERS = {
  openclaw: {
    formatPayload: formatOpenclawPayload,
    buildHeaders: (token) => ({
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    }),
  },
  generic: {
    formatPayload: formatGenericPayload,
    buildHeaders: (token, extraHeaders) => ({
      'Content-Type': 'application/json',
      ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
      ...extraHeaders,
    }),
  },
  slack: {
    formatPayload: formatSlackPayload,
    buildHeaders: () => ({
      'Content-Type': 'application/json',
    }),
  },
  discord: {
    formatPayload: formatDiscordPayload,
    buildHeaders: () => ({
      'Content-Type': 'application/json',
    }),
  },
};

/**
 * Get a provider by name.
 * @param {string} providerType
 * @returns {{ formatPayload: Function, buildHeaders: Function }}
 */
export function getProvider(providerType) {
  const provider = PROVIDERS[providerType];
  if (!provider) {
    const valid = Object.keys(PROVIDERS).join(', ');
    throw new Error(`Unknown webhook provider: "${providerType}". Valid: ${valid}`);
  }
  return provider;
}

/**
 * Format an alert payload using the specified provider.
 * Backward-compatible alias — when providerType is omitted, defaults to 'openclaw'.
 */
export function formatAlertPayload(alert, options = {}) {
  const { providerType = 'openclaw', ...providerOptions } = options;
  const provider = getProvider(providerType);
  return provider.formatPayload(alert, providerOptions);
}

// ============= Delivery =============

/**
 * Sleep helper for retry backoff.
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Deliver a payload to a webhook endpoint with retry.
 *
 * @param {string} url - The webhook URL.
 * @param {string} token - Auth token (usage depends on provider).
 * @param {object} payload - The request body.
 * @param {object} [retryConfig] - Retry configuration.
 * @param {object} [headerOverrides] - Extra headers to merge (for generic provider).
 * @returns {Promise<{ok: boolean, status: number, body: string}>}
 */
export async function deliverWebhook(url, token, payload, retryConfig = {}, headerOverrides = {}) {
  const { maxAttempts, baseDelayMs, maxDelayMs } = { ...DEFAULT_RETRY, ...retryConfig };

  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
    ...headerOverrides,
  };

  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });

      const body = await response.text();

      if (response.ok) {
        return { ok: true, status: response.status, body };
      }

      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After');
        const delayMs = retryAfter ? Number(retryAfter) * 1000 : baseDelayMs * Math.pow(2, attempt - 1);
        lastError = new Error(`Rate limited (429). Retry-After: ${retryAfter || 'none'}`);
        if (attempt < maxAttempts) {
          await sleep(Math.min(delayMs, maxDelayMs));
          continue;
        }
        return { ok: false, status: 429, body };
      }

      if (response.status >= 400 && response.status < 500) {
        return { ok: false, status: response.status, body };
      }

      lastError = new Error(`Server error: ${response.status} ${body}`);
      if (attempt < maxAttempts) {
        await sleep(Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs));
        continue;
      }
      return { ok: false, status: response.status, body };

    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) {
        await sleep(Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs));
        continue;
      }
    }
  }

  return { ok: false, status: 0, body: lastError?.message || 'Unknown error' };
}

// ============= Relay =============

/**
 * Poll for alerts and relay new ones to a webhook endpoint.
 *
 * @param {object} apiInstance - NansenAPI instance.
 * @param {object} config - Relay configuration.
 * @param {string} config.url - Webhook URL.
 * @param {string} [config.token] - Auth token.
 * @param {string} [config.providerType] - Provider type (default: 'generic').
 * @param {number} [config.intervalMs] - Polling interval (default: 60000).
 * @param {string} [config.type] - Filter by alert type.
 * @param {string} [config.alertId] - Relay only this specific alert ID.
 * @param {object} [config.providerOptions] - Options passed to the provider's formatPayload.
 * @param {object} [config.retryConfig] - Retry configuration for webhook delivery.
 * @param {object} [config.headerOverrides] - Extra headers (for generic provider).
 * @param {function} [config.log] - Logging function.
 * @param {AbortSignal} [config.signal] - AbortSignal to stop polling.
 * @returns {Promise<void>}
 */
export async function relayAlerts(apiInstance, config) {
  const {
    url,
    token,
    providerType = 'generic',
    intervalMs = 60000,
    type,
    alertId,
    providerOptions = {},
    retryConfig = {},
    headerOverrides = {},
    log = console.error,
    signal,
  } = config;

  // Backward compat: accept openclawOptions as alias for providerOptions
  const effectiveProviderOptions = config.openclawOptions || providerOptions;

  const provider = getProvider(providerType);
  const seenAlerts = new Set();
  let firstRun = true;

  while (!signal?.aborted) {
    try {
      const result = await apiInstance.alertsList();
      let alerts = Array.isArray(result) ? result : result?.alerts ?? result?.data ?? [];

      if (alertId) alerts = alerts.filter(a => a.id === alertId);
      if (type) alerts = alerts.filter(a => a.type === type);
      alerts = alerts.filter(a => a.isEnabled !== false);

      for (const alert of alerts) {
        const key = `${alert.id}:${JSON.stringify(alert.data)}`;

        if (firstRun) {
          seenAlerts.add(key);
          continue;
        }

        if (seenAlerts.has(key)) continue;
        seenAlerts.add(key);

        const payload = provider.formatPayload(alert, effectiveProviderOptions);
        const result = await deliverWebhook(url, token, payload, retryConfig, headerOverrides);

        if (result.ok) {
          log(`[webhook-relay] Delivered alert "${alert.name}" (${alert.id})`);
        } else {
          log(`[webhook-relay] Failed to deliver alert "${alert.name}" (${alert.id}): ${result.status} ${result.body}`);
        }
      }

      firstRun = false;
    } catch (err) {
      log(`[webhook-relay] Poll error: ${err.message}`);
    }

    if (signal?.aborted) break;
    await Promise.race([
      sleep(intervalMs),
      new Promise(resolve => signal?.addEventListener('abort', resolve, { once: true })),
    ]);
  }
}
