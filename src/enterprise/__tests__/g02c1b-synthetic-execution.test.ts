import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { executionCapabilitySigningBytes, serializeExecutionCapability } from '../execution-capability/index.js';
import { EXECUTION_CAPABILITY_PRESENTATION_FORMAT, EXECUTION_CAPABILITY_PRESENTATION_HEADER } from '../execution-capability-presentation/index.js';
import { GENERIC_HTTP_REQUEST_BINDING_FORMAT } from '../execution-adapters/generic-http/request-binding.js';
import { openExecutionCapabilityConsumptionLedger } from '../execution-capability/reference/consumption-ledger.js';
import {
  ReferenceExecutorConfigurationError,
  SYNTHETIC_DEPLOYMENT_RECORD_FORMAT,
  createReferenceExecutorExecutionFlow,
  createReferenceExecutorVerificationPipeline,
  openSyntheticDeploymentEffect,
  parseReferenceExecutorConfiguration,
  referenceExecutorStatusOf,
  type ReferenceExecutorExecution,
  type ReferenceExecutorExecutionFlow,
} from '../reference-executor/index.js';
import {
  ACTION,
  BEARER,
  EXECUTOR_ENVIRONMENT,
  EXECUTOR_ID,
  ISSUER_KEY,
  RESOURCE,
  addRawHeader,
  capabilityFor,
  dropRawHeader,
  executorConfiguration,
  hostVector,
  observedWith,
  presentationFor,
  rawPresentation,
  setRawHeader,
  signatureOver,
} from './g02c1a-reference-executor-fixture.js';
import { SYNTHETIC_ACTION, SYNTHETIC_EFFECT, inProcessFlow, syntheticCapability, syntheticConfiguration, syntheticDomain, type SyntheticDomain } from './g02c1b-synthetic-execution-fixture.js';

/**
 * G-02C1B, in process: the execution flow over a real G-02A ledger and a real
 * synthetic effect, instrumented so the order of claim, effect and outcome is
 * asserted from what happened, not from comments. The separate-process suite
 * (`g02c1b-synthetic-execution-process.test.ts`) runs the same flow behind real
 * HTTP/1.1 bytes, across processes and through crashes.
 */

const VECTOR = hostVector('POST with body and headers', {
  body: { kind: 'json-object', fields: { subject: { kind: 'source', source: 'subject' }, amount: { kind: 'source', source: 'amount.value' } } },
  headers: { 'X-Release-Channel': { kind: 'literal', value: 'stable' } },
});

const domains: SyntheticDomain[] = [];
after(() => {
  for (const domain of domains) domain.cleanup();
});
async function freshDomain(audience?: string): Promise<SyntheticDomain> {
  const domain = await syntheticDomain(audience);
  domains.push(domain);
  return domain;
}

const statusOf = (flow: ReferenceExecutorExecutionFlow, execution: ReferenceExecutorExecution): number =>
  flow.statusOf(execution, (stage, code) => referenceExecutorStatusOf({ mode: 'verification-only', outcome: 'refused', stage, code, bindingDigest: null }));

const brief = (execution: ReferenceExecutorExecution) => ({ outcome: execution.outcome, stage: execution.stage, code: execution.code, ledgerState: execution.ledgerState });

describe('G-02C1B — claim before effect, observed and recorded once', () => {
  it('an eligible synthetic capability is claimed, then performed once, then recorded completed — in that order', async () => {
    const domain = await freshDomain();
    const world = await inProcessFlow(domain);
    try {
      const { capability, presentation } = syntheticCapability(VECTOR.digest);
      const execution = world.flow.execute(observedWith(VECTOR, { presentation }));
      assert.deepEqual(execution, { mode: 'synthetic-execution', outcome: 'completed-observed', stage: 'effect', code: 'SYNTHETIC_EFFECT_APPLIED', bindingDigest: VECTOR.digest, ledgerState: 'completed' });
      assert.equal(statusOf(world.flow, execution), 201);
      assert.deepEqual(world.events, [
        'before-claim',
        'claim',
        'claim:claimed',
        'after-claim',
        'after-expiry-check',
        'effect-start',
        'effect-precondition:claimed',
        'during-effect',
        'effect:completed',
        'after-effect',
        'record:completed',
        'after-outcome',
      ]);
      assert.equal((await domain.state(capability.capabilityId)).state, 'completed');
      assert.deepEqual(domain.records(), [`${capability.capabilityId}.json`]);
      const text = domain.recordText(capability.capabilityId) ?? '';
      const written = JSON.parse(text) as Record<string, unknown>;
      assert.deepEqual(Object.keys(written).sort(), ['attemptedAt', 'audience', 'bindingDigest', 'capabilityId', 'claimedAt', 'executionId', 'executorId', 'format', 'issuer', 'observed', 'operation', 'target']);
      assert.deepEqual(
        { format: written['format'], executorId: written['executorId'], capabilityId: written['capabilityId'], executionId: written['executionId'], operation: written['operation'], target: written['target'], bindingDigest: written['bindingDigest'], observed: written['observed'] },
        { format: SYNTHETIC_DEPLOYMENT_RECORD_FORMAT, executorId: EXECUTOR_ID, capabilityId: capability.capabilityId, executionId: capability.executionId, operation: SYNTHETIC_ACTION, target: RESOURCE, bindingDigest: VECTOR.digest, observed: 'applied' },
      );
      for (const secret of [BEARER, presentation.slice(0, 40), serializeExecutionCapability(capability), 'grantReference', '7500']) assert.equal(text.includes(secret), false, 'the record holds no secret, capability or body');
    } finally {
      world.close();
    }
  });

  it('a second delivery — the same capability, or another capability for the same execution — is answered from the ledger and performs nothing', async () => {
    const domain = await freshDomain();
    const world = await inProcessFlow(domain);
    try {
      const { capability, presentation } = syntheticCapability(VECTOR.digest);
      assert.equal(world.flow.execute(observedWith(VECTOR, { presentation })).outcome, 'completed-observed');
      world.events.length = 0;
      const again = world.flow.execute(observedWith(VECTOR, { presentation }));
      assert.deepEqual(brief(again), { outcome: 'already-consumed', stage: 'claim', code: 'CAPABILITY_CONSUMED', ledgerState: 'completed' });
      assert.equal(statusOf(world.flow, again), 202, 'never a success status');
      const sameExecution = world.flow.execute(observedWith(VECTOR, { presentation: syntheticCapability(VECTOR.digest, { executionId: capability.executionId }).presentation }));
      assert.deepEqual(brief(sameExecution), { outcome: 'already-consumed', stage: 'claim', code: 'EXECUTION_CONSUMED', ledgerState: 'completed' });
      assert.equal(world.events.includes('effect-start'), false, 'no effect for a duplicate');
      assert.deepEqual(domain.records(), [`${capability.capabilityId}.json`]);
    } finally {
      world.close();
    }
  });

  it('a consumed capability presented with a changed body, path, header or audience is refused before the ledger, and the ledger keeps its answer', async () => {
    const domain = await freshDomain();
    const world = await inProcessFlow(domain);
    try {
      const { capability, presentation } = syntheticCapability(VECTOR.digest);
      world.flow.execute(observedWith(VECTOR, { presentation }));
      world.events.length = 0;
      for (const options of [
        { presentation, body: Buffer.from(VECTOR.request.body?.replace('7500', '7501') ?? '', 'utf8') },
        { presentation, target: VECTOR.request.path.replace(RESOURCE, 'cluster-eu-2') },
        { presentation, edit: (raw: string[]) => setRawHeader(raw, 'x-release-channel', 'canary') },
      ]) {
        assert.deepEqual(brief(world.flow.execute(observedWith(VECTOR, options))), { outcome: 'refused', stage: 'verification', code: 'ACTION_BINDING_MISMATCH', ledgerState: null });
      }
      assert.equal(world.events.includes('claim'), false);
      assert.equal((await domain.state(capability.capabilityId)).state, 'completed');
      assert.equal(domain.records().length, 1);
    } finally {
      world.close();
    }
  });

  it('after a terminal failure, and while an outcome is unknown, a redelivery performs nothing', async () => {
    const domain = await freshDomain();
    let crashDuringEffect = false;
    const world = await inProcessFlow(domain, {
      fault: (point) => {
        if (point === 'during-effect' && crashDuringEffect) throw new Error('the write failed half-way');
      },
    });
    try {
      // Terminal failure: a record already holds the name (the target refuses).
      const failing = syntheticCapability(VECTOR.digest);
      writeFileSync(join(domain.outputDirectory, `${failing.capability.capabilityId}.json`), 'pre-existing\n', { mode: 0o600 });
      assert.deepEqual(brief(world.flow.execute(observedWith(VECTOR, { presentation: failing.presentation }))), { outcome: 'failed-observed', stage: 'effect', code: 'SYNTHETIC_EFFECT_REFUSED', ledgerState: 'failed' });
      assert.equal(domain.recordText(failing.capability.capabilityId), 'pre-existing\n', 'the existing file is untouched');
      // Unknown: the write fails after the file was created.
      crashDuringEffect = true;
      const unknown = syntheticCapability(VECTOR.digest);
      const execution = world.flow.execute(observedWith(VECTOR, { presentation: unknown.presentation }));
      assert.deepEqual(brief(execution), { outcome: 'attempted-outcome-unknown', stage: 'effect', code: 'SYNTHETIC_EFFECT_UNCONFIRMED', ledgerState: 'outcome-unknown' });
      assert.equal(statusOf(world.flow, execution), 502);
      assert.ok(existsSync(join(domain.outputDirectory, `${unknown.capability.capabilityId}.json`)), 'a partial record may exist');
      crashDuringEffect = false;
      world.events.length = 0;
      assert.deepEqual(brief(world.flow.execute(observedWith(VECTOR, { presentation: failing.presentation }))), { outcome: 'already-consumed', stage: 'claim', code: 'CAPABILITY_CONSUMED', ledgerState: 'failed' });
      assert.deepEqual(brief(world.flow.execute(observedWith(VECTOR, { presentation: unknown.presentation }))), { outcome: 'already-consumed', stage: 'claim', code: 'CAPABILITY_CONSUMED', ledgerState: 'outcome-unknown' });
      assert.equal(world.events.includes('effect-start'), false, 'no retry, no re-execution');
      assert.equal((await domain.state(unknown.capability.capabilityId)).state, 'outcome-unknown', 'never turned into completed');
    } finally {
      world.close();
    }
  });
});

describe('G-02C1B — nothing that fails verification or policy can claim, and the effect never runs', () => {
  it('every refusal leaves the ledger and the output directory untouched', async () => {
    const domain = await freshDomain();
    const world = await inProcessFlow(domain);
    try {
      const forge = () => {
        const capability = capabilityFor(VECTOR.digest, { action: SYNTHETIC_ACTION });
        const signature = signatureOver(executionCapabilitySigningBytes(capability), ISSUER_KEY);
        const bytes = Buffer.from(signature.signature, 'base64url');
        bytes[0] = (bytes[0] ?? 0) ^ 0x01;
        return { capability, presentation: rawPresentation({ bindingFormat: GENERIC_HTTP_REQUEST_BINDING_FORMAT, capability: serializeExecutionCapability(capability), format: EXECUTION_CAPABILITY_PRESENTATION_FORMAT, signature: { ...signature, signature: bytes.toString('base64url') } }) };
      };
      const iso = (offset: number): string => new Date(Date.now() + offset).toISOString();
      const cases: readonly (readonly [string, { readonly capability: { readonly capabilityId: string }; readonly presentation: string }, Parameters<typeof observedWith>[1], string])[] = [
        ['an invalid signature', forge(), {}, 'SIGNATURE_INVALID'],
        ['an unknown issuer', syntheticCapability(VECTOR.digest, { issuer: 'frontera-deployment-unknown' }), {}, 'ISSUER_NOT_PINNED'],
        ['another audience', syntheticCapability(VECTOR.digest, { audience: 'executor-elsewhere' }), {}, 'AUDIENCE_NOT_THIS_EXECUTOR'],
        ['another organization (cross-organization replay)', syntheticCapability(VECTOR.digest, { organizationId: 'org-elsewhere' }), {}, 'ORGANIZATION_NOT_PERMITTED'],
        ['expired', syntheticCapability(VECTOR.digest, { issuedAt: iso(-40_000), expiresAt: iso(-10_000) }), {}, 'CAPABILITY_EXPIRED'],
        ['status-required', syntheticCapability(VECTOR.digest, { statusRequirement: 'online-status-required' }), {}, 'STATUS_REQUIRED_UNAVAILABLE'],
        ['an altered body', syntheticCapability(VECTOR.digest), { body: Buffer.from(VECTOR.request.body?.replace('7500', '7501') ?? '', 'utf8') }, 'ACTION_BINDING_MISMATCH'],
        ['an altered target', syntheticCapability(VECTOR.digest), { target: VECTOR.request.path.replace(RESOURCE, 'cluster-eu-2') }, 'ACTION_BINDING_MISMATCH'],
        ['an altered header', syntheticCapability(VECTOR.digest), { edit: (raw: string[]) => setRawHeader(raw, 'x-release-channel', 'canary') }, 'ACTION_BINDING_MISMATCH'],
        ['a duplicated presentation header', syntheticCapability(VECTOR.digest), { edit: (raw: string[]) => addRawHeader(raw, EXECUTION_CAPABILITY_PRESENTATION_HEADER, 'AAAA') }, 'HEADER_DUPLICATED'],
        ['no credential', syntheticCapability(VECTOR.digest), { edit: (raw: string[]) => dropRawHeader(raw, 'authorization') }, 'CLIENT_CREDENTIAL_MISSING'],
        ['a wrong credential', syntheticCapability(VECTOR.digest), { edit: (raw: string[]) => setRawHeader(raw, 'authorization', 'Bearer not-the-gateway-credential') }, 'CLIENT_UNAUTHENTICATED'],
        ['a permitted action that is not synthetic', syntheticCapability(VECTOR.digest, { action: ACTION }), {}, 'ACTION_NOT_SYNTHETIC'],
      ];
      for (const [name, { capability, presentation }, options, code] of cases) {
        world.events.length = 0;
        const execution = world.flow.execute(observedWith(VECTOR, { ...options, presentation }));
        assert.ok(execution.outcome === 'refused' || execution.outcome === 'assessed-ineligible', name);
        assert.equal(execution.code, code, name);
        assert.equal(execution.ledgerState, null, name);
        assert.ok(statusOf(world.flow, execution) >= 400 && statusOf(world.flow, execution) < 500, name);
        assert.equal(world.events.includes('claim'), false, `${name}: no claim`);
        assert.equal(world.events.includes('effect-start'), false, `${name}: no effect`);
        assert.equal((await domain.state(capability.capabilityId)).state, 'absent', name);
      }
      assert.deepEqual(domain.records(), []);
    } finally {
      world.close();
    }
  });

  it('a capability that expires after its claim is recorded failed and never performed', async () => {
    const domain = await freshDomain();
    let offset = 0;
    const world = await inProcessFlow(domain, {
      clock: () => Date.now() + offset,
      fault: (point) => {
        if (point === 'after-claim') offset = 40_000;
      },
    });
    try {
      const { capability, presentation } = syntheticCapability(VECTOR.digest);
      const execution = world.flow.execute(observedWith(VECTOR, { presentation }));
      assert.deepEqual(brief(execution), { outcome: 'consumed-not-attempted', stage: 'expiry', code: 'CAPABILITY_EXPIRED_AFTER_CLAIM', ledgerState: 'failed' });
      assert.equal(statusOf(world.flow, execution), 422);
      assert.equal(world.events.includes('effect-start'), false);
      assert.equal((await domain.state(capability.capabilityId)).state, 'failed');
      assert.deepEqual(domain.records(), []);
    } finally {
      world.close();
    }
  });

  it('a ledger that cannot take the claim lock refuses conservatively and performs nothing; the capability stays unconsumed', async () => {
    const domain = await freshDomain();
    const world = await inProcessFlow(domain, { busyTimeoutMs: 50 });
    const { default: Database } = await import('better-sqlite3');
    const holder = new Database(domain.ledgerPath);
    try {
      holder.prepare('BEGIN IMMEDIATE').run();
      const { capability, presentation } = syntheticCapability(VECTOR.digest);
      const execution = world.flow.execute(observedWith(VECTOR, { presentation }));
      assert.deepEqual(brief(execution), { outcome: 'claim-unavailable', stage: 'claim', code: 'LEDGER_UNAVAILABLE', ledgerState: null });
      assert.equal(statusOf(world.flow, execution), 503);
      assert.equal(world.events.includes('effect-start'), false);
      holder.prepare('ROLLBACK').run();
      assert.equal((await domain.state(capability.capabilityId)).state, 'absent', 'nothing was consumed');
      assert.equal(world.flow.execute(observedWith(VECTOR, { presentation })).outcome, 'completed-observed', 'the next delivery claims it');
    } finally {
      holder.close();
      world.close();
    }
  });

  it('an outcome the ledger cannot record is answered as unknown, whatever was observed — never as completed', async () => {
    const domain = await freshDomain();
    const world = await inProcessFlow(domain, {
      recordOutcome: () => {
        throw new Error('the ledger is gone');
      },
    });
    try {
      const { capability, presentation } = syntheticCapability(VECTOR.digest);
      const execution = world.flow.execute(observedWith(VECTOR, { presentation }));
      assert.deepEqual(brief(execution), { outcome: 'attempted-outcome-unknown', stage: 'outcome', code: 'OUTCOME_NOT_RECORDED', ledgerState: 'claimed' });
      assert.equal(statusOf(world.flow, execution), 502);
      assert.equal((await domain.state(capability.capabilityId)).state, 'claimed', 'the claim stays: authorized and possibly attempted');
      assert.equal(domain.records().length, 1, 'the effect did happen; only its record is missing');
    } finally {
      world.close();
    }
  });
});

describe('G-02C1B — the synthetic effect is contained', () => {
  it('a planted link at the record name is never followed, and an existing record is never overwritten', async () => {
    const domain = await freshDomain();
    const world = await inProcessFlow(domain);
    try {
      const outside = join(domain.root, 'outside.txt');
      writeFileSync(outside, 'outside\n');
      const { capability, presentation } = syntheticCapability(VECTOR.digest);
      symlinkSync(outside, join(domain.outputDirectory, `${capability.capabilityId}.json`));
      assert.deepEqual(brief(world.flow.execute(observedWith(VECTOR, { presentation }))), { outcome: 'failed-observed', stage: 'effect', code: 'SYNTHETIC_EFFECT_REFUSED', ledgerState: 'failed' });
      assert.equal(readFileSync(outside, 'utf8'), 'outside\n');
    } finally {
      world.close();
    }
  });

  it('a directory swapped for a link after boot is not written', async () => {
    const domain = await freshDomain();
    const world = await inProcessFlow(domain);
    const elsewhere = join(domain.root, 'elsewhere');
    try {
      mkdirSync(elsewhere, { mode: 0o700 });
      renameSync(domain.outputDirectory, join(domain.root, 'moved'));
      symlinkSync(elsewhere, domain.outputDirectory);
      const { capability, presentation } = syntheticCapability(VECTOR.digest);
      assert.deepEqual(brief(world.flow.execute(observedWith(VECTOR, { presentation }))), { outcome: 'consumed-not-attempted', stage: 'effect', code: 'EFFECT_NOT_ATTEMPTED', ledgerState: 'failed' });
      assert.equal(existsSync(join(elsewhere, `${capability.capabilityId}.json`)), false);
    } finally {
      world.close();
    }
  });

  it('the effect names files only from a 64-hex capability id, and refuses without a durable claim', async () => {
    const domain = await freshDomain();
    const input = (capabilityId: string) => ({ executorId: EXECUTOR_ID, audience: 'a', issuer: 'i', capabilityId, executionId: 'e', operation: SYNTHETIC_ACTION, target: RESOURCE, bindingDigest: VECTOR.digest, claimedAt: 'c', attemptedAt: 'a' });
    const claimedEverything = openSyntheticDeploymentEffect({ outputDirectory: domain.outputDirectory, durablyClaimed: () => true });
    for (const id of ['../escaped', `../${'a'.repeat(64)}`, '/tmp/absolute', `${'a'.repeat(63)}/`, 'A'.repeat(64), '']) assert.equal(claimedEverything.apply(input(id)), 'not-attempted', JSON.stringify(id));
    assert.equal(existsSync(join(domain.root, 'escaped.json')), false);
    const claimedNothing = openSyntheticDeploymentEffect({ outputDirectory: domain.outputDirectory, durablyClaimed: () => false });
    assert.equal(claimedNothing.apply(input('b'.repeat(64))), 'not-attempted');
    assert.deepEqual(domain.records(), []);
  });

  it('boot refuses an output directory that is missing, a file, a link, reached through a link, or writable by others', async () => {
    const domain = await freshDomain();
    const file = join(domain.root, 'file');
    writeFileSync(file, '');
    const link = join(domain.root, 'link');
    symlinkSync(domain.outputDirectory, link);
    const open = join(domain.root, 'open');
    mkdirSync(open);
    chmodSync(open, 0o777);
    for (const outputDirectory of [join(domain.root, 'missing'), file, link, open]) {
      assert.throws(() => openSyntheticDeploymentEffect({ outputDirectory, durablyClaimed: () => true }), /synthetic/, outputDirectory);
    }
    const linkedParent = join(domain.root, 'linked-parent');
    symlinkSync(domain.root, linkedParent);
    assert.throws(() => openSyntheticDeploymentEffect({ outputDirectory: join(linkedParent, 'output'), durablyClaimed: () => true }), /synthetic/);
  });
});

describe('G-02C1B — rollback and ledger identity', () => {
  it('a restored older ledger re-enables a consumed capability: rollback is not prevented (only this synthetic record’s exclusive name refuses the second write)', async () => {
    const domain = await freshDomain();
    const backup = join(domain.root, 'ledger-before.sqlite');
    copyFileSync(domain.ledgerPath, backup);
    const { capability, presentation } = syntheticCapability(VECTOR.digest);
    const first = await inProcessFlow(domain);
    assert.equal(first.flow.execute(observedWith(VECTOR, { presentation })).outcome, 'completed-observed');
    first.close();
    const recordBefore = domain.recordText(capability.capabilityId);
    for (const suffix of ['-wal', '-shm']) rmSync(`${domain.ledgerPath}${suffix}`, { force: true });
    copyFileSync(backup, domain.ledgerPath);
    const restored = await inProcessFlow(domain);
    try {
      const again = restored.flow.execute(observedWith(VECTOR, { presentation }));
      assert.ok(restored.events.includes('claim:claimed'), 'the restored ledger let the capability be claimed again');
      assert.deepEqual(brief(again), { outcome: 'failed-observed', stage: 'effect', code: 'SYNTHETIC_EFFECT_REFUSED', ledgerState: 'failed' });
      assert.equal(domain.recordText(capability.capabilityId), recordBefore);
    } finally {
      restored.close();
    }
  });

  it('a flow refuses a ledger pinned to another audience', async () => {
    const domain = await freshDomain('executor-elsewhere');
    await assert.rejects(inProcessFlow(domain), /another audience/);
    const ledger = await openExecutionCapabilityConsumptionLedger(domain.ledgerPath, { audience: 'executor-elsewhere', clock: () => Date.now() });
    try {
      const configuration = parseReferenceExecutorConfiguration(syntheticConfiguration(domain), EXECUTOR_ENVIRONMENT);
      const effect = openSyntheticDeploymentEffect({ outputDirectory: domain.outputDirectory, durablyClaimed: () => false });
      assert.throws(() => createReferenceExecutorExecutionFlow({ configuration, pipeline: createReferenceExecutorVerificationPipeline(configuration, () => Date.now()), ledger, effect, clock: () => Date.now() }), /another audience/);
    } finally {
      ledger.close();
    }
  });
});

describe('G-02C1B — the closed mode', () => {
  it('a G-02C1A configuration is verification-only, with no synthetic section and no fault injection', () => {
    const configuration = parseReferenceExecutorConfiguration(executorConfiguration(), EXECUTOR_ENVIRONMENT);
    assert.deepEqual([configuration.mode, configuration.syntheticExecution, configuration.faultInjection], ['verification-only', null, null]);
    assert.equal(parseReferenceExecutorConfiguration(executorConfiguration({ mode: 'verification-only' }), EXECUTOR_ENVIRONMENT).mode, 'verification-only');
  });

  it('no field enables an effect on its own, and the synthetic section is closed and strict', () => {
    const domain = { ledgerPath: '/var/lib/frontera-ref/ledger/consumption.sqlite', outputDirectory: '/var/lib/frontera-ref/output' };
    const section = (overrides: Record<string, unknown>) => ({ effect: SYNTHETIC_EFFECT, consumptionLedgerPath: domain.ledgerPath, outputDirectory: domain.outputDirectory, syntheticActions: [SYNTHETIC_ACTION], ...overrides });
    const refused = (raw: Record<string, unknown>): string => {
      try {
        parseReferenceExecutorConfiguration(raw, EXECUTOR_ENVIRONMENT);
      } catch (error) {
        assert.ok(error instanceof ReferenceExecutorConfigurationError);
        return error.code;
      }
      return 'accepted';
    };
    assert.equal(parseReferenceExecutorConfiguration(syntheticConfiguration(domain), EXECUTOR_ENVIRONMENT).mode, 'synthetic-execution');
    const cases: readonly (readonly [string, Record<string, unknown>, string])[] = [
      ['an unknown mode', executorConfiguration({ mode: 'execute' }), 'MODE_UNSUPPORTED'],
      ['a synthetic section without the mode', executorConfiguration({ syntheticExecution: section({}) }), 'MODE_INCONSISTENT'],
      ['a synthetic section in verification-only mode', executorConfiguration({ mode: 'verification-only', syntheticExecution: section({}) }), 'MODE_INCONSISTENT'],
      ['synthetic mode without its section', executorConfiguration({ mode: 'synthetic-execution' }), 'MODE_INCONSISTENT'],
      ['fault injection outside synthetic mode', executorConfiguration({ faultInjection: { crashAt: 'after-claim' } }), 'MODE_INCONSISTENT'],
      ['an unknown fault point', syntheticConfiguration(domain, { faultInjection: { crashAt: 'whenever' } }), 'FAULT_INJECTION_INVALID'],
      ['another effect', syntheticConfiguration(domain, { syntheticExecution: section({ effect: 'frontera.kubernetes-deploy.v1' }) }), 'SYNTHETIC_EXECUTION_INVALID'],
      ['an unknown section key', syntheticConfiguration(domain, { syntheticExecution: section({ webhook: 'https://example.com' }) }), 'CONFIGURATION_UNKNOWN_KEY'],
      ['a relative ledger path', syntheticConfiguration(domain, { syntheticExecution: section({ consumptionLedgerPath: 'ledger.sqlite' }) }), 'SYNTHETIC_EXECUTION_INVALID'],
      ['a non-normalized output path', syntheticConfiguration(domain, { syntheticExecution: section({ outputDirectory: '/var/lib/frontera-ref/x/../output' }) }), 'SYNTHETIC_EXECUTION_INVALID'],
      ['a trailing separator', syntheticConfiguration(domain, { syntheticExecution: section({ outputDirectory: '/var/lib/frontera-ref/output/' }) }), 'SYNTHETIC_EXECUTION_INVALID'],
      ['records beside the ledger', syntheticConfiguration(domain, { syntheticExecution: section({ outputDirectory: '/var/lib/frontera-ref/ledger' }) }), 'SYNTHETIC_EXECUTION_INVALID'],
      ['the ledger inside the records', syntheticConfiguration(domain, { syntheticExecution: section({ consumptionLedgerPath: '/var/lib/frontera-ref/output/ledger.sqlite' }) }), 'SYNTHETIC_EXECUTION_INVALID'],
      ['records inside the ledger directory', syntheticConfiguration(domain, { syntheticExecution: section({ outputDirectory: '/var/lib/frontera-ref/ledger/records' }) }), 'SYNTHETIC_EXECUTION_INVALID'],
      ['an action not named synthetic', syntheticConfiguration(domain, { syntheticExecution: section({ syntheticActions: [ACTION] }) }), 'SYNTHETIC_EXECUTION_INVALID'],
      ['a synthetic action that is not permitted', syntheticConfiguration(domain, { syntheticExecution: section({ syntheticActions: ['synthetic.drop-cluster'] }) }), 'SYNTHETIC_EXECUTION_INVALID'],
      ['the bare prefix', syntheticConfiguration(domain, { permittedActions: [ACTION, 'synthetic.'], syntheticExecution: section({ syntheticActions: ['synthetic.'] }) }), 'SYNTHETIC_EXECUTION_INVALID'],
      ['no synthetic action', syntheticConfiguration(domain, { syntheticExecution: section({ syntheticActions: [] }) }), 'SYNTHETIC_EXECUTION_INVALID'],
    ];
    for (const [name, raw, code] of cases) assert.equal(refused(raw), code, name);
  });
});
