/**
 * Asset identity and trusted asset scale.
 *
 * ## An asset identifier is the registry's, not the caller's
 *
 * Money is not a number with a label beside it. `10` means nothing until it is
 * known to be ten of *which* asset, and how many fractional digits that asset
 * can exactly represent is a property of the asset — not of the request that
 * mentions it. So a deployment states, as trusted host configuration, the
 * assets it recognizes and each one's scale, and every monetary amount's unit
 * must resolve here. An unrecognized unit fails closed. A caller can name an
 * asset; it can never describe one: there is no request field for a scale, and
 * nothing in this module reads one from anywhere but a definition.
 *
 * ## Identifier strategy
 *
 * One identifier names exactly one definition, and one definition has exactly
 * one identifier: there are no aliases, because two spellings of one asset
 * would make one quantity serialize — and digest — two ways. Identifiers are
 * opaque, case-sensitive and compared exactly, and their grammar admits a
 * namespace and an issuer so that assets which share a ticker never share an
 * identity:
 *
 * ```
 * USD                         a deployment's fiat US dollar
 * xrpl:XRP                    the XRP Ledger's native asset
 * xrpl:USD/rExampleIssuer     a USD-denominated issued asset, disambiguated by issuer
 * stellar:XLM
 * ```
 *
 * Which of these a deployment recognizes is its own configuration; this module
 * ships none. Nothing here converts between assets, holds a rate, or ranks one
 * asset against another: amounts in different assets are simply not
 * comparable (see `compareMonetaryAmounts`).
 */

/** Opaque, bounded, and free of whitespace and separators that could make two spellings name one asset. Admits `namespace:CODE/issuer`. */
export const MONETARY_ASSET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

/** The largest scale a definition may declare. Generous enough for any ledger asset in use (18 is the common token maximum). */
export const MONETARY_ASSET_MAXIMUM_SCALE = 36;

/** At most this many assets per registry. */
export const MONETARY_ASSET_REGISTRY_MAXIMUM_ASSETS = 256;

/** One recognized asset. `scale` is the most fractional digits an amount of it may state — `2` for a cent-denominated fiat, `6` for XRP drops. */
export interface MonetaryAssetDefinition {
  readonly assetId: string;
  readonly scale: number;
}

/**
 * The trusted resolver every monetary boundary consults.
 *
 * Read-only by type. Built once from host configuration, frozen, and never
 * extended by anything a request carries.
 */
export interface MonetaryAssetRegistry {
  /** The definition for exactly this identifier, or `undefined`. Total: a non-string answers `undefined`. */
  resolve(assetId: unknown): MonetaryAssetDefinition | undefined;
  /** Every recognized identifier, sorted. */
  readonly assetIds: readonly string[];
}

export class MonetaryConfigurationError extends Error {
  readonly code: 'MONETARY_CONFIGURATION_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'MonetaryConfigurationError';
    this.code = 'MONETARY_CONFIGURATION_INVALID';
  }
}

export function isCanonicalMonetaryAssetId(value: unknown): value is string {
  return typeof value === 'string' && MONETARY_ASSET_ID_PATTERN.test(value);
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/** Reads a data property exactly once; an accessor is refused, because a getter is code and could answer differently later. */
function ownData(source: Readonly<Record<string, unknown>>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  if (descriptor === undefined) return undefined;
  if (!('value' in descriptor)) throw new MonetaryConfigurationError(`Asset definition '${key}' is an accessor, not a value.`);
  return descriptor.value as unknown;
}

function snapshotDefinition(raw: unknown, index: number): MonetaryAssetDefinition {
  if (!isPlainRecord(raw)) throw new MonetaryConfigurationError(`Asset definition #${index} must be a plain object.`);
  const keys = Reflect.ownKeys(raw);
  if (keys.length !== 2 || !keys.every((key) => key === 'assetId' || key === 'scale')) {
    throw new MonetaryConfigurationError(`Asset definition #${index} must state exactly assetId and scale.`);
  }
  const assetId = ownData(raw, 'assetId');
  const scale = ownData(raw, 'scale');
  if (!isCanonicalMonetaryAssetId(assetId)) throw new MonetaryConfigurationError(`Asset definition #${index} has a malformed assetId.`);
  if (typeof scale !== 'number' || !Number.isSafeInteger(scale) || scale < 0 || scale > MONETARY_ASSET_MAXIMUM_SCALE) {
    throw new MonetaryConfigurationError(`Asset '${assetId}' must declare an integer scale between 0 and ${MONETARY_ASSET_MAXIMUM_SCALE}.`);
  }
  return Object.freeze({ assetId, scale });
}

/**
 * Builds the trusted registry, or throws `MonetaryConfigurationError`.
 *
 * Wiring-time, and unforgiving: a malformed definition or an identifier stated
 * twice is refused as a whole rather than resolved by picking one — "which of
 * the two scales did the host mean?" is not a question to answer at runtime.
 * An empty list is valid and recognizes nothing, so every amount fails closed.
 */
export function createMonetaryAssetRegistry(definitions: readonly MonetaryAssetDefinition[]): MonetaryAssetRegistry {
  if (!Array.isArray(definitions)) throw new MonetaryConfigurationError('Asset definitions must be an array.');
  if (definitions.length > MONETARY_ASSET_REGISTRY_MAXIMUM_ASSETS) {
    throw new MonetaryConfigurationError(`At most ${MONETARY_ASSET_REGISTRY_MAXIMUM_ASSETS} assets may be defined.`);
  }
  const byId = new Map<string, MonetaryAssetDefinition>();
  definitions.forEach((raw, index) => {
    const definition = snapshotDefinition(raw, index);
    if (byId.has(definition.assetId)) throw new MonetaryConfigurationError(`Asset '${definition.assetId}' is defined more than once.`);
    byId.set(definition.assetId, definition);
  });
  const assetIds = Object.freeze([...byId.keys()].sort());
  return Object.freeze({
    assetIds,
    resolve(assetId: unknown): MonetaryAssetDefinition | undefined {
      return typeof assetId === 'string' ? byId.get(assetId) : undefined;
    },
  });
}
