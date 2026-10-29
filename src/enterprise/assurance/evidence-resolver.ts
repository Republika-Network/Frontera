import type { GovernanceStore } from '../governance-store/governance-store.js';
import type { EvidenceStore } from '../evidence/evidence-store.js';
import { verifyEvidenceBundle } from '../evidence/verifier.js';
import type { AgentPassportStore } from '../passport/passport-store.js';
import { AssuranceError } from './errors.js';
import type {
  AssuranceAccessContext,
  AssuranceEvidenceContradiction,
  AssuranceEvidenceReference,
  AssuranceEvidenceRejectionCode,
  AssuranceEvidenceRequirement,
  AssuranceEvidenceResolution,
  AssuranceEvidenceType,
  AssuranceRejectedEvidence,
  AssuranceScope,
} from './contracts.js';
import { ASSURANCE_RESOLVER_VERSION } from './contracts.js';
import { MANUAL_EVIDENCE_TYPES, asSuppliedManualReference, isHostVerified, manualMetricNameViolation } from './manual-evidence-trust.js';

/**
 * The Assurance Evidence Resolver (mission section 14): turns one evidence
 * requirement plus one immutable assessment scope into accepted and
 * rejected evidence *references* -- never copies. It consults only the
 * public contracts of the Governance Store, Evidence Bundle Store, Agent
 * Passport Store, and an injected runtime-health snapshot; it executes no
 * SQL of its own and copies no aggregate.
 *
 * Determinism: every age check is measured against the scope's
 * `evidenceCutoffAt`, never the wall clock, so re-resolving the same scope
 * over the same stores yields the same resolutions.
 */

/** A bounded, injected observation of Enterprise/module health used as `enterprise_health` / `module_health` / `lifecycle_event` evidence. */
export interface AssuranceRuntimeHealthSnapshot {
  readonly ready: boolean;
  readonly lifecycleState: string;
  readonly modules: readonly { readonly moduleId: string; readonly version: string; readonly status: string }[];
  readonly observedAt: string;
}

export interface AssuranceEvidenceSources {
  readonly governanceStore?: GovernanceStore;
  readonly evidenceStore?: EvidenceStore;
  readonly passportStore?: AgentPassportStore;
  readonly runtimeHealth?: () => Promise<AssuranceRuntimeHealthSnapshot>;
}

export interface AssuranceEvidenceResolver {
  resolve(scope: AssuranceScope, requirement: AssuranceEvidenceRequirement, context: AssuranceAccessContext): Promise<AssuranceEvidenceResolution>;
}

export interface CreateEvidenceResolverOptions {
  readonly sources: AssuranceEvidenceSources;
  /** Manually supplied evidence references (`control_attestation` / `external_artifact_reference` / `passport_view`); accepted only where the requirement allows manual evidence. */
  readonly manualEvidence?: readonly AssuranceEvidenceReference[];
  readonly now: () => string;
  readonly nextId: (prefix: string) => string;
  /** Bounded candidate window per requirement -- the resolver never sweeps an unbounded history. */
  readonly maxCandidatesPerType?: number;
}

export { MANUAL_EVIDENCE_TYPES };

const DAY_MS = 24 * 60 * 60 * 1000;

interface Candidate {
  readonly reference: AssuranceEvidenceReference;
  /** Codes already known at gathering time (e.g. digest mismatch discovered against the source store). */
  readonly gatheringRejections: readonly AssuranceEvidenceRejectionCode[];
  readonly gatheringDetail?: string;
}

function requireTenantScope(context: AssuranceAccessContext): void {
  if (!context.system && (context.organizationId === undefined || context.organizationId.length === 0)) {
    throw new AssuranceError('ASSURANCE_TENANT_SCOPE_REQUIRED', 'A non-system caller must provide an organization scope for Assurance evidence resolution.');
  }
}

export function createAssuranceEvidenceResolver(options: CreateEvidenceResolverOptions): AssuranceEvidenceResolver {
  const { sources, now, nextId } = options;
  const manualEvidence = options.manualEvidence ?? [];
  const maxCandidates = options.maxCandidatesPerType ?? 50;

  async function gatherGovernanceRecords(scope: AssuranceScope, context: AssuranceAccessContext, unavailable: string[]): Promise<Candidate[]> {
    if (sources.governanceStore === undefined) {
      unavailable.push('governance_record');
      return [];
    }
    try {
      const storeContext = { organizationId: scope.subject.organizationId, system: context.system };
      const isAgentSubject = scope.subject.subjectType === 'agent' || scope.subject.subjectType === 'passport';
      const result = await sources.governanceStore.query(storeContext, {
        organizationId: scope.subject.organizationId,
        ...(isAgentSubject ? { actorId: scope.subject.subjectId } : {}),
        ...(scope.from !== undefined && !scope.includeHistoricalEvidence ? { from: scope.from } : {}),
        to: scope.evidenceCutoffAt,
        limit: maxCandidates,
      });
      const candidates: Candidate[] = [];
      for (const summary of result.records) {
        const verification = await sources.governanceStore.verify(storeContext, summary.evaluationId).catch(() => null);
        candidates.push({
          reference: {
            evidenceReferenceId: nextId('assurance-evidence'),
            evidenceType: 'governance_record',
            externalId: summary.evaluationId,
            organizationId: summary.organizationId ?? scope.subject.organizationId,
            subjectId: summary.actorId,
            digest: summary.aggregateDigest,
            occurredAt: summary.evaluatedAt,
            collectedAt: now(),
            verified: verification?.valid === true,
            ...(verification?.valid === true ? { verificationReference: `governance-verify:${summary.evaluationId}` } : {}),
            provenance: {
              sourceSystem: 'aoc.enterprise.governance-store',
              sourceType: 'governance_record',
              collectedBy: 'aoc.assurance.evidence-resolver',
              collectedAt: now(),
              originalDigest: summary.aggregateDigest,
            },
            metadata: { status: summary.status, actionType: summary.actionType, reasonCodes: summary.reasonCodes },
          },
          gatheringRejections: verification !== null && !verification.valid ? ['EVIDENCE_DIGEST_MISMATCH'] : [],
          ...(verification !== null && !verification.valid ? { gatheringDetail: 'Stored Governance Record failed integrity verification.' } : {}),
        });
      }
      return candidates;
    } catch {
      unavailable.push('governance_record');
      return [];
    }
  }

  async function gatherEvidenceBundles(scope: AssuranceScope, context: AssuranceAccessContext, governanceCandidates: readonly Candidate[], unavailable: string[]): Promise<Candidate[]> {
    if (sources.evidenceStore === undefined) {
      unavailable.push('evidence_bundle');
      return [];
    }
    try {
      const storeContext = { organizationId: scope.subject.organizationId, system: context.system };
      const candidates: Candidate[] = [];
      const seenBundleIds = new Set<string>();

      const evaluationIds = governanceCandidates.map((candidate) => candidate.reference.externalId);
      for (const evaluationId of evaluationIds.slice(0, maxCandidates)) {
        const records = await sources.evidenceStore.listByEvaluationId(storeContext, evaluationId);
        for (const record of records) {
          if (seenBundleIds.has(record.bundle.bundleId)) continue;
          seenBundleIds.add(record.bundle.bundleId);
          const verification = verifyEvidenceBundle(record.bundle, { now });
          candidates.push({
            reference: {
              evidenceReferenceId: nextId('assurance-evidence'),
              evidenceType: 'evidence_bundle',
              externalId: record.bundle.bundleId,
              organizationId: record.bundle.source.organizationId ?? scope.subject.organizationId,
              ...(scope.subject.subjectType === 'agent' || scope.subject.subjectType === 'passport' ? { subjectId: scope.subject.subjectId } : {}),
              digest: record.bundle.integrity.bundleDigest,
              version: record.bundle.bundleVersion,
              occurredAt: record.bundle.createdAt,
              collectedAt: now(),
              verified: verification.valid,
              ...(verification.valid ? { verificationReference: `evidence-verify:${record.bundle.bundleId}` } : {}),
              provenance: {
                sourceSystem: 'aoc.enterprise.evidence',
                sourceType: 'evidence_bundle',
                collectedBy: 'aoc.assurance.evidence-resolver',
                collectedAt: now(),
                originalDigest: record.bundle.integrity.bundleDigest,
                disclosurePolicy: record.bundle.disclosure.level,
              },
              metadata: { state: record.state, evaluationId: record.bundle.source.evaluationId },
            },
            gatheringRejections: verification.valid ? [] : ['EVIDENCE_DIGEST_MISMATCH'],
            ...(verification.valid ? {} : { gatheringDetail: 'Evidence Bundle failed structural verification.' }),
          });
        }
      }
      return candidates;
    } catch {
      unavailable.push('evidence_bundle');
      return [];
    }
  }

  async function gatherPassports(scope: AssuranceScope, context: AssuranceAccessContext, unavailable: string[]): Promise<Candidate[]> {
    if (sources.passportStore === undefined) {
      unavailable.push('agent_passport');
      return [];
    }
    try {
      const storeContext = { organizationId: scope.subject.organizationId, system: false } as const;
      void context;
      let passportId = scope.subject.passportId;
      if (passportId === undefined && (scope.subject.subjectType === 'agent' || scope.subject.subjectType === 'passport')) {
        if (scope.subject.subjectType === 'passport') {
          passportId = scope.subject.subjectId;
        } else {
          const passport = await sources.passportStore.findByAgentId(storeContext, scope.subject.subjectId);
          passportId = passport?.passportId;
        }
      }
      if (passportId === undefined) return [];

      const load = await sources.passportStore.reconstruct(storeContext, passportId);
      if (load.status !== 'complete' || load.passport === undefined) {
        return [];
      }
      const verification = await sources.passportStore.verify(storeContext, passportId);
      const passport = load.passport;
      return [
        {
          reference: {
            evidenceReferenceId: nextId('assurance-evidence'),
            evidenceType: 'agent_passport',
            externalId: passport.passportId,
            organizationId: passport.organization.organizationId,
            subjectId: passport.subject.agentId,
            digest: passport.integrity.latestEventDigest,
            version: passport.passportVersion,
            occurredAt: passport.lifecycle.enteredAt,
            collectedAt: now(),
            verified: verification.valid,
            ...(verification.valid ? { verificationReference: `passport-verify:${passport.passportId}` } : {}),
            provenance: {
              sourceSystem: 'aoc.enterprise.agent-passport',
              sourceType: 'agent_passport',
              collectedBy: 'aoc.assurance.evidence-resolver',
              collectedAt: now(),
              originalDigest: passport.integrity.latestEventDigest,
            },
            metadata: {
              status: passport.status,
              chainValid: verification.checks.eventChain,
              lifecycleValid: verification.checks.lifecycle,
              governanceReferenceCount: passport.governanceReferences.length,
              evidenceReferenceCount: passport.evidenceReferences.length,
            },
          },
          gatheringRejections: [],
        },
      ];
    } catch {
      unavailable.push('agent_passport');
      return [];
    }
  }

  async function gatherRuntimeHealth(scope: AssuranceScope, evidenceType: AssuranceEvidenceType, unavailable: string[]): Promise<Candidate[]> {
    if (sources.runtimeHealth === undefined) {
      unavailable.push(evidenceType);
      return [];
    }
    try {
      const snapshot = await sources.runtimeHealth();
      const collectedAt = now();
      const provenance = {
        sourceSystem: 'aoc.enterprise.lifecycle',
        sourceType: evidenceType,
        collectedBy: 'aoc.assurance.evidence-resolver',
        collectedAt,
      } as const;
      if (evidenceType === 'enterprise_health') {
        return [
          {
            reference: {
              evidenceReferenceId: nextId('assurance-evidence'),
              evidenceType,
              externalId: 'enterprise',
              organizationId: scope.subject.organizationId,
              occurredAt: snapshot.observedAt,
              collectedAt,
              verified: true,
              provenance,
              metadata: { ready: snapshot.ready, lifecycleState: snapshot.lifecycleState },
            },
            gatheringRejections: [],
          },
        ];
      }
      if (evidenceType === 'module_health') {
        return snapshot.modules.map((module) => ({
          reference: {
            evidenceReferenceId: nextId('assurance-evidence'),
            evidenceType,
            externalId: module.moduleId,
            organizationId: scope.subject.organizationId,
            occurredAt: snapshot.observedAt,
            collectedAt,
            verified: true,
            provenance,
            metadata: { status: module.status, version: module.version },
          },
          gatheringRejections: [],
        }));
      }
      // lifecycle_event: a bounded observation of the current lifecycle state.
      return [
        {
          reference: {
            evidenceReferenceId: nextId('assurance-evidence'),
            evidenceType,
            externalId: `lifecycle:${snapshot.lifecycleState}`,
            organizationId: scope.subject.organizationId,
            occurredAt: snapshot.observedAt,
            collectedAt,
            verified: true,
            provenance,
            metadata: { lifecycleState: snapshot.lifecycleState },
          },
          gatheringRejections: [],
        },
      ];
    } catch {
      unavailable.push(evidenceType);
      return [];
    }
  }

  /**
   * Manually supplied evidence (ASSURE-SEC-01C, `manual-evidence-trust.ts`):
   * offered only to the requirements it names in `requirementIds` (bound
   * elsewhere, it is not a candidate here at all); rejected when it names
   * none; carried with `verified: false` and its supplier's verification
   * claims kept apart; and rejected when an attestation asserts a metric
   * name that is not canonical or that is reserved for Host-derived metrics.
   */
  function gatherManualEvidence(requirement: AssuranceEvidenceRequirement): Candidate[] {
    const candidates: Candidate[] = [];
    for (const supplied of manualEvidence) {
      if (!MANUAL_EVIDENCE_TYPES.includes(supplied.evidenceType)) continue;
      const boundTo = supplied.requirementIds ?? [];
      if (boundTo.length > 0 && !boundTo.includes(requirement.requirementId)) continue;
      const reference = asSuppliedManualReference(supplied);
      const codes: AssuranceEvidenceRejectionCode[] = [];
      const details: string[] = [];
      if (requirement.manualEvidenceAllowed !== true) {
        codes.push('EVIDENCE_TYPE_NOT_ACCEPTED');
        details.push('This requirement does not allow manually supplied evidence.');
      }
      if (boundTo.length === 0) {
        codes.push('EVIDENCE_NOT_BOUND');
        details.push('Manually supplied evidence must name the requirement(s) it is offered for in requirementIds.');
      }
      const metric = reference.evidenceType === 'control_attestation' ? reference.metadata?.['metric'] : undefined;
      const metricViolation = metric === undefined ? undefined : manualMetricNameViolation(metric);
      if (metricViolation !== undefined) {
        codes.push('EVIDENCE_METRIC_NOT_PERMITTED');
        details.push(
          metricViolation === 'reserved_namespace'
            ? 'The attested metric lies in a namespace reserved for Host-derived metrics; an attestation cannot set it.'
            : 'The attested metric name is not canonical (lower-case ASCII segments separated by single dots).',
        );
      }
      candidates.push({ reference, gatheringRejections: codes, ...(details.length > 0 ? { gatheringDetail: details.join(' ') } : {}) });
    }
    return candidates;
  }

  return {
    async resolve(scope, requirement, context) {
      requireTenantScope(context);
      if (!context.system && context.organizationId !== scope.subject.organizationId) {
        throw new AssuranceError(
          'ASSURANCE_ACCESS_SCOPE_VIOLATION',
          `The caller is not authorized to resolve Assurance evidence for organization '${scope.subject.organizationId}'.`,
        );
      }

      const unavailableSources: string[] = [];
      const candidates: Candidate[] = [];

      const wantsGovernance = requirement.acceptedEvidenceTypes.includes('governance_record');
      const wantsBundles = requirement.acceptedEvidenceTypes.includes('evidence_bundle');
      const governanceCandidates = wantsGovernance || wantsBundles ? await gatherGovernanceRecords(scope, context, wantsGovernance ? unavailableSources : []) : [];
      if (wantsGovernance) candidates.push(...governanceCandidates);
      if (wantsBundles) candidates.push(...(await gatherEvidenceBundles(scope, context, governanceCandidates, unavailableSources)));
      if (requirement.acceptedEvidenceTypes.includes('agent_passport')) candidates.push(...(await gatherPassports(scope, context, unavailableSources)));
      for (const healthType of ['enterprise_health', 'module_health', 'lifecycle_event'] as const) {
        if (requirement.acceptedEvidenceTypes.includes(healthType)) candidates.push(...(await gatherRuntimeHealth(scope, healthType, unavailableSources)));
      }
      if (MANUAL_EVIDENCE_TYPES.some((manualType) => requirement.acceptedEvidenceTypes.includes(manualType))) {
        candidates.push(...gatherManualEvidence(requirement));
      }

      // -- Validation pipeline: accept or reject every candidate with stable codes.
      const accepted: AssuranceEvidenceReference[] = [];
      const rejected: AssuranceRejectedEvidence[] = [];
      const cutoffMs = Date.parse(scope.evidenceCutoffAt);

      for (const candidate of candidates) {
        const reference = candidate.reference;
        const codes: AssuranceEvidenceRejectionCode[] = [...candidate.gatheringRejections];
        const details: string[] = candidate.gatheringDetail !== undefined ? [candidate.gatheringDetail] : [];

        if (!requirement.acceptedEvidenceTypes.includes(reference.evidenceType)) {
          codes.push('EVIDENCE_TYPE_NOT_ACCEPTED');
          details.push(`Evidence type '${reference.evidenceType}' is not accepted by requirement '${requirement.requirementId}'.`);
        }
        if (reference.organizationId !== scope.subject.organizationId) {
          codes.push('EVIDENCE_WRONG_TENANT');
          details.push(`Evidence is bound to organization '${reference.organizationId}', not '${scope.subject.organizationId}'.`);
        }
        if (requirement.mustReferenceSubject === true) {
          const boundToSubject = reference.subjectId === scope.subject.subjectId || (scope.subject.passportId !== undefined && reference.subjectId === scope.subject.passportId);
          if (!boundToSubject) {
            codes.push('EVIDENCE_WRONG_SUBJECT');
            details.push(`Evidence subject '${reference.subjectId ?? 'absent'}' does not reference assessment subject '${scope.subject.subjectId}'.`);
          }
        }
        if (requirement.mustBeVerified === true && !isHostVerified(reference)) {
          codes.push('EVIDENCE_UNVERIFIED');
          details.push('The requirement demands verified evidence and this reference is unverified.');
        }
        if (requirement.mustBeOrganizationBound === true && reference.organizationId.length === 0) {
          codes.push('EVIDENCE_WRONG_TENANT');
          details.push('The requirement demands organization-bound evidence.');
        }
        if (requirement.requiredDisclosureLevels !== undefined && requirement.requiredDisclosureLevels.length > 0) {
          const disclosure = reference.provenance.disclosurePolicy;
          if (disclosure === undefined || !requirement.requiredDisclosureLevels.includes(disclosure)) {
            codes.push('EVIDENCE_DISCLOSURE_INSUFFICIENT');
            details.push(`Disclosure level '${disclosure ?? 'absent'}' is not one of [${requirement.requiredDisclosureLevels.join(', ')}].`);
          }
        }

        const occurredAtMs = reference.occurredAt !== undefined ? Date.parse(reference.occurredAt) : Number.NaN;
        if (!Number.isNaN(occurredAtMs) && !Number.isNaN(cutoffMs)) {
          if (occurredAtMs > cutoffMs) {
            codes.push('EVIDENCE_INCOMPLETE');
            details.push(`Evidence occurred at '${reference.occurredAt}', after the evidence cutoff '${scope.evidenceCutoffAt}'.`);
          }
          if (requirement.maximumAgeDays !== undefined && cutoffMs - occurredAtMs > requirement.maximumAgeDays * DAY_MS) {
            codes.push('EVIDENCE_TOO_OLD');
            details.push(`Evidence is older than ${requirement.maximumAgeDays} day(s) at the evidence cutoff.`);
          }
          if (scope.from !== undefined && !scope.includeHistoricalEvidence && occurredAtMs < Date.parse(scope.from)) {
            codes.push('EVIDENCE_TOO_OLD');
            details.push(`Evidence occurred before the assessment period start '${scope.from}' and historical evidence is excluded.`);
          }
        } else if (requirement.maximumAgeDays !== undefined) {
          codes.push('EVIDENCE_INCOMPLETE');
          details.push('Evidence carries no usable occurredAt timestamp, so its age cannot be validated.');
        }

        if (codes.length > 0) {
          rejected.push({ evidenceReference: reference, reasonCodes: [...new Set(codes)], detail: details.join(' ') });
        } else {
          accepted.push(reference);
        }
      }

      // -- Deterministic contradiction detection (mission section 61): two
      // accepted references naming the same source artifact with different
      // digests contradict each other.
      const contradictions: AssuranceEvidenceContradiction[] = [];
      const byArtifact = new Map<string, AssuranceEvidenceReference[]>();
      for (const reference of accepted) {
        const key = `${reference.evidenceType}::${reference.externalId}`;
        byArtifact.set(key, [...(byArtifact.get(key) ?? []), reference]);
      }
      for (const [artifact, references] of byArtifact) {
        const digests = new Set(references.map((reference) => reference.digest).filter((digest): digest is string => digest !== undefined));
        if (digests.size > 1) {
          contradictions.push({
            evidenceReferenceIds: references.map((reference) => reference.evidenceReferenceId),
            reason: `Accepted evidence references for '${artifact}' carry ${digests.size} different digests.`,
            appliedPolicy: requirement.contradictionPolicy ?? 'manual_review',
          });
        }
      }

      const missingEvidence: string[] = [];
      const minimumCount = requirement.minimumCount ?? 1;
      if (accepted.length < minimumCount) {
        missingEvidence.push(
          `Requirement '${requirement.requirementId}' (${requirement.description}) needs at least ${minimumCount} accepted evidence reference(s) of type [${requirement.acceptedEvidenceTypes.join(', ')}]; ${accepted.length} accepted.`,
        );
      }
      for (const source of unavailableSources) {
        missingEvidence.push(`Evidence source for type '${source}' was unavailable during resolution.`);
      }

      const status =
        accepted.length >= minimumCount
          ? 'satisfied'
          : accepted.length > 0
            ? 'partially_satisfied'
            : unavailableSources.length > 0
              ? 'unavailable'
              : 'unsatisfied';

      return {
        requirementId: requirement.requirementId,
        status,
        acceptedEvidence: accepted,
        rejectedEvidence: rejected,
        missingEvidence,
        contradictions,
        resolvedAt: now(),
        resolverVersion: ASSURANCE_RESOLVER_VERSION,
      };
    },
  };
}
