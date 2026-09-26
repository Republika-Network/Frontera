# Soberanía Verifiable Export Package

Recognition Runtime, Authority Graph, Approval Runtime, External Agent
Handshake, Action Enforcement, Domain Policy Pack Runtime, and the Evidence /
Source / Citation Runtime each answer their own question about an autonomous
action. None of them answer the question a buyer, auditor, or counsel asks
once every one of those decisions has already been made:

**Ca Soberanía produce a portable, deterministic, tamper-evident package that
explains and proves why an autonomous action was allowed, blocked, required
approval, required evidence, or executed?**

That is the Verifiable Export Package's job.

## Why Soberanía needs verifiable export after the Evidence / Source / Citation Runtime

Soberanía already has every runtime fact it needs: a recognition decision, an
authority proof, an approval decision and proof, an external standing proof,
a policy pack decision and proof, evidence artifacts and citations, an
enforcement decision and proof, an execution result. What Soberanía has not had
until now is a way to **package** those facts into one portable,
self-verifying artifact a customer, auditor, or investor can inspect without
trusting Soberanía's live UI or database.

## Core thesis

**Soberanía already has the runtime facts. Now Soberanía must package those facts into a
portable, verifiable decision packet.**

The export package must not create truth. The export package must package
existing truth. It only:

- collects,
- normalizes,
- orders,
- hashes,
- links,
- serializes,
- verifies internal consistency,
- produces human-readable explanations from existing reasons/codes only,
- produces machine-verifiable artifacts.

It never re-evaluates recognition, authority, approval, policy, evidence
sufficiency, enforcement, or execution. See
[Legal / compliance disclaimer](#legal--compliance-disclaimer).

## What this module is not

- **Not a standalone reporting system.** It has no analytics, dashboards, or
  aggregation logic beyond hashing and linking what other runtimes already
  decided.
- **Not a re-evaluation engine.** It never calls back into Recognition
  Runtime, Authority Graph, Approval Runtime, External Agent Handshake,
  Action Enforcement, Domain Policy Pack Runtime, or Evidence Runtime to
  produce a *new* decision -- it only reads what those runtimes already
  produced.
- **Not a legal-conclusion engine.** It never infers legal or statutory
  compliance from package completeness.
- **Not a PDF generator, OCR pipeline, or binary parser.** It produces
  strings (JSON, markdown) only.
- **Not network-connected.** It makes no network calls and writes nothing to
  disk; every artifact it produces is an in-memory string a caller may choose
  to persist.

## Core concepts

- **ExportPackage** -- the top-level container: an id, a `type` (see
  [Package types](#package-types)), a `status`
  (`draft`/`sealed`/`verified`/`verification_failed`/`revoked`/`superseded`),
  a `targetType`/`targetId` naming the decision/proof this package is about,
  an ordered list of `sections`, and (once sealed) a `packageHash`.
- **ExportPackageSection** -- one named slice of the package (`recognition`,
  `authority`, `approval`, `external_standing`, `policy`, `evidence`,
  `citations`, `enforcement`, `execution`, `events`, `control_plane`,
  `enterprise_demo`, `summary`, `manifest`, `verification`). Carries its own
  `items`, a `sectionHash`, whether it is `required` for this package's type,
  and a `status` (`included`/`not_available`/`incomplete`/`failed_verification`).
- **ExportPackageItem** -- one fact copied from a source runtime record: its
  `type` (e.g. `policy_decision`, `enforcement_proof`), which
  `sourceModule` and `sourceId` it came from, a `payload` (the source
  record's own fields, verbatim), and a `payloadHash`.
- **ExportPackageReference** -- a directed link between two items (e.g. an
  `enforcement_decision` item `requires` a `policy_proof` item), derived
  purely from fields the source runtimes already recorded on the item's own
  payload -- see [How references link decisions/proofs/evidence](#how-references-link-decisionsproofsevidence).
- **ExportPackageManifest** -- one hash per section, one hash per item, one
  hash per reference, which sections were required for this package's type,
  and which required sections are missing, plus a `manifestHash` over all of
  it.
- **ExportPackageIntegrityReport** -- the result of recomputing every hash
  and structural check (duplicate ids, unknown references, target mismatch)
  against the package's own recorded state.
- **ExportPackageVerification** -- the top-level pass/fail/warn result:
  whether the manifest, package hash, section hashes, item hashes, and
  reference hashes all still match what the package claims.
- **DecisionPacket** -- a compact summary record (action, actor, allowed,
  executed, blocked, reasonCode, reason) plus pointers to each section id,
  produced alongside every `create*Packet` call.
- **AuditBundle** -- a summary (`packageCount`/`decisionCount`/`proofCount`/
  `eventCount`/`issueCount`) over a set of already-sealed packages, with its
  own `bundleHash`.

## Package types

`decision_packet` (a generic, single-action packet), `audit_bundle`,
`policy_decision_packet`, `enforcement_decision_packet`,
`approval_decision_packet`, `evidence_packet`,
`control_plane_snapshot_packet`, `enterprise_demo_packet`. Each type has its
own required-sections list (`REQUIRED_SECTIONS_BY_PACKAGE_TYPE` in
`services/export-package-manifest-service.ts`) -- e.g. every package type
requires a `summary` section; `policy_decision_packet` additionally requires
`policy`; `evidence_packet` additionally requires `evidence`.

## How package items map to source runtime objects

Every mapping lives in `integrations/*.ts`, one adapter file per source
module. Each adapter is a set of pure functions (`mapXToItem(ctx, x)`) that:

1. copy the source object's own fields into `payload` verbatim,
2. hash that payload with the same deterministic `createDigest` every proof
   in this repo already uses,
3. tag the item with its real `sourceModule` and the source object's own
   `id` as `sourceId`.

No adapter re-evaluates, re-scores, or overrides the object it maps. See
each adapter's own docstring for the specific "never re-evaluates X" note.

## How references link decisions/proofs/evidence

`services/export-package-reference-resolver.ts` holds a static rule table:
each rule names an item `type` and a `payload` field on that item (e.g.
`enforcement_decision.policyProofId`), and says what reference `type` to
create when another item's `sourceId` matches that field's value (e.g.
`requires` a `policy_proof`). The resolver never infers a link the source
runtimes did not already record as a field on the item's own payload. When a
referenced id has no matching item in the package, it is reported as a
**missing reference** instead of silently dropped -- see
[How missing references are detected](#how-missing-references-are-detected).

## How package hash is created

`services/export-package-hash-service.ts` wraps the repo-standard
`stableStringify` + SHA-256 `createDigest` pair (the same deterministic hash
every other feature's proof already uses) with typed helpers:
`hashPayload`, `hashSection`, `hashReference`, `hashManifest`, `hashPackage`,
`hashSerializedArtifact`, `hashAuditBundle`. `hashPackage` is computed over
the package's own identity fields plus its `manifestHash` (and
`previousPackageHash`, when this is not the trust domain's first sealed
package) -- so changing anything inside any section changes the section
hash, which changes the manifest hash, which changes the package hash.

## How manifest hash is created

`services/export-package-manifest-service.ts`'s `createManifest` collects
one hash entry per section/item/reference, the list of source modules
touched, and this package type's required/missing-required sections, then
hashes all of that with `hashManifest`. `verifyManifest` recomputes the same
hash from the manifest's own recorded fields and compares it.

## How verification works

`services/export-package-verification-service.ts`'s `verifyPackage`:

1. asks `ExportPackageIntegrityService` to recompute every section/item/
   reference hash against what is actually stored, and to run the
   structural checks below;
2. recomputes the manifest hash and the package hash from scratch;
3. combines all of that into one `ExportPackageVerification` record with a
   `status` of `verified` (nothing wrong), `verified_with_warnings` (only
   non-blocking issues, e.g. a missing *optional* section or reference), or
   `failed` (any hash mismatch, structural error, or missing *required*
   section).

Verification never re-evaluates the decision the package describes -- it
only proves (or disproves) that the package still says what it said when it
was sealed.

## How tampering is detected

`services/export-package-integrity-service.ts` recomputes `hashSection` for
every stored section and `hashPayload` for every stored item, comparing each
against the hash recorded at seal time. A changed payload, a changed item
list, or a changed section produces a `critical`-severity
`ITEM_PAYLOAD_HASH_MISMATCH` / `SECTION_HASH_MISMATCH` /
`REFERENCE_HASH_MISMATCH` issue, which fails verification.

## How missing references are detected

When the reference resolver finds an item field pointing at a `sourceId` no
item in the package has, it is recorded as a `MissingReference` and
attached to the section that contains the referencing item
(`section.missingReferenceIds`), demoting that section from `included` to
`incomplete`. The integrity report also surfaces a `warning`-severity
`MISSING_REFERENCE` issue for each one, and the manifest separately reports
`missingRequiredSections` for entire sections that are absent when this
package type requires them.

## How JSON bundle serialization works

`services/export-package-serializer.ts`'s `serializeJsonBundle` produces a
deterministic JSON string (via `stableStringify`, the same key-sorting
stringifier every hash in this repo uses) over `{ package, manifest,
verification? }`, plus a `contentHash` over that string. `serializeManifest`,
`serializeIntegrityReport`, and `serializeAuditBundleFragment` do the same
for just those records. Nothing here writes to a filesystem -- every
serializer returns a `SerializedExportPackage` string the caller may persist
however their environment allows.

## How markdown summary generation works

`services/export-package-markdown-service.ts`'s `render(pkg, manifest,
verification, audience)` builds a deterministic markdown string (no LLM,
no randomness) for one of three audiences (`buyer`, `technical`, `auditor`),
always including: the decision summary, the package/manifest hash, a
per-section status table, a policy summary, an enforcement summary, an
evidence/citation summary, the verification status, and the legal
disclaimer (see below). Every sentence is built from `reason`/`reasonCode`/
`summary` fields already present on the package's own items -- never
invented, never LLM-generated.

## How audit bundle fragments work

`ExportPackageRuntime.createAuditBundle` builds a small summary
(`packageCount`/`decisionCount`/`proofCount`/`eventCount`/`issueCount`) over
a caller-supplied list of already-sealed package ids, hashes it with
`hashAuditBundle`, and wraps it in its own `audit_bundle`-typed
`ExportPackage`. `serializePackage(id, 'audit_bundle_fragment')` renders that
summary as a JSON fragment.

## How Recognition Runtime integrates

`integrations/recognition-export-adapter.ts` maps a `RecognitionDecision`
and a `RecognitionProof` (a bare signature record with no `id` of its own --
its `digest` is used as `sourceId`) into items. Never re-evaluates
recognition; a `deny`/`revoked` decision is copied verbatim, never
overridden.

## How Authority Graph integrates

`integrations/authority-export-adapter.ts` maps an `AuthorityGrant`, a
`DelegationGrant` (preserving `sourceAuthorityGrantId`, i.e. delegation
lineage), and an `AuthorityProof` into items.

## How Approval Runtime integrates

`integrations/approval-export-adapter.ts` maps an `ApprovalRequest`, an
`ApprovalDecision`, and an `ApprovalProof` into items. Never fakes a human
review that did not occur -- `approverActorId` and `approved` are copied
exactly as recorded.

## How External Agent Handshake integrates

`integrations/external-handshake-export-adapter.ts` maps an
`ExternalAgentStanding`, an `AgentVisa`, and a `HandshakeProof` into items,
preserving trust boundary, allowed scope, and expiration fields verbatim.

## How Action Enforcement integrates

`integrations/action-enforcement-export-adapter.ts` maps an
`EnforcementRequest`, `EnforcementDecision`, `EnforcementProof`,
`ExecutionResult`, `SideEffectDescriptor`, and `EnforcementEvent` into
items, preserving every upstream reference field
(`recognitionDecisionId`/`authorityProofId`/`approvalProofId`/
`handshakeProofId`/`policyDecisionId`/`policyProofId`) so the reference
resolver can link this decision to the proofs it required. Never re-runs
the executor and never changes a recorded execution status.

## How Domain Policy Pack Runtime integrates

`integrations/policy-pack-export-adapter.ts` maps a `PolicyPack`,
`PolicyPackVersion` (preserving `demoOnly`/`legalCompleteness` as plain
metadata, never upgraded), `PolicyPackRule`, `PolicyPackDecision`,
`PolicyPackProof`, and `PolicyPackEvent` into items. Never re-evaluates a
policy rule.

## How Evidence Runtime integrates

`integrations/evidence-export-adapter.ts` maps every Evidence / Source /
Citation Runtime record type (`SourceDocument`, `EvidenceArtifact`,
`EvidenceRequirement`, `EvidenceSatisfaction`, `EvidenceReview`, `Citation`,
`EvidenceLink`, `EvidenceProof`, `EvidenceEvent`) into items, preserving
every hash and every `demoOnly`/`legalCompleteness` label. Never evaluates
legal sufficiency -- evidence presence is copied as a fact, not upgraded
into a conclusion.

## How Control Plane integrates

`integrations/control-plane-export-adapter.ts` maps a
`DemoControlPlaneSnapshot` (has a real, durable id) or a live
`AocControlPlaneReadModel` (no durable id of its own -- this adapter derives
a deterministic `sourceId` from `trustDomainId` + the read model's own
`generatedAt`, never invents a timestamp) into a `control_plane_snapshot`
item. Never mutates the Control Plane read model.

## How Enterprise Demo integrates

`integrations/enterprise-demo-export-adapter.ts` maps a `DemoScenario`
definition, a `DemoScenarioRun` (its own recorded `status`/`outcome`/
`proofChain` copied verbatim -- never re-run, never re-scored), and a
`DemoExportArtifact` into items.

## Legal / compliance disclaimer

- Export packages are **not legal advice**.
- Evidence presence, citation coverage, or policy pack coverage does **not**
  by itself prove legal or regulatory compliance.
- Demo-only packages and policy packs are illustrative and are **never** a
  substitute for customer- or counsel-validated compliance review.
- `not_legal_advice`/`demoOnly` metadata is copied as-is and is **never**
  converted into a claim of `verified`.
- Evidence is treated as legally sufficient only when a source document's or
  package's own metadata already says `verified_by_customer` or
  `verified_by_counsel` -- this module never assigns that label itself.

Every markdown summary this module renders repeats this disclaimer verbatim
(`services/export-package-markdown-service.ts`'s `LEGAL_DISCLAIMER`
constant).

## Determinism

- **Injected clock.** `ExportRuntimeClock`/`ManualExportRuntimeClock`
  (`domain/export-runtime-context.ts`) -- every timestamp comes from
  `ctx.clock.now()`, never `Date.now()` or `new Date()`.
- **Injected id generator.** `ExportRuntimeIdGenerator` -- every id comes
  from `ctx.ids.nextId(prefix)`, a sequential `${prefix}-000001` counter,
  never a random id.
- **Deterministic hashes.** Every hash in this module is SHA-256 over a
  recursively key-sorted `stableStringify` of already-recorded data --
  identical input always produces an identical hash.
- **No LLM evaluation.** Markdown/summary text is built from existing
  `reason`/`reasonCode`/`summary` fields with plain string templates, never
  an LLM call.
- **No network calls.** This module makes none.

## How to add a new section

1. Add the section type to `ExportPackageSectionType` in
   `domain/export-package-section.ts`.
2. Add a default title/description entry to `SECTION_DEFAULTS` in
   `services/export-package-section-builder.ts` and export a
   `buildXSection` convenience wrapper (or just pass the type directly to
   `buildSection`).
3. If the section should be required for one or more package types, add it
   to that type's entry in `REQUIRED_SECTIONS_BY_PACKAGE_TYPE` in
   `services/export-package-manifest-service.ts`.
4. If the section's items should participate in `DecisionPacket`'s
   `*SectionId` pointers, add a case in `deriveDecisionSummary`/
   `createTypedPackage` in `services/export-package-runtime.ts`.

## How to add a new source adapter

1. Create `integrations/<feature>-export-adapter.ts`, importing the source
   feature's real domain types (type-only imports) and exporting one pure
   `mapXToItem(ctx, x)` function per record type worth exporting, following
   the pattern in an existing adapter (see
   [How package items map to source runtime objects](#how-package-items-map-to-source-runtime-objects)).
2. Add the new `ExportPackageItemType`/`ExportPackageItemSourceModule`
   values it needs to `domain/export-package-item.ts`.
3. Re-export the new mapping functions from `integrations/index.ts`.
4. If the new source module introduces new cross-item link fields, add rows
   to the `RULES` table in `services/export-package-reference-resolver.ts`.

## How to add a new package type

1. Add the new value to `ExportPackageType` in `domain/export-package.ts`.
2. Add its required-sections entry to `REQUIRED_SECTIONS_BY_PACKAGE_TYPE` in
   `services/export-package-manifest-service.ts`.
3. Add a `create<Name>Packet` convenience method to `ExportPackageRuntime`
   in `services/export-package-runtime.ts` (a one-line wrapper around
   `createTypedPackage('<new_type>', input)`).

## How to run tests

```
npm run build && node --test --test-reporter=spec dist/src/features/verifiable-export-package/tests/**/*.test.js
```

or simply `npm test` from the repo root to run the whole suite (this module
follows the same `node --test` convention as every other feature).

## Frontera Systems Pilot Template

Verifiable Export Packages can now be bound into Enterprise Pilot Kits via
`src/features/aoc-enterprise-pilot-template/services/pilot-export-package-binding-service.ts`,
which checks a pilot's declared export package definition against a real,
already-created-and-verified `ExportPackage` -- it never creates a package
itself and never marks a pilot's export requirement satisfied without a
real `verified`/`verified_with_warnings` verification result.
