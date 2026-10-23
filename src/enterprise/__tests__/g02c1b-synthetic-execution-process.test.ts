import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createGenericHttpExecutionAdapterCore } from '../execution-adapters/generic-http/generic-http-execution-adapter.js';
import type { ReferenceExecutorExecution } from '../reference-executor/index.js';
import {
  BEARER,
  BEARER_ENV,
  CONFIG_VARIABLE,
  HEADER_CREDENTIAL,
  HEADER_CREDENTIAL_ENV,
  ISSUED_PRESENTATIONS,
  captureHostBytes,
  exchange,
  hostVector,
  parseRaw,
  rawExchange,
  refusedStart,
  sendThroughHostTransport,
  serializeRaw,
  spawnExecutor,
  validatedAction,
  withPresentation,
  type RawRequest,
  type SpawnedExecutor,
} from './g02c1a-reference-executor-fixture.js';
import { presentedWith, sendAndDisconnect, syntheticCapability, syntheticConfiguration, syntheticDomain, type SyntheticDomain } from './g02c1b-synthetic-execution-fixture.js';

/**
 * G-02C1B — synthetic execution across real processes and real HTTP/1.1 bytes:
 * the Host transport and classifier, duplicate and lost-response delivery,
 * restart, a genuine two-process race on one ledger, the separate-ledger
 * counterexample, crash injection at every point of the execution path, and
 * startup refusals. Loopback plain HTTP only; nothing here is production.
 */

const VECTOR = hostVector('POST with body and headers', {
  body: { kind: 'json-object', fields: { subject: { kind: 'source', source: 'subject' }, amount: { kind: 'source', source: 'amount.value' } } },
  headers: { 'X-Release-Channel': { kind: 'literal', value: 'stable' } },
});

const domains: SyntheticDomain[] = [];
const executors: SpawnedExecutor[] = [];
let base: RawRequest;

before(async () => {
  base = parseRaw(await captureHostBytes(withPresentation(VECTOR.request, syntheticCapability(VECTOR.digest).presentation)));
});
after(async () => {
  await Promise.all(executors.map((executor) => executor.kill()));
  for (const domain of domains) domain.cleanup();
});

async function domainOf(audience?: string): Promise<SyntheticDomain> {
  const domain = await syntheticDomain(audience);
  domains.push(domain);
  return domain;
}
async function executorOver(domain: SyntheticDomain, overrides: Record<string, unknown> = {}): Promise<SpawnedExecutor> {
  const executor = await spawnExecutor(syntheticConfiguration(domain, overrides));
  executors.push(executor);
  return executor;
}
async function deliver(executor: SpawnedExecutor, presentation: string): Promise<{ readonly status: number | undefined; readonly execution: ReferenceExecutorExecution }> {
  const { response, assessment } = await exchange(executor, serializeRaw(presentedWith(base, presentation)));
  return { status: response.status, execution: assessment as unknown as ReferenceExecutorExecution };
}

describe('G-02C1B process — the Host’s view: completed once, then unconfirmed, never twice', () => {
  it('through the real Host transport and the full Generic HTTP adapter: 201 is completed, a redelivery is 202 and unconfirmed', async () => {
    const domain = await domainOf();
    const executor = await executorOver(domain);
    const { capability, presentation } = syntheticCapability(VECTOR.digest);
    const adapter = createGenericHttpExecutionAdapterCore(VECTOR.plan, {
      resolve: async () => ({ kind: 'resolved', answers: [{ address: '93.184.216.34', family: 4 }] }),
      send: (request, _address, _timeoutMs, providerRefHeader) => sendThroughHostTransport(executor.port, withPresentation(request, presentation), providerRefHeader),
    });
    const first = await adapter.execute(validatedAction());
    assert.equal(first.outcome, 'completed', 'an observed synthetic completion (201)');
    const second = await adapter.execute(validatedAction());
    assert.equal(second.outcome, 'unconfirmed', 'already consumed (202) is never read as a success or as a definite failure');
    const observation = await sendThroughHostTransport(executor.port, withPresentation(VECTOR.request, presentation));
    assert.ok(observation.kind === 'response' && observation.status === 202);
    assert.equal((await domain.state(capability.capabilityId)).state, 'completed');
    assert.deepEqual(domain.records(), [`${capability.capabilityId}.json`]);
  });

  it('a lost response leaves one completed effect; the redelivery performs nothing; so does a restart', async () => {
    const domain = await domainOf();
    const executor = await executorOver(domain);
    const { capability, presentation } = syntheticCapability(VECTOR.digest);
    const before = executor.assessments.length;
    await sendAndDisconnect(executor.port, serializeRaw(presentedWith(base, presentation)));
    await executor.waitForAssessments(before + 1);
    assert.equal((executor.assessments[before] as unknown as ReferenceExecutorExecution).outcome, 'completed-observed', 'the section from claim to outcome is synchronous: a disconnect cannot interrupt it');
    const again = await deliver(executor, presentation);
    assert.deepEqual([again.status, again.execution.outcome, again.execution.ledgerState], [202, 'already-consumed', 'completed']);
    await executor.kill();
    const restarted = await executorOver(domain);
    const afterRestart = await deliver(restarted, presentation);
    assert.deepEqual([afterRestart.status, afterRestart.execution.outcome, afterRestart.execution.ledgerState], [202, 'already-consumed', 'completed']);
    assert.deepEqual(domain.records(), [`${capability.capabilityId}.json`]);
  });
});

describe('G-02C1B process — two executor processes, one ledger', () => {
  it('the same capability delivered to both at once: exactly one claim, exactly one effect, the other already consumed — twelve times', async (t) => {
    const domain = await domainOf();
    const [a, b] = await Promise.all([executorOver(domain), executorOver(domain)]);
    assert.ok(a !== undefined && b !== undefined && a.pid !== b.pid);
    const winners: string[] = [];
    for (let round = 0; round < 12; round += 1) {
      const { capability, presentation } = syntheticCapability(VECTOR.digest);
      const bytes = serializeRaw(presentedWith(base, presentation));
      const [left, right] = await Promise.all([rawExchange(a.port, bytes), rawExchange(b.port, bytes)]);
      assert.deepEqual([left.status, right.status].sort(), [201, 202], `round ${String(round)}`);
      winners.push(left.status === 201 ? 'a' : 'b');
      assert.equal((await domain.state(capability.capabilityId)).state, 'completed');
    }
    assert.equal(domain.records().length, 12, 'one record per capability, never two');
    t.diagnostic(`shared-ledger race winners: ${winners.join('')}`);
  });

  it('counterexample: two executors with SEPARATE ledgers are two consumption domains — each performs the same capability (a stated limitation, not a guarantee)', async () => {
    const [left, right] = await Promise.all([domainOf(), domainOf()]);
    const [a, b] = await Promise.all([executorOver(left), executorOver(right)]);
    const { capability, presentation } = syntheticCapability(VECTOR.digest);
    const bytes = serializeRaw(presentedWith(base, presentation));
    const answers = await Promise.all([rawExchange(a.port, bytes), rawExchange(b.port, bytes)]);
    assert.deepEqual(answers.map((answer) => answer.status), [201, 201]);
    for (const domain of [left, right]) {
      assert.equal((await domain.state(capability.capabilityId)).state, 'completed');
      assert.deepEqual(domain.records(), [`${capability.capabilityId}.json`]);
    }
  });
});

describe('G-02C1B process — crash injection at every point of the execution path', () => {
  const MATRIX: readonly (readonly [string, string, 'none' | 'partial' | 'complete', string, number])[] = [
    // point, ledger after the crash, record after the crash, next delivery's outcome, its status
    ['before-claim', 'absent', 'none', 'completed-observed', 201],
    ['after-claim', 'claimed', 'none', 'already-consumed', 202],
    ['after-expiry-check', 'claimed', 'none', 'already-consumed', 202],
    ['during-effect', 'claimed', 'partial', 'already-consumed', 202],
    ['after-effect', 'claimed', 'complete', 'already-consumed', 202],
    ['after-outcome', 'completed', 'complete', 'already-consumed', 202],
  ];

  for (const [point, ledgerState, record, nextOutcome, nextStatus] of MATRIX) {
    it(`crash ${point}: ledger ${ledgerState}, record ${record}; the next delivery is ${nextOutcome} (${String(nextStatus)}) and nothing re-executes`, async (t) => {
      const domain = await domainOf();
      const crashing = await executorOver(domain, { faultInjection: { crashAt: point } });
      const { capability, presentation } = syntheticCapability(VECTOR.digest);
      const response = await rawExchange(crashing.port, serializeRaw(presentedWith(base, presentation)));
      const exit = await crashing.exited();
      assert.equal(exit.signal, 'SIGKILL', 'the executor died at the fault point');
      assert.equal(response.status, undefined, 'no answer was sent');
      assert.equal((await domain.state(capability.capabilityId)).state, ledgerState);
      const text = domain.recordText(capability.capabilityId);
      if (record === 'none') assert.equal(text, undefined);
      if (record === 'partial') {
        assert.ok(text !== undefined && text.length > 0);
        assert.throws(() => JSON.parse(text), 'a half-written record');
      }
      if (record === 'complete') assert.equal((JSON.parse(text ?? '{}') as Record<string, unknown>)['capabilityId'], capability.capabilityId);
      // Recovery is a restart over the same ledger: the row is kept as it is, and nothing is performed again.
      const restarted = await executorOver(domain);
      const next = await deliver(restarted, presentation);
      assert.deepEqual([next.status, next.execution.outcome], [nextStatus, nextOutcome]);
      const final = (await domain.state(capability.capabilityId)).state;
      if (point === 'before-claim') assert.equal(final, 'completed', 'nothing was consumed, so the next delivery is the first');
      else assert.equal(final, ledgerState, 'the recovered row is never released, completed by assumption or re-executed');
      assert.equal(domain.records().length, record === 'none' && point !== 'before-claim' ? 0 : 1);
      t.diagnostic(`C-${point}: ledger=${ledgerState} record=${record} next=${nextOutcome}/${String(nextStatus)} final=${final}`);
    });
  }

  it('crash inside the claim transaction (before its commit): nothing is consumed', async () => {
    const domain = await domainOf();
    const { capability, presentation } = syntheticCapability(VECTOR.digest);
    const row = [capability.capabilityId, capability.issuer, capability.organizationId, capability.trustDomain, capability.executionId, capability.actionBinding.digest, capability.expiresAt, new Date().toISOString()];
    const script = [
      "const Database = require('better-sqlite3');",
      'const input = JSON.parse(process.env.G02C1B_ROW);',
      'const db = new Database(input.path);',
      "db.prepare('BEGIN IMMEDIATE').run();",
      "db.prepare(\"INSERT INTO execution_capability_consumptions (capability_id, issuer, organization_id, trust_domain, execution_id, action_binding_digest, expires_at, claimed_at, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'claimed')\").run(...input.row);",
      "process.kill(process.pid, 'SIGKILL');",
    ].join('\n');
    const child = spawnSync(process.execPath, ['-e', script], { env: { PATH: process.env.PATH ?? '', G02C1B_ROW: JSON.stringify({ path: domain.ledgerPath, row }) }, encoding: 'utf8' });
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    assert.equal((await domain.state(capability.capabilityId)).state, 'absent', 'an uncommitted claim leaves nothing');
    const executor = await executorOver(domain);
    assert.equal((await deliver(executor, presentation)).execution.outcome, 'completed-observed');
  });
});

describe('G-02C1B process — startup refuses what would make consumption meaningless or the effect unsafe', () => {
  it('a missing, foreign, damaged or unsafe store — or an incomplete mode — stops the executor before it listens', async () => {
    const domain = await domainOf();
    const foreign = await domainOf('executor-elsewhere');
    const missing = join(domain.root, 'ledger', 'missing.sqlite');
    const damaged = join(domain.root, 'ledger', 'damaged.sqlite');
    writeFileSync(damaged, 'not a database');
    const linked = join(domain.root, 'linked-output');
    symlinkSync(domain.outputDirectory, linked);
    const open = join(domain.root, 'open-output');
    mkdirSync(open);
    chmodSync(open, 0o777);
    const section = (overrides: Record<string, unknown>) => ({ syntheticExecution: { effect: 'frontera.synthetic-deployment-record.v1', consumptionLedgerPath: domain.ledgerPath, outputDirectory: domain.outputDirectory, syntheticActions: ['synthetic.apply-release'], ...overrides } });
    const cases: readonly (readonly [string, Record<string, unknown>, string])[] = [
      ['a missing ledger (never created)', syntheticConfiguration(domain, section({ consumptionLedgerPath: missing })), 'LEDGER_INVALID'],
      ['a ledger pinned to another audience', syntheticConfiguration(domain, section({ consumptionLedgerPath: foreign.ledgerPath })), 'LEDGER_INVALID'],
      ['a file that is not a ledger', syntheticConfiguration(domain, section({ consumptionLedgerPath: damaged })), 'LEDGER_INVALID'],
      ['an output directory that is a link', syntheticConfiguration(domain, section({ outputDirectory: linked })), 'SYNTHETIC_OUTPUT_INVALID'],
      ['an output directory others can write', syntheticConfiguration(domain, section({ outputDirectory: open })), 'SYNTHETIC_OUTPUT_INVALID'],
      ['synthetic mode without its section', syntheticConfiguration(domain, { syntheticExecution: undefined }), 'MODE_INCONSISTENT'],
      ['an unknown mode', syntheticConfiguration(domain, { mode: 'live-execution' }), 'MODE_UNSUPPORTED'],
    ];
    for (const [name, config, code] of cases) {
      const refused = await refusedStart(JSON.parse(JSON.stringify(config)) as Record<string, unknown>);
      assert.deepEqual([refused.code, refused.refusal.event, refused.refusal.code], [1, 'refused-to-start', code], name);
      assert.equal(refused.stdout, '', `${name}: never listened`);
      for (const secret of [BEARER, HEADER_CREDENTIAL, domain.root]) assert.equal(refused.stderr.includes(secret), false, `${name}: echoes nothing`);
    }
    assert.equal(existsSync(missing), false, 'the executor never creates a ledger');
  });
});

describe('G-02C1B process — diagnostics', () => {
  it('synthetic executors report their mode and variable names, and write no secret, presentation, capability or body', () => {
    assert.ok(executors.length > 6);
    for (const executor of executors) {
      assert.deepEqual([...executor.reportedEnvironment], [BEARER_ENV, CONFIG_VARIABLE, HEADER_CREDENTIAL_ENV, 'PATH'].sort());
      const written = `${executor.stdout()}\n${executor.stderr()}`;
      assert.ok(written.includes('"mode":"synthetic-execution"'));
      for (const secret of [BEARER, HEADER_CREDENTIAL, 'PRIVATE KEY', 'grantReference', '"amount"', 'agent:release-bot']) assert.equal(written.includes(secret), false, secret);
      for (const value of ISSUED_PRESENTATIONS) assert.equal(written.includes(value.slice(-64)), false, 'a presentation');
    }
  });
});
