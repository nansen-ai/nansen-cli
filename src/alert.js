/**
 * Nansen CLI - Smart Alert Commands
 * Create and manage smart money alerts via the Nansen API.
 *
 * Alerts are monitored by Nansen's backend and delivered via
 * Telegram, Slack, or Discord when thresholds are crossed.
 *
 * Auth: uses your existing Nansen API key (same as all other nansen commands).
 * Endpoint: https://api.nansen.ai/smart-alert/v3/
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { NansenError, ErrorCode } from './api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { version: packageVersion } = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
);

// ============= Alert API client =============

/**
 * Map HTTP status codes to NansenError error codes.
 * Mirrors the private statusToErrorCode in api.js.
 */
function statusToAlertErrorCode(status, data = {}) {
  const msg = (data?.message || data?.error || '').toLowerCase();
  switch (status) {
    case 400:
    case 422: return ErrorCode.INVALID_PARAMS;
    case 401: return ErrorCode.UNAUTHORIZED;
    case 403: return msg.includes('credit') ? ErrorCode.CREDITS_EXHAUSTED : ErrorCode.FORBIDDEN;
    case 404: return ErrorCode.NOT_FOUND;
    case 429: return ErrorCode.RATE_LIMITED;
    case 500:
    case 502: return ErrorCode.SERVER_ERROR;
    case 503: return ErrorCode.SERVICE_UNAVAILABLE;
    case 504: return ErrorCode.TIMEOUT;
    default:
      if (status >= 500) return ErrorCode.SERVER_ERROR;
      if (status >= 400) return ErrorCode.INVALID_PARAMS;
      return ErrorCode.UNKNOWN;
  }
}

/**
 * Make an authenticated request to the smart-alert API.
 * Uses the same apiKey and baseUrl as all other nansen commands.
 * Throws NansenError on failure (consistent with NansenAPI error contract).
 *
 * Override base URL for local testing: NANSEN_ALERT_BASE_URL=http://localhost:5001
 */
async function alertRequest(api, method, urlPath, body = null) {
  if (!api.apiKey) {
    throw new NansenError(
      'No API key configured. Run: nansen login --api-key <key>',
      ErrorCode.UNAUTHORIZED,
    );
  }

  const base = process.env.NANSEN_ALERT_BASE_URL || api.baseUrl;
  const url = `${base}/smart-alert/v3${urlPath}`;

  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'apikey': api.apiKey,
      'X-Client-Type': 'nansen-cli',
      'X-Client-Version': packageVersion,
    },
  };
  if (body !== null) {
    opts.body = JSON.stringify(body);
  }

  let data;
  let res;
  try {
    res = await fetch(url, opts);
    try { data = await res.json(); } catch { data = null; }
  } catch (err) {
    throw new NansenError(`Network error: ${err.message}`, ErrorCode.SERVICE_UNAVAILABLE);
  }

  if (!res.ok) {
    const msg = data?.message || data?.error || `HTTP ${res.status}`;
    throw new NansenError(msg, statusToAlertErrorCode(res.status, data), res.status, data);
  }
  return data;
}

// ============= Payload builders =============

const TIME_WINDOW_MAP = {
  '1h': '1h', '4h': '4h', '12h': '12h',
  '24h': '1d', '1d': '1d',
  '7d': '1w', '1w': '1w',
};

function usd(val) {
  const n = parseFloat(val);
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n}`;
}

function buildChannels(flags) {
  const channels = [];
  if (flags.telegram) channels.push({ type: 'telegram', data: { chatId: String(flags.telegram) } });
  if (flags.slack)    channels.push({ type: 'slack',    data: { webhookUrl: flags.slack } });
  if (flags.discord)  channels.push({ type: 'discord',  data: { webhookUrl: flags.discord } });
  return channels;
}

/**
 * Build a threshold object. Rejects NaN values explicitly.
 * @throws {NansenError} if a non-numeric string is passed
 */
function toThreshold(min, max) {
  const t = {};
  if (min !== undefined) {
    const val = parseFloat(min);
    if (isNaN(val)) throw new NansenError(`Invalid number: ${min}`, ErrorCode.INVALID_PARAMS);
    t.min = val;
  }
  if (max !== undefined) {
    const val = parseFloat(max);
    if (isNaN(val)) throw new NansenError(`Invalid number: ${max}`, ErrorCode.INVALID_PARAMS);
    t.max = val;
  }
  return t;
}

export function buildSmFlowsPayload(flags) {
  const chains = [].concat(flags.chain || 'ethereum');
  const timeWindow = TIME_WINDOW_MAP[flags.timewindow || '1d'] || '1d';

  const name = flags.name || [
    `SM flows · ${chains.join('+')}`,
    flags['netflow-24h-min'] && `netflow 24h > ${usd(flags['netflow-24h-min'])}`,
    flags['netflow-1h-min']  && `netflow 1h > ${usd(flags['netflow-1h-min'])}`,
  ].filter(Boolean).join(' · ');

  return {
    name,
    type: 'sm-token-flows',
    timeWindow,
    createdBy: 'agent',
    channels: buildChannels(flags),
    data: {
      chains,
      events: ['sm-token-flows'],
      netflow_1h: toThreshold(flags['netflow-1h-min']),
      netflow_1d: toThreshold(flags['netflow-24h-min'], flags['netflow-24h-max']),
      netflow_7d: toThreshold(flags['netflow-7d-min']),
      inflow_1h: {}, inflow_1d: {}, inflow_7d: {},
      outflow_1h: {}, outflow_1d: {}, outflow_7d: {},
      inclusion: {}, exclusion: {},
    },
  };
}

// ============= Table formatter =============

export function alertsTable(alerts) {
  if (!alerts?.length) return '(no alerts found)';

  const rows = alerts.map(a => ({
    id:       String(a.id      || '—').slice(0, 8),
    name:     String(a.name    || '—').slice(0, 32),
    type:     String(a.type    || '—'),
    enabled:  a.isEnabled ? '✓' : '✗',
    channels: (a.channels || []).map(c => c.type).join(', ') || '—',
    created:  a.createdAt ? new Date(a.createdAt).toISOString().slice(0, 10) : '—',
  }));

  const cols  = ['id', 'name', 'type', 'enabled', 'channels', 'created'];
  const heads = { id: 'ID', name: 'NAME', type: 'TYPE', enabled: 'ON', channels: 'CHANNELS', created: 'CREATED' };
  const widths = cols.map(c => Math.max(heads[c].length, ...rows.map(r => r[c].length)));

  const pad   = (s, w) => s.padEnd(w);
  const row   = r => cols.map((c, i) => pad(r[c], widths[i])).join('  ');
  const divider = widths.map(w => '─'.repeat(w)).join('  ');

  return [row(heads), divider, ...rows.map(row)].join('\n');
}

// ============= Help text =============

const HELP = `\
nansen alert — Manage smart money alerts

SUBCOMMANDS
  create    Create a new smart alert
  list      List your alerts
  delete    Delete an alert by ID
  toggle    Enable or disable an alert

USAGE
  nansen alert create --type sm-flows --chain ethereum \\
    --netflow-24h-min 500000 --telegram <chat-id>
  nansen alert list
  nansen alert delete <id>
  nansen alert toggle <id> --enable
  nansen alert toggle <id> --disable

Run 'nansen alert <subcommand> --help' for details.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TELEGRAM SETUP — REQUIRED FOR TELEGRAM DELIVERY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Nansen delivers alerts to Telegram via @NansenBot.
For alerts to land in your chat, the bot must be a member.

  1. Open the Telegram chat you want alerts in
  2. Add @NansenBot as a member
  3. Use that chat's ID with --telegram <chat-id>

To find your chat ID:
  • Group chats  — forward any message to @userinfobot
  • Your DM      — message @userinfobot directly → it shows your user ID
  • Channels     — the ID starts with -100...

@NansenBot will auto-disable an alert if it cannot send
(e.g. it was removed from the chat or the chat was deleted).
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

const CREATE_HELP = `\
nansen alert create — Create a smart money alert

TYPES
  sm-flows   Smart money token netflow threshold (default)
             Fires when smart money buys or sells a token above your threshold.

DELIVERY (at least one required)
  --telegram <chat-id>    Telegram chat ID (e.g. -5201043873)
  --slack <webhook-url>   Slack incoming webhook URL
  --discord <webhook-url> Discord webhook URL

SM-FLOWS OPTIONS
  --chain <chain>             Chain to monitor              (default: ethereum)
  --netflow-24h-min <usd>     24h netflow minimum in USD    (e.g. 500000)
  --netflow-24h-max <usd>     24h netflow maximum in USD
  --netflow-1h-min <usd>      1h netflow minimum in USD
  --netflow-7d-min <usd>      7d netflow minimum in USD
  --timewindow <window>       Evaluation window: 1h|24h|1d|7d|1w (default: 1d)
  --name <name>               Alert name (auto-generated if omitted)

EXAMPLES
  # Alert when smart money buys > $500K on Ethereum in 24h → Telegram
  nansen alert create --type sm-flows --chain ethereum \\
    --netflow-24h-min 500000 --telegram -5201043873

  # Alert on Solana, 1h window → Slack
  nansen alert create --type sm-flows --chain solana \\
    --netflow-1h-min 100000 --timewindow 1h \\
    --slack https://hooks.slack.com/services/...

TELEGRAM SETUP
  Before creating a Telegram alert:
  1. Add @NansenBot to your target Telegram chat
  2. Use the chat's ID as the --telegram value
  (Run 'nansen alert --help' for full setup instructions)`;

// ============= Command builder =============

export function buildAlertCommands(deps = {}) {
  const { log = console.log, errorOutput = console.error } = deps;

  return {
    alert: async (args, api, flags, _options) => {
      const sub = args[0];

      // ── subcommand-specific help (nansen alert create --help) ──────────
      if ((flags.help || flags.h) && sub && sub !== 'help') {
        if (sub === 'create') {
          log(CREATE_HELP);
          return { type: 'help', command: 'alert create' };
        }
      }

      // ── top-level help ─────────────────────────────────────────────────
      if (!sub || sub === 'help' || flags.help || flags.h) {
        log(HELP);
        return { type: 'help', command: 'alert' };
      }

      // ── create ─────────────────────────────────────────────────────────
      if (sub === 'create') {
        const type = (flags.type || flags.t || 'sm-flows').toLowerCase();

        if (type !== 'sm-flows' && type !== 'sm-token-flows') {
          errorOutput(`Error: unsupported alert type "${type}"`);
          errorOutput('Supported types: sm-flows');
          return { type: 'error', error: 'unsupported type' };
        }

        const channels = buildChannels(flags);
        if (!channels.length) {
          errorOutput('Error: at least one delivery channel is required.');
          errorOutput('  --telegram <chat-id>  |  --slack <webhook>  |  --discord <webhook>');
          errorOutput('');
          errorOutput("Telegram setup: add @NansenBot to your chat, then use that chat's ID.");
          errorOutput('Run: nansen alert --help');
          return { type: 'error', error: 'no channel' };
        }

        let payload;
        try {
          payload = buildSmFlowsPayload(flags);
        } catch (err) {
          errorOutput(`Error: ${err.message}`);
          return { type: 'error', error: err.message };
        }

        try {
          const result = await alertRequest(api, 'POST', '/', payload);
          const id = result?.id || result?.data?.id;

          log(`✓ Alert created${id ? `: ${id}` : ''}`);
          log(`  Name:     ${payload.name}`);
          log(`  Type:     ${payload.type}`);
          log(`  Window:   ${payload.timeWindow}`);
          log(`  Chains:   ${payload.data.chains.join(', ')}`);
          log(`  Channels: ${channels.map(c => c.type).join(', ')}`);

          if (channels.some(c => c.type === 'telegram')) {
            log('');
            log('  ⚠ Telegram: make sure @NansenBot is a member of your chat.');
            log('  If not added, alerts cannot be delivered.');
            log('  Run: nansen alert --help  for setup instructions.');
          }

          return { type: 'alert-created', data: result };
        } catch (err) {
          errorOutput(`Error creating alert: ${err.message}`);
          if (err.code === ErrorCode.UNAUTHORIZED || err.status === 401 || err.status === 403) {
            errorOutput('  Check your API key: nansen login --api-key <key>');
          }
          return { type: 'error', error: err.message };
        }
      }

      // ── list ───────────────────────────────────────────────────────────
      if (sub === 'list') {
        try {
          const result = await alertRequest(api, 'GET', '/list');
          const alerts = result?.data || result || [];
          if (!Array.isArray(alerts) || !alerts.length) {
            log('No alerts found.');
            log('Create one: nansen alert create --help');
            return { type: 'alert-list', data: [] };
          }
          log(alertsTable(alerts));
          return { type: 'alert-list', data: alerts };
        } catch (err) {
          errorOutput(`Error listing alerts: ${err.message}`);
          return { type: 'error', error: err.message };
        }
      }

      // ── delete ─────────────────────────────────────────────────────────
      if (sub === 'delete') {
        const id = args[1];
        if (!id) {
          errorOutput('Usage: nansen alert delete <id>');
          return { type: 'error', error: 'missing id' };
        }
        try {
          await alertRequest(api, 'DELETE', `/${id}`);
          log(`✓ Alert deleted: ${id}`);
          return { type: 'alert-deleted', id };
        } catch (err) {
          errorOutput(`Error deleting alert ${id}: ${err.message}`);
          return { type: 'error', error: err.message };
        }
      }

      // ── toggle ─────────────────────────────────────────────────────────
      if (sub === 'toggle') {
        const id = args[1];
        if (!id) {
          errorOutput('Usage: nansen alert toggle <id> --enable | --disable');
          return { type: 'error', error: 'missing id' };
        }
        if (!flags.enable && !flags.disable) {
          errorOutput('Specify --enable or --disable');
          return { type: 'error', error: 'missing --enable/--disable' };
        }
        const isEnabled = !!flags.enable;
        try {
          await alertRequest(api, 'PATCH', '/toggle', { id, isEnabled });
          log(`✓ Alert ${id} ${isEnabled ? 'enabled' : 'disabled'}`);
          return { type: 'alert-toggled', id, isEnabled };
        } catch (err) {
          errorOutput(`Error toggling alert ${id}: ${err.message}`);
          return { type: 'error', error: err.message };
        }
      }

      errorOutput(`Unknown subcommand: "${sub}"`);
      errorOutput('Available: create, list, delete, toggle');
      errorOutput('Run: nansen alert --help');
      return { type: 'error', error: `unknown subcommand: ${sub}` };
    },
  };
}
