import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AuthorityStateFreshnessError } from '../authority-state-freshness/errors.js';
import type { TradeLedgerReader, TradeRecoveryInput, TradeSubmissionRecord, TradeTransactionIdentity } from '../xrpl-trade-execution/index.js';
import { closeAllWitnesses } from './core07-freshness-fixture.js';
import { testAccount } from './trade04b-xrpl-fixture.js';
import { executorRig, rawProposal, validatedAction } from './trade04c-execution-fixture.js';

/**
 * TRADE-04D mutation qualification (§12), in TRADE-04C's manner: each
 * load-bearing recovery check is removed from the **compiled** module, the
 * mutant is loaded beside the original, and the guarding property must fail
 * for it (`detected`) — or keep holding because an independent, separately
 * qualified boundary still refuses (`contained`, which names that boundary).
 * The original module is never modified; every mutant file is removed.
 */

const load = createRequire(__filename);
const ENTERPRISE = join(__dirname, '..');
const tmp = mkdtempSync(join(tmpdir(), 'trade04d-mutation-'));
after(async () => {
  await closeAllWitnesses();
  rmSync(tmp, { recursive: true, force: true });
});

interface Mutant<M> {
  readonly id: string;
  readonly file: string;
  readonly replacements: readonly (readonly [string, string])[];
  readonly guard: (module: M) => boolean | Promise<boolean>;
  readonly expect?: 'detected' | 'contained';
  /** For `contained`: what still refuses. */
  readonly containedBy?: string;
}

const results: { id: string; outcome: string; containedBy?: string }[] = [];

async function qualify<M>(mutant: Mutant<M>): Promise<void> {
  const path = join(ENTERPRISE, mutant.file);
  let source = readFileSync(path, 'utf8');
  const original = source;
  for (const [search, replace] of mutant.replacements) {
    assert.equal(source.split(search).length - 1, 1, `${mutant.id}: the mutation site occurs exactly once in ${mutant.file}: ${search.slice(0, 80)}`);
    source = source.split(search).join(replace);
  }
  const mutantPath = path.replace(/\.js$/, `.mutant-${mutant.id}.js`);
  writeFileSync(mutantPath, source);
  try {
    assert.equal(await mutant.guard(load(path) as M), true, `${mutant.id}: the guard holds for the shipped module`);
    const held = await mutant.guard(load(mutantPath) as M);
    const expected = mutant.expect ?? 'detected';
    if (expected === 'detected') assert.equal(held, false, `${mutant.id}: the guard detects the removed check`);
    else assert.equal(held, true, `${mutant.id}: contained by ${mutant.containedBy}`);
    results.push({ id: mutant.id, outcome: expected, ...(mutant.containedBy !== undefined ? { containedBy: mutant.containedBy } : {}) });
  } finally {
    delete load.cache[load.resolve(mutantPath)];
    rmSync(mutantPath, { force: true });
    assert.equal(readFileSync(path, 'utf8'), original, 'the shipped module is untouched');
  }
}

// ── shared inputs ──
const OWNER = testAccount();
const DELEGATE = testAccount();
const HASH = 'A'.repeat(64);
const IDENTITY: TradeTransactionIdentity = { transactionHash: HASH, account: OWNER, delegateAccount: DELEGATE, sequence: 41, lastLedgerSequence: 120, minLedger: 101 };
const body = (overrides: Record<string, unknown> = {}) => ({ Account: OWNER, Delegate: DELEGATE, TransactionType: 'OfferCreate', Sequence: 41, LastLedgerSequence: 120, TakerGets: '1000', TakerPays: { currency: 'USD', issuer: DELEGATE, value: '5' }, Flags: 0, ...overrides });
const validated = (overrides: Record<string, unknown> = {}, tx = body()) => ({ hash: HASH, validated: true, ledger_index: 110, ledger_hash: 'B'.repeat(64), tx_json: tx, meta: { TransactionResult: 'tesSUCCESS', AffectedNodes: [] }, ...overrides });
function stub(lookup: unknown, options: { readonly network?: number; readonly indices?: readonly number[] } = {}): TradeLedgerReader {
  const indices = [...(options.indices ?? [125, 125])];
  return {
    connect: async () => {},
    serverInfo: async () => ({ info: { network_id: options.network ?? 1 } }),
    validatedLedgerIndex: async () => (indices.length > 1 ? indices.shift() : indices[0]),
    lookupTransaction: async () => lookup,
  };
}
const OPTIONS = { networkId: 1, requestTimeoutMs: 1_000 };

function row(state: TradeSubmissionRecord['state'], overrides: Partial<TradeSubmissionRecord> = {}): TradeSubmissionRecord {
  return {
    executionId: 'aoc.exec:m',
    account: OWNER,
    sequence: 41,
    lastLedgerSequence: 120,
    minLedger: 101,
    transactionHash: HASH,
    transactionType: 'OfferCreate',
    state,
    submissionAttempts: state === 'reserved' ? 0 : 1,
    transitions: [],
    reservedAt: 'x',
    updatedAt: 'x',
    evidence: { organizationId: 'org-acme', subject: 's', requestId: 'req-1', decisionId: 'dec-1', boundedGrantId: 'grant-1', proposalDigest: 'sha256:x', delegateAccount: DELEGATE, signerId: 'sig', signerRequestId: 'r', signingPublicKey: 'ED00', keyAuthority: 'master-key', preparedDigest: 'sha256:p', delegationAssessmentDigest: 'sha256:a', delegationFactsDigest: 'sha256:f', referenceLedgerIndex: 100, referenceLedgerHash: 'B'.repeat(64), delegationLedgerIndex: 100, delegateRootLedgerIndex: 100, ownerRootLedgerIndex: 100, fee: '12', ledgerProvenance: 'injected-ledger-client' },
    ...overrides,
  };
}
const attempt = { organizationId: 'org-acme', executionId: 'aoc.exec:m', requestId: 'req-1', decisionId: 'dec-1', boundedGrantId: 'grant-1', action: 'trade.offer-create' };

type EvidenceModule = typeof import('../xrpl-trade-execution/trade-ledger-evidence.js');
type OfferModule = typeof import('../xrpl-trade-execution/trade-offer-state.js');
type AssessmentModule = typeof import('../xrpl-trade-execution/trade-recovery-assessment.js');
type CoordinatorModule = typeof import('../xrpl-trade-execution/trade-recovery-coordinator.js');
type ResolverModule = typeof import('../xrpl-trade-execution/trade-resolution-authority.js');
type LedgerModule = typeof import('../xrpl-trade-rail/reference/reference-capability-ledger.js');
type ExecutorModule = typeof import('../xrpl-trade-execution/trade-offer-executor.js');
const EVIDENCE = 'xrpl-trade-execution/trade-ledger-evidence.js';
const OFFER = 'xrpl-trade-execution/trade-offer-state.js';
const ASSESSMENT = 'xrpl-trade-execution/trade-recovery-assessment.js';
const COORDINATOR = 'xrpl-trade-execution/trade-recovery-coordinator.js';
const RESOLVER = 'xrpl-trade-execution/trade-resolution-authority.js';
const LEDGER = 'xrpl-trade-rail/reference/reference-capability-ledger.js';
const EXECUTOR = 'xrpl-trade-execution/trade-offer-executor.js';

const unresolved = async (m: EvidenceModule, lookup: unknown, options: Parameters<typeof stub>[1] = {}): Promise<boolean> => (await m.readTradeLedgerEvidence(stub(lookup, options), IDENTITY, OPTIONS)).status === 'unresolved';

describe('TRADE-04D mutations — the validated-ledger evidence contract', () => {
  const mutants: readonly Mutant<EvidenceModule>[] = [
    { id: 'transaction-hash-binding', file: EVIDENCE, replacements: [['(0, index_js_1.readXrplInclusion)(raw, identity.transactionHash);', "(0, index_js_1.readXrplInclusion)(raw, recordOf(raw)?.['hash']);"]], guard: (m) => unresolved(m, validated({ hash: 'C'.repeat(64) })) },
    { id: 'owner-account-binding', file: EVIDENCE, replacements: [["    if (body['Account'] !== identity.account)\n        return demoted('wrong-account');", '']], guard: (m) => unresolved(m, validated({}, body({ Account: testAccount() }))) },
    { id: 'sequence-binding', file: EVIDENCE, replacements: [["    if (body['Sequence'] !== identity.sequence)\n        return demoted('sequence-mismatch');", '']], guard: (m) => unresolved(m, validated({}, body({ Sequence: 42 }))) },
    {
      id: 'network-identity-check-before-lookup',
      file: EVIDENCE,
      replacements: [["        if ((0, index_js_1.readXrplNetworkId)(await ledger.serverInfo()) !== networkId)\n            return unresolved('network-mismatch');", '        await ledger.serverInfo();']],
      expect: 'contained',
      containedBy: 'the same check repeated after the lookup (network-changed)',
      guard: (m) => unresolved(m, validated(), { network: 2 }),
    },
    {
      id: 'network-identity-checks-both',
      file: EVIDENCE,
      replacements: [
        ["        if ((0, index_js_1.readXrplNetworkId)(await ledger.serverInfo()) !== networkId)\n            return unresolved('network-mismatch');", '        await ledger.serverInfo();'],
        ["        if ((0, index_js_1.readXrplNetworkId)(await ledger.serverInfo()) !== networkId)\n            return unresolved('network-changed', before);", '        await ledger.serverInfo();'],
      ],
      guard: (m) => unresolved(m, validated(), { network: 2 }),
    },
    { id: 'last-ledger-sequence-boundary', file: EVIDENCE, replacements: [['(0, index_js_1.xrplNonInclusionProven)(reading, before, identity.lastLedgerSequence)', '(0, index_js_1.xrplNonInclusionProven)(reading, before + 1, identity.lastLedgerSequence)']], guard: (m) => unresolved(m, { error: 'txnNotFound', searched_all: true }, { indices: [119, 119] }) },
    { id: 'inclusion-beyond-validated-index', file: EVIDENCE, replacements: [["        if (reading.ledgerIndex > after)\n            return unresolved('ledger-index-disagreement', before);", '']], guard: (m) => unresolved(m, validated({ ledger_index: 110 }), { indices: [105, 105] }) },
    { id: 'complete-non-inclusion-proof', file: EVIDENCE, replacements: [["    if (result?.['error'] === 'txnNotFound')\n        return unresolved('history-incomplete', before);", "    if (result?.['error'] === 'txnNotFound')\n        return Object.freeze({ status: 'not-included', networkId, transactionHash: identity.transactionHash, searchedFrom: identity.minLedger, searchedTo: identity.lastLedgerSequence, validatedIndexBefore: before, validatedIndexAfter: after });"]], guard: (m) => unresolved(m, { error: 'txnNotFound', searched_all: false }) },
    { id: 'result-code-classification', file: EVIDENCE, replacements: [["resultClass: reading.engineResult === 'tesSUCCESS' ? 'tesSUCCESS' : 'tec',", "resultClass: 'tesSUCCESS',"]], guard: async (m) => { const e = await m.readTradeLedgerEvidence(stub(validated({ meta: { TransactionResult: 'tecKILLED' } })), IDENTITY, OPTIONS); return e.status === 'included' && e.resultClass === 'tec'; } },
    { id: 'validated-result-class-only', file: EVIDENCE, replacements: [["        return demoted('result-unrecognized');", '        void 0;']], guard: (m) => unresolved(m, validated({ meta: { TransactionResult: 'tefPAST_SEQ' } })) },
  ];
  for (const mutant of mutants) it(`${mutant.expect ?? 'detected'}: ${mutant.id}`, () => qualify(mutant));
});

describe('TRADE-04D mutations — offer metadata classification', () => {
  const included = (nodes: unknown[], tx: Record<string, unknown> = body()) => ({ status: 'included' as const, networkId: 1, transactionHash: HASH, engineResult: 'tesSUCCESS', resultClass: 'tesSUCCESS' as const, ledgerIndex: 110, ledgerHash: 'B'.repeat(64), validatedIndexBefore: 111, validatedIndexAfter: 111, transaction: tx, meta: { AffectedNodes: nodes } });
  const created = (gets: string, value: string) => ({ CreatedNode: { LedgerEntryType: 'Offer', LedgerIndex: 'C'.repeat(64), NewFields: { Account: OWNER, Sequence: 41, TakerGets: gets, TakerPays: { currency: 'USD', issuer: DELEGATE, value } } } });
  const mutants: readonly Mutant<OfferModule>[] = [
    { id: 'partial-fill-read-as-resting', file: OFFER, replacements: [['    if (gets === 0 && pays === 0)', '    if (gets !== undefined && pays !== undefined)']], guard: (m) => m.readOfferCreateEffect(included([created('500', '2.5')]), OWNER, 41).effect === 'partially-executed-remainder-resting' },
    { id: 'fill-or-kill-required-for-full-execution', file: OFFER, replacements: [['        if ((flagValue & TF_FILL_OR_KILL) !== 0)', '        if (true)']], guard: (m) => m.readOfferCreateEffect(included([]), OWNER, 41).effect === 'applied-not-resting' },
    {
      id: 'snapshot-before-inclusion-accepted',
      file: OFFER,
      replacements: [["    if (snapshot.ledgerIndex < initial.ledgerIndex)\n        return answer(placed ? 'placed-as-of-inclusion' : 'not-placed', 'snapshot-precedes-inclusion');", '']],
      guard: (m) => {
        const initial = m.readOfferCreateEffect(included([created('1000', '5')]), OWNER, 41);
        return m.assessTradeOfferState(initial, { basis: 'validated-offer-snapshot', state: 'not-present', ledgerIndex: 100, ledgerHash: 'B'.repeat(64) }).interpretation !== 'no-longer-present-as-of-snapshot';
      },
    },
  ];
  for (const mutant of mutants) it(`${mutant.expect ?? 'detected'}: ${mutant.id}`, () => qualify(mutant));
});

describe('TRADE-04D mutations — the recovery assessment', () => {
  const base = (overrides: Partial<TradeRecoveryInput>): TradeRecoveryInput => ({ executionId: 'aoc.exec:m', interlock: { status: 'read', record: row('unconfirmed') }, p11: { record: { attempt, terminal: { observation: { kind: 'provider', certainty: 'unconfirmed', providerRef: HASH } } } }, ...overrides });
  const mutants: readonly Mutant<AssessmentModule>[] = [
    { id: 'signer-restore-trusted', file: ASSESSMENT, replacements: [["            if (signer.state === 'absent' || signer.state === 'signing-failed')\n                inconsistencies.push('signer-denies-host-verified-signature');", '']], guard: (m) => m.assessTradeRecovery(base({ signer: { source: 'customer-signer-ledger', executionId: 'aoc.exec:m', state: 'absent' } })).class === 'inconsistent-evidence' },
    { id: 'sequence-released-without-ledger-index', file: ASSESSMENT, replacements: [["        else if (validatedIndex === undefined)\n            sequenceStatus = 'unknown';", "        else if (validatedIndex === undefined)\n            sequenceStatus = 'window-closed-record-open';"]], guard: (m) => { const a = m.assessTradeRecovery(base({})); return a.sequence.status === 'unknown' && a.automatedRecovery.refusals.includes('sequence-held-until-ledger-fact'); } },
    { id: 'authority-to-outcome-binding', file: ASSESSMENT, replacements: [["                inconsistencies.push('p11-identity-mismatch');", '                void 0;']], guard: (m) => m.assessTradeRecovery(base({ p11: { record: { attempt: { ...attempt, boundedGrantId: 'grant-other' } } } })).class === 'inconsistent-evidence' },
  ];
  for (const mutant of mutants) it(`${mutant.expect ?? 'detected'}: ${mutant.id}`, () => qualify(mutant));
});

describe('TRADE-04D mutations — CORE-07 freshness and rollback on the recovery read', () => {
  const ledger = { ...stub({ error: 'txnNotFound', searched_all: true }), ledgerHeader: async () => ({}), ledgerEntry: async () => ({}) };
  const coordinatorOf = (m: CoordinatorModule, interlock: Parameters<CoordinatorModule['createTradeRecoveryCoordinator']>[0]['interlock']) => m.createTradeRecoveryCoordinator({ networkId: 1, requestTimeoutMs: 1_000, maxValidatedLedgerAgeSeconds: 10, ledger, interlock });
  const mutants: readonly Mutant<CoordinatorModule>[] = [
    { id: 'core07-failed-status-ignored', file: COORDINATOR, replacements: [['        if (freshness !== undefined && FAILED_FRESHNESS.has(freshness))', '        if (false)']], guard: async (m) => (await coordinatorOf(m, { read: async () => undefined, health: async () => ({ freshness: 'regressed' }) }).assess('aoc.exec:m', { p11: { record: undefined } })).assessment.class === 'indeterminate' },
    {
      id: 'rollback-error-read-as-empty',
      file: COORDINATOR,
      replacements: [["        if (error instanceof errors_js_1.AuthorityStateFreshnessError)\n            return Object.freeze({ status: 'unavailable', reason: 'freshness-unproven' });", "        if (error instanceof errors_js_1.AuthorityStateFreshnessError)\n            return Object.freeze({ status: 'read', record: undefined });"]],
      guard: async (m) => (await coordinatorOf(m, { read: async () => Promise.reject(new AuthorityStateFreshnessError('AUTHORITY_FRESHNESS_ROLLBACK_DETECTED', 'rolled back')) }).assess('aoc.exec:m', { p11: { record: undefined } })).assessment.certainty !== 'proven',
    },
  ];
  for (const mutant of mutants) it(`${mutant.expect ?? 'detected'}: ${mutant.id}`, () => qualify(mutant));
});

describe('TRADE-04D mutations — the P12 authority’s authority-to-outcome binding', () => {
  const mutants: readonly Mutant<ResolverModule>[] = [
    {
      id: 'resolver-grant-binding',
      file: RESOLVER,
      replacements: [['        if (record.evidence.boundedGrantId !== query.boundedGrantId || record.evidence.decisionId !== query.decisionId || record.evidence.requestId !== query.requestId)', '        if (false)']],
      guard: async (m) => {
        const authority = m.createTradeResolutionAuthority({ networkId: 1, action: 'trade.offer-create', requestTimeoutMs: 1_000, ledger: stub(validated()), interlock: { read: async () => row('unconfirmed'), settle: async () => {} } });
        const answer = await authority.resolve({ organizationId: 'org-acme', executionId: 'aoc.exec:m', evaluationId: 'e', requestId: 'req-1', decisionId: 'dec-1', boundedGrantId: 'grant-other', action: 'trade.offer-create', providerRef: HASH, basis: 'initial-observation-unconfirmed' });
        return answer.outcome === 'unresolved';
      },
    },
  ];
  for (const mutant of mutants) it(`${mutant.expect ?? 'detected'}: ${mutant.id}`, () => qualify(mutant));
});

describe('TRADE-04D mutations — the signer ledger: no implicit recreation, replay protection across restarts', () => {
  let n = 0;
  const path = (): string => join(tmp, `ledger-${(n += 1)}.sqlite`);
  const entry = (capabilityId: string, executionId: string) => ({ capabilityId, executionId, boundedGrantId: 'g', signingPreimageDigest: `sha256:${'1'.repeat(64)}`, expiresAt: new Date(Date.now() + 30_000).toISOString() });
  const missingRefused = async (m: LedgerModule): Promise<boolean> => {
    const file = path();
    try {
      (await m.openReferenceCapabilityLedger(file)).close();
      return false;
    } catch {
      return !existsSync(file);
    }
  };
  const mutants: readonly Mutant<LedgerModule>[] = [
    { id: 'implicit-creation-guard', file: LEDGER, replacements: [['    if (!(0, node_fs_1.existsSync)(file) && !create) {', '    if (false) {']], expect: 'contained', containedBy: "SQLite's fileMustExist on a non-create open", guard: missingRefused },
    { id: 'implicit-creation-both-guards', file: LEDGER, replacements: [['    if (!(0, node_fs_1.existsSync)(file) && !create) {', '    if (false) {'], ['    const db = new Database(file, create ? {} : { fileMustExist: true });', '    const db = new Database(file);']], guard: missingRefused },
    {
      id: 'replay-ledger-forgets-at-restart',
      file: LEDGER,
      replacements: [['    const db = new Database(file, create ? {} : { fileMustExist: true });', "    const db = new Database(':memory:');"]],
      guard: async (m) => {
        const file = path();
        const first = await m.openReferenceCapabilityLedger(file, { create: true });
        first.consume(entry('cap-1', 'exec-1'), new Date().toISOString());
        first.close();
        const second = await m.openReferenceCapabilityLedger(file, { create: true });
        try {
          return second.consume(entry('cap-1', 'exec-1'), new Date().toISOString()) === 'capability-consumed';
        } finally {
          second.close();
        }
      },
    },
  ];
  for (const mutant of mutants) it(`${mutant.expect ?? 'detected'}: ${mutant.id}`, () => qualify(mutant));
});

describe('TRADE-04D mutations — the executor never repeats an attempted execution', () => {
  const mutants: readonly Mutant<ExecutorModule>[] = [
    {
      id: 'no-repeat-recorded-check',
      file: EXECUTOR,
      replacements: [["                if (typeof earlier === 'string')\n                    return finish(unconfirmed(earlier, trade_execution_details_js_1.TRADE_EXECUTION_DETAILS.PREVIOUSLY_RECORDED), { transactionHash: earlier });", '']],
      expect: 'contained',
      containedBy: 'the signer’s durable execution uniqueness (no second signature) and the interlock’s execution-recorded reservation (no second submission)',
      guard: async (m) => {
        const rig = await executorRig({ create: m.createTradeOfferExecutionAdapter });
        try {
          const raw = rawProposal(rig.pairs[0]!);
          rig.book.attest(raw);
          const action = validatedAction(raw);
          await rig.adapter.execute(action);
          const before = { signatures: rig.signer.signatures(), sends: rig.ledger.submitCalls.length };
          await rig.adapter.execute(action);
          return rig.signer.signatures() === before.signatures && rig.ledger.submitCalls.length === before.sends;
        } finally {
          await rig.close();
        }
      },
    },
  ];
  for (const mutant of mutants) it(`${mutant.expect ?? 'detected'}: ${mutant.id}`, () => qualify(mutant));
});

describe('TRADE-04D mutations — summary', () => {
  it('every mutant was qualified; none survived unexplained', () => {
    const contained = results.filter((result) => result.outcome === 'contained');
    assert.ok(contained.every((result) => typeof result.containedBy === 'string' && result.containedBy.length > 0));
    // Printed for the qualification record.
    console.log(JSON.stringify({ mutants: results.length, detected: results.length - contained.length, contained: contained.map((result) => ({ id: result.id, containedBy: result.containedBy })) }));
  });
});
