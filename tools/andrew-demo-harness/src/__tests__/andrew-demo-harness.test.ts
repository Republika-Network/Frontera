import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { createSqliteXrplAttemptStore } from '@aoc-enterprise/xrpl-testnet-transport';

import type { DemoSummary } from '../contracts.js';
import { runAndrewDemo, type RunAndrewDemoResult } from '../demo.js';
import { DEMO_IDENTITY } from '../run-infrastructure.js';
import { fixture, type Fixture } from './scripted-ledger.js';

/**
 * ANDREW-P0-11 — the one-command demo harness, end to end, over the real
 * Andrew composition, the real P0-08 transport package and a scripted XRPL
 * Testnet. Covers the 20 harness requirements of the P0-11 brief.
 */

const SEED_SHAPE = /\bs[1-9A-HJ-NP-Za-km-z]{28,30}\b/;
const BLOB_SHAPE = /\b[0-9A-Fa-f]{200,}\b/;

interface Run {
  readonly result: RunAndrewDemoResult;
  readonly output: string;
  readonly fixture: Fixture;
}

const fixtures: Fixture[] = [];
after(() => {
  for (const entry of fixtures) entry.cleanup();
});

async function run(f: Fixture, extra: Partial<Parameters<typeof runAndrewDemo>[0]> = {}): Promise<Run> {
  fixtures.push(f);
  const lines: string[] = [];
  const result = await runAndrewDemo({ environment: f.environment, ports: f.ports, write: (line) => lines.push(line), ...extra });
  return { result, output: lines.join('\n'), fixture: f };
}

const runsOf = (f: Fixture): readonly string[] => (existsSync(join(f.environment['FRONTERA_ANDREW_STATE_ROOT'] ?? '', 'runs')) ? readdirSync(join(f.environment['FRONTERA_ANDREW_STATE_ROOT'] ?? '', 'runs')) : []);
const demoResultBlock = (output: string): string => output.slice(output.lastIndexOf('DEMO RESULT'));

function assertNotReady(r: Run, reason: RegExp): void {
  assert.equal(r.result.verdict, 'NOT READY', r.output);
  assert.equal(r.result.exitCode, 2);
  assert.match(r.output, reason);
  assert.match(r.output, /PREFLIGHT NOT READY/);
  assert.doesNotMatch(r.output, /SCENARIO A/, 'Scenario A was not started');
  assert.deepEqual(runsOf(r.fixture), [], 'no run state was created');
  assert.equal(r.fixture.ledger.counts.transportConnects + r.fixture.ledger.counts.submits, 0, 'no transport activity');
}

describe('ANDREW-P0-11 — preflight refuses, before any governed action', () => {
  it('1. refuses a Mainnet endpoint', async () => {
    assertNotReady(await run(fixture({ environment: { FRONTERA_XRPL_TESTNET_ENDPOINT: 'wss://s1.ripple.com/' } })), /Mainnet server — this demo is XRPL Testnet only/);
  });
  it('2. refuses a server that does not report the Testnet network id', async () => {
    assertNotReady(await run(fixture({ ledger: { networkId: 0 } })), /reports network_id 0, not XRPL Testnet \(1\)/);
  });
  it('3. refuses an insufficient treasury Test RLUSD balance, with a funding instruction and no refill', async () => {
    const r = await run(fixture({ ledger: { treasuryRlusd: '5' } }));
    assertNotReady(r, /FUNDING REQUIRED — the demo never refills, resets or faucets the fixture/);
    assert.match(r.output, /holds 5 RLUSD; 10 is required/);
  });
  it('4. refuses a missing RLUSD trust line', async () => {
    assertNotReady(await run(fixture({ ledger: { recipientTrustLine: false } })), /the recipient has no RLUSD trust line/);
  });
  it('5. refuses an unresolved attempt from an earlier run of this demo; ignores other treasuries', async () => {
    const f = fixture();
    const priorRun = join(f.environment['FRONTERA_ANDREW_STATE_ROOT'] ?? '', 'runs', 'andrew-prior');
    mkdirSync(priorRun, { recursive: true });
    writeFileSync(join(priorRun, 'run.json'), JSON.stringify({ schema: 'frontera.andrew-demo.run.v1', runId: 'andrew-prior', demoIdentity: DEMO_IDENTITY, network: 'xrpl-testnet', networkId: 1, treasury: f.treasury.classicAddress, recipient: f.recipient.classicAddress, startedAt: new Date().toISOString() }));
    const store = createSqliteXrplAttemptStore(join(priorRun, 'xrpl-attempts.sqlite'));
    store.record({ executionId: 'aoc.exec:prior', requestId: 'aoc.gar:prior', decisionId: 'd', network: 'xrpl-testnet', sourceAccount: f.treasury.classicAddress, destination: f.recipient.classicAddress, currency: 'RLUSD', issuer: 'i', value: '10', fee: '12', sequence: 1, lastLedgerSequence: 2, transactionHash: 'AB'.repeat(32), validatedLedgerAtPrepare: 1, notAfter: new Date().toISOString(), createdAt: new Date().toISOString() }, 'blob');
    store.append('aoc.exec:prior', 'submit-uncertain');
    store.close();
    const blocked = await run(f);
    assert.equal(blocked.result.verdict, 'NOT READY');
    assert.match(blocked.output, /XRPL attempt aoc\.exec:prior .* is 'submit-uncertain' — reconcile it on the ledger/);
    assert.deepEqual(runsOf(f), ['andrew-prior']);

    // The same unresolved attempt under another treasury does not block this demo.
    const other = fixture();
    const otherRun = join(other.environment['FRONTERA_ANDREW_STATE_ROOT'] ?? '', 'runs', 'andrew-other');
    mkdirSync(otherRun, { recursive: true });
    writeFileSync(join(otherRun, 'run.json'), JSON.stringify({ schema: 'frontera.andrew-demo.run.v1', runId: 'andrew-other', demoIdentity: DEMO_IDENTITY, network: 'xrpl-testnet', networkId: 1, treasury: f.treasury.classicAddress, recipient: f.recipient.classicAddress, startedAt: new Date().toISOString() }));
    const ready = await run(other, { preflightOnly: true });
    assert.equal(ready.result.verdict, 'READY', ready.output);
  });
  it('refuses a secrets file readable by others, without reading it', async () => {
    assertNotReady(await run(fixture({ secretsMode: 0o644 })), /must be readable by its owner only \(chmod 600\)/);
  });
  it('refuses a seed that does not belong to the configured treasury', async () => {
    const r = await run(fixture({ secrets: (treasury, recipient) => `FRONTERA_XRPL_TESTNET_TREASURY_SEED=${String(recipient.seed)}\nFRONTERA_XRPL_TESTNET_TREASURY_ADDRESS=${treasury.classicAddress}\nFRONTERA_XRPL_TESTNET_RECIPIENT_ADDRESS=${recipient.classicAddress}\n` }));
    assertNotReady(r, /treasury signing seed in the secrets file does not belong/);
  });
});

describe('ANDREW-P0-11 — the complete demo, one run', () => {
  let r: Run;
  let summary: DemoSummary;
  before(async () => {
    r = await run(fixture());
    summary = JSON.parse(readFileSync(r.result.summaryPath ?? '', 'utf8')) as DemoSummary;
  });
  const a = () => summary.scenarioA ?? {};
  const b = () => summary.scenarioB ?? {};
  const step = (name: string) => summary.checkpoints.find((entry) => entry.step === name);

  it('passes overall, exits 0, prints DEMO RESULT: PASS once', () => {
    assert.equal(r.result.verdict, 'PASS', r.output);
    assert.equal(r.result.exitCode, 0);
    assert.equal(summary.finalVerdict, 'PASS');
    assert.match(demoResultBlock(r.output), /^DEMO RESULT\n-+\nPASS\n/m);
    assert.equal(r.output.match(/\nPASS\n/g)?.length, 1);
  });
  it('8. the first denial is an expected PASS, with zero grants, signatures and submissions', () => {
    assert.equal(step('A2')?.result, 'EXPECTED GOVERNANCE DENIAL');
    assert.equal(a()['originalStatus'], 'denied');
    assert.ok((a()['originalReasonCodes'] as readonly string[]).includes('DOMAIN_POLICY_DENIED'));
    assert.match(r.output, /RESULT: BLOCKED — expected: the destination is not approved/);
  });
  it('9. the exact replay returns the stored decision and creates nothing', () => {
    assert.equal(step('A3')?.result, 'PASS');
    assert.deepEqual(a()['replay'], { requestId: a()['originalRequestId'], decisionId: a()['originalDecisionId'], sameDecision: true });
    assert.match(r.output, /NO RE-EVALUATION \/ NO NEW EXECUTION/);
  });
  it('10. approval alone creates no execution', () => {
    assert.equal(step('A4')?.result, 'PASS');
    assert.match(String(step('A4')?.detail), /0 grants, 0 signatures, 0 submissions/);
    const approval = a()['approvalEvidence'] as Record<string, unknown>;
    assert.match(String(approval['authorityBasis']), /destination\.approve.*organization-administrator/);
  });
  it('11. the linked reconsideration creates exactly one grant, one signature, one submission, validated', () => {
    assert.equal(r.fixture.ledger.counts.submits, 1);
    assert.equal(r.fixture.ledger.blobs.length, 1);
    assert.deepEqual(a()['counters'], { grants: 1, connections: (a()['counters'] as Record<string, number>)['connections'], signatures: 1, submissions: 1, attempts: 1 });
    assert.equal(a()['engineResult'], 'tesSUCCESS');
    assert.equal(a()['assureFinalState'], 'executed-confirmed-completed');
    assert.equal(a()['assureVerified'], true);
    assert.notEqual(a()['reconsiderationRequestId'], a()['originalRequestId']);
  });
  it('12. the second reconsideration is refused as already realized, creating nothing', () => {
    assert.equal(step('A9')?.result, 'EXPECTED DUPLICATE REFUSAL');
    assert.deepEqual((a()['secondReconsideration'] as Record<string, unknown>)['reasonCodes'], ['GOVERNED_ACTION_RECONSIDERATION_ALREADY_REALIZED']);
  });
  it('13. the original historical denial remains', () => {
    assert.deepEqual(a()['historicalReplay'], { status: 'denied', decisionId: a()['originalDecisionId'], unchanged: true });
  });
  it('14. Scenario B: the ceiling withholding is an expected PASS — 0 grants, connections, signatures, submissions, attempt rows', () => {
    assert.equal(step('B')?.result, 'EXPECTED AUTHORITY WITHHOLDING');
    assert.equal(b()['decisionStatus'], 'allowed');
    assert.equal(b()['withheldBy'], 'authority-binding');
    assert.equal(b()['reasonCode'], 'FINANCIAL_AUTHORITY_CEILING_EXCEEDED');
    assert.deepEqual(b()['requestedAmount'], { value: '125000', unit: 'USD' });
    assert.deepEqual(b()['authorityCeiling'], { value: '100000', unit: 'USD' });
    for (const field of ['grantCount', 'connectionCount', 'signatureCount', 'submissionCount', 'attemptRowCount']) assert.equal(b()[field], 0, field);
    assert.equal(b()['transactionHash'], null);
    assert.equal(b()['assureVerified'], true);
    assert.equal(b()['assureFinalState'], 'not-executed');
  });
  it('18. the summary matches the canonical runtime records', () => {
    const runDirectory = join(r.fixture.environment['FRONTERA_ANDREW_STATE_ROOT'] ?? '', 'runs', summary.runId);
    const store = createSqliteXrplAttemptStore(join(runDirectory, 'xrpl-attempts.sqlite'));
    try {
      const record = store.find(String(a()['executionId']));
      assert.equal(record?.attempt.transactionHash, a()['transactionHash']);
      assert.equal(record?.state, 'validated-success');
    } finally {
      store.close();
    }
    const grantsDb = new Database(join(runDirectory, 'host', 'bounded-grants.sqlite'), { readonly: true });
    try {
      assert.deepEqual((grantsDb.prepare('SELECT grant_id FROM bounded_grants').all() as { readonly grant_id: string }[]).map((row) => row.grant_id), [a()['grantId']]);
    } finally {
      grantsDb.close();
    }
    const governance = new Database(join(runDirectory, 'host', 'governance.sqlite'), { readonly: true });
    try {
      const row = governance.prepare("SELECT reference_id AS referenceId, external_version AS externalVersion, uri, created_at AS createdAt FROM governance_references WHERE reference_type = 'issuance_record' AND external_id = ?").get(b()['requestId']);
      assert.deepEqual(row, b()['issuanceRecord']);
      assert.match(String((row as Record<string, string>)['uri']), /requested=USD:125000;ceiling=USD:100000$/);
    } finally {
      governance.close();
    }
    assert.equal(summary.amounts.testnetTransfer.value, '10');
    assert.equal(summary.amounts.productionMotivatingExample.value, '75000');
    const keys = JSON.parse(readFileSync(summary.verificationMaterial?.authorityVerificationKeysFile ?? '', 'utf8')) as readonly Record<string, string>[];
    assert.equal(keys[0]?.['keyId'], summary.verificationMaterial?.authorityKeyId);
    assert.match(String(keys[0]?.['publicKeyPem']), /BEGIN PUBLIC KEY/);
    assert.ok(existsSync(r.result.reportPath ?? ''));
  });
  it('6, 7, 19. no seed, signed blob or secret-shaped material in the terminal, the summary, the report or the evidence files', () => {
    const runDirectory = join(r.fixture.environment['FRONTERA_ANDREW_STATE_ROOT'] ?? '', 'runs', summary.runId);
    const texts = [r.output, readFileSync(r.result.summaryPath ?? '', 'utf8'), readFileSync(r.result.reportPath ?? '', 'utf8'), ...readdirSync(join(runDirectory, 'evidence')).map((file) => readFileSync(join(runDirectory, 'evidence', file), 'utf8'))];
    const secrets = [String(r.fixture.treasury.seed), String(r.fixture.recipient.seed), r.fixture.treasury.privateKey, r.fixture.recipient.privateKey, ...r.fixture.ledger.blobs];
    assert.ok(r.fixture.ledger.blobs.length === 1 && r.fixture.ledger.blobs[0]!.length > 200, 'a real signed blob existed during the run');
    for (const text of texts) {
      for (const secret of secrets) assert.equal(text.includes(secret), false, 'secret material leaked');
      assert.doesNotMatch(text, SEED_SHAPE);
      assert.doesNotMatch(text, BLOB_SHAPE);
      assert.doesNotMatch(text, /PRIVATE KEY/);
    }
  });
  it('the terminal distinguishes governed, Testnet and illustrative amounts — 75,000 and 125,000 never as moved', () => {
    assert.match(r.output, /Testnet transfer\.+ 10 Test RLUSD on XRPL Testnet — no real-world value/);
    assert.match(r.output, /Production example\.+ USD 75,000 \(Andrew\/LUMX\) — motivating scenario only, never sent/);
    assert.match(r.output, /Requested\.+ USD 125,000 \(governed amount — nothing is sent\)/);
    assert.doesNotMatch(r.output, /Delivered\.+ (75|125)/);
  });
});

describe('ANDREW-P0-11 — the harness fails closed and never prints PASS after a failure', () => {
  const assertFailed = (r: Run, category: string, pattern: RegExp) => {
    assert.equal(r.result.verdict, 'FAIL', r.output);
    assert.equal(r.result.exitCode, 1);
    assert.match(demoResultBlock(r.output), new RegExp(`FAIL — ${category}`));
    assert.match(r.output, pattern);
    assert.doesNotMatch(demoResultBlock(r.output), /^PASS$/m);
    const summary = JSON.parse(readFileSync(r.result.summaryPath ?? '', 'utf8')) as DemoSummary;
    assert.equal(summary.finalVerdict, 'FAIL');
    assert.equal(summary.failure?.category, category);
  };

  it('15. an unexpected grant during Scenario B fails the harness', async () => {
    const r = await run(fixture(), {
      observer: (step, context) => {
        if (step !== 'B:after-request') return;
        const db = new Database(join(context.hostDirectory, 'bounded-grants.sqlite'));
        try {
          db.prepare("INSERT INTO bounded_grants SELECT 'aoc.grant:planted', grant_json, grant_digest, revocation_digest, committed_at, schema_version, signature_algorithm, signing_key_id, signature, signature_version FROM bounded_grants LIMIT 1").run();
        } finally {
          db.close();
        }
      },
    });
    assertFailed(r, 'UNEXPECTED DEMO ASSERTION FAILURE', /B: unexpected grant/);
  });
  it('16. unexpected XRPL activity during Scenario B fails the harness', async () => {
    const f = fixture();
    const r = await run(f, {
      observer: (step) => {
        if (step === 'B:after-request') {
          f.activityOffset.connections += 1;
          f.activityOffset.submissions += 1;
        }
      },
    });
    assertFailed(r, 'UNEXPECTED DEMO ASSERTION FAILURE', /B: unexpected XRPL activity/);
  });
  it('17. an evidence verification failure fails the harness', async () => {
    const r = await run(fixture(), {
      observer: (step, context) => {
        if (step !== 'A7' || context.evaluationId === undefined) return;
        const db = new Database(join(context.hostDirectory, 'governance.sqlite'));
        try {
          db.prepare("UPDATE governance_references SET external_version = 'tampered' WHERE evaluation_id = ? AND reference_type = 'execution_record'").run(context.evaluationId);
        } finally {
          db.close();
        }
      },
    });
    assertFailed(r, 'EVIDENCE VERIFICATION FAILURE', /does not verify/);
  });
  it('20. an interrupted run is a failed run — never PASS', async () => {
    let approved = false;
    const r = await run(fixture(), {
      observer: (step) => {
        if (step === 'A4') approved = true;
      },
      isInterrupted: () => approved,
    });
    assertFailed(r, 'UNEXPECTED DEMO ASSERTION FAILURE', /interrupted after A4/);
    assert.equal(r.fixture.ledger.counts.submits, 0, 'nothing was paid after the interruption');
  });
  it('a validated tec result is an XRPL validation failure', async () => {
    const r = await run(fixture({ ledger: { engineResult: 'tecPATH_DRY' } }));
    assert.equal(r.result.exitCode, 1);
    assert.match(demoResultBlock(r.output), /FAIL — (XRPL VALIDATION FAILURE|XRPL SUBMISSION FAILURE)/);
  });
  type Replyish = { readonly body: Record<string, unknown> };
  const substitute = (point: string, change: (value: Replyish) => Replyish) => (at: string, value: unknown) => (at === point ? change(value as Replyish) : value);
  it('a denial for another reason is not the expected destination denial', async () => {
    const r = await run(fixture(), { intercept: substitute('A2', (v) => ({ ...v, body: { ...v.body, decision: { ...(v.body['decision'] as object), reasonCodes: ['AUTHORITY_INSUFFICIENT'] } } })) });
    assertFailed(r, 'UNEXPECTED DEMO ASSERTION FAILURE', /A2: wrong denial reason/);
  });
  it('a replay that re-evaluated (another decision) fails the harness', async () => {
    const r = await run(fixture(), { intercept: substitute('A3', (v) => ({ ...v, body: { ...v.body, decision: { ...(v.body['decision'] as object), decisionId: 'enforcement-decision-reevaluated' } } })) });
    assertFailed(r, 'UNEXPECTED DEMO ASSERTION FAILURE', /A3: the replay returned a different decision/);
    assert.equal(r.fixture.ledger.counts.submits, 0);
  });
  it('a reconsideration whose trace is not linked to the original fails the harness', async () => {
    const r = await run(fixture(), {
      intercept: (at, value) => {
        if (at !== 'A5:trace') return value;
        const traced = value as { readonly trace: { readonly summary: unknown; readonly stages: Record<string, Record<string, unknown>> }; readonly text: string };
        const request = traced.trace.stages['request'] ?? {};
        return { ...traced, trace: { ...traced.trace, stages: { ...traced.trace.stages, request: { ...request, lineage: { ...(request['lineage'] as object), reconsiders: { requestId: 'aoc.gar:someone-else', status: 'denied' } } } } } };
      },
    });
    assertFailed(r, 'UNEXPECTED DEMO ASSERTION FAILURE', /A5: the reconsideration is not linked/);
  });
  it('a second reconsideration that executes fails the harness', async () => {
    const r = await run(fixture(), { intercept: substitute('A9', (v) => ({ ...v, body: { ...v.body, status: 'executed', reasonCodes: [] } })) });
    assertFailed(r, 'UNEXPECTED DEMO ASSERTION FAILURE', /A9: a second reconsideration executed/);
  });
  it('an original whose historical answer changed fails the harness', async () => {
    const r = await run(fixture(), { intercept: substitute('A10', (v) => ({ ...v, body: { ...v.body, status: 'executed' } })) });
    assertFailed(r, 'UNEXPECTED DEMO ASSERTION FAILURE', /A10: the replay did not return the original request/);
  });
  it('Scenario B withheld for another reason fails the harness', async () => {
    const r = await run(fixture(), { intercept: substitute('B', (v) => ({ ...v, body: { ...v.body, reasonCodes: ['FINANCIAL_AUTHORITY_ASSET_MISMATCH'] } })) });
    assertFailed(r, 'UNEXPECTED DEMO ASSERTION FAILURE', /B: wrong reason/);
  });
  it('a ledger re-read that disagrees with the transport on the engine result fails the harness', async () => {
    const r = await run(fixture({ ledger: { lookupEngineResult: 'tecUNFUNDED_PAYMENT' } }));
    assertFailed(r, 'XRPL VALIDATION FAILURE', /the ledger reports 'tecUNFUNDED_PAYMENT'/);
  });
  it('a delivered amount that differs on the independent ledger re-read fails the harness', async () => {
    const r = await run(fixture({ ledger: { lookupDeliveredValue: '9' } }));
    assertFailed(r, 'XRPL VALIDATION FAILURE', /the ledger delivered 9, expected 10/);
  });
});
