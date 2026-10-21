import type { KernelEvaluationRequest } from '../../kernel/index.js';
import {
  GOVERNANCE_ATTRIBUTION_EVENT_TYPE,
  GOVERNANCE_ATTRIBUTION_VERSION,
  GOVERNANCE_STORE_CONTRACT_IDS,
  type GovernanceEvaluationAttribution,
  type GovernanceRecord,
} from './contracts.js';
import { GovernanceStoreError } from './errors.js';

/**
 * G-01A — the one reading and the one writing rule for an evaluation's
 * attribution. The Store seals what it is handed; it decides nothing about who
 * a caller is. What it does refuse is an attribution that contradicts the
 * request it is attached to, so a record can never say one actor in its
 * request and another in its attribution.
 */

const BASES = ['customer-principal', 'service-principal', 'legacy-asserted'] as const;
const SALT = /^[0-9a-f]{32}$/;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Closed shape of a well-formed attribution: exactly the fields its basis names, every one a non-empty string. */
export function isWellFormedAttribution(value: unknown): value is GovernanceEvaluationAttribution {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate['version'] !== GOVERNANCE_ATTRIBUTION_VERSION) return false;
  if (!BASES.includes(candidate['basis'] as (typeof BASES)[number])) return false;
  if (!isNonEmptyString(candidate['evaluatedActorId'])) return false;
  if (typeof candidate['salt'] !== 'string' || !SALT.test(candidate['salt'])) return false;
  const keys = Object.keys(candidate).filter((key) => candidate[key] !== undefined).sort();
  if (candidate['basis'] === 'legacy-asserted') {
    if (candidate['legacyScope'] !== 'organization' && candidate['legacyScope'] !== 'unscoped') return false;
    if (candidate['organizationId'] !== undefined && !isNonEmptyString(candidate['organizationId'])) return false;
    if (candidate['legacyScope'] === 'organization' && candidate['organizationId'] === undefined) return false;
    const allowed = ['basis', 'evaluatedActorId', 'legacyScope', 'organizationId', 'salt', 'version'];
    return keys.every((key) => allowed.includes(key));
  }
  if (!isNonEmptyString(candidate['organizationId']) || !isNonEmptyString(candidate['requestingPrincipalId'])) return false;
  return JSON.stringify(keys) === JSON.stringify(['basis', 'evaluatedActorId', 'organizationId', 'requestingPrincipalId', 'salt', 'version']);
}

/** Refuses, before anything is written, an attribution that is malformed or names another actor or organization than its request. */
export function assertAttributionMatchesRequest(attribution: GovernanceEvaluationAttribution, request: KernelEvaluationRequest): void {
  if (!isWellFormedAttribution(attribution)) {
    throw new GovernanceStoreError('GOVERNANCE_STORE_VALIDATION_ERROR', 'Invalid append input: attribution is not a well-formed aoc.governance-attribution.v1 value.');
  }
  if (attribution.evaluatedActorId !== request.actor.id || attribution.organizationId !== request.organization?.id) {
    throw new GovernanceStoreError('GOVERNANCE_STORE_VALIDATION_ERROR', 'Invalid append input: attribution must name exactly the request’s actor and organization.');
  }
}

/** The event payload an attribution is sealed as. A fresh, plain copy: nothing the caller handed in is persisted by reference. */
export function attributionEventPayload(attribution: GovernanceEvaluationAttribution): Readonly<Record<string, unknown>> {
  return { attribution: { ...attribution } };
}

export type RecordedAttribution =
  | { readonly status: 'attributed'; readonly attribution: GovernanceEvaluationAttribution }
  /** No attribution event: committed before G-01A, by the governed-action path, or with authentication disabled. Carries no authenticated identity. */
  | { readonly status: 'unattributed' }
  /** More than one attribution event, or one this build cannot read. Never treated as either of the above. */
  | { readonly status: 'unreadable' };

/** Reads a stored aggregate's attribution. Exactly one well-formed attribution event, matching the record's own request, or it is not attributed. */
export function readRecordedAttribution(record: GovernanceRecord): RecordedAttribution {
  const events = record.events.filter((event) => event.eventType === GOVERNANCE_ATTRIBUTION_EVENT_TYPE);
  if (events.length === 0) return { status: 'unattributed' };
  const [event] = events;
  if (events.length !== 1 || event === undefined || event.eventContract !== GOVERNANCE_STORE_CONTRACT_IDS.eventRecord) return { status: 'unreadable' };
  const attribution = event.eventPayload['attribution'];
  if (!isWellFormedAttribution(attribution)) return { status: 'unreadable' };
  if (attribution.evaluatedActorId !== record.request.actorId || attribution.organizationId !== record.request.organizationId) return { status: 'unreadable' };
  return { status: 'attributed', attribution };
}

/**
 * Whether two attributions name the same requester: the same basis, the same
 * requesting principal (or legacy scope), in the same organization, for the
 * same actor. The only rule an idempotent replay may cross.
 */
export function sameRequester(left: GovernanceEvaluationAttribution, right: GovernanceEvaluationAttribution): boolean {
  if (left.basis !== right.basis || left.evaluatedActorId !== right.evaluatedActorId || left.organizationId !== right.organizationId) return false;
  if (left.basis === 'legacy-asserted' && right.basis === 'legacy-asserted') return left.legacyScope === right.legacyScope;
  if (left.basis !== 'legacy-asserted' && right.basis !== 'legacy-asserted') return left.requestingPrincipalId === right.requestingPrincipalId;
  return false;
}
