/**
 * XRPL network identity (TRADE-04A).
 *
 * A server answer is evidence about exactly one network: the one whose
 * `network_id` it states. A server on another network, or one that does not
 * state its network, is never evidence for the network asked about — not
 * "probably the same", not "the default".
 */

/** The network ids rippled reports in `server_info.info.network_id`. Nothing defaults to mainnet. */
export const XRPL_NETWORK_IDENTITIES = Object.freeze({ mainnet: 0, testnet: 1, devnet: 2 } as const);

export type XrplNetworkName = keyof typeof XRPL_NETWORK_IDENTITIES;

export const XRPL_MAINNET_NETWORK_ID = XRPL_NETWORK_IDENTITIES.mainnet;

function recordOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Readonly<Record<string, unknown>>) : undefined;
}

/**
 * The `network_id` a raw `server_info` result reports, or `undefined` when
 * absent or malformed. The PAY-02 rail's `readNetworkId`, unchanged.
 */
export function readXrplNetworkId(raw: unknown): number | undefined {
  const networkId = recordOf(recordOf(raw)?.['info'])?.['network_id'];
  return typeof networkId === 'number' && Number.isSafeInteger(networkId) && networkId >= 0 ? networkId : undefined;
}

/**
 * Whether `networkId` names a network this transport knows, and — for
 * mainnet — whether trusted configuration explicitly allowed it. Configuration
 * time only; never a server answer.
 */
export function isPermittedXrplNetworkId(networkId: unknown, allowMainnet: boolean): networkId is number {
  if (!(Object.values(XRPL_NETWORK_IDENTITIES) as readonly unknown[]).includes(networkId)) return false;
  return networkId !== XRPL_MAINNET_NETWORK_ID || allowMainnet === true;
}

export type XrplNetworkIdentityCheck =
  | { readonly ok: true; readonly networkId: number }
  | { readonly ok: false; readonly failure: 'NETWORK_UNSTATED' | 'NETWORK_MISMATCH' };

/** The server answered for `expected`, and said so. Total: anything else is a failure. */
export function checkXrplNetworkIdentity(serverInfo: unknown, expected: number): XrplNetworkIdentityCheck {
  const reported = readXrplNetworkId(serverInfo);
  if (reported === undefined) return { ok: false, failure: 'NETWORK_UNSTATED' };
  if (reported !== expected) return { ok: false, failure: 'NETWORK_MISMATCH' };
  return { ok: true, networkId: reported };
}
