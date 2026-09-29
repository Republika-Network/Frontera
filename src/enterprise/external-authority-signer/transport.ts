import type { AuthoritySigningFailureReason } from '../authority-authenticity/errors.js';
import type { ExternalAuthoritySigningRequest } from './protocol.js';

/**
 * The port to an external custody service (CORE-02): the one thing that knows
 * *how* to reach it — HTTP, a unix socket, a vendor SDK, an HSM client library.
 *
 * Two calls, both structured, and neither able to move a private key:
 *
 * - `identity` — a **non-signing** capability call: which key, algorithm,
 *   public material, artifact version and operations the service offers. Used
 *   at startup to prove the pinned identity, and by health probes (so a probe
 *   never spends a metered signature).
 * - `sign` — one of the five structured authority operations over its artifact.
 *
 * Both return the service's *raw* answer (`unknown`): deciding whether it is
 * acceptable is the adapter's job (`external-signer.ts`), never the transport's,
 * so a transport cannot be the reason an unverified signature is persisted.
 *
 * Every call is bounded by `timeoutMs`. A transport throws only
 * `ExternalAuthoritySignerTransportError`, carrying a repository-owned reason
 * and a message that names no credential, no payload and no response body.
 */
export interface ExternalAuthoritySignerTransport {
  identity(options: { readonly timeoutMs: number }): Promise<unknown>;
  sign(request: ExternalAuthoritySigningRequest, options: { readonly timeoutMs: number }): Promise<unknown>;
}

export class ExternalAuthoritySignerTransportError extends Error {
  constructor(
    readonly reason: AuthoritySigningFailureReason,
    message: string,
  ) {
    super(message);
    this.name = 'ExternalAuthoritySignerTransportError';
  }
}
