/**
 * ANDREW-DEMO-UI-01 — the explicit release point between AUTHORIZED and
 * EXECUTE.
 *
 * The Host evaluates, issues the bounded grant, passes the exercise gate and
 * routes to the XRPL adapter in one governed request; the adapter then hands
 * the translated payment to its transport. This gate wraps that transport:
 * the submission is **held before anything is signed** until the operator
 * clicks EXECUTE. Nothing about the decision or the grant is changed — the
 * gate only decides *when* the already-authorized submission reaches the real
 * transport, and whether it does at all:
 *
 * - `release()` hands it to the real transport (P0-08 for LIVE, the same
 *   transport over the scripted ledger for REHEARSAL);
 * - `abandon()` answers `not-submitted` — the adapter contract's "proven not
 *   to have reached the network" — because nothing was signed or sent.
 *
 * One gate admits exactly one submission. A second submission is answered
 * `not-submitted` without reaching the transport and is recorded as an
 * invariant violation for the caller to fail on.
 */

/** The non-secret facts of a held submission, as the adapter handed them over. */
export interface HeldSubmission {
  readonly executionId: string;
  readonly requestId: string;
  readonly decisionId: string;
  readonly notAfter: string;
  readonly network: string | undefined;
  readonly destination: string;
  readonly amount: { readonly value: string; readonly currency: string; readonly issuer: string } | undefined;
  readonly heldAt: string;
}

export type GateState = 'armed' | 'held' | 'released' | 'abandoned';

export interface ExecutionGate {
  /** Wraps the transport the composition will receive. */
  wrap(transport: unknown): unknown;
  state(): GateState;
  held(): HeldSubmission | undefined;
  /** Resolves when a submission arrives at the gate. */
  arrival(): Promise<HeldSubmission>;
  release(): void;
  abandon(): void;
  /** Submissions refused because the gate had already admitted one. Must stay 0. */
  extraSubmissions(): number;
}

interface SubmissionLike {
  readonly executionId?: unknown;
  readonly requestId?: unknown;
  readonly decisionId?: unknown;
  readonly notAfter?: unknown;
  readonly network?: unknown;
  readonly instruction?: { readonly Destination?: unknown; readonly Amount?: unknown };
}

interface TransportLike {
  submitPayment(submission: unknown): Promise<unknown>;
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

export function createExecutionGate(now: () => Date = () => new Date()): ExecutionGate {
  let state: GateState = 'armed';
  let heldSubmission: HeldSubmission | undefined;
  let decide: ((go: boolean) => void) | undefined;
  let extra = 0;
  let notifyArrival: ((held: HeldSubmission) => void) | undefined;
  const arrived = new Promise<HeldSubmission>((resolve) => {
    notifyArrival = resolve;
  });

  return {
    wrap(transport) {
      const inner = transport as TransportLike;
      return Object.freeze({
        async submitPayment(submission: unknown): Promise<unknown> {
          if (state !== 'armed') {
            extra += 1;
            return { kind: 'not-submitted' };
          }
          const s = submission as SubmissionLike;
          const amount = s.instruction?.Amount as { readonly value?: unknown; readonly currency?: unknown; readonly issuer?: unknown } | undefined;
          heldSubmission = Object.freeze({
            executionId: text(s.executionId),
            requestId: text(s.requestId),
            decisionId: text(s.decisionId),
            notAfter: text(s.notAfter),
            network: typeof s.network === 'string' ? s.network : undefined,
            destination: text(s.instruction?.Destination),
            amount: amount !== undefined && typeof amount === 'object' ? { value: text(amount.value), currency: text(amount.currency), issuer: text(amount.issuer) } : undefined,
            heldAt: now().toISOString(),
          });
          state = 'held';
          const go = await new Promise<boolean>((resolve) => {
            decide = resolve;
            notifyArrival?.(heldSubmission as HeldSubmission);
          });
          if (!go) {
            state = 'abandoned';
            return { kind: 'not-submitted' };
          }
          state = 'released';
          return inner.submitPayment(submission);
        },
      });
    },
    state: () => state,
    held: () => heldSubmission,
    arrival: () => arrived,
    release() {
      if (state !== 'held' || decide === undefined) throw new Error('No held submission to release.');
      const go = decide;
      decide = undefined;
      go(true);
    },
    abandon() {
      if (state !== 'held' || decide === undefined) return;
      const stop = decide;
      decide = undefined;
      stop(false);
    },
    extraSubmissions: () => extra,
  };
}
