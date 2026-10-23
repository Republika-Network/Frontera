import type { AdmittedHttpRequest } from './admission.js';
import type { ReferenceExecutorMethod, ReferenceExecutorOrigin } from './configuration.js';

/**
 * G-02C1A — the executor's own reconstruction of
 * `frontera.http-request-binding.v1` from the request it **received**.
 *
 * The Host computes the record from the request it is about to send
 * (`execution-adapters/generic-http/request-binding.ts`); this computes the same
 * record, independently, from the request the executor's parser delivered. It
 * imports nothing from the Host: the format is restated here and a structure
 * test pins the two equal, and golden vectors pin the two records equal over
 * real HTTP/1.1 bytes. The executor never accepts a digest from the request.
 *
 * | Field | From |
 * |---|---|
 * | `method` | the received method |
 * | `origin` | the executor's **configured** origin; admission already required `Host` to equal its authority |
 * | `target` | the raw request target, byte for byte: never decoded, never normalized |
 * | `headers` | every admitted header (lower-case name, exact value), sorted by name — with one exception, below |
 * | `credentialHeader` | the configured credential header's name |
 * | `body` | the exact UTF-8 text, or `null` when the body is empty — never reparsed as JSON |
 *
 * ## The one `content-length` exception
 *
 * The Host's mapper binds `content-length` exactly when the request has a body.
 * For a body-less `POST`, `PUT` or `PATCH`, Node's HTTP/1.1 client then adds
 * `Content-Length: 0` on its own (`DELETE` gets none). So for those three
 * methods, and only when the received body is empty, the received
 * `content-length` must be present, unique (admission) and exactly `0`, and is
 * then left out of the record — the record's `body: null` already says the same
 * thing. In every other case `content-length` is bound as received; a body-less
 * request of those methods without it, or with another spelling such as `00`,
 * is refused. There is no general rule that ignores `content-length`.
 */

export const REFERENCE_EXECUTOR_HTTP_BINDING_FORMAT = 'frontera.http-request-binding.v1';

/** The methods for which the Host's Node HTTP/1.1 client sends `Content-Length: 0` when there is no body. */
const ZERO_LENGTH_METHODS: readonly ReferenceExecutorMethod[] = Object.freeze(['POST', 'PUT', 'PATCH']);
export const IMPLICIT_ZERO_LENGTH_METHODS = ZERO_LENGTH_METHODS;

export interface ReconstructedHttpRequestBinding {
  readonly method: string;
  readonly origin: { readonly scheme: 'https'; readonly hostname: string; readonly port: number };
  readonly target: string;
  readonly headers: readonly (readonly [string, string])[];
  readonly credentialHeader: string;
  readonly body: string | null;
}

export type BindingReconstruction = { readonly ok: true; readonly binding: ReconstructedHttpRequestBinding } | { readonly ok: false; readonly refusal: 'FRAMING_UNEXPECTED' };

/** Code-unit order on names; admission made names lower-case and unique, so this is a total order. */
function byName(left: readonly [string, string], right: readonly [string, string]): number {
  return left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0;
}

export function reconstructHttpRequestBinding(request: AdmittedHttpRequest, origin: ReferenceExecutorOrigin, credentialHeaderName: string): BindingReconstruction {
  let headers = request.headers;
  const implicitZeroLength = request.body === null && ZERO_LENGTH_METHODS.includes(request.method);
  if (implicitZeroLength) {
    const lengths = headers.filter(([name]) => name === 'content-length');
    if (lengths.length !== 1 || lengths[0]?.[1] !== '0') return { ok: false, refusal: 'FRAMING_UNEXPECTED' };
    headers = headers.filter(([name]) => name !== 'content-length');
  }
  const sorted = headers.map(([name, value]) => Object.freeze([name, value] as const)).sort(byName);
  return {
    ok: true,
    binding: Object.freeze({
      method: request.method,
      origin: Object.freeze({ scheme: 'https' as const, hostname: origin.hostname, port: origin.port }),
      target: request.target,
      headers: Object.freeze(sorted),
      credentialHeader: credentialHeaderName,
      body: request.body,
    }),
  };
}
