# Frontera Systems Agent Passport Runtime v1 (PR-006)

`src/enterprise/passport/` — the governed identity, authority, status,
provenance, and evidence-reference record of an agent operating within an
organization.

## Core principle

The Passport does not decide. `AocKernel` (`src/kernel/`) decides. The
Governance Store (`../governance-store/`) remembers. Evidence Bundles
(`../evidence/`) demonstrate. The Passport identifies and contextualizes
the agent across time.

```
Evaluate
    ↓
Record
    ↓
Reconstruct
    ↓
Verify
    ↓
Project
    ↓
Share Evidence
    ↓
Identify   <-- PR-006
```

## Architecture

```
Frontera Systems
    │
    ├── Kernel
    ├── Governance Store
    ├── Evidence Runtime
    └── Agent Passport Runtime
            │
            ├── contracts.ts          -- canonical model
            ├── errors.ts             -- AgentPassportError taxonomy
            ├── lifecycle.ts          -- the one state machine
            ├── events.ts             -- event-chain digest (reuses governance-store digest/canonical-json)
            ├── reconstruction.ts     -- fold events -> AgentPassport
            ├── passport-store.ts     -- AgentPassportStore interface + tenant-scope helpers
            ├── in-memory-passport-store.ts
            ├── sqlite-passport-store.ts
            ├── verification.ts       -- STRUCTURAL / REFERENTIAL / FULL_INTERNAL
            ├── disclosure.ts         -- INTERNAL/AUDITOR/PARTNER/CUSTOMER/PUBLIC views
            ├── service.ts            -- AgentPassportService (orchestration surface)
            └── index.ts
```

Every dependency direction is one-way: the Passport Runtime imports public
contracts from the Governance Store and Evidence Bundle; neither of those,
nor the Kernel, imports the Passport Runtime. Enforced by
`src/enterprise/__tests__/structural-boundaries.test.ts`.

## What it adds

- A durable, event-sourced identity record per agent, bound to exactly one
  organization.
- A six-status lifecycle (`draft`/`active`/`suspended`/`revoked`/
  `expired`/`retired`) with one enforced state machine.
- Capability/authority/delegation **references** (never copies).
- Governance Record and Evidence Bundle **references** (never copies),
  validated against the real stores at link time.
- Per-Passport event-chain integrity (SHA-256 over canonical JSON, reusing
  the Governance Store's own primitive).
- Three verification modes: `STRUCTURAL` (event chain + lifecycle only),
  `REFERENTIAL` (+ referenced Governance Records/Evidence Bundles exist),
  `FULL_INTERNAL` (+ referenced integrity where accessible).
- Five minimal-disclosure views, each independently digested.
- Bounded, reference-derived history summaries — never a trust score.
- In-memory and SQLite `AgentPassportStore` implementations behind one
  contract, with shared contract tests
  (`src/enterprise/__tests__/passport-store-contract.test.ts`).
- HTTP endpoints under `/api/passports/*`.
- `aoc.enterprise.agent-passport`, a configuration-criticality Enterprise
  module.
- Telemetry counters (`passport_issued_total`, etc.) and Passport-specific
  error codes on the wire.

## What it does not add

See "Non-Goals" in the mission and "Known Limitations" below — no W3C
Verifiable Credentials, no DIDs, no wallets, no external signatures, no
trust scoring, no reputation, no Assurance certification.

## How it differs from `packages/agent-governance` (the commercial SaaS Passport)

| | `packages/agent-governance` | Frontera Systems Agent Passport Runtime |
|---|---|---|
| Purpose | Commercial, signed, QR-verifiable credential | Governed identity/history aggregate for Frontera Systems |
| Storage | Direct-mutation row (SaaS SQLite) | Append-only events, reconstructed state |
| Governance/Evidence integration | None | References Governance Records and Evidence Bundles by id+digest |
| Tenant model | Registry/purchase-scoped | `PassportAccessContext` (system / organizationId), same shape as the Governance Store's |
| Trust scoring | None | None (deliberately) |
| Consumers | `apps/agent-passport-web`, `packages/pmfreak-agent-passport-foundation` | `src/enterprise/*` HTTP surface, embedders of `AocEnterprise` |

Neither imports the other. See `AGENT_PASSPORT_MIGRATION_V1.md` for how
they coexist.

## Why no trust score

No governed, documented, explainable methodology exists for collapsing an
agent's history into a single number. A score invites over-trust it
cannot justify and cannot be disputed the way a list of references can.
`AgentPassportHistorySummary` exposes the underlying counts instead
(evaluations referenced, allowed/denied/approval-required counts,
suspensions, revocations) so a consumer can apply its own judgement, or
wait for a future Assurance Runtime to establish one.

## Verification model

- **STRUCTURAL**: recomputes and checks the event chain
  (`verifyEventChain`), re-derives lifecycle via
  `reconstructAgentPassportFromEvents`, and checks identity/organization
  binding, reference shape, and `passportRuntimeVersion` support. Never
  touches the Governance Store or Evidence Bundle Store.
- **REFERENTIAL**: everything STRUCTURAL does, plus confirms every
  `PassportGovernanceReference`/`PassportEvidenceReference` resolves to a
  real record in the caller's organization scope.
- **FULL_INTERNAL**: the same checks as REFERENTIAL in v1 (referenced
  integrity is confirmed by existence + digest match at link time; a
  deeper re-verification of the referenced Governance Record's/Evidence
  Bundle's own integrity is available separately via
  `governanceReads.verify()` / `evidence.verify()`).

None of these modes is "legal verification," "certification," or
"non-repudiation."

## Disclosure model

See `AOC_AGENT_PASSPORT_DISCLOSURE.md`.

## Database schema

Three SQLite tables (`aoc.agent-passport.schema.v1`):

- `agent_passports` — a reconstructable projection cache (never a second
  source of truth): `passport_id`, `organization_id`, `agent_id`,
  `agent_type`, `passport_version`, `created_at`, `created_by`,
  `latest_sequence`, `latest_event_digest`, `current_status`,
  `schema_version`. A partial `UNIQUE(organization_id, agent_id) WHERE
  current_status IN ('draft','active','suspended')` index enforces "one
  non-terminal Passport per agent per organization" at the database
  layer.
- `agent_passport_events` — canonical, append-only:
  `UNIQUE(passport_id, sequence)`, `previous_event_digest`,
  `event_digest`, full actor/timing/version metadata.
- `agent_passport_idempotency` — `(scope, idempotency_key)` primary key,
  `subject_digest`, `passport_id`.

No separate reference tables for capabilities/authorities/delegations/
governance/evidence — they are derived from events on reconstruction
(mission section 35: "Do not build two conflicting sources of truth").

## Module registration

```
aoc.enterprise.agent-passport
```

Capabilities: `passport.issue`, `passport.reconstruct`, `passport.verify`,
`passport.suspend`, `passport.reactivate`, `passport.revoke`,
`passport.retire`, `passport.reference-evidence`,
`passport.reference-governance`, `passport.project-view`. Declares an
`optional: true` dependency on `aoc.enterprise.governance-store`.
Criticality (`required`/`optional`) is set from
`AOC_ENTERPRISE_PASSPORT_REQUIRED` (default `false` — optional).

## HTTP endpoints

```
POST /api/passports
GET  /api/passports/{passportId}
GET  /api/passports/{passportId}/events
GET  /api/passports/{passportId}/history
POST /api/passports/{passportId}/activate
POST /api/passports/{passportId}/suspend
POST /api/passports/{passportId}/reactivate
POST /api/passports/{passportId}/revoke
POST /api/passports/{passportId}/retire
POST /api/passports/{passportId}/verify
POST /api/passports/{passportId}/evidence
POST /api/passports/{passportId}/governance
POST /api/passports/{passportId}/views
```

Every route defers tenant-scope resolution to `enterprise.passports`
(`AgentPassportService`) via `resolveGovernanceAccessContext`, exactly
the way the Evidence and Governance-read routes already do — no route
handler touches the Store directly.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `AOC_ENTERPRISE_PASSPORT_SQLITE_PATH` | `.data/agent-passport.sqlite` | Passport Store's own on-disk file (distinct from the Governance Store's) |
| `AOC_ENTERPRISE_PASSPORT_REQUIRED` | `false` | Module criticality: `true` makes a Passport Store outage block Enterprise readiness |

## Known Limitations

At completion, Passport v1 does not yet provide: W3C Verifiable
Credentials; DIDs; wallets; external digital signatures; key custody;
public identity federation; universal/global trust or reputation;
non-repudiation; external timestamping; blockchain anchoring;
zero-knowledge proofs; portable cross-enterprise recognition; legal
identity verification; model attestation; remote Passport exchange;
Passport recovery; a distributed Passport Store; or Assurance
certification. A background expiration scheduler does not exist —
expiration is an explicitly appended event (mission section 27's required
deterministic choice).
