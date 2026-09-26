# Frontera Systems Intellectual Property Overview

> STATUS: DRAFT — PENDING PROFESSIONAL LEGAL REVIEW.
> This document is a factual inventory derived from repository contents
> as of 2026-07-14. It is not a legal opinion on the strength,
> enforceability, or defensibility of any claim it describes.

## 1. Ownership

Frontera Systems, as embodied in this repository, is owned by Onchainfest
LLC, subject to:

- third-party open source and commercial dependencies (see
  `docs/legal/OPEN_SOURCE_DEPENDENCIES.md` and
  `docs/legal/THIRD_PARTY_NOTICES.md`);
- any component licensed to Onchainfest LLC under separate terms;
- material governed by a separate contract (e.g. a customer- or
  partner-specific agreement) that has not been reviewed as part of this
  inventory;
- Soberanía Protocol and its own, separate terms — Soberanía Protocol is a distinct
  repository and project that Frontera Systems consumes as a dependency,
  not material owned or claimed by this repository (see
  `docs/legal/PROTOCOL_ENTERPRISE_BOUNDARY.md`).

## 2. Core proprietary assets

This section lists assets that are actually implemented and verifiable
in the repository as of this writing. Assets that consist only of empty
directories, `.gitkeep` placeholders, or unfulfilled roadmap intent are
excluded from this table; where relevant they are called out separately
in the notes below the table.

| Activo | Estado | Rutas | Tipo de IP | Dependencia de Soberanía Protocol | Observaciones |
|---|---|---|---|---|---|
| Soberanía Kernel (governance decision engine) | Implemented, tested | `src/kernel/**` | Copyright; trade secret (decision logic) | Consumes `@aoc/protocol` contracts | Sole decision-maker in the request path; boundary enforced by structural tests |
| Frontera Systems Host (runtime hosting/API) | Implemented, tested | `src/enterprise/**` (134 source files) | Copyright; trade secret | Orchestrates around, does not redefine, protocol contracts | HTTP adapter, composition root, persistence, events, health, telemetry; 27 documented API endpoints (`release/RELEASE_MANIFEST.json`) |
| Frontera Systems Runtime (grants, delegation, vault, federation) | Implemented, tested | `src/runtime/**` (43 source files) | Copyright; trade secret | Consumes protocol primitives | Independently tested; does not call `AocKernel.evaluate()` |
| Governance Store (persistence layer) | Implemented | `src/enterprise/governance-store/**` | Copyright; trade secret (schema/design) | None | SQLite + in-memory providers; schema-version guards |
| Assurance Runtime / Soberanía SAF framework | Implemented | `src/enterprise/assurance/**` | Copyright; trade secret | None | `AOC_SAF_FRAMEWORK_ID = 'aoc.saf'`; sealed, re-derived section digests |
| Evidence lifecycle (Evidence Bundle) | Implemented | `src/enterprise/evidence/**` | Copyright; trade secret | None | Per `docs/architecture/ADR-EVIDENCE-BUNDLE.md` |
| Agent Passport Runtime (governance execution) | Implemented, tested (27 source files, 2 test files) | `packages/agent-governance/**` | Copyright; trade secret | None | Passport issuance/verification, constitution, runtime-guard decisions; consumed in ~39 locations |
| Enterprise Host SDK | Implemented, tested | `packages/enterprise-host-sdk/**` | Copyright | Consumes Frontera Systems' own API, not Soberanía Protocol directly | Typed HTTP client; frozen v1.0.0 surface; zero runtime dependencies |
| Tenant isolation (enforcement) | Implemented, empirically verified | `src/enterprise/governance-store/**` (shared tenant-scoping helpers) | Trade secret | None | Verified under concurrency (0 cross-tenant leaks in load testing per `docs/release/TECHNICAL_DUE_DILIGENCE_V1.md` §3). **Not** the same as `packages/tenant-governance`, which is contracts-only (see below) |
| Adapters (transport layer) | Implemented | `src/enterprise/adapters/node-http-adapter.ts`, `src/runtime/adapters/**` | Copyright | None | Single transport-aware module per host, per architecture docs |
| Operational tooling (backup/restore/portability) | Implemented, tested | `scripts/portability/**`, `scripts/generate-release-manifest.mjs` | Copyright; trade secret (procedures) | None | `backup:v1` / `restore:v1` / `validate:portability:v1`; 18 contract tests |
| Deployment patterns | Implemented (documented + scripted) | `docs/operations/DEPLOYMENT_GUIDE_V1.md`, `scripts/run-enterprise-host.mjs` | Copyright | None | Env-var reference, systemd/container/proxy patterns |
| Observability (telemetry/logging) | Implemented | `src/enterprise/telemetry/**` | Copyright | None | Operational counters + structured logging; no built-in metrics endpoint (documented gap, not a defect) |
| Backup and recovery | Implemented, tested | `scripts/portability/backup-enterprise-v1.mjs`, `restore-enterprise-v1.mjs` | Copyright; trade secret | None | RPO/RTO documented in `docs/operations/BACKUP_RECOVERY_V1.md` |
| Commercial integration — billing (Stripe) | Implemented | `apps/agent-passport-web/**` | Copyright (integration code only; Stripe itself is third-party) | None | Private demo/pilot app; explicitly **not** part of the shipped Enterprise runtime deliverable per `docs/release/DEPENDENCY_AUDIT_V1.md` |
| PMFreak Agent Passport Foundation (product-specific integration) | Implemented, tested (16 source files, 6 test files) | `packages/pmfreak-agent-passport-foundation/**` | Copyright; trade secret | None | Wires six PMFreak agent roles to Agent Passport Core; ~23 references elsewhere in the repo |
| Enterprise interface/contracts layer | Partial — type contracts only, no executable logic, no tests | `packages/control-plane-sdk`, `packages/tenant-governance`, `packages/org-boundary`, `packages/integration-runtime`, `packages/enterprise-audit`, `packages/policy-runtime` | Copyright (as authored expression) | None | Each has one `contracts.ts` file (26–44 lines); only `policy-runtime` has an external reference (one bridge `.d.ts` file) |
| Canonical Runtime Contracts (shared types) | Implemented (types/enums/reason-codes only, no executable logic), consumed | `packages/canonical-runtime-contracts/**` (35 files) | Copyright | None | Consumed in 6 locations; functions as the shared type-contract source of truth despite containing no runtime logic |
| Control Plane service | Implemented, untested, not externally consumed | `packages/control-plane/**` | Copyright | None | Real CRUD/state-machine logic (access requests/grants); no test coverage and no consumers outside its own package as of this writing — flagged for engineering/founder follow-up, not a defect in this document |
| Governance Treaties / Runtime Negotiation | Partial — early-stage | `packages/governance-treaties/**`, `packages/runtime-negotiation/**` | Copyright | None | In-memory only, no persistence or cryptography per their own docs; tests disabled (`*.test.skip.ts`); neither package declares a `name` in `package.json` — a workspace-scaffolding anomaly worth an engineering follow-up, not treated here as evidence of abandonment |
| Product verticals under `src/features/*` (13 subsystems) | Implemented, tested | `src/features/**` (e.g. `action-enforcement`, `aoc-control-plane`, `aoc-enterprise-demo`, `aoc-enterprise-pilot-template`, `aoc-integrations`, `approval-runtime`, `authority-graph`, `domain-policy-pack-runtime`, `evidence-source-runtime`, `external-agent-handshake`, `policy-pack-foundation`, `recognition-runtime`, `verifiable-export-package`) | Copyright; trade secret (varies by subsystem) | Varies | Structurally kept separate from `src/enterprise` by boundary lint (`docs/release/TECHNICAL_DUE_DILIGENCE_V1.md` Finding DD-1). Two subsystems are explicitly self-described as "demo" and "pilot template" verticals and should not be represented as core shipped runtime without that qualification |

### Not implemented — excluded from the table above

`packages/consent-engine`, `packages/capability-tokens`,
`packages/scoped-access`, `packages/identity`, and `packages/audit-sdk`
exist as workspace directories but contain no source beyond a
`.gitkeep` placeholder. Their names conceptually mirror the "Protocol
primitive layer" described in `docs/architecture/foundation.md`, but
today they contain no implementation, and no protocol-primitive
redefinition currently exists in Frontera Systems as a result. They are
listed here for completeness and founder awareness, not as implemented
assets. See Section 5.

Four `apps/*` directories (`agent-gateway`, `audit-console`, `dashboard`,
`policy-engine`) are empty placeholders (`.gitkeep` only) and are
likewise excluded from the table above.

## 3. Supporting assets

- Documentation: `docs/architecture/**` (ADRs, foundational and
  boundary docs), `docs/enterprise/**`, `docs/operations/**`,
  `docs/kernel/**`, `docs/sdk/**`, `docs/governance/**`.
- Proprietary schemas: store schema identifiers recorded in
  `release/RELEASE_MANIFEST.json` (`aoc.governance-store.schema.v1`,
  `evidence.bundle.v1`, `aoc.agent-passport.schema.v1`,
  `aoc.assurance-store.schema.v1`, `aoc.canonical-json.v1`).
- Test harnesses: the suites under each package's `__tests__`/`tests`
  directories and the strategy documented in
  `docs/testing/TEST_STRATEGY_V1.md`.
- Runbooks: `docs/operations/RUNBOOKS_V1.md`,
  `docs/release/AOC_ENTERPRISE_V1_TAGGING_RUNBOOK.md`.
- Threat models: `docs/security/THREAT_MODEL_V1.md` and its addendum.
- Release process: `scripts/generate-release-manifest.mjs`,
  `scripts/check-release-docs.mjs`, `scripts/check-api-freeze.mjs`,
  `release/RELEASE_MANIFEST.json`, `CHANGELOG.md`.
- Product packaging / commercial workflow: `apps/agent-passport-web`
  (pricing, checkout, account pages) as a reference implementation of a
  commercial integration.

## 4. Excluded assets

Expressly not owned by Onchainfest LLC as part of this repository:

- **Open source dependencies** — see
  `docs/legal/OPEN_SOURCE_DEPENDENCIES.md` (e.g. `better-sqlite3`,
  `next`, `react`, `react-dom`, `stripe`, `typescript`, and their
  transitive trees).
- **Third-party tools** used in development/CI (npm, TypeScript
  compiler, GitHub Actions runners) — not part of this repository's IP.
- **Public standards/specifications** referenced conceptually (e.g.
  OIDC/SAML/SCIM as integration targets described in
  `docs/architecture/repo-boundaries.md`) — the standards themselves are
  not owned by Onchainfest LLC; only original integration code is.
- **Soberanía Protocol** — a separate repository
  (`Architects-of-Change-Protocol/Architects_of_Change_Protocol`) with
  its own ownership and licensing; consumed here as the `@aoc/protocol`
  peer dependency. See `docs/legal/PROTOCOL_ENTERPRISE_BOUNDARY.md`.
- **Material not created by Onchainfest LLC** that may be introduced
  under a future contribution, contractor engagement, or acquisition —
  none identified in this repository as of this writing, but any such
  material must be documented per `CONTRIBUTING.md` when it arises.
- **Components with a separately documented license** — none identified
  in this repository beyond the dependencies above as of this writing.

## 5. Founder knowledge dependency

The following areas depend on knowledge that is not fully captured in
this repository and should be treated as a due-diligence gap until
addressed:

- **Security reporting channel** — resolved for initial operational
  purposes: `SECURITY.md` now designates `vicvalch@onchainfest.xyz`
  (`[SECURITY REPORT]`) with Víctor Valverde as primary owner. A backup
  security owner is not yet designated, and no operational testing,
  monitoring, or formal SOC/CISO coverage is claimed or verifiable from
  this repository; those remain due-diligence gaps.
- **Commercial licensing terms and contact** — `LICENSE` now designates
  `vicvalch@onchainfest.xyz` (`[COMMERCIAL LICENSE]`) as the licensing
  contact, but the actual commercial agreement template, pricing, and
  negotiation process are not recorded in this repository.
- **Entity, employment, and IP-assignment records** — this repository
  contains no employment agreements, contractor agreements, or IP
  assignment records; their existence and status cannot be verified from
  repository contents alone (see
  `docs/legal/IP_DUE_DILIGENCE_CHECKLIST.md`).
- **Rationale for the empty `packages/consent-engine` /
  `capability-tokens` / `scoped-access` / `identity` / `audit-sdk`
  stubs** — whether these are reserved namespace placeholders for future
  enterprise-side work, an intentional mirror of Soberanía Protocol's
  conceptual layer for future extension, or leftover scaffolding, is not
  documented in the repository and should be confirmed with engineering
  leadership.
- **Trademark registry status** — whether any of the names in
  `TRADEMARKS.md` have been filed or registered in any jurisdiction is
  not knowable from repository contents and must be confirmed against
  actual trademark office records.
- **Domain and account ownership** (e.g. package registry accounts,
  cloud infrastructure accounts) — not verifiable from this repository.

## 6. Protection strategy

| Asset category | Classification |
|---|---|
| Kernel, Enterprise Host, Enterprise Runtime, Governance Store, Assurance Runtime, Evidence lifecycle | Copyright + trade secret (source not published; logic and invariants are the differentiated value) |
| Agent Passport Runtime, PMFreak foundation, Control Plane service | Copyright + trade secret |
| Enterprise Host SDK | Copyright (client library; less trade-secret-sensitive by nature, since it is designed for external consumption) |
| Contracts-only packages (`control-plane-sdk`, `tenant-governance`, `org-boundary`, `integration-runtime`, `enterprise-audit`, `policy-runtime`, `canonical-runtime-contracts`) | Copyright only — thin, interface-level expression; not currently a meaningful trade secret given minimal content |
| Operational tooling, backup/recovery, deployment patterns | Copyright + execution advantage (documented, repeatable procedures are a competitive/operational advantage, not necessarily a legal trade secret in the strict sense) |
| Names listed in `TRADEMARKS.md` | Trademark (unregistered / registration status unverified) |
| Soberanía Protocol concepts consumed by reference (consent, capability tokens, scoped access grammar) | Public specification (owned and governed separately by the Soberanía Protocol project, not by this repository) |
| Empty stub packages (`consent-engine`, `capability-tokens`, `scoped-access`, `identity`, `audit-sdk`) | Not currently protected — no original expression exists yet to protect |
| Third-party dependencies | Not applicable — owned by their respective upstream authors |

No claim of trade secret status is made for information that is already
public (e.g., material already described in public documentation,
published specifications, or open source dependencies).
