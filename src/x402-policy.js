/**
 * x402 payment policy guard.
 * Decides whether an auto-payment is safe to sign before any signature is produced.
 * Three layers: known-asset allowlist, optional payTo allowlist, per-payment USD cap.
 * Two cumulative caps, an optional per-process one and a persisted daily one,
 * are charged by each signer, through signWithSpendCharge, immediately before
 * it signs.
 */

import { EVM_X402_TOKENS, SVM_X402_TOKENS } from './x402-tokens.js';
import { getWalletConfig } from './wallet.js';
import { addToDailySpend, subtractFromDailySpend } from './x402-spend-ledger.js';

// The only x402 scheme this client can honour. "exact" = a fixed-amount transfer
// authorization (EIP-3009 / Permit2 on EVM, SPL TransferChecked on SVM). Any other
// scheme must be refused before signing, not silently accepted.
export const SUPPORTED_X402_SCHEMES = new Set(['exact']);

/**
 * True for the exact Solana CAIP-2 network prefix ("solana:..."), matching
 * isSvmNetwork() in x402-svm.js. Duplicated here (rather than imported) to
 * avoid a circular dependency: x402-svm.js imports resolvePaymentAmount from
 * this module.
 */
function isSvmNetworkString(network) {
  return typeof network === 'string' && network.startsWith('solana:');
}

/**
 * Look up the known token entry for a (network, asset) pair.
 * Returns { token, symbol, decimals } or null if the pair is not a known
 * Nansen x402 payment asset.
 *
 * EVM addresses are compared case-insensitively (hex is case-insensitive
 * modulo EIP-55 checksum casing). Solana mint addresses are base58 and
 * MUST be compared case-sensitively — flipping the case of a base58 string
 * decodes to different bytes entirely, not the same address in a different
 * checksum casing.
 */
export function resolveKnownToken(network, asset) {
  if (typeof network !== 'string' || typeof asset !== 'string') return null;
  if (network.startsWith('eip155:')) {
    const table = EVM_X402_TOKENS[network];
    if (!table) return null;
    return table.find(t => t.token.toLowerCase() === asset.toLowerCase()) || null;
  }
  if (isSvmNetworkString(network)) {
    const table = SVM_X402_TOKENS[network];        // exact CAIP-2 key, not the bare 'solana' prefix
    if (!table) return null;
    return table.find(t => t.token === asset) || null;
  }
  return null;
}

// Default per-payment ceiling in USD. x402 API calls cost cents; $1.00 is a
// conservative safety ceiling — raise NANSEN_X402_MAX_AMOUNT if legitimate
// calls exceed it (they should not for normal API usage).
export const DEFAULT_X402_MAX_AMOUNT_USD = 1.0;

/**
 * Resolve the per-payment USD cap.
 * Precedence: NANSEN_X402_MAX_AMOUNT env var > wallet config x402MaxAmount > default.
 * Returns a positive number, or Infinity when explicitly set to "unlimited".
 */
export function resolveMaxAmountUsd() {
  const env = process.env.NANSEN_X402_MAX_AMOUNT;
  // An empty/whitespace-only value (e.g. an exported-but-unset shell var) must
  // be treated as unset, not as Number('') === 0 — a $0.00 cap would refuse
  // every real payment.
  if (env !== undefined && env.trim() !== '') {
    if (env.trim().toLowerCase() === 'unlimited') return Infinity;
    const n = Number(env);
    if (Number.isFinite(n) && n >= 0) return n;
    // fall through on garbage value
  }
  try {
    const cfg = getWalletConfig();
    if (cfg && cfg.x402MaxAmount !== undefined) {
      const n = Number(cfg.x402MaxAmount);
      if (Number.isFinite(n) && n >= 0) return n;
    }
  } catch { /* no config yet */ }
  return DEFAULT_X402_MAX_AMOUNT_USD;
}

/**
 * Optional payTo allowlist.
 * If NANSEN_X402_ALLOWED_PAYTO is set (comma-separated addresses), only those
 * recipients may be paid. Unset = no recipient restriction.
 *
 * Comparison is case-insensitive for EVM (hex) but case-sensitive for Solana
 * (base58) — see resolveKnownToken for why. `network` is required to know
 * which rule applies; omit it only for EVM-style (case-insensitive) checks.
 */
export function isPayToAllowed(payTo, network) {
  const raw = process.env.NANSEN_X402_ALLOWED_PAYTO;
  if (!raw) return true;
  const caseSensitive = isSvmNetworkString(network);
  const normalize = (s) => (caseSensitive ? s.trim() : s.trim().toLowerCase());
  const allow = raw.split(',').map(normalize).filter(Boolean);
  if (allow.length === 0) return true;
  return typeof payTo === 'string' && allow.includes(normalize(payTo));
}

/**
 * Resolve the payment amount field, preferring `amount` over the legacy
 * `maxAmountRequired` alias (older x402 implementations only send the latter).
 * A present-but-empty `amount` (e.g. "") is treated as missing so it falls
 * through to `maxAmountRequired` here too — the one place this decision is
 * made. Signers must call this instead of re-deriving the fallback themselves;
 * a mismatched `??` vs `||` between here and a signer is exactly the
 * amount-substitution bypass this guard exists to prevent.
 */
export function resolvePaymentAmount(requirement) {
  const amount = requirement.amount;
  if (amount !== undefined && amount !== null && amount !== '') return amount;
  return requirement.maxAmountRequired;
}

/**
 * Resolve the payment recipient field, preferring `payTo` (camelCase) over
 * the legacy `pay_to` (snake_case) alias. A present-but-empty `payTo` (e.g.
 * "") is treated as missing, exactly like resolvePaymentAmount — the same
 * single-source-of-truth rule signers must use instead of re-deriving the
 * fallback themselves.
 */
export function resolvePayTo(requirement) {
  const payTo = requirement.payTo;
  if (payTo !== undefined && payTo !== null && payTo !== '') return payTo;
  return requirement.pay_to;
}

/**
 * Decide whether an x402 payment requirement is safe to auto-sign.
 * Returns { ok: true, usd, symbol, network, asset, payTo, amountRaw } when
 * allowed (amountRaw is the parsed base-unit amount as a decimal string, so
 * "0x2710" and 1e4 both become "10000"), or
 * { ok: false, reason } with a human-readable, actionable reason when refused.
 *
 * Enforces in order: known (network, asset) allowlist, optional payTo
 * allowlist, per-payment USD cap. Never signs; pure decision.
 */
export function evaluatePaymentRequirement(requirement) {
  const scheme = requirement.scheme;
  if (!SUPPORTED_X402_SCHEMES.has(scheme)) {
    return {
      ok: false,
      reason:
        `Refusing to auto-pay: unsupported payment scheme ${scheme == null ? '(missing)' : `"${scheme}"`}. ` +
        `Only "exact" is supported. No signature was produced.`,
    };
  }

  const network = requirement.network;
  const asset = requirement.asset;
  const payTo = resolvePayTo(requirement);
  const amountRaw = resolvePaymentAmount(requirement);

  const known = resolveKnownToken(network, asset);
  if (!known) {
    return {
      ok: false,
      reason:
        `Refusing to auto-pay: asset ${asset} on ${network} is not a recognized ` +
        `Nansen payment token. No signature was produced.`,
    };
  }

  if (payTo === undefined || payTo === null || payTo === '') {
    return {
      ok: false,
      reason: 'Refusing to auto-pay: payTo field is missing from the payment requirement.',
    };
  }

  if (!isPayToAllowed(payTo, network)) {
    return {
      ok: false,
      reason: `Refusing to auto-pay: recipient ${payTo} is not in NANSEN_X402_ALLOWED_PAYTO.`,
    };
  }

  if (amountRaw === undefined || amountRaw === null) {
    return { ok: false, reason: 'Refusing to auto-pay: amount field is missing from the payment requirement.' };
  }

  let usd;
  let base;
  try {
    // BigInt base units → USD. Keep integer/fraction split to avoid float loss
    // on large values; final Number() is safe for display-scale amounts.
    base = BigInt(amountRaw);
    // A transfer authorization must be for a positive amount; a negative value
    // is never legitimate and should never be signed.
    if (base < 0n) {
      return { ok: false, reason: `Refusing to auto-pay: negative amount ${amountRaw}.` };
    }
    const scale = 10n ** BigInt(known.decimals);
    // Number arithmetic is precise enough for stablecoin amounts at 6 or 18
    // decimals against a dollar-scale cap. Would need BigInt-native comparison
    // if supported decimals or cap magnitudes change significantly.
    usd = Number(base / scale) + Number(base % scale) / Number(scale);
  } catch {
    return { ok: false, reason: `Refusing to auto-pay: unparseable amount ${amountRaw}.` };
  }

  // Cap is inclusive: an amount exactly at the cap is allowed (usd > cap, not >=).
  // Note a cap of 0 still permits a zero-value payment (0 > 0 is false); use
  // NANSEN_X402_ALLOWED_PAYTO or an unfunded wallet to block signing entirely.
  const cap = resolveMaxAmountUsd();
  if (usd > cap) {
    const capStr = Number.isFinite(cap) ? `$${cap.toFixed(2)}` : 'unlimited';
    return {
      ok: false,
      reason:
        `Refusing to auto-pay $${usd.toFixed(2)} ${known.symbol}: exceeds the ` +
        `${capStr} per-payment cap. To authorize, raise it with ` +
        `NANSEN_X402_MAX_AMOUNT=<usd> (or NANSEN_X402_MAX_AMOUNT=unlimited to disable).`,
    };
  }

  return {
    ok: true,
    usd,
    // A decimal string, not a BigInt, so the decision stays JSON-serializable.
    amountMicroUsd: toMicroUsd(base, known.decimals).toString(),
    symbol: known.symbol,
    network,
    asset,
    payTo,
    amountRaw: base.toString(),
  };
}

// Cumulative USD auto-paid by this process, in integer micro-USD so repeated
// charges can't drift past an exact cap the way float sums do (0.1 + 0.2).
// It resets with every process: the cap bounds one invocation (its retries,
// fallbacks and concurrent requests), not spending across separate runs.
let sessionSpentMicroUsd = 0n;
// The caps as first read, so they can't change partway through a run.
let sessionCap;
let dailyCap;

const MICRO_USD_PER_USD = 1_000_000n;
const USD_AMOUNT = /^\d+(\.\d+)?$/;
const DEFAULT_DAILY_MAX_MICRO_USD = 50n * MICRO_USD_PER_USD;

/**
 * Token base units → micro-USD, rounded up so a fraction of a micro-dollar is
 * never charged as zero.
 */
function toMicroUsd(base, decimals) {
  const scale = 10n ** BigInt(decimals);
  return (base * MICRO_USD_PER_USD + scale - 1n) / scale;
}

/** "$0.01", or up to six decimals ("$0.0015") when a sub-cent amount needs them. */
function formatMicroUsd(micro) {
  const fraction = (micro % MICRO_USD_PER_USD).toString().padStart(6, '0').replace(/0{1,4}$/, '');
  return `$${micro / MICRO_USD_PER_USD}.${fraction}`;
}

/**
 * Parse a USD cap environment variable as micro-USD.
 * Returns `fallback` when it is unset or empty, null when it is "unlimited",
 * or { error } for a value that isn't a plain non-negative decimal: a safety
 * cap the user asked for must not silently turn off because of a typo.
 */
function resolveCapMicroUsd(name, fallback, label) {
  const env = process.env[name];
  if (env === undefined || env.trim() === '') return fallback;
  const value = env.trim();
  if (value.toLowerCase() === 'unlimited') return null;
  // Plain decimals only: Number() would read "0x10" as $16 and "1e3" as $1000.
  if (!USD_AMOUNT.test(value)) {
    return {
      error:
        `Refusing to auto-pay: ${name}="${env}" is not a valid USD amount. ` +
        `Set it to a number such as 5.00, or ${fallback === null ? 'unset it' : `set ${name}=unlimited`} to disable the ${label} cap. No signature was produced.`,
    };
  }
  const [whole, fraction = ''] = value.split('.');
  // Digits past the sixth decimal are dropped, which can only lower the cap.
  return BigInt(whole) * MICRO_USD_PER_USD + BigInt(fraction.slice(0, 6).padEnd(6, '0'));
}

/**
 * NANSEN_X402_SESSION_MAX_AMOUNT in micro-USD: null when disabled (unset,
 * empty or "unlimited"), or { error } when invalid.
 */
export function resolveSessionMaxMicroUsd() {
  return resolveCapMicroUsd('NANSEN_X402_SESSION_MAX_AMOUNT', null, 'session');
}

/**
 * NANSEN_X402_DAILY_MAX_AMOUNT in micro-USD: $50.00 when unset or empty, null
 * for "unlimited", or { error } when invalid.
 */
export function resolveDailyMaxMicroUsd() {
  return resolveCapMicroUsd('NANSEN_X402_DAILY_MAX_AMOUNT', DEFAULT_DAILY_MAX_MICRO_USD, 'daily');
}

function sessionMaxMicroUsd() {
  if (sessionCap === undefined) sessionCap = resolveSessionMaxMicroUsd();
  return sessionCap;
}

function dailyMaxMicroUsd() {
  if (dailyCap === undefined) dailyCap = resolveDailyMaxMicroUsd();
  return dailyCap;
}

const capError = cap => (cap !== null && typeof cap === 'object' ? cap.error : null);

/**
 * The refusal reason when NANSEN_X402_SESSION_MAX_AMOUNT or
 * NANSEN_X402_DAILY_MAX_AMOUNT is invalid, else null. Check it once before
 * any payment work, so the error is reported once and before any balance or
 * blockhash request.
 */
export function spendCapConfigError() {
  return capError(sessionMaxMicroUsd()) ?? capError(dailyMaxMicroUsd());
}

const unknownAmount = cap =>
  `Refusing to auto-pay: payment amount is unknown, so the ${cap} cap cannot be applied. No signature was produced.`;
const knownAmount = decision => typeof decision.amountMicroUsd === 'string' && /^\d+$/.test(decision.amountMicroUsd);

/**
 * Count an approved payment against the persisted daily cap.
 * Returns { ok: true, release } or { ok: false, reason }. release() takes the
 * payment back off the day it was counted on. A failed release keeps it
 * counted, which only over-counts.
 */
export function chargeDailySpend(decision, now = new Date()) {
  const cap = dailyMaxMicroUsd();
  if (cap === null) return { ok: true, release: () => {} };
  if (typeof cap === 'object') return { ok: false, reason: cap.error };
  if (!knownAmount(decision)) return { ok: false, reason: unknownAmount('daily') };

  const micro = BigInt(decision.amountMicroUsd);
  let result;
  try {
    result = addToDailySpend(micro, cap, now);
  } catch (err) {
    return { ok: false, reason: err.message };
  }
  if (result.ok) {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      try { subtractFromDailySpend(micro, now); } catch { /* stays counted */ }
    };
    return { ok: true, release };
  }
  return {
    ok: false,
    reason:
      `Refusing to auto-pay ${formatMicroUsd(micro)} ${decision.symbol}: x402 auto-payments today (UTC) already total ` +
      `${formatMicroUsd(result.spent)}, and the payment would exceed the ${formatMicroUsd(cap)} daily cap. ` +
      'To authorize, raise it with NANSEN_X402_DAILY_MAX_AMOUNT=<usd> (or NANSEN_X402_DAILY_MAX_AMOUNT=unlimited to disable). ' +
      'No signature was produced.',
  };
}

/**
 * Charge an approved payment against the per-process cumulative cap.
 * Prefer signWithSpendCharge, which also runs the signer and releases the
 * charge when signing fails.
 *
 * `decision` is the { ok: true } result of evaluatePaymentRequirement.
 * Returns { ok: true, release } and adds the amount to the session total, or
 * { ok: false, reason } and leaves the total unchanged.
 */
export function chargeSessionSpend(decision) {
  const cap = sessionMaxMicroUsd();
  if (cap === null) return { ok: true, release: () => {} };
  if (typeof cap === 'object') return { ok: false, reason: cap.error };

  if (!knownAmount(decision)) {
    return { ok: false, reason: unknownAmount('session') };
  }

  const micro = BigInt(decision.amountMicroUsd);
  const total = sessionSpentMicroUsd + micro;
  if (total > cap) {
    return {
      ok: false,
      reason:
        `Refusing to auto-pay ${formatMicroUsd(micro)} ${decision.symbol}: this process has already auto-paid ` +
        `${formatMicroUsd(sessionSpentMicroUsd)}, and the payment would exceed the ${formatMicroUsd(cap)} ` +
        'session cap. To authorize, raise it with NANSEN_X402_SESSION_MAX_AMOUNT=<usd> (or unset it to disable). ' +
        'No signature was produced.',
    };
  }
  sessionSpentMicroUsd = total;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    sessionSpentMicroUsd -= micro;
  };
  return { ok: true, release };
}

/**
 * Charge the session and daily caps for an approved payment, then run `sign`.
 * The charges and the start of the signer happen in the same tick, so
 * concurrent requests in one process can't both pass the checks. Call it
 * after every async check that could still skip the option.
 *
 * Returns { ok: false, reason } when a cap refuses, without calling `sign`,
 * or { ok: true, value, release }. Both charges are released if `sign`
 * throws. The caller calls release() if the server cleanly rejects the
 * payment; any other outcome keeps them, so the caps can only over-count.
 */
export async function signWithSpendCharge(decision, sign) {
  const charge = chargeSessionSpend(decision);
  if (!charge.ok) return charge;
  // The session check comes first: undoing it is free, undoing the daily
  // charge rewrites the ledger.
  const daily = chargeDailySpend(decision);
  if (!daily.ok) {
    charge.release();
    return daily;
  }
  const release = () => {
    charge.release();
    daily.release();
  };
  try {
    return { ok: true, value: await sign(), release };
  } catch (err) {
    release();
    throw err;
  }
}

export function resetSpendCapsForTests() {
  sessionSpentMicroUsd = 0n;
  sessionCap = undefined;
  dailyCap = undefined;
}
