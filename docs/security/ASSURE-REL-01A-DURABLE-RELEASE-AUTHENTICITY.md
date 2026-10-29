# ASSURE-REL-01A — Durable Release Records, Approval Authenticity and Anti-Replay

**Scope:** `rn.sv@0.1.0` commercial report releases (ASSURE-REP-01).
**Revision R1 (pre-merge review):** a release now requires durable custody, so
the in-memory store refuses it (§6). Opening a SQLite file now reads before it
writes, and refuses a file without changing it (§13).
**Closes:** ASSURE-PILOT-01 finding F01, under authoritative verification only.
**Does not change:** the `commercialUse: restricted` policy, the frozen
`aoc.assurance-store.schema.v1` identifier, the delivered release record
format, any HTTP route or SDK method, or findings F02, F03 and F04.

Three statements of different strength must not be confused:

1. **A hash** shows that content matches a value.
2. **A custody record** shows that the Host kept an approval it bound to an
   authenticated identity. This is what REL-01A adds.
3. **A digital signature** with an appropriate chain of trust lets a third
   party check authenticity without asking the issuer. REL-01A does **not**
   provide this, and nothing in it claims to.

## 1. The vulnerability (F01)

Before this change, `releaseCommercialReport` built a `CommercialReportRelease`
with the approver, the approval time, the three report digests and a
`releaseDigest`, returned it, and kept nothing. Verification recomputed the
digests and found them consistent.

Anyone holding a package could therefore change `approvedBy` and recompute
every digest. The resulting package was exactly as self-consistent as the
original, so it passed verification even against a copy of the issuer's store,
which held no release. The same absence of custody allowed any number of
releases for the same content, with nothing kept to arbitrate between them.
ASSURE-PILOT-01 reproduced both behaviours and pinned them as tests.

## 2. Threat model

**Assets:**

- the approver's identity;
- the authorizing organization;
- the approved assessment;
- the content, Markdown and manifest digests;
- the framework id and version;
- the approval time;
- the release identity;
- the release state and history.

| Adversary | Attack | Outcome after REL-01A |
| --- | --- | --- |
| A1 customer | edits its copy of the package | Offline: detected unless every digest is recomputed. Against custody: always detected (R02, R10–R12) |
| A2 third party | changes the approver and recomputes the digests | Detected against custody (`RELEASE_MISMATCH`, `release.approvedBy`). **Offline: not detectable** (§11) |
| A3 | recomputes hashes after editing the JSON | Same as A2 (R03) |
| A4 | holds an organization API key without `assure.report-release` | Refused (`ASSURANCE_REVIEWER_UNAUTHORIZED`, R07) |
| A5 | authenticated reviewer of another tenant | Refused (`ASSURANCE_ASSESSMENT_NOT_FOUND`, R06) |
| A6 | operator releases the same content twice | The kept record is returned; nothing is written (R04) |
| A7 | operator reuses an earlier release record | The record names other digests or another report version, so it does not match custody for this package (R10–R12, R17) |
| A8 | edits dates, digests or identifiers | Mismatch against custody, field by field (R10–R12) |
| A9 | reads another organization's releases | Gets nothing: `null`, `ASSURANCE_ASSESSMENT_NOT_FOUND` or `RELEASE_NOT_IN_CUSTODY`, never the record (R16) |
| A10 | direct write access to the store | The append-only triggers refuse UPDATE and DELETE. A row edited around them is reported as corrupted. **A writer who rewrites a row and recomputes every digest is not detected** (§16) |

**Trust levels:**

| Level | Meaning | Provided by |
| --- | --- | --- |
| Package integrity | The files agree with each other | `verifyCommercialReport` and the independent verifier, offline |
| Store authenticity | The package matches the record the Host kept, read through an authorized context | `AssuranceService.verifyCommercialRelease` |
| Approver attribution | The approver is the identity the Host authenticated when it released | The release path: credential principal, recorded in custody |
| External cryptographic authenticity | Checkable without asking the issuer | **Not provided** (`EXTERNAL_SIGNATURE_NOT_AVAILABLE`) |

An issuer-administered store gives **no non-repudiation independent of the
issuer**. Whoever administers the store administers the record.

## 3. Architecture decision

**Selected: extend the Assurance Store (option A).**

The store already provides what custody needs:

- tenant scoping (`canAccessAssuranceOrganization`);
- IMMEDIATE transactions with typed, driver-free failures (SEC-01E);
- WAL with `synchronous = FULL`;
- the portability backup (`safeSqliteCopy`);
- the same file the assessment lives in, so a release is checked against its
  assessment inside one transaction.

**Discarded:**

- **A dedicated release ledger (option B).** It would be a second persistence
  system with its own backup, migration and tenancy, and would give no
  guarantee the Assurance Store lacks.
- **A signed release manifest (option C).** Frontera has signing primitives:
  CORE-01 Ed25519 grant signatures and the FV-P4B signed status verifier. None
  is provisioned for Assurance, and introducing an issuer key needs custody,
  rotation, revocation, public-key distribution, algorithm versioning,
  recovery, authorization, backup and a trust model. That is a future step
  (§16). An HMAC would be a shared secret, not a publicly checkable signature,
  and was not considered.

**Schema identifier unchanged.** The custody table is added at open time, as
the Governance Store added its reference-integrity columns
(`AOC_ENTERPRISE_GOVERNANCE_STORE.md`). Bumping the frozen identifier would
make every runtime refuse every existing database. Each row carries its own
`custody_version` (`aoc.assurance.commercial-release-custody.v1`).

## 4. The authoritative source

The authority is **the Assurance Store the Host composed at startup**, reached
through `AssuranceService` with an authorized context:

- `getCommercialRelease(context, reportId)`;
- `listCommercialReleases(context, assessmentId)`;
- `verifyCommercialRelease(context, package)`.

The package supplies only a lookup key (`manifest.reportId`). The record it is
compared with always comes from the Host's own store. A caller cannot supply
both a forged package and its own "authoritative" record.

A **store file handed over** is comparison material. One example is the
independent verifier's `--store-copy` option. Whoever forged a package could
forge the copy too, so the verifier reports such a match as
`UNAUTHENTICATED_COPY` and never as authenticity. A copy obtained from the
issuer over an independent, trusted channel is only as good as that channel.

## 5. The approver's identity

The release path takes the approver from the authenticated
`AssuranceReviewerPrincipal` (ASSURE-SEC-01B), and never from the request:

- an `approvedBy` or `organizationId` in the request body is ignored (R01);
- the principal must hold `assure.report-release` at the time of release;
- the organization is the approver's, and the assessment must be visible
  within it.

`approvalAuthentication: 'assurance_reviewer_credential'` records how the
approver was authenticated.

## 6. The durable contract

```text
CommercialReleaseCustodyRecord (src/enterprise/assurance/commercial-release-custody.ts)
  custodyVersion   'aoc.assurance.commercial-release-custody.v1'
  reportId         release identity = report version: rn-sv-report:<assessmentId>:v<reportVersion>
  organizationId   from the stored assessment, through the approver's scope (kept out of the package)
  assessmentId
  manifest         CommercialReportManifest, as delivered (framework id, version and digest; assessment digest; content and Markdown digests)
  release          CommercialReportRelease, exactly as returned and delivered (reused unchanged)
  recordDigest     sha256 over the canonical JSON of every other field
```

The delivered release record is **unchanged**, so the REP-01 golden example and
`releaseDigest` are unaffected. The release identity is the existing
`reportId`, so no field was added to the package.

**SQLite table `assurance_commercial_releases`:**

- the primary key is `report_id`;
- a foreign key links `assessment_id` to `assurance_assessments`;
- columns: `organization_id`, framework id and version, `content_digest`,
  `release_digest`, `approved_by`, `approved_at`, `custody_version`,
  `record_json` and `record_digest`;
- there is an index on `assessment_id`;
- `BEFORE UPDATE` and `BEFORE DELETE` triggers refuse any change (append-only).

**Reads re-check everything.** The JSON must agree with its columns, both
digests must recompute, and the manifest and release record must bind each
other. Otherwise the read fails with `ASSURANCE_INTEGRITY_FAILED`, and the
record is never returned as custody.

**`AssuranceStore` gains three optional methods:**

- `commitCommercialRelease`;
- `getCommercialRelease`;
- `listCommercialReleases`.

They are optional so that existing implementations still compile. **The service
refuses to release or verify with a store that lacks them**
(`ASSURANCE_STORE_UNAVAILABLE`). A release is never returned unkept.

**A release requires durable custody (R1).** Custody that disappears on a
restart cannot back a commercial approval: a "kept" release that is gone
tomorrow can no longer be checked against, and the same report version could
then be released again. The service therefore releases only into **a SQLite
Assurance Store created by `createSqliteAssuranceStore`**. The factory
registers each store it returns in a module-private `WeakSet`, and
`providesDurableReleaseCustody(store)` checks membership. Any other store is
refused with `ASSURANCE_STORE_UNAVAILABLE` after the approver's
authentication, role and organization checks, and before a draft is rebuilt or
an approval built. Nothing is written, logged as a success, or published.
This covers the in-memory store, an embedder's own store, and an object that
copies a SQLite store's `providerKind` and methods.

A string cannot forge durability; only the factory's own instance qualifies.
What membership does **not** vouch for: the durability of the disk, or a
database file written around the store (§16).

On the in-memory store, these still work:

- drafting, completing assessments and every other operation;
- `verifyCommercialRelease`, which checks integrity and, with nothing in its
  custody, answers `RELEASE_NOT_IN_CUSTODY`;
- `getCommercialRelease` and `listCommercialReleases`.

Tests that release run on temporary SQLite files. No test-only bypass exists.

## 7. Atomicity

`releaseCommercialReport` runs these steps in order:

1. authenticates the approver and checks the release role and the
   organization;
2. refuses unless the store provides durable custody (§6);
3. rebuilds the draft from the store, checks every release gate, the exact
   content digest and both acknowledgements;
4. looks up custody for the `reportId`; if a release is kept, answers from it
   (§8);
5. checks the approval date, builds the release record and the custody record;
6. **commits** it in one SQLite IMMEDIATE transaction. The transaction checks
   that the assessment exists in the record's organization and is `completed`
   (not superseded), then either inserts or finds an existing row. The primary
   key backs this up;
7. logs `assurance.commercial_report.released` (`status: committed`) and
   returns, **only after the commit**.

If the write fails, the store raises `ASSURANCE_STORE_UNAVAILABLE` with
`retryable: true` and no SQL or path. No row is left behind, no success is
logged, and a retry commits exactly once (R13).

No enterprise event was added: the store is canonical, so there is no second
write to fail after the commit, and the SEC-01E double-write risk is not
recreated.

## 8. Idempotency and anti-replay

The release identity, and the idempotency key, is the `reportId`. The service
derives it from the assessment and the report version, never from the caller,
so no caller-supplied key can be reused against someone else's release.

| Case | Behaviour |
| --- | --- |
| 1. First valid release | One write, one record; `custody.outcome: 'committed'` |
| 2. Identical retry after a lost response | The kept record is returned, with its original `approvedAt` and `releaseDigest`; `custody.outcome: 'replayed'`. This holds even after the issue date and across a restart (R04) |
| 3. Same content, another approver | Refused: `ASSURANCE_ASSESSMENT_IMMUTABLE`, `reason: 'commercial_release_conflict'`, `conflict: 'approver'`. The first approver is never replaced |
| 4. Same version, other content (e.g. after a finding event) | The old approval no longer matches the draft (`ASSURANCE_INTEGRITY_FAILED`). Approving the new content under the released version is refused with `conflict: 'content'`. A new `reportVersion` is a new, explicit release, and the earlier one is untouched (R17/R23) |
| 5. Key reused for other content | Same as case 4 |
| 6. Concurrent requests | At most one commit. The IMMEDIATE transaction takes the write lock before reading, and the primary key backs it up. Proven with two connections to one file (R05) |
| 7. Host restart | Custody and uniqueness are in the database file (R14) |
| 8. Backup and restore | The portability tooling's `safeSqliteCopy` carries the table, its rows and its triggers. A restored store replays and refuses as before (R15) |

The conflict uses the existing 409 code `ASSURANCE_ASSESSMENT_IMMUTABLE`, so no
new public error code was added. A released report version is immutable.

## 9. Organizational isolation

- Custody reads require a tenant scope.
- A record of another organization is invisible: `getCommercialRelease`
  returns `null`, and `verifyCommercialRelease` answers
  `RELEASE_NOT_IN_CUSTODY` with no custody details.
- `listCommercialReleases` first requires the assessment to be visible.
- A commit is refused unless the stored assessment belongs to the record's
  organization (R16).

## 10. Authoritative verification

`verifyCommercialRelease(context, { content, markdown, manifest, release })`
reports two dimensions separately.

**Integrity** (`INTEGRITY_VALID` / `INTEGRITY_INVALID`) is the package's own
digests.

**Authority:**

| Status | Meaning |
| --- | --- |
| `RELEASE_MATCHES_AUTHORITY` | The delivered release record and manifest equal the kept ones, field by field |
| `RELEASE_MISMATCH` | They differ. `mismatchedFields` names each field, e.g. `release.approvedBy` |
| `RELEASE_NOT_IN_CUSTODY` | No release is kept for this report version in the caller's scope. The release is not corroborated |
| `AUTHORITY_UNAVAILABLE` | Custody could not be consulted (store closed or failing, custody unsupported, or a corrupted record). `authorityFailure` gives the code |

`releaseAuthenticated` is true only when integrity is valid **and** the release
matches the authority. A match also reports:

- `custody`: the approver, role, time and release digest as kept;
- `approverCurrentlyAuthorized`: whether that approver still holds the role
  today (§15).

`externalSignature` is always `EXTERNAL_SIGNATURE_NOT_AVAILABLE`. Failed
verifications are logged with ids and statuses only.

## 11. Limits of offline verification

The independent verifier (`scripts/assurance/verify-commercial-package.mjs`)
still proves only integrity and consistency offline. A package whose approver
was changed and whose digests were all recomputed **still passes offline**.
That is F01's remaining, offline half, and it is pinned by the PILOT-01 test.

With `--store-copy`, the verifier also compares the package with the release
kept in the copy and fails on any difference. It labels the copy
`UNAUTHENTICATED_COPY`, and external authenticity stays `NOT_DEMONSTRATED`. A
customer without access to the Host establishes authenticity only by asking
the issuer to verify, or by comparing digests over an independent channel.

## 12. Backup and restore

The table lives in `assurance.sqlite`, which the v1 portability backup already
copies with SQLite's online backup API. No registry change was needed: the
store's schema identifier is unchanged, and `tableCounts` lists the new table
automatically. R15 runs the tooling's own `safeSqliteCopy`,
`sqliteIntegrityCheck` and `tableCounts`, reopens the copy, and checks custody,
replay, conflict and the append-only triggers.

**A restore to an older backup loses the releases made after it.** Those
releases then read as `RELEASE_NOT_IN_CUSTODY`, never as forged, and the same
report versions could be released again. Treat the backup schedule as part of
release custody.

## 13. Migration

**Opening reads before it writes (R1).** Before R1, opening switched the file
to WAL, which rewrites its header, before checking anything. It also ran the
DDL whenever the version ledger was missing or empty, initialized in separate
statements, and accepted an existing custody table of any shape. The opening
order is now:

1. Open the connection and apply connection-only settings (`foreign_keys`,
   `busy_timeout`). Neither writes the file.
2. **Preflight, read-only**, which refuses the file **without changing it**
   (`ASSURANCE_STORE_UNAVAILABLE`, "nothing was changed", with no driver
   detail or path) when:
   - it is not a readable SQLite database;
   - it holds objects but no `assurance_store_versions` ledger (another
     application's database, or a non-Assurance file);
   - the ledger is unreadable;
   - the newest ledger row names another schema version;
   - a custody table exists with other columns, types, nullability or primary
     key;
   - a custody table lacks its index or either trigger (partially created);
   - custody objects exist without their table.

   An unexpected object is refused. It is never repaired or dropped. An empty
   file is fresh. A ledger without rows is an initialization interrupted
   before it recorded its version, and is completed in step 4.
3. Only then switch to WAL and set `synchronous = FULL`.
4. **Initialize in one IMMEDIATE transaction**: the v1 DDL, the custody DDL,
   and the version row if none exists. The ledger is re-read under the write
   lock, so concurrent first opens record a single row. Any failure rolls the
   whole initialization back ("no part of the initialization was kept"). The
   file can be opened again once the cause is gone.

**Proven by test, comparing before/after snapshots** of `sqlite_master`
(every object and its SQL), every table's rows, `user_version` and the
journal mode:

- a fresh file initializes in WAL mode with one version row;
- a v1 database with custody reopens unchanged;
- a pre-REL-01A v1 database gains exactly the custody objects, and nothing else
  changes;
- an unsupported version is refused unchanged (no table, index or trigger, no
  WAL switch, `user_version` kept), both with and without an existing custody
  table, whose release stays intact;
- an unreadable ledger, a foreign database and a non-database file are
  refused unchanged (the non-database file's bytes are hashed);
- a custody table of another structure, and one missing a trigger, are
  refused unchanged;
- a failure injected at the version-row insert, after the custody objects were
  created inside the transaction, leaves no custody table and no version row;
  once the cause is removed, the same file opens and is completed with its
  history intact.

**Limits.**

- The v1 base tables are created with `IF NOT EXISTS` and are not validated
  column by column: only the custody objects are.
- Reading a refused file that is already in WAL mode can create its `-shm`
  sidecar, as any reader would. The database file, its schema and its rows are
  not changed.

| Runtime | Database | Behaviour |
| --- | --- | --- |
| REL-01A | pre-REL-01A | Opens; table added; nothing else changes |
| pre-REL-01A | post-REL-01A | Opens; never reads the table. **It releases without custody, as it always did. Do not run an older runtime against a production store** |
| REL-01A | unsupported version, unreadable ledger, foreign database, incompatible custody objects | Refused, untouched (R1) |

No production migration was run as part of this change.

## 14. Historical releases

Releases made before REL-01A were never kept. They are **not fabricated
retroactively**, and no identity is assigned to them. Verifying one answers
`RELEASE_NOT_IN_CUSTODY`: not corroborated, not shown to be forged. Its digests
are left unchanged. To bring one under custody, release it again as a new
report version, by an approver who reviews it now.

## 15. Revocation

A release records the approver the Host authenticated **at that moment**. A
later revocation (the credential removed from `assuranceReviewers`) does not
rewrite it. Verification still answers `RELEASE_MATCHES_AUTHORITY` with the
original approver, and reports `approverCurrentlyAuthorized: false`
separately. The revoked credential authenticates no one, and so releases
nothing further (R18). Whether a revoked approver's earlier releases remain
acceptable is Host policy, decided by whoever reads both fields.

## 16. Residual risks

| Risk | Consequence |
| --- | --- |
| **No external signature** | Authenticity requires asking the issuer. A customer holding only the package cannot tell a resealed forgery from the original |
| **Issuer-controlled custody (A10)** | Someone who can write the store and recompute every digest can rewrite a release undetected (pinned as `A10 KNOWN LIMITATION`). Custody is the issuer's own record, not non-repudiation |
| **Downgrade** | An older runtime ignores custody and releases without it |
| **Restore to an older backup** | Loses later releases; they become uncorroborated and re-releasable |
| **Durability is the factory instance, not the disk** | `providesDurableReleaseCustody` recognizes the store this module created. It cannot vouch for the storage under it, nor for a database file written around the store (A10) |
| **No operational interface (F04)** | Release and verification are reachable only in-process; nothing is exposed to customers |
| **F02 contradiction deadlock, F03 Markdown "not yet released" banner** | Unchanged |
| **`commercialUse: restricted`** | Unchanged. A release still acknowledges it, and nothing here authorizes commercial use |

**Mutation testing.** Twenty non-equivalent mutants were applied to the
compiled code. Each was killed by the REL-01A suite:

- omitting the write;
- skipping uniqueness in the store transaction;
- skipping uniqueness in the service lookup;
- ignoring the tenant on a store read;
- ignoring the tenant in verification;
- taking `approvedBy` from the body;
- accepting self-contained digests as authenticity;
- skipping the comparison with the store;
- releasing without the role;
- ignoring a persistence failure;
- allowing a conflicting approver;
- allowing conflicting content;
- releasing an incomplete assessment;
- dropping the assessment binding;
- (R1) dropping the durable-custody gate;
- (R1) trusting a `providerKind` string for durability;
- (R1) skipping the read-only preflight;
- (R1) switching to WAL before the preflight;
- (R1) initializing outside a transaction;
- (R1) accepting a custody table of another structure.

Each R1 mutant was killed by the specific test for its case.

One mutant is equivalent and not counted: removing only the primary key, while
the in-transaction check holds the write lock.

Removing only the in-transaction check is **not** equivalent. The primary key
turns the race into a store failure instead of returning the kept release, and
R05 detects it.

## 17. Operation

- **Release:** `releaseCommercialReport` as before. Read `custody.outcome`: a
  `replayed` answer is the original approval, not a new one. A Host that
  releases must run `persistence.provider = sqlite`. On the in-memory provider,
  every release is refused (§6).
- **Reissue:** increment `reportVersion`. Never expect a released version to
  accept another approval.
- **Verify a received package:** call `verifyCommercialRelease` with an
  organization context. Treat only `releaseAuthenticated: true` as authentic,
  and read `approverCurrentlyAuthorized` separately.
- **Audit:** use `listCommercialReleases(context, assessmentId)`.
- **Store file analysis:** use `verify-commercial-package.mjs --store-copy`.
  The result is comparison only.

## 18. Failure response

| Observation | Response |
| --- | --- |
| `ASSURANCE_STORE_UNAVAILABLE` on release | Nothing was released. A persistence failure (`retryable: true`) can be retried: the retry commits once or replays. A store without durable custody never releases: configure the SQLite provider |
| `ASSURANCE_STORE_UNAVAILABLE` on open, "nothing was changed" | The file was refused untouched: another schema version, not an Assurance Store, unreadable, or custody objects this runtime does not recognize. Do not repair it by hand; restore or migrate it deliberately |
| `ASSURANCE_ASSESSMENT_IMMUTABLE`, `commercial_release_conflict` | A release is already kept for that version. Read it with `getCommercialRelease`; issue a new version if a new approval is intended |
| `RELEASE_MISMATCH` for a circulating package | Treat it as forged or altered. Compare `mismatchedFields` with the kept record; deliver the kept version again |
| `RELEASE_NOT_IN_CUSTODY` | Not corroborated. It is either a pre-REL-01A release, a release lost to a restore, or a forgery under an unknown version |
| `AUTHORITY_UNAVAILABLE` with `ASSURANCE_INTEGRITY_FAILED` | A custody row was changed outside the store. Stop releasing from that store; restore from backup and investigate who wrote it |
| `approverCurrentlyAuthorized: false` | The approval stands as recorded. Decide under Host policy whether to reissue |
