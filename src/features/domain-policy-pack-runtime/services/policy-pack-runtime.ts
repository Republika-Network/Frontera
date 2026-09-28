import type { PolicyPack, PolicyPackDomain, PolicyPackKind } from '../domain/policy-pack.js';
import type { PolicyPackLegalCompleteness, PolicyPackVersion } from '../domain/policy-pack-version.js';
import type { PolicyPackScope } from '../domain/policy-pack-scope.js';
import type { PolicyPackRule } from '../domain/policy-pack-rule.js';
import type { PolicyPackSource } from '../domain/policy-pack-source.js';
import type { PolicyEvaluationInput, PolicyPackEvaluationResult } from '../domain/policy-pack-evaluation.js';
import type { PolicyPackDecision } from '../domain/policy-pack-decision.js';
import type { PolicyPackProof } from '../domain/policy-pack-proof.js';
import type { PolicyPackEvent } from '../domain/policy-pack-event.js';
import type { PolicyPackSimulationInput, PolicyPackSimulationResult } from '../domain/policy-pack-simulation.js';
import type { PolicyPackRuntimeContext } from '../runtime/policy-pack-runtime-context.js';
import type { PolicyPackWriterContext } from '../domain/policy-pack-writer.js';
import { PolicyPackDecisionNotFoundError, PolicyPackProofNotFoundError } from '../runtime/policy-pack-runtime-errors.js';
import { PolicyPackStore } from './policy-pack-store.js';
import { PolicyPackLedger } from './policy-pack-ledger.js';
import { PolicyPackRegistry, type RegisterPolicyPackInput, type RegisterPolicyPackVersionInput } from './policy-pack-registry.js';
import { PolicyPackEvaluationService } from './policy-pack-evaluation-service.js';
import { PolicyPackSimulationService } from './policy-pack-simulation-service.js';

export type { RegisterPolicyPackInput, RegisterPolicyPackVersionInput } from './policy-pack-registry.js';

export interface RegisterPolicyPackVersionParams {
  readonly id: string;
  readonly policyPackId: string;
  readonly version: string;
  readonly scope: PolicyPackScope;
  readonly rules: readonly PolicyPackRule[];
  readonly sources: readonly PolicyPackSource[];
  readonly effectiveFrom: string;
  readonly effectiveUntil?: string;
  readonly supersedesVersionId?: string;
  readonly demoOnly: boolean;
  readonly legalCompleteness: PolicyPackLegalCompleteness;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface RegisterPolicyPackParams {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly kind: PolicyPackKind;
  readonly domain: PolicyPackDomain;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * The read-only view of the runtime's store that callers get. Packs,
 * versions, evaluations, decisions, proofs and events can be read; nothing can
 * be written through it (NB-008).
 */
export type PolicyPackStoreReader = Pick<
  PolicyPackStore,
  | 'getPack'
  | 'hasPack'
  | 'listPacks'
  | 'listActivePacks'
  | 'getVersion'
  | 'hasVersion'
  | 'listVersions'
  | 'listVersionsByPack'
  | 'listActiveVersions'
  | 'listVersionsByDomain'
  | 'listVersionsByJurisdiction'
  | 'listVersionsByCountry'
  | 'getEvaluation'
  | 'listEvaluations'
  | 'getDecision'
  | 'getDecisionByInput'
  | 'listDecisions'
  | 'getProof'
  | 'getProofByDecision'
  | 'getProofByEvaluation'
  | 'getLatestProof'
  | 'getLatestEvent'
  | 'getEvents'
>;

function storeReader(store: PolicyPackStore): PolicyPackStoreReader {
  return Object.freeze({
    getPack: (id: string) => store.getPack(id),
    hasPack: (id: string) => store.hasPack(id),
    listPacks: () => store.listPacks(),
    listActivePacks: () => store.listActivePacks(),
    getVersion: (id: string) => store.getVersion(id),
    hasVersion: (id: string) => store.hasVersion(id),
    listVersions: () => store.listVersions(),
    listVersionsByPack: (id: string) => store.listVersionsByPack(id),
    listActiveVersions: () => store.listActiveVersions(),
    listVersionsByDomain: (domain: string) => store.listVersionsByDomain(domain),
    listVersionsByJurisdiction: (jurisdiction: string) => store.listVersionsByJurisdiction(jurisdiction),
    listVersionsByCountry: (country: string) => store.listVersionsByCountry(country),
    getEvaluation: (id: string) => store.getEvaluation(id),
    listEvaluations: (filter?: Parameters<PolicyPackStore['listEvaluations']>[0]) => store.listEvaluations(filter),
    getDecision: (id: string) => store.getDecision(id),
    getDecisionByInput: (id: string) => store.getDecisionByInput(id),
    listDecisions: () => store.listDecisions(),
    getProof: (id: string) => store.getProof(id),
    getProofByDecision: (id: string) => store.getProofByDecision(id),
    getProofByEvaluation: (id: string) => store.getProofByEvaluation(id),
    getLatestProof: () => store.getLatestProof(),
    getLatestEvent: () => store.getLatestEvent(),
    getEvents: () => store.getEvents(),
  });
}

/**
 * Single composition root for the Domain Policy Pack Runtime. Wires
 * PolicyPackStore, PolicyPackLedger, PolicyPackRegistry,
 * PolicyPackEvaluationService and PolicyPackSimulationService together and
 * exposes the small, stable API surface other Soberanía runtimes and the demo/
 * control-plane adapters are expected to call.
 *
 * NB-008 (closed by CORE-03): the authoritative store and registry are
 * private (`#`), so the only way to change policy through a runtime is a
 * writer-first method below, which refuses without a trusted
 * `PolicyPackWriterContext`, records the writer, and stops working after
 * `freeze`. `store` is a frozen read-only facade.
 */
export class PolicyPackRuntime {
  readonly store: PolicyPackStoreReader;
  readonly ledger: PolicyPackLedger;
  readonly #store: PolicyPackStore;
  readonly #registry: PolicyPackRegistry;
  private readonly evaluationService: PolicyPackEvaluationService;
  private readonly simulationService: PolicyPackSimulationService;

  constructor(private readonly ctx: PolicyPackRuntimeContext) {
    this.#store = new PolicyPackStore();
    this.store = storeReader(this.#store);
    this.ledger = new PolicyPackLedger(ctx, this.#store);
    this.#registry = new PolicyPackRegistry(ctx, this.#store, this.ledger);
    this.evaluationService = new PolicyPackEvaluationService(ctx, this.#store, this.ledger);
    this.simulationService = new PolicyPackSimulationService(ctx, this.#store, this.ledger);
  }

  registerPolicyPack(writer: PolicyPackWriterContext, input: RegisterPolicyPackParams): PolicyPack {
    return this.#registry.registerPolicyPack(writer, input satisfies RegisterPolicyPackInput);
  }

  registerPolicyPackVersion(writer: PolicyPackWriterContext, input: RegisterPolicyPackVersionParams): PolicyPackVersion {
    return this.#registry.registerPolicyPackVersion(writer, input satisfies RegisterPolicyPackVersionInput);
  }

  activatePolicyPackVersion(writer: PolicyPackWriterContext, policyPackVersionId: string): PolicyPackVersion {
    return this.#registry.activatePolicyPackVersion(writer, policyPackVersionId);
  }

  deprecatePolicyPackVersion(writer: PolicyPackWriterContext, policyPackVersionId: string): PolicyPackVersion {
    return this.#registry.deprecatePolicyPackVersion(writer, policyPackVersionId);
  }

  revokePolicyPackVersion(writer: PolicyPackWriterContext, policyPackVersionId: string): PolicyPackVersion {
    return this.#registry.revokePolicyPackVersion(writer, policyPackVersionId);
  }

  /** NB-008: irreversibly make policy read-only for this runtime — the policy-pack counterpart of freezing the assurance registry before traffic. */
  freeze(writer: PolicyPackWriterContext): void {
    this.#registry.freeze(writer);
  }

  isFrozen(): boolean {
    return this.#registry.isFrozen();
  }

  evaluatePolicy(input: PolicyEvaluationInput): PolicyPackEvaluationResult {
    return this.evaluationService.evaluate(input);
  }

  simulatePolicyPack(input: PolicyPackSimulationInput): PolicyPackSimulationResult {
    return this.simulationService.simulate(input);
  }

  getPolicyPackDecision(decisionId: string): PolicyPackDecision {
    const decision = this.#store.getDecision(decisionId);
    if (!decision) {
      throw new PolicyPackDecisionNotFoundError(decisionId);
    }
    return decision;
  }

  getPolicyPackProof(proofId: string): PolicyPackProof {
    const proof = this.#store.getProof(proofId);
    if (!proof) {
      throw new PolicyPackProofNotFoundError(proofId);
    }
    return proof;
  }

  getPolicyPackTrail(evaluationId: string): readonly PolicyPackEvent[] {
    return this.ledger.getTrailByEvaluation(evaluationId);
  }

  listActivePolicyPacks(): readonly PolicyPack[] {
    return this.#registry.listActivePacks();
  }

  listActivePolicyPackVersions(): readonly PolicyPackVersion[] {
    return this.#registry.listActiveVersions();
  }
}

export function createPolicyPackRuntime(ctx: PolicyPackRuntimeContext): PolicyPackRuntime {
  return new PolicyPackRuntime(ctx);
}
