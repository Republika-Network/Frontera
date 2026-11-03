import { conformanceDigest } from './canonical.js';
import { toMs, type CredentialState } from './contracts.js';
import { evaluateConformance } from './engine.js';
import type { SyntheticHumanDirectory } from './human-authority.js';
import { loadEngineInput } from './lifecycle.js';
import type { ConformanceProfileRegistry } from './profile.js';
import type { ConformanceStore } from './sqlite-conformance-store.js';
import { transitionsUrlPath, type EvidenceFreshnessStatus, type StatusAssertionPayload } from './status-contracts.js';
import { verifyCredentialHistory } from './verifier.js';

/**
 * RN-CONFORM-03 / WP-03 — the read-only projection of RN-CONFORM-02's committed
 * credential state into the fields a status assertion states.
 *
 * Nothing is taken from a caller: not the state, not the subject, not a
 * freshness time. Everything is read from committed storage and recomputed:
 * the credential record, its immutable integration version, the committed head,
 * the **full transition history verified** (`verifyCredentialHistory`, every
 * digest, signature, chain link and human approval), and evidence freshness by
 * the RN-CONFORM-02 engine over re-authenticated, bounded evidence
 * (`loadEngineInput`). This module writes nothing and calls no lifecycle
 * operation, so it cannot change a conformance decision (INV-08). It is not a
 * second state machine: the state is the committed head's, verbatim.
 *
 * Deterministic for a given committed state and instant `at`: the issuer and
 * the isolated signer each compute it independently and must agree.
 */

export type StatusProjection = Omit<StatusAssertionPayload, 'schema' | 'purpose' | 'issuer' | 'anchors' | 'sequence' | 'previousAssertionDigest' | 'requestNonce' | 'issuedAt' | 'validUntil' | 'designation'>;

export type StatusProjectionResult =
  | { readonly ok: true; readonly projection: StatusProjection; readonly digest: string }
  | { readonly ok: false; readonly reason: 'UNKNOWN_CREDENTIAL' | 'HISTORY_INVALID' | 'REGISTRY_UNAVAILABLE'; readonly detail: string };

export interface StatusProjectionDeps {
  readonly store: ConformanceStore;
  readonly profiles: ConformanceProfileRegistry;
  /** The RN-CONFORM-02 transition-registry public key: the history is re-verified before anything is stated. */
  readonly registryPublicKeyPem: string;
  readonly coordinatorPublicKeyPem: string;
  /** When given, the stored human decisions behind every human-gated transition are re-verified too. */
  readonly humans?: SyntheticHumanDirectory;
  readonly maxEvaluationObservations?: number;
}

/** How far back `lastSuccessfulVerificationAt` looks among committed evaluations. */
const RECENT_EVALUATIONS = 64;

function freshnessOf(input: { readonly unauthenticated: number; readonly proposalKind: string; readonly proposalReason: string; readonly categories: readonly string[] }): EvidenceFreshnessStatus {
  if (input.unauthenticated > 0) return 'EVIDENCE_TAMPERED';
  if (input.proposalKind === 'SUSPEND') return 'PROTECTIVE_ACTION_PENDING';
  if (input.proposalKind === 'NONE' && input.proposalReason === 'UNDER_INVESTIGATION') return 'UNDER_INVESTIGATION';
  if (input.categories.some((c) => c === 'CONFLICTING' || c === 'UNCONFIRMED_VIOLATION')) return 'UNDER_INVESTIGATION';
  if (input.categories.length > 0 && input.categories.every((c) => c === 'VERIFIED_SUCCESS')) return 'FRESH';
  if (input.categories.some((c) => c === 'STALE_EVIDENCE')) return 'STALE';
  return 'INCOMPLETE';
}

const earliest = (values: readonly (string | null)[]): string | null => {
  if (values.length === 0 || values.some((v) => v === null)) return null;
  return [...(values as string[])].sort()[0] ?? null;
};

/** Never throws. A read or verification failure of whatever kind is a refusal to state anything. */
export function projectCredentialStatus(deps: StatusProjectionDeps, credentialId: string, at: string): StatusProjectionResult {
  try {
    const found = deps.store.findCredential(credentialId);
    if (found === undefined) return { ok: false, reason: 'UNKNOWN_CREDENTIAL', detail: 'no such credential' };
    const credential = found;
    const organizationId = credential.organizationId;
    const history = verifyCredentialHistory(deps.store, organizationId, credentialId, { registryPublicKeyPem: deps.registryPublicKeyPem, ...(deps.humans === undefined ? {} : { humans: deps.humans }) });
    if (!history.valid) return { ok: false, reason: 'HISTORY_INVALID', detail: `${history.failure}@${history.atStateVersion ?? '-'}` };
    const head = deps.store.getHead(organizationId, credentialId);
    const integration = deps.store.getIntegrationByDigest(organizationId, credential.integrationDigest);
    if (head === undefined || integration === undefined) return { ok: false, reason: 'REGISTRY_UNAVAILABLE', detail: 'credential record incomplete' };
    // The head must be exactly the verified history's last transition.
    if (head.stateVersion !== history.stateVersion || head.state !== history.state || head.headTransitionDigest !== history.headTransitionDigest) return { ok: false, reason: 'HISTORY_INVALID', detail: 'HEAD_MISMATCH' };
    const loaded = loadEngineInput(deps.store, deps.profiles, organizationId, credentialId, at, deps.coordinatorPublicKeyPem, deps.maxEvaluationObservations === undefined ? {} : { maxObservations: deps.maxEvaluationObservations });
    if (loaded === undefined) return { ok: false, reason: 'REGISTRY_UNAVAILABLE', detail: 'engine input unavailable' };
    const engine = evaluateConformance(loaded.input);
    const critical = engine.requirementResults.filter((r) => r.severity === 'critical');
    const status = freshnessOf({ unauthenticated: loaded.unauthenticated.length, proposalKind: engine.proposal.kind, proposalReason: engine.proposal.reasonCode, categories: critical.map((r) => r.category) });
    // Freshness is stated only when every critical requirement is verified now: the earliest expiry and the oldest supporting success.
    const freshUntil = status === 'FRESH' ? earliest(critical.map((r) => r.freshUntil).filter((v) => v !== null)) : null;
    const oldest = status === 'FRESH' ? earliest(critical.map((r) => r.latestSuccessAt).filter((v) => v !== null)) : null;
    const atMs = toMs(at);
    const lastSuccess = deps.store
      .listRecentEvaluations(organizationId, credentialId, RECENT_EVALUATIONS)
      .find((e) => toMs(e.record.evaluatedAt) <= atMs && e.record.proposal.kind !== 'SUSPEND' && e.record.requirementResults.filter((r) => r.severity === 'critical').every((r) => r.category === 'VERIFIED_SUCCESS'));
    const record = integration.record;
    const projection: StatusProjection = Object.freeze({
      credentialId,
      subject: Object.freeze({ platformId: credential.platformId, organizationId, integrationId: credential.integrationId, integrationVersion: credential.integrationVersion, integrationDigest: credential.integrationDigest }),
      scope: Object.freeze({ coveredOperations: Object.freeze([...credential.coveredOperations].sort()), declaredExclusions: Object.freeze([...new Set(credential.declaredExclusions)].sort()) }),
      profile: Object.freeze({ id: credential.profileId, version: credential.profileVersion, digest: credential.profileDigest }),
      sdk: Object.freeze({ package: record.sdk.package, version: record.sdk.version }),
      adapter: Object.freeze({ name: record.adapter.name, version: record.adapter.version }),
      state: head.state as CredentialState,
      stateVersion: head.stateVersion,
      reasonCode: head.reasonCode,
      effectiveAt: head.effectiveAt,
      lastSuccessfulVerificationAt: lastSuccess?.record.evaluatedAt ?? null,
      evidenceFreshness: Object.freeze({ status: freshUntil === null || oldest === null ? (status === 'FRESH' ? 'INCOMPLETE' : status) : status, oldestRequiredEvidenceAt: oldest, freshUntil }),
      credentialValidUntil: credential.validUntil,
      historyRef: Object.freeze({ latestTransitionDigest: head.headTransitionDigest, transitionsUrlPath: transitionsUrlPath(credentialId) }),
    });
    return { ok: true, projection, digest: conformanceDigest(projection) };
  } catch (error) {
    return { ok: false, reason: 'REGISTRY_UNAVAILABLE', detail: error instanceof Error ? error.name : 'error' };
  }
}
