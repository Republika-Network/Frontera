import { describe, it, after, type TestContext } from 'node:test';
import assert from 'node:assert/strict';

import { createAocKernel, type KernelEvaluationRequest } from '../../kernel/index.js';
import {
  KERNEL_AUTHORITY_SCHEMA_VERSION,
  type AppendKernelAuthorityEventInput,
  type KernelAuthorityAccessContext,
  type KernelAuthorityEntityKind,
  type KernelAuthorityEntityStatus,
  type KernelAuthorityStoreProviderKind,
  type ProvisionActorInput,
  type ProvisionCapabilityTokenInput,
  type ProvisionTrustDomainInput,
} from '../kernel-authority/contracts.js';
import { createDurableKernelProviders } from '../kernel-authority/durable-kernel-providers.js';
import { KernelAuthorityError, type KernelAuthorityErrorCode } from '../kernel-authority/errors.js';
import type { KernelAuthorityStore } from '../kernel-authority/kernel-authority-store.js';
import { createKernelAuthorityProvisioningService, type KernelAuthorityProvisioningService } from '../kernel-authority/provisioning-service.js';
import {
  DURABLE_FIXTURE_OTHER_ACTION,
  DURABLE_FIXTURE_OTHER_RESOURCE_SCOPE,
  DURABLE_FIXTURE_OUTSIDER_ACTOR_ID,
  buildDurableFixtureRequest,
  provisionDurableAuthorityFixture,
} from '../kernel-authority/fixtures/durable-authority.fixture.js';

/**
 * The Kernel Authority Store conformance suite (FRONTERA-PROD-01).
 *
 * One set of behavioural assertions every `KernelAuthorityStore` provider must
 * pass unchanged -- memory and SQLite today, a network-durable provider next.
 * A provider supplies only how to open an isolated store and, optionally, how
 * to reach its persisted representation; it never supplies an expectation.
 * See `docs/architecture/ADR-NETWORK-DURABLE-KERNEL-AUTHORITY-STORE.md`.
 *
 * Nothing here inspects a provider's tables. Where a property can only be
 * exercised by damaging persisted state or by racing independent writers, the
 * provider exposes that as a capability (`tamper`, `race`, `reopen`). A
 * provider that has no such representation -- the in-memory store has no
 * state outside its own process -- declares it absent and the case is
 * reported as skipped with the reason, never counted as passed.
 */

/** Identifies one entity's chain inside a provider's persisted representation. */
export interface ConformanceEntityKey {
  readonly organizationId: string;
  readonly entityKind: KernelAuthorityEntityKind;
  readonly entityId: string;
}

/**
 * Direct edits to a provider's persisted representation, standing in for an
 * attacker or a fault with write access to the storage itself (a file, a
 * database role) rather than to the store's API. Each method changes exactly
 * the named fact and nothing else -- in particular, never a digest column it
 * was not asked to change.
 */
export interface KernelAuthorityStoreTamper {
  /** Replaces one event's persisted payload. The event's stored digest is left as it was. */
  rewriteEventPayload(key: ConformanceEntityKey, sequence: number, payload: Readonly<Record<string, unknown>>): Promise<void>;
  /** Replaces one event's recorded predecessor digest. Its own stored digest is left as it was. */
  rewriteEventPreviousDigest(key: ConformanceEntityKey, sequence: number, previousEventDigest: string): Promise<void>;
  /** Moves one event to a different sequence number. */
  renumberEvent(key: ConformanceEntityKey, fromSequence: number, toSequence: number): Promise<void>;
  /** Removes one event. */
  deleteEvent(key: ConformanceEntityKey, sequence: number): Promise<void>;
  /** Rewrites the independently-stored chain head (the length/digest the chain must reconstruct to). */
  rewriteHead(key: ConformanceEntityKey, head: { readonly latestSequence?: number; readonly latestEventDigest?: string }): Promise<void>;
  /** Rewrites any derived projection of current state a provider keeps beside the events. */
  rewriteProjection(key: ConformanceEntityKey, projection: { readonly status?: KernelAuthorityEntityStatus; readonly payload?: Readonly<Record<string, unknown>> }): Promise<void>;
}

/** One independent writer in a race: its own connection/handle onto the same backing state. */
export interface ConformanceRaceParticipant {
  readonly context: KernelAuthorityAccessContext;
  readonly inputs: readonly AppendKernelAuthorityEventInput[];
}

export type ConformanceAppendOutcome =
  | { readonly outcome: 'appended' | 'replayed'; readonly sequence: number }
  /** `code` is a `KernelAuthorityErrorCode`, or `unclassified:<name>` for anything else that escaped the store. */
  | { readonly outcome: 'refused'; readonly code: string };

export interface ConformanceStoreOptions {
  /** Injected clock. Providers must honour it so digests are reproducible across providers. */
  readonly now?: () => string;
  /** Injected id source. Providers must honour it for the same reason. */
  readonly nextId?: (prefix: string) => string;
}

export interface ConformanceStoreHandle {
  readonly store: KernelAuthorityStore;
  /** Absent when the provider keeps no representation outside the store object itself. */
  readonly tamper?: KernelAuthorityStoreTamper;
  /**
   * Runs every participant against the same backing state from independent
   * handles, released together, and returns each participant's outcomes in
   * input order. Absent when the provider has no second handle to offer.
   */
  readonly race?: (participants: readonly ConformanceRaceParticipant[]) => Promise<readonly (readonly ConformanceAppendOutcome[])[]>;
  /** Opens a new handle over the same backing state -- a restarted process. Absent for a non-durable provider. */
  readonly reopen?: () => Promise<KernelAuthorityStore>;
  /** A human-readable statement of what `race` actually exercises for this provider. */
  readonly raceIsolation?: string;
}

export interface KernelAuthorityStoreConformanceProvider {
  readonly providerName: string;
  readonly expectedProviderKind: KernelAuthorityStoreProviderKind;
  /** Opens a fresh, empty store isolated from every other case. */
  readonly createStore: (label: string, options?: ConformanceStoreOptions) => Promise<ConformanceStoreHandle>;
  /** Releases everything `createStore` acquired. Called once, after the suite. */
  readonly cleanup: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Shared fixtures. Deliberately small and explicit: a conformance failure has
// to be readable without a debugger.
// ---------------------------------------------------------------------------

const ORG = 'org-acme';
const OTHER_ORG = 'org-beta';
const OPERATOR: KernelAuthorityAccessContext = { system: true, actorId: 'operator-1' };
const READER: KernelAuthorityAccessContext = { system: false, organizationId: ORG };
const OTHER_READER: KernelAuthorityAccessContext = { system: false, organizationId: OTHER_ORG };
const ACTOR: ProvisionActorInput = { actorId: 'actor-alice', type: 'human', displayName: 'Alice' };
const EXTERNAL_SUBJECT = { system: 'example-app', subjectId: 'external-user-42' } as const;

function actorKey(actorId: string, organizationId = ORG): ConformanceEntityKey {
  return { organizationId, entityKind: 'actor', entityId: actorId };
}

function actorAppend(actor: ProvisionActorInput, organizationId = ORG, idempotencyKey?: string): AppendKernelAuthorityEventInput {
  return {
    organizationId,
    entityKind: 'actor',
    entityId: actor.actorId,
    eventType: 'KernelAuthorityEntityProvisioned',
    payload: { ...actor },
    ...(idempotencyKey !== undefined ? { idempotency: { idempotencyKey } } : {}),
  };
}

function rejectsWith(code: KernelAuthorityErrorCode): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof KernelAuthorityError, `expected a KernelAuthorityError(${code}), got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  };
}

/** The single instant the golden clock reports. */
const GOLDEN_NOW = '2026-03-01T12:00:00.000Z';

/**
 * A deterministic clock and id source. The golden digests below are only
 * reproducible because every provider honours these rather than its own.
 *
 * The clock is constant on purpose: how many times a provider consults it
 * (SQLite also stamps its schema-version row and idempotency claims) is an
 * implementation detail, and a ticking clock would make the digests depend on
 * it. Ids are counted per prefix for the same reason.
 */
function deterministicOptions(): Required<ConformanceStoreOptions> {
  const counters = new Map<string, number>();
  return {
    now: () => GOLDEN_NOW,
    nextId: (prefix: string) => {
      const next = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, next);
      return `${prefix}-golden-${next}`;
    },
  };
}

/**
 * GOLDEN canonical event digests (`aoc.canonical-json.v1`, sha256) for the
 * fixed event sequence in `provisionGoldenSequence`, under the deterministic
 * clock and id source above.
 *
 * These are compatibility constants, not snapshots to be refreshed: memory and
 * SQLite both reproduce them today, and a new provider is conformant only if
 * it reproduces them byte-for-byte. A provider that normalizes a payload, a
 * timestamp, a sequence number or an absent predecessor digest on the way
 * through storage will fail here -- and the same provider would fail every
 * integrity check on real authority, closed. If one of these ever has to
 * change, every persisted authority store has changed meaning with it.
 */
export const GOLDEN_KERNEL_AUTHORITY_EVENT_DIGESTS = {
  issuerActor: 'sha256:7c8e0ddc11f1b3534af7941ac41c928a128f90c5e2be43e7b2c3593c865a2880',
  trustDomain: 'sha256:cc98f34fe8e86286e10ba6ac608b97fe19e1dff3dcbf2141bb5b4f9c9bd67405',
  subjectActor: 'sha256:c75baa55d97b9eced2c90c5ad8a10fcae8f5d4e4d4f04c83b85bea63ff6d5fc2',
  capabilityToken: 'sha256:e1cedf56d49bf21cc10dee0dfbd4210bbe21e84f37442dd9bb1811c20098c806',
  capabilityTokenRevocation: 'sha256:c9c5546f3c377ed9cdf02d2b404f3821b2ee60eca6a763c3b730368e12eaff1c',
} as const;

const GOLDEN_ISSUER: ProvisionActorInput = { actorId: 'actor-org-acme', type: 'organization', displayName: 'Acme Corporation' };
// Keys deliberately out of lexicographic order, and a display name outside
// ASCII with a quote in it: canonicalization, not insertion order or escaping
// accidents, must decide the digest.
const GOLDEN_SUBJECT: ProvisionActorInput = {
  type: 'human',
  displayName: 'Álvaro "Al" Núñez — 検証 🚀',
  actorId: 'actor-alvaro',
  trustDomainId: 'trust-domain-acme',
  externalSubject: { subjectId: 'user-0001', system: 'example-app' },
  metadata: { team: 'ops', cost_center: '0042' },
};
const GOLDEN_TRUST_DOMAIN: ProvisionTrustDomainInput = {
  trustDomainId: 'trust-domain-acme',
  name: 'Acme',
  issuerActorId: 'actor-org-acme',
  acceptedIssuerIds: ['actor-org-acme'],
  acceptedActorTypes: ['human', 'agent'],
};
const GOLDEN_TOKEN: ProvisionCapabilityTokenInput = {
  capabilityTokenId: 'cap-alvaro-1',
  subjectActorId: 'actor-alvaro',
  principalActorId: 'actor-alvaro',
  issuerActorId: 'actor-org-acme',
  trustDomainId: 'trust-domain-acme',
  capability: 'material-action.execute',
  actions: ['execute.material-action'],
  resourceScopes: ['project:alpha', 'project:beta'],
  riskLevel: 'medium',
  delegable: true,
  maxDelegationDepth: 2,
};
/** An operator-supplied event time in a valid but non-normalized ISO-8601 form. It must round-trip as written. */
const GOLDEN_OCCURRED_AT = '2026-03-01T13:00:00.5+01:00';

async function provisionGoldenSequence(service: KernelAuthorityProvisioningService): Promise<void> {
  await service.provisionActor(OPERATOR, GOLDEN_ISSUER);
  await service.provisionTrustDomain(OPERATOR, GOLDEN_TRUST_DOMAIN);
  await service.provisionActor(OPERATOR, GOLDEN_SUBJECT, { idempotency: { idempotencyKey: 'golden-subject' }, occurredAt: GOLDEN_OCCURRED_AT });
  await service.provisionCapabilityToken(OPERATOR, GOLDEN_TOKEN);
  await service.revoke(OPERATOR, { entityKind: 'capability-token', entityId: GOLDEN_TOKEN.capabilityTokenId, reason: 'rotated' });
}

/**
 * Recorded, named departures from the contract, keyed by `providerName` then
 * by gap id. A case listed here still runs and is reported as TODO, never as a
 * pass, and the ADR records each entry. This list only ever shrinks: a new
 * provider may not be certified with an entry of its own.
 */
export const KNOWN_CONFORMANCE_GAPS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  sqlite: {
    'race-loser-classification':
      'FRONTERA-PROD-01 F1: under genuinely independent connections a losing SQLite writer receives a raw SQLITE_BUSY instead of the replay/conflict the serial order implies (deferred transaction cannot upgrade to a write lock under WAL). Safety holds; classification does not.',
  },
};

// ---------------------------------------------------------------------------
// The suite.
// ---------------------------------------------------------------------------

export function runKernelAuthorityStoreConformance(provider: KernelAuthorityStoreConformanceProvider): void {
  const opened: KernelAuthorityStore[] = [];
  after(async () => {
    await Promise.all(opened.map((store) => store.close().catch(() => {})));
    await provider.cleanup();
  });

  async function open(label: string, options?: ConformanceStoreOptions): Promise<ConformanceStoreHandle & { readonly service: KernelAuthorityProvisioningService }> {
    const handle = await provider.createStore(label, options);
    opened.push(handle.store);
    return { ...handle, service: createKernelAuthorityProvisioningService({ store: handle.store, organizationId: ORG }) };
  }

  async function reopenOrSkip(handle: ConformanceStoreHandle): Promise<KernelAuthorityStore> {
    assert.ok(handle.reopen !== undefined);
    const store = await handle.reopen();
    opened.push(store);
    return store;
  }

  const name = provider.providerName;

  describe(`Kernel Authority Store conformance [${name}]: foundation`, () => {
    it('reports an empty store as healthy, readable, writable and current', async () => {
      const { store } = await open('empty-health');
      const health = await store.health();
      assert.equal(store.providerKind, provider.expectedProviderKind);
      assert.deepEqual(health, {
        providerKind: provider.expectedProviderKind,
        status: 'healthy',
        readable: true,
        writable: true,
        schemaVersion: KERNEL_AUTHORITY_SCHEMA_VERSION,
        migrationState: 'current',
        recordCount: 0,
      });
    });

    it('answers every read on an empty store with its empty value, never an error and never a minted record', async () => {
      const { store } = await open('empty-reads');
      assert.equal(await store.getRecord(READER, ORG, 'actor', ACTOR.actorId), null);
      assert.deepEqual(await store.listRecords(READER, { organizationId: ORG }), []);
      assert.deepEqual(await store.listEvents(READER, ORG, 'actor', ACTOR.actorId), []);
      assert.equal(await store.findActorByExternalSubject(READER, ORG, EXTERNAL_SUBJECT), null);
      // A read creates nothing.
      assert.equal((await store.health()).recordCount, 0);
    });

    it('appends a first entity at sequence 1 with no predecessor and returns its reconstructed record', async () => {
      const { store } = await open('first-append');
      const result = await store.appendEvent(OPERATOR, actorAppend(ACTOR));

      assert.equal(result.replayed, false);
      assert.equal(result.event.sequence, 1);
      assert.equal(result.event.previousEventDigest, undefined);
      assert.equal(result.event.eventType, 'KernelAuthorityEntityProvisioned');
      assert.equal(result.event.provisionedBy, 'operator-1');
      assert.equal(result.event.schemaVersion, KERNEL_AUTHORITY_SCHEMA_VERSION);
      assert.match(result.event.eventDigest, /^sha256:[0-9a-f]{64}$/);
      assert.equal(result.record.status, 'active');
      assert.equal(result.record.latestSequence, 1);
      assert.equal(result.record.latestEventDigest, result.event.eventDigest);
    });

    it('reads back exactly what the append returned', async () => {
      const { store } = await open('read-back');
      const result = await store.appendEvent(OPERATOR, actorAppend(ACTOR));

      assert.deepEqual(await store.getRecord(READER, ORG, 'actor', ACTOR.actorId), result.record);
      assert.deepEqual(await store.listEvents(READER, ORG, 'actor', ACTOR.actorId), [result.event]);
      assert.deepEqual(await store.listRecords(READER, { organizationId: ORG }), [result.record]);
      assert.equal((await store.health()).recordCount, 1);
    });

    it('lists records in the deterministic (kind in declared order, then id) order whatever the provisioning order', async () => {
      const { store, service } = await open('list-order');
      await service.provisionActor(OPERATOR, { actorId: 'actor-zed', type: 'human', displayName: 'Zed' });
      await service.provisionTrustDomain(OPERATOR, GOLDEN_TRUST_DOMAIN);
      await service.provisionActor(OPERATOR, { actorId: 'actor-amy', type: 'human', displayName: 'Amy' });

      const keys = (await store.listRecords(READER, { organizationId: ORG })).map((record) => `${record.entityKind}:${record.entityId}`);
      assert.deepEqual(keys, ['actor:actor-amy', 'actor:actor-zed', 'trust-domain:trust-domain-acme']);
    });

    it('filters listed records by kind, trust domain and status', async () => {
      const { store, service } = await open('list-filters');
      await service.provisionActor(OPERATOR, { actorId: 'actor-in-domain', type: 'human', displayName: 'In', trustDomainId: 'trust-domain-acme' });
      await service.provisionActor(OPERATOR, { actorId: 'actor-no-domain', type: 'human', displayName: 'Out' });
      await service.provisionTrustDomain(OPERATOR, GOLDEN_TRUST_DOMAIN);
      await service.revoke(OPERATOR, { entityKind: 'actor', entityId: 'actor-no-domain', reason: 'offboarded' });

      const ids = async (query: Parameters<KernelAuthorityStore['listRecords']>[1]) => (await store.listRecords(READER, query)).map((record) => record.entityId);
      assert.deepEqual(await ids({ organizationId: ORG, entityKind: 'actor' }), ['actor-in-domain', 'actor-no-domain']);
      assert.deepEqual(await ids({ organizationId: ORG, trustDomainId: 'trust-domain-acme' }), ['actor-in-domain', 'trust-domain-acme']);
      assert.deepEqual(await ids({ organizationId: ORG, status: 'revoked' }), ['actor-no-domain']);
      assert.deepEqual(await ids({ organizationId: ORG, entityKind: 'actor', status: 'active' }), ['actor-in-domain']);
    });

    it('lists an entity events oldest first', async () => {
      const { store, service } = await open('list-events');
      await service.provisionActor(OPERATOR, ACTOR);
      await service.revoke(OPERATOR, { entityKind: 'actor', entityId: ACTOR.actorId, reason: 'offboarded' });
      const events = await store.listEvents(READER, ORG, 'actor', ACTOR.actorId);
      assert.deepEqual(
        events.map((event) => [event.sequence, event.eventType]),
        [
          [1, 'KernelAuthorityEntityProvisioned'],
          [2, 'KernelAuthorityEntityRevoked'],
        ],
      );
    });

    it('refuses every read and write after close, reports unhealthy, and closes idempotently', async () => {
      const { store, service } = await open('closed');
      await service.provisionActor(OPERATOR, ACTOR);
      await store.close();

      const unavailable = rejectsWith('KERNEL_AUTHORITY_STORE_UNAVAILABLE');
      await assert.rejects(() => store.appendEvent(OPERATOR, actorAppend({ ...ACTOR, actorId: 'actor-bob' })), unavailable);
      await assert.rejects(() => store.getRecord(READER, ORG, 'actor', ACTOR.actorId), unavailable);
      await assert.rejects(() => store.listRecords(READER, { organizationId: ORG }), unavailable);
      await assert.rejects(() => store.listEvents(READER, ORG, 'actor', ACTOR.actorId), unavailable);
      await assert.rejects(() => store.findActorByExternalSubject(READER, ORG, EXTERNAL_SUBJECT), unavailable);

      const health = await store.health();
      assert.equal(health.status, 'unhealthy');
      assert.equal(health.readable, false);
      assert.equal(health.writable, false);

      await store.close();
    });

    it('reports health as fixed vocabulary and counts only, never authority content', async () => {
      const { store, service } = await open('health-content');
      await service.provisionActor(OPERATOR, { ...ACTOR, externalSubject: EXTERNAL_SUBJECT });
      const serialized = JSON.stringify(await store.health());
      for (const secret of [ACTOR.actorId, ACTOR.displayName, EXTERNAL_SUBJECT.subjectId, ORG, 'operator-1']) {
        assert.ok(!serialized.includes(secret), `health must not disclose '${secret}'`);
      }
    });
  });

  describe(`Kernel Authority Store conformance [${name}]: operator boundary`, () => {
    it('refuses every write from a non-operator context, so an evaluation can never provision', async () => {
      const { store } = await open('operator-guard');
      for (const context of [READER, { system: false, organizationId: ORG, actorId: 'actor-alice' }, { system: false }] as const) {
        await assert.rejects(() => store.appendEvent(context, actorAppend(ACTOR)), rejectsWith('KERNEL_AUTHORITY_OPERATOR_CONTEXT_REQUIRED'));
      }
      assert.equal((await store.health()).recordCount, 0);
    });

    it('refuses an operator context that does not name the operator, so every write is attributable', async () => {
      const { store } = await open('operator-identity');
      await assert.rejects(() => store.appendEvent({ system: true }, actorAppend(ACTOR)), rejectsWith('KERNEL_AUTHORITY_OPERATOR_CONTEXT_REQUIRED'));
    });

    it('refuses a structurally invalid append before consulting any state', async () => {
      const { store } = await open('append-validation');
      const invalid: readonly AppendKernelAuthorityEventInput[] = [
        { ...actorAppend(ACTOR), organizationId: ' ' },
        { ...actorAppend(ACTOR), entityId: '' },
        { ...actorAppend(ACTOR), entityKind: 'super-actor' as KernelAuthorityEntityKind },
        { ...actorAppend(ACTOR), eventType: 'KernelAuthorityEntityRestored' as AppendKernelAuthorityEventInput['eventType'] },
      ];
      for (const input of invalid) {
        await assert.rejects(() => store.appendEvent(OPERATOR, input), rejectsWith('KERNEL_AUTHORITY_VALIDATION_ERROR'));
      }
      assert.equal((await store.health()).recordCount, 0);
    });

    it('keeps the provisioning service rules: no revocation of a boundary entity, and every revocation states a reason', async () => {
      const { service } = await open('service-rules');
      await service.provisionActor(OPERATOR, ACTOR);
      for (const entityKind of ['trust-domain', 'root-issuer'] as const) {
        await assert.rejects(() => service.revoke(OPERATOR, { entityKind, entityId: 'x', reason: 'retiring' }), rejectsWith('KERNEL_AUTHORITY_VALIDATION_ERROR'));
      }
      await assert.rejects(() => service.revoke(OPERATOR, { entityKind: 'actor', entityId: ACTOR.actorId, reason: '  ' }), rejectsWith('KERNEL_AUTHORITY_VALIDATION_ERROR'));
    });
  });

  describe(`Kernel Authority Store conformance [${name}]: organization isolation`, () => {
    it('keeps the same entity id in two organizations as two independent entities', async () => {
      const { store } = await open('same-id-two-orgs');
      const acme = await store.appendEvent(OPERATOR, actorAppend(ACTOR, ORG));
      const beta = await store.appendEvent(OPERATOR, actorAppend({ ...ACTOR, displayName: 'Alice of Beta' }, OTHER_ORG));

      assert.equal(acme.replayed, false);
      assert.equal(beta.replayed, false, 'a different payload under the same id in another organization is not a conflict');
      assert.equal(beta.event.sequence, 1);
      assert.equal((await store.getRecord(READER, ORG, 'actor', ACTOR.actorId))?.payload.displayName, 'Alice');
      assert.equal((await store.getRecord(OTHER_READER, OTHER_ORG, 'actor', ACTOR.actorId))?.payload.displayName, 'Alice of Beta');

      // Revoking one leaves the other live.
      await store.appendEvent(OPERATOR, { organizationId: OTHER_ORG, entityKind: 'actor', entityId: ACTOR.actorId, eventType: 'KernelAuthorityEntityRevoked', payload: { reason: 'offboarded' } });
      assert.equal((await store.getRecord(READER, ORG, 'actor', ACTOR.actorId))?.status, 'active');
    });

    it('refuses every organization-scoped read that names another organization, or none', async () => {
      const { store, service } = await open('cross-org-reads');
      await service.provisionActor(OPERATOR, { ...ACTOR, externalSubject: EXTERNAL_SUBJECT });

      const violation = rejectsWith('KERNEL_AUTHORITY_ACCESS_SCOPE_VIOLATION');
      await assert.rejects(() => store.getRecord(OTHER_READER, ORG, 'actor', ACTOR.actorId), violation);
      await assert.rejects(() => store.listRecords(OTHER_READER, { organizationId: ORG }), violation);
      await assert.rejects(() => store.listEvents(OTHER_READER, ORG, 'actor', ACTOR.actorId), violation);
      await assert.rejects(() => store.findActorByExternalSubject(OTHER_READER, ORG, EXTERNAL_SUBJECT), violation);

      const unscoped = rejectsWith('KERNEL_AUTHORITY_TENANT_SCOPE_REQUIRED');
      await assert.rejects(() => store.listRecords({ system: false }, { organizationId: ORG }), unscoped);
      await assert.rejects(() => store.getRecord({ system: false, organizationId: '' }, ORG, 'actor', ACTOR.actorId), unscoped);
    });

    it('never returns one organization records to another organization query', async () => {
      const { store, service } = await open('tenancy-list');
      const other = createKernelAuthorityProvisioningService({ store, organizationId: OTHER_ORG });
      await service.provisionActor(OPERATOR, ACTOR);
      await other.provisionActor(OPERATOR, { actorId: 'actor-beta-only', type: 'human', displayName: 'Beta' });

      assert.deepEqual((await store.listRecords(READER, { organizationId: ORG })).map((record) => [record.organizationId, record.entityId]), [[ORG, ACTOR.actorId]]);
      assert.deepEqual((await store.listRecords(OTHER_READER, { organizationId: OTHER_ORG })).map((record) => [record.organizationId, record.entityId]), [[OTHER_ORG, 'actor-beta-only']]);
      assert.equal(await store.getRecord(OTHER_READER, OTHER_ORG, 'actor', ACTOR.actorId), null);
    });

    it('scopes external-subject resolution to its organization', async () => {
      const { store, service } = await open('subject-org-scope');
      await service.provisionActor(OPERATOR, { ...ACTOR, externalSubject: EXTERNAL_SUBJECT });
      assert.equal(await store.findActorByExternalSubject(OTHER_READER, OTHER_ORG, EXTERNAL_SUBJECT), null);
    });

    it('lets a system (operator) context read any organization explicitly named', async () => {
      const { store, service } = await open('system-read');
      await service.provisionActor(OPERATOR, ACTOR);
      assert.equal((await store.getRecord(OPERATOR, ORG, 'actor', ACTOR.actorId))?.entityId, ACTOR.actorId);
    });
  });

  describe(`Kernel Authority Store conformance [${name}]: provisioning`, () => {
    it('provisions an entity once and replays an identical re-provision without a second event', async () => {
      const { store, service } = await open('provision-replay');
      const first = await service.provisionActor(OPERATOR, ACTOR);
      const second = await service.provisionActor(OPERATOR, ACTOR);

      assert.equal(first.replayed, false);
      assert.equal(second.replayed, true);
      assert.deepEqual(second.record, first.record);
      assert.equal((await store.listEvents(READER, ORG, 'actor', ACTOR.actorId)).length, 1);
    });

    it('treats payloads that differ only in key order as the same payload', async () => {
      const { service } = await open('provision-key-order');
      await service.provisionActor(OPERATOR, { actorId: ACTOR.actorId, type: ACTOR.type, displayName: ACTOR.displayName });
      const reordered = await service.provisionActor(OPERATOR, { displayName: ACTOR.displayName, type: ACTOR.type, actorId: ACTOR.actorId });
      assert.equal(reordered.replayed, true);
    });

    it('refuses a re-provision that changes the terms, rather than widening authority in place', async () => {
      const { store, service } = await open('provision-conflict');
      await service.provisionActor(OPERATOR, ACTOR);
      await assert.rejects(() => service.provisionActor(OPERATOR, { ...ACTOR, type: 'organization' }), rejectsWith('KERNEL_AUTHORITY_ENTITY_CONFLICT'));
      assert.equal((await store.getRecord(READER, ORG, 'actor', ACTOR.actorId))?.payload.type, 'human');
      assert.equal((await store.listEvents(READER, ORG, 'actor', ACTOR.actorId)).length, 1);
    });
  });

  describe(`Kernel Authority Store conformance [${name}]: external subject binding`, () => {
    it('binds one external subject to one actor and resolves it', async () => {
      const { store, service } = await open('subject-bind');
      await service.provisionActor(OPERATOR, { ...ACTOR, externalSubject: EXTERNAL_SUBJECT });
      const resolved = await store.findActorByExternalSubject(READER, ORG, EXTERNAL_SUBJECT);
      assert.equal(resolved?.entityId, ACTOR.actorId);
      assert.equal(resolved?.status, 'active');
    });

    it('refuses to bind the same external subject to a second actor', async () => {
      const { store, service } = await open('subject-conflict');
      await service.provisionActor(OPERATOR, { ...ACTOR, externalSubject: EXTERNAL_SUBJECT });
      await assert.rejects(
        () => service.provisionActor(OPERATOR, { actorId: 'actor-mallory', type: 'human', displayName: 'Mallory', externalSubject: EXTERNAL_SUBJECT }),
        rejectsWith('KERNEL_AUTHORITY_EXTERNAL_SUBJECT_CONFLICT'),
      );
      assert.equal(await store.getRecord(READER, ORG, 'actor', 'actor-mallory'), null, 'the conflicting actor must not be provisioned either');
      assert.equal((await store.findActorByExternalSubject(READER, ORG, EXTERNAL_SUBJECT))?.entityId, ACTOR.actorId);
    });

    it('treats the subject system as part of the identity: the same subject id in another system is another subject', async () => {
      const { store, service } = await open('subject-system');
      await service.provisionActor(OPERATOR, { ...ACTOR, externalSubject: EXTERNAL_SUBJECT });
      await service.provisionActor(OPERATOR, { actorId: 'actor-okta-42', type: 'human', displayName: 'Okta 42', externalSubject: { system: 'okta', subjectId: EXTERNAL_SUBJECT.subjectId } });
      assert.equal((await store.findActorByExternalSubject(READER, ORG, { system: 'okta', subjectId: EXTERNAL_SUBJECT.subjectId }))?.entityId, 'actor-okta-42');
      assert.equal((await store.findActorByExternalSubject(READER, ORG, EXTERNAL_SUBJECT))?.entityId, ACTOR.actorId);
    });

    it('keeps identical subject values in another organization bound independently', async () => {
      const { store, service } = await open('subject-two-orgs');
      const other = createKernelAuthorityProvisioningService({ store, organizationId: OTHER_ORG });
      await service.provisionActor(OPERATOR, { ...ACTOR, externalSubject: EXTERNAL_SUBJECT });
      await other.provisionActor(OPERATOR, { actorId: 'actor-beta-alice', type: 'human', displayName: 'Alice (Beta)', externalSubject: EXTERNAL_SUBJECT });

      assert.equal((await store.findActorByExternalSubject(READER, ORG, EXTERNAL_SUBJECT))?.entityId, ACTOR.actorId);
      assert.equal((await store.findActorByExternalSubject(OTHER_READER, OTHER_ORG, EXTERNAL_SUBJECT))?.entityId, 'actor-beta-alice');
    });

    it('resolves a revoked actor as revoked, and keeps the binding: the subject is not rebindable to a new actor', async () => {
      // Current contract, recorded rather than implied: a binding outlives its
      // actor's revocation. The resolver reports the revoked actor (so a
      // consumer can deny with a truthful reason) and a replacement actor may
      // not claim the same subject in the same organization.
      const { store, service } = await open('subject-after-revoke');
      await service.provisionActor(OPERATOR, { ...ACTOR, externalSubject: EXTERNAL_SUBJECT });
      await service.revoke(OPERATOR, { entityKind: 'actor', entityId: ACTOR.actorId, reason: 'offboarded' });

      assert.equal((await store.findActorByExternalSubject(READER, ORG, EXTERNAL_SUBJECT))?.status, 'revoked');
      await assert.rejects(
        () => service.provisionActor(OPERATOR, { actorId: 'actor-alice-2', type: 'human', displayName: 'Alice', externalSubject: EXTERNAL_SUBJECT }),
        rejectsWith('KERNEL_AUTHORITY_EXTERNAL_SUBJECT_CONFLICT'),
      );
    });
  });

  describe(`Kernel Authority Store conformance [${name}]: event chain`, () => {
    it('starts every chain at sequence 1, advances by exactly one, and links each event to its predecessor', async () => {
      const { store, service } = await open('chain-links');
      const provisioned = await service.provisionActor(OPERATOR, ACTOR);
      await service.revoke(OPERATOR, { entityKind: 'actor', entityId: ACTOR.actorId, reason: 'offboarded' });

      const [first, second, ...rest] = await store.listEvents(READER, ORG, 'actor', ACTOR.actorId);
      assert.equal(rest.length, 0);
      assert.equal(first?.sequence, 1);
      assert.equal(first?.previousEventDigest, undefined);
      assert.equal(first?.eventDigest, provisioned.record.latestEventDigest);
      assert.equal(second?.sequence, 2);
      assert.equal(second?.previousEventDigest, first?.eventDigest);
      assert.notEqual(second?.eventDigest, first?.eventDigest);
    });

    it('reports a head that matches the canonical history', async () => {
      const { store, service } = await open('chain-head');
      await service.provisionActor(OPERATOR, ACTOR);
      await service.revoke(OPERATOR, { entityKind: 'actor', entityId: ACTOR.actorId, reason: 'offboarded' });

      const events = await store.listEvents(READER, ORG, 'actor', ACTOR.actorId);
      const record = await store.getRecord(READER, ORG, 'actor', ACTOR.actorId);
      assert.equal(record?.latestSequence, events.length);
      assert.equal(record?.latestEventDigest, events[events.length - 1]?.eventDigest);
    });

    it('credits every event to the operator that wrote it', async () => {
      const { store, service } = await open('chain-attribution');
      await service.provisionActor(OPERATOR, ACTOR);
      await service.revoke({ system: true, actorId: 'operator-2' }, { entityKind: 'actor', entityId: ACTOR.actorId, reason: 'offboarded' });
      const events = await store.listEvents(READER, ORG, 'actor', ACTOR.actorId);
      assert.deepEqual(events.map((event) => event.provisionedBy), ['operator-1', 'operator-2']);
      const record = await store.getRecord(READER, ORG, 'actor', ACTOR.actorId);
      assert.equal(record?.provisionedBy, 'operator-1');
      assert.equal(record?.revokedBy, 'operator-2');
    });
  });

  describe(`Kernel Authority Store conformance [${name}]: idempotency`, () => {
    it('replays the same key with the same payload without appending again', async () => {
      const { store, service } = await open('idem-replay');
      const idempotency = { idempotencyKey: 'provision-alice-001' };
      const first = await service.provisionActor(OPERATOR, ACTOR, { idempotency });
      const retry = await service.provisionActor(OPERATOR, ACTOR, { idempotency });
      assert.equal(first.replayed, false);
      assert.equal(retry.replayed, true);
      assert.equal((await store.listEvents(READER, ORG, 'actor', ACTOR.actorId)).length, 1);
    });

    it('refuses the same key with a different payload, for another entity or for the same one', async () => {
      const { store, service } = await open('idem-conflict');
      const idempotency = { idempotencyKey: 'provision-alice-001' };
      await service.provisionActor(OPERATOR, ACTOR, { idempotency });
      await assert.rejects(() => service.provisionActor(OPERATOR, { ...ACTOR, actorId: 'actor-mallory' }, { idempotency }), rejectsWith('KERNEL_AUTHORITY_IDEMPOTENCY_CONFLICT'));
      await assert.rejects(() => service.provisionActor(OPERATOR, { ...ACTOR, displayName: 'Alice II' }, { idempotency }), rejectsWith('KERNEL_AUTHORITY_IDEMPOTENCY_CONFLICT'));
      assert.equal(await store.getRecord(READER, ORG, 'actor', 'actor-mallory'), null);
    });

    it('claims a key even when it is first used on an operation that replays', async () => {
      const { service } = await open('idem-claim-on-replay');
      await service.provisionActor(OPERATOR, ACTOR);
      const idempotency = { idempotencyKey: 'late-key' };
      assert.equal((await service.provisionActor(OPERATOR, ACTOR, { idempotency })).replayed, true);
      await assert.rejects(() => service.provisionActor(OPERATOR, { ...ACTOR, actorId: 'actor-bob' }, { idempotency }), rejectsWith('KERNEL_AUTHORITY_IDEMPOTENCY_CONFLICT'));
    });

    it('scopes idempotency keys to the organization', async () => {
      const { store, service } = await open('idem-org-scope');
      const other = createKernelAuthorityProvisioningService({ store, organizationId: OTHER_ORG });
      const idempotency = { idempotencyKey: 'shared-key' };
      await service.provisionActor(OPERATOR, ACTOR, { idempotency });
      const beta = await other.provisionActor(OPERATOR, { actorId: 'actor-beta-bob', type: 'human', displayName: 'Bob' }, { idempotency });
      assert.equal(beta.replayed, false);
    });
  });

  describe(`Kernel Authority Store conformance [${name}]: revocation`, () => {
    it('revokes active authority and reconstructs the record as revoked, with who, when and why', async () => {
      const { store, service } = await open('revoke');
      await service.provisionActor(OPERATOR, ACTOR);
      const revoked = await service.revoke(OPERATOR, { entityKind: 'actor', entityId: ACTOR.actorId, reason: 'offboarded' });

      assert.equal(revoked.replayed, false);
      assert.equal(revoked.record.status, 'revoked');
      assert.equal(revoked.record.revocationReason, 'offboarded');
      assert.equal(revoked.record.revokedBy, 'operator-1');
      assert.ok(revoked.record.revokedAt);
      assert.deepEqual(await store.getRecord(READER, ORG, 'actor', ACTOR.actorId), revoked.record);
      assert.equal(revoked.record.payload.displayName, 'Alice', 'revocation withdraws authority; it does not rewrite what was provisioned');
    });

    it('treats a repeated revocation as an idempotent replay', async () => {
      const { store, service } = await open('revoke-replay');
      await service.provisionActor(OPERATOR, ACTOR);
      await service.revoke(OPERATOR, { entityKind: 'actor', entityId: ACTOR.actorId, reason: 'offboarded' });
      const again = await service.revoke(OPERATOR, { entityKind: 'actor', entityId: ACTOR.actorId, reason: 'offboarded again' });

      assert.equal(again.replayed, true);
      assert.equal(again.record.revocationReason, 'offboarded', 'the first revocation stands');
      assert.equal((await store.listEvents(READER, ORG, 'actor', ACTOR.actorId)).length, 2);
    });

    it('never restores a revoked entity, whatever the re-provision says', async () => {
      const { store, service } = await open('revoke-terminal');
      await service.provisionActor(OPERATOR, ACTOR);
      await service.revoke(OPERATOR, { entityKind: 'actor', entityId: ACTOR.actorId, reason: 'offboarded' });

      await assert.rejects(() => service.provisionActor(OPERATOR, ACTOR), rejectsWith('KERNEL_AUTHORITY_ENTITY_REVOKED'));
      await assert.rejects(() => service.provisionActor(OPERATOR, { ...ACTOR, displayName: 'Alice, again' }), rejectsWith('KERNEL_AUTHORITY_ENTITY_REVOKED'));
      await assert.rejects(() => store.appendEvent(OPERATOR, actorAppend(ACTOR, ORG, 'restore-attempt')), rejectsWith('KERNEL_AUTHORITY_ENTITY_REVOKED'));
      assert.equal((await store.getRecord(READER, ORG, 'actor', ACTOR.actorId))?.status, 'revoked');
      assert.equal((await store.listEvents(READER, ORG, 'actor', ACTOR.actorId)).length, 2);
    });

    it('refuses to revoke something that was never provisioned', async () => {
      const { service } = await open('revoke-missing');
      await assert.rejects(() => service.revoke(OPERATOR, { entityKind: 'actor', entityId: 'actor-ghost', reason: 'n/a' }), rejectsWith('KERNEL_AUTHORITY_ENTITY_NOT_FOUND'));
    });

    it('still allows a new replacement entity under a new id', async () => {
      const { store, service } = await open('revoke-replacement');
      await service.provisionActor(OPERATOR, ACTOR);
      await service.revoke(OPERATOR, { entityKind: 'actor', entityId: ACTOR.actorId, reason: 'rotated' });
      const replacement = await service.provisionActor(OPERATOR, { ...ACTOR, actorId: 'actor-alice-2' });

      assert.equal(replacement.replayed, false);
      assert.equal(replacement.record.status, 'active');
      assert.equal((await store.getRecord(READER, ORG, 'actor', ACTOR.actorId))?.status, 'revoked');
    });
  });

  describe(`Kernel Authority Store conformance [${name}]: canonical digests (golden)`, () => {
    it('reproduces the golden event digests byte-for-byte and round-trips every digest-bearing value exactly', async () => {
      const options = deterministicOptions();
      const { store, service } = await open('golden', options);
      await provisionGoldenSequence(service);

      const digestOf = async (kind: KernelAuthorityEntityKind, id: string) => (await store.listEvents(READER, ORG, kind, id)).map((event) => event.eventDigest);
      const actual = {
        issuerActor: (await digestOf('actor', GOLDEN_ISSUER.actorId))[0],
        trustDomain: (await digestOf('trust-domain', GOLDEN_TRUST_DOMAIN.trustDomainId))[0],
        subjectActor: (await digestOf('actor', GOLDEN_SUBJECT.actorId))[0],
        capabilityToken: (await digestOf('capability-token', GOLDEN_TOKEN.capabilityTokenId))[0],
        capabilityTokenRevocation: (await digestOf('capability-token', GOLDEN_TOKEN.capabilityTokenId))[1],
      };
      assert.deepEqual(actual, GOLDEN_KERNEL_AUTHORITY_EVENT_DIGESTS);

      // The exact logical values the digests were computed over come back unchanged.
      const [subjectEvent] = await store.listEvents(READER, ORG, 'actor', GOLDEN_SUBJECT.actorId);
      assert.equal(subjectEvent?.occurredAt, GOLDEN_OCCURRED_AT, 'an operator-supplied event time must round-trip exactly as written');
      assert.equal(subjectEvent?.persistedAt, GOLDEN_NOW);
      assert.equal(subjectEvent?.eventId, 'kernel-authority-event-golden-3');
      assert.equal(typeof subjectEvent?.sequence, 'number');
      assert.equal('previousEventDigest' in (subjectEvent ?? {}), false, 'an absent predecessor is absent, not null');
      assert.deepEqual(subjectEvent?.payload, { ...GOLDEN_SUBJECT });
    });
  });

  describe(`Kernel Authority Store conformance [${name}]: evaluation parity`, () => {
    it('produces the same AocKernel decisions, including resource-scope semantics, and the same denial after revocation', async () => {
      const { store } = await open('evaluation-parity');
      const decisions = await createDurableKernelProviders({ store, organizationId: 'org-acme' });
      const service = createKernelAuthorityProvisioningService({ store, organizationId: 'org-acme', onCommitted: () => decisions.reload() });
      const ids = await provisionDurableAuthorityFixture(service);
      const kernel = createAocKernel({ recognitionProvider: decisions.recognitionProvider, clock: decisions.clock, idGenerator: decisions.idGenerator });

      let counter = 0;
      const statusOf = async (overrides: Parameters<typeof buildDurableFixtureRequest>[1]) =>
        (await kernel.evaluate({ ...buildDurableFixtureRequest(ids, overrides), requestId: `req-conformance-${(counter += 1)}` } as KernelEvaluationRequest)).status;

      const matrix = async () => ({
        valid: await statusOf({}),
        childScope: await statusOf({ resourceScope: `${ids.resourceScope}:child` }),
        siblingPrefixScope: await statusOf({ resourceScope: `${ids.resourceScope}0` }),
        wrongResource: await statusOf({ resourceScope: DURABLE_FIXTURE_OTHER_RESOURCE_SCOPE }),
        wrongAction: await statusOf({ action: DURABLE_FIXTURE_OTHER_ACTION }),
        unknownActor: await statusOf({ actorId: 'actor-nobody' }),
        unauthorizedActor: await statusOf({ actorId: DURABLE_FIXTURE_OUTSIDER_ACTOR_ID }),
        crossOrganization: await statusOf({ organizationId: 'org-beta' }),
      });

      assert.deepEqual(await matrix(), {
        valid: 'allowed',
        childScope: 'allowed',
        siblingPrefixScope: 'denied',
        wrongResource: 'denied',
        wrongAction: 'denied',
        unknownActor: 'denied',
        unauthorizedActor: 'denied',
        crossOrganization: 'denied',
      });

      await service.revoke(OPERATOR, { entityKind: 'capability-token', entityId: ids.capabilityTokenId, reason: 'rotated' });
      assert.equal(await statusOf({}), 'denied', 'a committed revocation is observed by the next evaluation');
    });
  });

  describe(`Kernel Authority Store conformance [${name}]: integrity of persisted state`, () => {
    const noTamper = 'provider keeps no persisted representation outside the store object; its integrity is the shared reconstruction path';

    async function tamperable(label: string) {
      const handle = await open(label);
      return handle;
    }

    async function provisionAndRevoke(service: KernelAuthorityProvisioningService): Promise<void> {
      await service.provisionActor(OPERATOR, ACTOR);
      await service.revoke(OPERATOR, { entityKind: 'actor', entityId: ACTOR.actorId, reason: 'offboarded' });
    }

    const integrityFailed = rejectsWith('KERNEL_AUTHORITY_INTEGRITY_FAILED');

    it('detects a payload edited in place with every digest left untouched', async (t) => {
      const { store, service, tamper } = await tamperable('tamper-payload');
      if (tamper === undefined) return t.skip(noTamper);
      await service.provisionActor(OPERATOR, ACTOR);
      await tamper.rewriteEventPayload(actorKey(ACTOR.actorId), 1, { ...ACTOR, type: 'organization', displayName: 'Alice (widened)' });

      await assert.rejects(() => store.getRecord(READER, ORG, 'actor', ACTOR.actorId), integrityFailed);
      await assert.rejects(() => store.listRecords(READER, { organizationId: ORG }), integrityFailed);
    });

    it('detects a broken predecessor digest', async (t) => {
      const { store, service, tamper } = await tamperable('tamper-previous-digest');
      if (tamper === undefined) return t.skip(noTamper);
      await provisionAndRevoke(service);
      await tamper.rewriteEventPreviousDigest(actorKey(ACTOR.actorId), 2, `sha256:${'0'.repeat(64)}`);

      await assert.rejects(() => store.getRecord(READER, ORG, 'actor', ACTOR.actorId), integrityFailed);
    });

    it('detects a sequence gap even when the stored head agrees with it', async (t) => {
      const { store, service, tamper } = await tamperable('tamper-gap');
      if (tamper === undefined) return t.skip(noTamper);
      await provisionAndRevoke(service);
      await tamper.renumberEvent(actorKey(ACTOR.actorId), 2, 3);
      await tamper.rewriteHead(actorKey(ACTOR.actorId), { latestSequence: 3 });

      await assert.rejects(() => store.getRecord(READER, ORG, 'actor', ACTOR.actorId), integrityFailed);
    });

    it('detects a lost tail: a missing revocation never reads back as live authority', async (t) => {
      const { store, service, tamper } = await tamperable('tamper-truncated');
      if (tamper === undefined) return t.skip(noTamper);
      await provisionAndRevoke(service);
      await tamper.deleteEvent(actorKey(ACTOR.actorId), 2);

      await assert.rejects(() => store.getRecord(READER, ORG, 'actor', ACTOR.actorId), integrityFailed);
      await assert.rejects(() => store.listRecords(READER, { organizationId: ORG }), integrityFailed);
    });

    it('detects a chain that does not begin with its provisioning event', async (t) => {
      const { store, service, tamper } = await tamperable('tamper-headless');
      if (tamper === undefined) return t.skip(noTamper);
      await provisionAndRevoke(service);
      await tamper.deleteEvent(actorKey(ACTOR.actorId), 1);

      await assert.rejects(() => store.getRecord(READER, ORG, 'actor', ACTOR.actorId), integrityFailed);
    });

    it('detects a stored head that disagrees with the history, by sequence or by digest', async (t) => {
      const { store, service, tamper } = await tamperable('tamper-head');
      if (tamper === undefined) return t.skip(noTamper);
      await service.provisionActor(OPERATOR, ACTOR);
      await service.provisionActor(OPERATOR, { ...ACTOR, actorId: 'actor-bob', displayName: 'Bob' });
      await tamper.rewriteHead(actorKey(ACTOR.actorId), { latestSequence: 7 });
      await tamper.rewriteHead(actorKey('actor-bob'), { latestEventDigest: `sha256:${'f'.repeat(64)}` });

      await assert.rejects(() => store.getRecord(READER, ORG, 'actor', ACTOR.actorId), integrityFailed);
      await assert.rejects(() => store.getRecord(READER, ORG, 'actor', 'actor-bob'), integrityFailed);
    });

    it('never trusts a projection of current state over the canonical events', async (t) => {
      const { store, service, tamper } = await tamperable('tamper-projection');
      if (tamper === undefined) return t.skip(noTamper);
      await provisionAndRevoke(service);
      await tamper.rewriteProjection(actorKey(ACTOR.actorId), { status: 'active', payload: { ...ACTOR, type: 'organization' } });

      for (const record of [await store.getRecord(READER, ORG, 'actor', ACTOR.actorId), (await store.listRecords(READER, { organizationId: ORG }))[0]]) {
        assert.equal(record?.status, 'revoked', 'a projection claiming the entity is live must not resurrect it');
        assert.equal(record?.payload.type, 'human', 'a projection claiming wider terms must not widen them');
      }
    });
  });

  describe(`Kernel Authority Store conformance [${name}]: durability`, () => {
    it('restores every record and every revocation through a new handle over the same state', async (t) => {
      const handle = await open('durability');
      if (handle.reopen === undefined) return t.skip('provider is not durable: its state does not outlive the store object');
      await handle.service.provisionActor(OPERATOR, { ...ACTOR, externalSubject: EXTERNAL_SUBJECT });
      await handle.service.provisionActor(OPERATOR, { ...ACTOR, actorId: 'actor-bob', displayName: 'Bob' });
      await handle.service.revoke(OPERATOR, { entityKind: 'actor', entityId: 'actor-bob', reason: 'offboarded' });
      const before = await handle.store.listRecords(READER, { organizationId: ORG });
      await handle.store.close();

      const reopened = await reopenOrSkip(handle);
      assert.deepEqual(await reopened.listRecords(READER, { organizationId: ORG }), before);
      assert.equal((await reopened.findActorByExternalSubject(READER, ORG, EXTERNAL_SUBJECT))?.entityId, ACTOR.actorId);
      await assert.rejects(
        () => createKernelAuthorityProvisioningService({ store: reopened, organizationId: ORG }).provisionActor(OPERATOR, { ...ACTOR, actorId: 'actor-bob', displayName: 'Bob' }),
        rejectsWith('KERNEL_AUTHORITY_ENTITY_REVOKED'),
      );
    });
  });

  describe(`Kernel Authority Store conformance [${name}]: concurrency`, () => {
    const noRace = 'provider offers no independent second handle onto the same backing state';
    const classificationGap = KNOWN_CONFORMANCE_GAPS[name]?.['race-loser-classification'];

    function countOutcomes(outcomes: readonly (readonly ConformanceAppendOutcome[])[]) {
      const flat = outcomes.flat();
      return {
        appended: flat.filter((entry) => entry.outcome === 'appended').length,
        replayed: flat.filter((entry) => entry.outcome === 'replayed').length,
        refusedCodes: flat.flatMap((entry) => (entry.outcome === 'refused' ? [entry.code] : [])),
      };
    }

    /**
     * The two halves of the concurrency contract (ADR §"Concurrency").
     *
     * SAFETY is asserted unconditionally, here, for every provider: at most one
     * logical mutation commits and the resulting state is the state of one
     * serial order. CLASSIFICATION -- every losing participant is told what the
     * serial order made of its request (replay or the named conflict), never a
     * raw driver error -- is asserted in its own subtest, so a provider with a
     * recorded gap reports it as TODO rather than as a pass.
     */
    async function classifies(t: TestContext, assertion: () => void): Promise<void> {
      await t.test('classifies every losing participant as the serial order would', classificationGap !== undefined ? { todo: classificationGap } : {}, () => assertion());
    }

    it('commits exactly one of two concurrent incompatible first provisions', async (t) => {
      const handle = await open('race-incompatible');
      if (handle.race === undefined) return t.skip(noRace);
      const outcomes = await handle.race([
        { context: OPERATOR, inputs: [actorAppend(ACTOR)] },
        { context: OPERATOR, inputs: [actorAppend({ ...ACTOR, type: 'organization' })] },
      ]);

      const counted = countOutcomes(outcomes);
      assert.equal(counted.appended, 1, `exactly one provision may commit (${handle.raceIsolation ?? ''})`);
      assert.equal(counted.replayed, 0, 'an incompatible provision is never a replay');
      assert.equal((await handle.store.listEvents(READER, ORG, 'actor', ACTOR.actorId)).length, 1);
      await classifies(t, () => assert.deepEqual(counted.refusedCodes, ['KERNEL_AUTHORITY_ENTITY_CONFLICT']));
    });

    it('resolves concurrent duplicate idempotent writes to one logical mutation', async (t) => {
      const handle = await open('race-idempotent');
      if (handle.race === undefined) return t.skip(noRace);
      const participants = Array.from({ length: 6 }, () => ({ context: OPERATOR, inputs: [actorAppend(ACTOR, ORG, 'same-key')] }));
      const counted = countOutcomes(await handle.race(participants));

      assert.equal(counted.appended, 1);
      assert.equal((await handle.store.listEvents(READER, ORG, 'actor', ACTOR.actorId)).length, 1);
      await classifies(t, () => {
        assert.equal(counted.replayed, participants.length - 1);
        assert.deepEqual(counted.refusedCodes, []);
      });
    });

    it('lets only one of two actors racing for the same external subject bind it', async (t) => {
      const handle = await open('race-subject');
      if (handle.race === undefined) return t.skip(noRace);
      const outcomes = await handle.race([
        { context: OPERATOR, inputs: [actorAppend({ ...ACTOR, externalSubject: EXTERNAL_SUBJECT })] },
        { context: OPERATOR, inputs: [actorAppend({ actorId: 'actor-mallory', type: 'human', displayName: 'Mallory', externalSubject: EXTERNAL_SUBJECT })] },
      ]);

      const counted = countOutcomes(outcomes);
      assert.equal(counted.appended, 1);
      const winner = outcomes[0]?.[0]?.outcome === 'appended' ? ACTOR.actorId : 'actor-mallory';
      const loser = winner === ACTOR.actorId ? 'actor-mallory' : ACTOR.actorId;
      assert.equal((await handle.store.findActorByExternalSubject(READER, ORG, EXTERNAL_SUBJECT))?.entityId, winner);
      assert.equal(await handle.store.getRecord(READER, ORG, 'actor', loser), null, 'the losing actor must not exist at all');
      await classifies(t, () => assert.deepEqual(counted.refusedCodes, ['KERNEL_AUTHORITY_EXTERNAL_SUBJECT_CONFLICT']));
    });

    it('serializes a concurrent revocation race into one revocation at the authority head', async (t) => {
      const handle = await open('race-revoke');
      if (handle.race === undefined) return t.skip(noRace);
      await handle.service.provisionActor(OPERATOR, ACTOR);
      const participants = Array.from({ length: 6 }, (_, index) => ({
        context: OPERATOR,
        inputs: [{ organizationId: ORG, entityKind: 'actor' as const, entityId: ACTOR.actorId, eventType: 'KernelAuthorityEntityRevoked' as const, payload: { reason: `reason-${index}` } }],
      }));
      const counted = countOutcomes(await handle.race(participants));

      assert.equal(counted.appended, 1, 'no lost update at the head: one revocation event, never two at sequence 2');
      const events = await handle.store.listEvents(READER, ORG, 'actor', ACTOR.actorId);
      assert.deepEqual(events.map((event) => event.sequence), [1, 2]);
      assert.equal((await handle.store.getRecord(READER, ORG, 'actor', ACTOR.actorId))?.status, 'revoked');
      await classifies(t, () => {
        assert.equal(counted.replayed, participants.length - 1);
        assert.deepEqual(counted.refusedCodes, []);
      });
    });
  });
}

/** Maps anything a racing append produced into a comparable outcome. Shared by in-process and worker participants. */
export async function runConformanceAppends(store: KernelAuthorityStore, participant: ConformanceRaceParticipant): Promise<ConformanceAppendOutcome[]> {
  const outcomes: ConformanceAppendOutcome[] = [];
  for (const input of participant.inputs) {
    try {
      const result = await store.appendEvent(participant.context, input);
      outcomes.push({ outcome: result.replayed ? 'replayed' : 'appended', sequence: result.event.sequence });
    } catch (error) {
      outcomes.push({ outcome: 'refused', code: error instanceof KernelAuthorityError ? error.code : `unclassified:${error instanceof Error ? error.name : typeof error}` });
    }
  }
  return outcomes;
}
