/**
 * Exact Lightning money (PAY-06): BTC as P9 canonical decimal text ↔ integer
 * millisatoshis, and BOLT11's human-readable amount → millisatoshis.
 *
 * ```
 * 1 BTC = 100 000 000 sat = 100 000 000 000 msat          (10^11)
 * "0.00000001" BTC = 1 sat = 1000 msat
 * "0.00000000001" BTC = 1 msat                            (the smallest transferable unit)
 * ```
 *
 * Text and `BigInt` only: no `Number` holds a monetary quantity, nothing is
 * rounded, truncated or parsed as a float. A value that needs a sub-millisatoshi
 * digit is refused, never rounded; zero is refused (a payment is positive); a
 * value above the protocol's own bound (21 000 000 BTC, and LND's signed 64-bit
 * millisatoshi fields) is refused.
 */

/** Millisatoshis per BTC. */
export const MSAT_PER_BTC = 100_000_000_000n;

/** The fractional digits one millisatoshi needs: `BTC` amounts carry at most 11. */
export const LIGHTNING_BTC_MAXIMUM_SCALE = 11;

/** Bitcoin's supply bound in millisatoshis — no real invoice or payment exceeds it, and every node field holding one fits a signed 64-bit integer. */
export const LIGHTNING_MAXIMUM_MSAT = 21_000_000n * MSAT_PER_BTC;

const CANONICAL_DECIMAL = /^(?:0|[1-9][0-9]{0,15})(?:\.[0-9]*[1-9])?$/;
const CANONICAL_MSAT = /^(?:0|[1-9][0-9]{0,18})$/;

/**
 * The exact millisatoshi value of a positive P9 canonical BTC decimal, or
 * `undefined`: not canonical, zero, more than 11 fractional digits (a
 * sub-millisatoshi quantity), or above the supply bound.
 */
export function msatOfBtcDecimal(decimal: unknown): bigint | undefined {
  if (typeof decimal !== 'string' || !CANONICAL_DECIMAL.test(decimal)) return undefined;
  const point = decimal.indexOf('.');
  const integer = point === -1 ? decimal : decimal.slice(0, point);
  const fraction = point === -1 ? '' : decimal.slice(point + 1);
  if (fraction.length > LIGHTNING_BTC_MAXIMUM_SCALE) return undefined;
  const msat = BigInt(integer) * MSAT_PER_BTC + BigInt(fraction.padEnd(LIGHTNING_BTC_MAXIMUM_SCALE, '0') || '0');
  return msat > 0n && msat <= LIGHTNING_MAXIMUM_MSAT ? msat : undefined;
}

/** The P9 canonical BTC decimal of a millisatoshi amount (`0 < msat ≤` the supply bound), or `undefined`. Exact: every millisatoshi value has one. */
export function btcDecimalOfMsat(msat: unknown): string | undefined {
  if (typeof msat !== 'bigint' || msat <= 0n || msat > LIGHTNING_MAXIMUM_MSAT) return undefined;
  const whole = msat / MSAT_PER_BTC;
  const fraction = (msat % MSAT_PER_BTC).toString().padStart(LIGHTNING_BTC_MAXIMUM_SCALE, '0').replace(/0+$/, '');
  return fraction.length === 0 ? whole.toString() : `${whole.toString()}.${fraction}`;
}

/** A node-reported millisatoshi count as decimal text (int64 travels as a JSON string) → `BigInt`, or `undefined`. Never a `Number`. Zero allowed (a fee may be zero). */
export function msatOfDecimalText(value: unknown): bigint | undefined {
  if (typeof value !== 'string' || !CANONICAL_MSAT.test(value)) return undefined;
  const msat = BigInt(value);
  return msat <= LIGHTNING_MAXIMUM_MSAT ? msat : undefined;
}

/** BOLT11 multipliers, as millisatoshis per unit of `amount` — `m`, `u`, `n` divide evenly; `p` is a tenth of a millisatoshi. */
const MULTIPLIER_MSAT: Readonly<Record<string, bigint>> = Object.freeze({ '': MSAT_PER_BTC, m: 100_000_000n, u: 100_000n, n: 100n });

/**
 * The millisatoshis a BOLT11 human-readable amount (`2500u`, `20m`, `10n`,
 * `9678785340p`, `1`) requires, or `undefined` for anything the spec says to
 * fail: a non-digit, a leading zero, an unknown multiplier, a `p` amount whose
 * last digit is not `0` (sub-millisatoshi), zero, or more than Bitcoin's supply.
 */
export function msatOfBolt11Amount(text: string): bigint | undefined {
  const match = /^([1-9][0-9]{0,19})([munp]?)$/.exec(text);
  if (match === null) return undefined;
  const digits = match[1] ?? '';
  const multiplier = match[2] ?? '';
  let msat: bigint;
  if (multiplier === 'p') {
    if (!digits.endsWith('0')) return undefined;
    msat = BigInt(digits) / 10n;
  } else {
    msat = BigInt(digits) * (MULTIPLIER_MSAT[multiplier] ?? 0n);
  }
  return msat > 0n && msat <= LIGHTNING_MAXIMUM_MSAT ? msat : undefined;
}
