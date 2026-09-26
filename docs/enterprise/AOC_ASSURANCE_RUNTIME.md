# Frontera Systems Assurance Runtime v1 (PR-007)

The Assurance Runtime evaluates whether a subject satisfies explicit,
versioned Assurance controls with sufficient, verified evidence.

```
The Kernel evaluates whether an action may proceed.
The Governance Store preserves what happened.
Evidence Bundles disclose relevant proof.
The Agent Passport identifies and contextualizes an agent across time.
The Assurance Runtime evaluates whether defined controls are satisfied by sufficient evidence.
```

## The Assurance Equation

```
Control Criteria + Verified Evidence + Defined Scope + Versioned Evaluation Method
  = Assurance Control Result
```

No control passes because documentation claims it, a developer says so, a UI
displays it, a module has a reassuring name, a test file exists, a company
self-declares, an LLM generates a convincing explanation, a Passport is old,
or many actions happened without obvious failure. Every result names the
framework/version, subject, scope, control, criteria, evidence considered,
evidence rejected (with stable reason codes), the deterministic result, the
findings produced, the scoring impact, and the evaluator version.

## Architecture

```
Assurance Framework Registry
        │
        ▼
   Assessment Scope (immutable)
        │
        ▼
   Control Selection
        │
        ▼
   Evidence Resolver ──► Governance Records / Evidence Bundles /
        │                Agent Passports / Runtime Health / Attestations
        ▼
   Control Evaluators (deterministic)
        │
        ▼
   Findings ──► Domain Assessments ──► Scoring ──► Eligibility
        │
        ▼
   Continuous Assurance State (derived)
        │
        ▼
   Verifiable Assessment Record (immutable once completed)
```

Package: `src/enterprise/assurance/` — contracts, framework
validation/registry, `saf-framework.ts` (the built-in `aoc.saf` 1.0.0),
evidence resolver, metric derivation, control evaluator, findings, scoring,
eligibility, assessment lifecycle/integrity, verification, signals, reports,
in-memory + SQLite stores, and the `AssuranceService` orchestration surface.

## What it is / is not

It **is**: a versioned framework registry, a control-definition runtime, an
evidence-requirement engine and resolver, a deterministic control evaluator,
a findings engine, a domain-assessment engine, a transparent scoring engine,
an eligibility evaluator, a continuous-signal processor, an append-oriented
assessment history, a verification service, and a structured report
foundation.

It is **not**: the Kernel, governance enforcement, a statutory auditor, a
legal opinion, a certification authority, a SOC 2/ISO/PCI/HIPAA issuer, an
opaque ML evaluator, a universal trust score, a reputation ranking, a
remediation executor, a guarantee against future incidents, a replacement
for independent human review, or a generalized GRC suite.

## Determinism

For the same framework version, control definitions, assessment scope,
evidence set, evaluator version, and scoring configuration, every result is
identical. There is no wall-clock inside evaluation (evidence-age checks use
the scope's `evidenceCutoffAt`), no randomness, and no model inference.
Boolean/threshold criteria read only from metrics derived from **accepted
evidence** (`metrics.ts`); a metric that cannot be derived is absent and the
control evaluates `unknown` — never silently false.

## Status discipline

Six statuses: `pass`, `partial`, `fail`, `unknown`, `not_applicable`,
`manual_review_required`. `unknown` is never converted to `fail`;
`manual_review_required` is never converted to `pass`; `not_applicable`
exists only through framework-defined applicability rules with structured
justification. Contradictory evidence follows the requirement's deterministic
contradiction policy (`fail` / `manual_review` / `unknown`).

## Assessment lifecycle

```
created → collecting_evidence → evaluating ─┬─ manual_review (→ evaluating)
                                            ├─ completed  (immutable)
                                            └─ failed     (immutable)
```

A completed assessment is immutable. Changed evidence, scope, or framework
version requires `requestReassessment()`, which creates a new assessment that
references and — only upon its own completion — supersedes the prior one
(store-level bookkeeping outside every digest). Continuous signals derive
staleness and state; they never rewrite history.

## Enterprise integration

- Module `aoc.enterprise.assurance` (optional by default;
  `AOC_ENTERPRISE_ASSURANCE_REQUIRED=true` makes it required). An Assurance
  outage degrades Enterprise without blocking `POST /api/governance/evaluate`.
- Composition: `enterprise.assurance` (service), `enterprise.assuranceStore`,
  `enterprise.assuranceFrameworks` (frozen registry).
- Store: independent in-memory or SQLite
  (`AOC_ENTERPRISE_ASSURANCE_SQLITE_PATH`, default `.data/assurance.sqlite`).

## HTTP APIs (internal; Enterprise resolves the access context)

| Endpoint | Purpose |
| --- | --- |
| `POST /api/assurance/assessments` | create an assessment (201) |
| `GET /api/assurance/assessments/{assessmentId}` | read an assessment |
| `POST /api/assurance/assessments/{assessmentId}/evaluate` | collect evidence, evaluate controls, attempt completion (`{"complete": false}` to skip completion) |
| `POST /api/assurance/assessments/{assessmentId}/verify` | independent verification (200 valid / 409 invalid) |
| `GET /api/assurance/assessments/{assessmentId}/findings` | findings with event-folded statuses |
| `POST /api/assurance/findings/{findingId}/events` | append a finding lifecycle event |
| `POST /api/assurance/manual-reviews` | record an attributable manual review |
| `POST /api/assurance/signals` | submit and process a continuous signal |
| `GET /api/assurance/subjects/{subjectId}/state` | derived continuous state |
| `POST /api/assurance/subjects/{subjectId}/reassess` | request a reassessment |

A failed control is a valid assessment result (HTTP 200), never an HTTP
error. Error taxonomy and mapping: `AOC_ASSURANCE_OPERATIONS.md`.

## Boundaries (enforced by design and tests)

Kernel, Governance Store, Evidence Runtime, and Passport Runtime never import
Assurance; Assurance consumes only their public contracts. Assurance
evaluators execute no SQL; HTTP controllers calculate no scores; framework
definitions carry no executable code; reports never mutate assessments;
eligibility never modifies Passport state; signals never rewrite historical
assessments.

## Related documents

`AOC_ASSURANCE_FRAMEWORK_MODEL.md`, `AOC_ASSURANCE_CONTROL_MODEL.md`,
`AOC_ASSURANCE_EVIDENCE_MODEL.md`, `AOC_ASSURANCE_FINDINGS.md`,
`AOC_ASSURANCE_SCORING.md`, `AOC_ASSURANCE_ELIGIBILITY.md`,
`AOC_CONTINUOUS_ASSURANCE_SIGNALS.md`, `AOC_ASSURANCE_OPERATIONS.md`,
`AOC_SAF_V1_RUNTIME_MAPPING.md`, `AOC_ASSURANCE_CURRENT_MODEL.md`,
`ASSURANCE_STORE_MIGRATION_V1.md`,
`../architecture/ADR-ASSURANCE-RUNTIME.md`.

## Known limitations (v1)

Assurance Runtime v1 does **not** provide: statutory certification, legal
compliance opinions, independent auditor status or auditor independence,
external assessor signatures, regulatory accreditation, ISO certification,
SOC 2 report issuance, PCI or HIPAA certification, legal filings, digital
certificate issuance, non-repudiation, an external timestamp authority,
blockchain anchoring, zero-knowledge proofs, automatic remediation,
enforcement, opaque AI scoring, predictive risk analytics, a universal trust
score, cross-enterprise reputation, a public certification marketplace, a
distributed Assurance Store, complete external-evidence ingestion,
jurisdiction-specific legal conclusions, or any guarantee of future
compliance.
