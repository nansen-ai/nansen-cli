import { describe, it, expect } from 'vitest';
import { RLP } from '@ethereumjs/rlp';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak256 } from '../crypto.js';
import {
  signEvmTransaction,
  signEip1559Transaction,
  resolveQuoteEip1559Fees,
  resolveQuoteLegacyGasPrice,
  assertEvmFeeWithinCap,
  MAX_EVM_TX_FEE_WEI,
  parseMaxTxFeeOption,
} from '../trading.js';

// Valid secp256k1 scalar, matching the convention in perp.test.js. Deliberately
// not a random 64-hex literal: those read as a real private key to secret
// scanners, and nothing here depends on the key's value — the recovery test
// derives the expected address from it.
const KEY = '11'.repeat(32);
const BASE_CHAIN_ID = 8453;

function addressForKey(privHex) {
  const pub = secp256k1.getPublicKey(Buffer.from(privHex, 'hex'), false);
  return '0x' + Buffer.from(keccak256(Buffer.from(pub).subarray(1))).subarray(12).toString('hex');
}

function bufToBigInt(u8) {
  const hex = Buffer.from(u8).toString('hex');
  return hex === '' ? 0n : BigInt('0x' + hex);
}

// Decode 0x02 || RLP([...]) back into its 12 fields.
function decodeType2(raw) {
  const bytes = Buffer.from(raw.slice(2), 'hex');
  expect(bytes[0]).toBe(0x02);
  const fields = RLP.decode(Uint8Array.from(bytes.subarray(1)));
  return { fields, payload: bytes.subarray(1) };
}

const TX = {
  nonce: 18,
  // Numbers, not hand-written hex: the fee values are deliberately different so
  // a maxFee/priority transposition fails the ordering assertions below.
  maxPriorityFeePerGas: 1100000,
  maxFeePerGas: 6600000,
  gasLimit: 73112,
  to: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  value: '0x0',
  data: '0x095ea7b3',
  chainId: BASE_CHAIN_ID,
};

describe('signEip1559Transaction envelope', () => {
  const raw = signEip1559Transaction(TX, KEY);

  it('is a type-2 envelope with 12 RLP fields', () => {
    const { fields } = decodeType2(raw);
    expect(fields).toHaveLength(12);
  });

  // Pins the EIP-1559 field order independently of the signer: the fee values
  // differ, so swapping maxFee and priority would fail here.
  it('orders fields per EIP-1559', () => {
    const { fields } = decodeType2(raw);
    expect(bufToBigInt(fields[0])).toBe(BigInt(BASE_CHAIN_ID));
    expect(bufToBigInt(fields[1])).toBe(18n);
    expect(bufToBigInt(fields[2])).toBe(1100000n);            // maxPriorityFeePerGas
    expect(bufToBigInt(fields[3])).toBe(6600000n);            // maxFeePerGas
    expect(bufToBigInt(fields[4])).toBe(73112n);              // gasLimit
    expect('0x' + Buffer.from(fields[5]).toString('hex')).toBe(TX.to);
    expect(bufToBigInt(fields[6])).toBe(0n);                  // value
    expect('0x' + Buffer.from(fields[7]).toString('hex')).toBe(TX.data);
    expect(fields[8]).toEqual([]);                            // accessList
  });

  it('uses a raw yParity of 0 or 1, not an EIP-155 v', () => {
    const { fields } = decodeType2(raw);
    const yParity = bufToBigInt(fields[9]);
    expect([0n, 1n]).toContain(yParity);
    // EIP-155 would put chainId*2+35+bit here, which for Base is >= 16941.
    expect(yParity).toBeLessThan(2n);
  });

  // The real check: recover the signer from the signature over the unsigned
  // payload and confirm it is the key's own address. A wrong hash, wrong
  // yParity or mis-serialised r/s all fail here.
  it('recovers to the signing address', () => {
    const { fields } = decodeType2(raw);
    const unsignedPayload = Buffer.concat([
      Buffer.from([0x02]),
      Buffer.from(RLP.encode(fields.slice(0, 9))),
    ]);
    const msgHash = keccak256(unsignedPayload);

    const r = Buffer.from(fields[10]).toString('hex').padStart(64, '0');
    const s = Buffer.from(fields[11]).toString('hex').padStart(64, '0');
    const yParity = Number(bufToBigInt(fields[9]));

    const sig = secp256k1.Signature
      .fromBytes(Buffer.from(r + s, 'hex'), 'compact')
      .addRecoveryBit(yParity);
    const pub = sig.recoverPublicKey(msgHash).toBytes(false);
    const recovered = '0x' + Buffer.from(keccak256(Buffer.from(pub).subarray(1))).subarray(12).toString('hex');

    expect(recovered).toBe(addressForKey(KEY));
  });
});

describe('signEvmTransaction transaction-type selection', () => {
  const base = {
    to: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    data: '0x095ea7b3',
    value: '0',
    gas: '73112',
  };

  it('emits type 2 when the quote carries fee caps', () => {
    const raw = signEvmTransaction(
      { ...base, maxFeePerGas: '6600000', maxPriorityFeePerGas: '1100000' },
      KEY, 'base', 18,
    );
    expect(raw.startsWith('0x02')).toBe(true);
  });

  it('preserves both fee fields rather than flattening them', () => {
    const raw = signEvmTransaction(
      { ...base, maxFeePerGas: '6600000', maxPriorityFeePerGas: '1100000' },
      KEY, 'base', 18,
    );
    const { fields } = decodeType2(raw);
    expect(bufToBigInt(fields[2])).toBe(1100000n);
    expect(bufToBigInt(fields[3])).toBe(6600000n);
  });

  it('falls back to the fee cap when only maxFeePerGas is given', () => {
    const raw = signEvmTransaction({ ...base, maxFeePerGas: '6600000' }, KEY, 'base', 18);
    const { fields } = decodeType2(raw);
    expect(bufToBigInt(fields[2])).toBe(6600000n);
    expect(bufToBigInt(fields[3])).toBe(6600000n);
  });

  it('still emits legacy for a gasPrice-only quote', () => {
    const raw = signEvmTransaction({ ...base, gasPrice: '6600000' }, KEY, 'base', 18);
    expect(raw.startsWith('0x02')).toBe(false);
  });

  // The old fallback signed a 1-wei transaction: unmineable, and it burns the
  // nonce for every later attempt.
  it('refuses to sign when the quote has no fee information', () => {
    expect(() => signEvmTransaction({ ...base }, KEY, 'base', 18)).toThrow(
      /no gas price.*Refusing to sign/s,
    );
  });
});

// The Privy and approval/revoke signing paths do not go through
// signEvmTransaction, so they resolve their fee fields with these helpers.
// They used to fall back to 1,000,000 wei (0.001 gwei) — an unmineable fee
// that left the nonce stuck — and must refuse the same way instead.
describe('resolveQuoteEip1559Fees', () => {
  it('passes through EIP-1559 fields', () => {
    expect(resolveQuoteEip1559Fees({ maxFeePerGas: '6600000', maxPriorityFeePerGas: '1100000' }))
      .toEqual({ maxFeePerGas: '6600000', maxPriorityFeePerGas: '1100000' });
  });

  it('falls back to the fee cap when the priority fee is omitted', () => {
    expect(resolveQuoteEip1559Fees({ maxFeePerGas: '6600000' }))
      .toEqual({ maxFeePerGas: '6600000', maxPriorityFeePerGas: '6600000' });
  });

  it('lifts a legacy gasPrice into both EIP-1559 fields', () => {
    expect(resolveQuoteEip1559Fees({ gasPrice: '6600000' }))
      .toEqual({ maxFeePerGas: '6600000', maxPriorityFeePerGas: '6600000' });
  });

  it('refuses a quote with no fee information instead of inventing one', () => {
    expect(() => resolveQuoteEip1559Fees({ to: '0x1', data: '0x' })).toThrow(
      /no gas price.*Refusing to sign/s,
    );
    expect(() => resolveQuoteEip1559Fees({ maxFeePerGas: '', gasPrice: '' })).toThrow(
      /no gas price.*Refusing to sign/s,
    );
    expect(() => resolveQuoteEip1559Fees(undefined)).toThrow(/Refusing to sign/);
  });
});

describe('resolveQuoteLegacyGasPrice', () => {
  it('prefers gasPrice and flattens an EIP-1559-only quote to its fee cap', () => {
    expect(resolveQuoteLegacyGasPrice({ gasPrice: '6600000', maxFeePerGas: '9900000' })).toBe('6600000');
    expect(resolveQuoteLegacyGasPrice({ maxFeePerGas: '9900000' })).toBe('9900000');
  });

  it('refuses a quote with no fee information', () => {
    expect(() => resolveQuoteLegacyGasPrice({})).toThrow(/no gas price.*Refusing to sign/s);
    expect(() => resolveQuoteLegacyGasPrice(undefined)).toThrow(/Refusing to sign/);
  });
});

// The fee fields of a quote are signed verbatim, so a compromised or buggy
// aggregator response could make the wallet pay an arbitrary tip to the block
// producer. The Solana signer already caps the priority fee a single trade can
// pay (MAX_PRIORITY_FEE_LAMPORTS); this is the EVM sibling.
describe('assertEvmFeeWithinCap', () => {
  it('accepts a normal Base swap fee', () => {
    // 5 gwei x 300k gas = 0.0015 ETH
    expect(() => assertEvmFeeWithinCap('5000000000', 300000, 'swap')).not.toThrow();
    expect(() => assertEvmFeeWithinCap('0x12a05f200', '0x493e0', 'swap')).not.toThrow();
  });

  it('accepts a fee exactly at the cap and refuses one wei above it', () => {
    expect(MAX_EVM_TX_FEE_WEI).toBe(10n ** 18n);
    expect(() => assertEvmFeeWithinCap(MAX_EVM_TX_FEE_WEI, 1, 'swap')).not.toThrow();
    expect(() => assertEvmFeeWithinCap(MAX_EVM_TX_FEE_WEI / 1000000n, 1000000, 'swap')).not.toThrow();
    expect(() => assertEvmFeeWithinCap(MAX_EVM_TX_FEE_WEI + 1n, 1, 'swap')).toThrow(/fee cap/);
  });

  it('refuses a fee above the cap and names the numbers', () => {
    // 10,000 gwei x 300k gas = 3 ETH
    expect(() => assertEvmFeeWithinCap('10000000000000', 300000, 'swap'))
      .toThrow(/3000000000000000000 wei of gas for this swap.*1000000000000000000 wei fee cap.*Refusing to sign.*--max-tx-fee/s);
  });

  it('uses the cap it is given, and none for 0', () => {
    expect(() => assertEvmFeeWithinCap('10000000000000', 300000, 'swap', 3n * 10n ** 18n)).not.toThrow();
    expect(() => assertEvmFeeWithinCap('10000000000000', 300000, 'swap', 0n)).not.toThrow();
    expect(() => assertEvmFeeWithinCap('5000000000', 300000, 'swap', 10n ** 15n)).toThrow(/fee cap/);
  });

  it('refuses a zero, negative or malformed fee or gas limit', () => {
    expect(() => assertEvmFeeWithinCap('5000000000', 0, 'swap')).toThrow(/invalid gas limit for this swap \(0\)/);
    expect(() => assertEvmFeeWithinCap('5000000000', '0x0', 'swap')).toThrow(/invalid gas limit/);
    expect(() => assertEvmFeeWithinCap('0', 300000, 'swap')).toThrow(/invalid fee per gas/);
    expect(() => assertEvmFeeWithinCap('-1', 300000, 'swap')).toThrow(/invalid fee per gas for this swap \(-1\)/);
    expect(() => assertEvmFeeWithinCap('5 gwei', 300000, 'swap')).toThrow(/invalid fee per gas/);
    expect(() => assertEvmFeeWithinCap(1.5, 300000, 'swap')).toThrow(/invalid fee per gas/);
    // still refused with the cap disabled
    expect(() => assertEvmFeeWithinCap('5000000000', 0, 'swap', 0n)).toThrow(/invalid gas limit/);
  });
});

describe('parseMaxTxFeeOption', () => {
  it('defaults to the cap and reads ETH digit-wise', () => {
    expect(parseMaxTxFeeOption(undefined)).toBe(MAX_EVM_TX_FEE_WEI);
    expect(parseMaxTxFeeOption('0')).toBe(0n);
    expect(parseMaxTxFeeOption('0.5')).toBe(5n * 10n ** 17n);
    expect(parseMaxTxFeeOption('.25')).toBe(25n * 10n ** 16n);
    expect(parseMaxTxFeeOption(' 2 ')).toBe(2n * 10n ** 18n);
    expect(parseMaxTxFeeOption('1.000000000000000001')).toBe(10n ** 18n + 1n);
  });

  it('refuses anything else', () => {
    for (const bad of ['', '-1', 'abc', '1e18', '1.', '0.0000000000000000001', 'true']) {
      expect(() => parseMaxTxFeeOption(bad), bad).toThrow(/Invalid --max-tx-fee/);
    }
  });

  // parseArgs JSON-parses option values and accumulates a repeated option into
  // an array, so String() would turn `--max-tx-fee '[0]'` into "0" and disable
  // the cap without saying so.
  it('refuses a non-scalar value instead of coercing it', () => {
    for (const bad of [[0], [2], ['0'], {}, true]) {
      expect(() => parseMaxTxFeeOption(bad), JSON.stringify(bad)).toThrow(/single value in ETH/);
    }
  });
});

describe('signEvmTransaction fee ceiling', () => {
  const base = { to: '0x' + '11'.repeat(20), data: '0x', value: '0', gas: '300000' };

  it('refuses an EIP-1559 quote whose fee cap is anomalous', () => {
    expect(() => signEvmTransaction({ ...base, maxFeePerGas: '10000000000000' }, KEY, 'base', 1))
      .toThrow(/fee cap/);
  });

  it('refuses a legacy quote whose gas price is anomalous', () => {
    expect(() => signEvmTransaction({ ...base, gasPrice: '10000000000000' }, KEY, 'base', 1))
      .toThrow(/fee cap/);
  });

  it('names what is being signed and uses the given cap', () => {
    expect(() => signEvmTransaction({ ...base, maxFeePerGas: '10000000000000' }, KEY, 'base', 1, { label: 'bridge step "deposit"' }))
      .toThrow(/for this bridge step "deposit"/);
    expect(signEvmTransaction({ ...base, maxFeePerGas: '10000000000000' }, KEY, 'base', 1, { maxTxFeeWei: 0n })).toMatch(/^0x02/);
  });

  it('refuses a quote with a zero gas limit', () => {
    expect(() => signEvmTransaction({ ...base, gas: '0', maxFeePerGas: '5000000000' }, KEY, 'base', 1))
      .toThrow(/invalid gas limit/);
  });

  it('still signs a normal quote', () => {
    expect(signEvmTransaction({ ...base, maxFeePerGas: '5000000000' }, KEY, 'base', 1)).toMatch(/^0x02/);
    expect(signEvmTransaction({ ...base, gasPrice: '5000000000' }, KEY, 'base', 1)).toMatch(/^0x/);
  });
});
