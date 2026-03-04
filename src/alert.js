/**
 * Nansen CLI - Alert Management Commands
 * Create, list, toggle and delete smart money alerts via the Nansen smart-alert API.
 *
 * Auth: Nansen API key (apikey header) — same key used for all other nansen commands.
 * Endpoint: https://api.nansen.ai/smart-alert/v3/ (requires Kong route — see Step 1 of plan)
 *
 * Local testing (without Kong):
 *   1. Run superapp backend locally (APP_ENV=local)
 *   2. Set NANSEN_ALERT_API_URL=http://localhost:5001
 *   3. Run: nansen alert create --type sm-flows --chain ethereum --netflow-24h-min 500000 --telegram -5201043873
 *      (The local dev bypass in AuthGuard will accept any ApiKey and use the Professional dev user)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ============= Config =============

function getConfig() {
  const configPath = path.join(
    process.env.HOME || process.env.USERPROFILE || '',
    '.nansen',
    'config.json',
  );
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return {};
  }
}

function getApiKey() {
  return process.env.NANSEN_API_KEY || getConfig().apiKey || null;
}

/**
 * Base URL for smart-alert API.
 * Override with NANSEN_ALERT_API_URL for local testing:
 *   NANSEN_ALERT_API_URL=http://localhost:5001 nansen alert create ...
 */
function getAlertBaseUrl() {
  return (
    process.env.NANSEN_ALERT_API_URL ||
    process.env.NANSEN_BASE_URL ||
    'https://api.nansen.ai'
  );
}

// ============= HTTP client =============

async function alertRequest(method, path_, body = null) {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error(
      'No API key configured. Run: nansen login --api-key <key>',
    );
  }

  const url = `${getAlertBaseUrl()}/smart-alert/v3${path_}`;
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `ApiKey ${apiKey}`,
      'X-Client-Type': 'nansen-cli',
    },
  };
  if (body !== null) {
    opts.body = JSON.stringify(body);
  }

  const res = await fetch(url, opts);
  let data;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!res.ok) {
    const msg =
      data?.message || data?.error || `HTTP ${res.status} ${res.statusText}`;
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// ============= Alert API helpers =============

/**
 * POST /smart-alert/v3/
 */
export async function createAlert(payload) {
  return alertRequest('POST', '/', payload);
}

/**
 * GET /smart-alert/v3/list
 */
export async function listAlerts() {
  return alertRequest('GET', '/list');
}

/**
 * DELETE /smart-alert/v3/:id
 */
export async function deleteAlert(id) {
  return alertRequest('DELETE', `/${id}`);
}

/**
 * PATCH /smart-alert/v3/toggle
 */
export async function toggleAlert(id, isEnabled) {
  return alertRequest('PATCH', '/toggle', { id, isEnabled });
}

// ============= Payload builders =============

const TIME_WINDOW_MAP = {
  '1h': '1h',
  '4h': '4h',
  '12h': '12h',
  '24h': '1d',
  '1d': '1d',
  '7d': '1w',
  '1w': '1w',
};

/**
 * Build a sm-token-flows alert payload from CLI flags.
 */
function buildSmFlowsPayload(options) {
  const {
    chain = 'ethereum',
    name,
    'netflow-1h-min': netflow1hMin,
    'netflow-1h-max': netflow1hMax,
    'netflow-24h-min': netflow24hMin,
    'netflow-24h-max': netflow24hMax,
    'netflow-7d-min': netflow7dMin,
    'netflow-7d-max': netflow7dMax,
    'inflow-24h-min': inflow24hMin,
    'outflow-24h-min': outflow24hMin,
    'market-cap-min': marketCapMin,
    'market-cap-max': marketCapMax,
    telegram,
    slack,
    discord,
    timewindow = '1d',
  } = options;

  const chains = Array.isArray(chain) ? chain : [chain];
  const timeWindow = TIME_WINDOW_MAP[timewindow] || timewindow;

  const channels = buildChannels({ telegram, slack, discord });

  // Human-readable default name
  const alertName =
    name ||
    [
      `SM flows on ${chains.join('+')}`,
      netflow24hMin && `netflow24h>${formatUsd(netflow24hMin)}`,
      netflow24hMax && `netflow24h<${formatUsd(netflow24hMax)}`,
    ]
      .filter(Boolean)
      .join(' ');

  return {
    name: alertName,
    type: 'sm-token-flows',
    timeWindow,
    createdBy: 'agent',
    channels,
    data: {
      chains,
      events: ['sm-token-flows'],
      // 1h
      netflow_1h: toMinMax(netflow1hMin, netflow1hMax),
      inflow_1h: {},
      outflow_1h: {},
      // 1d
      netflow_1d: toMinMax(netflow24hMin, netflow24hMax),
      inflow_1d: inflow24hMin ? { min: parseFloat(inflow24hMin) } : {},
      outflow_1d: outflow24hMin ? { min: parseFloat(outflow24hMin) } : {},
      // 7d
      netflow_7d: toMinMax(netflow7dMin, netflow7dMax),
      inflow_7d: {},
      outflow_7d: {},
      inclusion: {
        ...(marketCapMin || marketCapMax
          ? { marketCap: toMinMax(marketCapMin, marketCapMax) }
          : {}),
      },
      exclusion: {},
    },
  };
}

function toMinMax(min, max) {
  const obj = {};
  if (min !== undefined && min !== null) obj.min = parseFloat(min);
  if (max !== undefined && max !== null) obj.max = parseFloat(max);
  return obj;
}

function formatUsd(val) {
  const n = parseFloat(val);
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n}`;
}

function buildChannels({ telegram, slack, discord }) {
  const channels = [];
  if (telegram) {
    channels.push({ type: 'telegram', data: { chatId: String(telegram) } });
  }
  if (slack) {
    channels.push({ type: 'slack', data: { webhookUrl: slack } });
  }
  if (discord) {
    channels.push({ type: 'discord', data: { webhookUrl: discord } });
  }
  // Must have at least one channel; fall back to noop (creates alert silently)
  if (channels.length === 0) {
    channels.push({ type: 'noop' });
  }
  return channels;
}

// ============= Table formatter =============

function formatAlertsTable(alerts) {
  if (!alerts || alerts.length === 0) return '(no alerts)';
  const rows = alerts.map((a) => ({
    id: a.id || '—',
    name: a.name || '—',
    type: a.type || '—',
    enabled: a.isEnabled ? '✓' : '✗',
    channels: (a.channels || []).map((c) => c.type).join(', ') || '—',
    created: a.createdAt ? new Date(a.createdAt).toISOString().slice(0, 10) : '—',
  }));

  const cols = ['id', 'name', 'type', 'enabled', 'channels', 'created'];
  const widths = cols.map((c) =>
    Math.max(c.length, ...rows.map((r) => String(r[c]).length)),
  );

  const header = cols.map((c, i) => c.padEnd(widths[i])).join('  ');
  const divider = widths.map((w) => '─'.repeat(w)).join('  ');
  const body = rows
    .map((r) => cols.map((c, i) => String(r[c]).padEnd(widths[i])).join('  '))
    .join('\n');

  return `${header}\n${divider}\n${body}`;
}

// ============= Command builder =============

export function buildAlertCommands(deps = {}) {
  const { log = console.log, errorOutput = console.error } = deps;

  const HELP = `nansen alert — Manage smart money alerts

SUBCOMMANDS:
  create    Create a new alert
  list      List all alerts
  delete    Delete an alert by ID
  toggle    Enable or disable an alert

USAGE:
  nansen alert create --type sm-flows --chain ethereum --netflow-24h-min 500000 --telegram <chat-id>
  nansen alert list
  nansen alert delete <id>
  nansen alert toggle <id> --enable
  nansen alert toggle <id> --disable

LOCAL TESTING (without Kong):
  Set NANSEN_ALERT_API_URL=http://localhost:5001 and run with APP_ENV=local on the backend.

NOTE:
  Alerts are delivered by @NansenBot. For Telegram delivery, add @NansenBot to your chat first.`;

  const CREATE_HELP = `nansen alert create — Create a new smart money alert

TYPES:
  sm-flows          Smart money token netflow threshold (most common)

SM-FLOWS OPTIONS:
  --chain <chain>             Chain to monitor (default: ethereum)
  --netflow-24h-min <usd>     Fire when 24h netflow exceeds this USD value
  --netflow-24h-max <usd>     Fire when 24h netflow is below this USD value
  --netflow-1h-min <usd>      1h netflow threshold (min)
  --netflow-7d-min <usd>      7d netflow threshold (min)
  --inflow-24h-min <usd>      24h inflow threshold
  --outflow-24h-min <usd>     24h outflow threshold
  --market-cap-min <usd>      Filter by minimum market cap
  --market-cap-max <usd>      Filter by maximum market cap
  --timewindow <window>       Evaluation window: 1h|4h|12h|24h|1d|7d|1w (default: 1d)
  --name <name>               Alert name (auto-generated if omitted)

DELIVERY CHANNELS (at least one required):
  --telegram <chat-id>        Telegram chat ID (e.g. -5201043873)
  --slack <webhook-url>       Slack incoming webhook URL
  --discord <webhook-url>     Discord webhook URL

EXAMPLES:
  nansen alert create --type sm-flows --chain ethereum --netflow-24h-min 500000 --telegram -5201043873
  nansen alert create --type sm-flows --chain solana --netflow-1h-min 100000 --netflow-24h-min 500000 --telegram -5201043873`;

  return {
    alert: async (args, _apiInstance, flags, _options) => {
      const sub = args[0];

      if (!sub || sub === 'help' || flags.help || flags.h) {
        log(HELP);
        return { type: 'help', command: 'alert' };
      }

      // ── create ──────────────────────────────────────────────────────────────
      if (sub === 'create') {
        if (flags.help || flags.h) {
          log(CREATE_HELP);
          return { type: 'help', command: 'alert create' };
        }

        const type = flags.type || flags.t || 'sm-flows';

        let payload;
        if (type === 'sm-flows' || type === 'sm-token-flows') {
          if (!flags.telegram && !flags.slack && !flags.discord) {
            errorOutput(
              'Error: specify at least one delivery channel (--telegram, --slack, --discord)',
            );
            errorOutput('  Example: --telegram -5201043873');
            return { type: 'error', error: 'no channel specified' };
          }
          payload = buildSmFlowsPayload(flags);
        } else {
          errorOutput(`Error: unsupported alert type "${type}". Supported: sm-flows`);
          return { type: 'error', error: 'unsupported type' };
        }

        try {
          const result = await createAlert(payload);
          const id = result?.id || result?.data?.id || '(unknown)';
          log(`✓ Alert created: ${id}`);
          log(`  Name: ${payload.name}`);
          log(`  Type: ${payload.type} | Window: ${payload.timeWindow}`);
          log(
            `  Channels: ${payload.channels.map((c) => c.type).join(', ')}`,
          );
          if (payload.channels.some((c) => c.type === 'telegram')) {
            log('');
            log(
              '  ⚠ Telegram delivery: make sure @NansenBot is a member of your chat.',
            );
          }
          return { type: 'alert-created', data: result };
        } catch (err) {
          errorOutput(`Error creating alert: ${err.message}`);
          if (err.status === 401 || err.status === 403) {
            errorOutput('  Check your API key: nansen login --api-key <key>');
          }
          return { type: 'error', error: err.message };
        }
      }

      // ── list ────────────────────────────────────────────────────────────────
      if (sub === 'list') {
        try {
          const result = await listAlerts();
          const alerts = result?.data || result || [];
          if (!Array.isArray(alerts) || alerts.length === 0) {
            log('No alerts found.');
            return { type: 'alert-list', data: [] };
          }
          log(formatAlertsTable(alerts));
          return { type: 'alert-list', data: alerts };
        } catch (err) {
          errorOutput(`Error listing alerts: ${err.message}`);
          return { type: 'error', error: err.message };
        }
      }

      // ── delete ──────────────────────────────────────────────────────────────
      if (sub === 'delete') {
        const id = args[1];
        if (!id) {
          errorOutput('Error: provide an alert ID — nansen alert delete <id>');
          return { type: 'error', error: 'missing id' };
        }
        try {
          await deleteAlert(id);
          log(`✓ Alert deleted: ${id}`);
          return { type: 'alert-deleted', id };
        } catch (err) {
          errorOutput(`Error deleting alert ${id}: ${err.message}`);
          return { type: 'error', error: err.message };
        }
      }

      // ── toggle ──────────────────────────────────────────────────────────────
      if (sub === 'toggle') {
        const id = args[1];
        if (!id) {
          errorOutput(
            'Error: provide an alert ID — nansen alert toggle <id> --enable|--disable',
          );
          return { type: 'error', error: 'missing id' };
        }
        let isEnabled;
        if (flags.enable) isEnabled = true;
        else if (flags.disable) isEnabled = false;
        else {
          errorOutput(
            'Error: specify --enable or --disable',
          );
          return { type: 'error', error: 'missing --enable/--disable' };
        }
        try {
          await toggleAlert(id, isEnabled);
          log(`✓ Alert ${id} ${isEnabled ? 'enabled' : 'disabled'}`);
          return { type: 'alert-toggled', id, isEnabled };
        } catch (err) {
          errorOutput(`Error toggling alert ${id}: ${err.message}`);
          return { type: 'error', error: err.message };
        }
      }

      errorOutput(
        `Unknown alert subcommand: "${sub}". Available: create, list, delete, toggle`,
      );
      log('Run: nansen alert --help');
      return { type: 'error', error: `unknown subcommand: ${sub}` };
    },
  };
}
