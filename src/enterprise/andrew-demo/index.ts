/**
 * The Andrew demo composition (ANDREW-P0-07): governed USD settled as RLUSD on
 * XRPL Testnet, on the shipped Enterprise Host. See
 * `docs/demo/andrew/ANDREW-P0-07-TESTNET-RLUSD-COMPOSITION.md`.
 *
 * Demo-only and opt-in: not re-exported from the Enterprise barrel, not on the
 * frozen API surface, and not imported by the Host, the composition root or
 * any generic module, so the default Host never becomes XRPL-specific.
 */
export {
  ANDREW_GOVERNED_ASSET,
  ANDREW_TESTNET_RLUSD_SETTLEMENT,
  ANDREW_XRPL_DESTINATION_NAMESPACE,
  ANDREW_XRPL_NETWORK,
  AndrewSettlementConfigurationError,
  RLUSD_CURRENCY_CODE,
  RLUSD_XRPL_MAINNET_ISSUER,
  RLUSD_XRPL_TESTNET_ISSUER,
  andrewSettlementProfile,
  andrewXrplAdapterOptions,
  assertAndrewSettlement,
  type AndrewSettlementConfiguration,
} from './rlusd-testnet-settlement.js';
export { createRecordingXrplTransport, type RecordingXrplTransport } from './recording-xrpl-transport.js';
export {
  ANDREW_LIFETIME_LIMIT_USD,
  ANDREW_PER_TRANSFER_CEILING_USD,
  ANDREW_TRANSFER_ACTION,
  ANDREW_TRANSFER_ACTION_CLASS,
  ANDREW_TREASURY_RESOURCE,
  ANDREW_TREASURY_RESOURCE_CLASS,
  ANDREW_XRPL_ADAPTER_ID,
  composeAndrewDemo,
  type AndrewDemo,
  type AndrewDemoIdentity,
  type AndrewDemoOperator,
  type AndrewDemoOptions,
} from './andrew-demo-composition.js';
