/**
 * The Generic HTTP Execution Adapter — one pinned HTTPS integration, composed
 * as a child of the trusted execution adapter registry. See
 * `docs/enterprise/AOC_GENERIC_HTTP_EXECUTION_ADAPTER.md`.
 *
 * Only the configuration contract and the production factory leave this
 * module. The Enterprise barrel re-exports the configuration **types** alone;
 * the factory is reached through `createEnterprise`, and the address policy,
 * the request mapper, the Node transport and the adapter core are not exported
 * from here at all — a consumer cannot obtain an open HTTP client or
 * substitute a transport through any supported surface.
 */
export {
  GENERIC_HTTP_LIMITS,
  GenericHttpConfigurationError,
  isGenericHttpConfigurationError,
  type EnterpriseGenericHttpActionSource,
  type EnterpriseGenericHttpConfigurationErrorCode,
  type EnterpriseGenericHttpCredential,
  type EnterpriseGenericHttpExecutionAdapterOptions,
  type EnterpriseGenericHttpJsonBody,
  type EnterpriseGenericHttpMethod,
  type EnterpriseGenericHttpPathSegment,
  type EnterpriseGenericHttpValueBinding,
} from './contracts.js';
export { createGenericHttpExecutionAdapter } from './generic-http-execution-adapter.js';
