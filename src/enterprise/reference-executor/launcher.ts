import { readFileSync, realpathSync } from 'node:fs';
import { dirname, sep } from 'node:path';

import { ReferenceExecutorConfigurationError, parseReferenceExecutorConfiguration, type ReferenceExecutorConfiguration, type ReferenceExecutorFaultPoint } from './configuration.js';
import type { ReferenceExecutorExecutionFlow } from './execution-flow.js';
import { startReferenceExecutorGateway, type ReferenceExecutorGateway } from './gateway.js';
import { REFERENCE_EXECUTOR_HTTP_BINDING_FORMAT } from './binding-reconstruction.js';
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
/** CI crash injection needs this variable set to `enabled` as well as `faultInjection` in the configuration: one file alone cannot make the executor kill itself. */
export const REFERENCE_EXECUTOR_FAULT_INJECTION_VARIABLE = 'FRONTERA_REFERENCE_EXECUTOR_FAULT_INJECTION';

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
  if (configuration.faultInjection !== null && environment[REFERENCE_EXECUTOR_FAULT_INJECTION_VARIABLE] !== 'enabled') {
    throw new ReferenceExecutorStartupError('FAULT_INJECTION_NOT_ENABLED', `faultInjection needs ${REFERENCE_EXECUTOR_FAULT_INJECTION_VARIABLE}=enabled in the executor's environment.`);
  }
  const execution = configuration.mode === 'synthetic-execution' ? await openSyntheticExecution(configuration, clock, writeLine) : undefined;
  const gateway = await startReferenceExecutorGateway({
    configuration,
    clock,
    onAssessment: (assessment) => writeLine(JSON.stringify({ event: 'assessment', ...assessment })),
    ...(execution !== undefined ? { execution } : {}),
  });
  // The names (never the values) of the variables this process was given, so a supervisor can see what it holds.
  const variables = Object.keys(environment).sort();
  writeLine(JSON.stringify({ event: 'ready', mode: configuration.mode, executorId: configuration.executorId, receipts: configuration.executorReceipts === null ? null : configuration.executorReceipts.keyId, host: gateway.host, port: gateway.port, environment: variables }));
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
async function openSyntheticExecution(configuration: ReferenceExecutorConfiguration, clock: () => number, writeLine: (line: string) => void): Promise<ReferenceExecutorExecutionFlow> {
  const synthetic = configuration.syntheticExecution;
  if (synthetic === null) throw new ReferenceExecutorStartupError('MODE_INCONSISTENT', 'synthetic-execution mode requires its section.');
  const { openExecutionCapabilityConsumptionLedger } = await import('../execution-capability/reference/consumption-ledger.js');
  const { admitsEffect, openSyntheticDeploymentEffect } = await import('./synthetic-effect.js');
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
    effect = openSyntheticDeploymentEffect({ outputDirectory: synthetic.outputDirectory, durablyClaimed: (capabilityId) => admitsEffect(opened.read(capabilityId).state) });
    // Separate on disk, not only in spelling: neither real directory may contain the other.
    const ledgerDirectory = realpathSync(dirname(synthetic.consumptionLedgerPath));
    const output = synthetic.outputDirectory;
    if (ledgerDirectory === output || ledgerDirectory.startsWith(`${output}${sep}`) || output.startsWith(`${ledgerDirectory}${sep}`)) throw new Error('overlap');
  } catch {
    opened.close();
    throw new ReferenceExecutorStartupError('SYNTHETIC_OUTPUT_INVALID', 'The synthetic output directory is missing, a link, reached through a link, not this user\'s, writable by others, under an ancestor others can rename, or overlapping the ledger.');
  }
  const crashAt = configuration.faultInjection?.crashAt;
  // CI crash injection: an abrupt kill at one point of the execution path — no cleanup, no answer, nothing flushed by this process.
  // A hook that returns changes nothing; this one never throws.
  const fault = crashAt === undefined ? undefined : (point: ReferenceExecutorFaultPoint): void => {
    if (point === crashAt) process.kill(process.pid, 'SIGKILL');
  };
  const receipts = configuration.executorReceipts === null ? undefined : await openReceipts(configuration, opened, clock, writeLine, fault);
  return createReferenceExecutorExecutionFlow({
    configuration,
    pipeline: createReferenceExecutorVerificationPipeline(configuration, clock),
    ledger: opened,
    effect,
    clock,
    ...(fault !== undefined ? { fault } : {}),
    ...(receipts !== undefined ? { receipts } : {}),
  });
}

/**
 * G-02C1C: the receipt ledger (existing, pinned to this executor and audience), the executor's own receipt key, and the
 * issuer over both ledgers. Then a recovery sweep: every unresolved consumption gets the conservative receipt its
 * durable state supports. Nothing here claims, performs or records a consumption outcome.
 */
async function openReceipts(
  configuration: ReferenceExecutorConfiguration,
  consumption: Awaited<ReturnType<typeof import('../execution-capability/reference/consumption-ledger.js').openExecutionCapabilityConsumptionLedger>>,
  clock: () => number,
  writeLine: (line: string) => void,
  fault: ((point: ReferenceExecutorFaultPoint) => void) | undefined,
): Promise<{ issue(capabilityId: string, observed?: 'completed-observed' | 'failed-observed' | 'consumed-not-attempted' | 'attempted-outcome-unknown'): unknown }> {
  const settings = configuration.executorReceipts;
  const synthetic = configuration.syntheticExecution;
  if (settings === null || synthetic === null) throw new ReferenceExecutorStartupError('MODE_INCONSISTENT', 'Receipts need synthetic-execution mode.');
  const { openExecutorReceiptLedger } = await import('./receipt-ledger.js');
  const { loadExecutorReceiptSigner } = await import('./receipt-signer.js');
  const { createExecutorReceiptIssuer } = await import('./receipt-issuer.js');
  let receiptLedger: Awaited<ReturnType<typeof openExecutorReceiptLedger>>;
  try {
    receiptLedger = await openExecutorReceiptLedger(settings.receiptLedgerPath, { executorId: configuration.executorId, audience: configuration.audience, clock });
  } catch {
    throw new ReferenceExecutorStartupError('RECEIPT_LEDGER_INVALID', 'The receipt ledger is missing, damaged, or pinned to another executor or audience; the executor never creates one.');
  }
  let signer: ReturnType<typeof loadExecutorReceiptSigner>;
  try {
    signer = loadExecutorReceiptSigner({ executorId: configuration.executorId, keyId: settings.keyId, privateKeyFile: settings.privateKeyFile, issuerKeys: configuration.trustedIssuers.flatMap((entry) => entry.keys) });
  } catch {
    receiptLedger.close();
    // Never the key, never its path: a code and a reason.
    throw new ReferenceExecutorStartupError('RECEIPT_KEY_INVALID', 'The receipt key is missing, unreadable, not private to this user, not Ed25519, or a trusted issuer key.');
  }
  const issuer = createExecutorReceiptIssuer({
    executorId: configuration.executorId,
    audience: configuration.audience,
    bindingFormat: REFERENCE_EXECUTOR_HTTP_BINDING_FORMAT,
    consumption,
    receipts: receiptLedger,
    signer,
    outputDirectory: synthetic.outputDirectory,
    ...(fault !== undefined ? { fault } : {}),
  });
  const reported = Object.freeze({
    issue: (capabilityId: string, observed?: 'completed-observed' | 'failed-observed' | 'consumed-not-attempted' | 'attempted-outcome-unknown') => {
      const issuance = observed === undefined ? issuer.issue(capabilityId) : issuer.issue(capabilityId, observed);
      // Never the receipt text or its signature on the diagnostic line: the status, and what the receipt says.
      writeLine(JSON.stringify(issuance.status === 'issued' ? { event: 'receipt', status: 'issued', sequence: issuance.sequence, outcome: issuance.outcome } : { event: 'receipt', status: 'refused', code: issuance.code }));
      return issuance;
    },
  });
  // Recovery: unresolved consumptions, page by page; each gets the receipt its durable state supports. Never an effect.
  let after: { readonly claimedAt: string; readonly capabilityId: string } | undefined;
  for (;;) {
    const page = consumption.listUnresolved(after === undefined ? {} : { after });
    for (const record of page.records) reported.issue(record.capabilityId);
    if (page.next === undefined) break;
    after = page.next;
  }
  return reported;
}
