/**
 * G-02C1D — the two header names governed execution adds to the Generic HTTP
 * exchange, and nothing else.
 *
 * | Header | Direction | What it carries |
 * |---|---|---|
 * | `frontera-execution-capability` | request | the G-02C1A presentation of the capability the G-02C0 gate issued and verified for this exact request |
 * | `frontera-execution-receipt` | response | the executor's G-02C1C signed receipt, in its transport encoding |
 *
 * Both are **reserved**: no adapter configuration can map, credential or read
 * either one, so a governed action can never supply, replace or duplicate a
 * presentation, and a provider reference can never be read from a receipt.
 * The request header is appended by the adapter core alone, once, from the
 * gate's verdict, after the request binding was computed; the executor's
 * binding reconstruction leaves exactly this header out (G-02C1A), so the
 * binding is the same on both sides.
 *
 * This module knows the names, the bounds and the alphabet. It decodes,
 * verifies and trusts nothing: a presentation is opaque here, and a receipt
 * value is untrusted provider input handed on unread.
 */

export const GENERIC_HTTP_PRESENTATION_HEADER = 'frontera-execution-capability';
export const GENERIC_HTTP_RECEIPT_HEADER = 'frontera-execution-receipt';

export const GENERIC_HTTP_GOVERNED_HEADER_LIMITS = Object.freeze({
  /** Base64url characters; equals the G-02C1A presentation bound. */
  maxPresentationLength: 8_192,
  /** Base64url characters; equals the G-02C1C receipt transport bound. */
  maxReceiptLength: 8_192,
});

/** Unpadded base64url: the one alphabet either value is ever written in. */
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** Whether `value` is a non-empty unpadded base64url string of at most `maximum` characters. */
export function isGovernedHeaderValue(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && BASE64URL.test(value);
}
