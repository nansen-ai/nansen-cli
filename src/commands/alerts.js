/**
 * Nansen CLI - Alerts command
 * Smart alert CRUD with type-specific named flags.
 */

import { NansenError, ErrorCode } from '../api.js';

// ============= Formatting =============

// Format alerts list as human-readable table
export function formatAlertsTable(alerts) {
  if (!Array.isArray(alerts) || alerts.length === 0) {
    return 'No alerts';
  }

  const formatChannels = (channels) => {
    if (!channels || !Array.isArray(channels) || channels.length === 0) return '';
    return channels.map(ch => ch.type).join(', ');
  };

  const formatEnabled = (isEnabled) => isEnabled ? '✓' : '✗';

  const truncate = (str, maxLen) => {
    if (!str) return '';
    return str.length > maxLen ? str.slice(0, maxLen - 1) + '…' : str;
  };

  const idWidth = Math.max(2, Math.max(...alerts.map(a => (a.id || '').length)));
  const nameWidth = Math.max(4, Math.min(30, Math.max(...alerts.map(a => (a.name || '').length))));
  const typeWidth = Math.max(4, Math.min(25, Math.max(...alerts.map(a => (a.type || '').length))));
  const channelsWidth = Math.max(8, Math.min(20, Math.max(...alerts.map(a => formatChannels(a.channels).length))));

  const lines = [];
  const header = `${'ID'.padEnd(idWidth)} │ ${'NAME'.padEnd(nameWidth)} │ ${'TYPE'.padEnd(typeWidth)} │ ${'ENABLED'.padEnd(7)} │ ${'CHANNELS'.padEnd(channelsWidth)}`;
  lines.push(header);
  lines.push('─'.repeat(idWidth) + '─┼─' + '─'.repeat(nameWidth) + '─┼─' + '─'.repeat(typeWidth) + '─┼─' + '─'.repeat(7) + '─┼─' + '─'.repeat(channelsWidth));

  for (const alert of alerts) {
    const id = (alert.id || '').padEnd(idWidth);
    const name = truncate(alert.name, nameWidth).padEnd(nameWidth);
    const type = truncate(alert.type, typeWidth).padEnd(typeWidth);
    const enabled = formatEnabled(alert.isEnabled).padEnd(7);
    const channels = truncate(formatChannels(alert.channels), channelsWidth).padEnd(channelsWidth);
    lines.push(`${id} │ ${name} │ ${type} │ ${enabled} │ ${channels}`);
  }

  return lines.join('\n');
}

// ============= Data Builders =============

/**
 * Parse a token string "address:chain" into { address, chain }.
 * Handles single string or array of strings (from repeated --token flags).
 */
function parseTokens(tokenArg) {
  if (!tokenArg) return undefined;
  const tokens = Array.isArray(tokenArg) ? tokenArg : [tokenArg];
  return tokens.map(t => {
    const colonIdx = t.lastIndexOf(':');
    if (colonIdx === -1) throw new NansenError(`Invalid token format: "${t}". Expected address:chain`, ErrorCode.INVALID_PARAM);
    return { address: t.slice(0, colonIdx), chain: t.slice(colonIdx + 1) };
  });
}

/**
 * Parse a subject string "type:value" into { type, value }.
 * Handles single string or array (from repeated --subject flags).
 */
function parseSubjects(subjectArg) {
  if (!subjectArg) return undefined;
  const subjects = Array.isArray(subjectArg) ? subjectArg : [subjectArg];
  return subjects.map(s => {
    const colonIdx = s.indexOf(':');
    if (colonIdx === -1) throw new NansenError(`Invalid subject format: "${s}". Expected type:value`, ErrorCode.INVALID_PARAM);
    return { type: s.slice(0, colonIdx), value: s.slice(colonIdx + 1) };
  });
}

/**
 * Normalise chains option to array.
 */
function parseChains(chainsOpt) {
  if (!chainsOpt) return undefined;
  if (Array.isArray(chainsOpt)) return chainsOpt;
  return chainsOpt.split(',');
}

/**
 * Build a { min, max } range object from two option values.
 * Returns undefined if neither is provided.
 */
function buildRange(minVal, maxVal) {
  if (minVal === undefined && maxVal === undefined) return undefined;
  return {
    min: minVal !== undefined ? Number(minVal) : null,
    max: maxVal !== undefined ? Number(maxVal) : null,
  };
}

/**
 * Build the data payload for sm-token-flows alerts from named flags.
 */
export function buildSmTokenFlowsData(options) {
  const data = {};

  const chains = parseChains(options.chains);
  if (chains) data.chains = chains;

  const flowFields = ['inflow-1h', 'inflow-1d', 'inflow-7d', 'outflow-1h', 'outflow-1d', 'outflow-7d'];
  for (const field of flowFields) {
    const range = buildRange(options[`${field}-min`], options[`${field}-max`]);
    if (range) {
      // Convert CLI key "inflow-1h" → data key "inflow_1h"
      data[field.replace(/-/g, '_')] = range;
    }
  }

  const tokens = parseTokens(options.token);
  const excludeTokens = parseTokens(options['exclude-token']);
  if (tokens) data.inclusion = { tokens };
  if (excludeTokens) data.exclusion = { tokens: excludeTokens };

  return data;
}

/**
 * Build the data payload for common-token-transfer alerts from named flags.
 */
export function buildCommonTokenTransferData(options) {
  const data = {};

  const chains = parseChains(options.chains);
  if (chains) data.chains = chains;

  if (options.events) {
    data.events = typeof options.events === 'string' ? options.events.split(',') : options.events;
  }

  const usdRange = buildRange(options['usd-min'], options['usd-max']);
  if (usdRange) data.usdValue = usdRange;

  const amountRange = buildRange(options['token-amount-min'], options['token-amount-max']);
  if (amountRange) data.tokenAmount = amountRange;

  const subjects = parseSubjects(options.subject);
  if (subjects) data.subjects = subjects;

  const tokens = parseTokens(options.token);
  const excludeTokens = parseTokens(options['exclude-token']);
  if (tokens) data.inclusion = { tokens };
  if (excludeTokens) data.exclusion = { tokens: excludeTokens };

  return data;
}

/**
 * Build the alert data payload from named flags, dispatching on type.
 * --data '<json>' is merged on top as an escape-hatch override.
 */
export function buildAlertData(options) {
  let data;

  if (options.type === 'sm-token-flows') {
    data = buildSmTokenFlowsData(options);
  } else if (options.type === 'common-token-transfer') {
    data = buildCommonTokenTransferData(options);
  } else {
    // Unknown / no type — minimal fallback: just handle chains
    data = {};
    const chains = parseChains(options.chains);
    if (chains) data.chains = chains;
  }

  // Merge --data on top (power-user escape hatch, overrides named flags)
  if (options.data) {
    let override;
    if (typeof options.data === 'string') {
      try {
        override = JSON.parse(options.data);
      } catch {
        throw new NansenError('--data must be valid JSON', ErrorCode.INVALID_PARAM);
      }
    } else {
      override = options.data;
    }
    data = { ...data, ...override };
  }

  return data;
}

// ============= Command Builder =============

export function buildAlertsCommands(deps = {}) {
  const { log = console.log } = deps;

  return {
    'alerts': async (args, apiInstance, flags, options) => {
      const sub = args[0];
      if (!sub || sub === 'help' || flags.help || flags.h) {
        log(`nansen alerts — Smart alert management

SUBCOMMANDS:
  list        List all alerts
  create      Create a new alert
  update      Update an existing alert
  toggle      Enable or disable an alert
  delete      Delete an alert

USAGE:
  nansen alerts list
  nansen alerts create --name <name> --type <type> --time-window <window> --chains <chains> --telegram <chatId>
  nansen alerts update <id> [--name <name>] [--chains <chains>]
  nansen alerts toggle <id> --enabled
  nansen alerts toggle <id> --disabled
  nansen alerts delete <id>

OPTIONS (all types):
  --chains <chains>            Comma-separated chains (e.g. ethereum,solana).
  --token <address:chain>      Filter by token (repeatable). Adds to inclusion list.
  --exclude-token <addr:chain> Exclude token (repeatable). Adds to exclusion list.
  --telegram <chatId>          Send to Telegram chat.
  --slack <webhookUrl>         Send to Slack webhook.
  --discord <webhookUrl>       Send to Discord webhook. Combine multiple channel flags.
  --description '<text>'       Alert description.

OPTIONS (sm-token-flows):
  --inflow-1h-min <usd>   --inflow-1h-max <usd>
  --inflow-1d-min <usd>   --inflow-1d-max <usd>
  --inflow-7d-min <usd>   --inflow-7d-max <usd>
  --outflow-1h-min <usd>  --outflow-1h-max <usd>
  --outflow-1d-min <usd>  --outflow-1d-max <usd>
  --outflow-7d-min <usd>  --outflow-7d-max <usd>

OPTIONS (common-token-transfer):
  --events <buy,sell,swap,send,receive>   Comma-separated event types.
  --usd-min <usd>          --usd-max <usd>
  --token-amount-min <n>   --token-amount-max <n>
  --subject <type:value>   Filter by subject (repeatable, e.g. label:"Centralized Exchange").

EXAMPLES:
  nansen alerts list --table
  nansen alerts create --name 'ETH SM Inflow' --type sm-token-flows --time-window 1h --chains ethereum --telegram 5238612255 --inflow-1h-min 1000000
  nansen alerts create --name 'USDC Transfers' --type common-token-transfer --time-window 1h --chains ethereum --telegram 5238612255 --events send,receive --usd-min 1000000 --subject label:"Centralized Exchange"
  nansen alerts toggle abc123 --disabled
  nansen alerts delete abc123

Advanced: use --data '<json>' to pass the full alert config directly (merged on top of any named flags).`);
        return;
      }

      // Build channels array from --telegram/--slack/--discord flags
      function buildChannels() {
        const channels = [];
        if (options.telegram) channels.push({ type: 'telegram', data: { chatId: String(options.telegram) } });
        if (options.slack) channels.push({ type: 'slack', data: { webhookUrl: options.slack } });
        if (options.discord) channels.push({ type: 'discord', data: { webhookUrl: options.discord } });
        return channels.length > 0 ? channels : null;
      }

      const handlers = {
        'list': () => apiInstance.alertsList(),
        'create': () => {
          const name = options.name;
          const type = options.type;
          const timeWindow = options['time-window'];
          const channels = buildChannels();
          const data = buildAlertData(options);
          const missing = [];
          if (!name) missing.push('--name');
          if (!type) missing.push('--type');
          if (!timeWindow) missing.push('--time-window');
          if (!channels) missing.push('a channel (--telegram, --slack, or --discord)');
          if (missing.length > 0) {
            throw new NansenError(`Required: ${missing.join(', ')}`, ErrorCode.MISSING_PARAM);
          }
          return apiInstance.alertsCreate({
            name,
            type,
            timeWindow,
            channels,
            data,
            ...(options.description ? { description: options.description } : {}),
            isEnabled: !flags.disabled,
          });
        },
        'update': () => {
          const id = args[1];
          if (!id) throw new NansenError('Required: <id>', ErrorCode.MISSING_PARAM);
          const params = { id };
          if (options.name) params.name = options.name;
          if (options.type) params.type = options.type;
          if (options['time-window']) params.timeWindow = options['time-window'];
          const channels = buildChannels();
          if (channels) params.channels = channels;
          const data = buildAlertData(options);
          if (Object.keys(data).length > 0) params.data = data;
          if (options.description) params.description = options.description;
          if (flags.enabled) params.isEnabled = true;
          if (flags.disabled) params.isEnabled = false;
          return apiInstance.alertsUpdate(params);
        },
        'toggle': () => {
          const id = args[1];
          if (!id) throw new NansenError('Required: <id>', ErrorCode.MISSING_PARAM);
          const isEnabled = flags.enabled ? true : flags.disabled ? false : undefined;
          if (isEnabled === undefined) throw new NansenError('Required: --enabled or --disabled', ErrorCode.MISSING_PARAM);
          return apiInstance.alertsToggle({ id, isEnabled });
        },
        'delete': () => {
          const id = args[1];
          if (!id) throw new NansenError('Required: <id>', ErrorCode.MISSING_PARAM);
          return apiInstance.alertsDelete(id);
        },
      };

      if (!handlers[sub]) {
        throw new NansenError(`Unknown alerts subcommand: ${sub}. Available: list, create, update, toggle, delete`, ErrorCode.UNKNOWN);
      }
      return handlers[sub]();
    },
  };
}
