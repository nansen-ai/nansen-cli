/**
 * Test stand-ins for the remote signers (Privy, WalletConnect).
 *
 * The CLI checks that a remote signer hands back exactly the transaction it was
 * sent, signed by the expected wallet, so a stub can no longer answer with
 * placeholder bytes. These helpers sign what the stub received with fixed test
 * keys, the way a real signer would.
 */
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { signEip1559Transaction, signSolanaTransaction } from '../../trading.js';
import { keccak256, toChecksumAddress } from '../../crypto.js';
import { base58Encode } from '../../wallet.js';
import { parseTransactionMessage, readCompactU16 } from '../../solana-tx.js';

export const TEST_EVM_KEY = '11'.repeat(32);
export const TEST_EVM_ADDRESS = toChecksumAddress(
  keccak256(Buffer.from(secp256k1.getPublicKey(Buffer.from(TEST_EVM_KEY, 'hex'), false)).subarray(1)).subarray(12).toString('hex'),
);

const SOL_SEED = Buffer.alloc(32, 0x22);
const SOL_PUB = Buffer.from(ed25519.getPublicKey(SOL_SEED));
/** 64-byte seed||pubkey hex, the form signSolanaTransaction takes. */
export const TEST_SOL_KEY = Buffer.concat([SOL_SEED, SOL_PUB]).toString('hex');
export const TEST_SOL_ADDRESS = base58Encode(SOL_PUB);
export const TEST_SOL_PUBKEY_BYTES = SOL_PUB;

/** Sign the transaction a Privy `eth_signTransaction` request body carries. */
export function privySignedEvm(privyBody, key = TEST_EVM_KEY) {
  const t = privyBody.params.transaction;
  return signEip1559Transaction({
    chainId: t.chain_id,
    nonce: t.nonce,
    maxPriorityFeePerGas: t.max_priority_fee_per_gas,
    maxFeePerGas: t.max_fee_per_gas,
    gasLimit: t.gas_limit,
    to: t.to,
    value: t.value,
    data: t.data,
  }, key);
}

/**
 * Sign the transaction a Privy Solana `signTransaction` request body carries,
 * in the slot of the key's own account (not always slot 0: an x402 payment has
 * the facilitator as fee payer), as Privy does.
 */
export function privySignedSolana(privyBody, key = TEST_SOL_KEY) {
  return signSolanaSlot(privyBody.params.transaction, key);
}

export function signSolanaSlot(txBase64, key = TEST_SOL_KEY) {
  const bytes = Buffer.from(txBase64, 'base64');
  const { value: sigCount, size } = readCompactU16(bytes, 0);
  const message = bytes.subarray(size + 64 * sigCount);
  const signer = base58Encode(Buffer.from(key, 'hex').subarray(32));
  const index = Math.max(0, parseTransactionMessage(txBase64).staticAccountKeys.indexOf(signer));
  const single = Buffer.concat([Buffer.from([1]), Buffer.alloc(64), message]).toString('base64');
  const signature = Buffer.from(signSolanaTransaction(single, key), 'base64').subarray(1, 65);
  signature.copy(bytes, size + 64 * index);
  return bytes.toString('base64');
}

/** The fee payer's signature (the transaction id) in signed base64 bytes. */
export function solanaSigOf(signedTxBase64) {
  return base58Encode(Buffer.from(signedTxBase64, 'base64').subarray(1, 65));
}
