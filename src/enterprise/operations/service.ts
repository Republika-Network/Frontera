import { EnterpriseHttpError, EnterpriseHttpErrors, mapEvidenceErrorToHttp, mapGovernanceStoreErrorToHttp } from '../api/enterprise-http-errors.js';
import { isEvidenceError } from '../evidence/errors.js';
import { authorityTraceVerificationOf, type AuthorityTraceBuild } from '../evidence/trace-builder.js';
import { GOVERNED_REQUEST_ID_PATTERN } from '../evidence/trace-contracts.js';
import { discloseAuthorityTrace, discloseTraceVerification, disclosedTraceDigest, getDisclosurePolicyV2 } from '../evidence/trace-disclosure.js';
import type { GovernanceRecordSummary, GovernanceStoreAccessContext, GovernanceStoreCountQuery, GovernanceStoreQuery, GovernanceStoreQueryResult } from '../governance-store/contracts.js';
import { isGovernanceStoreError } from '../governance-store/errors.js';
import type { EnterpriseHealthReport } from '../health/health-check.js';
import { DECISION_ACTIVITY_STATUSES, closedQuery, isOperatorEntityId } from '../operator-control/contracts.js';
import type { OperatorAuthenticator } from '../operator-control/operator-authenticator.js';
import { discloseOperationalView, operationalViewOf, operationalViewOfEvaluation, operationalViewWithoutTrace } from './classification.js';
import {
  OPERATIONS_PAGE_DEFAULT_LIMIT,
  OPERATIONS_PAGE_MAX_LIMIT,
  OPERATIONS_SCAN_LIMIT,
  OPERATOR_TRACE_LEVELS,
  type OperationalAttentionPage,
  type OperationalExecutionPage,
  type OperationalExecutionView,
  type OperationalHealth,
  type OperationalHealthView,
  type OperationalMetrics,
  type OperationalTraceView,
} from './contracts.js';

/**
 * PROD-03-01 — the operator plane's operational visibility: read only.
 *
 * ```
 * Authorization header
 *   └─ OperatorAuthenticator.authorize(header, 'operations.read' | 'trace.read')   401 / 403 / 503
 *       └─ closed path + query                                                  400
 *           └─ organization-scoped reads only: { system: false, organizationId: <served> }
 *               ├─ Governance Store: query / count (bounded, cursor-paged)
 *               ├─ ASSURE-01 trace builder (the one trace implementation)
 *               └─ the Host's own health report
 * ```
 *
 * What it cannot do, by the objects it is handed: append, claim, resolve,
 * reconcile, retry, approve, revoke, issue or execute anything. Every port
 * below is a read, and every answer is a fresh projection of durable state.
 */

export type OperationsQuery = Readonly<Record<string, string>>;

export interface OperatorOperationsService {
  /** Governed requests of the served organization, newest first, each classified through its trace. */
  listExecutions(authorizationHeader: string | undefined, query: OperationsQuery): Promise<OperationalExecutionPage>;
  /** Executions claimed without a definitive outcome: every entry requires attention. */
  listAttention(authorizationHeader: string | undefined, query: OperationsQuery): Promise<OperationalAttentionPage>;
  /** One request's ASSURE-01 trace, disclosed at an operator level (never FULL), its verification and its classification. */
  readTrace(authorizationHeader: string | undefined, requestId: string, query: OperationsQuery): Promise<OperationalTraceView>;
  /** Closed counters, computed on read. */
  metrics(authorizationHeader: string | undefined, query: OperationsQuery): Promise<OperationalMetrics>;
  /** The Host's health report with the operational counts. */
  health(authorizationHeader: string | undefined, query: OperationsQuery): Promise<OperationalHealthView>;
}

export interface OperatorOperationsDependencies {
  readonly authenticator: OperatorAuthenticator;
  /** The one organization this Host serves. */
  readonly organizationId: string;
  /** The Governance Store's read half: query and count. Never append. */
  readonly governanceRecords: {
    query(context: GovernanceStoreAccessContext, query: GovernanceStoreQuery): Promise<GovernanceStoreQueryResult>;
    count(context: GovernanceStoreAccessContext, query: GovernanceStoreCountQuery): Promise<number>;
  };
  /** The ASSURE-01 trace builder over the Host's composed read-only sources. */
  readonly traces: { build(context: GovernanceStoreAccessContext, requestId: string): Promise<AuthorityTraceBuild | null> };
  /** The same report `GET /health` serves. */
  readonly health: () => Promise<EnterpriseHealthReport>;
  readonly now: () => string;
}

const CURSOR = /^[A-Za-z0-9._:=-]{1,512}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
/** One candidate page while scanning; well inside the store's own maximum. */
const SCAN_PAGE = 100;
/** How many times metrics re-read the counters around the scan before stating that the store kept moving. */
const METRICS_SNAPSHOT_ATTEMPTS = 3;

/** The counters `metrics` states. Every set counted here only grows (the Governance Store is append-only). */
interface MetricCounters {
  readonly allowed: number;
  readonly denied: number;
  readonly approvalRequired: number;
  readonly indeterminate: number;
  readonly total: number;
  readonly issuanceWithheld: number;
  readonly executionClaims: number;
}

function sameCounters(a: MetricCounters, b: MetricCounters): boolean {
  return (Object.keys(a) as (keyof MetricCounters)[]).every((key) => a[key] === b[key]);
}

function pageLimit(raw: string | undefined): number {
  if (raw === undefined) return OPERATIONS_PAGE_DEFAULT_LIMIT;
  if (!/^[1-9][0-9]{0,2}$/.test(raw) || Number(raw) > OPERATIONS_PAGE_MAX_LIMIT) throw EnterpriseHttpErrors.invalidRequest(`limit must be an integer from 1 to ${OPERATIONS_PAGE_MAX_LIMIT}.`);
  return Number(raw);
}

function pageCursor(raw: string | undefined): string | undefined {
  if (raw !== undefined && !CURSOR.test(raw)) throw EnterpriseHttpErrors.invalidRequest('cursor must be the opaque value a previous page returned.');
  return raw;
}

function mapReadError(error: unknown, callerInput: boolean): never {
  if (isGovernanceStoreError(error)) throw mapGovernanceStoreErrorToHttp(error, { callerInput });
  if (isEvidenceError(error)) throw mapEvidenceErrorToHttp(error);
  throw error;
}

function integrityFailed(failure: string): EnterpriseHttpError {
  return new EnterpriseHttpError(500, 'AUTHORITY_STATE_INTEGRITY_FAILED', 'The recorded state could not be verified, so it is not reported. Treat this as a security incident; see the operator runbook.', undefined, { failure });
}

/** A closed failure code for a trace that could not be built — never an exception's text. */
function failureCodeOf(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error ? (error as { code: unknown }).code : undefined;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'READ_FAILED';
}

export function createOperatorOperationsService(dependencies: OperatorOperationsDependencies): OperatorOperationsService {
  const { authenticator, organizationId, governanceRecords, traces, now } = dependencies;
  if (authenticator.organizationId !== organizationId) throw new Error('createOperatorOperationsService: the authenticator serves another organization.');
  /** Organization-scoped, never system: an operator reads this Host's organization and nothing else. */
  const context: GovernanceStoreAccessContext = Object.freeze({ system: false, organizationId });

  async function query(filter: GovernanceStoreQuery, callerInput: boolean): Promise<GovernanceStoreQueryResult> {
    let page: GovernanceStoreQueryResult;
    try {
      page = await governanceRecords.query(context, { ...filter, organizationId });
    } catch (error) {
      return mapReadError(error, callerInput);
    }
    // The served organization only, re-proven: a record of another is corruption, never data.
    if (page.records.some((record) => record.organizationId !== organizationId)) throw integrityFailed('GOVERNANCE_RECORD_MISMATCH');
    return page;
  }

  async function count(filter: GovernanceStoreCountQuery): Promise<number> {
    try {
      return await governanceRecords.count(context, { ...filter, organizationId });
    } catch (error) {
      return mapReadError(error, false);
    }
  }

  /**
   * Whether a record came through the governed-action path, from the durable
   * evidence that path writes in the decision's own commit (its idempotency
   * claim, which derives the request id) — never from the request id's shape,
   * which an evaluate-route caller may choose.
   */
  async function isGovernedAction(evaluationId: string): Promise<boolean> {
    return (await count({ evaluationId, governedPath: 'governed-action' })) > 0;
  }

  /** One record, classified. A store that cannot be read fails the whole read; a trace that cannot be built is that record's own state. */
  async function viewOf(summary: GovernanceRecordSummary): Promise<OperationalExecutionView> {
    if (!GOVERNED_REQUEST_ID_PATTERN.test(summary.requestId) || !(await isGovernedAction(summary.evaluationId))) return operationalViewOfEvaluation(summary);
    let build: AuthorityTraceBuild | null;
    try {
      build = await traces.build(context, summary.requestId);
    } catch (error) {
      if (isGovernanceStoreError(error)) return mapReadError(error, false);
      return operationalViewWithoutTrace(summary, failureCodeOf(error));
    }
    if (build === null || build.trace.evaluationId !== summary.evaluationId) return operationalViewWithoutTrace(summary, build === null ? 'TRACE_NOT_FOUND' : 'TRACE_RECORD_MISMATCH');
    return operationalViewOf(build.trace, summary);
  }

  async function viewsOf(records: readonly GovernanceRecordSummary[]): Promise<OperationalExecutionView[]> {
    const views: OperationalExecutionView[] = [];
    // Sequential: each build is several store reads, and a page is bounded.
    for (const record of records) views.push(await viewOf(record));
    return views;
  }

  /**
   * The bounded scan behind every count: the Governance Store's open claims
   * (`execution-open`), each classified through its trace, at most
   * `OPERATIONS_SCAN_LIMIT` of them. Reads only.
   */
  async function scanOpenClaims(): Promise<{ readonly operations: Omit<OperationalHealth, 'checkedAt'>; readonly definitiveOnRead: number }> {
    const candidates = await count({ governedPath: 'execution-open' });
    let examined = 0;
    let unresolved = 0;
    let attention = 0;
    let definitiveOnRead = 0;
    let cursor: string | undefined;
    do {
      const page = await query({ governedPath: 'execution-open', limit: Math.min(SCAN_PAGE, OPERATIONS_SCAN_LIMIT - examined), ...(cursor !== undefined ? { cursor } : {}) }, false);
      for (const view of await viewsOf(page.records)) {
        examined += 1;
        if (view.unresolved) unresolved += 1;
        if (view.attentionRequired) attention += 1;
        if (view.outcome.status !== 'none' && view.outcome.status !== 'unconfirmed') definitiveOnRead += 1;
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined && examined < OPERATIONS_SCAN_LIMIT);
    return {
      operations: {
        unresolvedExecutions: unresolved,
        attentionRequired: attention,
        scan: { candidates: Math.max(candidates, examined), examined, complete: cursor === undefined, limit: OPERATIONS_SCAN_LIMIT },
      },
      definitiveOnRead,
    };
  }

  async function counters(): Promise<MetricCounters> {
    const allowed = await count({ status: 'allowed' });
    const denied = await count({ status: 'denied' });
    const approvalRequired = await count({ status: 'approval_required' });
    const indeterminate = await count({ status: 'indeterminate' });
    const total = await count({});
    const issuanceWithheld = await count({ governedPath: 'issuance-withheld' });
    const executionClaims = await count({ governedPath: 'execution-claimed' });
    return { allowed, denied, approvalRequired, indeterminate, total, issuanceWithheld, executionClaims };
  }

  return Object.freeze({
    async listExecutions(authorizationHeader: string | undefined, rawQuery: OperationsQuery): Promise<OperationalExecutionPage> {
      authenticator.authorize(authorizationHeader, 'operations.read');
      const { status, actorId, requestId, limit, cursor } = closedQuery(rawQuery, ['status', 'actorId', 'requestId', 'limit', 'cursor']);
      if (status !== undefined && !(DECISION_ACTIVITY_STATUSES as readonly string[]).includes(status)) throw EnterpriseHttpErrors.invalidRequest(`status must be one of: ${DECISION_ACTIVITY_STATUSES.join(', ')}.`);
      if (actorId !== undefined && !isOperatorEntityId(actorId)) throw EnterpriseHttpErrors.invalidRequest("actorId must be 1-128 letters, digits, '.', '_', ':' or '-', starting with a letter or digit.");
      if (requestId !== undefined && (requestId.length === 0 || requestId.length > 256 || requestId.trim() !== requestId || CONTROL.test(requestId))) {
        throw EnterpriseHttpErrors.invalidRequest('requestId must be a non-empty identifier of at most 256 characters.');
      }
      const after = pageCursor(cursor);
      const page = await query(
        {
          limit: pageLimit(limit),
          ...(status !== undefined ? { status: status as (typeof DECISION_ACTIVITY_STATUSES)[number] } : {}),
          ...(actorId !== undefined ? { actorId } : {}),
          ...(requestId !== undefined ? { requestId } : {}),
          ...(after !== undefined ? { cursor: after } : {}),
        },
        true,
      );
      return { executions: await viewsOf(page.records), nextCursor: page.nextCursor ?? null, coverage: 'governance-store-decisions-classified-by-trace' };
    },

    async listAttention(authorizationHeader: string | undefined, rawQuery: OperationsQuery): Promise<OperationalAttentionPage> {
      authenticator.authorize(authorizationHeader, 'operations.read');
      const { limit, cursor } = closedQuery(rawQuery, ['limit', 'cursor']);
      const after = pageCursor(cursor);
      const page = await query({ governedPath: 'execution-open', limit: pageLimit(limit), ...(after !== undefined ? { cursor: after } : {}) }, true);
      const views = await viewsOf(page.records);
      const attention = views.filter((view) => view.attentionRequired);
      return { attention, nextCursor: page.nextCursor ?? null, resolvedOnRead: views.length - attention.length, coverage: 'execution-claims-without-definitive-outcome' };
    },

    async readTrace(authorizationHeader: string | undefined, requestId: string, rawQuery: OperationsQuery): Promise<OperationalTraceView> {
      authenticator.authorize(authorizationHeader, 'trace.read');
      const { level } = closedQuery(rawQuery, ['level']);
      const requested = level ?? 'AUDITOR';
      // FULL is internal (`evidence-service.ts`); an operator reads at most AUDITOR, the third-party audit level.
      if (!(OPERATOR_TRACE_LEVELS as readonly string[]).includes(requested)) {
        throw requested === 'FULL'
          ? new EnterpriseHttpError(403, 'EVIDENCE_DISCLOSURE_NOT_PERMITTED', 'FULL disclosure is internal; the operator plane reads a trace at most at AUDITOR.')
          : EnterpriseHttpErrors.invalidRequest(`level must be one of: ${OPERATOR_TRACE_LEVELS.join(', ')}.`);
      }
      if (!GOVERNED_REQUEST_ID_PATTERN.test(requestId)) throw EnterpriseHttpErrors.invalidRequest('requestId must be a governed request identity (aoc.gar:<32 lowercase hex>).');
      let build: AuthorityTraceBuild | null;
      try {
        build = await traces.build(context, requestId);
      } catch (error) {
        return mapReadError(error, false);
      }
      if (build === null) throw new EnterpriseHttpError(404, 'EVIDENCE_TRACE_NOT_FOUND', 'No governed request with that id is recorded for this organization.');
      if (build.trace.organizationId !== organizationId || build.trace.requestId !== requestId) throw integrityFailed('TRACE_RECORD_MISMATCH');
      const policy = getDisclosurePolicyV2(requested);
      const disclosed = discloseAuthorityTrace(build.trace, policy);
      const at = now();
      const { record } = build;
      const summary = {
        requestId,
        evaluationId: record.evaluation.evaluationId,
        decisionId: record.evaluation.decisionId,
        actorId: record.request.actorId,
        actionType: record.request.actionType,
        status: record.evaluation.status,
        reasonCodes: record.evaluation.reasonCodes,
        evaluatedAt: record.evaluation.evaluatedAt,
        persistedAt: record.evaluation.persistedAt,
      };
      // Classified exactly as the execution list classifies it, then disclosed at the trace's own level.
      const view = (await isGovernedAction(summary.evaluationId)) ? operationalViewOf(build.trace, summary) : operationalViewOfEvaluation(summary);
      return {
        requestId,
        disclosure: { level: policy.level, policyId: policy.policyId, policyVersion: policy.version, visibleFields: policy.visibleFields, hiddenFields: policy.hiddenFields, redactedFields: policy.redactedFields },
        trace: disclosed,
        traceDigest: disclosedTraceDigest(disclosed),
        verification: discloseTraceVerification(authorityTraceVerificationOf(build, at), policy),
        operational: discloseOperationalView(view, disclosed),
        generatedAt: at,
      };
    },

    async metrics(authorizationHeader: string | undefined, rawQuery: OperationsQuery): Promise<OperationalMetrics> {
      authenticator.authorize(authorizationHeader, 'operations.read');
      closedQuery(rawQuery, []);
      // Separate reads, so a concurrent append can land between any two. Every counted set only grows, so
      // counters read before the scan and found unchanged after it all held at one instant, with the scan
      // inside it; otherwise read again, a bounded number of times. The read order makes the counters
      // coherent even then: each status before the total, and the claims after the scan that examined them.
      let before = await counters();
      for (let attempt = 1; ; attempt += 1) {
        const { operations, definitiveOnRead } = await scanOpenClaims();
        const after = await counters();
        const consistent = sameCounters(before, after);
        if (!consistent && attempt < METRICS_SNAPSHOT_ATTEMPTS) {
          before = after;
          continue;
        }
        // Claims outside the candidate set carry a definitive outcome row, written only after the canonical record it summarizes.
        // Within it, only what the traces just showed counts. Stated only from one consistent read of every candidate.
        const derived = consistent && operations.scan.complete ? after.executionClaims - operations.scan.examined + definitiveOnRead : null;
        const { total, allowed, denied, approvalRequired, indeterminate, issuanceWithheld, executionClaims } = after;
        return {
          decisions: { total, allowed, denied, approvalRequired, indeterminate },
          issuanceWithheld,
          executionClaims,
          // Never an impossible value: a derivation outside [0, claims] is not stated.
          confirmedOutcomes: derived !== null && derived >= 0 && derived <= executionClaims ? derived : null,
          unresolvedExecutions: operations.unresolvedExecutions,
          attentionRequired: operations.attentionRequired,
          scan: operations.scan,
          consistent,
          computedAt: now(),
          coverage: 'governance-store-counts-and-claim-scan',
        };
      }
    },

    async health(authorizationHeader: string | undefined, rawQuery: OperationsQuery): Promise<OperationalHealthView> {
      authenticator.authorize(authorizationHeader, 'operations.read');
      closedQuery(rawQuery, []);
      const report = await dependencies.health();
      const { operations } = await scanOpenClaims();
      return { health: report, operations: { ...operations, checkedAt: now() } };
    },
  });
}
