import {
  STATUS_HISTORY_BOOTSTRAP_EVIDENCE_SCHEMA,
  STATUS_HISTORY_BOOTSTRAP_MAX_REQUEST_LIFETIME_SECONDS,
  STATUS_SOURCE_CLASSES,
  bootstrapBindingDigest,
  bootstrapBindingOf,
  canonicalInstant,
  isDigest,
  isIdentifier,
  parseStatusHistoryBootstrapRequest,
  readPlain,
  readSources,
  readStatusReference,
} from './bootstrap-contract.js';
import type {
  StatusHistoryBootstrapAuthorizer,
  StatusHistoryBootstrapEvidence,
  StatusHistoryBootstrapEvidenceDraft,
  StatusHistoryBootstrapReason,
  StatusHistoryBootstrapRequest,
  StatusReference,
  StatusSourceClass,
  StatusSourcePolicy,
  StatusSourceVerifier,
} from './bootstrap-contract.js';
import type { SovereignStatusHighWaterMark, SovereignStatusHistoryKey, SqliteStatusHighWaterMarkStore } from './sqlite-status-high-water-mark-store.js';

/**
 * FV-P4C-2B1 — the fail-closed coordinator of a trusted bootstrap.
 *
 * It grants nothing itself. A history is anchored only when, in order:
 * 1. **Request.** The request is well formed, unexpired and unused, and names
 *    this store's namespace and the subject the host verified.
 * 2. **Status.** The status verifies (FV-P4B, injected) and is exactly the one
 *    the request names.
 * 3. **Authority.** The injected authorizer authorizes exactly this request's
 *    binding.
 * 4. **Source.** Every injected source attestation is of a class the host's
 *    policy accepts, recent, in agreement with the others, and names this very
 *    status as the latest it knows.
 * 5. **History.** The receiver's own `establishStatusHistory` accepts the
 *    transition. Its write goes through `compareAndSetWithEvidence`, so the
 *    mark and the evidence record commit together, or neither does.
 *
 * Nothing here clears a conflict, reopens a withdrawal, revives retired terms
 * or lowers a history: those refusals belong to `establishStatusHistory` and
 * to the store, and the coordinator offers no option around them. It has no
 * endpoint, no CLI and no reset, and a committed bootstrap authorizes no
 * document operation (S9).
 *
 * The receiver functions are injected because this Host module may not import
 * the portable receiver package; the composition passes the package's own
 * `verifySovereignStatus` and `establishStatusHistory`.
 */

export const STATUS_HISTORY_BOOTSTRAP_COORDINATOR = 'frontera.sovereign-status-bootstrap-coordinator/1' as const;

/** The two receiver functions the coordinator relies on, structurally (the package's own). */
export interface StatusHistoryReceiverPort {
  verifySovereignStatus(signedStatusText: unknown, trustedContext: unknown): Promise<unknown>;
  establishStatusHistory(signedStatusText: unknown, bootstrapContext: unknown): Promise<unknown>;
}

/** Everything here is the host's own, trusted configuration and services; nothing comes from a request. */
export interface StatusHistoryBootstrapContext {
  readonly store: SqliteStatusHighWaterMarkStore;
  /** What the host itself verified about the asset (RSDK-01 / FV-P2). */
  readonly trustedSubject: { readonly sovereignAssetId: string; readonly registrant: string; readonly manifestDigest: string };
  /** The host's trusted clock at this operation. */
  readonly evaluationTime: string;
  /** The host's identifier for this operation, recorded in the evidence. */
  readonly operationId: string;
  readonly verificationKeyResolver: unknown;
  readonly receiver: StatusHistoryReceiverPort;
  readonly authorizer: StatusHistoryBootstrapAuthorizer;
  readonly sourceVerifier: StatusSourceVerifier;
  readonly sourcePolicy: StatusSourcePolicy;
}

export interface StatusHistoryBootstrapResult {
  readonly coordinator: typeof STATUS_HISTORY_BOOTSTRAP_COORDINATOR;
  readonly outcome: 'established' | 'refused';
  readonly reason: StatusHistoryBootstrapReason;
  /** The receiver's own reason when the history transition was refused, or the status verifier's when the status was. */
  readonly detail: string | null;
  readonly requestId: string | null;
  readonly operationId: string | null;
  /** The evidence committed with the history; `null` unless established. */
  readonly evidence: StatusHistoryBootstrapEvidence | null;
  /** A bootstrap anchors trust in a history. It authorizes no document operation and executes nothing. */
  readonly documentAuthorization: 'not_evaluated';
  readonly execution: 'not_performed';
}

interface Known {
  requestId: string | null;
  operationId: string | null;
}

export async function coordinateStatusHistoryBootstrap(rawRequest: unknown, signedStatusText: unknown, rawContext: unknown): Promise<StatusHistoryBootstrapResult> {
  const known: Known = { requestId: null, operationId: null };
  try {
    return await coordinate(rawRequest, signedStatusText, rawContext, known);
  } catch {
    return result('refused', 'BOOTSTRAP_ERROR', known);
  }
}

async function coordinate(rawRequest: unknown, signedStatusText: unknown, rawContext: unknown, known: Known): Promise<StatusHistoryBootstrapResult> {
  const context = readContext(rawContext);
  if (context === undefined) return result('refused', 'CONTEXT_INVALID', known);
  known.operationId = context.operationId;
  const now = canonicalInstant(context.evaluationTime)!;

  // 1. The request: its form, its lifetime, its scope, its uniqueness.
  const request = parseStatusHistoryBootstrapRequest(rawRequest);
  if (request === undefined) return result('refused', 'REQUEST_INVALID', known);
  known.requestId = request.requestId;
  const createdAt = canonicalInstant(request.createdAt)!;
  const expiresAt = canonicalInstant(request.expiresAt)!;
  if (expiresAt <= createdAt || expiresAt - createdAt > BigInt(STATUS_HISTORY_BOOTSTRAP_MAX_REQUEST_LIFETIME_SECONDS) * 1_000_000_000n) {
    return result('refused', 'REQUEST_INVALID', known);
  }
  if (now < createdAt) return result('refused', 'REQUEST_NOT_YET_VALID', known);
  if (now >= expiresAt) return result('refused', 'REQUEST_EXPIRED', known);
  if (request.namespace !== context.store.namespace) return result('refused', 'NAMESPACE_MISMATCH', known);
  const subject = context.trustedSubject;
  if (request.sovereignAssetId !== subject.sovereignAssetId || request.issuer !== subject.registrant || request.manifestDigest !== subject.manifestDigest) {
    return result('refused', 'SUBJECT_MISMATCH', known);
  }
  const key: SovereignStatusHistoryKey = { sovereignAssetId: request.sovereignAssetId, issuer: request.issuer };
  let replayed: boolean;
  let existing: Awaited<ReturnType<SqliteStatusHighWaterMarkStore['read']>>;
  try {
    replayed = await context.store.hasBootstrapRequest(request.requestId);
    // R2: an unreadable or inconsistent history throws here and is never treated as empty.
    existing = await context.store.read(key);
  } catch {
    return result('refused', 'HISTORY_STORE_UNAVAILABLE', known);
  }
  if (replayed) return result('refused', 'REQUEST_REPLAYED', known);
  if (request.operation === 'reanchor' && existing === undefined) return result('refused', 'HISTORY_REFUSED', known, 'NOT_ESTABLISHED');
  if (existing?.mark.conflict === true) return result('refused', 'HISTORY_REFUSED', known, 'CONFLICT_DETECTED');

  // 2. The status: authentic, authoritative, and exactly the one requested.
  const verified = readVerifiedStatus(await context.receiver.verifySovereignStatus(signedStatusText, {
    verificationKeyResolver: context.verificationKeyResolver,
    expectedSovereignAssetId: subject.sovereignAssetId,
    expectedRegistrant: subject.registrant,
    expectedManifestDigest: subject.manifestDigest,
    evaluationTime: context.evaluationTime,
  }));
  if (verified.ok === false) return result('refused', 'STATUS_REJECTED', known, verified.reason);
  const { status } = verified;
  const termsMatch = request.terms === null ? status.terms === null : status.terms !== null && status.terms.claimId === request.terms.claimId && status.terms.claimDigest === request.terms.claimDigest;
  if (status.sequence !== request.status.sequence || status.statusDigest !== request.status.statusDigest || !termsMatch) return result('refused', 'STATUS_MISMATCH', known);

  // 3. Authority: a decision about exactly this binding, from the host's authorizer only.
  const binding = bootstrapBindingOf(request);
  const bindingDigest = bootstrapBindingDigest(binding);
  let decision: unknown;
  try {
    decision = await context.authorizer.authorizeStatusHistoryBootstrap(binding, bindingDigest);
  } catch {
    return result('refused', 'AUTHORITY_UNAVAILABLE', known);
  }
  const authority = readPlain(decision, ['outcome', 'bindingDigest', 'authorityRef'], ['outcome']);
  if (authority === undefined || authority.get('outcome') !== 'authorized') return result('refused', 'OPERATOR_UNAUTHORIZED', known);
  const authorityRef = authority.get('authorityRef');
  if (authority.get('bindingDigest') !== bindingDigest || !isIdentifier(authorityRef, 512)) return result('refused', 'AUTHORITY_BINDING_INVALID', known);

  // 4. Currentness, by the host's policy: accepted classes, recent, unanimous, and nothing newer known.
  let attested: unknown;
  try {
    attested = await context.sourceVerifier.attestStatusSource({ namespace: request.namespace, sovereignAssetId: key.sovereignAssetId, issuer: key.issuer, status: { ...request.status } });
  } catch {
    return result('refused', 'SOURCE_UNAVAILABLE', known);
  }
  const sources = readAttestations(attested);
  if (sources === undefined) return result('refused', 'SOURCE_UNTRUSTED', known);
  for (const source of sources) {
    if (!context.sourcePolicy.acceptedSourceClasses.includes(source.sourceClass)) return result('refused', 'SOURCE_UNTRUSTED', known);
    const observedAt = canonicalInstant(source.observedAt)!;
    if (observedAt > now) return result('refused', 'SOURCE_UNTRUSTED', known);
    if (now - observedAt > BigInt(context.sourcePolicy.maxSourceAgeSeconds) * 1_000_000_000n) return result('refused', 'SOURCE_STALE', known);
  }
  const first = sources[0]!.status;
  if (sources.some((source) => source.status.sequence !== first.sequence || source.status.statusDigest !== first.statusDigest)) return result('refused', 'SOURCE_CONFLICT', known);
  if (first.sequence > request.status.sequence) return result('refused', 'SOURCE_REPORTS_NEWER', known);
  if (first.sequence !== request.status.sequence || first.statusDigest !== request.status.statusDigest) return result('refused', 'SOURCE_MISMATCH', known);

  // 5. The transition, by the receiver's own rules, with the evidence in the same transaction.
  const draft: StatusHistoryBootstrapEvidenceDraft = {
    schemaVersion: STATUS_HISTORY_BOOTSTRAP_EVIDENCE_SCHEMA,
    operationId: context.operationId,
    requestId: request.requestId,
    namespace: request.namespace,
    sovereignAssetId: key.sovereignAssetId,
    issuer: key.issuer,
    operation: request.operation,
    purpose: request.purpose,
    bindingDigest,
    operatorRef: request.operatorRef,
    authorityRef: authorityRef as string,
    sources: sources.map(({ sourceClass, sourceRef, observedAt }) => ({ sourceClass, sourceRef, observedAt })),
    status: { ...request.status },
    evaluationTime: context.evaluationTime,
    result: 'committed',
    classification: 'host-recorded-unsigned',
  };
  let committed: StatusHistoryBootstrapEvidence | undefined;
  const evidenceStore = {
    read: (k: SovereignStatusHistoryKey) => context.store.read(k),
    async compareAndSet(k: SovereignStatusHistoryKey, revision: number | null, next: SovereignStatusHighWaterMark): Promise<boolean> {
      const recorded = await context.store.compareAndSetWithEvidence(k, revision, next, draft);
      if (recorded === false) return false;
      committed = recorded;
      return true;
    },
  };
  const outcome = readPlain(
    await context.receiver.establishStatusHistory(signedStatusText, {
      verificationKeyResolver: context.verificationKeyResolver,
      historyStore: evidenceStore,
      expectedSovereignAssetId: subject.sovereignAssetId,
      expectedRegistrant: subject.registrant,
      expectedManifestDigest: subject.manifestDigest,
      evaluationTime: context.evaluationTime,
      ...(request.operation === 'reanchor' ? { reanchor: true } : {}),
    }),
    ['outcome', 'reason', 'statusRejection', 'mark'],
    ['outcome', 'reason'],
  );
  const reason = outcome?.get('reason');
  if (outcome?.get('outcome') === 'established' && committed !== undefined && reason === (request.operation === 'establish' ? 'ESTABLISHED' : 'REESTABLISHED')) {
    // Neither the receiver's report nor the store's return value is taken on its word: the store's own
    // committed state must show this request, this anchor and this transition.
    const confirmed = await confirmCommit(context.store, key, draft, committed);
    if (confirmed !== 'confirmed') return result('refused', confirmed, known);
    return result('established', reason as 'ESTABLISHED' | 'REESTABLISHED', known, null, committed);
  }
  if (reason === 'HISTORY_STORE_UNAVAILABLE' || reason === 'HISTORY_STORE_INVALID') return result('refused', 'HISTORY_STORE_UNAVAILABLE', known);
  // A commit without the expected outcome (or the reverse) cannot happen; if it ever did, it is not reported as success.
  return result('refused', 'HISTORY_REFUSED', known, typeof reason === 'string' ? reason : null);
}

/**
 * Re-reads the store after a reported commit.
 *
 * - **Evidence:** the returned evidence must be the draft's own: request, operation, binding, authority,
 *   sources, status and instant.
 * - **Request:** it must be recorded.
 * - **History:** it must carry this anchor, at or past the recorded transition. A later ordinary advance by
 *   a concurrent check may have moved it on, under the same anchor.
 *
 * This guards against an injected receiver or store that reports a commit it did not make. It cannot guard
 * against one that lies consistently.
 */
async function confirmCommit(
  store: SqliteStatusHighWaterMarkStore,
  key: SovereignStatusHistoryKey,
  draft: StatusHistoryBootstrapEvidenceDraft,
  committed: StatusHistoryBootstrapEvidence,
): Promise<'confirmed' | 'COMMIT_UNVERIFIED' | 'HISTORY_STORE_UNAVAILABLE'> {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  for (const field of ['schemaVersion', 'operationId', 'requestId', 'namespace', 'sovereignAssetId', 'issuer', 'operation', 'purpose', 'bindingDigest', 'operatorRef', 'authorityRef', 'sources', 'status', 'evaluationTime'] as const) {
    if (!same(committed[field], draft[field])) return 'COMMIT_UNVERIFIED';
  }
  if (committed.next.sequence !== draft.status.sequence || committed.next.statusDigest !== draft.status.statusDigest) return 'COMMIT_UNVERIFIED';
  let recorded: boolean;
  let entry: Awaited<ReturnType<SqliteStatusHighWaterMarkStore['read']>>;
  try {
    recorded = await store.hasBootstrapRequest(draft.requestId);
    entry = await store.read(key);
  } catch {
    return 'HISTORY_STORE_UNAVAILABLE';
  }
  if (recorded !== true || entry === undefined || entry.mark.anchoredAt !== draft.evaluationTime || entry.revision < committed.next.revision) return 'COMMIT_UNVERIFIED';
  if (entry.revision === committed.next.revision && (entry.mark.sequence !== committed.next.sequence || entry.mark.statusDigest !== committed.next.statusDigest)) return 'COMMIT_UNVERIFIED';
  return 'confirmed';
}

interface Context {
  readonly store: SqliteStatusHighWaterMarkStore;
  readonly trustedSubject: { readonly sovereignAssetId: string; readonly registrant: string; readonly manifestDigest: string };
  readonly evaluationTime: string;
  readonly operationId: string;
  readonly verificationKeyResolver: unknown;
  readonly receiver: StatusHistoryReceiverPort;
  readonly authorizer: StatusHistoryBootstrapAuthorizer;
  readonly sourceVerifier: StatusSourceVerifier;
  readonly sourcePolicy: StatusSourcePolicy;
}

const CONTEXT_KEYS = ['store', 'trustedSubject', 'evaluationTime', 'operationId', 'verificationKeyResolver', 'receiver', 'authorizer', 'sourceVerifier', 'sourcePolicy'] as const;

/** The host's context, read once; services are bound so a later read cannot swap them. */
function readContext(raw: unknown): Context | undefined {
  const fields = readPlain(raw, CONTEXT_KEYS, CONTEXT_KEYS);
  if (fields === undefined) return undefined;
  const evaluationTime = fields.get('evaluationTime');
  const operationId = fields.get('operationId');
  if (canonicalInstant(evaluationTime) === undefined || !isIdentifier(operationId, 256)) return undefined;
  const subject = readPlain(fields.get('trustedSubject'), ['sovereignAssetId', 'registrant', 'manifestDigest'], ['sovereignAssetId', 'registrant', 'manifestDigest']);
  if (subject === undefined || !isIdentifier(subject.get('sovereignAssetId'), 256) || !isIdentifier(subject.get('registrant'), 2048) || !isDigest(subject.get('manifestDigest'))) return undefined;
  const policy = readPlain(fields.get('sourcePolicy'), ['acceptedSourceClasses', 'maxSourceAgeSeconds'], ['acceptedSourceClasses', 'maxSourceAgeSeconds']);
  if (policy === undefined) return undefined;
  const classes = policy.get('acceptedSourceClasses');
  const maxAge = policy.get('maxSourceAgeSeconds');
  if (!Array.isArray(classes) || classes.length === 0 || !classes.every((c) => STATUS_SOURCE_CLASSES.includes(c as StatusSourceClass)) || new Set(classes).size !== classes.length) return undefined;
  if (typeof maxAge !== 'number' || !Number.isSafeInteger(maxAge) || maxAge < 1 || maxAge > 86_400) return undefined;
  const store = bind(fields.get('store'), ['read', 'compareAndSetWithEvidence', 'hasBootstrapRequest']);
  const receiver = bind(fields.get('receiver'), ['verifySovereignStatus', 'establishStatusHistory']);
  const authorizer = bind(fields.get('authorizer'), ['authorizeStatusHistoryBootstrap']);
  const sourceVerifier = bind(fields.get('sourceVerifier'), ['attestStatusSource']);
  if (store === undefined || receiver === undefined || authorizer === undefined || sourceVerifier === undefined) return undefined;
  const rawStore = fields.get('store') as { namespace?: unknown };
  let namespace: unknown;
  try {
    namespace = Reflect.get(rawStore, 'namespace');
  } catch {
    return undefined;
  }
  if (!isIdentifier(namespace, 256)) return undefined;
  return {
    store: { ...store, namespace } as unknown as SqliteStatusHighWaterMarkStore,
    trustedSubject: {
      sovereignAssetId: subject.get('sovereignAssetId') as string,
      registrant: subject.get('registrant') as string,
      manifestDigest: subject.get('manifestDigest') as string,
    },
    evaluationTime: evaluationTime as string,
    operationId: operationId as string,
    verificationKeyResolver: fields.get('verificationKeyResolver'),
    receiver: receiver as unknown as StatusHistoryReceiverPort,
    authorizer: authorizer as unknown as StatusHistoryBootstrapAuthorizer,
    sourceVerifier: sourceVerifier as unknown as StatusSourceVerifier,
    sourcePolicy: { acceptedSourceClasses: [...(classes as StatusSourceClass[])], maxSourceAgeSeconds: maxAge },
  };
}

function bind(value: unknown, names: readonly string[]): Record<string, (...args: unknown[]) => unknown> | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const bound: Record<string, (...args: unknown[]) => unknown> = {};
  for (const name of names) {
    let method: unknown;
    try {
      method = Reflect.get(value, name);
    } catch {
      return undefined;
    }
    if (typeof method !== 'function') return undefined;
    const fn = method as (...args: unknown[]) => unknown;
    bound[name] = (...args: unknown[]) => Reflect.apply(fn, value, args);
  }
  return bound;
}

type Verified =
  | { readonly ok: true; readonly status: StatusReference & { readonly terms: { readonly claimId: string; readonly claimDigest: string } | null } }
  | { readonly ok: false; readonly reason: string | null };

/** Reads the receiver's verification result; anything but an `authentic_authorized` result is a rejection. */
function readVerifiedStatus(value: unknown): Verified {
  if (typeof value !== 'object' || value === null) return { ok: false, reason: null };
  const record = value as Record<string, unknown>;
  if (record['outcome'] !== 'authentic_authorized') return { ok: false, reason: typeof record['reason'] === 'string' ? record['reason'] : null };
  const status = readStatusReference({ sequence: record['sequence'], statusDigest: record['statusDigest'] });
  const terms = record['currentTerms'];
  const parsedTerms = terms === null ? null : readPlain(terms, ['claimId', 'claimDigest'], ['claimId', 'claimDigest']);
  if (status === undefined || parsedTerms === undefined) return { ok: false, reason: null };
  return {
    ok: true,
    status: { ...status, terms: parsedTerms === null ? null : { claimId: parsedTerms.get('claimId') as string, claimDigest: parsedTerms.get('claimDigest') as string } },
  };
}

/** One or more attestations, each a closed shape; a single attestation may be given bare. */
function readAttestations(value: unknown): Array<{ sourceClass: StatusSourceClass; sourceRef: string; observedAt: string; status: StatusReference }> | undefined {
  const list = Array.isArray(value) ? value : [value];
  if (Reflect.getPrototypeOf(list) !== Array.prototype) return undefined;
  const statuses: StatusReference[] = [];
  const stripped: unknown[] = [];
  for (const item of list) {
    const fields = readPlain(item, ['sourceClass', 'sourceRef', 'observedAt', 'status'], ['sourceClass', 'sourceRef', 'observedAt', 'status']);
    if (fields === undefined) return undefined;
    const status = readStatusReference(fields.get('status'));
    if (status === undefined) return undefined;
    statuses.push(status);
    stripped.push({ sourceClass: fields.get('sourceClass'), sourceRef: fields.get('sourceRef'), observedAt: fields.get('observedAt') });
  }
  const sources = readSources(stripped);
  if (sources === undefined) return undefined;
  return sources.map((source, index) => ({ ...source, status: statuses[index]! }));
}

function result(
  outcome: 'established' | 'refused',
  reason: StatusHistoryBootstrapReason,
  known: Known,
  detail: string | null = null,
  evidence: StatusHistoryBootstrapEvidence | null = null,
): StatusHistoryBootstrapResult {
  return Object.freeze({
    coordinator: STATUS_HISTORY_BOOTSTRAP_COORDINATOR,
    outcome,
    reason,
    detail,
    requestId: known.requestId,
    operationId: known.operationId,
    evidence,
    documentAuthorization: 'not_evaluated',
    execution: 'not_performed',
  });
}
