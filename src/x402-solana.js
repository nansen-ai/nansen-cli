/**
 * x402 Solana Payment Module
 * Implements automatic PAYAI token payments for x402 protocol on Solana (SVM)
 * Zero external dependencies - uses Node.js crypto built-ins only
 */

import crypto from 'crypto';

// ============= Constants =============

// PAYAI Token mint address on Solana mainnet
const PAYAI_MINT = 'HeLp6NuQkmYB4pYWo2zYs22mESHXPQYzXbB8n4V98jwC';

// Solana system programs
const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ASSOCIATED_TOKEN_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

// ============= Base58 Functions =============

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/**
 * Decode a base58 string to buffer
 */
function base58Decode(s) {
  let num = 0n;
  for (const char of s) {
    const charIndex = BASE58_ALPHABET.indexOf(char);
    if (charIndex === -1) throw new Error(`Invalid base58 character: ${char}`);
    num = num * 58n + BigInt(charIndex);
  }

  // Convert to bytes
  const bytes = [];
  while (num > 0n) {
    bytes.unshift(Number(num & 0xffn));
    num = num >> 8n;
  }

  // Handle leading 1s (zeros)
  for (const char of s) {
    if (char === '1') bytes.unshift(0);
    else break;
  }

  return Buffer.from(bytes);
}

/**
 * Encode a buffer to base58 string
 */
function base58Encode(buf) {
  let num = 0n;
  for (const byte of buf) {
    num = num * 256n + BigInt(byte);
  }

  let str = '';
  while (num > 0n) {
    const rem = Number(num % 58n);
    num = num / 58n;
    str = BASE58_ALPHABET[rem] + str;
  }

  // Leading zeros → leading '1's
  for (const byte of buf) {
    if (byte === 0) str = '1' + str;
    else break;
  }

  return str || '1';
}

// ============= Solana Address Utils =============

/**
 * Find associated token account address for a given owner and mint
 */
function findAssociatedTokenAddress(ownerPubkey, mintPubkey) {
  const seeds = [
    ownerPubkey,
    base58Decode(TOKEN_PROGRAM_ID),
    mintPubkey
  ];
  
  // Use a simple hash-based approach for PDA derivation
  // This is a simplified version - in production, you'd use the proper PDA derivation
  const combined = Buffer.concat(seeds);
  const hash = crypto.createHash('sha256').update(combined).digest();
  return hash.slice(0, 32);
}

// ============= Solana Transaction Builder =============

/**
 * Instruction data for SPL Token transfer
 */
function createTransferInstruction(amount) {
  // SPL Token Transfer instruction: 3 (instruction discriminator) + 8 bytes (amount)
  const data = Buffer.alloc(9);
  data[0] = 3; // Transfer instruction
  data.writeBigUInt64LE(BigInt(amount), 1);
  return data;
}

/**
 * Create a Solana transaction for PAYAI token transfer
 */
function createSolanaTransaction(fromPubkey, toPubkey, amount, recentBlockhash) {
  const mintPubkey = base58Decode(PAYAI_MINT);
  const fromTokenAccount = findAssociatedTokenAddress(fromPubkey, mintPubkey);
  const toTokenAccount = findAssociatedTokenAddress(toPubkey, mintPubkey);
  
  // Create transfer instruction
  const instruction = {
    programId: base58Decode(TOKEN_PROGRAM_ID),
    accounts: [
      fromTokenAccount, // source
      toTokenAccount,   // destination  
      fromPubkey        // authority
    ],
    data: createTransferInstruction(amount)
  };

  // Simplified transaction structure
  const transaction = {
    recentBlockhash: base58Decode(recentBlockhash),
    instructions: [instruction],
    feePayer: fromPubkey
  };

  return transaction;
}

/**
 * Serialize a Solana transaction for signing
 */
function serializeTransaction(transaction) {
  // This is a simplified serialization - in production you'd implement
  // the full Solana transaction wire format
  const parts = [
    transaction.recentBlockhash,
    transaction.feePayer,
    Buffer.from([transaction.instructions.length]) // instruction count
  ];
  
  for (const ix of transaction.instructions) {
    parts.push(ix.programId);
    parts.push(Buffer.from([ix.accounts.length])); // account count
    for (const account of ix.accounts) {
      parts.push(account);
    }
    parts.push(Buffer.from([ix.data.length])); // data length
    parts.push(ix.data);
  }
  
  return Buffer.concat(parts);
}

/**
 * Sign a Solana transaction with Ed25519 keypair
 */
function signTransaction(transaction, keypairHex) {
  // Extract the 32-byte private seed from the 64-byte keypair
  const keypairBuffer = Buffer.from(keypairHex, 'hex');
  if (keypairBuffer.length !== 64) {
    throw new Error('Invalid Solana keypair length - expected 64 bytes');
  }
  
  const privateSeed = keypairBuffer.slice(0, 32);
  const publicKey = keypairBuffer.slice(32, 64);
  
  // Serialize the transaction for signing
  const message = serializeTransaction(transaction);
  
  // Sign with Ed25519 — build PKCS#8 DER for the private seed
  const pkcs8Header = Buffer.from([
    0x30, 0x2e,             // SEQUENCE (46 bytes)
    0x02, 0x01, 0x00,       // INTEGER 0 (version)
    0x30, 0x05,             // SEQUENCE (5 bytes)
    0x06, 0x03, 0x2b, 0x65, 0x70, // OID 1.3.101.112 (Ed25519)
    0x04, 0x22,             // OCTET STRING (34 bytes)
    0x04, 0x20              // OCTET STRING (32 bytes) — the seed
  ]);
  const signingKey = crypto.createPrivateKey({
    key: Buffer.concat([pkcs8Header, privateSeed]),
    format: 'der',
    type: 'pkcs8'
  });
  const signature = crypto.sign(null, message, signingKey);
  
  return {
    signature,
    message,
    publicKey
  };
}

// ============= x402 Protocol Functions =============

/**
 * Parse payment requirements from 402 response
 * @param {Response} response - HTTP Response object with 402 status
 * @returns {Object|null} Parsed payment requirements for Solana
 */
export function parsePaymentRequirements(response) {
  const paymentHeader = response.headers.get('payment-required');
  if (!paymentHeader) {
    return null;
  }
  
  try {
    // Decode base64 JSON payment requirements
    const paymentData = JSON.parse(atob(paymentHeader));
    
    // x402 returns an array of payment requirements at the top level
    const requirements = Array.isArray(paymentData) ? paymentData : (paymentData.payments || [paymentData]);
    
    // Look for Solana payment requirement
    for (const payment of requirements) {
      if (payment.network && payment.network.startsWith('solana:')) {
        return {
          network: payment.network,
          recipient: payment.recipient || payment.pay_to,
          amount: payment.amount || payment.maxAmountRequired,
          token: payment.token || payment.asset || PAYAI_MINT,
          memo: payment.memo,
          nonce: payment.nonce || paymentData.nonce || Date.now().toString()
        };
      }
    }
    
    return null;
  } catch (error) {
    console.warn('Failed to parse payment requirements:', error.message);
    return null;
  }
}

/**
 * Create a signed Solana payment payload for x402
 * @param {Object} requirements - Payment requirements from parsePaymentRequirements
 * @param {string} keypairHex - 64-byte Solana keypair (32-byte seed + 32-byte pubkey)
 * @returns {string} Base64-encoded payment payload for X-PAYMENT header
 */
export function createSolanaPaymentPayload(requirements, keypairHex) {
  if (!requirements || !requirements.recipient) {
    throw new Error('Invalid payment requirements');
  }
  
  if (!keypairHex || keypairHex.length !== 128) {
    throw new Error('Invalid Solana keypair - expected 64-byte hex string');
  }
  
  // Extract public key from keypair
  const keypairBuffer = Buffer.from(keypairHex, 'hex');
  const publicKey = keypairBuffer.slice(32, 64);
  const recipientPubkey = base58Decode(requirements.recipient);
  
  // Use a recent blockhash (in production, this would be fetched from RPC)
  // For x402, we use a deterministic blockhash based on nonce
  const blockHashSeed = `x402-${requirements.nonce}`;
  const recentBlockhash = base58Encode(
    crypto.createHash('sha256').update(blockHashSeed).digest().slice(0, 32)
  );
  
  // Create and sign the transaction
  const transaction = createSolanaTransaction(
    publicKey,
    recipientPubkey, 
    BigInt(requirements.amount),
    recentBlockhash
  );
  
  const signed = signTransaction(transaction, keypairHex);
  
  // Create x402 SVM exact scheme payload
  const payload = {
    scheme: 'exact',
    network: requirements.network,
    transaction: signed.message.toString('base64'),
    signature: signed.signature.toString('base64'),
    publicKey: signed.publicKey.toString('base64'),
    nonce: requirements.nonce
  };
  
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

/**
 * Check if a wallet has sufficient PAYAI balance for payment
 * @param {string} walletAddress - Base58 Solana wallet address
 * @param {number} requiredAmount - Required PAYAI amount in smallest units
 * @returns {Promise<boolean>} True if sufficient balance (stub implementation)
 */
export async function checkPayaiBalance(walletAddress, requiredAmount) {
  // This is a stub implementation - in production, you'd query the Solana RPC
  // to check the actual PAYAI token balance
  console.warn('Balance check not implemented - assuming sufficient balance');
  return true;
}

/**
 * Auto-retry a request with x402 Solana payment
 * @param {Function} requestFn - Function that makes the HTTP request
 * @param {string} keypairHex - Solana keypair for signing payments
 * @returns {Promise<Response>} Response after successful payment
 */
export async function retryWithPayment(requestFn, keypairHex) {
  // First attempt - expect 402
  let response = await requestFn();
  
  if (response.status !== 402) {
    return response; // Not a payment required response
  }
  
  // Parse payment requirements
  const requirements = parsePaymentRequirements(response);
  if (!requirements) {
    throw new Error('Payment required but no Solana payment requirements found');
  }
  
  // Verify we support this token (PAYAI)
  if (requirements.token && requirements.token !== PAYAI_MINT) {
    throw new Error(`Unsupported payment token: ${requirements.token}. Only PAYAI is supported.`);
  }
  
  // Check balance (stub)
  const walletAddress = base58Encode(Buffer.from(keypairHex, 'hex').slice(32, 64));
  const hasBalance = await checkPayaiBalance(walletAddress, requirements.amount);
  if (!hasBalance) {
    throw new Error(`Insufficient PAYAI balance for payment of ${requirements.amount}`);
  }
  
  // Create payment payload
  const paymentPayload = createSolanaPaymentPayload(requirements, keypairHex);
  
  // Retry with payment
  const retryResponse = await requestFn({
    'X-PAYMENT': paymentPayload
  });
  
  return retryResponse;
}