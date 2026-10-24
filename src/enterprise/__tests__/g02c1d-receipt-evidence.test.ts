import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { ExecutionAdapterResult } from '../../features/execution-runtime/index.js';
import { snapshotGenericHttpOptions } from '../execution-adapters/generic-http/configuration.js';
import { GenericHttpConfigurationError } from '../execution-adapters/generic-http/contracts.js';
import { createGenericHttpExecutionAdapterCore, type GenericHttpExchangeEvidence } from '../execution-adapters/generic-http/generic-http-execution-adapter.js';
import { GENERIC_HTTP_PRESENTATION_HEADER, GENERIC_HTTP_RECEIPT_HEADER } from '../execution-adapters/generic-http/governed-headers.js';
import type { GenericHttpTransportObservation } from '../execution-adapters/generic-http/node-https-transport.js';
import { genericHttpRequestBinding } from '../execution-adapters/generic-http/request-binding.js';
import type { GenericHttpWireRequest } from '../execution-adapters/generic-http/request-mapper.js';
import { EXECUTION_CAPABILITY_PRESENTATION_HEADER } from '../execution-capability-presentation/index.js';
import { executionCapabilityActionBindingDigest } from '../execution-capability/index.js';
import {
  EXECUTOR_RECEIPT_TRANSPORT_FORMAT,
  EXECUTOR_RECEIPT_TRANSPORT_HEADER,
  EXECUTOR_RECEIPT_TRANSPORT_LIMITS,
  decodeExecutorReceiptTransport,
  encodeExecutorReceiptTransport,
  serializeExecutorReceipt,
  type ExecutorReceipt,
} from '../executor-receipt/index.js';
import { canonicalSerialize } from '../governance-store/canonical-json.js';
import { createExecutionReceiptTrust, openExecutionReceiptEvidenceStore, receiptAgreementOf } from '../execution-receipt-evidence/index.js';
import { G02B_ISSUER, G02B_ORGANIZATION, G02B_TRUST_DOMAIN } from './g02b-execution-capability-issuance-fixture.js';
import { CREDENTIAL_TOKEN, countingNetwork, gatedOptions, gatedPlan, recordingGate } from './g02c0-execution-binding-fixture.js';
import { generateReceiptKey } from './g02c1c-executor-receipt-fixture.js';
import {
  E2E_ADAPTER_ID,
  E2E_EXECUTOR_ID,
  E2E_RECEIPT_KEY_ID,
  UNKNOWN,
  afterObservers,
  deliverableReceipt,
  e2eTrustedExecutor,
  executionIdOf,
  hostWorld,
  openE2EEvidenceStore,
  presentedCapability,
  privateDirectory,
  receiptAbout,
  signReceiptText,
  type HostWorld,
} from './g02c1d-end-to-end-fixture.js';

/**
 * G-02C1D, in process: the receipt transport encoding, the Host's receipt
 * evidence (verification against pinned executors, correlation with the
 * real G-02B issuance, the temporal check, the additive store) and the
 * Generic HTTP adapter's one presentation header — all over the real issuer,
 * gate and adapter core, with a scripted responder in place of the network.
 * The separate-process suite repeats the essentials over real HTTP/1.1 bytes
 * with the reference executor in its own process.
 */

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const keys = privateDirectory('frontera-g02c1d-keys-');
cleanups.push(() => rmSync(keys, { recursive: true, force: true }));
const EXECUTOR_KEY = generateReceiptKey(keys, 'executor.pem');
const OTHER_KEY = generateReceiptKey(keys, 'other.pem');
const TRUSTED = [e2eTrustedExecutor(EXECUTOR_KEY.publicKeyPem)];

const response = (status: number, receiptValues: readonly string[]): GenericHttpTransportObservation => ({ kind: 'response', status, providerRefValues: [], receiptValues });

/** A world whose executor answers `status` with the receipt `make` builds about the presented capability (or none). */
async function world(status: number, make?: (request: GenericHttpWireRequest) => readonly string[]): Promise<HostWorld> {
  const built = await hostWorld({ trustedExecutors: TRUSTED, respond: (request) => response(status, make === undefined ? [] : make(request)) });
  cleanups.push(() => built.close());
  return built;
}

/** One governed execution through `built`: a fresh grant, its action, the adapter's result and the execution's evidence. */
async function run(built: HostWorld) {
  const signed = await built.grant();
  const action = built.actionFor(signed);
  const result = await built.execute(action);
  const executionId = executionIdOf(signed);
  return { signed, action, result, executionId, observations: built.evidence.observationsFor(executionId), evidence: built.evidence.evidenceFor(executionId), conflicts: built.evidence.conflictsFor(executionId) };
}

/** `id` with its last character changed: another execution of the same shape. */
const altered = (id: string): string => `${id.slice(0, -1)}${id.endsWith('0') ? '1' : '0'}`;

const sign = (receipt: ExecutorReceipt, keyFile: string = EXECUTOR_KEY.keyFile, keyId: string = E2E_RECEIPT_KEY_ID): readonly string[] => [deliverableReceipt(keyFile, receipt, keyId)];

// ── 1. The receipt transport encoding ──────────────────────────────────────

describe('G-02C1D — frontera.executor-receipt-transport.v1: one value, one spelling, the persisted artifact verbatim', () => {
  const aReceipt = async () => {
    let captured: GenericHttpWireRequest | undefined;
    const built = await world(201, (request) => {
      captured = request;
      return [];
    });
    await run(built);
    assert.ok(captured !== undefined);
    return receiptAbout(presentedCapability(captured));
  };

  it('round-trips the receipt text and its signature byte for byte, and decodes to exactly what was encoded', async () => {
    const receipt = await aReceipt();
    const text = serializeExecutorReceipt(receipt);
    const signature = signReceiptText(EXECUTOR_KEY.keyFile, text);
    const encoded = encodeExecutorReceiptTransport({ receipt: text, signature });
    assert.ok(encoded.length <= EXECUTOR_RECEIPT_TRANSPORT_LIMITS.maximumEncodedLength && /^[A-Za-z0-9_-]+$/.test(encoded));
    const decoded = decodeExecutorReceiptTransport([encoded]);
    assert.ok(decoded.ok);
    assert.equal(decoded.presented.receipt, text);
    assert.deepEqual({ ...(decoded.presented.signature as Record<string, string>) }, { ...signature });
    assert.equal(EXECUTOR_RECEIPT_TRANSPORT_HEADER, GENERIC_HTTP_RECEIPT_HEADER, 'the Host reads the header the executor writes');
    assert.equal(EXECUTION_CAPABILITY_PRESENTATION_HEADER, GENERIC_HTTP_PRESENTATION_HEADER, 'the executor reads the header the Host writes');
  });

  it('refuses none, several, oversized, foreign-alphabet, padded, non-canonical, unknown-format, badly signed and malformed-receipt values — quoting nothing', async () => {
    const receipt = await aReceipt();
    const text = serializeExecutorReceipt(receipt);
    const signature = signReceiptText(EXECUTOR_KEY.keyFile, text);
    const good = encodeExecutorReceiptTransport({ receipt: text, signature });
    const b64 = (value: unknown) => Buffer.from(typeof value === 'string' ? value : canonicalSerialize(value), 'utf8').toString('base64url');
    const cases: readonly [string, readonly unknown[], string][] = [
      ['no value', [], 'RECEIPT_MISSING'],
      ['an empty value', [''], 'RECEIPT_MISSING'],
      ['two values', [good, good], 'RECEIPT_DUPLICATED'],
      ['too long', ['A'.repeat(EXECUTOR_RECEIPT_TRANSPORT_LIMITS.maximumEncodedLength + 1)], 'RECEIPT_TOO_LARGE'],
      ['a foreign alphabet', [`${good.slice(0, -2)}+/`], 'RECEIPT_ENCODING_INVALID'],
      ['padding', [`${good}=`], 'RECEIPT_ENCODING_INVALID'],
      ['non-canonical JSON', [b64(JSON.stringify({ receipt: text, format: EXECUTOR_RECEIPT_TRANSPORT_FORMAT, signature }))], 'RECEIPT_NONCANONICAL'],
      ['an unknown format', [b64({ format: 'frontera.executor-receipt-transport.v2', receipt: text, signature })], 'RECEIPT_FORMAT_UNSUPPORTED'],
      ['an extra field', [b64({ format: EXECUTOR_RECEIPT_TRANSPORT_FORMAT, receipt: text, signature, status: 'ok' })], 'RECEIPT_MALFORMED'],
      ['a malformed signature', [b64({ format: EXECUTOR_RECEIPT_TRANSPORT_FORMAT, receipt: text, signature: { ...signature, signature: 'short' } })], 'RECEIPT_SIGNATURE_MALFORMED'],
      ['an invalid receipt text', [b64({ format: EXECUTOR_RECEIPT_TRANSPORT_FORMAT, receipt: `${text} `, signature })], 'RECEIPT_TEXT_INVALID'],
      ['not JSON', [b64('not json')], 'RECEIPT_MALFORMED'],
      ['a non-string', [42], 'RECEIPT_MISSING'],
    ];
    for (const [label, values, failure] of cases) {
      const decoded = decodeExecutorReceiptTransport(values);
      assert.ok(!decoded.ok, label);
      assert.equal(decoded.failure, failure, label);
      assert.equal(JSON.stringify(decoded).includes(text.slice(0, 20)), false, `${label}: quotes nothing`);
    }
  });
});

// ── 2. Verification and correlation, over the real issuance ────────────────

describe('G-02C1D — a receipt becomes evidence only when a pinned executor signed it about exactly what this Host issued', () => {
  it('a correlated completed receipt: accepted once, the artifact kept verbatim, the HTTP outcome untouched and consistent', async () => {
    const built = await world(201, (request) => sign(receiptAbout(presentedCapability(request))));
    const outcome = await run(built);
    assert.equal(outcome.result.outcome, 'completed', 'the adapter result is the status classification, as before');
    assert.deepEqual(
      outcome.observations.map((observation) => [observation.disposition, observation.failure, observation.agreement, observation.transmission, observation.httpStatus, observation.httpOutcome, observation.receiptOutcome]),
      [['receipt-correlated', null, 'consistent', 'response', 201, 'completed', 'completed-observed']],
    );
    assert.equal(outcome.evidence.length, 1);
    const evidence = outcome.evidence[0];
    assert.ok(evidence !== undefined);
    const record = built.issuance.read(outcome.executionId);
    assert.ok(record.state === 'issued');
    assert.equal(evidence.capabilityId, record.capabilityId, 'correlated to the capability this Host issued');
    assert.equal(evidence.receipt.actionBinding.digest, record.capability.actionBinding.digest);
    const delivered = decodeExecutorReceiptTransport(built.exchanges[0]?.receiptValues ?? []);
    assert.ok(delivered.ok);
    assert.equal(evidence.presented.receipt, delivered.presented.receipt, 'the stored text is the delivered text');
    assert.deepEqual({ ...evidence.presented.signature }, { ...(delivered.presented.signature as Record<string, string>) });
  });

  it('the same receipt again is idempotent: one evidence row, two observations', async () => {
    const built = await world(201, (request) => sign(receiptAbout(presentedCapability(request))));
    const outcome = await run(built);
    const exchange = built.exchanges[0] as GenericHttpExchangeEvidence;
    await built.recorder.observe(exchange);
    assert.equal(built.evidence.evidenceFor(outcome.executionId).length, 1);
    assert.deepEqual(built.evidence.observationsFor(outcome.executionId).map((observation) => observation.disposition), ['receipt-correlated', 'receipt-correlated']);
  });

  it('a receipt that contradicts the HTTP status is recorded as a contradiction; nothing chooses either side', async () => {
    const unknown = await world(201, (request) => sign(receiptAbout(presentedCapability(request), UNKNOWN)));
    const contradicted = await run(unknown);
    assert.equal(contradicted.result.outcome, 'completed', 'the status classification is not moved by the receipt');
    assert.deepEqual(contradicted.observations.map((observation) => [observation.disposition, observation.agreement, observation.receiptOutcome]), [['receipt-correlated', 'contradicts', 'attempted-outcome-unknown']]);

    const rejected = await world(422, (request) => sign(receiptAbout(presentedCapability(request))));
    const completedAfter422 = await run(rejected);
    assert.equal(completedAfter422.result.outcome, 'failed');
    assert.equal(completedAfter422.observations[0]?.agreement, 'contradicts');

    const failed = await world(422, (request) => sign(receiptAbout(presentedCapability(request), { consumption: { ledgerState: 'failed' }, outcome: 'failed-observed', basis: 'execution-path', observation: null })));
    assert.equal((await run(failed)).observations[0]?.agreement, 'consistent');

    const uncertain = await world(502, (request) => sign(receiptAbout(presentedCapability(request))));
    const unconfirmed = await run(uncertain);
    assert.equal(unconfirmed.result.outcome, 'unconfirmed', 'a 502 stays unconfirmed even beside a completed receipt');
    assert.deepEqual([unconfirmed.observations[0]?.disposition, unconfirmed.observations[0]?.agreement], ['receipt-correlated', 'not-comparable']);
    for (const [http, reported, agreement] of [
      ['completed', 'completed-observed', 'consistent'],
      ['completed', 'failed-observed', 'contradicts'],
      ['failed', 'consumed-not-attempted', 'consistent'],
      ['failed', 'attempted-outcome-unknown', 'contradicts'],
      ['unconfirmed', 'completed-observed', 'not-comparable'],
    ] as const) {
      assert.equal(receiptAgreementOf(http, reported), agreement, `${http} / ${reported}`);
    }
  });

  it('no receipt is recorded as missing — never as "completed" and never as "nothing happened"', async () => {
    const built = await world(201);
    const outcome = await run(built);
    assert.equal(outcome.result.outcome, 'completed');
    assert.deepEqual(outcome.observations.map((observation) => [observation.disposition, observation.failure, observation.agreement, observation.receiptOutcome]), [['receipt-missing', 'RECEIPT_MISSING', 'not-comparable', null]]);
    assert.deepEqual(outcome.evidence, []);
  });

  it('two receipt headers are ambiguous: neither is read', async () => {
    const built = await world(201, (request) => {
      const one = sign(receiptAbout(presentedCapability(request)))[0] as string;
      return [one, one];
    });
    const outcome = await run(built);
    assert.deepEqual(outcome.observations.map((observation) => [observation.disposition, observation.failure]), [['receipt-duplicated', 'RECEIPT_DUPLICATED']]);
    assert.deepEqual(outcome.evidence, []);
  });

  const refused: readonly [string, (request: GenericHttpWireRequest) => readonly string[], string, string][] = [
    ['a malformed value', () => ['not*base64url'], 'receipt-invalid', 'RECEIPT_ENCODING_INVALID'],
    ['an unpinned executor', (request) => sign(receiptAbout(presentedCapability(request), { executorId: 'reference-executor-unpinned' })), 'receipt-invalid', 'EXECUTOR_UNTRUSTED'],
    ['an unpinned key id', (request) => sign(receiptAbout(presentedCapability(request), { executorKeyId: 'g02c1d-unpinned-key' }), EXECUTOR_KEY.keyFile, 'g02c1d-unpinned-key'), 'receipt-invalid', 'EXECUTOR_KEY_UNTRUSTED'],
    ['the pinned key id signed by another key (forged)', (request) => sign(receiptAbout(presentedCapability(request)), OTHER_KEY.keyFile), 'receipt-invalid', 'SIGNATURE_INVALID'],
    ['an envelope naming another key id than the receipt', (request) => sign(receiptAbout(presentedCapability(request)), EXECUTOR_KEY.keyFile, 'g02c1d-other-key-id'), 'receipt-invalid', 'EXECUTOR_KEY_UNTRUSTED'],
    ['an audience the executor is not pinned for', (request) => sign(receiptAbout(presentedCapability(request), { audience: 'executor-elsewhere' })), 'receipt-invalid', 'SCOPE_NOT_PERMITTED'],
    ['another organization', (request) => sign(receiptAbout(presentedCapability(request), { organizationId: 'org-elsewhere' })), 'receipt-invalid', 'SCOPE_NOT_PERMITTED'],
    ['another trust domain (cross-domain replay)', (request) => sign(receiptAbout(presentedCapability(request), { trustDomain: 'trust-domain-elsewhere' })), 'receipt-invalid', 'SCOPE_NOT_PERMITTED'],
    ['another execution', (request) => {
      const capability = presentedCapability(request);
      return sign(receiptAbout(capability, { executionId: altered(capability.executionId) }));
    }, 'receipt-uncorrelated', 'IDENTITY_MISMATCH'],
    ['another capability', (request) => sign(receiptAbout(presentedCapability(request), { capabilityId: 'c'.repeat(64), observation: { kind: 'frontera.synthetic-deployment-record.v1', reference: `${'c'.repeat(64)}.json`, digest: `sha256:${'a'.repeat(64)}` } })), 'receipt-uncorrelated', 'IDENTITY_MISMATCH'],
    ['a modified action binding', (request) => sign(receiptAbout(presentedCapability(request), { actionBinding: { format: 'frontera.http-request-binding.v1', digest: `sha256:${'d'.repeat(64)}` } })), 'receipt-uncorrelated', 'BINDING_MISMATCH'],
    ['another Host (issuer), correctly signed', (request) => sign(receiptAbout(presentedCapability(request), { issuer: 'frontera-deployment-elsewhere' })), 'receipt-uncorrelated', 'IDENTITY_MISMATCH'],
    ['a claim before issuance', (request) => {
      const capability = presentedCapability(request);
      return sign(receiptAbout(capability, { consumption: { claimedAt: new Date(Date.parse(capability.issuedAt) - 60_000).toISOString() }, observedAt: capability.issuedAt }));
    }, 'receipt-uncorrelated', 'TEMPORALLY_INCONSISTENT'],
    ['a claim after expiry', (request) => {
      const capability = presentedCapability(request);
      return sign(receiptAbout(capability, { consumption: { claimedAt: capability.expiresAt }, observedAt: capability.expiresAt }));
    }, 'receipt-uncorrelated', 'TEMPORALLY_INCONSISTENT'],
  ];
  for (const [label, make, disposition, failure] of refused) {
    it(`${label}: ${disposition} (${failure}), never evidence`, async () => {
      const built = await world(201, make);
      const outcome = await run(built);
      assert.equal(outcome.result.outcome, 'completed', 'the receipt never moves the result');
      assert.deepEqual(outcome.observations.map((observation) => [observation.disposition, observation.failure]), [[disposition, failure]]);
      assert.deepEqual(outcome.evidence, []);
      assert.deepEqual(outcome.conflicts, []);
    });
  }

  it('a receipt for an execution this Host never issued is refused: issuance cannot be inferred from a signature', async () => {
    let first: readonly string[] = [];
    const built = await world(201, (request) => {
      first = sign(receiptAbout(presentedCapability(request)));
      return first;
    });
    await run(built);
    const elsewhere = built.exchanges[0] as GenericHttpExchangeEvidence;
    const unissued = altered(elsewhere.action.correlation.executionId);
    const stranger = { ...elsewhere, action: { ...elsewhere.action, correlation: { ...elsewhere.action.correlation, executionId: unissued } } };
    await built.recorder.observe(stranger as GenericHttpExchangeEvidence);
    assert.deepEqual(
      built.evidence.observationsFor(unissued).map((observation) => [observation.disposition, observation.failure, observation.capabilityId]),
      [['receipt-uncorrelated', 'ISSUANCE_NOT_FOUND', null]],
    );
  });

  it('a receipt replayed from another execution is refused for this one', async () => {
    let previous: readonly string[] = [];
    const built = await world(201, (request) => {
      const fresh = sign(receiptAbout(presentedCapability(request)));
      const answer = previous.length === 0 ? fresh : previous;
      previous = fresh;
      return answer;
    });
    const first = await run(built);
    assert.equal(first.observations[0]?.disposition, 'receipt-correlated');
    const second = await run(built);
    assert.deepEqual(second.observations.map((observation) => [observation.disposition, observation.failure]), [['receipt-uncorrelated', 'IDENTITY_MISMATCH']]);
    assert.deepEqual(second.evidence, []);
  });
});

// ── 3. Conflicts and supersession ──────────────────────────────────────────

describe('G-02C1D — conflicting evidence is preserved, never merged; supersession is forward only', () => {
  /** A world whose responses are scripted one by one; each answers with the receipts `script` builds for its request. */
  async function scripted(script: (request: GenericHttpWireRequest) => readonly string[]) {
    const built = await world(201, script);
    const outcome = await run(built);
    const exchange = built.exchanges[0] as GenericHttpExchangeEvidence;
    const capability = presentedCapability(built.sent[0] as GenericHttpWireRequest);
    /** Shows the recorder the same exchange, carrying `values` instead. */
    const deliver = (values: readonly string[]) => built.recorder.observe({ ...exchange, receiptValues: values });
    return { built, outcome, capability, deliver };
  }

  it('a different receipt for a taken position is a conflict, preserved beside the accepted one', async () => {
    const { built, outcome, capability, deliver } = await scripted((request) => sign(receiptAbout(presentedCapability(request))));
    const rival = receiptAbout(capability, { observation: { kind: 'frontera.synthetic-deployment-record.v1', reference: `${capability.capabilityId}.json`, digest: `sha256:${'f'.repeat(64)}` } });
    await deliver(sign(rival));
    await deliver(sign(rival));
    assert.equal(built.evidence.evidenceFor(outcome.executionId).length, 1, 'the accepted receipt is never overwritten');
    const conflicts = built.evidence.conflictsFor(outcome.executionId);
    assert.deepEqual(conflicts.map((conflict) => [conflict.reason, conflict.sequence]), [['POSITION_TAKEN', 1]], 'kept once, idempotently');
    assert.deepEqual(built.evidence.observationsFor(outcome.executionId).map((observation) => observation.disposition), ['receipt-correlated', 'receipt-conflicting', 'receipt-conflicting']);
  });

  it('an unknown is superseded by its definite resolution; a successor of a definite outcome, or of a predecessor never seen, is a conflict', async () => {
    const { built, outcome, capability, deliver } = await scripted((request) => sign(receiptAbout(presentedCapability(request), UNKNOWN)));
    const first = built.evidence.evidenceFor(outcome.executionId)[0];
    assert.ok(first !== undefined && first.outcome === 'attempted-outcome-unknown');
    const resolution = receiptAbout(capability, {}, { sequence: 2, supersedes: first.receiptId });
    await deliver(sign(resolution));
    assert.deepEqual(built.evidence.evidenceFor(outcome.executionId).map((row) => [row.sequence, row.outcome]), [[1, 'attempted-outcome-unknown'], [2, 'completed-observed']]);
    const history = createExecutionReceiptTrust(TRUSTED).assessHistory(built.evidence.evidenceFor(outcome.executionId).map((row) => row.presented));
    assert.equal(history.chain, 'valid');
    assert.equal(history.current, resolution.receiptId);

    const third = receiptAbout(capability, {}, { sequence: 3, supersedes: resolution.receiptId });
    await deliver(sign(third));
    assert.deepEqual(built.evidence.conflictsFor(outcome.executionId).map((conflict) => conflict.reason), ['SUPERSESSION_INVALID'], 'a definite outcome is never superseded');

    // A successor that names the true prior position, whose predecessor the Host never accepted: preserved, not accepted.
    const unanchored = await scripted(() => []);
    const lone = receiptAbout(unanchored.capability, {}, { sequence: 2, supersedes: receiptAbout(unanchored.capability, UNKNOWN).receiptId });
    await unanchored.deliver(sign(lone));
    assert.deepEqual(unanchored.built.evidence.conflictsFor(unanchored.outcome.executionId).map((conflict) => conflict.reason), ['PREDECESSOR_UNKNOWN']);
    assert.deepEqual(unanchored.built.evidence.evidenceFor(unanchored.outcome.executionId), []);
  });
});

// ── 4. The evidence store ──────────────────────────────────────────────────

describe('G-02C1D — the evidence store: separate, append-only, durable, and refused when tampered with', () => {
  it('survives a restart; refuses re-creation, a missing file, another identity, a shared directory, edits and dropped triggers', async () => {
    const built = await world(201, (request) => sign(receiptAbout(presentedCapability(request))));
    const outcome = await run(built);
    const path = join(built.dir, 'receipt-evidence.sqlite');
    built.evidence.close();
    const options = { issuer: G02B_ISSUER, organizationId: G02B_ORGANIZATION, trustDomain: G02B_TRUST_DOMAIN, clock: () => Date.now() };
    const reopened = await openExecutionReceiptEvidenceStore(path, options);
    try {
      assert.equal(reopened.evidenceFor(outcome.executionId).length, 1, 'durable across a restart');
      assert.equal(reopened.observationsFor(outcome.executionId).length, 1);
    } finally {
      reopened.close();
    }
    await assert.rejects(openExecutionReceiptEvidenceStore(path, { ...options, create: true }), /never re-initialized/);
    await assert.rejects(openExecutionReceiptEvidenceStore(join(built.dir, 'absent.sqlite'), options), /never created implicitly/);
    await assert.rejects(openExecutionReceiptEvidenceStore(path, { ...options, issuer: 'frontera-deployment-elsewhere' }), /another issuer/);

    const { default: Database } = await import('better-sqlite3');
    let original = '';
    const raw = new Database(path);
    try {
      assert.throws(() => raw.prepare("UPDATE receipt_evidence SET outcome = 'failed-observed'").run(), /immutable/);
      assert.throws(() => raw.prepare('DELETE FROM receipt_observations').run(), /permanent/);
      original = (raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'receipt_evidence_never_updated'").get() as { sql: string }).sql;
      raw.exec('DROP TRIGGER receipt_evidence_never_updated');
      raw.prepare('UPDATE receipt_evidence SET canonical = canonical || \' \'').run();
    } finally {
      raw.close();
    }
    await assert.rejects(openExecutionReceiptEvidenceStore(path, options), /missing its integrity triggers/);
    const decoy = new Database(path);
    try {
      decoy.exec('CREATE TRIGGER receipt_evidence_never_updated BEFORE UPDATE ON receipt_evidence BEGIN SELECT 1; END;');
    } finally {
      decoy.close();
    }
    await assert.rejects(openExecutionReceiptEvidenceStore(path, options), /missing its integrity triggers/, 'a same-named no-op trigger is not the trigger');
    const repaired = new Database(path);
    try {
      repaired.exec('DROP TRIGGER receipt_evidence_never_updated');
      repaired.exec(original);
    } finally {
      repaired.close();
    }
    await assert.rejects(openExecutionReceiptEvidenceStore(path, options), /corrupted row/, 'every row is re-read against its own text');

    const shared = join(built.dir, 'shared');
    mkdirSync(shared);
    chmodSync(shared, 0o777);
    await assert.rejects(openExecutionReceiptEvidenceStore(join(shared, 'evidence.sqlite'), { ...options, create: true }), /writable by no one else/);
  });

  it('a Host that crashes before persisting evidence loses the observation, never the result; nothing is re-presented to recover it', async () => {
    const built = await hostWorld({ trustedExecutors: TRUSTED, respond: (request) => response(201, sign(receiptAbout(presentedCapability(request)))), evidenceUnavailable: true });
    cleanups.push(() => built.close());
    const signed = await built.grant();
    const result = await built.execute(built.actionFor(signed));
    assert.equal(result.outcome, 'completed');
    assert.equal(built.sent.length, 1, 'one send; no retry to obtain evidence');
    const reopened = await openExecutionReceiptEvidenceStore(join(built.dir, 'receipt-evidence.sqlite'), { issuer: G02B_ISSUER, organizationId: G02B_ORGANIZATION, trustDomain: G02B_TRUST_DOMAIN, clock: () => Date.now() });
    try {
      assert.deepEqual(reopened.observationsFor(executionIdOf(signed)), [], 'no evidence — which says nothing about whether the effect happened');
    } finally {
      reopened.close();
    }
  });

  it('the store accepts only this Host’s receipts, for the exchange’s own execution and capability', async () => {
    const dir = privateDirectory('frontera-g02c1d-store-');
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const store = await openE2EEvidenceStore(join(dir, 'evidence.sqlite'));
    try {
      let captured: GenericHttpWireRequest | undefined;
      const built = await world(201, (request) => {
        captured = request;
        return [];
      });
      await run(built);
      const capability = presentedCapability(captured as GenericHttpWireRequest);
      const receipt = receiptAbout(capability);
      const canonical = serializeExecutorReceipt(receipt);
      const candidate = { receipt, canonical, signature: signReceiptText(EXECUTOR_KEY.keyFile, canonical) };
      const base = { executionId: capability.executionId, adapterId: E2E_ADAPTER_ID, capabilityId: capability.capabilityId, transmission: 'response' as const, httpStatus: 201, httpOutcome: 'completed' as const, disposition: null, failure: null, receiptDigest: null, agreement: 'consistent' as const };
      const refused = (outcome: { readonly disposition: string; readonly failure: string | null }) => [outcome.disposition, outcome.failure];
      assert.deepEqual(refused(store.record({ ...base, executionId: altered(capability.executionId), candidate })), ['receipt-uncorrelated', 'STORE_SCOPE_MISMATCH']);
      assert.deepEqual(refused(store.record({ ...base, capabilityId: '9'.repeat(64), candidate })), ['receipt-uncorrelated', 'STORE_SCOPE_MISMATCH']);
      const lying = { ...candidate, receipt: { ...receipt, receiptId: 'f'.repeat(64) } as ExecutorReceipt };
      assert.deepEqual(refused(store.record({ ...base, candidate: lying })), ['receipt-invalid', 'STORE_TEXT_MISMATCH'], 'the stored text is judged, never the object handed in');
      assert.deepEqual(store.evidenceFor(capability.executionId), [], 'a refusal is an observation, never evidence');
      assert.equal(store.observationsFor(altered(capability.executionId)).length, 1, 'and never a silent drop');
      const accepted = store.record({ ...base, candidate, agreement: 'contradicts' });
      assert.equal(accepted.disposition, 'receipt-correlated');
      assert.equal(store.observationsFor(capability.executionId).at(-1)?.agreement, 'consistent', 'the agreement is recomputed from the stored text');
    } finally {
      store.close();
    }
  });
});

// ── 5. The one presentation header (D1) ────────────────────────────────────

describe('G-02C1D (D1) — the adapter appends exactly one presentation header, after binding, and changes nothing else', () => {
  it('the gate’s presentation travels as the last header, once; method, target, mapped headers, credential and body are as bound', async () => {
    const built = await world(201);
    const signed = await built.grant();
    const action = built.actionFor(signed);
    await built.execute(action);
    const sent = built.sent[0] as GenericHttpWireRequest;
    const last = sent.headers[sent.headers.length - 1];
    assert.equal(last?.[0], GENERIC_HTTP_PRESENTATION_HEADER);
    assert.equal(sent.headers.filter(([name]) => name === GENERIC_HTTP_PRESENTATION_HEADER).length, 1);
    const unpresented: GenericHttpWireRequest = { ...sent, headers: sent.headers.slice(0, -1) };
    const plan = gatedPlan({ adapterId: E2E_ADAPTER_ID, origin: 'https://api.devops.example', timeoutMs: 5_000 });
    const record = built.issuance.read(executionIdOf(signed));
    assert.ok(record.state === 'issued');
    assert.equal(executionCapabilityActionBindingDigest({ format: 'frontera.http-request-binding.v1', value: genericHttpRequestBinding(plan, unpresented) }), record.capability.actionBinding.digest, 'the binding is of the request without the header');
    assert.ok(sent.headers.some(([name, value]) => name === 'authorization' && value === `Bearer ${CREDENTIAL_TOKEN}`), 'the credential is intact');
    assert.equal(presentedCapability(sent).capabilityId, record.capabilityId, 'it presents exactly the issued capability');
  });

  it('a refusal presents nothing and sends nothing; a malformed or decorated presentation is a refusal', async () => {
    const offers: readonly [string, unknown][] = [
      ['a refusal', { proceed: false }],
      ['a refusal carrying a presentation', { proceed: false, presentation: 'abc' }],
      ['a header injection', { proceed: true, presentation: 'abc\r\nx-injected: 1' }],
      ['an oversized value', { proceed: true, presentation: 'A'.repeat(8_193) }],
      ['an empty value', { proceed: true, presentation: '' }],
      ['a non-string', { proceed: true, presentation: 42 }],
      ['a padded value', { proceed: true, presentation: 'abc=' }],
      ['an accessor', Object.defineProperty({ proceed: true }, 'presentation', { get: () => 'abc', enumerable: true })],
      ['an extra member (a header name)', { proceed: true, presentation: 'abc', header: 'authorization' }],
    ];
    const host = await world(201);
    const action = host.actionFor(await host.grant());
    for (const [label, verdict] of offers) {
      const network = countingNetwork();
      const { gate } = recordingGate(verdict);
      const result: ExecutionAdapterResult = await createGenericHttpExecutionAdapterCore(gatedPlan(), network, gate).execute(action);
      assert.equal(result.outcome, 'failed', label);
      assert.equal(network.sent.length + network.resolved.length, 0, `${label}: no lookup, no send`);
    }
  });

  it('a mapping, a credential header or a provider reference can never name either governed header', () => {
    for (const name of [GENERIC_HTTP_PRESENTATION_HEADER, GENERIC_HTTP_RECEIPT_HEADER, 'Frontera-Execution-Capability']) {
      assert.throws(() => snapshotGenericHttpOptions(gatedOptions({ headers: { [name]: { kind: 'literal', value: 'x' } } })), GenericHttpConfigurationError, `header ${name}`);
      assert.throws(() => snapshotGenericHttpOptions(gatedOptions({ credential: { kind: 'header', name, value: 'secret-value-123' } })), GenericHttpConfigurationError, `credential ${name}`);
      assert.throws(() => snapshotGenericHttpOptions(gatedOptions({ providerRefHeader: name })), GenericHttpConfigurationError, `provider reference ${name}`);
    }
  });

  it('the observer sees only presented exchanges, after the result is fixed, and can neither change nor withhold it', async () => {
    const seen: GenericHttpExchangeEvidence[] = [];
    const network = countingNetwork(201);
    const host = await world(201);
    const action = host.actionFor(await host.grant());
    const throwing = createGenericHttpExecutionAdapterCore(gatedPlan(), network, recordingGate({ proceed: true, presentation: 'abc' }).gate, async (exchange) => {
      seen.push(exchange);
      throw new Error('the evidence path failed');
    });
    assert.equal((await throwing.execute(action)).outcome, 'completed', 'a failing observer leaves the result');
    assert.equal(seen.length, 0, 'the result is handed back before the observer runs');
    await afterObservers();
    assert.equal(seen.length, 1);
    assert.deepEqual([seen[0]?.transmission, seen[0]?.status, seen[0]?.result.outcome], ['response', 201, 'completed']);
    assert.ok(Object.isFrozen(seen[0]));

    const unpresented: GenericHttpExchangeEvidence[] = [];
    const plain = createGenericHttpExecutionAdapterCore(gatedPlan(), countingNetwork(201), recordingGate({ proceed: true }).gate, async (exchange) => {
      unpresented.push(exchange);
    });
    assert.equal((await plain.execute(action)).outcome, 'completed');
    await afterObservers();
    assert.equal(unpresented.length, 0, 'nothing presented, nothing observed');

    const hanging = createGenericHttpExecutionAdapterCore(gatedPlan(), countingNetwork(201), recordingGate({ proceed: true, presentation: 'abc' }).gate, () => new Promise<void>(() => undefined));
    assert.equal((await hanging.execute(action)).outcome, 'completed', 'an observer that never settles cannot hold the result');
  });
});

// ── 6. The executor delivers what it persisted ─────────────────────────────

describe('G-02C1D — the executor delivers the receipt it persisted and signed, and nothing it did not', () => {
  it('the delivered value decodes to the executor receipt ledger’s own artifact; refusals and receipt-less answers carry none', async () => {
    const { receiptDomain, receiptWorld } = await import('./g02c1c-executor-receipt-fixture.js');
    const { hostVector, observedWith } = await import('./g02c1a-reference-executor-fixture.js');
    const { syntheticCapability } = await import('./g02c1b-synthetic-execution-fixture.js');
    const vector = hostVector('POST with a body', { body: { kind: 'json-object', fields: { subject: { kind: 'source', source: 'subject' } } } });
    const domain = await receiptDomain();
    cleanups.push(() => domain.cleanup());
    const flowWorld = await receiptWorld(domain);
    try {
      const { capability, presentation } = syntheticCapability(vector.digest);
      const record = flowWorld.flow.execute(observedWith(vector, { presentation }));
      assert.equal(record.outcome, 'completed-observed');
      const delivered = flowWorld.flow.answerHeadersOf?.(record)['frontera-execution-receipt'];
      assert.ok(delivered !== undefined);
      const decoded = decodeExecutorReceiptTransport([delivered]);
      assert.ok(decoded.ok);
      const persisted = flowWorld.receipts.history(capability.capabilityId);
      assert.equal(persisted.length, 1);
      assert.equal(decoded.presented.receipt, persisted[0]?.receipt, 'the persisted text, verbatim');
      assert.deepEqual({ ...(decoded.presented.signature as Record<string, string>) }, { ...persisted[0]?.signature });
      assert.equal(JSON.stringify(record).includes(delivered.slice(0, 32)), false, 'never inside the diagnostic record');

      const duplicate = flowWorld.flow.execute(observedWith(vector, { presentation }));
      assert.equal(duplicate.outcome, 'already-consumed');
      assert.equal(flowWorld.flow.answerHeadersOf?.(duplicate)['frontera-execution-receipt'], delivered, 'a duplicate replays the persisted receipt and performs nothing');
      assert.equal(domain.records().length, 1);

      const refusal = flowWorld.flow.execute(observedWith(vector, { presentation: 'not-a-presentation' }));
      assert.equal(refusal.outcome, 'refused');
      assert.deepEqual(flowWorld.flow.answerHeadersOf?.(refusal), {});
    } finally {
      flowWorld.close();
    }
  });

  it('a receipt the executor did not persist is never delivered: no receipts configured, no header', async () => {
    const { inProcessFlow, syntheticDomain, syntheticCapability } = await import('./g02c1b-synthetic-execution-fixture.js');
    const { hostVector, observedWith } = await import('./g02c1a-reference-executor-fixture.js');
    const vector = hostVector('POST plain');
    const domain = await syntheticDomain();
    cleanups.push(() => domain.cleanup());
    const flowWorld = await inProcessFlow(domain);
    try {
      const { presentation } = syntheticCapability(vector.digest);
      const record = flowWorld.flow.execute(observedWith(vector, { presentation }));
      assert.equal(record.outcome, 'completed-observed');
      assert.deepEqual(flowWorld.flow.answerHeadersOf?.(record), {});
    } finally {
      flowWorld.close();
    }
  });

  it('the trust registry refuses a duplicate, an empty or a wildcard executor', () => {
    assert.throws(() => createExecutionReceiptTrust([...TRUSTED, ...TRUSTED]), /trust registry is invalid/);
    assert.throws(() => createExecutionReceiptTrust([e2eTrustedExecutor(EXECUTOR_KEY.publicKeyPem, { keys: [] })]), /trust registry is invalid/);
    assert.throws(() => createExecutionReceiptTrust([e2eTrustedExecutor(EXECUTOR_KEY.publicKeyPem, { executorId: '*' })]), /trust registry is invalid/);
    assert.equal(createExecutionReceiptTrust(TRUSTED).trustedExecutors.join(), E2E_EXECUTOR_ID);
  });
});
