import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { boundedGrantDigest, type BoundedGrant } from '../../features/grant-runtime/index.js';
import { createRecordingExecutionAdapter } from '../../features/execution-runtime/tests/execution-fixture.js';
import { KernelGrantCapability } from '../../kernel/orchestration/grant-adapter.js';
import { createSqliteApprovalStore } from '../approval-authority/index.js';
import type { ApprovalStateCommitment } from '../approval-authority/state-commitment.js';
import { AuthorityAuthenticityConfigurationError, AuthoritySigningUnavailableError, type AuthoritySigningFailureReason } from '../authority-authenticity/errors.js';
import { createSqliteBoundedGrantStore } from '../bounded-grant-store/index.js';
import { createEnterprise, type CreateEnterpriseOptions } from '../composition/composition-root.js';
import { DEFAULT_EXTERNAL_SIGNER_PROBE_INTERVAL_MS, loadEnterpriseConfiguration } from '../configuration/enterprise-configuration.js';
import { createHttpExternalAuthoritySignerTransport, establishExternalAuthorityArtifactSigner } from '../external-authority-signer/index.js';
import { createSqliteObligationDischargeStore } from '../obligation-discharge/index.js';
import { AUTHORITY_KEY_A, AUTHORITY_KEY_B, AUTHORITY_KEY_UNTRUSTED, testVerifier, trustedKeyOf, type TestAuthorityKey } from './authority-authenticity-fixture.js';
import {
  ScriptedTransport,
  SIGNER_TOKEN,
  establish,
  establishScripted,
  externalCustodyEnv,
  genuineSignature,
  identityOf,
  signerKeyDirectory,
  spawnReferenceSigner,
  startFaultProxy,
  startInProcessSigner,
  unavailable,
  withoutSoftwareCustody,
  type FaultProxy,
  type SpawnedSigner,
} from './core02-external-signer-fixture.js';
import { Workspace, boot, call, createContextTable, govern, provision, secureEnv, settle, type Booted } from './core04-host-fixture.js';
import { approvalPolicy, approvalsFile, payablesWorld, provisionApprovers } from './core05-host-fixture.js';
import { buildTestKernelProviders } from './support.js';

/**
 * CORE-02R — post-merge review hardening of the external custody boundary.
 *
 * - **A** — a host-supplied authority store cannot substitute its own signer or
 *   trust boundary for the configured one: under external custody the
 *   composition root builds every authority store itself, over the boundary it
 *   establishes against the configured signer, and refuses any supplied store.
 * - **B** — a successful identity-only probe never clears a signing failure; only
 *   a successful signature does. `/health` stays truthful without spending one.
 * - **C** — the startup identity handshake honours `maxAttempts` for the
 *   availability family and never retries a refusal.
 * - **P3** — identity probes are single-flight and rate-bounded; signing
 *   failures remain visible immediately.
 *
 * Finding D (the real process environment) is in
 * `external-authority-signer-process-env.test.ts`: it mutates `process.env`, so
 * it runs in its own test process.
 */

const work = mkdtempSync(join(tmpdir(), 'frontera-core02r-'));
const cleanups: (() => Promise<void>)[] = [];
after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup().catch(() => {});
  rmSync(work, { recursive: true, force: true });
});

const dir = (name: string): string => mkdtempSync(join(work, `${name}-`));

const reasonOf = (error: unknown): AuthoritySigningFailureReason | undefined =>
  error instanceof AuthoritySigningUnavailableError || error instanceof AuthorityAuthenticityConfigurationError ? error.reason : undefined;

const refusedWith = (reason: AuthoritySigningFailureReason) => (error: unknown) => {
  assert.equal(reasonOf(error), reason, error instanceof Error ? error.message : String(error));
  return true;
};

const DIGEST = (c: string) => `sha256:${c.repeat(64)}`;
const APPROVAL_STATE: ApprovalStateCommitment = { storeId: 'approval-store:1', organizationId: 'org-a', sequence: 5, chainDigest: DIGEST('d') };

function grant(id = 'aoc.grant:core02r'): BoundedGrant {
  const withoutDigest = {
    id,
    correlation: { requestId: 'req-1', decisionId: 'dec-1', action: 'payment.send', resourceScope: 'record:contract' },
    subject: 'actor-a',
    scope: { action: { kind: 'identity', value: 'payment.send' }, amount: { kind: 'ceiling', limit: '100', unit: 'USD' }, resources: { kind: 'set', values: ['record:contract'] } },
    issuedAt: '2026-01-01T12:00:00.000Z',
    expiresAt: '2026-01-01T12:10:00.000Z',
    sourceDigest: DIGEST('a'),
  } as Omit<BoundedGrant, 'digest'>;
  return { ...withoutDigest, digest: boundedGrantDigest(withoutDigest) };
}

/** Key B's material under key A's id: the same-id / different-key substitution. */
const B_UNDER_A_ID: TestAuthorityKey = { ...AUTHORITY_KEY_B, keyId: AUTHORITY_KEY_A.keyId };

// ── A — supplied store signer / trust substitution ───────────────────────────

function sqliteEnv(directory: string): Record<string, string> {
  return {
    AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'sqlite',
    AOC_ENTERPRISE_LOG_LEVEL: 'error',
    AOC_ENTERPRISE_SQLITE_PATH: join(directory, 'governance.sqlite'),
    AOC_ENTERPRISE_PASSPORT_SQLITE_PATH: join(directory, 'passport.sqlite'),
    AOC_ENTERPRISE_ASSURANCE_SQLITE_PATH: join(directory, 'assurance.sqlite'),
    AOC_ENTERPRISE_BOUNDED_GRANT_SQLITE_PATH: join(directory, 'bounded-grants.sqlite'),
    AOC_ENTERPRISE_EMERGENCY_CONTROL_SQLITE_PATH: join(directory, 'emergency.sqlite'),
  };
}

function compose(configuration: ReturnType<typeof loadEnterpriseConfiguration>, supplied: Pick<CreateEnterpriseOptions, 'obligations' | 'approvals'> & { readonly grantStore?: unknown } = {}) {
  const { grantStore, ...rest } = supplied;
  return createEnterprise({
    configuration,
    kernelProviders: buildTestKernelProviders(),
    authorityControlledExecution: {
      grantCapability: new KernelGrantCapability({ declaration: {} }),
      executionAdapter: createRecordingExecutionAdapter(),
      resolveAuthorityBinding: () => ({ kind: 'no-temporal-authority-bound', sourceKind: 'none-applicable', justification: 'test composition' }),
      ...(grantStore !== undefined ? { grantStore: grantStore as never } : {}),
    },
    ...rest,
  });
}

async function inProcessSigner(key: TestAuthorityKey) {
  const signer = await startInProcessSigner(key);
  cleanups.push(() => signer.close());
  return signer;
}

/** A durable grant store built with a genuine **external** signer for `signWith`, reading with a verifier that trusts `trust`. Carries the `external` custody brand. */
async function externalGrantStore(path: string, signWith: TestAuthorityKey, trust: readonly TestAuthorityKey[] = [signWith]) {
  const service = await inProcessSigner(signWith);
  const { signer } = await establish(service.endpoint, { pin: signWith, trust });
  const store = await createSqliteBoundedGrantStore(path, { authenticity: { signer, verifier: testVerifier(trust) } });
  cleanups.push(() => store.close());
  return { store, service };
}

const externalFor = (endpoint: string, trusted: readonly TestAuthorityKey[] = [AUTHORITY_KEY_A]) =>
  externalCustodyEnv({ endpoint, keyId: AUTHORITY_KEY_A.keyId }, trusted.map(trustedKeyOf));

const refusesSupplied = (name: string) => (error: unknown) => {
  assert.ok(error instanceof AuthorityAuthenticityConfigurationError, error instanceof Error ? error.message : String(error));
  assert.match(error.message, /composes its authority stores itself/);
  assert.ok(error.message.includes(name), error.message);
  return true;
};

describe('CORE-02R A — under external custody no supplied authority store can substitute a signer or a trust boundary for the configured one', () => {
  it('A1 — configured signer A, supplied external store signed by B: refused, and signer B is never used', async () => {
    const configured = await inProcessSigner(AUTHORITY_KEY_A);
    const directory = dir('a1');
    const { store, service } = await externalGrantStore(join(work, 'a1-supplied.sqlite'), AUTHORITY_KEY_B);
    const before = await service.counts();
    await assert.rejects(() => compose(loadEnterpriseConfiguration({ ...sqliteEnv(directory), ...externalFor(configured.endpoint, [AUTHORITY_KEY_A, AUTHORITY_KEY_B]) }), { grantStore: store }), refusesSupplied('authorityControlledExecution.grantStore'));
    assert.deepEqual(await service.counts(), before, 'signer B signed nothing for this Host');
    assert.deepEqual(readdirSync(directory), [], 'refused before any store file was opened');
  });

  it('A2 — same key id, different public key: refused', async () => {
    const configured = await inProcessSigner(AUTHORITY_KEY_A);
    const { store } = await externalGrantStore(join(work, 'a2-supplied.sqlite'), B_UNDER_A_ID);
    await assert.rejects(() => compose(loadEnterpriseConfiguration({ ...sqliteEnv(dir('a2')), ...externalFor(configured.endpoint) }), { grantStore: store }), refusesSupplied('grantStore'));
  });

  it('A3 / A6 — even a supplied store built over exactly the configured key, algorithm and registry is refused: the canonical external boundary is the one the root establishes, not one it is handed', async () => {
    const configured = await inProcessSigner(AUTHORITY_KEY_A);
    const { store } = await externalGrantStore(join(work, 'a6-supplied.sqlite'), AUTHORITY_KEY_A);
    await assert.rejects(() => compose(loadEnterpriseConfiguration({ ...sqliteEnv(dir('a6')), ...externalFor(configured.endpoint) }), { grantStore: store }), refusesSupplied('grantStore'));
  });

  it('A4 — signer A, but a supplied verifier that also trusts an attacker key, under a configuration that trusts only A: refused (no silently wider trust set)', async () => {
    const configured = await inProcessSigner(AUTHORITY_KEY_A);
    const { store } = await externalGrantStore(join(work, 'a4-supplied.sqlite'), AUTHORITY_KEY_A, [AUTHORITY_KEY_A, AUTHORITY_KEY_UNTRUSTED]);
    await assert.rejects(() => compose(loadEnterpriseConfiguration({ ...sqliteEnv(dir('a4')), ...externalFor(configured.endpoint) }), { grantStore: store }), refusesSupplied('grantStore'));
  });

  it('A5 — configured signer unreachable, supplied external store present: refused — the configured boundary is never bypassed', async () => {
    const directory = dir('a5');
    const { store } = await externalGrantStore(join(work, 'a5-supplied.sqlite'), AUTHORITY_KEY_A);
    await assert.rejects(() => compose(loadEnterpriseConfiguration({ ...sqliteEnv(directory), ...externalFor('http://127.0.0.1:65000') }), { grantStore: store }), refusesSupplied('grantStore'));
    assert.deepEqual(readdirSync(directory), []);
    // And without a supplied store, the unreachable configured signer refuses the Host: it is actually contacted.
    await assert.rejects(() => compose(loadEnterpriseConfiguration({ ...sqliteEnv(dir('a5-plain')), ...externalFor('http://127.0.0.1:65000') })), refusedWith('EXTERNAL_SIGNER_UNREACHABLE'));
  });

  it('obligation and approval stores are pinned the same way: no grant→A / obligation→B / approval→C split under one Host', async () => {
    const configured = await inProcessSigner(AUTHORITY_KEY_A);
    const serviceB = await inProcessSigner(AUTHORITY_KEY_B);
    const { signer } = await establish(serviceB.endpoint, { pin: AUTHORITY_KEY_B });
    const authenticity = { signer, verifier: testVerifier([AUTHORITY_KEY_B]) };
    const obligations = await createSqliteObligationDischargeStore(join(work, 'supplied-obligations.sqlite'), { now: () => new Date().toISOString(), organizationId: 'org-a', authenticity });
    cleanups.push(() => obligations.close());
    const approvals = await createSqliteApprovalStore(join(work, 'supplied-approvals.sqlite'), { now: () => new Date().toISOString(), organizationId: 'org-a', authenticity });
    cleanups.push(() => approvals.close());
    const configuration = () => loadEnterpriseConfiguration({ ...sqliteEnv(dir('stores')), ...externalFor(configured.endpoint) });
    await assert.rejects(() => compose(configuration(), { obligations: { store: obligations } as never }), refusesSupplied('obligations.store'));
    await assert.rejects(() => compose(configuration(), { approvals: { store: approvals } }), refusesSupplied('approvals.store'));
  });

  it('the refusal holds under ephemeral persistence too: external custody never adopts a store it did not build', async () => {
    const configured = await inProcessSigner(AUTHORITY_KEY_A);
    const { store } = await externalGrantStore(join(work, 'memory-supplied.sqlite'), AUTHORITY_KEY_B);
    await assert.rejects(() => compose(loadEnterpriseConfiguration({ AOC_ENTERPRISE_LOG_LEVEL: 'error', ...externalFor(configured.endpoint) }), { grantStore: store }), refusesSupplied('grantStore'));
  });

  it('the root-built boundary is the configured one: genesis is signed by the configured signer, and posture reports the established custody', async () => {
    const configured = await inProcessSigner(AUTHORITY_KEY_A);
    const enterprise = await compose(loadEnterpriseConfiguration({ ...sqliteEnv(dir('built')), ...externalFor(configured.endpoint, [AUTHORITY_KEY_A, AUTHORITY_KEY_B]) }));
    cleanups.push(() => enterprise.close());
    await enterprise.start();
    const health = await enterprise.health();
    assert.equal(health.posture?.authoritySigner, 'external');
    assert.equal(health.authoritySigner?.keyId, AUTHORITY_KEY_A.keyId);
    assert.equal((await configured.counts())['signRevocationState'], 1, 'genesis crossed the configured boundary');
  });

  it('software custody keeps host-supplied authenticated stores (the embedding surface is unchanged where no external claim is made)', async () => {
    const { authorityAuthenticityEnv, openDurableStore } = await import('./authority-authenticity-fixture.js');
    const store = await openDurableStore(join(work, 'software-supplied.sqlite'));
    cleanups.push(() => store.close());
    const enterprise = await compose(loadEnterpriseConfiguration({ ...sqliteEnv(dir('software')), ...authorityAuthenticityEnv() }), { grantStore: store });
    cleanups.push(() => enterprise.close());
    assert.equal((await enterprise.health()).posture?.authoritySigner, 'software');
  });
});

// ── B — identity reachability is not signing readiness ───────────────────────

describe('CORE-02R B — a successful identity probe never clears a signing failure; only a successful signature does', () => {
  for (const [label, fault, reason] of [
    ['unavailable (5xx)', () => unavailable('EXTERNAL_SIGNER_UNAVAILABLE'), 'EXTERNAL_SIGNER_UNAVAILABLE'],
    ['timeout', () => unavailable('EXTERNAL_SIGNER_TIMEOUT'), 'EXTERNAL_SIGNER_TIMEOUT'],
    ['an invalid signature (same key id, wrong key)', async (request: Parameters<ScriptedTransport['answer']>[0]) => ({ signature: await genuineSignature(B_UNDER_A_ID, request) }), 'EXTERNAL_SIGNER_SIGNATURE_INVALID'],
  ] as const) {
    it(`signing fails with ${label}: identity probes keep succeeding, and health stays unavailable (${reason}) until a real signature succeeds`, async () => {
      const transport = new ScriptedTransport(AUTHORITY_KEY_A);
      const { signer, monitor } = await establishScripted(transport, { pin: AUTHORITY_KEY_A });
      const genuine = transport.answer;
      transport.answer = fault;
      await assert.rejects(() => signer.signApprovalState(APPROVAL_STATE), refusedWith(reason));
      for (let probe = 0; probe < 3; probe += 1) {
        const status = await monitor.probe();
        assert.equal(status.identity.state, 'ready', 'the identity endpoint is reachable and answers as the pin');
        assert.equal(status.lastSigning.state, 'unavailable');
        assert.equal(status.lastSigning.reason, reason);
        assert.equal(status.state, 'unavailable', `probe ${probe}: identity success does not erase the signing failure`);
        assert.equal(status.reason, reason);
      }
      assert.equal(transport.identityCalls, 1 + 3, 'every probe really reached the identity endpoint');
      transport.answer = genuine;
      await signer.signApprovalState(APPROVAL_STATE);
      const recovered = monitor.status();
      assert.equal(recovered.state, 'ready', 'a successful signature proves recovery');
      assert.equal(recovered.reason, undefined);
      assert.equal(recovered.lastSigning.state, 'ready');
    });
  }

  it('an identity failure alone degrades health, and a later identity success restores it when no signing failure is unresolved', async () => {
    const transport = new ScriptedTransport(AUTHORITY_KEY_A);
    const { monitor } = await establishScripted(transport, { pin: AUTHORITY_KEY_A });
    const healthy = transport.identityAnswer;
    transport.identityAnswer = () => unavailable('EXTERNAL_SIGNER_UNREACHABLE');
    let status = await monitor.probe();
    assert.deepEqual([status.state, status.reason, status.identity.state, status.lastSigning.state], ['unavailable', 'EXTERNAL_SIGNER_UNREACHABLE', 'unavailable', 'ready']);
    transport.identityAnswer = healthy;
    status = await monitor.probe();
    assert.deepEqual([status.state, status.reason, status.identity.state], ['ready', undefined, 'ready']);
  });

  it('a successful signature does not clear an identity failure, and a recovered identity does not clear a signing failure: each clears only its own', async () => {
    const transport = new ScriptedTransport(AUTHORITY_KEY_A);
    const { signer, monitor } = await establishScripted(transport, { pin: AUTHORITY_KEY_A });
    transport.identityAnswer = () => identityOf(AUTHORITY_KEY_B);
    assert.equal((await monitor.probe()).reason, 'EXTERNAL_SIGNER_IDENTITY_MISMATCH');
    await signer.signApprovalState(APPROVAL_STATE);
    const status = monitor.status();
    assert.equal(status.state, 'unavailable', 'the identity mismatch stands until identity is re-proven');
    assert.equal(status.identity.reason, 'EXTERNAL_SIGNER_IDENTITY_MISMATCH');
    assert.equal(status.lastSigning.state, 'ready');
  });

  it('when both are failing, the unresolved signing failure is the reported reason — it is what stops new authority', async () => {
    const transport = new ScriptedTransport(AUTHORITY_KEY_A);
    const { signer, monitor } = await establishScripted(transport, { pin: AUTHORITY_KEY_A });
    transport.answer = async (request) => ({ signature: await genuineSignature(B_UNDER_A_ID, request) });
    await assert.rejects(() => signer.signGrant(grant(), 'store-1'), refusedWith('EXTERNAL_SIGNER_SIGNATURE_INVALID'));
    transport.identityAnswer = () => unavailable('EXTERNAL_SIGNER_TIMEOUT');
    const status = await monitor.probe();
    assert.deepEqual([status.state, status.reason, status.identity.reason], ['unavailable', 'EXTERNAL_SIGNER_SIGNATURE_INVALID', 'EXTERNAL_SIGNER_TIMEOUT']);
  });

  it('a health probe never spends a signature', async () => {
    const transport = new ScriptedTransport(AUTHORITY_KEY_A);
    const { monitor } = await establishScripted(transport, { pin: AUTHORITY_KEY_A });
    for (let probe = 0; probe < 5; probe += 1) await monitor.probe();
    assert.equal(transport.signCalls.length, 0);
  });
});

// ── P3 — probe fanout ────────────────────────────────────────────────────────

describe('CORE-02R P3 — identity probes are single-flight and rate-bounded; signing failures stay immediate', () => {
  it('concurrent probes share one identity call; within the interval no call is made; after it, one is', async () => {
    const transport = new ScriptedTransport(AUTHORITY_KEY_A);
    let now = 1_000_000;
    let release: () => void = () => {};
    const { monitor } = await establishExternalAuthorityArtifactSigner({
      transport,
      pinned: trustedKeyOf(AUTHORITY_KEY_A),
      verifier: testVerifier([AUTHORITY_KEY_A]),
      timeoutMs: 1_000,
      maxAttempts: 1,
      probeIntervalMs: 5_000,
      now: () => now,
    });
    assert.equal(transport.identityCalls, 1, 'the startup handshake');
    await Promise.all(Array.from({ length: 20 }, () => monitor.probe()));
    assert.equal(transport.identityCalls, 1, 'within the interval the startup proof stands');
    now += 5_000;
    const healthy = transport.identityAnswer;
    transport.identityAnswer = () => new Promise((resolve) => (release = () => resolve(healthy())));
    const pending = Array.from({ length: 20 }, () => monitor.probe());
    await new Promise((resolve) => setImmediate(resolve));
    release();
    await Promise.all(pending);
    transport.identityAnswer = healthy;
    assert.equal(transport.identityCalls, 2, 'twenty concurrent probes → one identity call');
    now += 4_999;
    await monitor.probe();
    assert.equal(transport.identityCalls, 2);
    now += 1;
    await monitor.probe();
    assert.equal(transport.identityCalls, 3);
  });

  it('a cached identity never hides a signing failure: it is visible on the very next status', async () => {
    const transport = new ScriptedTransport(AUTHORITY_KEY_A);
    const { signer, monitor } = await establishExternalAuthorityArtifactSigner({
      transport,
      pinned: trustedKeyOf(AUTHORITY_KEY_A),
      verifier: testVerifier([AUTHORITY_KEY_A]),
      timeoutMs: 1_000,
      maxAttempts: 1,
      probeIntervalMs: 60_000,
    });
    transport.answer = () => unavailable('EXTERNAL_SIGNER_UNAVAILABLE');
    await assert.rejects(() => signer.signApprovalState(APPROVAL_STATE));
    const status = await monitor.probe();
    assert.equal(transport.identityCalls, 1, 'no identity call was needed');
    assert.deepEqual([status.state, status.reason], ['unavailable', 'EXTERNAL_SIGNER_UNAVAILABLE']);
  });

  it('the probe interval is bounded: 0 … 60 000 ms', async () => {
    for (const probeIntervalMs of [-1, 60_001, 1.5]) {
      await assert.rejects(
        () =>
          establishExternalAuthorityArtifactSigner({ transport: new ScriptedTransport(AUTHORITY_KEY_A), pinned: trustedKeyOf(AUTHORITY_KEY_A), verifier: testVerifier([AUTHORITY_KEY_A]), timeoutMs: 1_000, maxAttempts: 1, probeIntervalMs }),
        AuthorityAuthenticityConfigurationError,
      );
    }
  });
});

// ── C — startup identity retry budget ────────────────────────────────────────

describe('CORE-02R C — the startup identity handshake honours maxAttempts for availability failures, and never retries a refusal', () => {
  const scripted = (answers: readonly (() => unknown)[]) => {
    const transport = new ScriptedTransport(AUTHORITY_KEY_A);
    transport.identityAnswer = () => (answers[transport.identityCalls - 1] ?? (() => identityOf(AUTHORITY_KEY_A)))();
    return transport;
  };
  const healthy = () => identityOf(AUTHORITY_KEY_A);

  it('C1 — timeout then the pinned identity: starts, after exactly two identity calls', async () => {
    const transport = scripted([() => unavailable('EXTERNAL_SIGNER_TIMEOUT'), healthy]);
    const { monitor } = await establishScripted(transport, { pin: AUTHORITY_KEY_A, maxAttempts: 3 });
    assert.equal(transport.identityCalls, 2);
    assert.equal(monitor.status().state, 'ready');
    assert.equal(transport.signCalls.length, 0, 'identity retries are not signing attempts');
    assert.equal(Object.values(monitor.status().operations).reduce((total, counters) => total + counters.attempts, 0), 0, 'nor are they counted as such');
  });

  it('C2 — unavailable on every attempt: refuses after exactly maxAttempts', async () => {
    const transport = scripted([() => unavailable('EXTERNAL_SIGNER_UNAVAILABLE'), () => unavailable('EXTERNAL_SIGNER_UNAVAILABLE'), () => unavailable('EXTERNAL_SIGNER_UNAVAILABLE'), healthy]);
    await assert.rejects(() => establishScripted(transport, { pin: AUTHORITY_KEY_A, maxAttempts: 3 }), refusedWith('EXTERNAL_SIGNER_UNAVAILABLE'));
    assert.equal(transport.identityCalls, 3);
  });

  for (const [label, answer, reason] of [
    ['C3 — authentication failure', () => unavailable('EXTERNAL_SIGNER_AUTHENTICATION_FAILED'), 'EXTERNAL_SIGNER_AUTHENTICATION_FAILED'],
    ['C4 — identity mismatch (the endpoint answers as key B)', () => identityOf(AUTHORITY_KEY_B), 'EXTERNAL_SIGNER_IDENTITY_MISMATCH'],
    ['C4b — same key id, different public key', () => identityOf(B_UNDER_A_ID), 'EXTERNAL_SIGNER_IDENTITY_MISMATCH'],
    ['C5 — malformed identity', () => ({ protocol: 'x' }), 'EXTERNAL_SIGNER_MALFORMED_RESPONSE'],
    ['C5b — refused', () => unavailable('EXTERNAL_SIGNER_REFUSED'), 'EXTERNAL_SIGNER_REFUSED'],
    ['C5c — capability unsupported', () => identityOf(AUTHORITY_KEY_A, { operations: ['signGrant'] }), 'EXTERNAL_SIGNER_CAPABILITY_UNSUPPORTED'],
  ] as const) {
    it(`${label} on the first attempt: refuses after exactly one identity call (maxAttempts 3)`, async () => {
      const transport = scripted([answer, healthy, healthy]);
      await assert.rejects(() => establishScripted(transport, { pin: AUTHORITY_KEY_A, maxAttempts: 3 }), refusedWith(reason));
      assert.equal(transport.identityCalls, 1);
    });
  }

  for (const status of [429, 500, 503]) {
    it(`C6/C7 — HTTP ${status} then the pinned identity, over real HTTP: starts after two calls`, async () => {
      let calls = 0;
      const server = createServer((_req, res) => {
        calls += 1;
        if (calls === 1) {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end('{}');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(identityOf(AUTHORITY_KEY_A)));
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
      const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const { monitor } = await establishExternalAuthorityArtifactSigner({
        transport: createHttpExternalAuthoritySignerTransport({ endpoint, credential: SIGNER_TOKEN }),
        pinned: trustedKeyOf(AUTHORITY_KEY_A),
        verifier: testVerifier([AUTHORITY_KEY_A]),
        timeoutMs: 1_000,
        maxAttempts: 2,
      });
      assert.equal(calls, 2);
      assert.equal(monitor.status().state, 'ready');
    });
  }

  it('maxAttempts 1 keeps the single-attempt handshake', async () => {
    const transport = scripted([() => unavailable('EXTERNAL_SIGNER_TIMEOUT'), healthy]);
    await assert.rejects(() => establishScripted(transport, { pin: AUTHORITY_KEY_A, maxAttempts: 1 }), refusedWith('EXTERNAL_SIGNER_TIMEOUT'));
    assert.equal(transport.identityCalls, 1);
  });

  it('a runtime health probe is one attempt: a transient identity failure is reported, not retried', async () => {
    const transport = new ScriptedTransport(AUTHORITY_KEY_A);
    const { monitor } = await establishScripted(transport, { pin: AUTHORITY_KEY_A, maxAttempts: 3 });
    transport.identityAnswer = () => unavailable('EXTERNAL_SIGNER_TIMEOUT');
    const status = await monitor.probe();
    assert.equal(transport.identityCalls, 2, 'startup + one probe attempt');
    assert.equal(status.identity.reason, 'EXTERNAL_SIGNER_TIMEOUT');
  });

  it('the canonical Host configuration carries maxAttempts into the startup handshake (composition level)', async () => {
    const service = await inProcessSigner(AUTHORITY_KEY_A);
    const proxy = await startFaultProxy(service.endpoint);
    cleanups.push(() => proxy.close());
    // The proxy passes identity through; count that exactly one handshake happened on a healthy signer.
    const enterprise = await compose(loadEnterpriseConfiguration({ ...sqliteEnv(dir('c-host')), ...externalFor(proxy.endpoint), AOC_ENTERPRISE_AUTHORITY_SIGNER_MAX_ATTEMPTS: '3' }));
    cleanups.push(() => enterprise.close());
    assert.equal(proxy.identityCalls, 1);
    assert.equal(enterprise.configuration.authorityAuthenticity.externalSigner?.maxAttempts, 3);
  });
});

// ── B on the canonical Host, with the signer in its own process ──────────────

describe('CORE-02R B — on the canonical Host: /health stays degraded while identity is healthy and signing is broken; only a real signature restores it', () => {
  const workspace = new Workspace();
  const keys = signerKeyDirectory();
  const KEY_ID = 'frontera-core02r-key-1';
  let signer: SpawnedSigner;
  let proxy: FaultProxy;
  let trusted: { keyId: string; algorithm: string; publicKeyPem: string }[];
  let host: Booted & { context: ReturnType<typeof createContextTable> };
  let amount = 500;
  after(async () => {
    await workspace.cleanup();
    await proxy?.close();
    await signer?.kill();
    keys.cleanup();
  });

  const health = async () => {
    const reply = await call(host.baseUrl, 'GET', '/health');
    return { status: reply.body['status'], signer: reply.body['authoritySigner'] as Record<string, unknown>, text: reply.text };
  };
  const mutate = async () => {
    amount += 1;
    host.context.set(payablesWorld(amount));
    return govern(host.baseUrl, settle(amount));
  };

  async function bootWith(extra: Record<string, string | undefined> = {}): Promise<Booted & { context: ReturnType<typeof createContextTable> }> {
    const context = createContextTable();
    const env = { ...withoutSoftwareCustody(secureEnv(workspace.dir(), approvalsFile())), ...externalCustodyEnv({ endpoint: proxy.endpoint, keyId: KEY_ID }, trusted), ...extra };
    const booted = await boot(workspace, env, { context, policy: approvalPolicy() });
    await provision(booted.host);
    await provisionApprovers(booted.host);
    return { ...booted, context };
  }

  it('setup: a healthy external Host whose signer sits behind a fault-injecting proxy', async () => {
    signer = await spawnReferenceSigner({ keyFile: join(keys.dir, 'authority-key.pem'), keyId: KEY_ID });
    trusted = [{ keyId: KEY_ID, algorithm: 'ed25519-v1', publicKeyPem: signer.publicKeyPem }];
    proxy = await startFaultProxy(signer.endpoint);
    host = await bootWith({ AOC_ENTERPRISE_AUTHORITY_SIGNER_TIMEOUT_MS: '500' });
    const executed = await mutate();
    assert.equal(executed.body['status'], 'executed', executed.text);
    const healthy = await health();
    assert.equal(healthy.status, 'healthy', healthy.text);
    assert.equal(healthy.signer['state'], 'ready');
  });

  for (const [fault, reason] of [
    ['unavailable', 'EXTERNAL_SIGNER_UNAVAILABLE'],
    ['hang', 'EXTERNAL_SIGNER_TIMEOUT'],
    ['redirect', 'EXTERNAL_SIGNER_SIGNATURE_INVALID'],
  ] as const) {
    it(`signing ${fault} → mutation fails → /health degraded (${reason}) through repeated successful identity probes → restored → still degraded until a real signature → healthy`, async () => {
      if (fault === 'redirect') {
        // Another custody service answering under the pinned key id with different key material.
        const impostor = await inProcessSigner({ ...AUTHORITY_KEY_B, keyId: KEY_ID });
        proxy.redirectTarget = impostor.endpoint;
      }
      proxy.fault = fault;
      const failed = await mutate();
      assert.notEqual(failed.body['status'], 'executed', failed.text);

      const identityBefore = proxy.identityCalls;
      for (let probe = 0; probe < 3; probe += 1) {
        const degraded = await health();
        assert.equal(degraded.status, 'degraded', degraded.text);
        assert.equal(degraded.signer['state'], 'unavailable');
        assert.equal(degraded.signer['reason'], reason);
        assert.deepEqual(degraded.signer['identity'], { state: 'ready' }, 'the identity endpoint is healthy');
        assert.deepEqual(degraded.signer['lastSigning'], { state: 'unavailable', reason });
      }
      assert.ok(proxy.identityCalls >= identityBefore + 3, 'each /health really probed identity, successfully');
      const ready = await call(host.baseUrl, 'GET', '/ready');
      assert.equal(ready.status, 200, 'existing authority is still served: a signer failure is not unreadiness');

      proxy.fault = 'pass';
      const stillDegraded = await health();
      assert.equal(stillDegraded.status, 'degraded', 'the signing endpoint is back, but nothing has proven it yet');
      assert.equal(stillDegraded.signer['reason'], reason);

      const recovered = await mutate();
      assert.equal(recovered.body['status'], 'executed', recovered.text);
      const healthy = await health();
      assert.equal(healthy.status, 'healthy', healthy.text);
      assert.deepEqual(healthy.signer['lastSigning'], { state: 'ready' });
    });
  }

  it('fanout: with the default probe interval, concurrent /health and /ready requests do not each reach the signer — and a signing failure is still visible at once', async () => {
    await host.host.close();
    // The variable unset: the shipped default applies.
    host = await bootWith({ AOC_ENTERPRISE_AUTHORITY_SIGNER_PROBE_INTERVAL_MS: undefined });
    assert.equal(host.host.enterprise.configuration.authorityAuthenticity.externalSigner?.probeIntervalMs, DEFAULT_EXTERNAL_SIGNER_PROBE_INTERVAL_MS);
    assert.equal(DEFAULT_EXTERNAL_SIGNER_PROBE_INTERVAL_MS, 5_000);
    const before = proxy.identityCalls;
    const replies = await Promise.all(Array.from({ length: 30 }, (_, index) => call(host.baseUrl, 'GET', index % 2 === 0 ? '/health' : '/ready')));
    assert.ok(replies.every((reply) => reply.status === 200));
    assert.ok(proxy.identityCalls - before <= 1, `30 health requests → ${proxy.identityCalls - before} identity calls`);

    proxy.fault = 'unavailable';
    const failed = await mutate();
    assert.notEqual(failed.body['status'], 'executed');
    const degraded = await health();
    assert.equal(degraded.status, 'degraded', 'the cached identity does not hide the signing failure');
    assert.equal(degraded.signer['reason'], 'EXTERNAL_SIGNER_UNAVAILABLE');
    proxy.fault = 'pass';
  });
});
