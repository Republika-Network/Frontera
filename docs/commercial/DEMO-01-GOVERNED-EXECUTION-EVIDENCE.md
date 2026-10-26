# DEMO-01A — Governed Execution Evidence: Signed Reference Evidence Capture

- Status: **Reference only. Synthetic. Test-only.**
- Bundle format: `frontera.demo-evidence-bundle.v1`
- Capture suite: `src/enterprise/__tests__/demo01-evidence-capture.test.ts`
- Bundle schema, verifier and scan: `src/enterprise/__tests__/demo01-evidence-bundle.ts`
- CI job: `demo-evidence` in `.github/workflows/ci.yml`
- Consumer: DEMO-01B (a static page in `frontera-web`, separate repository, separate PR)

## 1. What this is

The buyer story is **an AI DevOps agent asks to deploy `release-42` to production**.
DEMO-01A records one run of the Frontera reference implementation for three
scenarios and writes what the run produced to one JSON file. A public demo page
can show that file and re-check its signatures.

The run uses the G-02C1D path end to end:

- the canonical shipped Host (`bootEnterpriseHost()`, production profile, SQLite, signed grants, CORE-07 witness, software custody);
- the reference executor in its own process (independent verification, durable single-use consumption, one synthetic effect, a signed receipt);
- a byte relay in front of the executor.

No second simulation exists: every fact in the bundle is read from the run.
Nothing in this milestone changes production source. The protocol artifacts in
the bundle are unchanged and are copied verbatim:

- the G-02A capability, as its canonical text and CORE-02 signature;
- the G-02C1C receipt, as its canonical text and CORE-02 signature;
- the G-02C1D evidence store's observations and accepted receipts.

## 2. What it is not

- **Not production evidence.** Every identity, environment and effect is synthetic. The effect is a synthetic deployment record written by the reference executor, not a deployment.
- **Not live.** The file is a recording of one CI run. A page that shows it must say "recorded reference run", never "live", "now" or "real-time".
- **Not a new guarantee.** DEMO-01A claims nothing beyond G-02C1D's security statement (`docs/security/G-02C1D-END-TO-END-RECEIPT-EVIDENCE.md`).
- **Not an endpoint.** It adds no route, API, privileged surface, signing authority or retry path. Nothing can be issued or executed through it.

## 3. Evidence authenticity classification

| Category | Applies | How |
|---|---|---|
| Actual reference implementation output | **Yes** | Every capability, receipt, decision, observation and effect record is read from the Host's and the executor's own stores after the run. |
| Deterministic generated fixtures | Partly | The scenario inputs (actors, resources, `release-42`) are fixed synthetic values. The outputs are not deterministic: identifiers, instants, signatures and keys differ every run. |
| Precomputed artifacts | Yes, once consumed | DEMO-01B shows one recorded bundle. It never re-runs anything. |
| Synthetic example data | Yes | All identities and the effect are synthetic. |
| Live production evidence | **No** | Never. |

## 4. The three scenarios and what the suite asserts

Every assertion below runs in `validate` (`npm test`) and in `demo-evidence`.
The suite fails, and no bundle is written, if any of them does not hold.

### A. Authorized: the delegated production environment

- The governed action returns `executed`. The Host's issuance ledger holds an `issued` capability for that execution.
- Exactly one request reaches the executor. It carries exactly one presentation header, and that header carries exactly the issued capability text and signature.
- At the executor, the consumption state is `completed`, with one synthetic effect and one signed receipt.
- On the Host, there is one observation: `response`, `receipt-correlated`, `consistent`, `completed`, `completed-observed`. The accepted receipt is the executor's persisted receipt, verbatim.
- **Resubmission:** the same request with the same idempotency key adds no request to the executor and no effect.
- **Re-presentation:** the captured bytes, written to the executor directly again, add no effect. The executor still holds one receipt.
- Certainty: `authorized`, `executedAtExecutor`, `observedByHost`, `verifiedByHost`, `confirmed` (by reference evidence, never business settlement).

### B. Blocked: an environment outside the delegated authority

The agent requests `production-eu-environment-example`. That resource is in the
same resource class and governed by the same profile as the delegated
environment, but the agent's capability token, authority grant and delegation
cover only the fixture's resources.

- The governed action returns `denied` with non-empty reason codes. The suite asserts no specific code: the bundle carries the Kernel's own reason codes and the committed decision's failed policy checks exactly as the run produced them.
- No issuance-ledger row is added and no capability is issued.
- No request reaches the executor, so there is no presentation header, no effect and no receipt.
- No evidence observation is added on the Host. There is no "refusal receipt": the architecture has none, and the bundle does not imply one.

### C. Uncertain: the executor acts and its answer is lost

The Host's request goes through a relay that forwards it and then drops the
Host's connection as soon as the executor's answer starts.

- The governed action returns `execution_unconfirmed`. The capability is `issued`, and exactly one presentation, the issued capability, reached the executor.
- **Executor side** (read by the test harness from the executor's own durable state; never known to the Host): consumption `completed`, one synthetic effect, and one signed receipt persisted but never delivered.
- **Host side:** one observation, `unconfirmed`, `receipt-missing`, `not-comparable`, with HTTP outcome `unconfirmed`. There is no accepted receipt.
- **Resubmission:** the same request with the same idempotency key adds no request and no effect, the status is never `executed`, and the Host still holds no verified receipt.
- Certainty: `authorized` and `executedAtExecutor` hold. `observedByHost`, `verifiedByHost` and `confirmed` do not. Resolving this needs reconciliation or a receipt-retrieval route, and neither exists (§9).

### The certainty ladder

| Rung | Derived from (never asserted directly) |
|---|---|
| `authorized` | The Host's issuance ledger holds an `issued` capability for the execution. |
| `executedAtExecutor` | The executor's consumption ledger says `completed` and exactly one synthetic record was added. |
| `observedByHost` | A Host evidence observation has transmission `response`. |
| `verifiedByHost` | The Host's evidence store accepted a receipt (`receipt-correlated`). |
| `confirmed` | Verified, the receipt says `completed-observed`, agreement is `consistent`, and the Host status is `executed`. |

`hostConclusion` is the Host's own governed-action status. The ladder is
recomputed from the facts by the verifier, so a bundle whose ladder disagrees
with its facts fails.

## 5. Bundle format: `frontera.demo-evidence-bundle.v1`

```text
{
  format:                   "frontera.demo-evidence-bundle.v1"
  evidenceCanonicalization: "aoc.canonical-json.v1"
  evidenceDigest:           "sha256:<hex>"            # of aoc.canonical-json.v1(evidence)
  evidence: {
    classification:   { origin, data, production:false, live:false, effect, transport, statement }
    story:            { headline, principalId, agentActorId, delegatedByActorId, action,
                        delegatedResource, undelegatedResource, releaseVersion }
    verificationKeys: [ { role:"capability-issuer", subject, keyId, algorithm, publicKeyPem, signingDomain, origin },
                        { role:"executor-receipt",  subject, keyId, algorithm, publicKeyPem, signingDomain, origin } ]
    scenarios: [ authorized, blocked, uncertain ]     # exactly these, in this order
    limitations: [ ... ]                              # §9, verbatim
  }
  provenance: { source, repository, checkoutSha, headSha, workflow, job, runId, runAttempt, runUrl,
                generatedAt, statement }              # outside the digest
}
```

Each scenario has the same shape:

```text
{ id, title,
  request:  { principalId, agentActorId, action, resource, parameters:{ releaseVersion } }
  host: {                                             # what the Host knew
    response:         { httpStatus, status, reasonCodes, executionId|null, replayed|null }
    decision:         { decisionId, status, reasonCodes, failedChecks:[{ policyId, reasonCode }] }
    capabilityIssued: null | { issuanceState, capabilityId, executionId, issuer, issuerKeyId, audience,
                               subjectActorId, onBehalfOfActorId, action, resource,
                               actionBinding:{ format, digest }, consumption, statusRequirement,
                               issuedAt, expiresAt, canonical, signature }
    issuanceRecordsAdded, evidenceObservationsAdded
    observations:     [ { transmission, httpStatus, httpOutcome, disposition, failure, receiptOutcome, agreement } ]
    acceptedReceipts: [ { receiptId, digest, outcome, receipt, signature } ]
  }
  wire:     { requestsReachingExecutor, presentationHeaders, presentedCapabilityMatchesIssued|null }
  executor: { source:"executor-durable-state-read-by-test-harness", consumptionState|null, outcomeRecorded|null,
              syntheticEffectsAdded, effectRecord|null, receipts:[ { receipt, signature } ] }
  resubmission:   { status, requestsReachingExecutorAdded, syntheticEffectsAdded }
  representation: null | { executorHttpStatus, syntheticEffectsAdded }
  certainty: { authorized, executedAtExecutor, observedByHost, verifiedByHost, confirmed, hostConclusion }
}
```

- `signature` is the CORE-02 envelope verbatim: `{ algorithm, artifactVersion, keyId, signature }`, base64url and unpadded.
- `capabilityIssued.canonical` and every `receipt` are the exact canonical texts that were signed. The signed bytes are `signingDomain + canonical text` (UTF-8).
- The file is written with keys in canonical order and two-space indentation. Its layout does not affect `evidenceDigest`.
- The schema is **closed**. `parseDemoEvidenceBundle` refuses:
  - an unknown or missing field, or a wrong type;
  - a field whose name suggests secret material (`private`, `secret`, `token`, `credential`, `authorization`, `bearer`, `apiKey`, …), wherever it appears;
  - a key that is not a PEM public key;
  - scenarios other than exactly `authorized`, `blocked`, `uncertain`, in that order.

## 6. Verifying a bundle

`verifyDemoEvidenceBundle` (Node, in the suite) re-derives every checkable
claim. DEMO-01B should repeat the cryptographic checks in the browser with
WebCrypto.

**1. Digest.** `evidenceDigest` must equal `sha256:` of `aoc.canonical-json.v1(evidence)`. The canonicalization rules:

- object keys sorted by UTF-16 code unit;
- array order kept;
- `JSON.stringify` for strings, booleans and finite numbers;
- no whitespace.

**2. Capability signature.** Ed25519 over `UTF-8(signingDomain + canonical)` with the `capability-issuer` key. The envelope's `keyId` must equal the key's `keyId`. The capability's `issuer` and `issuerKeyId` must equal the key's `subject` and `keyId`. The metadata beside `canonical` must equal the fields inside it.

**3. Receipt signatures.** Ed25519 over `UTF-8(signingDomain + receipt)` with the `executor-receipt` key, for every executor receipt and every Host-accepted receipt. The suite also runs the G-02C1C verifier, pinned to the bundled key and the scope the capabilities name, with the expected executor, issuer, capability, execution, audience and action binding.

**4. Correlation.**
- Each receipt names its scenario's capability and execution, and the same action binding.
- `observation.digest` equals `sha256:` of the exact `effectRecord` text.
- A Host-accepted receipt is the executor's own receipt, verbatim. Its `digest` is the hash of its text, and its `receiptId` and `outcome` are the ones inside the signed text.

**5. Scenario invariants and certainty.** The §4 invariants hold, and `certainty` equals the ladder recomputed from the facts.

**What a valid signature shows.** Both keys are generated fresh by the run:
- the authority key in the test process;
- the receipt key in a separate process. The test process reads its private file once, only to check that it is absent from the bundle.

Their private halves never leave the CI runner. They are not in the bundle, and the suite checks that.

A key that travels with the artifact it verifies is not a root of trust, though. A valid signature shows that the bytes are what the holder of that key signed (consistency), not who holds it. That the file came from this CI run rests on §7.

## 7. Provenance and digests

- `provenance` is copied from the producing job's environment:
  - `GITHUB_REPOSITORY`, `GITHUB_SHA` (`checkoutSha`; for a pull request this is GitHub's merge commit);
  - `FRONTERA_DEMO01_HEAD_SHA` (`headSha`: the pull request's head, or the pushed commit);
  - `GITHUB_WORKFLOW`, `GITHUB_JOB`, `GITHUB_RUN_ID`, `GITHUB_RUN_ATTEMPT`, and the derived `runUrl`.

  Outside GitHub Actions every CI field is `null` and `source` is `local-test-run`. These fields are **claims**. They sit outside `evidenceDigest`, which describes the evidence payload only, so nothing hashes itself.
- The job writes `frontera-demo-evidence-bundle.v1.json.sha256` (the `sha256sum` of the file) beside the bundle. It prints that line in the job log and the run summary, uploads both files as one artifact, and prints the artifact URL and the artifact zip's digest from `actions/upload-artifact@v4`.
- **Independent check.** Open `runUrl` and confirm:
  - the run is a `CI` workflow run on `Republika-Network/Frontera` at `headSha`;
  - its `demo-evidence` job log shows the same file digest;
  - its artifact downloads to the same bytes.

  GitHub, not the file, is the authority for those facts.
- No artifact attestation and no new permission is used: the job has `contents: read` only (see §10).

## 8. Sensitive material

The bundle is public material from the start. Protection works in three layers.

1. **Construction.** The suite copies named fields only:
   - it never keeps the relay's raw request bytes, which contain the executor bearer credential;
   - it never keeps file paths, environment values or private keys;
   - signature envelopes are copied field by field.
2. **Closed schema.** An unexpected field, or one whose name suggests secret material, is a refusal (§5).
3. **Scan** (`sensitiveFindings`) of the serialized file. It must find nothing.
   - **Run sentinels:**
     - the Host authority private key and two other test authority private keys;
     - the executor receipt private key, read from its file only to check its absence;
     - the executor bearer credential and the other gateway credentials;
     - the agent, administrator and legacy API keys;
     - the Host and executor state directories, the OS temporary directory, the home directory and the working directory;
     - the value of every environment variable whose name contains `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `CREDENTIAL` or `PEM`.
   - **Generic shapes:** a private-key block, an HTTP authorization value, Unix and Windows filesystem paths, connection strings, credentials in a URL, and environment assignments.

   Each PEM sentinel is checked whole and line by line. The suite also proves the scan is live: an appended credential, private key or state path is reported.

## 9. Reference limitations (carried in the bundle)

1. **Transport:** loopback HTTP only. TLS, certificate checks, public DNS and the public-address policy are not qualified.
2. **Lost receipts:** there is no retrieval flow. An undelivered receipt stays on the executor until reconciliation exists.
3. **Revocation:** an executor working offline cannot learn that an already-issued capability was revoked before it expires.
4. **Rollback:** the Host and executor keep separate durable stores, with no global anti-rollback guarantee.
5. **Exactly-once:** there is no universal exactly-once guarantee. Single use is enforced by the executor's own durable ledger.
6. **Keys:** executor receipt-key custody and rotation are not production-hardened. The bundle's keys exist for one run.

These are disclosures, not DEMO-01 work items.

## 10. CI job `demo-evidence`

- **Runner:** `ubuntu-24.04`, `timeout-minutes: 30`, `permissions: contents: read`. It uses no secrets and no write permission.
- **Steps:**
  1. `npm ci`, then `npm run build`.
  2. Run the one compiled suite with `FRONTERA_DEMO01_EVIDENCE_OUT` set to a path under `$RUNNER_TEMP`.
  3. Write `sha256sum`.
  4. `actions/upload-artifact@v4`, artifact name `frontera-demo01-reference-evidence-run<run_id>-attempt<run_attempt>`, 90-day retention.
- **Not done:** nothing is published as a release, package or site.
- The same suite also runs, without writing, inside `validate` (`npm test`).
- **Repeatability:** every run produces a bundle of the same shape that passes the same checks. Identifiers, instants and keys differ by design, so two runs never produce the same bytes.

## 11. Consuming the bundle in DEMO-01B (frontera-web)

1. Pick the `demo-evidence` run of the merged commit. Download its artifact from the run page and check the file against the `.sha256` file and the job log's digest.
2. Commit the bundle unchanged to the page's folder (for example `src/landing/enterprise/governed-execution-demo/evidence.json`). Record next to it: the source repository, `headSha`, `runUrl`, the artifact name, and the file's SHA-256.
3. Parse it strictly: the same closed shape as §5. Reject unknown fields, and reject a `format` other than `frontera.demo-evidence-bundle.v1`.
4. Re-verify in the browser:
   - **Signatures:** Ed25519 with `crypto.subtle`. Import the SPKI from `publicKeyPem` and verify over `signingDomain + canonical`. Decode signatures from base64url.
   - **Digest:** recompute `evidenceDigest` with SHA-256 over a canonical serializer that follows §6.1.
   - **Unsupported browsers:** where Ed25519 is unavailable, show "verification unavailable in this browser", never "failed".
5. **Presentation rules:**
   - Say "recorded reference run" and "synthetic" wherever an outcome is shown.
   - Show `blocked.host.response.reasonCodes` as recorded. Never invent or rename a code.
   - Never show a receipt for the blocked scenario.
   - Separate the executor's facts from the Host's knowledge in the uncertain scenario.
   - Show the §9 limitations.
6. **Do not** fetch the bundle at runtime, call a Frontera endpoint, embed a private key, or describe the bundle as live.
