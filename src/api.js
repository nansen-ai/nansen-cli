/**
 * Nansen API Client
 * Handles all HTTP communication with the Nansen API
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ============= Config Paths =============

const CONFIG_DIR = path.join(process.env.HOME || process.env.USERPROFILE || '', '.nansen');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

/**
 * Get the config directory path
 */
export function getConfigDir() {
  return CONFIG_DIR;
}

/**
 * Get the config file path
 */
export function getConfigFile() {
  return CONFIG_FILE;
}

/**
 * Save config to ~/.nansen/config.json
 */
export function saveConfig(config) {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { mode: 0o700, recursive: true });
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

/**
 * Delete config file (logout)
 */
export function deleteConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    fs.unlinkSync(CONFIG_FILE);
    return true;
  }
  return false;
}

// ============= Address Validation =============

const ADDRESS_PATTERNS = {
  // EVM chains: 0x followed by 40 hex chars
  evm: /^0x[a-fA-F0-9]{40}$/,
  // Solana: Base58, 32-44 chars (no 0, O, I, l)
  solana: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
  // Bitcoin: Various formats
  bitcoin: /^(1|3|bc1)[a-zA-HJ-NP-Z0-9]{25,62}$/,
};

const EVM_CHAINS = [
  'ethereum', 'arbitrum', 'base', 'bnb', 'polygon', 'optimism',
  'avalanche', 'linea', 'scroll', 'zksync', 'mantle', 'ronin',
  'sei', 'plasma', 'sonic', 'unichain', 'monad', 'hyperevm', 'iotaevm'
];

/**
 * Validate address format for a given chain
 * @param {string} address - The address to validate
 * @param {string} chain - The blockchain (ethereum, solana, etc.)
 * @returns {{valid: boolean, error?: string}}
 */
export function validateAddress(address, chain = 'ethereum') {
  if (!address || typeof address !== 'string') {
    return { valid: false, error: 'Address is required' };
  }

  const trimmed = address.trim();
  
  if (EVM_CHAINS.includes(chain)) {
    if (!ADDRESS_PATTERNS.evm.test(trimmed)) {
      return { valid: false, error: `Invalid EVM address format. Expected 0x followed by 40 hex characters.` };
    }
  } else if (chain === 'solana') {
    if (!ADDRESS_PATTERNS.solana.test(trimmed)) {
      return { valid: false, error: `Invalid Solana address format. Expected Base58 string (32-44 chars).` };
    }
  } else if (chain === 'bitcoin') {
    if (!ADDRESS_PATTERNS.bitcoin.test(trimmed)) {
      return { valid: false, error: `Invalid Bitcoin address format.` };
    }
  }
  // For unknown chains, allow any non-empty string (API will validate)
  
  return { valid: true };
}

/**
 * Validate token address (same rules as wallet address)
 */
export function validateTokenAddress(tokenAddress, chain = 'solana') {
  return validateAddress(tokenAddress, chain);
}

function loadConfig() {
  // Priority: 1. Environment variables, 2. ~/.nansen/config.json, 3. Local config.json
  
  // Check environment variables first (highest priority)
  if (process.env.NANSEN_API_KEY) {
    return {
      apiKey: process.env.NANSEN_API_KEY,
      baseUrl: process.env.NANSEN_BASE_URL || 'https://api.nansen.ai'
    };
  }
  
  // Check ~/.nansen/config.json (from `nansen login`)
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch (e) {
      // Ignore parse errors, continue to next option
    }
  }
  
  // Check local config.json (for development)
  const localConfig = path.join(__dirname, '..', 'config.json');
  if (fs.existsSync(localConfig)) {
    return JSON.parse(fs.readFileSync(localConfig, 'utf8'));
  }
  
  // No config found
  return {
    apiKey: null,
    baseUrl: 'https://api.nansen.ai'
  };
}

const config = loadConfig();

export class NansenAPI {
  constructor(apiKey = config.apiKey, baseUrl = config.baseUrl) {
    if (!apiKey) {
      throw new Error('API key required. Run `nansen login` or set NANSEN_API_KEY environment variable.');
    }
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  async request(endpoint, body = {}, options = {}) {
    const url = `${this.baseUrl}${endpoint}`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': this.apiKey,
        ...options.headers
      },
      body: JSON.stringify(body)
    });

    const data = await response.json();

    if (!response.ok) {
      const error = new Error(data.message || data.error || `API error: ${response.status}`);
      error.status = response.status;
      error.data = data;
      throw error;
    }

    return data;
  }

  // ============= Smart Money Endpoints =============
  
  async smartMoneyNetflow(params = {}) {
    const { chains = ['solana'], filters = {}, orderBy, pagination } = params;
    return this.request('/api/v1/smart-money/netflow', {
      chains,
      filters,
      order_by: orderBy,
      pagination
    });
  }

  async smartMoneyDexTrades(params = {}) {
    const { chains = ['solana'], filters = {}, orderBy, pagination } = params;
    return this.request('/api/v1/smart-money/dex-trades', {
      chains,
      filters,
      order_by: orderBy,
      pagination
    });
  }

  async smartMoneyPerpTrades(params = {}) {
    const { filters = {}, orderBy, pagination } = params;
    return this.request('/api/v1/smart-money/perp-trades', {
      filters,
      order_by: orderBy,
      pagination
    });
  }

  async smartMoneyHoldings(params = {}) {
    const { chains = ['solana'], filters = {}, orderBy, pagination } = params;
    return this.request('/api/v1/smart-money/holdings', {
      chains,
      filters,
      order_by: orderBy,
      pagination
    });
  }

  async smartMoneyDcas(params = {}) {
    const { filters = {}, orderBy, pagination } = params;
    return this.request('/api/v1/smart-money/dcas', {
      filters,
      order_by: orderBy,
      pagination
    });
  }

  async smartMoneyHistoricalHoldings(params = {}) {
    const { chains = ['solana'], filters = {}, orderBy, pagination, days = 30 } = params;
    const to = new Date().toISOString().split('T')[0];
    const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    return this.request('/api/v1/smart-money/historical-holdings', {
      chains,
      date_range: { from, to },
      filters,
      order_by: orderBy,
      pagination
    });
  }

  // ============= Profiler Endpoints =============

  async addressBalance(params = {}) {
    const { address, entityName, chain = 'ethereum', hideSpamToken = true, filters = {}, orderBy } = params;
    if (address) {
      const validation = validateAddress(address, chain);
      if (!validation.valid) throw new Error(validation.error);
    }
    return this.request('/api/v1/profiler/address/current-balance', {
      address,
      entity_name: entityName,
      chain,
      hide_spam_token: hideSpamToken,
      filters,
      order_by: orderBy
    });
  }

  async addressLabels(params = {}) {
    const { address, chain = 'ethereum', pagination = { page: 1, recordsPerPage: 100 } } = params;
    if (address) {
      const validation = validateAddress(address, chain);
      if (!validation.valid) throw new Error(validation.error);
    }
    return this.request('/api/beta/profiler/address/labels', {
      parameters: { address, chain },
      pagination
    });
  }

  async addressTransactions(params = {}) {
    const { address, chain = 'ethereum', filters = {}, orderBy, pagination } = params;
    if (address) {
      const validation = validateAddress(address, chain);
      if (!validation.valid) throw new Error(validation.error);
    }
    return this.request('/api/v1/profiler/address/transactions', {
      address,
      chain,
      filters,
      order_by: orderBy,
      pagination
    });
  }

  async addressPnl(params = {}) {
    const { address, chain = 'ethereum' } = params;
    if (address) {
      const validation = validateAddress(address, chain);
      if (!validation.valid) throw new Error(validation.error);
    }
    return this.request('/api/v1/profiler/address/pnl-and-trade-performance', {
      address,
      chain
    });
  }

  async entitySearch(params = {}) {
    const { query, pagination } = params;
    return this.request('/api/beta/profiler/entity-name-search', {
      parameters: { query },
      pagination
    });
  }

  async addressHistoricalBalances(params = {}) {
    const { address, chain = 'ethereum', filters = {}, orderBy, pagination, days = 30 } = params;
    if (address) {
      const validation = validateAddress(address, chain);
      if (!validation.valid) throw new Error(validation.error);
    }
    const to = new Date().toISOString().split('T')[0];
    const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    return this.request('/api/v1/profiler/address/historical-balances', {
      address,
      chain,
      date: { from, to },
      filters,
      order_by: orderBy,
      pagination
    });
  }

  async addressRelatedWallets(params = {}) {
    const { address, chain = 'ethereum', filters = {}, orderBy, pagination } = params;
    if (address) {
      const validation = validateAddress(address, chain);
      if (!validation.valid) throw new Error(validation.error);
    }
    return this.request('/api/v1/profiler/address/related-wallets', {
      address,
      chain,
      filters,
      order_by: orderBy,
      pagination
    });
  }

  async addressCounterparties(params = {}) {
    const { address, chain = 'ethereum', filters = {}, orderBy, pagination, days = 30 } = params;
    if (address) {
      const validation = validateAddress(address, chain);
      if (!validation.valid) throw new Error(validation.error);
    }
    const to = new Date().toISOString().split('T')[0];
    const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    return this.request('/api/v1/profiler/address/counterparties', {
      address,
      chain,
      date: { from, to },
      filters,
      order_by: orderBy,
      pagination
    });
  }

  async addressPnlSummary(params = {}) {
    const { address, chain = 'ethereum', filters = {}, orderBy, pagination, days = 30 } = params;
    if (address) {
      const validation = validateAddress(address, chain);
      if (!validation.valid) throw new Error(validation.error);
    }
    const to = new Date().toISOString().split('T')[0];
    const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    return this.request('/api/v1/profiler/address/pnl-summary', {
      address,
      chain,
      date: { from, to },
      filters,
      order_by: orderBy,
      pagination
    });
  }

  async addressPerpPositions(params = {}) {
    const { address, filters = {}, orderBy, pagination } = params;
    // Perp positions work with HL addresses (not validated)
    return this.request('/api/v1/profiler/perp-positions', {
      address,
      filters,
      order_by: orderBy,
      pagination
    });
  }

  async addressPerpTrades(params = {}) {
    const { address, filters = {}, orderBy, pagination, days = 30 } = params;
    const to = new Date().toISOString().split('T')[0];
    const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    return this.request('/api/v1/profiler/perp-trades', {
      address,
      date: { from, to },
      filters,
      order_by: orderBy,
      pagination
    });
  }

  // ============= Token God Mode Endpoints =============

  async tokenScreener(params = {}) {
    const { chains = ['solana'], timeframe = '24h', filters = {}, orderBy, pagination } = params;
    return this.request('/api/v1/token-screener', {
      chains,
      timeframe,
      filters,
      order_by: orderBy,
      pagination
    });
  }

  async tokenHolders(params = {}) {
    const { tokenAddress, chain = 'solana', labelType = 'all_holders', filters = {}, orderBy, pagination } = params;
    if (tokenAddress) {
      const validation = validateTokenAddress(tokenAddress, chain);
      if (!validation.valid) throw new Error(validation.error);
    }
    return this.request('/api/v1/tgm/holders', {
      token_address: tokenAddress,
      chain,
      label_type: labelType,
      filters,
      order_by: orderBy,
      pagination
    });
  }

  async tokenFlows(params = {}) {
    const { tokenAddress, chain = 'solana', filters = {}, orderBy, pagination } = params;
    if (tokenAddress) {
      const validation = validateTokenAddress(tokenAddress, chain);
      if (!validation.valid) throw new Error(validation.error);
    }
    return this.request('/api/v1/tgm/flows', {
      token_address: tokenAddress,
      chain,
      filters,
      order_by: orderBy,
      pagination
    });
  }

  async tokenDexTrades(params = {}) {
    const { tokenAddress, chain = 'solana', onlySmartMoney = false, filters = {}, orderBy, pagination, days = 7 } = params;
    if (tokenAddress) {
      const validation = validateTokenAddress(tokenAddress, chain);
      if (!validation.valid) throw new Error(validation.error);
    }
    const to = new Date().toISOString().split('T')[0];
    const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    
    // Apply smart money filter via filters object
    if (onlySmartMoney) {
      filters.include_smart_money_labels = filters.include_smart_money_labels || 
        ['Fund', 'Smart Trader', '30D Smart Trader', '90D Smart Trader', '180D Smart Trader'];
    }
    
    return this.request('/api/v1/tgm/dex-trades', {
      token_address: tokenAddress,
      chain,
      date: { from, to },
      filters,
      order_by: orderBy,
      pagination
    });
  }

  async tokenPnlLeaderboard(params = {}) {
    const { tokenAddress, chain = 'solana', filters = {}, orderBy, pagination, days = 30 } = params;
    if (tokenAddress) {
      const validation = validateTokenAddress(tokenAddress, chain);
      if (!validation.valid) throw new Error(validation.error);
    }
    const to = new Date().toISOString().split('T')[0];
    const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    return this.request('/api/v1/tgm/pnl-leaderboard', {
      token_address: tokenAddress,
      chain,
      date: { from, to },
      filters,
      order_by: orderBy,
      pagination
    });
  }

  async tokenWhoBoughtSold(params = {}) {
    const { tokenAddress, chain = 'solana', filters = {}, orderBy, pagination } = params;
    if (tokenAddress) {
      const validation = validateTokenAddress(tokenAddress, chain);
      if (!validation.valid) throw new Error(validation.error);
    }
    return this.request('/api/v1/tgm/who-bought-sold', {
      token_address: tokenAddress,
      chain,
      filters,
      order_by: orderBy,
      pagination
    });
  }

  async tokenFlowIntelligence(params = {}) {
    const { tokenAddress, chain = 'solana', filters = {}, orderBy, pagination } = params;
    if (tokenAddress) {
      const validation = validateTokenAddress(tokenAddress, chain);
      if (!validation.valid) throw new Error(validation.error);
    }
    return this.request('/api/v1/tgm/flow-intelligence', {
      token_address: tokenAddress,
      chain,
      filters,
      order_by: orderBy,
      pagination
    });
  }

  async tokenTransfers(params = {}) {
    const { tokenAddress, chain = 'solana', filters = {}, orderBy, pagination, days = 7 } = params;
    if (tokenAddress) {
      const validation = validateTokenAddress(tokenAddress, chain);
      if (!validation.valid) throw new Error(validation.error);
    }
    const to = new Date().toISOString().split('T')[0];
    const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    return this.request('/api/v1/tgm/transfers', {
      token_address: tokenAddress,
      chain,
      date: { from, to },
      filters,
      order_by: orderBy,
      pagination
    });
  }

  async tokenJupDca(params = {}) {
    const { tokenAddress, filters = {}, orderBy, pagination } = params;
    // JUP DCA is Solana-only
    if (tokenAddress) {
      const validation = validateTokenAddress(tokenAddress, 'solana');
      if (!validation.valid) throw new Error(validation.error);
    }
    return this.request('/api/v1/tgm/jup-dca', {
      token_address: tokenAddress,
      filters,
      order_by: orderBy,
      pagination
    });
  }

  async tokenPerpTrades(params = {}) {
    const { tokenSymbol, filters = {}, orderBy, pagination, days = 30 } = params;
    const to = new Date().toISOString().split('T')[0];
    const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    return this.request('/api/v1/tgm/perp-trades', {
      token_symbol: tokenSymbol,
      date: { from, to },
      filters,
      order_by: orderBy,
      pagination
    });
  }

  async tokenPerpPositions(params = {}) {
    const { tokenSymbol, filters = {}, orderBy, pagination } = params;
    return this.request('/api/v1/tgm/perp-positions', {
      token_symbol: tokenSymbol,
      filters,
      order_by: orderBy,
      pagination
    });
  }

  async tokenPerpPnlLeaderboard(params = {}) {
    const { tokenSymbol, filters = {}, orderBy, pagination, days = 30 } = params;
    const to = new Date().toISOString().split('T')[0];
    const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    return this.request('/api/v1/tgm/perp-pnl-leaderboard', {
      token_symbol: tokenSymbol,
      date: { from, to },
      filters,
      order_by: orderBy,
      pagination
    });
  }

  // ============= Portfolio Endpoints =============

  async portfolioDefiHoldings(params = {}) {
    const { walletAddress } = params;
    return this.request('/api/v1/portfolio/defi-holdings', {
      wallet_address: walletAddress
    });
  }
}

export default NansenAPI;
