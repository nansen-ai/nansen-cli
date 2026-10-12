/**
 * x402 Auto-Payment via WalletConnect
 *
 * Handles automatic payment signing when the API returns HTTP 402.
 * Uses the walletconnect CLI to check wallet connection and sign EIP-712 typed data.
 */

import crypto from 'crypto';
import { NansenError, ErrorCode } from './api.js';
import { wcExec } from './walletconnect-exec.js';
import { getWalletConnectAddress, parseWcJson } from './walletconnect-trading.js';
import { evaluatePaymentRequirement, resolvePaymentAmount, resolvePayTo } from './x402-policy.js';
import { isEvmNetwork } from './x402-evm.js';
import { rankRequirements } from './x402.js';
import { hasSufficientEvmPaymentBalance } from './x402-payment-balance.js';

/**
 * True for an option this path can sign: scheme=exact with EIP-3009
 * TransferWithAuthorization support (extra.name + extra.version). Like the
 * local EVM signer, only an absent or "eip3009" transfer method is signed as
 * EIP-3009; Permit2 and unknown methods are not compatible.
 */
function isCompatible(req) {
  const method = req?.extra?.assetTransferMethod;
  return Boolean(
    req?.scheme === 'exact' &&
    req.extra?.name &&
    req.extra?.version &&
    (!method || method === 'eip3009')
  );
}

/**
 * Select a compatible payment requirement from the accepts array.
 */
export function selectPaymentRequirement(accepts) {
  if (!Array.isArray(accepts) || accepts.length === 0) return null;
  return accepts.find(isCompatible) || null;
}

/**
 * Parse chain ID from network string (e.g., "eip155:8453" → 8453)
 */
function parseChainId(network) {
  if (!network) return null;
  const match = network.match(/^eip155:(\d+)$/);
  return match ? Number(match[1]) : null;
}

/**
 * Build EIP-712 typed data for TransferWithAuthorization (EIP-3009).
 */
export function buildEIP712TypedData({ fromAddress, requirement }) {
  const payTo = resolvePayTo(requirement);
  const { asset, maxTimeoutSeconds } = requirement;
  const extra = requirement.extra || {};
  const amount = resolvePaymentAmount(requirement);

  if (!extra.name || !extra.version) {
    throw new Error(
      'Refusing to sign x402 payment: EIP-712 domain name/version missing from requirement.extra.',
    );
  }

  // Chain id comes only from the CAIP-2 network the policy validated — not from
  // a remote extra.chainId override, which could change the signing domain.
  const chainId = parseChainId(requirement.network);
  if (chainId === null) {
    throw new Error(
      `Refusing to sign x402 payment: unsupported or missing EVM network ${requirement.network}.`,
    );
  }
  // A remote extra.chainId that disagrees with the network is a domain-binding
  // mismatch — refuse rather than sign under either interpretation. A null or
  // empty extra.chainId means "unspecified", not a conflict, so treat it as absent.
  if (extra.chainId != null && extra.chainId !== '' && Number(extra.chainId) !== chainId) {
    throw new Error(
      `Refusing to sign x402 payment: extra.chainId ${extra.chainId} conflicts with ` +
      `network ${requirement.network} (chain id ${chainId}).`,
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const nonce = '0x' + crypto.randomBytes(32).toString('hex');

  const typedData = {
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'TransferWithAuthorization',
    domain: {
      name: extra.name,
      version: extra.version,
      chainId,
      verifyingContract: asset,
    },
    message: {
      from: fromAddress,
      to: payTo,
      value: amount,
      validAfter: now - 600, // 10 min in the past to tolerate clock skew between client and verifier
      validBefore: now + (maxTimeoutSeconds || 120),
      nonce,
    },
  };

  return typedData;
}

/**
 * Build the base64-encoded Payment-Signature header value.
 * Follows x402 v2 spec: { x402Version, resource, accepted, payload }
 */
export function buildPaymentSignatureHeader({ signature, authorization, resource, accepted }) {
  const paymentPayload = {
    x402Version: 2,
    resource: resource || { url: '', description: '', mimeType: '' },
    accepted: accepted || {},
    payload: {
      signature,
      authorization,
    },
  };
  return Buffer.from(JSON.stringify(paymentPayload), 'utf8').toString('base64');
}

/**
 * Format amount for human-readable display (e.g., "0.01 USDC")
 */
function formatPaymentAmount(requirement) {
  const { extra } = requirement;
  const rawAmount = resolvePaymentAmount(requirement);
  const symbol = extra.symbol || extra.name || 'tokens';
  const decimals = extra.decimals || 6;
  const amount = Number(rawAmount) / Math.pow(10, decimals);
  const chain = requirement.network || requirement.chain || 'unknown';
  return `${amount} ${symbol} on ${chain}`;
}

/**
 * Prepare one option for signing: policy, chain-scoped session, balance,
 * typed data. Returns { fromAddress, typedData } or { error } explaining why
 * the option is skipped; `logged` marks an error already reported on stderr.
 */
async function prepareRequirement(requirement) {
  // Evaluate payment policy before touching any signing material
  const decision = evaluatePaymentRequirement(requirement);
  if (!decision.ok) return { error: new Error(decision.reason) };

  // Resolve the WalletConnect signer scoped to this exact chain. EVM
  // addresses are identical across chains, so "some account exists in the
  // session" can't prove the session was actually approved for THIS chain --
  // only the CAIP-2 chain tag can (mirrors getWalletConnectAddress's chainId
  // param, used the same way before signing/broadcasting in trading.js and
  // transfer.js). Without this, a session connected only to, say, Base would
  // be silently accepted to authorize a payment on BNB Chain or X Layer --
  // the same defect class fixed in #615, just unguarded here because this
  // path never reused getWalletConnectAddress and instead took accounts[0]
  // with no chain filter at all.
  const chainId = parseChainId(requirement.network);
  if (chainId === null) {
    return { error: new Error(`Refusing to auto-pay: unsupported or missing EVM network ${requirement.network}.`) };
  }
  const fromAddress = await getWalletConnectAddress('evm', chainId);
  if (!fromAddress) {
    return {
      error: new NansenError(
        `x402 payment required but no WalletConnect session is active for chain ${requirement.network}. ` +
          'To pay automatically: create a local wallet with `nansen wallet create` (then set NANSEN_WALLET_PASSWORD), ' +
          'or connect an external wallet approved for this chain via the `walletconnect` CLI (`walletconnect connect`).',
        ErrorCode.PAYMENT_REQUIRED,
        402
      ),
    };
  }

  // Don't ask the user to approve a payment the wallet can't cover.
  if (!await hasSufficientEvmPaymentBalance(requirement, fromAddress)) {
    return {
      logged: true,
      error: new NansenError(
        `x402 payment required but the WalletConnect wallet has an insufficient token balance on ${requirement.network}. ` +
          'Fund the token on this network or use another funded payment option.',
        ErrorCode.PAYMENT_REQUIRED,
        402
      ),
    };
  }

  try {
    return { fromAddress, typedData: buildEIP712TypedData({ fromAddress, requirement }) };
  } catch (error) {
    return { error };
  }
}

/**
 * Ask the connected wallet to sign one option and build its header.
 * A rejected, timed-out, or malformed signature throws: the user was already
 * prompted, so the caller must not prompt again for another option.
 */
async function signRequirement(requirement, fromAddress, typedData, resource) {
  const typedDataJson = JSON.stringify(typedData);

  // Log payment info to stderr (stdout is for JSON output)
  const amountStr = formatPaymentAmount(requirement);
  process.stderr.write(`x402: Requesting payment approval (${amountStr})...\n`);

  // Sign via walletconnect CLI (120s timeout for user approval)
  let signResult;
  try {
    const output = await wcExec('walletconnect', ['sign-typed-data', typedDataJson], 120000);
    // walletconnect may print status messages before the result and may
    // pretty-print it over several lines. Reading only the first line that
    // starts with "{" used to throw on a multi-line result — after the user
    // had already approved and signed the payment in their wallet.
    signResult = parseWcJson(output);
    if (typeof signResult?.signature !== 'string' || signResult.signature.length === 0) {
      throw new Error('walletconnect sign-typed-data returned no signature');
    }
  } catch (err) {
    throw new NansenError(
      `x402 payment signing failed: ${err.message}`,
      ErrorCode.PAYMENT_REQUIRED,
      402
    );
  }

  // Build Payment-Signature header (authorization values must be strings per x402 spec)
  const authorization = {
    from: fromAddress,
    to: resolvePayTo(requirement),
    value: resolvePaymentAmount(requirement).toString(),
    validAfter: typedData.message.validAfter.toString(),
    validBefore: typedData.message.validBefore.toString(),
    nonce: typedData.message.nonce,
  };

  const headerValue = buildPaymentSignatureHeader({
    signature: signResult.signature,
    authorization,
    resource,
    accepted: requirement,
  });

  process.stderr.write(`x402: Payment signed successfully.\n`);
  return headerValue;
}

/**
 * Generate WalletConnect payment signatures for every viable option, cheapest
 * first (the same ranking the local wallet uses). Options refused by policy,
 * without a session for their chain, or known to be unfunded are skipped
 * before the user is prompted. Caller tries each until the server accepts one.
 *
 * Throws when nothing can be signed (the last skip reason) or when signing
 * itself fails.
 *
 * @param {Object} paymentRequirements - Decoded payment requirements from 402 response
 * @returns {AsyncGenerator<{ signature: string, network: string, asset: string }>}
 */
export async function* createWalletConnectPaymentSignatures(paymentRequirements) {
  const accepts = paymentRequirements.accepts || paymentRequirements;
  const list = Array.isArray(accepts) ? accepts : [accepts];
  const compatible = rankRequirements(list.filter(isCompatible))
    .filter(req => isEvmNetwork(req.network));
  if (compatible.length === 0) {
    const available = list.map(r => r?.scheme).join(', ');
    throw new NansenError(
      `x402 payment required but no compatible payment method found. Available: ${available || 'none'}. Need scheme=exact with EIP-3009 support.`,
      ErrorCode.PAYMENT_REQUIRED,
      402
    );
  }

  const resource = paymentRequirements.resource || { url: '', description: '', mimeType: '' };
  let lastError = null;
  let yielded = false;
  for (const requirement of compatible) {
    const { fromAddress, typedData, error, logged } = await prepareRequirement(requirement);
    if (error) {
      if (compatible.length > 1 && !logged) console.error(`[x402] Skipping ${requirement.network} WalletConnect option: ${error.message}`);
      lastError = error;
      continue;
    }
    const signature = await signRequirement(requirement, fromAddress, typedData, resource);
    yielded = true;
    yield { signature, network: requirement.network, asset: requirement.asset };
  }
  if (!yielded && lastError) throw lastError;
}

/**
 * Handle x402 payment: return the first viable Payment-Signature header.
 * For fallback across options, use createWalletConnectPaymentSignatures().
 *
 * @param {Object} paymentRequirements - Decoded payment requirements from 402 response
 * @returns {string} Base64-encoded Payment-Signature header value
 * @throws {NansenError} On failure
 */
export async function handleX402Payment(paymentRequirements) {
  for await (const { signature } of createWalletConnectPaymentSignatures(paymentRequirements)) {
    return signature;
  }
  throw new NansenError('x402 payment required but no WalletConnect payment option could be signed.', ErrorCode.PAYMENT_REQUIRED, 402);
}
