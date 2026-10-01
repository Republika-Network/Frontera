import { readFileSync } from 'node:fs';

import {
  loadEnterpriseConfiguration,
  validateEnterpriseEnvironment,
  type EnterpriseAdministrator,
  type EnterpriseApiKey,
  type EnterpriseConfiguration,
  type EnterpriseOperator,
} from '../configuration/enterprise-configuration.js';
import { OPERATOR_ROLES, isOperatorRole } from '../operator-control/roles.js';
import type { EnterpriseGenericHttpCredential, EnterpriseGenericHttpExecutionAdapterOptions } from '../execution-adapters/generic-http/index.js';
import { GovernanceProfileConfigurationError, createGovernanceProfileRegistry, type GovernanceConfiguration } from '../governance-profile/index.js';
import { GovernedActionConfigurationError } from '../governed-action/errors.js';
import { composeGovernedTrust, type ObligationConfiguration, type TrustedContextConfiguration } from '../trusted-context/index.js';
import type { MonetaryAssetDefinition } from '../../features/monetary-runtime/index.js';

/**
 * The Enterprise Host's configuration: the environment
 * (`loadEnterpriseConfiguration`, unchanged) plus the one thing the
 * environment cannot express — the governed-action deployment.
 *
 * ```
 * environment ──► EnterpriseConfiguration ─┐
 *                                          ├─► EnterpriseHostConfiguration ──► bootEnterpriseHost ──► createEnterprise
 * AOC_ENTERPRISE_GOVERNED_ACTIONS_FILE ────┘
 * ```
 *
 * The governed-action file holds structure (trust domain, customer principals,
 * Generic HTTP mappings, routes), never secrets. Every secret it needs — a
 * customer API key, a provider credential — is named by the environment
 * variable that holds it (`apiKeyEnv`, `tokenEnv`, `valueEnv`). A file that
 * carries a secret inline is refused, so the file can be reviewed, versioned
 * and backed up as configuration.
 *
 * See `docs/enterprise/AOC_ENTERPRISE_HOST.md` §"Secure production host".
 */

export type EnterpriseHostConfigurationErrorCode =
  | 'HOST_ENVIRONMENT_INVALID'
  | 'HOST_GOVERNED_ACTIONS_FILE_UNREADABLE'
  | 'HOST_GOVERNED_ACTIONS_FILE_INVALID'
  | 'HOST_SECRET_REFERENCE_UNRESOLVED'
  | 'HOST_UNAUTHENTICATED_NETWORK_BIND'
  | 'HOST_CREDENTIALS_MISSING'
  | 'HOST_CREDENTIALS_AMBIGUOUS'
  | 'HOST_ADMINISTRATOR_INVALID'
  | 'HOST_OPERATOR_INVALID'
  | 'HOST_PERSISTENCE_NOT_DURABLE'
  | 'HOST_AUTHENTICATION_REQUIRED'
  | 'HOST_GOVERNED_ACTIONS_REQUIRED'
  | 'HOST_KERNEL_AUTHORITY_REQUIRED'
  | 'HOST_AUTHORITY_SIGNING_KEY_REQUIRED'
  | 'HOST_AUTHORITY_FRESHNESS_REQUIRED'
  | 'HOST_EXECUTION_ROUTE_INVALID'
  | 'HOST_COMPOSITION_INCOMPLETE'
  | 'HOST_NOT_HEALTHY';

/** A deployment defect the Host refuses to start with. Messages name variables, fields and codes — never a value. */
export class EnterpriseHostConfigurationError extends Error {
  constructor(
    readonly code: EnterpriseHostConfigurationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'EnterpriseHostConfigurationError';
  }
}

export function isEnterpriseHostConfigurationError(error: unknown): error is EnterpriseHostConfigurationError {
  return error instanceof EnterpriseHostConfigurationError;
}

/** One customer principal: who a customer-plane credential authenticates as. The key itself is resolved from `apiKeyEnv`. */
export interface EnterpriseHostCustomerPrincipal {
  readonly principalId: string;
  readonly externalSubject: { readonly system: string; readonly subjectId: string };
}

/** The resolved governed-action deployment. Secrets are resolved; nothing here came from a caller. */
export interface EnterpriseHostGovernedActionConfiguration {
  readonly trustDomainId: string;
  /** Bounded-grant lifetime, anchored on the committed decision. 1 … 3600 seconds. */
  readonly grantLifetimeSeconds: number;
  readonly customerPrincipals: readonly EnterpriseHostCustomerPrincipal[];
  readonly monetary: { readonly assets: readonly MonetaryAssetDefinition[]; readonly financialActions: readonly string[] };
  /**
   * CORE-03 — the governed-action semantic model (parameter dimensions, action
   * and resource classes, Governance Profiles). Validated in full here, so a
   * malformed profile refuses startup; absent, nothing is classified.
   */
  readonly governance?: GovernanceConfiguration;
  /**
   * CORE-04 — the trusted context source registry: which source may attest
   * which fact classes, for this organization, with what freshness. Validated
   * in full here (and again at composition), so a malformed or over-broad
   * source refuses startup. The retrieval side — the context provider — is
   * trusted in-process composition (`BootEnterpriseHostOptions.contextProvider`),
   * never file content.
   */
  readonly trustedContext?: TrustedContextConfiguration;
  /** CORE-04 — the obligation discharge sources, validated here. */
  readonly obligations?: ObligationConfiguration;
  readonly genericHttpAdapters: readonly EnterpriseGenericHttpExecutionAdapterOptions[];
  /** Trusted routing: governed action → adapter id. An action with no route is authorized by nothing and reaches no adapter. */
  readonly routes: ReadonlyMap<string, string>;
  /**
   * CTRL-02 — `operator-promoted`: the file's Governance Profiles are a
   * catalog of versions, and only the version an identified operator
   * activated (durably, through `/api/admin/governance-profiles/...`)
   * resolves. Absent: every configured profile is active, as before.
   */
  readonly profileLifecycle?: 'operator-promoted';
}

export interface EnterpriseHostConfiguration {
  /** The full configuration, with customer-principal credentials merged into `authentication.apiKeys`. */
  readonly configuration: EnterpriseConfiguration;
  readonly governedActions: EnterpriseHostGovernedActionConfiguration | undefined;
  /** `production` or `staging`: the durable, authenticated, governed profile is mandatory. */
  readonly secureProfile: boolean;
}

export const GOVERNED_ACTIONS_FILE_VARIABLE = 'AOC_ENTERPRISE_GOVERNED_ACTIONS_FILE';
export const MAX_GRANT_LIFETIME_SECONDS = 3600;
/**
 * CTRL-01: the shortest administrator secret the Host accepts. An administrator
 * credential can revoke authority and stop execution for the whole deployment,
 * so a short or guessable one is a deployment defect, refused at boot.
 */
export const MIN_ADMINISTRATOR_SECRET_LENGTH = 32;
const OPERATOR_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const SECURE_ENVIRONMENTS = new Set(['production', 'staging']);

type Env = Readonly<Record<string, string | undefined>>;

function invalid(message: string): never {
  throw new EnterpriseHostConfigurationError('HOST_GOVERNED_ACTIONS_FILE_INVALID', `${GOVERNED_ACTIONS_FILE_VARIABLE}: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function closedKeys(value: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) invalid(`${where} has unsupported field '${key}'. Allowed: ${allowed.join(', ')}.`);
  }
}

function text(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim() !== value) invalid(`${where} must be a non-empty string without surrounding whitespace.`);
  return value;
}

function array(value: unknown, where: string): readonly unknown[] {
  if (!Array.isArray(value)) invalid(`${where} must be an array.`);
  return value;
}

/** Resolves a secret by the name of the variable that holds it. The error names the variable, never a value. */
function secretFrom(env: Env, name: unknown, where: string): string {
  if (typeof name !== 'string' || !ENV_NAME.test(name)) invalid(`${where} must name an environment variable (uppercase letters, digits and underscores).`);
  const value = env[name];
  if (value === undefined || value.length === 0) {
    throw new EnterpriseHostConfigurationError('HOST_SECRET_REFERENCE_UNRESOLVED', `${where} names environment variable '${name}', which is not set or is empty.`);
  }
  return value;
}

function parseCredential(env: Env, value: unknown, where: string): EnterpriseGenericHttpCredential {
  if (!isRecord(value)) invalid(`${where} must be an object.`);
  if (value.kind === 'bearer') {
    closedKeys(value, ['kind', 'tokenEnv'], where);
    return { kind: 'bearer', token: secretFrom(env, value.tokenEnv, `${where}.tokenEnv`) };
  }
  if (value.kind === 'header') {
    closedKeys(value, ['kind', 'name', 'valueEnv'], where);
    return { kind: 'header', name: text(value.name, `${where}.name`), value: secretFrom(env, value.valueEnv, `${where}.valueEnv`) };
  }
  return invalid(`${where}.kind must be 'bearer' or 'header'. Inline secrets are not accepted; reference an environment variable.`);
}

interface ParsedGovernedActionsFile {
  readonly governedActions: EnterpriseHostGovernedActionConfiguration;
  /** Resolved customer secrets, kept off `governedActions` so the returned configuration object carries none. */
  readonly customerKeys: readonly { readonly principal: EnterpriseHostCustomerPrincipal; readonly apiKey: string }[];
  /** CTRL-01: resolved administrator credentials. Kept apart from every ordinary credential. */
  readonly administrators: readonly EnterpriseAdministrator[];
  /** CTRL-02: resolved operator credentials, each with one role from the closed model. Kept apart from every ordinary credential. */
  readonly operators: readonly EnterpriseOperator[];
}

function administratorInvalid(message: string): never {
  throw new EnterpriseHostConfigurationError('HOST_ADMINISTRATOR_INVALID', `${GOVERNED_ACTIONS_FILE_VARIABLE}: ${message}`);
}

/**
 * CTRL-01: `administrators` — who may administer authority through
 * `/api/admin/...`. Optional: absent, the administration API is not mounted.
 * Each entry names a stable operator id (the identity every mutation is
 * recorded under) and the environment variable holding its secret.
 */
function parseAdministrators(env: Env, value: unknown): readonly EnterpriseAdministrator[] {
  if (value === undefined) return [];
  const entries = array(value, 'administrators');
  if (entries.length === 0) invalid('administrators must name at least one administrator when present; omit it to leave the administration API unmounted.');
  const seen = new Set<string>();
  return entries.map((entry, index) => {
    const where = `administrators[${index}]`;
    if (!isRecord(entry)) invalid(`${where} must be an object.`);
    closedKeys(entry, ['operatorId', 'apiKeyEnv'], where);
    const operatorId = text(entry.operatorId, `${where}.operatorId`);
    if (!OPERATOR_ID.test(operatorId)) invalid(`${where}.operatorId must be 1-128 letters, digits, '.', '_' or '-', starting with a letter or digit.`);
    if (seen.has(operatorId)) invalid(`${where}.operatorId '${operatorId}' is declared twice; one operator has one identity.`);
    seen.add(operatorId);
    const key = secretFrom(env, entry.apiKeyEnv, `${where}.apiKeyEnv`);
    if (key.length < MIN_ADMINISTRATOR_SECRET_LENGTH || key.trim() !== key) {
      administratorInvalid(`${where}.apiKeyEnv names a secret shorter than ${MIN_ADMINISTRATOR_SECRET_LENGTH} characters or with surrounding whitespace. An administrator credential must be a long random secret.`);
    }
    return { operatorId, key };
  });
}

function operatorInvalid(message: string): never {
  throw new EnterpriseHostConfigurationError('HOST_OPERATOR_INVALID', `${GOVERNED_ACTIONS_FILE_VARIABLE}: ${message}`);
}

/**
 * CTRL-02: `operators` — identified human operators of the operator plane.
 * Optional. Each names a stable operator id (the identity every write is
 * attributed to), exactly one role from the closed operator role model, and the
 * environment variable holding its secret. An operator id is one identity: it
 * may not also be a CTRL-01 administrator.
 */
function parseOperators(env: Env, value: unknown, administrators: readonly EnterpriseAdministrator[]): readonly EnterpriseOperator[] {
  if (value === undefined) return [];
  const entries = array(value, 'operators');
  if (entries.length === 0) invalid('operators must name at least one operator when present; omit it to configure none.');
  const seen = new Set<string>(administrators.map((administrator) => administrator.operatorId));
  return entries.map((entry, index) => {
    const where = `operators[${index}]`;
    if (!isRecord(entry)) invalid(`${where} must be an object.`);
    closedKeys(entry, ['operatorId', 'role', 'apiKeyEnv'], where);
    const operatorId = text(entry.operatorId, `${where}.operatorId`);
    if (!OPERATOR_ID.test(operatorId)) operatorInvalid(`${where}.operatorId must be 1-128 letters, digits, '.', '_' or '-', starting with a letter or digit.`);
    if (seen.has(operatorId)) operatorInvalid(`${where}.operatorId '${operatorId}' is declared twice (operators and administrators share one identity space); one operator has one identity.`);
    seen.add(operatorId);
    if (!isOperatorRole(entry.role)) operatorInvalid(`${where}.role must be one of: ${OPERATOR_ROLES.join(', ')}.`);
    const key = secretFrom(env, entry.apiKeyEnv, `${where}.apiKeyEnv`);
    if (key.length < MIN_ADMINISTRATOR_SECRET_LENGTH || key.trim() !== key) {
      operatorInvalid(`${where}.apiKeyEnv names a secret shorter than ${MIN_ADMINISTRATOR_SECRET_LENGTH} characters or with surrounding whitespace. An operator credential must be a long random secret.`);
    }
    return { operatorId, role: entry.role, key };
  });
}

function parseGovernedActionsFile(env: Env, path: string, organizationId: string): ParsedGovernedActionsFile {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new EnterpriseHostConfigurationError('HOST_GOVERNED_ACTIONS_FILE_UNREADABLE', `${GOVERNED_ACTIONS_FILE_VARIABLE} names '${path}', which could not be read.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Never echo the content: a mistake may have pasted a secret into it.
    invalid('the file is not valid JSON.');
  }
  if (!isRecord(parsed)) invalid('the file must contain a JSON object.');
  closedKeys(
    parsed,
    ['version', 'trustDomainId', 'grantLifetimeSeconds', 'customerPrincipals', 'administrators', 'operators', 'profileLifecycle', 'monetary', 'governance', 'trustedContext', 'obligations', 'genericHttpAdapters', 'routes'],
    'the file',
  );
  if (parsed.version !== 1) invalid('version must be 1.');

  const trustDomainId = text(parsed.trustDomainId, 'trustDomainId');
  const lifetime = parsed.grantLifetimeSeconds;
  if (typeof lifetime !== 'number' || !Number.isInteger(lifetime) || lifetime < 1 || lifetime > MAX_GRANT_LIFETIME_SECONDS) {
    invalid(`grantLifetimeSeconds must be an integer from 1 to ${MAX_GRANT_LIFETIME_SECONDS}.`);
  }

  const customerPrincipals = array(parsed.customerPrincipals, 'customerPrincipals').map((entry, index) => {
    const where = `customerPrincipals[${index}]`;
    if (!isRecord(entry)) invalid(`${where} must be an object.`);
    closedKeys(entry, ['principalId', 'externalSubject', 'apiKeyEnv'], where);
    if (!isRecord(entry.externalSubject)) invalid(`${where}.externalSubject must be an object.`);
    closedKeys(entry.externalSubject, ['system', 'subjectId'], `${where}.externalSubject`);
    const principal: EnterpriseHostCustomerPrincipal = {
      principalId: text(entry.principalId, `${where}.principalId`),
      externalSubject: { system: text(entry.externalSubject.system, `${where}.externalSubject.system`), subjectId: text(entry.externalSubject.subjectId, `${where}.externalSubject.subjectId`) },
    };
    return { principal, apiKey: secretFrom(env, entry.apiKeyEnv, `${where}.apiKeyEnv`) };
  });
  const administrators = parseAdministrators(env, parsed.administrators);
  const operators = parseOperators(env, parsed.operators, administrators);
  // CTRL-02: with operators configured, agents are onboarded by identified
  // operators (operator-issued credentials), so the file may name no static
  // customer principal at all.
  if (customerPrincipals.length === 0 && operators.length === 0) {
    invalid('customerPrincipals must name at least one principal (or configure operators, who onboard agents); governed actions act only for a bound customer identity.');
  }

  let profileLifecycle: 'operator-promoted' | undefined;
  if (parsed.profileLifecycle !== undefined) {
    if (parsed.profileLifecycle !== 'operator-promoted') invalid("profileLifecycle must be 'operator-promoted' when present.");
    if (!operators.some((operator) => operator.role === 'profile-steward' || operator.role === 'organization-administrator')) {
      operatorInvalid("profileLifecycle 'operator-promoted' needs at least one operator whose role may promote a profile (profile-steward or organization-administrator); otherwise no profile could ever become active.");
    }
    profileLifecycle = 'operator-promoted';
  }
  const lifecycleOption = profileLifecycle !== undefined ? { lifecycle: { activeVersion: () => undefined } } : {};

  let monetary: EnterpriseHostGovernedActionConfiguration['monetary'] = { assets: [], financialActions: [] };
  if (parsed.monetary !== undefined) {
    if (!isRecord(parsed.monetary)) invalid('monetary must be an object.');
    closedKeys(parsed.monetary, ['assets', 'financialActions'], 'monetary');
    // Shape only; the monetary registry validates identity and scale at composition.
    monetary = {
      assets: array(parsed.monetary.assets ?? [], 'monetary.assets') as readonly MonetaryAssetDefinition[],
      financialActions: array(parsed.monetary.financialActions ?? [], 'monetary.financialActions').map((action, index) => text(action, `monetary.financialActions[${index}]`)),
    };
  }

  // CORE-03: validated completely, now, by the same registry builder the
  // composition root runs — so a profile that could not be believed stops the
  // Host at startup with a configuration error, never at the first request.
  let governance: GovernanceConfiguration | undefined;
  if (parsed.governance !== undefined) {
    if (!isRecord(parsed.governance)) invalid('governance must be an object.');
    try {
      createGovernanceProfileRegistry(parsed.governance as GovernanceConfiguration, lifecycleOption);
    } catch (error) {
      if (error instanceof GovernanceProfileConfigurationError) invalid(`governance: ${error.message}`);
      throw error;
    }
    governance = parsed.governance as GovernanceConfiguration;
  }
  if (profileLifecycle !== undefined && (governance?.profiles ?? []).length === 0) {
    invalid("profileLifecycle 'operator-promoted' needs governance.profiles: the catalog of versions an operator may promote.");
  }

  // CORE-04: the trusted source registry and the obligation discharge sources,
  // validated completely now — against the one organization this Host serves
  // and the fact classes and obligations its profiles declare — by the same
  // builder the composition root runs. A profile that declares a fact no source
  // may attest, a source scoped to another organization, an attestation with no
  // freshness bound, or obligations nothing can discharge, stops the Host here.
  // (Whether a context provider and a policy are composed is the composition's
  // question: they are in-process inputs, not file content.)
  const trustedContext = parsed.trustedContext as TrustedContextConfiguration | undefined;
  const obligations = parsed.obligations as ObligationConfiguration | undefined;
  try {
    composeGovernedTrust({
      governance: createGovernanceProfileRegistry(governance, lifecycleOption),
      organizationId,
      ...(trustedContext !== undefined ? { trustedContext, contextProvider: { resolveContext: () => Promise.resolve({ observations: [] }) } } : {}),
      ...(obligations !== undefined ? { obligations } : {}),
      policyComposed: true,
    });
  } catch (error) {
    if (error instanceof GovernedActionConfigurationError) invalid(`${error.code}: ${error.message}`);
    throw error;
  }

  // Everything but the credential is handed to the Generic HTTP adapter's own
  // snapshot validation at composition, which refuses unknown keys, non-HTTPS
  // origins, redirects and private-network options.
  const genericHttpAdapters = array(parsed.genericHttpAdapters ?? [], 'genericHttpAdapters').map((entry, index) => {
    const where = `genericHttpAdapters[${index}]`;
    if (!isRecord(entry)) invalid(`${where} must be an object.`);
    const { credential, ...rest } = entry;
    return {
      ...(rest as unknown as EnterpriseGenericHttpExecutionAdapterOptions),
      ...(credential !== undefined ? { credential: parseCredential(env, credential, `${where}.credential`) } : {}),
    };
  });

  const routes = new Map<string, string>();
  array(parsed.routes, 'routes').forEach((entry, index) => {
    const where = `routes[${index}]`;
    if (!isRecord(entry)) invalid(`${where} must be an object.`);
    closedKeys(entry, ['action', 'adapterId'], where);
    const action = text(entry.action, `${where}.action`);
    if (routes.has(action)) invalid(`${where} routes action '${action}' a second time; one action reaches one adapter.`);
    routes.set(action, text(entry.adapterId, `${where}.adapterId`));
  });

  return {
    governedActions: {
      trustDomainId,
      grantLifetimeSeconds: lifetime as number,
      customerPrincipals: customerPrincipals.map(({ principal }) => principal),
      monetary,
      ...(governance !== undefined ? { governance } : {}),
      ...(trustedContext !== undefined ? { trustedContext } : {}),
      ...(obligations !== undefined ? { obligations } : {}),
      genericHttpAdapters,
      routes,
      ...(profileLifecycle !== undefined ? { profileLifecycle } : {}),
    },
    customerKeys: customerPrincipals,
    administrators,
    operators,
  };
}

function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/**
 * Reads, validates and resolves the Enterprise Host's configuration, or
 * refuses with a precise, secret-free `EnterpriseHostConfigurationError`.
 *
 * Rules for every environment:
 * - every recognized variable parses strictly (no silent downgrade);
 * - a Host without authentication binds loopback only;
 * - required authentication needs at least one credential;
 * - governed actions need the durable Kernel Authority source.
 *
 * Additional rules for the secure profile (`AOC_ENTERPRISE_ENV` = `production`
 * or `staging`): SQLite persistence, required authentication, the
 * governed-action file, a required Kernel Authority source, a configured
 * authority signer — software or external custody (CORE-02) — and an external
 * authority-state freshness witness (CORE-07). A secure Host is Frontera's
 * governed-action control plane or it does not start.
 */
export function loadEnterpriseHostConfiguration(env: Env): EnterpriseHostConfiguration {
  const problems = validateEnterpriseEnvironment(env);
  if (problems.length > 0) throw new EnterpriseHostConfigurationError('HOST_ENVIRONMENT_INVALID', `The environment is invalid: ${problems.join(' ')}`);

  const base = loadEnterpriseConfiguration(env);
  const secureProfile = SECURE_ENVIRONMENTS.has(base.environment);
  const file = env[GOVERNED_ACTIONS_FILE_VARIABLE];
  const parsed = file !== undefined && file.trim().length > 0 ? parseGovernedActionsFile(env, file, base.kernelAuthority.organizationId) : undefined;
  const governed = parsed?.governedActions;

  // A customer principal belongs to the one organization this instance serves.
  const customerKeys: readonly EnterpriseApiKey[] = (parsed?.customerKeys ?? []).map(({ principal, apiKey }) => ({
    key: apiKey,
    organizationId: base.kernelAuthority.organizationId,
    customerIdentity: { principalId: principal.principalId, externalSubject: principal.externalSubject },
  }));
  // Administrators are deliberately NOT merged into `authentication.apiKeys`:
  // an administrator secret authenticates the administration API only, and an
  // ordinary key never authenticates there.
  const administrators = parsed?.administrators ?? [];
  // CTRL-02 operators, likewise never merged into `authentication.apiKeys`.
  const operators = parsed?.operators ?? [];
  const configuration: EnterpriseConfiguration = {
    ...base,
    authentication: { apiKeys: [...base.authentication.apiKeys, ...customerKeys] },
    ...(administrators.length > 0 || operators.length > 0 ? { administration: { administrators, ...(operators.length > 0 ? { operators } : {}) } } : {}),
  };

  const seen = new Set<string>();
  for (const secret of [
    ...configuration.authentication.apiKeys.map((apiKey) => apiKey.key),
    ...administrators.map((administrator) => administrator.key),
    ...operators.map((operator) => operator.key),
  ]) {
    if (seen.has(secret)) {
      throw new EnterpriseHostConfigurationError(
        'HOST_CREDENTIALS_AMBIGUOUS',
        'The same secret is configured for more than one credential (AOC_ENTERPRISE_API_KEYS, customerPrincipals, administrators and/or operators). One secret authenticates one caller.',
      );
    }
    seen.add(secret);
  }

  if (!configuration.features.requireAuthentication && !isLoopback(configuration.http.host)) {
    throw new EnterpriseHostConfigurationError(
      'HOST_UNAUTHENTICATED_NETWORK_BIND',
      `AOC_ENTERPRISE_HTTP_HOST is a network address and AOC_ENTERPRISE_REQUIRE_AUTH is off: every network peer would read every tenant's records as the system principal. Set AOC_ENTERPRISE_REQUIRE_AUTH=true with AOC_ENTERPRISE_API_KEYS, or bind 127.0.0.1.`,
    );
  }
  // CTRL-02: a Host whose agents are onboarded by operators may start with no
  // static key — its customer credentials are operator-issued.
  if (configuration.features.requireAuthentication && configuration.authentication.apiKeys.length === 0 && operators.length === 0) {
    throw new EnterpriseHostConfigurationError(
      'HOST_CREDENTIALS_MISSING',
      'AOC_ENTERPRISE_REQUIRE_AUTH is on and no credential is configured. Set AOC_ENTERPRISE_API_KEYS or configure customerPrincipals in the governed-action file. There is no default key.',
    );
  }

  if (secureProfile) {
    if (env.AOC_ENTERPRISE_PERSISTENCE_PROVIDER !== 'sqlite') {
      throw new EnterpriseHostConfigurationError(
        'HOST_PERSISTENCE_NOT_DURABLE',
        `AOC_ENTERPRISE_ENV=${base.environment} requires AOC_ENTERPRISE_PERSISTENCE_PROVIDER=sqlite. In-memory state loses every grant, revocation and ledger on restart.`,
      );
    }
    if (env.AOC_ENTERPRISE_REQUIRE_AUTH === undefined || !configuration.features.requireAuthentication) {
      throw new EnterpriseHostConfigurationError('HOST_AUTHENTICATION_REQUIRED', `AOC_ENTERPRISE_ENV=${base.environment} requires AOC_ENTERPRISE_REQUIRE_AUTH=true.`);
    }
    if (governed === undefined) {
      throw new EnterpriseHostConfigurationError(
        'HOST_GOVERNED_ACTIONS_REQUIRED',
        `AOC_ENTERPRISE_ENV=${base.environment} requires ${GOVERNED_ACTIONS_FILE_VARIABLE}: a secure Host is the governed-action control plane. See .env.example.`,
      );
    }
    if (!configuration.kernelAuthority.required) {
      throw new EnterpriseHostConfigurationError('HOST_KERNEL_AUTHORITY_REQUIRED', `AOC_ENTERPRISE_ENV=${base.environment} requires AOC_ENTERPRISE_KERNEL_AUTHORITY_REQUIRED=true.`);
    }
    // Durable authority is always signed — by exactly one, explicitly stated
    // custody. `external` (CORE-02) needs no private key here and is refused
    // with one (validateEnterpriseEnvironment); `software` needs the key.
    const authenticity = configuration.authorityAuthenticity;
    const signerReady =
      authenticity.mode === 'external'
        ? authenticity.activeSigningKeyId !== undefined && authenticity.verificationKeys.length > 0 && authenticity.externalSigner.endpoint.length > 0 && authenticity.externalSigner.credential.length > 0
        : authenticity.activeSigningKeyId !== undefined && authenticity.signingKeyPem !== undefined && authenticity.verificationKeys.length > 0;
    if (!signerReady) {
      throw new EnterpriseHostConfigurationError(
        'HOST_AUTHORITY_SIGNING_KEY_REQUIRED',
        `AOC_ENTERPRISE_ENV=${base.environment} requires an authority signer: either AOC_ENTERPRISE_AUTHORITY_SIGNER_MODE=external with AOC_ENTERPRISE_AUTHORITY_SIGNER_ENDPOINT, AOC_ENTERPRISE_AUTHORITY_SIGNER_TOKEN, AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_ID and AOC_ENTERPRISE_AUTHORITY_VERIFICATION_KEYS (no private key in this process), or software custody with AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_ID, AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_PEM and AOC_ENTERPRISE_AUTHORITY_VERIFICATION_KEYS. Durable authority is always signed.`,
      );
    }
    // CORE-07: durable authority on a secure Host is always anchored. A
    // signature proves a state is authentic, never that it is the newest; a
    // secure Host without an external freshness witness would run with AA-003 /
    // GS-002 open — a restored pre-revocation snapshot would be believed after
    // a restart. There is no local-only substitute: an anchor inside the
    // authority store's restore domain is rolled back with it.
    const freshness = configuration.authorityFreshness;
    const freshnessReady =
      freshness?.mode === 'external' && freshness.witness.endpoint.length > 0 && freshness.witness.credential.length > 0 && freshness.witness.witnessId.length > 0 && freshness.witness.publicKeyPem.length > 0;
    if (!freshnessReady) {
      throw new EnterpriseHostConfigurationError(
        'HOST_AUTHORITY_FRESHNESS_REQUIRED',
        `AOC_ENTERPRISE_ENV=${base.environment} requires an external authority-state freshness witness: AOC_ENTERPRISE_AUTHORITY_FRESHNESS_MODE=external with AOC_ENTERPRISE_AUTHORITY_FRESHNESS_ENDPOINT, AOC_ENTERPRISE_AUTHORITY_FRESHNESS_TOKEN, AOC_ENTERPRISE_AUTHORITY_FRESHNESS_WITNESS_ID and AOC_ENTERPRISE_AUTHORITY_FRESHNESS_WITNESS_PUBLIC_KEY. Its state must live outside the authority stores' backup and snapshot domain.`,
      );
    }
  }

  if (governed !== undefined) {
    if (!configuration.kernelAuthority.enabled) {
      throw new EnterpriseHostConfigurationError(
        'HOST_KERNEL_AUTHORITY_REQUIRED',
        `Governed actions decide against the durable Kernel Authority world and bind customers through it. Set AOC_ENTERPRISE_KERNEL_AUTHORITY_ENABLED=true.`,
      );
    }
    if (governed.routes.size === 0) {
      throw new EnterpriseHostConfigurationError('HOST_EXECUTION_ROUTE_INVALID', `${GOVERNED_ACTIONS_FILE_VARIABLE}: routes must route at least one action to an adapter.`);
    }
  }

  return { configuration, governedActions: governed, secureProfile };
}
