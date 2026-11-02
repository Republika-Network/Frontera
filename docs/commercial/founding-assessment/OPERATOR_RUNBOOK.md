# Founding Assessment — Operator Runbook

> **STATUS: DRAFT (ASSURE-REL-01E). Not an authorization to operate on
> customer data.** Until the launch gate is GO, run every step with
> **synthetic data only**.
>
> Tags: **[IMPL]** an implemented command, route or SDK method on baseline
> `5012246c`, with its source · **[PROC]** a manual step, no code behind it ·
> **[PLANNED]** does not exist; a backlog item.
>
> Routes are relative to the Host. `R` = reviewer credential with
> `assure.reviewer`; `A` = with `assure.report-release`. The credential is sent
> as the bearer `apiKey` (SEC-01B). SDK methods are on the Enterprise Host SDK
> client (`packages/enterprise-host-sdk/src/client.ts`). The authorization
> matrix is REL-01D §3.

## 1. Private Host preflight

1. [PROC] Provision a dedicated machine or VM for **one customer**, on an
   encrypted volume, reachable only on loopback (operators use an SSH tunnel)
   or a private network with TLS terminated in front (REL-01D §9).
2. [IMPL] `npm ci && npm run build`.
3. [PROC] Set the environment from `OPERATOR_ROLES.md` §1. Point
   `AOC_ENTERPRISE_ASSURANCE_SQLITE_PATH` at the encrypted volume.
4. [IMPL] `npm run check:host-configuration`. It runs the launcher's preflight
   without binding, writing a store or contacting a signer. Exit 0 required.
   Its output names checks and variables, never values.
5. [IMPL] `npm run start:enterprise`.
6. [PROC] Confirm from a second machine that the Host port is **not**
   reachable from outside the private network.

## 2. Credential provisioning and safe storage

1. [PROC] Founder approves the issuance (`OPERATOR_ROLES.md` §4). Record it in
   the credential register.
2. [PROC] Generate a high-entropy secret per person. Place it only in the
   environment variable named by `apiKeyEnv`, through the platform's secret
   mechanism, and in the holder's approved password manager.
3. [IMPL] Add `{ reviewerId, roles, apiKeyEnv }` to `assuranceReviewers` in the
   governed-action file (`AOC_ENTERPRISE_GOVERNED_ACTIONS_FILE`). Inline
   secrets are refused. Duplicate secrets refuse boot.
4. [IMPL] `reviewerId` must be a safe public reference: lower-case ASCII
   letters and digits joined by single `.`, `_` or `-`, ≤ 64 characters, no
   ≥ 7-digit run, not `withheld-reviewer-…`, unique. The Host refuses to boot
   otherwise (ASSURE-OPS-01, R-04). [PROC] Use a role-style reference such as
   `rn-reviewer-01`, never a name: the Host cannot detect a well-formed name.
5. [IMPL] Restart the Host. Rotation and revocation are the same procedure:
   edit, then restart. A revoked credential authenticates no one.

## 3. Framework registration

1. [IMPL] `AOC_ENTERPRISE_ASSURANCE_FRAMEWORKS=rn.sv@0.1.0` registers the exact
   frozen framework at boot. Any other value refuses boot.
2. [PROC] Record the framework digest that the assessment binds. It must
   equal the golden digest
   `sha256:e71fafe1a10af95514823e35d43138b1b93cdb72e37765200447a37748c13a58`.

## 4. Reviewer-only mode

1. [IMPL] `AOC_ENTERPRISE_ASSURANCE_REVIEWER_ONLY=true`.
2. [PROC] Smoke test with synthetic data: a write with the organization API
   key must be refused (`401`). Tested in `assure-rel-01d-operator-interface.test.ts` O13.

## 5. Creating an assessment

1. [PROC] Preconditions: signed SOW (draft B) and authorization to assess
   (draft E) are on file.
2. [IMPL] `POST /api/assurance/assessments` (R) · SDK `createAssessment`. The
   actor is the credential. `requestedBy` may be omitted or must equal it.
3. [IMPL] `GET /api/assurance/assessments/{id}` to confirm the framework id,
   version and status.

## 6. Collecting evidence (synthetic or customer-approved only)

1. [PROC] Accept only evidence that meets draft C, from the named customer
   contact, after draft E is signed. Keep the artifacts in the location
   decided under D-05 (none is defined yet).
2. [PROC] Compute each artifact's digest. Write `metadata`, `provenance` and
   `externalId` **without personal data** or customer-confidential terms.
3. [IMPL] `POST /api/assurance/assessments/{id}/evidence` (R) · SDK
   `submitAssessmentEvidence`. Each reference names its `requirementIds`
   (`rn.sv.req.sv-01` … `sv-10`). At most 500 per submission. JSON only.
   1 MiB bound.
4. [IMPL] Read the per-reference outcome. `EVIDENCE_NOT_BOUND`,
   `EVIDENCE_WRONG_TENANT` and `EVIDENCE_METRIC_NOT_PERMITTED` are rejections,
   not errors to work around.
5. [PROC] The submitter is attributed only in the `enterprise.assurance.operator`
   log line. Note the submission in the engagement record.

## 7. Reviewing evidence

1. [IMPL] `POST /api/assurance/manual-reviews` (R; the control's required role
   is `assure.reviewer`) · SDK `recordManualReview`. Outcome `pass`, `partial`,
   `fail` or `insufficient_evidence`. A definitive outcome must cite accepted
   evidence bound to the control (SEC-01A).
2. [PROC] Rationale: factual, no personal data, no secrets. It is stored but
   never disclosed in the report.
3. [PROC] Use `insufficient_evidence` whenever a defensible conclusion is not
   possible. Never record `fail` for missing evidence.

## 8. Handling contradictory evidence

Follow REL-01B §15 exactly:

1. [IMPL] Confirm the attempt is in `manual_review` with
   `CONTROL_EVIDENCE_CONTRADICTORY` on the control.
2. [PROC] **Do not record reviews to "close" it.** The service refuses
   pass/partial over an unresolved contradiction.
3. [IMPL] `POST /api/assurance/assessments/{id}/terminate` (R) · SDK
   `terminateAssessment` with `{ reasonCode: 'unresolved_contradiction', rationale }`.
   `terminatedBy` is not accepted.
4. [PROC] Ask the customer for one authoritative artifact with its own identity.
5. [IMPL] `POST /api/assurance/subjects/{subjectId}/reassess` (R) with
   `{ assessmentId: <ended>, reason }`. Then repeat §6–§9 on the new attempt.
6. [PROC] Report only on the completed new attempt. The ended attempt is part
   of the engagement record, never of the report.

## 9. Evaluating and completing

1. [IMPL] `POST /api/assurance/assessments/{id}/evaluate` (R) · SDK
   `evaluateAssessment(id, { complete: true })`. Completion is refused while
   any review is pending.
2. [IMPL] On `409 ASSURANCE_ASSESSMENT_CONFLICT` (`concurrent_modification`),
   re-read and retry. Nothing was written.
3. [IMPL] `POST /api/assurance/assessments/{id}/verify` (R or A).
4. [IMPL] **No reviews after completion.** A review of a completed, failed or
   superseded assessment is refused (`409 ASSURANCE_ASSESSMENT_IMMUTABLE`,
   `reason: terminal_assessment`) and nothing is recorded (ASSURE-OPS-01, R-02).

## 10. Draft inspection

1. [IMPL] `POST /api/assurance/assessments/{id}/commercial-report/draft` (R or
   A) · SDK `draftCommercialReport`.
2. [PROC] Readiness must be `READY_FOR_RELEASE`. Read the whole report:
   scope, exclusions and limitations against the SOW. Check declared text for
   customer-confidential terms (the classifier cannot see those).
3. [PROC] Record the `contentDigest` you reviewed.

## 11. Independent approval

1. [PROC] The approver is a **different person** from every reviewer, holding
   only an `A` credential, and signs the pre-release attestation
   (`OPERATOR_ROLES.md` §4).
2. [PROC] The approver independently reads the draft and the SOW. Both
   acknowledgements (`limitationsReviewed`, `commercialUseRestrictionAcknowledged`)
   mean what they say. The second acknowledges `commercialUse: restricted`.

## 12. Durable release

1. [IMPL] `POST /api/assurance/assessments/{id}/commercial-report/release` (A)
   · SDK `releaseCommercialReport`, with the exact `contentDigest`.
2. [IMPL] Expect `201`, `custody.outcome: committed`. `200 replayed` means it
   was already released by you. `409 commercial_release_conflict` means a
   release is already kept for that version. `409 approved_digest_stale` means
   draft again. `403 separation_of_duties` means the approver reviewed the
   assessment: stop and re-staff. Full table: REL-01D §4, REL-01A §18.
3. [PROC] **Immediately** take a cold backup (§15).

## 13. Customer package export

1. [IMPL] `GET /api/assurance/commercial-releases/{reportId}` (R or A) ·
   SDK `getCommercialRelease`. `GET …/{id}/commercial-releases` lists them.
2. [IMPL] Export the package from custody (ASSURE-OPS-01, R-05):
   `GET /api/assurance/commercial-releases/{reportId}/package` (R or A) · SDK
   `exportCommercialReleasePackage`. Save the JSON body as `export.json`. It
   contains the full report, so treat it as customer-confidential. The Host
   verifies the bytes against custody before answering. `409
   ASSURANCE_RELEASE_NOT_EXPORTABLE` (`artifacts_not_in_custody`) means a
   release kept before this feature: re-deliver the original package.
   `500 ASSURANCE_INTEGRITY_FAILED` means stop and escalate (§16).
3. [IMPL] `node scripts/assurance/materialize-commercial-package.mjs export.json --out <empty-dir>`
   writes the six files byte-exact, from the closed file set only. Then delete
   `export.json`. On Windows, never let `core.autocrlf` or an editor touch
   `report.md`. Archive the directory.
4. [IMPL] Before sending, run the offline verifier:
   `node scripts/assurance/verify-commercial-package.mjs <package-dir>`
   (add `--renderer dist/src/enterprise/assurance/commercial-report-markdown.js`
   for a re-render check). Required verdict: PASS on files, integrity and
   consistency. External authenticity always reads `NOT DEMONSTRATED`.
5. [PROC] Deliver per draft H.

## 14. Authoritative verification

1. [IMPL] `POST /api/assurance/commercial-releases/verify` (R or A) · SDK
   `verifyCommercialRelease`, with the package as received back from the
   customer. Always `200`.
2. [PROC] Answer the customer in writing. Only `RELEASE_MATCHES_AUTHORITY`
   with `releaseAuthenticated: true` is authentic. Report
   `approverCurrentlyAuthorized` separately. `RELEASE_MISMATCH` means forged
   or altered: escalate (§16).
3. [IMPL] For forensics only: `verify-commercial-package.mjs --store-copy <copy>`.
   The copy is comparison material (`UNAUTHENTICATED_COPY`), never the
   authority.

## 15. Backup and recovery

1. [IMPL] `npm run backup:v1 -- --output <dir> --cold`, with the Host stopped,
   after every release and before any upgrade (`AOC_ENTERPRISE_BACKUP_V1.md`).
   The Assurance Store is `stores/assurance.sqlite`.
2. [PROC] Encrypt the backup (the tool does not). Store it off-Host. Record it.
3. [IMPL] `npm run restore:v1 -- --backup <dir> --target <dir>`, with the
   restoring deployment's environment (`AOC_ENTERPRISE_RESTORE_V1.md`).
4. [PROC] After a restore, list releases and compare them against the
   engagement record. Releases made after the backup are **lost**, read
   `RELEASE_NOT_IN_CUSTODY`, and could be released again. Treat that as an
   incident (§16).
5. [PROC] A restore drill with synthetic data before the first engagement.

## 16. Incident escalation

| Trigger | First action |
| --- | --- |
| Secret exposed or suspected | Revoke (§2.5); rotate all secrets on the Host; review the operator log |
| Disallowed data received (secrets, special-category data …) | Do not submit it; delete it; notify the customer; record it |
| `AUTHORITY_UNAVAILABLE` with `ASSURANCE_INTEGRITY_FAILED` | Stop releasing from that store; preserve it; restore; investigate (REL-01A §18) |
| `RELEASE_MISMATCH` for a circulating package | Treat it as forged; re-deliver the kept version; notify the customer |
| Host reachable from outside the private network | Stop the Host; rotate secrets; review logs |

[PROC] Escalate to the founder and security lead within the agreed time.
Customer and regulator notifications follow `CUSTOMER_DATA_GOVERNANCE.md` §12
(legal review pending). Generic triage: `docs/pilot/INCIDENT_TRIAGE.md`.

## 17. Customer offboarding

1. [PROC] Confirm acceptance (draft F) and any open verification requests.
2. [PROC] Delete Republika-held artifact copies at the agreed time
   (proposed: 30 days after acceptance).
3. [PROC] Revoke and rotate every credential on the Host.
4. [PROC] At the end of retention: destroy the store file and **every**
   backup. No per-customer delete exists in the store (`assurance-store.ts`).
   Destroy the Host. Issue the deletion certificate (draft I).
5. [PROC] Tell the customer that, after destruction, authoritative
   verification is no longer available.

## Implemented vs planned — summary

| Step | Status |
| --- | --- |
| Preflight, start, configuration check | IMPL |
| Credentials, reviewer-only mode, framework opt-in | IMPL (issuance, register and storage are PROC) |
| Create, evidence, review, terminate, reassess, evaluate, verify | IMPL |
| Draft, release into custody, list, get, verify a release | IMPL |
| Package export for a real assessment | IMPL (ASSURE-OPS-01): export route, SDK method, materialiser CLI |
| Offline package verifier | IMPL |
| Backup, restore | IMPL (encryption PROC) |
| Customer offboarding and deletion | PROC (no purge tool) |
| Refusing reviews after completion | IMPL (ASSURE-OPS-01) |
| Reviewer-ID format validation | IMPL (ASSURE-OPS-01); names in well-formed tokens: PROC |
| Signed releases | **PLANNED (R-01)** |
