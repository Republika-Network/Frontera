# ADR — Governance Reference Integrity

**Status:** Accepted
**Scope:** Frontera Systems Governance Store (`src/enterprise/governance-store/`)
**Supersedes nothing. Changes no historical record.**

Related: `ADR-ENTERPRISE-GOVERNANCE-STORE.md`,
`docs/enterprise/AOC_ENTERPRISE_GOVERNANCE_STORE.md`,
`ADR-TOKENIZE-CAPABILITY.md`, `ADR-COLLATERALIZE-ACTION.md`.

---

## Problem

`governance_references` rows were not covered by any integrity mechanism. A
direct database writer could change a persisted `reference_type`,
`external_id`, `uri`, or `created_at`, or delete or fabricate rows, and
`verify()` would still report the aggregate as valid.

The consequential case is classification laundering: rewriting an
`execution_record` (something an external system claims it did) into an
`authorization_artifact` (something Soberanía itself authorized), or the reverse.
That is the one distinction the reference vocabulary exists to make, and it
was the one thing nothing protected.

## Historical constraint

References cannot simply be added to the aggregate digest, for a structural
reason and a compatibility reason.

**Structural.** The aggregate digest is sealed inside `appendEvaluation`'s
transaction. The artifacts references name do not exist at that moment: a
`TokenizationMandate` is issued *after* the aggregate commits — it carries
`evaluationRef`, so it cannot precede the evaluation — and an
`execution_record` reports an external event that may happen months later.
References are appended after the seal by necessity, not by oversight.
`projection.ts` builds every aggregate with `references: []` and always has.

**Compatibility.** Two guards in the code make redefinition destructive:

- `initSchemaAndMigrate` throws `GOVERNANCE_SCHEMA_VERSION_UNSUPPORTED` when a
  database's stored `schema_version` differs from the build's, in *both*
  directions;
- `loadAggregate` reports any aggregate whose stamped `metadata.schemaVersion`
  differs as `corrupted`, and that field sits inside `metadataDigest` inside
  `aggregateDigest`.

So a schema-version bump would make this build refuse every existing database
*and* mark every historical aggregate corrupted, unfixable without rewriting
history. And recomputing historical aggregate digests to include references
would destroy the only property those digests have: attesting to bytes
committed at a known past moment.

**Future engineers: do not "simplify" this by folding references into the
aggregate digest.** It is not a simplification. It converts every stored
aggregate digest into a present-day recomputation and silently discards the
evidence value of everything already recorded.

## Candidate designs

| | Design | Assessment |
|---|---|---|
| A | Independent per-reference hash chain (`digest(prev + reference)`) | Detects modification, insertion, reordering, and mid-chain deletion. Needs an anchor for tail deletion. |
| B | Reference-set digest per aggregate, recomputed and rewritten on each append | Detects the same set, but the stored set-digest row is rewritten on every append — an update-in-place inside an append-only store — and it loses per-row attribution, so a failure names the set rather than the row. |
| C | Versioned append-only integrity records in a separate side table | Detection identical to A, at the cost of a second table, a join on every load, and a second identity per reference, for no additional property. |
| D | **Reuse the repository's existing per-aggregate append-only chain primitive** — the Agent Passport event chain (`src/enterprise/passport/events.ts`): explicit field-set digest input, `aoc.canonical-json.v1` + SHA-256 from `governance-store/digest.ts`, per-aggregate scope, `verifyEventChain`-style verification, plus a stored head projection (`agent_passports.latest_sequence` / `latest_event_digest`). | A, expressed in a shape this repository already ships, tests, and maintains. |

Rejected outright:

- **folding references into the aggregate projection** — invalidates every
  stored aggregate digest (above);
- **back-filling digests over historical rows** — proves present-state
  consistency while presenting itself as evidence of historical immutability.
  Dishonest, and the reason the legacy classification exists instead;
- **signatures / PKI / HSM** — out of scope. The requirement is tamper
  *evidence*, not privileged attestation, and introducing key material would
  create a key-management problem this store has no answer for.

## Selected design

**D, with A's chain semantics: a per-evaluation append-only reference hash
chain plus a stored chain head.**

- Additive nullable columns on `governance_references`: `sequence`,
  `reference_integrity_version`, `previous_reference_digest`,
  `reference_digest`.
- New table `governance_reference_chains`: one head row per evaluation
  (`latest_sequence`, `latest_reference_digest`, `integrity_version`).
- Version `aoc.governance-reference-integrity.v1`, stamped **per row**.
- Digest input (explicit field set, absent optionals pinned to `null`):
  `referenceId`, `evaluationId`, `organizationId`, `sequence`,
  `referenceType`, `externalId`, `externalVersion`, `digest`, `uri`,
  `createdAt`, `integrityVersion`, `previousReferenceDigest`.
- `appendReference` becomes one transaction: read head → assign position →
  seal → insert row → advance head.
- Verification joins the existing `verify()` path as one additional check.
- Both providers call the same `sealGovernanceReference` and
  `verifyGovernanceReferenceIntegrity`, so the sealed bytes cannot drift.

### Why the aggregate digest was not changed

`computeAggregateDigest` and every `*DigestInput` in `projection.ts` are
untouched, and `buildGovernanceAggregate` still constructs aggregates with
`references: []`. A reference append therefore cannot change any aggregate
digest, and a historical aggregate verifies to the same bytes before and after
this change — asserted directly in
`governance-reference-integrity.test.ts` ("A. the aggregate digest is not
redefined", "F. a pre-hardening database still opens and verifies").

### Why a stored chain head

Without it, deleting the *newest* references leaves a chain that is shorter but
internally consistent — sequences 1..N-1, every link intact — and therefore
undetectable. The head row records what the newest reference should be. This is
the same projection the Agent Passport Store keeps for the same reason.

The head is a projection of append-only rows, not a record of its own, which is
why it is the one thing in this design that is updated in place.

## Compatibility model

| Case | Behavior |
|---|---|
| historical aggregate | digest unchanged, verifies identically |
| historical reference | readable, unchanged, classified `legacy_unprotected`, never a failure |
| new protected reference | sealed, chained, tamper-evident |
| mixed database | both coexist; the protected chain starts at `sequence` 1 and attests only to rows it sealed |
| new runtime, old database | opens; columns added additively; nothing back-filled |
| old runtime, new database | opens and reads normally — added columns are invisible to column-named `SELECT`s and `INSERT`s, and the schema version is unchanged |
| rollback: this build meets a chain sealed by a newer one | `appendReference` refuses with `GOVERNANCE_SCHEMA_VERSION_UNSUPPORTED` before writing; reads still work, and the newer rows report `protected_unsupported_version` |

### Legacy semantics

A row is `legacy_unprotected` only when it carries **no** integrity metadata.
A row carrying *some* is not legacy — it is a protected row that lost part of
itself, and it is reported as `protected_corrupted`. Never demoting a damaged
protected row to legacy is what keeps the fail-closed property meaningful.

Stated without hedging: **references created before this feature were not
covered by reference-integrity protection.** Nothing here changes that, and no
digest is manufactured to suggest otherwise.

### Versioning

`aoc.governance-reference-integrity.v1`, per row, not a schema bump — for the
reasons in "Historical constraint". A row declaring an unknown version is
reported `protected_unsupported_version` and fails closed: not guessed at, not
treated as corruption (the row may be intact), not demoted to legacy (it
claims protection).

## Security properties

Protected:

- modification of any digested field of a protected reference;
- deletion of a protected reference (mid-chain via sequence gap; newest via
  the chain head; all of them via the orphaned head);
- insertion of a fabricated protected reference;
- reordering of protected references;
- moving a protected reference to another aggregate or tenant (both
  `evaluationId` and `organizationId` are digested);
- partial removal of integrity metadata;
- unknown integrity versions (fails closed).

Not protected, and not claimed:

- **a privileged database writer** who rewrites a row, recomputes its digest,
  re-links every following reference, and updates the chain head. Identical in
  kind to the pre-existing aggregate-chain limitation;
- **modification of legacy-unprotected rows** — they were never sealed;
- **rows written by a runtime without this mechanism**, which are
  indistinguishable from genuinely historical ones;
- **authority, legal validity, or execution truth.** A valid digest proves the
  row is unchanged. Nothing more.

## Known limitations

1. The privileged-writer limitation above. Local digests cannot solve it.
2. Reference integrity attests to rows *it sealed*, not to the completeness of
   the table.
3. Chain scope is per evaluation, so tail-deletion detection depends on the
   head row surviving.
4. No cross-instance or cross-node coordination is claimed; both providers
   serialize writes locally.

## Deferred

Strengthening beyond local digests — an external transparency log, signatures,
remote attestation, a cross-instance integrity anchor, or a Protocol-level
evidence anchor — is recorded here as **deferred architecture only**. None is
implemented, and none should be added speculatively. If it is taken up, it is a
trust-anchor problem spanning both integrity domains and both durable stores,
not a reference-integrity feature.

## Protocol boundary

Unchanged. This protects Enterprise-owned governance evidence. It creates no
sovereignty capability and touches no Protocol contract.

```
Soberanía Protocol    -> Sovereignty Capabilities
Frontera Systems  -> Governed Actions -> Enforcements -> Mandates -> Evidence
```
