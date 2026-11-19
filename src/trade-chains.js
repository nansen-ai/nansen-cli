/**
 * The chains `nansen trade` can quote and execute on, one entry per chain.
 *
 * Every per-chain table the trade path reads (trading.js CHAIN_MAP and token
 * symbols, trade-validation.js native/stable/gas tables) is derived from here.
 * Those tables used to be keyed separately, and a chain missing from one of them
 * failed OPEN: no gas pre-check, a native sell treated as an ERC-20, a NaN
 * balance. One registry, plus a test that every entry has every field, means a
 * chain cannot be half-added.
 *
 * Adding a chain: add an entry with every field below, an RPC in rpc-urls.js
 * CHAIN_RPCS, and a sim-capable RPC in SIMULATION_RPCS (an EVM chain without one
 * trades with swap-outcome verification skipped).
 */

const EVM_NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

/**
 * @typedef {object} TradeChain
 * @property {'solana'|'evm'} type
 * @property {string} name          Display name
 * @property {number} chainId       EVM chain id (Solana: 501, the trading service's index)
 * @property {string} index         The trading service's chainIndex
 * @property {string} lifiChainId   The bridge-status chain id
 * @property {string} explorer      Transaction URL prefix
 * @property {string} nativeSymbol
 * @property {number} nativeDecimals
 * @property {string} nativeAddress The address quotes use for the native token
 * @property {{address: string, symbol: string}|null} wrappedNative
 * @property {Array<{address: string, symbol: string}>} stables
 *   With the native token, the tokens one side of a swap must be.
 * @property {Record<string, string>} extraSymbols  Other symbols `--from`/`--to` accept
 * @property {number} minGas        Native balance (token units) needed to quote
 * @property {number} feeBuffer     Native amount held back when selling the max
 */

/** @type {Record<string, TradeChain>} */
export const TRADE_CHAINS = {
  solana: {
    type: 'solana',
    name: 'Solana',
    chainId: 501,
    index: '501',
    lifiChainId: '1151111081099710',
    explorer: 'https://solscan.io/tx/',
    nativeSymbol: 'SOL',
    nativeDecimals: 9,
    nativeAddress: 'So11111111111111111111111111111111111111112',
    // The native mint is also the wrapped-SOL mint; `WSOL` resolves to it below.
    wrappedNative: null,
    stables: [
      { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC' },
    ],
    extraSymbols: {
      WSOL: 'So11111111111111111111111111111111111111112',
      USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    },
    // Solana's real cost is a 5000-lamport base fee plus at most ~0.00204 SOL of
    // ATA rent, so 0.005 is a wide margin. See MIN_GAS_AMOUNTS in
    // trade-validation.js for why this is not sized off the priority-fee ceiling.
    minGas: 0.005,
    feeBuffer: 0.005,
  },
  base: {
    type: 'evm',
    name: 'Base',
    chainId: 8453,
    index: '8453',
    lifiChainId: '8453',
    explorer: 'https://basescan.org/tx/',
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    nativeAddress: EVM_NATIVE,
    wrappedNative: { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH' },
    stables: [
      { address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', symbol: 'USDC' },
    ],
    extraSymbols: {
      // NOTE: Legacy L2-bridged USDT on Base. If Tether deploys natively on Base
      // (like Circle did with USDC), this address will need updating.
      USDT: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',
    },
    minGas: 0.000024,
    feeBuffer: 0.00004,
  },
};

/** Chain names `--chain` / `--to-chain` accept, in display order. */
export const TRADE_CHAIN_NAMES = Object.keys(TRADE_CHAINS);

/** The registry entry for a chain name (any case), or undefined. */
export function tradeChain(name) {
  if (!name) return undefined;
  const key = String(name).toLowerCase();
  return Object.hasOwn(TRADE_CHAINS, key) ? TRADE_CHAINS[key] : undefined;
}

/** Symbol → address for every token symbol a chain accepts. */
export function tradeChainSymbols(chain) {
  const symbols = { [chain.nativeSymbol]: chain.nativeAddress };
  if (chain.wrappedNative) symbols[chain.wrappedNative.symbol] = chain.wrappedNative.address;
  for (const { address, symbol } of chain.stables) symbols[symbol] = address;
  return { ...symbols, ...chain.extraSymbols };
}

/** Build `{ [chain]: pick(entry) }` over every trade chain. */
export function mapTradeChains(pick) {
  return Object.fromEntries(TRADE_CHAIN_NAMES.map((name) => [name, pick(TRADE_CHAINS[name], name)]));
}
