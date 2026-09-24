/**
 * Whether a provider reference may be carried out of the execution boundary —
 * onto an `ExecutionOutcome`, into a live result, and into the durable P11
 * execution-outcome record.
 *
 * ## A provider reference is an opaque correlation handle, nothing more
 *
 * It is whatever the provider chose to call its side of the effect: a payment
 * id, a job id, a request id. It is **never proof**: a reference on an
 * `unconfirmed` outcome leaves the effect unconfirmed, and a reference on a
 * `failed` outcome leaves it definitively not completed. Nothing reads a
 * reference to decide anything, nothing dereferences one, and its presence or
 * absence never changes certainty.
 *
 * ## Why it is filtered here, once, for every adapter
 *
 * The value is provider-controlled input relayed by adapter-controlled code,
 * and after P11 it is durable. So the one provider-neutral rule lives at the
 * lowest layer that carries references — this runtime — rather than in each
 * adapter (the Generic HTTP adapter applies it too, alongside its own
 * credential-echo check) or in the evidence stream (which applies its own,
 * wider evidence check downstream and is never a dependency of this layer).
 *
 * Accepted: one non-empty value of at most `PROVIDER_REFERENCE_MAXIMUM_LENGTH`
 * printable ASCII characters, with no leading or trailing space, shaped like
 * none of the credential or destination forms below. Anything else is not a
 * reference this platform will carry, and is **omitted** — never truncated,
 * redacted, hashed or reported, and never a reason to change the outcome.
 */
export const PROVIDER_REFERENCE_MAXIMUM_LENGTH = 512;

const PRINTABLE_TRIMMED = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/;

/** Shapes that are never a reference, whatever a provider put in the field: a bearer or basic credential, a JWT, a PEM block, a URL, a cookie pair, an authorization header. */
const UNSAFE_REFERENCE_PATTERNS: readonly RegExp[] = [
  /\bbearer\s/i,
  /\bbasic\s+[A-Za-z0-9+/=]{8,}/i,
  /^eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/,
  /-----BEGIN [A-Z ]*(PRIVATE KEY|CERTIFICATE)-----/,
  /[a-z][a-z0-9+.-]*:\/\//i,
  /(?:^|[;\s])(?:set-)?cookie\s*[:=]/i,
  /\bauthorization\s*[:=]/i,
];

export function isRecordableProviderRef(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= PROVIDER_REFERENCE_MAXIMUM_LENGTH &&
    PRINTABLE_TRIMMED.test(value) &&
    UNSAFE_REFERENCE_PATTERNS.every((pattern) => !pattern.test(value))
  );
}
