/**
 * Solana swap-outcome simulation: run a swap transaction through
 * `simulateTransaction` and report the resulting balance changes to the
 * signer's wallet.
 *
 * This is the Solana sibling of swap-simulation.js. Solana signs the
 * aggregator's serialized transaction verbatim, so this is the only check that
 * confirms the wallet actually comes out the way the quote promised — the
 * static checks in trade-validation.js inspect the instructions themselves,
 * not their effect. All delta math runs here, client-side, from the raw
 * `accounts` snapshot the RPC returns, so the verification stays independent
 * of the service that built the quote.
 *
 * Unlike the EVM simulation endpoint, `simulateTransaction` (with `accounts` +
 * `replaceRecentBlockhash`) is a standard public-RPC method — no trace RPC, no
 * Nansen-hosted proxy. It is always called anonymously (see SIMULATION_RPCS.solana
 * in rpc-urls.js); the Nansen API key is never attached here.
 */

import { SIMULATION_RPCS } from './rpc-urls.js';
import { parseTransactionMessage } from './solana-tx.js';
import { base58Decode, base58Encode } from './wallet.js';

// Mirrors NATIVE_SOL_SYSTEM_MINT in trading.js / SOLANA_NATIVE_SOL_ALIASES in
// trade-validation.js (duplicated, not imported, to avoid a circular import —
// both of those modules will import from this one).
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const SOL_SENTINEL = '11111111111111111111111111111111';
// Same base58 string as SOL_SENTINEL, but here it means the program that owns
// ordinary wallet (keypair) accounts.
const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const TOKEN_PROGRAMS = new Set(['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']);
// An SPL Approve of u64::MAX is an unlimited allowance.
const U64_MAX = (1n << 64n) - 1n;

function isSolanaNativeMint(mint) {
  return mint === WSOL_MINT || mint === SOL_SENTINEL;
}

// getMultipleAccounts caps at 100 keys per call; batch defensively even though
// a real swap's writable-account set is well under this.
const MAX_ACCOUNTS_PER_CALL = 100;

/**
 * A simulation error the caller can distinguish from a genuine outcome mismatch.
 * `code` is one of:
 *   NO_SIM_RPC             - no simulation endpoint configured for the chain
 *   SIM_RPC_ERROR           - transport/parse failure talking to the endpoint,
 *                             OR a 200 OK sim that omitted the `accounts`
 *                             result we asked for (an RPC capability gap, not
 *                             a corrupt result — see the throw site below)
 *   SIM_REVERTED            - the transaction itself reverted in simulation
 *   SIM_RESULT_UNPARSEABLE  - the sim ran AND returned the accounts we asked
 *                             for, but a tracked balance or lookup table
 *                             couldn't be resolved/parsed
 *   SIM_ACCOUNT_CONTROL_CHANGED - the simulated post-state hands control of one
 *                             of the wallet's own accounts to someone else (new
 *                             owner, delegate or close authority, or the wallet
 *                             reassigned to another program or given data),
 *                             whatever the balances say; a changed authority,
 *                             close or withdrawal on a stake or nonce account
 *                             the wallet controls; or a token Approve or
 *                             SetAuthority the wallet signs from inside another
 *                             program (CPI), which the post-state can hide, or
 *                             a CPI that hands the wallet a token account whose
 *                             post-state wasn't checked; or a CPI'd Stake
 *                             program instruction, or System nonce authorize or
 *                             withdraw, the wallet signs
 *   SIM_INNER_INSTRUCTIONS_UNAVAILABLE - the sim ran but the RPC returned no
 *                             readable inner instructions, so the CPI check
 *                             above can't run
 * NO_SIM_RPC and SIM_RPC_ERROR are degrade conditions (warn, proceed per
 * policy); the caller decides. SIM_REVERTED, SIM_RESULT_UNPARSEABLE,
 * SIM_ACCOUNT_CONTROL_CHANGED and SIM_INNER_INSTRUCTIONS_UNAVAILABLE are
 * outcome/parse problems and must not be silently ignored — fail closed.
 */
export class SolanaSimulationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SolanaSimulationError';
    this.code = code;
  }
}

/** Whether a sim-capable endpoint is configured for this chain. */
export function hasSolanaSimulationRpc(chain) {
  return chain === 'solana' && Boolean(SIMULATION_RPCS.solana);
}

async function rpcCall(rpcUrl, method, params, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: controller.signal,
    });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new SolanaSimulationError(
        'SIM_RPC_ERROR',
        `Simulation RPC returned non-JSON (HTTP ${res.status}) for ${method}: ${text.slice(0, 120)}`,
      );
    }
    const ok = res.ok ?? (res.status >= 200 && res.status < 300);
    if (!ok) {
      const detail = body?.error?.message || text.slice(0, 120);
      throw new SolanaSimulationError('SIM_RPC_ERROR', `Simulation RPC HTTP ${res.status} for ${method}: ${detail}`);
    }
    if (body.error) {
      throw new SolanaSimulationError('SIM_RPC_ERROR', `${method} error: ${body.error.message || JSON.stringify(body.error)}`);
    }
    return body.result;
  } catch (e) {
    if (e instanceof SolanaSimulationError) throw e;
    if (e.name === 'AbortError') {
      throw new SolanaSimulationError('SIM_RPC_ERROR', `Simulation RPC timed out after ${timeoutMs}ms (${method})`);
    }
    throw new SolanaSimulationError('SIM_RPC_ERROR', `Simulation RPC request failed (${method}): ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
}

async function getMultipleAccountsChunked(rpcUrl, pubkeys, encoding, timeoutMs) {
  if (!pubkeys.length) return [];
  const out = [];
  for (let i = 0; i < pubkeys.length; i += MAX_ACCOUNTS_PER_CALL) {
    const chunk = pubkeys.slice(i, i + MAX_ACCOUNTS_PER_CALL);
    const result = await rpcCall(rpcUrl, 'getMultipleAccounts', [chunk, { encoding, commitment: 'confirmed' }], timeoutMs);
    if (!Array.isArray(result?.value)) {
      throw new SolanaSimulationError(
        'SIM_RPC_ERROR',
        `getMultipleAccounts returned no account array (value: ${JSON.stringify(result?.value)}); RPC may be rate-limiting or malfunctioning.`,
      );
    }
    // The RPC spec guarantees value.length === chunk.length (null entries for
    // missing accounts), and every downstream read indexes into this array
    // positionally against writableKeys. A short array would silently shift
    // every later account's pre-state by one slot rather than fail loudly —
    // treat a non-conforming length the same as a malformed response.
    if (result.value.length !== chunk.length) {
      throw new SolanaSimulationError(
        'SIM_RPC_ERROR',
        `getMultipleAccounts returned ${result.value.length} accounts for a ${chunk.length}-key request; RPC may be rate-limiting or malfunctioning.`,
      );
    }
    out.push(...result.value);
  }
  return out;
}

/**
 * A static account index is writable unless it's a readonly signer or one of
 * the trailing readonly non-signers. Mirrors the header layout parsed by
 * parseTransactionMessage (solana-tx.js).
 */
function isStaticWritable(parsed, index) {
  const { numRequiredSignatures, numReadonlySignedAccounts, numReadonlyUnsignedAccounts } = parsed.header;
  const numStatic = parsed.staticAccountKeys.length;
  if (index < numRequiredSignatures) {
    return index < numRequiredSignatures - numReadonlySignedAccounts;
  }
  return index < numStatic - numReadonlyUnsignedAccounts;
}

/**
 * Resolve only the WRITABLE accounts a v0 transaction references through
 * address-lookup-tables. A readonly ALT account can never change balance, so
 * it's irrelevant to the drain-surface check below — resolving only the
 * writable indexes saves decoding entries this check will never use.
 */
async function resolveAltWritableAccounts(rpcUrl, parsed, timeoutMs) {
  if (!parsed.addressTableLookups.length) return [];
  const tableAddresses = parsed.addressTableLookups.map((l) => l.lookupTableAddress);
  const tableInfos = await getMultipleAccountsChunked(rpcUrl, tableAddresses, 'base64', timeoutMs);

  const resolved = [];
  parsed.addressTableLookups.forEach((lookup, i) => {
    const info = tableInfos[i];
    if (!info) {
      throw new SolanaSimulationError(
        'SIM_RESULT_UNPARSEABLE',
        `Address lookup table ${lookup.lookupTableAddress} not found; cannot resolve its accounts.`,
      );
    }
    // LookupTableMeta: typeIndex u32, deactivationSlot u64, lastExtendedSlot u64,
    // lastExtendedSlotStartIndex u8, authority Option<Pubkey>, padding — 32-byte
    // pubkeys begin at byte offset 56.
    const raw = Array.isArray(info.data) ? info.data[0] : info.data;
    const buf = Buffer.from(raw, 'base64');
    for (const idx of lookup.writableIndexes) {
      const offset = 56 + idx * 32;
      if (offset + 32 > buf.length) {
        throw new SolanaSimulationError(
          'SIM_RESULT_UNPARSEABLE',
          `Address lookup table ${lookup.lookupTableAddress} has no entry at index ${idx}.`,
        );
      }
      resolved.push(base58Encode(buf.subarray(offset, offset + 32)));
    }
  });
  return resolved;
}

/** Lamports (native) or SPL token base-unit balance from a jsonParsed account. */
function extractBalance(kind, info) {
  if (!info) return 0n;
  try {
    if (kind === 'native') return BigInt(info.lamports ?? 0);
    const amt = info.data?.parsed?.info?.tokenAmount?.amount;
    return amt != null ? BigInt(amt) : 0n;
  } catch {
    throw new SolanaSimulationError('SIM_RESULT_UNPARSEABLE', `Could not parse a simulated ${kind} balance.`);
  }
}

/**
 * Whether an account holds data. RPC account objects carry `space` (data
 * length) and `data` as [base64, encoding], or as a parsed object when the node
 * could parse it, which means there is data. A shape that shows neither throws,
 * so an unreadable wallet post-state is never read as dataless.
 */
function accountHasData(info) {
  if (typeof info?.space === 'number') return info.space > 0;
  if (Array.isArray(info?.data) && typeof info.data[0] === 'string') return info.data[0].length > 0;
  if (info?.data && typeof info.data === 'object') return true;
  throw new SolanaSimulationError('SIM_RESULT_UNPARSEABLE', 'Simulation returned an unreadable wallet account; cannot verify the outcome.');
}

/**
 * Whether a simulated post-state shows the account closed. simulateTransaction
 * returns a closed account as an empty System-owned account with zero lamports
 * (`{ lamports: 0, owner: System, data: ['', 'base64'], space: 0 }`), not as
 * null; null is accepted too. Any shape it can't read is not closed, so a
 * wallet token account in that shape fails closed as unreadable instead.
 */
function isClosedAccount(info) {
  if (!info) return true;
  if (info.owner !== SYSTEM_PROGRAM) return false;
  // Strict: BigInt('') and Number(null) are both zero.
  const { lamports } = info;
  const readable = (typeof lamports === 'number' && Number.isSafeInteger(lamports))
    || (typeof lamports === 'string' && /^\d+$/.test(lamports));
  if (!readable || BigInt(lamports) !== 0n) return false;
  if (typeof info.space === 'number') return info.space === 0;
  return Array.isArray(info.data) && info.data[0] === '';
}

// The largest pre-state an existing account can have and still be tracked as a
// possible new wallet token account. A token account is 165 bytes; one of the
// newer token program with every account extension stays well under this.
// Pool and market accounts above it are left out, so their post-state isn't
// requested from the simulation, where it could push the call past its timeout.
// A larger account handed to the wallet with SetAuthority(AccountOwner) is
// caught from the instructions instead (see assertInnerTokenInstructionsSafe).
const MAX_CANDIDATE_ACCOUNT_BYTES = 2048;

function accountDataLength(info) {
  if (typeof info?.space === 'number') return info.space;
  if (Array.isArray(info?.data) && typeof info.data[0] === 'string') return Buffer.byteLength(info.data[0], 'base64');
  return 0; // parsed by the node: a small, known account type
}

/**
 * The parsed SPL token-account fields of a jsonParsed account, or null if it
 * isn't one. A token-account snapshot missing its mint, owner or amount throws:
 * read as an empty account, its real balance would count as swap output, or it
 * would drop out of tracking.
 */
function tokenAccountFields(info) {
  const parsed = info?.data?.parsed;
  if (parsed?.type !== 'account') return null;
  const fields = parsed.info;
  if (
    !fields || typeof fields !== 'object'
    || typeof fields.mint !== 'string' || typeof fields.owner !== 'string'
    || typeof fields.tokenAmount?.amount !== 'string' || !/^\d+$/.test(fields.tokenAmount.amount)
  ) {
    throw new SolanaSimulationError('SIM_RESULT_UNPARSEABLE', 'Simulation returned an incomplete SPL token account; cannot verify the outcome.');
  }
  return fields;
}

/**
 * The owner bytes of a token account the node returned raw (base64) instead of
 * parsed, or null when it isn't a token account. SPL layout: mint 0..32, owner
 * 32..64. A 165-byte account is a token account; a longer Token-2022 one
 * carries account type 2 at offset 165 (a mint has 1 there).
 */
function rawTokenAccountOwner(info) {
  if (!TOKEN_PROGRAMS.has(info?.owner) || !Array.isArray(info.data) || info.data[1] !== 'base64') return null;
  const bytes = Buffer.from(info.data[0], 'base64');
  if (bytes.length < 165 || (bytes.length > 165 && bytes[165] !== 2)) return null;
  return bytes.subarray(32, 64);
}

function controlChanged(detail) {
  return new SolanaSimulationError(
    'SIM_ACCOUNT_CONTROL_CHANGED',
    `Simulation shows this transaction ${detail} This changes who controls your wallet's accounts, which balance checks do not catch. Refusing to sign.`,
  );
}

/**
 * The delegated amount of a parsed token account, 0n when it has no delegate.
 * The RPC's parsed form always carries `delegatedAmount` next to a delegate;
 * one without it (or with a non-numeric amount) throws, since reading it as 0
 * would hide a grown allowance.
 */
function delegatedAmountOf(fields) {
  if (!fields?.delegate) return 0n;
  const amount = fields.delegatedAmount?.amount;
  if (typeof amount !== 'string' || !/^\d+$/.test(amount)) {
    throw new SolanaSimulationError('SIM_RESULT_UNPARSEABLE', 'Simulation returned a token delegate without a readable delegated amount; cannot verify the outcome.');
  }
  return BigInt(amount);
}

/**
 * Balance deltas can't see a transaction that leaves every balance alone but
 * hands someone else control of the wallet's token account (a CPI'd Approve or
 * SetAuthority carries the wallet's signature, and the static instruction check
 * only classifies top-level instructions). Compare the authorities themselves.
 * `pre` is null for an account the transaction creates.
 */
function assertTokenAccountControl(pubkey, pre, post, walletAddress) {
  const label = `token account ${pubkey} (mint ${post.mint})`;
  if (post.owner !== walletAddress) {
    throw controlChanged(`transfers ownership of your ${label} to ${post.owner}.`);
  }
  // The wallet itself as delegate or close authority leaves control with the
  // wallet, so it isn't a hand-off.
  if (post.delegate && post.delegate !== walletAddress) {
    const preDelegate = pre?.delegate || null;
    const amount = delegatedAmountOf(post);
    if (post.delegate !== preDelegate || amount > delegatedAmountOf(pre)) {
      const shown = amount === U64_MAX ? 'an unlimited amount' : `${amount} base units`;
      throw controlChanged(`approves ${post.delegate} to spend ${shown} from your ${label}.`);
    }
  }
  if (post.closeAuthority && post.closeAuthority !== walletAddress && post.closeAuthority !== (pre?.closeAuthority || null)) {
    throw controlChanged(`sets ${post.closeAuthority} as the close authority of your ${label}.`);
  }
}

const STAKE_PROGRAM = 'Stake11111111111111111111111111111111111111';

/**
 * Which kind of wallet-controlled authority account a jsonParsed pre-state is:
 * 'stake' (the wallet is its staker, withdrawer or lockup custodian), 'nonce'
 * (an initialized nonce account the wallet is the authority of), or null.
 * Throws when an initialized one has unreadable authorities.
 * Shapes captured from mainnet getAccountInfo and simulateTransaction.
 */
function walletAuthorityAccountKind(pubkey, info, walletAddress) {
  // Raw (base64) data is left to rawWalletAuthorityAccount.
  if ((info?.owner !== STAKE_PROGRAM && info?.owner !== SYSTEM_PROGRAM) || Array.isArray(info.data)) return null;
  const unreadable = () => new SolanaSimulationError('SIM_RESULT_UNPARSEABLE', `Simulation returned an unreadable stake or nonce account (${pubkey}); cannot verify who controls it.`);
  // No data at all can't be shown not to be the wallet's.
  if (!info.data) throw unreadable();
  const parsed = info.data.parsed;
  // Allow-list the shapes that carry no authority; any other one must have
  // readable authorities, since it can't be shown not to be the wallet's.
  if (info.owner === STAKE_PROGRAM) {
    if (parsed?.type === 'uninitialized' || parsed?.type === 'rewardsPool') return null;
    const fields = authorityFields('stake', info);
    if (!fields) throw unreadable();
    return fields.staker === walletAddress || fields.withdrawer === walletAddress || fields['lockup custodian'] === walletAddress ? 'stake' : null;
  }
  // Under jsonParsed the node parses a System-owned account only as a nonce
  // account (authorityFields checks the program too).
  if (parsed?.type === 'uninitialized') return null;
  const fields = parsed?.type === 'initialized' ? authorityFields('nonce', info) : null;
  if (!fields) throw unreadable();
  return fields.authority === walletAddress ? 'nonce' : null;
}

/**
 * Whether a stake or nonce account the node returned unparsed (base64) holds the
 * wallet's key in an authority field. Stake layout: state u32, rent-exempt
 * reserve u64, staker 12..44, withdrawer 44..76, lockup timestamp and epoch,
 * custodian 92..124. Nonce layout: version u32, state u32, authority 8..40.
 */
function rawWalletAuthorityAccount(info, walletBytes) {
  // Only these two owners' accounts are decoded: other writable accounts (pools,
  // markets) can be large.
  if ((info?.owner !== STAKE_PROGRAM && info?.owner !== SYSTEM_PROGRAM) || !Array.isArray(info.data)) return false;
  // Canonical base64 only: Node's decoder silently drops invalid characters.
  if (info.data.length !== 2 || info.data[1] !== 'base64' || typeof info.data[0] !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(info.data[0])) {
    throw new SolanaSimulationError('SIM_RESULT_UNPARSEABLE', 'Simulation returned an unreadable stake or nonce account; cannot verify who controls it.');
  }
  const bytes = Buffer.from(info.data[0], 'base64');
  const at = (start) => bytes.subarray(start, start + 32).equals(walletBytes);
  if (info.owner === STAKE_PROGRAM) {
    // Too short to hold the custodian: its authorities can't be read.
    if (bytes.length < 124) throw new SolanaSimulationError('SIM_RESULT_UNPARSEABLE', 'Simulation returned an unreadable stake or nonce account; cannot verify who controls it.');
    return at(12) || at(44) || at(92);
  }
  return info.owner === SYSTEM_PROGRAM && bytes.length === 80 && at(8);
}

function lamportsOf(info, label) {
  const { lamports } = info;
  if ((typeof lamports === 'number' && Number.isSafeInteger(lamports) && lamports >= 0) || (typeof lamports === 'string' && /^\d+$/.test(lamports))) {
    return BigInt(lamports);
  }
  throw new SolanaSimulationError('SIM_RESULT_UNPARSEABLE', `Could not parse the lamport balance of your ${label}; cannot verify the outcome.`);
}

/**
 * The authority fields of a parsed stake or nonce account, as strings, or null
 * when the post-state isn't a readable account of that kind.
 */
function authorityFields(kind, info) {
  const parsed = info?.data?.parsed;
  if (kind === 'stake') {
    if (info.owner !== STAKE_PROGRAM) return null;
    const meta = parsed?.info?.meta;
    const { staker, withdrawer } = meta?.authorized || {};
    const { custodian, epoch, unixTimestamp } = meta?.lockup || {};
    // u64/i64 values: a number above 2^53 was already rounded by JSON.parse.
    const exact = (v) => (typeof v === 'number' && Number.isSafeInteger(v)) || (typeof v === 'string' && /^-?\d+$/.test(v));
    if (![staker, withdrawer, custodian].every(isPubkey) || !exact(epoch) || !exact(unixTimestamp)) return null;
    return { staker, withdrawer, 'lockup custodian': custodian, 'lockup epoch': String(epoch), 'lockup end time': String(unixTimestamp) };
  }
  if (info.owner !== SYSTEM_PROGRAM || info.data?.program !== 'nonce' || !isPubkey(parsed?.info?.authority)) return null;
  return { authority: parsed.info.authority };
}

/**
 * A stake or nonce account the wallet controls holds SOL that balance deltas
 * don't count. A wallet-signed Authorize, SetLockup or AuthorizeNonceAccount
 * hands it to someone else without moving a lamport, and a wallet-signed
 * Withdraw moves its lamports out (to an attacker, or to the wallet, where it
 * would count as swap output). No swap needs either, so refuse any authority
 * change, a close, or a lamport decrease. Lamports coming in and a nonce
 * advancing are fine.
 */
function assertWalletAuthorityAccountUnchanged(pubkey, kind, pre, post) {
  const label = `${kind} account ${pubkey}`;
  if (isClosedAccount(post)) {
    throw controlChanged(`closes your ${label} and withdraws its SOL.`);
  }
  const before = authorityFields(kind, pre);
  const after = authorityFields(kind, post);
  if (!before || !after) {
    throw new SolanaSimulationError('SIM_RESULT_UNPARSEABLE', `Simulation returned an unreadable post-state for your ${label}; cannot verify who controls it.`);
  }
  for (const [field, value] of Object.entries(before)) {
    if (after[field] !== value) {
      throw controlChanged(`changes the ${field} of your ${label} from ${value} to ${after[field]}.`);
    }
  }
  const preLamports = lamportsOf(pre, label);
  const postLamports = lamportsOf(post, label);
  if (postLamports < preLamports) {
    throw controlChanged(`withdraws ${preLamports - postLamports} lamports from your ${label}.`);
  }
}

// SPL Token instruction discriminators (the same in either token program).
const SPL_APPROVE = 4;
const SPL_SET_AUTHORITY = 6;
const SPL_APPROVE_CHECKED = 13;
// Raw layouts: position of the authority in the instruction's account list. A
// multisig authority's signers follow it.
const RAW_AUTHORITY_LAYOUTS = {
  [SPL_APPROVE]: { kind: 'approve', authorityPos: 2 },
  [SPL_APPROVE_CHECKED]: { kind: 'approve', authorityPos: 3 },
  [SPL_SET_AUTHORITY]: { kind: 'setAuthority', authorityPos: 1 },
};
// SetAuthority data: [6, authorityType u8, COption tag u8, new authority 32].
// AuthorityType::AccountOwner is 2 in either token program.
const SPL_AUTHORITY_ACCOUNT_OWNER = 2;
const UNREADABLE_INNER = 'Simulation returned an unreadable token-program inner instruction; cannot verify the outcome.';
const isPubkey = (v) => typeof v === 'string' && v.length > 0;

/**
 * The new owner a raw SetAuthority data buffer hands a token account to, or
 * null when it changes another authority type or clears it.
 */
function rawNewAccountOwner(data) {
  if (data.length < 35 || data[1] !== SPL_AUTHORITY_ACCOUNT_OWNER || data[2] !== 1) return null;
  return base58Encode(data.subarray(3, 35));
}

/**
 * Classify one inner instruction as a token-program Approve or SetAuthority
 * ({ kind, account, authorities, newOwner? }), or null for anything else.
 * `newOwner` is set on a SetAuthority that hands a token account to a new
 * owner.
 * simulateTransaction returns inner instructions with addresses already
 * resolved (lookup tables included): a parsed token instruction carries
 * `parsed.type`/`parsed.info`; one the node couldn't parse carries `accounts`
 * (pubkeys) and base58 `data`. Throws on a shape it can't read, so a malformed
 * entry never reads as harmless.
 */
function classifyInnerTokenInstruction(ix) {
  if (!ix || typeof ix !== 'object' || !isPubkey(ix.programId)) {
    throw new SolanaSimulationError('SIM_RESULT_UNPARSEABLE', 'Simulation returned a malformed inner instruction; cannot verify the outcome.');
  }
  if (!TOKEN_PROGRAMS.has(ix.programId)) return null;

  if (ix.parsed !== undefined) {
    if (!ix.parsed || typeof ix.parsed !== 'object') throw new SolanaSimulationError('SIM_RESULT_UNPARSEABLE', UNREADABLE_INNER);
    const { type, info } = ix.parsed;
    if (!['approve', 'approveChecked', 'setAuthority'].includes(type)) return null;
    if (!info || typeof info !== 'object') throw new SolanaSimulationError('SIM_RESULT_UNPARSEABLE', UNREADABLE_INNER);
    const signers = Array.isArray(info.signers) ? info.signers : [];
    const out = type === 'setAuthority'
      // `account` is a token account or a mint, depending on the authority type.
      ? {
        kind: 'setAuthority',
        account: info.account ?? info.mint,
        authorities: [info.authority, info.multisigAuthority, ...signers],
        newOwner: info.authorityType === 'accountOwner' && isPubkey(info.newAuthority) ? info.newAuthority : null,
      }
      : { kind: 'approve', account: info.source, authorities: [info.owner, info.multisigOwner, ...signers] };
    const authorities = out.authorities.filter((a) => a != null);
    if (!isPubkey(out.account) || authorities.length === 0 || !authorities.every(isPubkey)) {
      throw new SolanaSimulationError('SIM_RESULT_UNPARSEABLE', UNREADABLE_INNER);
    }
    return { ...out, authorities };
  }

  // Unparsed: raw account list + data, same layouts as the static top-level check.
  let data;
  try {
    if (!Array.isArray(ix.accounts) || !ix.accounts.every(isPubkey) || typeof ix.data !== 'string') throw new Error('shape');
    data = base58Decode(ix.data);
  } catch {
    throw new SolanaSimulationError('SIM_RESULT_UNPARSEABLE', UNREADABLE_INNER);
  }
  const layout = data.length ? RAW_AUTHORITY_LAYOUTS[data[0]] : undefined;
  if (!layout) return null;
  if (ix.accounts.length <= layout.authorityPos) throw new SolanaSimulationError('SIM_RESULT_UNPARSEABLE', UNREADABLE_INNER);
  return {
    kind: layout.kind,
    account: ix.accounts[0],
    authorities: ix.accounts.slice(layout.authorityPos),
    newOwner: layout.kind === 'setAuthority' ? rawNewAccountOwner(data) : null,
  };
}

// parsed.info keys that name a new authority or a recipient, not a signer: a
// stake-pool withdrawal legitimately names the wallet there.
const STAKE_NON_SIGNER_KEYS = new Set(['newAuthority', 'newAuthorized', 'destination']);
const UNREADABLE_INNER_STAKE = 'Simulation returned an unreadable Stake program inner instruction; cannot verify the outcome.';
const SYSTEM_WITHDRAW_NONCE = 5;
const SYSTEM_AUTHORIZE_NONCE = 7;

/**
 * Throw when an inner instruction runs a Stake program instruction, or a
 * System nonce authorize/withdraw, with the wallet's signature: the same rule
 * the static check applies at top level. A CPI can change and restore the
 * account inside one transaction, so the post-state alone can't show it.
 * Parsed Stake instructions are refused when the wallet is any top-level
 * `info` value other than a new authority or a recipient (deny by default, so
 * types not captured here are covered); raw ones when the wallet is anywhere
 * in `accounts`. `ix.programId` was already validated by the token classifier.
 */
function assertInnerStakeNonceInstructionSafe(ix, walletAddress) {
  if (ix.programId === STAKE_PROGRAM) {
    if (ix.parsed !== undefined) {
      if (!ix.parsed || typeof ix.parsed !== 'object') throw new SolanaSimulationError('SIM_RESULT_UNPARSEABLE', UNREADABLE_INNER_STAKE);
      const { type, info } = ix.parsed;
      if (!info || typeof info !== 'object') throw new SolanaSimulationError('SIM_RESULT_UNPARSEABLE', UNREADABLE_INNER_STAKE);
      if (Object.entries(info).some(([k, v]) => !STAKE_NON_SIGNER_KEYS.has(k) && v === walletAddress)) {
        throw controlChanged(`runs a Stake program instruction (${type}) with your wallet's signature, from inside another program.`);
      }
      return;
    }
    if (!Array.isArray(ix.accounts)) throw new SolanaSimulationError('SIM_RESULT_UNPARSEABLE', UNREADABLE_INNER_STAKE);
    if (ix.accounts.includes(walletAddress)) {
      throw controlChanged('runs a Stake program instruction with your wallet\'s signature, from inside another program.');
    }
    return;
  }
  if (ix.programId !== SYSTEM_PROGRAM) return;
  if (ix.parsed !== undefined) {
    const info = ix.parsed?.info;
    if (info && typeof info === 'object' && info.nonceAccount !== undefined
      && info.nonceAuthority === walletAddress && ix.parsed.type !== 'advanceNonce') {
      throw controlChanged(`changes or withdraws from nonce account ${info.nonceAccount} with your wallet's signature, from inside another program.`);
    }
    return;
  }
  if (!Array.isArray(ix.accounts) || typeof ix.data !== 'string') {
    throw new SolanaSimulationError('SIM_RESULT_UNPARSEABLE', 'Simulation returned an unreadable System program inner instruction; cannot verify the outcome.');
  }
  let data;
  try {
    data = base58Decode(ix.data);
  } catch {
    throw new SolanaSimulationError('SIM_RESULT_UNPARSEABLE', 'Simulation returned an unreadable System program inner instruction; cannot verify the outcome.');
  }
  if (data.length < 4) return;
  const discriminator = data.readUInt32LE(0);
  if ((discriminator === SYSTEM_WITHDRAW_NONCE || discriminator === SYSTEM_AUTHORIZE_NONCE) && ix.accounts.includes(walletAddress)) {
    throw controlChanged(`changes or withdraws from nonce account ${ix.accounts[0]} with your wallet's signature, from inside another program.`);
  }
}

/**
 * The static instruction check (assertSolanaInstructionsSafe in
 * trade-validation.js) only sees top-level instructions, and the post-state
 * can't show a delegate or authority that a CPI sets and the same transaction
 * then hides again (approve, then close the account; or close it and re-create
 * it at the same address). A CPI runs with the wallet's signature, so apply the
 * top-level rule to every inner instruction: refuse an Approve or SetAuthority
 * the wallet authorizes, whatever account it targets, and a Stake or nonce
 * instruction the wallet signs (assertInnerStakeNonceInstructionSafe).
 *
 * A SetAuthority that someone else signs to hand a token account to the wallet
 * is refused when that account's post-state isn't checked (`trackedKeys`):
 * the token program clears the delegate on an owner change, but the previous
 * owner's close authority stays in place. Accounts larger than MAX_CANDIDATE_ACCOUNT_BYTES before the
 * transaction aren't tracked, and the end state alone can't show this. A
 * tracked account goes through assertTokenAccountControl instead.
 *
 * CloseAccount is deliberately not checked here: a router may close a
 * temporary account it opened for the wallet and pay the SOL on. Where that
 * rent goes is bounded by the native-SOL output check instead.
 */
function assertInnerTokenInstructionsSafe(innerGroups, walletAddress, trackedKeys) {
  for (const group of innerGroups) {
    if (!Array.isArray(group?.instructions)) {
      throw new SolanaSimulationError('SIM_RESULT_UNPARSEABLE', 'Simulation returned malformed inner instructions; cannot verify the outcome.');
    }
    for (const ix of group.instructions) {
      const op = classifyInnerTokenInstruction(ix);
      if (!op) {
        assertInnerStakeNonceInstructionSafe(ix, walletAddress);
        continue;
      }
      if (op.authorities.includes(walletAddress)) {
        if (op.kind === 'approve') {
          throw controlChanged(`approves a delegate on token account ${op.account} with your wallet's signature, from inside another program.`);
        }
        throw controlChanged(`changes an authority of ${op.account} with your wallet's signature, from inside another program.`);
      }
      if (op.newOwner === walletAddress && !trackedKeys.has(op.account)) {
        throw controlChanged(`hands token account ${op.account} to your wallet from inside another program, and its end state was not checked for a close authority left in place.`);
      }
    }
  }
}

/**
 * Whether simulateTransaction returned inner instructions this module can
 * read. A node that honors the param returns [] when there are none; a missing
 * field or compiled entries (programIdIndex, no resolved programId) means the
 * node can't give the CPI check what it needs. Anything else malformed is left
 * to the classifier to reject.
 */
function innerInstructionsReadable(innerGroups) {
  if (!Array.isArray(innerGroups)) return false;
  return !innerGroups.some((g) => Array.isArray(g?.instructions)
    && g.instructions.some((ix) => ix && typeof ix === 'object' && ix.programId === undefined && typeof ix.programIdIndex === 'number'));
}

/**
 * Simulate a Solana swap transaction and return the normalised asset changes
 * it causes to `walletAddress`'s wallet.
 *
 * @param {string} chain - chain key (only 'solana' is wired today)
 * @param {string} txBase64 - the serialized transaction to simulate, unsigned
 * @param {{ walletAddress: string, timeoutMs?: number, allowMissingInnerInstructions?: boolean }} opts
 *   allowMissingInnerInstructions: when the RPC returns no inner instructions,
 *   skip the inner-instruction check instead of throwing
 *   SIM_INNER_INSTRUCTIONS_UNAVAILABLE. Every other check still runs.
 * @returns {Promise<{ deltas: Record<string, bigint>, method: string, innerInstructionsChecked: boolean }>}
 *   deltas is keyed by mint address, with native SOL (and any WSOL leg of the
 *   same swap) folded under SOL_SENTINEL. innerInstructionsChecked is false
 *   only when allowMissingInnerInstructions let a missing set through.
 * @throws {SolanaSimulationError} on any degrade condition, an in-sim revert,
 *   or an unparseable result.
 */
export async function simulateSolanaAssetChanges(chain, txBase64, { walletAddress, timeoutMs = 20000, allowMissingInnerInstructions = false } = {}) {
  const rpcUrl = SIMULATION_RPCS[chain];
  if (!rpcUrl) {
    throw new SolanaSimulationError('NO_SIM_RPC', `No simulation RPC configured for chain '${chain}'.`);
  }
  if (!walletAddress) {
    throw new SolanaSimulationError('SIM_RPC_ERROR', 'simulateSolanaAssetChanges requires a `walletAddress`.');
  }

  const parsed = parseTransactionMessage(txBase64);

  // Deduplicated: the same pubkey could in principle appear more than once
  // across the static keys and ALT-resolved writable indexes (or across two
  // different lookup tables). Without dedup, tracking + summing its delta
  // twice would double (or further inflate) a real balance change, letting
  // assertSolanaSwapOutcome's minimum-output check pass on an inflated delta
  // that doesn't reflect what the wallet actually received.
  const writableKeys = [];
  const seenWritableKeys = new Set();
  const pushWritable = (key) => {
    if (seenWritableKeys.has(key)) return;
    seenWritableKeys.add(key);
    writableKeys.push(key);
  };
  for (let i = 0; i < parsed.staticAccountKeys.length; i++) {
    if (isStaticWritable(parsed, i)) pushWritable(parsed.staticAccountKeys[i]);
  }
  const altWritableKeys = await resolveAltWritableAccounts(rpcUrl, parsed, timeoutMs);
  for (const key of altWritableKeys) {
    pushWritable(key);
  }

  const preAccountInfos = await getMultipleAccountsChunked(rpcUrl, writableKeys, 'jsonParsed', timeoutMs);

  // Track the wallet's own accounts among the writable set — that's the
  // complete drain surface assertSolanaSwapOutcome needs (input/output/sibling).
  // Accounts that don't exist pre-swap are tracked as *candidates*: a first-ever
  // purchase of the output token has the tx create its ATA, so it has no
  // pre-state to read ownership from. We snapshot it post-simulation anyway and
  // classify it from the created account's owner (below); a zero pre-balance
  // makes its whole post-balance the delta. Skipping these would report a 0n
  // output delta and false-block every first-time buy.
  //
  // A System-Program-owned pre-state is a candidate too: an address someone
  // pre-funded with lamports (the ATA program accepts a pre-funded address)
  // can become the wallet's token account in this tx, and an attacker could
  // set a delegate on it as it's created. Its token pre-balance is zero.
  //
  // Every other writable account small enough to be a token account is a
  // candidate for the control check only: a tx can hand the wallet an existing
  // token account (SetAuthority on the account owner), initialize an
  // uninitialized one, or reassign another program's account to a token
  // program. A hand-off keeps the previous owner's close authority (the token
  // program clears only the delegate). Its balance isn't counted as output (`credit: false`), since it
  // wasn't created for this swap.
  const tracked = []; // { pubkey, preInfo, classified, credit?, kind?, mint? }
  let sawWalletAccount = false;
  const walletBytes = base58Decode(walletAddress);
  writableKeys.forEach((pubkey, i) => {
    const info = preAccountInfos[i];
    if (!info) {
      tracked.push({ pubkey, preInfo: null, classified: false, credit: true });
      return;
    }
    if (pubkey === walletAddress) {
      tracked.push({ pubkey, preInfo: info, classified: true, kind: 'native' });
      sawWalletAccount = true;
      return;
    }
    const fields = tokenAccountFields(info);
    if (fields?.owner === walletAddress) {
      tracked.push({ pubkey, preInfo: info, classified: true, kind: 'token', mint: fields.mint });
      sawWalletAccount = true;
      return;
    }
    // Unparsed by the node, so its post-state could not be checked either.
    if (!fields && rawTokenAccountOwner(info)?.equals(walletBytes)) {
      throw new SolanaSimulationError('SIM_RESULT_UNPARSEABLE', 'Simulation returned an unparsed SPL token account of your wallet; cannot verify the outcome.');
    }
    // Checked before the System-owned candidate branch: a nonce account is
    // System-owned.
    const authorityKind = walletAuthorityAccountKind(pubkey, info, walletAddress);
    if (authorityKind) {
      tracked.push({ pubkey, preInfo: info, classified: true, kind: authorityKind });
      return;
    }
    if (rawWalletAuthorityAccount(info, walletBytes)) {
      throw new SolanaSimulationError('SIM_RESULT_UNPARSEABLE', `Simulation returned an unparsed stake or nonce account your wallet controls (${pubkey}); cannot verify the outcome.`);
    }
    if (info.owner === SYSTEM_PROGRAM) {
      tracked.push({ pubkey, preInfo: null, classified: false, credit: true });
    } else if (accountDataLength(info) <= MAX_CANDIDATE_ACCOUNT_BYTES) {
      tracked.push({ pubkey, preInfo: null, classified: false, credit: false });
    }
  });

  // A top-level SetAuthority that someone else signs to hand a token account to
  // the wallet: track that account whatever its size, so its post-state goes
  // through the control check. (The inner-instruction check below refuses the
  // same hand-off from inside a program when the account isn't tracked.)
  const trackedKeys = new Set(tracked.map((t) => t.pubkey));
  for (const ix of parsed.instructions) {
    const programId = parsed.staticAccountKeys[ix.programIdIndex];
    if (!TOKEN_PROGRAMS.has(programId) || ix.data[0] !== SPL_SET_AUTHORITY) continue;
    if (rawNewAccountOwner(ix.data) !== walletAddress) continue;
    // Message index space: static keys, then every lookup table's writable
    // entries in order. A readonly entry can't be the target of a SetAuthority.
    const idx = ix.accountIndexes[0];
    const target = idx < parsed.staticAccountKeys.length ? parsed.staticAccountKeys[idx] : altWritableKeys[idx - parsed.staticAccountKeys.length];
    if (target && !trackedKeys.has(target)) {
      tracked.push({ pubkey: target, preInfo: null, classified: false, credit: false });
      trackedKeys.add(target);
    }
  }

  // The wallet's native account is the fee payer, so it always pre-exists and is
  // writable; not seeing it means we couldn't locate the signer's own accounts
  // and can't meaningfully verify the outcome. (Unclassified candidates alone
  // don't count — they may all belong to other parties.)
  if (!sawWalletAccount) {
    throw new SolanaSimulationError(
      'SIM_RESULT_UNPARSEABLE',
      'Could not resolve the signer wallet as a writable account in this transaction; cannot verify the outcome.',
    );
  }

  const simResult = await rpcCall(
    rpcUrl,
    'simulateTransaction',
    [
      txBase64,
      {
        sigVerify: false,
        replaceRecentBlockhash: true,
        commitment: 'confirmed',
        encoding: 'base64',
        accounts: { addresses: tracked.map((t) => t.pubkey), encoding: 'jsonParsed' },
        innerInstructions: true,
      },
    ],
    timeoutMs,
  );

  if (simResult?.value?.err != null) {
    throw new SolanaSimulationError('SIM_REVERTED', `Swap reverts in simulation: ${JSON.stringify(simResult.value.err)}`);
  }
  const postAccountInfos = simResult?.value?.accounts;
  if (!Array.isArray(postAccountInfos) || postAccountInfos.length !== tracked.length) {
    // A 200 OK with `err: null` but no (or short) `accounts` array means the
    // node accepted the request without honoring the `accounts` param — the
    // same "public node doesn't fully support this" gap rpc-urls.js documents
    // as a degrade condition, not a corrupt result. SIM_RPC_ERROR here (rather
    // than SIM_RESULT_UNPARSEABLE) keeps this in verifySolanaSwapOutcome's
    // degrade allow-list so a capability gap on the default public RPC warns
    // and proceeds instead of blocking every trade.
    throw new SolanaSimulationError('SIM_RPC_ERROR', 'Simulation did not return balance data for the tracked accounts (RPC may not support the `accounts` parameter).');
  }

  // Refuse rather than degrade: the default RPC returns inner instructions, so
  // only a custom endpoint lacks them, and without them a CPI that delegates a
  // wallet account and then hides it would pass.
  const innerGroups = simResult.value.innerInstructions;
  const innerInstructionsChecked = innerInstructionsReadable(innerGroups);
  if (innerInstructionsChecked) {
    assertInnerTokenInstructionsSafe(innerGroups, walletAddress, trackedKeys);
  } else if (!allowMissingInnerInstructions) {
    throw new SolanaSimulationError(
      'SIM_INNER_INSTRUCTIONS_UNAVAILABLE',
      'The Solana simulation RPC did not return inner instructions, so calls this transaction makes from inside other programs cannot be checked. Refusing to sign. Set NANSEN_SOLANA_SIM_RPC to an RPC that supports simulateTransaction with innerInstructions.',
    );
  }

  const deltas = {};
  tracked.forEach((t, i) => {
    const postInfo = postAccountInfos[i];
    let { kind, mint } = t;
    if (kind === 'stake' || kind === 'nonce') {
      assertWalletAuthorityAccountUnchanged(t.pubkey, kind, t.preInfo, postInfo);
      return;
    }
    if (!t.classified) {
      // Newly-created account: classify from its post-simulation state and
      // count it only if the tx created it as one of the wallet's own accounts
      // (e.g. the output-token ATA). Anything else is another party's account.
      if (isClosedAccount(postInfo)) return;
      const fields = tokenAccountFields(postInfo);
      // Unparsed by the node, so it can't be checked as the wallet's account.
      if (!fields && rawTokenAccountOwner(postInfo)?.equals(walletBytes)) {
        throw new SolanaSimulationError('SIM_RESULT_UNPARSEABLE', `Simulation returned an unparsed SPL token account of your wallet created by this transaction (${t.pubkey}); cannot verify the outcome.`);
      }
      if (fields?.owner !== walletAddress) return;
      // Checked as new whatever it held before: an authority carried over from
      // the previous owner is a hand-off too.
      assertTokenAccountControl(t.pubkey, null, fields, walletAddress);
      if (!t.credit) return;
      kind = 'token';
      mint = fields.mint;
    } else if (kind === 'native') {
      // The wallet pays the fee, so it can't be closed; a missing post-state is
      // an unreadable result, not a zero balance.
      if (!postInfo) {
        throw new SolanaSimulationError('SIM_RESULT_UNPARSEABLE', 'Simulation returned no post-state for your wallet account; cannot verify the outcome.');
      }
      // A CPI'd System Program Assign (the wallet signs) hands the wallet's
      // lamports to whichever program now owns it, with no balance change yet.
      if (postInfo.owner !== SYSTEM_PROGRAM) {
        throw controlChanged(`reassigns your wallet account ${t.pubkey} to program ${postInfo.owner}.`);
      }
      // A CPI'd System Program Allocate (the wallet signs) gives the wallet
      // account data while leaving it System-owned. An account with data can't
      // pay fees or send SOL, so the wallet's lamports would be stuck.
      if (accountHasData(postInfo) && !accountHasData(t.preInfo)) {
        throw controlChanged(`allocates data on your wallet account ${t.pubkey}, after which it can no longer pay fees or send SOL.`);
      }
    } else if (isClosedAccount(postInfo)) {
      // A closed wallet token account sends all its lamports wherever the close
      // points. Count them as leaving under SOL_SENTINEL: a close back to the
      // wallet nets out against the wallet's native inflow, and a close
      // elsewhere shows as native outflow bounded by the fee/rent slack. For the
      // WSOL account (Jupiter's wrap/unwrap cleanup closes it on every
      // native-SOL swap) the lamports are rent + wrapped amount, so they are the
      // whole delta. For any other mint they are the rent, and the token
      // pre-balance (zero to close, unless the tx emptied it) is counted below.
      let lamports;
      try {
        lamports = BigInt(t.preInfo.lamports);
      } catch {
        throw new SolanaSimulationError('SIM_RESULT_UNPARSEABLE', `Could not parse the lamport balance of your token account ${t.pubkey}.`);
      }
      if (lamports !== 0n) deltas[SOL_SENTINEL] = (deltas[SOL_SENTINEL] || 0n) - lamports;
      if (isSolanaNativeMint(mint)) return;
    } else {
      const fields = tokenAccountFields(postInfo);
      if (!fields) {
        throw new SolanaSimulationError(
          'SIM_RESULT_UNPARSEABLE',
          `Simulation returned an unreadable post-state for your token account ${t.pubkey}; cannot verify who controls it.`,
        );
      }
      assertTokenAccountControl(t.pubkey, tokenAccountFields(t.preInfo), fields, walletAddress);
    }
    const pre = extractBalance(kind, t.preInfo); // null preInfo (new account) → 0n
    const post = extractBalance(kind, postInfo);
    const delta = post - pre;
    if (delta === 0n) return;
    const key = kind === 'native' ? SOL_SENTINEL : (isSolanaNativeMint(mint) ? SOL_SENTINEL : mint);
    deltas[key] = (deltas[key] || 0n) + delta;
  });
  for (const k of Object.keys(deltas)) {
    if (deltas[k] === 0n) delete deltas[k];
  }

  return { deltas, method: 'simulateTransaction', innerInstructionsChecked };
}
