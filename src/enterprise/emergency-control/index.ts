/**
 * The durable emergency-control store — the operational safety interlock's
 * persistent home.
 *
 * See `docs/enterprise/AOC_EMERGENCY_CONTROL.md`. The three things to know from
 * here: everything below sits behind `EmergencyControlReaderPort`, so execution
 * components never learn that a database exists; the mutations are the
 * **operator's**, on the host side of the trust boundary, with no customer
 * route and no SDK method; and the digests it verifies are storage integrity,
 * never cryptographic authenticity.
 */
export { EmergencyControlStoreError, isEmergencyControlStoreError } from './errors.js';
export type { EmergencyControlStoreErrorCode } from './errors.js';

export {
  EMERGENCY_CONTROL_RECORD_FORMAT,
  EMERGENCY_CONTROL_STORE_SCHEMA_VERSION,
  serializeStoredEmergencyControl,
  storedEmergencyControlDigest,
} from './emergency-control-record.js';
export type { StoredEmergencyControl } from './emergency-control-record.js';

export { createSqliteEmergencyControlStore } from './sqlite-emergency-control-store.js';
export type {
  CreateSqliteEmergencyControlStoreOptions,
  DurableEmergencyControlStore,
  EmergencyControlStoreHealth,
} from './sqlite-emergency-control-store.js';
