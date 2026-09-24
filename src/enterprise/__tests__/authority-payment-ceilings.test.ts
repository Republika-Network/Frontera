import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import type { KernelAuthorityMonetaryConstraint as AuthorityConstraint } from '../kernel-authority/contracts.js';
import type { ExecutionAdapterResult } from '../../features/execution-runtime/index.js';
import { createRecordingExecutionAdapter, type RecordingExecutionAdapter } from '../../features/execution-runtime/tests/execution-fixture.js';
import { EXERCISE_CONTROL_REASON_CODES as X, type ExerciseControlLedgerPort, type ExerciseControlPolicy } from '../../features/exercise-control-runtime/index.js';
import { createInMemoryBoundedGrantStore, type BoundedGrant, type BoundedGrantStorePort } from '../../features/grant-runtime/index.js';
import { compareCanonicalDecimals, isCanonicalDecimal } from '../../features/monetary-runtime/index.js';
import type { PolicyPackProvider } from '../../kernel/index.js';
import { KernelGrantCapability } from '../../kernel/orchestration/grant-adapter.js';
import { createEnterprise, type AocEnterprise, type CreateEnterpriseOptions } from '../composition/composition-root.js';
import { loadEnterpriseConfiguration, type EnterpriseApiKey } from '../configuration/enterprise-configuration.js';
import { createSqliteExerciseControlLedger } from '../exercise-control-ledger/index.js';
import { FINANCIAL_AUTHORITY_REASON_CODES as F } from '../execution-governance/index.js';
import type { GrantAuthorityBinding } from '../execution-governance/index.js';
import { buildDurableAuthorityPayloads, DURABLE_FIXTURE_OPERATOR } from '../kernel-authority/fixtures/durable-authority.fixture.js';
import type { KernelAuthorityStore } from '../kernel-authority/kernel-authority-store.js';
import { createKernelAuthorityProvisioningService, type KernelAuthorityProvisioningService } from '../kernel-authority/provisioning-service.js';
import { createSqliteKernelAuthorityStore } from '../kernel-authority/sqlite-kernel-authority-store.js';
import { financialSpendingLimitId, financialSpendingScopeKey } from '../kernel-authority/financial-authority-resolver.js';

/**
 * P10 — authority-sourced payment ceilings and durable spending limits, end to
 * end, through the one customer entry point and the real durable stores:
 *
 * ```
 * operator ─ provisioning ─ SQLite Kernel Authority Store ─ hydration ─ Authority Graph
 *                                                                          │
 * customer ─ POST /api/governed-actions (governAction) ─ Kernel ─ committed decision
 *                                                                          │
 *            financial-authority resolution on the decision's own lineage ◄┘
 *            ─ grant ceiling = authority's ─ P7 (SQLite ledger, authority limits) ─ adapter
 * ```
 *
 * No Kernel, resolver, store, ledger or adapter is faked here: the recording
 * adapter only records, and host wrappers only *observe* or *stand in the
 * window* a race test needs.
 */

const ORG = 'org-a';
const TRUST_DOMAIN = 'trust-domain-a';
const ACTION = 'payment.send';
const RESOURCE = 'resource-treasury-1';
const AGENT = 'agent-a';
const OWNER = 'owner-a';
const AUTHORITY_GRANT = 'authority-grant-owner-a';
const DELEGATION = 'delegation-agent-a';
const SUBJECT = { system: 'payments-app', subjectId: 'principal-agent-a' } as const;
const SECRET = 'AOC_P10_PAYMENT_CEILINGS_API_KEY_SENTINEL';

const OTHER_AGENT = 'agent-b';
const OTHER_OWNER = 'owner-b';
const OTHER_SUBJECT = { system: 'payments-app', subjectId: 'principal-agent-b' } as const;
const OTHER_SECRET = 'AOC_P10_PAYMENT_CEILINGS_SECOND_API_KEY_SENTINEL';

const KEYS: readonly EnterpriseApiKey[] = [
  { key: SECRET, organizationId: ORG, customerIdentity: { principalId: 'principal-agent-a', externalSubject: SUBJECT } },
  { key: OTHER_SECRET, organizationId: ORG, customerIdentity: { principalId: 'principal-agent-b', externalSubject: OTHER_SUBJECT } },
];

const NO_TEMPORAL_BOUND: GrantAuthorityBinding = {
  kind: 'no-temporal-authority-bound',
  sourceKind: 'organizational-authority',
  justification: 'Durable Kernel Authority; no mandate window governs these payments.',
};

const directories: string[] = [];
const enterprises: AocEnterprise[] = [];
after(async () => {
  await Promise.all(enterprises.map((enterprise) => enterprise.close().catch(() => {})));
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function workDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'aoc-p10-'));
  directories.push(directory);
  return directory;
}

const ceiling = (value: string, currency = 'USD'): AuthorityConstraint => ({ type: 'max_amount', currency, value });
const lifetime = (maximum: string, currency = 'USD', limitId = 'lifetime'): AuthorityConstraint => ({ type: 'spending_limit', limitId, currency, maximum, window: { kind: 'lifetime' } });
const rolling = (maximum: string, seconds: number, currency = 'USD', limitId = 'daily'): AuthorityConstraint => ({ type: 'spending_limit', limitId, currency, maximum, window: { kind: 'rolling', seconds } });

interface PrincipalWorld {
  readonly owner: string;
  readonly agent: string;
  readonly subject: { readonly system: string; readonly subjectId: string };
  readonly authorityGrantId: string;
  readonly delegationGrantId: string;
  readonly suffix: string;
}

const PRIMARY: PrincipalWorld = { owner: OWNER, agent: AGENT, subject: SUBJECT, authorityGrantId: AUTHORITY_GRANT, delegationGrantId: DELEGATION, suffix: 'a' };
const SECONDARY: PrincipalWorld = { owner: OTHER_OWNER, agent: OTHER_AGENT, subject: OTHER_SUBJECT, authorityGrantId: 'authority-grant-owner-b', delegationGrantId: 'delegation-agent-b', suffix: 'b' };

/** Provisions issuer and trust domain once. */
async function provisionDomain(service: KernelAuthorityProvisioningService): Promise<void> {
  const payloads = buildDurableAuthorityPayloads(ORG, TRUST_DOMAIN);
  await service.provisionActor(DURABLE_FIXTURE_OPERATOR, payloads.issuerActor);
  await service.provisionTrustDomain(DURABLE_FIXTURE_OPERATOR, payloads.trustDomain);
  await service.provisionRootIssuer(DURABLE_FIXTURE_OPERATOR, payloads.rootIssuer);
}

/**
 * One human owner holding durable payment authority, delegated to one agent —
 * the machine that actually pays. Constraints live on the owner's authority
 * grant; the delegation repeats none of them unless a test says so.
 */
async function provisionPrincipal(
  service: KernelAuthorityProvisioningService,
  world: PrincipalWorld,
  options: { readonly constraints?: readonly AuthorityConstraint[]; readonly delegationConstraints?: readonly AuthorityConstraint[] } = {},
): Promise<void> {
  const payloads = buildDurableAuthorityPayloads(ORG, TRUST_DOMAIN);
  await service.provisionActor(DURABLE_FIXTURE_OPERATOR, { ...payloads.ownerActor, actorId: world.owner, displayName: `Owner ${world.suffix}`, externalSubject: { system: 'payments-app', subjectId: `owner-${world.suffix}` } });
  await service.provisionActor(DURABLE_FIXTURE_OPERATOR, { ...payloads.agentActor, actorId: world.agent, displayName: `Agent ${world.suffix}`, externalSubject: world.subject });
  await service.provisionPassport(DURABLE_FIXTURE_OPERATOR, { ...payloads.passport, passportId: `passport-${world.agent}`, subjectActorId: world.agent });
  await service.provisionCapabilityToken(DURABLE_FIXTURE_OPERATOR, {
    ...payloads.capabilityToken,
    capabilityTokenId: `cap-${world.agent}`,
    subjectActorId: world.agent,
    principalActorId: world.owner,
    issuerActorId: world.owner,
    actions: [ACTION],
    resourceScopes: [RESOURCE],
  });
  await service.provisionAuthorityGrant(DURABLE_FIXTURE_OPERATOR, {
    ...payloads.authorityGrant,
    authorityGrantId: world.authorityGrantId,
    subjectActorId: world.owner,
    actions: [ACTION],
    resourceScopes: [RESOURCE],
    ...(options.constraints !== undefined ? { constraints: options.constraints } : {}),
  });
  await service.provisionDelegationGrant(DURABLE_FIXTURE_OPERATOR, {
    ...payloads.delegationGrant,
    delegationGrantId: world.delegationGrantId,
    delegatorActorId: world.owner,
    delegateActorId: world.agent,
    sourceAuthorityGrantId: world.authorityGrantId,
    actions: [ACTION],
    resourceScopes: [RESOURCE],
    ...(options.delegationConstraints !== undefined ? { constraints: options.delegationConstraints } : {}),
  });
}

interface Host {
  readonly enterprise: AocEnterprise;
  readonly adapter: RecordingExecutionAdapter;
  readonly grants: BoundedGrant[];
  readonly provisioning: KernelAuthorityProvisioningService;
  readonly authorityStore: KernelAuthorityStore;
  readonly ledgerPath: string;
}

interface HostOptions {
  readonly dir: string;
  readonly policy?: ExerciseControlPolicy;
  readonly ledger?: ExerciseControlLedgerPort;
  readonly adapterBehaviour?: (amount: string) => ExecutionAdapterResult;
  readonly policyPackProvider?: PolicyPackProvider;
  /** Runs inside the host grant store's `issue`, before the store's synchronous commit guard — the commit-boundary window. */
  readonly beforeGrantCommit?: (host: Host) => Promise<void>;
  /** Runs on the first authoritative grant read after an issuance — the window between issuance and exercise. */
  readonly afterGrantIssued?: (host: Host) => Promise<void>;
  readonly assets?: readonly { readonly assetId: string; readonly scale: number }[];
  readonly financialActions?: readonly string[];
}

/** One Frontera Host over the durable authority store and the durable P7 ledger at `dir`. Reopening the same `dir` is a restart. */
async function openHost(options: HostOptions): Promise<Host> {
  const authorityStore = await createSqliteKernelAuthorityStore(join(options.dir, 'kernel-authority.sqlite'));
  const ledgerPath = join(options.dir, 'exercise-ledger.sqlite');
  const base = loadEnterpriseConfiguration({
    AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'memory',
    AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID: ORG,
    AOC_ENTERPRISE_EXERCISE_LEDGER_SQLITE_PATH: ledgerPath,
  });
  const grants: BoundedGrant[] = [];
  const raw = createInMemoryBoundedGrantStore();
  let host: Host | undefined;
  let pendingAfterIssue = false;
  const grantStore: BoundedGrantStorePort = {
    async issue(input) {
      if (options.beforeGrantCommit !== undefined && host !== undefined) await options.beforeGrantCommit(host);
      const outcome = await raw.issue(input);
      if (outcome.outcome === 'issued') {
        grants.push(outcome.grant);
        pendingAfterIssue = true;
      }
      return outcome;
    },
    async read(grantId) {
      if (pendingAfterIssue && options.afterGrantIssued !== undefined && host !== undefined) {
        pendingAfterIssue = false;
        await options.afterGrantIssued(host);
      }
      return raw.read(grantId);
    },
    revoke: (input) => raw.revoke(input),
  };
  const adapter = createRecordingExecutionAdapter((action) =>
    options.adapterBehaviour === undefined ? { outcome: 'completed', providerRef: 'provider-ref' } : options.adapterBehaviour(action.amount?.value ?? ''),
  );
  const enterprise = await createEnterprise({
    configuration: { ...base, authentication: { apiKeys: KEYS } },
    kernelAuthorityStore: authorityStore,
    ...(options.policyPackProvider !== undefined ? { policyPackProvider: options.policyPackProvider } : {}),
    customerIdentityAdmission: { enabled: true },
    authorityControlledExecution: {
      grantCapability: new KernelGrantCapability({ declaration: {} }),
      grantStore,
      executionAdapter: adapter,
      resolveAuthorityBinding: () => NO_TEMPORAL_BOUND,
      exerciseControls: {
        policy: options.policy ?? (() => []),
        revalidateAuthorityBinding: () => NO_TEMPORAL_BOUND,
        ...(options.ledger !== undefined ? { ledger: options.ledger } : {}),
      },
    },
    governedActionOrchestrator: {
      enabled: true,
      trustDomainId: TRUST_DOMAIN,
      grantPolicy: (query) => ({ grantExpiresAt: new Date(Date.parse(query.evaluatedAt) + 10 * 60 * 1000).toISOString() }),
    },
    monetary: { assets: options.assets ?? [{ assetId: 'USD', scale: 2 }, { assetId: 'EUR', scale: 2 }], financialActions: options.financialActions ?? [ACTION] },
  } satisfies CreateEnterpriseOptions);
  enterprises.push(enterprise);
  const provisioning = enterprise.kernelAuthorityProvisioning;
  assert.ok(provisioning !== undefined);
  host = { enterprise, adapter, grants, provisioning, authorityStore, ledgerPath };
  return host;
}

async function closeHost(host: Host): Promise<void> {
  await host.enterprise.close();
  await host.authorityStore.close();
}

let keySequence = 0;
async function pay(host: Host, value: string, options: { readonly currency?: string; readonly secret?: string; readonly extra?: Record<string, unknown> } = {}) {
  assert.ok(host.enterprise.governAction !== undefined);
  const reply = await host.enterprise.governAction(
    { action: ACTION, resource: RESOURCE, amount: { value, currency: options.currency ?? 'USD' }, idempotencyKey: `p10-${(keySequence += 1)}`, ...(options.extra ?? {}) },
    { authorizationHeader: `Bearer ${options.secret ?? SECRET}` },
  );
  return reply.body as { readonly status: string; readonly withheldBy?: string; readonly reasonCodes: readonly string[]; readonly decision?: { readonly status: string } };
}

function reservations(ledgerPath: string): readonly { readonly rules: readonly { readonly limit: { readonly limitId: string; readonly scopeKey: string }; readonly usage: string }[] }[] {
  const db = new Database(ledgerPath, { readonly: true });
  try {
    const ids = db.prepare(`SELECT reservation_id AS id FROM exercise_control_reservations ORDER BY reserved_at_ms, rowid`).all() as { id: string }[];
    const rules = db.prepare(`SELECT limit_id AS limitId, scope_key AS scopeKey, usage FROM exercise_control_reservation_limits WHERE reservation_id = ? ORDER BY ordinal`);
    return ids.map(({ id }) => ({
      rules: (rules.all(id) as { limitId: string; scopeKey: string; usage: string }[]).map((row) => ({ limit: { limitId: row.limitId, scopeKey: row.scopeKey }, usage: row.usage })),
    }));
  } finally {
    db.close();
  }
}

async function freshHost(options: Omit<HostOptions, 'dir'> & { readonly constraints: readonly AuthorityConstraint[]; readonly delegationConstraints?: readonly AuthorityConstraint[]; readonly secondary?: readonly AuthorityConstraint[] }): Promise<Host> {
  const host = await openHost({ dir: workDir(), ...options });
  await provisionDomain(host.provisioning);
  await provisionPrincipal(host.provisioning, PRIMARY, { constraints: options.constraints, ...(options.delegationConstraints !== undefined ? { delegationConstraints: options.delegationConstraints } : {}) });
  if (options.secondary !== undefined) await provisionPrincipal(host.provisioning, SECONDARY, { constraints: options.secondary });
  return host;
}

// ---------------------------------------------------------------------------

describe('P10 §88 — the required end-to-end scenario: per-execution ceiling 100 USD, lifetime limit 250 USD', () => {
  it('75, 100, 75 execute and consume one durable bucket; 0.01 is withheld by P7; the grant ceiling is always the authority’s 100', async () => {
    const host = await freshHost({ constraints: [ceiling('100'), lifetime('250')] });

    const first = await pay(host, '75');
    assert.equal(first.status, 'executed', JSON.stringify(first));
    assert.equal(first.decision?.status, 'allowed');
    assert.deepEqual(host.grants[0]?.scope.amount, { kind: 'ceiling', limit: '100', unit: 'USD' }, 'grant ceiling = authority 100, never the requested 75');

    assert.equal((await pay(host, '100')).status, 'executed');
    assert.equal((await pay(host, '75')).status, 'executed', 'aggregate = 250, exactly the limit');

    const fourth = await pay(host, '0.01');
    assert.equal(fourth.status, 'withheld', JSON.stringify(fourth));
    assert.equal(fourth.withheldBy, 'exercise');
    assert.deepEqual([...fourth.reasonCodes], [X.EXERCISE_CONTROL_LIMIT_EXCEEDED]);
    assert.equal(host.adapter.callCount, 3, 'the 0.01 never reached the adapter');
    assert.deepEqual(host.adapter.calls.map((call) => call.amount?.value), ['75', '100', '75']);

    for (const grant of host.grants) assert.deepEqual(grant.scope.amount, { kind: 'ceiling', limit: '100', unit: 'USD' });

    // One stable, authority-anchored bucket across three grants, three requests and three execution ids.
    const expectedScope = financialSpendingScopeKey({ organizationId: ORG, entityKind: 'authority-grant', entityId: AUTHORITY_GRANT, currency: 'USD' });
    const rows = reservations(host.ledgerPath);
    assert.equal(rows.length, 3, 'three admitted reservations; the refused 0.01 wrote nothing');
    for (const row of rows) {
      assert.deepEqual(
        row.rules.map((rule) => [rule.limit.limitId, rule.limit.scopeKey]),
        [[financialSpendingLimitId('lifetime'), expectedScope]],
      );
    }
    // The 0.01 fits the 100 ceiling, so it is issued a grant — and P7, not the
    // grant, withholds it on the aggregate limit.
    assert.equal(new Set(host.grants.map((grant) => grant.id)).size, 4, 'each request got its own grant — and still the same bucket');
  });

  it('100.01 under a fresh budget fails before any grant: FINANCIAL_AUTHORITY_CEILING_EXCEEDED, decision still ALLOW, no reservation, no adapter', async () => {
    const host = await freshHost({ constraints: [ceiling('100'), lifetime('250')] });
    const result = await pay(host, '100.01');
    assert.equal(result.status, 'withheld', JSON.stringify(result));
    assert.equal(result.withheldBy, 'authority-binding');
    assert.deepEqual([...result.reasonCodes], [F.FINANCIAL_AUTHORITY_CEILING_EXCEEDED]);
    assert.equal(result.decision?.status, 'allowed', 'the Kernel decision is reported exactly as committed, never rewritten to a denial');
    assert.equal(host.grants.length, 0, 'no grant issued');
    assert.equal(reservations(host.ledgerPath).length, 0, 'no P7 reservation');
    assert.equal(host.adapter.callCount, 0, 'no adapter call');
  });
});

describe('P10 §89 / §44 — durable: restart preserves both the authority definition and the consumed budget', () => {
  it('consume 175, close every store, reopen and re-hydrate: 75 succeeds, 0.01 is withheld', async () => {
    const dir = workDir();
    const before = await openHost({ dir });
    await provisionDomain(before.provisioning);
    await provisionPrincipal(before.provisioning, PRIMARY, { constraints: [ceiling('100'), lifetime('250')] });
    assert.equal((await pay(before, '75')).status, 'executed');
    assert.equal((await pay(before, '100')).status, 'executed');
    await closeHost(before);

    const after = await openHost({ dir });
    const records = await after.authorityStore.listRecords({ system: false, organizationId: ORG }, { organizationId: ORG, entityKind: 'authority-grant' });
    assert.deepEqual(records[0]?.payload.constraints, [ceiling('100'), lifetime('250')], 'the authority definition survived the restart');
    assert.equal((await pay(after, '75')).status, 'executed', 'the budget did not reset: 175 + 75 = 250');
    const last = await pay(after, '0.01');
    assert.equal(last.status, 'withheld', JSON.stringify(last));
    assert.deepEqual([...last.reasonCodes], [X.EXERCISE_CONTROL_LIMIT_EXCEEDED]);
    assert.equal(after.adapter.callCount, 1);
    await closeHost(after);
  });

  it('§45 a ceiling and a limit beyond 2^53 survive provision → persist → restart → resolve → compare → reserve byte-exact', async () => {
    const dir = workDir();
    const BEYOND = '9007199254740993.01';
    const before = await openHost({ dir });
    await provisionDomain(before.provisioning);
    await provisionPrincipal(before.provisioning, PRIMARY, { constraints: [ceiling(BEYOND), lifetime('18014398509481986.02')] });
    await closeHost(before);

    const after = await openHost({ dir });
    const first = await pay(after, BEYOND);
    assert.equal(first.status, 'executed', JSON.stringify(first));
    assert.deepEqual(after.grants[0]?.scope.amount, { kind: 'ceiling', limit: BEYOND, unit: 'USD' });
    assert.equal(after.adapter.calls[0]?.amount?.value, BEYOND);
    assert.equal((await pay(after, BEYOND)).status, 'executed', 'exactly twice the value fits exactly');
    const over = await pay(after, '0.01');
    assert.deepEqual([...over.reasonCodes], [X.EXERCISE_CONTROL_LIMIT_EXCEEDED], 'one cent over an exact 2^54-scale budget is refused');
    const usages = reservations(after.ledgerPath).map((row) => row.rules[0]?.usage);
    assert.deepEqual(usages, [BEYOND, BEYOND]);
    await closeHost(after);
  });

  it('fractional values that expose binary floating point stay exact: 0.1 + 0.2 fills a 0.3 budget exactly', async () => {
    const host = await freshHost({ constraints: [ceiling('0.3'), lifetime('0.3')] });
    assert.equal((await pay(host, '0.1')).status, 'executed');
    assert.equal((await pay(host, '0.2')).status, 'executed', 'in IEEE-754 0.1 + 0.2 > 0.3; in exact decimal it is equal');
    assert.deepEqual([...(await pay(host, '0.01')).reasonCodes], [X.EXERCISE_CONTROL_LIMIT_EXCEEDED]);
  });
});

describe('P10 §22 / §49 / §51 — the request never becomes its own ceiling, and a policy threshold is not authority', () => {
  it('request 25, authority 100: the grant source and grant ceiling are 100, not 25', async () => {
    const host = await freshHost({ constraints: [ceiling('100'), lifetime('1000')] });
    assert.equal((await pay(host, '25')).status, 'executed');
    assert.deepEqual(host.grants[0]?.scope.amount, { kind: 'ceiling', limit: '100', unit: 'USD' });
  });

  it('request equal to the ceiling executes; one cent above is refused before any grant', async () => {
    const host = await freshHost({ constraints: [ceiling('100'), lifetime('1000')] });
    assert.equal((await pay(host, '100')).status, 'executed');
    const over = await pay(host, '100.01');
    assert.deepEqual([...over.reasonCodes], [F.FINANCIAL_AUTHORITY_CEILING_EXCEEDED]);
    assert.equal(host.grants.length, 1);
    assert.equal(host.adapter.callCount, 1);
  });

  it('policy allows amount <= 10000, authority ceiling 100, request 150: the Kernel allows, no usable financial grant is issued', async () => {
    const thresholdPolicy: PolicyPackProvider = {
      evaluatePolicyForEnforcement(input) {
        const within = isCanonicalDecimal(input.amount) && compareCanonicalDecimals(input.amount, '10000') <= 0;
        return within
          ? { type: 'policy_allowed', allowed: true, reasonCode: 'PAYMENT_WITHIN_POLICY_THRESHOLD', reason: 'amount <= 10000' }
          : { type: 'policy_denied', allowed: false, reasonCode: 'PAYMENT_ABOVE_POLICY_THRESHOLD', reason: 'amount > 10000' };
      },
    };
    const host = await freshHost({ constraints: [ceiling('100'), lifetime('100000')], policyPackProvider: thresholdPolicy });
    const result = await pay(host, '150');
    assert.equal(result.decision?.status, 'allowed', 'the policy threshold permitted 150');
    assert.equal(result.status, 'withheld');
    assert.deepEqual([...result.reasonCodes], [F.FINANCIAL_AUTHORITY_CEILING_EXCEEDED], 'the policy threshold never substitutes for authority');
    assert.equal(host.grants.length, 0);
    assert.equal(host.adapter.callCount, 0);
  });
});

describe('P10 §15 / §30 / §48 — financial actions without resolvable monetary authority fail closed', () => {
  for (const [name, constraints, request, code] of [
    ['no max_amount at all', [lifetime('1000')], { value: '1' }, F.FINANCIAL_AUTHORITY_CEILING_MISSING],
    ['no constraints at all', [], { value: '1' }, F.FINANCIAL_AUTHORITY_CEILING_MISSING],
    ['a ceiling but no aggregate spending limit — missing is not unlimited', [ceiling('100')], { value: '1' }, F.FINANCIAL_AUTHORITY_SPENDING_LIMIT_MISSING],
    ['authority 100 USD, request in EUR — incomparable, never converted', [ceiling('100'), lifetime('1000')], { value: '100', currency: 'EUR' }, F.FINANCIAL_AUTHORITY_ASSET_MISMATCH],
    ['a spending limit only in another asset', [ceiling('100'), lifetime('1000', 'EUR')], { value: '1' }, F.FINANCIAL_AUTHORITY_SPENDING_LIMIT_MISSING],
  ] as const) {
    it(`${name} → withheld ${code}; no grant, no reservation, no adapter`, async () => {
      const host = await freshHost({ constraints });
      const result = await pay(host, request.value, 'currency' in request ? { currency: request.currency } : {});
      assert.equal(result.status, 'withheld', JSON.stringify(result));
      assert.equal(result.withheldBy, 'authority-binding');
      assert.deepEqual([...result.reasonCodes], [code]);
      assert.equal(host.grants.length, 0);
      assert.equal(reservations(host.ledgerPath).length, 0);
      assert.equal(host.adapter.callCount, 0);
    });
  }

  it('an asset the deployment no longer recognizes on the lineage is malformed authority, whatever asset is requested', async () => {
    const dir = workDir();
    const before = await openHost({ dir, assets: [{ assetId: 'USD', scale: 2 }, { assetId: 'EUR', scale: 2 }] });
    await provisionDomain(before.provisioning);
    await provisionPrincipal(before.provisioning, PRIMARY, { constraints: [ceiling('100'), lifetime('1000'), ceiling('5', 'EUR')] });
    await closeHost(before);
    // The operator removes EUR from the trusted registry; the durable authority still names it.
    const after = await openHost({ dir, assets: [{ assetId: 'USD', scale: 2 }] });
    const result = await pay(after, '1');
    assert.deepEqual([...result.reasonCodes], [F.FINANCIAL_AUTHORITY_MALFORMED]);
    assert.equal(after.adapter.callCount, 0);
    await closeHost(after);
  });

  it('a registry scale narrowed below the stored ceiling makes the authority malformed rather than rounding it', async () => {
    const dir = workDir();
    const before = await openHost({ dir, assets: [{ assetId: 'USD', scale: 2 }] });
    await provisionDomain(before.provisioning);
    await provisionPrincipal(before.provisioning, PRIMARY, { constraints: [ceiling('100.25'), lifetime('1000')] });
    await closeHost(before);
    const after = await openHost({ dir, assets: [{ assetId: 'USD', scale: 0 }] });
    const result = await pay(after, '1');
    assert.deepEqual([...result.reasonCodes], [F.FINANCIAL_AUTHORITY_MALFORMED]);
    await closeHost(after);
  });
});

describe('P10 §20 / §79 — delegation never escapes the principal’s monetary authority', () => {
  it('the delegation repeats nothing: the delegate is still bound by the principal’s 100', async () => {
    const host = await freshHost({ constraints: [ceiling('100'), lifetime('1000')] });
    assert.deepEqual([...(await pay(host, '100.01')).reasonCodes], [F.FINANCIAL_AUTHORITY_CEILING_EXCEEDED]);
    assert.equal((await pay(host, '100')).status, 'executed');
  });

  it('a delegation may narrow: principal 100, delegate 50 → effective 50', async () => {
    const host = await freshHost({ constraints: [ceiling('100'), lifetime('1000')], delegationConstraints: [ceiling('50')] });
    assert.deepEqual([...(await pay(host, '50.01')).reasonCodes], [F.FINANCIAL_AUTHORITY_CEILING_EXCEEDED]);
    assert.equal((await pay(host, '50')).status, 'executed');
    assert.deepEqual(host.grants[0]?.scope.amount, { kind: 'ceiling', limit: '50', unit: 'USD' }, 'intersection: the narrowest ceiling on the lineage');
  });

  it('a delegation can never broaden: principal 100, delegate 500 → effective 100', async () => {
    const host = await freshHost({ constraints: [ceiling('100'), lifetime('1000')], delegationConstraints: [ceiling('500')] });
    assert.deepEqual([...(await pay(host, '101')).reasonCodes], [F.FINANCIAL_AUTHORITY_CEILING_EXCEEDED]);
    assert.equal((await pay(host, '100')).status, 'executed');
    assert.deepEqual(host.grants[0]?.scope.amount, { kind: 'ceiling', limit: '100', unit: 'USD' });
  });

  it('a delegation cannot escape the principal’s aggregate limit, and adding its own limit only narrows', async () => {
    const host = await freshHost({ constraints: [ceiling('100'), lifetime('150')], delegationConstraints: [lifetime('1000', 'USD', 'delegate-lifetime')] });
    assert.equal((await pay(host, '100')).status, 'executed');
    assert.deepEqual([...(await pay(host, '60')).reasonCodes], [X.EXERCISE_CONTROL_LIMIT_EXCEEDED], 'the principal’s 150 still binds the delegate');
    const rules = reservations(host.ledgerPath)[0]?.rules.map((rule) => rule.limit.limitId).sort();
    assert.deepEqual(rules, [financialSpendingLimitId('delegate-lifetime'), financialSpendingLimitId('lifetime')].sort(), 'both limits entered one admission');
  });
});

describe('P10 §28 / §52 / §53 / §54 / §55 — durable aggregate limits through P7, with P7’s semantics unchanged', () => {
  it('§52 ceiling 500 / execution, lifetime 1000: 400, 500, 100 execute; 0.01 is withheld before the adapter', async () => {
    const host = await freshHost({ constraints: [ceiling('500'), lifetime('1000')] });
    for (const value of ['400', '500', '100']) assert.equal((await pay(host, value)).status, 'executed', value);
    assert.deepEqual([...(await pay(host, '0.01')).reasonCodes], [X.EXERCISE_CONTROL_LIMIT_EXCEEDED]);
    assert.equal(host.adapter.callCount, 3);
  });

  it('§53 a provider-confirmed failure releases its reservation: 75 may be reserved again under a 100 limit', async () => {
    let fail = true;
    const host = await freshHost({
      constraints: [ceiling('100'), lifetime('100')],
      adapterBehaviour: () => (fail ? { outcome: 'failed', reason: 'PROVIDER_REJECTED' } : { outcome: 'completed', providerRef: 'ok' }),
    });
    assert.equal((await pay(host, '75')).status, 'execution_failed');
    fail = false;
    assert.equal((await pay(host, '75')).status, 'executed', 'the failed 75 was released');
    assert.deepEqual([...(await pay(host, '75')).reasonCodes], [X.EXERCISE_CONTROL_LIMIT_EXCEEDED], 'the executed 75 is consumed');
  });

  it('§54 an unconfirmed execution stays consumed (no reconciliation in P10)', async () => {
    const host = await freshHost({ constraints: [ceiling('100'), lifetime('100')], adapterBehaviour: () => ({ outcome: 'unconfirmed', detail: 'timeout after send' }) });
    assert.equal((await pay(host, '75')).status, 'execution_unconfirmed');
    assert.deepEqual([...(await pay(host, '75')).reasonCodes], [X.EXERCISE_CONTROL_LIMIT_EXCEEDED]);
  });

  it('§55 a rolling 24h authority limit uses P7’s window semantics exactly — no reset timer', async () => {
    const dir = workDir();
    let instant = Date.parse('2026-03-01T00:00:00.000Z');
    const ledger = await createSqliteExerciseControlLedger(join(dir, 'host-ledger.sqlite'), { now: () => new Date(instant).toISOString() });
    const host = await openHost({ dir, ledger });
    await provisionDomain(host.provisioning);
    await provisionPrincipal(host.provisioning, PRIMARY, { constraints: [ceiling('500'), rolling('500', 86_400)] });

    assert.equal((await pay(host, '300')).status, 'executed');
    instant += 3_600_000;
    assert.equal((await pay(host, '200')).status, 'executed');
    instant += 3_600_000;
    assert.deepEqual([...(await pay(host, '0.01')).reasonCodes], [X.EXERCISE_CONTROL_LIMIT_EXCEEDED]);
    instant = Date.parse('2026-03-02T00:00:01.000Z');
    assert.equal((await pay(host, '300')).status, 'executed', 'the first 300 left the window; exactly its capacity returned');
    assert.deepEqual([...(await pay(host, '0.01')).reasonCodes], [X.EXERCISE_CONTROL_LIMIT_EXCEEDED], 'the 200 is still inside the window');
    await ledger.close();
  });
});

describe('P10 §57 / §58 — authority and asset isolation', () => {
  it('authority A’s budget is not authority B’s: exhausting A leaves B untouched', async () => {
    const host = await freshHost({ constraints: [ceiling('100'), lifetime('100')], secondary: [ceiling('100'), lifetime('100')] });
    assert.equal((await pay(host, '100')).status, 'executed');
    assert.deepEqual([...(await pay(host, '1')).reasonCodes], [X.EXERCISE_CONTROL_LIMIT_EXCEEDED]);
    assert.equal((await pay(host, '100', { secret: OTHER_SECRET })).status, 'executed', 'no accidental global bucket');
    const scopes = reservations(host.ledgerPath).map((row) => row.rules[0]?.limit.scopeKey);
    assert.equal(new Set(scopes).size, 2);
  });

  it('a USD budget does not consume the EUR budget, and neither authorizes the other', async () => {
    const host = await freshHost({ constraints: [ceiling('100'), lifetime('100'), ceiling('100', 'EUR'), lifetime('100', 'EUR')] });
    assert.equal((await pay(host, '100')).status, 'executed');
    assert.deepEqual([...(await pay(host, '1')).reasonCodes], [X.EXERCISE_CONTROL_LIMIT_EXCEEDED]);
    assert.equal((await pay(host, '100', { currency: 'EUR' })).status, 'executed', 'EUR capacity untouched');
    const eurRule = reservations(host.ledgerPath)[1]?.rules[0];
    assert.equal(eurRule?.limit.scopeKey, financialSpendingScopeKey({ organizationId: ORG, entityKind: 'authority-grant', entityId: AUTHORITY_GRANT, currency: 'EUR' }));
  });
});

describe('P10 §59 / §60 / §61 / §81 — host P7 policy can only narrow, and admission stays atomic', () => {
  it('a host limit adds to — never replaces — the authority limit, and both enter one reservation', async () => {
    const hostPolicy: ExerciseControlPolicy = (query) => [{ limitId: 'host-daily', scopeKey: `actor:${query.subject}`, metric: 'amount', maximum: '50', unit: 'USD', window: { kind: 'rolling', seconds: 86_400 } }];
    const host = await freshHost({ constraints: [ceiling('100'), lifetime('1000')], policy: hostPolicy });
    assert.equal((await pay(host, '50')).status, 'executed');
    assert.deepEqual([...(await pay(host, '1')).reasonCodes], [X.EXERCISE_CONTROL_LIMIT_EXCEEDED], 'the host’s own narrower limit applies');
    const rules = reservations(host.ledgerPath)[0]?.rules.map((rule) => rule.limit.limitId).sort();
    assert.deepEqual(rules, [financialSpendingLimitId('lifetime'), 'host-daily'].sort());
  });

  it('a host policy that returns nothing cannot remove the authority limit', async () => {
    const host = await freshHost({ constraints: [ceiling('100'), lifetime('100')], policy: () => [] });
    assert.equal((await pay(host, '100')).status, 'executed');
    assert.deepEqual([...(await pay(host, '1')).reasonCodes], [X.EXERCISE_CONTROL_LIMIT_EXCEEDED]);
  });

  it('a host limit colliding with an authority bucket is refused as a whole (EXERCISE_CONTROL_POLICY_INVALID), never resolved by picking one', async () => {
    const collision: ExerciseControlPolicy = () => [
      { limitId: financialSpendingLimitId('lifetime'), scopeKey: financialSpendingScopeKey({ organizationId: ORG, entityKind: 'authority-grant', entityId: AUTHORITY_GRANT, currency: 'USD' }), metric: 'amount', maximum: '1000000', unit: 'USD', window: { kind: 'lifetime' } },
    ];
    const host = await freshHost({ constraints: [ceiling('100'), lifetime('100')], policy: collision });
    const result = await pay(host, '1');
    assert.deepEqual([...result.reasonCodes], [X.EXERCISE_CONTROL_POLICY_INVALID]);
    assert.equal(host.adapter.callCount, 0);
    assert.equal(reservations(host.ledgerPath).length, 0);
  });

  it('a partial multi-limit admission never happens: a refusal on one limit consumes nothing from the other', async () => {
    const hostPolicy: ExerciseControlPolicy = (query) => [{ limitId: 'host-cap', scopeKey: `actor:${query.subject}`, metric: 'amount', maximum: '10', unit: 'USD', window: { kind: 'lifetime' } }];
    const host = await freshHost({ constraints: [ceiling('100'), lifetime('100')], policy: hostPolicy });
    assert.deepEqual([...(await pay(host, '50')).reasonCodes], [X.EXERCISE_CONTROL_LIMIT_EXCEEDED]);
    assert.equal(reservations(host.ledgerPath).length, 0, 'the authority bucket was not partially reserved');
  });

  it('§81 two concurrent payments race for the last capacity: at most one is admitted', async () => {
    const host = await freshHost({ constraints: [ceiling('100'), lifetime('100')] });
    const results = await Promise.all([pay(host, '100'), pay(host, '100')]);
    assert.deepEqual(results.map((result) => result.status).sort(), ['executed', 'withheld']);
    assert.equal(host.adapter.callCount, 1);
  });

  it('§81 two Hosts over the same durable authority and ledger files share one bucket', async () => {
    const dir = workDir();
    const first = await openHost({ dir });
    await provisionDomain(first.provisioning);
    await provisionPrincipal(first.provisioning, PRIMARY, { constraints: [ceiling('100'), lifetime('100')] });
    const second = await openHost({ dir });
    const results = await Promise.all([pay(first, '100'), pay(second, '100')]);
    assert.deepEqual(results.map((result) => result.status).sort(), ['executed', 'withheld']);
    assert.equal(first.adapter.callCount + second.adapter.callCount, 1);
    await closeHost(first);
    await closeHost(second);
  });
});

describe('P10 §41 / §46 / §82 / §83 — authority changes invalidate stale financial authority', () => {
  it('§82 revoked inside the commit-boundary window: no grant is committed', async () => {
    const host = await freshHost({
      constraints: [ceiling('1000'), lifetime('100000')],
      beforeGrantCommit: async (h) => {
        await h.provisioning.revoke(DURABLE_FIXTURE_OPERATOR, { entityKind: 'authority-grant', entityId: AUTHORITY_GRANT, reason: 'authority withdrawn during issuance' });
      },
    });
    const result = await pay(host, '10');
    assert.equal(result.status, 'withheld', JSON.stringify(result));
    assert.equal(result.withheldBy, 'authority-binding');
    assert.deepEqual([...result.reasonCodes], [F.FINANCIAL_AUTHORITY_INACTIVE]);
    assert.equal(host.grants.length, 0, 'the stale 1000 was never committed');
    assert.equal(host.adapter.callCount, 0);
  });

  it('§41 narrowed inside the commit-boundary window (revoke + re-provision under a new id): no grant is committed under the stale ceiling', async () => {
    const host = await freshHost({
      constraints: [ceiling('1000'), lifetime('100000')],
      beforeGrantCommit: async (h) => {
        await h.provisioning.revoke(DURABLE_FIXTURE_OPERATOR, { entityKind: 'delegation-grant', entityId: DELEGATION, reason: 'replaced by a narrower delegation' });
        await h.provisioning.provisionDelegationGrant(DURABLE_FIXTURE_OPERATOR, {
          ...buildDurableAuthorityPayloads(ORG, TRUST_DOMAIN).delegationGrant,
          delegationGrantId: `${DELEGATION}-narrow`,
          delegatorActorId: OWNER,
          delegateActorId: AGENT,
          sourceAuthorityGrantId: AUTHORITY_GRANT,
          actions: [ACTION],
          resourceScopes: [RESOURCE],
          constraints: [ceiling('100')],
        });
      },
    });
    const result = await pay(host, '10');
    assert.equal(result.status, 'withheld', JSON.stringify(result));
    assert.ok(([F.FINANCIAL_AUTHORITY_INACTIVE, F.FINANCIAL_AUTHORITY_CHANGED] as readonly string[]).includes(result.reasonCodes[0] ?? ''), JSON.stringify(result));
    assert.equal(host.grants.length, 0);
  });

  it('§46 / §83 revoked after issuance and before exercise: withheld before any reservation, adapter never called', async () => {
    const host = await freshHost({
      constraints: [ceiling('100'), lifetime('1000')],
      afterGrantIssued: async (h) => {
        await h.provisioning.revoke(DURABLE_FIXTURE_OPERATOR, { entityKind: 'authority-grant', entityId: AUTHORITY_GRANT, reason: 'authority withdrawn after issuance' });
      },
    });
    const result = await pay(host, '10');
    assert.equal(result.status, 'withheld', JSON.stringify(result));
    assert.equal(result.withheldBy, 'exercise');
    assert.deepEqual([...result.reasonCodes], [X.EXERCISE_CONTROL_AUTHORITY_BINDING_UNVERIFIABLE]);
    assert.equal(host.grants.length, 1, 'the grant was issued under the authority that then stood');
    assert.equal(reservations(host.ledgerPath).length, 0, 'no P7 reservation was made');
    assert.equal(host.adapter.callCount, 0);
  });

  it('§47 a replacement authority with identical terms does not revive a grant issued under the old one', async () => {
    const host = await freshHost({
      constraints: [ceiling('100'), lifetime('1000')],
      afterGrantIssued: async (h) => {
        await h.provisioning.revoke(DURABLE_FIXTURE_OPERATOR, { entityKind: 'delegation-grant', entityId: DELEGATION, reason: 'replaced' });
        await h.provisioning.provisionDelegationGrant(DURABLE_FIXTURE_OPERATOR, {
          ...buildDurableAuthorityPayloads(ORG, TRUST_DOMAIN).delegationGrant,
          delegationGrantId: `${DELEGATION}-replacement`,
          delegatorActorId: OWNER,
          delegateActorId: AGENT,
          sourceAuthorityGrantId: AUTHORITY_GRANT,
          actions: [ACTION],
          resourceScopes: [RESOURCE],
        });
      },
    });
    const result = await pay(host, '10');
    assert.equal(result.status, 'withheld', JSON.stringify(result));
    assert.ok(([X.EXERCISE_CONTROL_AUTHORITY_BINDING_UNVERIFIABLE, X.EXERCISE_CONTROL_AUTHORITY_BINDING_CHANGED] as readonly string[]).includes(result.reasonCodes[0] ?? ''));
    assert.equal(host.adapter.callCount, 0);
  });
});

describe('P10 §32 / §50 / §99 — a caller can neither state, raise nor select monetary authority', () => {
  const RESERVED = ['maxAmount', 'max_amount', 'paymentCeiling', 'spendingLimit', 'spendingLimits', 'budget', 'budgetId', 'remaining', 'limitId', 'scopeKey', 'window', 'financialAuthority', 'authorityLimit'];

  for (const key of RESERVED) {
    it(`'${key}' at the top level of the intent is rejected before the Kernel`, async () => {
      const host = await freshHost({ constraints: [ceiling('100'), lifetime('1000')] });
      const result = await pay(host, '10', { extra: { [key]: key === 'window' ? 'lifetime' : '1000000000' } });
      assert.equal(result.status, 'rejected', JSON.stringify(result));
      assert.equal(host.grants.length, 0);
    });

    it(`'${key}' at the top level of assertedContext is rejected before the Kernel`, async () => {
      const host = await freshHost({ constraints: [ceiling('100'), lifetime('1000')] });
      const result = await pay(host, '10', { extra: { assertedContext: { [key]: 'unlimited' } } });
      assert.equal(result.status, 'rejected', JSON.stringify(result));
      assert.equal(host.grants.length, 0);
    });
  }

  it('the same keys nested inside asserted context cannot reach authority: the ceiling and the budget stay the operator’s', async () => {
    const host = await freshHost({ constraints: [ceiling('100'), lifetime('150')] });
    const smuggled = { assertedContext: { meta: { maxAmount: '1000000000', spendingLimit: 'unlimited', budgetId: 'admin', window: 'lifetime', limitId: 'lifetime', scopeKey: 'global', remaining: '1000000000', financialAuthority: { ceiling: '1000000000' } } } };
    const first = await pay(host, '100', { extra: smuggled });
    assert.equal(first.status, 'executed', JSON.stringify(first));
    assert.deepEqual(host.grants[0]?.scope.amount, { kind: 'ceiling', limit: '100', unit: 'USD' });
    assert.deepEqual([...(await pay(host, '100.01', { extra: smuggled })).reasonCodes], [F.FINANCIAL_AUTHORITY_CEILING_EXCEEDED]);
    assert.deepEqual([...(await pay(host, '60', { extra: smuggled })).reasonCodes], [X.EXERCISE_CONTROL_LIMIT_EXCEEDED]);
  });

  it('the customer surface exposes no route or method to set a ceiling or a budget', async () => {
    const host = await freshHost({ constraints: [ceiling('100'), lifetime('1000')] });
    const surface = Object.keys(host.enterprise).filter((name) => /payment|budget|spending|ceiling|limit/i.test(name));
    assert.deepEqual(surface, [], 'authority is provisioned only through the operator surface');
  });
});

describe('P10 §80 — tenant confinement', () => {
  it('authority provisioned for organization B never supplies payment authority to organization A, even with identical ids', async () => {
    const dir = workDir();
    const store = await createSqliteKernelAuthorityStore(join(dir, 'kernel-authority.sqlite'));
    const orgB = createKernelAuthorityProvisioningService({ store, organizationId: 'org-b' });
    const payloads = buildDurableAuthorityPayloads('org-b', TRUST_DOMAIN);
    await orgB.provisionActor(DURABLE_FIXTURE_OPERATOR, payloads.issuerActor);
    await orgB.provisionTrustDomain(DURABLE_FIXTURE_OPERATOR, payloads.trustDomain);
    await orgB.provisionRootIssuer(DURABLE_FIXTURE_OPERATOR, payloads.rootIssuer);
    await provisionPrincipal(orgB, PRIMARY, { constraints: [ceiling('100'), lifetime('1000')] });
    await store.close();

    // Organization A holds the same actor, action and asset — but no monetary authority of its own.
    const host = await openHost({ dir });
    await provisionDomain(host.provisioning);
    await provisionPrincipal(host.provisioning, PRIMARY, { constraints: [] });
    const result = await pay(host, '10');
    assert.equal(result.status, 'withheld', JSON.stringify(result));
    assert.deepEqual([...result.reasonCodes], [F.FINANCIAL_AUTHORITY_CEILING_MISSING]);
    assert.equal(host.adapter.callCount, 0);
    await closeHost(host);
  });
});
