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
 *                             whatever the balances say
 * NO_SIM_RPC and SIM_RPC_ERROR are degrade conditions (warn, proceed per
 * policy); the caller decides. SIM_REVERTED, SIM_RESULT_UNPARSEABLE and
 * SIM_ACCOUNT_CONTROL_CHANGED are outcome/parse problems and must not be
 * silently ignored — fail closed.
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

/**
 * Simulate a Solana swap transaction and return the normalised asset changes
 * it causes to `walletAddress`'s wallet.
 *
 * @param {string} chain - chain key (only 'solana' is wired today)
 * @param {string} txBase64 - the serialized transaction to simulate, unsigned
 * @param {{ walletAddress: string, timeoutMs?: number }} opts
 * @returns {Promise<{ deltas: Record<string, bigint>, method: string }>}
 *   deltas is keyed by mint address, with native SOL (and any WSOL leg of the
 *   same swap) folded under SOL_SENTINEL.
 * @throws {SolanaSimulationError} on any degrade condition, an in-sim revert,
 *   or an unparseable result.
 */
export async function simulateSolanaAssetChanges(chain, txBase64, { walletAddress, timeoutMs = 20000 } = {}) {
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
  for (const key of await resolveAltWritableAccounts(rpcUrl, parsed, timeoutMs)) {
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
  const tracked = []; // { pubkey, preInfo, classified, kind?, mint? }
  let sawWalletAccount = false;
  const walletBytes = base58Decode(walletAddress);
  writableKeys.forEach((pubkey, i) => {
    const info = preAccountInfos[i];
    if (!info) {
      tracked.push({ pubkey, preInfo: null, classified: false });
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
    if (info.owner === SYSTEM_PROGRAM) {
      tracked.push({ pubkey, preInfo: null, classified: false });
    }
  });

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

  const deltas = {};
  tracked.forEach((t, i) => {
    const postInfo = postAccountInfos[i];
    let { kind, mint } = t;
    if (!t.classified) {
      // Newly-created account: classify from its post-simulation state and
      // count it only if the tx created it as one of the wallet's own accounts
      // (e.g. the output-token ATA). Anything else is another party's account.
      if (!postInfo) return;
      const fields = tokenAccountFields(postInfo);
      // Unparsed by the node, so it can't be checked as the wallet's account.
      if (!fields && rawTokenAccountOwner(postInfo)?.equals(walletBytes)) {
        throw new SolanaSimulationError('SIM_RESULT_UNPARSEABLE', `Simulation returned an unparsed SPL token account of your wallet created by this transaction (${t.pubkey}); cannot verify the outcome.`);
      }
      if (fields?.owner !== walletAddress) return;
      assertTokenAccountControl(t.pubkey, null, fields, walletAddress);
      kind = 'token';
      mint = fields.mint;
    } else if (kind === 'native') {
      // A CPI'd System Program Assign (the wallet signs) hands the wallet's
      // lamports to whichever program now owns it, with no balance change yet.
      if (postInfo && postInfo.owner !== SYSTEM_PROGRAM) {
        throw controlChanged(`reassigns your wallet account ${t.pubkey} to program ${postInfo.owner}.`);
      }
      // A CPI'd System Program Allocate (the wallet signs) gives the wallet
      // account data while leaving it System-owned. An account with data can't
      // pay fees or send SOL, so the wallet's lamports would be stuck.
      if (postInfo && accountHasData(postInfo) && !accountHasData(t.preInfo)) {
        throw controlChanged(`allocates data on your wallet account ${t.pubkey}, after which it can no longer pay fees or send SOL.`);
      }
    } else if (!postInfo) {
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

  return { deltas, method: 'simulateTransaction' };
}
