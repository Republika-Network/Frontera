import { EnterpriseHttpErrors, mapGovernanceStoreErrorToHttp } from '../api/enterprise-http-errors.js';
import type { EnterpriseConfiguration } from '../configuration/enterprise-configuration.js';
import type { GovernanceRecord, GovernanceRecordVerificationResult, GovernanceStoreAccessContext, GovernanceStoreQuery, GovernanceStoreQueryResult } from '../governance-store/contracts.js';
import { isGovernanceStoreError } from '../governance-store/errors.js';
import type { GovernanceStore } from '../governance-store/governance-store.js';
import type { EnterpriseTelemetry } from '../telemetry/enterprise-telemetry.js';
import { extractBearerToken, matchApiKey } from './credential-matching.js';
import { projectGovernanceRecord, resolveGovernanceReadAccess, type GovernanceRecordDisclosure, type GovernanceRecordView } from './governance-record-disclosure.js';

/**
 * The Enterprise Host's read/verify surface over the Governance Store.
 * This service — never the HTTP adapter — turns the caller's credential
 * into a `GovernanceStoreAccessContext` (PR-004 sections 34/35/73):
 *
 * - authentication disabled → system scope (local/dev posture, same trust
 *   model the evaluate endpoint already has);
 * - authenticated org-scoped key → that organization only;
 * - authenticated unscoped key → system scope.
 *
 * The Store itself enforces the resulting scope; handlers never build raw
 * queries.
 *
 * G-01A: a configured **auditor** also reads here (its one organization, the
 * canonical record), and nowhere else. An organization-scoped API key reads a
 * record carrying an authenticated attribution as a marked projection with
 * that payload withheld (`governance-record-disclosure.ts`); `verify` always
 * checks the complete stored record.
 */
export interface GovernanceReadService {
  getByEvaluationId(authorizationHeader: string | undefined, evaluationId: string): Promise<GovernanceRecordView | null>;
  getByDecisionId(authorizationHeader: string | undefined, decisionId: string): Promise<GovernanceRecordView | null>;
  getByRequestId(authorizationHeader: string | undefined, requestId: string): Promise<GovernanceRecordView | null>;
  query(authorizationHeader: string | undefined, query: GovernanceStoreQuery): Promise<GovernanceStoreQueryResult>;
  verify(authorizationHeader: string | undefined, evaluationId: string): Promise<GovernanceRecordVerificationResult>;
}

/** Resolves the caller's authenticated read scope. Throws 401 for missing/unknown credentials when authentication is required. */
export function resolveGovernanceAccessContext(authorizationHeader: string | undefined, configuration: EnterpriseConfiguration): GovernanceStoreAccessContext {
  if (!configuration.features.requireAuthentication) return { system: true };

  const token = extractBearerToken(authorizationHeader);
  if (token === undefined) throw EnterpriseHttpErrors.authenticationFailed('A Bearer token is required.');
  const matchedKey = matchApiKey(token, configuration.authentication.apiKeys);
  if (matchedKey === undefined) throw EnterpriseHttpErrors.authenticationFailed('The provided credential is not recognized.');

  return matchedKey.organizationId !== undefined ? { system: false, organizationId: matchedKey.organizationId } : { system: true };
}

function view(record: GovernanceRecord | null, disclosure: GovernanceRecordDisclosure): GovernanceRecordView | null {
  return record === null ? null : projectGovernanceRecord(record, disclosure);
}

export function createGovernanceReadService(
  store: GovernanceStore,
  configuration: EnterpriseConfiguration,
  telemetry: EnterpriseTelemetry,
): GovernanceReadService {
  async function run<T>(authorizationHeader: string | undefined, callerInput: boolean, operation: (context: GovernanceStoreAccessContext, disclosure: GovernanceRecordDisclosure) => Promise<T>): Promise<T> {
    const { context, disclosure } = resolveGovernanceReadAccess(authorizationHeader, configuration);
    try {
      return await operation(context, disclosure);
    } catch (error) {
      if (isGovernanceStoreError(error)) {
        if (error.code === 'GOVERNANCE_RECORD_CORRUPTED') telemetry.recordStoreCorruptedRecord();
        throw mapGovernanceStoreErrorToHttp(error, { callerInput });
      }
      throw error;
    }
  }

  return {
    getByEvaluationId: (auth, evaluationId) => run(auth, false, async (context, disclosure) => view(await store.getByEvaluationId(context, evaluationId), disclosure)),
    getByDecisionId: (auth, decisionId) => run(auth, false, async (context, disclosure) => view(await store.getByDecisionId(context, decisionId), disclosure)),
    getByRequestId: (auth, requestId) => run(auth, false, async (context, disclosure) => view(await store.getByRequestId(context, requestId), disclosure)),
    query: (auth, query) =>
      run(auth, true, async (context) => {
        const startedAtMs = Date.now();
        const result = await store.query(context, query);
        telemetry.recordStoreQuery(Date.now() - startedAtMs);
        return result;
      }),
    verify: (auth, evaluationId) =>
      run(auth, false, async (context) => {
        const result = await store.verify(context, evaluationId);
        telemetry.recordStoreVerification(result.valid);
        return result;
      }),
  };
}
