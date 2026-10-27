/**
 * AUTH-04C — the Authority gateway contract (AUTH-04B, AUTH-04B2), as the web
 * client reads it.
 *
 * Every response is parsed into these shapes or refused: a field the gateway
 * does not send is never invented, and a malformed response is an error, not a
 * blank. The Host stays authoritative for every value here — the organization,
 * the operator, the request identity, the subject digest, policy, standing and
 * the verdict. The client never computes or overrides any of them.
 */

export type Verdict = 'approve' | 'reject';

export interface SessionInfo {
  readonly operatorId: string;
  readonly displayName: string;
  readonly organizationId: string;
  readonly csrfToken: string;
}

export interface Quorum {
  readonly minimumApprovals: number;
  readonly counted: number;
}

export interface ApprovalSummary {
  readonly approvalRequestId: string;
  readonly status: string;
  readonly action: string;
  readonly resourceScope: string;
  readonly governanceProfile: string;
  readonly requestedAt: string;
  readonly requestExpiresAt: string;
  readonly subjectDigest: string;
  readonly quorum: Quorum;
  /** The verdicts this human's role and standing reach, as the Host says. */
  readonly verdicts: readonly Verdict[];
}

export interface SubjectParameter {
  readonly dimension: string;
  readonly type: string;
  readonly value: string | number;
}

export interface ApprovalSubjectView {
  readonly actorId: string;
  readonly principalActorId: string | null;
  readonly action: string;
  readonly resourceScope: string;
  readonly counterpartyId: string | null;
  readonly amount: { readonly value: string; readonly unit: string } | null;
  readonly parameters: readonly SubjectParameter[];
  readonly governanceProfile: string;
  readonly decision: { readonly status: string; readonly reasonCodes: readonly string[]; readonly evaluatedAt: string };
  readonly contextValidUntil: string | null;
}

export interface ApprovalRequirementView {
  readonly minimumApprovals: number;
  readonly requestTtlSeconds: number;
  readonly approvalValiditySeconds: number;
  readonly requiredEvidence: readonly string[];
}

export interface ApprovalDetail extends ApprovalSummary {
  /** The exact canonical bytes the subject digest covers, as the Host serialized them. */
  readonly canonicalSubject: string;
  readonly subject: ApprovalSubjectView;
  readonly requirement: ApprovalRequirementView;
}

export interface DecisionChallenge {
  readonly publicKey: AssertionOptionsJSON;
  readonly commitment: string;
  readonly approvalRequestId: string;
  readonly subjectDigest: string;
  readonly verdict: Verdict;
  readonly expiresAt: string;
}

export type DecisionSubmission =
  | { readonly outcome: 'recorded'; readonly commitment: string; readonly verdict: Verdict; readonly approvalRequestId: string; readonly requestStatus: string; readonly execution: string }
  | { readonly outcome: 'refused'; readonly commitment: string; readonly code: string; readonly reasonCode: string | null };

/** The decision states the gateway reports (AUTH-04B §7). Nothing else is shown as a decision state. */
export const DECISION_STATES = ['challenge_open', 'challenge_expired', 'approved', 'rejected', 'refused', 'abandoned', 'unsettled', 'unknown'] as const;
export type DecisionState = (typeof DECISION_STATES)[number];

export interface DecisionStatus {
  readonly commitment: string;
  readonly approvalRequestId: string;
  readonly verdict: Verdict;
  readonly decision: DecisionState;
  readonly code: string | null;
  readonly request: { readonly status: string; readonly superseded: boolean } | null;
  readonly execution: string;
}

/** WebAuthn options as JSON (base64url binary fields), exactly as the gateway sends them. */
export interface AssertionOptionsJSON {
  readonly rpId: string;
  readonly challenge: string;
  readonly timeout: number;
  readonly userVerification: string;
  readonly allowCredentials: readonly { readonly type: 'public-key'; readonly id: string }[];
}

export interface CreationOptionsJSON {
  readonly rp: { readonly id: string; readonly name: string };
  readonly user: { readonly id: string; readonly name: string; readonly displayName: string };
  readonly challenge: string;
  readonly pubKeyCredParams: readonly { readonly type: 'public-key'; readonly alg: number }[];
  readonly timeout: number;
  readonly attestation: string;
  readonly excludeCredentials: readonly { readonly type: 'public-key'; readonly id: string }[];
  readonly authenticatorSelection: { readonly residentKey: string; readonly requireResidentKey: boolean; readonly userVerification: string };
}

/** A response that does not have the contract's shape. */
export class ContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContractError';
  }
}

type Json = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

function record(value: unknown, what: string): Json {
  if (!isRecord(value)) throw new ContractError(`${what} is not an object.`);
  return value;
}

function text(source: Json, key: string, what: string): string {
  const value = source[key];
  if (typeof value !== 'string') throw new ContractError(`${what}.${key} is not a string.`);
  return value;
}

function nullableText(source: Json, key: string, what: string): string | null {
  const value = source[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new ContractError(`${what}.${key} is not a string.`);
  return value;
}

function count(source: Json, key: string, what: string): number {
  const value = source[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new ContractError(`${what}.${key} is not a number.`);
  return value;
}

function list(source: Json, key: string, what: string): readonly unknown[] {
  const value = source[key];
  if (!Array.isArray(value)) throw new ContractError(`${what}.${key} is not a list.`);
  return value;
}

const verdictOf = (value: unknown, what: string): Verdict => {
  if (value !== 'approve' && value !== 'reject') throw new ContractError(`${what} is not a verdict.`);
  return value;
};

export function parseSession(value: unknown): SessionInfo {
  const body = record(value, 'session');
  return { operatorId: text(body, 'operatorId', 'session'), displayName: text(body, 'displayName', 'session'), organizationId: text(body, 'organizationId', 'session'), csrfToken: text(body, 'csrfToken', 'session') };
}

export function parseSummary(value: unknown): ApprovalSummary {
  const body = record(value, 'approval');
  const quorum = record(body['quorum'], 'approval.quorum');
  return {
    approvalRequestId: text(body, 'approvalRequestId', 'approval'),
    status: text(body, 'status', 'approval'),
    action: text(body, 'action', 'approval'),
    resourceScope: text(body, 'resourceScope', 'approval'),
    governanceProfile: text(body, 'governanceProfile', 'approval'),
    requestedAt: text(body, 'requestedAt', 'approval'),
    requestExpiresAt: text(body, 'requestExpiresAt', 'approval'),
    subjectDigest: text(body, 'subjectDigest', 'approval'),
    quorum: { minimumApprovals: count(quorum, 'minimumApprovals', 'quorum'), counted: count(quorum, 'counted', 'quorum') },
    verdicts: list(body, 'verdicts', 'approval').map((entry) => verdictOf(entry, 'approval.verdicts[]')),
  };
}

export function parseInbox(value: unknown): readonly ApprovalSummary[] {
  return list(record(value, 'inbox'), 'approvals', 'inbox').map(parseSummary);
}

export function parseDetail(value: unknown): ApprovalDetail {
  const body = record(value, 'approval');
  const subject = record(body['subject'], 'approval.subject');
  const decision = record(subject['decision'], 'subject.decision');
  const requirement = record(body['requirement'], 'approval.requirement');
  const amount = subject['amount'];
  return {
    ...parseSummary(value),
    canonicalSubject: text(body, 'canonicalSubject', 'approval'),
    subject: {
      actorId: text(subject, 'actorId', 'subject'),
      principalActorId: nullableText(subject, 'principalActorId', 'subject'),
      action: text(subject, 'action', 'subject'),
      resourceScope: text(subject, 'resourceScope', 'subject'),
      counterpartyId: nullableText(subject, 'counterpartyId', 'subject'),
      amount: amount === null || amount === undefined ? null : { value: text(record(amount, 'subject.amount'), 'value', 'amount'), unit: text(record(amount, 'subject.amount'), 'unit', 'amount') },
      parameters: list(subject, 'parameters', 'subject').map((entry) => {
        const parameter = record(entry, 'subject.parameters[]');
        const parameterValue = parameter['value'];
        if (typeof parameterValue !== 'string' && typeof parameterValue !== 'number') throw new ContractError('subject.parameters[].value is not a string or number.');
        return { dimension: text(parameter, 'dimension', 'parameter'), type: text(parameter, 'type', 'parameter'), value: parameterValue };
      }),
      governanceProfile: text(subject, 'governanceProfile', 'subject'),
      decision: { status: text(decision, 'status', 'decision'), reasonCodes: list(decision, 'reasonCodes', 'decision').map((code) => (typeof code === 'string' ? code : String(code))), evaluatedAt: text(decision, 'evaluatedAt', 'decision') },
      contextValidUntil: nullableText(subject, 'contextValidUntil', 'subject'),
    },
    requirement: {
      minimumApprovals: count(requirement, 'minimumApprovals', 'requirement'),
      requestTtlSeconds: count(requirement, 'requestTtlSeconds', 'requirement'),
      approvalValiditySeconds: count(requirement, 'approvalValiditySeconds', 'requirement'),
      requiredEvidence: list(requirement, 'requiredEvidence', 'requirement').map((entry) => (typeof entry === 'string' ? entry : String(entry))),
    },
  };
}

function parseAssertionOptions(value: unknown): AssertionOptionsJSON {
  const body = record(value, 'publicKey');
  return {
    rpId: text(body, 'rpId', 'publicKey'),
    challenge: text(body, 'challenge', 'publicKey'),
    timeout: count(body, 'timeout', 'publicKey'),
    userVerification: text(body, 'userVerification', 'publicKey'),
    allowCredentials: list(body, 'allowCredentials', 'publicKey').map((entry) => ({ type: 'public-key' as const, id: text(record(entry, 'allowCredentials[]'), 'id', 'allowCredentials[]') })),
  };
}

export function parseLoginOptions(value: unknown): AssertionOptionsJSON {
  return parseAssertionOptions(record(value, 'login options')['publicKey']);
}

export function parseCreationOptions(value: unknown): CreationOptionsJSON {
  const body = record(record(value, 'enrolment options')['publicKey'], 'publicKey');
  const rp = record(body['rp'], 'publicKey.rp');
  const user = record(body['user'], 'publicKey.user');
  const selection = record(body['authenticatorSelection'], 'publicKey.authenticatorSelection');
  return {
    rp: { id: text(rp, 'id', 'rp'), name: text(rp, 'name', 'rp') },
    user: { id: text(user, 'id', 'user'), name: text(user, 'name', 'user'), displayName: text(user, 'displayName', 'user') },
    challenge: text(body, 'challenge', 'publicKey'),
    pubKeyCredParams: list(body, 'pubKeyCredParams', 'publicKey').map((entry) => ({ type: 'public-key' as const, alg: count(record(entry, 'pubKeyCredParams[]'), 'alg', 'pubKeyCredParams[]') })),
    timeout: count(body, 'timeout', 'publicKey'),
    attestation: text(body, 'attestation', 'publicKey'),
    excludeCredentials: list(body, 'excludeCredentials', 'publicKey').map((entry) => ({ type: 'public-key' as const, id: text(record(entry, 'excludeCredentials[]'), 'id', 'excludeCredentials[]') })),
    authenticatorSelection: { residentKey: text(selection, 'residentKey', 'selection'), requireResidentKey: selection['requireResidentKey'] === true, userVerification: text(selection, 'userVerification', 'selection') },
  };
}

export function parseChallenge(value: unknown): DecisionChallenge {
  const body = record(value, 'decision challenge');
  return {
    publicKey: parseAssertionOptions(body['publicKey']),
    commitment: text(body, 'commitment', 'challenge'),
    approvalRequestId: text(body, 'approvalRequestId', 'challenge'),
    subjectDigest: text(body, 'subjectDigest', 'challenge'),
    verdict: verdictOf(body['verdict'], 'challenge.verdict'),
    expiresAt: text(body, 'expiresAt', 'challenge'),
  };
}

export function parseSubmission(value: unknown): DecisionSubmission {
  const body = record(value, 'decision');
  if (body['outcome'] === 'recorded') {
    return {
      outcome: 'recorded',
      commitment: text(body, 'commitment', 'decision'),
      verdict: verdictOf(body['verdict'], 'decision.verdict'),
      approvalRequestId: text(body, 'approvalRequestId', 'decision'),
      requestStatus: text(record(body['approval'], 'decision.approval'), 'status', 'approval'),
      execution: text(body, 'execution', 'decision'),
    };
  }
  if (body['outcome'] === 'refused') return { outcome: 'refused', commitment: text(body, 'commitment', 'decision'), code: text(body, 'code', 'decision'), reasonCode: nullableText(body, 'reasonCode', 'decision') };
  throw new ContractError('decision.outcome is neither recorded nor refused.');
}

export function parseStatus(value: unknown): DecisionStatus {
  const body = record(value, 'decision status');
  const decision = body['decision'];
  if (typeof decision !== 'string' || !(DECISION_STATES as readonly string[]).includes(decision)) throw new ContractError('decision status is not a known state.');
  const request = body['request'];
  return {
    commitment: text(body, 'commitment', 'status'),
    approvalRequestId: text(body, 'approvalRequestId', 'status'),
    verdict: verdictOf(body['verdict'], 'status.verdict'),
    decision: decision as DecisionState,
    code: nullableText(body, 'code', 'status'),
    request: request === null || request === undefined ? null : { status: text(record(request, 'status.request'), 'status', 'request'), superseded: record(request, 'status.request')['superseded'] === true },
    execution: text(body, 'execution', 'status'),
  };
}

/** A gateway error body: `{ error: { code, message, commitment? } }`. */
export interface GatewayErrorBody {
  readonly code: string;
  readonly message: string;
  readonly commitment: string | null;
}

export function parseError(value: unknown): GatewayErrorBody | undefined {
  if (!isRecord(value) || !isRecord(value['error'])) return undefined;
  const error = value['error'];
  return {
    code: typeof error['code'] === 'string' ? error['code'] : 'UNKNOWN',
    message: typeof error['message'] === 'string' ? error['message'] : '',
    commitment: typeof error['commitment'] === 'string' ? error['commitment'] : null,
  };
}
