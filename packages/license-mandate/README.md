# `@aoc-enterprise/license-mandate`

Enterprise-owned, provider-neutral, immutable contracts for the **`LICENSE`
governed action**: the request to grant a defined permission over specified
rights of a governed asset to a defined licensee, the durable `LicenseMandate`
that authorizes it, the evidence of the external license actually granted under
it, and the evidence of that license's reported expiry or termination.

- Action documentation: `docs/enterprise/AOC_LICENSE_ACTION.md`
- Decision record: `docs/architecture/ADR-LICENSE-ACTION.md`
- Three-enforcement audit: `docs/architecture/ADR-ENTERPRISE-ENFORCEMENT-VOCABULARY.md`
- Runtime: `src/enterprise/license-governance/`

This is a **pure data contract**: no persistence, no service, no API, no policy
engine, no provider SDK, no execution.

## What `LICENSE` means

> Authorize the grant of a defined permission to a defined licensee to exercise
> specified governed rights associated with an already-governed asset, for
> specified uses, within a specified operating context, under defined
> governance conditions.

## What is deliberately not here

No contract drafting. No signature capture. No royalty, payment, billing,
settlement, pricing, valuation or tax calculation. No usage metering. No DRM or
content delivery. No marketplace, catalogue or license discovery. No copyright,
patent or trademark registry. No jurisdiction-specific legal policy. No KYC,
AML, wallet, blockchain or smart-contract integration. No provider adapter.

Every `external*` field and every value in `permittedContexts` is an opaque,
provider-neutral label Soberanía records and compares as a string and never
interprets, resolves, or executes against.

## Authorization is not legal validity

This package lets Frontera Systems say exactly one kind of thing: *this authority
graph, policy state, approval state and obligation set permitted Actor A to
grant License L to Licensee B under Terms T.*

It never says the license is legally enforceable, that formalities were
satisfied, that consideration passed, that royalties or tax were settled, that
copyright subsists, that a patent is valid, that a trademark is registered, that
the right is legally licensable, or that any contract was signed.

**A `LicenseMandate` is not a claim that a license exists.** Until execution
evidence is recorded, Soberanía's position is that it authorized the grant and does
not know whether the grant was made.

## Actions this package deliberately does not introduce

`SUBLICENSE`, `ASSIGN_LICENSE` and `TERMINATE_LICENSE` are recorded in
`ENTERPRISE_ACTIONS_DISTINCT_FROM_LICENSE` as *different* actions, and none is
implemented. Sublicensing and assignment are represented only as declared
constraints on this authorization. Should any of them ever need to be
*authorized* by Soberanía rather than merely declared or observed, each is a separate
governed action with its own request, decision and mandate.

## Two kinds of scope

A license has two independent notions of scope, and conflating them is the
mistake this contract is shaped to prevent:

```
rights scope      25% of a divisible revenue right      → rightsScope (OPTIONAL)
permission scope  display only · web channel · 12 months → permittedUses ·
                  · non-exclusive · 10 seats               permittedContexts ·
                                                           exclusivity ·
                                                           maximumLicenseTermEndsAt ·
                                                           maximumLicensedUnits
```

`rightsScope` is **optional**, and absence means *"not expressed as a portion of
the named rights"* — **never** "100%". A permission can be completely specified
without any fraction in it. The two are incommensurable and every comparison
fails closed rather than coercing.

## The executor is optional

`TOKENIZE` and `COLLATERALIZE` require an executor because someone must mint the
token or create the security interest. Licensing does not: a licensor may grant
directly. `executorRef` binds strictly when present and constrains nothing when
absent — requiring one would force every direct license to invent a party, and
an invented binding protects nothing.

## Multiple licenses are not prohibited

Nothing in this package concludes that an asset may carry only one license, or
that an exclusive license blocks any other. Many non-exclusive licenses may
coexist. `exclusivity` is a declaration Soberanía records and compares, never a rule
Soberanía enforces against the world. Whether a prior exclusive grant should block a
new request is a **policy** question — the full serialized terms travel to the
Kernel, so policy can inspect prior mandates and evidence and deny an
incompatible request.

## Revocation is not termination

Revoking a `LicenseMandate` withdraws authority to grant *further* licenses. It
makes no claim that a license already granted ceased to exist — Soberanía governs
authority and is not a party to the agreement.

An externally-reported end (`expired`, `terminated`, `cancelled`,
`surrendered`, `superseded`) is recorded as `EnterpriseLicenseLifecycleEvidence`
— append-only observation, never a mandate status, never a governed action, and
never a restoration of licensing capacity Soberanía cannot verify was freed.

## Duplication with TOKENIZE and COLLATERALIZE, and why it is not yet extracted

`ENTERPRISE_LICENSABLE_RIGHT_TYPES` coincides exactly with
`ENTERPRISE_TOKENIZED_RIGHT_TYPES` and
`ENTERPRISE_COLLATERALIZABLE_RIGHT_TYPES`; the rights-scope union and the
mandate reference skeleton are likewise identical across all three packages.

That is a deliberate, recorded duplication rather than a shared import. The
three-enforcement audit
(`docs/architecture/ADR-ENTERPRISE-ENFORCEMENT-VOCABULARY.md`) confirms the
semantics are genuinely identical and classifies them **GENERIC SEMANTIC
PROVEN, EXTRACTION DEFERRED FOR COMPATIBILITY**: extraction would require a new
dependency edge into two already-frozen contract packages for a purely
declarative benefit, and the ADR records the concrete migration path for when
that cost becomes worth paying.
