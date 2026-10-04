import type { ValidatedExecutionAction } from '../../features/execution-runtime/index.js';
import type { XrplExecutionAdapterOptions, XrplPaymentSubmission, XrplPaymentTransport, XrplSubmissionObservation } from '../execution-adapters/xrpl/index.js';

/**
 * ANDREW-P0-06 test fixtures. Synthetic, deterministic and offline.
 *
 * The addresses are XRPL classic addresses whose 20-byte account ids are the
 * first 20 bytes of SHA-256 over a public label, encoded with
 * `ripple-address-codec@5.0.1` (`encodeAccountID`). They are well-formed and
 * checksum-valid, and nobody holds a key for them: no seed, no wallet, no
 * funded account.
 *
 * | constant | label |
 * |---|---|
 * | `XRPL_DESTINATION` | `frontera:andrew-p0-06:destination` |
 * | `XRPL_ISSUER` | `frontera:andrew-p0-06:issuer` |
 * | `XRPL_OTHER_DESTINATION` | `frontera:andrew-p0-06:other-destination` |
 * | `XRPL_OTHER_ISSUER` | `frontera:andrew-p0-06:other-issuer` |
 */
export const XRPL_DESTINATION = 'r92Zr53w6hG5eqX7Zs9Gz2Rq7g7W3FY8zZ';
export const XRPL_ISSUER = 'rhdd5zpcK7jT48xt4GW44cAYXXfPYr4azT';
export const XRPL_OTHER_DESTINATION = 'rwCMDuwZ8PAkS9iRguQVtp44BCerTPaNNb';
export const XRPL_OTHER_ISSUER = 'rwY592bHmvugm1sBaTEiaAuPhz5tb749Jf';
/** `XRPL_DESTINATION` with its last character changed: right alphabet, right length, wrong checksum. */
export const XRPL_CORRUPT_DESTINATION = 'r92Zr53w6hG5eqX7Zs9Gz2Rq7g7W3FY8zz';

/** Known-good public vectors: the genesis account, ACCOUNT_ZERO and ACCOUNT_ONE. */
export const XRPL_GENESIS_ACCOUNT = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';
export const XRPL_ACCOUNT_ZERO = 'rrrrrrrrrrrrrrrrrrrrrhoLvTp';
export const XRPL_ACCOUNT_ONE = 'rrrrrrrrrrrrrrrrrrrrBZbvji';

/**
 * A **fake** transaction hash: fixture output of the fake transport only. It
 * was produced by no ledger and proves no submission.
 */
export const FIXTURE_TRANSACTION_HASH = 'F1C7F1C7F1C7F1C7F1C7F1C7F1C7F1C7F1C7F1C7F1C7F1C7F1C7F1C7F1C7F1C7';

export const XRPL_ADAPTER_ID = 'xrpl.treasury';

/** The canonical Andrew mapping: Frontera `USD` is XRPL issued `USD` from the configured issuer. Nothing else. */
export const USD_ISSUED_OPTIONS: XrplExecutionAdapterOptions = {
  adapterId: XRPL_ADAPTER_ID,
  assets: [{ assetId: 'USD', representation: { kind: 'issued', currency: 'USD', issuer: XRPL_ISSUER } }],
};

export interface SpyXrplTransport extends XrplPaymentTransport {
  readonly submissions: readonly XrplPaymentSubmission[];
}

/** Records every submission and answers with `respond`. Defaults to a validated payment carrying the fake hash. */
export function createSpyXrplTransport(
  respond: (submission: XrplPaymentSubmission) => XrplSubmissionObservation | Promise<XrplSubmissionObservation> = () => ({ kind: 'validated', transactionHash: FIXTURE_TRANSACTION_HASH }),
): SpyXrplTransport {
  const submissions: XrplPaymentSubmission[] = [];
  return {
    submissions,
    async submitPayment(submission) {
      submissions.push(submission);
      return respond(submission);
    },
  };
}

export function xrplKey(identifier: string, namespace = 'xrpl'): string {
  return `${namespace}:${identifier}`;
}

/** A validated action as the exercise gate builds one: the canonical USD 75,000 to `XRPL_DESTINATION`. */
export function validatedAction(overrides: Partial<ValidatedExecutionAction> = {}): ValidatedExecutionAction {
  return {
    boundedGrantId: 'grant-p006-1',
    subject: 'agent-andrew',
    action: 'transfer-funds',
    resource: 'treasury-operating-account',
    counterparty: xrplKey(XRPL_DESTINATION),
    organization: 'org-acme',
    amount: { value: '75000', unit: 'USD' },
    notAfter: '2026-01-01T13:00:00.000Z',
    correlation: { requestId: 'req-p006-1', decisionId: 'decision-p006-1', executionId: 'exec-p006-1' },
    ...overrides,
  };
}
