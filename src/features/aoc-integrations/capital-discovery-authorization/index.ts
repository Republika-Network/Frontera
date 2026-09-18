import type { ResourceRef } from '@aoc/protocol';
import { legacyResourceIdentifier } from '@aoc-enterprise/scoped-access';
import type { KernelEvaluationRequest, KernelEvaluationResult } from '../../../kernel/contracts/index.js';

export const CAPITAL_DISCOVERY_RESOURCE_KINDS = {
  OpportunityProjectionRef: 'capital-discovery-opportunity-projection',
  QuoteRef: 'capital-discovery-quote',
  FinancingCaseRef: 'capital-discovery-financing-case',
} as const;

export const CAPITAL_DISCOVERY_ACTION_RESOURCE = {
  'capital.opportunity.view': 'OpportunityProjectionRef',
  'capital.quote.submit': 'OpportunityProjectionRef',
  'capital.offer.accept': 'QuoteRef',
  'capital.quote.withdraw': 'QuoteRef',
  'capital.financing.execute': 'FinancingCaseRef',
} as const;

export type CapitalDiscoveryActionId = keyof typeof CAPITAL_DISCOVERY_ACTION_RESOURCE;
export type CapitalDiscoveryResourceType = keyof typeof CAPITAL_DISCOVERY_RESOURCE_KINDS;
export interface CapitalDiscoveryResource {
  readonly type: CapitalDiscoveryResourceType;
  readonly ref: string;
}
export interface CapitalDiscoveryAuthorizationIntent {
  readonly requestId: string;
  readonly actorId: string;
  readonly trustDomainId: string;
  readonly actorOrgRef?: string;
  readonly principalActorId?: string;
  readonly action: CapitalDiscoveryActionId;
  readonly resource: CapitalDiscoveryResource;
  readonly requestedAt: string;
  readonly correlationId?: string;
}

// Consumers receive the canonical kernel result without a second decision vocabulary.
export type CapitalDiscoveryAuthorizationResult = KernelEvaluationResult;

export type CapitalDiscoveryAuthorizationErrorCode =
  | 'INVALID_INTENT'
  | 'UNKNOWN_CAPITAL_DISCOVERY_ACTION'
  | 'UNKNOWN_CAPITAL_DISCOVERY_RESOURCE_TYPE'
  | 'ACTION_RESOURCE_MISMATCH'
  | 'INVALID_EXTERNAL_REF'
  | 'INVALID_REQUEST_ID'
  | 'INVALID_ACTOR_ID'
  | 'INVALID_TRUST_DOMAIN_ID'
  | 'INVALID_ORGANIZATION_ID'
  | 'INVALID_PRINCIPAL_ACTOR_ID'
  | 'INVALID_CORRELATION_ID'
  | 'INVALID_REQUESTED_AT';

export class CapitalDiscoveryAuthorizationError extends Error {
  constructor(readonly code: CapitalDiscoveryAuthorizationErrorCode) {
    super(code);
    this.name = 'CapitalDiscoveryAuthorizationError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
function identifier(value: unknown, code: CapitalDiscoveryAuthorizationErrorCode, maxLength = 256): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || value !== value.trim() || CONTROL.test(value)) {
    throw new CapitalDiscoveryAuthorizationError(code);
  }
  return value;
}

function optionalIdentifier(value: unknown, code: CapitalDiscoveryAuthorizationErrorCode): string | undefined {
  return value === undefined ? undefined : identifier(value, code);
}

function externalResourceRef(value: unknown): string {
  const ref = identifier(value, 'INVALID_EXTERNAL_REF', 512);
  if (ref.includes(':')) {
    throw new CapitalDiscoveryAuthorizationError('INVALID_EXTERNAL_REF');
  }
  return ref;
}

function validRequestedAt(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/u.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , , offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]!
    && Number(hourText) <= 23 && Number(minuteText) <= 59 && Number(secondText) <= 59
    && (offsetHourText === undefined || (Number(offsetHourText) <= 23 && Number(offsetMinuteText) <= 59))
    && !Number.isNaN(Date.parse(value));
}

function resourceType(value: unknown): CapitalDiscoveryResourceType {
  if (typeof value !== 'string' || !Object.hasOwn(CAPITAL_DISCOVERY_RESOURCE_KINDS, value)) {
    throw new CapitalDiscoveryAuthorizationError('UNKNOWN_CAPITAL_DISCOVERY_RESOURCE_TYPE');
  }
  return value as CapitalDiscoveryResourceType;
}

function actionId(value: unknown): CapitalDiscoveryActionId {
  if (typeof value !== 'string' || !Object.hasOwn(CAPITAL_DISCOVERY_ACTION_RESOURCE, value)) {
    throw new CapitalDiscoveryAuthorizationError('UNKNOWN_CAPITAL_DISCOVERY_ACTION');
  }
  return value as CapitalDiscoveryActionId;
}

/** Maps only a bounded opaque identity; neither tenant nor attributes are caller-controlled. */
export function toCapitalDiscoveryResourceRef(resource: unknown): ResourceRef {
  if (!isRecord(resource) || !hasOnlyKeys(resource, ['type', 'ref'])) {
    throw new CapitalDiscoveryAuthorizationError('INVALID_EXTERNAL_REF');
  }
  const type = resourceType(resource.type);
  const ref = externalResourceRef(resource.ref);
  return { kind: CAPITAL_DISCOVERY_RESOURCE_KINDS[type], id: ref };
}

export function capitalDiscoveryResourceScope(resource: unknown): string {
  return legacyResourceIdentifier(toCapitalDiscoveryResourceRef(resource));
}

/** Parses untrusted input into the existing kernel request. No business facts can pass through. */
export function buildCapitalDiscoveryKernelRequest(intent: unknown): KernelEvaluationRequest {
  if (!isRecord(intent) || !hasOnlyKeys(intent, [
    'requestId', 'actorId', 'trustDomainId', 'actorOrgRef', 'principalActorId',
    'action', 'resource', 'requestedAt', 'correlationId',
  ])) {
    throw new CapitalDiscoveryAuthorizationError('INVALID_INTENT');
  }
  const requestId = identifier(intent.requestId, 'INVALID_REQUEST_ID');
  const actorId = identifier(intent.actorId, 'INVALID_ACTOR_ID');
  const trustDomainId = identifier(intent.trustDomainId, 'INVALID_TRUST_DOMAIN_ID');
  const actorOrgRef = optionalIdentifier(intent.actorOrgRef, 'INVALID_ORGANIZATION_ID');
  const principalActorId = optionalIdentifier(intent.principalActorId, 'INVALID_PRINCIPAL_ACTOR_ID');
  const correlationId = optionalIdentifier(intent.correlationId, 'INVALID_CORRELATION_ID');
  const action = actionId(intent.action);
  if (!isRecord(intent.resource) || !hasOnlyKeys(intent.resource, ['type', 'ref'])) {
    throw new CapitalDiscoveryAuthorizationError('INVALID_EXTERNAL_REF');
  }
  const type = resourceType(intent.resource.type);
  if (CAPITAL_DISCOVERY_ACTION_RESOURCE[action] !== type) {
    throw new CapitalDiscoveryAuthorizationError('ACTION_RESOURCE_MISMATCH');
  }
  const resource = toCapitalDiscoveryResourceRef(intent.resource);
  const requestedAt = intent.requestedAt;
  if (!validRequestedAt(requestedAt)) {
    throw new CapitalDiscoveryAuthorizationError('INVALID_REQUESTED_AT');
  }
  return {
    requestId,
    actor: { id: actorId, trustDomainId, ...(principalActorId === undefined ? {} : { principalId: principalActorId }) },
    action: { type: action, resourceScope: legacyResourceIdentifier(resource) },
    requestedAt,
    ...(actorOrgRef === undefined ? {} : { organization: { id: actorOrgRef } }),
    ...(correlationId === undefined ? {} : { correlationId }),
  };
}
