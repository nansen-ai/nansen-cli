/**
 * Tests for walletconnect-x402.js — policy guard wiring in handleX402Payment.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../x402-policy.js', () => ({
  evaluatePaymentRequirement: vi.fn(),
  resolvePaymentAmount: (requirement) =>
    requirement.amount !== undefined && requirement.amount !== null && requirement.amount !== ''
      ? requirement.amount
      : requirement.maxAmountRequired,
  resolvePayTo: (requirement) =>
    requirement.payTo !== undefined && requirement.payTo !== null && requirement.payTo !== ''
      ? requirement.payTo
      : requirement.pay_to,
}));

vi.mock('../walletconnect-exec.js', () => ({
  wcExec: vi.fn(),
}));

import { evaluatePaymentRequirement } from '../x402-policy.js';
import { wcExec } from '../walletconnect-exec.js';
import { handleX402Payment, buildEIP712TypedData } from '../walletconnect-x402.js';

// Session approved for Base (eip155:8453) only -- the account entry carries
// the CAIP-2 chain tag getWalletConnectAddress matches on, not just a bare
// address, so a mock without a `chain` field would mask the exact-chain bug
// this file used to have (accounts[0] taken with no chain filter at all).
const CONNECTED_WALLET = {
  connected: true,
  accounts: [{ chain: 'eip155:8453', address: '0xWalletAddress' }],
};

const REQUIREMENT = {
  scheme: 'exact',
  network: 'eip155:8453',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  payTo: '0xRecipient',
  amount: '10000',
  maxTimeoutSeconds: 120,
  extra: { name: 'USD Coin', version: '2', chainId: 8453 },
};

const PAYMENT_REQUIREMENTS = { accepts: [REQUIREMENT] };

beforeEach(() => {
  vi.clearAllMocks();
  // Default: wallet connected, wcExec returns whoami then sign result
  wcExec.mockImplementation((_cmd, args) => {
    if (args[0] === 'whoami') {
      return Promise.resolve(JSON.stringify(CONNECTED_WALLET));
    }
    return Promise.resolve(JSON.stringify({ signature: '0xfakesig' }));
  });
});

describe('handleX402Payment — policy guard', () => {
  it('throws with the refusal reason when evaluatePaymentRequirement returns ok: false', async () => {
    evaluatePaymentRequirement.mockReturnValue({
      ok: false,
      reason: 'Refusing to auto-pay: test refusal',
    });

    await expect(
      handleX402Payment(PAYMENT_REQUIREMENTS),
    ).rejects.toThrow('Refusing to auto-pay: test refusal');

    // Signing (wcExec sign-typed-data) must never be reached
    const signCalls = wcExec.mock.calls.filter(c => c[1]?.[0] === 'sign-typed-data');
    expect(signCalls).toHaveLength(0);
  });

  it('proceeds to sign when evaluatePaymentRequirement returns ok: true', async () => {
    evaluatePaymentRequirement.mockReturnValue({ ok: true, usd: 0.01, symbol: 'USDC' });

    const result = await handleX402Payment(PAYMENT_REQUIREMENTS);

    expect(typeof result).toBe('string');
    const decoded = JSON.parse(Buffer.from(result, 'base64').toString('utf8'));
    expect(decoded.x402Version).toBe(2);
    expect(decoded.payload.signature).toBe('0xfakesig');

    const signCalls = wcExec.mock.calls.filter(c => c[1]?.[0] === 'sign-typed-data');
    expect(signCalls).toHaveLength(1);
  });
});

describe('handleX402Payment — WalletConnect chain scoping', () => {
  it('refuses to pay when the connected session is approved for a different EVM chain', async () => {
    evaluatePaymentRequirement.mockReturnValue({ ok: true, usd: 0.01, symbol: 'USDC' });
    // Session approved for Ethereum mainnet only; the payment requirement is on Base.
    wcExec.mockImplementation((_cmd, args) => {
      if (args[0] === 'whoami') {
        return Promise.resolve(JSON.stringify({
          connected: true,
          accounts: [{ chain: 'eip155:1', address: '0xWalletAddress' }],
        }));
      }
      return Promise.resolve(JSON.stringify({ signature: '0xfakesig' }));
    });

    await expect(
      handleX402Payment(PAYMENT_REQUIREMENTS),
    ).rejects.toThrow(/no WalletConnect session is active for chain eip155:8453/);

    // A wrong-chain session must never reach signing.
    const signCalls = wcExec.mock.calls.filter(c => c[1]?.[0] === 'sign-typed-data');
    expect(signCalls).toHaveLength(0);
  });

  it('refuses to pay when no WalletConnect session is connected at all', async () => {
    evaluatePaymentRequirement.mockReturnValue({ ok: true, usd: 0.01, symbol: 'USDC' });
    wcExec.mockImplementation((_cmd, args) => {
      if (args[0] === 'whoami') {
        return Promise.resolve(JSON.stringify({ connected: false }));
      }
      return Promise.resolve(JSON.stringify({ signature: '0xfakesig' }));
    });

    await expect(
      handleX402Payment(PAYMENT_REQUIREMENTS),
    ).rejects.toThrow(/no WalletConnect session is active for chain eip155:8453/);
  });

  it('signs from the account matching the target chain, not accounts[0]', async () => {
    evaluatePaymentRequirement.mockReturnValue({ ok: true, usd: 0.01, symbol: 'USDC' });
    // Deliberately DIFFERENT addresses per chain entry (a multi-account
    // wallet, or a proxy quirk) and the Base entry deliberately placed
    // SECOND, not first -- so this test can only pass if the chain tag,
    // not array position, decides which address is used. Two entries
    // sharing one address would let a bug that still reads accounts[0]
    // slip through unnoticed.
    wcExec.mockImplementation((_cmd, args) => {
      if (args[0] === 'whoami') {
        return Promise.resolve(JSON.stringify({
          connected: true,
          accounts: [
            { chain: 'eip155:1', address: '0xEthOnlyAddress' },
            { chain: 'eip155:8453', address: '0xBaseAddress' },
          ],
        }));
      }
      return Promise.resolve(JSON.stringify({ signature: '0xfakesig' }));
    });

    const result = await handleX402Payment(PAYMENT_REQUIREMENTS);
    const decoded = JSON.parse(Buffer.from(result, 'base64').toString('utf8'));
    expect(decoded.payload.authorization.from).toBe('0xBaseAddress');
  });
});

describe('buildEIP712TypedData — payTo field normalisation', () => {
  it('uses payTo (camelCase) when both payTo and pay_to are present', () => {
    const req = { ...REQUIREMENT, payTo: '0xCamel', pay_to: '0xSnake' };
    const td = buildEIP712TypedData({ fromAddress: '0xSender', requirement: req });
    expect(td.message.to).toBe('0xCamel');
  });

  it('falls back to pay_to when payTo is absent', () => {
    const req = { ...REQUIREMENT };
    delete req.payTo;
    req.pay_to = '0xSnakeOnly';
    const td = buildEIP712TypedData({ fromAddress: '0xSender', requirement: req });
    expect(td.message.to).toBe('0xSnakeOnly');
  });
});

describe('buildEIP712TypedData — chain id binding', () => {
  it('derives chain id from the CAIP-2 network field, ignoring extra.chainId when consistent', () => {
    // extra.chainId agrees with network → allowed, domain.chainId = 8453
    const req = { ...REQUIREMENT, network: 'eip155:8453', extra: { ...REQUIREMENT.extra, chainId: 8453 } };
    const td = buildEIP712TypedData({ fromAddress: '0xSender', requirement: req });
    expect(td.domain.chainId).toBe(8453);
  });

  it('derives chain id from network when extra.chainId is absent', () => {
    const req = { ...REQUIREMENT, extra: { name: 'USD Coin', version: '2' } };
    const td = buildEIP712TypedData({ fromAddress: '0xSender', requirement: req });
    expect(td.domain.chainId).toBe(8453);
  });

  it('treats a null or empty-string extra.chainId as absent, not a conflict', () => {
    // null/'' mean "unspecified" (Number(null)===0, Number('')===0) and must not
    // be read as a chain id of 0 conflicting with the network.
    for (const chainId of [null, '']) {
      const req = { ...REQUIREMENT, network: 'eip155:8453', extra: { ...REQUIREMENT.extra, chainId } };
      const td = buildEIP712TypedData({ fromAddress: '0xSender', requirement: req });
      expect(td.domain.chainId).toBe(8453);
    }
  });

  it('throws when extra.chainId conflicts with the validated network', () => {
    // remote extra.chainId: 1 on a Base requirement must be rejected — not signed
    const req = { ...REQUIREMENT, network: 'eip155:8453', extra: { ...REQUIREMENT.extra, chainId: 1 } };
    expect(() => buildEIP712TypedData({ fromAddress: '0xSender', requirement: req })).toThrow(
      /extra\.chainId.*conflicts with.*network/i,
    );
  });

  it('throws when network is missing or not an EVM CAIP-2 id', () => {
    const req = { ...REQUIREMENT, network: 'bogus' };
    expect(() => buildEIP712TypedData({ fromAddress: '0xSender', requirement: req })).toThrow(
      /unsupported or missing EVM network/i,
    );
  });

  it('throws when extra is missing entirely', () => {
    const req = { ...REQUIREMENT };
    delete req.extra;
    expect(() => buildEIP712TypedData({ fromAddress: '0xSender', requirement: req })).toThrow(
      /EIP-712 domain name\/version missing/i,
    );
  });

  it('throws when extra.name is absent', () => {
    const req = { ...REQUIREMENT, extra: { version: '2' } };
    expect(() => buildEIP712TypedData({ fromAddress: '0xSender', requirement: req })).toThrow(
      /EIP-712 domain name\/version missing/i,
    );
  });

  it('throws when extra.version is absent', () => {
    const req = { ...REQUIREMENT, extra: { name: 'USD Coin' } };
    expect(() => buildEIP712TypedData({ fromAddress: '0xSender', requirement: req })).toThrow(
      /EIP-712 domain name\/version missing/i,
    );
  });
});
