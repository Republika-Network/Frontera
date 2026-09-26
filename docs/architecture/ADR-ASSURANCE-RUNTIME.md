# ADR: Frontera Systems Assurance Runtime v1 (PR-007)

Status: Accepted

## Context

- The platform already evaluates (Kernel), records (Governance Store),
  discloses (Evidence Bundles), and identifies (Agent Passports), preserving
  governed history end to end.
- Governance Records preserve durable internal truth; Evidence Bundles
  provide controlled portable evidence; Passports preserve identity and
  governed history — and all three carry deliberate, reserved
  forward-references to a not-yet-existing Assurance artifact
  (`assurance_record`, `assurance`).
- SAF exists in this repository as implemented concepts and doctrine, not as
  standalone SAF-001/002/003 documents (see
  `docs/enterprise/AOC_ASSURANCE_CURRENT_MODEL.md`): the governance-level
  ladder whose `'certified'` rung no engine ever earned, evidence
  requirement/review/risk primitives, claim-safety prohibitions on
  certification wording, and the Passport's "no trustScore without a
  governed, documented, explainable methodology" rule.
- Enterprise lacked a runtime that evaluates whether defined controls are
  satisfied by sufficient evidence: control evaluation, findings, scoring,
  eligibility.
- Existing public numeric artifacts (negotiation trustDelta, registry
  percentages) are manual or product-specific and were never
  evidence-derived assurance scores.
- A universal trust score would be misleading and is prohibited by the
  repository's own doctrine.

## Decision

Implement the Assurance Runtime as a bounded Enterprise capability
(`src/enterprise/assurance/`):

- versioned, immutable-once-active Assurance frameworks in a registry that
  freezes at startup; the first framework (`aoc.saf` 1.0.0) is translated
  from the repository's implemented SAF concepts with a documented mapping;
- explicit evidence requirements resolved into accepted/rejected evidence
  *references* (never copies) with stable rejection reason codes and
  deterministic contradiction policies;
- deterministic control evaluation over metrics derived exclusively from
  accepted evidence, preserving `unknown` and `manual_review_required` as
  first-class states (never silently converted);
- append-oriented findings with rule-based severity and an event-sourced
  lifecycle that never overwrites history;
- transparent scoring owned by the framework, with per-control and
  per-domain calculation traces and blocking controls that override numeric
  averages;
- eligibility profiles distinct from certification, with named blocking
  controls/findings and reason codes; provisional states only where the
  framework allows them;
- immutable completed assessments with SHA-256 section digests (reusing
  `aoc.canonical-json.v1`), reassessment as a new superseding assessment,
  and store-level supersession bookkeeping outside every digest;
- continuous signals that derive staleness and state without rewriting
  history, and that recommend (never execute) reassessment;
- an independent append-oriented Assurance Store (in-memory + SQLite, one
  shared contract suite, tenant-isolated, no general update/delete API);
- internal verification that recomputes every digest and independently
  reproduces domain scores, the overall score, and eligibility;
- canonical JSON reports with INTERNAL/AUDITOR/CUSTOMER/PUBLIC projections
  and their own digests;
- an optional-by-default Enterprise module, HTTP APIs, telemetry, events,
  and structured logging;
- no LLM anywhere in the evaluation or reporting path (narratives are
  deterministic restatements of structured results);
- existing public products preserved untouched for compatibility.

## Positive consequences

Explainable Assurance results; end-to-end evidence traceability;
deterministic, reproducible scoring; defensible findings; framework
versioning; continuous-assurance readiness; a foundation for future external
audit support; stronger product differentiation grounded in real evidence.

## Negative consequences

Significant model complexity (frameworks, controls, criteria, resolutions,
findings, scores, eligibility, signals); evidence-resolution dependencies on
three other stores and runtime health; more storage (a fourth independent
store); manual-review operational requirements; framework maintenance and
versioning discipline; migration complexity for any future product
integration; stricter claims discipline everywhere Assurance results
surface.

## Rejected alternatives

- Hardcoded dashboard scores — exactly the overclaim the claim-safety rules
  prohibit.
- One universal trust score — misleading; prohibited by Passport doctrine.
- LLM-only assessment — non-deterministic, non-reconstructable, prohibited.
- Self-certification without evidence — violates the Assurance Equation.
- Automatic enforcement (blocking actions, suspending Passports, mutating
  policy) — the Kernel decides; Assurance evaluates.
- Mutable completed assessments — destroys reconstructability.
- Immediate statutory certification — legal claims without legal basis.
- Turning Passport history into reputation — explicitly prohibited.
- A generic GRC platform — unbounded scope.
- Arbitrary executable framework logic — code injection into the trust base.
