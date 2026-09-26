# Canonical Runtime Contracts

## Purpose

`@aoc-enterprise/canonical-runtime-contracts` is the single semantic source of truth for all typed contracts across the Frontera Systems runtime ecosystem.

It eliminates semantic drift by ensuring that reason codes, governance decisions, event schemas, billing entitlements, feature gates, error taxonomy, and response envelopes are defined exactly once and consumed everywhere.

## Why This Exists

Without a canonical contracts layer, distributed systems accumulate:

- Inline string literals that diverge between packages over time
- Duplicate `interface` and `type` definitions that express the same concept differently
- Feature flag identifiers that exist in frontend, backend, and SDK with no shared source
- Billing entitlements that are hardcoded per-service rather than derived from a plan map
- Reason codes that vary spelling or casing between governance, audit, and SDK layers
- API response shapes that differ between routes

This package resolves all of these by being the **only** allowed definition point.

## Module Structure

```
src/
├── version.ts              — Contract version metadata and backward compatibility markers
├── reason-codes/           — Typed const objects for all runtime reason codes
│   ├── grant.ts            — Grant lifecycle (issued, validated, consumed, revoked, replayed)
│   ├── delegation.ts       — Delegated capability reason codes
│   ├── claim.ts            — Capability claim verification codes
│   ├── governance.ts       — Governance policy denial codes
│   ├── audit.ts            — Audit delivery codes
│   ├── boundary.ts         — Org/tenant/workspace boundary codes
│   ├── integration.ts      — Integration adapter registration codes
│   ├── runtime.ts          — Internal runtime error codes
│   └── index.ts            — CanonicalReasonCode union + ALL_REASON_CODES map
├── envelopes/              — Canonical response and decision envelopes
│   ├── decision.ts         — RuntimeDecisionEnvelope, PolicyEvaluationDecisionEnvelope, status enums
│   └── response.ts         — RuntimeApiResponse<T>, PaginatedResponse<T>, typed API shapes
├── events/                 — Canonical event schemas
│   ├── lifecycle.ts        — Grant/delegation/claim lifecycle audit events
│   ├── operational.ts      — Ingestion, escalation, memory, cognition, quota events
│   └── governance.ts       — Policy evaluation, treaty, negotiation, audit routing events
├── governance/             — Governance semantic contracts
│   ├── decisions.ts        — PolicyDecisionType, NegotiationStatus, RiskTier, AuditDeliveryPolicy
│   ├── obligations.ts      — ObligationType, CanonicalObligation
│   └── treaties.ts         — GovernanceTreatyType/Status, TreatyParticipantRole, amendment/dispute types
├── identity/               — Identity and trust domain contracts
│   └── trust.ts            — TrustLevel, TrustDegradationRisk, TrustCompatibilityDecision
├── entitlements/           — Feature gates and billing contracts
│   ├── feature-flags.ts    — FEATURE_FLAGS const, FeatureFlag type
│   ├── billing.ts          — BILLING_PLANS, QUOTA_IDENTIFIERS, PLAN_FEATURE_ENTITLEMENTS
│   └── quotas.ts           — QuotaLimit, QuotaUsage, QuotaEnforcement, UsageMeteringRecord
├── scoping/                — Workspace and isolation contracts
│   ├── isolation.ts        — IsolationMode, TenantIsolationProfile
│   └── workspace.ts        — WorkspaceResolutionContext, WorkspaceLineage, ProjectContinuityState
└── errors/                 — Typed error taxonomy
    ├── runtime.ts          — RuntimeErrorCode
    ├── governance.ts       — GovernanceErrorCode
    └── billing.ts          — BillingErrorCode
```

## Usage

Import from the canonical package, not from local type definitions:

```typescript
// CORRECT
import {
  GRANT_REASON_CODES,
  type GrantReasonCode,
  type RuntimeApiSuccessResponse,
  FEATURE_FLAGS,
  BILLING_PLANS,
  ISOLATION_MODES,
} from '@aoc-enterprise/canonical-runtime-contracts';

// WRONG — inline definition
const reasonCode = 'grant_expired'; // string drift risk
```

## Layering Rules

1. **Zero runtime logic** — this package contains only types, const objects, and interfaces. No functions, no classes, no I/O.
2. **Zero dependencies** — the package imports nothing from other `@aoc-enterprise/*` packages or external libraries.
3. **No circular imports** — other packages depend on this one; it depends on nothing.
4. **Frontend and backend safe** — all exports are pure TypeScript with no Node.js-specific APIs.
5. **Strictly typed** — no `any`, no loose `string` reason codes in response shapes.

## Canonical Reason Codes

All reason codes are defined as `as const` objects with derived union types:

```typescript
export const GRANT_REASON_CODES = {
  GRANT_EXPIRED: 'grant_expired',
  GRANT_REVOKED: 'grant_revoked',
  // ...
} as const;

export type GrantReasonCode = typeof GRANT_REASON_CODES[keyof typeof GRANT_REASON_CODES];
```

The `ALL_REASON_CODES` export merges all domain-specific maps into one lookup object. The `CanonicalReasonCode` union covers all valid codes system-wide.

## Feature Gates

Feature flags are defined once in `entitlements/feature-flags.ts` and plan entitlements are derived from them in `entitlements/billing.ts`. No service should hardcode feature flag string literals.

```typescript
import { FEATURE_FLAGS, PLAN_FEATURE_ENTITLEMENTS, BILLING_PLANS } from '@aoc-enterprise/canonical-runtime-contracts';

const enterpriseFeatures = PLAN_FEATURE_ENTITLEMENTS[BILLING_PLANS.ENTERPRISE];
```

## API Response Envelopes

All API responses must use the canonical success/error envelope:

```typescript
import type { RuntimeApiResponse } from '@aoc-enterprise/canonical-runtime-contracts';

function handleResponse<T>(res: RuntimeApiResponse<T>) {
  if (res.success) {
    // res.data is typed as T
  } else {
    // res.error.code and res.error.reasonCodes are typed
  }
}
```

## CI Enforcement

Three scripts enforce contract integrity:

- `scripts/check-runtime-contract-drift.mjs` — detects inline reason code literals that should be imported
- `scripts/check-duplicate-semantic-contracts.mjs` — detects duplicate type/interface/const definitions across packages
- `scripts/check-feature-flag-consistency.mjs` — detects inline feature flag string literals

These run as part of the `lint` pipeline in CI.
