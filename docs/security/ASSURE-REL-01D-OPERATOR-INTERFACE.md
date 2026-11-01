# ASSURE-REL-01D — Secure Host Operator Interface

Status: implemented on `feat/assure-rel-01d-operator-interface`. Not deployed.
**This is not a commercial authorization.** `rn.sv@0.1.0` keeps
`commercialUse: restricted`; nothing here changes the framework, its evidence
policies, reviewer authorization, golden digests or historical reports.

## 1. Purpose and scope

ASSURE-PILOT-01 found that the commercial flow had no operational interface
(F04): drafting and releasing an `rn.sv@0.1.0` report was possible only by
in-process integration with the Assurance service. REL-01D exposes the
**existing** `AssuranceService` operations to authenticated human operators
through the **existing** Enterprise Host HTTP adapter, so a private, controlled
Founding Assessment pilot can run on the Host itself.

In scope: evidence submission, termination, commercial drafts, release into
durable custody, release retrieval, delivered-package verification, operator
identity on the existing Assurance routes, a reviewer-only Host mode, opt-in
registration of `rn.sv@0.1.0`, separation of duties for release, and
compare-and-set protection for non-terminal assessment writes.

Out of scope: a new identity provider or login, browser sessions, customer
self-service or portal, public report retrieval, PDF, payments, deployment,
migrations, and any change to evaluation, scoring, report content or report
formats.

## 2. Identity model

The operator identity is the **SEC-01B Assurance reviewer credential**: a
dedicated bearer secret configured for one reviewer, in the one organization the
Host serves, with explicit roles (governed-action file `assuranceReviewers`,
secret in an environment variable). The Host's duplicate-secret check keeps it
distinct from every other credential.

- A principal comes only from the service's authenticator (`authenticateReviewer`,
  constant-time comparison; a principal is trusted only if that authenticator
  issued it). `src/enterprise/api/assurance-operator-access.ts` is the single
  place an Assurance HTTP caller is resolved; it never builds a principal.
- The **organization** is the credential's. The **actor** is the credential's
  `reviewerId`. The **roles** are the credential's. No request field supplies
  any of them.
- An organization API key, an unscoped key, a CTRL-02 operator or
  administrator secret, an auditor secret and the unauthenticated system context
  are **not** reviewers, on every operator route, with or without
  `AOC_ENTERPRISE_REQUIRE_AUTH` (no loopback exemption).

### Roles

| Role | Grants |
| --- | --- |
| `assure.reviewer` | Create / evaluate / reassess assessments, submit evidence, record manual reviews (the control's required role), end attempts, draft reports, read |
| `assure.report-release` | Draft reports, release a report into custody, read |

A credential holding both roles is **not** thereby able to release an assessment
it reviewed (section 5).

### Declared identity fields

`requestedBy` (create, reassess), `actorId` (finding events), `approvedBy` and
`approverRole` (release) may be **omitted** with a reviewer credential, or must
**equal** the credential's value; any other value is refused
(`403 ASSURANCE_REVIEWER_UNAUTHORIZED`), never silently replaced.
`terminatedBy` is not accepted at all (`400`). With an organization key, the v1
fields keep their v1 meaning (the v1 path is unchanged and is not
reviewer-attributed).

## 3. Authorization matrix

`R` = Assurance reviewer credential with `assure.reviewer`; `A` = with
`assure.report-release`; `K` = organization API key; `S` = system context
(authentication disabled — loopback only — or an unscoped key).

| Operation | Route | R | A | K | S | Service |
| --- | --- | --- | --- | --- | --- | --- |
| Create | `POST /api/assurance/assessments` | ✅ actor = credential | 403 | ✅ / 401 reviewer-only | ✅ / 401 reviewer-only | `createAssessment` |
| View | `GET /api/assurance/assessments/{id}` | ✅ | ✅ | ✅ | ✅ | `getAssessment` |
| Submit evidence | `POST …/{id}/evidence` | ✅ | 403 | 401 | 401 | `collectEvidence` |
| Manual review | `POST /api/assurance/manual-reviews` | ✅ (control role) | 403 | 401 | 401 | `recordManualReview` |
| Evaluate / complete | `POST …/{id}/evaluate` | ✅ | 403 | ✅ / 401 reviewer-only | ✅ / 401 reviewer-only | `evaluateAssessment`, `completeAssessment` |
| Verify assessment | `POST …/{id}/verify` | ✅ | ✅ | ✅ | ✅ | `verifyAssessment` |
| End an attempt | `POST …/{id}/terminate` | ✅ | 403 | 401 | 401 | `terminateAssessment` |
| Draft report | `POST …/{id}/commercial-report/draft` | ✅ | ✅ | 401 | 401 | `buildCommercialReportDraft` |
| Release | `POST …/{id}/commercial-report/release` | 403 | ✅ if no review (§5) | 401 | 401 | `releaseCommercialReport` |
| List releases | `GET …/{id}/commercial-releases` | ✅ | ✅ | 401 | 401 | `listCommercialReleases` |
| Read a release | `GET /api/assurance/commercial-releases/{reportId}` | ✅ | ✅ | 401 | 401 | `getCommercialRelease` |
| Verify a package | `POST /api/assurance/commercial-releases/verify` | ✅ | ✅ | 401 | 401 | `verifyCommercialRelease` |

"Reviewer-only" is `AOC_ENTERPRISE_ASSURANCE_REVIEWER_ONLY=true`, which also
refuses `K`/`S` on finding events, signals and reassessment. Without it the v1
organization-key behaviour is unchanged (backward compatible).

**Tenant scope.** Every call runs in the credential's organization. An
assessment or release of another organization is answered exactly as an absent
one (`404 ASSURANCE_ASSESSMENT_NOT_FOUND` / `404 ASSURANCE_RELEASE_NOT_FOUND`,
the foreign organization never named); a delivered package of another
organization verifies as `RELEASE_NOT_IN_CUSTODY`. A reviewer cannot open an
assessment for another organization (`403`). Foreign evidence offered to the
Host's own assessment is rejected per reference by the SEC-01D resolver.

## 4. Release semantics

A release requires, in order: an authenticated reviewer credential holding
`assure.report-release`; the Host's organization; **durable custody** (the
SQLite Assurance Store — any other store is `503 ASSURANCE_STORE_UNAVAILABLE`
before anything is built); **separation of duties** (§5); a `READY_FOR_RELEASE`
draft rebuilt from the store; the **exact** current `contentDigest`; both
acknowledgements (`limitationsReviewed`, `commercialUseRestrictionAcknowledged`);
and an approval date not after the report's `issuedOn`.

| Situation | Answer |
| --- | --- |
| First release of a report version | `201`, `custody.outcome: committed` |
| Same approver, same content again | `200`, `custody.outcome: replayed`, the original record |
| Another approver, or other content, for a kept report version | `409 ASSURANCE_ASSESSMENT_IMMUTABLE`, `reason: commercial_release_conflict` |
| Approved digest no longer produced by the store | `409 ASSURANCE_INTEGRITY_FAILED`, `reason: approved_digest_stale` (draft again) |
| Concurrent first releases | One commits; the other is answered as replay or conflict (custody primary key) |

A replay and a conflict persist across a restart: custody is the SQLite table
`assurance_commercial_releases` (append-only, unique per `reportId`).

**Verification** (`POST /api/assurance/commercial-releases/verify`) reports the
package's integrity and the Host authority's answer separately
(`RELEASE_MATCHES_AUTHORITY`, `RELEASE_MISMATCH`, `RELEASE_NOT_IN_CUSTODY`,
`AUTHORITY_UNAVAILABLE`), always with `200`; the package is never the
authority. No route claims a digital signature: `externalSignature` is always
`EXTERNAL_SIGNATURE_NOT_AVAILABLE`.

## 5. Separation of duties

**Rule.** The credential that approves a release must not be a credential that
recorded a substantive review of that assessment. In `releaseCommercialReport`,
before any draft is built, the service lists the assessment's manual reviews
from the store and refuses (`403 ASSURANCE_REVIEWER_UNAUTHORIZED`,
`reason: separation_of_duties`) when the approver's `reviewerId` is among their
`reviewerId`s. It is enforced in the service, so in-process callers are bound
too.

**Why it is reliable.** Manual reviews are append-only records whose
`reviewerId` comes from the authenticated credential (SEC-01B); a request
cannot remove or re-attribute one. Every recorded review counts, including any
kept from before SEC-01B, and a single reviewed control disqualifies. Holding
both roles grants nothing by itself.

**Timing.** The reviews are read before the draft is built, without a lock.
That is sufficient: a release needs a `READY_FOR_RELEASE` draft, which exists
only for a `completed` assessment, and the report content is derived from the
completed assessment. A review recorded after completion (still accepted — a
pinned PILOT-01 limitation) changes no released content, and the check counts
it anyway when it is already stored, which is stricter than the content it
protects.

**What it does not prove.** It distinguishes **credentials**, not people:
two credentials issued to one person defeat it. Issue one credential per person
and keep the assessor and approver roles on different people (procedural).

## 6. Concurrency (Stage 0)

Before REL-01D, non-terminal assessment saves were last-writer-wins (REL-01B
§10): a concurrent writer's evidence or evaluation could be replaced by a
snapshot computed from an older state. Exposing evidence submission over HTTP
made that reachable by two operators, so it was fixed first.

- `AssuranceStore.saveAssessment(context, assessment, expected?)` and the
  completion commit take a precondition: the stored **status** and
  **`integrity.assessmentDigest`** the writer read (the digest does not cover the
  status, so both are compared).
- SQLite checks it inside the existing `IMMEDIATE` transaction, after the
  terminal-immutability check; the in-memory store has the same semantics.
- A stale writer writes nothing and gets `ASSURANCE_ASSESSMENT_CONFLICT`
  (`409`, `reason: concurrent_modification`, `retryable: true`). A lost race is
  never recorded as an evaluation failure.
- An end (`terminateAssessment`) re-reads, re-checks and re-binds itself to the
  newly stored content on a conflict (at most 3 attempts), so it is neither lost
  to a concurrent evaluation nor written over a newer state. Evaluation,
  evidence collection and completion do not retry: the caller re-reads.
- Every service rewrite passes the precondition; an unconditional save remains
  only for compatibility of the store interface.

Proof: `assure-rel-01d-concurrency.test.ts` races two services over two SQLite
connections to one file, with a read barrier and a forced write order. With the
precondition disabled, six of its race tests fail; with it, all pass.

## 7. Request handling, errors and logging

- Operator routes authenticate and check the role **before** reading the body.
- `POST` bodies must be `application/json` (`415`), within the 1 MiB bound
  (`400`; the connection may be closed). Evidence references have a closed field
  set and at most 500 per submission.
- Every operator response, error or not, carries `Cache-Control: no-store`.
- Errors are the standard envelope. Store failures are reported without driver
  text, SQL or paths. Unknown failures are `500 INFRASTRUCTURE_FAILURE`.
- Logging uses the closed `EnterpriseLogContext` field set: each operator action
  writes one `enterprise.assurance.operator` line (`operatorId`, `operation`,
  `assessmentId` / `reportId`, `httpStatus`, `errorCode`). No token, body,
  evidence, rationale or report content is logged; tests plant markers in all
  of them and assert their absence from logs and error bodies.
- There are no cookies and no CORS headers on the Host API, so CSRF does not
  apply: a browser cannot attach a bearer token to a cross-site request, and
  cannot read a cross-origin response. Do not add CORS to these routes.

## 8. Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `AOC_ENTERPRISE_ASSURANCE_FRAMEWORKS` | unset | `rn.sv@0.1.0` registers the exact frozen framework. An unknown entry refuses boot. |
| `AOC_ENTERPRISE_ASSURANCE_REVIEWER_ONLY` | `false` | `true`: Assurance writes accept a reviewer credential only. |
| `AOC_ENTERPRISE_PERSISTENCE_PROVIDER` | `memory` | Must be `sqlite` to release (durable custody). |
| `assuranceReviewers` (governed-action file) | none | `{ reviewerId, roles, apiKeyEnv }`; secret in the named variable. |

A Founding Assessment Host sets all of the above, binds to loopback or a private
network, and configures at least one `assure.reviewer` and one
`assure.report-release` credential held by different people.

## 9. Private-network operation

The current credentials are static bearer secrets: anyone holding one is that
reviewer, there is no rate limiting on the Host API, and rotation is a
configuration change plus restart. **Do not expose these routes to the public
internet.** Operate the Host on loopback (an SSH tunnel) or a private network
reachable only by the named operators, terminate TLS in front of it if it leaves
the machine, and keep each secret with exactly one person.

## 10. Residual risks and blockers (not resolved here)

| Risk | Status |
| --- | --- |
| Static bearer secrets, no MFA or passkey binding for release approval | Accepted for a private pilot; a passkey-bound approval (AUTH-03 decision challenge) is a later mission |
| No rate limiting on the Host API | Private-network operation only |
| Separation of duties distinguishes credentials, not people | Procedural: one credential per person |
| No external signature or timestamp on releases; a store writer can rewrite custody undetected (REL-01A A10) | Unchanged; customers confirm digests over an independent channel |
| Manual evidence is never authenticated (SEC-01C) | Unchanged |
| `commercialUse: restricted` and its nine framework blockers | Unchanged; needs a governance decision and a new framework version |
| No customer self-service retrieval or portal | Out of scope; delivery is the package plus the independent verifier |
| Evidence submission is attributed in the audit log, not in the stored assessment | The assessment records the requester and every review, ending and release; who submitted an evidence set is in `enterprise.assurance.operator` only |
| The v1 organization-key path stays available unless reviewer-only mode is on | Set reviewer-only on a Founding Assessment Host |
| Over the 1 MiB bound the shared body reader drops the connection after answering `400` | Existing Host behaviour, unchanged |

## 11. Tests

| Suite | Covers |
| --- | --- |
| `assure-rel-01d-concurrency.test.ts` | Stage 0: two-connection races (evidence, evaluations, evaluation vs end, completion vs rewrite), terminal immutability, in-memory parity, HTTP mapping, golden digests |
| `assure-rel-01d-operator-interface.test.ts` | Credentials, roles, forged identity, request hygiene, release semantics, verification and tampering, separation of duties, tenant boundary, termination, HTTP race, log and error leakage, reviewer-only mode, framework opt-in, in-memory custody refusal — all through the real Host |
| `assure-rel-01d-host-pilot.test.ts` | Stage 5: the synthetic Founding Assessment flow over HTTP on the production-posture Host, a restart, and the independent package verifier |
| `assure-pilot-01-commercial-dry-run.test.ts` | F04 inverted: exactly two callers outside the module (the adapter and the SDK client) |
| `packages/enterprise-host-sdk/__tests__/client.test.ts` | The seven SDK methods, their routes and bodies; the release request is closed |
