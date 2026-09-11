import { createHash } from 'crypto';

import { serializeGrantCorrelation, type GrantCorrelation } from './grant-correlation.js';
import { serializeGrantScope, type GrantScope } from './grant-scope.js';
import { serializeGrantSourceAuthorization, type GrantSourceAuthorization } from './grant-source-authorization.js';

/**
 * The artifact this whole phase exists to produce.
 *
 * > An authorization decision answers "is this action authorized?".
 * > A grant answers "what exact portion of that authorized authority may now be
 * > exercised, by whom, against what, under which bounds, and until when?"
 *
 * ## What is deliberately absent
 *
 * **No policy decision field.** No `status: 'allowed'`, no effect, no outcome,
 * no authorization reason code. A grant is a *consequence* of a decision, not a
 * copy of one, and a second copy of a decision is a second thing that can
 * disagree with it. `ADR-ACCESS-GRANT.md` refuses "a duplicated decision
 * outcome" at compile time for the same reason.
 *
 * **No lifecycle status field either.** `ADR-ACCESS-GRANT.md` excludes
 * `'expired'` from `EnterpriseAccessGrantStatus` because expiry is fully
 * represented by `issuedAt`/`expiresAt` and a status would be "a second,
 * independently-settable source of truth for the same fact". This record
 * extends that reasoning one step: revocation is an immutable *event* held
 * beside the grant (`grant-revocation.ts`), so that neither expiry nor
 * revocation is a mutable field on an artifact that is otherwise immutable, and
 * neither can drift from the fact it describes. Exercisability is derived at
 * read time, from the clock and the revocation set — `ADR-OBLIGATION-DISCHARGE-AND-BOUNDED-GRANT.md`
 * §6 and hard invariant 7, "derived from the clock at read time; no job is
 * load-bearing".
 *
 * **No token.** Not a JWT, macaroon, UCAN, OAuth token, signed URL, capability
 * token or ledger object. `ADR-ACCESS-GRANT.md` lists every one of those as an
 * explicit non-responsibility and enforces it with `@ts-expect-error` proofs,
 * and no accepted ADR has since chosen an external serialized token format. A
 * bounded grant is an internal, typed record held by a trusted store; a caller
 * never holds one and therefore never presents one. See the README's
 * "Integrity" section for exactly where signing would attach if a later ADR
 * decides it should.
 *
 * **No usage counter.** See the README: every accepted ADR is silent on
 * single-use, multi-use, consumption and replay, so this phase implements
 * issuance, validity and revocation and invents no consumption model.
 */
export interface BoundedGrant {
  /** Deterministic; see `boundedGrantId`. Never a UUID, never a counter, never clock-derived. */
  readonly id: string;
  /** What this grant was derived from, and what evidence will later correlate it by. */
  readonly correlation: GrantCorrelation;
  /**
   * The party that may exercise it.
   *
   * Always the subject the source authorization was evaluated for. There is no
   * delegation at this layer and no field that could express one — see
   * `GrantSourceAuthorization.subject`.
   */
  readonly subject: string;
  /** The bounds, after attenuation. Equal to or narrower than the source scope on every axis, and proven so by `grantScopeIsWithin` at issuance. */
  readonly scope: GrantScope;
  readonly issuedAt: string;
  /** The instant it stops being exercisable, derived from `scope.validity`. Never later than the source's own horizon. */
  readonly expiresAt: string;
  /** A fingerprint of the authority this was narrowed from, so "narrowed from what?" is answerable from the grant alone. */
  readonly sourceDigest: string;
  /** A fingerprint of the grant's own canonical form. Integrity, not a signature — see the README. */
  readonly digest: string;
}

/**
 * The deterministic identity of one bounded grant.
 *
 * Derived from the correlation, the subject and the canonical bounds, and from
 * nothing else — no UUID, no counter, no clock, no ambient randomness. The
 * discipline `obligationInstanceId` established one layer down, and it buys the
 * same three things: two issuances of the same grant over the same authority
 * collide rather than duplicate, a replay produces a byte-identical artifact,
 * and `tests/grant-determinism.test.ts` can assert identity by construction.
 *
 * The hash is over a canonical string, so key order, set order and `-0` can
 * never make two identical grants take different identities.
 */
export function boundedGrantId(input: { readonly correlation: GrantCorrelation; readonly subject: string; readonly scope: GrantScope }): string {
  const canonical = `{${serializeGrantCorrelation(input.correlation)},"scope":${serializeGrantScope(input.scope)},"subject":${JSON.stringify(input.subject)}}`;
  return `aoc.grant:${createHash('sha256').update(canonical).digest('hex').slice(0, 32)}`;
}

/**
 * The canonical serialization of a grant.
 *
 * Key order is lexicographic and fixed here rather than taken from
 * `Object.keys`, undefined is omitted rather than written as `null`, and there
 * is no whitespace — the same rules `aoc.canonical-json.v1` applies, so a grant
 * canonicalized here and a grant canonicalized by the Governance Store produce
 * the same bytes. `tests/grant-canonicalization.test.ts` pins that equality
 * against the real canonicalizer rather than asserting it in prose, because
 * layer E may not import layer F and a rule restated by hand is a rule that can
 * drift.
 */
export function serializeBoundedGrant(grant: BoundedGrant): string {
  return [
    '{',
    [
      `"correlation":{${serializeGrantCorrelation(grant.correlation)}}`,
      `"digest":${JSON.stringify(grant.digest)}`,
      `"expiresAt":${JSON.stringify(grant.expiresAt)}`,
      `"id":${JSON.stringify(grant.id)}`,
      `"issuedAt":${JSON.stringify(grant.issuedAt)}`,
      `"scope":${serializeGrantScope(grant.scope)}`,
      `"sourceDigest":${JSON.stringify(grant.sourceDigest)}`,
      `"subject":${JSON.stringify(grant.subject)}`,
    ].join(','),
    '}',
  ].join('');
}

/** `sha256:<hex>` over the canonical form of the source authorization. The repository's one digest idiom, matching `computeDigest` in the Governance Store and the `*Proof` families in `src/features`. */
export function grantSourceDigest(source: GrantSourceAuthorization): string {
  return `sha256:${createHash('sha256').update(`{${serializeGrantSourceAuthorization(source)}}`).digest('hex')}`;
}

/**
 * `sha256:<hex>` over the grant's canonical form, with `digest` itself held
 * empty so the value is well defined rather than self-referential.
 *
 * This is an **integrity** mechanism — it detects that a grant's fields differ
 * from the ones that were digested — and explicitly not a signature, not
 * non-repudiation, and no defence against a privileged writer able to rewrite
 * both a grant and its digest. That is the same limit the Governance Store
 * states for its own digests, and the honest one to state here.
 */
export function boundedGrantDigest(grant: Omit<BoundedGrant, 'digest'>): string {
  return `sha256:${createHash('sha256').update(serializeBoundedGrant({ ...grant, digest: '' })).digest('hex')}`;
}

/** Whether a grant's recorded digest still matches its fields. A grant that fails this is tampered and is refused at read time, never repaired. */
export function boundedGrantDigestMatches(grant: BoundedGrant): boolean {
  return grant.digest === boundedGrantDigest(grant);
}
