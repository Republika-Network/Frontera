// Soberanía Enterprise v1 performance baseline (PR-008).
//
// Reproducible micro/meso benchmark of the Enterprise Host against real
// SQLite stores. Run AFTER `npm run build`:
//
//   node scripts/benchmark-enterprise.mjs            # full baseline
//   node scripts/benchmark-enterprise.mjs --quick    # reduced iterations (CI smoke)
//   node scripts/benchmark-enterprise.mjs --json     # machine-readable output only
//
// The benchmark uses the same seeded Kernel provider fixture the contract
// test suite uses (no mocks -- real Kernel, real stores) so results are
// deterministic in shape and independently reproducible. Latency numbers
// depend on hardware; record them together with the environment block this
// script prints. See docs/performance/BENCHMARK_BASELINE_V1.md.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, cpus, totalmem } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

const QUICK = process.argv.includes('--quick');
const JSON_ONLY = process.argv.includes('--json');
const N = QUICK ? 25 : 200;
const N_TENANTS = QUICK ? 10 : 50;

const { createEnterpriseServer, loadEnterpriseConfiguration, validateAssuranceFramework, AOC_SAF_FRAMEWORK_V1, buildAssuranceReport } = await import(
  '../dist/src/enterprise/index.js'
);
const { buildTestKernelProviders, buildAllowedRequestBody } = await import('../dist/src/enterprise/__tests__/support.js');

const workDir = mkdtempSync(join(tmpdir(), 'aoc-enterprise-bench-'));
const storeEnv = {
  AOC_ENTERPRISE_HTTP_PORT: '0',
  AOC_ENTERPRISE_HTTP_HOST: '127.0.0.1',
  AOC_ENTERPRISE_LOG_LEVEL: 'error',
  AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'sqlite',
  AOC_ENTERPRISE_SQLITE_PATH: join(workDir, 'governance.sqlite'),
  AOC_ENTERPRISE_PASSPORT_SQLITE_PATH: join(workDir, 'passport.sqlite'),
  AOC_ENTERPRISE_ASSURANCE_SQLITE_PATH: join(workDir, 'assurance.sqlite'),
  // ASSURE-SEC-01B: the benchmark reviewer is scoped to the organization this instance serves.
  AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID: 'bench-org-0',
};

// ASSURE-SEC-01B: manual reviews are recorded only by an authenticated Assurance reviewer credential (benchmark-only secret).
const BENCH_REVIEWER_SECRET = 'bench-only-assurance-reviewer-secret-0000000';
function benchConfiguration() {
  const loaded = loadEnterpriseConfiguration(storeEnv);
  return {
    ...loaded,
    authentication: {
      ...loaded.authentication,
      assuranceReviewers: [{ reviewerId: 'bench-reviewer', organizationId: 'bench-org-0', roles: ['assurance-reviewer'], key: BENCH_REVIEWER_SECRET }],
    },
  };
}

function stats(samplesMs) {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const pick = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const mean = sum / sorted.length;
  const variance = sorted.reduce((acc, v) => acc + (v - mean) ** 2, 0) / sorted.length;
  // Tukey fence: samples beyond q3 + 1.5*IQR are reported (never discarded --
  // outliers stay in every aggregate; the count just makes tails visible).
  const q1 = pick(0.25);
  const q3 = pick(0.75);
  const upperFence = q3 + 1.5 * (q3 - q1);
  return {
    n: sorted.length,
    meanMs: round(mean),
    stdDevMs: round(Math.sqrt(variance)),
    p50Ms: round(pick(0.5)),
    p95Ms: round(pick(0.95)),
    maxMs: round(sorted[sorted.length - 1]),
    outliersAboveTukeyFence: sorted.filter((v) => v > upperFence).length,
    opsPerSec: round(1000 / mean),
  };
}

const round = (v) => Math.round(v * 1000) / 1000;

// Cyclic array access that also accepts the negative warm-up indexes.
const at = (array, i) => array[((i % array.length) + array.length) % array.length];

async function timed(fn) {
  const start = performance.now();
  const result = await fn();
  return { ms: performance.now() - start, result };
}

// Each scenario runs WARMUP unrecorded iterations first (JIT, prepared-statement
// and page-cache warm-up), then `count` recorded iterations. Warm-up calls use
// negative indexes so id-generating callers produce distinct, non-colliding ids.
const WARMUP = QUICK ? 3 : 10;

async function series(count, fn, { warmup = WARMUP } = {}) {
  for (let i = 0; i < warmup; i += 1) {
    await fn(-1 - i);
  }
  const samples = [];
  let last;
  for (let i = 0; i < count; i += 1) {
    const { ms, result } = await timed(() => fn(i));
    samples.push(ms);
    last = result;
  }
  return { samples, last };
}

async function requestJson(baseUrl, method, path, body, headers = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const parsed = await response.json();
  if (response.status >= 400) {
    throw new Error(`${method} ${path} -> ${response.status}: ${JSON.stringify(parsed).slice(0, 300)}`);
  }
  return parsed;
}

const results = {};
const environment = {
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  cpus: cpus().length,
  cpuModel: cpus()[0]?.model ?? 'unknown',
  totalMemGiB: round(totalmem() / 1024 ** 3),
  quick: QUICK,
  iterations: N,
  warmupIterationsPerScenario: QUICK ? 3 : 10,
};

// -- cold start (fresh SQLite files) ----------------------------------------
const coldStart = await timed(async () => {
  const server = await createEnterpriseServer({
    kernelProviders: buildTestKernelProviders(),
    configuration: benchConfiguration(),
  });
  await server.listen();
  return server;
});
results.coldStartMs = round(coldStart.ms);
let server = coldStart.result;
await server.close();

// -- warm start (existing SQLite files, schema already initialized) ---------
const warmStart = await timed(async () => {
  const reopened = await createEnterpriseServer({
    kernelProviders: buildTestKernelProviders(),
    configuration: benchConfiguration(),
  });
  const listenAddress = await reopened.listen();
  return { server: reopened, address: listenAddress };
});
results.warmStartMs = round(warmStart.ms);
server = warmStart.result.server;
const baseUrl = `http://127.0.0.1:${warmStart.result.address.port}`;
const enterprise = server.enterprise;

// -- governance evaluation (Kernel + atomic Governance Store append) --------
const evaluationIds = [];
{
  const { samples } = await series(N, async (i) => {
    const body = buildAllowedRequestBody({ requestId: `bench-req-${i}`, correlationId: `bench-corr-${i}` });
    const response = await requestJson(baseUrl, 'POST', '/api/governance/evaluate', body);
    evaluationIds.push(response.governanceRecord.evaluationId);
    return response;
  });
  results.governanceEvaluate = stats(samples);
}

// -- governance record read + independent verification ----------------------
{
  const { samples } = await series(N, (i) => requestJson(baseUrl, 'GET', `/api/governance/evaluations/${at(evaluationIds, i)}`));
  results.governanceRead = stats(samples);
}
{
  const { samples } = await series(N, (i) => requestJson(baseUrl, 'GET', `/api/governance/evaluations/${at(evaluationIds, i)}/verify`));
  results.governanceVerify = stats(samples);
}

// -- evidence bundle projection + verification -------------------------------
const bundleIds = [];
{
  const { samples } = await series(N, async (i) => {
    const response = await requestJson(baseUrl, 'POST', '/api/evidence/build', {
      evaluationId: at(evaluationIds, i),
      level: 'AUDITOR',
      createdBy: 'bench',
    });
    bundleIds.push(response.bundle.bundleId);
    return response;
  });
  results.evidenceBuild = stats(samples);
}
{
  const { samples } = await series(N, (i) => requestJson(baseUrl, 'POST', '/api/evidence/verify', { bundleId: at(bundleIds, i) }));
  results.evidenceVerify = stats(samples);
}

// -- large evidence payload evaluation (bounded by the store request cap) ----
{
  const largeEvidence = Array.from({ length: 150 }, (_, i) => ({ type: 'document', reference: `bench-doc-${i}`, description: `benchmark evidence item ${i}` }));
  const { samples } = await series(QUICK ? 10 : 50, async (i) => {
    const body = buildAllowedRequestBody({ requestId: `bench-large-${i}` });
    body.context = { ...body.context, evidence: largeEvidence };
    return requestJson(baseUrl, 'POST', '/api/governance/evaluate', body);
  });
  results.governanceEvaluateLargeEvidence = stats(samples);
}

// -- assurance: assessment creation across many tenants ----------------------
const assessments = [];
{
  const { samples } = await series(N, async (i) => {
    const organizationId = `bench-org-${Math.abs(i) % N_TENANTS}`;
    const created = await requestJson(baseUrl, 'POST', '/api/assurance/assessments', {
      subject: { subjectId: `bench-subject-${i}`, subjectType: 'organization', organizationId },
      frameworkId: 'aoc.saf',
      frameworkVersion: '1.0.0',
      requestedBy: 'bench',
    });
    assessments.push({ assessmentId: created.assessmentId, organizationId });
    return created;
  });
  results.assuranceCreateAssessment = stats(samples);
  results.assuranceTenantCount = N_TENANTS;
}

// -- assurance: full evaluation (evidence resolution + controls + scoring) ---
{
  const evalCount = QUICK ? 10 : 50;
  // One-shot per assessment (evaluation mutates state); warm-up disabled.
  const { samples } = await series(evalCount, (i) =>
    requestJson(baseUrl, 'POST', `/api/assurance/assessments/${assessments[i].assessmentId}/evaluate`, {}),
    { warmup: 0 },
  );
  results.assuranceEvaluate = stats(samples);
}

// -- assurance: independent verification (digest + score recomputation) ------
{
  const verifyCount = QUICK ? 10 : 50;
  const { samples } = await series(verifyCount, async (i) => {
    const response = await fetch(`${baseUrl}/api/assurance/assessments/${at(assessments, i).assessmentId}/verify`, { method: 'POST' });
    await response.json();
    return response;
  });
  results.assuranceVerify = stats(samples);
}

// -- assurance: manual review workflow + completion (report input) -----------
{
  const context = { system: true };
  const first = await enterprise.assurance.getAssessment(context, assessments[0].assessmentId);
  if (first.status === 'manual_review') {
    const reviewControls = first.controlEvaluations.filter((evaluation) => evaluation.status === 'manual_review_required').map((evaluation) => evaluation.controlId);
    const controlsById = new Map(AOC_SAF_FRAMEWORK_V1.controls.map((control) => [control.controlId, control]));
    for (const controlId of reviewControls) {
      const control = controlsById.get(controlId);
      const requiredRole = control?.criteria?.requiredReviewerRole;
      await requestJson(baseUrl, 'POST', '/api/assurance/manual-reviews', {
        assessmentId: assessments[0].assessmentId,
        controlId,
        reviewerId: 'bench-reviewer',
        outcome: 'pass',
        rationale: 'Benchmark manual review.',
        evidenceReferenceIds: ['bench-review-evidence-1'],
        ...(requiredRole !== undefined ? { reviewerRole: requiredRole } : {}),
      }, { authorization: `Bearer ${BENCH_REVIEWER_SECRET}` });
    }
    await requestJson(baseUrl, 'POST', `/api/assurance/assessments/${assessments[0].assessmentId}/evaluate`, { complete: true });
  }
}

// -- assurance: findings load (large finding sets from unknown evidence) -----
{
  const { samples, last } = await series(QUICK ? 10 : 50, () => requestJson(baseUrl, 'GET', `/api/assurance/assessments/${assessments[0].assessmentId}/findings`));
  results.assuranceListFindings = stats(samples);
  results.assuranceFindingsPerAssessment = last.findings.length;
}

// -- assurance: report projection (in-process, deterministic projector) ------
{
  const context = { system: true };
  const completed = await enterprise.assurance.getAssessment(context, assessments[0].assessmentId);
  let reportCounter = 0;
  const { samples } = await series(N, () =>
    buildAssuranceReport({
      assessment: completed,
      framework: AOC_SAF_FRAMEWORK_V1,
      view: 'AUDITOR',
      generatedBy: 'bench',
      now: () => '2026-01-01T00:00:00.000Z',
      nextId: (prefix) => `${prefix}-${(reportCounter += 1)}`,
    }),
  );
  results.assuranceReportProjection = stats(samples);
}

// -- assurance: signal processing --------------------------------------------
{
  const { samples } = await series(N, (i) =>
    requestJson(baseUrl, 'POST', '/api/assurance/signals', {
      subjectId: `bench-subject-${Math.abs(i) % N}`,
      subjectType: 'organization',
      organizationId: at(assessments, i).organizationId,
      signalType: 'control_evidence_expired',
      sourceType: 'enterprise_health',
      sourceId: `bench-source-${i}`, // negative warm-up indexes keep ids distinct
      occurredAt: '2026-01-01T00:00:00.000Z',
      details: { reference: `bench-signal-${i}` },
    }),
  );
  results.assuranceSignal = stats(samples);
}

// -- framework validation (framework loading cost) ---------------------------
{
  const { samples } = await series(N, () => validateAssuranceFramework(AOC_SAF_FRAMEWORK_V1));
  results.frameworkValidation = stats(samples);
}

results.memory = {
  rssMiB: round(process.memoryUsage().rss / 1024 ** 2),
  heapUsedMiB: round(process.memoryUsage().heapUsed / 1024 ** 2),
};

await server.close();
rmSync(workDir, { recursive: true, force: true });

const output = { environment, results };
if (JSON_ONLY) {
  console.log(JSON.stringify(output, null, 2));
} else {
  console.log('Soberanía Enterprise v1 benchmark baseline');
  console.log(JSON.stringify(environment, null, 2));
  console.log('');
  const rows = Object.entries(results).filter(([, v]) => v !== null && typeof v === 'object' && 'p50Ms' in v);
  console.log('| scenario | n | mean ms | stddev ms | p50 ms | p95 ms | max ms | outliers>Tukey | ops/s |');
  console.log('|---|---|---|---|---|---|---|---|---|');
  for (const [name, s] of rows) {
    console.log(`| ${name} | ${s.n} | ${s.meanMs} | ${s.stdDevMs} | ${s.p50Ms} | ${s.p95Ms} | ${s.maxMs} | ${s.outliersAboveTukeyFence} | ${s.opsPerSec} |`);
  }
  console.log('');
  console.log(`coldStartMs=${results.coldStartMs} warmStartMs=${results.warmStartMs}`);
  console.log(`findingsPerAssessment=${results.assuranceFindingsPerAssessment} tenants=${results.assuranceTenantCount}`);
  console.log(`rssMiB=${results.memory.rssMiB} heapUsedMiB=${results.memory.heapUsedMiB}`);
}
