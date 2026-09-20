/**
 * The durable emergency-control store's error taxonomy.
 *
 * ## Why these are thrown from the *writer* and never from the reader
 *
 * `EmergencyControlReaderPort.read` is synchronous, is called inside the
 * bounded-grant store's commit guard, and must be total: a reader that threw
 * there would turn an operational condition into an exception in the middle of
 * a transaction. So the read never throws — it reports `unavailable`, which
 * withholds, which is the closed direction.
 *
 * The operator mutations are different. An operator setting a control is
 * entitled to a loud failure rather than a silent one: a `release` that
 * appeared to work but did not would leave a deployment stopped while its
 * operator believed it running, and an `activate` that appeared to work but did
 * not would leave it running while its operator believed it stopped. The second
 * is the dangerous one, and neither is acceptable quietly.
 *
 * ## What the messages may say
 *
 * The scope, the condition, and nothing else. No SQL, no file path, no driver
 * text, no row contents, and never an issuer reference: an error message is not
 * a place to publish who can stop a deployment.
 */
export type EmergencyControlStoreErrorCode =
  /** The store cannot be opened, has been closed, or is recorded under a schema version this runtime does not implement. Never a reason to fall back to another source of controls. */
  | 'EMERGENCY_CONTROL_STORE_UNAVAILABLE'
  /** Persisted control state failed validation. The store refuses to answer from state it cannot validate, and never repairs it. */
  | 'EMERGENCY_CONTROL_STORE_STATE_CORRUPT'
  /** An operator supplied a declaration or release that does not state what its own scope requires. Refused at write time rather than stored and mis-read later. */
  | 'EMERGENCY_CONTROL_DECLARATION_INVALID';

export class EmergencyControlStoreError extends Error {
  constructor(
    readonly code: EmergencyControlStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'EmergencyControlStoreError';
  }
}

export function isEmergencyControlStoreError(error: unknown): error is EmergencyControlStoreError {
  return error instanceof EmergencyControlStoreError;
}
