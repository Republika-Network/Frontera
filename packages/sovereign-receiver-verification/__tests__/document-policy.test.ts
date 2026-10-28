import test from 'node:test';
import assert from 'node:assert/strict';

import { mintSovereignAssetId } from '@aoc/protocol/identity';
import { SovereignLicenseTermsAudienceKind } from '@aoc/protocol/licensing';

import {
  DOCUMENT_USE_ACTIONS,
  DOCUMENT_USE_POLICY_EVALUATOR,
  DOCUMENT_USE_POLICY_REASONS,
  DOCUMENT_USE_PROFILE,
  evaluateDocumentUsePolicy,
  verifyDocumentUseEligibility,
} from '../src/index.js';
import type { DocumentUseEligible, DocumentUsePolicyDecision, DocumentUsePolicyDecisionValue, DocumentUsePolicyReason } from '../src/index.js';
import {
  ACCESS,
  APPROVAL,
  EXPORT,
  MODIFY,
  Obligation,
  PROFILE_RULES,
  Permission,
  RECEIVER,
  Restriction,
  eligibleDocument,
  rule,
} from './document-fixtures.js';

const NOW = '2026-10-28T12:00:00.000Z';
const READ = ACCESS.termRef;

function context(eligibility: DocumentUseEligible, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    receiverPrincipal: RECEIVER,
    evaluationTime: NOW,
    expectedSovereignAssetId: eligibility.sovereignAssetId,
    policyReference: { claimId: eligibility.terms.claimId, claimDigest: eligibility.terms.claimDigest },
    ...overrides,
  };
}

function evaluate(eligibility: unknown, action: string, overrides: Record<string, unknown> = {}): DocumentUsePolicyDecision {
  return evaluateDocumentUsePolicy(eligibility, { action }, context(eligibility as DocumentUseEligible, overrides));
}

function assertDecision(result: DocumentUsePolicyDecision, decision: DocumentUsePolicyDecisionValue, reason: DocumentUsePolicyReason, matched?: readonly string[]): void {
  assert.equal(result.decision, decision, JSON.stringify(result));
  assert.equal(result.reason, reason, JSON.stringify(result));
  if (matched !== undefined) assert.deepEqual(result.matchedRuleIds, matched);
  assert.ok(DOCUMENT_USE_POLICY_REASONS.includes(result.reason));
  assert.equal(result.evaluator, DOCUMENT_USE_POLICY_EVALUATOR);
  assert.equal(result.documentProfile, DOCUMENT_USE_PROFILE);
  // A decision is never an authorization, a capability or an execution.
  assert.equal(result.authorization, 'not_evaluated');
  assert.equal(result.revocation, 'not_evaluated');
  assert.equal(result.freshness, 'not_evaluated');
  assert.equal(result.execution, 'not_performed');
  for (const forbidden of ['capability', 'grant', 'token', 'permit', 'content', 'document', 'bundle']) {
    assert.equal(forbidden in result, false, `decision must not carry "${forbidden}"`);
  }
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.matchedRuleIds));
}

// --- Semantics (profile §4) ----------------------------------------------------------

test('1. READ is allowed under a Permission, with the settling rule recorded', async () => {
  const { eligibility } = await eligibleDocument();
  const result = evaluate(eligibility, READ);
  assertDecision(result, 'ALLOWED', 'PERMITTED', ['rule-access']);
  assert.equal(result.action, READ);
  assert.equal(result.sovereignAssetId, eligibility.sovereignAssetId);
  assert.deepEqual(result.policy, { claimId: eligibility.terms.claimId, claimDigest: eligibility.terms.claimDigest });
  assert.equal(result.evaluationTime, NOW);
});

test('2. READ without a Permission is denied: nothing is permitted by default', async () => {
  const { eligibility } = await eligibleDocument({ rules: [rule('rule-export', Restriction, EXPORT)] });
  assertDecision(evaluate(eligibility, READ), 'DENIED', 'NOT_PERMITTED', []);
});

test('3. READ under a Restriction is denied', async () => {
  const { eligibility } = await eligibleDocument({ rules: [rule('rule-no-read', Restriction, ACCESS)] });
  assertDecision(evaluate(eligibility, READ), 'DENIED', 'RESTRICTED', ['rule-no-read']);
});

test('4. EXPORT under a Restriction is denied', async () => {
  const { eligibility } = await eligibleDocument();
  assertDecision(evaluate(eligibility, EXPORT.termRef), 'DENIED', 'RESTRICTED', ['rule-export']);
});

test('5. EXPORT explicitly permitted is allowed', async () => {
  const { eligibility } = await eligibleDocument({ rules: [rule('rule-export-ok', Permission, EXPORT)] });
  assertDecision(evaluate(eligibility, EXPORT.termRef), 'ALLOWED', 'PERMITTED', ['rule-export-ok']);
});

test('6. MODIFY with a Permission and no approval obligation is allowed (the owner\'s choice)', async () => {
  const { eligibility } = await eligibleDocument({ rules: [rule('rule-modify', Permission, MODIFY)] });
  assertDecision(evaluate(eligibility, MODIFY.termRef), 'ALLOWED', 'PERMITTED', ['rule-modify']);
});

test('7. MODIFY under a Restriction is denied, even beside a Permission and an obligation', async () => {
  const { eligibility } = await eligibleDocument({
    rules: [rule('rule-modify', Permission, MODIFY), rule('rule-no-modify', Restriction, MODIFY), rule('rule-approval', Obligation, APPROVAL)],
  });
  assertDecision(evaluate(eligibility, MODIFY.termRef), 'DENIED', 'RESTRICTED', ['rule-no-modify']);
});

test('8. MODIFY with a pending owner-approval obligation is WITHHELD', async () => {
  const { eligibility } = await eligibleDocument();
  assertDecision(evaluate(eligibility, MODIFY.termRef), 'WITHHELD', 'OWNER_APPROVAL_REQUIRED', ['rule-modify', 'rule-approval']);
});

test('8b. no approval field exists: an asserted approval cannot turn WITHHELD into ALLOWED', async () => {
  const { eligibility } = await eligibleDocument();
  for (const injected of [{ approved: true }, { approval: { approved: true } }, { ownerApproval: 'granted' }]) {
    assertDecision(evaluate(eligibility, MODIFY.termRef, injected), 'DENIED', 'CONTEXT_INVALID');
    assertDecision(evaluateDocumentUsePolicy(eligibility, { action: MODIFY.termRef, ...injected }, context(eligibility)), 'DENIED', 'REQUEST_INVALID');
  }
});

test('8c. MODIFY without a Permission is denied even when an approval obligation exists', async () => {
  const { eligibility } = await eligibleDocument({ rules: [rule('rule-access', Permission, ACCESS), rule('rule-approval', Obligation, APPROVAL)] });
  assertDecision(evaluate(eligibility, MODIFY.termRef), 'DENIED', 'NOT_PERMITTED');
});

test('8d. the approval obligation is scoped to MODIFY: READ under the same terms is allowed', async () => {
  const { eligibility } = await eligibleDocument();
  assertDecision(evaluate(eligibility, READ), 'ALLOWED', 'PERMITTED', ['rule-access']);
});

test('9. Restriction and Permission over the same action: the Restriction wins', async () => {
  const { eligibility } = await eligibleDocument({ rules: [rule('rule-export-ok', Permission, EXPORT), rule('rule-export', Restriction, EXPORT)] });
  assertDecision(evaluate(eligibility, EXPORT.termRef), 'DENIED', 'RESTRICTED', ['rule-export']);
});

test('10. an unknown action is denied, including the obligated action used as an action', async () => {
  const { eligibility } = await eligibleDocument();
  for (const action of ['read', 'aoc.licensing:reproduce', APPROVAL.termRef, 'soberania.document:export ', '']) {
    assertDecision(evaluate(eligibility, action), 'DENIED', 'ACTION_UNKNOWN');
  }
});

test('11. a concept outside the profile never reaches evaluation: FV-P2 refuses it, so nothing is eligible', async () => {
  // Defense in depth: the evaluator rechecks the concept table, but no issued
  // eligibility can carry an unknown concept, and a fabricated one is refused.
  await assert.rejects(eligibleDocument({ rules: [rule('rule-commercial', Permission, { namespace: 'aoc.licensing', termRef: 'aoc.licensing:commercial-use' })] }));
});

test('12. an effect placed on the wrong concept denies every action', async () => {
  const cases = [
    [rule('rule-approval-permitted', Permission, APPROVAL)],
    [rule('rule-approval-restricted', Restriction, APPROVAL)],
    [rule('rule-export-obligation', Obligation, EXPORT)],
  ];
  for (const misplaced of cases) {
    const { eligibility } = await eligibleDocument({ rules: [rule('rule-access', Permission, ACCESS), ...misplaced] });
    for (const action of DOCUMENT_USE_ACTIONS) assertDecision(evaluate(eligibility, action), 'DENIED', 'EFFECT_MISPLACED', [misplaced[0]!.id]);
  }
});

// --- Time (profile §4 Time): effectiveAt inclusive, expiresAt exclusive -----------------

test('13–17. the terms are in effect from effectiveAt (inclusive) until expiresAt (exclusive)', async () => {
  const { eligibility } = await eligibleDocument({ effectiveAt: '2026-06-01T00:00:00.000Z', expiresAt: '2026-12-01T00:00:00.000Z' });
  const at = (evaluationTime: string) => evaluate(eligibility, READ, { evaluationTime });
  assertDecision(at('2026-05-31T23:59:59.999999999Z'), 'DENIED', 'TERMS_NOT_YET_EFFECTIVE');
  assertDecision(at('2026-06-01T00:00:00Z'), 'ALLOWED', 'PERMITTED');
  assertDecision(at('2026-11-30T23:59:59.999999999Z'), 'ALLOWED', 'PERMITTED');
  assertDecision(at('2026-12-01T00:00:00.000Z'), 'DENIED', 'TERMS_EXPIRED');
  assertDecision(at('2026-12-01T00:00:00.000000001Z'), 'DENIED', 'TERMS_EXPIRED');
  assertDecision(at('2027-01-01T00:00:00Z'), 'DENIED', 'TERMS_EXPIRED');
});

test('time is compared exactly, below the millisecond: no rounding grace', async () => {
  const { eligibility } = await eligibleDocument({ expiresAt: '2026-12-01T00:00:00.000000001Z' });
  assertDecision(evaluate(eligibility, READ, { evaluationTime: '2026-12-01T00:00:00Z' }), 'ALLOWED', 'PERMITTED');
  assertDecision(evaluate(eligibility, READ, { evaluationTime: '2026-12-01T00:00:00.000000001Z' }), 'DENIED', 'TERMS_EXPIRED');
});

test('absent bounds are absent: terms without effectiveAt or expiresAt are in effect at any instant', async () => {
  const { eligibility } = await eligibleDocument({ expiresAt: null });
  assertDecision(evaluate(eligibility, READ, { evaluationTime: '9999-12-31T23:59:59.999999999Z' }), 'ALLOWED', 'PERMITTED');
});

test('18. a malformed evaluation time is denied', async () => {
  const { eligibility } = await eligibleDocument();
  for (const evaluationTime of ['2026-02-30T00:00:00Z', '2026-10-28T12:00:00+01:00', '2026-10-28 12:00:00Z', '2026-10-28T24:00:00Z', 'now', 1_793_000_000_000, '', '2026-10-28T12:00:00.0000000001Z']) {
    assertDecision(evaluate(eligibility, READ, { evaluationTime }), 'DENIED', 'EVALUATION_TIME_INVALID');
  }
});

test('19. a missing evaluation time is denied', async () => {
  const { eligibility } = await eligibleDocument();
  const { evaluationTime: _omitted, ...withoutTime } = context(eligibility);
  assertDecision(evaluateDocumentUsePolicy(eligibility, { action: READ }, withoutTime), 'DENIED', 'CONTEXT_INVALID');
});

test('20. only the host-supplied instant is used: the process clock is never read', async () => {
  const { eligibility } = await eligibleDocument({ expiresAt: '2026-12-01T00:00:00.000Z' });
  const realNow = Date.now;
  Date.now = () => { throw new Error('the evaluator must not read the clock'); };
  try {
    assertDecision(evaluate(eligibility, READ, { evaluationTime: '2026-11-01T00:00:00Z' }), 'ALLOWED', 'PERMITTED');
    assertDecision(evaluate(eligibility, READ, { evaluationTime: '2026-12-02T00:00:00Z' }), 'DENIED', 'TERMS_EXPIRED');
  } finally {
    Date.now = realNow;
  }
});

// --- Audience (profile §2, §4) -----------------------------------------------------------

test('21. the receiver named by the terms is the audience', async () => {
  const { eligibility } = await eligibleDocument();
  assertDecision(evaluate(eligibility, READ), 'ALLOWED', 'PERMITTED');
});

test('22. another receiver, or a near-identical identity, is not the audience', async () => {
  const { eligibility } = await eligibleDocument();
  for (const receiverPrincipal of ['did:example:other', 'DID:EXAMPLE:RECEIVER', 'did:example:receiver2', 'did:example:receive']) {
    assertDecision(evaluate(eligibility, READ, { receiverPrincipal }), 'DENIED', 'AUDIENCE_MISMATCH');
  }
});

test('23. a custom audience is not interpreted, so it is denied; a public audience addresses every receiver', async () => {
  const custom = await eligibleDocument({ audience: { kind: SovereignLicenseTermsAudienceKind.Custom, namespace: 'example:membership', id: 'gold' } });
  assertDecision(evaluate(custom.eligibility, READ), 'DENIED', 'AUDIENCE_UNSUPPORTED');
  const open = await eligibleDocument({ audience: { kind: SovereignLicenseTermsAudienceKind.Public } });
  assertDecision(evaluate(open.eligibility, READ, { receiverPrincipal: 'did:example:anyone' }), 'ALLOWED', 'PERMITTED');
});

test('24. a missing or malformed receiver identity is denied, even for a public audience', async () => {
  const open = await eligibleDocument({ audience: { kind: SovereignLicenseTermsAudienceKind.Public } });
  const { receiverPrincipal: _omitted, ...withoutReceiver } = context(open.eligibility);
  assertDecision(evaluateDocumentUsePolicy(open.eligibility, { action: READ }, withoutReceiver), 'DENIED', 'CONTEXT_INVALID');
  for (const receiverPrincipal of ['', ' did:example:receiver', 'did:example:receiver\n', 42, null]) {
    assertDecision(evaluate(open.eligibility, READ, { receiverPrincipal }), 'DENIED', 'RECEIVER_IDENTITY_INVALID');
  }
});

// --- Public audience (founder decision, FV-P3.1) -------------------------------------
// Public means the terms are addressed to any receiver. It neither makes the
// content public nor authorizes anything: every other rule still applies.

const PUBLIC = { kind: SovereignLicenseTermsAudienceKind.Public } as const;
const ANY_RECEIVER = { receiverPrincipal: 'did:example:some-receiver' };

test('Public 1. Public + Permission over READ is ALLOWED for any receiver', async () => {
  const { eligibility } = await eligibleDocument({ audience: PUBLIC });
  assertDecision(evaluate(eligibility, READ, ANY_RECEIVER), 'ALLOWED', 'PERMITTED', ['rule-access']);
});

test('Public 2. Public + Restriction over EXPORT is DENIED', async () => {
  const { eligibility } = await eligibleDocument({ audience: PUBLIC });
  assertDecision(evaluate(eligibility, EXPORT.termRef, ANY_RECEIVER), 'DENIED', 'RESTRICTED', ['rule-export']);
});

test('Public 2b. no audience turns a Restriction into a Permission, even beside an explicit Permission', async () => {
  const { eligibility } = await eligibleDocument({ audience: PUBLIC, rules: [rule('rule-export-ok', Permission, EXPORT), rule('rule-export', Restriction, EXPORT)] });
  assertDecision(evaluate(eligibility, EXPORT.termRef, ANY_RECEIVER), 'DENIED', 'RESTRICTED', ['rule-export']);
});

test('Public 3. Public + owner-approval obligation over MODIFY is WITHHELD', async () => {
  const { eligibility } = await eligibleDocument({ audience: PUBLIC });
  assertDecision(evaluate(eligibility, MODIFY.termRef, ANY_RECEIVER), 'WITHHELD', 'OWNER_APPROVAL_REQUIRED', ['rule-modify', 'rule-approval']);
});

test('Public 4. Public without a Permission is DENIED', async () => {
  const { eligibility } = await eligibleDocument({ audience: PUBLIC, rules: [rule('rule-export', Restriction, EXPORT)] });
  assertDecision(evaluate(eligibility, READ, ANY_RECEIVER), 'DENIED', 'NOT_PERMITTED', []);
});

test('Public 5. Public with expired terms is DENIED', async () => {
  const { eligibility } = await eligibleDocument({ audience: PUBLIC, expiresAt: '2026-01-02T00:00:00.000Z' });
  assertDecision(evaluate(eligibility, READ, ANY_RECEIVER), 'DENIED', 'TERMS_EXPIRED');
});

test('Public 6. Public with an unverified eligibility result is DENIED', async () => {
  const { eligibility } = await eligibleDocument({ audience: PUBLIC });
  const copy = JSON.parse(JSON.stringify(eligibility)) as unknown;
  assertDecision(evaluateDocumentUsePolicy(copy, { action: READ }, context(eligibility, ANY_RECEIVER)), 'DENIED', 'ELIGIBILITY_UNVERIFIED');
});

test('Public 7. a Principal audience with another receiver is DENIED', async () => {
  const { eligibility } = await eligibleDocument();
  assertDecision(evaluate(eligibility, READ, ANY_RECEIVER), 'DENIED', 'AUDIENCE_MISMATCH');
});

test('Public 8. a Custom audience has no supported interpretation and is DENIED', async () => {
  const { eligibility } = await eligibleDocument({ audience: { kind: SovereignLicenseTermsAudienceKind.Custom, namespace: 'example:membership', id: 'gold' } });
  for (const action of DOCUMENT_USE_ACTIONS) assertDecision(evaluate(eligibility, action), 'DENIED', 'AUDIENCE_UNSUPPORTED');
});

// --- Security ---------------------------------------------------------------------

test('25. an ineligible FV-P2 result is never evaluated', async () => {
  const ineligible = await verifyDocumentUseEligibility('{}', { verificationKeyResolver: { resolveVerificationKey: () => undefined }, expectedSovereignAssetId: mintSovereignAssetId() });
  assert.equal(ineligible.outcome, 'ineligible');
  const result = evaluateDocumentUsePolicy(ineligible, { action: READ }, { receiverPrincipal: RECEIVER, evaluationTime: NOW, expectedSovereignAssetId: 'x', policyReference: { claimId: 'x', claimDigest: 'x' } });
  assertDecision(result, 'DENIED', 'ELIGIBILITY_UNVERIFIED');
  assert.equal(result.sovereignAssetId, null);
  assert.equal(result.policy, null);
});

test('26. a fabricated or copied eligibility result is refused, however exact the copy', async () => {
  const { eligibility } = await eligibleDocument();
  const copies: unknown[] = [
    JSON.parse(JSON.stringify(eligibility)),
    structuredClone(eligibility),
    { ...eligibility },
    Object.create(eligibility),
    new Proxy(eligibility, {}),
    undefined,
    null,
  ];
  for (const forged of copies) {
    assertDecision(evaluateDocumentUsePolicy(forged, { action: READ }, context(eligibility)), 'DENIED', 'ELIGIBILITY_UNVERIFIED');
  }
});

test('27. a different expected asset is denied', async () => {
  const { eligibility } = await eligibleDocument();
  assertDecision(evaluate(eligibility, READ, { expectedSovereignAssetId: mintSovereignAssetId() }), 'DENIED', 'ASSET_MISMATCH');
});

test('27b. a policy reference that does not name the eligible terms exactly is denied', async () => {
  const { eligibility } = await eligibleDocument();
  for (const policyReference of [
    { claimId: 'claim:other', claimDigest: eligibility.terms.claimDigest },
    { claimId: eligibility.terms.claimId, claimDigest: '0'.repeat(64) },
  ]) {
    assertDecision(evaluate(eligibility, READ, { policyReference }), 'DENIED', 'POLICY_REFERENCE_MISMATCH');
  }
  assertDecision(evaluate(eligibility, READ, { policyReference: { claimId: eligibility.terms.claimId } }), 'DENIED', 'CONTEXT_INVALID');
});

test('28. terms cannot change after verification: the result is frozen, and an edited copy is not trusted', async () => {
  const { eligibility } = await eligibleDocument();
  assert.throws(() => { (eligibility.terms.rules as unknown as unknown[]).push(rule('rule-export-ok', Permission, EXPORT)); });
  assert.throws(() => { (eligibility.terms.rules[1] as { effect: string }).effect = 'Permission'; });
  const edited = JSON.parse(JSON.stringify(eligibility)) as { terms: { rules: { effect: string }[] } };
  edited.terms.rules[1]!.effect = 'Permission';
  assertDecision(evaluateDocumentUsePolicy(edited, { action: EXPORT.termRef }, context(eligibility)), 'DENIED', 'ELIGIBILITY_UNVERIFIED');
  assertDecision(evaluate(eligibility, EXPORT.termRef), 'DENIED', 'RESTRICTED');
});

test('29. an accessor in the request or the context is refused without being invoked', async () => {
  const { eligibility } = await eligibleDocument();
  let invoked = 0;
  const request = Object.defineProperty({}, 'action', { enumerable: true, get: () => { invoked += 1; return READ; } });
  assertDecision(evaluateDocumentUsePolicy(eligibility, request, context(eligibility)), 'DENIED', 'REQUEST_INVALID');
  const trusted = Object.defineProperty(context(eligibility), 'evaluationTime', { enumerable: true, get: () => { invoked += 1; return NOW; } });
  assertDecision(evaluateDocumentUsePolicy(eligibility, { action: READ }, trusted), 'DENIED', 'CONTEXT_INVALID');
  assert.equal(invoked, 0);
});

test('30. inherited or prototype-borne fields are never honoured', async () => {
  const { eligibility } = await eligibleDocument();
  assertDecision(evaluateDocumentUsePolicy(eligibility, Object.create({ action: READ }), context(eligibility)), 'DENIED', 'REQUEST_INVALID');
  assertDecision(evaluateDocumentUsePolicy(eligibility, { action: READ }, Object.create(context(eligibility))), 'DENIED', 'CONTEXT_INVALID');
  class Request {
    readonly action = READ;
  }
  assertDecision(evaluateDocumentUsePolicy(eligibility, new Request(), context(eligibility)), 'DENIED', 'REQUEST_INVALID');
  // A requester cannot smuggle trusted fields through its request.
  assertDecision(evaluateDocumentUsePolicy(eligibility, { action: READ, evaluationTime: NOW }, context(eligibility)), 'DENIED', 'REQUEST_INVALID');
});

test('31. malformed inputs are denied and never throw', async () => {
  const { eligibility } = await eligibleDocument();
  for (const request of [null, undefined, 'read', [READ], { action: 42 }, {}]) {
    assertDecision(evaluateDocumentUsePolicy(eligibility, request, context(eligibility)), 'DENIED', 'REQUEST_INVALID');
  }
  for (const trusted of [null, undefined, 'context', [], {}, { ...context(eligibility), extra: true }, { ...context(eligibility), policyReference: null }]) {
    assertDecision(evaluateDocumentUsePolicy(eligibility, { action: READ }, trusted), 'DENIED', 'CONTEXT_INVALID');
  }
  const hostile = new Proxy({}, { ownKeys: () => { throw new Error('hostile'); } });
  const result = evaluateDocumentUsePolicy(eligibility, { action: READ }, hostile);
  assert.equal(result.decision, 'DENIED');
});

test('32. several rules: every settling rule is recorded, in authored order', async () => {
  const { eligibility } = await eligibleDocument({
    rules: [rule('read-a', Permission, ACCESS), rule('export-a', Restriction, EXPORT), rule('read-b', Permission, ACCESS), rule('export-b', Restriction, EXPORT)],
  });
  assertDecision(evaluate(eligibility, READ), 'ALLOWED', 'PERMITTED', ['read-a', 'read-b']);
  assertDecision(evaluate(eligibility, EXPORT.termRef), 'DENIED', 'RESTRICTED', ['export-a', 'export-b']);
});

test('33. the same inputs always produce the same decision', async () => {
  const { eligibility } = await eligibleDocument();
  for (const action of [...DOCUMENT_USE_ACTIONS, 'unknown']) {
    const first = evaluate(eligibility, action);
    for (let i = 0; i < 5; i += 1) assert.deepEqual(evaluate(eligibility, action), first);
  }
});

// --- Regression and layering ------------------------------------------------------------

test('36. eligibility is not a permission: it carries no decision, and a decision is never the RSDK-02B verdict', async () => {
  const { eligibility } = await eligibleDocument();
  assert.equal('decision' in eligibility, false);
  // RSDK-02B accepts exactly { decision: 'eligible' } from its asset policy; no evaluator output has that shape.
  for (const action of DOCUMENT_USE_ACTIONS) {
    const result = evaluate(eligibility, action);
    assert.notEqual(result.decision as string, 'eligible');
    assert.ok(Object.keys(result).length > 1);
  }
});

test('the reason and action sets are closed and frozen', () => {
  assert.ok(Object.isFrozen(DOCUMENT_USE_POLICY_REASONS));
  assert.equal(new Set(DOCUMENT_USE_POLICY_REASONS).size, DOCUMENT_USE_POLICY_REASONS.length);
  assert.deepEqual([...DOCUMENT_USE_ACTIONS], [ACCESS.termRef, EXPORT.termRef, MODIFY.termRef]);
  assert.equal(PROFILE_RULES.length, 4);
});
