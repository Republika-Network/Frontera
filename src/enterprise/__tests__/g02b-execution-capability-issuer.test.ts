import { copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { executionCapabilityGrantReferenceV2, type AuthorityArtifactSigner, type AuthoritySignature, type ExecutionCapabilityIssuanceRequest } from '../authority-authenticity/index.js';
import { createExecutionCapabilityVerifier, executionCapabilityGrantReference, serializeExecutionCapability } from '../execution-capability/index.js';
import { openExecutionCapabilityConsumptionLedger } from '../execution-capability/reference/consumption-ledger.js';
import {
  ExecutionCapabilityIssuanceError,
  createExecutionCapabilityIssuer,
  createExecutionCapabilityIssuerSlot,
  type ExecutionCapabilityIssuanceLedger,
  type ExecutionCapabilitySignedGrantReader,
} from '../execution-capability-issuance/index.js';
import { AUTHORITY_KEY_A, AUTHORITY_KEY_B, openDurableStore, testVerifier, trustedKeyOf } from './authority-authenticity-fixture.js';
import {
  G02B_ACTION,
  G02B_AUDIENCE,
  G02B_BINDING_FORMAT,
  G02B_ISSUER,
  G02B_ORGANIZATION,
  G02B_OTHER_AUDIENCE,
  G02B_RESOURCE,
  G02B_TRUST_DOMAIN,
  LedgerDirectory,
  NOW,
  POLICY,
  custodySigner,
  grantFor,
  inputFor,
  policyInput,
  readerOf,
  signCapabilityBytes,
  signedGrant,
  type SignedGrant,
} from './g02b-execution-capability-issuance-fixture.js';

/**
 * G-02B — the Host-side issuer: reserve before custody, one custody call,
 * local verification, commit; never a second identity for an execution, and
 * every failure classified as never requested or possibly requested. Then the
 * D7 rollback model, end to end through G-02A's executor side.
 */

const ledgers = new LedgerDirectory();
after(() => ledgers.cleanup());

const BINDING_VALUE = { method: 'PATCH', path: '/deployments/production-cluster-eu', body: { replicas: 4 } };

/** A custody boundary that counts calls; `behaviour` replaces what it does. */
function counted(behaviour?: (request: ExecutionCapabilityIssuanceRequest) => Promise<AuthoritySignature>, base: AuthorityArtifactSigner = custodySigner()): { readonly signer: AuthorityArtifactSigner; calls(): number } {
  let calls = 0;
  const signer: AuthorityArtifactSigner = {
    ...base,
    signExecutionCapability: async (request: ExecutionCapabilityIssuanceRequest) => {
      calls += 1;
      return behaviour !== undefined ? behaviour(request) : base.signExecutionCapability!(request);
    },
  };
  return { signer, calls: () => calls };
}

async function issuerOver(options: { readonly grants: ExecutionCapabilitySignedGrantReader; readonly signer?: AuthorityArtifactSigner; readonly ledger?: ExecutionCapabilityIssuanceLedger; readonly verifierKeys?: Parameters<typeof testVerifier>[0]; readonly now?: () => number }) {
  const ledger = options.ledger ?? (await ledgers.create());
  const issuer = createExecutionCapabilityIssuer({ grants: options.grants, signer: options.signer ?? custodySigner(), verifier: testVerifier(options.verifierKeys ?? [AUTHORITY_KEY_A]), policy: POLICY, ledger, now: options.now ?? (() => NOW) });
  return { issuer, ledger };
}

const failsWith = (code: string, custody: 'never-requested' | 'possibly-requested') => (error: unknown) => error instanceof ExecutionCapabilityIssuanceError && error.code === code && error.custody === custody;

function executorVerifier(audience = G02B_AUDIENCE, clock = NOW + 1_000) {
  return createExecutionCapabilityVerifier({
    trustedIssuers: [{ issuer: G02B_ISSUER, keys: [trustedKeyOf(AUTHORITY_KEY_A)] }],
    executor: { audience, organizationIds: [G02B_ORGANIZATION], trustDomain: G02B_TRUST_DOMAIN },
    clock: () => clock,
  });
}

describe('G-02B issuer — issuance', () => {
  it('issues one capability, recorded issued with its locally verified signature, that the standalone executor verifier accepts', async () => {
    const signed = await signedGrant();
    const custody = counted();
    const { issuer, ledger } = await issuerOver({ grants: readerOf([signed]), signer: custody.signer });
    const issued = await issuer.issue(inputFor(signed));
    assert.equal(custody.calls(), 1);
    assert.equal(issued.canonical, serializeExecutionCapability(issued.capability));
    assert.equal(issued.capability.issuer, G02B_ISSUER);
    assert.equal(issued.capability.subjectActorId, signed.grant.subject);
    assert.equal(issued.capability.onBehalfOfActorId, null);
    assert.equal(issued.capability.statusRequirement, 'offline-permitted');
    assert.equal(issued.capability.consumption, 'single-use');
    assert.equal(Date.parse(issued.capability.expiresAt) - Date.parse(issued.capability.issuedAt), 30_000);
    const record = ledger.read(issued.capability.executionId);
    assert.equal(record.state, 'issued');
    assert.equal(issuer.inspect(issued.capability.executionId), 'issued');
    const verdict = executorVerifier().verify({ presentation: { capability: issued.canonical, signature: issued.signature }, action: G02B_ACTION, resource: G02B_RESOURCE, actionBinding: { format: G02B_BINDING_FORMAT, value: BINDING_VALUE } });
    assert.equal(verdict.verification, 'verified');
  });

  it('a capability never outlives its grant', async () => {
    const signed = await signedGrant({ expiresAt: NOW + 10_000 });
    const { issuer } = await issuerOver({ grants: readerOf([signed]) });
    const issued = await issuer.issue(inputFor(signed));
    assert.equal(issued.capability.expiresAt, signed.grant.expiresAt);
  });

  it('the nonce stays in the Host: absent from the capability text and the returned value, kept in the ledger, and it recomputes the reference', async () => {
    const signed = await signedGrant();
    const { issuer, ledger } = await issuerOver({ grants: readerOf([signed]) });
    const issued = await issuer.issue(inputFor(signed));
    const record = ledger.read(issued.capability.executionId);
    assert.ok(record.state !== 'absent');
    assert.equal(issued.canonical.includes(record.grantReferenceNonce), false);
    assert.equal(JSON.stringify(issued).includes(record.grantReferenceNonce), false);
    assert.equal(executionCapabilityGrantReferenceV2({ nonce: record.grantReferenceNonce, grantStoreId: record.grantStoreId, boundedGrantId: record.boundedGrantId, grantDigest: record.grantDigest }), issued.capability.grantReference);
    assert.notEqual(issued.capability.grantReference, executionCapabilityGrantReference({ grantStoreId: signed.storeId, boundedGrantId: signed.grant.id, grantDigest: signed.grant.digest }), 'not G-02A’s per-grant value');
    assert.equal(issued.canonical.includes(signed.grant.id) || issued.canonical.includes(signed.storeId) || issued.canonical.includes(signed.grant.digest), false, 'no grant identity crosses');
  });
});

describe('G-02B issuer — refusals before custody leave no record and ask nothing', () => {
  const cases: readonly [string, (signed: SignedGrant) => { readonly grants?: ExecutionCapabilitySignedGrantReader; readonly input?: Record<string, unknown>; readonly verifierKeys?: Parameters<typeof testVerifier>[0] }, string][] = [
    ['an absent grant', () => ({ grants: readerOf([]) }), 'CAPABILITY_GRANT_NOT_FOUND'],
    ['a revoked grant', (signed) => ({ grants: readerOf([signed], [signed.grant.id]) }), 'CAPABILITY_GRANT_REVOKED'],
    ['an unreadable grant store', () => ({ grants: { readSigned: () => Promise.reject(new Error('store unavailable')) } }), 'CAPABILITY_GRANT_UNAVAILABLE'],
    ['an unregistered audience', () => ({ input: { audience: 'executor-unknown' } }), 'CAPABILITY_REFUSED'],
    // `*` is not even a well-formed audience: the G-02A codec refuses it before the rule is consulted.
    ['a wildcard audience', () => ({ input: { audience: '*' } }), 'CAPABILITY_REQUEST_INVALID'],
    ['another action', () => ({ input: { action: 'export-records' } }), 'CAPABILITY_REFUSED'],
    ['another resource', () => ({ input: { resource: 'production-cluster-us' } }), 'CAPABILITY_REFUSED'],
    ['an execution not derived from the grant', () => ({ input: { executionId: 'aoc.exec:0123456789abcdef0123456789abcdef' } }), 'CAPABILITY_REFUSED'],
    ['an unregistered binding format', () => ({ input: { actionBinding: { format: 'frontera.other-binding.v1', digest: `sha256:${'1'.repeat(64)}` } } }), 'CAPABILITY_REFUSED'],
    ['a stale trust registry that does not hold the active key', () => ({ verifierKeys: [AUTHORITY_KEY_B] }), 'CAPABILITY_REFUSED'],
    ['a malformed request', () => ({ input: { actionBinding: { format: G02B_BINDING_FORMAT, digest: 'not-a-digest' } } }), 'CAPABILITY_REQUEST_INVALID'],
  ];
  for (const [name, setup, code] of cases) {
    it(`${name} → ${code}`, async () => {
      const signed = await signedGrant();
      const { grants, input, verifierKeys } = setup(signed);
      const custody = counted();
      const { issuer, ledger } = await issuerOver({ grants: grants ?? readerOf([signed]), signer: custody.signer, ...(verifierKeys !== undefined ? { verifierKeys } : {}) });
      const request = { ...inputFor(signed), ...input };
      await assert.rejects(issuer.issue(request as never), failsWith(code, 'never-requested'));
      assert.equal(custody.calls(), 0, 'custody was never asked');
      assert.equal(ledger.read(String(request.executionId)).state, 'absent', 'nothing reserved');
    });
  }

  it('an expired grant (no remaining lifetime) is refused before any reservation; the rule itself refuses GRANT_EXPIRED (custody suite)', async () => {
    const signed = await signedGrant({ issuedAt: NOW - 120_000, expiresAt: NOW - 1 });
    const custody = counted();
    const { issuer, ledger } = await issuerOver({ grants: readerOf([signed]), signer: custody.signer });
    await assert.rejects(issuer.issue(inputFor(signed)), failsWith('CAPABILITY_REQUEST_INVALID', 'never-requested'));
    assert.equal(custody.calls(), 0);
    assert.equal(ledger.read(inputFor(signed).executionId).state, 'absent');
  });

  it('a signer without the operation is refused before anything is read', async () => {
    const signed = await signedGrant();
    const grants = readerOf([signed]);
    const { signExecutionCapability: _unused, ...without } = custodySigner();
    const { issuer } = await issuerOver({ grants, signer: without as AuthorityArtifactSigner });
    await assert.rejects(issuer.issue(inputFor(signed)), failsWith('CAPABILITY_ISSUER_UNSUPPORTED', 'never-requested'));
    assert.equal(grants.reads, 0);
  });

  it('an issuer is never built over a ledger recorded for another issuer', async () => {
    const ledger = await ledgers.create(undefined, { issuer: 'frontera-deployment-other' });
    assert.throws(() => createExecutionCapabilityIssuer({ grants: readerOf([]), signer: custodySigner(), verifier: testVerifier(), policy: POLICY, ledger }), failsWith('CAPABILITY_REQUEST_INVALID', 'never-requested'));
  });
});

describe('G-02B issuer — the real authenticated durable grant store decides revocation', () => {
  it('issues for a stored grant, refuses once the store has revoked it, and refuses a grant the store does not hold', async () => {
    const store = await openDurableStore(join(ledgers.dir, `grants-${Date.now()}.sqlite`));
    try {
      const now = Date.now();
      const kept = grantFor({ issuedAt: now - 60_000, expiresAt: now + 3_600_000 });
      const revoked = grantFor({ issuedAt: now - 60_000, expiresAt: now + 3_600_000 });
      for (const grant of [kept, revoked]) assert.equal((await store.issue({ grant, commitGuard: () => ({ permitted: true, reasonCodes: [] }) })).outcome, 'issued');
      assert.equal((await store.revoke({ grantId: revoked.id, reason: 'administrator-revoked', revokedAt: new Date(now).toISOString(), issuerRef: 'operator:g02b' })).outcome, 'revoked');
      const ledger = await ledgers.create(undefined, { clock: Date.now });
      const issuer = createExecutionCapabilityIssuer({ grants: store, signer: custodySigner(AUTHORITY_KEY_A, policyInput(), Date.now), verifier: testVerifier([AUTHORITY_KEY_A]), policy: POLICY, ledger, now: Date.now });
      const issued = await issuer.issue(inputFor({ grant: kept }));
      assert.equal(ledger.read(issued.capability.executionId).state, 'issued');
      assert.equal(issued.capability.grantReference.startsWith('sha256:'), true);
      await assert.rejects(issuer.issue(inputFor({ grant: revoked })), failsWith('CAPABILITY_GRANT_REVOKED', 'never-requested'));
      await assert.rejects(issuer.issue(inputFor({ grant: grantFor() })), failsWith('CAPABILITY_GRANT_NOT_FOUND', 'never-requested'));
      assert.equal(ledger.read(inputFor({ grant: revoked }).executionId).state, 'absent');
    } finally {
      await store.close();
    }
  });
});

describe('G-02B issuer — after the reservation, nothing is ever issued twice', () => {
  it('a repeated execution is refused: already issued, custody not asked again', async () => {
    const signed = await signedGrant();
    const custody = counted();
    const { issuer } = await issuerOver({ grants: readerOf([signed]), signer: custody.signer });
    await issuer.issue(inputFor(signed));
    await assert.rejects(issuer.issue(inputFor(signed)), failsWith('CAPABILITY_ALREADY_ISSUED', 'never-requested'));
    await assert.rejects(issuer.issue(inputFor(signed, { audience: G02B_OTHER_AUDIENCE })), failsWith('CAPABILITY_ALREADY_ISSUED', 'never-requested'), 'not for another audience either');
    assert.equal(custody.calls(), 1);
  });

  it('signer outage: possibly requested, the row is uncertain, and a retry is refused without asking again', async () => {
    const signed = await signedGrant();
    const custody = counted(() => Promise.reject(new Error('custody unreachable')));
    const { issuer, ledger } = await issuerOver({ grants: readerOf([signed]), signer: custody.signer });
    await assert.rejects(issuer.issue(inputFor(signed)), failsWith('CAPABILITY_SIGNING_UNCERTAIN', 'possibly-requested'));
    assert.equal(ledger.read(inputFor(signed).executionId).state, 'uncertain');
    await assert.rejects(issuer.issue(inputFor(signed)), failsWith('CAPABILITY_OUTCOME_UNKNOWN', 'never-requested'));
    assert.equal(custody.calls(), 1);
  });

  it('an unverifiable signature (wrong key) is discarded and the row is uncertain', async () => {
    const signed = await signedGrant();
    const custody = counted(async (request) => signCapabilityBytes(request.capability, AUTHORITY_KEY_B));
    const { issuer, ledger } = await issuerOver({ grants: readerOf([signed]), signer: custody.signer, verifierKeys: [AUTHORITY_KEY_A, AUTHORITY_KEY_B] });
    await assert.rejects(issuer.issue(inputFor(signed)), failsWith('CAPABILITY_SIGNATURE_INVALID', 'possibly-requested'));
    assert.equal(ledger.read(inputFor(signed).executionId).state, 'uncertain');
  });

  it('custody is asked for exactly the reserved text: what it receives is the frozen canonical record the ledger holds', async () => {
    const signed = await signedGrant();
    let seen: ExecutionCapabilityIssuanceRequest | undefined;
    const base = custodySigner();
    const custody = counted(async (request) => {
      seen = request;
      return base.signExecutionCapability!(request);
    });
    const { issuer, ledger } = await issuerOver({ grants: readerOf([signed]), signer: custody.signer });
    await issuer.issue(inputFor(signed));
    const record = ledger.read(inputFor(signed).executionId);
    // Assigned inside the custody callback, which control-flow analysis does not follow.
    const observed = seen as ExecutionCapabilityIssuanceRequest | undefined;
    assert.ok(observed !== undefined && record.state !== 'absent');
    assert.equal(serializeExecutionCapability(observed.capability), record.canonical);
    assert.equal(observed.grantReferenceNonce, record.grantReferenceNonce);
  });

  it('crash after reservation (custody never answers, the process stops): the restarted Host finds outcome unknown and issues nothing', async () => {
    const signed = await signedGrant();
    const path = ledgers.path();
    const first = await ledgers.create(path);
    let reached: () => void = () => {};
    const atCustody = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const hung = counted(() => {
      reached();
      return new Promise<AuthoritySignature>(() => {});
    });
    const { issuer } = await issuerOver({ grants: readerOf([signed]), signer: hung.signer, ledger: first });
    void issuer.issue(inputFor(signed)).catch(() => {});
    await atCustody;
    first.close();
    // "Restart": a new issuer over a new connection to the same file.
    const custody = counted();
    const { issuer: restarted } = await issuerOver({ grants: readerOf([signed]), signer: custody.signer, ledger: await ledgers.reopen(path) });
    assert.equal(restarted.inspect(inputFor(signed).executionId), 'reserved');
    await assert.rejects(restarted.issue(inputFor(signed)), failsWith('CAPABILITY_OUTCOME_UNKNOWN', 'never-requested'));
    assert.equal(custody.calls(), 0);
  });

  it('crash after signature, before the durable commit: the signed capability is never released, and the execution stays outcome unknown', async () => {
    const signed = await signedGrant();
    const path = ledgers.path();
    const real = await ledgers.create(path);
    const crashing: ExecutionCapabilityIssuanceLedger = {
      ...real,
      issuer: real.issuer,
      reserve: (reservation) => real.reserve(reservation),
      read: (executionId) => real.read(executionId),
      readCapability: (capabilityId) => real.readCapability(capabilityId),
      markUncertain: (executionId, capabilityId) => real.markUncertain(executionId, capabilityId),
      markIssued: () => {
        throw new Error('the process stopped before the commit');
      },
      close: () => real.close(),
    };
    const custody = counted();
    const { issuer } = await issuerOver({ grants: readerOf([signed]), signer: custody.signer, ledger: crashing });
    await assert.rejects(issuer.issue(inputFor(signed)), failsWith('CAPABILITY_RECORD_FAILED', 'possibly-requested'));
    assert.equal(custody.calls(), 1);
    real.close();
    const { issuer: restarted } = await issuerOver({ grants: readerOf([signed]), signer: custody.signer, ledger: await ledgers.reopen(path) });
    assert.equal(restarted.inspect(inputFor(signed).executionId), 'reserved');
    await assert.rejects(restarted.issue(inputFor(signed)), failsWith('CAPABILITY_OUTCOME_UNKNOWN', 'never-requested'));
    assert.equal(custody.calls(), 1, 'never asked again');
  });

  it('concurrent issuance for one execution (in process, and across two connections): exactly one custody call, one capability', async () => {
    const signed = await signedGrant();
    const custody = counted();
    const path = ledgers.path();
    const a = await ledgers.create(path);
    const b = await ledgers.reopen(path);
    const one = (await issuerOver({ grants: readerOf([signed]), signer: custody.signer, ledger: a })).issuer;
    const two = (await issuerOver({ grants: readerOf([signed]), signer: custody.signer, ledger: b })).issuer;
    const outcomes = await Promise.allSettled([one, two, one, two, one].map((issuer) => issuer.issue(inputFor(signed))));
    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') assert.ok(failsWith('CAPABILITY_OUTCOME_UNKNOWN', 'never-requested')(outcome.reason) || failsWith('CAPABILITY_ALREADY_ISSUED', 'never-requested')(outcome.reason), String(outcome.reason));
    }
    assert.equal(custody.calls(), 1);
  });
});

describe('G-02B issuer — the write-once slot', () => {
  it('unbound refuses; binds once; a second bind is refused', async () => {
    const slot = createExecutionCapabilityIssuerSlot();
    const signed = await signedGrant();
    await assert.rejects(slot.issue(inputFor(signed)), failsWith('CAPABILITY_ISSUER_UNBOUND', 'never-requested'));
    assert.throws(() => slot.inspect('aoc.exec:x'), failsWith('CAPABILITY_ISSUER_UNBOUND', 'never-requested'));
    const { issuer } = await issuerOver({ grants: readerOf([signed]) });
    slot.bind(issuer);
    assert.equal(slot.bound(), true);
    assert.throws(() => slot.bind(issuer), failsWith('CAPABILITY_REQUEST_INVALID', 'never-requested'));
    assert.equal((await slot.issue(inputFor(signed))).capability.executionId, inputFor(signed).executionId);
  });
});

describe('G-02B D7 — a restored issuance ledger, end to end', () => {
  it('the same execution gets a second capability (new id, new nonce, fresh valid signature); what stops a second execution is the executor’s shared consumption ledger, not issuance', async () => {
    const signed = await signedGrant();
    const path = ledgers.path();
    (await ledgers.create(path)).close();
    const backup = ledgers.path();
    copyFileSync(path, backup);
    const live = await ledgers.reopen(path);
    const first = await (await issuerOver({ grants: readerOf([signed]), ledger: live })).issuer.issue(inputFor(signed));
    live.close();
    rmSync(path);
    for (const suffix of ['-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
    copyFileSync(backup, path);
    const restored = await ledgers.reopen(path);
    const second = await (await issuerOver({ grants: readerOf([signed]), ledger: restored })).issuer.issue(inputFor(signed));
    assert.notEqual(second.capability.capabilityId, first.capability.capabilityId);
    assert.notEqual(second.capability.grantReference, first.capability.grantReference, 'different nonce, different reference');
    assert.notEqual(second.signature.signature, first.signature.signature);
    assert.equal(second.capability.executionId, first.capability.executionId, 'custody pins the execution to the grant: the duplicate names the same execution');
    const present = (issued: typeof first) => ({ presentation: { capability: issued.canonical, signature: issued.signature }, action: G02B_ACTION, resource: G02B_RESOURCE, actionBinding: { format: G02B_BINDING_FORMAT, value: BINDING_VALUE } });
    const verifier = executorVerifier();
    assert.equal(verifier.verify(present(first)).verification, 'verified');
    assert.equal(verifier.verify(present(second)).verification, 'verified', 'both are genuine: issuance alone does not prevent this');
    // One executor (or executors sharing one consumption ledger): the second is refused by execution identity.
    const shared = await openExecutionCapabilityConsumptionLedger(join(ledgers.dir, `consumption-shared-${Date.now()}.sqlite`), { audience: G02B_AUDIENCE, clock: () => NOW + 1_000, create: true });
    try {
      assert.equal(shared.claim(verifier.verify(present(first))).outcome, 'claimed');
      assert.deepEqual(shared.claim(verifier.verify(present(second))), { outcome: 'refused', reason: 'EXECUTION_CONSUMED' });
    } finally {
      shared.close();
    }
    // Executor instances with separate ledgers are separate consumption domains: each accepts one.
    const separate = await openExecutionCapabilityConsumptionLedger(join(ledgers.dir, `consumption-separate-${Date.now()}.sqlite`), { audience: G02B_AUDIENCE, clock: () => NOW + 1_000, create: true });
    try {
      assert.equal(separate.claim(verifier.verify(present(second))).outcome, 'claimed', 'a second consumption domain accepts the duplicate: the D7 deployment blocker');
    } finally {
      separate.close();
    }
  });
});
