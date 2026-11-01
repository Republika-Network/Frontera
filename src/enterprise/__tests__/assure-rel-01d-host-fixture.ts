import { join } from 'node:path';
import Database from 'better-sqlite3';

import { bootEnterpriseHost, type EnterpriseHost } from '../host/enterprise-host.js';
import type { AssuranceEvidenceReference } from '../assurance/contracts.js';
import { withDeploymentWitness } from './core07-freshness-fixture.js';
import {
  ORG,
  SECRETS,
  bearer,
  call,
  capturingLogger,
  ctrl02Env,
  ctrl02File,
  recordingAdapter,
  type Reply,
  type Workspace,
} from './ctrl02-host-fixture.js';
import { PILOT_CONTROLS, PILOT_CUTOFF, PILOT_ENGAGEMENT, PILOT_ORG, PILOT_REVIEW_PLAN, PILOT_SUBJECT, pilotEvidence, pilotEvidenceId } from './assure-pilot-01-scenario.js';

/**
 * ASSURE-REL-01D: the real Enterprise Host (production posture: SQLite for
 * every store, authentication required, a governed-actions file, a deployment
 * witness) with Assurance reviewer credentials, `rn.sv@0.1.0` opted in, and
 * helpers that drive the operator interface over HTTP only.
 */

export const REL01D_SECRETS = {
  reviewer: 'REL01D_ASSURANCE_REVIEWER_SECRET_0f3a91c7e2d4b86a5c17',
  reviewer2: 'REL01D_ASSURANCE_REVIEWER_TWO_SECRET_7d2e04b9a16c3f85e2',
  approver: 'REL01D_ASSURANCE_APPROVER_SECRET_c81e5a0d9f3b2764a1e0',
  approver2: 'REL01D_ASSURANCE_APPROVER_TWO_SECRET_4b6f2a91e0d7c35b8f',
  dual: 'REL01D_ASSURANCE_DUAL_ROLE_SECRET_e93c1b7a5d0f2486c4b9',
} as const;

export const REL01D_IDS = {
  reviewer: 'rel01d-reviewer',
  reviewer2: 'rel01d-reviewer-2',
  approver: 'rel01d-approver',
  approver2: 'rel01d-approver-2',
  dual: 'rel01d-dual',
} as const;

const REVIEWERS = [
  { reviewerId: REL01D_IDS.reviewer, roles: ['assure.reviewer'], apiKeyEnv: 'REL01D_REVIEWER_KEY' },
  { reviewerId: REL01D_IDS.reviewer2, roles: ['assure.reviewer'], apiKeyEnv: 'REL01D_REVIEWER_TWO_KEY' },
  { reviewerId: REL01D_IDS.approver, roles: ['assure.report-release'], apiKeyEnv: 'REL01D_APPROVER_KEY' },
  { reviewerId: REL01D_IDS.approver2, roles: ['assure.report-release'], apiKeyEnv: 'REL01D_APPROVER_TWO_KEY' },
  { reviewerId: REL01D_IDS.dual, roles: ['assure.reviewer', 'assure.report-release'], apiKeyEnv: 'REL01D_DUAL_KEY' },
];

export const REL01D_AUTH = {
  reviewer: bearer(REL01D_SECRETS.reviewer),
  reviewer2: bearer(REL01D_SECRETS.reviewer2),
  approver: bearer(REL01D_SECRETS.approver),
  approver2: bearer(REL01D_SECRETS.approver2),
  dual: bearer(REL01D_SECRETS.dual),
  /** The organization API key the Host serves (`AOC_ENTERPRISE_API_KEYS`). Not a reviewer. */
  organizationKey: bearer(SECRETS.legacyKey),
  /** A CTRL-02 organization-administrator operator. Not a reviewer. */
  operator: bearer(SECRETS.administrator),
  unknown: bearer('REL01D_NOT_A_CONFIGURED_CREDENTIAL_000000000000000000'),
} as const;

export const ALL_SECRETS: readonly string[] = [...Object.values(REL01D_SECRETS), ...Object.values(SECRETS)];

/** The production-posture env with Assurance reviewers. `assurance` sets the REL-01D variables (rn.sv on by default). */
export function rel01dEnv(dir: string, assurance: { readonly frameworks?: string | undefined; readonly reviewerOnly?: boolean } = {}): Record<string, string | undefined> {
  const frameworks = 'frameworks' in assurance ? assurance.frameworks : 'rn.sv@0.1.0';
  return ctrl02Env(dir, ctrl02File({ assuranceReviewers: REVIEWERS }), {
    REL01D_REVIEWER_KEY: REL01D_SECRETS.reviewer,
    REL01D_REVIEWER_TWO_KEY: REL01D_SECRETS.reviewer2,
    REL01D_APPROVER_KEY: REL01D_SECRETS.approver,
    REL01D_APPROVER_TWO_KEY: REL01D_SECRETS.approver2,
    REL01D_DUAL_KEY: REL01D_SECRETS.dual,
    ...(frameworks !== undefined ? { AOC_ENTERPRISE_ASSURANCE_FRAMEWORKS: frameworks } : {}),
    ...(assurance.reviewerOnly === true ? { AOC_ENTERPRISE_ASSURANCE_REVIEWER_ONLY: 'true' } : {}),
  });
}

export interface Rel01dHost {
  readonly host: EnterpriseHost;
  readonly baseUrl: string;
  readonly dir: string;
  readonly assurancePath: string;
}

export async function bootRel01d(workspace: Workspace, dir: string, env: Record<string, string | undefined>): Promise<Rel01dHost> {
  const host = workspace.track(await bootEnterpriseHost({ env: await withDeploymentWitness(env), executionAdapters: [recordingAdapter()], logger: capturingLogger }));
  const { port } = await host.listen();
  return { host, baseUrl: `http://127.0.0.1:${port}`, dir, assurancePath: join(dir, 'assurance.sqlite') };
}

/** The issue date a report approved today may carry: today (UTC). An approval after the issue date is refused. */
export function todayIssue(): { readonly issuedOn: string; readonly reportVersion: string } {
  return { issuedOn: new Date().toISOString().slice(0, 10), reportVersion: '1.0' };
}

export const REL01D_ENGAGEMENT = PILOT_ENGAGEMENT;
export const REL01D_SUBJECT = PILOT_SUBJECT;

/** The PILOT-01 synthetic evidence set, re-homed into the Host's organization (the deliberately foreign SV-05 artifact stays foreign). */
export function hostEvidence(): AssuranceEvidenceReference[] {
  return pilotEvidence().map((reference) => (reference.organizationId === PILOT_ORG ? { ...reference, organizationId: ORG } : reference));
}

export async function createRnSvAssessment(baseUrl: string, authorization: string, extra: Record<string, unknown> = {}): Promise<Reply> {
  return call(baseUrl, 'POST', '/api/assurance/assessments', {
    authorization,
    body: {
      subject: { subjectType: 'system', subjectId: REL01D_SUBJECT, organizationId: ORG },
      frameworkId: 'rn.sv',
      frameworkVersion: '0.1.0',
      evidenceCutoffAt: PILOT_CUTOFF,
      purpose: 'ASSURE-REL-01D synthetic operator pilot',
      ...extra,
    },
  });
}

/** Records the PILOT-01 review plan over HTTP with `authorization`. Returns each reply. */
export async function reviewAllOverHttp(baseUrl: string, authorization: string, assessmentId: string, controls: readonly string[] = PILOT_CONTROLS): Promise<readonly Reply[]> {
  const replies: Reply[] = [];
  for (const controlId of controls) {
    const [outcome, evidence] = PILOT_REVIEW_PLAN[controlId] ?? ['insufficient_evidence'];
    replies.push(
      await call(baseUrl, 'POST', '/api/assurance/manual-reviews', {
        authorization,
        body: {
          assessmentId,
          controlId,
          outcome,
          rationale: `REL01D-RATIONALE-NEVER-LOGGED ${controlId}`,
          ...(evidence !== undefined ? { evidenceReferenceIds: evidence.map(pilotEvidenceId) } : {}),
        },
      }),
    );
  }
  return replies;
}

/** Create -> evidence -> evaluate -> review (by `reviewer`) -> evaluate+complete, all over HTTP. Returns the completed assessment id. */
export async function completedAssessmentOverHttp(baseUrl: string, reviewer: string = REL01D_AUTH.reviewer): Promise<string> {
  const created = await createRnSvAssessment(baseUrl, reviewer);
  if (created.status !== 201) throw new Error(`create failed: ${created.status} ${created.text.slice(0, 300)}`);
  const assessmentId = created.body['assessmentId'] as string;
  const collected = await call(baseUrl, 'POST', `/api/assurance/assessments/${assessmentId}/evidence`, { authorization: reviewer, body: { manualEvidence: hostEvidence() } });
  if (collected.status !== 200) throw new Error(`evidence failed: ${collected.status} ${collected.text.slice(0, 300)}`);
  const evaluated = await call(baseUrl, 'POST', `/api/assurance/assessments/${assessmentId}/evaluate`, { authorization: reviewer, body: { complete: false } });
  if (evaluated.status !== 200) throw new Error(`evaluate failed: ${evaluated.status} ${evaluated.text.slice(0, 300)}`);
  for (const reply of await reviewAllOverHttp(baseUrl, reviewer, assessmentId)) {
    if (reply.status !== 201) throw new Error(`review failed: ${reply.status} ${reply.text.slice(0, 300)}`);
  }
  const completed = await call(baseUrl, 'POST', `/api/assurance/assessments/${assessmentId}/evaluate`, { authorization: reviewer, body: {} });
  if (completed.status !== 200 || completed.body['status'] !== 'completed') throw new Error(`completion failed: ${completed.status} ${completed.text.slice(0, 300)}`);
  return assessmentId;
}

export function draftBody(): Record<string, unknown> {
  return { engagement: REL01D_ENGAGEMENT, issue: todayIssue() };
}

export function releaseBody(approvedContentDigest: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...draftBody(), approvedContentDigest, acknowledgements: { limitationsReviewed: true, commercialUseRestrictionAcknowledged: true }, ...extra };
}

/** A consistent copy of a WAL-mode SQLite file (a plain file copy could miss the log). */
export async function snapshotSqlite(source: string, destination: string): Promise<void> {
  const raw = new Database(source, { readonly: true, fileMustExist: true });
  try {
    await raw.backup(destination);
  } finally {
    raw.close();
  }
}
