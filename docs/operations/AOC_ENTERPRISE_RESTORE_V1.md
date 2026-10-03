# AOC Enterprise v1 — Automated Restore (`restore:v1`)

Companion to `docs/operations/AOC_ENTERPRISE_BACKUP_V1.md`. Validates an
`aoc.enterprise.backup.v1` backup set completely **before** touching the
target directory, and fails closed — it never repairs, migrates, invents or
partially restores. The store list, the target filenames and the variable each
file serves all come from the one registry,
`scripts/portability/store-registry.mjs`.

## Command

```bash
npm run restore:v1 -- --backup <backup-directory> --target <target-directory> \
  [--force] [--allow-incomplete] [--allow-legacy-backup]
```

Run it **with the restoring deployment's environment** (the CLI passes
`process.env`): that is how restore knows which stores the deployment needs,
which organization it serves, and which public authority keys it trusts. The
CLI refuses to run without a `sqlite` deployment environment unless
`--no-target-check` is passed; a secure-profile environment
(`production`/`staging`) must supply its trusted verification keys.

- `--target <dir>` — restored files are written under the registry's target
  names, which are the Host's own default basenames (`enterprise-host.sqlite`,
  `bounded-grants.sqlite`, `approvals.sqlite`, …). The command prints, and
  `restore-report.json` records, the exact `VARIABLE=path` for each restored
  store.
- `--force` / `--replace` — required when the target already holds any
  registry-managed file or sidecar.
- `--allow-incomplete` — forensics only: accept a backup that does not contain
  every required store. The missing store is **not created**.
- `--allow-legacy-backup` — accept a pre-PROD-02 backup (no coverage record)
  explicitly; it is reported as `coverage.model: legacy, complete: false`.
- `--no-target-check` — restore against the backup's own record only. Backups
  are checksummed, not signed, so a consistently forged manifest cannot be
  caught this way; the report says `targetCoverageChecked: false`.

Requires `npm run build`.

## Validation order (all before the target is touched)

1. **Manifest** — exact format `aoc.enterprise.backup.v1`; required fields;
   a safe `backupId`; every store entry names a store this registry knows
   (an unknown store is refused, never dropped), under its registry filename;
   no duplicate store name or filename.
2. **Organization** — when the restoring deployment is given, the backup's
   organization must be the one it serves; every signed store must be bound
   to the backup's organization. A store is never transplanted.
3. **Coverage** (below).
4. **Files** — exactly the declared files under `stores/` (an extra file —
   including a planted witness database — is refused); no symlink; no path
   escape; SHA-256; `PRAGMA integrity_check`; the schema version is one this
   build supports *and* is the version the file itself records; for the
   three signed stores, the signed head commits to exactly the rows present
   (never rows without a head, never a head without its rows) and equals the
   head the manifest recorded at backup time. A file SQLite cannot read is a
   named refusal.
5. **Staging** — every store copied into a staging directory beside the
   target and re-checksummed.
6. **Deep verification** — each staged store is opened through its **own
   factory** on a scratch copy (never on the target, never on a missing path:
   a factory creates a store when the file is absent, which restore must never
   do). The three signed stores are opened with the restoring deployment's
   **trusted verification keys** (`AOC_ENTERPRISE_AUTHORITY_VERIFICATION_KEYS`,
   public keys) and a signer that refuses to sign, so they open only if their
   signed state verifies; the report says `verified-under-trusted-keys`, or
   `not-checked` when no keys were supplied. Opening never re-signs, strips a
   signature or replaces a key id: a rotated key's re-attestation is a
   best-effort write that the refusing signer skips, on a copy that is thrown
   away.

### Coverage

| Backup | Result |
|---|---|
| PROD-02 manifest with strictly typed deployment flags and every registry store recorded once; every store its recorded deployment composes is included (the rules are this build's, re-applied — the flags are the producer's record), nothing it records as required is absent, and every store the restoring deployment requires is included | **restored** |
| a required store is missing (from either point of view), or the manifest claims `complete` while omitting a store | **refused** — `--allow-incomplete` restores the rest and creates nothing for the missing store |
| unknown (newer) coverage model | **refused** |
| pre-PROD-02 (no `coverage`) | **refused** — `--allow-legacy-backup` restores it as `legacy`, incomplete; still refused if the restoring deployment requires a store it lacks, unless `--allow-incomplete` too |

An incomplete restore never silently becomes a deployment with an empty
authority store: on a secure Host the surviving witness refuses the fresh
genesis the store would otherwise create
(`AUTHORITY_FRESHNESS_ROLLBACK_DETECTED`); an unsigned store (emergency
controls, ledger, control plane) has no such defense, which is why the flags
exist only for forensics.

## Replacement and rollback

- Target paths are examined with `lstat`: a symlink at any store path,
  sidecar or the report — even a dangling one — is refused, and overlap with
  the backup is judged on real paths. Staging and safety directories get
  unpredictable names; the report and an in-progress marker
  (`.restore-in-progress`) are created exclusively.
- Every registry-managed file already in the target — **including stores the
  backup does not contain, every `-wal`/`-shm` sidecar, and the previous
  `restore-report.json`** — is moved (not
  copied) into `<target>/.pre-restore-safety-<backupId>-<time>/` first, so the
  restored target is exactly the backup set, never a hybrid with a stale file
  or a foreign WAL.
- Staged files are then renamed into place one by one and verified again
  (checksum, no sidecar).
- **Any failure after the first move rolls the target back**: every promoted
  file is removed and every moved-aside file is renamed back, so the target
  ends byte-for-byte as it was. If the rollback itself cannot complete, the
  error says so and names the safety directory; do not start the Host on that
  target.
- On success the safety directory stays as the pre-restore copy.

Across thirteen files there is no filesystem transaction. The guarantee is
procedural — stage, verify, move aside, promote, verify, roll back on any
failure — and is qualified with failures injected after the 1st, 6th and last
store and in post-promotion verification
(`prod02-backup-integrity-host.test.ts`). An external `SIGKILL` mid-promotion
can still leave a mixed target. It is then **marked**: `.restore-in-progress`
stays, the next restore refuses the target until an operator has inspected the
safety and staging directories (both sides are there) and removed the marker
deliberately, and re-running `restore:v1 --force` recovers. The Host does not
read the marker — do not start it on a marked target.

## Freshness witness

Restore never touches the CORE-07 witness: not its database (never in a
backup), not its slots (no reset, no enrollment). After a restore, start the
Host against the **surviving** witness:

- the backup holds the latest authority heads → the Host starts;
- the backup is older than an authority transition the witness recorded (a
  grant revocation, an obligation discharge, an approval verdict) → the Host
  refuses to start before handing out any authority
  (`AUTHORITY_FRESHNESS_ROLLBACK_DETECTED`). Restore a newer backup. Never
  reset or re-enroll the witness to make an old backup start — that is the
  attack CORE-07 exists to stop.

## Restore report

```json
{
  "backupId": "backup-...",
  "status": "restored",
  "coverage": { "model": "aoc.enterprise.backup.coverage.v1", "complete": true },
  "objectVerification": { "approvals": { "opened": true, "status": "healthy", "authenticity": "verified-under-trusted-keys", "signedHead": "structurally-consistent" }, "...": {} },
  "targets": [{ "store": "approvals", "envVar": "AOC_ENTERPRISE_APPROVAL_SQLITE_PATH", "path": "/data/approvals.sqlite" }],
  "notRestored": ["execution-resolutions"],
  "freshnessWitness": "not restored (never part of a backup); start the Host against the surviving witness",
  "preRestoreSafetyCopy": null
}
```

## Compatibility

| Backup | Store schema | Result |
|---|---|---|
| `aoc.enterprise.backup.v1` | a version this build opens (the execution-outcome store opens v1 and v2) | supported |
| `aoc.enterprise.backup.v1` | any other version | refused — no migration runner; use the build recorded in `metadata/release-context.json` |
| any other format | any | refused |

## Failure modes (each refused before the target is touched, each tested)

Unsupported format; malformed or missing manifest; a store silently dropped
from the manifest; a missing store file; an unexpected extra file (including a
witness database); a checksum mismatch; SQLite corruption behind a recomputed
checksum; an unsupported schema version; a file whose own schema disagrees with
the manifest; a symlinked store; a path-traversing filename; a store mapped to
another store's file; duplicate store names; an unknown store; an unknown
coverage model; approval rows without their signed head; a signed head without
the rows it commits to; a revocation-state commitment that no longer matches
its revocations; a substituted signed head; a forged signed head with a
rewritten manifest (caught by the trusted keys); a backup of another
organization; a signed store bound to another organization; a source/target
overlap; a pre-PROD-02 backup; an incomplete backup. Evidence:
`src/enterprise/__tests__/prod02-backup-integrity-host.test.ts`,
`tests/portability-backup-restore.contract.test.mjs`.

## After a restore

Start the Host (the matching build) with the printed variables, the
deployment's secrets from the secret manager, and the surviving witness. Then
follow `RUNBOOKS_V1.md` §5 (restore) — including the control-plane step: the
control-plane store is not witness-anchored, so any agent credential revoked
or profile retired after the backup must be revoked or retired again.
