import { describe, it, expect } from 'vitest';
import { TRADE_CHAINS, TRADE_CHAIN_NAMES, TRADE_SOURCE_CHAIN_NAMES, tradeChain, tradeChainSymbols } from '../trade-chains.js';
import { CHAIN_RPCS, SIMULATION_RPCS } from '../rpc-urls.js';
import { resolveChain, resolveTokenAddress } from '../trading.js';
import { validateQuoteInput } from '../trade-validation.js';

// A chain missing any of these used to fail open somewhere in the trade path
// (no gas check, native sell treated as ERC-20, NaN balance), so every entry
// must carry all of them.
const REQUIRED = {
  type: (v) => v === 'solana' || v === 'evm',
  name: (v) => typeof v === 'string' && v.length > 0,
  chainId: (v) => Number.isInteger(v) && v > 0,
  index: (v) => /^\d+$/.test(v),
  lifiChainId: (v) => /^\d+$/.test(v),
  explorer: (v) => /^https:\/\/[^\s]+\/tx\/$/.test(v),
  nativeSymbol: (v) => /^[A-Z]+$/.test(v),
  nativeDecimals: (v) => Number.isInteger(v) && v > 0,
  nativeAddress: (v) => typeof v === 'string' && v.length > 0,
  stables: (v) => Array.isArray(v) && v.length > 0 && v.every((s) => s.address && /^[A-Z]+$/.test(s.symbol)),
  extraSymbols: (v) => v && typeof v === 'object',
  minGas: (v) => typeof v === 'number' && v > 0,
  feeBuffer: (v) => typeof v === 'number' && v > 0,
  standaloneApprovals: (v) => typeof v === 'boolean',
};

describe('trade-chain registry', () => {
  it.each(TRADE_CHAIN_NAMES)('%s has every required field', (name) => {
    const chain = TRADE_CHAINS[name];
    for (const [field, valid] of Object.entries(REQUIRED)) {
      expect(valid(chain[field]), `${name}.${field} = ${JSON.stringify(chain[field])}`).toBe(true);
    }
  });

  it.each(TRADE_CHAIN_NAMES)('%s has a configured RPC', (name) => {
    expect(CHAIN_RPCS[name]).toMatch(/^https:\/\//);
  });

  it.each(TRADE_CHAIN_NAMES.filter((n) => TRADE_CHAINS[n].type === 'evm'))(
    '%s uses its EVM chain id as the trading index and LI.FI id',
    (name) => {
      const chain = TRADE_CHAINS[name];
      expect(chain.index).toBe(String(chain.chainId));
      expect(chain.lifiChainId).toBe(String(chain.chainId));
      expect(chain.nativeAddress).toBe('0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');
      for (const { address } of chain.stables) expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    },
  );

  it.each(TRADE_CHAIN_NAMES)('%s: every symbol resolves through the trade command', (name) => {
    for (const [symbol, address] of Object.entries(tradeChainSymbols(TRADE_CHAINS[name]))) {
      expect(resolveTokenAddress(symbol.toLowerCase(), name)).toBe(address);
    }
  });

  it.each(TRADE_SOURCE_CHAIN_NAMES.filter((n) => TRADE_CHAINS[n].type === 'evm'))(
    '%s (an EVM chain a trade signs on) has a swap-outcome simulation endpoint',
    (name) => {
      expect(SIMULATION_RPCS[name]).toMatch(/^https:\/\//);
    },
  );

  it.each(TRADE_SOURCE_CHAIN_NAMES)('%s is accepted by resolveChain and validateQuoteInput', (name) => {
    const chain = TRADE_CHAINS[name];
    expect(resolveChain(name).chainId).toBe(chain.chainId);
    expect(() => validateQuoteInput({
      chain: name, from: chain.nativeAddress, to: chain.stables[0].address, amount: '1',
    })).not.toThrow();
  });

  it('hyperevm is a bridge destination only: refused as --chain, accepted as --to-chain', () => {
    expect(TRADE_SOURCE_CHAIN_NAMES).not.toContain('hyperevm');
    expect(TRADE_CHAIN_NAMES).toContain('hyperevm');
    expect(() => validateQuoteInput({ chain: 'hyperevm', from: 'HYPE', to: 'USDC', amount: '1' }))
      .toThrow('HyperEVM is supported as a bridge destination only');
    expect(() => validateQuoteInput({
      chain: 'base', toChain: 'hyperevm',
      from: TRADE_CHAINS.base.nativeAddress, to: TRADE_CHAINS.hyperevm.stables[0].address, amount: '1',
    })).not.toThrow();
  });

  it('tradeChain is case-insensitive and ignores prototype keys', () => {
    expect(tradeChain('BASE')).toBe(TRADE_CHAINS.base);
    expect(tradeChain('toString')).toBeUndefined();
    expect(tradeChain(undefined)).toBeUndefined();
  });
});
