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

// SPL Token / Token-2022 program IDs and the instruction discriminators whose
// authority is checked, shared with trade-validation.js's top-level check.
export const SPL_TOKEN_PROGRAMS = new Set([
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
]);
export const SPL_APPROVE = 4;
export const SPL_SET_AUTHORITY = 6;
export const SPL_CLOSE_ACCOUNT = 9;
export const SPL_APPROVE_CHECKED = 13;

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
 *                             for, but a tracked balance, lookup table or
 *                             token-program inner instruction couldn't be
 *                             resolved/parsed
 *   SIM_ACCOUNT_CONTROL_CHANGED - the simulated post-state hands control of one
 *                             of the wallet's own accounts to someone else (new
 *                             owner, delegate or close authority, a closed empty
 *                             token account, a CPI the wallet authorizes that
 *                             approves a delegate, changes an authority or
 *                             closes an account with its rent sent elsewhere,
 *                             or the wallet reassigned to another program),
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

function controlChanged(detail) {
  return new SolanaSimulationError(
    'SIM_ACCOUNT_CONTROL_CHANGED',
    `Simulation shows this transaction ${detail} This changes who controls your wallet's accounts, which balance checks do not catch. Refusing to sign.`,
  );
}

function tokenAmountOf(uiAmount) {
  try {
    return BigInt(uiAmount?.amount ?? 0);
  } catch {
    throw new SolanaSimulationError('SIM_RESULT_UNPARSEABLE', 'Could not parse a simulated token delegation amount.');
  }
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
  if (post.delegate) {
    const preDelegate = pre?.delegate || null;
    const grew = tokenAmountOf(post.delegatedAmount) > tokenAmountOf(pre?.delegatedAmount);
    if (post.delegate !== preDelegate || grew) {
      throw controlChanged(`approves ${post.delegate} to spend ${post.delegatedAmount?.amount ?? 'an unknown amount'} from your ${label}.`);
    }
  }
  if (post.closeAuthority && post.closeAuthority !== (pre?.closeAuthority || null)) {
    throw controlChanged(`sets ${post.closeAuthority} as the close authority of your ${label}.`);
  }
}

const UNREADABLE_INNER = 'Simulation returned an unreadable token-program inner instruction; cannot verify the outcome.';
const isPubkey = (v) => typeof v === 'string' && v.length > 0;

/**
 * Classify one inner instruction as a token-program Approve, SetAuthority or
 * CloseAccount ({ kind, account, destination?, authorities }), or null for
 * anything else. simulateTransaction returns inner instructions with addresses
 * already resolved (lookup tables included): a parsed token instruction carries
 * `parsed.type`/`parsed.info`; one the node couldn't parse carries `accounts`
 * (pubkeys) and base58 `data`. Throws on a shape it can't read, so a malformed
 * entry never reads as harmless.
 */
function classifyInnerTokenInstruction(ix) {
  if (!ix || typeof ix !== 'object' || !isPubkey(ix.programId)) {
    throw new SolanaSimulationError('SIM_RESULT_UNPARSEABLE', 'Simulation returned a malformed inner instruction; cannot verify the outcome.');
  }
  if (!SPL_TOKEN_PROGRAMS.has(ix.programId)) return null;

  if (ix.parsed && typeof ix.parsed === 'object') {
    const { type } = ix.parsed;
    const info = ix.parsed.info;
    if (!['approve', 'approveChecked', 'setAuthority', 'closeAccount'].includes(type)) return null;
    if (!info || typeof info !== 'object') throw new SolanaSimulationError('SIM_RESULT_UNPARSEABLE', UNREADABLE_INNER);
    const signers = Array.isArray(info.signers) ? info.signers : [];
    let out;
    if (type === 'closeAccount') {
      out = { kind: 'close', account: info.account, destination: info.destination, authorities: [info.owner, info.multisigOwner, ...signers] };
      if (!isPubkey(out.destination)) throw new SolanaSimulationError('SIM_RESULT_UNPARSEABLE', UNREADABLE_INNER);
    } else if (type === 'setAuthority') {
      // `account` is a token account or a mint, depending on the authority type.
      out = { kind: 'setAuthority', account: info.account ?? info.mint, authorities: [info.authority, info.multisigAuthority, ...signers] };
    } else {
      out = { kind: 'approve', account: info.source, authorities: [info.owner, info.multisigOwner, ...signers] };
    }
    const authorities = out.authorities.filter((a) => a != null);
    if (!isPubkey(out.account) || authorities.length === 0 || !authorities.every(isPubkey)) {
      throw new SolanaSimulationError('SIM_RESULT_UNPARSEABLE', UNREADABLE_INNER);
    }
    return { ...out, authorities };
  }

  // Unparsed: raw account list + data, same layouts as the top-level check.
  let data;
  try {
    if (!Array.isArray(ix.accounts) || !ix.accounts.every(isPubkey) || typeof ix.data !== 'string') throw new Error('shape');
    data = base58Decode(ix.data);
  } catch {
    throw new SolanaSimulationError('SIM_RESULT_UNPARSEABLE', UNREADABLE_INNER);
  }
  const layouts = {
    [SPL_APPROVE]: { kind: 'approve', authorityPos: 2 },
    [SPL_APPROVE_CHECKED]: { kind: 'approve', authorityPos: 3 },
    [SPL_SET_AUTHORITY]: { kind: 'setAuthority', authorityPos: 1 },
    [SPL_CLOSE_ACCOUNT]: { kind: 'close', authorityPos: 2 },
  };
  const layout = data.length ? layouts[data[0]] : undefined;
  if (!layout) return null;
  if (ix.accounts.length <= layout.authorityPos) throw new SolanaSimulationError('SIM_RESULT_UNPARSEABLE', UNREADABLE_INNER);
  return {
    kind: layout.kind,
    account: ix.accounts[0],
    destination: layout.kind === 'close' ? ix.accounts[1] : undefined,
    authorities: ix.accounts.slice(layout.authorityPos),
  };
}

/**
 * The static instruction check (assertSolanaInstructionsSafe) only sees
 * top-level instructions, and the post-state can't show a CPI that delegates
 * or re-authorizes an account it then closes, or that closes an account and
 * re-creates it at the same address. Apply the top-level rules to every CPI:
 * refuse an Approve or SetAuthority the wallet authorizes, and a CloseAccount
 * of one of the wallet's token accounts, or one the wallet authorizes, whose
 * rent goes anywhere but the wallet.
 */
function assertInnerTokenInstructionsSafe(innerGroups, walletAddress, walletTokenAccounts) {
  for (const group of innerGroups) {
    if (!Array.isArray(group?.instructions)) {
      throw new SolanaSimulationError('SIM_RESULT_UNPARSEABLE', 'Simulation returned malformed inner instructions; cannot verify the outcome.');
    }
    for (const ix of group.instructions) {
      const op = classifyInnerTokenInstruction(ix);
      if (!op) continue;
      const walletAuthorizes = op.authorities.includes(walletAddress);
      const label = walletTokenAccounts.has(op.account) ? `your token account ${op.account}` : `token account ${op.account}`;
      if (op.kind === 'approve' && walletAuthorizes) {
        throw controlChanged(`approves a delegate on ${label} with your wallet's signature, from inside another program.`);
      }
      if (op.kind === 'setAuthority' && walletAuthorizes) {
        throw controlChanged(`changes an authority of ${label} with your wallet's signature, from inside another program.`);
      }
      if (op.kind === 'close' && (walletAuthorizes || walletTokenAccounts.has(op.account)) && op.destination !== walletAddress) {
        throw controlChanged(`closes ${label} from inside another program and sends its rent to ${op.destination}.`);
      }
    }
  }
}

/**
 * Whether simulateTransaction returned inner instructions this module can
 * read. A node that honors the param returns [] when there are none; a missing
 * field or compiled entries (programIdIndex, no resolved programId) is an RPC
 * capability gap. Anything else malformed is left to the classifier to reject.
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

  const deltas = {};
  const walletTokenAccounts = new Set();
  tracked.forEach((t, i) => {
    const postInfo = postAccountInfos[i];
    let { kind, mint } = t;
    if (!t.classified) {
      // Newly-created account: classify from its post-simulation state and
      // count it only if the tx created it as one of the wallet's own accounts
      // (e.g. the output-token ATA). Anything else is another party's account.
      if (!postInfo) return;
      const fields = tokenAccountFields(postInfo);
      if (fields?.owner !== walletAddress) return;
      assertTokenAccountControl(t.pubkey, null, fields, walletAddress);
      walletTokenAccounts.add(t.pubkey);
      kind = 'token';
      mint = fields.mint;
    } else if (kind === 'native') {
      // A CPI'd System Program Assign (the wallet signs) hands the wallet's
      // lamports to whichever program now owns it, with no balance change yet.
      if (postInfo && postInfo.owner !== SYSTEM_PROGRAM) {
        throw controlChanged(`reassigns your wallet account ${t.pubkey} to program ${postInfo.owner}.`);
      }
    } else if (!postInfo) {
      walletTokenAccounts.add(t.pubkey);
      // Closing a token account needs a zero balance, so a non-zero pre-balance
      // already shows up as an outflow. An empty one is a silent 0n delta and,
      // closed through a close authority other than the wallet, its rent can
      // go anywhere the destination checks don't see, so refuse it. The WSOL
      // account is the exception: Jupiter's wrap/unwrap cleanup closes it on
      // every native-SOL swap. The close itself is checked (a top-level close
      // in assertSolanaInstructionsSafe, a CPI close in
      // assertInnerTokenInstructionsSafe); here count the whole pre-balance
      // (rent + wrapped amount) as leaving under SOL_SENTINEL, so it nets out
      // against the wallet's native inflow when the close returns it.
      if (isSolanaNativeMint(mint)) {
        let lamports;
        try {
          lamports = BigInt(t.preInfo.lamports);
        } catch {
          throw new SolanaSimulationError('SIM_RESULT_UNPARSEABLE', `Could not parse the lamport balance of your WSOL account ${t.pubkey}.`);
        }
        if (lamports !== 0n) deltas[SOL_SENTINEL] = (deltas[SOL_SENTINEL] || 0n) - lamports;
        return;
      }
      if (extractBalance('token', t.preInfo) === 0n) {
        throw controlChanged(`closes your empty token account ${t.pubkey} (mint ${mint}).`);
      }
    } else {
      const fields = tokenAccountFields(postInfo);
      if (!fields) {
        throw new SolanaSimulationError(
          'SIM_RESULT_UNPARSEABLE',
          `Simulation returned an unreadable post-state for your token account ${t.pubkey}; cannot verify who controls it.`,
        );
      }
      assertTokenAccountControl(t.pubkey, tokenAccountFields(t.preInfo), fields, walletAddress);
      walletTokenAccounts.add(t.pubkey);
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

  // Runs after the post-state checks above, so a node that can't return inner
  // instructions only loses this check, not the whole verification.
  const innerGroups = simResult.value.innerInstructions;
  const innerChecked = innerInstructionsReadable(innerGroups);
  if (innerChecked) {
    assertInnerTokenInstructionsSafe(innerGroups, walletAddress, walletTokenAccounts);
  }

  return { deltas, method: 'simulateTransaction', innerInstructionsChecked: innerChecked };
}
