/**
 * ANDREW-P0-11 — nothing the demo prints or writes may carry secret material.
 *
 * Two layers: every secret value the run holds (seeds from the secrets file,
 * the generated credentials, the generated private keys) is registered and
 * matched exactly; and secret *shapes* are refused even when unregistered — an
 * XRPL family seed, a PEM private key, a long hex blob (a signed transaction).
 * A hit is never printed: the guard throws a fixed phrase naming the shape.
 */

const SHAPES: readonly (readonly [string, RegExp])[] = [
  // secp256k1 seeds are 29 characters, Ed25519 seeds (`sEd…`) 31.
  ['an XRPL family seed', /\bs[1-9A-HJ-NP-Za-km-z]{28,30}\b/],
  ['a PEM private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['a signed transaction blob', /\b[0-9A-Fa-f]{200,}\b/],
];

export class SecretExposureError extends Error {
  constructor(readonly shape: string) {
    super(`Refused to emit output carrying ${shape}.`);
    this.name = 'SecretExposureError';
  }
}

export interface SecretGuard {
  register(value: string | undefined): void;
  /** Returns `text` unchanged, or throws `SecretExposureError` (never echoing the secret). */
  check(text: string): string;
}

export function createSecretGuard(): SecretGuard {
  const secrets = new Set<string>();
  return {
    register(value) {
      if (typeof value === 'string' && value.length >= 8) secrets.add(value);
    },
    check(text) {
      for (const secret of secrets) if (text.includes(secret)) throw new SecretExposureError('a registered secret value');
      for (const [shape, pattern] of SHAPES) if (pattern.test(text)) throw new SecretExposureError(shape);
      return text;
    },
  };
}
