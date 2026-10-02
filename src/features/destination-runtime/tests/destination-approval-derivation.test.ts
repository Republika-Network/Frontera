import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDestinationApproval,
  buildDestinationApprovalRevocation,
  deriveDestinationApprovalState,
  isDestinationApprovalActive,
  isDestinationApprovalError,
  requireApproveDestinationCommand,
  type DestinationApproval,
  type DestinationApprovalHistoryEntry,
  type DestinationApprovalState,
} from '../approval/index.js';

/**
 * ANDREW-P0-03 — the pure state derivation: current approval state from one
 * organization's history for one destination and a trusted instant. Total over
 * consistent history; anything the write path cannot produce is CORRUPT.
 */

const ORG = 'org-a';
const KEY = 'network-a:abc123';
const DESTINATION = { namespace: 'network-a', identifier: 'abc123' };

function approval(sequence: number, approvedAt: string, expiresAt: string | null = null, organizationId = ORG): DestinationApproval {
  return buildDestinationApproval({ organizationId, destination: DESTINATION, sequence, approvedBy: 'operator:admin-1', authorityBasis: 'basis', approvedAt, expiresAt });
}

function approved(record: DestinationApproval): DestinationApprovalHistoryEntry {
  return { transition: 'approved', approval: record };
}

function revoked(sequence: number, approvalSequence: number, revokedAt: string): DestinationApprovalHistoryEntry {
  return {
    transition: 'revoked',
    revocation: buildDestinationApprovalRevocation({ organizationId: ORG, destinationKey: KEY, sequence, approvalSequence, revokedBy: 'operator:admin-1', revocationBasis: 'basis', revokedAt }),
  };
}

function derive(history: readonly DestinationApprovalHistoryEntry[], now: string): DestinationApprovalState {
  return deriveDestinationApprovalState(ORG, KEY, history, now);
}

function assertCorrupt(history: readonly DestinationApprovalHistoryEntry[], now = '2026-10-02T20:00:00.000Z'): void {
  assert.throws(
    () => derive(history, now),
    (error: unknown) => isDestinationApprovalError(error) && error.code === 'DESTINATION_APPROVAL_CORRUPT',
  );
}

describe('Destination approval state derivation (ANDREW-P0-03)', () => {
  it('no history is never-approved, and only `approved` is active', () => {
    const state = derive([], '2026-10-02T12:00:00.000Z');
    assert.deepEqual(state, { state: 'never-approved', organizationId: ORG, destinationKey: KEY });
    assert.equal(isDestinationApprovalActive(state), false);
    const first = approval(1, '2026-10-02T12:00:00.000Z', '2026-10-02T18:00:00.000Z');
    assert.equal(isDestinationApprovalActive(derive([approved(first)], '2026-10-02T13:00:00.000Z')), true);
    assert.equal(isDestinationApprovalActive(derive([approved(first)], '2026-10-02T18:00:00.000Z')), false);
    assert.equal(isDestinationApprovalActive(derive([approved(first), revoked(2, 1, '2026-10-02T13:00:00.000Z')], '2026-10-02T13:00:00.000Z')), false);
  });

  it('expiry: approved strictly before expiresAt, expired at and after it — and revoked is not expired', () => {
    const first = approval(1, '2026-10-02T12:00:00.000Z', '2026-10-02T18:00:00.000Z');
    assert.equal(derive([approved(first)], '2026-10-02T17:59:59.999Z').state, 'approved');
    assert.equal(derive([approved(first)], '2026-10-02T18:00:00.000Z').state, 'expired');
    assert.equal(derive([approved(first)], '2026-10-02T18:00:00.001Z').state, 'expired');
    const ended = derive([approved(first), revoked(2, 1, '2026-10-02T13:00:00.000Z')], '2026-10-03T00:00:00.000Z');
    assert.equal(ended.state, 'revoked', 'revocation is reported as revocation even after the original expiry');
  });

  it('revoked and expired states keep the approval they are about, unchanged', () => {
    const first = approval(1, '2026-10-02T12:00:00.000Z', '2026-10-02T18:00:00.000Z');
    const expired = derive([approved(first)], '2026-10-02T19:00:00.000Z');
    assert.equal(expired.state === 'expired' && expired.approval, first);
    const state = derive([approved(first), revoked(2, 1, '2026-10-02T13:00:00.000Z')], '2026-10-02T14:00:00.000Z');
    assert.equal(state.state === 'revoked' && state.approval, first);
  });

  it('re-approval after revocation and after expiry is a new active approval', () => {
    const first = approval(1, '2026-10-02T12:00:00.000Z', '2026-10-02T13:00:00.000Z');
    const second = approval(3, '2026-10-02T14:00:00.000Z');
    const afterRevoke = derive([approved(approval(1, '2026-10-02T12:00:00.000Z')), revoked(2, 1, '2026-10-02T12:30:00.000Z'), approved(second)], '2026-10-02T15:00:00.000Z');
    assert.equal(afterRevoke.state === 'approved' && afterRevoke.approval.sequence, 3);
    const afterExpiry = derive([approved(first), approved(approval(2, '2026-10-02T13:00:00.000Z'))], '2026-10-02T15:00:00.000Z');
    assert.equal(afterExpiry.state === 'approved' && afterExpiry.approval.sequence, 2);
  });

  it('refuses history the write path cannot produce', () => {
    const first = approval(1, '2026-10-02T12:00:00.000Z', '2026-10-02T18:00:00.000Z');
    // A second approval while the first is still active.
    assertCorrupt([approved(first), approved(approval(2, '2026-10-02T13:00:00.000Z'))]);
    // A revocation first, a revocation of the wrong approval, two revocations.
    assertCorrupt([revoked(1, 1, '2026-10-02T12:00:00.000Z')]);
    assertCorrupt([approved(first), revoked(2, 7, '2026-10-02T13:00:00.000Z')]);
    assertCorrupt([approved(first), revoked(2, 1, '2026-10-02T13:00:00.000Z'), revoked(3, 1, '2026-10-02T13:30:00.000Z')]);
    // A revocation after the approval had expired.
    assertCorrupt([approved(first), revoked(2, 1, '2026-10-02T18:00:00.000Z')]);
    // Out of order, or a duplicate sequence.
    assertCorrupt([approved(approval(2, '2026-10-02T12:00:00.000Z')), revoked(1, 2, '2026-10-02T13:00:00.000Z')]);
    assertCorrupt([approved(first), approved(approval(1, '2026-10-02T19:00:00.000Z'))]);
    // Another organization's record, or another destination's.
    assertCorrupt([approved(approval(1, '2026-10-02T12:00:00.000Z', null, 'org-b'))]);
    assertCorrupt([approved(buildDestinationApproval({ organizationId: ORG, destination: { namespace: 'network-b', identifier: 'abc123' }, sequence: 1, approvedBy: 'a', authorityBasis: 'b', approvedAt: '2026-10-02T12:00:00.000Z', expiresAt: null }))]);
    // An expiry that is not after the approval.
    assertCorrupt([approved(approval(1, '2026-10-02T12:00:00.000Z', '2026-10-02T12:00:00.000Z'))]);
  });

  it('an approval command states only a destination, optional expiry and an idempotency key; absent expiry is null', () => {
    assert.deepEqual(requireApproveDestinationCommand({ destination: DESTINATION, idempotencyKey: 'approve-0001' }), { destination: DESTINATION, expiresAt: null, idempotencyKey: 'approve-0001' });
    for (const extra of ['organizationId', 'approvedBy', 'approved', 'status']) {
      assert.throws(
        () => requireApproveDestinationCommand({ destination: DESTINATION, idempotencyKey: 'approve-0001', [extra]: 'x' }),
        (error: unknown) => isDestinationApprovalError(error) && error.code === 'DESTINATION_APPROVAL_INPUT_INVALID',
      );
    }
  });
});
