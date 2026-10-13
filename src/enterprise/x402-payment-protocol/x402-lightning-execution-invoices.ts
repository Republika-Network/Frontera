import { X402_PROTOCOL_ID, isX402JsonObject, parseX402Json, readX402Requirements } from '../../features/payment-runtime/protocols/x402/index.js';
import { parseLightningDestination, type LightningDestination, type LightningInvoiceSource } from '../../features/payment-runtime/rails/lightning/index.js';
import type { BoundCustomerIdentity } from '../customer-identity/index.js';
import type { GovernanceRecord, GovernanceStoreAccessContext } from '../governance-store/index.js';
import { deriveGovernedActionExecutionId, executionAttemptReferenceId } from '../governed-action/identifiers.js';
import { boundScopeOf } from '../governed-action/kernel-request.js';
import { derivePaymentBusinessOperationRequestId, type PaymentProtocolContextReader } from '../payment-protocol-ingress/index.js';
import { X402_LNBTC_NETWORKS, x402LightningBindingId } from './x402-lightning-binding.js';

/**
 * PAY-08 — the Lightning rail's invoice source for x402, bound to the
 * **execution**, not to a history of invoices.
 *
 * PAY-06 asks `invoiceFor({ executionId, payee, paymentHash })`. The answer is
 * read from durable state, never from what this process happens to remember:
 *
 * ```
 * executionId E (from PAY-06)
 *   → an x402 presentation in flight here, whose governed request R is derived
 *     exactly as PAY-04 derives it (the orchestrator's identity reader, PAY-04's
 *     business-operation derivation)
 *   → the Governance Store's committed decision for R:  E = derive(R, decision)
 *     and E's write-ahead execution claim is on R's record
 *   → PAY-04's CORE-07-anchored record for R: an x402 lnbtc challenge whose
 *     destination is exactly (payee, paymentHash), whose instrument is
 *     <network>:<paymentHash>, whose requirement re-reads closed
 *   → that requirement's `extra.invoice` — the exact text interpreted, bound to
 *     the request, recorded before governance, and governed
 * ```
 *
 * Anything else — no presentation in flight for E, no committed decision, a
 * different derived execution, no claim, a record for another destination, a
 * requirement that does not re-read — is `undefined`, which PAY-06 refuses as
 * `invoice-unavailable` **before** any node call. The source can withhold a
 * payment, never redirect one, and never hands one execution another's text.
 *
 * Why this is enough. PAY-04 records each x402 instrument (network + payment
 * hash) for one business operation only, with one exact requirement: another
 * invoice text under the same instrument — same operation or another — is a
 * conflict refused before `govern()`. So the text read here is the only text
 * that could ever have been governed for that instrument, and it is read from
 * the record, after the decision, for the execution PAY-06 is running.
 *
 * What lives in memory: only the presentations **currently in flight** (a
 * counted entry per governed request, added before the ingress is entered and
 * removed when it returns). The governed path runs the rail inside that call,
 * so this is exactly the window in which PAY-06 can ask; after it, a
 * re-presentation of an attempted execution is answered from the governance
 * record without reaching the rail, and P12 resolves an uncertain one by the
 * node's payment status, never through this source. Nothing accumulates with
 * traffic: memory is bounded by concurrency, never by history. A restart
 * starts with nothing in flight; the durable binding is unchanged.
 */

/** The Governance Store's read by governed request id — the committed decision and its execution claim. Trusted composition, read-only. */
export interface X402GovernedRequestRecordReader {
  getByRequestId(context: GovernanceStoreAccessContext, requestId: string): Promise<GovernanceRecord | null>;
}

export interface X402LightningExecutionInvoicesOptions {
  /** The organization the composed ingress serves. */
  readonly organizationId: string;
  /** PAY-04's verified context reader over the same business-operation store the ingress records into. */
  readonly contexts: PaymentProtocolContextReader;
  /** The Governance Store the orchestrator commits decisions and execution claims into. */
  readonly decisions: X402GovernedRequestRecordReader;
}

export interface X402LightningExecutionInvoices {
  /** The source PAY-06's Lightning rail is composed with. */
  readonly invoices: LightningInvoiceSource;
  /**
   * Runs one presentation with its governed request in flight: the request id
   * is derived from the bound identity and the business operation exactly as
   * PAY-04 derives it, held while `run` executes, and released when it settles.
   * An identity or operation that does not derive a request holds nothing.
   */
  during<T>(identity: BoundCustomerIdentity, businessOperationId: unknown, run: () => Promise<T>): Promise<T>;
}

const LIGHTNING_NETWORKS = new Map<string, string>((Object.keys(X402_LNBTC_NETWORKS) as (keyof typeof X402_LNBTC_NETWORKS)[]).map((network) => [x402LightningBindingId(network), X402_LNBTC_NETWORKS[network].network]));

export function createX402LightningExecutionInvoices(options: X402LightningExecutionInvoicesOptions): X402LightningExecutionInvoices {
  const { organizationId, contexts, decisions } = options ?? ({} as X402LightningExecutionInvoicesOptions);
  if (typeof organizationId !== 'string' || organizationId.length === 0) throw new TypeError('The served organization id is required.');
  if (contexts === null || typeof contexts !== 'object' || typeof contexts.readByGovernedRequestId !== 'function') throw new TypeError('The PAY-04 context reader is required.');
  if (decisions === null || typeof decisions !== 'object' || typeof decisions.getByRequestId !== 'function') throw new TypeError('The Governance Store request reader is required.');

  /** Governed request id → presentations of it in flight. Entries exist only while a presentation runs. */
  const inFlight = new Map<string, number>();

  /** The exact invoice PAY-04 recorded for `requestId`, if its execution is `executionId` and its destination is exactly `query`'s. */
  async function invoiceOf(requestId: string, query: LightningDestination & { readonly executionId: string }): Promise<string | undefined> {
    const record = await decisions.getByRequestId({ system: false, organizationId }, requestId);
    if (record === null || record.request.organizationId !== organizationId) return undefined;
    // The execution PAY-06 runs must be this request's committed decision's — and already claimed (write-ahead, before the adapter).
    if (deriveGovernedActionExecutionId({ requestId, decisionId: record.evaluation.decisionId }) !== query.executionId) return undefined;
    if (!record.references.some((entry) => entry.referenceId === executionAttemptReferenceId(query.executionId) && entry.externalId === query.executionId)) return undefined;

    const context = await contexts.readByGovernedRequestId(organizationId, requestId);
    if (context === undefined || context.requestId !== requestId || context.challenge.protocolId !== X402_PROTOCOL_ID) return undefined;
    const network = LIGHTNING_NETWORKS.get(context.challenge.fields['binding'] ?? '');
    const destination = parseLightningDestination(context.terms.destination);
    if (network === undefined || destination === undefined || destination.payee !== query.payee || destination.paymentHash !== query.paymentHash) return undefined;
    if (context.challenge.fields['instrument'] !== `${network}:${query.paymentHash}` || context.challenge.key !== `${X402_PROTOCOL_ID}:2:${network}:${query.paymentHash}`) return undefined;
    const parsed = parseX402Json(context.challenge.fields['requirement'] ?? '');
    if (!parsed.valid) return undefined;
    const requirement = readX402Requirements(parsed.value);
    if (requirement.network !== network || requirement.payTo !== query.payee || requirement.extra === undefined || !isX402JsonObject(requirement.extra)) return undefined;
    const invoice = requirement.extra['invoice'];
    return typeof invoice === 'string' && invoice.length > 0 ? invoice : undefined;
  }

  return Object.freeze({
    invoices: Object.freeze({
      async invoiceFor(query: LightningDestination & { readonly executionId: string }): Promise<string | undefined> {
        // Exactly one in-flight request can derive this execution; none other is consulted further.
        for (const requestId of [...inFlight.keys()]) {
          let invoice: string | undefined;
          try {
            invoice = await invoiceOf(requestId, query);
          } catch {
            return undefined;
          }
          if (invoice !== undefined) return invoice;
        }
        return undefined;
      },
    }),

    async during<T>(identity: BoundCustomerIdentity, businessOperationId: unknown, run: () => Promise<T>): Promise<T> {
      const scope = boundScopeOf(identity, organizationId);
      if (scope === undefined || typeof businessOperationId !== 'string' || businessOperationId.length === 0) return run();
      let requestId: string;
      try {
        requestId = derivePaymentBusinessOperationRequestId({ organizationId: scope.organizationId, principalId: scope.principalId, businessOperationId });
      } catch {
        return run();
      }
      inFlight.set(requestId, (inFlight.get(requestId) ?? 0) + 1);
      try {
        return await run();
      } finally {
        const remaining = (inFlight.get(requestId) ?? 1) - 1;
        if (remaining > 0) inFlight.set(requestId, remaining);
        else inFlight.delete(requestId);
      }
    },
  });
}
