# AUTH-04B — Secure Authority session and API boundary

**Status:** implemented and CI-qualified through private in-process fixtures
only. **Disabled by default.** It has not been deployed, has no DNS or TLS, and
receives no external traffic. One Host process, one organization. There is no
UI (AUTH-04C).

## 1. Architecture

```
Safari (iPhone) ── https://authority.frontera-systems.com ── TLS proxy (future; preserves Host)
                                                                  │
                     ┌──────────────── Host process ──────────────┴──────────────────────┐
                     │  Authority gateway (own listener; AOC_ENTERPRISE_AUTHORITY_GATEWAY_*)│
                     │   A  passkey sign-in ──► AUTH-02 recognition (durable challenge)     │
                     │   B  session (memory) — who, never may                              │
                     │   C  inbox ──────────► humanAuthority.inbox (same standing port as  │
                     │                         CORE-05; role; SoD; pending only)           │
                     │   D  decision challenge / submission ─► AUTH-03 channel             │
                     │   F  decision status (read-only, own decisions only)                │
                     │                                │                                    │
                     │  enterprise.humanAuthority (AUTH-04A, in-process) ─► CORE-05        │
                     │  Host API listener (unchanged): no /authority path, no reference    │
                     └─────────────────────────────────────────────────────────────────────┘
```

- **Separate listener.** The gateway is never a route of the Host API: the
  public API has no Authority path, and a structural test forbids every Host
  route, adapter, API, administration, operator-plane or console source from
  naming it.
- **Separate concerns.** A: authentication (AUTH-02). B: session. C: read
  scope. D: per-decision WebAuthn (AUTH-03). E: the CORE-05 command, reached
  only through the AUTH-03 channel after its own verification. F: status.
- **No second engine.** The inbox filters with the **same** approver-standing
  port CORE-05 judges with (hoisted, not copied). CORE-05 still decides every
  verdict.

## 2. API (all under `/authority/v1`)

| Method & path | Auth | Purpose |
|---|---|---|
| `POST /session/login/options` | Origin | AUTH-02 authentication options; sets the one-shot `__Host-frontera_authority_login` cookie that binds the ceremony to this browser |
| `POST /session/login` `{assertion}` | Origin + login cookie | Verifies the passkey (AUTH-02). On success, creates a **new** session id (rotation) and returns the CSRF token |
| `GET /session` | session | Who is signed in |
| `POST /session/logout` | session + CSRF | Ends the session |
| `GET /approvals` | session | The human's eligible pending requests |
| `GET /approvals/:id` | session | One eligible request: canonical subject bytes (re-hashed to its digest), subject, requirement, expiry, quorum, allowed verdicts |
| `POST /approvals/:id/decision-challenges` `{subjectDigest, verdict}` | session + CSRF | One AUTH-03 challenge (≤ 120 s) for the session's human, the Host's organization and this exact subject and verdict |
| `POST /decisions` `{assertion}` | session + CSRF | Submits the decision through the AUTH-03 channel |
| `GET /decisions/:commitment` | session | Read-only status of the caller's own decision |

On every request:
- `Host` must equal the Authority origin's host (`421` otherwise).
- Any `Authorization` header is refused (`AUTHORITY_BEARER_REFUSED`).

On every POST:
- `Origin` must equal the public origin.
- The body must be `application/json`.
- The body takes a **closed** set of fields. A caller-supplied
  `organizationId`, `operatorId` or `actorId` is refused, never ignored.

Every response carries `no-store`, a CSP of `default-src 'none'`, `DENY`
framing, `nosniff`, `no-referrer` and HSTS.

## 3. Sign-in

- The Host generates the challenge (AUTH-02 `beginAuthentication`, user verification required, discoverable credential).
- The challenge is bound to the browser by a one-shot `__Host-` login cookie, which prevents login CSRF and cross-browser completion.
- AUTH-02 checks the RP ID and origin, user verification, an active principal and credential, the counter, and durable single-use challenge consumption (a chained, signed, witnessed row).
- The session is bound to the operator id and the credential used. The organization is the Host's own.
- There is no password and no fallback.

## 4. Session

- 256-bit random id, held only in the `__Host-frontera_authority_session` cookie (`HttpOnly; Secure; SameSite=Strict; Path=/`, no `Domain`).
- A 256-bit per-session CSRF token, sent as the `x-frontera-csrf-token` header (never stored in script storage).
- Absolute lifetime and idle timeout on a monotonic clock (defaults 1 h and 15 min; configurable).
- Rotation on every sign-in: a planted or previous id is never adopted.
- Logout, plus re-validation on **every** request: a revoked human or revoked sign-in credential ends the session (tested).
- **No authority in session data:** the operator id, credential id, CSRF token, timestamps, and the commitments issued to it. A structural test pins these fields.
- **Restart and session loss:** sessions live in memory (single-process pilot). A restart drops every session and the human signs in again. Nothing authorizes from memory: challenges and their consumption are durable and witnessed.

## 5. Inbox scope

A request is visible only when **all** of these hold:
- it is pending and not superseded;
- the human is an active principal;
- their configured role reaches a verdict;
- they are neither the requester nor its principal;
- they hold **live** approver standing (the same Kernel-Authority port CORE-05 uses).

Anything else returns the same `404` as a request that does not exist, so
nothing is enumerable. Redacted: no store ids, signatures, paths, other
approvers' identities, operator keys or administrative metadata.

## 6. Decisions

**Challenge issuance.** The request must be in the human's inbox, the verdict
must be one their role reaches, and the subject digest must equal the current
one. The client receives only the WebAuthn options, the commitment, the exact
subject digest, the verdict and the expiry.

**Submission.** The assertion must answer a decision challenge issued **to
this session**, for this human (`AUTHORITY_DECISION_NOT_YOURS` otherwise). A
consumed decision answers `409` with its status link, never a second attempt.
Everything else is the AUTH-03 channel's own checks:
- credential ownership, active human and credential, RP ID and origin;
- the exact commitment (verdict and subject), one-time use;
- CORE-05 standing and segregation of duties, request expiry and status.

A session alone, a login assertion, another session's challenge, or another
human's challenge never decide anything (tested).

## 7. Failure, reconciliation and UI states

AUTH-04A semantics are unchanged. `GET /decisions/:commitment` is the
deterministic, read-only status after a lost response:

| Gateway field | Value | UI state |
|---|---|---|
| `decision` | `challenge_open` | pending (not yet signed) |
| `decision` | `challenge_expired` | expired |
| `decision` | `approved` / `rejected` | approved / rejected (CORE-05 holds the verdict citing this decision) |
| `decision` | `refused` (+ `code`) | rejected by policy (e.g. no standing) — not a verdict |
| `decision` | `abandoned` | abandoned (consumed, no verdict; reconciled at restart) |
| `decision` | `unsettled` | outcome unknown, being settled — show "checking", never success |
| `request.status` | `pending` · `approved` · `rejected` · `revoked` · `request-expired` · `approval-expired` | request state as CORE-05 derives it |
| `execution` | always `not_observed` | **execution_unconfirmed** — Authority never observes execution and never reports it as confirmed |

Guarantees:
- **No duplicates or replays:** no duplicate verdict on retry, and no replay of a consumed assertion.
- **No invented outcomes:** no automatic re-approval, no fabricated execution confirmation, and no promotion of an unconfirmed outcome to success.
- **Fail closed:** sign-in and decisions fail closed (`5xx`) while CORE-07 freshness cannot be established (tested).

## 8. Exposure model

- **Defaults:** `AOC_ENTERPRISE_AUTHORITY_GATEWAY_MODE` defaults to `disabled`. Enabling it requires `AOC_ENTERPRISE_HUMAN_AUTHORITY_MODE=enabled`, which in turn requires a witness, SQLite, software custody, operators and CORE-05.
- **Public origin and binding:** `…_PUBLIC_ORIGIN` must be an `https` origin listed in the relying party's allowed origins. The listener binds to loopback by default (`…_HOST`, `…_PORT`).
- **Deployment target:** behind a TLS proxy for `authority.frontera-systems.com` that preserves `Host`. This was **not** configured here.
- **Tests:** CI runs the gateway on loopback inside the test process only.

## 9. Bootstrap enrolment — design (approved in principle; implemented by AUTH-04B2, see `AUTH-04B2-SECURE-CTO-PASSKEY-ENROLMENT.md`)

Today a human can be enrolled only **in-process** (AUTH-02 service through
`enterprise.humanAuthority.identity`, with an administrator built from a CTRL-02
organization-administrator principal). A deployed Host started by the launcher
has no in-process embedder, so a real pilot needs a bootstrap path. Any such
path is **a new privileged API or provisioning utility**, so per the
authorization it is presented here and **not built**:

**Proposed (smallest):**
1. **Administrator act, on the existing private operator plane:**
   `POST /api/admin/human-identity/enrolments`, authorized by the existing
   CTRL-02 operator authenticator for role `organization-administrator` only
   (never the Authority gateway).
   - It creates the principal if needed (the operator id must be configured)
     and returns a **one-time, short-lived (≤ 15 min) enrolment token**: AUTH-02
     `fre1.` format, verifier-only at rest, single use, revocable.
   - The shared operator bearer authenticates the *administrator*. It is never
     the enrolment credential, and it never reaches a browser.
2. **Out-of-band hand-off** of the enrolment token to the CTO (in person or a
   separate channel).
3. **Registration on the Authority gateway:**
   `POST /authority/v1/enrolment/options` then `/enrolment` take the token
   (Origin and JSON checks) and run AUTH-02 registration with the pinned RP and
   origin and user verification required. No session is created, and no
   self-registration exists without a token.
4. **Audit:** each step is a chained, signed, witnessed AUTH-02 row (who
   authorized, which credential).

Alternative: an offline provisioning CLI that opens the identity store with
the authority signer and the witness, used only while the Host is stopped. It
needs the same token hand-off, so it adds operational risk without removing
the token.

**Decision requested:** approve (1)–(4) as an AUTH-04B-follow-up (or AUTH-04C)
increment, or choose the CLI.

## 10. Dependencies and CodeQL

- No new dependency: the gateway uses `node:http` and `node:crypto` only.
- `apps/agent-passport-web` and its Next.js tree (issue #210) are neither imported nor reused (structural test).
- Issue #210's Critical/High alerts all resolve to `apps/agent-passport-web`, which this boundary does not load.
- CodeQL result: see the PR checks.

## 11. Remaining restrictions

- No UI, no push, no deployment, no DNS/TLS (AUTH-04C+).
- Bootstrap enrolment requires the founder decision in §9.
- Sessions are in memory: one Host process, lost on restart.
- backup:v1 excluded the identity store (AUTH-04A) until AUTH-04D1.
- External key custody is still unsupported for the identity store.
- No rate limiting beyond bounded ceremony and session tables. The future proxy should add per-IP limits.
