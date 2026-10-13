import { copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import type { PaymentRail } from '../../features/payment-runtime/index.js';
import type { MppMethodNormalizer } from '../../features/payment-runtime/protocols/mpp/index.js';
import { createStripeRail, readOnlyStripe, stripeDestinationOf, type StripeRail } from '../../features/payment-runtime/rails/stripe/index.js';
import { CONNECTED_ACCOUNT, TEST_CUSTOMER, TEST_PAYMENT_METHOD, USD_ASSET, createSimulatedStripe, testRailConfiguration } from '../../features/payment-runtime/rails/stripe/tests/stripe-test-fixtures.js';
import { createStripeFinalityAuthority } from '../stripe-payment-rail/stripe-finality-authority.js';
import { createStripeResolutionAuthority } from '../stripe-payment-rail/stripe-resolution-authority.js';
import { createSqliteStripePaymentInterlock, type DurableStripePaymentInterlock } from '../stripe-payment-rail/sqlite-stripe-payment-interlock.js';
import { boundaryFor } from './core07-freshness-fixture.js';
import { BUSINESS_REFERENCE, GOVERNED_ACCOUNT, type OpenedPaymentRailEdge, type PaymentRailEdge } from './pay07-governed-payment-world.js';

/**
 * PAY-09 — the Stripe / USD rail edge for the PAY-07 canonical suite, composed
 * as PAY-09 composes it: the real rail (exact cents, a trusted connected
 * account, reserve → create (cannot charge) → bind → one confirmation,
 * processor certainty mapped onto P11), the durable payment interlock anchored
 * at the world's CORE-07 witness, the read-only P12 resolution authority and
 * the read-only processor-finality authority, both bound to the platform
 * account recorded before the confirmation. Stripe is PAY-09's deterministic
 * simulator below the external port (every confirmation counted).
 *
 * Everything Stripe-specific stops here. The shared world receives a
 * `PaymentRail`, two read-only authorities and generic capabilities — it never
 * learns that one proof is a processor status and the others a ledger hash and
 * a preimage. The suite is run unchanged: no case was weakened or skipped.
 */

const CONFIGURATION = testRailConfiguration({ fundingSources: [{ accountId: GOVERNED_ACCOUNT, customerId: TEST_CUSTOMER, paymentMethodId: TEST_PAYMENT_METHOD }], connectedAccounts: [CONNECTED_ACCOUNT] });
const SCOPE = { railId: CONFIGURATION.railId, mode: CONFIGURATION.mode, platformAccountId: CONFIGURATION.platformAccountId } as const;

/** Trusted host composition: the merchant's `cardpay` MPP method quotes USD as decimal text; the host maps it and prefers the Stripe rail. */
const CARDPAY: MppMethodNormalizer = {
  methodId: 'cardpay',
  intent: 'charge',
  rail: CONFIGURATION.railId,
  normalize(challenge) {
    const amount = challenge.decodedRequest['amount'];
    const recipient = challenge.decodedRequest['recipient'];
    if (typeof amount !== 'string' || challenge.decodedRequest['currency'] !== 'usd') return undefined;
    return { amount: { value: amount, unit: USD_ASSET }, ...(typeof recipient === 'string' ? { merchantReference: recipient } : {}), reference: BUSINESS_REFERENCE };
  },
};

const freshnessCode = (error: unknown): string => (typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'UNCODED');

export const STRIPE_EDGE: PaymentRailEdge = Object.freeze<PaymentRailEdge>({
  implementationId: CONFIGURATION.railId,
  railId: CONFIGURATION.railId,
  asset: { assetId: USD_ASSET, scale: 2 },
  // The same logical bound as every rail: a ceiling of 1000 USD; 2.5 % of it is within, 1.00001 × of it is over — in USD's own exact unit. No FX.
  economics: { ceiling: { value: '1000', unit: USD_ASSET }, withinCeiling: { value: '25', unit: USD_ASSET }, overCeiling: { value: '1000.01', unit: USD_ASSET } },
  lifetime: '100000',
  mppMethod: CARDPAY,
  mppRequest: (amount, merchantReference) => ({ amount: amount.value, currency: 'usd', recipient: merchantReference }),

  async open({ directory, witness, organizationId }): Promise<OpenedPaymentRailEdge> {
    const interlockPath = join(directory, 'stripe-payment-interlock.sqlite');
    const backupPath = join(directory, 'stripe-payment-interlock.before-payment.sqlite');
    const stripe = createSimulatedStripe();
    const openInterlock = async (): Promise<DurableStripePaymentInterlock> =>
      createSqliteStripePaymentInterlock(interlockPath, { scope: SCOPE, now: () => new Date().toISOString(), freshness: { boundary: await boundaryFor(witness, organizationId) } });

    // A backup of the interlock taken before any payment: the stale copy a rollback would restore.
    let interlock = await openInterlock();
    await interlock.close();
    copyFileSync(interlockPath, backupPath);
    interlock = await openInterlock();
    let open = true;

    const railOver = (store: DurableStripePaymentInterlock): StripeRail => createStripeRail({ configuration: CONFIGURATION, stripe, interlock: store });
    let rail = railOver(interlock);
    const delegate: PaymentRail = { railId: CONFIGURATION.railId, execute: (request) => rail.execute(request) };

    /** The one PaymentIntent the uncertain scenario left pending. */
    const pending = (): string => {
      const intent = stripe.intents().find((candidate) => candidate.status === 'processing');
      if (intent === undefined) throw new Error('pay07-stripe: no payment to resolve');
      return intent.id;
    };

    return {
      rail: delegate,
      async preparePayee(_amount, label) {
        // The trusted directory: the merchant reference the challenge names is this deployment's configured connected account.
        return { merchantReference: label, destination: stripeDestinationOf(CONNECTED_ACCOUNT) };
      },
      behave(behaviour) {
        stripe.confirmBehaviour = behaviour === 'complete' ? 'succeed' : behaviour === 'fail' ? 'decline' : 'processing';
      },
      effects: () => stripe.calls.confirmReceived,
      async resolveExternally(outcome) {
        if (outcome === 'completed') stripe.settle(pending());
        else stripe.fail(pending());
      },
      resolutionAuthority: () => createStripeResolutionAuthority({ configuration: CONFIGURATION, stripe: readOnlyStripe(stripe), interlock }),
      finalityAuthority: () => createStripeFinalityAuthority({ configuration: CONFIGURATION, stripe: readOnlyStripe(stripe), interlock }),
      async restart() {
        await interlock.close();
        interlock = await openInterlock();
        rail = railOver(interlock);
      },
      async rollback() {
        await interlock.close();
        open = false;
        for (const suffix of ['-wal', '-shm']) rmSync(`${interlockPath}${suffix}`, { force: true });
        copyFileSync(backupPath, interlockPath);
        try {
          interlock = await openInterlock();
          open = true;
          return { refused: false };
        } catch (error) {
          return { refused: true, code: freshnessCode(error) };
        }
      },
      async close() {
        if (open) await interlock.close().catch(() => undefined);
      },
    };
  },
});
