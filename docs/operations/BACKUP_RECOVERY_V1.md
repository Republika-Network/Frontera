# Frontera Systems Host — Backup and Recovery (v1.0.0, PROD-02)

Backup strategy for the Enterprise Host's SQLite persistence. Applies only to
`AOC_ENTERPRISE_PERSISTENCE_PROVIDER=sqlite`; the `memory` provider has
nothing to back up and loses all state on restart.

**Use the automated tooling** — `npm run backup:v1` and `npm run restore:v1`
(`AOC_ENTERPRISE_BACKUP_V1.md`, `AOC_ENTERPRISE_RESTORE_V1.md`). Since PROD-02
it covers every durable store the Host composes, records which ones a
deployment requires, refuses an incomplete or pre-PROD-02 backup as a complete
image, verifies signed authority state under the trusted keys, and rolls a
failed replacement back. This document explains *why* the procedure is shaped
the way it is, what must live **outside** a data backup, and the manual
fallback. The qualification evidence is
`docs/security/PROD-02-COMPLETE-BACKUP-RESTORE-COVERAGE.md`.

## What to back up — three recovery domains

A recoverable Frontera deployment has three things, kept in three different
places. Mixing them is the most dangerous mistake an operator can make.

| Domain | Contents | Where it is recovered from |
|---|---|---|
| **Authority data** | the fourteen SQLite stores in `scripts/portability/store-registry.mjs` (those the deployment composes; thirteen at PROD-02, plus ASSURE-01's Evidence Bundle Store) | `backup:v1` sets |
| **Secrets and key material** | API keys, operator/administrator/customer/provider credentials, the software-custody authority private key, the external signer's and the witness's service credentials | the secret manager / key custody — **never** a data backup |
| **Freshness witness state** | the CORE-07 witness's own database and receipt key | the witness operator's own, separate backup set and schedule — **never** with the authority data |

### Authority data

| Store | Default path | Composed when |
|---|---|---|
| Governance | `.data/enterprise-host.sqlite` | always |
| Agent Passport | `.data/agent-passport.sqlite` | always |
| Assurance | `.data/assurance.sqlite` | always |
| Kernel Authority | `.data/kernel-authority.sqlite` | durable authority enabled |
| Bounded grants (signed) | `.data/bounded-grants.sqlite` | governed actions |
| Emergency controls | `.data/emergency-controls.sqlite` | governed actions |
| Exercise ledger | `.data/exercise-ledger.sqlite` | governed actions |
| Authority event stream | `.data/authority-event-stream.sqlite` | governed actions |
| Execution outcomes | `.data/execution-outcomes.sqlite` | governed actions |
| Execution resolutions | `.data/execution-resolutions.sqlite` | the governed-action file declares operators (PROD-03-02), or an embedder composes P12 reconciliation |
| Obligation discharges (signed) | `.data/obligation-discharges.sqlite` | the governed-action file declares obligations |
| Approvals (signed) | `.data/approvals.sqlite` | a Governance Profile declares an approval |
| Control plane | `.data/control-plane.sqlite` | the governed-action file declares operators |

**Back up every composed store together as one set.** Their records reference
each other (a resumed approval references a committed decision; an outcome
references a grant; a ledger reservation references an execution), and a
restore of files from different runs is a state that never existed.

Also keep, with each backup set (not secret): the build identity — the
manifest records the source commit; a store opens only under a build that
supports its schema — and the governed-action file, from configuration
management (its SHA-256 is in the manifest).

## Consistency: cold backups for disaster recovery

Each SQLite store is consistent on its own; fourteen files are not one
transaction.

- **Cold backup (required for disaster recovery and pre-upgrade):** stop the
  Host (`SIGTERM`; since PROD-02 a clean shutdown closes every store it
  opened, so no WAL remains), then `npm run backup:v1 -- --output <dir>
  --cold`. `--cold` refuses when any store still has a non-empty WAL. The
  tool cannot *prove* the Host is stopped; the manifest records the
  operator's attestation and what was observed
  (`consistency.toolVerifiedHostStopped` is always `false`).
- **Live backup:** `backup:v1` without `--cold` uses SQLite's Online Backup
  API (safe against a live writer). Each file is consistent; the set is not
  a single point in time (`consistency.mode: live-per-file`). Acceptable as a
  routine supplement, never as the disaster-recovery image.
- **Volume snapshots** are equivalent to a cold backup only when atomic across
  the whole data directory **and the witness is on a different volume**.

## Key material and secrets — what must exist outside a data backup

A data backup restores *state*. It never restores the ability to act: every
secret below is restored from the secret manager, by name. Each backup's
manifest lists the names (`configuration.secretEnvironmentVariables`) and
`RESTORE.md` repeats them; no value is ever in a backup (proven by a canary
scan of every byte, under both custody modes).

### Authority signing — software custody

Restore from the secret manager / secure key backup:

- `AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_PEM` — the PKCS#8 private key
  (AA-001: process-resident). Never from a data backup.
- `AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_ID` — the active key id (the
  manifest's `authority.signer.activeSigningKeyId`).
- `AOC_ENTERPRISE_AUTHORITY_VERIFICATION_KEYS` — every **public** key that
  signed any state still in the stores, including rotated-out keys (CORE-01
  rotation: historical artifacts keep the key id that signed them). Compare
  with `authority.signer.trustedVerificationKeys` (key id, algorithm, SPKI
  fingerprint). A missing historical key makes the signed state unreadable —
  the store opens unhealthy and the secure Host refuses to start, never
  silently re-signs.

### Authority signing — external custody (CORE-02)

- The signer service is restored or kept available **independently** (its key
  lives with it; the Host data never contains it).
- `AOC_ENTERPRISE_AUTHORITY_SIGNER_ENDPOINT`, the pinned
  `AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_ID`, the trusted public keys, and
  `AOC_ENTERPRISE_AUTHORITY_SIGNER_TOKEN` (injected from the secret manager).
- `AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_PEM` must **not** be present.

Restoring data never re-signs history, strips a signature or replaces a key
id. `restore:v1` verifies the three signed stores under the trusted keys
before promoting them; the secure Host verifies them again at startup.

### Freshness witness (CORE-07)

- The **surviving** witness — the one that witnessed the state being
  restored. Its endpoint, `…_FRESHNESS_WITNESS_ID`, the pinned
  `…_FRESHNESS_WITNESS_PUBLIC_KEY` (manifest: `witnessId`,
  `witnessPublicKeyFingerprint`) and `…_FRESHNESS_TOKEN` (secret manager).
- Its state is backed up by its operator on a different volume, in a
  different backup set, on a different schedule. **Never** restore it together
  with the authority stores, never reset it, never re-enroll an existing store
  to make a restore start.

### Operator, administrator, customer and provider credentials

- `AOC_ENTERPRISE_API_KEYS`, and every variable the governed-action file names
  in `apiKeyEnv` (operators, CTRL-01 administrators, customer principals),
  `tokenEnv` / `valueEnv` (Generic HTTP provider credentials): from the secret
  manager.
- **Operator-issued agent credentials** are not recoverable from any backup:
  the control-plane store holds SHA-256 verifiers, never the one-time secret.
  An agent that lost its secret gets a **rotated or reissued** credential
  (`POST /api/admin/agents/{actorId}/credentials/{id}/rotate`), never one
  extracted from a backup.

## Restore procedure

Full steps in `RUNBOOKS_V1.md` §5. Summary:

1. Stop the Host. Keep the current data directory (evidence).
2. `npm run restore:v1 -- --backup <set> --target <data-dir> [--force]`, with
   the deployment's environment (so coverage, organization and signatures are
   checked against it).
3. Point the variables at the printed paths; inject secrets; keep the
   surviving witness.
4. Start the **matching build**. A refusal with
   `AUTHORITY_FRESHNESS_ROLLBACK_DETECTED` means the backup is older than an
   authority transition the witness recorded: restore a newer backup — never
   touch the witness.
5. Re-apply every control-plane change made after the backup (credential
   revocations/rotations, profile retirements): the control-plane store is not
   witness-anchored (PROD-02 residual).
6. Health verification (`RUNBOOKS_V1.md` §12); announce the recovery point.

## Disaster recovery (host lost entirely)

1. Provision a replacement host (`DEPLOYMENT_GUIDE_V1.md`).
2. Deploy the build recorded in the backup's manifest.
3. Restore configuration (governed-action file — compare its SHA-256 with
   `coverage.deployment.governedActionsFileDigest`) and secrets (above).
4. Make the signer (external custody) and the witness reachable. Do not
   restore the witness from the authority backup.
5. `restore:v1` into the new data directory; start; verify.
6. Re-apply post-backup control-plane changes; take a fresh cold backup.

The PROD-02 clean-room drill performs steps 2–6 end to end on the real secure
Host, under software and external custody, against a separate-process
witness (`prod02-disaster-recovery-host.test.ts`).

## Pending witness transitions in disaster recovery

CORE-07 anchors each authority transition as *prepare (witness) → local commit
→ finalize (witness)*. What a restore meets:

| Witness | Restored store | Result | Operator action |
|---|---|---|---|
| committed C, nothing pending | head = C | starts | none |
| committed C | head older than C | refused, `ROLLBACK_DETECTED` | restore a newer backup |
| committed C, pending P | head = P (the backup was taken after the local commit, before finalize) | starts; the Host finalizes P | none |
| committed C, pending P | head = C (a crash between prepare and local commit, **or** a restore of the pre-transition state — indistinguishable) | refused, `PENDING_RECOVERY` | **trusted operational recovery only** (`RUNBOOKS_V1.md` §5.3): there is no abort or force-clear API, and PROD-02 adds none |
| bound to another store id | any | refused, `BINDING_MISMATCH` | restore this deployment's own store |

## RPO and RTO

- **RPO = your backup interval.** No replication, no changelog, no
  point-in-time recovery. Restoring a backup older than the newest state also
  forgets every *unanchored* change made after it — exercise-ledger
  consumption (so a spent limit regains that capacity), execution outcomes (so
  an action executed after the backup could execute again), emergency stops
  and releases, Kernel Authority provisioning and revocations, control-plane
  credentials and profile lifecycle, and the trace. If an anchored store (grant
  revocation state, obligation discharges, approvals) changed after the
  backup, the secure Host refuses to start instead. Keep the interval short,
  restore the **newest** cold backup, and re-apply post-backup revocations and
  stops from your incident records.
- **RTO** is not an SLA. The PROD-02 drill observes the whole cycle (cold
  backup → restore of all thirteen stores — fourteen since ASSURE-01 — → secure-Host boot → verification)
  in seconds on a small synthetic deployment; production time is dominated by
  store size, provisioning and secret injection. Measure your own.

## Limitations

- No point-in-time recovery; no cross-store transactional snapshot while live.
- Backups are checksummed, not signed: whoever controls backup storage can
  rewrite files and manifest together. The signed stores still verify under
  the trusted keys and CORE-07 still refuses a stale signed state; the
  unsigned stores have no such defense. Access-control backup storage.
- The control-plane store, emergency controls, the exercise ledger and Kernel
  Authority are not witness-anchored: an older copy of them is believed.
- Schema-version coupling: a backup restores only under a build that supports
  its recorded schema versions.
- Backups are not encrypted by the tooling.
