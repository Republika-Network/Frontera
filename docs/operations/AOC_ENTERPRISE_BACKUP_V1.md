# AOC Enterprise v1 — Automated Backup (`backup:v1`)

Automated counterpart to the manual procedure in
`docs/operations/BACKUP_RECOVERY_V1.md`. That document remains the
authority on *why* (consistency model, frequency, retention, key material);
this document covers the `backup:v1` **command**. Companion documents:
`docs/operations/AOC_ENTERPRISE_RESTORE_V1.md` (restore) and
`docs/security/PROD-02-COMPLETE-BACKUP-RESTORE-COVERAGE.md` (the PROD-02
qualification: what is proven, how, and what remains residual).

## What it backs up — the store registry

Since PROD-02 the store list is **one registry**,
`scripts/portability/store-registry.mjs`. Backup discovery, restore mapping,
manifest validation, the fixture, the comparison and the tests all derive from
it; a structural test (`tests/portability-store-registry.structure.test.mjs`)
fails when the Host's configuration loader reads a `*_SQLITE_PATH` variable the
registry neither declares nor excludes, and a Host-level test boots real Hosts
to prove the registry predicts exactly the store files the composition root
opens.

The registry declares **fourteen** durable SQLite stores — every store the
Enterprise Host can compose (thirteen at PROD-02; ASSURE-01 added the durable
Evidence Bundle Store):

| Store | Variable | Backup file | Required when | Integrity |
|---|---|---|---|---|
| governance | `AOC_ENTERPRISE_SQLITE_PATH` | `stores/governance.sqlite` | always | per-record digests |
| agent-passport | `AOC_ENTERPRISE_PASSPORT_SQLITE_PATH` | `stores/agent-passport.sqlite` | always | per-passport digest chain |
| assurance | `AOC_ENTERPRISE_ASSURANCE_SQLITE_PATH` | `stores/assurance.sqlite` | always | per-assessment digests |
| kernel-authority | `AOC_ENTERPRISE_KERNEL_AUTHORITY_SQLITE_PATH` | `stores/kernel-authority.sqlite` | `AOC_ENTERPRISE_KERNEL_AUTHORITY_ENABLED=true` | digest-chained events (unsigned) |
| bounded-grants | `AOC_ENTERPRISE_BOUNDED_GRANT_SQLITE_PATH` | `stores/bounded-grants.sqlite` | governed actions configured | **Ed25519-signed**, CORE-07 anchored |
| emergency-controls | `AOC_ENTERPRISE_EMERGENCY_CONTROL_SQLITE_PATH` | `stores/emergency-controls.sqlite` | governed actions configured | digest-chained head (unsigned) |
| exercise-ledger | `AOC_ENTERPRISE_EXERCISE_LEDGER_SQLITE_PATH` | `stores/exercise-ledger.sqlite` | governed actions configured | per-record digests (unsigned) |
| authority-event-stream | `AOC_ENTERPRISE_AUTHORITY_EVENT_STREAM_SQLITE_PATH` | `stores/authority-event-stream.sqlite` | governed actions configured | digest-chained events (unsigned) |
| execution-outcomes | `AOC_ENTERPRISE_EXECUTION_OUTCOME_SQLITE_PATH` | `stores/execution-outcomes.sqlite` | governed actions configured | per-attempt digests (unsigned) |
| execution-resolutions | `AOC_ENTERPRISE_EXECUTION_RESOLUTION_SQLITE_PATH` | `stores/execution-resolutions.sqlite` | never from configuration (P12 is embedder-composed); backed up when its variable is set and the file exists | binding/resolution digests |
| obligation-discharges | `AOC_ENTERPRISE_OBLIGATION_DISCHARGE_SQLITE_PATH` | `stores/obligation-discharges.sqlite` | the governed-action file declares `obligations` | **Ed25519-signed** chain head, CORE-07 anchored |
| approvals | `AOC_ENTERPRISE_APPROVAL_SQLITE_PATH` | `stores/approvals.sqlite` | some Governance Profile declares `approval` | **Ed25519-signed** chain head, CORE-07 anchored |
| control-plane | `AOC_ENTERPRISE_CONTROL_PLANE_SQLITE_PATH` | `stores/control-plane.sqlite` | the governed-action file declares `operators` | append-only triggers (unsigned, **not** anchored) |
| evidence-bundles | `AOC_ENTERPRISE_EVIDENCE_SQLITE_PATH` | `stores/evidence-bundles.sqlite` | always (ASSURE-01) | per-row digest over the exact bundle bytes plus each bundle's own digests; lifecycle replayed from an append-only log (unsigned) |

Which conditional stores a deployment composes is read from the environment
and the **structure** of the governed-action file (`deriveDeploymentRequirements`):
the file is parsed as JSON and only its shape is inspected. No secret it
references is resolved, so the backup operator's process never needs, and
never touches, a credential value. A configured file that cannot be read or
parsed refuses the backup — the required stores would be unknowable.

A store that is **not required** is read only when its variable is explicitly
set **and** its file exists (an embedder's P12 store, for example). A default
path that merely happens to exist is never swept in — it is not this
deployment's state — but never silently either: it is recorded as
`present-not-configured` and the command prints a warning naming the variable
to set if an embedder does compose it.

**Deliberately excluded** (`EXCLUDED_DURABLE_STATE` in the registry): the
CORE-07 freshness witness's database and receipt key (a different restore
domain — see below), every secret and private key, the in-memory Evidence
Bundle Store (rebuilt from the Governance Store), policy packs (in-process
composition, no durable store), library-only SQLite stores the Host never
composes (access-governance, authority-governance, mandate and
protected-resource stores), and the governed-action file (configuration — its
SHA-256 is recorded so a restore can be matched to it).

## Command

```bash
npm run backup:v1 -- --output <directory> [--cold] [--force] [--allow-missing-stores]
```

Run it with the same environment you start the Host with. Requires
`npm run build` to have run.

- `--output <dir>` (required) — must not exist, or must be empty, unless
  `--force`/`--replace`.
- `--cold` — the operator attests the Host is stopped. The tool **cannot
  prove** a Host is stopped; it refuses when it sees evidence that one is not
  (a non-empty `-wal` sidecar beside any source store) and records the
  attestation and what it observed. Use it for every disaster-recovery and
  pre-upgrade backup: it is the only cross-store-consistent backup.
- `--allow-missing-stores` — development/forensics only. A required store
  whose file is absent is recorded as `missing-allowed`, the manifest says
  `coverage.complete: false`, `RESTORE.md` says **INCOMPLETE**, and a restore
  refuses it unless explicitly told to accept an incomplete backup.

## What the command does

1. Refuses anything but `AOC_ENTERPRISE_PERSISTENCE_PROVIDER=sqlite`.
2. Derives the deployment's required stores; refuses a missing required store
   (naming it, its variable and its condition) unless `--allow-missing-stores`.
3. With `--cold`, refuses if any source store has a non-empty WAL.
4. Refuses an `--output` nested in (or containing) any source store path.
5. Copies each store with **SQLite's Online Backup API** (`Database#backup()`),
   never a byte-level `cp`; switches the copy out of WAL mode so it is one
   self-contained file. The **whole** database is copied — a signed head
   travels inside the same file as its rows and is never reconstructed.
6. On each copy: `PRAGMA integrity_check` (any failure aborts the whole
   backup), the store's recorded schema version (refused unless this build
   supports it), SHA-256, byte size, the row count of every table, and — for
   the three signed stores — the signed head's store id, organization,
   sequence, state digest and signing key id, refusing a head that does not
   commit to exactly the rows present.
7. Writes `backup-manifest.json`, `checksums.sha256`, `metadata/*.json` and
   `RESTORE.md` into a staging directory beside `--output` and promotes it
   with one rename only after everything succeeded; any failure deletes the
   staging directory.

## Consistency model

Each store copy is transactionally consistent **for that store**. Thirteen
files are **not** one distributed transaction, and nothing here claims they
are: the manifest records `consistency.crossStoreAtomic: false`. Stop the Host
and pass `--cold` for strict cross-store consistency. Since PROD-02 a clean
Host shutdown closes every store it opened, so a stopped Host's data
directory carries no WAL sidecars (previously the approval, obligation and
control-plane stores stayed open past `close()`).

## Backup manifest (`aoc.enterprise.backup.v1`, coverage model `aoc.enterprise.backup.coverage.v1`)

The format identifier is unchanged; PROD-02 adds fields. Abbreviated:

```json
{
  "backupFormat": "aoc.enterprise.backup.v1",
  "backupId": "backup-<timestamp>-<short-commit>",
  "source": { "commit": "...", "branch": "...", "releaseVersion": "...", "nodeVersion": "...", "platform": "...", "architecture": "..." },
  "enterprise": { "enterpriseVersion": "...", "governanceStoreVersion": "...", "...": "..." },
  "stores": [
    {
      "name": "approvals", "filename": "approvals.sqlite", "envVar": "AOC_ENTERPRISE_APPROVAL_SQLITE_PATH",
      "checksum": "sha256:...", "sizeBytes": 0, "schemaVersion": 1, "required": true, "condition": "approvals-declared",
      "recordCount": 0, "tableCounts": { "approval_records": 0, "...": 0 }, "integrityCheck": "ok",
      "signedHead": { "storeId": "approval-store:...", "organizationId": "...", "sequence": 0, "stateDigest": "sha256:...", "signingKeyId": "...", "freshnessStateKind": "approval-state" }
    }
  ],
  "coverage": {
    "coverageModel": "aoc.enterprise.backup.coverage.v1",
    "complete": true,
    "registry": ["governance", "...fourteen names..."],
    "deployment": { "environment": "production", "organizationId": "...", "governedActions": true, "obligationsDeclared": true, "approvalsDeclared": true, "operatorsConfigured": true, "kernelAuthorityEnabled": true, "executionReconciliation": false, "governedActionsFileDigest": "sha256:..." },
    "stores": [{ "name": "...", "envVar": "...", "condition": "...", "required": true, "present": true, "included": true, "status": "included | not-configured | missing-allowed" }],
    "excluded": [{ "name": "authority-state-witness", "reason": "..." }]
  },
  "consistency": { "mode": "cold-attested | live-per-file", "operatorAttestedStopped": true, "nonEmptyWalObserved": [], "toolVerifiedHostStopped": false, "crossStoreAtomic": false },
  "authority": {
    "signer": { "mode": "software | external", "activeSigningKeyId": "...", "trustedVerificationKeys": [{ "keyId": "...", "algorithm": "ed25519-v1", "publicKeyFingerprint": "sha256:..." }], "privateKeyIncluded": false, "signerCredentialIncluded": false },
    "freshness": { "mode": "external", "witnessId": "...", "witnessPublicKeyFingerprint": "sha256:...", "witnessStateIncluded": false, "witnessCredentialIncluded": false }
  },
  "configuration": { "requiredEnvironmentVariables": ["..."], "secretEnvironmentVariables": ["AOC_ENTERPRISE_API_KEYS", "..."], "excludedSecrets": ["..."], "secretValuesIncluded": false }
}
```

- `stores` follows the registry's order. Every file is written with a
  stable-key serializer, so two backups of identical content diff cleanly.
- `coverage` is what lets a restore tell a complete backup from an
  incomplete one, and a pre-PROD-02 backup (which has none) from both — see
  `AOC_ENTERPRISE_RESTORE_V1.md` §"Coverage".
- `configuration.secretEnvironmentVariables` lists **names** only: the four
  static secret variables plus every `apiKeyEnv` / `tokenEnv` / `valueEnv`
  reference in the governed-action file. Values are never read.
- `authority` records only public, non-secret identities. The fingerprint is
  the SHA-256 of the public key's SPKI DER.

## Secrets and key material

`backup:v1` never reads a secret value: not `AOC_ENTERPRISE_API_KEYS`, not the
authority private key, not the external signer's token, not the witness
token, not an operator, administrator, customer or provider credential. The
PROD-02 drill plants a unique random canary in every one of those sources and
scans every byte of the backup set and the CLI's output: zero occurrences,
under software and external custody. Operator-issued agent secrets are not in
the control-plane store at all (it holds SHA-256 verifiers). Restoring
secrets is a secret-manager procedure, never a data restore —
`BACKUP_RECOVERY_V1.md` §"Key material and secrets".

## The freshness witness is never in a backup

The CORE-07 witness's state lives in a **different restore domain**: another
volume, another backup set, another snapshot schedule. `backup:v1` has no
definition for it, never contacts it, and never enrolls or resets it. Backing
the witness up *with* the authority stores and restoring both to the same
moment would make an old authority state look current — the one attack CORE-07
cannot detect.

## Security

- Never copies `.env`, keys, tokens or credentials; reads only the registry's
  store paths.
- Refuses an output path overlapping a source store.
- Sets no permissions beyond the process umask — **store backups encrypted,
  access-controlled and off-host.** Governed records, approval subjects and
  credential verifiers are sensitive.
- Backups are checksummed, not signed: whoever controls the backup storage
  can rewrite files and manifest together. The three signed stores still
  verify under the trusted authority keys on restore, and CORE-07 still
  refuses a stale signed state at startup; the unsigned stores have no such
  defense (`THREAT_MODEL_V1.md` §7.28).

## RPO / RTO

RPO is **your backup interval** — no replication, no point-in-time recovery.
Restoring anything older than the newest state also forgets every unanchored
change made after the backup (exercise consumption, outcomes, emergency
controls, Kernel Authority and control-plane changes); if any of the three
anchored stores changed after the backup, the secure Host refuses to start on
it instead. See `BACKUP_RECOVERY_V1.md` §"RPO and RTO" and the
qualification document for the observed (not guaranteed) drill timings.
