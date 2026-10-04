import { executionDestinationKey, parseExecutionDestination } from '../../../features/destination-runtime/index.js';
import type { ValidatedExecutionAction } from '../../../features/execution-runtime/index.js';
import type { XrplPaymentInstruction } from './contracts.js';
import type { XrplPlan } from './configuration.js';
import { isXrplClassicAddress, xrplDropsFromXrp, xrplIssuedCurrencyValue } from './xrpl-codec.js';

/**
 * The pure half of the adapter: one validated action and the frozen plan in,
 * one canonical Payment instruction or one refusal out. No I/O, no clock, no
 * randomness — the same action always yields the same instruction.
 *
 * ## Every value comes from the validated action
 *
 * `Destination` is the identifier of the destination the action's
 * `counterparty` designates — the value the exercise gate proved equal to the
 * grant's bound — and `Amount` is built from the action's `amount`, proven
 * within the grant's ceiling in the grant's own unit. There is no second
 * destination or amount field to read: the action is the payload.
 *
 * The counterparty must *be* a canonical P0-01 destination key: it is parsed
 * through P0-01's single ingress and accepted only when it re-spells to the
 * identical key, the rule the trusted destination context applies before it
 * reports approval facts about that same key. The namespace must be exactly the
 * one this adapter serves; nothing is stripped, folded or reinterpreted.
 *
 * Address validity is checked here and nowhere above: a destination may be
 * registered and approved and still not be a usable XRPL address, and that
 * fails at this boundary, before the transport.
 */

export type XrplTranslationRefusal =
  /** The action names no counterparty, so there is nothing to pay. */
  | 'destination-missing'
  /** The counterparty is not exactly a canonical destination key. */
  | 'destination-malformed'
  /** The destination belongs to a namespace this adapter does not serve. */
  | 'namespace-unsupported'
  /** The identifier is not a valid XRPL classic address. */
  | 'address-invalid'
  /** The action carries no amount. */
  | 'amount-missing'
  /** The amount's asset has no explicit XRPL mapping. Never converted, never sent as something else. */
  | 'asset-unmapped'
  /** The amount cannot be stated exactly on XRPL: zero, finer than a drop, beyond 15 significant digits or out of range. */
  | 'amount-unrepresentable';

export type XrplTranslation = { readonly ok: true; readonly instruction: XrplPaymentInstruction } | { readonly ok: false; readonly refusal: XrplTranslationRefusal };

const refuse = (refusal: XrplTranslationRefusal): XrplTranslation => ({ ok: false, refusal });

export function translateXrplPayment(plan: XrplPlan, action: ValidatedExecutionAction): XrplTranslation {
  const counterparty = action.counterparty;
  if (typeof counterparty !== 'string') return refuse('destination-missing');
  const separator = counterparty.indexOf(':');
  if (separator <= 0) return refuse('destination-malformed');
  const parsed = parseExecutionDestination({ namespace: counterparty.slice(0, separator), identifier: counterparty.slice(separator + 1) });
  if (!parsed.valid || executionDestinationKey(parsed.destination) !== counterparty) return refuse('destination-malformed');
  const destination = parsed.destination;
  if (destination.namespace !== plan.namespace) return refuse('namespace-unsupported');
  if (!isXrplClassicAddress(destination.identifier)) return refuse('address-invalid');

  const amount = action.amount;
  if (amount === undefined) return refuse('amount-missing');
  const representation = plan.assets.get(amount.unit);
  if (representation === undefined) return refuse('asset-unmapped');

  if (representation.kind === 'native') {
    const drops = xrplDropsFromXrp(amount.value);
    if (drops === undefined) return refuse('amount-unrepresentable');
    return { ok: true, instruction: Object.freeze({ TransactionType: 'Payment', Destination: destination.identifier, Amount: drops }) };
  }
  const value = xrplIssuedCurrencyValue(amount.value);
  if (value === undefined) return refuse('amount-unrepresentable');
  return {
    ok: true,
    instruction: Object.freeze({
      TransactionType: 'Payment',
      Destination: destination.identifier,
      Amount: Object.freeze({ currency: representation.currency, issuer: representation.issuer, value }),
    }),
  };
}
