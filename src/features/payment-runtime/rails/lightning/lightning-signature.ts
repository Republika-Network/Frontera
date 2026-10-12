import { createHash, createPublicKey, verify as verifyWithOpenSsl } from 'node:crypto';

/**
 * BOLT11 signature verification (PAY-06) — the one place the rail touches
 * elliptic-curve cryptography, and it only ever **verifies** public data.
 *
 * A BOLT11 signature is a compact secp256k1 ECDSA signature (R ‖ S, 64 bytes)
 * plus a recovery id, over SHA-256 of the human-readable part and the
 * byte-padded data part. The payee is either the `n` field (then the signature
 * must verify under it **and** be low-S) or — the common case — the key
 * *recovered* from the signature with its recovery id (then high-S is
 * accepted, as the spec requires).
 *
 * Recovery matters: the node that pays an invoice recovers the payee the same
 * way, so a payee Frontera merely *verified* under an expected key while the
 * recovery id named another would not be the node the payment goes to.
 *
 * Two independent implementations must agree before a payee is believed:
 *
 * - `@noble/curves` (already shipped in the runtime through the XRPL SDK;
 *   audited, dependency-free) recovers the key — Node's crypto cannot;
 * - Node's own OpenSSL then verifies the signature under that key.
 *
 * No key is generated, held or derived here. Nothing is signed.
 */

/** secp256k1's group order. */
const CURVE_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const HALF_ORDER = CURVE_ORDER >> 1n;

/** The fixed DER prefix of a secp256k1 SubjectPublicKeyInfo holding a 33-byte compressed point. */
const SPKI_SECP256K1_COMPRESSED_PREFIX = Buffer.from('3036301006072a8648ce3d020106052b8104000a032200', 'hex');

interface NobleSecp256k1 {
  recoverPublicKey(signature: Uint8Array, message: Uint8Array, options: { readonly prehash: false }): Uint8Array;
  verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array, options: { readonly prehash: false; readonly lowS: boolean }): boolean;
}

let loaded: Promise<NobleSecp256k1> | undefined;

/** Loaded on first use (an ES module from this CommonJS build), then cached. */
function curve(): Promise<NobleSecp256k1> {
  loaded ??= import('@noble/curves/secp256k1.js').then((module) => module.secp256k1 as unknown as NobleSecp256k1);
  return loaded;
}

function bigEndian(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

export function sha256(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(createHash('sha256').update(bytes).digest());
}

/** A 33-byte compressed secp256k1 public key, as BOLT11 and nodes spell it (lowercase hex, `02`/`03` prefix). */
export function isLightningNodePublicKey(value: unknown): value is string {
  return typeof value === 'string' && /^0[23][0-9a-f]{64}$/.test(value);
}

function openSslVerifies(message: Uint8Array, compact: Uint8Array, publicKey: Uint8Array): boolean {
  try {
    const key = createPublicKey({ key: Buffer.concat([SPKI_SECP256K1_COMPRESSED_PREFIX, Buffer.from(publicKey)]), format: 'der', type: 'spki' });
    return verifyWithOpenSsl('sha256', Buffer.from(message), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(compact));
  } catch {
    return false;
  }
}

export type Bolt11SignatureCheck = { readonly valid: true; readonly payee: string } | { readonly valid: false; readonly reason: 'signature-invalid' | 'signature-high-s' };

/**
 * Verifies a BOLT11 signature over `message` (the hrp bytes ‖ the padded data
 * bytes — SHA-256 is applied here) and answers the payee it proves.
 *
 * @param signature 65 bytes: R ‖ S ‖ recovery id.
 * @param explicitPayee the `n` field, when the invoice carries one.
 */
export async function verifyBolt11Signature(message: Uint8Array, signature: Uint8Array, explicitPayee: Uint8Array | undefined): Promise<Bolt11SignatureCheck> {
  const invalid: Bolt11SignatureCheck = { valid: false, reason: 'signature-invalid' };
  if (signature.length !== 65) return invalid;
  const compact = signature.subarray(0, 64);
  const recovery = signature[64] ?? 255;
  if (recovery > 3) return invalid;
  const r = bigEndian(compact.subarray(0, 32));
  const s = bigEndian(compact.subarray(32, 64));
  if (r === 0n || r >= CURVE_ORDER || s === 0n || s >= CURVE_ORDER) return invalid;
  const digest = sha256(message);
  let secp: NobleSecp256k1;
  try {
    secp = await curve();
  } catch {
    return invalid;
  }
  try {
    if (explicitPayee !== undefined) {
      if (explicitPayee.length !== 33 || (explicitPayee[0] !== 2 && explicitPayee[0] !== 3)) return invalid;
      // BOLT11: with `n`, the signature is checked under it — and must be low-S.
      if (s > HALF_ORDER) return { valid: false, reason: 'signature-high-s' };
      if (!secp.verify(compact, digest, explicitPayee, { prehash: false, lowS: true })) return invalid;
      if (!openSslVerifies(message, compact, explicitPayee)) return invalid;
      return { valid: true, payee: Buffer.from(explicitPayee).toString('hex') };
    }
    // Without `n`: recover with the stated recovery id (high-S accepted), then verify independently.
    const recovered = secp.recoverPublicKey(Uint8Array.from([recovery, ...compact]), digest, { prehash: false });
    if (!(recovered instanceof Uint8Array) || recovered.length !== 33) return invalid;
    if (!secp.verify(compact, digest, recovered, { prehash: false, lowS: false })) return invalid;
    if (!openSslVerifies(message, compact, recovered)) return invalid;
    return { valid: true, payee: Buffer.from(recovered).toString('hex') };
  } catch {
    return invalid;
  }
}
