/**
 * Token-2022 UI-amount extensions.
 *
 * Wallets and explorers show some Token-2022 balances as something other than
 * raw / 10^decimals:
 * - scaled UI amount: raw / 10^decimals × multiplier. The mint's authority can
 *   schedule a new multiplier that takes over at a set time (a dividend or a
 *   split for tokenized stocks).
 * - interest-bearing: the displayed amount grows with accrued interest.
 *
 * An --amount the user types is the amount their wallet shows, so these mints
 * need converting to raw units. Pure functions, no I/O.
 */

// Refuse to convert while a scheduled multiplier change is this close: the
// transaction could land, or a saved trade quote (valid for an hour) could be
// executed, under the other multiplier.
export const MULTIPLIER_SWITCH_AHEAD_SEC = 3600;
export const MULTIPLIER_SWITCH_BEHIND_SEC = 300;

const U64_MAX = (1n << 64n) - 1n;
// Token-2022's amount_to_ui_amount displays a scaled amount in two f64 steps:
// n = trunc(f64(raw) × multiplier), then n / 10^decimals printed to `decimals`
// places. Casting raw to f64 is exact only below 2^53; the division and
// printing return n exactly only when n has at most 15 significant digits.
const F64_EXACT_LIMIT = 2n ** 53n;
const DISPLAY_UNITS_LIMIT = 10n ** 15n;

/** A positive plain decimal string ("6.0048") as { num, scale }: value = num / 10^scale. */
function parsePositiveDecimal(str) {
  if (typeof str !== 'string' || !/^\d+(\.\d+)?$/.test(str)) return null;
  const [whole, frac = ''] = str.split('.');
  const num = BigInt(whole + frac);
  if (num === 0n) return null;
  return { num, scale: BigInt(frac.length) };
}

/**
 * Classify a mint by its jsonParsed `info` (getAccountInfo, encoding jsonParsed).
 * Never throws, so callers that work in raw units (--max, percent, base units)
 * keep working on every kind; only displayedAmountToRaw refuses.
 *
 * @returns {{kind: 'plain'} | {kind: 'interest-bearing'} | {kind: 'invalid', reason: string}
 *   | {kind: 'scaled', multiplier: string, newMultiplier: string, effectiveTimestamp: number}}
 */
export function readUiAmountConfig(parsedMintInfo) {
  const extensions = parsedMintInfo?.extensions;
  if (extensions === undefined) return { kind: 'plain' };
  if (!Array.isArray(extensions)) return { kind: 'invalid', reason: 'the mint extensions are not a list' };
  if (extensions.some(e => e?.extension === 'interestBearingConfig')) return { kind: 'interest-bearing' };
  // An entry the CLI cannot name could be the scaled UI amount one: the RPC's
  // jsonParsed decoder emits { extension: 'unparseableExtension' } for any it
  // could not decode.
  // findIndex, not find: find returns the entry itself, so an undefined entry
  // would look like "nothing found".
  const unnamed = extensions.findIndex(e => e === null || typeof e !== 'object' || typeof e.extension !== 'string');
  if (unnamed !== -1) return { kind: 'invalid', reason: `one of its mint extensions is malformed: ${JSON.stringify(extensions[unnamed] ?? null)}` };
  if (extensions.some(e => e.extension === 'unparseableExtension')) {
    return { kind: 'invalid', reason: 'the RPC could not decode one of its mint extensions, which may be the scaled UI amount one' };
  }
  const scaled = extensions.find(e => e?.extension === 'scaledUiAmountConfig');
  if (!scaled) return { kind: 'plain' };
  const state = scaled.state;
  const timestamp = state?.newMultiplierEffectiveTimestamp;
  if (!parsePositiveDecimal(state?.multiplier) || !parsePositiveDecimal(state?.newMultiplier) || !Number.isSafeInteger(timestamp)) {
    return { kind: 'invalid', reason: `the scaled UI amount config is unreadable: ${JSON.stringify(state ?? null)}` };
  }
  return {
    kind: 'scaled',
    multiplier: state.multiplier,
    newMultiplier: state.newMultiplier,
    effectiveTimestamp: timestamp,
  };
}

/** The multiplier in effect at `nowSec`, as on-chain: the new one from its effective time on. */
export function effectiveMultiplier(config, nowSec) {
  return nowSec >= config.effectiveTimestamp ? config.newMultiplier : config.multiplier;
}

function sameValue(a, b) {
  const x = parsePositiveDecimal(a);
  const y = parsePositiveDecimal(b);
  return x.num * 10n ** y.scale === y.num * 10n ** x.scale;
}

/**
 * Raw units shown as `decimals`-place text, truncated like the RPC's
 * uiAmountString: trunc(raw × multiplier / 10^decimals).
 */
export function scaledRawToUiAmount(raw, decimals, config, nowSec) {
  const m = parsePositiveDecimal(effectiveMultiplier(config, nowSec));
  const scaledUnits = BigInt(raw) * m.num / 10n ** m.scale;
  if (decimals === 0) return scaledUnits.toString();
  const digits = scaledUnits.toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, -decimals);
  const frac = digits.slice(-decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

/**
 * Convert a displayed amount of a scaled-UI-amount mint to raw units, rounded
 * down so the transfer never exceeds what the user asked for.
 * raw = floor(amount × 10^decimals / multiplier), in exact integer math.
 */
export function scaledUiAmountToRaw(amountStr, decimals, config, nowSec, mint = 'this token') {
  const str = String(amountStr).trim();
  if (str.startsWith('-')) throw new Error('Amount must be positive');
  if (!/^\d+(\.\d+)?$/.test(str)) throw new Error('Amount must be a valid number');
  if (/^0+(\.0+)?$/.test(str)) throw new Error('Amount must be greater than zero');

  const secondsToSwitch = config.effectiveTimestamp - nowSec;
  if (!sameValue(config.multiplier, config.newMultiplier)
      && secondsToSwitch <= MULTIPLIER_SWITCH_AHEAD_SEC && secondsToSwitch >= -MULTIPLIER_SWITCH_BEHIND_SEC) {
    const at = new Date(config.effectiveTimestamp * 1000).toISOString();
    throw new Error(
      `Token ${mint} changes its display multiplier from ${config.multiplier} to ${config.newMultiplier} at ${at}. ` +
      'The amount it shows in wallets changes then, so the CLI will not convert a displayed amount within an hour before ' +
      `or ${MULTIPLIER_SWITCH_BEHIND_SEC / 60} minutes after the change. Nothing was signed or sent. Try again after ${new Date((config.effectiveTimestamp + MULTIPLIER_SWITCH_BEHIND_SEC) * 1000).toISOString()}.`,
    );
  }

  const m = parsePositiveDecimal(effectiveMultiplier(config, nowSec));
  const [whole, frac = ''] = str.split('.');
  const amountNum = BigInt(whole + frac);
  const amountScale = BigInt(frac.length);
  const raw = (amountNum * 10n ** BigInt(decimals) * 10n ** m.scale) / (10n ** amountScale * m.num);
  if (raw === 0n) {
    throw new Error(
      `Amount ${str} is below the smallest unit of this token (${decimals} decimals, display multiplier ${effectiveMultiplier(config, nowSec)}) and would send nothing. Use a larger amount.`,
    );
  }
  if (raw > U64_MAX) throw new Error(`Amount ${str} is larger than any token balance can be`);
  // raw is cast to f64 first; the requested amount in displayed base units
  // (amountNum × 10^decimals / 10^amountScale) must survive / 10^decimals and printing.
  if (raw >= F64_EXACT_LIMIT || amountNum * 10n ** BigInt(decimals) >= DISPLAY_UNITS_LIMIT * 10n ** amountScale) {
    throw new Error(
      `Amount ${str} is too large to convert exactly for this token: wallets compute its displayed amount in floating point, ` +
      'which is exact only up to 15 significant digits. Nothing was signed or sent. Send it in smaller parts.',
    );
  }
  return raw;
}
