import { describe, it, expect } from 'vitest';
import { RLP } from '@ethereumjs/rlp';
import {
  assertSolanaSignedMatches,
  assertEvmSignedMatches,
  decodeSignedEvmTransaction,
} from '../signed-tx-binding.js';
import {
  signEip1559Transaction,
  signLegacyTransaction,
  signSolanaTransaction,
  toBuffer,
} from '../trading.js';
import { keccak256, rlpEncode, signSecp256k1 } from '../crypto.js';
import { base58Decode, generateEvmWallet, generateSolanaWallet } from '../wallet.js';

// ============= EVM =============

const ROUTER = '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae';
const OTHER = '0x000000000000000000000000000000000000dead';

const wallet = generateEvmWallet();
const stranger = generateEvmWallet();

const SENT = {
  chainId: 8453,
  nonce: '0x5',
  gasLimit: '0x3d090',
  maxFeePerGas: '0x64b540',
  maxPriorityFeePerGas: '0x10c8e0',
  to: ROUTER,
  value: '0x2386f26fc10000',
  data: '0x4630a0d8' + 'ab'.repeat(40),
};

// Every field Privy is sent, in the shape signEip1559Transaction takes.
const sign1559 = (overrides = {}, key = wallet.privateKey) => signEip1559Transaction({ ...SENT, ...overrides }, key);
const FULL_EXPECTED = { ...SENT, type: 2, accessList: [] };

describe('decodeSignedEvmTransaction', () => {
  it('decodes a type-2 transaction and recovers the signer', () => {
    const tx = decodeSignedEvmTransaction(sign1559());
    expect(tx).toMatchObject({
      type: 2,
      chainId: 8453n,
      nonce: 5n,
      gasLimit: 250000n,
      maxFeePerGas: 6600000n,
      maxPriorityFeePerGas: 1100000n,
      to: ROUTER,
      value: 10000000000000000n,
      data: SENT.data,
      accessList: [],
      from: wallet.address.toLowerCase(),
    });
  });

  it('decodes an EIP-155 legacy transaction, chain id from v', () => {
    const signed = signLegacyTransaction({
      nonce: '0x7', gasPrice: '0x3b9aca00', gasLimit: '0x5208', to: ROUTER, value: '0x1', data: '0x', chainId: 8453,
    }, wallet.privateKey);
    expect(decodeSignedEvmTransaction(signed)).toMatchObject({
      type: 0, chainId: 8453n, nonce: 7n, gasPrice: 1000000000n, to: ROUTER, value: 1n, data: '0x',
      from: wallet.address.toLowerCase(),
    });
  });

  it('decodes a type-1 transaction', () => {
    const fields = [toBuffer(8453), toBuffer(1), toBuffer(1000), toBuffer(21000), toBuffer(ROUTER), toBuffer(5), toBuffer('0x'), []];
    const payload = Buffer.concat([Buffer.from([1]), rlpEncode(fields)]);
    const { r, s, v } = signSecp256k1(keccak256(payload), Buffer.from(wallet.privateKey, 'hex'));
    const strip = (b) => { let i = 0; while (i < b.length && b[i] === 0) i++; return b.subarray(i); };
    const signed = '0x' + Buffer.concat([Buffer.from([1]), rlpEncode([...fields, toBuffer(v), strip(r), strip(s)])]).toString('hex');
    expect(decodeSignedEvmTransaction(signed)).toMatchObject({
      type: 1, chainId: 8453n, nonce: 1n, gasPrice: 1000n, gasLimit: 21000n, value: 5n, from: wallet.address.toLowerCase(),
    });
  });

  it('refuses a legacy transaction without EIP-155 replay protection', () => {
    // v = 27: valid pre-EIP-155 shape, signable on any chain.
    const raw = RLP.encode([new Uint8Array([1]), new Uint8Array([1]), new Uint8Array([0x52, 0x08]), toBuffer(ROUTER), new Uint8Array(), new Uint8Array(), new Uint8Array([27]), new Uint8Array(32).fill(1), new Uint8Array(32).fill(1)]);
    expect(() => decodeSignedEvmTransaction('0x' + Buffer.from(raw).toString('hex'))).toThrow(/no EIP-155 chain id/);
  });

  it('refuses EIP-7702 set-code and blob transactions', () => {
    expect(() => decodeSignedEvmTransaction('0x04' + Buffer.from(RLP.encode([])).toString('hex'))).toThrow(/unsupported transaction type 0x04/);
    expect(() => decodeSignedEvmTransaction('0x03' + Buffer.from(RLP.encode([])).toString('hex'))).toThrow(/unsupported transaction type 0x03/);
  });

  it('refuses malformed bytes', () => {
    expect(() => decodeSignedEvmTransaction('0xdeadbeef01')).toThrow();
    expect(() => decodeSignedEvmTransaction('0xnothex')).toThrow(/not 0x-prefixed hex/);
    expect(() => decodeSignedEvmTransaction(undefined)).toThrow(/not 0x-prefixed hex/);
    // A valid type-2 envelope with trailing junk.
    expect(() => decodeSignedEvmTransaction(sign1559() + '00')).toThrow();
  });
});

describe('assertEvmSignedMatches', () => {
  it('accepts the transaction that was sent, signed by the wallet', () => {
    expect(() => assertEvmSignedMatches(sign1559(), FULL_EXPECTED, { from: wallet.address })).not.toThrow();
  });

  it('accepts decimal-string and bigint forms of the expected values', () => {
    expect(() => assertEvmSignedMatches(sign1559(), {
      ...FULL_EXPECTED, value: '10000000000000000', nonce: 5n, chainId: '8453',
    }, { from: wallet.address })).not.toThrow();
  });

  it.each([
    ['to', { to: OTHER }, /to is 0x0+dead/],
    ['data', { data: '0xa9059cbb' }, /data differs/],
    ['value', { value: '0x1' }, /value is 1, expected 10000000000000000/],
    ['chainId', { chainId: 1 }, /chainId is 1, expected 8453/],
    ['nonce', { nonce: '0x6' }, /nonce is 6, expected 5/],
    ['gasLimit', { gasLimit: '0x3d091' }, /gasLimit is 250001/],
    ['maxFeePerGas', { maxFeePerGas: '0x64b541' }, /maxFeePerGas is 6600001/],
    ['maxPriorityFeePerGas', { maxPriorityFeePerGas: '0x10c8df' }, /maxPriorityFeePerGas is 1099999/],
  ])('refuses a changed %s', (_name, change, message) => {
    expect(() => assertEvmSignedMatches(sign1559(change), FULL_EXPECTED, { from: wallet.address, label: 'swap transaction' }))
      .toThrow(expect.objectContaining({ code: 'SIGNED_TX_MISMATCH', message: expect.stringMatching(message) }));
  });

  it('refuses the right transaction signed by another key', () => {
    expect(() => assertEvmSignedMatches(sign1559({}, stranger.privateKey), FULL_EXPECTED, { from: wallet.address }))
      .toThrow(expect.objectContaining({ code: 'SIGNED_TX_MISMATCH', message: expect.stringMatching(/signed by 0x/) }));
  });

  it('refuses a different envelope type when the type is pinned', () => {
    const legacy = signLegacyTransaction({ nonce: '0x5', gasPrice: '0x64b540', gasLimit: '0x3d090', to: ROUTER, value: SENT.value, data: SENT.data, chainId: 8453 }, wallet.privateKey);
    expect(() => assertEvmSignedMatches(legacy, { to: ROUTER, value: SENT.value, data: SENT.data, chainId: 8453, type: 2 }, { from: wallet.address }))
      .toThrow(expect.objectContaining({ code: 'SIGNED_TX_MISMATCH', message: expect.stringMatching(/type is 0, expected 2/) }));
  });

  it('only compares the fields it is given (a wallet may choose nonce, gas and fees)', () => {
    const walletChosen = sign1559({ nonce: '0x63', gasLimit: '0x7a120', maxFeePerGas: '0x1', maxPriorityFeePerGas: '0x1' });
    expect(() => assertEvmSignedMatches(walletChosen, { to: ROUTER, value: SENT.value, data: SENT.data, chainId: 8453 }, { from: wallet.address }))
      .not.toThrow();
  });

  it('treats a missing data field as empty calldata', () => {
    const transfer = sign1559({ data: '0x' });
    expect(() => assertEvmSignedMatches(transfer, { to: ROUTER, value: SENT.value, chainId: 8453 }, { from: wallet.address })).not.toThrow();
    expect(() => assertEvmSignedMatches(transfer, { to: ROUTER, value: SENT.value, chainId: 8453, data: '0x12' }, { from: wallet.address }))
      .toThrow(/data differs/);
  });

  it('refuses bytes that do not decode, saying nothing was broadcast', () => {
    expect(() => assertEvmSignedMatches('0xdeadbeef01', FULL_EXPECTED, { from: wallet.address, label: 'approval transaction' }))
      .toThrow(expect.objectContaining({
        code: 'SIGNED_TX_MISMATCH',
        message: expect.stringMatching(/Refusing to broadcast the approval transaction: .*do not decode.*Nothing was broadcast\./),
      }));
  });

  it('uses the caller note in place of the default', () => {
    expect(() => assertEvmSignedMatches(sign1559({ to: OTHER }), FULL_EXPECTED, { from: wallet.address, note: 'The wallet may still have sent it.' }))
      .toThrow(/The wallet may still have sent it\.$/);
  });

  it('requires the expected signer and the core fields', () => {
    expect(() => assertEvmSignedMatches(sign1559(), FULL_EXPECTED, {})).toThrow(/expected signer .* is required/);
    expect(() => assertEvmSignedMatches(sign1559(), { to: ROUTER, value: '0x0' }, { from: wallet.address })).toThrow(/expected.chainId is required/);
  });
});

// ============= Solana =============

const solWallet = generateSolanaWallet();
const solOther = generateSolanaWallet();

// [sigCount][sigs][message]; message header + keys + blockhash + one instruction.
function unsignedTx(signerKeys, { requiredSigs = signerKeys.length, blockhash = 3, version0 = false } = {}) {
  const keys = signerKeys.map(k => base58Decode(k));
  const body = Buffer.concat([
    Buffer.from([requiredSigs, 0, 1, keys.length + 1]),
    ...keys,
    Buffer.alloc(32, 2),
    Buffer.alloc(32, blockhash),
    Buffer.from([1, keys.length, 1, 0, 1, 0]),
  ]);
  const message = version0 ? Buffer.concat([Buffer.from([0x80]), body, Buffer.from([0])]) : body;
  return Buffer.concat([Buffer.from([requiredSigs]), Buffer.alloc(64 * requiredSigs), message]).toString('base64');
}

// Sign slot `index` of a (possibly multi-signer) transaction.
function signSlot(txBase64, privateKeyHex, index) {
  const bytes = Buffer.from(txBase64, 'base64');
  const sigCount = bytes[0];
  const message = bytes.subarray(1 + 64 * sigCount);
  const oneSig = Buffer.from(signSolanaTransaction(Buffer.concat([Buffer.from([1]), Buffer.alloc(64), message]).toString('base64'), privateKeyHex), 'base64').subarray(1, 65);
  oneSig.copy(bytes, 1 + 64 * index);
  return bytes.toString('base64');
}

describe('assertSolanaSignedMatches', () => {
  it('accepts the same message signed by the wallet (legacy and v0)', () => {
    for (const version0 of [false, true]) {
      const tx = unsignedTx([solWallet.address], { version0 });
      expect(() => assertSolanaSignedMatches(tx, signSolanaTransaction(tx, solWallet.privateKey), { signer: solWallet.address })).not.toThrow();
    }
  });

  it('refuses a different message, even one the wallet validly signed', () => {
    const tx = unsignedTx([solWallet.address]);
    const substituted = signSolanaTransaction(unsignedTx([solWallet.address], { blockhash: 9 }), solWallet.privateKey);
    expect(() => assertSolanaSignedMatches(tx, substituted, { signer: solWallet.address, label: 'swap transaction' }))
      .toThrow(expect.objectContaining({ code: 'SIGNED_TX_MISMATCH', message: expect.stringMatching(/swap transaction: .*message bytes differ.*Nothing was broadcast/) }));
  });

  it('refuses a changed signature count', () => {
    const tx = unsignedTx([solWallet.address]);
    const signed = Buffer.from(signSolanaTransaction(tx, solWallet.privateKey), 'base64');
    const twoSigs = Buffer.concat([Buffer.from([2]), signed.subarray(1, 65), Buffer.alloc(64), signed.subarray(65)]).toString('base64');
    expect(() => assertSolanaSignedMatches(tx, twoSigs, { signer: solWallet.address })).toThrow(/signature count 2, expected 1/);
  });

  it('refuses an unsigned or invalidly signed wallet slot', () => {
    const tx = unsignedTx([solWallet.address]);
    expect(() => assertSolanaSignedMatches(tx, tx, { signer: solWallet.address })).toThrow(/no valid signature from/);
    const junk = Buffer.from(tx, 'base64');
    junk.fill(7, 1, 65);
    expect(() => assertSolanaSignedMatches(tx, junk.toString('base64'), { signer: solWallet.address })).toThrow(/no valid signature from/);
  });

  it('refuses a signature from another required signer while the wallet slot is empty', () => {
    const tx = unsignedTx([solOther.address, solWallet.address]);
    const onlyOther = signSlot(tx, solOther.privateKey, 0);
    expect(() => assertSolanaSignedMatches(tx, onlyOther, { signer: solWallet.address })).toThrow(/no valid signature from/);
  });

  it('accepts the wallet signing slot 1 while another signer (an x402 fee payer) has not signed yet', () => {
    const tx = unsignedTx([solOther.address, solWallet.address]);
    expect(() => assertSolanaSignedMatches(tx, signSlot(tx, solWallet.privateKey, 1), { signer: solWallet.address })).not.toThrow();
  });

  it('refuses when the wallet is not a required signer', () => {
    const tx = unsignedTx([solOther.address]);
    expect(() => assertSolanaSignedMatches(tx, signSolanaTransaction(tx, solOther.privateKey), { signer: solWallet.address }))
      .toThrow(/is not a required signer/);
  });

  it('refuses missing or unparseable returned bytes', () => {
    const tx = unsignedTx([solWallet.address]);
    expect(() => assertSolanaSignedMatches(tx, undefined, { signer: solWallet.address })).toThrow(/no signed transaction/);
    expect(() => assertSolanaSignedMatches(tx, Buffer.from([5]).toString('base64'), { signer: solWallet.address })).toThrow(/do not parse/);
  });

  it('requires the expected signer', () => {
    const tx = unsignedTx([solWallet.address]);
    expect(() => assertSolanaSignedMatches(tx, tx, {})).toThrow(/expected signer .* is required/);
  });
});
