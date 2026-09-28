import type { PolicyPack, PolicyPackDomain, PolicyPackKind } from '../domain/policy-pack.js';
import type { PolicyPackLegalCompleteness, PolicyPackVersion } from '../domain/policy-pack-version.js';
import type { PolicyPackScope } from '../domain/policy-pack-scope.js';
import type { PolicyPackRule } from '../domain/policy-pack-rule.js';
import type { PolicyPackSource } from '../domain/policy-pack-source.js';
import type { PolicyPackRuntimeContext } from '../runtime/policy-pack-runtime-context.js';
import {
  PolicyPackDuplicateIdError,
  PolicyPackInvalidStatusTransitionError,
  PolicyPackNotFoundError,
  PolicyPackVersionNotFoundError,
  PolicyPackWriteRefusedError,
} from '../runtime/policy-pack-runtime-errors.js';
import { isTrustedPolicyPackWriter, type PolicyPackWriterContext } from '../domain/policy-pack-writer.js';
import type { PolicyPackLedger } from './policy-pack-ledger.js';
import type { PolicyPackStore } from './policy-pack-store.js';
import { PolicyPackValidator } from './policy-pack-validator.js';

export interface RegisterPolicyPackInput {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly kind: PolicyPackKind;
  readonly domain: PolicyPackDomain;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface RegisterPolicyPackVersionInput {
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

const VALID_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  draft: ['active', 'revoked'],
  active: ['deprecated', 'revoked', 'superseded'],
  deprecated: ['revoked'],
  revoked: [],
  superseded: [],
};

/**
 * Registers policy packs and policy pack versions, enforces lifecycle
 * transitions, and records lifecycle events on the ledger. Never evaluates
 * rules -- that is PolicyRuleEvaluator's responsibility.
 *
 * NB-008 (closed by CORE-03): every write takes a trusted
 * `PolicyPackWriterContext` first and is refused without one
 * (`POLICY_PACK_WRITER_REQUIRED`); the writer is recorded on the pack, the
 * version and the lifecycle event. `freeze(writer)` makes the registry — and
 * the policy half of its store — read-only for the rest of the process
 * (`POLICY_PACK_REGISTRY_FROZEN`), the policy-pack counterpart of the
 * assurance registry's freeze before traffic (SEC-INV-034).
 */
export class PolicyPackRegistry {
  private readonly validator = new PolicyPackValidator();
  #frozenBy: string | undefined;

  constructor(
    private readonly ctx: PolicyPackRuntimeContext,
    private readonly store: PolicyPackStore,
    private readonly ledger: PolicyPackLedger,
  ) {}

  /** The writer, verified, or a refusal. Checked before anything is read or changed. */
  private authorize(writer: unknown): PolicyPackWriterContext {
    if (!isTrustedPolicyPackWriter(writer)) {
      throw new PolicyPackWriteRefusedError('POLICY_PACK_WRITER_REQUIRED', 'Policy-pack writes require a trusted writer context ({ system: true, actorId }).');
    }
    if (this.#frozenBy !== undefined) {
      throw new PolicyPackWriteRefusedError('POLICY_PACK_REGISTRY_FROZEN', `The policy-pack registry was frozen by ${this.#frozenBy}; packs and versions are read-only.`);
    }
    return writer;
  }

  /** Irreversibly makes packs and versions read-only. Recorded with its writer. */
  freeze(writer: PolicyPackWriterContext): void {
    const { actorId } = this.authorize(writer);
    this.#frozenBy = actorId;
    this.store.freezeAuthority();
    this.ledger.recordEvent({ type: 'policy_pack_registry_frozen', payload: { actorId } });
  }

  isFrozen(): boolean {
    return this.#frozenBy !== undefined;
  }

  registerPolicyPack(writer: PolicyPackWriterContext, input: RegisterPolicyPackInput): PolicyPack {
    const { actorId } = this.authorize(writer);
    if (this.store.hasPack(input.id)) {
      throw new PolicyPackDuplicateIdError('policy pack', input.id);
    }
    const now = this.ctx.clock.now();
    const pack: PolicyPack = {
      id: input.id,
      name: input.name,
      description: input.description,
      kind: input.kind,
      domain: input.domain,
      status: 'draft',
      currentVersionId: '',
      versions: [],
      createdAt: now,
      updatedAt: now,
      registeredBy: actorId,
      lastWrittenBy: actorId,
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    };
    this.store.savePack(pack);

    this.ledger.recordEvent({
      type: 'policy_pack_registered',
      policyPackId: pack.id,
      payload: { name: pack.name, kind: pack.kind, domain: pack.domain, actorId },
    });

    return pack;
  }

  registerPolicyPackVersion(writer: PolicyPackWriterContext, input: RegisterPolicyPackVersionInput): PolicyPackVersion {
    const { actorId } = this.authorize(writer);
    const pack = this.store.getPack(input.policyPackId);
    if (!pack) {
      throw new PolicyPackNotFoundError(input.policyPackId);
    }
    if (this.store.hasVersion(input.id)) {
      throw new PolicyPackDuplicateIdError('policy pack version', input.id);
    }

    const now = this.ctx.clock.now();
    const version: PolicyPackVersion = {
      id: input.id,
      policyPackId: input.policyPackId,
      version: input.version,
      status: 'draft',
      scope: input.scope,
      rules: input.rules,
      sources: input.sources,
      effectiveFrom: input.effectiveFrom,
      demoOnly: input.demoOnly,
      legalCompleteness: input.legalCompleteness,
      createdAt: now,
      updatedAt: now,
      registeredBy: actorId,
      ...(input.effectiveUntil !== undefined ? { effectiveUntil: input.effectiveUntil } : {}),
      ...(input.supersedesVersionId !== undefined ? { supersedesVersionId: input.supersedesVersionId } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    };

    this.validator.validateVersion(version);
    this.store.saveVersion(version);

    const updatedPack: PolicyPack = { ...pack, versions: [...pack.versions, version], updatedAt: now, lastWrittenBy: actorId };
    this.store.savePack(updatedPack);

    return version;
  }

  activatePolicyPackVersion(writer: PolicyPackWriterContext, policyPackVersionId: string): PolicyPackVersion {
    const { actorId } = this.authorize(writer);
    const version = this.transition(policyPackVersionId, 'active', actorId);

    this.validator.validateActivatable(version);

    const pack = this.store.getPack(version.policyPackId);
    if (pack) {
      const updated: PolicyPack = {
        ...pack,
        status: 'active',
        currentVersionId: version.id,
        updatedAt: this.ctx.clock.now(),
        lastWrittenBy: actorId,
      };
      this.store.savePack(updated);
    }

    if (version.supersedesVersionId && this.store.hasVersion(version.supersedesVersionId)) {
      this.transition(version.supersedesVersionId, 'superseded', actorId);
      this.ledger.recordEvent({
        type: 'policy_pack_version_superseded',
        policyPackId: version.policyPackId,
        policyPackVersionId: version.supersedesVersionId,
        payload: { supersededByVersionId: version.id, actorId },
      });
    }

    this.ledger.recordEvent({
      type: 'policy_pack_version_activated',
      policyPackId: version.policyPackId,
      policyPackVersionId: version.id,
      payload: { version: version.version, actorId },
    });

    return version;
  }

  deprecatePolicyPackVersion(writer: PolicyPackWriterContext, policyPackVersionId: string): PolicyPackVersion {
    const { actorId } = this.authorize(writer);
    const version = this.transition(policyPackVersionId, 'deprecated', actorId);
    this.ledger.recordEvent({
      type: 'policy_pack_version_deprecated',
      policyPackId: version.policyPackId,
      policyPackVersionId: version.id,
      payload: { version: version.version, actorId },
    });
    return version;
  }

  revokePolicyPackVersion(writer: PolicyPackWriterContext, policyPackVersionId: string): PolicyPackVersion {
    const { actorId } = this.authorize(writer);
    const version = this.transition(policyPackVersionId, 'revoked', actorId);
    this.ledger.recordEvent({
      type: 'policy_pack_version_revoked',
      policyPackId: version.policyPackId,
      policyPackVersionId: version.id,
      payload: { version: version.version, actorId },
    });
    return version;
  }

  supersedePolicyPackVersion(writer: PolicyPackWriterContext, policyPackVersionId: string, supersededByVersionId: string): PolicyPackVersion {
    const { actorId } = this.authorize(writer);
    const version = this.transition(policyPackVersionId, 'superseded', actorId);
    this.ledger.recordEvent({
      type: 'policy_pack_version_superseded',
      policyPackId: version.policyPackId,
      policyPackVersionId: version.id,
      payload: { supersededByVersionId, actorId },
    });
    return version;
  }

  listPacks(): readonly PolicyPack[] {
    return this.store.listPacks();
  }

  listActivePacks(): readonly PolicyPack[] {
    return this.store.listActivePacks();
  }

  listActiveVersions(): readonly PolicyPackVersion[] {
    return this.store.listActiveVersions();
  }

  private transition(policyPackVersionId: string, to: PolicyPackVersion['status'], actorId: string): PolicyPackVersion {
    const version = this.store.getVersion(policyPackVersionId);
    if (!version) {
      throw new PolicyPackVersionNotFoundError(policyPackVersionId);
    }
    const allowed = VALID_TRANSITIONS[version.status] ?? [];
    if (!allowed.includes(to)) {
      throw new PolicyPackInvalidStatusTransitionError(policyPackVersionId, version.status, to);
    }
    const updated = this.store.updateVersionStatus(policyPackVersionId, to, this.ctx.clock.now(), actorId);
    if (!updated) {
      throw new PolicyPackVersionNotFoundError(policyPackVersionId);
    }
    return updated;
  }
}
