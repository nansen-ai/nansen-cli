/**
 * OpenClaw Webhook Delivery
 *
 * Delivers Nansen smart alert payloads to an OpenClaw gateway
 * via the POST /hooks/agent endpoint.
 */

/**
 * Default retry configuration.
 */
const DEFAULT_RETRY = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
};

/**
 * Format a Nansen smart alert into an OpenClaw /hooks/agent payload.
 *
 * @param {object} alert - The alert object from the Nansen API.
 * @param {object} [options] - Formatting options.
 * @param {string} [options.agentId] - OpenClaw agent ID (default: "hooks").
 * @param {string} [options.channel] - Delivery channel (default: "last").
 * @param {boolean} [options.deliver] - Whether to deliver to a chat channel (default: true).
 * @param {string} [options.model] - Model override for the agent turn.
 * @returns {object} The /hooks/agent request body.
 */
export function formatAlertPayload(alert, options = {}) {
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
 * Sleep helper for retry backoff.
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Deliver a payload to an OpenClaw webhook endpoint with retry.
 *
 * @param {string} url - The OpenClaw webhook URL (e.g. http://localhost:18790/hooks/agent).
 * @param {string} token - Bearer token for authentication.
 * @param {object} payload - The request body.
 * @param {object} [retryConfig] - Retry configuration.
 * @returns {Promise<{ok: boolean, status: number, body: string}>}
 */
export async function deliverWebhook(url, token, payload, retryConfig = {}) {
  const { maxAttempts, baseDelayMs, maxDelayMs } = { ...DEFAULT_RETRY, ...retryConfig };

  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      });

      const body = await response.text();

      // Success or client error (don't retry 4xx except 429)
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

      // Non-retryable client errors
      if (response.status >= 400 && response.status < 500) {
        return { ok: false, status: response.status, body };
      }

      // Server errors — retry with backoff
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

/**
 * Poll for alerts and relay new ones to OpenClaw.
 *
 * @param {object} apiInstance - NansenAPI instance.
 * @param {object} config - Relay configuration.
 * @param {string} config.url - OpenClaw webhook URL.
 * @param {string} config.token - OpenClaw hook token.
 * @param {number} [config.intervalMs] - Polling interval (default: 60000).
 * @param {string} [config.type] - Filter by alert type.
 * @param {string} [config.alertId] - Relay only this specific alert ID.
 * @param {object} [config.openclawOptions] - Options passed to formatAlertPayload.
 * @param {object} [config.retryConfig] - Retry configuration for webhook delivery.
 * @param {function} [config.log] - Logging function.
 * @param {AbortSignal} [config.signal] - AbortSignal to stop polling.
 * @returns {Promise<void>}
 */
export async function relayAlerts(apiInstance, config) {
  const {
    url,
    token,
    intervalMs = 60000,
    type,
    alertId,
    openclawOptions = {},
    retryConfig = {},
    log = console.error,
    signal,
  } = config;

  const seenAlerts = new Set();
  let firstRun = true;

  while (!signal?.aborted) {
    try {
      const result = await apiInstance.alertsList();
      let alerts = Array.isArray(result) ? result : result?.alerts ?? result?.data ?? [];

      // Filter by type or specific alert ID
      if (alertId) alerts = alerts.filter(a => a.id === alertId);
      if (type) alerts = alerts.filter(a => a.type === type);

      // Only relay enabled alerts
      alerts = alerts.filter(a => a.isEnabled !== false);

      for (const alert of alerts) {
        const key = `${alert.id}:${JSON.stringify(alert.data)}`;

        if (firstRun) {
          // On first run, just seed the seen set — don't relay existing alerts
          seenAlerts.add(key);
          continue;
        }

        if (seenAlerts.has(key)) continue;
        seenAlerts.add(key);

        const payload = formatAlertPayload(alert, openclawOptions);
        const result = await deliverWebhook(url, token, payload, retryConfig);

        if (result.ok) {
          log(`[openclaw-relay] Delivered alert "${alert.name}" (${alert.id})`);
        } else {
          log(`[openclaw-relay] Failed to deliver alert "${alert.name}" (${alert.id}): ${result.status} ${result.body}`);
        }
      }

      firstRun = false;
    } catch (err) {
      log(`[openclaw-relay] Poll error: ${err.message}`);
    }

    // Wait for next interval or abort
    if (signal?.aborted) break;
    await Promise.race([
      sleep(intervalMs),
      new Promise(resolve => signal?.addEventListener('abort', resolve, { once: true })),
    ]);
  }
}
