/**
 * Nansen CLI - x402 Solana Auto-Payment
 * Implements SPL TransferChecked transaction building for x402 payments.
 */

import crypto from 'crypto';
import { base58Encode, base58DecodePubkey } from './wallet.js';
import { encodeCompactU16, deriveATA as _deriveATA } from './transfer.js';
import { resolvePaymentAmount, resolvePayTo } from './x402-policy.js';
import { SOLANA_MAINNET_NETWORK } from './x402-tokens.js';
import { CHAIN_RPCS } from './rpc-urls.js';
import {
  ADDRESS_LOOKUP_TABLE_PROGRAM,
  SLOT_HASHES_SYSVAR,
  SYSVAR_PROGRAM,
  isLookupTableUsable,
  parseAddressLookupTable,
  parseSlotHashes,
} from './solana-tx.js';

// ============= Constants =============

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const _TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';
const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const _SYSTEM_PROGRAM = '11111111111111111111111111111111';

const DEFAULT_COMPUTE_UNIT_LIMIT = 20000;
const DEFAULT_COMPUTE_UNIT_PRICE_MICROLAMPORTS = 1;

// Upper bound on a single blockhash RPC round-trip. A NANSEN_SOLANA_RPC
// endpoint that accepts the connection but never answers would otherwise
// stall the x402 payment fallback loop for Node's default header timeout.
const SOLANA_RPC_TIMEOUT_MS = 15_000;

// An x402 Solana payment is signed by exactly two accounts: the facilitator
// (feePayer, slot 0) and the paying wallet (slot 1).
const X402_SVM_SIGNER_COUNT = 2;
const SIGNATURE_BYTES = 64;

// ============= PDA Derivation =============

/**
 * Derive Associated Token Account (ATA) address.
 * Returns base58-encoded PDA. Delegates algorithm to transfer.js.
 */
export function deriveATA(ownerBase58, mintBase58, tokenProgramBase58 = TOKEN_PROGRAM) {
  return base58Encode(_deriveATA(ownerBase58, mintBase58, tokenProgramBase58));
}

// ============= MessageV0 Builder =============

/**
 * Build a Solana MessageV0 from accounts and instructions.
 * feePayer is always placed at account index 0, forced signer+writable,
 * regardless of whether an instruction references it directly.
 * Returns numRequiredSignatures alongside the bytes. Each caller writes a
 * fixed number of signature slots and asserts this value against it, since a
 * header that disagrees with the slot count is rejected at broadcast.
 *
 * addressLookupTables ([{ key, addresses }], resolved on-chain by the caller)
 * moves accounts out of the static key list into table lookups. Only accounts
 * that are neither signers nor invoked as a program are eligible — the runtime
 * requires both to be static keys — so the fee payer always stays static.
 */
export function buildMessageV0({ feePayer, instructions, recentBlockhash, addressLookupTables = [] }) {
  // All unique accounts in order: feePayer first, then signers, then rest
  const accountMap = new Map();
  const feePayerKey = feePayer;

  // feePayer is always first, always writable + signer
  accountMap.set(feePayerKey, { isSigner: true, isWritable: true });

  // Collect all accounts from instructions
  for (const ix of instructions) {
    if (!accountMap.has(ix.programId)) {
      accountMap.set(ix.programId, { isSigner: false, isWritable: false });
    }
    for (const acc of ix.accounts) {
      const existing = accountMap.get(acc.pubkey);
      if (existing) {
        existing.isSigner = existing.isSigner || acc.isSigner;
        existing.isWritable = existing.isWritable || acc.isWritable;
      } else {
        accountMap.set(acc.pubkey, { isSigner: acc.isSigner, isWritable: acc.isWritable });
      }
    }
  }

  // Pull lookup-eligible accounts out of the static list, table by table. An
  // account found in more than one table is loaded from the first.
  const invokedPrograms = new Set(instructions.map(ix => ix.programId));
  const lookups = [];
  const loadedWritable = [];
  const loadedReadonly = [];
  const loaded = new Set();
  for (const table of addressLookupTables) {
    const writableIndexes = [];
    const readonlyIndexes = [];
    table.addresses.forEach((address, index) => {
      const meta = accountMap.get(address);
      if (!meta || meta.isSigner || invokedPrograms.has(address) || loaded.has(address)) return;
      loaded.add(address);
      if (meta.isWritable) {
        writableIndexes.push(index);
        loadedWritable.push(address);
      } else {
        readonlyIndexes.push(index);
        loadedReadonly.push(address);
      }
    });
    if (writableIndexes.length || readonlyIndexes.length) {
      lookups.push({ key: table.key, writableIndexes, readonlyIndexes });
    }
  }

  // Sort: signers+writable, signers+readonly, non-signer+writable, non-signer+readonly
  // feePayer always at index 0
  const sortedKeys = [feePayerKey];
  const rest = [...accountMap.entries()].filter(([k]) => k !== feePayerKey && !loaded.has(k));

  // Signer+writable
  for (const [k, v] of rest) if (v.isSigner && v.isWritable) sortedKeys.push(k);
  // Signer+readonly
  for (const [k, v] of rest) if (v.isSigner && !v.isWritable) sortedKeys.push(k);
  // Non-signer+writable
  for (const [k, v] of rest) if (!v.isSigner && v.isWritable) sortedKeys.push(k);
  // Non-signer+readonly
  for (const [k, v] of rest) if (!v.isSigner && !v.isWritable) sortedKeys.push(k);

  // Count header values
  let numRequiredSignatures = 0;
  let numReadonlySignedAccounts = 0;
  let numReadonlyUnsignedAccounts = 0;

  for (const key of sortedKeys) {
    const meta = accountMap.get(key);
    if (meta.isSigner) {
      numRequiredSignatures++;
      if (!meta.isWritable) numReadonlySignedAccounts++;
    } else {
      if (!meta.isWritable) numReadonlyUnsignedAccounts++;
    }
  }

  // Build the account keys index: static keys, then every table's writable
  // loads, then every table's readonly loads — the order the runtime resolves.
  const allKeys = [...sortedKeys, ...loadedWritable, ...loadedReadonly];
  // Instruction account indexes are single bytes.
  if (allKeys.length > 256) {
    throw new Error(`Solana transaction references ${allKeys.length} accounts; a message can index at most 256.`);
  }
  const keyIndex = new Map();
  allKeys.forEach((k, i) => keyIndex.set(k, i));

  // Compile instructions
  const compiledInstructions = instructions.map(ix => {
    const programIdIndex = keyIndex.get(ix.programId);
    const accountIndices = ix.accounts.map(a => keyIndex.get(a.pubkey));
    return { programIdIndex, accountIndices, data: ix.data };
  });

  // Serialize MessageV0
  // Format: prefix(0x80) | header(3 bytes) | staticAccountKeys | recentBlockhash | instructions | addressTableLookups
  const parts = [];

  // Version prefix (0x80 = v0)
  parts.push(Buffer.from([0x80]));

  // Header: numRequiredSignatures, numReadonlySignedAccounts, numReadonlyUnsignedAccounts
  parts.push(Buffer.from([numRequiredSignatures, numReadonlySignedAccounts, numReadonlyUnsignedAccounts]));

  // Static account keys
  parts.push(encodeCompactU16(sortedKeys.length));
  for (const key of sortedKeys) {
    parts.push(base58DecodePubkey(key));
  }

  // Recent blockhash (32 bytes)
  parts.push(base58DecodePubkey(recentBlockhash));

  // Instructions
  parts.push(encodeCompactU16(compiledInstructions.length));
  for (const ix of compiledInstructions) {
    parts.push(Buffer.from([ix.programIdIndex]));
    parts.push(encodeCompactU16(ix.accountIndices.length));
    for (const idx of ix.accountIndices) {
      parts.push(Buffer.from([idx]));
    }
    parts.push(encodeCompactU16(ix.data.length));
    parts.push(ix.data);
  }

  // Address table lookups
  parts.push(encodeCompactU16(lookups.length));
  for (const lookup of lookups) {
    parts.push(base58DecodePubkey(lookup.key));
    parts.push(encodeCompactU16(lookup.writableIndexes.length));
    parts.push(Buffer.from(lookup.writableIndexes));
    parts.push(encodeCompactU16(lookup.readonlyIndexes.length));
    parts.push(Buffer.from(lookup.readonlyIndexes));
  }

  return { messageBytes: Buffer.concat(parts), numRequiredSignatures };
}

// ============= Ed25519 Signing =============

/**
 * Sign a message with Ed25519 using a Solana keypair (64 bytes: seed + pubkey).
 */
function signEd25519(message, keypairHex) {
  const seed = Buffer.from(keypairHex.slice(0, 64), 'hex'); // First 32 bytes
  const keyObj = crypto.createPrivateKey({
    key: Buffer.concat([
      Buffer.from('302e020100300506032b657004220420', 'hex'), // PKCS8 Ed25519 prefix
      seed,
    ]),
    format: 'der',
    type: 'pkcs8',
  });
  return crypto.sign(null, message, keyObj);
}

// ============= x402 Solana Payment =============

/**
 * Build an unsigned Solana x402 payment transaction.
 * Returns the serialized MessageV0 bytes and the full transaction bytes
 * (with both signature slots as 64 zero bytes).
 *
 * Used by local-key signing (createSvmPaymentPayload) and Privy server wallet signing.
 */
export function buildUnsignedSvmTransaction(
  requirements,
  walletAddress,
  recentBlockhash,
  decimals = 6,
  tokenProgram = TOKEN_PROGRAM,
) {
  const extra = requirements.extra || {};
  const feePayerStr = extra.feePayer;
  if (!feePayerStr) {
    throw new Error('feePayer is required in requirements.extra for SVM transactions');
  }

  const mint = requirements.asset;
  const amount = BigInt(resolvePaymentAmount(requirements));
  const payTo = resolvePayTo(requirements);

  // Derive ATAs
  const sourceATA = deriveATA(walletAddress, mint, tokenProgram);
  const destATA = deriveATA(payTo, mint, tokenProgram);

  // Build instructions
  // 1. SetComputeUnitLimit: [2, u32 LE]
  const cuLimitData = Buffer.alloc(5);
  cuLimitData[0] = 2;
  cuLimitData.writeUInt32LE(DEFAULT_COMPUTE_UNIT_LIMIT, 1);

  // 2. SetComputeUnitPrice: [3, u64 LE]
  const cuPriceData = Buffer.alloc(9);
  cuPriceData[0] = 3;
  cuPriceData.writeBigUInt64LE(BigInt(DEFAULT_COMPUTE_UNIT_PRICE_MICROLAMPORTS), 1);

  // 3. TransferChecked: [12, u64 amount LE, u8 decimals]
  const transferData = Buffer.alloc(10);
  transferData[0] = 12;
  transferData.writeBigUInt64LE(amount, 1);
  transferData[9] = decimals;

  // 4. Memo: random 16 bytes hex for nonce
  const memoData = Buffer.from(crypto.randomBytes(16).toString('hex'));

  const instructions = [
    {
      programId: COMPUTE_BUDGET_PROGRAM,
      accounts: [],
      data: cuLimitData,
    },
    {
      programId: COMPUTE_BUDGET_PROGRAM,
      accounts: [],
      data: cuPriceData,
    },
    {
      programId: tokenProgram,
      accounts: [
        { pubkey: sourceATA, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: destATA, isSigner: false, isWritable: true },
        { pubkey: walletAddress, isSigner: true, isWritable: false },
      ],
      data: transferData,
    },
    {
      programId: MEMO_PROGRAM,
      accounts: [],
      data: memoData,
    },
  ];

  const { messageBytes, numRequiredSignatures } = buildMessageV0({
    feePayer: feePayerStr,
    instructions,
    recentBlockhash,
  });
  // The header must agree with the signature slots written below. A
  // server-supplied feePayer equal to the paying wallet collapses the two
  // signers into one, and the transaction would fail sanitization at broadcast.
  if (numRequiredSignatures !== X402_SVM_SIGNER_COUNT) {
    const cause = feePayerStr === walletAddress
      ? `its feePayer is the paying wallet (${walletAddress}) instead of a facilitator account`
      : `its transaction requires ${numRequiredSignatures} signatures instead of ${X402_SVM_SIGNER_COUNT}`;
    throw new Error(
      `Cannot pay this x402 Solana option: ${cause}. ` +
      'Another payment option will be tried; if none succeeds, pay on another network or report this payment option to Nansen.',
    );
  }

  // Build transaction: compact-u16(numSignatures) + signatures + message
  // [facilitator placeholder, client placeholder], 64 zero bytes each
  const txBytes = Buffer.concat([
    encodeCompactU16(X402_SVM_SIGNER_COUNT),
    Buffer.alloc(X402_SVM_SIGNER_COUNT * SIGNATURE_BYTES),
    messageBytes,
  ]);

  return { messageBytes, txBase64: txBytes.toString('base64') };
}

/**
 * Build a signed Solana x402 payment transaction using a local Ed25519 keypair.
 * Calls buildUnsignedSvmTransaction internally, then signs with the private key.
 *
 * @returns {string} Base64-encoded PaymentPayload JSON for Payment-Signature header
 */
export function createSvmPaymentPayload(
  requirements,
  keypairHex,
  walletAddress,
  resource,
  recentBlockhash,
  decimals = 6,
  tokenProgram = TOKEN_PROGRAM,
) {
  const { messageBytes, txBase64: unsignedTxBase64 } = buildUnsignedSvmTransaction(
    requirements,
    walletAddress,
    recentBlockhash,
    decimals,
    tokenProgram,
  );

  // Sign: client signs the full message (with 0x80 version prefix already included)
  const clientSignature = signEd25519(messageBytes, keypairHex);

  // Write the client signature into slot 1 of the unsigned transaction, so
  // the wire layout is built in one place.
  const txBytes = Buffer.from(unsignedTxBase64, 'base64');
  const clientSlotOffset = encodeCompactU16(X402_SVM_SIGNER_COUNT).length + SIGNATURE_BYTES;
  clientSignature.copy(txBytes, clientSlotOffset);

  const txBase64 = txBytes.toString('base64');

  // Build x402 payload (camelCase per x402 spec)
  const payload = {
    x402Version: 2,
    payload: { transaction: txBase64 },
    accepted: requirements,
  };

  if (resource) {
    payload.resource = { url: resource };
  }

  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

function isHttpUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Fetch recent blockhash from Solana RPC.
 *
 * Defaults to the shared RPC registry so NANSEN_SOLANA_RPC is honoured even
 * for an argless call; every production caller passes the URL explicitly.
 */
export async function fetchRecentBlockhash(rpcUrl = CHAIN_RPCS.solana) {
  // Validate up front and never echo the raw value. A private RPC URL usually
  // carries an API key in its query string, and Node's own parse failure
  // ("Failed to parse URL from <value>") would otherwise copy it into the
  // error message that the Privy and local-wallet fallback loops print.
  if (!isHttpUrl(rpcUrl)) {
    throw new Error(
      'Invalid Solana RPC URL: expected a full http:// or https:// URL. Check NANSEN_SOLANA_RPC.'
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SOLANA_RPC_TIMEOUT_MS);
  const timeoutError = (cause) => new Error(
    `Solana RPC did not respond within ${SOLANA_RPC_TIMEOUT_MS / 1000}s while fetching a recent blockhash. Retry or configure a different RPC endpoint.`,
    { cause }
  );

  try {
    let response;
    try {
      response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getLatestBlockhash',
          params: [{ commitment: 'finalized' }],
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) throw timeoutError(err);
      throw new Error(
        `Solana RPC unavailable while fetching a recent blockhash. Retry or configure a different RPC endpoint. ${String(err.message ?? err)}`,
        { cause: err }
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(
        `Solana RPC returned HTTP ${response.status} while fetching a recent blockhash. Retry or configure a different RPC endpoint. ${text.slice(0, 100)}`
      );
    }

    let data;
    try {
      data = await response.json();
    } catch (err) {
      if (controller.signal.aborted) throw timeoutError(err);
      throw new Error(
        'Solana RPC returned an invalid response while fetching a recent blockhash. Retry or configure a different RPC endpoint.',
        { cause: err }
      );
    }

    if (data?.error) {
      const detail =
        data.error.message != null ? String(data.error.message)
        : data.error.code  != null ? String(data.error.code)
        : 'unknown RPC error';
      throw new Error(
        `Solana RPC failed while fetching a recent blockhash: ${detail}. Retry or configure a different RPC endpoint.`
      );
    }

    const blockhash = data?.result?.value?.blockhash;
    if (typeof blockhash !== 'string' || blockhash.length === 0) {
      throw new Error(
        'Solana RPC returned no recent blockhash. Retry or configure a different RPC endpoint.'
      );
    }

    return blockhash;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * getMultipleAccounts (base64) with the shared timeout and actionable errors.
 * Returns the accounts in request order and the slot the RPC read them at.
 */
async function getMultipleAccountsBase64(rpcUrl, addresses, purpose) {
  if (!isHttpUrl(rpcUrl)) {
    throw new Error(
      'Invalid Solana RPC URL: expected a full http:// or https:// URL. Check NANSEN_SOLANA_RPC.'
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SOLANA_RPC_TIMEOUT_MS);
  const rpcError = (detail, cause) => new Error(
    `Solana RPC ${detail} while fetching ${purpose}. Retry or configure a different RPC endpoint.`,
    cause ? { cause } : undefined
  );
  const timeoutError = (cause) => rpcError(`did not respond within ${SOLANA_RPC_TIMEOUT_MS / 1000}s`, cause);

  let data;
  try {
    let response;
    try {
      response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getMultipleAccounts',
          params: [addresses, { encoding: 'base64', commitment: 'confirmed' }],
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) throw timeoutError(err);
      throw rpcError('was unavailable', err);
    }
    if (!response.ok) throw rpcError(`returned HTTP ${response.status}`);
    try {
      data = await response.json();
    } catch (err) {
      if (controller.signal.aborted) throw timeoutError(err);
      throw rpcError('returned an invalid response', err);
    }
  } finally {
    clearTimeout(timer);
  }

  if (data?.error) {
    throw rpcError(`failed (${String(data.error.message ?? data.error.code ?? 'unknown RPC error')})`);
  }
  const accounts = data?.result?.value;
  // Each account is matched to its address by position, so a short or padded
  // array would pair an account with the wrong address.
  if (!Array.isArray(accounts) || accounts.length !== addresses.length) {
    throw rpcError('returned an unexpected account list');
  }
  return { accounts, slot: data.result.context?.slot };
}

const accountBytes = (account) =>
  Buffer.from((Array.isArray(account.data) ? account.data[0] : account.data) ?? '', 'base64');

/**
 * Fetch and parse address-lookup-table accounts, in the order given.
 *
 * Throws unless every address is a table owned by the lookup-table program
 * that the runtime will still resolve: a quote that names a missing, foreign or
 * deactivated table can't be compiled into a transaction the runtime accepts.
 * A table that is only deactivating is still usable (see isLookupTableUsable);
 * telling the two apart needs the SlotHashes sysvar, which is fetched only when
 * some table has a deactivation slot.
 */
export async function fetchAddressLookupTables(rpcUrl, addresses) {
  const { accounts } = await getMultipleAccountsBase64(rpcUrl, addresses, 'address lookup tables');

  const tables = accounts.map((account, i) => {
    const key = addresses[i];
    if (!account) {
      throw new Error(`Address lookup table ${key} not found on-chain. Get a new quote.`);
    }
    if (account.owner !== ADDRESS_LOOKUP_TABLE_PROGRAM) {
      throw new Error(`Account ${key} is not an address lookup table. Get a new quote.`);
    }
    return { key, ...parseAddressLookupTable(accountBytes(account)) };
  });

  if (tables.some((t) => t.deactivationSlot !== null)) {
    const { accounts: [sysvar], slot } = await getMultipleAccountsBase64(rpcUrl, [SLOT_HASHES_SYSVAR], 'recent slot hashes');
    if (!sysvar || sysvar.owner !== SYSVAR_PROGRAM || !Number.isSafeInteger(slot)) {
      throw new Error(
        'Solana RPC returned no usable SlotHashes sysvar, so a deactivating address lookup table cannot be checked. Retry or configure a different RPC endpoint.'
      );
    }
    const slotHashes = parseSlotHashes(accountBytes(sysvar));
    for (const table of tables) {
      if (!isLookupTableUsable(table.deactivationSlot, BigInt(slot), slotHashes)) {
        throw new Error(`Address lookup table ${table.key} has been deactivated. Get a new quote.`);
      }
    }
  }

  return tables.map(({ key, addresses: tableAddresses }) => ({ key, addresses: tableAddresses }));
}

/**
 * Get RPC URL for a Solana network identifier.
 */
export function getSolanaRpcUrl(network) {
  // Mainnet goes through the shared registry so NANSEN_SOLANA_RPC applies to
  // x402 blockhash and balance calls the same way it does to every other
  // Solana path (transfer, trading, limit orders). The default is unchanged.
  if (network === SOLANA_MAINNET_NETWORK) return CHAIN_RPCS.solana;
  // Devnet/testnet resolve for tooling (e.g. balance checks), but the x402 pay
  // path never reaches them: SVM_X402_TOKENS is mainnet-only, so the policy layer
  // refuses a devnet/testnet requirement before signing. Adding a non-mainnet
  // token entry would silently enable signing here — revisit this gate if you do.
  if (network === 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1') return 'https://api.devnet.solana.com';
  if (network === 'solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z') return 'https://api.testnet.solana.com';
  throw new Error(`Unsupported Solana network for x402: ${network}`);
}

/**
 * Check if a network string is a Solana network.
 */
export function isSvmNetwork(network) {
  return typeof network === 'string' && network.startsWith('solana:');
}
