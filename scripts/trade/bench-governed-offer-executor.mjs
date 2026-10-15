// TRADE-04C — diagnostic benchmark of the governed delegated OfferCreate executor.
// OFFLINE: the XRPL ledger is the labelled fake (`FakeXrplLedger`), the signer is the loopback reference,
// the CORE-07 witness is the loopback reference witness. No XRPL server, no ledger write, no network beyond 127.0.0.1.
// Run after `npm run build`:
//
//   node scripts/trade/bench-governed-offer-executor.mjs [--iterations 60] [--host-iterations 30]
//
// What it measures, separately (never conflated):
//   1. The executor, unit level (real executor, real anchored SQLite interlock, real TRADE-04B client over HTTP):
//      per stage — grant binding, validated ledger reference + quarantine, delegation re-read, account roots
//      (key authority + owner Sequence), blocking (incl. the witness probe), protected signing (incl. the
//      client's verification), durable reservation (SQLite + witness prepare/finalize), reserved submission
//      (incl. the durable claim + witness), finality reads, and the executor total.
//   2. The interlock alone: reserve and claim (each one anchored CORE-07 transition), median/p95/p99.
//   3. The shipped Host, end to end: TRADE-03 admission + POST /api/governed-actions (envelope, Kernel with the
//      CORE-04 trade provider and its risk assessment, policy, CORE-05, emergency, P10 grant, P7, P11 claim,
//      evidence persistence) + the executor; the governed-path overhead is the total minus the executor's.
//
// Fake-ledger latency is NOT XRPL network latency or throughput: ledger close (~3–5 s), validation and
// network round trips are absent. Nothing here supports an HFT-readiness claim. TRADE-03's
// one-pending-binding-per-(principal, owner) admission bounds order flow independently.
import { performance } from 'node:perf_hooks';

import { closeAllWitnesses, closeDeploymentWitnesses } from '../../dist/src/enterprise/__tests__/core07-freshness-fixture.js';
import { executorRig, rawProposal, validatedAction } from '../../dist/src/enterprise/__tests__/trade04c-execution-fixture.js';
import { Workspace, bootTradeHost, governTrade, proposalFor } from '../../dist/src/enterprise/__tests__/trade04c-host-fixture.js';

const argument = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? fallback : Number.parseInt(process.argv[index + 1] ?? '', 10);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`--${name} must be a positive integer`);
  return value;
};
const ITERATIONS = argument('iterations', 60);
const HOST_ITERATIONS = argument('host-iterations', 30);

function summary(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
  const fmt = (value) => Number(value.toFixed(2));
  return { n: sorted.length, median: fmt(at(0.5)), p95: sorted.length >= 20 ? fmt(at(0.95)) : null, p99: sorted.length >= 100 ? fmt(at(0.99)) : null, max: fmt(sorted.at(-1)) };
}

const report = { environment: { node: process.version, platform: process.platform, ledger: 'FAKE (offline)', note: 'single process; WSL /mnt/c when run there' } };

// ── 1. Executor stages ────────────────────────────────────────────────────────
{
  const rig = await executorRig({});
  try {
    for (let warm = 0; warm < 3; warm += 1) {
      const raw = rawProposal(rig.pairs[0]);
      rig.book.attest(raw);
      await rig.adapter.execute(validatedAction(raw));
    }
    rig.traces.length = 0;
    for (let index = 0; index < ITERATIONS; index += 1) {
      const raw = rawProposal(rig.pairs[0]);
      rig.book.attest(raw);
      const result = await rig.adapter.execute(validatedAction(raw));
      if (result.outcome !== 'completed') throw new Error(`unexpected outcome ${JSON.stringify(result)}`);
    }
    const stages = {};
    for (const trace of rig.traces) for (const [stage, ms] of Object.entries(trace.timings)) (stages[stage] ??= []).push(ms);
    report.executor = Object.fromEntries(Object.entries(stages).map(([stage, samples]) => [stage, summary(samples)]));
    report.executor.ordersPerSecondSequential = Number((1000 / summary(stages.total).median).toFixed(1));
  } finally {
    await rig.close();
  }
}

// ── 2. The interlock alone ───────────────────────────────────────────────────
{
  const rig = await executorRig({});
  try {
    const reserve = [];
    const claim = [];
    const owner = rig.pairs[0].owner;
    for (let index = 0; index < ITERATIONS; index += 1) {
      const executionId = `aoc.exec:bench-${index}`;
      const hash = (index + 1).toString(16).toUpperCase().padStart(64, 'C');
      const record = {
        executionId,
        account: owner,
        sequence: 1000 + index,
        lastLedgerSequence: 520,
        minLedger: 501,
        transactionHash: hash,
        evidence: { organizationId: 'org-acme', subject: 'a', requestId: 'r', decisionId: 'd', boundedGrantId: 'g', proposalDigest: `sha256:${'a'.repeat(64)}`, delegateAccount: rig.pairs[0].delegate.address, signerId: 's', signerRequestId: 'f'.repeat(64), signingPublicKey: `ED${'1'.repeat(64)}`, keyAuthority: 'master-key', preparedDigest: `sha256:${'b'.repeat(64)}`, delegationAssessmentDigest: `sha256:${'c'.repeat(64)}`, delegationFactsDigest: `sha256:${'d'.repeat(64)}`, referenceLedgerIndex: 500, referenceLedgerHash: 'E'.repeat(64), delegationLedgerIndex: 500, delegateRootLedgerIndex: 500, ownerRootLedgerIndex: 500, fee: '12', ledgerProvenance: 'injected-ledger-client' },
      };
      let start = performance.now();
      await rig.interlock.reserve(record, 500);
      reserve.push(performance.now() - start);
      start = performance.now();
      await rig.interlock.claimSubmission({ executionId, networkId: 1, transactionHash: hash, transactionType: 'OfferCreate', account: owner, sequence: record.sequence, lastLedgerSequence: 520 });
      claim.push(performance.now() - start);
    }
    report.interlock = { reserveAnchored: summary(reserve), claimAnchored: summary(claim) };
  } finally {
    await rig.close();
  }
}

// ── 3. The shipped Host, end to end ──────────────────────────────────────────
{
  const workspace = new Workspace();
  const trade = await bootTradeHost(workspace);
  try {
    for (let warm = 0; warm < 2; warm += 1) await governTrade(trade, proposalFor(trade, '10'));
    trade.traces.length = 0;
    const total = [];
    for (let index = 0; index < HOST_ITERATIONS; index += 1) {
      const start = performance.now();
      const reply = await governTrade(trade, proposalFor(trade, '10'));
      total.push(performance.now() - start);
      if (reply.body.status !== "executed") throw new Error(`unexpected reply ${reply.text} ${JSON.stringify((trade.assessments.at(-1)?.controls ?? []).filter((c) => c.outcome !== "SATISFIED"))} ${JSON.stringify(trade.assessments.at(-1)?.outcome)}`);
    }
    const executor = trade.traces.map((trace) => trace.timings.total);
    report.host = { endToEnd: summary(total), executorTotal: summary(executor), governedPathOverhead: summary(total.map((value, index) => value - (executor[index] ?? 0))) };
  } finally {
    await trade.signer.close();
    workspace.cleanup();
  }
}

await closeAllWitnesses();
await closeDeploymentWitnesses();
console.log(JSON.stringify(report, null, 2));
process.exit(0);
