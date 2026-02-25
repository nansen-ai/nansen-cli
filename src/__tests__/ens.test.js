import { describe, it, expect } from 'vitest';
import { isEnsName, resolveAddress } from '../ens.js';

describe('ENS Resolution', () => {
  describe('isEnsName', () => {
    it('recognizes valid ENS names', () => {
      expect(isEnsName('vitalik.eth')).toBe(true);
      expect(isEnsName('nansen.eth')).toBe(true);
      expect(isEnsName('my-wallet.eth')).toBe(true);
    });

    it('rejects non-ENS strings', () => {
      expect(isEnsName('0x1234567890abcdef1234567890abcdef12345678')).toBe(false);
      expect(isEnsName('not-ens')).toBe(false);
      expect(isEnsName('')).toBe(false);
      expect(isEnsName(null)).toBe(false);
      expect(isEnsName('sub.domain.eth')).toBe(false); // subdomains not matched by simple pattern
    });
  });

  describe('resolveAddress', () => {
    it('passes through raw addresses unchanged', async () => {
      const result = await resolveAddress('0x4a7C6899cdcB379e284fBFD045462e751DA4C7cE');
      expect(result.address).toBe('0x4a7C6899cdcB379e284fBFD045462e751DA4C7cE');
      expect(result.ensName).toBeUndefined();
    });

    it('passes through null/undefined', async () => {
      const result = await resolveAddress(null);
      expect(result.address).toBeNull();
    });

    it('rejects ENS on non-EVM chains', async () => {
      await expect(resolveAddress('nansen.eth', 'solana')).rejects.toThrow('EVM chains');
    });

    it('fails with descriptive error for unresolvable names', async () => {
      await expect(resolveAddress('zzznonexistent999999.eth')).rejects.toThrow('Could not resolve ENS name');
    }, 15000);
  });

  // Live resolution tests (require network)
  describe.skipIf(!process.env.NANSEN_LIVE_TEST)('live resolution', () => {
    it('resolves nansen.eth', async () => {
      const result = await resolveAddress('nansen.eth');
      expect(result.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(result.ensName).toBe('nansen.eth');
    }, 10000);

    it('resolves vitalik.eth', async () => {
      const result = await resolveAddress('vitalik.eth');
      expect(result.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(result.ensName).toBe('vitalik.eth');
    }, 10000);
  });
});
