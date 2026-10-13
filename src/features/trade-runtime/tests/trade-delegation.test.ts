import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  TRADE_DELEGATION_EVIDENCE_SCHEMA,
  TRADE_DELEGATION_OBSERVATION_SCHEMA,
  TRADE_DELEGATION_REFUSAL_CODES as C,
  canonicalTradeDelegationPermission,
  parseTradeDelegationObservation,
  tradeDelegateEntryIndex,
  verifyTradeDelegation,
} from '../index.js';
import type { TradeDelegationRequirement } from '../index.js';

/**
 * TRADE-02 — the delegation observation contract, the `Delegate` entry key and
 * the verifier. Pure: every instant is passed in.
 */

const OWNER = 'rf1BiGeXwwQoi8Z2ueFYTEXSwuJYfV2Jpn';
const DELEGATE = 'ra5nK24KXen9AHvsdFTKHSANinZseWnPcX';
const OTHER = 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B';
const TXN_A = 'A'.repeat(64);
const TXN_B = 'B'.repeat(64);
const LEDGER_HASH = 'C'.repeat(64);
const AT = '2026-10-13T12:00:10.000Z';
const OBSERVED = '2026-10-13T12:00:05.000Z';

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

const REQUIREMENT: TradeDelegationRequirement = Object.freeze({ network: 'xrp-ledger-testnet', owner: OWNER, delegate: DELEGATE, at: AT, maxAgeSeconds: 10 });

const codeOf = (observation: unknown, requirement: Partial<TradeDelegationRequirement> = {}): string => {
  const result = verifyTradeDelegation(observation, { ...REQUIREMENT, ...requirement });
  return result.verified ? 'VERIFIED' : result.code;
};

describe('TRADE-02 — the Delegate entry key', () => {
  it('reproduces the documented xrpl.org Delegate entry index', () => {
    // xrpl.org "Delegate" ledger entry example: Account rG8uo…, Authorize r9GAK…, index 749D…29A2.
    assert.equal(tradeDelegateEntryIndex('rG8uoRH9uA6AJ6NRj8P4cJG1HNfYcnMPrt', 'r9GAKojMTyexqvy8DXFWYq63Mod5k5wnkT'), '749D3DCDF9F032DDDB8AC49641BACBFDD398C4B6C231C4AB325B7755962329A2');
  });

  it('is directional: the owner and delegate are not interchangeable', () => {
    const forward = tradeDelegateEntryIndex(OWNER, DELEGATE);
    assert.match(forward ?? '', /^[0-9A-F]{64}$/);
    assert.notEqual(forward, tradeDelegateEntryIndex(DELEGATE, OWNER));
  });

  it('is undefined for anything but two valid, non-reserved classic addresses', () => {
    for (const bad of ['', 'not-an-address', `${OWNER}x`, 'rrrrrrrrrrrrrrrrrrrrrhoLvTp', 'rrrrrrrrrrrrrrrrrrrrBZbvji', 42, undefined]) {
      assert.equal(tradeDelegateEntryIndex(bad, DELEGATE), undefined, String(bad));
      assert.equal(tradeDelegateEntryIndex(OWNER, bad), undefined, String(bad));
    }
  });
});

describe('TRADE-02 — permission values', () => {
  it('names are kept, the two trading values are named, other numbers stay visible, anything else is refused', () => {
    assert.equal(canonicalTradeDelegationPermission('OfferCreate'), 'OfferCreate');
    assert.equal(canonicalTradeDelegationPermission(8), 'OfferCreate');
    assert.equal(canonicalTradeDelegationPermission(9), 'OfferCancel');
    assert.equal(canonicalTradeDelegationPermission(1), 'value:1');
    assert.equal(canonicalTradeDelegationPermission(65_545), 'value:65545');
    for (const bad of [0, -1, 8.5, 4_294_967_296, '8', '', 'Offer Create', null, {}, ['OfferCreate']]) assert.equal(canonicalTradeDelegationPermission(bad), undefined, JSON.stringify(bad));
  });
});

describe('TRADE-02 — the observation is a closed record, re-validated wherever it is used', () => {
  it('accepts a well-formed granted and absent observation, and freezes the copy', () => {
    const parsed = parseTradeDelegationObservation(granted());
    assert.ok(parsed !== undefined && parsed.state === 'granted');
    assert.equal(Object.isFrozen(parsed), true);
    assert.equal(Object.isFrozen(parsed.permissions), true);
    assert.equal(parseTradeDelegationObservation(absent())?.state, 'absent');
  });

  it('refuses every malformed variation', () => {
    const cases: Record<string, unknown> = {
      'extra field': granted({ verified: true }),
      'absent with permissions': { ...absent(), permissions: ['OfferCreate'] },
      'missing field': (() => { const { previousTxnId: _x, ...rest } = granted(); return rest; })(),
      'unknown state': granted({ state: 'pending' }),
      'wrong schema': granted({ schema: 'frontera.trade-delegation-observation.v2' }),
      mainnet: granted({ network: 'xrp-ledger-mainnet', networkId: 0 }),
      'network id of another network': granted({ networkId: 2 }),
      'entry index of another pair': granted({ entryIndex: tradeDelegateEntryIndex(OWNER, OTHER) }),
      'self-delegation': granted({ delegate: OWNER, entryIndex: tradeDelegateEntryIndex(OWNER, OWNER) }),
      'reserved owner': granted({ owner: 'rrrrrrrrrrrrrrrrrrrrrhoLvTp' }),
      'ledger index zero': granted({ validatedLedgerIndex: 0 }),
      'ledger index as text': granted({ validatedLedgerIndex: '100' }),
      'lower-case ledger hash': granted({ validatedLedgerHash: 'c'.repeat(64) }),
      'instant not in ISO form': granted({ observedAt: '2026-10-13T12:00:05Z' }),
      'impossible instant': granted({ observedAt: '2026-13-40T12:00:05.000Z' }),
      'no permissions': granted({ permissions: [] }),
      'eleven permissions': granted({ permissions: Array.from({ length: 11 }, (_, index) => `value:${String(100 + index)}`) }),
      'unsorted permissions': granted({ permissions: ['OfferCreate', 'OfferCancel'] }),
      'duplicate permissions': granted({ permissions: ['OfferCreate', 'OfferCreate'] }),
      'non-canonical numeric spelling of OfferCreate': granted({ permissions: ['value:8'] }),
      'numeric permission': granted({ permissions: [8] }),
      'previous transaction after the ledger': granted({ previousTxnLedgerIndex: 101 }),
      'class instance': Object.assign(Object.create({ inherited: true }) as object, granted()),
      array: [granted()],
      null: null,
    };
    for (const [name, value] of Object.entries(cases)) assert.equal(parseTradeDelegationObservation(value), undefined, name);
  });

  it('never runs a getter on the observation', () => {
    let touched = false;
    const hostile = granted();
    Object.defineProperty(hostile, 'state', { enumerable: true, get: () => { touched = true; return 'granted'; } });
    assert.equal(parseTradeDelegationObservation(hostile), undefined);
    const hostilePermissions = granted();
    Object.defineProperty(hostilePermissions, 'permissions', { enumerable: true, get: () => { touched = true; return ['OfferCreate']; } });
    assert.equal(parseTradeDelegationObservation(hostilePermissions), undefined);
    assert.equal(touched, false);
  });
});

describe('TRADE-02 — verification', () => {
  it('a fresh, granted OfferCreate delegation for exactly this pair is verified, with the ledger it was proved at', () => {
    const result = verifyTradeDelegation(granted(), REQUIREMENT);
    assert.ok(result.verified);
    assert.deepEqual(result.evidence, {
      schema: TRADE_DELEGATION_EVIDENCE_SCHEMA,
      network: 'xrp-ledger-testnet',
      networkId: 1,
      owner: OWNER,
      delegate: DELEGATE,
      permission: 'OfferCreate',
      permissions: ['OfferCreate'],
      entryIndex: tradeDelegateEntryIndex(OWNER, DELEGATE),
      validatedLedgerIndex: 100,
      validatedLedgerHash: LEDGER_HASH,
      previousTxnId: TXN_A,
      previousTxnLedgerIndex: 90,
      observedAt: OBSERVED,
      verifiedAt: AT,
      maxAgeSeconds: 10,
    });
    assert.equal(Object.isFrozen(result.evidence), true);
  });

  it('OfferCancel beside OfferCreate is tolerated', () => {
    assert.equal(codeOf(granted({ permissions: ['OfferCancel', 'OfferCreate'] })), 'VERIFIED');
  });

  it('refuses with exactly one reason code per failure', () => {
    const matrix: readonly [string, unknown, Partial<TradeDelegationRequirement>, string][] = [
      ['malformed observation', granted({ extra: 1 }), {}, C.OBSERVATION_MALFORMED],
      ['requirement for mainnet', granted(), { network: 'xrp-ledger-mainnet' as never }, C.REQUIREMENT_INVALID],
      ['max age above the ceiling', granted(), { maxAgeSeconds: 61 }, C.REQUIREMENT_INVALID],
      ['max age zero', granted(), { maxAgeSeconds: 0 }, C.REQUIREMENT_INVALID],
      ['fractional max age', granted(), { maxAgeSeconds: 1.5 }, C.REQUIREMENT_INVALID],
      ['requirement instant malformed', granted(), { at: 'now' }, C.REQUIREMENT_INVALID],
      ['requirement self-delegation', granted(), { delegate: OWNER }, C.REQUIREMENT_INVALID],
      ['bad expected previous transaction', granted(), { expectedPreviousTxnId: 'abc' }, C.REQUIREMENT_INVALID],
      ['other network', granted({ network: 'xrp-ledger-devnet', networkId: 2 }), {}, C.NETWORK_MISMATCH],
      ['other owner', granted({ owner: OTHER, entryIndex: tradeDelegateEntryIndex(OTHER, DELEGATE) }), {}, C.OWNER_MISMATCH],
      ['other delegate', granted({ delegate: OTHER, entryIndex: tradeDelegateEntryIndex(OWNER, OTHER) }), {}, C.DELEGATE_MISMATCH],
      ['ledger below the known floor', granted(), { minimumValidatedLedgerIndex: 101 }, C.LEDGER_BELOW_MINIMUM],
      ['observed after the instant', granted({ observedAt: '2026-10-13T12:00:10.001Z' }), {}, C.OBSERVATION_FROM_FUTURE],
      ['older than max age by 1 ms', granted({ observedAt: '2026-10-13T11:59:59.999Z' }), {}, C.OBSERVATION_STALE],
      ['absent', absent(), {}, C.ABSENT],
      ['changed since relied on', granted({ previousTxnId: TXN_B }), { expectedPreviousTxnId: TXN_A }, C.CHANGED],
      ['OfferCreate not granted', granted({ permissions: ['OfferCancel'] }), {}, C.PERMISSION_MISSING],
      ['payment granted too', granted({ permissions: ['OfferCreate', 'Payment'] }), {}, C.PERMISSION_EXCESS],
      ['an unnamed permission too', granted({ permissions: ['OfferCreate', 'value:65545'] }), {}, C.PERMISSION_EXCESS],
    ];
    for (const [name, observation, requirement, code] of matrix) assert.equal(codeOf(observation, requirement), code, name);
  });

  it('the age bound is inclusive at exactly max age and exclusive one millisecond later; equal instants are fresh', () => {
    assert.equal(codeOf(granted({ observedAt: '2026-10-13T12:00:00.000Z' })), 'VERIFIED');
    assert.equal(codeOf(granted({ observedAt: AT })), 'VERIFIED');
  });

  it('a stale absence is still not a grant, and a stale grant is still refused: time is checked before state', () => {
    assert.equal(codeOf(absent({ observedAt: '2026-10-13T11:00:00.000Z' })), C.OBSERVATION_STALE);
    assert.equal(codeOf(granted({ observedAt: '2026-10-13T11:00:00.000Z' })), C.OBSERVATION_STALE);
  });

  it('revocation: once a validated absence at ledger 105 is known, the earlier grant at ledger 100 can no longer verify', () => {
    assert.equal(codeOf(granted()), 'VERIFIED');
    assert.equal(codeOf(absent({ validatedLedgerIndex: 105 }), { minimumValidatedLedgerIndex: 100 }), C.ABSENT);
    assert.equal(codeOf(granted(), { minimumValidatedLedgerIndex: 105 }), C.LEDGER_BELOW_MINIMUM);
  });

  it('revoke and re-grant between decision and signing is detected by the entry’s last-changing transaction', () => {
    const atDecision = verifyTradeDelegation(granted(), REQUIREMENT);
    assert.ok(atDecision.verified);
    const regranted = granted({ validatedLedgerIndex: 120, previousTxnId: TXN_B, previousTxnLedgerIndex: 118 });
    assert.equal(codeOf(regranted, { expectedPreviousTxnId: atDecision.evidence.previousTxnId, minimumValidatedLedgerIndex: atDecision.evidence.validatedLedgerIndex }), C.CHANGED);
    assert.equal(codeOf(granted({ validatedLedgerIndex: 120 }), { expectedPreviousTxnId: TXN_A, minimumValidatedLedgerIndex: 100 }), 'VERIFIED');
  });
});
