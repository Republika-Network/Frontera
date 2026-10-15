import { Client, NotConnectedError, RippledError } from 'xrpl';
import { isPermittedXrplNetworkId, isXrplLedgerIndex, isXrplTransactionHash } from '../../../xrpl-transport/index.js';
import { decodeXrplSignedBlob, isXrplSignedBlob, xrplSignedBlobHash } from '../../../xrpl-transport/xrpl-signature.js';
import { XrplRailConfigurationError, isXrplRlusdRailConfiguration, type XrplRlusdRailConfiguration } from './xrpl-config.js';
import { XrplSubmissionNotAttemptedError, type XrplClientPort, type XrplPaymentTransaction } from './xrpl-client-port.js';

type XrplRead = (request: Record<string, unknown>, timeoutMs: number | undefined) => Promise<{ readonly result: unknown }>;

/**
 * One SDK client over one endpoint, and the only two ways this file talks
 * through it: bounded reads, and **the** `submit` request. Private to this
 * file: both exported constructors below build on it, so the repository's one
 * `submit` request is written exactly once (`requestSubmit`) whichever
 * submission domain reaches it (TRADE-04C, gate G2).
 */
function openXrplSdkConnection(endpoint: string, requestTimeoutMs: number): { readonly client: Client; readonly read: XrplRead; readonly requestSubmit: (signedTransaction: string) => Promise<unknown> } {
  const client = new Client(endpoint, { timeout: requestTimeoutMs, connectionTimeout: requestTimeoutMs });

  /**
   * A read under `min(requestTimeoutMs, timeoutMs)`. The SDK's own
   * per-request timeout (`Connection.request(request, timeout)`, which
   * `Client.request` delegates to after adding the API version) rejects the
   * request and forgets it when it elapses — a late answer is discarded, so
   * nothing is left outstanding past the caller's budget. Reads only.
   */
  const read: XrplRead = async (request, timeoutMs) => {
    const timeout = Math.max(1, Math.floor(Math.min(requestTimeoutMs, timeoutMs ?? requestTimeoutMs)));
    return (await client.connection.request({ ...request, api_version: client.apiVersion } as never, timeout)) as { readonly result: unknown };
  };

  /** The repository's one XRPL write: `fail_hard`, one request, no retry. Callers prove the blob may be sent before calling it. */
  const requestSubmit = async (signedTransaction: string): Promise<unknown> => (await client.request({ command: 'submit', tx_blob: signedTransaction, fail_hard: true })).result;

  return { client, read, requestSubmit };
}

/** A `tx` lookup: the raw result, or a server error answer as `{ error, searched_all }`. Throws for a transport failure. */
async function lookupTransactionOn(read: XrplRead, query: { readonly hash: string; readonly minLedger: number; readonly maxLedger: number }, timeoutMs?: number): Promise<unknown> {
  try {
    return (await read({ command: 'tx', transaction: query.hash, min_ledger: query.minLedger, max_ledger: query.maxLedger }, timeoutMs)).result;
  } catch (error) {
    if (error instanceof RippledError) {
      const data = (error as { readonly data?: unknown }).data;
      const record = data !== null && typeof data === 'object' ? (data as Readonly<Record<string, unknown>>) : {};
      return { error: record['error'], searched_all: record['searched_all'] };
    }
    throw error;
  }
}

/**
 * The `XrplClientPort` over the official XRPL JavaScript SDK (`xrpl`) — the
 * **only** production source that opens an XRPL connection or submits a
 * transaction (EP-069 in `NO_BYPASS_AUTHORITY_CONTROLLED_EXECUTION.md`).
 *
 * One WebSocket client to the one configured endpoint, opened on demand by the
 * rail (`connect`) and closed by `disconnect`. No background loop of its own;
 * the SDK may re-establish a dropped socket, but it never re-sends a request
 * that was in flight — a request interrupted by a disconnect is rejected, and
 * the rail treats a rejected `submit` as possibly submitted.
 *
 * `submit` sends `fail_hard: true`, so a transaction that fails locally is
 * neither held nor relayed by the server. It is the single `submit` request in
 * this repository and is made at most once per call — no retry.
 */
export function createXrplSdkClient(configuration: XrplRlusdRailConfiguration): XrplClientPort {
  if (!isXrplRlusdRailConfiguration(configuration)) throw new XrplRailConfigurationError('configuration', 'must come from createXrplRlusdRailConfiguration');
  const { client, read, requestSubmit } = openXrplSdkConnection(configuration.endpoint, configuration.requestTimeoutMs);

  return Object.freeze({
    async connect(): Promise<void> {
      if (!client.isConnected()) await client.connect();
    },
    async disconnect(): Promise<void> {
      if (client.isConnected()) await client.disconnect();
    },
    async serverInfo(): Promise<unknown> {
      return (await client.request({ command: 'server_info' })).result;
    },
    async validatedLedgerIndex(timeoutMs?: number): Promise<unknown> {
      const response = await read({ command: 'ledger', ledger_index: 'validated' }, timeoutMs);
      const result = response.result;
      return result !== null && typeof result === 'object' ? (result as { readonly ledger_index?: unknown }).ledger_index : undefined;
    },
    async ledgerHeader(index: number, timeoutMs?: number): Promise<unknown> {
      const response = await read({ command: 'ledger', ledger_index: index }, timeoutMs);
      const result = response.result;
      if (result === null || typeof result !== 'object') return undefined;
      const { ledger_index, ledger_hash, ledger, validated } = result as { readonly ledger_index?: unknown; readonly ledger_hash?: unknown; readonly ledger?: unknown; readonly validated?: unknown };
      const close_time = ledger !== null && typeof ledger === 'object' ? (ledger as { readonly close_time?: unknown }).close_time : undefined;
      // The validated ledger's own hash, as rippled states it for every `ledger` answer (PAY-05 finality evidence).
      return { ledger_index, ledger_hash, close_time, validated };
    },
    async autofill(transaction: XrplPaymentTransaction): Promise<unknown> {
      // A copy: the SDK fills the object it is handed.
      return client.autofill({ ...transaction, Amount: { ...transaction.Amount } });
    },
    async submit(signedTransaction: string): Promise<unknown> {
      if (!client.isConnected()) throw new XrplSubmissionNotAttemptedError();
      try {
        return await requestSubmit(signedTransaction);
      } catch (error) {
        // The SDK raises NotConnectedError before writing to the socket; nothing left the process.
        if (error instanceof NotConnectedError) throw new XrplSubmissionNotAttemptedError();
        throw error;
      }
    },
    async lookupTransaction(query: { readonly hash: string; readonly minLedger: number; readonly maxLedger: number }, timeoutMs?: number): Promise<unknown> {
      return lookupTransactionOn(read, query, timeoutMs);
    },
  });
}

/**
 * TRADE-04C, gate G2 — the transport-level configuration of a reserved
 * submission client: one `wss://` endpoint, one network, one request timeout.
 * Never mainnet: the network id must be a known non-mainnet XRPL network.
 */
export interface XrplReservedSubmissionConfiguration {
  readonly endpoint: string;
  readonly networkId: number;
  readonly requestTimeoutMs: number;
}

const RESERVED_CONFIGURATIONS = new WeakSet<object>();
const ENDPOINT_MAXIMUM_LENGTH = 2048;

/** Validates and brands a reserved submission configuration, or throws `XrplRailConfigurationError` naming the field. */
export function createXrplReservedSubmissionConfiguration(input: { readonly endpoint: unknown; readonly networkId: unknown; readonly requestTimeoutMs: unknown }): XrplReservedSubmissionConfiguration {
  const refuse = (field: string, message: string): never => {
    throw new XrplRailConfigurationError(field, message);
  };
  const endpoint = input?.endpoint;
  if (typeof endpoint !== 'string' || endpoint.length === 0 || endpoint.length > ENDPOINT_MAXIMUM_LENGTH) return refuse('endpoint', 'must be a non-empty wss:// URL of bounded length');
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return refuse('endpoint', 'must be a wss:// URL');
  }
  if (url.protocol !== 'wss:') refuse('endpoint', 'must use wss://');
  if (url.username !== '' || url.password !== '') refuse('endpoint', 'must not carry credentials');
  if (url.search !== '' || url.hash !== '') refuse('endpoint', 'must not carry a query or fragment');
  if (url.hostname === '') refuse('endpoint', 'must name a host');
  if (!isPermittedXrplNetworkId(input.networkId, false)) refuse('networkId', 'must be a known XRPL network other than mainnet');
  const timeout = input.requestTimeoutMs;
  if (typeof timeout !== 'number' || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000) refuse('requestTimeoutMs', 'must be an integer from 1 to 60000');
  const configuration = Object.freeze({ endpoint, networkId: input.networkId as number, requestTimeoutMs: timeout as number });
  RESERVED_CONFIGURATIONS.add(configuration);
  return configuration;
}

/**
 * What the submit site states about the one signed blob it is asked to send,
 * read from the blob itself (never from the caller): its own hash and the
 * fields that bind it to a sequence window.
 */
export interface XrplSubmissionClaim {
  readonly executionId: string;
  readonly networkId: number;
  readonly transactionHash: string;
  readonly transactionType: string;
  readonly account: string;
  readonly sequence: number;
  readonly lastLedgerSequence: number;
}

/**
 * The durable sequence authority a reserved submission client is bound to at
 * construction. `claimSubmission` must, atomically and durably, move the one
 * reservation recorded for `executionId` from *reserved* to *submitting* —
 * and only when every field of the claim equals that reservation and it was
 * never claimed before. It throws otherwise; then nothing is sent.
 */
export interface XrplReservedSubmissionAuthority {
  claimSubmission(claim: XrplSubmissionClaim): Promise<void>;
}

/** Thrown by `submitReserved` when the blob was not sent because no matching, unclaimed durable reservation exists (or the blob is unreadable). */
export class XrplReservedSubmissionRefusedError extends Error {
  readonly code: 'XRPL_RESERVED_SUBMISSION_REFUSED';

  constructor() {
    super('The XRPL submission was refused before anything was sent: no matching, unclaimed durable reservation.');
    this.name = 'XrplReservedSubmissionRefusedError';
    this.code = 'XRPL_RESERVED_SUBMISSION_REFUSED';
  }
}

/**
 * The reserved submission client (TRADE-04C, G2): reads, plus **one** way to
 * write — `submitReserved(executionId, blob)`, which sends the blob through
 * the file's one `submit` request only after the bound sequence authority has
 * durably claimed the execution's reservation for exactly this blob.
 *
 * ```
 * submitReserved(executionId, blob)
 *   ├─ not connected                                   → XrplSubmissionNotAttemptedError (nothing claimed, nothing sent)
 *   ├─ blob decoded HERE; hash recomputed HERE
 *   ├─ authority.claimSubmission({ executionId, network, hash, type, account, Sequence, LastLedgerSequence })
 *   │     refused / unreadable                          → XrplReservedSubmissionRefusedError (nothing sent)
 *   └─ requestSubmit(blob) ONCE                         → raw answer; any throw after this point: possibly sent
 * ```
 *
 * There is no `submit(blob)` on it and no way to swap its authority: the
 * authority is fixed when the client is built, by trusted Host composition.
 * A claim is single-use and durable, so a second call for the same execution
 * — from this process, another one, or after a restart — is refused before
 * anything is sent. Transaction-neutral: the authority, not this file,
 * decides which transaction types its reservations may carry.
 */
export interface XrplReservedSubmissionClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  serverInfo(): Promise<unknown>;
  validatedLedgerIndex(timeoutMs?: number): Promise<unknown>;
  /** The raw `ledger` result for the ledger with sequence `index` (header only). */
  ledgerHeader(index: number): Promise<unknown>;
  /** The raw `ledger_entry` result; an error answer such as `entryNotFound` is answered as its data, not thrown. */
  ledgerEntry(request: Readonly<Record<string, unknown>>): Promise<unknown>;
  lookupTransaction(query: { readonly hash: string; readonly minLedger: number; readonly maxLedger: number }, timeoutMs?: number): Promise<unknown>;
  submitReserved(executionId: string, signedTransaction: string): Promise<unknown>;
}

/**
 * The claim a signed blob makes, read from the blob alone: its own hash, type,
 * account, `Sequence` and `LastLedgerSequence`, plus the client's network and
 * the execution it is submitted for. `undefined` for anything unreadable.
 * Pure; used by `submitReserved` and by offline qualification doubles of it,
 * so both state exactly the same claim.
 */
export function xrplSubmissionClaimOf(executionId: string, networkId: number, signedTransaction: unknown): XrplSubmissionClaim | undefined {
  const decoded = isXrplSignedBlob(signedTransaction) ? decodeXrplSignedBlob(signedTransaction) : undefined;
  const transactionHash = decoded !== undefined ? xrplSignedBlobHash(signedTransaction) : undefined;
  if (typeof executionId !== 'string' || decoded === undefined || transactionHash === undefined || !isXrplTransactionHash(transactionHash)) return undefined;
  const { TransactionType, Account, Sequence, LastLedgerSequence } = decoded as Readonly<Record<string, unknown>>;
  if (typeof TransactionType !== 'string' || typeof Account !== 'string' || !isXrplLedgerIndex(Sequence) || !isXrplLedgerIndex(LastLedgerSequence)) return undefined;
  return Object.freeze({ executionId, networkId, transactionHash, transactionType: TransactionType, account: Account, sequence: Sequence, lastLedgerSequence: LastLedgerSequence });
}

const LEDGER_ENTRY_SELECTORS = ['delegate', 'offer', 'account_root'] as const;

export function createXrplReservedSubmissionClient(configuration: XrplReservedSubmissionConfiguration, authority: XrplReservedSubmissionAuthority): XrplReservedSubmissionClient {
  if (!RESERVED_CONFIGURATIONS.has(configuration as object)) throw new XrplRailConfigurationError('configuration', 'must come from createXrplReservedSubmissionConfiguration');
  if (typeof authority?.claimSubmission !== 'function') throw new XrplRailConfigurationError('authority', 'must be a durable sequence authority');
  const claim = (submission: XrplSubmissionClaim): Promise<void> => authority.claimSubmission.call(authority, submission);
  const { client, read, requestSubmit } = openXrplSdkConnection(configuration.endpoint, configuration.requestTimeoutMs);

  const rippledData = (error: unknown): Readonly<Record<string, unknown>> | undefined => {
    if (!(error instanceof RippledError)) return undefined;
    const data = (error as { readonly data?: unknown }).data;
    return data !== null && typeof data === 'object' ? (data as Readonly<Record<string, unknown>>) : {};
  };

  return Object.freeze({
    async connect(): Promise<void> {
      if (!client.isConnected()) await client.connect();
    },
    async disconnect(): Promise<void> {
      if (client.isConnected()) await client.disconnect();
    },
    async serverInfo(): Promise<unknown> {
      return (await read({ command: 'server_info' }, undefined)).result;
    },
    async validatedLedgerIndex(timeoutMs?: number): Promise<unknown> {
      const result = (await read({ command: 'ledger', ledger_index: 'validated' }, timeoutMs)).result;
      return result !== null && typeof result === 'object' ? (result as { readonly ledger_index?: unknown }).ledger_index : undefined;
    },
    async ledgerHeader(index: number): Promise<unknown> {
      const result = (await read({ command: 'ledger', ledger_index: index }, undefined)).result;
      if (result === null || typeof result !== 'object') return undefined;
      const { ledger_index, ledger_hash, ledger, validated } = result as { readonly ledger_index?: unknown; readonly ledger_hash?: unknown; readonly ledger?: unknown; readonly validated?: unknown };
      const close_time = ledger !== null && typeof ledger === 'object' ? (ledger as { readonly close_time?: unknown }).close_time : undefined;
      return { ledger_index, ledger_hash, close_time, validated };
    },
    async ledgerEntry(request: Readonly<Record<string, unknown>>): Promise<unknown> {
      // Closed: one known selector and `ledger_index: 'validated'`, nothing else is ever asked.
      const keys = Object.keys(request ?? {});
      const selector = keys.find((key) => key !== 'ledger_index');
      if (keys.length !== 2 || request['ledger_index'] !== 'validated' || selector === undefined || !(LEDGER_ENTRY_SELECTORS as readonly string[]).includes(selector)) throw new TypeError('Unsupported ledger_entry request.');
      try {
        return (await read({ command: 'ledger_entry', [selector]: request[selector], ledger_index: 'validated' }, undefined)).result;
      } catch (error) {
        const data = rippledData(error);
        if (data === undefined) throw error;
        return { error: data['error'], ledger_index: data['ledger_index'], ledger_hash: data['ledger_hash'], validated: data['validated'] };
      }
    },
    async lookupTransaction(query: { readonly hash: string; readonly minLedger: number; readonly maxLedger: number }, timeoutMs?: number): Promise<unknown> {
      return lookupTransactionOn(read, query, timeoutMs);
    },
    async submitReserved(executionId: string, signedTransaction: string): Promise<unknown> {
      if (!client.isConnected()) throw new XrplSubmissionNotAttemptedError();
      // The claim is read from the blob itself: whatever the caller believes about it is irrelevant.
      const submission = xrplSubmissionClaimOf(executionId, configuration.networkId, signedTransaction);
      if (submission === undefined) throw new XrplReservedSubmissionRefusedError();
      try {
        await claim(submission);
      } catch {
        throw new XrplReservedSubmissionRefusedError();
      }
      try {
        return await requestSubmit(signedTransaction);
      } catch (error) {
        // The SDK raises NotConnectedError before writing to the socket; nothing left the process (the claim stays: the record blocks until the ledger closes its window).
        if (error instanceof NotConnectedError) throw new XrplSubmissionNotAttemptedError();
        throw error;
      }
    },
  });
}
