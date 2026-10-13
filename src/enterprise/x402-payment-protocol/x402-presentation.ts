import { X402_PROTOCOL_ID, type X402PaymentProtocolAdapter } from '../../features/payment-runtime/protocols/x402/index.js';
import type { BoundCustomerIdentity } from '../customer-identity/index.js';
import type { PaymentProtocolIngress, PaymentProtocolIngressRequest, PaymentProtocolIngressResult } from '../payment-protocol-ingress/index.js';
import type { X402LightningExecutionInvoices } from './x402-lightning-execution-invoices.js';

/**
 * PAY-08 — presenting a merchant's x402 402 response to the **existing**
 * PAY-04 ingress. Not a second ingress: one awaited preparation step (the
 * bindings' asynchronous, pure verification — PAY-06's BOLT11 signature check),
 * then `prepareAndGovern` exactly as for any protocol, which owns the whole
 * order — interpretation, PaymentIntent, PAY-01 compiler, the durable,
 * CORE-07-anchored business operation, and only then `govern()`.
 *
 * The caller's request is forwarded **as given**: the ingress reads it closed
 * itself (own data properties only), so nothing here copies it, spreads it or
 * runs an accessor on it. Preparation reads `challenges` from its own data
 * descriptor only; an accessor there is simply not prepared, and the adapter
 * refuses what was not prepared. Preparation establishes nothing about
 * authority and moves nothing. The discovery request that received the 402 is
 * not a payment effect, and nothing here sends a request.
 *
 * With Lightning invoices composed, the presentation's governed request is
 * held in flight (`X402LightningExecutionInvoices.during`) for exactly the one
 * ingress call, so the rail — which runs inside it — can be handed the exact
 * invoice PAY-04 recorded for the execution, and nothing outlives the call.
 */
export interface X402Presentation {
  present(identity: BoundCustomerIdentity, request: PaymentProtocolIngressRequest): Promise<PaymentProtocolIngressResult>;
}

/** One member of the caller's request, read from its own data descriptor — never through a getter. */
function ownDataOf(request: unknown, name: 'challenges' | 'businessOperationId'): unknown {
  try {
    if (request === null || typeof request !== 'object') return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(request, name);
    return descriptor !== undefined && 'value' in descriptor ? (descriptor.value as unknown) : undefined;
  } catch {
    return undefined;
  }
}

export function createX402Presentation(options: { readonly adapter: X402PaymentProtocolAdapter; readonly ingress: PaymentProtocolIngress; readonly invoices?: X402LightningExecutionInvoices }): X402Presentation {
  const { adapter, ingress, invoices } = options ?? ({} as { adapter: X402PaymentProtocolAdapter; ingress: PaymentProtocolIngress; invoices?: X402LightningExecutionInvoices });
  if (adapter === null || typeof adapter !== 'object' || adapter.protocolId !== X402_PROTOCOL_ID || typeof adapter.prepare !== 'function') throw new TypeError('The x402 adapter is required.');
  if (ingress === null || typeof ingress !== 'object' || typeof ingress.prepareAndGovern !== 'function' || !ingress.protocols.includes(X402_PROTOCOL_ID)) throw new TypeError('The payment protocol ingress must compose the x402 adapter.');
  if (invoices !== undefined && (invoices === null || typeof invoices !== 'object' || typeof invoices.during !== 'function')) throw new TypeError('The Lightning execution invoices must be the composed ones.');
  const prepare = adapter.prepare;
  return Object.freeze({
    async present(identity: BoundCustomerIdentity, request: PaymentProtocolIngressRequest): Promise<PaymentProtocolIngressResult> {
      await prepare.call(adapter, ownDataOf(request, 'challenges'));
      const enter = async (): Promise<PaymentProtocolIngressResult> => {
        return ingress.prepareAndGovern(identity, request);
      };
      return invoices === undefined ? enter() : invoices.during(identity, ownDataOf(request, 'businessOperationId'), enter);
    },
  });
}
