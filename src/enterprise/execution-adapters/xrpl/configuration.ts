import { isDestinationNamespace } from '../../../features/destination-runtime/index.js';
import { isRecordableExecutionAdapterId } from '../../../features/execution-runtime/index.js';
import { isCanonicalMonetaryAssetId } from '../../../features/monetary-runtime/index.js';
import {
  XRPL_DESTINATION_NAMESPACE,
  XrplConfigurationError,
  type XrplAssetRepresentation,
  type XrplConfigurationErrorCode,
  type XrplExecutionAdapterOptions,
} from './contracts.js';
import { isXrplClassicAddress, isXrplNonStandardCurrencyCode, isXrplStandardCurrencyCode } from './xrpl-codec.js';

/**
 * Construct → validate → snapshot → freeze, the discipline the Generic HTTP
 * adapter applies to its own configuration.
 *
 * Every option is read **once**, as a data property — an accessor is refused,
 * because a getter could answer differently during traffic — into a fresh
 * frozen plan. Nothing the host passed in is held afterwards. Every defect is a
 * construction-time throw, so a malformed issuer or an unmapped currency fails
 * startup rather than an authorized payment. Messages never echo a value.
 */

/** At most this many asset mappings per adapter. */
export const XRPL_MAXIMUM_ASSET_MAPPINGS = 64;

/** The adapter's own frozen description of what it may send. Internal; never exported from the Enterprise barrel. */
export interface XrplPlan {
  readonly adapterId: string;
  readonly namespace: string;
  /** ANDREW-P0-07: the network label every submission carries, when configured. */
  readonly network?: string;
  /** Frontera asset id → XRPL representation. Exact keys; no alias, no fallback. */
  readonly assets: ReadonlyMap<string, XrplAssetRepresentation>;
}

function fail(code: XrplConfigurationErrorCode, message: string): never {
  throw new XrplConfigurationError(code, message);
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/** The record's own data properties, read once; refuses a non-record, an accessor, a symbol key and a key outside `allowed`. */
function readRecord(value: unknown, allowed: readonly string[], what: string): Readonly<Record<string, unknown>> {
  if (!isPlainRecord(value)) fail('XRPL_OPTIONS_INVALID', `${what} must be a plain object.`);
  const out: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key)) fail('XRPL_OPTIONS_INVALID', `${what} states a field this contract does not declare.`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) fail('XRPL_OPTIONS_INVALID', `${what} must hold values, not accessors.`);
    out[key] = descriptor.value as unknown;
  }
  return out;
}

/**
 * The parts of a P9 asset id (`[namespace:]CODE[/issuer]`) a mapping must agree
 * with. The grammar is P9's; this only reads it.
 */
function assetIdParts(assetId: string): { readonly namespace?: string; readonly code: string; readonly issuer?: string } {
  const colon = assetId.lastIndexOf(':');
  const namespace = colon < 0 ? undefined : assetId.slice(0, colon);
  const rest = colon < 0 ? assetId : assetId.slice(colon + 1);
  const slash = rest.indexOf('/');
  const code = slash < 0 ? rest : rest.slice(0, slash);
  const issuer = slash < 0 ? undefined : rest.slice(slash + 1);
  return { ...(namespace !== undefined ? { namespace } : {}), code, ...(issuer !== undefined ? { issuer } : {}) };
}

/** A network label: lowercase-led, lowercase letters and digits joined by single `-` or `.`, at most 64 characters. A label, never a URL. */
const NETWORK_LABEL = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const NETWORK_LABEL_MAXIMUM_LENGTH = 64;

export function isXrplNetworkLabel(value: unknown): value is string {
  return typeof value === 'string' && value.length <= NETWORK_LABEL_MAXIMUM_LENGTH && NETWORK_LABEL.test(value);
}

function isXrplNamespace(value: unknown): value is string {
  return isDestinationNamespace(value) && (value === XRPL_DESTINATION_NAMESPACE || value.startsWith(`${XRPL_DESTINATION_NAMESPACE}.`));
}

function snapshotRepresentation(raw: unknown, assetId: string, index: number): XrplAssetRepresentation {
  const what = `Asset mapping #${index} representation`;
  const kind = isPlainRecord(raw) ? Object.getOwnPropertyDescriptor(raw, 'kind') : undefined;
  const kindValue = kind !== undefined && 'value' in kind ? (kind.value as unknown) : undefined;
  const parts = assetIdParts(assetId);
  if (parts.namespace !== undefined && !isXrplNamespace(parts.namespace)) {
    fail('XRPL_ASSET_MAPPING_INVALID', `Asset mapping #${index} names an asset of another rail.`);
  }

  if (kindValue === 'issued') {
    const record = readRecord(raw, ['kind', 'currency', 'issuer'], what);
    const { currency, issuer } = record;
    if (!isXrplStandardCurrencyCode(currency)) fail('XRPL_CURRENCY_INVALID', `Asset mapping #${index} needs a standard three-character XRPL currency code other than XRP.`);
    if (!isXrplClassicAddress(issuer)) fail('XRPL_ISSUER_INVALID', `Asset mapping #${index} needs an issuer that is a valid XRPL classic address.`);
    // No conversion by configuration: the asset authorized is the asset sent.
    if (parts.code !== currency) fail('XRPL_ASSET_MAPPING_INVALID', `Asset mapping #${index} would send a currency other than the authorized asset.`);
    if (parts.issuer !== undefined && parts.issuer !== issuer) fail('XRPL_ASSET_MAPPING_INVALID', `Asset mapping #${index} names an issuer other than the one its asset id states.`);
    return Object.freeze({ kind: 'issued', currency, issuer });
  }
  if (kindValue === 'pinned') {
    const record = readRecord(raw, ['kind', 'denominates', 'currency', 'issuer'], what);
    const { denominates, currency, issuer } = record;
    // A pinned representation carries a governed unit, so the asset must be one: no rail namespace, no issuer.
    if (parts.namespace !== undefined || parts.issuer !== undefined) fail('XRPL_ASSET_MAPPING_INVALID', `Asset mapping #${index} pins a representation for an asset that is not a bare governed unit.`);
    // The operator restates the governed unit; a mismatch is a configuration defect, never a conversion.
    if (denominates !== assetId) fail('XRPL_ASSET_MAPPING_INVALID', `Asset mapping #${index} pins a representation that denominates a different asset.`);
    // Only a 160-bit token code: a standard code must use 'issued', where it has to equal the asset.
    if (!isXrplNonStandardCurrencyCode(currency)) fail('XRPL_CURRENCY_INVALID', `Asset mapping #${index} pins a representation whose currency is not a canonical 160-bit XRPL currency code.`);
    if (!isXrplClassicAddress(issuer)) fail('XRPL_ISSUER_INVALID', `Asset mapping #${index} needs an issuer that is a valid XRPL classic address.`);
    return Object.freeze({ kind: 'pinned', denominates, currency, issuer });
  }
  if (kindValue === 'native') {
    readRecord(raw, ['kind'], what);
    if (parts.code !== 'XRP' || parts.issuer !== undefined) fail('XRPL_ASSET_MAPPING_INVALID', `Asset mapping #${index} maps an asset that is not XRP to native XRP.`);
    return Object.freeze({ kind: 'native' });
  }
  return fail('XRPL_ASSET_MAPPING_INVALID', `${what} must be of kind 'issued', 'pinned' or 'native'.`);
}

/** The XRPL amount a representation sends. `issued` and `pinned` share one key space, so no token can carry two Frontera assets. */
function representationKey(representation: XrplAssetRepresentation): string {
  return representation.kind === 'native' ? 'native' : `issued:${representation.currency}/${representation.issuer}`;
}

export function snapshotXrplOptions(options: XrplExecutionAdapterOptions): XrplPlan {
  let record: Readonly<Record<string, unknown>>;
  let mappings: readonly unknown[];
  try {
    record = readRecord(options, ['adapterId', 'namespace', 'network', 'assets'], 'XRPL adapter options');
    const assets = record['assets'];
    if (!Array.isArray(assets)) fail('XRPL_ASSET_MAPPING_INVALID', 'XRPL adapter options need an assets array.');
    mappings = Array.from(assets as readonly unknown[]);
  } catch (error) {
    if (error instanceof XrplConfigurationError) throw error;
    return fail('XRPL_OPTIONS_INVALID', 'XRPL adapter options could not be read.');
  }

  const adapterId = record['adapterId'];
  if (typeof adapterId !== 'string' || !isRecordableExecutionAdapterId(adapterId)) fail('XRPL_ADAPTER_ID_INVALID', 'The XRPL adapter needs a recordable adapterId.');
  const namespace = record['namespace'] ?? XRPL_DESTINATION_NAMESPACE;
  if (!isXrplNamespace(namespace)) fail('XRPL_NAMESPACE_INVALID', `The XRPL adapter namespace must be '${XRPL_DESTINATION_NAMESPACE}' or '${XRPL_DESTINATION_NAMESPACE}.<label>'.`);
  const network = record['network'];
  if (network !== undefined && !isXrplNetworkLabel(network)) fail('XRPL_NETWORK_INVALID', 'The XRPL adapter network must be a lowercase label of at most 64 characters.');

  if (mappings.length === 0 || mappings.length > XRPL_MAXIMUM_ASSET_MAPPINGS) {
    fail('XRPL_ASSET_MAPPING_INVALID', `The XRPL adapter needs between 1 and ${XRPL_MAXIMUM_ASSET_MAPPINGS} asset mappings.`);
  }
  const assets = new Map<string, XrplAssetRepresentation>();
  const represented = new Set<string>();
  mappings.forEach((raw, index) => {
    const mapping = readRecord(raw, ['assetId', 'representation'], `Asset mapping #${index}`);
    const assetId = mapping['assetId'];
    if (!isCanonicalMonetaryAssetId(assetId)) fail('XRPL_ASSET_MAPPING_INVALID', `Asset mapping #${index} has a malformed assetId.`);
    if (assets.has(assetId)) fail('XRPL_ASSET_MAPPING_INVALID', `Asset mapping #${index} maps an asset that is already mapped.`);
    const representation = snapshotRepresentation(mapping['representation'], assetId, index);
    const key = representationKey(representation);
    // Two Frontera assets for one XRPL amount would be an alias (P9 allows none).
    if (represented.has(key)) fail('XRPL_ASSET_MAPPING_INVALID', `Asset mapping #${index} repeats an XRPL representation another asset already uses.`);
    represented.add(key);
    assets.set(assetId, representation);
  });

  return Object.freeze({ adapterId, namespace, ...(network !== undefined ? { network } : {}), assets });
}
