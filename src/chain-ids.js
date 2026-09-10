/**
 * Canonical EVM chain name → numeric chain ID mapping.
 *
 * Single source of truth — import from here instead of defining inline.
 */

// If you add a chain to EVM_CHAINS below, add its numeric chain ID here too.
// transfer.js's EVM transfer paths (both local-wallet and WalletConnect) look
// up the chain ID here and fail closed with "Unsupported chain" when it's
// missing -- so a chain listed in EVM_CHAINS but absent here can't actually
// be used to send a transfer yet, even though address-format validation and
// ENS resolution already accept it.
export const EVM_CHAIN_IDS = {
  ethereum: 1,
  base: 8453,
  optimism: 10,
  arbitrum: 42161,
  polygon: 137,
  avalanche: 43114,
  bnb: 56,
  linea: 59144,
  scroll: 534352,
  mantle: 5000,
};

/**
 * All EVM chain names recognised by this CLI.
 * Used for address-format validation (0x...) and ENS resolution gating.
 * Import from here instead of defining an inline list per file.
 */
export const EVM_CHAINS = [
  'ethereum', 'arbitrum', 'base', 'bnb', 'polygon', 'optimism',
  'avalanche', 'linea', 'scroll', 'mantle', 'ronin',
  'sei', 'plasma', 'sonic', 'monad', 'hyperevm', 'iotaevm',
];
