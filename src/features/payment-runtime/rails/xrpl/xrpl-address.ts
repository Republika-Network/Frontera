import { isValidClassicAddress } from 'xrpl';
import type { PaymentDestination } from '../../domain/index.js';

/**
 * XRPL account and destination parsing for the RLUSD rail (PAY-02).
 *
 * The checksum is the SDK's (`isValidClassicAddress`); this file adds only the
 * bounds that make a value safe to hand it — the classic alphabet and length,
 * so whitespace, an oversized value or a non-string never reaches the codec.
 */

/** Classic-address shape: `r`, then 24 … 34 characters of the XRPL base58 alphabet. */
const CLASSIC_ADDRESS_SHAPE = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;

export function isXrplClassicAddress(value: unknown): value is string {
  return typeof value === 'string' && CLASSIC_ADDRESS_SHAPE.test(value) && isValidClassicAddress(value);
}

/**
 * The destination kinds this rail accepts — PAY-01 `PaymentDestination.kind`
 * values, in PAY-01's own grammar, so no PAY-01 change is needed:
 *
 * | kind | reference | governed counterparty |
 * | --- | --- | --- |
 * | `xrpl-account` | a classic address | `xrpl-account:r…` |
 * | `xrpl-tagged-account` | `<classic address>:<destination tag>` | `xrpl-tagged-account:r…:12345` |
 *
 * The destination tag is therefore **part of the governed counterparty**: a
 * grant for `r…:1` is not a grant for `r…:2` or for the untagged `r…`, and the
 * tag travels to the rail only as the granted counterparty — never as
 * metadata. Two kinds rather than an optional suffix so that every
 * destination has exactly one spelling.
 *
 * X-addresses (which fold a tag into the address) are **refused**: they would
 * give one destination a second spelling, and a grant bound to one spelling
 * must not be satisfiable by the other.
 */
export const XRPL_DESTINATION_KINDS = Object.freeze({ account: 'xrpl-account', taggedAccount: 'xrpl-tagged-account' } as const);

/** A destination tag: an unsigned 32-bit integer in canonical decimal (no sign, no leading zero). */
const DESTINATION_TAG = /^(?:0|[1-9][0-9]{0,9})$/;
const DESTINATION_TAG_MAXIMUM = '4294967295';

function destinationTagOf(text: string): number | undefined {
  if (!DESTINATION_TAG.test(text)) return undefined;
  if (text.length === DESTINATION_TAG_MAXIMUM.length && text > DESTINATION_TAG_MAXIMUM) return undefined;
  // At most ten digits and at most 2^32 − 1: exactly representable. A tag is an identifier, not money.
  return Number.parseInt(text, 10);
}

export interface XrplDestination {
  readonly address: string;
  readonly tag?: number;
}

/** The XRPL destination a granted payment destination names, or `undefined` when it is not one this rail accepts. Total; never throws. */
export function parseXrplDestination(destination: PaymentDestination): XrplDestination | undefined {
  const kind: unknown = destination?.kind;
  const reference: unknown = destination?.reference;
  if (typeof reference !== 'string') return undefined;
  if (kind === XRPL_DESTINATION_KINDS.account) {
    return isXrplClassicAddress(reference) ? Object.freeze({ address: reference }) : undefined;
  }
  if (kind === XRPL_DESTINATION_KINDS.taggedAccount) {
    const separator = reference.indexOf(':');
    if (separator === -1 || reference.indexOf(':', separator + 1) !== -1) return undefined;
    const address = reference.slice(0, separator);
    const tag = destinationTagOf(reference.slice(separator + 1));
    if (!isXrplClassicAddress(address) || tag === undefined) return undefined;
    return Object.freeze({ address, tag });
  }
  return undefined;
}
