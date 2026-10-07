/**
 * Every request-scoped log line the mission requires: correlation id,
 * request id, decision id, evaluation duration, kernel version, enterprise
 * version, status. Never logs secrets/tokens/raw context -- callers pass
 * only the closed set of fields below, so there is no code path that could
 * accidentally log a bearer token or a raw `context` payload.
 */
export interface EnterpriseLogContext {
  readonly correlationId?: string;
  readonly requestId?: string;
  readonly decisionId?: string;
  /** PR-004 Governance Store fields: the appended aggregate's identity and append outcome. Still a closed set -- never payloads, never raw context. */
  readonly evaluationId?: string;
  readonly created?: boolean;
  readonly idempotentReplay?: boolean;
  readonly errorCode?: string;
  readonly durationMs?: number;
  readonly kernelVersion?: string;
  readonly enterpriseVersion?: string;
  readonly status?: string;
  readonly route?: string;
  readonly httpStatus?: number;
  /** PR-007 Assurance Runtime fields (mission section 71). Still a closed set -- ids, statuses, and scores only; never evidence payloads, Bundles, Passport details, or secrets. */
  readonly assessmentId?: string;
  readonly frameworkId?: string;
  readonly frameworkVersion?: string;
  readonly subjectId?: string;
  readonly subjectType?: string;
  readonly organizationId?: string;
  readonly controlId?: string;
  readonly domainId?: string;
  readonly findingId?: string;
  readonly severity?: string;
  readonly normalizedScore?: number;
  readonly findingCount?: number;
  readonly evaluatorVersion?: string;
  /** CTRL-01 authority administration fields. The trusted operator id (from configuration, never a request), the operation, and the target's canonical id. Never a credential. */
  readonly operatorId?: string;
  readonly operation?: string;
  readonly target?: string;
  /** PROD-03-01 governed-path fields (`operations/governed-path-log.ts`). Still closed: identities, closed states and reason codes only — never an amount, a parameter, an adapter or provider reference, a payload or a credential. */
  readonly executionId?: string;
  readonly operationalState?: string;
  readonly reasonCodes?: readonly string[];
  readonly withheldBy?: string;
  readonly outcome?: string;
  readonly outcomeRecorded?: boolean;
  readonly attentionRequired?: boolean;
}

export type EnterpriseLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface EnterpriseLogger {
  debug(message: string, fields?: EnterpriseLogContext): void;
  info(message: string, fields?: EnterpriseLogContext): void;
  warn(message: string, fields?: EnterpriseLogContext): void;
  error(message: string, fields?: EnterpriseLogContext): void;
}

const LEVEL_RANK: Readonly<Record<EnterpriseLogLevel, number>> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface EnterpriseLoggerSink {
  write(line: string): void;
}

const consoleSink: EnterpriseLoggerSink = {
  write(line) {
    console.log(line);
  },
};

export function createEnterpriseLogger(minLevel: EnterpriseLogLevel = 'info', sink: EnterpriseLoggerSink = consoleSink): EnterpriseLogger {
  function emit(level: EnterpriseLogLevel, message: string, fields?: EnterpriseLogContext): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[minLevel]) return;
    const entry = {
      level,
      message,
      timestamp: new Date().toISOString(),
      ...fields,
    };
    sink.write(JSON.stringify(entry));
  }

  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
  };
}
