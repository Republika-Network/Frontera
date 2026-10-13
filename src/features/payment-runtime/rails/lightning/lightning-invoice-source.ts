import type { LightningDestination } from './lightning-destination.js';

/**
 * Where the rail obtains the BOLT11 text for a governed destination (PAY-06).
 *
 * Trusted embedder composition. The governed destination names the payee and
 * the payment hash; the invoice text — too long for a governed reference, and
 * not itself authority — is held by whatever obtained it (a merchant
 * checkout, a protocol adapter, an operator) and looked up here by that
 * payment hash. The rail decodes and verifies whatever it returns and pays it
 * only if it matches the governed payee, payment hash, amount and network
 * exactly; an invoice source can therefore withhold a payment, never redirect
 * one.
 *
 * Invoices are not refreshed here or anywhere in the rail: an expired invoice
 * is refused, and obtaining a new one is the application's (or a protocol's)
 * business — a new invoice is a new payment hash, so a new governed payment.
 */
export interface LightningInvoiceSource {
  /** The invoice for this payee and payment hash, or `undefined` when none is known. May throw (refused). */
  invoiceFor(query: LightningDestination & { readonly executionId: string }): Promise<string | undefined>;
}

/**
 * A minimal in-memory invoice source: an embedder registers each invoice
 * under its payment hash before it creates the governed payment. Useful for
 * single-process composition and tests; durable sources are the embedder's.
 */
export function createLightningInvoiceBook(): LightningInvoiceSource & { register(paymentHash: string, invoice: string): void } {
  const invoices = new Map<string, string>();
  return Object.freeze({
    register(paymentHash: string, invoice: string): void {
      if (typeof paymentHash !== 'string' || !/^[0-9a-f]{64}$/.test(paymentHash) || typeof invoice !== 'string') throw new TypeError('An invoice is registered under its payment hash (lowercase hex).');
      if (invoices.has(paymentHash) && invoices.get(paymentHash) !== invoice) throw new TypeError('A different invoice is already registered under this payment hash.');
      invoices.set(paymentHash, invoice);
    },
    async invoiceFor(query: LightningDestination & { readonly executionId: string }): Promise<string | undefined> {
      return invoices.get(query.paymentHash);
    },
  });
}
