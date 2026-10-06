/**
 * ANDREW-DEMO-UI-01 — the only shape the browser ever receives.
 *
 * Every field is a non-secret, display-safe fact copied from a canonical
 * record (a governed-action reply, an ASSURE-01 trace, the grant store, the
 * attempt store, the ledger) or a measured counter. There is no seed, key,
 * credential, signed blob, environment variable or filesystem path in this
 * contract, and the server additionally refuses to send any serialization that
 * the secret guard rejects.
 *
 * `allowed` is computed by the backend's state machine and is the same table
 * the backend enforces; the browser only uses it to enable buttons.
 */

export type DemoMode = 'rehearsal' | 'live';

export type ScenarioAPhase =
  | 'not-started'
  | 'denied'
  | 'replayed'
  | 'approved'
  | 'reconsidering'
  | 'authorized'
  | 'executing'
  | 'confirmed'
  | 'evidence-verified'
  | 'refused-second'
  | 'complete'
  | 'failed';

export type ActionName =
  | 'preflight'
  | 'session'
  | 'request'
  | 'replay'
  | 'approve'
  | 'reconsider'
  | 'execute'
  | 'abandon'
  | 'verifyEvidence'
  | 'reconsiderAgain'
  | 'historical'
  | 'scenarioB';

export interface CountersDto {
  readonly grants: number;
  readonly connections: number;
  readonly signatures: number;
  readonly submissions: number;
  readonly attempts: number;
}

export interface DecisionDto {
  readonly decisionId: string;
  readonly status: string;
  readonly reasonCodes: readonly string[];
}

export interface PreflightDto {
  readonly status: 'not-run' | 'READY' | 'NOT READY';
  readonly checkedAt?: string;
  readonly reasons: readonly string[];
  readonly networkName: string;
  readonly connectedNetworkId?: number;
  readonly expectedNetworkId: number;
  readonly validatedLedger?: number;
  readonly treasury?: string;
  readonly recipient?: string;
  readonly issuer: string;
  readonly treasuryTrustLine?: boolean;
  readonly recipientTrustLine?: boolean;
  readonly treasuryTestRlusd?: string;
  readonly requiredAmount?: string;
  readonly attemptState: 'clean' | 'blocked' | 'unknown';
  readonly secrets: string;
}

export interface LifecycleEntryDto {
  readonly state: 'AUTHORIZED' | 'RELEASED' | 'SIGNING' | 'SUBMITTING' | 'VALIDATING' | 'VALIDATED' | 'CONFIRMED' | 'REFUSED' | 'REVIEW REQUIRED' | 'NOT SUBMITTED';
  readonly at: string;
  readonly detail?: string;
}

export interface ScenarioADto {
  readonly phase: ScenarioAPhase;
  readonly agent: { readonly label: string; readonly principal: string };
  readonly amountUsd?: string;
  readonly destinationKey?: string;
  readonly recipient?: string;
  readonly request?: {
    readonly requestId: string;
    readonly decision: DecisionDto;
    readonly initialApprovalState: string;
    readonly identityActor: string;
    readonly authorityPresence: string;
    readonly traceVerified: boolean;
    readonly counters: CountersDto;
  };
  readonly replay?: { readonly requestId: string; readonly decisionId: string; readonly sameDecision: boolean; readonly counters: CountersDto };
  readonly approval?: { readonly state: string; readonly approvedBy: string; readonly role: string; readonly authorityBasis: string; readonly approvedAt: string; readonly counters: CountersDto };
  readonly authorization?: {
    readonly originalRequestId: string;
    readonly reconsiderationRequestId: string;
    readonly decisionId: string;
    readonly decisionStatus?: string;
    readonly reasonCodes?: readonly string[];
    readonly businessIntentId?: string;
    readonly reason?: string;
    readonly identityActor?: string;
    readonly grantId: string;
    readonly grantCeiling?: { readonly limit: string; readonly unit: string };
    readonly executionId: string;
    readonly grantNotAfter: string;
    readonly releaseDeadline: string;
    readonly heldAt: string;
    readonly payment: { readonly destination: string; readonly value?: string; readonly currencyLabel: string };
    readonly counters: CountersDto;
  };
  readonly lifecycle: readonly LifecycleEntryDto[];
  readonly execution?: {
    readonly transactionHash: string;
    readonly ledgerIndex?: number;
    readonly engineResult?: string;
    readonly deliveredValue?: string;
    readonly deliveredAsset: string;
    readonly sourceAccount?: string;
    readonly destinationAccount?: string;
    readonly attemptState: string;
    readonly counters: CountersDto;
    readonly scripted: boolean;
  };
  readonly evidence?: { readonly finalState: string; readonly verified: boolean; readonly checks: number; readonly results: readonly { readonly check: string; readonly status: string }[] };
  readonly second?: { readonly requestId: string; readonly status: string; readonly reasonCodes: readonly string[]; readonly newGrants: number; readonly newSignatures: number; readonly newSubmissions: number };
  readonly historical?: { readonly status: string; readonly decisionId: string; readonly unchanged: boolean; readonly traceVerified: boolean };
}

export interface ScenarioBDto {
  readonly status: 'locked' | 'ready' | 'running' | 'blocked' | 'failed';
  readonly requestedUsd: string;
  readonly ceilingUsd: string;
  readonly destinationApproved: boolean;
  readonly result?: {
    readonly requestId: string;
    readonly decisionId: string;
    readonly decisionStatus: string;
    readonly reasonCode: string;
    readonly withheldBy: string;
    readonly issuanceOutcome: string;
    readonly requested?: { readonly value: string; readonly unit: string };
    readonly ceiling?: { readonly value: string; readonly unit: string };
    readonly issuanceRecordId?: string;
    readonly grants: number;
    readonly connections: number;
    readonly signatures: number;
    readonly submissions: number;
    readonly attemptRows: number;
    readonly transaction: string | null;
    readonly assureFinalState: string;
    readonly assureVerified: boolean;
  };
}

/**
 * The Andrew/LUMX business story beside what this run governs and settles.
 * Governed and settled amounts are always equal (1:1, USD → Test RLUSD); in
 * REHEARSAL they are the business amount itself, in LIVE they may be a scaled
 * Testnet amount (`scaled: true`), which the screen must say plainly.
 */
export interface StoryDto {
  /** "75000": the agent asks to send USD 75,000 to a never-approved wallet. */
  readonly businessAmountUsd: string;
  /** What Frontera governs in this run (the request the agent actually sends). Absent until known. */
  readonly governedAmountUsd?: string;
  /** What settles on the ledger in this run, in `settlementAsset`. Equal to the governed amount. */
  readonly settlementAmount?: string;
  readonly settlementAsset: string;
  readonly settlementNetwork: string;
  /** The run governs a smaller amount than the business scenario (LIVE Testnet funding). */
  readonly scaled: boolean;
  readonly ceilingUsd: string;
  /** The authority-ceiling test request. */
  readonly secondTestUsd: string;
}

export interface DemoStateDto {
  readonly schema: 'frontera.andrew-demo-ui.state.v1';
  readonly mode: DemoMode;
  /** "REHEARSAL — NO XRPL TRANSACTION" or "LIVE • XRPL TESTNET". */
  readonly modeLabel: string;
  readonly network: { readonly name: string; readonly description: string };
  readonly story: StoryDto;
  readonly preflight: PreflightDto;
  readonly review: { readonly required: boolean; readonly reasons: readonly string[] };
  readonly session?: { readonly runId: string; readonly startedAt: string; readonly status: 'active' | 'complete' | 'failed' | 'interrupted' | 'abandoned' };
  /** The accounts the run on screen used (public addresses). Absent before any run. */
  readonly runAccounts?: { readonly treasury: string; readonly recipient: string };
  readonly busy?: { readonly action: ActionName; readonly since: string };
  readonly scenarioA: ScenarioADto;
  readonly scenarioB: ScenarioBDto;
  readonly verdict: {
    readonly status: 'NOT STARTED' | 'IN PROGRESS' | 'PASS' | 'FAIL';
    readonly failure?: { readonly category: string; readonly message: string; readonly step?: string };
    readonly summaryAvailable: boolean;
    readonly reportAvailable: boolean;
    readonly finishedAt?: string;
  };
  readonly checkpoints: readonly { readonly step: string; readonly result: string; readonly detail?: string }[];
  readonly transcript: readonly string[];
  readonly allowed: Readonly<Record<ActionName, boolean>>;
  readonly notice?: string;
}
