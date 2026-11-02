# ASSURE-OPS-02 — Secure Customer Data Operations

Status: implemented on `feat/assure-ops-02-secure-customer-data`, from
`origin/main` @ `6a838803` (ASSURE-OPS-01, #251). Not deployed. No customer
data was used.
**This is not a commercial authorization.** `rn.sv@0.1.0` keeps
`commercialUse: restricted`. The launch gate stays **NO-GO**.

**Deployment model:** one private, isolated Host and one dedicated data
environment per customer engagement. The Host already serves exactly one
organization (REL-01D). This mission adds the engagement boundary around it as
operator tooling, `scripts/assurance/engagement-ops.mjs`. It is not a
multi-tenant platform, and the Host itself is unchanged.

**What is new.** One operator tool, built entirely on existing tested
components: backup:v1, restore:v1, the AUTH-04D1 AES-256-GCM sealed container,
and Assurance custody verification. No new cryptography.

**What was fixed.** The portability tooling resolved its own location with
`new URL(...).pathname`. That yields `C:\C:\…` under Windows Node, so backup and
restore could not run on the Windows-native environment. It now uses
`fileURLToPath`/`pathToFileURL`, which behaves identically on Linux. The release
manifest checksums of the six changed scripts are updated.

## 1. Data inventory

Every class of information in an engagement, from the code. "Customer data"
means information about, or supplied by, the assessed organization.

| # | Data | Exact location | Customer data? | Sensitivity | Encrypted at rest by the product? | Readers / writers | Retention behaviour | Backup | Deletion |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Engagement record (`engagementId`, `organizationId`, lifecycle events) | `<root>/engagement.json` | Identifiers only | Low | No (volume) | Custody admin (tool) | Append-only events | Not in backup:v1; recreate on restore | With the root |
| 2 | Assessment, scope declaration, status, results, integrity digests | Assurance Store `<root>/data/assurance.sqlite`, `assurance_assessments` (JSON) | **Yes** (scope, subject, system names) | High | No (volume) | Host only; reviewer credentials over HTTP | Immutable once terminal | backup:v1 `stores/assurance.sqlite` | Store destruction only |
| 3 | Evidence **references**: id, type, external id, organization, digest, dates, supplier claims, provenance (`collectedBy` …), free-form `metadata`, `requirementIds` | Inside the assessment JSON and the projection table `assurance_evidence_references` | **Yes** (metadata may hold anything an operator types) | High | No | Host; submitted by `assure.reviewer` | Immutable once terminal | Yes | Store destruction only |
| 4 | Evidence **content** (files) | **Not stored by the Host.** Optionally `<root>/intake/` (operator-placed), or left with the customer | **Yes** | Very high | No (volume) | Assigned reviewer | Operator-controlled | **Not** in backup:v1 | Root disposition |
| 5 | Manual reviews: reviewer id, outcome, free-text rationale, cited evidence | `assurance_manual_reviews` | **Yes** (rationale) | High | No | Host; append-only (OPS-01 R-02) | Append-only | Yes | Store destruction only |
| 6 | Control evaluations, domain assessments, scores, findings, finding events, signals | Assessment JSON and the projections `assurance_control_evaluations`, `assurance_domain_assessments`, `assurance_scores`, `assurance_findings`, `assurance_finding_events`, `assurance_signals` | **Yes** | High | No | Host | Append-only | Yes | Store destruction only |
| 7 | Report drafts | **Not stored**: built on demand and returned over HTTP | Yes | High | n/a | Reviewer or approver credential | Transient | n/a | n/a |
| 8 | Commercial release custody v1 (manifest, release record) and v2 (+ approved content and Markdown) | `assurance_commercial_releases` (append-only triggers) | **Yes** (v2 holds the report) | High | No | Host | Append-only; never deleted | Yes | Store destruction only |
| 9 | Export envelopes, materialised packages | `<root>/exports/` by procedure; anywhere the operator writes | **Yes** (the full report) | High | No | Operator | Operator-controlled | No | Root disposition |
| 10 | Reviewer and organization credentials | Environment variables named in the governed-action file (`apiKeyEnv`), and the operator's secret manager | No (secret) | Critical | Secret manager | Host process; the holder | Rotation by restart | **Never** (backup:v1 excludes all secrets) | Revoke in the secret manager (MANUAL) |
| 11 | Host configuration (governed-action file, environment) | `<root>/governed-actions.json` (recommended) plus the process environment | No secrets inline (refused by the Host) | Medium | No | Custody admin | — | Digest recorded only | Root disposition |
| 12 | Logs | Host stdout (`enterprise.assurance.operator`: ids, operation, status, code) | Identifiers only (tested: no token, body, evidence, rationale or report) | Medium | Wherever stdout is collected | Platform | Platform's | No | Platform's (MANUAL) |
| 13 | Telemetry | In-process only; no exporter is configured | No | Low | n/a | — | — | — | — |
| 14 | SQLite `-wal` / `-shm` sidecars | Beside each store in `<root>/data/` | **Yes** (uncheckpointed pages) | High | No | Host | Removed on clean shutdown | Backup uses the Online Backup API; the copy leaves WAL mode | Root disposition |
| 15 | Other Host stores (governance, passport, kernel-authority, evidence bundles, governed-action stores) | `<root>/data/*.sqlite` | Host-internal; holds customer data only if the engagement uses governed actions | Medium | No | Host | Store-specific | Yes | Store destruction |
| 16 | Sealed engagement backups | Off-host location chosen by the custody admin (`externalLocations.backups`) | **Yes**, encrypted | High | **Yes**: AES-256-GCM, engagement key | Custody admin | Operator-controlled | — | Delete copies, then destroy the key (MANUAL) |
| 17 | Backup key | Secret manager; a key file only while in use | No (secret) | Critical | Secret manager | Custody admin | — | Never in a backup | Destroy (MANUAL; cryptographic erasure of every backup sealed with it) |
| 18 | Temporary files | Tool plaintext work: `<root>/work/backup-*` (owner-only), removed on every path (tested). Operator temp: `TMPDIR`/`TEMP` (preflight warns unless inside the root) | **Yes** while present | High | No (volume) | Tool / operator | Removed by the tool | No | Root disposition |
| 19 | Process crash artifacts | None by default: Node writes no core dump or diagnostic report unless `--report-*` flags or OS core dumps are enabled | Could hold memory (credentials, report text) | High | — | OS | OS | No | Keep core dumps disabled on the engagement VM (MANUAL) |

### Data flow

```text
customer ──(evidence files: encrypted channel, D-05)──► reviewer
   │                                                    │ digests + references only
   │                                                    ▼
   │                               Host A (private, loopback/VPN, reviewer-only)
   │                                 └─ <root-A>/data/assurance.sqlite  (+ other stores, -wal/-shm)
   │                                        │ release (custody v2: approved bytes)
   │                                        ▼
   │                               GET …/package ──► <root-A>/exports/ ──► materialise ──► archive
   ◄──────────────────────── package (encrypted channel) + digest over a second channel ─┘
                                            │
         engagement-ops backup (cold) ──────┘──► sealed file (AES-256-GCM, key A) ──► off-host storage A
```

## 2. Storage and trust boundaries

- **Engagement root** (`<root>/`): `engagement.json`, `data/` (every store),
  `exports/`, `intake/`, `work/`, and the governed-action file. Everything an
  engagement writes on the Host machine belongs here, and offboarding destroys
  exactly this tree.
- **Host process boundary:** the only reader and writer of the stores. HTTP
  callers reach Assurance only with a reviewer credential (REL-01D,
  reviewer-only mode).
- **Outside the root and outside the tool:** off-host sealed backups, the
  backup key, the secret manager, log collection, the customer's copies, and
  hosting-provider snapshots.

## 3. Isolation strategy

| Property | Mechanism | Evidence |
| --- | --- | --- |
| No shared SQLite file | Preflight **E08**: every store variable must be exactly `<root>/data/<registry restore filename>` | ISO-01, ISO-05 (a shared store fails) |
| One organization per Host | Host (REL-01D) plus preflight **E02** (served org = engagement org) | ISO-05 |
| No report retrieval across customers | Separate Hosts and credential sets: A's credential is `401` on B; A's report is `404` on B; A's package is `RELEASE_NOT_IN_CUSTODY` on B | ISO-02 |
| No cross-customer evidence | SEC-01D attribution: A's evidence offered to B is `EVIDENCE_WRONG_TENANT` per reference | ISO-03 |
| No reused credentials | Preflight **E12** with a credential ledger: sha256 fingerprints (never values) of reviewer and organization keys; reuse across engagements, or sharing within one, fails | ISO-04 |
| No cross-customer restore | The sealed header names the engagement and organization (authenticated by GCM), and restore:v1 refuses another organization | BAK-04 |
| No system-context bypass | Reviewer-only mode (**E04**), authentication required (**E06**), loopback or private bind (**E07**) | ISO-05 |
| Framework recorded | **E05**: exactly `rn.sv@0.1.0` | ISO-05 |
| Separation of duties | **E11**: at least one reviewer and one approver, no dual-role credential | ISO-05 |

**What remains shared, and can undermine isolation if hosts are combined:**

- the OS account and machine, if two engagements run on one machine;
- the process temporary directory (**E15** warns unless it is inside the root);
- the Node installation and the repository build;
- the log collector;
- the operator's workstation, password manager and e-mail;
- the backup storage service;
- in the test fixture, also the authority signing key and the CTRL-02
  operator secrets.

Organization ids differing is **not** isolation: the boundary is separate
Hosts, store files and credentials. Physical or cryptographic isolation
between machines is a hosting decision this tool cannot verify.

## 4. Encryption model

| Data | Control | Verified by |
| --- | --- | --- |
| Engagement root (stores, sidecars, exports, intake, work) | **Platform full-volume encryption** (BitLocker, LUKS/dm-crypt, FileVault) of the engagement volume | Preflight **E13**: a read-only probe (`manage-bde -status`, `/sys` dm-crypt `CRYPT-` targets, `fdesetup status`). PASS only on detected encryption. NOT_ENCRYPTED fails. UNVERIFIED (network filesystems, WSL `9p`, probe denied) warns, or fails with `--require-encryption`. An operator attestation is recorded but never upgraded to PASS |
| Backups | **AES-256-GCM** sealed container (AUTH-04D1 `lib-sealed-backup.mjs`, `node:crypto`). The header is GCM additional data: readable, not alterable | ENC-02: wrong key, flipped ciphertext, altered header and truncation all refused |
| Credentials, keys | Secret manager; never in the repository, logs, packages or backups | ENC-03: a scan of logs, the export, the sealed file and the unsealed backup set finds no credential and no key |

**Observed on the development machine used for this mission:** C: reports
`BitLocker: Fully Decrypted; Protection Off`, and the WSL root is
`ext4` with no dm-crypt. Both are `NOT_ENCRYPTED`. The preflight would fail
a Founding Assessment Host there, which is the intended result. Nothing on
the machine was changed.

**Application-level encryption of the stores is not added.** Full-volume
encryption is the proven control. A custom page or field cipher would be new
cryptography and would not protect sidecars, exports or temporary files.

## 5. Key ownership

| Key | Owner | Stored | Rotation | Recovery | Destruction |
| --- | --- | --- | --- | --- | --- |
| Volume key | Hosting platform or custody admin | Platform KMS / TPM / recovery key in the secret manager | Platform procedure | Recovery key | Destroying the volume key is the effective erasure of the root |
| Engagement backup key (`authority-pilot-backup.mjs keygen`, reused) | Custody admin | Secret manager; key file only while in use, never beside the backups | New key per engagement; re-seal on rotation (new backup) | Secret manager | At disposition: cryptographic erasure of every sealed backup |
| Reviewer and organization credentials | Holder (one person each) / custody admin | Secret manager | Engagement end and on suspicion (restart) | Re-issue | Revoke |

## 6. Evidence intake

**Decision: references only. No evidence repository is built.**
`rn.sv@0.1.0` accepts `external_artifact_reference` and `control_attestation`.
The Host records references and digests and never the file. A conclusion is
verifiable after the file is gone, because the reference keeps the file's
`digest`: a retained or re-supplied copy can be checked against it. If neither
survives, the conclusion stands as recorded and the digest proves only that
some file was cited.

Procedure (MANUAL):

1. Prefer inspection in a customer-controlled session; copy nothing (D-05).
2. If a file must be received, receive it over the agreed encrypted channel
   into `<root>/intake/` only. Never execute, open macros in, or convert it.
   Customer-supplied filenames are not trusted: rename to an opaque id.
3. Compute `sha256` with a standard tool (`certutil -hashfile <f> SHA256`,
   `sha256sum`) and record it as the reference `digest`.
4. Put no personal data in `metadata`, `provenance` or rationale
   (`CUSTOMER_DATA_GOVERNANCE.md` §4).
5. Delete intake copies at the agreed time. Offboarding deletes whatever
   remains, and the inventory lists it (`evidence-intake`).

## 7. Backup strategy

`engagement-ops.mjs backup --root <root> --key-file <key> --output <file>`
(IMPLEMENTED):

1. Checks that the Host environment serves the engagement's organization.
2. Requires a key; there is no plaintext mode.
3. Refuses an output inside `<root>/data` or an existing file.
4. Runs **backup:v1 `--cold`**: the Online Backup API, integrity check,
   schema guard, coverage, organization binding. It refuses a running Host
   (non-empty WAL).
5. Requires complete coverage and the engagement organization, and refuses an
   Assurance Store holding another organization's rows.
6. Seals the set with AES-256-GCM. The authenticated header records the
   profile, engagement, organization, backup id, source commit, consistency,
   assessment count, and every release (`reportId`, custody version,
   `releaseDigest`, `recordDigest`).
7. Plaintext exists only in `<root>/work/backup-*` (owner-only) and is
   removed on every path.

Take one after every release, before every upgrade, and at handoff. The tool
does not schedule backups (no background automation).

## 8. Restore requirements

- `verify --archive …` (IMPLEMENTED) runs with the engagement Host's
  environment and the key. It checks the header against `engagement.json`
  before unsealing, and again after. It restores with restore:v1 into a
  throwaway target, then reads every release through the Assurance Store's own
  custody verification and compares it with the header. It verifies every
  completed assessment, then discards the target.
- `restore --archive …` (IMPLEMENTED) restores only into the same
  engagement's **empty** `data/` directory. It refuses another engagement or
  organization (by header and by restore:v1), any store variable pointing
  outside the root, and a non-empty data directory. There is no `--force`.
- After a restore, the Host boots on the restored stores. The original
  release verifies and exports **byte-identically** (BAK-03).
- **Digest consistency is not independent authenticity.** The sealed backup
  is authenticated with the engagement key. Whoever holds that key can produce
  a valid backup. Release custody keeps REL-01A's A10 limitation.

## 9. Retention states

Derived by `status`, never declared:

`ENGAGEMENT_CREATED → ASSESSMENT_ACTIVE → ASSESSMENT_COMPLETED → RELEASE_ISSUED → HANDOFF_COMPLETED → RETENTION_ACTIVE → RETENTION_EXPIRED`
(plus `UNDETERMINED_HOST_MAY_BE_RUNNING` while a WAL is non-empty).

- `record --event handoff-accepted --by <role-ref>`.
- `record --event retention-set --until YYYY-MM-DD --policy-reference <ref> --by <role-ref>`.
  The **policy reference is mandatory**. The proposed periods in
  `CUSTOMER_DATA_GOVERNANCE.md` §10 are **not** approved, and the tool
  enforces none of them by itself.
- Events append; none is edited. A name or email as `--by` is refused.

## 10. Offboarding

- `offboard --root <root>` (dry run, the default) deletes nothing. It produces
  the disposition plan:
  - **destroy:** every file under the root, with class, size and sha256;
  - **refusals:** symbolic links, another organization's rows, a non-empty
    WAL or journal (the store is then not even opened);
  - **manual** steps and what **survives**;
  - limitations, and a `planDigest`.
- `offboard --execute --approval <file> --confirm <engagement-id> --certificate <file>`
  (IMPLEMENTED, gated) deletes only when **all** of these hold:
  - no refusal;
  - the confirmation repeats the engagement id;
  - the approval (`frontera.assurance.disposition-approval.v1`) names this
    engagement, its organization and the **current** `planDigest`, so any
    change since approval refuses;
  - the approver is a role-style reference;
  - the basis is `retention_expired` (only in `RETENTION_EXPIRED`),
    `customer_request` or `contract_termination`;
  - the certificate is written outside the root and doesn't already exist;
  - every file is still a regular file with its planned digest.

  It then deletes those files and the root's directories, never anything
  outside the root. It writes a disposition certificate listing what was
  destroyed and the manual steps still outstanding.
- **Destroyed by the tool:** the engagement root (stores, sidecars, exports,
  intake, work, configuration).
- **MANUAL, recorded as outstanding in the certificate:**
  - destroy the backup key (cryptographic erasure of every sealed backup);
  - delete off-host backup copies;
  - revoke credentials;
  - destroy or re-image the Host volume and provider snapshots.
- **Survives:** the customer's delivered copies; business records required by
  an approved policy or by law, including the certificate; third-party copies
  outside our control.
- **Append-only custody is not weakened.** No `DELETE` was added to any
  table. Records are disposed of by destroying the whole store.
- **Limits:** a file-system deletion is not proof of physical erasure (SSD
  remapping, journals, snapshots). On an encrypted volume, destroying the
  volume key is the effective erasure, and that step is manual. Key
  destruction assumes no retained copy of the key and no plaintext snapshot.
- In this mission the executing path ran only on synthetic temporary
  engagements.

## 11. Incident handling

| Incident | First action |
| --- | --- |
| Engagement backup key exposed | Treat every backup sealed with it as plaintext. Rotate: new key, new backup, delete the old backups, destroy the old key |
| A credential reused across engagements (E12 FAIL) | Do not start the Host; issue new credentials; record them in the ledger |
| Preflight E13 NOT_ENCRYPTED on a running engagement | Stop the Host; move the root to an encrypted volume; treat the plaintext copy as an exposure |
| Cross-customer restore attempted | It is refused (BAK-04). Investigate who held the other engagement's archive |
| Data found outside the root (E15 temp, an export elsewhere) | Move it into the root or delete it; record it |

Then follow `docs/commercial/founding-assessment/OPERATOR_RUNBOOK.md` §16.

## 12. Operational roles

The custody administrator runs init, preflight, backup, verify, restore,
inventory and the offboarding plan. The founder (or delegate) signs the
disposition approval. The custody administrator and the approver of a release
are different people (`OPERATOR_ROLES.md`). Reviewers never hold the backup
key.

## 13. Adversarial tests

`src/enterprise/__tests__/assure-ops-02-secure-customer-data.test.ts`, 15
tests. Two synthetic customers run on two real production-posture Hosts
(SQLite, authentication required, reviewer-only, `rn.sv@0.1.0`, deployment
witness).

| ID | Covers | Result |
| --- | --- | --- |
| ISO-01 | Distinct roots, store files and organizations; preflight E01–E11, E13 PASS | PASS |
| ISO-02 | A's credential on B `401`; A's report and assessment on B `404`; A's package on B `RELEASE_NOT_IN_CUSTODY`, on A `RELEASE_MATCHES_AUTHORITY` | PASS |
| ISO-03 | A's evidence on B's assessment → `EVIDENCE_WRONG_TENANT`, nothing accepted | PASS |
| ISO-04 | Credential ledger: reuse across engagements and sharing within one fail; the ledger holds no secret | PASS |
| ISO-05 | Shared store, reviewer-only off, public bind, other framework, memory persistence, other organization, dual-role credential: each FAIL | PASS |
| ENC-01 | Detection parsing (BitLocker, FileVault); NOT_ENCRYPTED fails; UNVERIFIED fails when required; an attestation stays WARN; live probe reports | PASS |
| ENC-02 / BAK-05 | Wrong key, flipped ciphertext, altered header, truncation (an interrupted copy) refused; a missing or unreadable key writes nothing; no plaintext left in `work/` | PASS |
| ENC-03 | No credential or key in logs, the export, the sealed file or the unsealed backup set | PASS |
| BAK-01 / BAK-02 | Backup before release (no releases) and after (one v2 release); verify restores into a throwaway target and checks every release | PASS |
| BAK-03 | Restore refuses non-empty data; after a simulated loss, restore → Host boots → export byte-identical, same `packageDigest` | PASS |
| BAK-04 | A's backup into B refused with either key; A's archive with B's environment refused; B's stores untouched; a backup of a running Host (non-empty WAL) refused, nothing left | PASS |
| RET-01 | Lifecycle derived; retention needs a policy reference; names refused | PASS |
| RET-02 | Inventory by class; the dry-run plan lists exactly those paths, deletes nothing, is deterministic | PASS |
| RET-03 | No approval, wrong confirmation, another plan, another engagement, retention not expired, named approver, certificate inside the root, a file changed after approval, a non-empty WAL: each refused; nothing deleted; customer B untouched | PASS |
| RET-04 | An approved disposition of synthetic A removes exactly its root, writes the certificate (manual steps and limitations listed), leaves the key outside the root, and leaves B intact and serving | PASS |

**Mutation testing** (12 mutants of `engagement-ops.mjs`, one at a time,
restored): **12 killed, 0 survived**:

- engagement binding on unseal removed;
- approval accepted for any plan;
- the running-Host refusal removed;
- the credential-reuse check removed;
- the store-placement check removed;
- the retention-basis check removed;
- the certificate allowed inside the root;
- a backup allowed without a key;
- a restore allowed into a non-empty directory;
- unverified encryption passing when required;
- the plaintext work directory not removed;
- a Host environment of another organization accepted.

**Two defects found by these tests and fixed before commit:**

1. A read-only SQLite connection leaves `-wal`/`-shm` sidecars, which changed
   the inventory being planned. It now uses a `query_only` connection that
   SQLite cleans up.
2. The plan opened a store even when a non-empty WAL showed a running Host.
   It now never opens it.

## 14. Existing limitations

- **Volume encryption is detected, not enforced by the Host.** A Host started
  without the preflight is not stopped by anything. The preflight is a
  mandatory MANUAL step in the runbook.
- **Windows ACLs are not inspected** (E14 is WARN on Windows); POSIX mode is
  checked elsewhere.
- **Evidence files are outside the product.** Intake is procedural.
- **Lifecycle events are an operator-maintained file.** They are not signed.
- **The credential ledger is a local file.** It detects reuse only among the
  engagements recorded in it.
- **Not in backup:v1:** the engagement record and the governed-action file.
  The latter's digest is recorded.
- **Hosting-provider snapshots, log retention and core-dump settings** are
  outside the tool.
- **Some portability *test files*** (`tests/*.mjs`) still use
  `new URL().pathname` and fail under Windows Node only. CI on Linux runs
  them. The tooling itself is fixed.

## 15. Residual risks

| Risk | Status |
| --- | --- |
| A Host run on an unencrypted volume | Detected by the preflight (FAIL); not prevented by the Host |
| Backup key held with the backups | Procedural separation; the tool refuses no specific location |
| Key holder can forge a valid backup | Inherent to symmetric sealing; not independent authenticity |
| A10 issuer-controlled custody; B7 no signature | Unchanged |
| Physical erasure not proven | Documented; rely on volume-key destruction |
| Retention periods unapproved | Unchanged; the tool requires a policy reference and enforces no period itself |
| Static bearer credentials | Unchanged (REL-01D) |
