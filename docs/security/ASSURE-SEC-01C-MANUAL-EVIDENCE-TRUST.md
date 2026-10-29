# ASSURE-SEC-01C — Manual evidence trust, metric integrity and requirement binding

**Principle:** data supplied by an interested party is candidate evidence,
never authority over the audit result.

## Trust map (per source)

| Source | Created by | Fields controlled by | Verified by | Metrics it may produce |
| --- | --- | --- | --- | --- |
| `governance_record` | resolver, from the Governance Store | Host | store integrity check (`verified`, `verificationReference`) | `governance.*` |
| `evidence_bundle` | resolver, from the Evidence Store | Host | structural bundle verification | `evidence.*` |
| `agent_passport` | resolver, from the Passport Store | Host | event-chain and lifecycle verification | `passport.*` |
| `enterprise_health`, `module_health`, `lifecycle_event` | resolver, from the injected runtime snapshot | Host | in-process observation | `enterprise.*`, `modules.*` |
| `control_attestation`, `external_artifact_reference`, `passport_view` | **caller** (`collectEvidence` `manualEvidence`, in process only; no HTTP surface) | **supplier**: every field | **nothing in the Host** | attestation only: one non-reserved metric |

## Before

- **C1:** the supplier's `verified: true` passed `mustBeVerified`, raised
  control confidence to `high`, and counted toward eligibility's
  `minimumVerifiedEvidenceRate`.
- **C2:** `deriveAssuranceMetrics` wrote `metrics[metadata.metric] = value` for
  every accepted attestation, after the derived metrics, last writer wins. An
  attestation could set or override `governance.records.all_verified`,
  `passport.verified`, `enterprise.ready`, `modules.unhealthy_count`, and so on.
- **C3:** manual evidence was offered to every requirement that accepted its
  type. SEC-01A bound it at review time only.

## After (`assurance/manual-evidence-trust.ts`)

- **C1, verification:** the resolver admits a manual reference with
  `verified: false`, drops `verificationReference`, and keeps what the supplier
  claimed under `supplierClaims`. That field is recomputed, never taken from
  input. Every reader asks `isHostVerified(reference)`: `mustBeVerified`,
  evaluator confidence, and the eligibility verified rate. That predicate is
  false for every manual type, including references stored before this change.
- **C2, metrics:** `RESERVED_METRIC_NAMESPACES` are `governance`, `evidence`,
  `passport`, `enterprise` and `modules`. A test derives the full catalog and
  fails if a derived metric falls outside them. A manual name must be canonical
  (`^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$`, ≤ 128 characters), so case,
  whitespace, Unicode look-alike and separator variants are rejected, not
  normalised. The resolver rejects a violating attestation with
  `EVIDENCE_METRIC_NOT_PERMITTED`; the detail never echoes the value.
  `metrics.ts` applies the same policy again. An attestation counts once
  however many requirements accepted it. Disagreeing attestations leave the
  metric absent (`unknown`), independent of order.
- **C3, binding:** manual evidence is offered only to the requirements named in
  `requirementIds`, and unbound evidence is rejected with
  `EVIDENCE_NOT_BOUND`. An empty list, a repeated id, an id the framework does
  not define, or one `evidenceReferenceId` naming two different references
  refuses the whole set before collection (`ASSURANCE_EVIDENCE_INVALID`); the
  assessment does not change state. Assessment and tenant isolation are
  unchanged: evidence lives inside its assessment, and a foreign organization
  is rejected with `EVIDENCE_WRONG_TENANT`. Reuse across controls is an
  explicit list on one reference, never a copy.

A binding states which requirement the supplier intends the evidence for. It
does not prove the document true.

## Compatibility

- **Contracts (additive):** `AssuranceEvidenceReference.supplierClaims`, and
  the rejection codes `EVIDENCE_NOT_BOUND` and `EVIDENCE_METRIC_NOT_PERMITTED`.
  No HTTP route, SDK type or store schema changes, because manual evidence has
  no HTTP surface. `rn.sv` and `aoc.saf` definitions and golden digests are
  unchanged.
- **In-process embedders:** manual evidence must now carry `requirementIds`.
  Attestation metrics must use non-reserved canonical names. No framework in
  the repository uses an attestation for a reserved metric.
- **SAF:** its only manual requirement (`saf.req.review-attestation`) accepts
  bound attestations as before. Its derived-metric controls can no longer be
  satisfied by an attestation.
- **Historical records:** completed assessments are immutable and not
  re-evaluated. In-flight assessments keep their stored resolutions. On
  re-evaluation, reserved-name attestations no longer set metrics, and stored
  manual `verified: true` no longer raises confidence or eligibility. A manual
  reference without `supplierClaims` that reads `verified: true` was recorded
  before SEC-01C and its flag is the supplier's.

## Residual risks

- **SEC-01D:** organization attribution of evidence with no organization;
  v2 bundle verification.
- **SEC-01E:** ignored finding-event write failures.
- **External authenticity:** no manual artifact is authenticated (there is no
  signature or retrieval). Binding and metric policy limit what such evidence
  can affect; they do not make it true.
- **Derived-metric duplication:** the resolver gathers Host sources per
  requirement, so two requirements accepting the same type count the same
  record twice in `*.count` metrics. This predates SEC-01C and is not a trust
  issue.
