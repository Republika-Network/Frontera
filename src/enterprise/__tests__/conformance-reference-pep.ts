import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';

/**
 * RN-CONFORM-04 — SYNTHETIC REFERENCE POLICY ENFORCEMENT POINT. TEST CODE ONLY.
 *
 * A Fileverse-*inspired* document-use enforcement point used to prove that the
 * continuous-conformance machinery detects an integration that bypasses its own
 * authorization. It is not a Fileverse integration, contacts nothing, holds only
 * synthetic documents (with sentinel bytes so a leak is detectable), and is
 * reachable from no Host, route, package export or configuration: it lives in
 * `src/enterprise/__tests__/` and nothing outside tests imports it (CC-D-12:
 * synthetic only).
 *
 * The PEP reaches its authorization and revocation dependencies only through
 * two ports. Conformance scenarios plug in {@link SyntheticDecisionAuthority};
 * `tests/conformance-reference-real-pipeline.e2e.test.mjs` plugs in an adapter
 * over the real FV-P2/P3/P4C decision functions of
 * `@aoc-enterprise/sovereign-receiver-verification`, so the same enforcement
 * order runs over the shipped document-use pipeline.
 *
 * The protected store is reachable only with a single-use capability that this
 * module mints **after** authorization. Defective variants (BYPASS-01..08) are
 * switches on a {@link ReferenceDeployment} fixture object and nowhere else.
 */

// ---------------------------------------------------------------------------
// Operations, ceilings and the defect catalogue.
// ---------------------------------------------------------------------------

export const REFERENCE_OPERATIONS = Object.freeze(['document.export', 'document.modify-protected-terms', 'document.open'] as const);
export type ReferenceOperation = (typeof REFERENCE_OPERATIONS)[number];
export const isReferenceOperation = (value: unknown): value is ReferenceOperation => typeof value === 'string' && (REFERENCE_OPERATIONS as readonly string[]).includes(value);

/** The FV-P3 action each operation is decided as (`DOCUMENT_USE_ACTIONS`). */
export const FV_ACTION_OF: Readonly<Record<ReferenceOperation, string>> = Object.freeze({
  'document.open': 'aoc.licensing:access',
  'document.export': 'soberania.document:export',
  'document.modify-protected-terms': 'soberania.document:modify-protected-terms',
});

/**
 * Decision freshness ceilings, restating `DOCUMENT_USE_FRESHNESS_CEILINGS` (access 86 400 s, export/modify 900 s). The
 * real-pipeline e2e test asserts they equal the package's constants. Profile-permitted maxima, not production guarantees.
 */
export const DECISION_CEILING_SECONDS: Readonly<Record<ReferenceOperation, number>> = Object.freeze({
  'document.open': 86_400,
  'document.export': 900,
  'document.modify-protected-terms': 900,
});

/** Proposed revocation propagation target `P_rev` (CR-02, ≤ 300 s). A synthetic parameter of this fixture, not a guarantee. */
export const REVOCATION_PROPAGATION_SECONDS = 300;

/** How long the PEP waits for its authorization dependency before failing closed (real milliseconds; kept short for tests). */
export const AUTHORITY_TIMEOUT_MS = 25;

export type ReferenceChallengeType = 'G01' | 'G02' | 'G03' | 'G04' | 'G05' | 'G06' | 'G07' | 'G08';

/** Deliberately defective fixture variants. Each names the challenge expected to detect it. */
export const BYPASS_VARIANTS = Object.freeze({
  'BYPASS-01': Object.freeze({ title: 'Missing authorization: the operation executes without obtaining or verifying a decision', challenge: 'G01', controlId: 'CR-01' }),
  'BYPASS-02': Object.freeze({ title: 'Revocation ignored: a previously authorized decision keeps working after effective revocation', challenge: 'G02', controlId: 'CR-02' }),
  'BYPASS-03': Object.freeze({ title: 'Alternate interface bypass: the batch interface omits authorization', challenge: 'G03', controlId: 'CR-03' }),
  'BYPASS-04': Object.freeze({ title: 'Storage retrieval bypass: the storage locator route serves protected bytes directly', challenge: 'G04', controlId: 'CR-04' }),
  'BYPASS-05': Object.freeze({ title: 'Stale authorization reuse: a decision is honoured past its freshness ceiling', challenge: 'G05', controlId: 'CR-05' }),
  'BYPASS-06': Object.freeze({ title: 'Cross-tenant substitution: a principal of one organization acts on another organization\'s document', challenge: 'G06', controlId: 'CR-06' }),
  'BYPASS-07': Object.freeze({ title: 'Fail-open dependency: an unavailable, slow or malformed authorization dependency lets the operation proceed', challenge: 'G07', controlId: 'CR-07' }),
  'BYPASS-08': Object.freeze({ title: 'Deployment/policy digest mismatch: the deployment runs a different adapter than the credentialed one', challenge: 'G08', controlId: 'CR-08' }),
} as const);
export type BypassId = keyof typeof BYPASS_VARIANTS;
export const BYPASS_IDS = Object.freeze(Object.keys(BYPASS_VARIANTS) as BypassId[]);

// ---------------------------------------------------------------------------
// Keys, canonical bytes, digests.
// ---------------------------------------------------------------------------

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** A deterministic Ed25519 TEST key for `label` (seed = sha256 of a public string). Never a real key; nothing is committed. */
export function referenceTestKey(label: string): KeyObject {
  const seed = createHash('sha256').update(`rn-conform-04:synthetic-test-key:${label}`).digest();
  return createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' });
}

/** The synthetic authorization dependency's signing key, and the public key the PEP trusts. */
export const AUTHORITY_KEY = referenceTestKey('reference-decision-authority');
export const AUTHORITY_PUBLIC_KEY_PEM = createPublicKey(AUTHORITY_KEY).export({ type: 'spki', format: 'pem' }).toString();
/** A key nobody trusts — what a forged decision is signed with. */
export const FORGER_KEY = referenceTestKey('reference-forger');

type Flat = Readonly<Record<string, string | number>>;
const canonicalFlat = (value: object): string => JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));
const sha256 = (text: string | Uint8Array): string => createHash('sha256').update(text).digest('hex');
export const referenceDigest = (value: Flat): string => `sha256:${sha256(canonicalFlat(value))}`;

// ---------------------------------------------------------------------------
// The synthetic world.
// ---------------------------------------------------------------------------

export const ORG_ALPHA = 'org-synthetic-alpha';
export const ORG_BETA = 'org-synthetic-beta';
/** Fixture time zero. Fixture time is the integration's own clock; validator wall time is the conformance clock. */
export const FIXTURE_T0_MS = Date.parse('2026-10-28T12:00:00.000Z');

export interface SyntheticPrincipal {
  readonly principalId: string;
  readonly organizationId: string;
  readonly roles: readonly string[];
}

export interface DocumentTerms {
  readonly claimId: string;
  readonly digest: string;
  /** Roles permitted per operation. Like FV terms audiences, rules name roles — never organizations. */
  readonly rules: Readonly<Record<ReferenceOperation, readonly string[]>>;
}

export interface SyntheticDocument {
  readonly documentId: string;
  readonly organizationId: string;
  readonly locator: string;
  readonly protectedDocument: boolean;
  readonly content: Uint8Array;
  readonly terms: DocumentTerms;
}

export interface ReferenceWorld {
  readonly principals: ReadonlyMap<string, SyntheticPrincipal>;
  readonly documents: ReadonlyMap<string, SyntheticDocument>;
}

/** The byte marker every synthetic document carries. Its presence in any output proves protected content escaped. */
export const SENTINEL_PREFIX = 'RN-CONFORM-04-SENTINEL';
export const sentinelOf = (documentId: string): string => `${SENTINEL_PREFIX}:${documentId}`;
export const containsSentinel = (bytes: Uint8Array | string | null | undefined): boolean =>
  bytes !== null && bytes !== undefined && Buffer.from(typeof bytes === 'string' ? bytes : Buffer.from(bytes)).toString('latin1').includes(SENTINEL_PREFIX);

const termsOf = (claimId: string, rules: DocumentTerms['rules']): DocumentTerms => Object.freeze({ claimId, rules, digest: referenceDigest({ claimId, rules: JSON.stringify(rules) }) });

const doc = (documentId: string, organizationId: string, protectedDocument: boolean, rules: DocumentTerms['rules']): SyntheticDocument =>
  Object.freeze({
    documentId,
    organizationId,
    locator: `synthetic-storage://${organizationId}/${documentId}`,
    protectedDocument,
    content: new Uint8Array(Buffer.from(`${sentinelOf(documentId)}\nSynthetic document body. No real content.\n`, 'utf8')),
    terms: termsOf(`claim:${documentId}:terms-1`, rules),
  });

/** Principals of each operation's probes. */
export const PRINCIPALS = Object.freeze({
  reader: 'alpha-reader',
  editor: 'alpha-editor',
  outsider: 'alpha-outsider',
  betaAgent: 'beta-agent',
});

export const DOCUMENTS = Object.freeze({ alphaContract: 'doc-alpha-contract', alphaNotice: 'doc-alpha-notice', betaContract: 'doc-beta-contract' });

/** The authorized principal for each operation on the protected alpha document. */
export const AUTHORIZED_FOR: Readonly<Record<ReferenceOperation, string>> = Object.freeze({
  'document.open': PRINCIPALS.reader,
  'document.export': PRINCIPALS.editor,
  'document.modify-protected-terms': PRINCIPALS.editor,
});

const PROTECTED_RULES: DocumentTerms['rules'] = Object.freeze({
  'document.open': Object.freeze(['reader', 'editor']),
  'document.export': Object.freeze(['editor']),
  'document.modify-protected-terms': Object.freeze(['owner']),
});

/** Two organizations, authorized and unauthorized principals, protected and unprotected documents. */
export function createReferenceWorld(): ReferenceWorld {
  const principals: SyntheticPrincipal[] = [
    { principalId: PRINCIPALS.reader, organizationId: ORG_ALPHA, roles: ['member', 'reader'] },
    { principalId: PRINCIPALS.editor, organizationId: ORG_ALPHA, roles: ['member', 'reader', 'editor', 'owner'] },
    { principalId: PRINCIPALS.outsider, organizationId: ORG_ALPHA, roles: ['member'] },
    // Holds every role — so the role-based authority (like FV, which carries no organization) would allow it anywhere.
    // Only the PEP's tenant binding stands between it and organization alpha's documents (CR-06).
    { principalId: PRINCIPALS.betaAgent, organizationId: ORG_BETA, roles: ['member', 'reader', 'editor', 'owner'] },
  ];
  const documents = [
    doc(DOCUMENTS.alphaContract, ORG_ALPHA, true, PROTECTED_RULES),
    doc(DOCUMENTS.alphaNotice, ORG_ALPHA, false, Object.freeze({ 'document.open': ['member'], 'document.export': ['member'], 'document.modify-protected-terms': ['owner'] })),
    doc(DOCUMENTS.betaContract, ORG_BETA, true, PROTECTED_RULES),
  ];
  return Object.freeze({
    principals: new Map(principals.map((p) => [p.principalId, Object.freeze({ ...p, roles: Object.freeze([...p.roles]) })])),
    documents: new Map(documents.map((d) => [d.documentId, d])),
  });
}

// ---------------------------------------------------------------------------
// Decisions and the two dependency ports.
// ---------------------------------------------------------------------------

export const DECISION_SCHEMA = 'rn.reference.document-use-decision/1' as const;

export interface ReferenceDecisionPayload {
  readonly schema: typeof DECISION_SCHEMA;
  readonly decisionId: string;
  readonly effect: 'ALLOW' | 'DENY';
  readonly reason: string;
  readonly principalId: string;
  readonly organizationId: string;
  readonly documentId: string;
  readonly operation: ReferenceOperation;
  readonly termsClaimId: string;
  readonly termsDigest: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
}

export interface SignedReferenceDecision {
  readonly payload: ReferenceDecisionPayload;
  readonly signature: string;
}

const DECISION_KEYS = ['decisionId', 'documentId', 'effect', 'expiresAtMs', 'issuedAtMs', 'operation', 'organizationId', 'principalId', 'reason', 'schema', 'termsClaimId', 'termsDigest'];

export function signReferenceDecision(payload: ReferenceDecisionPayload, key: KeyObject = AUTHORITY_KEY): SignedReferenceDecision {
  return Object.freeze({ payload: Object.freeze({ ...payload }), signature: sign(null, Buffer.from(canonicalFlat(payload), 'utf8'), key).toString('base64') });
}

/** Closed-shape check plus signature verification. Total: anything malformed is `undefined`. */
export function readSignedDecision(value: unknown, trustedPublicKeyPem: string): SignedReferenceDecision | undefined {
  try {
    // Read the caller's value exactly ONCE, into plain data. Everything below — shape checks, the signed bytes and the
    // returned payload — uses only this snapshot, so a getter or Proxy cannot show one value to verification and another
    // to use (review P2-1).
    const snapshot: unknown = JSON.parse(JSON.stringify(value));
    if (typeof snapshot !== 'object' || snapshot === null) return undefined;
    const outer = snapshot as Record<string, unknown>;
    if (Object.keys(outer).sort().join(',') !== 'payload,signature' || typeof outer['signature'] !== 'string') return undefined;
    const payload = outer['payload'];
    if (typeof payload !== 'object' || payload === null) return undefined;
    const p = payload as Record<string, unknown>;
    if (Object.keys(p).sort().join(',') !== DECISION_KEYS.join(',')) return undefined;
    if (p['schema'] !== DECISION_SCHEMA || (p['effect'] !== 'ALLOW' && p['effect'] !== 'DENY') || !isReferenceOperation(p['operation'])) return undefined;
    for (const k of ['decisionId', 'reason', 'principalId', 'organizationId', 'documentId', 'termsClaimId', 'termsDigest']) if (typeof p[k] !== 'string') return undefined;
    if (!Number.isSafeInteger(p['issuedAtMs']) || !Number.isSafeInteger(p['expiresAtMs'])) return undefined;
    const typed = p as unknown as ReferenceDecisionPayload;
    const ok = verify(null, Buffer.from(canonicalFlat(typed), 'utf8'), trustedPublicKeyPem, Buffer.from(outer['signature'] as string, 'base64'));
    return ok ? Object.freeze({ payload: Object.freeze({ ...typed }), signature: outer['signature'] as string }) : undefined;
  } catch {
    return undefined;
  }
}

export interface AuthorizationQuery {
  readonly principalId: string;
  readonly organizationId: string;
  readonly documentId: string;
  readonly operation: ReferenceOperation;
  readonly termsClaimId: string;
  readonly termsDigest: string;
}

/** What the authorization dependency answered. `decision` is untrusted until the PEP verifies it. */
export type AuthorityAnswer = { readonly kind: 'decision'; readonly decision: unknown } | { readonly kind: 'unavailable'; readonly detail: string };

/** The trusted authorization dependency (policy layer: eligibility + terms). */
export interface AuthorizationPort {
  decide(query: AuthorizationQuery): Promise<AuthorityAnswer>;
}

export type RevocationState = 'NOT_REVOKED' | 'REVOKED' | 'UNKNOWN';

/** The signed-status layer: whether the document's terms are currently revoked. Consulted on **every** operation. */
export interface RevocationPort {
  revocationOf(documentId: string, termsClaimId: string): Promise<RevocationState>;
}

export interface FixtureClock {
  ms(): number;
  advance(seconds: number): void;
  set(ms: number): void;
}

export function fixtureClock(startMs: number = FIXTURE_T0_MS): FixtureClock {
  let now = startMs;
  return { ms: () => now, advance: (seconds) => void (now += Math.round(seconds * 1000)), set: (ms) => void (now = ms) };
}

export type AuthorityMode = 'available' | 'unavailable' | 'timeout' | 'malformed';

let decisionCounter = 0;

/**
 * The deterministic synthetic authorization dependency. Like the FV-P3 evaluator it decides from the terms rules and the
 * principal's roles only — it carries no organization check — and like FV-P4C it reports revocation separately.
 */
export class SyntheticDecisionAuthority implements AuthorizationPort, RevocationPort {
  /** Fixture switch: how the dependency behaves. */
  mode: AuthorityMode = 'available';
  /** Fixture switch: whether revocation status can be determined. */
  revocationMode: 'reliable' | 'unknown' = 'reliable';
  readonly #revokedAt = new Map<string, number>();
  readonly calls: AuthorizationQuery[] = [];
  readonly #world: ReferenceWorld;
  readonly #clock: FixtureClock;
  readonly #key: KeyObject;

  constructor(world: ReferenceWorld, clock: FixtureClock, key: KeyObject = AUTHORITY_KEY) {
    this.#world = world;
    this.#clock = clock;
    this.#key = key;
  }

  async decide(query: AuthorizationQuery): Promise<AuthorityAnswer> {
    this.calls.push(query);
    if (this.mode === 'unavailable') return { kind: 'unavailable', detail: 'synthetic authorization dependency unavailable' };
    if (this.mode === 'timeout') return new Promise<AuthorityAnswer>(() => undefined);
    if (this.mode === 'malformed') return { kind: 'decision', decision: { effect: 'ALLOW', note: 'not a decision' } };
    const principal = this.#world.principals.get(query.principalId);
    const document = this.#world.documents.get(query.documentId);
    const permitted = principal !== undefined && document !== undefined && document.terms.claimId === query.termsClaimId && document.terms.digest === query.termsDigest && document.terms.rules[query.operation].some((role) => principal.roles.includes(role));
    const issuedAtMs = this.#clock.ms();
    decisionCounter += 1;
    return {
      kind: 'decision',
      decision: signReferenceDecision(
        {
          schema: DECISION_SCHEMA,
          decisionId: `dcs-${decisionCounter}`,
          effect: permitted ? 'ALLOW' : 'DENY',
          reason: permitted ? 'TERMS_PERMIT' : 'TERMS_DO_NOT_PERMIT',
          ...query,
          issuedAtMs,
          expiresAtMs: issuedAtMs + DECISION_CEILING_SECONDS[query.operation] * 1000,
        },
        this.#key,
      ),
    };
  }

  /** Effective revocation of a document's terms at fixture time `atMs`. */
  revoke(termsClaimId: string, atMs: number = this.#clock.ms()): void {
    this.#revokedAt.set(termsClaimId, atMs);
  }

  async revocationOf(_documentId: string, termsClaimId: string): Promise<RevocationState> {
    if (this.revocationMode === 'unknown') return 'UNKNOWN';
    const at = this.#revokedAt.get(termsClaimId);
    return at !== undefined && this.#clock.ms() >= at ? 'REVOKED' : 'NOT_REVOKED';
  }
}

// ---------------------------------------------------------------------------
// The protected resource port.
// ---------------------------------------------------------------------------

/** A single-use permission to perform one operation on one document, minted by the PEP only after authorization. */
interface OperationCapability {
  readonly documentId: string;
  readonly operation: ReferenceOperation;
  readonly decisionId: string;
}

const liveCapabilities = new WeakSet<OperationCapability>();
const mintCapability = (documentId: string, operation: ReferenceOperation, decisionId: string): OperationCapability => {
  const capability = Object.freeze({ documentId, operation, decisionId });
  liveCapabilities.add(capability);
  return capability;
};

export class StoreRefusal extends Error {
  readonly code: 'NO_CAPABILITY' | 'CAPABILITY_MISMATCH' | 'UNKNOWN_DOCUMENT';
  constructor(code: StoreRefusal['code']) {
    super(`Protected store refused: ${code}`);
    this.name = 'StoreRefusal';
    this.code = code;
  }
}

export interface StorageResponse {
  readonly status: number;
  readonly body: Uint8Array | null;
}

/** Every access the store saw, for tests that prove no protected byte was read or written before authorization. */
export interface StoreAccess {
  readonly kind: 'open' | 'export' | 'modify' | 'locator';
  readonly documentId: string;
  readonly served: boolean;
}

/** The synthetic document storage. Content is reachable only through a live capability; the locator route serves nothing. */
export class ProtectedDocumentStore {
  readonly #documents = new Map<string, SyntheticDocument>();
  readonly accesses: StoreAccess[] = [];

  constructor(world: ReferenceWorld) {
    for (const d of world.documents.values()) this.#documents.set(d.documentId, d);
  }

  /** Public metadata only — never content. */
  metadata(documentId: string): { readonly documentId: string; readonly organizationId: string; readonly locator: string; readonly termsClaimId: string; readonly termsDigest: string } | undefined {
    const d = this.#documents.get(documentId);
    return d === undefined ? undefined : Object.freeze({ documentId: d.documentId, organizationId: d.organizationId, locator: d.locator, termsClaimId: d.terms.claimId, termsDigest: d.terms.digest });
  }

  #consume(capability: OperationCapability, documentId: string, operation: ReferenceOperation): SyntheticDocument {
    if (!liveCapabilities.has(capability)) throw new StoreRefusal('NO_CAPABILITY');
    liveCapabilities.delete(capability);
    if (capability.documentId !== documentId || capability.operation !== operation) throw new StoreRefusal('CAPABILITY_MISMATCH');
    const d = this.#documents.get(documentId);
    if (d === undefined) throw new StoreRefusal('UNKNOWN_DOCUMENT');
    return d;
  }

  open(capability: OperationCapability, documentId: string): Uint8Array {
    const d = this.#consume(capability, documentId, 'document.open');
    this.accesses.push({ kind: 'open', documentId, served: true });
    return new Uint8Array(d.content);
  }

  /** The export is assembled whole after the capability is consumed: there is no partial stream to escape on failure. */
  export(capability: OperationCapability, documentId: string): Uint8Array {
    const d = this.#consume(capability, documentId, 'document.export');
    this.accesses.push({ kind: 'export', documentId, served: true });
    return new Uint8Array(Buffer.concat([Buffer.from(`synthetic-export:${documentId}\n`, 'utf8'), Buffer.from(d.content)]));
  }

  modifyProtectedTerms(capability: OperationCapability, documentId: string, newTermsDigest: string): { readonly previousTermsDigest: string; readonly newTermsDigest: string } {
    const d = this.#consume(capability, documentId, 'document.modify-protected-terms');
    this.accesses.push({ kind: 'modify', documentId, served: true });
    const updated = Object.freeze({ ...d, terms: Object.freeze({ ...d.terms, digest: newTermsDigest }) });
    this.#documents.set(documentId, updated);
    return Object.freeze({ previousTermsDigest: d.terms.digest, newTermsDigest });
  }

  /** The direct storage route (by locator). A conformant store serves nothing here. */
  retrieveByLocator(locator: string, defective = false): StorageResponse {
    const d = [...this.#documents.values()].find((x) => x.locator === locator);
    if (d === undefined) return { status: 404, body: null };
    this.accesses.push({ kind: 'locator', documentId: d.documentId, served: defective });
    return defective ? { status: 200, body: new Uint8Array(d.content) } : { status: 403, body: null };
  }

  /** TEST VISIBILITY: the current terms digest (to prove a denied modification committed nothing). */
  currentTermsDigest(documentId: string): string | undefined {
    return this.#documents.get(documentId)?.terms.digest;
  }
}

// ---------------------------------------------------------------------------
// The enforcement point.
// ---------------------------------------------------------------------------

export const PEP_DENIALS = Object.freeze([
  'MALFORMED_REQUEST',
  'UNKNOWN_PRINCIPAL',
  'PRINCIPAL_CONTEXT_MISMATCH',
  'UNKNOWN_DOCUMENT',
  'CROSS_ORGANIZATION',
  'TERMS_MISMATCH',
  'AUTHORITY_UNAVAILABLE',
  'DECISION_INVALID',
  'DECISION_BINDING_MISMATCH',
  'DECISION_FROM_FUTURE',
  'DECISION_STALE',
  'REVOKED',
  'REVOCATION_UNKNOWN',
  'NOT_PERMITTED',
] as const);
export type PepDenial = (typeof PEP_DENIALS)[number];

/** The ordered enforcement steps (mission WP-02). A trace records which ran, so tests can prove order. */
export type PepStep =
  | '1.request-schema'
  | '2.principal-context'
  | '3.resource-binding'
  | '4.policy-terms'
  | '5.decision-obtained'
  | '6.decision-verified'
  | '7.freshness-revocation'
  | '8.permission'
  | '9.resource-action'
  | '10.evidence';

export interface DocumentOperationRequest {
  readonly principalId: string;
  readonly organizationId: string;
  readonly documentId: string;
  readonly operation: ReferenceOperation;
  readonly termsDigest: string;
  /** A decision the caller carries (e.g. obtained earlier). Verified, never silently refreshed. */
  readonly decision?: unknown;
  /** For `document.modify-protected-terms`. */
  readonly newTermsDigest?: string;
}

export interface PepEvidence {
  readonly schema: 'rn.reference.pep-evidence/1';
  /** Digest of the minimal execution record: no content, no principal attributes. */
  readonly evidenceDigest: string;
  readonly steps: readonly PepStep[];
}

export type PepResult =
  | { readonly kind: 'content'; readonly bytes: Uint8Array }
  | { readonly kind: 'export'; readonly bytes: Uint8Array }
  | { readonly kind: 'terms-modified'; readonly previousTermsDigest: string; readonly newTermsDigest: string };

export type PepOutcome =
  | { readonly outcome: 'allowed'; readonly operation: ReferenceOperation; readonly documentId: string; readonly decisionId: string | null; readonly result: PepResult; readonly evidence: PepEvidence }
  | { readonly outcome: 'denied'; readonly operation: string | null; readonly documentId: string | null; readonly reason: PepDenial; readonly evidence: PepEvidence };

export interface PepPorts {
  readonly world: ReferenceWorld;
  readonly store: ProtectedDocumentStore;
  readonly authorization: AuthorizationPort;
  readonly revocation: RevocationPort;
  readonly clock: FixtureClock;
  readonly trustedAuthorityPublicKeyPem: string;
  /** Deadline for each dependency call (default {@link AUTHORITY_TIMEOUT_MS}); a slower real dependency may set more. */
  readonly authorityTimeoutMs?: number;
}

/** Which defects apply to this request: none, for the conformant PEP. */
type DefectProbe = (id: BypassId, operation: ReferenceOperation) => boolean;
const NO_DEFECTS: DefectProbe = () => false;

const REQUEST_KEYS = new Set(['principalId', 'organizationId', 'documentId', 'operation', 'termsDigest', 'decision', 'newTermsDigest']);

function readRequest(value: unknown): DocumentOperationRequest | undefined {
  // One read of the caller's object, into plain data; every later step uses the snapshot only (review P2-2).
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(JSON.stringify(value));
  } catch {
    return undefined;
  }
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) return undefined;
  const r = snapshot as Record<string, unknown>;
  if (!Object.keys(r).every((k) => REQUEST_KEYS.has(k))) return undefined;
  for (const k of ['principalId', 'organizationId', 'documentId', 'termsDigest']) if (typeof r[k] !== 'string' || (r[k] as string).length === 0 || (r[k] as string).length > 256) return undefined;
  if (!isReferenceOperation(r['operation'])) return undefined;
  if (r['operation'] === 'document.modify-protected-terms' ? typeof r['newTermsDigest'] !== 'string' : r['newTermsDigest'] !== undefined) return undefined;
  if (r['newTermsDigest'] !== undefined && (r['newTermsDigest'] as string).length > 256) return undefined;
  return Object.freeze(r) as unknown as DocumentOperationRequest;
}

/**
 * Calls a dependency with a deadline. A synchronous throw, a rejection, a non-promise answer or a missed deadline all
 * become `fallback` — never an exception escaping the PEP (review P3-1).
 */
async function guarded<T>(call: () => Promise<T> | T, fallback: T, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), timeoutMs);
  });
  try {
    const answer = Promise.resolve()
      .then(call)
      .catch(() => fallback);
    return await Promise.race([answer, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function runPep(raw: unknown, ports: PepPorts, defect: DefectProbe): Promise<PepOutcome> {
  const steps: PepStep[] = [];
  const timeoutMs = ports.authorityTimeoutMs ?? AUTHORITY_TIMEOUT_MS;
  const at = ports.clock.ms();
  const evidence = (record: Flat): PepEvidence => Object.freeze({ schema: 'rn.reference.pep-evidence/1', evidenceDigest: referenceDigest({ ...record, atMs: at }), steps: Object.freeze([...steps]) });
  const deny = (reason: PepDenial, operation: string | null, documentId: string | null): PepOutcome => {
    steps.push('10.evidence');
    return Object.freeze({ outcome: 'denied', operation, documentId, reason, evidence: evidence({ outcome: 'denied', reason, operation: operation ?? '', documentId: documentId ?? '' }) });
  };

  // 1. Request schema.
  steps.push('1.request-schema');
  const request = readRequest(raw);
  if (request === undefined) return deny('MALFORMED_REQUEST', null, null);
  const { operation, documentId } = request;
  const has = (id: BypassId) => defect(id, operation);

  // 2. Principal and organization context.
  steps.push('2.principal-context');
  const principal = ports.world.principals.get(request.principalId);
  if (principal === undefined) return deny('UNKNOWN_PRINCIPAL', operation, documentId);
  if (principal.organizationId !== request.organizationId) return deny('PRINCIPAL_CONTEXT_MISMATCH', operation, documentId);

  // 3. Bind the operation to the exact resource, in the caller's organization.
  steps.push('3.resource-binding');
  const metadata = ports.store.metadata(documentId);
  if (metadata === undefined) return deny('UNKNOWN_DOCUMENT', operation, documentId);
  if (metadata.organizationId !== request.organizationId && !has('BYPASS-06')) return deny('CROSS_ORGANIZATION', operation, documentId);

  // 4. Applicable policy and signed terms.
  steps.push('4.policy-terms');
  if (request.termsDigest !== metadata.termsDigest) return deny('TERMS_MISMATCH', operation, documentId);

  // 5–6. A trusted decision: the one the caller carries (verified, never refreshed), or a fresh one from the dependency.
  let decision: SignedReferenceDecision | undefined;
  if (!has('BYPASS-01')) {
    let candidate: unknown = request.decision;
    if (candidate === undefined) {
      const unavailable: AuthorityAnswer = { kind: 'unavailable', detail: 'dependency failed or timed out' };
      const raw = await guarded<unknown>(() => ports.authorization.decide({ principalId: principal.principalId, organizationId: request.organizationId, documentId, operation, termsClaimId: metadata.termsClaimId, termsDigest: metadata.termsDigest }), unavailable, timeoutMs);
      const answer: AuthorityAnswer = typeof raw === 'object' && raw !== null && ((raw as AuthorityAnswer).kind === 'decision' || (raw as AuthorityAnswer).kind === 'unavailable') ? (raw as AuthorityAnswer) : unavailable;
      if (answer.kind !== 'decision') {
        if (!has('BYPASS-07')) return deny('AUTHORITY_UNAVAILABLE', operation, documentId);
      } else {
        candidate = answer.decision;
      }
    }
    steps.push('5.decision-obtained');
    if (candidate !== undefined) {
      steps.push('6.decision-verified');
      decision = readSignedDecision(candidate, ports.trustedAuthorityPublicKeyPem);
      if (decision === undefined) {
        // A malformed answer from the dependency is a dependency failure; BYPASS-07 lets it through.
        if (!(has('BYPASS-07') && request.decision === undefined)) return deny('DECISION_INVALID', operation, documentId);
      } else {
        const p = decision.payload;
        const bound = p.principalId === principal.principalId && p.documentId === documentId && p.operation === operation && p.termsClaimId === metadata.termsClaimId && p.termsDigest === metadata.termsDigest;
        const orgBound = p.organizationId === request.organizationId || has('BYPASS-06');
        if (!bound || !orgBound) return deny('DECISION_BINDING_MISMATCH', operation, documentId);
      }
    }
  }

  // 7. Freshness and revocation — on every operation, cached decision or not.
  steps.push('7.freshness-revocation');
  if (decision !== undefined) {
    const p = decision.payload;
    if (p.issuedAtMs > at) return deny('DECISION_FROM_FUTURE', operation, documentId);
    const ceilingEnd = p.issuedAtMs + DECISION_CEILING_SECONDS[operation] * 1000;
    if ((at >= p.expiresAtMs || at >= ceilingEnd) && !has('BYPASS-05')) return deny('DECISION_STALE', operation, documentId);
  }
  if (!has('BYPASS-02')) {
    const revocation = await guarded<RevocationState>(() => ports.revocation.revocationOf(documentId, metadata.termsClaimId), 'UNKNOWN', timeoutMs);
    if (revocation === 'REVOKED') return deny('REVOKED', operation, documentId);
    if (revocation !== 'NOT_REVOKED') return deny('REVOCATION_UNKNOWN', operation, documentId);
  }

  // 8. The decision must explicitly permit this operation.
  steps.push('8.permission');
  if (decision !== undefined && decision.payload.effect !== 'ALLOW') return deny('NOT_PERMITTED', operation, documentId);
  if (decision === undefined && !has('BYPASS-01') && !has('BYPASS-07')) return deny('DECISION_INVALID', operation, documentId);

  // 9. Only now: the protected resource action.
  steps.push('9.resource-action');
  const decisionId = decision?.payload.decisionId ?? null;
  const capability = mintCapability(documentId, operation, decisionId ?? 'none');
  let result: PepResult;
  if (operation === 'document.open') result = { kind: 'content', bytes: ports.store.open(capability, documentId) };
  else if (operation === 'document.export') result = { kind: 'export', bytes: ports.store.export(capability, documentId) };
  else result = { kind: 'terms-modified', ...ports.store.modifyProtectedTerms(capability, documentId, request.newTermsDigest as string) };

  // 10. Minimal evidence.
  steps.push('10.evidence');
  return Object.freeze({ outcome: 'allowed', operation, documentId, decisionId, result, evidence: evidence({ outcome: 'allowed', operation, documentId, decisionId: decisionId ?? '' }) });
}

/** The conformant reference PEP. */
export function executeProtectedDocumentOperation(request: unknown, ports: PepPorts): Promise<PepOutcome> {
  return runPep(request, ports, NO_DEFECTS);
}

// ---------------------------------------------------------------------------
// The deployed reference integration (conformant, or with fixture defects).
// ---------------------------------------------------------------------------

export const REFERENCE_ADAPTER = Object.freeze({ name: 'rn-reference-document-pep', version: '1.0.0' });
export const REFERENCE_SDK = Object.freeze({ package: '@republika-synthetic/document-use-reference-adapter', version: '1.0.0', lockDigest: `sha256:${'4'.repeat(64)}` });
export const REFERENCE_POLICY_DIGEST = referenceDigest({ policy: 'rn.reference.document-use-policy', version: '1', rules: JSON.stringify(PROTECTED_RULES) });
export const REFERENCE_FIXTURE_REF = 'fixture-reference-pep-v1';

export const deploymentDigestOf = (adapter: { readonly name: string; readonly version: string }, policyDigest: string): string =>
  referenceDigest({ adapterName: adapter.name, adapterVersion: adapter.version, sdkPackage: REFERENCE_SDK.package, sdkVersion: REFERENCE_SDK.version, policyDigest });
/** What the credentialed deployment runs. */
export const REFERENCE_DEPLOYMENT_DIGEST = deploymentDigestOf(REFERENCE_ADAPTER, REFERENCE_POLICY_DIGEST);
export const REFERENCE_ADAPTER_DIGEST = referenceDigest({ adapterName: REFERENCE_ADAPTER.name, adapterVersion: REFERENCE_ADAPTER.version });

export interface AttestedManifest {
  readonly schema: 'rn.reference.attested-manifest/1';
  readonly adapter: { readonly name: string; readonly version: string };
  readonly policyDigest: string;
  readonly deploymentDigest: string;
}

/**
 * The fixture switches. TEST-ONLY: this object, its defects and the integration built from it exist only in tests, and
 * no runtime configuration can create one.
 */
export interface ReferenceDeployment {
  readonly defects: Set<BypassId>;
  /** Operations the defects apply to; empty = all. */
  readonly defectOperations: Set<ReferenceOperation>;
}

export const conformantDeployment = (): ReferenceDeployment => ({ defects: new Set(), defectOperations: new Set() });

export interface ReferenceIntegration {
  readonly world: ReferenceWorld;
  readonly store: ProtectedDocumentStore;
  readonly authority: SyntheticDecisionAuthority;
  readonly clock: FixtureClock;
  readonly ports: PepPorts;
  /** The primary interface. */
  execute(request: unknown): Promise<PepOutcome>;
  /** The alternate (batch) interface: must enforce the same decision. */
  executeBatch(requests: readonly unknown[]): Promise<readonly PepOutcome[]>;
  /** The direct storage route, by locator, for one operation's storage path. */
  storage(locator: string, operation: ReferenceOperation): StorageResponse;
  /** A client obtaining a decision to carry with later requests. */
  obtainDecision(principalId: string, organizationId: string, documentId: string, operation: ReferenceOperation): Promise<unknown>;
  attestedManifest(): AttestedManifest;
}

export function createReferenceIntegration(
  deployment: ReferenceDeployment = conformantDeployment(),
  options: { readonly world?: ReferenceWorld; readonly clock?: FixtureClock; readonly authorization?: AuthorizationPort; readonly revocation?: RevocationPort; readonly trustedAuthorityPublicKeyPem?: string; readonly authorityTimeoutMs?: number } = {},
): ReferenceIntegration {
  const world = options.world ?? createReferenceWorld();
  const clock = options.clock ?? fixtureClock();
  const store = new ProtectedDocumentStore(world);
  const authority = new SyntheticDecisionAuthority(world, clock);
  const ports: PepPorts = {
    world,
    store,
    authorization: options.authorization ?? authority,
    revocation: options.revocation ?? authority,
    clock,
    trustedAuthorityPublicKeyPem: options.trustedAuthorityPublicKeyPem ?? AUTHORITY_PUBLIC_KEY_PEM,
    ...(options.authorityTimeoutMs === undefined ? {} : { authorityTimeoutMs: options.authorityTimeoutMs }),
  };
  const defect: DefectProbe = (id, operation) => deployment.defects.has(id) && (deployment.defectOperations.size === 0 || deployment.defectOperations.has(operation));
  const execute = (request: unknown) => runPep(request, ports, defect);
  return {
    world,
    store,
    authority,
    clock,
    ports,
    execute,
    async executeBatch(requests) {
      const out: PepOutcome[] = [];
      for (const raw of requests) {
        const request = readRequest(raw);
        if (request !== undefined && defect('BYPASS-03', request.operation)) {
          // DEFECT (fixture only): the batch path goes straight to storage without the PEP.
          const capability = mintCapability(request.documentId, request.operation, 'batch-bypass');
          const bytes = request.operation === 'document.export' ? store.export(capability, request.documentId) : request.operation === 'document.open' ? store.open(capability, request.documentId) : null;
          const result: PepResult = bytes === null ? { kind: 'terms-modified', ...store.modifyProtectedTerms(capability, request.documentId, request.newTermsDigest ?? 'sha256:batch') } : request.operation === 'document.export' ? { kind: 'export', bytes } : { kind: 'content', bytes };
          out.push(Object.freeze({ outcome: 'allowed', operation: request.operation, documentId: request.documentId, decisionId: null, result, evidence: Object.freeze({ schema: 'rn.reference.pep-evidence/1', evidenceDigest: referenceDigest({ batch: 'bypass' }), steps: Object.freeze(['9.resource-action'] as PepStep[]) }) }));
        } else {
          out.push(await execute(raw));
        }
      }
      return Object.freeze(out);
    },
    storage(locator, operation) {
      return store.retrieveByLocator(locator, defect('BYPASS-04', operation));
    },
    async obtainDecision(principalId, organizationId, documentId, operation) {
      const metadata = store.metadata(documentId);
      if (metadata === undefined) return undefined;
      const answer = await ports.authorization.decide({ principalId, organizationId, documentId, operation, termsClaimId: metadata.termsClaimId, termsDigest: metadata.termsDigest });
      return answer.kind === 'decision' ? answer.decision : undefined;
    },
    attestedManifest() {
      const adapter = deployment.defects.has('BYPASS-08') ? { name: REFERENCE_ADAPTER.name, version: '1.0.1-unreviewed' } : { ...REFERENCE_ADAPTER };
      return Object.freeze({ schema: 'rn.reference.attested-manifest/1', adapter: Object.freeze(adapter), policyDigest: REFERENCE_POLICY_DIGEST, deploymentDigest: deploymentDigestOf(adapter, REFERENCE_POLICY_DIGEST) });
    },
  };
}

// ---------------------------------------------------------------------------
// Validator challenge procedures (what a validator does against the fixture).
// ---------------------------------------------------------------------------

export interface SubProbe {
  readonly name: string;
  readonly outcome: 'allowed' | 'denied' | 'precondition-failed';
  readonly reason: string;
  readonly leakedProtectedContent: boolean;
}

export interface ProbeResult {
  readonly challengeType: ReferenceChallengeType;
  readonly operation: string;
  /** What a validator reports: never content. */
  readonly observedOutcome: 'denied' | 'allowed' | 'error' | 'digest_reported';
  readonly observedDeploymentDigest: string | null;
  readonly statusCode: number;
  /** Digest of the observed responses (status, outcome, reason) — the content itself never leaves the probe. */
  readonly responseDigest: string;
  readonly leakedProtectedContent: boolean;
  readonly subProbes: readonly SubProbe[];
}

const leakOf = (o: PepOutcome): boolean => o.outcome === 'allowed' && (o.result.kind === 'content' || o.result.kind === 'export') && containsSentinel(o.result.bytes);
const sub = (name: string, o: PepOutcome): SubProbe => Object.freeze({ name, outcome: o.outcome, reason: o.outcome === 'denied' ? o.reason : 'EXECUTED', leakedProtectedContent: leakOf(o) });

function requestFor(integration: ReferenceIntegration, principalId: string, organizationId: string, documentId: string, operation: ReferenceOperation, extra: { decision?: unknown } = {}): DocumentOperationRequest {
  const metadata = integration.store.metadata(documentId);
  return {
    principalId,
    organizationId,
    documentId,
    operation,
    termsDigest: metadata?.termsDigest ?? 'sha256:unknown',
    // A probe's modification re-asserts the current terms, so a two-step probe (G02) is not refused for a terms change it made itself.
    ...(operation === 'document.modify-protected-terms' ? { newTermsDigest: metadata?.termsDigest ?? 'sha256:unknown' } : {}),
    ...(extra.decision === undefined ? {} : { decision: extra.decision }),
  };
}

/**
 * Runs challenge `type` for `operation` against a FRESH, isolated instance of the deployment (each probe owns its world,
 * fixture clock and dependency state, so probes never contaminate each other) and reports what a validator observes.
 */
export async function runReferenceProbe(deployment: ReferenceDeployment, type: ReferenceChallengeType, operation: string): Promise<ProbeResult> {
  const integration = createReferenceIntegration(deployment);
  const subProbes: SubProbe[] = [];
  const target = DOCUMENTS.alphaContract;
  let digestReported: string | null = null;
  if (type === 'G08') {
    digestReported = integration.attestedManifest().deploymentDigest;
  } else if (!isReferenceOperation(operation)) {
    subProbes.push({ name: 'operation', outcome: 'precondition-failed', reason: 'NOT_A_REFERENCE_OPERATION', leakedProtectedContent: false });
  } else {
    const authorized = AUTHORIZED_FOR[operation];
    switch (type) {
      case 'G01': {
        subProbes.push(sub('no-decision', await integration.execute(requestFor(integration, PRINCIPALS.outsider, ORG_ALPHA, target, operation))));
        const forged = signReferenceDecision(
          { schema: DECISION_SCHEMA, decisionId: 'forged-1', effect: 'ALLOW', reason: 'FORGED', principalId: PRINCIPALS.outsider, organizationId: ORG_ALPHA, documentId: target, operation, termsClaimId: integration.store.metadata(target)?.termsClaimId ?? '', termsDigest: integration.store.metadata(target)?.termsDigest ?? '', issuedAtMs: integration.clock.ms(), expiresAtMs: integration.clock.ms() + 60_000 },
          FORGER_KEY,
        );
        subProbes.push(sub('forged-decision', await integration.execute(requestFor(integration, PRINCIPALS.outsider, ORG_ALPHA, target, operation, { decision: forged }))));
        const someoneElses = await integration.obtainDecision(authorized, ORG_ALPHA, target, operation);
        subProbes.push(sub('another-principals-decision', await integration.execute(requestFor(integration, PRINCIPALS.outsider, ORG_ALPHA, target, operation, { decision: someoneElses }))));
        break;
      }
      case 'G02': {
        const decision = await integration.obtainDecision(authorized, ORG_ALPHA, target, operation);
        const before = await integration.execute(requestFor(integration, authorized, ORG_ALPHA, target, operation, { decision }));
        if (before.outcome !== 'allowed') {
          subProbes.push({ name: 'pre-revocation', outcome: 'precondition-failed', reason: before.reason, leakedProtectedContent: false });
          break;
        }
        integration.authority.revoke(integration.store.metadata(target)?.termsClaimId ?? '');
        integration.clock.advance(REVOCATION_PROPAGATION_SECONDS + 1);
        // Same (still unexpired) decision after P_rev; a modification would have changed the terms, so re-read them.
        subProbes.push(sub('post-revocation', await integration.execute(requestFor(integration, authorized, ORG_ALPHA, target, operation, { decision }))));
        break;
      }
      case 'G03':
        subProbes.push(sub('batch-interface-unauthorized', (await integration.executeBatch([requestFor(integration, PRINCIPALS.outsider, ORG_ALPHA, target, operation)]))[0] as PepOutcome));
        break;
      case 'G04': {
        const metadata = integration.store.metadata(target);
        const response = integration.storage(metadata?.locator ?? '', operation);
        // Only an explicit refusal (403, no body) counts as enforcement; anything else (e.g. a 404 from a wrong locator) is
        // inconclusive, never a pass (review P3-2).
        const outcome: SubProbe['outcome'] = response.status === 200 ? 'allowed' : response.status === 403 && response.body === null ? 'denied' : 'precondition-failed';
        subProbes.push({ name: 'storage-locator', outcome, reason: `HTTP_${response.status}`, leakedProtectedContent: containsSentinel(response.body) });
        break;
      }
      case 'G05': {
        const decision = await integration.obtainDecision(authorized, ORG_ALPHA, target, operation);
        integration.clock.advance(DECISION_CEILING_SECONDS[operation] + 1);
        subProbes.push(sub('stale-decision', await integration.execute(requestFor(integration, authorized, ORG_ALPHA, target, operation, { decision }))));
        break;
      }
      case 'G06':
        subProbes.push(sub('cross-tenant', await integration.execute(requestFor(integration, PRINCIPALS.betaAgent, ORG_BETA, target, operation))));
        break;
      case 'G07':
        for (const mode of ['unavailable', 'timeout', 'malformed'] as const) {
          integration.authority.mode = mode;
          subProbes.push(sub(`dependency-${mode}`, await integration.execute(requestFor(integration, authorized, ORG_ALPHA, target, operation))));
        }
        integration.authority.mode = 'available';
        break;
    }
  }
  const observedOutcome: ProbeResult['observedOutcome'] =
    type === 'G08' ? 'digest_reported' : subProbes.length === 0 || subProbes.some((s) => s.outcome === 'precondition-failed') ? 'error' : subProbes.some((s) => s.outcome === 'allowed') ? 'allowed' : 'denied';
  const statusCode = observedOutcome === 'allowed' || observedOutcome === 'digest_reported' ? 200 : observedOutcome === 'denied' ? 403 : 500;
  return Object.freeze({
    challengeType: type,
    operation,
    observedOutcome,
    observedDeploymentDigest: digestReported,
    statusCode,
    responseDigest: referenceDigest({ type, operation, observedOutcome, statusCode, subProbes: subProbes.map((s) => `${s.name}:${s.outcome}:${s.reason}`).join('|') }),
    leakedProtectedContent: subProbes.some((s) => s.leakedProtectedContent),
    subProbes: Object.freeze(subProbes),
  });
}
