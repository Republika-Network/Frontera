import type { IncomingMessage, ServerResponse } from 'node:http';

import { EnterpriseHttpError, mapEvidenceErrorToHttp, mapAgentPassportErrorToHttp, mapAssuranceErrorToHttp } from '../api/enterprise-http-errors.js';
import type { AocEnterprise } from '../composition/composition-root.js';
import { getInternalEnterpriseConfiguration } from '../composition/composition-root.js';
import { validateEvidenceBuildRequestBody, validateEvidenceTraceQuery, validateEvidenceTraceVerifyQuery, validateEvidenceVerifyRequestBody, toEvidenceBundleResponseBody, toEvidenceVerifyResponseBody } from '../api/evidence-contract.js';
import { isEvidenceError } from '../evidence/errors.js';
import { resolveGovernanceAccessContext } from '../orchestration/governance-read-service.js';
import {
  validateActorRequestBody,
  validateBuildViewRequestBody,
  validateIssuePassportRequestBody,
  validateLinkEvidenceRequestBody,
  validateLinkGovernanceRequestBody,
  validateRetireRequestBody,
  validateRevokeRequestBody,
  validateSuspendRequestBody,
  validateVerifyRequestBody,
} from '../api/passport-contract.js';
import { isAgentPassportError } from '../passport/errors.js';
import { isAssuranceError } from '../assurance/errors.js';
import {
  validateCreateAssessmentRequestBody,
  validateEvaluateAssessmentRequestBody,
  validateFindingEventRequestBody,
  validateManualReviewRequestBody,
  validateReassessRequestBody,
  validateSignalRequestBody,
} from '../api/assurance-contract.js';
import { GOVERNANCE_EVALUATE_AMOUNT_LOCATION, GOVERNED_ACTION_AMOUNT_LOCATION, parseJsonWithExactMonetaryNumber } from '../api/exact-monetary-json.js';
import { ADMIN_MAX_BODY_BYTES } from '../authority-administration/contracts.js';

/** P9: v1 monetary JSON numbers are read from their exact source text, never through IEEE-754. */
const parseGovernedActionBody = (text: string): unknown => parseJsonWithExactMonetaryNumber(text, GOVERNED_ACTION_AMOUNT_LOCATION);
const parseGovernanceEvaluateBody = (text: string): unknown => parseJsonWithExactMonetaryNumber(text, GOVERNANCE_EVALUATE_AMOUNT_LOCATION);

const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB -- generous for a governance-evaluation payload, small enough to bound memory per request.

/**
 * Reads and parses a JSON body. `parse` defaults to `JSON.parse`; the two routes
 * that carry a monetary JSON number pass a parser that keeps that number's exact
 * source text (`api/exact-monetary-json.ts`, P9).
 */
function readRequestBody(req: IncomingMessage, parse: (text: string) => unknown = JSON.parse, maxBytes: number = MAX_BODY_BYTES): Promise<unknown> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    req.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        rejectPromise(new EnterpriseHttpError(400, 'INVALID_REQUEST', 'Request body exceeds the maximum accepted size.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolvePromise({});
        return;
      }
      try {
        resolvePromise(parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        rejectPromise(new EnterpriseHttpError(400, 'INVALID_REQUEST', 'Request body must be valid JSON.'));
      }
    });
    req.on('error', rejectPromise);
  });
}

const JSON_CONTENT_TYPE = /^application\/json\s*(?:;.*)?$/i;

/**
 * CTRL-01: the body reader handed to the authority administration service,
 * which calls it only after the caller is authorized. JSON only, and bounded
 * far below the general limit: an administrative body is a reason or a scope.
 */
function administrationBodyReader(req: IncomingMessage): () => Promise<unknown> {
  return () => {
    const contentType = req.headers['content-type'];
    if (typeof contentType !== 'string' || !JSON_CONTENT_TYPE.test(contentType)) {
      return Promise.reject(new EnterpriseHttpError(415, 'INVALID_REQUEST', 'Administration requests must be sent as application/json.'));
    }
    return readRequestBody(req, JSON.parse, ADMIN_MAX_BODY_BYTES);
  };
}

function writeJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function writeError(res: ServerResponse, error: unknown, enterprise: AocEnterprise, route: string): void {
  const httpError =
    error instanceof EnterpriseHttpError
      ? error
      : isEvidenceError(error)
        ? mapEvidenceErrorToHttp(error)
        : isAgentPassportError(error)
          ? mapAgentPassportErrorToHttp(error)
          : isAssuranceError(error)
            ? mapAssuranceErrorToHttp(error)
            : undefined;
  if (httpError !== undefined) {
    writeJson(res, httpError.httpStatus, {
      error: {
        code: httpError.code,
        message: httpError.message,
        ...(httpError.details !== undefined ? { details: httpError.details } : {}),
        ...(httpError.extra ?? {}),
      },
    });
    return;
  }
  enterprise.logger.error('enterprise.http.unhandled_error', { route });
  writeJson(res, 500, { error: { code: 'INFRASTRUCTURE_FAILURE', message: 'An unexpected Enterprise Host failure occurred.' } });
}

/**
 * The only module in this tree that knows about `IncomingMessage`/
 * `ServerResponse`. Everything it does is translate HTTP <-> the
 * framework-agnostic `AocEnterprise` calls -- no governance logic, no
 * persistence, no composition lives here.
 */
export function createEnterpriseRequestListener(enterprise: AocEnterprise): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const method = req.method ?? 'GET';
    const routeLabel = `${method} ${(req.url ?? '/').slice(0, 256)}`;
    const fail = (error: unknown): void => writeError(res, normalizePathDecodeError(error), enterprise, routeLabel);
    try {
      dispatch();
    } catch (error) {
      fail(error);
    }

    // Everything reachable from here must fail closed: a synchronous throw
    // (auth rejection, malformed percent-encoding, invalid URL) becomes an
    // HTTP error envelope via `fail`, never an uncaught process exception.
    function dispatch(): void {
      const url = new URL(req.url ?? '/', 'http://localhost');

      if (method === 'GET' && url.pathname === '/health') {
        enterprise
          .health()
          .then((report) => writeJson(res, report.status === 'unhealthy' ? 503 : 200, report))
          .catch(fail);
        return;
      }

      if (method === 'GET' && url.pathname === '/live') {
        const live = enterprise.isLive();
        writeJson(res, live ? 200 : 503, { live, lifecycleState: enterprise.lifecycleState() });
        return;
      }

      // Ready means "can do its job now", not only "started": a Host whose
      // lifecycle is up but whose health is `unhealthy` — a required module
      // failing, such as the authenticated grant store's revocation-state proof
      // on a governed-action Host, or an unreachable Governance Store — is not
      // ready. Liveness (`/live`) stays lifecycle-only.
      if (method === 'GET' && url.pathname === '/ready') {
        if (!enterprise.isReady()) {
          writeJson(res, 503, { ready: false, lifecycleState: enterprise.lifecycleState() });
          return;
        }
        enterprise
          .health()
          .then((report) => {
            const ready = report.status !== 'unhealthy';
            writeJson(res, ready ? 200 : 503, { ready, lifecycleState: enterprise.lifecycleState(), status: report.status });
          })
          .catch(() => writeJson(res, 503, { ready: false, lifecycleState: enterprise.lifecycleState() }));
        return;
      }

      if (method === 'POST' && url.pathname === '/api/governance/evaluate') {
        const idempotencyKeyHeader = req.headers['idempotency-key'];
        const idempotencyKey = Array.isArray(idempotencyKeyHeader) ? idempotencyKeyHeader[0] : idempotencyKeyHeader;
        readRequestBody(req, parseGovernanceEvaluateBody)
          .then((rawBody) =>
            enterprise.evaluate(rawBody, {
              ...(req.headers.authorization !== undefined ? { authorizationHeader: req.headers.authorization } : {}),
              ...(idempotencyKey !== undefined && idempotencyKey.length > 0 ? { idempotencyKey } : {}),
            }),
          )
          .then((outcome) => writeJson(res, outcome.httpStatus, outcome.body))
          .catch(fail);
        return;
      }

      // -- P5 customer governed actions. Capability-gated: mounted only when
      // the Host composed BOTH customer identity admission and the Governed
      // Action Orchestrator; otherwise this falls through to the unmounted-route
      // 404 below. Admission, intent validation and everything after them live
      // inside `enterprise.governAction` -- this adapter only routes. The body's
      // own `idempotencyKey` is canonical; no `Idempotency-Key` header is read.
      if (method === 'POST' && url.pathname === '/api/governed-actions') {
        const governAction =
          enterprise.customerIdentityAdmission !== undefined && enterprise.governedActionOrchestrator !== undefined ? enterprise.governAction : undefined;
        if (governAction !== undefined) {
          readRequestBody(req, parseGovernedActionBody)
            .then((rawBody) => governAction(rawBody, req.headers.authorization !== undefined ? { authorizationHeader: req.headers.authorization } : {}))
            .then((outcome) => writeJson(res, outcome.httpStatus, outcome.body))
            .catch(fail);
          return;
        }
      }

      // -- CTRL-01 authority administration. Mounted only when the Host composed
      // `authorityAdministration` (an administrator is configured); otherwise
      // every path below falls through to the unmounted-route 404. The service
      // authenticates the administrator, derives the operator identity and runs
      // the existing authoritative operation — this adapter only routes. Every
      // mutation is a POST; a GET never changes anything.
      if (url.pathname.startsWith('/api/admin/') && enterprise.authorityAdministration !== undefined) {
        const administration = enterprise.authorityAdministration;
        const auth = req.headers.authorization;
        // -- CTRL-02 operator plane. Mounted only when the Host composed
        // `operatorControl` (CTRL-02 operators are configured). The service
        // authenticates the operator, checks the role's permission before any
        // body is read, derives organization and operator identity, and calls
        // the existing authoritative services — this adapter only routes.
        const operatorControl = enterprise.operatorControl;
        const operatorRoute = operatorControl === undefined ? undefined : matchOperatorRoute(method, url.pathname);
        if (operatorControl !== undefined && operatorRoute !== undefined) {
          const query = Object.fromEntries(url.searchParams.entries());
          const respond = (promise: Promise<unknown>): void => {
            promise.then((body) => writeJson(res, 200, body)).catch(fail);
          };
          switch (operatorRoute.kind) {
            case 'organization':
              respond(operatorControl.describeOrganization(auth, query));
              return;
            case 'agents':
              respond(operatorControl.listAgents(auth, query));
              return;
            case 'agent':
              respond(operatorControl.inspectAgent(auth, operatorRoute.actorId, query));
              return;
            case 'agent-credential-issue':
              respond(operatorControl.issueAgentCredential(auth, operatorRoute.actorId, administrationBodyReader(req)));
              return;
            case 'agent-credential-rotate':
              respond(operatorControl.rotateAgentCredential(auth, operatorRoute.actorId, operatorRoute.credentialId, administrationBodyReader(req)));
              return;
            case 'agent-credential-revoke':
              respond(operatorControl.revokeAgentCredential(auth, operatorRoute.actorId, operatorRoute.credentialId, administrationBodyReader(req)));
              return;
            case 'entities':
              respond(operatorControl.listAuthorityEntities(auth, query));
              return;
            case 'entity-create':
              respond(operatorControl.provisionAuthorityEntity(auth, operatorRoute.entityKind, administrationBodyReader(req)));
              return;
            case 'profiles':
              respond(operatorControl.listGovernanceProfiles(auth, query));
              return;
            case 'profile-transition':
              respond(operatorControl.transitionGovernanceProfile(auth, operatorRoute.profileId, operatorRoute.version, operatorRoute.transition, administrationBodyReader(req)));
              return;
            case 'decision-activity':
              respond(operatorControl.listDecisionActivity(auth, query));
              return;
            case 'decision-evidence':
              respond(operatorControl.inspectDecisionEvidence(auth, operatorRoute.evaluationId, query));
              return;
          }
        }
        // -- CTRL-04 approval workflow (operator plane). Mounted only when the Host
        // composed `operatorApprovals` (operators configured and CORE-05
        // approvals composed). The service authenticates and authorizes the
        // operator before any body is read and derives the approval actor from
        // the authenticated principal — this adapter only routes.
        const operatorApprovals = enterprise.operatorApprovals;
        const approvalRoute = operatorApprovals === undefined ? undefined : matchApprovalRoute(method, url.pathname);
        if (operatorApprovals !== undefined && approvalRoute !== undefined) {
          const query = Object.fromEntries(url.searchParams.entries());
          const respond = (promise: Promise<unknown>): void => {
            promise.then((body) => writeJson(res, 200, body)).catch(fail);
          };
          switch (approvalRoute.kind) {
            case 'approvals':
              respond(operatorApprovals.listApprovals(auth, query));
              return;
            case 'approval':
              respond(operatorApprovals.inspectApproval(auth, approvalRoute.approvalRequestId, query));
              return;
            case 'approval-command':
              respond(operatorApprovals.command(auth, approvalRoute.verb, approvalRoute.approvalRequestId, administrationBodyReader(req)));
              return;
          }
        }
        const route = matchAdministrationRoute(method, url.pathname);
        if (route !== undefined) {
          const respond = (promise: Promise<unknown>): void => {
            promise.then((body) => writeJson(res, 200, body)).catch(fail);
          };
          switch (route.kind) {
            case 'grant':
              respond(administration.inspectGrant(auth, route.id));
              return;
            case 'execution':
              respond(administration.inspectExecutionGrant(auth, route.id));
              return;
            case 'grant-revoke':
              respond(administration.revokeGrant(auth, route.id, administrationBodyReader(req)));
              return;
            case 'entity':
              respond(administration.inspectAuthorityEntity(auth, route.entityKind, route.id));
              return;
            case 'entity-revoke':
              respond(administration.revokeAuthorityEntity(auth, route.entityKind, route.id, administrationBodyReader(req)));
              return;
            case 'emergency-controls':
              respond(administration.listEmergencyControls(auth));
              return;
            case 'emergency-control-activate':
              respond(administration.activateEmergencyControl(auth, administrationBodyReader(req)));
              return;
            case 'emergency-control-release':
              respond(administration.releaseEmergencyControl(auth, administrationBodyReader(req)));
              return;
          }
        }
      }

      // -- PR-005 Evidence Bundle endpoints. Tenant scoping is resolved
      // entirely inside `enterprise.evidence` (never here), the same way the
      // PR-004 governance-read routes below defer to `governanceReads`.
      if (method === 'POST' && url.pathname === '/api/evidence/build') {
        readRequestBody(req)
          .then((rawBody) => enterprise.evidence.build(req.headers.authorization, validateEvidenceBuildRequestBody(rawBody)))
          .then((record) => writeJson(res, 201, toEvidenceBundleResponseBody(record)))
          .catch(fail);
        return;
      }

      if (method === 'POST' && url.pathname === '/api/evidence/verify') {
        readRequestBody(req)
          .then((rawBody) => enterprise.evidence.verify(req.headers.authorization, validateEvidenceVerifyRequestBody(rawBody).bundleId))
          .then((result) => writeJson(res, 200, toEvidenceVerifyResponseBody(result)))
          .catch(fail);
        return;
      }

      // -- ASSURE-01 Unified Authority-to-Outcome Trace: two pure reads over the
      // canonical stores, scoped exactly as the bundle routes above. The
      // request id is the only path input; the query is closed.
      if (method === 'GET') {
        const traceVerifyMatch = /^\/api\/evidence\/traces\/([^/]+)\/verify$/.exec(url.pathname);
        if (traceVerifyMatch?.[1] !== undefined) {
          const requestId = decodeURIComponent(traceVerifyMatch[1]);
          Promise.resolve()
            .then(() => validateEvidenceTraceVerifyQuery(url.searchParams))
            .then(() => enterprise.evidence.verifyTrace(req.headers.authorization, requestId))
            .then((verification) => writeJson(res, 200, verification))
            .catch(fail);
          return;
        }
        const traceMatch = /^\/api\/evidence\/traces\/([^/]+)$/.exec(url.pathname);
        if (traceMatch?.[1] !== undefined) {
          const requestId = decodeURIComponent(traceMatch[1]);
          Promise.resolve()
            .then(() => validateEvidenceTraceQuery(url.searchParams))
            .then(({ level }) => enterprise.evidence.getTrace(req.headers.authorization, requestId, level))
            .then((view) => writeJson(res, 200, view))
            .catch(fail);
          return;
        }
      }

      if (method === 'GET') {
        const evidenceMatch = /^\/api\/evidence\/([^/]+)$/.exec(url.pathname);
        if (evidenceMatch?.[1] !== undefined) {
          const bundleId = decodeURIComponent(evidenceMatch[1]);
          enterprise.evidence
            .getByBundleId(req.headers.authorization, bundleId)
            .then((record) => {
              if (record === null) {
                writeJson(res, 404, { error: { code: 'EVIDENCE_BUNDLE_NOT_FOUND', message: `No Evidence Bundle for bundleId '${bundleId}'.` } });
                return;
              }
              writeJson(res, 200, toEvidenceBundleResponseBody(record));
            })
            .catch(fail);
          return;
        }
      }

      // -- PR-004 Governance Store read/verify endpoints. All access-context
      // resolution and tenant scoping happens inside `enterprise.governanceReads`
      // (never here); this adapter only routes.
      if (method === 'GET') {
        const readMatch = matchGovernanceReadRoute(url.pathname);
        if (readMatch !== undefined) {
          const auth = req.headers.authorization;
          const respond = (promise: Promise<unknown>, notFoundMessage: string) =>
            promise
              .then((recordOrResult) => {
                if (recordOrResult === null) {
                  writeJson(res, 404, { error: { code: 'GOVERNANCE_RECORD_NOT_FOUND', message: notFoundMessage } });
                  return;
                }
                writeJson(res, 200, recordOrResult);
              })
              .catch(fail);

          switch (readMatch.kind) {
            case 'evaluation':
              respond(enterprise.governanceReads.getByEvaluationId(auth, readMatch.id), `No governance record for evaluationId '${readMatch.id}'.`);
              return;
            case 'evaluation-verify':
              respond(enterprise.governanceReads.verify(auth, readMatch.id), `No governance record for evaluationId '${readMatch.id}'.`);
              return;
            case 'decision':
              respond(enterprise.governanceReads.getByDecisionId(auth, readMatch.id), `No governance record for decisionId '${readMatch.id}'.`);
              return;
            case 'request':
              respond(enterprise.governanceReads.getByRequestId(auth, readMatch.id), `No governance record for requestId '${readMatch.id}'.`);
              return;
          }
        }
      }

      // -- PR-007 Assurance Runtime endpoints (mission section 58). Tenant
      // scoping, control logic, evidence selection, scoring, and eligibility
      // all live inside `enterprise.assurance` -- this adapter only routes.
      if (url.pathname.startsWith('/api/assurance/')) {
        const context = resolveGovernanceAccessContext(req.headers.authorization, getInternalEnterpriseConfiguration(enterprise));
        const { assurance } = enterprise;

        if (method === 'POST' && url.pathname === '/api/assurance/assessments') {
          readRequestBody(req)
            .then((rawBody) => assurance.createAssessment(context, validateCreateAssessmentRequestBody(rawBody)))
            .then((assessment) => writeJson(res, 201, assessment))
            .catch(fail);
          return;
        }

        const assessmentAction = /^\/api\/assurance\/assessments\/([^/]+)\/(evaluate|verify|findings)$/.exec(url.pathname);
        if (assessmentAction?.[1] !== undefined && assessmentAction[2] !== undefined) {
          const assessmentId = decodeURIComponent(assessmentAction[1]);
          if (method === 'POST' && assessmentAction[2] === 'evaluate') {
            readRequestBody(req)
              .then(async (rawBody) => {
                const body = validateEvaluateAssessmentRequestBody(rawBody);
                let assessment = await assurance.evaluateAssessment(context, assessmentId);
                if (body.complete !== false && assessment.status === 'evaluating') {
                  assessment = await assurance.completeAssessment(context, assessmentId);
                }
                return assessment;
              })
              .then((assessment) => writeJson(res, 200, assessment))
              .catch(fail);
            return;
          }
          if (method === 'POST' && assessmentAction[2] === 'verify') {
            assurance
              .verifyAssessment(context, assessmentId)
              .then((result) => writeJson(res, result.valid ? 200 : 409, result))
              .catch(fail);
            return;
          }
          if (method === 'GET' && assessmentAction[2] === 'findings') {
            assurance
              .listFindings(context, assessmentId)
              .then((findings) => writeJson(res, 200, { assessmentId, findings }))
              .catch(fail);
            return;
          }
        }

        const assessmentMatch = /^\/api\/assurance\/assessments\/([^/]+)$/.exec(url.pathname);
        if (method === 'GET' && assessmentMatch?.[1] !== undefined) {
          const assessmentId = decodeURIComponent(assessmentMatch[1]);
          assurance
            .getAssessment(context, assessmentId)
            .then((assessment) => {
              if (assessment === null) {
                writeJson(res, 404, { error: { code: 'ASSURANCE_ASSESSMENT_NOT_FOUND', message: `No Assurance assessment for assessmentId '${assessmentId}'.` } });
                return;
              }
              writeJson(res, 200, assessment);
            })
            .catch(fail);
          return;
        }

        const findingEventsMatch = /^\/api\/assurance\/findings\/([^/]+)\/events$/.exec(url.pathname);
        if (method === 'POST' && findingEventsMatch?.[1] !== undefined) {
          const findingId = decodeURIComponent(findingEventsMatch[1]);
          readRequestBody(req)
            .then((rawBody) => assurance.appendFindingEvent(context, validateFindingEventRequestBody(rawBody, findingId)))
            .then((event) => writeJson(res, 201, event))
            .catch(fail);
          return;
        }

        if (method === 'POST' && url.pathname === '/api/assurance/manual-reviews') {
          readRequestBody(req)
            .then((rawBody) => assurance.recordManualReview(context, validateManualReviewRequestBody(rawBody)))
            .then((review) => writeJson(res, 201, review))
            .catch(fail);
          return;
        }

        if (method === 'POST' && url.pathname === '/api/assurance/signals') {
          readRequestBody(req)
            .then((rawBody) => assurance.processSignal(context, validateSignalRequestBody(rawBody)))
            .then((result) => writeJson(res, 201, result))
            .catch(fail);
          return;
        }

        const subjectMatch = /^\/api\/assurance\/subjects\/([^/]+)\/(state|reassess)$/.exec(url.pathname);
        if (subjectMatch?.[1] !== undefined && subjectMatch[2] !== undefined) {
          const subjectId = decodeURIComponent(subjectMatch[1]);
          if (method === 'GET' && subjectMatch[2] === 'state') {
            const frameworkId = url.searchParams.get('frameworkId') ?? undefined;
            const frameworkVersion = url.searchParams.get('frameworkVersion') ?? undefined;
            assurance
              .getContinuousState(context, subjectId, frameworkId, frameworkVersion)
              .then((state) => writeJson(res, 200, state))
              .catch(fail);
            return;
          }
          if (method === 'POST' && subjectMatch[2] === 'reassess') {
            readRequestBody(req)
              .then((rawBody) => assurance.requestReassessment(context, validateReassessRequestBody(rawBody, subjectId)))
              .then((assessment) => writeJson(res, 201, assessment))
              .catch(fail);
            return;
          }
        }
      }

      // -- PR-006 Agent Passport Runtime endpoints. Tenant scoping is resolved
      // entirely inside `enterprise.passports` (never here), the same way
      // Evidence and Governance-read routes above defer to their services.
      if (method === 'POST' && url.pathname === '/api/passports') {
        const context = resolveGovernanceAccessContext(req.headers.authorization, getInternalEnterpriseConfiguration(enterprise));
        readRequestBody(req)
          .then((rawBody) => enterprise.passports.issuePassport(context, validateIssuePassportRequestBody(rawBody)))
          .then((result) => writeJson(res, result.created ? 201 : 200, result))
          .catch(fail);
        return;
      }

      if (method === 'GET') {
        const match = matchPassportRoute(url.pathname);
        if (match !== undefined) {
          const context = resolveGovernanceAccessContext(req.headers.authorization, getInternalEnterpriseConfiguration(enterprise));
          if (match.kind === 'passport') {
            enterprise.passports
              .getPassport(context, match.id)
              .then((load) => writeJson(res, load.status === 'complete' ? 200 : 500, load))
              .catch(fail);
            return;
          }
          if (match.kind === 'events') {
            enterprise.passports
              .getEvents(context, match.id)
              .then((events) => writeJson(res, 200, { passportId: match.id, events }))
              .catch(fail);
            return;
          }
          if (match.kind === 'history') {
            enterprise.passports
              .getHistorySummary(context, match.id)
              .then((summary) => writeJson(res, 200, summary))
              .catch(fail);
            return;
          }
        }
      }

      if (method === 'POST') {
        const match = matchPassportActionRoute(url.pathname);
        if (match !== undefined) {
          const context = resolveGovernanceAccessContext(req.headers.authorization, getInternalEnterpriseConfiguration(enterprise));
          const { passports } = enterprise;
          switch (match.action) {
            case 'activate':
              readRequestBody(req)
                .then((rawBody) => passports.activatePassport(context, match.id, validateActorRequestBody(rawBody).actorId))
                .then((passport) => writeJson(res, 200, passport))
                .catch(fail);
              return;
            case 'suspend':
              readRequestBody(req)
                .then((rawBody) => passports.suspendPassport(context, match.id, validateSuspendRequestBody(rawBody)))
                .then((passport) => writeJson(res, 200, passport))
                .catch(fail);
              return;
            case 'reactivate':
              readRequestBody(req)
                .then((rawBody) => passports.reactivatePassport(context, match.id, validateActorRequestBody(rawBody, 'reactivatedBy').actorId))
                .then((passport) => writeJson(res, 200, passport))
                .catch(fail);
              return;
            case 'revoke':
              readRequestBody(req)
                .then((rawBody) => passports.revokePassport(context, match.id, validateRevokeRequestBody(rawBody)))
                .then((passport) => writeJson(res, 200, passport))
                .catch(fail);
              return;
            case 'retire':
              readRequestBody(req)
                .then((rawBody) => passports.retirePassport(context, match.id, validateRetireRequestBody(rawBody)))
                .then((passport) => writeJson(res, 200, passport))
                .catch(fail);
              return;
            case 'verify':
              readRequestBody(req)
                .then((rawBody) => passports.verifyPassport(context, match.id, validateVerifyRequestBody(rawBody).mode))
                .then((result) => writeJson(res, result.valid ? 200 : 409, result))
                .catch(fail);
              return;
            case 'evidence':
              readRequestBody(req)
                .then((rawBody) => {
                  const body = validateLinkEvidenceRequestBody(rawBody);
                  return passports.linkEvidenceBundle(context, match.id, body.reference, body.actorId);
                })
                .then((passport) => writeJson(res, 200, passport))
                .catch(fail);
              return;
            case 'governance':
              readRequestBody(req)
                .then((rawBody) => {
                  const body = validateLinkGovernanceRequestBody(rawBody);
                  return passports.linkGovernanceRecord(context, match.id, body.reference, body.actorId);
                })
                .then((passport) => writeJson(res, 200, passport))
                .catch(fail);
              return;
            case 'views':
              readRequestBody(req)
                .then((rawBody) => {
                  const body = validateBuildViewRequestBody(rawBody);
                  return passports.buildView(context, match.id, body.viewType, body.generatedBy);
                })
                .then((view) => writeJson(res, 201, view))
                .catch(fail);
              return;
          }
        }
      }

      writeJson(res, 404, { error: { code: 'NOT_FOUND', message: `No route for ${method} ${url.pathname}.` } });
    }
  };
}

function normalizePathDecodeError(error: unknown): unknown {
  return error instanceof URIError
    ? new EnterpriseHttpError(400, 'INVALID_REQUEST', 'Request path contains malformed percent-encoding.')
    : error;
}

type AdministrationRoute =
  | { readonly kind: 'grant' | 'grant-revoke' | 'execution'; readonly id: string }
  | { readonly kind: 'entity' | 'entity-revoke'; readonly entityKind: string; readonly id: string }
  | { readonly kind: 'emergency-controls' | 'emergency-control-activate' | 'emergency-control-release' };

/**
 * CTRL-01 routes. Reads are `GET`, mutations are `POST` to an explicit verb
 * path; anything else — including a `GET` on a mutation path — matches nothing
 * and is a 404. There is deliberately no route that un-revokes, deletes a
 * revocation, issues a grant or provisions authority.
 */
function matchAdministrationRoute(method: string, pathname: string): AdministrationRoute | undefined {
  if (method === 'GET') {
    const grant = /^\/api\/admin\/authority\/grants\/([^/]+)$/.exec(pathname);
    if (grant?.[1] !== undefined) return { kind: 'grant', id: decodeURIComponent(grant[1]) };
    const entity = /^\/api\/admin\/authority\/entities\/([^/]+)\/([^/]+)$/.exec(pathname);
    if (entity?.[1] !== undefined && entity[2] !== undefined) return { kind: 'entity', entityKind: decodeURIComponent(entity[1]), id: decodeURIComponent(entity[2]) };
    const execution = /^\/api\/admin\/authority\/executions\/([^/]+)$/.exec(pathname);
    if (execution?.[1] !== undefined) return { kind: 'execution', id: decodeURIComponent(execution[1]) };
    if (/^\/api\/admin\/emergency-controls$/.exec(pathname) !== null) return { kind: 'emergency-controls' };
    return undefined;
  }
  if (method === 'POST') {
    const grant = /^\/api\/admin\/authority\/grants\/([^/]+)\/revoke$/.exec(pathname);
    if (grant?.[1] !== undefined) return { kind: 'grant-revoke', id: decodeURIComponent(grant[1]) };
    const entity = /^\/api\/admin\/authority\/entities\/([^/]+)\/([^/]+)\/revoke$/.exec(pathname);
    if (entity?.[1] !== undefined && entity[2] !== undefined) return { kind: 'entity-revoke', entityKind: decodeURIComponent(entity[1]), id: decodeURIComponent(entity[2]) };
    const transition = /^\/api\/admin\/emergency-controls\/(activate|release)$/.exec(pathname);
    if (transition?.[1] === 'activate') return { kind: 'emergency-control-activate' };
    if (transition?.[1] === 'release') return { kind: 'emergency-control-release' };
  }
  return undefined;
}

type OperatorRoute =
  | { readonly kind: 'organization' | 'agents' | 'entities' | 'profiles' | 'decision-activity' }
  | { readonly kind: 'decision-evidence'; readonly evaluationId: string }
  | { readonly kind: 'agent' | 'agent-credential-issue'; readonly actorId: string }
  | { readonly kind: 'agent-credential-rotate' | 'agent-credential-revoke'; readonly actorId: string; readonly credentialId: string }
  | { readonly kind: 'entity-create'; readonly entityKind: string }
  | { readonly kind: 'profile-transition'; readonly profileId: string; readonly version: string; readonly transition: 'activate' | 'retire' };

/**
 * CTRL-02 operator routes (and CTRL-03's two reads). Reads are `GET`; every mutation is a `POST` to an
 * explicit path — create an authority entity of one kind, issue / rotate /
 * revoke an agent credential, activate / retire a Governance Profile version.
 * There is deliberately no route that mints a bounded grant, un-revokes,
 * deletes, or names an organization: the organization is the Host's own.
 */
function matchOperatorRoute(method: string, pathname: string): OperatorRoute | undefined {
  if (method === 'GET') {
    if (/^\/api\/admin\/organization$/.exec(pathname) !== null) return { kind: 'organization' };
    if (/^\/api\/admin\/agents$/.exec(pathname) !== null) return { kind: 'agents' };
    const agent = /^\/api\/admin\/agents\/([^/]+)$/.exec(pathname);
    if (agent?.[1] !== undefined) return { kind: 'agent', actorId: decodeURIComponent(agent[1]) };
    if (/^\/api\/admin\/authority\/entities$/.exec(pathname) !== null) return { kind: 'entities' };
    if (/^\/api\/admin\/governance-profiles$/.exec(pathname) !== null) return { kind: 'profiles' };
    // CTRL-03 — read-only: committed decisions, and one decision record with its verification.
    if (/^\/api\/admin\/activity\/decisions$/.exec(pathname) !== null) return { kind: 'decision-activity' };
    const evidence = /^\/api\/admin\/evidence\/decisions\/([^/]+)$/.exec(pathname);
    if (evidence?.[1] !== undefined) return { kind: 'decision-evidence', evaluationId: decodeURIComponent(evidence[1]) };
    return undefined;
  }
  if (method === 'POST') {
    const create = /^\/api\/admin\/authority\/entities\/([^/]+)$/.exec(pathname);
    if (create?.[1] !== undefined) return { kind: 'entity-create', entityKind: decodeURIComponent(create[1]) };
    const issue = /^\/api\/admin\/agents\/([^/]+)\/credentials$/.exec(pathname);
    if (issue?.[1] !== undefined) return { kind: 'agent-credential-issue', actorId: decodeURIComponent(issue[1]) };
    const credential = /^\/api\/admin\/agents\/([^/]+)\/credentials\/([^/]+)\/(rotate|revoke)$/.exec(pathname);
    if (credential?.[1] !== undefined && credential[2] !== undefined) {
      return {
        kind: credential[3] === 'rotate' ? 'agent-credential-rotate' : 'agent-credential-revoke',
        actorId: decodeURIComponent(credential[1]),
        credentialId: decodeURIComponent(credential[2]),
      };
    }
    const profile = /^\/api\/admin\/governance-profiles\/([^/]+)\/versions\/([^/]+)\/(activate|retire)$/.exec(pathname);
    if (profile?.[1] !== undefined && profile[2] !== undefined) {
      return { kind: 'profile-transition', profileId: decodeURIComponent(profile[1]), version: decodeURIComponent(profile[2]), transition: profile[3] === 'activate' ? 'activate' : 'retire' };
    }
  }
  return undefined;
}

type ApprovalRoute =
  | { readonly kind: 'approvals' }
  | { readonly kind: 'approval'; readonly approvalRequestId: string }
  | { readonly kind: 'approval-command'; readonly approvalRequestId: string; readonly verb: 'approve' | 'reject' | 'request-changes' | 'escalate' | 'revoke' };

/**
 * CTRL-04 approval routes. Reads are `GET`; each verdict is a `POST` to its own
 * explicit verb path (so the one permission it needs is known before any body
 * is read). There is deliberately no route that un-rejects, un-revokes,
 * restores, deletes or executes, and none that names an approver or an
 * organization.
 */
function matchApprovalRoute(method: string, pathname: string): ApprovalRoute | undefined {
  if (method === 'GET') {
    if (/^\/api\/admin\/approvals$/.exec(pathname) !== null) return { kind: 'approvals' };
    const approval = /^\/api\/admin\/approvals\/([^/]+)$/.exec(pathname);
    if (approval?.[1] !== undefined) return { kind: 'approval', approvalRequestId: decodeURIComponent(approval[1]) };
    return undefined;
  }
  if (method === 'POST') {
    const command = /^\/api\/admin\/approvals\/([^/]+)\/(approve|reject|request-changes|escalate|revoke)$/.exec(pathname);
    if (command?.[1] !== undefined && command[2] !== undefined) {
      return { kind: 'approval-command', approvalRequestId: decodeURIComponent(command[1]), verb: command[2] as 'approve' | 'reject' | 'request-changes' | 'escalate' | 'revoke' };
    }
  }
  return undefined;
}

type GovernanceReadRoute =
  | { readonly kind: 'evaluation' | 'evaluation-verify' | 'decision' | 'request'; readonly id: string };

function matchGovernanceReadRoute(pathname: string): GovernanceReadRoute | undefined {
  const verifyMatch = /^\/api\/governance\/evaluations\/([^/]+)\/verify$/.exec(pathname);
  if (verifyMatch?.[1] !== undefined) return { kind: 'evaluation-verify', id: decodeURIComponent(verifyMatch[1]) };
  const evaluationMatch = /^\/api\/governance\/evaluations\/([^/]+)$/.exec(pathname);
  if (evaluationMatch?.[1] !== undefined) return { kind: 'evaluation', id: decodeURIComponent(evaluationMatch[1]) };
  const decisionMatch = /^\/api\/governance\/decisions\/([^/]+)$/.exec(pathname);
  if (decisionMatch?.[1] !== undefined) return { kind: 'decision', id: decodeURIComponent(decisionMatch[1]) };
  const requestMatch = /^\/api\/governance\/requests\/([^/]+)$/.exec(pathname);
  if (requestMatch?.[1] !== undefined) return { kind: 'request', id: decodeURIComponent(requestMatch[1]) };
  return undefined;
}

type PassportReadRoute = { readonly kind: 'passport' | 'events' | 'history'; readonly id: string };

/** `GET /api/passports/{id}`, `GET /api/passports/{id}/events`, `GET /api/passports/{id}/history`. */
function matchPassportRoute(pathname: string): PassportReadRoute | undefined {
  const eventsMatch = /^\/api\/passports\/([^/]+)\/events$/.exec(pathname);
  if (eventsMatch?.[1] !== undefined) return { kind: 'events', id: decodeURIComponent(eventsMatch[1]) };
  const historyMatch = /^\/api\/passports\/([^/]+)\/history$/.exec(pathname);
  if (historyMatch?.[1] !== undefined) return { kind: 'history', id: decodeURIComponent(historyMatch[1]) };
  const passportMatch = /^\/api\/passports\/([^/]+)$/.exec(pathname);
  if (passportMatch?.[1] !== undefined) return { kind: 'passport', id: decodeURIComponent(passportMatch[1]) };
  return undefined;
}

type PassportActionRoute = {
  readonly action: 'activate' | 'suspend' | 'reactivate' | 'revoke' | 'retire' | 'verify' | 'evidence' | 'governance' | 'views';
  readonly id: string;
};

const PASSPORT_ACTIONS: readonly PassportActionRoute['action'][] = ['activate', 'suspend', 'reactivate', 'revoke', 'retire', 'verify', 'evidence', 'governance', 'views'];

/** `POST /api/passports/{id}/{action}` for every mutating/derived Passport action. */
function matchPassportActionRoute(pathname: string): PassportActionRoute | undefined {
  const match = /^\/api\/passports\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  const action = match[2];
  if (!(PASSPORT_ACTIONS as readonly string[]).includes(action)) return undefined;
  return { action: action as PassportActionRoute['action'], id: decodeURIComponent(match[1]) };
}
