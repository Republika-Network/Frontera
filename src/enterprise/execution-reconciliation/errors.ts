/**
 * A P12 composition defect: the host stated `executionReconciliation` in a way
 * that cannot be composed safely — no authorities, a duplicate or unrecordable
 * `authorityId`, a missing selector, or reconciliation without governed
 * actions. Thrown by `createEnterprise()` before any store is opened. Never a
 * runtime outcome: every runtime condition of reconciliation is a result.
 */
export class ExecutionReconciliationConfigurationError extends Error {
  readonly code = 'EXECUTION_RECONCILIATION_CONFIGURATION_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'ExecutionReconciliationConfigurationError';
  }
}
