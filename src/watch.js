/**
 * Nansen CLI - Watch Command
 * Long-running polling for wallet and token activity, outputting NDJSON events.
 * Designed for AI agent consumption with heartbeats, state persistence, and graceful shutdown.
 */

import fs from 'fs';
import path from 'path';
import { validateAddress, validateTokenAddress, getConfigDir, sleep } from './api.js';

// ============= Constants =============

const MIN_INTERVAL = 10;
const MAX_INTERVAL = 3600;
const DEFAULT_INTERVAL = 30;
const DEFAULT_TIMEOUT = 0; // 0 = no timeout
const RETRY_ATTEMPTS = 3;
const RETRY_DELAYS = [1000, 2000, 4000]; // exponential backoff

const STATE_DIR = path.join(getConfigDir(), 'watch-state');
const STATE_FILE = path.join(STATE_DIR, 'watch-state.json');

// ============= State Persistence =============

export function loadWatchState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch {
    // Corrupted state file, start fresh
  }
  return {};
}

export function saveWatchState(state) {
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { mode: 0o700, recursive: true });
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

function getStateKey(type, address, chain) {
  return `${type}:${chain}:${address}`;
}

// ============= Interval Clamping =============

export function clampInterval(interval, warn) {
  let clamped = interval;
  let warning = null;
  if (clamped < MIN_INTERVAL) {
    warning = `Interval ${clamped}s is below minimum. Clamped to ${MIN_INTERVAL}s.`;
    clamped = MIN_INTERVAL;
  } else if (clamped > MAX_INTERVAL) {
    warning = `Interval ${clamped}s is above maximum. Clamped to ${MAX_INTERVAL}s.`;
    clamped = MAX_INTERVAL;
  }
  if (warning && warn) {
    warn(warning);
  }
  return { interval: clamped, warning };
}

// ============= Event Emitters =============

function emitEvent(output, event) {
  output(JSON.stringify(event));
}

function emitHeartbeat(output, nextPollIn) {
  emitEvent(output, {
    type: 'heartbeat',
    timestamp: new Date().toISOString(),
    nextPollIn
  });
}

function emitError(output, message, fatal = false) {
  emitEvent(output, {
    type: 'error',
    error: message,
    timestamp: new Date().toISOString(),
    fatal
  });
}

function emitData(output, type, data, address, chain) {
  emitEvent(output, {
    type,
    timestamp: new Date().toISOString(),
    address,
    chain,
    data
  });
}

function emitStarted(output, watchType, address, chain, interval, timeout) {
  emitEvent(output, {
    type: 'started',
    watchType,
    address,
    chain,
    interval,
    timeout: timeout || null,
    timestamp: new Date().toISOString()
  });
}

function emitStopped(output, reason) {
  emitEvent(output, {
    type: 'stopped',
    reason,
    timestamp: new Date().toISOString()
  });
}

// ============= Retry Logic =============

async function fetchWithRetry(fn, output) {
  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt < RETRY_ATTEMPTS - 1) {
        await sleep(RETRY_DELAYS[attempt]);
      } else {
        emitError(output, `API call failed after ${RETRY_ATTEMPTS} retries: ${err.message}`, false);
        return null;
      }
    }
  }
  return null;
}

// ============= Deduplication =============

function extractNewRecords(records, seenKeys) {
  if (!Array.isArray(records) || records.length === 0) return [];

  const newRecords = [];
  for (const record of records) {
    const key = generateRecordKey(record);
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      newRecords.push(record);
    }
  }
  return newRecords;
}

function generateRecordKey(record) {
  // Use transaction_hash if available (most unique), otherwise hash the record
  if (record.transaction_hash) return record.transaction_hash;
  if (record.tx_hash) return record.tx_hash;
  // Fallback: hash of key fields
  const keyFields = ['address', 'token_address', 'token_symbol', 'value_usd', 'block_timestamp', 'timestamp'];
  const parts = keyFields.map(f => record[f] || '').join('|');
  return parts;
}

function extractRecords(result) {
  if (!result) return [];
  if (Array.isArray(result)) return result;
  if (result.data && Array.isArray(result.data)) return result.data;
  if (result.results && Array.isArray(result.results)) return result.results;
  if (result.data?.results && Array.isArray(result.data.results)) return result.data.results;
  if (result.data?.data && Array.isArray(result.data.data)) return result.data.data;
  return [];
}

// ============= Watch Core =============

export async function runWatch(params) {
  const {
    watchType,     // 'wallet' or 'token'
    address,
    chain = 'ethereum',
    interval: rawInterval = DEFAULT_INTERVAL,
    once = false,
    timeout = DEFAULT_TIMEOUT,
    api,
    output = console.log,
    errorOutput = console.error,
    onSignal,      // for testing: custom signal handler setup
  } = params;

  // Validate address
  if (!address) {
    emitError(output, 'Address is required', true);
    return { exitCode: 1 };
  }

  if (watchType === 'wallet') {
    const validation = validateAddress(address, chain);
    if (!validation.valid) {
      emitError(output, validation.error, true);
      return { exitCode: 1 };
    }
  } else if (watchType === 'token') {
    const validation = validateTokenAddress(address, chain);
    if (!validation.valid) {
      emitError(output, validation.error, true);
      return { exitCode: 1 };
    }
  } else {
    emitError(output, `Unknown watch type: ${watchType}. Use "wallet" or "token".`, true);
    return { exitCode: 1 };
  }

  // Clamp interval
  const { interval, warning } = clampInterval(rawInterval, errorOutput);
  if (warning) {
    emitError(output, warning, false);
  }

  // Load persisted state for deduplication
  const stateKey = getStateKey(watchType, address, chain);
  const allState = loadWatchState();
  const seenKeys = new Set(allState[stateKey]?.seenKeys || []);

  // Graceful shutdown
  let stopped = false;
  const stop = (reason) => {
    if (stopped) return;
    stopped = true;
    // Persist state before exit
    const updatedState = loadWatchState();
    // Keep only the last 1000 keys to prevent unbounded growth
    const keysArray = [...seenKeys];
    updatedState[stateKey] = {
      seenKeys: keysArray.slice(-1000),
      lastPoll: new Date().toISOString()
    };
    saveWatchState(updatedState);
    emitStopped(output, reason);
  };

  if (onSignal) {
    onSignal(() => stop('signal'));
  } else {
    const handler = () => {
      stop('signal');
      process.exit(0);
    };
    process.on('SIGINT', handler);
    process.on('SIGTERM', handler);
  }

  // Timeout
  let timeoutTimer = null;
  if (timeout > 0) {
    timeoutTimer = setTimeout(() => {
      stop('timeout');
    }, timeout * 1000);
  }

  // Fetch function based on watch type
  const fetchData = watchType === 'wallet'
    ? () => api.addressTransactions({ address, chain, days: 1 })
    : () => api.tokenDexTrades({ tokenAddress: address, chain, days: 1 });

  const eventType = watchType === 'wallet' ? 'wallet_activity' : 'token_activity';

  // Emit started event
  emitStarted(output, watchType, address, chain, interval, timeout);

  // Poll loop
  const startTime = Date.now();

  while (!stopped) {
    // Fetch data with retries
    const result = await fetchWithRetry(fetchData, output);

    if (result && !stopped) {
      const records = extractRecords(result);
      const newRecords = extractNewRecords(records, seenKeys);

      for (const record of newRecords) {
        if (stopped) break;
        emitData(output, eventType, record, address, chain);
      }
    }

    if (once || stopped) {
      if (!stopped) stop('once');
      break;
    }

    // Emit heartbeat
    emitHeartbeat(output, interval);

    // Wait for next poll
    const waitEnd = Date.now() + interval * 1000;
    while (Date.now() < waitEnd && !stopped) {
      await sleep(Math.min(1000, waitEnd - Date.now()));
    }
  }

  if (timeoutTimer) clearTimeout(timeoutTimer);
  if (!stopped) stop('completed');

  return { exitCode: 0 };
}

// ============= CLI Integration =============

export function buildWatchCommand(deps = {}) {
  const {
    output = console.log,
    errorOutput = console.error,
  } = deps;

  return async (args, apiInstance, flags, options) => {
    const watchType = args[0]; // 'wallet' or 'token'

    if (!watchType || watchType === 'help') {
      output(JSON.stringify({
        command: 'watch',
        description: 'Watch wallet or token activity in real-time (NDJSON output)',
        subcommands: {
          wallet: 'Watch wallet transactions',
          token: 'Watch token DEX trades'
        },
        options: {
          address: 'Wallet or token address (required)',
          chain: 'Blockchain (default: ethereum)',
          interval: `Poll interval in seconds (default: ${DEFAULT_INTERVAL}, min: ${MIN_INTERVAL}, max: ${MAX_INTERVAL})`,
          once: 'Poll once and exit',
          timeout: 'Auto-stop after N seconds (default: no timeout)'
        },
        examples: [
          'nansen watch wallet --address 0x123... --chain ethereum --interval 30',
          'nansen watch token --address So1...xyz --chain solana --once',
          'nansen watch wallet --address 0x123... --timeout 300'
        ]
      }));
      return;
    }

    const address = options.address || options.token || args[1];
    const chain = options.chain || (watchType === 'token' ? 'solana' : 'ethereum');
    const interval = options.interval ? parseInt(options.interval, 10) : DEFAULT_INTERVAL;
    const once = flags.once || false;
    const timeout = options.timeout ? parseInt(options.timeout, 10) : DEFAULT_TIMEOUT;

    return runWatch({
      watchType,
      address,
      chain,
      interval,
      once,
      timeout,
      api: apiInstance,
      output,
      errorOutput
    });
  };
}
