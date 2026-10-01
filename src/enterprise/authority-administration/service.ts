import { assessGrantExercise, GRANT_REASON_CODES, type BoundedGrantReaderPort } from '../../features/grant-runtime/index.js';
import type { EmergencyControlStorePort } from '../../features/emergency-control-runtime/index.js';
import { EnterpriseHttpError, EnterpriseHttpErrors } from '../api/enterprise-http-errors.js';
import { isBoundedGrantStoreError } from '../bounded-grant-store/errors.js';
import type { EnterpriseAdministrator, EnterpriseApiKey, EnterpriseOperator } from '../configuration/enterprise-configuration.js';
import { isEmergencyControlStoreError } from '../emergency-control/errors.js';
import type { RevokeBoundedGrantRequest, RevokeBoundedGrantResult } from '../execution-governance/service.js';
import { isExecutionOutcomeStoreError } from '../execution-outcome-store/errors.js';
import type { ExecutionOutcomeReader } from '../execution-outcome-store/outcome-store.js';
import type { KernelAuthorityAccessContext } from '../kernel-authority/contracts.js';
import { isKernelAuthorityError } from '../kernel-authority/errors.js';
import type { KernelAuthorityStore } from '../kernel-authority/kernel-authority-store.js';
import type { KernelAuthorityProvisioningService } from '../kernel-authority/provisioning-service.js';
import { createOperatorAuthenticator, type OperatorAuthenticator } from '../operator-control/operator-authenticator.js';
import type { OperatorPermission } from '../operator-control/roles.js';
import type { EnterpriseLogger } from '../telemetry/enterprise-logger.js';
import {
  isCanonicalEntityId,
  isCanonicalGrantId,
  isKernelAuthorityEntityKind,
  toAdministeredAuthorityEntityView,
  toAdministeredGrantRevocation,
  toAdministeredGrantView,
  toEmergencyControlTargets,
  validateAuthorityEntityRevocationRequest,
  validateEmergencyControlTarget,
  validateGrantRevocationRequest,
  type AdministeredAuthorityEntityView,
  type AdministeredExecutionGrantView,
  type AdministeredGrantView,
  type AuthorityEntityRevocationResponse,
  type EmergencyControlsView,
  type EmergencyControlTransitionResponse,
  type GrantRevocationResponse,
} from './contracts.js';

/**
 * CTRL-01 — the authority administration application service.
 *
 * Authority administration is itself an authority-bearing action, so every
 * operation here runs the same sequence, in this order, before anything is
 * read:
 *
 * ```
 * Authorization header
 *   └─ authenticate as an ADMINISTRATOR          no header / unknown secret   → 401
 *       │                                        an ordinary credential       → 403
 *       └─ Host ready                                                          → 503
 *           └─ validate path + closed body                                     → 400
 *               └─ the existing authoritative service, under the trusted operator
 *                   ├─ bounded grants:     BoundedGrantReaderPort.read + assessGrantExercise;
 *                   │                      AuthorityControlledExecution.revokeGrant (CORE-01)
 *                   ├─ Kernel Authority:   KernelAuthorityStore.getRecord;
 *                   │                      KernelAuthorityProvisioningService.revoke
 *                   └─ emergency control:  EmergencyControlStorePort.active / activate / release
 * ```
 *
 * What it deliberately cannot do, by the types it is handed: issue or
 * provision anything (it holds a grant *reader* and a revoke function, and
 * only `getRecord` + `revoke` of the Kernel Authority), un-revoke anything (no
 * port offers it), sign anything, or reach a database. Every mutation is
 * recorded by the store that owns it, under `operator:<operatorId>` — the
 * identity bound to the administrator credential in configuration.
 *
 * Tenancy: one Host serves exactly one authority organization
 * (`kernelAuthority.organizationId`). Every Kernel Authority call is scoped to
 * it here; no request can name another.
 */
/**
 * Reads and parses the request body. Called only **after** the caller is
 * authorized, so an unauthenticated or non-administrator request is refused
 * before its body is read, parsed or validated.
 */
export type AdministrationBodyReader = () => Promise<unknown>;

export interface AuthorityAdministrationService {
  inspectGrant(authorizationHeader: string | undefined, grantId: string): Promise<AdministeredGrantView>;
  inspectExecutionGrant(authorizationHeader: string | undefined, executionId: string): Promise<AdministeredExecutionGrantView>;
  revokeGrant(authorizationHeader: string | undefined, grantId: string, readBody: AdministrationBodyReader): Promise<GrantRevocationResponse>;
  inspectAuthorityEntity(authorizationHeader: string | undefined, entityKind: string, entityId: string): Promise<AdministeredAuthorityEntityView>;
  revokeAuthorityEntity(authorizationHeader: string | undefined, entityKind: string, entityId: string, readBody: AdministrationBodyReader): Promise<AuthorityEntityRevocationResponse>;
  listEmergencyControls(authorizationHeader: string | undefined): Promise<EmergencyControlsView>;
  activateEmergencyControl(authorizationHeader: string | undefined, readBody: AdministrationBodyReader): Promise<EmergencyControlTransitionResponse>;
  releaseEmergencyControl(authorizationHeader: string | undefined, readBody: AdministrationBodyReader): Promise<EmergencyControlTransitionResponse>;
}

export interface AuthorityAdministrationDependencies {
  /** CTRL-01 administrators. The trusted identity of each is its configured `operatorId`; CTRL-02 holds them to exactly the CTRL-01 powers. */
  readonly administrators: readonly EnterpriseAdministrator[];
  /** CTRL-02 operators. Each reaches the CTRL-01 operations its role's permissions allow (`operator-control/roles.ts`). At least one administrator or operator in total. */
  readonly operators?: readonly EnterpriseOperator[];
  /**
   * CTRL-02: the Host's one operator authenticator, shared with the operator
   * control service so both planes authenticate identically. Built from
   * `administrators`, `operators` and `ordinaryCredentials` when absent.
   */
  readonly authenticator?: OperatorAuthenticator;
  /** Every ordinary credential the Host accepts elsewhere, used only to tell "authenticated, not an administrator" (403) from "not authenticated" (401). */
  readonly ordinaryCredentials: readonly EnterpriseApiKey[];
  /** The one organization this Host serves. */
  readonly organizationId: string;
  /** The Host's clock — the same one grant exercise is assessed by. */
  readonly now: () => string;
  readonly isReady: () => boolean;
  readonly lifecycleState: () => string;
  readonly logger: EnterpriseLogger;
  readonly grants?: {
    /** Read-only: the authoritative read the exercise path uses. No `issue`, no `revoke` on this object. */
    readonly reader: BoundedGrantReaderPort;
    /** The canonical revocation: `AuthorityControlledExecutionService.revokeGrant`, which signs through the CORE-01 store and reports evidence. */
    readonly revoke: (input: RevokeBoundedGrantRequest) => Promise<RevokeBoundedGrantResult>;
  };
  readonly kernelAuthority?: {
    readonly store: Pick<KernelAuthorityStore, 'getRecord'>;
    readonly provisioning: Pick<KernelAuthorityProvisioningService, 'revoke'>;
  };
  readonly emergencyControl?: EmergencyControlStorePort;
  /** Read-only, tenant-scoped, verified before return (P11). */
  readonly executionOutcomes?: ExecutionOutcomeReader;
}

/** The trusted administrative context of one request. Built only from configuration. */
interface AdministratorContext {
  readonly operatorId: string;
  /** What each store records as the actor: the administration plane, then the operator. */
  readonly actorRef: string;
}

function notComposed(capability: string): EnterpriseHttpError {
  return new EnterpriseHttpError(404, 'AUTHORITY_ADMIN_CAPABILITY_NOT_COMPOSED', `${capability} is not composed on this Host.`);
}

function targetNotFound(message: string): EnterpriseHttpError {
  return new EnterpriseHttpError(404, 'AUTHORITY_ADMIN_TARGET_NOT_FOUND', message);
}

function stateUnavailable(): EnterpriseHttpError {
  return new EnterpriseHttpError(503, 'AUTHORITY_STATE_UNAVAILABLE', 'The authoritative store is unavailable. Nothing was read or changed.');
}

/**
 * CORE-02 / AA-004: the authority signer could not sign, so **nothing was
 * recorded**. For a revocation that means the grant is still exercisable — the
 * message says so, and names the one control that does not depend on the
 * signer (an emergency stop). The reason is a closed code; never a credential,
 * endpoint or provider message.
 */
/**
 * Recognized by its stable error name rather than by importing the signer
 * module: the administration layer is structurally barred from reaching
 * anything signing-related (CTRL-01), and needs only to know that nothing was
 * written. The reason is read only if it is a closed-vocabulary-shaped code.
 */
function isAuthoritySigningUnavailable(error: unknown): error is Error & { readonly reason: string | undefined } {
  return error instanceof Error && error.name === 'AuthoritySigningUnavailableError';
}

function signerUnavailable(reason: unknown): EnterpriseHttpError {
  const failure = typeof reason === 'string' && /^[A-Z][A-Z_]{2,63}$/.test(reason) ? reason : 'AUTHORITY_SIGNER_UNAVAILABLE';
  return new EnterpriseHttpError(
    503,
    'AUTHORITY_SIGNER_UNAVAILABLE',
    'The authority signer is unavailable, so nothing was recorded: a revocation that cannot be signed is not a revocation, and this grant remains exercisable until one is. Retry when the signer is available; to halt execution now, declare an emergency stop (it does not depend on the signer).',
    undefined,
    { failure, recorded: false },
  );
}

/** An integrity incident is never a 404 and never a success: the operator is told the state cannot be vouched for, and which store condition fired — a code, never contents. */
function integrityFailed(failure: string): EnterpriseHttpError {
  return new EnterpriseHttpError(
    500,
    'AUTHORITY_STATE_INTEGRITY_FAILED',
    'The authoritative state could not be verified, so it is not reported and nothing was changed. Treat this as a security incident; see the operator runbook.',
    undefined,
    { failure },
  );
}

function committedRefreshFailed(): EnterpriseHttpError {
  return new EnterpriseHttpError(
    503,
    'AUTHORITY_STATE_REFRESH_FAILED',
    'The authority write was durably recorded, but this Host could not refresh its in-memory authority projection, which now fails closed (decisions are denied) until a refresh succeeds. Retry the SAME request — same target, terms and idempotency key — to replay the committed record and refresh. Do not submit a different request.',
    undefined,
    { recorded: true, retry: 'same-request' },
  );
}

export function createAuthorityAdministrationService(dependencies: AuthorityAdministrationDependencies): AuthorityAdministrationService {
  const { organizationId, now, logger } = dependencies;
  if (dependencies.administrators.length === 0 && (dependencies.operators?.length ?? 0) === 0 && dependencies.authenticator === undefined) {
    throw new Error('createAuthorityAdministrationService: at least one administrator or operator is required.');
  }

  // CTRL-02: one authenticator for the whole operator plane — the Host's
  // canonical constant-time matcher, then the one permission policy. A CTRL-01
  // administrator is the `legacy-administrator` class: exactly these
  // operations, never provisioning.
  const authenticator: OperatorAuthenticator =
    dependencies.authenticator ??
    createOperatorAuthenticator({
      administrators: dependencies.administrators,
      operators: dependencies.operators ?? [],
      ordinaryCredentials: dependencies.ordinaryCredentials,
      organizationId,
      isReady: dependencies.isReady,
      lifecycleState: dependencies.lifecycleState,
    });

  function authorize(authorizationHeader: string | undefined, permission: OperatorPermission): AdministratorContext {
    const principal = authenticator.authorize(authorizationHeader, permission);
    return { operatorId: principal.operatorId, actorRef: principal.actorRef };
  }

  function audit(context: AdministratorContext, operation: string, target: string, status: string): void {
    logger.info('enterprise.admin.authority', { operatorId: context.operatorId, operation, target, status, organizationId });
  }

  function mapGrantStoreError(error: unknown): never {
    if (isBoundedGrantStoreError(error)) {
      if (error.code === 'BOUNDED_GRANT_STORE_UNAVAILABLE') throw stateUnavailable();
      throw integrityFailed(error.code);
    }
    // CORE-02 / AA-004: the signer could not sign. Nothing was written, and the
    // operator is told so in as many words — never a success, never a generic
    // fault that could be read as "probably done".
    if (isAuthoritySigningUnavailable(error)) throw signerUnavailable(error.reason);
    throw error;
  }

  function mapKernelAuthorityError(error: unknown): never {
    if (isKernelAuthorityError(error)) {
      switch (error.code) {
        case 'KERNEL_AUTHORITY_ENTITY_NOT_FOUND':
          throw targetNotFound('No Kernel Authority entity of that kind and id is provisioned in this organization.');
        case 'KERNEL_AUTHORITY_VALIDATION_ERROR':
          throw EnterpriseHttpErrors.invalidRequest(error.message);
        case 'KERNEL_AUTHORITY_REFRESH_FAILED':
          throw committedRefreshFailed();
        case 'KERNEL_AUTHORITY_STORE_UNAVAILABLE':
          throw stateUnavailable();
        case 'KERNEL_AUTHORITY_INTEGRITY_FAILED':
        case 'KERNEL_AUTHORITY_VERSION_UNSUPPORTED':
          throw integrityFailed(error.code);
        default:
          throw new EnterpriseHttpError(409, 'AUTHORITY_ADMIN_OPERATION_REFUSED', `The Kernel Authority refused the operation (${error.code}).`);
      }
    }
    throw error;
  }

  function mapEmergencyControlError(error: unknown): never {
    if (isEmergencyControlStoreError(error)) {
      if (error.code === 'EMERGENCY_CONTROL_STORE_UNAVAILABLE') throw stateUnavailable();
      if (error.code === 'EMERGENCY_CONTROL_DECLARATION_INVALID') throw EnterpriseHttpErrors.invalidRequest('The emergency control is not well formed.');
      throw integrityFailed(error.code);
    }
    throw error;
  }

  function grantIdFrom(grantId: string): string {
    if (!isCanonicalGrantId(grantId)) throw EnterpriseHttpErrors.invalidRequest("grantId must be a canonical bounded-grant id ('aoc.grant:' followed by 32 lowercase hex digits).");
    return grantId;
  }

  function entityFrom(entityKind: string, entityId: string): { readonly entityKind: Parameters<KernelAuthorityStore['getRecord']>[2]; readonly entityId: string } {
    if (!isKernelAuthorityEntityKind(entityKind)) throw EnterpriseHttpErrors.invalidRequest('entityKind is not a Kernel Authority entity kind.');
    if (!isCanonicalEntityId(entityId)) throw EnterpriseHttpErrors.invalidRequest('entityId must be a non-empty identifier of at most 256 characters.');
    return { entityKind, entityId };
  }

  /** Reads are organization-scoped, not system: an administrator reads this Host's organization and nothing else. */
  const readContext: KernelAuthorityAccessContext = Object.freeze({ system: false, organizationId });

  async function readEntity(entityKind: Parameters<KernelAuthorityStore['getRecord']>[2], entityId: string): Promise<AdministeredAuthorityEntityView> {
    const kernelAuthority = dependencies.kernelAuthority;
    if (kernelAuthority === undefined) throw notComposed('The Kernel Authority');
    let record;
    try {
      record = await kernelAuthority.store.getRecord(readContext, organizationId, entityKind, entityId);
    } catch (error) {
      mapKernelAuthorityError(error);
    }
    if (record === null) throw targetNotFound('No Kernel Authority entity of that kind and id is provisioned in this organization.');
    if (record.organizationId !== organizationId || record.entityKind !== entityKind || record.entityId !== entityId) throw integrityFailed('KERNEL_AUTHORITY_RECORD_MISMATCH');
    return toAdministeredAuthorityEntityView(record);
  }

  function emergencyControlStore(): EmergencyControlStorePort {
    if (dependencies.emergencyControl === undefined) throw notComposed('Emergency control');
    return dependencies.emergencyControl;
  }

  function activeControls(store: EmergencyControlStorePort): EmergencyControlsView {
    try {
      return { active: toEmergencyControlTargets(store.active()) };
    } catch (error) {
      mapEmergencyControlError(error);
    }
  }

  return Object.freeze({
    async inspectGrant(authorizationHeader: string | undefined, rawGrantId: string): Promise<AdministeredGrantView> {
      authorize(authorizationHeader, 'authority.inspect');
      const grantId = grantIdFrom(rawGrantId);
      const grants = dependencies.grants;
      if (grants === undefined) throw notComposed('Bounded grants');
      let read;
      try {
        read = await grants.reader.read(grantId);
      } catch (error) {
        mapGrantStoreError(error);
      }
      if (read.grant === undefined) throw targetNotFound('No bounded grant with that id is held by the authoritative store.');
      if (read.grant.id !== grantId || (read.revocation !== undefined && read.revocation.grantId !== grantId)) throw integrityFailed('BOUNDED_GRANT_RECORD_MISMATCH');
      const assessedAt = now();
      // The grant-runtime's own assessment — the one the exercise path runs.
      const assessment = assessGrantExercise({ grant: read.grant, ...(read.revocation !== undefined ? { revocation: read.revocation } : {}), at: assessedAt });
      // A grant whose own digest does not match its fields is not reported as
      // anything: not exercisable, not revoked, not expired.
      if (assessment.reasonCodes.includes(GRANT_REASON_CODES.GRANT_CORRELATION_INVALID)) throw integrityFailed('BOUNDED_GRANT_DIGEST_MISMATCH');
      return toAdministeredGrantView(read.grant, read.revocation, assessment, assessedAt);
    },

    async inspectExecutionGrant(authorizationHeader: string | undefined, rawExecutionId: string): Promise<AdministeredExecutionGrantView> {
      authorize(authorizationHeader, 'authority.inspect');
      if (!isCanonicalEntityId(rawExecutionId)) throw EnterpriseHttpErrors.invalidRequest('executionId must be a non-empty identifier of at most 256 characters.');
      const reader = dependencies.executionOutcomes;
      if (reader === undefined) throw notComposed('Execution outcomes');
      let record;
      try {
        record = await reader.read({ organizationId }, rawExecutionId);
      } catch (error) {
        if (isExecutionOutcomeStoreError(error)) {
          if (error.code === 'EXECUTION_OUTCOME_STORE_UNAVAILABLE') throw stateUnavailable();
          if (error.code === 'EXECUTION_OUTCOME_INPUT_INVALID') throw EnterpriseHttpErrors.invalidRequest('executionId is not a canonical execution id.');
          if (error.code === 'EXECUTION_OUTCOME_TENANT_VIOLATION') throw targetNotFound('No execution with that id is recorded for this organization.');
          throw integrityFailed(error.code);
        }
        throw error;
      }
      if (record === undefined) throw targetNotFound('No execution with that id is recorded for this organization.');
      const { attempt } = record;
      if (attempt.executionId !== rawExecutionId || attempt.organizationId !== organizationId) throw integrityFailed('EXECUTION_OUTCOME_RECORD_MISMATCH');
      return {
        executionId: attempt.executionId,
        requestId: attempt.requestId,
        decisionId: attempt.decisionId,
        grantId: attempt.boundedGrantId,
        action: attempt.action,
        preparedAt: attempt.preparedAt,
      };
    },

    async revokeGrant(authorizationHeader: string | undefined, rawGrantId: string, readBody: AdministrationBodyReader): Promise<GrantRevocationResponse> {
      const context = authorize(authorizationHeader, 'authority.revoke');
      const grantId = grantIdFrom(rawGrantId);
      const { reason } = validateGrantRevocationRequest(await readBody());
      const grants = dependencies.grants;
      if (grants === undefined) throw notComposed('Bounded grants');
      let result: RevokeBoundedGrantResult;
      try {
        result = await grants.revoke({ grantId, reason, issuerRef: context.actorRef, revokedAt: now() });
      } catch (error) {
        audit(context, 'grant.revoke', grantId, 'failed');
        mapGrantStoreError(error);
      }
      if (result.outcome === 'refused') {
        audit(context, 'grant.revoke', grantId, 'refused');
        if (result.reasonCodes.includes(GRANT_REASON_CODES.GRANT_NOT_FOUND)) throw targetNotFound('No bounded grant with that id is held by the authoritative store.');
        throw new EnterpriseHttpError(409, 'AUTHORITY_ADMIN_OPERATION_REFUSED', `The revocation was refused (${result.reasonCodes.join(', ')}).`);
      }
      audit(context, 'grant.revoke', grantId, result.outcome);
      return { outcome: result.outcome, grantId, revocation: toAdministeredGrantRevocation(result.revocation) };
    },

    async inspectAuthorityEntity(authorizationHeader: string | undefined, rawKind: string, rawId: string): Promise<AdministeredAuthorityEntityView> {
      authorize(authorizationHeader, 'authority.inspect');
      const { entityKind, entityId } = entityFrom(rawKind, rawId);
      return readEntity(entityKind, entityId);
    },

    async revokeAuthorityEntity(authorizationHeader: string | undefined, rawKind: string, rawId: string, readBody: AdministrationBodyReader): Promise<AuthorityEntityRevocationResponse> {
      const context = authorize(authorizationHeader, 'authority.revoke');
      const { entityKind, entityId } = entityFrom(rawKind, rawId);
      const { reason } = validateAuthorityEntityRevocationRequest(await readBody());
      const kernelAuthority = dependencies.kernelAuthority;
      if (kernelAuthority === undefined) throw notComposed('The Kernel Authority');
      const target = `${entityKind}:${entityId}`;
      // The operator write context: system, this Host's organization, and the
      // configured operator — the store's own operator rule enforces the rest.
      const operator: KernelAuthorityAccessContext = { system: true, organizationId, actorId: context.actorRef };
      let result;
      try {
        result = await kernelAuthority.provisioning.revoke(operator, { entityKind, entityId, reason });
      } catch (error) {
        audit(context, 'authority-entity.revoke', target, isKernelAuthorityError(error) && error.code === 'KERNEL_AUTHORITY_REFRESH_FAILED' ? 'committed-refresh-failed' : 'refused');
        mapKernelAuthorityError(error);
      }
      if (result.record.status !== 'revoked' || result.record.entityKind !== entityKind || result.record.entityId !== entityId) throw integrityFailed('KERNEL_AUTHORITY_RECORD_MISMATCH');
      const outcome = result.replayed ? 'already-revoked' : 'revoked';
      audit(context, 'authority-entity.revoke', target, outcome);
      return { outcome, entity: toAdministeredAuthorityEntityView(result.record) };
    },

    async listEmergencyControls(authorizationHeader: string | undefined): Promise<EmergencyControlsView> {
      authorize(authorizationHeader, 'authority.inspect');
      return activeControls(emergencyControlStore());
    },

    async activateEmergencyControl(authorizationHeader: string | undefined, readBody: AdministrationBodyReader): Promise<EmergencyControlTransitionResponse> {
      const context = authorize(authorizationHeader, 'emergency.stop');
      const control = validateEmergencyControlTarget(await readBody());
      const store = emergencyControlStore();
      const target = control.value === undefined ? control.scope : `${control.scope}:${control.value}`;
      try {
        store.activate({ scope: control.scope, ...(control.value !== undefined ? { value: control.value } : {}), issuerRef: context.actorRef, declaredAt: now() });
      } catch (error) {
        audit(context, 'emergency-control.activate', target, 'failed');
        mapEmergencyControlError(error);
      }
      audit(context, 'emergency-control.activate', target, 'activated');
      return { outcome: 'activated', control, ...activeControls(store) };
    },

    async releaseEmergencyControl(authorizationHeader: string | undefined, readBody: AdministrationBodyReader): Promise<EmergencyControlTransitionResponse> {
      const context = authorize(authorizationHeader, 'emergency.release');
      const control = validateEmergencyControlTarget(await readBody());
      const store = emergencyControlStore();
      const target = control.value === undefined ? control.scope : `${control.scope}:${control.value}`;
      try {
        store.release({ scope: control.scope, ...(control.value !== undefined ? { value: control.value } : {}), issuerRef: context.actorRef, releasedAt: now() });
      } catch (error) {
        audit(context, 'emergency-control.release', target, 'failed');
        mapEmergencyControlError(error);
      }
      audit(context, 'emergency-control.release', target, 'released');
      return { outcome: 'released', control, ...activeControls(store) };
    },
  });
}
