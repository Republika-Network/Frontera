import {
  bindingOf,
  isBoundedIdentifier,
  sameBinding,
  sameCheckpoint,
  sameHead,
  type AuthorityStateBinding,
  type AuthorityStateCheckpoint,
  type AuthorityStateKind,
} from './checkpoint.js';
import { AuthorityStateFreshnessError, type AuthorityStateFreshnessErrorCode } from './errors.js';
import type { WitnessBindingState } from './protocol.js';
import { isAuthorityStateFreshnessAnchor, type AuthorityStateFreshnessAnchor, type AuthorityStateWitnessMonitor, type AuthorityStateWitnessStatus } from './witness-client.js';

/**
 * CORE-07 — freshness of authenticated authority state across restarts.
 *
 * ## The problem
 *
 * Every rollback-sensitive store signs its state head, and every read verifies
 * it. That proves a trusted key vouched for the state; it cannot prove the
 * state is the newest one. A captured older head verifies exactly as well as
 * the current one, so restoring a pre-revocation snapshot of the bounded-grant
 * store — or a pre-rejection prefix of the approval store — used to return
 * revoked authority to use after a restart. Nothing *inside* the store's
 * restore domain can fix that: a table, a file beside it, process memory or an
 * environment variable is rolled back with the state it claims to witness.
 *
 * ## The boundary
 *
 * An external witness (`witness-client.ts`) holds, per `(stateKind,
 * organizationId)` slot, the newest checkpoint of that store's already-signed
 * head, and advances it only by compare-and-advance. This file is what a store
 * does with it:
 *
 * 1. **Genesis** (`genesisStoreId`) — a new store is enrolled at the witness
 *    **before** its local genesis is committed. A crash in between leaves a
 *    witnessed genesis and an empty file, and the next start adopts that same
 *    store id (genesis state is deterministic from it), so the two can never
 *    disagree about which store exists.
 * 2. **Startup** (`establish`) — the local head, verified cryptographically by
 *    the store, is compared with the witness **before** the store is handed to
 *    anything. Only provably safe cases proceed: equal, or the witness's
 *    prepared successor is exactly the local head (finalized here). An older
 *    local head is a rollback, a different head at the same position a fork,
 *    a local head the witness has never seen is refused, and a prepared
 *    successor the local store does *not* hold is `pending-recovery`: it is
 *    indistinguishable, by design, from "committed, then rolled back".
 * 3. **Transition** (`transition`) — `prepare` at the witness (expected →
 *    proposed), then the store's local commit, then `finalize`. From `prepare`
 *    on, the witness no longer treats the old head as current, so there is no
 *    acknowledged authority transition a snapshot restore can erase merely
 *    because the process crashed before anchoring it. The network is never
 *    called inside a SQLite write transaction: `prepare` completes before the
 *    store opens its transaction, and `finalize` runs after it commits.
 * 4. **Running** (`observe`) — every authoritative read passes the verified
 *    local head through a floor: the newest checkpoint this process has
 *    established or committed. A lower sequence is a rollback; the same
 *    sequence with a different digest a fork. No network call on a read.
 *
 * There is no fallback. A deployment that composed a witness never silently
 * degrades to the process-only floor: a witness that cannot be reached at
 * startup refuses the store, and one that cannot be reached for a transition
 * refuses the transition with nothing written. And there is no "force clear":
 * a pending transition the local store does not hold is resolved only by
 * trusted operational recovery, never by an API here.
 */

export type AuthorityStateFreshnessStatusValue = 'ready' | 'unavailable' | 'regressed' | 'forked' | 'pending-recovery' | 'unbound';

export interface AuthorityStateFreshnessSessionStatus {
  readonly stateKind: AuthorityStateKind;
  readonly status: AuthorityStateFreshnessStatusValue;
  readonly reason?: AuthorityStateFreshnessErrorCode;
  /** The sequence of the newest checkpoint this process has established or committed. */
  readonly sequence: number;
}

/** The statuses under which a store refuses every authoritative read. */
const FAILED_STATUSES: ReadonlySet<AuthorityStateFreshnessStatusValue> = new Set(['regressed', 'forked', 'pending-recovery', 'unbound']);

export function isFailedAuthorityStateFreshnessStatus(status: AuthorityStateFreshnessStatusValue): boolean {
  return FAILED_STATUSES.has(status);
}

/**
 * The explicit, trusted enrollment of an **existing** store (CORE-07 §12 of the
 * ADR). The operator states that the currently verified local state is the
 * baseline from which monotonic freshness begins — which CORE-07 cannot check:
 * it cannot know whether the state was rolled back before its first trusted
 * enrollment.
 *
 * Constructible only by trusted in-process code, like every writer context in
 * this repository: there is no HTTP route to it, and no composition path
 * builds one. Own data properties only.
 */
export interface AuthorityStateEnrollmentContext {
  readonly operator: true;
  readonly operatorId: string;
  readonly attestation: 'verified-local-state-is-current';
}

function readOwn(source: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  return descriptor !== undefined && 'value' in descriptor ? (descriptor.value as unknown) : undefined;
}

export function isAuthorityStateEnrollmentContext(value: unknown): value is AuthorityStateEnrollmentContext {
  return (
    typeof value === 'object' &&
    value !== null &&
    readOwn(value, 'operator') === true &&
    isBoundedIdentifier(readOwn(value, 'operatorId')) &&
    readOwn(value, 'attestation') === 'verified-local-state-is-current'
  );
}

export interface AuthorityStateFreshnessSession {
  readonly binding: AuthorityStateBinding;
  readonly storeId: string;
  /**
   * Synchronous, local, no network. Called by the store on every authoritative
   * read with the head it has just verified. Throws — and the read refuses —
   * when the session has failed, or the head is older than the floor or
   * differs from it at the same sequence.
   */
  observe(local: AuthorityStateCheckpoint): void;
  /**
   * One authority state transition: `prepare` at the witness, then `commit`
   * (the store's synchronous local write transaction, which must return the
   * state it committed), then `finalize`. Throws, with nothing written, when
   * the witness does not prepare; see the module comment for every other case.
   */
  transition<T>(expected: AuthorityStateCheckpoint, proposed: AuthorityStateCheckpoint, commit: () => { readonly value: T; readonly state: AuthorityStateCheckpoint }): Promise<T>;
  /** Compares the witness with the local head (witness first, then local) and finalizes a transition left prepared by a crash. Serialized with transitions. */
  probe(): Promise<AuthorityStateFreshnessSessionStatus>;
  status(): AuthorityStateFreshnessSessionStatus;
}

export interface AuthorityStateFreshnessBoundary {
  readonly organizationId: string;
  readonly witnessId: string;
  /** The store id a **new**, empty store must be created under — enrolled at the witness before the caller commits its local genesis. */
  genesisStoreId(stateKind: AuthorityStateKind, genesis: { readonly newStoreId: () => string; readonly genesisDigest: (storeId: string) => string }): Promise<string>;
  /** Establishes freshness for an opened store's verified head, or throws. `enrollment` only for the explicit ceremony. */
  establish(local: AuthorityStateCheckpoint, readLocal: () => AuthorityStateCheckpoint, options?: { readonly enrollment?: AuthorityStateEnrollmentContext }): Promise<AuthorityStateFreshnessSession>;
  sessions(): readonly AuthorityStateFreshnessSession[];
  /**
   * The health probe: the witness's signed identity and every session's
   * witness-then-local comparison. Single-flight, and at most once per
   * `probeIntervalMs` — within it the last result's statuses are returned
   * (live, without a network call), so a health check can never fan out
   * witness calls.
   */
  probe(): Promise<AuthorityStateFreshnessProbe>;
}

export interface AuthorityStateFreshnessProbe {
  readonly witness: AuthorityStateWitnessStatus | undefined;
  readonly stores: readonly AuthorityStateFreshnessSessionStatus[];
}

export interface CreateAuthorityStateFreshnessBoundaryOptions {
  readonly anchor: AuthorityStateFreshnessAnchor;
  readonly monitor?: AuthorityStateWitnessMonitor;
  /** The organization this Host serves — the slot every store of this boundary is bound under. */
  readonly organizationId: string;
  /** 0 … 60 000 ms: the minimum age of a probe result before `probe()` asks the witness again. Default 0. */
  readonly probeIntervalMs?: number;
  /** Milliseconds; defaults to `Date.now`. A negative age invalidates the cached probe. For tests. */
  readonly now?: () => number;
}

const BOUNDARIES = new WeakSet<object>();

/** Which boundary each durable authority store was composed under. Module-private; set only by the stores themselves. */
const COMPOSED_UNDER = new WeakMap<object, AuthorityStateFreshnessBoundary>();

/**
 * Records that `store` was opened under `boundary` — its freshness was
 * established at open, or the store refuses every read for the life of the
 * process. Called by the durable authority stores; composition reads it back
 * (`freshnessBoundaryOf`) to state the posture from the composed objects.
 */
export function markComposedUnderFreshness(store: object, boundary: AuthorityStateFreshnessBoundary): void {
  if (isAuthorityStateFreshnessBoundary(boundary)) COMPOSED_UNDER.set(store, boundary);
}

export function freshnessBoundaryOf(store: unknown): AuthorityStateFreshnessBoundary | undefined {
  return typeof store === 'object' && store !== null ? COMPOSED_UNDER.get(store) : undefined;
}

/** Whether `value` was built by `createAuthorityStateFreshnessBoundary` (runtime brand, not shape). */
export function isAuthorityStateFreshnessBoundary(value: unknown): value is AuthorityStateFreshnessBoundary {
  return typeof value === 'object' && value !== null && BOUNDARIES.has(value);
}

function freshness(code: AuthorityStateFreshnessErrorCode, message: string): AuthorityStateFreshnessError {
  return new AuthorityStateFreshnessError(code, message);
}

const STATUS_FOR_CODE: Partial<Record<AuthorityStateFreshnessErrorCode, AuthorityStateFreshnessStatusValue>> = {
  AUTHORITY_FRESHNESS_ROLLBACK_DETECTED: 'regressed',
  AUTHORITY_FRESHNESS_FORK_DETECTED: 'forked',
  AUTHORITY_FRESHNESS_BINDING_MISMATCH: 'forked',
  AUTHORITY_FRESHNESS_PENDING_RECOVERY: 'pending-recovery',
  AUTHORITY_FRESHNESS_UNBOUND_STORE: 'unbound',
};

/**
 * Compares a verified local head with the witnessed state. Returns `ready`,
 * `finalize` (the witness's prepared successor is exactly the local head), or
 * throws the closed refusal. Pure; shared by startup and by the probe.
 */
function reconcile(local: AuthorityStateCheckpoint, witnessed: WitnessBindingState): 'ready' | 'finalize' {
  const kind = local.stateKind;
  if (witnessed.status === 'unbound') {
    throw freshness('AUTHORITY_FRESHNESS_UNBOUND_STORE', `The ${kind} store holds authenticated state the freshness witness has no binding for. It is never enrolled automatically; enroll it explicitly (the enrollment ceremony) if this state is known to be current.`);
  }
  if (witnessed.storeId !== local.storeId) {
    throw freshness('AUTHORITY_FRESHNESS_BINDING_MISMATCH', `The freshness witness binds this organization's ${kind} to a different store than the one opened. A substituted or replaced store is refused.`);
  }
  const { committed, pending } = witnessed;
  if (pending !== undefined && sameHead(pending, local)) return 'finalize';
  if (local.sequence < committed.sequence) {
    throw freshness('AUTHORITY_FRESHNESS_ROLLBACK_DETECTED', `The ${kind} store is at sequence ${local.sequence}, older than the witnessed sequence ${committed.sequence}. An earlier authentic state has been restored; it is refused.`);
  }
  if (pending !== undefined && sameHead(committed, local)) {
    throw freshness(
      'AUTHORITY_FRESHNESS_PENDING_RECOVERY',
      `The freshness witness holds a prepared ${kind} transition (sequence ${pending.sequence}) that the local store does not hold. That is indistinguishable from a committed transition followed by a rollback, so it is refused; resolving it needs trusted operational recovery.`,
    );
  }
  if (sameHead(committed, local)) return 'ready';
  if (local.sequence === committed.sequence || (pending !== undefined && local.sequence === pending.sequence)) {
    throw freshness('AUTHORITY_FRESHNESS_FORK_DETECTED', `The ${kind} store and the freshness witness hold different states at sequence ${local.sequence}. A fork is refused.`);
  }
  throw freshness('AUTHORITY_FRESHNESS_FORK_DETECTED', `The ${kind} store is at sequence ${local.sequence}, ahead of anything the freshness witness has seen. Authority state that was never anchored is refused.`);
}

export function createAuthorityStateFreshnessBoundary(options: CreateAuthorityStateFreshnessBoundaryOptions): AuthorityStateFreshnessBoundary {
  const { anchor, monitor, organizationId } = options;
  if (!isAuthorityStateFreshnessAnchor(anchor)) {
    throw freshness('AUTHORITY_FRESHNESS_CONFIGURATION_INVALID', 'The authority-state freshness boundary needs an anchor established by establishAuthorityStateWitness.');
  }
  if (!isBoundedIdentifier(organizationId)) throw freshness('AUTHORITY_FRESHNESS_CONFIGURATION_INVALID', 'The authority-state freshness boundary needs the organization it serves.');
  const probeIntervalMs = options.probeIntervalMs ?? 0;
  if (!Number.isSafeInteger(probeIntervalMs) || probeIntervalMs < 0 || probeIntervalMs > 60_000) {
    throw freshness('AUTHORITY_FRESHNESS_CONFIGURATION_INVALID', 'The authority-state freshness probe interval must be an integer from 0 to 60000 ms.');
  }
  const now = options.now ?? Date.now;
  const established: AuthorityStateFreshnessSession[] = [];
  let probedAt: number | undefined;
  let probeInFlight: Promise<AuthorityStateFreshnessProbe> | undefined;

  const current = (): AuthorityStateFreshnessProbe => ({ witness: monitor?.status(), stores: established.map((session) => session.status()) });

  function probe(): Promise<AuthorityStateFreshnessProbe> {
    if (probeInFlight !== undefined) return probeInFlight;
    const elapsed = probedAt === undefined ? Number.POSITIVE_INFINITY : now() - probedAt;
    if (elapsed >= 0 && elapsed < probeIntervalMs) return Promise.resolve(current());
    probeInFlight = (async () => {
      try {
        if (monitor !== undefined) await monitor.probe();
        for (const session of established) await session.probe();
      } finally {
        probedAt = now();
      }
      return current();
    })().finally(() => {
      probeInFlight = undefined;
    });
    return probeInFlight;
  }

  async function genesisStoreId(stateKind: AuthorityStateKind, genesis: { readonly newStoreId: () => string; readonly genesisDigest: (storeId: string) => string }): Promise<string> {
    const binding: AuthorityStateBinding = { stateKind, organizationId };
    // Two rounds at most: a lost enrollment race is re-read once, and then the
    // winner's genesis is adopted.
    for (let round = 0; round < 2; round += 1) {
      const witnessed = await anchor.read(binding);
      if (witnessed.status === 'bound') {
        // Adopted only if the witness holds exactly that store's genesis and
        // nothing after it: a crash between enrollment and the local genesis
        // commit (or a concurrent initializer). Recreating that genesis is
        // provably safe — it is deterministic from the store id, and it holds
        // no authority.
        if (witnessed.pending === undefined && witnessed.committed.sequence === 0 && witnessed.committed.stateDigest === genesis.genesisDigest(witnessed.storeId)) return witnessed.storeId;
        throw freshness(
          'AUTHORITY_FRESHNESS_ROLLBACK_DETECTED',
          `The ${stateKind} store is empty, and the freshness witness holds this organization's ${stateKind} beyond genesis. A deleted or replaced store is never re-initialized.`,
        );
      }
      const storeId = genesis.newStoreId();
      const checkpoint: AuthorityStateCheckpoint = { ...binding, storeId, sequence: 0, stateDigest: genesis.genesisDigest(storeId) };
      const answer = await anchor.enroll('genesis', checkpoint);
      if (answer.outcome === 'enrolled') return storeId;
    }
    throw freshness('AUTHORITY_FRESHNESS_CONFLICT', `The ${stateKind} genesis could not be enrolled at the freshness witness: another initializer kept winning. Nothing was created.`);
  }

  async function establish(local: AuthorityStateCheckpoint, readLocal: () => AuthorityStateCheckpoint, establishOptions: { readonly enrollment?: AuthorityStateEnrollmentContext } = {}): Promise<AuthorityStateFreshnessSession> {
    if (local.organizationId !== organizationId) throw freshness('AUTHORITY_FRESHNESS_BINDING_MISMATCH', `The ${local.stateKind} store belongs to another organization than this freshness boundary serves.`);
    const binding = bindingOf(local);
    const enrollment = establishOptions.enrollment;
    if (enrollment !== undefined && !isAuthorityStateEnrollmentContext(enrollment)) {
      throw freshness('AUTHORITY_FRESHNESS_CONFIGURATION_INVALID', 'Enrolling an existing store requires a trusted enrollment context { operator: true, operatorId, attestation }.');
    }
    let witnessed = await anchor.read(binding);
    if (enrollment !== undefined) {
      if (witnessed.status === 'unbound') {
        const answer = await anchor.enroll('baseline', local);
        if (answer.outcome !== 'enrolled') throw freshness('AUTHORITY_FRESHNESS_ALREADY_ENROLLED', `The ${local.stateKind} slot was enrolled concurrently; enrollment never rebinds a slot.`);
        witnessed = answer.state;
      } else if (!(witnessed.storeId === local.storeId && witnessed.pending === undefined && sameHead(witnessed.committed, local))) {
        throw freshness('AUTHORITY_FRESHNESS_ALREADY_ENROLLED', `The freshness witness already binds this organization's ${local.stateKind} to other state. Enrollment never rebinds a slot, and never enrolls another state over it.`);
      }
    }
    if (reconcile(local, witnessed) === 'finalize') {
      // The witness prepared exactly this head and the local store committed
      // it: a crash between commit and finalize. Completing it is safe.
      const answer = await anchor.finalize(local);
      if (answer.outcome !== 'finalized') throw freshness('AUTHORITY_FRESHNESS_FORK_DETECTED', `The ${local.stateKind} transition prepared at the freshness witness could not be finalized over the local state.`);
    }
    const session = createSession(anchor, local, readLocal);
    established.push(session);
    return session;
  }

  const boundary: AuthorityStateFreshnessBoundary = Object.freeze({
    organizationId,
    witnessId: anchor.witnessId,
    genesisStoreId,
    establish,
    sessions: () => [...established],
    probe,
  });
  BOUNDARIES.add(boundary);
  return boundary;
}

function createSession(anchor: AuthorityStateFreshnessAnchor, established: AuthorityStateCheckpoint, readLocal: () => AuthorityStateCheckpoint): AuthorityStateFreshnessSession {
  const binding = bindingOf(established);
  const { storeId } = established;
  const kind = established.stateKind;
  /** The newest checkpoint this process has established or committed. Only ever moves forward. */
  let floor: AuthorityStateCheckpoint = established;
  /** A failure that is never cleared in this process: the store refuses every read until an operator acts. */
  let sticky: AuthorityStateFreshnessError | undefined;
  /** The last read's observation failure. Cleared by the next read that observes a fresh head. */
  let observed: AuthorityStateFreshnessError | undefined;
  /** A transition committed locally whose `finalize` has not been confirmed. Local and witness-pending agree; it is completed before the next transition. */
  let unfinalized: AuthorityStateCheckpoint | undefined;
  /** The last witness call made on behalf of this session failed for availability. */
  let witnessUnavailable: AuthorityStateFreshnessErrorCode | undefined;
  /** Transitions and probes run one at a time, so a probe never sees this session's own prepared-but-uncommitted transition. */
  let queue: Promise<unknown> = Promise.resolve();

  function serialized<T>(run: () => Promise<T>): Promise<T> {
    const result = queue.then(run);
    queue = result.catch(() => undefined);
    return result;
  }

  function fail(error: AuthorityStateFreshnessError): never {
    sticky ??= error;
    throw sticky;
  }

  function observe(local: AuthorityStateCheckpoint): void {
    if (sticky !== undefined) throw sticky;
    let problem: AuthorityStateFreshnessError | undefined;
    if (!sameBinding(local, binding) || local.storeId !== storeId) {
      problem = freshness('AUTHORITY_FRESHNESS_BINDING_MISMATCH', `The ${kind} store read under this process is not the store whose freshness was established.`);
    } else if (local.sequence < floor.sequence) {
      problem = freshness('AUTHORITY_FRESHNESS_ROLLBACK_DETECTED', `The ${kind} store regressed from sequence ${floor.sequence} to ${local.sequence} under this process.`);
    } else if (local.sequence === floor.sequence && local.stateDigest !== floor.stateDigest) {
      problem = freshness('AUTHORITY_FRESHNESS_FORK_DETECTED', `The ${kind} store holds a different state at sequence ${local.sequence} than the one this process established.`);
    }
    if (problem !== undefined) {
      observed = problem;
      throw problem;
    }
    observed = undefined;
    if (local.sequence > floor.sequence) floor = local;
  }

  async function witnessCall<T>(call: () => Promise<T>): Promise<T> {
    try {
      const value = await call();
      witnessUnavailable = undefined;
      return value;
    } catch (error) {
      if (error instanceof AuthorityStateFreshnessError && error.code === 'AUTHORITY_FRESHNESS_UNAVAILABLE') witnessUnavailable = error.code;
      throw error;
    }
  }

  /** Completes an earlier transition whose finalize never arrived. Throws (nothing written) when the witness cannot be reached. */
  async function finalizeOutstanding(): Promise<void> {
    if (unfinalized === undefined) return;
    const pending = unfinalized;
    const answer = await witnessCall(() => anchor.finalize(pending));
    const witnessed = answer.state;
    if (answer.outcome === 'finalized' || (witnessed.status === 'bound' && witnessed.storeId === storeId && witnessed.pending === undefined && sameHead(witnessed.committed, pending))) {
      unfinalized = undefined;
      return;
    }
    fail(freshness('AUTHORITY_FRESHNESS_FORK_DETECTED', `The ${kind} transition this process committed could not be finalized at the freshness witness.`));
  }

  function transition<T>(expected: AuthorityStateCheckpoint, proposed: AuthorityStateCheckpoint, commit: () => { readonly value: T; readonly state: AuthorityStateCheckpoint }): Promise<T> {
    return serialized(async () => {
      if (sticky !== undefined) throw sticky;
      if (!sameBinding(expected, binding) || expected.storeId !== storeId || !sameBinding(proposed, binding) || proposed.storeId !== storeId || proposed.sequence !== expected.sequence + 1) {
        throw freshness('AUTHORITY_FRESHNESS_CONFIGURATION_INVALID', `A ${kind} transition must advance this store by exactly one position.`);
      }
      await finalizeOutstanding();

      // 1. PREPARE — before any local write. A witness that cannot prepare
      //    leaves the local store exactly as it was.
      let answer = await witnessCall(() => anchor.prepare(expected, proposed));
      if (answer.outcome === 'conflict') {
        const witnessed = answer.state;
        // The one conflict this side can resolve: the witness holds, prepared,
        // exactly the head the store just verified as current — a committed
        // transition whose finalize never arrived. Completing it is safe; then
        // prepare once more.
        if (witnessed.status === 'bound' && witnessed.storeId === storeId && witnessed.pending !== undefined && sameHead(witnessed.pending, expected)) {
          const finalized = await witnessCall(() => anchor.finalize(expected));
          if (finalized.outcome !== 'finalized') throw freshness('AUTHORITY_FRESHNESS_CONFLICT', `The ${kind} witness state moved while a transition was being prepared. Nothing was written.`);
          answer = await witnessCall(() => anchor.prepare(expected, proposed));
        }
        if (answer.outcome === 'conflict') {
          throw freshness('AUTHORITY_FRESHNESS_CONFLICT', `The freshness witness did not prepare this ${kind} transition: another writer advanced or prepared the witnessed state first. Nothing was written.`);
        }
      }

      // 2. LOCAL COMMIT — synchronous, inside the store's own transaction, which
      //    revalidates that the local state is still `expected`. The witness now
      //    holds `proposed` prepared, so the old state is no longer current
      //    there: whatever happens next, a restore of `expected` is refused.
      let committed: { readonly value: T; readonly state: AuthorityStateCheckpoint };
      try {
        committed = commit();
      } catch (error) {
        const cause = error instanceof Error && 'code' in error && typeof (error as { code: unknown }).code === 'string' ? (error as { code: string }).code : 'local commit failed';
        fail(freshness('AUTHORITY_FRESHNESS_PENDING_RECOVERY', `The ${kind} transition was prepared at the freshness witness, and its local commit did not complete (${cause}). The store refuses authority reads until trusted operational recovery resolves it.`));
      }
      if (!sameCheckpoint(committed.state, proposed)) {
        fail(freshness('AUTHORITY_FRESHNESS_PENDING_RECOVERY', `The ${kind} transition prepared at the freshness witness is not the state the local store committed. The store refuses authority reads until trusted operational recovery resolves it.`));
      }
      if (proposed.sequence > floor.sequence) floor = proposed;

      // 3. FINALIZE — after the commit. A finalize that does not arrive leaves
      //    local and witness-pending in exact agreement: safe, and completed
      //    before the next transition or by the next start.
      try {
        const finalized = await witnessCall(() => anchor.finalize(proposed));
        const witnessed = finalized.state;
        if (finalized.outcome !== 'finalized' && !(witnessed.status === 'bound' && witnessed.storeId === storeId && witnessed.pending === undefined && sameHead(witnessed.committed, proposed))) {
          fail(freshness('AUTHORITY_FRESHNESS_FORK_DETECTED', `The freshness witness refused to finalize the ${kind} transition this process committed.`));
        }
      } catch (error) {
        if (sticky !== undefined) throw error;
        unfinalized = proposed;
      }
      return committed.value;
    });
  }

  function probe(): Promise<AuthorityStateFreshnessSessionStatus> {
    return serialized(async () => {
      if (sticky !== undefined) return status();
      let witnessed: WitnessBindingState;
      try {
        // The witness first, then the local head: a transition another writer
        // completes in between can then only make the local head *newer* than
        // what was read from the witness, never older.
        witnessed = await witnessCall(() => anchor.read(binding));
      } catch {
        return status();
      }
      let local: AuthorityStateCheckpoint;
      try {
        local = readLocal();
      } catch {
        return status();
      }
      try {
        if (reconcile(local, witnessed) === 'finalize') {
          const answer = await witnessCall(() => anchor.finalize(local));
          if (answer.outcome === 'finalized' && unfinalized !== undefined && sameHead(unfinalized, local)) unfinalized = undefined;
        } else if (unfinalized !== undefined && witnessed.status === 'bound' && sameHead(witnessed.committed, unfinalized)) {
          unfinalized = undefined;
        }
      } catch (error) {
        if (error instanceof AuthorityStateFreshnessError && STATUS_FOR_CODE[error.code] !== undefined) sticky ??= error;
      }
      return status();
    });
  }

  function status(): AuthorityStateFreshnessSessionStatus {
    const failure = sticky ?? observed;
    const value: AuthorityStateFreshnessStatusValue =
      failure !== undefined ? (STATUS_FOR_CODE[failure.code] ?? 'forked') : unfinalized !== undefined || witnessUnavailable !== undefined ? 'unavailable' : 'ready';
    const reason = failure?.code ?? (unfinalized !== undefined || witnessUnavailable !== undefined ? 'AUTHORITY_FRESHNESS_UNAVAILABLE' : undefined);
    return Object.freeze({ stateKind: kind, status: value, ...(reason !== undefined ? { reason } : {}), sequence: floor.sequence });
  }

  return Object.freeze({ binding, storeId, observe, transition, probe, status });
}
