import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import Database from 'better-sqlite3';

import { RLUSD_CURRENCY_CODE, RLUSD_XRPL_TESTNET_ISSUER, type AndrewDemo } from '../../../dist/src/enterprise/andrew-demo/index.js';
import { codesOf, decisionOf, expectAlreadyRealized, expectCeilingWithholding, expectDestinationDenial, expectLinkedReconsideration, expectSameDecision, reconsiderationFailure } from './expectations.js';
import { DemoFailure, type DemoConfiguration, type DemoCounters, type DemoExpectedOutcome, type DemoInterceptor, type DemoLedgerPorts, type DemoStepObserver, type DemoSummary, type DemoTransportBinding } from './contracts.js';
import { grouped, type Presenter } from './presentation.js';
import { DEMO_OPERATOR, DEMO_REGISTRAR, type RunPaths } from './run-infrastructure.js';

/**
 * ANDREW-P0-11 — Scenario A (unapproved destination → approval → linked
 * reconsideration → one real Testnet payment) and Scenario B (approved
 * destination, USD 125,000 against the USD 100,000 authority: withheld at
 * issuance, nothing on chain).
 *
 * Every step goes through the normal Andrew composition: the agent's HTTP
 * request to the Host, the P0-03 destination governance, the Host's own
 * evidence API. The harness decides nothing — it checks what the canonical
 * records say against what the story requires, and stops at the first
 * deviation with a categorized failure. Every summary value is copied from a
 * canonical record (a governed-action response, an ASSURE-01 trace, the grant
 * store, the attempt store, the ledger), never from an expected constant.
 */

/** The Scenario B request: an approved destination, above the USD 100,000 per-transfer authority. */
export const SCENARIO_B_REQUEST_USD = '125000';
/** Andrew's production example — the motivating scenario, never a Testnet amount. */
export const PRODUCTION_MOTIVATING_EXAMPLE_USD = '75000';

const CEILING_EXCEEDED = 'FINANCIAL_AUTHORITY_CEILING_EXCEEDED';

interface Reply {
  readonly status: number;
  readonly text: string;
  readonly body: Record<string, unknown>;
}

type Stages = Record<string, Record<string, unknown>>;
interface Trace {
  readonly summary: Record<string, unknown>;
  readonly stages: Stages;
}

export interface ScenarioContext {
  readonly demo: AndrewDemo;
  readonly configuration: DemoConfiguration;
  readonly paths: RunPaths;
  readonly credentials: { readonly agent: string; readonly operator: string; readonly auditor: string };
  readonly binding: DemoTransportBinding;
  readonly ports: DemoLedgerPorts;
  readonly present: Presenter;
  readonly checkpoints: DemoSummary['checkpoints'][number][];
  readonly observer?: DemoStepObserver;
  readonly intercept?: DemoInterceptor;
  readonly isInterrupted?: () => boolean;
}

/** What the harness observes at `point`: the canonical value, unless a test interceptor substitutes it. */
function seen<T>(context: Pick<ScenarioContext, 'intercept'>, point: string, value: T): T {
  return context.intercept === undefined ? value : (context.intercept(point, value) as T);
}

async function call(baseUrl: string, method: string, path: string, authorization: string, body?: unknown): Promise<Reply> {
  const response = await fetch(`${baseUrl}${path}`, { method, headers: { authorization: `Bearer ${authorization}`, 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  return { status: response.status, text, body: parsed };
}

const fail = (category: ConstructorParameters<typeof DemoFailure>[0], message: string): never => {
  throw new DemoFailure(category, message);
};
const assertDemo = (condition: boolean, message: string): void => {
  if (!condition) fail('UNEXPECTED DEMO ASSERTION FAILURE', message);
};
const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

function readGrants(paths: RunPaths): readonly Record<string, unknown>[] {
  const file = join(paths.hostDirectory, 'bounded-grants.sqlite');
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return (db.prepare('SELECT grant_json FROM bounded_grants').all() as { readonly grant_json: string }[]).map((row) => JSON.parse(row.grant_json) as Record<string, unknown>);
  } finally {
    db.close();
  }
}

function issuanceRecordRow(paths: RunPaths, requestId: string): { readonly referenceId: string; readonly externalVersion: string; readonly uri: string; readonly createdAt: string } | undefined {
  const db = new Database(join(paths.hostDirectory, 'governance.sqlite'), { readonly: true, fileMustExist: true });
  try {
    return db
      .prepare("SELECT reference_id AS referenceId, external_version AS externalVersion, uri, created_at AS createdAt FROM governance_references WHERE reference_type = 'issuance_record' AND external_id = ?")
      .get(requestId) as { readonly referenceId: string; readonly externalVersion: string; readonly uri: string; readonly createdAt: string } | undefined;
  } finally {
    db.close();
  }
}

export function measureCounters(context: Pick<ScenarioContext, 'paths' | 'binding'>): DemoCounters {
  const activity = context.binding.activity();
  return { grants: readGrants(context.paths).length, connections: activity.connections, signatures: activity.signatures, submissions: activity.submissions, attempts: context.binding.attemptCount() };
}

function sameCounters(context: ScenarioContext, expected: DemoCounters, step: string, what: string): DemoCounters {
  const now = measureCounters(context);
  if (now.grants !== expected.grants) fail('UNEXPECTED DEMO ASSERTION FAILURE', `${step}: unexpected grant — ${what} (grants ${expected.grants} → ${now.grants})`);
  if (now.signatures !== expected.signatures || now.submissions !== expected.submissions || now.connections !== expected.connections || now.attempts !== expected.attempts) {
    fail('UNEXPECTED DEMO ASSERTION FAILURE', `${step}: unexpected XRPL activity — ${what} (connections ${expected.connections}→${now.connections}, signatures ${expected.signatures}→${now.signatures}, submissions ${expected.submissions}→${now.submissions}, attempt rows ${expected.attempts}→${now.attempts})`);
  }
  return now;
}

async function checkpoint(context: ScenarioContext, step: string, result: 'PASS' | DemoExpectedOutcome, detail: string, extra: { readonly requestId?: string; readonly evaluationId?: string } = {}): Promise<void> {
  context.checkpoints.push({ step, result, detail });
  await context.observer?.(step, { runDirectory: context.paths.runDirectory, hostDirectory: context.paths.hostDirectory, ...extra });
  // Checked after every checkpoint, so an interruption stops the run before the next governed action.
  if (context.isInterrupted?.() === true) fail('UNEXPECTED DEMO ASSERTION FAILURE', `the run was interrupted after ${step}`);
}

export class EvidenceClient {
  constructor(
    private readonly baseUrl: string,
    private readonly auditor: string,
  ) {}

  async trace(requestId: string): Promise<{ readonly trace: Trace; readonly text: string }> {
    const reply = await call(this.baseUrl, 'GET', `/api/evidence/traces/${encodeURIComponent(requestId)}?level=AUDITOR`, this.auditor);
    if (reply.status !== 200) fail('EVIDENCE VERIFICATION FAILURE', `the ASSURE-01 trace of ${requestId} could not be read (HTTP ${reply.status})`);
    const trace = reply.body['trace'] as Trace | undefined;
    if (trace === undefined) fail('EVIDENCE VERIFICATION FAILURE', `the ASSURE-01 trace of ${requestId} is empty`);
    return { trace: trace as Trace, text: reply.text };
  }

  /** Verify the trace; anything but `verified: true` is an evidence failure, named by its failing checks. */
  async verify(requestId: string): Promise<{ readonly verified: true; readonly checks: number }> {
    const reply = await call(this.baseUrl, 'GET', `/api/evidence/traces/${encodeURIComponent(requestId)}/verify`, this.auditor);
    const checks = (reply.body['checks'] as readonly { readonly check: string; readonly status: string }[] | undefined) ?? [];
    if (reply.status !== 200 || reply.body['verified'] !== true) {
      const failed = checks.filter((entry) => entry.status === 'fail').map((entry) => entry.check);
      fail('EVIDENCE VERIFICATION FAILURE', `the ASSURE-01 trace of ${requestId} does not verify${failed.length > 0 ? ` (failing: ${failed.join(', ')})` : ''}`);
    }
    return { verified: true, checks: checks.length };
  }
}

// ── Scenario A ─────────────────────────────────────────────────────────────

export async function runScenarioA(context: ScenarioContext): Promise<Readonly<Record<string, unknown>>> {
  const { demo, configuration, present, credentials } = context;
  const evidence = new EvidenceClient(demo.baseUrl, credentials.auditor);
  const amount = configuration.amountUsd;
  const operatorBearer = `Bearer ${credentials.operator}`;
  const govern = (intent: Record<string, unknown>, key: string) => call(demo.baseUrl, 'POST', '/api/governed-actions', credentials.agent, { idempotencyKey: key, ...intent });
  const key = (label: string) => `${context.paths.runId}-${label}`;

  present.banner('SCENARIO A — Unapproved destination, then approval and reconsideration');

  // A1 — the agent's request, on fresh governance state.
  const destination = demo.registerDestination(configuration.recipient, DEMO_REGISTRAR);
  const initialState = demo.destinationGovernance.readDestinationApproval(operatorBearer, { destination }).state;
  if (initialState !== 'never-approved') fail('PRECONDITION FAILURE', `fresh run state expected: the destination is '${initialState}', not 'never-approved'`);
  const zero = measureCounters(context);
  if (Object.values(zero).some((count) => count !== 0)) fail('PRECONDITION FAILURE', `fresh run state expected: grants/XRPL activity already present (${JSON.stringify(zero)})`);
  const intent = demo.transferIntent(configuration.recipient, amount);
  present.line('A1  Agent request');
  present.fact('Agent', 'Andrew\'s treasury agent (principal-andrew-agent)');
  present.fact('Business intent', `${intent.action} from ${intent.resource}`);
  present.fact('Governed amount', `USD ${grouped(amount)}`);
  present.fact('Destination', intent.counterparty);
  present.fact('Destination governance', 'NOT APPROVED (never-approved)');
  await checkpoint(context, 'A1', 'PASS', `destination ${intent.counterparty} is never-approved on fresh state`);

  // A2 — first decision: denied by destination policy; nothing granted, signed or sent.
  const original = seen(context, 'A2', await govern(intent, key('A-original')));
  const originalRequestId = str(original.body['requestId']) ?? '';
  const originalDecision = expectDestinationDenial(original);
  sameCounters(context, zero, 'A2', 'the denied request');
  const originalTrace = await evidence.trace(originalRequestId);
  await evidence.verify(originalRequestId);
  present.line();
  present.line('A2  First decision');
  present.fact('Identity', `VERIFIED (${String(originalTrace.trace.stages['request']?.['actorId'])})`);
  present.fact('Destination approved', 'NO');
  present.fact('Policy decision', `DENIED (${originalDecision.reasonCodes.join(', ')})`);
  present.fact('Authority', `NOT EVALUATED — no executable decision (${String(originalTrace.trace.stages['authority']?.['presence'])})`);
  present.result('BLOCKED — expected: the destination is not approved');
  present.fact('Request', originalRequestId);
  present.fact('Decision', originalDecision.decisionId);
  present.fact('Grant', 'NONE (0)');
  present.fact('XRPL signature', 'NONE (0)');
  present.fact('XRPL submission', 'NONE (0)');
  await checkpoint(context, 'A2', 'EXPECTED GOVERNANCE DENIAL', originalDecision.reasonCodes.join(','), { requestId: originalRequestId, evaluationId: originalDecision.evaluationId });

  // A3 — exact replay: the stored decision, no re-evaluation.
  const replay = seen(context, 'A3', await govern(intent, key('A-original')));
  expectSameDecision(original, replay, 'A3');
  sameCounters(context, zero, 'A3', 'the replay');
  present.line();
  present.line('A3  Idempotent replay of the exact request');
  present.fact('Decision', `${decisionOf(replay).decisionId} (same as A2)`);
  present.fact('Result', 'NO RE-EVALUATION / NO NEW EXECUTION');
  await checkpoint(context, 'A3', 'PASS', 'same committed decision');

  // A4 — explicit destination approval through P0-03; executes nothing.
  const approval = demo.destinationGovernance.approveDestination(operatorBearer, { destination, idempotencyKey: key('A-approve') });
  if (approval.outcome !== 'approved') fail('UNEXPECTED DEMO ASSERTION FAILURE', `A4: the destination approval was not recorded (${approval.outcome})`);
  const approvalRecord = approval.outcome === 'approved' ? approval.approval : undefined;
  assertDemo(demo.destinationGovernance.readDestinationApproval(operatorBearer, { destination }).state === 'approved', 'A4: the destination does not read as approved');
  sameCounters(context, zero, 'A4', 'the approval');
  const approvalEvidence = { approvedBy: approvalRecord?.approvedBy, authorityBasis: approvalRecord?.authorityBasis, approvedAt: approvalRecord?.approvedAt, sequence: approvalRecord?.sequence, organizationId: approvalRecord?.organizationId };
  present.line();
  present.line('A4  Destination approval');
  present.fact('Approved by', `${String(approvalRecord?.approvedBy)} (${DEMO_OPERATOR.role})`);
  present.fact('Authority basis', String(approvalRecord?.authorityBasis));
  present.fact('Destination', intent.counterparty);
  present.fact('Approval recorded', String(approvalRecord?.approvedAt));
  present.fact('Execution by approval', 'NONE — approval alone executed nothing');
  await checkpoint(context, 'A4', 'PASS', 'approval recorded; 0 grants, 0 signatures, 0 submissions');

  // A5–A7 — linked reconsideration of the same business intent: fresh decision, one grant, one real payment.
  present.line();
  present.line('A5  Reconsidering the original business intent…');
  const reconsideration = seen(context, 'A6', await govern({ ...intent, reconsideration: { of: originalRequestId, reason: 'destination-approved' } }, key('A-reconsideration')));
  const reconsiderationRequestId = str(reconsideration.body['requestId']) ?? '';
  const executionId = str(reconsideration.body['executionId']);
  if (reconsideration.body['status'] !== 'executed') throw reconsiderationFailure(reconsideration, executionId !== undefined ? context.binding.findAttempt(executionId) : undefined);
  const reconsiderationDecision = decisionOf(reconsideration);
  assertDemo(reconsiderationRequestId !== originalRequestId && reconsiderationDecision.decisionId !== originalDecision.decisionId, 'A6: the reconsideration reused the original request or decision');
  assertDemo(reconsiderationDecision.status === 'allowed', `A6: the fresh decision is '${reconsiderationDecision.status}', not allowed`);
  const afterPayment = measureCounters(context);
  assertDemo(afterPayment.grants === 1 && afterPayment.signatures === 1 && afterPayment.submissions === 1 && afterPayment.attempts === 1, `A7: expected exactly 1 grant, 1 signature, 1 submission, 1 attempt row — got ${JSON.stringify(afterPayment)}`);
  const grants = readGrants(context.paths);
  const grant = grants[0] ?? {};
  const grantCorrelation = (grant['correlation'] ?? {}) as Record<string, unknown>;
  assertDemo(grantCorrelation['requestId'] === reconsiderationRequestId && grantCorrelation['decisionId'] === reconsiderationDecision.decisionId, 'A6: the grant is not bound to the reconsideration decision');
  const grantAmount = ((grant['scope'] ?? {}) as Record<string, unknown>)['amount'] as { readonly kind?: string; readonly limit?: string; readonly unit?: string } | undefined;

  // The trace is read first: it names the fresh decision's lineage to the original.
  const recTrace = seen(context, 'A5:trace', await evidence.trace(reconsiderationRequestId));
  const lineage = (recTrace.trace.stages['request']?.['lineage'] ?? {}) as Record<string, unknown>;
  expectLinkedReconsideration(lineage, originalRequestId);
  present.fact('Original request', originalRequestId);
  present.fact('Reconsideration request', reconsiderationRequestId);
  present.fact('Shared business intent', String(lineage['businessIntentId']));
  present.fact('Reason', String(lineage['reason']));
  await checkpoint(context, 'A5', 'PASS', `linked to ${originalRequestId}`, { requestId: reconsiderationRequestId, evaluationId: reconsiderationDecision.evaluationId });

  present.line();
  present.line('A6  Fresh governance result');
  present.fact('Identity', `VERIFIED (${String(recTrace.trace.stages['request']?.['actorId'])})`);
  present.fact('Destination approved', 'YES');
  present.fact('Policy decision', `ALLOWED (${reconsiderationDecision.reasonCodes.join(', ')})`);
  present.fact('Bounded grant', String(grant['id']));
  present.fact('Authority bound', grantAmount?.kind === 'ceiling' ? `amount ≤ ${String(grantAmount.unit)} ${grouped(String(grantAmount.limit))} per transfer` : 'UNKNOWN');
  present.fact('Execution', String(executionId));
  present.result('AUTHORIZED');
  await checkpoint(context, 'A6', 'PASS', `decision ${reconsiderationDecision.decisionId}, grant ${String(grant['id'])}`);

  // A7 — the real XRPL Testnet payment, read back from the attempt store and independently from the ledger.
  present.line();
  present.line('A7  Executing on XRPL Testnet…');
  const attempt = context.binding.findAttempt(String(executionId));
  if (attempt === undefined) fail('XRPL SUBMISSION FAILURE', 'A7: no XRPL attempt was recorded for the execution');
  const record = attempt as NonNullable<typeof attempt>;
  if (record.state !== 'validated-success') fail('XRPL VALIDATION FAILURE', `A7: the XRPL attempt is '${record.state}', not validated-success`);
  const hash = record.attempt.transactionHash;
  if (reconsideration.body['providerRef'] !== hash) fail('XRPL VALIDATION FAILURE', 'A7: the governed result does not carry the attempt\'s transaction hash');
  const final = record.events.at(-1)?.evidence ?? {};
  if (final['engineResult'] !== 'tesSUCCESS') fail('XRPL VALIDATION FAILURE', `A7: engine result '${String(final['engineResult'])}'`);
  if (!context.ports.issuedValuesEqual(final['deliveredValue'], amount)) fail('XRPL VALIDATION FAILURE', `A7: delivered ${String(final['deliveredValue'])}, expected ${amount}`);
  const lookup = await context.ports.lookupTransaction(configuration, hash);
  if (!lookup.found || lookup.validated !== true) fail('XRPL VALIDATION FAILURE', `A7: the ledger does not show ${hash} as validated`);
  if (lookup.hash !== undefined && lookup.hash !== hash) fail('XRPL VALIDATION FAILURE', 'A7: the ledger returned a different transaction');
  if (lookup.engineResult !== 'tesSUCCESS') fail('XRPL VALIDATION FAILURE', `A7: the ledger reports '${String(lookup.engineResult)}'`);
  if (lookup.delivered?.currency !== RLUSD_CURRENCY_CODE || lookup.delivered.issuer !== RLUSD_XRPL_TESTNET_ISSUER) fail('XRPL VALIDATION FAILURE', 'A7: the delivered asset is not Testnet RLUSD');
  if (!context.ports.issuedValuesEqual(lookup.delivered?.value, amount)) fail('XRPL VALIDATION FAILURE', `A7: the ledger delivered ${String(lookup.delivered?.value)}, expected ${amount}`);
  if (lookup.account !== configuration.treasury || lookup.destination !== configuration.recipient) fail('XRPL VALIDATION FAILURE', 'A7: the ledger shows another source or destination');
  present.result(String(lookup.engineResult));
  present.fact('Rail', 'XRPL Testnet (adapter xrpl-testnet.treasury)');
  present.fact('Transaction', hash);
  present.fact('Validated ledger', String(lookup.ledgerIndex));
  present.fact('Delivered', `${String(lookup.delivered?.value)} Test RLUSD (Testnet issuer ${RLUSD_XRPL_TESTNET_ISSUER})`);
  present.fact('Source', configuration.treasury);
  present.fact('Destination', configuration.recipient);
  present.fact('Signatures / submissions', `${afterPayment.signatures} / ${afterPayment.submissions}`);
  await checkpoint(context, 'A7', 'PASS', `${hash} @ ${String(lookup.ledgerIndex)}`, { requestId: reconsiderationRequestId, evaluationId: reconsiderationDecision.evaluationId });

  // A8 — the authority-to-outcome evidence, verified.
  const verifiedTrace = await evidence.trace(reconsiderationRequestId);
  const recVerification = await evidence.verify(reconsiderationRequestId);
  const stages = verifiedTrace.trace.stages;
  const finalState = verifiedTrace.trace.summary['finalState'];
  if (finalState !== 'executed-confirmed-completed') fail('EVIDENCE VERIFICATION FAILURE', `A8: the trace's final state is '${String(finalState)}'`);
  if (stages['outcome']?.['providerRef'] !== hash) fail('EVIDENCE VERIFICATION FAILURE', 'A8: the trace outcome does not carry the transaction hash');
  if (stages['execution']?.['executionId'] !== executionId) fail('EVIDENCE VERIFICATION FAILURE', 'A8: the trace names another execution');
  const traceGrants = (stages['authority']?.['grants'] as readonly Record<string, unknown>[] | undefined) ?? [];
  if (traceGrants.length !== 1 || traceGrants[0]?.['grantId'] !== grant['id']) fail('EVIDENCE VERIFICATION FAILURE', 'A8: the trace names another grant');
  if (((stages['request']?.['lineage'] ?? {}) as Record<string, unknown>)['realizedOriginal'] !== true) fail('EVIDENCE VERIFICATION FAILURE', 'A8: the trace does not record the realization of the original');
  present.line();
  present.line('A8  Evidence (ASSURE-01)');
  present.line(`  agent → original denial → approval → linked reconsideration → allowed decision`);
  present.line(`        → grant → execution → XRPL transaction → confirmed outcome`);
  present.fact('Final state', String(finalState));
  present.fact('Evidence', `VERIFIED (${recVerification.checks} checks)`);
  await checkpoint(context, 'A8', 'PASS', 'trace verified');

  // A9 — one business intent, at most one realization.
  const again = seen(context, 'A9', await govern({ ...intent, reconsideration: { of: originalRequestId, reason: 'destination-approved' } }, key('A-reconsideration-2')));
  expectAlreadyRealized(again);
  sameCounters(context, afterPayment, 'A9', 'the second reconsideration');
  present.line();
  present.line('A9  Second reconsideration of the same original');
  present.result(`REFUSED — expected: ${codesOf(again).join(', ')}`);
  present.fact('New grant / signature / submission', 'NONE');
  await checkpoint(context, 'A9', 'EXPECTED DUPLICATE REFUSAL', codesOf(again).join(','));

  // A10 — historical truth: the original denial is never rewritten by the later success.
  const historical = seen(context, 'A10', await govern(intent, key('A-original')));
  expectSameDecision(original, historical, 'A10');
  const historicalTrace = await evidence.trace(originalRequestId);
  await evidence.verify(originalRequestId);
  assertDemo(historicalTrace.trace.stages['request']?.['lineage'] === undefined, 'A10: the original record was rewritten with lineage');
  sameCounters(context, afterPayment, 'A10', 'the historical replay');
  present.line();
  present.line('A10 Historical truth');
  present.fact('Original request', `${String(historical.body['status']).toUpperCase()} — decision ${decisionOf(historical).decisionId} (unchanged)`);
  await checkpoint(context, 'A10', 'PASS', 'original denial unchanged');

  return {
    originalRequestId,
    originalDecisionId: originalDecision.decisionId,
    originalStatus: originalDecision.status,
    originalReasonCodes: [...originalDecision.reasonCodes],
    replay: { requestId: replay.body['requestId'], decisionId: decisionOf(replay).decisionId, sameDecision: isDeepStrictEqual(decisionOf(replay), originalDecision) },
    approvalEvidence,
    businessIntentId: lineage['businessIntentId'],
    reconsiderationReason: lineage['reason'],
    reconsiderationRequestId,
    reconsiderationDecisionId: reconsiderationDecision.decisionId,
    reconsiderationStatus: reconsiderationDecision.status,
    grantId: grant['id'],
    grantAmountBound: grantAmount,
    executionId,
    rail: 'XRPL Testnet',
    adapterId: stages['outcome']?.['adapterId'],
    transactionHash: hash,
    ledgerIndex: lookup.ledgerIndex,
    engineResult: lookup.engineResult,
    deliveredAmount: lookup.delivered,
    sourceAccount: lookup.account,
    destinationAccount: lookup.destination,
    attemptState: record.state,
    assureFinalState: finalState,
    assureVerified: recVerification.verified,
    originalTraceVerified: true,
    secondReconsideration: { requestId: again.body['requestId'], status: again.body['status'], reasonCodes: codesOf(again) },
    historicalReplay: { status: historical.body['status'], decisionId: decisionOf(historical).decisionId, unchanged: isDeepStrictEqual(decisionOf(historical), originalDecision) },
    counters: afterPayment,
  };
}

// ── Scenario B ─────────────────────────────────────────────────────────────

export async function runScenarioB(context: ScenarioContext): Promise<Readonly<Record<string, unknown>>> {
  const { demo, configuration, present, credentials } = context;
  const evidence = new EvidenceClient(demo.baseUrl, credentials.auditor);
  present.banner('SCENARIO B — Authority ceiling (approved destination)');

  // Governance state reused only to show the destination is approved; no ledger read, no funding needed.
  const destination = { namespace: 'xrpl.testnet', identifier: configuration.recipient };
  const approvalState = demo.destinationGovernance.readDestinationApproval(`Bearer ${credentials.operator}`, { destination }).state;
  if (approvalState !== 'approved') fail('PRECONDITION FAILURE', `Scenario B needs an approved destination; it is '${approvalState}'`);
  const before = measureCounters(context);

  const reply = seen(context, 'B', await call(demo.baseUrl, 'POST', '/api/governed-actions', credentials.agent, { idempotencyKey: `${context.paths.runId}-B-ceiling`, ...demo.transferIntent(configuration.recipient, SCENARIO_B_REQUEST_USD) }));
  const requestId = str(reply.body['requestId']) ?? '';
  await context.observer?.('B:after-request', { runDirectory: context.paths.runDirectory, hostDirectory: context.paths.hostDirectory, requestId, evaluationId: decisionOf(reply).evaluationId });
  sameCounters(context, before, 'B', 'the over-ceiling request');
  const decision = expectCeilingWithholding(reply);

  const { trace, text } = await evidence.trace(requestId);
  const verification = await evidence.verify(requestId);
  const authority = trace.stages['authority'] ?? {};
  const issuance = (authority['issuance'] ?? {}) as Record<string, unknown>;
  if (authority['presence'] !== 'recorded' || issuance['outcome'] !== 'withheld') fail('EVIDENCE VERIFICATION FAILURE', 'B: the trace has no durable authority-issuance withholding');
  if (issuance['withheldBy'] !== 'authority-binding' || !isDeepStrictEqual(issuance['reasonCodes'], [CEILING_EXCEEDED])) fail('EVIDENCE VERIFICATION FAILURE', 'B: the durable issuance record names another layer or reason');
  if (!isDeepStrictEqual(issuance['requested'], { value: SCENARIO_B_REQUEST_USD, unit: 'USD' })) fail('EVIDENCE VERIFICATION FAILURE', 'B: the durable issuance record names another requested amount');
  if (((authority['grants'] as readonly unknown[] | undefined) ?? []).length !== 0) fail('EVIDENCE VERIFICATION FAILURE', 'B: the trace shows a grant');
  if (trace.summary['finalState'] !== 'not-executed') fail('EVIDENCE VERIFICATION FAILURE', `B: final state '${String(trace.summary['finalState'])}'`);
  if (/providerRef|transactionHash/.test(text)) fail('EVIDENCE VERIFICATION FAILURE', 'B: the trace implies a transaction');
  const row = issuanceRecordRow(context.paths, requestId);
  if (row === undefined) fail('EVIDENCE VERIFICATION FAILURE', 'B: no durable issuance_record row for the request');
  const after = sameCounters(context, before, 'B', 'the over-ceiling request');
  const requested = issuance['requested'] as { readonly value: string; readonly unit: string };
  const ceiling = issuance['ceiling'] as { readonly value: string; readonly unit: string } | undefined;

  present.fact('Requested', `${requested.unit} ${grouped(requested.value)} (governed amount — nothing is sent)`);
  present.fact('Authority ceiling', ceiling === undefined ? 'UNKNOWN' : `${ceiling.unit} ${grouped(ceiling.value)}`);
  present.fact('Destination approved', 'YES');
  present.fact('Kernel decision', `${decision.status.toUpperCase()} (${decision.reasonCodes.join(', ')})`);
  present.fact('Authority issuance', `WITHHELD by ${String(issuance['withheldBy'])}`);
  present.result('BLOCKED — expected: above the authority ceiling');
  present.fact('Reason', String((issuance['reasonCodes'] as readonly string[])[0]));
  present.fact('Request', requestId);
  present.fact('Decision', decision.decisionId);
  present.fact('Durable issuance record', String(row?.referenceId));
  present.fact('Grant', `NONE (${after.grants - before.grants})`);
  present.fact('XRPL connection', `NONE (${after.connections - before.connections})`);
  present.fact('XRPL signature', `NONE (${after.signatures - before.signatures})`);
  present.fact('XRPL submission', `NONE (${after.submissions - before.submissions})`);
  present.fact('Attempt rows', `NONE (${after.attempts - before.attempts})`);
  present.fact('Evidence', `VERIFIED (${verification.checks} checks)`);
  await checkpoint(context, 'B', 'EXPECTED AUTHORITY WITHHOLDING', CEILING_EXCEEDED, { requestId, evaluationId: decision.evaluationId });

  return {
    requestId,
    decisionId: decision.decisionId,
    decisionStatus: decision.status,
    requestedAmount: requested,
    authorityCeiling: ceiling,
    issuanceOutcome: issuance['outcome'],
    withheldBy: issuance['withheldBy'],
    reasonCode: (issuance['reasonCodes'] as readonly string[])[0],
    issuanceRecord: row,
    grantCount: after.grants - before.grants,
    connectionCount: after.connections - before.connections,
    signatureCount: after.signatures - before.signatures,
    submissionCount: after.submissions - before.submissions,
    attemptRowCount: after.attempts - before.attempts,
    providerRef: reply.body['providerRef'] ?? null,
    transactionHash: reply.body['providerRef'] ?? null,
    assureFinalState: trace.summary['finalState'],
    assureVerified: verification.verified,
  };
}
