import { copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import type { PaymentRail } from '../../features/payment-runtime/index.js';
import type { MppMethodNormalizer } from '../../features/payment-runtime/protocols/mpp/index.js';
import { createLightningInvoiceBook, createLightningRail, lightningDestinationOf, msatOfBtcDecimal, readOnlyLightningNode, type LightningRail } from '../../features/payment-runtime/rails/lightning/index.js';
import { BTC_ASSET, TEST_NOW_MS, createSimulatedLightningNode, testRailConfiguration, type SimulatedInvoice } from '../../features/payment-runtime/rails/lightning/tests/lightning-test-fixtures.js';
import { createLightningFinalityAuthority } from '../lightning-payment-rail/lightning-finality-authority.js';
import { createLightningResolutionAuthority } from '../lightning-payment-rail/lightning-resolution-authority.js';
import { createSqliteLightningPaymentInterlock, type DurableLightningPaymentInterlock } from '../lightning-payment-rail/sqlite-lightning-payment-interlock.js';
import { boundaryFor } from './core07-freshness-fixture.js';
import { BUSINESS_REFERENCE, GOVERNED_ACCOUNT, type OpenedPaymentRailEdge, type PaymentRailEdge } from './pay07-governed-payment-world.js';

/**
 * PAY-07 — the Lightning / BTC rail edge, composed as PAY-06 composes it: the
 * real rail (strict BOLT11 binding of the governed payee and payment hash,
 * exact msat, the trusted routing-fee cap carried to the node, one send, node
 * uncertainty mapped onto P11), the durable payment interlock anchored at the
 * world's CORE-07 witness (written before the one send), the read-only P12
 * resolution authority and the read-only preimage-finality authority, both
 * bound to the payer node recorded before the send. The node is PAY-06's
 * deterministic simulator with LND's semantics (every send counted); the
 * invoice comes from a trusted embedder source, never from the protocol.
 *
 * Everything Lightning-specific stops here. The shared world receives a
 * `PaymentRail`, two read-only authorities and generic capabilities — it never
 * learns that one proof is a preimage and the other a ledger hash.
 */

const CONFIGURATION = testRailConfiguration({ sourceAccounts: [GOVERNED_ACCOUNT] });

/** Trusted host composition: the merchant's `lnpay` MPP method quotes BTC as decimal text; the host maps it and prefers the Lightning rail. */
const LNPAY: MppMethodNormalizer = {
  methodId: 'lnpay',
  intent: 'charge',
  rail: CONFIGURATION.railId,
  normalize(challenge) {
    const amount = challenge.decodedRequest['amount'];
    const recipient = challenge.decodedRequest['recipient'];
    if (typeof amount !== 'string' || challenge.decodedRequest['currency'] !== 'btc') return undefined;
    return { amount: { value: amount, unit: BTC_ASSET }, ...(typeof recipient === 'string' ? { merchantReference: recipient } : {}), reference: BUSINESS_REFERENCE };
  },
};

const freshnessCode = (error: unknown): string => (typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'UNCODED');

export const LIGHTNING_EDGE: PaymentRailEdge = Object.freeze<PaymentRailEdge>({
  implementationId: CONFIGURATION.railId,
  railId: CONFIGURATION.railId,
  asset: { assetId: BTC_ASSET, scale: 11 },
  // The same logical bound as every rail: a ceiling of 0.001 BTC; 2.5 % of it is within, 1.00001 × of it is over — in BTC's own exact unit. No FX.
  economics: { ceiling: { value: '0.001', unit: BTC_ASSET }, withinCeiling: { value: '0.000025', unit: BTC_ASSET }, overCeiling: { value: '0.00100001', unit: BTC_ASSET } },
  lifetime: '0.1',
  mppMethod: LNPAY,
  mppRequest: (amount, merchantReference) => ({ amount: amount.value, currency: 'btc', recipient: merchantReference }),

  async open({ directory, witness, organizationId }): Promise<OpenedPaymentRailEdge> {
    const interlockPath = join(directory, 'lightning-payment-interlock.sqlite');
    const backupPath = join(directory, 'lightning-payment-interlock.before-payment.sqlite');
    const node = await createSimulatedLightningNode();
    const book = createLightningInvoiceBook();
    const openInterlock = async (): Promise<DurableLightningPaymentInterlock> =>
      createSqliteLightningPaymentInterlock(interlockPath, { scope: { railId: CONFIGURATION.railId, network: CONFIGURATION.network }, now: () => new Date().toISOString(), freshness: { boundary: await boundaryFor(witness, organizationId) } });

    // A backup of the interlock taken before any payment: the stale copy a rollback would restore.
    let interlock = await openInterlock();
    await interlock.close();
    copyFileSync(interlockPath, backupPath);
    interlock = await openInterlock();
    let open = true;

    const railOver = (store: DurableLightningPaymentInterlock): LightningRail => createLightningRail({ configuration: CONFIGURATION, node, invoices: book, interlock: store, now: () => TEST_NOW_MS });
    let rail = railOver(interlock);
    const delegate: PaymentRail = { railId: CONFIGURATION.railId, execute: (request) => rail.execute(request) };
    let invoice: SimulatedInvoice | undefined;

    return {
      rail: delegate,
      async preparePayee(amount, label) {
        const amountMsat = msatOfBtcDecimal(amount.value);
        if (amountMsat === undefined) throw new Error('pay07-lightning: not an exact BTC amount');
        // The payee's invoice, from the trusted embedder source: registered with the node and in the invoice book the rail binds against.
        invoice = await node.registerInvoice({ label, amountMsat });
        book.register(invoice.paymentHash, invoice.invoice);
        return { merchantReference: label, destination: lightningDestinationOf(invoice.payee, invoice.paymentHash) };
      },
      behave(behaviour) {
        node.behaviour = behaviour === 'complete' ? 'succeed' : behaviour === 'fail' ? 'fail' : 'hold';
      },
      effects: () => node.calls.sendPayment,
      async resolveExternally(outcome) {
        if (invoice === undefined) throw new Error('pay07-lightning: no payment to resolve');
        if (outcome === 'completed') node.settleHeld(invoice.paymentHash);
        else node.cancelHeld(invoice.paymentHash);
      },
      resolutionAuthority: () => createLightningResolutionAuthority({ configuration: CONFIGURATION, node: readOnlyLightningNode(node), interlock }),
      finalityAuthority: () => createLightningFinalityAuthority({ configuration: CONFIGURATION, node: readOnlyLightningNode(node), interlock }),
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
