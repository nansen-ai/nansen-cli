#!/usr/bin/env node
/**
 * Nansen CLI - Command-line interface for Nansen API
 * Designed for AI agents with structured JSON output
 * 
 * Usage: nansen <command> [options]
 * 
 * All output is JSON for easy parsing by AI agents.
 * Use --pretty for human-readable formatting.
 */

import { NansenAPI, saveConfig, deleteConfig, getConfigFile } from './api.js';
import * as readline from 'readline';

// Parse command line arguments
function parseArgs(args) {
  const result = { _: [], flags: {}, options: {} };
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      
      if (key === 'pretty' || key === 'help' || key === 'table') {
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

// Table formatter for human-readable output
function formatTable(data) {
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

function formatValue(val) {
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

// Output helper
function output(data, pretty = false, table = false) {
  if (table) {
    if (data.success === false) {
      console.error(`Error: ${data.error}`);
    } else {
      const tableData = data.data || data;
      console.log(formatTable(tableData));
    }
  } else if (pretty) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(JSON.stringify(data));
  }
}

// Error output
function errorOutput(error, pretty = false, table = false) {
  const errorData = {
    success: false,
    error: error.message,
    status: error.status,
    details: error.data
  };
  output(errorData, pretty, table);
  process.exit(1);
}

// Parse simple sort syntax: "field:direction" or "field" (defaults to DESC)
function parseSort(sortOption, orderByOption) {
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

// Help text
const HELP = `
Nansen CLI - Command-line interface for Nansen API
Designed for AI agents with structured JSON output.

USAGE:
  nansen <command> [subcommand] [options]

COMMANDS:
  login          Save your API key (interactive)
  logout         Remove saved API key
  smart-money    Smart Money analytics (netflow, dex-trades, holdings, dcas, historical-holdings)
  profiler       Wallet profiling (balance, labels, transactions, pnl, perp-positions, perp-trades)
  token          Token God Mode (screener, holders, flows, trades, pnl, perp-trades, perp-positions)
  portfolio      Portfolio analytics (defi-holdings)
  help           Show this help message

GLOBAL OPTIONS:
  --pretty       Format JSON output for readability
  --table        Format output as human-readable table
  --chain        Blockchain to query (ethereum, solana, base, etc.)
  --chains       Multiple chains as JSON array
  --limit        Number of results (shorthand for pagination)
  --filters      JSON object with filters
  --sort         Sort by field (e.g., --sort value_usd:desc)
  --order-by     JSON array with sort order (advanced)
  --days         Date range in days (default: 30 for most endpoints)
  --symbol       Token symbol (for perp endpoints)

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

// Command handlers
// Helper to prompt for input
async function prompt(question, hidden = false) {
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

const commands = {
  'login': async (args, api, flags) => {
    console.log('Nansen CLI Login\n');
    console.log('Get your API key at: https://app.nansen.ai/api\n');
    
    const apiKey = await prompt('Enter your API key: ', true);
    
    if (!apiKey || apiKey.trim().length === 0) {
      console.log('\n❌ No API key provided');
      process.exit(1);
    }
    
    // Validate the key with a test request
    console.log('\nValidating API key...');
    try {
      const testApi = new NansenAPI(apiKey.trim());
      await testApi.tokenScreener({ chains: ['solana'], pagination: { page: 1, per_page: 1 } });
      
      // Save the config
      saveConfig({ 
        apiKey: apiKey.trim(), 
        baseUrl: 'https://api.nansen.ai' 
      });
      
      console.log('✓ API key validated');
      console.log(`✓ Saved to ${getConfigFile()}\n`);
      console.log('You can now use the Nansen CLI. Try:');
      console.log('  nansen token screener --chain solana --pretty');
    } catch (error) {
      console.log(`\n❌ Invalid API key: ${error.message}`);
      process.exit(1);
    }
  },

  'logout': async (args, api, flags) => {
    const deleted = deleteConfig();
    if (deleted) {
      console.log(`✓ Removed ${getConfigFile()}`);
    } else {
      console.log('No saved credentials found');
    }
  },

  'help': async (args, api, flags) => {
    console.log(HELP);
  },

  'smart-money': async (args, api, flags, options) => {
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
      'netflow': () => api.smartMoneyNetflow({ chains, filters, orderBy, pagination }),
      'dex-trades': () => api.smartMoneyDexTrades({ chains, filters, orderBy, pagination }),
      'perp-trades': () => api.smartMoneyPerpTrades({ filters, orderBy, pagination }),
      'holdings': () => api.smartMoneyHoldings({ chains, filters, orderBy, pagination }),
      'dcas': () => api.smartMoneyDcas({ filters, orderBy, pagination }),
      'historical-holdings': () => api.smartMoneyHistoricalHoldings({ chains, filters, orderBy, pagination, days }),
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

  'profiler': async (args, api, flags, options) => {
    const subcommand = args[0] || 'help';
    const address = options.address;
    const entityName = options.entity || options['entity-name'];
    const chain = options.chain || 'ethereum';
    const filters = options.filters || {};
    const orderBy = parseSort(options.sort, options['order-by']);
    const pagination = options.limit ? { page: 1, recordsPerPage: options.limit } : undefined;
    const days = options.days ? parseInt(options.days) : 30;

    const handlers = {
      'balance': () => api.addressBalance({ address, entityName, chain, filters, orderBy }),
      'labels': () => api.addressLabels({ address, chain, pagination }),
      'transactions': () => api.addressTransactions({ address, chain, filters, orderBy, pagination }),
      'pnl': () => api.addressPnl({ address, chain }),
      'search': () => api.entitySearch({ query: options.query, pagination }),
      'historical-balances': () => api.addressHistoricalBalances({ address, chain, filters, orderBy, pagination, days }),
      'related-wallets': () => api.addressRelatedWallets({ address, chain, filters, orderBy, pagination }),
      'counterparties': () => api.addressCounterparties({ address, chain, filters, orderBy, pagination, days }),
      'pnl-summary': () => api.addressPnlSummary({ address, chain, filters, orderBy, pagination, days }),
      'perp-positions': () => api.addressPerpPositions({ address, filters, orderBy, pagination }),
      'perp-trades': () => api.addressPerpTrades({ address, filters, orderBy, pagination, days }),
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

  'token': async (args, api, flags, options) => {
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
      'screener': () => api.tokenScreener({ chains, timeframe, filters, orderBy, pagination }),
      'holders': () => api.tokenHolders({ tokenAddress, chain, filters, orderBy, pagination }),
      'flows': () => api.tokenFlows({ tokenAddress, chain, filters, orderBy, pagination }),
      'dex-trades': () => api.tokenDexTrades({ tokenAddress, chain, onlySmartMoney, filters, orderBy, pagination, days }),
      'pnl': () => api.tokenPnlLeaderboard({ tokenAddress, chain, filters, orderBy, pagination, days }),
      'who-bought-sold': () => api.tokenWhoBoughtSold({ tokenAddress, chain, filters, orderBy, pagination }),
      'flow-intelligence': () => api.tokenFlowIntelligence({ tokenAddress, chain, filters, orderBy, pagination }),
      'transfers': () => api.tokenTransfers({ tokenAddress, chain, filters, orderBy, pagination, days }),
      'jup-dca': () => api.tokenJupDca({ tokenAddress, filters, orderBy, pagination }),
      'perp-trades': () => api.tokenPerpTrades({ tokenSymbol, filters, orderBy, pagination, days }),
      'perp-positions': () => api.tokenPerpPositions({ tokenSymbol, filters, orderBy, pagination }),
      'perp-pnl-leaderboard': () => api.tokenPerpPnlLeaderboard({ tokenSymbol, filters, orderBy, pagination, days }),
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

  'portfolio': async (args, api, flags, options) => {
    const subcommand = args[0] || 'help';
    const walletAddress = options.wallet || options.address;

    const handlers = {
      'defi': () => api.portfolioDefiHoldings({ walletAddress }),
      'defi-holdings': () => api.portfolioDefiHoldings({ walletAddress }),
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

// Main entry point
async function main() {
  const rawArgs = process.argv.slice(2);
  const { _: positional, flags, options } = parseArgs(rawArgs);
  
  const command = positional[0] || 'help';
  const subArgs = positional.slice(1);
  const pretty = flags.pretty || flags.p;
  const table = flags.table || flags.t;

  if (command === 'help' || flags.help || flags.h) {
    console.log(HELP);
    return;
  }

  if (!commands[command]) {
    output({ 
      error: `Unknown command: ${command}`,
      available: Object.keys(commands)
    }, pretty, table);
    process.exit(1);
  }

  // Commands that don't require API authentication
  const noAuthCommands = ['login', 'logout', 'help'];
  
  if (noAuthCommands.includes(command)) {
    await commands[command](subArgs, null, flags, options);
    return;
  }

  try {
    const api = new NansenAPI();
    const result = await commands[command](subArgs, api, flags, options);
    output({ success: true, data: result }, pretty, table);
  } catch (error) {
    errorOutput(error, pretty, table);
  }
}

main();
