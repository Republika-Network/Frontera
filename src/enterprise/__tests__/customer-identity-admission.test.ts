import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createInMemoryKernelAuthorityStore } from '../kernel-authority/in-memory-kernel-authority-store.js';
import { createSqliteKernelAuthorityStore } from '../kernel-authority/sqlite-kernel-authority-store.js';
import { createKernelAuthorityProvisioningService } from '../kernel-authority/provisioning-service.js';
import type { KernelAuthorityStore } from '../kernel-authority/kernel-authority-store.js';
import type { KernelAuthorityAccessContext, KernelAuthorityRecord } from '../kernel-authority/contracts.js';
import type { EnterpriseApiKey } from '../configuration/enterprise-configuration.js';
import {
  CUSTOMER_IDENTITY_REFUSAL_REASONS as REFUSED,
  CUSTOMER_IDENTITY_UNAVAILABLE_REASONS as UNAVAILABLE,
  CustomerIdentityConfigurationError,
  authenticateCustomerCredential,
  createCustomerIdentityAdmission,
  createKernelAuthoritySubjectBindingReader,
  type CustomerIdentityAdmissionResult,
  type CustomerIdentityAdmissionService,
  type CustomerSubjectBindingReader,
} from '../customer-identity/index.js';

/**
 * IDENTITY-01 … IDENTITY-11 (`docs/enterprise/AOC_CUSTOMER_PRINCIPAL_BINDING.md`),
 * measured against the admission service and the real Kernel Authority stores.
 * IDENTITY-12 and the composition hook are measured in
 * `customer-identity-composition.test.ts`.
 */

const ORG = 'org-acme';
const OTHER_ORG = 'org-beta';
const OPERATOR: KernelAuthorityAccessContext = { system: true, actorId: 'operator-1' };
const SUBJECT = { system: 'example-app', subjectId: 'user-42' } as const;
const UNBOUND_SUBJECT = { system: 'example-app', subjectId: 'user-404' } as const;

/** Never a real credential. Anything that echoes it has leaked a secret. */
const SECRET = 'AOC_CUSTOMER_IDENTITY_SECRET_SENTINEL_DO_NOT_USE';
const UNBOUND_SECRET = 'AOC_CUSTOMER_IDENTITY_UNBOUND_SENTINEL_DO_NOT_USE';
const LEGACY_SCOPED = 'AOC_LEGACY_SCOPED_SENTINEL_DO_NOT_USE';
const LEGACY_UNSCOPED = 'AOC_LEGACY_UNSCOPED_SENTINEL_DO_NOT_USE';
const ALL_SECRETS = [SECRET, UNBOUND_SECRET, LEGACY_SCOPED, LEGACY_UNSCOPED];

const API_KEYS: readonly EnterpriseApiKey[] = [
  { key: LEGACY_UNSCOPED },
  { key: LEGACY_SCOPED, organizationId: ORG },
  { key: SECRET, organizationId: ORG, customerIdentity: { principalId: 'principal-1', externalSubject: SUBJECT } },
  { key: UNBOUND_SECRET, organizationId: ORG, customerIdentity: { principalId: 'principal-404', externalSubject: UNBOUND_SUBJECT } },
];

const closers: Array<() => Promise<void>> = [];
const tempDirs: string[] = [];
after(async () => {
  await Promise.all(closers.map((close) => close().catch(() => {})));
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function tempDbPath(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'aoc-customer-identity-'));
  tempDirs.push(dir);
  return join(dir, `${name}.sqlite`);
}

const PROVIDERS: readonly { readonly name: 'memory' | 'sqlite'; readonly create: (label: string) => Promise<KernelAuthorityStore> }[] = [
  { name: 'memory', create: async () => createInMemoryKernelAuthorityStore() },
  { name: 'sqlite', create: (label) => createSqliteKernelAuthorityStore(tempDbPath(label)) },
];

async function openStore(provider: (typeof PROVIDERS)[number], label: string): Promise<KernelAuthorityStore> {
  const store = await provider.create(label);
  closers.push(() => store.close());
  return store;
}

async function bindActor(store: KernelAuthorityStore, organizationId: string, actorId: string, externalSubject: { readonly system: string; readonly subjectId: string } = SUBJECT): Promise<void> {
  await createKernelAuthorityProvisioningService({ store, organizationId }).provisionActor(OPERATOR, {
    actorId,
    type: 'agent',
    displayName: actorId,
    externalSubject,
  });
}

function admissionOver(store: KernelAuthorityStore, apiKeys: readonly EnterpriseApiKey[] = API_KEYS, organizationId = ORG): CustomerIdentityAdmissionService {
  return createCustomerIdentityAdmission({ apiKeys, subjectBindings: createKernelAuthoritySubjectBindingReader(store), organizationId });
}

function readerReturning(answer: () => Promise<KernelAuthorityRecord | null>): CustomerSubjectBindingReader {
  return createKernelAuthoritySubjectBindingReader({ findActorByExternalSubject: () => answer() });
}

function actorRecord(overrides: Partial<KernelAuthorityRecord> = {}): KernelAuthorityRecord {
  return {
    organizationId: ORG,
    entityKind: 'actor',
    entityId: 'actor-acme',
    status: 'active',
    payload: { actorId: 'actor-acme', externalSubject: { ...SUBJECT } },
    provisionedBy: 'operator-1',
    provisionedAt: '2026-01-01T00:00:00.000Z',
    latestSequence: 1,
    latestEventDigest: 'sha256:0',
    ...overrides,
  };
}

function assertNoSecret(value: unknown, where: string): void {
  const serialized = JSON.stringify(value) ?? '';
  for (const secret of ALL_SECRETS) {
    assert.equal(serialized.includes(secret), false, `${where} leaked a credential: ${serialized}`);
  }
}

function assertRefused(result: CustomerIdentityAdmissionResult, reason: string): void {
  assert.deepEqual(result, { status: 'refused', reason });
  assertNoSecret(result, `refusal ${reason}`);
}

describe('Customer credential authentication (credential → principal)', () => {
  it('refuses a missing or empty Authorization header (CUSTOMER_AUTH_REQUIRED)', () => {
    for (const header of [undefined, '', '   ']) {
      assert.deepEqual(authenticateCustomerCredential(header, API_KEYS), { status: 'refused', reason: REFUSED.CUSTOMER_AUTH_REQUIRED });
    }
  });

  it('refuses a header that is not a bearer credential (CUSTOMER_AUTH_MALFORMED)', () => {
    for (const header of [SECRET, `Basic ${SECRET}`, 'Bearer', 'Bearer    ', `Token ${SECRET}`]) {
      assert.deepEqual(authenticateCustomerCredential(header, API_KEYS), { status: 'refused', reason: REFUSED.CUSTOMER_AUTH_MALFORMED }, header);
    }
  });

  it('refuses an unknown bearer, including a prefix, suffix or case variant of a real key (CUSTOMER_AUTH_INVALID)', () => {
    for (const token of ['nope', SECRET.slice(0, -1), `${SECRET}x`, SECRET.toLowerCase(), ` ${SECRET}x`]) {
      assert.deepEqual(authenticateCustomerCredential(`Bearer ${token}`, API_KEYS), { status: 'refused', reason: REFUSED.CUSTOMER_AUTH_INVALID }, token);
    }
  });

  it('IDENTITY-03: refuses a valid but unscoped legacy key rather than widening it to system (CUSTOMER_AUTH_UNSCOPED)', () => {
    assert.deepEqual(authenticateCustomerCredential(`Bearer ${LEGACY_UNSCOPED}`, API_KEYS), { status: 'refused', reason: REFUSED.CUSTOMER_AUTH_UNSCOPED });
  });

  it('IDENTITY-03: refuses an unscoped key even when it carries customer identity metadata', () => {
    const keys: EnterpriseApiKey[] = [{ key: SECRET, customerIdentity: { principalId: 'principal-1', externalSubject: SUBJECT } }];
    assert.deepEqual(authenticateCustomerCredential(`Bearer ${SECRET}`, keys), { status: 'refused', reason: REFUSED.CUSTOMER_AUTH_UNSCOPED });
  });

  it('refuses a valid, scoped legacy key without customer identity metadata (CUSTOMER_IDENTITY_NOT_CONFIGURED)', () => {
    assert.deepEqual(authenticateCustomerCredential(`Bearer ${LEGACY_SCOPED}`, API_KEYS), {
      status: 'refused',
      reason: REFUSED.CUSTOMER_IDENTITY_NOT_CONFIGURED,
    });
  });

  it('refuses malformed principal or external-subject metadata instead of trimming it into shape (CUSTOMER_IDENTITY_INVALID)', () => {
    const malformed: readonly EnterpriseApiKey['customerIdentity'][] = [
      { principalId: '', externalSubject: SUBJECT },
      { principalId: ' principal-1', externalSubject: SUBJECT },
      { principalId: 'principal-1 ', externalSubject: SUBJECT },
      { principalId: 'principal\u00001', externalSubject: SUBJECT },
      { principalId: 'principal\n1', externalSubject: SUBJECT },
      { principalId: 'p'.repeat(257), externalSubject: SUBJECT },
      { principalId: 'principal-1', externalSubject: { system: '', subjectId: 'user-42' } },
      { principalId: 'principal-1', externalSubject: { system: 'example-app', subjectId: '' } },
      { principalId: 'principal-1', externalSubject: { system: 'example-app', subjectId: 'user-42\u007f' } },
      { principalId: 'principal-1', externalSubject: null as unknown as { system: string; subjectId: string } },
      { principalId: 42 as unknown as string, externalSubject: SUBJECT },
    ];
    for (const customerIdentity of malformed) {
      const keys = [{ key: SECRET, organizationId: ORG, customerIdentity } as EnterpriseApiKey];
      assert.deepEqual(
        authenticateCustomerCredential(`Bearer ${SECRET}`, keys),
        { status: 'refused', reason: REFUSED.CUSTOMER_IDENTITY_INVALID },
        JSON.stringify(customerIdentity),
      );
    }
  });

  it('IDENTITY-01/02/04/09: an eligible key yields one immutable, non-secret, organization-bound principal with no system flag', () => {
    const result = authenticateCustomerCredential(`Bearer ${SECRET}`, API_KEYS);
    assert.equal(result.status, 'authenticated');
    if (result.status !== 'authenticated') return;

    assert.deepEqual(result.principal, { plane: 'customer', principalId: 'principal-1', organizationId: ORG, externalSubject: SUBJECT });
    assert.deepEqual(Object.keys(result.principal).sort(), ['externalSubject', 'organizationId', 'plane', 'principalId']);
    assert.equal('system' in result.principal, false);
    assert.equal('key' in result.principal, false);
    assert.equal(Object.isFrozen(result.principal), true);
    assert.equal(Object.isFrozen(result.principal.externalSubject), true);
    assertNoSecret(result, 'principal');
  });

  it('accepts the bearer scheme case-insensitively, exactly as the legacy routes do', () => {
    assert.equal(authenticateCustomerCredential(`bearer ${SECRET}`, API_KEYS).status, 'authenticated');
  });
});

for (const provider of PROVIDERS) {
  describe(`Customer identity admission over the Kernel Authority store (${provider.name})`, () => {
    it('IDENTITY-05: a bound external subject admits exactly the actor the authority store binds it to', async () => {
      const store = await openStore(provider, 'bound');
      await bindActor(store, ORG, 'actor-acme');

      const result = await admissionOver(store).admit({ authorizationHeader: `Bearer ${SECRET}` });

      assert.deepEqual(result, {
        status: 'bound',
        identity: {
          principal: { plane: 'customer', principalId: 'principal-1', organizationId: ORG, externalSubject: SUBJECT },
          actor: { actorId: 'actor-acme' },
        },
      });
      if (result.status !== 'bound') return;
      assert.deepEqual(Object.keys(result.identity.actor), ['actorId'], 'only the minimum actor projection crosses — never the authority record');
      assert.equal(Object.isFrozen(result.identity), true);
      assert.equal(Object.isFrozen(result.identity.principal), true);
      assert.equal(Object.isFrozen(result.identity.actor), true);
      assertNoSecret(result, 'bound identity');
    });

    it('IDENTITY-07: an unbound external subject is refused, and no actor is created', async () => {
      const store = await openStore(provider, 'unbound');
      await bindActor(store, ORG, 'actor-acme');
      const before = await store.listRecords({ system: false, organizationId: ORG }, { organizationId: ORG });

      assertRefused(await admissionOver(store).admit({ authorizationHeader: `Bearer ${UNBOUND_SECRET}` }), REFUSED.CUSTOMER_SUBJECT_UNBOUND);

      const afterwards = await store.listRecords({ system: false, organizationId: ORG }, { organizationId: ORG });
      assert.deepEqual(afterwards, before, 'admission must never mint an actor or a binding');
      assert.equal(await store.findActorByExternalSubject({ system: false, organizationId: ORG }, ORG, UNBOUND_SUBJECT), null);
    });

    it('a revoked bound actor admits no one', async () => {
      const store = await openStore(provider, 'revoked');
      await bindActor(store, ORG, 'actor-acme');
      await createKernelAuthorityProvisioningService({ store, organizationId: ORG }).revoke(OPERATOR, { entityKind: 'actor', entityId: 'actor-acme', reason: 'offboarded' });

      assertRefused(await admissionOver(store).admit({ authorizationHeader: `Bearer ${SECRET}` }), REFUSED.CUSTOMER_SUBJECT_ACTOR_REVOKED);
    });

    it('IDENTITY-08: a credential scoped to one organization never resolves the other organization actor for the same subject', async () => {
      const store = await openStore(provider, 'cross-tenant');
      await bindActor(store, ORG, 'actor-acme');
      await bindActor(store, OTHER_ORG, 'actor-beta');

      const result = await admissionOver(store).admit({ authorizationHeader: `Bearer ${SECRET}` });
      assert.equal(result.status, 'bound');
      if (result.status === 'bound') assert.equal(result.identity.actor.actorId, 'actor-acme');
    });

    it('IDENTITY-08: when only another organization binds the subject, the credential is unbound — never borrowed', async () => {
      const store = await openStore(provider, 'cross-tenant-only-beta');
      await bindActor(store, OTHER_ORG, 'actor-beta');

      assertRefused(await admissionOver(store).admit({ authorizationHeader: `Bearer ${SECRET}` }), REFUSED.CUSTOMER_SUBJECT_UNBOUND);
    });

    it('IDENTITY-06: nothing attached to the admission request can choose, override or widen the actor', async () => {
      const store = await openStore(provider, 'override');
      await bindActor(store, ORG, 'actor-acme');
      await bindActor(store, OTHER_ORG, 'actor-beta');
      await bindActor(store, ORG, 'actor-attacker', { system: 'example-app', subjectId: 'attacker' });
      const admission = admissionOver(store);

      const injected = {
        authorizationHeader: `Bearer ${SECRET}`,
        actorId: 'actor-attacker',
        actor: { id: 'actor-attacker' },
        organizationId: OTHER_ORG,
        organization: { id: OTHER_ORG },
        system: true,
        plane: 'operator',
        principalId: 'principal-404',
        externalSubject: { system: 'example-app', subjectId: 'attacker' },
      };
      const result = await admission.admit(injected as unknown as { authorizationHeader: string });

      assert.deepEqual(result, {
        status: 'bound',
        identity: {
          principal: { plane: 'customer', principalId: 'principal-1', organizationId: ORG, externalSubject: SUBJECT },
          actor: { actorId: 'actor-acme' },
        },
      });
    });

    it('IDENTITY-06: identity text smuggled inside the Authorization header is just an invalid credential', async () => {
      const store = await openStore(provider, 'header-injection');
      await bindActor(store, ORG, 'actor-acme');
      const admission = admissionOver(store);

      for (const header of [
        `Bearer ${SECRET} actorId=actor-attacker`,
        `Bearer ${SECRET};organizationId=${OTHER_ORG}`,
        `Bearer {"key":"${SECRET}","system":true}`,
      ]) {
        assertRefused(await admission.admit({ authorizationHeader: header }), REFUSED.CUSTOMER_AUTH_INVALID);
      }
    });

    it('IDENTITY-04: no admitted identity carries a system flag, and no refusal falls back to one', async () => {
      const store = await openStore(provider, 'no-system');
      await bindActor(store, ORG, 'actor-acme');
      const admission = admissionOver(store);

      for (const header of [undefined, 'garbage', `Bearer ${LEGACY_UNSCOPED}`, `Bearer ${LEGACY_SCOPED}`, `Bearer ${SECRET}`]) {
        const result = await admission.admit(header === undefined ? {} : { authorizationHeader: header });
        assert.equal(/"system":true/.test(JSON.stringify(result)), false, `${String(header)} must never produce a system principal`);
        if (result.status === 'bound') assert.equal('system' in result.identity.principal, false);
      }
    });

    it('rotation keeps the identity: two keys configured for one principal admit the same actor', async () => {
      const store = await openStore(provider, 'rotation');
      await bindActor(store, ORG, 'actor-acme');
      const rotated = 'AOC_ROTATED_SENTINEL_DO_NOT_USE';
      const admission = admissionOver(store, [...API_KEYS, { key: rotated, organizationId: ORG, customerIdentity: { principalId: 'principal-1', externalSubject: SUBJECT } }]);

      const first = await admission.admit({ authorizationHeader: `Bearer ${SECRET}` });
      const second = await admission.admit({ authorizationHeader: `Bearer ${rotated}` });
      assert.deepEqual(second, first);
    });
  });
}

describe('Customer identity admission: the binding source fails closed (IDENTITY-11)', () => {
  const EXPECTED_CONTEXT: KernelAuthorityAccessContext = { system: false, organizationId: ORG };

  it('reads bindings with a non-system, organization-scoped context taken from the credential', async () => {
    const seen: Array<{ context: KernelAuthorityAccessContext; organizationId: string; subject: unknown }> = [];
    const reader = createKernelAuthoritySubjectBindingReader({
      async findActorByExternalSubject(context, organizationId, subject) {
        seen.push({ context, organizationId, subject });
        return actorRecord();
      },
    });
    const admission = createCustomerIdentityAdmission({ apiKeys: API_KEYS, subjectBindings: reader, organizationId: ORG });

    assert.equal((await admission.admit({ authorizationHeader: `Bearer ${SECRET}` })).status, 'bound');
    assert.deepEqual(seen, [{ context: EXPECTED_CONTEXT, organizationId: ORG, subject: { ...SUBJECT } }]);
  });

  it('a binding source that throws is unavailable — not unbound, and never an identity', async () => {
    const admission = createCustomerIdentityAdmission({
      apiKeys: API_KEYS,
      subjectBindings: readerReturning(() => Promise.reject(new Error(`store exploded while holding ${SECRET}`))),
      organizationId: ORG,
    });
    const result = await admission.admit({ authorizationHeader: `Bearer ${SECRET}` });
    assert.deepEqual(result, { status: 'unavailable', reason: UNAVAILABLE.CUSTOMER_SUBJECT_LOOKUP_FAILED });
    assertNoSecret(result, 'lookup failure');
  });

  it('a closed durable store is unavailable', async () => {
    const store = await createSqliteKernelAuthorityStore(tempDbPath('closed'));
    await bindActor(store, ORG, 'actor-acme');
    await store.close();

    assert.deepEqual(await admissionOver(store).admit({ authorizationHeader: `Bearer ${SECRET}` }), {
      status: 'unavailable',
      reason: UNAVAILABLE.CUSTOMER_SUBJECT_LOOKUP_FAILED,
    });
  });

  it('a record that answers a different question is treated as corruption, never as the actor', async () => {
    const wrongAnswers: readonly KernelAuthorityRecord[] = [
      actorRecord({ organizationId: OTHER_ORG }),
      actorRecord({ entityKind: 'passport' }),
      actorRecord({ entityId: '' }),
      actorRecord({ payload: { actorId: 'actor-acme' } }),
      actorRecord({ payload: { actorId: 'actor-acme', externalSubject: { system: 'example-app', subjectId: 'someone-else' } } }),
      actorRecord({ payload: { actorId: 'actor-acme', externalSubject: { system: 'other-app', subjectId: 'user-42' } } }),
      actorRecord({ status: 'suspended' as unknown as 'active' }),
    ];
    for (const record of wrongAnswers) {
      const admission = createCustomerIdentityAdmission({ apiKeys: API_KEYS, subjectBindings: readerReturning(async () => record), organizationId: ORG });
      assert.deepEqual(
        await admission.admit({ authorizationHeader: `Bearer ${SECRET}` }),
        { status: 'unavailable', reason: UNAVAILABLE.CUSTOMER_SUBJECT_BINDING_INCONSISTENT },
        JSON.stringify(record),
      );
    }
  });

  it('a reader that answers outside its contract admits no one', async () => {
    for (const answer of [undefined, null, { status: 'bound', actorId: '' }, { status: 'bound', actorId: ' actor' }, { status: 'maybe' }]) {
      const admission = createCustomerIdentityAdmission({
        apiKeys: API_KEYS,
        subjectBindings: { findActorByExternalSubject: async () => answer as never },
        organizationId: ORG,
      });
      assert.deepEqual(
        await admission.admit({ authorizationHeader: `Bearer ${SECRET}` }),
        { status: 'unavailable', reason: UNAVAILABLE.CUSTOMER_SUBJECT_BINDING_INCONSISTENT },
        JSON.stringify(answer),
      );
    }
  });

  it('refusals before the binding source never touch it', async () => {
    let reads = 0;
    const admission = createCustomerIdentityAdmission({
      apiKeys: API_KEYS,
      subjectBindings: {
        async findActorByExternalSubject() {
          reads += 1;
          return { status: 'unbound' };
        },
      },
      organizationId: ORG,
    });
    for (const header of [undefined, 'garbage', 'Bearer nope', `Bearer ${LEGACY_UNSCOPED}`, `Bearer ${LEGACY_SCOPED}`]) {
      await admission.admit(header === undefined ? {} : { authorizationHeader: header });
    }
    assert.equal(reads, 0);
  });
});

describe('Customer identity admission: composition-time validation', () => {
  const reader: CustomerSubjectBindingReader = { findActorByExternalSubject: async () => ({ status: 'unbound' }) };

  function refusesWith(apiKeys: readonly EnterpriseApiKey[], code: string, organizationId = ORG): void {
    assert.throws(
      () => createCustomerIdentityAdmission({ apiKeys, subjectBindings: reader, organizationId }),
      (error: unknown) => {
        assert.ok(error instanceof CustomerIdentityConfigurationError);
        assert.equal(error.code, code);
        for (const secret of [...ALL_SECRETS, 'AOC_OTHER_SENTINEL_DO_NOT_USE']) assert.equal(error.message.includes(secret), false, `configuration error leaked a credential: ${error.message}`);
        return true;
      },
    );
  }

  it('refuses a configuration with no customer-plane credential at all', () => {
    refusesWith([{ key: LEGACY_UNSCOPED }, { key: LEGACY_SCOPED, organizationId: ORG }], 'CUSTOMER_IDENTITY_NO_CUSTOMER_CREDENTIAL');
    refusesWith([], 'CUSTOMER_IDENTITY_NO_CUSTOMER_CREDENTIAL');
  });

  it('refuses a customer credential without an organization', () => {
    refusesWith([{ key: SECRET, customerIdentity: { principalId: 'principal-1', externalSubject: SUBJECT } }], 'CUSTOMER_IDENTITY_CREDENTIAL_UNSCOPED');
  });

  it('refuses malformed customer identity metadata', () => {
    refusesWith([{ key: SECRET, organizationId: ORG, customerIdentity: { principalId: ' principal-1', externalSubject: SUBJECT } }], 'CUSTOMER_IDENTITY_CREDENTIAL_INVALID');
    refusesWith([{ key: SECRET, organizationId: ORG, customerIdentity: { principalId: 'principal-1', externalSubject: { system: 'x', subjectId: '' } } }], 'CUSTOMER_IDENTITY_CREDENTIAL_INVALID');
  });

  it('refuses a customer credential scoped to an organization this instance does not serve', () => {
    refusesWith([{ key: SECRET, organizationId: OTHER_ORG, customerIdentity: { principalId: 'principal-1', externalSubject: SUBJECT } }], 'CUSTOMER_IDENTITY_ORGANIZATION_NOT_SERVED');
  });

  it('refuses one principalId naming two different identities', () => {
    refusesWith(
      [
        { key: SECRET, organizationId: ORG, customerIdentity: { principalId: 'principal-1', externalSubject: SUBJECT } },
        { key: 'AOC_OTHER_SENTINEL_DO_NOT_USE', organizationId: ORG, customerIdentity: { principalId: 'principal-1', externalSubject: UNBOUND_SUBJECT } },
      ],
      'CUSTOMER_IDENTITY_PRINCIPAL_AMBIGUOUS',
    );
  });

  it('leaves legacy keys alone: they neither break composition nor become eligible', async () => {
    const admission = createCustomerIdentityAdmission({ apiKeys: API_KEYS, subjectBindings: reader, organizationId: ORG });
    assertRefused(await admission.admit({ authorizationHeader: `Bearer ${LEGACY_SCOPED}` }), REFUSED.CUSTOMER_IDENTITY_NOT_CONFIGURED);
    assertRefused(await admission.admit({ authorizationHeader: `Bearer ${LEGACY_UNSCOPED}` }), REFUSED.CUSTOMER_AUTH_UNSCOPED);
  });

  it('reads a snapshot of the validated credentials: mutating the host configuration afterwards changes nothing', async () => {
    const mutable = API_KEYS.map((apiKey) => JSON.parse(JSON.stringify(apiKey)) as { key: string; organizationId?: string; customerIdentity?: { principalId: string; externalSubject: { system: string; subjectId: string } } });
    const seen: unknown[] = [];
    const admission = createCustomerIdentityAdmission({
      apiKeys: mutable,
      subjectBindings: {
        async findActorByExternalSubject(organizationId, subject) {
          seen.push({ organizationId, subject });
          return { status: 'bound', actorId: 'actor-acme' };
        },
      },
      organizationId: ORG,
    });

    const customer = mutable[2];
    assert.ok(customer?.customerIdentity !== undefined);
    customer.organizationId = OTHER_ORG;
    customer.customerIdentity.principalId = 'principal-attacker';
    customer.customerIdentity.externalSubject.subjectId = 'attacker';
    const legacy = mutable[1];
    assert.ok(legacy !== undefined);
    legacy.customerIdentity = { principalId: 'principal-legacy', externalSubject: { system: 'example-app', subjectId: 'attacker' } };

    const result = await admission.admit({ authorizationHeader: `Bearer ${SECRET}` });
    assert.equal(result.status, 'bound');
    if (result.status === 'bound') {
      assert.deepEqual(result.identity.principal, { plane: 'customer', principalId: 'principal-1', organizationId: ORG, externalSubject: SUBJECT });
    }
    assert.deepEqual(seen, [{ organizationId: ORG, subject: { ...SUBJECT } }]);
    assertRefused(await admission.admit({ authorizationHeader: `Bearer ${LEGACY_SCOPED}` }), REFUSED.CUSTOMER_IDENTITY_NOT_CONFIGURED);
  });

  it('the service it returns exposes no credential and cannot be modified', () => {
    const admission = createCustomerIdentityAdmission({ apiKeys: API_KEYS, subjectBindings: reader, organizationId: ORG });
    assertNoSecret(admission, 'admission service');
    assert.equal(Object.isFrozen(admission), true);
    assert.deepEqual(Object.keys(admission).sort(), ['admit', 'organizationId']);
  });
});

describe('Customer identity admission: durability of the binding it reads', () => {
  it('an external-subject binding survives closing and reopening the durable store', async () => {
    const path = tempDbPath('reopen');
    const first = await createSqliteKernelAuthorityStore(path);
    await bindActor(first, ORG, 'actor-acme');
    await first.close();

    const reopened = await createSqliteKernelAuthorityStore(path);
    closers.push(() => reopened.close());
    const result = await admissionOver(reopened).admit({ authorizationHeader: `Bearer ${SECRET}` });
    assert.equal(result.status, 'bound');
    if (result.status === 'bound') assert.equal(result.identity.actor.actorId, 'actor-acme');
  });
});
