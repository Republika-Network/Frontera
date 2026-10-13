# ADR: One canonical payment-rail conformance suite, run inside one shared governed world, over a measured byte-identical CORE — rail specifics only at the edge (PAY-07)

- Status: accepted
- Phase: PAY-07 — Multi-Rail Qualification (§11.2 CORE PROVEN)
- Status of implementation: test-only qualification code in
  `src/features/payment-runtime/tests/conformance/` (the suite) and
  `src/enterprise/__tests__/pay07-*.ts` (the CORE manifest, the shared world,
  the XRPL and Lightning edges, the qualification and structural tests). No
  production code, generic contract or effect path changed.
- Depends on: `ADR-PROVIDER-CONFORMANCE-SUITE.md` (the pattern — its strengths,
  not its API), `ADR-PAYMENTS-AS-A-GOVERNED-VERTICAL.md` (PAY-01),
  `ADR-XRPL-PRODUCTION-COMPOSITION.md` (PAY-03), `ADR-LIGHTNING-RAIL.md` (PAY-06),
  `ADR-PAYMENT-SETTLEMENT-RECEIPTS-AND-OBLIGATIONS.md` (PAY-05),
  `ADR-PAYMENT-PROTOCOL-ADAPTER-BOUNDARY.md` (PAY-04), ASSURE-01.
- Canonical documentation: `docs/payments/PAY-07-MULTI-RAIL-QUALIFICATION.md`.

## Context

§11.2 asks for more than "both rails pass their tests": one representative flow
from the protocol requirement to evidence on both rails, CORE byte-identical
between the runs, P12 reconciliation, a verifying ASSURE-01 trace, and three
negative governance cases behaving identically. Two rail-specific test files
asserting "the same things" would prove none of that: their assertions could
drift, a rail could skip a case, and nothing would show the CORE was the same.

`provider-conformance-suite` gives the right shape — a canonical suite, an
implementation-neutral harness, adapter factories outside the suite, a closed
result vocabulary — but qualifies an adapter's translation. A payment rail is
qualified only together with the governance it sits inside.

## Decision

1. **One suite.** `runPaymentRailConformanceSuite(harness)` holds every
   assertion and a closed, versioned case list (`frontera.payment-rail-conformance.v1`,
   MRC-01 … MRC-16). It imports nothing, names no rail, and never branches on
   the opaque `implementationId`. A new rail is qualified by running this suite,
   never by writing its own.
2. **Observations in, verdicts out.** The harness returns what happened (governed
   answers, provider-boundary effect counts, rail-port instructions, P11, P12,
   PAY-05 and ASSURE-01 answers); it never returns a verdict. One harness shape
   for every rail — no discriminated union.
3. **One shared governed world.** `createGovernedPaymentHarness(edge, digest)`
   composes the real governance stack, the PAY-04 MPP ingress, P11, P12, PAY-05
   and the ASSURE-01 builder and verifier identically for every rail, reaching
   the rail only through PAY-01's bridge. It imports no rail.
4. **Rail specifics only in an edge.** A `PaymentRailEdge` supplies the rail, its
   provider simulator, durable interlock, read-only P12 and finality authorities,
   trusted MPP normalizer and counterparty directory — and generic capabilities
   (`behave`, `effects`, `resolveExternally`, `restart`, `rollback`).
5. **Measured CORE identity.** A reviewed root list defines the CORE; each run
   computes the manifest digest (SHA-256 over LF-normalized bytes, canonical
   text) of the tree it executes and embeds it in its report. Parity requires
   equal digests. The manifest must cover the shared path's runtime import
   closure, and every directory beside a root must be classified.
6. **Parity is a comparison of reports**, case by case: verdict, external-effect
   count and generic lifecycle signature; implementation ids are the only
   permitted difference, because rail-specific evidence never enters a report.
7. **Qualification findings are classified, not fixed in passing.** A generic
   change is a possible architecture defect; PAY-07 found no XRPL-shaped field in
   any generic port and one XRPL-named CORE-07 slot identifier, which is pinned
   and documented as a residual rather than renamed (a persisted-state migration).

## Consequences

- PAY-08 (x402) is a protocol, not a rail: it enters at the PAY-04 boundary and
  can reuse the shared world unchanged. A future rail (PAY-09) must pass this
  suite; adding a case bumps the suite version for every rail at once.
- The suite is test code under `tests/`; it ships in `dist` like every other
  in-repository test fixture, is exported from no entry point, and no production
  source may import it (structurally pinned).
- CORE PROVEN is scoped to XRPL / RLUSD and Lightning / BTC under the qualified,
  deterministic flows; live-rail evidence remains PAY-03's Testnet and PAY-06's
  regtest qualification.
