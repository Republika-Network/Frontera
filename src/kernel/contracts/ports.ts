import type {
  GovernedAuthorityProviderPort,
  GovernedConstraintProviderPort,
  GovernedRepresentationProviderPort,
} from '@aoc-enterprise/governed-authority';

import type {
  EnforcementRecognitionIntegration,
  RecognitionVerificationInput,
  RecognitionVerificationResult,
} from '../../features/action-enforcement/domain/enforcement-context.js';
import type { EnforcementPolicyPackIntegration } from '../../features/action-enforcement/domain/policy-pack-enforcement.js';
import type { ContextResolverPort } from '../../features/context-resolution-runtime/index.js';
import type {
  EnforcementRuntimeClock,
  EnforcementRuntimeIdGenerator,
} from '../../features/action-enforcement/runtime/enforcement-runtime-context.js';

/**
 * Only ports that correspond to a *real, direct* dependency of the kernel's
 * own composition boundary are defined here. `AocKernel` composes exactly
 * one `ActionEnforcementRuntime`, which itself requires a recognition
 * integration and optionally a policy pack integration and a runtime
 * context (clock + id generator) -- those four are the kernel's real ports.
 *
 * `AuthorityProvider`, `ApprovalProvider`, and `EvidenceProvider` are
 * deliberately NOT introduced here: Authority Graph, Approval Runtime, and
 * evidence checking are reached transitively, *inside* whatever concrete
 * `RecognitionProvider` the kernel is given (see
 * `bridgeRecognitionRuntime` in action-enforcement's fixtures for the real
 * example) -- the kernel itself never calls them directly, so a port for
 * them at this boundary would be speculative. `KernelEventSink` is also
 * omitted: nothing in the wrapped engine emits to an external sink today: the
 * kernel returns a self-contained `KernelTrace` instead. See
 * `docs/kernel/AOC_KERNEL_INVARIANTS_V1.md`.
 */
export type RecognitionProvider = EnforcementRecognitionIntegration;
export type { RecognitionVerificationInput, RecognitionVerificationResult };

export type PolicyPackProvider = EnforcementPolicyPackIntegration;

export type KernelClock = EnforcementRuntimeClock;
export type KernelIdGenerator = EnforcementRuntimeIdGenerator;

/**
 * Optional governed-authority state provider: answers "does this holder
 * control this much of this right of this resource?" and nothing else.
 *
 * A real port rather than a speculative one, and the boundary is narrow on
 * purpose. It returns a `GovernedAuthorityCoverage` from
 * `@aoc-enterprise/governed-authority` -- a pure-data package -- so no store,
 * table, tenancy guard or digest concept crosses into the kernel's contracts.
 * `createGovernedAuthorityResolver`
 * (`src/enterprise/authority-governance/resolver.ts`) satisfies it
 * structurally.
 *
 * Optional in the same sense `PolicyPackProvider` is: omitted, kernel
 * behaviour is identical to this layer not existing, which is exactly what
 * every deployment that has not enrolled a resource in right-scoped authority
 * needs. Present, it can only ever *narrow* an outcome -- it never rescues a
 * denial and never grants anything, because it produces facts and `AocKernel`
 * produces decisions.
 */
export type GovernedAuthorityProvider = GovernedAuthorityProviderPort;

/**
 * Optional holder-bound representation provider: answers "may this requester
 * exercise that holder's governed authority?" and nothing else.
 *
 * A *second* narrow port rather than a widening of `GovernedAuthorityProvider`,
 * and the separation is the point. The two answer different questions, fail
 * for disjoint reasons, and are independently configurable; folding them would
 * force one coverage union to carry two verdicts and would make a denial
 * unable to say which of the two proofs was missing. Both return pure-data
 * types from `@aoc-enterprise/governed-authority`, so no store, table, tenancy
 * guard or digest concept crosses into the kernel's contracts.
 * `createGovernedRepresentationResolver`
 * (`src/enterprise/authority-governance/representation-resolver.ts`) satisfies
 * it structurally.
 *
 * Optional in exactly the sense its sibling is, and consulted only where the
 * governed-authority check found the resource *enrolled*: a deployment that
 * has recorded no authority state for a resource keeps its existing behaviour
 * unchanged, and one that has keeps it fail-closed. Present, it can only ever
 * narrow -- it never rescues a denial and never grants anything.
 */
export type GovernedRepresentationProvider = GovernedRepresentationProviderPort;

/**
 * Optional persistent-constraint fact provider: answers "what persistent
 * constraints stand over the authority this request engages, and which of them
 * bear on this action?" and nothing else.
 *
 * A *third* narrow port rather than a widening of either sibling, for the same
 * reason those two are separate from each other: it answers a different
 * question and fails for disjoint reasons. Its result is pure data from
 * `@aoc-enterprise/governed-authority`, so no store, table, tenancy guard or
 * digest concept crosses into the kernel's contracts.
 * `createGovernedConstraintResolver`
 * (`src/enterprise/authority-governance/constraint-resolver.ts`) satisfies it
 * structurally.
 *
 * Unlike its two siblings this port produces **no verdict at all**. It cannot
 * deny, cannot narrow and cannot rescue: its whole effect is that the typed
 * constraint facts reach the optional Domain Policy Pack preflight, so a
 * deployment that wants a cross-action compatibility rule can express one.
 * Omitted, or with no policy pack configured, kernel behaviour is byte-identical
 * to this layer not existing.
 *
 * The hard invariants do not depend on it. Capacity conservation and the
 * structural holder/constraint coverage rule are enforced afterwards, inside the
 * Governed Authority Store's own consistency boundary, against the state
 * committed there — so a policy that saw nothing, or a provider that failed, can
 * never widen what the authority layer allows.
 */
export type GovernedConstraintProvider = GovernedConstraintProviderPort;

/**
 * Optional trusted-context fact provider: answers "what is true right now
 * about the keys this deployment declared, and which configured source says
 * so?" and nothing else.
 *
 * A *fourth* narrow port rather than a widening of any sibling, for the reason
 * the other three are separate from each other: it answers a different
 * question and fails for disjoint reasons. Its result is pure data from
 * `src/features/context-resolution-runtime`, so no store, connector, HTTP
 * client or credential concept crosses into the kernel's contracts.
 * `createInMemoryContextResolver` satisfies it structurally, and so does any
 * deployment-supplied resolver over a real system of record.
 *
 * Like `GovernedConstraintProvider`, and unlike the two authority ports, this
 * one produces **no verdict at all**. Its return type carries observations and
 * nothing else — no allow, no deny, no narrow, no recommendation — which is
 * layer C's law in `ADR-AUTHORITY-CONTROL-LAYERING.md` expressed as a type
 * rather than as a comment: "the moment a context source can recommend, an ERP
 * outage becomes an authorization outcome decided by an ERP."
 *
 * What it *is* for is the defect `CURRENT_STATE_AUTHORITY_CONTROL.md` records
 * as GAP-1: today a rule reading `amount <= 10000` decides on a number the
 * caller put in the request body. Resolved facts arrive alongside that number,
 * under a namespace the caller cannot write to, so a deployment's rule can turn
 * on what a system of record says rather than on what the requester claims.
 *
 * Omitted — or configured with no declared requirements — kernel behaviour is
 * byte-identical to this layer not existing, and a characterization suite
 * (`src/kernel/__tests__/characterization/context-capability-absent.test.ts`)
 * pins that.
 */
export type ContextProvider = ContextResolverPort;
