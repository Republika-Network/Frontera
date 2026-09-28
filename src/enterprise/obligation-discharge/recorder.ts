import {
  OBLIGATION_DISCHARGE_OUTCOMES,
  isObligationType,
  type ObligationDischargeObservation,
  type ObligationDischargeProviderOutput,
  type ObligationDischargeProviderPort,
  type ObligationDischargeQuery,
  type ObligationDischargeSource,
} from '../../features/obligation-runtime/index.js';
import type { ObligationDischargeContent, ObligationDischargeRecordInput, ObligationDischargeStore, ObligationDischargeWriterContext, StoredObligationDischarge } from './contracts.js';
import { ObligationDischargeError } from './errors.js';

/** Bounds on the opaque strings a report carries. */
const MAX_TEXT = 256;

export interface ObligationDischargeRecorderOptions {
  readonly store: ObligationDischargeStore;
  /** The configured discharge sources. A report citing any other source is refused before it is written. */
  readonly sources: readonly ObligationDischargeSource[];
  /** The one organization this Host serves; every row is written under it. */
  readonly organizationId: string;
  readonly now: () => string;
}

/**
 * The trusted writer's surface (CORE-04). **In-process only**: it is exposed on
 * the Enterprise handle beside `kernelAuthorityProvisioning`, and never over
 * HTTP — not by the governed-action API and not by the CTRL-01 administration
 * API, whose authority does not expand.
 */
export interface ObligationDischargeRecorder {
  record(writer: ObligationDischargeWriterContext, input: ObligationDischargeRecordInput): Promise<StoredObligationDischarge>;
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_TEXT;
}

function readOwn(source: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  return descriptor !== undefined && 'value' in descriptor ? (descriptor.value as unknown) : undefined;
}

function invalid(message: string): never {
  throw new ObligationDischargeError('OBLIGATION_DISCHARGE_INVALID', message);
}

/**
 * Builds the recorder.
 *
 * What it checks is **who may write and whether the report is well-formed**,
 * never what the report means: a well-formed `discharged` report from a
 * self-reported source is written, and the obligation runtime then leaves the
 * obligation `discharged` — unsatisfied — because that is what a self-reported
 * discharge is worth. Only a configured `independent` source's report can
 * carry an obligation to `verified`, and only a configured `independent`
 * source may waive one. There is no field here by which a writer states a
 * resulting state.
 */
export function createObligationDischargeRecorder(options: ObligationDischargeRecorderOptions): ObligationDischargeRecorder {
  const sourceIds = new Set(options.sources.map((source) => source.id));
  const { store, organizationId, now } = options;

  // One report at a time, so the time-order check below and the append see the same history.
  let tail: Promise<unknown> = Promise.resolve();

  return Object.freeze({
    record(writer: ObligationDischargeWriterContext, input: ObligationDischargeRecordInput): Promise<StoredObligationDischarge> {
      const result = tail.then(() => recordOnce(writer, input));
      tail = result.catch(() => undefined);
      return result;
    },
  });

  async function recordOnce(writer: ObligationDischargeWriterContext, input: ObligationDischargeRecordInput): Promise<StoredObligationDischarge> {
    {
      // Own data properties only, on plain objects: an inherited or getter
      // `system: true` is not a trusted writer.
      if (writer === null || typeof writer !== 'object' || readOwn(writer, 'system') !== true || !isText(readOwn(writer, 'actorId'))) {
        throw new ObligationDischargeError('OBLIGATION_DISCHARGE_WRITER_UNTRUSTED', 'Recording an obligation discharge requires a trusted writer context { system: true, actorId }.');
      }
      if (input === null || typeof input !== 'object') invalid('The report must be an object.');
      const correlation = readOwn(input, 'correlation');
      if (correlation === null || typeof correlation !== 'object') invalid('The report must name the decision correlation it is about.');
      const requestId = readOwn(correlation, 'requestId');
      const action = readOwn(correlation, 'action');
      const resourceScope = readOwn(correlation, 'resourceScope');
      if (!isText(requestId) || !isText(action) || !isText(resourceScope)) invalid('The correlation must name a requestId, an action and a resourceScope.');
      const obligationType = readOwn(input, 'obligationType');
      if (typeof obligationType !== 'string' || !isObligationType(obligationType)) invalid('The obligation kind is not a well-formed identifier.');
      const sourceId = readOwn(input, 'sourceId');
      if (typeof sourceId !== 'string' || !sourceIds.has(sourceId)) invalid('The report must cite a configured discharge source.');
      const outcome = readOwn(input, 'outcome');
      if (typeof outcome !== 'string' || !(OBLIGATION_DISCHARGE_OUTCOMES as readonly string[]).includes(outcome)) invalid('The outcome is not a declared discharge outcome.');
      const observedAt = readOwn(input, 'observedAt');
      const recordedAt = now();
      if (typeof observedAt !== 'string' || Number.isNaN(Date.parse(observedAt))) invalid('observedAt must be a valid ISO-8601 instant.');
      if (Date.parse(observedAt) > Date.parse(recordedAt)) invalid('observedAt lies in the future; a report of something that has not happened yet is not recorded.');
      const reference = readOwn(input, 'reference');
      const subjectId = readOwn(input, 'subjectId');
      if (reference !== undefined && !isText(reference)) invalid('reference must be a non-empty string of at most 256 characters when present.');
      if (subjectId !== undefined && !isText(subjectId)) invalid('subjectId must be a non-empty string of at most 256 characters when present.');

      const content: ObligationDischargeContent = {
        organizationId,
        correlation: { requestId, action, resourceScope },
        obligationType,
        sourceId,
        outcome: outcome as StoredObligationDischarge['outcome'],
        observedAt,
        ...(reference !== undefined ? { reference } : {}),
        ...(subjectId !== undefined ? { subjectId } : {}),
        recordedBy: readOwn(writer, 'actorId') as string,
        recordedAt,
      };
      // Reports for one obligation of one decision are recorded in strictly
      // increasing observation time. The lifecycle orders by that time, so this
      // makes every prefix of the committed history a prefix of the lifecycle
      // sequence — and since a satisfied obligation is terminal, no earlier
      // prefix (a rollback, CORE-07) can ever be satisfied when the whole is not.
      const earlier = (await store.read(organizationId, content.correlation)).filter((row) => row.obligationType === content.obligationType);
      if (earlier.some((row) => Date.parse(row.observedAt) >= Date.parse(observedAt))) {
        invalid('A report for this obligation was already recorded at or after this observation time; reports are recorded in time order.');
      }
      // The store binds the row to its position and advances the signed head.
      return store.append(content);
    }
  }
}

/**
 * The discharge provider the Kernel's obligation capability reads through: the
 * verified rows for exactly the queried correlation, in the served
 * organization only, reduced to observations. A store that cannot be read, or
 * whose rows do not verify, makes this throw — which the Kernel reports as
 * `resolved: false`, leaving every blocking obligation unsatisfied.
 */
export function createStoredObligationDischargeProvider(store: ObligationDischargeStore, organizationId: string): ObligationDischargeProviderPort {
  return {
    async resolveObligationDischarges(query: ObligationDischargeQuery): Promise<ObligationDischargeProviderOutput> {
      // A query for another organization reads nothing: a discharge recorded
      // for one organization's decision is never evidence for another's.
      if (query.organizationId !== organizationId) return { observations: [] };
      const declared = new Set(query.obligationTypes);
      const rows = await store.read(organizationId, query.correlation);
      const observations: ObligationDischargeObservation[] = rows
        .filter((row) => declared.has(row.obligationType))
        .map((row) => ({
          obligationType: row.obligationType,
          correlation: { requestId: row.correlation.requestId, action: row.correlation.action, resourceScope: row.correlation.resourceScope },
          sourceId: row.sourceId,
          outcome: row.outcome,
          observedAt: row.observedAt,
          ...(row.subjectId !== undefined ? { subjectId: row.subjectId } : {}),
          ...(row.reference !== undefined ? { reference: row.reference } : {}),
        }));
      return { observations };
    },
  };
}
