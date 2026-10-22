import type { GovernanceStore } from '../governance-store/governance-store.js';
import type { EvidenceStore } from '../evidence/evidence-store.js';
import type { EnterpriseTelemetry } from '../telemetry/enterprise-telemetry.js';
import { computeDigest } from '../governance-store/digest.js';
import { AgentPassportError, isAgentPassportError } from './errors.js';
import { buildAgentPassportView } from './disclosure.js';
import { computePassportHistorySummary } from './reconstruction.js';
import { verifyAgentPassport } from './verification.js';
import type { AgentPassportStore } from './passport-store.js';
import {
  AOC_AGENT_PASSPORT_RUNTIME_VERSION,
  type AgentAuthorityReference,
  type AgentCapabilityReference,
  type AgentDelegationReference,
  type AgentPassport,
  type AgentPassportEvent,
  type AgentPassportHistorySummary,
  type AgentPassportLoadResult,
  type AgentPassportOrganizationBinding,
  type AgentPassportSubject,
  type AgentPassportVerificationMode,
  type AgentPassportVerificationResult,
  type AgentPassportView,
  type PassportAccessContext,
  type PassportEvidenceReference,
  type PassportGovernanceReference,
} from './contracts.js';

/**
 * The Agent Passport orchestration surface (mission section 40) -- what
 * HTTP handlers and embedders call. Neither builds a Passport by hand nor
 * touches `AgentPassportStore` internals directly; every mutation is
 * "append an event, then reconstruct," exactly like `EvidenceService` sits
 * atop the Bundle Store. Optional `governanceStore`/`evidenceStore`
 * dependencies exist solely for *referential* validation when linking --
 * this module never copies a Governance Record or an Evidence Bundle, and
 * never asks the Kernel anything.
 */
export interface IssueAgentPassportInput {
  readonly subject: AgentPassportSubject;
  readonly organization: Omit<AgentPassportOrganizationBinding, 'boundAt'> & { readonly boundAt?: string };
  readonly actorId: string;
  readonly actorType?: string;
  readonly activateImmediately?: boolean;
  readonly capabilities?: readonly AgentCapabilityReference[];
  readonly authorities?: readonly AgentAuthorityReference[];
  readonly delegations?: readonly AgentDelegationReference[];
  readonly sourceIdentityRecord?: string;
  readonly idempotencyKey?: string;
}

export interface IssueAgentPassportResult {
  readonly passport: AgentPassport;
  /** `false` when an identical prior issuance (same organization, idempotency key, and subject) was replayed instead of appending a new event. */
  readonly created: boolean;
}

export interface SuspendAgentPassportInput {
  readonly suspendedBy: string;
  readonly reason?: string;
  readonly expectedReviewAt?: string;
  readonly evidenceBundleId?: string;
}

export interface RevokeAgentPassportInput {
  readonly reasonCode: string;
  readonly reason: string;
  readonly revokedBy: string;
  readonly evidenceBundleId?: string;
}

export interface RetireAgentPassportInput {
  readonly retiredBy: string;
  readonly reason?: string;
}

export interface AgentPassportService {
  issuePassport(context: PassportAccessContext, input: IssueAgentPassportInput): Promise<IssueAgentPassportResult>;

  activatePassport(context: PassportAccessContext, passportId: string, actorId: string): Promise<AgentPassport>;
  suspendPassport(context: PassportAccessContext, passportId: string, input: SuspendAgentPassportInput): Promise<AgentPassport>;
  reactivatePassport(context: PassportAccessContext, passportId: string, reactivatedBy: string): Promise<AgentPassport>;
  revokePassport(context: PassportAccessContext, passportId: string, input: RevokeAgentPassportInput): Promise<AgentPassport>;
  retirePassport(context: PassportAccessContext, passportId: string, input: RetireAgentPassportInput): Promise<AgentPassport>;

  referenceCapability(context: PassportAccessContext, passportId: string, reference: AgentCapabilityReference, actorId: string): Promise<AgentPassport>;
  removeCapabilityReference(context: PassportAccessContext, passportId: string, capabilityId: string, actorId: string): Promise<AgentPassport>;
  referenceAuthority(context: PassportAccessContext, passportId: string, reference: AgentAuthorityReference, actorId: string): Promise<AgentPassport>;
  removeAuthorityReference(context: PassportAccessContext, passportId: string, authorityId: string, actorId: string): Promise<AgentPassport>;
  referenceDelegation(context: PassportAccessContext, passportId: string, reference: AgentDelegationReference, actorId: string): Promise<AgentPassport>;
  removeDelegationReference(context: PassportAccessContext, passportId: string, delegationId: string, actorId: string): Promise<AgentPassport>;

  linkGovernanceRecord(context: PassportAccessContext, passportId: string, reference: PassportGovernanceReference, actorId: string): Promise<AgentPassport>;
  linkEvidenceBundle(context: PassportAccessContext, passportId: string, reference: PassportEvidenceReference, actorId: string): Promise<AgentPassport>;

  getPassport(context: PassportAccessContext, passportId: string): Promise<AgentPassportLoadResult>;
  getEvents(context: PassportAccessContext, passportId: string): Promise<readonly AgentPassportEvent[]>;
  getHistorySummary(context: PassportAccessContext, passportId: string): Promise<AgentPassportHistorySummary>;
  findByAgentId(context: PassportAccessContext, agentId: string): Promise<AgentPassport | null>;

  verifyPassport(context: PassportAccessContext, passportId: string, mode?: AgentPassportVerificationMode): Promise<AgentPassportVerificationResult>;
  buildView(context: PassportAccessContext, passportId: string, viewType: string, generatedBy: string): Promise<AgentPassportView>;
}

export interface AgentPassportServiceDependencies {
  readonly store: AgentPassportStore;
  readonly governanceStore?: GovernanceStore;
  readonly evidenceStore?: EvidenceStore;
  readonly telemetry?: EnterpriseTelemetry;
  readonly now: () => string;
  readonly nextId: (prefix: string) => string;
}

function requirePassport(load: AgentPassportLoadResult, passportId: string): AgentPassport {
  if (load.status !== 'complete' || load.passport === undefined) {
    throw new AgentPassportError('PASSPORT_INTEGRITY_FAILED', `Agent Passport '${passportId}' could not be reconstructed (${load.status}).`, {
      missingComponents: load.missingComponents,
      integrityFailures: load.integrityFailures,
    });
  }
  return load.passport;
}

export function createAgentPassportService(deps: AgentPassportServiceDependencies): AgentPassportService {
  const { store, governanceStore, evidenceStore, telemetry, now, nextId } = deps;

  async function currentPassport(context: PassportAccessContext, passportId: string): Promise<AgentPassport> {
    const load = await store.reconstruct(context, passportId);
    telemetry?.recordPassportReconstruction(load.status === 'complete');
    return requirePassport(load, passportId);
  }

  return {
    async issuePassport(context, input) {
      if (input.subject.agentId.length === 0) throw new AgentPassportError('PASSPORT_VALIDATION_ERROR', 'subject.agentId is required.');
      if (input.organization.organizationId.length === 0) throw new AgentPassportError('PASSPORT_VALIDATION_ERROR', 'organization.organizationId is required.');
      if (!context.system && context.organizationId !== input.organization.organizationId) {
        throw new AgentPassportError('PASSPORT_ACCESS_SCOPE_VIOLATION', 'A non-system caller may only issue a Passport within its own organization.');
      }

      const subjectDigest = computeDigest(input.subject);
      const scope = `passport-issue::${input.organization.organizationId}`;

      if (input.idempotencyKey !== undefined) {
        const resolution = await store.resolveIdempotency(context, { idempotency: { idempotencyKey: input.idempotencyKey, scope }, subjectDigest });
        if (resolution.kind === 'conflict') {
          telemetry?.recordPassportIdempotencyConflict();
          throw new AgentPassportError('PASSPORT_IDEMPOTENCY_CONFLICT', `Idempotency key '${input.idempotencyKey}' was already used with a different Passport subject.`);
        }
        if (resolution.kind === 'replay') {
          const passport = await currentPassport(context, resolution.passportId);
          telemetry?.recordPassportIdempotentReplay();
          return { passport, created: false };
        }
      }

      const passportId = nextId('passport');
      const boundAt = input.organization.boundAt ?? now();
      const actorType = input.actorType ?? 'user';

      const createdResult = await store.appendEvent(context, {
        passportId,
        organizationId: input.organization.organizationId,
        eventType: 'AgentPassportCreated',
        payload: {
          subject: { ...input.subject },
          organization: { ...input.organization, boundAt },
          passportVersion: AOC_AGENT_PASSPORT_RUNTIME_VERSION,
          ...(input.sourceIdentityRecord !== undefined ? { sourceIdentityRecord: input.sourceIdentityRecord } : {}),
        },
        actorId: input.actorId,
        actorType,
        ...(input.idempotencyKey !== undefined ? { idempotency: { idempotencyKey: input.idempotencyKey, scope } } : {}),
      });

      let passport = createdResult.passport;

      if (input.activateImmediately === true) {
        const activated = await store.appendEvent(context, {
          passportId,
          organizationId: input.organization.organizationId,
          eventType: 'AgentPassportActivated',
          payload: {},
          actorId: input.actorId,
          actorType,
        });
        passport = activated.passport;
        telemetry?.recordPassportActivation();
      }

      for (const reference of input.capabilities ?? []) {
        const result = await store.appendEvent(context, {
          passportId,
          organizationId: input.organization.organizationId,
          eventType: 'AgentCapabilityReferenced',
          payload: { reference },
          actorId: input.actorId,
          actorType,
        });
        passport = result.passport;
      }
      for (const reference of input.authorities ?? []) {
        const result = await store.appendEvent(context, {
          passportId,
          organizationId: input.organization.organizationId,
          eventType: 'AgentAuthorityReferenced',
          payload: { reference },
          actorId: input.actorId,
          actorType,
        });
        passport = result.passport;
      }
      for (const reference of input.delegations ?? []) {
        const result = await store.appendEvent(context, {
          passportId,
          organizationId: input.organization.organizationId,
          eventType: 'AgentDelegationReferenced',
          payload: { reference },
          actorId: input.actorId,
          actorType,
        });
        passport = result.passport;
      }

      telemetry?.recordPassportIssued();
      return { passport, created: true };
    },

    async activatePassport(context, passportId, actorId) {
      const passport = await currentPassport(context, passportId);
      const result = await store.appendEvent(context, {
        passportId,
        organizationId: passport.organization.organizationId,
        eventType: 'AgentPassportActivated',
        payload: {},
        actorId,
        actorType: 'user',
      });
      telemetry?.recordPassportActivation();
      return result.passport;
    },

    async suspendPassport(context, passportId, input) {
      const passport = await currentPassport(context, passportId);
      const result = await store.appendEvent(context, {
        passportId,
        organizationId: passport.organization.organizationId,
        eventType: 'AgentPassportSuspended',
        payload: {
          suspendedBy: input.suspendedBy,
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
          ...(input.expectedReviewAt !== undefined ? { expectedReviewAt: input.expectedReviewAt } : {}),
          ...(input.evidenceBundleId !== undefined ? { evidenceBundleId: input.evidenceBundleId } : {}),
        },
        actorId: input.suspendedBy,
        actorType: 'user',
      });
      telemetry?.recordPassportSuspension();
      return result.passport;
    },

    async reactivatePassport(context, passportId, reactivatedBy) {
      const passport = await currentPassport(context, passportId);
      const result = await store.appendEvent(context, {
        passportId,
        organizationId: passport.organization.organizationId,
        eventType: 'AgentPassportReactivated',
        payload: { reactivatedBy },
        actorId: reactivatedBy,
        actorType: 'user',
      });
      telemetry?.recordPassportReactivation();
      return result.passport;
    },

    async revokePassport(context, passportId, input) {
      const passport = await currentPassport(context, passportId);
      const result = await store.appendEvent(context, {
        passportId,
        organizationId: passport.organization.organizationId,
        eventType: 'AgentPassportRevoked',
        payload: {
          reasonCode: input.reasonCode,
          reason: input.reason,
          revokedBy: input.revokedBy,
          ...(input.evidenceBundleId !== undefined ? { evidenceBundleId: input.evidenceBundleId } : {}),
        },
        actorId: input.revokedBy,
        actorType: 'user',
      });
      telemetry?.recordPassportRevocation();
      return result.passport;
    },

    async retirePassport(context, passportId, input) {
      const passport = await currentPassport(context, passportId);
      const result = await store.appendEvent(context, {
        passportId,
        organizationId: passport.organization.organizationId,
        eventType: 'AgentPassportRetired',
        payload: {
          retiredBy: input.retiredBy,
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
        },
        actorId: input.retiredBy,
        actorType: 'user',
      });
      telemetry?.recordPassportRetirement();
      return result.passport;
    },

    async referenceCapability(context, passportId, reference, actorId) {
      const passport = await currentPassport(context, passportId);
      const result = await store.appendEvent(context, {
        passportId,
        organizationId: passport.organization.organizationId,
        eventType: 'AgentCapabilityReferenced',
        payload: { reference },
        actorId,
        actorType: 'user',
      });
      return result.passport;
    },

    async removeCapabilityReference(context, passportId, capabilityId, actorId) {
      const passport = await currentPassport(context, passportId);
      const result = await store.appendEvent(context, {
        passportId,
        organizationId: passport.organization.organizationId,
        eventType: 'AgentCapabilityReferenceRemoved',
        payload: { capabilityId },
        actorId,
        actorType: 'user',
      });
      return result.passport;
    },

    async referenceAuthority(context, passportId, reference, actorId) {
      const passport = await currentPassport(context, passportId);
      const result = await store.appendEvent(context, {
        passportId,
        organizationId: passport.organization.organizationId,
        eventType: 'AgentAuthorityReferenced',
        payload: { reference },
        actorId,
        actorType: 'user',
      });
      return result.passport;
    },

    async removeAuthorityReference(context, passportId, authorityId, actorId) {
      const passport = await currentPassport(context, passportId);
      const result = await store.appendEvent(context, {
        passportId,
        organizationId: passport.organization.organizationId,
        eventType: 'AgentAuthorityReferenceRemoved',
        payload: { authorityId },
        actorId,
        actorType: 'user',
      });
      return result.passport;
    },

    async referenceDelegation(context, passportId, reference, actorId) {
      const passport = await currentPassport(context, passportId);
      const result = await store.appendEvent(context, {
        passportId,
        organizationId: passport.organization.organizationId,
        eventType: 'AgentDelegationReferenced',
        payload: { reference },
        actorId,
        actorType: 'user',
      });
      return result.passport;
    },

    async removeDelegationReference(context, passportId, delegationId, actorId) {
      const passport = await currentPassport(context, passportId);
      const result = await store.appendEvent(context, {
        passportId,
        organizationId: passport.organization.organizationId,
        eventType: 'AgentDelegationReferenceRemoved',
        payload: { delegationId },
        actorId,
        actorType: 'user',
      });
      return result.passport;
    },

    async linkGovernanceRecord(context, passportId, reference, actorId) {
      const passport = await currentPassport(context, passportId);

      if (governanceStore !== undefined) {
        const record = await governanceStore.getByEvaluationId(context, reference.evaluationId).catch(() => null);
        if (record === null) {
          throw new AgentPassportError('PASSPORT_GOVERNANCE_RECORD_NOT_FOUND', `No Governance Record for evaluationId '${reference.evaluationId}' within this scope.`);
        }
        // G-01C: a Passport references only its own organization's records -- the scope verification checks them in. A
        // system-scope caller could otherwise link another organization's record that the Passport can never verify.
        if (record.request.organizationId !== passport.organization.organizationId) {
          throw new AgentPassportError('PASSPORT_GOVERNANCE_RECORD_NOT_FOUND', `No Governance Record for evaluationId '${reference.evaluationId}' within this Passport's organization.`);
        }
        if (record.integrity.aggregateDigest !== reference.governanceRecordDigest) {
          throw new AgentPassportError('PASSPORT_REFERENCE_INVALID', `governanceRecordDigest does not match the stored Governance Record's aggregateDigest.`);
        }
        // G-01B1: a reference states only what its record states. The digest binds the record; the identifiers and the
        // decision status the Passport carries (and counts) must be the record's own, never a caller's assertion — so an
        // advisory denial cannot be linked as an "allowed" governed request. Advisory records stay linkable as what they are.
        const mismatched = [
          reference.evaluationId !== record.evaluation.evaluationId ? 'evaluationId' : undefined,
          reference.requestId !== record.evaluation.requestId || reference.requestId !== record.request.requestId ? 'requestId' : undefined,
          reference.decisionId !== record.evaluation.decisionId ? 'decisionId' : undefined,
          reference.status !== record.evaluation.status ? 'status' : undefined,
        ].filter((field): field is string => field !== undefined);
        if (mismatched.length > 0) {
          throw new AgentPassportError('PASSPORT_REFERENCE_INVALID', `The reference does not match the stored Governance Record: ${mismatched.join(', ')}.`);
        }
      }

      const result = await store.appendEvent(context, {
        passportId,
        organizationId: passport.organization.organizationId,
        eventType: 'GovernanceRecordLinked',
        payload: { reference },
        actorId,
        actorType: 'user',
      });
      telemetry?.recordPassportGovernanceLink();
      return result.passport;
    },

    async linkEvidenceBundle(context, passportId, reference, actorId) {
      const passport = await currentPassport(context, passportId);

      if (evidenceStore !== undefined) {
        const bundleRecord = await evidenceStore.getByBundleId(context, reference.bundleId).catch(() => null);
        if (bundleRecord === null) {
          throw new AgentPassportError('PASSPORT_EVIDENCE_NOT_FOUND', `No Evidence Bundle for bundleId '${reference.bundleId}' within this scope.`);
        }
        if (bundleRecord.bundle.integrity.bundleDigest !== reference.bundleDigest) {
          throw new AgentPassportError('PASSPORT_REFERENCE_INVALID', `bundleDigest does not match the stored Evidence Bundle's bundleDigest.`);
        }
      }

      const result = await store.appendEvent(context, {
        passportId,
        organizationId: passport.organization.organizationId,
        eventType: 'EvidenceBundleLinked',
        payload: { reference },
        actorId,
        actorType: 'user',
      });
      telemetry?.recordPassportEvidenceLink();
      return result.passport;
    },

    async getPassport(context, passportId) {
      return store.reconstruct(context, passportId);
    },

    async getEvents(context, passportId) {
      return store.listEvents(context, passportId);
    },

    async getHistorySummary(context, passportId) {
      const [passport, events] = await Promise.all([currentPassport(context, passportId), store.listEvents(context, passportId)]);
      return computePassportHistorySummary(passport, events);
    },

    async findByAgentId(context, agentId) {
      return store.findByAgentId(context, agentId);
    },

    async verifyPassport(context, passportId, mode = 'STRUCTURAL') {
      const events = await store.listEvents(context, passportId);
      const result = await verifyAgentPassport({
        passportId,
        events,
        mode,
        now,
        referenceCheckers: {
          ...(governanceStore !== undefined
            ? { governanceRecordExists: async (evaluationId: string, organizationId: string) => (await governanceStore.getByEvaluationId({ organizationId, system: false }, evaluationId).catch(() => null)) !== null }
            : {}),
          ...(evidenceStore !== undefined
            ? { evidenceBundleExists: async (bundleId: string, organizationId: string) => (await evidenceStore.getByBundleId({ organizationId, system: false }, bundleId).catch(() => null)) !== null }
            : {}),
        },
      });
      telemetry?.recordPassportVerification(result.valid);
      return result;
    },

    async buildView(context, passportId, viewType, generatedBy) {
      const passport = await currentPassport(context, passportId);
      const view = buildAgentPassportView({ passport, viewType, generatedBy, now, nextId });
      telemetry?.recordPassportViewGeneration();
      return view;
    },
  };
}

export { isAgentPassportError };
