import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { XRPL_ACCOUNT_FLAG_DISABLE_MASTER } from '../../features/trade-runtime/rails/xrpl/index.js';
import { TRADE_PARAMETER_DIMENSION_IDS as P } from '../../features/trade-runtime/index.js';
import type { ValidatedExecutionAction } from '../../features/execution-runtime/index.js';
import { closeAllWitnesses, closeDeploymentWitnesses, startWitness } from './core07-freshness-fixture.js';
import { decodeBlob, testDelegate } from './trade04b-xrpl-fixture.js';
import { NETWORK_ID, ORG, executorRig, rawProposal, scratch, validatedAction, type ExecutorRig } from './trade04c-execution-fixture.js';
import { S1_TRUST_DOMAIN } from './trade04c-s1-capability-fixture.js';
import { XRPL_TRADE_EXECUTOR_ID } from '../xrpl-trade-execution/host-configuration.js';
import { boundaryFor } from './core07-freshness-fixture.js';

/**
 * TRADE-04C mutation qualification (prompt §20), in TRADE-03's and TRADE-04B's
 * manner: each load-bearing check is removed from the **compiled** module, the
 * mutant is loaded beside the original, and the guarding property must then
 * fail. The original module is never modified; every mutant file is removed
 * after use.
 *
 * Two classes:
 * - **detected** — the guard holds for the shipped module and fails for the
 *   mutant: the check is load-bearing and a test notices its removal;
 * - **contained** — the mutant removes a check, but an independent boundary
 *   still refuses: the submit site's durable, single-use claim (the G2
 *   property — "no send without a matching reservation, never twice" —
 *   holding even against a defective executor), the SQL schema's own
 *   uniqueness, TRADE-02's assessment, or a second executor check over the
 *   same binding. The guard holds for both; each names what contains it.
 *   They are listed, not hidden.
 */

const load = createRequire(__filename);
const ENTERPRISE = join(__dirname, '..');
after(async () => {
  await closeAllWitnesses();
  await closeDeploymentWitnesses();
});

interface Mutant<M> {
  readonly id: string;
  readonly file: string;
  readonly search: string;
  readonly replace: string;
  readonly occurrences?: number;
  readonly guard: (module: M) => boolean | Promise<boolean>;
  /** `contained`: the property holds even for the mutant, because another boundary enforces it. */
  readonly expect?: 'detected' | 'contained';
}

async function qualify<M>(mutant: Mutant<M>): Promise<void> {
  const path = join(ENTERPRISE, mutant.file);
  const source = readFileSync(path, 'utf8');
  assert.equal(source.split(mutant.search).length - 1, mutant.occurrences ?? 1, `${mutant.id}: the mutation site occurs exactly as expected in ${mutant.file}`);
  const mutantPath = path.replace(/\.js$/, `.mutant-${mutant.id}.js`);
  writeFileSync(mutantPath, source.split(mutant.search).join(mutant.replace));
  try {
    assert.equal(await mutant.guard(load(path) as M), true, `${mutant.id}: the guard holds for the shipped module`);
    const held = await mutant.guard(load(mutantPath) as M);
    if ((mutant.expect ?? 'detected') === 'detected') assert.equal(held, false, `${mutant.id}: the guard detects the removed check`);
    else assert.equal(held, true, `${mutant.id}: contained by an independent boundary below the executor`);
  } finally {
    delete load.cache[load.resolve(mutantPath)];
    rmSync(mutantPath, { force: true });
  }
}

type ExecutorModule = typeof import('../xrpl-trade-execution/trade-offer-executor.js');
type InterlockModule = typeof import('../xrpl-trade-execution/sqlite-trade-sequence-interlock.js');
const EXECUTOR = 'xrpl-trade-execution/trade-offer-executor.js';
const INTERLOCK = 'xrpl-trade-execution/sqlite-trade-sequence-interlock.js';

/** Runs `body` against a rig built from `module`; answers `body`'s verdict. */
async function withRig(module: ExecutorModule, body: (rig: ExecutorRig) => Promise<boolean>, options: Parameters<typeof executorRig>[0] = {}): Promise<boolean> {
  const rig = await executorRig({ ...options, create: module.createTradeOfferExecutionAdapter });
  try {
    return await body(rig);
  } finally {
    await rig.close();
  }
}

function order(rig: ExecutorRig, overrides: Record<string, unknown> = {}): ValidatedExecutionAction {
  const raw = rawProposal(rig.pairs[0]!, overrides);
  rig.book.attest(raw);
  return validatedAction(raw);
}

const withParameter = (action: ValidatedExecutionAction, dimension: string, value: string): ValidatedExecutionAction =>
  ({ ...action, parameters: action.parameters!.map((parameter) => (parameter.dimension === dimension ? { ...parameter, value } : parameter)) }) as ValidatedExecutionAction;

/** The property: refused with nothing signed and nothing sent. */
const refusedUnsigned = (rig: ExecutorRig, result: { readonly outcome: string }): boolean => result.outcome === 'failed' && rig.signer.signatures() === 0 && rig.ledger.submitCalls.length === 0;

describe('TRADE-04C mutations — the executor (grant binding, ledger reliance, transaction integrity, uncertainty)', () => {
  const mutants: readonly Mutant<ExecutorModule>[] = [
    {
      id: 'remove-bounded-parameter-check',
      file: EXECUTOR,
      search: "        if (values.get(dimension) !== intent.parameters[dimension])\n            return 'unbound';",
      replace: '        void dimension;',
      guard: (module) => withRig(module, async (rig) => refusedUnsigned(rig, await rig.adapter.execute(withParameter(order(rig), P.quantity, '101')))),
    },
    {
      id: 'remove-attested-digest-binding',
      file: EXECUTOR,
      search: 'if (!validation.valid || validation.accepted.digest !== digest)',
      replace: 'if (!validation.valid)',
      // Contained by the parameter comparison: the digest dimension, recompiled from the altered proposal, no longer equals the granted digest.
      expect: 'contained',
      guard: (module) =>
        withRig(module, async (rig) => {
          const action = order(rig);
          const digest = action.parameters!.find((parameter) => parameter.dimension === P.proposalDigest)!.value as string;
          const record = rig.book.records.get(digest)!;
          // Change TakerPays after the grant: the attested record no longer matches its digest.
          rig.book.records.set(digest, { ...record, proposal: { ...record.proposal, takerPays: { currency: 'XRP', drops: '1' } } as typeof record.proposal });
          return refusedUnsigned(rig, await rig.adapter.execute(action));
        }),
    },
    {
      id: 'remove-subject-organization-binding',
      file: EXECUTOR,
      search: 'if (action.organization !== attested.organizationId || action.subject !== attested.actorId)',
      replace: 'if (false)',
      guard: (module) => withRig(module, async (rig) => refusedUnsigned(rig, await rig.adapter.execute({ ...order(rig), subject: 'actor-intruder' }))),
    },
    {
      id: 'change-taker-gets-after-grant',
      file: EXECUTOR,
      // TRADE-04C-S1: the executor builds through the shared derivation (`preparedDelegatedOfferFromProposal`); the mutant alters the
      // amount at the executor's binding of it. Detected now by the signer's own proposal-to-transaction check as well.
      search: 'const buildOffer = index_js_5.preparedDelegatedOfferFromProposal;',
      replace: "const buildOffer = (p, f, o) => index_js_5.preparedDelegatedOfferFromProposal('drops' in p.takerGets ? p : { ...p, takerGets: { ...p.takerGets, value: '1000' } }, f, o);",
      guard: (module) =>
        withRig(module, async (rig) => {
          await rig.adapter.execute(order(rig));
          const sent = rig.ledger.submitted[0];
          return sent !== undefined && (decodeBlob(sent.blob)['TakerGets'] as { value?: string }).value === '100';
        }),
    },
    {
      id: 'accept-observations-outside-the-ledger-window',
      file: EXECUTOR,
      search: 'if (index < V || index > V + span)',
      replace: 'if (false)',
      guard: (module) =>
        withRig(module, async (rig) => {
          const action = order(rig);
          rig.ledger.faults.advanceOnEntry = true;
          return refusedUnsigned(rig, await rig.adapter.execute(action));
        }),
    },
    {
      id: 'skip-delegation-scope-reading',
      file: EXECUTOR,
      search: ' || delegation.permissionReading.withinTradingScope !== true) {',
      replace: ') {',
      guard: (module) =>
        withRig(module, async (rig) => {
          const action = order(rig);
          rig.ledger.delegate(rig.pairs[0]!.owner, rig.pairs[0]!.delegate.address, ['OfferCreate', 'Payment']);
          return refusedUnsigned(rig, await rig.adapter.execute(action));
        }),
      // TRADE-02's assessment already answers NOT_AUTHORIZED for an entry beyond the trading scope: the executor's own reading is defence in depth.
      expect: 'contained',
    },
    {
      id: 'skip-delegate-key-verification',
      file: EXECUTOR,
      search: '        if (!key.authorized)\n            throw',
      replace: '        if (false)\n            throw',
      guard: (module) =>
        withRig(module, async (rig) => {
          const action = order(rig);
          rig.ledger.fund(rig.pairs[0]!.delegate.address, 5, { flags: XRPL_ACCOUNT_FLAG_DISABLE_MASTER });
          return refusedUnsigned(rig, await rig.adapter.execute(action));
        }),
    },
    {
      id: 'use-the-delegate-sequence',
      file: EXECUTOR,
      search: '(0, index_js_3.readXrplOwnerSequence)(ownerRoot.value.entry.node, pair.ownerAccount)',
      replace: '(0, index_js_3.readXrplOwnerSequence)(delegateRoot.value.entry.node, pair.delegateAccount)',
      guard: (module) =>
        withRig(module, async (rig) => {
          const ownerSequence = rig.ledger.accounts.get(rig.pairs[0]!.owner)!.sequence;
          await rig.adapter.execute(order(rig));
          return rig.ledger.submitted[0]?.sequence === ownerSequence;
        }),
    },
    {
      id: 'skip-sequence-blocking-before-signing',
      file: EXECUTOR,
      search: '        if (blocked)\n            throw',
      replace: '        if (false)\n            throw',
      guard: (module) =>
        withRig(
          module,
          async (rig) => {
            rig.ledger.behavior = { kind: 'drop' };
            rig.ledger.autoAdvance = false;
            await rig.adapter.execute(order(rig));
            const before = rig.signer.signatures();
            await rig.adapter.execute(order(rig));
            // The second order competes with an open window: it must not even be signed.
            return rig.signer.signatures() === before && rig.ledger.submitCalls.length === 1;
          },
          { configuration: { finalityTimeoutMs: 0 } },
        ),
    },
    {
      id: 'submit-before-reservation',
      file: EXECUTOR,
      search: '                    reservation = await interlock.reserve(',
      replace: '                    await ledger.submitReserved(executionId, signature.signedTransaction).catch(() => undefined);\n                    reservation = await interlock.reserve(',
      guard: (module) =>
        withRig(module, async (rig) => {
          await rig.adapter.execute(order(rig));
          // Every send past the submit site is one claimed reservation: exactly one, after the reservation.
          return rig.ledger.submitCalls.length === 1;
        }),
      expect: 'contained',
    },
    {
      id: 'blind-retry-after-uncertain-submission',
      file: EXECUTOR,
      search: '                    answer = await ledger.submitReserved(executionId, signature.signedTransaction);',
      replace: '                    try { answer = await ledger.submitReserved(executionId, signature.signedTransaction); } catch { answer = await ledger.submitReserved(executionId, signature.signedTransaction); }',
      guard: (module) =>
        withRig(module, async (rig) => {
          rig.ledger.behavior = { kind: 'throw-after-send' };
          await rig.adapter.execute(order(rig));
          return rig.ledger.submitCalls.length === 1;
        }),
      expect: 'contained',
    },
    {
      id: 'treat-provisional-success-as-settled',
      file: EXECUTOR,
      search: 'const final = await awaitFinality(executionId, signature.hash, { minLedger: prepared.validated + 1, maxLedger: prepared.offer.LastLedgerSequence });',
      replace: "const final = { result: Object.freeze({ outcome: 'completed', providerRef: signature.hash }), settlement: 'validated-success', detail: 'tesSUCCESS' };",
      guard: (module) =>
        withRig(
          module,
          async (rig) => {
            rig.ledger.behavior = { kind: 'drop' };
            rig.ledger.autoAdvance = false;
            return (await rig.adapter.execute(order(rig))).outcome === 'unconfirmed';
          },
          { configuration: { finalityTimeoutMs: 0 } },
        ),
    },
    {
      id: 'report-uncertain-submission-as-failed',
      file: EXECUTOR,
      search: 'return finish(unconfirmed(signature.hash, trade_execution_details_js_1.TRADE_EXECUTION_DETAILS.SUBMISSION_OUTCOME_UNKNOWN), { transactionHash: signature.hash, evidence });',
      replace: "return finish(failed(F.PROVIDER_UNAVAILABLE, 'trade-submission-outcome-unknown'), { transactionHash: signature.hash, evidence });",
      guard: (module) =>
        withRig(module, async (rig) => {
          rig.ledger.behavior = { kind: 'throw-after-send' };
          return (await rig.adapter.execute(order(rig))).outcome === 'unconfirmed';
        }),
    },
    {
      id: 'accept-a-signature-for-another-transaction',
      file: EXECUTOR,
      search: '(0, index_js_2.canonicalTradeJson)(signature.transaction) !== (0, index_js_2.canonicalTradeJson)(prepared.offer) ||',
      replace: '',
      guard: (module) =>
        withRig(module, async (rig) => {
          const original = rig.signerClient.signDelegatedOffer;
          const tampering = { signDelegatedOffer: async (input: Parameters<typeof original>[0]) => ({ ...(await original(input)), transaction: { ...input.transaction, TakerPays: '1' } }) };
          const adapter = module.createTradeOfferExecutionAdapter({ configuration: (await import('./trade04c-execution-fixture.js')).executorConfiguration(rig.pairs), attested: rig.book, signer: tampering, authorization: { trustDomain: S1_TRUST_DOMAIN, issuer: rig.issuer }, ledger: rig.ledger.client(NETWORK_ID, rig.interlock), interlock: rig.interlock, ledgerProvenance: 'injected-ledger-client', simulation: 'simulated-facts-offline-qualification-only' });
          await adapter.readiness();
          rig.ledger.passQuarantine();
          await adapter.execute(order(rig));
          return rig.ledger.submitCalls.length === 0;
        }),
    },
    {
      id: 'accept-a-wrong-signer-key',
      file: EXECUTOR,
      search: 'signature.signingPublicKey !== pair.signingPublicKey ||',
      replace: '',
      guard: (module) =>
        withRig(module, async (rig) => {
          const original = rig.signerClient.signDelegatedOffer;
          const tampering = { signDelegatedOffer: async (input: Parameters<typeof original>[0]) => ({ ...(await original(input)), signingPublicKey: testDelegate().publicKey }) };
          const adapter = module.createTradeOfferExecutionAdapter({ configuration: (await import('./trade04c-execution-fixture.js')).executorConfiguration(rig.pairs), attested: rig.book, signer: tampering, authorization: { trustDomain: S1_TRUST_DOMAIN, issuer: rig.issuer }, ledger: rig.ledger.client(NETWORK_ID, rig.interlock), interlock: rig.interlock, ledgerProvenance: 'injected-ledger-client', simulation: 'simulated-facts-offline-qualification-only' });
          await adapter.readiness();
          rig.ledger.passQuarantine();
          await adapter.execute(order(rig));
          return rig.ledger.submitCalls.length === 0;
        }),
    },
  ];
  for (const mutant of mutants) it(`${mutant.expect ?? 'detected'}: ${mutant.id}`, () => qualify(mutant));
});

describe('TRADE-04C mutations — the durable trade interlock (G4) and its claim (G2)', () => {
  const now = (): string => new Date().toISOString();
  async function store(module: InterlockModule, accounts: readonly string[]) {
    const witness = await startWitness();
    const space = scratch();
    const interlock = await module.createSqliteTradeSequenceInterlock(join(space.dir, 'i.sqlite'), { scope: { domainId: XRPL_TRADE_EXECUTOR_ID, networkId: 1 }, sequenceAccounts: accounts, now, freshness: { boundary: await boundaryFor(witness, ORG) } });
    return { interlock, witness, close: async () => { await interlock.close(); await witness.close(); space.cleanup(); } };
  }
  const owner = testDelegate().address;
  let n = 0;
  const record = (sequence = 40) => {
    n += 1;
    return {
      executionId: `aoc.exec:mutant-${n}`,
      account: owner,
      sequence,
      lastLedgerSequence: 520,
      minLedger: 501,
      transactionHash: n.toString(16).toUpperCase().padStart(64, 'B'),
      evidence: { organizationId: ORG, subject: 'a', requestId: 'r', decisionId: 'd', boundedGrantId: 'g', proposalDigest: `sha256:${'a'.repeat(64)}`, delegateAccount: testDelegate().address, signerId: 's', signerRequestId: 'f'.repeat(64), signingPublicKey: `ED${'1'.repeat(64)}`, keyAuthority: 'master-key' as const, preparedDigest: `sha256:${'b'.repeat(64)}`, delegationAssessmentDigest: `sha256:${'c'.repeat(64)}`, delegationFactsDigest: `sha256:${'d'.repeat(64)}`, referenceLedgerIndex: 500, referenceLedgerHash: 'E'.repeat(64), delegationLedgerIndex: 500, delegateRootLedgerIndex: 500, ownerRootLedgerIndex: 500, fee: '12', ledgerProvenance: 'injected-ledger-client' as const },
    };
  };
  const claimOf = (r: ReturnType<typeof record>, hash = r.transactionHash) => ({ executionId: r.executionId, networkId: 1, transactionHash: hash, transactionType: 'OfferCreate', account: r.account, sequence: r.sequence, lastLedgerSequence: r.lastLedgerSequence });
  const refused = async (promise: Promise<unknown>): Promise<boolean> => promise.then(() => false, () => true);

  const mutants: readonly Mutant<InterlockModule>[] = [
    {
      id: 'claim-ignores-the-transaction-hash',
      file: INTERLOCK,
      search: 'if (claim.transactionHash !== record.transactionHash)',
      replace: 'if (false)',
      guard: async (module) => {
        const s = await store(module, [owner]);
        try {
          const r = record();
          await s.interlock.reserve(r, 500);
          return await refused(s.interlock.claimSubmission(claimOf(r, 'F'.repeat(64))));
        } finally {
          await s.close();
        }
      },
    },
    {
      id: 'claim-allowed-twice',
      file: INTERLOCK,
      search: "if (record.state !== 'reserved')\n                        throw claimRefused('already-claimed');",
      replace: 'void record;',
      occurrences: 2,
      // Contained by the schema: trade_anchored_events is UNIQUE (kind, execution_id), so a second claim cannot commit.
      expect: 'contained',
      guard: async (module) => {
        const s = await store(module, [owner]);
        try {
          const r = record();
          await s.interlock.reserve(r, 500);
          await s.interlock.claimSubmission(claimOf(r));
          return await refused(s.interlock.claimSubmission(claimOf(r)));
        } finally {
          await s.close();
        }
      },
    },
    {
      id: 'skip-sequence-blocking-at-reservation',
      file: INTERLOCK,
      search: "if (openBlocking(input.account, input.sequence, validatedLedgerIndex))\n                        return { done: { outcome: 'blocked' } };",
      replace: '',
      guard: async (module) => {
        const s = await store(module, [owner]);
        try {
          await s.interlock.reserve(record(40), 500);
          return (await s.interlock.reserve(record(40), 500)).outcome === 'blocked';
        } finally {
          await s.close();
        }
      },
    },
    {
      id: 'release-an-uncertain-window-without-ledger-evidence',
      file: INTERLOCK,
      search: "open: record.state !== 'settled' }",
      replace: "open: record.state !== 'settled' && record.state !== 'unconfirmed' }",
      guard: async (module) => {
        const s = await store(module, [owner]);
        try {
          const r = record(40);
          await s.interlock.reserve(r, 500);
          await s.interlock.claimSubmission(claimOf(r));
          await s.interlock.markUnconfirmed(r.executionId, r.transactionHash);
          return (await s.interlock.blocking({ account: owner, sequence: 40, validatedLedgerIndex: 500 })) === true;
        } finally {
          await s.close();
        }
      },
    },
    {
      id: 'ignore-core07-freshness-before-signing',
      file: INTERLOCK,
      search: "            if (freshnessNow.status !== 'ready')\n                throw",
      replace: '            if (false)\n                throw',
      guard: async (module) => {
        const s = await store(module, [owner]);
        try {
          await s.witness.close();
          return await refused(s.interlock.blocking({ account: owner, sequence: 40, validatedLedgerIndex: 500 }));
        } finally {
          await s.close();
        }
      },
    },
    {
      id: 'unanchored-claim',
      file: INTERLOCK,
      search: "                    insertEvent.run('claim', claim.executionId, eventDigest('claim', identity));",
      replace: '',
      guard: async (module) => {
        const s = await store(module, [owner]);
        try {
          const r = record();
          await s.interlock.reserve(r, 500);
          await s.interlock.claimSubmission(claimOf(r)).catch(() => undefined);
          // A claim that is not in the anchored history is refused as corrupt on the next read.
          const read = await s.interlock.read(r.executionId).then((value) => value, () => undefined);
          return read?.submissionAttempts === 1;
        } finally {
          await s.close();
        }
      },
    },
  ];
  for (const mutant of mutants) it(`${mutant.expect ?? 'detected'}: ${mutant.id}`, () => qualify(mutant));
});

describe('TRADE-04C mutations — Host account isolation and the G2 submit site (structural guards)', () => {
  it('detected: disable the owner-account overlap check at boot', async () => {
    const host = join(ENTERPRISE, 'host/enterprise-host.js');
    const source = readFileSync(host, 'utf8');
    const search = '        assertXrplDomainsDisjoint(host);\n';
    assert.equal(source.split(search).length - 1, 1);
    // The guard: the boot calls the check before either composition (the TRADE-04A tripwire's ordering predicate).
    const guard = (text: string): boolean => {
      const boot = text.slice(text.indexOf('async function bootEnterpriseHost('));
      const positions = ['assertXrplDomainsDisjoint(host);', "import('../xrpl-payment-rail/host-composition.js')", "import('../xrpl-trade-execution/host-composition.js')"].map((marker) => boot.indexOf(marker));
      return positions.every((position) => position !== -1) && positions[0]! < positions[1]! && positions[1]! < positions[2]!;
    };
    assert.equal(guard(source), true);
    assert.equal(guard(source.replace(search, '')), false);
  });

  it('detected: submit without the durable claim (the claim removed from submitReserved)', () => {
    const client = join(__dirname, '..', '..', 'features/payment-runtime/rails/xrpl/xrpl-sdk-client.js');
    const source = readFileSync(client, 'utf8');
    const search = 'await claim(submission);';
    assert.equal(source.split(search).length - 1, 1);
    const guard = (text: string): boolean => {
      const reserved = text.slice(text.indexOf('async submitReserved('));
      const claim = reserved.indexOf('await claim(submission);');
      const send = reserved.indexOf('return await requestSubmit(signedTransaction);');
      return claim !== -1 && send !== -1 && claim < send;
    };
    assert.equal(guard(source), true);
    assert.equal(guard(source.replace(search, '')), false);
  });
});
