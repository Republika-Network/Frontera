import { chmodSync, copyFileSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash, createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AUTHORITY_ARTIFACT_VERSION } from '../authority-authenticity/index.js';
import { EXECUTION_CAPABILITY_SIGNING_DOMAIN } from '../execution-capability/index.js';
import { openExecutionCapabilityConsumptionLedger } from '../execution-capability/reference/consumption-ledger.js';
import { EXECUTOR_RECEIPT_SIGNING_DOMAIN, createExecutorReceiptVerifier, parseExecutorReceipt, positionExecutorReceipt, serializeExecutorReceipt, type ExecutorReceipt } from '../executor-receipt/index.js';
import { canonicalSerialize } from '../governance-store/canonical-json.js';
import { receiptOutcomeFor } from '../reference-executor/receipt-issuer.js';
import { ExecutorReceiptConflictError, openExecutorReceiptLedger } from '../reference-executor/receipt-ledger.js';
import { loadExecutorReceiptSigner } from '../reference-executor/receipt-signer.js';
import { AUDIENCE, EXECUTOR_ID, ISSUER_KEY, ORGANIZATION, TRUST_DOMAIN, hostVector, observedWith } from './g02c1a-reference-executor-fixture.js';
import { syntheticCapability } from './g02c1b-synthetic-execution-fixture.js';
import { BINDING_FORMAT, ISSUER_PINS, RECEIPT_KEY_ID, generateReceiptKey, receiptDomain, receiptWorld, trustedExecutor, type ReceiptDomain, type ReceiptWorld } from './g02c1c-executor-receipt-fixture.js';

/**
 * G-02C1C, in process: the receipt contract, the standalone verifier, the
 * receipt ledger, the signer's custody rules, issuance from durable state,
 * supersession, idempotent recovery and the crash points of the receipt path.
 * The separate-process suite (`g02c1c-executor-receipt-process.test.ts`)
 * repeats the essentials with the key held only by the executor process.
 */

const VECTOR = hostVector('POST with body and headers', {
  body: { kind: 'json-object', fields: { subject: { kind: 'source', source: 'subject' }, amount: { kind: 'source', source: 'amount.value' } } },
  headers: { 'X-Release-Channel': { kind: 'literal', value: 'stable' } },
});

const domains: ReceiptDomain[] = [];
after(() => {
  for (const domain of domains) domain.cleanup();
});
async function freshDomain(): Promise<ReceiptDomain> {
  const domain = await receiptDomain();
  domains.push(domain);
  return domain;
}

/** Runs one delivery through `world`; a fault that throws is a crash at that point, and leaves durable state as it was. */
function deliver(world: ReceiptWorld, presentation: string): void {
  try {
    world.flow.execute(observedWith(VECTOR, { presentation }));
  } catch {
    // A crash injected at a fault point.
  }
}

/** A receipt signed by `keyFile`'s key (read here only to forge), over `domain` + the canonical text. */
function forged(keyFile: string, receipt: unknown, options: { readonly domain?: string; readonly keyId?: string; readonly text?: string } = {}): { readonly receipt: string; readonly signature: Record<string, string> } {
  const text = options.text ?? canonicalSerialize(receipt);
  const key = createPrivateKey(readFileSync(keyFile, 'utf8'));
  const signature = sign(null, Buffer.from(`${options.domain ?? EXECUTOR_RECEIPT_SIGNING_DOMAIN}${text}`, 'utf8'), key).toString('base64url');
  return { receipt: text, signature: { algorithm: 'ed25519-v1', artifactVersion: AUTHORITY_ARTIFACT_VERSION, keyId: options.keyId ?? RECEIPT_KEY_ID, signature } };
}

async function completedReceipt(domain: ReceiptDomain): Promise<{ readonly world: ReceiptWorld; readonly capabilityId: string; readonly presented: { readonly receipt: string; readonly signature: Readonly<Record<string, string>> } }> {
  const world = await receiptWorld(domain);
  const { capability, presentation } = syntheticCapability(VECTOR.digest);
  deliver(world, presentation);
  const history = world.receipts.history(capability.capabilityId);
  assert.equal(history.length, 1);
  return { world, capabilityId: capability.capabilityId, presented: history[0] as { readonly receipt: string; readonly signature: Readonly<Record<string, string>> } };
}

describe('G-02C1C — a receipt for what the execution path observed, from durable state', () => {
  it('a completed synthetic execution yields one signed receipt naming the executor, capability, binding, consumption, outcome and evidence', async () => {
    const domain = await freshDomain();
    const { world, capabilityId, presented } = await completedReceipt(domain);
    try {
      const receipt = parseExecutorReceipt(presented.receipt);
      assert.ok(receipt.ok);
      const r = receipt.receipt;
      const detail = world.ledger.readDetail(capabilityId);
      assert.ok(detail.state === 'completed');
      assert.deepEqual(
        { executorId: r.executorId, executorKeyId: r.executorKeyId, audience: r.audience, organizationId: r.organizationId, trustDomain: r.trustDomain, binding: r.actionBinding, consumption: r.consumption, outcome: r.outcome, basis: r.basis, observedAt: r.observedAt, sequence: r.sequence, supersedes: r.supersedes },
        { executorId: EXECUTOR_ID, executorKeyId: RECEIPT_KEY_ID, audience: AUDIENCE, organizationId: ORGANIZATION, trustDomain: TRUST_DOMAIN, binding: { format: BINDING_FORMAT, digest: VECTOR.digest }, consumption: { claimedAt: detail.claimedAt, ledgerState: 'completed' }, outcome: 'completed-observed', basis: 'durable-state', observedAt: detail.outcomeRecordedAt, sequence: 1, supersedes: null },
      );
      const bytes = readFileSync(join(domain.outputDirectory, `${capabilityId}.json`));
      assert.deepEqual(r.observation, { kind: 'frontera.synthetic-deployment-record.v1', reference: `${capabilityId}.json`, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` });
      const verification = domain.verifier.verify(presented, { expected: { executorId: EXECUTOR_ID, capabilityId, issuer: r.issuer, executionId: r.executionId, audience: AUDIENCE, organizationId: ORGANIZATION, trustDomain: TRUST_DOMAIN, actionBinding: { format: BINDING_FORMAT, digest: VECTOR.digest } }, history: world.receipts.history(capabilityId) });
      assert.deepEqual(
        { ...verification, receipt: verification.receipt === null ? null : 'present' },
        { canonical: 'valid', executorTrust: 'trusted', signature: 'valid', scope: 'permitted', identityMatch: 'yes', bindingMatch: 'yes', receiptState: 'current', reportedOutcome: 'completed-observed', externalConfirmation: 'not-established', issuedHere: 'not-evaluated', failure: null, receipt: 'present' },
      );
      for (const secret of ['PRIVATE KEY', 'grantReference', 'agent:release-bot', 'authorization', 'Bearer']) assert.equal(presented.receipt.includes(secret), false, secret);
    } finally {
      world.close();
    }
  });

  it('the outcome is exact where the ledger or the execution path knows it, and conservative where it does not', async () => {
    assert.deepEqual(receiptOutcomeFor('completed'), { outcome: 'completed-observed', basis: 'durable-state' });
    assert.deepEqual(receiptOutcomeFor('failed', 'failed-observed'), { outcome: 'failed-observed', basis: 'execution-path' });
    assert.deepEqual(receiptOutcomeFor('failed', 'consumed-not-attempted'), { outcome: 'consumed-not-attempted', basis: 'execution-path' });
    assert.deepEqual(receiptOutcomeFor('failed'), { outcome: 'attempted-outcome-unknown', basis: 'durable-state' });
    assert.deepEqual(receiptOutcomeFor('failed', 'completed-observed'), { outcome: 'attempted-outcome-unknown', basis: 'durable-state' }, 'an observation the ledger contradicts is ignored');
    assert.deepEqual(receiptOutcomeFor('outcome-unknown', 'completed-observed'), { outcome: 'attempted-outcome-unknown', basis: 'durable-state' });
    assert.deepEqual(receiptOutcomeFor('claimed', 'completed-observed'), { outcome: 'attempted-outcome-unknown', basis: 'durable-state' }, 'completed is never inferred from a claim');

    const domain = await freshDomain();
    let expire = false;
    let offset = 0;
    let breakWrite = false;
    const world = await receiptWorld(domain, {
      clock: () => Date.now() + offset,
      fault: (point) => {
        if (point === 'after-claim' && expire) offset = 40_000;
        if (point === 'during-effect' && breakWrite) throw new Error('the write failed half-way');
      },
    });
    try {
      const outcomeOf = (capabilityId: string): ExecutorReceipt | undefined => {
        const parsed = parseExecutorReceipt(world.receipts.history(capabilityId)[0]?.receipt);
        return parsed.ok ? parsed.receipt : undefined;
      };
      // Failed, observed: the target refused the create.
      const refusedCreate = syntheticCapability(VECTOR.digest);
      chmodSync(domain.outputDirectory, 0o500);
      try {
        deliver(world, refusedCreate.presentation);
      } finally {
        chmodSync(domain.outputDirectory, 0o700);
      }
      assert.deepEqual([outcomeOf(refusedCreate.capability.capabilityId)?.outcome, outcomeOf(refusedCreate.capability.capabilityId)?.basis], ['failed-observed', 'execution-path']);
      // Consumed, not attempted: expired after the claim.
      expire = true;
      const expired = syntheticCapability(VECTOR.digest);
      deliver(world, expired.presentation);
      expire = false;
      offset = 0;
      assert.equal(outcomeOf(expired.capability.capabilityId)?.outcome, 'consumed-not-attempted');
      // Unknown: the write failed after creation.
      breakWrite = true;
      const unknown = syntheticCapability(VECTOR.digest);
      deliver(world, unknown.presentation);
      breakWrite = false;
      assert.deepEqual([outcomeOf(unknown.capability.capabilityId)?.outcome, outcomeOf(unknown.capability.capabilityId)?.consumption.ledgerState], ['attempted-outcome-unknown', 'outcome-unknown']);
      // No consumption, no receipt.
      assert.deepEqual(world.issuer.issue('f'.repeat(64)), { status: 'refused', code: 'NOT_CONSUMED' });
    } finally {
      world.close();
    }
  });

  it('a failed row recovered without the execution path’s observation is unknown, never guessed', async () => {
    const domain = await freshDomain();
    // The in-path receipt is lost before construction: only the durable `failed` remains.
    const world = await receiptWorld(domain, {
      receiptFault: (point) => {
        if (point === 'before-receipt') throw new Error('crash before the receipt');
      },
    });
    const { capability, presentation } = syntheticCapability(VECTOR.digest);
    try {
      chmodSync(domain.outputDirectory, 0o500);
      try {
        deliver(world, presentation);
      } finally {
        chmodSync(domain.outputDirectory, 0o700);
      }
      assert.equal(world.ledger.readDetail(capability.capabilityId).state, 'failed');
      assert.equal(world.receipts.latest(capability.capabilityId), undefined);
    } finally {
      world.close();
    }
    const consumption = await openExecutionCapabilityConsumptionLedger(domain.ledgerPath, { audience: AUDIENCE, clock: () => Date.now() });
    consumption.close();
    const recovery = await receiptWorld(domain);
    try {
      const issued = recovery.issuer.issue(capability.capabilityId);
      assert.ok(issued.status === 'issued');
      const parsed = parseExecutorReceipt(issued.receipt.receipt);
      assert.ok(parsed.ok);
      assert.deepEqual([parsed.receipt.outcome, parsed.receipt.basis, parsed.receipt.consumption.ledgerState], ['attempted-outcome-unknown', 'durable-state', 'failed']);
    } finally {
      recovery.close();
    }
  });

  it('completed is never signed without the synthetic record that names this capability and binding', async () => {
    const domain = await freshDomain();
    const world = await receiptWorld(domain, {
      receiptFault: (point) => {
        if (point === 'before-receipt') throw new Error('no in-path receipt');
      },
    });
    try {
      const { capability, presentation } = syntheticCapability(VECTOR.digest);
      deliver(world, presentation);
      assert.equal(world.ledger.readDetail(capability.capabilityId).state, 'completed');
      assert.equal(world.receipts.latest(capability.capabilityId), undefined, 'the in-path receipt was lost before construction');
      const record = join(domain.outputDirectory, `${capability.capabilityId}.json`);
      const original = readFileSync(record);
      rmSync(record);
      const recover = await receiptWorld(domain);
      try {
        assert.deepEqual(recover.issuer.issue(capability.capabilityId), { status: 'refused', code: 'EVIDENCE_UNAVAILABLE' });
        writeFileSync(record, original.toString('utf8').replace(VECTOR.digest, `sha256:${'0'.repeat(64)}`), { mode: 0o600 });
        assert.deepEqual(recover.issuer.issue(capability.capabilityId), { status: 'refused', code: 'EVIDENCE_UNAVAILABLE' }, 'a record for another binding is not evidence');
        rmSync(record);
        writeFileSync(record, original, { mode: 0o600 });
        const issued = recover.issuer.issue(capability.capabilityId);
        assert.equal(issued.status === 'issued' ? issued.outcome : issued.code, 'completed-observed', 'recovered from durable state, with the record as evidence');
      } finally {
        recover.close();
      }
      assert.equal(domain.records().length, 1, 'recovery never performs the effect');
    } finally {
      world.close();
    }
  });
});

describe('G-02C1C — idempotent, forward-only, crash-safe', () => {
  it('asking again returns the same signed artifact; a stranded claim is unknown; a later forward resolution supersedes it exactly once', async () => {
    const domain = await freshDomain();
    const world = await receiptWorld(domain, {
      fault: (point) => {
        if (point === 'after-effect') throw new Error('crash after the effect, before the outcome');
      },
    });
    try {
      const { capability, presentation } = syntheticCapability(VECTOR.digest);
      deliver(world, presentation);
      const id = capability.capabilityId;
      const detail = world.ledger.readDetail(id);
      assert.ok(detail.state === 'claimed');
      const first = world.issuer.issue(id);
      const again = world.issuer.issue(id);
      assert.ok(first.status === 'issued' && again.status === 'issued');
      assert.deepEqual(again.receipt, first.receipt, 'the same artifact, not a second receipt');
      const one = parseExecutorReceipt(first.receipt.receipt);
      assert.ok(one.ok);
      assert.deepEqual([one.receipt.outcome, one.receipt.consumption.ledgerState, one.receipt.observedAt, one.receipt.sequence], ['attempted-outcome-unknown', 'claimed', detail.claimedAt, 1]);
      // A later forward resolution (a reconciliation outside this milestone, simulated with G-02A's own call).
      assert.equal(world.ledger.recordOutcome(id, 'completed'), 'recorded');
      const second = world.issuer.issue(id);
      assert.ok(second.status === 'issued');
      const two = parseExecutorReceipt(second.receipt.receipt);
      assert.ok(two.ok);
      assert.deepEqual([two.receipt.outcome, two.receipt.sequence, two.receipt.supersedes], ['completed-observed', 2, one.receipt.receiptId]);
      assert.deepEqual(world.issuer.issue(id), second, 'resolved once');
      const history = world.receipts.history(id);
      assert.equal(history.length, 2);
      const assessed = domain.verifier.assessHistory(history);
      assert.deepEqual([assessed.chain, assessed.current], ['valid', two.receipt.receiptId]);
      assert.equal(domain.verifier.verify(first.receipt, { history }).receiptState, 'superseded', 'an old receipt stays authentic and is no longer current');
      assert.equal(domain.verifier.verify(first.receipt).receiptState, 'unknown', 'without history no verifier can say it is current');
      assert.equal(domain.records().length, 1, 'no receipt ever runs the effect');
      // No backward or competing successor.
      assert.throws(() => world.receipts.reserve({ ...two.receipt, consumption: { ...two.receipt.consumption, ledgerState: 'failed' }, outcome: 'attempted-outcome-unknown', basis: 'durable-state', observation: null } as never), ExecutorReceiptConflictError);
    } finally {
      world.close();
    }
  });

  it('a crash at every point of the receipt path recovers to the same receipt, signed byte for byte the same', async () => {
    const outcomes: string[] = [];
    for (const point of ['before-receipt', 'after-receipt-construction', 'after-receipt-reservation', 'after-receipt-signature', 'after-receipt'] as const) {
      const domain = await freshDomain();
      let armed = true;
      const world = await receiptWorld(domain, {
        receiptFault: (at) => {
          if (armed && at === point) {
            armed = false;
            throw new Error(`crash at ${point}`);
          }
        },
      });
      try {
        const { capability, presentation } = syntheticCapability(VECTOR.digest);
        deliver(world, presentation);
        const id = capability.capabilityId;
        const left = world.receipts.latest(id);
        const stateAfterCrash = left === undefined ? 'none' : left.state;
        const expected = { 'before-receipt': 'none', 'after-receipt-construction': 'none', 'after-receipt-reservation': 'reserved', 'after-receipt-signature': 'reserved', 'after-receipt': 'issued' }[point];
        assert.equal(stateAfterCrash, expected, point);
        // The signature a crash lost (after-receipt-signature), or the one recorded (after-receipt), as the signer produced it then.
        const lost = world.signatures[0];
        const recovered = world.issuer.issue(id);
        assert.ok(recovered.status === 'issued', point);
        if (point === 'after-receipt-signature' || point === 'after-receipt') assert.deepEqual(recovered.receipt.signature, lost, `${point}: the signature produced before the crash, reproduced byte for byte`);
        assert.equal(world.receipts.history(id).length, 1, `${point}: one receipt`);
        assert.equal(domain.verifier.verify(recovered.receipt).signature, 'valid');
        assert.equal(domain.records().length, 1, `${point}: the effect ran once`);
        outcomes.push(`${point}:${stateAfterCrash}`);
      } finally {
        world.close();
      }
    }
    assert.equal(outcomes.length, 5);
  });

  it('a receipt ledger restored from an older copy regenerates exactly the receipts it lost — same text, same signature', async () => {
    const domain = await freshDomain();
    const backup = join(domain.root, 'receipts-before.sqlite');
    copyFileSync(domain.receiptLedgerPath, backup);
    const { world, capabilityId, presented } = await completedReceipt(domain);
    world.close();
    for (const suffix of ['-wal', '-shm']) rmSync(`${domain.receiptLedgerPath}${suffix}`, { force: true });
    copyFileSync(backup, domain.receiptLedgerPath);
    const restored = await receiptWorld(domain);
    try {
      assert.equal(restored.receipts.latest(capabilityId), undefined, 'the restored ledger forgot it');
      const again = restored.issuer.issue(capabilityId);
      assert.ok(again.status === 'issued');
      assert.deepEqual(again.receipt, presented);
    } finally {
      restored.close();
    }
  });
});

describe('G-02C1C — the verifier refuses every altered, foreign or misattributed receipt', () => {
  it('every security-relevant field, changed and re-signed or not, makes the receipt unacceptable', async () => {
    const domain = await freshDomain();
    const { world, presented } = await completedReceipt(domain);
    try {
      const original = JSON.parse(presented.receipt) as Record<string, unknown>;
      const set = (path: string, value: unknown): Record<string, unknown> => {
        const copy = JSON.parse(presented.receipt) as Record<string, Record<string, unknown>>;
        const [head, tail] = path.split('.');
        if (tail === undefined) (copy as Record<string, unknown>)[head as string] = value;
        else (copy[head as string] as Record<string, unknown>)[tail] = value;
        return copy;
      };
      const mutations: readonly (readonly [string, unknown])[] = [
        ['receiptId', 'a'.repeat(64)],
        ['executorId', 'reference-executor-other'],
        ['executorKeyId', 'g02c1c-other-key'],
        ['issuer', 'frontera-deployment-other'],
        ['capabilityId', 'b'.repeat(64)],
        ['executionId', 'aoc.exec:other'],
        ['audience', 'executor-elsewhere'],
        ['organizationId', 'org-elsewhere'],
        ['trustDomain', 'trust-domain-elsewhere'],
        ['actionBinding.format', 'frontera.batch-job-binding.v1'],
        ['actionBinding.digest', `sha256:${'c'.repeat(64)}`],
        ['consumption.claimedAt', '2020-01-01T00:00:00.000Z'],
        ['consumption.ledgerState', 'claimed'],
        ['outcome', 'failed-observed'],
        ['basis', 'execution-path'],
        ['observedAt', '2099-01-01T00:00:00.000Z'],
        ['sequence', 2],
        ['supersedes', 'd'.repeat(64)],
        ['observation.digest', `sha256:${'e'.repeat(64)}`],
        ['observation.reference', 'other.json'],
        ['format', 'frontera.executor-receipt.v2'],
      ];
      for (const [path, value] of mutations) {
        const changed = set(path, value);
        const unsigned = domain.verifier.verify({ receipt: canonicalSerialize(changed), signature: presented.signature });
        assert.equal(unsigned.receipt, null, `${path}: an edited receipt with the old signature`);
        assert.notEqual(unsigned.signature, 'valid', path);
      }
      assert.ok(original['outcome'] === 'completed-observed');
      const cases: readonly (readonly [string, unknown, string])[] = [
        ['whitespace', { receipt: JSON.stringify(original, null, 1), signature: presented.signature }, 'RECEIPT_NONCANONICAL'],
        ['an unknown field', { receipt: canonicalSerialize({ ...original, note: 'x' }), signature: presented.signature }, 'RECEIPT_MALFORMED'],
        ['a duplicated field', { receipt: `{"actionBinding":{},${presented.receipt.slice(1)}`, signature: presented.signature }, 'RECEIPT_NONCANONICAL'],
        ['a wildcard identifier', { receipt: canonicalSerialize({ ...original, audience: '*' }), signature: presented.signature }, 'RECEIPT_MALFORMED'],
        ['a malformed instant', { receipt: canonicalSerialize({ ...original, observedAt: '2026-10-23 05:00:00' }), signature: presented.signature }, 'RECEIPT_MALFORMED'],
        ['another algorithm', { receipt: presented.receipt, signature: { ...presented.signature, algorithm: 'rsa-pss-sha256' } }, 'SIGNATURE_INVALID'],
        ['the capability signing domain', forged(domain.keyFile, undefined, { text: presented.receipt, domain: EXECUTION_CAPABILITY_SIGNING_DOMAIN }), 'SIGNATURE_INVALID'],
        ['no domain', forged(domain.keyFile, undefined, { text: presented.receipt, domain: '' }), 'SIGNATURE_INVALID'],
        ['an unpinned key id', { receipt: presented.receipt, signature: { ...presented.signature, keyId: 'g02c1c-unpinned' } }, 'EXECUTOR_KEY_UNTRUSTED'],
        ['a truncated signature', { receipt: presented.receipt, signature: { ...presented.signature, signature: String(presented.signature['signature']).slice(0, 40) } }, 'SIGNATURE_INVALID'],
        ['a malformed envelope', { receipt: presented.receipt, signature: { keyId: RECEIPT_KEY_ID } }, 'SIGNATURE_INVALID'],
        ['an extra presentation field', { ...presented, note: 'x' }, 'PRESENTATION_MALFORMED'],
      ];
      for (const [name, value, failure] of cases) {
        const result = domain.verifier.verify(value);
        assert.equal(result.failure, failure, name);
        assert.equal(result.receipt, null, name);
      }
    } finally {
      world.close();
    }
  });

  it('trust is the caller’s registry: another executor’s key, an unpinned executor, a foreign scope and an expectation mismatch are each reported separately', async () => {
    const domain = await freshDomain();
    const { world, capabilityId, presented } = await completedReceipt(domain);
    try {
      const other = generateReceiptKey(domain.keyDirectory, 'other-executor.pem');
      const both = createExecutorReceiptVerifier({ trustedExecutors: [trustedExecutor(domain.publicKeyPem), { ...trustedExecutor(other.publicKeyPem, 'g02c1c-other-executor-key'), executorId: 'reference-executor-other' }] });
      // Signed by another pinned executor's key, claiming this executor.
      const parsed = JSON.parse(presented.receipt) as Record<string, unknown>;
      assert.equal(both.verify(forged(other.keyFile, { ...parsed, executorKeyId: 'g02c1c-other-executor-key' }, { keyId: 'g02c1c-other-executor-key' })).failure, 'EXECUTOR_KEY_UNTRUSTED');
      assert.equal(createExecutorReceiptVerifier({ trustedExecutors: [{ ...trustedExecutor(domain.publicKeyPem), executorId: 'reference-executor-other' }] }).verify(presented).failure, 'EXECUTOR_UNTRUSTED');
      const scoped = (overrides: Record<string, unknown>) => createExecutorReceiptVerifier({ trustedExecutors: [{ ...trustedExecutor(domain.publicKeyPem), ...overrides }] }).verify(presented);
      for (const overrides of [{ audiences: ['executor-elsewhere'] }, { organizationIds: ['org-elsewhere'] }, { trustDomains: ['trust-domain-elsewhere'] }]) {
        const result = scoped(overrides);
        assert.deepEqual([result.signature, result.scope, result.failure], ['valid', 'not-permitted', 'SCOPE_NOT_PERMITTED'], JSON.stringify(overrides));
      }
      for (const expected of [{ executorId: 'x' }, { capabilityId: 'a'.repeat(64) }, { executionId: 'x' }, { issuer: 'x' }, { audience: 'x' }, { organizationId: 'x' }, { trustDomain: 'x' }]) {
        assert.deepEqual([domain.verifier.verify(presented, { expected }).identityMatch, domain.verifier.verify(presented, { expected }).failure], ['no', 'IDENTITY_MISMATCH'], JSON.stringify(expected));
      }
      assert.equal(domain.verifier.verify(presented, { expected: { actionBinding: { format: BINDING_FORMAT, digest: `sha256:${'0'.repeat(64)}` } } }).bindingMatch, 'no');
      assert.equal(domain.verifier.verify(presented).bindingMatch, 'unknown');
      assert.equal(domain.verifier.verify(presented, { expected: { capabilityId } }).identityMatch, 'yes');
    } finally {
      world.close();
    }
  });

  it('rotation: old and new keys verify while both are pinned; an unpinned old key stops verifying; nothing is fetched', async () => {
    const domain = await freshDomain();
    const { world, presented } = await completedReceipt(domain);
    world.close();
    const rotated = generateReceiptKey(domain.keyDirectory, 'rotated.pem');
    const overlap = createExecutorReceiptVerifier({ trustedExecutors: [trustedExecutor(domain.publicKeyPem, RECEIPT_KEY_ID, [{ keyId: 'g02c1c-executor-receipt-key-2', publicKeyPem: rotated.publicKeyPem }])] });
    assert.equal(overlap.verify(presented).signature, 'valid');
    const parsed = JSON.parse(presented.receipt) as Record<string, unknown>;
    const signedByNew = forged(rotated.keyFile, { ...parsed, executorKeyId: 'g02c1c-executor-receipt-key-2' }, { keyId: 'g02c1c-executor-receipt-key-2' });
    assert.equal(overlap.verify(signedByNew).signature, 'valid');
    const afterRotation = createExecutorReceiptVerifier({ trustedExecutors: [trustedExecutor(rotated.publicKeyPem, 'g02c1c-executor-receipt-key-2')] });
    assert.equal(afterRotation.verify(presented).failure, 'EXECUTOR_KEY_UNTRUSTED', 'a receipt under a removed key is no longer verifiable here');
    assert.equal(afterRotation.verify({ receipt: presented.receipt, signature: { ...presented.signature, keyId: 'g02c1c-executor-receipt-key-2' } }).failure, 'EXECUTOR_KEY_UNTRUSTED', 'relabelling the key id does not help');
  });

  it('history: an exact duplicate is one receipt; a different receipt at the same position, or a broken chain, is a conflict', async () => {
    const domain = await freshDomain();
    const { world, presented } = await completedReceipt(domain);
    try {
      assert.deepEqual(domain.verifier.assessHistory([presented, presented]).chain, 'valid');
      const parsed = JSON.parse(presented.receipt) as ExecutorReceipt;
      const rival = positionExecutorReceipt({ ...parsed, observation: { ...(parsed.observation as NonNullable<ExecutorReceipt['observation']>), digest: `sha256:${'9'.repeat(64)}` } } as never, 1, null);
      const conflict = forged(domain.keyFile, undefined, { text: serializeExecutorReceipt(rival) });
      assert.equal(domain.verifier.assessHistory([presented, conflict]).chain, 'conflicting');
      assert.equal(domain.verifier.verify(presented, { history: [conflict] }).receiptState, 'conflicting');
      assert.equal(parseExecutorReceipt(canonicalSerialize({ ...parsed, sequence: 2, supersedes: 'a'.repeat(64), receiptId: parsed.receiptId })).ok, false, 'a successor of another id is not even well formed');
      const afterCompleted = positionExecutorReceipt({ ...parsed } as never, 2, parsed.receiptId);
      assert.equal(domain.verifier.assessHistory([presented, forged(domain.keyFile, undefined, { text: serializeExecutorReceipt(afterCompleted) })]).chain, 'conflicting', 'a successor of a definite outcome');
    } finally {
      world.close();
    }
  });
});

describe('G-02C1C — the receipt ledger and the signer hold their rules', () => {
  it('raw SQL cannot delete, overwrite, duplicate a position or supersede backwards; a tampered or foreign ledger is refused at open', async () => {
    const domain = await freshDomain();
    const { world, presented, capabilityId } = await completedReceipt(domain);
    world.close();
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(domain.receiptLedgerPath);
    try {
      assert.throws(() => db.prepare('DELETE FROM executor_receipts').run(), /permanent/);
      assert.throws(() => db.prepare("UPDATE executor_receipts SET canonical = 'x'").run(), /only becomes issued/);
      const row = db.prepare('SELECT * FROM executor_receipts').get() as Record<string, unknown>;
      assert.throws(() => db.prepare('INSERT INTO executor_receipts (receipt_id, capability_id, execution_id, issuer, sequence, supersedes, outcome, ledger_state, key_id, canonical, digest, state, reserved_at) VALUES (?, ?, ?, ?, 1, NULL, ?, ?, ?, ?, ?, ?, ?)').run('f'.repeat(64), row['capability_id'], row['execution_id'], row['issuer'], row['outcome'], row['ledger_state'], row['key_id'], row['canonical'], row['digest'], 'reserved', row['reserved_at']), /UNIQUE/);
      assert.throws(() => db.prepare("INSERT INTO executor_receipts (receipt_id, capability_id, execution_id, issuer, sequence, supersedes, outcome, ledger_state, key_id, canonical, digest, state, reserved_at) VALUES (?, ?, ?, ?, 2, ?, 'attempted-outcome-unknown', 'failed', ?, ?, ?, 'reserved', ?)").run('e'.repeat(64), row['capability_id'], row['execution_id'], row['issuer'], row['receipt_id'], row['key_id'], row['canonical'], row['digest'], row['reserved_at']), /supersedes only/);
      // A raw writer that removes the guard, edits the text and restores the guard is caught by the content check at open.
      db.exec('DROP TRIGGER executor_receipts_issue_only');
      db.prepare('UPDATE executor_receipts SET canonical = ?').run(presented.receipt.replace('completed-observed', 'failed-observed'));
      db.exec(readFileSync(join(__dirname, '..', 'reference-executor', 'receipt-ledger.js'), 'utf8').match(/CREATE TRIGGER IF NOT EXISTS executor_receipts_issue_only[\s\S]*?END;/)?.[0] ?? '');
    } finally {
      db.close();
    }
    await assert.rejects(openExecutorReceiptLedger(domain.receiptLedgerPath, { executorId: EXECUTOR_ID, audience: AUDIENCE, clock: () => Date.now() }), /could not be opened|corrupted/);
    const other = await freshDomain();
    await assert.rejects(openExecutorReceiptLedger(other.receiptLedgerPath, { executorId: 'reference-executor-other', audience: AUDIENCE, clock: () => Date.now() }), /another executor/);
    await assert.rejects(openExecutorReceiptLedger(join(other.root, 'receipts', 'missing.sqlite'), { executorId: EXECUTOR_ID, audience: AUDIENCE, clock: () => Date.now() }), /does not exist/);
    await assert.rejects(openExecutorReceiptLedger(other.receiptLedgerPath, { executorId: EXECUTOR_ID, audience: AUDIENCE, clock: () => Date.now(), create: true }), /already exists/);
  });

  it('the signer signs only ledger reservations, for its own key, from a private, owned, non-issuer Ed25519 key — and exposes only public material', async () => {
    const domain = await freshDomain();
    const { world, capabilityId } = await completedReceipt(domain);
    try {
      const stored = world.receipts.latest(capabilityId);
      assert.ok(stored !== undefined);
      assert.throws(() => world.signer.signExecutorReceipt({ ...stored }), /Only a reservation/, 'a look-alike record is never signed');
      const second = await openExecutorReceiptLedger(domain.receiptLedgerPath, { executorId: EXECUTOR_ID, audience: AUDIENCE, clock: () => Date.now() });
      try {
        const foreign = second.reserve({ ...(stored.receipt as ExecutorReceipt) } as never);
        assert.equal(foreign.receiptId, stored.receiptId);
        assert.throws(() => world.signer.signExecutorReceipt(foreign), /Only a reservation/, 'a reservation of another ledger instance is never signed');
      } finally {
        second.close();
      }
      assert.deepEqual(Object.keys(world.signer).sort(), ['executorId', 'keyId', 'publicKeyPem', 'signExecutorReceipt']);
      assert.equal(/PRIVATE/.test(JSON.stringify(world.signer)), false);
      const load = (overrides: Record<string, unknown>) => () => loadExecutorReceiptSigner({ executorId: EXECUTOR_ID, keyId: RECEIPT_KEY_ID, privateKeyFile: domain.keyFile, receiptLedger: world.receipts, issuerKeys: ISSUER_PINS, ...overrides });
      assert.throws(load({ keyId: ISSUER_PINS[0]?.keyId }), /trusted issuer key id/);
      const issuerKeyFile = join(domain.keyDirectory, 'issuer.pem');
      writeFileSync(issuerKeyFile, ISSUER_KEY.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
      assert.throws(load({ privateKeyFile: issuerKeyFile }), /trusted issuer key/);
      const open = join(domain.keyDirectory, 'open.pem');
      copyFileSync(domain.keyFile, open);
      chmodSync(open, 0o644);
      assert.throws(load({ privateKeyFile: open }), /readable by no one else/);
      const link = join(domain.keyDirectory, 'link.pem');
      symlinkSync(domain.keyFile, link);
      assert.throws(load({ privateKeyFile: link }), /regular file|could not be read/);
      const x25519 = join(domain.keyDirectory, 'x25519.pem');
      writeFileSync(x25519, generateKeyPairSync('x25519').privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
      assert.throws(load({ privateKeyFile: x25519 }), /Ed25519/);
      assert.throws(load({ privateKeyFile: join(domain.keyDirectory, 'missing.pem') }), /could not be read/);
    } finally {
      world.close();
    }
  });
});

describe('G-02C1C — read-only consumption access (G-02A, additive)', () => {
  it('readDetail returns exactly the stored facts; listUnresolved pages deterministically and changes nothing', async () => {
    const domain = await freshDomain();
    const world = await receiptWorld(domain, {
      fault: (point) => {
        if (point === 'after-claim') throw new Error('crash after the claim');
      },
      receiptFault: () => undefined,
    });
    try {
      const ids: string[] = [];
      for (let index = 0; index < 5; index += 1) {
        const { capability, presentation } = syntheticCapability(VECTOR.digest);
        deliver(world, presentation);
        ids.push(capability.capabilityId);
      }
      const detail = world.ledger.readDetail(ids[0] as string);
      assert.ok(detail.state === 'claimed');
      assert.deepEqual([detail.actionBindingDigest, detail.organizationId, detail.trustDomain, detail.outcomeRecordedAt], [VECTOR.digest, ORGANIZATION, TRUST_DOMAIN, null]);
      assert.deepEqual(world.ledger.readDetail('a'.repeat(64)), { state: 'absent' });
      const seen: string[] = [];
      let after: { readonly claimedAt: string; readonly capabilityId: string } | undefined;
      let pages = 0;
      for (;;) {
        const page = world.ledger.listUnresolved(after === undefined ? { limit: 2 } : { limit: 2, after });
        pages += 1;
        seen.push(...page.records.map((record) => record.capabilityId));
        if (page.next === undefined) break;
        after = page.next;
      }
      assert.deepEqual([...seen].sort(), [...ids].sort());
      assert.equal(pages, 3);
      assert.deepEqual(world.ledger.listUnresolved({ limit: 100 }).records.map((record) => record.capabilityId), seen, 'one fixed order');
      for (const id of ids) assert.equal(world.ledger.readDetail(id).state, 'claimed', 'listing changes nothing');
      assert.throws(() => world.ledger.listUnresolved({ limit: 0 }));
      assert.throws(() => world.ledger.listUnresolved({ limit: 101 }));
      assert.deepEqual(domain.records(), [], 'no effect ran');
    } finally {
      world.close();
    }
  });
});

describe('G-02C1C — review findings: stale reservations, substituted rows, rotation, rollback, file custody', () => {
  it('a reservation left unsigned is signed before it is superseded: the chain stays verifiable (F1)', async () => {
    const domain = await freshDomain();
    let armed = false;
    const world = await receiptWorld(domain, {
      fault: (point) => {
        if (point === 'after-effect') throw new Error('crash after the effect, before the outcome');
      },
      receiptFault: (point) => {
        if (armed && point === 'after-receipt-reservation') {
          armed = false;
          throw new Error('crash between reserve and issue');
        }
      },
    });
    try {
      const { capability, presentation } = syntheticCapability(VECTOR.digest);
      deliver(world, presentation);
      const id = capability.capabilityId;
      armed = true;
      assert.throws(() => world.issuer.issue(id), /crash between reserve and issue/);
      assert.equal(world.receipts.latest(id)?.state, 'reserved', 'seq 1 reserved, never signed');
      assert.equal(world.ledger.recordOutcome(id, 'completed'), 'recorded');
      const resolved = world.issuer.issue(id);
      assert.ok(resolved.status === 'issued');
      const history = world.receipts.history(id);
      assert.equal(history.length, 2, 'the stale reservation was signed, then superseded');
      const assessed = domain.verifier.assessHistory(history);
      assert.equal(assessed.chain, 'valid');
      assert.equal(parseExecutorReceipt(resolved.receipt.receipt).ok && (parseExecutorReceipt(resolved.receipt.receipt) as { receipt: ExecutorReceipt }).receipt.outcome, 'completed-observed');
    } finally {
      world.close();
    }
  });

  it('a receipt ledger edited underneath cannot get the executor to sign a substituted statement (F2)', async () => {
    const domain = await freshDomain();
    const world = await receiptWorld(domain, {
      receiptFault: (point) => {
        if (point === 'before-receipt') throw new Error('no in-path receipt');
      },
    });
    const { capability, presentation } = syntheticCapability(VECTOR.digest);
    try {
      deliver(world, presentation);
    } finally {
      world.close();
    }
    const id = capability.capabilityId;
    const consumption = await openExecutionCapabilityConsumptionLedger(domain.ledgerPath, { audience: AUDIENCE, clock: () => Date.now() });
    const detail = consumption.readDetail(id);
    consumption.close();
    assert.ok(detail.state === 'completed');
    const bytes = readFileSync(join(domain.outputDirectory, `${id}.json`));
    const substituted = positionExecutorReceipt(
      {
        format: 'frontera.executor-receipt.v1',
        executorId: EXECUTOR_ID,
        executorKeyId: RECEIPT_KEY_ID,
        issuer: detail.issuer,
        capabilityId: id,
        executionId: detail.executionId,
        audience: AUDIENCE,
        organizationId: 'org-substituted',
        trustDomain: detail.trustDomain,
        actionBinding: { format: BINDING_FORMAT, digest: detail.actionBindingDigest },
        consumption: { claimedAt: detail.claimedAt, ledgerState: 'completed' },
        outcome: 'completed-observed',
        basis: 'durable-state',
        observedAt: detail.outcomeRecordedAt as string,
        observation: { kind: 'frontera.synthetic-deployment-record.v1', reference: `${id}.json`, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` },
      },
      1,
      null,
    );
    const canonical = serializeExecutorReceipt(substituted);
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(domain.receiptLedgerPath);
    try {
      db.prepare("INSERT INTO executor_receipts (receipt_id, capability_id, execution_id, issuer, sequence, supersedes, outcome, ledger_state, key_id, canonical, digest, state, reserved_at) VALUES (?, ?, ?, ?, 1, NULL, 'completed-observed', 'completed', ?, ?, ?, 'reserved', ?)").run(
        substituted.receiptId,
        id,
        detail.executionId,
        detail.issuer,
        RECEIPT_KEY_ID,
        canonical,
        `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`,
        new Date().toISOString(),
      );
    } finally {
      db.close();
    }
    const recovery = await receiptWorld(domain);
    try {
      assert.deepEqual(recovery.issuer.issue(id), { status: 'refused', code: 'RECEIPT_CONFLICT' });
      assert.deepEqual(recovery.receipts.history(id), [], 'nothing signed');
      assert.deepEqual(recovery.signatures, []);
    } finally {
      recovery.close();
    }
  });

  it('a reservation under a rotated-out key is refused by name, never signed by another key (F3)', async () => {
    const domain = await freshDomain();
    const world = await receiptWorld(domain, {
      receiptFault: (point) => {
        if (point === 'after-receipt-reservation') throw new Error('crash between reserve and issue');
      },
    });
    const { capability, presentation } = syntheticCapability(VECTOR.digest);
    try {
      deliver(world, presentation);
      assert.deepEqual(world.receipts.pendingKeyIds(), [RECEIPT_KEY_ID]);
    } finally {
      world.close();
    }
    const rotated = generateReceiptKey(domain.keyDirectory, 'rotated.pem');
    const after = await receiptWorld(domain, { keyId: 'g02c1c-executor-receipt-key-2', keyFile: rotated.keyFile });
    try {
      assert.deepEqual(after.issuer.issue(capability.capabilityId), { status: 'refused', code: 'RECEIPT_KEY_MISMATCH' });
      assert.deepEqual(after.signatures, []);
    } finally {
      after.close();
    }
  });

  it('a receipt ledger restored to before an unknown receipt regenerates a different receipt at that position: a verifier holding both sees a conflict (F4)', async () => {
    const domain = await freshDomain();
    const world = await receiptWorld(domain, {
      fault: (point) => {
        if (point === 'after-effect') throw new Error('crash after the effect');
      },
    });
    const backup = join(domain.root, 'receipts-backup.sqlite');
    copyFileSync(domain.receiptLedgerPath, backup);
    const { capability, presentation } = syntheticCapability(VECTOR.digest);
    let old: { readonly receipt: string; readonly signature: Readonly<Record<string, string>> };
    try {
      deliver(world, presentation);
      const first = world.issuer.issue(capability.capabilityId);
      assert.ok(first.status === 'issued');
      old = first.receipt;
      assert.equal(world.ledger.recordOutcome(capability.capabilityId, 'completed'), 'recorded');
    } finally {
      world.close();
    }
    for (const suffix of ['-wal', '-shm']) rmSync(`${domain.receiptLedgerPath}${suffix}`, { force: true });
    copyFileSync(backup, domain.receiptLedgerPath);
    const restored = await receiptWorld(domain);
    try {
      const regenerated = restored.issuer.issue(capability.capabilityId);
      assert.ok(regenerated.status === 'issued');
      assert.notDeepEqual(regenerated.receipt, old);
      assert.equal(domain.verifier.assessHistory([old, regenerated.receipt]).chain, 'conflicting', 'rollback is detectable by a verifier that kept the old receipt, not prevented');
    } finally {
      restored.close();
    }
  });

  it('a receipt ledger file others can write is refused at open', async () => {
    const domain = await freshDomain();
    chmodSync(domain.receiptLedgerPath, 0o666);
    await assert.rejects(openExecutorReceiptLedger(domain.receiptLedgerPath, { executorId: EXECUTOR_ID, audience: AUDIENCE, clock: () => Date.now() }), /writable by no one else/);
    chmodSync(domain.receiptLedgerPath, 0o600);
    (await openExecutorReceiptLedger(domain.receiptLedgerPath, { executorId: EXECUTOR_ID, audience: AUDIENCE, clock: () => Date.now() })).close();
  });
});
