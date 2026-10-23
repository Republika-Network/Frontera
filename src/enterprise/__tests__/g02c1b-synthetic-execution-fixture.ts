import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import assert from 'node:assert/strict';

import { EXECUTION_CAPABILITY_PRESENTATION_HEADER } from '../execution-capability-presentation/index.js';
import { openExecutionCapabilityConsumptionLedger, type ExecutionCapabilityConsumptionLedger, type ExecutionCapabilityConsumptionRecord } from '../execution-capability/reference/consumption-ledger.js';
import type { ExecutionCapability } from '../execution-capability/index.js';
import { createReferenceExecutorExecutionFlow, type ReferenceExecutorExecutionFlow } from '../reference-executor/execution-flow.js';
import { admitsEffect, openSyntheticDeploymentEffect, type SyntheticDeploymentEffect } from '../reference-executor/synthetic-effect.js';
import { createReferenceExecutorVerificationPipeline, parseReferenceExecutorConfiguration, type ReferenceExecutorConfiguration, type ReferenceExecutorFaultPoint } from '../reference-executor/index.js';
import { ACTION, AUDIENCE, EXECUTOR_ENVIRONMENT, capabilityFor, editHeaders, executorConfiguration, presentationFor, type RawRequest } from './g02c1a-reference-executor-fixture.js';

/**
 * G-02C1B fixtures — test-only, synthetic, local. A **synthetic domain** is one
 * temporary root holding an initialized G-02A consumption ledger (created here
 * with G-02A's own explicit `create: true`, as an operator would) and a
 * private output directory for synthetic records. Executors open it; this
 * process reads it back through the same G-02A API.
 */

export const SYNTHETIC_ACTION = 'synthetic.apply-release';
export const SYNTHETIC_EFFECT = 'frontera.synthetic-deployment-record.v1';

export interface SyntheticDomain {
  readonly root: string;
  readonly ledgerPath: string;
  readonly outputDirectory: string;
  /** Record file names in the output directory. */
  records(): string[];
  /** The raw text of a capability's record, if one exists. */
  recordText(capabilityId: string): string | undefined;
  /** The ledger's record for a capability, read through G-02A in this process. */
  state(capabilityId: string): Promise<ExecutionCapabilityConsumptionRecord>;
  cleanup(): void;
}

export async function syntheticDomain(audience: string = AUDIENCE): Promise<SyntheticDomain> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'frontera-g02c1b-')));
  const ledgerDirectory = join(root, 'ledger');
  const outputDirectory = join(root, 'output');
  mkdirSync(ledgerDirectory, { mode: 0o700 });
  mkdirSync(outputDirectory, { mode: 0o700 });
  const ledgerPath = join(ledgerDirectory, 'consumption.sqlite');
  // The operator's one explicit initialization (G-02A); the executor never does this.
  (await openExecutionCapabilityConsumptionLedger(ledgerPath, { audience, clock: () => Date.now(), create: true })).close();
  return {
    root,
    ledgerPath,
    outputDirectory,
    records: () => readdirSync(outputDirectory).sort(),
    recordText: (capabilityId) => {
      try {
        return readFileSync(join(outputDirectory, `${capabilityId}.json`), 'utf8');
      } catch {
        return undefined;
      }
    },
    state: async (capabilityId) => {
      const ledger = await openExecutionCapabilityConsumptionLedger(ledgerPath, { audience, clock: () => Date.now() });
      try {
        return ledger.read(capabilityId);
      } finally {
        ledger.close();
      }
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** The G-02C1A executor configuration, in synthetic-execution mode over `domain`. `deploy-release` stays permitted and is not synthetic. */
export function syntheticConfiguration(domain: Pick<SyntheticDomain, 'ledgerPath' | 'outputDirectory'>, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return executorConfiguration({
    mode: 'synthetic-execution',
    permittedActions: [ACTION, SYNTHETIC_ACTION, 'scale-release'],
    syntheticExecution: { effect: SYNTHETIC_EFFECT, consumptionLedgerPath: domain.ledgerPath, outputDirectory: domain.outputDirectory, syntheticActions: [SYNTHETIC_ACTION] },
    ...overrides,
  });
}

export interface InProcessFlow {
  readonly flow: ReferenceExecutorExecutionFlow;
  readonly configuration: ReferenceExecutorConfiguration;
  readonly ledger: ExecutionCapabilityConsumptionLedger;
  readonly effect: SyntheticDeploymentEffect;
  /** Every claim, effect, outcome record and fault point, in the order they happened. */
  readonly events: string[];
  close(): void;
}

export interface InProcessFlowOptions {
  readonly clock?: () => number;
  readonly fault?: (point: ReferenceExecutorFaultPoint) => void;
  readonly busyTimeoutMs?: number;
  /** Replaces the ledger's `recordOutcome` (a ledger that cannot record). */
  readonly recordOutcome?: ExecutionCapabilityConsumptionLedger['recordOutcome'];
  readonly configuration?: Record<string, unknown>;
  /** The flow module to build from (a mutant). */
  readonly flowModule?: { readonly createReferenceExecutorExecutionFlow: typeof createReferenceExecutorExecutionFlow };
  /** G-02C1C: the receipt issuer to hand the flow, built over this flow's own consumption ledger. */
  readonly receiptsFor?: (ledger: ExecutionCapabilityConsumptionLedger) => NonNullable<Parameters<typeof createReferenceExecutorExecutionFlow>[0]['receipts']>;
}

/** The flow over a real ledger and a real effect, instrumented so every test can assert the order of claim, effect and outcome. */
export async function inProcessFlow(domain: SyntheticDomain, options: InProcessFlowOptions = {}): Promise<InProcessFlow> {
  const configuration = parseReferenceExecutorConfiguration(options.configuration ?? syntheticConfiguration(domain), EXECUTOR_ENVIRONMENT);
  const clock = options.clock ?? (() => Date.now());
  const ledger = await openExecutionCapabilityConsumptionLedger(domain.ledgerPath, { audience: configuration.audience, clock, ...(options.busyTimeoutMs !== undefined ? { busyTimeoutMs: options.busyTimeoutMs } : {}) });
  const events: string[] = [];
  const recording: ExecutionCapabilityConsumptionLedger = Object.freeze({
    audience: ledger.audience,
    claim: (verification: unknown) => {
      events.push('claim');
      const claim = ledger.claim(verification);
      events.push(`claim:${claim.outcome}`);
      return claim;
    },
    recordOutcome: (capabilityId: string, outcome: Parameters<ExecutionCapabilityConsumptionLedger['recordOutcome']>[1]) => {
      events.push(`record:${outcome}`);
      return (options.recordOutcome ?? ledger.recordOutcome)(capabilityId, outcome);
    },
    read: (capabilityId: string) => ledger.read(capabilityId),
    readExecution: (issuer: string, executionId: string) => ledger.readExecution(issuer, executionId),
    readDetail: (capabilityId: string) => ledger.readDetail(capabilityId),
    listUnresolved: (options?: Parameters<ExecutionCapabilityConsumptionLedger['listUnresolved']>[0]) => ledger.listUnresolved(options),
    close: () => ledger.close(),
  });
  const synthetic = configuration.syntheticExecution;
  assert.ok(synthetic !== null);
  const real = openSyntheticDeploymentEffect({
    outputDirectory: synthetic.outputDirectory,
    durablyClaimed: (capabilityId) => {
      const state = ledger.read(capabilityId).state;
      events.push(`effect-precondition:${state}`);
      return admitsEffect(state);
    },
  });
  const effect: SyntheticDeploymentEffect = Object.freeze({
    outputDirectory: real.outputDirectory,
    apply: (input: Parameters<SyntheticDeploymentEffect['apply']>[0], during?: () => void) => {
      events.push('effect-start');
      const observation = real.apply(input, during);
      events.push(`effect:${observation}`);
      return observation;
    },
  });
  const factory = options.flowModule?.createReferenceExecutorExecutionFlow ?? createReferenceExecutorExecutionFlow;
  const flow = factory({
    configuration,
    pipeline: createReferenceExecutorVerificationPipeline(configuration, clock),
    ledger: recording,
    effect,
    clock,
    fault: (point) => {
      events.push(point);
      options.fault?.(point);
    },
    ...(options.receiptsFor !== undefined ? { receipts: options.receiptsFor(ledger) } : {}),
  });
  return { flow, configuration, ledger, effect, events, close: () => ledger.close() };
}

/** A fresh synthetic capability for `digest`, and the presentation header value for it. */
export function syntheticCapability(digest: string, overrides: Partial<Record<keyof ExecutionCapability, unknown>> = {}): { readonly capability: ExecutionCapability; readonly presentation: string } {
  const capability = capabilityFor(digest, { action: SYNTHETIC_ACTION, ...overrides });
  return { capability, presentation: presentationFor(capability) };
}

/** `raw` presented with exactly `presentation`. */
export function presentedWith(raw: RawRequest, presentation: string): RawRequest {
  return editHeaders(raw, EXECUTION_CAPABILITY_PRESENTATION_HEADER, () => `${EXECUTION_CAPABILITY_PRESENTATION_HEADER}: ${presentation}`);
}

/** Writes `bytes` and drops the connection as soon as they are flushed: the client never reads an answer. */
export function sendAndDisconnect(port: number, bytes: Buffer): Promise<void> {
  return new Promise((done) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.on('error', () => done());
    socket.end(bytes, () => {
      socket.destroy();
      done();
    });
  });
}
