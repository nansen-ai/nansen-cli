import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SIMULATION_RPCS } from '../rpc-urls.js';
import { generateSolanaWallet, base58Decode, base58Encode } from '../wallet.js';
import {
  simulateSolanaAssetChanges,
  SolanaSimulationError,
  hasSolanaSimulationRpc,
  SOL_SENTINEL,
} from '../solana-simulation.js';

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';

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

// A minimal legacy tx: [wallet (signer, writable), tokenAccount (writable),
// programId (readonly)]. The first instruction's contents don't matter —
// simulation only reads the accounts snapshot, plus any top-level token
// CloseAccount, which `tokenCloses` ({ account, destination, authority,
// program? }) appends (account + destination writable, authority readonly).
function buildLegacyTx({ wallet, extraWritableKeys = [], readonlyKeys = [], tokenCloses = [], systemCreates = [] }) {
  const programId = generateSolanaWallet().address;
  const recentBlockhash = generateSolanaWallet().address;
  const writable = [wallet, ...extraWritableKeys];
  const readonly = [...readonlyKeys];
  for (const k of systemCreates) if (!writable.includes(k)) writable.push(k);
  if (systemCreates.length) readonly.push(SYSTEM_PROGRAM_ID);
  for (const c of tokenCloses) {
    for (const k of [c.account, c.destination]) if (!writable.includes(k)) writable.push(k);
    for (const k of [c.authority, ...(c.signers ?? []), c.program ?? TOKEN_PROGRAM]) if (!writable.includes(k) && !readonly.includes(k)) readonly.push(k);
  }
  const accountKeys = [...writable, ...readonly, programId];
  const at = (k) => accountKeys.indexOf(k);
  const messageBytes = buildMessageBytes({
    versioned: false,
    accountKeys,
    header: {
      numRequiredSignatures: 1,
      numReadonlySignedAccounts: 0,
      numReadonlyUnsignedAccounts: readonly.length + 1, // + programId
    },
    recentBlockhash,
    instructions: [
      { programIdIndex: accountKeys.length - 1, accountIndexes: [0], data: Buffer.from([0x01]) },
      // System CreateAccount: u32 0, lamports, space, owner (wallet funds it).
      ...systemCreates.map((k) => ({
        programIdIndex: at(SYSTEM_PROGRAM_ID),
        accountIndexes: [0, at(k)],
        data: Buffer.concat([Buffer.alloc(4), Buffer.alloc(8), Buffer.alloc(8), base58Decode(TOKEN_PROGRAM)]),
      })),
      ...tokenCloses.map((c) => ({
        programIdIndex: at(c.program ?? TOKEN_PROGRAM),
        accountIndexes: [at(c.account), at(c.destination), at(c.authority), ...(c.signers ?? []).map(at)],
        data: Buffer.from([9]),
      })),
    ],
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
        return { value: { err: null, innerInstructions: [], accounts: addrs.map((a) => post[a]) } };
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
        return { value: { err: null, innerInstructions: [], accounts: addrs.map((a) => post[a]) } };
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
        return { value: { err: null, innerInstructions: [], accounts: addrs.map((a) => post[a]) } };
      },
    }));

    const result = await simulateSolanaAssetChanges('solana', txBase64, { walletAddress: wallet });
    expect(result.deltas[mint]).toBe(200n);
  });

  describe('top-level close whose accounts come from an address-lookup table (v0 tx)', () => {
    // Static keys: [wallet, wsolAta, token program, filler program]. The ALT
    // contributes one writable entry (index 4) and one readonly entry (index 5).
    function runV0({ destinationIndex }) {
      const wallet = generateSolanaWallet().address;
      const wsolAta = generateSolanaWallet().address;
      const programId = generateSolanaWallet().address;
      const altAddress = generateSolanaWallet().address;
      const altWritable = generateSolanaWallet().address;
      const altReadonly = generateSolanaWallet().address;
      const altTableData = Buffer.concat([Buffer.alloc(56), base58Decode(altWritable), base58Decode(altReadonly)]).toString('base64');
      const messageBytes = buildMessageBytes({
        versioned: true,
        accountKeys: [wallet, wsolAta, TOKEN_PROGRAM, programId],
        header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 2 },
        recentBlockhash: generateSolanaWallet().address,
        instructions: [
          { programIdIndex: 3, accountIndexes: [0], data: Buffer.from([0x01]) },
          { programIdIndex: 2, accountIndexes: [1, destinationIndex, 0], data: Buffer.from([9]) },
        ],
        addressTableLookups: [{ lookupTableAddress: altAddress, writableIndexes: [0], readonlyIndexes: [1] }],
      });
      vi.stubGlobal('fetch', mockSolanaRpc({
        altAccounts: { [altAddress]: { data: [altTableData, 'base64'], owner: 'AddressLookupTab1e1111111111111111111111', lamports: 1 } },
        trackedAccounts: {
          [wallet]: nativeAccountInfo(1_000_000_000),
          [wsolAta]: tokenAccountInfo({ mint: WSOL_MINT, owner: wallet, amount: 0, closeAuthority: altWritable }),
        },
        simValue: (params) => {
          const post = { [wallet]: nativeAccountInfo(999_995_000) };
          return { value: { err: null, innerInstructions: [], accounts: params[1].accounts.addresses.map((a) => post[a] ?? null) } };
        },
      }));
      return { wsolAta, altWritable, result: simulateSolanaAssetChanges('solana', wrapTransaction(messageBytes), { walletAddress: wallet }) };
    }

    // Static keys: [wallet, token program, filler program]; writable lookup
    // entries follow in table order. `tables` lists each table's writable entries.
    function runV0Tables({ tables, close, preTracked, postTracked }) {
      const wallet = preTracked.wallet;
      const accountKeys = [wallet, TOKEN_PROGRAM, generateSolanaWallet().address];
      const altAccounts = {};
      const lookups = tables.map((entries) => {
        const lookupTableAddress = generateSolanaWallet().address;
        const data = Buffer.concat([Buffer.alloc(56), ...entries.map((a) => base58Decode(a))]).toString('base64');
        altAccounts[lookupTableAddress] = { data: [data, 'base64'], owner: 'AddressLookupTab1e1111111111111111111111', lamports: 1 };
        return { lookupTableAddress, writableIndexes: entries.map((_, i) => i), readonlyIndexes: [] };
      });
      const messageBytes = buildMessageBytes({
        versioned: true,
        accountKeys,
        header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 2 },
        recentBlockhash: generateSolanaWallet().address,
        instructions: [
          { programIdIndex: 2, accountIndexes: [0], data: Buffer.from([0x01]) },
          { programIdIndex: 1, accountIndexes: close, data: Buffer.from([9]) },
        ],
        addressTableLookups: lookups,
      });
      vi.stubGlobal('fetch', mockSolanaRpc({
        altAccounts,
        trackedAccounts: preTracked.accounts,
        simValue: (params) => ({ value: { err: null, innerInstructions: [], accounts: params[1].accounts.addresses.map((a) => postTracked[a] ?? null) } }),
      }));
      return simulateSolanaAssetChanges('solana', wrapTransaction(messageBytes), { walletAddress: wallet });
    }

    it('allows a WSOL account that lives in a lookup table closed back to the wallet', async () => {
      const wallet = generateSolanaWallet().address;
      const wsolAta = generateSolanaWallet().address;
      const result = await runV0Tables({
        tables: [[wsolAta]],
        close: [3, 0, 0], // account = first writable table entry, destination = wallet
        preTracked: { wallet, accounts: { [wallet]: nativeAccountInfo(1_000_000_000), [wsolAta]: tokenAccountInfo({ mint: WSOL_MINT, owner: wallet, amount: 0 }) } },
        postTracked: { [wallet]: nativeAccountInfo(1_000_000_000 - 5_000 + 2_039_280) },
      });
      expect(result.deltas[SOL_SENTINEL]).toBe(-5_000n);
    });

    it('reads writable entries across two lookup tables in table order', async () => {
      // Index 4 is the second table's entry (the attacker), not the first's.
      const wallet = generateSolanaWallet().address;
      const wsolAta = generateSolanaWallet().address;
      const attacker = generateSolanaWallet().address;
      const result = runV0Tables({
        tables: [[wsolAta], [attacker]],
        close: [3, 4, 0],
        preTracked: { wallet, accounts: { [wallet]: nativeAccountInfo(1_000_000_000), [wsolAta]: tokenAccountInfo({ mint: WSOL_MINT, owner: wallet, amount: 0, closeAuthority: attacker }) } },
        postTracked: { [wallet]: nativeAccountInfo(999_995_000) },
      });
      await expect(result).rejects.toMatchObject({ code: 'SIM_ACCOUNT_CONTROL_CHANGED', message: expect.stringContaining(`closes your token account ${wsolAta} in a top-level instruction and sends its rent to ${attacker}`) });
    });

    it('refuses when the rent destination resolves through the table to another address', async () => {
      const { result, altWritable } = runV0({ destinationIndex: 4 });
      await expect(result).rejects.toMatchObject({ code: 'SIM_ACCOUNT_CONTROL_CHANGED', message: expect.stringContaining(`sends its rent to ${altWritable}`) });
    });

    it('refuses when the rent destination is a readonly table entry it cannot resolve', async () => {
      const { result } = runV0({ destinationIndex: 5 });
      await expect(result).rejects.toMatchObject({ code: 'SIM_ACCOUNT_CONTROL_CHANGED', message: expect.stringContaining('cannot resolve') });
    });
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
        return { value: { err: null, innerInstructions: [], accounts: addrs.map((a) => post[a]) } };
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
        return { value: { err: null, innerInstructions: [], accounts: addrs.map((a) => post[a] ?? null) } };
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
        return { value: { err: null, innerInstructions: [], accounts: addrs.map((a) => post[a] ?? null) } };
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
      simValue: () => ({ value: { err: null, innerInstructions: [], accounts: null } }),
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
        return { value: { err: null, innerInstructions: [], accounts: addrs.map(() => nativeAccountInfo(1_000_000_000)) } };
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
      simValue: () => ({ value: { err: null, innerInstructions: [], accounts: [] } }),
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

    function run({ pre, post, extraWritableKeys = [ataIn, ataOut], inner = [], tokenCloses = [], systemCreates = [] }) {
      const txBase64 = buildLegacyTx({ wallet, extraWritableKeys, tokenCloses, systemCreates });
      vi.stubGlobal('fetch', mockSolanaRpc({
        trackedAccounts: pre,
        simValue: (params) => ({ value: { err: null, innerInstructions: inner, accounts: params[1].accounts.addresses.map((a) => (a in post ? post[a] : null)) } }),
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

    it('fails closed when a delegate is set but the post-state has no delegated amount', async () => {
      // Read as 0, a grown allowance for an existing delegate would go unnoticed.
      const pre = basePre();
      pre[ataOut] = tokenAccountInfo({ mint: mintOut, owner: wallet, amount: 0, delegate: attacker, delegatedAmount: { amount: '5', decimals: 6 } });
      await expect(run({ pre, post: basePost({ delegate: attacker }) }))
        .rejects.toMatchObject({ code: 'SIM_RESULT_UNPARSEABLE' });
    });

    it('fails closed when a delegated amount is not a whole number', async () => {
      const pre = basePre();
      pre[ataOut] = tokenAccountInfo({ mint: mintOut, owner: wallet, amount: 0, delegate: attacker, delegatedAmount: { amount: '5', decimals: 6 } });
      await expect(run({ pre, post: basePost({ delegate: attacker, delegatedAmount: { amount: '', decimals: 6 } }) }))
        .rejects.toMatchObject({ code: 'SIM_RESULT_UNPARSEABLE' });
    });

    it('fails closed when an existing delegate has no delegated amount in the pre-state', async () => {
      const pre = basePre();
      pre[ataOut] = tokenAccountInfo({ mint: mintOut, owner: wallet, amount: 0, delegate: attacker });
      await expect(run({ pre, post: basePost({ delegate: attacker, delegatedAmount: { amount: '5', decimals: 6 } }) }))
        .rejects.toMatchObject({ code: 'SIM_RESULT_UNPARSEABLE' });
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
      // The route's top-level CloseAccount returns the account's rent to the wallet.
      const post = { ...basePost(), [wallet]: nativeAccountInfo(999_995_000 + 2_039_280), [wsolAta]: null };
      const tokenCloses = [{ account: wsolAta, destination: wallet, authority: wallet }];
      const result = await run({ pre, post, extraWritableKeys: [ataIn, ataOut, wsolAta], tokenCloses });
      expect(result.deltas[mintOut]).toBe(1_000_000n);
      expect(result.deltas[SOL_SENTINEL]).toBe(-5_000n);
    });

    describe('top-level close of a wallet token account', () => {
      let wsolAta;
      beforeEach(() => { wsolAta = generateSolanaWallet().address; });
      const wsolPre = (extra = {}) => ({ ...basePre(), [wsolAta]: tokenAccountInfo({ mint: WSOL_MINT, owner: wallet, amount: 0, ...extra }) });
      const withWsol = () => [ataIn, ataOut, wsolAta];
      // Rent went to another account: the wallet's native balance only paid the fee.
      const rentLostPost = () => ({ ...basePost(), [wsolAta]: null });

      it('refuses a close of the empty wallet WSOL account by a third-party close authority that sends the rent elsewhere', async () => {
        // The close authority was set before this tx, so the post-state check
        // sees no change, the wallet signs nothing for the close, and the lost
        // rent fits inside the native fee slack.
        const tokenCloses = [{ account: wsolAta, destination: attacker, authority: attacker }];
        await expect(run({ pre: wsolPre({ closeAuthority: attacker }), post: rentLostPost(), extraWritableKeys: withWsol(), tokenCloses }))
          .rejects.toMatchObject({ code: 'SIM_ACCOUNT_CONTROL_CHANGED', message: expect.stringContaining(`closes your token account ${wsolAta} in a top-level instruction and sends its rent to ${attacker}`) });
      });

      it('refuses a Token-2022 close of a wallet token account that sends the rent elsewhere', async () => {
        const tokenCloses = [{ account: wsolAta, destination: attacker, authority: attacker, program: TOKEN_2022_PROGRAM }];
        await expect(run({ pre: wsolPre({ closeAuthority: attacker }), post: rentLostPost(), extraWritableKeys: withWsol(), tokenCloses }))
          .rejects.toMatchObject({ code: 'SIM_ACCOUNT_CONTROL_CHANGED' });
      });

      it('refuses a close-and-reinitialize of a wallet token account whose rent goes elsewhere (post-state looks intact)', async () => {
        const tokenCloses = [{ account: ataOut, destination: attacker, authority: attacker }];
        await expect(run({ pre: basePre(), post: basePost(), tokenCloses }))
          .rejects.toMatchObject({ code: 'SIM_ACCOUNT_CONTROL_CHANGED', message: expect.stringContaining(`sends its rent to ${attacker}`) });
      });

      it('refuses a closed wallet WSOL account when no close instruction shows where its rent went', async () => {
        await expect(run({ pre: wsolPre(), post: rentLostPost(), extraWritableKeys: withWsol() }))
          .rejects.toMatchObject({ code: 'SIM_ACCOUNT_CONTROL_CHANGED', message: expect.stringContaining(`closes your token account ${wsolAta}, but no close instruction`) });
      });

      it('refuses when one close returns the rent and another close of the same account sends it elsewhere', async () => {
        const tokenCloses = [
          { account: wsolAta, destination: wallet, authority: wallet },
          { account: wsolAta, destination: attacker, authority: attacker },
        ];
        await expect(run({ pre: wsolPre({ closeAuthority: attacker }), post: rentLostPost(), extraWritableKeys: withWsol(), tokenCloses }))
          .rejects.toMatchObject({ code: 'SIM_ACCOUNT_CONTROL_CHANGED' });
      });

      it("allows a top-level close of another party's account to that party", async () => {
        const router = generateSolanaWallet().address;
        const routerTemp = generateSolanaWallet().address;
        const tokenCloses = [{ account: routerTemp, destination: router, authority: router }];
        const result = await run({ pre: basePre(), post: basePost(), tokenCloses });
        expect(result.deltas[mintOut]).toBe(1_000_000n);
      });

      it('allows a WSOL account the tx creates and closes back to the wallet (no pre-state)', async () => {
        const tokenCloses = [{ account: wsolAta, destination: wallet, authority: wallet }];
        const result = await run({ pre: basePre(), post: { ...basePost(), [wsolAta]: null }, extraWritableKeys: withWsol(), tokenCloses });
        expect(result.deltas[mintOut]).toBe(1_000_000n);
      });

      it('allows selling a whole token balance with the input account closed back to the wallet', async () => {
        const post = { ...basePost(), [ataIn]: null, [wallet]: nativeAccountInfo(999_995_000 + 2_039_280) };
        const tokenCloses = [{ account: ataIn, destination: wallet, authority: wallet }];
        const result = await run({ pre: basePre(), post, tokenCloses });
        expect(result.deltas[mintIn]).toBe(-1_000_000n);
        expect(result.deltas[mintOut]).toBe(1_000_000n);
      });

      it('fails closed when a closed WSOL account has no readable pre-state lamports', async () => {
        const pre = wsolPre();
        delete pre[wsolAta].lamports;
        const tokenCloses = [{ account: wsolAta, destination: wallet, authority: wallet }];
        await expect(run({ pre, post: rentLostPost(), extraWritableKeys: withWsol(), tokenCloses }))
          .rejects.toMatchObject({ code: 'SIM_RESULT_UNPARSEABLE' });
      });
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

    describe('token accounts closed by a CPI', () => {
      // simulateTransaction's inner instructions, as mainnet returns them: a
      // parsed token instruction, or `accounts` + base58 `data` when unparsed.
      const parsedClose = (info) => ({
        program: 'spl-token', programId: TOKEN_PROGRAM, stackHeight: 2, parsed: { type: 'closeAccount', info },
      });
      const rawClose = (accounts) => ({ programId: TOKEN_PROGRAM, accounts, data: base58Encode(Buffer.from([9])), stackHeight: 2 });
      const inGroup = (...instructions) => [{ index: 0, instructions }];
      let wsolAta;
      beforeEach(() => { wsolAta = generateSolanaWallet().address; });
      const wsolPre = () => ({ ...basePre(), [wsolAta]: tokenAccountInfo({ mint: WSOL_MINT, owner: wallet, amount: 0 }) });
      const withWsol = () => [ataIn, ataOut, wsolAta];

      it('refuses a CPI close of the wallet WSOL account that sends its rent elsewhere', async () => {
        const post = { ...basePost(), [wsolAta]: null };
        const inner = inGroup(parsedClose({ account: wsolAta, destination: attacker, owner: wallet }));
        await expect(run({ pre: wsolPre(), post, extraWritableKeys: withWsol(), inner }))
          .rejects.toMatchObject({ code: 'SIM_ACCOUNT_CONTROL_CHANGED', message: expect.stringContaining(`sends its rent to ${attacker}`) });
      });

      it('refuses a close-and-reinitialize of a wallet token account (post-state looks intact)', async () => {
        const inner = inGroup(
          parsedClose({ account: ataOut, destination: attacker, owner: wallet }),
          { program: 'spl-token', programId: TOKEN_PROGRAM, stackHeight: 2, parsed: { type: 'initializeAccount3', info: { account: ataOut, mint: mintOut, owner: wallet } } },
        );
        await expect(run({ pre: basePre(), post: basePost(), inner }))
          .rejects.toMatchObject({ code: 'SIM_ACCOUNT_CONTROL_CHANGED' });
      });

      it("refuses a CPI close of the wallet's token account by a third-party close authority", async () => {
        // A close authority set before this tx (unchanged, so the post-state check passes it).
        const pre = { ...wsolPre(), [wsolAta]: tokenAccountInfo({ mint: WSOL_MINT, owner: wallet, amount: 0, closeAuthority: attacker }) };
        const post = { ...basePost(), [wsolAta]: null };
        const inner = inGroup(parsedClose({ account: wsolAta, destination: attacker, owner: attacker }));
        await expect(run({ pre, post, extraWritableKeys: withWsol(), inner }))
          .rejects.toMatchObject({ code: 'SIM_ACCOUNT_CONTROL_CHANGED', message: expect.stringContaining(`your token account ${wsolAta}`) });
      });

      it("refuses a wallet-authorized CPI close of an account outside the transaction's writable accounts", async () => {
        // No pre-state was ever read for it, so it can't count as created in this tx.
        const temp = generateSolanaWallet().address;
        const inner = inGroup(parsedClose({ account: temp, destination: attacker, owner: wallet }));
        await expect(run({ pre: basePre(), post: basePost(), inner }))
          .rejects.toMatchObject({ code: 'SIM_ACCOUNT_CONTROL_CHANGED' });
      });

      describe('temporary account created and closed within the transaction', () => {
        // A router opens a WSOL account for the wallet (System allocate from
        // inside the router), swaps into it, closes it into its own account and
        // pays the SOL on to the wallet.
        const initWsol = (account) => ({
          program: 'spl-token', programId: TOKEN_PROGRAM, stackHeight: 2, parsed: { type: 'initializeAccount3', info: { account, mint: WSOL_MINT, owner: wallet } },
        });
        const allocate = (account) => ({
          program: 'system', programId: SYSTEM_PROGRAM_ID, stackHeight: 2, parsed: { type: 'allocate', info: { account, space: 165 } },
        });
        // Raw System Allocate: u32 8 + u64 space.
        const rawAllocate = (account) => ({
          programId: SYSTEM_PROGRAM_ID, accounts: [account], data: base58Encode(Buffer.concat([Buffer.from([8, 0, 0, 0]), Buffer.from([165, 0, 0, 0, 0, 0, 0, 0])])), stackHeight: 2,
        });
        let temp, router;
        beforeEach(() => { temp = generateSolanaWallet().address; router = generateSolanaWallet().address; });
        const tempPost = () => ({ ...basePost(), [temp]: null });
        const withTemp = () => [ataIn, ataOut, temp];

        it('allows a CPI close of a wallet WSOL account the transaction opened, with the rent sent to the router', async () => {
          const inner = inGroup(allocate(temp), initWsol(temp), parsedClose({ account: temp, destination: router, owner: wallet }));
          const result = await run({ pre: basePre(), post: tempPost(), extraWritableKeys: withTemp(), inner });
          expect(result.deltas[mintOut]).toBe(1_000_000n);
        });

        it('allows the same close when the node returns both instructions unparsed', async () => {
          const inner = inGroup(rawAllocate(temp), initWsol(temp), rawClose([temp, router, wallet]));
          const result = await run({ pre: basePre(), post: tempPost(), extraWritableKeys: withTemp(), inner });
          expect(result.deltas[mintOut]).toBe(1_000_000n);
        });

        it('allows it when a top-level CreateAccount opens the account before the router runs', async () => {
          // Top-level instruction 1 creates it; the router's inner group is instruction 2.
          const inner = [{ index: 2, instructions: [initWsol(temp), parsedClose({ account: temp, destination: router, owner: wallet })] }];
          const result = await run({ pre: basePre(), post: tempPost(), extraWritableKeys: withTemp(), systemCreates: [temp], inner });
          expect(result.deltas[mintOut]).toBe(1_000_000n);
        });

        it('counts the seed variants and a raw inner CreateAccount as creating the account', async () => {
          const funder = wallet;
          const creates = [
            { program: 'system', programId: SYSTEM_PROGRAM_ID, stackHeight: 2, parsed: { type: 'createAccountWithSeed', info: { source: funder, newAccount: temp, base: funder, seed: 'x', lamports: 2_039_280, space: 165, owner: TOKEN_PROGRAM } } },
            { program: 'system', programId: SYSTEM_PROGRAM_ID, stackHeight: 2, parsed: { type: 'allocateWithSeed', info: { account: temp, base: funder, seed: 'x', space: 165, owner: TOKEN_PROGRAM } } },
            // Raw CreateAccount: u32 0, lamports, space, owner; accounts [funder, new account].
            { programId: SYSTEM_PROGRAM_ID, accounts: [funder, temp], data: base58Encode(Buffer.concat([Buffer.alloc(20), base58Decode(TOKEN_PROGRAM)])), stackHeight: 2 },
          ];
          for (const create of creates) {
            const inner = inGroup(create, initWsol(temp), parsedClose({ account: temp, destination: router, owner: wallet }));
            const result = await run({ pre: basePre(), post: tempPost(), extraWritableKeys: withTemp(), inner });
            expect(result.deltas[mintOut]).toBe(1_000_000n);
          }
        });

        it('does not count a System transfer or assign as creating the account', async () => {
          // OKX funds its temporary account with a transfer; that alone proves nothing.
          const transfer = { program: 'system', programId: SYSTEM_PROGRAM_ID, stackHeight: 2, parsed: { type: 'transfer', info: { source: wallet, destination: temp, lamports: 2_039_280 } } };
          const rawTransfer = { programId: SYSTEM_PROGRAM_ID, accounts: [wallet, temp], data: base58Encode(Buffer.concat([Buffer.from([2, 0, 0, 0]), Buffer.alloc(8)])), stackHeight: 2 };
          const assign = { program: 'system', programId: SYSTEM_PROGRAM_ID, stackHeight: 2, parsed: { type: 'assign', info: { account: temp, owner: TOKEN_PROGRAM } } };
          const inner = inGroup(transfer, rawTransfer, assign, initWsol(temp), parsedClose({ account: temp, destination: router, owner: wallet }));
          await expect(run({ pre: basePre(), post: tempPost(), extraWritableKeys: withTemp(), inner }))
            .rejects.toMatchObject({ code: 'SIM_ACCOUNT_CONTROL_CHANGED' });
        });

        it('refuses when no instruction in the transaction creates the account (an empty snapshot alone is not proof)', async () => {
          // e.g. a lagging node returned no pre-state for an existing account and
          // the route's create-if-missing was a no-op.
          const inner = inGroup(initWsol(temp), parsedClose({ account: temp, destination: router, owner: wallet }));
          await expect(run({ pre: basePre(), post: tempPost(), extraWritableKeys: withTemp(), inner }))
            .rejects.toMatchObject({ code: 'SIM_ACCOUNT_CONTROL_CHANGED', message: expect.stringContaining(`closes token account ${temp} from inside another program and sends its rent to ${router}`) });
        });

        it('refuses when the account is only created after the close', async () => {
          const inner = inGroup(parsedClose({ account: temp, destination: router, owner: wallet }), allocate(temp), initWsol(temp));
          await expect(run({ pre: basePre(), post: tempPost(), extraWritableKeys: withTemp(), inner }))
            .rejects.toMatchObject({ code: 'SIM_ACCOUNT_CONTROL_CHANGED' });
        });

        it('refuses a top-level create that runs after the router closes the account', async () => {
          // The inner group belongs to instruction 0, before the create at 1.
          const inner = [{ index: 0, instructions: [initWsol(temp), parsedClose({ account: temp, destination: router, owner: wallet })] }];
          await expect(run({ pre: basePre(), post: tempPost(), extraWritableKeys: withTemp(), systemCreates: [temp], inner }))
            .rejects.toMatchObject({ code: 'SIM_ACCOUNT_CONTROL_CHANGED' });
        });

        it('refuses when inner instruction groups are out of order', async () => {
          const inner = [
            { index: 3, instructions: [allocate(temp)] },
            { index: 2, instructions: [parsedClose({ account: temp, destination: router, owner: wallet })] },
          ];
          await expect(run({ pre: basePre(), post: tempPost(), extraWritableKeys: withTemp(), inner }))
            .rejects.toMatchObject({ code: 'SIM_ACCOUNT_CONTROL_CHANGED' });
        });

        it('refuses a pre-existing wallet WSOL account closed, re-created and closed again to another address', async () => {
          // The second close follows a create, but the account existed before the transaction.
          const inner = inGroup(
            parsedClose({ account: wsolAta, destination: wallet, owner: wallet }),
            allocate(wsolAta),
            initWsol(wsolAta),
            parsedClose({ account: wsolAta, destination: router, owner: wallet }),
          );
          await expect(run({ pre: wsolPre(), post: { ...basePost(), [wsolAta]: null }, extraWritableKeys: withWsol(), inner }))
            .rejects.toMatchObject({ code: 'SIM_ACCOUNT_CONTROL_CHANGED', message: expect.stringContaining(`sends its rent to ${router}`) });
        });

        it('refuses a pre-funded address allocated as a wallet WSOL account and closed to another address', async () => {
          // The address held lamports before the transaction, so it existed;
          // only its pre-state stops the exception here.
          const inner = inGroup(allocate(temp), initWsol(temp), parsedClose({ account: temp, destination: router, owner: wallet }));
          const pre = { ...basePre(), [temp]: nativeAccountInfo(2_039_280) };
          await expect(run({ pre, post: tempPost(), extraWritableKeys: withTemp(), inner }))
            .rejects.toMatchObject({ code: 'SIM_ACCOUNT_CONTROL_CHANGED', message: expect.stringContaining(`closes token account ${temp} from inside another program`) });
        });

        it('refuses a top-level close the wallet signs of a pre-funded address it opened as a wallet token account, without relying on the static check', async () => {
          // The address held lamports before (System-owned pre-state) and is gone
          // after, so the post-state never shows it as one of the wallet's
          // accounts. The simulation check must still refuse the close itself.
          const inner = inGroup(allocate(temp), initWsol(temp));
          const pre = { ...basePre(), [temp]: nativeAccountInfo(2_039_280) };
          const tokenCloses = [{ account: temp, destination: router, authority: wallet }];
          await expect(run({ pre, post: tempPost(), extraWritableKeys: withTemp(), inner, tokenCloses }))
            .rejects.toMatchObject({ code: 'SIM_ACCOUNT_CONTROL_CHANGED', message: expect.stringContaining(`closes token account ${temp} in a top-level instruction with your wallet's signature and sends its rent to ${router}`) });
        });

        it('refuses a top-level close whose multisig signers include the wallet', async () => {
          const multisig = generateSolanaWallet().address;
          const tokenCloses = [{ account: temp, destination: router, authority: multisig, signers: [wallet] }];
          await expect(run({ pre: basePre(), post: tempPost(), extraWritableKeys: withTemp(), tokenCloses }))
            .rejects.toMatchObject({ code: 'SIM_ACCOUNT_CONTROL_CHANGED', message: expect.stringContaining("with your wallet's signature") });
        });

        it('refuses the same top-level close of an account the transaction creates (no exception at the top level)', async () => {
          const tokenCloses = [{ account: temp, destination: router, authority: wallet }];
          await expect(run({ pre: basePre(), post: tempPost(), extraWritableKeys: withTemp(), systemCreates: [temp], tokenCloses }))
            .rejects.toMatchObject({ code: 'SIM_ACCOUNT_CONTROL_CHANGED' });
        });

        it("refuses a temporary account re-created as the wallet's and left open after its rent went elsewhere", async () => {
          // Still open after the tx, so it is one of the wallet's token accounts.
          const inner = inGroup(allocate(temp), initWsol(temp), parsedClose({ account: temp, destination: router, owner: wallet }), allocate(temp), initWsol(temp));
          const post = { ...basePost(), [temp]: tokenAccountInfo({ mint: WSOL_MINT, owner: wallet, amount: 0 }) };
          await expect(run({ pre: basePre(), post, extraWritableKeys: withTemp(), inner }))
            .rejects.toMatchObject({ code: 'SIM_ACCOUNT_CONTROL_CHANGED', message: expect.stringContaining(`closes your token account ${temp}`) });
        });
      });

      it('refuses a CPI close whose multisig signers include the wallet', async () => {
        const temp = generateSolanaWallet().address;
        const multisig = generateSolanaWallet().address;
        const inner = inGroup(parsedClose({ account: temp, destination: attacker, multisigOwner: multisig, signers: [wallet] }));
        await expect(run({ pre: basePre(), post: basePost(), inner }))
          .rejects.toMatchObject({ code: 'SIM_ACCOUNT_CONTROL_CHANGED' });
      });

      it('refuses an unparsed (raw) CPI CloseAccount of a wallet token account', async () => {
        const post = { ...basePost(), [wsolAta]: null };
        const inner = inGroup(rawClose([wsolAta, attacker, wallet]));
        await expect(run({ pre: wsolPre(), post, extraWritableKeys: withWsol(), inner }))
          .rejects.toMatchObject({ code: 'SIM_ACCOUNT_CONTROL_CHANGED' });
      });

      it('allows a CPI close of the wallet WSOL account back to the wallet', async () => {
        const post = { ...basePost(), [wallet]: nativeAccountInfo(999_995_000 + 2_039_280), [wsolAta]: null };
        const inner = inGroup(parsedClose({ account: wsolAta, destination: wallet, owner: wallet }));
        const result = await run({ pre: wsolPre(), post, extraWritableKeys: withWsol(), inner });
        expect(result.deltas[SOL_SENTINEL]).toBe(-5_000n);
      });

      it("ignores a CPI close of another party's account (an aggregator's own temp account)", async () => {
        const router = generateSolanaWallet().address;
        const routerTemp = generateSolanaWallet().address;
        const inner = inGroup(
          parsedClose({ account: routerTemp, destination: router, owner: router }),
          rawClose([generateSolanaWallet().address, router, router]),
        );
        const result = await run({ pre: basePre(), post: basePost(), inner });
        expect(result.deltas[mintOut]).toBe(1_000_000n);
      });

      it('refuses (does not degrade) when the RPC returns no inner instructions', async () => {
        await expect(run({ pre: basePre(), post: basePost(), inner: null }))
          .rejects.toMatchObject({ code: 'SIM_INNER_INSTRUCTIONS_UNAVAILABLE', message: expect.stringContaining('NANSEN_SOLANA_SIM_RPC') });
      });

      it('reports a post-state violation ahead of missing inner instructions', async () => {
        const post = basePost();
        post[ataOut] = tokenAccountInfo({ mint: mintOut, owner: attacker, amount: 1_000_000 });
        await expect(run({ pre: basePre(), post, inner: null }))
          .rejects.toMatchObject({ code: 'SIM_ACCOUNT_CONTROL_CHANGED' });
      });

      it('refuses compiled inner instructions (programIdIndex) it cannot resolve', async () => {
        const inner = inGroup({ programIdIndex: 3, accounts: [1, 2, 0], data: base58Encode(Buffer.from([9])) });
        await expect(run({ pre: basePre(), post: basePost(), inner }))
          .rejects.toMatchObject({ code: 'SIM_INNER_INSTRUCTIONS_UNAVAILABLE' });
      });

      it('passes a clean swap with an empty inner-instruction list', async () => {
        const result = await run({ pre: basePre(), post: basePost(), inner: [] });
        expect(result.deltas[mintOut]).toBe(1_000_000n);
      });

      it('fails closed on a null or programId-less inner instruction entry', async () => {
        await expect(run({ pre: basePre(), post: basePost(), inner: inGroup(null) }))
          .rejects.toMatchObject({ code: 'SIM_RESULT_UNPARSEABLE' });
        await expect(run({ pre: basePre(), post: basePost(), inner: inGroup({ accounts: [], data: '' }) }))
          .rejects.toMatchObject({ code: 'SIM_RESULT_UNPARSEABLE' });
      });

      it('fails closed on a parsed closeAccount missing its fields', async () => {
        await expect(run({ pre: basePre(), post: basePost(), inner: inGroup(parsedClose({})) }))
          .rejects.toMatchObject({ code: 'SIM_RESULT_UNPARSEABLE' });
        await expect(run({ pre: basePre(), post: basePost(), inner: inGroup(parsedClose({ account: ataOut, owner: wallet })) }))
          .rejects.toMatchObject({ code: 'SIM_RESULT_UNPARSEABLE' });
      });

      it('fails closed on a raw CloseAccount with too few accounts', async () => {
        await expect(run({ pre: basePre(), post: basePost(), inner: inGroup(rawClose([ataOut, attacker])) }))
          .rejects.toMatchObject({ code: 'SIM_RESULT_UNPARSEABLE' });
      });

      it('refuses a Token-2022 CPI close of a wallet token account', async () => {
        const inner = inGroup({ ...parsedClose({ account: ataOut, destination: attacker, owner: wallet }), program: 'spl-token-2022', programId: TOKEN_2022_PROGRAM });
        await expect(run({ pre: basePre(), post: basePost(), inner }))
          .rejects.toMatchObject({ code: 'SIM_ACCOUNT_CONTROL_CHANGED' });
      });

      it('allows a raw CPI close back to the wallet', async () => {
        const post = { ...basePost(), [wallet]: nativeAccountInfo(999_995_000 + 2_039_280), [wsolAta]: null };
        const result = await run({ pre: wsolPre(), post, extraWritableKeys: withWsol(), inner: inGroup(rawClose([wsolAta, wallet, wallet])) });
        expect(result.deltas[SOL_SENTINEL]).toBe(-5_000n);
      });

      it('refuses a raw CPI close whose multisig signers include the wallet', async () => {
        const multisig = generateSolanaWallet().address;
        const inner = inGroup(rawClose([generateSolanaWallet().address, attacker, multisig, wallet]));
        await expect(run({ pre: basePre(), post: basePost(), inner }))
          .rejects.toMatchObject({ code: 'SIM_ACCOUNT_CONTROL_CHANGED' });
      });

      it('refuses a wallet-authorized CPI Approve, parsed or raw, even if revoked later in the tx', async () => {
        const parsedApprove = { program: 'spl-token', programId: TOKEN_PROGRAM, stackHeight: 2, parsed: { type: 'approve', info: { source: ataOut, delegate: attacker, owner: wallet, amount: '1' } } };
        await expect(run({ pre: basePre(), post: basePost(), inner: inGroup(parsedApprove) }))
          .rejects.toMatchObject({ code: 'SIM_ACCOUNT_CONTROL_CHANGED', message: expect.stringContaining('approves a delegate') });
        const rawApproveChecked = { programId: TOKEN_PROGRAM, accounts: [ataOut, mintOut, attacker, wallet], data: base58Encode(Buffer.from([13, 1, 0, 0, 0, 0, 0, 0, 0, 6])), stackHeight: 2 };
        await expect(run({ pre: basePre(), post: basePost(), inner: inGroup(rawApproveChecked) }))
          .rejects.toMatchObject({ code: 'SIM_ACCOUNT_CONTROL_CHANGED' });
      });

      it('refuses SetAuthority-then-close of an account the tx creates (authority moved off the wallet first)', async () => {
        const temp = generateSolanaWallet().address;
        const inner = inGroup(
          { program: 'spl-token', programId: TOKEN_PROGRAM, stackHeight: 2, parsed: { type: 'initializeAccount3', info: { account: temp, mint: WSOL_MINT, owner: wallet } } },
          { program: 'spl-token', programId: TOKEN_PROGRAM, stackHeight: 2, parsed: { type: 'setAuthority', info: { account: temp, authorityType: 'closeAccount', newAuthority: attacker, authority: wallet } } },
          parsedClose({ account: temp, destination: attacker, owner: attacker }),
        );
        await expect(run({ pre: basePre(), post: basePost(), inner }))
          .rejects.toMatchObject({ code: 'SIM_ACCOUNT_CONTROL_CHANGED', message: expect.stringContaining('changes an authority') });
      });

      it("ignores an Approve or SetAuthority another party authorizes on its own account", async () => {
        const router = generateSolanaWallet().address;
        const inner = inGroup(
          { program: 'spl-token', programId: TOKEN_PROGRAM, stackHeight: 2, parsed: { type: 'approve', info: { source: generateSolanaWallet().address, delegate: attacker, owner: router, amount: '1' } } },
          { program: 'spl-token', programId: TOKEN_PROGRAM, stackHeight: 2, parsed: { type: 'setAuthority', info: { mint: generateSolanaWallet().address, authorityType: 'mintTokens', newAuthority: null, authority: router } } },
        );
        const result = await run({ pre: basePre(), post: basePost(), inner });
        expect(result.deltas[mintOut]).toBe(1_000_000n);
      });

      it('fails closed on a malformed unparsed token-program inner instruction', async () => {
        const inner = inGroup({ programId: TOKEN_PROGRAM, accounts: [ataOut], data: 42 });
        await expect(run({ pre: basePre(), post: basePost(), inner }))
          .rejects.toMatchObject({ code: 'SIM_RESULT_UNPARSEABLE' });
      });

      it('asks the RPC for inner instructions', async () => {
        let captured;
        const txBase64 = buildLegacyTx({ wallet, extraWritableKeys: [ataIn, ataOut] });
        vi.stubGlobal('fetch', mockSolanaRpc({
          trackedAccounts: basePre(),
          onRequest: (body) => { if (body.method === 'simulateTransaction') captured = body.params[1]; },
          simValue: (params) => ({ value: { err: null, innerInstructions: [], accounts: params[1].accounts.addresses.map((a) => basePost()[a] ?? null) } }),
        }));
        await simulateSolanaAssetChanges('solana', txBase64, { walletAddress: wallet });
        expect(captured.innerInstructions).toBe(true);
      });
    });

    it('counts a pre-funded address the tx initializes cleanly as the wallet output account', async () => {
      const pre = { ...basePre(), [ataOut]: nativeAccountInfo(1_000_000) };
      const result = await run({ pre, post: basePost() });
      expect(result.deltas[mintOut]).toBe(1_000_000n);
    });
  });
});
