import { executionDestinationKey, parseExecutionDestination, type ExecutionDestination } from '../domain/index.js';
import { isCanonicalRegistrationInstant } from '../registry/index.js';

/**
 * Destination governance approval (ANDREW-P0-03): **has this organization
 * authorized governed use of this exact destination, right now?**
 *
 * ## Four questions, four owners
 *
 * | question | owner |
 * | --- | --- |
 * | what exact destination is this? | P0-01 identity (`../domain`) |
 * | does Frontera have a record of it? | P0-02 registry (`../registry`) — deployment-wide |
 * | **has organization O approved it?** | **this module — per organization** |
 * | may this actor perform this action, amount, asset? | a later task (Kernel / policy) |
 *
 * Approval is never inferred: not from registry membership, not from a valid
 * spelling, not from a request field, not from prior use. It exists only as an
 * explicit `approved` event recorded by an authenticated administrative
 * authority, and stops being active when it is explicitly `revoked` or its
 * `expiresAt` passes.
 *
 * ## Scoped by organization, always
 *
 * The security identity of an approval is `(organizationId, destinationKey)`.
 * Organization A approving D says nothing about organization B. A write takes
 * its organization from the trusted authority context — never from the command
 * — so an administrator can only approve or revoke for the organization they
 * act for. Every read names the organization it asks about, and there is no
 * cross-organization listing.
 *
 * ## History is never rewritten
 *
 * Approve → revoke → approve is three events. A revocation references the
 * approval it ends; it never deletes or edits it. An expired approval stays in
 * history exactly as recorded. Current state is *derived*, deterministically,
 * from the history and a trusted instant.
 *
 * ## The read is synchronous
 *
 * Like the registry, so a later trusted-context resolver (P0-04) can consult
 * approval without an `await` between the read and the decision.
 */

/** The longest organization identifier admitted — the same bound and grammar as the enterprise customer-identity identifier. */
export const DESTINATION_APPROVAL_ORGANIZATION_ID_MAX_LENGTH = 256;

/** The longest actor reference or authority basis recorded. Room for `operator:<256-character operator id>` and a structured basis. */
export const DESTINATION_GOVERNANCE_REFERENCE_MAX_LENGTH = 512;

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

/** The operator plane's idempotency-key grammar (`operator-control/contracts.ts`), reused verbatim. */
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

/**
 * Whether `value` is an organization identifier this module admits.
 *
 * Deliberately the same rule as `isCanonicalCustomerIdentifier`
 * (`src/enterprise/customer-identity/identifiers.ts`) — non-empty, at most 256
 * characters, trim-stable, no control character — restated here only because a
 * feature runtime may not import the enterprise layer. A test proves the two
 * agree. The value itself is the Host's served organization
 * (`EnterpriseOperatorPrincipal.organizationId`): this module invents no
 * organization identity of its own.
 */
export function isDestinationApprovalOrganizationId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= DESTINATION_APPROVAL_ORGANIZATION_ID_MAX_LENGTH && value === value.trim() && !CONTROL.test(value);
}

/** An actor reference (`approvedBy`, `revokedBy`) or an authority basis: non-empty, bounded, trim-stable, no control character. */
export function isDestinationGovernanceReference(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= DESTINATION_GOVERNANCE_REFERENCE_MAX_LENGTH && value === value.trim() && !CONTROL.test(value);
}

export function isDestinationApprovalIdempotencyKey(value: unknown): value is string {
  return typeof value === 'string' && IDEMPOTENCY_KEY.test(value);
}

/** A canonical UTC instant (`YYYY-MM-DDTHH:MM:SS.sssZ`) that round-trips exactly — the registry's rule, reused. */
export function isCanonicalApprovalInstant(value: unknown): value is string {
  return isCanonicalRegistrationInstant(value);
}

/**
 * The trusted context a governance write is made under.
 *
 * Not a request field and not caller data: it is built by the administrative
 * service (`src/enterprise/destination-approval/administration.ts`) from an
 * operator principal the CTRL-02 authenticator produced after a credential
 * match and a permission check. `organizationId` is the organization the
 * authority acts for, and is the **only** source of a write's organization
 * scope.
 *
 * - `actorRef` is *provenance*: who made the decision (`operator:ops-1`).
 * - `authorityBasis` is *why that actor could*: the permission, role and
 *   credential class it was authorized under.
 *
 * Neither is a signature. What a caller constructing this must guarantee is
 * stated in `docs/demo/andrew/ANDREW-P0-03-DESTINATION-APPROVAL.md` §6.
 */
export interface DestinationGovernanceAuthority {
  readonly authenticated: true;
  readonly organizationId: string;
  readonly actorRef: string;
  readonly authorityBasis: string;
}

/** Approve `destination` for the authority's organization. */
export interface ApproveDestinationCommand {
  readonly destination: ExecutionDestination;
  /** When the approval stops being active, or `null`/absent for no expiry. Must be later than the instant the approval is recorded. */
  readonly expiresAt?: string | null;
  /** Retry identity, per organization. The same key with the same request replays; with a different request it is refused. */
  readonly idempotencyKey: string;
}

/** Revoke the authority's organization's active approval of `destination`. */
export interface RevokeDestinationCommand {
  readonly destination: ExecutionDestination;
  readonly idempotencyKey: string;
}

/** Which organization is asking about which destination. Both are required. */
export interface DestinationApprovalQuery {
  readonly organizationId: string;
  readonly destination: ExecutionDestination;
}

/** One recorded approval. Immutable: revocation and expiry never change it. */
export interface DestinationApproval {
  readonly organizationId: string;
  readonly destination: ExecutionDestination;
  /** P0-01's `executionDestinationKey(destination)`, derived — never accepted from a caller. */
  readonly destinationKey: string;
  /** The approval's position in the store's history; also what a revocation names. */
  readonly sequence: number;
  readonly approvedBy: string;
  readonly authorityBasis: string;
  /** From the store's injected clock, inside the write transaction. */
  readonly approvedAt: string;
  readonly expiresAt: string | null;
}

/** One recorded revocation, naming the approval it ended. */
export interface DestinationApprovalRevocation {
  readonly organizationId: string;
  readonly destinationKey: string;
  readonly sequence: number;
  readonly approvalSequence: number;
  readonly revokedBy: string;
  readonly revocationBasis: string;
  readonly revokedAt: string;
}

/**
 * Current approval state for one organization and one destination.
 *
 * Only `approved` is active. `revoked` (deliberately withdrawn) and `expired`
 * (validity period ended) are different facts and keep the approval they are
 * about. `never-approved` is the absence of any approval event — never what a
 * damaged or unreadable store answers; that is an error.
 */
export type DestinationApprovalState =
  | { readonly state: 'never-approved'; readonly organizationId: string; readonly destinationKey: string }
  | { readonly state: 'approved'; readonly approval: DestinationApproval }
  | { readonly state: 'expired'; readonly approval: DestinationApproval }
  | { readonly state: 'revoked'; readonly approval: DestinationApproval; readonly revocation: DestinationApprovalRevocation };

/** One event of an organization's history for one destination, oldest first. */
export type DestinationApprovalHistoryEntry =
  | { readonly transition: 'approved'; readonly approval: DestinationApproval }
  | { readonly transition: 'revoked'; readonly revocation: DestinationApprovalRevocation };

/**
 * The outcome of `approve`.
 *
 * - `approved`: a new approval was recorded.
 * - `already-approved`: an approval was already active; it is returned with its
 *   original provenance and terms. Nothing new was recorded except the command.
 *
 * `replayed` is `true` when this idempotency key had already been used for the
 * same request: the original outcome and record are returned, whatever has
 * happened since — a replay never approves again.
 */
export interface ApproveDestinationResult {
  readonly outcome: 'approved' | 'already-approved';
  readonly approval: DestinationApproval;
  readonly replayed: boolean;
}

/**
 * The outcome of `revoke`.
 *
 * - `revoked`: the active approval was ended by a new revocation.
 * - `already-revoked`: the latest event was already a revocation; it is returned.
 * - `not-active`: there was nothing to revoke — never approved, or expired.
 */
export type RevokeDestinationResult =
  | { readonly outcome: 'revoked' | 'already-revoked'; readonly revocation: DestinationApprovalRevocation; readonly replayed: boolean }
  | { readonly outcome: 'not-active'; readonly destinationKey: string; readonly replayed: boolean };

/**
 * The **read capability, and nothing else**. A future trusted-context resolver
 * is typed against this, so it cannot reach `approve` or `revoke`.
 */
export interface DestinationApprovalReaderPort {
  /** Throws `DestinationApprovalError` on a malformed query, an unreadable store or unverifiable history; never answers `never-approved` for any of them. */
  read(query: DestinationApprovalQuery): DestinationApprovalState;
  /** The organization's full history for the destination, oldest first. */
  history(query: DestinationApprovalQuery): readonly DestinationApprovalHistoryEntry[];
}

/**
 * Approval reads plus the two governance writes. No update, delete, edit,
 * rename or re-key: a decision, once recorded, is history.
 */
export interface DestinationApprovalStorePort extends DestinationApprovalReaderPort {
  approve(authority: DestinationGovernanceAuthority, command: ApproveDestinationCommand): ApproveDestinationResult;
  revoke(authority: DestinationGovernanceAuthority, command: RevokeDestinationCommand): RevokeDestinationResult;
}

/** The one permitted reading of a state: only `approved` is active. */
export function isDestinationApprovalActive(state: DestinationApprovalState): boolean {
  return state.state === 'approved';
}

export type DestinationApprovalErrorCode =
  /** The command, query or destination is outside the contract. Nothing was read or written. */
  | 'DESTINATION_APPROVAL_INPUT_INVALID'
  /** The authority context is absent, not authenticated, or malformed. Nothing was written. */
  | 'DESTINATION_APPROVAL_AUTHORITY_INVALID'
  /** The destination is not KNOWN in the registry, so it cannot be approved. Nothing was written; nothing was registered. */
  | 'DESTINATION_APPROVAL_DESTINATION_UNKNOWN'
  /** The idempotency key was already used, in this organization, for a different request. Nothing was written. */
  | 'DESTINATION_APPROVAL_IDEMPOTENCY_CONFLICT'
  /** The store cannot be opened or has been closed, its clock answered a non-canonical instant, or its schema version is not implemented. */
  | 'DESTINATION_APPROVAL_UNAVAILABLE'
  /** Persisted governance state failed verification. Refused, never repaired, never read as `never-approved`. */
  | 'DESTINATION_APPROVAL_CORRUPT';

/** Messages name the condition only: no SQL, no file path, no driver text, no actor reference. */
export class DestinationApprovalError extends Error {
  constructor(
    readonly code: DestinationApprovalErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DestinationApprovalError';
  }
}

export function isDestinationApprovalError(error: unknown): error is DestinationApprovalError {
  return error instanceof DestinationApprovalError;
}

function invalid(message: string): DestinationApprovalError {
  return new DestinationApprovalError('DESTINATION_APPROVAL_INPUT_INVALID', message);
}

function corrupt(message: string): DestinationApprovalError {
  return new DestinationApprovalError('DESTINATION_APPROVAL_CORRUPT', message);
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/**
 * Reads a closed record: only `allowed` keys, data properties only, each read
 * once. A field outside the set — `approved`, `organizationId`, `approvedBy`,
 * `status` — is refused, never stripped.
 */
function closedRecord(input: unknown, allowed: readonly string[], what: string, fail: (message: string) => DestinationApprovalError): Readonly<Record<string, unknown>> {
  if (!isPlainRecord(input)) throw fail(`${what} must be a plain object.`);
  const keys = Reflect.ownKeys(input);
  if (!keys.every((key) => typeof key === 'string' && allowed.includes(key))) throw fail(`${what} states exactly ${allowed.map((key) => `\`${key}\``).join(', ')}.`);
  const values: Record<string, unknown> = {};
  for (const key of allowed) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor !== undefined && !('value' in descriptor)) throw fail(`${what} may not state an accessor.`);
    values[key] = descriptor?.value as unknown;
  }
  return values;
}

function requireDestination(value: unknown): ExecutionDestination {
  const parsed = parseExecutionDestination(value);
  if (!parsed.valid) throw invalid(`The destination is not a well-formed execution destination (${parsed.violation}).`);
  return parsed.destination;
}

function requireIdempotencyKey(value: unknown): string {
  if (!isDestinationApprovalIdempotencyKey(value)) throw invalid("idempotencyKey must be 8-128 letters, digits, '.', '_', ':' or '-', starting with a letter or digit.");
  return value;
}

/**
 * The authority context, checked whole and copied. The store is the trust
 * boundary for its *shape*; that it was built from an authenticated principal
 * is the constructing service's guarantee.
 */
export function requireDestinationGovernanceAuthority(input: unknown): DestinationGovernanceAuthority {
  const fail = (message: string) => new DestinationApprovalError('DESTINATION_APPROVAL_AUTHORITY_INVALID', message);
  const values = closedRecord(input, ['authenticated', 'organizationId', 'actorRef', 'authorityBasis'], 'A governance authority', fail);
  if (values['authenticated'] !== true) throw fail('A governance write requires an authenticated authority.');
  if (!isDestinationApprovalOrganizationId(values['organizationId'])) throw fail('The authority does not name a well-formed organization.');
  if (!isDestinationGovernanceReference(values['actorRef'])) throw fail('The authority does not name a well-formed actor.');
  if (!isDestinationGovernanceReference(values['authorityBasis'])) throw fail('The authority does not state a well-formed basis.');
  return Object.freeze({ authenticated: true, organizationId: values['organizationId'], actorRef: values['actorRef'], authorityBasis: values['authorityBasis'] });
}

export function requireApproveDestinationCommand(input: unknown): Required<ApproveDestinationCommand> {
  const values = closedRecord(input, ['destination', 'expiresAt', 'idempotencyKey'], 'An approval command', invalid);
  const destination = requireDestination(values['destination']);
  const expiresAt = values['expiresAt'] ?? null;
  if (expiresAt !== null && !isCanonicalApprovalInstant(expiresAt)) throw invalid('expiresAt must be null or a canonical UTC instant (YYYY-MM-DDTHH:MM:SS.sssZ).');
  const idempotencyKey = requireIdempotencyKey(values['idempotencyKey']);
  return Object.freeze({ destination, expiresAt, idempotencyKey });
}

export function requireRevokeDestinationCommand(input: unknown): RevokeDestinationCommand {
  const values = closedRecord(input, ['destination', 'idempotencyKey'], 'A revocation command', invalid);
  return Object.freeze({ destination: requireDestination(values['destination']), idempotencyKey: requireIdempotencyKey(values['idempotencyKey']) });
}

export function requireDestinationApprovalQuery(input: unknown): DestinationApprovalQuery {
  const values = closedRecord(input, ['organizationId', 'destination'], 'An approval query', invalid);
  if (!isDestinationApprovalOrganizationId(values['organizationId'])) throw invalid('An approval query must name a well-formed organization.');
  return Object.freeze({ organizationId: values['organizationId'], destination: requireDestination(values['destination']) });
}

/** A request that names only a destination — the administrative read, whose organization comes from the authenticated principal. */
export function requireDestinationApprovalTarget(input: unknown): { readonly destination: ExecutionDestination } {
  const values = closedRecord(input, ['destination'], 'A destination approval request', invalid);
  return Object.freeze({ destination: requireDestination(values['destination']) });
}

/** Samples the injected clock and refuses an answer that is not a canonical instant: no state is read or written against an unknown time. */
export function sampleApprovalInstant(now: () => string): string {
  const instant = now();
  if (!isCanonicalApprovalInstant(instant)) {
    throw new DestinationApprovalError('DESTINATION_APPROVAL_UNAVAILABLE', 'The approval store clock did not answer a canonical instant; nothing was read or written.');
  }
  return instant;
}

function frozenDestination(destination: ExecutionDestination): ExecutionDestination {
  return Object.freeze({ namespace: destination.namespace, identifier: destination.identifier });
}

export function buildDestinationApproval(fields: {
  readonly organizationId: string;
  readonly destination: ExecutionDestination;
  readonly sequence: number;
  readonly approvedBy: string;
  readonly authorityBasis: string;
  readonly approvedAt: string;
  readonly expiresAt: string | null;
}): DestinationApproval {
  const destination = frozenDestination(fields.destination);
  return Object.freeze({
    organizationId: fields.organizationId,
    destination,
    destinationKey: executionDestinationKey(destination),
    sequence: fields.sequence,
    approvedBy: fields.approvedBy,
    authorityBasis: fields.authorityBasis,
    approvedAt: fields.approvedAt,
    expiresAt: fields.expiresAt,
  });
}

export function buildDestinationApprovalRevocation(fields: DestinationApprovalRevocation): DestinationApprovalRevocation {
  return Object.freeze({
    organizationId: fields.organizationId,
    destinationKey: fields.destinationKey,
    sequence: fields.sequence,
    approvalSequence: fields.approvalSequence,
    revokedBy: fields.revokedBy,
    revocationBasis: fields.revocationBasis,
    revokedAt: fields.revokedAt,
  });
}

/** Whether an approval is past its validity period at `at`. Expired exactly at `expiresAt` — the repository's `now >= expiresAt` rule. */
export function isDestinationApprovalExpiredAt(approval: DestinationApproval, at: string): boolean {
  return approval.expiresAt !== null && Date.parse(at) >= Date.parse(approval.expiresAt);
}

/**
 * Current state from one organization's history for one destination, at the
 * trusted instant `now`.
 *
 * Total over consistent history, and refuses anything else as
 * `DESTINATION_APPROVAL_CORRUPT`: an entry for another organization or
 * destination, sequences out of order, a revocation that does not name the
 * approval immediately before it or that came after that approval expired, a
 * second approval while the first was still active, an expiry not after its
 * approval. Each of those is history the write path cannot produce.
 */
export function deriveDestinationApprovalState(organizationId: string, destinationKey: string, history: readonly DestinationApprovalHistoryEntry[], now: string): DestinationApprovalState {
  let previousSequence = 0;
  let latest: DestinationApprovalHistoryEntry | undefined;
  let latestApproval: DestinationApproval | undefined;
  for (const entry of history) {
    const record = entry.transition === 'approved' ? entry.approval : entry.revocation;
    if (record.organizationId !== organizationId || record.destinationKey !== destinationKey) throw corrupt('Approval history names another organization or destination.');
    if (!(record.sequence > previousSequence)) throw corrupt('Approval history is out of order.');
    previousSequence = record.sequence;
    if (entry.transition === 'approved') {
      const approval = entry.approval;
      if (approval.expiresAt !== null && !(Date.parse(approval.expiresAt) > Date.parse(approval.approvedAt))) throw corrupt('An approval expires no later than it was recorded.');
      if (latest?.transition === 'approved' && !isDestinationApprovalExpiredAt(latest.approval, approval.approvedAt)) throw corrupt('Two approvals were recorded active at once.');
      latestApproval = approval;
    } else {
      const revocation = entry.revocation;
      if (latest?.transition !== 'approved' || latestApproval === undefined || revocation.approvalSequence !== latestApproval.sequence) throw corrupt('A revocation does not name the approval it ended.');
      if (isDestinationApprovalExpiredAt(latestApproval, revocation.revokedAt)) throw corrupt('A revocation was recorded for an approval that had already expired.');
    }
    latest = entry;
  }
  if (latest === undefined) return Object.freeze({ state: 'never-approved', organizationId, destinationKey });
  if (latest.transition === 'revoked') {
    if (latestApproval === undefined) throw corrupt('A revocation does not name the approval it ended.');
    return Object.freeze({ state: 'revoked', approval: latestApproval, revocation: latest.revocation });
  }
  return Object.freeze({ state: isDestinationApprovalExpiredAt(latest.approval, now) ? 'expired' : 'approved', approval: latest.approval });
}
