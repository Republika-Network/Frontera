import { AOC_ENTERPRISE_HOST_VERSION } from '../version.js';

/**
 * Centralizes every environment-derived knob the Soberanía Enterprise Host needs.
 * The Kernel itself takes none of this -- `AocKernel` is constructed once by
 * the composition root (`composition/composition-root.ts`) and never reads
 * configuration directly, per the mission's "Kernel remains
 * configuration-independent" principle.
 */
export type EnterpriseEnvironment = 'development' | 'test' | 'staging' | 'production';

export type EnterprisePersistenceProviderKind = 'memory' | 'sqlite';

/** A configured caller credential. `organizationId`, when present, scopes the key to requests naming that same `organization.id` -- a request for a different organization is a 403, not a 401 (the key is valid; it just isn't authorized for that organization). */
export interface EnterpriseApiKey {
  readonly key: string;
  readonly organizationId?: string;
  /**
   * Non-secret identity metadata that makes this credential eligible for the
   * secure **customer plane** (`docs/enterprise/AOC_CUSTOMER_PRINCIPAL_BINDING.md`).
   *
   * Additive and ignored by every legacy v1 route: those keep authenticating
   * with `key` and scoping with `organizationId` exactly as before. A key
   * without this block, or without `organizationId`, is never admitted as a
   * customer principal. Supplied through typed composition configuration only;
   * `AOC_ENTERPRISE_API_KEYS` has no syntax for it and never will set it.
   *
   * The secret authenticates the principal; it is not the identity. Rotating
   * `key` while keeping this block keeps the same principal, external subject
   * and actor binding.
   */
  readonly customerIdentity?: EnterpriseApiKeyCustomerIdentity;
}

/** Who a customer-plane credential authenticates as. Server-configured, non-secret, and never derived from the key itself. */
export interface EnterpriseApiKeyCustomerIdentity {
  readonly principalId: string;
  /** The Kernel Authority external subject this principal represents. Resolved to a Frontera actor only through `KernelAuthorityStore.findActorByExternalSubject`. */
  readonly externalSubject: {
    readonly system: string;
    readonly subjectId: string;
  };
}

/**
 * CTRL-01: one authority administrator credential.
 *
 * Deliberately **not** an `EnterpriseApiKey`, and never merged into
 * `authentication.apiKeys`: an administrator secret authenticates the
 * authority administration API (`/api/admin/...`) and nothing else, and no
 * ordinary API key — legacy, organization-scoped or customer principal —
 * authenticates there. Being able to call the Host is not authority over it.
 *
 * Supplied through the Host's governed-action file (`administrators`), whose
 * secrets are environment-variable references; `AOC_ENTERPRISE_API_KEYS` has no
 * syntax for it. `operatorId` is the trusted identity every administrative
 * mutation is recorded under — it comes from this configuration, never from a
 * request.
 */
export interface EnterpriseAdministrator {
  readonly operatorId: string;
  readonly key: string;
}

export interface EnterpriseFeatureFlags {
  readonly traceLevel: 'basic' | 'full';
  readonly requireAuthentication: boolean;
}

/**
 * Timeouts the module lifecycle actually enforces (mission section 29:
 * "only implement timeouts that are actually enforced"). No separate
 * graceful-shutdown-drain timeout exists because this PR does not implement
 * in-flight-evaluation draining (see the Module Lifecycle doc's
 * "Limitations" section) -- `shutdownTimeoutMs` bounds each module's own
 * `shutdown()` call, which is all v1 needs.
 */
export interface EnterpriseLifecycleConfiguration {
  readonly startupTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
  readonly healthCheckTimeoutMs: number;
}

export interface EnterpriseConfiguration {
  readonly environment: EnterpriseEnvironment;
  readonly enterpriseVersion: string;
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
  readonly persistence: {
    readonly provider: EnterprisePersistenceProviderKind;
    readonly sqlitePath: string;
    /** Bounded wait (ms) on a locked SQLite file before failing, instead of an immediate SQLITE_BUSY. Enforced via `PRAGMA busy_timeout`. */
    readonly busyTimeoutMs: number;
    /** Enforced Governance Store persistence limits (PR-004 section 38) — every value here is actually applied on append; none is decorative. */
    readonly limits: {
      readonly maxRequestPayloadBytes: number;
      readonly maxResultPayloadBytes: number;
      readonly maxEventPayloadBytes: number;
      readonly maxTraceSteps: number;
    };
  };
  readonly eventPublishing: {
    readonly enabled: boolean;
  };
  readonly telemetry: {
    readonly enabled: boolean;
  };
  readonly authentication: {
    /** Static bearer tokens accepted by the Enterprise Host's own authentication step. Never forwarded to the Kernel. */
    readonly apiKeys: readonly EnterpriseApiKey[];
  };
  /**
   * CTRL-01: the authority administration API's credentials. Absent or empty
   * means the API is not mounted — there is no default administrator and no
   * fallback to any other credential.
   */
  readonly administration?: {
    readonly administrators: readonly EnterpriseAdministrator[];
  };
  readonly features: EnterpriseFeatureFlags;
  readonly http: {
    readonly port: number;
    readonly host: string;
  };
  readonly lifecycle: EnterpriseLifecycleConfiguration;
  /** PR-006: Agent Passport Runtime configuration (mission section 52 -- module criticality is deployment-configurable, never hardcoded). */
  readonly passport: {
    /** SQLite path for the Passport Store when `persistence.provider === 'sqlite'`. Independent of `persistence.sqlitePath` -- a distinct on-disk database file, since the Passport Store is an independent store (mission section 9). */
    readonly sqlitePath: string;
    /** When `true`, a Passport Store outage makes the Enterprise Host not-ready (`criticality: 'required'`). Defaults to `false`: Passport-backed agent recognition degrades gracefully rather than blocking governance evaluation. */
    readonly required: boolean;
  };
  /**
   * P0-PKG-07: Kernel Authority Runtime configuration -- the durable,
   * operator-provisioned recognition/authority world the Kernel decides
   * against.
   *
   * Opt-in (`enabled: false` by default) because turning it on changes where
   * the Kernel's world comes from. A deployment that has not adopted durable
   * authority keeps `createDefaultKernelProviders()`'s real-but-empty,
   * fail-closed world byte for byte.
   */
  readonly kernelAuthority: {
    /** When `true`, the composition root restores the Kernel's world from the Kernel Authority Store instead of composing an empty one. */
    readonly enabled: boolean;
    /** The organization whose authority world this deployment decides for. One Enterprise instance serves exactly one authority organization. */
    readonly organizationId: string;
    /** SQLite path for the Kernel Authority Store when `persistence.provider === 'sqlite'`. Independent of every other store's path -- authority source-of-truth is never stored inside an evaluation-history database. */
    readonly sqlitePath: string;
    /** When `true` (the default), an authority-source outage makes the Enterprise Host not-ready rather than letting it answer out of a world it can no longer verify. */
    readonly required: boolean;
  };
  /**
   * The authoritative bounded-grant store's durable location.
   *
   * Read only when a host composes `authorityControlledExecution` **and**
   * supplies no `grantStore` of its own. Independent of every other store's
   * path, for the reason the Kernel Authority Store states: an authority
   * source-of-truth is never kept inside an evaluation-history database, and a
   * deployment must be able to back it up, restore it and rotate it on its own
   * terms. See `docs/security/AUTHORITATIVE_GRANT_STORE.md`.
   */
  readonly boundedGrant: {
    /** SQLite path for the bounded-grant store when `persistence.provider === 'sqlite'`. */
    readonly sqlitePath: string;
  };
  /**
   * The durable emergency-control store: the operational safety interlock's
   * own file.
   *
   * Its own, for the reason every other store has its own: an operator must be
   * able to back up, restore and rotate the kill switch independently of the
   * records it governs, and a control that shared a file with the grants it
   * stops could be lost by a restore that was only ever about grants. See
   * `docs/enterprise/AOC_EMERGENCY_CONTROL.md`.
   */
  readonly emergencyControl: {
    /** SQLite path for the emergency-control store when `persistence.provider === 'sqlite'`. */
    readonly sqlitePath: string;
  };
  /**
   * The durable exercise-control ledger (P7): aggregate / velocity reservation
   * state for the bounded-grant path.
   *
   * Read **only** when a host composes
   * `authorityControlledExecution.exerciseControls` **and** supplies no ledger
   * of its own — and then always, whatever `persistence.provider` says: an
   * aggregate limit whose consumption is forgotten on restart fails *open*, so
   * there is no process-local default. The file is never opened or created
   * otherwise. Its own file, for the reason every authority store has its own:
   * consumption state must be backed up, restored and rotated on its own terms,
   * and never inside an evidence database. See
   * `docs/enterprise/AOC_EXERCISE_CONTROLS.md`.
   */
  readonly exerciseLedger: {
    /** SQLite path for the exercise-control ledger. */
    readonly sqlitePath: string;
  };
  /**
   * The canonical authority event stream (P8): durable, hash-chained evidence
   * of the governed-action / bounded-grant lifecycle.
   *
   * Read **only** when governed actions are composed and the host supplies no
   * stream store of its own; used when `persistence.provider === 'sqlite'`
   * (the process-local store is selected otherwise, and is not durable). Its
   * own file: evidence is backed up, restored and retained on its own terms,
   * and is never co-located with authority state. A file that cannot be opened
   * degrades the stream's module and records nothing — it never refuses or
   * permits an action. See `docs/enterprise/AOC_CANONICAL_AUTHORITY_EVENT_STREAM.md`.
   */
  readonly authorityEventStream: {
    /** SQLite path for the canonical authority event stream. */
    readonly sqlitePath: string;
  };
  /**
   * P11 — the durable execution outcome store: the exact prepared context and
   * the initial provider observation of every governed execution.
   *
   * Read **only** when governed actions are composed and the host supplies no
   * store of its own; used when `persistence.provider === 'sqlite'` (the
   * process-local store is selected otherwise, and does **not** survive a
   * restart). Its own file. Unlike the evidence stream, a file that cannot be
   * opened fails startup: governed executions never run without durable
   * preparation. See `docs/architecture/ADR-DURABLE-MONETARY-OUTCOMES.md`.
   */
  readonly executionOutcome: {
    /** SQLite path for the execution outcome store. */
    readonly sqlitePath: string;
  };
  /**
   * P12 — the execution resolution store: which trusted resolution authority
   * may resolve each governed execution, and what it later established.
   *
   * Read **only** when `executionReconciliation` is enabled and the host
   * supplies no store of its own; used when `persistence.provider === 'sqlite'`
   * (the process-local store otherwise, which does **not** survive a restart).
   * Its own file — never the P11 file. A file that cannot be opened fails
   * startup: with reconciliation enabled, no governed execution runs without a
   * durable binding. See
   * `docs/architecture/ADR-EXECUTION-RECONCILIATION-AND-RESOLUTION-AUTHORITY.md`.
   */
  /**
   * CORE-04 — the durable obligation discharge store: the append-only,
   * digest-verified log of reports about the obligations governed decisions
   * stand under. Opened only when governed actions configure obligation
   * discharge sources, and then the SQLite file under `sqlite` persistence.
   * Its own file, so the reports that release withheld executions are backed
   * up and restored on their own terms.
   */
  readonly obligationDischarge: {
    readonly sqlitePath: string;
  };
  /**
   * CORE-05 — the durable approval store: the append-only, signed log of
   * approval requests and approver verdicts that resume withheld decisions.
   * Opened only when a Governance Profile declares an approval requirement,
   * and then the SQLite file under `sqlite` persistence. Its own file.
   */
  readonly approval: {
    readonly sqlitePath: string;
  };
  readonly executionResolution: {
    /** SQLite path for the execution resolution store. */
    readonly sqlitePath: string;
  };
  /**
   * The cryptographic authenticity boundary for authority artifacts.
   *
   * Read only when a host composes `authorityControlledExecution` **and** the
   * durable bounded-grant store is selected. It is deliberately not a feature
   * flag: there is no `enabled` field, because a boolean that switched signature
   * verification off would be a permanent downgrade seam, and the one thing this
   * configuration must not offer is a supported way to run durable authority
   * unsigned. Keys are either configured, or the durable store is refused at
   * composition. See `docs/security/AUTHORITY_ARTIFACT_AUTHENTICITY.md` §12.
   *
   * CORE-02: a closed choice of **custody** — `software` (the key is in this
   * process, AA-001) or `external` (it is not; see §29). The two are
   * exclusive by type: the external variant has no field a private key could be
   * placed in.
   */
  readonly authorityAuthenticity: SoftwareAuthorityAuthenticityConfiguration | ExternalAuthorityAuthenticityConfiguration;
  /**
   * CORE-07 — cross-restart freshness of authenticated authority state.
   *
   * A closed choice: `none` (absent means `none`: signatures authenticate the
   * durable authority stores, and a restored earlier authentic state is
   * detected only while a process runs — AA-003 / GS-002 stay open for this
   * deployment) or `external` (every durable authority store anchors its
   * signed head at an external authority-state witness outside its restore
   * domain, and a restored earlier state is refused across restarts). The
   * secure Host profile requires `external`. There is no local-only mode that
   * claims cross-restart freshness, and no fallback from `external` to one.
   */
  readonly authorityFreshness?: NoAuthorityFreshnessConfiguration | ExternalAuthorityFreshnessConfiguration;
  /** PR-007: Assurance Runtime configuration (mission section 57 -- Assurance criticality is deployment-configurable, never hardcoded). */
  readonly assurance: {
    /** SQLite path for the Assurance Store when `persistence.provider === 'sqlite'`. Independent of every other store's path -- the Assurance Store is an independent store (mission section 48). */
    readonly sqlitePath: string;
    /** When `true`, an Assurance Store outage makes the Enterprise Host not-ready. Defaults to `false`: Assurance degrades gracefully without blocking `POST /api/governance/evaluate`. */
    readonly required: boolean;
  };
}

/**
 * The trusted verification set: every key whose signatures this deployment
 * will accept, including historical keys that signed still-live artifacts.
 *
 * Public material, so it is safe on the public configuration surface. The set
 * is the root of trust — an artifact naming a key id absent from here is
 * refused, and an artifact's own claim about its key is never consulted for
 * material. Removing an entry makes every artifact signed by it unreadable;
 * §13 of the security document states why that is a key-trust operation and
 * not a revocation.
 */
export type AuthorityVerificationKeyConfiguration = {
  readonly keyId: string;
  readonly algorithm: string;
  /** SPKI PEM. */
  readonly publicKeyPem: string;
};

/** Software custody: the authority private key is parsed into this process (AA-001). The historical, and still supported, mode. */
export interface SoftwareAuthorityAuthenticityConfiguration {
  /** Absent means `software` — the historical shape, unchanged for embedders. External custody is only ever selected explicitly. */
  readonly mode?: 'software';
  /** Which configured key signs new artifacts. Must also appear in `verificationKeys`, or composition refuses. */
  readonly activeSigningKeyId: string | undefined;
  /**
   * PKCS#8 PEM for the active signing key. **Secret.**
   *
   * Redacted from `PublicEnterpriseConfiguration` exactly as `apiKeys` are,
   * and a security test pins that it never appears there. In this mode it is a
   * private key resident in application process memory — AA-001. External
   * custody (`mode: 'external'`) is the mode without it.
   */
  readonly signingKeyPem: string | undefined;
  readonly verificationKeys: readonly AuthorityVerificationKeyConfiguration[];
}

/**
 * External custody (CORE-02): the authority private key is held by a custody
 * service outside this process; this process holds its pinned **public**
 * identity and a service credential. There is no private-key field — the type
 * cannot carry one — and no fallback to software signing exists.
 */
export interface ExternalAuthorityAuthenticityConfiguration {
  readonly mode: 'external';
  /** The **pinned** key id the custody service must answer as. Must appear in `verificationKeys`; its entry there pins the algorithm and public key too. */
  readonly activeSigningKeyId: string | undefined;
  readonly verificationKeys: readonly AuthorityVerificationKeyConfiguration[];
  readonly externalSigner: {
    /** Base URL of the custody service. `https:`, or `http:` to loopback for the local reference signer. */
    readonly endpoint: string;
    /** Bearer credential for the custody service. **Secret** — it authorizes use of the key, though it is not the key. Never on public configuration. */
    readonly credential: string;
    /** Per-attempt time budget for every call. */
    readonly timeoutMs: number;
    /** Bounded attempts, for the startup identity handshake and every signature; only availability failures are retried. */
    readonly maxAttempts: number;
    /** CORE-02R: minimum age of an identity result before `/health` probes the service again (0 = every health check). Bounds signer fanout; never delays a signing failure. */
    readonly probeIntervalMs: number;
  };
  /**
   * Whether `AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_PEM` was present in the
   * environment this was read from. The key itself is never read into this
   * object; its presence alongside external custody is a contradiction the
   * composition refuses, because the key would still be resident in this
   * process's environment.
   */
  readonly conflictingSigningKeyPresent: boolean;
}

/** CORE-07: no freshness witness. Cross-restart rollback of durable authority is not detected (AA-003 / GS-002 open for this deployment). */
export interface NoAuthorityFreshnessConfiguration {
  readonly mode: 'none';
}

/**
 * CORE-07: an external authority-state witness. Its identity — id and Ed25519
 * public key — is pinned here and never learned from the witness; its
 * credential is its own, never the external signer's. A different trust role
 * gets a different credential and a different key.
 */
export interface ExternalAuthorityFreshnessConfiguration {
  readonly mode: 'external';
  readonly witness: {
    /** Base URL of the witness. `https:`, or `http:` to loopback for the local reference witness. */
    readonly endpoint: string;
    /** Bearer credential for the witness. **Secret.** Never on public configuration. */
    readonly credential: string;
    /** The pinned witness id every receipt must name. */
    readonly witnessId: string;
    /** SPKI PEM of the pinned witness receipt key. Public material. */
    readonly publicKeyPem: string;
    readonly timeoutMs: number;
    readonly maxAttempts: number;
    readonly probeIntervalMs: number;
  };
}

export const DEFAULT_AUTHORITY_FRESHNESS_TIMEOUT_MS = 5_000;
export const DEFAULT_AUTHORITY_FRESHNESS_MAX_ATTEMPTS = 2;
export const DEFAULT_AUTHORITY_FRESHNESS_PROBE_INTERVAL_MS = 5_000;

export const DEFAULT_EXTERNAL_SIGNER_TIMEOUT_MS = 5_000;
export const DEFAULT_EXTERNAL_SIGNER_MAX_ATTEMPTS = 2;
export const DEFAULT_EXTERNAL_SIGNER_PROBE_INTERVAL_MS = 5_000;

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value === '1' || value.toLowerCase() === 'true';
}

/**
 * Parses the trusted authority verification set from its JSON environment
 * variable.
 *
 * Malformed input yields an **empty** set, never a partial one. A set that
 * silently dropped the entries it could not parse would be a deployment that
 * believes it trusts three keys while trusting two, and the artifacts signed by
 * the third would fail closed at exercise time rather than at startup. Empty is
 * refused by the verifier at composition, which is where a configuration
 * problem should surface.
 */
function parseAuthorityVerificationKeys(value: string | undefined): readonly { readonly keyId: string; readonly algorithm: string; readonly publicKeyPem: string }[] {
  if (value === undefined || value.trim().length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const entries: { readonly keyId: string; readonly algorithm: string; readonly publicKeyPem: string }[] = [];
  for (const candidate of parsed) {
    if (typeof candidate !== 'object' || candidate === null) return [];
    const entry = candidate as Record<string, unknown>;
    if (typeof entry.keyId !== 'string' || typeof entry.algorithm !== 'string' || typeof entry.publicKeyPem !== 'string') return [];
    entries.push({ keyId: entry.keyId, algorithm: entry.algorithm, publicKeyPem: entry.publicKeyPem });
  }
  return entries;
}

/** Parses a positive-integer millisecond timeout, falling back to `fallback` for anything missing, non-numeric, zero, or negative -- an unreasonable value is never silently allowed to disable a timeout. */
function parsePositiveIntMs(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseEnvironment(value: string | undefined): EnterpriseEnvironment {
  if (value === 'production' || value === 'staging' || value === 'test' || value === 'development') return value;
  return 'development';
}

/** Parses `AOC_ENTERPRISE_API_KEYS="key1,key2:org-acme,key3:org-beta"` -- a bare key grants access regardless of the request's organization; a `key:orgId` pair scopes it. */
function parseApiKeys(value: string | undefined): readonly EnterpriseApiKey[] {
  if (!value) return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const separatorIndex = entry.indexOf(':');
      if (separatorIndex === -1) return { key: entry };
      const key = entry.slice(0, separatorIndex).trim();
      const organizationId = entry.slice(separatorIndex + 1).trim();
      return organizationId.length > 0 ? { key, organizationId } : { key };
    });
}

const ENVIRONMENT_VALUES: readonly EnterpriseEnvironment[] = ['development', 'test', 'staging', 'production'];
const PERSISTENCE_PROVIDER_VALUES: readonly EnterprisePersistenceProviderKind[] = ['memory', 'sqlite'];
const LOG_LEVEL_VALUES: readonly EnterpriseConfiguration['logLevel'][] = ['debug', 'info', 'warn', 'error'];
const BOOLEAN_VARIABLES = [
  'AOC_ENTERPRISE_REQUIRE_AUTH',
  'AOC_ENTERPRISE_EVENTS_ENABLED',
  'AOC_ENTERPRISE_TELEMETRY_ENABLED',
  'AOC_ENTERPRISE_PASSPORT_REQUIRED',
  'AOC_ENTERPRISE_ASSURANCE_REQUIRED',
  'AOC_ENTERPRISE_KERNEL_AUTHORITY_ENABLED',
  'AOC_ENTERPRISE_KERNEL_AUTHORITY_REQUIRED',
] as const;

/**
 * The strict reading of the same variables `loadEnterpriseConfiguration`
 * reads leniently.
 *
 * `loadEnterpriseConfiguration` maps anything it does not recognize to a
 * default — `AOC_ENTERPRISE_PERSISTENCE_PROVIDER=sqllite` becomes `memory`,
 * `AOC_ENTERPRISE_ENV=prod` becomes `development`, `AOC_ENTERPRISE_REQUIRE_AUTH=yes`
 * becomes `false`. Embedders and tests rely on that leniency, so it stays. A
 * process an operator starts must not: each of those is a silent downgrade
 * from what the operator wrote. The Enterprise Host bootstrap
 * (`host/enterprise-host.ts`) refuses to boot while this returns anything.
 *
 * Returns one problem per variable, naming the variable and the accepted
 * values — never echoing a value, because a mistyped variable can hold a
 * secret.
 */
export function validateEnterpriseEnvironment(env: Readonly<Record<string, string | undefined>>): readonly string[] {
  const problems: string[] = [];
  const oneOf = (name: string, allowed: readonly string[]): void => {
    const value = env[name];
    if (value !== undefined && !allowed.includes(value)) problems.push(`${name} must be one of: ${allowed.join(', ')}.`);
  };
  oneOf('AOC_ENTERPRISE_ENV', ENVIRONMENT_VALUES);
  oneOf('AOC_ENTERPRISE_PERSISTENCE_PROVIDER', PERSISTENCE_PROVIDER_VALUES);
  oneOf('AOC_ENTERPRISE_LOG_LEVEL', LOG_LEVEL_VALUES);
  oneOf('AOC_ENTERPRISE_TRACE_LEVEL', ['basic', 'full']);
  for (const name of BOOLEAN_VARIABLES) {
    const value = env[name];
    if (value !== undefined && !['true', 'false', '1', '0'].includes(value.toLowerCase())) problems.push(`${name} must be true or false.`);
  }
  const port = env.AOC_ENTERPRISE_HTTP_PORT;
  if (port !== undefined && (!/^\d{1,5}$/.test(port) || Number.parseInt(port, 10) > 65_535)) problems.push('AOC_ENTERPRISE_HTTP_PORT must be an integer from 0 to 65535.');
  const host = env.AOC_ENTERPRISE_HTTP_HOST;
  if (host !== undefined && host.trim().length === 0) problems.push('AOC_ENTERPRISE_HTTP_HOST must not be empty.');
  const verificationKeys = env.AOC_ENTERPRISE_AUTHORITY_VERIFICATION_KEYS;
  if (verificationKeys !== undefined && verificationKeys.trim().length > 0 && parseAuthorityVerificationKeys(verificationKeys).length === 0) {
    problems.push('AOC_ENTERPRISE_AUTHORITY_VERIFICATION_KEYS must be a JSON array of {keyId, algorithm, publicKeyPem} objects.');
  }
  problems.push(...authoritySignerEnvironmentProblems(env));
  problems.push(...authorityFreshnessEnvironmentProblems(env));
  const apiKeys = env.AOC_ENTERPRISE_API_KEYS;
  if (apiKeys !== undefined && parseApiKeys(apiKeys).some((apiKey) => apiKey.key.length === 0)) {
    problems.push('AOC_ENTERPRISE_API_KEYS contains an entry with an empty key.');
  }
  return problems;
}

const EXTERNAL_SIGNER_VARIABLES = [
  'AOC_ENTERPRISE_AUTHORITY_SIGNER_ENDPOINT',
  'AOC_ENTERPRISE_AUTHORITY_SIGNER_TOKEN',
  'AOC_ENTERPRISE_AUTHORITY_SIGNER_TIMEOUT_MS',
  'AOC_ENTERPRISE_AUTHORITY_SIGNER_MAX_ATTEMPTS',
  'AOC_ENTERPRISE_AUTHORITY_SIGNER_PROBE_INTERVAL_MS',
] as const;

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/**
 * CORE-02: the strict reading of the authority-signer custody variables. One
 * custody, stated explicitly, with nothing belonging to the other lying around:
 *
 * - `external` with `AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_PEM` present is
 *   refused — the key would be resident in this process's environment while
 *   the operator believes it is not;
 * - `external` without endpoint, credential, pinned key id or trusted
 *   verification keys is refused;
 * - an external-signer variable without `external` is refused — never guessed.
 *
 * Names variables and rules, never values.
 */
function authoritySignerEnvironmentProblems(env: Readonly<Record<string, string | undefined>>): readonly string[] {
  const problems: string[] = [];
  const mode = env.AOC_ENTERPRISE_AUTHORITY_SIGNER_MODE;
  if (mode !== undefined && mode !== 'software' && mode !== 'external') {
    problems.push('AOC_ENTERPRISE_AUTHORITY_SIGNER_MODE must be one of: software, external.');
    return problems;
  }
  const present = (name: string): boolean => env[name] !== undefined && (env[name] ?? '').length > 0;
  if (mode !== 'external') {
    for (const name of EXTERNAL_SIGNER_VARIABLES) {
      if (env[name] !== undefined) problems.push(`${name} is set but AOC_ENTERPRISE_AUTHORITY_SIGNER_MODE is not 'external'. Refusing to guess which authority-key custody was meant.`);
    }
    return problems;
  }
  if (env.AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_PEM !== undefined) {
    problems.push(
      "AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_PEM must not be set when AOC_ENTERPRISE_AUTHORITY_SIGNER_MODE=external: external custody means this process holds no authority private key. Remove it from this process's environment.",
    );
  }
  if (!present('AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_ID')) problems.push('AOC_ENTERPRISE_AUTHORITY_SIGNER_MODE=external requires AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_ID: the key id the external signer must answer as.');
  if (!present('AOC_ENTERPRISE_AUTHORITY_VERIFICATION_KEYS')) problems.push('AOC_ENTERPRISE_AUTHORITY_SIGNER_MODE=external requires AOC_ENTERPRISE_AUTHORITY_VERIFICATION_KEYS: the pinned signer key is checked against them.');
  const endpoint = env.AOC_ENTERPRISE_AUTHORITY_SIGNER_ENDPOINT;
  if (endpoint === undefined || endpoint.length === 0) {
    problems.push('AOC_ENTERPRISE_AUTHORITY_SIGNER_MODE=external requires AOC_ENTERPRISE_AUTHORITY_SIGNER_ENDPOINT.');
  } else {
    let url: URL | undefined;
    try {
      url = new URL(endpoint);
    } catch {
      url = undefined;
    }
    if (url === undefined || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
      problems.push('AOC_ENTERPRISE_AUTHORITY_SIGNER_ENDPOINT must be an absolute https URL (or http to a loopback address for the local reference signer).');
    } else if (url.protocol === 'http:' && !isLoopbackHostname(url.hostname)) {
      problems.push('AOC_ENTERPRISE_AUTHORITY_SIGNER_ENDPOINT uses plain http to a non-loopback address; only https is accepted beyond loopback.');
    } else if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '' || (url.pathname !== '/' && url.pathname !== '')) {
      problems.push('AOC_ENTERPRISE_AUTHORITY_SIGNER_ENDPOINT must be a base URL with no credentials, path, query or fragment.');
    }
  }
  const token = env.AOC_ENTERPRISE_AUTHORITY_SIGNER_TOKEN;
  if (token === undefined || token.length < 32 || /\s/.test(token)) {
    problems.push('AOC_ENTERPRISE_AUTHORITY_SIGNER_MODE=external requires AOC_ENTERPRISE_AUTHORITY_SIGNER_TOKEN: a credential of at least 32 characters with no whitespace.');
  }
  const timeout = env.AOC_ENTERPRISE_AUTHORITY_SIGNER_TIMEOUT_MS;
  if (timeout !== undefined && (!/^\d{1,5}$/.test(timeout) || Number.parseInt(timeout, 10) < 1 || Number.parseInt(timeout, 10) > 60_000)) {
    problems.push('AOC_ENTERPRISE_AUTHORITY_SIGNER_TIMEOUT_MS must be an integer from 1 to 60000.');
  }
  const attempts = env.AOC_ENTERPRISE_AUTHORITY_SIGNER_MAX_ATTEMPTS;
  if (attempts !== undefined && !['1', '2', '3'].includes(attempts)) problems.push('AOC_ENTERPRISE_AUTHORITY_SIGNER_MAX_ATTEMPTS must be 1, 2 or 3.');
  const probeInterval = env.AOC_ENTERPRISE_AUTHORITY_SIGNER_PROBE_INTERVAL_MS;
  if (probeInterval !== undefined && (!/^\d{1,5}$/.test(probeInterval) || Number.parseInt(probeInterval, 10) > 60_000)) {
    problems.push('AOC_ENTERPRISE_AUTHORITY_SIGNER_PROBE_INTERVAL_MS must be an integer from 0 to 60000.');
  }
  return problems;
}

const AUTHORITY_FRESHNESS_VARIABLES = [
  'AOC_ENTERPRISE_AUTHORITY_FRESHNESS_ENDPOINT',
  'AOC_ENTERPRISE_AUTHORITY_FRESHNESS_TOKEN',
  'AOC_ENTERPRISE_AUTHORITY_FRESHNESS_WITNESS_ID',
  'AOC_ENTERPRISE_AUTHORITY_FRESHNESS_WITNESS_PUBLIC_KEY',
  'AOC_ENTERPRISE_AUTHORITY_FRESHNESS_TIMEOUT_MS',
  'AOC_ENTERPRISE_AUTHORITY_FRESHNESS_MAX_ATTEMPTS',
  'AOC_ENTERPRISE_AUTHORITY_FRESHNESS_PROBE_INTERVAL_MS',
] as const;

/**
 * CORE-07: the strict reading of the authority-freshness variables. One mode,
 * stated explicitly:
 *
 * - `external` without endpoint, credential, pinned witness id or pinned
 *   witness public key is refused;
 * - a witness variable without `external` is refused — never guessed;
 * - the witness credential must not be the external signer's: a different
 *   trust role never shares a credential.
 *
 * Names variables and rules, never values.
 */
function authorityFreshnessEnvironmentProblems(env: Readonly<Record<string, string | undefined>>): readonly string[] {
  const problems: string[] = [];
  const mode = env.AOC_ENTERPRISE_AUTHORITY_FRESHNESS_MODE;
  if (mode !== undefined && mode !== 'none' && mode !== 'external') {
    problems.push('AOC_ENTERPRISE_AUTHORITY_FRESHNESS_MODE must be one of: none, external.');
    return problems;
  }
  if (mode !== 'external') {
    for (const name of AUTHORITY_FRESHNESS_VARIABLES) {
      if (env[name] !== undefined) problems.push(`${name} is set but AOC_ENTERPRISE_AUTHORITY_FRESHNESS_MODE is not 'external'. Refusing to guess whether a freshness witness was meant.`);
    }
    return problems;
  }
  const endpoint = env.AOC_ENTERPRISE_AUTHORITY_FRESHNESS_ENDPOINT;
  if (endpoint === undefined || endpoint.length === 0) {
    problems.push('AOC_ENTERPRISE_AUTHORITY_FRESHNESS_MODE=external requires AOC_ENTERPRISE_AUTHORITY_FRESHNESS_ENDPOINT.');
  } else {
    let url: URL | undefined;
    try {
      url = new URL(endpoint);
    } catch {
      url = undefined;
    }
    if (url === undefined || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
      problems.push('AOC_ENTERPRISE_AUTHORITY_FRESHNESS_ENDPOINT must be an absolute https URL (or http to a loopback address for the local reference witness).');
    } else if (url.protocol === 'http:' && !isLoopbackHostname(url.hostname)) {
      problems.push('AOC_ENTERPRISE_AUTHORITY_FRESHNESS_ENDPOINT uses plain http to a non-loopback address; only https is accepted beyond loopback.');
    } else if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '' || (url.pathname !== '/' && url.pathname !== '')) {
      problems.push('AOC_ENTERPRISE_AUTHORITY_FRESHNESS_ENDPOINT must be a base URL with no credentials, path, query or fragment.');
    }
  }
  const token = env.AOC_ENTERPRISE_AUTHORITY_FRESHNESS_TOKEN;
  if (token === undefined || token.length < 32 || /\s/.test(token)) {
    problems.push('AOC_ENTERPRISE_AUTHORITY_FRESHNESS_MODE=external requires AOC_ENTERPRISE_AUTHORITY_FRESHNESS_TOKEN: a credential of at least 32 characters with no whitespace.');
  } else if (token === env.AOC_ENTERPRISE_AUTHORITY_SIGNER_TOKEN) {
    problems.push('AOC_ENTERPRISE_AUTHORITY_FRESHNESS_TOKEN must not be the external signer credential: the freshness witness and the authority signer are different trust roles.');
  }
  const witnessId = env.AOC_ENTERPRISE_AUTHORITY_FRESHNESS_WITNESS_ID;
  if (witnessId === undefined || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(witnessId)) {
    problems.push('AOC_ENTERPRISE_AUTHORITY_FRESHNESS_MODE=external requires AOC_ENTERPRISE_AUTHORITY_FRESHNESS_WITNESS_ID: 1-128 letters, digits, ".", "_", ":" or "-".');
  }
  const publicKey = env.AOC_ENTERPRISE_AUTHORITY_FRESHNESS_WITNESS_PUBLIC_KEY;
  if (publicKey === undefined || !/-----BEGIN PUBLIC KEY-----/.test(publicKey) || /PRIVATE KEY/.test(publicKey)) {
    problems.push('AOC_ENTERPRISE_AUTHORITY_FRESHNESS_MODE=external requires AOC_ENTERPRISE_AUTHORITY_FRESHNESS_WITNESS_PUBLIC_KEY: the pinned witness Ed25519 public key (SPKI PEM). Never a private key.');
  }
  const timeout = env.AOC_ENTERPRISE_AUTHORITY_FRESHNESS_TIMEOUT_MS;
  if (timeout !== undefined && (!/^\d{1,5}$/.test(timeout) || Number.parseInt(timeout, 10) < 1 || Number.parseInt(timeout, 10) > 60_000)) {
    problems.push('AOC_ENTERPRISE_AUTHORITY_FRESHNESS_TIMEOUT_MS must be an integer from 1 to 60000.');
  }
  const attempts = env.AOC_ENTERPRISE_AUTHORITY_FRESHNESS_MAX_ATTEMPTS;
  if (attempts !== undefined && !['1', '2', '3'].includes(attempts)) problems.push('AOC_ENTERPRISE_AUTHORITY_FRESHNESS_MAX_ATTEMPTS must be 1, 2 or 3.');
  const probeInterval = env.AOC_ENTERPRISE_AUTHORITY_FRESHNESS_PROBE_INTERVAL_MS;
  if (probeInterval !== undefined && (!/^\d{1,5}$/.test(probeInterval) || Number.parseInt(probeInterval, 10) > 60_000)) {
    problems.push('AOC_ENTERPRISE_AUTHORITY_FRESHNESS_PROBE_INTERVAL_MS must be an integer from 0 to 60000.');
  }
  return problems;
}

/** CORE-07: the freshness mode as read from `env`. Absent (or `none`) is `none`. */
function loadAuthorityFreshness(env: Readonly<Record<string, string | undefined>>): NonNullable<EnterpriseConfiguration['authorityFreshness']> {
  if (env.AOC_ENTERPRISE_AUTHORITY_FRESHNESS_MODE !== 'external') return { mode: 'none' };
  const attempts = env.AOC_ENTERPRISE_AUTHORITY_FRESHNESS_MAX_ATTEMPTS;
  const probeInterval = env.AOC_ENTERPRISE_AUTHORITY_FRESHNESS_PROBE_INTERVAL_MS;
  return {
    mode: 'external',
    witness: {
      endpoint: env.AOC_ENTERPRISE_AUTHORITY_FRESHNESS_ENDPOINT ?? '',
      credential: env.AOC_ENTERPRISE_AUTHORITY_FRESHNESS_TOKEN ?? '',
      witnessId: env.AOC_ENTERPRISE_AUTHORITY_FRESHNESS_WITNESS_ID ?? '',
      publicKeyPem: env.AOC_ENTERPRISE_AUTHORITY_FRESHNESS_WITNESS_PUBLIC_KEY ?? '',
      timeoutMs: parsePositiveIntMs(env.AOC_ENTERPRISE_AUTHORITY_FRESHNESS_TIMEOUT_MS, DEFAULT_AUTHORITY_FRESHNESS_TIMEOUT_MS),
      maxAttempts: attempts !== undefined && /^\d+$/.test(attempts) ? Number.parseInt(attempts, 10) : DEFAULT_AUTHORITY_FRESHNESS_MAX_ATTEMPTS,
      probeIntervalMs: probeInterval !== undefined && /^\d+$/.test(probeInterval) ? Number.parseInt(probeInterval, 10) : DEFAULT_AUTHORITY_FRESHNESS_PROBE_INTERVAL_MS,
    },
  };
}

/**
 * CORE-02: the authority-signer custody as read from `env`. In `external`
 * mode `AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_PEM` is **never read** into the
 * configuration — only whether it was present, so composition can refuse the
 * contradiction instead of ignoring a key that is still in the environment.
 */
function loadAuthorityAuthenticity(env: Readonly<Record<string, string | undefined>>): EnterpriseConfiguration['authorityAuthenticity'] {
  const verificationKeys = parseAuthorityVerificationKeys(env.AOC_ENTERPRISE_AUTHORITY_VERIFICATION_KEYS);
  if (env.AOC_ENTERPRISE_AUTHORITY_SIGNER_MODE === 'external') {
    const attempts = env.AOC_ENTERPRISE_AUTHORITY_SIGNER_MAX_ATTEMPTS;
    const probeInterval = env.AOC_ENTERPRISE_AUTHORITY_SIGNER_PROBE_INTERVAL_MS;
    return {
      mode: 'external',
      activeSigningKeyId: env.AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_ID,
      verificationKeys,
      externalSigner: {
        endpoint: env.AOC_ENTERPRISE_AUTHORITY_SIGNER_ENDPOINT ?? '',
        credential: env.AOC_ENTERPRISE_AUTHORITY_SIGNER_TOKEN ?? '',
        timeoutMs: parsePositiveIntMs(env.AOC_ENTERPRISE_AUTHORITY_SIGNER_TIMEOUT_MS, DEFAULT_EXTERNAL_SIGNER_TIMEOUT_MS),
        maxAttempts: attempts !== undefined && /^\d+$/.test(attempts) ? Number.parseInt(attempts, 10) : DEFAULT_EXTERNAL_SIGNER_MAX_ATTEMPTS,
        probeIntervalMs: probeInterval !== undefined && /^\d+$/.test(probeInterval) ? Number.parseInt(probeInterval, 10) : DEFAULT_EXTERNAL_SIGNER_PROBE_INTERVAL_MS,
      },
      conflictingSigningKeyPresent: env.AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_PEM !== undefined,
    };
  }
  return {
    activeSigningKeyId: env.AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_ID,
    signingKeyPem: env.AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_PEM,
    verificationKeys,
  };
}

/**
 * Reads `env` (defaults to `process.env`) into a fully-resolved
 * `EnterpriseConfiguration`. Every field has a local-dev-friendly default so
 * an embedder can compose with zero configuration. Lenient by design; the
 * Enterprise Host bootstrap applies `validateEnterpriseEnvironment` and its
 * secure-profile rules on top (`host/enterprise-host.ts`).
 */
export function loadEnterpriseConfiguration(env: Readonly<Record<string, string | undefined>> = process.env): EnterpriseConfiguration {
  return {
    environment: parseEnvironment(env.AOC_ENTERPRISE_ENV),
    enterpriseVersion: env.AOC_ENTERPRISE_VERSION ?? AOC_ENTERPRISE_HOST_VERSION,
    logLevel: (env.AOC_ENTERPRISE_LOG_LEVEL as EnterpriseConfiguration['logLevel'] | undefined) ?? 'info',
    persistence: {
      provider: env.AOC_ENTERPRISE_PERSISTENCE_PROVIDER === 'sqlite' ? 'sqlite' : 'memory',
      sqlitePath: env.AOC_ENTERPRISE_SQLITE_PATH ?? '.data/enterprise-host.sqlite',
      busyTimeoutMs: parsePositiveIntMs(env.AOC_ENTERPRISE_STORE_BUSY_TIMEOUT_MS, 5_000),
      limits: {
        maxRequestPayloadBytes: parsePositiveIntMs(env.AOC_ENTERPRISE_STORE_MAX_REQUEST_PAYLOAD_BYTES, 262_144),
        maxResultPayloadBytes: parsePositiveIntMs(env.AOC_ENTERPRISE_STORE_MAX_RESULT_PAYLOAD_BYTES, 524_288),
        maxEventPayloadBytes: parsePositiveIntMs(env.AOC_ENTERPRISE_STORE_MAX_EVENT_PAYLOAD_BYTES, 65_536),
        maxTraceSteps: parsePositiveIntMs(env.AOC_ENTERPRISE_STORE_MAX_TRACE_STEPS, 500),
      },
    },
    eventPublishing: {
      enabled: parseBoolean(env.AOC_ENTERPRISE_EVENTS_ENABLED, true),
    },
    telemetry: {
      enabled: parseBoolean(env.AOC_ENTERPRISE_TELEMETRY_ENABLED, true),
    },
    authentication: {
      apiKeys: parseApiKeys(env.AOC_ENTERPRISE_API_KEYS),
    },
    features: {
      traceLevel: env.AOC_ENTERPRISE_TRACE_LEVEL === 'full' ? 'full' : 'basic',
      requireAuthentication: parseBoolean(env.AOC_ENTERPRISE_REQUIRE_AUTH, false),
    },
    http: {
      port: Number.parseInt(env.AOC_ENTERPRISE_HTTP_PORT ?? '8787', 10),
      // Loopback unless an operator says otherwise. A network-facing bind is a
      // deployment decision, and the Enterprise Host bootstrap refuses one
      // without authentication (PROD-01; NB-005).
      host: env.AOC_ENTERPRISE_HTTP_HOST ?? '127.0.0.1',
    },
    lifecycle: {
      startupTimeoutMs: parsePositiveIntMs(env.AOC_ENTERPRISE_STARTUP_TIMEOUT_MS, 30_000),
      shutdownTimeoutMs: parsePositiveIntMs(env.AOC_ENTERPRISE_SHUTDOWN_TIMEOUT_MS, 30_000),
      healthCheckTimeoutMs: parsePositiveIntMs(env.AOC_ENTERPRISE_HEALTH_CHECK_TIMEOUT_MS, 5_000),
    },
    passport: {
      sqlitePath: env.AOC_ENTERPRISE_PASSPORT_SQLITE_PATH ?? '.data/agent-passport.sqlite',
      required: parseBoolean(env.AOC_ENTERPRISE_PASSPORT_REQUIRED, false),
    },
    kernelAuthority: {
      enabled: parseBoolean(env.AOC_ENTERPRISE_KERNEL_AUTHORITY_ENABLED, false),
      organizationId: env.AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID ?? 'default',
      sqlitePath: env.AOC_ENTERPRISE_KERNEL_AUTHORITY_SQLITE_PATH ?? '.data/kernel-authority.sqlite',
      // Defaults to required, unlike Passport and Assurance: an authority
      // source that is silently absent is not a degraded feature, it is a Host
      // answering out of a world it cannot verify.
      required: parseBoolean(env.AOC_ENTERPRISE_KERNEL_AUTHORITY_REQUIRED, true),
    },
    boundedGrant: {
      sqlitePath: env.AOC_ENTERPRISE_BOUNDED_GRANT_SQLITE_PATH ?? '.data/bounded-grants.sqlite',
    },
    emergencyControl: {
      sqlitePath: env.AOC_ENTERPRISE_EMERGENCY_CONTROL_SQLITE_PATH ?? '.data/emergency-controls.sqlite',
    },
    exerciseLedger: {
      sqlitePath: env.AOC_ENTERPRISE_EXERCISE_LEDGER_SQLITE_PATH ?? '.data/exercise-ledger.sqlite',
    },
    authorityEventStream: {
      sqlitePath: env.AOC_ENTERPRISE_AUTHORITY_EVENT_STREAM_SQLITE_PATH ?? '.data/authority-event-stream.sqlite',
    },
    executionOutcome: {
      sqlitePath: env.AOC_ENTERPRISE_EXECUTION_OUTCOME_SQLITE_PATH ?? '.data/execution-outcomes.sqlite',
    },
    obligationDischarge: {
      sqlitePath: env.AOC_ENTERPRISE_OBLIGATION_DISCHARGE_SQLITE_PATH ?? '.data/obligation-discharges.sqlite',
    },
    approval: {
      sqlitePath: env.AOC_ENTERPRISE_APPROVAL_SQLITE_PATH ?? '.data/approvals.sqlite',
    },
    executionResolution: {
      sqlitePath: env.AOC_ENTERPRISE_EXECUTION_RESOLUTION_SQLITE_PATH ?? '.data/execution-resolutions.sqlite',
    },
    authorityAuthenticity: loadAuthorityAuthenticity(env),
    authorityFreshness: loadAuthorityFreshness(env),
    assurance: {
      sqlitePath: env.AOC_ENTERPRISE_ASSURANCE_SQLITE_PATH ?? '.data/assurance.sqlite',
      required: parseBoolean(env.AOC_ENTERPRISE_ASSURANCE_REQUIRED, false),
    },
  };
}

/**
 * The redacted, secret-free view of `EnterpriseConfiguration` (R004.B). This
 * is the shape exposed on the public `AocEnterprise.configuration` surface --
 * every field a legitimate embedder needs (environment, ports, feature
 * flags, timeouts) with `authentication.apiKeys` replaced by a non-secret
 * count and per-key organization scoping. Never carries `EnterpriseApiKey.key`.
 */
export type PublicEnterpriseConfiguration = Omit<EnterpriseConfiguration, 'authentication' | 'authorityAuthenticity' | 'authorityFreshness' | 'administration'> & {
  /** CORE-07: the freshness mode and, for `external`, the pinned witness identity and bounds — the origin only, never the credential. */
  readonly authorityFreshness: {
    readonly mode: 'none' | 'external';
    readonly witness?: {
      readonly origin: string;
      readonly witnessId: string;
      readonly timeoutMs: number;
      readonly maxAttempts: number;
      readonly probeIntervalMs: number;
      /** Whether a witness credential is configured. A boolean, never the credential. */
      readonly credentialConfigured: boolean;
    };
  };
  /** CTRL-01: how many administrators are configured. A count, never an identity or a secret. */
  readonly administration: { readonly administratorCount: number };
  readonly authentication: {
    readonly requireAuthentication: boolean;
    readonly apiKeyCount: number;
    /** Non-secret: which configured keys are organization-scoped, in configured order. Never the key values themselves. */
    readonly apiKeyOrganizationScopes: readonly (string | undefined)[];
  };
  /**
   * The authenticity boundary, minus the one field that must never leave the
   * composition root.
   *
   * The signing key is **absent from this type**, not merely omitted at runtime:
   * there is no property on the public configuration a private authority signing
   * key could be assigned to, so a future edit that tried to pass one through
   * would not compile. The verification keys stay — they are public material by
   * construction, and a deployment that can see which key ids it trusts can
   * diagnose a rotation without being handed the ability to sign.
   */
  readonly authorityAuthenticity: {
    /** CORE-02: which custody signs: `software` (a key in this process) or `external` (none). */
    readonly signerMode: 'software' | 'external';
    readonly activeSigningKeyId: string | undefined;
    /** Whether a signing key is configured at all. A boolean, never the key. Always `false` under external custody. */
    readonly signingKeyConfigured: boolean;
    readonly verificationKeys: readonly { readonly keyId: string; readonly algorithm: string; readonly publicKeyPem: string }[];
    /** CORE-02, external custody only: where signatures come from, and the bounds on asking. The origin only — never a credential. */
    readonly externalSigner?: {
      readonly origin: string;
      readonly timeoutMs: number;
      readonly maxAttempts: number;
      readonly probeIntervalMs: number;
      /** Whether a service credential is configured. A boolean, never the credential. */
      readonly credentialConfigured: boolean;
    };
  };
};

/**
 * Strips every raw secret out of a resolved `EnterpriseConfiguration`,
 * producing the safe shape `AocEnterprise.configuration` actually exposes.
 * The full, secret-bearing `EnterpriseConfiguration` never leaves the
 * composition root / trusted in-process adapters (see
 * `composition-root.ts`'s `getInternalEnterpriseConfiguration`).
 */
export function toPublicEnterpriseConfiguration(config: EnterpriseConfiguration): PublicEnterpriseConfiguration {
  // `authorityAuthenticity` is destructured out alongside `authentication` so
  // the private signing key is removed by *construction* rather than by an
  // overwrite that a later spread could undo.
  const { authentication, authorityAuthenticity, authorityFreshness, administration, ...rest } = config;
  return {
    ...rest,
    authorityFreshness:
      authorityFreshness?.mode === 'external'
        ? {
            mode: 'external',
            witness: {
              origin: originOf(authorityFreshness.witness.endpoint),
              witnessId: authorityFreshness.witness.witnessId,
              timeoutMs: authorityFreshness.witness.timeoutMs,
              maxAttempts: authorityFreshness.witness.maxAttempts,
              probeIntervalMs: authorityFreshness.witness.probeIntervalMs,
              credentialConfigured: authorityFreshness.witness.credential.length > 0,
            },
          }
        : { mode: 'none' },
    administration: { administratorCount: administration?.administrators.length ?? 0 },
    authentication: {
      requireAuthentication: config.features.requireAuthentication,
      apiKeyCount: authentication.apiKeys.length,
      apiKeyOrganizationScopes: authentication.apiKeys.map((apiKey) => apiKey.organizationId),
    },
    authorityAuthenticity:
      authorityAuthenticity.mode === 'external'
        ? {
            signerMode: 'external',
            activeSigningKeyId: authorityAuthenticity.activeSigningKeyId,
            signingKeyConfigured: false,
            verificationKeys: authorityAuthenticity.verificationKeys,
            externalSigner: {
              origin: originOf(authorityAuthenticity.externalSigner.endpoint),
              timeoutMs: authorityAuthenticity.externalSigner.timeoutMs,
              maxAttempts: authorityAuthenticity.externalSigner.maxAttempts,
              probeIntervalMs: authorityAuthenticity.externalSigner.probeIntervalMs,
              credentialConfigured: authorityAuthenticity.externalSigner.credential.length > 0,
            },
          }
        : {
            signerMode: 'software',
            activeSigningKeyId: authorityAuthenticity.activeSigningKeyId,
            signingKeyConfigured: authorityAuthenticity.signingKeyPem !== undefined,
            verificationKeys: authorityAuthenticity.verificationKeys,
          },
  };
}

/** The scheme, host and port of an endpoint — never a path, query, fragment or userinfo, any of which could hold a secret by mistake. */
function originOf(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    return url.origin === 'null' ? 'invalid' : url.origin;
  } catch {
    return 'invalid';
  }
}

/**
 * A short, stable checksum of the resolved configuration (never the raw
 * values -- `apiKeys` are secrets) so `/health` can report "configuration
 * changed since last deploy" without leaking what changed.
 */
export function computeConfigurationChecksum(config: EnterpriseConfiguration): string {
  const shape = {
    environment: config.environment,
    enterpriseVersion: config.enterpriseVersion,
    logLevel: config.logLevel,
    persistenceProvider: config.persistence.provider,
    eventsEnabled: config.eventPublishing.enabled,
    telemetryEnabled: config.telemetry.enabled,
    apiKeyCount: config.authentication.apiKeys.length,
    traceLevel: config.features.traceLevel,
    requireAuthentication: config.features.requireAuthentication,
    passportRequired: config.passport.required,
    assuranceRequired: config.assurance.required,
    kernelAuthorityEnabled: config.kernelAuthority.enabled,
    kernelAuthorityOrganizationId: config.kernelAuthority.organizationId,
    kernelAuthorityRequired: config.kernelAuthority.required,
  };
  const serialized = JSON.stringify(shape);
  let hash = 0;
  for (let i = 0; i < serialized.length; i += 1) {
    hash = (Math.imul(31, hash) + serialized.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16);
}
