/**
 * Where an authority signer's private key lives (CORE-02), recorded by the
 * constructor that knows, and read by composition — never inferred from a
 * TypeScript shape.
 *
 * - `software`: the key is parsed into this process (`createSoftwareAuthorityArtifactSigner`, AA-001).
 * - `external`: this process holds no key; signatures come from an external
 *   custody boundary and are verified locally before use
 *   (`src/enterprise/external-authority-signer/`).
 *
 * The same kind of runtime brand as the authenticated durable grant store
 * (CORE-01, `AUTHORITY_ARTIFACT_AUTHENTICITY.md` §26.8), with the same
 * boundary: it stops an honest composition mistake — a software signer, or a
 * store built with one, carried into a deployment configured for external
 * custody. Code running in this process can register anything; a malicious
 * in-process host is outside the trust boundary.
 *
 * Nothing here holds, names or reaches key material, credentials or endpoints.
 */

export type AuthoritySignerCustody = 'software' | 'external';

const SIGNER_CUSTODY = new WeakMap<object, AuthoritySignerCustody>();
const STORE_CUSTODY = new WeakMap<object, AuthoritySignerCustody | 'unknown'>();

/** Recorded once, by the constructor that built the signer. A second, different registration is refused: a signer has one custody. */
export function registerAuthoritySignerCustody(signer: object, custody: AuthoritySignerCustody): void {
  const existing = SIGNER_CUSTODY.get(signer);
  if (existing !== undefined && existing !== custody) throw new Error('An authority signer has exactly one custody.');
  SIGNER_CUSTODY.set(signer, custody);
}

/** The custody its constructor recorded, or `unknown` for a signer no trusted constructor built (a test double, a wrapper, a shape-alike). */
export function authoritySignerCustody(signer: unknown): AuthoritySignerCustody | 'unknown' {
  if (typeof signer !== 'object' || signer === null) return 'unknown';
  return SIGNER_CUSTODY.get(signer) ?? 'unknown';
}

/** Called by each authenticated durable store with the signer it was built with, so composition can ask a store it did not build what custody signs for it. */
export function bindStoreSignerCustody(store: object, signer: unknown): void {
  STORE_CUSTODY.set(store, authoritySignerCustody(signer));
}

/** The custody of the signer an authenticated durable store was built with; `unknown` for anything else. */
export function storeSignerCustody(store: unknown): AuthoritySignerCustody | 'unknown' {
  if (typeof store !== 'object' || store === null) return 'unknown';
  return STORE_CUSTODY.get(store) ?? 'unknown';
}
