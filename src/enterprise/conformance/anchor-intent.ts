import { canonicalizeConformance, conformanceDigest } from './canonical.js';
import { isIdentifier, toMs, type TransitionRecord } from './contracts.js';
import type { ConformanceStore, StoredAnchorIntent } from './sqlite-conformance-store.js';

/**
 * RN-CONFORM-03 / WP-11 — a **simulated** ledger anchor intent (network intent `XRPL_TESTNET`).
 *
 * A local, prepared record that a future RN-CONFORM-03X adapter could submit:
 * it binds one immutable credential transition (id + digest) and the profile
 * version by digest, and nothing else — no evidence, no validator identity, no
 * customer data. It is **not** an anchor: `confirmationState` is always
 * `prepared`, there is no field for a ledger transaction hash (none is ever
 * invented), and status assertions never list it in `anchors`. Nothing here
 * opens a connection or depends on a ledger client library.
 *
 * Anchoring is never on the suspension path: preparing (or failing to prepare)
 * an intent cannot block or delay a protective transition (INV-11).
 */

export const ANCHOR_INTENT_SCHEMA = 'rn.conformance.anchor-intent/1' as const;

export interface AnchorIntentRecord {
  readonly anchorSchemaVersion: typeof ANCHOR_INTENT_SCHEMA;
  readonly credentialId: string;
  readonly transitionId: string;
  readonly transitionDigest: string;
  readonly profileVersion: string;
  /** Digest of the canonical anchor payload `{credentialId, transitionId, transitionDigest, profileVersion}`. */
  readonly canonicalPayloadDigest: string;
  readonly networkIntent: 'XRPL_TESTNET';
  readonly preparedAt: string;
  readonly confirmationState: 'prepared';
  readonly synthetic: true;
}

export class AnchorIntentError extends Error {
  readonly code: 'UNKNOWN_CREDENTIAL' | 'UNKNOWN_TRANSITION' | 'TRANSITION_DIGEST_MISMATCH' | 'MALFORMED_INPUT';
  constructor(code: AnchorIntentError['code']) {
    super(`Anchor intent refused: ${code}`);
    this.name = 'AnchorIntentError';
    this.code = code;
  }
}

/** The deterministic canonical payload an eventual ledger anchor would carry (by digest). */
export function anchorPayload(credentialId: string, transition: Pick<TransitionRecord, 'transitionId' | 'profileVersion'>, transitionDigest: string) {
  return Object.freeze({ schema: ANCHOR_INTENT_SCHEMA, credentialId, transitionId: transition.transitionId, transitionDigest, profileVersion: transition.profileVersion });
}

/**
 * Prepares (idempotently) the anchor intent for one committed transition. `expectedTransitionDigest`, when
 * given, must equal the stored digest. Returns the existing intent if one was already prepared.
 */
export function prepareAnchorIntent(store: ConformanceStore, input: { readonly credentialId: string; readonly transitionId: string; readonly expectedTransitionDigest?: string; readonly now: string }): AnchorIntentRecord {
  if (!isIdentifier(input.credentialId) || !isIdentifier(input.transitionId) || !Number.isFinite(toMs(input.now))) throw new AnchorIntentError('MALFORMED_INPUT');
  const existing = store.getAnchorIntentByTransition(input.transitionId);
  if (existing !== undefined && existing.credentialId === input.credentialId) {
    const record = JSON.parse(existing.recordJson) as AnchorIntentRecord;
    if (input.expectedTransitionDigest !== undefined && record.transitionDigest !== input.expectedTransitionDigest) throw new AnchorIntentError('TRANSITION_DIGEST_MISMATCH');
    return record;
  }
  const credential = store.findCredential(input.credentialId);
  if (credential === undefined) throw new AnchorIntentError('UNKNOWN_CREDENTIAL');
  const row = store.listTransitions(credential.organizationId, input.credentialId).find((t) => t.columns.transitionId === input.transitionId);
  if (row === undefined) throw new AnchorIntentError('UNKNOWN_TRANSITION');
  if (input.expectedTransitionDigest !== undefined && row.transitionDigest !== input.expectedTransitionDigest) throw new AnchorIntentError('TRANSITION_DIGEST_MISMATCH');
  const transition = JSON.parse(row.recordJson) as TransitionRecord;
  const payload = anchorPayload(input.credentialId, transition, row.transitionDigest);
  const record: AnchorIntentRecord = Object.freeze({
    anchorSchemaVersion: ANCHOR_INTENT_SCHEMA,
    credentialId: input.credentialId,
    transitionId: input.transitionId,
    transitionDigest: row.transitionDigest,
    profileVersion: transition.profileVersion,
    canonicalPayloadDigest: conformanceDigest(payload),
    networkIntent: 'XRPL_TESTNET',
    preparedAt: input.now,
    confirmationState: 'prepared',
    synthetic: true,
  });
  const stored: StoredAnchorIntent = Object.freeze({
    intentId: `anc_${conformanceDigest({ transitionId: input.transitionId, transitionDigest: row.transitionDigest }).slice(7, 39)}`,
    credentialId: input.credentialId,
    transitionId: input.transitionId,
    transitionDigest: row.transitionDigest,
    profileVersion: transition.profileVersion,
    payloadDigest: record.canonicalPayloadDigest,
    networkIntent: 'XRPL_TESTNET',
    confirmationState: 'prepared',
    preparedAtMs: toMs(input.now),
    recordJson: canonicalizeConformance(record),
  });
  store.insertAnchorIntent(stored);
  return record;
}
