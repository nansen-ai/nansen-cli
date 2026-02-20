/**
 * Nansen CLI - Core logic (testable)
 * Extracted from index.js for coverage
 */

import { NansenAPI, NansenError, ErrorCode, PrivyAPI, awalCommand, saveConfig, deleteConfig, getConfigFile, clearCache, getCacheDir, validateAddress, sleep } from './api.js';
import fs from 'fs';
import { getUpdateNotification, scheduleUpdateCheck } from './update-check.js';
import { createRequire } from 'module';
import * as readline from 'readline';

const require = createRequire(import.meta.url);
const { version: VERSION } = require('../package.json');

// ============= Schema Definition =============

export const SCHEMA = {
  version: VERSION,
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
          returns: ['chain', 'block_timestamp', 'transaction_hash', 'trader_address', 'trader_address_label', 'token_bought_address', 'token_sold_address', 'token_bought_amount', 'token_sold_amount', 'token_bought_symbol', 'token_sold_symbol', 'trade_value_usd']
        },
        'perp-trades': {
          description: 'Perpetual trading on Hyperliquid',
          options: { limit: { type: 'number' }, sort: { type: 'string' }, filters: { type: 'object' } },
          returns: ['trader_address', 'trader_address_label', 'token_symbol', 'side', 'action', 'token_amount', 'price_usd', 'value_usd', 'type', 'block_timestamp', 'transaction_hash']
        },
        'holdings': {
          description: 'Aggregated token balances',
          options: { chain: { type: 'string', default: 'solana' }, chains: { type: 'array' }, limit: { type: 'number' }, labels: { type: 'string|array' } },
          returns: ['chain', 'token_address', 'token_symbol', 'token_sectors', 'value_usd', 'balance_24h_percent_change', 'holders_count', 'share_of_holdings_percent', 'token_age_days', 'market_cap_usd']
        },
        'dcas': {
          description: 'DCA strategies on Jupiter',
          options: { limit: { type: 'number' }, filters: { type: 'object' } },
          returns: ['dca_created_at', 'dca_updated_at', 'trader_address', 'trader_address_label', 'dca_vault_address', 'input_token_address', 'output_token_address', 'deposit_token_amount', 'token_spent_amount', 'output_token_redeemed_amount', 'dca_status', 'input_token_symbol', 'output_token_symbol', 'deposit_value_usd']
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
          returns: ['chain', 'address', 'token_address', 'token_symbol', 'token_name', 'token_amount', 'price_usd', 'value_usd']
        },
        'labels': {
          description: 'Behavioral and entity labels',
          options: { address: { type: 'string', required: true }, chain: { type: 'string', default: 'ethereum' } },
          returns: ['label', 'label_type', 'label_subtype']
        },
        'transactions': {
          description: 'Transaction history',
          options: { address: { type: 'string', required: true }, chain: { type: 'string', default: 'ethereum' }, date: { type: 'string', required: true, description: 'Date or date range (YYYY-MM-DD or {"from":"YYYY-MM-DD","to":"YYYY-MM-DD"})' }, limit: { type: 'number' }, days: { type: 'number', default: 30 } },
          returns: ['chain', 'method', 'tokens_sent', 'tokens_received', 'volume_usd', 'block_timestamp', 'transaction_hash']
        },
        'pnl': {
          description: 'PnL and trade performance',
          options: { address: { type: 'string', required: true }, chain: { type: 'string', default: 'ethereum' }, date: { type: 'string', description: 'Date or date range (YYYY-MM-DD or {"from":"YYYY-MM-DD","to":"YYYY-MM-DD"})' }, days: { type: 'number', default: 30 }, limit: { type: 'number' } },
          returns: ['token_address', 'token_symbol', 'realized_pnl_usd', 'unrealized_pnl_usd', 'total_pnl_usd']
        },
        'search': {
          description: 'Search for entities by name',
          options: { query: { type: 'string', required: true, description: 'Search query' }, limit: { type: 'number' } },
          returns: ['entity_name']
        },
        'historical-balances': {
          description: 'Historical balances over time',
          options: { address: { type: 'string', required: true }, chain: { type: 'string', default: 'ethereum' }, days: { type: 'number', default: 30 } },
          returns: ['date', 'token_address', 'token_symbol', 'balance', 'balance_usd']
        },
        'related-wallets': {
          description: 'Find wallets related to an address',
          options: { address: { type: 'string', required: true }, chain: { type: 'string', default: 'ethereum' }, limit: { type: 'number' } },
          returns: ['address', 'address_label', 'relation', 'transaction_hash', 'block_timestamp', 'order', 'chain']
        },
        'counterparties': {
          description: 'Top counterparties by volume',
          options: { address: { type: 'string', required: true }, chain: { type: 'string', default: 'ethereum' }, days: { type: 'number', default: 30 } },
          returns: ['counterparty_address', 'counterparty_address_label', 'interaction_count', 'total_volume_usd', 'volume_in_usd', 'volume_out_usd', 'tokens_info']
        },
        'pnl-summary': {
          description: 'Summarized PnL metrics',
          options: { address: { type: 'string', required: true }, chain: { type: 'string', default: 'ethereum' }, days: { type: 'number', default: 30 } },
          returns: ['top5_tokens', 'traded_token_count', 'traded_times', 'realized_pnl_usd', 'realized_pnl_percent', 'win_rate']
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
        },
        'batch': {
          description: 'Batch profile multiple addresses',
          options: {
            addresses: { type: 'string', description: 'Comma-separated addresses' },
            file: { type: 'string', description: 'File with one address per line' },
            chain: { type: 'string', default: 'ethereum' },
            include: { type: 'string', default: 'labels,balance', description: 'Comma-separated: labels,balance,pnl' },
            delay: { type: 'number', default: 1000, description: 'Delay between requests in ms' }
          },
          returns: ['address', 'chain', 'labels', 'balance', 'pnl', 'error']
        },
        'trace': {
          description: 'Multi-hop counterparty trace (BFS)',
          options: {
            address: { type: 'string', required: true },
            chain: { type: 'string', default: 'ethereum' },
            depth: { type: 'number', default: 2, description: 'Max hops (1-5)' },
            width: { type: 'number', default: 10, description: 'Top N counterparties per hop' },
            days: { type: 'number', default: 30 },
            delay: { type: 'number', default: 1000, description: 'Delay between requests in ms' }
          },
          returns: ['root', 'chain', 'depth', 'nodes', 'edges', 'stats']
        },
        'compare': {
          description: 'Compare two wallets (shared counterparties, tokens)',
          options: {
            addresses: { type: 'string', required: true, description: 'Two comma-separated addresses' },
            chain: { type: 'string', default: 'ethereum' },
            days: { type: 'number', default: 30 }
          },
          returns: ['addresses', 'chain', 'shared_counterparties', 'shared_tokens', 'balances']
        }
      }
    },
    'token': {
      description: 'Token God Mode - deep analytics for any token',
      subcommands: {
        'info': {
          description: 'Get detailed information for a specific token',
          options: {
            token: { type: 'string', required: true, description: 'Token address' },
            chain: { type: 'string', default: 'solana' },
            timeframe: { type: 'string', default: '24h', enum: ['5m', '10m', '1h', '6h', '24h', '7d', '30d'] }
          },
          returns: ['token_address', 'token_symbol', 'token_name', 'chain', 'price_usd', 'volume_usd', 'market_cap', 'holder_count', 'liquidity_usd']
        },
        'screener': {
          description: 'Discover and filter tokens',
          options: {
            chain: { type: 'string', default: 'solana' },
            chains: { type: 'array' },
            timeframe: { type: 'string', default: '24h', enum: ['5m', '10m', '1h', '6h', '24h', '7d', '30d'] },
            'smart-money': { type: 'boolean', description: 'Filter for Smart Money only' },
            search: { type: 'string', description: 'Filter results by token symbol or name (client-side)' },
            limit: { type: 'number' },
            sort: { type: 'string' }
          },
          returns: ['token_address', 'token_symbol', 'token_name', 'chain', 'price_usd', 'volume_usd', 'market_cap', 'holder_count', 'smart_money_holders']
        },
        'holders': {
          description: 'Token holder analysis',
          options: { token: { type: 'string', required: true }, chain: { type: 'string', default: 'solana' }, 'smart-money': { type: 'boolean' }, limit: { type: 'number' } },
          returns: ['address', 'address_label', 'token_amount', 'total_outflow', 'total_inflow', 'balance_change_24h', 'balance_change_7d', 'balance_change_30d', 'ownership_percentage', 'value_usd']
        },
        'flows': {
          description: 'Token flow metrics',
          options: { token: { type: 'string', required: true }, chain: { type: 'string', default: 'solana' }, date: { type: 'string', required: true, description: 'Date or date range (YYYY-MM-DD or {"from":"YYYY-MM-DD","to":"YYYY-MM-DD"})' }, days: { type: 'number', default: 30 }, limit: { type: 'number' } },
          returns: ['date', 'price_usd', 'token_amount', 'value_usd', 'holders_count', 'total_inflows_count', 'total_outflows_count']
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
          options: { token: { type: 'string', required: true }, chain: { type: 'string', default: 'solana' }, date: { type: 'string', required: true, description: 'Date or date range (YYYY-MM-DD or {"from":"YYYY-MM-DD","to":"YYYY-MM-DD"})' }, days: { type: 'number', default: 30 }, limit: { type: 'number' } },
          returns: ['address', 'address_label', 'bought_token_volume', 'sold_token_volume', 'token_trade_volume', 'bought_volume_usd', 'sold_volume_usd', 'trade_volume_usd']
        },
        'flow-intelligence': {
          description: 'Detailed flow intelligence by label',
          options: { token: { type: 'string', required: true }, chain: { type: 'string', default: 'solana' }, days: { type: 'number', default: 30 } },
          returns: ['public_figure_net_flow_usd', 'public_figure_wallet_count', 'top_pnl_net_flow_usd', 'top_pnl_wallet_count', 'whale_net_flow_usd', 'whale_wallet_count', 'smart_trader_net_flow_usd', 'smart_trader_wallet_count', 'exchange_net_flow_usd', 'exchange_wallet_count', 'fresh_wallets_net_flow_usd', 'fresh_wallets_wallet_count']
        },
        'transfers': {
          description: 'Token transfer history',
          options: { token: { type: 'string', required: true }, chain: { type: 'string', default: 'solana' }, days: { type: 'number', default: 30 }, limit: { type: 'number' }, from: { type: 'string', description: 'Filter by sender address' }, to: { type: 'string', description: 'Filter by recipient address' }, enrich: { type: 'boolean', description: 'Enrich addresses with Nansen labels' } },
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
    },
    'perp': {
      description: 'Perpetual futures analytics',
      subcommands: {
        'screener': {
          description: 'Screen perpetual futures contracts',
          options: {
            days: { type: 'number', default: 30 },
            limit: { type: 'number' },
            sort: { type: 'string' },
            filters: { type: 'object' }
          },
          returns: ['token_symbol', 'volume_usd', 'open_interest', 'funding_rate', 'price_change_24h']
        },
        'leaderboard': {
          description: 'Perpetual futures PnL leaderboard',
          options: {
            days: { type: 'number', default: 30 },
            limit: { type: 'number' },
            sort: { type: 'string' },
            filters: { type: 'object' }
          },
          returns: ['address', 'address_label', 'realized_pnl', 'unrealized_pnl', 'total_pnl', 'trade_count', 'win_rate']
        }
      }
    },
    'wallet': {
      description: 'Agentic wallet — supports Coinbase (awal) and Privy providers',
      subcommands: {
        'setup': {
          description: 'Choose wallet provider (coinbase or privy)',
          options: {
            provider: { type: 'string', required: true, enum: ['coinbase', 'privy'], description: 'Wallet provider' }
          },
          returns: ['provider', 'message']
        },
        'status': {
          description: 'Check wallet status and auth',
          options: {},
          returns: ['provider', 'status', 'authenticated']
        },
        'login': {
          description: '[Coinbase] Start email OTP login',
          options: { email: { type: 'string', required: true } },
          returns: ['flowId', 'message']
        },
        'verify': {
          description: '[Coinbase] Complete OTP verification',
          options: { 'flow-id': { type: 'string', required: true }, otp: { type: 'string', required: true } },
          returns: ['success', 'email']
        },
        'create': {
          description: '[Privy] Create a new wallet',
          options: {
            'chain-type': { type: 'string', default: 'ethereum', description: 'ethereum, solana, etc.' },
            policy: { type: 'string', description: 'Policy ID to attach' }
          },
          returns: ['id', 'address', 'chain_type']
        },
        'list': {
          description: '[Privy] List wallets',
          options: { 'chain-type': { type: 'string' }, limit: { type: 'number', default: 100 } },
          returns: ['id', 'address', 'chain_type']
        },
        'balance': {
          description: 'Get wallet balance',
          options: {
            id: { type: 'string', description: '[Privy] Wallet ID' },
            chain: { type: 'string', description: '[Coinbase] Chain: base or base-sepolia' }
          },
          returns: ['balance']
        },
        'address': {
          description: '[Coinbase] Get wallet address',
          options: {},
          returns: ['address']
        },
        'send': {
          description: '[Coinbase] Send USDC',
          options: {
            amount: { type: 'string', required: true },
            to: { type: 'string', required: true, description: 'Address or ENS name' },
            chain: { type: 'string', default: 'base' }
          },
          returns: ['txHash', 'amount', 'recipient']
        },
        'trade': {
          description: '[Coinbase] Trade tokens on Base',
          options: {
            amount: { type: 'string', required: true },
            from: { type: 'string', required: true },
            to: { type: 'string', required: true },
            slippage: { type: 'number', description: 'Basis points (100 = 1%)' }
          },
          returns: ['txHash', 'amountIn', 'amountOut']
        },
        'create-policy': {
          description: '[Privy] Create spending policy',
          options: { name: { type: 'string', required: true }, 'chain-type': { type: 'string', default: 'ethereum' }, rules: { type: 'object' } },
          returns: ['id', 'name', 'rules']
        }
      }
    },
    'search': {
      description: 'Search for tokens and entities across Nansen',
      options: {
        query: { type: 'string', required: true, description: 'Search query (token name, symbol, address, or entity)' },
        type: { type: 'string', default: 'any', enum: ['token', 'entity', 'any'], description: 'Result type filter' },
        chain: { type: 'string', description: 'Filter by chain (e.g., ethereum, solana)' },
        limit: { type: 'number', default: 25, description: 'Max results (1-50)' }
      },
      returns: ['tokens[name, symbol, chain, address, price, volume_24h, market_cap, rank]', 'entities[name, tags, rank]', 'total_results']
    },
    'points': {
      description: 'Nansen Points analytics',
      subcommands: {
        'leaderboard': {
          description: 'Points leaderboard',
          options: {
            tier: { type: 'string', description: 'Filter by tier' },
            limit: { type: 'number' }
          },
          returns: ['rank', 'address', 'address_label', 'points', 'tier']
        }
      }
    }
  },
  globalOptions: {
    pretty: { type: 'boolean', description: 'Format JSON output for readability' },
    table: { type: 'boolean', description: 'Format output as human-readable table' },
    fields: { type: 'string', description: 'Comma-separated list of fields to include in output' },
    'no-retry': { type: 'boolean', description: 'Disable automatic retry on rate limits/errors' },
    retries: { type: 'number', default: 3, description: 'Max retry attempts' },
    format: { type: 'string', enum: ['json', 'csv'], description: 'Output format (default: json)' }
  },
  chains: ['ethereum', 'solana', 'base', 'bnb', 'arbitrum', 'polygon', 'optimism', 'avalanche', 'linea', 'scroll', 'mantle', 'ronin', 'sei', 'plasma', 'sonic', 'monad', 'hyperevm', 'iotaevm'],
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
      
      if (key === 'pretty' || key === 'help' || key === 'version' || key === 'table' || key === 'no-retry' || key === 'cache' || key === 'no-cache' || key === 'stream' || key === 'enrich') {
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

/**
 * Format data as CSV with header row
 */
export function formatCsv(data) {
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
    records = [data];
  }

  if (records.length === 0) return '';

  const columns = [...new Set(records.flatMap(r => Object.keys(r)))];

  const escape = (val) => {
    if (val === null || val === undefined) return '';
    const s = typeof val === 'object' ? JSON.stringify(val) : String(val);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  };

  const lines = [columns.join(',')];
  for (const record of records) {
    lines.push(columns.map(col => escape(record[col])).join(','));
  }
  return lines.join('\n');
}

// Format output data (returns string, does not print)
export function formatOutput(data, { pretty = false, table = false, csv = false } = {}) {
  if (csv) {
    if (data.success === false) {
      return { type: 'error', text: `Error: ${data.error}` };
    }
    const csvData = data.data || data;
    return { type: 'csv', text: formatCsv(csvData) };
  } else if (table) {
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

/**
 * Parse --date option into {from, to} object.
 * Accepts: "YYYY-MM-DD" (single date → from=date, to=date),
 *          '{"from":"YYYY-MM-DD","to":"YYYY-MM-DD"}' (JSON object),
 *          or already-parsed object {from, to}.
 * Falls back to days-based range if no date provided.
 */
export function parseDateOption(dateOption, days = 30) {
  if (dateOption) {
    if (typeof dateOption === 'object' && dateOption.from) {
      return dateOption;
    }
    if (typeof dateOption === 'string') {
      // Simple date string: use as both from and to
      const dateMatch = dateOption.match(/^\d{4}-\d{2}-\d{2}$/);
      if (dateMatch) {
        return { from: dateOption, to: dateOption };
      }
    }
  }
  // Default: use days-based range
  const to = new Date().toISOString().split('T')[0];
  const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  return { from, to };
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

// Enrich transfers with Nansen labels for from/to addresses
async function enrichTransfers(result, apiInstance, chain) {
  const transfers = result?.data?.results || result?.transfers || result?.data || [];
  if (!Array.isArray(transfers) || transfers.length === 0) return result;

  // Collect unique addresses (cap at 50)
  const addrs = new Set();
  for (const t of transfers) {
    if (t.from) addrs.add(t.from);
    if (t.to) addrs.add(t.to);
    if (addrs.size >= 50) break;
  }

  // Batch lookup labels
  const labelMap = {};
  for (const addr of addrs) {
    try {
      const labelsResult = await apiInstance.addressLabels({ address: addr, chain });
      labelMap[addr] = labelsResult?.labels || labelsResult?.data?.results || [];
    } catch {
      labelMap[addr] = [];
    }
  }

  // Merge labels into transfers
  for (const t of transfers) {
    if (t.from && labelMap[t.from]) t.from_labels = labelMap[t.from];
    if (t.to && labelMap[t.to]) t.to_labels = labelMap[t.to];
  }

  return result;
}

// ============= Composite Functions =============

export async function batchProfile(api, params = {}) {
  const { addresses = [], chain = 'ethereum', include = ['labels', 'balance'], delayMs = 1000 } = params;
  const results = [];
  for (let i = 0; i < addresses.length; i++) {
    const address = addresses[i].trim();
    const entry = { address, chain };
    const validation = validateAddress(address, chain);
    if (!validation.valid) {
      entry.error = validation.error;
      results.push(entry);
      if (i < addresses.length - 1) await sleep(delayMs);
      continue;
    }
    try {
      if (include.includes('labels')) {
        entry.labels = await api.addressLabels({ address, chain });
      }
      if (include.includes('balance')) {
        entry.balance = await api.addressBalance({ address, chain });
      }
      if (include.includes('pnl')) {
        entry.pnl = await api.addressPnl({ address, chain });
      }
    } catch (err) {
      entry.error = err.message;
    }
    results.push(entry);
    if (i < addresses.length - 1) await sleep(delayMs);
  }
  return { results, total: addresses.length, completed: results.filter(r => !r.error).length };
}

export async function traceCounterparties(api, params = {}) {
  const { address, chain = 'ethereum', depth = 2, width = 10, days = 30, delayMs = 1000 } = params;
  if (!address) {
    throw new NansenError('address is required for trace', ErrorCode.MISSING_PARAM);
  }
  const validation = validateAddress(address, chain);
  if (!validation.valid) {
    throw new NansenError(validation.error, ErrorCode.INVALID_ADDRESS);
  }
  const clampedDepth = Math.max(1, Math.min(depth, 5));
  const visited = new Set();
  const nodes = [];
  const edges = [];
  const queue = [{ addr: address, hop: 0 }];
  visited.add(address);
  nodes.push(address);

  while (queue.length > 0) {
    const { addr, hop } = queue.shift();
    if (hop >= clampedDepth) continue;

    try {
      const result = await api.addressCounterparties({
        address: addr, chain, days,
        pagination: { page: 1, per_page: width },
      });

      const counterparties = result?.data?.results || result?.counterparties || result?.data || [];
      const items = Array.isArray(counterparties) ? counterparties.slice(0, width) : [];

      for (const cp of items) {
        const cpAddr = cp.counterparty_address || cp.address || cp.counterparty;
        if (!cpAddr) continue;

        edges.push({
          from: addr, to: cpAddr,
          volume_usd: cp.volume_usd || cp.total_volume_usd || 0,
          tx_count: cp.transaction_count || cp.tx_count || 0,
          hop: hop + 1,
        });

        if (!visited.has(cpAddr)) {
          visited.add(cpAddr);
          nodes.push(cpAddr);
          queue.push({ addr: cpAddr, hop: hop + 1 });
        }
      }
    } catch (err) {
      // Skip addresses that fail (404, etc) but continue the traversal
    }

    if (queue.length > 0) await sleep(delayMs);
  }

  return {
    root: address, chain, depth: clampedDepth,
    nodes, edges,
    stats: { nodes_visited: nodes.length, edges_found: edges.length, max_depth_reached: Math.max(0, ...edges.map(e => e.hop)) },
  };
}

export async function compareWallets(api, params = {}) {
  const { addresses = [], chain = 'ethereum', days = 30, delayMs = 1000 } = params;
  if (addresses.length !== 2) {
    throw new NansenError('Exactly 2 addresses are required for comparison', ErrorCode.INVALID_PARAMS);
  }
  const [addr1, addr2] = addresses;
  for (const addr of [addr1, addr2]) {
    const validation = validateAddress(addr, chain);
    if (!validation.valid) {
      throw new NansenError(validation.error, ErrorCode.INVALID_ADDRESS);
    }
  }

  // Fetch counterparties and balances for both addresses
  const [cp1, cp2] = await Promise.all([
    api.addressCounterparties({ address: addr1, chain, days }).catch(() => null),
    api.addressCounterparties({ address: addr2, chain, days }).catch(() => null),
  ]);
  await sleep(delayMs);
  const [bal1, bal2] = await Promise.all([
    api.addressBalance({ address: addr1, chain }).catch(() => null),
    api.addressBalance({ address: addr2, chain }).catch(() => null),
  ]);

  // Extract counterparty addresses
  const extractCps = (result) => {
    const list = result?.data?.results || result?.counterparties || result?.data || [];
    return Array.isArray(list) ? list : [];
  };
  const cps1 = extractCps(cp1);
  const cps2 = extractCps(cp2);
  const cpAddrs1 = new Set(cps1.map(c => c.counterparty_address || c.address || c.counterparty).filter(Boolean));
  const cpAddrs2 = new Set(cps2.map(c => c.counterparty_address || c.address || c.counterparty).filter(Boolean));
  const sharedCpAddrs = [...cpAddrs1].filter(a => cpAddrs2.has(a));

  // Extract token holdings
  const extractTokens = (result) => {
    const list = result?.data?.results || result?.balances || result?.data || [];
    return Array.isArray(list) ? list : [];
  };
  const tokens1 = extractTokens(bal1);
  const tokens2 = extractTokens(bal2);
  const tokenSyms1 = new Set(tokens1.map(t => t.token_symbol).filter(Boolean));
  const tokenSyms2 = new Set(tokens2.map(t => t.token_symbol).filter(Boolean));
  const sharedTokens = [...tokenSyms1].filter(s => tokenSyms2.has(s));

  return {
    addresses: [addr1, addr2], chain,
    shared_counterparties: sharedCpAddrs,
    shared_tokens: sharedTokens,
    balances: [
      { address: addr1, total_usd: tokens1.reduce((sum, t) => sum + (t.balance_usd || 0), 0) },
      { address: addr2, total_usd: tokens2.reduce((sum, t) => sum + (t.balance_usd || 0), 0) },
    ],
  };
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
  smart-money    Smart Money analytics (netflow, dex-trades, perp-trades, holdings, dcas, historical-holdings)
  profiler       Wallet profiling (balance, labels, transactions, pnl, pnl-summary, search,
                   historical-balances, related-wallets, counterparties, perp-positions, perp-trades,
                   batch, trace, compare)
  token          Token God Mode (info, screener, holders, flows, dex-trades, pnl, who-bought-sold,
                   flow-intelligence, transfers, jup-dca, perp-trades, perp-positions,
                   perp-pnl-leaderboard)
  portfolio      Portfolio analytics (defi)
  perp           Perpetual futures analytics (screener, leaderboard)
  points         Nansen Points analytics (leaderboard)
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
  --format csv   Output as CSV with header row

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
  nansen token holders --token 0x123... --smart-money

SMART MONEY LABELS:
  Fund, Smart Trader, 30D Smart Trader, 90D Smart Trader, 
  180D Smart Trader, Smart HL Perps Trader

SUPPORTED CHAINS:
  ethereum, solana, base, bnb, arbitrum, polygon, optimism,
  avalanche, linea, scroll, mantle, ronin, sei,
  plasma, sonic, monad, hyperevm, iotaevm

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
        'transactions': () => {
          const date = parseDateOption(options.date, days);
          return apiInstance.addressTransactions({ address, chain, filters, orderBy, pagination, days, date });
        },
        'pnl': () => {
          const date = parseDateOption(options.date, days);
          return apiInstance.addressPnl({ address, chain, date, days, pagination });
        },
        'search': () => apiInstance.entitySearch({ query: options.query }),
        'historical-balances': () => apiInstance.addressHistoricalBalances({ address, chain, filters, orderBy, pagination, days }),
        'related-wallets': () => apiInstance.addressRelatedWallets({ address, chain, orderBy, pagination }),
        'counterparties': () => apiInstance.addressCounterparties({ address, chain, filters, orderBy, pagination, days }),
        'pnl-summary': () => apiInstance.addressPnlSummary({ address, chain, orderBy, pagination, days }),
        'perp-positions': () => apiInstance.addressPerpPositions({ address, filters, orderBy, pagination }),
        'perp-trades': () => apiInstance.addressPerpTrades({ address, filters, orderBy, pagination, days }),
        'batch': () => {
          let addresses = [];
          if (options.addresses) {
            addresses = options.addresses.split(',').map(a => a.trim()).filter(Boolean);
          } else if (options.file) {
            const content = fs.readFileSync(options.file, 'utf8');
            try {
              const parsed = JSON.parse(content);
              if (!Array.isArray(parsed)) {
                throw new NansenError('File must contain a JSON array of address strings or one address per line', ErrorCode.INVALID_PARAMS);
              }
              if (!parsed.every(item => typeof item === 'string')) {
                throw new NansenError('File must contain a JSON array of address strings or one address per line', ErrorCode.INVALID_PARAMS);
              }
              addresses = parsed.map(a => a.trim()).filter(Boolean);
            } catch (e) {
              if (e instanceof NansenError) throw e;
              addresses = content.split('\n').map(a => a.trim()).filter(Boolean);
            }
          }
          if (addresses.length > 100) {
            throw new NansenError('Batch is limited to 100 addresses', ErrorCode.INVALID_PARAMS);
          }
          const include = options.include ? options.include.split(',').map(s => s.trim()) : ['labels', 'balance'];
          const delayMs = options.delay ? parseInt(options.delay) : 1000;
          return batchProfile(apiInstance, { addresses, chain, include, delayMs });
        },
        'trace': () => {
          const depth = options.depth ? Math.max(1, Math.min(parseInt(options.depth), 5)) : 2;
          const width = options.width ? parseInt(options.width) : 10;
          const delayMs = options.delay ? parseInt(options.delay) : 1000;
          return traceCounterparties(apiInstance, { address, chain, depth, width, days, delayMs });
        },
        'compare': () => {
          const addrs = (options.addresses || '').split(',').map(a => a.trim()).filter(Boolean);
          return compareWallets(apiInstance, { addresses: addrs, chain, days });
        },
        'help': () => ({
          commands: ['balance', 'labels', 'transactions', 'pnl', 'search', 'historical-balances', 'related-wallets', 'counterparties', 'pnl-summary', 'perp-positions', 'perp-trades', 'batch', 'trace', 'compare'],
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
        filters.include_smart_money_labels = filters.include_smart_money_labels || 
          ['Fund', 'Smart Trader', '30D Smart Trader', '90D Smart Trader', '180D Smart Trader'];
      }

      const handlers = {
        'info': () => apiInstance.tokenInformation({ tokenAddress, chain, timeframe }),
        'screener': async () => {
          const search = options.search;
          // When searching, fetch more results to filter from (API has no server-side search)
          const searchPagination = search 
            ? { page: 1, per_page: Math.max(500, pagination?.per_page || 0) }
            : pagination;
          const result = await apiInstance.tokenScreener({ chains, timeframe, filters, orderBy, pagination: searchPagination });
          if (search) {
            const q = search.toLowerCase();
            const requestedLimit = pagination?.per_page || 100;
            const filterArr = (arr) => arr.filter(t => 
              (t.token_symbol && t.token_symbol.toLowerCase().includes(q)) ||
              (t.token_name && t.token_name.toLowerCase().includes(q)) ||
              (t.token_address && t.token_address.toLowerCase() === q)
            ).slice(0, requestedLimit);
            // Handle nested response shapes: {data: [...]} or {data: {data: [...]}}
            if (Array.isArray(result?.data)) {
              return { ...result, data: filterArr(result.data) };
            } else if (result?.data?.data && Array.isArray(result.data.data)) {
              return { ...result, data: { ...result.data, data: filterArr(result.data.data) } };
            }
          }
          return result;
        },
        'holders': () => apiInstance.tokenHolders({ tokenAddress, chain, labelType: onlySmartMoney ? 'smart_money' : 'all_holders', filters, orderBy, pagination }),
        'flows': () => {
          const date = parseDateOption(options.date, days);
          return apiInstance.tokenFlows({ tokenAddress, chain, filters, orderBy, pagination, days, date });
        },
        'dex-trades': () => apiInstance.tokenDexTrades({ tokenAddress, chain, onlySmartMoney, filters, orderBy, pagination, days }),
        'pnl': () => apiInstance.tokenPnlLeaderboard({ tokenAddress, chain, filters, orderBy, pagination, days }),
        'who-bought-sold': () => {
          const date = parseDateOption(options.date, days);
          return apiInstance.tokenWhoBoughtSold({ tokenAddress, chain, filters, orderBy, pagination, days, date });
        },
        'flow-intelligence': () => apiInstance.tokenFlowIntelligence({ tokenAddress, chain, days }),
        'transfers': () => {
          // Inject --from/--to into filters
          if (options.from) filters.from_address = options.from;
          if (options.to) filters.to_address = options.to;
          return apiInstance.tokenTransfers({ tokenAddress, chain, filters, orderBy, pagination, days });
        },
        'jup-dca': () => apiInstance.tokenJupDca({ tokenAddress, filters, orderBy, pagination }),
        'perp-trades': () => apiInstance.tokenPerpTrades({ tokenSymbol, filters, orderBy, pagination, days }),
        'perp-positions': () => apiInstance.tokenPerpPositions({ tokenSymbol, filters, orderBy, pagination }),
        'perp-pnl-leaderboard': () => apiInstance.tokenPerpPnlLeaderboard({ tokenSymbol, filters, orderBy, pagination, days }),
        'help': () => ({
          commands: ['info', 'screener', 'holders', 'flows', 'dex-trades', 'pnl', 'who-bought-sold', 'flow-intelligence', 'transfers', 'jup-dca', 'perp-trades', 'perp-positions', 'perp-pnl-leaderboard'],
          description: 'Token God Mode endpoints',
          example: 'nansen token screener --chain solana --timeframe 24h --smart-money'
        })
      };

      if (!handlers[subcommand]) {
        return { error: `Unknown subcommand: ${subcommand}`, available: Object.keys(handlers) };
      }

      let result = await handlers[subcommand]();

      // Enrich transfers with Nansen labels for from/to addresses
      if (subcommand === 'transfers' && (options.enrich || flags.enrich)) {
        result = await enrichTransfers(result, apiInstance, chain);
      }

      return result;
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
    },

    'perp': async (args, apiInstance, flags, options) => {
      const subcommand = args[0] || 'help';
      const filters = options.filters || {};
      const orderBy = parseSort(options.sort, options['order-by']);
      const pagination = options.limit ? { page: 1, per_page: options.limit } : undefined;
      const days = options.days ? parseInt(options.days) : 30;

      const handlers = {
        'screener': () => apiInstance.perpScreener({ filters, orderBy, pagination, days }),
        'leaderboard': () => apiInstance.perpLeaderboard({ filters, orderBy, pagination, days }),
        'help': () => ({
          commands: ['screener', 'leaderboard'],
          description: 'Perpetual futures analytics endpoints',
          example: 'nansen perp screener --days 7 --limit 20'
        })
      };

      if (!handlers[subcommand]) {
        return { error: `Unknown subcommand: ${subcommand}`, available: Object.keys(handlers) };
      }

      return handlers[subcommand]();
    },

    'wallet': async (args, apiInstance, flags, options) => {
      const subcommand = args[0] || 'help';

      // Load wallet provider from config
      const configFile = getConfigFile();
      let config = {};
      try { config = JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch {}
      const provider = options.provider || config.walletProvider;

      if (subcommand === 'help') {
        return {
          provider: provider || 'not configured',
          commands: {
            shared: ['setup', 'status', 'balance', 'help'],
            coinbase: ['login', 'verify', 'address', 'send', 'trade'],
            privy: ['create', 'list', 'create-policy']
          },
          examples: [
            'nansen wallet setup --provider coinbase',
            'nansen wallet setup --provider privy',
            'nansen wallet status',
            'nansen wallet balance'
          ],
          hint: provider ? `Current provider: ${provider}` : 'Run "nansen wallet setup --provider <coinbase|privy>" first'
        };
      }

      // Setup: save provider choice
      if (subcommand === 'setup') {
        const p = options.provider || args[1];
        if (!p || !['coinbase', 'privy'].includes(p)) {
          return { error: 'Provider required: coinbase or privy', usage: 'nansen wallet setup --provider coinbase' };
        }
        config.walletProvider = p;
        saveConfig(config);
        return { provider: p, message: `Wallet provider set to ${p}. Run "nansen wallet status" to check.` };
      }

      // Require provider for all other commands
      if (!provider) {
        return {
          error: 'No wallet provider configured',
          hint: 'Run "nansen wallet setup --provider <coinbase|privy>" to choose',
          providers: {
            coinbase: 'Email OTP auth, send USDC, trade on Base. No API keys needed.',
            privy: 'Programmatic wallets with policy guardrails. Needs PRIVY_APP_ID + PRIVY_APP_SECRET.'
          }
        };
      }

      // ---- Coinbase (awal) handlers ----
      if (provider === 'coinbase') {
        const coinbaseHandlers = {
          'status': () => awalCommand(['status']),
          'login': () => {
            const email = options.email || args[1];
            if (!email) return { error: 'Email required. Usage: nansen wallet login --email user@example.com' };
            return awalCommand(['auth', 'login', email]);
          },
          'verify': () => {
            const flowId = options['flow-id'] || args[1];
            const otp = options.otp || args[2];
            if (!flowId || !otp) return { error: 'Flow ID and OTP required. Usage: nansen wallet verify --flow-id <id> --otp <code>' };
            return awalCommand(['auth', 'verify', flowId, otp]);
          },
          'balance': () => {
            const cmdArgs = ['balance'];
            if (options.chain) cmdArgs.push('--chain', options.chain);
            return awalCommand(cmdArgs);
          },
          'address': () => awalCommand(['address']),
          'send': () => {
            const amount = options.amount || args[1];
            const to = options.to || args[2];
            if (!amount || !to) return { error: 'Amount and recipient required. Usage: nansen wallet send --amount 1.00 --to vitalik.eth' };
            const cmdArgs = ['send', amount, to];
            if (options.chain) cmdArgs.push('--chain', options.chain);
            return awalCommand(cmdArgs);
          },
          'trade': () => {
            const amount = options.amount || args[1];
            const from = options.from || args[2];
            const to = options.to || args[3];
            if (!amount || !from || !to) return { error: 'Amount, from, and to required. Usage: nansen wallet trade --amount $5 --from usdc --to eth' };
            const cmdArgs = ['trade', amount, from, to];
            if (options.slippage) cmdArgs.push('--slippage', String(options.slippage));
            return awalCommand(cmdArgs);
          }
        };

        if (!coinbaseHandlers[subcommand]) {
          return { error: `Unknown coinbase wallet command: ${subcommand}`, available: Object.keys(coinbaseHandlers) };
        }
        return coinbaseHandlers[subcommand]();
      }

      // ---- Privy handlers ----
      if (provider === 'privy') {
        let privy;
        try {
          privy = new PrivyAPI();
        } catch (e) {
          return { error: e.message, hint: 'Set PRIVY_APP_ID and PRIVY_APP_SECRET env vars. Get them from https://dashboard.privy.io' };
        }

        const walletId = options.id || args[1];

        const privyHandlers = {
          'status': async () => {
            const wallets = await privy.listWallets({ limit: 5 });
            return { provider: 'privy', authenticated: true, wallets: wallets?.data || wallets };
          },
          'create': () => privy.createWallet({
            chainType: options['chain-type'] || 'ethereum',
            policyIds: options.policy ? [options.policy] : undefined
          }),
          'list': () => privy.listWallets({
            chainType: options['chain-type'],
            limit: options.limit ? parseInt(options.limit) : 100
          }),
          'balance': () => {
            if (!walletId) return { error: 'Wallet ID required. Usage: nansen wallet balance --id <wallet_id>' };
            return privy.getBalance(walletId);
          },
          'create-policy': () => privy.createPolicy({
            name: options.name,
            chainType: options['chain-type'] || 'ethereum',
            rules: options.rules || []
          }),
          'get-policy': () => {
            const policyId = options.id || args[1];
            if (!policyId) return { error: 'Policy ID required.' };
            return privy.getPolicy(policyId);
          },
          'delete': () => {
            if (!walletId) return { error: 'Wallet ID required.' };
            return privy.deleteWallet(walletId);
          }
        };

        if (!privyHandlers[subcommand]) {
          return { error: `Unknown privy wallet command: ${subcommand}`, available: Object.keys(privyHandlers) };
        }
        return privyHandlers[subcommand]();
      }

      return { error: `Unknown provider: ${provider}`, hint: 'Run "nansen wallet setup --provider <coinbase|privy>"' };
    },

    'search': async (args, apiInstance, flags, options) => {
      const query = args[0] || options.query;
      if (!query) {
        return { error: 'Search query required. Usage: nansen search <query> [--type token|entity|any] [--chain ethereum] [--limit 25]' };
      }
      return apiInstance.generalSearch({
        query,
        resultType: options.type || 'any',
        chain: options.chain,
        limit: options.limit ? parseInt(options.limit) : 25
      });
    },

    'points': async (args, apiInstance, flags, options) => {
      const subcommand = args[0] || 'help';
      const tier = options.tier;
      const pagination = options.limit ? { page: 1, per_page: options.limit } : undefined;

      const handlers = {
        'leaderboard': () => apiInstance.pointsLeaderboard({ tier, pagination }),
        'help': () => ({
          commands: ['leaderboard'],
          description: 'Nansen Points analytics endpoints',
          example: 'nansen points leaderboard --limit 100'
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
export const NO_AUTH_COMMANDS = ['login', 'logout', 'help', 'schema', 'cache', 'wallet'];

// Command aliases for convenience
export const COMMAND_ALIASES = {
  'tgm': 'token',           // Token God Mode
  'sm': 'smart-money',      // Smart Money
  'prof': 'profiler',       // Profiler
  'port': 'portfolio'       // Portfolio
};

// Generate help text for a specific subcommand using SCHEMA
export function generateSubcommandHelp(command, subcommand) {
  const cmdSchema = SCHEMA.commands[command];
  if (!cmdSchema) return null;
  
  const subSchema = cmdSchema.subcommands?.[subcommand];
  if (!subSchema) return null;

  const lines = [];
  lines.push(`\n${command} ${subcommand} - ${subSchema.description || 'No description'}\n`);
  
  // Usage
  const requiredOpts = [];
  const optionalOpts = [];
  
  if (subSchema.options) {
    for (const [name, opt] of Object.entries(subSchema.options)) {
      if (opt.required) {
        requiredOpts.push(name);
      } else {
        optionalOpts.push(name);
      }
    }
  }
  
  let usage = `USAGE:\n  nansen ${command} ${subcommand}`;
  if (requiredOpts.length) {
    usage += ' ' + requiredOpts.map(o => `--${o} <value>`).join(' ');
  }
  if (optionalOpts.length) {
    usage += ' [options]';
  }
  lines.push(usage);
  
  // Required options
  if (requiredOpts.length) {
    lines.push('\nREQUIRED:');
    for (const name of requiredOpts) {
      const opt = subSchema.options[name];
      const desc = opt.description || `${opt.type}`;
      lines.push(`  --${name.padEnd(16)} ${desc}`);
    }
  }
  
  // Optional options
  if (optionalOpts.length) {
    lines.push('\nOPTIONS:');
    for (const name of optionalOpts) {
      const opt = subSchema.options[name];
      const defaultStr = opt.default !== undefined ? ` (default: ${opt.default})` : '';
      const desc = (opt.description || opt.type) + defaultStr;
      lines.push(`  --${name.padEnd(16)} ${desc}`);
    }
  }
  
  // Return fields
  if (subSchema.returns && subSchema.returns.length) {
    lines.push('\nRETURNS:');
    lines.push(`  ${subSchema.returns.join(', ')}`);
  }
  
  // Examples
  lines.push('\nEXAMPLES:');
  const chain = subSchema.options?.chain?.default || 'solana';
  
  // Example values for common required options
  const exampleValues = {
    address: '0x123...',
    token: '0x123...',
    query: '"search term"',
    symbol: 'BTC',
    date: '2024-01-01'
  };
  
  // Build example based on required options
  let example = `  nansen ${command} ${subcommand}`;
  for (const name of requiredOpts) {
    const value = exampleValues[name] || '<value>';
    example += ` --${name} ${value}`;
  }
  if (subSchema.options?.chain && !requiredOpts.includes('chain')) {
    example += ` --chain ${chain}`;
  }
  example += ' --pretty';
  lines.push(example);
  
  // Add a filtered example if filters are supported
  if (subSchema.options?.filters || subSchema.options?.labels) {
    let filterExample = `  nansen ${command} ${subcommand}`;
    for (const name of requiredOpts) {
      const value = exampleValues[name] || '<value>';
      filterExample += ` --${name} ${value}`;
    }
    if (subSchema.options?.chain && !requiredOpts.includes('chain')) {
      filterExample += ` --chain ${chain}`;
    }
    if (subSchema.options?.labels) {
      filterExample += ' --labels "Smart Trader"';
    }
    filterExample += ' --limit 10 --table';
    lines.push(filterExample);
  }
  
  return lines.join('\n');
}

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

  // Resolve command aliases
  const rawCommand = positional[0] || 'help';
  const command = COMMAND_ALIASES[rawCommand] || rawCommand;
  const subArgs = positional.slice(1);
  const subcommand = subArgs[0];
  const pretty = flags.pretty || flags.p;
  const table = flags.table || flags.t;
  const stream = flags.stream || flags.s;
  const csv = options.format === 'csv';

  // Update check (read cached result + schedule background refresh)
  const updateNotification = getUpdateNotification(VERSION);
  scheduleUpdateCheck();
  const notify = () => { if (updateNotification) errorOutput(updateNotification); };

  const commands = { ...buildCommands(deps), ...commandOverrides };

  if (flags.version || flags.v) {
    output(VERSION);
    return { type: 'version', data: VERSION };
  }

  if (command === 'help' || flags.help || flags.h) {
    // Check for subcommand-specific help: nansen <command> <subcommand> --help
    if (flags.help || flags.h) {
      // First try subcommand help
      if (command && subcommand) {
        const subHelp = generateSubcommandHelp(command, subcommand);
        if (subHelp) {
          output(subHelp);
          notify();
          return { type: 'subcommand-help', command, subcommand };
        }
      }
      // Then try command-level help (list subcommands)
      if (command && SCHEMA.commands[command]) {
        const cmdSchema = SCHEMA.commands[command];
        const lines = [`\n${command} - ${cmdSchema.description}\n`];
        lines.push('SUBCOMMANDS:');
        for (const [sub, subSchema] of Object.entries(cmdSchema.subcommands || {})) {
          lines.push(`  ${sub.padEnd(20)} ${subSchema.description || ''}`);
        }
        lines.push(`\nFor detailed help: nansen ${command} <subcommand> --help`);
        output(lines.join('\n'));
        notify();
        return { type: 'command-help', command };
      }
    }
    // Fallback to main help
    output(BANNER + HELP);
    notify();
    return { type: 'help' };
  }

  if (!commands[command]) {
    const errorData = { 
      error: `Unknown command: ${command}`,
      available: Object.keys(commands)
    };
    const formatted = formatOutput(errorData, { pretty, table });
    output(formatted.text);
    notify();
    exit(1);
    return { type: 'error', data: errorData };
  }

  // Commands that don't require API authentication
  if (NO_AUTH_COMMANDS.includes(command)) {
    const result = await commands[command](subArgs, null, flags, options);
    
    // Schema and wallet commands return data that should be output
    if ((command === 'schema' || command === 'wallet') && result) {
      const formatted = formatOutput(result, { pretty, table: false });
      output(formatted.text);
      notify();
      return { type: command, data: result };
    }

    notify();
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
      notify();
      return { type: 'stream', data: result };
    }

    const successData = { success: true, data: result };
    const formatted = formatOutput(successData, { pretty, table, csv });
    output(formatted.text);
    notify();
    return { type: csv ? 'csv' : 'success', data: result };
  } catch (error) {
    const errorData = formatError(error);
    const formatted = formatOutput(errorData, { pretty, table, csv });
    errorOutput(formatted.text);
    notify();
    exit(1);
    return { type: 'error', data: errorData };
  }
}
