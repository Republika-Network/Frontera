import { createHash } from 'node:crypto';

import {
  contextObservationProvenanceDigest,
  type ContextFactObservation,
  type ContextFactValue,
  type ContextResolutionQuery,
} from '../../features/context-resolution-runtime/index.js';
import { executionDestinationKey, parseExecutionDestination, sameExecutionDestination, type ExecutionDestination } from '../../features/destination-runtime/index.js';
import { isDestinationApprovalActive, isDestinationApprovalError, isDestinationApprovalOrganizationId } from '../../features/destination-runtime/approval/index.js';
import type { DestinationApprovalReaderPort, DestinationApprovalState } from '../../features/destination-runtime/approval/index.js';
import { isDestinationRegistryError } from '../../features/destination-runtime/registry/index.js';
import type { DestinationLookup, DestinationRegistryReaderPort } from '../../features/destination-runtime/registry/index.js';
import type { ContextProvider } from '../../kernel/index.js';

/**
 * ANDREW-P0-04 — trusted destination context.
 *
 * > **A request may name a destination. Whether that destination is known,
 * > and whether this organization has approved it, is read here — from the
 * > registry and the approval store — and never from the request.**
 *
 * This is not a second trusted-context system. It is a `ContextProvider` — a
 * retrieval port behind the one Trusted Context Boundary — whose every reading
 * is admitted, scoped, freshness-bounded and digested by
 * `ContextResolutionService` exactly like any other source's, and reaches
 * policy only as an admitted `contextFact`.
 *
 * ## Where each input comes from
 *
 * | input | source |
 * | --- | --- |
 * | destination | the query's `counterpartyId` — the value the grant binds — parsed through P0-01's single ingress, accepted only when it round-trips to the identical canonical key |
 * | organization | the query's `organizationId` — the Kernel request's bound organization (`BoundCustomerIdentity` on the governed path) — and only when it equals the organization this provider was composed for |
 * | known | `DestinationRegistryReaderPort.lookup` |
 * | approval state | `DestinationApprovalReaderPort.read({ organizationId, destination })` |
 *
 * ## Unavailable is not false
 *
 * When registry or approval truth cannot be established — a store error, a
 * damaged store, a record that does not describe the destination asked about,
 * an approval for a destination the registry does not know, an unexpected
 * failure — the provider reports **no destination reading at all**. Each
 * declared destination key is then `unresolved` at the boundary, and a
 * required key denies (`CONTEXT_REQUIRED_FACT_UNRESOLVED`). It never reports
 * `destination.known = false` or `destination.approved = false` for a store it
 * could not read: those are verified facts, and only a verified read produces
 * them.
 *
 * ## Read-only, by construction
 *
 * The factory keeps the readers' `lookup` and `read` functions and nothing
 * else: no reference to a store object is retained, so `register`, `approve`
 * and `revoke` are unreachable from here even when the composed object is a
 * full store.
 */

/** The fact classes this provider can answer. Exact, case-sensitive; a profile declares the ones it needs. */
export const DESTINATION_CONTEXT_FACT_CLASSES = Object.freeze({
  /** The canonical destination key (`<namespace>:<identifier>`) the other facts are about. */
  key: 'destination.key',
  /** `true` when the registry knows the destination, `false` when it verifiably does not. */
  known: 'destination.known',
  /** The organization's approval state: `never-approved` | `approved` | `expired` | `revoked`. */
  approvalState: 'destination.approvalState',
  /** `true` only for an active (`approved`) approval of a known destination. */
  approved: 'destination.approved',
} as const);

const REGISTRY_FACTS: readonly string[] = [DESTINATION_CONTEXT_FACT_CLASSES.key, DESTINATION_CONTEXT_FACT_CLASSES.known];
const APPROVAL_FACTS: readonly string[] = [DESTINATION_CONTEXT_FACT_CLASSES.approvalState, DESTINATION_CONTEXT_FACT_CLASSES.approved];
const DESTINATION_FACTS: readonly string[] = [...REGISTRY_FACTS, ...APPROVAL_FACTS];

/** Destination governance facts for one organization and one destination, established from trusted state. */
export interface TrustedDestinationContext {
  readonly organizationId: string;
  readonly destination: ExecutionDestination;
  readonly destinationKey: string;
  readonly destinationKnown: boolean;
  /** The full P0-03 state name, kept rather than reduced to a boolean. */
  readonly destinationApprovalState: DestinationApprovalState['state'];
  /** The one permitted reading of active approval: `approved` state, of a known destination. */
  readonly destinationApproved: boolean;
  /** The approval event the state rests on, when there is one. Provenance for audit, not an input to anything. */
  readonly approvalSequence?: number;
}

/**
 * Why trusted destination facts could not be established. Every one of these
 * withholds the facts; none of them is a "no".
 */
export type TrustedDestinationUnavailableReason =
  /** The query names no counterparty, or one that is not exactly a canonical destination key. */
  | 'DESTINATION_UNDETERMINED'
  /** The query carries no well-formed organization, or one other than the organization this provider serves. */
  | 'ORGANIZATION_UNBOUND'
  | 'REGISTRY_UNAVAILABLE'
  /** The registry refused its own state, or answered about a different destination. */
  | 'REGISTRY_CORRUPT'
  | 'APPROVAL_UNAVAILABLE'
  /** The approval store refused its own state, or answered about a different organization or destination. */
  | 'APPROVAL_CORRUPT'
  /** Approval history exists for a destination the registry does not know — impossible through the P0-03 write path. */
  | 'GOVERNANCE_INCONSISTENT'
  /** Anything else went wrong while resolving. */
  | 'RESOLUTION_FAILED';

export type TrustedDestinationResolution =
  | { readonly kind: 'resolved'; readonly context: TrustedDestinationContext }
  | { readonly kind: 'unavailable'; readonly reason: TrustedDestinationUnavailableReason };

/** The read capabilities trusted destination context needs, and nothing more. */
export interface TrustedDestinationReaders {
  readonly registry: Pick<DestinationRegistryReaderPort, 'lookup'>;
  readonly approvals: Pick<DestinationApprovalReaderPort, 'read'>;
}

function unavailable(reason: TrustedDestinationUnavailableReason): TrustedDestinationResolution {
  return Object.freeze({ kind: 'unavailable', reason });
}

/**
 * The destination a counterparty designates, or `undefined` when it is not
 * exactly one.
 *
 * Accepted only when the counterparty *is* a canonical destination key: split
 * at the first `:` (a namespace cannot contain one), parsed through P0-01's
 * single ingress, and re-keyed to the identical string. Nothing is trimmed,
 * folded or repaired, so two counterparties never designate one destination,
 * and a counterparty that is not a destination key designates none.
 */
export function destinationFromCounterparty(counterpartyId: unknown): ExecutionDestination | undefined {
  if (typeof counterpartyId !== 'string') return undefined;
  const separator = counterpartyId.indexOf(':');
  if (separator === -1 || separator === 0) return undefined;
  const parsed = parseExecutionDestination({ namespace: counterpartyId.slice(0, separator), identifier: counterpartyId.slice(separator + 1) });
  if (!parsed.valid) return undefined;
  return executionDestinationKey(parsed.destination) === counterpartyId ? parsed.destination : undefined;
}

function registryFailure(error: unknown): TrustedDestinationUnavailableReason {
  return isDestinationRegistryError(error) && error.code === 'DESTINATION_REGISTRY_CORRUPT' ? 'REGISTRY_CORRUPT' : 'REGISTRY_UNAVAILABLE';
}

function approvalFailure(error: unknown): TrustedDestinationUnavailableReason {
  return isDestinationApprovalError(error) && error.code === 'DESTINATION_APPROVAL_CORRUPT' ? 'APPROVAL_CORRUPT' : 'APPROVAL_UNAVAILABLE';
}

/** Whether a registry answer is about exactly `destination`. Anything else is not a trusted record of it. */
function describesDestination(lookup: DestinationLookup, destination: ExecutionDestination, destinationKey: string): boolean {
  if (lookup === null || typeof lookup !== 'object') return false;
  if (lookup.membership === 'unknown') return lookup.destinationKey === destinationKey;
  if (lookup.membership === 'known') {
    const registration: unknown = lookup.registration;
    if (registration === null || typeof registration !== 'object') return false;
    return lookup.registration.destinationKey === destinationKey && sameExecutionDestination(lookup.registration.destination, destination);
  }
  return false;
}

/** Whether an approval answer is about exactly `organizationId` and `destinationKey`. */
function describesApproval(state: DestinationApprovalState, organizationId: string, destinationKey: string): boolean {
  if (state === null || typeof state !== 'object') return false;
  switch (state.state) {
    case 'never-approved':
      return state.organizationId === organizationId && state.destinationKey === destinationKey;
    case 'approved':
    case 'expired':
      return state.approval?.organizationId === organizationId && state.approval.destinationKey === destinationKey;
    case 'revoked':
      return (
        state.approval?.organizationId === organizationId &&
        state.approval.destinationKey === destinationKey &&
        state.revocation?.organizationId === organizationId &&
        state.revocation.destinationKey === destinationKey &&
        state.revocation.approvalSequence === state.approval.sequence
      );
    default:
      return false;
  }
}

/**
 * Establishes destination governance facts for one trusted organization and
 * one canonical destination, from the two read ports only. Synchronous, like
 * both ports. Never throws: every failure is an `unavailable` reason.
 */
export function resolveTrustedDestinationContext(readers: TrustedDestinationReaders, input: { readonly organizationId: string; readonly destination: ExecutionDestination }): TrustedDestinationResolution {
  const { organizationId } = input;
  if (!isDestinationApprovalOrganizationId(organizationId)) return unavailable('ORGANIZATION_UNBOUND');
  const parsed = parseExecutionDestination(input.destination);
  if (!parsed.valid) return unavailable('DESTINATION_UNDETERMINED');
  const destination = parsed.destination;
  const destinationKey = executionDestinationKey(destination);

  let lookup: DestinationLookup;
  try {
    lookup = readers.registry.lookup(destination);
  } catch (error) {
    return unavailable(registryFailure(error));
  }
  if (!describesDestination(lookup, destination, destinationKey)) return unavailable('REGISTRY_CORRUPT');

  let state: DestinationApprovalState;
  try {
    state = readers.approvals.read({ organizationId, destination });
  } catch (error) {
    return unavailable(approvalFailure(error));
  }
  if (!describesApproval(state, organizationId, destinationKey)) return unavailable('APPROVAL_CORRUPT');

  const destinationKnown = lookup.membership === 'known';
  // The P0-03 write path refuses to approve an unknown destination, and the
  // registry never forgets one; approval history for an unknown destination
  // means the two stores disagree. Withheld, never read as approved.
  if (!destinationKnown && state.state !== 'never-approved') return unavailable('GOVERNANCE_INCONSISTENT');

  return Object.freeze({
    kind: 'resolved',
    context: Object.freeze({
      organizationId,
      destination,
      destinationKey,
      destinationKnown,
      destinationApprovalState: state.state,
      destinationApproved: destinationKnown && isDestinationApprovalActive(state),
      ...(state.state !== 'never-approved' ? { approvalSequence: state.approval.sequence } : {}),
    }),
  });
}

/** The source ids the two systems of record are configured under in `trustedContext.sources`. */
export interface DestinationContextSourceIds {
  /** Attests `destination.key` and `destination.known`. */
  readonly registry: string;
  /** Attests `destination.approvalState` and `destination.approved`. */
  readonly approval: string;
}

export interface CreateDestinationContextProviderOptions extends TrustedDestinationReaders {
  /** The organization this Host serves. A query in any other organization is answered with nothing. */
  readonly organizationId: string;
  readonly sourceIds: DestinationContextSourceIds;
  /** Optional, for operators: told why facts were withheld. Never consulted for a decision; a throw from it is ignored. */
  readonly onUnavailable?: (event: { readonly reason: TrustedDestinationUnavailableReason; readonly at: string }) => void;
}

function opaqueReference(prefix: string, ...parts: readonly string[]): string {
  return `${prefix}:sha256:${createHash('sha256').update(parts.join('\n'), 'utf8').digest('hex')}`;
}

/**
 * The destination context retrieval port, composed by trusted host code.
 *
 * Answers only the destination fact classes the query asks for, in the
 * organization it was composed for, about the destination the query's
 * counterparty designates. Each reading carries the organization, a bounded
 * opaque reference and a provenance digest, so it is admissible under a
 * `reference-digest` source and nowhere else.
 */
export function createDestinationContextProvider(options: CreateDestinationContextProviderOptions): ContextProvider {
  const servedOrganization = options.organizationId;
  if (!isDestinationApprovalOrganizationId(servedOrganization)) throw new TypeError('A destination context provider needs the well-formed organization it serves.');
  const sourceIds = { registry: options.sourceIds?.registry, approval: options.sourceIds?.approval };
  if (typeof sourceIds.registry !== 'string' || sourceIds.registry.length === 0 || typeof sourceIds.approval !== 'string' || sourceIds.approval.length === 0) {
    throw new TypeError('A destination context provider needs the registry and approval source ids.');
  }
  if (typeof options.registry?.lookup !== 'function' || typeof options.approvals?.read !== 'function') {
    throw new TypeError('A destination context provider needs a registry reader and an approval reader.');
  }
  // Only the two read functions are kept. Nothing else of either object —
  // `register`, `approve`, `revoke`, `close` — is reachable from here.
  const lookup = options.registry.lookup.bind(options.registry);
  const read = options.approvals.read.bind(options.approvals);
  const readers: TrustedDestinationReaders = Object.freeze({ registry: Object.freeze({ lookup }), approvals: Object.freeze({ read }) });
  const report = options.onUnavailable;

  function withhold(reason: TrustedDestinationUnavailableReason, at: string): { readonly observations: readonly ContextFactObservation[] } {
    try {
      report?.({ reason, at });
    } catch {
      // Diagnostics never change what is resolved.
    }
    return { observations: [] };
  }

  function observe(query: ContextResolutionQuery): { readonly observations: readonly ContextFactObservation[] } {
    const asked = DESTINATION_FACTS.filter((factClass) => query.keys.includes(factClass));
    if (asked.length === 0) return { observations: [] };
    if (query.organizationId === undefined || query.organizationId !== servedOrganization) return withhold('ORGANIZATION_UNBOUND', query.at);
    const destination = destinationFromCounterparty(query.counterpartyId);
    if (destination === undefined) return withhold('DESTINATION_UNDETERMINED', query.at);

    const resolution = resolveTrustedDestinationContext(readers, { organizationId: servedOrganization, destination });
    if (resolution.kind === 'unavailable') return withhold(resolution.reason, query.at);
    const { context } = resolution;

    const values: Readonly<Record<string, ContextFactValue>> = {
      [DESTINATION_CONTEXT_FACT_CLASSES.key]: context.destinationKey,
      [DESTINATION_CONTEXT_FACT_CLASSES.known]: context.destinationKnown,
      [DESTINATION_CONTEXT_FACT_CLASSES.approvalState]: context.destinationApprovalState,
      [DESTINATION_CONTEXT_FACT_CLASSES.approved]: context.destinationApproved,
    };
    const registryReference = opaqueReference('destination-registry', context.destinationKey, context.destinationKnown ? 'known' : 'unknown');
    const approvalReference = opaqueReference(
      'destination-approval',
      context.organizationId,
      context.destinationKey,
      context.destinationApprovalState,
      String(context.approvalSequence ?? 0),
    );
    const observations = asked.map((key): ContextFactObservation => {
      const fromRegistry = REGISTRY_FACTS.includes(key);
      const reading = {
        key,
        value: values[key] as ContextFactValue,
        sourceId: fromRegistry ? sourceIds.registry : sourceIds.approval,
        observedAt: query.at,
        reference: fromRegistry ? registryReference : approvalReference,
        organizationId: context.organizationId,
      };
      return Object.freeze({ ...reading, provenanceDigest: contextObservationProvenanceDigest(reading) });
    });
    return { observations: Object.freeze(observations) };
  }

  return {
    resolveContext(query) {
      try {
        return Promise.resolve(observe(query));
      } catch {
        // An unexpected failure is unavailable, never an empty world that
        // could be mistaken for a verified answer: no destination reading.
        return Promise.resolve(withhold('RESOLUTION_FAILED', query.at));
      }
    },
  };
}
