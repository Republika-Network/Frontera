import { randomUUID } from 'node:crypto';

import type { KernelClock, KernelIdGenerator, RecognitionProvider } from '../../kernel/index.js';
import type { KernelProviderSet } from '../providers/kernel-provider-composition.js';
import type { KernelAuthorityAccessContext, KernelAuthorityRecord } from './contracts.js';
import { hydrateKernelAuthorityWorld } from './hydration.js';
import type { KernelAuthorityStore } from './kernel-authority-store.js';
import { createDurableRecognitionProvider } from './recognition-bridge.js';

export interface CreateDurableKernelProvidersOptions {
  /** The durable authority source. Memory or SQLite -- the composition is identical; only the survival guarantee differs. */
  readonly store: KernelAuthorityStore;
  /** The organization whose authority world this decision service decides for. One service serves exactly one organization. */
  readonly organizationId: string;
  readonly clock?: KernelClock;
  readonly idGenerator?: KernelIdGenerator;
}

/**
 * The decision surface an application receives: everything needed to *ask*
 * `AocKernel` a question, and nothing that could answer one by changing the
 * world.
 *
 * It deliberately does **not** carry the Recognition/Authority/Approval/
 * Handshake runtime handles that `KernelProviderSet` exposes. Those are
 * concrete, mutable engines whose public methods include `registerActor`,
 * `issuePassport`, `issueCapabilityToken`, `registerRootIssuer` and
 * `issueAuthorityGrant`. Handing them to a consumer alongside a
 * `recognitionProvider` would mean an application could mint itself an actor
 * and a covering token in the live world, name them in its request metadata,
 * and be allowed -- without ever holding an operator context, and without the
 * durable store recording anything. The separation this layer exists to
 * establish would hold only by convention.
 *
 * So the handles stay private to the composition that builds the world. What
 * crosses this boundary is a provider that answers, a clock, an id generator,
 * the store (whose own writes independently demand an operator context), and
 * the ability to re-read.
 */
export interface DurableKernelDecisionService {
  /** Read-only. Answers recognition questions; cannot register, issue, grant or revoke anything. */
  readonly recognitionProvider: RecognitionProvider;
  readonly clock: KernelClock;
  readonly idGenerator: KernelIdGenerator;
  /** The durable authority source. Reads are organization-scoped; every write independently requires a privileged operator context. */
  readonly authorityStore: KernelAuthorityStore;
  readonly organizationId: string;
  /** The records this world was last hydrated from -- the exact provenance of every decision it can produce. */
  readonly records: () => readonly KernelAuthorityRecord[];
  /**
   * Rebuilds the world from the store.
   *
   * The provisioning service calls this after every committed write, so a
   * single-process deployment never observes a stale world. A deployment where
   * a *different* process provisions must call it (or restart) to observe that
   * process's writes -- documented rather than papered over, because a world
   * that silently lagged its store is exactly what this layer must not claim
   * to be. See `docs/enterprise/AOC_DURABLE_KERNEL_AUTHORITY.md`,
   * "Propagation across processes".
   */
  reload(): Promise<void>;
}

/** @deprecated Name retained for the 1.1.0 call sites; `DurableKernelDecisionService` describes what it actually is. */
export type DurableKernelProviderSet = DurableKernelDecisionService;

/**
 * Internal composition result: the decision service **plus** the mutable world
 * handles, for the one caller that legitimately needs both -- the Enterprise
 * composition root, which must satisfy `KernelProviderSet` and which already
 * holds the operator provisioning surface anyway.
 *
 * Not exported from `enterprise/index.ts`. If this ever becomes reachable from
 * a package export, the guarantee above is gone.
 *
 * CORE-06: the composition root publishes `providerSet` as
 * `AocEnterprise.kernelProviders`, so an in-process holder of the
 * `AocEnterprise` object holds these mutable handles. That object is trusted
 * embedding surface (SEC-TRUST-001) — reachable from no route, SDK method or
 * intent — and its holder could equally supply its own Kernel. The separation
 * above holds against code handed only a `DurableKernelDecisionService`, not
 * against the embedder (`docs/security/CORE-06-GOVERNANCE-CORE-QUALIFICATION.md`
 * §10).
 */
export interface DurableKernelWorld {
  readonly service: DurableKernelDecisionService;
  /** Satisfies the Kernel's own provider contract. Carries mutable engine handles; never hand this to an application. */
  readonly providerSet: KernelProviderSet;
}

function defaultClockAndIds(): { readonly now: () => string; readonly nextId: (prefix: string) => string } {
  return {
    now: () => new Date().toISOString(),
    nextId: (prefix: string) => `${prefix}-${randomUUID()}`,
  };
}

/**
 * Builds the durable world for one organization, returning both the narrow
 * decision service and the full provider set.
 *
 * Fail-closed is preserved end to end. A store holding no records for this
 * organization hydrates an empty world, and an empty world denies every
 * request with `RECOGNITION_ACTOR_UNKNOWN` exactly as
 * `createDefaultKernelProviders()` does. Nothing here auto-creates an actor, a
 * trust domain, an authority grant or a token, and no request can cause one to
 * be created.
 */
export async function createDurableKernelWorld(options: CreateDurableKernelProvidersOptions): Promise<DurableKernelWorld> {
  const fallback = defaultClockAndIds();
  const clock: KernelClock = options.clock ?? { now: fallback.now };
  const idGenerator: KernelIdGenerator = options.idGenerator ?? { nextId: fallback.nextId };
  const { store, organizationId } = options;

  // A read context, never an operator context. This composition is
  // structurally incapable of writing to the authority source: it never holds
  // `system: true`, and `requireKernelAuthorityOperator` refuses every write
  // without it.
  const readContext: KernelAuthorityAccessContext = { system: false, organizationId };

  let world = hydrateKernelAuthorityWorld(await store.listRecords(readContext, { organizationId }), { now: clock.now, nextId: idGenerator.nextId });

  const recognitionProvider = createDurableRecognitionProvider({
    organizationId,
    now: clock.now,
    world: () => ({ recognitionRuntime: world.recognitionRuntime, records: world.records }),
  });

  async function reload(): Promise<void> {
    world = hydrateKernelAuthorityWorld(await store.listRecords(readContext, { organizationId }), { now: clock.now, nextId: idGenerator.nextId });
  }

  const service: DurableKernelDecisionService = {
    recognitionProvider,
    clock,
    idGenerator,
    authorityStore: store,
    organizationId,
    records: () => world.records,
    reload,
  };

  const providerSet: KernelProviderSet = {
    get recognitionRuntime() {
      return world.recognitionRuntime;
    },
    get authorityRuntime() {
      return world.authorityRuntime;
    },
    get approvalRuntime() {
      return world.approvalRuntime;
    },
    get handshakeRuntime() {
      return world.handshakeRuntime;
    },
    recognitionProvider,
    clock,
    idGenerator,
  };

  return { service, providerSet };
}

/**
 * Restores the operator-provisioned Recognition/Authority world for one
 * organization from a durable Kernel Authority Store, and returns the
 * read-only surface an application evaluates against.
 *
 * The sibling of `createDefaultKernelProviders()`, not a replacement for it.
 * That factory keeps its exact behaviour -- a real but empty, fail-closed
 * world -- and remains correct for every deployment that has not adopted
 * durable authority. This one differs in exactly one respect: where the
 * world's contents come from.
 */
export async function createDurableKernelProviders(options: CreateDurableKernelProvidersOptions): Promise<DurableKernelDecisionService> {
  return (await createDurableKernelWorld(options)).service;
}
