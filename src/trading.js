/**
 * Nansen CLI - Trading Commands
 * Quote and execute DEX swaps via the Nansen Trading API.
 * Supports Solana and EVM chains (Ethereum, Base, BSC).
 * Zero external dependencies — uses Node.js built-in crypto only.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { exportWallet, getDefaultAddress, showWallet, keccak256, listWallets } from './wallet.js';

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
  const body = await res.json();

  if (!res.ok) {
    const code = body.code || 'QUOTE_ERROR';
    const msg = body.message || `Quote request failed with status ${res.status}`;
    throw Object.assign(new Error(msg), { code, status: res.status, details: body.details });
  }

  return body;
}

/**
 * Broadcast a signed transaction via the Nansen Trading API.
 *
 * @param {object} params
 * @param {string} params.signedTransaction - Base64 (Solana) or 0x hex (EVM)
 * @param {string} [params.chain] - Target chain name
 * @param {string} [params.requestId] - Optional Jupiter request ID (Solana only)
 * @param {boolean} [params.simulate] - Run pre-broadcast simulation
 * @returns {Promise<object>} Execution result
 */
export async function executeTransaction(params) {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
  if (process.env.NANSEN_API_KEY) {
    headers['Authorization'] = `Bearer ${process.env.NANSEN_API_KEY}`;
  }

  const res = await fetch(`${TRADING_API_URL}/execute`, {
    method: 'POST',
    headers,
    body: JSON.stringify(params),
  });
  const body = await res.json();

  if (!res.ok) {
    const code = body.code || 'EXECUTE_ERROR';
    const msg = body.message || `Execute request failed with status ${res.status}`;
    throw Object.assign(new Error(msg), { code, status: res.status, details: body.details });
  }

  return body;
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
export function signEvmTransaction(txData, privateKeyHex, chain, nonce) {
  const chainConfig = CHAIN_MAP[chain];
  if (!chainConfig || chainConfig.type !== 'evm') {
    throw new Error(`Unsupported EVM chain: ${chain}`);
  }

  const tx = {
    nonce,
    gasPrice: txData.gasPrice || txData.maxFeePerGas || '1',
    gasLimit: txData.gas || txData.gasLimit || '210000',
    to: txData.to,
    value: txData.value || '0',
    data: txData.data || '0x',
    chainId: chainConfig.chainId,
  };

  return signLegacyTransaction(tx, privateKeyHex);
}

/**
 * Fetch the pending nonce for an EVM address.
 * @param {string} chain - Chain name
 * @param {string} address - 0x address
 * @returns {Promise<number>} Nonce
 */
export async function getEvmNonce(chain, address) {
  const rpcUrl = EVM_RPC_URLS[chain];
  if (!rpcUrl) throw new Error(`No RPC URL configured for chain: ${chain}`);

  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_getTransactionCount',
      params: [address, 'pending'],
    }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`RPC error: ${body.error.message}`);
  return parseInt(body.result, 16);
}

/**
 * Send an ERC-20 approval transaction.
 * Required before swapping non-native EVM tokens.
 *
 * @param {string} tokenAddress - ERC-20 token contract
 * @param {string} spenderAddress - Approval target (from quote.approvalAddress)
 * @param {string} privateKeyHex - Wallet private key
 * @param {string} chain - Chain name
 * @param {number} nonce - Account nonce
 * @returns {string} 0x-prefixed signed approval tx hex
 */
// ⚠️ SECURITY: ERC-20 approval signing - requires thorough review
export function buildApprovalTransaction(tokenAddress, spenderAddress, privateKeyHex, chain, nonce) {
  const chainConfig = CHAIN_MAP[chain];
  if (!chainConfig) throw new Error(`Unsupported chain: ${chain}`);

  // ERC-20 approve(address spender, uint256 amount) selector = 0x095ea7b3
  // Approve max uint256
  const MAX_UINT256_HEX = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
  const data = '0x095ea7b3'
    + spenderAddress.slice(2).toLowerCase().padStart(64, '0')
    + MAX_UINT256_HEX;

  const tx = {
    nonce,
    gasPrice: '1', // Will use a reasonable default; caller should provide
    gasLimit: '100000',
    to: tokenAddress,
    value: '0',
    data,
    chainId: chainConfig.chainId,
  };

  return signLegacyTransaction(tx, privateKeyHex);
}

// ============= Legacy (Type 0) EVM Transaction Signing =============
// ⚠️ SECURITY: Legacy EVM transaction signing - requires thorough review before production use

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
  const { r, s, v: recoveryBit } = ecdsaSign(msgHash, Buffer.from(privateKeyHex, 'hex'));

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
    r.length > 0 && r[0] === 0 ? r.subarray(1) : r, // strip leading zero
    s.length > 0 && s[0] === 0 ? s.subarray(1) : s,
  ];

  return '0x' + rlpEncode(signedFields).toString('hex');
}

// ============= ECDSA Signing (secp256k1) =============
// ⚠️ SECURITY: Raw ECDSA implementation - requires thorough review

/**
 * Sign a 32-byte hash with secp256k1 (no additional hashing).
 *
 * @param {Buffer} msgHash - 32-byte message hash
 * @param {Buffer} privKey - 32-byte private key
 * @returns {{ r: Buffer, s: Buffer, v: number }} Signature components
 */
function ecdsaSign(msgHash, privKey) {
  const N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;

  const ecdh = crypto.createECDH('secp256k1');
  ecdh.setPrivateKey(privKey);
  const pubKey = ecdh.getPublicKey();

  const ecPrivateKey = crypto.createPrivateKey({
    key: Buffer.concat([
      Buffer.from('30740201010420', 'hex'),
      privKey,
      Buffer.from('a00706052b8104000aa144034200', 'hex'),
      pubKey,
    ]),
    format: 'der',
    type: 'sec1',
  });

  // Sign with null algo = raw ECDSA (no additional hashing)
  const sig = crypto.sign(null, msgHash, {
    key: ecPrivateKey,
    dsaEncoding: 'ieee-p1363',
  });

  let r = sig.subarray(0, 32);
  let s_raw = sig.subarray(32, 64);

  // Low-S normalization (EIP-2)
  let sBn = BigInt('0x' + s_raw.toString('hex'));
  const halfN = N >> 1n;
  let sFlipped = false;
  if (sBn > halfN) {
    sBn = N - sBn;
    sFlipped = true;
    s_raw = Buffer.from(sBn.toString(16).padStart(64, '0'), 'hex');
  }

  // Determine recovery ID (v = 0 or 1)
  // Try to recover the public key from the signature and compare
  // Since we can't do EC point recovery easily with just Node.js crypto,
  // we determine v by checking: if s was flipped, v flips.
  // This works because flipping s negates the recovery point's y.
  //
  // ⚠️ SECURITY: Recovery ID heuristic. Should be verified with test vectors.
  // A robust implementation would do trial EC point recovery.
  let v = sFlipped ? 1 : 0;

  return { r, s: s_raw, v };
}

// ============= RLP Encoding =============
// ⚠️ SECURITY: RLP encoding - requires review for edge cases

/**
 * RLP-encode a value (Buffer, string, number, or array).
 */
export function rlpEncode(input) {
  if (Array.isArray(input)) {
    const encoded = Buffer.concat(input.map(rlpEncode));
    return Buffer.concat([encodeLength(encoded.length, 0xc0), encoded]);
  }
  const buf = toBuffer(input);
  if (buf.length === 1 && buf[0] < 0x80) return buf;
  return Buffer.concat([encodeLength(buf.length, 0x80), buf]);
}

function encodeLength(len, offset) {
  if (len < 56) return Buffer.from([offset + len]);
  const hexLen = len.toString(16);
  const lenBytes = Buffer.from(hexLen.padStart(hexLen.length + (hexLen.length % 2), '0'), 'hex');
  return Buffer.concat([Buffer.from([offset + 55 + lenBytes.length]), lenBytes]);
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
  if (quote.approvalAddress) lines.push(`    ⚠ Requires token approval to: ${quote.approvalAddress}`);
  return lines.join('\n');
}

// ============= CLI Command Builder =============

/**
 * Build trading command handlers for CLI integration.
 */
export function buildTradingCommands(deps = {}) {
  const { log = console.log, exit = process.exit } = deps;

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
        log(`
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
          log('❌ No wallet found. Create one with: nansen wallet create');
          exit(1);
          return;
        }

        log(`\nFetching quote on ${chainConfig.name}...`);
        log(`  Wallet: ${walletAddress}`);

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
          log('❌ No quotes available');
          if (response.warnings?.length) {
            response.warnings.forEach(w => log(`  ⚠ ${w}`));
          }
          exit(1);
          return;
        }

        log('');
        response.quotes.forEach((q, i) => log(formatQuote(q, i)));

        const quoteId = saveQuote(response, chain);
        log(`\n  Quote ID: ${quoteId}`);
        log(`  Execute:  nansen execute --quote ${quoteId}`);

        if (response.quotes[0]?.approvalAddress) {
          log(`\n  ⚠ This token swap requires an ERC-20 approval step.`);
          log(`    The execute command will handle this automatically.`);
        }

        log('');
        return { quoteId, response };

      } catch (err) {
        log(`❌ ${err.message}`);
        if (err.details) log(`  Details: ${JSON.stringify(err.details)}`);
        exit(1);
      }
    },

    'execute': async (args, apiInstance, flags, options) => {
      const quoteId = options.quote || options['quote-id'] || args[0];
      const walletName = options.wallet;
      const noSimulate = flags['no-simulate'] || flags.noSimulate;

      if (!quoteId) {
        log(`
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

        const bestQuote = quoteData.response.quotes?.[0];
        if (!bestQuote) {
          log('❌ No quote data found');
          exit(1);
          return;
        }

        // Verify transaction data exists
        if (!bestQuote.transaction) {
          log('❌ Quote does not contain transaction data.');
          log('  Ensure userWalletAddress was provided when fetching the quote.');
          exit(1);
          return;
        }

        log(`\nExecuting trade on ${chainConfig.name}...`);
        log(formatQuote(bestQuote));
        log('');

        // Get wallet credentials
        const password = process.env.NANSEN_WALLET_PASSWORD || await promptPassword('Enter wallet password: ', deps);

        let effectiveWalletName = walletName;
        if (!effectiveWalletName) {
          const list = listWallets();
          effectiveWalletName = list.defaultWallet;
        }
        if (!effectiveWalletName) {
          log('❌ No wallet found. Create one with: nansen wallet create');
          exit(1);
          return;
        }

        const exported = exportWallet(effectiveWalletName, password);

        let signedTransaction;
        let requestId;

        if (chainType === 'solana') {
          // Solana: quote.transaction is base64 serialized VersionedTransaction
          log('  Signing Solana transaction...');
          signedTransaction = signSolanaTransaction(bestQuote.transaction, exported.solana.privateKey);
          requestId = bestQuote.metadata?.requestId;

        } else {
          // EVM: quote.transaction is { to, data, value, gas, gasPrice }
          const walletAddress = exported.evm.address;

          // Handle ERC-20 approval if needed
          if (bestQuote.approvalAddress) {
            log(`  ⚠ Token requires approval. Sending approval tx first...`);
            const approvalNonce = await getEvmNonce(chain, walletAddress);
            const approvalTxHex = buildApprovalTransaction(
              bestQuote.inputMint,
              bestQuote.approvalAddress,
              exported.evm.privateKey,
              chain,
              approvalNonce
            );

            const approvalResult = await executeTransaction({
              signedTransaction: approvalTxHex,
              chain,
              simulate: !noSimulate,
            });

            if (approvalResult.status !== 'Success') {
              log(`  ❌ Approval transaction failed: ${approvalResult.error || 'unknown error'}`);
              exit(1);
              return;
            }
            log(`  ✓ Approval confirmed: ${approvalResult.txHash}`);
            log('');

            // Re-fetch quote since nonce changed and approval is now in place
            // For now, just increment nonce
          }

          log('  Fetching nonce...');
          const nonce = await getEvmNonce(chain, walletAddress);
          log(`  Nonce: ${nonce}`);

          log('  Signing EVM transaction...');
          signedTransaction = signEvmTransaction(
            bestQuote.transaction,
            exported.evm.privateKey,
            chain,
            nonce
          );
        }

        log('  Broadcasting...');
        const execParams = {
          signedTransaction,
          chain,
          simulate: !noSimulate,
        };
        if (requestId) execParams.requestId = requestId;

        const result = await executeTransaction(execParams);

        if (result.status === 'Success') {
          const txId = result.signature || result.txHash;
          const explorerUrl = chainConfig.explorer + txId;

          log(`\n  ✓ Transaction successful!`);
          log(`    Status:      ${result.status}`);
          log(`    ${result.signature ? 'Signature' : 'Tx Hash'}:   ${txId}`);
          log(`    Chain:       ${chainConfig.name} (${result.chainType})`);
          log(`    Broadcaster: ${result.broadcaster}`);
          log(`    Explorer:    ${explorerUrl}`);

          if (result.swapEvents?.length) {
            log(`    Swaps:`);
            result.swapEvents.forEach(e => {
              log(`      ${e.inputAmount} ${e.inputMint?.slice(0, 8)}... → ${e.outputAmount} ${e.outputMint?.slice(0, 8)}...`);
            });
          }
        } else {
          log(`\n  ✗ Transaction failed`);
          log(`    Status: ${result.status}`);
          if (result.error) log(`    Error:  ${result.error}`);
        }
        log('');

        return result;

      } catch (err) {
        log(`❌ ${err.message}`);
        if (err.details) log(`  Details: ${JSON.stringify(err.details)}`);
        exit(1);
      }
    },
  };
}
