import type { ContextFactObservation } from '../domain/context-fact.js';
import type { ContextResolutionQuery, ContextResolverOutput, ContextResolverPort } from '../domain/context-resolver-port.js';

/**
 * A resolver backed by a fixed table of observations.
 *
 * The reference implementation of the port and the one every test in this phase
 * uses. It is emphatically **not** an ERP, CRM or any other integration: the
 * architecture is proved against an in-memory table precisely so that what is
 * demonstrated is the trust boundary rather than a connector.
 *
 * It answers only keys the query declared, so it also serves as the executable
 * statement of the declared-keys-only rule: a table holding a hundred facts
 * about a vendor returns the one the deployment asked for.
 */
export function createInMemoryContextResolver(
  observations: readonly ContextFactObservation[] | ((query: ContextResolutionQuery) => readonly ContextFactObservation[]),
): ContextResolverPort {
  return {
    resolveContext(query: ContextResolutionQuery): Promise<ContextResolverOutput> {
      const table = typeof observations === 'function' ? observations(query) : observations;
      const keys = new Set(query.keys);
      return Promise.resolve({ observations: table.filter((observation) => keys.has(observation.key)) });
    },
  };
}

/** A resolver that always fails, for proving that an unreadable source produces `resolved: false` rather than an empty fact set. */
export function createFailingContextResolver(message = 'context source unavailable'): ContextResolverPort {
  return {
    resolveContext(): Promise<ContextResolverOutput> {
      return Promise.reject(new Error(message));
    },
  };
}
