# Runtime Semantic Governance

## Overview

Semantic governance is the discipline of ensuring that the language used across runtime, SDK, API, and protocol layers remains consistent, deterministic, and auditable.

In Frontera Systems, semantic governance is enforced through:

1. A canonical contracts package as the single definition source
2. CI scripts that detect drift at commit time
3. Typed discriminated unions that make invalid states unrepresentable
4. Explicit reason codes on all decision responses

## Governance Reason Codes

Every access decision, policy evaluation, treaty operation, and boundary check returns `reasonCodes`. These are no longer `string[]` — they map to types from the canonical package.

### Reason Code Domains

| Domain | Const Object | Union Type |
|--------|-------------|------------|
| Grant lifecycle | `GRANT_REASON_CODES` | `GrantReasonCode` |
| Delegation | `DELEGATION_REASON_CODES` | `DelegationReasonCode` |
| Claim verification | `CLAIM_REASON_CODES` | `ClaimReasonCode` |
| Governance policy | `GOVERNANCE_REASON_CODES` | `GovernanceReasonCode` |
| Audit delivery | `AUDIT_REASON_CODES` | `AuditReasonCode` |
| Org/tenant boundary | `BOUNDARY_REASON_CODES` | `BoundaryReasonCode` |
| Integration adapters | `INTEGRATION_REASON_CODES` | `IntegrationReasonCode` |
| Runtime internals | `RUNTIME_REASON_CODES` | `RuntimeReasonCode` |

The `CanonicalReasonCode` union covers all domains and is the authoritative type for any `reasonCodes` field.

## Policy Decision Semantics

Policy decisions use the `PolicyDecisionType` union:

- `allow` — request is permitted without further obligation
- `deny` — request is rejected; reasonCodes explain why
- `allow-with-obligations` — request is permitted subject to `CanonicalObligation[]`

Obligations are typed via `ObligationType`:

- `audit_enhanced` — additional audit depth required
- `human_review_required` — human must review before execution
- `rate_limited` — throttling applied
- `time_bounded` — access expires at a specific time
- `scope_restricted` — execution is limited to a reduced scope
- `notify_stakeholder` — stakeholders must be notified
- `dual_approval` — two-party approval required
- `sovereign_routing` — data must be routed through sovereign infrastructure

## Treaty Governance States

Governance treaties follow a deterministic state machine:

```
proposed → active ──┬──→ suspended → active
                    ├──→ expired
                    └──→ revoked
                    
active → disputed → resolved → (active | revoked)
```

All states are captured in `GovernanceTreatyStatus` from the canonical package.

## Risk Tier Classification

Agent risk tiers follow `RiskTier`:

- `low` — standard operational agents
- `medium` — agents with elevated data access
- `high` — agents with write capabilities or cross-boundary access
- `critical` — agents with sovereign or emergency authority

Risk tier determines which controls and obligations are automatically applied.

## Audit Delivery Policy

All audit sinks operate under an `AuditDeliveryPolicy`:

- `fail-open` — continue operation if audit delivery fails
- `fail-closed` — block operation if audit delivery fails
- `warn-only` — log warning but continue regardless

The policy is set per tenant isolation profile and cannot be downgraded without governance approval.

## Isolation Mode Governance

Tenant isolation modes (`IsolationMode`) determine data residency and key management:

- `logical` — shared infrastructure with logical separation
- `strong` — dedicated compute with tenant-controlled encryption
- `sovereign` — fully air-gapped with sovereign key roots

Isolation mode changes require a treaty amendment or governance escalation.
