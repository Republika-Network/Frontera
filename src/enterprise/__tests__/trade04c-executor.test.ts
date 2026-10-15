import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { ExecutionAdapterResult, ValidatedExecutionAction } from '../../features/execution-runtime/index.js';
import { TRADE_PARAMETER_DIMENSION_IDS as P } from '../../features/trade-runtime/index.js';
import { XRPL_ACCOUNT_FLAG_DISABLE_MASTER } from '../../features/trade-runtime/rails/xrpl/index.js';
import { TRADE_EXECUTION_DETAILS as D, TradeExecutorConfigurationError, createTradeOfferExecutionAdapter, createTradeResolutionAuthority, readOnlyTradeLedger, tradeExecutionEvidenceOf } from '../xrpl-trade-execution/index.js';
import type { DelegatedOfferSigningPort } from '../xrpl-trade-rail/index.js';
import { closeAllWitnesses, startWitness, type StartedWitness } from './core07-freshness-fixture.js';
import { ACTION, NETWORK_ID, SIGNER_TOKEN, FakeXrplLedger, executorConfiguration, executorRig, rawProposal, validatedAction, type ExecutorRig } from './trade04c-execution-fixture.js';
import { S1_TRUST_DOMAIN, testCapabilityIssuer } from './trade04c-s1-capability-fixture.js';
import { decodeBlob, testDelegate } from './trade04b-xrpl-fixture.js';

/**
 * TRADE-04C — the governed delegated OfferCreate executor, unit level: the
 * real executor, the real CORE-07-anchored SQLite trade interlock, the real
 * TRADE-04B signer client over HTTP to a loopback reference signer, and the
 * labelled fake ledger (`FakeXrplLedger`) — no XRPL network.
 *
 * Every refusal below asserts the two counts that matter: signatures produced
 * by the signer and sends past the submit site's claim. A refused order is
 * never signed (or, after signing, never sent).
 */

let witness: StartedWitness;
before(async () => {
  witness = await startWitness();
});
after(async () => {
  await closeAllWitnesses();
});

const detail = (result: ExecutionAdapterResult): string | undefined => ('detail' in result ? result.detail : undefined);

/** Runs `body` against a fresh rig and closes it. */
async function withRig(options: Parameters<typeof executorRig>[0], body: (rig: ExecutorRig) => Promise<void>): Promise<void> {
  const rig = await executorRig({ ...options });
  try {
    await body(rig);
  } finally {
    await rig.close();
  }
}

/** A granted order for pair 0, attested, and its validated action. */
function order(rig: ExecutorRig, overrides: Record<string, unknown> = {}, attest: { readonly simulatedSources?: boolean } = {}): { readonly raw: Record<string, unknown>; readonly action: ValidatedExecutionAction } {
  const raw = rawProposal(rig.pairs[0]!, overrides);
  rig.book.attest(raw, attest);
  return { raw, action: validatedAction(raw) };
}

function assertRefusedUnsigned(rig: ExecutorRig, result: ExecutionAdapterResult, expected: string): void {
  assert.equal(result.outcome, 'failed', JSON.stringify(result));
  assert.equal(detail(result), expected, JSON.stringify(result));
  assert.equal(rig.signer.signatures(), 0, 'nothing signed');
  assert.equal(rig.ledger.submitCalls.length, 0, 'nothing sent');
}

const withParameter = (action: ValidatedExecutionAction, dimension: string, value: string): ValidatedExecutionAction =>
  ({ ...action, parameters: action.parameters!.map((parameter) => (parameter.dimension === dimension ? { ...parameter, value } : parameter)) }) as ValidatedExecutionAction;

/** A test-composed adapter over the rig, past its own restart quarantine. */
async function adapterOver(rig: ExecutorRig, overrides: Partial<Parameters<typeof createTradeOfferExecutionAdapter>[0]>): Promise<ReturnType<typeof createTradeOfferExecutionAdapter>> {
  const adapter = createTradeOfferExecutionAdapter({ configuration: executorConfiguration(rig.pairs), attested: rig.book, signer: rig.signerClient, authorization: { trustDomain: S1_TRUST_DOMAIN, issuer: rig.issuer }, ledger: rig.ledger.client(NETWORK_ID, rig.interlock), interlock: rig.interlock, ledgerProvenance: 'injected-ledger-client', simulation: 'simulated-facts-offline-qualification-only', ...overrides });
  await adapter.readiness();
  rig.ledger.passQuarantine();
  return adapter;
}

describe('TRADE-04C A — the granted, attested order executes exactly once', () => {
  it('A1 valid: signed SIGNED_NOT_SUBMITTED, reserved, submitted once, validated tesSUCCESS → completed with the hash', async () => {
    await withRig({}, async (rig) => {
      const { action } = order(rig);
      const result = await rig.adapter.execute(action);
      assert.equal(result.outcome, 'completed', JSON.stringify(rig.traces.at(-1)));
      assert.equal(rig.signer.signatures(), 1);
      assert.equal(rig.ledger.submitCalls.length, 1);
      const tx = rig.ledger.submitted[0]!;
      assert.equal((result as { providerRef?: string }).providerRef, tx.hash);
      const record = await rig.interlock.read(action.correlation.executionId);
      assert.equal(record?.state, 'settled');
      assert.equal(record?.settlement, 'validated-success');
      assert.equal(record?.submissionAttempts, 1);
      assert.deepEqual(record?.transitions.map((transition) => transition.to), ['reserved', 'submitting', 'settled']);
    });
  });

  it('A2 the submitted blob is exactly the attested proposal: owner, delegate, amounts, issuer, currency, flags; owner Sequence; configured Fee; LLS = V + offset; no other field', async () => {
    await withRig({}, async (rig) => {
      const pair = rig.pairs[0]!;
      const { action } = order(rig, { flags: ['passive', 'sell'] });
      const sequenceBefore = rig.ledger.accounts.get(pair.owner)!.sequence;
      const validatedBefore = rig.ledger.validatedIndex;
      await rig.adapter.execute(action);
      const fields = decodeBlob(rig.ledger.submitted[0]!.blob);
      assert.deepEqual(Object.keys(fields).sort(), ['Account', 'Delegate', 'Fee', 'Flags', 'LastLedgerSequence', 'Sequence', 'SigningPubKey', 'TakerGets', 'TakerPays', 'TransactionType', 'TxnSignature']);
      assert.equal(fields['TransactionType'], 'OfferCreate');
      assert.equal(fields['Account'], pair.owner);
      assert.equal(fields['Delegate'], pair.delegate.address);
      assert.equal(fields['SigningPubKey'], pair.delegate.publicKey);
      assert.deepEqual(fields['TakerGets'], { currency: '524C555344000000000000000000000000000000', issuer: 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B', value: '100' });
      assert.equal(fields['TakerPays'], '200000000');
      assert.equal(fields['Flags'], 0x0001_0000 | 0x0008_0000);
      assert.equal(fields['Sequence'], sequenceBefore, 'the OWNER Sequence — never the delegate’s');
      assert.notEqual(fields['Sequence'], rig.ledger.accounts.get(pair.delegate.address)!.sequence);
      assert.equal(fields['Fee'], '12');
      assert.equal(fields['LastLedgerSequence'], validatedBefore + 20);
    });
  });

  it('A3 an Expiration in the proposal is carried exactly; one already past the reference ledger’s close time is refused unsigned', async () => {
    await withRig({}, async (rig) => {
      const future = rig.ledger.closeTimeOf(rig.ledger.validatedIndex) + 3_600;
      const { action } = order(rig, { expiration: future });
      assert.equal((await rig.adapter.execute(action)).outcome, 'completed');
      assert.equal(decodeBlob(rig.ledger.submitted[0]!.blob)['Expiration'], future);
    });
    await withRig({}, async (rig) => {
      const { action } = order(rig, { expiration: rig.ledger.closeTimeOf(rig.ledger.validatedIndex) - 1 });
      assertRefusedUnsigned(rig, await rig.adapter.execute(action), D.OFFER_EXPIRED);
    });
  });

  it('A4 the evidence record links authority to ledger outcome, is labelled injected-ledger-client, and carries no secret', async () => {
    await withRig({}, async (rig) => {
      const { action } = order(rig);
      await rig.adapter.execute(action);
      const record = await rig.interlock.read(action.correlation.executionId);
      const evidence = tradeExecutionEvidenceOf(record!, NETWORK_ID);
      assert.equal(evidence.status, 'validated-applied');
      assert.equal(evidence.ledgerProvenance, 'injected-ledger-client');
      assert.equal(evidence.authority.boundedGrantId, action.boundedGrantId);
      assert.equal(evidence.authority.decisionId, action.correlation.decisionId);
      assert.equal(evidence.authority.proposalDigest, action.parameters!.find((parameter) => parameter.dimension === P.proposalDigest)!.value);
      assert.equal(evidence.signature.transactionHash, rig.ledger.submitted[0]!.hash);
      assert.equal(evidence.reservation.submissionAttempts, 1);
      assert.match(evidence.digest, /^sha256:[0-9a-f]{64}$/);
      const text = JSON.stringify(evidence);
      for (const secret of [SIGNER_TOKEN, rig.pairs[0]!.delegate.seed, rig.ledger.submitted[0]!.blob]) assert.equal(text.includes(secret), false);
    });
  });
});

describe('TRADE-04C A — anything not bound exactly to the grant never reaches the signer', () => {
  it('no attestation for the granted digest', async () => {
    await withRig({}, async (rig) => {
      const raw = rawProposal(rig.pairs[0]!);
      assertRefusedUnsigned(rig, await rig.adapter.execute(validatedAction(raw)), D.PROPOSAL_UNAVAILABLE);
    });
  });

  it('wrong subject, organization, resource, action or amount', async () => {
    await withRig({}, async (rig) => {
      const { action } = order(rig);
      for (const mutated of [
        { ...action, subject: 'actor-someone-else' },
        { ...action, organization: 'org-rival' },
        { ...action, resource: `xrp-ledger-testnet:${rig.pairs[0]!.delegate.address}` },
        { ...action, action: 'trade.offer-cancel' },
        { ...action, amount: { ...action.amount!, value: '100.000001' } },
        { ...action, amount: { ...action.amount!, unit: 'xrp-ledger-testnet:XRP' } },
      ]) {
        assertRefusedUnsigned(rig, await rig.adapter.execute(mutated), D.NOT_BOUND);
      }
      // Exact decimal equality, not text: the same quantity spelled with a trailing zero still binds.
      assert.equal((await rig.adapter.execute({ ...action, amount: { ...action.amount!, value: `${action.amount!.value}.0` } })).outcome, 'completed');
    });
  });

  it('every granted parameter substituted independently: digest, network, delegate, base, quote, side, quantity', async () => {
    await withRig({}, async (rig) => {
      const { action } = order(rig);
      const other = order(rig, { takerPays: { currency: 'XRP', drops: '300000000' } }).action;
      const otherDigest = other.parameters!.find((parameter) => parameter.dimension === P.proposalDigest)!.value as string;
      const substitutions: Record<string, string> = {
        [P.network]: 'xrp-ledger-devnet',
        [P.delegateAccount]: testDelegate().address,
        [P.baseAsset]: 'XRP',
        [P.quoteAsset]: 'USD/rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B',
        [P.side]: 'buy',
        [P.quantity]: '101',
      };
      for (const [dimension, value] of Object.entries(substitutions)) {
        const result = await rig.adapter.execute(withParameter(action, dimension, value));
        assert.equal(result.outcome, 'failed', dimension);
        assert.ok(detail(result) === D.NOT_BOUND || detail(result) === D.PROPOSAL_UNAVAILABLE, `${dimension}: ${detail(result)}`);
      }
      assert.equal(rig.signer.signatures(), 0);
      assert.equal(rig.ledger.submitCalls.length, 0);
      // The digest IS the grant's order: an action naming another attested digest is a grant for that order, and exactly that
      // order — its own price — is what gets built. A price changed after the grant has another digest, so another grant.
      assert.equal((await rig.adapter.execute(withParameter(action, P.proposalDigest, otherDigest))).outcome, 'completed');
      assert.equal(decodeBlob(rig.ledger.submitted[0]!.blob)['TakerPays'], '300000000');
    });
  });

  it('a missing, extra, duplicated or non-token parameter', async () => {
    await withRig({}, async (rig) => {
      const { action } = order(rig);
      const parameters = action.parameters!;
      for (const mutated of [
        parameters.slice(1),
        [...parameters, { dimension: 'tradeLimitPrice', type: 'token' as const, value: '2' }],
        [...parameters.slice(1), parameters[1]!],
        parameters.map((parameter, index) => (index === 0 ? { dimension: parameter.dimension, type: 'integer' as const, value: 1 } : parameter)),
      ]) {
        assertRefusedUnsigned(rig, await rig.adapter.execute({ ...action, parameters: mutated } as ValidatedExecutionAction), D.NOT_BOUND);
      }
      const { parameters: _dropped, ...withoutParameters } = action;
      assertRefusedUnsigned(rig, await rig.adapter.execute(withoutParameters as ValidatedExecutionAction), D.NOT_BOUND);
    });
  });

  it('an attested record whose proposal no longer matches its digest (price or quantity changed after the grant)', async () => {
    await withRig({}, async (rig) => {
      const { action } = order(rig);
      const digest = action.parameters!.find((parameter) => parameter.dimension === P.proposalDigest)!.value as string;
      const record = rig.book.records.get(digest)!;
      for (const change of [{ takerPays: { currency: 'XRP', drops: '1' } }, { takerGets: { ...(record.proposal.takerGets as object), value: '1000' } }, { flags: [] }, { delegateAccount: testDelegate().address }]) {
        rig.book.records.set(digest, { ...record, proposal: { ...record.proposal, ...change } as typeof record.proposal });
        assertRefusedUnsigned(rig, await rig.adapter.execute(action), D.NOT_BOUND);
      }
    });
  });

  it('an expired grant (notAfter passed) is refused before signing', async () => {
    await withRig({}, async (rig) => {
      const { action } = order(rig);
      assertRefusedUnsigned(rig, await rig.adapter.execute({ ...action, notAfter: new Date(Date.now() - 1000).toISOString() }), D.NOT_BOUND);
    });
  });

  it('facts from a simulated-source profile are never executed without the in-code acknowledgement', async () => {
    await withRig({ simulation: false }, async (rig) => {
      const { action } = order(rig, {}, { simulatedSources: true });
      assertRefusedUnsigned(rig, await rig.adapter.execute(action), D.SIMULATED_FACTS);
      const operational = order(rig, {}, { simulatedSources: false });
      assert.equal((await rig.adapter.execute(operational.action)).outcome, 'completed');
    });
  });

  it('an owner or network the executor is not configured for', async () => {
    await withRig({}, async (rig) => {
      const strangerOwner = testDelegate().address;
      const raw = rawProposal({ owner: strangerOwner, delegate: rig.pairs[0]!.delegate }, {});
      rig.book.attest(raw);
      assertRefusedUnsigned(rig, await rig.adapter.execute(validatedAction(raw)), D.PAIR_NOT_CONFIGURED);
      const devnet = rawProposal(rig.pairs[0]!, { network: 'xrp-ledger-devnet' });
      rig.book.attest(devnet);
      assertRefusedUnsigned(rig, await rig.adapter.execute(validatedAction(devnet)), D.PAIR_NOT_CONFIGURED);
    });
  });
});

describe('TRADE-04C B — XLS-75 delegation and delegate-key authority, re-read from validated ledgers before signing', () => {
  const cases: readonly { readonly name: string; readonly arrange: (rig: ExecutorRig) => void; readonly expected: string }[] = [
    { name: 'no delegation', arrange: (rig) => rig.ledger.revoke(rig.pairs[0]!.owner, rig.pairs[0]!.delegate.address), expected: D.DELEGATION_NOT_AUTHORIZED },
    { name: 'permission for another transaction type only', arrange: (rig) => rig.ledger.delegate(rig.pairs[0]!.owner, rig.pairs[0]!.delegate.address, ['Payment']), expected: D.DELEGATION_NOT_AUTHORIZED },
    { name: 'permissions beyond the trading scope', arrange: (rig) => rig.ledger.delegate(rig.pairs[0]!.owner, rig.pairs[0]!.delegate.address, ['OfferCreate', 'Payment']), expected: D.DELEGATION_NOT_AUTHORIZED },
    {
      name: 'delegated to another delegate account',
      arrange: (rig) => {
        rig.ledger.revoke(rig.pairs[0]!.owner, rig.pairs[0]!.delegate.address);
        rig.ledger.delegate(rig.pairs[0]!.owner, testDelegate().address);
      },
      expected: D.DELEGATION_NOT_AUTHORIZED,
    },
    { name: 'delegate master key disabled, no regular key', arrange: (rig) => rig.ledger.fund(rig.pairs[0]!.delegate.address, 5, { flags: XRPL_ACCOUNT_FLAG_DISABLE_MASTER }), expected: D.DELEGATE_KEY_NOT_AUTHORIZED },
    { name: 'delegate master disabled, regular key is another key', arrange: (rig) => rig.ledger.fund(rig.pairs[0]!.delegate.address, 5, { flags: XRPL_ACCOUNT_FLAG_DISABLE_MASTER, regularKey: testDelegate().address }), expected: D.DELEGATE_KEY_NOT_AUTHORIZED },
    { name: 'delegate account absent', arrange: (rig) => rig.ledger.accounts.delete(rig.pairs[0]!.delegate.address), expected: D.DELEGATE_KEY_NOT_AUTHORIZED },
    { name: 'another network', arrange: (rig) => (rig.ledger.faults.networkId = 2), expected: D.LEDGER_UNVALIDATED },
    { name: 'validated ledger too old', arrange: (rig) => (rig.ledger.faults.validatedAge = 120), expected: D.LEDGER_UNVALIDATED },
    { name: 'ledger unreachable', arrange: (rig) => (rig.ledger.faults.serverInfoThrows = true), expected: D.LEDGER_UNVALIDATED },
    { name: 'entry answer not validated', arrange: (rig) => (rig.ledger.faults.entryNotValidated = true), expected: D.DELEGATION_UNAVAILABLE },
    { name: 'entry answer from behind the reference (stale)', arrange: (rig) => (rig.ledger.faults.entryLedgerOffset = -3), expected: D.DELEGATION_UNAVAILABLE },
    { name: 'entry answer with a conflicting hash for the reference index', arrange: (rig) => (rig.ledger.faults.entryHashConflict = true), expected: D.DELEGATION_UNAVAILABLE },
    { name: 'delegation read unreachable', arrange: (rig) => (rig.ledger.faults.delegateEntryThrows = true), expected: D.DELEGATION_UNAVAILABLE },
    { name: 'observations spread beyond the allowed ledger span', arrange: (rig) => (rig.ledger.faults.advanceOnEntry = true), expected: D.OBSERVATION_INCONSISTENT },
    { name: 'account roots unreachable', arrange: (rig) => (rig.ledger.faults.accountRootThrows = true), expected: D.DELEGATE_KEY_NOT_AUTHORIZED },
    { name: 'malformed owner Sequence', arrange: (rig) => (rig.ledger.faults.malformedSequence = true), expected: D.OWNER_SEQUENCE_UNAVAILABLE },
  ];
  for (const testCase of cases) {
    it(`${testCase.name} → refused, nothing signed or sent`, async () => {
      await withRig({}, async (rig) => {
        const { action } = order(rig);
        testCase.arrange(rig);
        assertRefusedUnsigned(rig, await rig.adapter.execute(action), testCase.expected);
      });
    });
  }

  it('delegation revoked after the governed assessment but before signing: zero signatures (Scenario D, unit level)', async () => {
    await withRig({}, async (rig) => {
      const { action } = order(rig);
      rig.ledger.revoke(rig.pairs[0]!.owner, rig.pairs[0]!.delegate.address);
      assertRefusedUnsigned(rig, await rig.adapter.execute(action), D.DELEGATION_NOT_AUTHORIZED);
    });
  });

  it('the restart quarantine holds orders until the ledger proves every earlier window closed', async () => {
    await withRig({ quarantine: true }, async (rig) => {
      const { action } = order(rig);
      assertRefusedUnsigned(rig, await rig.adapter.execute(action), D.RESTART_QUARANTINE);
      rig.ledger.passQuarantine();
      assert.equal((await rig.adapter.execute(action)).outcome, 'completed');
    });
  });
});

describe('TRADE-04C C — the signer is untrusted: only exactly the prepared offer, by the pinned key, is ever reserved', () => {
  it('a signing port answering a different transaction, another owner, another key or not signed-not-submitted is refused before reservation', async () => {
    await withRig({}, async (rig) => {
      const tamperings: readonly ((value: Record<string, unknown>) => Record<string, unknown>)[] = [
        (value) => ({ ...value, transaction: { ...(value['transaction'] as object), TakerPays: '1' } }),
        (value) => ({ ...value, transaction: { ...(value['transaction'] as object), Sequence: 999 } }),
        (value) => ({ ...value, transaction: { ...(value['transaction'] as object), Fee: '99' } }),
        (value) => ({ ...value, transaction: { ...(value['transaction'] as object), LastLedgerSequence: 1 } }),
        (value) => ({ ...value, ownerAccount: testDelegate().address }),
        (value) => ({ ...value, delegateAccount: testDelegate().address }),
        (value) => ({ ...value, signingPublicKey: testDelegate().publicKey }),
        (value) => ({ ...value, status: 'submitted' }),
      ];
      for (const tamper of tamperings) {
        const port: DelegatedOfferSigningPort = { signDelegatedOffer: async (input) => tamper((await rig.signerClient.signDelegatedOffer(input)) as unknown as Record<string, unknown>) as never };
        const adapter = await adapterOver(rig, { signer: port });
        const { action } = order(rig);
        const result = await adapter.execute(action);
        assert.equal(detail(result), D.SIGNATURE_REJECTED, JSON.stringify(result));
        assert.equal(await rig.interlock.recorded(action.correlation.executionId), undefined, 'nothing reserved');
      }
      assert.equal(rig.ledger.submitCalls.length, 0);
    });
  });

  it('a signer that is unreachable, refuses, or answers out of protocol: no retry, nothing reserved or sent', async () => {
    await withRig({}, async (rig) => {
      await rig.signer.close();
      const { action } = order(rig);
      const result = await rig.adapter.execute(action);
      assert.equal(detail(result), D.SIGNER_UNAVAILABLE);
      assert.equal(rig.ledger.submitCalls.length, 0);
      assert.equal(await rig.interlock.recorded(action.correlation.executionId), undefined);
    });
  });

  it('a LastLedgerSequence beyond the signer client’s horizon is refused by the client before anything is sent to the signer', async () => {
    await withRig({ configuration: { lastLedgerOffset: 30 } }, async (rig) => {
      // The rig pins the client horizon to the executor offset; a narrower client is composed here.
      const { signerClient } = await import('./trade04c-execution-fixture.js');
      const narrow = signerClient(rig.signer.endpoint, rig.pairs, { lastLedgerOffset: 10 });
      const adapter = await adapterOver(rig, { configuration: executorConfiguration(rig.pairs, { lastLedgerOffset: 30 }), signer: narrow });
      const { action } = order(rig);
      assertRefusedUnsigned(rig, await adapter.execute(action), D.SIGNER_REFUSED);
    });
  });

  it('configuration: fee above its ceiling, offset outside the shared historical bound, mainnet, or a duplicated owner is refused', () => {
    const pairs = [{ owner: testDelegate().address, delegate: testDelegate() }];
    const base = { attested: { attestedProposal: () => undefined }, signer: { signDelegatedOffer: async () => undefined as never }, authorization: { trustDomain: S1_TRUST_DOMAIN, issuer: testCapabilityIssuer() }, ledger: new FakeXrplLedger().client(NETWORK_ID, { claimSubmission: async () => {} }), interlock: { recorded: async () => undefined, blocking: async () => false, reserve: async () => ({ outcome: 'blocked' as const }), markUnconfirmed: async () => {}, settle: async () => {} }, ledgerProvenance: 'injected-ledger-client' as const };
    for (const overrides of [{ feeDrops: '101' }, { maximumFeeDrops: '1000001' }, { lastLedgerOffset: 201 }, { lastLedgerOffset: 1 }, { network: 'xrp-ledger-mainnet' as never }, { observationSpanLedgers: 11 }]) {
      assert.throws(() => createTradeOfferExecutionAdapter({ ...base, configuration: executorConfiguration(pairs, overrides) }), TradeExecutorConfigurationError, JSON.stringify(overrides));
    }
    const doubled = executorConfiguration([...pairs, ...pairs]);
    assert.throws(() => createTradeOfferExecutionAdapter({ ...base, configuration: doubled }), TradeExecutorConfigurationError);
    assert.equal(ACTION, executorConfiguration(pairs).action);
  });
});

describe('TRADE-04C D/E — durable reservation, one submission, uncertainty preserved', () => {
  it('a duplicate execution — same execution id, again or after a restart — is never signed or sent twice', async () => {
    const { scratch } = await import('./trade04c-execution-fixture.js');
    const space = scratch();
    const ledger = new FakeXrplLedger();
    try {
      const first = await executorRig({ witness, dir: space.dir, ledger });
      const { action } = order(first);
      assert.equal((await first.adapter.execute(action)).outcome, 'completed');
      const again = await first.adapter.execute(action);
      assert.equal(again.outcome, 'unconfirmed');
      assert.equal(detail(again), D.PREVIOUSLY_RECORDED);
      assert.equal(first.signer.signatures(), 1);
      assert.equal(ledger.submitCalls.length, 1);
      const record = first.book.records;
      await first.interlock.close();
      await first.signer.close();
      // A restarted executor over the same file, the same witness and the same ledger.
      const second = await executorRig({ witness, dir: space.dir, ledger, pairs: first.pairs });
      for (const [digest, value] of record) second.book.records.set(digest, value);
      const restarted = await second.adapter.execute(action);
      assert.equal(detail(restarted), D.PREVIOUSLY_RECORDED);
      assert.equal(second.signer.signatures(), 0);
      assert.equal(ledger.submitCalls.length, 1);
      await second.close();
    } finally {
      space.cleanup();
    }
  });

  it('two orders on one owner in one process run one at a time and take consecutive owner Sequences', async () => {
    await withRig({}, async (rig) => {
      const a = order(rig);
      const b = order(rig);
      const [left, right] = await Promise.all([rig.adapter.execute(a.action), rig.adapter.execute(b.action)]);
      assert.equal(left.outcome, 'completed');
      assert.equal(right.outcome, 'completed');
      const sequences = rig.ledger.submitted.map((tx) => tx.sequence);
      assert.equal(new Set(sequences).size, 2);
      assert.equal(Math.abs(sequences[0]! - sequences[1]!), 1);
    });
  });

  it('an open window (dropped transaction) blocks the next order on that owner until the ledger validates its LastLedgerSequence', async () => {
    await withRig({ configuration: { finalityTimeoutMs: 100 } }, async (rig) => {
      rig.ledger.behavior = { kind: 'drop' };
      rig.ledger.autoAdvance = false;
      const first = order(rig);
      const pending = await rig.adapter.execute(first.action);
      assert.equal(pending.outcome, 'unconfirmed');
      assert.equal(detail(pending), D.FINALITY_UNKNOWN, 'a provisional success is never completion');
      const blocked = await rig.adapter.execute(order(rig).action);
      assert.equal(detail(blocked), D.SEQUENCE_IN_FLIGHT);
      assert.equal(rig.signer.signatures(), 1, 'the blocked order was never signed');
      rig.ledger.advance(25); // past LastLedgerSequence
      rig.ledger.behavior = { kind: 'accept' };
      rig.ledger.autoAdvance = true;
      assert.equal((await rig.adapter.execute(order(rig).action)).outcome, 'completed');
    });
  });

  it('a transport failure after the request may have been written is unconfirmed — never retried, never failed; P12 resolves it from the ledger', async () => {
    await withRig({ configuration: { finalityTimeoutMs: 0 } }, async (rig) => {
      rig.ledger.behavior = { kind: 'throw-after-send', includeWith: 'tesSUCCESS' };
      const { action } = order(rig);
      const result = await rig.adapter.execute(action);
      assert.equal(result.outcome, 'unconfirmed');
      assert.equal(detail(result), D.SUBMISSION_OUTCOME_UNKNOWN);
      assert.equal(rig.ledger.submitCalls.length, 1, 'exactly one send, no retry');
      assert.equal((await rig.interlock.read(action.correlation.executionId))?.state, 'unconfirmed');
      rig.ledger.advance(1);
      const authority = createTradeResolutionAuthority({ networkId: NETWORK_ID, action: ACTION, requestTimeoutMs: 1_000, ledger: readOnlyTradeLedger(rig.ledger.client(NETWORK_ID, rig.interlock)), interlock: rig.interlock });
      const query = { organizationId: 'org-acme', executionId: action.correlation.executionId, evaluationId: 'eval-1', requestId: action.correlation.requestId, decisionId: action.correlation.decisionId, boundedGrantId: action.boundedGrantId, action: ACTION, providerRef: rig.ledger.submitted[0]!.hash, basis: 'initial-observation-unconfirmed' as const };
      assert.deepEqual(await authority.resolve(query), { outcome: 'resolved', certainty: 'confirmed-completed', providerRef: rig.ledger.submitted[0]!.hash });
      assert.equal((await rig.interlock.read(action.correlation.executionId))?.settlement, 'validated-success');
      assert.equal(rig.ledger.submitCalls.length, 1, 'P12 never resubmits');
      // A query for another grant, decision or hash is never answered from this record.
      for (const wrong of [{ boundedGrantId: 'grant-other' }, { decisionId: 'dec-other' }, { providerRef: 'F'.repeat(64) }, { action: 'payment.execute' }]) assert.deepEqual(await authority.resolve({ ...query, ...wrong }), { outcome: 'unresolved' });
    });
  });

  it('a window expired without proof stays uncertain; proven non-inclusion after LastLedgerSequence resolves not-completed and releases the window', async () => {
    await withRig({ configuration: { finalityTimeoutMs: 0 } }, async (rig) => {
      rig.ledger.behavior = { kind: 'drop' };
      rig.ledger.autoAdvance = false;
      const { action } = order(rig);
      assert.equal((await rig.adapter.execute(action)).outcome, 'unconfirmed');
      const tx = rig.ledger.submitted[0]!;
      const authority = createTradeResolutionAuthority({ networkId: NETWORK_ID, action: ACTION, requestTimeoutMs: 1_000, ledger: readOnlyTradeLedger(rig.ledger.client(NETWORK_ID, rig.interlock)), interlock: rig.interlock });
      const query = { organizationId: 'org-acme', executionId: action.correlation.executionId, evaluationId: 'eval-1', requestId: action.correlation.requestId, decisionId: action.correlation.decisionId, boundedGrantId: action.boundedGrantId, action: ACTION, providerRef: tx.hash, basis: 'initial-observation-unconfirmed' as const };
      assert.deepEqual(await authority.resolve(query), { outcome: 'unresolved' }, 'window still open: absence proves nothing');
      rig.ledger.faults.lookupThrows = true;
      rig.ledger.advance(30);
      assert.deepEqual(await authority.resolve(query), { outcome: 'unresolved' }, 'an unavailable lookup is not evidence');
      rig.ledger.faults.lookupThrows = false;
      const resolved = await authority.resolve(query);
      assert.equal((resolved as { certainty?: string }).certainty, 'confirmed-not-completed');
      assert.equal((await rig.interlock.read(action.correlation.executionId))?.settlement, 'expired');
      assert.equal(await rig.interlock.blocking({ account: tx.account, sequence: tx.sequence, validatedLedgerIndex: rig.ledger.validatedIndex }), false);
    });
  });

  it('validated tec… is a definitive provider rejection (fee consumed), tem… is malformed, an unreadable answer is unconfirmed', async () => {
    await withRig({}, async (rig) => {
      rig.ledger.behavior = { kind: 'accept', finalResult: 'tecUNFUNDED_OFFER' };
      const tec = order(rig);
      const tecResult = await rig.adapter.execute(tec.action);
      assert.equal(tecResult.outcome, 'failed');
      assert.equal(detail(tecResult), 'tecUNFUNDED_OFFER');
      assert.equal((await rig.interlock.read(tec.action.correlation.executionId))?.settlement, 'validated-failure');
      rig.ledger.behavior = { kind: 'malformed', engineResult: 'temBAD_OFFER' };
      const tem = order(rig);
      assert.equal(detail(await rig.adapter.execute(tem.action)), 'temBAD_OFFER');
      assert.equal((await rig.interlock.read(tem.action.correlation.executionId))?.settlement, 'malformed');
      rig.ledger.behavior = { kind: 'unreadable' };
      const unreadable = order(rig);
      const unreadableResult = await rig.adapter.execute(unreadable.action);
      assert.equal(unreadableResult.outcome, 'unconfirmed');
      assert.equal(detail(unreadableResult), D.SUBMISSION_RESPONSE_UNREADABLE);
      assert.equal(rig.ledger.submitCalls.length, 3);
    });
  });

  it('signed but not sent (no connection at the submit site): unconfirmed signed-not-submitted, the reservation stays open and blocks', async () => {
    await withRig({}, async (rig) => {
      const client = rig.ledger.client(NETWORK_ID, rig.interlock);
      // Connected for every read, disconnected for the write.
      const ledger = { ...client, connect: async () => {}, submitReserved: async (executionId: string, blob: string) => {
        rig.ledger.connected = false;
        return client.submitReserved(executionId, blob);
      } };
      rig.ledger.connected = true;
      const adapter = await adapterOver(rig, { ledger });
      const { action } = order(rig);
      const result = await adapter.execute(action);
      assert.equal(result.outcome, 'unconfirmed');
      assert.equal(detail(result), D.SIGNED_NOT_SUBMITTED);
      assert.equal(rig.ledger.submitCalls.length, 0);
      const record = await rig.interlock.read(action.correlation.executionId);
      assert.equal(record?.state, 'reserved');
      assert.equal(record?.submissionAttempts, 0);
      assert.equal(await rig.interlock.blocking({ account: record!.account, sequence: record!.sequence, validatedLedgerIndex: rig.ledger.validatedIndex }), true);
    });
  });

  it('the interlock or its witness unavailable: refused before signing', async () => {
    await withRig({}, async (rig) => {
      const { action } = order(rig);
      await rig.interlock.close();
      assertRefusedUnsigned(rig, await rig.adapter.execute(action), D.INTERLOCK_UNAVAILABLE);
    });
    const own = await startWitness();
    const rig = await executorRig({ witness: own });
    try {
      const { action } = order(rig);
      await own.close();
      assertRefusedUnsigned(rig, await rig.adapter.execute(action), D.INTERLOCK_UNAVAILABLE);
    } finally {
      await rig.close();
    }
  });

  it('a reservation failure after signing (crash after sign, before reserve): the signature is discarded, nothing sent', async () => {
    await withRig({}, async (rig) => {
      const interlock = { ...rig.interlock, recorded: rig.interlock.recorded, blocking: rig.interlock.blocking, markUnconfirmed: rig.interlock.markUnconfirmed, settle: rig.interlock.settle, reserve: async () => { throw new Error('disk full'); } };
      const adapter = await adapterOver(rig, { interlock });
      const { action } = order(rig);
      const result = await adapter.execute(action);
      assert.equal(detail(result), D.RESERVATION_FAILED);
      assert.equal(rig.signer.signatures(), 1);
      assert.equal(rig.ledger.submitCalls.length, 0);
    });
  });
});
