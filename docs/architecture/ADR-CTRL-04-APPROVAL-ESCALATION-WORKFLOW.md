# ADR — CTRL-04: Approval & Escalation Workflow (human side)

- **Status:** ACCEPTED (CTRL-04), 2026-10-02
- **Roadmap item:** CTRL-04 (`docs/architecture/FRONTERA-MASTER-PLAN.md` §9)
- **Builds on (unchanged in substance):** CORE-05 (`ADR-DURABLE-APPROVALS-ON-THE-GOVERNED-PATH.md` — the approval engine), CTRL-02 (`ADR-CTRL-02-OPERATOR-AGENT-IDENTITY.md` — the operator principal and role model), CTRL-03 (`ADR-CTRL-03-WEB-CONTROL-PLANE.md` — the web console, its BFF session and truthful-display rules)
- **Qualification:** `docs/security/CTRL-04-APPROVAL-ESCALATION-WORKFLOW.md`
- **Non-goals kept:** SSO / MFA / IAM hardening (PROD-04); publicly verifiable passports (TD-5); alerts and notification delivery (CTRL-05); one canonical end-to-end trace (ASSURE-01); evidence authenticity (ASSURE-02/03); approval-store backup (PROD-02); pilot qualification (PROD-03)

## 1. Context

CORE-05 made `approval_required` resumable: one canonical approval request per committed decision, bound to its exact subject and a snapshot of the trusted requirement; approval-runtime's policies with Kernel-Authority approver standing re-resolved at submission and at use; an authenticated append-only approval log; the same committed decision resumed into a grant whose signed source binds the approval. But its command port (`enterprise.approvals`) was **in-process only**: no human could see, approve, reject or escalate a pending request through the shipped product without code. CTRL-03 shipped the web console and deliberately left the approval surface empty (its D17).

### 1.1 Implementation gate (introduced by CTRL-04)

The Master Plan names CTRL-04, its dependencies (CORE-05, CTRL-03) and its ownership (approval read and command routes, approval inbox, human approval UX, escalation routing/visibility) but **no literal exit criterion**. CTRL-04 qualifies against the following implementation gate — introduced here, **not** quoted from the Master Plan:

> From a clean secure Host and through the shipped Frontera Web Control Plane, an identified human operator can: see a real pending approval request produced by a real governed action; inspect the exact canonical approval subject and trusted requirement snapshot; inspect quorum, expiry, evidence requirements and recorded decisions; submit an approve / reject / request-changes / escalate / revoke command through HTTP only; have the server derive the human actor and authentication channel; have CORE-05 re-resolve Kernel-Authority approver standing; have quorum and SOD enforced by CORE-05; see canonical state re-read after the command; and, after sufficient valid approval, allow the ORIGINAL governed-action requester to retry/resume the SAME committed decision and execute — while an operator-plane role alone cannot create approval authority; Kernel-Authority approval authority alone cannot bypass operator-plane authentication; the requester cannot self-approve; duplicate approval does not satisfy quorum; rejection remains final; requestChanges and escalation do not satisfy quorum; expiry is enforced; revocation withdraws approval; stale or substituted subjects are refused; required evidence references are enforced; legacy CTRL-01 administrators gain no CTRL-04 permissions; customer/agent credentials cannot use the approval admin plane; the Web UI never executes the governed action as the human approver; no database, REPL or source-code access is required.

### 1.2 Discovery — the CORE-05 port as it stood (`main @ fe277ea`)

| Operation | Input | Output | Trusted context | Persistence | Transition (derived) | Authority check | SOD | Expiry | Refusals (`ApprovalAuthorityError.code`) | Idempotency |
|---|---|---|---|---|---|---|---|---|---|---|
| `pending()` | — | open views, oldest first | none (read) | none | — | standing re-resolved per verdict at read | — | request expiry at read | store corrupt/unsupported | pure read |
| `describe(requestId)` | governed `requestId` | the request's view or `undefined` | none (read) | none | — | as above | — | as above | as above | pure read |
| `approve` | `(ctx, {approvalRequestId, subjectDigest, evidence?, reason?})` | view re-read after the append | `{authenticated: true, actorId, authenticatedBy}` (own data properties) | `approved` row (actor, evidence, reason, `recordedBy = authenticatedBy`) | counts toward quorum; quorum met → `approved` | recognition + live standing for `approverAction` over exactly the resource, every hop live | requester/target barred; principal allowed | strictly before `evaluatedAt + requestTtlSeconds` | `APPROVAL_INVALID` (closed command / unknown request / other subject), `APPROVAL_APPROVER_INELIGIBLE` (+ runtime `reasonCode`, incl. `SEGREGATION_OF_DUTIES_VIOLATION`), `APPROVAL_DUPLICATE`, `APPROVAL_EVIDENCE_INSUFFICIENT`, `APPROVAL_REQUEST_CLOSED`, `APPROVAL_REQUEST_SUPERSEDED`, `APPROVAL_CONTEXT_UNTRUSTED`, store errors | a second approval by the same actor → `APPROVAL_DUPLICATE`; after completion → `APPROVAL_REQUEST_CLOSED`; commands serialized in-process |
| `reject` | same | same | same | `rejected` row | pending → `rejected` (final) | recognition + live standing | none (requester may reject) | as approve | as approve (minus evidence/duplicate) | second reject → `APPROVAL_REQUEST_CLOSED` |
| `requestChanges` | same | same | same | `requested_changes` row | none (inert) | recognition + live standing | none | as approve | as reject | each call records another inert fact |
| `escalate` | same | same | same | `escalated` row | none (inert) | recognition + live standing | none | as approve | as reject | each call records another inert fact |
| `revoke` | same | same | same | `revoked` row | pending/approved → `revoked` (final) | recognition + live standing (no admission chain) | none | — | as reject | second revoke → `APPROVAL_REQUEST_CLOSED` |

Derived states: `pending`, `approved`, `rejected`, `revoked`, `request-expired`, `approval-expired`, plus the view's `superseded` flag (trusted configuration no longer holds the request's profile/requirement). Durable facts: the six row kinds. The signed approval store, `ApprovalAuthority.assess` (orchestrator only), the Governance Profile `approval` requirement and the Host composition (`composition-root.ts`, approver standing through approval-runtime's recognition and Authority-Graph integrations over the live Kernel-Authority world plus the CORE-04 lineage revalidator) are unchanged by CTRL-04.

Gaps for a human surface: no list of every request (only `pending()`), lookup only by governed `requestId` (an operator reviews an *approval request*), and the verdict view did not expose the recorded note or evidence references (needed to make an escalation's reference visible).

## 2. Decisions

### D1 — CORE-05 is the only approval engine; CTRL-04 adds one read and presentation fields

CTRL-04 calls `enterprise.approvals`' semantics and nothing else. It adds, in `approval-authority`:

- `ApprovalCommandPort.list()` — every canonical approval request, every derived state (superseded included), oldest first: the same replay `pending()` and `describe()` run, unfiltered;
- three presentation fields on `ApprovalVerdictView` — `recordedBy`, `reason?`, `evidence[]` — restated from the authenticated row. Nothing reads them to decide; `counted` and `reasonCode` are judged exactly as before.

No store, append, state, quorum or proof writer is exposed; the orchestrator still receives `assess` only. Structurally pinned (`approval-structure.test.ts`, `ctrl04-structure.test.ts`).

### D2 — The identity bridge: `operator:<operatorId>` is the approver's Kernel-Authority actor id

CTRL-02's authenticated principal already carries the canonical identity every operator-plane store records: `actorRef = operator:<operatorId>`, built from server configuration after a constant-time credential match. It is a valid Kernel-Authority actor id (the operator plane's entity id syntax admits `:`). So:

```
Bearer credential ──► OperatorAuthenticator.authorize(header, approval.*) ──► EnterpriseOperatorPrincipal
                                                                               (credentialClass must be 'operator')
   ──► ApprovalCommandContext { authenticated: true, actorId: principal.actorRef, authenticatedBy: 'frontera:operator-plane' }
   ──► CORE-05: is `operator:<operatorId>` a recognized Kernel-Authority actor with live authority for
       the requirement's approverAction over exactly this resource?
```

The context is built in exactly one function (`approvalCommandContextFor`, `operator-control/approval-workflow.ts`) from the principal alone. **No mapping store**: an organization makes a human an approver by provisioning — over the CTRL-02 operator plane, with no code — a Kernel-Authority actor whose id is that operator's `operator:<operatorId>` and an authority grant for the approver action over the resources they may approve. Nothing is inferred from a role, a session or a credential class. `authenticatedBy` is recorded on the row (`recordedBy`) and never interpreted.

Consequences: an operator with no such actor, or whose actor lacks live standing, is refused by CORE-05 whatever their role; a Kernel-Authority actor with standing but no operator-plane credential cannot reach the HTTP command; an agent's customer-plane credential is unknown on the operator plane. A provisioner who names a Kernel-Authority actor `operator:<id>` is assigning approval standing to that operator — exactly the authority-provisioning act `authority.provision` exists for (residual R-3).

### D3 — Two separate checks: operator permission to *reach*; Kernel-Authority standing to *count*

Three closed permissions are added to the CTRL-02 policy (`roles.ts`) and one role:

| Permission | Meaning |
|---|---|
| `approval.read` | the approval inbox and one request's canonical subject, requirement and derived state |
| `approval.approve` | attempt an approving verdict — **permitting** |
| `approval.restrict` | attempt reject (final), request changes, escalate (both inert), revoke — **restrict-only** |

| Role | `approval.read` | `approval.approve` | `approval.restrict` |
|---|---|---|---|
| observer | ✓ | — | — |
| responder | ✓ | — | ✓ |
| provisioner | — | — | — |
| profile-steward | — | — | — |
| **approver** (new) | ✓ | ✓ | ✓ |
| organization-administrator | ✓ | ✓ | ✓ |
| *legacy-administrator* (CTRL-01) | — | — | — |

- **Restriction never implies expansion:** `responder` may reject, request changes, escalate and revoke but can never approve, even holding approval standing (tested).
- `provisioner` and `profile-steward` are **not** broadened: neither needs to see approval subjects (which can carry amounts, counterparties and parameters).
- `approver` holds the CTRL-02 reads and the three approval permissions — no authority, credential, profile or emergency permission — so an approver need not be an organization administrator.
- `organization-administrator` holds every permission by construction (CTRL-02 D3) — and is refused by CORE-05 like anyone else without standing (tested).
- CTRL-01 administrators gain nothing; the approval service additionally refuses any non-`operator` credential class (defence in depth).

The Host checks the permission before any body is read. Role names never reach CORE-05; no CTRL-04 module reads a role to decide a verdict (structurally pinned).

### D4 — HTTP surface: seven operator-plane routes (49 → 56)

| Method | Path | Permission | CORE-05 call |
|---|---|---|---|
| GET | `/api/admin/approvals?view=pending\|escalated\|approved\|rejected\|revoked\|expired\|superseded\|all` | `approval.read` | `list()`, filtered by derived state |
| GET | `/api/admin/approvals/{approvalRequestId}` | `approval.read` | `list()`, one request |
| POST | `/api/admin/approvals/{approvalRequestId}/approve` | `approval.approve` | `approve` |
| POST | `/api/admin/approvals/{approvalRequestId}/reject` | `approval.restrict` | `reject` |
| POST | `/api/admin/approvals/{approvalRequestId}/request-changes` | `approval.restrict` | `requestChanges` |
| POST | `/api/admin/approvals/{approvalRequestId}/escalate` | `approval.restrict` | `escalate` |
| POST | `/api/admin/approvals/{approvalRequestId}/revoke` | `approval.restrict` | `revoke` |

One explicit path per verdict, so the one permission a request needs is known before its body is read (the CTRL-01/02 convention). Mounted only when operators are configured **and** CORE-05 approvals are composed (`enterprise.operatorApprovals`); otherwise the paths are unmounted (404). The router matches a closed verb list and imports nothing from the operator plane. There is no un-reject, un-revoke, restore, delete or execute path.

**Request contract.** A JSON body (`application/json`, the operator plane's 16 KiB bound) that is closed: `{ subjectDigest, evidence?: [{type, hash, uri?}], reason? }`; anything else — `actorId`, `authenticatedBy`, `operatorId`, `organizationId`, `role`, `permissions`, `approverId`, `approvalDigest`, `proof`, `state`, `quorum`, `countedApprovers`, `system`, `signature`, `privateKey`, even `approvalRequestId` (it comes from the path) — is **refused (400), never ignored**. Strings ≤ 256 characters; ≤ 32 evidence references; hashes `sha256:` + 64 lowercase hex. Queries are closed (`view` only on the list; none on the detail). CORE-05 re-validates the command authoritatively.

**Response contract.** Operator-safe DTOs restated field by field from the CORE-05 view (`ApprovalInboxItem`, `ApprovalDetailView` with `ApprovalRequirementView`, `ApprovalQuorumView`, `ApprovalVerdictRecordView`, `ApprovalEvidenceReferenceView`): identifiers, the canonical subject (fields and exact canonical bytes), the requirement snapshot with its digest, derived status / counted approvers / expiry / `approvedAt` / `notAfter` / `approvalDigest` / `closedBy`, and every recorded verdict (kind, actor, time, channel, note, evidence references, derived `counted` and `reasonCode`, row digest). Never a store id, sequence, signature, key, chain head or raw trusted context. A command answers `{ outcome: 'recorded', verdict, approval }` where `approval` is CORE-05's re-read after the append.

**Error mapping** (deliberate, never a generic success):

| Situation | HTTP | `error.code` | `error.failure` |
|---|---|---|---|
| no / malformed / unknown credential; agent credential | 401 | `AUTHENTICATION_FAILED` | — |
| ordinary API key (recognized wrong plane) | 403 | `AUTHORIZATION_FAILED` | — |
| role lacks the permission; CTRL-01 administrator | 403 | `OPERATOR_PERMISSION_DENIED` | — |
| malformed / unknown body or query field; an escalation without a reference | 400 | `INVALID_REQUEST` | — |
| no such approval request in this organization | 404 | `AUTHORITY_ADMIN_TARGET_NOT_FOUND` | — |
| reviewed subject ≠ the request's subject | 409 | `OPERATOR_OPERATION_REFUSED` | `APPROVAL_SUBJECT_MISMATCH` |
| no live standing (unrecognized, no / wrong action, wrong resource) | 409 | ″ | `APPROVAL_APPROVER_INELIGIBLE` (+ runtime `reasonCode`) |
| requester approving its own request | 409 | ″ | `APPROVAL_SEGREGATION_OF_DUTIES` |
| the same approver again | 409 | ″ | `APPROVAL_DUPLICATE` |
| a required evidence type not cited | 409 | ″ | `APPROVAL_EVIDENCE_INSUFFICIENT` |
| request closed — by reject / revoke / expiry / completed approval / lapse | 409 | ″ | `APPROVAL_REJECTED` / `APPROVAL_REVOKED` / `APPROVAL_REQUEST_EXPIRED` / `APPROVAL_ALREADY_APPROVED` / `APPROVAL_EXPIRED` (+ `approvalStatus`, from a fresh read) |
| configuration changed since the request opened | 409 | ″ | `APPROVAL_REQUEST_SUPERSEDED` |
| approval state unverifiable (a read: nothing changed; a command: whether it was recorded is unknown — the store may fail verification on the re-read after the append) | 500 | `AUTHORITY_STATE_INTEGRITY_FAILED` | store error code |
| approval store unreadable | 503 | `AUTHORITY_STATE_UNAVAILABLE` | — (whether a command was recorded is unknown: re-read) |

Every 409 states `recorded: false`. "Quorum incomplete" is not an error: a valid approval under quorum answers 200 with the derived `pending` state.

### D5 — The subject the human reviewed is the subject decided (TOCTOU)

The approval request id is derived from `(organization, requestId, decisionId, subjectDigest)` (CORE-05), so one id has one subject. Every command must carry the `subjectDigest` the operator was shown; the Host compares it to the request's own subject before calling CORE-05 (409 `APPROVAL_SUBJECT_MISMATCH`), and CORE-05 checks it again under its serialized write. A request whose profile or requirement changed since it opened is `superseded` and accepts no command. The console's verdict form carries the digest of the page it rendered as a hidden field; after any refusal it re-reads and re-renders the **current** subject — the earlier intent is never re-applied to a new subject.

### D6 — Approval inbox and detail in the CTRL-03 console

`src/control-plane-web` gains `views/pages-approvals.tsx` (inbox, detail, verdict confirmation), `approval-forms.ts` (the closed verdict form) and three Host-client calls. Same architecture as CTRL-03: server-rendered, no script, BFF session, CSRF + exact origin on every POST, `no-store`, PRG with a fresh Host read after every verdict, the closed failure taxonomy (a verdict refusal is a `refused` 409 with its `failure` code shown verbatim). The **inbox** has one tab per derived view (pending, escalated, approved, rejected, revoked, expired, superseded, all) and labels status and quorum as *derived*. The **detail** separates *derived state* (computed by CORE-05 when the page was read) from *durable facts* (the canonical subject recorded by the governed path, and each recorded verdict with its actor, channel, note and evidence references), shows the requirement snapshot (approver action — labelled separate from the governed action — minimum approvers, request TTL, approval validity, required evidence types, snapshot digest) and the exact canonical subject bytes. Verdict links are shown per the Host-reported permissions and the derived status — UX only; the request handler forwards every verdict (structurally pinned: it never calls `may()`).

Truthful wording: after a completed approval the console says **"Approval quorum satisfied — the action has not been executed"** and that the original requester must retry its own governed action; never "action executed". Rejection and revocation are labelled final with no undo control; requesting changes is explained as recorded, inert, and requiring a new governed request for a changed action.

**Legacy components.** `src/features/aoc-control-plane/components/approvals/` (`ApprovalPanel`, `ApprovalActionBar`, `ApprovalRequestsTable`, `ApprovalQuorumIndicator`, `ApprovalDecisionDetail`, `ApprovalEvidenceList`, `ApprovalProofDetail`) was re-inspected. Every component is typed to the legacy in-process view model (`ApprovalViewModel` / `ApprovalRequestRow` in `domain/control-plane-view-model.ts`), not to the Host's DTOs; `ApprovalQuorumIndicator` decides "met" itself (`currentApprovals >= minimumApprovals`) — a UI quorum computation; `ApprovalActionBar` and `ApprovalPanel` carry `onApprove` / `onReject` / `onRequestChanges` / `onEscalate` click handlers into the legacy command service — script and command wiring the console forbids. Reusing any of them would mean an adapter re-inventing CORE-05's derived state in the legacy shape. **None is reused**; only CTRL-03's two pure components (`AocEmptyState`, `AocErrorState`) remain in use (structurally pinned: `ctrl03-structure.test.ts`).

### D7 — Approval is not execution

No CTRL-04 module reaches the customer plane, the orchestrator, an execution adapter or a grant writer (structurally pinned). An operator credential is not a customer-plane credential (401 on `/api/governed-actions`). The original requester retries with the same idempotency key; the orchestrator replays the **same committed decision** (never re-made or rewritten), CORE-05 `assess` derives `approved` and its `approvalDigest`, the grant's signed source binds it, and the pre-claim re-assessment requires the same digest (CORE-05, unchanged).

### D8 — Escalation routing: visibility, not authority

An escalation remains exactly CORE-05's: a recorded, attributable, inert verdict (it requires the escalating operator's live standing, like every verdict). CTRL-04's routing is the smallest truthful mechanism: the derived **Escalated** view lists every open request with at least one recorded escalation, each with who escalated, when, and the recorded reference (the `reason` note). The Host **requires** a reference on every escalation (400 without one) — a CTRL-04 routing rule on the operator plane, not a CORE-05 change; in-process callers of the port are unaffected. Anyone holding `approval.read` finds it without knowing the id. No tiers, targets, fallback approvers, overrides or quorum effects exist; no routing metadata was added to CORE-05 (the approval digest and quorum semantics are untouched). Targeted routing to named people, and any delivery (email, chat, SMS, push, subscriptions), are CTRL-05.

### D9 — Evidence references

The verdict form asks for one `sha256:` reference (and an optional location) per evidence type the request's requirement snapshot names. An empty row is omitted and a malformed hash is forwarded as typed — the Host refuses, never the console: a malformed hash (or a location without a hash) is `400 INVALID_REQUEST`; a required type not cited is `409` `APPROVAL_EVIDENCE_INSUFFICIENT`. References are recorded inside the verdict row's digest (CORE-05) and displayed as recorded; nothing claims the external artifact is authentic (ASSURE). No upload feature exists.

### D10 — Expiry and time

Request expiry, quorum time and approval validity are the Host's values (`requestExpiresAt`, `approvedAt`, `notAfter`), shown as "Host time". The browser clock is used for nothing. A stale page may still show a control; the Host refuses at and after the expiry instant (CORE-05's strict-before semantics, qualified with an injected clock).

### D11 — Disclosure

Approval content is readable only with `approval.read`. It is never put in a URL (ids are digests; views are closed words), a redirect location, a cookie or a log line: the Host's audit line carries operator id, organization, operation, target id and outcome; the console's request log carries method, route shape (`/approvals/:id/approve`) and status.

### D12 — Activity

The approval detail is the approval lifecycle view: every row is one CORE-05 log fact, derived values labelled derived. CTRL-04 does **not** merge approval facts into CTRL-03's Activity page and makes no end-to-end-trace claim (ASSURE-01).

## 3. Consequences and residual risks

- **R-1 Operator credential theft** = that operator within its role, and — if that operator holds approval standing — their approvals (bearer secrets; no SSO/MFA/phishing resistance: PROD-04). Quorum > 1 bounds a single stolen approver.
- **R-2 Session theft** (CTRL-03 R-2) now includes approving as that operator until expiry or sign-out.
- **R-3 Naming discipline.** Approval standing is assigned by provisioning a Kernel-Authority actor named `operator:<operatorId>`. A provisioner can therefore make an operator an approver (that is what `authority.provision` is trusted with) and must not reuse the `operator:` prefix for unrelated actors. No mapping store exists to misconfigure; the convention is documented and tested.
- **R-4 Escalation has no targeted routing or delivery** (CTRL-05).
- **R-5 Repeated escalate / request-changes record repeated inert facts** (CORE-05 semantics); harmless, visible, never counted.
- **R-6 `list()` replays every request on each read** — linear in the approval log; acceptable for a pilot Host (one organization), revisited if needed.
- **R-8 An organization administrator can close a quorum-1 loop alone.** It holds every permission by construction (CTRL-02 D3): it can issue an agent credential, provision `operator:<self>` approver standing, request as that agent and approve as itself. Segregation of duties is CORE-05's actor-id rule — the agent and the operator are different actors — so CTRL-04 does not prevent it; the organization-administrator role is trusted, as for every other permitting operation. Mitigation is configuration: quorum ≥ 2, and separate operators for provisioning (`provisioner`) and approval (`approver`). Not claimed beyond actor-id segregation.
- **R-7 Approval facts are not on a canonical end-to-end trace** with the governed request (ASSURE-01); evidence references are not verified (ASSURE-02/03); the approval store is not in `backup:v1` (PROD-02).
- Unchanged CORE-05 residuals: in-process code can still construct a command context (SEC-TRUST-001 — now the operator plane is the one HTTP constructor); rollback without a freshness witness; key/process compromise (CORE-02, AA-010).
