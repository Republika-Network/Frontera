import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAssuranceEvidenceResolver, type AssuranceEvidenceSources } from '../assurance/evidence-resolver.js';
import { deriveAssuranceMetrics } from '../assurance/metrics.js';
import { UNATTRIBUTED_ORGANIZATION, attributeEvidenceBundle, classifyBundleVerification } from '../assurance/evidence-bundle-trust.js';
import { isHostVerified } from '../assurance/manual-evidence-trust.js';
import { AOC_SAF_FRAMEWORK_ID, AOC_SAF_FRAMEWORK_V1, AOC_SAF_FRAMEWORK_VERSION } from '../assurance/saf-framework.js';
import { RN_SV_FRAMEWORK_V0_1 } from '../assurance/frameworks/rn-sv-framework.js';
import { computeDigest } from '../governance-store/digest.js';
import { createInMemoryEvidenceStore, type EvidenceStore } from '../evidence/evidence-store.js';
import { createSqliteEvidenceStore } from '../evidence/sqlite-evidence-store.js';
import { rebuildEvidenceBundleCurrentTrace } from '../evidence/bundle-current-trace.js';
import {
  AUDITOR_DISCLOSURE_POLICY_V2,
  buildAuthorityTrace,
  buildEvidenceBundle,
  buildEvidenceBundleV2,
  getDisclosurePolicy,
  verifyEvidenceBundle,
  type AuthorityTraceSources,
  type EvidenceBundle,
} from '../evidence/index.js';
import type { GovernanceRecord, GovernanceStoreAccessContext, GovernanceStoreQuery } from '../governance-store/contracts.js';
import type { GovernanceStore } from '../governance-store/governance-store.js';
import type { AssuranceAccessContext, AssuranceEvidenceRequirement, AssuranceEvidenceResolution } from '../assurance/contracts.js';
import { ASSURANCE_CUTOFF, ASSURANCE_ORG, ASSURANCE_SYSTEM, buildAssuranceClock, buildAssuranceHarness, buildAssuranceIdGenerator, buildAttestation, buildTestScope } from './assurance-support.js';

/**
 * ASSURE-SEC-01D -- tenant attribution and Evidence Bundle v2 verification.
 *
 * Host evidence belongs to the organization its canonical store recorded,
 * never to the assessed organization by default; a v2 bundle is verified
 * against the canonical trace rebuilt now, in the assessed organization's
 * scope, and every failure keeps its own cause. Canonical sources are a
 * synthetic Governance Store (so a non-conforming store can be simulated) and
 * the real in-memory and SQLite Evidence Stores.
 */

const ORG = 'org-1';
const OTHER = 'org-2';
const AGENT = 'agent-under-test';
const T = '2026-06-01T00:00:00.000Z';
const requestIdOf = (hex: string): string => `aoc.gar:${hex.repeat(32)}`;

interface CanonicalRecord {
  record: GovernanceRecord;
  /** On the governed-action path (G-01B1): only such a record has a trace. */
  governed: boolean;
}

interface Canon {
  readonly records: CanonicalRecord[];
  /** Simulates a non-conforming store: summaries returned whatever the organization filter. */
  readonly leakSummaries?: readonly { readonly evaluationId: string; readonly organizationId?: string }[];
  traceReadFails?: boolean;
}

function governanceRecord(input: { readonly organizationId?: string; readonly requestId: string; readonly evaluationId: string; readonly status?: string }): GovernanceRecord {
  const status = input.status ?? 'denied';
  return {
    request: { requestId: input.requestId, ...(input.organizationId !== undefined ? { organizationId: input.organizationId } : {}), actorId: AGENT, actionType: 'act', resourceScope: 'res', requestedAt: T, receivedAt: T, payloadDigest: 'sha256:p' },
    evaluation: { evaluationId: input.evaluationId, decisionId: `decision-${input.evaluationId}`, requestId: input.requestId, status, summary: status, reasonCodes: [], evaluatedAt: T, kernelVersion: 'k', enterpriseVersion: 'e' },
    integrity: { aggregateDigest: `sha256:${computeDigest({ evaluationId: input.evaluationId }).slice(7)}`, chainPosition: 1 },
    trace: [],
    events: [],
    metadata: { lifecycleState: 'running', moduleSnapshot: [], schemaVersion: 'aoc.governance-store.schema.v1' },
    references: [],
  } as unknown as GovernanceRecord;
}

const visible = (context: GovernanceStoreAccessContext, organizationId: string | undefined): boolean => context.system || (organizationId !== undefined && organizationId === context.organizationId);

/** The Governance Store's read contract over `canon`, with the real stores' tenant rules (`store-common.ts`). */
function governanceStore(canon: Canon): GovernanceStore {
  const summaryOf = (record: GovernanceRecord) => ({
    evaluationId: record.evaluation.evaluationId,
    decisionId: record.evaluation.decisionId,
    requestId: record.request.requestId,
    ...(record.request.organizationId !== undefined ? { organizationId: record.request.organizationId } : {}),
    actorId: record.request.actorId,
    actionType: record.request.actionType,
    status: record.evaluation.status,
    reasonCodes: record.evaluation.reasonCodes,
    evaluatedAt: record.evaluation.evaluatedAt,
    persistedAt: record.evaluation.evaluatedAt,
    aggregateDigest: record.integrity.aggregateDigest,
  });
  const byEvaluation = (evaluationId: string) => canon.records.find((entry) => entry.record.evaluation.evaluationId === evaluationId);
  const store = {
    async query(context: GovernanceStoreAccessContext, query: GovernanceStoreQuery) {
      const organizationId = context.system ? query.organizationId : context.organizationId;
      if (query.governedPath === 'governed-action') {
        if (canon.traceReadFails === true) throw Object.assign(new Error('store offline'), { code: 'GOVERNANCE_STORE_UNAVAILABLE' });
        return { records: canon.records.filter((entry) => entry.governed && entry.record.request.requestId === query.requestId && visible(context, entry.record.request.organizationId)).map((entry) => summaryOf(entry.record)) };
      }
      const conforming = canon.records.filter((entry) => organizationId === undefined || entry.record.request.organizationId === organizationId).map((entry) => summaryOf(entry.record));
      const leaked = (canon.leakSummaries ?? []).map((leak) => {
        const entry = byEvaluation(leak.evaluationId);
        assert.ok(entry);
        const { organizationId: _real, ...rest } = summaryOf(entry.record);
        return { ...rest, ...(leak.organizationId !== undefined ? { organizationId: leak.organizationId } : {}) };
      });
      return { records: [...conforming, ...leaked] };
    },
    async verify() {
      return { valid: true, failures: [] };
    },
    async getByEvaluationId(context: GovernanceStoreAccessContext, evaluationId: string) {
      const entry = byEvaluation(evaluationId);
      return entry !== undefined && visible(context, entry.record.request.organizationId) ? entry.record : null;
    },
    async getByRequestId(context: GovernanceStoreAccessContext, requestId: string) {
      const entry = canon.records.find((candidate) => candidate.record.request.requestId === requestId);
      return entry !== undefined && visible(context, entry.record.request.organizationId) ? entry.record : null;
    },
  };
  return store as unknown as GovernanceStore;
}

async function v2Bundle(canon: Canon, record: GovernanceRecord, bundleId: string): Promise<EvidenceBundle> {
  const build = await buildAuthorityTrace({ governance: governanceStore(canon) } as AuthorityTraceSources, { system: true }, record.request.requestId);
  assert.ok(build, 'the canonical trace of a governed request builds');
  return buildEvidenceBundleV2(record, build.trace, AUDITOR_DISCLOSURE_POLICY_V2, { now: () => T, nextId: () => bundleId });
}

function v1Bundle(record: GovernanceRecord, bundleId: string, level = 'AUDITOR'): EvidenceBundle {
  return buildEvidenceBundle(record, getDisclosurePolicy(level), { now: () => T, nextId: () => bundleId });
}

const BUNDLES: AssuranceEvidenceRequirement = {
  requirementId: 'req.bundles',
  description: 'verified, organization-bound evidence bundles',
  acceptedEvidenceTypes: ['evidence_bundle'],
  minimumCount: 1,
  mustBeVerified: true,
  mustBeOrganizationBound: true,
  contradictionPolicy: 'manual_review',
};

const RECORDS: AssuranceEvidenceRequirement = { ...BUNDLES, requirementId: 'req.records', description: 'verified governance records', acceptedEvidenceTypes: ['governance_record'] };

async function resolve(sources: AssuranceEvidenceSources, requirement = BUNDLES, context: AssuranceAccessContext = ASSURANCE_ORG): Promise<AssuranceEvidenceResolution> {
  const resolver = createAssuranceEvidenceResolver({ sources, now: buildAssuranceClock(), nextId: buildAssuranceIdGenerator() });
  return resolver.resolve(buildTestScope(), requirement, context);
}

const codesOf = (resolution: AssuranceEvidenceResolution, externalId: string): readonly string[] =>
  resolution.rejectedEvidence.find((rejected) => rejected.evidenceReference.externalId === externalId)?.reasonCodes ?? [];
const detailOf = (resolution: AssuranceEvidenceResolution, externalId: string): string =>
  resolution.rejectedEvidence.find((rejected) => rejected.evidenceReference.externalId === externalId)?.detail ?? '';
const acceptedIds = (resolution: AssuranceEvidenceResolution): readonly string[] => resolution.acceptedEvidence.map((reference) => reference.externalId);

/** One org-1 governed request with a v2 bundle, stored with its owner. */
async function v2World(options: { readonly status?: string } = {}) {
  const record = governanceRecord({ organizationId: ORG, requestId: requestIdOf('a'), evaluationId: 'eval-a', ...(options.status !== undefined ? { status: options.status } : {}) });
  const canon: Canon = { records: [{ record, governed: true }] };
  const evidenceStore = createInMemoryEvidenceStore({ now: () => T });
  const bundle = await v2Bundle(canon, record, 'bundle-v2');
  await evidenceStore.store(bundle, { organizationId: ORG });
  return { canon, record, bundle, evidenceStore, sources: { governanceStore: governanceStore(canon), evidenceStore } as AssuranceEvidenceSources };
}

describe('ASSURE-SEC-01D -- D1: evidence is attributed to the organization its canonical store recorded', () => {
  it('(1) a Governance Record of the assessed organization is accepted under that organization', async () => {
    const record = governanceRecord({ organizationId: ORG, requestId: requestIdOf('a'), evaluationId: 'eval-a' });
    const resolution = await resolve({ governanceStore: governanceStore({ records: [{ record, governed: true }] }) }, RECORDS);
    assert.deepEqual(acceptedIds(resolution), ['eval-a']);
    assert.equal(resolution.acceptedEvidence[0]?.organizationId, ORG);
  });

  it('(2) a record another organization owns, returned by a non-conforming store, is rejected -- and its organization is not disclosed', async () => {
    const own = governanceRecord({ organizationId: ORG, requestId: requestIdOf('a'), evaluationId: 'eval-a' });
    const foreign = governanceRecord({ organizationId: OTHER, requestId: requestIdOf('b'), evaluationId: 'eval-b' });
    const canon: Canon = { records: [{ record: own, governed: true }, { record: foreign, governed: true }], leakSummaries: [{ evaluationId: 'eval-b', organizationId: OTHER }] };
    const resolution = await resolve({ governanceStore: governanceStore(canon) }, RECORDS);
    assert.deepEqual(acceptedIds(resolution), ['eval-a']);
    assert.ok(codesOf(resolution, 'eval-b').includes('EVIDENCE_WRONG_TENANT'));
    assert.equal(detailOf(resolution, 'eval-b').includes(OTHER), false, 'no other tenant identifier in the detail');
  });

  it('(3) a record with no organization is not attributable: never presented as the assessed organization', async () => {
    const own = governanceRecord({ organizationId: ORG, requestId: requestIdOf('a'), evaluationId: 'eval-a' });
    const unscoped = governanceRecord({ requestId: requestIdOf('c'), evaluationId: 'eval-c' });
    const canon: Canon = { records: [{ record: own, governed: true }, { record: unscoped, governed: false }], leakSummaries: [{ evaluationId: 'eval-c' }] };
    for (const context of [ASSURANCE_ORG, ASSURANCE_SYSTEM] as const) {
      const resolution = await resolve({ governanceStore: governanceStore(canon) }, RECORDS, context);
      const rejected = resolution.rejectedEvidence.find((entry) => entry.evidenceReference.externalId === 'eval-c');
      assert.equal(rejected?.evidenceReference.organizationId, UNATTRIBUTED_ORGANIZATION);
      assert.ok(rejected?.reasonCodes.includes('EVIDENCE_WRONG_TENANT'));
      assert.match(rejected?.detail ?? '', /no organization attributable/);
      assert.deepEqual(acceptedIds(resolution), ['eval-a']);
    }
  });

  it('(4) historical bundles: a store-recorded owner is honoured; a bundle the store recorded no owner for is not attributed, even when its source record is the assessed organization\'s', async () => {
    const record = governanceRecord({ organizationId: ORG, requestId: requestIdOf('a'), evaluationId: 'eval-a' });
    const canon: Canon = { records: [{ record, governed: true }] };
    const evidenceStore = createInMemoryEvidenceStore({ now: () => T });
    // Pre-ASSURE-01 storage: no owner option; the store defaulted the owner to the disclosed organization.
    await evidenceStore.store(v1Bundle(record, 'bundle-legacy-owned'));
    // The same, under a policy that hides the organization: the store recorded no owner at all.
    await evidenceStore.store(v1Bundle(record, 'bundle-legacy-unowned', 'PARTNER'));
    const resolution = await resolve({ governanceStore: governanceStore(canon), evidenceStore }, BUNDLES, ASSURANCE_SYSTEM);
    assert.deepEqual(acceptedIds(resolution), ['bundle-legacy-owned']);
    const unowned = resolution.rejectedEvidence.find((entry) => entry.evidenceReference.externalId === 'bundle-legacy-unowned');
    assert.equal(unowned?.evidenceReference.organizationId, UNATTRIBUTED_ORGANIZATION, 'never inferred from the evaluation id it shares with an org-1 record');
    assert.ok(unowned?.reasonCodes.includes('EVIDENCE_WRONG_TENANT'));
    assert.equal(unowned?.reasonCodes.includes('EVIDENCE_DIGEST_MISMATCH'), false, 'an unattributed bundle is not a corrupt one');
    // An organization-scoped caller does not even see an unowned bundle (the store's own tenant rule).
    const scoped = await resolve({ governanceStore: governanceStore(canon), evidenceStore }, BUNDLES, ASSURANCE_ORG);
    assert.deepEqual(acceptedIds(scoped), ['bundle-legacy-owned']);
    assert.equal(scoped.rejectedEvidence.length, 0);
  });

  it('(4b) attribution persists in the SQLite Evidence Store: an unowned bundle stays unattributed after reopening', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'assure-sec-01d-'));
    try {
      const record = governanceRecord({ organizationId: ORG, requestId: requestIdOf('a'), evaluationId: 'eval-a' });
      const canon: Canon = { records: [{ record, governed: true }] };
      const path = join(dir, 'evidence.db');
      const first = await createSqliteEvidenceStore(path, { now: () => T });
      await first.store(v1Bundle(record, 'bundle-owned'), { organizationId: ORG });
      await first.store(v1Bundle(record, 'bundle-unowned', 'PARTNER'));
      await first.close();
      const reopened = await createSqliteEvidenceStore(path, { now: () => T });
      try {
        const resolution = await resolve({ governanceStore: governanceStore(canon), evidenceStore: reopened }, BUNDLES, ASSURANCE_SYSTEM);
        assert.deepEqual(acceptedIds(resolution), ['bundle-owned']);
        assert.ok(codesOf(resolution, 'bundle-unowned').includes('EVIDENCE_WRONG_TENANT'));
      } finally {
        await reopened.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('attribution rules: owner wins only when the disclosed organization agrees', () => {
    assert.deepEqual(attributeEvidenceBundle(ORG, ORG), { organizationId: ORG });
    assert.deepEqual(attributeEvidenceBundle(ORG, undefined), { organizationId: ORG });
    assert.deepEqual(attributeEvidenceBundle(undefined, ORG), { organizationId: UNATTRIBUTED_ORGANIZATION }, 'a disclosed organization alone is the bundle\'s own claim');
    assert.deepEqual(attributeEvidenceBundle('', undefined), { organizationId: UNATTRIBUTED_ORGANIZATION });
    assert.deepEqual(attributeEvidenceBundle(ORG, OTHER), { organizationId: UNATTRIBUTED_ORGANIZATION, conflict: true });
  });
});

describe('ASSURE-SEC-01D -- D1: tenant isolation holds for every caller context', () => {
  async function twoTenantWorld() {
    const own = governanceRecord({ organizationId: ORG, requestId: requestIdOf('a'), evaluationId: 'eval-shared' });
    const foreign = governanceRecord({ organizationId: OTHER, requestId: requestIdOf('b'), evaluationId: 'eval-foreign' });
    const canon: Canon = { records: [{ record: own, governed: true }, { record: foreign, governed: true }] };
    const evidenceStore = createInMemoryEvidenceStore({ now: () => T });
    await evidenceStore.store(v1Bundle(own, 'bundle-own'), { organizationId: ORG });
    // A bundle owned by org-2 that names org-1's evaluation (e.g. written by an embedder).
    await evidenceStore.store(v1Bundle(own, 'bundle-foreign-owner', 'PARTNER'), { organizationId: OTHER });
    // A v2 bundle of org-2's own request, stored as org-2's.
    await evidenceStore.store(await v2Bundle(canon, foreign, 'bundle-foreign-v2'), { organizationId: OTHER });
    return { canon, evidenceStore };
  }

  it('(6, 16) organization context: another organization\'s bundle is invisible; only the assessed organization\'s is accepted', async () => {
    const { canon, evidenceStore } = await twoTenantWorld();
    const resolution = await resolve({ governanceStore: governanceStore(canon), evidenceStore }, BUNDLES, ASSURANCE_ORG);
    assert.deepEqual(acceptedIds(resolution), ['bundle-own']);
    assert.equal(resolution.rejectedEvidence.length, 0);
  });

  it('(6, 15) system context: it sees more, accepts nothing more -- foreign-owned bundles are rejected without naming their organization', async () => {
    const { canon, evidenceStore } = await twoTenantWorld();
    const resolution = await resolve({ governanceStore: governanceStore(canon), evidenceStore }, BUNDLES, ASSURANCE_SYSTEM);
    assert.deepEqual(acceptedIds(resolution), ['bundle-own']);
    assert.ok(codesOf(resolution, 'bundle-foreign-owner').includes('EVIDENCE_WRONG_TENANT'));
    assert.equal(detailOf(resolution, 'bundle-foreign-owner').includes(OTHER), false);
  });

  it('(11) a v2 bundle of another organization\'s request is not verified in the assessed scope and is rejected', async () => {
    const { canon, evidenceStore } = await twoTenantWorld();
    // org-2's bundle is reachable only through org-2's evaluation; an assessment of org-2 data from org-1 is refused before any read.
    const foreignEvidence = await evidenceStore.listByEvaluationId({ system: true }, 'eval-foreign');
    assert.equal(foreignEvidence.length, 1);
    const leaking: Canon = { ...canon, leakSummaries: [{ evaluationId: 'eval-foreign', organizationId: OTHER }] };
    const resolution = await resolve({ governanceStore: governanceStore(leaking), evidenceStore }, BUNDLES, ASSURANCE_SYSTEM);
    const codes = codesOf(resolution, 'bundle-foreign-v2');
    assert.ok(codes.includes('EVIDENCE_WRONG_TENANT'));
    assert.ok(codes.includes('EVIDENCE_SOURCE_UNAVAILABLE'), 'the trace is rebuilt only in the assessed organization\'s scope');
    assert.equal(resolution.rejectedEvidence.find((entry) => entry.evidenceReference.externalId === 'bundle-foreign-v2')?.evidenceReference.verified, false);
    assert.equal(detailOf(resolution, 'bundle-foreign-v2').includes(OTHER), false);
  });

  it('(15) a system caller and an organization caller reach the same verdict on the assessed organization\'s own evidence', async () => {
    const world = await v2World();
    const asOrg = await resolve(world.sources, BUNDLES, ASSURANCE_ORG);
    const asSystem = await resolve(world.sources, BUNDLES, ASSURANCE_SYSTEM);
    assert.deepEqual(acceptedIds(asOrg), ['bundle-v2']);
    assert.deepEqual(acceptedIds(asSystem), ['bundle-v2']);
  });
});

describe('ASSURE-SEC-01D -- D2: Evidence Bundles are verified against their canonical sources', () => {
  it('(5) a legitimate v1 bundle is verified against its source Governance Record and accepted', async () => {
    const record = governanceRecord({ organizationId: ORG, requestId: requestIdOf('a'), evaluationId: 'eval-a' });
    const evidenceStore = createInMemoryEvidenceStore({ now: () => T });
    await evidenceStore.store(v1Bundle(record, 'bundle-v1'), { organizationId: ORG });
    const resolution = await resolve({ governanceStore: governanceStore({ records: [{ record, governed: false }] }), evidenceStore });
    assert.deepEqual(acceptedIds(resolution), ['bundle-v1']);
    assert.equal(resolution.acceptedEvidence[0]?.verified, true);
    assert.equal(isHostVerified(resolution.acceptedEvidence[0]!), true);
    assert.equal(resolution.acceptedEvidence[0]?.verificationReference, 'evidence-verify:bundle-v1');
  });

  it('(5) a v1 bundle sealed over a record that is not the canonical one is an integrity failure', async () => {
    const record = governanceRecord({ organizationId: ORG, requestId: requestIdOf('a'), evaluationId: 'eval-a' });
    const forgedSource = { ...record, integrity: { ...record.integrity, aggregateDigest: `sha256:${'9'.repeat(64)}` } } as GovernanceRecord;
    const evidenceStore = createInMemoryEvidenceStore({ now: () => T });
    await evidenceStore.store(v1Bundle(forgedSource, 'bundle-v1-forged'), { organizationId: ORG });
    const resolution = await resolve({ governanceStore: governanceStore({ records: [{ record, governed: false }] }), evidenceStore });
    assert.deepEqual(acceptedIds(resolution), []);
    assert.ok(codesOf(resolution, 'bundle-v1-forged').includes('EVIDENCE_DIGEST_MISMATCH'));
    assert.equal(codesOf(resolution, 'bundle-v1-forged').includes('EVIDENCE_SOURCE_UNAVAILABLE'), false, 'a v1 bundle has no trace to miss');
  });

  it('(7) a v2 bundle whose canonical trace rebuilds and agrees is verified and accepted', async () => {
    const world = await v2World();
    const resolution = await resolve(world.sources);
    assert.deepEqual(acceptedIds(resolution), ['bundle-v2']);
    assert.equal(resolution.acceptedEvidence[0]?.verified, true);
    assert.equal(resolution.acceptedEvidence[0]?.organizationId, ORG);
    assert.equal(resolution.status, 'satisfied');
  });

  it('(7) the explicitly composed trace sources are the ones used', async () => {
    const world = await v2World();
    let reads = 0;
    const governance = governanceStore(world.canon);
    const traceSources: AuthorityTraceSources = {
      governance: {
        getByRequestId: (context, requestId) => ((reads += 1), governance.getByRequestId(context, requestId)),
        verify: (context, evaluationId) => governance.verify(context, evaluationId),
        query: (context, query) => governance.query(context, query),
      },
    };
    const resolution = await resolve({ ...world.sources, traceSources });
    assert.deepEqual(acceptedIds(resolution), ['bundle-v2']);
    assert.ok(reads > 0);
  });

  it('(8) a v2 bundle whose canonical trace cannot be rebuilt is not verified -- source unavailable, never a digest mismatch', async () => {
    const world = await v2World();
    world.canon.records[0]!.governed = false;
    const resolution = await resolve(world.sources);
    assert.deepEqual(acceptedIds(resolution), []);
    const codes = codesOf(resolution, 'bundle-v2');
    assert.ok(codes.includes('EVIDENCE_SOURCE_UNAVAILABLE'));
    assert.equal(codes.includes('EVIDENCE_DIGEST_MISMATCH'), false);
    assert.equal(codes.includes('EVIDENCE_CONTRADICTORY'), false, 'absence is not a contradiction');
    assert.equal(resolution.rejectedEvidence[0]?.evidenceReference.verified, false);
  });

  it('(8, 14) a canonical store that cannot be read leaves a v2 bundle unverified, as source unavailable', async () => {
    const world = await v2World();
    world.canon.traceReadFails = true;
    const resolution = await resolve(world.sources);
    assert.deepEqual(acceptedIds(resolution), []);
    assert.deepEqual([...codesOf(resolution, 'bundle-v2')].sort(), ['EVIDENCE_SOURCE_UNAVAILABLE', 'EVIDENCE_UNVERIFIED']);
    assert.equal(detailOf(resolution, 'bundle-v2').includes('offline'), false, 'no store message reaches the detail');
  });

  it('(9) a v2 bundle the canonical records now contradict is rejected as contradictory', async () => {
    const world = await v2World();
    (world.canon.records[0]!.record.evaluation as { status: string }).status = 'allowed';
    const resolution = await resolve(world.sources);
    assert.deepEqual(acceptedIds(resolution), []);
    const codes = codesOf(resolution, 'bundle-v2');
    assert.ok(codes.includes('EVIDENCE_CONTRADICTORY'), String(codes));
    assert.equal(codes.includes('EVIDENCE_SOURCE_UNAVAILABLE'), false);
  });

  it('(10) a v2 bundle with an altered digest is an integrity failure, not a missing source', async () => {
    const world = await v2World();
    const tampered = { ...world.bundle, bundleId: 'bundle-tampered', subject: { ...world.bundle.subject, description: 'rewritten' } } as EvidenceBundle;
    await world.evidenceStore.store(tampered, { organizationId: ORG });
    const resolution = await resolve(world.sources);
    assert.deepEqual(acceptedIds(resolution), ['bundle-v2']);
    const codes = codesOf(resolution, 'bundle-tampered');
    assert.ok(codes.includes('EVIDENCE_DIGEST_MISMATCH'));
    assert.equal(codes.includes('EVIDENCE_SOURCE_UNAVAILABLE'), false);
  });

  it('(12) a v2 bundle naming a different request than it was sealed for is rejected', async () => {
    const world = await v2World();
    const other = governanceRecord({ organizationId: ORG, requestId: requestIdOf('d'), evaluationId: 'eval-d' });
    world.canon.records.push({ record: other, governed: true });
    const misdirected = { ...world.bundle, bundleId: 'bundle-misdirected', source: { ...world.bundle.source, requestId: other.request.requestId } } as EvidenceBundle;
    await world.evidenceStore.store(misdirected, { organizationId: ORG });
    const resolution = await resolve(world.sources);
    assert.equal(acceptedIds(resolution).includes('bundle-misdirected'), false);
    assert.ok(codesOf(resolution, 'bundle-misdirected').includes('EVIDENCE_DIGEST_MISMATCH'));
  });

  it('(13) a verified v2 bundle of a request with no confirmed outcome proves what it disclosed -- no more', async () => {
    const world = await v2World({ status: 'allowed' });
    const resolution = await resolve(world.sources);
    assert.deepEqual(acceptedIds(resolution), ['bundle-v2']);
    const summary = world.bundle.trace?.summary;
    assert.ok(typeof summary === 'object' && summary.finalState !== 'executed-confirmed-completed', 'the request never reached a confirmed outcome');
    const metrics = deriveAssuranceMetrics([resolution]);
    assert.deepEqual(Object.keys(metrics).sort(), ['evidence.bundles.all_verified', 'evidence.bundles.count'], 'a verified bundle yields bundle metrics only -- never an execution or outcome claim');
  });

  it('(14) an Evidence Store that cannot be read makes the source unavailable, never satisfied', async () => {
    const world = await v2World();
    const failing = { ...world.evidenceStore, listByEvaluationId: async () => Promise.reject(new Error('disk')) } as EvidenceStore;
    const resolution = await resolve({ ...world.sources, evidenceStore: failing });
    assert.equal(resolution.status, 'unavailable');
    assert.deepEqual(resolution.acceptedEvidence, []);
  });

  it('(9, 10) classification keeps causes apart and never accepts an unclassified failure', () => {
    const base = { bundleId: 'b', valid: false, checks: { bundleDigest: true, verificationDigest: true, policyMatch: true, versionSupported: true, complete: true }, verifiedAt: T } as const;
    const rebuilt = { status: 'rebuilt', record: {} as GovernanceRecord, currentTrace: {} as never } as const;
    assert.deepEqual(classifyBundleVerification({ ...base, failures: [{ check: 'bundleDigest', message: 'x' }] }, undefined).codes, ['EVIDENCE_DIGEST_MISMATCH']);
    assert.deepEqual(classifyBundleVerification({ ...base, failures: [{ check: 'traceConsistent', message: 'x' }] }, { status: 'not-found' }).codes, ['EVIDENCE_SOURCE_UNAVAILABLE']);
    assert.deepEqual(classifyBundleVerification({ ...base, failures: [{ check: 'traceConsistent', message: 'x' }] }, rebuilt).codes, ['EVIDENCE_CONTRADICTORY']);
    assert.deepEqual(classifyBundleVerification({ ...base, failures: [{ check: 'sourceTraceVerified', message: 'x' }] }, rebuilt).codes, ['EVIDENCE_UNVERIFIED']);
    assert.deepEqual(classifyBundleVerification({ ...base, failures: [{ check: 'complete', message: 'x' }] }, undefined).codes, ['EVIDENCE_INCOMPLETE']);
    assert.deepEqual(classifyBundleVerification({ ...base, failures: [{ check: 'versionSupported', message: 'x' }] }, undefined).codes, ['EVIDENCE_VERSION_UNSUPPORTED']);
    assert.deepEqual(classifyBundleVerification({ ...base, failures: [{ check: 'somethingNew', message: 'x' }] }, undefined).codes, ['EVIDENCE_UNVERIFIED']);
    assert.deepEqual(classifyBundleVerification({ ...base, valid: true, failures: [] }, undefined).codes, []);
  });

  it('the Evidence Service and the resolver agree: same canonical sources, same verdict', async () => {
    const world = await v2World();
    const lookup = await rebuildEvidenceBundleCurrentTrace({ governance: governanceStore(world.canon) }, { system: false, organizationId: ORG }, world.bundle, () => T);
    assert.equal(lookup.status, 'rebuilt');
    const direct = verifyEvidenceBundle(world.bundle, { ...(lookup.status === 'rebuilt' ? { record: lookup.record, ...(lookup.currentTrace !== undefined ? { currentTrace: lookup.currentTrace } : {}) } : {}), now: () => T });
    assert.equal(direct.valid, true);
    assert.equal(direct.freshness, 'current');
  });
});

describe('ASSURE-SEC-01D -- rejected or inconclusive evidence never satisfies a control', () => {
  async function safRun(sources: AssuranceEvidenceSources) {
    const harness = buildAssuranceHarness({ framework: AOC_SAF_FRAMEWORK_V1, sources });
    const created = await harness.service.createAssessment(ASSURANCE_ORG, {
      subject: { subjectType: 'agent', subjectId: AGENT, organizationId: ORG },
      frameworkId: AOC_SAF_FRAMEWORK_ID,
      frameworkVersion: AOC_SAF_FRAMEWORK_VERSION,
      requestedBy: 'assessor-1',
      evidenceCutoffAt: ASSURANCE_CUTOFF,
    });
    const evaluated = await harness.service.evaluateAssessment(ASSURANCE_ORG, created.assessmentId);
    return new Map(evaluated.controlEvaluations.map((evaluation) => [evaluation.controlId, evaluation.status]));
  }

  it('(17, 18, 22) aoc.saf: a verified v2 bundle passes the bundle controls; the same bundle without its canonical trace leaves them unresolved -- not failed', async () => {
    const verified = await v2World();
    const passing = await safRun(verified.sources);
    assert.equal(passing.get('saf.evidence.bundles-present'), 'pass');
    assert.equal(passing.get('saf.evidence.bundles-verified'), 'pass');

    const unverifiable = await v2World();
    unverifiable.canon.records[0]!.governed = false;
    const unresolved = await safRun(unverifiable.sources);
    for (const controlId of ['saf.evidence.bundles-present', 'saf.evidence.bundles-verified']) {
      const status = unresolved.get(controlId);
      assert.notEqual(status, 'pass', controlId);
      assert.notEqual(status, 'fail', `${controlId}: an inconclusive verification is not a confirmed failure`);
    }
  });

  it('(17) a rejected bundle does not count toward a requirement', async () => {
    const world = await v2World();
    world.canon.records[0]!.governed = false;
    const resolution = await resolve(world.sources);
    assert.equal(resolution.status, 'unsatisfied');
    assert.equal(resolution.acceptedEvidence.length, 0);
    assert.equal(resolution.rejectedEvidence.length, 1);
  });

  it('(21) SEC-01C still holds next to Host evidence: a manual self-declared verification never counts as Host-verified', async () => {
    const attestation = buildAttestation('test.bool', true, { verified: true });
    assert.equal(isHostVerified(attestation), false);
  });

  it('(23) the rn.sv@0.1.0 and aoc.saf golden digests are unchanged', () => {
    assert.equal(computeDigest(RN_SV_FRAMEWORK_V0_1), 'sha256:e71fafe1a10af95514823e35d43138b1b93cdb72e37765200447a37748c13a58');
    assert.equal(computeDigest(AOC_SAF_FRAMEWORK_V1), 'sha256:4c0b5c65a0b8cfe40de726f26d80b80224fac6ca80fe2c221f7a734548899bb9');
  });
});
