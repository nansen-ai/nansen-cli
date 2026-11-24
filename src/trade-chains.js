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
 * @property {boolean} standaloneApprovals Whether the trading service broadcasts
 *   an ERC-20 approval or revoke sent on its own. It does so only on the legacy
 *   /execute route, whose chain list is shorter than the quote chains; the
 *   standard route takes swaps only. Where false, a sell that needs an approval
 *   or revoke is refused before anything is signed.
 * @property {boolean} legacyGasPriceHeadroom Whether a gasPrice-only quote is
 *   re-priced before signing (withLegacyGasPriceHeadroom). LI.FI's gasPrice
 *   quotes on these chains carry no margin over the base fee; elsewhere the
 *   quote is signed as quoted.
 * @property {boolean} [destinationOnly] Accepted as --to-chain and in
 *   bridge-status only. Nothing is signed on it, so it needs no sim-capable RPC.
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
      { address: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', symbol: 'USDT' },
    ],
    extraSymbols: {
      WSOL: 'So11111111111111111111111111111111111111112',
    },
    // Solana's real cost is a 5000-lamport base fee plus at most ~0.00204 SOL of
    // ATA rent, so 0.005 is a wide margin. See MIN_GAS_AMOUNTS in
    // trade-validation.js for why this is not sized off the priority-fee ceiling.
    minGas: 0.005,
    feeBuffer: 0.005,
    standaloneApprovals: true,
    legacyGasPriceHeadroom: false,
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
    standaloneApprovals: true,
    legacyGasPriceHeadroom: false,
  },
  // Same-chain swaps here route through LI.FI (legacy gasPrice transactions).
  // Gas floors: mainnet fees swing by two orders of magnitude, so the floor is a
  // "can you afford a normal swap" margin, not an estimate; the execute-time
  // eth_call and outcome simulation are the authority on a specific trade.
  ethereum: {
    type: 'evm',
    name: 'Ethereum',
    chainId: 1,
    index: '1',
    lifiChainId: '1',
    explorer: 'https://etherscan.io/tx/',
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    nativeAddress: EVM_NATIVE,
    wrappedNative: { address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', symbol: 'WETH' },
    stables: [
      { address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', symbol: 'USDC' },
      { address: '0xdac17f958d2ee523a2206206994597c13d831ec7', symbol: 'USDT' },
    ],
    extraSymbols: {},
    // A node checks a swap's upfront gas, gasLimit x gasPrice, not what it ends
    // up paying. LI.FI swaps here signed at ~560k-650k gas (the API's padded
    // limit; seen live 2026-11), and the signed gasPrice is up to 2.5x the quoted
    // one (withLegacyGasPriceHeadroom). minGas covers ~650k gas at 1.5 gwei
    // signed, so a wallet that can't pay a typical swap is refused at quote time,
    // before an approval spends gas; feeBuffer covers a ~1.8 gwei quote.
    minGas: 0.001,
    feeBuffer: 0.003,
    standaloneApprovals: true,
    legacyGasPriceHeadroom: true,
  },
  arbitrum: {
    type: 'evm',
    name: 'Arbitrum',
    chainId: 42161,
    index: '42161',
    lifiChainId: '42161',
    explorer: 'https://arbiscan.io/tx/',
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    nativeAddress: EVM_NATIVE,
    wrappedNative: { address: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', symbol: 'WETH' },
    stables: [
      { address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', symbol: 'USDC' },
      { address: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', symbol: 'USDT' },
    ],
    extraSymbols: {},
    minGas: 0.00003,
    feeBuffer: 0.00005,
    standaloneApprovals: false,
    legacyGasPriceHeadroom: true,
  },
  polygon: {
    type: 'evm',
    name: 'Polygon',
    chainId: 137,
    index: '137',
    lifiChainId: '137',
    explorer: 'https://polygonscan.com/tx/',
    nativeSymbol: 'POL',
    nativeDecimals: 18,
    nativeAddress: EVM_NATIVE,
    wrappedNative: { address: '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270', symbol: 'WPOL' },
    stables: [
      { address: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', symbol: 'USDC' },
      { address: '0xc2132d05d31c914a87c6611c10748aeb04b58e8f', symbol: 'USDT' },
    ],
    // MATIC was renamed POL; accept the old symbol for the native token.
    extraSymbols: { MATIC: EVM_NATIVE },
    minGas: 0.2,
    feeBuffer: 0.5,
    standaloneApprovals: false,
    legacyGasPriceHeadroom: true,
  },
  // Robinhood Chain (Arbitrum Orbit). The trading service refuses it by the
  // caller's region; that refusal surfaces as the service's own error.
  robinhood: {
    type: 'evm',
    name: 'Robinhood',
    chainId: 4663,
    index: '4663',
    lifiChainId: '4663',
    explorer: 'https://robinhoodchain.blockscout.com/tx/',
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    nativeAddress: EVM_NATIVE,
    wrappedNative: null,
    // USDG (Global Dollar), 6 decimals. There is no USDC anchor here.
    stables: [
      { address: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', symbol: 'USDG' },
    ],
    extraSymbols: {},
    minGas: 0.00003,
    feeBuffer: 0.00005,
    standaloneApprovals: false,
    legacyGasPriceHeadroom: true,
  },
  // HyperEVM: a bridge destination only. Same-chain swaps get no quotes from the
  // trading service, and no public HyperEVM RPC serves eth_simulateV1, so a
  // transaction signed here would skip swap-outcome verification. Refused as
  // --chain (assertTradeSourceChain); bridging into it signs on the source chain.
  hyperevm: {
    type: 'evm',
    name: 'HyperEVM',
    chainId: 999,
    index: '999',
    lifiChainId: '999',
    explorer: 'https://hyperevmscan.io/tx/',
    nativeSymbol: 'HYPE',
    nativeDecimals: 18,
    nativeAddress: EVM_NATIVE,
    wrappedNative: { address: '0x5555555555555555555555555555555555555555', symbol: 'WHYPE' },
    stables: [
      { address: '0xb88339cb7199b77e23db6e890353e22632ba630f', symbol: 'USDC' },
    ],
    extraSymbols: {},
    // Unused while destinationOnly (no balance or gas check runs on a destination).
    minGas: 0.001,
    feeBuffer: 0.001,
    standaloneApprovals: false,
    legacyGasPriceHeadroom: false,
    destinationOnly: true,
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

/** Chain names `--chain` accepts: every chain that is not destination-only. */
export const TRADE_SOURCE_CHAIN_NAMES = TRADE_CHAIN_NAMES.filter((name) => !TRADE_CHAINS[name].destinationOnly);

/**
 * Refuse a destination-only chain as the chain a trade signs on.
 * @throws {Error} with an actionable message
 */
export function assertTradeSourceChain(name) {
  const chain = tradeChain(name);
  if (chain?.destinationOnly) {
    throw new Error(
      `${chain.name} is supported as a bridge destination only: use it as --to-chain from ${TRADE_SOURCE_CHAIN_NAMES.join(', ')}. Swaps on ${chain.name} itself are not available.`,
    );
  }
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
