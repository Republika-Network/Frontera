import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import type { ContextResolutionQuery, ContextSource } from '../../features/context-resolution-runtime/index.js';
import { executionDestinationKey, type ExecutionDestination } from '../../features/destination-runtime/index.js';
import type { DestinationApprovalReaderPort, DestinationGovernanceAuthority } from '../../features/destination-runtime/approval/index.js';
import { DestinationApprovalError } from '../../features/destination-runtime/approval/index.js';
import { DestinationRegistryError, type DestinationRegistryReaderPort } from '../../features/destination-runtime/registry/index.js';
import type { ContextProvider, KernelEvaluationRequest } from '../../kernel/index.js';
import { KernelContextCapability, resolveKernelContext, resolveKernelContextFacts } from '../../kernel/orchestration/context-adapter.js';
import { createSqliteDestinationApprovalStore, type DurableDestinationApprovalStore } from '../destination-approval/index.js';
import { createSqliteDestinationRegistry, DESTINATION_REGISTRY_SCHEMA_VERSION, type DurableDestinationRegistry } from '../destination-registry/index.js';
import { validateGovernedActionIntent } from '../governed-action/intent.js';
import {
  DESTINATION_CONTEXT_FACT_CLASSES as F,
  createDestinationContextProvider,
  destinationFromCounterparty,
  resolveTrustedDestinationContext,
  type TrustedDestinationResolution,
  type TrustedDestinationUnavailableReason,
} from '../trusted-context/index.js';

/**
 * ANDREW-P0-04 — trusted destination context, against the real durable
 * registry (P0-02) and approval store (P0-03), and through the real Kernel
 * context path (`resolveKernelContext` → Trusted Context Boundary →
 * `resolveKernelContextFacts().admitted`, the facts policy reads).
 *
 * Synthetic namespaces and identifiers only; no rail.
 */

const ORG_A = 'org-a';
const ORG_B = 'org-b';
const T0 = '2026-10-01T00:00:00.000Z';
const SOURCES = { registry: 'destination-registry', approval: 'destination-approval' } as const;
const ALL_KEYS = [F.approvalState, F.approved, F.key, F.known].sort();

const directories: string[] = [];
after(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function freshDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'frontera-p004-'));
  directories.push(directory);
  return directory;
}

function destination(namespace: string, identifier: string): ExecutionDestination {
  return { namespace, identifier };
}

function authority(organizationId: string): DestinationGovernanceAuthority {
  return { authenticated: true, organizationId, actorRef: 'operator:ops-1', authorityBasis: 'permission:destination.approve' };
}

interface World {
  readonly registry: DurableDestinationRegistry;
  readonly store: DurableDestinationApprovalStore;
  readonly registryPath: string;
  readonly approvalPath: string;
  readonly clock: { now(): string; set(instant: string): void };
  register(target: ExecutionDestination): void;
  approve(organizationId: string, target: ExecutionDestination, expiresAt?: string): void;
  revoke(organizationId: string, target: ExecutionDestination): void;
  close(): Promise<void>;
}

let keySequence = 0;
const nextKey = (prefix: string): string => `${prefix}-${String((keySequence += 1)).padStart(6, '0')}`;

async function world(directory = freshDirectory()): Promise<World> {
  let instant = T0;
  const clock = { now: () => instant, set: (value: string) => void (instant = value) };
  const registryPath = join(directory, 'destination-registry.sqlite');
  const approvalPath = join(directory, 'destination-approval.sqlite');
  const registry = await createSqliteDestinationRegistry(registryPath, { now: clock.now });
  const store = await createSqliteDestinationApprovalStore(approvalPath, { now: clock.now, registry });
  return {
    registry,
    store,
    registryPath,
    approvalPath,
    clock,
    register: (target) => void registry.register({ destination: target, registeredBy: 'operator:registrar' }),
    approve: (organizationId, target, expiresAt) => void store.approve(authority(organizationId), { destination: target, idempotencyKey: nextKey('approve'), ...(expiresAt !== undefined ? { expiresAt } : {}) }),
    revoke: (organizationId, target) => void store.revoke(authority(organizationId), { destination: target, idempotencyKey: nextKey('revoke') }),
    async close() {
      await store.close();
      await registry.close();
    },
  };
}

function resolved(resolution: TrustedDestinationResolution) {
  assert.equal(resolution.kind, 'resolved', JSON.stringify(resolution));
  return (resolution as Extract<TrustedDestinationResolution, { kind: 'resolved' }>).context;
}

function assertUnavailable(resolution: TrustedDestinationResolution, reason: TrustedDestinationUnavailableReason): void {
  assert.deepEqual(resolution, { kind: 'unavailable', reason });
}

// ---------------------------------------------------------------------------
// The real Kernel context path, so what is asserted is what policy would read.

const CONTEXT_SOURCES: readonly ContextSource[] = [
  { id: SOURCES.registry, kind: 'internal_store', name: 'Destination registry', trustClass: 'authoritative', organizationId: ORG_A, provenance: 'reference-digest', attests: [{ factClass: F.key, maxAgeSeconds: 900 }, { factClass: F.known, maxAgeSeconds: 900 }] },
  { id: SOURCES.approval, kind: 'approval_system', name: 'Destination approval', trustClass: 'authoritative', organizationId: ORG_A, provenance: 'reference-digest', attests: [{ factClass: F.approvalState, maxAgeSeconds: 900 }, { factClass: F.approved, maxAgeSeconds: 900 }] },
];

function capability(provider: ContextProvider): KernelContextCapability {
  return new KernelContextCapability({
    provider,
    sources: CONTEXT_SOURCES,
    declaration: { requirements: ALL_KEYS.map((key) => ({ key, minimumTrustClass: 'authoritative' as const, required: true })) },
  });
}

function kernelRequest(counterpartyId: string | undefined, organizationId: string | undefined = ORG_A, extra: Record<string, unknown> = {}): KernelEvaluationRequest {
  return {
    requestId: nextKey('req'),
    actor: { id: 'actor-agent', trustDomainId: 'trust-domain-p004' },
    action: { type: 'send-value', resourceScope: 'treasury-example', ...(counterpartyId !== undefined ? { counterpartyId } : {}) },
    ...(organizationId !== undefined ? { organization: { id: organizationId } } : {}),
    requestedAt: T0,
    ...extra,
  } as KernelEvaluationRequest;
}

/** Resolves through the Kernel context path and returns what policy may read, plus the denial codes. */
async function policyView(provider: ContextProvider, request: KernelEvaluationRequest, at = T0) {
  const cap = capability(provider);
  const resolution = await resolveKernelContext(cap, request, at);
  assert.ok(resolution !== undefined);
  const facts = resolveKernelContextFacts(cap, resolution, request);
  const admitted = Object.fromEntries(facts.admitted.contextFacts.map((fact) => [fact.factClass, fact.value]));
  return { admitted, reasonCodes: facts.reasonCodes, resolution };
}

function provider(w: Pick<World, 'registry' | 'store'>, organizationId = ORG_A, onUnavailable?: (reason: TrustedDestinationUnavailableReason) => void): ContextProvider {
  return createDestinationContextProvider({
    organizationId,
    sourceIds: SOURCES,
    registry: w.registry,
    approvals: w.store,
    ...(onUnavailable !== undefined ? { onUnavailable: (event: { readonly reason: TrustedDestinationUnavailableReason }) => onUnavailable(event.reason) } : {}),
  });
}

const D = destination('network-a', 'abc123');
const DK = executionDestinationKey(D);

describe('ANDREW-P0-04 — registry × approval matrix (A–E), from the two read ports only', () => {
  it('A: unknown destination, never approved → known=false, approved=false', async () => {
    const w = await world();
    const context = resolved(resolveTrustedDestinationContext({ registry: w.registry, approvals: w.store }, { organizationId: ORG_A, destination: D }));
    assert.deepEqual(context, { organizationId: ORG_A, destination: D, destinationKey: DK, destinationKnown: false, destinationApprovalState: 'never-approved', destinationApproved: false });
    await w.close();
  });

  it('B: known, never approved → known=true, approved=false', async () => {
    const w = await world();
    w.register(D);
    const context = resolved(resolveTrustedDestinationContext({ registry: w.registry, approvals: w.store }, { organizationId: ORG_A, destination: D }));
    assert.equal(context.destinationKnown, true);
    assert.equal(context.destinationApprovalState, 'never-approved');
    assert.equal(context.destinationApproved, false);
    await w.close();
  });

  it('C: known, approved → known=true, approved=true, with the approval it rests on', async () => {
    const w = await world();
    w.register(D);
    w.approve(ORG_A, D);
    const context = resolved(resolveTrustedDestinationContext({ registry: w.registry, approvals: w.store }, { organizationId: ORG_A, destination: D }));
    assert.equal(context.destinationKnown, true);
    assert.equal(context.destinationApprovalState, 'approved');
    assert.equal(context.destinationApproved, true);
    assert.equal(typeof context.approvalSequence, 'number');
    await w.close();
  });

  it('D: known, revoked → approved=false, state revoked (not collapsed to never-approved)', async () => {
    const w = await world();
    w.register(D);
    w.approve(ORG_A, D);
    w.revoke(ORG_A, D);
    const context = resolved(resolveTrustedDestinationContext({ registry: w.registry, approvals: w.store }, { organizationId: ORG_A, destination: D }));
    assert.deepEqual([context.destinationKnown, context.destinationApprovalState, context.destinationApproved], [true, 'revoked', false]);
    await w.close();
  });

  it('E: known, expired → approved=false, state expired; expiry is exact at expiresAt', async () => {
    const w = await world();
    w.register(D);
    w.approve(ORG_A, D, '2026-10-01T01:00:00.000Z');
    const read = () => resolved(resolveTrustedDestinationContext({ registry: w.registry, approvals: w.store }, { organizationId: ORG_A, destination: D }));
    w.clock.set('2026-10-01T00:59:59.999Z');
    assert.deepEqual([read().destinationApprovalState, read().destinationApproved], ['approved', true]);
    w.clock.set('2026-10-01T01:00:00.000Z');
    assert.deepEqual([read().destinationApprovalState, read().destinationApproved], ['expired', false]);
    w.clock.set('2026-10-02T00:00:00.000Z');
    assert.deepEqual([read().destinationApprovalState, read().destinationApproved], ['expired', false]);
    await w.close();
  });
});

describe('ANDREW-P0-04 — tenant isolation and canonical identity', () => {
  it('approval for organization A is never approval for organization B', async () => {
    const w = await world();
    w.register(D);
    w.approve(ORG_A, D);
    const readers = { registry: w.registry, approvals: w.store };
    assert.equal(resolved(resolveTrustedDestinationContext(readers, { organizationId: ORG_A, destination: D })).destinationApproved, true);
    const b = resolved(resolveTrustedDestinationContext(readers, { organizationId: ORG_B, destination: D }));
    assert.deepEqual([b.destinationKnown, b.destinationApprovalState, b.destinationApproved], [true, 'never-approved', false]);

    // Through the provider: a Host serving A, and a Host serving B, over the same stores.
    const forA = await policyView(provider(w, ORG_A), kernelRequest(DK, ORG_A));
    assert.equal(forA.admitted[F.approved], true);
    const forB = await provider(w, ORG_B).resolveContext({ keys: ALL_KEYS, actorId: 'a', trustDomainId: 't', action: 'send-value', resourceScope: 'r', organizationId: ORG_B, counterpartyId: DK, at: T0 });
    assert.deepEqual(Object.fromEntries(forB.observations.map((o) => [o.key, o.value])), { [F.key]: DK, [F.known]: true, [F.approvalState]: 'never-approved', [F.approved]: false });
    await w.close();
  });

  it('the canonical destination key appears identically in the resolver result and the admitted fact', async () => {
    const w = await world();
    w.register(D);
    const view = await policyView(provider(w), kernelRequest(DK));
    assert.equal(view.admitted[F.key], DK);
    assert.equal(view.admitted[F.key], 'network-a:abc123');
    assert.equal(resolved(resolveTrustedDestinationContext({ registry: w.registry, approvals: w.store }, { organizationId: ORG_A, destination: D })).destinationKey, DK);
    await w.close();
  });

  it('the same identifier under two namespaces resolves independently', async () => {
    const w = await world();
    const a = destination('network-a', 'shared-id');
    const b = destination('network-b', 'shared-id');
    w.register(a);
    w.register(b);
    w.approve(ORG_A, a);
    const viewA = await policyView(provider(w), kernelRequest(executionDestinationKey(a)));
    const viewB = await policyView(provider(w), kernelRequest(executionDestinationKey(b)));
    assert.deepEqual([viewA.admitted[F.key], viewA.admitted[F.approved]], ['network-a:shared-id', true]);
    assert.deepEqual([viewB.admitted[F.key], viewB.admitted[F.approved]], ['network-b:shared-id', false]);
    await w.close();
  });

  it('case-different identifiers are different destinations', async () => {
    const w = await world();
    const lower = destination('network-a', 'abc');
    w.register(lower);
    w.approve(ORG_A, lower);
    const upper = await policyView(provider(w), kernelRequest('network-a:ABC'));
    assert.deepEqual([upper.admitted[F.known], upper.admitted[F.approved]], [false, false]);
    const exact = await policyView(provider(w), kernelRequest('network-a:abc'));
    assert.deepEqual([exact.admitted[F.known], exact.admitted[F.approved]], [true, true]);
    await w.close();
  });

  it('a counterparty designates a destination only when it is exactly a canonical key', () => {
    assert.deepEqual(destinationFromCounterparty('network-a:abc123'), D);
    assert.deepEqual(destinationFromCounterparty('network-a:scheme://x/1'), destination('network-a', 'scheme://x/1'));
    for (const value of ['abc123', ':abc', 'network-a:', 'Network-A:abc', ' network-a:abc', 'network-a:abc ', 'network-a:a b', 'network a:abc', 'network-a:abç', '', undefined, 42, null, { namespace: 'network-a', identifier: 'abc' }]) {
      assert.equal(destinationFromCounterparty(value), undefined, String(value));
    }
  });
});

describe('ANDREW-P0-04 — fail closed: unavailable is never false', () => {
  it('registry store failure → REGISTRY_UNAVAILABLE; no destination fact reaches policy; required facts deny', async () => {
    const w = await world();
    w.register(D);
    w.approve(ORG_A, D);
    await w.registry.close();
    assertUnavailable(resolveTrustedDestinationContext({ registry: w.registry, approvals: w.store }, { organizationId: ORG_A, destination: D }), 'REGISTRY_UNAVAILABLE');
    const reasons: TrustedDestinationUnavailableReason[] = [];
    const view = await policyView(provider(w, ORG_A, (reason) => reasons.push(reason)), kernelRequest(DK));
    assert.deepEqual(view.admitted, {});
    assert.deepEqual(view.reasonCodes, ['CONTEXT_REQUIRED_FACT_UNRESOLVED']);
    assert.deepEqual([...view.resolution.unresolved].sort(), ALL_KEYS);
    assert.deepEqual(reasons, ['REGISTRY_UNAVAILABLE']);
    await w.store.close();
  });

  it('approval store failure → APPROVAL_UNAVAILABLE; known is withheld too, never reported alone as a partial answer', async () => {
    const w = await world();
    w.register(D);
    await w.store.close();
    assertUnavailable(resolveTrustedDestinationContext({ registry: w.registry, approvals: w.store }, { organizationId: ORG_A, destination: D }), 'APPROVAL_UNAVAILABLE');
    const view = await policyView(provider(w), kernelRequest(DK));
    assert.deepEqual(view.admitted, {});
    assert.deepEqual(view.reasonCodes, ['CONTEXT_REQUIRED_FACT_UNRESOLVED']);
    await w.registry.close();
  });

  it('corrupt registry state → REGISTRY_CORRUPT, never unknown', async () => {
    const directory = freshDirectory();
    const path = join(directory, 'destination-registry.sqlite');
    await (await createSqliteDestinationRegistry(path, { now: () => T0 })).close();
    const db = new Database(path);
    db.prepare(`INSERT INTO registered_destinations VALUES (?, ?, ?, ?, ?, ?)`).run(DK, 'network-a', 'abc123', 'operator:registrar', '2026-10-01', DESTINATION_REGISTRY_SCHEMA_VERSION);
    db.close();
    const registry = await createSqliteDestinationRegistry(path, { now: () => T0 });
    const store = await createSqliteDestinationApprovalStore(join(directory, 'destination-approval.sqlite'), { now: () => T0, registry });
    assertUnavailable(resolveTrustedDestinationContext({ registry, approvals: store }, { organizationId: ORG_A, destination: D }), 'REGISTRY_CORRUPT');
    const view = await policyView(provider({ registry, store }), kernelRequest(DK));
    assert.deepEqual(view.admitted, {});
    assert.deepEqual(view.reasonCodes, ['CONTEXT_REQUIRED_FACT_UNRESOLVED']);
    await store.close();
    await registry.close();
  });

  it('corrupt approval state (a deleted revocation) → APPROVAL_CORRUPT, never approved and never never-approved', async () => {
    const directory = freshDirectory();
    const w = await world(directory);
    w.register(D);
    w.approve(ORG_A, D);
    w.revoke(ORG_A, D);
    await w.close();
    const db = new Database(join(directory, 'destination-approval.sqlite'));
    db.exec(`DROP TRIGGER destination_approval_events_append_only_delete`);
    db.exec(`DELETE FROM destination_approval_events WHERE transition = 'revoked'`);
    db.close();
    const reopened = await world(directory);
    assertUnavailable(resolveTrustedDestinationContext({ registry: reopened.registry, approvals: reopened.store }, { organizationId: ORG_A, destination: D }), 'APPROVAL_CORRUPT');
    const view = await policyView(provider(reopened), kernelRequest(DK));
    assert.deepEqual(view.admitted, {});
    assert.notEqual(view.reasonCodes.length, 0);
    await reopened.close();
  });

  it('UNKNOWN registry + ACTIVE approval (independent registry file) → GOVERNANCE_INCONSISTENT, never approved', async () => {
    const w = await world();
    w.register(D);
    w.approve(ORG_A, D);
    const otherRegistry = await createSqliteDestinationRegistry(join(freshDirectory(), 'other-registry.sqlite'), { now: () => T0 });
    assertUnavailable(resolveTrustedDestinationContext({ registry: otherRegistry, approvals: w.store }, { organizationId: ORG_A, destination: D }), 'GOVERNANCE_INCONSISTENT');
    const view = await policyView(provider({ registry: otherRegistry, store: w.store }), kernelRequest(DK));
    assert.deepEqual(view.admitted, {});
    assert.deepEqual(view.reasonCodes, ['CONTEXT_REQUIRED_FACT_UNRESOLVED']);
    // Revoked or expired history for an unknown destination is just as impossible.
    w.revoke(ORG_A, D);
    assertUnavailable(resolveTrustedDestinationContext({ registry: otherRegistry, approvals: w.store }, { organizationId: ORG_A, destination: D }), 'GOVERNANCE_INCONSISTENT');
    await otherRegistry.close();
    await w.close();
  });

  it('a reader answering about another destination or organization is not a trusted record of this one', () => {
    const known = { membership: 'known', registration: { destination: D, destinationKey: DK, registeredBy: 'operator:x', registeredAt: T0 } } as const;
    const never = { state: 'never-approved', organizationId: ORG_A, destinationKey: DK } as const;
    const other = destination('network-a', 'other');
    const cases: readonly [string, DestinationRegistryReaderPort['lookup'], DestinationApprovalReaderPort['read'], TrustedDestinationUnavailableReason][] = [
      ['registry answers another key (unknown)', () => ({ membership: 'unknown', destinationKey: 'network-a:other' }), () => never, 'REGISTRY_CORRUPT'],
      ['registry answers another destination (known)', () => ({ membership: 'known', registration: { destination: other, destinationKey: DK, registeredBy: 'x', registeredAt: T0 } }), () => never, 'REGISTRY_CORRUPT'],
      ['registry answers an invented membership', () => ({ membership: 'trusted', destinationKey: DK }) as never, () => never, 'REGISTRY_CORRUPT'],
      ['registry answers nothing', () => undefined as never, () => never, 'REGISTRY_CORRUPT'],
      ['approval answers for another organization', () => known, () => ({ state: 'never-approved', organizationId: ORG_B, destinationKey: DK }), 'APPROVAL_CORRUPT'],
      [
        'approval answers an approval of another organization',
        () => known,
        () => ({ state: 'approved', approval: { organizationId: ORG_B, destination: D, destinationKey: DK, sequence: 1, approvedBy: 'x', authorityBasis: 'y', approvedAt: T0, expiresAt: null } }),
        'APPROVAL_CORRUPT',
      ],
      ['approval answers an invented state', () => known, () => ({ state: 'trusted', organizationId: ORG_A, destinationKey: DK }) as never, 'APPROVAL_CORRUPT'],
      ['registry throws an unexpected error', () => { throw new Error('boom'); }, () => never, 'REGISTRY_UNAVAILABLE'],
      ['registry throws a typed corruption', () => { throw new DestinationRegistryError('DESTINATION_REGISTRY_CORRUPT', 'x'); }, () => never, 'REGISTRY_CORRUPT'],
      ['approval throws an unexpected error', () => known, () => { throw new Error('boom'); }, 'APPROVAL_UNAVAILABLE'],
      ['approval throws a typed corruption', () => known, () => { throw new DestinationApprovalError('DESTINATION_APPROVAL_CORRUPT', 'x'); }, 'APPROVAL_CORRUPT'],
    ];
    for (const [label, lookup, read, reason] of cases) {
      assert.deepEqual(resolveTrustedDestinationContext({ registry: { lookup }, approvals: { read } }, { organizationId: ORG_A, destination: D }), { kind: 'unavailable', reason }, label);
    }
  });

  it('a malformed destination or organization is unavailable, and no store is read', () => {
    let reads = 0;
    const readers = { registry: { lookup: () => ((reads += 1), { membership: 'unknown', destinationKey: DK }) as never }, approvals: { read: () => ((reads += 1), { state: 'never-approved', organizationId: ORG_A, destinationKey: DK }) as never } };
    assertUnavailable(resolveTrustedDestinationContext(readers, { organizationId: ORG_A, destination: { namespace: 'Network-A', identifier: 'x' } }), 'DESTINATION_UNDETERMINED');
    assertUnavailable(resolveTrustedDestinationContext(readers, { organizationId: ORG_A, destination: { ...D, approved: true } as ExecutionDestination }), 'DESTINATION_UNDETERMINED');
    assertUnavailable(resolveTrustedDestinationContext(readers, { organizationId: ' org-a', destination: D }), 'ORGANIZATION_UNBOUND');
    assertUnavailable(resolveTrustedDestinationContext(readers, { organizationId: '' as string, destination: D }), 'ORGANIZATION_UNBOUND');
    assert.equal(reads, 0);
  });

  it('the provider withholds — never answers false — for an undetermined destination or an unbound organization', async () => {
    const w = await world();
    w.register(D);
    w.approve(ORG_A, D);
    const reasons: TrustedDestinationUnavailableReason[] = [];
    const p = provider(w, ORG_A, (reason) => reasons.push(reason));
    for (const counterparty of [undefined, 'abc123', 'Network-A:abc123', 'network-a:abc123 ']) {
      const view = await policyView(p, kernelRequest(counterparty));
      assert.deepEqual(view.admitted, {}, String(counterparty));
      assert.deepEqual(view.reasonCodes, ['CONTEXT_REQUIRED_FACT_UNRESOLVED']);
    }
    const base: ContextResolutionQuery = { keys: ALL_KEYS, actorId: 'a', trustDomainId: 't', action: 'x', resourceScope: 'r', counterpartyId: DK, at: T0 };
    assert.deepEqual((await p.resolveContext(base)).observations, [], 'no organization');
    assert.deepEqual((await p.resolveContext({ ...base, organizationId: ORG_B })).observations, [], 'another organization');
    assert.deepEqual(reasons, ['DESTINATION_UNDETERMINED', 'DESTINATION_UNDETERMINED', 'DESTINATION_UNDETERMINED', 'DESTINATION_UNDETERMINED', 'ORGANIZATION_UNBOUND', 'ORGANIZATION_UNBOUND']);
    await w.close();
  });

  it('a failing diagnostic hook changes nothing', async () => {
    const w = await world();
    await w.registry.close();
    const p = createDestinationContextProvider({ organizationId: ORG_A, sourceIds: SOURCES, registry: w.registry, approvals: w.store, onUnavailable: () => { throw new Error('hook'); } });
    assert.deepEqual((await p.resolveContext({ keys: ALL_KEYS, actorId: 'a', trustDomainId: 't', action: 'x', resourceScope: 'r', organizationId: ORG_A, counterpartyId: DK, at: T0 })).observations, []);
    await w.store.close();
  });
});

describe('ANDREW-P0-04 — request self-assertion cannot reach trusted destination facts', () => {
  const trust = { assets: { resolve: () => undefined }, actionClassifier: { classify: () => 'non-financial' as const } } as unknown as Parameters<typeof validateGovernedActionIntent>[1];
  const base = { action: 'send-value', resource: 'treasury-example', counterparty: DK, idempotencyKey: 'idem-p004-0001' };

  it('the intake refuses every governance-shaped top-level claim, and organization scope', () => {
    assert.equal(validateGovernedActionIntent(base, trust).valid, true);
    for (const field of ['destinationKnown', 'known', 'approved', 'destinationApproved', 'approvalStatus', 'approvalState', 'registered', 'trusted', 'organizationId', 'organization', 'destination', 'governance']) {
      const result = validateGovernedActionIntent({ ...base, [field]: field === 'governance' ? { destination: { approved: true } } : true }, trust);
      assert.equal(result.valid, false, field);
    }
  });

  it('the intake refuses organization scope inside asserted context', () => {
    for (const field of ['organizationId', 'organization']) {
      assert.equal(validateGovernedActionIntent({ ...base, assertedContext: { [field]: ORG_B } }, trust).valid, false, field);
    }
  });

  it('claims smuggled anywhere in the Kernel request change no trusted fact: the trusted value is resolved independently', async () => {
    const w = await world();
    w.register(D);
    const forged = kernelRequest(DK, ORG_A, {
      context: { destinationApproved: true, approved: true, approvalState: 'approved', destinationKnown: true, governance: { destination: { approved: true } }, [F.approved]: true },
    });
    const view = await policyView(provider(w), forged);
    assert.deepEqual(view.admitted, { [F.approvalState]: 'never-approved', [F.approved]: false, [F.key]: DK, [F.known]: true });
    await w.close();
  });

  it('a forged reading cannot ride along: an observation from an unconfigured source, or claiming another organization, is refused at the boundary', async () => {
    const w = await world();
    w.register(D);
    const honest = provider(w);
    const smuggling: ContextProvider = {
      async resolveContext(query) {
        const { observations } = await honest.resolveContext(query);
        const forged = observations.map((o) => (o.key === F.approved ? { ...o, value: true } : o));
        return { observations: forged };
      },
    };
    const view = await policyView(smuggling, kernelRequest(DK));
    assert.equal(view.admitted[F.approved], undefined, 'a value altered after its provenance digest is refused');
    assert.notEqual(view.reasonCodes.length, 0);
    await w.close();
  });
});

describe('ANDREW-P0-04 — read-only: resolution never mutates governance', () => {
  it('no register, approve or revoke is reachable, and stored registry and approval history are unchanged', async () => {
    const w = await world();
    w.register(D);
    w.approve(ORG_A, D);
    const calls: string[] = [];
    const spyRegistry = { lookup: (d: ExecutionDestination) => w.registry.lookup(d), register: () => void calls.push('register') };
    const spyStore = { read: (q: Parameters<DestinationApprovalReaderPort['read']>[0]) => w.store.read(q), history: () => (calls.push('history'), []), approve: () => void calls.push('approve'), revoke: () => void calls.push('revoke') };
    const count = (path: string, table: string) => {
      const db = new Database(path, { readonly: true });
      const n = (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      db.close();
      return n;
    };
    const before = { registry: count(w.registryPath, 'registered_destinations'), events: count(w.approvalPath, 'destination_approval_events'), commands: count(w.approvalPath, 'destination_approval_commands'), history: JSON.stringify(w.store.history({ organizationId: ORG_A, destination: D })) };
    const p = createDestinationContextProvider({ organizationId: ORG_A, sourceIds: SOURCES, registry: spyRegistry as unknown as DestinationRegistryReaderPort, approvals: spyStore as unknown as DestinationApprovalReaderPort });
    for (let index = 0; index < 5; index += 1) {
      await policyView(p, kernelRequest(DK));
      await policyView(p, kernelRequest('network-a:never-registered'));
    }
    assert.deepEqual(calls, []);
    assert.deepEqual(
      { registry: count(w.registryPath, 'registered_destinations'), events: count(w.approvalPath, 'destination_approval_events'), commands: count(w.approvalPath, 'destination_approval_commands'), history: JSON.stringify(w.store.history({ organizationId: ORG_A, destination: D })) },
      before,
    );
    // Resolving an unknown destination does not register it.
    assert.equal(w.registry.lookup(destination('network-a', 'never-registered')).membership, 'unknown');
    await w.close();
  });

  it('the provider holds no reference to the composed objects beyond their read functions', async () => {
    const w = await world();
    const p = createDestinationContextProvider({ organizationId: ORG_A, sourceIds: SOURCES, registry: w.registry, approvals: w.store });
    assert.deepEqual(Object.keys(p), ['resolveContext']);
    const text = JSON.stringify(p);
    assert.equal(/approve|revoke|register/.test(text), false);
    await w.close();
  });
});

describe('ANDREW-P0-04 — policy-facing facts through the one Trusted Context Boundary', () => {
  it('admitted facts carry the full state and the derived active approval; readings are org-scoped, digested and source-attributed', async () => {
    const w = await world();
    w.register(D);
    w.approve(ORG_A, D);
    const p = provider(w);
    const output = await p.resolveContext({ keys: ALL_KEYS, actorId: 'a', trustDomainId: 't', action: 'send-value', resourceScope: 'r', organizationId: ORG_A, counterpartyId: DK, at: T0 });
    for (const observation of output.observations) {
      assert.equal(observation.organizationId, ORG_A);
      assert.equal(observation.observedAt, T0);
      assert.match(observation.provenanceDigest ?? '', /^sha256:/);
      assert.ok((observation.reference ?? '').length <= 256);
      assert.equal(observation.sourceId, observation.key === F.key || observation.key === F.known ? SOURCES.registry : SOURCES.approval);
    }
    const view = await policyView(p, kernelRequest(DK));
    assert.deepEqual(view.admitted, { [F.approvalState]: 'approved', [F.approved]: true, [F.key]: DK, [F.known]: true });
    assert.deepEqual(view.reasonCodes, []);
    await w.close();
  });

  it('answers only the destination keys asked for, and nothing when none is asked', async () => {
    const w = await world();
    w.register(D);
    const p = provider(w);
    const q = (keys: readonly string[]): ContextResolutionQuery => ({ keys, actorId: 'a', trustDomainId: 't', action: 'x', resourceScope: 'r', organizationId: ORG_A, counterpartyId: DK, at: T0 });
    assert.deepEqual((await p.resolveContext(q([F.known]))).observations.map((o) => o.key), [F.known]);
    assert.deepEqual((await p.resolveContext(q(['invoice.exists']))).observations, []);
    await w.close();
  });

  it('the Kernel passes the request counterparty — and only the typed axis — to the resolver', async () => {
    const queries: ContextResolutionQuery[] = [];
    const recording: ContextProvider = { resolveContext: (query) => (queries.push(query), Promise.resolve({ observations: [] })) };
    await policyView(recording, kernelRequest(DK));
    await policyView(recording, kernelRequest(undefined));
    assert.equal(queries[0]?.counterpartyId, DK);
    assert.equal(queries[0]?.organizationId, ORG_A);
    assert.equal('counterpartyId' in (queries[1] ?? {}), false);
  });

  it('composition refuses a provider without a well-formed served organization, source ids or readers', async () => {
    const w = await world();
    const ok = { organizationId: ORG_A, sourceIds: SOURCES, registry: w.registry, approvals: w.store };
    assert.throws(() => createDestinationContextProvider({ ...ok, organizationId: '' }), TypeError);
    assert.throws(() => createDestinationContextProvider({ ...ok, sourceIds: { registry: '', approval: 'x' } }), TypeError);
    assert.throws(() => createDestinationContextProvider({ ...ok, registry: {} as DestinationRegistryReaderPort }), TypeError);
    assert.throws(() => createDestinationContextProvider({ ...ok, approvals: {} as DestinationApprovalReaderPort }), TypeError);
    await w.close();
  });
});
