import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_MINIMUM_GRANT_REMAINING_MS } from '@aoc-enterprise/xrpl-testnet-transport';

import { ANDREW_PER_TRANSFER_CEILING_USD, RLUSD_XRPL_TESTNET_ISSUER } from '../../../dist/src/enterprise/andrew-demo/index.js';
import { defaultStateRoot, loadDemoConfiguration, type ConfigurationResult } from '../../andrew-demo-harness/dist/configuration.js';
import { DemoFailure, type DemoConfiguration, type DemoCounters, type DemoLedgerPorts, type DemoSummary, type DemoTransportEvent } from '../../andrew-demo-harness/dist/contracts.js';
import { DemoRunResources, buildDemoSummary, describeDemoFailure, openDemoRun, writeDemoEvidence } from '../../andrew-demo-harness/dist/demo.js';
import { runDemoPreflight, unresolvedAttemptReasons, type PreflightOutcome } from '../../andrew-demo-harness/dist/preflight.js';
import { createPresenter, type Presenter } from '../../andrew-demo-harness/dist/presentation.js';
import { DEMO_AGENT_PRINCIPAL, newRunId } from '../../andrew-demo-harness/dist/run-infrastructure.js';
import {
  EvidenceClient,
  PRODUCTION_MOTIVATING_EXAMPLE_USD,
  SCENARIO_B_REQUEST_USD,
  createScenarioA,
  measureCounters,
  readGrants,
  runScenarioB,
  type ScenarioAReconsiderationResult,
  type ScenarioASteps,
  type ScenarioContext,
} from '../../andrew-demo-harness/dist/scenarios.js';
import { createSecretGuard, type SecretGuard } from '../../andrew-demo-harness/dist/secret-guard.js';
import type { ActionName, CountersDto, DemoMode, DemoStateDto, LifecycleEntryDto, PreflightDto, ScenarioADto, ScenarioAPhase, ScenarioBDto, StoryDto } from './dto.js';
import { createExecutionGate, type ExecutionGate, type HeldSubmission } from './execution-gate.js';
import { REHEARSAL_TREASURY_RLUSD, createRehearsalWorld, type RehearsalScript, type RehearsalWorld } from './rehearsal-ledger.js';

/**
 * ANDREW-DEMO-UI-01 — the visual demo's backend controller.
 *
 * It owns one demo session at a time and the server-side state machine. Every
 * governed step is the P0-11 harness step (`createScenarioA`, `runScenarioB`)
 * over the normal Andrew composition; the controller decides nothing about
 * governance. It only:
 *
 * - enforces the legal order of operator actions (`allowedActions`), the same
 *   table it publishes to the browser;
 * - holds an authorized execution at the transport boundary until the
 *   operator releases it (`execution-gate.ts`);
 * - turns canonical results into display-safe DTOs (`dto.ts`);
 * - persists a non-secret session snapshot in the run directory so a browser
 *   refresh — or a backend restart — recovers what happened, and fails closed
 *   when an XRPL attempt is left unresolved.
 *
 * PASS is computed here and only here, from the harness's own checks, after
 * the summary is written: no request body can influence it.
 */

export class ActionRefused extends Error {
  constructor(
    readonly action: ActionName,
    message: string,
  ) {
    super(message);
    this.name = 'ActionRefused';
  }
}

export interface DemoControllerOptions {
  readonly mode: DemoMode;
  /** Non-secret overrides only: FRONTERA_ANDREW_SECRETS_FILE, FRONTERA_ANDREW_STATE_ROOT, FRONTERA_XRPL_TESTNET_ENDPOINT, FRONTERA_ANDREW_LIVE_AMOUNT_USD. */
  readonly environment: Readonly<Record<string, string | undefined>>;
  /** LIVE: the XRPL Testnet ports (`createLedgerPorts()`); tests inject a scripted ledger. Ignored in REHEARSAL. */
  readonly ports?: DemoLedgerPorts;
  /** REHEARSAL: scripted-ledger overrides (tests). */
  readonly rehearsal?: Partial<RehearsalScript>;
  readonly now?: () => Date;
}

const UI_STATE_FILE = 'ui-state.json';
const IN_FLIGHT: readonly ScenarioAPhase[] = ['reconsidering', 'authorized', 'executing'];
const ZERO: CountersDto = { grants: 0, connections: 0, signatures: 0, submissions: 0, attempts: 0 };

interface ScenarioAView {
  phase: ScenarioAPhase;
  amountUsd?: string;
  destinationKey?: string;
  request?: ScenarioADto['request'];
  replay?: ScenarioADto['replay'];
  approval?: ScenarioADto['approval'];
  authorization?: ScenarioADto['authorization'];
  lifecycle: LifecycleEntryDto[];
  execution?: ScenarioADto['execution'];
  evidence?: ScenarioADto['evidence'];
  second?: ScenarioADto['second'];
  historical?: ScenarioADto['historical'];
}

interface Session {
  readonly runId: string;
  readonly startedAt: string;
  readonly configuration: DemoConfiguration;
  readonly preflight: PreflightOutcome;
  readonly checkpoints: DemoSummary['checkpoints'][number][];
  readonly run: DemoRunResources;
  readonly gate: ExecutionGate;
  context?: ScenarioContext;
  steps?: ScenarioASteps;
  status: 'active' | 'complete' | 'failed' | 'interrupted' | 'abandoned';
  a: ScenarioAView;
  b: { status: ScenarioBDto['status']; result?: ScenarioBDto['result']; record?: Readonly<Record<string, unknown>> };
  aRecord?: Readonly<Record<string, unknown>>;
  pendingReconsideration?: Promise<ScenarioAReconsiderationResult>;
  scenarioBWindow: boolean;
  transportEventsDuringB: number;
  failure?: NonNullable<DemoSummary['failure']>;
  finalized: boolean;
  verdict?: 'PASS' | 'FAIL';
  finishedAt?: string;
  summaryPath?: string;
  reportPath?: string;
}

/** A session recovered from disk after a backend restart: display only. */
interface RecoveredSession {
  readonly runId: string;
  /** From the run's own manifest (`run.json`). */
  readonly recipient?: string;
  readonly treasury?: string;
  readonly startedAt: string;
  readonly status: 'interrupted' | 'complete' | 'failed' | 'abandoned';
  readonly a: ScenarioAView;
  readonly b: Session['b'];
  readonly checkpoints: DemoSummary['checkpoints'][number][];
  readonly verdict?: 'PASS' | 'FAIL';
  readonly failure?: NonNullable<DemoSummary['failure']>;
  readonly summaryPath?: string;
  readonly reportPath?: string;
  readonly finishedAt?: string;
}

const str = (value: unknown): string => (value === undefined || value === null ? '' : String(value));
const counters = (value: DemoCounters | undefined): CountersDto => (value === undefined ? ZERO : { grants: value.grants, connections: value.connections, signatures: value.signatures, submissions: value.submissions, attempts: value.attempts });

export class DemoController {
  readonly mode: DemoMode;
  private readonly environment: Readonly<Record<string, string | undefined>>;
  private readonly guard: SecretGuard = createSecretGuard();
  private readonly transcript: string[] = [];
  private readonly present: Presenter;
  private readonly now: () => Date;
  private readonly world: RehearsalWorld | undefined;
  private readonly ports: DemoLedgerPorts;
  private readonly stateRoot: string;
  private preflightDto: PreflightDto;
  private reviewReasons: readonly string[] = [];
  private session: Session | undefined;
  private recovered: RecoveredSession | undefined;
  private busy: { action: ActionName; since: string } | undefined;
  private guardTripped = false;
  private notice: string | undefined;

  constructor(options: DemoControllerOptions) {
    this.mode = options.mode;
    this.environment = options.environment;
    this.now = options.now ?? (() => new Date());
    this.present = createPresenter((line) => {
      this.transcript.push(this.redact(line));
      if (this.transcript.length > 400) this.transcript.splice(0, this.transcript.length - 400);
    }, this.guard);
    const liveRoot = options.environment['FRONTERA_ANDREW_STATE_ROOT'] ?? defaultStateRoot();
    if (options.mode === 'rehearsal') {
      // The rehearsal never shares the live run area, and never reads the secrets file.
      this.stateRoot = join(liveRoot, 'rehearsal');
      this.world = createRehearsalWorld(this.stateRoot, { treasuryRlusd: REHEARSAL_TREASURY_RLUSD, ...options.rehearsal });
      for (const value of Object.values(this.world.secrets)) if (/^s/.test(value)) this.guard.register(value);
      this.ports = this.world.ports;
    } else {
      if (options.ports === undefined) throw new Error('LIVE mode needs the XRPL Testnet ports.');
      this.stateRoot = liveRoot;
      this.ports = options.ports;
    }
    this.preflightDto = this.emptyPreflight();
    this.recoverFromDisk();
    this.reviewReasons = this.computeReview(undefined);
  }

  // ── Read side ────────────────────────────────────────────────────────────

  /** The whole display state. Safe by construction; the server still passes it through the secret guard. */
  state(): DemoStateDto {
    const session = this.session;
    const shown: Session | RecoveredSession | undefined = session ?? this.recovered;
    const a = shown?.a ?? { phase: 'not-started' as const, lifecycle: [] };
    const b = shown?.b ?? { status: 'locked' as const };
    const approved = a.approval?.state === 'approved';
    const verdictStatus: DemoStateDto['verdict']['status'] = shown === undefined ? 'NOT STARTED' : shown.verdict ?? (shown.status === 'active' ? 'IN PROGRESS' : 'FAIL');
    const failure = shown?.failure;
    return {
      schema: 'frontera.andrew-demo-ui.state.v1',
      mode: this.mode,
      modeLabel: this.mode === 'live' ? 'LIVE • XRPL TESTNET' : 'REHEARSAL — NO XRPL TRANSACTION',
      network:
        this.mode === 'live'
          ? { name: 'XRPL Testnet', description: 'Real XRPL Testnet (network_id 1). Test RLUSD has no real-world value. Mainnet is refused.' }
          : { name: 'Scripted rehearsal ledger', description: 'No network connection. In-process scripted XRPL Testnet behind the real P0-08 transport; ephemeral in-memory keys; nothing reaches XRPL.' },
      story: this.story(),
      preflight: this.preflightDto,
      review: { required: this.reviewReasons.length > 0, reasons: this.reviewReasons },
      ...(shown !== undefined ? { session: { runId: shown.runId, startedAt: shown.startedAt, status: shown.status } } : {}),
      ...(this.runAccounts() !== undefined ? { runAccounts: this.runAccounts() as { readonly treasury: string; readonly recipient: string } } : {}),
      ...(this.busy !== undefined ? { busy: { ...this.busy } } : {}),
      scenarioA: {
        phase: a.phase,
        agent: { label: 'Andrew\'s Treasury Agent', principal: DEMO_AGENT_PRINCIPAL },
        ...(a.amountUsd !== undefined ? { amountUsd: a.amountUsd } : this.preflightDto.requiredAmount !== undefined ? { amountUsd: this.preflightDto.requiredAmount } : {}),
        ...(a.destinationKey !== undefined ? { destinationKey: a.destinationKey } : {}),
        // The run's own recipient — never the current process's (a restarted rehearsal generates new accounts).
        ...(this.runRecipient() !== undefined ? { recipient: this.runRecipient() as string } : {}),
        ...(a.request !== undefined ? { request: a.request } : {}),
        ...(a.replay !== undefined ? { replay: a.replay } : {}),
        ...(a.approval !== undefined ? { approval: a.approval } : {}),
        ...(a.authorization !== undefined ? { authorization: a.authorization } : {}),
        lifecycle: [...a.lifecycle],
        ...(a.execution !== undefined ? { execution: a.execution } : {}),
        ...(a.evidence !== undefined ? { evidence: a.evidence } : {}),
        ...(a.second !== undefined ? { second: a.second } : {}),
        ...(a.historical !== undefined ? { historical: a.historical } : {}),
      },
      scenarioB: {
        status: b.status === 'locked' && approved && shown?.status === 'active' ? 'ready' : b.status,
        requestedUsd: SCENARIO_B_REQUEST_USD,
        ceilingUsd: ANDREW_PER_TRANSFER_CEILING_USD,
        destinationApproved: approved,
        ...(b.result !== undefined ? { result: b.result } : {}),
      },
      verdict: {
        status: verdictStatus,
        ...(failure !== undefined ? { failure: { category: failure.category, message: failure.message, ...(failure.step !== undefined ? { step: failure.step } : {}) } } : {}),
        summaryAvailable: shown?.summaryPath !== undefined,
        reportAvailable: shown?.reportPath !== undefined,
        ...(shown?.finishedAt !== undefined ? { finishedAt: shown.finishedAt } : {}),
      },
      checkpoints: (shown?.checkpoints ?? []).map((entry) => ({ step: entry.step, result: entry.result, ...(entry.detail !== undefined ? { detail: entry.detail } : {}) })),
      transcript: [...this.transcript],
      allowed: this.allowedActions(),
      ...(this.notice !== undefined ? { notice: this.notice } : {}),
    };
  }

  /**
   * The business scenario beside what this run actually governs and settles.
   * REHEARSAL governs the USD 75,000 scenario itself. LIVE governs and settles
   * the configured Testnet amount (default 10) and is then marked `scaled`:
   * the screen must never imply that USD 75,000 of RLUSD moved.
   */
  private story(): StoryDto {
    const governed = this.session?.configuration.amountUsd ?? this.recovered?.a.amountUsd ?? this.preflightDto.requiredAmount;
    return {
      businessAmountUsd: PRODUCTION_MOTIVATING_EXAMPLE_USD,
      ...(governed !== undefined ? { governedAmountUsd: governed, settlementAmount: governed } : {}),
      settlementAsset: 'Test RLUSD',
      settlementNetwork: this.mode === 'live' ? 'XRPL Testnet' : 'Scripted rehearsal ledger (no network)',
      scaled: governed !== undefined && governed !== PRODUCTION_MOTIVATING_EXAMPLE_USD,
      ceilingUsd: ANDREW_PER_TRANSFER_CEILING_USD,
      secondTestUsd: SCENARIO_B_REQUEST_USD,
    };
  }

  /** The recipient of the run on screen: the session's configuration, a recovered run's manifest, or — before any run — the preflight's. */
  private runRecipient(): string | undefined {
    if (this.session !== undefined) return this.session.configuration.recipient;
    if (this.recovered !== undefined) return this.recovered.recipient;
    return this.preflightDto.recipient;
  }

  /** The accounts of the run on screen (session configuration or the recovered run's manifest); none before any run. */
  private runAccounts(): { readonly treasury: string; readonly recipient: string } | undefined {
    if (this.session !== undefined) return { treasury: this.session.configuration.treasury, recipient: this.session.configuration.recipient };
    const r = this.recovered;
    return r?.treasury !== undefined && r.recipient !== undefined ? { treasury: r.treasury, recipient: r.recipient } : undefined;
  }

  /** The legal next actions — the table the backend enforces and the browser displays. */
  allowedActions(): Record<ActionName, boolean> {
    const s = this.session;
    const idle = this.busy === undefined;
    const active = s !== undefined && s.status === 'active' && !s.finalized;
    const phase = s?.a.phase ?? 'not-started';
    const inFlight = active && IN_FLIGHT.includes(phase);
    const review = this.reviewReasons.length > 0;
    const step = (wanted: ScenarioAPhase) => idle && active && phase === wanted;
    const approved = s?.a.approval?.state === 'approved';
    return {
      preflight: idle && !inFlight,
      session: idle && !inFlight && !review && !this.guardTripped,
      request: step('not-started'),
      replay: step('denied'),
      approve: step('replayed'),
      reconsider: step('approved') && !review,
      execute: step('authorized') && !review,
      abandon: step('authorized'),
      verifyEvidence: step('confirmed'),
      reconsiderAgain: step('evidence-verified'),
      historical: step('refused-second'),
      scenarioB: idle && active && approved && !inFlight && s?.b.status === 'locked',
    };
  }

  /** The written summary of the current (or recovered) run, if the run has finished — local paths named, not shown. */
  summaryText(): string | undefined {
    const path = (this.session ?? this.recovered)?.summaryPath;
    return path !== undefined && existsSync(path) ? this.redact(readFileSync(path, 'utf8')) : undefined;
  }

  reportText(): { readonly name: string; readonly text: string } | undefined {
    const shown = this.session ?? this.recovered;
    const path = shown?.reportPath;
    return path !== undefined && existsSync(path) && shown !== undefined ? { name: `ANDREW-DEMO-${shown.runId}.md`, text: this.redact(readFileSync(path, 'utf8')) } : undefined;
  }

  /** The server reports a refused serialization here: a run with a tripped guard can never PASS. */
  secretGuard(): SecretGuard {
    return this.guard;
  }

  noteGuardTripped(): void {
    this.guardTripped = true;
    const s = this.session;
    if (s !== undefined && !s.finalized) {
      s.failure = { category: 'UNEXPECTED DEMO ASSERTION FAILURE', message: 'a response was withheld because it matched secret material' };
      void this.finalize(s);
    } else if (s !== undefined) {
      s.verdict = 'FAIL';
    }
  }

  // ── Actions ──────────────────────────────────────────────────────────────

  async preflight(): Promise<void> {
    this.assertAllowed('preflight');
    await this.exclusive('preflight', async () => {
      await this.runPreflight();
    });
  }

  /** A fresh run: fresh preflight (must be READY), fresh run directory, fresh Host state. Never inherits an earlier run. */
  async createSession(): Promise<void> {
    this.assertAllowed('session');
    await this.exclusive('session', async () => {
      const previous = this.session;
      if (previous !== undefined && !previous.finalized) {
        previous.status = 'abandoned';
        previous.failure ??= { category: 'UNEXPECTED DEMO ASSERTION FAILURE', message: 'the session was replaced by a new session before it finished' };
        await this.finalize(previous);
      }
      this.notice = undefined;
      const prepared = await this.runPreflight();
      if (prepared === undefined) throw new ActionRefused('session', 'Preflight is NOT READY — no session was started and no governed action was made.');
      if (this.reviewReasons.length > 0) throw new ActionRefused('session', 'An XRPL attempt requires review — no new session until it is reconciled.');
      const startedAt = this.now().toISOString();
      const runId = newRunId(this.now());
      const session: Session = {
        runId,
        startedAt,
        configuration: prepared.configuration,
        preflight: prepared.preflight,
        checkpoints: [],
        run: new DemoRunResources(),
        gate: createExecutionGate(this.now),
        status: 'active',
        a: { phase: 'not-started', lifecycle: [] },
        b: { status: 'locked' },
        scenarioBWindow: false,
        transportEventsDuringB: 0,
        finalized: false,
      };
      this.session = session;
      this.recovered = undefined;
      this.transcript.length = 0;
      this.present.banner(`FRONTERA — Andrew / LUMX governed payment demo (${this.mode === 'live' ? 'LIVE • XRPL TESTNET' : 'REHEARSAL — NO XRPL TRANSACTION'})`);
      try {
        session.context = await openDemoRun(session.run, {
          configuration: prepared.configuration,
          secrets: prepared.secrets,
          ports: this.ports,
          guard: this.guard,
          present: this.present,
          runId,
          startedAt,
          checkpoints: session.checkpoints,
          transportObserver: (event) => this.onTransportEvent(session, event),
          wrapTransport: (transport) => session.gate.wrap(transport),
        });
        session.steps = createScenarioA(session.context);
      } catch (error) {
        await this.fail(session, error);
        return;
      }
      this.persist(session);
    });
  }

  /** A1 + A2. */
  request(): Promise<void> {
    return this.step('request', async (s, steps) => {
      const r = await steps.request();
      s.a.amountUsd = r.amountUsd;
      s.a.destinationKey = r.destinationKey;
      s.a.request = {
        requestId: r.originalRequestId,
        decision: { decisionId: r.originalDecision.decisionId, status: r.originalDecision.status, reasonCodes: [...r.originalDecision.reasonCodes] },
        initialApprovalState: r.initialApprovalState,
        identityActor: r.identityActor,
        authorityPresence: r.authorityPresence,
        traceVerified: r.originalTraceVerified,
        counters: counters(r.counters),
      };
      s.a.phase = 'denied';
    });
  }

  /** A3. */
  replay(): Promise<void> {
    return this.step('replay', async (s, steps) => {
      const r = await steps.replay();
      s.a.replay = { requestId: str(r.requestId), decisionId: r.decisionId, sameDecision: r.sameDecision, counters: counters(r.counters) };
      s.a.phase = 'replayed';
    });
  }

  /** A4 — approval executes nothing; the next step needs its own explicit action. */
  approve(): Promise<void> {
    return this.step('approve', async (s, steps) => {
      const r = await steps.approve();
      s.a.approval = { state: r.approvalState, approvedBy: str(r.approvalEvidence.approvedBy), role: r.role, authorityBasis: str(r.approvalEvidence.authorityBasis), approvedAt: str(r.approvalEvidence.approvedAt), counters: counters(r.counters) };
      s.a.phase = 'approved';
    });
  }

  /**
   * A5–A6: the linked reconsideration is sent; the Host decides, grants and
   * routes the payment, which stops at the execution gate before anything is
   * signed. Returns at AUTHORIZED.
   */
  reconsider(): Promise<void> {
    return this.step('reconsider', async (s, steps) => {
      s.a.phase = 'reconsidering';
      const pending = steps.reconsider();
      s.pendingReconsideration = pending;
      // Never an unhandled rejection: the outcome is consumed by execute() or abandon().
      pending.catch(() => {});
      const outcome = await Promise.race([
        pending.then(
          () => ({ kind: 'done' as const }),
          (error: unknown) => ({ kind: 'error' as const, error }),
        ),
        s.gate.arrival().then((held) => ({ kind: 'held' as const, held })),
      ]);
      if (outcome.kind === 'error') throw outcome.error;
      if (outcome.kind === 'done') throw new DemoFailure('UNEXPECTED DEMO ASSERTION FAILURE', 'A6: the reconsideration completed without stopping at the operator release point');
      await this.describeAuthorization(s, outcome.held);
      s.a.lifecycle.push({ state: 'AUTHORIZED', at: outcome.held.heldAt, detail: 'execution held before signing — awaiting operator release' });
      s.a.phase = 'authorized';
    });
  }

  /**
   * A7 — the explicit release. Returns as soon as the held submission is
   * released; `completion` settles when the harness has checked the outcome
   * (attempt store and an independent ledger re-read). The browser follows
   * the real lifecycle by polling the state.
   */
  async execute(): Promise<{ readonly completion: Promise<void> }> {
    this.assertAllowed('execute');
    const s = this.session as Session;
    this.busy = { action: 'execute', since: this.now().toISOString() };
    s.a.phase = 'executing';
    s.a.lifecycle.push({ state: 'RELEASED', at: this.now().toISOString(), detail: 'operator released the authorized execution' });
    this.persist(s);
    s.gate.release();
    const completion = (async () => {
      try {
        const r = await (s.pendingReconsideration as Promise<ScenarioAReconsiderationResult>);
        if (s.gate.extraSubmissions() !== 0) throw new DemoFailure('UNEXPECTED DEMO ASSERTION FAILURE', 'A7: a second submission reached the execution gate');
        s.a.execution = {
          transactionHash: r.transactionHash,
          ...(r.ledgerIndex !== undefined ? { ledgerIndex: r.ledgerIndex } : {}),
          ...(r.engineResult !== undefined ? { engineResult: r.engineResult } : {}),
          ...(r.deliveredAmount?.value !== undefined ? { deliveredValue: r.deliveredAmount.value } : {}),
          deliveredAsset: r.deliveredAmount?.issuer === RLUSD_XRPL_TESTNET_ISSUER ? 'Test RLUSD' : 'UNKNOWN ASSET',
          ...(r.sourceAccount !== undefined ? { sourceAccount: r.sourceAccount } : {}),
          ...(r.destinationAccount !== undefined ? { destinationAccount: r.destinationAccount } : {}),
          attemptState: r.attemptState,
          counters: counters(r.counters),
          scripted: this.mode === 'rehearsal',
        };
        if (s.a.authorization !== undefined) {
          s.a.authorization = {
            ...s.a.authorization,
            decisionStatus: r.reconsiderationDecision.status,
            reasonCodes: [...r.reconsiderationDecision.reasonCodes],
            businessIntentId: str(r.businessIntentId),
            reason: str(r.reconsiderationReason),
            identityActor: r.identityActor,
          };
        }
        s.a.lifecycle.push({ state: 'CONFIRMED', at: this.now().toISOString(), detail: 'attempt store and an independent ledger re-read agree' });
        s.a.phase = 'confirmed';
      } catch (error) {
        await this.fail(s, error);
      } finally {
        this.busy = undefined;
        this.persist(s);
      }
    })();
    return { completion };
  }

  /** Stop at AUTHORIZED without executing: the held submission answers `not-submitted`. The run fails (it did not complete), and nothing was signed. */
  async abandon(): Promise<void> {
    this.assertAllowed('abandon');
    const s = this.session as Session;
    await this.exclusive('abandon', async () => {
      s.gate.abandon();
      await (s.pendingReconsideration as Promise<unknown>).catch(() => {});
      const now = s.context !== undefined ? measureCounters(s.context) : undefined;
      s.a.lifecycle.push({ state: 'NOT SUBMITTED', at: this.now().toISOString(), detail: `operator stopped before release — signatures ${now?.signatures ?? 0}, submissions ${now?.submissions ?? 0}` });
      s.failure = { category: 'UNEXPECTED DEMO ASSERTION FAILURE', message: `the operator stopped the authorized execution before release; nothing was signed or submitted (signatures ${now?.signatures ?? 0}, submissions ${now?.submissions ?? 0})` };
      s.a.phase = 'failed';
      await this.finalize(s);
    });
  }

  /** A8. */
  verifyEvidence(): Promise<void> {
    return this.step('verifyEvidence', async (s, steps) => {
      const r = await steps.verifyEvidence();
      s.a.evidence = { finalState: str(r.finalState), verified: r.verified, checks: r.checks, results: r.results.map((entry) => ({ check: entry.check, status: entry.status })) };
      s.a.phase = 'evidence-verified';
    });
  }

  /** A9. */
  reconsiderAgain(): Promise<void> {
    return this.step('reconsiderAgain', async (s, steps) => {
      const before = s.a.execution?.counters ?? ZERO;
      const r = await steps.reconsiderAgain();
      s.a.second = { requestId: str(r.requestId), status: str(r.status), reasonCodes: [...r.reasonCodes], newGrants: r.counters.grants - before.grants, newSignatures: r.counters.signatures - before.signatures, newSubmissions: r.counters.submissions - before.submissions };
      s.a.phase = 'refused-second';
    });
  }

  /** A10. */
  historical(): Promise<void> {
    return this.step('historical', async (s, steps) => {
      const r = await steps.historicalTruth();
      s.a.historical = { status: str(r.status), decisionId: r.decisionId, unchanged: r.unchanged, traceVerified: r.originalTraceVerified };
      s.aRecord = steps.record();
      s.a.phase = 'complete';
      if (s.b.record !== undefined) await this.finalize(s);
    });
  }

  /** Scenario B: approved destination, USD 125,000 against the USD 100,000 ceiling. Any XRPL transport activity is a fatal invariant violation. */
  async scenarioB(): Promise<void> {
    this.assertAllowed('scenarioB');
    const s = this.session as Session;
    await this.exclusive('scenarioB', async () => {
      s.b.status = 'running';
      const context = s.context as ScenarioContext;
      const before = context.binding.activity();
      s.scenarioBWindow = true;
      try {
        const r = await runScenarioB(context);
        s.scenarioBWindow = false;
        const after = context.binding.activity();
        if (after.connections !== before.connections || after.signatures !== before.signatures || after.submissions !== before.submissions || s.transportEventsDuringB !== 0) {
          throw new DemoFailure('UNEXPECTED DEMO ASSERTION FAILURE', 'B: FATAL — the over-ceiling request reached the XRPL transport');
        }
        const issuance = (r['issuanceRecord'] ?? {}) as Record<string, unknown>;
        s.b.record = r;
        s.b.result = {
          requestId: str(r['requestId']),
          decisionId: str(r['decisionId']),
          decisionStatus: str(r['decisionStatus']),
          reasonCode: str(r['reasonCode']),
          withheldBy: str(r['withheldBy']),
          issuanceOutcome: str(r['issuanceOutcome']),
          ...(r['requestedAmount'] !== undefined ? { requested: r['requestedAmount'] as { value: string; unit: string } } : {}),
          ...(r['authorityCeiling'] !== undefined ? { ceiling: r['authorityCeiling'] as { value: string; unit: string } } : {}),
          ...(issuance['referenceId'] !== undefined ? { issuanceRecordId: str(issuance['referenceId']) } : {}),
          grants: Number(r['grantCount']),
          connections: Number(r['connectionCount']),
          signatures: Number(r['signatureCount']),
          submissions: Number(r['submissionCount']),
          attemptRows: Number(r['attemptRowCount']),
          transaction: r['transactionHash'] === null ? null : str(r['transactionHash']),
          assureFinalState: str(r['assureFinalState']),
          assureVerified: r['assureVerified'] === true,
        };
        s.b.status = 'blocked';
        if (s.a.phase === 'complete') await this.finalize(s);
      } catch (error) {
        s.scenarioBWindow = false;
        s.b.status = 'failed';
        await this.fail(s, error);
      }
    });
  }

  /** Close the session's Host and witness (server shutdown). An authorized-but-unreleased execution is abandoned: nothing is signed. */
  async close(): Promise<void> {
    const s = this.session;
    if (s === undefined || s.finalized) return;
    s.gate.abandon();
    await s.pendingReconsideration?.catch(() => {});
    s.status = 'interrupted';
    s.failure ??= { category: 'UNEXPECTED DEMO ASSERTION FAILURE', message: 'the demo backend stopped before the session finished' };
    await this.finalize(s);
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private assertAllowed(action: ActionName): void {
    if (this.busy !== undefined) throw new ActionRefused(action, `Another action (${this.busy.action}) is still running.`);
    if (!this.allowedActions()[action]) throw new ActionRefused(action, `'${action}' is not allowed in the current state.`);
  }

  private async exclusive(action: ActionName, body: () => Promise<void>): Promise<void> {
    this.busy = { action, since: this.now().toISOString() };
    try {
      await body();
    } finally {
      this.busy = undefined;
      if (this.session !== undefined) this.persist(this.session);
    }
  }

  private async step(action: ActionName, body: (session: Session, steps: ScenarioASteps) => Promise<void>): Promise<void> {
    this.assertAllowed(action);
    const s = this.session as Session;
    await this.exclusive(action, async () => {
      try {
        await body(s, s.steps as ScenarioASteps);
      } catch (error) {
        if (error instanceof ActionRefused) throw error;
        await this.fail(s, error);
      }
    });
  }

  /** The authorization as canonical records state it while the payment is held: the grant store, the held submission, the request's trace. */
  private async describeAuthorization(s: Session, held: HeldSubmission): Promise<void> {
    const context = s.context as ScenarioContext;
    const now = measureCounters(context);
    if (now.grants !== 1 || now.signatures !== 0 || now.submissions !== 0 || now.attempts !== 0) {
      throw new DemoFailure('UNEXPECTED DEMO ASSERTION FAILURE', `A6: before release expected exactly 1 grant and no XRPL signature, submission or attempt — got ${JSON.stringify(now)}`);
    }
    const grant = readGrants(context.paths)[0] ?? {};
    const correlation = (grant['correlation'] ?? {}) as Record<string, unknown>;
    if (correlation['requestId'] !== held.requestId || correlation['decisionId'] !== held.decisionId) throw new DemoFailure('UNEXPECTED DEMO ASSERTION FAILURE', 'A6: the held execution is not covered by the reconsideration\'s grant');
    const amount = ((grant['scope'] ?? {}) as Record<string, unknown>)['amount'] as { readonly kind?: string; readonly limit?: string; readonly unit?: string } | undefined;
    let lineage: Record<string, unknown> = {};
    let identityActor: string | undefined;
    try {
      const traced = await new EvidenceClient(context.demo.baseUrl, context.credentials.auditor).trace(held.requestId);
      lineage = (traced.trace.stages['request']?.['lineage'] ?? {}) as Record<string, unknown>;
      identityActor = str(traced.trace.stages['request']?.['actorId']) || undefined;
    } catch {
      // The trace of an in-flight request may not be readable yet; the harness reads and verifies it after execution.
    }
    const original = s.a.request?.requestId ?? '';
    const reconsiders = (lineage['reconsiders'] ?? {}) as Record<string, unknown>;
    if (reconsiders['requestId'] !== undefined && reconsiders['requestId'] !== original) throw new DemoFailure('UNEXPECTED DEMO ASSERTION FAILURE', 'A5: the reconsideration is not linked to the denied original');
    const notAfter = Date.parse(held.notAfter);
    s.a.authorization = {
      originalRequestId: original,
      reconsiderationRequestId: held.requestId,
      decisionId: held.decisionId,
      ...(typeof lineage['businessIntentId'] === 'string' ? { businessIntentId: lineage['businessIntentId'] } : {}),
      ...(typeof lineage['reason'] === 'string' ? { reason: lineage['reason'] } : {}),
      ...(identityActor !== undefined ? { identityActor } : {}),
      grantId: str(grant['id']),
      ...(amount?.kind === 'ceiling' && amount.limit !== undefined && amount.unit !== undefined ? { grantCeiling: { limit: amount.limit, unit: amount.unit } } : {}),
      executionId: held.executionId,
      grantNotAfter: held.notAfter,
      releaseDeadline: Number.isNaN(notAfter) ? held.notAfter : new Date(notAfter - DEFAULT_MINIMUM_GRANT_REMAINING_MS).toISOString(),
      heldAt: held.heldAt,
      payment: { destination: held.destination, ...(held.amount?.value !== undefined ? { value: held.amount.value } : {}), currencyLabel: held.amount?.issuer === RLUSD_XRPL_TESTNET_ISSUER ? 'Test RLUSD (XRPL Testnet issuer)' : 'UNKNOWN ASSET' },
      counters: counters(now),
    };
  }

  private onTransportEvent(s: Session, event: DemoTransportEvent): void {
    if (s.scenarioBWindow) s.transportEventsDuringB += 1;
    const at = this.now().toISOString();
    const push = (state: LifecycleEntryDto['state'], detail?: string) => s.a.lifecycle.push({ state, at, ...(detail !== undefined ? { detail } : {}) });
    switch (event.event) {
      case 'signing':
        push('SIGNING', this.mode === 'live' ? 'treasury key, on the backend only' : 'ephemeral rehearsal key, in memory only');
        break;
      case 'submitting':
        push('SUBMITTING', this.mode === 'live' ? 'to XRPL Testnet' : 'to the scripted rehearsal ledger');
        break;
      case 'xrpl.attempt.submitted':
        push('VALIDATING', event.detail !== undefined ? `preliminary ${event.detail}; awaiting a validated ledger` : 'awaiting a validated ledger');
        break;
      case 'xrpl.attempt.validated':
        push('VALIDATED', event.detail);
        break;
      case 'xrpl.submission.refused':
      case 'xrpl.attempt.validated-tec':
      case 'xrpl.attempt.expired':
        push('REFUSED', event.detail ?? event.event);
        break;
      case 'xrpl.attempt.submit-uncertain':
      case 'xrpl.attempt.unresolved':
      case 'xrpl.attempt.anomaly':
        push('REVIEW REQUIRED', event.detail ?? event.event);
        break;
      default:
        break;
    }
    this.persist(s);
  }

  private async fail(s: Session, error: unknown): Promise<void> {
    s.failure ??= describeDemoFailure(error, this.guard, s.checkpoints);
    if (s.a.phase !== 'complete') s.a.phase = 'failed';
    await this.finalize(s);
  }

  /** Close the run and write its evidence. PASS only when both scenarios passed every harness check and the summary was written. */
  private async finalize(s: Session): Promise<void> {
    if (s.finalized) return;
    s.finalized = true;
    s.gate.abandon();
    await s.run.close();
    const invariantBroken = s.gate.extraSubmissions() !== 0 || s.transportEventsDuringB !== 0 || this.guardTripped;
    if (invariantBroken && s.failure === undefined) s.failure = { category: 'UNEXPECTED DEMO ASSERTION FAILURE', message: 'a demo invariant was violated (an extra submission, Scenario B transport activity, or a withheld response)' };
    const verdict: 'PASS' | 'FAIL' = s.failure === undefined && s.aRecord !== undefined && s.b.record !== undefined ? 'PASS' : 'FAIL';
    s.finishedAt = this.now().toISOString();
    const summary = buildDemoSummary({
      runId: s.runId,
      startedAt: s.startedAt,
      finishedAt: s.finishedAt,
      configuration: s.configuration,
      preflight: s.preflight,
      infrastructure: s.run.infrastructure,
      scenarioA: s.aRecord,
      scenarioB: s.b.record,
      checkpoints: s.checkpoints,
      failure: s.failure,
      verdict,
    });
    let written = false;
    if (s.run.paths !== undefined) {
      try {
        const paths = writeDemoEvidence(s.run.paths, summary, this.guard);
        s.summaryPath = paths.summaryPath;
        s.reportPath = paths.reportPath;
        written = true;
      } catch {
        s.failure ??= { category: 'EVIDENCE VERIFICATION FAILURE', message: 'the evidence summary could not be written' };
      }
    }
    s.verdict = verdict === 'PASS' && written ? 'PASS' : 'FAIL';
    if (s.status === 'active') s.status = s.verdict === 'PASS' ? 'complete' : 'failed';
    this.present.banner('DEMO RESULT');
    if (s.verdict === 'PASS') {
      this.present.line('PASS');
      this.present.line('  Governance blocked what was forbidden.');
      this.present.line('  Governance allowed what became authorized.');
      this.present.line(`  Only authorized execution reached ${this.mode === 'live' ? 'XRPL Testnet' : 'the scripted rehearsal ledger'}.`);
      this.present.line('  Every material outcome is evidenced and verified.');
    } else {
      this.present.line(`FAIL — ${s.failure?.category ?? 'UNEXPECTED DEMO ASSERTION FAILURE'}: ${s.failure?.message ?? 'the run did not complete'}`);
    }
    this.reviewReasons = this.computeReview(s.configuration);
    this.persist(s);
  }

  /** Preflight, fresh. Returns the loaded configuration when READY. */
  private async runPreflight(): Promise<{ readonly configuration: DemoConfiguration; readonly secrets: Readonly<Record<string, string>>; readonly preflight: PreflightOutcome } | undefined> {
    const loaded = this.loadConfiguration();
    const checkedAt = this.now().toISOString();
    if (!loaded.ok) {
      this.preflightDto = { ...this.emptyPreflight(), status: 'NOT READY', checkedAt, reasons: loaded.reasons.map((reason) => this.redact(reason)), secrets: 'NOT CONFIGURED' };
      this.reviewReasons = this.computeReview(undefined);
      return undefined;
    }
    const { configuration, secrets } = loaded.loaded;
    const outcome = await runDemoPreflight(configuration, secrets, this.ports);
    const x = outcome.xrpl;
    const attemptBlocked = outcome.reasons.some((reason) => /XRPL attempt|attempt store|manifest/.test(reason));
    this.preflightDto = {
      status: outcome.verdict,
      checkedAt,
      reasons: outcome.reasons.map((reason) => this.redact(reason)),
      networkName: this.mode === 'live' ? 'XRPL Testnet' : 'Scripted rehearsal ledger (XRPL Testnet rules)',
      ...(x?.connectedNetworkId !== undefined ? { connectedNetworkId: x.connectedNetworkId } : {}),
      expectedNetworkId: configuration.expectedNetworkId,
      ...(x?.validatedLedgerIndex !== undefined ? { validatedLedger: x.validatedLedgerIndex } : {}),
      treasury: configuration.treasury,
      recipient: configuration.recipient,
      issuer: RLUSD_XRPL_TESTNET_ISSUER,
      ...(x !== undefined ? { treasuryTrustLine: x.treasury.trustLine, recipientTrustLine: x.recipient.trustLine } : {}),
      ...(x?.treasury.tokenBalance !== undefined ? { treasuryTestRlusd: x.treasury.tokenBalance } : {}),
      requiredAmount: configuration.amountUsd,
      attemptState: attemptBlocked ? 'blocked' : 'clean',
      secrets: this.mode === 'live' ? 'configured securely (backend only)' : 'none — ephemeral rehearsal keys in memory',
    };
    this.reviewReasons = this.computeReview(configuration);
    return outcome.verdict === 'READY' ? { configuration, secrets, preflight: outcome } : undefined;
  }

  private loadConfiguration(): ConfigurationResult {
    if (this.world !== undefined) return { ok: true, loaded: { configuration: this.world.configuration, secrets: this.world.secrets } };
    return loadDemoConfiguration(this.environment, this.guard);
  }

  private emptyPreflight(): PreflightDto {
    return {
      status: 'not-run',
      reasons: [],
      networkName: this.mode === 'live' ? 'XRPL Testnet' : 'Scripted rehearsal ledger (XRPL Testnet rules)',
      expectedNetworkId: 1,
      issuer: RLUSD_XRPL_TESTNET_ISSUER,
      attemptState: 'unknown',
      secrets: this.mode === 'live' ? 'not yet checked' : 'none — ephemeral rehearsal keys in memory',
      ...(this.world !== undefined ? { treasury: this.world.configuration.treasury, recipient: this.world.configuration.recipient, requiredAmount: this.world.configuration.amountUsd } : {}),
    };
  }

  /** Filesystem locations never reach the browser: the state root, the secrets file and the home directory are named, not shown. */
  private redact(text: string): string {
    let out = text;
    const secretsFile = this.environment['FRONTERA_ANDREW_SECRETS_FILE'] ?? join(defaultStateRoot(), 'testnet.env');
    for (const [path, label] of [[secretsFile, '<secrets file>'], [this.stateRoot, '<state root>'], [defaultStateRoot(), '<state root>'], [homedir(), '~']] as const) {
      if (path.length > 1) out = out.split(path).join(label);
    }
    return out;
  }

  /**
   * Unresolved XRPL attempts that block any further payment: every treasury
   * this demo's runs used (and the configured one), scanned by the P0-11
   * preflight rule. A run interrupted mid-execution therefore blocks until its
   * attempt is reconciled — and an interruption before signing (no attempt row)
   * blocks nothing, because nothing was signed.
   */
  private computeReview(configuration: DemoConfiguration | undefined): readonly string[] {
    const treasuries = new Set<string>();
    if (configuration !== undefined) treasuries.add(configuration.treasury);
    const runsRoot = join(this.stateRoot, 'runs');
    if (existsSync(runsRoot)) {
      for (const runId of readdirSync(runsRoot)) {
        if (!existsSync(join(runsRoot, runId, UI_STATE_FILE))) continue;
        try {
          const manifest = JSON.parse(readFileSync(join(runsRoot, runId, 'run.json'), 'utf8')) as { readonly treasury?: unknown };
          if (typeof manifest.treasury === 'string') treasuries.add(manifest.treasury);
        } catch {
          return [`run ${runId}: its manifest cannot be read — inspect it before another payment`];
        }
      }
    }
    const reasons = new Set<string>();
    for (const treasury of treasuries) {
      const scope = { ...(configuration ?? ({} as DemoConfiguration)), stateRoot: this.stateRoot, treasury };
      for (const reason of unresolvedAttemptReasons(scope)) reasons.add(this.redact(reason));
    }
    return [...reasons];
  }

  /** The non-secret session snapshot, beside the run's own records. */
  private persist(s: Session): void {
    const directory = s.run.paths?.runDirectory;
    if (directory === undefined) return;
    const snapshot = {
      schema: 'frontera.andrew-demo-ui.session.v1',
      mode: this.mode,
      runId: s.runId,
      startedAt: s.startedAt,
      updatedAt: this.now().toISOString(),
      status: s.status,
      a: s.a,
      b: { status: s.b.status, ...(s.b.result !== undefined ? { result: s.b.result } : {}) },
      checkpoints: s.checkpoints,
      ...(s.verdict !== undefined ? { verdict: s.verdict } : {}),
      ...(s.failure !== undefined ? { failure: s.failure } : {}),
      ...(s.finishedAt !== undefined ? { finishedAt: s.finishedAt } : {}),
      summaryWritten: s.summaryPath !== undefined,
    };
    try {
      writeFileSync(join(directory, UI_STATE_FILE), this.guard.check(`${JSON.stringify(snapshot, null, 2)}\n`), { mode: 0o600 });
    } catch {
      this.guardTripped = true;
    }
  }

  /**
   * After a backend restart: the latest session snapshot is shown read-only. A
   * session that was still active is marked interrupted (it can never resume —
   * its Host, keys and credentials lived in the stopped process); whether that
   * blocks further payments is decided by the attempt store, not the snapshot.
   */
  private recoverFromDisk(): void {
    const runsRoot = join(this.stateRoot, 'runs');
    if (!existsSync(runsRoot)) return;
    let latest: { readonly runId: string; readonly startedAt: string; readonly snapshot: Record<string, unknown> } | undefined;
    for (const runId of readdirSync(runsRoot)) {
      const file = join(runsRoot, runId, UI_STATE_FILE);
      if (!existsSync(file)) continue;
      let snapshot: Record<string, unknown>;
      try {
        snapshot = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (snapshot['status'] === 'active') {
        snapshot['status'] = 'interrupted';
        snapshot['failure'] ??= { category: 'UNEXPECTED DEMO ASSERTION FAILURE', message: 'the demo backend stopped before this session finished' };
        snapshot['verdict'] = 'FAIL';
        try {
          writeFileSync(file, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
        } catch {
          // Display only.
        }
      }
      const startedAt = str(snapshot['startedAt']);
      if (latest === undefined || startedAt > latest.startedAt) latest = { runId, startedAt, snapshot };
    }
    if (latest === undefined) return;
    const snap = latest.snapshot;
    const directory = join(runsRoot, latest.runId);
    const summaryPath = join(directory, 'summary.json');
    const reportPath = join(directory, `ANDREW-DEMO-${latest.runId}.md`);
    let recipient: string | undefined;
    let treasury: string | undefined;
    try {
      const manifest = JSON.parse(readFileSync(join(directory, 'run.json'), 'utf8')) as { readonly recipient?: unknown; readonly treasury?: unknown };
      if (typeof manifest.recipient === 'string') recipient = manifest.recipient;
      if (typeof manifest.treasury === 'string') treasury = manifest.treasury;
    } catch {
      // Display only: without a readable manifest the recipient is not shown.
    }
    this.recovered = {
      runId: latest.runId,
      ...(recipient !== undefined ? { recipient } : {}),
      ...(treasury !== undefined ? { treasury } : {}),
      startedAt: latest.startedAt,
      status: snap['status'] as RecoveredSession['status'],
      a: (snap['a'] ?? { phase: 'not-started', lifecycle: [] }) as ScenarioAView,
      b: (snap['b'] ?? { status: 'locked' }) as Session['b'],
      checkpoints: (snap['checkpoints'] ?? []) as DemoSummary['checkpoints'][number][],
      ...(snap['verdict'] === 'PASS' || snap['verdict'] === 'FAIL' ? { verdict: snap['verdict'] } : {}),
      ...(snap['failure'] !== undefined ? { failure: snap['failure'] as NonNullable<DemoSummary['failure']> } : {}),
      ...(existsSync(summaryPath) ? { summaryPath } : {}),
      ...(existsSync(reportPath) ? { reportPath } : {}),
      ...(typeof snap['finishedAt'] === 'string' ? { finishedAt: snap['finishedAt'] } : {}),
    };
    if (this.recovered.status === 'interrupted') {
      this.notice = `Recovered run ${latest.runId}: the backend stopped while it was ${String((this.recovered.a as ScenarioAView).phase)}. It cannot resume; start a new session. Any unresolved XRPL attempt blocks further payments.`;
    }
  }
}
