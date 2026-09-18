# FR-REC-01 — Capital Discovery authorization request boundary

This additive integration builds Frontera's canonical `KernelEvaluationRequest` from Capital Discovery identifiers and actor intent. Frontera owns governance and returns `KernelEvaluationResult`; Capital Discovery owns matching, marketplace state, object ownership checks, and business execution. An `allowed` result alone proves none of those Capital Discovery facts.

## Frozen resource and action contract

| Action | Capital Discovery ref | Protocol `ResourceRef.kind` |
| --- | --- | --- |
| `capital.opportunity.view` | `OpportunityProjectionRef` | `capital-discovery-opportunity-projection` |
| `capital.quote.submit` | `OpportunityProjectionRef` | `capital-discovery-opportunity-projection` |
| `capital.offer.accept` | `QuoteRef` | `capital-discovery-quote` |
| `capital.quote.withdraw` | `QuoteRef` | `capital-discovery-quote` |
| `capital.financing.execute` | `FinancingCaseRef` | `capital-discovery-financing-case` |

`ResourceRef.id` preserves the validated opaque ref exactly. `resourceScope` uses Frontera's existing `kind:id` convention via `legacyResourceIdentifier`. These namespace-qualified kind strings are explicit authorization-contract semantics, frozen for this integration rather than inferred from a ref prefix. `ResourceRef.tenantId` and `ResourceRef.attributes` are absent. Organization identity does not establish resource tenancy or ownership, and marketplace facts do not belong on the resource identity.

External resource refs are bounded opaque strings without `:`; the delimiter is reserved because Frontera matches resource scopes by exact value or colon-separated child prefix. The builder validates real calendar dates in ISO-8601 timestamps with optional fractional seconds and numeric offsets, and preserves valid input strings exactly.

The builder accepts only bounded identifiers, the frozen action/ref discriminants, and a caller-supplied timestamp. It rejects unknown fields, actions, resource types, and mismatched pairs. It supplies no capability, policy facts, governed rights, target type, context, or action parameters. It has no side effects. The existing kernel result and reason/evidence vocabulary remain unchanged.

When supplied, `actorOrgRef` becomes `KernelEvaluationRequest.organization.id`. It is a caller-provided identifier, not proof of membership or resource ownership. Frontera's request adapter reserves its metadata location; Capital Discovery must still verify actor organization, resource ownership, projection currentness, quote state, and all business invariants server-side immediately before its transaction.

FR-REC-02 will separately introduce a trusted server-side `CapitalDiscoveryContextProvider`. This slice registers no context sources or requirements and makes no requester business value trusted. It creates no quote or FinancingCase, mutates no Opportunity, performs no matching, and executes no external financial action. A future Capital Discovery adapter can pass the built request to Frontera's existing evaluation path and consume its canonical result without translating decision semantics.

FR-REC-01 establishes an internal Frontera contract-first integration boundary; it is not yet a published cross-repository package entry point. A future host/API or explicitly approved public adapter may expose it.
