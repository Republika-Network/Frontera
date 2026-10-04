import {
  checkXrplSettlement,
  type XrplPaymentSubmission,
  type XrplPaymentTransport,
  type XrplSettlementProfile,
  type XrplSettlementRefusal,
  type XrplSubmissionObservation,
} from '../execution-adapters/xrpl/index.js';

/**
 * ANDREW-P0-07 — the demo's stand-in for a real XRPL transport. It records
 * every submission it is handed and **sends nothing**: no network, no
 * account, no key, no signature, no hash.
 *
 * It does what P0-08's real transport must do first — `checkXrplSettlement`
 * against the deployment's settlement profile — and then, because nothing
 * reached any ledger, it answers `not-submitted`. It never reports
 * `validated` and never invents a transaction hash, so no execution record
 * produced through it can be mistaken for a settled payment.
 *
 * `accepted` holds the submissions that passed the settlement check (what a
 * real transport would have signed); `refused` holds the ones that failed it,
 * with the reason.
 */
export interface RecordingXrplTransport extends XrplPaymentTransport {
  readonly accepted: readonly XrplPaymentSubmission[];
  readonly refused: readonly { readonly submission: XrplPaymentSubmission; readonly refusal: XrplSettlementRefusal }[];
}

export function createRecordingXrplTransport(profile: XrplSettlementProfile): RecordingXrplTransport {
  const accepted: XrplPaymentSubmission[] = [];
  const refused: { readonly submission: XrplPaymentSubmission; readonly refusal: XrplSettlementRefusal }[] = [];
  return Object.freeze({
    accepted,
    refused,
    async submitPayment(submission: XrplPaymentSubmission): Promise<XrplSubmissionObservation> {
      const check = checkXrplSettlement(profile, submission);
      if (check.ok) accepted.push(submission);
      else refused.push({ submission, refusal: check.refusal });
      return { kind: 'not-submitted' };
    },
  });
}
