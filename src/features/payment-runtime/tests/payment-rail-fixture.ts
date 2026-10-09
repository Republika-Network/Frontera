import type { PaymentExecutionRequest, PaymentRail, PaymentRailResult } from '../index.js';

/**
 * The reference payment rail — deterministic, in-memory, and only ever a
 * test double.
 *
 * It lives under `tests/` rather than in the module's production sources for
 * the reason the execution runtime's recording adapter does: a rail that
 * reports `completed` without moving anything, shipped as production code,
 * would be a payment path nobody chose. It performs **no** external effect:
 * it records the exact normalized request it was handed and answers with the
 * outcome the test scripted. It is used only to qualify the PAY-01 contract —
 * that nothing reaches a rail without a grant, and that exactly the granted,
 * normalized payment does — and it is not, and must never be composed as, a
 * real payment rail.
 */
export interface RecordingPaymentRail extends PaymentRail {
  readonly requests: readonly PaymentExecutionRequest[];
  readonly callCount: number;
}

export const REFERENCE_RAIL_ID = 'reference-rail';

export function createRecordingPaymentRail(
  behaviour: (request: PaymentExecutionRequest) => PaymentRailResult | Promise<PaymentRailResult> = (request) => ({ status: 'completed', externalReference: `ref-${request.executionId.slice(-12)}` }),
  railId: string = REFERENCE_RAIL_ID,
): RecordingPaymentRail {
  const requests: PaymentExecutionRequest[] = [];
  return {
    railId,
    requests,
    get callCount(): number {
      return requests.length;
    },
    async execute(request: PaymentExecutionRequest): Promise<PaymentRailResult> {
      requests.push(request);
      return behaviour(request);
    },
  };
}
