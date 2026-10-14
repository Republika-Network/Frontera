import { TRADE_NETWORKS, isTradeNetwork, parseTradeDelegationPolicy, type TradeNetwork } from '../../features/trade-runtime/index.js';
import { externalSignerCredentialProblem } from '../external-authority-signer/http-transport.js';
import { DELEGATED_OFFER_SIGNER_LIMITS, delegatedOfferSignerEndpointProblem, isDelegatedOfferSignerId, validateDelegatedOfferSignerPin, type DelegatedOfferSignerPin } from '../xrpl-trade-rail/index.js';
import { TRADE_EXECUTOR_LIMITS, type TradeOfferExecutorConfiguration } from './trade-offer-executor.js';

/**
 * TRADE-04C (gate G4) — the Host configuration contract of the governed
 * trade executor: the governed-action file's optional `xrplTradeExecution`
 * section.
 *
 * Absent → no trade executor, no trade signer client, no trade interlock, no
 * trade resolver: the Host is exactly what it was. Present → composed through
 * the existing execution-adapter registry and P12, or the Host refuses to
 * start.
 *
 * ```json
 * "xrplTradeExecution": {
 *   "tradeAction": "trade.offer-create",
 *   "network": "xrp-ledger-testnet",
 *   "endpoint": "wss://s.altnet.rippletest.net:51233",
 *   "pairs": [{ "ownerAccount": "r…", "delegateAccount": "r…", "signingPublicKey": "ED…" }],
 *   "signer": { "endpoint": "https://offer-signer.internal", "signerId": "desk-signer",
 *               "credential": { "kind": "bearer", "tokenEnv": "FRONTERA_XRPL_OFFER_SIGNER_TOKEN" } },
 *   "delegation": { "sourceId": "trade-delegation-verifier", "maxAgeSeconds": 10 },
 *   "feeDrops": "12", "maximumFeeDrops": "100", "lastLedgerOffset": 20
 * }
 * ```
 *
 * Closed at every level (an unknown field — a seed, a key, a typo — is
 * refused, never ignored). There is no place for a secret: the signer
 * credential is named by environment variable. Mainnet is not representable
 * (TRADE-01's networks are XRPL Testnet and Devnet). The owner key is never
 * anywhere in Frontera.
 */
export const XRPL_TRADE_EXECUTOR_ID = 'xrpl-trade-offer-executor';

export interface EnterpriseHostXrplTradeExecutionConfiguration {
  readonly tradeAction: string;
  readonly endpoint: string;
  readonly executor: TradeOfferExecutorConfiguration;
  readonly signer: {
    readonly endpoint: string;
    readonly credential: string;
    readonly timeoutMs: number;
    readonly pin: DelegatedOfferSignerPin;
  };
}

export class XrplTradeHostConfigurationProblem extends Error {
  readonly kind: 'invalid' | 'secret-unresolved';

  constructor(kind: 'invalid' | 'secret-unresolved', message: string) {
    super(message);
    this.name = 'XrplTradeHostConfigurationProblem';
    this.kind = kind;
  }
}

type Env = Readonly<Record<string, string | undefined>>;

const SECTION = 'xrplTradeExecution';
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const SECTION_FIELDS = [
  'tradeAction',
  'network',
  'endpoint',
  'pairs',
  'signer',
  'delegation',
  'feeDrops',
  'maximumFeeDrops',
  'lastLedgerOffset',
  'observationSpanLedgers',
  'maxValidatedLedgerAgeSeconds',
  'requestTimeoutMs',
  'finalityTimeoutMs',
  'pollIntervalMs',
] as const;
const DEFAULTS = Object.freeze({ lastLedgerOffset: 20, observationSpanLedgers: 2, maxValidatedLedgerAgeSeconds: 10, requestTimeoutMs: 10_000, finalityTimeoutMs: 60_000, pollIntervalMs: 1_000 });
const DEFAULT_SIGNER_TIMEOUT_MS = 10_000;

const problem = (message: string): never => {
  throw new XrplTradeHostConfigurationProblem('invalid', `${SECTION}${message}`);
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

function integer(value: unknown, fallback: number, limits: { readonly minimum: number; readonly maximum: number }, where: string): number {
  const chosen = value ?? fallback;
  if (typeof chosen !== 'number' || !Number.isSafeInteger(chosen) || chosen < limits.minimum || chosen > limits.maximum) problem(`${where} must be an integer from ${limits.minimum} to ${limits.maximum}.`);
  return chosen as number;
}

/**
 * Validates the section. Pure apart from reading the one named credential
 * variable from `env`; contacts nothing. `context` is the rest of the
 * already-parsed file.
 */
export function parseXrplTradeExecutionSection(
  env: Env,
  value: unknown,
  context: { readonly routes: ReadonlyMap<string, string>; readonly financialActions: readonly string[]; readonly parameterDimensions: readonly string[]; readonly otherAdapterIds: readonly string[] },
): EnterpriseHostXrplTradeExecutionConfiguration {
  const section = closed(value, SECTION_FIELDS, '');

  const tradeAction = text(section['tradeAction'], '.tradeAction');
  if (context.routes.get(tradeAction) !== XRPL_TRADE_EXECUTOR_ID) problem(`.tradeAction '${tradeAction}' must be routed to adapter '${XRPL_TRADE_EXECUTOR_ID}' in routes.`);
  for (const [action, adapterId] of context.routes) {
    if (adapterId === XRPL_TRADE_EXECUTOR_ID && action !== tradeAction) problem(`: routes sends action '${action}' to '${XRPL_TRADE_EXECUTOR_ID}', but only the configured tradeAction may reach the trade executor.`);
  }
  if (context.otherAdapterIds.includes(XRPL_TRADE_EXECUTOR_ID)) problem(`: another adapter reuses the trade executor's id '${XRPL_TRADE_EXECUTOR_ID}'.`);
  if (!context.financialActions.includes(tradeAction)) problem(`.tradeAction '${tradeAction}' must be listed in monetary.financialActions: an order is exercisable only under P7 exposure control.`);
  for (const dimension of ['tradeProposalDigest', 'tradeNetwork', 'tradeDelegateAccount', 'tradeBaseAsset', 'tradeQuoteAsset', 'tradeSide', 'tradeQuantity']) {
    if (!context.parameterDimensions.includes(dimension)) problem(`: governance.parameterDimensions must declare '${dimension}': the executor binds every order to its exact granted parameters.`);
  }

  const network = section['network'];
  if (!isTradeNetwork(network)) problem(`.network must be one of: ${Object.keys(TRADE_NETWORKS).join(', ')}. Mainnet is not available to the trade executor.`);
  const endpoint = text(section['endpoint'], '.endpoint');
  let url: URL | undefined;
  try {
    url = new URL(endpoint);
  } catch {
    problem('.endpoint must be a wss:// URL.');
  }
  if (url!.protocol !== 'wss:' || url!.username !== '' || url!.password !== '' || url!.search !== '' || url!.hash !== '' || url!.hostname === '') problem('.endpoint must be a wss:// URL with a host and no credentials, query or fragment.');

  const pairsRaw = section['pairs'];
  if (!Array.isArray(pairsRaw) || pairsRaw.length === 0) problem('.pairs must be a non-empty array.');
  const pairs = (pairsRaw as unknown[]).map((entry, index) => {
    const pair = closed(entry, ['ownerAccount', 'delegateAccount', 'signingPublicKey'], `.pairs[${index}]`);
    return { ownerAccount: pair['ownerAccount'], delegateAccount: pair['delegateAccount'], signingPublicKey: pair['signingPublicKey'] };
  });
  const owners = new Set(pairs.map((pair) => pair.ownerAccount));
  if (owners.size !== pairs.length) problem('.pairs names an owner account twice: one owner has one delegate and one sequence domain.');

  const signer = closed(section['signer'], ['endpoint', 'signerId', 'credential', 'timeoutMs'], '.signer');
  const signerEndpoint = text(signer['endpoint'], '.signer.endpoint');
  const endpointProblem = delegatedOfferSignerEndpointProblem(signerEndpoint);
  if (endpointProblem !== undefined) problem(`.signer.endpoint ${endpointProblem}.`);
  if (!isDelegatedOfferSignerId(signer['signerId'])) problem('.signer.signerId must be a recordable identifier (letters, digits, ":", ".", "_", "-"; at most 128).');
  let pin: DelegatedOfferSignerPin;
  try {
    pin = validateDelegatedOfferSignerPin({ signerId: signer['signerId'], network, pairs });
  } catch (error) {
    return problem(`.pairs: ${error instanceof Error ? error.message : 'invalid pairs'}`);
  }
  const credential = closed(signer['credential'], ['kind', 'tokenEnv'], '.signer.credential');
  if (credential['kind'] !== 'bearer') problem(".signer.credential.kind must be 'bearer'. Inline secrets are not accepted; reference an environment variable.");
  const tokenEnv = credential['tokenEnv'];
  if (typeof tokenEnv !== 'string' || !ENV_NAME.test(tokenEnv)) problem('.signer.credential.tokenEnv must name an environment variable (uppercase letters, digits and underscores).');
  const token = env[tokenEnv as string];
  if (token === undefined || token.length === 0) throw new XrplTradeHostConfigurationProblem('secret-unresolved', `${SECTION}.signer.credential.tokenEnv names environment variable '${String(tokenEnv)}', which is not set or is empty.`);
  const credentialProblem = externalSignerCredentialProblem(token);
  if (credentialProblem !== undefined) problem(`.signer.credential: the token named by '${String(tokenEnv)}' ${credentialProblem}.`);
  const timeoutMs = integer(signer['timeoutMs'], DEFAULT_SIGNER_TIMEOUT_MS, DELEGATED_OFFER_SIGNER_LIMITS.timeoutMs, '.signer.timeoutMs');

  const delegationPolicy = parseTradeDelegationPolicy(section['delegation']);
  if (delegationPolicy === undefined) problem('.delegation must be { sourceId, maxAgeSeconds (1 to 60) }.');

  const L = TRADE_EXECUTOR_LIMITS;
  const feeDrops = text(section['feeDrops'], '.feeDrops');
  const maximumFeeDrops = text(section['maximumFeeDrops'], '.maximumFeeDrops');
  if (!/^[1-9][0-9]{0,15}$/.test(maximumFeeDrops) || BigInt(maximumFeeDrops) > L.maximumFeeDrops) problem('.maximumFeeDrops must be a positive whole number of drops, at most 1 XRP.');
  if (!/^[1-9][0-9]{0,15}$/.test(feeDrops) || BigInt(feeDrops) > BigInt(maximumFeeDrops)) problem('.feeDrops must be a positive whole number of drops, at most maximumFeeDrops.');
  const lastLedgerOffset = integer(section['lastLedgerOffset'], DEFAULTS.lastLedgerOffset, { minimum: L.lastLedgerOffset.minimum, maximum: Math.min(L.lastLedgerOffset.maximum, DELEGATED_OFFER_SIGNER_LIMITS.maximumLedgerHorizon.maximum) }, '.lastLedgerOffset');

  const executor: TradeOfferExecutorConfiguration = Object.freeze({
    adapterId: XRPL_TRADE_EXECUTOR_ID,
    action: tradeAction,
    network: network as TradeNetwork,
    pairs: pin.pairs,
    feeDrops,
    maximumFeeDrops,
    lastLedgerOffset,
    observationSpanLedgers: integer(section['observationSpanLedgers'], DEFAULTS.observationSpanLedgers, L.observationSpanLedgers, '.observationSpanLedgers'),
    maxValidatedLedgerAgeSeconds: integer(section['maxValidatedLedgerAgeSeconds'], DEFAULTS.maxValidatedLedgerAgeSeconds, L.maxValidatedLedgerAgeSeconds, '.maxValidatedLedgerAgeSeconds'),
    requestTimeoutMs: integer(section['requestTimeoutMs'], DEFAULTS.requestTimeoutMs, L.requestTimeoutMs, '.requestTimeoutMs'),
    finalityTimeoutMs: integer(section['finalityTimeoutMs'], DEFAULTS.finalityTimeoutMs, L.finalityTimeoutMs, '.finalityTimeoutMs'),
    pollIntervalMs: integer(section['pollIntervalMs'], DEFAULTS.pollIntervalMs, L.pollIntervalMs, '.pollIntervalMs'),
    delegationPolicy: delegationPolicy!,
  });
  return Object.freeze({ tradeAction, endpoint, executor, signer: Object.freeze({ endpoint: signerEndpoint, credential: token, timeoutMs, pin }) });
}

/** The XRPL network id of the trade domain (never mainnet). */
export function tradeExecutionNetworkId(configuration: EnterpriseHostXrplTradeExecutionConfiguration): number {
  return TRADE_NETWORKS[configuration.executor.network].networkId;
}

/**
 * Environment variable names that would put XRPL key material — or the
 * TRADE-04B reference offer signer's own configuration — into the Host
 * process. With the executor configured, the Host refuses to start with any
 * of them present (presence alone; the value is never read).
 */
export function xrplTradeKeyMaterialVariables(env: Env): readonly string[] {
  return Object.keys(env)
    .filter((name) => env[name] !== undefined)
    .filter((name) => name.startsWith('FRONTERA_REFERENCE_XRPL_OFFER_SIGNER_') || (/XRPL|OWNER|DELEGATE/.test(name) && /(SEED|SECRET|PRIVATE|MNEMONIC|WALLET)/.test(name)))
    .sort();
}
