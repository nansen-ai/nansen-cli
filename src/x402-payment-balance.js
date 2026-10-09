import { CHAIN_RPCS } from './rpc-urls.js';
import { resolvePaymentAmount, resolveKnownToken } from './x402-policy.js';

// RPC endpoint per supported x402 EVM network.
export const EVM_X402_RPCS = {
  'eip155:8453': CHAIN_RPCS.base,
  'eip155:196': CHAIN_RPCS.xlayer,
  'eip155:56': CHAIN_RPCS.bsc,
};

/**
 * Skip known unfunded EVM options before signing. RPC failures remain
 * best-effort: let server verification decide when the balance is unknown.
 */
export async function hasSufficientEvmPaymentBalance(requirement, address) {
  const rpc = EVM_X402_RPCS[requirement.network];
  if (!rpc) return true;
  const token = resolveKnownToken(requirement.network, requirement.asset);
  const symbol = token?.symbol || 'token';
  const amount = BigInt(resolvePaymentAmount(requirement));
  let balance;
  try {
    const response = await fetch(rpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'eth_call',
        params: [{
          to: requirement.asset,
          data: `0x70a08231${address.replace(/^0x/, '').toLowerCase().padStart(64, '0')}`,
        }, 'latest'],
      }),
      signal: AbortSignal.timeout(5000),
    });
    const data = await response.json();
    if (response.ok === false || data.error || !/^0x[0-9a-f]+$/i.test(data.result)) {
      throw new Error('Balance unavailable');
    }
    balance = BigInt(data.result);
  } catch {
    console.error(`[x402] Unable to check ${symbol} balance on ${requirement.network}; deferring to server verification.`);
    return true;
  }
  if (balance < amount) {
    console.error(
      `[x402] Skipping ${symbol} on ${requirement.network}: insufficient token balance. ` +
      `Fund this token on this network or use another funded payment option.`,
    );
    return false;
  }
  return true;
}
