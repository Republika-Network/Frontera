import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';

import { AUTHORITY_ARTIFACT_VERSION } from '../authority-authenticity/signature-envelope.js';
import { EXECUTOR_RECEIPT_SIGNING_DOMAIN, executorReceiptSigningBytes } from '../executor-receipt/index.js';
import { isExecutorReceiptReservation, type StoredExecutorReceipt } from './receipt-ledger.js';

/**
 * G-02C1C — the reference executor's **receipt signer**: the one place in the
 * executor that holds a private key, and it is the executor's own receipt
 * key, never an authority key.
 *
 * ## One structured operation
 *
 * `signExecutorReceipt(reservation)` signs only a reservation the receipt
 * ledger produced (a branded object — a look-alike is refused), only for this
 * executor and this key id, and only the receipt domain followed by the
 * reservation's own canonical text. There is no `sign(bytes)`. Every signature
 * is verified with the public half before it is returned.
 *
 * ## Custody checks at load
 *
 * The key file must be a regular file (not a link), its own canonical path,
 * owned by this user and readable by no one else; its content must be one
 * Ed25519 private key. Its key id and its public material must differ from
 * every issuer key the executor trusts. The private key never leaves this
 * module: what is exported is the key id and the public PEM.
 */

export class ExecutorReceiptSignerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutorReceiptSignerError';
  }
}

export interface ExecutorReceiptSigner {
  readonly executorId: string;
  readonly keyId: string;
  /** SPKI PEM: what a verifier pins. */
  readonly publicKeyPem: string;
  signExecutorReceipt(reservation: StoredExecutorReceipt): Readonly<Record<string, string>>;
}

const materialOf = (key: KeyObject): string => createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex');

export function loadExecutorReceiptSigner(options: {
  readonly executorId: string;
  readonly keyId: string;
  readonly privateKeyFile: string;
  /** Every issuer key the executor pins: none may be this key. */
  readonly issuerKeys: readonly { readonly keyId: string; readonly publicKeyPem: string }[];
}): ExecutorReceiptSigner {
  const refuse = (message: string): never => {
    throw new ExecutorReceiptSignerError(message);
  };
  const { executorId, keyId, privateKeyFile } = options;
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (uid === undefined) refuse('This platform has no user identity to check the receipt key file against.');
  let pem: string;
  try {
    const stat = lstatSync(privateKeyFile);
    if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(privateKeyFile) !== privateKeyFile) return refuse('The receipt key file must be a regular file at its canonical path.');
    if (stat.uid !== uid || (stat.mode & 0o077) !== 0) return refuse('The receipt key file must be owned by this user and readable by no one else.');
    pem = readFileSync(privateKeyFile, 'utf8');
  } catch (error) {
    if (error instanceof ExecutorReceiptSignerError) throw error;
    return refuse('The receipt key file could not be read.');
  }
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(pem);
  } catch {
    return refuse('The receipt key file does not hold a private key.');
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') refuse('The receipt key must be Ed25519.');
  const publicKey = createPublicKey(privateKey);
  const material = materialOf(publicKey);
  for (const issuerKey of options.issuerKeys) {
    if (issuerKey.keyId === keyId) refuse('The receipt key id is also a trusted issuer key id; an executor key is never an authority key.');
    if (materialOf(createPublicKey(issuerKey.publicKeyPem)) === material) refuse('The receipt key is a trusted issuer key; an executor key is never an authority key.');
  }
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

  function signExecutorReceipt(reservation: StoredExecutorReceipt): Readonly<Record<string, string>> {
    const branded = isExecutorReceiptReservation(reservation);
    if (!branded) throw new ExecutorReceiptSignerError('Only a reservation of the receipt ledger is signed.');
    const receipt = reservation.receipt;
    if (receipt.executorId !== executorId || receipt.executorKeyId !== keyId) throw new ExecutorReceiptSignerError('The reservation names another executor or key.');
    const bytes = executorReceiptSigningBytes(receipt);
    if (bytes.toString('utf8') !== `${EXECUTOR_RECEIPT_SIGNING_DOMAIN}${reservation.canonical}`) throw new ExecutorReceiptSignerError('The reservation text is not the canonical receipt.');
    const signature = sign(null, bytes, privateKey);
    if (!verify(null, bytes, publicKey, signature)) throw new ExecutorReceiptSignerError('The receipt signature did not verify.');
    return Object.freeze({ algorithm: 'ed25519-v1', artifactVersion: AUTHORITY_ARTIFACT_VERSION, keyId, signature: signature.toString('base64url') });
  }

  return Object.freeze({ executorId, keyId, publicKeyPem, signExecutorReceipt });
}
