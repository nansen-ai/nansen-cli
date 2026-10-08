/**
 * WalletConnect Trading & Transfer Support
 *
 * Allows signing and broadcasting transactions via a WalletConnect-connected wallet
 * (hardware wallets, mobile wallets) instead of local key storage.
 * Uses the walletconnect CLI binary (subprocess-based, same as x402).
 *
 * Supports EVM chains and Solana (trading only).
 */

import { wcExec } from './walletconnect-exec.js';
import { base58Encode } from './wallet.js';
import { encodeApproveCalldata } from './trade-validation.js';

const SOLANA_MAINNET_CHAIN = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

/**
 * Extract the first JSON object from walletconnect CLI output.
 * The CLI may print status messages before the JSON result, and may
 * pretty-print the result across several lines. Shared with the x402
 * payment path so both read the CLI's output the same way.
 */
export function parseWcJson(output) {
  const lines = output.split('\n');
  const startIdx = lines.findIndex(l => l.trimStart().startsWith('{'));
  if (startIdx === -1) throw new Error('No JSON output from walletconnect');

  // Handle multi-line JSON: collect lines until braces balance. A brace
  // inside a string value ("... retried } ok") is not structural, so track
  // string and escape state while scanning — counting it would end the object
  // early and fail to parse a perfectly valid result.
  let depth = 0;
  let inString = false;
  let escaped = false;
  const jsonLines = [];
  for (let i = startIdx; i < lines.length; i++) {
    jsonLines.push(lines[i]);
    for (const ch of lines[i]) {
      if (escaped) {
        escaped = false;
      } else if (inString) {
        if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
      } else if (ch === '"') {
        inString = true;
      } else if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth--;
      }
    }
    // A JSON string cannot contain a raw newline, so any unterminated quote is
    // a line-local anomaly rather than a string continuing onto the next line.
    inString = false;
    escaped = false;
    if (depth === 0) break;
  }
  return JSON.parse(jsonLines.join('\n'));
}

/**
 * Get the address of the connected WalletConnect wallet.
 * Returns the first account address, or null if not connected / binary missing.
 *
 * @param {string} [chainType] - Optional: 'evm' or 'solana'. Filters accounts by chain prefix.
 *   No arg = first account (backward compat).
 * @param {number} [chainId] - Optional, 'evm' only: the specific EIP-155 chain ID the
 *   caller is about to sign/broadcast on. When given, only an account the session has
 *   actually approved for THAT chain (`eip155:<chainId>`) is returned — a session
 *   connected only to, say, Ethereum mainnet must not be handed back as if it were
 *   approved for Base just because both are "eip155:*". Mirrors the mainnet-only
 *   exact-match already done for Solana above. Only meaningful for
 *   chainType === 'evm' -- the Solana branch already does its own exact
 *   match unconditionally, so omit chainId there (a chain-config chain ID
 *   like Solana's 501 is not a CAIP-2 EIP-155 chain ID and would not match
 *   anything); also omit it when no specific chain needs verifying at all
 *   (chainType itself omitted, for first-account backward compat).
 */
export async function getWalletConnectAddress(chainType, chainId) {
  try {
    const output = await wcExec('walletconnect', ['whoami', '--json'], 3000);
    const data = JSON.parse(output);
    if (data.connected === false) return null;
    const accounts = data.accounts || [];
    if (!accounts.length) return null;

    if (chainType === 'solana') {
      // Match Solana mainnet only — reject devnet/testnet to prevent wrong-network trades
      const solAccount = accounts.find(a => a.chain === SOLANA_MAINNET_CHAIN);
      return solAccount?.address || null;
    }
    if (chainType === 'evm') {
      if (chainId != null) {
        const evmAccount = accounts.find(a => a.chain === `eip155:${chainId}`);
        return evmAccount?.address || null;
      }
      const evmAccount = accounts.find(a => a.chain?.startsWith('eip155:'));
      return evmAccount?.address || null;
    }
    // No filter — return first account address (backward compat)
    return accounts[0]?.address || null;
  } catch {
    return null;
  }
}

/**
 * Run a wallet send and mark anything that goes wrong as an ambiguous handoff.
 *
 * Once the wallet has been asked to send, no failure here proves the
 * transaction stayed put. `wcExec` collapses a user rejection, a 120s approval
 * timeout and a failure to launch the binary into the same bare
 * `Error(err.message)`, and the timeout is precisely the case where the user DID
 * approve and the wallet DID broadcast while the subprocess gave up waiting. A
 * reply we cannot parse, or one carrying neither a hash nor signed bytes, says
 * just as little about what the wallet did.
 *
 * Callers must therefore never read one of these as "nothing was sent" and go on
 * to send something else. Marking it here, at the boundary, is what makes that
 * hold for every call site — including ones added later — instead of depending
 * on each `catch` to remember. `isFatalBroadcastError` in trading.js treats the
 * flag as terminal; it is deliberately distinct from `broadcastRuledOut`, which
 * is the opposite claim (the backend stated nothing was sent).
 *
 * @param {() => Promise<T>} fn - the send, from the wallet call through parsing
 * @returns {Promise<T>}
 * @template T
 */
async function markBroadcastAmbiguous(fn) {
  try {
    return await fn();
  } catch (err) {
    throw Object.assign(err, { broadcastAmbiguous: true });
  }
}

/**
 * Send a transaction via WalletConnect.
 *
 * The connected wallet signs and may broadcast the transaction.
 * Returns either { txHash } (wallet broadcast) or { signedTransaction } (we broadcast).
 *
 * @param {object} txData - Transaction data: { to, data, value, gas, chainId }
 * @param {number} [timeoutMs=120000] - Timeout for user approval
 * @returns {{ txHash?: string, signedTransaction?: string }}
 */
export async function sendTransactionViaWalletConnect(txData, timeoutMs = 120000) {
  // The walletconnect CLI expects chainId as "eip155:<id>" string format
  const chainId = txData.chainId
    ? (String(txData.chainId).startsWith('eip155:') ? txData.chainId : `eip155:${txData.chainId}`)
    : undefined;

  const payload = {
    to: txData.to,
    data: txData.data || '0x',
    value: txData.value ? '0x' + BigInt(txData.value).toString(16) : '0x0',
    gas: txData.gas ? '0x' + BigInt(txData.gas).toString(16) : undefined,
    chainId,
  };

  return markBroadcastAmbiguous(async () => {
    const output = await wcExec('walletconnect', ['send-transaction', JSON.stringify(payload)], timeoutMs);
    const result = parseWcJson(output);

    if (result.transactionHash) return { txHash: result.transactionHash };
    if (result.txHash) return { txHash: result.txHash };
    if (result.signedTransaction) return { signedTransaction: result.signedTransaction };

    throw new Error('Unexpected response from walletconnect send-transaction');
  });
}

/**
 * Send an ERC-20 approval via WalletConnect.
 *
 * Builds approve(spender, amount) calldata and delegates to sendTransactionViaWalletConnect.
 * The amount is scoped to the swap's input (passed by the caller) so a bad quote
 * can drain at most one trade, not the wallet's full token balance.
 *
 * @param {string} tokenAddress - ERC-20 token contract
 * @param {string} spenderAddress - Approval target (e.g. DEX router)
 * @param {number} chainId - EIP-155 chain ID
 * @param {bigint|string|number} amount - Allowance to grant, in base units
 * @param {bigint|string|number} [maxAllowance] - Hard cap from persisted request intent
 * @param {object} [opts]
 * @param {boolean} [opts.allowZero=false] - Allow a zero-amount revoke approval
 * @returns {{ txHash?: string, signedTransaction?: string }}
 */
export async function sendApprovalViaWalletConnect(tokenAddress, spenderAddress, chainId, amount, maxAllowance, { allowZero = false } = {}) {
  // encodeApproveCalldata enforces a valid 20-byte spender, a bounded (< MAX)
  // amount within the request cap, and exactly-68-byte calldata — so a
  // malformed or tampered spender/amount can't reshape the ABI word layout.
  const data = encodeApproveCalldata(spenderAddress, amount, { maxAllowance, allowZero });

  return sendTransactionViaWalletConnect({
    to: tokenAddress,
    data,
    value: '0',
    gas: '100000',
    chainId,
  });
}

/**
 * Sign a Solana transaction via WalletConnect.
 *
 * The wallet signs the transaction and returns either:
 * - { signedTransaction: "<base58>" } — full signed transaction
 * - { signature: "<base58>" } — raw Ed25519 signature only
 *
 * @param {string} txBase58 - Base58-encoded Solana transaction
 * @param {number} [timeoutMs=120000] - Timeout for user approval
 * @returns {{ signedTransaction?: string, signature?: string }}
 */
export async function sendSolanaTransactionViaWalletConnect(txBase58, timeoutMs = 120000) {
  const payload = {
    transaction: txBase58,
    chainId: SOLANA_MAINNET_CHAIN,
  };

  // Marked ambiguous for the same reason as the EVM send: this goes out over the
  // CLI's `send-transaction` verb, so a wallet that signs-and-sends has already
  // broadcast by the time a timeout or an unreadable reply reaches us.
  return markBroadcastAmbiguous(async () => {
    const output = await wcExec('walletconnect', ['send-transaction', JSON.stringify(payload)], timeoutMs);
    const result = parseWcJson(output);

    if (result.signedTransaction) return { signedTransaction: result.signedTransaction };
    if (result.signature) return { signature: result.signature };
    // Some wallets (e.g. Phantom) return 'transaction' instead of 'signedTransaction'
    if (result.transaction) return { signedTransaction: result.transaction };

    throw new Error('Unexpected response from walletconnect Solana sign');
  });
}

/**
 * Sign a Solana message via WalletConnect.
 *
 * Used for challenge-response authentication (e.g., Jupiter Limit Order V2).
 * Returns the raw Ed25519 signature as base58.
 *
 * @param {Buffer} messageBuffer - Raw message bytes to sign
 * @param {number} [timeoutMs=120000] - Timeout for user approval
 * @returns {{ signature: string }} Base58-encoded signature
 */
export async function signSolanaMessageViaWalletConnect(messageBuffer, timeoutMs = 120000) {
  const payload = {
    message: base58Encode(messageBuffer),
    chainId: SOLANA_MAINNET_CHAIN,
  };

  const output = await wcExec('walletconnect', ['sign-message', JSON.stringify(payload)], timeoutMs);
  const result = parseWcJson(output);

  if (result.signature) return { signature: result.signature };

  throw new Error('Unexpected response from walletconnect sign-message');
}
