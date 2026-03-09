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
 * Normalise a repeatable string option to array, or undefined if absent.
 */
function normArray(val) {
  if (!val) return undefined;
  return Array.isArray(val) ? val : [val];
}

/**
 * Build the data payload for sm-token-flows alerts from named flags.
 */
export function buildSmTokenFlowsData(options) {
  const data = {};

  const chains = parseChains(options.chains);
  if (chains) data.chains = chains;

  const flowFields = ['inflow-1h', 'inflow-1d', 'inflow-7d', 'outflow-1h', 'outflow-1d', 'outflow-7d', 'netflow-1h', 'netflow-1d', 'netflow-7d'];
  for (const field of flowFields) {
    const range = buildRange(options[`${field}-min`], options[`${field}-max`]);
    if (range) {
      // Convert CLI key "inflow-1h" → data key "inflow_1h"
      data[field.replace(/-/g, '_')] = range;
    }
  }

  const tokens = parseTokens(options.token);
  const excludeTokens = parseTokens(options['exclude-token']);
  if (tokens) data.inclusion = { ...data.inclusion, tokens };
  if (excludeTokens) data.exclusion = { ...data.exclusion, tokens: excludeTokens };

  const sectors = normArray(options['token-sector']);
  if (sectors) data.inclusion = { ...data.inclusion, tokenSectors: sectors };
  const excludeSectors = normArray(options['exclude-token-sector']);
  if (excludeSectors) data.exclusion = { ...data.exclusion, tokenSectors: excludeSectors };

  if (options['token-age-max'] !== undefined) {
    data.inclusion = { ...data.inclusion, tokenAge: { max: Number(options['token-age-max']) } };
  }

  const marketCapRange = buildRange(options['market-cap-min'], options['market-cap-max']);
  if (marketCapRange) data.inclusion = { ...data.inclusion, marketCap: marketCapRange };

  const fdvRange = buildRange(options['fdv-min'], options['fdv-max']);
  if (fdvRange) data.inclusion = { ...data.inclusion, fdvUsd: fdvRange };

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

  const counterparties = parseSubjects(options.counterparty);
  if (counterparties) data.counterparties = counterparties;

  const tokens = parseTokens(options.token);
  const excludeTokens = parseTokens(options['exclude-token']);
  if (tokens) data.inclusion = { ...data.inclusion, tokens };
  if (excludeTokens) data.exclusion = { ...data.exclusion, tokens: excludeTokens };

  const sectors = normArray(options['token-sector']);
  if (sectors) data.inclusion = { ...data.inclusion, tokenSectors: sectors };
  const excludeSectors = normArray(options['exclude-token-sector']);
  if (excludeSectors) data.exclusion = { ...data.exclusion, tokenSectors: excludeSectors };

  const tokenAgeMin = options['token-age-min'];
  const tokenAgeMax = options['token-age-max'];
  if (tokenAgeMin !== undefined || tokenAgeMax !== undefined) {
    const tokenAge = {};
    if (tokenAgeMin !== undefined) tokenAge.min = Number(tokenAgeMin);
    if (tokenAgeMax !== undefined) tokenAge.max = Number(tokenAgeMax);
    data.inclusion = { ...data.inclusion, tokenAge };
  }

  const marketCapRange = buildRange(options['market-cap-min'], options['market-cap-max']);
  if (marketCapRange) data.inclusion = { ...data.inclusion, marketCap: marketCapRange };

  const excludeFrom = parseSubjects(options['exclude-from']);
  if (excludeFrom) data.exclusion = { ...data.exclusion, fromTargets: excludeFrom };
  const excludeTo = parseSubjects(options['exclude-to']);
  if (excludeTo) data.exclusion = { ...data.exclusion, toTargets: excludeTo };

  return data;
}

/**
 * Build the data payload for smart-contract-call alerts from named flags.
 */
export function buildSmartContractCallData(options) {
  const data = {};

  const chains = parseChains(options.chains);
  if (chains) data.chains = chains;

  const usdRange = buildRange(options['usd-min'], options['usd-max']);
  if (usdRange) data.usdValue = usdRange;

  if (options['signature-hash']) {
    data.signatureHash = Array.isArray(options['signature-hash'])
      ? options['signature-hash']
      : [options['signature-hash']];
  }

  const callers = parseSubjects(options.caller);
  const contracts = parseSubjects(options.contract);
  const excludeCallers = parseSubjects(options['exclude-caller']);
  const excludeContracts = parseSubjects(options['exclude-contract']);

  if (callers) data.inclusion = { ...data.inclusion, caller: callers };
  if (contracts) data.inclusion = { ...data.inclusion, smartContract: contracts };
  if (excludeCallers) data.exclusion = { ...data.exclusion, caller: excludeCallers };
  if (excludeContracts) data.exclusion = { ...data.exclusion, smartContract: excludeContracts };

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
  } else if (options.type === 'smart-contract-call') {
    data = buildSmartContractCallData(options);
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

const TIME_WINDOW_BY_TYPE = {
  'common-token-transfer': 'realtime',
  'smart-contract-call': 'realtime',
  'sm-token-flows': '1h',
};

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
  nansen alerts list [--type sm-token-flows] [--enabled] [--disabled] [--token-address <addr>] [--chain <chain>] [--limit <n>] [--offset <n>]
  nansen alerts create --name <name> --type <type> --chains <chains> --telegram <chatId>
  nansen alerts update <id> [--name <name>] [--chains <chains>]
  nansen alerts toggle <id> --enabled
  nansen alerts toggle <id> --disabled
  nansen alerts delete <id>

SUBJECT TYPES:
  address, entity, label, custom-label
  Example: --subject address:0xabc  --subject label:"Centralized Exchange"

  Chain aliases: For Hyperliquid use hyperevm, for BSC use bnb.

OPTIONS (all types):
  --chains <chains>            Comma-separated chains (e.g. ethereum,solana).
  --token <address:chain>      Filter by token (repeatable). Adds to inclusion list.
  --exclude-token <addr:chain> Exclude token (repeatable). Adds to exclusion list.
  --telegram <chatId>          Send to Telegram chat.
  --slack <webhookUrl>         Send to Slack webhook.
  --discord <webhookUrl>       Send to Discord webhook. Combine multiple channel flags.
  --description '<text>'       Alert description.

OPTIONS (sm-token-flows):
  --inflow-1h-min <usd>    --inflow-1h-max <usd>
  --inflow-1d-min <usd>    --inflow-1d-max <usd>
  --inflow-7d-min <usd>    --inflow-7d-max <usd>
  --outflow-1h-min <usd>   --outflow-1h-max <usd>
  --outflow-1d-min <usd>   --outflow-1d-max <usd>
  --outflow-7d-min <usd>   --outflow-7d-max <usd>
  --netflow-1h-min <usd>   --netflow-1h-max <usd>
  --netflow-1d-min <usd>   --netflow-1d-max <usd>
  --netflow-7d-min <usd>   --netflow-7d-max <usd>
  --token-sector <name>        Filter by token sector (repeatable).
  --exclude-token-sector <name> Exclude token sector (repeatable).
  --token-age-max <days>       Maximum token age in days.
  --market-cap-min <usd>       --market-cap-max <usd>
  --fdv-min <usd>              --fdv-max <usd>

OPTIONS (common-token-transfer):
  --events <buy,sell,swap,send,receive>   Comma-separated event types.
  --usd-min <usd>              --usd-max <usd>
  --token-amount-min <n>       --token-amount-max <n>
  --subject <type:value>       Filter by subject (repeatable, e.g. label:"Centralized Exchange").
  --counterparty <type:value>  Filter by counterparty (repeatable, same format as --subject).
  --token-sector <name>        Filter by token sector (repeatable).
  --exclude-token-sector <name> Exclude token sector (repeatable).
  --token-age-min <days>       --token-age-max <days>
  --market-cap-min <usd>       --market-cap-max <usd>
  --exclude-from <type:value>  Exclude by sender (repeatable).
  --exclude-to <type:value>    Exclude by recipient (repeatable).

OPTIONS (smart-contract-call):
  --usd-min <usd>              --usd-max <usd>
  --signature-hash <hash>      Function signature hash (repeatable).
  --caller <type:value>        Include callers (repeatable).
  --contract <type:value>      Include smart contracts (repeatable).
  --exclude-caller <type:value>    Exclude callers (repeatable).
  --exclude-contract <type:value>  Exclude contracts (repeatable).

EXAMPLES:
  nansen alerts list --table
  nansen alerts list --type sm-token-flows --enabled
  nansen alerts create --name 'ETH SM Inflow' --type sm-token-flows --chains ethereum --telegram 5238612255 --inflow-1h-min 1000000
  nansen alerts create --name 'USDC Transfers' --type common-token-transfer --chains ethereum --telegram 5238612255 --events send,receive --usd-min 1000000 --subject label:"Centralized Exchange"
  nansen alerts create --name 'Contract Calls' --type smart-contract-call --chains ethereum --telegram 5238612255 --signature-hash 0xa9059cbb --caller address:0xabc
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
        'list': async () => {
          const params = {};
          if (options.type) params.type = options.type;
          if (options['token-address']) params.tokenAddress = options['token-address'];
          if (options.chain) params.chain = options.chain;
          if (options.limit) params.limit = Number(options.limit);
          if (options.offset) params.offset = Number(options.offset);
          if (flags.enabled) params.isEnabled = true;
          if (flags.disabled) params.isEnabled = false;

          let results = await apiInstance.alertsList(params);
          // Normalise to array
          if (!Array.isArray(results)) results = results?.alerts ?? results?.data ?? [];

          // Client-side filters (defensive — backend may or may not support them)
          if (params.type) results = results.filter(a => a.type === params.type);
          if (params.isEnabled !== undefined) results = results.filter(a => a.isEnabled === params.isEnabled);
          if (params.tokenAddress) {
            const addr = params.tokenAddress.toLowerCase();
            results = results.filter(a => {
              const tokens = [...(a.data?.inclusion?.tokens ?? []), ...(a.data?.exclusion?.tokens ?? [])];
              return tokens.some(t => t.address?.toLowerCase() === addr);
            });
          }
          if (params.chain) {
            const chain = params.chain.toLowerCase();
            results = results.filter(a => (a.data?.chains ?? []).some(c => c.toLowerCase() === chain));
          }
          const offset = params.offset ?? 0;
          const limit = params.limit;
          results = results.slice(offset, limit != null ? offset + limit : undefined);
          return results;
        },
        'create': () => {
          const name = options.name;
          const type = options.type;
          const timeWindow = TIME_WINDOW_BY_TYPE[type] ?? 'realtime';
          const channels = buildChannels();
          const data = buildAlertData(options);
          const missing = [];
          if (!name) missing.push('--name');
          if (!type) missing.push('--type');
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
          if (options.type) {
            params.type = options.type;
            params.timeWindow = TIME_WINDOW_BY_TYPE[options.type] ?? 'realtime';
          }
          const channels = buildChannels();
          if (channels) params.channels = channels;
          const data = buildAlertData(options);
          if (Object.keys(data).length > 0) params.data = data;
          if (options.description) params.description = options.description;
          if (flags.enabled && flags.disabled) throw new NansenError('Cannot specify both --enabled and --disabled', ErrorCode.INVALID_PARAM);
          if (flags.enabled) params.isEnabled = true;
          if (flags.disabled) params.isEnabled = false;
          return apiInstance.alertsUpdate(params);
        },
        'toggle': () => {
          const id = args[1];
          if (!id) throw new NansenError('Required: <id>', ErrorCode.MISSING_PARAM);
          if (flags.enabled && flags.disabled) throw new NansenError('Cannot specify both --enabled and --disabled', ErrorCode.INVALID_PARAM);
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
