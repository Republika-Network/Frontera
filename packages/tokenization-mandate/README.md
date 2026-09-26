# @aoc-enterprise/tokenization-mandate

Enterprise-owned, provider-neutral, immutable contracts for the **`TOKENIZE`** governed capability.

Three records, one vocabulary:

| Contract | Answers |
|---|---|
| `EnterpriseTokenizationRequest` | *May actor A tokenize rights R of asset X, within scope S, through executor E?* |
| `EnterpriseTokenizationMandate` | *What authorization was actually issued, by which decision, under which conditions, until when?* |
| `EnterpriseTokenizationExecutionEvidence` | *What did the external system actually issue under that authorization?* |

All three share `EnterpriseTokenizationTerms` — rights, scope, executor, constraints — so "what was asked" and "what was granted" can never drift into two different notions of scope.

## What this package is not

It is a pure data contract. No persistence, no service, no API, no policy engine, no provider SDK, no execution. And specifically, for this capability:

- no blockchain client, RPC, chain, or network access
- no token standard (no ERC-20/721/1400/3643 assumption anywhere)
- no wallet, key, signature, or custody
- no minting, issuance, transfer, burn, or valuation
- no marketplace, exchange, order book, or price
- no KYC/AML, investor onboarding, or transfer-agent logic
- no securities, title, or ownership assertion

Frontera Systems **authorizes** tokenization. It is not the tokenization provider.

## Semantics

### `TOKENIZE` is not `PROTOCOLIZE`

```
Protocolization  — establishes a governed/canonical asset representation
                   and its authority/evidence context.
Tokenization     — an optional governed action performed on rights of an
                   already-governed asset, producing an external
                   representation of those rights.
```

An asset can be protocolized and never tokenized. Tokenization always presupposes an already-identified governed asset. `ENTERPRISE_CAPABILITIES_DISTINCT_FROM_TOKENIZE` records this distinction as data (`protocolize`, `register`, `transfer`, `license`, `delegate`, `collateralize`, `commercialize`), and `validateEnterpriseTokenizationRequest` enforces it structurally: a request whose `capability` is not exactly `'tokenize'` is invalid.

This is **not** a capability registry. This repository deliberately treats capability as an open string (`AuthorityGrant.capability`, `RecognitionCapabilityToken.capability`, `ActionDescriptor.capability`), and nothing here enumerates or constrains what other capabilities exist.

### Rights

`ENTERPRISE_TOKENIZED_RIGHT_TYPES` is a closed vocabulary — `economic-interest`, `revenue-right`, `ownership-interest`, `usage-right`, `contractual-claim` — mirroring `ENTERPRISE_ACCESS_OBLIGATION_TYPES` and `ENTERPRISE_USAGE_EVENT_TYPES`. A future category is a `schemaVersion` change, not an escape hatch.

Naming a right records what the proposed tokens would represent. It never asserts that anyone holds it: `'ownership-interest'` does not make Soberanía a title registry, and authority must already have been established upstream by the primitives Soberanía evaluates.

### Scope, without floating point

```ts
{ kind: 'proportional', basisPoints: 2000 }                            // 20%
{ kind: 'unitized', units: 500, unitDenomination: 'entitlement-unit' } // 500 units
```

Shares are integer basis points (1/100th of a percent; `10000` is the whole). `0.1 + 0.2 !== 0.3` in IEEE-754, and an economically significant share must compare and sum exactly. The union is discriminated, so "somehow both 20% and 500 units" is unrepresentable, and `enterpriseTokenizationScopeWithin` never compares across kinds or across unit denominations.

`TOKENIZE(asset)` is never "the whole asset" — a request must name its rights and its scope explicitly.

### Constraints

`maximumIssuedUnits`, `permittedNetworks`, `permittedTokenStandards`, `permittedJurisdictions`, `transferRestricted`, `additionalIssuanceAllowed`. Every one is a *declared limit Soberanía records and compares*, never an instruction Soberanía carries out. The label lists are opaque strings: Soberanía does not resolve, validate, or act on a network name, a standard name, or a jurisdiction code. `additionalIssuanceAllowed` is required because "may this be exercised more than once?" has no safe default.

### Containment

`enterpriseTokenizationTermsWithin(inner, outer)` is the single test for "did the granted authorization stay inside what was requested?": rights are a subset, scope is contained, the executor is unchanged, constraints did not loosen. While it holds, `20%` cannot become `100%`.

### Mandate status

`'active' | 'revoked'` only, mirroring `EnterpriseAccessGrantStatus`. `'expired'`, `'consumed'` and `'superseded'` are deliberately not status values: expiry is fully represented by `effectiveFrom`/`expiresAt`, exhaustion by recorded execution evidence measured against the constraints, and supersession is a relationship between two mandates rather than a property of either. Each would otherwise be a second, independently-settable source of truth. `enterpriseTokenizationMandateAuthorizes` derives all of them instead, purely, from the instant it is asked about.

### Revocation semantics

Revoking a mandate withdraws the authority to perform **additional** external issuance.

It makes no claim about tokens an external system has already issued. Soberanía governs authority; it does not pretend to hold technical powers an external tokenization system does not grant it. Execution evidence recorded before revocation is preserved immutably.

### The integration boundary

`EnterpriseTokenizationExecutionEvidence` is the whole of it:

```
TokenizationMandate  ->  external system performs issuance  ->  execution evidence returned
```

`externalSystem`, `externalNetwork`, `externalTokenStandard`, `externalContractReference`, `externalTransactionReference` are opaque strings Soberanía stores and echoes. `externalContractReference` is not assumed to be an EVM address; `externalTokenStandard` is not assumed to be an ERC number. Recording evidence never re-authorizes anything — the same observation-only posture `EnterpriseUsageEvent` takes toward `EnterpriseAccessGrant`.

## Where the governance actually happens

Nothing in this package decides anything, and nothing in it persists anything. Authority, policy, approvals, obligations, decision and durable evidence for `TOKENIZE` come from the primitives Frontera Systems already has — `AocKernel`, Recognition Runtime, Authority Graph, Approval Runtime, the Domain Policy Pack Runtime, and the Governance Store. The Enterprise module that binds this package to them — and that stores mandates durably, in SQLite, across process restarts — lives at `src/enterprise/tokenization-governance/`.

See `docs/enterprise/AOC_TOKENIZE_CAPABILITY.md`, `docs/architecture/ADR-TOKENIZE-CAPABILITY.md`, and `docs/architecture/ADR-TOKENIZATION-MANDATE-PERSISTENCE.md`.

### Terminology

In the Soberanía model, `TOKENIZE` is an Enterprise **Governed Action**, the evaluation of whether it may be exercised is an **Enforcement**, and `EnterpriseTokenizationMandate` is the resulting **Mandate**. These are distinct from Soberanía Protocol's **Sovereignty Capabilities**. The field name `capability` on `EnterpriseTokenizationRequest` is the repository's existing technical contract surface and is deliberately unchanged; read it as "the identifier of the Governed Action".

## Ownership

Frontera Systems. Depends only on `@aoc/protocol` (identity primitives) and `@aoc-enterprise/resource-envelope` (`resourceRefIdentityEquals`).
