export type ObligationDischargeErrorCode =
  /** The writer context is not a trusted system context with an actor. */
  | 'OBLIGATION_DISCHARGE_WRITER_UNTRUSTED'
  /** The report is malformed, names an unconfigured source, or claims a future observation. */
  | 'OBLIGATION_DISCHARGE_INVALID'
  /** A stored row failed verification; nothing read from the store is believed. */
  | 'OBLIGATION_DISCHARGE_STORE_CORRUPT'
  /** The store file is not one this build understands. */
  | 'OBLIGATION_DISCHARGE_STORE_UNSUPPORTED'
  /** The store was used after it was closed. */
  | 'OBLIGATION_DISCHARGE_STORE_CLOSED';

export class ObligationDischargeError extends Error {
  readonly code: ObligationDischargeErrorCode;

  constructor(code: ObligationDischargeErrorCode, message: string) {
    super(message);
    this.name = 'ObligationDischargeError';
    this.code = code;
  }
}
