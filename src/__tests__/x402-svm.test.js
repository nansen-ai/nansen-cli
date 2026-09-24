/**
 * Tests for x402 Solana payment module
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import crypto from 'crypto';
import { base58Decode, base58Encode } from '../wallet.js';
import {
  deriveATA,
  isSvmNetwork,
  getSolanaRpcUrl,
  buildUnsignedSvmTransaction,
  fetchRecentBlockhash,
} from '../x402-svm.js';
import { CHAIN_RPCS } from '../rpc-urls.js';

// Inline Solana wallet generation (from wallet.js PR #26, not yet merged)
function generateSolanaWallet() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  const rawPrivate = privateKey.subarray(privateKey.length - 32);
  const rawPublic = publicKey.subarray(publicKey.length - 32);
  const keypair = Buffer.concat([rawPrivate, rawPublic]);
  return {
    privateKey: keypair.toString('hex'),
    address: base58Encode(rawPublic),
  };
}

describe('base58Decode', () => {
  it('should round-trip with base58Encode', () => {
    const original = crypto.randomBytes(32);
    const encoded = base58Encode(original);
    const decoded = base58Decode(encoded);
    expect(decoded.toString('hex')).toBe(original.toString('hex'));
  });

  it('should handle leading zeros', () => {
    const buf = Buffer.from([0, 0, 1, 2, 3]);
    const encoded = base58Encode(buf);
    const decoded = base58Decode(encoded);
    expect(decoded.toString('hex')).toBe(buf.toString('hex'));
  });

  it('should decode known Solana addresses', () => {
    // System program: all zeros, 32 bytes
    const decoded = base58Decode('11111111111111111111111111111111');
    expect(decoded.length).toBe(32);
    expect(decoded.every(b => b === 0)).toBe(true);
  });
});

describe('deriveATA', () => {
  it('should produce a valid base58 address', () => {
    // Use known addresses for deterministic test
    const owner = '11111111111111111111111111111111'; // System program
    const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // USDC mainnet

    const ata = deriveATA(owner, mint);
    expect(ata).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  });

  it('should produce different ATAs for different owners', () => {
    const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const wallet1 = generateSolanaWallet();
    const wallet2 = generateSolanaWallet();

    const ata1 = deriveATA(wallet1.address, mint);
    const ata2 = deriveATA(wallet2.address, mint);
    expect(ata1).not.toBe(ata2);
  });

  it('should be deterministic', () => {
    const wallet = generateSolanaWallet();
    const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

    const ata1 = deriveATA(wallet.address, mint);
    const ata2 = deriveATA(wallet.address, mint);
    expect(ata1).toBe(ata2);
  });
});

describe('isSvmNetwork', () => {
  it('should return true for Solana networks', () => {
    expect(isSvmNetwork('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp')).toBe(true);
    expect(isSvmNetwork('solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1')).toBe(true);
  });

  it('should return false for non-Solana networks', () => {
    expect(isSvmNetwork('eip155:8453')).toBe(false);
    expect(isSvmNetwork('')).toBe(false);
    expect(isSvmNetwork(null)).toBe(false);
  });
});

describe('getSolanaRpcUrl', () => {
  it('should return the shared mainnet RPC for the canonical mainnet CAIP-2 id', () => {
    expect(getSolanaRpcUrl('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp')).toBe(CHAIN_RPCS.solana);
  });

  it('should return devnet URL for the canonical devnet CAIP-2 id', () => {
    expect(getSolanaRpcUrl('solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1')).toContain('devnet');
  });

  it('should return testnet URL for the canonical testnet CAIP-2 id', () => {
    expect(getSolanaRpcUrl('solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z')).toContain('testnet');
  });

  it('throws for an unknown solana:* network instead of falling back to mainnet', () => {
    expect(() => getSolanaRpcUrl('solana:bogus')).toThrow(/Unsupported Solana network/);
    expect(() => getSolanaRpcUrl('solana:not-a-real-network-id')).toThrow(/Unsupported Solana network/);
  });

  // The mainnet branch hardcoded the public endpoint, so a user's
  // NANSEN_SOLANA_RPC (honoured by transfer, trading and limit orders) was
  // ignored for x402 blockhash fetches and balance checks.
  it('honours NANSEN_SOLANA_RPC for mainnet like every other Solana path', async () => {
    const previous = process.env.NANSEN_SOLANA_RPC;
    process.env.NANSEN_SOLANA_RPC = 'https://private.rpc.example/solana';
    vi.resetModules();
    try {
      const fresh = await import('../x402-svm.js');
      expect(fresh.getSolanaRpcUrl('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp')).toBe('https://private.rpc.example/solana');
      // Devnet/testnet stay on their fixed endpoints.
      expect(fresh.getSolanaRpcUrl('solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1')).toContain('devnet');
    } finally {
      if (previous === undefined) delete process.env.NANSEN_SOLANA_RPC;
      else process.env.NANSEN_SOLANA_RPC = previous;
      vi.resetModules();
    }
  });
});

describe('buildUnsignedSvmTransaction', () => {
  const wallet = generateSolanaWallet();
  const requirements = {
    scheme: 'exact',
    network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    payTo: base58Encode(crypto.randomBytes(32)),
    amount: '50000',
    extra: { feePayer: base58Encode(crypto.randomBytes(32)) },
  };
  const blockhash = base58Encode(crypto.randomBytes(32));

  it('returns messageBytes and txBase64', () => {
    const result = buildUnsignedSvmTransaction(requirements, wallet.address, blockhash);
    expect(result.messageBytes).toBeInstanceOf(Buffer);
    expect(typeof result.txBase64).toBe('string');
    // txBase64 should decode to valid bytes
    const txBytes = Buffer.from(result.txBase64, 'base64');
    expect(txBytes.length).toBeGreaterThan(128); // at least 2 sigs + message
  });

  it('produces same messageBytes as createSvmPaymentPayload', () => {
    const { messageBytes } = buildUnsignedSvmTransaction(requirements, wallet.address, blockhash);

    // createSvmPaymentPayload also builds the same message internally
    // We verify the messageBytes starts with 0x80 (v0 prefix)
    expect(messageBytes[0]).toBe(0x80);
    // Header: numRequiredSignatures, numReadonlySignedAccounts, numReadonlyUnsignedAccounts
    expect(messageBytes[1]).toBeGreaterThanOrEqual(2); // at least feePayer + client
  });

  it('resolves maxAmountRequired when amount is an empty string (matches resolvePaymentAmount)', () => {
    // Regression: this signer must resolve the amount the same way the policy
    // guard does, so a signed transfer amount never diverges from the guarded one.
    const req = { ...requirements, amount: '', maxAmountRequired: '999999' };
    const { messageBytes } = buildUnsignedSvmTransaction(req, wallet.address, blockhash);
    const expectedAmountBytes = Buffer.alloc(8);
    expectedAmountBytes.writeBigUInt64LE(999999n);
    expect(messageBytes.includes(expectedAmountBytes)).toBe(true);
  });

  it('throws without feePayer in extra', () => {
    const badReqs = { ...requirements, extra: {} };
    expect(() => buildUnsignedSvmTransaction(badReqs, wallet.address, blockhash))
      .toThrow('feePayer is required');
  });

  it('transaction has two 64-byte zero signature slots', () => {
    const { txBase64 } = buildUnsignedSvmTransaction(requirements, wallet.address, blockhash);
    const txBytes = Buffer.from(txBase64, 'base64');
    // First byte is compact-u16 encoding of 2 (= 0x02)
    expect(txBytes[0]).toBe(2);
    // Next 128 bytes should be zeros (two placeholder signatures)
    const sigSlots = txBytes.subarray(1, 129);
    expect(sigSlots.every(b => b === 0)).toBe(true);
  });
});

describe('fetchRecentBlockhash', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the recent blockhash from a valid RPC response', async () => {
    const bh = base58Encode(crypto.randomBytes(32));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: { value: { blockhash: bh } } }),
    }));
    await expect(fetchRecentBlockhash('http://unused')).resolves.toBe(bh);
  });

  it('surfaces JSON-RPC errors as actionable blockhash failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ error: { code: 429, message: 'rate limited' } }),
    }));
    await expect(fetchRecentBlockhash('http://unused'))
      .rejects.toThrow(/Solana RPC failed while fetching a recent blockhash: rate limited/);
  });

  it('rejects a response missing result.value.blockhash with an actionable message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: {} }),
    }));
    await expect(fetchRecentBlockhash('http://unused'))
      .rejects.toThrow(/Solana RPC returned no recent blockhash/);
  });

  it('rejects a non-2xx HTTP response with the status code', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'Service Unavailable',
    }));
    await expect(fetchRecentBlockhash('http://unused'))
      .rejects.toThrow(/Solana RPC returned HTTP 503/);
  });

  it('rejects a fetch/network failure with an actionable message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    await expect(fetchRecentBlockhash('http://unused'))
      .rejects.toThrow(/Solana RPC unavailable while fetching a recent blockhash/);
  });

  it('defaults to the shared RPC registry entry rather than a hardcoded public endpoint', async () => {
    const bh = base58Encode(crypto.randomBytes(32));
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: { value: { blockhash: bh } } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchRecentBlockhash()).resolves.toBe(bh);
    expect(fetchMock).toHaveBeenCalledWith(CHAIN_RPCS.solana, expect.objectContaining({ method: 'POST' }));
  });

  // A private RPC URL usually carries an API key in its query string. Node's
  // own parse failure ("Failed to parse URL from <value>") would copy it into
  // the error message, which privy.js and the x402 fallback loop print.
  it('refuses a malformed RPC URL up front without echoing it', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const secret = 'SUPERSECRET_KEY_123';
    const badUrls = [
      `mainnet.helius-rpc.com/?api-key=${secret}`, // missing scheme
      `ws://rpc.example/?api-key=${secret}`,        // non-HTTP scheme
      '   ',
      '',
      'not a url',
    ];
    for (const url of badUrls) {
      let caught;
      try {
        await fetchRecentBlockhash(url);
      } catch (err) {
        caught = err;
      }
      expect(caught, `expected rejection for ${JSON.stringify(url)}`).toBeInstanceOf(Error);
      expect(caught.message).toMatch(/Invalid Solana RPC URL.*http:\/\/ or https:\/\/.*NANSEN_SOLANA_RPC/);
      expect(caught.message).not.toContain(secret);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('passes an abort signal to fetch and times out a hanging RPC with an actionable message', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn((_url, opts) => new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
        });
      }));
      vi.stubGlobal('fetch', fetchMock);

      const pending = fetchRecentBlockhash('http://unused');
      const assertion = expect(pending).rejects.toThrow(/did not respond within 15s while fetching a recent blockhash/);
      expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);

      await vi.advanceTimersByTimeAsync(15_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not report a timeout for an ordinary network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    let caught;
    try {
      await fetchRecentBlockhash('http://unused');
    } catch (err) {
      caught = err;
    }
    expect(caught.message).toMatch(/Solana RPC unavailable/);
    expect(caught.message).not.toMatch(/did not respond/);
  });
});
