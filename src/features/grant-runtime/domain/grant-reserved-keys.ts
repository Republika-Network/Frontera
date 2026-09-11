/**
 * The requester-facing reserved namespace for grants.
 *
 * The third application of one rule.
 * `request-adapter.ts` deletes a caller-supplied `organizationId`;
 * `CONTEXT_RESERVED_REQUEST_KEY_PREFIX` generalized that to a namespace for
 * resolved facts; `OBLIGATION_RESERVED_REQUEST_KEY_PREFIX` did the same for
 * obligation state. `aoc.grant` is reserved by the same rule and dropped in the
 * same pass, whether or not a grant capability is configured.
 *
 * ## What this is, and what actually protects the boundary
 *
 * Reserving the namespace is **not** the thing standing between a caller and a
 * self-issued grant. Grant data is never read out of the request bag under any
 * name: a `GrantSourceAuthorization` is projected by the Kernel adapter from an
 * authorization that already happened, the requested narrowing is supplied by
 * the *host* through the issuance service and never by the wire, and
 * `KernelEvaluationRequest` has no grant field at all. A forged
 * `aoc.grant` would have nowhere to be read from even if it survived.
 *
 * It is dropped anyway, for the reason `organizationId` is: a key that means
 * something internally must not be writable from outside, whether or not a
 * reader exists today. The adversarial payloads the brief names —
 * `{"grant":{"maxAmount":1000000}}`, `{"aoc.grant":{"action":"*"}}`,
 * `{"grantEligible":true}`, `{"grant":{"subject":"attacker"}}` — are written
 * from the attacker's side in
 * `src/kernel/__tests__/kernel-grant-self-assertion.test.ts`, and each is shown
 * to change nothing about the grant that results.
 *
 * This can break no existing deployment: the namespace did not exist before
 * this capability did, so nothing can have been passing one through.
 */
export const GRANT_RESERVED_REQUEST_KEY_PREFIX = 'aoc.grant';

export function isReservedGrantKey(key: string): boolean {
  return key === GRANT_RESERVED_REQUEST_KEY_PREFIX || key.startsWith(`${GRANT_RESERVED_REQUEST_KEY_PREFIX}.`);
}
