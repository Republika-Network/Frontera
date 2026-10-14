import { createHash, timingSafeEqual } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync, type Stats } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { ECDSA, Wallet } from 'xrpl';

import {
  DELEGATED_OFFER_SIGNER_OPERATION,
  DELEGATED_OFFER_SIGNER_PATHS,
  DELEGATED_OFFER_SIGNER_PROTOCOL,
  delegatedOfferPairKey,
  isDelegatedOfferAccount,
  isDelegatedOfferSignerId,
  parseDelegatedOfferSigningRequest,
  type DelegatedOfferNetwork,
  type DelegatedOfferSignerIdentity,
  type DelegatedOfferSignerPair,
} from '../delegated-offer-protocol.js';
import { verifySignedDelegatedOffer } from '../delegated-offer-verification.js';

/**
 * TRADE-04B — the **reference** delegated OfferCreate signer.
 *
 * NOT an HSM, NOT a KMS, NOT hardware-backed, NOT a custody certification and
 * NOT for unattended institutional custody. A separate process that holds
 * disposable XRPL **delegate** keys in a file (mode 0600, its alone) and
 * answers `frontera.xrpl-delegated-offer-signer.v1`, for development and for
 * isolated Testnet qualification: it lets the Host be qualified with no
 * trading key anywhere in the Host process.
 *
 * - It signs exactly one shape: the closed, single-signed delegated
 *   `OfferCreate`, as the delegate of a configured owner, for its configured
 *   network (`parseDelegatedOfferSigningRequest` and the static restrictions
 *   below refuse anything else **before** a key is touched). No raw bytes, no
 *   other transaction type, no multisigning, no algorithm choice, no key
 *   export route.
 * - It never holds an **owner** key: owners delegate on the ledger (XLS-75);
 *   the reference holds only delegate keys.
 * - It never connects to XRPL, reads no ledger state and submits nothing: it
 *   imports the SDK's `Wallet` only.
 * - It decides nothing. Its access control is its bearer credential; its
 *   restrictions (pair, network, fee ceiling, `LastLedgerSequence` horizon
 *   when a trusted ledger reference is injected, `Expiration` against its
 *   clock) are defence in depth, never governance.
 * - Plain HTTP, literal loopback only.
 *
 * Never composed into the Host: the Host reaches it only over the protocol,
 * by endpoint (`trade04b-protected-signer-structure.test.ts`).
 */

/** One delegate key the service holds, for one owner. The seed comes from this service's own key file, never from the Host. */
export interface ReferenceDelegatedOfferKey {
  readonly ownerAccount: string;
  readonly delegateSeed: string;
}

export interface ReferenceDelegatedOfferSignerOptions {
  readonly signerId: string;
  readonly network: DelegatedOfferNetwork;
  readonly credential: string;
  readonly keys: readonly ReferenceDelegatedOfferKey[];
  /** The signer's own fee ceiling, in drops. Defence in depth; never a substitute for the authority's monetary controls. */
  readonly maximumFeeDrops: string;
  /** Upper bound on `LastLedgerSequence − reference`, applied only when `ledgerReference` is injected. */
  readonly maximumLedgerHorizon?: number;
  /**
   * A **trusted, injected** validated ledger index, or `undefined` when none is
   * known. Absent, the horizon check is deferred: the reference never estimates
   * a ledger position from its clock and never reads the ledger itself.
   */
  readonly ledgerReference?: () => number | undefined;
  /** Wall clock (ms since the Unix epoch) for the `Expiration` check. Absent, that check is deferred. */
  readonly clock?: () => number;
}

/** What the service answers for one request: a status and a closed body. */
export interface ReferenceSignerAnswer {
  readonly status: number;
  readonly body: unknown;
}

export interface ReferenceDelegatedOfferSignerService {
  /** The protocol, transport-free: method, path, presented `authorization`, `content-type` and raw body. Used by the HTTP handler and by in-process qualification. */
  answer(request: { readonly method: string; readonly path: string; readonly authorization: unknown; readonly contentType: unknown; readonly body: Buffer }): ReferenceSignerAnswer;
  handle(req: IncomingMessage, res: ServerResponse): void;
  readonly identity: DelegatedOfferSignerIdentity;
  /** Signatures produced. A count only. */
  signatures(): number;
}

export const REFERENCE_DELEGATED_OFFER_SIGNER_LIMITS = Object.freeze({
  maximumRequestBytes: 16 * 1024,
  maximumFeeDrops: 1_000_000n,
  maximumLedgerHorizon: Object.freeze({ minimum: 1, maximum: 1_000, default: 20 }),
  /** Request ids remembered to refuse a replayed request. */
  rememberedRequestIds: 4_096,
});

/** Seconds between the Unix epoch and the XRPL (Ripple) epoch, 2000-01-01T00:00:00Z. */
const RIPPLE_EPOCH_OFFSET_SECONDS = 946_684_800;
const FEE_DROPS = /^[1-9][0-9]{0,15}$/;

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

const refusal = (status: number, error: string): ReferenceSignerAnswer => ({ status, body: { error } });

export function createReferenceDelegatedOfferSignerService(options: ReferenceDelegatedOfferSignerOptions): ReferenceDelegatedOfferSignerService {
  if (!isDelegatedOfferSignerId(options?.signerId)) throw new Error('The reference delegated offer signer needs a recordable signer id.');
  if (options.network !== 'xrp-ledger-testnet' && options.network !== 'xrp-ledger-devnet') throw new Error('The reference delegated offer signer serves XRPL Testnet or Devnet only.');
  if (typeof options.credential !== 'string' || options.credential.length < 32 || /\s/.test(options.credential)) throw new Error('The reference delegated offer signer needs a credential of at least 32 characters without whitespace.');
  if (typeof options.maximumFeeDrops !== 'string' || !FEE_DROPS.test(options.maximumFeeDrops) || BigInt(options.maximumFeeDrops) > REFERENCE_DELEGATED_OFFER_SIGNER_LIMITS.maximumFeeDrops) throw new Error('The reference delegated offer signer fee ceiling must be a positive whole number of drops, at most 1 XRP.');
  const horizonLimits = REFERENCE_DELEGATED_OFFER_SIGNER_LIMITS.maximumLedgerHorizon;
  const maximumLedgerHorizon = options.maximumLedgerHorizon ?? horizonLimits.default;
  if (!Number.isSafeInteger(maximumLedgerHorizon) || maximumLedgerHorizon < horizonLimits.minimum || maximumLedgerHorizon > horizonLimits.maximum) throw new Error('The reference delegated offer signer ledger horizon is out of bounds.');
  if (!Array.isArray(options.keys) || options.keys.length === 0 || options.keys.length > 64) throw new Error('The reference delegated offer signer needs 1 to 64 delegate keys.');
  const maximumFeeDrops = BigInt(options.maximumFeeDrops);

  const wallets = new Map<string, { readonly wallet: Wallet; readonly pair: DelegatedOfferSignerPair }>();
  for (const key of options.keys) {
    if (!isDelegatedOfferAccount(key?.ownerAccount)) throw new Error('A reference delegated offer key names no valid owner account.');
    let wallet: Wallet;
    try {
      wallet = Wallet.fromSeed(key.delegateSeed);
    } catch {
      throw new Error('A reference delegated offer key file entry does not hold a valid delegate key.');
    }
    if (wallet.classicAddress === key.ownerAccount) throw new Error('A reference delegate key is the owner account’s own key; the reference holds delegate keys only.');
    const pair = Object.freeze({ ownerAccount: key.ownerAccount, delegateAccount: wallet.classicAddress, signingPublicKey: wallet.publicKey });
    if (wallets.has(delegatedOfferPairKey(pair))) throw new Error('The reference delegated offer signer holds one owner/delegate pair twice.');
    wallets.set(delegatedOfferPairKey(pair), { wallet, pair });
  }

  const expected = digest(`Bearer ${options.credential}`);
  const identity: DelegatedOfferSignerIdentity = Object.freeze({
    protocol: DELEGATED_OFFER_SIGNER_PROTOCOL,
    signerId: options.signerId,
    operations: Object.freeze([DELEGATED_OFFER_SIGNER_OPERATION] as const),
    network: options.network,
    pairs: Object.freeze([...wallets.values()].map((entry) => entry.pair)),
  });
  const seenRequestIds = new Set<string>();
  let signatures = 0;

  const authenticated = (presented: unknown): boolean => typeof presented === 'string' && timingSafeEqual(digest(presented), expected);

  function sign(body: Buffer): ReferenceSignerAnswer {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      return refusal(400, 'not-json');
    }
    const request = parseDelegatedOfferSigningRequest(parsed);
    // Exactly the closed delegated OfferCreate, for this signer, network and a held pair — or no key is touched.
    if (request === undefined || request.signerId !== options.signerId) return refusal(422, 'not-signable');
    if (request.network !== options.network) return refusal(422, 'wrong-network');
    const held = wallets.get(delegatedOfferPairKey(request));
    if (held === undefined) return refusal(422, 'pair-not-held');
    if (seenRequestIds.has(request.requestId)) return refusal(409, 'request-replayed');
    const tx = request.transaction;
    if (BigInt(tx.Fee) > maximumFeeDrops) return refusal(422, 'fee-above-ceiling');
    const reference = options.ledgerReference?.();
    if (reference !== undefined && (!Number.isSafeInteger(reference) || reference < 1 || tx.LastLedgerSequence <= reference || tx.LastLedgerSequence > reference + maximumLedgerHorizon)) return refusal(422, 'ledger-horizon');
    if (options.clock !== undefined && tx.Expiration !== undefined && tx.Expiration <= Math.floor(options.clock() / 1000) - RIPPLE_EPOCH_OFFSET_SECONDS) return refusal(422, 'expired');
    seenRequestIds.add(request.requestId);
    if (seenRequestIds.size > REFERENCE_DELEGATED_OFFER_SIGNER_LIMITS.rememberedRequestIds) seenRequestIds.delete(seenRequestIds.values().next().value as string);
    let signed: { readonly tx_blob: string; readonly hash: string };
    try {
      // A plain copy: the SDK never sees the frozen parse result, and is handed nothing the parser did not accept.
      signed = held.wallet.sign(JSON.parse(JSON.stringify(tx)) as Parameters<Wallet['sign']>[0]);
    } catch {
      return refusal(500, 'signing-failed');
    }
    // The reference checks its own output exactly as the Host will before answering.
    if (!verifySignedDelegatedOffer({ prepared: tx, pair: held.pair, signedTransaction: signed.tx_blob, hash: signed.hash }).verified) return refusal(500, 'signing-failed');
    signatures += 1;
    return {
      status: 200,
      body: { protocol: DELEGATED_OFFER_SIGNER_PROTOCOL, signerId: options.signerId, requestId: request.requestId, ownerAccount: held.pair.ownerAccount, delegateAccount: held.pair.delegateAccount, signedTransaction: signed.tx_blob, hash: signed.hash },
    };
  }

  function answer(request: { readonly method: string; readonly path: string; readonly authorization: unknown; readonly contentType: unknown; readonly body: Buffer }): ReferenceSignerAnswer {
    if (!authenticated(request.authorization)) return refusal(401, 'unauthenticated');
    if (request.path === DELEGATED_OFFER_SIGNER_PATHS.identity) return request.method === 'GET' ? { status: 200, body: identity } : refusal(405, 'method-not-allowed');
    if (request.path !== DELEGATED_OFFER_SIGNER_PATHS.signDelegatedOffer) return refusal(404, 'not-found');
    if (request.method !== 'POST') return refusal(405, 'method-not-allowed');
    if (typeof request.contentType !== 'string' || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.contentType)) return refusal(415, 'not-json');
    if (request.body.length > REFERENCE_DELEGATED_OFFER_SIGNER_LIMITS.maximumRequestBytes) return refusal(413, 'too-large');
    return sign(request.body);
  }

  function respond(res: ServerResponse, { status, body }: ReferenceSignerAnswer): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'cache-control': 'no-store' });
    res.end(payload);
  }

  function handle(req: IncomingMessage, res: ServerResponse): void {
    const path = (req.url ?? '').split('?')[0] ?? '';
    const head = { method: req.method ?? '', path, authorization: req.headers.authorization, contentType: req.headers['content-type'] };
    // Authentication and routing first: an unauthenticated or misrouted body is never buffered.
    if (!authenticated(head.authorization) || path !== DELEGATED_OFFER_SIGNER_PATHS.signDelegatedOffer || req.method !== 'POST') {
      req.resume();
      return respond(res, answer({ ...head, body: Buffer.alloc(0) }));
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let refused = false;
    req.on('data', (chunk: Buffer) => {
      if (refused) return;
      size += chunk.length;
      if (size > REFERENCE_DELEGATED_OFFER_SIGNER_LIMITS.maximumRequestBytes) {
        refused = true;
        respond(res, refusal(413, 'too-large'));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!refused) respond(res, answer({ ...head, body: Buffer.concat(chunks) }));
    });
  }

  return Object.freeze({ answer, handle, identity, signatures: () => signatures });
}

/** A literal loopback address: `127.0.0.0/8` or `::1`. Names (`localhost`) and wildcards (`0.0.0.0`, `::`) are refused. */
export function isReferenceSignerLoopbackHost(host: unknown): boolean {
  return host === '::1' || (typeof host === 'string' && /^127\.(?:25[0-5]|2[0-4]\d|1?\d?\d)\.(?:25[0-5]|2[0-4]\d|1?\d?\d)\.(?:25[0-5]|2[0-4]\d|1?\d?\d)$/.test(host));
}

/** Starts the reference service on a literal loopback address; any other bind is refused before a socket is opened. */
export async function startReferenceDelegatedOfferSigner(
  options: ReferenceDelegatedOfferSignerOptions & { readonly host?: string; readonly port?: number },
): Promise<{ readonly server: Server; readonly port: number; readonly host: string; readonly identity: DelegatedOfferSignerIdentity; signatures(): number; close(): Promise<void> }> {
  const host = options.host ?? '127.0.0.1';
  if (!isReferenceSignerLoopbackHost(host)) throw new Error('The reference delegated offer signer binds a literal loopback address only.');
  const service = createReferenceDelegatedOfferSignerService(options);
  const server = createServer((req, res) => service.handle(req, res));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, () => resolve());
  });
  return {
    server,
    port: (server.address() as AddressInfo).port,
    host,
    identity: service.identity,
    signatures: service.signatures,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

// ── Key file custody ─────────────────────────────────────────────────────────

export const REFERENCE_DELEGATED_OFFER_KEY_FILE_FORMAT = 'frontera.reference-xrpl-delegated-offer-signer-key.v1';
export const REFERENCE_DELEGATED_OFFER_PUBLIC_IDENTITY_FORMAT = 'frontera.reference-xrpl-delegated-offer-signer-identity.v1';

/**
 * Why a key file's metadata does not show exclusive custody, or `undefined`.
 * A regular file (never a symlink), owned by this process's user, with no
 * group or other permission bit. On a filesystem that cannot enforce Unix
 * permissions (Windows drives under WSL report every file as `0777`) this is
 * never `undefined`: put the key on a Linux filesystem.
 */
export function referenceKeyFileModeProblem(stats: Pick<Stats, 'mode' | 'uid'> & { isFile(): boolean; isSymbolicLink(): boolean }, uid: number | undefined): string | undefined {
  if (stats.isSymbolicLink()) return 'is a symbolic link';
  if (!stats.isFile()) return 'is not a regular file';
  if (uid === undefined) return 'cannot be checked for ownership on this platform';
  if (stats.uid !== uid) return 'is not owned by this process’s user';
  if ((stats.mode & 0o077) !== 0) return 'is readable or writable by other users, or sits on a filesystem that cannot enforce Unix permissions (mode must be 0600)';
  return undefined;
}

const currentUid = (): number | undefined => (typeof process.getuid === 'function' ? process.getuid() : undefined);

export interface ReferenceDelegatedOfferKeyFile {
  readonly network: DelegatedOfferNetwork;
  readonly keys: readonly ReferenceDelegatedOfferKey[];
  /** Public only: what the operator pins in the Host. */
  readonly pairs: readonly DelegatedOfferSignerPair[];
}

/**
 * Creates a new reference key file — explicitly, never as a side effect of
 * loading: one fresh, disposable delegate key per owner, written with
 * create-only semantics (an existing file is never overwritten) at mode 0600,
 * then re-checked. If the filesystem did not enforce the mode, the file is
 * removed and creation is refused. The **public** identity (owner, delegate,
 * signing public key per pair) is written to `<path>.pub`, also create-only,
 * for the operator to pin. Nothing secret is returned beyond the file itself.
 */
export function createReferenceDelegatedOfferKeyFile(path: string, options: { readonly network: DelegatedOfferNetwork; readonly ownerAccounts: readonly string[]; readonly algorithm?: 'ed25519' | 'secp256k1' }): { readonly pairs: readonly DelegatedOfferSignerPair[] } {
  if (options.network !== 'xrp-ledger-testnet' && options.network !== 'xrp-ledger-devnet') throw new Error('The reference delegated offer key file serves XRPL Testnet or Devnet only.');
  if (!Array.isArray(options.ownerAccounts) || options.ownerAccounts.length === 0 || options.ownerAccounts.length > 64) throw new Error('The reference delegated offer key file needs 1 to 64 owner accounts.');
  if (new Set(options.ownerAccounts).size !== options.ownerAccounts.length || !options.ownerAccounts.every(isDelegatedOfferAccount)) throw new Error('The reference delegated offer key file needs distinct, valid owner accounts.');
  const algorithm = options.algorithm ?? 'ed25519';
  if (algorithm !== 'ed25519' && algorithm !== 'secp256k1') throw new Error('The reference delegated offer key algorithm is ed25519 or secp256k1.');
  const generated = options.ownerAccounts.map((ownerAccount) => ({ ownerAccount, wallet: Wallet.generate(algorithm === 'ed25519' ? ECDSA.ed25519 : ECDSA.secp256k1) }));
  const pairs = generated.map(({ ownerAccount, wallet }) => Object.freeze({ ownerAccount, delegateAccount: wallet.classicAddress, signingPublicKey: wallet.publicKey }));
  const contents = JSON.stringify({ format: REFERENCE_DELEGATED_OFFER_KEY_FILE_FORMAT, network: options.network, keys: generated.map(({ ownerAccount, wallet }) => ({ ownerAccount, delegateSeed: wallet.seed })) });
  // 'wx': create-only — an existing file, or a symlink planted at the path, makes this fail; nothing is overwritten.
  const fd = openSync(path, 'wx', 0o600);
  let problem: string | undefined;
  try {
    problem = referenceKeyFileModeProblem(fstatSync(fd) as Stats & { isSymbolicLink(): boolean }, currentUid());
    if (problem === undefined) writeFileSync(fd, contents);
  } finally {
    closeSync(fd);
  }
  if (problem !== undefined) {
    unlinkSync(path);
    throw new Error(`The reference delegated offer key file ${problem}; refused, and nothing was kept.`);
  }
  writeFileSync(`${path}.pub`, `${JSON.stringify({ format: REFERENCE_DELEGATED_OFFER_PUBLIC_IDENTITY_FORMAT, network: options.network, pairs })}\n`, { mode: 0o644, flag: 'wx' });
  return Object.freeze({ pairs: Object.freeze(pairs) });
}

/**
 * Loads an existing reference key file. Refused — with a message naming the
 * rule, never the path's contents — when it is absent (never created here),
 * not exclusively this user's at mode 0600, not in the format, or holds an
 * entry whose delegate is its own owner.
 */
export function loadReferenceDelegatedOfferKeyFile(path: string): ReferenceDelegatedOfferKeyFile {
  let stats: Stats;
  try {
    stats = lstatSync(path);
  } catch {
    throw new Error('The reference delegated offer key file does not exist; create it explicitly first.');
  }
  const problem = referenceKeyFileModeProblem(stats, currentUid());
  if (problem !== undefined) throw new Error(`The reference delegated offer key file ${problem}.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error('The reference delegated offer key file is not readable JSON.');
  }
  const record = parsed as { readonly format?: unknown; readonly network?: unknown; readonly keys?: unknown } | null;
  if (record === null || typeof record !== 'object' || Object.keys(record).sort().join(',') !== 'format,keys,network' || record.format !== REFERENCE_DELEGATED_OFFER_KEY_FILE_FORMAT) throw new Error('The reference delegated offer key file is not in the reference format.');
  if (record.network !== 'xrp-ledger-testnet' && record.network !== 'xrp-ledger-devnet') throw new Error('The reference delegated offer key file names no Testnet or Devnet network.');
  if (!Array.isArray(record.keys) || record.keys.length === 0 || record.keys.length > 64) throw new Error('The reference delegated offer key file holds no keys.');
  const keys: ReferenceDelegatedOfferKey[] = [];
  const pairs: DelegatedOfferSignerPair[] = [];
  for (const entry of record.keys as unknown[]) {
    const key = entry as { readonly ownerAccount?: unknown; readonly delegateSeed?: unknown } | null;
    if (key === null || typeof key !== 'object' || Object.keys(key).sort().join(',') !== 'delegateSeed,ownerAccount' || !isDelegatedOfferAccount(key.ownerAccount) || typeof key.delegateSeed !== 'string') throw new Error('The reference delegated offer key file holds a malformed entry.');
    let wallet: Wallet;
    try {
      wallet = Wallet.fromSeed(key.delegateSeed);
    } catch {
      throw new Error('The reference delegated offer key file holds an entry that is not a valid key.');
    }
    if (wallet.classicAddress === key.ownerAccount) throw new Error('The reference delegated offer key file holds an owner’s own key.');
    keys.push(Object.freeze({ ownerAccount: key.ownerAccount, delegateSeed: key.delegateSeed }));
    pairs.push(Object.freeze({ ownerAccount: key.ownerAccount, delegateAccount: wallet.classicAddress, signingPublicKey: wallet.publicKey }));
  }
  return Object.freeze({ network: record.network, keys: Object.freeze(keys), pairs: Object.freeze(pairs) });
}
