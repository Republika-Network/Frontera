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
  resolveGrantValidity,
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
  type GrantValidityCeiling,
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
 * which run inside its transaction. The temporal half of check 4 is stated
 * separately in `grant-validity.ts`: the issuer proposes an expiry, every
 * applicable upstream ceiling contains it, and nothing invents a ceiling where
 * none exists.
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
  /**
   * The expiry the trusted issuer proposes for this grant.
   *
   * Required, finite, and strictly after `issuedAt` — ADR §4, "Where a grant's
   * validity comes from", rules 1 and 2, and hard invariant 9. There is no
   * default and no fallback: an issuance supplying none is refused with
   * `GRANT_VALIDITY_INVALID`.
   *
   * This is **host input**, like `requestedBounds`. Nothing on
   * `KernelEvaluationRequest` reaches it, and a requester cannot influence it —
   * a requester able to set, extend or remove the expiry on its own grant has
   * been handed the grant. The adversarial suites prove the wire cannot reach
   * this field at all.
   *
   * It is contained, never clamped: a proposal above the effective ceiling is
   * refused with `GRANT_SCOPE_BROADENING`, and a proposal within every bound is
   * accepted exactly as supplied.
   */
  readonly expiresAt: string;
  /**
   * Upstream ceilings the *caller of this service* knows about and the Kernel
   * adapter could not, added to whatever the source authorization already
   * carries.
   *
   * The mandate case: a host issuing under a governed mandate supplies that
   * mandate's own `expiresAt` here (or via `withGrantValidityCeiling`), which is
   * how ADR hard invariant 10 — "a grant never outlives the authority
   * justifying it" — becomes enforceable on a path the Kernel cannot see.
   */
  readonly additionalValidityCeilings?: readonly GrantValidityCeiling[];
}

export type GrantIssuanceOutcome =
  | { readonly outcome: 'issued'; readonly grant: BoundedGrant; readonly bounds: readonly GrantBoundAttenuation[]; readonly effectiveValidityCeiling?: GrantValidityCeiling }
  | { readonly outcome: 'already-issued'; readonly grant: BoundedGrant; readonly bounds: readonly GrantBoundAttenuation[]; readonly effectiveValidityCeiling?: GrantValidityCeiling }
  | {
      readonly outcome: 'refused';
      readonly reasonCodes: readonly GrantReasonCode[];
      readonly violations: readonly GrantAttenuationViolation[];
      /** The ceiling that capped the request, when one did. Absent when the refusal had another cause, or when no ceiling existed. */
      readonly effectiveValidityCeiling?: GrantValidityCeiling;
    };

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

      // 4. The validity window: proposed by the issuer, contained by every
      //    applicable upstream ceiling that exists, and never clamped.
      //    ADR §4, "Where a grant's validity comes from".
      const ceilings = [...source.validityCeilings, ...(request.additionalValidityCeilings ?? [])];
      const validity = resolveGrantValidity({ issuedAt: request.issuedAt, requestedExpiresAt: request.expiresAt, ceilings });
      if (validity.outcome === 'refused' || validity.expiresAt === undefined) {
        return {
          outcome: 'refused',
          reasonCodes: validity.reasonCodes.length > 0 ? validity.reasonCodes : [GRANT_REASON_CODES.GRANT_VALIDITY_INVALID],
          violations: [],
          ...(validity.effectiveCeiling !== undefined ? { effectiveValidityCeiling: validity.effectiveCeiling } : {}),
        };
      }
      const expiresAt = validity.expiresAt;

      const id = boundedGrantId({ correlation: request.correlation, subject: request.subject, scope: attenuation.scope, expiresAt });
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
        // The temporal ceilings are re-proven too, against the authority as it
        // stands now. A mandate whose window has been shortened since the
        // caller measured it refuses the issuance rather than committing a
        // grant that would outlive it.
        const currentValidity = resolveGrantValidity({
          issuedAt: request.issuedAt,
          requestedExpiresAt: grant.expiresAt,
          ceilings: [...current.validityCeilings, ...(request.additionalValidityCeilings ?? [])],
        });
        if (currentValidity.outcome !== 'accepted') {
          return { permitted: false, reasonCodes: currentValidity.reasonCodes };
        }
        return { permitted: true, reasonCodes: [] };
      };

      const stored = await store.issue({ grant, commitGuard });
      if (stored.outcome === 'refused') return refusal(stored.reasonCodes, []);
      return {
        outcome: stored.outcome,
        grant: stored.grant,
        bounds: attenuation.bounds,
        ...(validity.effectiveCeiling !== undefined ? { effectiveValidityCeiling: validity.effectiveCeiling } : {}),
      };
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
