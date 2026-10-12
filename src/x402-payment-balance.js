import { CHAIN_RPCS } from './rpc-urls.js';
import { resolvePaymentAmount, resolveKnownToken } from './x402-policy.js';
import { deriveATA, getSolanaRpcUrl } from './x402-svm.js';

// RPC endpoint per supported x402 EVM network.
export const EVM_X402_RPCS = {
  'eip155:8453': CHAIN_RPCS.base,
  'eip155:196': CHAIN_RPCS.xlayer,
  'eip155:56': CHAIN_RPCS.bsc,
};

async function rpcResult(rpc, method, params) {
  const response = await fetch(rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(5000),
  });
  const data = await response.json();
  if (response.ok === false || data.error) throw new Error('Balance unavailable');
  return data.result;
}

/**
 * Compare a raw balance read with the payment amount. A read that throws is
 * unknown, not zero: let server verification decide.
 */
async function hasSufficientBalance(requirement, readBalance) {
  const token = resolveKnownToken(requirement.network, requirement.asset);
  const symbol = token?.symbol || 'token';
  const amount = BigInt(resolvePaymentAmount(requirement));
  let balance;
  try {
    balance = await readBalance();
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

/**
 * Skip known unfunded EVM options before signing. RPC failures remain
 * best-effort: let server verification decide when the balance is unknown.
 */
export async function hasSufficientEvmPaymentBalance(requirement, address) {
  const rpc = EVM_X402_RPCS[requirement.network];
  if (!rpc) return true;
  return hasSufficientBalance(requirement, async () => {
    const result = await rpcResult(rpc, 'eth_call', [{
      to: requirement.asset,
      data: `0x70a08231${address.replace(/^0x/, '').toLowerCase().padStart(64, '0')}`,
    }, 'latest']);
    if (!/^0x[0-9a-f]+$/i.test(result)) throw new Error('Balance unavailable');
    return BigInt(result);
  });
}

/**
 * Solana counterpart of hasSufficientEvmPaymentBalance. The payment transfers
 * from the payer's associated token account, so only that account counts: a
 * missing ATA is a zero balance, not an unknown one.
 */
export async function hasSufficientSvmPaymentBalance(requirement, address) {
  let rpc;
  try {
    rpc = getSolanaRpcUrl(requirement.network);
  } catch {
    return true;
  }
  return hasSufficientBalance(requirement, async () => {
    const result = await rpcResult(rpc, 'getTokenAccountsByOwner', [
      address, { mint: requirement.asset }, { encoding: 'jsonParsed' },
    ]);
    if (!Array.isArray(result?.value)) throw new Error('Balance unavailable');
    const ata = deriveATA(address, requirement.asset);
    const account = result.value.find(entry => entry?.pubkey === ata);
    if (!account) return 0n;
    const raw = account.account?.data?.parsed?.info?.tokenAmount?.amount;
    if (typeof raw !== 'string' || !/^\d+$/.test(raw)) throw new Error('Balance unavailable');
    return BigInt(raw);
  });
}
