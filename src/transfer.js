/**
 * Nansen CLI - Token Transfer
 * Send native and ERC-20/SPL tokens on EVM and Solana chains.
 * Zero external dependencies — uses Node.js built-in crypto only.
 */

import crypto from 'crypto';
import { base58Encode, exportWallet, getWalletConfig, verifyPassword } from './wallet.js';
import { keccak256, signSecp256k1, rlpEncode, bigIntToMinBuf } from './crypto.js';

// ============= Constants =============

const DEFAULT_EVM_RPC = 'https://eth.public-rpc.com';
const DEFAULT_SOLANA_RPC = 'https://api.mainnet-beta.solana.com';

const PRIORITY_FEE_DEFAULTS = { base: 100000000n, ethereum: 1500000000n, evm: 1500000000n };

const ERC20_TRANSFER_SELECTOR = 'a9059cbb'; // transfer(address,uint256)
const SYSTEM_PROGRAM = '11111111111111111111111111111111'; // 32 zero bytes in base58
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

// Chain-specific RPC endpoints
const CHAIN_RPCS = {
  'ethereum': process.env.NANSEN_EVM_RPC || DEFAULT_EVM_RPC,
  'evm': process.env.NANSEN_EVM_RPC || DEFAULT_EVM_RPC,
  'base': process.env.NANSEN_BASE_RPC || 'https://mainnet.base.org',
  'solana': process.env.NANSEN_SOLANA_RPC || DEFAULT_SOLANA_RPC,
};

const CHAIN_IDS = { 'ethereum': 1, 'evm': 1, 'base': 8453 };

// ============= Base58 =============

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Decode(str) {
  let num = 0n;
  for (const ch of str) {
    const idx = BASE58_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`Invalid base58 character: ${ch}`);
    num = num * 58n + BigInt(idx);
  }
  const hex = num.toString(16);
  const paddedHex = hex.length % 2 ? '0' + hex : hex;
  const bytes = num === 0n ? [] : [...Buffer.from(paddedHex, 'hex')];
  let leadingZeros = 0;
  for (const ch of str) { if (ch === '1') leadingZeros++; else break; }
  return Buffer.from([...Array(leadingZeros).fill(0), ...bytes]);
}

function base58DecodePubkey(str) {
  const raw = base58Decode(str);
  if (raw.length === 32) return raw;
  if (raw.length < 32) return Buffer.concat([Buffer.alloc(32 - raw.length), raw]);
  return raw.subarray(raw.length - 32);
}

// ============= Address Validation =============

function validateEvmAddress(address) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return { valid: false, error: 'Invalid EVM address' };
  return { valid: true };
}

function validateSolanaAddress(address) {
  try {
    const decoded = base58Decode(address);
    if (decoded.length !== 32) return { valid: false, error: 'Invalid Solana address length' };
    return { valid: true };
  } catch { return { valid: false, error: 'Invalid Solana address' }; }
}

// ============= Amount Parsing =============

function parseAmount(amountStr, decimals) {
  const parts = amountStr.split('.');
  const whole = parts[0] || '0';
  let frac = (parts[1] || '').padEnd(decimals, '0').slice(0, decimals);
  return BigInt(whole) * (10n ** BigInt(decimals)) + BigInt(frac);
}

function formatAmount(rawAmount, decimals) {
  const divisor = 10n ** BigInt(decimals);
  const whole = rawAmount / divisor;
  const frac = rawAmount % divisor;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${whole}.${fracStr}`;
}

// ============= RPC =============

async function rpcCall(url, method, params = []) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const data = await response.json();
  if (data.error) throw new Error(friendlyRpcError(data.error));
  return data.result;
}

/**
 * Convert raw RPC errors into actionable messages.
 */
function friendlyRpcError(error) {
  const msg = error.message || JSON.stringify(error);
  const lower = msg.toLowerCase();

  if (lower.includes('no record of a prior credit') || lower.includes('accountnotfound')) {
    return 'Insufficient SOL for transaction fees. Send at least 0.01 SOL to your wallet.';
  }
  if (lower.includes('insufficient lamports') || lower.includes('insufficient funds')) {
    return 'Insufficient SOL balance for this transaction. Top up your wallet with SOL.';
  }
  if (lower.includes('blockhash not found') || lower.includes('blockhash')) {
    return 'Transaction expired. Please try again.';
  }
  if (lower.includes('too large') || lower.includes('transaction too big')) {
    return 'Transaction too large. Try a simpler transaction or fewer instructions.';
  }
  if (lower.includes('program failed') || lower.includes('custom program error')) {
    return `Transaction rejected by on-chain program: ${msg}`;
  }

  return `RPC error: ${msg}`;
}


function bigIntToHex(n) {
  if (n === 0n) return '0x';
  const hex = n.toString(16);
  return '0x' + hex;
}

// ============= EVM Transaction =============

async function buildEvmTransaction({ to, amount, token, privateKey, chain, max = false }) {
  const rpcUrl = CHAIN_RPCS[chain] || CHAIN_RPCS.evm;
  const chainId = CHAIN_IDS[chain] || 1;

  // Derive address
  const privBuf = Buffer.from(privateKey, 'hex');
  const ecdh = crypto.createECDH('secp256k1');
  ecdh.setPrivateKey(privBuf);
  const pubKey = ecdh.getPublicKey(null, 'uncompressed');
  const from = '0x' + keccak256(pubKey.subarray(1)).subarray(12).toString('hex');

  // Nonce
  const nonceHex = await rpcCall(rpcUrl, 'eth_getTransactionCount', [from, 'latest']);
  const nonce = BigInt(nonceHex);

  // Fees — dynamic priority fee
  const feeHistory = await rpcCall(rpcUrl, 'eth_feeHistory', [4, 'latest', [50]]);
  const baseFee = BigInt(feeHistory.baseFeePerGas[feeHistory.baseFeePerGas.length - 1]);
  let maxPriorityFee;
  try {
    const dynamicTip = await rpcCall(rpcUrl, 'eth_maxPriorityFeePerGas', []);
    maxPriorityFee = BigInt(dynamicTip);
  } catch {
    // Fallback: median tip from fee history, or chain-specific default
    const tips = (feeHistory.reward || []).map(r => r[0] ? BigInt(r[0]) : 0n).filter(t => t > 0n);
    if (tips.length > 0) {
      tips.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      maxPriorityFee = tips[Math.floor(tips.length / 2)];
    } else {
      maxPriorityFee = PRIORITY_FEE_DEFAULTS[chain] || PRIORITY_FEE_DEFAULTS.evm;
    }
  }
  const maxFee = baseFee * 2n + maxPriorityFee;

  let txTo, txValue, txData;
  if (token) {
    const toStripped = to.replace(/^0x/, '').padStart(64, '0');
    const amtHex = amount.toString(16).padStart(64, '0');
    txTo = token;
    txValue = 0n;
    txData = Buffer.from(ERC20_TRANSFER_SELECTOR + toStripped + amtHex, 'hex');

    // Pre-check: ERC-20 balance
    const balResult = await rpcCall(rpcUrl, 'eth_call', [{
      to: token,
      data: '0x70a08231' + from.slice(2).padStart(64, '0'), // balanceOf(address)
    }, 'latest']);
    const tokenBalance = BigInt(balResult || '0x0');
    if (tokenBalance < amount) {
      throw new Error(`Insufficient token balance: have ${tokenBalance}, need ${amount}`);
    }
  } else {
    txTo = to;
    txData = Buffer.alloc(0);

    // Native ETH balance check / max calculation
    const balHex = await rpcCall(rpcUrl, 'eth_getBalance', [from, 'latest']);
    const ethBalance = BigInt(balHex);

    if (max) {
      // First estimate gas for a dummy transfer to get the right gasLimit
      // (EIP-7702 delegated accounts need more than 21000)
      let estGasLimit;
      try {
        const dummyEstimate = await rpcCall(rpcUrl, 'eth_estimateGas', [
          { from, to, value: '0x1' },
        ]);
        estGasLimit = BigInt(dummyEstimate) * 120n / 100n;
      } catch {
        estGasLimit = 21000n;
      }
      // Reserve: L2 gas (gasLimit * maxFee) + L1 data fee buffer
      // L1 fees on Base/OP are typically ~0.5-2% of L2 gas cost
      // Use 3x L2 gas cost as safe total reserve
      const l2GasCost = maxFee * estGasLimit;
      const safeReserve = l2GasCost * 3n;
      if (ethBalance <= safeReserve) throw new Error(`Insufficient balance: ${ethBalance} wei (need > ${safeReserve} for gas + L1 fees)`);
      txValue = ethBalance - safeReserve;
      amount = txValue;
      stderr(`  Max send: ${formatAmount(txValue, 18)} ETH (reserved ${formatAmount(safeReserve, 18)} for gas)`);
    } else {
      txValue = amount;
      const estimatedCost = amount + maxFee * 21000n;
      if (ethBalance < estimatedCost) {
        throw new Error(`Insufficient ETH balance: have ${ethBalance} wei, need ~${estimatedCost} wei (${amount} value + gas)`);
      }
    }
  }

  // Estimate gas dynamically
  const estimateParams = { from, to: txTo, data: txData.length > 0 ? '0x' + txData.toString('hex') : '0x' };
  if (txValue > 0n) estimateParams.value = bigIntToHex(txValue);
  let gasLimit;
  try {
    const gasEstimate = await rpcCall(rpcUrl, 'eth_estimateGas', [estimateParams]);
    // Add 20% buffer for safety
    gasLimit = BigInt(gasEstimate) * 120n / 100n;
  } catch {
    // Fallback to safe defaults if estimation fails
    gasLimit = token ? 100000n : 21000n;
  }

  // RLP: [chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gasLimit, to, value, data, accessList]
  const txFields = [
    bigIntToHex(BigInt(chainId)),
    bigIntToHex(nonce),
    bigIntToHex(maxPriorityFee),
    bigIntToHex(maxFee),
    bigIntToHex(gasLimit),
    txTo,
    bigIntToHex(txValue),
    txData.length > 0 ? '0x' + txData.toString('hex') : '0x',
    [], // accessList
  ];

  const unsigned = rlpEncode(txFields);
  const txHash = keccak256(Buffer.concat([Buffer.from([0x02]), unsigned]));
  const sig = signSecp256k1(txHash, privBuf);

  const signed = rlpEncode([
    ...txFields,
    bigIntToHex(BigInt(sig.v)),
    '0x' + sig.r.toString('hex'),
    '0x' + sig.s.toString('hex'),
  ]);

  const rawTx = Buffer.concat([Buffer.from([0x02]), signed]);
  return { signedTransaction: '0x' + rawTx.toString('hex'), amount: txValue };
}

// ============= Solana Transaction =============

function encodeCompactU16(value) {
  if (value < 0x80) return Buffer.from([value]);
  if (value < 0x4000) return Buffer.from([(value & 0x7f) | 0x80, (value >> 7) & 0x7f]);
  return Buffer.from([(value & 0x7f) | 0x80, ((value >> 7) & 0x7f) | 0x80, (value >> 14) & 0x03]);
}

function signEd25519(message, seed) {
  const keyObj = crypto.createPrivateKey({
    key: Buffer.concat([
      Buffer.from('302e020100300506032b657004220420', 'hex'), // PKCS8 Ed25519 prefix
      seed,
    ]),
    format: 'der',
    type: 'pkcs8',
  });
  return crypto.sign(null, message, keyObj);
}

// ============= Solana PDA / ATA =============

function deriveATA(owner, mint, tokenProgram) {
  const ownerBuf = typeof owner === 'string' ? base58DecodePubkey(owner) : owner;
  const mintBuf = typeof mint === 'string' ? base58DecodePubkey(mint) : mint;
  const tokenProgBuf = base58DecodePubkey(tokenProgram);
  const ataBuf = base58DecodePubkey(ATA_PROGRAM);

  for (let nonce = 255; nonce >= 0; nonce--) {
    const hash = crypto.createHash('sha256')
      .update(Buffer.concat([ownerBuf, tokenProgBuf, mintBuf, Buffer.from([nonce]), ataBuf, Buffer.from('ProgramDerivedAddress')]))
      .digest();
    // PDA must NOT be on the ed25519 curve
    if (!isOnEd25519Curve(hash)) return hash;
  }
  throw new Error('Could not derive ATA');
}

function isOnEd25519Curve(bytes) {
  const p = (1n << 255n) - 19n;
  const d = (-121665n * modPowBig(121666n, p - 2n, p) % p + p) % p;
  let y = 0n;
  for (let i = 0; i < 32; i++) y |= BigInt(bytes[i]) << (BigInt(i) * 8n);
  y &= (1n << 255n) - 1n;
  if (y >= p) return false;
  const y2 = modPowBig(y, 2n, p);
  const num = ((y2 - 1n) % p + p) % p;
  const den = ((d * y2 + 1n) % p + p) % p;
  const x2 = (num * modPowBig(den, p - 2n, p)) % p;
  if (x2 === 0n) return true;
  return modPowBig(x2, (p - 1n) / 2n, p) === 1n;
}

function modPowBig(base, exp, mod) {
  let result = 1n;
  base = ((base % mod) + mod) % mod;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod;
    exp >>= 1n;
    base = (base * base) % mod;
  }
  return result;
}

async function getTokenInfo(rpcUrl, mint) {
  // Get mint account to determine token program and decimals
  const info = await rpcCall(rpcUrl, 'getAccountInfo', [mint, { encoding: 'jsonParsed' }]);
  if (!info || !info.value) throw new Error(`Token mint ${mint} not found`);
  const owner = info.value.owner;
  const decimals = info.value.data?.parsed?.info?.decimals;
  return { tokenProgram: owner, decimals: decimals ?? 9 };
}

async function buildSolanaTransaction({ to, amount, amountStr, token, privateKey }) {
  const rpcUrl = CHAIN_RPCS.solana;

  const keypairBuf = Buffer.from(privateKey, 'hex');
  const seed = keypairBuf.subarray(0, 32);
  const pubkey = keypairBuf.subarray(32, 64);
  const fromAddr = base58Encode(pubkey);

  // Get recent blockhash
  const bhResult = await rpcCall(rpcUrl, 'getLatestBlockhash', [{ commitment: 'finalized' }]);
  const blockhash = bhResult.value.blockhash;

  let accountKeys, instructions, numReadonlyUnsigned;

  if (token) {
    // SPL Token TransferChecked
    const { tokenProgram, decimals } = await getTokenInfo(rpcUrl, token);
    const tokenAmount = parseAmount(amountStr, decimals);
    const mintBuf = base58DecodePubkey(token);
    const sourceATA = deriveATA(fromAddr, token, tokenProgram);
    const destATA = deriveATA(to, token, tokenProgram);
    const tokenProgBuf = base58DecodePubkey(tokenProgram);

    // Pre-check: SPL token balance
    const sourceAtaAddr = base58Encode(sourceATA);
    try {
      const ataInfo = await rpcCall(rpcUrl, 'getTokenAccountBalance', [sourceAtaAddr]);
      const tokenBalance = BigInt(ataInfo.value.amount);
      if (tokenBalance < tokenAmount) {
        throw new Error(`Insufficient token balance: have ${ataInfo.value.uiAmountString}, need ${amountStr}`);
      }
    } catch (e) {
      if (e.message.includes('Insufficient')) throw e;
      throw new Error(`Source token account not found. Do you hold this token?`);
    }

    // TransferChecked instruction data: [12, amount u64 LE, decimals u8]
    const instrData = Buffer.alloc(10);
    instrData[0] = 12; // TransferChecked
    instrData.writeBigUInt64LE(tokenAmount, 1);
    instrData[9] = decimals;

    const destPubkey = base58DecodePubkey(to);

    // Check if destination ATA already exists — skip CreateATA if so
    const destAtaAddr = base58Encode(destATA);
    let destAtaExists = false;
    try {
      const destInfo = await rpcCall(rpcUrl, 'getAccountInfo', [destAtaAddr, { encoding: 'base64' }]);
      destAtaExists = destInfo?.value !== null;
    } catch { /* assume doesn't exist */ }

    if (destAtaExists) {
      // Simple: just TransferChecked, no CreateATA needed
      // Account ordering: writable first, then readonly (Solana message format requirement)
      // Accounts: [owner(s,w), sourceATA(w), destATA(w), mint(r), tokenProgram(r)]
      accountKeys = [
        pubkey,        // 0: owner/feePayer (signer, writable)
        sourceATA,     // 1: source ATA (writable)
        destATA,       // 2: dest ATA (writable)
        mintBuf,       // 3: mint (readonly)
        tokenProgBuf,  // 4: token program (readonly)
      ];
      instructions = [{
        programIdIndex: 4,
        accountIndices: [1, 3, 2, 0], // source, mint, dest, authority
        data: instrData,
      }];
      numReadonlyUnsigned = 2; // mint + tokenProgram
    } else {
      // Need CreateAssociatedTokenAccountIdempotent + TransferChecked
      const ataProgBuf = base58DecodePubkey(ATA_PROGRAM);
      const sysProgramBuf = base58DecodePubkey(SYSTEM_PROGRAM);

      accountKeys = [
        pubkey,        // 0
        sourceATA,     // 1
        destATA,       // 2
        destPubkey,    // 3
        mintBuf,       // 4
        sysProgramBuf, // 5
        tokenProgBuf,  // 6
        ataProgBuf,    // 7
      ];

      const createAtaInstr = {
        programIdIndex: 7,
        accountIndices: [0, 2, 3, 4, 5, 6],
        data: Buffer.from([1]),
      };
      const transferInstr = {
        programIdIndex: 6,
        accountIndices: [1, 4, 2, 0],
        data: instrData,
      };
      instructions = [createAtaInstr, transferInstr];
      numReadonlyUnsigned = 5; // destOwner, mint, systemProg, tokenProg, ataProg
    }
  } else {
    // Native SOL transfer

    // Pre-check: SOL balance
    const balResult = await rpcCall(rpcUrl, 'getBalance', [fromAddr, { commitment: 'confirmed' }]);
    const solBalance = BigInt(balResult.value);
    const needed = amount + 5000n; // amount + ~fee
    if (solBalance < needed) {
      throw new Error(`Insufficient SOL balance: have ${solBalance} lamports, need ${needed} (${amount} + fees)`);
    }

    const instrData = Buffer.alloc(12);
    instrData.writeUInt32LE(2, 0);
    instrData.writeBigUInt64LE(amount, 4);

    accountKeys = [
      pubkey,
      base58DecodePubkey(to),
      base58DecodePubkey(SYSTEM_PROGRAM),
    ];

    instructions = [{
      programIdIndex: 2,
      accountIndices: [0, 1],
      data: instrData,
    }];
    numReadonlyUnsigned = 1;
  }

  // Serialize legacy message
  const parts = [];
  parts.push(Buffer.from([1, 0, numReadonlyUnsigned]));
  parts.push(encodeCompactU16(accountKeys.length));
  for (const key of accountKeys) parts.push(key);
  parts.push(base58DecodePubkey(blockhash));
  parts.push(encodeCompactU16(instructions.length));
  for (const ix of instructions) {
    parts.push(Buffer.from([ix.programIdIndex]));
    parts.push(encodeCompactU16(ix.accountIndices.length));
    parts.push(Buffer.from(ix.accountIndices));
    parts.push(encodeCompactU16(ix.data.length));
    parts.push(ix.data);
  }

  const messageBytes = Buffer.concat(parts);

  // Sign
  const signature = signEd25519(messageBytes, seed);

  // Serialize transaction: compact(numSigs) + signatures + message
  const txBytes = Buffer.concat([
    encodeCompactU16(1),
    signature, // 64 bytes
    messageBytes,
  ]);

  // Solana sendTransaction expects base64
  return { signedTransaction: txBytes.toString('base64') };
}

// ============= Broadcasting =============

// ============= Confirmation =============

function stderr(msg) { process.stderr.write(msg + '\n'); }

async function waitForEvmConfirmation(rpcUrl, txHash, timeoutMs = 30000) {
  stderr('  Waiting for confirmation...');
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const receipt = await rpcCall(rpcUrl, 'eth_getTransactionReceipt', [txHash]);
      if (receipt) {
        if (receipt.status === '0x0') throw new Error(`Transaction reverted on-chain: ${txHash}`);
        const block = parseInt(receipt.blockNumber, 16);
        stderr(`  ✓ Confirmed in block ${block}`);
        return { confirmed: true, blockNumber: block };
      }
    } catch (e) {
      if (e.message.includes('reverted')) throw e;
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  stderr('  ⚠ Confirmation timed out (tx may still succeed)');
  return { confirmed: false };
}

async function waitForSolanaConfirmation(rpcUrl, txHash, timeoutMs = 30000) {
  stderr('  Waiting for confirmation...');
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const result = await rpcCall(rpcUrl, 'getSignatureStatuses', [[txHash]]);
      const status = result?.value?.[0];
      if (status) {
        if (status.err) throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`);
        if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
          stderr(`  ✓ Confirmed (${status.confirmationStatus}, slot ${status.slot})`);
          return { confirmed: true, slot: status.slot };
        }
      }
    } catch (e) {
      if (e.message.includes('failed')) throw e;
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  stderr('  ⚠ Confirmation timed out (tx may still succeed)');
  return { confirmed: false };
}

// ============= Token Validation =============

async function validateErc20Token(rpcUrl, tokenAddress) {
  // Check it's a contract
  const code = await rpcCall(rpcUrl, 'eth_getCode', [tokenAddress, 'latest']);
  if (!code || code === '0x' || code === '0x0') {
    throw new Error(`Address ${tokenAddress} is not a contract — not a valid ERC-20 token`);
  }
  // Check decimals() is callable
  try {
    const decResult = await rpcCall(rpcUrl, 'eth_call', [{ to: tokenAddress, data: '0x313ce567' }, 'latest']);
    const decimals = parseInt(decResult, 16);
    if (isNaN(decimals) || decimals > 255) {
      throw new Error(`Contract ${tokenAddress} returned invalid decimals — may not be a valid ERC-20 token`);
    }
    return decimals;
  } catch (e) {
    if (e.message.includes('not a valid')) throw e;
    throw new Error(`Contract ${tokenAddress} does not implement ERC-20 decimals() — may not be a valid token`);
  }
}

// ============= Broadcasting =============

async function broadcastTransaction(signedTx, chain) {
  if (chain === 'solana') {
    return rpcCall(CHAIN_RPCS.solana, 'sendTransaction', [signedTx, {
      encoding: 'base64',
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    }]);
  }
  return rpcCall(CHAIN_RPCS[chain] || CHAIN_RPCS.evm, 'eth_sendRawTransaction', [signedTx]);
}

// ============= Public API =============

// Exported for testing
export { parseAmount, formatAmount, signEd25519, encodeCompactU16, base58Decode, base58DecodePubkey, deriveATA, validateEvmAddress, validateSolanaAddress, bigIntToHex };

export async function sendTokens({ to, amount, chain, token = null, wallet = null, password, max = false, dryRun = false }) {
  // Validate address
  const validate = chain === 'solana' ? validateSolanaAddress : validateEvmAddress;
  const v = validate(to);
  if (!v.valid) throw new Error(`Invalid recipient: ${v.error}`);

  const config = getWalletConfig();
  if (!verifyPassword(password, config)) throw new Error('Incorrect password');

  const walletName = wallet || config.defaultWallet;
  if (!walletName) throw new Error('No wallet specified and no default wallet set');
  const walletData = exportWallet(walletName, password);

  let result;
  if (chain === 'solana') {
    if (max && !token) {
      // Max native SOL: balance - 5000 lamports fee
      const rpcUrl = CHAIN_RPCS.solana;
      const fromAddr = walletData.solana.address;
      const balResult = await rpcCall(rpcUrl, 'getBalance', [fromAddr, { commitment: 'confirmed' }]);
      const solBalance = BigInt(balResult.value);
      const fee = 5000n;
      if (solBalance <= fee) throw new Error(`Insufficient SOL balance: ${solBalance} lamports (need > ${fee} for fees)`);
      const maxAmount = solBalance - fee;
      amount = formatAmount(maxAmount, 9);
      stderr(`  Max send: ${amount} SOL`);
    } else if (max && token) {
      // Max SPL: full token balance
      const rpcUrl = CHAIN_RPCS.solana;
      const { tokenProgram, decimals } = await getTokenInfo(rpcUrl, token);
      const sourceATA = deriveATA(walletData.solana.address, token, tokenProgram);
      const sourceAtaAddr = base58Encode(sourceATA);
      const ataInfo = await rpcCall(rpcUrl, 'getTokenAccountBalance', [sourceAtaAddr]);
      amount = ataInfo.value.uiAmountString;
      stderr(`  Max send: ${amount} (SPL token)`);
    }
    const amountRaw = token ? null : parseAmount(amount, 9);
    result = await buildSolanaTransaction({
      to, amount: amountRaw, amountStr: amount, token,
      privateKey: walletData.solana.privateKey,
    });
  } else {
    const rpcUrl = CHAIN_RPCS[chain] || CHAIN_RPCS.evm;

    // Validate ERC-20 token contract
    let decimals = 18;
    if (token) {
      decimals = await validateErc20Token(rpcUrl, token);
    }

    if (max && token) {
      // Max ERC-20: full token balance
      const privBuf = Buffer.from(walletData.evm.privateKey, 'hex');
      const ecdh = crypto.createECDH('secp256k1');
      ecdh.setPrivateKey(privBuf);
      const pubKey = ecdh.getPublicKey(null, 'uncompressed');
      const from = '0x' + keccak256(pubKey.subarray(1)).subarray(12).toString('hex');
      const balResult = await rpcCall(rpcUrl, 'eth_call', [{
        to: token, data: '0x70a08231' + from.slice(2).padStart(64, '0'),
      }, 'latest']);
      const tokenBalance = BigInt(balResult || '0x0');
      if (tokenBalance === 0n) throw new Error('Token balance is zero');
      amount = formatAmount(tokenBalance, decimals);
      stderr(`  Max send: ${amount} (ERC-20)`);
    }

    const amountRaw = (max && !token) ? 0n : parseAmount(amount, decimals);
    result = await buildEvmTransaction({
      to, amount: amountRaw, token,
      privateKey: walletData.evm.privateKey,
      chain, max: max && !token,
    });
  }

  // Dry run: return transaction details without broadcasting
  if (dryRun) {
    const finalAmount = (max && !token && result.amount != null)
      ? formatAmount(result.amount, chain === 'solana' ? 9 : 18)
      : amount;
    return {
      dryRun: true,
      from: chain === 'solana' ? walletData.solana.address : walletData.evm.address,
      to, amount: finalAmount, token, chain,
      ...(result.estimatedFee ? { estimatedFee: result.estimatedFee } : {}),
    };
  }

  const txHash = await broadcastTransaction(result.signedTransaction, chain);

  // Wait for confirmation
  let confirmation;
  if (chain === 'solana') {
    confirmation = await waitForSolanaConfirmation(CHAIN_RPCS.solana, txHash);
  } else {
    const rpcUrl = CHAIN_RPCS[chain] || CHAIN_RPCS.evm;
    confirmation = await waitForEvmConfirmation(rpcUrl, txHash);
  }

  // For max native sends, use the actual amount from the tx builder
  const finalAmount = (max && !token && result.amount != null)
    ? formatAmount(result.amount, chain === 'solana' ? 9 : 18)
    : amount;

  return {
    success: true,
    transactionHash: txHash,
    confirmed: confirmation.confirmed,
    ...(confirmation.blockNumber ? { blockNumber: confirmation.blockNumber } : {}),
    from: chain === 'solana' ? walletData.solana.address : walletData.evm.address,
    to, amount: finalAmount, token, chain,
    explorer: getExplorerUrl(chain, txHash),
  };
}

/**
 * Get block explorer URL for a transaction.
 */
function getExplorerUrl(chain, txHash) {
  const explorers = {
    solana: 'https://solscan.io/tx/',
    ethereum: 'https://etherscan.io/tx/',
    base: 'https://basescan.org/tx/',
    arbitrum: 'https://arbiscan.io/tx/',
    polygon: 'https://polygonscan.com/tx/',
    optimism: 'https://optimistic.etherscan.io/tx/',
    bnb: 'https://bscscan.com/tx/',
    avalanche: 'https://snowtrace.io/tx/',
    linea: 'https://lineascan.build/tx/',
    scroll: 'https://scrollscan.com/tx/',
    mantle: 'https://mantlescan.xyz/tx/',
  };
  const base = explorers[chain] || explorers.ethereum;
  return `${base}${txHash}`;
}
