import { executionIdForGrant } from '../authority-authenticity/index.js';
import type { ExecutionAdapterResult, ValidatedExecutionAction } from '../../features/execution-runtime/index.js';
import type { GovernedParameter } from '../../features/governed-parameter-runtime/index.js';
import { createEmergencyControlReader, createInMemoryEmergencyControlStore } from '../../features/emergency-control-runtime/index.js';
import type { EnterpriseGenericHttpExecutionAdapterOptions } from '../execution-adapters/generic-http/contracts.js';
import { snapshotGenericHttpOptions, type GenericHttpPlan } from '../execution-adapters/generic-http/configuration.js';
import { createGenericHttpExecutionAdapterCore, type GenericHttpPreSendGate } from '../execution-adapters/generic-http/generic-http-execution-adapter.js';
import type { GenericHttpNetworkRuntime } from '../execution-adapters/generic-http/node-https-transport.js';
import type { GenericHttpWireRequest } from '../execution-adapters/generic-http/request-mapper.js';
import { createExecutionCapabilityGate, type ExecutionCapabilityGate } from '../execution-capability-gate/index.js';
import { createExecutionCapabilityIssuer, type ExecutionCapabilityIssuanceLedger, type ExecutionCapabilityIssuer, type ExecutionCapabilitySignedGrantReader } from '../execution-capability-issuance/index.js';
import type { AuthorityArtifactSigner } from '../authority-authenticity/index.js';
import { AUTHORITY_KEY_A, testVerifier, trustedKeyOf, type TestAuthorityKey } from './authority-authenticity-fixture.js';
import { G02B_AUDIENCE, G02B_ORGANIZATION, NOW, POLICY, custodySigner, type SignedGrant } from './g02b-execution-capability-issuance-fixture.js';

/**
 * G-02C0 fixtures — test-only, offline. A Generic HTTP adapter core over a
 * counting fake network (no socket, no DNS), gated by the real G-02C0 gate over
 * the real G-02B issuer, software custody and a real SQLite issuance ledger.
 * Grants are real Ed25519-signed governed-path-shaped grants (G-02B fixture).
 */

export const GATED_ADAPTER_ID = 'devops.deployment-gateway';
export const CREDENTIAL_TOKEN = 'G02C0BearerSentinel0123456789abcdef';

export const TYPED_PARAMETERS: readonly GovernedParameter[] = Object.freeze([
  Object.freeze({ dimension: 'replicaCount', type: 'integer', value: 4 } as GovernedParameter),
  Object.freeze({ dimension: 'strategy', type: 'token', value: 'rolling' } as GovernedParameter),
]);

/** One pinned integration that reads every kind of governed value: resource (path), execution id (header), amount, counterparty and two typed parameters (body). */
export function gatedOptions(overrides: Record<string, unknown> = {}): EnterpriseGenericHttpExecutionAdapterOptions {
  return {
    adapterId: GATED_ADAPTER_ID,
    origin: 'https://api.devops.example',
    method: 'POST',
    path: [{ kind: 'literal', value: 'v1' }, { kind: 'literal', value: 'deployments' }, { kind: 'source', source: 'resource' }],
    query: { strategy: { kind: 'parameter', dimension: 'strategy' } },
    headers: { 'Idempotency-Key': { kind: 'source', source: 'correlation.executionId' }, 'X-Counterparty': { kind: 'source', source: 'counterparty' } },
    body: {
      kind: 'json-object',
      fields: {
        subject: { kind: 'source', source: 'subject' },
        amount: { kind: 'source', source: 'amount.value' },
        currency: { kind: 'source', source: 'amount.unit' },
        replicas: { kind: 'parameter', dimension: 'replicaCount' },
      },
    },
    credential: { kind: 'bearer', token: CREDENTIAL_TOKEN },
    providerRefHeader: 'x-request-id',
    timeoutMs: 1000,
    ...overrides,
  } as EnterpriseGenericHttpExecutionAdapterOptions;
}

export function gatedPlan(overrides: Record<string, unknown> = {}): GenericHttpPlan {
  return snapshotGenericHttpOptions(gatedOptions(overrides));
}

/** The validated action the exercise gate would hand down for `signed`'s grant. */
export function actionFor(signed: Pick<SignedGrant, 'grant'>, overrides: Partial<Record<keyof ValidatedExecutionAction, unknown>> = {}): ValidatedExecutionAction {
  const grant = signed.grant;
  return Object.freeze({
    boundedGrantId: grant.id,
    subject: grant.subject,
    action: grant.correlation.action,
    resource: grant.correlation.resourceScope,
    counterparty: 'vendor-0042',
    organization: G02B_ORGANIZATION,
    amount: Object.freeze({ value: '7500', unit: 'USD' }),
    parameters: TYPED_PARAMETERS,
    notAfter: grant.expiresAt,
    correlation: Object.freeze({ requestId: grant.correlation.requestId, decisionId: grant.correlation.decisionId, executionId: executionIdForGrant(grant) }),
    ...overrides,
  } as unknown as ValidatedExecutionAction);
}

/** A counting network runtime: resolves to one public address and answers every send with `status`. Never a socket. */
export interface CountingNetwork extends GenericHttpNetworkRuntime {
  readonly resolved: string[];
  readonly sent: GenericHttpWireRequest[];
  /** Called once per resolution, before it answers — the first await after the gate. */
  onResolve?: () => void;
}

export function countingNetwork(status = 201): CountingNetwork {
  const network: CountingNetwork = {
    resolved: [],
    sent: [],
    async resolve(hostname) {
      network.resolved.push(hostname);
      network.onResolve?.();
      return { kind: 'resolved', answers: [{ address: '93.184.216.34', family: 4 }] };
    },
    async send(request) {
      network.sent.push(request);
      return { kind: 'response', status, providerRefValues: ['prov-g02c0'] };
    },
  };
  return network;
}

export interface GateWorld {
  readonly gate: ExecutionCapabilityGate;
  readonly issuer: ExecutionCapabilityIssuer;
  readonly network: CountingNetwork;
  readonly emergency: ReturnType<typeof createInMemoryEmergencyControlStore>;
  readonly ledger: ExecutionCapabilityIssuanceLedger;
  execute(action: ValidatedExecutionAction): Promise<ExecutionAdapterResult>;
}

export interface GateWorldOptions {
  readonly grants: ExecutionCapabilitySignedGrantReader;
  readonly ledger: ExecutionCapabilityIssuanceLedger;
  readonly signer?: AuthorityArtifactSigner;
  /** Replaces the real issuer — a defective or compromised in-process issuer. */
  readonly issuer?: ExecutionCapabilityIssuer;
  readonly audience?: string;
  readonly issuerKey?: TestAuthorityKey;
  readonly now?: () => number;
  readonly status?: number;
  readonly planOverrides?: Record<string, unknown>;
  readonly bind?: false;
  readonly withEmergencyControl?: false;
}

export function gateWorld(options: GateWorldOptions): GateWorld {
  const now = options.now ?? (() => NOW);
  const issuer = options.issuer ?? createExecutionCapabilityIssuer({ grants: options.grants, signer: options.signer ?? custodySigner(), verifier: testVerifier([AUTHORITY_KEY_A]), policy: POLICY, ledger: options.ledger, now });
  const gate = createExecutionCapabilityGate({ adapterId: GATED_ADAPTER_ID, audience: options.audience ?? G02B_AUDIENCE, policy: POLICY, issuer, clock: now });
  const emergency = createInMemoryEmergencyControlStore();
  if (options.bind !== false) gate.bind({ issuerKey: trustedKeyOf(options.issuerKey ?? AUTHORITY_KEY_A), emergencyControl: options.withEmergencyControl === false ? undefined : createEmergencyControlReader(emergency) });
  const network = countingNetwork(options.status);
  const adapter = createGenericHttpExecutionAdapterCore(gatedPlan(options.planOverrides), network, gate.beforeSend);
  return { gate, issuer, network, emergency, ledger: options.ledger, execute: (action) => adapter.execute(action) };
}

/** A gate that records what it was shown and answers `verdict`. */
export function recordingGate(verdict: unknown | (() => unknown)): { readonly gate: GenericHttpPreSendGate; readonly seen: Parameters<GenericHttpPreSendGate>[0][] } {
  const seen: Parameters<GenericHttpPreSendGate>[0][] = [];
  const gate = (async (subject: Parameters<GenericHttpPreSendGate>[0]) => {
    seen.push(subject);
    return typeof verdict === 'function' ? (verdict as () => unknown)() : verdict;
  }) as GenericHttpPreSendGate;
  return { gate, seen };
}
