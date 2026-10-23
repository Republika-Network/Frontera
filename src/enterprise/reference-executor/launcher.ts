import { readFileSync } from 'node:fs';

import { ReferenceExecutorConfigurationError, parseReferenceExecutorConfiguration } from './configuration.js';
import { startReferenceExecutorGateway, type ReferenceExecutorGateway } from './gateway.js';

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
 * It receives no Host configuration, no issuer private key and no database
 * path, and it opens no store. Every line it writes to stdout is one JSON
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
  const gateway = await startReferenceExecutorGateway({
    configuration,
    clock: () => Date.now(),
    onAssessment: (assessment) => writeLine(JSON.stringify({ event: 'assessment', ...assessment })),
  });
  writeLine(JSON.stringify({ event: 'ready', mode: 'verification-only', executorId: configuration.executorId, host: gateway.host, port: gateway.port }));
  return gateway;
}

/** The refusal line for a failed start: a code and the first line of a message that never carries a value. */
export function referenceExecutorStartupRefusal(error: unknown): string {
  const code = error instanceof ReferenceExecutorConfigurationError || error instanceof ReferenceExecutorStartupError ? error.code : 'STARTUP_FAILED';
  const message = error instanceof ReferenceExecutorConfigurationError || error instanceof ReferenceExecutorStartupError ? (error.message.split('\n')[0] ?? '') : 'startup failed';
  return JSON.stringify({ event: 'refused-to-start', code, message });
}
