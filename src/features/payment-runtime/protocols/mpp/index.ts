/**
 * PAY-04 — the MPP payment protocol adapter, below the protocol-neutral
 * `PaymentProtocolAdapter` contract (`../../domain/payment-protocol.ts`). The
 * contract never imports it; it imports only the contract and P9. See
 * `README.md` and `docs/payments/PAY-04-PAYMENT-PROTOCOL-ADAPTER.md`.
 */
export {
  MPP_CHARGE_INTENT,
  MPP_PROTOCOL_ID,
  MPP_RESERVED_CONTEXT_KEYS,
  createMppPaymentProtocolAdapter,
} from './mpp-payment-adapter.js';
export type {
  MppChallengeCandidate,
  MppChallengeSelectionContext,
  MppChallengeSelector,
  MppChargeNormalization,
  MppCounterpartyResolutionContext,
  MppCounterpartyResolver,
  MppMethodNormalizer,
  MppPaymentProtocolAdapterOptions,
} from './mpp-payment-adapter.js';
export {
  MPP_CHALLENGE_KNOWN_PARAMS,
  MPP_PAYMENT_AUTHORIZATION_HEADER,
  isMppChallengeUsableAt,
  mppChallengeFieldsOf,
  mppChallengeKeyOf,
  mppCredentialHeaderField,
  parseMppPaymentChallenge,
} from './mpp-challenge.js';
export type { MppChallengeFields, MppChallengeParse, MppPaymentChallenge } from './mpp-challenge.js';
export { MPP_CHALLENGE_LIMITS, decodeBase64UrlNoPad, decodeCanonicalJsonObject, decodeUtf8Fatal, parseWwwAuthenticate, rfc3339EpochMilliseconds } from './mpp-grammar.js';
export type { AuthenticateParse, CanonicalJsonDecode, MppJsonValue, RawAuthChallenge } from './mpp-grammar.js';
