import type {
  ObligationDischargeProviderOutput,
  ObligationDischargeProviderPort,
  ObligationDischargeQuery,
} from '../domain/obligation-discharge-port.js';
import type { ObligationDischargeObservation } from '../domain/obligation-discharge.js';

/**
 * A discharge provider backed by a fixed table of observations.
 *
 * The reference implementation of the port and the one every test in this phase
 * uses. It is emphatically **not** an approval system, an ERP, an identity
 * provider or any other integration: the architecture is proved against an
 * in-memory table precisely so that what is demonstrated is the trust boundary
 * rather than a connector, and so that no test reaches a network.
 *
 * It answers only obligations the query declared, so it also serves as the
 * executable statement of the declared-obligations-only rule.
 */
export function createInMemoryObligationDischargeProvider(
  observations: readonly ObligationDischargeObservation[] | ((query: ObligationDischargeQuery) => readonly ObligationDischargeObservation[]),
): ObligationDischargeProviderPort {
  return {
    resolveObligationDischarges(query: ObligationDischargeQuery): Promise<ObligationDischargeProviderOutput> {
      const table = typeof observations === 'function' ? observations(query) : observations;
      const declared = new Set(query.obligationTypes);
      return Promise.resolve({ observations: table.filter((observation) => declared.has(observation.obligationType)) });
    },
  };
}

/** A provider that always fails, for proving that an unreadable approval system withholds exercise rather than producing an empty — and therefore satisfied — obligation set. */
export function createFailingObligationDischargeProvider(message = 'obligation discharge source unavailable'): ObligationDischargeProviderPort {
  return {
    resolveObligationDischarges(): Promise<ObligationDischargeProviderOutput> {
      return Promise.reject(new Error(message));
    },
  };
}
