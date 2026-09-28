import type { PolicyPack, PolicyPackStatus } from '../domain/policy-pack.js';
import type { PolicyPackVersion, PolicyPackVersionStatus } from '../domain/policy-pack-version.js';
import type { PolicyPackEvaluationResult } from '../domain/policy-pack-evaluation.js';
import type { PolicyPackDecision } from '../domain/policy-pack-decision.js';
import type { PolicyPackProof } from '../domain/policy-pack-proof.js';
import type { PolicyPackEvent } from '../domain/policy-pack-event.js';
import { PolicyPackWriteRefusedError } from '../runtime/policy-pack-runtime-errors.js';

export interface PolicyPackEvaluationFilter {
  readonly actorId?: string;
  readonly action?: string;
  readonly trustDomainId?: string;
}

/**
 * Single source of truth for policy pack records. Higher-level services
 * (registry, ledger, proof service, evaluation service) read the latest
 * persisted record here to compute deterministic ordering/hash chains, then
 * write their result back through this store -- the store never computes
 * hashes or business rules itself.
 */
export class PolicyPackStore {
  private readonly packs = new Map<string, PolicyPack>();
  private readonly versions = new Map<string, PolicyPackVersion>();
  private readonly evaluations = new Map<string, PolicyPackEvaluationResult>();
  private readonly decisions = new Map<string, PolicyPackDecision>();
  private readonly proofs = new Map<string, PolicyPackProof>();
  private readonly events: PolicyPackEvent[] = [];
  #authorityFrozen = false;

  /**
   * NB-008: make the policy half of this store (packs and versions) read-only,
   * irreversibly. Called by the registry's `freeze`; evaluations, decisions,
   * proofs and events stay writable, because they record what policy did
   * rather than change what it is.
   */
  freezeAuthority(): void {
    this.#authorityFrozen = true;
  }

  get authorityFrozen(): boolean {
    return this.#authorityFrozen;
  }

  private assertAuthorityWritable(): void {
    if (this.#authorityFrozen) throw new PolicyPackWriteRefusedError('POLICY_PACK_REGISTRY_FROZEN', 'The policy-pack store is frozen: packs and versions are read-only.');
  }

  savePack(pack: PolicyPack): PolicyPack {
    this.assertAuthorityWritable();
    this.packs.set(pack.id, pack);
    return pack;
  }

  getPack(policyPackId: string): PolicyPack | undefined {
    return this.packs.get(policyPackId);
  }

  hasPack(policyPackId: string): boolean {
    return this.packs.has(policyPackId);
  }

  updatePackStatus(policyPackId: string, status: PolicyPackStatus, updatedAt: string): PolicyPack | undefined {
    this.assertAuthorityWritable();
    const existing = this.packs.get(policyPackId);
    if (!existing) {
      return undefined;
    }
    const updated: PolicyPack = { ...existing, status, updatedAt };
    this.packs.set(policyPackId, updated);
    return updated;
  }

  listPacks(): readonly PolicyPack[] {
    return [...this.packs.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  listActivePacks(): readonly PolicyPack[] {
    return this.listPacks().filter((pack) => pack.status === 'active');
  }

  saveVersion(version: PolicyPackVersion): PolicyPackVersion {
    this.assertAuthorityWritable();
    this.versions.set(version.id, version);
    return version;
  }

  getVersion(policyPackVersionId: string): PolicyPackVersion | undefined {
    return this.versions.get(policyPackVersionId);
  }

  hasVersion(policyPackVersionId: string): boolean {
    return this.versions.has(policyPackVersionId);
  }

  updateVersionStatus(policyPackVersionId: string, status: PolicyPackVersionStatus, updatedAt: string, changedBy?: string): PolicyPackVersion | undefined {
    this.assertAuthorityWritable();
    const existing = this.versions.get(policyPackVersionId);
    if (!existing) {
      return undefined;
    }
    const updated: PolicyPackVersion = { ...existing, status, updatedAt, ...(changedBy !== undefined ? { statusChangedBy: changedBy } : {}) };
    this.versions.set(policyPackVersionId, updated);
    return updated;
  }

  listVersions(): readonly PolicyPackVersion[] {
    return [...this.versions.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  listVersionsByPack(policyPackId: string): readonly PolicyPackVersion[] {
    return this.listVersions().filter((version) => version.policyPackId === policyPackId);
  }

  listActiveVersions(): readonly PolicyPackVersion[] {
    return this.listVersions().filter((version) => version.status === 'active');
  }

  listVersionsByDomain(domain: string): readonly PolicyPackVersion[] {
    return this.listActiveVersions().filter((version) => {
      const pack = this.packs.get(version.policyPackId);
      return pack !== undefined && pack.domain === domain;
    });
  }

  listVersionsByJurisdiction(jurisdiction: string): readonly PolicyPackVersion[] {
    return this.listActiveVersions().filter((version) => (version.scope.jurisdictions ?? []).includes(jurisdiction));
  }

  listVersionsByCountry(country: string): readonly PolicyPackVersion[] {
    return this.listActiveVersions().filter((version) => (version.scope.countries ?? []).includes(country));
  }

  saveEvaluation(evaluation: PolicyPackEvaluationResult): PolicyPackEvaluationResult {
    this.evaluations.set(evaluation.id, evaluation);
    return evaluation;
  }

  getEvaluation(evaluationId: string): PolicyPackEvaluationResult | undefined {
    return this.evaluations.get(evaluationId);
  }

  listEvaluations(filter?: PolicyPackEvaluationFilter): readonly PolicyPackEvaluationResult[] {
    const all = [...this.evaluations.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (!filter) {
      return all;
    }
    return all.filter(
      (evaluation) =>
        (filter.actorId === undefined || evaluation.input.actorId === filter.actorId) &&
        (filter.action === undefined || evaluation.input.action === filter.action) &&
        (filter.trustDomainId === undefined || evaluation.input.trustDomainId === filter.trustDomainId),
    );
  }

  saveDecision(decision: PolicyPackDecision): PolicyPackDecision {
    this.decisions.set(decision.id, decision);
    return decision;
  }

  getDecision(decisionId: string): PolicyPackDecision | undefined {
    return this.decisions.get(decisionId);
  }

  getDecisionByInput(inputId: string): PolicyPackDecision | undefined {
    return [...this.decisions.values()].find((decision) => decision.inputId === inputId);
  }

  listDecisions(): readonly PolicyPackDecision[] {
    return [...this.decisions.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  saveProof(proof: PolicyPackProof): PolicyPackProof {
    this.proofs.set(proof.id, proof);
    return proof;
  }

  getProof(proofId: string): PolicyPackProof | undefined {
    return this.proofs.get(proofId);
  }

  getProofByDecision(decisionId: string): PolicyPackProof | undefined {
    return [...this.proofs.values()].find((proof) => proof.decisionId === decisionId);
  }

  getProofByEvaluation(evaluationId: string): PolicyPackProof | undefined {
    return [...this.proofs.values()].find((proof) => proof.evaluationId === evaluationId);
  }

  getLatestProof(): PolicyPackProof | undefined {
    return this.proofs.size === 0 ? undefined : [...this.proofs.values()].at(-1);
  }

  saveEvent(event: PolicyPackEvent): PolicyPackEvent {
    this.events.push(event);
    return event;
  }

  getLatestEvent(): PolicyPackEvent | undefined {
    return this.events.at(-1);
  }

  getEvents(): readonly PolicyPackEvent[] {
    return [...this.events];
  }
}
