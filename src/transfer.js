/**
 * Nansen CLI - Token Transfer
 * Send native and ERC-20/SPL tokens on EVM and Solana chains.
 * Zero external dependencies — uses Node.js built-in crypto only.
 */

import crypto from 'crypto';
import { keccak256, base58Encode, exportWallet, getWalletConfig, verifyPassword } from './wallet.js';

// ============= Constants =============

const DEFAULT_EVM_RPC = 'https://eth.public-rpc.com';
const DEFAULT_SOLANA_RPC = 'https://api.mainnet-beta.solana.com';

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

// ============= RPC =============

async function rpcCall(url, method, params = []) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const data = await response.json();
  if (data.error) throw new Error(`RPC error: ${data.error.message || JSON.stringify(data.error)}`);
  return data.result;
}

// ============= RLP Encoding =============

function rlpEncode(input) {
  if (Array.isArray(input)) {
    const encoded = input.map(rlpEncode);
    const payload = Buffer.concat(encoded);
    if (payload.length < 56) {
      return Buffer.concat([Buffer.from([0xc0 + payload.length]), payload]);
    }
    const lenBytes = bigIntToMinBuf(BigInt(payload.length));
    return Buffer.concat([Buffer.from([0xf7 + lenBytes.length]), lenBytes, payload]);
  }

  // Scalar: convert hex string or Buffer to bytes
  let data;
  if (Buffer.isBuffer(input)) {
    data = input;
  } else {
    let hex = (typeof input === 'string' ? input : '').replace(/^0x/, '');
    // Strip leading zeros (RLP encodes minimal bytes)
    hex = hex.replace(/^0+/, '');
    if (hex === '' || hex.length === 0) return Buffer.from([0x80]); // empty byte string
    if (hex.length % 2) hex = '0' + hex;
    data = Buffer.from(hex, 'hex');
  }

  if (data.length === 0) return Buffer.from([0x80]);
  if (data.length === 1 && data[0] < 0x80) return data;
  if (data.length < 56) return Buffer.concat([Buffer.from([0x80 + data.length]), data]);
  const lenBytes = bigIntToMinBuf(BigInt(data.length));
  return Buffer.concat([Buffer.from([0xb7 + lenBytes.length]), lenBytes, data]);
}

function bigIntToMinBuf(n) {
  if (n === 0n) return Buffer.alloc(0);
  const hex = n.toString(16);
  return Buffer.from(hex.length % 2 ? '0' + hex : hex, 'hex');
}

function bigIntToHex(n) {
  if (n === 0n) return '0x';
  const hex = n.toString(16);
  return '0x' + hex;
}

// ============= secp256k1 ECDSA =============

const P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2Fn;
const N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
const Gx = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798n;
const Gy = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8n;

function modInv(a, m) {
  let [old_r, r] = [((a % m) + m) % m, m];
  let [old_s, s] = [1n, 0n];
  while (r !== 0n) {
    const q = old_r / r;
    [old_r, r] = [r, old_r - q * r];
    [old_s, s] = [s, old_s - q * s];
  }
  return ((old_s % m) + m) % m;
}

function ptAdd(x1, y1, x2, y2) {
  if (x1 === null) return [x2, y2];
  if (x2 === null) return [x1, y1];
  if (x1 === x2 && y1 === y2) {
    const lam = (3n * x1 * x1 * modInv(2n * y1, P)) % P;
    const x3 = ((lam * lam - 2n * x1) % P + P) % P;
    return [x3, ((lam * (x1 - x3) - y1) % P + P) % P];
  }
  if (x1 === x2) return [null, null];
  const lam = (((y2 - y1) % P + P) * modInv(((x2 - x1) % P + P) % P, P)) % P;
  const x3 = ((lam * lam - x1 - x2) % P + P) % P;
  return [x3, ((lam * (x1 - x3) - y1) % P + P) % P];
}

function ptMul(k, x, y) {
  let [rx, ry] = [null, null];
  let [qx, qy] = [x, y];
  while (k > 0n) {
    if (k & 1n) [rx, ry] = ptAdd(rx, ry, qx, qy);
    [qx, qy] = ptAdd(qx, qy, qx, qy);
    k >>= 1n;
  }
  return [rx, ry];
}

function rfc6979k(privBuf, hash) {
  let v = Buffer.alloc(32, 0x01);
  let k = Buffer.alloc(32, 0x00);
  k = crypto.createHmac('sha256', k).update(Buffer.concat([v, Buffer.from([0x00]), privBuf, hash])).digest();
  v = crypto.createHmac('sha256', k).update(v).digest();
  k = crypto.createHmac('sha256', k).update(Buffer.concat([v, Buffer.from([0x01]), privBuf, hash])).digest();
  v = crypto.createHmac('sha256', k).update(v).digest();
  while (true) {
    v = crypto.createHmac('sha256', k).update(v).digest();
    const candidate = BigInt('0x' + v.toString('hex'));
    if (candidate >= 1n && candidate < N) return candidate;
    k = crypto.createHmac('sha256', k).update(Buffer.concat([v, Buffer.from([0x00])])).digest();
    v = crypto.createHmac('sha256', k).update(v).digest();
  }
}

function signSecp256k1(hash, privateKey) {
  const z = BigInt('0x' + hash.toString('hex'));
  const d = BigInt('0x' + privateKey.toString('hex'));
  const k = rfc6979k(privateKey, hash);
  const [rx, ry] = ptMul(k, Gx, Gy);
  const r = rx % N;
  if (r === 0n) throw new Error('Invalid signature: r=0');
  let s = (modInv(k, N) * ((z + r * d) % N)) % N;
  if (s === 0n) throw new Error('Invalid signature: s=0');
  let recovery = (ry % 2n === 0n) ? 0 : 1;
  if (s > N >> 1n) { s = N - s; recovery ^= 1; }
  return {
    r: Buffer.from(r.toString(16).padStart(64, '0'), 'hex'),
    s: Buffer.from(s.toString(16).padStart(64, '0'), 'hex'),
    recovery,
  };
}

// ============= EVM Transaction =============

async function buildEvmTransaction({ to, amount, token, privateKey, chain }) {
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

  // Fees
  const feeHistory = await rpcCall(rpcUrl, 'eth_feeHistory', [4, 'latest', [50]]);
  const baseFee = BigInt(feeHistory.baseFeePerGas[feeHistory.baseFeePerGas.length - 1]);
  const maxPriorityFee = 100000000n; // 0.1 gwei (Base is cheap)
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
    txValue = amount;
    txData = Buffer.alloc(0);

    // Pre-check: native ETH balance
    const balHex = await rpcCall(rpcUrl, 'eth_getBalance', [from, 'latest']);
    const ethBalance = BigInt(balHex);
    const estimatedCost = amount + maxFee * 21000n; // rough gas cost estimate
    if (ethBalance < estimatedCost) {
      throw new Error(`Insufficient ETH balance: have ${ethBalance} wei, need ~${estimatedCost} wei (${amount} value + gas)`);
    }
  }

  // Estimate gas dynamically instead of hardcoding
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
    bigIntToHex(BigInt(sig.recovery)),
    '0x' + sig.r.toString('hex'),
    '0x' + sig.s.toString('hex'),
  ]);

  const rawTx = Buffer.concat([Buffer.from([0x02]), signed]);
  return { signedTransaction: '0x' + rawTx.toString('hex') };
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
      // Accounts: [owner(s,w), sourceATA(w), mint(r), destATA(w), tokenProgram(r)]
      accountKeys = [
        pubkey,        // 0: owner/feePayer (signer, writable)
        sourceATA,     // 1: source ATA (writable)
        mintBuf,       // 2: mint (readonly)
        destATA,       // 3: dest ATA (writable)
        tokenProgBuf,  // 4: token program (readonly)
      ];
      instructions = [{
        programIdIndex: 4,
        accountIndices: [1, 2, 3, 0], // source, mint, dest, authority
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
export { rlpEncode, parseAmount, signSecp256k1, signEd25519, encodeCompactU16, base58Decode, base58DecodePubkey, deriveATA, validateEvmAddress, validateSolanaAddress, bigIntToHex };

export async function sendTokens({ to, amount, chain, token = null, wallet = null, password }) {
  // Validate
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
    // For SPL tokens, decimals are fetched inside buildSolanaTransaction
    // For native SOL, 9 decimals
    const amountRaw = token ? null : parseAmount(amount, 9);
    result = await buildSolanaTransaction({
      to, amount: amountRaw, amountStr: amount, token,
      privateKey: walletData.solana.privateKey,
    });
  } else {
    // For ERC-20, fetch decimals from contract; for native ETH, 18
    let decimals = 18;
    if (token) {
      const rpcUrl = CHAIN_RPCS[chain] || CHAIN_RPCS.evm;
      // Call decimals() on the token contract
      const decResult = await rpcCall(rpcUrl, 'eth_call', [{ to: token, data: '0x313ce567' }, 'latest']);
      decimals = parseInt(decResult, 16);
    }
    const amountRaw = parseAmount(amount, decimals);
    result = await buildEvmTransaction({
      to, amount: amountRaw, token,
      privateKey: walletData.evm.privateKey,
      chain,
    });
  }

  const txHash = await broadcastTransaction(result.signedTransaction, chain);

  return {
    success: true,
    transactionHash: txHash,
    from: chain === 'solana' ? walletData.solana.address : walletData.evm.address,
    to, amount, token, chain,
  };
}
