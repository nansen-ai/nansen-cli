/**
 * Nansen CLI - Trading Commands
 * Quote and execute DEX swaps via the Nansen Trading API.
 * Supports Solana and EVM chains (Ethereum, Base, BSC).
 * Zero external dependencies — uses Node.js built-in crypto only.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { exportWallet, getDefaultAddress, showWallet, listWallets } from './wallet.js';

import { keccak256, signSecp256k1, rlpEncode } from './crypto.js';

// ============= Constants =============

const TRADING_API_URL = process.env.NANSEN_TRADING_API_URL || 'https://trading-api.nansen.ai';

const CHAIN_MAP = {
  solana:   { index: '501', type: 'solana', chainId: 501,  name: 'Solana',   explorer: 'https://solscan.io/tx/' },
  ethereum: { index: '1',   type: 'evm',    chainId: 1,    name: 'Ethereum', explorer: 'https://etherscan.io/tx/' },
  base:     { index: '8453', type: 'evm',   chainId: 8453, name: 'Base',     explorer: 'https://basescan.org/tx/' },
  bsc:      { index: '56',  type: 'evm',    chainId: 56,   name: 'BSC',      explorer: 'https://bscscan.com/tx/' },
};

// Default public RPC endpoints (used for nonce fetching)
const EVM_RPC_URLS = {
  ethereum: process.env.NANSEN_RPC_ETHEREUM || 'https://eth.llamarpc.com',
  base:     process.env.NANSEN_RPC_BASE     || 'https://mainnet.base.org',
  bsc:      process.env.NANSEN_RPC_BSC      || 'https://bsc-dataseed.binance.org',
};

function getQuotesDir() {
  const configDir = path.join(process.env.HOME || process.env.USERPROFILE || '', '.nansen');
  return path.join(configDir, 'quotes');
}

// ============= Trading API Client =============

/**
 * Get a trading quote from the Nansen Trading API.
 * Returns quotes with transaction data ready for signing.
 *
 * @param {object} params - Query parameters for GET /quote
 * @returns {Promise<object>} Quote response with quotes[].transaction
 */
export async function getQuote(params) {
  const url = new URL('/quote', TRADING_API_URL);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }

  const headers = { 'Accept': 'application/json' };
  if (process.env.NANSEN_API_KEY) {
    headers['Authorization'] = `Bearer ${process.env.NANSEN_API_KEY}`;
  }

  const res = await fetch(url.toString(), { headers });

  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw Object.assign(
      new Error(`Quote API returned non-JSON response (status ${res.status}). This may be a Cloudflare challenge or server error.`),
      { code: 'NON_JSON_RESPONSE', status: res.status, details: text.slice(0, 200) }
    );
  }

  if (!res.ok) {
    const code = body.code || 'QUOTE_ERROR';
    const msg = body.message || `Quote request failed with status ${res.status}`;
    throw Object.assign(new Error(msg), { code, status: res.status, details: body.details });
  }

  return body;
}

/**
 * Call POST /execution/prepare to build transactions server-side.
 * The server handles nonce, gas estimation, approval building, and simulation.
 *
 * @param {object} params
 * @param {string} params.mode - Execution mode ('standard')
 * @param {string} params.chain - Chain type ('evm' or 'solana')
 * @param {string} params.chainId - Chain ID as string
 * @param {string} params.walletAddress - Wallet address
 * @param {object} params.quote - Quote object from the saved quote file
 * @param {boolean} [params.skipSimulation] - Skip pre-broadcast simulation
 * @returns {Promise<object>} Prepare result with swapTxData, approvalTxData, needsApproval, etc.
 */
export async function prepareTransaction(params) {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
  if (process.env.NANSEN_API_KEY) {
    headers['Authorization'] = `Bearer ${process.env.NANSEN_API_KEY}`;
  }

  const res = await fetch(`${TRADING_API_URL}/execution/prepare`, {
    method: 'POST',
    headers,
    body: JSON.stringify(params),
  });

  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw Object.assign(
      new Error(`Prepare API returned non-JSON response (status ${res.status}). This may be a Cloudflare challenge or server error.`),
      { code: 'PREPARE_FAILED', status: res.status, details: text.slice(0, 200) }
    );
  }

  if (!res.ok) {
    const code = body.code || 'PREPARE_ERROR';
    const msg = body.message || `Prepare request failed with status ${res.status}`;
    throw Object.assign(new Error(msg), { code, status: res.status, details: body.details });
  }

  return body;
}

/**
 * Call POST /execution/standard to broadcast signed transactions.
 * The server handles approval broadcast + wait + swap broadcast.
 *
 * @param {object} params
 * @param {string} params.chain - Chain type ('evm' or 'solana')
 * @param {string} params.chainId - Chain ID as string
 * @param {string} params.signedTransaction - Signed swap tx (base64 for Solana, 0x hex for EVM)
 * @param {string} [params.signedApprovalTransaction] - Signed approval tx (EVM only)
 * @param {string} [params.aggregator] - Aggregator name
 * @param {string} [params.requestId] - Request ID (Solana/Jupiter)
 * @param {string} [params.walletAddress] - Wallet address
 * @returns {Promise<object>} { txHash, success, error? }
 */
export async function submitExecution(params, { retries = 2, retryDelayMs = 1500 } = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
  if (process.env.NANSEN_API_KEY) {
    headers['Authorization'] = `Bearer ${process.env.NANSEN_API_KEY}`;
  }

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      await new Promise(r => setTimeout(r, retryDelayMs));
    }

    const res = await fetch(`${TRADING_API_URL}/execution/standard`, {
      method: 'POST',
      headers,
      body: JSON.stringify(params),
    });

    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      const feeHint = res.status === 502
        ? params.chain === 'solana'
          ? ' This often means the transaction failed simulation — check that you have enough SOL for fees (~0.005 SOL minimum).'
          : params.chain === 'evm'
            ? ' This often means the transaction failed simulation — check that you have enough ETH for gas fees.'
            : ''
        : '';
      lastError = Object.assign(
        new Error(`Execute API returned non-JSON response (status ${res.status}).${feeHint || ' This may be a Cloudflare challenge or server error.'}`),
        { code: 'BROADCAST_FAILED', status: res.status, details: text.slice(0, 200) }
      );
      // Retry on 502/503 (likely transient Cloudflare issues)
      if ((res.status === 502 || res.status === 503) && attempt < retries) continue;
      throw lastError;
    }

    if (!res.ok) {
      const code = body.code || 'EXECUTE_ERROR';
      const msg = body.message || `Execute request failed with status ${res.status}`;
      throw Object.assign(new Error(msg), { code, status: res.status, details: body.details });
    }

    return body;
  }
  throw lastError;
}

// ============= Quote Storage =============

/**
 * Save a quote response to disk for later execution.
 * @returns {string} Quote ID
 */
export function saveQuote(quoteResponse, chain) {
  const dir = getQuotesDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const timestamp = Date.now();
  const hash = crypto.randomBytes(4).toString('hex');
  const quoteId = `${timestamp}-${hash}`;

  const data = { quoteId, chain, timestamp, response: quoteResponse };

  fs.writeFileSync(path.join(dir, `${quoteId}.json`), JSON.stringify(data, null, 2), { mode: 0o600 });
  cleanupQuotes();
  return quoteId;
}

/**
 * Load a saved quote by ID.
 */
export function loadQuote(quoteId) {
  const filePath = path.join(getQuotesDir(), `${quoteId}.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Quote "${quoteId}" not found. Quotes expire after 1 hour.`);
  }
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (Date.now() - data.timestamp > 3600000) {
    fs.unlinkSync(filePath);
    throw new Error('Quote has expired. Please request a new quote.');
  }
  return data;
}

/**
 * Remove quotes older than 1 hour.
 */
export function cleanupQuotes() {
  const dir = getQuotesDir();
  if (!fs.existsSync(dir)) return;
  const now = Date.now();
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      if (now - data.timestamp > 3600000) fs.unlinkSync(path.join(dir, file));
    } catch { /* ignore */ }
  }
}

// ============= Transaction Signing =============

// ----------------------------------------------------------------
// TODO: SECURITY REVIEW REQUIRED
// The signing functions below construct and sign raw transactions.
// They MUST be audited before any production/mainnet use.
// ----------------------------------------------------------------

/**
 * Sign a Solana transaction from quote data.
 *
 * The trading API returns a base64-encoded serialized VersionedTransaction
 * in quote.transaction. We deserialize, sign with Ed25519, re-serialize.
 *
 * Based on the e2e test pattern:
 *   const serializedTx = Buffer.from(quote.transaction, 'base64')
 *   const tx = VersionedTransaction.deserialize(serializedTx)
 *   tx.sign([signer])
 *
 * We replicate this without @solana/web3.js using raw crypto.
 *
 * @param {string} transactionBase64 - Base64-encoded serialized VersionedTransaction
 * @param {string} privateKeyHex - 128-char hex (64 bytes: seed + pubkey)
 * @returns {string} Base64-encoded signed transaction
 */
// ⚠️ SECURITY: Solana transaction signing - requires thorough review before production use
export function signSolanaTransaction(transactionBase64, privateKeyHex) {
  const txBytes = Buffer.from(transactionBase64, 'base64');

  // Extract Ed25519 seed (first 32 bytes of the 64-byte keypair)
  const seed = Buffer.from(privateKeyHex.slice(0, 64), 'hex');

  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([
      Buffer.from('302e020100300506032b657004220420', 'hex'), // PKCS8 Ed25519 prefix
      seed,
    ]),
    format: 'der',
    type: 'pkcs8',
  });

  // VersionedTransaction wire format:
  // [signatures_count (compact-u16)] [signatures (64 bytes each)...] [message_bytes...]
  const { value: sigCount, size: sigCountSize } = readCompactU16(txBytes, 0);
  const messageOffset = sigCountSize + (sigCount * 64);
  const messageBytes = txBytes.subarray(messageOffset);

  // Sign the message bytes
  const signature = crypto.sign(null, messageBytes, privateKey);

  // Write signature into the first slot (fee payer = our wallet)
  const signedTx = Buffer.from(txBytes);
  signature.copy(signedTx, sigCountSize);

  return signedTx.toString('base64');
}

/**
 * Sign an EVM transaction from quote data.
 *
 * The trading API returns transaction fields in quote.transaction:
 *   { to, data, value?, gas?, gasPrice? }
 *
 * The nonce must be fetched from the chain RPC.
 * Signs as a legacy (type 0) transaction with gasPrice (matching the e2e tests).
 *
 * @param {object} txData - Transaction fields from quote.transaction { to, data, value, gas, gasPrice }
 * @param {string} privateKeyHex - 64-char hex (32-byte secp256k1 private key)
 * @param {string} chain - Chain name (ethereum, base, bsc)
 * @param {number} nonce - Account nonce
 * @returns {string} 0x-prefixed signed transaction hex
 */
// ⚠️ SECURITY: EVM transaction signing - requires thorough review before production use
// TODO: Always signs as legacy (type 0) transactions. Do we need EIP-1559 (type 2) support?
export function signEvmTransaction(txData, privateKeyHex, chain, nonce) {
  const chainConfig = CHAIN_MAP[chain];
  if (!chainConfig || chainConfig.type !== 'evm') {
    throw new Error(`Unsupported EVM chain: ${chain}`);
  }

  const tx = {
    nonce,
    gasPrice: toHex(txData.gasPrice || txData.maxFeePerGas || '1'),
    gasLimit: toHex(txData.gas || txData.gasLimit || '210000'),
    to: txData.to,
    value: toHex(txData.value || '0'),
    data: txData.data || '0x',
    chainId: chainConfig.chainId,
  };

  return signLegacyTransaction(tx, privateKeyHex);
}


/**
 * Wait for an EVM transaction to be confirmed on-chain.
 * Polls eth_getTransactionReceipt until receipt is available or timeout.
 *
 * @param {string} chain - Chain name
 * @param {string} txHash - Transaction hash (0x...)
 * @param {number} [timeoutMs=30000] - Max wait time
 * @param {number} [pollMs=2000] - Poll interval
 * @returns {Promise<object>} Transaction receipt
 */
export async function waitForReceipt(chain, txHash, timeoutMs = 30000, pollMs = 2000) {
  const rpcUrl = EVM_RPC_URLS[chain];
  if (!rpcUrl) throw new Error(`No RPC URL configured for chain: ${chain}`);

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getTransactionReceipt',
        params: [txHash],
      }),
    });
    const body = await res.json();
    if (body.result) {
      const status = parseInt(body.result.status, 16);
      if (status !== 1) {
        throw new Error(`Transaction reverted on-chain (status: ${body.result.status}). Tx: ${txHash}`);
      }
      return body.result;
    }
    // Receipt not yet available — wait and retry
    await new Promise(r => setTimeout(r, pollMs));
  }
  throw new Error(`Transaction receipt not found after ${timeoutMs}ms. Tx: ${txHash}`);
}


// ============= EIP-1559 (Type 2) EVM Transaction Signing =============

/**
 * Sign an EIP-1559 (type 2) EVM transaction.
 * Used for transactions returned by /execution/prepare which include
 * maxFeePerGas/maxPriorityFeePerGas instead of gasPrice.
 *
 * @param {object} txData - { nonce, maxFeePerGas, maxPriorityFeePerGas, gas, to, value, data, chainId }
 * @param {string} privateKeyHex - 32-byte private key as hex
 * @returns {string} 0x-prefixed signed transaction hex
 */
export function signEip1559EvmTransaction(txData, privateKeyHex) {
  const chainId = BigInt(txData.chainId);
  const nonce = BigInt(txData.nonce || 0);
  const maxPriorityFeePerGas = BigInt(txData.maxPriorityFeePerGas || 0);
  const maxFeePerGas = BigInt(txData.maxFeePerGas || 0);
  const gasLimit = BigInt(txData.gas || txData.gasLimit || 210000);
  const value = BigInt(txData.value || 0);

  const bigIntToHex = (n) => n === 0n ? '0x' : '0x' + n.toString(16);

  const txFields = [
    bigIntToHex(chainId),
    bigIntToHex(nonce),
    bigIntToHex(maxPriorityFeePerGas),
    bigIntToHex(maxFeePerGas),
    bigIntToHex(gasLimit),
    txData.to,
    bigIntToHex(value),
    txData.data || '0x',
    [], // accessList
  ];

  const unsigned = rlpEncode(txFields);
  const txHash = keccak256(Buffer.concat([Buffer.from([0x02]), unsigned]));
  const sig = signSecp256k1(txHash, Buffer.from(privateKeyHex, 'hex'));

  const signed = rlpEncode([
    ...txFields,
    bigIntToHex(BigInt(sig.v)),
    '0x' + sig.r.toString('hex'),
    '0x' + sig.s.toString('hex'),
  ]);

  const rawTx = Buffer.concat([Buffer.from([0x02]), signed]);
  return '0x' + rawTx.toString('hex');
}

// ============= Legacy (Type 0) EVM Transaction Signing =============
// ⚠️ SECURITY: Legacy EVM transaction signing - requires thorough review before production use

/**
 * Strip all leading zero bytes from a buffer.
 * RLP requires minimal encoding, so signature r/s values must not have leading zeros.
 */
export function stripLeadingZeros(buf) {
  let i = 0;
  while (i < buf.length && buf[i] === 0) i++;
  return buf.subarray(i);
}

/**
 * Sign a legacy (type 0) EVM transaction.
 *
 * @param {object} tx - { nonce, gasPrice, gasLimit, to, value, data, chainId }
 * @param {string} privateKeyHex - 32-byte private key as hex
 * @returns {string} 0x-prefixed signed transaction hex
 */
export function signLegacyTransaction(tx, privateKeyHex) {
  // EIP-155 unsigned: RLP([nonce, gasPrice, gasLimit, to, value, data, chainId, 0, 0])
  const unsignedFields = [
    rlpNormalize(tx.nonce),
    rlpNormalize(tx.gasPrice),
    rlpNormalize(tx.gasLimit),
    toBuffer(tx.to),
    rlpNormalize(tx.value),
    toBuffer(tx.data || '0x'),
    rlpNormalize(tx.chainId),
    Buffer.alloc(0), // EIP-155: empty for signing
    Buffer.alloc(0), // EIP-155: empty for signing
  ];

  const unsignedPayload = rlpEncode(unsignedFields);
  const msgHash = keccak256(unsignedPayload);

  // Sign with secp256k1
  const { r, s, v: recoveryBit } = signSecp256k1(msgHash, Buffer.from(privateKeyHex, 'hex'));

  // EIP-155 v = chainId * 2 + 35 + recoveryBit
  const v = tx.chainId * 2 + 35 + recoveryBit;

  // Signed: RLP([nonce, gasPrice, gasLimit, to, value, data, v, r, s])
  const signedFields = [
    rlpNormalize(tx.nonce),
    rlpNormalize(tx.gasPrice),
    rlpNormalize(tx.gasLimit),
    toBuffer(tx.to),
    rlpNormalize(tx.value),
    toBuffer(tx.data || '0x'),
    rlpNormalize(v),
    stripLeadingZeros(r),
    stripLeadingZeros(s),
  ];

  return '0x' + rlpEncode(signedFields).toString('hex');
}

export function toBuffer(v) {
  if (Buffer.isBuffer(v)) return v;
  if (typeof v === 'string') {
    if (v.startsWith('0x')) {
      const hex = v.slice(2);
      if (hex.length === 0) return Buffer.alloc(0);
      return Buffer.from(hex.padStart(hex.length + (hex.length % 2), '0'), 'hex');
    }
    return Buffer.from(v);
  }
  if (typeof v === 'number' || typeof v === 'bigint') {
    if (v === 0 || v === 0n) return Buffer.alloc(0);
    const hex = BigInt(v).toString(16);
    return Buffer.from(hex.padStart(hex.length + (hex.length % 2), '0'), 'hex');
  }
  return Buffer.alloc(0);
}

/**
 * Convert a value to 0x hex string. Handles decimal strings, hex strings, and numbers.
 */
function toHex(val) {
  if (val === undefined || val === null || val === '' || val === '0' || val === 0) return '0x0';
  if (typeof val === 'string' && val.startsWith('0x')) return val;
  // Decimal string or number → hex
  return '0x' + BigInt(val).toString(16);
}

function rlpNormalize(val) {
  if (val === undefined || val === null || val === '0x0' || val === '0x' || val === 0 || val === '0') {
    return Buffer.alloc(0);
  }
  return toBuffer(val);
}

// ============= Compact-u16 (Solana) =============

/**
 * Read a compact-u16 from a buffer (Solana transaction format).
 */
export function readCompactU16(buf, offset) {
  let value = 0;
  let size = 0;
  for (let i = 0; i < 3; i++) {
    const byte = buf[offset + i];
    value |= (byte & 0x7f) << (7 * i);
    size++;
    if ((byte & 0x80) === 0) break;
  }
  return { value, size };
}

// ============= Chain Utilities =============

/**
 * Resolve chain name to config.
 */
export function resolveChain(chainName) {
  const chain = CHAIN_MAP[chainName?.toLowerCase()];
  if (!chain) {
    throw new Error(`Unsupported chain "${chainName}". Supported: ${Object.keys(CHAIN_MAP).join(', ')}`);
  }
  return chain;
}

/**
 * Get wallet chain type for address lookup.
 */
export function getWalletChainType(chainName) {
  return resolveChain(chainName).type;
}

// ============= CLI Helpers =============

async function promptPassword(prompt, deps = {}) {
  if (deps.promptFn) return deps.promptFn(prompt);
  const readline = await import('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    process.stderr.write(prompt);
    let input = '';
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    if (stdin.setRawMode) stdin.setRawMode(true);
    stdin.resume();
    const onData = (ch) => {
      const c = ch.toString();
      if (c === '\n' || c === '\r') {
        if (stdin.setRawMode) stdin.setRawMode(wasRaw || false);
        stdin.removeListener('data', onData);
        process.stderr.write('\n');
        rl.close();
        resolve(input);
      } else if (c === '\u0003') { rl.close(); process.exit(1); }
      else if (c === '\u007f' || c === '\b') { input = input.slice(0, -1); }
      else { input += c; }
    };
    stdin.on('data', onData);
  });
}

function isNativeToken(mintAddress) {
  return /^0x[eE]{40}$/.test(mintAddress);
}

function formatQuote(quote, index) {
  const lines = [];
  const label = index !== undefined ? `  Quote #${index + 1}` : '  Best Quote';
  lines.push(`${label} (${quote.aggregator || 'unknown'})`);
  lines.push(`    Input:        ${quote.inAmount} → ${quote.inputMint?.slice(0, 12)}...`);
  lines.push(`    Output:       ${quote.outAmount} → ${quote.outputMint?.slice(0, 12)}...`);
  if (quote.inUsdValue)  lines.push(`    In USD:       $${quote.inUsdValue}`);
  if (quote.outUsdValue) lines.push(`    Out USD:      $${quote.outUsdValue}`);
  if (quote.priceImpactPct) lines.push(`    Price Impact: ${quote.priceImpactPct}%`);
  if (quote.tradingFeeInUsd) lines.push(`    Trading Fee:  $${quote.tradingFeeInUsd}`);
  if (quote.networkFeeInUsd) lines.push(`    Network Fee:  $${quote.networkFeeInUsd}`);
  if (quote.approvalAddress && !isNativeToken(quote.inputMint)) lines.push(`    ⚠ Requires token approval to: ${quote.approvalAddress}`);
  return lines.join('\n');
}

// ============= CLI Command Builder =============

/**
 * Build trading command handlers for CLI integration.
 */
export function buildTradingCommands(deps = {}) {
  const { errorOutput = console.error, exit = process.exit } = deps;

  return {
    'quote': async (args, apiInstance, flags, options) => {
      const chain = options.chain || args[0];
      const from = options.from || options['from-token'] || args[1];
      const to = options.to || options['to-token'] || args[2];
      const amount = options.amount || args[3];
      const walletName = options.wallet;
      const slippage = options.slippage;
      const autoSlippage = flags['auto-slippage'] || flags.autoSlippage;
      const maxAutoSlippage = options['max-auto-slippage'];
      const swapMode = options['swap-mode'] || 'exactIn';

      if (!chain || !from || !to || !amount) {
        errorOutput(`
Usage: nansen quote --chain <chain> --from <token> --to <token> --amount <baseUnits>

OPTIONS:
  --chain <chain>           Chain: solana, ethereum, base, bsc
  --from <address>          Input token address
  --to <address>            Output token address
  --amount <units>          Amount in BASE UNITS (e.g. lamports, wei)
  --wallet <name>           Wallet name (default: default wallet)
  --slippage <pct>          Slippage as decimal (e.g. 0.03 for 3%). Default: 0.03
  --auto-slippage           Enable auto slippage calculation
  --max-auto-slippage <pct> Max auto slippage when auto-slippage enabled
  --swap-mode <mode>        exactIn (default) or exactOut

EXAMPLES:
  nansen quote --chain solana --from So11111111111111111111111111111111111111112 --to EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --amount 1000000000
  nansen quote --chain base --from 0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee --to 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 --amount 1000000000000000000
`);
        exit(1);
        return;
      }

      try {
        const chainConfig = resolveChain(chain);
        const chainType = chainConfig.type === 'evm' ? 'evm' : 'solana';

        let walletAddress;
        if (walletName) {
          const wallet = showWallet(walletName);
          walletAddress = chainType === 'solana' ? wallet.solana : wallet.evm;
        } else {
          walletAddress = getDefaultAddress(chainType);
        }

        if (!walletAddress) {
          errorOutput('No wallet found. Create one with: nansen wallet create');
          exit(1);
          return;
        }

        errorOutput(`\nFetching quote on ${chainConfig.name}...`);
        errorOutput(`  Wallet: ${walletAddress}`);

        const params = {
          chainIndex: chainConfig.index,
          fromTokenAddress: from,
          toTokenAddress: to,
          amount,
          userWalletAddress: walletAddress,
        };
        if (slippage) params.slippagePercent = slippage;
        if (autoSlippage) params.autoSlippage = true;
        if (maxAutoSlippage) params.maxAutoSlippagePercent = maxAutoSlippage;
        if (swapMode !== 'exactIn') params.swapMode = swapMode;

        const response = await getQuote(params);

        if (!response.success || !response.quotes?.length) {
          errorOutput('No quotes available');
          if (response.warnings?.length) {
            response.warnings.forEach(w => errorOutput(`  Warning: ${w}`));
          }
          exit(1);
          return;
        }

        errorOutput('');
        response.quotes.forEach((q, i) => errorOutput(formatQuote(q, i)));

        const quoteId = saveQuote(response, chain);
        errorOutput(`\n  Quote ID: ${quoteId}`);
        errorOutput(`  Execute:  nansen execute --quote ${quoteId}`);

        if (response.quotes[0]?.approvalAddress && !isNativeToken(response.quotes[0]?.inputMint)) {
          errorOutput(`\n  Warning: This token swap requires an ERC-20 approval step.`);
          errorOutput(`    The execute command will handle this automatically.`);
        }

        errorOutput('');
        return undefined; // Output already printed above

      } catch (err) {
        errorOutput(`Error: ${err.message}`);
        if (err.details) errorOutput(`  Details: ${JSON.stringify(err.details)}`);
        exit(1);
      }
    },

    'execute': async (args, apiInstance, flags, options) => {
      const quoteId = options.quote || options['quote-id'] || args[0];
      const walletName = options.wallet;
      const noSimulate = flags['no-simulate'] || flags.noSimulate;

      if (!quoteId) {
        errorOutput(`
Usage: nansen execute --quote <quoteId> [options]

OPTIONS:
  --quote <id>              Quote ID from 'nansen quote'
  --wallet <name>           Wallet name (default: default wallet)
  --no-simulate             Skip pre-broadcast simulation

EXAMPLES:
  nansen execute --quote 1708900000000-abc123
`);
        exit(1);
        return;
      }

      try {
        const quoteData = loadQuote(quoteId);
        const chain = quoteData.chain;
        const chainConfig = resolveChain(chain);
        const chainType = chainConfig.type;

        const allQuotes = quoteData.response.quotes || [];
        if (!allQuotes.length) {
          errorOutput('❌ No quote data found');
          exit(1);
          return;
        }

        // --quote-index pins a specific quote (no fallback)
        const pinIndex = options['quote-index'] != null ? parseInt(options['quote-index'], 10) : null;
        const startIndex = pinIndex ?? 0;
        const endIndex = pinIndex != null ? startIndex + 1 : allQuotes.length;

        // Check if any quote in range has transaction data before prompting for password
        const hasAnyTransaction = allQuotes.slice(startIndex, endIndex).some(q => q?.transaction);
        if (!hasAnyTransaction) {
          errorOutput('❌ No quotes contain transaction data.');
          errorOutput('  Ensure userWalletAddress was provided when fetching the quote.');
          exit(1);
          return;
        }

        // Get wallet credentials once (before the loop)
        const password = process.env.NANSEN_WALLET_PASSWORD || await promptPassword('Enter wallet password: ', deps);

        let effectiveWalletName = walletName;
        if (!effectiveWalletName) {
          const list = listWallets();
          effectiveWalletName = list.defaultWallet;
        }
        if (!effectiveWalletName) {
          errorOutput('No wallet found. Create one with: nansen wallet create');
          exit(1);
          return;
        }

        const exported = exportWallet(effectiveWalletName, password);
        let lastQuoteError = null;

        for (let qi = startIndex; qi < endIndex; qi++) {
          const currentQuote = allQuotes[qi];
          if (!currentQuote) continue;

          const quoteName = currentQuote.source || currentQuote.metadata?.source || `#${qi + 1}`;

          // Verify transaction data exists
          if (!currentQuote.transaction) {
            errorOutput(`  ⚠ Quote ${quoteName}: no transaction data, skipping...`);
            lastQuoteError = `Quote ${quoteName} has no transaction data`;
            continue;
          }

          errorOutput(`\nExecuting trade on ${chainConfig.name}...`);
          if (endIndex - startIndex > 1) {
            errorOutput(`  Trying quote ${qi + 1}/${allQuotes.length} (${quoteName})...`);
          }
          errorOutput(formatQuote(currentQuote));
          errorOutput('');

          try {
            // Client-side tx.value validation (EVM only).
            // ERC-20 swaps transfer tokens via calldata, so value must be 0.
            // Native ETH swaps must have value matching the quoted inAmount.
            // A compromised API could attach a large value to drain ETH silently.
            if (chainType === 'evm') {
              const isNative = isNativeToken(currentQuote.inputMint);
              const txValue = BigInt(currentQuote.transaction.value || '0');
              if (isNative) {
                const expectedValue = BigInt(currentQuote.inAmount || currentQuote.inputAmount || '0');
                if (txValue !== expectedValue) {
                  errorOutput(`  ❌ Transaction value mismatch for ${quoteName}: tx.value=${txValue}, expected=${expectedValue}`);
                  if (qi + 1 < endIndex) errorOutput(`  Trying next quote...`);
                  lastQuoteError = `${quoteName} transaction value mismatch`;
                  continue;
                }
              } else {
                if (txValue > 0n) {
                  errorOutput(`  ❌ ERC-20 swap has non-zero tx.value (${txValue}) for ${quoteName} — aborting`);
                  if (qi + 1 < endIndex) errorOutput(`  Trying next quote...`);
                  lastQuoteError = `${quoteName} unexpected tx.value`;
                  continue;
                }
              }
            }

            // Step 1: Prepare — server handles nonce, gas, approval building, simulation
            const walletAddress = chainType === 'solana' ? exported.solana.address : exported.evm.address;
            errorOutput('  Preparing transaction...');
            const prepareResult = await prepareTransaction({
              mode: 'standard',
              chain: chainConfig.type,
              chainId: String(chainConfig.chainId),
              walletAddress,
              quote: currentQuote,
              skipSimulation: noSimulate || false,
            });

            // Step 2: Sign locally
            let signedTransaction;
            let signedApprovalTransaction;

            if (chainType === 'solana') {
              errorOutput('  Signing Solana transaction...');
              signedTransaction = signSolanaTransaction(prepareResult.transaction, exported.solana.privateKey);
            } else {
              // EVM: sign approval if needed, then sign swap
              if (prepareResult.needsApproval && prepareResult.approvalTxData) {
                errorOutput('  Signing approval transaction...');
                signedApprovalTransaction = prepareResult.approvalTxData.maxFeePerGas
                  ? signEip1559EvmTransaction(prepareResult.approvalTxData, exported.evm.privateKey)
                  : signEvmTransaction(prepareResult.approvalTxData, exported.evm.privateKey, chain, prepareResult.approvalTxData.nonce);
              }
              errorOutput('  Signing swap transaction...');
              signedTransaction = prepareResult.swapTxData.maxFeePerGas
                ? signEip1559EvmTransaction(prepareResult.swapTxData, exported.evm.privateKey)
                : signEvmTransaction(prepareResult.swapTxData, exported.evm.privateKey, chain, prepareResult.swapTxData.nonce);
            }

            // Step 3: Submit — server handles approval broadcast + wait + swap broadcast
            errorOutput('  Broadcasting...');
            const submitParams = {
              chain: chainConfig.type,
              chainId: String(chainConfig.chainId),
              signedTransaction,
              aggregator: currentQuote.aggregator,
              walletAddress,
            };
            if (signedApprovalTransaction) submitParams.signedApprovalTransaction = signedApprovalTransaction;
            if (prepareResult.requestId) submitParams.requestId = prepareResult.requestId;
            if (currentQuote.metadata?.requestId) submitParams.requestId = currentQuote.metadata.requestId;

            const result = await submitExecution(submitParams);

            if (result.success) {
              const txId = result.txHash;
              const explorerUrl = chainConfig.explorer + txId;

              // For EVM: verify the tx actually succeeded on-chain
              if (chainType === 'evm' && txId) {
                errorOutput('  Verifying on-chain status...');
                try {
                  await waitForReceipt(chain, txId);
                } catch (receiptErr) {
                  errorOutput(`\n  ⚠ Transaction was broadcast but REVERTED on-chain!`);
                  errorOutput(`    Tx Hash:   ${txId}`);
                  errorOutput(`    Explorer:  ${explorerUrl}`);
                  errorOutput(`    Error:     ${receiptErr.message}`);
                  if (qi + 1 < endIndex) {
                    errorOutput(`  Trying next quote...`);
                    lastQuoteError = `${quoteName} reverted on-chain`;
                    continue;
                  }
                  errorOutput(`\n  The trading API reported success, but the contract execution failed.`);
                  errorOutput(`  This can happen due to: stale quotes, insufficient gas, or liquidity changes.`);
                  exit(1);
                  return;
                }
              }

              errorOutput(`\n  ✓ Transaction successful!`);
              errorOutput(`    Tx Hash:   ${txId}`);
              errorOutput(`    Chain:     ${chainConfig.name}`);
              errorOutput(`    Explorer:  ${explorerUrl}`);
              errorOutput('');
              return undefined; // Success — done
            } else {
              errorOutput(`\n  ✗ Quote ${quoteName} failed`);
              if (result.error) errorOutput(`    Error:  ${result.error}`);
              lastQuoteError = `${quoteName}: ${result.error || 'unknown'}`;
              if (qi + 1 < endIndex) errorOutput(`  Trying next quote...`);
            }

          } catch (quoteErr) {
            errorOutput(`  ❌ Quote ${quoteName} failed: ${quoteErr.message}`);
            lastQuoteError = `${quoteName}: ${quoteErr.message}`;
            if (qi + 1 < endIndex) errorOutput(`  Trying next quote...`);
          }
        }

        // All quotes exhausted
        errorOutput(`\n❌ All quotes failed. Last error: ${lastQuoteError || 'unknown'}`);
        errorOutput('');
        exit(1);
        return undefined;

      } catch (err) {
        errorOutput(`Error: ${err.message}`);
        if (err.details) errorOutput(`  Details: ${JSON.stringify(err.details)}`);
        exit(1);
      }
    },
  };
}
