import type { EnterpriseConfiguration } from '../configuration/enterprise-configuration.js';
import type { GovernanceStoreAccessContext } from '../governance-store/contracts.js';
import type { GovernanceStore } from '../governance-store/governance-store.js';
import { resolveGovernanceAccessContext } from '../orchestration/governance-read-service.js';
import { EVIDENCE_BUNDLE_SCHEMA_VERSION_V2 } from './contracts.js';
import { getDisclosurePolicy } from './disclosure-policies.js';
import { EvidenceError } from './errors.js';
import { EVIDENCE_PROJECTION_ENGINE_VERSION_V2, buildEvidenceBundle, buildEvidenceBundleV2 } from './projector.js';
import { authorityTraceVerificationOf, buildAuthorityTrace, validateTraceRequestId, type AuthorityTraceBuild, type AuthorityTraceSources } from './trace-builder.js';
import type { AuthorityTraceVerification } from './trace-contracts.js';
import { discloseAuthorityTrace, discloseTraceVerification, disclosedTraceDigest, findDisclosurePolicyV2ById, getDisclosurePolicyV2, type DisclosedAuthorityTrace, type DisclosurePolicyV2 } from './trace-disclosure.js';
import { verifyEvidenceBundle, type EvidenceBundleCurrentTrace } from './verifier.js';
import type { EvidenceStore } from './evidence-store.js';
import type { EvidenceBundleRecord, EvidenceDisclosureMetadata, EvidenceReference, EvidenceVerificationResult } from './contracts.js';

/**
 * The Evidence Bundle orchestration surface (mission section "Verification
 * API" / "Lifecycle": `Governance Record -> Bundle Generated -> Bundle
 * Stored -> Bundle Verified -> Bundle Exported`). This is what HTTP handlers
 * and embedders call -- neither builds a Bundle nor touches the Governance
 * Store or Bundle Store directly. Tenant scoping is resolved from the
 * caller's credential exactly the way `GovernanceReadService` does, so an
 * Evidence Bundle can never be built from, or read from, a Governance
 * Record outside the caller's own scope.
 *
 * ASSURE-01 adds the per-request Unified Authority-to-Outcome Trace: fetched
 * and verified live over the canonical stores (`getTrace`, `verifyTrace` —
 * pure reads, nothing written anywhere), and sealed into a v2 bundle by
 * `build({ requestId, level })`. A v1 build (`{ evaluationId, level }`) is
 * exactly what it always was.
 */
export interface BuildEvidenceBundleInput {
  /** v1: one Governance Record's bundle. Exactly one of `evaluationId` / `requestId`. */
  readonly evaluationId?: string;
  /** v2 (ASSURE-01): one governed request's trace-bearing bundle. */
  readonly requestId?: string;
  readonly level: string;
  readonly createdBy?: string;
  readonly references?: readonly EvidenceReference[];
}

/** The fetched trace, disclosed under the requested level. */
export interface DisclosedAuthorityTraceView {
  readonly requestId: string;
  readonly disclosure: EvidenceDisclosureMetadata;
  readonly trace: DisclosedAuthorityTrace;
  /** Digest of exactly the disclosed trace above. */
  readonly traceDigest: string;
  readonly generatedAt: string;
}

export interface EvidenceService {
  build(authorizationHeader: string | undefined, input: BuildEvidenceBundleInput): Promise<EvidenceBundleRecord>;
  getByBundleId(authorizationHeader: string | undefined, bundleId: string): Promise<EvidenceBundleRecord | null>;
  listByEvaluationId(authorizationHeader: string | undefined, evaluationId: string): Promise<readonly EvidenceBundleRecord[]>;
  listByDecisionId(authorizationHeader: string | undefined, decisionId: string): Promise<readonly EvidenceBundleRecord[]>;
  verify(authorizationHeader: string | undefined, bundleId: string): Promise<EvidenceVerificationResult>;
  /** ASSURE-01: one governed request's trace, disclosed at `level`. A pure read. */
  getTrace(authorizationHeader: string | undefined, requestId: string, level: string): Promise<DisclosedAuthorityTraceView>;
  /** ASSURE-01: the structured verification of one governed request's canonical trace. A pure read. */
  verifyTrace(authorizationHeader: string | undefined, requestId: string): Promise<AuthorityTraceVerification>;
}

export interface EvidenceServiceDependencies {
  readonly governanceStore: GovernanceStore;
  readonly evidenceStore: EvidenceStore;
  readonly configuration: EnterpriseConfiguration;
  readonly now: () => string;
  readonly nextId: (prefix: string) => string;
  /** ASSURE-01: the read-only canonical sources a trace is built from. Defaults to the Governance Store alone (every other stage `not-composed`). */
  readonly traceSources?: AuthorityTraceSources;
}

/**
 * FULL is internal (`disclosure-policies.ts`): an organization-scoped
 * credential — a third party's — receives at most AUDITOR for a trace or a v2
 * bundle; only a system-scope credential may ask for FULL. (v1 builds keep
 * their original semantics.)
 */
function permittedPolicyV2(context: GovernanceStoreAccessContext, level: string): DisclosurePolicyV2 {
  const policy = getDisclosurePolicyV2(level);
  if (policy.level === 'FULL' && !context.system) {
    throw new EvidenceError('EVIDENCE_DISCLOSURE_NOT_PERMITTED', 'FULL disclosure is internal; an organization-scoped credential may request at most AUDITOR.');
  }
  return policy;
}

function disclosureOf(policy: DisclosurePolicyV2): EvidenceDisclosureMetadata {
  return { level: policy.level, policyId: policy.policyId, policyVersion: policy.version, visibleFields: policy.visibleFields, hiddenFields: policy.hiddenFields, redactedFields: policy.redactedFields };
}

export function createEvidenceService(deps: EvidenceServiceDependencies): EvidenceService {
  const { governanceStore, evidenceStore, configuration, now, nextId } = deps;
  const traceSources: AuthorityTraceSources = deps.traceSources ?? { governance: governanceStore };

  async function requireTrace(context: GovernanceStoreAccessContext, requestId: string): Promise<AuthorityTraceBuild> {
    const build = await buildAuthorityTrace(traceSources, context, requestId);
    if (build === null) throw new EvidenceError('EVIDENCE_TRACE_NOT_FOUND', `No governed request '${requestId}' within this scope.`);
    return build;
  }

  async function buildV2(context: GovernanceStoreAccessContext, input: BuildEvidenceBundleInput & { readonly requestId: string }): Promise<EvidenceBundleRecord> {
    const requestId = validateTraceRequestId(input.requestId);
    const policy = permittedPolicyV2(context, input.level);
    const build = await requireTrace(context, requestId);
    const organizationId = build.trace.organizationId;
    const disclosed = discloseAuthorityTrace(build.trace, policy);
    const traceDigest = disclosedTraceDigest(disclosed);
    // Idempotent: the same disclosure of an unchanged trace is the bundle already
    // stored, not a new one. A changed trace supersedes the earlier bundle of
    // the same request and policy — never rewrites it.
    const earlier = (await evidenceStore.listByRequestId({ system: false, organizationId }, requestId)).filter(
      (entry) => entry.bundle.bundleVersion === EVIDENCE_BUNDLE_SCHEMA_VERSION_V2 && entry.bundle.disclosure.policyId === policy.policyId && entry.state !== 'SUPERSEDED',
    );
    const createdBy = input.createdBy ?? EVIDENCE_PROJECTION_ENGINE_VERSION_V2;
    const same = earlier.find(
      (entry) =>
        entry.bundle.integrity.traceDigest === traceDigest &&
        entry.bundle.integrity.recordDigest === build.record.integrity.aggregateDigest &&
        entry.bundle.verification.createdBy === createdBy &&
        JSON.stringify(entry.bundle.references) === JSON.stringify(input.references ?? []),
    );
    if (same !== undefined) return same;
    const bundle = buildEvidenceBundleV2(build.record, build.trace, policy, {
      now,
      nextId,
      ...(input.createdBy !== undefined ? { createdBy: input.createdBy } : {}),
      ...(input.references !== undefined ? { references: input.references } : {}),
    });
    // Every still-active bundle of this request and policy is superseded inside the store's own write transaction.
    return evidenceStore.store(bundle, { organizationId, supersedeActive: true });
  }

  return {
    async build(authorizationHeader, input) {
      const context = resolveGovernanceAccessContext(authorizationHeader, configuration);
      if (typeof input.level !== 'string' || input.level.length === 0) {
        throw new EvidenceError('EVIDENCE_VALIDATION_ERROR', 'level is required.');
      }
      const hasEvaluation = input.evaluationId !== undefined;
      const hasRequest = input.requestId !== undefined;
      if (hasEvaluation === hasRequest) {
        throw new EvidenceError('EVIDENCE_VALIDATION_ERROR', 'Exactly one of evaluationId (v1 bundle) or requestId (v2 trace bundle) is required.');
      }
      if (hasRequest) return buildV2(context, { ...input, requestId: input.requestId as string });
      if (typeof input.evaluationId !== 'string' || input.evaluationId.length === 0) {
        throw new EvidenceError('EVIDENCE_VALIDATION_ERROR', 'evaluationId is required.');
      }
      const policy = getDisclosurePolicy(input.level);
      const record = await governanceStore.getByEvaluationId(context, input.evaluationId);
      if (record === null) {
        throw new EvidenceError('EVIDENCE_SOURCE_RECORD_NOT_FOUND', `No Governance Record for evaluationId '${input.evaluationId}' within this scope.`);
      }
      const bundle = buildEvidenceBundle(record, policy, {
        now,
        nextId,
        ...(input.createdBy !== undefined ? { createdBy: input.createdBy } : {}),
        ...(input.references !== undefined ? { references: input.references } : {}),
      });
      return evidenceStore.store(bundle, record.request.organizationId !== undefined ? { organizationId: record.request.organizationId } : {});
    },

    async getByBundleId(authorizationHeader, bundleId) {
      const context = resolveGovernanceAccessContext(authorizationHeader, configuration);
      return evidenceStore.getByBundleId(context, bundleId);
    },

    async listByEvaluationId(authorizationHeader, evaluationId) {
      const context = resolveGovernanceAccessContext(authorizationHeader, configuration);
      return evidenceStore.listByEvaluationId(context, evaluationId);
    },

    async listByDecisionId(authorizationHeader, decisionId) {
      const context = resolveGovernanceAccessContext(authorizationHeader, configuration);
      return evidenceStore.listByDecisionId(context, decisionId);
    },

    async verify(authorizationHeader, bundleId) {
      const context = resolveGovernanceAccessContext(authorizationHeader, configuration);
      const stored = await evidenceStore.getByBundleId(context, bundleId);
      if (stored === null) {
        throw new EvidenceError('EVIDENCE_BUNDLE_NOT_FOUND', `No Evidence Bundle for bundleId '${bundleId}' within this scope.`);
      }
      let result: EvidenceVerificationResult;
      if (stored.bundle.bundleVersion === EVIDENCE_BUNDLE_SCHEMA_VERSION_V2) {
        // The bundle is checked against the canonical records as they stand now,
        // read in the caller's own scope.
        let current: EvidenceBundleCurrentTrace | undefined;
        let record;
        const policy = findDisclosurePolicyV2ById(stored.bundle.disclosure.policyId);
        try {
          const build = await buildAuthorityTrace(traceSources, context, stored.bundle.source.requestId);
          if (build !== null) {
            record = build.record;
            if (policy !== undefined) current = { disclosed: discloseAuthorityTrace(build.trace, policy), verification: discloseTraceVerification(authorityTraceVerificationOf(build, now()), policy) };
          }
        } catch {
          current = undefined;
        }
        result = verifyEvidenceBundle(stored.bundle, { ...(record !== undefined ? { record } : {}), now, ...(current !== undefined ? { currentTrace: current } : {}) });
      } else {
        let sourceRecord;
        try {
          sourceRecord = await governanceStore.getByEvaluationId(context, stored.bundle.source.evaluationId);
        } catch {
          sourceRecord = null;
        }
        result = verifyEvidenceBundle(stored.bundle, { ...(sourceRecord !== null ? { record: sourceRecord } : {}), now });
      }
      if (result.valid) {
        await evidenceStore.markVerified(bundleId);
      }
      return result;
    },

    async getTrace(authorizationHeader, requestId, level) {
      const context = resolveGovernanceAccessContext(authorizationHeader, configuration);
      validateTraceRequestId(requestId);
      const policy = permittedPolicyV2(context, level);
      const build = await requireTrace(context, requestId);
      const trace = discloseAuthorityTrace(build.trace, policy);
      return { requestId, disclosure: disclosureOf(policy), trace, traceDigest: disclosedTraceDigest(trace), generatedAt: now() };
    },

    async verifyTrace(authorizationHeader, requestId) {
      const context = resolveGovernanceAccessContext(authorizationHeader, configuration);
      const build = await requireTrace(context, requestId);
      return authorityTraceVerificationOf(build, now());
    },
  };
}
