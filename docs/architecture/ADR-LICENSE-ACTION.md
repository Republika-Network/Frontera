# ADR: `LICENSE` as a governed action, and what the third enforcement taught us

- Status: accepted
- Supersedes: nothing
- Related: `docs/architecture/ADR-TOKENIZE-CAPABILITY.md`,
  `docs/architecture/ADR-COLLATERALIZE-ACTION.md`,
  `docs/architecture/ADR-GOVERNANCE-REFERENCE-INTEGRITY.md`,
  `docs/architecture/ADR-ENTERPRISE-ENFORCEMENT-VOCABULARY.md`
- Reference: `docs/enterprise/AOC_LICENSE_ACTION.md`

## Context

Frontera Systems had two verified governed actions — `TOKENIZE` (authorizing an
external *representation* of governed rights) and `COLLATERALIZE` (authorizing
governed rights to be committed as *security* for an obligation) — plus the
`authorization_artifact` classification and the Governance Reference Integrity
mechanism.

Two implementations are enough to notice a shape and not enough to know whether
it is real. Structural similarity between two siblings is weak evidence: the
second was built with the first in view, and TypeScript shapes that match
prove nothing about whether the *domains* match.

`LICENSE` was chosen as the third enforcement deliberately, because it is the
one that could most plausibly *break* the emerging pattern:

- it grants **permission to exercise** rather than representing or encumbering;
- it has a **beneficiary who is not a counterparty to an obligation**;
- it may have **no external performer at all**;
- and its natural notion of "scope" is not obviously a fraction of anything.

The question this ADR answers is not "ca Soberanía govern licensing?" — it plainly
can, through machinery that already exists. It is: **what did implementing it
concretely reveal about which vocabulary genuinely belongs to Frontera Systems?**

## Decision

Introduce `LICENSE` as a third Enterprise Governed Action, implemented
concretely and durably through the existing enforcement machinery, with **no
new orchestration engine and no generic framework**, and with four deliberate
departures from its siblings where the domain demanded them.

### Domain meaning

> Authorize the grant of a defined permission to a defined licensee to exercise
> specified governed rights associated with an already-governed asset, for
> specified uses, within a specified operating context, under defined
> governance conditions.

### Boundary

Soberanía authorizes the governed licensing action. It does not claim the license is
legally enforceable, that formalities were satisfied, that consideration
passed, that royalties or tax were settled, that copyright subsists, that a
patent is valid, that a trademark is registered, that the right is legally
licensable, or that any contract was signed. Those require independent external
evidence, and even then Soberanía has preserved a *report*, not verified a fact.

**Crucially: the existence of a `LicenseMandate` is not a claim that a license
exists.** Until execution evidence is recorded, Soberanía's position is that it
authorized the grant and does not know whether the grant was made.

### Why LICENSE belongs in Enterprise, not Protocol

Everything `LICENSE` needs is Enterprise-local governance state: an asset the
tenant already governs, an authority graph, a policy state, an approval state,
an obligation set, a durable mandate, and evidence rows. Nothing crosses an
independent sovereignty boundary. `LICENSE` is emphatically **not** a Protocol
Sovereignty Capability and not a ninth capability of any kind.

### Authority model

Unchanged and unextended: Recognition Runtime → Authority Graph → Kernel. No
licensing-specific authority engine exists. Authority remains scoped to the
asset, a requester never gains authority by submitting a request, and
`approval_required` never produces a mandate.

### Licensee semantics

`licenseeRef` is required and is a **fourth distinct role**, never collapsed
into the requester, the asset authority, the approver, or any executor.

Identity binding is the default and the safe direction: an execution naming a
different licensee is refused. The single exception is
`constraints.assignment === 'permitted'` — a license the licensee may assign to
anyone the moment it exists is one whose licensee identity the authorization
did not meaningfully bind. `approval-required` keeps the binding, because the
further approval is exactly what has not happened.

### Rights model

The five-category governed-right vocabulary is reused *unchanged*, and this was
a finding rather than a default. The vocabulary names **which governed right of
the asset an action concerns** — a property of the asset's rights, not of the
action applied to them. Representing a right, encumbering it, and permitting
its exercise all select from the same set.

`ownership-interest` is deliberately not excluded: licensing an ownership
interest records that the permission draws on it, and `LICENSE != TRANSFER`
still holds throughout.

### Rights scope vs permission scope — the central finding

**They are two different concepts, and `LICENSE` proves it.**

`TOKENIZE` and `COLLATERALIZE` both *require* a scope because representing or
encumbering a right is inherently a question of how much of it. A permission is
not. *"Company B may display this work on its website for 12 months"* is a
completely specified license containing no fraction of anything.

`rightsScope` is therefore **optional**, and absence means *"not expressed as a
portion of the named rights"* — **not** "100%". Forcing every license to assert
10000 basis points would make the contract state a claim about the rights that
the licensor never made.

The two are incommensurable and every comparison fails closed rather than
coercing: a mandate that expressed no portion refuses an execution that asserts
one, and a mandate that expressed one refuses an execution that omits it. This
is the same fail-closed posture `enterpriseCollateralizationScopeWithin` takes
across scope *kinds*, lifted one level up to presence itself.

When a license *is* fractionally expressed, the identical integer basis-point
containment applies — no floating-point arithmetic for economically significant
fractional rights, and escalation refused across persistence and restart.

### Executor decision — optional, and that is the point

**`executorRef` is optional.** This is the departure with the largest
architectural consequence.

`TOKENIZE` and `COLLATERALIZE` necessarily have an external performer: someone
must mint the token, someone must create the security interest. Licensing does
not — a licensor granting directly has no separate executor, while one working
through a licensing platform or rights administrator does. Both are ordinary,
and neither is a degenerate case of the other.

Requiring an executor would force every direct license to invent a party, and
an invented party binding protects nothing. When present it binds strictly;
when absent, `execution.executedBy` is recorded as an observation that
constrains nothing.

### Constraints model

Permitted uses are a closed, provider-neutral, asset-neutral vocabulary of
Soberanía's *own* governed-use categories — explicitly not statutory definitions and
not any jurisdiction's exclusive-rights enumeration.

`prohibitedUses` lives in immutable terms rather than in obligations, and is
not redundant with the allow-list: an allow-list cannot express a carve-out
*inside* a broad grant ("commercial use, but never model training"). A use may
never appear in both; that state is rejected at validation as unrepresentable.
Behavioural requirements (attribution, reporting, payment evidence) remain
**obligations** — terms carry what the license *is*, obligations carry what
someone must *do*.

Operating context is a map from an opaque **dimension** label to an opaque
allow-list, not a `territories` field. Territory is not the universal root
concept: for software the context may be an environment, for content a channel,
for data a market. Hard-coding geography would make every non-geographic
license misrepresent itself. This also avoided building a large license DSL.

Exclusivity is a three-level rank (`non-exclusive` < `sole` < `exclusive`)
because `sole` is a real arrangement a boolean cannot express. It is **recorded
and compared, never enforced as universal law** — nothing here concludes that
an asset may carry only one license or that an exclusive grant blocks others.
That is a policy question, and policy receives the full serialized terms.

Sublicensing and assignment are required dispositions because silence is
exactly the ambiguity a governed authorization exists to remove. No
`SUBLICENSE` or `ASSIGN_LICENSE` action is introduced.

`maximumLicensedUnits` is a **per-license ceiling and deliberately not
cumulative** — see the enforcement-vocabulary ADR for why this is a genuine
semantic difference from collateral scope rather than an omission.

### Revocation vs external termination

Revocation withdraws authority to grant *further* licenses. It does not
terminate a license already granted; Soberanía is not a party to the agreement and
cannot erase external state it does not control. The revocation record
preserves `executionsAtRevocation` as immutable proof the authorization had
been exercised.

An externally-reported end is *evidence*
(`expired` | `terminated` | `cancelled` | `surrendered` | `superseded`), never a
mandate status and never a governed action. It does not decrement the execution
count: doing so on an unverified report would manufacture fresh licensing
capacity. Reports arriving after authority lapsed are accepted deliberately.

This model was adopted because `COLLATERALIZE` had already proven it with
release/discharge evidence, and it fit `LICENSE` cleanly with no lifecycle
redesign — so §49's "add a minimal evidence contract if it fits cleanly"
applied rather than its deferral branch.

### Persistence, authorization_artifact, reference integrity

In-memory and SQLite stores shipped together, held to identical semantics by a
shared behavioural contract suite. The `TOKENIZE` memory-first gap is not
repeated.

The mandate is classified `authorization_artifact` and sealed through the
canonical `appendReference` path. No license-specific integrity code exists;
sequence, integrity version, chain link and digest are all Store-computed
inside its own transaction.

## Generalization findings

Recorded in full in
`docs/architecture/ADR-ENTERPRISE-ENFORCEMENT-VOCABULARY.md`. In summary:
`LICENSE` **confirmed** that the governed-right vocabulary, the mandate
reference skeleton, the validity/revocation metadata and the execution-evidence
envelope are semantically identical across three independent domains, and
**refuted** the hypotheses that executor binding is universal, that rights scope
is always required, and that a quantity ceiling always accumulates.

No generic primitives were extracted in this change, and no enforcement
framework was created. The behavioural machinery is already shared; what
remains duplicated is *vocabulary*, and extracting it would require a
dependency edge into two frozen contract packages for a declarative benefit.

## Protocol recommendation

**No Protocol change is required or justified.** `LICENSE` produced no
requirement that cannot remain entirely within Enterprise. Ideas such as
governed permission lineage, license lineage and rights delegation lineage were
considered and deliberately not implemented: none of them appeared as a
*requirement* in the implementation, and the threshold — a relationship or
evidence that must cross independent sovereignty boundaries — was never
reached.

## Known limitations

- Soberanía preserves external reports; it does not verify them. Execution evidence
  is someone else's claim, correlated and sealed.
- The privileged-writer limitation is unchanged and remains deferred: a writer
  able to rewrite data, digests, chain links and heads together can defeat
  local tamper detection.
- No conflict engine. Whether an exclusive grant should block a later request
  is left to policy, which can see prior mandates and evidence.
- `@aoc-enterprise/license-mandate` is not yet on the published
  `@aoc-enterprise/runtime` surface, matching its two sibling packages.

## Alternatives considered

- **Require `executorRef` for symmetry.** Rejected: it would force direct
  licenses to invent a party, and would have manufactured a false confirmation
  of the "generic executor binding" hypothesis — the opposite of what a third
  enforcement is for.
- **Require `rightsScope`, defaulting to 10000 basis points.** Rejected: it
  makes the contract assert a claim about the rights that the licensor never
  made, and would have falsely confirmed `GovernedRightsScope` as universal.
- **Model `territories` directly.** Rejected as asset-class encoding; the
  dimension map covers geography without privileging it.
- **Accumulate `maximumLicensedUnits` like collateral scope.** Rejected: seats
  granted to different licensees exhaust nothing about the asset, and reusing
  the machinery would have hidden a real semantic difference.
- **A boolean `exclusive` flag.** Rejected: cannot express `sole`.
- **Reuse `EnterpriseCollateralizationScope` by import.** Rejected for the same
  compatibility reasons the tokenization/collateralization duplication was
  recorded rather than shared.
- **Build a generic enforcement framework now that there are three.**
  Rejected — see the enforcement-vocabulary ADR.
