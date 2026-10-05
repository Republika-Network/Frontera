import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { GovernanceRecord } from '../governance-store/contracts.js';
import { projectRequestPayload } from '../governance-store/projection.js';
import { deriveBusinessIntentId, reconsiderationLinkReferenceId } from '../governed-action/identifiers.js';
import { RECONSIDERATION_REASONS, assessReconsiderationTarget, businessIntentDigest, isReconsiderationReason } from '../governed-action/reconsideration-lineage.js';

/**
 * ANDREW-P0-09 — the reconsideration rules at their own boundary, against a
 * pure assessment over a minimal record, so each refusal is isolated: tenant,
 * actor, integrity, root, status and business-intent identity.
 */

const ORG = 'org-p009';
const ACTOR = 'actor-agent';
const PRINCIPAL = 'principal-agent';
const ORIGINAL = 'aoc.gar:11111111111111111111111111111111';
const NEW = 'aoc.gar:22222222222222222222222222222222';
const scope = { organizationId: ORG, principalId: PRINCIPAL, actorId: ACTOR };

function kernelRequest(overrides: { readonly action?: Record<string, unknown>; readonly actorId?: string; readonly organizationId?: string; readonly requestId?: string; readonly correlationId?: string; readonly requestedAt?: string; readonly context?: Record<string, unknown> } = {}) {
  return {
    requestId: overrides.requestId ?? NEW,
    actor: { id: overrides.actorId ?? ACTOR, trustDomainId: 'td' },
    organization: { id: overrides.organizationId ?? ORG },
    action: { type: 'transfer-funds', resourceScope: 'treasury', counterpartyId: 'xrpl.testnet:rAddress', amount: '10', currency: 'USD', ...overrides.action },
    requestedAt: overrides.requestedAt ?? '2026-10-05T00:00:00.000Z',
    ...(overrides.correlationId !== undefined ? { correlationId: overrides.correlationId } : {}),
    ...(overrides.context !== undefined ? { context: overrides.context } : {}),
  };
}
const payload = (overrides: Parameters<typeof kernelRequest>[0] = {}) => projectRequestPayload(kernelRequest(overrides) as never);

function record(overrides: { readonly status?: string; readonly actorId?: string; readonly organizationId?: string; readonly requestId?: string; readonly payload?: Readonly<Record<string, unknown>>; readonly references?: GovernanceRecord['references'] } = {}): GovernanceRecord {
  const requestId = overrides.requestId ?? ORIGINAL;
  return {
    request: { requestId, organizationId: overrides.organizationId ?? ORG, actorId: overrides.actorId ?? ACTOR, requestPayload: overrides.payload ?? payload({ requestId }) },
    evaluation: { evaluationId: 'eval-original', decisionId: 'decision-original', status: overrides.status ?? 'denied', reasonCodes: ['DOMAIN_POLICY_DENIED'] },
    references: overrides.references ?? [],
  } as unknown as GovernanceRecord;
}

/** The pure assessment, given what the commit phase read (the original record, and whether it verified). */
const verify = async (found: GovernanceRecord | null, options: { readonly valid?: boolean; readonly of?: string; readonly requestId?: string; readonly newPayload?: Readonly<Record<string, unknown>> } = {}) =>
  assessReconsiderationTarget({ original: found, originalVerified: found !== null && (options.valid ?? true), scope, requestId: options.requestId ?? NEW, reconsideration: { of: options.of ?? ORIGINAL, reason: 'destination-approved' }, requestPayload: options.newPayload ?? payload() });

describe('ANDREW-P0-09 — the business intent is who wants what, not how the attempt was made', () => {
  it('ignores request id, time, the caller correlation label and asserted context', () => {
    const base = businessIntentDigest(payload());
    assert.equal(businessIntentDigest(payload({ requestId: ORIGINAL, requestedAt: '2027-01-01T00:00:00.000Z', correlationId: 'anything', context: { passportId: 'p' } })), base);
  });

  it('is sensitive to the organization, the actor, and every field of the action', () => {
    const base = businessIntentDigest(payload());
    for (const variant of [
      payload({ organizationId: 'org-other' }),
      payload({ actorId: 'actor-other' }),
      payload({ action: { type: 'other-action' } }),
      payload({ action: { resourceScope: 'other-treasury' } }),
      payload({ action: { counterpartyId: 'xrpl:rAddress' } }),
      payload({ action: { amount: '10.01' } }),
      payload({ action: { currency: 'EUR' } }),
      payload({ action: { governedParameters: [{ dimension: 'x', value: 1 }] } }),
    ]) {
      assert.notEqual(businessIntentDigest(variant), base);
    }
  });

  it('the reason vocabulary is closed', () => {
    for (const reason of RECONSIDERATION_REASONS) assert.equal(isReconsiderationReason(reason), true);
    for (const reason of ['because', 'DESTINATION-APPROVED', '', 1, null]) assert.equal(isReconsiderationReason(reason), false);
  });
});

describe('ANDREW-P0-09 — who may reconsider what', () => {
  it('accepts an original of this organization and actor, withheld, with the same intent — and derives the shared intent id', async () => {
    const verdict = await verify(record());
    assert.ok(verdict.ok);
    assert.equal(verdict.target.originalRequestId, ORIGINAL);
    assert.equal(verdict.target.originalDecisionId, 'decision-original');
    assert.equal(verdict.target.businessIntentId, deriveBusinessIntentId({ organizationId: ORG, originalRequestId: ORIGINAL }));
    assert.equal(verdict.target.intentDigest, businessIntentDigest(payload()));
  });

  it('accepts an indeterminate original too', async () => {
    assert.equal((await verify(record({ status: 'indeterminate' }))).ok, true);
  });

  const refusal = async (promise: ReturnType<typeof verify>) => {
    const verdict = await promise;
    return verdict.ok ? 'ok' : verdict.refusal;
  };

  it('refuses itself, a missing original, and another organization’s action', async () => {
    assert.equal(await refusal(verify(record(), { of: NEW, requestId: NEW })), 'RECONSIDERATION_TARGET_SELF');
    assert.equal(await refusal(verify(null)), 'RECONSIDERATION_TARGET_NOT_FOUND');
    assert.equal(await refusal(verify(record({ organizationId: 'org-elsewhere' }))), 'RECONSIDERATION_TARGET_NOT_FOUND');
  });

  it('refuses an unverifiable original and another actor’s original', async () => {
    assert.equal(await refusal(verify(record(), { valid: false })), 'RECONSIDERATION_TARGET_UNVERIFIABLE');
    assert.equal(await refusal(verify(record({ actorId: 'actor-other' }))), 'RECONSIDERATION_TARGET_OTHER_ACTOR');
  });

  it('refuses a reconsideration as target (one root per lineage) and any original that was not withheld', async () => {
    const asReconsideration = record({ references: [{ referenceId: reconsiderationLinkReferenceId(ORIGINAL), referenceType: 'reconsideration_link', externalId: 'aoc.gar:33333333333333333333333333333333' }] as unknown as GovernanceRecord['references'] });
    assert.equal(await refusal(verify(asReconsideration)), 'RECONSIDERATION_TARGET_NOT_ORIGINAL');
    for (const status of ['allowed', 'approval_required']) assert.equal(await refusal(verify(record({ status }))), 'RECONSIDERATION_TARGET_NOT_WITHHELD', status);
  });

  it('refuses a different business intent', async () => {
    assert.equal(await refusal(verify(record(), { newPayload: payload({ action: { amount: '11' } }) })), 'RECONSIDERATION_INTENT_MISMATCH');
    assert.equal(await refusal(verify(record(), { newPayload: payload({ action: { counterpartyId: 'xrpl.testnet:rOther' } }) })), 'RECONSIDERATION_INTENT_MISMATCH');
  });
});
