# ADR: AI may interpret, recommend and explain — it may never authorize

- Status: accepted (architecture only — **no implementation performed**)
- Related: `ADR-AUTHORITY-CONTROL-LAYERING.md` (layer G),
  `ADR-CONTEXT-PROVENANCE-AND-TRUST.md`, `ADR-ASSURANCE-RUNTIME.md`,
  `ADR-EVIDENCE-BUNDLE.md`
- Scope: `packages/advisory-contracts` (new),
  `src/features/intelligence-advisory` (new), and a structural boundary over
  `src/kernel/`, `src/features/action-enforcement/`,
  `src/features/domain-policy-pack-runtime/`,
  `src/features/context-resolution-runtime/` (new)
- **A prohibition with a mechanism.** Not an AI feature. Not a model
  integration. Not a prompt framework. This ADR adds no model call anywhere; it
  decides where one may ever live.

## Context

Frontera today contains no model call, anywhere. That is not an accident of
scope — it is asserted in prose across at least a dozen modules
(`recognition-runtime/README.md` §"Why this is deterministic, not an LLM";
`evidence-source-runtime/README.md` "No LLM evaluates evidence or interprets a
law, contract, policy, invoice"; `assurance/report.ts` "no LLM sits anywhere in
this pipeline") and pinned by determinism tests that assert the absence of
network calls, LLM calls, OCR, `Math.random()` and argless `new Date()`.

What does not exist is an architectural statement. The prohibition is currently
distributed across a dozen README paragraphs and a set of per-module tests. That
arrangement holds exactly until someone adds a thirteenth module, and it offers
no guidance at all on the question the product roadmap actually raises: AI is
wanted — for explanation, for drafting policy, for surfacing anomalies, for
narrating a simulation. Where may it go?

Without a stated boundary, the first such feature is negotiated in a pull
request, by whoever is reviewing that day.

## Decision

### 1. The rule

**AI may interpret, recommend, explain, detect signals, summarize, narrate, and
propose policy. AI may never be the final authorization authority.**

Final authorization and enforcement remain deterministic, inspectable,
testable, reproducible and fail-closed.

### 2. What that means, stated as five prohibitions

No AI output may:

1. **be a decision.** `KernelDecisionStatus` is produced by `AocKernel` from
   typed records and a clock. Nothing else, ever.
2. **be a fact policy reads.** A model-produced value is not a `ContextFact` of
   any trust class. There is no path by which an inference becomes
   `authoritative`, `attested` or `derived`. It is not `asserted` either — it is
   simply not context.
3. **discharge an obligation.** A model cannot mark `require-mfa`,
   `require-approval` or `require-acceptance` satisfied.
4. **issue, widen, extend or revoke a grant.**
5. **reach the Kernel by any route.** Including transitively, including through
   a store, including through a "pre-computed score" written by a model earlier.

### 3. What AI may produce: an `Advisory`

One shape, addressed to humans:

```
advisoryId
kind        'explanation' | 'recommendation' | 'signal' | 'summary'
            | 'policy_draft' | 'simulation_narrative' | 'anomaly'
subject     what it is about (a decision id, a pack id, a time window)
content     text and structured annotations
provenance  producer, model identity, version, generatedAt, inputs cited
confidence  optional, and explicitly not a threshold anything acts on
```

`Advisory` carries **no** allow, no deny, no score that maps onto an outcome, no
severity that any enforcement path reads. This is a type-level property. A
component cannot accidentally act on an advisory because there is nothing on it
to act on.

### 4. The boundary is structural, not a review convention

Three mechanisms, in increasing strength:

1. **Type shape.** `Advisory` has no decisional field. A model output cannot be
   passed where a `ContextFact`, a `PolicyEffect` or a `KernelEvaluationResult`
   is expected.
2. **Import boundary.** No module under `src/kernel/`,
   `src/features/action-enforcement/`, `src/features/domain-policy-pack-runtime/`
   or the context resolution runtime may import from
   `src/features/intelligence-advisory/` or `@aoc-enterprise/advisory-contracts`
   — enforced by a check in the `scripts/lint-architecture.mjs` family, which
   already enforces "no explicit `any`" and "no wildcard exports in runtime
   internals" the same way.
3. **Determinism tests.** Every decision-path module keeps and extends the
   existing determinism assertions.

The reason for three rather than one: a type rule stops the obvious mistake, an
import rule stops the clever one, and a determinism test stops the accidental
one.

### 5. Policy drafting is the interesting case, and it is allowed

A model may draft a policy pack. That draft is an `Advisory` of kind
`policy_draft`. It becomes policy only when a human with authority reviews it
and promotes it through the existing, unchanged `PolicyPackValidator` and
versioning path — at which point what is running is a validated, versioned,
human-authorized pack whose evaluation is as deterministic as any other.

The boundary is not "AI may not touch policy". It is **"AI may not be the
authority that puts policy into force."** The provenance of the draft is
recorded on the pack version, so an auditor can see that version 7 originated
from an advisory and was promoted by a named human at a named time.

### 6. Explanation is allowed, and is not the decision

A model may explain why a decision came out as it did. The explanation is an
`Advisory`, not the decision's reason. `KernelEvaluationResult.reasonCodes`,
`summary` and `trace` remain deterministic outputs of the Kernel, and they
remain what evidence carries and what verification digests bind.

Rejected: letting a model author `summary`. It is inside the governance record,
inside the digest, and inside every evidence bundle — a non-reproducible field
there would break the reproducibility guarantee that makes those digests worth
anything.

### 7. Anomaly detection may surface, never gate

A model noticing that a vendor's spend pattern changed produces a `signal`
advisory for an operator. It does not raise a risk level, does not add an
approval requirement, and does not deny. If a deployment wants a detected
pattern to affect decisions, the path is: the signal informs a human, the human
authors a deterministic rule, the rule decides. That round trip is the control,
and shortening it is the failure mode this ADR exists to prevent.

### 8. Advisories are recorded, and are never evidence of authorization

Advisories are stored and disclosable, with their producer and model identity in
provenance. They appear in evidence as advisories — a record that something was
suggested — never as a step in the decision's trace, and never inside the
digests that bind a decision.

## Hard invariants

1. `AocKernel` is the only producer of a decision. Unchanged.
2. No advisory type carries a decisional field.
3. No import path exists from advisory modules into the decision path.
4. No model output is ever a `ContextFact`, at any trust class.
5. A policy pack reaches force only through human promotion and existing
   validation.
6. `reasonCodes`, `summary` and `trace` are deterministic and reproducible.
7. Removing every advisory producer changes no decision, anywhere. This is the
   test that settles any future argument about whether something belongs in G.

## Consequences

**Gained.** A place for AI that is genuinely useful — explanation, drafting,
detection, narration — with a boundary that a reviewer does not have to
re-derive. A prohibition that survives the thirteenth module. An answer to the
enterprise procurement question "is an AI deciding this?" that is a test rather
than a promise.

**Not gained, deliberately.** No AI-assisted authorization, no adaptive policy,
no learned thresholds, no model-scored risk feeding an outcome, no automatic
promotion of a drafted pack. Each is a real product idea and each is
incompatible with a decision an auditor can reproduce.

**Costs.** Some genuinely convenient features are foreclosed. An operator who
wants an anomaly to gate an action must write a rule, which is slower. Invariant
7 must be maintained as a real test, not a stated intention.

## Alternatives rejected

| alternative | why not |
| --- | --- |
| AI decides, with a human review queue for low-confidence cases | the high-confidence cases are then decided by a model, and reproducibility is gone for exactly the decisions nobody looks at |
| AI proposes a decision that policy may override | a proposal that policy usually accepts is a decision; and the override rule would itself have to be deterministic, at which point the proposal is redundant |
| AI-produced facts admitted at a low trust class | trust class is about *who says so*; an inference has no source of record. Admitting it would make `derived` inheritance meaningless |
| A model-scored risk level feeding `PolicyRiskLevel` | risk level feeds effects; a non-reproducible input to a reproducible chain makes the whole chain non-reproducible |
| Let a model author `summary` only | `summary` sits inside the aggregate digest and every evidence bundle; a non-reproducible field there voids the verification guarantee |
| Prose prohibitions in READMEs, as today | measured as insufficient: twelve modules each restating it, no guidance for the thirteenth, and no mechanism at all |
| A runtime feature flag to allow AI decisions | a flag that can be turned on is a capability that exists; the guarantee has to be structural to be worth stating |
