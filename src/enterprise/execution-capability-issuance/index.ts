/**
 * G-02B — in-custody issuance of `frontera.execution-capability.v1`: the
 * Host-side issuer and its write-once slot, and the durable issuance ledger.
 * The custody rule itself lives with the authority signer
 * (`authority-authenticity/execution-capability-issuance.ts`).
 *
 * Internal. Nothing here is exported from the enterprise entry point, mounted
 * on a route or connected to an execution adapter: the issuer returns a
 * capability to its in-process caller, and that caller is G-02C's.
 */
export {
  EXECUTION_CAPABILITY_ISSUER_FAILURES,
  ExecutionCapabilityIssuanceError,
  createExecutionCapabilityIssuer,
  createExecutionCapabilityIssuerSlot,
} from './issuer.js';
export type {
  ExecutionCapabilityCustodyExposure,
  ExecutionCapabilityIssuanceInput,
  ExecutionCapabilityIssuer,
  ExecutionCapabilityIssuerFailure,
  ExecutionCapabilityIssuerOptions,
  ExecutionCapabilityIssuerSlot,
  ExecutionCapabilitySignedGrantReader,
  IssuedExecutionCapability,
} from './issuer.js';

export { EXECUTION_CAPABILITY_ISSUANCE_LEDGER_SCHEMA_VERSION, EXECUTION_CAPABILITY_ISSUANCE_STATES, openExecutionCapabilityIssuanceLedger } from './issuance-ledger.js';
export type {
  ExecutionCapabilityIssuanceLedger,
  ExecutionCapabilityIssuanceLedgerOptions,
  ExecutionCapabilityIssuanceRecord,
  ExecutionCapabilityIssuanceState,
  ExecutionCapabilityReservation,
  ExecutionCapabilityReserveOutcome,
} from './issuance-ledger.js';
