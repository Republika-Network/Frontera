import {
  GRANT_REASON_CODES,
  assessGrantEligibility,
  assessGrantExercise,
  attenuateGrantScope,
  boundedGrantDigest,
  boundedGrantId,
  grantScopeIsWithin,
  grantSourceDigest,
  grantSourceMatchesCorrelation,
  isWellFormedGrantCorrelation,
  type BoundedGrant,
  type BoundedGrantStorePort,
  type GrantAttenuationViolation,
  type GrantBoundAttenuation,
  type GrantCommitPrecondition,
  type GrantCorrelation,
  type GrantExerciseAssessment,
  type GrantReasonCode,
  type GrantRevocation,
  type GrantRevocationReason,
  type GrantSourceAuthorization,
  type RequestedGrantBounds,
} from '../domain/index.js';

/**
 * The trusted internal grant path.
 *
 * There is exactly one way a bounded grant comes into existence, and this is
 * it. It is composed at the host, never reachable from the wire, and it takes a
 * `GrantSourceAuthorization` projected from an authorization that already
 * happened rather than anything a requester supplied.
 * `ADR-OBLIGATION-DISCHARGE-AND-BOUNDED-GRANT.md`'s hole 2 — "a caller holding
 * grant-issuance rights can mint a grant citing a decision that denied, or a
 * decision for a different resource, or no decision at all" — is closed by the
 * eight checks below, six of which run before the store is touched and two of
 * which run inside its transaction.
 *
 * ## Issuance is not evaluation
 *
 * `AocKernel.evaluate()` reports whether an authorization *would be*
 * grant-eligible, and mutates nothing. This service creates the artifact, and
 * does so under the authoritative store's own commit boundary. The repository
 * already distinguishes pure evaluation from mutation everywhere else
 * (`preflight` versus `enforce`, `resolveAvailability` versus
 * `acquireReservation`), and blurring the two here would put a write inside a
 * function three characterization suites assert is side-effect free.
 */

export interface GrantIssuanceRequest {
  /** The authorization this grant is derived from. Projected by the Kernel adapter from an evaluated result; never assembled from request data. */
  readonly source: GrantSourceAuthorization;
  /**
   * The narrowing the *host* asks for, axis by axis. Every axis is optional,
   * and an omitted axis inherits the source bound unchanged (ADR §4).
   *
   * This is host input, not caller input. Nothing on `KernelEvaluationRequest`
   * reaches it, and a requester cannot influence it — which is why a
   * broadening request is a host bug caught by `GRANT_SCOPE_BROADENING` rather
   * than an attack surface. The adversarial suites prove the wire cannot reach
   * this field at all.
   */
  readonly requestedBounds?: RequestedGrantBounds;
  /**
   * The party the grant is to be held by.
   *
   * Must equal `source.subject`. There is no delegation at this layer, so a
   * value that differs is refused with `GRANT_SUBJECT_INVALID` rather than
   * treated as a delegated issuance — see `GrantSourceAuthorization.subject`.
   */
  readonly subject: string;
  /** The correlation the caller believes it is issuing against. Checked against the source's own, so a grant can never cite one authorization while deriving from another. */
  readonly correlation: GrantCorrelation;
  readonly issuedAt: string;
}

export type GrantIssuanceOutcome =
  | { readonly outcome: 'issued'; readonly grant: BoundedGrant; readonly bounds: readonly GrantBoundAttenuation[] }
  | { readonly outcome: 'already-issued'; readonly grant: BoundedGrant; readonly bounds: readonly GrantBoundAttenuation[] }
  | { readonly outcome: 'refused'; readonly reasonCodes: readonly GrantReasonCode[]; readonly violations: readonly GrantAttenuationViolation[] };

export interface GrantIssuanceServiceOptions {
  readonly store: BoundedGrantStorePort;
  /**
   * Re-reads the authoritative source authorization at commit time.
   *
   * **Synchronous**, so the store can call it inside its critical section with
   * no `await` between the read that decides and the write that records —
   * `ADR-OBLIGATION-DISCHARGE-AND-BOUNDED-GRANT.md` §4.6's whole point. A
   * deployment that cannot answer synchronously must pre-load the answer before
   * calling `issueGrant`, exactly as `acquireReservation`'s callers pre-load
   * what they hand it.
   *
   * Omitted, the source handed to `issueGrant` is re-checked against itself,
   * which still closes duplicate issuance and preclusion but not a genuinely
   * concurrent change of the underlying authorization. A production deployment
   * supplies one; the README says so plainly rather than leaving the gap
   * implied.
   */
  readonly revalidateSource?: (correlation: GrantCorrelation) => GrantSourceAuthorization | undefined;
}

function refusal(reasonCodes: readonly GrantReasonCode[], violations: readonly GrantAttenuationViolation[] = []): GrantIssuanceOutcome {
  return { outcome: 'refused', reasonCodes, violations };
}

export interface GrantIssuanceService {
  issueGrant(request: GrantIssuanceRequest): Promise<GrantIssuanceOutcome>;
  /** Whether an issued grant may be exercised at `at`. Derived from the clock and the revocation set at read time; nothing has to have swept. */
  assessExercise(grantId: string, at: string): Promise<GrantExerciseAssessment>;
  revokeGrant(input: { readonly grantId: string; readonly reason: GrantRevocationReason; readonly revokedAt: string; readonly issuerRef: string }): Promise<
    { readonly outcome: 'revoked' | 'already-revoked'; readonly revocation: GrantRevocation } | { readonly outcome: 'refused'; readonly reasonCodes: readonly GrantReasonCode[] }
  >;
}

export function createGrantIssuanceService(options: GrantIssuanceServiceOptions): GrantIssuanceService {
  const { store, revalidateSource } = options;

  return {
    async issueGrant(request: GrantIssuanceRequest): Promise<GrantIssuanceOutcome> {
      const { source } = request;

      // 6. Source-authorization correlation is intact. First, because every
      //    other check is meaningless if this grant is not actually about the
      //    authorization it names.
      if (!isWellFormedGrantCorrelation(request.correlation) || !grantSourceMatchesCorrelation(source, request.correlation)) {
        return refusal([GRANT_REASON_CODES.GRANT_CORRELATION_INVALID]);
      }

      // 1 and 2. The authorization permitted exercise, and every blocking
      //    obligation is satisfied. Read from the source, never re-derived:
      //    this layer cannot authorize and cannot discharge.
      const eligibility = assessGrantEligibility(source);
      if (eligibility.eligibility !== 'eligible') return refusal(eligibility.reasonCodes);

      // 5. The subject is valid. No delegation: the holder is the authorized
      //    subject or there is no grant.
      if (request.subject !== source.subject) return refusal([GRANT_REASON_CODES.GRANT_SUBJECT_INVALID]);

      // 3. The bounds are equal to or narrower than the source bounds.
      const attenuation = attenuateGrantScope(source.scope, request.requestedBounds ?? {});
      if (attenuation.outcome === 'refused') {
        const reasonCodes = [...new Set(attenuation.violations.map((violation) => violation.reasonCode))];
        return refusal(reasonCodes, attenuation.violations);
      }

      // The settling invariant, re-derived independently of the function that
      // just produced the scope. The invariant is a property the *artifact*
      // must have, not a property of the process that made it, so it is proven
      // of the artifact.
      if (!grantScopeIsWithin(source.scope, attenuation.scope)) {
        return refusal([GRANT_REASON_CODES.GRANT_SCOPE_BROADENING]);
      }

      // 4. The validity window is valid, and is the grant's expiry.
      const validity = attenuation.scope.validity;
      if (validity === undefined || validity.kind !== 'window') return refusal([GRANT_REASON_CODES.GRANT_VALIDITY_INVALID], []);
      const expiresAt = validity.notAfter;
      const issuedAtInstant = Date.parse(request.issuedAt);
      const expiresAtInstant = Date.parse(expiresAt);
      if (Number.isNaN(issuedAtInstant) || Number.isNaN(expiresAtInstant) || expiresAtInstant <= issuedAtInstant) {
        // `expiresAt` strictly after `issuedAt`, the one temporal consistency
        // rule `validateEnterpriseAccessGrant` already enforces on the frozen
        // contract. A grant that expires at or before the instant it is issued
        // is refused rather than stored as a permanently unusable artifact.
        return refusal([GRANT_REASON_CODES.GRANT_VALIDITY_INVALID], []);
      }

      const id = boundedGrantId({ correlation: request.correlation, subject: request.subject, scope: attenuation.scope });
      const withoutDigest = {
        id,
        correlation: request.correlation,
        subject: request.subject,
        scope: attenuation.scope,
        issuedAt: request.issuedAt,
        expiresAt,
        sourceDigest: grantSourceDigest(source),
      };
      const grant: BoundedGrant = { ...withoutDigest, digest: boundedGrantDigest(withoutDigest) };

      // 7 and 8. Preclusion and the commit-boundary re-check, both inside the
      //    store's own critical section against the records read there.
      const commitGuard = (): GrantCommitPrecondition => {
        if (revalidateSource === undefined) return { permitted: true, reasonCodes: [] };
        const current = revalidateSource(request.correlation);
        if (current === undefined) return { permitted: false, reasonCodes: [GRANT_REASON_CODES.GRANT_CORRELATION_INVALID] };

        const currentEligibility = assessGrantEligibility(current);
        if (currentEligibility.eligibility !== 'eligible') return { permitted: false, reasonCodes: currentEligibility.reasonCodes };
        if (current.subject !== request.subject) return { permitted: false, reasonCodes: [GRANT_REASON_CODES.GRANT_SUBJECT_INVALID] };
        // The bounds are re-proven against the authority as it stands now, not
        // as it stood when the caller measured it. A source that has narrowed
        // since — a lower ceiling, a shorter horizon, a smaller resource set —
        // refuses the issuance instead of committing a grant that is no longer
        // inside it.
        if (!grantScopeIsWithin(current.scope, grant.scope)) {
          return { permitted: false, reasonCodes: [GRANT_REASON_CODES.GRANT_SCOPE_BROADENING] };
        }
        return { permitted: true, reasonCodes: [] };
      };

      const stored = await store.issue({ grant, commitGuard });
      if (stored.outcome === 'refused') return refusal(stored.reasonCodes, []);
      return { outcome: stored.outcome, grant: stored.grant, bounds: attenuation.bounds };
    },

    async assessExercise(grantId: string, at: string): Promise<GrantExerciseAssessment> {
      const read = await store.read(grantId);
      if (read.grant === undefined) return { eligibility: 'unusable', reasonCodes: [GRANT_REASON_CODES.GRANT_NOT_FOUND] };
      return assessGrantExercise({
        grant: read.grant,
        ...(read.revocation !== undefined ? { revocation: read.revocation } : {}),
        at,
      });
    },

    async revokeGrant(input) {
      const outcome = await store.revoke(input);
      if (outcome.outcome === 'refused') return { outcome: 'refused', reasonCodes: outcome.reasonCodes };
      return { outcome: outcome.outcome, revocation: outcome.revocation };
    },
  };
}
