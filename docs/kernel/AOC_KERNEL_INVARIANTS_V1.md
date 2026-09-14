# Soberanía Kernel Invariants v1

> **Scope.** This document is **Kernel-scoped**: it states what the decision engine guarantees, and nothing about
> execution paths, stores, provider adapters or containment. The canonical cross-cutting artifact — every security
> invariant with its scope, enforcement mechanism, evidence and boundary — is
> `docs/security/SECURITY_INVARIANTS.md`. These ten invariants appear there as SEC-INV-001 through SEC-INV-007 and
> their neighbours; neither document supersedes the other.

These invariants are documented only where the current implementation (as reconstructed in
`AOC_KERNEL_CURRENT_EXECUTION_MODEL.md`) actually enforces them. Where the runtime is ambiguous or only partially
enforces a candidate invariant, that is stated explicitly rather than silently redefining behavior. The kernel
(`src/kernel/orchestration/kernel-invariants.ts`) asserts the subset of these that are mechanically checkable at the
kernel boundary; the rest are structural properties of the wrapped engine and are verified by the characterization
test suite instead.

## Confirmed invariants

1. **No action may be allowed for an unrecognized actor.**
   `EnforcementDecisionService.mapRecognitionResult` default-denies any recognition result whose `type` is not in
   `RECOGNITION_TYPE_MAP` and is not explicitly `allowed`/`recognized`. `RecognizedActorPolicy` runs first in
   recognition-runtime's own chain. Confirmed by `src/features/action-enforcement/tests/recognition-runtime-integration.test.ts` case 5
   (`unrecognized_actor` -> `execution_blocked`, `execute()` never called).

2. **Recognition does not itself grant authority.**
   `RecognitionVerifier.verifyAction` calls `authorityGraph.verifyAuthority(...)` as a *separate* step after
   recognition's own chain passes, and an invalid authority result can still downgrade an otherwise-recognized
   decision. Confirmed by `src/features/action-enforcement/tests/recognition-runtime-integration.test.ts` case 9 (forged self-issued authority grant
   still blocks despite an existing capability token).

3. **Authority must be valid for the requested action and scope.**
   `AuthorityGraphRuntime.verifyAuthority` is called with the request's `action`/`resourceScope`; a mismatch
   produces a non-`valid` authority decision, which downgrades the enforcement outcome. Confirmed by
   `src/features/action-enforcement/tests/authority-graph-integration.test.ts`.

4. **Authority expiration is evaluated at decision time.**
   Recognition-runtime's `ValidCapabilityPolicy`/capability verification checks token expiry against `ctx.clock.now()`
   at the moment of the call, not at issuance time. Confirmed by `src/features/action-enforcement/tests/recognition-runtime-integration.test.ts`
   case 7 (`expired` capability token -> `expired` decision).

5. **Required approvals cannot be bypassed.**
   `ApprovalPendingPolicy` (action-enforcement chain) independently blocks whenever the mapped decision type is
   `approval_required`; `ApprovalPolicy`/`ApprovalRuntime` (recognition-runtime chain) independently governs whether
   a `require_human_approval` result can be upgraded to `allow`. Two independent layers must each agree before
   execution proceeds. Confirmed by `src/features/action-enforcement/tests/recognition-runtime-integration.test.ts` case 3.

6. **A denied policy cannot become allowed merely because another policy allows it, unless explicit precedence rules
   exist.** Both policy chains (`EnforcementPolicyEvaluator.evaluate`, recognition-runtime's `PolicyEvaluator`) are
   first-failure-wins over a fixed, ordered chain — there is no "any policy allows -> allow" logic anywhere. The
   one explicit precedence rule that does exist is documented in code
   (`action-enforcement/policies/index.ts:14-24`): a policy pack `allow` can only ever *preserve* an outcome every
   core Soberanía layer already reached independently; it can never *create* an allow a core layer denied.

7. **Required evidence must be present before a final allowed decision.**
   `EvidencePolicy` (recognition-runtime) and `EvidenceRequiredPolicy` (action-enforcement) both independently gate
   on this. Confirmed by `src/features/action-enforcement/tests/recognition-runtime-integration.test.ts` case 4 (missing invoice-support evidence ->
   `evidence_required`, `execute()` never called).

8. **Every terminal result must contain machine-readable reasons.**
   Every `EnforcementDecision` carries a non-optional `reasonCode: string` and `reason: string`
   (`domain/enforcement-decision.ts`). True for every decision type the engine can currently produce.

9. **Every evaluation must be traceable to the applicable runtime inputs.**
   `EnforcementDecision.policyResults` records every policy that ran, in order, with `passed`/`reasonCode`/`reason`/
   `severity`; `EnforcementLedger` and recognition-runtime's `EvidenceLedger` independently append audit events.
   Confirmed structurally in every test that inspects `decision.policyResults`.

10. **The same deterministic inputs must produce the same logical decision.**
    True given a deterministic `EnforcementRuntimeContext` (manual clock + sequential id generator) and unchanged
    upstream state (actors/tokens/grants/approvals) — both policy chains are pure functions of their `context`
    argument. This does **not** hold across two calls that mutate shared runtime state between them (e.g. an
    idempotency record from a prior call, or a token revoked in between) — that is expected, not a bug: the
    invariant is about the *same* kernel state, not call-count-independence.

## Documented ambiguities (not asserted as invariants)

- **`invalid_request` is a defined `EnforcementDecisionType` that no current policy ever produces.** The engine has
  no structural request-validation layer; a malformed request (e.g. empty `actorId`) is not rejected up front —
  it flows through and typically surfaces as an ordinary recognition denial (`unrecognized_actor` or similar). The
  kernel adds real request-shape validation at its own boundary (`KernelValidationError` /
  `status: 'denied'` with `REQUEST_INVALID`), but this is new behavior at the kernel edge, not a change to what the
  underlying engine does with a request that reaches it.
- **Recognition-integration exceptions are not caught today.** An uncaught throw from
  `EnforcementRecognitionIntegration.verifyAction` propagates out of `preflight()`/`enforce()` as a raw exception.
  The kernel treats this as `status: 'indeterminate'` with `KERNEL_INDETERMINATE` at its own boundary; the wrapped
  engine's behavior (propagating the throw) is unchanged.
- **Two separate audit trails, not one.** Recognition-runtime's `EvidenceLedger` and action-enforcement's
  `EnforcementLedger` are independent today. The kernel trace (`KernelTrace`) is a *new*, unified, read-only view
  built by reading both decisions' already-produced data — it does not merge or persist a new combined ledger.
- **The `EnforcementProof` hash chain is not the Soberanía Evidence Bundle.** It is a real, working hash-chained proof of
  each terminal decision, but has no export format, cross-runtime attestation, or durable persistence. The kernel
  does not claim otherwise.
