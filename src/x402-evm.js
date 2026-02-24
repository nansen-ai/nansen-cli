/**
 * Nansen CLI - x402 EVM Auto-Payment
 * Implements EIP-3009 TransferWithAuthorization via EIP-712 typed data signing.
 * Zero external dependencies — uses Node.js built-in crypto + wallet.js keccak256.
 */

import crypto from 'crypto';
import { keccak256, signSecp256k1 } from './crypto.js';

// ============= EIP-712 Type Hashing =============

const DOMAIN_TYPES = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
];

const AUTHORIZATION_TYPES = [
  { name: 'from', type: 'address' },
  { name: 'to', type: 'address' },
  { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' },
  { name: 'validBefore', type: 'uint256' },
  { name: 'nonce', type: 'bytes32' },
];

/**
 * Encode a type string for EIP-712 typeHash.
 * e.g. "TransferWithAuthorization(address from,address to,uint256 value,...)"
 */
function encodeType(typeName, fields) {
  const fieldStrs = fields.map(f => `${f.type} ${f.name}`);
  return `${typeName}(${fieldStrs.join(',')})`;
}

/**
 * Compute typeHash = keccak256(encodeType(...))
 */
function typeHash(typeName, fields) {
  return keccak256(Buffer.from(encodeType(typeName, fields), 'utf8'));
}

/**
 * ABI-encode a single value to 32 bytes based on its EIP-712 type.
 */
function encodeValue(fieldType, value) {
  if (fieldType === 'string') {
    // Strings are hashed
    return keccak256(Buffer.from(value, 'utf8'));
  }
  if (fieldType === 'bytes') {
    const buf = typeof value === 'string' ? Buffer.from(value.replace(/^0x/, ''), 'hex') : value;
    return keccak256(buf);
  }
  if (fieldType === 'bytes32') {
    if (typeof value === 'string') {
      return Buffer.from(value.replace(/^0x/, ''), 'hex');
    }
    return value;
  }
  if (fieldType === 'address') {
    // Left-pad address to 32 bytes
    const addr = value.replace(/^0x/, '').toLowerCase();
    return Buffer.from(addr.padStart(64, '0'), 'hex');
  }
  if (fieldType.startsWith('uint') || fieldType.startsWith('int')) {
    // Encode as 32-byte big-endian
    const hex = BigInt(value).toString(16).padStart(64, '0');
    return Buffer.from(hex, 'hex');
  }
  if (fieldType === 'bool') {
    return Buffer.from((value ? '1' : '0').padStart(64, '0'), 'hex');
  }
  throw new Error(`Unsupported EIP-712 field type: ${fieldType}`);
}

/**
 * Compute struct hash = keccak256(typeHash || encodeValue(field1) || encodeValue(field2) || ...)
 */
function hashStruct(typeName, fields, data) {
  const parts = [typeHash(typeName, fields)];
  for (const field of fields) {
    const value = data[field.name];
    if (value === undefined || value === null) {
      throw new Error(`Missing EIP-712 field: ${field.name}`);
    }
    parts.push(encodeValue(field.type, value));
  }
  return keccak256(Buffer.concat(parts));
}

/**
 * Compute EIP-712 domain separator hash.
 */
function hashDomain(domain) {
  return hashStruct('EIP712Domain', DOMAIN_TYPES, domain);
}

/**
 * Compute EIP-712 final hash: keccak256("\x19\x01" || domainSeparator || structHash)
 */
export function hashTypedData(domain, primaryType, fields, message) {
  const domainSeparator = hashDomain(domain);
  const structHash = hashStruct(primaryType, fields, message);
  return keccak256(Buffer.concat([
    Buffer.from([0x19, 0x01]),
    domainSeparator,
    structHash,
  ]));
}

// ============= x402 EVM Payment =============

/**
 * Extract chain ID from CAIP-2 network identifier.
 * e.g. "eip155:8453" → 8453
 */
function getChainId(network) {
  const match = network.match(/^eip155:(\d+)$/);
  if (!match) throw new Error(`Invalid EVM network: ${network}`);
  return parseInt(match[1], 10);
}

/**
 * Create an x402 payment payload for EVM (EIP-3009 TransferWithAuthorization).
 *
 * @param {object} requirements - Parsed PaymentRequirements from 402 response
 * @param {string} privateKeyHex - 32-byte EVM private key as hex
 * @param {string} walletAddress - Signer's EVM address
 * @param {string} resource - Original request URL
 * @returns {string} Base64-encoded PaymentPayload for Payment-Signature header
 */
export function createEvmPaymentPayload(requirements, privateKeyHex, walletAddress, resource) {
  const chainId = getChainId(requirements.network);
  const extra = requirements.extra || {};

  // Token name and version from requirements.extra (set by server/facilitator)
  const tokenName = extra.name;
  const tokenVersion = extra.version || '1';

  if (!tokenName) {
    throw new Error('EIP-712 domain name missing from requirements.extra');
  }

  // Generate random nonce (32 bytes)
  const nonce = '0x' + crypto.randomBytes(32).toString('hex');

  // Validity window: valid now, expires in 1 hour
  const now = Math.floor(Date.now() / 1000);
  const validAfter = '0';
  const validBefore = String(now + 3600);

  // EIP-712 domain
  const domain = {
    name: tokenName,
    version: tokenVersion,
    chainId,
    verifyingContract: requirements.asset,
  };

  // EIP-3009 message
  const message = {
    from: walletAddress,
    to: requirements.pay_to || requirements.payTo,
    value: BigInt(requirements.amount),
    validAfter: BigInt(validAfter),
    validBefore: BigInt(validBefore),
    nonce: nonce,
  };

  // Hash and sign
  const msgHash = hashTypedData(domain, 'TransferWithAuthorization', AUTHORIZATION_TYPES, message);
  const { r, s, v } = signSecp256k1(msgHash, Buffer.from(privateKeyHex, 'hex'));
  const signature = '0x' + r.toString('hex') + s.toString('hex') + (27 + v).toString(16);

  // Build payload (camelCase keys per x402 spec)
  const payload = {
    x402Version: 2,
    payload: {
      authorization: {
        from: walletAddress,
        to: message.to,
        value: String(requirements.amount),
        validAfter: validAfter,
        validBefore: validBefore,
        nonce: nonce,
      },
      signature: signature,
    },
    accepted: requirements,
  };

  // Add resource as object if provided
  if (resource) {
    payload.resource = { url: resource };
  }

  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

/**
 * Check if a network string is an EVM network.
 */
export function isEvmNetwork(network) {
  return typeof network === 'string' && network.startsWith('eip155:');
}
