import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { EXECUTION_FAILURE_REASONS, createExecutionAdapterRegistry, type ValidatedExecutionAction } from '../../features/execution-runtime/index.js';
import { createExecutionCapabilityIssuancePolicy, executionIdForGrant, type AuthoritySignature, type ExecutionCapabilityIssuanceRequest } from '../authority-authenticity/index.js';
import { createGenericHttpExecutionAdapterCore } from '../execution-adapters/generic-http/generic-http-execution-adapter.js';
import { GENERIC_HTTP_REQUEST_BINDING_FORMAT, genericHttpRequestBinding, genericHttpRequestBindingOf } from '../execution-adapters/generic-http/request-binding.js';
import { mapGenericHttpRequest, type GenericHttpWireRequest } from '../execution-adapters/generic-http/request-mapper.js';
import { ExecutionCapabilityGateConfigurationError, createExecutionCapabilityGate } from '../execution-capability-gate/index.js';
import { createExecutionCapabilityVerifier, executionCapabilityActionBindingDigest, serializeExecutionCapability, type ExecutionCapability } from '../execution-capability/index.js';
import { openExecutionCapabilityConsumptionLedger } from '../execution-capability/reference/consumption-ledger.js';
import { createExecutionCapabilityIssuer, type ExecutionCapabilityIssuer } from '../execution-capability-issuance/index.js';
import { AUTHORITY_KEY_A, AUTHORITY_KEY_B, testSigner, testVerifier, trustedKeyOf } from './authority-authenticity-fixture.js';
import {
  G02B_AUDIENCE,
  G02B_ISSUER,
  G02B_ORGANIZATION,
  G02B_OTHER_AUDIENCE,
  G02B_TRUST_DOMAIN,
  LedgerDirectory,
  NOW,
  POLICY,
  capabilityFor,
  custodySigner,
  readerOf,
  signCapabilityBytes,
  signedGrant,
  type SignedGrant,
} from './g02b-execution-capability-issuance-fixture.js';
import { CREDENTIAL_TOKEN, GATED_ADAPTER_ID, actionFor, countingNetwork, gateWorld, gatedPlan, recordingGate } from './g02c0-execution-binding-fixture.js';
import { ALLOWED_INTENT, IDENTITY, ORG, TRUST_DOMAIN_ID, buildGovernedWorld, type GovernedWorld } from './governed-action-support.js';

/**
 * G-02C0 — the governed execution binding and safety gate, measured at every
 * layer: the binding record over the exact request, the adapter's pre-send hook
 * (which can only stop a request), the gate over the real G-02B issuer and
 * software custody, a compromised in-process issuer, the emergency re-check,
 * the governed path end to end, and the reference executor recomputing the
 * binding over the request the (fake) network received.
 *
 * Counted, never inferred: sends, resolutions, custody calls and ledger rows.
 */

const ledgers = new LedgerDirectory();
after(() => ledgers.cleanup());

function requestOf(action: ValidatedExecutionAction, overrides: Record<string, unknown> = {}): GenericHttpWireRequest {
  const mapped = mapGenericHttpRequest(gatedPlan(overrides), action);
  assert.ok(mapped.ok, 'the request was expected to be buildable');
  return mapped.request;
}

function digestOf(request: GenericHttpWireRequest, overrides: Record<string, unknown> = {}): string {
  return executionCapabilityActionBindingDigest({ format: GENERIC_HTTP_REQUEST_BINDING_FORMAT, value: genericHttpRequestBinding(gatedPlan(overrides), request) });
}

function withheld(result: unknown): void {
  assert.deepEqual(result, { outcome: 'failed', reason: EXECUTION_FAILURE_REASONS.ADAPTER_ERROR, detail: 'Generic HTTP request was withheld before transmission by the pre-send gate.' });
}

/** A custody boundary that counts calls; `before` runs inside custody, before it signs. */
function countedCustody(before?: (request: ExecutionCapabilityIssuanceRequest) => void | Promise<void>) {
  const base = custodySigner();
  let calls = 0;
  return {
    calls: () => calls,
    signer: {
      ...base,
      signExecutionCapability: async (request: ExecutionCapabilityIssuanceRequest): Promise<AuthoritySignature> => {
        calls += 1;
        await before?.(request);
        return base.signExecutionCapability!(request);
      },
    },
  };
}

const BASE_SIGNED: Promise<SignedGrant> = signedGrant();

// ── 1. The binding record ──────────────────────────────────────────────────

describe('G-02C0 binding — frontera.http-request-binding.v1 covers the exact request, minus one secret', () => {
  it('binds method, origin, target (path and query), every mapped header and the exact body', async () => {
    const action = actionFor(await BASE_SIGNED);
    const request = requestOf(action);
    const binding = genericHttpRequestBinding(gatedPlan(), request);
    assert.equal(binding.method, 'POST');
    assert.deepEqual(binding.origin, { scheme: 'https', hostname: 'api.devops.example', port: 443 });
    assert.equal(binding.target, request.path);
    assert.ok(binding.target.includes('?strategy=rolling'), 'the query is part of the target');
    assert.equal(binding.body, request.body);
    assert.deepEqual(JSON.parse(binding.body ?? ''), { subject: action.subject, amount: 7500, currency: 'USD', replicas: 4 });
    // Every header the request carries but the credential, including the framing headers the mapper sets.
    const sent = new Map(request.headers.map(([name, value]) => [name, value]));
    assert.equal(binding.headers.length, request.headers.length - 1, 'exactly one header is excluded');
    for (const [name, value] of binding.headers) assert.equal(sent.get(name), value, name);
    for (const name of ['idempotency-key', 'x-counterparty', 'content-type', 'content-length']) assert.ok(binding.headers.some(([key]) => key === name), name);
    assert.deepEqual(binding.headers.map(([name]) => name), [...binding.headers.map(([name]) => name)].sort(), 'sorted by name');
    assert.ok(Object.isFrozen(binding) && Object.isFrozen(binding.headers) && Object.isFrozen(binding.origin));
  });

  it('excludes only the credential value — its name stays bound — and no other header can take its place', async () => {
    const request = requestOf(actionFor(await BASE_SIGNED));
    const binding = genericHttpRequestBinding(gatedPlan(), request);
    assert.equal(binding.credentialHeader, 'authorization');
    assert.equal(JSON.stringify(binding).includes(CREDENTIAL_TOKEN), false, 'the secret is never in the record');
    assert.equal(binding.headers.some(([name]) => name === 'authorization'), false);
    // Naming another header as the excluded one changes the record — and the digest.
    const misnamed = genericHttpRequestBindingOf(request, 'x-counterparty');
    assert.notEqual(executionCapabilityActionBindingDigest({ format: GENERIC_HTTP_REQUEST_BINDING_FORMAT, value: misnamed }), digestOf(request));
    // An explicit header credential is excluded the same way.
    const headerCredential = { credential: { kind: 'header', name: 'X-Api-Key', value: 'g02c0-api-key-sentinel' } };
    const keyed = genericHttpRequestBinding(gatedPlan(headerCredential), requestOf(actionFor(await BASE_SIGNED), headerCredential));
    assert.equal(keyed.credentialHeader, 'x-api-key');
    assert.equal(JSON.stringify(keyed).includes('g02c0-api-key-sentinel'), false);
    assert.ok(keyed.headers.some(([name]) => name === 'authorization') === false);
  });

  it('a request without a body or a credential binds null for both', async () => {
    const overrides = { method: 'DELETE', body: undefined, credential: undefined };
    const binding = genericHttpRequestBinding(gatedPlan(overrides), requestOf(actionFor(await BASE_SIGNED), overrides));
    assert.equal(binding.body, null);
    assert.equal(binding.credentialHeader, null);
    assert.equal(binding.method, 'DELETE');
  });

  it('no governed value can be substituted without changing the digest — amount, unit, counterparty, resource, typed parameters, subject, execution', async () => {
    const signed = await BASE_SIGNED;
    const base = digestOf(requestOf(actionFor(signed)));
    const substitutions: readonly [string, Partial<Record<keyof ValidatedExecutionAction, unknown>>][] = [
      ['amount', { amount: Object.freeze({ value: '75000', unit: 'USD' }) }],
      ['unit', { amount: Object.freeze({ value: '7500', unit: 'EUR' }) }],
      ['counterparty', { counterparty: 'vendor-6666' }],
      ['resource (path)', { resource: 'production-cluster-us' }],
      ['integer parameter (body)', { parameters: Object.freeze([{ dimension: 'replicaCount', type: 'integer', value: 40 }, { dimension: 'strategy', type: 'token', value: 'rolling' }]) }],
      ['token parameter (query)', { parameters: Object.freeze([{ dimension: 'replicaCount', type: 'integer', value: 4 }, { dimension: 'strategy', type: 'token', value: 'recreate' }]) }],
      ['subject', { subject: 'actor-intruder' }],
      ['execution (header)', { correlation: Object.freeze({ requestId: 'r', decisionId: 'd', executionId: 'aoc.exec:00000000000000000000000000000000' }) }],
    ];
    for (const [label, overrides] of substitutions) assert.notEqual(digestOf(requestOf(actionFor(signed, overrides))), base, label);
    // Destination and method are operator configuration, but bound all the same.
    assert.notEqual(digestOf(requestOf(actionFor(signed), { origin: 'https://api.devops.example:8443' }), { origin: 'https://api.devops.example:8443' }), base, 'port');
    assert.notEqual(digestOf(requestOf(actionFor(signed), { method: 'PUT' }), { method: 'PUT' }), base, 'method');
    // The one thing deliberately unbound: rotating the provider credential leaves the record unchanged.
    const rotated = { credential: { kind: 'bearer', token: 'G02C0RotatedBearer0123456789abcdef' } };
    assert.equal(digestOf(requestOf(actionFor(signed), rotated), rotated), base);
  });
});

// ── 2. The adapter's pre-send hook ─────────────────────────────────────────

describe('G-02C0 adapter hook — after mapping, before DNS; it can stop a request and never change one', () => {
  it('without a gate the adapter is unchanged: the same request, one resolution, one send', async () => {
    const action = actionFor(await BASE_SIGNED);
    const network = countingNetwork();
    const result = await createGenericHttpExecutionAdapterCore(gatedPlan(), network).execute(action);
    assert.equal(result.outcome, 'completed');
    assert.equal(network.sent.length, 1);
    assert.deepEqual(network.sent[0], requestOf(action));
  });

  it('the gate is shown a frozen subject: the adapter id, the very action, and the binding of the request that is then sent', async () => {
    const action = actionFor(await BASE_SIGNED);
    const network = countingNetwork();
    let resolvedBeforeGate = -1;
    const { gate, seen } = recordingGate(() => {
      resolvedBeforeGate = network.resolved.length;
      return { proceed: true };
    });
    const result = await createGenericHttpExecutionAdapterCore(gatedPlan(), network, gate).execute(action);
    assert.equal(result.outcome, 'completed');
    assert.equal(resolvedBeforeGate, 0, 'the gate runs before any DNS lookup');
    assert.equal(seen.length, 1);
    const subject = seen[0];
    assert.ok(subject !== undefined && Object.isFrozen(subject) && Object.isFrozen(subject.binding));
    assert.equal(subject.adapterId, GATED_ADAPTER_ID);
    assert.equal(subject.action, action, 'the same action object, not a copy');
    assert.equal(network.sent.length, 1);
    const sent = network.sent[0] as GenericHttpWireRequest;
    assert.deepEqual(subject.binding, genericHttpRequestBinding(gatedPlan(), sent), 'the bound record is the record of what was sent');
    assert.equal(JSON.stringify(subject).includes(CREDENTIAL_TOKEN), false, 'the gate never sees the credential');
    assert.equal(Object.keys(subject).sort().join(','), 'action,adapterId,binding', 'no request object is handed to the gate');
    assert.throws(() => {
      (subject.binding as { target: string }).target = '/v1/admin';
    }, TypeError);
  });

  const refusals: readonly [string, unknown][] = [
    ['{ proceed: false }', { proceed: false }],
    ['undefined', undefined],
    ['null', null],
    ['true', true],
    ["{ proceed: 'true' }", { proceed: 'true' }],
    ['{ proceed: 1 }', { proceed: 1 }],
    ['an inherited proceed', Object.create({ proceed: true })],
    [
      'a getter',
      Object.defineProperty({}, 'proceed', {
        get: () => true,
        enumerable: true,
      }),
    ],
  ];
  for (const [label, verdict] of refusals) {
    it(`a gate answering ${label} withholds the request: no DNS, no send`, async () => {
      const network = countingNetwork();
      const { gate } = recordingGate(verdict);
      withheld(await createGenericHttpExecutionAdapterCore(gatedPlan(), network, gate).execute(actionFor(await BASE_SIGNED)));
      assert.equal(network.resolved.length, 0);
      assert.equal(network.sent.length, 0);
    });
  }

  it('a gate that throws or rejects withholds the request', async () => {
    for (const gate of [
      async () => {
        throw new Error('gate failure');
      },
      () => Promise.reject(new Error('gate rejection')),
    ]) {
      const network = countingNetwork();
      withheld(await createGenericHttpExecutionAdapterCore(gatedPlan(), network, gate as never).execute(actionFor(await BASE_SIGNED)));
      assert.equal(network.sent.length + network.resolved.length, 0);
    }
  });

  it('an unbuildable request never reaches the gate', async () => {
    const { gate, seen } = recordingGate({ proceed: true });
    const network = countingNetwork();
    const result = await createGenericHttpExecutionAdapterCore(gatedPlan(), network, gate).execute(actionFor(await BASE_SIGNED, { counterparty: undefined }));
    assert.equal(result.outcome, 'failed');
    assert.equal(seen.length, 0);
    assert.equal(network.sent.length, 0);
  });
});

// ── 3. The gate over the real issuer ───────────────────────────────────────

describe('G-02C0 gate — issue for the exact request, verify as the executor would, re-check the stop, then send', () => {
  it('issues one capability bound to the sent request; the reference executor recomputes the binding from what it received, verifies and consumes once', async () => {
    const signed = await BASE_SIGNED;
    const custody = countedCustody();
    const world = gateWorld({ grants: readerOf([signed]), ledger: await ledgers.create(), signer: custody.signer });
    const action = actionFor(signed);
    const result = await world.execute(action);
    assert.equal(result.outcome, 'completed', JSON.stringify(result));
    assert.equal(custody.calls(), 1);
    assert.equal(world.network.sent.length, 1);

    const record = world.ledger.read(action.correlation.executionId);
    assert.ok(record.state === 'issued' && record.signature !== undefined, 'one capability, committed');
    const sent = world.network.sent[0] as GenericHttpWireRequest;
    assert.equal(record.capability.actionBinding.format, GENERIC_HTTP_REQUEST_BINDING_FORMAT);
    assert.equal(record.capability.actionBinding.digest, digestOf(sent), 'the capability binds the digest of the request actually sent');
    assert.equal(record.capability.executionId, action.correlation.executionId);
    assert.equal(record.capability.audience, G02B_AUDIENCE);

    // Reference demonstration (simulated executor): it knows its own credential header, recomputes the record from the
    // request the transport delivered, and verifies the capability as its audience. G-02C0 transmits no capability: the
    // demonstration reads it from the Host's issuance ledger.
    const executor = createExecutionCapabilityVerifier({ trustedIssuers: [{ issuer: G02B_ISSUER, keys: [trustedKeyOf(AUTHORITY_KEY_A)] }], executor: { audience: G02B_AUDIENCE, organizationIds: [G02B_ORGANIZATION], trustDomain: G02B_TRUST_DOMAIN }, clock: () => NOW + 1_000 });
    const presentation = { capability: record.canonical, signature: record.signature };
    const received = { format: GENERIC_HTTP_REQUEST_BINDING_FORMAT, value: genericHttpRequestBindingOf(sent, 'authorization') };
    const verdict = executor.verify({ presentation, action: action.action, resource: action.resource, actionBinding: received });
    assert.equal(verdict.verification, 'verified');
    const consumption = await openExecutionCapabilityConsumptionLedger(join(ledgers.dir, 'g02c0-consumption.sqlite'), { audience: G02B_AUDIENCE, clock: () => NOW + 1_000, create: true });
    try {
      assert.equal(consumption.claim(verdict).outcome, 'claimed');
      assert.deepEqual(consumption.claim(executor.verify({ presentation, action: action.action, resource: action.resource, actionBinding: received })), { outcome: 'refused', reason: 'CAPABILITY_CONSUMED' });
    } finally {
      consumption.close();
    }

    // A request altered after binding — a substituted amount, or a different target — is refused by that executor.
    const tamperedBody = { ...sent, body: (sent.body ?? '').replace('7500', '75000') };
    const tamperedTarget = { ...sent, path: sent.path.replace('rolling', 'recreate') };
    for (const tampered of [tamperedBody, tamperedTarget]) {
      const refused = executor.verify({ presentation, action: action.action, resource: action.resource, actionBinding: { format: GENERIC_HTTP_REQUEST_BINDING_FORMAT, value: genericHttpRequestBindingOf(tampered, 'authorization') } });
      assert.equal(refused.verification === 'rejected' ? refused.failure : refused.verification, 'ACTION_BINDING_MISMATCH');
    }
  });

  it('a second exercise of the same execution is withheld: no second capability, no custody call, no send', async () => {
    const signed = await BASE_SIGNED;
    const custody = countedCustody();
    const world = gateWorld({ grants: readerOf([signed]), ledger: await ledgers.create(), signer: custody.signer });
    const action = actionFor(signed);
    assert.equal((await world.execute(action)).outcome, 'completed');
    withheld(await world.execute(action));
    assert.equal(custody.calls(), 1);
    assert.equal(world.network.sent.length, 1);
  });

  it('a revoked, absent or foreign-action grant is refused before custody: withheld, no row, no send', async () => {
    const signed = await signedGrant();
    const exportGrant = await signedGrant({ action: 'export-records' });
    const cases: readonly [string, ReturnType<typeof readerOf>, SignedGrant][] = [
      ['revoked', readerOf([signed], [signed.grant.id]), signed],
      ['absent', readerOf([]), signed],
      // Registered for the other audience only: custody refuses the action for this adapter's audience.
      ['action not permitted for the audience', readerOf([exportGrant]), exportGrant],
    ];
    for (const [label, grants, target] of cases) {
      const custody = countedCustody();
      const world = gateWorld({ grants, ledger: await ledgers.create(), signer: custody.signer });
      const action = actionFor(target);
      withheld(await world.execute(action));
      assert.equal(custody.calls(), 0, label);
      assert.equal(world.ledger.read(action.correlation.executionId).state, 'absent', label);
      assert.equal(world.network.sent.length + world.network.resolved.length, 0, label);
    }
  });

  it('an action that disagrees with its grant on resource or subject is refused by custody: nothing is sent', async () => {
    const signed = await signedGrant();
    for (const overrides of [{ resource: 'production-cluster-us' }, { subject: 'actor-intruder' }] as const) {
      const world = gateWorld({ grants: readerOf([signed]), ledger: await ledgers.create() });
      withheld(await world.execute(actionFor(signed, overrides)));
      assert.equal(world.network.sent.length, 0);
    }
  });

  it('custody that fails after the reservation leaves the row uncertain, never reissued, and nothing is sent', async () => {
    const signed = await signedGrant();
    const custody = countedCustody(() => {
      throw new Error('custody unavailable');
    });
    const world = gateWorld({ grants: readerOf([signed]), ledger: await ledgers.create(), signer: custody.signer });
    const action = actionFor(signed);
    withheld(await world.execute(action));
    assert.equal(world.ledger.read(action.correlation.executionId).state, 'uncertain');
    withheld(await world.execute(action));
    assert.equal(custody.calls(), 1, 'possibly requested: never asked again');
    assert.equal(world.network.sent.length, 0);
  });

  it('an emergency stop for this adapter declared while custody signs withholds the request — the capability exists, nothing is sent', async () => {
    const signed = await signedGrant();
    let declare: () => void = () => undefined;
    const custody = countedCustody(() => declare());
    const world = gateWorld({ grants: readerOf([signed]), ledger: await ledgers.create(), signer: custody.signer });
    declare = () => world.emergency.activate({ scope: 'adapter', value: GATED_ADAPTER_ID, issuerRef: 'operator:g02c0', declaredAt: new Date(NOW).toISOString() });
    const action = actionFor(signed);
    withheld(await world.execute(action));
    assert.equal(world.ledger.read(action.correlation.executionId).state, 'issued', 'issued, verified and never presented');
    assert.equal(world.network.sent.length + world.network.resolved.length, 0);
  });

  it('a stop scoped to another adapter does not withhold; an unreadable stop does', async () => {
    const signed = await signedGrant();
    const world = gateWorld({ grants: readerOf([signed]), ledger: await ledgers.create() });
    world.emergency.activate({ scope: 'adapter', value: 'another.adapter', issuerRef: 'operator:g02c0', declaredAt: new Date(NOW).toISOString() });
    assert.equal((await world.execute(actionFor(signed))).outcome, 'completed');

    const second = await signedGrant();
    const policyGate = createExecutionCapabilityGate({ adapterId: GATED_ADAPTER_ID, audience: G02B_AUDIENCE, policy: POLICY, issuer: createExecutionCapabilityIssuer({ grants: readerOf([second]), signer: custodySigner(), verifier: testVerifier([AUTHORITY_KEY_A]), policy: POLICY, ledger: await ledgers.create(), now: () => NOW }), clock: () => NOW });
    policyGate.bind({
      issuerKey: trustedKeyOf(AUTHORITY_KEY_A),
      emergencyControl: {
        read: () => {
          throw new Error('emergency store unreadable');
        },
      },
    });
    const network = countingNetwork();
    withheld(await createGenericHttpExecutionAdapterCore(gatedPlan(), network, policyGate.beforeSend).execute(actionFor(second)));
    assert.equal(network.sent.length, 0);
  });

  it('an unbound gate withholds without asking the issuer; a gate is bound exactly once', async () => {
    const signed = await signedGrant();
    const custody = countedCustody();
    const world = gateWorld({ grants: readerOf([signed]), ledger: await ledgers.create(), signer: custody.signer, bind: false });
    assert.equal(world.gate.bound(), false);
    withheld(await world.execute(actionFor(signed)));
    assert.equal(custody.calls(), 0);
    world.gate.bind({ issuerKey: trustedKeyOf(AUTHORITY_KEY_A), emergencyControl: undefined });
    assert.throws(() => world.gate.bind({ issuerKey: trustedKeyOf(AUTHORITY_KEY_A), emergencyControl: undefined }), ExecutionCapabilityGateConfigurationError);
    assert.equal((await world.execute(actionFor(signed))).outcome, 'completed');
  });

  it('a subject naming another adapter is refused', async () => {
    const signed = await signedGrant();
    const world = gateWorld({ grants: readerOf([signed]), ledger: await ledgers.create() });
    const action = actionFor(signed);
    const verdict = await world.gate.beforeSend({ adapterId: 'another.adapter', action, binding: genericHttpRequestBinding(gatedPlan(), requestOf(action)) });
    assert.deepEqual(verdict, { proceed: false });
    assert.equal(world.ledger.read(action.correlation.executionId).state, 'absent');
  });

  it('composition refuses a gate whose audience is unregistered or does not permit the HTTP binding format', () => {
    const issuer = { issue: () => Promise.reject(new Error('unused')) };
    assert.throws(() => createExecutionCapabilityGate({ adapterId: GATED_ADAPTER_ID, audience: 'executor-unknown', policy: POLICY, issuer }), ExecutionCapabilityGateConfigurationError);
    const other = createExecutionCapabilityIssuancePolicy({ issuer: G02B_ISSUER, organizationId: G02B_ORGANIZATION, trustDomain: G02B_TRUST_DOMAIN, lifetimeMs: 30_000, audiences: [{ audience: G02B_AUDIENCE, actions: ['deploy-release'], bindingFormats: ['frontera.other-binding.v1'] }] });
    assert.throws(() => createExecutionCapabilityGate({ adapterId: GATED_ADAPTER_ID, audience: G02B_AUDIENCE, policy: other, issuer }), ExecutionCapabilityGateConfigurationError);
    assert.throws(() => createExecutionCapabilityGate({ adapterId: '', audience: G02B_AUDIENCE, policy: POLICY, issuer }), ExecutionCapabilityGateConfigurationError);
  });
});

// ── 4. A defective or compromised in-process issuer ────────────────────────

describe('G-02C0 gate — post-issuance verification refuses any capability that is not exactly this request', () => {
  /** An issuer that returns `capability`, signed by `key` (a compromised boundary, or a bug), without any ledger. */
  const GENUINE = Symbol('genuine signature');
  function forgedIssuer(capability: ExecutionCapability, key = AUTHORITY_KEY_A, signature: unknown = GENUINE): ExecutionCapabilityIssuer {
    return {
      issue: async () => ({ capability, canonical: serializeExecutionCapability(capability), signature: (signature === GENUINE ? signCapabilityBytes(capability, key) : signature) as AuthoritySignature }),
      inspect: () => 'absent',
    };
  }

  async function run(issuer: ExecutionCapabilityIssuer, signed: SignedGrant, action: ValidatedExecutionAction = actionFor(signed)) {
    const world = gateWorld({ grants: readerOf([signed]), ledger: await ledgers.create(), issuer });
    return { result: await world.execute(action), world };
  }

  it('control: the exact capability for this request proceeds (so each refusal below is discriminating)', async () => {
    const signed = await signedGrant();
    const action = actionFor(signed);
    const { capability } = capabilityFor(signed, { actionBinding: { format: GENERIC_HTTP_REQUEST_BINDING_FORMAT, digest: digestOf(requestOf(action)) } });
    const { result, world } = await run(forgedIssuer(capability), signed, action);
    assert.equal(result.outcome, 'completed');
    assert.equal(world.network.sent.length, 1);
  });

  it('a capability for another request, execution, subject, audience, action or resource — or past the action’s window — is refused, and nothing is sent', async () => {
    const signed = await signedGrant();
    const action = actionFor(signed);
    const exact = { format: GENERIC_HTTP_REQUEST_BINDING_FORMAT, digest: digestOf(requestOf(action)) };
    const cases: readonly [string, Partial<Record<keyof ExecutionCapability, unknown>>][] = [
      ['another request (substituted amount)', { actionBinding: { format: GENERIC_HTTP_REQUEST_BINDING_FORMAT, digest: digestOf(requestOf(actionFor(signed, { amount: Object.freeze({ value: '75000', unit: 'USD' }) }))) } }],
      ['another binding format', { actionBinding: { format: 'frontera.other-binding.v1', digest: exact.digest } }],
      ['another execution', { actionBinding: exact, executionId: 'aoc.exec:00000000000000000000000000000000' }],
      ['another subject', { actionBinding: exact, subjectActorId: 'actor-intruder' }],
      ['another audience', { actionBinding: exact, audience: G02B_OTHER_AUDIENCE }],
      ['another action', { actionBinding: exact, action: 'export-records' }],
      ['another resource', { actionBinding: exact, resource: 'production-cluster-us' }],
      ['another organization', { actionBinding: exact, organizationId: 'org-other' }],
      ['another issuer', { actionBinding: exact, issuer: 'frontera-deployment-other' }],
      ['expired', { actionBinding: exact, issuedAt: new Date(NOW - 60_000).toISOString(), expiresAt: new Date(NOW - 30_000).toISOString() }],
    ];
    for (const [label, overrides] of cases) {
      const { capability } = capabilityFor(signed, overrides);
      const { result, world } = await run(forgedIssuer(capability), signed, action);
      withheld(result);
      assert.equal(world.network.sent.length + world.network.resolved.length, 0, label);
    }
  });

  it('a capability outliving the action’s notAfter is refused', async () => {
    const signed = await signedGrant();
    const action = actionFor(signed, { notAfter: new Date(NOW + 10_000).toISOString() });
    const { capability } = capabilityFor(signed, { actionBinding: { format: GENERIC_HTTP_REQUEST_BINDING_FORMAT, digest: digestOf(requestOf(action)) } });
    const { result, world } = await run(forgedIssuer(capability), signed, action);
    withheld(result);
    assert.equal(world.network.sent.length, 0);
  });

  it('a signature by an unpinned key, a signature over other bytes, or no signature at all is refused', async () => {
    const signed = await signedGrant();
    const action = actionFor(signed);
    const exact = { actionBinding: { format: GENERIC_HTTP_REQUEST_BINDING_FORMAT, digest: digestOf(requestOf(action)) } };
    const { capability } = capabilityFor(signed, exact);
    const { capability: other } = capabilityFor(signed, { ...exact, resource: 'production-cluster-us' });
    const keyB = capabilityFor(signed, exact, { key: AUTHORITY_KEY_B }).capability;
    for (const issuer of [forgedIssuer(keyB, AUTHORITY_KEY_B), forgedIssuer(capability, AUTHORITY_KEY_A, signCapabilityBytes(other)), forgedIssuer(capability, AUTHORITY_KEY_A, {}), forgedIssuer(capability, AUTHORITY_KEY_A, null)]) {
      const { result, world } = await run(issuer, signed, action);
      withheld(result);
      assert.equal(world.network.sent.length, 0);
    }
  });

  it('a gate pinned to another key refuses even a genuine issuance', async () => {
    const signed = await signedGrant();
    const world = gateWorld({ grants: readerOf([signed]), ledger: await ledgers.create(), issuerKey: AUTHORITY_KEY_B });
    withheld(await world.execute(actionFor(signed)));
    assert.equal(world.network.sent.length, 0);
  });
});

// ── 5. The governed path, end to end ───────────────────────────────────────

describe('G-02C0 on the governed path — Kernel → decision → grant → claim → exercise → registry → mapping → gate → one request', () => {
  const STORE_ID = 'grant-store-g02c0-world';
  const AUDIENCE = 'executor-erp-gateway';

  async function governedWorld(options: { readonly actions?: readonly string[] } = {}) {
    let world: GovernedWorld | undefined;
    const now = () => Date.parse(world?.clock.now() ?? '2026-01-01T00:00:00.000Z');
    const policyInput = { issuer: 'frontera-deployment-g02c0', organizationId: ORG, trustDomain: TRUST_DOMAIN_ID, lifetimeMs: 30_000, audiences: [{ audience: AUDIENCE, actions: options.actions ?? [ALLOWED_INTENT.action], bindingFormats: [GENERIC_HTTP_REQUEST_BINDING_FORMAT] }] };
    const policy = createExecutionCapabilityIssuancePolicy(policyInput);
    const ledger = await ledgers.create(ledgers.path(), { issuer: policy.issuer, clock: now });
    let custodyCalls = 0;
    const custody = custodySigner(AUTHORITY_KEY_A, policyInput, now);
    const signer = {
      ...custody,
      signExecutionCapability: async (request: ExecutionCapabilityIssuanceRequest): Promise<AuthoritySignature> => {
        custodyCalls += 1;
        return custody.signExecutionCapability!(request);
      },
    };
    // Simulated authenticated store: the world's grant record, signed under the authority key as the durable store files it.
    const grants = {
      async readSigned(grantId: string) {
        const read = await (world as GovernedWorld).grantStore.read(grantId);
        if (read.grant === undefined) return { storeId: STORE_ID };
        return { storeId: STORE_ID, grant: read.grant, signature: await testSigner(AUTHORITY_KEY_A).signGrant(read.grant, STORE_ID), ...(read.revocation !== undefined ? { revocation: read.revocation } : {}) };
      },
    };
    const issuer = createExecutionCapabilityIssuer({ grants, signer, verifier: testVerifier([AUTHORITY_KEY_A]), policy, ledger, now });
    const gate = createExecutionCapabilityGate({ adapterId: 'erp.generic', audience: AUDIENCE, policy, issuer, clock: now });
    gate.bind({ issuerKey: trustedKeyOf(AUTHORITY_KEY_A), emergencyControl: undefined });
    const network = countingNetwork();
    const plan = gatedPlan({
      adapterId: 'erp.generic',
      origin: 'https://api.erp.example',
      path: [{ kind: 'literal', value: 'v1' }, { kind: 'literal', value: 'actions' }],
      query: undefined,
      headers: { 'Idempotency-Key': { kind: 'source', source: 'correlation.executionId' } },
      body: { kind: 'json-object', fields: { action: { kind: 'source', source: 'action' }, resource: { kind: 'source', source: 'resource' }, subject: { kind: 'source', source: 'subject' } } },
    });
    const generic = createGenericHttpExecutionAdapterCore(plan, network, gate.beforeSend);
    const registry = createExecutionAdapterRegistry({ adapterId: 'router', adapters: [generic], selectAdapter: () => 'erp.generic' });
    world = buildGovernedWorld({ executionAdapter: registry });
    return { world, network, ledger, plan, custodyCalls: () => custodyCalls };
  }

  it('executes once: one capability bound to the one request sent, and a replay neither re-issues nor re-sends', async () => {
    const { world, network, ledger, plan, custodyCalls } = await governedWorld();
    const result = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(result.status, 'executed', JSON.stringify(result));
    assert.equal(network.sent.length, 1);
    assert.equal(custodyCalls(), 1);
    const executionId = result.executionId ?? '';
    const record = ledger.read(executionId);
    assert.ok(record.state === 'issued', 'the governed execution id is the one custody derived from the grant');
    const sent = network.sent[0] as GenericHttpWireRequest;
    assert.equal(record.capability.actionBinding.digest, executionCapabilityActionBindingDigest({ format: GENERIC_HTTP_REQUEST_BINDING_FORMAT, value: genericHttpRequestBinding(plan, sent) }));
    const grant = (await world.grantStore.read(record.boundedGrantId)).grant;
    assert.ok(grant !== undefined && executionIdForGrant(grant) === executionId);

    const replay = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(replay.status, 'executed');
    assert.equal(network.sent.length, 1, 'answered from the governance claim: the adapter is not reached again');
    assert.equal(custodyCalls(), 1);
  });

  it('an issuance custody refuses fails the execution as ADAPTER_ERROR — recorded, nothing sent', async () => {
    const { world, network, custodyCalls } = await governedWorld({ actions: ['some-other-routed-action'] });
    const result = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(result.status, 'execution_failed', JSON.stringify(result));
    assert.equal(result.status === 'execution_failed' ? result.failure : undefined, 'ADAPTER_ERROR');
    assert.equal(network.sent.length + network.resolved.length, 0);
    assert.equal(custodyCalls(), 0);
  });
});
