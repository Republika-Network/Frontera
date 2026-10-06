/**
 * ANDREW-P0-11 — the one-command Andrew/LUMX demo harness: contracts.
 *
 * Demo tooling, not runtime capability. This project lives outside `src/`,
 * `packages/` and `apps/`, is not a workspace and is not referenced by the root
 * build, so normal build, test, CI and application startup never load it. It
 * drives the capabilities proven in P0-08 (real XRPL Testnet transport), P0-09
 * (linked reconsideration) and P0-10 (durable authority-ceiling withholding)
 * through the normal Andrew composition and adds no governance semantics.
 *
 * The XRPL side is injected through the ports below: the harness core never
 * imports the transport package. `live-wiring.ts` binds the real Testnet
 * transport for `npm run demo:andrew`; tests bind a scripted ledger.
 */

/** What can go wrong, kept distinct so an expected block is never confused with a failure. */
export const DEMO_FAILURE_CATEGORIES = [
  'PRECONDITION FAILURE',
  'GOVERNANCE DENIAL',
  'XRPL SUBMISSION FAILURE',
  'XRPL VALIDATION FAILURE',
  'EVIDENCE VERIFICATION FAILURE',
  'UNEXPECTED DEMO ASSERTION FAILURE',
] as const;
export type DemoFailureCategory = (typeof DEMO_FAILURE_CATEGORIES)[number];

/** Expected outcomes that are part of the story — a PASS, never a failure. */
export type DemoExpectedOutcome = 'EXPECTED GOVERNANCE DENIAL' | 'EXPECTED AUTHORITY WITHHOLDING' | 'EXPECTED DUPLICATE REFUSAL';

export class DemoFailure extends Error {
  constructor(
    readonly category: DemoFailureCategory,
    message: string,
  ) {
    super(message);
    this.name = 'DemoFailure';
  }
}

/** Canonical decimal amount with its unit, exactly as a canonical record states it. */
export interface DemoAmount {
  readonly value: string;
  readonly unit: string;
}

/** The live demo configuration, from the secrets file and the environment. Secrets are held by reference only. */
export interface DemoConfiguration {
  readonly endpoint: string;
  readonly expectedNetworkId: number;
  readonly treasury: string;
  readonly recipient: string;
  /** The governed USD amount of the live transfer (default 10), also the Test RLUSD value moved on Testnet. */
  readonly amountUsd: string;
  /** Where runs live: `<root>/runs/<runId>/`. */
  readonly stateRoot: string;
  readonly secretsFile: string;
}

/** Counts measured at the boundary, never assumed. */
export interface DemoCounters {
  readonly grants: number;
  readonly connections: number;
  readonly signatures: number;
  readonly submissions: number;
  readonly attempts: number;
}

/** The XRPL attempt record, as the transport's durable store reports it (signed blob never included). */
export interface DemoAttemptRecord {
  readonly state: string;
  readonly attempt: { readonly transactionHash: string; readonly sourceAccount: string; readonly destination: string; readonly value: string; readonly currency: string; readonly issuer: string };
  readonly events: readonly { readonly state: string; readonly evidence?: Readonly<Record<string, string>> }[];
}

/** An independent ledger re-read of a transaction, by hash. */
export interface DemoLedgerLookup {
  readonly found: boolean;
  readonly validated?: boolean;
  readonly hash?: string;
  readonly ledgerIndex?: number;
  readonly engineResult?: string;
  readonly account?: string;
  readonly destination?: string;
  readonly delivered?: { readonly currency?: string; readonly issuer?: string; readonly value?: string };
}

/** The read-only XRPL preflight (P0-08 `runXrplPreflight` report shape). */
export interface DemoXrplPreflight {
  readonly connectedNetworkId: number | undefined;
  readonly networkOk: boolean;
  readonly validatedLedgerIndex: number | undefined;
  readonly treasury: { readonly address: string; readonly xrpDrops: string | undefined; readonly xrpReady: boolean; readonly trustLine: boolean; readonly tokenBalance: string | undefined; readonly tokenSufficient: boolean };
  readonly recipient: { readonly address: string; readonly xrpDrops: string | undefined; readonly xrpReady: boolean; readonly trustLine: boolean; readonly trustLimitSufficient: boolean };
  readonly blockers: readonly string[];
  readonly ready: boolean;
}

/**
 * The XRPL ports the harness is handed. `live-wiring.ts` binds the real
 * Testnet; tests bind a scripted ledger. Every count is measured by the port.
 */
export interface DemoLedgerPorts {
  /** Read-only: server_info, account_info, account_lines. Signs and submits nothing. */
  preflight(configuration: DemoConfiguration): Promise<DemoXrplPreflight>;
  /** Proves, without any network, that the configured signing material belongs to the treasury. Throws a fixed, non-secret phrase otherwise. */
  verifySignerAccount(configuration: DemoConfiguration, secrets: Readonly<Record<string, string>>): void;
  /**
   * Open the run's fresh attempt store and build the transport the Andrew
   * composition is given. Called once, after preflight is READY.
   */
  openTransport(configuration: DemoConfiguration, secrets: Readonly<Record<string, string>>, attemptStorePath: string, observe?: DemoTransportObserver): DemoTransportBinding;
  /** Independent re-read of a validated transaction (a fresh connection; not counted as transport activity). */
  lookupTransaction(configuration: DemoConfiguration, hash: string): Promise<DemoLedgerLookup>;
  /** Decimal equality of issued values, exactly (no floats). */
  issuedValuesEqual(left: unknown, right: string): boolean;
}

/**
 * A non-secret transport lifecycle event, as it happens at the boundary:
 * `signing` (the signer was called), `submitting` (the signed transaction is
 * being sent), and the P0-08 transport's own structured events
 * (`xrpl.attempt.persisted`, `xrpl.attempt.submitted`, `xrpl.attempt.validated`, …).
 * Never carries a seed, a signed blob or a prepared transaction.
 */
export interface DemoTransportEvent {
  readonly event: string;
  readonly executionId?: string;
  readonly transactionHash?: string;
  readonly detail?: string;
}

export type DemoTransportObserver = (event: DemoTransportEvent) => void;

export interface DemoTransportBinding {
  /** Handed to `composeAndrewDemo` as its `transport`. */
  readonly transport: unknown;
  /** Transport-side activity, measured: connections opened, signatures made, submissions sent. */
  activity(): { readonly connections: number; readonly signatures: number; readonly submissions: number };
  findAttempt(executionId: string): DemoAttemptRecord | undefined;
  attemptCount(): number;
  close(): void;
}

/**
 * Test seam: substitutes what the harness observes at a named point — a
 * governed reply (`A2`, `A3`, `A6`, `A9`, `A10`, `B`) or a trace (`A5:trace`) —
 * so a test can prove the harness rejects answers a correct Host never gives
 * (a re-evaluated replay, a lost linkage, a second realization, a wrong
 * reason). Never set by `npm run demo:andrew`.
 */
export type DemoInterceptor = (point: string, value: unknown) => unknown;

/** Test seam: notified after each checkpoint. A throw here is an interruption, reported as a failed run. */
export type DemoStepObserver = (step: string, context: DemoStepContext) => void | Promise<void>;

export interface DemoStepContext {
  readonly runDirectory: string;
  readonly hostDirectory: string;
  readonly requestId?: string;
  readonly evaluationId?: string;
}

/** The machine-readable, non-secret summary of one run. Built from canonical records only. */
export interface DemoSummary {
  readonly schema: 'frontera.andrew-demo.summary.v1';
  readonly runId: string;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly network: { readonly name: 'XRPL Testnet'; readonly networkId?: number; readonly endpoint: string; readonly validatedLedgerAtPreflight?: number };
  readonly amounts: {
    /** The governed (business) amount of the live transfer. */
    readonly governedAmount: DemoAmount;
    /** What moved on XRPL Testnet: Test RLUSD, which has no real-world value. */
    readonly testnetTransfer: { readonly value: string; readonly asset: 'Test RLUSD (XRPL Testnet)'; readonly currencyCode: string; readonly issuer: string };
    /** Andrew's production example: the motivating scenario. Nothing of this size moved anywhere. */
    readonly productionMotivatingExample: DemoAmount & { readonly note: string };
  };
  readonly accounts: { readonly treasury: string; readonly recipient: string };
  readonly verificationMaterial?: { readonly authorityKeyId: string; readonly authorityVerificationKeysFile: string; readonly witnessId: string; readonly witnessPublicKeyFile: string };
  readonly preflight?: { readonly verdict: 'READY' | 'NOT READY'; readonly reasons: readonly string[]; readonly treasuryTestRlusd?: string; readonly networkId?: number };
  readonly scenarioA?: Readonly<Record<string, unknown>>;
  readonly scenarioB?: Readonly<Record<string, unknown>>;
  readonly checkpoints: readonly { readonly step: string; readonly result: 'PASS' | DemoExpectedOutcome | 'FAIL'; readonly detail?: string }[];
  readonly failure?: { readonly category: DemoFailureCategory; readonly message: string; readonly step?: string };
  readonly finalVerdict: 'PASS' | 'FAIL' | 'NOT READY';
}
