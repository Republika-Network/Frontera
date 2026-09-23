import {
  boundedGrantDigest,
  boundedGrantId,
  type BoundedGrant,
  type GrantCorrelation,
  type GrantScope,
} from '../../grant-runtime/index.js';
import type { ExecutionAdapter, ExecutionAdapterResult, GrantExerciseRequest, ValidatedExecutionAction } from '../index.js';

/**
 * A fake provider, and deliberately only a fake.
 *
 * It lives under `tests/` rather than in the module's production sources
 * because a no-op adapter shipped as production code is an execution path
 * nobody chose. What is being proved here is the *boundary* — that nothing
 * crosses it without a grant, and that exactly what crosses it is a validated
 * action — and a recorder proves that more sharply than a real provider would.
 *
 * It records every call so a test can assert the invocation **count**, which is
 * the property that actually matters: `0` for every blocked case and `1` for a
 * valid exercise.
 */
export interface RecordingExecutionAdapter extends ExecutionAdapter {
  readonly calls: readonly ValidatedExecutionAction[];
  readonly callCount: number;
}

export function createRecordingExecutionAdapter(
  behaviour: (action: ValidatedExecutionAction) => ExecutionAdapterResult | Promise<ExecutionAdapterResult> = () => ({ outcome: 'completed', providerRef: 'provider-ref-1' }),
): RecordingExecutionAdapter {
  const calls: ValidatedExecutionAction[] = [];
  return {
    adapterId: 'test.fake-provider',
    calls,
    get callCount(): number {
      return calls.length;
    },
    async execute(action: ValidatedExecutionAction): Promise<ExecutionAdapterResult> {
      calls.push(action);
      return behaviour(action);
    },
  };
}

export const TEST_CORRELATION: GrantCorrelation = {
  requestId: 'req-exec-1',
  decisionId: 'decision-exec-1',
  action: 'payment',
  resourceScope: 'vendor/V123',
};

export const TEST_ISSUED_AT = '2026-01-01T12:00:00.000Z';
export const TEST_EXPIRES_AT = '2026-01-01T12:10:00.000Z';

export const TEST_SCOPE: GrantScope = {
  action: { kind: 'identity', value: 'payment' },
  amount: { kind: 'ceiling', limit: '7500', unit: 'USD' },
  counterparty: { kind: 'identity', value: 'V123' },
  organization: { kind: 'identity', value: 'org-acme' },
  resources: { kind: 'set', values: ['vendor/V123'] },
};

/**
 * A grant built the way issuance builds one — deterministic id, digest over the
 * canonical form — so a test measures the artifact the real path produces
 * rather than a hand-written lookalike whose digest happens to match.
 */
export function buildTestGrant(overrides: Partial<Omit<BoundedGrant, 'id' | 'digest'>> = {}): BoundedGrant {
  const correlation = overrides.correlation ?? TEST_CORRELATION;
  const subject = overrides.subject ?? 'agent-A';
  const scope = overrides.scope ?? TEST_SCOPE;
  const expiresAt = overrides.expiresAt ?? TEST_EXPIRES_AT;
  const provenance = overrides.authorityBindingDigest !== undefined ? { authorityBindingDigest: overrides.authorityBindingDigest } : {};
  const withoutDigest = {
    id: boundedGrantId({ correlation, subject, scope, expiresAt, ...provenance }),
    ...provenance,
    correlation,
    subject,
    scope,
    issuedAt: overrides.issuedAt ?? TEST_ISSUED_AT,
    expiresAt,
    sourceDigest: overrides.sourceDigest ?? 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
  };
  return { ...withoutDigest, digest: boundedGrantDigest(withoutDigest) };
}

/**
 * `Partial` is not enough here, and `exactOptionalPropertyTypes` is why: a test
 * for "the attempt states no counterparty" has to be able to *remove* an
 * optional field, which `Partial` can only express as `undefined` — a value
 * the real type refuses. The three removable axes are therefore named
 * explicitly, so a test says `omitCounterparty: true` instead of smuggling an
 * `undefined` past a cast.
 */
export interface ExerciseRequestOverrides {
  readonly boundedGrantId?: string;
  readonly subject?: string;
  readonly action?: string;
  readonly resource?: string;
  readonly counterparty?: string;
  readonly organization?: string;
  readonly amount?: { readonly value: string; readonly unit: string };
  readonly correlation?: GrantCorrelation;
  readonly executionId?: string;
  readonly omitCounterparty?: boolean;
  readonly omitOrganization?: boolean;
  readonly omitAmount?: boolean;
}

export function buildExerciseRequest(grant: BoundedGrant, overrides: ExerciseRequestOverrides = {}): GrantExerciseRequest {
  const counterparty = overrides.counterparty ?? 'V123';
  const organization = overrides.organization ?? 'org-acme';
  const amount = overrides.amount ?? { value: '7500', unit: 'USD' };
  return {
    boundedGrantId: overrides.boundedGrantId ?? grant.id,
    subject: overrides.subject ?? 'agent-A',
    action: overrides.action ?? 'payment',
    resource: overrides.resource ?? 'vendor/V123',
    ...(overrides.omitCounterparty === true ? {} : { counterparty }),
    ...(overrides.omitOrganization === true ? {} : { organization }),
    ...(overrides.omitAmount === true ? {} : { amount }),
    correlation: overrides.correlation ?? TEST_CORRELATION,
    executionId: overrides.executionId ?? 'exec-1',
  };
}
