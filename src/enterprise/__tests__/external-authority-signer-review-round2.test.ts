import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRecordingExecutionAdapter } from '../../features/execution-runtime/tests/execution-fixture.js';
import { KernelGrantCapability } from '../../kernel/orchestration/grant-adapter.js';
import type { ApprovalStateCommitment } from '../approval-authority/state-commitment.js';
import { AuthorityAuthenticityConfigurationError, AuthoritySigningUnavailableError, type AuthoritySigningFailureReason } from '../authority-authenticity/errors.js';
import { createEnterprise, type CreateEnterpriseOptions } from '../composition/composition-root.js';
import { loadEnterpriseConfiguration } from '../configuration/enterprise-configuration.js';
import { establishExternalAuthorityArtifactSigner, type ExternalAuthoritySignerMonitor } from '../external-authority-signer/index.js';
import { createInMemoryGovernanceStore } from '../governance-store/in-memory-governance-store.js';
import { AUTHORITY_KEY_A, AUTHORITY_KEY_B, authorityAuthenticityEnv, testVerifier, trustedKeyOf } from './authority-authenticity-fixture.js';
import { ScriptedTransport, externalCustodyEnv, identityOf, startFaultProxy, startInProcessSigner, unavailable, withoutSoftwareCustody, type FaultProxy } from './core02-external-signer-fixture.js';
import { Workspace, boot, secureEnv } from './core04-host-fixture.js';
import { approvalPolicy, approvalsFile } from './core05-host-fixture.js';
import { buildTestKernelProviders } from './support.js';

/**
 * CORE-02R review round 2 — post-merge hotfix.
 *
 * - **A** — external custody + in-memory persistence was a split brain: the
 *   authenticity boundary and every signed authority store are selected only on
 *   the durable path, so `createEnterprise` accepted external custody with
 *   memory persistence, never contacted the configured signer, composed the
 *   unsigned in-memory grant store and reported `authoritySigner: not-composed`.
 *   Now refused before anything is opened, whenever authority-controlled
 *   execution is composed. Without it no authority store exists and nothing is
 *   signed, so that composition stays valid (A6).
 * - **B** — the identity-probe cache compared `now() - identityCheckedAt` against
 *   the interval, so a wall clock moved backwards made the age negative and a
 *   stale `ready` stood until wall time caught up. A negative age now
 *   invalidates the cache.
 */

const work = mkdtempSync(join(tmpdir(), 'frontera-core02r2-'));
const cleanups: (() => Promise<void>)[] = [];
after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup().catch(() => {});
  rmSync(work, { recursive: true, force: true });
});

const dir = (name: string): string => mkdtempSync(join(work, `${name}-`));
const UNREACHABLE = 'http://127.0.0.1:65000';

const reasonOf = (error: unknown): AuthoritySigningFailureReason | undefined =>
  error instanceof AuthoritySigningUnavailableError || error instanceof AuthorityAuthenticityConfigurationError ? error.reason : undefined;

/** The round-2 refusal: a configuration error, from no signer interaction (no closed signer reason). */
const refusesMemoryAuthority = (error: unknown) => {
  assert.ok(error instanceof AuthorityAuthenticityConfigurationError, error instanceof Error ? error.message : String(error));
  assert.match(error.message, /external authority-key custody with authority-controlled execution/);
  assert.match(error.message, /requires durable persistence/);
  assert.equal(error.reason, undefined, 'refused by configuration, not by any signer answer');
  return true;
};

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

const memoryEnv = (): Record<string, string> => ({ AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'memory', AOC_ENTERPRISE_LOG_LEVEL: 'error' });
const externalFor = (endpoint: string) => externalCustodyEnv({ endpoint, keyId: AUTHORITY_KEY_A.keyId }, [trustedKeyOf(AUTHORITY_KEY_A)]);

const ace = (): NonNullable<CreateEnterpriseOptions['authorityControlledExecution']> => ({
  grantCapability: new KernelGrantCapability({ declaration: {} }),
  executionAdapter: createRecordingExecutionAdapter(),
  resolveAuthorityBinding: () => ({ kind: 'no-temporal-authority-bound', sourceKind: 'none-applicable', justification: 'test composition' }),
});

async function compose(configuration: ReturnType<typeof loadEnterpriseConfiguration>, extra: Partial<CreateEnterpriseOptions> = {}, withAce = true) {
  const enterprise = await createEnterprise({ configuration, kernelProviders: buildTestKernelProviders(), ...(withAce ? { authorityControlledExecution: ace() } : {}), ...extra });
  cleanups.push(() => enterprise.close());
  return enterprise;
}

/** A healthy in-process custody service behind a counting proxy: `identityCalls` / `signCalls` are what reached the configured signer. */
async function countedSigner(): Promise<FaultProxy> {
  const service = await startInProcessSigner(AUTHORITY_KEY_A);
  const proxy = await startFaultProxy(service.endpoint);
  cleanups.push(() => service.close());
  cleanups.push(() => proxy.close());
  return proxy;
}

// ── A — external custody never composes unsigned in-memory authority ─────────

describe('CORE-02R round 2 A — external custody + authority-controlled execution + in-memory persistence is refused before anything is opened', () => {
  it('A1 — external + memory + ACE, signer unreachable: refused deterministically, by the persistence rule (not by a signer timeout)', async () => {
    for (let run = 0; run < 3; run += 1) {
      await assert.rejects(() => compose(loadEnterpriseConfiguration({ ...memoryEnv(), ...externalFor(UNREACHABLE) })), refusesMemoryAuthority);
    }
  });

  it('A2 — external + memory + ACE, signer healthy: still refused, and the signer is never contacted', async () => {
    const proxy = await countedSigner();
    await assert.rejects(() => compose(loadEnterpriseConfiguration({ ...memoryEnv(), ...externalFor(proxy.endpoint) })), refusesMemoryAuthority);
    assert.equal(proxy.identityCalls, 0, 'refused before the signer is established');
    assert.equal(proxy.signCalls, 0);
  });

  it('A2b — omitting the persistence variable (the default provider, memory) is the same refusal', async () => {
    const configuration = loadEnterpriseConfiguration({ AOC_ENTERPRISE_LOG_LEVEL: 'error', ...externalFor(UNREACHABLE) });
    assert.equal(configuration.persistence.provider, 'memory');
    await assert.rejects(() => compose(configuration), refusesMemoryAuthority);
  });

  it('A3 — external + sqlite + signer healthy: composes, over the established external boundary', async () => {
    const proxy = await countedSigner();
    const enterprise = await compose(loadEnterpriseConfiguration({ ...sqliteEnv(dir('a3')), ...externalFor(proxy.endpoint) }));
    const health = await enterprise.health();
    assert.equal(health.posture?.authoritySigner, 'external');
    assert.equal(health.posture?.authorityStore, 'authenticated-durable');
    assert.equal(health.authoritySigner?.custody, 'external');
    assert.ok(proxy.identityCalls >= 1, 'the configured signer proved its identity');
    assert.equal(proxy.signCalls, 1, 'the durable store genesis was signed across the boundary');
  });

  it('A4 — external + sqlite + signer unreachable: refused through signer establishment, before any store file exists', async () => {
    const directory = dir('a4');
    await assert.rejects(
      () => compose(loadEnterpriseConfiguration({ ...sqliteEnv(directory), ...externalFor(UNREACHABLE) })),
      (error: unknown) => {
        assert.equal(reasonOf(error), 'EXTERNAL_SIGNER_UNREACHABLE', error instanceof Error ? error.message : String(error));
        return true;
      },
    );
    assert.deepEqual(readdirSync(directory), []);
  });

  it('A5 — software custody + memory + ACE: unchanged — composes on the in-memory store, which it reports honestly', async () => {
    const enterprise = await compose(loadEnterpriseConfiguration({ ...memoryEnv(), ...authorityAuthenticityEnv() }));
    const health = await enterprise.health();
    assert.ok(enterprise.authorityControlledExecution !== undefined);
    assert.equal(health.posture?.authorityStore, 'unauthenticated');
    assert.equal(health.posture?.persistence, 'ephemeral');
    assert.equal(health.posture?.authoritySigner, 'not-composed', 'no signer is claimed where none signs');
  });

  it('A5b — no custody configured at all + memory + ACE (the development / test default): unchanged', async () => {
    const enterprise = await compose(loadEnterpriseConfiguration(memoryEnv()));
    assert.ok(enterprise.authorityControlledExecution !== undefined);
    assert.equal((await enterprise.health()).posture?.authorityStore, 'unauthenticated');
  });

  it('A6 — external + memory WITHOUT authority-controlled execution: composes (no authority store exists and nothing is signed), and posture says so truthfully', async () => {
    const proxy = await countedSigner();
    const enterprise = await compose(loadEnterpriseConfiguration({ ...memoryEnv(), ...externalFor(proxy.endpoint) }), {}, false);
    const health = await enterprise.health();
    assert.equal(enterprise.authorityControlledExecution, undefined);
    assert.equal(health.posture?.authorityStore, 'not-composed');
    assert.equal(health.posture?.authoritySigner, 'not-composed');
    assert.equal(health.posture?.approvals, 'not-configured');
    assert.equal(health.posture?.obligations, 'not-configured');
    assert.equal(proxy.identityCalls + proxy.signCalls, 0, 'no authority operation exists to use the signer');
  });

  it('A7 — no composition that runs ACE under external custody reports a not-composed signer: it is external, or it is refused', async () => {
    const proxy = await countedSigner();
    const attempts: [string, () => ReturnType<typeof loadEnterpriseConfiguration>][] = [
      ['memory', () => loadEnterpriseConfiguration({ ...memoryEnv(), ...externalFor(proxy.endpoint) })],
      ['sqlite', () => loadEnterpriseConfiguration({ ...sqliteEnv(dir('a7')), ...externalFor(proxy.endpoint) })],
    ];
    for (const [label, configuration] of attempts) {
      let enterprise: Awaited<ReturnType<typeof compose>> | undefined;
      try {
        enterprise = await compose(configuration());
      } catch (error) {
        assert.equal(label, 'memory', `only the memory composition may refuse: ${String(error)}`);
        continue;
      }
      assert.ok(enterprise.authorityControlledExecution !== undefined);
      assert.equal((await enterprise.health()).posture?.authoritySigner, 'external', label);
    }
  });

  it('A7b — the canonical Host (development profile) is refused by the composition root before it listens, not by the late posture guard', async () => {
    const workspace = new Workspace();
    cleanups.push(() => workspace.cleanup());
    const directory = workspace.dir();
    const env = { ...withoutSoftwareCustody(secureEnv(directory, approvalsFile())), AOC_ENTERPRISE_ENV: 'development', AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'memory', ...externalFor(UNREACHABLE) };
    await assert.rejects(() => boot(workspace, env, { policy: approvalPolicy() }), refusesMemoryAuthority);
  });

  it('A8 — obligation / approval stores cannot be selected in memory under external custody: a supplied in-memory Governance Store (which selects them) is refused, before any file or signer contact', async () => {
    const proxy = await countedSigner();
    const directory = dir('a8');
    const persistence = createInMemoryGovernanceStore({ now: () => new Date().toISOString(), limits: loadEnterpriseConfiguration(memoryEnv()).persistence.limits, enterpriseVersion: 'test' });
    await assert.rejects(
      () => compose(loadEnterpriseConfiguration({ ...sqliteEnv(directory), ...externalFor(proxy.endpoint) }), { persistence }),
      (error: unknown) => {
        refusesMemoryAuthority(error);
        assert.match((error as Error).message, /a supplied 'memory' Governance Store/);
        return true;
      },
    );
    assert.deepEqual(readdirSync(directory), [], 'refused before any store file was opened');
    assert.equal(proxy.identityCalls + proxy.signCalls, 0);
  });

  it('A8b — the governed Host with approvals declared, under external custody and memory persistence, is refused: no in-memory approval or obligation state is ever composed', async () => {
    const workspace = new Workspace();
    cleanups.push(() => workspace.cleanup());
    const proxy = await countedSigner();
    const env = { ...withoutSoftwareCustody(secureEnv(workspace.dir(), approvalsFile())), AOC_ENTERPRISE_ENV: 'development', AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'memory', ...externalFor(proxy.endpoint) };
    await assert.rejects(() => boot(workspace, env, { policy: approvalPolicy() }), refusesMemoryAuthority);
    assert.equal(proxy.identityCalls + proxy.signCalls, 0);
  });

  it('the supplied-store refusal (CORE-02R A) still takes precedence and is unchanged', async () => {
    const proxy = await countedSigner();
    await assert.rejects(
      () => compose(loadEnterpriseConfiguration({ ...memoryEnv(), ...externalFor(proxy.endpoint) }), { approvals: { store: {} as never } }),
      (error: unknown) => error instanceof AuthorityAuthenticityConfigurationError && /composes its authority stores itself/.test(error.message),
    );
  });
});

// ── B — a clock moved backwards cannot extend identity freshness ─────────────

const APPROVAL_STATE: ApprovalStateCommitment = { storeId: 'approval-store:1', organizationId: 'org-a', sequence: 5, chainDigest: `sha256:${'d'.repeat(64)}` };
const INTERVAL = 5_000;
const T = 1_000_000_000;

async function clocked(): Promise<{ transport: ScriptedTransport; monitor: ExternalAuthoritySignerMonitor; signer: Awaited<ReturnType<typeof establishExternalAuthorityArtifactSigner>>['signer']; clock: { now: number } }> {
  const transport = new ScriptedTransport(AUTHORITY_KEY_A);
  const clock = { now: T };
  const { monitor, signer } = await establishExternalAuthorityArtifactSigner({
    transport,
    pinned: trustedKeyOf(AUTHORITY_KEY_A),
    verifier: testVerifier([AUTHORITY_KEY_A]),
    timeoutMs: 1_000,
    maxAttempts: 1,
    probeIntervalMs: INTERVAL,
    now: () => clock.now,
  });
  assert.equal(transport.identityCalls, 1, 'the startup handshake, at T');
  return { transport, monitor, signer, clock };
}

describe('CORE-02R round 2 B — the identity-probe cache is valid only for a non-negative age below the interval', () => {
  it('B1 — positive age below the interval: cache hit, no identity call', async () => {
    const { transport, monitor, clock } = await clocked();
    for (const age of [0, 1, INTERVAL - 1]) {
      clock.now = T + age;
      assert.equal((await monitor.probe()).state, 'ready');
    }
    assert.equal(transport.identityCalls, 1);
  });

  it('B2 — age exactly the interval: probes', async () => {
    const { transport, monitor, clock } = await clocked();
    clock.now = T + INTERVAL;
    await monitor.probe();
    assert.equal(transport.identityCalls, 2);
  });

  it('B3 — age beyond the interval: probes', async () => {
    const { transport, monitor, clock } = await clocked();
    clock.now = T + INTERVAL + 1;
    await monitor.probe();
    assert.equal(transport.identityCalls, 2);
  });

  it('B4 — negative age (clock moved backwards): probes immediately, for a 1 ms and a 1 h rollback alike', async () => {
    for (const rollback of [1, 3_600_000]) {
      const { transport, monitor, clock } = await clocked();
      clock.now = T - rollback;
      await monitor.probe();
      assert.equal(transport.identityCalls, 2, `rollback ${rollback} ms`);
    }
  });

  it('B5 — rollback + signer unreachable: the stale ready is not served; identity becomes unavailable', async () => {
    const { transport, monitor, clock } = await clocked();
    transport.identityAnswer = () => unavailable('EXTERNAL_SIGNER_UNREACHABLE');
    clock.now = T - 3_600_000;
    const status = await monitor.probe();
    assert.equal(transport.identityCalls, 2);
    assert.deepEqual([status.state, status.reason, status.identity.state], ['unavailable', 'EXTERNAL_SIGNER_UNREACHABLE', 'unavailable']);
  });

  it('B6 — rollback + the service now answers as another key: the mismatch is surfaced', async () => {
    const { transport, monitor, clock } = await clocked();
    transport.identityAnswer = () => identityOf(AUTHORITY_KEY_B);
    clock.now = T - 3_600_000;
    const status = await monitor.probe();
    assert.equal(transport.identityCalls, 2);
    assert.deepEqual([status.state, status.reason], ['unavailable', 'EXTERNAL_SIGNER_IDENTITY_MISMATCH']);
  });

  it('B7 — concurrent callers after a rollback share exactly one identity request', async () => {
    const { transport, monitor, clock } = await clocked();
    const healthy = transport.identityAnswer;
    let release: () => void = () => {};
    transport.identityAnswer = () => new Promise((resolve) => (release = () => resolve(healthy())));
    clock.now = T - 60_000;
    const pending = Array.from({ length: 25 }, () => monitor.probe());
    await new Promise((resolve) => setImmediate(resolve));
    release();
    await Promise.all(pending);
    assert.equal(transport.identityCalls, 2, 'twenty-five concurrent probes → one identity call');
  });

  it('B8 — fanout protection is intact: after a rollback probe the cache re-anchors at the new time, and the 5 000 ms bound applies again', async () => {
    const { transport, monitor, clock } = await clocked();
    await Promise.all(Array.from({ length: 20 }, () => monitor.probe()));
    assert.equal(transport.identityCalls, 1, 'within the interval nothing is asked');
    clock.now = T - 60_000;
    await monitor.probe();
    assert.equal(transport.identityCalls, 2);
    clock.now = T - 60_000 + INTERVAL - 1;
    await Promise.all(Array.from({ length: 20 }, () => monitor.probe()));
    assert.equal(transport.identityCalls, 2, 'the rollback probe result is cached for the interval');
    clock.now = T - 60_000 + INTERVAL;
    await monitor.probe();
    assert.equal(transport.identityCalls, 3);
  });

  it('signing failure stays sticky: a rollback-triggered, successful identity probe does not clear it; only a verified signature does', async () => {
    const { transport, monitor, signer, clock } = await clocked();
    const genuine = transport.answer;
    transport.answer = () => unavailable('EXTERNAL_SIGNER_TIMEOUT');
    await assert.rejects(() => signer.signApprovalState(APPROVAL_STATE), (error: unknown) => reasonOf(error) === 'EXTERNAL_SIGNER_TIMEOUT');
    clock.now = T - 3_600_000;
    const probed = await monitor.probe();
    assert.equal(transport.identityCalls, 2, 'the rollback forced a real identity probe');
    assert.equal(probed.identity.state, 'ready');
    assert.deepEqual([probed.state, probed.reason, probed.lastSigning.state], ['unavailable', 'EXTERNAL_SIGNER_TIMEOUT', 'unavailable']);
    transport.answer = genuine;
    await signer.signApprovalState(APPROVAL_STATE);
    assert.equal(monitor.status().state, 'ready');
  });
});
