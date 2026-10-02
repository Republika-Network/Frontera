# CTRL-03 — Web Control Plane MVP: Qualification

- **Roadmap item:** CTRL-03 (`docs/architecture/FRONTERA-MASTER-PLAN.md` §9)
- **Branch:** `feat/ctrl-03-web-control-plane-mvp`, from `main @ 846af3c`
- **Decision record:** `docs/architecture/ADR-CTRL-03-WEB-CONTROL-PLANE.md`
- **Exit gate (an implementation qualification gate, not a quotation from the Master Plan, which states CTRL-03's scope but no literal criterion):** *An identified CTRL-02 human operator can open the shipped Frontera web control plane and, using HTTP only, identify the organization / operator context; inspect the real agent inventory; inspect standing authority, delegation and effective limits; onboard (the supported stages of) an agent; issue the agent credential with the secret revealed exactly once; assign bounded standing authority using canonical action/resource and typed parameter bounds; inspect the resulting canonical state after a server re-read; revoke / restrict authority where the role permits; inspect the activity and evidence available from the shipped Host — while a read-only operator cannot mutate, a legacy CTRL-01 administrator gains no CTRL-02 powers, an agent / customer credential cannot enter the operator UI/API plane, the browser never reads a database or in-process runtime, and UI state can never create or expand authority.*

## 1. Discovery (before CTRL-03, `main @ 846af3c`)

| Area | Finding |
|---|---|
| HTTP surface | 47 endpoints (`release/api-surface.v1.json`). The operator plane (CTRL-02) covers organization/operator context, agent inventory, credentials, Kernel-Authority listing and provisioning, Governance Profile lifecycle; CTRL-01 covers grant/execution/entity inspection, revocation and emergency controls |
| Activity over HTTP | **None for operators.** Governance records are readable only by id and only with a customer/API-key credential (`resolveGovernanceAccessContext`); `GovernanceStore.query` exists in process but was never routed (API_STABILITY_V1 §5); the P8 stream has no read route; operator lifecycle facts exist on the Kernel-Authority, credential and profile records |
| Evidence over HTTP | Evidence bundles are customer-credential authenticated and in-memory; `GovernanceStore.verify` exists for one record but only behind the customer read route |
| Frontend stack | React 18 + `react-dom` (dev / optional peer); the legacy library is tested with `renderToStaticMarkup`. **No bundler, DOM emulator or browser automation exists in the lockfile** (Next is only inside `apps/agent-passport-web`) |
| Legacy surfaces | `src/features/aoc-control-plane` (157 files, pure-props panels over an **in-process** read model, "Soberanía" chrome, CTRL-04 approve/reject/escalate commands); `packages/control-plane` (orphan fs store); `packages/control-plane-sdk` (types only); `apps/agent-passport-web` (separate product); `apps/{dashboard,…}` (`.gitkeep`) |
| Host serving | JSON only; no static files, CSP, framing or CORS headers |
| ASSURE-01 | Not landed: no canonical end-to-end trace |

Reconciliation decision and table: ADR §1.1. One shipped control plane after CTRL-03 — the web console over the Host's operator API; `AocEmptyState` and `AocErrorState` are the only legacy components reused (pure, unbranded, command-free; structurally pinned).

## 2. What was built

ADR D1–D19, in one line each: a script-free, server-rendered console (`src/control-plane-web`, `npm run start:control-plane`) behind a same-origin BFF session that keeps the operator bearer server-side; one HTTP client boundary with a closed failure taxonomy; Host-reported permissions as the only UX input (no role table; the Host refuses forged operations); staged onboarding; the one-time credential reveal; generic authority and typed-limit display with lineage; closed, strictly serialized provisioning forms; delegation that restates the parent's own bounds; confirmed revocation with no un-revoke; permitting profile promotion labelled as such; truthful activity and evidence with coverage stated; and two read-only operator-plane endpoints (47 → 49).

## 3. The canonical web qualification, executed

`src/control-plane-web/__tests__/ctrl03-web-control-plane-host.test.ts`. One shipped Host (`bootEnterpriseHost()`, secure profile: SQLite, required authentication, Ed25519 authority signing, external freshness witness; operators configured; **no** static customer principal; `profileLifecycle: operator-promoted`; the deploy domain with `replicaCount` (integer, maximum) and `deploymentStrategy` (token, exact)), a **clean** store, nothing seeded after boot, no in-process helper; and the shipped console (`createControlPlaneWebServer()`, what the launcher runs) pointed at it. Every operator step is an HTML page and an HTML form, driven by the browser harness (§9); ground truth is read back from the Host's own API with an observer credential.

| Step | Through the web | Proven against the Host |
|---|---|---|
| 1–3 | `ops-admin` signs in; Overview; Agents | the organization, operator id, role and permission list shown are the Host's; the inventory and the Kernel Authority are empty |
| — | issuer actor, trust domain, root issuer via the closed forms | each recorded with `provisionedBy: operator:ops-admin` |
| — | `ops-steward` activates `deploy-production@1` (confirmation page) | the confirmation calls activation permitting and "not harmless", shows the digest the Host reports; without the checkbox nothing is sent; then `active`, `activatedBy: operator:ops-steward` |
| 4 | `ops-provisioner` provisions the owner, then onboards the agent (`/agents/new`) | redirected to the re-read agent page: actor `active`, credential `none`, standing authority `none` — not shown as complete |
| 5–7 | "Issue credential" | the secret (`fra1.agc-….…`) appears **exactly once** in the issuing page (`no-store`); absent after dismissal, reload, the list; re-submitting the same form replays at the Host and shows no secret; one credential recorded |
| 8 | passport, capability token, authority grant with bound rows `deploymentStrategy = rolling`, `replicaCount ≤ 3`; "Delegate (narrower) from this grant" | the delegation form is prefilled with the parent's own bounds (`3`, not wider); the recorded delegation carries exactly `[deploymentStrategy exact rolling, replicaCount maximum 3]`, attributed to `ops-provisioner` |
| 9 | the agent and delegation pages after the redirect | all three stages recorded; the credential row is the Host's; the lineage shows `replicaCount ≤ 3` on each hop; the bound renders as `replicaCount integer maximum (inclusive) 3` |
| 10 | (the agent, not the console) the revealed credential on `POST /api/governed-actions` | `replicaCount 2` → `executed`, adapter calls 1 with exactly `[deploymentStrategy=rolling, replicaCount=2]`; `replicaCount 4` → `withheld` (`authority-binding`, `PARAMETER_AUTHORITY_EXCEEDED`), adapter calls still 1 |
| 14a | `ops-observer`: Activity, Evidence, the bounded grant | the decision rows are exactly the Host's decisions in its order, with its ids, times, actors and statuses; the executed decision's evidence is "Integrity verified" and links its recorded grant; the withheld decision shows *no grant* and *no execution recorded* (none fabricated); the signed grant bounds `replicaCount ≤ 2` (narrower than standing) |
| 11–13 | `ops-provisioner` revokes the delegation (confirmation: exact target, type, status, terminal, reason) | redirected to the re-read entity: `revoked`, `revokedBy: operator:ops-provisioner`, reason recorded; no revoke or un-revoke offered; the agent's next request does not execute, adapter calls unchanged |
| 14b | Activity, lifecycle table | one row per recorded transition — every entity provisioned, the one revocation, every credential, the profile activation — with the record's time, operator and reason; nothing invented, nothing dropped |
| — | every response, URL, cookie, console log line and Host log line | the agent secret appears in exactly one response; no operator credential is ever rendered, put in a header, cookie or URL, or logged |

## 4. Role × operation matrix through the web

`ctrl03-web-roles-host.test.ts`, real Host, real console, each role signed in through the web. Two independent halves:

**(a) What is shown** — derived only from the permissions the Host reported (and every one of those permissions is listed on the Overview):

| Role | Provision | Bootstrap kinds | Issue credential | Rotate | Revoke credential | Revoke actor | Activate profile | Emergency stop |
|---|---|---|---|---|---|---|---|---|
| organization-administrator | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| provisioner | ✓ | — | ✓ | ✓ | ✓ | ✓ | — | — |
| responder | — | — | — | — | ✓ | ✓ | — | ✓ |
| profile-steward | — | — | — | — | — | — | ✓ | — |
| observer | — | — | — | — | — | — | — | — |

**(b) What the Host refuses** — for every operation a role lacks, a forged form posted through the console with that role's own valid session and CSRF token reaches the Host and is refused there: the console answers 403 showing the Host's `OPERATOR_PERMISSION_DENIED`, and the Host's state (entities, agents, credentials, profile states, emergency controls) is byte-identical before and after. 22 forged cases: provision (responder, steward, observer), bootstrap (provisioner, responder, steward, observer), issue credential (responder, steward, observer), revoke authority (steward, observer), activate profile (provisioner, responder, observer), emergency stop (provisioner, steward, observer), emergency release (provisioner, responder, steward, observer). The allowed side is exercised too: a responder revokes and stops, an administrator releases, a steward promotes.

**Credential-plane matrix:**

| Credential | Console sign-in | Operator API | Governed-action API |
|---|---|---|---|
| CTRL-02 operator (any role) | ✓ session | its permissions | 401 |
| CTRL-01 administrator | **403**, no session ("a CTRL-01 administrator credential" cannot open the console) | CTRL-01 routes only; 403 on the CTRL-03 reads | 401 |
| Operator-issued agent credential | **401**, no session | 401 | its Kernel decision |
| API key (customer / legacy) | **403**, no session | 403 | its principal |
| Unknown | **401**, no session | 401 | 401 |

No refused credential is ever echoed. Host-side the two CTRL-03 reads were also put through the CTRL-02 service matrix (6 caller classes × every operation; `ctrl02-operator-control-service.test.ts`) and `ctrl03-activity-evidence-host.test.ts`.

## 5. One-time-secret matrix

| Property | Evidence |
|---|---|
| The issuing response contains the secret once | canonical 5–7 (`split(secret).length - 1 === 1`); `ctrl03-web-units.test.tsx` (rendered page) |
| Agent list / agent detail / reload contain no secret | canonical 5–7 and 9 |
| A resubmission (browser "resend") shows none | canonical 5–7 (Host replay, `bearerCredential: null`) |
| Rotation reveals the new secret once; the old one stops authenticating | `ctrl03-web-roles-host.test.ts` › rotation (old → 401 at the Host) |
| Browser persistence | no script exists; no storage API in any console module (`ctrl03-structure.test.ts`); cookies hold only the opaque session id and the sign-in token (canonical secret sweep) |
| Console logs / Host logs / error pages | canonical secret sweep over both loggers; request logs carry method, route shape and status only (structural pin) |
| URL / history / headers | canonical sweep over every visited URL, every response header and every cookie |
| Clipboard | no clipboard feature exists (it would need script); nothing is copied automatically |

## 6. Activity and evidence truthfulness

| Row | Canonical source | Proven |
|---|---|---|
| Decision row | `GovernanceStore.query` via `GET /api/admin/activity/decisions` | canonical 14a: ids, times, actor, status and order equal the Host's |
| Lifecycle row | Kernel-Authority / credential / profile records | canonical 14b: one row per recorded transition; the revocation row's time, operator and reason equal the record's |
| Missing field | — | unit: a revoked record with no `revokedAt` / `revokedBy` renders *not recorded* and *incomplete*, is listed last, and is never given a time; a stray `revokedAt` on an active record yields no revocation row |
| Evidence record + verification | `GET /api/admin/evidence/decisions/{id}` (record + `GovernanceStore.verify`) | canonical 14a; Host test: a tampered record (`UPDATE governance_evaluations …`) verifies **invalid**; unit: "Integrity verified" only for `valid: true`, qualified when legacy-unprotected references exist |
| Missing downstream | references | canonical 14a + unit: no `authorization_artifact` → "No bounded grant is recorded for this decision", with the reason stated as not recorded |

Coverage statements are rendered on both pages; neither is called an end-to-end trace (ASSURE-01).

## 7. API surface

**47 → 49.** `GET /api/admin/activity/decisions` and `GET /api/admin/evidence/decisions/{evaluationId}` (ADR D19; `release/api-surface.v1.json`; API_STABILITY_V1 §2.8; AOC_AUTHORITY_ADMINISTRATION_API §11). Why each is necessary: committed governed-action decisions — the only canonical record of what agents did — and their verification were reachable by no operator credential. Nothing else was added: no write, no SDK method, no broad dump; `check-api-freeze` confirms exactly the two new patterns and no other drift. `release/RELEASE_MANIFEST.json` still states 28 endpoints — the pre-existing stale release-tag artifact (Master Plan §14); not regenerated here.

## 8. Structural boundaries (`ctrl03-structure.test.ts`, measured scope, detectors self-tested)

The console imports only its own modules, React, `react-dom/server`, Node server primitives and the two reused presentation components — no `src/enterprise`, Kernel, Kernel Authority, composition root, Governance Store, bounded-grant store, signer, key, `better-sqlite3`, `fs`, fixture, operator-control module or legacy command/read-model service; exactly one module performs network I/O (the Host client: one `fetch`, `redirect: 'manual'`, no logger); one `Authorization` header in the whole console; request logs carry method, route shape and status only; no `localStorage` / `sessionStorage` / IndexedDB / `document.cookie` / clipboard / service worker / `dangerouslySetInnerHTML` / `<script>` / `eval`; no `script-src` in the CSP; no role names and no role comparison; the request handler never asks `may()`; no bounded-grant issuance or un-revoke; the console's Host writes are exactly the CTRL-01/CTRL-02 operator routes; no CTRL-04 approve/reject/escalate/quorum wiring; no rail, protocol, wallet, domain or model vocabulary; Frontera chrome, no "Soberanía"/"AOC Control Plane". Host side: the operator service holds the Governance Store's read half only, and both reads authorize `inventory.read` first with an organization-scoped, non-system context. The no-bypass network-site inventory lists the console's Host client as the fourth outbound site (EP-067).

## 9. The browser harness — and why it is enough, and what it does not check

The console ships no client-side script, so a browser's entire behaviour toward it is: GET, keep cookies, follow redirects, render, and submit forms as `application/x-www-form-urlencoded`. `__tests__/web-browser.ts` does exactly that, submitting the forms the server rendered (hidden fields, selected options, textareas) with the operator's typed values, and — since the adversarial review (§12) — computing `Origin` and `Referer` from each page's referrer policy exactly as the Fetch standard and Referrer Policy specification do, rather than injecting them. It does not render CSS or layout; visual behaviour is not machine-checked (residual). No browser-automation dependency was added (none exists in the lockfile, and none is needed to exercise a script-free application faithfully).

## 10. Threat model, invariants, no-bypass

- THREAT_MODEL_V1 §7.26: **21 BLOCKED** rows (each mirrored as `TM-7.26-1` … `TM-7.26-21` in the CORE-06 BLOCKED-claim matrix with named executable evidence, machine-checked by `core06-qualification-structure.test.ts`), **3 PARTIAL** (stolen session cookie; a compromised server-side dependency; back/forward re-display of the secret page), **2 NOT ADDRESSED** (phishing of the operator credential — PROD-04; a hostile configured Host URL — trusted configuration). Accepted risk 12. Browser UX, HTTP authorization and canonical authority are kept apart; UI gating is never claimed as a boundary.
- SECURITY_INVARIANTS §4.21: SEC-INV-200 … SEC-INV-207; claim 16e.
- NO_BYPASS: EP-067 (the console process; its one outbound call reaches the Host operator API; everything it can change is EP-062 … EP-066, authorized again by the Host); **8 of 67** effect paths bounded-grant controlled. The two new reads are not effect paths (as CTRL-02's reads are not).

## 11. Deliberate mutation campaign

Run on a native-Linux `git archive` export of `d4598a2` (the code after the adversarial-review fixes) by a scripted runner kept outside the repository. Method: an unmutated **baseline** first (kill set: 9 suites, 420 tests, 0 fail); then each mutation edits real production source (every `find` verified to occur exactly once), must compile (`tsc -b`; a compile failure is never counted), runs the kill set (`node --test --test-concurrency=1`), and is restored from its original bytes with the SHA-256 of each file compared before and after; after the campaign the whole `src` tree was diffed against a fresh export of the commit: identical. **40 counted mutations on that export, 40 killed** — and, after the session-clock fix (§12), **M38 plus re-runs of M31, M32 and M37 on `c5bc444`, all killed: 41 counted, 41 killed, 0 survivors.** They attack the console (M1–M12, M14, M15, M20–M37), the two new Host reads (M16–M19) and the Host’s credential-plane separation (M13). No test was mutated.

**Committed evidence:** `docs/security/evidence/ctrl03-mutation-evidence.json` — per mutation: the exact edits, compile result, every killing test’s full title (up to 12), the observed failure, and the before and restored SHA-256 of each mutated file.

**History, kept honestly:** M13’s first form named `configuration.authentication.operators` and did not compile; it was excluded and its corrected form (`configuration.administration.operators`) counted. M33 … M37 were added for the adversarial-review findings (§12). M33 changes only the referrer-policy *header*; the page’s `<meta name="referrer">` — which a browser lets override the header — still said `same-origin`, so M33 is killed by the header assertion alone. M33b changes both, reproducing the review blocker as first shipped, and is killed by the canonical sign-in through the browser-faithful harness and by every browser flow after it.

**M38, kept honestly:** its first run (on `6aa81c3`) **survived** — the new unit test replaced `Date.now` after the store had captured its clock function, so it never reached a wall-clock store. The test was strengthened (`c5bc444`: the stub is installed before the store is built and stepped through a variable) and M38 was then killed. The addendum, with both runs, is in the evidence file.

| ID | File | Semantic change | Property attacked | Killing test (full title; first of N) | Observed | N | Restoration |
|---|---|---|---|---|---|---|---|
| M1 | `app.tsx` | a Host 403 on agent onboarding becomes a success flash and a redirect | server 403 treated as UI success | responder → provision an agent actor (authority.provision): the Host answers 403 OPERATOR_PERMISSION_DENIED and nothing changes | Agents — Frontera Control Plane Frontera Control Plane Organization org-pilot Trust domain trust-domain-pilot Operator ops-responder (responder) Sign  | 4 | SHA-256 equal |
| M2 | `layout.tsx` | may() answers true for any permission | role gate removed (UI permission gating) | no role table: no module compares a role name; permission questions are the Host-reported list, asked in one helper | The input did not match the regular expression /export function may\(context: OrganizationContext, permission: string\): boolean \{\s*return context\. | 6 | SHA-256 equal |
| M3 | `app.tsx` | the console imports the Kernel-Authority store type | direct store/runtime import allowed into the browser app | every import is the console’s own, React, a Node server primitive, or one of the two reused presentation components | src/control-plane-web/app.tsx must not import '../enterprise/kernel-authority/kernel-authority-store.js' | 1 | SHA-256 equal |
| M4 | `app.tsx` | the issued secret is kept in the session flash and shown on the next page | one-time credential persisted after the response | 5–7: the credential is generated, its secret shown exactly once, and gone after dismissal, reload and replay | Expected values to be strictly equal: | 2 | SHA-256 equal |
| M5 | `pages-core.tsx` | the "continue to the agent" link carries the secret in its query | credential leaked into the detail view URL / history | 5–7: the credential is generated, its secret shown exactly once, and gone after dismissal, reload and replay | the secret appears exactly once in the issuing page | 3 | SHA-256 equal |
| M6 | `forms.ts` | a maximum bound row is dropped from the request | typed parameter maximum omitted from the provisioning request | 8: the provisioner assigns bounded standing authority — action, resource and a typed replicaCount ≤ 3 — through closed forms | Expected values to be strictly deep-equal: | 8 | SHA-256 equal |
| M7 | `forms.ts` | a maximum bound is serialized one higher than typed | typed parameter maximum widened in UI serialization | 8: the provisioner assigns bounded standing authority — action, resource and a typed replicaCount ≤ 3 — through closed forms | Expected values to be strictly deep-equal: | 8 | SHA-256 equal |
| M8 | `app.tsx` | an entity revocation renders the write response instead of redirecting to a fresh read | revocation response not followed by canonical refetch | 11–13: the provisioner revokes the delegation through the web; canonical state is re-read; the agent can no longer execute | re-read after the write | 2 | SHA-256 equal |
| M9 | `pages-records.tsx` | the activate control is shown on inventory.read instead of profile.promote | profile promotion treated as unprivileged | provisioner: controls shown exactly per its Host-reported permissions | Expected values to be strictly deep-equal: | 3 | SHA-256 equal |
| M9b | `app.tsx` | the activation warning calls it routine and non-permitting | profile promotion presented as harmless | a profile steward activates the deploy-production catalog version — a permitting operation, deliberately confirmed, at the reviewed digest | The expression evaluated to a falsy value: | 7 | SHA-256 equal |
| M10 | `activity.ts` | a revocation row is emitted from a stray revokedAt on an active entity | fabricated activity row without a canonical source | a missing time or operator is reported missing — never filled in — and revocation is never inferred from a stray field | status, not a stray timestamp, says what happened | 1 | SHA-256 equal |
| M10b | `activity.ts` | a revocation with no recorded time is given the provisioning time | fabricated activity time | a missing time or operator is reported missing — never filled in — and revocation is never inferred from a stray field | Expected values to be strictly equal: | 1 | SHA-256 equal |
| M11 | `pages-records.tsx` | "Integrity verified" is rendered whatever the store says | fabricated evidence verification rendered as verified | evidence says "verified" only when the store’s verification is valid | The input was expected to not match the regular expression /Integrity verified/. Input: | 1 | SHA-256 equal |
| M12 | `app.tsx` | a refused fra1. credential still gets a console session | agent credential accepted on the operator plane in the web client flow | an unknown credential, an agent credential and an API key are refused; none gets a session | fra1.agc-b3f | 1 | SHA-256 equal |
| M13 | `composition-root.ts` | customer admission is composed with the operators’ secrets as API keys | operator credential used as a customer action credential | planes stay separate at the Host: an agent credential on the operator plane is 401; an operator credential as a customer is 401 | Expected values to be strictly equal: | 2 | SHA-256 equal |
| M14 | `host-client.ts` | the Host client gains an approve call | CTRL-04 approval command accidentally wired | no module mints, edits or un-revokes authority: no bounded-grant issuance, no un-revoke, no reactivation route | the console writes only through the CTRL-01 / CTRL-02 operator routes | 9 | SHA-256 equal |
| M15 | `forms.ts` | a form organizationId is copied into the provisioning request | organization id accepted from browser input | the organization is the Host’s: organization, operator, system and provenance fields smuggled into a form or a query change nothing | Provision actor — Frontera Control Plane Frontera Control Plane Organization org-pilot Trust domain trust-domain-pilot Operator ops-provisioner (provi | 2 | SHA-256 equal |
| M16 | `service.ts` | the activity read authorizes authority.inspect instead of inventory.read | decision activity readable by a CTRL-01 administrator | both reads authorize inventory.read before anything else, with an organization-scoped, non-system store context | listDecisionActivity authorizes first' | 3 | SHA-256 equal |
| M17 | `service.ts` | the Governance Store context becomes system | activity/evidence read with a system (cross-organization) context | both reads authorize inventory.read before anything else, with an organization-scoped, non-system store context | The input did not match the regular expression /const governanceContext: GovernanceStoreAccessContext = Object\.freeze\(\{ system: false, organization | 2 | SHA-256 equal |
| M18 | `contracts.ts` | organizationId / tenantId / system become accepted query keys | organization accepted in the activity query | the query is closed: an organization, a tenant or any other key, and malformed values, are refused before the store is read | organizationId=org-other | 1 | SHA-256 equal |
| M19 | `service.ts` | the evidence DTO reports valid: true whatever verify returned | evidence verification fabricated at the Host | a tampered decision record is reported by the store’s verification as invalid — never as verified | Expected values to be strictly equal: | 1 | SHA-256 equal |
| M20 | `app.tsx` | a POST is accepted without the session CSRF token | CSRF token check removed | a POST without the session’s CSRF token, from another origin, or with no origin is refused and writes nothing | no token | 2 | SHA-256 equal |
| M21 | `security.ts` | any Origin is accepted for a state-changing request | Origin check removed | a POST without the session’s CSRF token, from another origin, or with no origin is refused and writes nothing | cross-origin | 3 | SHA-256 equal |
| M22 | `security.ts` | the session cookie loses HttpOnly | session cookie readable by script | the session cookie is opaque, HttpOnly, SameSite=Strict; every response carries the security headers | The input did not match the regular expression /HttpOnly/. Input: | 2 | SHA-256 equal |
| M23 | `security.ts` | the CSP gains script-src 'unsafe-inline' | CSP allows inline script | no module stores anything in the browser or ships a script | the CSP grants no script source' | 2 | SHA-256 equal |
| M24 | `failures.ts` | every 503 is classified unavailable (recorded:true ignored) | recorded refresh failure shown as not recorded | only an explicit recorded:true makes a 503 a recorded write; any other 503 is unknown-for-a-write, never "unwritten" | Expected values to be strictly equal: | 2 | SHA-256 equal |
| M25 | `host-client.ts` | redirect: 'follow' | Host client follows redirects | exactly one module performs network I/O — the Host client — and it holds no state, follows no redirect and logs nothing | The input did not match the regular expression /redirect: 'manual'/. Input: | 2 | SHA-256 equal |
| M26 | `app.tsx` | sign-in logs the presented credential | operator credential logged | no secret in any response but the one reveal, any URL, any cookie, the console log or the Host log | no log line carries an operator credential | 2 | SHA-256 equal |
| M27 | `app.tsx` | the delegation form prefills each parent maximum plus one | delegation editor suggests a wider value than the parent | 8: the provisioner assigns bounded standing authority — action, resource and a typed replicaCount ≤ 3 — through closed forms | Expected values to be strictly deep-equal: | 7 | SHA-256 equal |
| M28 | `pages-agents.tsx` | the standing-authority stage always renders assigned | partially onboarded agent rendered as complete | 4: an identified provisioner onboards the agent through the web — the actor stage only, shown as such | a partially onboarded agent is not shown as complete' | 1 | SHA-256 equal |
| M29 | `pages-agents.tsx` | the revoked-actor notice is suppressed | revoked actor rendered as still holding a working credential | a revoked actor is never shown as holding authority through a still-active credential | The input did not match the regular expression /This agent’s actor is revoked\./. Input: | 1 | SHA-256 equal |
| M30 | `app.tsx` | onboarding refuses locally on the reported permission list, never asking the Host | console decides authorization instead of the Host | responder → provision an agent actor (authority.provision): the Host answers 403 OPERATOR_PERMISSION_DENIED and nothing changes | the refusal is the Host’s own — the console forwarded the operation' | 3 | SHA-256 equal |
| M31 | `session.ts` | only the absolute lifetime ends a session | session idle expiry removed | absolute and idle expiry, destruction, opaque ids, and a clock moved backwards ends the session | idle timeout | 1 | SHA-256 equal |
| M32 | `app.tsx` | logout clears the cookie but keeps the session | sign-out does not destroy the server-side session | sign-out needs the CSRF token, destroys the server-side session, and the old cookie no longer opens anything | the destroyed session opens nothing' | 1 | SHA-256 equal |
| M33 | `security.ts` | the console's referrer policy becomes no-referrer | referrer policy makes real browsers send Origin: null | the referrer policy lets a browser send the console’s true Origin on its own form posts — never `null` (no-referrer would make every form look forged) | Expected values to be strictly equal: | 1 | SHA-256 equal |
| M33b | `security.ts` `layout.tsx` | both the referrer-policy header and the page meta become no-referrer | console documents make real browsers send Origin: null (the review blocker, as shipped) | 1–3: an operator signs in, sees the server-derived organization and operator context, and the clean inventory | Expected values to be strictly equal: | 55 | SHA-256 equal |
| M34 | `app.tsx` | the re-rendered issue form gets a fresh key | failed credential issue loses its idempotency key | a failed credential issue shows the failure on the re-read agent page and keeps the same idempotency key for the same-request retry | The input did not match the regular expression /name="idempotencyKey" value="console-issue-key-0001"/. Input: | 1 | SHA-256 equal |
| M35 | `app.tsx` | only the first four parent bounds are prefilled | delegation prefill drops parent bounds | a delegation form restates every parent bound — five bounds render five prefilled rows, none dropped | row 4' | 1 | SHA-256 equal |
| M36 | `pages-records.tsx` | the not-covered qualification is never shown | verification overstated over legacy-unprotected references | a verified record with legacy-unprotected references says those references are not covered | The input did not match the regular expression /data-testid="unprotected-references"/. Input: | 1 | SHA-256 equal |
| M37 | `app.tsx` | sign-in no longer ends the earlier session | an earlier session survives a new sign-in | a successful sign-in ends any earlier session of the same browser | Expected values to be strictly equal: | 1 | SHA-256 equal |
| M38 | `session.ts` | the session store reads Date.now instead of a monotonic clock | console sessions timed on the wall clock | sessions are timed on a monotonic clock: a wall-clock step backwards or forwards neither ends nor extends one | The expression evaluated to a falsy value: | 1 | SHA-256 equal |

## 12. Adversarial pre-push review

An independent, read-only adversarial review of the first complete candidate (`74174eb`) concluded **FAILED**:

| Finding | Disposition |
|---|---|
| **BLOCKER B1** — `Referrer-Policy: no-referrer` makes a browser send `Origin: null` on every form POST (Fetch standard), so the origin check refused every form — sign-in included — in any real browser; the harness injected the true `Origin` and hid it | **Fixed in code**: `same-origin`; `Origin: null` refused explicitly; the harness now derives `Origin`/`Referer` from the page's policy as the standard does, so a `no-referrer` regression fails sign-in in the canonical E2E (mutation M33) |
| MEDIUM — the qualification document cited everywhere did not exist yet | This document |
| MEDIUM — a failed credential issue lost its idempotency key, contradicting the same-request retry guidance | **Fixed**: the re-read agent page keeps the key (M34) |
| MEDIUM — delegation prefill showed only four parent bounds; the Host requires all to be restated | **Fixed**: every bound row up to the Host's 32 is rendered and read (M35) |
| LOW — "every success redirects" overclaimed (issue/rotate render the one-time reveal) | **Reworded** everywhere it was claimed |
| LOW — "Integrity verified" silent about legacy-unprotected references | **Fixed**: qualified on the page (M36) |
| LOW — shallow shape guards | **Fixed**: boolean checks, emergency control required |
| LOW — actor filter applies to decisions only, unlabelled | **Fixed**: labelled |
| LOW — session hardening (earlier session survives sign-in; no `__Host-`, no HSTS on HTTPS) | **Fixed** (M37) |
| LOW — bound values trimmed | **Fixed**: taken as typed |

**Found by the final clean-export run (after this document was first written):** the CTRL-03 E2E step lost an operator's session mid-run. Diagnosed before touching any test: the WSL wall clock of the qualification host was measured stepping **back 36 ms** within 20 s, and the session store — timed on `Date.now` — treated any backward reading as expiry. That is a product defect, not only an environment quirk (NTP and hypervisor resyncs step clocks; a backward step could equally have *extended* a session): sessions are now timed on a monotonic clock (`6aa81c3`), tested with the wall clock stepped an hour either way (mutation M38).

Also found by self-review before the external review: `fetch` resolves `.`/`..` path segments, so an identifier of `..` could have sent a confirmed operation to a different Host route — fixed (refused, nothing sent) and tested.

## 13. Validation

**Clean export (candidate)** of `f2906b0` — all code, tests and security documentation after the adversarial-review fixes — into a fresh native-Linux (ext4) directory: 0 files containing CR; `npm ci`, `clean`, typecheck, lint, build green; root **8 930 tests: 8 917 pass, 0 fail, 0 cancelled, 9 skipped, 4 todo** (the 4 todo are the pre-existing FRONTERA-PROD-01 F1 rows); workspaces **1 089 tests, 1 089 pass, 0 fail**; the CTRL-03 browser E2E (canonical + role matrix) **49 / 49**; API freeze **49 endpoints** (47 + 2, no other drift); release docs (24 documents) and SDK surface (5 frozen exports, no SDK change) green; `legal:check` pre-existing findings only (busboy/streamsearch license metadata; two unnamed workspace manifests); 0 conflict markers. One mutation (M33b) ran on a separate export while this validation was in progress. The first "final" run (of `d7ea302`, nothing else running) then found the session-clock defect (§12): root 8 930 / 0 fail and workspaces 1 089 / 0 fail, but the standalone CTRL-03 E2E step 46 / 49 — three role-matrix cases redirected to sign-in after the wall clock stepped back. Fixed in `6aa81c3` / `c5bc444`; the authoritative final run of the last commit is in the milestone report.

**Focused suites** (same export, 0 fail each): CTRL-03 web (units, structure, canonical, role matrix) 101; CTRL-03 Host reads 7; CTRL-02 (`ctrl02-*`) 299; CTRL-01 64; governed action 386; CORE-03 parameters + compatibility 41; CORE-04 trusted context 21; no-bypass, security invariants and the CORE-06 BLOCKED-claim matrix 87; the legacy `aoc-control-plane` library 256 (unchanged).

**Working copy** (Windows-mounted checkout): typecheck, lint, build, API freeze, release docs, SDK surface, legal report and `git diff --check` green; the CTRL-02 / CTRL-03 suites 397 + the doc-pin suites 195, 0 fail.

The commit that adds this section is documentation only; it is re-validated on its own clean export (milestone report), and nothing is committed after that run.

## 14. Residual risks (not claimed)

Bearer-secret operator sign-in (no SSO, MFA or phishing resistance — PROD-04); a stolen session cookie is that operator until idle/absolute expiry or sign-out; sessions live in one console process's memory (a restart signs everyone out; no shared session store); the one-time secret page relies on `no-store` against back/forward re-display; activity and evidence are assembled from separate canonical records, not one verifiable trace (ASSURE-01), and decision verification is digest integrity, not authenticity (ASSURE-02); the reason a request was withheld after an `allowed` decision is not recorded in the Governance Store; evidence bundles and approval state are not on the operator plane (ASSURE-01, CTRL-04); visual rendering and responsive layout are not machine-checked; `react` / `react-dom` are optional peers of the runtime package and must be installed where the console runs (PROD); the console trusts its configured Host URL; one organization per Host. Everything CTRL-02 left residual is unchanged (control-plane store rollback, overlapping standing grants, permitting profile promotion, TD-5). **PILOT READY is not claimed:** CTRL-04, PROD-02, ASSURE-01 and PROD-03 remain.

## 15. Verdict

**CTRL-03 WEB CONTROL PLANE MVP VERIFIED** — on the code after the adversarial-review fixes. The implementation gate is executed through the shipped Host and the shipped web console, browser-faithful, from a clean store (§3); every role's controls follow the Host's reported permissions and, independently, every forged operation a role lacks is refused by the Host (§4); the agent secret appears in exactly one response (§5); every activity and evidence row is a canonical Host record (§6); 41 of 41 counted mutations are killed (§11). PILOT READY is not claimed.
