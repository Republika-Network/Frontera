/**
 * The Generic HTTP Execution Adapter's **public configuration contract** — the
 * only part of this module a deployment ever writes.
 *
 * ```
 * ValidatedExecutionAction  +  this configuration (operator-pinned)
 *   -> one HTTPS request to one pinned origin
 * ```
 *
 * The caller may describe the governed action. The caller may never describe
 * where or how the network effect is sent: every field below is trusted host
 * configuration, supplied to `createEnterprise` and snapshotted at composition,
 * and nothing a caller sends can reach any of it.
 *
 * ## Closed and declarative, on purpose
 *
 * There is no callback, template, expression, path language or function that
 * receives the action and returns a URL. A value is either an operator literal
 * or **one named field** of `ValidatedExecutionAction`; a path is a list of
 * segments, each encoded as exactly one URL path segment; a body is a flat JSON
 * object. Boring is the security property: a mapping that cannot compute
 * cannot be made to compute a destination.
 *
 * There is equally no transport, agent, proxy, resolver, redirect, retry, TLS or
 * private-network option. The adapter binds its own Node HTTPS transport, and a
 * key this contract does not declare is **refused at composition**, so
 * `followRedirects: true` or `allowPrivateNetwork: true` fails startup rather
 * than being silently ignored.
 *
 * See `docs/enterprise/AOC_GENERIC_HTTP_EXECUTION_ADAPTER.md`.
 */

/** The effect-bearing methods Stage A supports. There is no GET: this adapter produces effects; it does not fetch data. */
export type EnterpriseGenericHttpMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * The fields of `ValidatedExecutionAction` a mapping may read — each already
 * proven inside the grant's bounds, or read from the trusted grant, or derived
 * by the server.
 *
 * Deliberately absent: `boundedGrantId` (internal authority plumbing, never a
 * provider value), anything from `assertedContext` (it never reaches the
 * execution boundary at all), the caller's original body, the API key, the
 * Authorization header, the adapter's own configuration and `process.env`.
 */
export type EnterpriseGenericHttpActionSource =
  | 'subject'
  | 'action'
  | 'resource'
  | 'counterparty'
  | 'organization'
  | 'amount.value'
  | 'amount.unit'
  | 'notAfter'
  | 'correlation.requestId'
  | 'correlation.decisionId'
  | 'correlation.executionId';

/**
 * One destination value: exactly one action field, or one operator literal.
 *
 * `required` defaults to **true**. A required source the action does not carry
 * (an absent `counterparty`, `organization` or `amount`) stops the request
 * before any network I/O, as `ADAPTER_ERROR`. `required: false` omits the
 * destination field instead.
 */
export type EnterpriseGenericHttpValueBinding =
  | {
      readonly kind: 'source';
      readonly source: EnterpriseGenericHttpActionSource;
      readonly required?: boolean;
    }
  | {
      readonly kind: 'literal';
      readonly value: string | number | boolean | null;
    };

/** One URL path segment. Always required; always encoded as exactly one segment. */
export type EnterpriseGenericHttpPathSegment =
  | { readonly kind: 'literal'; readonly value: string }
  | { readonly kind: 'source'; readonly source: EnterpriseGenericHttpActionSource };

/**
 * The provider credential. Operator configuration only; snapshotted at
 * composition; injected by the adapter and never placed in a URL, a body, a
 * result, a record or a log.
 *
 * Stage A keeps the configured secret **in process memory**. There is no KMS,
 * HSM, OAuth, refresh or mTLS here, and none is claimed.
 */
export type EnterpriseGenericHttpCredential =
  | {
      /** Sent as `Authorization: Bearer <token>`. The only way to set `Authorization`. */
      readonly kind: 'bearer';
      readonly token: string;
    }
  | {
      /** One explicit credential header, such as `X-API-Key`. May not name a protocol, proxy, cookie or Authorization header. */
      readonly kind: 'header';
      readonly name: string;
      readonly value: string;
    };

/** A flat JSON object. No nesting, no merge, no caller-shaped structure. */
export interface EnterpriseGenericHttpJsonBody {
  readonly kind: 'json-object';
  readonly fields: Readonly<Record<string, EnterpriseGenericHttpValueBinding>>;
}

/**
 * One pinned HTTPS integration. A deployment with several destinations composes
 * several of these and lets the **existing** trusted registry select among them
 * — this adapter has no router of its own.
 */
export interface EnterpriseGenericHttpExecutionAdapterOptions {
  /** The identity the registry routes by, emergency control scopes to, and the execution record names. Must be recordable. */
  readonly adapterId: string;
  /** The **exact** trusted origin: `https://` + DNS hostname + optional port, and nothing else. */
  readonly origin: string;
  readonly method: EnterpriseGenericHttpMethod;
  /** Segments, not a template. */
  readonly path: readonly EnterpriseGenericHttpPathSegment[];
  readonly query?: Readonly<Record<string, EnterpriseGenericHttpValueBinding>>;
  readonly headers?: Readonly<Record<string, EnterpriseGenericHttpValueBinding>>;
  readonly body?: EnterpriseGenericHttpJsonBody;
  readonly credential?: EnterpriseGenericHttpCredential;
  /** Optional provider correlation, read from **one** response header. Evidence only — never followed, never interpreted. */
  readonly providerRefHeader?: string;
  /** Whole-attempt budget in milliseconds, 100 through 60000. Default 10000. There is no "0 = unlimited". */
  readonly timeoutMs?: number;
}

/**
 * Composition defects. Thrown by `createEnterprise` before any store is opened
 * and before any traffic is served: a bad deployment fails startup, never one
 * customer action at a time. Messages name the defect and never echo a value
 * — a credential, a header value or a literal never appears in one.
 */
export type EnterpriseGenericHttpConfigurationErrorCode =
  | 'GENERIC_HTTP_OPTIONS_INVALID'
  | 'GENERIC_HTTP_ADAPTER_ID_INVALID'
  | 'GENERIC_HTTP_ORIGIN_INVALID'
  | 'GENERIC_HTTP_METHOD_INVALID'
  | 'GENERIC_HTTP_PATH_INVALID'
  | 'GENERIC_HTTP_MAPPING_INVALID'
  | 'GENERIC_HTTP_HEADER_INVALID'
  | 'GENERIC_HTTP_CREDENTIAL_INVALID'
  | 'GENERIC_HTTP_LIMIT_INVALID';

export class GenericHttpConfigurationError extends Error {
  constructor(
    readonly code: EnterpriseGenericHttpConfigurationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GenericHttpConfigurationError';
  }
}

export function isGenericHttpConfigurationError(error: unknown): error is GenericHttpConfigurationError {
  return error instanceof GenericHttpConfigurationError;
}

/**
 * Stage A bounds. Small, explicit, and never "0 = unlimited". Anything outside
 * them fails composition, or fails request construction before the network.
 */
export const GENERIC_HTTP_LIMITS = Object.freeze({
  maxUrlLength: 8 * 1024,
  maxQueryFields: 64,
  maxHeaders: 32,
  maxBodyFields: 64,
  maxBodyBytes: 64 * 1024,
  maxHeaderValueLength: 4 * 1024,
  maxTotalHeaderBytes: 16 * 1024,
  maxProviderRefLength: 512,
  maxPathSegments: 32,
  maxNameLength: 128,
  maxLiteralLength: 4 * 1024,
  defaultTimeoutMs: 10_000,
  minTimeoutMs: 100,
  maxTimeoutMs: 60_000,
});
