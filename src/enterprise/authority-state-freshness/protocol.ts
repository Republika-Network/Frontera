import {
  isAuthorityStateKind,
  isBoundedIdentifier,
  isStateDigest,
  isStateSequence,
  type AuthorityStateBinding,
  type AuthorityStateCheckpoint,
  type AuthorityStateHead,
} from './checkpoint.js';

/**
 * The Frontera authority-state witness protocol, v1 (CORE-07).
 *
 * A **structured** protocol for one job: holding, outside an authority store's
 * restore domain, the newest checkpoint of that store's authenticated state,
 * and advancing it only by compare-and-advance. It is deliberately not a
 * key-value store: there is no "put", no "sign these bytes", no arbitrary key
 * or resource path. Every request names one of five operations and carries
 * the structured binding or checkpoints it is about; the witness decides what
 * happens to its own record.
 *
 * - `identity` — which witness this is and what it offers. Signed over the
 *   caller's challenge, so the handshake proves possession of the pinned key.
 * - `read` — the witnessed state of one binding: unbound, or the committed
 *   checkpoint and any prepared (pending) successor.
 * - `enroll` — create a binding. `genesis` (sequence 0, used when a new store is
 *   created) or `baseline` (an existing store, only through the explicit
 *   enrollment ceremony). Never rebinds an existing binding.
 * - `prepare` — `expected` must be exactly the committed checkpoint with no
 *   pending successor; `proposed` (its successor, sequence + 1) becomes
 *   pending. From that moment the witness no longer treats `expected` as
 *   current: a store still holding it is either before the commit or rolled
 *   back, and the two are indistinguishable by design.
 * - `finalize` — the pending checkpoint becomes committed.
 *
 * Every answer is a **receipt** signed by the witness's own key (never an
 * authority signing key — role separation), over canonical, domain-separated
 * bytes that include the caller's fresh random challenge. A receipt is
 * therefore bound to one request: a recorded answer cannot be replayed to a
 * later call, and an answer from anything but the pinned key is refused.
 * Vendor-neutral: an adapter may put a cloud ledger, a timestamping service or
 * a chain behind a server that speaks this protocol; CORE depends on none.
 */

export const AUTHORITY_STATE_WITNESS_PROTOCOL = 'frontera.authority-state-witness.v1';

export const AUTHORITY_STATE_WITNESS_OPERATIONS = ['identity', 'read', 'enroll', 'prepare', 'finalize'] as const;
export type AuthorityStateWitnessOperation = (typeof AUTHORITY_STATE_WITNESS_OPERATIONS)[number];

/** One fixed path per operation. Nothing a caller supplies is ever part of a path. */
export const AUTHORITY_STATE_WITNESS_PATHS: Readonly<Record<AuthorityStateWitnessOperation, string>> = Object.freeze({
  identity: '/v1/identity',
  read: '/v1/checkpoint/read',
  enroll: '/v1/checkpoint/enroll',
  prepare: '/v1/checkpoint/prepare',
  finalize: '/v1/checkpoint/finalize',
});

/** The signing domain of a witness receipt. Distinct from every authority-artifact domain, so a receipt can never be read as authority and no authority signature as a receipt. */
export const AUTHORITY_STATE_WITNESS_RECEIPT_DOMAIN = 'frontera:authority-state-witness:receipt:v1';

export const AUTHORITY_STATE_ENROLLMENTS = ['genesis', 'baseline'] as const;
export type AuthorityStateEnrollment = (typeof AUTHORITY_STATE_ENROLLMENTS)[number];

/** 32 random bytes, hex. */
const CHALLENGE = /^[0-9a-f]{64}$/;

export function isWitnessChallenge(value: unknown): value is string {
  return typeof value === 'string' && CHALLENGE.test(value);
}

/** What a witness holds for one binding. */
export type WitnessBindingState =
  | { readonly status: 'unbound' }
  | { readonly status: 'bound'; readonly storeId: string; readonly committed: AuthorityStateHead; readonly pending?: AuthorityStateHead };

export type WitnessReceiptOutcome = 'identity' | 'current' | 'enrolled' | 'prepared' | 'finalized' | 'conflict';

/** The outcomes each operation may answer with. A receipt outside this table is malformed. */
export const WITNESS_OUTCOMES_BY_OPERATION: Readonly<Record<AuthorityStateWitnessOperation, readonly WitnessReceiptOutcome[]>> = Object.freeze({
  identity: ['identity'],
  read: ['current'],
  enroll: ['enrolled', 'conflict'],
  prepare: ['prepared', 'conflict'],
  finalize: ['finalized', 'conflict'],
});

export interface WitnessReceipt {
  readonly protocol: typeof AUTHORITY_STATE_WITNESS_PROTOCOL;
  readonly witnessId: string;
  readonly operation: AuthorityStateWitnessOperation;
  readonly challenge: string;
  readonly outcome: WitnessReceiptOutcome;
  /** Every operation but `identity`: the binding the answer is about. */
  readonly binding?: AuthorityStateBinding;
  /** Every operation but `identity`: the witnessed state **after** the operation. */
  readonly state?: WitnessBindingState;
  /** `identity` only: the operations the witness offers. */
  readonly operations?: readonly string[];
}

export type WitnessRequest =
  | { readonly operation: 'identity'; readonly challenge: string }
  | { readonly operation: 'read'; readonly challenge: string; readonly binding: AuthorityStateBinding }
  | { readonly operation: 'enroll'; readonly challenge: string; readonly enrollment: AuthorityStateEnrollment; readonly checkpoint: AuthorityStateCheckpoint }
  | { readonly operation: 'prepare'; readonly challenge: string; readonly expected: AuthorityStateCheckpoint; readonly proposed: AuthorityStateCheckpoint }
  | { readonly operation: 'finalize'; readonly challenge: string; readonly checkpoint: AuthorityStateCheckpoint };

// ── canonical bytes ─────────────────────────────────────────────────────────

const quote = (value: string): string => JSON.stringify(value);

function canonicalBinding(binding: AuthorityStateBinding): string {
  return `{"organizationId":${quote(binding.organizationId)},"stateKind":${quote(binding.stateKind)}}`;
}

function canonicalHead(head: AuthorityStateHead): string {
  return `{"sequence":${String(head.sequence)},"stateDigest":${quote(head.stateDigest)}}`;
}

function canonicalState(state: WitnessBindingState): string {
  if (state.status === 'unbound') return '{"status":"unbound"}';
  return [
    '{',
    [
      `"committed":${canonicalHead(state.committed)}`,
      ...(state.pending !== undefined ? [`"pending":${canonicalHead(state.pending)}`] : []),
      '"status":"bound"',
      `"storeId":${quote(state.storeId)}`,
    ].join(','),
    '}',
  ].join('');
}

/** Canonical bytes of a receipt: keys fixed and sorted, absent optional fields omitted. */
export function serializeWitnessReceipt(receipt: WitnessReceipt): string {
  return [
    '{',
    [
      ...(receipt.binding !== undefined ? [`"binding":${canonicalBinding(receipt.binding)}`] : []),
      `"challenge":${quote(receipt.challenge)}`,
      `"operation":${quote(receipt.operation)}`,
      ...(receipt.operations !== undefined ? [`"operations":[${receipt.operations.map(quote).join(',')}]`] : []),
      `"outcome":${quote(receipt.outcome)}`,
      `"protocol":${quote(receipt.protocol)}`,
      ...(receipt.state !== undefined ? [`"state":${canonicalState(receipt.state)}`] : []),
      `"witnessId":${quote(receipt.witnessId)}`,
    ].join(','),
    '}',
  ].join('');
}

/** The exact bytes a witness signs for a receipt: the domain, a newline, the canonical receipt. */
export function witnessReceiptSigningBytes(receipt: WitnessReceipt): Buffer {
  return Buffer.from(`${AUTHORITY_STATE_WITNESS_RECEIPT_DOMAIN}\n${serializeWitnessReceipt(receipt)}`, 'utf8');
}

// ── request bodies ──────────────────────────────────────────────────────────

function checkpointBody(checkpoint: AuthorityStateCheckpoint): Record<string, unknown> {
  return { stateKind: checkpoint.stateKind, organizationId: checkpoint.organizationId, storeId: checkpoint.storeId, sequence: checkpoint.sequence, stateDigest: checkpoint.stateDigest };
}

export function witnessRequestBody(request: WitnessRequest): Record<string, unknown> {
  const base = { protocol: AUTHORITY_STATE_WITNESS_PROTOCOL, challenge: request.challenge };
  switch (request.operation) {
    case 'identity':
      return base;
    case 'read':
      return { ...base, binding: { stateKind: request.binding.stateKind, organizationId: request.binding.organizationId } };
    case 'enroll':
      return { ...base, enrollment: request.enrollment, checkpoint: checkpointBody(request.checkpoint) };
    case 'prepare':
      return { ...base, expected: checkpointBody(request.expected), proposed: checkpointBody(request.proposed) };
    case 'finalize':
      return { ...base, checkpoint: checkpointBody(request.checkpoint) };
  }
}

// ── strict parsing, shared by the witness (requests) and the client (answers) ──

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

/** Exactly these own keys, no more and no fewer. */
export function hasExactKeys(value: unknown, keys: readonly string[]): value is Readonly<Record<string, unknown>> {
  if (!isPlainRecord(value)) return false;
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

export function parseBinding(value: unknown): AuthorityStateBinding | undefined {
  if (!hasExactKeys(value, ['stateKind', 'organizationId'])) return undefined;
  if (!isAuthorityStateKind(value.stateKind) || !isBoundedIdentifier(value.organizationId)) return undefined;
  return { stateKind: value.stateKind, organizationId: value.organizationId };
}

function parseHead(value: unknown): AuthorityStateHead | undefined {
  if (!hasExactKeys(value, ['sequence', 'stateDigest'])) return undefined;
  if (!isStateSequence(value.sequence) || !isStateDigest(value.stateDigest)) return undefined;
  return { sequence: value.sequence, stateDigest: value.stateDigest };
}

export function parseCheckpoint(value: unknown): AuthorityStateCheckpoint | undefined {
  if (!hasExactKeys(value, ['stateKind', 'organizationId', 'storeId', 'sequence', 'stateDigest'])) return undefined;
  if (!isAuthorityStateKind(value.stateKind) || !isBoundedIdentifier(value.organizationId) || !isBoundedIdentifier(value.storeId)) return undefined;
  if (!isStateSequence(value.sequence) || !isStateDigest(value.stateDigest)) return undefined;
  return { stateKind: value.stateKind, organizationId: value.organizationId, storeId: value.storeId, sequence: value.sequence, stateDigest: value.stateDigest };
}

function parseState(value: unknown): WitnessBindingState | undefined {
  if (hasExactKeys(value, ['status'])) return value.status === 'unbound' ? { status: 'unbound' } : undefined;
  const withPending = hasExactKeys(value, ['status', 'storeId', 'committed', 'pending']);
  if (!withPending && !hasExactKeys(value, ['status', 'storeId', 'committed'])) return undefined;
  const record = value as Readonly<Record<string, unknown>>;
  if (record.status !== 'bound' || !isBoundedIdentifier(record.storeId)) return undefined;
  const committed = parseHead(record.committed);
  if (committed === undefined) return undefined;
  if (!withPending) return { status: 'bound', storeId: record.storeId, committed };
  const pending = parseHead(record.pending);
  // A pending checkpoint is always the committed one's direct successor.
  if (pending === undefined || pending.sequence !== committed.sequence + 1) return undefined;
  return { status: 'bound', storeId: record.storeId, committed, pending };
}

/**
 * Parses a witness request body for `operation`, or `undefined`. Used by a
 * witness before it touches its record: a body that is not exactly one
 * well-formed request of that operation's shape is refused, never coerced.
 */
export function parseWitnessRequest(operation: AuthorityStateWitnessOperation, body: unknown): WitnessRequest | undefined {
  const keysFor: Record<AuthorityStateWitnessOperation, readonly string[]> = {
    identity: ['protocol', 'challenge'],
    read: ['protocol', 'challenge', 'binding'],
    enroll: ['protocol', 'challenge', 'enrollment', 'checkpoint'],
    prepare: ['protocol', 'challenge', 'expected', 'proposed'],
    finalize: ['protocol', 'challenge', 'checkpoint'],
  };
  if (!hasExactKeys(body, keysFor[operation]) || body.protocol !== AUTHORITY_STATE_WITNESS_PROTOCOL || !isWitnessChallenge(body.challenge)) return undefined;
  const challenge = body.challenge;
  switch (operation) {
    case 'identity':
      return { operation, challenge };
    case 'read': {
      const binding = parseBinding(body.binding);
      return binding === undefined ? undefined : { operation, challenge, binding };
    }
    case 'enroll': {
      const checkpoint = parseCheckpoint(body.checkpoint);
      const enrollment = body.enrollment;
      if (checkpoint === undefined || (enrollment !== 'genesis' && enrollment !== 'baseline')) return undefined;
      if (enrollment === 'genesis' && checkpoint.sequence !== 0) return undefined;
      return { operation, challenge, enrollment, checkpoint };
    }
    case 'prepare': {
      const expected = parseCheckpoint(body.expected);
      const proposed = parseCheckpoint(body.proposed);
      if (expected === undefined || proposed === undefined) return undefined;
      // One transition of one store: same binding, same store, the next position.
      if (expected.stateKind !== proposed.stateKind || expected.organizationId !== proposed.organizationId || expected.storeId !== proposed.storeId) return undefined;
      if (proposed.sequence !== expected.sequence + 1) return undefined;
      return { operation, challenge, expected, proposed };
    }
    case 'finalize': {
      const checkpoint = parseCheckpoint(body.checkpoint);
      return checkpoint === undefined ? undefined : { operation, challenge, checkpoint };
    }
  }
}

/** A witness response: the receipt and a base64 signature over its signing bytes. Parsed strictly; nothing else is accepted. */
export function parseWitnessResponse(body: unknown): { readonly receipt: WitnessReceipt; readonly signature: string } | undefined {
  if (!hasExactKeys(body, ['receipt', 'signature']) || typeof body.signature !== 'string' || body.signature.length === 0 || body.signature.length > 256) return undefined;
  const receipt = parseWitnessReceipt(body.receipt);
  return receipt === undefined ? undefined : { receipt, signature: body.signature };
}

export function parseWitnessReceipt(value: unknown): WitnessReceipt | undefined {
  const identityKeys = ['protocol', 'witnessId', 'operation', 'challenge', 'outcome', 'operations'];
  const stateKeys = ['protocol', 'witnessId', 'operation', 'challenge', 'outcome', 'binding', 'state'];
  const isIdentity = hasExactKeys(value, identityKeys);
  if (!isIdentity && !hasExactKeys(value, stateKeys)) return undefined;
  const record = value as Readonly<Record<string, unknown>>;
  if (record.protocol !== AUTHORITY_STATE_WITNESS_PROTOCOL || !isBoundedIdentifier(record.witnessId) || !isWitnessChallenge(record.challenge)) return undefined;
  const operation = record.operation;
  if (typeof operation !== 'string' || !(AUTHORITY_STATE_WITNESS_OPERATIONS as readonly string[]).includes(operation)) return undefined;
  const op = operation as AuthorityStateWitnessOperation;
  const outcome = record.outcome;
  if (typeof outcome !== 'string' || !(WITNESS_OUTCOMES_BY_OPERATION[op] as readonly string[]).includes(outcome)) return undefined;
  const base = { protocol: AUTHORITY_STATE_WITNESS_PROTOCOL, witnessId: record.witnessId, operation: op, challenge: record.challenge, outcome: outcome as WitnessReceiptOutcome } as const;
  if (isIdentity) {
    if (op !== 'identity') return undefined;
    const operations = record.operations;
    if (!Array.isArray(operations) || operations.length > 16 || operations.some((entry) => typeof entry !== 'string' || entry.length > 64)) return undefined;
    return { ...base, operations: operations as string[] };
  }
  if (op === 'identity') return undefined;
  const binding = parseBinding(record.binding);
  const state = parseState(record.state);
  if (binding === undefined || state === undefined) return undefined;
  return { ...base, binding, state };
}
