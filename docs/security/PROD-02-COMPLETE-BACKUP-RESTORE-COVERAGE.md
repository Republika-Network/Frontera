# PROD-02 — Complete Backup / Restore Coverage: Disaster Recovery & Clean-Room Qualification

- **Roadmap item:** `docs/architecture/FRONTERA-MASTER-PLAN.md` §9 PROD-02 (depends on PROD-01, soft — VERIFIED).
- **Exit criterion (Master Plan):** *a clean-room drill restores exercisable grants, revocations, ledgers and trace.*
- **Branch:** `feat/prod-02-complete-backup-restore-coverage`, from `main @ 57f3369` (the CTRL-04 merge).
- **Operator documents:** `docs/operations/BACKUP_RECOVERY_V1.md`, `AOC_ENTERPRISE_BACKUP_V1.md`, `AOC_ENTERPRISE_RESTORE_V1.md`, `AOC_ENTERPRISE_CLEAN_ROOM_DRILL.md`, `RUNBOOKS_V1.md` §4–5.
- **Security records:** `THREAT_MODEL_V1.md` §7.28; `SECURITY_INVARIANTS.md` §4.23 (SEC-INV-216 … SEC-INV-225); CORE-06 matrix rows `TM-7.28-1 … 27`.
- **Mutation evidence:** `docs/security/evidence/prod02-mutation-evidence.json`.

## 1. The goal, and what it is not

A Frontera deployment must come back from a backup as a functioning governed
authority system — with the security meaning of its durable state intact —
not as a directory of SQLite files. PROD-02 is **inventory → safe backup →
integrity and signed-state verification → compatibility validation →
fail-closed restore → secure-Host startup → semantic recovery verification**.

It is **not**: a parallel backup system (the existing `backup:v1` /
`restore:v1` / `validate:portability:v1` / `check:portability-smoke` tooling
is extended), a distributed transaction across thirteen files (none is
claimed), a secret store (no secret is ever in a backup), a way to recover a
lost one-time agent secret (rotate or reissue instead), ASSURE-01's unified
trace (PROD-02 preserves the existing P8 stream), or an extension of CORE-07
to the control-plane store (that needs its own decision).

## 2. Durable-state inventory (proven from code)

`loadEnterpriseConfiguration` (`src/enterprise/configuration/enterprise-configuration.ts`)
reads exactly thirteen `*_SQLITE_PATH` variables; the composition root opens
each under the condition below. Every other SQLite store in the repository
(access-governance, authority-governance, mandate and protected-resource
stores) is a library component the Host never composes — no Host
configuration names one. The CORE-07 reference witness has its own database
(`FRONTERA_REFERENCE_WITNESS_DB`), in a different process and restore domain.

| # | Store | Variable | Composed when | Schema source | Integrity / authenticity | Witness | Before PROD-02: backup / restore / fixture | Losing (or rolling back) it |
|---|---|---|---|---|---|---|---|---|
| 1 | governance | `AOC_ENTERPRISE_SQLITE_PATH` | always (sqlite) | `governance_store_versions` | per-record digests | — | yes / yes / yes | loses audit history and the committed decisions approvals and retries resume |
| 2 | agent-passport | `AOC_ENTERPRISE_PASSPORT_SQLITE_PATH` | always | `agent_passport_store_versions` | digest chain | — | yes / yes / yes | un-suspends passports, loses lifecycle |
| 3 | assurance | `AOC_ENTERPRISE_ASSURANCE_SQLITE_PATH` | always | `assurance_store_versions` | digests | — | yes / yes / yes | optional evidence only |
| 4 | kernel-authority | `AOC_ENTERPRISE_KERNEL_AUTHORITY_SQLITE_PATH` | `…_KERNEL_AUTHORITY_ENABLED=true` | `kernel_authority_store_versions` | digest-chained events, unsigned | — | yes / yes / yes | actors unrecognized (narrows); older copy restores withdrawn authority (widens) |
| 5 | bounded-grants | `AOC_ENTERPRISE_BOUNDED_GRANT_SQLITE_PATH` | governed actions | `bounded_grant_store_versions` | Ed25519 grants, revocations, revocation-state commitment | **yes** | no / no / no | lost or older revocation widens; refused under CORE-07 |
| 6 | emergency-controls | `…_EMERGENCY_CONTROL_SQLITE_PATH` | governed actions | `emergency_control_store_versions` | digest-chained head | — | no / no / no | active stop released (widens) |
| 7 | exercise-ledger | `…_EXERCISE_LEDGER_SQLITE_PATH` | governed actions | `exercise_control_ledger_versions` | per-record digests | — | no / no / no | consumed limits regain capacity; claims replayable (widens, duplicates) |
| 8 | authority-event-stream | `…_AUTHORITY_EVENT_STREAM_SQLITE_PATH` | governed actions | `authority_event_stream_versions` | digest chain | — | no / no / no | loses trace evidence only |
| 9 | execution-outcomes | `…_EXECUTION_OUTCOME_SQLITE_PATH` | governed actions | `execution_outcome_store_versions` (v1, v2) | per-attempt digests | — | no / no / no | duplicate provider effect |
| 10 | execution-resolutions | `…_EXECUTION_RESOLUTION_SQLITE_PATH` | embedder-composed P12 only | `execution_resolution_store_versions` | binding/resolution digests | — | no / no / no | bindings re-inferred, resolutions lost |
| 11 | obligation-discharges | `…_OBLIGATION_DISCHARGE_SQLITE_PATH` | file declares `obligations` | `obligation_discharge_store_meta` (integer) | Ed25519 chain head | **yes** | no / no / no | lost discharge withholds (narrows); refused when older |
| 12 | approvals | `…_APPROVAL_SQLITE_PATH` | a profile declares `approval` | `approval_store_meta` (integer) | Ed25519 chain head | **yes** | no / no / no | lost rejection/revocation re-approvable (widens); refused when older |
| 13 | control-plane | `…_CONTROL_PLANE_SQLITE_PATH` | file declares `operators` | `control_plane_versions` (no migration state) | append-only triggers, unsigned | **no** | no / no / no | lost: credentials and active profiles gone (narrows); older: revoked verifier back (widens — residual) |

**Final number: thirteen durable stores.** A fully configured shipped Host
composes twelve of them (P12 has no Host configuration); the PROD-02 drill
composes all twelve through the real Host and creates the thirteenth through
its own factory, as an embedder would.

## 3. Design

### 3.1 One registry (store-list drift removed)

`scripts/portability/store-registry.mjs` is the only list. It carries, per
store, the variable, the configuration field, the backup and target
filenames, the composition condition, the schema-version source and the
versions this build opens, the signed head and witness slot (if any), the
factory used for verification, and the loss effect. Backup, restore, the
fixture, the comparison, the clean-room drill and the tests derive from it;
the historical `targetStorePaths()` maps and the "three SQLite stores" wording
are gone (historical v1.0.0 reports are labelled as such).

Drift guards (`tests/portability-store-registry.structure.test.mjs`, 9
tests): every `*_SQLITE_PATH` the configuration loader reads is classified
(self-tested against a planted variable); each registry entry maps to the
field the Host reads and restores under the Host's own default filename; no
portability script names a store file except the registry (self-tested);
live copies use only the Online Backup API; every secret-bearing variable is
classified and no secret field is read; the witness is in no backup
definition; restore opens a store only on the scratch copy it just made.
And a Host-level cross-check boots four real deployments (full production;
production without operators/approvals/obligations; development without and
with Kernel Authority) and requires `deriveDeploymentRequirements` to predict
exactly the files the composition root created.

### 3.2 Conditional stores

Required stores are derived from the environment and the governed-action
file's **shape** (no secret is resolved): `always`,
`kernel-authority-enabled`, `governed-actions`, `obligations-declared`,
`approvals-declared`, `operators-configured`, `embedder-reconciliation`.
A required store must exist; a non-required store is read only when its
variable is explicitly set **and** its file exists (a stray default-path file
is never swept in — a defect the root suite exposed during development and
a regression test now pins). The manifest records each store as
`included`, `not-configured` or `missing-allowed`. `--allow-missing-stores`
survives for development/forensics only and makes the backup
`coverage.complete: false` and **INCOMPLETE**.

### 3.3 Format compatibility — additive, fail-closed coverage

Decision: keep `aoc.enterprise.backup.v1` and add an explicit coverage block
(`aoc.enterprise.backup.coverage.v1`). Rationale: the store-file format and
semantics did not change, so a format bump would orphan valid historical
backups for no benefit; what changed is what *completeness* means, and that is
now explicit and checked independently of the producer:

- restore re-derives the required set from the backup's recorded deployment
  using **its own** conditions, and from the restoring deployment's
  environment; a store missing from either is incompleteness, and a manifest
  that claims `complete` while omitting one is called out;
- a manifest **without** coverage is a pre-PROD-02 backup: understandable,
  never complete — refused unless `--allow-legacy-backup`, and still refused
  when the restoring deployment requires a store it lacks unless
  `--allow-incomplete` too;
- an unknown coverage model, an unknown store, a duplicate name or filename,
  or a registry-name/filename mismatch is refused;
- nothing is invented: an absent store stays absent.

### 3.4 Manifest

Answers: source commit, branch, runtime and store versions (deployment
generation); configured / included / not-configured / missing stores and why;
schema versions; SHA-256, size and per-table row counts; the signed heads
(store id, organization, sequence, digest, signing key id, witness slot);
the safe signer identity (mode, active key id, trusted keys as key id +
algorithm + SPKI fingerprint) and witness identity (id + key fingerprint);
`complete`; the consistency mode and what was observed (never "the Host was
stopped" — `toolVerifiedHostStopped` is always `false`); the secret
variable **names** to restore.

### 3.5 Cross-store consistency — no false atomicity

Each copy is transactionally consistent per store; the set is not one
transaction (`crossStoreAtomic: false`). Disaster recovery uses a cold
backup: `--cold` refuses when any source store has a non-empty WAL. Building
that check exposed a real defect: the Host's `close()` never closed the CORE-04
obligation, CORE-05 approval and CTRL-02 control-plane stores, so their
connections and WALs outlived a clean shutdown. Fixed in the composition root
(only stores it opened), with a regression test (no open descriptor, no WAL
after close) and mutation M31.

### 3.6 Restore: verify, stage, promote, roll back

Validation of the complete set precedes any write (§`AOC_ENTERPRISE_RESTORE_V1.md`).
Staged copies are re-checksummed together; each store is opened through its
own factory on a scratch copy — signed stores under the restoring
deployment's trusted public keys with a signer that never signs. Then every
registry-managed file and sidecar in the target (including stores the backup
lacks) is moved aside, staged files are renamed in and re-verified, and any
failure restores the target byte-for-byte. There is no cross-file filesystem
transaction; the guarantee is procedural and tested with failures injected
after the first, a middle and the last store, in post-promotion verification,
and on damaged staged and promoted files.

### 3.7 Restore mapping

Target filenames are the Host's own default basenames, so a restored
directory is a valid `.data/`; the report lists `{store, envVar, path}` for
every restored store and the CLI prints the variables. A test requires each
restored path to equal the restoring Host's variable (mutation M32 kills a
remap).

### 3.8 Secrets and key material

The backup reads no secret field; the manifest names the secret variables
(the four static ones plus every `apiKeyEnv` / `tokenEnv` / `valueEnv` in the
governed-action file). Procedures for software custody (private key, active
key id, every historical public key), external custody (signer restored
independently, pinned key id, trusted keys, injected token), the surviving
witness (id, pinned key, injected token) and operator/customer/provider
credentials are in `BACKUP_RECOVERY_V1.md` §"Key material and secrets". A lost
one-time agent secret is rotated or reissued, never extracted.

### 3.9 CORE-07 restore domain

No registry definition, script path or test helper backs up, restores, resets
or enrolls witness state; a planted witness file in a backup is refused; refused
boots leave the witness byte-identical; restore leaves it alone even when its
database path is in the restoring environment.

## 4. Qualification

All on the real shipped Host (`bootEnterpriseHost`, `production` profile,
SQLite, real loopback HTTP), unless stated.

### 4.1 Clean-room disaster recovery — the exit proof (`prod02-disaster-recovery-host.test.ts`)

Run twice: **software** custody and **external** custody (a separate-process
reference signer whose private key the test never reads). The CORE-07 witness
is a **separate process** with its own directory.

1. One deployment composes every Host store. Through public APIs only (the
   policy and the obligation discharge writer are trusted in-process
   composition, as in CORE-04/05): organization bootstrap; three profiles
   promoted, one retired, by a profile steward; approver standing; a payables
   agent (credential issued then **rotated**), a release agent, an offboarded
   agent (credential **revoked**), a withdrawn agent (actor **revoked**); a
   500 USD transfer under a 500 ceiling / 800 lifetime limit (ledger);
   two restarts executed (grants: one left **live**, one **revoked** by an
   operator); four approval requests — **approved** with an evidence hash,
   **rejected**, **pending**, **approved then revoked**; two obligations — one
   **discharged** (not yet resumed), one not; an active emergency **stop** and
   a declared-and-released one; an embedder-style P12 binding and
   resolution.
2. The Host stops; the backup **CLI** runs with `--cold`. Manifest: all
   thirteen stores, twelve required, `complete`, `cold-attested`, no witness
   state, signer mode correct; each signed head equals the surviving witness's
   committed checkpoint.
3. **Canaries:** a unique random secret in every source — legacy API key,
   customer principal key, provider (Generic HTTP) token, CTRL-01
   administrator key, five operator keys, two approver keys, external signer
   token, witness token, and (software custody) the private-key PEM and every
   base64 line of it — **zero occurrences** in every byte of the backup set,
   `RESTORE.md`, metadata, and the CLI's stdout/stderr.
4. The data directory is **deleted**. `restore:v1` rebuilds a fresh directory
   with the restoring environment: complete; the three signed stores
   `verified-under-trusted-keys`; every target path equals its Host variable.
5. The secure Host boots on the restored data, secrets from the environment,
   the **surviving** witness (posture `authorityFreshness: external`,
   `authenticated-durable`, signer as configured; `/ready` 200). Then, by
   behaviour and adapter count (starting from zero):

| Property | Result |
|---|---|
| Completed execution not repeated | the transfer retried with its key → `executed`, **same execution id**, adapter **0** |
| Ledger consumption survives | 400 → withheld (0 calls); 300 → executed (1); 1 → withheld (1) |
| Credentials | rotated-out → 401; revoked → 401 |
| Kernel Authority | withdrawn actor refused exactly as before; a new restart executes (2) — actors recognized |
| Live grant exercisable | grant view `exercisable`, no revocation; exercised → executed (3) |
| Revoked grant stays revoked | signed revocation (`security-incident`) present; exercise withheld (3) |
| Emergency stop | active list identical; transfer to the stopped resource withheld (3) |
| Approvals | approved resumes once (4) with the **same approval digest** and evidence hash; replay → no call; rejected and revoked → not executed; pending stays `pending` (4) |
| Obligations | discharged releases (5); undischarged withholds (5) |
| Profile lifecycle | identical states; the retired profile still governs nothing (5) |
| Governance | the transfer's committed decision re-readable |
| Trace (P8) | every pre-backup event digest present; the stream kept growing |
| P12 | binding and resolution digests identical; a different authority cannot rebind |

Observed (not an SLA): ~9.7 s (software) and ~9.9 s (external) for the whole
drill on this machine, including building the state.

### 4.2 Stale-backup drill (`prod02-stale-restore-host.test.ts`)

S1 (live grant, approved approval, pending obligation) → cold backup A →
S2: grant revoked, approval revoked, obligation discharged (each witnessed)
→ cold backup B. Restoring A (fresh directory, witness kept at S2, the
witness database reachable from restore's environment) **succeeds as a
restore** — restore cannot know freshness — and the Host **refuses to start**
with `AUTHORITY_FRESHNESS_ROLLBACK_DETECTED`; adapter calls **0**; witness rows
byte-identical. Each signed store from A placed alone into a restore of B is
refused the same way. Control: B restores and boots; the revocation, the
approval revocation and the discharge are current.

### 4.3 Control-plane residual (pinned)

A backup taken before a credential revocation and a profile retirement,
restored: the Host starts (no anchored store moved), the revoked credential
**executes again** and the retired profile is **active again** — RESIDUAL,
pinned by a test named so. The runbook step (re-revoke, re-retire) is proven
to close it. Not labelled BLOCKED.

### 4.4 Integrity matrix (`prod02-backup-integrity-host.test.ts`, 53 tests)

On a real deployment's cold backup: 22 tamper cases refused before the target
is touched (format, malformed/missing manifest, dropped store, missing file,
extra file, planted witness file, checksum, corruption behind a recomputed
checksum, unsupported schema, file/manifest schema disagreement, symlink,
path traversal, cross-mapped file, duplicate names, unknown store, unknown
coverage model, rows without head, head without rows, revocation-state
mismatch, substituted head, forged head with rewritten manifest), foreign
organization and transplanted signed store, source/target overlap, legacy and
historical four-store backups, incomplete backups (the missing store is not
created; the secure Host refuses its genesis under the witness); rollback
after the 1st, 6th and 12th store, after post-promotion verification, on a
damaged staged copy and a damaged promoted file; `--force` leaves exactly the
backup set; `--cold` refuses a running Host; an unreadable governed-action file
refuses; no handle or WAL after `close()`; registry ↔ composition for four
deployments. Added after the reviews (§7): non-boolean deployment flags; a
store recorded as required-but-absent; the consistently forged manifest
(caught with the restoring environment, a pinned RESIDUAL without it); a
manifest without an organization; a legacy backup's signed stores against the
restoring organization; a secure-profile restore without verification keys;
symlinks at a target store, sidecar and report (nothing written through
them); a target symlinked into the backup; the in-progress marker; a target
that changes while the backup is verified; no marker, staging or safety
directory after any rollback.

### 4.5 Existing coverage kept

Governance, Passport, Assurance and Kernel Authority keep their v1 contract
tests and logical comparison (`portability-backup-restore.contract.test.mjs`,
`durable-authority-portability.contract.test.mjs`, the smoke check), now on
registry paths, plus the stray-default regression.

## 5. Pending witness transitions

| Witness | Restored head | Result |
|---|---|---|
| committed = head | — | starts |
| committed newer | older | refused `ROLLBACK_DETECTED` (§4.2) |
| pending P, head = P | — | starts; the Host finalizes P (CORE-07 case B) |
| pending P, head = predecessor | — | refused `PENDING_RECOVERY` (CORE-07 case A) — trusted operational recovery, `RUNBOOKS_V1.md` §5.3; no abort API is added |

The two pending rows are CORE-07 behaviour, qualified by its own suites
(C3/C4); PROD-02 adds no code path that could clear a pending transition.

## 6. Mutation campaign

See `docs/security/evidence/prod02-mutation-evidence.json` (per mutation:
id, file, exact edit, attacked property, killing test, failure, before/after
SHA-256). Run on a native `git archive` export of `6cc0529`: **41 defined, 41 counted (all compiled), 41 killed, 0 survived**; every mutated file restored byte-for-byte (SHA-256 before = after) and the whole export identical to a fresh archive afterwards. History (earlier partial runs, the M23 survivor that strengthened the drill, the runner's kill detection): in the evidence file.

| Id | File | Mutation | Property attacked | First killing test | Result |
|---|---|---|---|---|---|
| M1 | backup-enterprise-v1.mjs | bounded-grant store omitted from the backup | every composed store is backed up (bounded grants) | stop → cold backup → destroy → restore into a fresh directory → secure Host boots on the surviving witness … | KILLED |
| M2 | backup-enterprise-v1.mjs | emergency-control store omitted from the backup | every composed store is backed up (emergency controls) | stop → cold backup → destroy → restore into a fresh directory → secure Host boots on the surviving witness … | KILLED |
| M3 | backup-enterprise-v1.mjs | exercise ledger omitted from the backup | every composed store is backed up (exercise ledger) | stop → cold backup → destroy → restore into a fresh directory → secure Host boots on the surviving witness … | KILLED |
| M4 | backup-enterprise-v1.mjs | authority event stream omitted from the backup | every composed store is backed up (event stream) | stop → cold backup → destroy → restore into a fresh directory → secure Host boots on the surviving witness … | KILLED |
| M5 | backup-enterprise-v1.mjs | execution outcome store omitted from the backup | every composed store is backed up (outcomes) | stop → cold backup → destroy → restore into a fresh directory → secure Host boots on the surviving witness … | KILLED |
| M6 | backup-enterprise-v1.mjs | execution resolution store omitted from the backup | an explicitly configured store is backed up (P12) | stop → cold backup → destroy → restore into a fresh directory → secure Host boots on the surviving witness … | KILLED |
| M7 | backup-enterprise-v1.mjs | obligation discharge store omitted from the backup | every composed store is backed up (obligations) | stop → cold backup → destroy → restore into a fresh directory → secure Host boots on the surviving witness … | KILLED |
| M8 | backup-enterprise-v1.mjs | approval store omitted from the backup | every composed store is backed up (approvals) | stop → cold backup → destroy → restore into a fresh directory → secure Host boots on the surviving witness … | KILLED |
| M9 | backup-enterprise-v1.mjs | control-plane store omitted from the backup | every composed store is backed up (control plane) | stop → cold backup → destroy → restore into a fresh directory → secure Host boots on the surviving witness … | KILLED |
| M10 | backup-enterprise-v1.mjs | a configured missing store treated as complete | an incomplete backup is never marked complete | an incomplete backup (missing stores explicitly allowed) is refused; with --allow-incomplete it restores wi… | KILLED |
| M11 | restore-enterprise-v1.mjs | restore skips checksum validation | a modified store file is refused | refuses a checksum mismatch in the exercise ledger | KILLED |
| M12 | restore-enterprise-v1.mjs | restore skips SQLite integrity_check | a corrupted store is refused as an integrity failure | refuses SQLite corruption behind a recomputed checksum (emergency controls) | KILLED |
| M13 | restore-enterprise-v1.mjs | restore accepts an unsupported schema version | an unsupported schema is refused | refuses a schema version this build does not support (control plane) | KILLED |
| M14 | restore-enterprise-v1.mjs | restore accepts an unmanifested extra file | only declared files are restored | refuses an unexpected extra store file | KILLED |
| M15 | restore-enterprise-v1.mjs | restore allows a symlinked store | symlinks are refused | refuses a symlinked store | KILLED |
| M16 | restore-enterprise-v1.mjs | restore allows a path-escaping filename | filenames stay inside stores/ under their registry name | refuses a path-traversing filename | KILLED |
| M17 | backup-enterprise-v1.mjs | backup serializes referenced secret values | no secret value enters a backup artifact | stop → cold backup → destroy → restore into a fresh directory → secure Host boots on the surviving witness … | KILLED |
| M18 | lib-portability.mjs | an approval head that does not commit to its rows tolerated | signed head and rows restore together | refuses a signed approval head without the rows it commits to | KILLED |
| M19 | restore-enterprise-v1.mjs | restore skips post-copy verification of staged files | a damaged copy is never promoted | a staged copy damaged before promotion is refused by the post-copy checksum, and the target is untouched | KILLED |
| M20 | restore-enterprise-v1.mjs | partial restore without rollback | the target ends exactly old or exactly new | a failure after 1 store(s) were promoted rolls every managed file back | KILLED |
| M21 | restore-enterprise-v1.mjs | restore drops the emergency-control store (stop released on restart) | an active stop survives restore | stop → cold backup → destroy → restore into a fresh directory → secure Host boots on the surviving witness … | KILLED |
| M22 | restore-enterprise-v1.mjs | restore drops the exercise ledger (consumption reset) | consumed limits stay consumed | stop → cold backup → destroy → restore into a fresh directory → secure Host boots on the surviving witness … | KILLED |
| M23 | restore-enterprise-v1.mjs | restore drops execution outcomes (completed execution retried through the adapter) | no duplicate provider effect | stop → cold backup → destroy → restore into a fresh directory → secure Host boots on the surviving witness … | KILLED |
| M24 | restore-enterprise-v1.mjs | restore drops the execution-resolution store (binding re-inferred) | the binding is restored, never re-inferred | stop → cold backup → destroy → restore into a fresh directory → secure Host boots on the surviving witness … | KILLED |
| M25 | restore-enterprise-v1.mjs | restore drops the obligation discharge store (discharge lost) | a verified discharge survives restore | stop → cold backup → destroy → restore into a fresh directory → secure Host boots on the surviving witness … | KILLED |
| M26 | backup-enterprise-v1.mjs | backup un-revokes agent credentials in the control-plane copy | a revocation in the backup stays a revocation | stop → cold backup → destroy → restore into a fresh directory → secure Host boots on the surviving witness … | KILLED |
| M27 | restore-enterprise-v1.mjs | restore re-enrolls the witness at the restored heads | restore never resets or re-enrolls the witness | S1 → backup A → S2 (revoke grant, revoke approval, discharge obligation) → restore A → refused before any a… | KILLED |
| M28 | session.ts | a store older than the witness accepted as ready | a stale authority restore stays fail-closed | S1 → backup A → S2 (revoke grant, revoke approval, discharge obligation) → restore A → refused before any a… | KILLED |
| M29 | store-registry.mjs | witness state added to the backup definitions | the witness is outside the restore domain | every durable SQLite path the Host configuration reads is classified by the registry (backed up or excluded… | KILLED |
| M30 | restore-enterprise-v1.mjs | a pre-PROD-02 backup accepted as complete | a historical incomplete backup is never complete | a pre-PROD-02 (legacy) backup is never accepted as complete; with the explicit flag it restores and says so | KILLED |
| M31 | composition-root.ts | Host shutdown leaves the approval, obligation and control-plane stores open | a clean shutdown releases every store (cold-backup precondition) | PROD-02 restore refuses a damaged or incomplete backup before touching the target | KILLED |
| M32 | store-registry.mjs | restore writes stores under their backup filenames, not the Host's | each restored file is the one its Host variable names | stop → cold backup → destroy → restore into a fresh directory → secure Host boots on the surviving witness … | KILLED |
| M33 | restore-enterprise-v1.mjs | non-boolean deployment flags accepted | the producer record is strictly typed | refuses a deployment flag that is not a boolean (a string "true" must not quietly un-require a store) | KILLED |
| M34 | restore-enterprise-v1.mjs | a store recorded as required-but-absent ignored | a required store the backup lacks keeps it incomplete | refuses a backup that records a required store as not included, even when its flags were rewritten and no r… | KILLED |
| M35 | restore-enterprise-v1.mjs | no in-progress marker during promotion | an uncatchable interruption is visible to the next restore | RESIDUAL: a manifest forged consistently (flags and coverage both rewritten) passes only when no restoring … | KILLED |
| M36 | restore-enterprise-v1.mjs | a symlink at a target store path accepted | restore never writes through or replaces a link | refuses a symlink at a target store path, even a dangling one | KILLED |
| M37 | lib-portability.mjs | overlap judged on spelled paths | a target resolving into the backup is refused | refuses a target that is a symlink into the backup directory | KILLED |
| M38 | restore-enterprise-v1.mjs | signed-store binding not checked against the restoring organization | no store is transplanted between organizations | refuses a legacy backup whose signed stores belong to another organization than the restoring deployment | KILLED |
| M39 | backup-enterprise-v1.mjs | an unclaimed default-path store silently skipped | a skipped store is never silent | a store file at a default path the deployment neither requires nor names is never swept into the backup (PR… | KILLED |
| M40 | restore-enterprise-v1.mjs | the target is not re-inspected before promotion | a store appearing during verification is never overwritten | refuses a target that changed while the backup was being verified, and leaves the newcomer alone | KILLED |
| M41 | restore-enterprise-v1.mjs | the report is registered for rollback only after it is written | a partial report never survives a failed restore | restore never opens (and so never creates) a store it did not just copy and verify | KILLED |

## 7. Adversarial reviews

Two independent, read-only reviews.

- **Review 1, of `122e6e1`.** No critical or high finding. Six verified
  issues, all fixed in `e2e0304`: (1) restore judged completeness from
  producer-written deployment flags without type checks, and silently when no
  restoring environment was given; (2) organization checks keyed off an
  optional manifest field and skipped legacy backups; (3) a P12 file at its
  default path skipped silently; (4) an uncatchable mid-promotion interruption
  was undetectable and the report was written outside the rollback; (5)
  target-side symlinks (dangling links, a report written through a link,
  predictable staging names, a stale report surviving a failed restore); (6)
  overlap judged on spelled, not real, paths. Doc rows it showed overstated
  were downgraded (the uncatchable interruption is PARTIAL; the consistently
  forged manifest without a restoring environment is RESIDUAL).
- **Review 2, of `e2e0304`.** Confirmed all six fixes; no critical or high
  finding; seven low issues, all fixed in `87c1736`: a report registered for
  rollback only after its write; a rollback removing another run's marker; a
  target changing between inspection and promotion; case-insensitive
  filesystems in the overlap check; the generated `RESTORE.md` omitting the
  environment requirement; missing tests for symlinked sidecars/reports and
  for dot-file cleanliness after rollback; and the P12 row (narrowed to "its
  variable set"). The realpath case fold is implemented for win32/darwin but
  not exercised on those platforms (unverified there).

The final commit `87c1736` was not reviewed a third time.

## 8. Residual risks

1. **Control-plane rollback** — an older control-plane copy resurrects revoked
   credential verifiers and older profile lifecycle (pinned; runbook
   mitigation). CORE-07 does not anchor this store.
2. **Unanchored state on an older (complete) restore** — exercise
   consumption, outcomes (duplicate-effect risk for actions executed after the
   backup), emergency controls, Kernel Authority and the trace roll back to the
   backup point. RPO; restore the newest cold backup; re-apply post-backup
   revocations and stops.
3. **Backups are checksummed, not signed** — whoever controls backup storage
   can rewrite unsigned stores and the manifest together.
4. **Witness co-restore** — an operator restoring the witness from its own
   backup to the same moment defeats CORE-07 by design.
5. **No cross-file transaction** — an external `SIGKILL` mid-promotion can leave
   a mixed target; a failed rollback is reported, not automated.
6. **Pending prepared transition** — trusted operational recovery only.
7. **Quiescence is evidence, not proof** — `--cold` refuses visible WAL activity;
   it cannot prove no other writer exists.
8. **P12** — the shipped Host composes no reconciliation; P12 restore is proven
   at the store level.
9. **Consistently forged manifest without the restoring environment** — caught
   with it (the CLI requires it); without it (`--no-target-check`, or an
   embedder calling `runRestore` without `env`) only the unsigned manifest can
   be judged, and the report says so.
10. **Uncatchable interruption mid-promotion** — marked (`.restore-in-progress`),
    not undone; the Host does not read the marker.
11. **P12 at its default path with the variable unset** — reported, not backed up.
12. **`release/RELEASE_MANIFEST.json`** still states 28 endpoints (stale since
    CTRL-01, pre-existing; regenerate before tagging). PROD-02 adds no endpoint.

## 9. Validation

Working copy (ext4 mirror of the worktree; not a clean export, and not a
certification of any later commit), on the content of `87c1736` plus the
`6cc0529` drill assertion:

- typecheck, lint, build green;
- root suite **9 060 tests: 9 047 pass, 0 fail**, 9 skipped (live Pinata and
  non-durable-provider cases, pre-existing), 4 todo;
- workspaces **1 089 / 1 089**;
- PROD-02: exit drill 2 / 2 (software, external), stale drill 2 / 2,
  integrity 53 / 53, structural 9 / 9, contract 21 / 21; CORE-06 BLOCKED
  matrix and security-invariant drift checks 47 / 47;
- portability smoke, API freeze (56 endpoints, none added), release docs, SDK
  surface green; legal report pre-existing findings only (no dependency added);
  `git diff --check` clean.
- `verify-release-manifest` reports the committed manifest's 28-endpoint count
  as stale — identical on `57f3369`, pre-existing (§8).

The clean `git archive` export of the final commit, and its exact results, are
in the milestone report (no commit follows that run).
