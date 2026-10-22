/**
 * G-02C0 — the governed execution binding and safety gate: the one caller of
 * the G-02B execution-capability issuer, composed into a Generic HTTP adapter
 * as its pre-send gate.
 *
 * Internal. Imported by the composition root alone; not exported from the
 * enterprise entry point, mounted on a route or offered as an option. It
 * presents nothing to an executor.
 */
export { ExecutionCapabilityGateConfigurationError, createExecutionCapabilityGate } from './gate.js';
export type { ExecutionCapabilityGate, ExecutionCapabilityGateOptions, ExecutionCapabilityGateRuntime } from './gate.js';
