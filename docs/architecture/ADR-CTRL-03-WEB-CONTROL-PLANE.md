# ADR — CTRL-03: Web Control Plane MVP

- **Status:** ACCEPTED (CTRL-03), 2026-10-01
- **Roadmap item:** CTRL-03 (`docs/architecture/FRONTERA-MASTER-PLAN.md` §9)
- **Builds on:** CTRL-01 (`AOC_AUTHORITY_ADMINISTRATION_API.md`), CTRL-02 (`ADR-CTRL-02-OPERATOR-AGENT-IDENTITY.md`), CORE-03 typed parameters, CORE-04 one organization per Host
- **Qualification:** `docs/security/CTRL-03-WEB-CONTROL-PLANE-MVP.md`

## 1. Context

CTRL-02 made Frontera operable over HTTP: an identified operator can onboard an agent and assign it bounded authority with `curl`. CTRL-03 makes that capability usable through a web control plane — without source changes, `curl`, a REPL, database access, in-process runtime handles, or any path around CTRL-02 authorization.

The Master Plan states CTRL-03's scope (agents, authorities, limits, activity, evidence; reuse `src/features/aoc-control-plane` panels *if they fit*; no PAY work) but no literal exit criterion. This item qualifies against the following **implementation gate** — stated here, not quoted from the Master Plan:

> An identified CTRL-02 human operator can open the shipped Frontera web control plane and, using HTTP only: identify the organization / operator context; inspect the real agent inventory; inspect standing authority, delegation and effective limits; onboard (the supported stages of) an agent; issue the agent credential with the secret revealed exactly once; assign bounded standing authority using canonical action/resource and typed parameter bounds; inspect the resulting canonical state after a server re-read; revoke / restrict authority where the role permits; inspect the activity and evidence available from the shipped Host — while a read-only operator cannot mutate, a CTRL-01 administrator gains no CTRL-02 powers, an agent / customer credential cannot enter the operator plane, the browser never reads a database or in-process runtime, and UI state can never create or expand authority.

### 1.1 What existed (discovery on `main @ 846af3c`)

| Surface | Status | Data source | Mutation source | Fit for CTRL-03 | Decision | Reason |
|---|---|---|---|---|---|---|
| `src/features/aoc-control-plane` (React panels, 157 files) | LIBRARY-ONLY; rendered by no app | `buildControlPlaneReadModel(bundle)` over **in-process** runtimes (recognition, authority graph, approval, handshake, enforcement) and a demo fixture | `ControlPlaneCommandService` wrapping in-process runtimes (`ApprovalRuntime`, `AuthorityGraphRuntime`, `AocGuard`) | Components are pure props, but bound to the legacy `AocControlPlaneReadModel` vocabulary, carry "Soberanía" chrome, and include CTRL-04 approve/reject/escalate wiring | **Reuse `AocEmptyState` and `AocErrorState` only**; leave the rest library-only | Only these two fit the HTTP DTOs unchanged. Every panel would need the in-process read model or an adapter that re-invents the Host's DTOs in the legacy shape; `AocDecisionBadge` maps statuses onto a different vocabulary (reinterpretation); `AocTimeline` is typed to the five legacy runtimes |
| `packages/control-plane` | SUPERSEDED / orphan | `fs` JSON file in `process.cwd()` | its own service | No | Not revived | Legacy access-request store; zero consumers |
| `packages/control-plane-sdk` | DOCUMENTED ONLY | — | — | No | Not revived | Two interfaces, no consumer, no tests |
| `apps/agent-passport-web` | Separate product (Next 14, own SQLite, Stripe) | its own DB | its own routes | No | Untouched | No connection to `src/enterprise`; a second identity system; TD-5 |
| `apps/{dashboard,audit-console,agent-gateway,policy-engine}` | ABSENT (`.gitkeep`) | — | — | Not as a home | Left empty | No build convention for a non-Next app under `apps/`; a workspace would duplicate the root's TypeScript build and test wiring |

There is **one** control plane after CTRL-03: the web console over the Host's operator API. The legacy React library stays a library (its demo/pilot consumers are unchanged); it is not a second authoritative control plane because it is rendered by no shipped process.

## 2. Decisions

### D1 — The application: `src/control-plane-web`, React server rendering, no new dependency

The console is a module of the root runtime package (`src/control-plane-web/`), compiled by the existing `tsc -b` (the base config already sets `jsx: react-jsx`), tested by the existing `node --test` glob, and started by `npm run start:control-plane` (`scripts/run-control-plane-web.mjs`), the same convention as the Enterprise Host (`src/enterprise/host` + `scripts/run-enterprise-host.mjs`). Its UI stack is the repository's existing one: React 18 rendered on the server with `react-dom/server` — exactly how the legacy library is already rendered in tests. No framework, bundler, browser automation or other dependency was added (none exists in the lockfile; adding a bundler for a client-side app was not justified, see D2).

`react` / `react-dom` stay what they were: optional peer dependencies of the runtime package, installed by `npm ci`; the Host never loads them. Packaging the console for a `--omit=dev` install is productization (residual R-9).

### D2 — No client-side script at all

Every page is server-rendered HTML; every operation is an HTML `<form>` POST. The Content-Security-Policy is `default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'` — **no script source exists**, so an injected `<script>` or event handler does not run. Consequences, all deliberate:

- There is nowhere in the browser for a credential to live: no `localStorage`, `sessionStorage`, IndexedDB, `document.cookie` access or service worker exists to misuse (structurally pinned).
- The one-time agent secret exists only in the HTML of the one response that revealed it; it is not in any script variable, store or later page.
- There is no clipboard button (it would need script). The secret is selectable text; nothing is ever copied automatically.
- The complete browser behaviour is GET + form POST + cookies + redirects, so the qualification harness drives it faithfully without a browser engine (D16).

### D3 — HTTP only, through a same-origin server-side session (BFF)

```
browser (HTML + forms, no script)
  └─ opaque session cookie + per-session CSRF token + same-origin check     src/control-plane-web/app.tsx
      └─ HostClient — the operator bearer, server-side only                   src/control-plane-web/host-client.ts
          └─ Frontera Host operator plane (/api/admin/...)                    authenticates + authorizes every call
              └─ CTRL-01 / CTRL-02 services → canonical Kernel Authority / governance state
```

Threat-modelled alternatives:

| | Direct browser bearer (memory only) | **Same-origin BFF session (chosen)** |
|---|---|---|
| XSS steals the operator bearer | Yes, if any script runs | No: the bearer never reaches the browser after sign-in |
| Persists across reload | No (by requirement) — operator re-enters the secret on every reload | Session survives reload, bounded |
| Needs script | Yes (to hold the bearer and call the API) | No (D2) |
| Cross-origin API access | Needs CORS on the Host or same-origin static hosting by the Host | None: the console calls the Host server-to-server; the Host gains no CORS and no static files |
| CSRF | Not applicable (no cookie) | Applies — mitigated (D4) |

The console module holds **no** database, store, key, signer, Kernel, composition-root or operator-control import (structurally pinned, `ctrl03-structure.test.ts`); its only outbound I/O is `fetch` in `host-client.ts` to the configured Host origin (`https://` unless loopback), with `redirect: 'manual'`, no retry and no logging. The Host is unchanged in kind: it serves JSON only and still authorizes every call.

### D4 — Operator authentication and session

- **Sign-in:** the operator pastes their CTRL-02 bearer credential into a password field; the console calls `GET /api/admin/organization` with it. 200 → a session; 401 → "not recognized"; 403 → refused (a CTRL-01 administrator, an API key); an agent credential is unknown on the operator plane (401). No session is created for any refusal and the credential is never echoed. SSO / MFA are PROD-04.
- **Session:** an in-memory record `{ id: 256-bit random, bearer, csrfToken: 256-bit random, operatorId (for log attribution only) }`. Cookie `frontera_console_session=<id>; Path=/; HttpOnly; SameSite=Strict`; on an `https://` public origin the cookies are `__Host-`-prefixed and `Secure`, and responses carry HSTS. Idle timeout 30 min, absolute 8 h (≤ 12 h configurable); a clock moved backwards ends it; a new sign-in ends any earlier session of the same browser; sign-out (a CSRF-protected POST) deletes it server-side.
- **CSRF:** every state-changing request needs (1) an `Origin` (or `Referer`) exactly equal to the configured public origin — absent both, or `Origin: null`, refused; (2) the session's CSRF token in the form, compared in constant time; (3) `SameSite=Strict`. Sign-in uses a short-lived double-submit token.
- **Referrer policy `same-origin`, not `no-referrer`.** Under the Fetch standard a browser sends `Origin: null` on a form POST from a `no-referrer` document, which would make every one of the console's own forms indistinguishable from a forged one (the first candidate shipped `no-referrer`; the adversarial pre-push review caught that no real browser could sign in, while the test harness — which injected the right `Origin` — passed). `same-origin` sends the true `Origin` and `Referer` to the console itself and nothing to any other origin; the harness now derives `Origin`/`Referer` from each page's policy exactly as the standard does.
- **TLS / origin:** binding a non-loopback address requires an explicit `https://` public origin (TLS terminated in front of the console); the Host URL must be `https://` unless it is loopback.
- **Never:** the bearer in a URL, query, fragment, static bundle, source, browser storage, analytics (none exists), log line or rendered page.

### D5 — Organization and operator context are the Host's

Every authenticated page first re-reads `GET /api/admin/organization` and renders exactly what it returns (organization, governed-action trust domain, operator id, role, credential class, permissions). No route, query or form field selects an organization; the console has no field for one, and smuggled `organizationId` / `operatorId` / `system` / provenance fields are never copied into a request (D10). One organization per Host, unchanged.

### D6 — Role UX is presentation; the Host's permission list is the only input

The console contains no role table. `may(context, permission)` asks only whether the Host's reported permission list contains a permission, and decides which controls are *shown*. The request handler never refuses an operation on a permission it believes the role lacks (structurally pinned): a forged form is forwarded and the Host refuses it with `403 OPERATOR_PERMISSION_DENIED`, which the console shows as a refusal. The qualification proves both halves independently for every role (`ctrl03-web-roles-host.test.ts`).

### D7 — Agent inventory and staged onboarding

The inventory is `GET /api/admin/agents[/{id}]`, rendered as returned. Onboarding is shown as the CTRL-02 stages the Host records — actor provisioned, credential issued, standing authority assigned — each with its recorded value, plus a "not yet recorded" list (external subject, credential, an active passport, standing authority). A partially onboarded agent is never shown as complete; a revoked actor is shown as admitting no one whatever its credentials' status. Each stage is one idempotent Host operation; every form carries an idempotency key generated when the form was rendered, so a re-submission replays instead of writing twice. A failure shows the canonical state and what remains; nothing is rolled back that the Host did not roll back.

### D8 — The one-time agent credential

The issuing (or rotating) POST is the only response that ever contains the secret — rendered directly from the Host's `bearerCredential`, with `Cache-Control: no-store`, a warning that it cannot be recovered, and a "continue" link that leads to pages carrying metadata only. It is not stored in the session, a cookie, a URL or a log; there is no redirect carrying it. A re-submission of the same form replays at the Host (`bearerCredential: null`) and the page says so. A failed issue re-renders the (re-read) agent page with the failure and the **same** idempotency key, so a retry is the same request. Rotation states that the previous credential is revoked in the same Host transaction.

### D9 — Authority and limits are displayed as recorded, generically

Entity pages group the recorded terms — scope (subject, capability, actions, resource scopes), delegation scope, P10 monetary limits, CORE-03 typed parameter bounds as **dimension / type / bound / value** — and list any other recorded term verbatim, so nothing the Host returned is hidden. Grants and delegations show their recorded lineage, one row per hop; the console computes no combined "effective" limit (every hop applies at decision; a merged value would be a reinterpretation). No dimension has domain meaning in the console (no treasury, deploy, customer-data, rail or wallet vocabulary — structurally pinned).

### D10 — Closed provisioning forms

One declarative spec per Kernel-Authority kind mirrors the Host's closed schema field for field (`forms.ts`). The builder reads only those fields and emits only the canonical DTO: no JSON textarea, no pass-through, no field for an organization, operator, `system`, provenance, digest, signature or bounded grant. Typed bounds are rows of *dimension* (from the Host's Governance Profiles), *bound* (`maximum` integer, `exact` integer / token / boolean) and *value* (taken untrimmed, as typed), parsed strictly (no `3.0`, `+3`, `03`, unsafe integers); a half-filled row or monetary limit is a form error, never dropped; the form renders one row more than are in use and every row up to the Host's ceiling of 32 is read. The Host's validation is authoritative; its refusal is shown verbatim and the form is re-rendered with the same idempotency key.

### D11 — Delegation

"Delegate (narrower) from this grant" opens the delegation form with the source's lineage and inherited bounds displayed, and its bound rows pre-filled with **every** one of the parent's bounds at its **own** value — never a wider one, none omitted (the Host requires each upstream bound to be restated). The Host enforces attenuation (`PARAMETER_BOUND_WIDENED` / `_REMOVED`); the console shows the refusal and re-reads.

### D12 — Revocation and restriction

Every destructive or permitting operation has a confirmation page that re-reads the target from the Host and shows its exact identity, type and current status, the consequences, a reason field where the API takes one, and a required explicit confirmation checkbox. There is no un-revoke, reactivate or local rollback anywhere; revoked authority offers no revoke link and says restoring capability means new provisioning. After success the console redirects to the canonical page (re-read).

### D13 — Governance Profiles

The catalog is shown with id, version, digest, state, governed parameters, the catalog content's own authorship claim (labelled as such) and the promotion / retirement record. Activation is labelled a **permitting** governance operation ("not harmless"); its confirmation shows the exact digest (sent as the compare-and-set), the version it will supersede, and that it creates no authority. Content is not authored over HTTP (configuration + restart, unchanged). No approval workflow wraps promotion (CTRL-04).

### D14 — Activity: two canonical sources, coverage stated

1. **Governed-action decisions** — `GET /api/admin/activity/decisions` (new, D19): committed Kernel decisions as the Governance Store recorded them, newest first, filterable and paged. The column is labelled **Kernel decision** — an `allowed` decision withheld afterwards (for example by standing parameter authority) is not shown as executed.
2. **Recorded lifecycle transitions** — projected purely from the existing reads (Kernel-Authority entities: provisioned / revoked; agent credentials: issued / revoked; profile versions: activated / retired), with each record's own id, time, operator and reason; a missing field is shown as *not recorded*, never filled in.

Both pages state their coverage, and an actor or status filter is labelled as applying to decisions only. Neither is called a canonical end-to-end trace: operator actions and governed requests are not on one verifiable trace until ASSURE-01 (residual R-4). Bounded-grant revocations and emergency stops have no listing and are inspected directly.

### D15 — Evidence: the decision record and the store's own verification

`GET /api/admin/evidence/decisions/{evaluationId}` (new, D19) returns the decision record (request summary, Kernel decision, reason codes, chain position, aggregate digest), its references (grant, execution attempt and outcome) and `GovernanceStore.verify`'s result. The console says "Integrity verified by the Governance Store" **only** when that result is `valid: true`, explains it is digest integrity — not a signature (ASSURE-02), not compliance — and says so when legacy-unprotected reference rows (which never make `valid` false) are not covered by it. A decision with no grant reference says so and that the reason is not recorded there. Evidence bundles (`/api/evidence/*`, customer-credential authenticated, in-memory) are not exposed on the operator plane (residual R-5). No model or generated explanation exists anywhere.

### D16 — Errors, caching and the qualification harness

The Host client classifies every non-2xx into a closed taxonomy (unauthenticated, unauthorized, validation, idempotency conflict, refused, not found, recorded-refresh-failed, integrity-failed, unavailable, unknown); a 2xx with an unexpected body is *unknown*, never rendered as state. `503 AUTHORITY_STATE_REFRESH_FAILED` with `recorded: true` is its own kind with "the write WAS durably recorded — retry the SAME request" guidance and the same idempotency key kept; an unavailable write is *unknown*, never "nothing changed". No write is retried automatically; no state is updated optimistically; every success is followed by a redirect to a fresh Host read — except a credential issue or rotation, whose one-time reveal page *is* the Host's write response and links to a fresh read; every page is `no-store`. A 2xx whose body fails the console's shape guard (including non-boolean verification checks) is a contract failure, never rendered.

The qualification harness (`__tests__/web-browser.ts`) is a faithful browser for a script-free application: it keeps cookies, follows redirects, submits the forms the server rendered (with their hidden fields and default selections) as `application/x-www-form-urlencoded` with the page's `Origin`, and records every response for secret scanning. It does not render CSS or layout; that is not machine-checked (residual R-10).

### D17 — CTRL-04 boundary

No approval inbox, approve, reject, request-changes, escalate or quorum UX ships; the legacy approval components are not imported; the console has no approval route and its Host client no approval call (structurally pinned). Approval state is not displayed (the Host exposes no approval read; CORE-05's command port is in-process).

### D18 — No PAY, rail or domain coupling

The console carries no XRPL, Lightning, x402, Stripe, QNT, Overledger, wallet or payment vocabulary, and no domain vocabulary (structurally pinned). Money appears only where the Host's data is a P10 monetary constraint.

### D19 — API surface 47 → 49

The scope cannot be met over the 47 endpoints: committed decisions are readable only by id with a **customer** credential, and the Governance Store query was never routed (API_STABILITY_V1 §5). Two read-only operator-plane endpoints were added over capabilities that already exist in process — nothing else:

| Method | Path | Permission | Source |
|---|---|---|---|
| GET | `/api/admin/activity/decisions?actorId=&decisionId=&requestId=&status=&limit=&cursor=` | `inventory.read` | `GovernanceStore.query`, organization-scoped (`system: false`) |
| GET | `/api/admin/evidence/decisions/{evaluationId}` | `inventory.read` | `GovernanceStore.getByEvaluationId` + `verify` |

`inventory.read` is held by every CTRL-02 role and never by a CTRL-01 administrator, an API key or an agent credential. Closed query strings (an organization is refused), restated DTOs (no request payload, no store row), mounted only when operators are configured. The operator service receives the store's read half only (`query`, `getByEvaluationId`, `verify` — structurally pinned). `release/api-surface.v1.json` 47 → 49.

## 3. Consequences and residual risks

- **R-1 Operator credential theft** = that operator within its role (bearer secrets; no SSO/MFA/rate limiting — PROD-04). The BFF narrows *browser* exposure (the bearer is not in the browser after sign-in) but the operator still types it once.
- **R-2 Session theft** = that session until idle/absolute expiry or sign-out (HttpOnly, SameSite=Strict, no script; not bound to a client).
- **R-3 Session store is process memory**: a console restart signs everyone out; one console process per deployment (no shared session store).
- **R-4 Activity is not a canonical trace** (ASSURE-01): decisions and lifecycle transitions come from separate records; operator actions are attributed per store; withholding reasons after an `allowed` decision are not recorded in the Governance Store.
- **R-5 Evidence bundles are not on the operator plane**; decision-record verification is integrity only (ASSURE-02).
- **R-6 Back/forward cache**: the secret page is `no-store` (which keeps it out of the HTTP cache and, in current browsers, the back/forward cache); a browser that ignores that could re-display it from memory. The secret is never re-fetched from anywhere.
- **R-7 The console trusts the Host it is configured with** (operator credentials are sent to that origin).
- **R-8 Approval state** is not shown (CTRL-04 owns the approval UX and any approval read).
- **R-9 Packaging**: `react` / `react-dom` are optional peers of the runtime package; a production image must install them (PROD).
- **R-10 Visual rendering** (CSS, layout, responsive behaviour) is not machine-checked; behaviour (HTML, forms, cookies, headers) is.
