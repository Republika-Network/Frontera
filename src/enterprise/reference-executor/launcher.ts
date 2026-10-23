import { readFileSync } from 'node:fs';

import { ReferenceExecutorConfigurationError, parseReferenceExecutorConfiguration, type ReferenceExecutorConfiguration, type ReferenceExecutorFaultPoint } from './configuration.js';
import type { ReferenceExecutorExecutionFlow } from './execution-flow.js';
import { startReferenceExecutorGateway, type ReferenceExecutorGateway } from './gateway.js';
import { createReferenceExecutorVerificationPipeline } from './verification-pipeline.js';

/**
 * G-02C1A — starts the reference executor as **its own OS process**
 * (`scripts/run-reference-executor.mjs`).
 *
 * Its whole input is its own environment:
 *
 * - `FRONTERA_REFERENCE_EXECUTOR_CONFIG_FILE` — the closed trust configuration
 *   (`configuration.ts`): pinned issuer **public** keys, identities,
 *   allow-lists, origin, loopback listener;
 * - the one variable that configuration names for the client credential.
 *
 * It receives no Host configuration and no issuer private key. In
 * verification-only mode it opens no store. In synthetic-execution mode
 * (G-02C1B) — and only then — it loads the G-02A consumption ledger, opens the
 * **existing** ledger file the configuration names (never creating one: a
 * missing, damaged or foreign-audience ledger refuses startup), opens the
 * synthetic output directory, and hands the gateway the execution flow. Every line it writes to stdout is one JSON
 * object: a `ready` line, then one `assessment` line per request — never a
 * header value, the credential, a capability or a body.
 */

export const REFERENCE_EXECUTOR_CONFIG_ENVIRONMENT_VARIABLE = 'FRONTERA_REFERENCE_EXECUTOR_CONFIG_FILE';

export class ReferenceExecutorStartupError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ReferenceExecutorStartupError';
  }
}

export async function startReferenceExecutorProcess(environment: Readonly<Record<string, string | undefined>>, writeLine: (line: string) => void): Promise<ReferenceExecutorGateway> {
  const path = environment[REFERENCE_EXECUTOR_CONFIG_ENVIRONMENT_VARIABLE];
  if (typeof path !== 'string' || path.length === 0) throw new ReferenceExecutorStartupError('CONFIGURATION_FILE_MISSING', `${REFERENCE_EXECUTOR_CONFIG_ENVIRONMENT_VARIABLE} is required.`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // Never the parser's message: it can quote the document.
    throw new ReferenceExecutorStartupError('CONFIGURATION_UNREADABLE', 'The configuration file could not be read as JSON.');
  }
  const configuration = parseReferenceExecutorConfiguration(raw, environment);
  const clock = (): number => Date.now();
  const execution = configuration.mode === 'synthetic-execution' ? await openSyntheticExecution(configuration, clock) : undefined;
  const gateway = await startReferenceExecutorGateway({
    configuration,
    clock,
    onAssessment: (assessment) => writeLine(JSON.stringify({ event: 'assessment', ...assessment })),
    ...(execution !== undefined ? { execution } : {}),
  });
  // The names (never the values) of the variables this process was given, so a supervisor can see what it holds.
  const variables = Object.keys(environment).sort();
  writeLine(JSON.stringify({ event: 'ready', mode: configuration.mode, executorId: configuration.executorId, host: gateway.host, port: gateway.port, environment: variables }));
  return gateway;
}

/** The refusal line for a failed start: a code and the first line of a message that never carries a value. */
export function referenceExecutorStartupRefusal(error: unknown): string {
  const code = error instanceof ReferenceExecutorConfigurationError || error instanceof ReferenceExecutorStartupError ? error.code : 'STARTUP_FAILED';
  const message = error instanceof ReferenceExecutorConfigurationError || error instanceof ReferenceExecutorStartupError ? (error.message.split('\n')[0] ?? '') : 'startup failed';
  return JSON.stringify({ event: 'refused-to-start', code, message });
}

/**
 * G-02C1B: the ledger, the effect and the flow, built only in
 * synthetic-execution mode. The ledger module (and with it the database
 * driver) is loaded only here.
 */
async function openSyntheticExecution(configuration: ReferenceExecutorConfiguration, clock: () => number): Promise<ReferenceExecutorExecutionFlow> {
  const synthetic = configuration.syntheticExecution;
  if (synthetic === null) throw new ReferenceExecutorStartupError('MODE_INCONSISTENT', 'synthetic-execution mode requires its section.');
  const { openExecutionCapabilityConsumptionLedger } = await import('../execution-capability/reference/consumption-ledger.js');
  const { openSyntheticDeploymentEffect } = await import('./synthetic-effect.js');
  const { createReferenceExecutorExecutionFlow } = await import('./execution-flow.js');
  let ledger: Awaited<ReturnType<typeof openExecutionCapabilityConsumptionLedger>>;
  try {
    // Never `create: true`: the operator initializes a ledger once, with G-02A's own explicit call.
    ledger = await openExecutionCapabilityConsumptionLedger(synthetic.consumptionLedgerPath, { audience: configuration.audience, clock });
  } catch {
    throw new ReferenceExecutorStartupError('LEDGER_INVALID', 'The consumption ledger is missing, damaged or pinned to another audience; the executor never creates one.');
  }
  const opened = ledger;
  let effect: ReturnType<typeof openSyntheticDeploymentEffect>;
  try {
    effect = openSyntheticDeploymentEffect({ outputDirectory: synthetic.outputDirectory, durablyClaimed: (capabilityId) => opened.read(capabilityId).state === 'claimed' });
  } catch {
    opened.close();
    throw new ReferenceExecutorStartupError('SYNTHETIC_OUTPUT_INVALID', 'The synthetic output directory is missing, a link, reached through a link, or writable by others.');
  }
  const crashAt = configuration.faultInjection?.crashAt;
  // CI crash injection: an abrupt kill at one point of the execution path — no cleanup, no answer, nothing flushed by this process.
  const fault = crashAt === undefined ? undefined : (point: ReferenceExecutorFaultPoint): void => {
    if (point === crashAt) process.kill(process.pid, 'SIGKILL');
  };
  return createReferenceExecutorExecutionFlow({ configuration, pipeline: createReferenceExecutorVerificationPipeline(configuration, clock), ledger: opened, effect, clock, ...(fault !== undefined ? { fault } : {}) });
}
