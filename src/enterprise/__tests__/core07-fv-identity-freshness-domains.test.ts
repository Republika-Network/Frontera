import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import {
  AUTHORITY_STATE_WITNESS_PROTOCOL,
  FV_BOOTSTRAP_IDENTITY_STATE_KIND,
  HOST_IDENTITY_STATE_KIND,
  HUMAN_IDENTITY_STATE_KINDS,
  authorityStateBindingProblem,
  createAuthorityStateFreshnessBoundary,
  createHttpAuthorityStateWitnessTransport,
  humanIdentityStateCheckpoint,
  isHumanIdentityStateKind,
  parseWitnessRequest,
  serializeAuthorityStateCheckpoint,
  serializeWitnessReceipt,
  type AuthorityStateCheckpoint,
  type AuthorityStateFreshnessBoundary,
  type WitnessRequest,
} from '../authority-state-freshness/index.js';
import {
  INTENDED_PRODUCTION_RP_ID,
  createHumanIdentityService,
  createRelyingPartyConfiguration,
  identityAdministratorFor,
  openSqliteHumanIdentityStore,
  type HumanIdentityStore,
} from '../human-identity/index.js';
import { humanIdentityGenesisDigest } from '../human-identity/chain.js';
import { AUTHORITY_KEY_A, testSigner, testVerifier } from './authority-authenticity-fixture.js';
import { ScriptedWitnessTransport, WITNESS_TOKEN, boundaryFor, closeAllWitnesses, connect, startWitness, witnessRows, type StartedWitness } from './core07-freshness-fixture.js';

// CORE-07-FV-WITNESS — independent identity freshness domains in one organization: the Host's (AUTH-04A) legacy
// `human-identity-state` slot, unchanged, and the dedicated FV executor's own `fv-bootstrap-identity-state` slot.
// Real reference witness, real synthetic AUTH-03 stores, temporary databases only. Nothing here is a production
// enrollment: the FV genesis below is the test-only registration contract.

const ORG = 'org-core07-fv-domains';
const OTHER_ORG = 'org-core07-fv-other';
const NOW = '2026-11-02T12:00:00.000Z';
const RP = createRelyingPartyConfiguration({ rpId: INTENDED_PRODUCTION_RP_ID, rpName: 'Frontera Authority', allowedOrigins: [`https://${INTENDED_PRODUCTION_RP_ID}`] });
const OPERATORS = ['op-a', 'op-b', 'op-c', 'op-d', 'op-e', 'op-f'];
const authenticity = { signer: testSigner(AUTHORITY_KEY_A), verifier: testVerifier([AUTHORITY_KEY_A]) };
const plainCloser = (_file: string, connection: { close(): unknown }) => (): void => void connection.close();
const admin = identityAdministratorFor({ plane: 'operator', operatorId: 'ops-admin', organizationId: ORG, role: 'organization-administrator', credentialClass: 'operator', actorRef: 'operator-plane:ops-admin' });

const dirs: string[] = [];
const opened: HumanIdentityStore[] = [];
after(async () => {
  for (const store of opened.splice(0)) {
    try {
      store.close();
    } catch {
      // already closed
    }
  }
  await closeAllWitnesses();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function directory(): string {
  const dir = mkdtempSync(join(tmpdir(), 'core07-fv-domains-'));
  dirs.push(dir);
  return dir;
}

async function hostStore(path: string, boundary: AuthorityStateFreshnessBoundary, create = false, organizationId = ORG): Promise<HumanIdentityStore> {
  const store = await openSqliteHumanIdentityStore(path, { organizationId, now: () => NOW, authenticity, create, freshness: { boundary } });
  opened.push(store);
  return store;
}

async function fvStore(path: string, boundary: AuthorityStateFreshnessBoundary, create = false, storeId?: string): Promise<HumanIdentityStore> {
  const store = await openSqliteHumanIdentityStore(path, {
    organizationId: ORG,
    now: () => NOW,
    authenticity,
    create,
    freshness: { boundary, stateKind: FV_BOOTSTRAP_IDENTITY_STATE_KIND },
    exclusive: { beforeWrite: () => undefined, closer: plainCloser, ...(storeId !== undefined ? { storeId } : {}) },
  });
  opened.push(store);
  return store;
}

let principal = 0;
/**
 * Advances a store by exactly one signed, witnessed row. A Host store: by its Host administrator. FV-P4C-2B3C-2A2B:
 * an FV store refuses Host administration, so its exclusive owner appends one synthetic row through the store's own
 * (trusted) append — these tests are about freshness positions, not about who may enrol whom.
 */
async function advance(store: HumanIdentityStore): Promise<void> {
  principal += 1;
  const operatorId = `${OPERATORS[principal % OPERATORS.length] ?? 'op-a'}-${String(principal)}`;
  if (store.exclusiveOwner) {
    await store.append({ kind: 'principal_created', operatorId, objectId: null, payload: JSON.stringify({ displayName: `Synthetic ${String(principal)}`, userHandle: `synthetic-${String(principal)}` }), recordedBy: 'test:core07-advance', recordedAt: NOW }, () => undefined);
    return;
  }
  await createHumanIdentityService({ store, relyingParty: RP, operatorIds: [...OPERATORS, operatorId], now: () => new Date(NOW) }).createPrincipal(admin, { operatorId, displayName: `Synthetic ${String(principal)}` });
}

const slotOf = async (witness: StartedWitness, stateKind: string, organizationId = ORG): Promise<Record<string, unknown> | undefined> =>
  (await witnessRows(witness.databasePath)).find((row) => row['state_kind'] === stateKind && row['organization_id'] === organizationId);

const STATE = { storeId: 'human-identity-store:00000000-0000-4000-8000-000000000001', organizationId: ORG, sequence: 3, chainDigest: `sha256:${'a'.repeat(64)}` };

describe('CORE-07-FV-WITNESS domain identity — closed, canonical, and the legacy Host bytes unchanged', () => {
  it('the Host’s identity checkpoint is byte-for-byte the legacy v1 checkpoint; the FV domain differs only by its kind', () => {
    const legacy = `{"format":"frontera.authority-state-checkpoint.v1","organizationId":"${ORG}","sequence":3,"stateDigest":"sha256:${'a'.repeat(64)}","stateKind":"human-identity-state","storeId":"${STATE.storeId}"}`;
    assert.equal(serializeAuthorityStateCheckpoint(humanIdentityStateCheckpoint(STATE)), legacy, 'no domain argument: the Host slot, unchanged');
    assert.equal(serializeAuthorityStateCheckpoint(humanIdentityStateCheckpoint(STATE, HOST_IDENTITY_STATE_KIND)), legacy);
    const fv = serializeAuthorityStateCheckpoint(humanIdentityStateCheckpoint(STATE, FV_BOOTSTRAP_IDENTITY_STATE_KIND));
    assert.equal(fv, legacy.replace('"stateKind":"human-identity-state"', '"stateKind":"fv-bootstrap-identity-state"'));
    assert.notEqual(fv, legacy);
    // A Host witness receipt keeps its signed bytes: the binding names the legacy kind, and nothing was added.
    const receipt = serializeWitnessReceipt({ protocol: AUTHORITY_STATE_WITNESS_PROTOCOL, witnessId: 'w', operation: 'read', challenge: '0'.repeat(64), outcome: 'current', binding: { stateKind: 'human-identity-state', organizationId: ORG }, state: { status: 'unbound' } });
    assert.equal(receipt, `{"binding":{"organizationId":"${ORG}","stateKind":"human-identity-state"},"challenge":"${'0'.repeat(64)}","operation":"read","outcome":"current","protocol":"frontera.authority-state-witness.v2","state":{"status":"unbound"},"witnessId":"w"}`);
  });

  it('the identity domains are exactly two, closed; an identity store is anchored in no other kind', () => {
    assert.deepEqual([...HUMAN_IDENTITY_STATE_KINDS], ['human-identity-state', 'fv-bootstrap-identity-state']);
    for (const kind of ['approval-state', 'payment-initiation-reservations', 'fv-bootstrap-identity', 'x'] as const) {
      assert.equal(isHumanIdentityStateKind(kind), false, kind);
      assert.throws(() => humanIdentityStateCheckpoint(STATE, kind as never), TypeError, kind);
    }
  });

  it('a domain name is never folded, trimmed, joined or namespaced into another: every spelling but the exact one is refused', () => {
    assert.equal(authorityStateBindingProblem({ stateKind: FV_BOOTSTRAP_IDENTITY_STATE_KIND, organizationId: ORG }), undefined);
    assert.match(authorityStateBindingProblem({ stateKind: FV_BOOTSTRAP_IDENTITY_STATE_KIND, organizationId: ORG, namespace: 'legacy-host' }) ?? '', /state kind that has none/);
    assert.match(authorityStateBindingProblem({ stateKind: HOST_IDENTITY_STATE_KIND, organizationId: ORG, namespace: 'fv-bootstrap' }) ?? '', /state kind that has none/, 'no namespace beside the Host slot');
    const spellings = ['', ' fv-bootstrap-identity-state', 'fv-bootstrap-identity-state ', 'FV-BOOTSTRAP-IDENTITY-STATE', 'Fv-bootstrap-identity-state', 'fv‐bootstrap-identity-state', 'fv-bootstrap-identity-state\u0000', 'fv-bootstrap-identity-state​', 'human-identity-state:fv-bootstrap', 'human-identity-state/fv-bootstrap', 'human-identity-state.fv-bootstrap', 'fv-bootstrap'];
    for (const stateKind of spellings) {
      assert.match(authorityStateBindingProblem({ stateKind: stateKind as never, organizationId: ORG }) ?? '', /outside the closed set/, JSON.stringify(stateKind));
      // The witness refuses the request before it touches a record.
      const body = { protocol: AUTHORITY_STATE_WITNESS_PROTOCOL, challenge: '1'.repeat(64), binding: { stateKind, organizationId: ORG } };
      assert.equal(parseWitnessRequest('read', body), undefined, JSON.stringify(stateKind));
    }
    // An organization is never aliased by a separator inside the binding either: it is a separate JSON field.
    assert.notEqual(
      serializeAuthorityStateCheckpoint({ stateKind: 'fv-bootstrap-identity-state', organizationId: 'a', storeId: 's', sequence: 0, stateDigest: `sha256:${'b'.repeat(64)}` }),
      serializeAuthorityStateCheckpoint({ stateKind: 'human-identity-state', organizationId: 'a', storeId: 's', sequence: 0, stateDigest: `sha256:${'b'.repeat(64)}` }),
    );
  });
});

describe('CORE-07-FV-WITNESS AUTH-03 store — the domain is the owner’s, named explicitly, never defaulted into the Host slot', () => {
  it('the Host store keeps the legacy slot with no new option; the FV domain belongs to the exclusive owner only and must be named', async () => {
    const witness = await startWitness();
    const boundary = await boundaryFor(witness, ORG);
    const dir = directory();
    const host = await hostStore(join(dir, 'host.sqlite'), boundary, true);
    assert.equal((await slotOf(witness, 'human-identity-state'))?.['store_id'], host.storeId, 'AUTH-04A-style open: the legacy slot');
    host.close();
    const refused = async (options: Record<string, unknown>, label: string): Promise<void> => {
      await assert.rejects(
        openSqliteHumanIdentityStore(join(dir, `${label}.sqlite`), { organizationId: ORG, now: () => NOW, authenticity, create: true, ...options } as never),
        (error: { code?: string }) => error.code === 'HUMAN_IDENTITY_CONFIGURATION_INVALID',
        label,
      );
    };
    const exclusive = { beforeWrite: () => undefined, closer: plainCloser };
    await refused({ freshness: { boundary, stateKind: FV_BOOTSTRAP_IDENTITY_STATE_KIND } }, 'fv-domain-without-exclusive-owner');
    await refused({ freshness: { boundary }, exclusive }, 'exclusive-owner-omitting-its-domain');
    await refused({ freshness: { boundary, stateKind: HOST_IDENTITY_STATE_KIND }, exclusive }, 'exclusive-owner-naming-the-host-slot');
    await refused({ freshness: { boundary, stateKind: 'approval-state' }, exclusive }, 'another-kind');
    await refused({ freshness: { boundary, stateKind: 'fv-bootstrap-identity-state ' }, exclusive }, 'malformed-domain');
    await refused({ freshness: { boundary, stateKind: FV_BOOTSTRAP_IDENTITY_STATE_KIND, enrollment: { operator: true, operatorId: 'ops', attestation: 'verified-local-state-is-current' } }, exclusive }, 'exclusive-enrollment');
    // A refused open created nothing at the witness.
    assert.equal(await slotOf(witness, FV_BOOTSTRAP_IDENTITY_STATE_KIND), undefined);
  });

  it('review M1: a stateful getter cannot hide an enrollment from the exclusive owner’s refusal — each freshness field is read once', async () => {
    const witness = await startWitness();
    const boundary = await boundaryFor(witness, ORG);
    const path = join(directory(), 'fv-existing.sqlite');
    // An existing FV store, never anchored.
    const existing = await openSqliteHumanIdentityStore(path, { organizationId: ORG, now: () => NOW, authenticity, create: true, exclusive: { beforeWrite: () => undefined, closer: plainCloser } });
    const storeId = existing.storeId;
    await advance(existing);
    existing.close();
    let reads = 0;
    const freshness = {
      boundary,
      stateKind: FV_BOOTSTRAP_IDENTITY_STATE_KIND,
      get enrollment() {
        reads += 1;
        return reads === 1 ? undefined : { operator: true, operatorId: 'ops', attestation: 'verified-local-state-is-current' };
      },
    };
    await assert.rejects(
      openSqliteHumanIdentityStore(path, { organizationId: ORG, now: () => NOW, authenticity, freshness: freshness as never, exclusive: { beforeWrite: () => undefined, closer: plainCloser, storeId } }),
      (error: { code?: string }) => error.code === 'AUTHORITY_FRESHNESS_UNBOUND_STORE',
      'the snapshot read no enrollment, so the unbound store is refused, never enrolled',
    );
    assert.equal(reads, 1);
    assert.equal(await slotOf(witness, FV_BOOTSTRAP_IDENTITY_STATE_KIND), undefined, 'nothing enrolled');
  });
});

describe('CORE-07-FV-WITNESS independence — one witness, one organization, two identity domains', () => {
  it('each domain has its own genesis store id and its own monotonic position; advancing one never advances the other', async () => {
    const witness = await startWitness();
    const dir = directory();
    const host = await hostStore(join(dir, 'host.sqlite'), await boundaryFor(witness, ORG), true);
    // The Host is still at genesis: the FV genesis must not adopt it (genesis adoption is per slot).
    const fv = await fvStore(join(dir, 'fv.sqlite'), await boundaryFor(witness, ORG), true);
    assert.notEqual(fv.storeId, host.storeId);
    await advance(host);
    await advance(host);
    await advance(fv);
    assert.equal((await slotOf(witness, 'human-identity-state'))?.['committed_sequence'], 2);
    assert.equal((await slotOf(witness, FV_BOOTSTRAP_IDENTITY_STATE_KIND))?.['committed_sequence'], 1);
    // Concurrent advancement of both domains: serialized per slot, independent across them.
    await Promise.all([advance(host), advance(fv), advance(fv)]);
    assert.equal((await slotOf(witness, 'human-identity-state'))?.['committed_sequence'], 3);
    assert.equal((await slotOf(witness, FV_BOOTSTRAP_IDENTITY_STATE_KIND))?.['committed_sequence'], 3);
    assert.equal(host.head().sequence, 3);
    assert.equal(fv.head().sequence, 3);
    host.close();
    fv.close();
    // Reopened, each is established against its own slot only.
    (await hostStore(join(dir, 'host.sqlite'), await boundaryFor(witness, ORG))).close();
    (await fvStore(join(dir, 'fv.sqlite'), await boundaryFor(witness, ORG), false, fv.storeId)).close();
  });

  it('a store is never anchored in two domains: the Host store id cannot become the FV genesis or baseline, nor the reverse', async () => {
    const witness = await startWitness();
    const dir = directory();
    const host = await hostStore(join(dir, 'host.sqlite'), await boundaryFor(witness, ORG), true);
    await advance(host);
    const hostId = host.storeId;
    host.close();
    const { anchor } = await connect(witness);
    // A genesis of the Host's store id in the FV slot (correct genesis digest): refused, the FV slot left unbound.
    const genesis: AuthorityStateCheckpoint = { stateKind: FV_BOOTSTRAP_IDENTITY_STATE_KIND, organizationId: ORG, storeId: hostId, sequence: 0, stateDigest: humanIdentityGenesisDigest(hostId, ORG) };
    const answer = await anchor.enroll('genesis', genesis);
    assert.equal(answer.outcome, 'conflict');
    assert.equal(answer.state.status, 'unbound');
    // A copy of the Host store offered as the FV baseline, through the explicit enrollment ceremony: refused.
    copyFileSync(join(dir, 'host.sqlite'), join(dir, 'host-copy.sqlite'));
    const copy = await openSqliteHumanIdentityStore(join(dir, 'host-copy.sqlite'), { organizationId: ORG, now: () => NOW, authenticity });
    opened.push(copy);
    const head = humanIdentityStateCheckpoint(copy.head(), FV_BOOTSTRAP_IDENTITY_STATE_KIND);
    const watched = new ScriptedWitnessTransport(createHttpAuthorityStateWitnessTransport({ endpoint: witness.endpoint, credential: WITNESS_TOKEN }));
    const client = await connect(witness, { transport: watched });
    await assert.rejects(
      createAuthorityStateFreshnessBoundary({ anchor: client.anchor, monitor: client.monitor, organizationId: ORG }).establish(head, () => head, { enrollment: { operator: true, operatorId: 'ops', attestation: 'verified-local-state-is-current' } }),
      (error: { code?: string; message?: string }) => error.code === 'AUTHORITY_FRESHNESS_ALREADY_ENROLLED' && /already anchored in the human-identity-state freshness domain/.test(error.message ?? ''),
    );
    assert.equal(watched.count('enroll'), 0, 'the client refuses before it asks the witness to enroll');
    // The witness's own atomic rule, without the client's check: a baseline of the Host store id in the FV slot.
    const baseline = await anchor.enroll('baseline', head);
    assert.equal(baseline.outcome, 'conflict');
    assert.equal(baseline.state.status, 'unbound');
    copy.close();
    assert.equal(await slotOf(witness, FV_BOOTSTRAP_IDENTITY_STATE_KIND), undefined);
    // The reverse, in another organization whose Host slot is unbound: an FV store copied to the Host's path and
    // enrolled by the Host's ceremony is refused by the witness's own rule, and the Host slot stays unbound.
    const otherAdmin = identityAdministratorFor({ plane: 'operator', operatorId: 'ops-admin', organizationId: OTHER_ORG, role: 'organization-administrator', credentialClass: 'operator', actorRef: 'operator-plane:ops-admin' });
    const fv = await openSqliteHumanIdentityStore(join(dir, 'fv-other.sqlite'), {
      organizationId: OTHER_ORG,
      now: () => NOW,
      authenticity,
      create: true,
      freshness: { boundary: await boundaryFor(witness, OTHER_ORG), stateKind: FV_BOOTSTRAP_IDENTITY_STATE_KIND },
      exclusive: { beforeWrite: () => undefined, closer: plainCloser },
    });
    // FV-P4C-2B3C-2A2B: an FV store refuses Host administration; its owner advances it by one row.
    void otherAdmin;
    await advance(fv);
    fv.close();
    copyFileSync(join(dir, 'fv-other.sqlite'), join(dir, 'host-other.sqlite'));
    await assert.rejects(
      openSqliteHumanIdentityStore(join(dir, 'host-other.sqlite'), { organizationId: OTHER_ORG, now: () => NOW, authenticity, freshness: { boundary: await boundaryFor(witness, OTHER_ORG), enrollment: { operator: true, operatorId: 'ops', attestation: 'verified-local-state-is-current' } } }),
      (error: { code?: string }) => error.code === 'AUTHORITY_FRESHNESS_ALREADY_ENROLLED',
    );
    assert.equal(await slotOf(witness, 'human-identity-state', OTHER_ORG), undefined);
    // PR #258 review: the Host's enrollment ceremony makes exactly its previous witness calls — never a read of the FV
    // domain — so it keeps working against a witness that predates the FV kind.
    const hostCalls = new ScriptedWitnessTransport(createHttpAuthorityStateWitnessTransport({ endpoint: witness.endpoint, credential: WITNESS_TOKEN }));
    const kindsRead: string[] = [];
    hostCalls.answer = (request, forward) => {
      if (request.operation === 'read') kindsRead.push(request.binding.stateKind);
      return forward();
    };
    const hostClient = await connect(witness, { transport: hostCalls });
    const newHost = await openSqliteHumanIdentityStore(join(dir, 'host-new.sqlite'), { organizationId: 'org-core07-fv-third', now: () => NOW, authenticity, create: true });
    newHost.close();
    const enrolled = await openSqliteHumanIdentityStore(join(dir, 'host-new.sqlite'), { organizationId: 'org-core07-fv-third', now: () => NOW, authenticity, freshness: { boundary: createAuthorityStateFreshnessBoundary({ anchor: hostClient.anchor, monitor: hostClient.monitor, organizationId: 'org-core07-fv-third' }), enrollment: { operator: true, operatorId: 'ops', attestation: 'verified-local-state-is-current' } } });
    enrolled.close();
    assert.ok(kindsRead.length > 0);
    assert.deepEqual([...new Set(kindsRead)], ['human-identity-state'], 'the Host enrollment never reads another domain');
    // Without the ceremony, the copy is simply unbound in the Host domain: never adopted.
    await assert.rejects(
      openSqliteHumanIdentityStore(join(dir, 'host-other.sqlite'), { organizationId: OTHER_ORG, now: () => NOW, authenticity, freshness: { boundary: await boundaryFor(witness, OTHER_ORG) } }),
      (error: { code?: string }) => error.code === 'AUTHORITY_FRESHNESS_UNBOUND_STORE',
    );
  });

  it('a crash between the FV genesis enrollment and the local genesis: the next initialization adopts that same store id, in its own domain only', async () => {
    const witness = await startWitness();
    const { anchor } = await connect(witness);
    const dir = directory();
    // The witness holds an FV genesis whose local file was never written (the crash), and the Host holds its own.
    const crashed = 'human-identity-store:33333333-3333-4333-8333-333333333333';
    assert.equal((await anchor.enroll('genesis', { stateKind: FV_BOOTSTRAP_IDENTITY_STATE_KIND, organizationId: ORG, storeId: crashed, sequence: 0, stateDigest: humanIdentityGenesisDigest(crashed, ORG) })).outcome, 'enrolled');
    const host = await hostStore(join(dir, 'host.sqlite'), await boundaryFor(witness, ORG), true);
    assert.notEqual(host.storeId, crashed, 'the Host never adopts the FV domain’s genesis');
    host.close();
    const fv = await fvStore(join(dir, 'fv.sqlite'), await boundaryFor(witness, ORG), true);
    assert.equal(fv.storeId, crashed, 'the FV initialization adopts its own domain’s witnessed genesis');
    await advance(fv);
    fv.close();
    // Once beyond genesis, an emptied FV file is never re-initialized.
    rmSync(join(dir, 'fv.sqlite'));
    await assert.rejects(fvStore(join(dir, 'fv.sqlite'), await boundaryFor(witness, ORG), true), (error: { code?: string }) => error.code === 'AUTHORITY_FRESHNESS_ROLLBACK_DETECTED');
  });

  it('genesis: a repeated identical enrollment is idempotent, a conflicting one is refused; the slot never rebinds', async () => {
    const witness = await startWitness();
    const { anchor } = await connect(witness);
    const id = 'human-identity-store:11111111-1111-4111-8111-111111111111';
    const genesis: AuthorityStateCheckpoint = { stateKind: FV_BOOTSTRAP_IDENTITY_STATE_KIND, organizationId: ORG, storeId: id, sequence: 0, stateDigest: humanIdentityGenesisDigest(id, ORG) };
    assert.equal((await anchor.enroll('genesis', genesis)).outcome, 'enrolled');
    assert.equal((await anchor.enroll('genesis', genesis)).outcome, 'enrolled', 'the same genesis, repeated (an acknowledgment lost)');
    const other = 'human-identity-store:22222222-2222-4222-8222-222222222222';
    const conflicting = await anchor.enroll('genesis', { ...genesis, storeId: other, stateDigest: humanIdentityGenesisDigest(other, ORG) });
    assert.equal(conflicting.outcome, 'conflict');
    assert.equal(conflicting.state.status === 'bound' ? conflicting.state.storeId : undefined, id);
    // Concurrent conflicting prepares in the FV domain: exactly one wins.
    const next = (digit: string): AuthorityStateCheckpoint => ({ ...genesis, sequence: 1, stateDigest: `sha256:${digit.repeat(64)}` });
    const outcomes = (await Promise.all([anchor.prepare(genesis, next('c')), anchor.prepare(genesis, next('d'))])).map((entry) => entry.outcome).sort();
    assert.deepEqual(outcomes, ['conflict', 'prepared']);
    // The FV genesis enrollment touched no other slot.
    assert.equal(await slotOf(witness, 'human-identity-state'), undefined);
  });
});

describe('CORE-07-FV-WITNESS authentication — a proof about one domain never answers another', () => {
  /** An FV-domain boundary whose transport answers each `read` with `answerFor(request)` forwarded to the real witness. */
  async function rerouted(witness: StartedWitness, reroute: (request: WitnessRequest) => WitnessRequest): Promise<AuthorityStateFreshnessBoundary> {
    const scripted = new ScriptedWitnessTransport(createHttpAuthorityStateWitnessTransport({ endpoint: witness.endpoint, credential: WITNESS_TOKEN }));
    const inner = createHttpAuthorityStateWitnessTransport({ endpoint: witness.endpoint, credential: WITNESS_TOKEN });
    scripted.answer = (request, forward) => (request.operation === 'read' ? inner.call(reroute(request), { timeoutMs: 2_000 }) : forward());
    const { anchor, monitor } = await connect(witness, { transport: scripted });
    return createAuthorityStateFreshnessBoundary({ anchor, monitor, organizationId: ORG });
  }

  it('a genuine, signed Host receipt — same challenge — offered for an FV read is refused (binding), and so is another organization’s', async () => {
    const witness = await startWitness();
    const dir = directory();
    const fv = await fvStore(join(dir, 'fv.sqlite'), await boundaryFor(witness, ORG), true);
    const fvId = fv.storeId;
    fv.close();
    const host = await hostStore(join(dir, 'host.sqlite'), await boundaryFor(witness, ORG), true);
    host.close();
    const asHost = (request: WitnessRequest): WitnessRequest => (request.operation === 'read' ? { ...request, binding: { stateKind: HOST_IDENTITY_STATE_KIND, organizationId: ORG } } : request);
    await assert.rejects(fvStore(join(dir, 'fv.sqlite'), await rerouted(witness, asHost), false, fvId), (error: { code?: string }) => error.code === 'AUTHORITY_FRESHNESS_BINDING_MISMATCH');
    const asOtherOrg = (request: WitnessRequest): WitnessRequest => (request.operation === 'read' ? { ...request, binding: { stateKind: FV_BOOTSTRAP_IDENTITY_STATE_KIND, organizationId: OTHER_ORG } } : request);
    await assert.rejects(fvStore(join(dir, 'fv.sqlite'), await rerouted(witness, asOtherOrg), false, fvId), (error: { code?: string }) => error.code === 'AUTHORITY_FRESHNESS_BINDING_MISMATCH');
    // The reverse: an FV receipt offered for the Host's read.
    const scripted = new ScriptedWitnessTransport(createHttpAuthorityStateWitnessTransport({ endpoint: witness.endpoint, credential: WITNESS_TOKEN }));
    const inner = createHttpAuthorityStateWitnessTransport({ endpoint: witness.endpoint, credential: WITNESS_TOKEN });
    scripted.answer = (request, forward) => (request.operation === 'read' ? inner.call({ ...request, binding: { stateKind: FV_BOOTSTRAP_IDENTITY_STATE_KIND, organizationId: ORG } }, { timeoutMs: 2_000 }) : forward());
    const { anchor, monitor } = await connect(witness, { transport: scripted });
    await assert.rejects(hostStore(join(dir, 'host.sqlite'), createAuthorityStateFreshnessBoundary({ anchor, monitor, organizationId: ORG })), (error: { code?: string }) => error.code === 'AUTHORITY_FRESHNESS_BINDING_MISMATCH');
    // And the honest path still opens both.
    (await fvStore(join(dir, 'fv.sqlite'), await boundaryFor(witness, ORG), false, fvId)).close();
    (await hostStore(join(dir, 'host.sqlite'), await boundaryFor(witness, ORG))).close();
  });

  it('a recorded FV receipt replayed to a later read (an older proof) is refused: it answers another challenge', async () => {
    const witness = await startWitness();
    const dir = directory();
    const fv = await fvStore(join(dir, 'fv.sqlite'), await boundaryFor(witness, ORG), true);
    const fvId = fv.storeId;
    fv.close();
    let recorded: unknown;
    const scripted = new ScriptedWitnessTransport(createHttpAuthorityStateWitnessTransport({ endpoint: witness.endpoint, credential: WITNESS_TOKEN }));
    scripted.answer = async (request, forward) => {
      if (request.operation !== 'read') return forward();
      if (recorded === undefined) recorded = await forward();
      return recorded;
    };
    const { anchor, monitor } = await connect(witness, { transport: scripted });
    const boundary = createAuthorityStateFreshnessBoundary({ anchor, monitor, organizationId: ORG });
    // The first open records a genuine answer; the store then advances, and a second open is handed the old one.
    const first = await fvStore(join(dir, 'fv.sqlite'), boundary, false, fvId);
    await advance(first);
    first.close();
    await assert.rejects(fvStore(join(dir, 'fv.sqlite'), boundary, false, fvId), (error: { code?: string }) => error.code === 'AUTHORITY_FRESHNESS_WITNESS_UNAUTHENTIC');
  });
});

describe('CORE-07-FV-WITNESS crash, uncertainty and recovery — never an automatic reset, re-enrollment or repair', () => {
  it('a finalize whose acknowledgment is lost is completed safely; a prepare whose acknowledgment is lost leaves the FV store refused, the Host untouched', async () => {
    const witness = await startWitness();
    const dir = directory();
    const host = await hostStore(join(dir, 'host.sqlite'), await boundaryFor(witness, ORG), true);
    await advance(host);
    const fvPath = join(dir, 'fv.sqlite');
    const fvId = (await fvStore(fvPath, await boundaryFor(witness, ORG), true)).storeId;
    opened.at(-1)?.close();
    const scripted = new ScriptedWitnessTransport(createHttpAuthorityStateWitnessTransport({ endpoint: witness.endpoint, credential: WITNESS_TOKEN }));
    const { anchor, monitor } = await connect(witness, { transport: scripted });
    let lose: 'finalize' | 'prepare' | undefined;
    scripted.answer = async (request, forward) => {
      const answer = await forward();
      if (request.operation === lose) {
        lose = undefined;
        throw new Error('the acknowledgment was lost after the witness applied it');
      }
      return answer;
    };
    const fv = await fvStore(fvPath, createAuthorityStateFreshnessBoundary({ anchor, monitor, organizationId: ORG }), false, fvId);
    // 1. finalize applied, acknowledgment lost: local and witness agree; the next start completes nothing new and opens.
    lose = 'finalize';
    await advance(fv);
    assert.equal(fv.head().sequence, 1);
    fv.close();
    const reopened = await fvStore(fvPath, await boundaryFor(witness, ORG), false, fvId);
    assert.equal((await slotOf(witness, FV_BOOTSTRAP_IDENTITY_STATE_KIND))?.['committed_sequence'], 1);
    reopened.close();
    // 2. prepare applied, acknowledgment lost: nothing written locally, the witness holds a successor the store does not.
    const again = await fvStore(fvPath, createAuthorityStateFreshnessBoundary({ anchor, monitor, organizationId: ORG }), false, fvId);
    lose = 'prepare';
    await assert.rejects(advance(again), (error: { code?: string }) => error.code === 'AUTHORITY_FRESHNESS_UNAVAILABLE');
    assert.equal(again.head().sequence, 1, 'nothing was written locally');
    again.close();
    // Uncertain: indistinguishable from "committed, then rolled back". Refused at every start; never auto-cleared.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assert.rejects(fvStore(fvPath, await boundaryFor(witness, ORG), false, fvId), (error: { code?: string }) => error.code === 'AUTHORITY_FRESHNESS_PENDING_RECOVERY');
    }
    const fvSlot = await slotOf(witness, FV_BOOTSTRAP_IDENTITY_STATE_KIND);
    assert.equal(fvSlot?.['committed_sequence'], 1);
    assert.equal(fvSlot?.['pending_sequence'], 2);
    // The Host's domain never noticed.
    await advance(host);
    assert.equal((await slotOf(witness, 'human-identity-state'))?.['committed_sequence'], 2);
    assert.equal((await slotOf(witness, 'human-identity-state'))?.['pending_sequence'], null);
  });

  it('a witness outage refuses the FV store (no fallback, no empty witness); the same witness restarted restores it; another key is never trusted', async () => {
    const witness = await startWitness();
    const dir = directory();
    const fvPath = join(dir, 'fv.sqlite');
    const fv = await fvStore(fvPath, await boundaryFor(witness, ORG), true);
    const fvId = fv.storeId;
    await advance(fv);
    fv.close();
    const boundary = await boundaryFor(witness, ORG);
    await witness.close();
    await assert.rejects(fvStore(fvPath, boundary, false, fvId), (error: { code?: string }) => error.code === 'AUTHORITY_FRESHNESS_UNAVAILABLE');
    // A different key over the same database is another witness: refused at the handshake under the pinned key.
    const impostor = await startWitness({ directory: witness.directory, witnessId: witness.witnessId });
    await assert.rejects(boundaryFor({ endpoint: impostor.endpoint, witnessId: witness.witnessId, publicKeyPem: witness.publicKeyPem }, ORG), (error: { code?: string }) => error.code === 'AUTHORITY_FRESHNESS_WITNESS_UNAUTHENTIC');
    await impostor.close();
    const restarted = await witness.restart();
    (await fvStore(fvPath, await boundaryFor(restarted, ORG), false, fvId)).close();
    assert.equal((await slotOf(restarted, FV_BOOTSTRAP_IDENTITY_STATE_KIND))?.['committed_sequence'], 1, 'nothing re-enrolled or reset');
  });

  it('a restarted witness keeps both domains; a corrupted FV witness record refuses the FV store only', async () => {
    const witness = await startWitness();
    const dir = directory();
    const host = await hostStore(join(dir, 'host.sqlite'), await boundaryFor(witness, ORG), true);
    await advance(host);
    host.close();
    const fvPath = join(dir, 'fv.sqlite');
    const fv = await fvStore(fvPath, await boundaryFor(witness, ORG), true);
    const fvId = fv.storeId;
    await advance(fv);
    fv.close();
    const restarted = await witness.restart();
    (await fvStore(fvPath, await boundaryFor(restarted, ORG), false, fvId)).close();
    (await hostStore(join(dir, 'host.sqlite'), await boundaryFor(restarted, ORG))).close();
    await restarted.close();
    // The FV slot's committed digest corrupted: the same sequence, another state.
    const db = new Database(restarted.databasePath);
    db.prepare("UPDATE witness_bindings_v2 SET committed_digest = ? WHERE state_kind = 'fv-bootstrap-identity-state'").run(`sha256:${'e'.repeat(64)}`);
    db.close();
    const again = await restarted.restart();
    await assert.rejects(fvStore(fvPath, await boundaryFor(again, ORG), false, fvId), (error: { code?: string }) => error.code === 'AUTHORITY_FRESHNESS_FORK_DETECTED');
    (await hostStore(join(dir, 'host.sqlite'), await boundaryFor(again, ORG))).close();
  });
});
