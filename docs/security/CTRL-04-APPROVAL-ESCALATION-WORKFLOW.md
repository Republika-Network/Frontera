# CTRL-04 — Approval & Escalation Workflow (human side): Qualification

- **Decision record:** `docs/architecture/ADR-CTRL-04-APPROVAL-ESCALATION-WORKFLOW.md`
- **Starting point:** `main @ fe277ea` (CTRL-03 merged), branch `feat/ctrl-04-approval-escalation-workflow`
- **Implementation gate:** ADR-CTRL-04 §1.1 — introduced by CTRL-04; the Master Plan named CTRL-04's scope and dependencies but no literal exit criterion
- **Invariants:** SEC-INV-208 … SEC-INV-215 (`SECURITY_INVARIANTS.md` §4.22) · **Threat model:** `THREAT_MODEL_V1.md` §7.27 · **No-bypass:** EP-068

## 1. Discovery

The full CORE-05 port inventory (operations × input, output, trusted context, persistence, transition, authority, SOD, expiry, refusals, idempotency) is ADR-CTRL-04 §1.2. In short: `enterprise.approvals` was an in-process port (`pending`, `describe(requestId)`, `approve`, `reject`, `requestChanges`, `escalate`, `revoke`) taking a trusted `ApprovalCommandContext {authenticated: true, actorId, authenticatedBy}` and a closed command `{approvalRequestId, subjectDigest, evidence?, reason?}`; state derived on every read by replaying approval-runtime's policies; approver standing read live from the Kernel Authority; the signed append-only log the only durable state. No route, no human surface (CTRL-03 D17).

What a human surface needed and the port lacked: a list of every request (not only pending), lookup by approval request, and the recorded note/evidence of each verdict (to make an escalation's reference visible). CTRL-04 added exactly those as reads (`list()`, three presentation fields on the verdict view); nothing that decides changed.

## 2. What was built

| Layer | Change |
|---|---|
| CORE-05 (`approval-authority`) | `list()`; `recordedBy`, `reason?`, `evidence[]` on `ApprovalVerdictView` (presentation only) |
| Operator plane (`operator-control`) | `approval-workflow.ts` — the Host service: authorize first, refuse non-operator credential classes, closed body, subject pre-check, **the one** `ApprovalCommandContext` (`operator:<operatorId>`, `frontera:operator-plane`), CORE-05 call, deliberate error mapping, field-by-field DTOs, content-free audit |
| Roles | `approval.read`, `approval.approve`, `approval.restrict`; role `approver`; observer +read, responder +read +restrict; provisioner, profile-steward, legacy administrator unchanged |
| Router / composition | seven routes under `/api/admin/approvals` (closed verb list, no operator-plane import in the router); `enterprise.operatorApprovals` composed only with operators **and** approvals |
| Web console | Approvals section: inbox (derived views), detail (derived state vs durable facts, canonical bytes, requirement snapshot, verdict log), one confirmation per verdict with evidence rows; three Host-client calls; route-shape logging |
| API | 49 → **56** endpoints (`release/api-surface.v1.json`) |

## 3. The identity bridge, proven

| Property | Evidence |
|---|---|
| The approver is `operator:<operatorId>` from the authenticated principal; the channel is `frontera:operator-plane` | Host quorum-1 case asserts the recorded verdict `[approved, operator:approver-a, frontera:operator-plane, counted]`; `ctrl04-structure.test.ts` pins the single construction |
| Body fields cannot name the actor or channel | 19 smuggled fields → 400, nothing recorded; mutations M1, M2 killed |
| A Kernel-Authority approver standing is provisioned with no code | the web qualification provisions `operator:approver-a` / `-b` and their `approve-release` grants through the console's own forms |
| Operator permission without standing → refused | `approver-nostanding` and the organization administrator → `APPROVAL_APPROVER_INELIGIBLE` / `INVALID_APPROVER` |
| Standing without operator authentication → unreachable | anonymous → 401; the self-approval agent's credential (its actor holds standing) → 401 |
| Standing over another resource / another approver action / only execution authority → refused | `APPROVAL_OUT_OF_SCOPE`, `APPROVER_AUTHORITY_MISSING`, `APPROVER_AUTHORITY_MISSING` |
| Standing revoked after the verdict → the unused approval is withdrawn | the responder revokes `approval-standing-approver-a` over the CTRL-01 route; status returns to `pending`, the verdict `counted: false`, the retry is withheld |

## 4. Canonical E2E — quorum 1 (browser and HTTP)

`ctrl04-web-approvals-host.test.ts` (browser-faithful harness, real Host, real console, clean stores):

1. Secure Host booted (`bootEnterpriseHost()`, SQLite everywhere, Ed25519 authority signing, external freshness witness, operators, two approval profiles); console booted (`createControlPlaneWebServer()`).
2. Organization bootstrapped and the release agent onboarded over the operator API (CTRL-02/03-proven); a provisioner gives `approver-a` and `approver-b` Kernel-Authority approval standing **through the console**.
3. The agent submits `deploy-release` × `production-cluster` → Kernel `approval_required` → withheld; adapter count unchanged.
4. `approver-a` signs in; the request is in the pending inbox (`0 / 1`, derived); the detail shows the subject digest, decision, evaluation, action, resource, typed parameter, approver action and the canonical subject bytes; the verdict form's fields are exactly `csrf`, `subjectDigest`, `reason` (+ `confirm`), and `subjectDigest` equals the Host's.
5. Approve → the Host derives the actor, CORE-05 checks standing → the re-read page says *"Approval quorum satisfied — the action has not been executed"*; the Host's truth: `approved`, `countedApprovers: ['operator:approver-a']`, `recordedBy: frontera:operator-plane`.
6. Adapter count still unchanged. The agent retries the same request → `executed`, the **same** `decision` object; a further retry replays; adapter **exactly once**. Activity re-reads the decision; the request moves to the Approved view.

The Host suite repeats this over HTTP and additionally proves: one decision record for the request (activity query), one approval request, and the resumed grant's signed `sourceDigest` equals the source recomputed **with** the approval digest and differs **without** it; the grant never outlives `notAfter`.

## 5. Canonical E2E — quorum 2 with evidence

Profile `release-critical`: two distinct approvers, `source_document` evidence required.

| Step | Result |
|---|---|
| approve without evidence (web: the field left empty) | 409 `APPROVAL_EVIDENCE_INSUFFICIENT`; nothing recorded |
| wrong evidence type | 409 `APPROVAL_EVIDENCE_INSUFFICIENT` |
| malformed / upper-case hash | 400 |
| `approver-a` with a hash and location | 200, `pending`, `1 / 2`; the reference is shown as recorded |
| agent retries | withheld (`GOVERNED_ACTION_APPROVAL_PENDING`); adapter unchanged |
| `approver-a` again (another hash) | 409 `APPROVAL_DUPLICATE`; still `1 / 2` |
| another critical request | `0 / 2` — no pooling |
| `approver-b` | 200, `approved`, `2 / 2` |
| agent retries | executed exactly once |
| evidence binding | the approval digest recomputes from the counted rows' digests; the verdict row's digest recomputes from the store and **changes** when its evidence hash is substituted |

## 6. Negative matrix (Host over HTTP; every row asserts the adapter where relevant)

| Case | Outcome |
|---|---|
| route permission, no standing (approver role; organization administrator) | 409 `APPROVAL_APPROVER_INELIGIBLE` (`INVALID_APPROVER`); retry withheld |
| standing over another resource | 409, `APPROVAL_OUT_OF_SCOPE` |
| standing for another approver action | 409, `APPROVER_AUTHORITY_MISSING` |
| execution authority only | 409, `APPROVER_AUTHORITY_MISSING` |
| responder with standing → approve | 403 `OPERATOR_PERMISSION_DENIED`; reject → 200 `rejected` |
| self-approval (requester holds standing and an operator credential) | 409 `APPROVAL_SEGREGATION_OF_DUTIES`; another approver then succeeds |
| duplicate approval | 409 `APPROVAL_DUPLICATE`, not counted |
| rejection | final: approve / reject / revoke afterwards → 409 `APPROVAL_REJECTED`; retry withheld `…_REJECTED`; adapter 0 |
| requested changes ×2 (quorum-1 cluster) | recorded, `pending`, quorum `0 / 1`, subject unchanged, retry withheld, adapter 0; approval still possible |
| escalation without a reference | 400, nothing recorded (the operator plane routes on the reference) |
| escalation ×2 | recorded with reference, quorum unchanged, in the Escalated view for an observer, retry withheld, adapter 0; an operator without standing can neither approve afterwards nor escalate |
| request expiry (injected clock) | 1 ms before → approve accepted; at the instant → 409 `APPROVAL_REQUEST_EXPIRED`, status `request-expired` |
| approval lapse before retry (injected clock) | status `approval-expired`; retry withheld `…_APPROVAL_EXPIRED`; adapter 0 |
| revoked before retry | `revoked`, `approvalDigest: null`; retry withheld `…_REVOKED`; second revoke / later approve → 409 `APPROVAL_REVOKED`; `unrevoke`/`restore`/`reactivate`/`undo`/`execute`/`delete` → 404 |
| standing revoked before use | approval withdrawn; retry withheld; adapter 0 |
| stale / substituted digest (forged, another request's) | 409 `APPROVAL_SUBJECT_MISMATCH`; nothing recorded |
| requirement changed (restart with quorum 1 → 2) | `superseded`; the old review → 409 `APPROVAL_REQUEST_SUPERSEDED`; listed under Superseded |
| foreign organization (a second Host, `org-foreign`) | its approval id → 404 on read and command; not in the inbox; nothing recorded there |
| legacy administrator | 403 on every approval route; its identity shows no approval permission |
| customer API key / agent credential / unknown / anonymous | 403 / 401 / 401 / 401 |
| approver credential on `/api/governed-actions` | 401 |
| concurrent double approve (same approver) | `[200, 409]`; one counted |
| concurrent approve by two approvers on quorum 1 | `[200, 409 APPROVAL_ALREADY_APPROVED]`; one approval digest; two concurrent retries → one execution |

## 7. Role × operation matrix (both halves independently)

Host (forged direct requests, `ctrl04-approval-workflow-host.test.ts`): for observer, responder, provisioner, profile steward, organization administrator, approver and legacy administrator × list, describe, approve, reject, request-changes, escalate, revoke — every permitted pair passes the permission check and is refused by the Host's subject pre-check (a deliberately stale digest: 409, nothing recorded), every other pair is 403 before any body is read. Which CORE-05 command each verb reaches is pinned structurally (`APPROVAL_COMMANDS`) and exercised end to end by the verdict cases above. A body that is not even JSON from a provisioner is 403, never 400.

Web (`ctrl04-web-approvals-host.test.ts`): the detail page shows exactly the verdict links the Host-reported permissions allow (observer none; responder reject / request-changes / escalate / revoke; administrator and approver all five), and every hidden verdict, forged as a POST with a valid session and CSRF token, is refused by the Host (`403 OPERATOR_PERMISSION_DENIED`); provisioner and steward get 403 on the inbox and detail with no subject content in the page.

| Operation | observer | responder | provisioner | profile-steward | approver | org-admin | legacy-admin |
|---|---|---|---|---|---|---|---|
| inbox / describe | ✓ | ✓ | 403 | 403 | ✓ | ✓ | 403 |
| approve | 403 | 403 | 403 | 403 | reach | reach | 403 |
| reject / request-changes / escalate / revoke | 403 | reach | 403 | 403 | reach | reach | 403 |

*reach* = past the permission check; with a current subject digest the Host forwards to CORE-05, which decides with the operator's Kernel-Authority standing.

## 8. Escalation routing

An escalation is CORE-05's recorded, inert verdict; the operator plane requires it to carry a reference (400 otherwise — a CTRL-04 routing rule, not a CORE-05 change). CTRL-04's routing is the derived **Escalated** view (`GET /api/admin/approvals?view=escalated`; the console's Escalated tab): every open request with a recorded escalation, with who escalated, when and the recorded reference. Proven: the escalation creates the CORE-05 fact (verdict row), an observer finds the request without knowing its id, the reference is visible, quorum and authority are unchanged, and no notification integration exists (structural). Targeted routing and delivery: CTRL-05.

## 9. Web integration and CTRL-03 regression

Same SSR, BFF session, CSRF + exact origin, no-script CSP, `no-store`, Host-client boundary, closed failure taxonomy and PRG re-read as CTRL-03. CSRF on approve: cross-site origin, `Origin: null` and a wrong token → 403, nothing recorded. Every approval response is `no-store` under a CSP with no script source and `frame-ancestors 'none'`; no approval content in any URL, redirect location, cookie or console log line (route shapes only). CTRL-03's own suites run unchanged except two deliberate amendments of CTRL-03 pins that stated "CTRL-04 is absent": the console's write-route list now includes `/api/admin/approvals/{}/{}`, and the "no approval wiring" pin now confines approval wiring to the CTRL-04 modules and still forbids every legacy approval component.

## 10. Structural boundaries (`ctrl04-structure.test.ts`, detectors self-tested)

No CTRL-04 module reaches an approval store or re-implements a policy, quorum or proof; the Host service is handed the command port only (`list` + five commands) and re-proves the organization; the console computes no quorum, eligibility, SOD or completion; exactly one context construction, from the principal alone; the closed body; the router reads no body and builds no context; the permission matrix; the approver role's limits; the service's own CTRL-01 refusal; no role-based verdict decision; no execution or customer-plane path; no escalation tiers; no notification integration; no rail/domain/model vocabulary; approvals reached only through the server-side Host client; the seven routes and the API freeze.

## 11. Threat model, invariants, no-bypass, API

- THREAT_MODEL_V1 §7.27: 25 BLOCKED rows (each in the CORE-06 BLOCKED-claim matrix as `TM-7.27-1 … 25` with named tests), 1 PARTIAL (stolen approver credential/session), 1 NOT ADDRESSED (escalation delivery, CTRL-05), 1 ACCEPTED (naming an actor `operator:<id>` is a trusted provisioning act); accepted risk 13. CTRL-03 row TM-7.26-20 superseded.
- SEC-INV-208 … SEC-INV-215; claim 16f; SEC-INV-200 restated (no second approval engine).
- NO_BYPASS: EP-068 (approval verdicts over the operator plane, deployment-gated, the HTTP entry onto EP-059); **8 of 68** effect paths bounded-grant controlled (denominator +1). The approval reads are not effect paths.
- API 49 → 56 (`check-api-freeze`); `release/RELEASE_MANIFEST.json` is not regenerated (a pre-tag artifact, stale since CTRL-01).

## 12. Deliberate mutation campaign

See `docs/security/evidence/ctrl04-mutation-evidence.json` and the table below.

Run on a native-Linux `git archive` export of `33c8b6f` (the reviewed fix commit; everything after it is documentation and one test comment). Kill set: the CTRL-04 Host, web, unit and structural suites plus the CTRL-03, CTRL-02 and CORE-05 structural suites (107 tests, baseline 107 / 107). Each mutation edits production code, must compile, must fail a test for its intended property, and is restored byte for byte (SHA-256 before = after); afterwards the whole `src` tree was diffed against a fresh archive of the commit — identical.

**35 defined, 35 counted (compiled), 35 killed, 0 survived.** History: a first campaign on `9dd428b` was stopped after M7 (all killed) when the review's fixes changed mutated code; M12's first form did not compile (TS2367) and was excluded, its corrected form counted; a first full run on `33c8b6f` had the same results but a runner TAP-parsing bug dropped killing-test titles — the authoritative run below used the fixed runner. Full edits, all killing tests and digests: `docs/security/evidence/ctrl04-mutation-evidence.json`.

| ID | Property attacked | Change (production code) | Killing test (first) | Observed failure | Restored |
|---|---|---|---|---|---|
| M1 | approver identity (actorId) comes only from the authenticated operator | an actorId field in the command body is stripped before validation and becomes the ApprovalCommandContext actor (`approval-workflow.ts`) | “every smuggled identity, authority or state field is refused with 400 and records nothing” | UORUM_MET","reason":null,"evidence":[],"rowDigest":"sha256:6ea3a32dfb53bdb0dcad3288edde0b0b569a2c527d5f3ea22e0b79e83b2281e1"}]}} 200 !== 400 | SHA-256 equal |
| M2 | the authentication channel (authenticatedBy) comes only from the server | an authenticatedBy field in the command body is stripped before validation and becomes the recorded channel (`approval-workflow.ts`) | “every smuggled identity, authority or state field is refused with 400 and records nothing” | UORUM_MET","reason":null,"evidence":[],"rowDigest":"sha256:7781e9b2f00eb256bb8e7a90ffc7ab6b57431f729968e5c2de14b03e9c30a0e2"}]}} 200 !== 400 | SHA-256 equal |
| M3 | each verdict needs its own operator permission before the body is read | every verdict path authorizes approval.read instead of its own permission (`approval-workflow.ts`) | “each role sees exactly the verdict links its Host-reported permissions allow — and every hidden verdict, forged, is refused by the Host” | Overview Agents Authority Approvals Activity Evidence Governance Profiles Approve — approval request Refused by the authoritativ 409 !== 403 | SHA-256 equal |
| M4 | an operator role (organization-administrator) is never approval authority | the approval authority port recognizes, and grants live standing to, every organization-administrator operator (`composition-root.ts`) | “A: an operator who may reach approve but holds no Kernel-Authority standing is refused by CORE-05 — including an organization administrator” | UORUM_MET","reason":null,"evidence":[],"rowDigest":"sha256:476439b5fde21734328c32958e985b0a314b626b01c0bbcc0b6fadb64c2fd95a"}]}} 200 !== 409 | SHA-256 equal |
| M5 | approver standing is checked against the Kernel Authority | the approval authority port reports every authority check valid (`composition-root.ts`) | “wrong resource, wrong approver action, and execution authority without approval authority are all refused” | UORUM_MET","reason":null,"evidence":[],"rowDigest":"sha256:35cf3446d595d2488b2208dc85a467d839f8e6d7a7cf08c67bd6a183c4c819d2"}]}} 200 !== 409 | SHA-256 equal |
| M6 | approval authority is the profile's approverAction, never the governed action | the runtime requirement asks for authority over the governed action instead of the approver action (`evaluation.ts`) | “the agent’s real governed action is withheld; the human finds it in the inbox, inspects the exact subject, approves; nothing executes until the agent retries the SAME request — then exactly once” | duction-cluster' as operator:approver-a. Your operator role lets you reach this command; it does not grant approval authority. N 409 !== 200 | SHA-256 equal |
| M7 | an approver's standing must cover exactly the request's resource | the scope policy passes an out-of-scope approver (`approval-scope-policy.ts`) | “wrong resource, wrong approver action, and execution authority without approval authority are all refused” | UORUM_MET","reason":null,"evidence":[],"rowDigest":"sha256:36abee5058b04c5343e84b053e644b4db710b38c39465c486f2789f1b7d2c3e9"}]}} 200 !== 409 | SHA-256 equal |
| M8 | segregation of duties: the requester cannot approve its own request | the governed-path requirement no longer requires segregation of duties (`evaluation.ts`) | “segregation of duties: the requesting actor cannot approve its own request, even holding standing; another approver can” | UORUM_MET","reason":null,"evidence":[],"rowDigest":"sha256:2eb7ee77221d5d098fcfef417f2329c940657ae6a61e79cfd21c034d43004a59"}]}} 200 !== 409 | SHA-256 equal |
| M9 | one approver counts once toward quorum | the duplicate policy never fires and quorum counts approvals instead of distinct approvers (`duplicate-approval-policy.ts`, `quorum-policy.ts`) | “missing evidence is refused by the Host; 1 / 2 executes nothing; the same human twice is refused; a second human completes 2 / 2; the agent resumes once” | Expected values to be strictly equal: 200 !== 409 | SHA-256 equal |
| M10 | no pooling: a verdict belongs to exactly one approval request | list() replays every request against the whole organization's rows, and a row belongs to any request of the organization (`evaluation.ts`, `service.ts`) | “missing evidence is refused by the Host; 1 / 2 executes nothing; the same human twice is refused; a second human completes 2 / 2; the agent resumes once” | + recordedBy: 'frontera:operator-plane', + rowDigest: 'sha256:5a4a813ede5f3fa74d24dcec04a560ebab10b8524936a9af3d4206af6e4a5805' + } + ] - [] | SHA-256 equal |
| M11 | a verdict binds the subject the human reviewed | both the Host pre-check and the CORE-05 subject check are removed: any digest acts on the request (`service.ts`, `approval-workflow.ts`) | “a stale confirmation page never applies the old intent: the Host refuses it and the console re-reads the current state” | Expected values to be strictly equal: 200 !== 409 | SHA-256 equal |
| M12 | escalation never satisfies quorum | a recorded escalation is replayed as an approving verdict (`evaluation.ts`) | “requesting changes is recorded and changes nothing; escalation is discoverable in the escalated view with its reference” | n evaluated to a falsy value: ok((0, web_browser_js_1.textOf)(escalated.html).includes('Status (derived, re-read): pending; quorum 0 / 1.')) | SHA-256 equal |
| M13 | requested changes never satisfy quorum | a recorded change request is replayed as an approving verdict (`evaluation.ts`) | “requesting changes is recorded and changes nothing; escalation is discoverable in the escalated view with its reference” | The expression evaluated to a falsy value: ok((0, web_browser_js_1.textOf)(changes.html).includes('Changes were requested')) | SHA-256 equal |
| M14 | rejection is final | a rejected request still accepts approving verdicts (`service.ts`) | “a stale confirmation page never applies the old intent: the Host refuses it and the console re-reads the current state” | Expected values to be strictly equal: 200 !== 409 | SHA-256 equal |
| M15 | revocation is final | a revoked request still accepts approving verdicts (`service.ts`) | “revocation withdraws a completed approval before the retry: no execution; no restore; a second revocation is refused” | T_INVALID","reason":null,"evidence":[],"rowDigest":"sha256:e5dc211f145dfe6b3d328d28a012a3fb76e690c88fa80ba7717a1017a9ce1ebc"}]}} 200 !== 409 | SHA-256 equal |
| M16 | request expiry is enforced at the strict-before boundary | the derived request-expired state and the runtime expiration policy are both disabled (`evaluation.ts`, `expiration-policy.ts`) | “the request accepts a verdict strictly before its expiry and refuses it at the expiry instant” | UORUM_MET","reason":null,"evidence":[],"rowDigest":"sha256:3e1302982f05698a9ddd29a274a8fc8e8c03dc4d5c0e49bca87568ad7e704c22"}]}} 200 !== 409 | SHA-256 equal |
| M17 | a completed approval lapses at notAfter | the derived approval-expired state never occurs (`evaluation.ts`) | “an approval that lapses before the agent retries releases nothing” | Expected values to be strictly equal: + actual - expected + 'approved' - 'approval-expired' ^ | SHA-256 equal |
| M18 | required evidence types are enforced | the runtime requirement carries no evidence requirement (`evaluation.ts`) | “missing evidence is refused by the Host; 1 / 2 executes nothing; the same human twice is refused; a second human completes 2 / 2; the agent resumes once” | rator:approver-a Request expires (Host time) 2026-10-02T06:43:21.566Z Quorum reached at not recorded Approval usable until (Host 200 !== 409 | SHA-256 equal |
| M19 | evidence references are sha256 content hashes | the Host and CORE-05 accept any sha256:-prefixed string as a hash (`service.ts`, `approval-workflow.ts`) | “missing evidence is refused by the Host; 1 / 2 executes nothing; the same human twice is refused; a second human completes 2 / 2; the agent resumes once” | rator:approver-a Request expires (Host time) 2026-10-02T06:43:45.488Z Quorum reached at not recorded Approval usable until (Host 200 !== 400 | SHA-256 equal |
| M20 | approver standing is re-resolved at use, not only at submission | a recorded approving verdict is replayed against an always-valid authority (trusting its admission) (`evaluation.ts`) | “revoking the approver’s Kernel-Authority standing withdraws an unused approval; the retry does not execute” | the approval is withdrawn: CORE-05 re-resolves standing at every read + actual - expected + 'approved' - 'pending' | SHA-256 equal |
| M21 | a human approval never executes the governed action | the operator approval surface calls the execution adapter when an approval completes (`composition-root.ts`) | “the agent’s real governed action is withheld; the human finds it in the inbox, inspects the exact subject, approves; nothing executes until the agent retries the SAME request — then exactly once” | a human approval through the web is not an execution 1 !== 0 | SHA-256 equal |
| M22 | the operator plane never retries the governed action with the operator credential | the console's Host client posts the governed action with the operator bearer alongside every approve verdict (`host-client.ts`) | “no module mints, edits or un-revokes authority: no bounded-grant issuance, no un-revoke, no reactivation route” | {}/credentials/{}/rotate', '/api/admin/approvals/{}/{}', ... '/api/admin/governance-profiles/{}/versions/{}/{}', + '/api/governed-actions' ] | SHA-256 equal |
| M23 | the original committed decision is resumed, never re-made | the governed request id includes the time, so a retry opens a new request and a new Kernel decision (`identifiers.ts`) | “the agent’s real governed action is withheld; the human finds it in the inbox, inspects the exact subject, approves; nothing executes until the agent retries the SAME request — then exactly once” | .gar:432e120d1eeaa5765360b08376eb9234","reasonCodes":["GOVERNED_ACTION_IDEMPOTENCY_CONFLICT"]} + actual - expected + 'rejected' - 'executed' | SHA-256 equal |
| M24 | the approval digest is bound into the resumed grant's signed source | the grant source serialization omits the approval digest (`grant-source-authorization.ts`) | “withheld → discoverable in the inbox → exact canonical subject → operator approves → nothing executes → the agent retries → executed exactly once under the same decision” | the approval digest is material to the signed source bytes | SHA-256 equal |
| M25 | the console never marks a request approved without the canonical re-read | the post-verdict flash reports approved for any approve verdict (`app.tsx`) | “missing evidence is refused by the Host; 1 / 2 executes nothing; the same human twice is refused; a second human completes 2 / 2; the agent resumes once” | ssion evaluated to a falsy value: ok((0, web_browser_js_1.textOf)(first.html).includes('Status (derived, re-read): pending; quorum 1 / 2.')) | SHA-256 equal |
| M26 | no request may choose the organization of an approval read | the inbox query accepts an organizationId key (`approval-workflow.ts`) | “every smuggled identity, authority or state field is refused with 400 and records nothing” | Expected values to be strictly equal: 200 !== 400 | SHA-256 equal |
| M26b | every approval read is re-proven to belong to the served organization | the service's organization re-proof is removed (`approval-workflow.ts`) | “a request of another organization in the port’s answer is an integrity failure, never data” | expected a refusal | SHA-256 equal |
| M27 | a CTRL-01 administrator gains no approval permission | the legacy-administrator policy gains approval.read / approve / restrict (`roles.ts`) | “approval permissions per role are exactly the documented matrix” | val.restrict' + ], - 'legacy-administrator': [], 'organization-administrator': [ 'approval.read', 'approval.approve', 'approval.restrict' ], | SHA-256 equal |
| M27b | a CTRL-01 administrator credential is refused by the approval service itself | the approval service's credential-class check is removed (`approval-workflow.ts`) | “a CTRL-01 administrator credential is refused by the approval service itself, whatever the policy says (defence in depth)” | )) throw EnterpriseHttpErrors.invalidRequest("evidence[].hash must be a content hash ('sha256:' and 64 lowercase h`... 12838 more characters | SHA-256 equal |
| M28 | customer and agent credentials never reach the approval plane | an ordinary (customer) API key authenticates on the operator plane as an approver (`operator-authenticator.ts`) | “legacy administrators, customer API keys, agent credentials and unknown credentials never reach the approval plane; an approver credential is not a customer credential” | customer API key GET /api/admin/approvals 200 !== 403 | SHA-256 equal |
| M29 | a stale page never applies the old intent to a changed subject | the Host silently substitutes the request's current subject digest for the reviewed one (`approval-workflow.ts`) | “a stale confirmation page never applies the old intent: the Host refuses it and the console re-reads the current state” | Expected values to be strictly equal: 200 !== 409 | SHA-256 equal |
| M30 | CTRL-04 has no external notification side effect (CTRL-05) | an escalation is posted to an external webhook (`approval-workflow.ts`) | “no model, AI or remote-inference dependency, no network, process or dynamic code” | src/enterprise/operator-control/approval-workflow.ts must not match /node:net\|node:http\|node:https\|node:dns\|\bfetch\s*\(/ true !== false | SHA-256 equal |
| M31 | the web approval code reaches no approval store | the console imports the approval store module (`app.tsx`) | “every import is the console’s own, React, a Node server primitive, or one of the two reused presentation components” | src/control-plane-web/app.tsx must not import '../enterprise/approval-authority/in-memory-approval-store.js' true !== false | SHA-256 equal |
| M32 | a double submission never counts an approver twice or completes twice | CORE-05 commands are no longer serialized: concurrent commands judge the same history (`service.ts`) | “concurrent double submissions: one approver counts once; one completion, one approval digest, one execution” | Expected values to be strictly deep-equal: + actual - expected [ 200, + 200 - 409 ] | SHA-256 equal |
| M33 | an escalation over the operator plane carries a routable reference | the escalation-reference rule is removed (`approval-workflow.ts`) | “escalation routing: recorded with its reference, discoverable in the escalated view without knowing the id, no quorum, no authority” | ESCALATED","reason":null,"evidence":[],"rowDigest":"sha256:dbcd5c8b5b62878ff952e656bbec1c97a969311f7889b888806606dcb8be83ff"}]}} 200 !== 400 | SHA-256 equal |

## 13. Adversarial review

Two independent, read-only reviews by a fresh agent that had not written the code.

**Review 1 — `9dd428b`.** No critical, high or medium defect; CORE-05 semantics and the CTRL-04 properties preserved. Low findings, all fixed in `33c8b6f`:

| # | Finding | Disposition |
|---|---|---|
| L1 | An integrity failure during a command was worded "nothing was changed", but CORE-05 re-reads the store after its append, so the command may have been recorded | Fixed: the command path says whether it was recorded is unknown; the console's integrity guidance no longer claims a write changed nothing (unit-tested) |
| L2 | "Escalation reference (required)" was enforced only by the browser | Fixed: the Host requires a reference on every escalation over the operator plane (400) — a CTRL-04 routing rule, not a CORE-05 change (Host + unit tests, mutation M33) |
| L3 | ADR prose misstated the malformed-hash error | Fixed (400 `INVALID_REQUEST` vs 409 `APPROVAL_EVIDENCE_INSUFFICIENT`) |
| T1–T4 | Organization re-proof pinned only by regex; one-context scan limited to a file list; a misleading test comment; a loose anonymous-POST assertion | Fixed: executed by `ctrl04-approval-workflow-service.test.ts`; scan over every production source; comment corrected; redirect to sign-in asserted |
| T5 | `operator:` is a naming convention, not a type | Accepted, documented (ADR R-3) |

The old review was invalidated by the fix commit.

**Review 2 — `33c8b6f`.** L1, L2 and the test gaps confirmed closed without regression; no code defect. Remaining items: the CTRL-04 documentation was not yet in the commit (it is committed with this document); this document overclaimed that the role-matrix probe "reaches CORE-05" (corrected: the Host's subject pre-check refuses it first; routing is pinned structurally and exercised end to end) and one test comment overclaimed (corrected, comment only); and a design residual now stated explicitly — an organization administrator, holding every permission, can assemble a quorum-1 self-approval loop through an agent it controls (ADR R-8, THREAT_MODEL §7.27 ACCEPTED row). Informational: a millisecond-boundary race can name a closed refusal `pending`; the context-construction pin is syntactic; the approval log is replayed per read (R-6).

## 14. Validation

Working copy (ext4 mirror of the worktree, after every code commit and with the documentation): typecheck, lint, build green; root 8 993 tests (8 980 pass, 0 fail, 9 skipped, 4 todo); workspaces 1 089 / 1 089; CTRL-04 Host 25 / 25, unit 6 / 6, structural 20 / 20, web E2E 11 / 11; CTRL-02/03 and CORE-05 suites green (544 tests in the focused run); API freeze 56 endpoints (7 added); release docs, SDK surface green; legal report pre-existing findings only (no dependency added); `git diff --check` clean, no conflict markers. Two independent adversarial reviews (`9dd428b`: three low findings, fixed in `33c8b6f`; `33c8b6f`: no code defect; one design residual stated, ADR-CTRL-04 R-8). 35 mutations, 35 killed. `release/RELEASE_MANIFEST.json` still states its stale count (a pre-tag artifact): regenerate before tagging. The final commit's own clean `git archive` export run (no commit after it) is reported in the milestone report.

Timing: no WSL timing anomaly was observed; the expiry boundary is qualified on an injected clock (no sleeps), and console sessions keep CTRL-03's monotonic clock.

## 15. Residual risks (not claimed)

SSO / MFA / phishing resistance (PROD-04) — a stolen approver credential or session approves within that operator's standing, bounded by quorum; escalation delivery and targeted routing (CTRL-05); one canonical trace of approval facts with the governed request (ASSURE-01); evidence authenticity (ASSURE-02/03); approval-store backup (PROD-02); pilot qualification (PROD-03); TD-5; external artifact truth. New, CTRL-04-scoped: an organization administrator holds every permission (CTRL-02 D3) and can therefore assemble a quorum-1 loop alone — issue an agent credential, give `operator:<self>` approver standing, request as the agent and approve as the operator; segregation of duties compares actor ids, and the agent and the operator are different actors (ADR R-8; mitigate with quorum ≥ 2 and separate operators for provisioning and approval); approval standing is assigned by naming a Kernel-Authority actor `operator:<operatorId>` (a trusted provisioning act — ADR R-3); repeated escalations / change requests record repeated inert facts (R-5); `list()` replays the whole approval log per read (R-6, pilot scale).

## 16. Verdict

The CTRL-04 implementation gate (ADR-CTRL-04 §1.1) is proven literally against the real shipped Host (`bootEnterpriseHost()`, secure profile) and the real web control plane (`createControlPlaneWebServer()`), from clean stores, through HTTP and HTML forms only: **CTRL-04 APPROVAL & ESCALATION WORKFLOW VERIFIED** — subject to the final commit's clean-export run reported in the milestone report. PILOT READY is not claimed: PROD-02, ASSURE-01 and PROD-03 remain.
