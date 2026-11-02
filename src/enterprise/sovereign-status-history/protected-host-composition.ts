import { statSync } from 'node:fs';
import { resolve } from 'node:path';

import { FV_BOOTSTRAP_IDENTITY_STATE_KIND, createHumanIdentityServiceWithBootstrapSettlement, isBootstrapSettlementCapabilityOf, openSqliteHumanIdentityStore, revokeBootstrapSettlementCapability } from '../human-identity/index.js';
import type { HumanIdentityStore, IssuedBootstrapAuthorityChallenge, RelyingPartyConfiguration, SqliteHumanIdentityStoreOptions } from '../human-identity/index.js';
import { createFvBootstrapAuthorityBoundary } from './authority-boundary.js';
import { createKernelAuthorityBootstrapPermissions } from './authority-permissions.js';
import type { BootstrapStandingPort } from './authority-permissions.js';
import type { BootstrapAuthorityReconciliationEntry } from './authority-settlement.js';
import { isIdentifier, parseStatusHistoryBootstrapRequest } from './bootstrap-contract.js';
import type { StatusSourcePolicy, StatusSourceVerifier } from './bootstrap-contract.js';
import { coordinateStatusHistoryBootstrap } from './bootstrap-coordinator.js';
import type { StatusHistoryBootstrapResult, StatusHistoryReceiverPort } from './bootstrap-coordinator.js';
import { checkProtectedFile, confirmExclusivelyHeld, exclusiveCloser, exclusivitySupported, heldByAnotherProcess } from './executor-exclusivity.js';
import type { ProtectedPathRefusal } from './executor-exclusivity.js';
import { createHostHistoryInventory } from './host-inventory.js';
import type { HostHistoryConfiguration, HostInventoryStatus } from './host-inventory.js';
import { createHumanDecisionBootstrapAuthorizer } from './human-decision-authorizer.js';
import { openProtectedContinuityStore } from './protected-continuity-store.js';
import type { ProtectedContinuityStore } from './protected-continuity-store.js';

/**
 * FV-P4C-2B3B — the protected FV Host composition (internal, not composed into the running Host,
 * unreachable from every route, CLI and startup path; pinned by structure tests).
 *
 * It owns, and never hands out:
 * - the **protected record and intent store**, opened exclusively: its lock is the executor's
 *   authority, and its epoch numbers each acquisition;
 * - every admitted **history handle**, opened exclusively and fenced on every write;
 * - the **AUTH-03 settlement capability**, issued here with its service, custody-checked with
 *   AUTH-03's own `isBootstrapSettlementCapabilityOf`, revoked at `close()`;
 * - the **in-flight registry**, the **inventory** and the **authority boundary**;
 * - the **coordinator call** itself (closing B3A's F4): `bootstrap()` takes data only (a request, a
 *   signed status, two signed decision responses), never code. The boundary's decision port goes only
 *   to the authorizer built for that one call (closing B3A's L1).
 *
 * **Startup** (`composeFvProtectedHost`):
 * 1. read the protected configuration and validate it;
 * 2. check the filesystem policy of the protected store and of every history (owner-only, canonical,
 *    no links); a history that fails is quarantined, a protected store that fails refuses startup;
 * 3. acquire the protected store exclusively (`EXECUTOR_HELD` if another Host holds it) and durably
 *    advance its epoch;
 * 4–8. open, assess and admit every history exclusively; resolve pending intents only by evidence;
 *    quarantine every unresolved namespace;
 * 9. issue the AUTH-03 pair and build the boundary over it;
 * 10. build the Kernel-Authority permissions and the coordinator context;
 * 11. expose status and the narrow ceremony and bootstrap methods only;
 * 12. **bootstrap execution stays disabled** unless the trusted composition passes a status source.
 *     No trusted issuer-currentness source exists in the Host (B6), so nothing in the running Host can.
 *
 * **Losing authority.** Every write, and every bootstrap and reconciliation, first confirms from the
 * kernel's lock table that this process still holds its locks on the files its paths name
 * (`executor-exclusivity.ts`). The first failure marks the composition `executor-lost`: it starts
 * nothing new, believes no outcome, and leaves intents pending.
 *
 * **Platform.** Linux only: elsewhere exclusivity cannot be confirmed, and startup is refused.
 *
 * **Not here:** backup promotion and restore ceremonies, and resolving quarantined intents (B3C); a
 * trusted status source (B6); an independent continuity witness (FV-P4D); any document use (FV-P5).
 */

export class FvProtectedHostError extends Error {
  constructor(
    readonly code: 'OPTIONS_INVALID' | 'PLATFORM_UNSUPPORTED' | 'PATH_REFUSED' | 'EXECUTOR_HELD' | 'PROTECTED_STORE_REFUSED' | 'IDENTITY_REFUSED' | 'CUSTODY_REFUSED',
    message: string,
  ) {
    super(message);
    this.name = 'FvProtectedHostError';
  }
}

export interface FvProtectedHostOptions {
  /** The protected record and intent store: the Host's trusted configuration, never a request's. */
  readonly protectedStorePath: string;
  /** Create the protected store (the B3C registration ceremony only). Never implied. */
  readonly initializeProtectedStore?: boolean;
  /** The Host's protected history configuration. */
  readonly configuration: () => HostHistoryConfiguration | undefined;
  /**
   * FV-P4C-2B3C-3 — the executor's **own** AUTH-03 bootstrap identity store: opened here, held exclusively
   * by this process for the composition's lifetime (no other connection, in any process, can open it), its
   * every write fenced by this executor's authority, closed only through the guarded closer. It is never
   * AUTH-04A's store and is never handed in already open: there is exactly one owner.
   * - `storePath`: the trusted configuration's path, under the same filesystem policy as every FV file.
   * - `storeId`: its durable identity, pinned when it was registered. Another store at that path (AUTH-04A's,
   *   a copy, a replacement), even one signed by the same deployment key, is refused.
   * - `authenticity` and `freshness` (CORE-07): the deployment's signer and verifier, and the witness. The
   *   freshness option names its domain explicitly, `stateKind: 'fv-bootstrap-identity-state'`
   *   (CORE-07-FV-WITNESS): the FV store's own slot, never the Host's `human-identity-state`. Never an enrollment.
   */
  readonly identity: {
    readonly storePath: string;
    readonly storeId: string;
    readonly authenticity: SqliteHumanIdentityStoreOptions['authenticity'];
    readonly freshness?: { readonly boundary: NonNullable<SqliteHumanIdentityStoreOptions['freshness']>['boundary']; readonly stateKind: typeof FV_BOOTSTRAP_IDENTITY_STATE_KIND };
    readonly relyingParty: RelyingPartyConfiguration;
    readonly operatorIds: readonly string[];
  };
  /** CORE-05's approver-standing port, answered from Kernel-Authority. */
  readonly standing: BootstrapStandingPort;
  readonly organizationId: string;
  /** The Host's trusted clock. */
  readonly clock: () => Date;
  readonly graceSeconds: number;
  readonly maxDecisions?: number;
  /** The receiver package's `verifySovereignStatus` and `establishStatusHistory`. */
  readonly receiver: StatusHistoryReceiverPort;
  readonly verificationKeyResolver: unknown;
  /** What the Host itself verified about an asset (RSDK-01 / FV-P2); `undefined` refuses. */
  readonly trustedSubjectOf: (sovereignAssetId: string) => { readonly sovereignAssetId: string; readonly registrant: string; readonly manifestDigest: string } | undefined;
  /**
   * The issuer-currentness source and its policy. Absent (the default, and the only possibility in the
   * running Host until B6): every bootstrap is refused `BOOTSTRAP_DISABLED` before anything is consumed.
   */
  readonly statusSource?: { readonly verifier: StatusSourceVerifier; readonly policy: StatusSourcePolicy };
}

export type FvProtectedHostReadiness = 'ready' | 'degraded' | 'unavailable' | 'executor-lost' | 'closed';

export interface FvProtectedHostStatus {
  readonly readiness: FvProtectedHostReadiness;
  readonly epoch: number;
  readonly bootstrapExecution: 'disabled' | 'enabled';
  /** Histories refused by the filesystem policy: never opened, quarantined. */
  readonly pathRefusals: Readonly<Record<string, ProtectedPathRefusal>>;
  /** Pending intents by namespace (request ids); `null` when the store cannot be read. */
  readonly pendingIntents: Readonly<Record<string, readonly string[] | null>>;
  readonly inventory: HostInventoryStatus;
}

export type FvProtectedBootstrapRefusal =
  | 'CLOSED'
  | 'EXECUTOR_LOST'
  | 'BOOTSTRAP_DISABLED'
  | 'REQUEST_INVALID'
  | 'SUBJECT_UNKNOWN'
  | 'DUPLICATE'
  | 'HISTORY_NOT_ADMITTED'
  | 'INVENTORY_REFRESHING'
  | 'EXECUTOR_NOT_HELD';

export type FvProtectedBootstrapOutcome =
  | { readonly outcome: 'ran'; readonly result: StatusHistoryBootstrapResult }
  | { readonly outcome: 'refused'; readonly reason: FvProtectedBootstrapRefusal };

export interface FvProtectedHost {
  status(): FvProtectedHostStatus;
  /** The human ceremony's challenge for one bootstrap decision (AUTH-03's own, nothing else of the service). */
  beginBootstrapDecision(input: { readonly operatorId: string; readonly namespace: string; readonly bindingDigest: string; readonly role: 'attest' | 'approve' }): IssuedBootstrapAuthorityChallenge;
  /** One bootstrap through the real coordinator, with data only. */
  bootstrap(input: { readonly request: unknown; readonly signedStatusText: unknown; readonly requesterResponse: unknown; readonly approverResponse: unknown }): Promise<FvProtectedBootstrapOutcome>;
  /** One reconciliation run from the histories' own evidence. */
  reconcile(): Promise<readonly BootstrapAuthorityReconciliationEntry[]>;
  /** Releases everything: the capability is revoked, every lock released. Running work fails closed. */
  close(): void;
}

const refusal = (reason: FvProtectedBootstrapRefusal): FvProtectedBootstrapOutcome => Object.freeze({ outcome: 'refused' as const, reason });

export async function composeFvProtectedHost(options: FvProtectedHostOptions): Promise<FvProtectedHost> {
  const invalid = (message: string): never => {
    throw new FvProtectedHostError('OPTIONS_INVALID', message);
  };
  if (typeof options !== 'object' || options === null) invalid('The protected FV Host needs its options.');
  const { protectedStorePath, configuration, identity: identityOption, standing, organizationId, clock, graceSeconds, maxDecisions, receiver, verificationKeyResolver, trustedSubjectOf, statusSource } = options;
  if (typeof protectedStorePath !== 'string' || protectedStorePath.trim() === '') invalid('protectedStorePath is the protected store file.');
  if (typeof configuration !== 'function' || typeof clock !== 'function' || typeof trustedSubjectOf !== 'function') invalid('configuration, clock and trustedSubjectOf are the Host’s own functions.');
  if (!isIdentifier(organizationId, 256)) invalid('organizationId is the one organization this Host serves.');
  if (typeof identityOption !== 'object' || identityOption === null) invalid('identity is the executor’s own bootstrap identity store configuration.');
  // A handed-in store is never accepted (it could be AUTH-04A's, or shared): the executor opens its own.
  if ('store' in identityOption) invalid('The executor opens and owns its bootstrap identity store; an already opened store is never accepted.');
  // PR #255 review, finding 1: every field is read exactly once, into this snapshot. Every check below and every use
  // after is of the snapshot, never of the caller's object, so no getter, Proxy or later mutation can change what was
  // checked. The freshness option is rebuilt to carry its boundary only: an enrollment never reaches the store.
  const rawFreshness = identityOption.freshness;
  const identity = Object.freeze({
    storePath: identityOption.storePath,
    storeId: identityOption.storeId,
    authenticity: identityOption.authenticity,
    relyingParty: identityOption.relyingParty,
    operatorIds: identityOption.operatorIds,
  });
  if (typeof identity.storePath !== 'string' || identity.storePath.trim() === '' || identity.storePath.includes('\0')) invalid('identity.storePath is the executor’s own bootstrap identity store file.');
  if (typeof identity.storeId !== 'string' || !/^human-identity-store:[0-9a-f-]{36}$/.test(identity.storeId)) invalid('identity.storeId is the pinned id of the executor’s bootstrap identity store.');
  if (typeof identity.authenticity !== 'object' || identity.authenticity === null) invalid('identity.authenticity is the deployment’s signer and verifier.');
  // Review M1: never a CORE-07 enrollment from here; binding a witness slot is an operator ceremony.
  // CORE-07-FV-WITNESS: the FV store's own freshness domain, named explicitly ('fv-bootstrap-identity-state'), never
  // the Host's 'human-identity-state' slot and never a default. Each field is read once; the store receives a fresh
  // option holding the boundary and the domain constant, never the caller's object.
  if (rawFreshness !== undefined && (typeof rawFreshness !== 'object' || rawFreshness === null || 'enrollment' in rawFreshness)) invalid('identity.freshness is a boundary only; the composition never enrolls a witness slot.');
  const rawFreshnessDomain: unknown = rawFreshness?.stateKind;
  if (rawFreshness !== undefined && rawFreshnessDomain !== FV_BOOTSTRAP_IDENTITY_STATE_KIND) invalid('identity.freshness names the FV bootstrap identity freshness domain explicitly (fv-bootstrap-identity-state); never the Host’s slot, another domain or none.');
  const freshnessOption: SqliteHumanIdentityStoreOptions['freshness'] = rawFreshness === undefined ? undefined : Object.freeze({ boundary: rawFreshness.boundary, stateKind: FV_BOOTSTRAP_IDENTITY_STATE_KIND });
  if (typeof receiver?.verifySovereignStatus !== 'function' || typeof receiver.establishStatusHistory !== 'function') invalid('receiver is the receiver package’s functions.');
  if (statusSource !== undefined && (typeof statusSource?.verifier?.attestStatusSource !== 'function' || typeof statusSource.policy !== 'object' || statusSource.policy === null)) invalid('statusSource is a verifier and its policy.');
  if (options.initializeProtectedStore !== undefined && typeof options.initializeProtectedStore !== 'boolean') invalid('initializeProtectedStore is a boolean.');
  const iso = (): string => clock().toISOString();
  const protectedPath = resolve(protectedStorePath);
  if (!exclusivitySupported()) throw new FvProtectedHostError('PLATFORM_UNSUPPORTED', 'Exclusive execution cannot be held or confirmed here (Linux /proc/self/fdinfo of this process’s own /proc, on the main thread, is required); nothing was opened.');

  // 1–2. Configuration and filesystem policy, before anything is opened.
  let loaded: HostHistoryConfiguration | undefined;
  try {
    loaded = configuration();
  } catch {
    loaded = undefined;
  }
  const configured = new Map<string, string>();
  for (const entry of Array.isArray(loaded?.histories) ? loaded!.histories : []) {
    // Review R2-L: a malformed or duplicated entry refuses the configuration; nothing is merged or dropped silently.
    if (typeof entry?.namespace !== 'string' || typeof entry.databasePath !== 'string' || configured.has(entry.namespace)) invalid('The history configuration names each namespace once, with a database path.');
    configured.set(entry.namespace, resolve(entry.databasePath));
  }
  if ([...configured.values()].includes(protectedPath)) invalid('The protected store is never also a history.');
  // Release review L1: not by name only. The same file reached by another path (a bind mount) is refused by identity.
  const identityOf = (path: string): string | undefined => {
    try {
      const st = statSync(path, { bigint: true });
      return `${st.dev}:${st.ino}`;
    } catch {
      return undefined;
    }
  };
  const protectedIdentity = identityOf(protectedPath);
  if (protectedIdentity !== undefined && [...configured.values()].some((path) => identityOf(path) === protectedIdentity)) invalid('The protected store is never also a history.');
  // Nor are two histories one file under two names (a raw header read of one would drop the other's lock).
  // FV-P4C-2B3C-3: the identity store is its own file too, by name and by identity.
  const identityPath = resolve(identity.storePath);
  const identityStoreFile = identityOf(identityPath);
  if (identityPath === protectedPath || [...configured.values()].includes(identityPath) || (identityStoreFile !== undefined && (identityStoreFile === protectedIdentity || [...configured.values()].some((path) => identityOf(path) === identityStoreFile)))) {
    invalid('The bootstrap identity store is its own file: never the protected store nor a history.');
  }
  const historyIdentities = [...configured.values()].map(identityOf).filter((id): id is string => id !== undefined);
  if (new Set(historyIdentities).size !== historyIdentities.length || new Set(configured.values()).size !== configured.size) invalid('Each history is its own file.');
  // The one configuration snapshot that was checked is the one the inventory loads.
  const snapshot = loaded === undefined ? undefined : Object.freeze({ generation: loaded.generation, histories: Object.freeze([...configured].map(([namespace, databasePath]) => Object.freeze({ namespace, databasePath }))) });
  const storeRefusal = checkProtectedFile(protectedPath, { allowMissing: options.initializeProtectedStore === true });
  if (storeRefusal !== undefined) throw new FvProtectedHostError('PATH_REFUSED', `The protected store path is refused (${storeRefusal}); nothing was opened.`);
  const identityRefusal = checkProtectedFile(identityPath);
  if (identityRefusal !== undefined) throw new FvProtectedHostError('PATH_REFUSED', `The bootstrap identity store path is refused (${identityRefusal}); nothing was opened.`);
  const pathRefusals: Record<string, ProtectedPathRefusal> = {};
  for (const [namespace, path] of configured) {
    const refused = checkProtectedFile(path);
    if (refused !== undefined) pathRefusals[namespace] = refused;
  }

  // The executor's state. The protected store's lock is the executor's authority: the first failed
  // confirmation of it loses the executor for good. A history's lock is that namespace's: losing it fences
  // and excludes that history only.
  let lost = false;
  let closed = false;
  // FV-P4C-2B3C-3 (review L3): once the executor's own identity store is open, its lock is part of the
  // executor's authority too; losing it loses the executor (readiness `executor-lost`), not only its writes.
  let identityOpen = false;
  const authority = (): boolean => {
    if (lost || closed) return false;
    if (confirmExclusivelyHeld(identityOpen ? [protectedPath, identityPath] : [protectedPath])) return true;
    lost = true;
    return false;
  };
  const heldHistory = (path: string): boolean => authority() && checkProtectedFile(path) === undefined && confirmExclusivelyHeld([path]);
  const fence = (check: () => boolean) => (): void => {
    if (!check()) throw new Error('exclusive execution is not held');
  };

  // 3. Exclusive authority: the protected store, epoch advanced durably.
  // Linux CI (B3B-REL): two Hosts opening together can each keep SQLite's SHARED lock from their first read
  // (exclusive locking mode retains it), so each blocks the other's EXCLUSIVE and both refuse. A refused
  // attempt never held the lock and its connection is already closed (releasing that SHARED lock), so the
  // acquisition is retried a bounded number of times after a random pause. Initialization is never retried,
  // and a store another live Host holds is still refused (`EXECUTOR_HELD`) once the attempts are spent.
  const ACQUIRE_ATTEMPTS = 6;
  let records: ProtectedContinuityStore;
  try {
    for (let attempt = 1; ; attempt += 1) {
      try {
        records = await openProtectedContinuityStore(protectedPath, { now: iso, create: options.initializeProtectedStore === true, beforeWrite: fence(() => checkProtectedFile(protectedPath) === undefined && authority()) });
        break;
      } catch (error) {
        if ((error as { code?: unknown }).code !== 'EXECUTOR_HELD' || options.initializeProtectedStore === true || attempt >= ACQUIRE_ATTEMPTS) throw error;
        await new Promise((done) => setTimeout(done, 5 + Math.floor(Math.random() * 20 * attempt)));
      }
    }
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === 'EXECUTOR_HELD') throw new FvProtectedHostError('EXECUTOR_HELD', 'Another FV executor holds the protected store; this Host executes nothing.');
    throw new FvProtectedHostError('PROTECTED_STORE_REFUSED', `The protected store could not be opened: ${(error as Error).message}`);
  }

  // 3b. FV-P4C-2B3C-3: the executor's own bootstrap identity store, exclusively, after the protected store (a
  // second executor refused there never touches it). Every write it makes — challenges, consumptions,
  // settlements — first confirms, synchronously inside its own transaction, that this process still holds
  // the identity store, the protected store and the executor's authority.
  let identityStore: HumanIdentityStore;
  try {
    identityStore = await openSqliteHumanIdentityStore(identityPath, {
      organizationId,
      now: iso,
      authenticity: identity.authenticity,
      ...(freshnessOption !== undefined ? { freshness: freshnessOption } : {}),
      exclusive: { beforeWrite: fence(() => checkProtectedFile(identityPath) === undefined && confirmExclusivelyHeld([identityPath]) && authority()), closer: exclusiveCloser, storeId: identity.storeId },
    });
  } catch (error) {
    records.close();
    // Held by another process: a previous executor still alive (retryable, like the protected store).
    if (heldByAnotherProcess(identityPath)) throw new FvProtectedHostError('EXECUTOR_HELD', 'Another process holds the bootstrap identity store; this Host executes nothing.');
    throw new FvProtectedHostError('IDENTITY_REFUSED', `The bootstrap identity store could not be opened: ${(error as Error).message}`);
  }
  if (identityStore.storeId !== identity.storeId || identityStore.organizationId !== organizationId || !confirmExclusivelyHeld([identityPath])) {
    identityStore.close();
    records.close();
    throw new FvProtectedHostError('IDENTITY_REFUSED', 'The store at the bootstrap identity path is not the pinned one (another store, a copy or a replacement), or it is not held; nothing is served.');
  }
  identityOpen = true;

  // 4–8. Every history, exclusively; pending intents resolved by evidence only; the rest quarantined.
  const inventory = createHostHistoryInventory({
    configuration: () => {
      if (snapshot === undefined) return undefined;
      // A history the filesystem policy refused is never opened (it stays out of every snapshot).
      return { generation: snapshot.generation, histories: snapshot.histories.filter((h) => pathRefusals[h.namespace] === undefined) };
    },
    records,
    now: iso,
    exclusive: {
      beforeWrite: (file: string) => fence(() => heldHistory(file))(),
      confirmHeld: (namespace: string) => {
        const path = configured.get(namespace);
        return path !== undefined && heldHistory(path);
      },
    },
  });
  let inventoryStatus: HostInventoryStatus;
  try {
    inventoryStatus = await inventory.refresh();
  } catch {
    inventory.close();
    identityStore.close();
    records.close();
    throw new FvProtectedHostError('PROTECTED_STORE_REFUSED', 'The history inventory could not be loaded; nothing is served.');
  }

  // 9. AUTH-03 custody: the pair is issued here, and the capability never leaves this closure.
  let issued: ReturnType<typeof createHumanIdentityServiceWithBootstrapSettlement>;
  let boundary: ReturnType<typeof createFvBootstrapAuthorityBoundary>;
  try {
    issued = createHumanIdentityServiceWithBootstrapSettlement({ store: identityStore, relyingParty: identity.relyingParty, operatorIds: identity.operatorIds, now: clock });
    if (issued.service.organizationId !== organizationId) throw new TypeError('The identity store serves another organization.');
    boundary = createFvBootstrapAuthorityBoundary({
      service: issued.service,
      settlement: issued.settlementCapability,
      custody: isBootstrapSettlementCapabilityOf,
      histories: inventory,
      organizationId,
      now: iso,
      graceSeconds,
      ...(maxDecisions !== undefined ? { maxDecisions } : {}),
      // Final review I3: authority is re-confirmed immediately before every settlement, not only when reconcile() starts.
      settlementGuard: () => authority(),
    });
  } catch (error) {
    inventory.close();
    identityStore.close();
    records.close();
    throw new FvProtectedHostError('CUSTODY_REFUSED', `AUTH-03 custody could not be established: ${(error as Error).message}`);
  }
  const { service, settlementCapability } = issued;
  const begin = service.beginBootstrapAuthorityDecision.bind(service);

  // 10. Kernel-Authority permissions, from the Host's standing port.
  const permissions = createKernelAuthorityBootstrapPermissions({ standing, organizationId, now: iso });

  const status = (): FvProtectedHostStatus => {
    inventoryStatus = inventory.status();
    const counts = inventoryStatus.readiness;
    const readiness: FvProtectedHostReadiness = closed ? 'closed' : lost ? 'executor-lost' : counts === 'ready' && Object.keys(pathRefusals).length === 0 ? 'ready' : counts === 'ready' || counts === 'degraded' ? 'degraded' : 'unavailable';
    const pendingIntents: Record<string, readonly string[] | null> = {};
    for (const namespace of configured.keys()) {
      try {
        pendingIntents[namespace] = closed ? null : Object.freeze(records.pendingIntents(namespace).map((i) => i.requestId));
      } catch {
        pendingIntents[namespace] = null;
      }
    }
    return Object.freeze({ readiness, epoch: records.epoch, bootstrapExecution: statusSource === undefined ? 'disabled' : 'enabled', pathRefusals: Object.freeze({ ...pathRefusals }), pendingIntents: Object.freeze(pendingIntents), inventory: inventoryStatus });
  };

  const host: FvProtectedHost = Object.freeze({
    status,
    beginBootstrapDecision(input: { readonly operatorId: string; readonly namespace: string; readonly bindingDigest: string; readonly role: 'attest' | 'approve' }) {
      if (closed) throw new TypeError('The protected FV Host is closed.');
      return begin(input);
    },
    async bootstrap(input: { readonly request: unknown; readonly signedStatusText: unknown; readonly requesterResponse: unknown; readonly approverResponse: unknown }): Promise<FvProtectedBootstrapOutcome> {
      if (closed) return refusal('CLOSED');
      if (lost) return refusal('EXECUTOR_LOST');
      if (statusSource === undefined) return refusal('BOOTSTRAP_DISABLED');
      // Data only, read once: the caller's objects are never read again (no getter can switch them later).
      let request: unknown;
      let signedStatusText: unknown;
      let requesterResponse: unknown;
      let approverResponse: unknown;
      try {
        ({ request, signedStatusText, requesterResponse, approverResponse } = JSON.parse(JSON.stringify({ request: input?.request, signedStatusText: input?.signedStatusText, requesterResponse: input?.requesterResponse, approverResponse: input?.approverResponse })) as Record<string, unknown>);
      } catch {
        return refusal('REQUEST_INVALID');
      }
      const parsed = parseStatusHistoryBootstrapRequest(request);
      if (parsed === undefined) return refusal('REQUEST_INVALID');
      const subject = trustedSubjectOf(parsed.sovereignAssetId);
      if (subject === undefined) return refusal('SUBJECT_UNKNOWN');
      const trustedSubject = Object.freeze({ sovereignAssetId: subject.sovereignAssetId, registrant: subject.registrant, manifestDigest: subject.manifestDigest });
      const ran = await boundary.runBootstrap(request, async (registered, history) => {
        // The authorizer is built for this one call: the decision port reaches nothing else.
        const authorizer = createHumanDecisionBootstrapAuthorizer({ decisions: boundary.bootstrapDecisions, organizationId, permissions, requesterResponse, approverResponse });
        // Awaited to its end: the registration and the intent settle only after the durable commit (F7).
        return coordinateStatusHistoryBootstrap(registered, signedStatusText, {
          store: history,
          trustedSubject,
          evaluationTime: iso(),
          operationId: `op:fv-protected:${records.epoch}:${registered.requestId}`,
          verificationKeyResolver,
          receiver,
          authorizer,
          sourceVerifier: statusSource.verifier,
          sourcePolicy: statusSource.policy,
        });
      });
      if (ran.outcome === 'refused') return refusal(ran.reason);
      return Object.freeze({ outcome: 'ran' as const, result: ran.value });
    },
    async reconcile(): Promise<readonly BootstrapAuthorityReconciliationEntry[]> {
      if (closed) throw new TypeError('The protected FV Host is closed.');
      // Only the executor reconciles; the inventory's snapshots admit only histories this process still holds.
      if (!authority()) throw new TypeError('The protected FV Host no longer holds exclusive execution; nothing is reconciled.');
      return boundary.reconcile();
    },
    close(): void {
      if (closed) return;
      closed = true;
      boundary.dispose();
      revokeBootstrapSettlementCapability(settlementCapability);
      inventory.close();
      identityStore.close();
      records.close();
    },
  });
  return host;
}
