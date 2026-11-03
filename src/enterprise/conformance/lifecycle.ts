import type { KeyObject } from 'node:crypto';

import { conformanceDigest } from './canonical.js';
import { newIdentifier, type RandomSource } from './coordinator.js';
import {
  SYNTHETIC_DESIGNATION,
  isIdentifier,
  isTimestamp,
  toMs,
  toTimestamp,
  type CredentialHead,
  type CredentialRecord,
  type CredentialState,
  type EvaluationRecord,
  type HumanAction,
  type HumanDecisionRef,
  type IntegrationVersionRecord,
  type SignedTransition,
  type TransitionCode,
  type TransitionRecord,
} from './contracts.js';
import { evaluateConformance, type EngineInput, type EngineOutput } from './engine.js';
import { authenticateStoredObservation, toAccepted } from './evidence.js';
import { verifyTwoPersonAuthority, type HumanAuthorityDenial, type SyntheticHumanDirectory } from './human-authority.js';
import type { ConformanceProfileDefinition, ConformanceProfileRegistry } from './profile.js';
import type { ConformanceClock } from './registry.js';
import { ConformanceStoreError, type ConformanceStore, type ConsumedDecision, type EvaluationCommit } from './sqlite-conformance-store.js';
import { signConformancePayload } from './signing.js';

/**
 * RN-CONFORM-02 / WP-10 — the credential lifecycle, the only writer of
 * credential state.
 *
 * | # | Edge | How |
 * |---|---|---|
 * | T1 | ∅ → CANDIDATE | `registerCandidate` |
 * | T2 | CANDIDATE → ACTIVE | `prepare('issue')` + two humans + `commit` |
 * | T3 | CANDIDATE → EXPIRED | `applyTimeRules` (candidate term) |
 * | T4 | ACTIVE → SUSPENDED | `evaluate` — automatic, atomic with the evaluation, no human |
 * | T5 | SUSPENDED → ACTIVE | after `CRITICAL_VIOLATION_CONFIRMED`/`CONFLICTING_EVIDENCE`, or a critical failure confirmed while suspended: `prepare('reinstate')` with a remediation declaration + full revalidation + two new decisions from two distinct humans (they may be the people who approved issuance; the decisions themselves are single-use); after `EVIDENCE_STALE`/`CORROBORATION_UNAVAILABLE`: `reinstateAutomatically` once revalidated |
 * | T6 | SUSPENDED → REVOKED | `prepare('revoke')` + two humans, or `applyTimeRules` after the suspension timeout (the only automatic revocation) |
 * | T7 | ACTIVE → REVOKED | `prepare('revoke')` + two humans |
 * | T8 | ACTIVE/SUSPENDED → EXPIRED | `applyTimeRules` (credential term) |
 *
 * REVOKED and EXPIRED are terminal; the store's triggers refuse every edge
 * out of them, every gap in `stateVersion`, and every activation without an
 * eligible evaluation computed on the immediately preceding head.
 */

export const AUTO_REINSTATABLE_REASONS = Object.freeze(['EVIDENCE_STALE', 'CORROBORATION_UNAVAILABLE'] as const);
export const HUMAN_REINSTATEMENT_REASONS = Object.freeze(['CRITICAL_VIOLATION_CONFIRMED', 'CONFLICTING_EVIDENCE'] as const);
export const REVOCATION_REASONS = Object.freeze(['PLATFORM_REQUEST', 'CONTRACT_TERMINATION', 'EVIDENCE_FORGERY_CONFIRMED', 'INTENTIONAL_BYPASS_CONFIRMED'] as const);
/** A prepared action older than this must be prepared again. */
export const PREPARED_ACTION_MAX_AGE_MS = 15 * 60 * 1000;

export type LifecycleRefusal =
  | 'UNKNOWN_INTEGRATION'
  | 'UNKNOWN_CREDENTIAL'
  | 'UNKNOWN_PROFILE'
  | 'CREDENTIAL_EXISTS'
  | 'WRONG_STATE'
  | 'NOT_ELIGIBLE'
  | 'NO_LONGER_ELIGIBLE'
  | 'REMEDIATION_REQUIRED'
  | 'HUMAN_PATH_NOT_APPLICABLE'
  | 'AUTOMATIC_PATH_NOT_APPLICABLE'
  | 'MALFORMED_INPUT'
  | 'PREPARED_ACTION_TAMPERED'
  | 'PREPARED_ACTION_EXPIRED'
  | 'CAS_CONFLICT'
  | 'STORE_BUSY'
  | 'APPROVAL_REFUSED'
  | 'INVARIANT_REFUSED';

export class CredentialLifecycleError extends Error {
  readonly code: LifecycleRefusal;
  readonly detail: string;
  constructor(code: LifecycleRefusal, detail = '') {
    super(`Credential lifecycle refused: ${code}${detail === '' ? '' : ` (${detail})`}`);
    this.name = 'CredentialLifecycleError';
    this.code = code;
    this.detail = detail;
  }
}

export interface LoadedCredential {
  readonly credential: CredentialRecord;
  readonly head: CredentialHead;
  readonly integration: IntegrationVersionRecord;
  readonly profile: ConformanceProfileDefinition;
}

/** Everything the engine needs, read from committed storage only. */
/**
 * Everything the engine needs, read from committed storage only. Every observation row is
 * re-authenticated from its signed submission (`authenticateStoredObservation`); rows that fail are
 * never evaluated and are counted in `unauthenticated`, which the verifier treats as tampering.
 */
export function loadEngineInput(
  store: ConformanceStore,
  profiles: ConformanceProfileRegistry,
  organizationId: string,
  credentialId: string,
  now: string,
  coordinatorPublicKeyPem: string,
): { loaded: LoadedCredential; input: EngineInput; unauthenticated: readonly string[] } | undefined {
  const credential = store.getCredential(organizationId, credentialId);
  const head = store.getHead(organizationId, credentialId);
  if (credential === undefined || head === undefined) return undefined;
  const integration = store.getIntegrationByDigest(organizationId, credential.integrationDigest);
  const profile = profiles.resolve(credential.profileId, credential.profileVersion, credential.profileDigest);
  if (integration === undefined || !profile.ok) return undefined;
  const nowMs = toMs(now);
  const all = store.listObservations(organizationId, credential.integrationDigest);
  const unauthenticated = all.filter((row) => authenticateStoredObservation(store, row, coordinatorPublicKeyPem) !== null).map((row) => row.eventId);
  const rows = all.filter((row) => !unauthenticated.includes(row.eventId));
  const excluded = new Set<string>();
  for (const validatorId of new Set(rows.map((r) => r.validatorId))) {
    const v = store.getValidator(validatorId);
    if (v === undefined || (v.keyRevokedAtMs !== null && v.keyRevokedAtMs <= nowMs) || (v.quarantinedAtMs !== null && v.quarantinedAtMs <= nowMs)) excluded.add(validatorId);
  }
  return {
    loaded: { credential, head, integration: integration.record, profile: profile.definition },
    input: {
      profile: profile.definition,
      integration: { integrationDigest: credential.integrationDigest, sdk: integration.record.sdk },
      observations: rows.map(toAccepted),
      excludedValidatorIds: [...excluded].sort(),
      evaluatedAt: now,
      credentialState: head.state,
      revalidationSince: head.state === 'SUSPENDED' ? head.effectiveAt : null,
    },
    unauthenticated,
  };
}

/**
 * Whether lifting the current suspension needs the two-person path: the suspension's own reason is a
 * violation or dispute, **or** a critical failure was confirmed while suspended (a
 * suspension that began as stale or unavailable evidence does not launder a later confirmed violation).
 */
export function reinstatementNeedsHumans(store: ConformanceStore, organizationId: string, credentialId: string, head: CredentialHead): boolean {
  if ((HUMAN_REINSTATEMENT_REASONS as readonly string[]).includes(head.reasonCode)) return true;
  const since = toMs(head.effectiveAt);
  return store.listEvaluations(organizationId, credentialId).some((e) => e.record.criticalFailureConfirmed && toMs(e.record.evaluatedAt) >= since);
}

export function signTransition(record: TransitionRecord, registryKey: KeyObject): SignedTransition {
  const transitionDigest = conformanceDigest(record);
  return Object.freeze({ record, transitionDigest, registrySignature: signConformancePayload('transition', { record, transitionDigest }, registryKey) });
}

export interface PreparedAction {
  readonly action: HumanAction;
  readonly organizationId: string;
  readonly credentialId: string;
  /** The exact action two humans approve. Its digest is `actionBindingDigest`. */
  readonly binding: {
    readonly schema: 'rn.conformance.action-binding/1';
    readonly action: HumanAction;
    readonly organizationId: string;
    readonly credentialId: string;
    readonly integrationId: string;
    readonly integrationVersion: number;
    readonly integrationDigest: string;
    readonly profileId: string;
    readonly profileVersion: string;
    readonly profileDigest: string;
    readonly transitionId: string;
    readonly transitionCode: TransitionCode;
    readonly fromState: CredentialState;
    readonly toState: CredentialState;
    readonly stateVersion: number;
    readonly reasonCode: string;
    readonly evaluationId: string | null;
    readonly evaluationDigest: string | null;
    readonly remediationDigest: string | null;
    readonly preparedAt: string;
    readonly synthetic: true;
  };
  readonly actionBindingDigest: string;
  readonly evaluation: EvaluationCommit | null;
}

export interface RemediationDeclaration {
  readonly statement: string;
  readonly declaredBy: string;
  readonly declaredAt: string;
}

export interface CredentialLifecycle {
  registerCandidate(input: { readonly organizationId: string; readonly integrationDigest: string }): CredentialRecord;
  /** Evaluates the credential now and commits the evaluation; when it requires suspension, the T4 transition commits in the same row insert. */
  evaluate(organizationId: string, credentialId: string, options?: { readonly faultHook?: () => void }): { readonly evaluation: EvaluationRecord; readonly protectiveTransition: SignedTransition | null; readonly engine: EngineOutput };
  /** Engine result now, without persisting (diagnostics and the verifier's freshness check). */
  assess(organizationId: string, credentialId: string): { readonly loaded: LoadedCredential; readonly engine: EngineOutput } | undefined;
  prepare(kind: 'issue' | 'reinstate' | 'revoke', input: { readonly organizationId: string; readonly credentialId: string; readonly remediation?: RemediationDeclaration; readonly reasonCode?: string }): PreparedAction;
  commit(prepared: PreparedAction, decisions: readonly unknown[]): CredentialHead;
  reinstateAutomatically(organizationId: string, credentialId: string): CredentialHead;
  applyTimeRules(organizationId: string, credentialId: string): CredentialHead;
}

const ACTION_OF: Readonly<Record<'issue' | 'reinstate' | 'revoke', HumanAction>> = Object.freeze({ issue: 'credential.issue', reinstate: 'credential.reinstate', revoke: 'credential.revoke' });

export function createCredentialLifecycle(deps: {
  readonly store: ConformanceStore;
  readonly profiles: ConformanceProfileRegistry;
  readonly clock: ConformanceClock;
  readonly random: RandomSource;
  readonly registryKey: KeyObject;
  readonly humans: SyntheticHumanDirectory;
  /** Stored observations are re-authenticated against the coordinator's challenges before every evaluation. */
  readonly coordinatorPublicKeyPem: string;
}): CredentialLifecycle {
  const { store, profiles, clock, random, registryKey, humans, coordinatorPublicKeyPem } = deps;

  const load = (organizationId: string, credentialId: string, now: string) => {
    const result = loadEngineInput(store, profiles, organizationId, credentialId, now, coordinatorPublicKeyPem);
    if (result === undefined) throw new CredentialLifecycleError('UNKNOWN_CREDENTIAL');
    return result;
  };

  const storeCall = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (error) {
      if (error instanceof ConformanceStoreError) {
        if (error.code === 'CAS_CONFLICT') throw new CredentialLifecycleError('CAS_CONFLICT', error.detail);
        if (error.code === 'BUSY') throw new CredentialLifecycleError('STORE_BUSY', error.detail);
        if (error.code === 'CONFLICT') throw new CredentialLifecycleError('APPROVAL_REFUSED', 'ALREADY_CONSUMED');
        throw new CredentialLifecycleError('INVARIANT_REFUSED', error.detail);
      }
      throw error;
    }
  };

  const buildEvaluation = (loaded: LoadedCredential, input: EngineInput, engine: EngineOutput): { record: EvaluationRecord; digest: string } => {
    const record: EvaluationRecord = Object.freeze({
      schema: 'rn.conformance.evaluation/1',
      evaluationId: newIdentifier(random, 'evl'),
      credentialId: loaded.credential.credentialId,
      organizationId: loaded.credential.organizationId,
      integrationDigest: loaded.credential.integrationDigest,
      profileId: loaded.credential.profileId,
      profileVersion: loaded.credential.profileVersion,
      profileDigest: loaded.credential.profileDigest,
      evaluatedAt: input.evaluatedAt,
      credentialState: loaded.head.state,
      credentialStateVersion: loaded.head.stateVersion,
      revalidationSince: input.revalidationSince,
      requirementResults: engine.requirementResults,
      proposal: engine.proposal,
      criticalFailureConfirmed: engine.criticalFailureConfirmed,
      evidenceIds: engine.evidenceIds,
      synthetic: true,
    });
    return { record, digest: conformanceDigest(record) };
  };

  const transition = (
    loaded: LoadedCredential,
    fields: Pick<TransitionRecord, 'transitionId' | 'to' | 'transitionCode' | 'reasonCode' | 'ruleId' | 'evaluationId' | 'evaluationDigest' | 'evidenceIds' | 'humanDecisions' | 'actionBindingDigest' | 'remediationDigest' | 'effectiveAt'>,
  ): SignedTransition =>
    signTransition(
      Object.freeze({
        schema: 'rn.conformance.transition/1',
        transitionId: fields.transitionId,
        credentialId: loaded.credential.credentialId,
        organizationId: loaded.credential.organizationId,
        stateVersion: loaded.head.stateVersion + 1,
        previousTransitionDigest: loaded.head.headTransitionDigest,
        from: loaded.head.state,
        to: fields.to,
        transitionCode: fields.transitionCode,
        reasonCode: fields.reasonCode,
        ruleId: fields.ruleId,
        profileId: loaded.credential.profileId,
        profileVersion: loaded.credential.profileVersion,
        integrationDigest: loaded.credential.integrationDigest,
        evaluationId: fields.evaluationId,
        evaluationDigest: fields.evaluationDigest,
        evidenceIds: Object.freeze([...fields.evidenceIds]),
        humanDecisions: Object.freeze([...fields.humanDecisions]),
        actionBindingDigest: fields.actionBindingDigest,
        remediationDigest: fields.remediationDigest,
        effectiveAt: fields.effectiveAt,
        synthetic: true,
      }),
      registryKey,
    );

  /** Runs inside the write transaction: the head has not moved and, for an activation, the evidence still makes it eligible. */
  const recheck = (organizationId: string, credentialId: string, expectedStateVersion: number, toActive: boolean) => {
    const current = load(organizationId, credentialId, clock.now());
    if (current.loaded.head.stateVersion !== expectedStateVersion) throw new CredentialLifecycleError('CAS_CONFLICT', 'the credential moved before commit');
    if (toActive && evaluateConformance(current.input).proposal.kind !== 'ELIGIBLE_FOR_ACTIVE') throw new CredentialLifecycleError('NO_LONGER_ELIGIBLE');
  };

  const headOf = (organizationId: string, credentialId: string): CredentialHead => {
    const head = store.getHead(organizationId, credentialId);
    if (head === undefined) throw new CredentialLifecycleError('UNKNOWN_CREDENTIAL');
    return head;
  };

  return Object.freeze<CredentialLifecycle>({
    registerCandidate(input) {
      if (!isIdentifier(input.organizationId) || typeof input.integrationDigest !== 'string') throw new CredentialLifecycleError('MALFORMED_INPUT');
      const integration = store.getIntegrationByDigest(input.organizationId, input.integrationDigest);
      if (integration === undefined) throw new CredentialLifecycleError('UNKNOWN_INTEGRATION');
      const profile = profiles.resolve(integration.record.profile.id, integration.record.profile.version, integration.record.profile.digest);
      if (!profile.ok) throw new CredentialLifecycleError('UNKNOWN_PROFILE');
      const now = clock.now();
      const nowMs = toMs(now);
      const record: CredentialRecord = Object.freeze({
        schema: 'rn.conformance.credential/1',
        credentialId: newIdentifier(random, 'crd'),
        organizationId: input.organizationId,
        platformId: integration.record.platformId,
        integrationId: integration.record.integrationId,
        integrationVersion: integration.record.integrationVersion,
        integrationDigest: integration.integrationDigest,
        profileId: profile.definition.profileId,
        profileVersion: profile.definition.profileVersion,
        profileDigest: profile.digest,
        coveredOperations: integration.record.coveredOperations,
        declaredExclusions: Object.freeze(integration.record.declaredExclusions.map((e) => e.operation)),
        createdAt: now,
        candidateUntil: toTimestamp(nowMs + profile.definition.candidateTermSeconds * 1000),
        validUntil: toTimestamp(nowMs + profile.definition.credentialTermSeconds * 1000),
        designation: SYNTHETIC_DESIGNATION,
        synthetic: true,
      });
      const genesis = signTransition(
        Object.freeze({
          schema: 'rn.conformance.transition/1',
          transitionId: newIdentifier(random, 'trn'),
          credentialId: record.credentialId,
          organizationId: record.organizationId,
          stateVersion: 1,
          previousTransitionDigest: null,
          from: null,
          to: 'CANDIDATE',
          transitionCode: 'T1',
          reasonCode: 'INTEGRATION_REGISTERED',
          ruleId: 'T1-REGISTRATION',
          profileId: record.profileId,
          profileVersion: record.profileVersion,
          integrationDigest: record.integrationDigest,
          evaluationId: null,
          evaluationDigest: null,
          evidenceIds: Object.freeze([]),
          humanDecisions: Object.freeze([]),
          actionBindingDigest: null,
          remediationDigest: null,
          effectiveAt: now,
          synthetic: true,
        }),
        registryKey,
      );
      try {
        store.createCredential(record, profile.definition.suspensionRevocationSeconds * 1000, genesis);
      } catch (error) {
        if (error instanceof ConformanceStoreError && error.code === 'CONFLICT') throw new CredentialLifecycleError('CREDENTIAL_EXISTS');
        throw error;
      }
      return record;
    },

    assess(organizationId: string, credentialId: string) {
      const result = loadEngineInput(store, profiles, organizationId, credentialId, clock.now(), coordinatorPublicKeyPem);
      return result === undefined ? undefined : { loaded: result.loaded, engine: evaluateConformance(result.input) };
    },

    evaluate(organizationId: string, credentialId: string, options = {}) {
      const now = clock.now();
      const { loaded, input } = load(organizationId, credentialId, now);
      const engine = evaluateConformance(input);
      const evaluation = buildEvaluation(loaded, input, engine);
      let protectiveTransition: SignedTransition | null = null;
      if (engine.proposal.kind === 'SUSPEND') {
        protectiveTransition = transition(loaded, {
          transitionId: newIdentifier(random, 'trn'),
          to: 'SUSPENDED',
          transitionCode: 'T4',
          reasonCode: engine.proposal.reasonCode,
          ruleId: engine.proposal.ruleId,
          evaluationId: evaluation.record.evaluationId,
          evaluationDigest: evaluation.digest,
          evidenceIds: engine.evidenceIds,
          humanDecisions: [],
          actionBindingDigest: null,
          remediationDigest: null,
          effectiveAt: now,
        });
      }
      storeCall(() => store.commitEvaluation({ record: evaluation.record, evaluationDigest: evaluation.digest, protectiveTransition }, options.faultHook));
      return { evaluation: evaluation.record, protectiveTransition, engine };
    },

    prepare(kind, input) {
      if (kind !== 'issue' && kind !== 'reinstate' && kind !== 'revoke') throw new CredentialLifecycleError('MALFORMED_INPUT');
      const now = clock.now();
      const { loaded, input: engineInput } = load(input.organizationId, input.credentialId, now);
      const { head } = loaded;
      let to: CredentialState;
      let code: TransitionCode;
      let reasonCode: string;
      let evaluation: EvaluationCommit | null = null;
      let remediationDigest: string | null = null;

      if (kind === 'revoke') {
        if (head.state !== 'ACTIVE' && head.state !== 'SUSPENDED') throw new CredentialLifecycleError('WRONG_STATE', head.state);
        if (typeof input.reasonCode !== 'string' || !(REVOCATION_REASONS as readonly string[]).includes(input.reasonCode)) throw new CredentialLifecycleError('MALFORMED_INPUT', 'revocation reason');
        to = 'REVOKED';
        code = head.state === 'ACTIVE' ? 'T7' : 'T6';
        reasonCode = input.reasonCode;
      } else {
        if (kind === 'issue' && head.state !== 'CANDIDATE') throw new CredentialLifecycleError('WRONG_STATE', head.state);
        if (kind === 'reinstate') {
          if (head.state !== 'SUSPENDED') throw new CredentialLifecycleError('WRONG_STATE', head.state);
          if (!reinstatementNeedsHumans(store, input.organizationId, input.credentialId, head)) throw new CredentialLifecycleError('HUMAN_PATH_NOT_APPLICABLE', head.reasonCode);
          const r = input.remediation;
          if (r === undefined || typeof r.statement !== 'string' || r.statement.length === 0 || r.statement.length > 512 || !isIdentifier(r.declaredBy) || !isTimestamp(r.declaredAt) || toMs(r.declaredAt) < toMs(head.effectiveAt) || toMs(r.declaredAt) > toMs(now)) {
            throw new CredentialLifecycleError('REMEDIATION_REQUIRED');
          }
          remediationDigest = conformanceDigest({ schema: 'rn.conformance.remediation/1', credentialId: loaded.credential.credentialId, suspendedBy: head.headTransitionDigest, statement: r.statement, declaredBy: r.declaredBy, declaredAt: r.declaredAt });
        }
        const engine = evaluateConformance(engineInput);
        if (engine.proposal.kind !== 'ELIGIBLE_FOR_ACTIVE') throw new CredentialLifecycleError('NOT_ELIGIBLE', engine.requirementResults.filter((r) => r.severity === 'critical' && r.category !== 'VERIFIED_SUCCESS').map((r) => `${r.requirementId}:${r.category}`).join(','));
        const built = buildEvaluation(loaded, engineInput, engine);
        evaluation = Object.freeze({ record: built.record, evaluationDigest: built.digest, protectiveTransition: null });
        to = 'ACTIVE';
        code = kind === 'issue' ? 'T2' : 'T5';
        reasonCode = kind === 'issue' ? 'ALL_CRITICAL_VERIFIED' : 'REMEDIATED_AND_REVALIDATED';
      }

      const binding: PreparedAction['binding'] = Object.freeze({
        schema: 'rn.conformance.action-binding/1',
        action: ACTION_OF[kind],
        organizationId: loaded.credential.organizationId,
        credentialId: loaded.credential.credentialId,
        integrationId: loaded.credential.integrationId,
        integrationVersion: loaded.credential.integrationVersion,
        integrationDigest: loaded.credential.integrationDigest,
        profileId: loaded.credential.profileId,
        profileVersion: loaded.credential.profileVersion,
        profileDigest: loaded.credential.profileDigest,
        transitionId: newIdentifier(random, 'trn'),
        transitionCode: code,
        fromState: head.state,
        toState: to,
        stateVersion: head.stateVersion + 1,
        reasonCode,
        evaluationId: evaluation?.record.evaluationId ?? null,
        evaluationDigest: evaluation?.evaluationDigest ?? null,
        remediationDigest,
        preparedAt: now,
        synthetic: true,
      });
      return Object.freeze({ action: ACTION_OF[kind], organizationId: loaded.credential.organizationId, credentialId: loaded.credential.credentialId, binding, actionBindingDigest: conformanceDigest(binding), evaluation });
    },

    commit(prepared: PreparedAction, decisions: readonly unknown[]) {
      const now = clock.now();
      const b = prepared.binding;
      // The binding is recomputed, never trusted: a modified action, subject or evaluation changes the digest the humans signed.
      if (conformanceDigest(b) !== prepared.actionBindingDigest || b.action !== prepared.action || b.credentialId !== prepared.credentialId || b.organizationId !== prepared.organizationId) {
        throw new CredentialLifecycleError('PREPARED_ACTION_TAMPERED');
      }
      if (prepared.evaluation !== null && (conformanceDigest(prepared.evaluation.record) !== prepared.evaluation.evaluationDigest || prepared.evaluation.evaluationDigest !== b.evaluationDigest || prepared.evaluation.record.evaluationId !== b.evaluationId)) {
        throw new CredentialLifecycleError('PREPARED_ACTION_TAMPERED');
      }
      if (toMs(now) - toMs(b.preparedAt) > PREPARED_ACTION_MAX_AGE_MS || toMs(now) < toMs(b.preparedAt)) throw new CredentialLifecycleError('PREPARED_ACTION_EXPIRED');
      const { loaded, input } = load(b.organizationId, b.credentialId, now);
      if (loaded.head.stateVersion !== b.stateVersion - 1 || loaded.head.state !== b.fromState) throw new CredentialLifecycleError('CAS_CONFLICT', 'the credential moved since the action was prepared');
      if (b.toState === 'ACTIVE') {
        // Eligibility is re-established at commit time: evidence that went stale or a violation that arrived since preparation refuses.
        const engine = evaluateConformance(input);
        if (engine.proposal.kind !== 'ELIGIBLE_FOR_ACTIVE') throw new CredentialLifecycleError('NO_LONGER_ELIGIBLE');
      }
      const authority = verifyTwoPersonAuthority(
        humans,
        decisions,
        { action: b.action, organizationId: b.organizationId, subjectRef: b.credentialId, actionBindingDigest: prepared.actionBindingDigest, now },
        store.isDecisionConsumed,
      );
      if (!authority.authorized) throw new CredentialLifecycleError('APPROVAL_REFUSED', authority.denial satisfies HumanAuthorityDenial);
      const refs: HumanDecisionRef[] = [...authority.refs];
      const consumed: ConsumedDecision[] = refs.map((ref, index) => ({ ref, signed: authority.signed[index]!, action: b.action, organizationId: b.organizationId, subjectRef: b.credentialId }));
      const signed = transition(loaded, {
        transitionId: b.transitionId,
        to: b.toState,
        transitionCode: b.transitionCode,
        reasonCode: b.reasonCode,
        ruleId: `${b.transitionCode}-${b.action}`,
        evaluationId: b.evaluationId,
        evaluationDigest: b.evaluationDigest,
        evidenceIds: prepared.evaluation?.record.evidenceIds ?? [],
        humanDecisions: refs,
        actionBindingDigest: prepared.actionBindingDigest,
        remediationDigest: b.remediationDigest,
        effectiveAt: now,
      });
      storeCall(() => store.commitTransition({ evaluation: prepared.evaluation, decisions: consumed, transition: signed }, undefined, () => recheck(b.organizationId, b.credentialId, b.stateVersion - 1, b.toState === 'ACTIVE')));
      return headOf(b.organizationId, b.credentialId);
    },

    reinstateAutomatically(organizationId: string, credentialId: string) {
      const now = clock.now();
      const { loaded, input } = load(organizationId, credentialId, now);
      if (loaded.head.state !== 'SUSPENDED') throw new CredentialLifecycleError('WRONG_STATE', loaded.head.state);
      if (!(AUTO_REINSTATABLE_REASONS as readonly string[]).includes(loaded.head.reasonCode) || reinstatementNeedsHumans(store, organizationId, credentialId, loaded.head)) {
        throw new CredentialLifecycleError('AUTOMATIC_PATH_NOT_APPLICABLE', loaded.head.reasonCode);
      }
      const engine = evaluateConformance(input);
      if (engine.proposal.kind !== 'ELIGIBLE_FOR_ACTIVE') throw new CredentialLifecycleError('NOT_ELIGIBLE');
      const built = buildEvaluation(loaded, input, engine);
      const signed = transition(loaded, {
        transitionId: newIdentifier(random, 'trn'),
        to: 'ACTIVE',
        transitionCode: 'T5',
        reasonCode: 'REVALIDATED_AUTOMATIC',
        ruleId: 'T5-AUTOMATIC',
        evaluationId: built.record.evaluationId,
        evaluationDigest: built.digest,
        evidenceIds: engine.evidenceIds,
        humanDecisions: [],
        actionBindingDigest: null,
        remediationDigest: null,
        effectiveAt: now,
      });
      storeCall(() =>
        store.commitTransition({ evaluation: { record: built.record, evaluationDigest: built.digest, protectiveTransition: null }, decisions: [], transition: signed }, undefined, () => {
          recheck(organizationId, credentialId, loaded.head.stateVersion, true);
          if (reinstatementNeedsHumans(store, organizationId, credentialId, loaded.head)) throw new CredentialLifecycleError('AUTOMATIC_PATH_NOT_APPLICABLE');
        }),
      );
      return headOf(organizationId, credentialId);
    },

    applyTimeRules(organizationId: string, credentialId: string) {
      const now = clock.now();
      const nowMs = toMs(now);
      const { loaded } = load(organizationId, credentialId, now);
      const { head, credential, profile } = loaded;
      let next: { to: CredentialState; code: TransitionCode; reason: string } | null = null;
      if ((head.state === 'ACTIVE' || head.state === 'SUSPENDED') && nowMs >= toMs(credential.validUntil)) next = { to: 'EXPIRED', code: 'T8', reason: 'CREDENTIAL_TERM_ENDED' };
      else if (head.state === 'CANDIDATE' && nowMs >= toMs(credential.candidateUntil)) next = { to: 'EXPIRED', code: 'T3', reason: 'CANDIDATE_TERM_ENDED' };
      else if (head.state === 'SUSPENDED' && nowMs >= toMs(head.effectiveAt) + profile.suspensionRevocationSeconds * 1000) next = { to: 'REVOKED', code: 'T6', reason: 'SUSPENSION_TIMEOUT' };
      if (next === null) return head;
      const signed = transition(loaded, {
        transitionId: newIdentifier(random, 'trn'),
        to: next.to,
        transitionCode: next.code,
        reasonCode: next.reason,
        ruleId: `${next.code}-TIME`,
        evaluationId: null,
        evaluationDigest: null,
        evidenceIds: [],
        humanDecisions: [],
        actionBindingDigest: null,
        remediationDigest: null,
        effectiveAt: now,
      });
      storeCall(() => store.commitTransition({ evaluation: null, decisions: [], transition: signed }));
      return headOf(organizationId, credentialId);
    },
  });
}
