import {
  CAPITAL_DISCOVERY_ACTION_RESOURCE,
  CAPITAL_DISCOVERY_RESOURCE_KINDS,
  type CapitalDiscoveryActionId,
  type CapitalDiscoveryResource,
} from '../capital-discovery-authorization/index.js';
import type {
  ContextFactObservation,
  ContextFactValue,
  ContextResolutionQuery,
  ContextResolverOutput,
  ContextResolverPort,
} from '../../context-resolution-runtime/index.js';

/** A host read of one deployment-declared scalar key from Capital Discovery state. */
export interface CapitalDiscoveryContextReading {
  readonly key: string;
  readonly value: ContextFactValue;
  readonly observedAt: string;
  readonly maxAgeSeconds?: number;
}

export interface CapitalDiscoveryContextReadInput {
  readonly keys: readonly string[];
  readonly action: CapitalDiscoveryActionId;
  readonly resource: CapitalDiscoveryResource;
  readonly actorId: string;
  readonly trustDomainId: string;
  readonly organizationId?: string;
  readonly at: string;
}

/** Implemented by the host against trusted server-side marketplace state. */
export interface CapitalDiscoveryContextReader {
  readContext(input: CapitalDiscoveryContextReadInput): Promise<readonly CapitalDiscoveryContextReading[]>;
}

const RESOURCE_TYPES = Object.keys(CAPITAL_DISCOVERY_RESOURCE_KINDS) as (keyof typeof CAPITAL_DISCOVERY_RESOURCE_KINDS)[];
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

export class CapitalDiscoveryContextProviderError extends Error {
  readonly code = 'DUPLICATE_CONTEXT_READING';
  constructor() {
    super('DUPLICATE_CONTEXT_READING');
    this.name = 'CapitalDiscoveryContextProviderError';
  }
}

function validObservedAt(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/u.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offsetHourText, offsetMinuteText] = match;
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

function resourceFromScope(scope: string): CapitalDiscoveryResource | undefined {
  const separator = scope.indexOf(':');
  if (separator < 0 || separator !== scope.lastIndexOf(':')) return undefined;
  const kind = scope.slice(0, separator);
  const ref = scope.slice(separator + 1);
  if (ref.length === 0 || ref.length > 512 || ref !== ref.trim() || CONTROL.test(ref)) return undefined;
  const type = RESOURCE_TYPES.find((candidate) => CAPITAL_DISCOVERY_RESOURCE_KINDS[candidate] === kind);
  return type === undefined ? undefined : { type, ref };
}

function validReading(value: unknown, keys: ReadonlySet<string>): value is CapitalDiscoveryContextReading {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (typeof row.key !== 'string' || !keys.has(row.key)) return false;
  if (typeof row.value !== 'string' && typeof row.value !== 'boolean' &&
    !(typeof row.value === 'number' && Number.isFinite(row.value))) return false;
  if (!validObservedAt(row.observedAt)) return false;
  return row.maxAgeSeconds === undefined ||
    (typeof row.maxAgeSeconds === 'number' && Number.isFinite(row.maxAgeSeconds) && row.maxAgeSeconds > 0);
}

/** Observations only: the configured Frontera source registry classifies them. */
export function createCapitalDiscoveryContextProvider(options: {
  readonly reader: CapitalDiscoveryContextReader;
  readonly sourceId: string;
}): ContextResolverPort {
  if (typeof options.sourceId !== 'string' || options.sourceId.length === 0 ||
    options.sourceId.length > 256 || options.sourceId !== options.sourceId.trim() || CONTROL.test(options.sourceId)) {
    throw new Error('Capital Discovery context source ID is required.');
  }
  const { reader, sourceId } = options;
  return {
    async resolveContext(query: ContextResolutionQuery): Promise<ContextResolverOutput> {
      if (!Object.hasOwn(CAPITAL_DISCOVERY_ACTION_RESOURCE, query.action)) return { observations: [] };
      const resource = resourceFromScope(query.resourceScope);
      const action = query.action as CapitalDiscoveryActionId;
      if (resource === undefined || resource.type !== CAPITAL_DISCOVERY_ACTION_RESOURCE[action]) {
        return { observations: [] };
      }
      const keys = [...new Set(query.keys)];
      if (keys.length === 0) return { observations: [] };
      const readings = await reader.readContext({
        keys, action, resource, actorId: query.actorId, trustDomainId: query.trustDomainId,
        ...(query.organizationId === undefined ? {} : { organizationId: query.organizationId }), at: query.at,
      });
      const requested = new Set(keys);
      const accepted = new Set<string>();
      const observations: ContextFactObservation[] = [];
      for (const reading of readings) {
        if (!validReading(reading, requested)) continue;
        if (accepted.has(reading.key)) throw new CapitalDiscoveryContextProviderError();
        accepted.add(reading.key);
        observations.push({
          key: reading.key, value: reading.value, sourceId, observedAt: reading.observedAt,
          ...(reading.maxAgeSeconds === undefined ? {} : { maxAgeSeconds: reading.maxAgeSeconds }),
        });
      }
      return { observations };
    },
  };
}
