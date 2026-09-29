# ADR — External Authority Signer & Key Custody Boundary (CORE-02)

- **Status:** Accepted — CORE-02, 2026-09-28 (branch `feat/core-02-external-signer-key-custody`, merged as PR #152); amended by the post-merge review hardening **CORE-02R**, 2026-09-29 (branch `fix/core-02-review-hardening`, §6)
- **Roadmap item:** `docs/architecture/FRONTERA-MASTER-PLAN.md` §9 CORE-02
- **Security detail:** `docs/security/AUTHORITY_ARTIFACT_AUTHENTICITY.md` §29
- **Code:** `src/enterprise/external-authority-signer/`, `src/enterprise/authority-authenticity/custody.ts`, the authenticity boundary in `src/enterprise/composition/composition-root.ts`, `scripts/run-reference-authority-signer.mjs`

## 1. Context

Every Frontera authority artifact — bounded grants, grant revocations, the
revocation-state commitment (CORE-01), the obligation discharge state
(CORE-04) and the approval state (CORE-05) — is Ed25519-signed through one
domain-aware interface, `AuthorityArtifactSigner`, and verified locally
against a trusted public-key registry. Until CORE-02 the only implementation
held the private key **in the Host process** (`createSoftwareAuthorityArtifactSigner`,
fed from `AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_PEM`): anything that could read
that process could mint authority that verifies perfectly (**AA-001**).

## 2. Decision

### 2.1 Custody is a closed, explicit configuration choice

`authorityAuthenticity` is `software` (the historical shape, still the
default when no mode is stated) **or** `external`
(`AOC_ENTERPRISE_AUTHORITY_SIGNER_MODE=external`). The external variant has
no private-key field. Under `external`:

- `AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_PEM` is never read into configuration;
  its mere presence refuses the Host (strict environment) and the composition
  (a non-secret `conflictingSigningKeyPresent` flag, or a hand-built object
  carrying a key) — the key would otherwise still be resident in the process
  environment while the operator believes it is not.
- External-signer variables without `external` are refused (never guessed).
- There is no auto-detection, no "try external, else software", and no
  software signer anywhere on the external composition path.

**Which configurations permit software signing:** any configuration that does
not set `AOC_ENTERPRISE_AUTHORITY_SIGNER_MODE=external` — including the secure
`production`/`staging` profile, which requires *a* signer, not external custody
specifically (§11.1 item 3 asks that keys are *not required* to be
process-resident; it does not mandate external custody). The embedding
surface (`createEnterprise`) keeps accepting a software configuration and a
host-supplied software-signed store under software custody. The posture field
`authoritySigner` (`software` | `external`) states which one runs.

### 2.2 The external signer keeps the domain-aware interface

The external implementation *is* an `AuthorityArtifactSigner`: the same five
methods, no generic `sign(bytes)`, no key member. It sits at the enterprise
composition edge; the Kernel, the governed runtimes, the stores and the
authenticity module know nothing about transport and import no vendor SDK
(structural tests).

```
Frontera Host process                                   custody service process
─────────────────────                                   ───────────────────────
store (grant | revocation | state)                      holds the private key
  └─ AuthorityArtifactSigner.signX(artifact)  ── HTTPS ─► /v1/sign/<operation>
       (external adapter)                                 parses the structured
         ├─ bounded attempts, per-attempt timeout         artifact, rebuilds the
         ├─ envelope: pinned keyId + algorithm            domain-separated bytes,
         ├─ LOCAL verify under the pinned key ◄───────────  signs, returns the
         └─ only then → store (write transaction)          4-field envelope
store read path ── AuthorityArtifactVerifier (public keys only; no signer)
```

### 2.3 A structured, vendor-neutral protocol

`frontera.external-authority-signer.v1`: `GET /v1/identity` (non-signing
capability answer: key id, algorithm, SPKI public key, artifact version,
operations) and one `POST` path per operation
(`/v1/sign/grant`, `/revocation`, `/revocation-state`,
`/obligation-discharge-state`, `/approval-state`). A grant travels as its
canonical serialization and must round-trip exactly; commitments travel as
their closed fields. There is no `/sign` taking bytes. A provider that
*does* expose generic signing (a cloud KMS) is put behind a server speaking
this protocol, so the generic primitive stays inside that server. The
transport is a port (`ExternalAuthoritySignerTransport`); the shipped one is
HTTP (https anywhere, http to loopback only; bearer credential; no redirects;
64 KiB response cap). mTLS, workload identity or a provider SDK are further
transport implementations — no CORE change.

### 2.4 Identity: configured trust pins remote identity

The pin is this deployment's own trusted-registry entry for
`AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_ID` — key id, algorithm **and** public
key. At startup, before any store is opened, the service's identity must
match all three exactly (public key compared as SPKI bytes) and offer exactly
the protocol, `aoc.authority-artifact.v1` and the five operations. Any
mismatch, a malformed answer, an unsupported algorithm, a refused credential,
or no answer within the budget refuses the Host. The advertised key is only
compared: nothing remote is ever added to the registry (no TOFU). Rotation is
configuration + restart; a key change answered mid-process is refused.

### 2.5 Every returned signature is verified locally before persistence

The adapter accepts an answer only if it is exactly the four-field envelope,
names the pinned key id and algorithm and the current artifact version, has
the exact encoding and width, and **verifies locally** — through the
deployment's own verifier, over the exact artifact sent, under the pinned key
(a still-trusted historical key is refused). Only then does a store see it,
and the store's own read-back verification stays as a second check (added to
the obligation and approval appends by CORE-02, which previously persisted
their head without reading it back).

### 2.6 Failure taxonomy, time and retries

A closed, repository-owned `AuthoritySigningFailureReason`:
`EXTERNAL_SIGNER_{TIMEOUT, UNREACHABLE, UNAVAILABLE, AUTHENTICATION_FAILED,
REFUSED, IDENTITY_MISMATCH, MALFORMED_RESPONSE, CAPABILITY_UNSUPPORTED,
SIGNATURE_INVALID}`. Runtime failures are `AuthoritySigningUnavailableError`
(with `reason`); startup identity failures are
`AuthorityAuthenticityConfigurationError` (with `reason`). No provider
exception, status text, body, credential or payload is propagated.

Every call has a per-attempt budget (`AOC_ENTERPRISE_AUTHORITY_SIGNER_TIMEOUT_MS`,
default 5 000, 1 … 60 000) and a bounded number of attempts
(`…_MAX_ATTEMPTS`, default 2, 1 … 3). Only the availability family (timeout,
unreachable, unavailable/429/5xx) is retried; anything the service *answered*
is never retried. Worst case per signature: `attempts × timeout`.

*As merged in PR #152 the startup identity handshake made a single attempt
regardless of `maxAttempts`; CORE-02R (§6.3) applies the same bound to it.*

### 2.7 Transactions

Unchanged and now structurally tested for all three stores: plan/preflight →
external sign (the only `await`) → `BEGIN IMMEDIATE` → re-verify state →
commit guard / exact-base check → write → read back → `COMMIT`. No
transaction callback is async, awaits or reaches the signer.

### 2.8 Cost and rate (AA-005)

Grant issuance now runs a **non-authoritative preflight** (already issued?
precluded by a revocation? `commitGuard` still permits?) before signing; the
transaction asks all three again after signing. Revocations already settled
unknown and already-revoked grants before signing. Expected signer calls:

| Operation | Calls |
|---|---|
| New grant store (genesis) | 1 (`signRevocationState`) |
| New discharge / approval store | 1 each |
| New grant | 1 |
| Duplicate / precluded / already-ineligible issuance | 0 |
| Revocation | 2 (`signRevocation` + `signRevocationState`) |
| Duplicate or unknown-grant revocation | 0 |
| Discharge report / approval event | 1 each |
| Key rotation (per store, at open) | 1 (best-effort re-attestation) |
| Health probe | 0 (identity only) |

Not zero-waste: eligibility withdrawn while a signature is in flight, a stale
revocation plan (another process revoked meanwhile — re-plan and sign again),
and a lost response followed by a retry each spend a signature that is then
discarded. That is the price of correctness; the stores guarantee one state
transition.

### 2.9 Outage semantics

- **Reads never depend on the signer.** Grants, revocation state, discharges
  and approvals verify locally with the signer down.
- **Mutations fail and write nothing.** Issuance, revocation, discharge,
  approval and genesis refuse; nothing unsigned, partial or "signed later"
  exists. An approval request cannot open (withheld `unavailable`).
- **Revocation is honest (AA-004).** The admin API answers `503
  AUTHORITY_SIGNER_UNAVAILABLE` with `recorded: false` and says the grant
  remains exercisable. The one control that does not depend on the signer —
  a durable **emergency stop** (unsigned, integrity-only store) — still works
  and withholds exercise; it is not a revocation.
- **Health.** `/health` carries `authoritySigner {custody, keyId, algorithm,
  state, reason?, signing}`; an unreachable, refusing or re-keyed service
  makes the Host `degraded` (never `unhealthy`; `/ready` stays 200). The probe
  never spends a signature. *As merged in PR #152 a successful probe also
  cleared a signing failure; CORE-02R (§6.2) separates the two.*
- **Startup.** A Host that cannot prove its signer's identity does not start —
  including a restart during a signer outage (reads are then unavailable until
  the signer answers; a degraded read-only boot is not offered). Deliberate:
  identity is proven before listen, and a new store's genesis needs a signature
  anyway.
- **Rotation during an outage.** Re-attestation stays best-effort; stores open
  and read under the still-trusted old key.

### 2.10 Reference custody boundary

`scripts/run-reference-authority-signer.mjs` runs
`src/enterprise/external-authority-signer/reference/reference-signer-service.ts`
as its own process: it generates or loads a PKCS#8 key file (mode 0600, its
alone), writes the public half to `<file>.pub`, binds loopback only, speaks
plain HTTP with one bearer credential, and labels itself "NOT an HSM". It
signs through `createSoftwareAuthorityArtifactSigner`, so the only file that
parses a private key is still `authority-authenticity/signer.ts`, and it can
perform only the five structured operations. It is a reference and
qualification boundary, not a deployment recommendation.

### 2.11 Agent Passport / TD-5 — decided, re-owned

The authority key vouches for authority artifacts; it is **not** extended to
passports (`AuthorityArtifactSigner` gains no passport method — structurally
tested). The Enterprise Host composes no passport signer at all; the HMAC
`createTestSigner` exists only in the standalone `apps/agent-passport-web`
issuer. TD-5 is **decided and re-owned to CTRL-02**: passport issuance needs
its own asymmetric key role (and may reuse this custody pattern and
transport), and passports stay not publicly verifiable until then.

## 3. What this does and does not change

**Closed for external mode (AA-001, scoped):** no authority private key is in
the Frontera Host process — not in configuration, not in the environment, not
parsed. Process-memory disclosure is no longer private-key disclosure.

**Not closed:**

- *Signing authorization under process compromise.* The Host holds a service
  credential that authorizes the custody service to sign structured
  artifacts. A fully compromised Host can still **ask** for signatures while
  it is compromised; it cannot extract the key or keep signing after the
  credential is rotated. The reference service enforces no independent policy.
  "Host compromise cannot mint authority" remains a claim we must not make.
- *AA-002.* The startup check now proves signer ↔ verifier agreement (key id,
  algorithm, public key) and catches miswiring or substitution of either half
  alone. An attacker who can rewrite the signer endpoint **and** the
  verification registry **and** the Host configuration still controls trust;
  there is no independent configuration trust root.
- *AA-004.* Revocation still needs the signer. It is now explicit, bounded,
  observable, tested and operationally mitigated (emergency stop), not solved.
  No redundant signers, quorum or signer-independent revocation.
- *AA-006.* Only `ed25519-v1`. A provider must support Ed25519 (or sit behind
  a custody server that does); adding an algorithm remains deliberate
  cryptographic work.
- *Transport.* The shipped transport has no mTLS/workload identity; plain HTTP
  is accepted only to loopback, for the reference signer.

## 4. Compatibility

No artifact format, domain string, `AUTHORITY_ARTIFACT_VERSION` or schema
changed. External and software signers produce **byte-identical** signatures
for the same key and artifact (deterministic Ed25519; tested for all five
operations). Migration: keep the verification registry; configure external
custody for the same key (existing artifacts verify unchanged) or for a new
key (keep the old public key trusted until its grants are dealt with; state
heads re-attest under the new key at open).

## 5. Evidence

`external-authority-signer-contract.test.ts`, `-stores.test.ts`,
`-configuration.test.ts`, `-host.test.ts` (signer as a separate process on the
canonical Host), `-structure.test.ts`, `tests/external-authority-signer-launcher.test.mjs`
(the shipped launcher, `/proc/<pid>/environ` inspection); deliberate-violation
experiments recorded in the Master Plan. CORE-02R adds
`-review-hardening.test.ts` and `-process-env.test.ts` (§6.7).

## 6. Post-merge review hardening (CORE-02R)

PR #152 merged with three open review findings (P2-A, P2-B, P2-C), and an
independent review found a fourth (P2-D). None changed the artifact format,
the protocol, a domain string, `AUTHORITY_ARTIFACT_VERSION` or a database
schema; all four are composition, health and bootstrap repairs. The text above
describes CORE-02 as designed; this section records what the merged code did
not yet do, and what it does now. Every finding was reproduced against
`main @ 0778b74` before it was fixed.

### 6.1 Supplied stores: custody branding was not identity (P2-A)

**Defect.** Under external custody, `createEnterprise` accepted a
host-supplied grant, obligation or approval store whose runtime brand said
`external`. That brand records only *where* the store's key lives. It says
nothing about *which* key id, algorithm or public key signs, or which trust
registry verifies. Reproduced: configured signer A (unreachable), and a
supplied store built over external signer B. The Host composed, posture said
`authoritySigner: external`, A was never contacted, and every mutation would
have been signed by B. The same shape admitted a key swap under the same id,
and a supplied verifier that also trusts an attacker key (which would make
attacker-signed historical artifacts readable).

**Rule (Strategy 1: refuse injection).** Under
`authorityAuthenticity.mode = 'external'`, the composition root **builds every
authority-bearing store itself** (bounded grant, obligation discharge,
approval), all over the one boundary it establishes. That boundary is the
configured pinned key id, algorithm and SPKI public key, proven by the
identity handshake, plus the configured verification registry. It **refuses
any supplied store** in every persistence mode, even one that matches exactly.
No store can prove which boundary built it through what it says about
itself, so none is adopted. A runtime fingerprint (Strategy 2) would have kept
an injection path and a comparator to get right. Refusal is the smaller trust
story, and no production path supplies stores: `bootEnterpriseHost` never has.

- Genesis of every store (revocation, discharge and approval state) is
  therefore always signed by the established, configured external signer.
  There is still no software fallback.
- Posture `authoritySigner: external` can now only come from the established
  configured boundary. There is no configuration/runtime split.
- Rotation is unaffected. The active signing identity is the pin (exactly the
  configured active key). The historical verification set is the configured
  registry, which may keep old keys trusted for old artifacts. Re-attestation
  still goes through the active external signer.
- Verification stays local. Nothing about reads moved to the signer.
- **Embedding boundary.** Software custody keeps host injection, under
  CORE-01's authenticated-store rule. It makes no external claim, so nothing
  here constrains it. A software-custody embedder that supplies a store signed
  by some other software key gets that store's signer. That is the pre-existing
  CORE-01 embedding boundary, and it is not a CORE-02 claim.
- **Threat-model honesty.** Like every brand in this module, this stops a
  supported composition API from contradicting the configuration. It is not a
  defense against malicious code already running in the Host process. AA-002
  is unchanged: whoever controls the configuration (endpoint, registry, key id)
  still defines trust.

### 6.2 Health: identity reachability is not signing readiness (P2-B)

**Defect.** The monitor kept one state, written by both signatures and
identity probes. After a signing failure (unavailable, timeout, or a signature
that did not verify), the next `/health` probe reached `/v1/identity`, got a
correct answer, and set the signer to `ready`. The Host then reported `healthy`
while every mutation still failed. Reproduced for 503 and for an invalid
signature.

**Model.** The monitor has two states, and each is written only by the event
that can prove it:

| State | Written by | Cleared by |
|---|---|---|
| `identity` | the startup handshake; each probe | a later successful identity probe |
| `lastSigning` | signing operations only | a later **successful, locally verified** signature, and nothing else |

- Effective `ready`: the last identity result is acceptable **and** no signing
  failure is unresolved.
- Effective `unavailable`: either of those does not hold.
- `reason`: the unresolved signing failure if there is one (it is what stops
  new authority), else the identity failure.
- `/health.authoritySigner` shows both halves (`identity`, `lastSigning`) next
  to `state`, `reason` and the signing totals.
- A health check still never spends a signature. Truthfulness comes from not
  letting identity stand in for signing, not from test-signing.
- A successful signature does not clear an identity failure either. Each half
  clears only its own.

`/ready` is unchanged: a signer failure leaves the Host `degraded`, and
`/ready` stays 200. Being ready to serve existing authority, which verifies
locally, is not the same as the signer being ready for new authority
mutations. `/health` states the second. AA-004 is unchanged: while signing
fails, revocation cannot be cryptographically recorded, and the emergency stop
remains the signer-independent containment.

### 6.3 Startup identity honours `maxAttempts` (P2-C)

**Defect.** The handshake called `/v1/identity` once. Reproduced: with
`maxAttempts = 3`, a single transient timeout refused startup after one call.

**Rule.** The handshake and every signature now share one bounded-attempt loop
(`withBoundedAttempts`) and the existing classifier
(`isRetryableAuthoritySigningFailure`).

- Retried, up to `maxAttempts` (1 … 3, default 2):
  `EXTERNAL_SIGNER_{TIMEOUT, UNREACHABLE, UNAVAILABLE}`. That family includes
  HTTP 429, 5xx and connection resets.
- Never retried, one call: `AUTHENTICATION_FAILED`, `REFUSED`,
  `MALFORMED_RESPONSE`, `CAPABILITY_UNSUPPORTED`, `IDENTITY_MISMATCH` (including
  the same key id over a different public key) and `SIGNATURE_INVALID`.
- Validation stays separate from the loop. The loop retries transport failures
  only. Identity and signature answers are validated after it returns, each by
  its own code, so an answer that was received and refused is never retried.
- No delay and no backoff between attempts. Worst-case startup identity time is
  `timeoutMs × maxAttempts`, which is 5 s × 2 by default and 60 s × 3 at most.
- Identity attempts are not counted as signing attempts. The per-operation
  counters stay signing-only.

**Runtime probe: one attempt, deliberately.** A health probe reports, and the
next probe is the retry. Retrying inside a probe would multiply health latency
and signer fanout while adding no truth. `maxAttempts` governs the startup
handshake and signing, not monitoring. One probe takes at most `timeoutMs`.

### 6.4 Canonical Host: the real process environment (P2-D)

**Defect.** `bootEnterpriseHost({ env })` validated external custody against
the supplied map. A sanitized map therefore booted an "external" Host while
the real `process.env` still held `AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_PEM`.
Reproduced: the Host listened.

**Rule.** Under external custody the canonical Host refuses
(`HOST_ENVIRONMENT_INVALID`) before composition when the declared
authority-key variable is present in either place:

- the configuration map;
- the real `process.env`.

Refusing before composition means nothing is opened and the signer is not
contacted. Presence is enough, and an empty value counts, which matches the
map validation: the variable must not be part of the process at all. The
value is never read, compared, logged or serialized. This controls the
declared input only. It is not a scan of the environment or of memory for
key-shaped text.

`createEnterprise()` is the embedding surface. It judges the configuration it
is handed and still refuses a contradictory one. It does not inspect the
process it runs in, because the process-level claim belongs to the shipped Host
process.

### 6.5 Health-probe fanout (P3)

**Issue.** `/health` and `/ready` are unauthenticated operational endpoints,
and each invoked one authenticated identity call to the signer. N inbound
health requests therefore meant N outbound signer requests, an amplification
towards the custody service and its rate limits.

**Decision (bounded cache).** Probes are **single-flight**: concurrent callers
share one identity call. They are also **rate-bounded** by
`AOC_ENTERPRISE_AUTHORITY_SIGNER_PROBE_INTERVAL_MS` (0 … 60 000, default
5 000). Within the interval, the last identity result stands.

- Staleness is bounded. An identity `ready` is at most one interval old.
- The cache never hides a signing failure. Signing failures are recorded when
  they happen and are independent of it, so recovery can never be claimed by
  the cache (§6.2).
- `0` restores probe-per-request, still single-flight.
- Worst-case signer load from health checks is one identity call per interval
  per Host process.

### 6.6 Residuals (unchanged by CORE-02R)

- **AA-010.** A compromised Host can still use the service credential to
  *request* legitimate-looking signatures. External custody prevents
  extraction, not all signing abuse.
- **AA-002.** Narrowed, not closed. There is no configuration trust root
  independent of the Host's configuration.
- **AA-004.** Revocation needs the signer.
- **AA-011.** A restart during a signer outage does not start. The bounded
  retry now tolerates a transient blip, but not an outage.

### 6.7 Evidence

- `external-authority-signer-review-hardening.test.ts`:
  - **A:** supplied-store refusals A1 … A6, and the obligation and approval
    stores.
  - **B:** stickiness for unavailable, timeout and invalid signature; identity
    failure and recovery; independence of the two halves; the canonical Host
    with a separate-process signer behind a fault-injecting proxy.
  - **C:** exact identity call counts C1 … C7, the no-retry classes, and the
    one-attempt probe.
  - **P3:** single-flight, the interval, and the default on the Host.
- `external-authority-signer-process-env.test.ts` (D): runs in its own test
  process; `process.env` is saved and restored.
- Structure rules: the shared retry loop, and "only a verified signature clears
  a signing failure".
- Deliberate-violation experiments are recorded in the Master Plan.
