/**
 * The durable authoritative bounded-grant store.
 *
 * See `docs/security/AUTHORITATIVE_GRANT_STORE.md`. The two things to know from
 * here: everything below sits behind `BoundedGrantStorePort`, so the exercise
 * path never learns that a database exists; and the digests it verifies are
 * storage integrity, never cryptographic authenticity — that is the detached
 * signature verified beside them (`../authority-authenticity/`).
 */
export { BoundedGrantStoreError, isBoundedGrantStoreError } from './errors.js';
export type { BoundedGrantStoreErrorCode } from './errors.js';

export {
  BOUNDED_GRANT_RECORD_FORMAT,
  serializeStoredGrantRecord,
  serializeStoredRevocationRecord,
  storedGrantRecordDigest,
  storedRevocationRecordDigest,
} from './bounded-grant-record.js';

export { createSqliteBoundedGrantStore } from './sqlite-bounded-grant-store.js';
export type {
  BoundedGrantStoreHealth,
  CreateSqliteBoundedGrantStoreOptions,
  DurableBoundedGrantStore,
} from './sqlite-bounded-grant-store.js';
