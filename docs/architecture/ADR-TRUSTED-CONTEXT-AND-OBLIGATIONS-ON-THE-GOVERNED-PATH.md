# ADR — Trusted Context & Obligations on the Governed Path (CORE-04)

- **Status:** Accepted (CORE-04, 2026-09-28)
- **Roadmap item:** CORE-04 — Trusted Context & Obligations on the Governed Path, `docs/architecture/FRONTERA-MASTER-PLAN.md` §9
- **Answers:** Master Plan §16 OQ-3 (admitted half), OQ-4, OQ-5, OQ-14 (pack half); the CORE-04 half of the §7 "Obligations" and "Advisory vs RiskSignal" rows
- **Builds on (unchanged in substance):** `ADR-CONTEXT-PROVENANCE-AND-TRUST.md` (layer C), `ADR-OBLIGATION-DISCHARGE-AND-BOUNDED-GRANT.md` (layer D, the six-state lifecycle), `ADR-GOVERNED-ACTION-SEMANTIC-PARAMETER-MODEL.md` (CORE-03), `ADR-DETERMINISTIC-AUTHORIZATION-AI-BOUNDARY.md` (its prohibitions stand; §4.4.6 of the Master Plan narrows them only for restrict-only admitted facts)

## 1. Context

Before CORE-04 both layers existed and were tested, and neither was reachable
from a governed action:

| Capability | Before CORE-04 |
|---|---|
| Context resolution (layer C) | A Kernel port (`contextResolution`) with a source registry and trust classes. **Not composed** on the governed-action Kernel (built with `grants` only). Any registered source could answer **any** key; no organization scope; no provenance reference; a future-dated reading counted as fresh; floats admitted; the policy metadata bag carried stale and conflicted *values*; nothing bound the admitted context to the decision or the grant |
| Obligations (layer D) | A Kernel port (`obligations`) with the six-state lifecycle. **Not composed**. A closed, domain-named vocabulary (`finance.approval`, `second.signer`) declared deployment-wide; no durable discharge store and no trusted writer; a committed decision withheld for an obligation could **never** be issued afterwards (a retry replays the committed decision) |
| Governance Profiles (CORE-03) | Declared `materialFacts`; nothing admitted them |
| Non-financial lineage | Re-resolved at exercise **only for financial actions** |
| Caller context | `assertedContext` reached the Kernel as caller claims |

## 2. Decision

### 2.1 One Trusted Context Boundary

The existing `ContextResolutionService.classify` **is** the boundary — extended,
not duplicated. It is composed into the **one** grant-aware Kernel the
governed-action path evaluates through, per effective Governance Profile.

```
GovernedAction → trusted semantics (profile id@version#digest)
  → profile material + restrict-only fact classes → the profile's declaration
  → ContextProvider (retrieval; trusted in-process composition, confers no trust)
  → candidate readings
  → Trusted Context Boundary (admission, then freshness, conflicts, trust class)
  → admitted facts → deterministic policy (typed predicates) → Kernel decision
  → committed decision (context provenance + admitted-context digest + validUntil)
  → BoundedGrant (sourceDigest binds the digest; validity ≤ validUntil)
  → exercise → adapter → outcome
```

Admission, in order, per reading (each failure is a recorded refusal, never a fact):

| Check | Refusal reason |
|---|---|
| The cited source is configured | `source_untrusted` |
| The source has **authority to attest this fact class** | `fact_class_not_attested` |
| The source's organization, and any organization the reading claims, is the request's | `organization_mismatch` |
| The observation time is a valid instant, not after the resolution instant beyond declared skew (default 0, max 300 s) | `observation_time_invalid`, `future_dated` |
| The value is admissible (boolean, **safe integer**, bounded non-empty string) | `value_malformed` |
| An `attested` source produced an attestation reference | `attestation_missing` |
| A `reference-digest` source's reading carries a reference and a provenance digest that recomputes over the whole reading | `provenance_invalid` |

Then: repeated identical readings collapse deterministically; readings that
disagree are `conflicted` (never last-writer-wins); freshness is decided against
the strictest applicable bound; the declared minimum trust class is applied.

### 2.2 Source authority (authority to attest ≠ authority to authorize)

A `ContextSource` now carries `attests: [{factClass, maxAgeSeconds}]` —
**required and exhaustive**, no wildcard — an optional `organizationId`, and a
`provenance` requirement. On the governed path (`composeGovernedTrust`) every
source must be `authoritative` or `attested` (never `request`/`asserted`), must be
scoped to the served organization, must bound the freshness of every class it
attests, may attest only classes some profile declares, and is composed with
`provenance: 'reference-digest'`. Every declared fact class must have at least
one attesting source. The registry is immutable after composition (no runtime
mutation, no admin route — NB-008 is not repeated).

A profile declaring a fact *material* never makes a source trusted for it, and a
source trusted for a fact never authorizes anything: an admitted fact is an
input to deterministic organization policy, read through a typed predicate.

### 2.3 Freshness — one canonical owner

The source's per-class `maxAgeSeconds` is the canonical owner. A requirement's
bound and a reading's own bound may only **tighten** it (stricter wins; a
malformed self-stated bound is treated as already stale). The boundary is
exclusive: a reading exactly `maxAgeSeconds` old is stale. A stale fact is a
`stale` read — never satisfied, its value never offered to policy.

### 2.4 Material vs restrict-only facts (the admitted RiskSignal contract)

Profiles declare `materialFacts` (required) and `restrictiveFacts`
(restrict-only). No second requirement language:

| | Material | Restrict-only (admitted RiskSignal) |
|---|---|---|
| Absent | deny `CONTEXT_REQUIRED_FACT_UNRESOLVED` (or the refusal-specific code) | baseline — no effect |
| Stale | deny `…_STALE` | lapsed — baseline |
| Conflicted | deny `…_CONFLICTED` | **deny `CONTEXT_RESTRICTIVE_FACT_AMBIGUOUS`** |
| Resolver failed | deny | **deny** (no restriction can be ruled out) |
| Policy reads it as | `contextFact` | `restrictiveFact` — only in monotone position (no `not`, no negated operator), only by rules whose effect restricts (never `allow`/`no_op`); refused at pack validation |

A candidate signal is admitted on exactly the same terms as any fact (source,
fact-class authority, organization, provenance, freshness). Model confidence is
not part of admission and never reaches policy. CORE names the concept
generically ("restrict-only fact"); the Kernel intelligence-vocabulary ban stands.

**Monotonicity (OQ-14, answered for the pack half):** with restrict-only facts
removed, every decision equals the baseline; with them present, it is equal or
more restrictive. Structurally: (a) the policy pack cannot grant — an `allow`
result only *passes* the one policy of thirteen, it never overrides another's
denial; (b) the validator makes a widening signal rule inexpressible; (c) grant
scope is projected from the request and the Kernel's decision only, never from
context (`sourceScopeFor`), so no fact can add an axis or widen a bound; (d) a
restrict-only fact never caps or extends validity. A Kernel-side check is not
added; the structural test and the Host monotonicity test stand in for it.

### 2.5 Policy integration

Policy receives admitted facts only, in two typed lists (`contextFacts`,
`restrictiveFacts`) with a single producer (the Kernel, from `satisfied` reads).
A missing, stale, conflicted, refused or under-trusted fact is **absent** — never
`false`, never a default. Raw `metadata` paths into `aoc.context` / `aoc.obligations`
are refused at validation. A proposed parameter may be compared with an admitted
fact (`valueFrom: {field: 'contextFact', factClass}`) — neither value overwrites
the other; an unadmitted comparand never matches.

Caller-supplied context cannot occupy a trusted-fact key: every declared fact
class (any case) and the `aoc.context`/`aoc.obligations`/`aoc.grant` namespaces
(any case) are reserved in `assertedContext` and refused before the Kernel runs.

### 2.6 Context materiality

The committed decision's `context` evaluation carries provenance (source,
reference, provenance digest, times — never values), the profile reference, the
**admitted-context digest** (`frontera.admitted-context.v1`: every admitted fact
*with its value*, every unresolved/stale/conflicted/refused key, the resolution
instant) and `validUntil` (the earliest admitted material fact's `staleAt`). The
Governance Record digests all of it.

`GrantSourceAuthorization` gains an additive, only-when-present `contextDigest`,
so the grant's `sourceDigest` — inside the grant's identity, digest and Ed25519
signature — commits to the exact admitted context. The signing domain is
unchanged (additive field, pre-CORE-04 sources keep their bytes). The decision's
`validUntil` joins the grant's validity ceilings as a `decision` ceiling, and the
orchestrator (the trusted issuer) proposes an expiry no later than it: **a grant
never outlives the facts it relied on**.

### 2.7 Time of check

| When | What is checked |
|---|---|
| **Admission** (inside `evaluate`, before policy) | Source identity, fact-class authority, organization, time validity, value, attestation, provenance; then freshness at the resolution instant, conflicts, trust class |
| **Decision** | Policy over admitted facts; required material facts not satisfied → deny; restrict-only ambiguity → deny; digest + `validUntil` + obligation state recorded and committed |
| **Grant issuance** | Grant source binds the context digest; validity ≤ `validUntil` (a stale-by-now decision cannot be issued); obligations **re-read** from the durable discharge store; P10 financial lineage (unchanged) |
| **Exercise** | Grant expiry (≤ `validUntil`), revocation (CORE-01), emergency control (P4), P7, **authority lineage for every action class** (new), typed bounds (CORE-03). Facts are **not** re-fetched (no network in CORE) |

Decision-time facts are snapshotted and bound; exercise-time validity is
enforced by the grant's lifetime cap, not by re-fetching. **TOCTOU (residual,
explicit):** a fact that becomes false before its `staleAt` is not detected
until then; the window is the source's `maxAgeSeconds`, chosen by the
organization per fact class. A restrict-only fact admitted *after* a grant was
issued does not affect that grant; revocation and emergency stop are the
mechanisms, and the grant lifetime (≤ 1 h on the Host) bounds it.

**Source trust change:** the registry is static configuration. Removing or
re-scoping a source takes effect for decisions made after restart; grants
already issued stay exercisable until their (context-capped) expiry. A
compromised source is contained by revoking the affected grants (CTRL-01) or an
emergency stop (P4). PKI for sources is not built.

### 2.8 Obligations — reused, reached, durable

**The existing lifecycle is reused unchanged**: six states, eight transitions,
satisfaction = `verified` | `waived`, transitions derived — never written — from
observations and each configured source's verification class (`independent` can
verify and waive; `self_reported` can at most report `discharged`, which never
satisfies). Justified changes:

- **Obligation kinds become declared identifiers** (the closed
  `finance.approval | second.signer` union was domain vocabulary in CORE). The
  two historical kinds remain valid identifiers.
- **Per-profile declaration**: a profile's `obligations: [{obligationType, blocking}]`.
- **A durable, authenticated discharge store** (`obligation-discharges.sqlite`,
  schema v2). A verified or waived discharge releases issuance, so the store is
  **authority-material** and its boundary is cryptographic (the CORE-01
  pattern): a hash chain over the whole append-only history, from a genesis
  bound to a random store id and the organization, whose head
  `{storeId, organizationId, sequence, chainDigest}` is signed by the
  deployment's authority signer under
  `frontera:authority-artifact:obligation-discharge-state:v1`. Every
  authoritative read (at open and before every issuance) verifies the
  signature and recomputes the chain; any failure refuses the store and leaves
  every blocking obligation unsatisfied. Triggers remain as defense in depth
  only. See §2.8.1. Reports are written only through an **in-process trusted writer**
  (`AocEnterprise.obligationDischarges.record({system: true, actorId}, …)`),
  attributed to that writer, citing a configured source; the input has no
  state/verified/satisfied field. No HTTP route, SDK method or CTRL-01 call
  reaches it.
- **Issuance-time re-read**: the committed decision records obligation state as
  it stood (an unmet blocking obligation withholds the *grant*, never rewrites
  the decision); a retry of the same request (same idempotency key → same
  committed decision, never re-made) is issued on the obligation state *now*.

#### 2.8.1 Why a signed state, not signed rows

Reproduced before the fix: a database-only writer inserted a row citing the
configured independent source, recomputed the unkeyed digest, and the canonical
Host executed the withheld action. Signing rows alone (Candidate A) would not
suffice: the lifecycle orders reports by observation time and refuses
`discharged → waived`, so *deleting* a genuine self-reported discharge could let
a genuine later waiver apply. Completeness of the set is part of the property,
so the whole history is committed (Candidate B). Store identity and organization
are inside the genesis, every row digest and the signed head, so a row or a head
copied from another store or organization fails; correlation
(`requestId`, `action`, `resourceScope`), source and outcome are inside each row
digest and therefore inside the signed chain. The unauthenticated v1 format
(never shipped) is refused, never upgraded; there is no unauthenticated durable
mode. The in-memory store (memory persistence only) keeps the same chain but
signs nothing — there is no database for a writer to reach — and the secure
profile refuses it.

**Write discipline.** An append never signs over unverified state: it verifies
the signed head and the exact row set, plans and signs the next head, then
re-verifies the whole history under the write lock and persists row and signed
head in one transaction. A genesis is created only for an empty file; missing
identity, head or tables refuse the store. Key rotation reuses the CORE-01 rule
(re-sign the unchanged, verified state under the active key at open). Details:
`docs/security/AUTHORITY_ARTIFACT_AUTHENTICITY.md` §27.

**Rollback.** A restore of an older genuine signed state after a restart is not
detected (CORE-07); an in-process witness refuses regression while the process
lives. The trusted writer records reports for one obligation of one decision in
strictly increasing observation time, so every committed prefix is a prefix of
the lifecycle sequence; a satisfied obligation is terminal, so a rollback can
remove satisfaction but never manufacture it.

**Gate source.** Whether an obligation applies at issuance is decided from the
trusted configuration of the request the server rebuilt (its effective
profile), never from the committed Governance Record's own `obligations` field,
which is integrity-only (§3.7 item 4 of the Master Plan).

Only pre-execution (issuance-gating) obligations exist; a non-blocking
obligation is recorded and gates nothing; outcomes and evidence never discharge
an obligation. Obligations are decision-bound through the correlation
`(requestId, action, resourceScope)` — `requestId` is server-derived from
organization, principal and idempotency key — so a discharge for one decision
never satisfies another. A withheld decision is issuable only within its grant
lifetime (anchored on the decision). Profile obligations carry no separate
deadline in CORE-04.

### 2.9 Lineage revalidation for every action class

The exercise gate re-resolves the actor's authority chain for the grant's action
and resource from the durable Kernel-Authority world and refuses
(`EXERCISE_CONTROL_AUTHORITY_BINDING_UNVERIFIABLE`) unless it is valid and every
hop is active and unexpired — for non-financial grants too (financial grants
keep P10's revalidation). Composed wherever P10's is.

### 2.10 Host composition

The governed-action file gains `trustedContext` (sources, skew) and
`obligations` (discharge sources), validated at startup against the served
organization and every profile. The **context provider** and the **policy** are
trusted in-process composition (`BootEnterpriseHostOptions.contextProvider`,
`.policyPackProvider`), like execution adapters. Composition refuses, before a
store opens: facts declared with no source registry, no provider or no policy;
a declared fact no source may attest; obligations declared with no discharge
sources. The secure profile refuses ephemeral obligations. `/health` posture adds
`trustedContext` (`composed`/`not-configured`) and `obligations`
(`durable`/`ephemeral`/`not-configured`). Compatibility: profiles that declare no
facts and no obligations need none of this and compose exactly as before.

## 3. Failure model

| Situation | Outcome |
|---|---|
| No reading for a required fact | denied `CONTEXT_REQUIRED_FACT_UNRESOLVED` |
| Only an unconfigured / unauthorized-for-class / other-organization source | denied `CONTEXT_REQUIRED_FACT_SOURCE_NOT_AUTHORIZED` |
| Stale | denied `CONTEXT_REQUIRED_FACT_STALE` |
| Invalid provenance / missing attestation | denied `CONTEXT_REQUIRED_FACT_PROVENANCE_INVALID` |
| Future-dated / invalid time | denied `CONTEXT_REQUIRED_FACT_TIME_INVALID` |
| Malformed value | denied `CONTEXT_REQUIRED_FACT_MALFORMED` |
| Conflicting trusted sources | denied `CONTEXT_REQUIRED_FACT_CONFLICTED` |
| Resolver failure / malformed output / store unavailable | `resolved: false`; required facts deny; restrict-only facts deny |
| Admitted but `false` / mismatching | policy decides (e.g. `INVOICE_NOT_FOUND`) |
| Obligation unsatisfied / store unreadable / tampered row | decision stands; grant withheld (`GRANT_OBLIGATIONS_UNSATISFIED`) |
| Lineage revoked after decision | exercise withheld, adapter never reached |

A required fact's denial comes from the Kernel acting on the profile's
declaration; a policy denial of an admitted `false` comes from organization
policy. A denial has one reason: when policy already denied, the context step
annotates and does not relabel.

## 4. Threat review

| Threat | Status | Mechanism / test |
|---|---|---|
| Caller-forged trusted context | Mitigated | Reserved keys (any case), single producer of policy facts; `governed-action-trusted-context-host` smuggling cases |
| Source spoofing (unconfigured id) | Mitigated | `source_untrusted` |
| Source overreach | Mitigated | `fact_class_not_attested`; §54 tests |
| Cross-organization source reuse / copied reading | Mitigated (single-org Host) | startup refusal + `organization_mismatch` |
| Fact-class confusion (material vs signal, case) | Mitigated | separate predicate families; case-fold uniqueness |
| Stale fact replay | Mitigated | per-class freshness; grant capped at `validUntil` |
| Future timestamp | Mitigated | `future_dated` |
| Provenance tampering in transit | Mitigated (integrity) | provenance digest recompute; **authenticity residual** (a connector-level attacker can recompute) |
| Conflicting trusted facts | Mitigated | `conflicted` → deny |
| Duplicate facts | Mitigated | deterministic de-duplication; digest order-independent |
| Reserved-key collision / nested smuggling | Mitigated | reservation + single producer |
| Model confidence as trust | Mitigated | not part of admission or policy input |
| Candidate signal bypass | Mitigated | same admission; `restrictiveFact` reads admitted only |
| RiskSignal authority expansion | Mitigated | validator + structural scope projection + Host monotonicity test |
| Policy mutation through context | Mitigated | context is input only; pack writes remain NB-008-gated |
| Obligation forgery / unauthorized discharge | Mitigated | trusted writer + configured source class; self-reported never satisfies |
| Obligation replay | Mitigated | decision-bound correlation |
| Discharge store tampering / forged satisfaction by a DB-only writer | **Mitigated (authenticity)** | signed chain head verified on every read; insert/alter/delete/reorder/transplant/re-sign-with-own-key refused (`obligation-discharge-authenticity.test.ts`, Host forgery E2E) |
| Discharge store rollback to an older genuine state | **Residual (CORE-07)**, bounded | in-process witness; time-ordered recording makes a rollback unable to manufacture satisfaction |
| Signing key or process compromise | **Residual (CORE-02)** | whoever holds the key can sign any state (AA-001) |
| Governance Record tampering (integrity-only, pre-existing) | **Residual (ASSURE-02)**, narrowed | the obligation gate no longer reads the record; the context digest is authentic once inside a signed grant |
| Context/decision digest mismatch | Mitigated | digest in committed record and in signed grant source |
| TOCTOU | **Residual, bounded** | §2.7 |
| Source revocation after issuance | **Residual, bounded** | §2.7; CTRL-01 revocation |

## 5. Residuals and owners

- **Security properties, separated.** *Authenticity:* the discharge store's
  committed state and every issued grant (with its context digest) are signed.
  *Integrity only:* the committed Governance Record, including its context
  evaluation (pre-existing, §3.7 item 4; ASSURE-02), and context provenance
  digests on readings (a connector-level attacker can recompute them).
  *Rollback:* not detected across restarts for either store (CORE-07).
  *Process/key compromise:* not addressed (CORE-02).
- **Provenance classification.** Context provenance is never read back from
  storage to admit a fact: admission happens in memory, at decision time, from
  the provider. The persisted context evaluation carries no values and cannot
  become an admitted fact; its digest is inside the signed grant's
  `sourceDigest`. What a Governance Store writer *can* still do is the
  pre-existing integrity-only residual (rewrite a committed decision before a
  grant is issued from it, e.g. its status or `validUntil`); bounded by the
  Host grant lifetime and every issuance/exercise gate, and owned by ASSURE-02.
- No exercise-time re-fetch of facts (by design); the window is `maxAgeSeconds`.
- Profile obligations have no own deadline; the grant lifetime bounds a withheld decision.
- Policy packs have no durable store or file format on the Host; policy is in-process composition (CORE-08 / CTRL-02).
- The shipped launcher composes no context provider and no policy: a file whose profiles declare facts refuses to start until an embedder supplies both (connectors: INTEL-04 / LDR).
- One organization per Host (no multi-tenancy invented).
- Discharge reports are recorded in-process only; a human operator surface belongs to CTRL-02 / CTRL-04.
- Non-blocking obligations and post-execution obligations are not enforced (none is modeled as gating).

## 6. Non-goals (kept)

No LLM, model, agent, embedding or vector store; no context retrieval from real
systems; no LDR dependency; no approval workflow (CORE-05); no human operators
(CTRL-02); no trust-administration API; no portable evidence (ASSURE).
