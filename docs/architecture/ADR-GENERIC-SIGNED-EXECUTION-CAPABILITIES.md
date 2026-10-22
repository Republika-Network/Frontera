# ADR: Generic signed execution capabilities (G-02A)

**Status:** Accepted (G-02A: contract, verifier and reference consumption ledger)
**Supersedes:** nothing
**Extends:** `ADR-EXTERNAL-AUTHORITY-SIGNER-AND-KEY-CUSTODY.md` (CORE-02), `ADR-OBLIGATION-DISCHARGE-AND-BOUNDED-GRANT.md`
**Security statement:** `docs/security/G-02A-EXECUTION-CAPABILITY.md` · invariants SEC-INV-357 … SEC-INV-366

## Context

An independent executor — a deployment gateway, a batch worker, a customer's
own service — has to decide whether Frontera authorized the one action it is
about to perform, without running Frontera's Kernel, stores or governance
model. Until now the only artifact that crossed that boundary was TRADE-04C-S1's
XRPL delegated-offer capability: correct, but domain-specific (network,
accounts, sequence, fee, signing preimage) and without an explicit audience.

The bounded grant is deliberately not that artifact. It is an internal typed
record held by a trusted store; a caller never holds or presents one
(SEC-INV-012, SEC-INV-026), and nothing in G-02 changes that.

## Decision

### 1. A derived artifact, not a serialized grant

`frontera.execution-capability.v1` is a separate, closed record derived from a
grant. It names the grant only through `grantReference` — `sha256` over the
grant's store id, grant id and grant digest under its own domain — which the
issuer can recompute for evidence linking and an executor cannot invert. No
grant scope, decision, request id, policy, approval, obligation or evidence
content is carried.

SEC-INV-012 and SEC-INV-026 are amended narrowly: they continue to hold for the
bounded grant without exception; the execution capability is the one artifact
that may leave the Host, and it is not a grant.

### 2. The contract

Eighteen fields, all required, no others (`EXECUTION_CAPABILITY_FIELDS`):

| Field | Binds |
|---|---|
| `format` | `frontera.execution-capability.v1` |
| `capabilityId` | 32 random bytes, hex — the single-use identity |
| `issuer`, `issuerKeyId` | the issuing deployment, and the CORE-02 key it signs as |
| `organizationId`, `trustDomain` | cross-organization and cross-domain replay |
| `audience` | exactly one executor; never a pattern (`*` is unrepresentable) |
| `subjectActorId`, `onBehalfOfActorId` | the acting actor, and the delegated principal or `null` (never the subject itself) |
| `action`, `resource` | what is authorized |
| `actionBinding` `{format, digest}` | the exact request, through an adapter-defined binding format |
| `executionId` | the issuer's opaque execution identity: one capability per execution |
| `grantReference` | the opaque internal-grant digest |
| `consumption` | `single-use` (the only v1 mode) |
| `statusRequirement` | `offline-permitted` or `online-status-required` |
| `issuedAt`, `expiresAt` | the window: at most 60 s; 30 s intended by default |

There is no numeric field, so there is no numeric spelling to disagree about.

**Privacy and correlation.** `subjectActorId` is stable across capabilities:
an executor can correlate one actor's actions over time, which is inherent in
telling it who acts. `executionId`, `grantReference` and `capabilityId` are
opaque and per execution. Two executors never receive the same capability
(one audience each), so they cannot correlate through it. Policy, decision and
evidence content never leave the Host in a capability.

### 3. Canonical form and signature: CORE-02, unchanged

- Canonical text: `aoc.canonical-json.v1` (`canonicalSerialize`) of the closed
  record. Parsing requires the text to re-serialize to exactly itself:
  reordering, whitespace, re-escaping, duplicated keys, unknown or missing
  fields are refused, never normalized. Unicode is compared code unit for code
  unit; an unpaired surrogate is refused raw or escaped. No second canonical
  JSON standard is introduced, and no other canonicalizer is changed.
- Signing bytes: `frontera:authority-artifact:execution-capability:v1\n` ‖
  canonical text — a new domain, registered in `AUTHORITY_SIGNING_DOMAINS`,
  prefix-free against every other.
- Envelope, algorithm registry (`ed25519-v1` only), key registry and
  verification routine: CORE-02's own. To let a standalone verifier use them
  without the Host's other artifact serializers, two dependency-free modules
  were split out **unchanged**: `authority-authenticity/signature-envelope.ts`
  (version, algorithm registry, envelope structural checks) and
  `authority-authenticity/signature-verification.ts` (trusted key registry and
  the one verification routine). `authority-signature.ts` re-exports the first;
  `createAuthorityArtifactVerifier` is built on the second. No signed artifact,
  signing domain, canonical byte or envelope field of any existing artifact
  changed.
- No signing operation exists for capabilities in G-02A. In-custody issuance —
  signing only for a grant the custody boundary itself signed, never past it —
  is G-02B. No generic byte-signing operation is added.

### 4. Four answers, never one boolean

`createExecutionCapabilityVerifier({ trustedIssuers, executor, clock })` takes
only what an independent executor holds. `verify({ presentation, action,
resource, actionBinding })` returns either a closed refusal (one of
`EXECUTION_CAPABILITY_VERIFICATION_FAILURES`, with per-check results) or:

1. **verification** — canonical form, pinned issuer and key, signature,
   audience, organization, trust domain, window, action, resource, binding;
2. **freshness** — offline: revocation and emergency stop `not-observed`, with
   the window as the only bound (`exposureBoundedUntil`); status-required:
   `status: 'unavailable'`;
3. **consumption eligibility** — `eligible: false` for a status-required
   capability (no status mechanism exists before G-02D);
4. execution outcome is not the verifier's concern.

`verified` is never permission to execute. Execution requires a durable claim.

The verifier's runtime import closure is exactly: the capability codec, the two
CORE-02 leaf modules and their error module, `aoc.canonical-json.v1` and its
digest — and `node:crypto` (pinned by a structural test).

### 5. Reference durable consumption ledger

`openExecutionCapabilityConsumptionLedger(path, { audience, clock, create })`,
adapted from the S1 signer's ledger (which is unchanged):

- one file = one consumption domain, pinned to one audience at creation;
- `claim` accepts only a `verified` result this runtime's verifier produced,
  refuses a status-required one, re-checks expiry against its own clock, and
  inserts in an `IMMEDIATE` transaction (`synchronous = FULL`) before any side
  effect; `capability_id` is the primary key and `(issuer, execution_id)` is
  unique;
- `claimed` is not an outcome: after a crash it reads as "authorized, possibly
  attempted, outcome not recorded"; recorded outcomes move forward only
  (`claimed` → `completed` | `failed` | `outcome-unknown`; `outcome-unknown` →
  `completed` | `failed`); rows and the ledger identity are never deleted or
  rewritten (triggers);
- a missing file is never an empty ledger; `create: true` refuses any existing
  file; a file without the schema, triggers, audience or integrity is refused.

Single use is global only across executor instances sharing one ledger file.
Nothing makes an external side effect happen exactly once.

## Consequences

- An enterprise executor can verify Frontera's authorization with the pinned
  public key, its own context, the request it is about to perform and a clock —
  without adopting the Kernel or the stores.
- Offline verification cannot observe a revocation or emergency stop committed
  after issuance. The ≤ 60 s window bounds that exposure; it does not eliminate
  it. A status-required capability fails closed until G-02D.
- The verifier and ledger are internal modules in G-02A: no package is
  published, no route exposed, nothing is composed into the Host.

## Deferred

| Milestone | Scope |
|---|---|
| G-02B | In-custody issuance rule, signer extension operation, issuer, Host audience configuration and issuer registration, grant-bound lifetime |
| G-02C | Executor integration; execution receipts signed by pinned executor keys, linked to P11 observations (P11/P12 semantics unchanged) |
| G-02D | Authoritative online status (signed, challenge-bound) for `online-status-required` |

TRADE-04C-S1's capability is not migrated. Multi-organization shared hosting
remains outside the qualified profile until G-01B2; embedders remain
trusted-code integrations.
