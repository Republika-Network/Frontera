import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createActionEnforcementPolicyPackIntegration } from '../../features/domain-policy-pack-runtime/integrations/action-enforcement-policy-pack-integration.js';
import { createPolicyPackRuntimeContext } from '../../features/domain-policy-pack-runtime/runtime/policy-pack-runtime-context.js';
import { createPolicyPackRuntime } from '../../features/domain-policy-pack-runtime/services/policy-pack-runtime.js';
import { executionDestinationKey, parseExecutionDestination, type ExecutionDestination } from '../../features/destination-runtime/index.js';
import type { ExecutionAdapter } from '../../features/execution-runtime/index.js';
import type { PolicyPackProvider } from '../../kernel/index.js';
import { createDestinationApprovalAdministration, createSqliteDestinationApprovalStore, type DestinationApprovalAdministration } from '../destination-approval/index.js';
import { createSqliteDestinationRegistry } from '../destination-registry/index.js';
import { createXrplExecutionAdapter, isXrplClassicAddress, type XrplPaymentTransport } from '../execution-adapters/xrpl/index.js';
import type { GovernanceConfiguration } from '../governance-profile/index.js';
import { bootEnterpriseHost, type EnterpriseHost } from '../host/enterprise-host.js';
import { GOVERNED_ACTIONS_FILE_VARIABLE, loadEnterpriseHostConfiguration } from '../host/host-configuration.js';
import type { KernelAuthorityAccessContext } from '../kernel-authority/contracts.js';
import { createOperatorAuthenticator } from '../operator-control/operator-authenticator.js';
import {
  DESTINATION_CONTEXT_FACT_CLASSES as FACT,
  DESTINATION_POLICY_MATERIAL_FACTS,
  assertDestinationPolicyGovernance,
  createDestinationContextProvider,
  destinationApprovalPolicyRules,
} from '../trusted-context/index.js';
import { andrewXrplAdapterOptions, assertAndrewSettlement, ANDREW_TESTNET_RLUSD_SETTLEMENT, type AndrewSettlementConfiguration } from './rlusd-testnet-settlement.js';

/**
 * ANDREW-P0-07 — the Andrew demo composition.
 *
 * One function composes the whole governed path for "send USD 75,000 to a
 * wallet that was not previously approved", on the shipped Enterprise Host,
 * without changing any generic default:
 *
 * ```
 * agent (customer principal) ─► POST /v1/governed-actions
 *   ─► identity, authority & delegation (Kernel Authority, durable)
 *   ─► USD monetary constraint: P10 ceiling USD 100,000 on the treasury lineage
 *   ─► trusted destination facts (P0-04) from the P0-02 registry + P0-03 approval store
 *   ─► destination approval policy (P0-05), checked at startup by assertDestinationPolicyGovernance
 *   ─► signed bounded grant, bound to `xrpl.testnet:<address>` and the USD ceiling
 *   ─► exercise gate ─► registry ─► XRPL adapter (pinned USD → RLUSD, Testnet namespace, network label)
 *   ─► the caller's transport (P0-07: the recording transport; P0-08: the real one)
 * ```
 *
 * What it does **not** own: keys, secrets and the authority-state witness.
 * The caller supplies the Host's secure environment (`environment`), whose
 * credentials are references to secrets kept outside the repository; the
 * composition adds only the path of the governed-action file it writes. It
 * reads operator keys from that environment solely to build the destination
 * governance authenticator from the Host's own parsed configuration, and never
 * logs or returns them.
 *
 * Approval is never inferred. A destination becomes approved only through
 * `destinationGovernance.approveDestination`, authorized by the CTRL-02
 * operator plane under `destination.approve` (held by
 * `organization-administrator` alone). XRPL state — an account existing, a
 * reserve, an RLUSD trust line — is never consulted.
 */

/** The governed action and resource Andrew's agent may request. */
export const ANDREW_TRANSFER_ACTION = 'transfer-funds';
export const ANDREW_TREASURY_RESOURCE = 'treasury-operating-account';
export const ANDREW_TRANSFER_ACTION_CLASS = 'transfer';
export const ANDREW_TREASURY_RESOURCE_CLASS = 'treasury_account';
/** The registry child the transfer route selects. Recorded on every execution. */
export const ANDREW_XRPL_ADAPTER_ID = 'xrpl-testnet.treasury';
/** The authority ceiling on one transfer, in the governed unit. */
export const ANDREW_PER_TRANSFER_CEILING_USD = '100000';
/** The lifetime spending limit of the treasury lineage, in the governed unit. */
export const ANDREW_LIFETIME_LIMIT_USD = '1000000';

const POLICY_PACK_ID = 'andrew-destination-policy';
const POLICY_PACK_VERSION_ID = 'andrew-destination-policy-v1';
const POLICY_SOURCE_ID = 'andrew-demo-source';
const REGISTRY_SOURCE_ID = 'destination-registry';
const APPROVAL_SOURCE_ID = 'destination-approval';
/** The operator context Andrew's authority world is provisioned under. Never available to an evaluation. */
const PROVISIONER: KernelAuthorityAccessContext = { system: true, actorId: 'operator:andrew-demo-provisioner' };

export interface AndrewDemoOperator {
  readonly operatorId: string;
  readonly role: string;
  /** The name of the environment variable holding this operator's secret. Never the secret. */
  readonly apiKeyEnv: string;
}

export interface AndrewDemoIdentity {
  readonly trustDomainId: string;
  /** Andrew's agent: the customer principal that submits governed actions. */
  readonly agent: {
    readonly principalId: string;
    readonly externalSubject: { readonly system: string; readonly subjectId: string };
    /** The name of the environment variable holding the agent's credential. Never the credential. */
    readonly apiKeyEnv: string;
  };
  /** The CTRL-02 operators. Destination approval needs one holding `destination.approve` (an `organization-administrator`). */
  readonly operators: readonly AndrewDemoOperator[];
}

export interface AndrewDemoOptions {
  /** The demo's own state: destination registry, approval store and the generated governed-action file. */
  readonly directory: string;
  /** The Host's secure environment, supplied by the caller; secrets by reference only. */
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly identity: AndrewDemoIdentity;
  /** Where translated payments go. P0-07 passes the recording transport; nothing in the composition reaches a network. */
  readonly transport: XrplPaymentTransport;
  /** Defaults to Testnet RLUSD; anything else is refused (`assertAndrewSettlement`). */
  readonly settlement?: AndrewSettlementConfiguration;
  readonly now?: () => string;
}

export interface AndrewDemo {
  readonly host: EnterpriseHost;
  readonly baseUrl: string;
  readonly organizationId: string;
  readonly settlement: AndrewSettlementConfiguration;
  /** The canonical destination key for an XRPL Testnet address: `xrpl.testnet:<address>`. */
  destinationKey(address: string): string;
  /**
   * Register an XRPL Testnet address in the P0-02 registry. Registration is
   * not approval: a registered destination stays `never-approved`. Refuses an
   * identifier that is not a checksum-valid XRPL classic address — a technical
   * check, never a governance one.
   */
  registerDestination(address: string, registeredBy: string): ExecutionDestination;
  /** P0-03 destination governance, authorized by the CTRL-02 operator plane. */
  readonly destinationGovernance: DestinationApprovalAdministration;
  /** The governed intent body for a USD transfer from the treasury to `address`. The request names no issuer, currency code, network or mapping. */
  transferIntent(address: string, usdValue: string): { readonly action: string; readonly resource: string; readonly counterparty: string; readonly amount: { readonly value: string; readonly currency: string } };
  close(): Promise<void>;
}

function governance(organizationId: string): GovernanceConfiguration {
  return {
    parameterDimensions: [],
    actionClasses: [{ id: ANDREW_TRANSFER_ACTION_CLASS, actions: [ANDREW_TRANSFER_ACTION] }],
    resourceClasses: [{ id: ANDREW_TREASURY_RESOURCE_CLASS, resources: [ANDREW_TREASURY_RESOURCE] }],
    profiles: [
      {
        profileId: 'andrew-destination-governed-transfer',
        version: 1,
        owner: organizationId,
        provenance: { authoredBy: 'operator:andrew-demo', approvedBy: 'operator:andrew-demo-security' },
        actionClass: ANDREW_TRANSFER_ACTION_CLASS,
        resourceClass: ANDREW_TREASURY_RESOURCE_CLASS,
        parameters: [],
        materialFacts: [...DESTINATION_POLICY_MATERIAL_FACTS],
        relevantPolicies: [POLICY_PACK_ID],
      },
    ],
  };
}

function governedActionFile(organizationId: string, identity: AndrewDemoIdentity, settlement: AndrewSettlementConfiguration): Record<string, unknown> {
  return {
    version: 1,
    trustDomainId: identity.trustDomainId,
    grantLifetimeSeconds: 600,
    customerPrincipals: [{ principalId: identity.agent.principalId, externalSubject: identity.agent.externalSubject, apiKeyEnv: identity.agent.apiKeyEnv }],
    operators: identity.operators.map(({ operatorId, role, apiKeyEnv }) => ({ operatorId, role, apiKeyEnv })),
    governance: governance(organizationId),
    trustedContext: {
      maxFutureSkewSeconds: 0,
      sources: [
        { sourceId: REGISTRY_SOURCE_ID, kind: 'internal_store', name: 'Destination registry', trustClass: 'authoritative', organizationId, attests: [{ factClass: FACT.key, maxAgeSeconds: 900 }, { factClass: FACT.known, maxAgeSeconds: 900 }] },
        { sourceId: APPROVAL_SOURCE_ID, kind: 'approval_system', name: 'Destination approval', trustClass: 'authoritative', organizationId, attests: [{ factClass: FACT.approvalState, maxAgeSeconds: 900 }, { factClass: FACT.approved, maxAgeSeconds: 900 }] },
      ],
    },
    // USD is governed. EUR is a known asset only so a EUR request is withheld as an
    // asset mismatch against the USD grant, never converted, never sent as RLUSD.
    monetary: { assets: [{ assetId: settlement.governedAsset, scale: 2 }, { assetId: 'EUR', scale: 2 }], financialActions: [ANDREW_TRANSFER_ACTION] },
    routes: [{ action: ANDREW_TRANSFER_ACTION, adapterId: ANDREW_XRPL_ADAPTER_ID }],
  };
}

function destinationPolicy(): PolicyPackProvider {
  const writer = { system: true, actorId: 'operator:andrew-demo-policy' } as const;
  const runtime = createPolicyPackRuntime(createPolicyPackRuntimeContext('2026-01-01T00:00:00.000Z'));
  runtime.registerPolicyPack(writer, { id: POLICY_PACK_ID, name: 'Andrew demo destination policy', description: 'A transfer to a destination this organization has not approved is denied.', kind: 'data_boundary', domain: 'general_enterprise' });
  runtime.registerPolicyPackVersion(writer, {
    id: POLICY_PACK_VERSION_ID,
    policyPackId: POLICY_PACK_ID,
    version: '1.0.0',
    scope: { resourceScopes: [ANDREW_TREASURY_RESOURCE] },
    rules: destinationApprovalPolicyRules({ actionClass: ANDREW_TRANSFER_ACTION_CLASS, policyPackVersionId: POLICY_PACK_VERSION_ID, sourceIds: [POLICY_SOURCE_ID] }),
    sources: [{ id: POLICY_SOURCE_ID, type: 'internal_control', title: 'Andrew demo destination governance', description: 'Demonstration control: approved destinations only.', authority: 'demo_only' }],
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    demoOnly: true,
    legalCompleteness: 'not_legal_advice',
  });
  runtime.activatePolicyPackVersion(writer, POLICY_PACK_VERSION_ID);
  return createActionEnforcementPolicyPackIntegration(runtime);
}

/** Andrew's authority world, provisioned through the operator surface: an owner, the agent acting for them, and one treasury lineage capped at USD 100,000 per transfer. */
async function provisionAuthority(host: EnterpriseHost, identity: AndrewDemoIdentity): Promise<void> {
  const service = host.enterprise.kernelAuthorityProvisioning;
  if (service === undefined) throw new Error('The Andrew demo needs the durable Kernel Authority (AOC_ENTERPRISE_KERNEL_AUTHORITY_ENABLED).');
  const trustDomainId = identity.trustDomainId;
  const issuer = 'actor-andrew-organization';
  const owner = 'actor-andrew-treasurer';
  const agent = 'actor-andrew-agent';
  await service.provisionActor(PROVISIONER, { actorId: issuer, type: 'organization', displayName: 'Andrew demo organization' });
  await service.provisionTrustDomain(PROVISIONER, { trustDomainId, name: 'Andrew demo trust domain', issuerActorId: issuer, acceptedIssuerIds: [issuer], acceptedActorTypes: ['human', 'organization', 'agent'] });
  await service.provisionRootIssuer(PROVISIONER, { trustDomainId, actorId: issuer });
  await service.provisionActor(PROVISIONER, { actorId: owner, type: 'human', displayName: 'Treasurer', issuerId: issuer, trustDomainId, externalSubject: { system: 'andrew-demo', subjectId: 'treasurer' } });
  await service.provisionActor(PROVISIONER, { actorId: agent, type: 'agent', displayName: 'Treasury agent', issuerId: issuer, trustDomainId, externalSubject: identity.agent.externalSubject });
  await service.provisionPassport(PROVISIONER, { passportId: `passport-${agent}`, type: 'agent_passport', subjectActorId: agent, issuerActorId: issuer, trustDomainId });
  await service.provisionCapabilityToken(PROVISIONER, {
    capabilityTokenId: `cap-${agent}`,
    subjectActorId: agent,
    principalActorId: owner,
    issuerActorId: owner,
    trustDomainId,
    capability: 'treasury.transfer',
    actions: [ANDREW_TRANSFER_ACTION],
    resourceScopes: [ANDREW_TREASURY_RESOURCE],
    riskLevel: 'high',
  });
  await service.provisionAuthorityGrant(PROVISIONER, {
    authorityGrantId: 'authority-grant-treasury',
    issuerActorId: issuer,
    subjectActorId: owner,
    trustDomainId,
    roleId: 'role-treasurer',
    capability: 'treasury.manage',
    actions: [ANDREW_TRANSFER_ACTION],
    resourceScopes: [ANDREW_TREASURY_RESOURCE],
    canDelegate: true,
    allowedDelegateActorTypes: ['agent'],
    maxDelegationDepth: 1,
    constraints: [
      { type: 'max_amount', currency: 'USD', value: ANDREW_PER_TRANSFER_CEILING_USD },
      { type: 'spending_limit', limitId: 'treasury-lifetime', currency: 'USD', maximum: ANDREW_LIFETIME_LIMIT_USD, window: { kind: 'lifetime' } },
    ],
  });
  await service.provisionDelegationGrant(PROVISIONER, {
    delegationGrantId: 'delegation-treasury-agent',
    delegatorActorId: owner,
    delegateActorId: agent,
    delegateActorType: 'agent',
    trustDomainId,
    sourceAuthorityGrantId: 'authority-grant-treasury',
    capability: 'treasury.transfer',
    actions: [ANDREW_TRANSFER_ACTION],
    resourceScopes: [ANDREW_TREASURY_RESOURCE],
    canRedelegate: false,
  });
}

export async function composeAndrewDemo(options: AndrewDemoOptions): Promise<AndrewDemo> {
  // 1. Settlement first: drifted configuration refuses before anything opens.
  const settlement = assertAndrewSettlement(options.settlement ?? ANDREW_TESTNET_RLUSD_SETTLEMENT);
  const now = options.now ?? (() => new Date().toISOString());

  // 2. The Host's own configuration, parsed exactly as the Host will parse it.
  const filePath = join(options.directory, 'andrew-governed-actions.json');
  const environment: Record<string, string | undefined> = Object.defineProperties({}, Object.getOwnPropertyDescriptors(options.environment)) as Record<string, string | undefined>;
  environment[GOVERNED_ACTIONS_FILE_VARIABLE] = filePath;
  const organizationId = environment['AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID'];
  if (organizationId === undefined || organizationId.length === 0) throw new Error('The Andrew demo needs AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID in the Host environment.');
  writeFileSync(filePath, JSON.stringify(governedActionFile(organizationId, options.identity, settlement), null, 2));
  const hostConfiguration = loadEnterpriseHostConfiguration(environment).configuration;

  // 3. Destination governance stores and the trusted provider over them.
  const registry = await createSqliteDestinationRegistry(join(options.directory, 'destination-registry.sqlite'), { now });
  const approvals = await createSqliteDestinationApprovalStore(join(options.directory, 'destination-approval.sqlite'), { now, registry });
  const contextProvider = createDestinationContextProvider({ organizationId, sourceIds: { registry: REGISTRY_SOURCE_ID, approval: APPROVAL_SOURCE_ID }, registry, approvals });
  assertDestinationPolicyGovernance(governance(organizationId), ANDREW_TRANSFER_ACTION_CLASS);

  // 4. The rail: pinned USD → RLUSD, Testnet namespace, network label, the caller's transport.
  const xrplAdapter: ExecutionAdapter = createXrplExecutionAdapter(andrewXrplAdapterOptions(ANDREW_XRPL_ADAPTER_ID, settlement), options.transport);

  let host: EnterpriseHost;
  try {
    host = await bootEnterpriseHost({ env: environment, executionAdapters: [xrplAdapter], contextProvider, policyPackProvider: destinationPolicy() });
  } catch (error) {
    await approvals.close();
    await registry.close();
    throw error;
  }
  let open = true;
  const { port } = await host.listen();
  await provisionAuthority(host, options.identity);

  // 5. Destination governance on the CTRL-02 operator plane, from the same parsed operators the Host serves.
  const authenticator = createOperatorAuthenticator({
    administrators: hostConfiguration.administration?.administrators ?? [],
    operators: hostConfiguration.administration?.operators ?? [],
    ordinaryCredentials: hostConfiguration.authentication.apiKeys,
    organizationId,
    isReady: () => open,
    lifecycleState: () => (open ? 'ready' : 'stopped'),
  });
  const destinationGovernance = createDestinationApprovalAdministration({ authenticator, store: approvals });

  const destinationOf = (address: string): ExecutionDestination => {
    const parsed = parseExecutionDestination({ namespace: settlement.destinationNamespace, identifier: address });
    if (!parsed.valid || !isXrplClassicAddress(address)) throw new Error('Not an XRPL classic address.');
    return parsed.destination;
  };

  return Object.freeze({
    host,
    baseUrl: `http://127.0.0.1:${port}`,
    organizationId,
    settlement,
    destinationKey: (address: string) => executionDestinationKey(destinationOf(address)),
    registerDestination(address: string, registeredBy: string) {
      const destination = destinationOf(address);
      registry.register({ destination, registeredBy });
      return destination;
    },
    destinationGovernance,
    transferIntent: (address: string, usdValue: string) => ({
      action: ANDREW_TRANSFER_ACTION,
      resource: ANDREW_TREASURY_RESOURCE,
      counterparty: executionDestinationKey(destinationOf(address)),
      amount: { value: usdValue, currency: settlement.governedAsset },
    }),
    async close() {
      if (!open) return;
      open = false;
      await host.close();
      await approvals.close();
      await registry.close();
    },
  });
}
