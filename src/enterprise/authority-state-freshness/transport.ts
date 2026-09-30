import type { WitnessRequest } from './protocol.js';

/**
 * The port to an authority-state witness (CORE-07): the one thing that knows
 * *how* to reach it — HTTP, a unix socket, a vendor SDK in front of a ledger or
 * a timestamping service.
 *
 * One call, structured: it sends one of the five protocol requests and returns
 * the witness's **raw** answer (`unknown`). Deciding whether that answer is
 * acceptable — its shape, its signature under the pinned witness key, its
 * challenge, its binding — is the client's job (`witness-client.ts`), never the
 * transport's, so a transport cannot be the reason an unverified receipt is
 * believed.
 *
 * Every call is bounded by `timeoutMs`. A transport throws only
 * `AuthorityStateFreshnessError`, with a code from the transport family
 * (`UNAVAILABLE`, `AUTHENTICATION_FAILED`, `REFUSED`, `MALFORMED_RESPONSE`) and a
 * message that names no credential, no endpoint path and no response body.
 */
export interface AuthorityStateWitnessTransport {
  call(request: WitnessRequest, options: { readonly timeoutMs: number }): Promise<unknown>;
}
