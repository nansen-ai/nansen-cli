/**
 * Nansen Alert Manager
 * Local alert system for price and smart money monitoring.
 * Persists to ~/.nansen/alerts.json with atomic writes.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getConfigDir, validateAddress, validateTokenAddress, NansenError, ErrorCode } from './api.js';

const ALERTS_FILE = path.join(getConfigDir(), 'alerts.json');
const MIN_CHECK_INTERVAL_MS = 60_000; // 60 seconds

// Supported chains (same as api.js)
const VALID_CHAINS = [
  'ethereum', 'solana', 'base', 'bnb', 'arbitrum', 'polygon', 'optimism',
  'avalanche', 'linea', 'scroll', 'zksync', 'mantle', 'ronin',
  'sei', 'plasma', 'sonic', 'unichain', 'monad', 'hyperevm', 'iotaevm'
];

/**
 * Read alerts from disk
 */
function readAlerts() {
  try {
    if (!fs.existsSync(ALERTS_FILE)) return [];
    const data = fs.readFileSync(ALERTS_FILE, 'utf8');
    const parsed = JSON.parse(data);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Write alerts to disk atomically (temp file + rename)
 */
function writeAlerts(alerts) {
  const dir = getConfigDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { mode: 0o700, recursive: true });
  }
  const tmpFile = ALERTS_FILE + '.tmp.' + process.pid;
  fs.writeFileSync(tmpFile, JSON.stringify(alerts, null, 2), { mode: 0o600 });
  fs.renameSync(tmpFile, ALERTS_FILE);
}

/**
 * Generate a deduplication key for an alert
 */
function alertKey(alert) {
  const { type, token, wallet, chain, condition, threshold } = alert;
  if (type === 'price') {
    return `price:${token}:${chain}:${condition}:${threshold}`;
  }
  return `smart-money:${wallet}:${chain}`;
}

/**
 * Validate alert creation inputs
 */
function validateCreateInputs({ token, wallet, chain, above, below, smartMoney }) {
  // Must have either token+price or wallet+smart-money
  const hasPrice = token && (above !== undefined || below !== undefined);
  const hasSM = wallet && smartMoney;

  if (!hasPrice && !hasSM) {
    throw new NansenError(
      'Must specify either --token with --above/--below for price alerts, or --wallet with --smart-money for smart money alerts',
      ErrorCode.MISSING_PARAM
    );
  }

  if (hasPrice && hasSM) {
    throw new NansenError(
      'Cannot combine price alert and smart money alert in one command',
      ErrorCode.INVALID_PARAMS
    );
  }

  // Validate chain
  if (!chain) {
    throw new NansenError('--chain is required', ErrorCode.MISSING_PARAM);
  }
  if (!VALID_CHAINS.includes(chain)) {
    throw new NansenError(
      `Invalid chain: ${chain}. Supported: ${VALID_CHAINS.join(', ')}`,
      ErrorCode.INVALID_CHAIN
    );
  }

  if (hasPrice) {
    // Validate token address
    const v = validateTokenAddress(token, chain);
    if (!v.valid) throw new NansenError(v.error, v.code);

    // Validate threshold is a positive number
    const threshold = above !== undefined ? above : below;
    const num = Number(threshold);
    if (isNaN(num) || num <= 0) {
      throw new NansenError(
        `Threshold must be a positive number, got: ${threshold}`,
        ErrorCode.INVALID_PARAMS
      );
    }
  }

  if (hasSM) {
    // Validate wallet address
    const v = validateAddress(wallet, chain);
    if (!v.valid) throw new NansenError(v.error, v.code);
  }
}

/**
 * Create an alert. Returns existing alert if duplicate (idempotent).
 */
export function createAlert({ token, wallet, chain, above, below, smartMoney }) {
  validateCreateInputs({ token, wallet, chain, above, below, smartMoney });

  const alerts = readAlerts();
  const now = new Date().toISOString();
  let newAlert;

  if (token && (above !== undefined || below !== undefined)) {
    const condition = above !== undefined ? 'above' : 'below';
    const threshold = Number(above !== undefined ? above : below);
    newAlert = {
      id: crypto.randomUUID(),
      type: 'price',
      token,
      chain,
      condition,
      threshold,
      status: 'active',
      createdAt: now,
      lastCheckedAt: null,
      triggeredAt: null,
    };
  } else {
    newAlert = {
      id: crypto.randomUUID(),
      type: 'smart-money',
      wallet,
      chain,
      status: 'active',
      createdAt: now,
      lastCheckedAt: null,
      triggeredAt: null,
      lastSeenTxHash: null,
    };
  }

  // Deduplication: return existing if same key
  const key = alertKey(newAlert);
  const existing = alerts.find(a => alertKey(a) === key && a.status === 'active');
  if (existing) {
    return { alert: existing, created: false };
  }

  alerts.push(newAlert);
  writeAlerts(alerts);
  return { alert: newAlert, created: true };
}

/**
 * List all alerts
 */
export function listAlerts() {
  return readAlerts();
}

/**
 * Delete an alert by ID
 */
export function deleteAlert(id) {
  if (!id) {
    throw new NansenError('Alert ID is required', ErrorCode.MISSING_PARAM);
  }
  const alerts = readAlerts();
  const idx = alerts.findIndex(a => a.id === id);
  if (idx === -1) {
    throw new NansenError(`Alert not found: ${id}`, ErrorCode.NOT_FOUND);
  }
  const removed = alerts.splice(idx, 1)[0];
  writeAlerts(alerts);
  return removed;
}

/**
 * Sleep helper
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fetch with retry and exponential backoff (3 retries: 1s, 2s, 4s)
 */
async function fetchWithRetry(api, endpoint, body, maxRetries = 3) {
  let lastError;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await api.request(endpoint, body, { retry: false });
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries - 1) {
        const delayMs = 1000 * Math.pow(2, attempt); // 1s, 2s, 4s
        await sleep(delayMs);
      }
    }
  }
  throw lastError;
}

/**
 * Check a single price alert against the API
 */
async function checkPriceAlert(alert, api) {
  const data = await fetchWithRetry(api, '/api/v1/tgm/token-information', {
    token_address: alert.token,
    chain: alert.chain,
    timeframe: '1d',
  });

  const price = data?.data?.price_usd ?? data?.price_usd;
  if (price === undefined || price === null) return null;

  const numPrice = Number(price);
  if (isNaN(numPrice)) return null;

  const triggered =
    (alert.condition === 'above' && numPrice >= alert.threshold) ||
    (alert.condition === 'below' && numPrice <= alert.threshold);

  if (triggered) {
    return {
      alertId: alert.id,
      type: 'price',
      token: alert.token,
      chain: alert.chain,
      condition: alert.condition,
      threshold: alert.threshold,
      currentPrice: numPrice,
      triggeredAt: new Date().toISOString(),
    };
  }
  return null;
}

/**
 * Check a single smart money alert against the API
 */
async function checkSmartMoneyAlert(alert, api) {
  const data = await fetchWithRetry(api, '/api/v1/smart-money/dex-trades', {
    chains: [alert.chain],
    filters: { trader_address: alert.wallet },
    pagination: { page: 1, recordsPerPage: 1 },
  });

  const trades = data?.data || [];
  if (!Array.isArray(trades) || trades.length === 0) return null;

  const latestTx = trades[0]?.transaction_hash;
  if (!latestTx || latestTx === alert.lastSeenTxHash) return null;

  return {
    alertId: alert.id,
    type: 'smart-money',
    wallet: alert.wallet,
    chain: alert.chain,
    latestTrade: trades[0],
    triggeredAt: new Date().toISOString(),
  };
}

/**
 * Check all active alerts. Returns array of triggered events.
 * Rate-limited: skips alerts checked within MIN_CHECK_INTERVAL_MS.
 * Marks triggered alerts so they never re-fire.
 */
export async function checkAlerts(api) {
  const alerts = readAlerts();
  const now = Date.now();
  const triggered = [];

  for (const alert of alerts) {
    if (alert.status !== 'active') continue;

    // Rate limit: skip if checked too recently
    if (alert.lastCheckedAt) {
      const elapsed = now - new Date(alert.lastCheckedAt).getTime();
      if (elapsed < MIN_CHECK_INTERVAL_MS) continue;
    }

    alert.lastCheckedAt = new Date(now).toISOString();

    try {
      let event = null;
      if (alert.type === 'price') {
        event = await checkPriceAlert(alert, api);
      } else if (alert.type === 'smart-money') {
        event = await checkSmartMoneyAlert(alert, api);
        // Update lastSeenTxHash even if not triggered
        if (event) {
          alert.lastSeenTxHash = event.latestTrade?.transaction_hash || null;
        }
      }

      if (event) {
        alert.status = 'triggered';
        alert.triggeredAt = event.triggeredAt;
        triggered.push(event);
      }
    } catch {
      // API errors are swallowed per-alert; other alerts still get checked
    }
  }

  writeAlerts(alerts);
  return triggered;
}

/**
 * Build the alert command handler for the CLI
 */
export function buildAlertCommand(deps = {}) {
  return async (args, apiInstance, flags, options) => {
    const sub = args[0];

    if (!sub || sub === 'help') {
      return {
        command: 'alert',
        subcommands: ['create', 'list', 'delete', 'check'],
        usage: {
          create_price: 'nansen alert create --token <addr> --chain <chain> --above <price>',
          create_smart_money: 'nansen alert create --wallet <addr> --chain <chain> --smart-money',
          list: 'nansen alert list',
          delete: 'nansen alert delete <id>',
          check: 'nansen alert check',
        },
      };
    }

    switch (sub) {
      case 'create': {
        const token = options.token;
        const wallet = options.wallet;
        const chain = options.chain;
        const above = options.above;
        const below = options.below;
        const smartMoney = flags['smart-money'] || flags.smartMoney;

        const result = createAlert({ token, wallet, chain, above, below, smartMoney });
        return result;
      }

      case 'list': {
        const alerts = listAlerts();
        return { alerts, count: alerts.length };
      }

      case 'delete': {
        const id = args[1];
        const removed = deleteAlert(id);
        return { deleted: true, alert: removed };
      }

      case 'check': {
        if (!apiInstance) {
          throw new NansenError('API key required for alert check. Run: nansen login', ErrorCode.UNAUTHORIZED);
        }
        const triggered = await checkAlerts(apiInstance);
        return { triggered, count: triggered.length };
      }

      default:
        throw new NansenError(
          `Unknown alert subcommand: ${sub}. Available: create, list, delete, check`,
          ErrorCode.INVALID_PARAMS
        );
    }
  };
}

// Export for testing
export { ALERTS_FILE, readAlerts, writeAlerts, MIN_CHECK_INTERVAL_MS, VALID_CHAINS };
