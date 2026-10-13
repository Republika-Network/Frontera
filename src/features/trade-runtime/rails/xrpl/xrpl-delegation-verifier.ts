import { assessTradeDelegation, isTradeInstant, parseTradeDelegationPolicy, parseTradeDelegationRequest } from '../../domain/index.js';
import type { TradeDelegationAssessment, TradeDelegationPins, TradeDelegationPolicy } from '../../domain/index.js';
import { XRPL_DELEGATION_READ_FAILURES, XrplDelegationReaderConfigurationError, createXrplDelegationReader } from './xrpl-delegation-reader.js';
import type { XrplDelegationRead, XrplDelegationReaderOptions } from './xrpl-delegation-reader.js';

/**
 * The XRPL delegation verifier (TRADE-02): request → read-only observation →
 * assessment, in one trusted step.
 *
 * It owns its reader. There is no way to hand it an observation, a verdict, a
 * source or a freshness bound: the request is the applicant's (and is parsed
 * closed), the policy and the port are trusted configuration fixed at
 * creation, and the pins are the execution side's. Whatever the reader cannot
 * answer is `UNAVAILABLE`; nothing is cached, so every `verify` reads the
 * ledger again and a past `AUTHORIZED` is never carried forward.
 *
 * Not composed: like the reader, it is satisfied by fakes until a reviewed
 * composition edge supplies a real port (TRADE-04).
 */

export interface XrplDelegationVerifierOptions extends XrplDelegationReaderOptions {
  readonly policy: TradeDelegationPolicy;
}

export interface XrplDelegationVerifier {
  verify(request: unknown, pins?: TradeDelegationPins): Promise<TradeDelegationAssessment>;
}

export function createXrplDelegationVerifier(options: XrplDelegationVerifierOptions): XrplDelegationVerifier {
  if (typeof options !== 'object' || options === null) throw new XrplDelegationReaderConfigurationError('Delegation verifier options are required.');
  const parsedPolicy = parseTradeDelegationPolicy(options.policy);
  if (parsedPolicy === undefined) throw new XrplDelegationReaderConfigurationError('A delegation policy with a sourceId and maxAgeSeconds (1 to 60) is required.');
  const policy: TradeDelegationPolicy = parsedPolicy;
  const { port, network, clock, maxValidatedLedgerAgeSeconds } = options;
  const reader = createXrplDelegationReader({ port, network, clock, maxValidatedLedgerAgeSeconds });

  function now(): string {
    try {
      const instant: unknown = clock();
      return isTradeInstant(instant) ? instant : '';
    } catch {
      return '';
    }
  }

  async function verify(request: unknown, pins?: TradeDelegationPins): Promise<TradeDelegationAssessment> {
    const parsed = parseTradeDelegationRequest(request);
    // A rejected request, or one for another network than this reader's, is never read.
    let read: XrplDelegationRead | undefined;
    if (parsed.valid && parsed.request.network !== network) read = Object.freeze({ outcome: 'unavailable' as const, failure: XRPL_DELEGATION_READ_FAILURES.NETWORK_MISMATCH });
    else if (parsed.valid) read = await reader.observe({ owner: parsed.request.ownerAccount, delegate: parsed.request.delegateAccount });
    return assessTradeDelegation({ request, policy, read, assessedAt: now(), ...(pins !== undefined ? { pins } : {}) });
  }

  return Object.freeze({ verify });
}
