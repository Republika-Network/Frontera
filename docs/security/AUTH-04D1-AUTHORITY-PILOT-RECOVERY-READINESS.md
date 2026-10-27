# AUTH-04D1 — Authority pilot recovery and deployment readiness

**Status:** implemented and CI-qualified in ephemeral fixtures only.

- **Backup and restore:** a backup and restore procedure for a single-organization, single-Host Authority pilot.
- **CORE-07 compatibility:** proven against a real Host and a reference witness running in its own process.
- **Deployment readiness:** a deployment architecture, an ingress contract, a first-CTO runbook and a real-iPhone acceptance matrix.

**Not deployed.** No DNS, TLS, proxy, VM, cloud resource or production secret exists or was changed. No invitation was sent and no customer onboarded. Every passkey in CI is a software authenticator: nothing here is a real-device result. Deployment is AUTH-04D2; real-device qualification is AUTH-04D3.

## 1. What changed

| Area | Change |
|---|---|
| `backup:v1` registry | The signed human identity store is a registry store (`human-identity`, condition `human-authority-enabled`, slot `human-identity-state`) instead of an exclusion. backup:v1 copies it with the Online Backup API, records its signed head, binds it to the organization; restore:v1 verifies it under the trusted keys. Format id unchanged. |
| `storeEnvironmentFor` | Names the identity store's variable only for a deployment that composes it: the Host refuses `AOC_ENTERPRISE_HUMAN_IDENTITY_SQLITE_PATH` unless the authority is enabled (AUTH-04A, unchanged). |
| Authority pilot profile | `npm run authority-pilot:backup -- keygen | backup | verify | restore | inspect` (`scripts/portability/authority-pilot-backup.mjs`): backup:v1 and restore:v1 with stricter preconditions, sealed with AES-256-GCM (`lib-sealed-backup.mjs`). |
| Ingress contract | `deploy/authority-pilot/ingress-contract.json`, a specification checked against the gateway and the web client. |
| Host shutdown (defect fix) | `Enterprise.close()`/`stop()` now close the human identity store. Before, it was closed only when startup failed. After a clean shutdown its connection stayed open with an un-checkpointed WAL, so no cold backup of a stopped Authority Host was possible, despite AUTH-04A §3. Found by these drills; the same class of defect PROD-02 fixed for the approval, obligation and control-plane stores. |
| Tests | `src/enterprise/__tests__/auth04d1-authority-recovery-host.test.ts` (the CORE-07 drills), `tests/authority-pilot-sealed-backup.contract.test.mjs`, `tests/authority-pilot-ingress-contract.test.mjs`, registry updates. |

Apart from that one shutdown line, no Host, gateway, CORE-05, CORE-07, G-02, WebAuthn or web-client code changed. No endpoint, route, dependency or witness protocol change.

## 2. Recovery dependency inventory

What a valid Authority Host needs, from the code (`composition-root.ts`, `human-authority-composition.ts`, `sqlite-human-identity-store.ts`, the registry):

| State | Where | Kind | Integrity / anchoring | How it is recovered |
|---|---|---|---|---|
| Human principals, enrolment authorizations (invitation **verifiers** only — tokens are never stored), passkey credentials (public keys, counters), revocations, `credential_used`, consumed ceremony challenges, `decision_authorized` evidence, `decision_outcome` | `human-identity.sqlite`, table `human_identity_records` | **durable** | hash chain under a head signed by the authority key (`human-identity-state:v1`); head anchored at the witness, slot `human-identity-state` | the newest file (§5) |
| Issued ceremony and decision challenges (not yet used) | same file, `human_identity_challenges`, `human_decision_challenges` | durable, unchained | issuance is not authority; **consumption** is a chained row | with the file; a lost unused challenge is simply refused |
| CORE-05 approval requests, verdicts, revocations | `approvals.sqlite` | durable | signed chain head, slot `approval-state` | the newest file |
| Every other Host store (governance, passport, assurance, Kernel Authority, bounded grants, emergency controls, exercise ledger, event stream, outcomes, resolutions, obligations, control plane, evidence) | the registry's files | durable | per the registry; grants and obligations signed and anchored | backup:v1 (the Host does not start without them) |
| Signed heads, store ids, organization binding | inside each signed file | durable | signature + chain recomputed at every open | travel with their rows; never reconstructed |
| CORE-07 committed and pending heads | the **witness's** database | durable, **external** | witness receipts signed by the witness key | the witness's own durability (§6); never from a Host backup |
| Authority signing key (software custody) | secret manager (`AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_PEM`) | secret | — | secret manager; never in a backup |
| Trusted verification keys | configuration (`AOC_ENTERPRISE_AUTHORITY_VERIFICATION_KEYS`, public) | configuration | — | configuration management |
| Witness endpoint, id, public key, token | configuration + secret manager | configuration / secret | — | configuration management / secret manager |
| Operator bearer secrets (CTRL-02), API keys | secret manager | secret | — | secret manager |
| Governed-action file (operators, profiles) | configuration management | configuration | SHA-256 recorded in the manifest | configuration management |
| Authority sessions, login ceremonies, enrolment ceremony state | Host process memory | **process-local** | — | lost on restart by design: sign in again; invitations stay valid |
| In-flight decisions | process memory | process-local | — | startup reconciliation records `recorded` or `abandoned` from CORE-05; never a verdict |
| Rate-limit counters | the ingress | process-local | — | reset on restart |
| Web client | `apps/authority-web/dist` | **reconstructible** | reproducible build, `asset-manifest.json` (sha256) | rebuild from the commit |
| **Backup key** (new) | secret manager | secret | — | secret manager; without it no sealed backup can be read |

Backing up `human-identity.sqlite` alone is not enough. The Host refuses to start without every store its configuration composes. It also needs the signing key and verification keys, the operator secrets and the governed-action file. Above all, it needs the **same surviving witness**.

## 3. The Authority pilot backup profile

backup:v1 already met most requirements: a SQLite-consistent copy (Online Backup API, never a byte copy of a live WAL file), integrity and schema checks, signed-head and organization binding, coverage that fails closed, staged promotion, and deep verification under the trusted keys. It did not cover the identity store and it does not encrypt. AUTH-04D1 therefore:

1. adds the identity store to the **one registry**, as backup:v1's fourth signed store (ASSURE-01, PAY-03 and TRADE-04C extended it the same way); and
2. adds a narrow profile **on top**, which keeps backup:v1's contract and replaces nothing.

### Commands

```bash
# once, into the secret manager (never beside the backups, never with the witness)
npm run authority-pilot:backup -- keygen --out <key-file>
# with the Host STOPPED, in the Host's environment
npm run authority-pilot:backup -- backup --output <sealed-file> --key-file <key-file>
# explicit verification, in the restoring deployment's environment (trusted keys required)
npm run authority-pilot:backup -- verify --archive <sealed-file> --key-file <key-file>
# restore into a fresh data directory, then start the Host against the SURVIVING witness
npm run authority-pilot:backup -- restore --archive <sealed-file> --key-file <key-file> --target <dir> [--force]
# the public header, without the key (organization, backup id, signed heads to compare with the witness)
npm run authority-pilot:backup -- inspect --archive <sealed-file>
```

### Preconditions and refusals (each tested)

- **Deployment shape:** the human-decision authority is enabled, persistence is `sqlite`, and the CORE-07 witness is external. Verify and restore also need the trusted verification keys.
- **Cold only:** a non-empty WAL beside any store, i.e. a running Host, is refused. The identity store and CORE-05 move together, so only a stopped Host gives a cross-store-consistent set.
- **Complete only:**
  - Coverage must be complete and must include the signed `human-identity` and `approvals` stores, each bound to the backup's organization.
  - There is no "missing allowed" mode, no legacy restore, no incomplete restore and no unchecked restore.
- **Verified only:** restore promotes nothing unless every signed store verifies under the trusted keys (restore:v1's deep verification).

### Sealed file (`frontera.authority-pilot.sealed-backup.v1`)

`MAGIC | header length | header (canonical JSON) | IV | tag | AES-256-GCM ciphertext`

| Property | How |
|---|---|
| **Confidentiality** | AES-256-GCM, 256-bit key from an owner-only key file (`chmod 600`, never a link, never overwritten). Passkey public keys, credential ids, operator ids, approval subjects and decision evidence exist only inside the ciphertext (tested byte for byte). |
| **Integrity** | The tag covers the ciphertext **and** the header (GCM additional data). Every file inside also carries its SHA-256, and backup:v1's checksums and signed-head checks run again on restore. |
| **Provenance and binding** | The public header records the backup id, creation time, source commit, organization, consistency (`cold-attested`), the key id (`fbk1-…`, a one-way name for the key), and each signed store's id, organization, sequence, state digest, signing key id and witness slot. Restore requires the header and the manifest inside to agree. |
| **No secrets** | No key, token, bearer, private key or witness state is read or written. The profile's own key is passed as a file path, never printed. |
| **No leftovers** | Plaintext exists only in a private (`0700`) temporary directory on the machine that already holds the stores, and is removed on every success and failure path (tested). |
| **Fail closed** | The following are refused before anything is unpacked or the target is touched: truncation, any flipped byte, appended bytes, a non-canonical header, an unsupported format or cipher, a wrong key, a forged key id, an archive path that escapes or is duplicated, and a size or digest mismatch. |
| **Bound** | 128 MiB of plaintext per pilot backup. A larger set is refused, never truncated. |

### Compatibility

The coverage record gains a `humanAuthorityEnabled` flag. This build reads only manifests that carry it, as with PAY-03's and TRADE-04C's flags. An older backup must be restored with the build recorded in its `metadata/release-context.json`. The `aoc.enterprise.backup.v1` format id, the store schemas and the witness protocol are unchanged.

## 4. Restore procedure

1. Stop. Never restore under a running Host.
2. Choose the backup. `inspect` shows each signed head's sequence; compare it with the witness's committed sequence for the same slot. A backup older than the witness **will** be refused (§5); do not try to make it start.
3. Run `verify`, then `restore` into a fresh directory, both in the restoring deployment's environment: the same organization, the trusted verification keys, and the witness configuration unchanged.
4. Start the Host with the printed store variables, the secrets from the secret manager, and the **surviving** witness.
5. If the Host refuses with `AUTHORITY_FRESHNESS_ROLLBACK_DETECTED`, the backup is older than the witnessed state. Restore a newer one, or follow §5's options. **Never reset, rebind or re-enroll the witness.**
6. Re-apply any control-plane revocation made after the backup. That store is not anchored (PROD-02 residual, unchanged).

## 5. CORE-07 restore semantics (the gate)

Proven on the shipped Host by `auth04d1-authority-recovery-host.test.ts`:
- production profile and software custody;
- the reference witness in its own process, with its own directory;
- the human authority and gateway enabled;
- the CTO and a second device enrolled through invitations.

| Scenario | Result |
|---|---|
| Valid current snapshot (sealed through the CLI, verified, restored) | **Starts.** The posture shows `humanAuthority: composed` and `authorityFreshness: external`. The CTO signs in, the decision status reads `approved` with execution `not_observed`, and the agent resumes and executes exactly once. |
| Truncated or bit-flipped sealed file (no key needed) | **Refused** at authentication; nothing unpacked; target untouched |
| Store cut in half inside a correctly re-sealed backup (attacker holds the key and recomputes the checksums) | **Refused** by restore:v1 (SQLite integrity); target untouched |
| Identity store removed, under the original header | **Refused** (the header and manifest disagree, and the backup is incomplete) |
| **Forged identity head**: an attacker passkey row inserted and the head re-signed with an untrusted key under the trusted key id; manifest, checksums and seal all rewritten with the real backup key | **Refused** by `verify` and `restore`: the head is not authentic under the trusted keys; target untouched |
| Wrong organization | **Refused** before any file is read |
| **Old identity state, witness advanced** (backup S0 from before a revocation and a decision) | Restore succeeds (it cannot know freshness). **The Host refuses to start** with `AUTHORITY_FRESHNESS_ROLLBACK_DETECTED`. No authority was handed out (zero adapter calls), and the witness is byte-identical before and after. |
| **Revoked credential** (S0 holds the lost device active) | It cannot come back, because S0 is refused as above. On the current restore, the revoked device's sign-in is refused. |
| **Consumed decision challenge** | On the current restore, replaying the original assertion is refused with `HUMAN_IDENTITY_DECISION_CHALLENGE_CONSUMED` (consumption is checked against the verified history, before expiry). CORE-05 still holds exactly one verdict. Under an old restore, the Host never starts. |
| S1, after one more sign-in on the recovered Host | **Refused** (`ROLLBACK_DETECTED`): every sign-in appends a witnessed `credential_used` row |
| Stale identity store alone, or stale approval store alone, inside an otherwise current restore | **Refused** (`ROLLBACK_DETECTED`) |
| Witness unreachable | **Refused** (`AUTHORITY_FRESHNESS_UNAVAILABLE`) |
| Witness not configured | **Refused** (`HOST_AUTHORITY_FRESHNESS_REQUIRED`) |
| The same restore, with the surviving witness back | **Starts** |
| Identity file lost, witness slot advanced, `INITIALIZE=true` | **Refused** (`ROLLBACK_DETECTED`): a store is never recreated over an advanced slot. The witness slot is untouched. |

Nothing in the profile, backup:v1 or restore:v1 contacts, reads, resets or enrolls the witness. A structure test pins this.

### Availability consequence (precise)

The identity head advances on every:
- sign-in (`credential_used`);
- enrolment;
- revocation;
- decision (`decision_authorized`, `decision_outcome`).

The approval head advances on every verdict. So for these two anchored stores, **a backup is restorable only until the next such event.** The effective RPO is "zero witnessed transitions". A backup taken at a planned stop restores that state. After the CTO's next sign-in it is permanently refused at that witness, by design.

If the live identity file is lost after the newest backup has gone stale:

1. **Restore the newest copy.** This is the only path that keeps every passkey. The live data volume must therefore be durable on its own: provider-replicated storage, never a lone local disk. A filesystem or VM snapshot is an older copy and goes stale the same way.
2. **Degraded but safe operation** (tested). Disable the human-decision authority (`AOC_ENTERPRISE_HUMAN_AUTHORITY_MODE` unset) and start the Host on the remaining current stores.
   - Approvals continue on the private CTRL-04 operator plane, with operator bearers.
   - No passkey decides anything.
   - Nothing is widened.
   - The approval store itself must still be current; if it is lost or stale, the whole Host refuses (PROD-02, unchanged).
3. **Re-founding the identity store** (a fresh, empty store under a newly bound witness slot, after which every human re-enrols) is **not supported**:
   - CORE-07 deliberately has no slot-retirement or force-clear ceremony;
   - the enrolment ceremony (`enroll-authority-state-freshness.mjs`) covers grants, obligations and approvals, not `human-identity-state`.
   Adding either is a CORE-07 change that needs the founder's decision. It was not made.

Not options, ever: resetting or re-enrolling the witness, restoring the witness together with the data, or promoting an older signed backup over a newer witnessed state.

## 6. Signer and witness custody

**Authority signing key**
- Ed25519, software custody (`AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_PEM` with its key id).
- External custody cannot compose human authority until the external signer protocol carries `signHumanIdentityState` (AUTH-03/04A, unchanged).
- The key signs every authority store head, including the identity head (TD-5 as narrowed for AUTH-03).
- It is held in the secret manager, readable only by the Host's service account, and never on the backup storage or the witness machine.
- Losing it with no other trusted key stops all new authority writes.
- Rotation is out of scope (no production rotation here). The Host re-attests heads signed by a trusted non-active key.

**Trusted verifiers**
- `AOC_ENTERPRISE_AUTHORITY_VERIFICATION_KEYS`: public keys only.
- Required to restore; the profile refuses without them.
- They must include every key that signed a head being restored.

**Current software-custody limitations**
- The private key is process-resident on the Host machine.
- A compromise of that machine is a compromise of the key (CORE-02's stated residual).
- The holder of the key can forge any head. Neither the witness nor backups protect against that.

**Witness availability and trust**
- Every authority write needs the witness. An outage after startup refuses identity and approval writes (fail closed), and a cold start without it refuses (tested).
- Pilot availability is therefore bounded by the witness's.
- The pilot runs the reference witness (`scripts/run-reference-authority-state-witness.mjs`) on a different machine and volume from the Host, with its receipt key in its own directory.
- The Host pins its id and public key.

**Witness persistence**
- The witness database must never lose committed state.
- A stale copy of the witness behind current Host data reads as "local ahead of witness" and is refused as a fork.
- So witness backups are only useful for a planned move. Durability must come from replicated storage, not snapshots.
- If the witness database is lost, every store becomes unbound and is refused. Grants, obligations and approvals can be re-enrolled by the explicit operator ceremony. **The identity store cannot** (§5.3), so its loss means human authority stays unavailable until a founder-approved change.

**Backups**
- They are sealed (§3). The backup key lives in the secret manager, apart from the backup storage and the witness.
- The backup storage is off-host, access-controlled and versioned.
- Losing the backup key makes every sealed backup unreadable; that is intended.
- Rotating it means sealing new backups under a new key.

**Credentials needed to restore an existing organization**
- the backup key;
- the trusted verification keys (public);
- the authority signing key (to write after restore);
- the witness endpoint, id, public key and token;
- the operator bearer secrets;
- the governed-action file;
- the build at the recorded commit.

None of these is in a backup.

No key was generated, stored or rotated for production here. CI generates throwaway keys inside temporary directories.

## 7. Pilot deployment topology (design only)

```
                 Internet (HTTPS only)
                        │
          ┌─────────────▼──────────────────────────────────────┐
          │ ingress — authority.frontera-systems.com           │   deploy/authority-pilot/ingress-contract.json
          │  TLS, HSTS, per-IP rate limits, 64 KiB bodies      │
          │  /authority/v1/*  → gateway (Host header kept)     │
          │  everything else  → static apps/authority-web/dist │   + security-headers.json
          └───────┬────────────────────────────────────────────┘
                  │ loopback
┌─────────────────▼──────────────── Authority Host VM (one process) ──────────────┐
│ Frontera Host: human authority + gateway (127.0.0.1:8788)                        │
│   main listener 127.0.0.1:8787 — operator plane, private network/VPN only        │
│   data volume (encrypted, provider-replicated): all registry stores incl.        │
│   human-identity.sqlite and approvals.sqlite                                     │
│   secrets from the secret manager: signing key, operator bearers, witness token  │
└──────────┬───────────────────────────────────────────────┬───────────────────────┘
           │ HTTPS (pinned key)                             │ sealed backups (cold, at planned stops)
┌──────────▼──────────────┐                     ┌───────────▼───────────────────────────┐
│ CORE-07 witness         │                     │ backup storage: off-host, versioned,  │
│ separate VM + volume    │                     │ access-controlled; backup key elsewhere│
│ (replicated, no shared  │                     └───────────────────────────────────────┘
│ snapshots with the Host)│
└─────────────────────────┘
```

- **Smallest viable shape:** one long-running Host process on one VM. It is not serverless: the Host holds sessions in memory, a SQLite single-writer, the witness transitions and startup reconciliation. A stateless function would lose all of them, and two instances would race on the stores.
- **Separations:**
  - the browser origin reaches only the gateway;
  - the operator plane is reachable only from a private network;
  - the witness and the backup storage are different machines and domains from the Host;
  - the marketing site is a different origin.

### Ingress and security-header contract

`deploy/authority-pilot/ingress-contract.json` is the normative version, checked by `tests/authority-pilot-ingress-contract.test.mjs`.

- **TLS:** a valid certificate for `authority.frontera-systems.com` only, TLS 1.2+, and HSTS. Port 80 only redirects.
- **Headers and origin:** the Host header is preserved; Origin, Cookie and `x-frontera-csrf-token` are forwarded unchanged; Set-Cookie is returned unchanged (the `__Host-` cookies need no Domain). The gateway enforces Host (421) and Origin (403) itself; the ingress must not weaken either.
- **CORS:** none. No `Access-Control-*` header and no preflight handling.
- **Static responses:** `apps/authority-web/security-headers.json`, which includes a strict CSP. Gateway responses carry their own `no-store` headers; the ingress caches nothing under `/authority/v1/`.
- **Rate limits (per TCP peer):**
  - sign-in: 10/min;
  - enrolment: 5/min;
  - all API calls: 120/min.

  A client-supplied `X-Forwarded-For` is never trusted.
- **Request bounds:** bodies up to 64 KiB, which is the gateway's own limit, and bounded timeouts.
- **Logging:** never bodies, cookies, CSRF tokens or Authorization values.
- **Never routed:** the Host's main listener (operator plane, passkey invitations, governed actions, health), the witness, the signer and the backup storage.
- **No credential anywhere:** no operator bearer, API key, witness token, signing key or backup key in the ingress configuration or any served file.

## 8. First CTO provisioning runbook (for AUTH-04D2; nothing here was executed)

1. **Prepare the Host:**
   - build at the approved commit;
   - one organization (`AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID`);
   - production profile and SQLite on the encrypted, replicated data volume;
   - the governed-action file with CTRL-02 operators (the organization administrator, and the CTO as an `approver`) and a Governance Profile that declares `approval`.
2. **Signer, verifier and witness:**
   - provision the authority signing key and its public verification key into the secret manager and configuration;
   - start the witness on its own machine and volume, and pin its id and public key on the Host;
   - generate the backup key into the secret manager.
3. **Initialize the identity store:**
   - start the Host once with `AOC_ENTERPRISE_HUMAN_AUTHORITY_MODE=enabled`, RP ID `authority.frontera-systems.com`, origin `https://authority.frontera-systems.com` and `AOC_ENTERPRISE_HUMAN_AUTHORITY_INITIALIZE=true`. The genesis is enrolled at the witness.
   - restart with `INITIALIZE=false` and keep it false from then on.
4. **Standing:** give the CTO's operator identity Kernel-Authority approver standing for exactly the pilot's actions and resources, and nothing more.
5. **Create the human:** on the private operator plane, as the organization administrator, `POST /api/admin/passkey-humans {operatorId, displayName}`.
6. **Invite:** `POST /api/admin/passkey-invitations {operatorId}` returns a one-time token, valid for at most 15 minutes and shown once.
7. **Verify the recipient out of band:** in person, or by calling a known number, never over the channel that carries the token. Hand the token over directly. If it is exposed, mistyped or late, revoke it and issue a new one.
8. **Register:**
   - the CTO opens `https://authority.frontera-systems.com` in Safari on the iPhone, chooses "Register with an invitation", and creates the passkey (Face ID or the device passcode);
   - the administrator confirms the new credential with `GET /api/admin/passkey-humans/:operatorId`, and revokes any credential the CTO does not recognize.
9. **Sign in explicitly:** registration creates no session.
10. **One synthetic approval request:** a governed action that requires approval, against a synthetic adapter with no real effect.
11. **Decide:** the CTO inspects the canonical subject and approves or rejects with a fresh passkey assertion. Success is shown only for the Host's actual outcome.
12. **Confirm the verdict independently:**
    - read CORE-05 on the operator plane (`GET /api/admin/approvals/:id`, observer);
    - check that it cites the decision evidence;
    - confirm exactly one verdict.
13. **Observe execution separately:**
    - the agent resumes through `POST /api/governed-actions`;
    - execution evidence comes from the governed-action result and the evidence bundle, never from the Authority screen (which says "not observed").
14. **Back up:** stop the Host, then run `backup`, `verify` and store the sealed file off-host. Remember it is restorable only until the next sign-in (§5).

## 9. Real-iPhone acceptance matrix (AUTH-04D3)

"CI equivalent" names the software-authenticator test that covers the same logic. It is **not** a device result. Every row's real-device status is **not run**.

| # | Scenario | Real-device steps | Expected | CI equivalent |
|---|---|---|---|---|
| D1 | Enrolment | Fresh invitation; Safari; "Register"; create passkey | 201; no session; credential listed for the CTO | AUTH-04B2 registration; AUTH-04C host |
| D2 | Face ID / passcode | Register and sign in with Face ID, then with Face ID disabled (passcode) | User verification satisfied both ways; the app makes no claim about which method was used | `userVerified` refusal in AUTH-04B2 |
| D3 | Sign-in | "Sign in with passkey" | Session; inbox | AUTH-04B, AUTH-04C |
| D4 | Approve | Open request, check subject and digest, approve, Face ID | "Approved"; execution "not observed"; one CORE-05 verdict | AUTH-04B, AUTH-04C |
| D5 | Reject | Same, reject | "Rejected"; the agent is withheld | AUTH-04B, AUTH-04C |
| D6 | Session expiry | Wait past the idle timeout | Back to sign-in; state cleared | AUTH-04C idle expiry |
| D7 | Revoked credential | Administrator revokes the passkey; CTO acts | Session ends; sign-in refused | AUTH-04B, AUTH-04D1 |
| D8 | Expired invitation | Wait 15 minutes, then register | "Invitation not valid" | AUTH-04B2 expiry |
| D9 | WebAuthn cancellation | Cancel the system sheet at sign-in, enrolment and decision | "Nothing was signed"; no request sent | AUTH-04C cancellation |
| D10 | Network loss mid-submission | Airplane mode right after Face ID | "Outcome could not be confirmed"; Check status; never resubmitted | AUTH-04C lost response |
| D11 | Decision-status recovery | Reconnect; Check status | Authoritative state; one verdict | AUTH-04C, AUTH-04D1 |
| D12 | Landscape | Rotate on every screen | No horizontal scroll; actions reachable | structural only |
| D13 | VoiceOver | Full journey with VoiceOver | Screen changes announced; every control named | structural only |
| D14 | Larger Dynamic Type | Largest accessibility size | No clipped text or controls | structural only |
| D15 | iCloud passkey sync | Use the synced passkey on a second Apple device | Sign-in works; counter 0 accepted; revocation applies to the synced key | AUTH-02 synced-credential tests |
| D16 | Wrong origin / RP ID | Open a lookalike origin | Browser refuses the RP ID; gateway refuses Origin | AUTH-04B2 wrong origin and RP ID |
| D17 | Host restart / lost process | Restart the Host mid-session and mid-decision | Signed out; decision reconciled `recorded` or `abandoned`; never duplicated | AUTH-04A reconciliation |
| D18 | Witness outage | Stop the witness, then try to decide | Refused; nothing recorded; recovers when back | AUTH-04B2 outage; AUTH-04D1 |
| D19 | Restore drill | Stop, back up, verify, restore to a fresh directory, start; then restore an older backup | Current restore starts; older refused (`ROLLBACK_DETECTED`); witness untouched | AUTH-04D1 |
| D20 | Lock screen / app switch mid-decision | Lock during the Face ID sheet; switch apps | No silent resubmission; a fresh explicit action is needed | AUTH-04C |

Evidence per row: device model, iOS and Safari versions, time, screen recording (no token or passkey material visible), and the Host's audit rows.

## 10. Security review

- **Witness (CORE-07):** never weakened, contacted, reset or enrolled by any backup or restore path, and pinned structurally. A stale restore is refused by the Host, not by the tool.
- **Confidentiality:**
  - sealed backups use standard AEAD from Node's built-in crypto, with no new dependency;
  - the header is authenticated;
  - archive paths are validated before any write;
  - key files must be owner-only;
  - no secret is in the header, logs or CLI output (scanned).
- **Integrity:** an attacker who controls the backup storage **and** holds the backup key still cannot get a forged identity head accepted (tested): authenticity rests on the authority key and the witness, not the backup key.
- **Rollback:** the decisive control is the witness. An attacker who rolls back the witness **and** the data together is out of scope (CORE-07's stated limit), so the witness must stay in a separate domain.
- **Registry change:**
  - `storeEnvironmentFor` keeps AUTH-04A's strict environment rule, so no Host receives an identity path without the authority;
  - restore's refusing signer gains `signHumanIdentityState` (refusing) only so that the identity store opens for verification.
- **No new attack surface:** no new endpoint, route, privileged API, dependency or production secret, and no browser-visible change.
- **Remaining risks, carried forward:**
  - software custody of the signing key;
  - the static operator bearer of the bootstrap administrator;
  - invitation interception during hand-off;
  - process-local sessions;
  - the unanchored control-plane store (PROD-02).

## 11. Unresolved availability limitations

1. **Zero-transition RPO.** For the identity and approval stores, a backup is restorable only until the next witnessed transition. Disaster recovery after losing the live volume depends on that volume's own durability.
2. **Losing the identity file** after its newest backup has gone stale leaves human authority permanently unavailable for the organization at that witness (degraded operator-plane mode only). Re-founding needs a founder-approved CORE-07 ceremony.
3. **Losing the witness database** leaves the identity store unbound. There is no enrolment ceremony for `human-identity-state`. Witness durability is a hard pilot requirement.
4. **Single points of failure:** one Host process and one witness. Either outage stops human decisions; there is no failover.
5. **Cold backups only:** each Authority backup needs a planned stop.
6. **Process-local state:** sessions and ceremonies are lost on restart; there is no in-Host rate limiter.
7. **No real-device or deployed qualification:** AUTH-04D2 and AUTH-04D3.

## 12. AUTH-04D2 prerequisites

- A founder decision on §11 items 1–3: accept them for the pilot, or fund a CORE-07 identity-slot recovery ceremony first.
- Provision, but only under AUTH-04D2's own authorization:
  - one VM with an encrypted, replicated data volume;
  - a separate witness VM and volume;
  - the secret manager entries (signing key, operator secrets, witness token, backup key);
  - off-host backup storage;
  - DNS and TLS for `authority.frontera-systems.com`;
  - an ingress that satisfies the contract.
- A private network path to the operator plane.
- An ingress conformance check against `ingress-contract.json` on the deployed origin.
- The §8 runbook dry-run with a synthetic human, then the CTO.
- AUTH-04D3: the §9 matrix on a current iPhone.
