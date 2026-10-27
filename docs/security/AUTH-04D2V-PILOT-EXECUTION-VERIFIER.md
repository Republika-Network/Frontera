# AUTH-04D2V — Pilot Execution Verification Tool

- **Status:** implementation and CI qualification. Nothing deployed.
- **Baseline:** `main @ 22fcc11` (AUTH-04D2S).
- **What it is:** a read-only operator CLI, `scripts/deploy/verify-synthetic-execution.mjs`, run as the `execution-verifier` tool of `compose.executor.yaml`. It feeds the AUTH-04D2S verifier (`src/enterprise/synthetic-execution-verification/`, **unchanged**) from existing private read paths, against keys pinned on the Host machine.
- **What it is not:** a dashboard, a route, an API, a protocol, a signing service or a database. No change to CORE-05, CORE-07, the G-02 chain, the gateway or the Authority Web client.

## 1. Read paths (all existing, all private)

| Evidence | Read path | Credential |
|---|---|---|
| CORE-05 approval: the canonical subject bytes, status, counted approvers, `notAfter`, `approvalDigest`, every verdict row | `GET /api/admin/approvals?view=all` and `GET /api/admin/approvals/{id}` (CTRL-04 operator plane) on `127.0.0.1:8787` | the observer operator (`approval.read`), already configured |
| ASSURE-01 trace: execution identity, final state, approval records; its own verification (integrity, authenticity of the approval chain head, correlation, completeness) | `GET /api/evidence/traces/{requestId}?level=AUDITOR` and `/verify` on `127.0.0.1:8787` | a read-only, organization-scoped **auditor** (`auditors` in the governed-action file; an existing contract). Stage 3 adds one, `pilot-execution-verifier`. `execution-init` prints its key |
| The Host-signed capability (G-02B issuance ledger) and the executor-signed receipts and exchange observations (G-02C1D evidence store) | the stores' own openers, on the Host's state volume, read methods only (`read`, `observationsFor`, `evidenceFor`) | none: filesystem access on the Host machine |
| Pinned keys: the executor receipt key the Host pins, the authority keys the executor pins, the issuer, organization and trust domain | the rendered public configuration in `FRONTERA_SYNTHETIC_EXECUTION_DIR`, mounted read-only | — |

**Neither the Authority origin nor its ingress routes `/api/admin` or `/api/evidence`** (CI-checked). The tool runs in the Host's network namespace and refuses any host but `http://127.0.0.1:<port>`.

## 2. Trust model

- **No injected evidence:**
  - the CLI takes exactly one argument, `--request <id>` or `--execution <id>`;
  - no argument can supply an approval view, a key or a path;
  - an execution id is resolved by recomputing `H(requestId, decisionId)` for every approval on the Host.
- **Approval provenance:**
  - the operator plane restates the exact canonical subject bytes, which must re-serialize to themselves before their digest is recomputed (by the AUTH-04D2S verifier);
  - every approving verdict row from the operator view must also appear, with the same row digest, subject digest and channel, in the verified ASSURE-01 trace's approval records. These are two independent read paths over one history;
  - the trace's own verification covers the authenticity of the approval chain's signed head;
  - any disagreement marks the trace unverified, and the result is `EXECUTION_UNKNOWN`.
- **Organization:**
  - exactly one is pinned, and a trace for another is unverified;
  - the receipt verifier pins executors to that organization.
- **Capability and receipt:**
  - re-verified by the AUTH-04D2S verifier under the pinned keys, with every AUTH-04D2S check;
  - a store that refuses its own integrity checks is reported as unreadable, and its evidence counts as missing.
- **Fail closed:** `EXECUTION_UNKNOWN` is never turned into success. An `AUTHORIZED` decision is never shown as executed. A withdrawn approval after execution stays `EXECUTION_UNKNOWN` (AUTH-04D2S §2).

## 3. Output

One human-readable summary, then the unchanged AUTH-04D2S statement as JSON (`frontera.synthetic-execution-verification.v1`, with its `verificationDigest`).

- **Every status is labelled synthetic.** The banner reads `SYNTHETIC ONLY — no external business effect is possible or claimed`.
- **Never printed:** credentials, keys, session tokens, the capability or receipt text, or signatures. Only identifiers, statuses and digests appear.
- **Exit codes:** `0` when the verification ran, whatever its status. `2` when it could not run: usage, configuration, refused access, an unknown id, or a non-loopback host.

## 4. Qualification (CI)

In `auth04d2s-verified-synthetic-execution.test.ts`, the tool runs as a separate process against the shipped Host with the gateway, the passkey decision and the reference executor:

- **Success:** `SIMULATED_SUCCESS`, and the statement is byte-identical to the in-process verification. The same holds by `--execution`, and on re-run.
- **Failure and incomplete outcomes:** `.invalid` gives `DELIVERY_FAILED`; pending gives `NOT_AUTHORIZED` with no receipt; a lost response gives `EXECUTION_UNKNOWN`.
- **Withdrawal after execution:** revoked approval, withdrawn standing, and a capability presented after revocation all give `EXECUTION_UNKNOWN` (`APPROVAL_WITHDRAWN_ORDER_UNPROVEN`). So does the first success once its approver's standing was revoked.
- **Never success:** an untrusted executor key, an untrusted authority key, another organization, missing stores, a tampered copy of the evidence store, an unknown execution or request id.
- **Refused, with no statement and no secret echoed:** a missing observer credential, a wrong one, an operator bearer used as the auditor, a non-loopback host, an extra argument.
- **No writes:** every row of both Host stores is identical before and after, and nothing is issued, presented or performed.
- **No leak:** neither output stream contains any configured secret, any key material, or a capability, receipt or signature.
- **Structure and kit checks:**
  - the kit test checks GET only, read methods only, no writes, loopback only, no key or approval argument, and no `/api/admin` or `/api/evidence` route on the Authority ingress;
  - `authority-pilot-config` checks the resolved `execution-verifier` service: the Host's network namespace, no port, only the observer and auditor credentials, and the pinned directory read-only.

**Covered by the AUTH-04D2S verifier tests, unchanged:** an expired or short-window capability, and a receipt claimed outside the window. The tool cannot fabricate those over real records.

## 5. Limitations

- **Concurrent opening:** the stores' openers open the SQLite files read-write; SQLite in WAL mode needs a writable directory. The tool calls only read methods, and CI proves the rows unchanged. Opening them while the Host runs relies on SQLite's concurrent readers.
- **Trust in the Host:** the approval view and the trace come from the Host itself. Their authenticity rests on the Host's own signed approval head, checked by the trace verification, and on the two read paths agreeing. A fully compromised Host machine could present a consistent forgery. The executor is co-located (AUTH-04D2S §8).
- **Not covered by CI:** the live pilot path (real TLS, DNS and the 8443 front), which stage-3 steps 6–7 check.
- **Unchanged from AUTH-04D2S:** the historical-ordering limitation, F2, F3, F5 and F6, and the pending real-device testing.
