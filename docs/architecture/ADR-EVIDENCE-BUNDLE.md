# ADR: Frontera Systems Evidence Bundle v1

- Status: Accepted (PR-005)
- Deciders: Frontera Systems architecture
- Related: `ADR-ENTERPRISE-GOVERNANCE-STORE.md`,
  `docs/enterprise/AOC_EVIDENCE_BUNDLE.md`,
  `docs/enterprise/EVIDENCE_PROJECTION_MODEL.md`,
  `docs/enterprise/DISCLOSURE_POLICIES.md`

## Context

- PR-004 gave Frontera Systems a canonical, durable, integrity-verifiable
  Governance Record for every evaluation. That record is sufficient for
  internal reconstruction, audit, integrity checking, and querying.
- It is not safe to hand to a third party. A `GovernanceRecord` carries
  internal metadata, module/provider snapshots, sanitized-but-still-broad
  request/result payloads, record ids, and digests meant for internal
  reconstruction -- an external auditor, partner, or customer should never
  receive it verbatim.
- Soberanía's product roadmap depends on being able to *share* proof of a
  decision -- to an auditor, a partner, a customer, or eventually a
  Passport/Assurance runtime -- without sharing everything the Store knows.
  RFC-005 already establishes this principle (`Truth ≠ Disclosure`) at the
  protocol level; PR-005 is the first Enterprise-side implementation of it.

## Decision

Create the Frontera Systems Evidence Bundle v1 (`src/enterprise/evidence/`):

- **A one-way projection**: `GovernanceRecord → DisclosurePolicy →
  EvidenceBundle`. The Projector (`projector.ts`) is the only place this
  happens; there is no reverse path, and a Bundle never carries enough
  information to reconstruct the source record.
- **Typed, validated Disclosure Policies** (`disclosure-policies.ts`): five
  levels (FULL, AUDITOR, PARTNER, CUSTOMER, PUBLIC), each an exhaustive
  classification of a fixed field vocabulary (`EVIDENCE_FIELD_KEYS`) into
  visible/hidden/redacted and required/optional, validated as a true
  partition at module load.
- **A bounded field vocabulary, not a passthrough**: even the FULL
  disclosure level only ever carries the fixed set of derived fields
  defined in `contracts.ts` -- never raw request/result payloads, record
  ids, module/provider snapshots, or arbitrary metadata. "Complete
  disclosure" means "every field on this list," not "everything the Store
  knows."
- **Defense-in-depth redaction**: the assembled `subject`/`evidence`
  sections are passed through the Governance Store's existing
  `redactSensitiveValues`, independent of and in addition to
  policy-driven redaction, so an accidental future secret-shaped field can
  never reach a Bundle. Policy redaction (`EVIDENCE_DISCLOSURE_REDACTED_VALUE`)
  and secret redaction (`GOVERNANCE_REDACTED_VALUE`) are kept as distinct
  markers.
- **Three-digest integrity model**: `bundleDigest` (over the Bundle's own
  projected content), `recordDigest` (the source record's
  `aggregateDigest`, carried verbatim -- never recomputed), and
  `verificationDigest` (binds the two plus the disclosure policy identity).
  `bundleDigest` is deliberately independent of `recordDigest`, because the
  projection changes between Bundles while the underlying decision does
  not.
- **Immutable Bundles, an independent Bundle Store**: no update method
  exists or may be added. Bundles are stored in
  `src/enterprise/evidence/evidence-store.ts`, a storage component wholly
  independent of the Governance Store. A changed disclosure policy always
  produces a *new* Bundle (`SUPERSEDED` marks the old one in the Store's
  own bookkeeping, never a rewrite of the Bundle's content).
- **Verification that never trusts stored digests**: `verifyEvidenceBundle`
  recomputes every digest from the Bundle's own content and checks it
  against a supplied Governance Record, the registered Disclosure Policy,
  and the Bundle's own `requiredFields` -- mirroring
  `verifyGovernanceRecordIntegrity`'s "recompute, never trust" posture.
- **Bounded HTTP surface**: `POST /api/evidence/build`,
  `GET /api/evidence/{bundleId}`, `POST /api/evidence/verify`. No
  mass-query endpoint -- lookups are bounded to a Bundle's own identifiers,
  matching the Governance Store's own bounded query posture. Tenant
  scoping reuses `resolveGovernanceAccessContext` verbatim.
- **Forward-compatible, not forward-implemented**: `EvidenceBundle.references`
  and the `verification` (provenance) block exist so a future
  Passport/Assurance/signature layer can attach to a Bundle without
  changing this model -- but no such runtime is implemented. See
  Non-Goals.

## Non-Goals (explicitly deferred)

Passport Runtime, Assurance Runtime, digital signatures, blockchain
anchoring, TSA/notarization, external object storage (IPFS, OCI registries),
PDF/signed-ZIP export, OpenAttestation, W3C Verifiable Credentials, DIDs,
wallets, cryptographic custody. Every one of these can be added as a new
layer *consuming* `EvidenceBundle` without a breaking change to it, because
the model already carries `bundleVersion`, `verification` (provenance), and
`references`.

## Consequences

- Positive: Frontera Systems can now produce something safe to share
  externally, with a documented, typed, testable disclosure boundary
  instead of ad hoc field-stripping at the call site. Multiple Bundles at
  different disclosure levels can coexist for the same decision, each
  independently verifiable.
- Positive: the Governance Store (PR-004) is completely unaffected --
  `compatibility.test.ts` and the full Governance Store contract suite pass
  unmodified; the Kernel is untouched.
- Trade-off: the fixed field vocabulary (`EVIDENCE_FIELD_KEYS`) means a
  new disclosable fact requires a deliberate, reviewed addition to
  `contracts.ts` and every existing policy's classification -- this is the
  point (no silent new leak surface), but it is friction by design.
- Deferred risk: without a signature/notarization layer, an Evidence
  Bundle's integrity guarantee is the same as the Governance Store's own
  (detects post-issuance tampering of the bytes the recipient holds; it is
  not non-repudiation and does not protect against a privileged issuer who
  rewrites a Bundle and its digest together). This is documented, not
  hidden, and is exactly the gap the future Assurance/signature layer
  closes.

## Addendum — ASSURE-01 (2026-10-03): the trace, v2 bundles, a durable store

- **Decision: a versioned trace referenced by a new bundle version, not a
  reinterpretation of v1.** The Unified Authority-to-Outcome Trace
  (`aoc.authority-trace.v1`) is a read-only projection over the canonical
  stores, rebuilt on every read. `evidence.bundle.v2` carries it, disclosed
  under five new v2 policies, with `integrity.traceDigest` bound into the
  verification digest. v1 builds, policies, digests and verification are
  unchanged; the v1 policies are not widened because their field lists are
  embedded in, and re-checked against, every historical v1 bundle.
- **Decision: the Bundle Store becomes durable** (SQLite, its own file),
  composed whenever persistence is `sqlite` and required by the secure Host;
  backed up as registry store fourteen. "No update method" is kept: the
  lifecycle (`GENERATED → VERIFIED → EXPORTED`, any → `SUPERSEDED`) is now
  forward-only and replayed from an append-only log.
- **Consequence:** the deferred risk above is unchanged — integrity, not
  authenticity; ASSURE-02 signs. See
  `docs/security/ASSURE-01-UNIFIED-AUTHORITY-OUTCOME-TRACE.md`.
