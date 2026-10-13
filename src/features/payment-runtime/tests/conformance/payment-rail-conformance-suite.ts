/**
 * PAY-07 — the canonical Payment Rail Conformance Suite.
 *
 * > **One suite, one set of assertions, every qualified rail.**
 *
 * Modelled on `packages/provider-conformance-suite` (harness-driven,
 * implementation-neutral, adapter factories outside the suite, a closed result
 * vocabulary, a machine-readable qualification result), but it qualifies a
 * different thing: not an adapter's translation, the whole **governance-to-
 * payment lifecycle** a rail sits inside —
 *
 * ```
 * agent ─ protocol requirement (MPP) ─ PaymentIntent ─ governed-action envelope
 *   ─ authority / policy / ceiling ─ grant ─ rail ─ P11 ─ (P12) ─ PAY-05 settlement ─ receipt ─ ASSURE-01 trace
 * ```
 *
 * ## What the suite knows
 *
 * Only generic Frontera vocabulary: governed statuses, P11 / P12 certainties,
 * PAY-05 settlement states, ASSURE-01 trace presences and final states, exact
 * decimal money. It never learns which rail it is qualifying: the harness is
 * one shape for every rail (no discriminated union), `implementationId` is an
 * opaque label the suite only copies into its report, and nothing here
 * branches on it (`pay07-multi-rail-structure.test.ts` scans this file).
 *
 * ## Harness evidence, suite verdict
 *
 * A harness never says "passed". It composes the real stack around its rail
 * and returns **observations** — what the governed path answered, how many
 * external money-moving calls the rail's provider boundary received, what the
 * rail port was instructed, what P12, PAY-05 and ASSURE-01 said. The suite
 * decides every verdict from those facts.
 *
 * ## The report is qualification evidence, not payment evidence
 *
 * It carries case ids, verdicts, bounded generic reason tokens, external-effect
 * counts and the generic lifecycle signature of each case — never a provider
 * reference, an invoice, a preimage, a transaction, a key or a route — and no
 * clock, path or random value, so it is byte-identical across runs of the same
 * tree. A future change to the required cases changes
 * `PAYMENT_RAIL_CONFORMANCE_SUITE_VERSION` deliberately.
 */

export const PAYMENT_RAIL_CONFORMANCE_SUITE_VERSION = 'frontera.payment-rail-conformance.v1';

/** The closed, ordered set of required cases. Every qualified rail runs every one; none may be skipped. */
export const PAYMENT_RAIL_CONFORMANCE_CASES = [
  { caseId: 'MRC-01', title: 'governed success end to end: MPP → PaymentIntent → governance → grant → one rail effect → P11 → PAY-05 settlement → receipt' },
  { caseId: 'MRC-02', title: 'definitive non-completion: one effect, confirmed-not-completed, never settleable, no receipt' },
  { caseId: 'MRC-03', title: 'uncertain initial execution: unconfirmed, replay never resends, P12 unresolved while undetermined' },
  { caseId: 'MRC-04', title: 'uncertain → restart → explicit P12 confirmed-completed → settled from the resolution; zero additional effects' },
  { caseId: 'MRC-05', title: 'uncertain → explicit P12 confirmed-not-completed → not settleable; zero additional effects' },
  { caseId: 'MRC-06', title: 'completed is not settled: P11 completion awaits finality; finality is verified by the trusted authority, adds no effect' },
  { caseId: 'MRC-07', title: 'deterministic receipt: the generic verifier accepts it, it refers to the canonical settlement, re-reads are identical' },
  { caseId: 'MRC-08', title: 'denied before execution: no grant, no attempt, zero effects; the trace verifies the denial' },
  { caseId: 'MRC-09', title: 'over-ceiling before execution: the shared ceiling withholds, zero effects; the trace verifies' },
  { caseId: 'MRC-10', title: 'revoked mid-flight: grant revoked after the claim, before the exercise checkpoint; zero effects; the trace verifies' },
  { caseId: 'MRC-11', title: 'ASSURE-01 trace of the success: every stage on the path recorded, correlated and verified' },
  { caseId: 'MRC-12', title: 'business-operation replay: the same MPP operation replays the same governed request; zero additional effects' },
  { caseId: 'MRC-13', title: 'exact money and destination: the MPP amount reaches the Kernel, the rail port, P11, the trace and the settlement unchanged (no float); the destination reaches the rail port unchanged' },
  { caseId: 'MRC-14', title: 'deterministic correlation: one execution identity and one opaque provider reference across rail, P11, P12, PAY-05 and ASSURE-01' },
  { caseId: 'MRC-15', title: 'rollback safety: the rail’s durable state refuses a stale restore before any effect' },
  { caseId: 'MRC-16', title: 'shared CORE and generic vocabulary: a well-formed CORE manifest digest; every observed token is generic' },
] as const;

export type PaymentRailConformanceCaseId = (typeof PAYMENT_RAIL_CONFORMANCE_CASES)[number]['caseId'];

// ───────────────────────────── the harness contract ─────────────────────────────

/** An exact P9 amount: canonical decimal text and a recognized unit. Never a number. */
export interface ConformanceAmount {
  readonly value: string;
  readonly unit: string;
}

/** What the rail's provider does with the one instruction it receives. The harness makes it so, by rail-specific means. */
export type ConformanceRailBehaviour = 'complete' | 'fail' | 'uncertain';

/** One governance scenario. Every field is generic; a harness realizes it with the SAME shared governance for every rail. */
export interface ConformanceScenario {
  readonly behaviour: ConformanceRailBehaviour;
  /** `unrecognized` presents the requirement as a principal the shared Kernel does not recognize. */
  readonly principal: 'authorized' | 'unrecognized';
  /** Independently below, or above, the same logical configured ceiling — in the rail asset's own exact unit. No FX. */
  readonly amount: 'within-ceiling' | 'over-ceiling';
  /** Revoke the grant after the write-ahead claim and before the shared exercise checkpoint. */
  readonly revokeAfterClaim: boolean;
}

/** What the governed path answered, as plain generic data. */
export interface ConformanceGoverned {
  /** The protocol ingress's own outcome: the requirement was governed, or refused before governance. */
  readonly ingress: string;
  readonly status?: string;
  readonly requestId?: string;
  readonly executionId?: string;
  readonly reasonCodes: readonly string[];
  readonly withheldBy?: string;
  readonly failure?: string;
  readonly providerRef?: string;
  readonly replayed?: boolean;
}

/** What crossed the protocol and governance boundaries before any rail. */
export interface ConformanceIngress {
  /** The protocol the requirement arrived in (`mpp`). */
  readonly protocolId: string;
  /** The canonical PaymentIntent amount the protocol adapter produced. */
  readonly intentAmount: ConformanceAmount;
  /** The canonical PaymentIntent destination the trusted counterparty resolution produced. */
  readonly intentDestination?: ConformanceDestination;
  /** How many governed intents the ingress handed to the orchestrator. */
  readonly governedIntents: number;
  /** How many decisions the shared Kernel evaluated. */
  readonly kernelEvaluations: number;
  /** The amount the Kernel was asked to decide, when it was asked. */
  readonly kernelAmount?: ConformanceAmount;
  /** Bounded grants issued by the shared grant store. */
  readonly grantsIssued: number;
}

/** One instruction the rail PORT received (PAY-01's `PaymentExecutionRequest`, its generic fields). */
export interface ConformanceInstruction {
  readonly executionId: string;
  readonly requestId: string;
  readonly amount: ConformanceAmount;
  readonly sourceAccountId: string;
  readonly destination: ConformanceDestination;
  readonly purpose: string;
}

/** PAY-01's opaque destination: a kind in the host's vocabulary and a reference. Compared, never interpreted. */
export interface ConformanceDestination {
  readonly kind: string;
  readonly reference: string;
}

/** P11's durable initial observation. */
export interface ConformanceObservation {
  readonly kind?: string;
  readonly certainty?: string;
  readonly providerRef?: string;
  readonly adapterId?: string;
  readonly amount?: ConformanceAmount;
}

export interface ConformanceReconciliation {
  readonly outcome: string;
  readonly certainty?: string;
  readonly providerRef?: string;
  /** The resolution is bound to the P11 attempt digest and to the observation it resolved. */
  readonly boundToAttempt?: boolean;
  readonly boundToObservation?: boolean;
  /** Whether the P12 store holds a resolution after this call. */
  readonly recorded: boolean;
}

export interface ConformanceSettlement {
  readonly outcome: string;
  readonly state?: string;
  readonly basis?: string;
  readonly railId?: string;
  readonly providerRef?: string;
  readonly amount?: ConformanceAmount;
  readonly method?: string;
  readonly factNames?: readonly string[];
  /** `verifyPaymentReceipt(receipt, settlement)` — the ONE generic receipt verifier. */
  readonly receiptValid?: boolean;
  readonly receiptFormat?: string;
  /** The receipt names this settlement (identity and content digest). */
  readonly receiptRefersToSettlement?: boolean;
  /** A second read of the stored receipt is identical (digest). */
  readonly receiptStable?: boolean;
  /** The settlement service's stored receipt read, when there is none: `false`. */
  readonly receiptPresent?: boolean;
}

/** ASSURE-01's verdict over the canonical trace, through the existing builder and verifier. */
export interface ConformanceTrace {
  readonly found: boolean;
  readonly verified: boolean;
  readonly failedChecks: readonly string[];
  readonly requestId?: string;
  readonly executionId?: string;
  readonly path?: string;
  readonly finalState?: string;
  readonly presence: Readonly<Record<string, string>>;
  readonly outcomeKind?: string;
  readonly outcomeCertainty?: string;
  readonly providerRef?: string;
  readonly resolutionCertainty?: string;
  readonly grantRecorded: boolean;
  readonly grantRevoked: boolean;
  readonly claimRecorded: boolean;
  readonly parametersAmount?: ConformanceAmount;
}

export interface ConformanceRollback {
  readonly refused: boolean;
  /** A bounded refusal code, never a message. */
  readonly code?: string;
}

/**
 * One isolated, freshly composed world for one case: the real shared
 * governance, the real protocol ingress, P11, P12, PAY-05 and ASSURE-01 around
 * one rail. Rail-specific means live behind these generic capabilities.
 */
export interface ConformanceWorld {
  /** Presents the representative protocol requirement (MPP) through the protocol ingress. */
  presentRequirement(): Promise<ConformanceGoverned>;
  /** Presents exactly the same business operation again (same challenge). */
  replayRequirement(): Promise<ConformanceGoverned>;
  /** External money-moving calls the rail's provider boundary received so far. Reads, P12 and finality never count; they must never add any. */
  externalEffects(): number;
  /** Every instruction the rail PORT received, in order. */
  railInstructions(): readonly ConformanceInstruction[];
  ingress(): Promise<ConformanceIngress>;
  observation(executionId: string): Promise<ConformanceObservation | undefined>;
  /** The provider becomes definitive about an uncertain payment (rail-specific means). Moves nothing. */
  resolveExternally(outcome: 'completed' | 'not-completed'): Promise<void>;
  /** P12 through the rail's read-only resolution authority, composed by the shared world. */
  reconcile(executionId: string): Promise<ConformanceReconciliation>;
  /** PAY-05's derived state, without asking any authority. */
  readSettlement(executionId: string): Promise<ConformanceSettlement>;
  /** PAY-05's explicit verification through the rail's read-only finality authority. */
  verifySettlement(executionId: string): Promise<ConformanceSettlement>;
  /** PAY-05's stored receipt read. */
  receipt(executionId: string): Promise<ConformanceSettlement>;
  /** ASSURE-01: build and verify the request's trace. */
  trace(requestId: string): Promise<ConformanceTrace>;
  /** Recomposes every component over the durable state (a process restart). */
  restart(): Promise<void>;
  /** Restores an older copy of the rail's durable interlock and reopens it. */
  rollbackRefused(): Promise<ConformanceRollback>;
  close(): Promise<void>;
}

/** One shape for every rail. No discriminator: the suite cannot tell rails apart, by construction. */
export interface PaymentRailConformanceHarness {
  /** An opaque label, copied into the report. Never a branch condition. */
  readonly implementationId: string;
  /** The SHA-256 digest of the qualified CORE source manifest this run executed against. */
  readonly coreManifestDigest: string;
  /** The same logical bound, stated in the rail asset's own exact unit. */
  readonly economics: { readonly ceiling: ConformanceAmount; readonly withinCeiling: ConformanceAmount; readonly overCeiling: ConformanceAmount };
  open(scenario: ConformanceScenario): Promise<ConformanceWorld>;
}

// ───────────────────────────── the closed report ─────────────────────────────

export interface PaymentRailConformanceCaseResult {
  readonly caseId: PaymentRailConformanceCaseId;
  readonly passed: boolean;
  /** Where it failed, and why — bounded generic tokens. Absent on a pass. */
  readonly phase?: string;
  readonly reason?: string;
  /** External money-moving calls observed by the end of the case. */
  readonly externalEffects: number;
  /** The generic lifecycle signature: what happened, in generic vocabulary only. Compared across rails. */
  readonly lifecycle: Readonly<Record<string, string>>;
}

export interface PaymentRailConformanceReport {
  readonly suiteVersion: typeof PAYMENT_RAIL_CONFORMANCE_SUITE_VERSION;
  readonly implementationId: string;
  readonly coreManifestDigest: string;
  readonly passed: boolean;
  readonly cases: readonly PaymentRailConformanceCaseResult[];
}

// ───────────────────────────── generic expectations ─────────────────────────────

/**
 * The generic dispositions every rail must produce, because every rail shares
 * the same governance. Fixed once here, never per rail — and recorded as the
 * existing governance answers them (audited, not chosen by PAY-07): an
 * unrecognized principal is a Kernel denial; an amount over the P10 ceiling is
 * withheld at issuance as an `authority-binding` withholding carrying P10's
 * `FINANCIAL_AUTHORITY_CEILING_EXCEEDED` (no grant); a grant revoked after the
 * write-ahead claim is withheld by the exercise gate.
 */
export const CONFORMANCE_EXPECTATIONS = {
  denied: { status: 'denied' },
  overCeiling: { status: 'withheld', withheldBy: 'authority-binding', reasonCode: 'FINANCIAL_AUTHORITY_CEILING_EXCEEDED' },
  revoked: { status: 'withheld', withheldBy: 'exercise', reasonCode: 'GRANT_EXERCISE_REVOKED' },
} as const;

/** Every token the suite may observe. A token outside these sets means a rail's vocabulary leaked into a generic answer. */
const GENERIC_VOCABULARY = {
  ingress: new Set(['governed', 'refused']),
  status: new Set(['executed', 'denied', 'indeterminate', 'withheld', 'execution_failed', 'execution_unconfirmed', 'rejected', 'system_error']),
  certainty: new Set(['confirmed-completed', 'confirmed-not-completed', 'unconfirmed']),
  settlementOutcome: new Set(['settled', 'status', 'not-eligible', 'not-final', 'finality-contradicted', 'authority-unavailable', 'evidence-mismatch', 'basis-unavailable', 'settlement-unrecorded', 'conflict', 'not-found', 'not-a-payment']),
  settlementState: new Set(['execution-uncertain', 'awaiting-finality', 'settled', 'not-settleable']),
  basis: new Set(['provider-confirmed-completed', 'resolution-confirmed-completed']),
  reconciliation: new Set(['resolved', 'unresolved', 'existing', 'not-eligible', 'basis-unavailable']),
  finalState: new Set([
    'denied',
    'indeterminate',
    'approval-pending',
    'not-executed',
    'withheld-at-exercise',
    'executed-confirmed-completed',
    'executed-confirmed-not-completed',
    'executed-unconfirmed',
    'claimed-outcome-unrecorded',
    'resolved-confirmed-completed',
    'resolved-confirmed-not-completed',
    'unverifiable',
    'inconsistent',
  ]),
} as const;

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

// ───────────────────────────── exact decimal arithmetic ─────────────────────────────

const DECIMAL = /^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$/;

/** Compares two canonical non-negative decimal texts exactly (no float). `undefined` when either is not canonical. */
export function compareExactDecimal(a: string, b: string): -1 | 0 | 1 | undefined {
  if (!DECIMAL.test(a) || !DECIMAL.test(b)) return undefined;
  const [ai = '0', af = ''] = a.split('.');
  const [bi = '0', bf = ''] = b.split('.');
  const scale = Math.max(af.length, bf.length);
  const x = BigInt(ai + af.padEnd(scale, '0'));
  const y = BigInt(bi + bf.padEnd(scale, '0'));
  return x === y ? 0 : x < y ? -1 : 1;
}

const sameAmount = (a: ConformanceAmount | undefined, b: ConformanceAmount | undefined): boolean =>
  a !== undefined && b !== undefined && typeof a.value === 'string' && typeof b.value === 'string' && a.unit === b.unit && a.value === b.value && compareExactDecimal(a.value, b.value) === 0;

// ───────────────────────────── the runner ─────────────────────────────

class ConformanceFailure extends Error {
  constructor(
    readonly phase: string,
    readonly reason: string,
  ) {
    super(`${phase}:${reason}`);
  }
}

interface CaseContext {
  check(phase: string, condition: boolean, reason: string): void;
  effects(phase: string, world: ConformanceWorld, expected: number): void;
  note(key: string, value: string | number | boolean | undefined): void;
  readonly harness: PaymentRailConformanceHarness;
  /** Tokens observed during the case, checked against the generic vocabulary at the end. */
  observe(kind: keyof typeof GENERIC_VOCABULARY, token: string | undefined): void;
}

const SCENARIO = (overrides: Partial<ConformanceScenario> = {}): ConformanceScenario => ({ behaviour: 'complete', principal: 'authorized', amount: 'within-ceiling', revokeAfterClaim: false, ...overrides });

type CaseBody = (context: CaseContext) => Promise<ConformanceWorld | undefined>;

async function governedSuccess(context: CaseContext, world: ConformanceWorld): Promise<ConformanceGoverned> {
  const governed = await world.presentRequirement();
  context.observe('ingress', governed.ingress);
  context.observe('status', governed.status);
  context.check('ingress', governed.ingress === 'governed', 'requirement-not-governed');
  context.check('governance', governed.status === 'executed', `status-${governed.status ?? 'absent'}`);
  context.check('identity', typeof governed.requestId === 'string' && typeof governed.executionId === 'string', 'execution-identity-absent');
  return governed;
}

async function traceVerified(context: CaseContext, world: ConformanceWorld, phase: string, requestId: string | undefined, finalState: string): Promise<ConformanceTrace> {
  context.check(phase, requestId !== undefined, 'request-id-absent');
  const trace = await world.trace(requestId ?? '');
  context.observe('finalState', trace.finalState);
  context.check(phase, trace.found, 'trace-not-found');
  context.check(phase, trace.requestId === requestId, 'trace-request-mismatch');
  context.check(phase, trace.verified && trace.failedChecks.length === 0, `trace-not-verified:${trace.failedChecks[0] ?? 'unknown'}`);
  context.check(phase, trace.finalState === finalState, `trace-final-state-${trace.finalState ?? 'absent'}`);
  context.check(phase, trace.presence['request'] === 'recorded' && trace.presence['decision'] === 'recorded', 'trace-decision-absent');
  return trace;
}

const CASES: Readonly<Record<PaymentRailConformanceCaseId, CaseBody>> = {
  'MRC-01': async (c) => {
    const world = await c.harness.open(SCENARIO());
    const governed = await governedSuccess(c, world);
    const ingress = await world.ingress();
    c.check('ingress', ingress.protocolId === 'mpp', 'protocol-not-mpp');
    c.check('ingress', ingress.governedIntents === 1, 'governed-intents-not-one');
    c.check('authority', ingress.kernelEvaluations === 1, 'kernel-not-consulted-once');
    c.check('grant', ingress.grantsIssued === 1, 'grant-not-issued-once');
    c.effects('rail', world, 1);
    c.check('rail', world.railInstructions().length === 1, 'rail-port-not-instructed-once');
    const observation = await world.observation(governed.executionId ?? '');
    c.observe('certainty', observation?.certainty);
    c.check('p11', observation?.kind === 'provider' && observation.certainty === 'confirmed-completed', `p11-${observation?.certainty ?? 'absent'}`);
    c.check('p11', typeof observation?.providerRef === 'string' && observation.providerRef.length > 0, 'provider-ref-absent');
    const settled = await world.verifySettlement(governed.executionId ?? '');
    c.observe('settlementOutcome', settled.outcome);
    c.observe('basis', settled.basis);
    c.check('settlement', settled.outcome === 'settled', `settlement-${settled.outcome}`);
    c.check('settlement', settled.basis === 'provider-confirmed-completed', `basis-${settled.basis ?? 'absent'}`);
    c.check('receipt', settled.receiptValid === true, 'receipt-not-verified');
    c.effects('settlement', world, 1);
    await traceVerified(c, world, 'trace', governed.requestId, 'executed-confirmed-completed');
    c.effects('trace', world, 1);
    c.note('status', governed.status);
    c.note('p11', observation?.certainty);
    c.note('settlement', settled.outcome);
    c.note('basis', settled.basis);
    c.note('trace', 'executed-confirmed-completed');
    return world;
  },

  'MRC-02': async (c) => {
    const world = await c.harness.open(SCENARIO({ behaviour: 'fail' }));
    const governed = await world.presentRequirement();
    c.observe('status', governed.status);
    c.check('governance', governed.status === 'execution_failed', `status-${governed.status ?? 'absent'}`);
    c.effects('rail', world, 1);
    const observation = await world.observation(governed.executionId ?? '');
    c.observe('certainty', observation?.certainty);
    c.check('p11', observation?.certainty === 'confirmed-not-completed', `p11-${observation?.certainty ?? 'absent'}`);
    const settlement = await world.verifySettlement(governed.executionId ?? '');
    c.observe('settlementOutcome', settlement.outcome);
    c.observe('settlementState', settlement.state);
    c.check('settlement', settlement.outcome === 'not-eligible' && settlement.state === 'not-settleable', `settlement-${settlement.outcome}-${settlement.state ?? ''}`);
    const receipt = await world.receipt(governed.executionId ?? '');
    c.check('receipt', receipt.receiptPresent === false, 'receipt-for-non-completion');
    const replay = await world.replayRequirement();
    c.check('replay', replay.executionId === governed.executionId && replay.status === 'execution_failed', 'replay-diverged');
    c.effects('replay', world, 1);
    await traceVerified(c, world, 'trace', governed.requestId, 'executed-confirmed-not-completed');
    c.note('status', governed.status);
    c.note('p11', observation?.certainty);
    c.note('settlement', settlement.state);
    c.note('trace', 'executed-confirmed-not-completed');
    return world;
  },

  'MRC-03': async (c) => {
    const world = await c.harness.open(SCENARIO({ behaviour: 'uncertain' }));
    const governed = await world.presentRequirement();
    c.observe('status', governed.status);
    c.check('governance', governed.status === 'execution_unconfirmed', `status-${governed.status ?? 'absent'}`);
    c.effects('rail', world, 1);
    const observation = await world.observation(governed.executionId ?? '');
    c.observe('certainty', observation?.certainty);
    c.check('p11', observation?.certainty === 'unconfirmed', `p11-${observation?.certainty ?? 'absent'}`);
    for (let index = 0; index < 2; index += 1) {
      const replay = await world.replayRequirement();
      c.check('replay', replay.executionId === governed.executionId && replay.status === 'execution_unconfirmed', 'replay-diverged');
    }
    c.effects('replay', world, 1);
    const unresolved = await world.reconcile(governed.executionId ?? '');
    c.observe('reconciliation', unresolved.outcome);
    c.check('p12', unresolved.outcome === 'unresolved' && !unresolved.recorded, `p12-${unresolved.outcome}`);
    c.effects('p12', world, 1);
    const settlement = await world.verifySettlement(governed.executionId ?? '');
    c.observe('settlementState', settlement.state);
    c.check('settlement', settlement.outcome === 'not-eligible' && settlement.state === 'execution-uncertain', `settlement-${settlement.outcome}-${settlement.state ?? ''}`);
    c.effects('settlement', world, 1);
    await traceVerified(c, world, 'trace', governed.requestId, 'executed-unconfirmed');
    c.check('trace', (await world.trace(governed.requestId ?? '')).presence['resolution'] === 'unresolved', 'trace-resolution-not-unresolved');
    c.note('status', governed.status);
    c.note('p11', observation?.certainty);
    c.note('p12', unresolved.outcome);
    c.note('settlement', settlement.state);
    c.note('trace', 'executed-unconfirmed');
    return world;
  },

  'MRC-04': async (c) => {
    const world = await c.harness.open(SCENARIO({ behaviour: 'uncertain' }));
    const governed = await world.presentRequirement();
    c.check('governance', governed.status === 'execution_unconfirmed', `status-${governed.status ?? 'absent'}`);
    c.effects('rail', world, 1);
    await world.restart();
    const after = await world.observation(governed.executionId ?? '');
    c.check('restart', after?.certainty === 'unconfirmed', 'p11-lost-across-restart');
    await world.resolveExternally('completed');
    c.effects('provider', world, 1);
    const resolved = await world.reconcile(governed.executionId ?? '');
    c.observe('reconciliation', resolved.outcome);
    c.observe('certainty', resolved.certainty);
    c.check('p12', resolved.outcome === 'resolved' && resolved.certainty === 'confirmed-completed', `p12-${resolved.outcome}-${resolved.certainty ?? ''}`);
    c.check('p12', resolved.boundToAttempt === true && resolved.boundToObservation === true, 'p12-not-bound');
    c.check('p12', resolved.recorded, 'p12-not-recorded');
    c.effects('p12', world, 1);
    const again = await world.reconcile(governed.executionId ?? '');
    c.check('p12', again.outcome === 'existing' || (again.outcome === 'resolved' && again.certainty === 'confirmed-completed'), `p12-repeat-${again.outcome}`);
    c.effects('p12-repeat', world, 1);
    const settled = await world.verifySettlement(governed.executionId ?? '');
    c.observe('settlementOutcome', settled.outcome);
    c.observe('basis', settled.basis);
    c.check('settlement', settled.outcome === 'settled' && settled.basis === 'resolution-confirmed-completed', `settlement-${settled.outcome}-${settled.basis ?? ''}`);
    c.check('receipt', settled.receiptValid === true, 'receipt-not-verified');
    c.effects('settlement', world, 1);
    const trace = await traceVerified(c, world, 'trace', governed.requestId, 'resolved-confirmed-completed');
    c.check('trace', trace.presence['resolution'] === 'recorded' && trace.resolutionCertainty === 'confirmed-completed', 'trace-resolution-absent');
    c.check('trace', trace.outcomeCertainty === 'unconfirmed', 'trace-initial-observation-rewritten');
    c.effects('trace', world, 1);
    c.note('status', governed.status);
    c.note('restart', 'survived');
    c.note('p12', resolved.certainty);
    c.note('settlement', settled.outcome);
    c.note('basis', settled.basis);
    c.note('trace', 'resolved-confirmed-completed');
    return world;
  },

  'MRC-05': async (c) => {
    const world = await c.harness.open(SCENARIO({ behaviour: 'uncertain' }));
    const governed = await world.presentRequirement();
    c.check('governance', governed.status === 'execution_unconfirmed', `status-${governed.status ?? 'absent'}`);
    await world.resolveExternally('not-completed');
    const resolved = await world.reconcile(governed.executionId ?? '');
    c.observe('reconciliation', resolved.outcome);
    c.observe('certainty', resolved.certainty);
    c.check('p12', resolved.outcome === 'resolved' && resolved.certainty === 'confirmed-not-completed', `p12-${resolved.outcome}-${resolved.certainty ?? ''}`);
    c.check('p12', resolved.boundToAttempt === true && resolved.boundToObservation === true, 'p12-not-bound');
    c.effects('p12', world, 1);
    const settlement = await world.verifySettlement(governed.executionId ?? '');
    c.observe('settlementState', settlement.state);
    c.check('settlement', settlement.outcome === 'not-eligible' && settlement.state === 'not-settleable', `settlement-${settlement.outcome}-${settlement.state ?? ''}`);
    const receipt = await world.receipt(governed.executionId ?? '');
    c.check('receipt', receipt.receiptPresent === false, 'receipt-for-non-completion');
    const replay = await world.replayRequirement();
    c.check('replay', replay.executionId === governed.executionId, 'replay-diverged');
    c.effects('replay', world, 1);
    const trace = await traceVerified(c, world, 'trace', governed.requestId, 'resolved-confirmed-not-completed');
    c.check('trace', trace.resolutionCertainty === 'confirmed-not-completed', 'trace-resolution-absent');
    c.note('status', governed.status);
    c.note('p12', resolved.certainty);
    c.note('settlement', settlement.state);
    c.note('trace', 'resolved-confirmed-not-completed');
    return world;
  },

  'MRC-06': async (c) => {
    const world = await c.harness.open(SCENARIO());
    const governed = await governedSuccess(c, world);
    const before = await world.readSettlement(governed.executionId ?? '');
    c.observe('settlementState', before.state);
    c.check('completed-not-settled', before.state === 'awaiting-finality', `state-${before.state ?? 'absent'}`);
    const receiptBefore = await world.receipt(governed.executionId ?? '');
    c.check('completed-not-settled', receiptBefore.receiptPresent === false, 'receipt-before-finality');
    c.effects('read', world, 1);
    const settled = await world.verifySettlement(governed.executionId ?? '');
    c.check('finality', settled.outcome === 'settled', `settlement-${settled.outcome}`);
    const observation = await world.observation(governed.executionId ?? '');
    c.check('finality', settled.railId === observation?.adapterId, 'settlement-rail-not-the-recorded-adapter');
    c.check('finality', typeof settled.method === 'string' && TOKEN.test(settled.method), 'finality-method-not-bounded');
    const names = settled.factNames ?? [];
    const prefix = settled.method?.split('.')[0] ?? '';
    c.check('finality', names.length > 0 && names.every((name) => name.startsWith(`${prefix}.`)) && [...names].sort().join() === names.join(), 'finality-facts-not-namespaced-sorted');
    const after = await world.readSettlement(governed.executionId ?? '');
    c.check('finality', after.state === 'settled', `state-after-${after.state ?? 'absent'}`);
    c.effects('finality', world, 1);
    c.note('before', before.state);
    c.note('after', after.state);
    return world;
  },

  'MRC-07': async (c) => {
    const world = await c.harness.open(SCENARIO());
    const governed = await governedSuccess(c, world);
    const settled = await world.verifySettlement(governed.executionId ?? '');
    c.check('receipt', settled.outcome === 'settled', `settlement-${settled.outcome}`);
    c.check('receipt', settled.receiptValid === true, 'receipt-not-verified');
    c.check('receipt', settled.receiptFormat === 'frontera.payment-receipt.v1', `receipt-format-${settled.receiptFormat ?? 'absent'}`);
    c.check('receipt', settled.receiptRefersToSettlement === true, 'receipt-not-of-this-settlement');
    const stored = await world.receipt(governed.executionId ?? '');
    c.check('receipt', stored.receiptPresent === true && stored.receiptValid === true && stored.receiptStable === true, 'stored-receipt-not-stable');
    c.effects('receipt', world, 1);
    c.note('receipt', settled.receiptFormat);
    return world;
  },

  'MRC-08': async (c) => {
    const world = await c.harness.open(SCENARIO({ principal: 'unrecognized' }));
    const governed = await world.presentRequirement();
    c.observe('status', governed.status);
    c.check('governance', governed.status === CONFORMANCE_EXPECTATIONS.denied.status, `status-${governed.status ?? 'absent'}`);
    c.check('governance', governed.executionId === undefined, 'denied-has-execution');
    const ingress = await world.ingress();
    c.check('ingress', ingress.protocolId === 'mpp' && ingress.governedIntents === 1, 'denial-not-through-mpp');
    c.check('grant', ingress.grantsIssued === 0, 'grant-issued-on-denial');
    c.effects('rail', world, 0);
    c.check('rail', world.railInstructions().length === 0, 'rail-port-instructed');
    const trace = await traceVerified(c, world, 'trace', governed.requestId, 'denied');
    c.check('trace', trace.path === 'denied', `trace-path-${trace.path ?? 'absent'}`);
    c.check('trace', !trace.grantRecorded && trace.presence['execution'] === 'not-applicable' && trace.presence['outcome'] === 'not-applicable', 'trace-invented-a-stage');
    c.note('status', governed.status);
    c.note('trace', trace.finalState);
    c.note('authority', trace.presence['authority']);
    return world;
  },

  'MRC-09': async (c) => {
    const { ceiling, withinCeiling, overCeiling } = c.harness.economics;
    c.check('economics', ceiling.unit === withinCeiling.unit && ceiling.unit === overCeiling.unit, 'economics-mixed-units');
    c.check('economics', compareExactDecimal(withinCeiling.value, ceiling.value) === -1 || compareExactDecimal(withinCeiling.value, ceiling.value) === 0, 'within-not-within');
    c.check('economics', compareExactDecimal(overCeiling.value, ceiling.value) === 1, 'over-not-over');
    const world = await c.harness.open(SCENARIO({ amount: 'over-ceiling' }));
    const governed = await world.presentRequirement();
    c.observe('status', governed.status);
    c.check('governance', governed.status === CONFORMANCE_EXPECTATIONS.overCeiling.status, `status-${governed.status ?? 'absent'}`);
    c.check('governance', governed.withheldBy === CONFORMANCE_EXPECTATIONS.overCeiling.withheldBy, `withheld-by-${governed.withheldBy ?? 'absent'}`);
    c.check('governance', governed.reasonCodes.includes(CONFORMANCE_EXPECTATIONS.overCeiling.reasonCode), 'not-the-shared-ceiling');
    const ingress = await world.ingress();
    c.check('ingress', sameAmount(ingress.intentAmount, overCeiling), 'over-ceiling-amount-not-presented');
    c.check('grant', ingress.grantsIssued === 0, 'grant-issued-over-ceiling');
    c.effects('rail', world, 0);
    c.check('rail', world.railInstructions().length === 0, 'rail-port-instructed');
    const trace = await traceVerified(c, world, 'trace', governed.requestId, 'not-executed');
    c.check('trace', !trace.grantRecorded && trace.presence['outcome'] !== 'recorded', 'trace-invented-a-stage');
    c.note('status', governed.status);
    c.note('withheldBy', governed.withheldBy);
    c.note('reasons', [...governed.reasonCodes].sort().join(','));
    c.note('trace', trace.finalState);
    return world;
  },

  'MRC-10': async (c) => {
    const world = await c.harness.open(SCENARIO({ revokeAfterClaim: true }));
    const governed = await world.presentRequirement();
    c.observe('status', governed.status);
    c.check('governance', governed.status === CONFORMANCE_EXPECTATIONS.revoked.status, `status-${governed.status ?? 'absent'}`);
    c.check('governance', governed.withheldBy === CONFORMANCE_EXPECTATIONS.revoked.withheldBy, `withheld-by-${governed.withheldBy ?? 'absent'}`);
    c.check('governance', governed.reasonCodes.includes(CONFORMANCE_EXPECTATIONS.revoked.reasonCode), 'not-revocation');
    const ingress = await world.ingress();
    c.check('grant', ingress.grantsIssued === 1, 'grant-did-not-exist');
    c.effects('rail', world, 0);
    c.check('rail', world.railInstructions().length === 0, 'rail-port-instructed');
    const observation = await world.observation(governed.executionId ?? '');
    c.check('p11', observation?.kind === 'withheld' && observation.certainty === undefined, 'withholding-recorded-as-certainty');
    const trace = await traceVerified(c, world, 'trace', governed.requestId, 'withheld-at-exercise');
    c.check('trace', trace.grantRecorded && trace.grantRevoked && trace.claimRecorded, 'trace-revocation-or-claim-absent');
    c.check('trace', trace.outcomeKind === 'withheld', 'trace-outcome-not-withheld');
    const replay = await world.replayRequirement();
    c.check('replay', replay.status === governed.status && replay.executionId === governed.executionId, 'replay-diverged');
    c.effects('replay', world, 0);
    c.note('status', governed.status);
    c.note('withheldBy', governed.withheldBy);
    c.note('trace', trace.finalState);
    return world;
  },

  'MRC-11': async (c) => {
    const world = await c.harness.open(SCENARIO());
    const governed = await governedSuccess(c, world);
    const trace = await traceVerified(c, world, 'trace', governed.requestId, 'executed-confirmed-completed');
    c.check('trace', trace.executionId === governed.executionId, 'trace-execution-mismatch');
    c.check('trace', trace.path === 'allowed', `trace-path-${trace.path ?? 'absent'}`);
    for (const stage of ['authority', 'execution', 'parameters', 'reservation', 'outcome', 'events']) c.check('trace', trace.presence[stage] === 'recorded', `trace-${stage}-${trace.presence[stage] ?? 'absent'}`);
    c.check('trace', trace.presence['resolution'] === 'not-applicable', 'trace-resolution-inferred');
    c.check('trace', trace.grantRecorded && !trace.grantRevoked && trace.claimRecorded, 'trace-grant-or-claim-absent');
    c.check('trace', trace.outcomeKind === 'provider' && trace.outcomeCertainty === 'confirmed-completed', 'trace-outcome');
    c.effects('trace', world, 1);
    c.note('trace', trace.finalState);
    c.note('stages', Object.entries(trace.presence).map(([stage, presence]) => `${stage}=${presence}`).sort().join(','));
    return world;
  },

  'MRC-12': async (c) => {
    const world = await c.harness.open(SCENARIO());
    const first = await governedSuccess(c, world);
    const before = await world.ingress();
    const replay = await world.replayRequirement();
    c.check('replay', replay.ingress === 'governed', 'replay-refused');
    c.check('replay', replay.requestId === first.requestId && replay.executionId === first.executionId, 'replay-new-identity');
    c.check('replay', replay.status === 'executed' && replay.replayed === true, 'replay-re-executed');
    const after = await world.ingress();
    c.check('replay', after.kernelEvaluations === before.kernelEvaluations && after.grantsIssued === before.grantsIssued, 'replay-re-decided');
    c.effects('replay', world, 1);
    c.check('replay', world.railInstructions().length === 1, 'rail-port-instructed-twice');
    c.note('replayed', replay.replayed);
    return world;
  },

  'MRC-13': async (c) => {
    const world = await c.harness.open(SCENARIO());
    const governed = await governedSuccess(c, world);
    const ingress = await world.ingress();
    const expected = c.harness.economics.withinCeiling;
    c.check('protocol', sameAmount(ingress.intentAmount, expected), 'intent-amount-mutated');
    c.check('authority', sameAmount(ingress.kernelAmount, expected), 'kernel-amount-mutated');
    const [instruction] = world.railInstructions();
    c.check('rail', sameAmount(instruction?.amount, expected), 'rail-amount-mutated');
    c.check('rail', typeof instruction?.amount.value === 'string', 'rail-amount-not-text');
    c.check('rail', ingress.intentDestination !== undefined && instruction?.destination.kind === ingress.intentDestination.kind && instruction.destination.reference === ingress.intentDestination.reference, 'rail-destination-mutated');
    const observation = await world.observation(governed.executionId ?? '');
    c.check('p11', sameAmount(observation?.amount, expected), 'p11-amount-mutated');
    const trace = await world.trace(governed.requestId ?? '');
    c.check('trace', sameAmount(trace.parametersAmount, expected), 'trace-amount-mutated');
    const settled = await world.verifySettlement(governed.executionId ?? '');
    c.check('settlement', sameAmount(settled.amount, expected), 'settlement-amount-mutated');
    c.effects('money', world, 1);
    c.note('preserved', 'protocol,kernel,rail,p11,trace,settlement');
    c.note('destination', 'unchanged');
    return world;
  },

  'MRC-14': async (c) => {
    const world = await c.harness.open(SCENARIO({ behaviour: 'uncertain' }));
    const governed = await world.presentRequirement();
    const [instruction] = world.railInstructions();
    c.check('rail', instruction !== undefined && instruction.executionId === governed.executionId && instruction.requestId === governed.requestId, 'rail-instruction-not-correlated');
    const observation = await world.observation(governed.executionId ?? '');
    const ref = observation?.providerRef;
    c.check('p11', typeof ref === 'string' && ref.length > 0, 'provider-ref-absent');
    await world.resolveExternally('completed');
    const resolved = await world.reconcile(governed.executionId ?? '');
    c.check('p12', resolved.providerRef === ref, 'p12-provider-ref-mismatch');
    const settled = await world.verifySettlement(governed.executionId ?? '');
    c.check('settlement', settled.providerRef === ref, 'settlement-provider-ref-mismatch');
    const trace = await world.trace(governed.requestId ?? '');
    c.check('trace', trace.executionId === governed.executionId && trace.providerRef === ref, 'trace-provider-ref-mismatch');
    c.effects('correlation', world, 1);
    c.note('correlated', 'rail,p11,p12,settlement,trace');
    return world;
  },

  'MRC-15': async (c) => {
    const world = await c.harness.open(SCENARIO());
    await governedSuccess(c, world);
    const rollback = await world.rollbackRefused();
    c.check('rollback', rollback.refused, 'stale-state-accepted');
    c.check('rollback', rollback.code !== undefined && TOKEN.test(rollback.code), 'refusal-code-not-bounded');
    c.effects('rollback', world, 1);
    c.note('refusal', rollback.code);
    return world;
  },

  'MRC-16': async (c) => {
    c.check('core', DIGEST.test(c.harness.coreManifestDigest), 'core-manifest-digest-malformed');
    c.check('harness', TOKEN.test(c.harness.implementationId), 'implementation-id-not-a-token');
    c.note('core', 'sha256');
    return undefined;
  },
};

async function runCase(harness: PaymentRailConformanceHarness, caseId: PaymentRailConformanceCaseId): Promise<PaymentRailConformanceCaseResult> {
  const lifecycle: Record<string, string> = {};
  const observed: [keyof typeof GENERIC_VOCABULARY, string][] = [];
  let world: ConformanceWorld | undefined;
  let lastEffects = 0;
  const context: CaseContext = {
    harness,
    check(phase, condition, reason) {
      if (!condition) throw new ConformanceFailure(phase, reason);
    },
    effects(phase, current, expected) {
      lastEffects = current.externalEffects();
      if (lastEffects !== expected) throw new ConformanceFailure(phase, `external-effects-${lastEffects}-expected-${expected}`);
    },
    note(key, value) {
      if (value !== undefined) lifecycle[key] = String(value);
    },
    observe(kind, token) {
      if (token !== undefined) observed.push([kind, token]);
    },
  };
  const opened: ConformanceWorld[] = [];
  const tracking: PaymentRailConformanceHarness = {
    implementationId: harness.implementationId,
    coreManifestDigest: harness.coreManifestDigest,
    economics: harness.economics,
    open: async (scenario) => {
      const next = await harness.open(scenario);
      opened.push(next);
      world = next;
      return next;
    },
  };
  try {
    await CASES[caseId]({ ...context, harness: tracking });
    for (const [kind, token] of observed) {
      if (!GENERIC_VOCABULARY[kind].has(token)) throw new ConformanceFailure('vocabulary', `non-generic-${kind}`);
    }
    return Object.freeze({ caseId, passed: true, externalEffects: world?.externalEffects() ?? 0, lifecycle: Object.freeze({ ...lifecycle }) });
  } catch (error) {
    const failure = error instanceof ConformanceFailure ? error : new ConformanceFailure('harness', 'harness-error');
    return Object.freeze({ caseId, passed: false, phase: failure.phase, reason: failure.reason, externalEffects: world?.externalEffects() ?? lastEffects, lifecycle: Object.freeze({ ...lifecycle }) });
  } finally {
    for (const entry of opened) await entry.close().catch(() => undefined);
  }
}

/**
 * Runs every required case, in order, against one harness — the same code for
 * every rail — and returns the closed, deterministic report.
 */
export async function runPaymentRailConformanceSuite(harness: PaymentRailConformanceHarness): Promise<PaymentRailConformanceReport> {
  const cases: PaymentRailConformanceCaseResult[] = [];
  for (const { caseId } of PAYMENT_RAIL_CONFORMANCE_CASES) cases.push(await runCase(harness, caseId));
  return Object.freeze({
    suiteVersion: PAYMENT_RAIL_CONFORMANCE_SUITE_VERSION,
    implementationId: harness.implementationId,
    coreManifestDigest: harness.coreManifestDigest,
    passed: cases.every((entry) => entry.passed),
    cases: Object.freeze(cases),
  });
}

export interface PaymentRailConformanceComparison {
  readonly equivalent: boolean;
  /** Bounded generic differences: `<caseId>:<field>` or a report-level token. */
  readonly differences: readonly string[];
}

/**
 * Compares two qualification reports. Parity holds only when both passed the
 * same suite version over the same CORE manifest digest, ran exactly the same
 * case ids in the same order, and every case produced the same verdict, the
 * same external-effect count and the same generic lifecycle signature.
 * Implementation ids are the only permitted difference — rail-specific
 * evidence never enters a report, so there is nothing else to excuse.
 */
export function comparePaymentRailConformanceReports(a: PaymentRailConformanceReport, b: PaymentRailConformanceReport): PaymentRailConformanceComparison {
  const differences: string[] = [];
  if (a.suiteVersion !== b.suiteVersion) differences.push('suite-version');
  if (a.coreManifestDigest !== b.coreManifestDigest) differences.push('core-manifest-digest');
  if (!a.passed) differences.push('first-not-passed');
  if (!b.passed) differences.push('second-not-passed');
  const ids = (report: PaymentRailConformanceReport): string => report.cases.map((entry) => entry.caseId).join(',');
  if (ids(a) !== ids(b) || ids(a) !== PAYMENT_RAIL_CONFORMANCE_CASES.map((entry) => entry.caseId).join(',')) differences.push('case-set');
  for (const left of a.cases) {
    const right = b.cases.find((entry) => entry.caseId === left.caseId);
    if (right === undefined) continue;
    if (left.passed !== right.passed) differences.push(`${left.caseId}:passed`);
    if (left.externalEffects !== right.externalEffects) differences.push(`${left.caseId}:external-effects`);
    const keys = [...new Set([...Object.keys(left.lifecycle), ...Object.keys(right.lifecycle)])].sort();
    for (const key of keys) if (left.lifecycle[key] !== right.lifecycle[key]) differences.push(`${left.caseId}:lifecycle.${key}`);
  }
  return Object.freeze({ equivalent: differences.length === 0, differences: Object.freeze(differences) });
}

/** The report as canonical JSON text: sorted keys, no whitespace. Byte-identical for identical reports. */
export function canonicalConformanceReportText(report: PaymentRailConformanceReport): string {
  const canonical = (value: unknown): string => {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(',')}]`;
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`;
  };
  return canonical(report);
}
