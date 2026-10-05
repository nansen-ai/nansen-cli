/**
 * Nansen CLI - Solana Transaction Deserialization
 * Parses a serialized (legacy or v0) Solana VersionedTransaction so its
 * instructions can be statically inspected before signing.
 */

import { base58Encode } from './wallet.js';

export function readCompactU16(buf, offset) {
  let value = 0;
  let shift = 0;
  let size = 0;
  for (let i = 0; i < 3; i++) {
    if (offset + i >= buf.length) {
      throw new Error('Malformed Solana transaction: compact-u16 length runs past end of buffer');
    }
    const byte = buf[offset + i];
    value |= (byte & 0x7f) << shift;
    size++;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return { value, size };
}

/**
 * Parse a base64-encoded Solana transaction (wire format:
 * [compact-u16 sigCount][sigCount * 64-byte signatures][message]) into its
 * header, static account keys, instructions, and (v0 only) address-table
 * lookups. `data` on instructions is returned undecoded (raw Buffer).
 */
export function parseTransactionMessage(base64) {
  const bytes = Buffer.from(base64, 'base64');
  // Fail closed on any read past the end of the buffer: a truncated or crafted
  // transaction must throw here rather than silently misparse into a wrong
  // (possibly drain-hiding) instruction list before signing.
  const requireBytes = (off, need) => {
    if (off + need > bytes.length) {
      throw new Error('Malformed Solana transaction: read past end of buffer');
    }
  };
  const { value: numSignatures, size: sigCountSize } = readCompactU16(bytes, 0);
  let offset = sigCountSize + numSignatures * 64;

  requireBytes(offset, 1);
  const first = bytes[offset];
  const isVersioned = (first & 0x80) !== 0;
  if (isVersioned) {
    // The low 7 bits are the version number. Only v0 exists today, and the rest
    // of this parser assumes the v0 message layout (static keys, instructions,
    // then address-table lookups). A future/unknown version could lay out its
    // bytes differently, so as a pre-signing safety gate we fail closed rather
    // than skip the prefix and misparse an unsupported format into a
    // wrong-and-possibly-drain-hiding instruction list.
    const version = first & 0x7f;
    if (version !== 0) {
      throw new Error(`Unsupported Solana transaction version ${version}. Refusing to sign.`);
    }
    offset += 1; // skip the version-prefix byte; header follows
  }

  requireBytes(offset, 3);
  const numRequiredSignatures = bytes[offset];
  const numReadonlySignedAccounts = bytes[offset + 1];
  const numReadonlyUnsignedAccounts = bytes[offset + 2];
  offset += 3;

  const { value: numAccountKeys, size: keysCountSize } = readCompactU16(bytes, offset);
  offset += keysCountSize;
  const staticAccountKeys = [];
  for (let i = 0; i < numAccountKeys; i++) {
    requireBytes(offset, 32);
    staticAccountKeys.push(base58Encode(bytes.subarray(offset, offset + 32)));
    offset += 32;
  }

  requireBytes(offset, 32);
  const recentBlockhash = base58Encode(bytes.subarray(offset, offset + 32));
  offset += 32;

  const { value: numInstructions, size: ixCountSize } = readCompactU16(bytes, offset);
  offset += ixCountSize;
  const instructions = [];
  for (let i = 0; i < numInstructions; i++) {
    requireBytes(offset, 1);
    const programIdIndex = bytes[offset];
    offset += 1;
    const { value: numAccounts, size: accCountSize } = readCompactU16(bytes, offset);
    offset += accCountSize;
    requireBytes(offset, numAccounts);
    const accountIndexes = [];
    for (let j = 0; j < numAccounts; j++) {
      accountIndexes.push(bytes[offset]);
      offset += 1;
    }
    const { value: dataLen, size: dataLenSize } = readCompactU16(bytes, offset);
    offset += dataLenSize;
    requireBytes(offset, dataLen);
    const data = bytes.subarray(offset, offset + dataLen);
    offset += dataLen;
    instructions.push({ programIdIndex, accountIndexes, data });
  }

  const addressTableLookups = [];
  if (isVersioned) {
    const { value: numLookups, size: lookupCountSize } = readCompactU16(bytes, offset);
    offset += lookupCountSize;
    for (let i = 0; i < numLookups; i++) {
      requireBytes(offset, 32);
      const lookupTableAddress = base58Encode(bytes.subarray(offset, offset + 32));
      offset += 32;
      const { value: numWritable, size: writableCountSize } = readCompactU16(bytes, offset);
      offset += writableCountSize;
      requireBytes(offset, numWritable);
      const writableIndexes = [];
      for (let j = 0; j < numWritable; j++) {
        writableIndexes.push(bytes[offset]);
        offset += 1;
      }
      const { value: numReadonly, size: readonlyCountSize } = readCompactU16(bytes, offset);
      offset += readonlyCountSize;
      requireBytes(offset, numReadonly);
      const readonlyIndexes = [];
      for (let j = 0; j < numReadonly; j++) {
        readonlyIndexes.push(bytes[offset]);
        offset += 1;
      }
      addressTableLookups.push({ lookupTableAddress, writableIndexes, readonlyIndexes });
    }
  }

  return {
    isVersioned,
    header: { numRequiredSignatures, numReadonlySignedAccounts, numReadonlyUnsignedAccounts },
    staticAccountKeys,
    recentBlockhash,
    instructions,
    addressTableLookups,
  };
}

/**
 * Resolve an account index to its base58 pubkey, or null if it's only
 * resolvable via an address-lookup-table entry (requires an RPC fetch this
 * module intentionally doesn't make). Lookup-table entries can never be
 * signers — Solana's message format requires every signer to be a static
 * account key — so a null result here only ever means "not a signer, and
 * this specific pubkey can't be verified without a network call."
 */
export function resolveStaticAccount(parsed, index) {
  if (index < parsed.staticAccountKeys.length) return parsed.staticAccountKeys[index];
  return null;
}

// Owner of every address-lookup-table account.
export const ADDRESS_LOOKUP_TABLE_PROGRAM = 'AddressLookupTab1e1111111111111111111111111';
// LookupTableMeta: typeIndex u32, deactivationSlot u64, lastExtendedSlot u64,
// lastExtendedSlotStartIndex u8, authority Option<Pubkey>, padding. The
// 32-byte addresses start right after it.
// The program always reserves all 56 bytes, even when authority is None.
const LOOKUP_TABLE_META_SIZE = 56;
const LOOKUP_TABLE_TYPE_INDEX = 1;
// Lookups index a table with a single byte.
const LOOKUP_TABLE_MAX_ADDRESSES = 256;
// A table that has never been deactivated stores u64::MAX here.
const LOOKUP_TABLE_ACTIVE_SLOT = 0xffffffffffffffffn;
// The SlotHashes sysvar: the recent slots a deactivating table stays usable for.
export const SLOT_HASHES_SYSVAR = 'SysvarS1otHashes111111111111111111111111111';
export const SYSVAR_PROGRAM = 'Sysvar1111111111111111111111111111111111111';

/**
 * Parse the raw data of an address-lookup-table account into its addresses and
 * its deactivation slot (null when it has never been deactivated). Throws on
 * anything that isn't an initialized table, so a truncated or foreign account
 * can't be read as a short or shifted address list.
 */
export function parseAddressLookupTable(data) {
  if (data.length < LOOKUP_TABLE_META_SIZE || (data.length - LOOKUP_TABLE_META_SIZE) % 32 !== 0) {
    throw new Error('Malformed address lookup table: unexpected account data length');
  }
  if ((data.length - LOOKUP_TABLE_META_SIZE) / 32 > LOOKUP_TABLE_MAX_ADDRESSES) {
    throw new Error(`Malformed address lookup table: more than ${LOOKUP_TABLE_MAX_ADDRESSES} addresses`);
  }
  if (data.readUInt32LE(0) !== LOOKUP_TABLE_TYPE_INDEX) {
    throw new Error('Malformed address lookup table: account is not an initialized lookup table');
  }
  const addresses = [];
  for (let offset = LOOKUP_TABLE_META_SIZE; offset < data.length; offset += 32) {
    addresses.push(base58Encode(data.subarray(offset, offset + 32)));
  }
  const deactivationSlot = data.readBigUInt64LE(4);
  return {
    deactivationSlot: deactivationSlot === LOOKUP_TABLE_ACTIVE_SLOT ? null : deactivationSlot,
    addresses,
  };
}

/**
 * Parse the SlotHashes sysvar (u64 count, then count × (u64 slot, 32-byte
 * hash)) into its slots.
 */
export function parseSlotHashes(data) {
  if (data.length < 8) throw new Error('Malformed SlotHashes sysvar: unexpected account data length');
  const count = data.readBigUInt64LE(0);
  if (8n + count * 40n > BigInt(data.length)) {
    throw new Error('Malformed SlotHashes sysvar: unexpected account data length');
  }
  const slots = [];
  for (let i = 0; i < Number(count); i++) slots.push(data.readBigUInt64LE(8 + i * 40));
  return slots;
}

/**
 * Whether the runtime still resolves addresses through a table, mirroring its
 * LookupTableMeta status rule. Deactivating a table doesn't disable it at
 * once: it stays usable while its deactivation slot is the current slot or is
 * still in SlotHashes, and only then becomes deactivated.
 *
 * A deactivation slot past `currentSlot` also counts as usable. Our two RPC
 * reads can come from nodes at different heights, and a slot we haven't seen
 * yet can't have left SlotHashes.
 */
export function isLookupTableUsable(deactivationSlot, currentSlot, slotHashes) {
  if (deactivationSlot === null) return true;
  if (deactivationSlot >= currentSlot) return true;
  return slotHashes.includes(deactivationSlot);
}
