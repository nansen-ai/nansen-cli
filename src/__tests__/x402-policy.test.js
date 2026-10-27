/**
 * Tests for src/x402-policy.js
 * Covers the known-asset allowlist, per-payment USD cap, payTo allowlist, and
 * the session and daily cumulative caps.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock wallet.js so getWalletConfig doesn't touch the filesystem.
vi.mock('../wallet.js', () => ({
  getWalletConfig: () => ({}),
}));

// Import after mock is registered.
const {
  resolveKnownToken,
  evaluatePaymentRequirement,
  resolveMaxAmountUsd,
  resolvePaymentAmount,
  resolvePayTo,
  isPayToAllowed,
  DEFAULT_X402_MAX_AMOUNT_USD,
  SUPPORTED_X402_SCHEMES,
  chargeSessionSpend,
  chargeDailySpend,
  resolveSessionMaxMicroUsd,
  resolveDailyMaxMicroUsd,
  spendCapConfigError,
  signWithSpendCharge,
  resetSpendCapsForTests,
} = await import('../x402-policy.js');
const { SOLANA_MAINNET_NETWORK } = await import('../x402-tokens.js');
const { x402SpendLedgerPath } = await import('../x402-spend-ledger.js');

// Canonical Base USDC requirement for reuse across tests.
const BASE_USDC_REQUIREMENT = {
  scheme: 'exact',
  network: 'eip155:8453',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  amount: '10000', // 0.01 USDC (6 decimals)
  pay_to: '0xPaymentRecipient',
};

describe('resolveKnownToken', () => {
  it('returns token metadata for Base USDC', () => {
    const entry = resolveKnownToken('eip155:8453', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
    expect(entry).toMatchObject({ symbol: 'USDC', decimals: 6 });
  });

  it('is case-insensitive on the asset address', () => {
    const entry = resolveKnownToken('eip155:8453', '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');
    expect(entry).not.toBeNull();
  });

  it('returns null for an unknown asset on a known network', () => {
    const entry = resolveKnownToken('eip155:8453', '0xdeaddeaddeaddeaddeaddeaddeaddeaddead0001');
    expect(entry).toBeNull();
  });

  it('returns null for an unknown network', () => {
    const entry = resolveKnownToken('eip155:1', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
    expect(entry).toBeNull();
  });

  it('returns Solana USDC for the solana network', () => {
    const entry = resolveKnownToken('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    expect(entry).toMatchObject({ symbol: 'USDC', decimals: 6 });
  });

  it('returns null when network or asset is not a string', () => {
    expect(resolveKnownToken(null, '0x123')).toBeNull();
    expect(resolveKnownToken('eip155:8453', null)).toBeNull();
  });

  it('is case-SENSITIVE on Solana mint addresses (base58, not checksummed hex)', () => {
    // Regression: flipping case in a base58 string decodes to different bytes
    // entirely — unlike EVM hex, there is no case-insensitive equivalence.
    const caseFlipped = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1V'; // last char V not v
    const entry = resolveKnownToken('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', caseFlipped);
    expect(entry).toBeNull();
  });

  it('requires the exact "solana:" prefix, matching isSvmNetwork (no bare "solana" match)', () => {
    // Regression: resolveKnownToken previously used network.startsWith('solana')
    // (no colon), which disagreed with isSvmNetwork()'s exact 'solana:' check
    // in x402-svm.js and could let the guard approve a requirement neither
    // isEvmNetwork nor isSvmNetwork would ever dispatch to a signer.
    const entry = resolveKnownToken('solana-devnet', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    expect(entry).toBeNull();
  });

  it('returns null for a well-formed but unknown solana:* CAIP-2 network id', () => {
    // A solana:* string that is not the known mainnet id must not resolve to any
    // token — previously the prefix match mapped any solana:* to mainnet.
    const entry = resolveKnownToken('solana:not-a-real-network-id', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    expect(entry).toBeNull();
  });

  it('returns USDC for exact Solana mainnet CAIP-2 id (regression guard)', () => {
    const entry = resolveKnownToken(SOLANA_MAINNET_NETWORK, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    expect(entry).toMatchObject({ symbol: 'USDC', decimals: 6 });
  });
});

describe('resolvePayTo', () => {
  it('prefers payTo over pay_to', () => {
    expect(resolvePayTo({ payTo: '0xCamel', pay_to: '0xSnake' })).toBe('0xCamel');
  });

  it('falls back to pay_to when payTo is undefined', () => {
    expect(resolvePayTo({ pay_to: '0xSnake' })).toBe('0xSnake');
  });

  it('falls back to pay_to when payTo is an empty string', () => {
    // Regression: an empty payTo must not be treated as a real recipient —
    // this is the same class of bug resolvePaymentAmount closes for amount.
    expect(resolvePayTo({ payTo: '', pay_to: '0xSnake' })).toBe('0xSnake');
  });
});

describe('SUPPORTED_X402_SCHEMES', () => {
  it('contains only "exact"', () => {
    expect([...SUPPORTED_X402_SCHEMES]).toEqual(['exact']);
  });
});

describe('evaluatePaymentRequirement — scheme gate', () => {
  it('refuses an unsupported scheme before checking asset/network', () => {
    const req = { ...BASE_USDC_REQUIREMENT, scheme: 'streaming' };
    const result = evaluatePaymentRequirement(req);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/unsupported payment scheme/i);
    expect(result.reason).toContain('"streaming"');
  });

  it('refuses when scheme is absent', () => {
    const req = { ...BASE_USDC_REQUIREMENT };
    delete req.scheme;
    const result = evaluatePaymentRequirement(req);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/unsupported payment scheme/i);
    expect(result.reason).toContain('(missing)');
  });

  it('allows scheme "exact" (regression guard on the happy path)', () => {
    const result = evaluatePaymentRequirement(BASE_USDC_REQUIREMENT);
    expect(result.ok).toBe(true);
  });
});

describe('evaluatePaymentRequirement — allowlist and basic pass', () => {
  it('1. known Base USDC small amount → ok, correct usd', () => {
    const result = evaluatePaymentRequirement(BASE_USDC_REQUIREMENT);
    expect(result.ok).toBe(true);
    expect(result.usd).toBeCloseTo(0.01, 5);
    expect(result.symbol).toBe('USDC');
  });

  it('returns the payment details it approved, for the audit log', () => {
    expect(evaluatePaymentRequirement({ ...BASE_USDC_REQUIREMENT, amount: 10000n })).toMatchObject({
      ok: true,
      network: 'eip155:8453',
      asset: BASE_USDC_REQUIREMENT.asset,
      payTo: '0xPaymentRecipient', // resolved from the pay_to alias
      amountRaw: '10000', // always a string, even from a BigInt amount
    });
  });

  it.each(['0x2710', 1e4, ' 10000 '])('normalizes the approved amount %j to decimal base units', (amount) => {
    expect(evaluatePaymentRequirement({ ...BASE_USDC_REQUIREMENT, amount })).toMatchObject({ ok: true, amountRaw: '10000' });
  });

  it('4. unknown asset on known network → refused (allowlist)', () => {
    const req = { ...BASE_USDC_REQUIREMENT, asset: '0xdeaddeaddeaddeaddeaddeaddeaddeaddead0001' };
    const result = evaluatePaymentRequirement(req);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not a recognized/i);
  });

  it('5. unknown network → refused', () => {
    const req = { ...BASE_USDC_REQUIREMENT, network: 'eip155:1' };
    const result = evaluatePaymentRequirement(req);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not a recognized/i);
  });

  it('well-formed solana:* CAIP-2 id that is not mainnet → refused', () => {
    // Previously any solana:* string was accepted; now only the exact mainnet id is.
    const req = {
      scheme: 'exact',
      network: 'solana:not-a-real-network-id',
      asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      amount: '10000',
      pay_to: '0xPaymentRecipient',
    };
    const result = evaluatePaymentRequirement(req);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not a recognized/i);
  });

  it('10. malformed amount → refused, no throw', () => {
    const req = { ...BASE_USDC_REQUIREMENT, amount: 'not-a-number' };
    const result = evaluatePaymentRequirement(req);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/unparseable amount/i);
  });

  it('10a. missing amount and maxAmountRequired → refused with clear message', () => {
    const req = { ...BASE_USDC_REQUIREMENT };
    delete req.amount;
    delete req.maxAmountRequired;
    const result = evaluatePaymentRequirement(req);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/amount field is missing/i);
  });

  it('11. negative amount → refused, no throw', () => {
    const req = { ...BASE_USDC_REQUIREMENT, amount: '-1000000' };
    const result = evaluatePaymentRequirement(req);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/negative amount/i);
  });

  it('12. missing payTo and pay_to → refused with clear message', () => {
    const req = { ...BASE_USDC_REQUIREMENT };
    delete req.payTo;
    delete req.pay_to;
    const result = evaluatePaymentRequirement(req);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/payTo field is missing/i);
  });

  it('13. payTo and pay_to both empty strings → refused, not resolved to "" (reviewer regression)', () => {
    // resolvePayTo("") falls through to pay_to, but pay_to is also "" here, so
    // the resolved value is itself "" — must be treated as missing, not as a
    // real (empty) recipient that then reaches a signer's deriveATA/EIP-712.
    const req = { ...BASE_USDC_REQUIREMENT, payTo: '', pay_to: '' };
    const result = evaluatePaymentRequirement(req);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/payTo field is missing/i);
  });

  it('uses pay_to field when payTo is absent', () => {
    const req = { ...BASE_USDC_REQUIREMENT };
    delete req.payTo;
    const result = evaluatePaymentRequirement(req);
    expect(result.ok).toBe(true);
  });

  it('falls back to pay_to when payTo is an empty string (not refused by an unset allowlist)', () => {
    // Regression: empty payTo must resolve to pay_to everywhere the guard and
    // the signers look at it, exactly like the amount empty-string fallback.
    const req = { ...BASE_USDC_REQUIREMENT, payTo: '' };
    const result = evaluatePaymentRequirement(req);
    expect(result.ok).toBe(true);
  });

  it('falls back to maxAmountRequired when amount is absent (v1 field name)', () => {
    // Older x402 implementations send maxAmountRequired instead of amount.
    // The guard must normalise both so it does not block payments the signing
    // paths would handle correctly.
    const req = { ...BASE_USDC_REQUIREMENT };
    delete req.amount;
    req.maxAmountRequired = '10000'; // 0.01 USDC — within cap
    const result = evaluatePaymentRequirement(req);
    expect(result.ok).toBe(true);
    expect(result.usd).toBeCloseTo(0.01, 5);
  });

  it('maxAmountRequired=0 is honoured (not replaced by undefined)', () => {
    // ?? not || ensures a literal 0 amount is not treated as falsy.
    const req = { ...BASE_USDC_REQUIREMENT };
    delete req.amount;
    req.maxAmountRequired = '0';
    const result = evaluatePaymentRequirement(req);
    expect(result.ok).toBe(true);
    expect(result.usd).toBe(0);
  });

  it('empty-string amount falls back to maxAmountRequired instead of evaluating as $0 (cap-bypass regression)', () => {
    // A malicious server sending amount: "" alongside a huge maxAmountRequired
    // must not slip through the cap at $0.00 while a signer later substitutes
    // maxAmountRequired for the falsy amount and signs the large value instead.
    const req = { ...BASE_USDC_REQUIREMENT, amount: '', maxAmountRequired: '1000000000000' };
    const result = evaluatePaymentRequirement(req);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/exceeds the/i);
  });
});

describe('resolvePaymentAmount', () => {
  it('prefers amount over maxAmountRequired', () => {
    expect(resolvePaymentAmount({ amount: '10000', maxAmountRequired: '999' })).toBe('10000');
  });

  it('falls back to maxAmountRequired when amount is undefined', () => {
    expect(resolvePaymentAmount({ maxAmountRequired: '10000' })).toBe('10000');
  });

  it('falls back to maxAmountRequired when amount is an empty string', () => {
    expect(resolvePaymentAmount({ amount: '', maxAmountRequired: '10000' })).toBe('10000');
  });

  it('keeps a literal 0 amount instead of falling back', () => {
    expect(resolvePaymentAmount({ amount: 0, maxAmountRequired: '10000' })).toBe(0);
  });
});

describe('evaluatePaymentRequirement — USD cap', () => {
  afterEach(() => {
    delete process.env.NANSEN_X402_MAX_AMOUNT;
  });

  it('2. very large amount on known asset → refused (cap)', () => {
    // $1,000,000 in USDC base units = 1_000_000_000_000 (6 decimals)
    const req = { ...BASE_USDC_REQUIREMENT, amount: '1000000000000' };
    const result = evaluatePaymentRequirement(req);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/exceeds the/i);
  });

  it('3a. amount just over $1.00 default cap → refused', () => {
    // $1.01 = 1_010_000 base units (USDC 6 decimals)
    const req = { ...BASE_USDC_REQUIREMENT, amount: '1010000' };
    const result = evaluatePaymentRequirement(req);
    expect(result.ok).toBe(false);
  });

  it('3b. amount just under $1.00 default cap → allowed', () => {
    // $0.99 = 990_000 base units
    const req = { ...BASE_USDC_REQUIREMENT, amount: '990000' };
    const result = evaluatePaymentRequirement(req);
    expect(result.ok).toBe(true);
  });

  it('3c. amount exactly at $1.00 default cap → allowed (inclusive boundary)', () => {
    // $1.00 = 1_000_000 base units; cap check is `usd > cap`, so exact cap passes
    const req = { ...BASE_USDC_REQUIREMENT, amount: '1000000' };
    const result = evaluatePaymentRequirement(req);
    expect(result.ok).toBe(true);
    expect(result.usd).toBe(1);
  });

  it('6. NANSEN_X402_MAX_AMOUNT=unlimited → $1M allowed', () => {
    process.env.NANSEN_X402_MAX_AMOUNT = 'unlimited';
    const req = { ...BASE_USDC_REQUIREMENT, amount: '1000000000000' };
    const result = evaluatePaymentRequirement(req);
    expect(result.ok).toBe(true);
  });

  it('7a. custom cap $5 → $3 payment allowed', () => {
    process.env.NANSEN_X402_MAX_AMOUNT = '5.00';
    const req = { ...BASE_USDC_REQUIREMENT, amount: '3000000' }; // $3.00
    const result = evaluatePaymentRequirement(req);
    expect(result.ok).toBe(true);
  });

  it('7b. custom cap $5 → $6 payment refused', () => {
    process.env.NANSEN_X402_MAX_AMOUNT = '5.00';
    const req = { ...BASE_USDC_REQUIREMENT, amount: '6000000' }; // $6.00
    const result = evaluatePaymentRequirement(req);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/exceeds/i);
  });
});

describe('evaluatePaymentRequirement — payTo allowlist', () => {
  afterEach(() => {
    delete process.env.NANSEN_X402_ALLOWED_PAYTO;
    delete process.env.NANSEN_X402_MAX_AMOUNT;
  });

  it('8a. NANSEN_X402_ALLOWED_PAYTO matches pay_to → allowed', () => {
    process.env.NANSEN_X402_ALLOWED_PAYTO = '0xPaymentRecipient,0xOtherAddr';
    const result = evaluatePaymentRequirement(BASE_USDC_REQUIREMENT);
    expect(result.ok).toBe(true);
  });

  it('8b. NANSEN_X402_ALLOWED_PAYTO does not match → refused', () => {
    process.env.NANSEN_X402_ALLOWED_PAYTO = '0xSomeOtherAddress';
    const result = evaluatePaymentRequirement(BASE_USDC_REQUIREMENT);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/NANSEN_X402_ALLOWED_PAYTO/);
  });

  it('8c. NANSEN_X402_ALLOWED_PAYTO unset → any recipient allowed (subject to cap)', () => {
    const req = { ...BASE_USDC_REQUIREMENT, pay_to: '0xArbitraryAddress' };
    const result = evaluatePaymentRequirement(req);
    expect(result.ok).toBe(true);
  });

  it('payTo takes precedence over pay_to — allowlist bypass attack is blocked', () => {
    // A server that sends { pay_to: "0xAllowed", payTo: "0xAttacker" } must be
    // refused: the policy must evaluate the same field the signing paths use.
    // Signing paths (WalletConnect, Privy, EVM, SVM) all prefer payTo (camelCase)
    // so the policy must also read payTo first.
    process.env.NANSEN_X402_ALLOWED_PAYTO = '0xAllowed';
    const req = {
      ...BASE_USDC_REQUIREMENT,
      payTo: '0xAttacker',
      pay_to: '0xAllowed',
    };
    const result = evaluatePaymentRequirement(req);
    // Policy sees payTo = "0xAttacker" which is NOT in the allowlist → refused
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/NANSEN_X402_ALLOWED_PAYTO/);
  });

  it('pay_to used as fallback when payTo is absent', () => {
    // Only pay_to present (v1 field name): should still be evaluated correctly.
    process.env.NANSEN_X402_ALLOWED_PAYTO = '0xPaymentRecipient';
    const req = { ...BASE_USDC_REQUIREMENT };
    delete req.payTo;
    req.pay_to = '0xPaymentRecipient';
    const result = evaluatePaymentRequirement(req);
    expect(result.ok).toBe(true);
  });
});

describe('evaluatePaymentRequirement — 18-decimal BSC token conversion', () => {
  afterEach(() => {
    delete process.env.NANSEN_X402_MAX_AMOUNT;
  });

  it('9. BSC USDT (18 decimals), small USD amount → correct conversion, allowed', () => {
    // 0.01 USDT on BSC = 10_000_000_000_000_000 base units (18 decimals)
    process.env.NANSEN_X402_MAX_AMOUNT = '1.00';
    const req = {
      scheme: 'exact',
      network: 'eip155:56',
      asset: '0x55d398326f99059fF775485246999027B3197955', // USDT on BSC
      amount: '10000000000000000', // 0.01 USDT
      pay_to: '0xAny',
    };
    const result = evaluatePaymentRequirement(req);
    expect(result.ok).toBe(true);
    expect(result.usd).toBeCloseTo(0.01, 5);
    expect(result.symbol).toBe('USDT');
  });
});

describe('resolveMaxAmountUsd', () => {
  afterEach(() => {
    delete process.env.NANSEN_X402_MAX_AMOUNT;
  });

  it('returns the default when env var is unset', () => {
    expect(resolveMaxAmountUsd()).toBe(DEFAULT_X402_MAX_AMOUNT_USD);
  });

  it('parses a numeric env var', () => {
    process.env.NANSEN_X402_MAX_AMOUNT = '5';
    expect(resolveMaxAmountUsd()).toBe(5);
  });

  it('returns Infinity for "unlimited"', () => {
    process.env.NANSEN_X402_MAX_AMOUNT = 'unlimited';
    expect(resolveMaxAmountUsd()).toBe(Infinity);
  });

  it('ignores garbage env var and falls through to default', () => {
    process.env.NANSEN_X402_MAX_AMOUNT = 'garbage';
    expect(resolveMaxAmountUsd()).toBe(DEFAULT_X402_MAX_AMOUNT_USD);
  });

  it('treats an empty-string env var as unset rather than a $0.00 cap', () => {
    // Number('') === 0, which would otherwise refuse every non-zero payment.
    process.env.NANSEN_X402_MAX_AMOUNT = '';
    expect(resolveMaxAmountUsd()).toBe(DEFAULT_X402_MAX_AMOUNT_USD);
  });

  it('treats a whitespace-only env var as unset', () => {
    process.env.NANSEN_X402_MAX_AMOUNT = '   ';
    expect(resolveMaxAmountUsd()).toBe(DEFAULT_X402_MAX_AMOUNT_USD);
  });
});

describe('isPayToAllowed', () => {
  afterEach(() => {
    delete process.env.NANSEN_X402_ALLOWED_PAYTO;
  });

  it('returns true when env var is unset', () => {
    expect(isPayToAllowed('0xAnything')).toBe(true);
  });

  it('returns true for an address in the allowlist (case-insensitive)', () => {
    process.env.NANSEN_X402_ALLOWED_PAYTO = '0xABC,0xDEF';
    expect(isPayToAllowed('0xabc')).toBe(true);
  });

  it('returns false for an address not in the allowlist', () => {
    process.env.NANSEN_X402_ALLOWED_PAYTO = '0xABC';
    expect(isPayToAllowed('0xXYZ')).toBe(false);
  });

  it('is case-insensitive for an EVM network', () => {
    process.env.NANSEN_X402_ALLOWED_PAYTO = '0xAbCdEf';
    expect(isPayToAllowed('0xabcdef', 'eip155:8453')).toBe(true);
  });

  it('is case-SENSITIVE for a Solana network (base58 allowlist)', () => {
    // Regression: lowercasing both sides let a case-flipped Solana address
    // pass an allowlist meant to restrict to one exact address.
    const real = 'J7ZvJEspvwP1oRxQZ7mYmNmT22NTm3GWq3t7HEbvPZYx';
    const caseFlipped = 'J7ZvJEspvwP1oRxQZ7mYmNmT22NTm3GWq3t7HEbvPZYX'; // last char X not x
    process.env.NANSEN_X402_ALLOWED_PAYTO = real;
    expect(isPayToAllowed(real, 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp')).toBe(true);
    expect(isPayToAllowed(caseFlipped, 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp')).toBe(false);
  });
});

describe('resolveSessionMaxMicroUsd', () => {
  afterEach(() => {
    delete process.env.NANSEN_X402_SESSION_MAX_AMOUNT;
  });

  it.each([undefined, '', '   ', 'unlimited', 'UNLIMITED'])('disables the cap for %j', (value) => {
    if (value !== undefined) process.env.NANSEN_X402_SESSION_MAX_AMOUNT = value;
    expect(resolveSessionMaxMicroUsd()).toBeNull();
  });

  it('converts a USD amount to micro-USD without float error', () => {
    process.env.NANSEN_X402_SESSION_MAX_AMOUNT = '0.29'; // 0.29 * 1e6 is 289999.99999999994
    expect(resolveSessionMaxMicroUsd()).toBe(290_000n);
  });

  it('parses the decimal exactly and drops digits past the sixth', () => {
    process.env.NANSEN_X402_SESSION_MAX_AMOUNT = ' 2.50 ';
    expect(resolveSessionMaxMicroUsd()).toBe(2_500_000n);
    process.env.NANSEN_X402_SESSION_MAX_AMOUNT = '0.0000019';
    expect(resolveSessionMaxMicroUsd()).toBe(1n);
    process.env.NANSEN_X402_SESSION_MAX_AMOUNT = '1' + '0'.repeat(400);
    expect(resolveSessionMaxMicroUsd()).toBe(10n ** 406n);
  });

  it.each(['garbage', '-1', 'NaN', 'Infinity', '1e308', '1e3', '0x10', '.5', '5.', '1_000'])('returns an error instead of disabling the cap for %j', (value) => {
    process.env.NANSEN_X402_SESSION_MAX_AMOUNT = value;
    expect(resolveSessionMaxMicroUsd().error).toMatch(/NANSEN_X402_SESSION_MAX_AMOUNT=.* is not a valid USD amount/);
  });
});

describe('spendCapConfigError', () => {
  beforeEach(() => resetSpendCapsForTests());
  afterEach(() => {
    delete process.env.NANSEN_X402_SESSION_MAX_AMOUNT;
    resetSpendCapsForTests();
  });

  it.each([undefined, 'unlimited', '0', '5.00'])('is null for %j', (value) => {
    if (value !== undefined) process.env.NANSEN_X402_SESSION_MAX_AMOUNT = value;
    expect(spendCapConfigError()).toBeNull();
  });

  it('returns the refusal reason for an invalid value', () => {
    process.env.NANSEN_X402_SESSION_MAX_AMOUNT = '1e3';
    expect(spendCapConfigError()).toBe(
      'Refusing to auto-pay: NANSEN_X402_SESSION_MAX_AMOUNT="1e3" is not a valid USD amount. ' +
      'Set it to a number such as 5.00, or unset it to disable the session cap. No signature was produced.',
    );
  });
});

describe('chargeSessionSpend', () => {
  const approve = (amount, requirement = BASE_USDC_REQUIREMENT) => {
    const decision = evaluatePaymentRequirement({ ...requirement, amount });
    expect(decision.ok).toBe(true);
    return decision;
  };

  beforeEach(() => resetSpendCapsForTests());
  afterEach(() => {
    delete process.env.NANSEN_X402_SESSION_MAX_AMOUNT;
    resetSpendCapsForTests();
  });

  it('always passes when the cap is unset', () => {
    for (let i = 0; i < 1000; i++) expect(chargeSessionSpend(approve('1000000')).ok).toBe(true);
  });

  it('allows payments up to and including the cap, then refuses', () => {
    process.env.NANSEN_X402_SESSION_MAX_AMOUNT = '0.03';
    expect(chargeSessionSpend(approve('10000')).ok).toBe(true);
    expect(chargeSessionSpend(approve('10000')).ok).toBe(true);
    expect(chargeSessionSpend(approve('10000')).ok).toBe(true); // exactly $0.03

    const refused = chargeSessionSpend(approve('10000'));
    expect(refused.ok).toBe(false);
    expect(refused.reason).toBe(
      'Refusing to auto-pay $0.01 USDC: this process has already auto-paid $0.03, and the payment would exceed ' +
      'the $0.03 session cap. To authorize, raise it with NANSEN_X402_SESSION_MAX_AMOUNT=<usd> (or unset it to disable). ' +
      'No signature was produced.',
    );
  });

  it('does not drift past an exact cap the way float sums do', () => {
    // 0.1 + 0.2 > 0.3 in floating point.
    process.env.NANSEN_X402_SESSION_MAX_AMOUNT = '0.3';
    expect(chargeSessionSpend(approve('100000')).ok).toBe(true);
    expect(chargeSessionSpend(approve('200000')).ok).toBe(true);
  });

  it('does not add a refused payment to the total', () => {
    process.env.NANSEN_X402_SESSION_MAX_AMOUNT = '0.05';
    expect(chargeSessionSpend(approve('40000')).ok).toBe(true);
    expect(chargeSessionSpend(approve('20000')).ok).toBe(false);
    expect(chargeSessionSpend(approve('10000')).ok).toBe(true); // 0.04 + 0.01, not 0.04 + 0.02 + 0.01
  });

  it('returns a released charge to the total, once', () => {
    process.env.NANSEN_X402_SESSION_MAX_AMOUNT = '0.02';
    expect(chargeSessionSpend(approve('10000')).ok).toBe(true);
    const failed = chargeSessionSpend(approve('10000'));
    expect(failed.ok).toBe(true);
    expect(chargeSessionSpend(approve('10000')).ok).toBe(false);

    failed.release();
    failed.release(); // a second release must not free more than was charged
    expect(chargeSessionSpend(approve('10000')).ok).toBe(true);
    expect(chargeSessionSpend(approve('10000')).ok).toBe(false);
  });

  it('reads the cap once, so changing the variable mid-run has no effect', () => {
    process.env.NANSEN_X402_SESSION_MAX_AMOUNT = '0.01';
    expect(chargeSessionSpend(approve('10000')).ok).toBe(true);
    process.env.NANSEN_X402_SESSION_MAX_AMOUNT = '100';
    expect(chargeSessionSpend(approve('10000')).ok).toBe(false);
  });

  it('shows sub-cent amounts with up to six decimals', () => {
    process.env.NANSEN_X402_SESSION_MAX_AMOUNT = '0.003';
    expect(chargeSessionSpend(approve('1500')).ok).toBe(true);
    expect(chargeSessionSpend(approve('1500')).ok).toBe(true);
    const refused = chargeSessionSpend(approve('1'));
    expect(refused.reason).toContain(
      'Refusing to auto-pay $0.000001 USDC: this process has already auto-paid $0.003, and the payment would exceed the $0.003 session cap.',
    );
  });

  it('charges the amount the policy decision carries, so both caps price a payment the same way', () => {
    process.env.NANSEN_X402_SESSION_MAX_AMOUNT = '0.02';
    const decision = approve('10000');
    expect(decision.amountMicroUsd).toBe('10000');
    expect(() => JSON.stringify(decision)).not.toThrow();
    expect(chargeSessionSpend({ ...decision, amountMicroUsd: '30000' }).ok).toBe(false);
    expect(chargeSessionSpend({ ...decision, amountMicroUsd: undefined }).reason).toContain('payment amount is unknown');
  });

  it('rounds a sub-micro-dollar 18-decimal amount up rather than charging zero', () => {
    process.env.NANSEN_X402_SESSION_MAX_AMOUNT = '0';
    const bsc = { scheme: 'exact', network: 'eip155:56', asset: '0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d', payTo: '0xRecipient' };
    expect(chargeSessionSpend(approve('1', bsc)).ok).toBe(false);
  });

  it('refuses every payment while the cap value is invalid', () => {
    process.env.NANSEN_X402_SESSION_MAX_AMOUNT = '5usd';
    const refused = chargeSessionSpend(approve('10000'));
    expect(refused.ok).toBe(false);
    expect(refused.reason).toContain('NANSEN_X402_SESSION_MAX_AMOUNT="5usd" is not a valid USD amount');
  });
});

describe('signWithSpendCharge', () => {
  const decision = () => evaluatePaymentRequirement({ ...BASE_USDC_REQUIREMENT, amount: '10000' });

  beforeEach(() => {
    resetSpendCapsForTests();
    process.env.NANSEN_X402_SESSION_MAX_AMOUNT = '0.01';
  });
  afterEach(() => {
    delete process.env.NANSEN_X402_SESSION_MAX_AMOUNT;
    resetSpendCapsForTests();
  });

  it('returns the signature with a release that frees the charge', async () => {
    const signed = await signWithSpendCharge(decision(), async () => 'sig');
    expect(signed).toEqual({ ok: true, value: 'sig', release: expect.any(Function) });
    expect(chargeSessionSpend(decision()).ok).toBe(false);

    signed.release();
    expect(chargeSessionSpend(decision()).ok).toBe(true);
  });

  it('refuses without calling the signer when the cap is reached', async () => {
    expect(chargeSessionSpend(decision()).ok).toBe(true);
    const sign = vi.fn();
    const signed = await signWithSpendCharge(decision(), sign);
    expect(signed.ok).toBe(false);
    expect(signed.reason).toContain('exceed the $0.01 session cap');
    expect(sign).not.toHaveBeenCalled();
  });

  it('releases the charge and rethrows when the signer fails', async () => {
    await expect(signWithSpendCharge(decision(), async () => { throw new Error('rejected by wallet'); }))
      .rejects.toThrow('rejected by wallet');
    expect(chargeSessionSpend(decision()).ok).toBe(true);
  });

  it('charges before the signer starts, so a concurrent request sees the charge', async () => {
    let finish;
    const first = signWithSpendCharge(decision(), () => new Promise((resolve) => { finish = resolve; }));
    const second = await signWithSpendCharge(decision(), async () => 'sig');
    expect(second.ok).toBe(false);
    finish('sig');
    expect((await first).ok).toBe(true);
  });
});

describe('resolveDailyMaxMicroUsd', () => {
  afterEach(() => {
    delete process.env.NANSEN_X402_DAILY_MAX_AMOUNT;
  });

  it.each([undefined, '', '   '])('defaults to $50.00 for %j', (value) => {
    if (value !== undefined) process.env.NANSEN_X402_DAILY_MAX_AMOUNT = value;
    expect(resolveDailyMaxMicroUsd()).toBe(50_000_000n);
  });

  it.each(['unlimited', 'Unlimited'])('disables the cap for %j', (value) => {
    process.env.NANSEN_X402_DAILY_MAX_AMOUNT = value;
    expect(resolveDailyMaxMicroUsd()).toBeNull();
  });

  it('parses a decimal exactly', () => {
    process.env.NANSEN_X402_DAILY_MAX_AMOUNT = '0.29';
    expect(resolveDailyMaxMicroUsd()).toBe(290_000n);
  });

  it.each(['-1', '1e3', '0x10', 'ten'])('returns an error instead of falling back for %j', (value) => {
    process.env.NANSEN_X402_DAILY_MAX_AMOUNT = value;
    expect(resolveDailyMaxMicroUsd().error).toBe(
      `Refusing to auto-pay: NANSEN_X402_DAILY_MAX_AMOUNT="${value}" is not a valid USD amount. ` +
      'Set it to a number such as 5.00, or set NANSEN_X402_DAILY_MAX_AMOUNT=unlimited to disable the daily cap. No signature was produced.',
    );
  });
});

describe('daily spend cap', () => {
  const NOW = new Date('2026-10-16T12:00:00Z');
  const approve = (amount) => {
    const decision = evaluatePaymentRequirement({ ...BASE_USDC_REQUIREMENT, amount });
    expect(decision.ok).toBe(true);
    return decision;
  };
  let originalHome;
  let home;

  beforeEach(() => {
    originalHome = process.env.HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'nansen-x402-daily-'));
    process.env.HOME = home;
    resetSpendCapsForTests();
  });
  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
    delete process.env.NANSEN_X402_SESSION_MAX_AMOUNT;
    delete process.env.NANSEN_X402_DAILY_MAX_AMOUNT;
    resetSpendCapsForTests();
  });

  it('applies the $50.00 default when the variable is unset', () => {
    // $1 each, the per-payment cap.
    for (let i = 0; i < 50; i++) expect(chargeDailySpend(approve('1000000'), NOW).ok).toBe(true);

    expect(chargeDailySpend(approve('1'), NOW)).toEqual({
      ok: false,
      reason:
        'Refusing to auto-pay $0.000001 USDC: x402 auto-payments today (UTC) already total $50.00, and the payment ' +
        'would exceed the $50.00 daily cap. To authorize, raise it with NANSEN_X402_DAILY_MAX_AMOUNT=<usd> ' +
        '(or NANSEN_X402_DAILY_MAX_AMOUNT=unlimited to disable). No signature was produced.',
    });
  });

  it('counts payments made by earlier runs', () => {
    process.env.NANSEN_X402_DAILY_MAX_AMOUNT = '0.02';
    expect(chargeDailySpend(approve('10000'), NOW).ok).toBe(true);
    resetSpendCapsForTests(); // a new process
    expect(chargeDailySpend(approve('10000'), NOW).ok).toBe(true);
    resetSpendCapsForTests();
    expect(chargeDailySpend(approve('10000'), NOW).reason).toContain('already total $0.02');
  });

  it('touches no file when the cap is unlimited', () => {
    process.env.NANSEN_X402_DAILY_MAX_AMOUNT = 'unlimited';
    for (let i = 0; i < 20; i++) expect(chargeDailySpend(approve('1000000'), NOW).ok).toBe(true);
    expect(fs.existsSync(path.join(home, '.nansen'))).toBe(false);
  });

  it('turns a ledger problem into a refusal reason', () => {
    expect(chargeDailySpend(approve('10000'), NOW).ok).toBe(true);
    fs.writeFileSync(x402SpendLedgerPath(NOW), '{');
    const refused = chargeDailySpend(approve('10000'), NOW);
    expect(refused.ok).toBe(false);
    expect(refused.reason).toContain(`the x402 daily spend ledger ${x402SpendLedgerPath(NOW)} is malformed`);
  });

  it('refuses a payment whose amount is unknown', () => {
    expect(chargeDailySpend({ ...approve('10000'), amountMicroUsd: undefined }, NOW).reason)
      .toContain('payment amount is unknown, so the daily cap cannot be applied');
  });

  it('is reported by spendCapConfigError when invalid', () => {
    process.env.NANSEN_X402_DAILY_MAX_AMOUNT = '5usd';
    expect(spendCapConfigError()).toContain('NANSEN_X402_DAILY_MAX_AMOUNT="5usd" is not a valid USD amount');
  });

  describe('in signWithSpendCharge', () => {
    it('refuses without calling the signer, and frees the session charge', async () => {
      process.env.NANSEN_X402_SESSION_MAX_AMOUNT = '0.01';
      process.env.NANSEN_X402_DAILY_MAX_AMOUNT = '0';
      const sign = vi.fn();

      const signed = await signWithSpendCharge(approve('10000'), sign);
      expect(signed.ok).toBe(false);
      expect(signed.reason).toContain('exceed the $0.00 daily cap');
      expect(sign).not.toHaveBeenCalled();
      expect(chargeSessionSpend(approve('10000')).ok).toBe(true);
    });

    it('does not charge the daily total when the session cap refuses first', async () => {
      process.env.NANSEN_X402_SESSION_MAX_AMOUNT = '0';
      const signed = await signWithSpendCharge(approve('10000'), vi.fn());
      expect(signed.reason).toContain('session cap');
      expect(fs.existsSync(x402SpendLedgerPath())).toBe(false);
    });

    it('takes the daily charge back when the signer fails or the payment is released', async () => {
      process.env.NANSEN_X402_DAILY_MAX_AMOUNT = '0.02';
      await expect(signWithSpendCharge(approve('10000'), async () => { throw new Error('rejected by wallet'); }))
        .rejects.toThrow('rejected by wallet');
      const signed = await signWithSpendCharge(approve('10000'), async () => 'sig');
      signed.release();
      signed.release(); // only once
      expect(JSON.parse(fs.readFileSync(x402SpendLedgerPath(), 'utf8')).spentMicroUsd).toBe('0');

      expect((await signWithSpendCharge(approve('10000'), async () => 'sig')).ok).toBe(true);
      expect((await signWithSpendCharge(approve('10000'), async () => 'sig')).ok).toBe(true);
      const refused = await signWithSpendCharge(approve('10000'), vi.fn());
      expect(refused.reason).toContain('already total $0.02');
    });

    it('keeps the daily charge when taking it back fails', async () => {
      process.env.NANSEN_X402_DAILY_MAX_AMOUNT = '0.01';
      const signed = await signWithSpendCharge(approve('10000'), async () => 'sig');
      fs.writeFileSync(x402SpendLedgerPath(), '{');
      expect(() => signed.release()).not.toThrow();
      expect(fs.readFileSync(x402SpendLedgerPath(), 'utf8')).toBe('{');
    });
  });
});
