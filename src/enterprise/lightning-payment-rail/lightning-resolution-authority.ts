import { EXECUTION_FAILURE_REASONS } from '../../features/execution-runtime/index.js';
import {
  btcDecimalOfMsat,
  concludeLightningPayment,
  isLightningNodePublicKey,
  isLightningRailConfiguration,
  readLightningNodeInfo,
  readLightningPaymentObservation,
  type LightningNodeReader,
  type LightningRailConfiguration,
} from '../../features/payment-runtime/rails/lightning/index.js';
import type { ExecutionResolutionAuthority, ExecutionResolutionAuthorityResult, ExecutionResolutionQuery } from '../execution-reconciliation/authority.js';
import type { LightningPaymentReservationRecord } from './sqlite-lightning-payment-interlock.js';

/** The P12 authority id under which Lightning executions are bound before their claim. */
export const LIGHTNING_RESOLUTION_AUTHORITY_ID = 'frontera.lightning-btc-node';

/** What the resolver reads from the local interlock: one reservation, by execution. It never writes the interlock. */
export interface LightningResolutionInterlockAccess {
  read(executionId: string): Promise<LightningPaymentReservationRecord | undefined>;
}

export interface LightningResolutionAuthorityOptions {
  readonly configuration: LightningRailConfiguration;
  /** Reads only — build it with `readOnlyLightningNode`; a reference adapter gives it a node-enforced read-only credential too. */
  readonly node: LightningNodeReader;
  readonly interlock: LightningResolutionInterlockAccess;
}

const UNRESOLVED: ExecutionResolutionAuthorityResult = Object.freeze({ outcome: 'unresolved' });

/**
 * PAY-06 — the Lightning rail's P12 `ExecutionResolutionAuthority`: read-only,
 * conservative, composed into the **existing** P12 flow unchanged (no second
 * reconciliation model, no second outcome store, no timer, no Lightning word
 * in P12's contract).
 *
 * Given an uncertain execution, it reads the one reservation the interlock
 * recorded for it — strictly before the send, so every payment that could
 * have been initiated has one — and asks **the payer node bound in that
 * reservation** for **that** logical payment, by its payment hash:
 *
 * | node answer for the reserved payment hash | P12 answer |
 * | --- | --- |
 * | the reserved payer: succeeded; preimage hashes to the payment hash; amount exactly the reserved amount; fee ≤ the reserved cap | `resolved / confirmed-completed`, ref = payment hash |
 * | the reserved payer: failed — terminal, nothing in flight | `resolved / confirmed-not-completed PROVIDER_REJECTED`, ref = payment hash |
 * | the reserved payer: in flight, not found, unreachable, unreadable, succeeded but inconsistent | `unresolved` (no resolution recorded) |
 * | **another node** (another identity, even on the same network) — whatever it answers | `unresolved` |
 * | another network | `unresolved` |
 * | no reservation for the execution, or one that disagrees with the P11 attempt (hash, asset, amount) | `unresolved` |
 *
 * **Another node proves nothing.** A payment hash names an invoice, and any
 * node may have tried to pay it; its record is about its own attempt. So the
 * node's identity must equal the reservation's `payerNodeId` — the identity
 * verified before the send — before its payment status is even read. A reader
 * composed against the wrong node, on the same network, can neither complete
 * nor fail this execution.
 *
 * **Absence is never evidence.** A node that does not know the payment proves
 * nothing (it could have lost state; the request could still arrive); a
 * missing reservation proves "never sent" only if the file could not have been
 * rolled back. Neither is ever answered as a non-completion.
 *
 * Bound exactly: the query's execution, the P11 attempt's handle (the payment
 * hash) and amount, and the reservation must all describe the same payment;
 * P12 itself binds the answer to the attempt digest, the current P11
 * observation and this authority.
 *
 * It **never** sends, retries, builds a route or touches the original payment
 * — it holds no send capability (`LightningNodeReader` has none) — and is asked
 * only from an explicit reconciliation.
 */
export function createLightningResolutionAuthority(options: LightningResolutionAuthorityOptions): ExecutionResolutionAuthority {
  const configuration = options?.configuration;
  if (!isLightningRailConfiguration(configuration)) throw new TypeError('The Lightning resolution authority needs a validated rail configuration.');
  const node = options.node;
  for (const method of ['nodeInfo', 'paymentStatus'] as const) {
    if (typeof node?.[method] !== 'function') throw new TypeError(`The Lightning resolution authority's node reader must implement ${method}.`);
  }
  const interlock = options.interlock;
  if (typeof interlock?.read !== 'function') throw new TypeError('The Lightning resolution authority needs read access to the interlock.');
  const timeout = configuration.requestTimeoutMs;

  async function resolve(query: ExecutionResolutionQuery): Promise<ExecutionResolutionAuthorityResult> {
    let record: LightningPaymentReservationRecord | undefined;
    try {
      record = await interlock.read(query.executionId);
    } catch {
      return UNRESOLVED;
    }
    if (record === undefined || record.executionId !== query.executionId || record.network !== configuration.network || !isLightningNodePublicKey(record.payerNodeId)) return UNRESOLVED;
    // The P11 attempt and the reservation must describe the same payment.
    if (query.providerRef !== undefined && query.providerRef !== record.paymentHash) return UNRESOLVED;
    if (query.amount !== undefined && (query.amount.unit !== configuration.asset.paymentAsset || query.amount.value !== btcDecimalOfMsat(record.amountMsat))) return UNRESOLVED;

    try {
      const info = readLightningNodeInfo(await node.nodeInfo(timeout));
      // The payer the reservation bound, on the reservation's network — or no answer at all.
      if (info === undefined || info.network !== record.network || info.identity !== record.payerNodeId) return UNRESOLVED;
      const observation = readLightningPaymentObservation(await node.paymentStatus(record.paymentHash, timeout));
      const conclusion = concludeLightningPayment(observation, record);
      const reference = { providerRef: record.paymentHash };
      if (conclusion.kind === 'completed') return Object.freeze({ outcome: 'resolved', certainty: 'confirmed-completed', ...reference });
      if (conclusion.kind === 'failed') return Object.freeze({ outcome: 'resolved', certainty: 'confirmed-not-completed', failure: EXECUTION_FAILURE_REASONS.PROVIDER_REJECTED, ...reference });
      return UNRESOLVED;
    } catch {
      return UNRESOLVED;
    }
  }

  return Object.freeze({ authorityId: LIGHTNING_RESOLUTION_AUTHORITY_ID, resolve });
}
