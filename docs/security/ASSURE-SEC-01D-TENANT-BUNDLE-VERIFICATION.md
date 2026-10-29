# ASSURE-SEC-01D — Tenant attribution and Evidence Bundle v2 verification

**Invariant:** evidence never takes an organization by assumption, and never
passes a verification whose canonical context could not be rebuilt.

## Before

- **D1, attribution.** The resolver filled missing organizations with the
  assessed one: `summary.organizationId ?? scope.subject.organizationId` for
  Governance Records and `bundle.source.organizationId ?? scope.subject.organizationId`
  for bundles. A bundle's `source.organizationId` is hidden by the PARTNER,
  CUSTOMER and PUBLIC policies. Under a system caller, the Evidence Store also
  returns bundles of every organization. So a bundle with a hidden
  organization, owned by another organization or by none, was presented as the
  assessed organization's.
- **D2, v2 verification.** The resolver called
  `verifyEvidenceBundle(bundle, { now })` with no `currentTrace` and no
  `record`. A v2 bundle without a current trace never verifies, so every v2
  bundle was rejected, always as `EVIDENCE_DIGEST_MISMATCH`, an integrity
  failure it did not have. v1 bundles were verified without their source
  record.

## Sources and decisions

| Source | Record identity | Trusted organization | Verifier | Resolver decision |
| --- | --- | --- | --- | --- |
| Governance Store `query` | `evaluationId` | `request.organizationId` (the query is bounded to the assessed organization by the store) | `verify()` | accepted under that organization. None recorded → not attributable. |
| Evidence Store `listByEvaluationId` | `bundleId` | `EvidenceBundleRecord.organizationId`, the owner the store recorded and its own tenant checks use | v1: `verifyEvidenceBundle` + source Governance Record. v2: + the current trace | no owner, or a disclosed organization that contradicts the owner → not attributable. Another owner → `EVIDENCE_WRONG_TENANT`. |
| Authority trace (`buildAuthorityTrace`) | `requestId` on the governed-action path | `trace.organizationId`, read in the **assessed organization's** scope only (`system: false`) | `authorityTraceVerificationOf` | the `currentTrace` for v2 |
| Passport Store | `passportId` | `passport.organization.organizationId` | chain and lifecycle | unchanged |
| Runtime health | one observation | this Host | none | unchanged |
| Manual evidence | supplier | supplier | none (SEC-01C) | unchanged |

Not attributable means `organizationId: ''`, rejected with
`EVIDENCE_WRONG_TENANT` and the detail "no organization attributable from its
canonical source". The resolver does not infer membership from a shared
evaluation id, and it rewrites no stored record. Tenant-scope details never
name another organization.

## Verification

`evidence/bundle-current-trace.ts` (`rebuildEvidenceBundleCurrentTrace`) is
the path `EvidenceService.verify` already took, extracted so the resolver
shares it. It rebuilds the request's trace from the canonical stores and
discloses it under the bundle's policy. It returns `rebuilt`, `not-found` or
`read-failed`; it never fabricates a trace from the bundle being verified.
The resolver reads the canonical stores in the assessed organization's scope.
The trace sources are the Evidence Service's own (`AssuranceEvidenceSources.traceSources`,
composed in `composition-root.ts`). By default it uses the Governance Store
alone, as the Evidence Service does.

`verifyEvidenceBundle` is unchanged. `assurance/evidence-bundle-trust.ts`
classifies its result:

| Situation | Code |
| --- | --- |
| content, digest binding, source record, policy | `EVIDENCE_DIGEST_MISMATCH` |
| trace not rebuilt (not found in scope, store unreadable, degraded comparison) | `EVIDENCE_SOURCE_UNAVAILABLE` |
| canonical records contradict a disclosed fact | `EVIDENCE_CONTRADICTORY` |
| canonical trace does not verify | `EVIDENCE_UNVERIFIED` |
| required field missing | `EVIDENCE_INCOMPLETE` |
| version unsupported | `EVIDENCE_VERSION_UNSUPPORTED` |
| any other verifier failure | `EVIDENCE_UNVERIFIED` (never accepted) |

All codes already existed. The rejection-code union is unchanged.

## Compatibility

- **v1 bundles:** still verified, now also against their source Governance
  Record when it can be read (as `EvidenceService.verify` does). If it cannot
  be read, v1 keeps its limitation: structural verification only.
- **v2 bundles:** previously always rejected. They are now accepted when their
  trace rebuilds and verifies, and rejected with their real cause otherwise.
- **aoc.saf:** a verified v2 bundle now satisfies the bundle controls. An
  unverifiable one leaves them unresolved, not failed. `rn.sv` and `aoc.saf`
  definitions and golden digests are unchanged.
- **Historical bundles** stored with no owner (pre-ASSURE-01, under a policy
  hiding the organization) are no longer attributed to the assessed
  organization. They were already invisible to organization-scoped callers;
  they are now rejected for system callers too. Nothing is migrated or
  rewritten. Completed assessments are not re-evaluated.
- **Contracts:** `AssuranceEvidenceSources.traceSources` is an optional
  in-process field. There are no HTTP, SDK, store-schema or rejection-code
  changes.

## Residual risks

- **SEC-01E:** finding-event write failures at completion are still ignored.
- **No dedicated "unattributed" code:** the condition is reported as
  `EVIDENCE_WRONG_TENANT` with its own detail. A distinct code would be an
  additive contract change and needs authorization.
- **Store trust:** attribution trusts the owner the Evidence Store recorded.
  A writer with direct store access could record a false owner. Store writes
  are Host-internal.
- **External authenticity:** verification shows that a bundle matches the
  Host's canonical records now. It does not show that those records describe
  the world truthfully.
