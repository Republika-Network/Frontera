// Strict TypeScript consumption of the installed Soberanía runtime closure (FRONTERA-SOBE-PILOT-01C0).
//
// tests/soberania-runtime-consumption.test.mjs copies this directory into a temporary directory whose
// node_modules holds only the lock-verified artifacts and the installed @aoc/protocol, compiles it
// with strict, skipLibCheck: false, exactOptionalPropertyTypes and noUncheckedIndexedAccess, and runs
// the emitted JavaScript. No path alias, ambient module declaration or type assertion is used: every
// type below comes from the installed packages' own declarations.
//
// Every decision is made by the real AuthorizationRuntime, GovernanceRuntime, CapabilityRuntime and
// ConsentRuntime, with grants signed by the real crypto package. Providers are in-memory stand-ins
// for a deployment's records; keys are generated for this run only.

import {
  AuthorizationRuntime,
  type AuthorizationDecisionFinalizer,
  type AuthorizationInput,
  type FinalizableDecision,
} from '@aoc-runtime/authorization-runtime';
import { CapabilityRuntime, type CapabilityEvaluationInput } from '@aoc-runtime/capability-runtime';
import { ConsentRuntime } from '@aoc-runtime/consent-runtime';
import { GovernanceRuntime } from '@aoc-runtime/governance-runtime';
import { createRuntimeAuthority, createTrustedKeySet } from '@aoc-runtime/crypto';
import type { CapabilityProvider, ConsentProvider, PolicyProvider } from '@aoc-runtime/provider-interfaces';
import type { CapabilityRef, ConsentGrant, GovernancePolicy, SignedConsentGrant } from '@aoc-runtime/shared-types';

/**
 * TEST FIXTURE ONLY — NOT A PRODUCTION AUDIT FINALIZER.
 *
 * It returns each decision unchanged: it signs nothing, records nothing and produces no audit
 * evidence. It exists to prove that a Frontera-owned object satisfies the finalizer contract without
 * the excluded @aoc/enterprise AuditRuntime. A production composition must supply a finalizer that
 * actually records signed evidence; that is FRONTERA-SOBE-PILOT-01C1 scope, not this fixture.
 */
export const NON_PRODUCTION_PASS_THROUGH_FINALIZER: AuthorizationDecisionFinalizer = Object.freeze({
  finalizeDecision<T extends FinalizableDecision>(decision: T): T {
    return decision;
  },
});

const NOW = '2026-06-01T12:00:00.000Z';
const ISSUED = '2026-05-01T00:00:00.000Z';
const FUTURE = '2026-12-31T00:00:00.000Z';
const PAST = '2026-05-15T00:00:00.000Z';
const ORG = 'org:frontera-pilot';
const OWNER = 'actor:alice';
const AGENT = 'actor:agent-1';
const MALLORY = 'actor:mallory';
const SCOPE_ID = 'scope:frontera-pilot/records';
const ACTION = 'records.export';
const RESOURCE = 'records';
const OWNER_PATH = '/orgs/frontera-pilot/records/alice';

const owner = createRuntimeAuthority('runtime:pilot-owner', OWNER);
const agent = createRuntimeAuthority('runtime:pilot-agent', AGENT);
const mallory = createRuntimeAuthority('runtime:pilot-mallory', MALLORY);
const trustedKeys = createTrustedKeySet([owner.identity, agent.identity, mallory.identity]);
type Authority = typeof owner;

// CapabilityRef declares no expiry, but CapabilityRuntime honours `expiresAt`; a provider may return
// the wider shape because it is assignable to CapabilityRef.
type ExpiringCapability = CapabilityRef & { expiresAt?: string };
const capability = (expiresAt?: string): ExpiringCapability => ({
  capabilityId: 'cap:records-export',
  action: ACTION,
  resource: RESOURCE,
  scope: { organizationId: ORG, path: OWNER_PATH },
  ...(expiresAt === undefined ? {} : { expiresAt }),
});
const grantOf = (overrides: Partial<ConsentGrant> = {}): ConsentGrant => ({
  grantId: 'grant:alice-to-agent',
  subjectActorId: OWNER,
  delegateActorId: AGENT,
  capability: capability(),
  issuedAt: ISSUED,
  expiresAt: FUTURE,
  ...overrides,
});

const signer = new ConsentRuntime({ getActiveGrants: async () => [] }, { trustedKeys, resourceOwnership: { ownerOf: async () => OWNER } });
const sign = (grant: ConsentGrant, subjectKey: Authority = owner, delegateKey: Authority | null = agent): SignedConsentGrant<ConsentGrant> => {
  const signed = signer.signGrant(grant, subjectKey.privateKey, subjectKey.identity, 'frontera-pilot-01c0');
  return grant.delegateActorId !== undefined && delegateKey !== null
    ? signer.signDelegation(signed, delegateKey.privateKey, delegateKey.identity, 'frontera-pilot-01c0')
    : signed;
};

const allowPolicy: GovernancePolicy = { policyId: 'policy:records-export', version: '1', scopeId: SCOPE_ID, rules: [{ condition: `action:${ACTION}`, effect: 'allow' }], updatedAt: ISSUED };
const denyPolicy: GovernancePolicy = { ...allowPolicy, policyId: 'policy:deny', rules: [{ condition: `action:${ACTION}`, effect: 'deny' }] };

interface RuntimeOptions {
  readonly policies?: GovernancePolicy[];
  readonly policyProvider?: PolicyProvider;
  readonly capabilities?: ExpiringCapability[];
  readonly capabilityProvider?: CapabilityProvider;
  readonly grants?: SignedConsentGrant<ConsentGrant>[];
  readonly consentProvider?: ConsentProvider;
}

function runtime(options: RuntimeOptions = {}): AuthorizationRuntime {
  const policies = options.policies ?? [allowPolicy];
  const capabilities = options.capabilities ?? [capability()];
  const grants = options.grants ?? [sign(grantOf())];
  return new AuthorizationRuntime(
    new GovernanceRuntime(options.policyProvider ?? { getPolicies: async (scopeId) => (scopeId === SCOPE_ID ? policies : []) }),
    new CapabilityRuntime(options.capabilityProvider ?? { resolve: async (actor) => (actor.actorId === AGENT ? capabilities : []) }),
    new ConsentRuntime(options.consentProvider ?? { getActiveGrants: async () => grants }, { trustedKeys, resourceOwnership: { ownerOf: async () => OWNER } }),
    NON_PRODUCTION_PASS_THROUGH_FINALIZER,
  );
}

// One trusted server clock, passed as both `at` (consent) and `now` (capability). AuthorizationInput
// does not declare `now`, although CapabilityRuntime reads it from the same object; the intersection
// states that honestly instead of letting the capability stage fall back to the wall clock.
type ClockedInput = AuthorizationInput & Required<Pick<CapabilityEvaluationInput, 'now'>>;
const input: ClockedInput = {
  actor: { actorId: AGENT, actorType: 'service', organizationId: ORG },
  namespace: { organizationId: ORG, path: `${OWNER_PATH}/2026` },
  scope: { scopeId: SCOPE_ID, namespace: { organizationId: ORG, path: OWNER_PATH }, allowedActorTypes: ['service'] },
  action: ACTION,
  resource: RESOURCE,
  at: NOW,
  now: NOW,
};

export interface CaseOutcome {
  readonly outcome: 'decided' | 'rejected' | 'refused';
  readonly allowed: boolean;
  readonly decision: string | null;
  readonly failedStage: string | null;
  readonly error: string | null;
}

async function outcome(build: () => AuthorizationRuntime, request: ClockedInput = input): Promise<CaseOutcome> {
  let rt: AuthorizationRuntime;
  try {
    rt = build();
  } catch (error) {
    return { outcome: 'refused', allowed: false, decision: null, failedStage: null, error: error instanceof Error ? error.message : String(error) };
  }
  try {
    const decision = await rt.evaluate(request);
    return { outcome: 'decided', allowed: decision.allowed, decision: decision.decision, failedStage: decision.failedStage ?? null, error: null };
  } catch (error) {
    return { outcome: 'rejected', allowed: false, decision: null, failedStage: null, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function runCases(): Promise<Record<string, CaseOutcome>> {
  const fail = async (): Promise<never> => {
    throw new Error('provider unavailable');
  };
  return {
    'allow: valid capability, owner-signed delegated consent, allow policy': await outcome(() => runtime()),
    'deny: consent signed with another trusted key': await outcome(() => runtime({ grants: [sign(grantOf(), mallory)] })),
    'deny: delegated consent without the delegate countersignature': await outcome(() => runtime({ grants: [sign(grantOf(), owner, null)] })),
    'deny: no consent': await outcome(() => runtime({ grants: [] })),
    'deny: expired consent': await outcome(() => runtime({ grants: [sign(grantOf({ expiresAt: PAST }))] })),
    'deny: revoked consent': await outcome(() => runtime({ grants: [sign(grantOf({ revokedAt: PAST }))] })),
    'deny: no capability for the actor': await outcome(() => runtime({ capabilities: [] })),
    'deny: expired capability': await outcome(() => runtime({ capabilities: [capability(PAST)] })),
    'deny: no governance rule matches': await outcome(() => runtime({ policies: [] })),
    'deny: governance deny rule': await outcome(() => runtime({ policies: [allowPolicy, denyPolicy] })),
    'deny: malformed evaluation time': await outcome(() => runtime(), { ...input, now: '2026-06-01 12:00' }),
    'deny: consent runtime configured with an empty trusted key set': await outcome(
      () =>
        new AuthorizationRuntime(
          new GovernanceRuntime({ getPolicies: async () => [allowPolicy] }),
          new CapabilityRuntime({ resolve: async () => [capability()] }),
          new ConsentRuntime({ getActiveGrants: async () => [sign(grantOf())] }, { trustedKeys: createTrustedKeySet([]), resourceOwnership: { ownerOf: async () => OWNER } }),
          NON_PRODUCTION_PASS_THROUGH_FINALIZER,
        ),
    ),
    'rejected: policy provider throws': await outcome(() => runtime({ policyProvider: { getPolicies: fail } })),
    'rejected: capability provider throws': await outcome(() => runtime({ capabilityProvider: { resolve: fail } })),
    'rejected: consent provider throws': await outcome(() => runtime({ consentProvider: { getActiveGrants: fail } })),
  };
}
