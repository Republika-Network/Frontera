/**
 * The closed XRPL protocol grammar every transaction type shares (TRADE-04A).
 *
 * Pure predicates over public ledger identifiers. They know no transaction
 * type, no amount and no business meaning: a hash is 64 uppercase hex digits
 * whether it names a Payment, an offer or a ledger. Extracted unchanged from
 * the PAY-02 codec and result reader, which re-export them under their
 * original names (`docs/architecture/ADR-XRPL-SHARED-TRANSPORT.md` §5).
 */

/** An XRPL transaction hash: 64 uppercase hex digits. */
const TRANSACTION_HASH = /^[0-9A-F]{64}$/;

export function isXrplTransactionHash(value: unknown): value is string {
  return typeof value === 'string' && TRANSACTION_HASH.test(value);
}

/** A ledger hash has the transaction hash's grammar: 64 uppercase hex digits. */
export function isXrplLedgerHash(value: unknown): value is string {
  return typeof value === 'string' && TRANSACTION_HASH.test(value);
}

/** The largest ledger sequence the protocol can express (UInt32). */
export const XRPL_LEDGER_INDEX_MAXIMUM = 4_294_967_295;

/** A ledger index as the protocol defines it: an integer from 1 to UInt32 maximum. Strict: used by the validated-read contracts. */
export function isXrplLedgerIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= XRPL_LEDGER_INDEX_MAXIMUM;
}

/** An XRPL signing public key: 33 bytes as uppercase hex — `ED` + 32 bytes (Ed25519) or `02`/`03` + 32 bytes (secp256k1). */
const SIGNING_PUBLIC_KEY = /^(?:ED|0[23])[0-9A-F]{64}$/;

export function isXrplSigningPublicKey(value: unknown): value is string {
  return typeof value === 'string' && SIGNING_PUBLIC_KEY.test(value);
}

/** An engine result code of a class rippled defines. */
const ENGINE_RESULT = /^(?:tes|tec|tef|tel|tem|ter)[A-Z_]{1,48}$/;

export function isXrplEngineResult(value: unknown): value is string {
  return typeof value === 'string' && ENGINE_RESULT.test(value);
}
