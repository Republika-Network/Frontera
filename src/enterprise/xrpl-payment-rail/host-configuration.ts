import {
  XrplRailConfigurationError,
  createXrplRlusdRailConfiguration,
  isXrplSigningPublicKey,
  type XrplRlusdRailConfiguration,
} from '../../features/payment-runtime/rails/xrpl/index.js';
import { externalSignerCredentialProblem, externalSignerEndpointProblem } from '../external-authority-signer/http-transport.js';
import { EXTERNAL_XRPL_SIGNER_LIMITS } from './external-xrpl-signer.js';
import { isExternalXrplSignerId } from './signer-protocol.js';

/**
 * PAY-03 — the Host configuration contract of the production XRPL / RLUSD
 * payment rail: the governed-action file's optional `xrplPaymentRail` section.
 *
 * Absent → no XRPL rail, no signer, no interlock, no resolver: the Host is
 * exactly what it was. Present → the rail is composed, explicitly, through the
 * existing execution-adapter registry and P12, or the Host refuses to start.
 *
 * ```json
 * "xrplPaymentRail": {
 *   "paymentAction": "payment.execute",
 *   "network": "testnet",
 *   "endpoint": "wss://s.altnet.rippletest.net:51233",
 *   "asset": { "paymentAsset": "stable:RLUSD/…", "currency": "524C5553…", "issuer": "r…" },
 *   "sourceAccounts": [{ "accountId": "treasury-ops", "address": "r…", "signingPublicKey": "ED…" }],
 *   "signer": { "endpoint": "https://xrpl-signer.internal", "signerId": "treasury-signer", "credential": { "kind": "bearer", "tokenEnv": "FRONTERA_XRPL_SIGNER_TOKEN" } }
 * }
 * ```
 *
 * Closed at every level (an unknown field — `seed`, `secret`, `privateKey` or
 * a typo — is refused, never ignored), read once, and fail-closed. Every rail
 * field is validated by PAY-02's own `createXrplRlusdRailConfiguration`, so
 * mainnet still needs **both** `network: "mainnet"` **and**
 * `allowMainnet: true`, and nothing defaults to mainnet.
 *
 * There is **no secret** here and no place for one: no seed, key or mnemonic
 * field exists; the signer transport credential is named by environment
 * variable, never inline. The signing public keys and the signer id are
 * **public** identity pins. Error messages name fields, never values.
 */
export interface EnterpriseHostXrplPaymentRailConfiguration {
  /** The one governed action that is a payment on this rail. Routed to the rail, financial, and bound to the XRPL resolution authority. */
  readonly paymentAction: string;
  readonly rail: XrplRlusdRailConfiguration;
  readonly signer: {
    readonly endpoint: string;
    readonly signerId: string;
    /** Resolved from the named environment variable. Secret: held here exactly as a Generic HTTP adapter credential is. */
    readonly credential: string;
    readonly timeoutMs: number;
  };
  /** Per source account, the pinned signing public key. */
  readonly signingKeys: readonly { readonly address: string; readonly signingPublicKey: string }[];
}

export class XrplHostConfigurationProblem extends Error {
  readonly kind: 'invalid' | 'secret-unresolved';

  constructor(kind: 'invalid' | 'secret-unresolved', message: string) {
    super(message);
    this.name = 'XrplHostConfigurationProblem';
    this.kind = kind;
  }
}

type Env = Readonly<Record<string, string | undefined>>;

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const SECTION = 'xrplPaymentRail';
const RAIL_FIELDS = ['network', 'allowMainnet', 'endpoint', 'asset', 'lastLedgerOffset', 'maxFeeDrops', 'requestTimeoutMs', 'finalityTimeoutMs', 'pollIntervalMs'] as const;
const SECTION_FIELDS = ['paymentAction', 'sourceAccounts', 'signer', ...RAIL_FIELDS];

const problem = (message: string): never => {
  throw new XrplHostConfigurationProblem('invalid', `${SECTION}${message}`);
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function closed(value: unknown, allowed: readonly string[], where: string): Record<string, unknown> {
  if (!isRecord(value)) return problem(`${where} must be an object.`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) problem(`${where} has unsupported field '${key}'. Allowed: ${allowed.join(', ')}.`);
  return value;
}

function text(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) problem(`${where} must be a non-empty string without surrounding whitespace.`);
  return value as string;
}

/**
 * Validates the section. Pure apart from reading the one named credential
 * variable from `env`; contacts nothing. `context` is the rest of the
 * already-parsed file, against which the payment action is checked.
 */
export function parseXrplPaymentRailSection(
  env: Env,
  value: unknown,
  context: { readonly routes: ReadonlyMap<string, string>; readonly financialActions: readonly string[]; readonly assets: readonly unknown[] },
): EnterpriseHostXrplPaymentRailConfiguration {
  const section = closed(value, SECTION_FIELDS, '');

  const sources = section['sourceAccounts'];
  if (!Array.isArray(sources) || sources.length === 0) problem('.sourceAccounts must be a non-empty array.');
  const signingKeys: { address: string; signingPublicKey: string }[] = [];
  const railSources = (sources as unknown[]).map((entry, index) => {
    const where = `.sourceAccounts[${index}]`;
    const source = closed(entry, ['accountId', 'address', 'signingPublicKey'], where);
    if (!isXrplSigningPublicKey(source['signingPublicKey'])) problem(`${where}.signingPublicKey must be the account's 33-byte signing public key as 66 uppercase hex digits (ED… or 02…/03…).`);
    signingKeys.push({ address: source['address'] as string, signingPublicKey: source['signingPublicKey'] as string });
    return { accountId: source['accountId'], address: source['address'] };
  });

  // PAY-02's own validation, unchanged: closed, typed, no mainnet default.
  const railInput: Record<string, unknown> = { sourceAccounts: railSources };
  for (const field of RAIL_FIELDS) if (section[field] !== undefined) railInput[field] = section[field];
  let rail: XrplRlusdRailConfiguration;
  try {
    rail = createXrplRlusdRailConfiguration(railInput as never);
  } catch (error) {
    if (error instanceof XrplRailConfigurationError) return problem(`.${error.field}: ${error.message}`);
    throw error;
  }

  const paymentAction = text(section['paymentAction'], '.paymentAction');
  if (context.routes.get(paymentAction) !== rail.railId) problem(`.paymentAction '${paymentAction}' must be routed to adapter '${rail.railId}' in routes.`);
  for (const [action, adapterId] of context.routes) {
    if (adapterId === rail.railId && action !== paymentAction) problem(`: routes sends action '${action}' to '${rail.railId}', but only the configured paymentAction may reach the XRPL rail.`);
  }
  if (!context.financialActions.includes(paymentAction)) problem(`.paymentAction '${paymentAction}' must be listed in monetary.financialActions: a payment is exercisable only under P7 exposure control.`);
  const declared = context.assets.some((asset) => isRecord(asset) && asset['assetId'] === rail.asset.paymentAsset);
  if (!declared) problem('.asset.paymentAsset must be declared in monetary.assets.');

  const signer = closed(section['signer'], ['endpoint', 'signerId', 'credential', 'timeoutMs'], '.signer');
  const endpoint = text(signer['endpoint'], '.signer.endpoint');
  const endpointProblem = externalSignerEndpointProblem(endpoint);
  if (endpointProblem !== undefined) problem(`.signer.endpoint ${endpointProblem}.`);
  const signerId = signer['signerId'];
  if (!isExternalXrplSignerId(signerId)) problem('.signer.signerId must be a recordable identifier (letters, digits, ":", ".", "_", "-"; at most 128).');
  const credential = closed(signer['credential'], ['kind', 'tokenEnv'], '.signer.credential');
  if (credential['kind'] !== 'bearer') problem(".signer.credential.kind must be 'bearer'. Inline secrets are not accepted; reference an environment variable.");
  const tokenEnv = credential['tokenEnv'];
  if (typeof tokenEnv !== 'string' || !ENV_NAME.test(tokenEnv)) problem('.signer.credential.tokenEnv must name an environment variable (uppercase letters, digits and underscores).');
  const token = env[tokenEnv as string];
  if (token === undefined || token.length === 0) throw new XrplHostConfigurationProblem('secret-unresolved', `${SECTION}.signer.credential.tokenEnv names environment variable '${String(tokenEnv)}', which is not set or is empty.`);
  const credentialProblem = externalSignerCredentialProblem(token);
  if (credentialProblem !== undefined) problem(`.signer.credential: the token named by '${String(tokenEnv)}' ${credentialProblem}.`);
  const limits = EXTERNAL_XRPL_SIGNER_LIMITS.timeoutMs;
  const timeoutMs = signer['timeoutMs'] ?? limits.default;
  if (typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs) || timeoutMs < limits.minimum || timeoutMs > limits.maximum) problem(`.signer.timeoutMs must be an integer from ${limits.minimum} to ${limits.maximum}.`);

  return Object.freeze({
    paymentAction,
    rail,
    signer: Object.freeze({ endpoint, signerId: signerId as string, credential: token, timeoutMs: timeoutMs as number }),
    signingKeys: Object.freeze(signingKeys.map((entry) => Object.freeze(entry))),
  });
}

/**
 * Environment variable names that would put XRPL key material, or the
 * reference signer's own configuration, into the Host process. The Host
 * refuses to start with any of them present when the rail is configured
 * (presence alone; the value is never read). Not a scan for key-shaped text.
 */
export function xrplKeyMaterialVariables(env: Env): readonly string[] {
  return Object.keys(env)
    .filter((name) => env[name] !== undefined)
    .filter((name) => name.startsWith('FRONTERA_REFERENCE_XRPL_SIGNER_') || (/XRPL/.test(name) && /(SEED|SECRET|PRIVATE|MNEMONIC|WALLET)/.test(name)))
    .sort();
}
