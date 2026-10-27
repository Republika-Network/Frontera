# AUTH-04A — Secure Host composition for human authority

**Status:** composed in-process inside the shipped Host, disabled by default.
No route, no UI, no mobile flow, no push (AUTH-04B+). One Host process, one
organization per Host. Pilot target only.

## 1. Composition

```
bootEnterpriseHost()
 ├─ host-configuration          humanAuthority enabled ⇒ external CORE-07 witness + SQLite (every profile)
 │                              strict env: a human-authority variable without the mode is refused
 └─ composition root (createEnterprise)
     ├─ assertHumanAuthorityComposable        before the signer is proven, the witness contacted, any store opened
     │    SQLite · external witness · software custody · CTRL-02 operators · durable CORE-05 approvals
     │    relying party: explicit RP ID + exact https origins (AUTH-02 rules, production mode only)
     ├─ authority signer + verifier (CORE-02) ──────── one boundary, shared with CORE-01/04/05 stores
     ├─ freshness boundary (CORE-07) ───────────────── one boundary, shared with every authority store
     ├─ CORE-05 approval authority (unchanged)
     └─ composeHumanAuthority                          after CORE-05
          identity store (AUTH-02/03, schema v2)  signed head verified at open · genesis enrolled at the witness
                                                  · head established at the witness before use
          identity service (AUTH-02/03)           operator ids from CTRL-02 config (ids + roles only, never bearer keys)
          decision channel (AUTH-03) ───────────► CORE-05 list / approve / reject   (frontera:human-passkey-decision)
          reconcile() once                        settles decisions a crash left unsettled — outcomes only
          enterprise.humanAuthority               in-process port; refused while the Host is not ready
 posture.humanAuthority = 'composed' only when the identity store is under the root's freshness boundary
 Host refuses to start (HOST_COMPOSITION_INCOMPLETE) if enabled and not composed
```

Nothing is duplicated: the signer, verifier, witness boundary, CORE-05 engine,
operator registry and lifecycle are the Host's existing ones. The CTRL-04
operator plane (static operator bearer, `/api/admin/approvals…`) is unchanged
and has no path to this authority; the authority receives operator **ids and
roles only**.

## 2. Configuration

| Variable | Rule |
|---|---|
| `AOC_ENTERPRISE_HUMAN_AUTHORITY_MODE` | `disabled` (default) or `enabled` |
| `AOC_ENTERPRISE_HUMAN_IDENTITY_SQLITE_PATH` | default `.data/human-identity.sqlite`; its own file |
| `AOC_ENTERPRISE_HUMAN_AUTHORITY_RP_ID` | **required**; intended pilot value `authority.frontera-systems.com` |
| `AOC_ENTERPRISE_HUMAN_AUTHORITY_ALLOWED_ORIGINS` | **required**; comma-separated exact `https://` origins on the RP ID or its subdomains |
| `AOC_ENTERPRISE_HUMAN_AUTHORITY_RP_NAME` | default `Frontera Authority` |
| `AOC_ENTERPRISE_HUMAN_AUTHORITY_INITIALIZE` | `true` permits creating the store **only when the file is absent** (the one initialization path) |
| `AOC_ENTERPRISE_HUMAN_AUTHORITY_DECISION_TTL_SECONDS` | 1–120, default 120 |

Plus the existing: `AOC_ENTERPRISE_AUTHORITY_FRESHNESS_MODE=external` (+ witness
variables), software custody (`AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_*`), a
governed-action file with CTRL-02 operators and a Governance Profile approval
requirement, `AOC_ENTERPRISE_PERSISTENCE_PROVIDER=sqlite`.

- The RP ID and origins are deployment configuration only; no request supplies them.
- No loopback/test relying-party mode is available to a Host.
- DNS and TLS for `authority.frontera-systems.com` are **not** assumed: WebAuthn
  verification is local; the origin is only checked against configuration.
- No secret is added. No production configuration was changed.

## 3. Startup and shutdown

Startup, in order (any failure refuses the Host and closes everything opened):

1. Strict environment and Host rules (mode, RP variables, TTL; witness + SQLite required).
2. The composition gate (`HUMAN_AUTHORITY_*` codes) — nothing opened yet.
3. Signer proven, witness established (existing CORE-02/CORE-07 boundaries).
4. CORE-05 composed.
5. Identity store: absent and not initializing → `HUMAN_AUTHORITY_STORE_UNINITIALIZED`;
   absent and initializing → genesis enrolled at the witness, then created; present →
   signature + chain + organization verified (`HUMAN_IDENTITY_STORE_*`), then the head
   established at the witness (`AUTHORITY_FRESHNESS_*`, e.g. `ROLLBACK_DETECTED`).
6. Startup reconciliation.
7. Port exposed; Host posture and health checked; `listen()`.

Shutdown closes the identity store with every other store (WAL flushed). No
in-memory authorization exists: challenges and their consumption are durable,
and the port refuses once the Host is not ready.

## 4. Freshness (CORE-07)

Mandatory whenever the authority is enabled, in every profile. The identity
store shares the Host's witness boundary (slot `human-identity-state`), so its
session appears in `/health` freshness and a witness outage after startup
refuses every identity write (fail closed). No CORE-07 semantics changed.

- Rolled-back identity file → refused at startup (tested).
- Deleted identity file → refused with or without initialization: the witness
  slot already advanced, and a store is never re-created over it (tested).
- Restoring the newest copy recovers (tested).
- **Not protected:** rolling back both the identity file and the witness.

## 5. Dual-store failure safety

AUTH-03 order is unchanged: verify → consume + evidence (one signed, witnessed
row) → CORE-05 verdict → outcome. AUTH-04A adds **bounded reconciliation**:
for each consumed decision with no recorded outcome that is not in flight in
this process, read CORE-05 — `recorded` if a verdict cites its evidence digest,
else `abandoned`. It records an outcome only: it never calls a CORE-05 command,
never re-opens a challenge and never creates a verdict. The Host runs it once
at startup.

| Case | Result | Tested |
|---|---|---|
| Consumed, CORE-05 commits | `recorded` | yes |
| Consumed, CORE-05 refuses (standing revoked) | `refused`, nothing counts | yes |
| Crash between consumption and CORE-05 | restart → `abandoned`, zero verdicts, assertion never reusable; a new decision works | yes |
| Reply lost after verdict recorded | restart → `recorded` from CORE-05, exactly one verdict | yes |
| Duplicate submission (concurrent / replay) | exactly one verdict | yes |
| Conflicting verdicts | CORE-05 serializes; a closed request refuses before consumption (AUTH-03) | AUTH-03 |
| Credential revoked during decision | refused, nothing consumed | yes |
| Principal revoked during decision | refused | yes |
| Witness unavailable during transition | refused; no local consumption; no verdict | yes |

No cross-store transaction and no CORE-05 change were needed.

## 6. Backup

The identity store is **excluded from backup:v1** in this increment (registry
`EXCLUDED_DURABLE_STATE`, with the reason). An operator enabling the authority
backs it up separately (Online Backup API) and keeps the witness outside that
backup domain. Loss narrows (no decision can be authorized until the newest
copy is restored or the slot is recovered at the witness); it never widens.

## 7. Remaining restrictions

- No route, BFF, browser or iPhone flow; no APNs/Web Push (AUTH-04B+).
- External signer custody cannot compose the authority (refused) until the
  external protocol carries `signHumanIdentityState`.
- backup:v1 does not cover the identity store.
- One Host process; reconciliation's in-flight rule is process-local.
- A refused initialization over an advanced witness slot leaves an empty file
  at the configured path; the next start refuses it (fail closed) until the
  newest copy is restored.
- Enrolment is in-process administration only (`identityAdministratorFor` from
  a CTRL-02 organization-administrator principal); there is no enrolment route.
