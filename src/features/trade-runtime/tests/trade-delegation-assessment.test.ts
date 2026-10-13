import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  TRADE_DELEGATION_ASSESSMENT_SCHEMA,
  TRADE_DELEGATION_OBSERVATION_SCHEMA,
  TRADE_DELEGATION_RELIANCE_REFUSALS as RR,
  TRADE_DELEGATION_REQUEST_SCHEMA,
  TRADE_DELEGATION_REQUEST_VIOLATIONS as RQ,
  TRADE_PROPOSAL_SCHEMA,
  assessTradeDelegation,
  checkTradeDelegationReliance,
  compileTradeProposal,
  createTradeGovernanceBinding,
  parseTradeDelegationPolicy,
  parseTradeDelegationRequest,
  tradeDelegateEntryIndex,
  tradeDelegationRequestFor,
  validateTradeProposal,
} from '../index.js';
import type { AcceptedTradeProposal, TradeDelegationAssessment, TradeDelegationAssessmentInput, TradeDelegationPolicy } from '../index.js';

/**
 * TRADE-02 — the delegation assessment contract: closed request, trusted
 * policy, three-way result, digested evidence, and reliance by a later
 * consumer. Test names carry the TRADE-02 matrix ids (A–F) they cover.
 */

const OWNER = 'rf1BiGeXwwQoi8Z2ueFYTEXSwuJYfV2Jpn';
const DELEGATE = 'ra5nK24KXen9AHvsdFTKHSANinZseWnPcX';
const OTHER = 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B';
const LEDGER_HASH = 'C'.repeat(64);
const TXN_A = 'A'.repeat(64);
const TXN_B = 'B'.repeat(64);
const OBSERVED = '2026-10-13T12:00:05.000Z';
const AT = '2026-10-13T12:00:08.000Z';
const POLICY: TradeDelegationPolicy = parseTradeDelegationPolicy({ sourceId: 'xrpl-testnet-reader', maxAgeSeconds: 10 }) as TradeDelegationPolicy;

const ACCEPTED: AcceptedTradeProposal = (() => {
  const result = validateTradeProposal({
    schema: TRADE_PROPOSAL_SCHEMA,
    organizationId: 'org-acme',
    principalId: 'agent-mm-01',
    requestId: 'req-0001',
    idempotencyKey: 'offer-0001',
    network: 'xrp-ledger-testnet',
    ownerAccount: OWNER,
    delegateAccount: DELEGATE,
    permission: 'OfferCreate',
    takerGets: { currency: 'USD', issuer: OTHER, value: '50' },
    takerPays: { currency: 'XRP', drops: '125000000' },
    requestedValiditySeconds: 60,
  });
  assert.ok(result.valid);
  return result.accepted;
})();

const request = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema: TRADE_DELEGATION_REQUEST_SCHEMA,
  organizationId: 'org-acme',
  proposalDigest: ACCEPTED.digest,
  network: 'xrp-ledger-testnet',
  ownerAccount: OWNER,
  delegateAccount: DELEGATE,
  permission: 'OfferCreate',
  ...overrides,
});

function granted(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: TRADE_DELEGATION_OBSERVATION_SCHEMA,
    network: 'xrp-ledger-testnet',
    networkId: 1,
    validatedLedgerIndex: 100,
    validatedLedgerHash: LEDGER_HASH,
    owner: OWNER,
    delegate: DELEGATE,
    entryIndex: tradeDelegateEntryIndex(OWNER, DELEGATE),
    observedAt: OBSERVED,
    state: 'granted',
    permissions: ['OfferCreate'],
    previousTxnId: TXN_A,
    previousTxnLedgerIndex: 90,
    ...overrides,
  };
}

function absent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const { permissions: _p, previousTxnId: _t, previousTxnLedgerIndex: _l, ...base } = granted({ state: 'absent' });
  return { ...base, ...overrides };
}

const observed = (observation: Record<string, unknown>) => ({ outcome: 'observed' as const, observation }) as unknown as TradeDelegationAssessmentInput['read'];

function assess(input: Partial<TradeDelegationAssessmentInput> = {}): TradeDelegationAssessment {
  return assessTradeDelegation({ request: request(), policy: POLICY, read: observed(granted()), assessedAt: AT, ...input });
}

const verdict = (assessment: TradeDelegationAssessment): string => `${assessment.status}/${assessment.reason}`;

const relyOn = (assessment: unknown, overrides: Partial<Parameters<typeof checkTradeDelegationReliance>[1]> = {}) => {
  const result = checkTradeDelegationReliance(assessment, { proposal: ACCEPTED.proposal, proposalDigest: ACCEPTED.digest, at: AT, policy: POLICY, ...overrides });
  return result.reliable ? 'RELIABLE' : result.code;
};

describe('TRADE-02 assessment — positive verification (A)', () => {
  it('A01/A02/A05/A06 correct owner, delegate, network and a validated observation granting OfferCreate → AUTHORIZED with the ledger facts', () => {
    const assessment = assess();
    assert.equal(verdict(assessment), 'AUTHORIZED/DELEGATION_VERIFIED');
    assert.equal(assessment.schema, TRADE_DELEGATION_ASSESSMENT_SCHEMA);
    assert.deepEqual(assessment.facts, {
      network: 'xrp-ledger-testnet',
      networkId: 1,
      owner: OWNER,
      delegate: DELEGATE,
      entryIndex: tradeDelegateEntryIndex(OWNER, DELEGATE),
      validatedLedgerIndex: 100,
      validatedLedgerHash: LEDGER_HASH,
      state: 'granted',
      permissions: ['OfferCreate'],
      previousTxnId: TXN_A,
      previousTxnLedgerIndex: 90,
    });
    assert.deepEqual(assessment.permissionReading, { offerCreateGranted: true, withinTradingScope: true });
    assert.deepEqual(assessment.timing, { observedAt: OBSERVED, assessedAt: AT, maxAgeSeconds: 10 });
    assert.deepEqual(assessment.source, { sourceId: 'xrpl-testnet-reader' });
    assert.equal(assessment.request?.proposalDigest, ACCEPTED.digest);
    assert.equal(Object.isFrozen(assessment), true);
    assert.equal(assessment.diagnostic, undefined);
  });

  it('A07/A08 normalization and digests are deterministic; the facts digest ignores observation time, the record digest does not', () => {
    const first = assess();
    const again = assess();
    assert.equal(first.digest, again.digest);
    assert.match(first.digest, /^sha256:[0-9a-f]{64}$/);
    const later = assess({ read: observed(granted({ observedAt: '2026-10-13T12:00:06.000Z' })), assessedAt: '2026-10-13T12:00:09.000Z' });
    assert.equal(later.status, 'AUTHORIZED');
    assert.equal(later.factsDigest, first.factsDigest, 'same ledger state, same facts digest');
    assert.notEqual(later.digest, first.digest, 'a different observation is a different record');
    const otherLedger = assess({ read: observed(granted({ validatedLedgerIndex: 101 })) });
    assert.notEqual(otherLedger.factsDigest, first.factsDigest);
  });

  it('A09 additional permissions are reported exactly; the protocol fact and the trading-scope policy are read separately', () => {
    const cancel = assess({ read: observed(granted({ permissions: ['OfferCancel', 'OfferCreate'] })) });
    assert.equal(verdict(cancel), 'AUTHORIZED/DELEGATION_VERIFIED');
    assert.deepEqual(cancel.facts?.permissions, ['OfferCancel', 'OfferCreate']);
    const payment = assess({ read: observed(granted({ permissions: ['OfferCreate', 'Payment'] })) });
    assert.equal(verdict(payment), 'NOT_AUTHORIZED/DELEGATION_PERMISSION_EXCESS');
    assert.deepEqual(payment.facts?.permissions, ['OfferCreate', 'Payment']);
    assert.deepEqual(payment.permissionReading, { offerCreateGranted: true, withinTradingScope: false }, 'OfferCreate is present as a protocol fact; the policy is what refuses');
  });

  it('A10 the request can be built from an accepted proposal, and a pinned PreviousTxnID that still matches is accepted', () => {
    const built = tradeDelegationRequestFor(ACCEPTED.proposal, ACCEPTED.digest);
    assert.ok(built.valid);
    assert.deepEqual(built.request, request());
    assert.equal(assess({ request: built.request, pins: { expectedPreviousTxnId: TXN_A, minimumValidatedLedgerIndex: 100 } }).status, 'AUTHORIZED');
  });
});

describe('TRADE-02 assessment — refusals (B): proof of absence is NOT_AUTHORIZED, anything that cannot answer is UNAVAILABLE', () => {
  it('B01 a validated absence → NOT_AUTHORIZED, with the absent facts recorded', () => {
    const assessment = assess({ read: observed(absent()) });
    assert.equal(verdict(assessment), 'NOT_AUTHORIZED/DELEGATION_ABSENT');
    assert.equal(assessment.facts?.state, 'absent');
    assert.equal(assessment.facts?.permissions, undefined);
    assert.deepEqual(assessment.permissionReading, { offerCreateGranted: false, withinTradingScope: false });
  });

  it('B02/B03/B10 an observation of another owner or delegate — including the inverted pair — is UNAVAILABLE and records no facts', () => {
    for (const [owner, delegate] of [
      [OTHER, DELEGATE],
      [OWNER, OTHER],
      [DELEGATE, OWNER],
    ] as const) {
      const assessment = assess({ read: observed(granted({ owner, delegate, entryIndex: tradeDelegateEntryIndex(owner, delegate) })) });
      assert.equal(assessment.status, 'UNAVAILABLE', `${owner} → ${delegate}`);
      assert.equal(assessment.facts, undefined);
    }
    assert.equal(assess({ request: request({ ownerAccount: DELEGATE, delegateAccount: OWNER }) }).status, 'UNAVAILABLE', 'SEC-05: inverted request against the real entry');
  });

  it('B04/B05/B06/B07 wrong, empty, unknown or malformed permissions never become OfferCreate', () => {
    assert.equal(verdict(assess({ read: observed(granted({ permissions: ['Payment'] })) })), 'NOT_AUTHORIZED/DELEGATION_PERMISSION_MISSING');
    assert.equal(verdict(assess({ read: observed(granted({ permissions: ['OfferCancel'] })) })), 'NOT_AUTHORIZED/DELEGATION_PERMISSION_MISSING');
    assert.equal(verdict(assess({ read: observed(granted({ permissions: ['value:65599'] })) })), 'NOT_AUTHORIZED/DELEGATION_PERMISSION_MISSING');
    assert.equal(verdict(assess({ read: observed(granted({ permissions: ['offercreate'] })) })), 'NOT_AUTHORIZED/DELEGATION_PERMISSION_MISSING', 'names are case-sensitive');
    for (const permissions of [[], ['value:8'], [8], [{ PermissionValue: 'OfferCreate' }], ['OfferCreate', 'OfferCreate'], 'OfferCreate']) {
      assert.equal(verdict(assess({ read: observed(granted({ permissions })) })), 'UNAVAILABLE/DELEGATION_OBSERVATION_MALFORMED', JSON.stringify(permissions));
    }
  });

  it('B08/B09 a malformed observation or a wrong ledger object key is UNAVAILABLE', () => {
    assert.equal(verdict(assess({ read: observed(granted({ entryIndex: 'F'.repeat(64) })) })), 'UNAVAILABLE/DELEGATION_OBSERVATION_MALFORMED');
    assert.equal(verdict(assess({ read: observed(granted({ schema: 'frontera.other.v1' })) })), 'UNAVAILABLE/DELEGATION_OBSERVATION_MALFORMED');
    assert.equal(verdict(assess({ read: observed(granted({ validatedLedgerHash: 'not-a-hash' })) })), 'UNAVAILABLE/DELEGATION_OBSERVATION_MALFORMED');
  });

  it('B11/B12 SEC-06 an observation from another network is UNAVAILABLE; an unsupported network is refused in the request', () => {
    assert.equal(verdict(assess({ read: observed(granted({ network: 'xrp-ledger-devnet', networkId: 2 })) })), 'UNAVAILABLE/DELEGATION_NETWORK_MISMATCH');
    assert.equal(verdict(assess({ read: observed(granted({ networkId: 0 })) })), 'UNAVAILABLE/DELEGATION_OBSERVATION_MALFORMED');
    for (const network of ['xrp-ledger-mainnet', 'mainnet', 'testnet', 1]) {
      const assessment = assess({ request: request({ network }) });
      assert.equal(verdict(assessment), 'UNAVAILABLE/DELEGATION_REQUEST_REJECTED');
      assert.equal(assessment.requestViolation, RQ.NETWORK_UNSUPPORTED);
    }
  });

  it('a reader that could not answer is UNAVAILABLE with its code as a diagnostic outside the digest — never NOT_AUTHORIZED', () => {
    const assessment = assess({ read: { outcome: 'unavailable', failure: 'DELEGATION_READ_LEDGER_UNREACHABLE' } });
    assert.equal(verdict(assessment), 'UNAVAILABLE/DELEGATION_SOURCE_UNAVAILABLE');
    assert.deepEqual(assessment.diagnostic, { readFailure: 'DELEGATION_READ_LEDGER_UNREACHABLE' });
    const other = assess({ read: { outcome: 'unavailable', failure: 'DELEGATION_READ_NOT_VALIDATED' } });
    assert.equal(other.digest, assessment.digest, 'the diagnostic is not part of the digested record');
    assert.equal(assess({ read: { outcome: 'unavailable', failure: 'Error: ECONNREFUSED 10.0.0.1:51234' } }).diagnostic?.readFailure, 'UNRECOGNISED', 'no transport detail is carried');
    for (const read of [undefined, null, {}, { outcome: 'granted' }, { outcome: 'observed' }]) {
      assert.equal(assess({ read: read as never }).status, 'UNAVAILABLE');
    }
  });
});

describe('TRADE-02 assessment — the request is closed (SEC-03, SEC-04, SEC-18)', () => {
  it('accepts exactly the declared request and freezes it', () => {
    const parsed = parseTradeDelegationRequest(request());
    assert.ok(parsed.valid);
    assert.equal(Object.isFrozen(parsed.request), true);
  });

  it('refuses claims of a verdict or of evidence, secrets, raw transactions and source selection — each by its class', () => {
    const cases: readonly [string, string][] = [
      ['delegationVerified', RQ.TRUSTED_FACT_CLAIM_REFUSED],
      ['delegationProof', RQ.TRUSTED_FACT_CLAIM_REFUSED],
      ['permissionGranted', RQ.TRUSTED_FACT_CLAIM_REFUSED],
      ['trustedContext', RQ.TRUSTED_FACT_CLAIM_REFUSED],
      ['ledgerEvidence', RQ.TRUSTED_FACT_CLAIM_REFUSED],
      ['observation', RQ.TRUSTED_FACT_CLAIM_REFUSED],
      ['validatedLedgerIndex', RQ.TRUSTED_FACT_CLAIM_REFUSED],
      ['status', RQ.TRUSTED_FACT_CLAIM_REFUSED],
      ['grant', RQ.TRUSTED_FACT_CLAIM_REFUSED],
      ['seed', RQ.SECRET_PROPERTY_REFUSED],
      ['privateKey', RQ.SECRET_PROPERTY_REFUSED],
      ['delegateSecret', RQ.SECRET_PROPERTY_REFUSED],
      ['tx_json', RQ.RAW_TRANSACTION_REFUSED],
      ['TransactionType', RQ.RAW_TRANSACTION_REFUSED],
      ['Permissions', RQ.RAW_TRANSACTION_REFUSED],
      ['endpoint', RQ.SOURCE_SELECTION_REFUSED],
      ['rpcUrl', RQ.SOURCE_SELECTION_REFUSED],
      ['maxAgeSeconds', RQ.SOURCE_SELECTION_REFUSED],
      ['freshness', RQ.SOURCE_SELECTION_REFUSED],
      ['sourceId', RQ.SOURCE_SELECTION_REFUSED],
      ['comment', RQ.UNDECLARED_PROPERTY],
    ];
    for (const [field, violation] of cases) {
      const parsed = parseTradeDelegationRequest(request({ [field]: 'x' }));
      assert.ok(!parsed.valid, field);
      assert.equal(parsed.violation, violation, field);
    }
  });

  it('refuses malformed, reserved, identical and unsupported values, and anything that is not a plain record', () => {
    const cases: readonly [Record<string, unknown>, string][] = [
      [{ schema: 'frontera.trade-delegation-request.v2' }, RQ.SCHEMA_UNSUPPORTED],
      [{ organizationId: '' }, RQ.IDENTIFIER_MALFORMED],
      [{ proposalDigest: 'sha256:abc' }, RQ.PROPOSAL_DIGEST_MALFORMED],
      [{ ownerAccount: 'rNotAnAddress' }, RQ.ACCOUNT_MALFORMED],
      [{ delegateAccount: 'rrrrrrrrrrrrrrrrrrrrrhoLvTp' }, RQ.ACCOUNT_RESERVED],
      [{ delegateAccount: OWNER }, RQ.OWNER_IS_DELEGATE],
      [{ permission: 'Payment' }, RQ.PERMISSION_UNSUPPORTED],
      [{ permission: 8 }, RQ.PERMISSION_UNSUPPORTED],
    ];
    for (const [overrides, violation] of cases) {
      const parsed = parseTradeDelegationRequest(request(overrides));
      assert.ok(!parsed.valid, JSON.stringify(overrides));
      assert.equal(parsed.violation, violation, JSON.stringify(overrides));
    }
    const missing = request();
    delete missing['delegateAccount'];
    assert.equal((parseTradeDelegationRequest(missing) as { violation: string }).violation, RQ.MISSING_FIELD);
    let ran = false;
    const getter = Object.defineProperty(request(), 'ownerAccount', { enumerable: true, get: () => ((ran = true), OWNER) });
    for (const raw of [null, [], 'request', getter, JSON.parse('{"__proto__":{}}'), new (class Request {})()]) {
      assert.equal((parseTradeDelegationRequest(raw) as { violation: string }).violation, RQ.NOT_A_RECORD);
    }
    assert.equal(ran, false, 'a getter is never run');
  });

  it('a rejected request records no facts, even when an observation was supplied', () => {
    const assessment = assess({ request: request({ delegationVerified: true }) });
    assert.equal(verdict(assessment), 'UNAVAILABLE/DELEGATION_REQUEST_REJECTED');
    assert.equal(assessment.requestViolation, RQ.TRUSTED_FACT_CLAIM_REFUSED);
    assert.equal(assessment.request, undefined);
    assert.equal(assessment.facts, undefined);
  });
});

describe('TRADE-02 assessment — freshness and revocation (E, SEC-08, SEC-15)', () => {
  it('E01–E03 granted at N, then permission removed or entry deleted at N+1: the later read decides, and an earlier one cannot be replayed past it', () => {
    assert.equal(assess({ read: observed(granted()) }).status, 'AUTHORIZED');
    const removed = assess({ read: observed(granted({ validatedLedgerIndex: 101, permissions: ['OfferCancel'], previousTxnId: TXN_B, previousTxnLedgerIndex: 101 })), pins: { minimumValidatedLedgerIndex: 101 } });
    assert.equal(verdict(removed), 'NOT_AUTHORIZED/DELEGATION_PERMISSION_MISSING');
    const deleted = assess({ read: observed(absent({ validatedLedgerIndex: 101 })), pins: { minimumValidatedLedgerIndex: 101 } });
    assert.equal(verdict(deleted), 'NOT_AUTHORIZED/DELEGATION_ABSENT');
    assert.equal(verdict(assess({ read: observed(granted()), pins: { minimumValidatedLedgerIndex: 101 } })), 'UNAVAILABLE/DELEGATION_LEDGER_BELOW_MINIMUM', 'the old "granted" at N cannot override what N+1 showed');
    assert.equal(verdict(assess({ read: observed(granted({ validatedLedgerIndex: 101, previousTxnId: TXN_B, previousTxnLedgerIndex: 101 })), pins: { expectedPreviousTxnId: TXN_A } })), 'NOT_AUTHORIZED/DELEGATION_CHANGED', 'revoke-and-re-grant');
  });

  it('E04/E08 a stale or future-dated observation is UNAVAILABLE, at the policy bound exactly', () => {
    assert.equal(assess({ assessedAt: '2026-10-13T12:00:15.000Z' }).status, 'AUTHORIZED', 'exactly 10 s');
    assert.equal(verdict(assess({ assessedAt: '2026-10-13T12:00:15.001Z' })), 'UNAVAILABLE/DELEGATION_OBSERVATION_STALE');
    assert.equal(verdict(assess({ assessedAt: '2026-10-13T12:00:04.999Z' })), 'UNAVAILABLE/DELEGATION_OBSERVATION_FROM_FUTURE', 'a clock stepping backwards fails closed');
    assert.equal(verdict(assess({ read: observed(absent()), assessedAt: '2026-10-13T12:01:00.000Z' })), 'UNAVAILABLE/DELEGATION_OBSERVATION_STALE', 'a stale absence proves nothing either');
  });

  it('E05 an outage after a positive result yields UNAVAILABLE, and the earlier record is not carried into the new one', () => {
    const before = assess();
    const during = assess({ read: { outcome: 'unavailable', failure: 'DELEGATION_READ_LEDGER_UNREACHABLE' } });
    assert.equal(before.status, 'AUTHORIZED');
    assert.equal(during.status, 'UNAVAILABLE');
    assert.equal(during.facts, undefined);
  });

  it('E07 the freshness bound is trusted configuration: invalid policies are refused, and the request cannot carry one', () => {
    for (const raw of [{ sourceId: 'x', maxAgeSeconds: 61 }, { sourceId: 'x', maxAgeSeconds: 0 }, { sourceId: 'x', maxAgeSeconds: 1.5 }, { sourceId: 'x' }, { sourceId: 'x', maxAgeSeconds: 10, endpoint: 'https://evil' }, { sourceId: 'https://node:51234', maxAgeSeconds: 10 }]) {
      assert.equal(parseTradeDelegationPolicy(raw), undefined, JSON.stringify(raw));
    }
    assert.equal(verdict(assess({ policy: { sourceId: 'x', maxAgeSeconds: 3600 } })), 'UNAVAILABLE/DELEGATION_CONTEXT_INVALID');
    assert.equal(verdict(assess({ request: request({ maxAgeSeconds: 3600 }) })), 'UNAVAILABLE/DELEGATION_REQUEST_REJECTED');
    assert.equal(verdict(assess({ assessedAt: 'now' })), 'UNAVAILABLE/DELEGATION_CONTEXT_INVALID');
    assert.equal(verdict(assess({ pins: { minimumValidatedLedgerIndex: 1, trusted: true } as never })), 'UNAVAILABLE/DELEGATION_CONTEXT_INVALID');
  });
});

describe('TRADE-02 assessment — reliance by a later consumer (E06, F, SEC-15, SEC-17)', () => {
  it('F01 a fresh AUTHORIZED assessment for this proposal is reliable', () => {
    assert.equal(relyOn(assess()), 'RELIABLE');
    assert.equal(relyOn(JSON.parse(JSON.stringify(assess()))), 'RELIABLE', 'survives storage as plain JSON');
  });

  it('SEC-15 reliance re-checks age every time, under the policy in force now', () => {
    const assessment = assess();
    assert.equal(relyOn(assessment, { at: '2026-10-13T12:00:15.000Z' }), 'RELIABLE');
    assert.equal(relyOn(assessment, { at: '2026-10-13T12:00:15.001Z' }), RR.STALE);
    assert.equal(relyOn(assessment, { at: '2026-10-13T12:00:07.000Z', policy: { sourceId: 'xrpl-testnet-reader', maxAgeSeconds: 1 } }), RR.STALE, 'a tighter policy applies to old records');
    assert.equal(relyOn(assessment, { at: '2026-10-13T12:00:04.000Z' }), RR.FROM_FUTURE);
  });

  it('F02/F03 NOT_AUTHORIZED and UNAVAILABLE are never reliable; AUTHORIZED is not presented as approval', () => {
    assert.equal(relyOn(assess({ read: observed(absent()) })), RR.NOT_AUTHORIZED);
    assert.equal(relyOn(assess({ read: { outcome: 'unavailable', failure: 'DELEGATION_READ_LEDGER_UNREACHABLE' } })), RR.NOT_AUTHORIZED);
    const keys = Object.keys(assess());
    for (const word of ['approved', 'decision', 'grant', 'allow', 'capability']) assert.equal(keys.some((key) => key.toLowerCase().includes(word)), false, word);
  });

  it('F05/E06 SEC-17 an assessment for another organization, proposal, owner, delegate or source cannot be substituted', () => {
    const assessment = assess();
    assert.equal(relyOn(assessment, { proposal: { ...ACCEPTED.proposal, organizationId: 'org-other' } }), RR.ORGANIZATION_MISMATCH);
    assert.equal(relyOn(assessment, { proposalDigest: `sha256:${'0'.repeat(64)}` }), RR.PROPOSAL_MISMATCH);
    assert.equal(relyOn(assessment, { proposal: { ...ACCEPTED.proposal, delegateAccount: OTHER } }), RR.BINDING_MISMATCH);
    assert.equal(relyOn(assessment, { proposal: { ...ACCEPTED.proposal, ownerAccount: OTHER } }), RR.BINDING_MISMATCH);
    assert.equal(relyOn(assessment, { proposal: { ...ACCEPTED.proposal, network: 'xrp-ledger-devnet' } }), RR.BINDING_MISMATCH);
    assert.equal(relyOn(assessment, { policy: { sourceId: 'another-reader', maxAgeSeconds: 10 } }), RR.SOURCE_MISMATCH);
  });

  it('SEC-16 a tampered or fabricated record is refused: digests are recomputed, and an edited verdict does not survive', () => {
    const assessment = JSON.parse(JSON.stringify(assess({ read: observed(absent()) }))) as Record<string, unknown>;
    assert.equal(relyOn({ ...assessment, status: 'AUTHORIZED', reason: 'DELEGATION_VERIFIED' }), RR.DIGEST_MISMATCH);
    const good = JSON.parse(JSON.stringify(assess())) as Record<string, unknown>;
    assert.equal(relyOn({ ...good, facts: { ...(good['facts'] as object), validatedLedgerIndex: 999 } }), RR.DIGEST_MISMATCH);
    assert.equal(relyOn({ ...good, timing: { ...(good['timing'] as object), observedAt: AT } }), RR.DIGEST_MISMATCH, 'refreshing the timestamp breaks the digest');
    assert.equal(relyOn({ ...good, diagnostic: { readFailure: 'X' } }), 'RELIABLE', 'the diagnostic is outside the digest');
    for (const raw of [null, 'AUTHORIZED', { status: 'AUTHORIZED' }, { ...good, schema: 'x' }]) assert.equal(relyOn(raw), RR.MALFORMED);
  });

  it('F04/F06 assessing compiles nothing and issues nothing: the TRADE-01 compilation of the same proposal is unchanged', () => {
    const binding = createTradeGovernanceBinding({ action: 'trade.offer-create' });
    const identity = { organizationId: 'org-acme', principalId: 'agent-mm-01' };
    const before = compileTradeProposal(ACCEPTED.proposal, binding, identity);
    assess();
    assert.deepEqual(compileTradeProposal(ACCEPTED.proposal, binding, identity), before);
  });
});
