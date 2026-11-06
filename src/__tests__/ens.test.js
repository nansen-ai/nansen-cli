import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import https from 'node:https';
import { isEnsName, resolveAddress } from '../ens.js';
import { CHAIN_RPCS } from '../rpc-urls.js';

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

    describe('with chain "all"', () => {
      afterEach(() => vi.restoreAllMocks());

      // Replay one ensideas-style answer without touching the network.
      function mockEnsIdeas(body) {
        return vi.spyOn(https, 'get').mockImplementation((_url, _opts, cb) => {
          const res = new EventEmitter();
          res.statusCode = 200;
          const req = new EventEmitter();
          queueMicrotask(() => {
            cb(res);
            res.emit('data', JSON.stringify(body));
            res.emit('end');
          });
          return req;
        });
      }

      it('resolves instead of rejecting, since the resolved address is an EVM address', async () => {
        const get = mockEnsIdeas({ address: '0x4a7C6899cdcB379e284fBFD045462e751DA4C7cE' });
        const result = await resolveAddress('nansen.eth', 'all');
        expect(result).toEqual({ address: '0x4a7C6899cdcB379e284fBFD045462e751DA4C7cE', ensName: 'nansen.eth' });
        expect(get).toHaveBeenCalledTimes(1);
        expect(get.mock.calls[0][0]).toContain('/ens/resolve/nansen.eth');
      });

      it('still rejects a non-EVM chain before any lookup', async () => {
        const get = mockEnsIdeas({ address: '0x4a7C6899cdcB379e284fBFD045462e751DA4C7cE' });
        await expect(resolveAddress('nansen.eth', 'solana')).rejects.toThrow('EVM chains');
        expect(get).not.toHaveBeenCalled();
      });
    });

    describe('on-chain fallback', () => {
      const RESOLVER = '231b0ee14048e9dccd1d247744d114a4eb5e8e63';
      const OWNER = 'd8da6bf26964af9d7eed9e03e53415d37aa96045';
      const word = hex => '0x' + hex.padStart(64, '0');
      const savedRpc = CHAIN_RPCS.ethereum;

      afterEach(() => {
        CHAIN_RPCS.ethereum = savedRpc;
        vi.restoreAllMocks();
      });

      // ensideas is down, so the name has to resolve through eth_call.
      function mockRpc() {
        vi.spyOn(https, 'get').mockImplementation(() => { throw new Error('ensideas down'); });
        const answers = [word(RESOLVER), word(OWNER)];
        return vi.spyOn(https, 'request').mockImplementation((_opts, cb) => {
          const req = new EventEmitter();
          req.write = () => {};
          req.end = () => queueMicrotask(() => {
            const res = new EventEmitter();
            res.statusCode = 200;
            cb(res);
            res.emit('data', JSON.stringify({ jsonrpc: '2.0', id: 1, result: answers.shift() }));
            res.emit('end');
          });
          return req;
        });
      }

      it('uses the shared Ethereum RPC instead of a hard-coded endpoint', async () => {
        CHAIN_RPCS.ethereum = 'https://ethereum-rpc.publicnode.com';
        const request = mockRpc();
        const result = await resolveAddress('vitalik.eth');
        expect(result.address.toLowerCase()).toBe('0x' + OWNER);
        expect(request).toHaveBeenCalledTimes(2);
        for (const [opts] of request.mock.calls) {
          expect(opts.hostname).toBe('ethereum-rpc.publicnode.com');
        }
      });

      it('keeps the port and query string of a custom RPC URL', async () => {
        CHAIN_RPCS.ethereum = 'https://rpc.example.org:8443/v1/mainnet?key=abc';
        const request = mockRpc();
        await resolveAddress('vitalik.eth');
        const [opts] = request.mock.calls[0];
        expect(opts.hostname).toBe('rpc.example.org');
        expect(opts.port).toBe('8443');
        expect(opts.path).toBe('/v1/mainnet?key=abc');
      });
    });

    it('fails with descriptive error for unresolvable names', async () => {
      const get = vi.spyOn(https, 'get').mockImplementation(() => { throw new Error('synthetic unresolved lookup'); });
      const post = vi.spyOn(https, 'request').mockImplementation(() => { throw new Error('synthetic unresolved RPC'); });
      try {
        await expect(resolveAddress('zzznonexistent999999.eth')).rejects.toThrow('Could not resolve ENS name');
        expect(get).toHaveBeenCalledOnce(); expect(post).toHaveBeenCalledOnce();
      } finally { get.mockRestore(); post.mockRestore(); }
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
