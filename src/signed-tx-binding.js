/**
 * Nansen CLI - Signed-transaction binding for remote signers.
 *
 * Privy and WalletConnect sign transactions outside this process. Every
 * pre-sign check (target, intent binding, value, fee cap, simulation) runs on
 * the transaction the CLI sent for signing, so the bytes a remote signer hands
 * back must encode exactly that transaction before anything is broadcast.
 * These checks compare the returned bytes with what was sent and confirm the
 * expected wallet produced the signature. Any difference throws
 * SIGNED_TX_MISMATCH.
 */

import { RLP } from '@ethereumjs/rlp';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { CommandError } from './api.js';
import { keccak256, bigIntToMinBuf } from './crypto.js';
import { readCompactU16, parseTransactionMessage } from './solana-tx.js';
import { base58Decode } from './wallet.js';

const DEFAULT_NOTE = 'Nothing was broadcast.';

function mismatch(label, detail, note = DEFAULT_NOTE) {
  return new CommandError(
    `Refusing to broadcast the ${label}: the signer returned a transaction that does not match the one this CLI checked (${detail}). ${note}`,
    'SIGNED_TX_MISMATCH',
  );
}

// ============= Solana =============

function splitSolanaTx(bytes) {
  const { value: sigCount, size } = readCompactU16(bytes, 0);
  const messageStart = size + sigCount * 64;
  if (bytes.length <= messageStart) throw new Error('transaction is too short');
  return { sigCount, sigStart: size, message: bytes.subarray(messageStart) };
}

// A malformed key or signature makes verify throw; treat it as not signed.
function verifyEd25519(signature, message, signer) {
  try {
    return ed25519.verify(signature, message, base58Decode(signer));
  } catch {
    return false;
  }
}

/**
 * Assert a signed Solana transaction carries exactly the message of the
 * unsigned transaction it was produced from, signed by `signer`.
 *
 * Only the signer's own slot is checked: other required signers (an x402
 * facilitator paying the fee, for example) may still be unsigned.
 *
 * @param {string} unsignedTxBase64 - the transaction sent to the signer
 * @param {string} signedTxBase64 - the transaction the signer returned
 * @param {object} opts
 * @param {string} opts.signer - base58 public key that must have signed
 * @param {string} [opts.label] - what the transaction is, for the error
 * @param {string} [opts.note] - sentence appended to the error
 */
export function assertSolanaSignedMatches(unsignedTxBase64, signedTxBase64, { signer, label = 'Solana transaction', note } = {}) {
  if (!signer) throw new Error(`assertSolanaSignedMatches: the expected signer of the ${label} is required`);
  if (typeof signedTxBase64 !== 'string' || signedTxBase64.length === 0) {
    throw mismatch(label, 'no signed transaction', note);
  }

  const parsed = parseTransactionMessage(unsignedTxBase64);
  const unsigned = splitSolanaTx(Buffer.from(unsignedTxBase64, 'base64'));
  let signed;
  try {
    signed = splitSolanaTx(Buffer.from(signedTxBase64, 'base64'));
  } catch (err) {
    throw mismatch(label, `the returned bytes do not parse: ${err.message}`, note);
  }

  if (signed.sigCount !== unsigned.sigCount) {
    throw mismatch(label, `signature count ${signed.sigCount}, expected ${unsigned.sigCount}`, note);
  }
  if (!signed.message.equals(unsigned.message)) {
    throw mismatch(label, 'the message bytes differ', note);
  }

  const index = parsed.staticAccountKeys.indexOf(signer);
  if (index < 0 || index >= parsed.header.numRequiredSignatures || index >= signed.sigCount) {
    throw mismatch(label, `${signer} is not a required signer of the transaction`, note);
  }

  const signedBytes = Buffer.from(signedTxBase64, 'base64');
  const sigOffset = signed.sigStart + index * 64;
  const signature = signedBytes.subarray(sigOffset, sigOffset + 64);
  if (!verifyEd25519(signature, signed.message, signer)) {
    throw mismatch(label, `no valid signature from ${signer}`, note);
  }
}

// ============= EVM =============

const TX_TYPE_LEGACY = 0;
const TX_TYPE_ACCESS_LIST = 1;
const TX_TYPE_EIP1559 = 2;

function toHex(bytes) {
  return '0x' + Buffer.from(bytes).toString('hex');
}

function asBytes(field, name) {
  if (!(field instanceof Uint8Array)) throw new Error(`${name} is not a byte string`);
  return field;
}

// RLP integers are minimal big-endian: a leading zero byte is non-canonical.
function asUint(field, name) {
  const bytes = asBytes(field, name);
  if (bytes.length > 0 && bytes[0] === 0) throw new Error(`${name} has a leading zero`);
  return bytes.length === 0 ? 0n : BigInt(toHex(bytes));
}

function asAddress(field, name) {
  const bytes = asBytes(field, name);
  if (bytes.length !== 20) throw new Error(`${name} is not a 20-byte address`);
  return toHex(bytes);
}

function asAccessList(field) {
  if (!Array.isArray(field)) throw new Error('accessList is not a list');
  return field;
}

function recoverSender(payload, yParity, r, s) {
  if (yParity !== 0n && yParity !== 1n) throw new Error(`invalid signature recovery bit ${yParity}`);
  const sig = new secp256k1.Signature(r, s).addRecoveryBit(Number(yParity));
  const pub = sig.recoverPublicKey(keccak256(payload)).toBytes(false);
  return toHex(keccak256(Buffer.from(pub).subarray(1)).subarray(12));
}

/**
 * Decode a signed EVM transaction and recover its sender.
 *
 * Accepts legacy transactions with EIP-155 replay protection, type 1 and
 * type 2. Pre-EIP-155 legacy transactions (no chain id) and every other
 * type, including EIP-7702 set-code transactions, are refused.
 *
 * @param {string} signedTxHex - 0x-prefixed hex of the signed transaction
 * @returns {{ type, chainId, nonce, gasLimit, gasPrice?, maxFeePerGas?, maxPriorityFeePerGas?, to, value, data, accessList, from }}
 */
export function decodeSignedEvmTransaction(signedTxHex) {
  if (typeof signedTxHex !== 'string' || !/^0x([0-9a-fA-F]{2})+$/.test(signedTxHex)) {
    throw new Error('signed transaction is not 0x-prefixed hex');
  }
  const raw = Buffer.from(signedTxHex.slice(2), 'hex');
  const first = raw[0];

  if (first >= 0xc0) {
    const fields = RLP.decode(raw);
    if (!Array.isArray(fields) || fields.length !== 9) throw new Error('legacy transaction must have 9 fields');
    const [nonce, gasPrice, gasLimit, to, value, data, v, r, s] = fields;
    const vNum = asUint(v, 'v');
    if (vNum < 35n) throw new Error('legacy transaction has no EIP-155 chain id');
    const chainId = (vNum - 35n) / 2n;
    const yParity = (vNum - 35n) % 2n;
    // EIP-155 signing payload: the six fields, then chainId, 0, 0.
    const payload = Buffer.from(RLP.encode([...fields.slice(0, 6), bigIntToMinBuf(chainId), new Uint8Array(), new Uint8Array()]));
    return {
      type: TX_TYPE_LEGACY,
      chainId,
      nonce: asUint(nonce, 'nonce'),
      gasPrice: asUint(gasPrice, 'gasPrice'),
      gasLimit: asUint(gasLimit, 'gasLimit'),
      to: asAddress(to, 'to'),
      value: asUint(value, 'value'),
      data: toHex(asBytes(data, 'data')),
      accessList: [],
      from: recoverSender(payload, yParity, asUint(r, 'r'), asUint(s, 's')),
    };
  }

  if (first === TX_TYPE_ACCESS_LIST || first === TX_TYPE_EIP1559) {
    const fields = RLP.decode(raw.subarray(1));
    const isEip1559 = first === TX_TYPE_EIP1559;
    const expectedLength = isEip1559 ? 12 : 11;
    if (!Array.isArray(fields) || fields.length !== expectedLength) {
      throw new Error(`type ${first} transaction must have ${expectedLength} fields`);
    }
    const unsignedCount = expectedLength - 3;
    const payload = Buffer.concat([Buffer.from([first]), Buffer.from(RLP.encode(fields.slice(0, unsignedCount)))]);
    const [yParity, r, s] = fields.slice(unsignedCount);
    const tx = isEip1559
      ? (() => {
        const [chainId, nonce, prio, maxFee, gasLimit, to, value, data, accessList] = fields;
        return {
          type: TX_TYPE_EIP1559,
          chainId: asUint(chainId, 'chainId'),
          nonce: asUint(nonce, 'nonce'),
          maxPriorityFeePerGas: asUint(prio, 'maxPriorityFeePerGas'),
          maxFeePerGas: asUint(maxFee, 'maxFeePerGas'),
          gasLimit: asUint(gasLimit, 'gasLimit'),
          to: asAddress(to, 'to'),
          value: asUint(value, 'value'),
          data: toHex(asBytes(data, 'data')),
          accessList: asAccessList(accessList),
        };
      })()
      : (() => {
        const [chainId, nonce, gasPrice, gasLimit, to, value, data, accessList] = fields;
        return {
          type: TX_TYPE_ACCESS_LIST,
          chainId: asUint(chainId, 'chainId'),
          nonce: asUint(nonce, 'nonce'),
          gasPrice: asUint(gasPrice, 'gasPrice'),
          gasLimit: asUint(gasLimit, 'gasLimit'),
          to: asAddress(to, 'to'),
          value: asUint(value, 'value'),
          data: toHex(asBytes(data, 'data')),
          accessList: asAccessList(accessList),
        };
      })();
    tx.from = recoverSender(payload, asUint(yParity, 'yParity'), asUint(r, 'r'), asUint(s, 's'));
    return tx;
  }

  throw new Error(`unsupported transaction type 0x${first.toString(16).padStart(2, '0')}`);
}

const UINT_FIELDS = ['chainId', 'nonce', 'gasLimit', 'value', 'maxFeePerGas', 'maxPriorityFeePerGas', 'gasPrice'];

function normalizeData(data) {
  const hex = (data === undefined || data === null || data === '') ? '0x' : String(data);
  return hex.toLowerCase();
}

/**
 * Assert a signed EVM transaction is the one that was sent for signing,
 * signed by `from`.
 *
 * `to`, `value`, `data` and `chainId` are always compared. Every other field
 * present in `expected` (nonce, gasLimit, maxFeePerGas, maxPriorityFeePerGas,
 * gasPrice, type) is compared too; leave out the ones the signer is allowed
 * to choose. `accessList: []` requires an empty access list.
 *
 * @param {string} signedTxHex - the transaction the signer returned
 * @param {object} expected - the fields sent for signing (hex, decimal string, number or bigint)
 * @param {object} opts
 * @param {string} opts.from - the wallet address that must have signed
 * @param {string} [opts.label] - what the transaction is, for the error
 * @param {string} [opts.note] - sentence appended to the error
 * @returns {object} the decoded transaction
 */
export function assertEvmSignedMatches(signedTxHex, expected, { from, label = 'EVM transaction', note } = {}) {
  if (!from) throw new Error(`assertEvmSignedMatches: the expected signer of the ${label} is required`);
  for (const key of ['chainId', 'to', 'value']) {
    if (expected?.[key] === undefined || expected?.[key] === null) {
      throw new Error(`assertEvmSignedMatches: expected.${key} is required`);
    }
  }

  let tx;
  try {
    tx = decodeSignedEvmTransaction(signedTxHex);
  } catch (err) {
    throw mismatch(label, `the returned bytes do not decode: ${err.message}`, note);
  }

  if (tx.from !== String(from).toLowerCase()) {
    throw mismatch(label, `signed by ${tx.from}, expected ${from}`, note);
  }
  if (tx.to !== String(expected.to).toLowerCase()) {
    throw mismatch(label, `to is ${tx.to}, expected ${expected.to}`, note);
  }
  if (tx.data !== normalizeData(expected.data)) {
    throw mismatch(label, 'data differs', note);
  }
  for (const key of UINT_FIELDS) {
    if (expected[key] === undefined) continue;
    const want = BigInt(expected[key]);
    if (tx[key] !== want) {
      throw mismatch(label, `${key} is ${tx[key] ?? 'absent'}, expected ${want}`, note);
    }
  }
  if (expected.type !== undefined && tx.type !== expected.type) {
    throw mismatch(label, `type is ${tx.type}, expected ${expected.type}`, note);
  }
  if (Array.isArray(expected.accessList) && expected.accessList.length === 0 && tx.accessList.length !== 0) {
    throw mismatch(label, 'it carries an access list', note);
  }
  return tx;
}
