# AUTH-04C — Mobile-first Frontera Authority web application

**Status:** implemented and CI-qualified against private, in-process integration
fixtures. **Not deployed:** no hosting, DNS, TLS, public URL, App Store or
TestFlight. **Not tested on a real iPhone:** the browser's passkey dialog is
replaced in tests by a spec-faithful software authenticator. Deployment and
real-device qualification belong to **AUTH-04D**.

## 1. Product journey

```
Administrator (private operator plane, AUTH-04B2)        CTO on iPhone Safari (this client)
  registers the CTO as a named human                       ┌─ Register with an invitation ─► passkey created (no session)
  issues a one-time invitation ──── hand-off in person ───►│
                                                           ├─ Sign in with passkey ───────► session (HttpOnly cookie)
                                                           ├─ Approvals (eligible only) ──► Review request (exact subject)
                                                           ├─ Approve / Reject ───────────► Confirm ──► passkey ──► Host records
                                                           └─ Decision status (authoritative; execution never claimed)
```

## 2. Screen map

| Screen | Purpose | Key states |
|---|---|---|
| Sign in | Passkey sign-in, entry to registration | loading, rejected, cancelled, unsupported device, session ended |
| Register your passkey | Invitation code, user-initiated passkey creation | invalid/expired/used invitation, cancelled, duplicate passkey |
| Passkey registered | Confirmation; explicit next step is sign-in | no session created |
| Approvals | Requests the Host lists for this human; count; refresh | loading, empty, session ended |
| Review request | Plain-language summary, separate **authoritative subject**, exact canonical bytes, digest checked on device, allowed verdicts | not found / no longer pending, digest mismatch (decision blocked), no verdict allowed |
| Confirm approval / rejection | Exact action, resource, agent, request, digest; what the passkey confirms; "approval is not proof of execution" | preparing, awaiting passkey, recording, cancelled, expired, refused before use |
| Decision status | Authoritative decision state, request status, execution "not observed", decision reference | checking, outcome unknown (check again), unsettled, abandoned, refused |

## 3. Design decisions

- **Visual system:** obsidian foundation with jade accents, high contrast (body
  text ≈ 17:1, muted text ≈ 9:1), and the system typeface, which honours iOS
  Dynamic Type through `font: -apple-system-body`. It deliberately does not look
  like a wallet, trading screen or consumer bank.
- **Calm decisions:**
  - choosing a verdict only opens a confirmation;
  - the confirmation restates the exact subject and what the passkey confirms;
  - the primary action is a single clearly labelled button ("Approve with passkey" / "Reject with passkey");
  - the danger styling is reserved for Reject.
- **Summary vs. record:** the summary sentence is labelled "for reading". The
  authoritative subject is a definition list of the Host's fields, plus the
  canonical bytes the digest covers, untruncated and wrapping, in a disclosure.
- **No invented fields:** environment and requested effect are not in the
  gateway contract, so they are not shown. Every field rendered comes from
  `GET /authority/v1/approvals/:id`.
- **Framework choice:** dependency-free TypeScript, with a ~100-line view model
  (`vnode.ts`) and DOM mounter (`dom.ts`), compiled by the repository's own
  TypeScript. React is a root dev dependency, but shipping it to a browser needs
  a bundler. That is a new dependency, and lockfile changes cannot be produced
  under the "no local package manager" rule. It would also widen the
  supply-chain surface (#210). The chosen approach has **zero runtime
  dependencies**.

## 4. Gateway endpoints consumed (unchanged)

| Client action | Endpoint |
|---|---|
| Start (resume session) | `GET /authority/v1/session` |
| Sign in | `POST /session/login/options` → `navigator.credentials.get()` → `POST /session/login` |
| Sign out | `POST /session/logout` (CSRF) |
| Register | `POST /enrolment/options {invitation}` → `navigator.credentials.create()` → `POST /enrolment {invitation, credential}` |
| Inbox | `GET /approvals` |
| Review | `GET /approvals/:approvalRequestId` |
| Decide | `POST /approvals/:id/decision-challenges {subjectDigest, verdict}` (CSRF) → `navigator.credentials.get()` → `POST /decisions {assertion}` (CSRF) |
| Status | `GET /decisions/:commitment` |

Every response is parsed strictly (`contracts.ts`): a malformed answer is an
error, never a partial screen. The client never computes or overrides the
subject digest, operator, organization, policy, standing or verdict. The digest
it sends is the one the Host returned for the request it displayed. The
device-side SHA-256 check of the canonical bytes can only **block** a decision
(on a mismatch), never alter what is sent.

## 5. Same-origin architecture (future pilot)

```
https://authority.frontera-systems.com   (one origin, TLS at the ingress; future AUTH-04D)
  ├─ /authority/v1/*  ──►  Host Authority gateway listener (127.0.0.1:<port>), Host header preserved
  └─ everything else  ──►  static files of apps/authority-web/dist, with apps/authority-web/security-headers.json
```

- **No Host change is needed.** The gateway keeps its own listener and all of its
  checks: `Host` equals the Authority host, `Origin` equals the Authority origin
  on every POST, `__Host-` HttpOnly Secure SameSite=Strict cookies, the CSRF
  header, and Authorization headers refused. The static client is served by the
  same origin, so cookies, the Origin check and WebAuthn's RP ID
  (`authority.frontera-systems.com`) all hold, with no CORS, no cross-site
  cookie and no browser-held token.
- **Ingress requirements (AUTH-04D):**
  - TLS for the Authority host;
  - preserve `Host`, forward `Origin`, `Cookie`, `x-frontera-csrf-token` and `Set-Cookie` unchanged;
  - no CORS headers;
  - serve the static files with `security-headers.json` (CSP `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; …`);
  - per-IP rate limits on `/authority/v1/session/login*` and `/authority/v1/enrolment*`;
  - keep the gateway listener on loopback or a private network.
- **CI qualification** uses a test-only loopback origin
  (`authority-web-origin-fixture.ts`) that does exactly the two routes above,
  against the real gateway.

## 6. WebAuthn and browser behaviour

- **Native dialog only:** `navigator.credentials.create()` and `.get()`. Face ID,
  Touch ID or a device code is the authenticator's choice; the client never
  collects or simulates biometrics and claims nothing about which method was
  used.
- **Exact fields both ways:** the codec turns the gateway's base64url JSON into
  `ArrayBuffer`s (the user handle decoded as bytes) and turns results back into
  exactly the JSON fields AUTH-02 accepts.
- **Outcomes classified:**
  - cancellation or timeout (`NotAllowedError`, `AbortError`) means nothing was
    signed or decided;
  - an unsupported device or browser disables passkey actions with an explanation;
  - `SecurityError` (a wrong address) is explained.
- **No automatic retry:** a new attempt always needs a new explicit tap and a
  new challenge.

## 7. Session security

- **Session:** the gateway's `__Host-` HttpOnly cookie, which the client cannot
  read. The CSRF token is held in memory only and sent as a header.
- **Nothing persisted:** no `localStorage`, `sessionStorage`, IndexedDB or
  `document.cookie`, and no token or identity value in a URL. All requests are
  same-origin, `credentials: 'same-origin'`, with redirects refused.
- **Session end:** an expired or revoked session returns the human to sign-in
  and drops all client state. Sign-out calls the gateway.

## 8. Error and reconciliation states

| Situation | Client behaviour |
|---|---|
| Empty inbox | "Nothing awaits your decision" |
| Request expired, superseded or decided elsewhere | Not listed; opening returns to the refreshed inbox with an explanation |
| Session expired or credential revoked | Back to sign-in, state cleared |
| Passkey cancelled or unsupported | Explained; nothing sent |
| Network failure before a decision | Explained; nothing decided |
| Decision window expired, request changed, role refused | Explained before any use of the assertion; nothing recorded |
| Lost submission response, already-used decision, outage after submission | Reads `GET /decisions/:commitment`; never resubmits; "Check status" if still unknown |
| `refused` | "Not recorded — refused by policy", with the reason code |
| `abandoned` | "Not recorded — interrupted"; a new decision is a new explicit action |
| `unsettled` | "Being confirmed — check again" |
| CORE-07 outage | "Cannot confirm its state right now, so nothing can be decided" |

Success is shown only when the Host reports `approved` or `rejected`. Execution
is always shown as "not observed by Frontera Authority": an approval is never
presented as an execution.

## 9. Accessibility

- **Structure:** one `h1` per screen, focusable (`tabindex="-1"`) and focused on
  every screen change, so VoiceOver announces the new screen. Landmarks are a
  `header`, `main` (with `aria-busy`) and `footer`.
- **Announcements:** a polite live region for notices, with `role="alert"` for
  errors and warnings and `role="status"` for progress and results.
- **Controls:** every button is named and typed, the input is labelled and
  described, and focus is visible (3 px jade outline). Keyboard order is document
  order.
- **Touch and zoom:** touch targets are at least 44–48 px, pinch zoom is never
  disabled, Dynamic Type is honoured, and safe-area insets are respected
  (notch, home indicator) in portrait and landscape.
- **Layout and motion:** long identifiers, digests, parameters and canonical
  bytes wrap (`overflow-wrap: anywhere`), so there is no horizontal page scroll.
  Reduced motion and forced colors are honoured.
- **How it was checked:** structurally, in unit tests. A real VoiceOver and
  Dynamic Type pass on a device belongs to AUTH-04D.

## 10. Known limitations

- Not deployed; no real-device or real-Safari test has been run (AUTH-04D).
- Single Host process; sessions are lost on restart (AUTH-04B).
- The static administrator bearer, the token-interception risk, the
  proxy-provided rate limits and backup:v1 still apply (AUTH-04B2).
- No push or notification: the CTO opens the app to see requests.
- Execution outcomes are not shown; Authority does not observe execution.
- English only; times are shown in UTC.

## 11. Future iPhone pilot checklist (AUTH-04D)

1. **Ingress:** TLS and the §5 ingress for `authority.frontera-systems.com`, with
   the gateway on a private listener.
2. **Configuration:**
   - production `AOC_ENTERPRISE_HUMAN_AUTHORITY_*` and `AOC_ENTERPRISE_AUTHORITY_GATEWAY_*` (public origin = the Authority origin);
   - the witness;
   - a restore procedure for the identity store.
3. **On a current iPhone (Safari):**
   - register with an invitation (in-person hand-off);
   - sign in with Face ID or a device code;
   - approve, reject, cancel, expire, lock the screen mid-decision, switch apps, lose the network mid-submission;
   - VoiceOver, the largest Dynamic Type size, landscape, and Low Power Mode.
4. **Passkey sync:** iCloud Keychain passkey sync behaviour (multi-device
   passkey; counter always 0).
5. **Review:** a security review of the deployed boundary (headers, cookies,
   rate limits, logs).
6. **Rollback:** a rollback plan, and the identity-store restore drill against
   the witness.
