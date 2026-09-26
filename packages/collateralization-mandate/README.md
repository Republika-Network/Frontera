# `@aoc-enterprise/collateralization-mandate`

Enterprise-owned, provider-neutral, immutable contracts for the
`COLLATERALIZE` **Governed Action**.

Four contracts over one shared vocabulary:

| Contract | What it is |
|---|---|
| `EnterpriseCollateralizationRequest` | an unevaluated request to commit rights as collateral |
| `EnterpriseCollateralizationMandate` | the durable authorization a successful enforcement produced |
| `EnterpriseCollateralizationExecutionEvidence` | the record of one external collateral arrangement actually created |
| `EnterpriseCollateralizationReleaseEvidence` | the record that an external system *reported* that arrangement ended |

All four compose `EnterpriseCollateralizationTerms`: which rights, how much of
them, securing which obligation, for whose benefit, by whom, under what
declared limits.

## Definition

> **COLLATERALIZE** — authorizing a specified executor to subject a defined
> scope of specified rights associated with an already-governed asset to an
> external collateral or security arrangement securing a referenced
> obligation, under defined governance conditions.

## What this package is not

It contains no lending platform, bank, loan engine, DeFi protocol, custody
system, lien registry, real-estate registry, UCC filing system, securities
platform, asset valuation engine, liquidation engine, margin engine, smart
contract, blockchain client, wallet, lending marketplace, or collateral
oracle — and no provider adapter for any of them.

Nothing here originates a loan, computes interest or loan-to-value, prices or
values an asset, creates or perfects a security interest, determines priority
against any registry, liquidates or seizes anything, or contacts any external
system. It is a pure data contract: no persistence, no service, no API, no
policy engine, no execution.

**Frontera Systems governs whether collateralization is authorized. External
systems execute the collateral arrangement.**

## Three distinctions that carry weight

```
COLLATERALIZE != TRANSFER      committing rights as collateral does not
                               transfer ownership of them

COLLATERALIZE != TOKENIZE      tokenization authorizes an external tokenized
                               *representation* of rights; collateralization
                               authorizes rights to be *committed as security*
                               for an obligation

COLLATERALIZE != PROTOCOLIZE   protocolization establishes the governed
                               identity/authority/evidence context;
                               collateralization presupposes it
```

Recorded as data in `ENTERPRISE_ACTIONS_DISTINCT_FROM_COLLATERALIZE` and
enforced structurally: `validateEnterpriseCollateralizationRequest` rejects
any request whose `capability` is not exactly `'collateralize'`.

## Four identities, never conflated

```
requestedBy           who asks
securedPartyRef       who benefits     (the lender / collateral taker)
executorRef           who may perform  (the external platform / agent)
securedObligationRef  what is secured  (not a party at all)
```

`enterpriseCollateralizationMandateAuthorizes` refuses a substitution of any of
the three references with its own refusal code, checked before any quantity
check, so a substitution attempt is reported as a substitution.

## Scope

```ts
{ kind: 'proportional', basisPoints: 2000 }                            // 20%
{ kind: 'unitized', units: 500, unitDenomination: 'entitlement-unit' } // 500 units
```

Integer basis points, never floating point — `0.1 + 0.2 !== 0.3`, and an
economically significant share must compare **and sum** exactly. Proportional
and unitized scopes are never comparable to one another, and unitized scopes
must agree on denomination.

**Collateral scope accumulates.** This is the one quantity rule with no
tokenization analogue: two commitments of 15% each commit 30% of the named
rights, so an authorization for 20% refuses the second even though 15% is, on
its own, inside 20%. `enterpriseCollateralizationScopeSum` returns `null` for
incommensurable scopes and callers surface that as a refusal, never as zero.

## Multiple interests are not prohibited

Nothing in this package assumes an asset may carry only one collateral
interest, that an existing interest blocks another, or that collateral is
transferable. Collateral arrangements differ by jurisdiction and structure.

Exclusivity, priority/ranking and aggregate limits are expressed as
**constraints** on an authorization (`exclusive`, `requiredPriorityRank`,
`maximumSecuredAmount`) and evaluated as policy — never as universal legal
assumptions this contract makes on anyone's behalf.

`requiredPriorityRank` records a requirement placed on an external system and
is compared against what that system *reports*. It is not a claim that Soberanía
determined, perfected, or can enforce priority anywhere.

## Revocation is not release

```
revocation of authority to perform further collateralization   ← what Soberanía can do
external treatment of a security interest already created      ← not Soberanía's to claim
```

Revoking a mandate blocks new external collateralization from that moment. It
does **not** release, discharge, terminate, or invalidate a security interest
an external system already created, and Soberanía does not pretend otherwise.
Execution evidence recorded before revocation is preserved immutably, and the
revocation record preserves both the execution count and the committed scope at
the moment authority was withdrawn.

## Release and discharge

An externally-created collateral interest may later be released, discharged,
satisfied, or terminated. `EnterpriseCollateralizationReleaseEvidence` records
that an external system **reported** one of those, and is deliberately:

- **not** a governed action. No `RELEASE_COLLATERAL` exists. No authority is
  evaluated, no decision is produced, nothing is authorized. If releasing
  collateral ever needs to be *authorized* by Soberanía rather than merely
  *observed*, that is a separate governed action with its own request,
  decision and mandate.
- **not** a mandate status. `EnterpriseCollateralizationMandateStatus` is
  `'active' | 'revoked'` and nothing else.
- **not** a restoration of headroom. Recording a release does not decrement
  committed scope: Soberanía cannot verify that the external encumbrance ended and
  must not manufacture fresh collateralization capacity from an unverified
  report.

## Duplication with TOKENIZE, and why it is not yet extracted

The scope union, the right-type vocabulary, the executor binding and the
mandate reference skeleton are structurally near-identical to
`@aoc-enterprise/tokenization-mandate`, and for scope and rights the
*semantics* match too. They are duplicated here rather than shared, on
purpose:

- `@aoc-enterprise/tokenization-mandate` is a frozen contract line. Extracting
  from it means a new package plus rewiring its four modules, its build graph
  and its publishability surface — not a small, localized change.
- The overlap is real but partial. Constraints share exactly one field
  (`permittedJurisdictions`); exhaustion is a unit *ceiling* for tokenization
  and a cumulative *scope sum* here; execution evidence payloads share nothing
  beyond executor and timing.

The duplication is recorded, measured and re-evaluated in
`docs/enterprise/AOC_COLLATERALIZE_ACTION.md`, "TOKENIZE vs COLLATERALIZE".
A third enforcement is the right moment to decide, not this one.

## Ownership

Frontera Systems. Depends only on `@aoc/protocol` (types) and
`@aoc-enterprise/resource-envelope` (`resourceRefIdentityEquals`).
