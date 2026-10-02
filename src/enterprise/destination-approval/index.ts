/**
 * The durable destination approval store and its administrative service
 * (ANDREW-P0-03): which registered destinations each organization has
 * approved, by whom, under what authority, and whether that approval is still
 * active.
 *
 * See `docs/demo/andrew/ANDREW-P0-03-DESTINATION-APPROVAL.md`. The port, the
 * records and the state derivation live in
 * `src/features/destination-runtime/approval`. Not re-exported from
 * `src/enterprise/index.ts`, and not composed into the Host or any route yet.
 */
export { DESTINATION_APPROVAL_SCHEMA_VERSION, createSqliteDestinationApprovalStore } from './sqlite-destination-approval-store.js';
export type { CreateSqliteDestinationApprovalStoreOptions, DurableDestinationApprovalStore } from './sqlite-destination-approval-store.js';
export { createDestinationApprovalAdministration } from './administration.js';
export type { CreateDestinationApprovalAdministrationOptions, DestinationApprovalAdministration } from './administration.js';
