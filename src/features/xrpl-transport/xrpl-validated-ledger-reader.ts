import { isXrplLedgerIndex } from './xrpl-ledger-grammar.js';
import { isPermittedXrplNetworkId } from './xrpl-network-identity.js';
import {
  XRPL_VALIDATED_READ_FAILURES,
  bindXrplValidatedAnswer,
  isXrplNodePublicKey,
  readXrplServerValidatedLedger,
  readXrplValidatedLedgerHeader,
  type XrplValidatedLedger,
  type XrplValidatedLedgerHeader,
  type XrplValidatedReadFailure,
} from './xrpl-validated-ledger.js';

/**
 * The read-only validated-ledger reader (TRADE-04A).
 *
 * It reaches a ledger only through `XrplValidatedLedgerReadPort` — three read
 * requests, no way to prepare, sign or submit anything — and answers a value
 * only from validated evidence on the configured network:
 *
 * - **every read re-proves the network**: `server_info` is asked first, each
 *   time, and must state the configured `network_id` (and the pinned node
 *   identity, when configured). Nothing is remembered between reads but a
 *   monotonic floor, so a reconnect to another network or to a lagging node
 *   is refused, never silently followed;
 * - **validated only**: a current or closed-but-unvalidated answer is
 *   `NOT_VALIDATED`; an answer behind the reported validated ledger is
 *   `LEDGER_REGRESSED`; a second hash for one index is `LEDGER_HASH_CONFLICT`;
 * - **bounded**: each request under `requestTimeoutMs` (a late answer is
 *   discarded), each answer under `maxResponseBytes`; one attempt per request,
 *   no retry, no fallback node;
 * - **closed failures**: a failure is a code, never the port's error, message
 *   or endpoint — no credential can leak through it.
 *
 * Nothing composes a real port yet: a production port over the one XRPL
 * client is a later composition edge (TRADE-04B/C, ADR-XRPL-SHARED-TRANSPORT
 * §7). Satisfied here by deterministic fakes only.
 */

/** The ledger objects a validated read may select. Closed: an object kind the verticals do not need is not readable. */
export type XrplLedgerEntrySelector =
  /** XLS-75 `Delegate` entry for (owner, delegate). */
  | { readonly delegate: { readonly account: string; readonly authorize: string } }
  /** An `Offer` by its owner and the owner `Sequence` that created it. */
  | { readonly offer: { readonly account: string; readonly seq: number } }
  /** An `AccountRoot` by address. */
  | { readonly account_root: string };

export type XrplValidatedLedgerEntryRequest = XrplLedgerEntrySelector & { readonly ledger_index: 'validated' };

/**
 * The only three requests the reader can make. Each answers the JSON-RPC
 * `result` object exactly as the server sent it — error results such as
 * `entryNotFound` included — and rejects only when the server could not be
 * asked or did not answer.
 */
export interface XrplValidatedLedgerReadPort {
  /** `server_info`. */
  serverInfo(): Promise<unknown>;
  /** `ledger` header of the ledger with sequence `index`. */
  ledgerHeader(index: number): Promise<unknown>;
  /** `ledger_entry` at the latest validated ledger. */
  ledgerEntry(request: XrplValidatedLedgerEntryRequest): Promise<unknown>;
}

/** The timer the reader bounds each request with. Injected for deterministic qualification; default the process timers. */
export interface XrplReadTimer {
  set(callback: () => void, milliseconds: number): unknown;
  clear(handle: unknown): void;
}

export interface XrplValidatedLedgerReaderOptions {
  readonly port: XrplValidatedLedgerReadPort;
  /** The one network every answer must be from. Mainnet only with `allowMainnet: true`. */
  readonly networkId: number;
  readonly allowMainnet?: boolean;
  /** How long ago the latest validated ledger may have closed, 1 to 60 seconds. */
  readonly maxValidatedLedgerAgeSeconds: number;
  /** Per request, 1 to 60 000 ms. */
  readonly requestTimeoutMs: number;
  /** Per answer, 1 KiB to 1 MiB of its UTF-8 JSON form. */
  readonly maxResponseBytes: number;
  /** When trusted configuration pins the server's node identity (`pubkey_node`). */
  readonly nodePublicKey?: string;
  readonly timer?: XrplReadTimer;
}

export const XRPL_VALIDATED_READER_LIMITS = Object.freeze({
  maxValidatedLedgerAgeSeconds: Object.freeze({ minimum: 1, maximum: 60 }),
  requestTimeoutMs: Object.freeze({ minimum: 1, maximum: 60_000 }),
  maxResponseBytes: Object.freeze({ minimum: 1_024, maximum: 1_048_576 }),
});

export type XrplValidatedRead<T> = { readonly outcome: 'read'; readonly value: T } | { readonly outcome: 'unavailable'; readonly failure: XrplValidatedReadFailure };

/** A validated `ledger_entry` answer: the entry's node, or its validated absence, bound to a validated ledger. */
export interface XrplValidatedLedgerEntry {
  readonly validatedLedger: XrplValidatedLedger;
  readonly ledgerIndex: number;
  readonly ledgerHash: string;
  readonly entry: { readonly state: 'absent' } | { readonly state: 'present'; readonly node: unknown };
}

export interface XrplValidatedLedgerReader {
  validatedLedger(): Promise<XrplValidatedRead<XrplValidatedLedger>>;
  ledgerHeader(index: number): Promise<XrplValidatedRead<XrplValidatedLedgerHeader>>;
  ledgerEntry(selector: XrplLedgerEntrySelector): Promise<XrplValidatedRead<XrplValidatedLedgerEntry>>;
}

export class XrplValidatedReaderConfigurationError extends Error {
  readonly code: 'XRPL_TRANSPORT_CONFIGURATION_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'XrplValidatedReaderConfigurationError';
    this.code = 'XRPL_TRANSPORT_CONFIGURATION_INVALID';
  }
}

const F = XRPL_VALIDATED_READ_FAILURES;
const CLASSIC_ADDRESS = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
const DEFAULT_TIMER: XrplReadTimer = Object.freeze({
  set: (callback: () => void, milliseconds: number): unknown => setTimeout(callback, milliseconds),
  clear: (handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>),
});

function unavailable<T>(failure: XrplValidatedReadFailure): XrplValidatedRead<T> {
  return Object.freeze({ outcome: 'unavailable' as const, failure });
}

function read<T>(value: T): XrplValidatedRead<T> {
  return Object.freeze({ outcome: 'read' as const, value });
}

function inRange(value: unknown, limits: { readonly minimum: number; readonly maximum: number }): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= limits.minimum && value <= limits.maximum;
}

/** A closed copy of the selector, or `undefined`: exactly one known key, each value of its exact shape. */
function selectorOf(selector: unknown): XrplLedgerEntrySelector | undefined {
  if (selector === null || typeof selector !== 'object' || Array.isArray(selector)) return undefined;
  const keys = Object.keys(selector);
  if (keys.length !== 1) return undefined;
  const record = selector as Readonly<Record<string, unknown>>;
  const value = record[keys[0]!];
  switch (keys[0]) {
    case 'delegate': {
      const delegate = value as Readonly<Record<string, unknown>> | null;
      if (delegate === null || typeof delegate !== 'object' || Object.keys(delegate).length !== 2) return undefined;
      const { account, authorize } = delegate;
      if (typeof account !== 'string' || !CLASSIC_ADDRESS.test(account) || typeof authorize !== 'string' || !CLASSIC_ADDRESS.test(authorize) || account === authorize) return undefined;
      return Object.freeze({ delegate: Object.freeze({ account, authorize }) });
    }
    case 'offer': {
      const offer = value as Readonly<Record<string, unknown>> | null;
      if (offer === null || typeof offer !== 'object' || Object.keys(offer).length !== 2) return undefined;
      const { account, seq } = offer;
      if (typeof account !== 'string' || !CLASSIC_ADDRESS.test(account) || !isXrplLedgerIndex(seq)) return undefined;
      return Object.freeze({ offer: Object.freeze({ account, seq }) });
    }
    case 'account_root':
      return typeof value === 'string' && CLASSIC_ADDRESS.test(value) ? Object.freeze({ account_root: value }) : undefined;
    default:
      return undefined;
  }
}

export function createXrplValidatedLedgerReader(options: XrplValidatedLedgerReaderOptions): XrplValidatedLedgerReader {
  if (typeof options !== 'object' || options === null) throw new XrplValidatedReaderConfigurationError('Validated reader options are required.');
  const { port, networkId, maxValidatedLedgerAgeSeconds, requestTimeoutMs, maxResponseBytes, nodePublicKey } = options;
  if (typeof port !== 'object' || port === null || typeof port.serverInfo !== 'function' || typeof port.ledgerHeader !== 'function' || typeof port.ledgerEntry !== 'function') {
    throw new XrplValidatedReaderConfigurationError('A read port with serverInfo, ledgerHeader and ledgerEntry is required.');
  }
  if (options.allowMainnet !== undefined && typeof options.allowMainnet !== 'boolean') throw new XrplValidatedReaderConfigurationError('allowMainnet must be a boolean.');
  if (!isPermittedXrplNetworkId(networkId, options.allowMainnet === true)) throw new XrplValidatedReaderConfigurationError('The network id must be a known XRPL network; mainnet needs an explicit allowMainnet: true.');
  const L = XRPL_VALIDATED_READER_LIMITS;
  if (!inRange(maxValidatedLedgerAgeSeconds, L.maxValidatedLedgerAgeSeconds)) throw new XrplValidatedReaderConfigurationError('maxValidatedLedgerAgeSeconds is out of range.');
  if (!inRange(requestTimeoutMs, L.requestTimeoutMs)) throw new XrplValidatedReaderConfigurationError('requestTimeoutMs is out of range.');
  if (!inRange(maxResponseBytes, L.maxResponseBytes)) throw new XrplValidatedReaderConfigurationError('maxResponseBytes is out of range.');
  if (nodePublicKey !== undefined && !isXrplNodePublicKey(nodePublicKey)) throw new XrplValidatedReaderConfigurationError('nodePublicKey must be a node public key (n…).');
  const timer = options.timer ?? DEFAULT_TIMER;
  if (typeof timer?.set !== 'function' || typeof timer.clear !== 'function') throw new XrplValidatedReaderConfigurationError('timer must implement set and clear.');
  const encoder = new TextEncoder();

  /** The highest validated index any read has seen. A server reporting less is behind what this reader already proved. */
  let floor = 0;

  /** One request, bounded in time and size. Answers the raw result, or a failure code. Never throws; never retries. */
  async function ask(request: () => Promise<unknown>): Promise<{ readonly raw: unknown } | XrplValidatedReadFailure> {
    let handle: unknown;
    const expired = new Promise<XrplValidatedReadFailure>((resolve) => {
      handle = timer.set(() => resolve(F.TIMEOUT), requestTimeoutMs);
    });
    let answered: Promise<{ readonly raw: unknown } | XrplValidatedReadFailure>;
    try {
      answered = request().then(
        (raw) => ({ raw }),
        () => F.LEDGER_UNREACHABLE,
      );
    } catch {
      answered = Promise.resolve(F.LEDGER_UNREACHABLE);
    }
    try {
      const outcome = await Promise.race([answered, expired]);
      if (typeof outcome === 'string') return outcome;
      let size: number;
      try {
        const text = JSON.stringify(outcome.raw);
        if (typeof text !== 'string') return F.RESPONSE_MALFORMED;
        size = encoder.encode(text).length;
      } catch {
        return F.RESPONSE_MALFORMED;
      }
      return size > maxResponseBytes ? F.RESPONSE_TOO_LARGE : outcome;
    } finally {
      timer.clear(handle);
    }
  }

  async function currentValidatedLedger(): Promise<XrplValidatedLedger | XrplValidatedReadFailure> {
    const answer = await ask(() => port.serverInfo());
    if (typeof answer === 'string') return answer;
    const ledger = readXrplServerValidatedLedger(answer.raw, { networkId, maxAgeSeconds: maxValidatedLedgerAgeSeconds, ...(nodePublicKey !== undefined ? { nodePublicKey } : {}) });
    if (typeof ledger === 'string') return ledger;
    if (ledger.ledgerIndex < floor) return F.LEDGER_REGRESSED;
    floor = ledger.ledgerIndex;
    return ledger;
  }

  async function validatedLedger(): Promise<XrplValidatedRead<XrplValidatedLedger>> {
    const ledger = await currentValidatedLedger();
    return typeof ledger === 'string' ? unavailable(ledger) : read(ledger);
  }

  async function ledgerHeader(index: number): Promise<XrplValidatedRead<XrplValidatedLedgerHeader>> {
    if (!isXrplLedgerIndex(index)) return unavailable(F.READER_INVALID);
    const ledger = await currentValidatedLedger();
    if (typeof ledger === 'string') return unavailable(ledger);
    // A header the network has not validated yet is not evidence of anything.
    if (index > ledger.ledgerIndex) return unavailable(F.NOT_VALIDATED);
    const answer = await ask(() => port.ledgerHeader(index));
    if (typeof answer === 'string') return unavailable(answer);
    const header = readXrplValidatedLedgerHeader(answer.raw, index);
    if (typeof header === 'string') return unavailable(header);
    if (header.ledgerIndex === ledger.ledgerIndex && header.ledgerHash !== ledger.ledgerHash) return unavailable(F.LEDGER_HASH_CONFLICT);
    return read(header);
  }

  async function ledgerEntry(selector: XrplLedgerEntrySelector): Promise<XrplValidatedRead<XrplValidatedLedgerEntry>> {
    const closed = selectorOf(selector);
    if (closed === undefined) return unavailable(F.READER_INVALID);
    const ledger = await currentValidatedLedger();
    if (typeof ledger === 'string') return unavailable(ledger);
    const request = Object.freeze({ ...closed, ledger_index: 'validated' as const });
    const answer = await ask(() => port.ledgerEntry(request));
    if (typeof answer === 'string') return unavailable(answer);
    const raw = answer.raw as Readonly<Record<string, unknown>> | null;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return unavailable(F.RESPONSE_MALFORMED);
    const error = Object.getOwnPropertyDescriptor(raw, 'error')?.value as unknown;
    // Absence is an answer only from a validated ledger that says which one it is.
    if (error !== undefined && error !== 'entryNotFound') return unavailable(F.LEDGER_ERROR);
    const bound = bindXrplValidatedAnswer(raw, ledger);
    if (typeof bound === 'string') return unavailable(bound);
    if (bound.ledgerIndex > floor) floor = bound.ledgerIndex;
    const node = Object.getOwnPropertyDescriptor(raw, 'node')?.value as unknown;
    if (error === undefined && (node === null || typeof node !== 'object' || Array.isArray(node))) return unavailable(F.RESPONSE_MALFORMED);
    return read(
      Object.freeze({
        validatedLedger: ledger,
        ledgerIndex: bound.ledgerIndex,
        ledgerHash: bound.ledgerHash,
        entry: error === undefined ? Object.freeze({ state: 'present' as const, node }) : Object.freeze({ state: 'absent' as const }),
      }),
    );
  }

  return Object.freeze({ validatedLedger, ledgerHeader, ledgerEntry });
}
