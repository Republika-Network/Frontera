# Frontera Systems Evidence Bundle v1

PR-005 introduces the Evidence Bundle: the first official mechanism for
turning a Governance Store record (PR-004) into something safe to hand to
someone outside Frontera Systems -- an auditor, a partner, a customer, or the
public.

**Core principle: `Truth ≠ Disclosure`.** The Governance Store keeps the
complete truth of every governance evaluation. An Evidence Bundle discloses
only the subset of that truth a `DisclosurePolicy` selects. An organization
can prove a decision was made correctly without revealing everything it
knows about how.

- Code: `src/enterprise/evidence/`
- Projection model: `docs/enterprise/EVIDENCE_PROJECTION_MODEL.md`
- Disclosure policies: `docs/enterprise/DISCLOSURE_POLICIES.md`
- Decision record: `docs/architecture/ADR-EVIDENCE-BUNDLE.md`

## Architecture

```
Governance Record  (src/enterprise/governance-store/ -- never leaves the Store)
        │
        ▼
Disclosure Policy   (FULL / AUDITOR / PARTNER / CUSTOMER / PUBLIC)
        │
        ▼
Evidence Projector  (buildEvidenceBundle -- the only direction this ever runs)
        │
        ▼
Evidence Bundle      (immutable, digest-sealed, independently stored)
        │
        ▼
Evidence Verifier    (verifyEvidenceBundle -- recomputes, never trusts)
        │
        ▼
Consumer  (auditor / partner / customer / public -- future Passport/Assurance)
```

The Governance Record never leaves the Governance Store. Every Bundle is
*built from* it, through the Projector, and stored independently in the
Bundle Store (`src/enterprise/evidence/evidence-store.ts`) -- never inside
the Governance Store.

## What an Evidence Bundle is not

- Not a copy of the Governance Record.
- Not a dump.
- Not a backup.
- Not a SQL export.
- Not a snapshot of the Store.

It is a deliberate, disclosure-governed *projection*: every field on it was
individually classified as visible, hidden, or redacted by the
`DisclosurePolicy` that produced it (`src/enterprise/evidence/disclosure-policies.ts`).

## Model

```ts
interface EvidenceBundle {
  bundleId: string;
  bundleVersion: string;              // 'evidence.bundle.v1' -- its own lineage, independent of the Store schema
  createdAt: string;
  source: EvidenceSource;             // evaluationId/decisionId/requestId/kernelVersion/enterpriseVersion/schemaVersion -- never the full Governance Record
  subject: EvidenceSubject;           // what is being demonstrated
  disclosure: EvidenceDisclosureMetadata;
  integrity: EvidenceIntegrityMetadata;
  evidence: EvidenceContent;          // status/summary/reasonCodes/trace/events/metadata -- only what the policy discloses
  verification: EvidenceProvenance;   // who/when/what-version built this projection
  references: readonly EvidenceReference[]; // reserved links to future Passport/Assurance/external-audit artifacts
}
```

See `src/enterprise/evidence/contracts.ts` for the complete, documented type
definitions, including the fixed field vocabulary (`EVIDENCE_FIELD_KEYS`)
every `DisclosurePolicy` classifies.

## Integrity

Every Bundle carries three digests (`EvidenceIntegrityMetadata`):

| Digest | Meaning |
|---|---|
| `bundleDigest` | SHA-256 over this Bundle's own projected content. Changes whenever the disclosed content changes -- different policies produce different `bundleDigest`s even from the same record. |
| `recordDigest` | The source Governance Record's `integrity.aggregateDigest`, carried **verbatim**. The Bundle never recomputes the decision, only projects it. |
| `verificationDigest` | Binds `bundleDigest`, `recordDigest`, and the disclosure policy identity together, so no one of the three can be swapped independently without detection. |

`bundleDigest ≠ recordDigest` by construction: two different Bundles (e.g.
PUBLIC and AUDITOR) built from the same Governance Record share the same
`recordDigest` but have distinct `bundleDigest`s, because the projection --
not the underlying decision -- is what differs.

## Verification

`verifyEvidenceBundle` (`src/enterprise/evidence/verifier.ts`) never trusts
a stored digest at face value. It answers, in order:

1. Does the Bundle's content match its own `bundleDigest`? (tamper check)
2. Does the digest binding (`verificationDigest`) still hold?
3. Does `recordDigest` match the Governance Record it claims to project,
   when one is supplied?
4. Does the Bundle's claimed disclosure policy match a real, registered
   `DisclosurePolicy`?
5. Is the Bundle missing any field its own policy requires
   (`requiredFields`)?
6. Is `bundleVersion` one this build understands?

A Bundle is `valid` only if every check passes; every failure is reported
individually in `failures`, never collapsed into a single boolean.

## Lifecycle

```
Governance Record → Bundle Generated → Bundle Stored → Bundle Verified → Bundle Exported
```

Tracked as `EvidenceBundleState` (`GENERATED` / `VERIFIED` / `EXPORTED` /
`SUPERSEDED`) in the Bundle Store -- never on the immutable `EvidenceBundle`
value itself. Bundles are never updated. A changed disclosure policy, or a
request for different content, always produces a **new** Bundle with its
own `bundleId` and `bundleDigest`; the previous Bundle is marked
`SUPERSEDED`, never rewritten or deleted.

## Multiple Bundles, one Record

```
Governance Record
        ├── PUBLIC Bundle    (bundleDigest A)
        ├── CUSTOMER Bundle  (bundleDigest B)
        ├── AUDITOR Bundle   (bundleDigest C)
        └── FULL Bundle      (bundleDigest D)   -- Assurance-ready
```

All four share the same `recordDigest`; all four have distinct
`bundleDigest`s and their own `bundleId`. See
`src/enterprise/__tests__/evidence-service.test.ts` for the executable
proof of this shape.

## HTTP surface

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/evidence/build` | `{ evaluationId, level, createdBy? }` → `201` with the stored `{ bundle, state, storedAt }`. |
| `GET` | `/api/evidence/{bundleId}` | `200` with the stored Bundle, `404` if unknown or out of the caller's tenant scope. |
| `POST` | `/api/evidence/verify` | `{ bundleId }` → `200` with the full `EvidenceVerificationResult`. |
| `POST` | `/api/evidence/build` with `{ requestId, level }` | ASSURE-01: a v2 bundle carrying the governed request's trace (below). |
| `GET` | `/api/evidence/traces/{requestId}?level=…` | ASSURE-01: the trace, disclosed at `level`. A pure read. |
| `GET` | `/api/evidence/traces/{requestId}/verify` | ASSURE-01: its structured verification. A pure read. |

No mass-query endpoint is exposed -- only lookups bounded to a Bundle's own
identifiers (`bundleId`, `evaluationId`, `decisionId`), consistent with the
Governance Store's own bounded query surface. Tenant scoping is resolved
identically to the PR-004 governance-read endpoints
(`resolveGovernanceAccessContext`), so a caller can never build or read an
Evidence Bundle over a Governance Record outside its own organization.

## Non-goals (explicitly out of scope for v1)

Passport Runtime, Assurance Runtime, digital signatures, blockchain
anchoring, TSA/notarization, external storage (IPFS, OCI registries), PDF or
signed ZIP export, OpenAttestation, W3C Verifiable Credentials, DIDs,
wallets, or cryptographic custody. `EvidenceBundle.references` and the
`verification` (provenance) block exist specifically so those layers can be
added later **without changing this model** -- see
`docs/architecture/ADR-EVIDENCE-BUNDLE.md`.

## Compatibility

PR-005 does not modify PR-004. The Governance Store, its schema, its
digests, and its HTTP surface are unchanged; `src/enterprise/__tests__/compatibility.test.ts`
and the full Governance Store contract suite continue to pass unmodified.
The Evidence Bundle Store is an independent storage component
(`src/enterprise/evidence/evidence-store.ts`) -- Bundles are never persisted
inside the Governance Store.

## ASSURE-01: the Unified Authority-to-Outcome Trace and v2 bundles

ASSURE-01 (`docs/security/ASSURE-01-UNIFIED-AUTHORITY-OUTCOME-TRACE.md`)
reconciles the bundle with the P8 event stream and the rest of the
governed-action spine. Everything above stays true for v1.

- **The trace** (`src/enterprise/evidence/trace-*.ts`, `aoc.authority-trace.v1`)
  is a deterministic, read-only projection of one governed request over the
  canonical stores: Governance Record (request, decision), approval log,
  obligation discharges, bounded grant and revocation, write-ahead claim, P11
  attempt and initial observation, P7 reservation, P12 binding and
  resolution, P8 events. It is rebuilt on every read and stored nowhere. The
  lookup key is the governed request id `POST /api/governed-actions`
  returns; every other identity is derived from it exactly. Each stage states
  one closed presence (`recorded`, `not-applicable`, `not-reached`,
  `unresolved`, `missing`, `unreadable`, `not-composed`, `none-recorded`).
- **Verification** returns every check with its category — contract,
  integrity, authenticity (only where the artifact itself is signed),
  correlation, completeness — and `verified` only when none failed.
- **v2 bundles** (`evidence.bundle.v2`) carry every v1 section plus the
  trace disclosed under one of five **v2** disclosure policies
  (`evidence.disclosure.*.v2`: the ten v1 fields plus one field per trace
  stage), and `integrity.traceDigest`, bound into `verificationDigest`. The
  v1 policies, bytes, digests and verification are unchanged; a trace
  attached to a v1 bundle is refused. Verifying a v2 bundle also rebuilds the
  canonical trace now: a bundle whose request has since moved on is `valid`
  and `superseded-by-later-facts`; one the canonical records contradict is
  invalid. Building again supersedes the earlier bundle of the same request
  and policy (never rewriting it); an unchanged trace returns the bundle
  already stored.
- **The Bundle Store is durable**: `src/enterprise/evidence/sqlite-evidence-store.ts`
  (`AOC_ENTERPRISE_EVIDENCE_SQLITE_PATH`, default `.data/evidence-bundles.sqlite`),
  composed whenever persistence is `sqlite` and required by the secure Host
  profile; its own file, never the Governance Store; immutable content,
  forward-only lifecycle replayed from an append-only log, every read
  re-verified; registry store fourteen of `backup:v1` / `restore:v1`. Bundle
  ownership is the store's own column, so a bundle whose policy hides the
  organization is still readable by — and only by — that organization.
- **FULL is internal.** An organization-scoped credential receives at most
  AUDITOR for a trace or a v2 bundle; sub-fields follow the field that governs
  them, and a bundle's verification is disclosed under its own policy.
- **Not authenticity.** Integrity, correlation and completeness. The trace and
  bundles are not signed (ASSURE-02).
