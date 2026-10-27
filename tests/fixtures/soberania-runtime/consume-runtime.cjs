'use strict';
// Plain-Node consumption scenario for the vendored Soberanía runtime (FRONTERA-SOBE-PILOT-01A).
//
// tests/soberania-runtime-consumption.test.mjs copies this file into a temporary directory whose
// node_modules holds only the extracted, lock-verified artifacts and the installed @aoc/protocol,
// then runs it with `node` from there: no TypeScript, no path aliases, no workspace, no Soberanía
// source. Every decision below is made by the real AuthorizationRuntime, GovernanceRuntime,
// CapabilityRuntime and ConsentRuntime. The providers are disposable in-memory stand-ins for a
// deployment's records, and the keys are generated for this run only.
//
// The one non-Soberanía piece is the audit finalizer: AuthorizationRuntime requires an object
// with finalizeDecision(), which in Soberanía lives in the excluded @aoc/enterprise. It is called
// only after every allow/deny has been decided and only annotates provenance, so a pass-through
// stands in for it here. It decides nothing.
//
// Prints one JSON object: { cases: { <name>: outcome }, loaded: [module files] }.

const { AuthorizationRuntime } = require('@aoc-runtime/authorization-runtime');
const { GovernanceRuntime } = require('@aoc-runtime/governance-runtime');
const { CapabilityRuntime } = require('@aoc-runtime/capability-runtime');
const { ConsentRuntime } = require('@aoc-runtime/consent-runtime');
const crypto = require('@aoc-runtime/crypto');

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

const owner = crypto.createRuntimeAuthority('runtime:pilot-owner', OWNER);
const agent = crypto.createRuntimeAuthority('runtime:pilot-agent', AGENT);
const mallory = crypto.createRuntimeAuthority('runtime:pilot-mallory', MALLORY);
const trustedKeys = crypto.createTrustedKeySet([owner.identity, agent.identity, mallory.identity]);

const capability = (overrides = {}) => ({
  capabilityId: 'cap:records-export', action: ACTION, resource: RESOURCE,
  scope: { organizationId: ORG, path: OWNER_PATH }, ...overrides,
});
const grantOf = (overrides = {}) => ({
  grantId: 'grant:alice-to-agent', subjectActorId: OWNER, delegateActorId: AGENT,
  capability: capability(), issuedAt: ISSUED, expiresAt: FUTURE, ...overrides,
});

// Grants are signed with ConsentRuntime's own signGrant/signDelegation.
const signer = new ConsentRuntime({ getActiveGrants: async () => [] }, { trustedKeys, resourceOwnership: { ownerOf: async () => OWNER } });
const sign = (grant, subjectKey = owner, delegateKey = agent) => {
  const signed = signer.signGrant(grant, subjectKey.privateKey, subjectKey.identity, 'frontera-pilot-01a');
  return grant.delegateActorId && delegateKey ? signer.signDelegation(signed, delegateKey.privateKey, delegateKey.identity, 'frontera-pilot-01a') : signed;
};

const allowPolicy = { policyId: 'policy:records-export', version: '1', scopeId: SCOPE_ID, rules: [{ condition: `action:${ACTION}`, effect: 'allow' }], updatedAt: ISSUED };
const passThroughAudit = { finalizeDecision: (decision) => decision };

function runtime({
  policies = [allowPolicy], policyProvider,
  capabilities = [capability()], capabilityProvider,
  grants = [sign(grantOf())], consentProvider,
  ownerOf = async () => OWNER,
} = {}) {
  return new AuthorizationRuntime(
    new GovernanceRuntime(policyProvider ?? { getPolicies: async (scopeId) => (scopeId === SCOPE_ID ? policies : []) }),
    // The capability provider answers for the authenticated actor only.
    new CapabilityRuntime(capabilityProvider ?? { resolve: async (actor) => (actor.actorId === AGENT ? capabilities : []) }),
    new ConsentRuntime(consentProvider ?? { getActiveGrants: async () => grants }, { trustedKeys, resourceOwnership: { ownerOf } }),
    passThroughAudit,
  );
}

// Server-derived input: one trusted clock passed as both `at` (consent) and `now` (capability).
const input = (overrides = {}) => ({
  actor: { actorId: AGENT, actorType: 'service', organizationId: ORG },
  namespace: { organizationId: ORG, path: `${OWNER_PATH}/2026` },
  scope: { scopeId: SCOPE_ID, namespace: { organizationId: ORG, path: OWNER_PATH }, allowedActorTypes: ['service'] },
  action: ACTION, resource: RESOURCE, at: NOW, now: NOW, ...overrides,
});

async function outcome(rt, request) {
  try {
    const decision = await rt.evaluate(request);
    return { outcome: 'decided', allowed: decision.allowed === true, decision: decision.decision, failedStage: decision.failedStage ?? null };
  } catch (error) {
    return { outcome: 'rejected', allowed: false, error: String(error && error.message ? error.message : error) };
  }
}

async function main() {
  const tampered = sign(grantOf());
  tampered.grant = { ...tampered.grant, expiresAt: '2099-01-01T00:00:00.000Z' };
  const unsigned = (() => { const g = grantOf(); return { grant: g, grantHash: crypto.stableHash(g) }; })();
  const fail = async () => { throw new Error('provider unavailable'); };

  const cases = {
    'A allowed': await outcome(runtime(), input()),
    'B correctly signed by a non-owner': await outcome(runtime({ grants: [sign(grantOf({ subjectActorId: MALLORY }), mallory)] }), input()),
    'C unsigned grant': await outcome(runtime({ grants: [unsigned] }), input()),
    'C owner grant signed with another trusted key': await outcome(runtime({ grants: [sign(grantOf(), mallory)] }), input()),
    'C grant altered after signing': await outcome(runtime({ grants: [tampered] }), input()),
    'C delegated grant without the delegate countersignature': await outcome(runtime({ grants: [sign(grantOf(), owner, null)] }), input()),
    'D expired capability': await outcome(runtime({ capabilities: [capability({ expiresAt: PAST })] }), input()),
    'D expired consent': await outcome(runtime({ grants: [sign(grantOf({ expiresAt: PAST }))] }), input()),
    'D revoked consent': await outcome(runtime({ grants: [sign(grantOf({ revokedAt: PAST }))] }), input()),
    'E ownership provider throws': await outcome(runtime({ ownerOf: fail }), input()),
    'E ownership unknown': await outcome(runtime({ ownerOf: async () => undefined }), input()),
    'E policy provider throws': await outcome(runtime({ policyProvider: { getPolicies: fail } }), input()),
    'E capability provider throws': await outcome(runtime({ capabilityProvider: { resolve: fail } }), input()),
    'E consent provider throws': await outcome(runtime({ consentProvider: { getActiveGrants: fail } }), input()),
    'E evaluation time `at` is a Date object': await outcome(runtime(), input({ at: new Date(NOW) })),
    'E evaluation time `now` is malformed': await outcome(runtime(), input({ now: '2026-06-01 12:00' })),
    'E grant issuedAt is an epoch number': await outcome(runtime({ grants: [sign(grantOf({ issuedAt: Date.parse(ISSUED) }))] }), input()),
    'E capability expiresAt is a Date object': await outcome(runtime({ capabilities: [capability({ expiresAt: new Date(FUTURE) })] }), input()),
    'F no governance rule matches': await outcome(runtime({ policies: [] }), input()),
    'F governance deny rule': await outcome(runtime({ policies: [allowPolicy, { ...allowPolicy, policyId: 'policy:deny', rules: [{ condition: `action:${ACTION}`, effect: 'deny' }] }] }), input()),
    'G sibling namespace': await outcome(runtime(), input({ namespace: { organizationId: ORG, path: `${OWNER_PATH}-other` } })),
    'G traversal namespace': await outcome(runtime(), input({ namespace: { organizationId: ORG, path: `${OWNER_PATH}/../bob` } })),
    'H federated authority without a verifier': await outcome(runtime(), input({ federatedAuthority: { claims: {}, signature: {}, scope: {} } })),
  };

  process.stdout.write(`${JSON.stringify({ cases, loaded: Object.keys(require.cache) })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  process.exit(1);
});
