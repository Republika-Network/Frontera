# Soberanía PMFreak Agent Passport Demo Pack v1

Pack ID:

```
aoc.demo.pmfreak.agent_passport.v1
```

Purpose:

Demonstrates how PMFreak agents can operate with Frontera Systems passports.

This pack models PMFreak agents as governed actors with identity, passport status, authority scope, capability tokens, evidence requirements, approval requirements, policy decisions, Control Plane summaries and export metadata.

This pack does not integrate with PMFreak production.
This pack does not access real PMFreak data.
This pack does not modify real projects.
This pack does not send communications.
This pack does not create invoices.
This pack does not certify customer acceptance.
This pack does not provide legal advice.
This pack does not certify compliance.

## Core thesis

```
PMFreak agents should not act only because they are technically able to act.

They should act only when they have:
- recognized identity
- valid Frontera Systems passport
- role-specific authority scope
- active capability token
- sufficient evidence
- required approvals
- applicable policy-pack clearance
- safe claim framing
- audit/export trail
- non-revoked status
```

PMFreak demonstrates what autonomous project agents can do.
Frontera Systems demonstrates why those agents can be trusted to do it.

## Default status

```
Default status:       demo_baseline
Default sourceStatus: system_authored
```

## The six PMFreak demo agents

| Role | Can | Cannot |
| --- | --- | --- |
| **Planning Agent** | Detect schedule variance, propose replanning, draft schedule changes, create draft tasks. | Approve a contractual date change, notify the customer of a formal schedule change without approval, mark a project officially delayed without approval, change a billing milestone, override a customer-approved timeline. |
| **Risk Agent** | Detect risks, propose mitigation, request evidence, prepare escalation drafts. | Close a risk without PM approval, assign blame to the customer, claim a contractual breach, send an escalation externally without approval, use legal-sensitive wording. |
| **Evidence Agent** | Collect, classify, and check evidence completeness, prepare an evidence bundle. | Certify customer acceptance, mark a deliverable complete without approval, modify, delete, or fabricate evidence. |
| **Client Communication Agent** | Draft client emails, meeting minutes, status updates, follow-ups. | Send a communication without approval, make a contractual commitment, admit fault, claim completion without evidence, claim invoice readiness. |
| **Billing Readiness Agent** | Check milestone status, check evidence completeness and acceptance evidence, recommend billing readiness. | Mark invoice-ready without PM approval, override missing acceptance evidence, certify customer acceptance, create/send an invoice, release payment. |
| **Change Control Agent** | Classify a change request, draft an impact summary, recommend an approval path, request PM review. | Approve a change request, change contract terms, commit an external delivery date, alter billing terms, bypass customer validation. |

Each role is defined in `pmfreak-agent-roles.ts` as a `PMFreakAgentRoleProfile`; each demo agent's passport (`pmfreak-agent-passport-fixtures.ts`) derives its `allowedActionIds`/`restrictedActionIds` from that profile.

## Primary demo scenario: Billing Readiness Agent

The Billing Readiness Agent is the primary demo agent. It attempts to mark a project milestone as ready for billing (`pmfreak.action.billing.mark_ready`).

Frontera Systems checks:

- passport status (must be `active`, not `revoked`/`suspended`/`expired`/`draft`)
- role authority (the action must be in `allowedActionIds`, not in `restrictedActionIds`)
- capability token (the passport must hold a token for `pmfreak.capability.billing.mark_ready`)
- workspace/project/phase/customer scope (`PMFreakAuthorityScope`)
- required evidence (`deliverable_evidence`, `customer_acceptance_record`)
- required approvals (`pm_approval`, `billing_review`)
- billing/contract/legal sensitivity flags on the attempt's `context`
- applied policy packs and (opaque, typed-reference-only) jurisdiction packs
- audit/export requirements

A passport granting the Billing Readiness Agent authority to *attempt* this action never by itself marks a milestone billing-ready -- missing evidence or a missing approval always escalates the decision rather than silently allowing it. "Soberanía allows the agent to mark billing readiness in this demo" means exactly that; it never means the invoice is legally valid, that customer acceptance is certified, or that billing is guaranteed.

## Possible decisions

```
allow
hold
deny
require_evidence
require_pm_approval
require_customer_validation
require_contract_review
require_billing_review
require_legal_review
require_security_review
require_executive_approval
```

Passport status handling (documented, deterministic -- see `resolvePMFreakAgentPassportAction`):

```
missing passport -> deny
revoked          -> deny
expired          -> deny
draft            -> deny (not yet active)
suspended        -> hold
active           -> evaluated normally
```

## Architecture

```
Policy Pack Foundation
  |
Soberanía PMFreak Agent Passport Demo Pack v1  (this module)
```

This pack's manifest is a real `PolicyPackManifest`, built with the Policy Pack Foundation's `createPolicyPackManifest` -- it does not re-implement the manifest standard, the safe-framing shape, or the overclaim scanner. It re-scans every resolution, Control Plane summary, and export metadata record it produces with `assertNoPMFreakAgentPassportOverclaim` (which itself always runs the universal `assertNoPolicyPackOverclaim` first) as defense in depth.

| File | Provides |
| --- | --- |
| `pmfreak-agent-passport-constants.ts` | Pack id/name/version, system id, deterministic demo workspace/project/customer ids and timestamps |
| `pmfreak-agent-passport-types.ts` | Every domain type: roles, passport, authority scope, capability, action, evidence/approval requirements, resolver input/output, registry, Control Plane summary, export metadata |
| `pmfreak-agent-roles.ts` | The six `PMFreakAgentRoleProfile` definitions |
| `pmfreak-capability-catalog.ts` | The 14 `PMFreakCapability` definitions |
| `pmfreak-action-catalog.ts` | The 14 `PMFreakAgentAction` definitions, each naming its capability, required evidence/approval ids, and default restriction |
| `pmfreak-evidence-requirements.ts` | The 13 `PMFreakEvidenceRequirement` catalog entries |
| `pmfreak-approval-requirements.ts` | The 9 `PMFreakApprovalRequirement` catalog entries |
| `pmfreak-authority-scope.ts` | `createDefaultPMFreakAuthorityScope` and authority-scope membership checks |
| `pmfreak-agent-passport-manifest.ts` | `createPMFreakAgentPassportDemoPackManifest`, built via `createPolicyPackManifest` |
| `pmfreak-passport-registry.ts` | `createPMFreakAgentPassportRegistry` -- in-memory, no mutation, no network |
| `pmfreak-passport-resolver.ts` | `resolvePMFreakAgentPassportAction` -- the deterministic decision engine |
| `pmfreak-control-plane-summary.ts` | `createPMFreakAgentPassportControlPlaneSummary` and the pack's safe display labels |
| `pmfreak-export-metadata.ts` | `createPMFreakAgentPassportExportMetadata` |
| `pmfreak-claim-safety.ts` | PMFreak-specific unsafe-claim phrases, additive to (never replacing) the universal Policy Pack Foundation list |
| `pmfreak-agent-passport-fixtures.ts` | Deterministic demo passports (positive and negative) and action-attempt fixtures |

## What this pack is not

It is not a real PMFreak API integration, a real PMFreak authentication provider, a real PMFreak project sync, a real PMFreak database, or a production UI. It does not ingest real customer data, mutate a real task, schedule, or billing record, send a real email or Slack/Teams message, create a real invoice, approve a real contract, provide legal advice, or certify compliance. It performs no OAuth, no webhooks, no network calls, no LLM calls, no OCR, no PDF parsing, and no dynamic web lookup.

A passport granting a PMFreak agent authority to *attempt* an action never by itself authorizes *execution* of that action -- evidence and approval requirements still gate it, every time.

## Determinism

No network calls, no LLM calls, no OCR/PDF parsing, no `Math.random()`, no `Date.now()`/argless `new Date()`. Every fixture id and timestamp is a fixed literal. See `tests/pmfreak-agent-determinism.test.ts`.

## Future extension path

A future `Soberanía PMFreak Project Governance Scenario Pack v1` may compose this passport demo with project-specific scenarios: milestone acceptance, billing readiness, schedule change, risk escalation, client communication, and change control -- built on top of, not instead of, the passport/authority/capability/evidence/approval model this pack establishes.
