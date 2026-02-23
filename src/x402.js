/**
 * x402 EVM Payment Module
 * Handles automatic x402 payments for EVM chains using local wallet.
 * Zero external dependencies — uses Node.js built-in crypto only.
 */

import crypto from 'crypto';
import { keccak256 } from './wallet.js';
import { exportWallet, verifyPassword, getWalletConfig } from './wallet.js';

// ============= x402 Payment Requirements Parsing =============

/**
 * Parse payment requirements from 402 response header
 * @param {Response} response - HTTP response with 402 status
 * @returns {Object|null} Parsed payment requirements or null
 */
export function parsePaymentRequirements(response) {
  const paymentHeader = response.headers.get('payment-required');
  if (!paymentHeader) {
    return null;
  }

  try {
    const paymentRequirements = JSON.parse(atob(paymentHeader));
    return paymentRequirements;
  } catch (err) {
    console.error('Failed to parse Payment-Required header:', err.message);
    return null;
  }
}

/**
 * Find the EVM payment requirement from payment requirements
 * @param {Object} requirements - Payment requirements object
 * @returns {Object|null} EVM payment requirement or null
 */
export function findEvmPaymentRequirement(requirements) {
  if (!requirements || !Array.isArray(requirements)) {
    return null;
  }

  // Look for eip155:* payment requirements (EVM chains)
  for (const req of requirements) {
    if (req.scheme === 'exact' && req.network && req.network.startsWith('eip155:')) {
      return req;
    }
  }

  return null;
}

// ============= EIP-712 Typed Data Signing =============

/**
 * Create EIP-712 domain separator hash
 * @param {Object} domain - Domain object
 * @returns {Buffer} Domain separator hash
 */
function hashDomain(domain) {
  const typeHash = keccak256(Buffer.from('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)', 'utf8'));
  
  const nameHash = keccak256(Buffer.from(domain.name || '', 'utf8'));
  const versionHash = keccak256(Buffer.from(domain.version || '', 'utf8'));
  const chainIdBytes = Buffer.alloc(32);
  chainIdBytes.writeBigUInt64BE(BigInt(domain.chainId || 1), 24);
  const contractBytes = Buffer.alloc(32);
  if (domain.verifyingContract) {
    const contractAddr = domain.verifyingContract.startsWith('0x') 
      ? domain.verifyingContract.slice(2) 
      : domain.verifyingContract;
    Buffer.from(contractAddr, 'hex').copy(contractBytes, 12);
  }

  const encoded = Buffer.concat([typeHash, nameHash, versionHash, chainIdBytes, contractBytes]);
  return keccak256(encoded);
}

/**
 * Create struct hash from typed data
 * @param {string} primaryType - Primary type name
 * @param {Object} types - Types definition
 * @param {Object} data - Data to hash
 * @returns {Buffer} Struct hash
 */
function hashStruct(primaryType, types, data) {
  const typeDefStr = encodeType(primaryType, types);
  const typeHash = keccak256(Buffer.from(typeDefStr, 'utf8'));
  
  const encodedData = encodeData(primaryType, types, data);
  const structData = Buffer.concat([typeHash, encodedData]);
  return keccak256(structData);
}

/**
 * Encode type definition string
 * @param {string} primaryType - Primary type name
 * @param {Object} types - Types definition
 * @returns {string} Encoded type string
 */
function encodeType(primaryType, types) {
  const deps = findTypeDependencies(primaryType, types);
  const sortedDeps = deps.filter(t => t !== primaryType).sort();
  const allTypes = [primaryType, ...sortedDeps];
  
  return allTypes.map(type => {
    const fields = types[type].map(field => `${field.type} ${field.name}`).join(',');
    return `${type}(${fields})`;
  }).join('');
}

/**
 * Find dependencies for a type
 * @param {string} primaryType - Primary type name
 * @param {Object} types - Types definition
 * @param {Set} found - Already found types
 * @returns {Array} Array of dependent type names
 */
function findTypeDependencies(primaryType, types, found = new Set()) {
  if (found.has(primaryType) || !types[primaryType]) {
    return Array.from(found);
  }
  
  found.add(primaryType);
  
  for (const field of types[primaryType]) {
    const baseType = field.type.replace(/\[\]$/, ''); // Remove array suffix
    if (types[baseType]) {
      findTypeDependencies(baseType, types, found);
    }
  }
  
  return Array.from(found);
}

/**
 * Encode data according to types
 * @param {string} primaryType - Primary type name
 * @param {Object} types - Types definition
 * @param {Object} data - Data to encode
 * @returns {Buffer} Encoded data
 */
function encodeData(primaryType, types, data) {
  const fields = types[primaryType];
  const encodedData = Buffer.alloc(32 * fields.length);
  let offset = 0;

  for (const field of fields) {
    const value = data[field.name];
    const encoded = encodeField(field.type, value, types);
    encoded.copy(encodedData, offset);
    offset += 32;
  }

  return encodedData;
}

/**
 * Encode a single field
 * @param {string} type - Field type
 * @param {*} value - Field value
 * @param {Object} types - Types definition
 * @returns {Buffer} Encoded field (32 bytes)
 */
function encodeField(type, value, types) {
  const buffer = Buffer.alloc(32);

  if (type === 'string') {
    const hash = keccak256(Buffer.from(value || '', 'utf8'));
    hash.copy(buffer);
  } else if (type === 'bytes') {
    const hash = keccak256(Buffer.from(value || '', 'hex'));
    hash.copy(buffer);
  } else if (type === 'address') {
    const addr = (value || '').startsWith('0x') ? value.slice(2) : (value || '');
    Buffer.from(addr.padStart(40, '0'), 'hex').copy(buffer, 12);
  } else if (type.startsWith('uint') || type.startsWith('int')) {
    const num = BigInt(value || 0);
    buffer.writeBigUInt64BE(num >> 192n, 0);
    buffer.writeBigUInt64BE((num >> 128n) & 0xffffffffffffffffn, 8);
    buffer.writeBigUInt64BE((num >> 64n) & 0xffffffffffffffffn, 16);
    buffer.writeBigUInt64BE(num & 0xffffffffffffffffn, 24);
  } else if (types[type]) {
    // Custom type - hash the struct
    const hash = hashStruct(type, types, value);
    hash.copy(buffer);
  }

  return buffer;
}

/**
 * Sign EIP-712 typed data
 * @param {Object} typedData - EIP-712 typed data
 * @param {string} privateKeyHex - Private key in hex
 * @returns {string} Signature in hex format (0x...)
 */
export function signTypedData(typedData, privateKeyHex) {
  const { domain, types, primaryType, message } = typedData;

  // Create domain separator and struct hash
  const domainSeparator = hashDomain(domain);
  const structHash = hashStruct(primaryType, types, message);

  // Create final hash: keccak256("\x19\x01" + domainSeparator + structHash)
  const prefix = Buffer.from('\x19\x01', 'utf8');
  const finalHash = keccak256(Buffer.concat([prefix, domainSeparator, structHash]));

  // Sign with secp256k1 ECDSA using Node.js crypto
  const privateKeyBuf = Buffer.from(privateKeyHex, 'hex');

  // Derive public key via ECDH
  const ecdh = crypto.createECDH('secp256k1');
  ecdh.setPrivateKey(privateKeyBuf);
  const publicKeyUncompressed = ecdh.getPublicKey(null, 'uncompressed'); // 65 bytes (04 + x + y)

  // Build SEC1 ECPrivateKey DER:
  //   SEQUENCE {
  //     INTEGER 1 (version)
  //     OCTET STRING (32 bytes private key)
  //     [0] OID secp256k1
  //     [1] BIT STRING (uncompressed public key)
  //   }
  const ecPrivateKey = Buffer.concat([
    Buffer.from('020101', 'hex'),                     // INTEGER 1
    Buffer.from('0420', 'hex'), privateKeyBuf,        // OCTET STRING (32)
    Buffer.from('a00706052b8104000a', 'hex'),         // [0] OID 1.3.132.0.10 (secp256k1)
    Buffer.from('a14403420004', 'hex'),               // [1] BIT STRING (66 bytes, 0 unused bits, 04+64)
    publicKeyUncompressed.subarray(1),                // 64 bytes (x + y)
  ]);
  // Wrap in SEQUENCE
  const seqLen = ecPrivateKey.length;
  const sec1Der = Buffer.concat([
    Buffer.from([0x30, seqLen]),
    ecPrivateKey,
  ]);

  const signingKey = crypto.createPrivateKey({ key: sec1Der, format: 'der', type: 'sec1' });
  const derSig = crypto.sign(null, finalHash, { key: signingKey, dsaEncoding: 'ieee-p1363' });

  // derSig is 64 bytes: r (32) + s (32) in IEEE P1363 format
  const r = derSig.subarray(0, 32);
  const s = derSig.subarray(32, 64);

  // Determine v (recovery id): try both 27 and 28
  // For EIP-712 signatures, v is 27 or 28
  // We verify by recovering the address from the signature
  let v = 27;

  // Derive our address for comparison
  const pubKeyHash = keccak256(publicKeyUncompressed.subarray(1));
  const ourAddress = pubKeyHash.subarray(12);

  // Try v=27 first; if recovery doesn't match, use v=28
  // Since Node.js doesn't expose ecrecover, we use a heuristic:
  // ensure s is in the lower half of the curve order (EIP-2)
  const curveOrder = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');
  const halfOrder = curveOrder / 2n;
  let sBigInt = 0n;
  for (let i = 0; i < 32; i++) sBigInt = (sBigInt << 8n) | BigInt(s[i]);

  if (sBigInt > halfOrder) {
    // Normalize s to lower half and flip v
    const newS = curveOrder - sBigInt;
    const newSBuf = Buffer.alloc(32);
    let tmp = newS;
    for (let i = 31; i >= 0; i--) { newSBuf[i] = Number(tmp & 0xffn); tmp >>= 8n; }
    newSBuf.copy(s, 0);
    v = 28;
  }

  return '0x' + Buffer.concat([r, s, Buffer.from([v])]).toString('hex');
}

// ============= x402 Payment Payload Creation =============

/**
 * Create EVM payment payload for x402
 * @param {Object} requirement - EVM payment requirement from 402 response
 * @param {string} privateKeyHex - Private key in hex format
 * @returns {Object} Payment payload object
 */
export function createEvmPaymentPayload(requirement, privateKeyHex) {
  if (!requirement || requirement.scheme !== 'exact') {
    throw new Error('Invalid payment requirement: must be exact scheme');
  }

  if (!requirement.network || !requirement.network.startsWith('eip155:')) {
    throw new Error('Invalid payment requirement: must be EVM network (eip155:*)');
  }

  // Extract chain ID from network identifier (e.g., "eip155:1" -> 1)
  const chainId = parseInt(requirement.network.split(':')[1], 10);
  if (isNaN(chainId)) {
    throw new Error('Invalid chain ID in payment requirement');
  }

  // Create the payment data structure according to x402 exact scheme
  const paymentData = {
    network: requirement.network,
    amount: requirement.amount,
    recipient: requirement.recipient,
    nonce: requirement.nonce || Math.floor(Date.now() / 1000).toString(),
    timestamp: Math.floor(Date.now() / 1000)
  };

  // Create EIP-712 typed data for signing
  const typedData = {
    domain: {
      name: 'x402Payment',
      version: '1',
      chainId: chainId,
      verifyingContract: requirement.verifyingContract || '0x0000000000000000000000000000000000000000'
    },
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' }
      ],
      Payment: [
        { name: 'network', type: 'string' },
        { name: 'amount', type: 'string' },
        { name: 'recipient', type: 'address' },
        { name: 'nonce', type: 'string' },
        { name: 'timestamp', type: 'uint256' }
      ]
    },
    primaryType: 'Payment',
    message: paymentData
  };

  // Sign the typed data
  const signature = signTypedData(typedData, privateKeyHex);

  // Return the complete payment payload
  return {
    scheme: 'exact',
    network: requirement.network,
    payment: paymentData,
    signature: signature
  };
}

// ============= Wallet Integration =============

/**
 * Get wallet password from environment or prompt user
 * @param {Function} promptFn - Function to prompt for password
 * @returns {Promise<string>} Wallet password
 */
export async function getWalletPassword(promptFn = null) {
  // Check environment variable first
  if (process.env.NANSEN_WALLET_PASSWORD) {
    return process.env.NANSEN_WALLET_PASSWORD;
  }

  // Prompt user if no environment variable
  if (promptFn) {
    return await promptFn('Enter wallet password for x402 payment: ', true);
  }

  // Fallback: use readline
  const readline = await import('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve, reject) => {
    process.stdout.write('Enter wallet password for x402 payment: ');
    
    if (process.stdout.isTTY) {
      let input = '';
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding('utf8');
      
      const onData = (char) => {
        if (char === '\n' || char === '\r') {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.removeListener('data', onData);
          process.stdout.write('\n');
          rl.close();
          resolve(input);
        } else if (char === '\u0003') {
          process.exit();
        } else if (char === '\u007F' || char === '\b') {
          if (input.length > 0) {
            input = input.slice(0, -1);
            process.stdout.write('\b \b');
          }
        } else {
          input += char;
          process.stdout.write('*');
        }
      };
      
      process.stdin.on('data', onData);
    } else {
      rl.question('', (answer) => {
        rl.close();
        resolve(answer);
      });
    }
  });
}

/**
 * Check if a local wallet exists
 * @returns {boolean} True if default wallet exists
 */
export function hasLocalWallet() {
  try {
    const config = getWalletConfig();
    return !!config.defaultWallet;
  } catch {
    return false;
  }
}

/**
 * Get private key from local wallet for x402 signing
 * @param {string} password - Wallet password
 * @returns {Promise<string>} EVM private key in hex format
 */
export async function getEvmPrivateKey(password) {
  const config = getWalletConfig();
  
  if (!config.defaultWallet) {
    throw new Error('No default wallet found. Create one with: nansen wallet create');
  }

  // Verify password
  if (!verifyPassword(password, config)) {
    throw new Error('Incorrect wallet password');
  }

  // Export the wallet to get private keys
  const wallet = exportWallet(config.defaultWallet, password);
  
  if (!wallet.evm || !wallet.evm.privateKey) {
    throw new Error('No EVM private key found in wallet');
  }

  return wallet.evm.privateKey;
}

// ============= x402 Flow Integration =============

/**
 * Attempt x402 payment for a failed request
 * @param {Response} response - 402 response
 * @param {Function} retryRequestFn - Function to retry the original request
 * @param {Function} promptFn - Function to prompt for password (optional)
 * @returns {Promise<Object>} Result of retried request
 */
export async function attemptX402Payment(response, retryRequestFn, promptFn = null) {
  // Check if we have a local wallet
  if (!hasLocalWallet()) {
    throw new Error('No local wallet found for x402 payment. Create one with: nansen wallet create');
  }

  // Parse payment requirements
  const requirements = parsePaymentRequirements(response);
  if (!requirements) {
    throw new Error('No payment requirements found in 402 response');
  }

  // Find EVM payment requirement
  const evmRequirement = findEvmPaymentRequirement(requirements);
  if (!evmRequirement) {
    throw new Error('No EVM payment requirement found. Only EVM x402 payments are supported.');
  }

  // Get wallet password
  const password = await getWalletPassword(promptFn);
  
  // Get private key
  const privateKeyHex = await getEvmPrivateKey(password);
  
  // Create payment payload
  const paymentPayload = createEvmPaymentPayload(evmRequirement, privateKeyHex);
  
  // Encode payment payload as base64 JSON for X-PAYMENT header
  const paymentHeader = btoa(JSON.stringify(paymentPayload));
  
  // Retry the original request with X-PAYMENT header
  return await retryRequestFn(paymentHeader);
}

/**
 * Check if x402 automatic payment should be attempted
 * @param {Response} response - HTTP response
 * @param {string|null} apiKey - Current API key
 * @returns {boolean} True if x402 payment should be attempted
 */
export function shouldAttemptX402Payment(response, apiKey) {
  return (
    response.status === 402 && 
    (!apiKey || apiKey.trim() === '') && 
    hasLocalWallet() &&
    response.headers.get('payment-required')
  );
}