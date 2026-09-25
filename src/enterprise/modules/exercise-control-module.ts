import type { ExerciseControlLedgerPort } from '../../features/exercise-control-runtime/index.js';
import { AOC_ENTERPRISE_HOST_VERSION } from '../version.js';
import { AUTHORITY_CONTROLLED_EXECUTION_MODULE_ID } from './authority-controlled-execution-module.js';
import type { EnterpriseModule } from './enterprise-module.js';

export const EXERCISE_CONTROL_MODULE_ID = 'aoc.enterprise.exercise-control';

/**
 * Reports that this deployment composed P7 exercise controls, and whether the
 * exercise-control ledger can currently be read and written.
 *
 * Registered **only** when a host supplied
 * `authorityControlledExecution.exerciseControls`.
 *
 * `criticality: 'optional'`, for the reason the Authority-Controlled Execution
 * module states: the frozen v1 evaluation surface never passes through this
 * composition. An unhealthy ledger is not an outage of authorization — every
 * exercise it cannot serve withholds with `EXERCISE_CONTROL_LEDGER_UNAVAILABLE`,
 * which is the closed direction — so it is reported here for an operator
 * rather than allowed to take the Host out of `ready`.
 *
 * It owns nothing: the composition root closes a ledger it opened, and a host
 * closes one it supplied.
 *
 * A Host whose purpose **is** governed execution (the Enterprise Host bootstrap,
 * `host/enterprise-host.ts`) composes it as `required` instead: there, an
 * unhealthy exercise-control ledger means the Host cannot do the one thing it runs for, and
 * `/health` and `/ready` must say so.
 */
export function createExerciseControlModule(ledger: ExerciseControlLedgerPort, now: () => string, criticality: 'required' | 'optional' = 'optional'): EnterpriseModule {
  const probe = (ledger as Partial<{ health: () => Promise<{ readonly status: string; readonly readable: boolean; readonly writable: boolean; readonly schemaVersion: string }> }>).health;
  return {
    descriptor: {
      id: EXERCISE_CONTROL_MODULE_ID,
      version: AOC_ENTERPRISE_HOST_VERSION,
      displayName: 'Exercise Controls',
      description: 'Aggregate / velocity exercise limits, a durable reservation ledger and exercise-time authority-binding revalidation on the bounded-grant path. No route.',
      criticality,
      dependencies: [{ moduleId: AUTHORITY_CONTROLLED_EXECUTION_MODULE_ID }],
      capabilities: ['exercise.aggregate-limits', 'exercise.reservation', 'exercise.authority-binding-revalidation'],
    },
    async initialize() {},
    async health() {
      if (typeof probe !== 'function') return { status: 'healthy', checkedAt: now(), details: { ledger: 'host-supplied' } };
      try {
        const report = await probe.call(ledger);
        return {
          status: report.status === 'healthy' ? 'healthy' : 'unhealthy',
          checkedAt: now(),
          details: { readable: report.readable, writable: report.writable, schemaVersion: report.schemaVersion },
        };
      } catch {
        return { status: 'unhealthy', checkedAt: now(), details: { readable: false, writable: false } };
      }
    },
    async shutdown() {
      // Owns nothing; see above.
    },
  };
}
