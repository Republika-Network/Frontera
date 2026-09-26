# ADR: Access Governance Lifecycle (R005.0)

- Status: **Accepted — Frozen**
- Deciders: Frontera Systems architecture
- Sequence: R005.0, Soberanía Architectural Consolidation Program
- Repository: `architects-of-change-protocol/aoc-enterprise` (Frontera Systems)
- Branch: `claude/access-governance-lifecycle-adr-0v93ka`
- Frozen at commit: `6f725fdc81a98af0120ee125fc43ba2a68285922`
  (merge of PR #85, `feat(access-governance): add EnterpriseEvidenceCorrelation
  canonical contract (R004.J)`)
- Related: `ADR-RESOURCE-ENVELOPE.md` (R004.D), `ADR-ACCESS-DECISION.md`
  (R004.E), `ADR-POLICY-OBLIGATION.md` (R004.F), `ADR-ACCESS-GRANT.md`
  (R004.G), `ADR-GRANT-REVOCATION.md` (R004.H), `ADR-USAGE-EVENT.md`
  (R004.I), `ADR-EVIDENCE-CORRELATION.md` (R004.J), `repo-boundaries.md`

## Role of this document

This ADR does not implement code. It freezes the canonical Access
Governance lifecycle that R004.D–R004.J already built, sequence by
sequence, as seven independent, immutable contracts. It is the single
document a future Provider Adapter implementer reads to understand the
whole shape of the lifecycle their adapter must plug into — without
having to reconstruct it from seven separate package READMEs.

No runtime, SDK, service, API, or Provider Adapter is implemented, renamed,
merged, or modified by this change. Every contract described here is
treated as canonical exactly as already implemented. Where this ADR's own
mandated inventory language (below) does not match an implemented type's
actual name, the implemented name wins and the mismatch is called out
explicitly — never silently renamed.

---

## Phase 1 — Repository Validation

| Check | Result |
|---|---|
| Repository | `architects-of-change-protocol/aoc-enterprise` |
| Branch | `claude/access-governance-lifecycle-adr-0v93ka` (pre-existing, checked out) |
| Working tree | Clean at time of writing (no untracked/modified files) |
| HEAD SHA | `6f725fdc81a98af0120ee125fc43ba2a68285922` |
| Last 7 sequence merges present on branch | R004.D `57cc2df`, R004.E `0fe2192`, R004.F `d3922bb`, R004.G `d4ee4b7`, R004.H `5005c5d`, R004.I `9833c9e`, R004.J `1aa72d2` |

All seven required input sequences are present, merged, and treated as
canonical for this ADR. No architecture branch creation was required — the
designated branch already exists and is the one this ADR is committed to.

---

## Phase 2 — Canonical Contract Inventory

Seven packages, each a single immutable, non-executable, provider-neutral
TypeScript contract with deterministic serialization, structural/identity
equality, and compile-time-enforced non-responsibilities
(`@ts-expect-error` negative test suites). None is wired into
`src/index.ts` or any public runtime export — by design, each has "no
runtime consumer yet."

A terminology note up front: this sequence's own task language refers to
the fourth contract generically as **"EnterprisePolicyObligation."** The
actual, already-implemented, canonical type is **`EnterpriseAccessObligation`**
(package `@aoc-enterprise/access-obligation`, R004.F). R004.F's own ADR
documents why: a type named `EnterprisePolicyObligation` already exists
(`@aoc-enterprise/policy-runtime`) and is a different, execution-shaped
concept (a policy engine's runtime instruction list), so naming a new,
immutable, declarative contract the same name would have been a collision,
not a rename. Per this ADR's own "do not rename" rule, `EnterpriseAccessObligation`
is used throughout as the canonical name; this table is the traceability
record for that mapping.

### 2.1 `EnterpriseResourceEnvelope` (R004.D)

`@aoc-enterprise/resource-envelope` · `packages/resource-envelope`

| | |
|---|---|
| **Responsibilities** | Describe where a governed external resource's bytes live (`location`), its content integrity at registration time (`integrity`), display/classification metadata (`descriptor`), and whether the underlying stored object still exists (`lifecycleState`). Compose Protocol's `ResourceRef` by reference for identity. Validate internal consistency; deterministic (de)serialization; identity equality derived from `ResourceRef` alone. |
| **Inputs** | `resource: ResourceRef` (Protocol), `location`, `integrity?`, `descriptor?`, `lifecycleState`, `registeredAt`, `correlationId?`, `schemaVersion` |
| **Outputs** | An immutable envelope record; `validateEnterpriseResourceEnvelope` result; serialized/round-trippable form; `resourceRefIdentityEquals` comparison |
| **Explicit non-responsibilities** | Provider credentials, API keys, bearer tokens, signed/temporary URLs, authorization headers, runtime clients, provider SDK types, business policy, approval state, revocation state, provider/network/existence validation, permission evaluation |

### 2.2 `EnterpriseAccessDecision` (R004.E)

`@aoc-enterprise/access-decision` · `packages/access-decision`

| | |
|---|---|
| **Responsibilities** | Record the immutable result of evaluating a request against a governed resource: who asked (`request.principalId`), against which resource (`resource`), what was decided (`outcome`), when (`evaluatedAt`), and a correlation id tying the record to the rest of an audit trail. |
| **Inputs** | `request: EnterpriseScopedAccessRequest` (composes Protocol `ScopedAccessRequest`), `resource: EnterpriseResourceEnvelope`, `outcome: PolicyDecision` (Protocol's `'allow' \| 'deny' \| 'conditional'`), `evaluatedAt`, `correlationId`, `reason?`, `policyEvaluationRef?`, `evidenceRefs?` |
| **Outputs** | An immutable decision record; `validateEnterpriseAccessDecision` result (including `RESOURCE_IDENTITY_MISMATCH` cross-check between `request.resource` and `resource.resource`); serialized form; identity equality over resource + principal + evaluation instant |
| **Explicit non-responsibilities** | Evaluating policy itself (no policy engine, no rule set), issuing a grant, provider credentials/URLs/SDKs, approval workflow state, revocation state, network/existence validation, policy-correctness evaluation |

### 2.3 `EnterpriseAccessObligation` (R004.F — mandated inventory name: "EnterprisePolicyObligation")

`@aoc-enterprise/access-obligation` · `packages/access-obligation`

| | |
|---|---|
| **Responsibilities** | Record a mandatory or optional condition attached to a decision (e.g. require MFA, watermark content, read-only, time-limit) — declaratively, never enforcing it. |
| **Inputs** | `id`, `type: EnterpriseAccessObligationType` (closed 8-value vocabulary), `mandatory: boolean`, `decisionRef: CanonicalId` (points at `EnterpriseAccessDecision.correlationId`), `severity?`, `parameters?` (JSON primitives only, credential-shaped keys forbidden), `description?`, `evidenceRefs?` |
| **Outputs** | An immutable obligation record; `validateEnterpriseAccessObligation` (single record) / `validateEnterpriseAccessObligationSet` (collection, duplicate-`id` check); serialized form; identity equality on `id`, structural equality on every declarative field |
| **Explicit non-responsibilities** | Decision outcome, grant identifiers, approval workflow state, URLs, credentials, provider SDK instances, runtime callbacks, a policy engine, provider/network/permission validation |

### 2.4 `EnterpriseAccessGrant` (R004.G)

`@aoc-enterprise/access-grant` · `packages/access-grant`

| | |
|---|---|
| **Responsibilities** | Record that authorization *was issued*: to whom, for which resource, until when, referencing which decision and which obligations were resolved first. |
| **Inputs** | `id`, `status: EnterpriseAccessGrantStatus` (`'active' \| 'revoked'`), `resource: ResourceRef` (Protocol, identity only — not the full envelope), `decisionRef: CanonicalId`, `obligationRefs?: readonly CanonicalId[]`, `principalId`, `issuedAt`, `expiresAt`, `correlationId`, `issuerRef?`, `auditRefs?` |
| **Outputs** | An immutable grant record; `validateEnterpriseAccessGrant` (required fields, `expiresAt` strictly after `issuedAt`, reference-shape checks); serialized form; identity equality on `id` + `decisionRef` + `principalId` + resource identity |
| **Explicit non-responsibilities** | A JWT/OAuth token, a download/signed URL, an API key, a provider SDK client, a session id, an execution callback, approval workflow runtime state, a scheduled expiration timer, wall-clock comparison |

### 2.5 `EnterpriseGrantRevocation` (R004.H)

`@aoc-enterprise/grant-revocation` · `packages/grant-revocation`

| | |
|---|---|
| **Responsibilities** | Record, immutably, *that* a previously-issued grant is no longer valid and *why* — without being the mechanism that makes it true anywhere else. |
| **Inputs** | `id`, `grantRef: CanonicalId` (points at `EnterpriseAccessGrant.id`), `revokedAt`, `reason: EnterpriseGrantRevocationReason` (closed 7-value vocabulary), `issuerRef`, `correlationId`, `evidenceRefs?`, `description?` |
| **Outputs** | An immutable revocation record; `validateEnterpriseGrantRevocation` / `validateEnterpriseGrantRevocationSet` (no two records share `id`; no two records revoke the same `grantRef`); serialized form; identity equality on `id` + `grantRef` + `revokedAt` |
| **Explicit non-responsibilities** | Provider execution, URL/cache/session invalidation, JWT/OAuth revocation, timers/schedulers, grant fields (`resource`, `status`, `expiry`, ...), provider/existence/runtime-enforcement validation |

### 2.6 `EnterpriseUsageEvent` (R004.I)

`@aoc-enterprise/usage-event` · `packages/usage-event`

| | |
|---|---|
| **Responsibilities** | Record, once per observed usage, that an issued grant was actually exercised: who, what, when, using which grant, against which resource. |
| **Inputs** | `id`, `eventType: EnterpriseUsageEventType` (closed 10-value vocabulary: `AccessAttempted`, `AccessStarted`, `AccessCompleted`, `AccessDenied`, `AccessExpired`, `AccessFailed`, `GrantConsumed`, `ContentViewed`, `ContentDownloaded`, `ContentStreamed`), `grantRef: CanonicalId`, `resource: ResourceRef`, `principalId`, `occurredAt`, `correlationId`, `metadata?` (JSON primitives, credential-shaped keys forbidden), `evidenceRefs?`, `description?` |
| **Outputs** | An immutable usage record (many per `grantRef` — repeatable by design); `validateEnterpriseUsageEvent` / `validateEnterpriseUsageEventSet` (duplicate `id` only — duplicate `grantRef` is expected); serialized form; identity equality on `id` + `occurredAt` + `grantRef` + `eventType` |
| **Explicit non-responsibilities** | An `allowed` field (that's the Decision's/Grant's fact), an `enforced` field, a `success`/`httpStatus`/provider-response field, a `policyEvaluationRef`, any grant field, provider execution/credentials/SDKs, validation against a grant's own `issuedAt`/`expiresAt` window |

### 2.7 `EnterpriseEvidenceCorrelation` (R004.J)

`@aoc-enterprise/evidence-correlation` · `packages/evidence-correlation`

| | |
|---|---|
| **Responsibilities** | Represent that a set of already-immutable records, taken together, belong to the same governed access lifecycle for one resource — a purely relational index, generating nothing itself. |
| **Inputs** | `id`, `resource: ResourceRef` (identity only), `decisionRefs: readonly CanonicalId[]` (**required, non-empty**), `obligationRefs?`, `grantRefs?`, `usageRefs?`, `revocationRefs?` (each an opaque id array), `correlatedAt`, `metadata?`, `description?` |
| **Outputs** | An immutable correlation graph; `validateEnterpriseEvidenceCorrelation` (non-empty `decisionRefs`, no duplicate refs within an array, "graph consistency": `usageRefs`/`revocationRefs` require `grantRefs`) / `validateEnterpriseEvidenceCorrelationSet` (duplicate `id`); serialized form; identity equality on correlation identity + resource + graph composition, reference-array comparisons set-based |
| **Explicit non-responsibilities** | Generating evidence, collecting logs, provider execution, auditing, persistence, any field belonging to a referenced contract, existence checks on any reference, provider/network/storage/authorization validation |

### 2.8 Supporting, pre-existing contract referenced by this lifecycle

`EnterpriseScopedAccessRequest` (`@aoc-enterprise/scoped-access`, pre-R004.D)
extends Protocol's `ScopedAccessRequest` with one additive field
(`action?`). It is not one of the seven R004.D–J contracts and is not
modified by this ADR, but it is the canonical shape of the "Access
Request" step in the lifecycle below, and `EnterpriseAccessDecision`
composes it directly.

---

## Phase 3 — Canonical Lifecycle

```text
 Resource
    │  (a resource exists somewhere external to Enterprise)
    ▼
 Access Request                         EnterpriseScopedAccessRequest
    │  principalId asks for resource,   (extends Protocol ScopedAccessRequest)
    │  requestedScope, action?          owner: requesting caller / Enterprise edge
    ▼
 Resource Envelope                      EnterpriseResourceEnvelope         (R004.D)
    │  the resource is described:       owner: Enterprise (resource registration)
    │  location, integrity, descriptor, immutable artifact: one envelope per
    │  lifecycleState                   registered resource snapshot
    ▼
 Access Decision                        EnterpriseAccessDecision           (R004.E)
    │  request + envelope evaluated to  owner: Enterprise (policy evaluation,
    │  outcome: allow / deny /          referenced but not embedded)
    │  conditional                      immutable artifact: one decision record
    ▼                                   per evaluation (re-evaluation produces
    │                                   a new record, never mutates the old one)
    ├─────────────► outcome = deny ─────► lifecycle halts here (Phase 7)
    ▼  outcome = allow / conditional
 Policy Obligations                     EnterpriseAccessObligation[]       (R004.F)
    │  conditions attached to the       owner: Enterprise (policy evaluation)
    │  decision: require-mfa,           immutable artifact: zero or more
    │  watermark-content, time-limit... obligation records, each referencing
    │                                   the decision by decisionRef
    ▼
 Access Grant                           EnterpriseAccessGrant              (R004.G)
    │  authorization is issued:         owner: Enterprise (issuance)
    │  principal, resource, expiresAt,  immutable artifact: one grant record,
    │  decisionRef, obligationRefs      status starts 'active'
    ▼
 Provider Translation                   (future Provider Adapter — not
    │  the grant is translated into     implemented; see Phase 4/5)
    │  provider-specific execution      owner: Provider Adapter
    │  input (a presigned URL request,  produces nothing Enterprise records;
    │  a scoped SDK call, a SAS         this is the boundary crossing
    │  request)                        (see Phase 4)
    ▼
 Provider Execution                     (future Provider Adapter — not
    │  the provider actually serves,    implemented)
    │  denies, or fails the access      owner: Provider (S3, Pinata, Azure
    │  attempt                          Blob, Google Drive, SharePoint, ...)
    ▼
 Usage Event                            EnterpriseUsageEvent               (R004.I)
    │  the adapter reports what it      owner: Enterprise (recording), fed by
    │  observed: AccessCompleted,       Provider Adapter (observing)
    │  ContentDownloaded, AccessFailed  immutable artifact: one usage record
    │  ...                              per observed event, referencing the
    │                                   grant by grantRef (repeatable)
    ▼
 Evidence Correlation                   EnterpriseEvidenceCorrelation      (R004.J)
    │  the decision, obligations,       owner: Enterprise (relational indexing)
    │  grant, usage, and (if any)       immutable artifact: one correlation
    │  revocation records for this      graph tying the lifecycle together by
    │  resource are tied together       opaque reference, generating no new fact
    ▼
 Grant Revocation (when applicable)     EnterpriseGrantRevocation          (R004.H)
    │  the grant is invalidated before  owner: Enterprise (recording the fact
    │  or after usage: expired,         of revocation, never the mechanism
    │  administrator-revoked,           that enforces it)
    │  security-incident, ...           immutable artifact: at most one
                                        revocation record per grantRef
```

### Transition-by-transition ownership

| Transition | Who acts | Immutable artifact produced | Contract |
|---|---|---|---|
| Resource → Access Request | Requesting principal / caller | none (a request, not yet a record) | `EnterpriseScopedAccessRequest` |
| Access Request → Resource Envelope | Enterprise (resource registration) | one envelope snapshot | `EnterpriseResourceEnvelope` |
| Resource Envelope + Request → Access Decision | Enterprise (policy evaluation, referenced not embedded) | one decision record | `EnterpriseAccessDecision` |
| Access Decision → Policy Obligations | Enterprise (policy evaluation) | zero or more obligation records | `EnterpriseAccessObligation` |
| Decision + Obligations → Access Grant | Enterprise (issuance) | one grant record | `EnterpriseAccessGrant` |
| Access Grant → Provider Translation | Provider Adapter (future, out of scope) | none Enterprise records | — |
| Provider Translation → Provider Execution | Provider (future, out of scope) | none Enterprise records | — |
| Provider Execution → Usage Event | Provider Adapter observes, Enterprise records | one usage record per observation | `EnterpriseUsageEvent` |
| All of the above → Evidence Correlation | Enterprise (relational indexing) | one correlation graph | `EnterpriseEvidenceCorrelation` |
| Access Grant → Grant Revocation | Enterprise (recording an external cause) | at most one revocation record per grant | `EnterpriseGrantRevocation` |

Every artifact in this lifecycle is immutable: re-evaluating a request
produces a new `EnterpriseAccessDecision`, never a mutated one; a grant
that lapses is represented by reading `expiresAt` against the current
time, never by rewriting the grant record; a grant that is administratively
ended produces a new `EnterpriseGrantRevocation` record, never a status
flip on the grant itself (the grant's own `status` field, `'active' |
'revoked'`, is a *declared future snapshot value*, not something any of
these seven contracts transitions in place — see R004.G's own ADR,
"Why `status` includes `'revoked'`").

---

## Phase 4 — Provider Boundary

```text
┌───────────────────────────────── ENTERPRISE ─────────────────────────────────┐
│                                                                                 │
│   EnterpriseResourceEnvelope   EnterpriseAccessDecision   EnterpriseAccessObligation │
│   EnterpriseAccessGrant        EnterpriseGrantRevocation  EnterpriseUsageEvent       │
│   EnterpriseEvidenceCorrelation                                                │
│                                                                                 │
│   Owns: Decision · Grant · Evidence · Policy (Obligation) · Usage · Revocation │
│   Every contract: immutable, provider-neutral, no credential, no SDK type,     │
│   no URL, no runtime client — enforced at compile time in every package.      │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                        │  EnterpriseAccessGrant (resource,
                                        │  status, expiresAt) is the ONLY
                                        │  input a Provider Adapter reads
                                        │  from Enterprise's owned contracts.
                                        │  EnterpriseUsageEvent is the ONLY
                                        │  output a Provider Adapter writes
                                        │  back.
                                        ▼
┌───────────────────────────────── PROVIDER ────────────────────────────────────┐
│                                                                                 │
│   Owns: Execution · Temporary URLs · Signed URLs · Credentials · Network ·     │
│         Storage · SDK                                                          │
│                                                                                 │
│   (Pinata SDK, S3 SDK, Azure Blob SDK, Google Drive API, SharePoint API, ...)  │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Why this separation exists

1. **Provider neutrality is load-bearing, not aspirational.** Every one of
   the seven contracts has a compile-time-enforced negative test suite
   proving it *cannot* carry a credential, an API key, a bearer token, a
   signed/temporary URL, a provider SDK client type, or a runtime session.
   That property is only meaningful if the boundary that separates
   "Enterprise decides and records" from "Provider executes" is drawn once,
   consistently, across all seven contracts — not re-litigated per
   contract.
2. **Immutability requires the boundary.** An immutable record cannot
   depend on provider state that changes independently of it (a presigned
   URL expires on its own clock; a provider credential can be rotated).
   Keeping provider execution entirely outside the seven contracts is what
   makes "immutable" actually true of them, not just declared.
3. **Swapping a provider must never touch the lifecycle.** Phase 8
   demonstrates this concretely: Pinata, S3, Azure Blob, Google Drive, and
   SharePoint all produce the identical seven-contract lifecycle: only
   `EnterpriseResourceEnvelope.location.system`/`systemReference` (a free
   string, not a closed enum — R004.D's explicit design choice) and the
   Provider Translation/Execution steps change.
4. **A decision, a grant, and evidence must be provable independent of
   any provider being reachable.** Because none of the seven contracts
   contact a provider or embed provider state, Enterprise can always
   answer "who decided what, when, and why" even if every configured
   provider is offline — the failure scenarios in Phase 7 depend on this.

---

## Phase 5 — Provider Contract Requirements

These are architectural expectations only — no interface, API, or method
signature is defined here, and none should be inferred as a to-do for this
sequence. A future Provider Adapter sequence designs the actual interface;
it must satisfy these expectations using only the seven frozen contracts
as its input/output surface.

| Expectation | What it means, conceptually |
|---|---|
| **Grant translation** | Given an `EnterpriseAccessGrant` (`resource`, `status`, `expiresAt` are the only fields a translation may read), the adapter produces whatever provider-specific execution artifact grants the actual access (a presigned URL, a scoped SDK call, a SAS token). This translation output is never written back into any of the seven contracts. |
| **Grant expiration** | The adapter is responsible for refusing to translate or honor a grant once `expiresAt` has passed, by comparing against wall-clock time itself — none of the seven contracts perform that comparison (Phase 7 explains why). |
| **Usage reporting** | The adapter is the actual emitter of `EnterpriseUsageEvent` records — it is the only party positioned to observe that a real access attempt happened, succeeded, or failed against a real provider. |
| **Revocation interpretation** | The adapter reads `EnterpriseGrantRevocation.reason` (a closed 7-value vocabulary: `expired`, `administrator-revoked`, `policy-changed`, `principal-disabled`, `resource-removed`, `manual-revocation`, `security-incident`) and decides what, if anything, to do on the provider's own side (e.g. `resource-removed` → unpin/delete a provider object; `security-incident` → revoke outstanding presigned URLs). The reason vocabulary is declarative; interpreting it is entirely the adapter's job. |
| **Capability declaration** | An adapter should be able to state, in whatever form its own design settles on, which storage systems, resource lifecycle states, and obligation types (`watermark-content`, `read-only`, `no-download`, `time-limit`, ...) it is actually capable of enforcing — so that Enterprise-side policy evaluation is not composing obligations no adapter can satisfy. No such declaration mechanism exists today; this is a requirement on future work, not a contract shape decided here. |
| **Provider metadata** | Anything provider-specific about *where* a resource lives belongs in `EnterpriseResourceEnvelope.location` (`system`, `systemReference`, `uri`) — a free-text, provider-neutral shape already frozen by R004.D. No new provider-identifying field should be added to any of the other six contracts. |
| **Failure reporting** | A provider-side failure (network error, permission error, provider outage) is reported as an `EnterpriseUsageEvent` with `eventType: 'AccessFailed'` (attempted but did not complete) or `'AccessDenied'` (rejected outright) — never as a `success`/`httpStatus`/provider-response field, which every one of the seven contracts explicitly forbids. |
| **Provider-specific identifiers** | A provider's own object key, CID, blob name, or file id is carried in `EnterpriseResourceEnvelope.location.systemReference` — the one place designed to hold it. No other contract has, or should gain, a field shaped to hold a provider identifier. |

---

## Phase 6 — Evidence Lifecycle

```text
 Decision  ──────►  Grant  ──────►  Usage  ──────►  Revocation
    │                  │                │                │
    └──────────────────┴────────────────┴────────────────┘
                              │
                              ▼
                    EvidenceCorrelation
              (references all of the above by id;
               owns none of their facts)
```

### Which artifact owns each fact

| Fact | Owning artifact | Referenced by (never duplicated in) |
|---|---|---|
| That a request was evaluated, and to what outcome | `EnterpriseAccessDecision` | `EnterpriseAccessObligation.decisionRef`, `EnterpriseAccessGrant.decisionRef`, `EnterpriseEvidenceCorrelation.decisionRefs` |
| That a condition attaches to a decision | `EnterpriseAccessObligation` | `EnterpriseAccessGrant.obligationRefs`, `EnterpriseEvidenceCorrelation.obligationRefs` |
| That authorization was issued, to whom, until when | `EnterpriseAccessGrant` | `EnterpriseGrantRevocation.grantRef`, `EnterpriseUsageEvent.grantRef`, `EnterpriseEvidenceCorrelation.grantRefs` |
| That a grant is no longer valid, and why | `EnterpriseGrantRevocation` | `EnterpriseEvidenceCorrelation.revocationRefs` |
| That a grant was actually exercised, and how | `EnterpriseUsageEvent` | `EnterpriseEvidenceCorrelation.usageRefs` |
| That a set of the above belong to the same lifecycle for one resource | `EnterpriseEvidenceCorrelation` | (terminal — nothing references a correlation graph within this contract line) |

`EnterpriseEvidenceCorrelation` is the only contract in this line that
*only* references — it owns no fact about any decision, obligation,
grant, usage event, or revocation. Every other contract both owns exactly
one class of fact and references at most the layer(s) immediately beneath
it (never a layer two steps down: `EnterpriseAccessGrant` does not
reference `EnterpriseUsageEvent`, `EnterpriseUsageEvent` does not
reference `EnterpriseAccessDecision` — each references only its direct
predecessor by opaque id). This directionality is what Phase 10 confirms
holds with no exceptions.

---

## Phase 7 — Failure Scenarios

| Scenario | Recorded by | How |
|---|---|---|
| **Decision denied** | `EnterpriseAccessDecision` | `outcome: 'deny'`. The lifecycle halts here by convention, not by mechanism — nothing in `EnterpriseAccessGrant` prevents issuing a grant unrelated to a denied decision; issuance logic (future, out of scope) is expected to never do so. `EnterpriseEvidenceCorrelation` can still index a denied-only lifecycle: `decisionRefs` is the only required reference array. |
| **Grant expires** | *(no dedicated record — a computed fact)* | `EnterpriseAccessGrant.expiresAt` vs. wall-clock time. None of the seven contracts perform this comparison (R004.G: "a comparison against the current time, which this immutable, non-executing contract does not perform"). A Provider Adapter or a future read layer computes it at read time. If the expiration is also formally recorded, it is via `EnterpriseGrantRevocation` with `reason: 'expired'` — a distinct, deliberate act of recording, not automatic. |
| **Provider unavailable** | `EnterpriseUsageEvent` (indirectly, if an adapter chooses to report it) | `eventType: 'AccessFailed'`. Entirely a Provider Adapter concern (Phase 4); no Enterprise contract has a provider-availability field. |
| **Provider execution fails** | `EnterpriseUsageEvent` | `eventType: 'AccessFailed'`. Same boundary as above — never a `success`/`httpStatus` field. |
| **Usage never occurs** | *(no record — absence is the record)* | No `EnterpriseUsageEvent` exists for that `grantRef`. `EnterpriseEvidenceCorrelation.usageRefs` stays empty or absent. The lifecycle is fully valid without ever reaching usage — an issued, unexercised grant is not an error state. |
| **Grant revoked before usage** | `EnterpriseGrantRevocation` | `revokedAt` recorded once for the `grantRef`; no matching `EnterpriseUsageEvent` need ever exist. `EnterpriseAccessGrant.status` is documented to move to `'revoked'` in the next snapshot, per R004.G. |
| **Usage arrives after revocation** | Both `EnterpriseGrantRevocation` and `EnterpriseUsageEvent` — coexisting | Both records are independently well-formed and can both exist: `EnterpriseUsageEvent.occurredAt` is never validated against any `EnterpriseGrantRevocation.revokedAt` (by design — R004.I: usage timestamps are "never validated against a grant's own `issuedAt`/`expiresAt` window," and no cross-contract check exists against revocation either). This is intentional, not a gap: the data model must be able to *represent* an anomaly (a provider that failed to honor a revocation promptly, a race condition, a delayed report, or a fraudulent replay) before anyone can *investigate* it. `EnterpriseEvidenceCorrelation` is what makes the anomaly discoverable — both records correlate under the same `resource`/`grantRefs` — but resolving what it means is explicitly reserved for a future audit/compliance/SIEM surface, never any of these seven contracts. |

---

## Phase 8 — Future Provider Examples (conceptual only)

The lifecycle in Phase 3 is identical for every provider below. Only two
things vary: the free-text `location.system`/`systemReference` value on
`EnterpriseResourceEnvelope`, and the unimplemented Provider
Translation/Execution steps. **No adapter is implemented by this
document.**

```text
                          EnterpriseResourceEnvelope.location
                          ┌─────────────────────────────────┐
                          │ system: <free string>             │
                          │ systemReference: <provider id>    │
                          │ uri: <provider-shaped locator>    │
                          └─────────────────┬───────────────┘
                                            │
        ┌──────────────┬──────────────┬────┴────────┬──────────────┐
        ▼              ▼              ▼             ▼              ▼
   ┌─────────┐    ┌─────────┐    ┌──────────┐  ┌──────────┐  ┌────────────┐
   │ Pinata  │    │   S3    │    │  Azure   │  │  Google  │  │ SharePoint │
   │ (IPFS)  │    │         │    │  Blob    │  │  Drive   │  │            │
   └─────────┘    └─────────┘    └──────────┘  └──────────┘  └────────────┘
   system:         system:        system:        system:       system:
   'pinata'        's3'           'azure-blob'    'google-     'sharepoint'
   systemReference: systemReference: systemReference: drive'    systemReference:
   '<CID>'         'bucket/key'   '<container/    systemReference: '<site>/<item-id>'
   uri:            uri:           blob>'          '<file-id>'    uri:
   'ipfs://...'    's3://...'     uri:            uri:           'https://.../
                                  'https://...     'https://...   sites/.../...'
                                  blob.core...'    drive.google
                                                   .com/...'

   Every one of the five: same EnterpriseAccessDecision → EnterpriseAccessObligation
   → EnterpriseAccessGrant → [Provider Translation → Provider Execution] →
   EnterpriseUsageEvent → EnterpriseEvidenceCorrelation → EnterpriseGrantRevocation
   lifecycle, unchanged. Only Provider Translation/Execution differs per provider,
   and that step is entirely outside the seven frozen contracts.
```

| Provider | `location.system` (illustrative) | What varies at Provider Execution | What does not vary |
|---|---|---|---|
| Pinata (IPFS) | `'pinata'` | Pin/unpin, IPFS gateway URL generation | All seven contracts, all transitions, all obligation/revocation/usage vocabularies |
| S3 | `'s3'` | Presigned `GetObject`/`PutObject` URL generation | ″ |
| Azure Blob | `'azure-blob'` | SAS token generation | ″ |
| Google Drive | `'google-drive'` | Drive API share-link/permission grant | ″ |
| SharePoint | `'sharepoint'` | Graph API sharing-link/permission grant | ″ |

---

## Phase 9 — Sequence Diagrams

Actors: **Requester** (holds `EnterpriseScopedAccessRequest`), **Enterprise
Governance** (owns the seven frozen contracts), **Provider Adapter**
(future, conceptual only), **Provider** (S3/Pinata/Azure/etc., conceptual
only).

### 9.1 Happy path

```text
Requester          Enterprise Governance              Provider Adapter        Provider
   │                        │                                │                   │
   │── access request ────►│                                │                   │
   │                        │─ build ResourceEnvelope        │                   │
   │                        │─ evaluate → AccessDecision      │                   │
   │                        │  (outcome: allow/conditional)   │                   │
   │                        │─ attach AccessObligation(s)      │                   │
   │                        │─ issue AccessGrant (active)      │                   │
   │                        │──── translate grant ────────────►│                   │
   │                        │                                │── execute ────────►│
   │                        │                                │◄── served ─────────│
   │                        │◄──── UsageEvent                │                   │
   │                        │     (AccessCompleted /          │                   │
   │                        │      ContentDownloaded)          │                   │
   │                        │─ correlate EvidenceCorrelation  │                   │
   │                        │  (decisionRefs, obligationRefs,  │                   │
   │                        │   grantRefs, usageRefs)          │                   │
   │◄── access served ─────│                                │                   │
```

### 9.2 Revocation

```text
Requester          Enterprise Governance              Provider Adapter        Provider
   │                        │                                │                   │
   │  (grant already active, issued earlier)                  │                   │
   │                        │◄── administrator-revoked ───────│                   │
   │                        │─ record GrantRevocation          │                   │
   │                        │  (grantRef, reason, revokedAt)   │                   │
   │                        │─ correlate EvidenceCorrelation  │                   │
   │                        │  (grantRefs + revocationRefs)   │                   │
   │                        │──── (no more translation) ─────►│                   │
   │                        │                                │─ interprets reason,│
   │                        │                                │  stops honoring   │
   │                        │                                │  grant, may unpin/│
   │                        │                                │  revoke provider  │
   │                        │                                │  side state ──────►│
```

### 9.3 Denied access

```text
Requester          Enterprise Governance              Provider Adapter        Provider
   │                        │                                │                   │
   │── access request ────►│                                │                   │
   │                        │─ build ResourceEnvelope        │                   │
   │                        │─ evaluate → AccessDecision      │                   │
   │                        │  (outcome: deny)                │                   │
   │                        │─ correlate EvidenceCorrelation  │                   │
   │                        │  (decisionRefs only)             │                   │
   │◄── access denied ─────│                                │                   │
   │                        │  (no AccessObligation, no AccessGrant, no          │
   │                        │   Provider Translation ever reached)               │
```

### 9.4 Late usage

```text
Requester          Enterprise Governance              Provider Adapter        Provider
   │                        │                                │                   │
   │  (grant active, issued and translated earlier)           │                   │
   │                        │─ record GrantRevocation          │                   │
   │                        │  (grantRef, security-incident,   │                   │
   │                        │   revokedAt = T1)                │                   │
   │                        │                                │  (in-flight request,│
   │                        │                                │   already reached  │
   │                        │                                │   provider before  │
   │                        │                                │   revocation) ─────►│
   │                        │                                │◄── served ─────────│
   │                        │◄── UsageEvent                  │                   │
   │                        │   (occurredAt = T2 > T1,        │                   │
   │                        │    grantRef unchanged)          │                   │
   │                        │─ correlate EvidenceCorrelation  │                   │
   │                        │  (both usageRefs and             │                   │
   │                        │   revocationRefs present —        │                   │
   │                        │   anomaly is now discoverable,   │                   │
   │                        │   not resolved by this contract) │                   │
```

### 9.5 Expired grant

```text
Requester          Enterprise Governance              Provider Adapter        Provider
   │                        │                                │                   │
   │  (grant issued, expiresAt = T_exp, no revocation ever recorded)             │
   │── access attempt ─────────────────────────────────────►│  (T_now > T_exp)  │
   │                        │                                │─ compares T_now   │
   │                        │                                │  vs T_exp itself  │
   │                        │                                │  (no Enterprise   │
   │                        │                                │   contract does   │
   │                        │                                │   this)           │
   │                        │                                │─ refuses to       │
   │                        │                                │  translate/honor  │
   │                        │◄── UsageEvent                  │  the grant        │
   │                        │   (AccessExpired or             │                   │
   │                        │    AccessDenied)                │                   │
   │◄── access denied ─────│                                │                   │
```

---

## Phase 10 — Architectural Validation

### Missing concepts

None found against the mandated minimum flow (Resource → Access Request →
Resource Envelope → Access Decision → Policy Obligations → Access Grant →
Provider Translation → Provider Execution → Usage Event → Evidence
Correlation → Grant Revocation). Every step maps onto an existing
canonical contract, an existing supporting contract (`EnterpriseScopedAccessRequest`),
or an explicitly out-of-scope future Provider Adapter step.

### Duplicate concepts

None found. Each contract's own ADR already performed and documented an
explicit "reuse-or-justify" search before introducing a new type
(`EnterpriseAccessObligation` over `CanonicalObligation`/
`EnterprisePolicyObligation`/`PolicyObligation`; `EnterpriseAccessGrant`'s
status vocabulary over `EnterpriseResourceLifecycleState`/`PolicyDecision`;
`EnterpriseGrantRevocation` over `AuthorityGrant`/`RevocationLink`). This
ADR re-verified each of those searches' conclusions and found no
overlooked candidate.

### Architectural overlap / responsibility leakage

None found. Compile-time negative tests exist in every one of the seven
packages proving no contract can carry a credential, a signed/temporary
URL, a provider SDK type, a runtime session, or another contract's owned
field. Reference directionality (Phase 6) holds with no exceptions: every
contract references only the layer immediately beneath it, by opaque id,
never embedding.

### Observations (not defects — recorded for future Provider Adapter and audit-surface designers)

1. **No cross-contract temporal validation exists between
   `EnterpriseUsageEvent.occurredAt`, `EnterpriseGrantRevocation.revokedAt`,
   and `EnterpriseAccessGrant.expiresAt`.** This is intentional and
   individually documented in R004.H and R004.I's own ADRs — each
   contract deliberately performs no wall-clock or cross-record time
   comparison. The consequence (Phase 7, "usage arrives after
   revocation") is that the frozen contracts can *represent* a temporal
   anomaly but never *resolve* it. **Recommendation:** any future
   audit/compliance/SIEM surface reading `EnterpriseEvidenceCorrelation`
   graphs must implement this reasoning itself. It must not be retrofitted
   into any of the seven frozen contracts — doing so would break their
   documented "no wall-clock comparison" boundary and would be a breaking
   change to already-shipped, tested behavior.
2. **`EnterpriseAccessGrant.status` is two-state (`'active' | 'revoked'`)
   and deliberately excludes `'expired'`** (R004.G's own documented
   rationale). Determining "is this grant currently valid" therefore
   requires composing three things — `status`, `expiresAt` vs. wall clock,
   and (if present) a correlated `EnterpriseGrantRevocation` — never a
   single field read. This is architecturally consistent with observation
   1 and is not itself a gap.
3. **Provider capability declaration** (Phase 5) has no home in any of the
   seven contracts today, and none is proposed by this ADR. A future
   Provider Adapter sequence must design where "which obligation types can
   this adapter actually enforce" is declared; it is out of scope for this
   freeze to decide.

None of these observations block the freeze: all three are already
correctly-scoped exclusions from the seven existing contracts' own design,
restated here for a Provider Adapter implementer's benefit, not new
findings requiring correction.

---

## Phase 11 — Acceptance Checklist

- [x] **Every contract has exactly one responsibility.** Confirmed per
  contract in Phase 2 and cross-checked against each package's own
  "Explicit non-responsibilities" section.
- [x] **No contract executes provider logic.** Confirmed: no contract
  contains a service, API, persistence layer, or execution engine; all
  seven are pure data + validation + serialization + equality.
- [x] **No provider owns Enterprise decisions.** Confirmed by Phase 4:
  `EnterpriseAccessDecision`, `EnterpriseAccessGrant`, and every other
  Enterprise-owned fact are produced without contacting, or depending on
  the availability of, any provider.
- [x] **Every immutable fact has exactly one owner.** Confirmed by the
  Phase 6 fact-ownership table — no fact is duplicated across two
  contracts.
- [x] **Every reference is directional.** Confirmed by Phase 6/10: each
  contract references only the layer immediately beneath it, by opaque
  `CanonicalId`, never embedding, and no back-reference exists (a
  decision does not know about grants issued from it).
- [x] **Provider neutrality preserved.** Confirmed by the compile-time
  negative test suite present in all seven packages, and by Phase 8
  showing five distinct future providers require zero change to any of
  the seven contracts.

---

## Phase 12 — Deliverables

This document is the complete deliverable for R005.0:

- **ADR** — this file (`docs/architecture/ADR-ACCESS-LIFECYCLE.md`).
- **Architecture diagrams** — Phase 4 (Provider Boundary).
- **Lifecycle diagrams** — Phase 3 (Canonical Lifecycle), Phase 6
  (Evidence Lifecycle).
- **Sequence diagrams** — Phase 9 (happy path, revocation, denied access,
  late usage, expired grant).
- **Provider boundary diagrams** — Phase 4, Phase 8 (per-provider
  conceptual mapping).
- **Future extension section** — Phase 5 (Provider Contract
  Requirements), Phase 8 (Future Provider Examples), Phase 10
  (Observations for future Provider Adapter / audit-surface design).

No package, contract, test, or runtime file is created or modified by
this change.

---

## Most important rule, restated

This ADR freezes the architecture described above. After approval, future
Provider Adapter work MUST conform to this document: it may translate
Enterprise concepts (`EnterpriseAccessGrant`, `EnterpriseGrantRevocation`,
`EnterpriseAccessObligation`) into provider-specific execution, and it
may emit `EnterpriseUsageEvent` records — but it may not invent new
lifecycle states, new cross-contract fields, new obligation or revocation
vocabulary entries, or any mechanism that causes a provider to influence
an Enterprise-owned fact (`EnterpriseAccessDecision.outcome`,
`EnterpriseAccessGrant.status`, or any other). Any such need surfaces as a
new sequence proposing a change to this frozen ADR, not as an
implementation detail inside a Provider Adapter.

---

## Final Verdict

**R005.0 COMPLETE — ACCESS LIFECYCLE FROZEN**
