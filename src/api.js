/**
 * Nansen API Client
 * Handles all HTTP communication with the Nansen API
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ============= Error Codes =============

/**
 * Structured error codes for programmatic handling by AI agents
 */
export const ErrorCode = {
  // Authentication & Authorization
  UNAUTHORIZED: 'UNAUTHORIZED',           // 401 - Invalid or missing API key
  FORBIDDEN: 'FORBIDDEN',                 // 403 - Valid key but insufficient permissions
  CREDITS_EXHAUSTED: 'CREDITS_EXHAUSTED', // 403 - Insufficient API credits
  PAYMENT_REQUIRED: 'PAYMENT_REQUIRED',   // 402 - x402 payment required
  
  // Rate Limiting
  RATE_LIMITED: 'RATE_LIMITED',           // 429 - Too many requests
  
  // Validation Errors
  INVALID_ADDRESS: 'INVALID_ADDRESS',     // Address format validation failed
  INVALID_TOKEN: 'INVALID_TOKEN',         // Token address validation failed
  INVALID_CHAIN: 'INVALID_CHAIN',         // Unsupported or invalid chain
  INVALID_PARAMS: 'INVALID_PARAMS',       // Generic parameter validation error
  MISSING_PARAM: 'MISSING_PARAM',         // Required parameter not provided
  UNSUPPORTED_FILTER: 'UNSUPPORTED_FILTER', // Filter not supported for this token/chain
  
  // Resource Errors
  NOT_FOUND: 'NOT_FOUND',                 // 404 - Resource not found
  TOKEN_NOT_FOUND: 'TOKEN_NOT_FOUND',     // Token doesn't exist
  ADDRESS_NOT_FOUND: 'ADDRESS_NOT_FOUND', // Address has no data
  
  // Server Errors
  SERVER_ERROR: 'SERVER_ERROR',           // 500+ - Nansen API internal error
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE', // 503 - API temporarily down
  
  // Client Errors
  NETWORK_ERROR: 'NETWORK_ERROR',         // Connection failed
  TIMEOUT: 'TIMEOUT',                     // Request timed out
  
  // Generic
  UNKNOWN: 'UNKNOWN',                     // Unclassified error
};

/**
 * Custom error class with structured error codes
 */
export class NansenError extends Error {
  constructor(message, code = ErrorCode.UNKNOWN, status = null, data = null) {
    super(message);
    this.name = 'NansenError';
    this.code = code;
    this.status = status;
    this.data = data;
  }

  toJSON() {
    return {
      error: this.message,
      code: this.code,
      status: this.status,
      details: this.data,
    };
  }
}

/**
 * Map HTTP status codes to error codes
 */
function statusToErrorCode(status, data = {}) {
  const message = data?.message || data?.error || '';
  const messageLower = message.toLowerCase();
  
  switch (status) {
    case 400:
    case 422:
      if (messageLower.includes('field') && messageLower.includes('not recognized')) return ErrorCode.UNSUPPORTED_FILTER;
      if (messageLower.includes('address')) return ErrorCode.INVALID_ADDRESS;
      if (messageLower.includes('token')) return ErrorCode.INVALID_TOKEN;
      if (messageLower.includes('chain')) return ErrorCode.INVALID_CHAIN;
      return ErrorCode.INVALID_PARAMS;
    case 401:
      return ErrorCode.UNAUTHORIZED;
    case 402:
      return ErrorCode.PAYMENT_REQUIRED;
    case 403:
      if (messageLower.includes('credit') || messageLower.includes('insufficient')) return ErrorCode.CREDITS_EXHAUSTED;
      return ErrorCode.FORBIDDEN;
    case 404:
      if (messageLower.includes('token')) return ErrorCode.TOKEN_NOT_FOUND;
      if (messageLower.includes('address') || messageLower.includes('wallet')) return ErrorCode.ADDRESS_NOT_FOUND;
      return ErrorCode.NOT_FOUND;
    case 429:
      return ErrorCode.RATE_LIMITED;
    case 500:
    case 502:
      return ErrorCode.SERVER_ERROR;
    case 503:
      return ErrorCode.SERVICE_UNAVAILABLE;
    case 504:
      return ErrorCode.TIMEOUT;
    default:
      if (status >= 500) return ErrorCode.SERVER_ERROR;
      if (status >= 400) return ErrorCode.INVALID_PARAMS;
      return ErrorCode.UNKNOWN;
  }
}

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

// ============= Response Cache =============

const CACHE_DIR = path.join(CONFIG_DIR, 'cache');
const DEFAULT_CACHE_TTL = 300; // 5 minutes

import crypto from 'crypto';

/**
 * Generate cache key from endpoint and request body
 */
function getCacheKey(endpoint, body) {
  const data = JSON.stringify({ endpoint, body });
  return crypto.createHash('md5').update(data).digest('hex');
}

/**
 * Get cached response if valid
 */
export function getCachedResponse(endpoint, body, ttlSeconds = DEFAULT_CACHE_TTL) {
  const cacheKey = getCacheKey(endpoint, body);
  const cacheFile = path.join(CACHE_DIR, `${cacheKey}.json`);
  
  if (!fs.existsSync(cacheFile)) {
    return null;
  }
  
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    const age = (Date.now() - cached.timestamp) / 1000;
    
    if (ttlSeconds <= 0 || age > ttlSeconds) {
      // Cache expired or TTL is 0, delete it
      fs.unlinkSync(cacheFile);
      return null;
    }
    
    return { ...cached.data, _meta: { ...cached.data._meta, fromCache: true, cacheAge: Math.round(age) } };
  } catch (e) {
    // Invalid cache file, delete it
    try { fs.unlinkSync(cacheFile); } catch {}
    return null;
  }
}

/**
 * Save response to cache
 */
export function setCachedResponse(endpoint, body, data) {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { mode: 0o700, recursive: true });
  }
  
  const cacheKey = getCacheKey(endpoint, body);
  const cacheFile = path.join(CACHE_DIR, `${cacheKey}.json`);
  
  const cached = {
    timestamp: Date.now(),
    endpoint,
    data
  };
  
  fs.writeFileSync(cacheFile, JSON.stringify(cached), { mode: 0o600 });
}

/**
 * Clear all cached responses
 */
export function clearCache() {
  if (fs.existsSync(CACHE_DIR)) {
    const files = fs.readdirSync(CACHE_DIR);
    for (const file of files) {
      if (file.endsWith('.json')) {
        fs.unlinkSync(path.join(CACHE_DIR, file));
      }
    }
    return files.length;
  }
  return 0;
}

/**
 * Get cache directory path
 */
export function getCacheDir() {
  return CACHE_DIR;
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
  'avalanche', 'linea', 'scroll', 'mantle', 'ronin',
  'sei', 'plasma', 'sonic', 'monad', 'hyperevm', 'iotaevm'
];

/**
 * Validate address format for a given chain
 * @param {string} address - The address to validate
 * @param {string} chain - The blockchain (ethereum, solana, etc.)
 * @returns {{valid: boolean, error?: string, code?: string}}
 */
export function validateAddress(address, chain = 'ethereum') {
  if (!address || typeof address !== 'string') {
    return { valid: false, error: 'Address is required', code: ErrorCode.MISSING_PARAM };
  }

  const trimmed = address.trim();
  
  if (EVM_CHAINS.includes(chain)) {
    if (!ADDRESS_PATTERNS.evm.test(trimmed)) {
      return { valid: false, error: `Invalid EVM address format. Expected 0x followed by 40 hex characters.`, code: ErrorCode.INVALID_ADDRESS };
    }
  } else if (chain === 'solana') {
    if (!ADDRESS_PATTERNS.solana.test(trimmed)) {
      return { valid: false, error: `Invalid Solana address format. Expected Base58 string (32-44 chars).`, code: ErrorCode.INVALID_ADDRESS };
    }
  } else if (chain === 'bitcoin') {
    if (!ADDRESS_PATTERNS.bitcoin.test(trimmed)) {
      return { valid: false, error: `Invalid Bitcoin address format.`, code: ErrorCode.INVALID_ADDRESS };
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

// ============= Retry Configuration =============

const DEFAULT_RETRY_OPTIONS = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  retryOnStatus: [429, 500, 502, 503, 504],
};

/**
 * Sleep for a given number of milliseconds
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Calculate delay with exponential backoff and jitter
 */
function calculateBackoff(attempt, baseDelayMs, maxDelayMs, retryAfterMs = null) {
  // If server specifies retry-after, use it (with some jitter)
  if (retryAfterMs) {
    const jitter = Math.random() * 1000;
    return Math.min(retryAfterMs + jitter, maxDelayMs);
  }
  
  // Exponential backoff: base * 2^attempt + random jitter
  const exponentialDelay = baseDelayMs * Math.pow(2, attempt);
  const jitter = Math.random() * baseDelayMs;
  return Math.min(exponentialDelay + jitter, maxDelayMs);
}

/**
 * Parse retry-after header (supports seconds or HTTP date)
 */
function parseRetryAfter(headerValue) {
  if (!headerValue) return null;
  
  // Try parsing as seconds
  const seconds = parseInt(headerValue, 10);
  if (!isNaN(seconds)) {
    return seconds * 1000;
  }
  
  // Try parsing as HTTP date
  const date = new Date(headerValue);
  if (!isNaN(date.getTime())) {
    return Math.max(0, date.getTime() - Date.now());
  }
  
  return null;
}

export class NansenAPI {
  constructor(apiKey = config.apiKey, baseUrl = config.baseUrl, options = {}) {
    this.apiKey = apiKey || null;
    this.baseUrl = baseUrl;
    this.retryOptions = { ...DEFAULT_RETRY_OPTIONS, ...options.retry };
    this.cacheOptions = { 
      enabled: options.cache?.enabled ?? false,
      ttl: options.cache?.ttl ?? DEFAULT_CACHE_TTL
    };
  }

  static cleanBody(body) {
    return Object.fromEntries(
      Object.entries(body).filter(([_, v]) =>
        v !== undefined && v !== null &&
        !(typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0)
      )
    );
  }

  async request(endpoint, body = {}, options = {}) {
    const url = `${this.baseUrl}${endpoint}`;
    const { maxRetries, baseDelayMs, maxDelayMs, retryOnStatus } = this.retryOptions;
    const shouldRetry = options.retry !== false; // Allow disabling retry per-request
    
    // Check cache first (if enabled and not bypassed)
    const useCache = options.cache !== false && this.cacheOptions.enabled;
    const cacheTtl = options.cacheTtl ?? this.cacheOptions.ttl;
    
    if (useCache) {
      const cached = getCachedResponse(endpoint, body, cacheTtl);
      if (cached) {
        return cached;
      }
    }
    
    let lastError;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(this.apiKey ? { 'apikey': this.apiKey } : {}),
            ...options.headers
          },
          body: JSON.stringify(NansenAPI.cleanBody(body))
        });
      } catch (err) {
        // Network-level errors - retry these too
        lastError = new NansenError(
          `Network error: ${err.message}`,
          ErrorCode.NETWORK_ERROR,
          null,
          { originalError: err.message, attempt: attempt + 1 }
        );
        
        if (shouldRetry && attempt < maxRetries) {
          const delayMs = calculateBackoff(attempt, baseDelayMs, maxDelayMs);
          await sleep(delayMs);
          continue;
        }
        throw lastError;
      }

      let data;
      try {
        data = await response.json();
      } catch (err) {
        // Non-JSON response (rare, usually server errors)
        const error = new NansenError(
          `Invalid response from API (status ${response.status})`,
          response.status >= 500 ? ErrorCode.SERVER_ERROR : ErrorCode.UNKNOWN,
          response.status,
          { body: await response.text().catch(() => null), attempt: attempt + 1 }
        );
        
        if (shouldRetry && attempt < maxRetries && response.status >= 500) {
          const delayMs = calculateBackoff(attempt, baseDelayMs, maxDelayMs);
          await sleep(delayMs);
          lastError = error;
          continue;
        }
        throw error;
      }

      if (!response.ok) {
        let message = data.message || data.error || `API error: ${response.status}`;
        const code = statusToErrorCode(response.status, data);
        const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));

        // Enhance messages for specific error codes
        if (code === ErrorCode.UNSUPPORTED_FILTER) {
          message = message.replace(/\.+$/, '') + '. This filter is not supported for this token/chain combination. Do not retry.';
        } else if (code === ErrorCode.CREDITS_EXHAUSTED) {
          message = message.replace(/\.+$/, '') + '. No retry will help. Check your Nansen dashboard for credit balance.';
        } else if (code === ErrorCode.PAYMENT_REQUIRED) {
          message = 'Payment required (x402). This endpoint requires on-chain payment.';
          const paymentHeader = response.headers.get('payment-required');
          if (paymentHeader) {
            try {
              data.paymentRequirements = JSON.parse(atob(paymentHeader));
            } catch {
              data.paymentRequiredRaw = paymentHeader;
            }
          }
        }

        lastError = new NansenError(message, code, response.status, {
          ...data,
          attempt: attempt + 1,
          retryAfterMs
        });
        
        // Retry on specific status codes
        if (shouldRetry && attempt < maxRetries && retryOnStatus.includes(response.status)) {
          const delayMs = calculateBackoff(attempt, baseDelayMs, maxDelayMs, retryAfterMs);
          await sleep(delayMs);
          continue;
        }
        
        throw lastError;
      }

      // Success - add retry metadata if we retried
      if (attempt > 0) {
        data._meta = { ...(data._meta || {}), retriedAttempts: attempt };
      }
      
      // Cache successful response
      if (useCache) {
        setCachedResponse(endpoint, body, data);
      }
      
      return data;
    }
    
    // Should not reach here, but just in case
    throw lastError;
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
      if (!validation.valid) throw new NansenError(validation.error, validation.code);
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
      if (!validation.valid) throw new NansenError(validation.error, validation.code);
    }
    return this.request('/api/beta/profiler/address/labels', {
      parameters: { address, chain },
      pagination
    });
  }

  async addressTransactions(params = {}) {
    const { address, chain = 'ethereum', filters = {}, orderBy, pagination, days = 30, date } = params;
    if (address) {
      const validation = validateAddress(address, chain);
      if (!validation.valid) throw new NansenError(validation.error, validation.code);
    }
    const dateRange = date || (() => {
      const to = new Date().toISOString().split('T')[0];
      const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      return { from, to };
    })();
    return this.request('/api/v1/profiler/address/transactions', {
      address,
      chain,
      date: dateRange,
      filters,
      order_by: orderBy,
      pagination
    });
  }

  async addressPnl(params = {}) {
    const { address, chain = 'ethereum', date, days = 30, pagination } = params;
    if (address) {
      const validation = validateAddress(address, chain);
      if (!validation.valid) throw new NansenError(validation.error, validation.code);
    }
    // Build date range
    let dateRange = date;
    if (!dateRange) {
      const to = new Date().toISOString().split('T')[0];
      const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      dateRange = { from, to };
    }
    return this.request('/api/v1/profiler/address/pnl', {
      address,
      chain,
      date: dateRange,
      pagination
    });
  }

  async entitySearch(params = {}) {
    const { query } = params;
    return this.request('/api/v1/search/entity-name', {
      search_query: query
    });
  }

  async generalSearch(params = {}) {
    const { query, resultType = 'any', chain, limit = 25 } = params;
    if (!query) {
      throw new NansenError('Search query is required', ErrorCode.MISSING_PARAM);
    }
    const body = {
      search_query: query,
      result_type: resultType,
      limit
    };
    if (chain) body.chain = chain;
    return this.request('/api/v1/search/general', body);
  }

  async addressHistoricalBalances(params = {}) {
    const { address, chain = 'ethereum', filters = {}, orderBy, pagination, days = 30 } = params;
    if (address) {
      const validation = validateAddress(address, chain);
      if (!validation.valid) throw new NansenError(validation.error, validation.code);
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
    const { address, chain = 'ethereum', orderBy, pagination } = params;
    if (address) {
      const validation = validateAddress(address, chain);
      if (!validation.valid) throw new NansenError(validation.error, validation.code);
    }
    return this.request('/api/v1/profiler/address/related-wallets', {
      address,
      chain,
      order_by: orderBy,
      pagination
    });
  }

  async addressCounterparties(params = {}) {
    const { address, chain = 'ethereum', filters = {}, orderBy, pagination, days = 30 } = params;
    if (address) {
      const validation = validateAddress(address, chain);
      if (!validation.valid) throw new NansenError(validation.error, validation.code);
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
    const { address, chain = 'ethereum', orderBy, pagination, days = 30 } = params;
    if (address) {
      const validation = validateAddress(address, chain);
      if (!validation.valid) throw new NansenError(validation.error, validation.code);
    }
    const to = new Date().toISOString().split('T')[0];
    const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    return this.request('/api/v1/profiler/address/pnl-summary', {
      address,
      chain,
      date: { from, to },
      order_by: orderBy,
      pagination
    });
  }

  async addressPerpPositions(params = {}) {
    const { address, filters = {}, orderBy } = params;
    // Perp positions work with HL addresses (not validated)
    // Note: This endpoint does NOT support pagination parameter
    return this.request('/api/v1/profiler/perp-positions', {
      address,
      filters,
      order_by: orderBy
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
      if (!validation.valid) throw new NansenError(validation.error, validation.code);
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
    const { tokenAddress, chain = 'solana', filters = {}, orderBy, pagination, days = 30, date } = params;
    if (tokenAddress) {
      const validation = validateTokenAddress(tokenAddress, chain);
      if (!validation.valid) throw new NansenError(validation.error, validation.code);
    }
    const dateRange = date || (() => {
      const to = new Date().toISOString().split('T')[0];
      const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      return { from, to };
    })();
    return this.request('/api/v1/tgm/flows', {
      token_address: tokenAddress,
      chain,
      date: dateRange,
      filters,
      order_by: orderBy,
      pagination
    });
  }

  async tokenDexTrades(params = {}) {
    const { tokenAddress, chain = 'solana', onlySmartMoney = false, filters = {}, orderBy, pagination, days = 7 } = params;
    if (tokenAddress) {
      const validation = validateTokenAddress(tokenAddress, chain);
      if (!validation.valid) throw new NansenError(validation.error, validation.code);
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
      if (!validation.valid) throw new NansenError(validation.error, validation.code);
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
    const { tokenAddress, chain = 'solana', filters = {}, orderBy, pagination, days = 30, date } = params;
    if (tokenAddress) {
      const validation = validateTokenAddress(tokenAddress, chain);
      if (!validation.valid) throw new NansenError(validation.error, validation.code);
    }
    const dateRange = date || (() => {
      const to = new Date().toISOString().split('T')[0];
      const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      return { from, to };
    })();
    return this.request('/api/v1/tgm/who-bought-sold', {
      token_address: tokenAddress,
      chain,
      date: dateRange,
      filters,
      order_by: orderBy,
      pagination
    });
  }

  async tokenFlowIntelligence(params = {}) {
    const { tokenAddress, chain = 'solana' } = params;
    if (tokenAddress) {
      const validation = validateTokenAddress(tokenAddress, chain);
      if (!validation.valid) throw new NansenError(validation.error, validation.code);
    }
    return this.request('/api/v1/tgm/flow-intelligence', {
      token_address: tokenAddress,
      chain
    });
  }

  async tokenTransfers(params = {}) {
    const { tokenAddress, chain = 'solana', filters = {}, orderBy, pagination, days = 7 } = params;
    if (tokenAddress) {
      const validation = validateTokenAddress(tokenAddress, chain);
      if (!validation.valid) throw new NansenError(validation.error, validation.code);
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
      if (!validation.valid) throw new NansenError(validation.error, validation.code);
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

  async tokenInformation(params = {}) {
    const { tokenAddress, chain = 'solana', timeframe = '24h' } = params;
    if (tokenAddress) {
      const validation = validateTokenAddress(tokenAddress, chain);
      if (!validation.valid) throw new NansenError(validation.error, validation.code);
    }
    return this.request('/api/v1/tgm/token-information', {
      token_address: tokenAddress,
      chain,
      timeframe
    });
  }

  // ============= OHLCV Endpoints =============

  async tokenOhlcv(params = {}) {
    const { tokenAddress, chain = 'solana', from, to, resolution = '1h', days = 7 } = params;
    if (tokenAddress) {
      const validation = validateTokenAddress(tokenAddress, chain);
      if (!validation.valid) throw new NansenError(validation.error, validation.code);
    }
    if (!tokenAddress) {
      throw new NansenError('Token address is required', ErrorCode.MISSING_PARAM);
    }

    // Calculate date range
    const toDate = to ? new Date(to) : new Date();
    const fromDate = from ? new Date(from) : new Date(toDate.getTime() - days * 24 * 60 * 60 * 1000);

    const dateRange = {
      from: fromDate.toISOString(),
      to: toDate.toISOString()
    };

    // Determine if low or high timeframe based on resolution
    const highTimeframeTypes = ['day', 'week', 'month', 'year'];
    const lowTimeframeMinutes = {
      '1m': 1, '5m': 5, '10m': 10, '15m': 15, '30m': 30,
      '1h': 60, '2h': 120, '4h': 240, '6h': 360, '12h': 720
    };

    if (highTimeframeTypes.includes(resolution)) {
      // High timeframe: day, week, month, year
      return this.request('/api/beta/tgm/prices/high-timeframe', {
        parameters: {
          tokenAddress,
          chain,
          date: dateRange,
          inputResolutionType: resolution,
          inputResolution: 1
        }
      });
    } else {
      // Low timeframe: minutes-based
      const minutes = lowTimeframeMinutes[resolution];
      if (!minutes) {
        throw new NansenError(
          `Invalid resolution: ${resolution}. Use: ${Object.keys(lowTimeframeMinutes).join(', ')}, day, week, month, year`,
          ErrorCode.INVALID_PARAMS
        );
      }
      return this.request('/api/beta/tgm/prices/low-timeframe', {
        parameters: {
          tokenAddress,
          chain,
          date: dateRange,
          minutesResolution: minutes
        }
      });
    }
  }

  // ============= Perp Endpoints =============

  async perpScreener(params = {}) {
    const { filters = {}, orderBy, pagination, days = 30 } = params;
    const to = new Date().toISOString().split('T')[0];
    const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    return this.request('/api/v1/perp-screener', {
      date: { from, to },
      filters,
      order_by: orderBy,
      pagination
    });
  }

  async perpLeaderboard(params = {}) {
    const { filters = {}, orderBy, pagination, days = 30 } = params;
    const to = new Date().toISOString().split('T')[0];
    const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    return this.request('/api/v1/perp-leaderboard', {
      date: { from, to },
      filters,
      order_by: orderBy,
      pagination
    });
  }

  // ============= Points Endpoints =============

  async pointsLeaderboard(params = {}) {
    const { tier, pagination } = params;
    return this.request('/api/v1/points/leaderboard', {
      tier,
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
