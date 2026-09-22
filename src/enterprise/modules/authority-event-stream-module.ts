import type { AuthorityEventProjectionHealth } from '../authority-event-stream/projector.js';
import type { AuthorityEventStreamStore } from '../authority-event-stream/stream-store.js';
import { AOC_ENTERPRISE_HOST_VERSION } from '../version.js';
import type { EnterpriseModule, EnterpriseModuleHealth } from './enterprise-module.js';
import { GOVERNED_ACTION_ORCHESTRATOR_MODULE_ID } from './governed-action-orchestrator-module.js';

export const AUTHORITY_EVENT_STREAM_MODULE_ID = 'aoc.enterprise.authority-event-stream';

/**
 * Reports the health of the canonical authority event stream (P8): whether its
 * store can be read and written, and whether any projection has failed.
 *
 * Registered only when the Governed Action Orchestrator is composed — the one
 * lifecycle Stage A projects. This is the existing internal health surface the
 * stream's failures are made visible through; there is no route, response field
 * or SDK method for it.
 *
 * ## It can never gate anything
 *
 * `criticality: 'optional'`, and `initialize()` never throws, so the stream can
 * neither prevent the Host from starting nor take it out of `ready`. A projection
 * failure is reported here as `degraded`, an unopenable or unhealthy store as
 * `unhealthy` — and that report is read by operators, never by `evaluate()`,
 * `govern()`, issuance, exercise or routing. Evidence that could not be written
 * is an evidence problem, not a reason to allow or refuse an action.
 *
 * It owns nothing: the composition root closes a store it opened, and a host
 * closes one it supplied.
 */
export function createAuthorityEventStreamModule(input: {
  readonly store: AuthorityEventStreamStore | undefined;
  /** Why the configured store could not be opened, when it could not. Reported by name only — never a path. */
  readonly openFailure?: Error;
  readonly projection: () => AuthorityEventProjectionHealth;
  readonly now: () => string;
}): EnterpriseModule {
  const { store, openFailure, projection, now } = input;
  return {
    descriptor: {
      id: AUTHORITY_EVENT_STREAM_MODULE_ID,
      version: AOC_ENTERPRISE_HOST_VERSION,
      displayName: 'Canonical Authority Event Stream',
      description: 'Append-only, hash-chained, tenant-confined evidence of the governed-action / bounded-grant lifecycle. Evidence only: never read to decide. No route.',
      criticality: 'optional',
      dependencies: [{ moduleId: GOVERNED_ACTION_ORCHESTRATOR_MODULE_ID }],
      capabilities: ['evidence.authority-event-stream'],
    },
    async initialize() {
      // Deliberately never throws: evidence must not be a prerequisite for the Host.
    },
    async health(): Promise<EnterpriseModuleHealth> {
      const projected = projection();
      const counters = { appended: projected.appended, existing: projected.existing, failed: projected.failed, outOfScope: projected.outOfScope };
      if (store === undefined) {
        return {
          status: 'unhealthy',
          checkedAt: now(),
          message: 'The configured authority event stream store is unavailable; lifecycle facts are not being recorded as canonical events. Authorization and execution are unaffected.',
          details: { readable: false, writable: false, reason: openFailure?.name ?? 'unavailable', ...counters },
        };
      }
      let report: Awaited<ReturnType<AuthorityEventStreamStore['health']>> | undefined;
      try {
        report = await store.health();
      } catch {
        report = undefined;
      }
      if (report === undefined || report.status !== 'healthy') {
        return { status: 'unhealthy', checkedAt: now(), details: { provider: store.providerKind, readable: report?.readable ?? false, writable: report?.writable ?? false, ...counters } };
      }
      return {
        status: projected.status === 'healthy' ? 'healthy' : 'degraded',
        checkedAt: now(),
        ...(projected.status === 'healthy' ? {} : { message: 'At least one canonical event could not be projected. Authorization and execution are unaffected.' }),
        details: {
          provider: store.providerKind,
          schemaVersion: report.schemaVersion,
          ...counters,
          ...(projected.lastFailureCode !== undefined ? { lastFailureCode: projected.lastFailureCode } : {}),
        },
      };
    },
    async shutdown() {
      // Owns nothing; see above.
    },
  };
}
