import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SIMULATION_RPCS } from '../rpc-urls.js';
import { generateSolanaWallet, base58Decode } from '../wallet.js';
import {
  simulateSolanaAssetChanges,
  SolanaSimulationError,
  hasSolanaSimulationRpc,
  SOL_SENTINEL,
} from '../solana-simulation.js';

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

// Same hand-rolled builder as solana-tx.test.js, kept independent of
// solana-tx.js so these fixtures aren't verified against the code under test.
function encodeCompactU16(value) {
  if (value < 0x80) return Buffer.from([value]);
  if (value < 0x4000) return Buffer.from([(value & 0x7f) | 0x80, (value >> 7) & 0x7f]);
  return Buffer.from([(value & 0x7f) | 0x80, ((value >> 7) & 0x7f) | 0x80, (value >> 14) & 0x03]);
}

function buildMessageBytes({ versioned, accountKeys, header, recentBlockhash, instructions = [], addressTableLookups = [] }) {
  const parts = [];
  if (versioned) parts.push(Buffer.from([0x80]));
  parts.push(Buffer.from([header.numRequiredSignatures, header.numReadonlySignedAccounts, header.numReadonlyUnsignedAccounts]));
  parts.push(encodeCompactU16(accountKeys.length));
  for (const k of accountKeys) parts.push(base58Decode(k));
  parts.push(base58Decode(recentBlockhash));
  parts.push(encodeCompactU16(instructions.length));
  for (const ix of instructions) {
    parts.push(Buffer.from([ix.programIdIndex]));
    parts.push(encodeCompactU16(ix.accountIndexes.length));
    for (const idx of ix.accountIndexes) parts.push(Buffer.from([idx]));
    parts.push(encodeCompactU16(ix.data.length));
    parts.push(ix.data);
  }
  if (versioned) {
    parts.push(encodeCompactU16(addressTableLookups.length));
    for (const alt of addressTableLookups) {
      parts.push(base58Decode(alt.lookupTableAddress));
      parts.push(encodeCompactU16(alt.writableIndexes.length));
      for (const idx of alt.writableIndexes) parts.push(Buffer.from([idx]));
      parts.push(encodeCompactU16(alt.readonlyIndexes.length));
      for (const idx of alt.readonlyIndexes) parts.push(Buffer.from([idx]));
    }
  }
  return Buffer.concat(parts);
}

function wrapTransaction(messageBytes, numSignatures = 1) {
  return Buffer.concat([encodeCompactU16(numSignatures), Buffer.alloc(numSignatures * 64), messageBytes]).toString('base64');
}

// A minimal single-instruction legacy tx: [wallet (signer, writable), tokenAccount
// (writable), programId (readonly)]. The instruction contents don't matter —
// simulation only cares about the accounts snapshot, not what the tx does.
function buildLegacyTx({ wallet, extraWritableKeys = [], readonlyKeys = [] }) {
  const programId = generateSolanaWallet().address;
  const recentBlockhash = generateSolanaWallet().address;
  const accountKeys = [wallet, ...extraWritableKeys, ...readonlyKeys, programId];
  const messageBytes = buildMessageBytes({
    versioned: false,
    accountKeys,
    header: {
      numRequiredSignatures: 1,
      numReadonlySignedAccounts: 0,
      numReadonlyUnsignedAccounts: readonlyKeys.length + 1, // + programId
    },
    recentBlockhash,
    instructions: [{ programIdIndex: accountKeys.length - 1, accountIndexes: [0], data: Buffer.from([0x01]) }],
  });
  return wrapTransaction(messageBytes);
}

function nativeAccountInfo(lamports) {
  return { lamports, owner: '11111111111111111111111111111111', data: ['', 'base64'], executable: false, rentEpoch: 0 };
}

function tokenAccountInfo({ mint, owner, amount, ...extra }) {
  return {
    lamports: 2039280,
    owner: TOKEN_PROGRAM,
    data: { program: 'spl-token', parsed: { type: 'account', info: { mint, owner, tokenAmount: { amount: String(amount), decimals: 6 }, ...extra } } },
    executable: false,
    rentEpoch: 0,
  };
}

function jsonRpcResponse(result) {
  return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result }) };
}

/**
 * Mock the Solana simulation RPC. `trackedAccounts`/`altAccounts` key raw
 * account infos by pubkey; `simValue(params)` builds the simulateTransaction
 * result from the actual request params (so tests can assert on
 * replaceRecentBlockhash / the accounts list it was asked to snapshot).
 */
function mockSolanaRpc({ trackedAccounts = {}, altAccounts = {}, simValue, onRequest } = {}) {
  return vi.fn().mockImplementation(async (url, opts) => {
    const body = JSON.parse(opts.body);
    onRequest?.(body);
    if (body.method === 'getMultipleAccounts') {
      const [pubkeys, rpcOpts] = body.params;
      const table = rpcOpts.encoding === 'base64' ? altAccounts : trackedAccounts;
      return jsonRpcResponse({ value: pubkeys.map((pk) => table[pk] ?? null) });
    }
    if (body.method === 'simulateTransaction') {
      return jsonRpcResponse(simValue(body.params));
    }
    throw new Error(`solana-simulation.test.js: unhandled RPC method ${body.method}`);
  });
}

describe('solana-simulation', () => {
  let originalSolanaRpc;
  beforeEach(() => {
    originalSolanaRpc = SIMULATION_RPCS.solana;
    SIMULATION_RPCS.solana = 'http://sol-sim.test';
  });
  afterEach(() => {
    SIMULATION_RPCS.solana = originalSolanaRpc;
    vi.unstubAllGlobals();
  });

  describe('hasSolanaSimulationRpc', () => {
    it('is true for solana when an endpoint is configured', () => {
      expect(hasSolanaSimulationRpc('solana')).toBe(true);
    });
    it('is false when no endpoint is configured', () => {
      SIMULATION_RPCS.solana = null;
      expect(hasSolanaSimulationRpc('solana')).toBe(false);
    });
    it('is false for a non-solana chain', () => {
      expect(hasSolanaSimulationRpc('base')).toBe(false);
    });
  });

  it('throws a SolanaSimulationError with code NO_SIM_RPC when no endpoint is configured', async () => {
    SIMULATION_RPCS.solana = null;
    await expect(simulateSolanaAssetChanges('solana', 'AA==', { walletAddress: 'x' }))
      .rejects.toBeInstanceOf(SolanaSimulationError);
    await expect(simulateSolanaAssetChanges('solana', 'AA==', { walletAddress: 'x' }))
      .rejects.toMatchObject({ code: 'NO_SIM_RPC' });
  });

  it('benign Jupiter native-in fixture: folds a WSOL leg into the native SOL bucket', async () => {
    const wallet = generateSolanaWallet().address;
    const wsolAccount = generateSolanaWallet().address;
    const usdcAccount = generateSolanaWallet().address;
    const usdcMint = generateSolanaWallet().address;
    const txBase64 = buildLegacyTx({ wallet, extraWritableKeys: [wsolAccount, usdcAccount] });

    vi.stubGlobal('fetch', mockSolanaRpc({
      trackedAccounts: {
        [wallet]: nativeAccountInfo(10_000_000_000),
        [wsolAccount]: tokenAccountInfo({ mint: WSOL_MINT, owner: wallet, amount: 0 }),
        [usdcAccount]: tokenAccountInfo({ mint: usdcMint, owner: wallet, amount: 100_000_000 }),
      },
      simValue: (params) => {
        const addrs = params[1].accounts.addresses;
        const post = {
          [wallet]: nativeAccountInfo(8_995_000_000), // paid 1 SOL input + ~5000 lamports fee
          [wsolAccount]: tokenAccountInfo({ mint: WSOL_MINT, owner: wallet, amount: 5000 }), // unwrap left dust
          [usdcAccount]: tokenAccountInfo({ mint: usdcMint, owner: wallet, amount: 150_000_000 }),
        };
        return { value: { err: null, accounts: addrs.map((a) => post[a]) } };
      },
    }));

    const result = await simulateSolanaAssetChanges('solana', txBase64, { walletAddress: wallet });
    expect(result.method).toBe('simulateTransaction');
    // -1,005,000,000 (native) + 5,000 (WSOL dust) folded into one SOL_SENTINEL bucket
    expect(result.deltas[SOL_SENTINEL]).toBe(-1_004_995_000n);
    expect(result.deltas[usdcMint]).toBe(50_000_000n);
    expect(result.deltas[WSOL_MINT]).toBeUndefined(); // folded, not reported separately
  });

  it('OKX SPL-token-in fixture: reports a clean token delta alongside native', async () => {
    const wallet = generateSolanaWallet().address;
    const usdtAccount = generateSolanaWallet().address;
    const usdtMint = generateSolanaWallet().address;
    const txBase64 = buildLegacyTx({ wallet, extraWritableKeys: [usdtAccount] });

    vi.stubGlobal('fetch', mockSolanaRpc({
      trackedAccounts: {
        [wallet]: nativeAccountInfo(2_000_000_000),
        [usdtAccount]: tokenAccountInfo({ mint: usdtMint, owner: wallet, amount: 1_000_000_000 }),
      },
      simValue: (params) => {
        const addrs = params[1].accounts.addresses;
        const post = {
          [wallet]: nativeAccountInfo(2_002_000_000), // received native output + reclaimed rent, minus fee
          [usdtAccount]: tokenAccountInfo({ mint: usdtMint, owner: wallet, amount: 0 }), // fully spent
        };
        return { value: { err: null, accounts: addrs.map((a) => post[a]) } };
      },
    }));

    const result = await simulateSolanaAssetChanges('solana', txBase64, { walletAddress: wallet });
    expect(result.deltas[usdtMint]).toBe(-1_000_000_000n);
    expect(result.deltas[SOL_SENTINEL]).toBe(2_000_000n);
  });

  it('resolves a tracked account that lives only in an address-lookup table (v0 tx)', async () => {
    const wallet = generateSolanaWallet().address;
    const programId = generateSolanaWallet().address;
    const recentBlockhash = generateSolanaWallet().address;
    const altAddress = generateSolanaWallet().address;
    const altTokenAccount = generateSolanaWallet().address;
    const mint = generateSolanaWallet().address;

    // ALT-writable index 3 resolves to altTokenAccount; earlier slots are filler.
    const altAddresses = [generateSolanaWallet().address, generateSolanaWallet().address, generateSolanaWallet().address, altTokenAccount];
    const altTableData = Buffer.concat([Buffer.alloc(56), ...altAddresses.map((a) => base58Decode(a))]).toString('base64');

    const messageBytes = buildMessageBytes({
      versioned: true,
      accountKeys: [wallet, programId],
      header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 1 },
      recentBlockhash,
      instructions: [{ programIdIndex: 1, accountIndexes: [0, 2], data: Buffer.from([0x01]) }],
      addressTableLookups: [{ lookupTableAddress: altAddress, writableIndexes: [3], readonlyIndexes: [] }],
    });
    const txBase64 = wrapTransaction(messageBytes);

    vi.stubGlobal('fetch', mockSolanaRpc({
      altAccounts: { [altAddress]: { data: [altTableData, 'base64'], owner: 'AddressLookupTab1e1111111111111111111111', lamports: 1 } },
      trackedAccounts: {
        [wallet]: nativeAccountInfo(1_000_000_000),
        [altTokenAccount]: tokenAccountInfo({ mint, owner: wallet, amount: 500 }),
      },
      simValue: (params) => {
        const addrs = params[1].accounts.addresses;
        const post = {
          [wallet]: nativeAccountInfo(999_995_000),
          [altTokenAccount]: tokenAccountInfo({ mint, owner: wallet, amount: 700 }),
        };
        return { value: { err: null, accounts: addrs.map((a) => post[a]) } };
      },
    }));

    const result = await simulateSolanaAssetChanges('solana', txBase64, { walletAddress: wallet });
    expect(result.deltas[mint]).toBe(200n);
  });

  it('does not double-count a writable account referenced both as a static key and via an ALT (regression: no dedup summed its delta twice)', async () => {
    const wallet = generateSolanaWallet().address;
    const programId = generateSolanaWallet().address;
    const recentBlockhash = generateSolanaWallet().address;
    const altAddress = generateSolanaWallet().address;
    const tokenAccount = generateSolanaWallet().address; // referenced BOTH ways below
    const mint = generateSolanaWallet().address;

    // ALT resolves the SAME tokenAccount already present as a static key.
    const altAddresses = [generateSolanaWallet().address, generateSolanaWallet().address, generateSolanaWallet().address, tokenAccount];
    const altTableData = Buffer.concat([Buffer.alloc(56), ...altAddresses.map((a) => base58Decode(a))]).toString('base64');

    const messageBytes = buildMessageBytes({
      versioned: true,
      accountKeys: [wallet, tokenAccount, programId],
      header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 1 },
      recentBlockhash,
      instructions: [{ programIdIndex: 2, accountIndexes: [0, 1], data: Buffer.from([0x01]) }],
      addressTableLookups: [{ lookupTableAddress: altAddress, writableIndexes: [3], readonlyIndexes: [] }],
    });
    const txBase64 = wrapTransaction(messageBytes);

    vi.stubGlobal('fetch', mockSolanaRpc({
      altAccounts: { [altAddress]: { data: [altTableData, 'base64'], owner: 'AddressLookupTab1e1111111111111111111111', lamports: 1 } },
      trackedAccounts: {
        [wallet]: nativeAccountInfo(1_000_000_000),
        [tokenAccount]: tokenAccountInfo({ mint, owner: wallet, amount: 500 }),
      },
      simValue: (params) => {
        const addrs = params[1].accounts.addresses;
        // Deduplicated: tokenAccount must appear only once in the snapshot request.
        expect(addrs.filter((a) => a === tokenAccount)).toHaveLength(1);
        const post = {
          [wallet]: nativeAccountInfo(999_995_000),
          [tokenAccount]: tokenAccountInfo({ mint, owner: wallet, amount: 700 }),
        };
        return { value: { err: null, accounts: addrs.map((a) => post[a]) } };
      },
    }));

    const result = await simulateSolanaAssetChanges('solana', txBase64, { walletAddress: wallet });
    // The real delta is 200 (500 -> 700); without dedup this would double to 400.
    expect(result.deltas[mint]).toBe(200n);
  });

  it('first-time buy: tracks the output ATA the tx creates (no pre-state) and reports its delta', async () => {
    // The output token account does not exist pre-swap (getMultipleAccounts
    // returns null for it), so it has no ownership to read up front. It must
    // still be snapshotted post-simulation and its whole post-balance counted
    // as the delta — otherwise the output delta is 0 and every first buy blocks.
    const wallet = generateSolanaWallet().address;
    const newOutputAta = generateSolanaWallet().address;
    const outputMint = generateSolanaWallet().address;
    const txBase64 = buildLegacyTx({ wallet, extraWritableKeys: [newOutputAta] });

    vi.stubGlobal('fetch', mockSolanaRpc({
      trackedAccounts: {
        [wallet]: nativeAccountInfo(10_000_000_000),
        // newOutputAta intentionally absent → getMultipleAccounts returns null.
      },
      simValue: (params) => {
        const addrs = params[1].accounts.addresses;
        // The candidate ATA must be included in the snapshot request.
        expect(addrs).toContain(newOutputAta);
        const post = {
          [wallet]: nativeAccountInfo(8_997_960_720), // paid 1 SOL + fee + ATA rent
          [newOutputAta]: tokenAccountInfo({ mint: outputMint, owner: wallet, amount: 250_000_000 }),
        };
        return { value: { err: null, accounts: addrs.map((a) => post[a] ?? null) } };
      },
    }));

    const result = await simulateSolanaAssetChanges('solana', txBase64, { walletAddress: wallet });
    expect(result.deltas[outputMint]).toBe(250_000_000n); // full post-balance, pre = 0
  });

  it('ignores a newly-created account the tx does not assign to the wallet', async () => {
    // A null pre-state account created for another party (e.g. a routing PDA)
    // must not be counted toward the wallet's deltas.
    const wallet = generateSolanaWallet().address;
    const someoneElsesNewAta = generateSolanaWallet().address;
    const otherOwner = generateSolanaWallet().address;
    const otherMint = generateSolanaWallet().address;
    const txBase64 = buildLegacyTx({ wallet, extraWritableKeys: [someoneElsesNewAta] });

    vi.stubGlobal('fetch', mockSolanaRpc({
      trackedAccounts: { [wallet]: nativeAccountInfo(1_000_000_000) },
      simValue: (params) => {
        const addrs = params[1].accounts.addresses;
        const post = {
          [wallet]: nativeAccountInfo(999_995_000),
          [someoneElsesNewAta]: tokenAccountInfo({ mint: otherMint, owner: otherOwner, amount: 5_000_000 }),
        };
        return { value: { err: null, accounts: addrs.map((a) => post[a] ?? null) } };
      },
    }));

    const result = await simulateSolanaAssetChanges('solana', txBase64, { walletAddress: wallet });
    expect(result.deltas[otherMint]).toBeUndefined();
    expect(result.deltas[SOL_SENTINEL]).toBe(-5_000n); // only the wallet's own fee delta
  });

  it('throws SIM_REVERTED when the simulated transaction errors', async () => {
    const wallet = generateSolanaWallet().address;
    const txBase64 = buildLegacyTx({ wallet });

    vi.stubGlobal('fetch', mockSolanaRpc({
      trackedAccounts: { [wallet]: nativeAccountInfo(1_000_000_000) },
      simValue: () => ({ value: { err: { InstructionError: [0, 'Custom'] }, accounts: null } }),
    }));

    await expect(simulateSolanaAssetChanges('solana', txBase64, { walletAddress: wallet }))
      .rejects.toMatchObject({ code: 'SIM_REVERTED' });
  });

  it('surfaces a transport failure as SIM_RPC_ERROR (degrade)', async () => {
    const wallet = generateSolanaWallet().address;
    const txBase64 = buildLegacyTx({ wallet });

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    await expect(simulateSolanaAssetChanges('solana', txBase64, { walletAddress: wallet }))
      .rejects.toMatchObject({ code: 'SIM_RPC_ERROR' });
  });

  it('degrades as SIM_RPC_ERROR when a 200 OK sim omits the accounts array (RPC capability gap, not a corrupt result)', async () => {
    // regression: a node that accepts `accounts` but doesn't honor it returns
    // err: null with no accounts data — this must degrade (warn + proceed),
    // not fail closed as SIM_RESULT_UNPARSEABLE, since SIMULATION_RPCS.solana
    // defaults to a public endpoint that can behave this way under load.
    const wallet = generateSolanaWallet().address;
    const txBase64 = buildLegacyTx({ wallet });

    vi.stubGlobal('fetch', mockSolanaRpc({
      trackedAccounts: { [wallet]: nativeAccountInfo(1_000_000_000) },
      simValue: () => ({ value: { err: null, accounts: null } }),
    }));

    await expect(simulateSolanaAssetChanges('solana', txBase64, { walletAddress: wallet }))
      .rejects.toMatchObject({ code: 'SIM_RPC_ERROR' });
  });

  it('degrades as SIM_RPC_ERROR when getMultipleAccounts returns a null value array (RPC capability gap)', async () => {
    // regression: a spec-violating 200 OK with `value: null` (a rate-limited
    // or malfunctioning node) must degrade like any other transport failure,
    // not silently become an empty array that starves preAccountInfos and
    // fails closed as SIM_RESULT_UNPARSEABLE (blocking a legitimate trade).
    const wallet = generateSolanaWallet().address;
    const txBase64 = buildLegacyTx({ wallet });

    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.method === 'getMultipleAccounts') return jsonRpcResponse({ value: null });
      throw new Error(`solana-simulation.test.js: unexpected RPC method ${body.method}`);
    }));

    await expect(simulateSolanaAssetChanges('solana', txBase64, { walletAddress: wallet }))
      .rejects.toMatchObject({ code: 'SIM_RPC_ERROR' });
  });

  it('degrades as SIM_RPC_ERROR when getMultipleAccounts returns fewer accounts than requested (misaligned response)', async () => {
    // regression: a conforming RPC always returns value.length === the
    // requested key count (null entries for missing accounts). A short array
    // would silently shift every later account's pre-state by one slot against
    // writableKeys, corrupting delta classification, rather than failing loudly.
    const wallet = generateSolanaWallet().address;
    const txBase64 = buildLegacyTx({ wallet, extraWritableKeys: [generateSolanaWallet().address] });

    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.method === 'getMultipleAccounts') {
        const [pubkeys] = body.params;
        // Return one fewer entry than requested.
        return jsonRpcResponse({ value: pubkeys.slice(1).map(() => null) });
      }
      throw new Error(`solana-simulation.test.js: unexpected RPC method ${body.method}`);
    }));

    await expect(simulateSolanaAssetChanges('solana', txBase64, { walletAddress: wallet }))
      .rejects.toMatchObject({ code: 'SIM_RPC_ERROR' });
  });

  it('always sends replaceRecentBlockhash:true (the quote blockhash is stale by execute)', async () => {
    const wallet = generateSolanaWallet().address;
    const txBase64 = buildLegacyTx({ wallet });
    let capturedOptions;

    vi.stubGlobal('fetch', mockSolanaRpc({
      trackedAccounts: { [wallet]: nativeAccountInfo(1_000_000_000) },
      onRequest: (body) => { if (body.method === 'simulateTransaction') capturedOptions = body.params[1]; },
      simValue: (params) => {
        const addrs = params[1].accounts.addresses;
        return { value: { err: null, accounts: addrs.map(() => nativeAccountInfo(1_000_000_000)) } };
      },
    }));

    await simulateSolanaAssetChanges('solana', txBase64, { walletAddress: wallet });
    expect(capturedOptions.replaceRecentBlockhash).toBe(true);
    expect(capturedOptions.sigVerify).toBe(false);
  });

  it('fails closed when the signer wallet cannot be resolved as a writable account', async () => {
    const wallet = generateSolanaWallet().address;
    const someoneElse = generateSolanaWallet().address;
    const txBase64 = buildLegacyTx({ wallet: someoneElse });

    vi.stubGlobal('fetch', mockSolanaRpc({
      trackedAccounts: { [someoneElse]: nativeAccountInfo(1_000_000_000) },
      simValue: () => ({ value: { err: null, accounts: [] } }),
    }));

    await expect(simulateSolanaAssetChanges('solana', txBase64, { walletAddress: wallet }))
      .rejects.toMatchObject({ code: 'SIM_RESULT_UNPARSEABLE' });
  });

  describe('account control changes (CPI Approve / SetAuthority / CloseAccount / Assign)', () => {
    // A USDC -> output swap whose balances are clean in every case; only the
    // post-state's authorities differ. Balance deltas alone pass all of these.
    const MAX_U64 = '18446744073709551615';
    let wallet, ataIn, ataOut, attacker, mintIn, mintOut;
    beforeEach(() => {
      wallet = generateSolanaWallet().address;
      ataIn = generateSolanaWallet().address;
      ataOut = generateSolanaWallet().address;
      attacker = generateSolanaWallet().address;
      mintIn = generateSolanaWallet().address;
      mintOut = generateSolanaWallet().address;
    });

    function run({ pre, post, extraWritableKeys = [ataIn, ataOut] }) {
      const txBase64 = buildLegacyTx({ wallet, extraWritableKeys });
      vi.stubGlobal('fetch', mockSolanaRpc({
        trackedAccounts: pre,
        simValue: (params) => ({ value: { err: null, accounts: params[1].accounts.addresses.map((a) => (a in post ? post[a] : null)) } }),
      }));
      return simulateSolanaAssetChanges('solana', txBase64, { walletAddress: wallet });
    }
    const basePre = () => ({
      [wallet]: nativeAccountInfo(1_000_000_000),
      [ataIn]: tokenAccountInfo({ mint: mintIn, owner: wallet, amount: 1_000_000 }),
      [ataOut]: tokenAccountInfo({ mint: mintOut, owner: wallet, amount: 0 }),
    });
    const basePost = (outExtra = {}) => ({
      [wallet]: nativeAccountInfo(999_995_000),
      [ataIn]: tokenAccountInfo({ mint: mintIn, owner: wallet, amount: 0 }),
      [ataOut]: tokenAccountInfo({ mint: mintOut, owner: wallet, amount: 1_000_000, ...outExtra }),
    });

    it('refuses a new delegate on the output token account', async () => {
      await expect(run({ pre: basePre(), post: basePost({ delegate: attacker, delegatedAmount: { amount: MAX_U64, decimals: 6 } }) }))
        .rejects.toMatchObject({ code: 'SIM_ACCOUNT_CONTROL_CHANGED', message: expect.stringContaining(`approves ${attacker}`) });
    });

    it('refuses a delegate replaced by a different one', async () => {
      const other = generateSolanaWallet().address;
      const pre = basePre();
      pre[ataOut] = tokenAccountInfo({ mint: mintOut, owner: wallet, amount: 0, delegate: other, delegatedAmount: { amount: '5', decimals: 6 } });
      await expect(run({ pre, post: basePost({ delegate: attacker, delegatedAmount: { amount: '5', decimals: 6 } }) }))
        .rejects.toMatchObject({ code: 'SIM_ACCOUNT_CONTROL_CHANGED' });
    });

    it('refuses a grown allowance for an existing delegate', async () => {
      const pre = basePre();
      pre[ataOut] = tokenAccountInfo({ mint: mintOut, owner: wallet, amount: 0, delegate: attacker, delegatedAmount: { amount: '5', decimals: 6 } });
      await expect(run({ pre, post: basePost({ delegate: attacker, delegatedAmount: { amount: MAX_U64, decimals: 6 } }) }))
        .rejects.toMatchObject({ code: 'SIM_ACCOUNT_CONTROL_CHANGED' });
    });

    it('allows an existing delegate left unchanged, and a delegate revoked', async () => {
      const existing = generateSolanaWallet().address;
      const pre = basePre();
      pre[ataOut] = tokenAccountInfo({ mint: mintOut, owner: wallet, amount: 0, delegate: existing, delegatedAmount: { amount: '5', decimals: 6 } });
      const unchanged = await run({ pre, post: basePost({ delegate: existing, delegatedAmount: { amount: '5', decimals: 6 } }) });
      expect(unchanged.deltas[mintOut]).toBe(1_000_000n);
      const revoked = await run({ pre, post: basePost() });
      expect(revoked.deltas[mintOut]).toBe(1_000_000n);
    });

    it('refuses an owner change on a wallet token account', async () => {
      const post = basePost();
      post[ataOut] = tokenAccountInfo({ mint: mintOut, owner: attacker, amount: 1_000_000 });
      await expect(run({ pre: basePre(), post }))
        .rejects.toMatchObject({ code: 'SIM_ACCOUNT_CONTROL_CHANGED', message: expect.stringContaining(`transfers ownership`) });
    });

    it('refuses a new close authority', async () => {
      await expect(run({ pre: basePre(), post: basePost({ closeAuthority: attacker }) }))
        .rejects.toMatchObject({ code: 'SIM_ACCOUNT_CONTROL_CHANGED', message: expect.stringContaining('close authority') });
    });

    it('refuses closing an empty non-WSOL wallet token account', async () => {
      const sibling = generateSolanaWallet().address;
      const pre = { ...basePre(), [sibling]: tokenAccountInfo({ mint: generateSolanaWallet().address, owner: wallet, amount: 0 }) };
      const post = { ...basePost(), [sibling]: null };
      await expect(run({ pre, post, extraWritableKeys: [ataIn, ataOut, sibling] }))
        .rejects.toMatchObject({ code: 'SIM_ACCOUNT_CONTROL_CHANGED', message: expect.stringContaining('closes your empty token account') });
    });

    it('allows closing the wallet WSOL account (Jupiter wrap/unwrap cleanup)', async () => {
      const wsolAta = generateSolanaWallet().address;
      const pre = { ...basePre(), [wsolAta]: tokenAccountInfo({ mint: WSOL_MINT, owner: wallet, amount: 0 }) };
      // The close returns the account's rent to the wallet.
      const post = { ...basePost(), [wallet]: nativeAccountInfo(999_995_000 + 2_039_280), [wsolAta]: null };
      const result = await run({ pre, post, extraWritableKeys: [ataIn, ataOut, wsolAta] });
      expect(result.deltas[mintOut]).toBe(1_000_000n);
      expect(result.deltas[SOL_SENTINEL]).toBe(-5_000n);
    });

    it('counts a closed empty WSOL account rent sent elsewhere as a native outflow', async () => {
      const wsolAta = generateSolanaWallet().address;
      const pre = { ...basePre(), [wsolAta]: tokenAccountInfo({ mint: WSOL_MINT, owner: wallet, amount: 0 }) };
      const post = { ...basePost(), [wsolAta]: null }; // rent went to another account
      const result = await run({ pre, post, extraWritableKeys: [ataIn, ataOut, wsolAta] });
      expect(result.deltas[SOL_SENTINEL]).toBe(-(5_000n + 2_039_280n));
    });

    it('fails closed when a closed WSOL account has no readable pre-state lamports', async () => {
      const wsolAta = generateSolanaWallet().address;
      const wsolPre = tokenAccountInfo({ mint: WSOL_MINT, owner: wallet, amount: 0 });
      delete wsolPre.lamports;
      const pre = { ...basePre(), [wsolAta]: wsolPre };
      const post = { ...basePost(), [wsolAta]: null };
      await expect(run({ pre, post, extraWritableKeys: [ataIn, ataOut, wsolAta] }))
        .rejects.toMatchObject({ code: 'SIM_RESULT_UNPARSEABLE' });
    });

    it('refuses reassigning the wallet account to another program (CPI Assign)', async () => {
      const post = basePost();
      post[wallet] = { ...nativeAccountInfo(999_995_000), owner: attacker };
      await expect(run({ pre: basePre(), post }))
        .rejects.toMatchObject({ code: 'SIM_ACCOUNT_CONTROL_CHANGED', message: expect.stringContaining('reassigns your wallet account') });
    });

    it('fails closed on an unreadable post-state for a wallet token account', async () => {
      const post = basePost();
      post[ataOut] = { lamports: 2039280, owner: TOKEN_PROGRAM, data: ['AAAA', 'base64'], executable: false, rentEpoch: 0 };
      await expect(run({ pre: basePre(), post })).rejects.toMatchObject({ code: 'SIM_RESULT_UNPARSEABLE' });
    });

    it('fails closed when the output token account pre-state has no tokenAmount', async () => {
      // Read as 0, the 1,000,000 it already holds would count as swap output.
      const pre = basePre();
      pre[ataOut] = tokenAccountInfo({ mint: mintOut, owner: wallet, amount: 1_000_000 });
      delete pre[ataOut].data.parsed.info.tokenAmount;
      await expect(run({ pre, post: basePost() })).rejects.toMatchObject({ code: 'SIM_RESULT_UNPARSEABLE' });
    });

    it('fails closed when a wallet token account post-state has no tokenAmount', async () => {
      const post = basePost();
      delete post[ataOut].data.parsed.info.tokenAmount;
      await expect(run({ pre: basePre(), post })).rejects.toMatchObject({ code: 'SIM_RESULT_UNPARSEABLE' });
    });

    it('fails closed when a writable token account pre-state has no owner', async () => {
      const pre = basePre();
      delete pre[ataOut].data.parsed.info.owner;
      await expect(run({ pre, post: basePost() })).rejects.toMatchObject({ code: 'SIM_RESULT_UNPARSEABLE' });
    });

    it('refuses a wallet token account the tx creates with a delegate already set', async () => {
      const pre = basePre();
      delete pre[ataOut]; // first-time buy: the output ATA does not exist yet
      await expect(run({ pre, post: basePost({ delegate: attacker, delegatedAmount: { amount: MAX_U64, decimals: 6 } }) }))
        .rejects.toMatchObject({ code: 'SIM_ACCOUNT_CONTROL_CHANGED' });
    });

    it('refuses a pre-funded address the tx initializes as a wallet token account with a delegate', async () => {
      // Someone sent lamports to the wallet's future ATA address, so its
      // pre-state is a System-Program-owned account, not null.
      const pre = { ...basePre(), [ataOut]: nativeAccountInfo(1_000_000) };
      await expect(run({ pre, post: basePost({ delegate: attacker, delegatedAmount: { amount: MAX_U64, decimals: 6 } }) }))
        .rejects.toMatchObject({ code: 'SIM_ACCOUNT_CONTROL_CHANGED' });
    });

    it('counts a pre-funded address the tx initializes cleanly as the wallet output account', async () => {
      const pre = { ...basePre(), [ataOut]: nativeAccountInfo(1_000_000) };
      const result = await run({ pre, post: basePost() });
      expect(result.deltas[mintOut]).toBe(1_000_000n);
    });
  });
});
