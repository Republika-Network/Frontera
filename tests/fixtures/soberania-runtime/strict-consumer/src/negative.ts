// Negative type controls (FRONTERA-SOBE-PILOT-01C0). Compiled with the same strict options as
// consumer.ts; every line marked `// expect-error` must produce a TypeScript error, and the test
// asserts the exact set of erroring lines. A contract that accepted any of these would not be a
// type-safe boundary.

import {
  AuthorizationRuntime,
  type AuthorizationDecisionFinalizer,
  type FederatedAuthorityVerifierPort,
  type FinalizableDecision,
} from '@aoc-runtime/authorization-runtime';
import { CapabilityRuntime } from '@aoc-runtime/capability-runtime';
import { ConsentRuntime } from '@aoc-runtime/consent-runtime';
import { GovernanceRuntime } from '@aoc-runtime/governance-runtime';

declare const governance: GovernanceRuntime;
declare const capability: CapabilityRuntime;
declare const consent: ConsentRuntime;

export const nonGeneric: AuthorizationDecisionFinalizer = { finalizeDecision: (d: FinalizableDecision): FinalizableDecision => d }; // expect-error
export const reshaping: AuthorizationDecisionFinalizer = { finalizeDecision: <T extends FinalizableDecision>(d: T) => ({ allowed: d.allowed }) }; // expect-error
export const misnamed: AuthorizationDecisionFinalizer = { finalize: <T extends FinalizableDecision>(d: T): T => d }; // expect-error
export const syncVerifier: FederatedAuthorityVerifierPort = { verify: () => ({ trusted: true, rejectedAuthorityPath: [], revokedIntermediaries: [] }) }; // expect-error
export const partialResult: FederatedAuthorityVerifierPort = { verify: async () => ({ trusted: true, rejectedAuthorityPath: [] }) }; // expect-error
export const noFinalizer = new AuthorizationRuntime(governance, capability, consent); // expect-error
export const wrongFinalizer = new AuthorizationRuntime(governance, capability, consent, {}); // expect-error
