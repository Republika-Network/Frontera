import { conformanceDigest } from './canonical.js';
import { SYNTHETIC_DESIGNATION, isIdentifier, readClosed, toMs, toTimestamp, type TransitionRecord } from './contracts.js';
import { ConformanceStoreError } from './sqlite-conformance-store.js';
import {
  MAX_STATUS_ASSERTION_LIFETIME_MS,
  STATUS_ASSERTION_PURPOSE,
  STATUS_ASSERTION_SCHEMA,
  STATUS_NONCE,
  STATUS_REFUSAL_PURPOSE,
  STATUS_REFUSAL_SCHEMA,
  parseStatusArtifact,
  serializeStatusArtifact,
  statusArtifactDigest,
  type StatusAssertion,
  type StatusAssertionPayload,
  type StatusRefusal,
  type StatusRefusalPayload,
  type StatusRefusalResult,
} from './status-contracts.js';
import { projectCredentialStatus, type StatusProjectionDeps, type StatusProjectionResult } from './status-projection.js';
import type { KeyObject } from 'node:crypto';

import { authenticateStatusRequest, projectionOf, type StatusIssuerKeyRecord, type StatusSignerPort, type StatusSignerRefusal } from './status-signer.js';

/**
 * RN-CONFORM-03 / WP-03–WP-06, WP-09 — the status registry: issues signed
 * status assertions over RN-CONFORM-02's committed credential state.
 *
 * ## Linearization point (INV-03)
 *
 * Each attempt (1) snapshots and projects the committed state outside any lock,
 * then (2) opens one `BEGIN IMMEDIATE` transaction on the conformance store —
 * the same write lock every credential transition needs — re-projects inside
 * it, and proceeds only if the projection is unchanged. Inside that transaction
 * it reads the chain head, has the isolated signer sign, and appends the
 * assertion; a trigger refuses the row unless it names the head committed at
 * that instant. **The linearization point is the re-projection inside the
 * IMMEDIATE transaction**: no transition can commit between it and the
 * assertion's insert, so an assertion is never issued for a head that is
 * already superseded. If the head moved between (1) and (2), the attempt is
 * retried (bounded); if every attempt sees movement, or the signer is
 * unavailable, the result is UNAVAILABLE and nothing is signed.
 *
 * Issuance writes only `cc_status_assertions`. It never evaluates, transitions
 * or changes a head (INV-08).
 */

export const DEFAULT_ONLINE_LIFETIME_MS = 5 * 60 * 1000;
export const DEFAULT_STAPLED_LIFETIME_MS = MAX_STATUS_ASSERTION_LIFETIME_MS;
export const DEFAULT_ISSUANCE_ATTEMPTS = 3;
/** A refusal says nothing about state, so it is short-lived. */
export const REFUSAL_LIFETIME_MS = 60 * 1000;

export interface OnlineStatusRequest {
  readonly credentialId: string;
  readonly nonce: string;
  readonly expect: {
    readonly platformId: string;
    readonly organizationId: string;
    readonly integrationId: string;
    readonly integrationVersion: number;
    readonly integrationDigest: string;
    readonly profileId: string;
    readonly profileVersion: string;
  };
  /** The covered operation the verifier is deciding about. Checked by the verifier against the signed scope. */
  readonly operation: string;
}

export type StatusUnavailableReason = 'MALFORMED_REQUEST' | 'SIGNER_UNAVAILABLE' | 'SIGNER_REFUSED' | 'REGISTRY_UNAVAILABLE' | 'HISTORY_INVALID' | 'RETRY_EXHAUSTED' | 'STORE_BUSY' | 'CLOCK_BEHIND';

export type StatusIssueOutcome =
  | { readonly kind: 'assertion'; readonly text: string; readonly assertion: StatusAssertion }
  | { readonly kind: 'refusal'; readonly text: string; readonly refusal: StatusRefusal }
  /** Nothing was signed. A client must treat this as "not currently conformant". */
  | { readonly kind: 'unavailable'; readonly reason: StatusUnavailableReason; readonly detail: string };

export interface PublicTransition {
  readonly stateVersion: number;
  readonly transitionCode: string;
  readonly from: string | null;
  readonly to: string;
  readonly reasonCode: string;
  readonly effectiveAt: string;
  readonly transitionDigest: string;
  readonly previousTransitionDigest: string | null;
  /** How many human approvals the transition carries — never who (CC-D-13). */
  readonly humanApprovals: number;
}

export interface StatusRegistry {
  issueOnline(request: unknown): StatusIssueOutcome;
  /** The current stapled assertion for the committed head, reused while still valid and still exactly current, otherwise newly issued. */
  stapled(credentialId: string): StatusIssueOutcome;
  /** Public transition history (minimal fields, bounded page). `undefined` for an unknown credential. */
  transitions(credentialId: string, afterStateVersion: number, limit: number): readonly PublicTransition[] | undefined;
  publicKeys(): readonly StatusIssuerKeyRecord[];
}

export const MAX_TRANSITIONS_PAGE = 50;

export function readOnlineStatusRequest(value: unknown): OnlineStatusRequest | undefined {
  const top = readClosed(value, ['credentialId', 'nonce', 'expect', 'operation']);
  if (!top.ok) return undefined;
  const expect = readClosed(top.record['expect'], ['platformId', 'organizationId', 'integrationId', 'integrationVersion', 'integrationDigest', 'profileId', 'profileVersion']);
  if (!expect.ok) return undefined;
  const e = expect.record;
  const r = top.record;
  const ok =
    isIdentifier(r['credentialId']) && typeof r['nonce'] === 'string' && STATUS_NONCE.test(r['nonce']) && typeof r['operation'] === 'string' && /^[a-z][a-z0-9.-]{0,63}$/.test(r['operation']) &&
    isIdentifier(e['platformId']) && isIdentifier(e['organizationId']) && isIdentifier(e['integrationId']) && Number.isSafeInteger(e['integrationVersion']) && (e['integrationVersion'] as number) >= 1 &&
    typeof e['integrationDigest'] === 'string' && /^sha256:[0-9a-f]{64}$/.test(e['integrationDigest']) && isIdentifier(e['profileId']) && typeof e['profileVersion'] === 'string';
  return ok ? (Object.freeze({ ...r, expect: Object.freeze({ ...e }) }) as unknown as OnlineStatusRequest) : undefined;
}

export function createStatusRegistry(deps: {
  readonly projection: StatusProjectionDeps;
  readonly clock: { now(): string };
  readonly signer: StatusSignerPort;
  /** The registry's own requester identity towards the signer (not the issuer key, which it never holds). */
  readonly requester: { readonly id: string; readonly key: KeyObject };
  readonly issuer: string;
  readonly onlineLifetimeMs?: number;
  readonly stapledLifetimeMs?: number;
  readonly maxAttempts?: number;
  /** Deterministic test barriers. `afterPrepare` runs outside the lock after the snapshot; `beforeSign` inside it. */
  readonly hooks?: { readonly afterPrepare?: (attempt: number) => void; readonly beforeSign?: () => void };
}): StatusRegistry {
  const { projection: p, clock, signer, requester, issuer } = deps;
  const onlineLifetime = Math.min(deps.onlineLifetimeMs ?? DEFAULT_ONLINE_LIFETIME_MS, MAX_STATUS_ASSERTION_LIFETIME_MS);
  const stapledLifetime = Math.min(deps.stapledLifetimeMs ?? DEFAULT_STAPLED_LIFETIME_MS, MAX_STATUS_ASSERTION_LIFETIME_MS);
  const attempts = Math.max(1, Math.min(10, Math.floor(deps.maxAttempts ?? DEFAULT_ISSUANCE_ATTEMPTS)));

  const unavailable = (reason: StatusUnavailableReason, detail = ''): StatusIssueOutcome => Object.freeze({ kind: 'unavailable', reason, detail });
  const fromSigner = (refusal: StatusSignerRefusal): StatusIssueOutcome => (refusal === 'UNAVAILABLE' ? unavailable('SIGNER_UNAVAILABLE') : unavailable('SIGNER_REFUSED', refusal));
  const request = (operation: 'signStatusAssertion' | 'signStatusRefusal', payload: StatusAssertionPayload | StatusRefusalPayload) => ({
    operation,
    requesterId: requester.id,
    payload,
    authentication: authenticateStatusRequest(requester.key, { operation, requesterId: requester.id, payload }),
  });

  const refusal = (credentialId: string, nonce: string, result: StatusRefusalResult): StatusIssueOutcome => {
    const now = clock.now();
    const payload: StatusRefusalPayload = Object.freeze({
      schema: STATUS_REFUSAL_SCHEMA,
      purpose: STATUS_REFUSAL_PURPOSE,
      issuer,
      requestedCredentialId: credentialId,
      requestNonce: nonce,
      result,
      issuedAt: now,
      validUntil: toTimestamp(toMs(now) + REFUSAL_LIFETIME_MS),
      designation: SYNTHETIC_DESIGNATION,
    });
    const signed = signer.sign(request('signStatusRefusal', payload));
    if (!signed.ok) return fromSigner(signed.refusal);
    const artifact: StatusRefusal = Object.freeze({ ...payload, signature: signed.signature });
    return Object.freeze({ kind: 'refusal', text: serializeStatusArtifact(artifact), refusal: artifact });
  };

  const project = (credentialId: string, at: string): StatusProjectionResult => projectCredentialStatus(p, credentialId, at);

  /** One issuance: snapshot → (barrier) → IMMEDIATE { re-project, compare, chain head, sign, append }. */
  const issue = (credentialId: string, nonce: string | null, lifetimeMs: number): StatusIssueOutcome => {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const at = clock.now();
      const snapshot = project(credentialId, at);
      if (!snapshot.ok) return snapshot.reason === 'HISTORY_INVALID' ? unavailable('HISTORY_INVALID', snapshot.detail) : unavailable('REGISTRY_UNAVAILABLE', snapshot.detail);
      deps.hooks?.afterPrepare?.(attempt);
      let outcome: StatusIssueOutcome | 'retry' | 'nonce-reused';
      try {
        outcome = p.store.withStatusIssuance((insert): StatusIssueOutcome | 'retry' | 'nonce-reused' => {
          const current = project(credentialId, at);
          if (!current.ok) return current.reason === 'HISTORY_INVALID' ? unavailable('HISTORY_INVALID', current.detail) : unavailable('REGISTRY_UNAVAILABLE', current.detail);
          if (current.digest !== snapshot.digest) return 'retry';
          const last = p.store.latestStatusAssertion(credentialId);
          // Everything the append could still refuse is checked here, under the lock and before the signer is asked:
          // a signature is never spent (and its sequence burned in the signer's journal) on an append that cannot happen.
          if (nonce !== null && p.store.isStatusNonceUsed(nonce)) return 'nonce-reused';
          if (last !== undefined && toMs(at) < last.issuedAtMs) return unavailable('CLOCK_BEHIND', 'the issuer clock is behind the last issued assertion');
          const credentialEnd = toMs(current.projection.credentialValidUntil);
          // A fresh assertion never outlives the credential it describes (an already expired credential gets the normal lifetime and states its expiry).
          const end = credentialEnd > toMs(at) ? Math.min(toMs(at) + lifetimeMs, credentialEnd) : toMs(at) + lifetimeMs;
          const payload: StatusAssertionPayload = Object.freeze({
            schema: STATUS_ASSERTION_SCHEMA,
            purpose: STATUS_ASSERTION_PURPOSE,
            issuer,
            ...current.projection,
            anchors: Object.freeze([]),
            sequence: (last?.sequence ?? 0) + 1,
            previousAssertionDigest: last?.assertionDigest ?? null,
            requestNonce: nonce,
            issuedAt: at,
            validUntil: toTimestamp(end),
            designation: SYNTHETIC_DESIGNATION,
          });
          deps.hooks?.beforeSign?.();
          const signed = signer.sign(request('signStatusAssertion', payload));
          if (!signed.ok) return fromSigner(signed.refusal);
          const artifact: StatusAssertion = Object.freeze({ ...payload, signature: signed.signature });
          const text = serializeStatusArtifact(artifact);
          insert({
            credentialId,
            sequence: artifact.sequence,
            assertionDigest: statusArtifactDigest(artifact),
            previousAssertionDigest: artifact.previousAssertionDigest,
            state: artifact.state,
            stateVersion: artifact.stateVersion,
            transitionDigest: artifact.historyRef.latestTransitionDigest,
            requestNonce: nonce,
            issuedAtMs: toMs(artifact.issuedAt),
            validUntilMs: toMs(artifact.validUntil),
            keyId: artifact.signature.keyId,
            assertionJson: text,
          });
          return Object.freeze({ kind: 'assertion', text, assertion: artifact });
        });
      } catch (error) {
        if (error instanceof ConformanceStoreError && error.code === 'BUSY') continue;
        if (error instanceof ConformanceStoreError && error.code === 'CONFLICT' && nonce !== null && p.store.isStatusNonceUsed(nonce)) return refusal(credentialId, nonce, 'NONCE_REUSED');
        return unavailable('REGISTRY_UNAVAILABLE', error instanceof ConformanceStoreError ? error.code : 'error');
      }
      if (outcome === 'nonce-reused' && nonce !== null) return refusal(credentialId, nonce, 'NONCE_REUSED');
      if (outcome !== 'retry' && outcome !== 'nonce-reused') return outcome;
    }
    return unavailable('RETRY_EXHAUSTED');
  };

  return Object.freeze<StatusRegistry>({
    issueOnline(raw: unknown): StatusIssueOutcome {
      try {
        const req = readOnlineStatusRequest(raw);
        if (req === undefined) return unavailable('MALFORMED_REQUEST');
        if (p.store.isStatusNonceUsed(req.nonce)) return refusal(req.credentialId, req.nonce, 'NONCE_REUSED');
        const credential = p.store.findCredential(req.credentialId);
        // Another organization's credential is indistinguishable from an unknown one (CC-D-13: nothing about other organizations).
        if (credential === undefined || credential.organizationId !== req.expect.organizationId) return refusal(req.credentialId, req.nonce, 'UNKNOWN_CREDENTIAL');
        const e = req.expect;
        if (credential.platformId !== e.platformId || credential.integrationId !== e.integrationId || credential.integrationVersion !== e.integrationVersion || credential.integrationDigest !== e.integrationDigest) {
          return refusal(req.credentialId, req.nonce, 'SUBJECT_MISMATCH');
        }
        if (credential.profileId !== e.profileId || credential.profileVersion !== e.profileVersion) return refusal(req.credentialId, req.nonce, 'PROFILE_MISMATCH');
        return issue(req.credentialId, req.nonce, onlineLifetime);
      } catch {
        return unavailable('REGISTRY_UNAVAILABLE');
      }
    },

    stapled(credentialId: string): StatusIssueOutcome {
      try {
        if (!isIdentifier(credentialId)) return unavailable('MALFORMED_REQUEST');
        if (p.store.findCredential(credentialId) === undefined) return unavailable('MALFORMED_REQUEST', 'UNKNOWN_CREDENTIAL');
        const now = clock.now();
        const cached = p.store.currentStapledAssertion(credentialId, toMs(now));
        if (cached !== undefined) {
          // Reused only while it still states exactly the current projection (a new investigation or lapsed evidence forces a new one).
          const parsed = parseStatusArtifact(cached.assertionJson);
          const current = project(credentialId, now);
          // The row's columns (used to select it) must agree with the artifact served (review P2-E).
          const consistent =
            parsed.ok && parsed.kind === 'assertion' && parsed.artifact.issuer === issuer && toMs(parsed.artifact.issuedAt) === cached.issuedAtMs && toMs(parsed.artifact.validUntil) === cached.validUntilMs &&
            parsed.artifact.sequence === cached.sequence && parsed.artifact.requestNonce === null && toMs(parsed.artifact.validUntil) > toMs(now);
          if (consistent && parsed.ok && parsed.kind === 'assertion' && current.ok && conformanceDigest(projectionOf(parsed.payload)) === current.digest) {
            return Object.freeze({ kind: 'assertion', text: cached.assertionJson, assertion: parsed.artifact });
          }
        }
        return issue(credentialId, null, stapledLifetime);
      } catch {
        return unavailable('REGISTRY_UNAVAILABLE');
      }
    },

    transitions(credentialId: string, afterStateVersion: number, limit: number) {
      const credential = isIdentifier(credentialId) ? p.store.findCredential(credentialId) : undefined;
      if (credential === undefined) return undefined;
      const bound = Math.max(1, Math.min(MAX_TRANSITIONS_PAGE, Math.floor(limit)));
      return Object.freeze(
        p.store
          .listTransitions(credential.organizationId, credentialId)
          .filter((row) => row.stateVersion > afterStateVersion)
          .slice(0, bound)
          .map((row) => {
            const record = JSON.parse(row.recordJson) as TransitionRecord;
            return Object.freeze({
              stateVersion: row.stateVersion,
              transitionCode: record.transitionCode,
              from: record.from,
              to: record.to,
              reasonCode: record.reasonCode,
              effectiveAt: record.effectiveAt,
              transitionDigest: row.transitionDigest,
              previousTransitionDigest: record.previousTransitionDigest,
              humanApprovals: record.humanDecisions.length,
            });
          }),
      );
    },

    publicKeys: () => signer.publicKeys(),
  });
}
