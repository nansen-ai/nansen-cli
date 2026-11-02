import { describe, it, expect, vi, afterEach } from 'vitest';

describe('CHAIN_RPCS default Ethereum RPC', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  // eth.public-rpc.com now answers 403 without an API key, so it must not be
  // the zero-config default for `wallet send --chain ethereum|evm`.
  it('defaults ethereum and the generic evm fallback to a keyless public endpoint', async () => {
    vi.stubEnv('NANSEN_EVM_RPC', '');
    vi.resetModules();
    const { CHAIN_RPCS } = await import('../rpc-urls.js');
    expect(CHAIN_RPCS.ethereum).toBe('https://ethereum-rpc.publicnode.com');
    expect(CHAIN_RPCS.evm).toBe(CHAIN_RPCS.ethereum);
  });

  it('still lets NANSEN_EVM_RPC override the default', async () => {
    vi.stubEnv('NANSEN_EVM_RPC', 'https://rpc.example.test');
    vi.resetModules();
    const { CHAIN_RPCS } = await import('../rpc-urls.js');
    expect(CHAIN_RPCS.ethereum).toBe('https://rpc.example.test');
    expect(CHAIN_RPCS.evm).toBe('https://rpc.example.test');
  });
});
