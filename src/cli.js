/**
 * Nansen CLI - Core logic (testable)
 * Extracted from index.js for coverage
 */

import { NansenAPI, saveConfig, deleteConfig, getConfigFile, clearCache, getCacheDir } from './api.js';
import * as readline from 'readline';

// ============= Schema Definition =============

export const SCHEMA = {
  version: '1.1.0',
  commands: {
    'smart-money': {
      description: 'Smart Money analytics - track sophisticated market participants',
      subcommands: {
        'netflow': {
          description: 'Net capital flows (inflows vs outflows)',
          options: {
            chain: { type: 'string', default: 'solana', description: 'Blockchain to query' },
            chains: { type: 'array', description: 'Multiple chains as JSON array' },
            limit: { type: 'number', description: 'Number of results' },
            labels: { type: 'string|array', description: 'Smart Money label filter' },
            sort: { type: 'string', description: 'Sort field:direction (e.g., value_usd:desc)' },
            filters: { type: 'object', description: 'Additional filters as JSON' }
          },
          returns: ['token_address', 'token_symbol', 'token_name', 'chain', 'inflow_usd', 'outflow_usd', 'net_flow_usd']
        },
        'dex-trades': {
          description: 'Real-time DEX trading activity',
          options: {
            chain: { type: 'string', default: 'solana' },
            chains: { type: 'array' },
            limit: { type: 'number' },
            labels: { type: 'string|array' },
            sort: { type: 'string' },
            filters: { type: 'object' }
          },
          returns: ['tx_hash', 'wallet_address', 'token_address', 'token_symbol', 'side', 'amount', 'value_usd', 'timestamp']
        },
        'perp-trades': {
          description: 'Perpetual trading on Hyperliquid',
          options: { limit: { type: 'number' }, sort: { type: 'string' }, filters: { type: 'object' } },
          returns: ['wallet_address', 'symbol', 'side', 'size', 'price', 'value_usd', 'pnl_usd', 'timestamp']
        },
        'holdings': {
          description: 'Aggregated token balances',
          options: { chain: { type: 'string', default: 'solana' }, chains: { type: 'array' }, limit: { type: 'number' }, labels: { type: 'string|array' } },
          returns: ['token_address', 'token_symbol', 'chain', 'balance', 'balance_usd', 'holder_count']
        },
        'dcas': {
          description: 'DCA strategies on Jupiter',
          options: { limit: { type: 'number' }, filters: { type: 'object' } },
          returns: ['wallet_address', 'input_token', 'output_token', 'total_input', 'total_output', 'avg_price']
        },
        'historical-holdings': {
          description: 'Historical holdings over time',
          options: { chain: { type: 'string', default: 'solana' }, chains: { type: 'array' }, days: { type: 'number', default: 30 }, limit: { type: 'number' } },
          returns: ['date', 'token_address', 'token_symbol', 'balance', 'balance_usd']
        }
      }
    },
    'profiler': {
      description: 'Wallet profiling - detailed information about any blockchain address',
      subcommands: {
        'balance': {
          description: 'Current token holdings',
          options: {
            address: { type: 'string', required: true, description: 'Wallet address to query' },
            chain: { type: 'string', default: 'ethereum' },
            entity: { type: 'string', description: 'Entity name instead of address' }
          },
          returns: ['token_address', 'token_symbol', 'token_name', 'balance', 'balance_usd', 'price_usd']
        },
        'labels': {
          description: 'Behavioral and entity labels',
          options: { address: { type: 'string', required: true }, chain: { type: 'string', default: 'ethereum' } },
          returns: ['label', 'label_type', 'label_subtype']
        },
        'transactions': {
          description: 'Transaction history',
          options: { address: { type: 'string', required: true }, chain: { type: 'string', default: 'ethereum' }, limit: { type: 'number' }, days: { type: 'number', default: 30 } },
          returns: ['tx_hash', 'block_number', 'timestamp', 'from', 'to', 'value', 'value_usd', 'method']
        },
        'pnl': {
          description: 'PnL and trade performance',
          options: { address: { type: 'string', required: true }, chain: { type: 'string', default: 'ethereum' } },
          returns: ['token_address', 'token_symbol', 'realized_pnl_usd', 'unrealized_pnl_usd', 'total_pnl_usd']
        },
        'search': {
          description: 'Search for entities by name',
          options: { query: { type: 'string', required: true, description: 'Search query' }, limit: { type: 'number' } },
          returns: ['entity_name', 'address', 'chain', 'labels']
        },
        'historical-balances': {
          description: 'Historical balances over time',
          options: { address: { type: 'string', required: true }, chain: { type: 'string', default: 'ethereum' }, days: { type: 'number', default: 30 } },
          returns: ['date', 'token_address', 'token_symbol', 'balance', 'balance_usd']
        },
        'related-wallets': {
          description: 'Find wallets related to an address',
          options: { address: { type: 'string', required: true }, chain: { type: 'string', default: 'ethereum' }, limit: { type: 'number' } },
          returns: ['address', 'relationship', 'transaction_count', 'volume_usd']
        },
        'counterparties': {
          description: 'Top counterparties by volume',
          options: { address: { type: 'string', required: true }, chain: { type: 'string', default: 'ethereum' }, days: { type: 'number', default: 30 } },
          returns: ['counterparty_address', 'counterparty_label', 'transaction_count', 'volume_usd']
        },
        'pnl-summary': {
          description: 'Summarized PnL metrics',
          options: { address: { type: 'string', required: true }, chain: { type: 'string', default: 'ethereum' }, days: { type: 'number', default: 30 } },
          returns: ['total_realized_pnl', 'total_unrealized_pnl', 'win_rate', 'total_trades']
        },
        'perp-positions': {
          description: 'Current perpetual positions',
          options: { address: { type: 'string', required: true }, limit: { type: 'number' } },
          returns: ['symbol', 'side', 'size', 'entry_price', 'mark_price', 'unrealized_pnl', 'leverage']
        },
        'perp-trades': {
          description: 'Perpetual trading history',
          options: { address: { type: 'string', required: true }, days: { type: 'number', default: 30 }, limit: { type: 'number' } },
          returns: ['symbol', 'side', 'size', 'price', 'value_usd', 'pnl_usd', 'timestamp']
        }
      }
    },
    'token': {
      description: 'Token God Mode - deep analytics for any token',
      subcommands: {
        'screener': {
          description: 'Discover and filter tokens',
          options: {
            chain: { type: 'string', default: 'solana' },
            chains: { type: 'array' },
            timeframe: { type: 'string', default: '24h', enum: ['5m', '10m', '1h', '6h', '24h', '7d', '30d'] },
            'smart-money': { type: 'boolean', description: 'Filter for Smart Money only' },
            limit: { type: 'number' },
            sort: { type: 'string' }
          },
          returns: ['token_address', 'token_symbol', 'token_name', 'chain', 'price_usd', 'volume_usd', 'market_cap', 'holder_count', 'smart_money_holders']
        },
        'holders': {
          description: 'Token holder analysis',
          options: { token: { type: 'string', required: true }, chain: { type: 'string', default: 'solana' }, 'smart-money': { type: 'boolean' }, limit: { type: 'number' } },
          returns: ['wallet_address', 'balance', 'balance_usd', 'pct_supply', 'labels']
        },
        'flows': {
          description: 'Token flow metrics',
          options: { token: { type: 'string', required: true }, chain: { type: 'string', default: 'solana' }, limit: { type: 'number' } },
          returns: ['label', 'inflow', 'outflow', 'net_flow', 'wallet_count']
        },
        'dex-trades': {
          description: 'DEX trading activity',
          options: { token: { type: 'string', required: true }, chain: { type: 'string', default: 'solana' }, 'smart-money': { type: 'boolean' }, days: { type: 'number', default: 30 }, limit: { type: 'number' } },
          returns: ['tx_hash', 'wallet_address', 'side', 'amount', 'price_usd', 'value_usd', 'timestamp']
        },
        'pnl': {
          description: 'PnL leaderboard',
          options: { token: { type: 'string', required: true }, chain: { type: 'string', default: 'solana' }, days: { type: 'number', default: 30 }, limit: { type: 'number' }, sort: { type: 'string' } },
          returns: ['wallet_address', 'realized_pnl_usd', 'unrealized_pnl_usd', 'total_pnl_usd', 'labels']
        },
        'who-bought-sold': {
          description: 'Recent buyers and sellers',
          options: { token: { type: 'string', required: true }, chain: { type: 'string', default: 'solana' }, limit: { type: 'number' } },
          returns: ['wallet_address', 'side', 'amount', 'value_usd', 'timestamp', 'labels']
        },
        'flow-intelligence': {
          description: 'Detailed flow intelligence by label',
          options: { token: { type: 'string', required: true }, chain: { type: 'string', default: 'solana' }, limit: { type: 'number' } },
          returns: ['label', 'inflow_usd', 'outflow_usd', 'net_flow_usd', 'unique_wallets']
        },
        'transfers': {
          description: 'Token transfer history',
          options: { token: { type: 'string', required: true }, chain: { type: 'string', default: 'solana' }, days: { type: 'number', default: 30 }, limit: { type: 'number' } },
          returns: ['tx_hash', 'from', 'to', 'amount', 'value_usd', 'timestamp']
        },
        'jup-dca': {
          description: 'Jupiter DCA orders for token',
          options: { token: { type: 'string', required: true }, limit: { type: 'number' } },
          returns: ['wallet_address', 'input_token', 'output_token', 'total_input', 'executed', 'remaining']
        },
        'perp-trades': {
          description: 'Perp trades by token symbol',
          options: { symbol: { type: 'string', required: true, description: 'Token symbol (e.g., BTC, ETH)' }, days: { type: 'number', default: 30 }, limit: { type: 'number' } },
          returns: ['wallet_address', 'side', 'size', 'price', 'value_usd', 'pnl_usd', 'timestamp']
        },
        'perp-positions': {
          description: 'Open perp positions by token symbol',
          options: { symbol: { type: 'string', required: true }, limit: { type: 'number' } },
          returns: ['wallet_address', 'side', 'size', 'entry_price', 'mark_price', 'unrealized_pnl', 'leverage']
        },
        'perp-pnl-leaderboard': {
          description: 'Perp PnL leaderboard by token',
          options: { symbol: { type: 'string', required: true }, days: { type: 'number', default: 30 }, limit: { type: 'number' } },
          returns: ['wallet_address', 'realized_pnl', 'unrealized_pnl', 'total_pnl', 'trade_count']
        }
      }
    },
    'portfolio': {
      description: 'Portfolio analytics',
      subcommands: {
        'defi': {
          description: 'DeFi holdings across protocols',
          options: { wallet: { type: 'string', required: true, description: 'Wallet address' } },
          returns: ['protocol', 'chain', 'position_type', 'token_symbol', 'balance', 'balance_usd']
        }
      }
    }
  },
  globalOptions: {
    pretty: { type: 'boolean', description: 'Format JSON output for readability' },
    table: { type: 'boolean', description: 'Format output as human-readable table' },
    fields: { type: 'string', description: 'Comma-separated list of fields to include in output' },
    'no-retry': { type: 'boolean', description: 'Disable automatic retry on rate limits/errors' },
    retries: { type: 'number', default: 3, description: 'Max retry attempts' }
  },
  chains: ['ethereum', 'solana', 'base', 'bnb', 'arbitrum', 'polygon', 'optimism', 'avalanche', 'linea', 'scroll', 'zksync', 'mantle', 'ronin', 'sei', 'plasma', 'sonic', 'unichain', 'monad', 'hyperevm', 'iotaevm'],
  smartMoneyLabels: ['Fund', 'Smart Trader', '30D Smart Trader', '90D Smart Trader', '180D Smart Trader', 'Smart HL Perps Trader']
};

// ============= Field Filtering =============

/**
 * Filter object to include only specified fields
 * Supports nested paths with dot notation (e.g., "data.results")
 */
export function filterFields(data, fields) {
  if (!fields || fields.length === 0) return data;
  
  const fieldSet = new Set(fields);
  
  function filterObject(obj) {
    if (obj === null || obj === undefined) return obj;
    if (Array.isArray(obj)) {
      return obj.map(item => filterObject(item));
    }
    if (typeof obj !== 'object') return obj;
    
    const filtered = {};
    for (const key of Object.keys(obj)) {
      if (fieldSet.has(key)) {
        filtered[key] = obj[key];
      } else if (typeof obj[key] === 'object' && obj[key] !== null) {
        // Recurse into nested objects/arrays
        const nested = filterObject(obj[key]);
        // Only include if it has content
        if (nested !== null && nested !== undefined) {
          if (Array.isArray(nested) && nested.length > 0) {
            filtered[key] = nested;
          } else if (!Array.isArray(nested) && Object.keys(nested).length > 0) {
            filtered[key] = nested;
          }
        }
      }
    }
    return filtered;
  }
  
  return filterObject(data);
}

/**
 * Parse comma-separated fields string
 */
export function parseFields(fieldsOption) {
  if (!fieldsOption) return null;
  return fieldsOption.split(',').map(f => f.trim()).filter(f => f.length > 0);
}

// Parse command line arguments
export function parseArgs(args) {
  const result = { _: [], flags: {}, options: {} };
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      
      if (key === 'pretty' || key === 'help' || key === 'table' || key === 'no-retry' || key === 'cache' || key === 'no-cache' || key === 'stream') {
        result.flags[key] = true;
      } else if (next && !next.startsWith('-')) {
        // Try to parse as JSON first
        try {
          result.options[key] = JSON.parse(next);
        } catch {
          result.options[key] = next;
        }
        i++;
      } else {
        result.flags[key] = true;
      }
    } else if (arg.startsWith('-')) {
      result.flags[arg.slice(1)] = true;
    } else {
      result._.push(arg);
    }
  }
  
  return result;
}

// Format a single value for table display
export function formatValue(val) {
  if (val === null || val === undefined) return '';
  if (typeof val === 'number') {
    if (Math.abs(val) >= 1000000) return (val / 1000000).toFixed(2) + 'M';
    if (Math.abs(val) >= 1000) return (val / 1000).toFixed(2) + 'K';
    if (Number.isInteger(val)) return val.toString();
    return val.toFixed(2);
  }
  if (typeof val === 'object') return JSON.stringify(val);
  return String(val);
}

// Table formatter for human-readable output
export function formatTable(data) {
  // Extract array of records from various response shapes
  let records = [];
  if (Array.isArray(data)) {
    records = data;
  } else if (data?.data && Array.isArray(data.data)) {
    records = data.data;
  } else if (data?.results && Array.isArray(data.results)) {
    records = data.results;
  } else if (data?.data?.results && Array.isArray(data.data.results)) {
    records = data.data.results;
  } else if (typeof data === 'object' && data !== null) {
    // Single object - convert to array
    records = [data];
  }

  if (records.length === 0) {
    return 'No data';
  }

  // Get columns from first record, prioritize common useful fields
  const priorityFields = ['token_symbol', 'token_name', 'symbol', 'name', 'address', 'label', 'chain', 'value_usd', 'amount', 'pnl_usd', 'price_usd', 'volume_usd', 'net_flow_usd', 'timestamp', 'block_timestamp'];
  const allKeys = [...new Set(records.flatMap(r => Object.keys(r)))];
  
  // Sort: priority fields first, then alphabetically
  const columns = allKeys.sort((a, b) => {
    const aIdx = priorityFields.indexOf(a);
    const bIdx = priorityFields.indexOf(b);
    if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
    if (aIdx !== -1) return -1;
    if (bIdx !== -1) return 1;
    return a.localeCompare(b);
  }).slice(0, 8); // Limit to 8 columns for readability

  // Calculate column widths
  const widths = columns.map(col => {
    const headerLen = col.length;
    const maxDataLen = Math.max(...records.map(r => {
      const val = formatValue(r[col]);
      return val.length;
    }));
    return Math.min(Math.max(headerLen, maxDataLen), 30); // Cap at 30 chars
  });

  // Build table
  const separator = '─';
  const lines = [];
  
  // Header
  const header = columns.map((col, i) => col.padEnd(widths[i])).join(' │ ');
  lines.push(header);
  lines.push(widths.map(w => separator.repeat(w)).join('─┼─'));
  
  // Rows
  for (const record of records.slice(0, 50)) { // Limit to 50 rows
    const row = columns.map((col, i) => {
      const val = formatValue(record[col]);
      return val.slice(0, widths[i]).padEnd(widths[i]);
    }).join(' │ ');
    lines.push(row);
  }

  if (records.length > 50) {
    lines.push(`... and ${records.length - 50} more rows`);
  }

  return lines.join('\n');
}

// Format output data (returns string, does not print)
export function formatOutput(data, { pretty = false, table = false } = {}) {
  if (table) {
    if (data.success === false) {
      return { type: 'error', text: `Error: ${data.error}` };
    } else {
      const tableData = data.data || data;
      return { type: 'table', text: formatTable(tableData) };
    }
  } else if (pretty) {
    return { type: 'json', text: JSON.stringify(data, null, 2) };
  } else {
    return { type: 'json', text: JSON.stringify(data) };
  }
}

// Format error data (returns object, does not exit)
export function formatError(error) {
  return {
    success: false,
    error: error.message,
    code: error.code || 'UNKNOWN',
    status: error.status || null,
    details: error.data || null
  };
}

/**
 * Format data as JSON lines (NDJSON) for streaming output
 * Each record is output as a separate JSON line
 */
export function formatStream(data) {
  // Extract array of records from various response shapes
  let records = [];
  if (Array.isArray(data)) {
    records = data;
  } else if (data?.data && Array.isArray(data.data)) {
    records = data.data;
  } else if (data?.results && Array.isArray(data.results)) {
    records = data.results;
  } else if (data?.data?.results && Array.isArray(data.data.results)) {
    records = data.data.results;
  } else if (typeof data === 'object' && data !== null) {
    // Single object - output as single line
    records = [data];
  }

  if (records.length === 0) {
    return '';
  }

  // Output each record as a separate JSON line
  return records.map(record => JSON.stringify(record)).join('\n');
}

// Parse simple sort syntax: "field:direction" or "field" (defaults to DESC)
export function parseSort(sortOption, orderByOption) {
  // If --order-by is provided, use it (full JSON control)
  if (orderByOption) return orderByOption;
  
  // If no --sort, return undefined
  if (!sortOption) return undefined;
  
  // Parse --sort field:direction or --sort field
  const parts = sortOption.split(':');
  const field = parts[0];
  const direction = (parts[1] || 'desc').toUpperCase();
  
  return [{ field, direction }];
}

// ASCII Art Banner
export const BANNER = `
 ███╗   ██╗ █████╗ ███╗   ██╗███████╗███████╗███╗   ██╗
 ████╗  ██║██╔══██╗████╗  ██║██╔════╝██╔════╝████╗  ██║
 ██╔██╗ ██║███████║██╔██╗ ██║███████╗█████╗  ██╔██╗ ██║
 ██║╚██╗██║██╔══██║██║╚██╗██║╚════██║██╔══╝  ██║╚██╗██║
 ██║ ╚████║██║  ██║██║ ╚████║███████║███████╗██║ ╚████║
 ╚═╝  ╚═══╝╚═╝  ╚═╝╚═╝  ╚═══╝╚══════╝╚══════╝╚═╝  ╚═══╝
                   Surface The Signal
`;

// Help text
export const HELP = `
Nansen CLI - Command-line interface for Nansen API
Designed for AI agents with structured JSON output.

USAGE:
  nansen <command> [subcommand] [options]

COMMANDS:
  login          Save your API key (interactive)
  logout         Remove saved API key
  schema         Output JSON schema for all commands (for agent introspection)
  cache          Cache management (clear)
  smart-money    Smart Money analytics (netflow, dex-trades, holdings, dcas, historical-holdings)
  profiler       Wallet profiling (balance, labels, transactions, pnl, perp-positions, perp-trades)
  token          Token God Mode (screener, holders, flows, trades, pnl, perp-trades, perp-positions)
  portfolio      Portfolio analytics (defi-holdings)
  help           Show this help message

GLOBAL OPTIONS:
  --pretty       Format JSON output for readability
  --table        Format output as human-readable table
  --fields       Comma-separated list of fields to include (e.g., --fields address,value_usd)
  --chain        Blockchain to query (ethereum, solana, base, etc.)
  --chains       Multiple chains as JSON array
  --limit        Number of results (shorthand for pagination)
  --filters      JSON object with filters
  --sort         Sort by field (e.g., --sort value_usd:desc)
  --order-by     JSON array with sort order (advanced)
  --days         Date range in days (default: 30 for most endpoints)
  --symbol       Token symbol (for perp endpoints)
  --no-retry     Disable automatic retry on rate limits/errors
  --retries <n>  Max retry attempts (default: 3)
  --cache        Enable response caching (default: off)
  --no-cache     Disable cache for this request
  --cache-ttl <s> Cache TTL in seconds (default: 300)
  --stream       Output as JSON lines (NDJSON) for incremental processing

EXAMPLES:
  # Get Smart Money netflow on Solana
  nansen smart-money netflow --chain solana

  # Get top tokens by Smart Money activity
  nansen token screener --chain solana --timeframe 24h --pretty

  # Get wallet balance
  nansen profiler balance --address 0x123... --chain ethereum

  # Get wallet labels
  nansen profiler labels --address 0x123... --chain ethereum

  # Search for entity
  nansen profiler search --query "Vitalik"

  # Get token holders with filters
  nansen token holders --token 0x123... --filters '{"only_smart_money":true}'

SMART MONEY LABELS:
  Fund, Smart Trader, 30D Smart Trader, 90D Smart Trader, 
  180D Smart Trader, Smart HL Perps Trader

SUPPORTED CHAINS:
  ethereum, solana, base, bnb, arbitrum, polygon, optimism,
  avalanche, linea, scroll, zksync, mantle, ronin, sei,
  plasma, sonic, unichain, monad, hyperevm, iotaevm

For more info: https://docs.nansen.ai
`;

// Helper to prompt for input (exported for mocking)
export async function prompt(question, hidden = false) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  return new Promise((resolve) => {
    if (hidden && process.stdout.isTTY) {
      process.stdout.write(question);
      let input = '';
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding('utf8');
      
      const onData = (char) => {
        if (char === '\n' || char === '\r') {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.removeListener('data', onData);
          process.stdout.write('\n');
          rl.close();
          resolve(input);
        } else if (char === '\u0003') {
          // Ctrl+C
          process.exit();
        } else if (char === '\u007F' || char === '\b') {
          // Backspace
          if (input.length > 0) {
            input = input.slice(0, -1);
            process.stdout.write('\b \b');
          }
        } else {
          input += char;
          process.stdout.write('*');
        }
      };
      
      process.stdin.on('data', onData);
    } else {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      });
    }
  });
}

// Build command handlers (returns object with handler functions)
export function buildCommands(deps = {}) {
  // Allow dependency injection for testing
  const {
    api = null,
    promptFn = prompt,
    log = console.log,
    NansenAPIClass = NansenAPI,
    saveConfigFn = saveConfig,
    deleteConfigFn = deleteConfig,
    getConfigFileFn = getConfigFile,
    exit = process.exit
  } = deps;

  return {
    'login': async (args, apiInstance, flags, options) => {
      log('Nansen CLI Login\n');
      log('Get your API key at: https://app.nansen.ai/api\n');
      
      const apiKey = await promptFn('Enter your API key: ', true);
      
      if (!apiKey || apiKey.trim().length === 0) {
        log('\n❌ No API key provided');
        exit(1);
        return;
      }
      
      // Validate the key with a test request
      log('\nValidating API key...');
      try {
        const testApi = new NansenAPIClass(apiKey.trim());
        await testApi.tokenScreener({ chains: ['solana'], pagination: { page: 1, per_page: 1 } });
        
        // Save the config
        saveConfigFn({ 
          apiKey: apiKey.trim(), 
          baseUrl: 'https://api.nansen.ai' 
        });
        
        log('✓ API key validated');
        log(`✓ Saved to ${getConfigFileFn()}\n`);
        log('You can now use the Nansen CLI. Try:');
        log('  nansen token screener --chain solana --pretty');
      } catch (error) {
        log(`\n❌ Invalid API key: ${error.message}`);
        exit(1);
      }
    },

    'logout': async (args, apiInstance, flags, options) => {
      const deleted = deleteConfigFn();
      if (deleted) {
        log(`✓ Removed ${getConfigFileFn()}`);
      } else {
        log('No saved credentials found');
      }
    },

    'help': async (args, apiInstance, flags, options) => {
      log(HELP);
    },

    'schema': async (args, apiInstance, flags, options) => {
      // Return schema for agent introspection
      const subcommand = args[0];
      
      if (subcommand && SCHEMA.commands[subcommand]) {
        // Return schema for specific command
        return {
          command: subcommand,
          ...SCHEMA.commands[subcommand],
          globalOptions: SCHEMA.globalOptions,
          chains: SCHEMA.chains,
          smartMoneyLabels: SCHEMA.smartMoneyLabels
        };
      }
      
      // Return full schema
      return SCHEMA;
    },

    'cache': async (args, apiInstance, flags, options) => {
      const subcommand = args[0] || 'help';
      
      const handlers = {
        'clear': () => {
          const count = clearCache();
          log(`✓ Cleared ${count} cached responses`);
          log(`  Cache dir: ${getCacheDir()}`);
        },
        'help': () => {
          log('Cache Management\n');
          log('USAGE:');
          log('  nansen cache clear    Clear all cached responses\n');
          log('CACHE OPTIONS (for any command):');
          log('  --cache               Enable caching for this session');
          log('  --no-cache            Bypass cache for this request');
          log('  --cache-ttl <seconds> Set cache TTL (default: 300)');
        }
      };
      
      if (!handlers[subcommand]) {
        log(`Unknown cache subcommand: ${subcommand}`);
        handlers['help']();
        return;
      }
      
      return handlers[subcommand]();
    },

    'smart-money': async (args, apiInstance, flags, options) => {
      const subcommand = args[0] || 'help';
      const chain = options.chain || 'solana';
      const chains = options.chains || [chain];
      const filters = options.filters || {};
      const orderBy = parseSort(options.sort, options['order-by']);
      const pagination = options.limit ? { page: 1, per_page: options.limit } : undefined;

      // Add smart money label filter if specified
      if (options.labels) {
        filters.include_smart_money_labels = Array.isArray(options.labels) 
          ? options.labels 
          : [options.labels];
      }

      const days = options.days ? parseInt(options.days) : 30;

      const handlers = {
        'netflow': () => apiInstance.smartMoneyNetflow({ chains, filters, orderBy, pagination }),
        'dex-trades': () => apiInstance.smartMoneyDexTrades({ chains, filters, orderBy, pagination }),
        'perp-trades': () => apiInstance.smartMoneyPerpTrades({ filters, orderBy, pagination }),
        'holdings': () => apiInstance.smartMoneyHoldings({ chains, filters, orderBy, pagination }),
        'dcas': () => apiInstance.smartMoneyDcas({ filters, orderBy, pagination }),
        'historical-holdings': () => apiInstance.smartMoneyHistoricalHoldings({ chains, filters, orderBy, pagination, days }),
        'help': () => ({
          commands: ['netflow', 'dex-trades', 'perp-trades', 'holdings', 'dcas', 'historical-holdings'],
          description: 'Smart Money analytics endpoints',
          example: 'nansen smart-money netflow --chain solana --labels Fund'
        })
      };

      if (!handlers[subcommand]) {
        return { error: `Unknown subcommand: ${subcommand}`, available: Object.keys(handlers) };
      }

      return handlers[subcommand]();
    },

    'profiler': async (args, apiInstance, flags, options) => {
      const subcommand = args[0] || 'help';
      const address = options.address;
      const entityName = options.entity || options['entity-name'];
      const chain = options.chain || 'ethereum';
      const filters = options.filters || {};
      const orderBy = parseSort(options.sort, options['order-by']);
      const pagination = options.limit ? { page: 1, recordsPerPage: options.limit } : undefined;
      const days = options.days ? parseInt(options.days) : 30;

      const handlers = {
        'balance': () => apiInstance.addressBalance({ address, entityName, chain, filters, orderBy }),
        'labels': () => apiInstance.addressLabels({ address, chain, pagination }),
        'transactions': () => apiInstance.addressTransactions({ address, chain, filters, orderBy, pagination }),
        'pnl': () => apiInstance.addressPnl({ address, chain }),
        'search': () => apiInstance.entitySearch({ query: options.query, pagination }),
        'historical-balances': () => apiInstance.addressHistoricalBalances({ address, chain, filters, orderBy, pagination, days }),
        'related-wallets': () => apiInstance.addressRelatedWallets({ address, chain, filters, orderBy, pagination }),
        'counterparties': () => apiInstance.addressCounterparties({ address, chain, filters, orderBy, pagination, days }),
        'pnl-summary': () => apiInstance.addressPnlSummary({ address, chain, filters, orderBy, pagination, days }),
        'perp-positions': () => apiInstance.addressPerpPositions({ address, filters, orderBy, pagination }),
        'perp-trades': () => apiInstance.addressPerpTrades({ address, filters, orderBy, pagination, days }),
        'help': () => ({
          commands: ['balance', 'labels', 'transactions', 'pnl', 'search', 'historical-balances', 'related-wallets', 'counterparties', 'pnl-summary', 'perp-positions', 'perp-trades'],
          description: 'Wallet profiling endpoints',
          example: 'nansen profiler balance --address 0x123... --chain ethereum'
        })
      };

      if (!handlers[subcommand]) {
        return { error: `Unknown subcommand: ${subcommand}`, available: Object.keys(handlers) };
      }

      return handlers[subcommand]();
    },

    'token': async (args, apiInstance, flags, options) => {
      const subcommand = args[0] || 'help';
      const tokenAddress = options.token || options['token-address'];
      const tokenSymbol = options.symbol || options['token-symbol'];
      const chain = options.chain || 'solana';
      const chains = options.chains || [chain];
      const timeframe = options.timeframe || '24h';
      const filters = options.filters || {};
      const orderBy = parseSort(options.sort, options['order-by']);
      const pagination = options.limit ? { page: 1, per_page: options.limit } : undefined;
      const days = options.days ? parseInt(options.days) : 30;

      // Convenience filter for smart money only
      const onlySmartMoney = options['smart-money'] || flags['smart-money'] || false;
      if (onlySmartMoney) {
        filters.only_smart_money = true;
      }

      const handlers = {
        'screener': () => apiInstance.tokenScreener({ chains, timeframe, filters, orderBy, pagination }),
        'holders': () => apiInstance.tokenHolders({ tokenAddress, chain, filters, orderBy, pagination }),
        'flows': () => apiInstance.tokenFlows({ tokenAddress, chain, filters, orderBy, pagination }),
        'dex-trades': () => apiInstance.tokenDexTrades({ tokenAddress, chain, onlySmartMoney, filters, orderBy, pagination, days }),
        'pnl': () => apiInstance.tokenPnlLeaderboard({ tokenAddress, chain, filters, orderBy, pagination, days }),
        'who-bought-sold': () => apiInstance.tokenWhoBoughtSold({ tokenAddress, chain, filters, orderBy, pagination }),
        'flow-intelligence': () => apiInstance.tokenFlowIntelligence({ tokenAddress, chain, filters, orderBy, pagination }),
        'transfers': () => apiInstance.tokenTransfers({ tokenAddress, chain, filters, orderBy, pagination, days }),
        'jup-dca': () => apiInstance.tokenJupDca({ tokenAddress, filters, orderBy, pagination }),
        'perp-trades': () => apiInstance.tokenPerpTrades({ tokenSymbol, filters, orderBy, pagination, days }),
        'perp-positions': () => apiInstance.tokenPerpPositions({ tokenSymbol, filters, orderBy, pagination }),
        'perp-pnl-leaderboard': () => apiInstance.tokenPerpPnlLeaderboard({ tokenSymbol, filters, orderBy, pagination, days }),
        'help': () => ({
          commands: ['screener', 'holders', 'flows', 'dex-trades', 'pnl', 'who-bought-sold', 'flow-intelligence', 'transfers', 'jup-dca', 'perp-trades', 'perp-positions', 'perp-pnl-leaderboard'],
          description: 'Token God Mode endpoints',
          example: 'nansen token screener --chain solana --timeframe 24h --smart-money'
        })
      };

      if (!handlers[subcommand]) {
        return { error: `Unknown subcommand: ${subcommand}`, available: Object.keys(handlers) };
      }

      return handlers[subcommand]();
    },

    'portfolio': async (args, apiInstance, flags, options) => {
      const subcommand = args[0] || 'help';
      const walletAddress = options.wallet || options.address;

      const handlers = {
        'defi': () => apiInstance.portfolioDefiHoldings({ walletAddress }),
        'defi-holdings': () => apiInstance.portfolioDefiHoldings({ walletAddress }),
        'help': () => ({
          commands: ['defi', 'defi-holdings'],
          description: 'Portfolio analytics endpoints',
          example: 'nansen portfolio defi --wallet 0x123...'
        })
      };

      if (!handlers[subcommand]) {
        return { error: `Unknown subcommand: ${subcommand}`, available: Object.keys(handlers) };
      }

      return handlers[subcommand]();
    }
  };
}

// Commands that don't require API authentication
export const NO_AUTH_COMMANDS = ['login', 'logout', 'help', 'schema', 'cache'];

// Run CLI with given args (returns result, allows custom output/exit handlers)
export async function runCLI(rawArgs, deps = {}) {
  const {
    output = console.log,
    errorOutput = console.error,
    exit = process.exit,
    NansenAPIClass = NansenAPI,
    commandOverrides = {}
  } = deps;

  const { _: positional, flags, options } = parseArgs(rawArgs);
  
  const command = positional[0] || 'help';
  const subArgs = positional.slice(1);
  const pretty = flags.pretty || flags.p;
  const table = flags.table || flags.t;
  const stream = flags.stream || flags.s;

  const commands = { ...buildCommands(deps), ...commandOverrides };

  if (command === 'help' || flags.help || flags.h) {
    output(BANNER + HELP);
    return { type: 'help' };
  }

  if (!commands[command]) {
    const errorData = { 
      error: `Unknown command: ${command}`,
      available: Object.keys(commands)
    };
    const formatted = formatOutput(errorData, { pretty, table });
    output(formatted.text);
    exit(1);
    return { type: 'error', data: errorData };
  }

  // Commands that don't require API authentication
  if (NO_AUTH_COMMANDS.includes(command)) {
    const result = await commands[command](subArgs, null, flags, options);
    
    // Schema command returns data that should be output
    if (command === 'schema' && result) {
      const formatted = formatOutput(result, { pretty, table: false });
      output(formatted.text);
      return { type: 'schema', data: result };
    }
    
    return { type: 'no-auth', command };
  }

  try {
    // Configure retry options
    const retryOptions = flags['no-retry'] 
      ? { maxRetries: 0 } 
      : { maxRetries: options.retries !== undefined ? options.retries : 3 };
    
    // Configure cache options
    const cacheOptions = {
      enabled: flags['cache'] && !flags['no-cache'],
      ttl: options['cache-ttl'] !== undefined ? options['cache-ttl'] : 300
    };
    
    const api = new NansenAPIClass(undefined, undefined, { retry: retryOptions, cache: cacheOptions });
    let result = await commands[command](subArgs, api, flags, options);
    
    // Apply field filtering if --fields is specified
    const fields = parseFields(options.fields);
    if (fields) {
      result = filterFields(result, fields);
    }
    
    // Output in requested format
    if (stream) {
      // Stream mode: output each record as a JSON line (NDJSON)
      const streamOutput = formatStream(result);
      if (streamOutput) {
        output(streamOutput);
      }
      return { type: 'stream', data: result };
    }
    
    const successData = { success: true, data: result };
    const formatted = formatOutput(successData, { pretty, table });
    output(formatted.text);
    return { type: 'success', data: result };
  } catch (error) {
    const errorData = formatError(error);
    const formatted = formatOutput(errorData, { pretty, table });
    errorOutput(formatted.text);
    exit(1);
    return { type: 'error', data: errorData };
  }
}
