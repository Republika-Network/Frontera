import {
  CONTEXT_MAX_AGE_SECONDS_LIMIT,
  CONTEXT_MAX_FUTURE_SKEW_SECONDS,
  CONTEXT_SOURCE_KINDS,
  isContextFactClass,
  validateContextSource,
  type ContextDeclaration,
  type ContextRequirement,
  type ContextSource,
  type ContextSourceKind,
} from '../../features/context-resolution-runtime/index.js';
import {
  OBLIGATION_DISCHARGE_SOURCE_KINDS,
  OBLIGATION_DISCHARGE_VERIFICATION_CLASSES,
  validateObligationDischargeSource,
  type ObligationDischargeSource,
  type ObligationDischargeSourceKind,
  type ObligationDischargeVerificationClass,
} from '../../features/obligation-runtime/index.js';
import type { ContextProvider } from '../../kernel/index.js';
import type { KernelProfileContextDeclaration } from '../../kernel/orchestration/context-adapter.js';
import type { KernelProfileObligationDeclaration } from '../../kernel/orchestration/obligation-adapter.js';
import type { GovernanceProfileRegistry } from '../governance-profile/index.js';
import { GovernedActionConfigurationError, type GovernedActionConfigurationErrorCode } from '../governed-action/errors.js';

/**
 * CORE-04 — the Trusted Context Boundary and obligations, as the governed-action
 * composition configures them.
 *
 * ## The one boundary
 *
 * There is exactly one place a contextual fact becomes trusted: the context
 * runtime's `ContextResolutionService`, composed into the one grant-aware
 * Kernel the governed-action path evaluates through. This module does not
 * admit anything itself. It turns trusted configuration — the source registry
 * below and each Governance Profile's material and restrict-only fact classes —
 * into that boundary's declarations, and refuses, at composition and before any
 * store opens, every configuration under which a declared fact could not be
 * admitted or could be admitted from somewhere it should not.
 *
 * ## Authority to attest is not authority to authorize
 *
 * A source here is granted authority to **attest** named fact classes, for one
 * organization, with a freshness bound per class. Nothing here, and nothing a
 * source says, grants authority to **act**: an admitted fact is one input to
 * deterministic organization policy, read through a typed predicate, and the
 * Kernel still decides. A profile declaring a fact *material* likewise makes no
 * source trusted for it — materiality and source authority are configured
 * separately, and both must hold.
 *
 * ## What is refused
 *
 * - a source of kind `request`, or below `authoritative` trust: on the governed
 *   path a requester can never be a context source;
 * - a source scoped to another organization than the one this Host serves;
 * - an attestation without a freshness bound — every admitted fact has one
 *   canonical owner of its freshness, the source's bound for that class;
 * - an attestation of a fact class no profile declares (inert configuration is
 *   refused rather than silently kept);
 * - a declared fact class no source may attest, facts declared with no context
 *   provider or no policy, obligations declared with no discharge sources.
 *
 * Every source is composed with `provenance: 'reference-digest'`: a reading
 * without a reference and a recomputing provenance digest is refused.
 *
 * The registry is immutable after composition: there is no runtime mutation,
 * no admin route and no request field that registers, removes or re-scopes a
 * source (NB-008 is not repeated).
 */

/** One trusted context source, as configured. Closed schema. */
export interface TrustedContextSourceDefinition {
  readonly sourceId: string;
  readonly kind: ContextSourceKind;
  readonly name: string;
  /** `authoritative` (read directly from a system of record) or `attested` (a verified signed attestation). Never `asserted`. */
  readonly trustClass: 'authoritative' | 'attested';
  /** The organization this source attests for. Must be the one this Host serves. */
  readonly organizationId: string;
  /** The fact classes this source may attest, each with its canonical freshness bound (seconds). */
  readonly attests: readonly { readonly factClass: string; readonly maxAgeSeconds: number }[];
}

export interface TrustedContextConfiguration {
  readonly sources: readonly TrustedContextSourceDefinition[];
  /** Tolerated forward clock skew for a reading's time, 0 … 300 s. Default 0. */
  readonly maxFutureSkewSeconds?: number;
}

/** One configured obligation discharge source. Closed schema. */
export interface ObligationDischargeSourceDefinition {
  readonly sourceId: string;
  readonly kind: ObligationDischargeSourceKind;
  readonly name: string;
  /** `independent` sources can verify and waive; `self_reported` ones can at most report a discharge, which never satisfies. */
  readonly verificationClass: ObligationDischargeVerificationClass;
}

export interface ObligationConfiguration {
  readonly sources: readonly ObligationDischargeSourceDefinition[];
}

/** What the composition root hands the Kernel and the orchestrator. */
export interface GovernedTrustComposition {
  /** Present when any profile declares facts. The context provider is composed alongside. */
  readonly context?: {
    readonly sources: readonly ContextSource[];
    readonly profileDeclarations: readonly KernelProfileContextDeclaration[];
    readonly provider: ContextProvider;
  };
  /** Present when obligation discharge sources are configured. */
  readonly obligations?: {
    readonly sources: readonly ObligationDischargeSource[];
    readonly profileDeclarations: readonly KernelProfileObligationDeclaration[];
  };
  /** Every fact class any profile declares — what the reserved-key registry already refuses from callers. */
  readonly factClasses: readonly string[];
}

const LIMITS = { sources: 64, attestationsPerSource: 128, text: 128 } as const;
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function refuse(code: GovernedActionConfigurationErrorCode, message: string): never {
  throw new GovernedActionConfigurationError(code, message);
}

function invalid(message: string): never {
  refuse('GOVERNED_ACTION_TRUSTED_CONTEXT_INVALID', message);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function closed(value: unknown, keys: readonly string[], where: string): Record<string, unknown> {
  if (!isPlainRecord(value)) invalid(`${where} must be an object.`);
  const extra = Object.keys(value).filter((key) => !keys.includes(key));
  if (extra.length > 0) invalid(`${where} carries undeclared properties: ${extra.join(', ')}.`);
  return value;
}

function list(value: unknown, where: string, maximum: number): readonly unknown[] {
  if (!Array.isArray(value)) invalid(`${where} must be an array.`);
  if (value.length > maximum) invalid(`${where} may hold at most ${maximum} entries.`);
  return value as readonly unknown[];
}

function text(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > LIMITS.text) invalid(`${where} must be a non-empty string of at most ${LIMITS.text} characters.`);
  return value;
}

function sourceId(value: unknown, where: string): string {
  if (typeof value !== 'string' || !SOURCE_ID.test(value)) invalid(`${where} is not a source identifier.`);
  return value;
}

/** Validates the trusted source registry against the served organization and the declared fact classes. */
function buildContextSources(configuration: unknown, organizationId: string, declaredFacts: ReadonlySet<string>): { readonly sources: readonly ContextSource[]; readonly skew: number; readonly attested: ReadonlySet<string> } {
  const config = closed(configuration, ['sources', 'maxFutureSkewSeconds'], 'trustedContext');
  const skew = config['maxFutureSkewSeconds'] ?? 0;
  if (typeof skew !== 'number' || !Number.isSafeInteger(skew) || skew < 0 || skew > CONTEXT_MAX_FUTURE_SKEW_SECONDS) {
    invalid(`trustedContext.maxFutureSkewSeconds must be an integer from 0 to ${CONTEXT_MAX_FUTURE_SKEW_SECONDS}.`);
  }
  const entries = list(config['sources'], 'trustedContext.sources', LIMITS.sources);
  if (entries.length === 0) invalid('trustedContext.sources must name at least one source; omit trustedContext when no profile declares facts.');
  const sources: ContextSource[] = [];
  const idFolds = new Set<string>();
  const attested = new Set<string>();
  for (const [index, raw] of entries.entries()) {
    const where = `trustedContext.sources[${index}]`;
    const entry = closed(raw, ['sourceId', 'kind', 'name', 'trustClass', 'organizationId', 'attests'], where);
    const id = sourceId(entry['sourceId'], `${where}.sourceId`);
    if (idFolds.has(id.toLowerCase())) invalid(`${where}.sourceId '${id}' is configured twice (source ids are unique regardless of case).`);
    idFolds.add(id.toLowerCase());
    const kind = entry['kind'];
    if (typeof kind !== 'string' || !(CONTEXT_SOURCE_KINDS as readonly string[]).includes(kind) || kind === 'request') {
      invalid(`${where}.kind must be a declared context source kind other than 'request' — on the governed path the requester is never a context source.`);
    }
    const trustClass = entry['trustClass'];
    if (trustClass !== 'authoritative' && trustClass !== 'attested') invalid(`${where}.trustClass must be 'authoritative' or 'attested'.`);
    const sourceOrganization = text(entry['organizationId'], `${where}.organizationId`);
    if (sourceOrganization !== organizationId) {
      invalid(`${where} is scoped to organization '${sourceOrganization}', and this Host serves one organization only; a source for another organization is never authoritative here.`);
    }
    const attests: { factClass: string; maxAgeSeconds: number }[] = [];
    const factFolds = new Set<string>();
    for (const [attestationIndex, rawAttestation] of list(entry['attests'], `${where}.attests`, LIMITS.attestationsPerSource).entries()) {
      const at = `${where}.attests[${attestationIndex}]`;
      const attestation = closed(rawAttestation, ['factClass', 'maxAgeSeconds'], at);
      const factClass = attestation['factClass'];
      if (!isContextFactClass(factClass)) invalid(`${at}.factClass is not a fact class identifier.`);
      if (factFolds.has(factClass.toLowerCase())) invalid(`${at}.factClass '${factClass}' is attested twice by one source.`);
      factFolds.add(factClass.toLowerCase());
      if (!declaredFacts.has(factClass)) invalid(`${at}.factClass '${factClass}' is declared by no Governance Profile; an attestation nothing reads is refused rather than kept.`);
      const maxAgeSeconds = attestation['maxAgeSeconds'];
      if (typeof maxAgeSeconds !== 'number' || !Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 1 || maxAgeSeconds > CONTEXT_MAX_AGE_SECONDS_LIMIT) {
        invalid(`${at}.maxAgeSeconds must be an integer from 1 to ${CONTEXT_MAX_AGE_SECONDS_LIMIT}; every admitted fact has a freshness bound.`);
      }
      attests.push({ factClass, maxAgeSeconds });
      attested.add(factClass);
    }
    if (attests.length === 0) invalid(`${where}.attests must name at least one fact class.`);
    const source: ContextSource = Object.freeze({
      id,
      kind: kind as ContextSourceKind,
      name: text(entry['name'], `${where}.name`),
      trustClass,
      organizationId,
      provenance: 'reference-digest' as const,
      attests: Object.freeze(attests.sort((left, right) => (left.factClass < right.factClass ? -1 : 1)).map((attestation) => Object.freeze(attestation))),
    });
    const violations = validateContextSource(source);
    if (violations.length > 0) invalid(violations.join(' '));
    sources.push(source);
  }
  return { sources: Object.freeze(sources.sort((left, right) => (left.id < right.id ? -1 : 1))), skew, attested };
}

function buildObligationSources(configuration: unknown): readonly ObligationDischargeSource[] {
  const config = closed(configuration, ['sources'], 'obligations');
  const entries = list(config['sources'], 'obligations.sources', LIMITS.sources);
  if (entries.length === 0) invalid('obligations.sources must name at least one discharge source.');
  const sources: ObligationDischargeSource[] = [];
  const folds = new Set<string>();
  for (const [index, raw] of entries.entries()) {
    const where = `obligations.sources[${index}]`;
    const entry = closed(raw, ['sourceId', 'kind', 'name', 'verificationClass'], where);
    const id = sourceId(entry['sourceId'], `${where}.sourceId`);
    if (folds.has(id.toLowerCase())) invalid(`${where}.sourceId '${id}' is configured twice.`);
    folds.add(id.toLowerCase());
    const kind = entry['kind'];
    if (typeof kind !== 'string' || !(OBLIGATION_DISCHARGE_SOURCE_KINDS as readonly string[]).includes(kind) || kind === 'request') {
      invalid(`${where}.kind must be a declared discharge source kind other than 'request'.`);
    }
    const verificationClass = entry['verificationClass'];
    if (typeof verificationClass !== 'string' || !(OBLIGATION_DISCHARGE_VERIFICATION_CLASSES as readonly string[]).includes(verificationClass)) invalid(`${where}.verificationClass is not a declared verification class.`);
    const source: ObligationDischargeSource = Object.freeze({
      id,
      kind: kind as ObligationDischargeSourceKind,
      name: text(entry['name'], `${where}.name`),
      verificationClass: verificationClass as ObligationDischargeVerificationClass,
    });
    const violations = validateObligationDischargeSource(source);
    if (violations.length > 0) invalid(violations.join(' '));
    sources.push(source);
  }
  return Object.freeze(sources.sort((left, right) => (left.id < right.id ? -1 : 1)));
}

export interface ComposeGovernedTrustInput {
  readonly governance: GovernanceProfileRegistry;
  readonly organizationId: string;
  readonly trustedContext?: TrustedContextConfiguration;
  readonly contextProvider?: ContextProvider;
  readonly obligations?: ObligationConfiguration;
  readonly policyComposed: boolean;
}

/**
 * Validates and composes CORE-04 for the governed-action path, or throws a
 * `GovernedActionConfigurationError` — at composition, before any store opens.
 *
 * Compatibility is explicit: a deployment whose profiles declare no facts and
 * no obligations, and that configures neither, composes exactly as before.
 */
export function composeGovernedTrust(input: ComposeGovernedTrustInput): GovernedTrustComposition {
  const profiles = input.governance.profiles;
  const declaredFacts = new Set(input.governance.factClasses);
  const factsDeclared = declaredFacts.size > 0;
  const obligationsDeclared = profiles.some((profile) => (profile.definition.obligations ?? []).length > 0);

  let context: GovernedTrustComposition['context'];
  if (input.trustedContext !== undefined) {
    const { sources, skew, attested } = buildContextSources(input.trustedContext, input.organizationId, declaredFacts);
    for (const factClass of declaredFacts) {
      if (!attested.has(factClass)) {
        refuse('GOVERNED_ACTION_TRUSTED_CONTEXT_INCOMPLETE', `Fact class '${factClass}' is declared by a Governance Profile and no configured source has authority to attest it; every request depending on it would fail closed.`);
      }
    }
    if (input.contextProvider === undefined || typeof input.contextProvider.resolveContext !== 'function') {
      refuse('GOVERNED_ACTION_TRUSTED_CONTEXT_REQUIRED', 'Trusted context sources are configured, and no context provider is composed to read candidate facts from them.');
    }
    const profileDeclarations: KernelProfileContextDeclaration[] = [];
    for (const profile of profiles) {
      const material = profile.definition.materialFacts;
      const restrictive = profile.definition.restrictiveFacts ?? [];
      if (material.length === 0 && restrictive.length === 0) continue;
      const requirements: ContextRequirement[] = [
        // Material: required, at a system-of-record class at least. Missing,
        // stale, conflicted, refused or under-trusted denies.
        ...material.map((key) => ({ key, minimumTrustClass: 'authoritative' as const, required: true })),
        // Restrict-only: never required; ambiguity denies.
        ...restrictive.map((key) => ({ key, minimumTrustClass: 'authoritative' as const, required: false, restrictive: true })),
      ];
      const declaration: ContextDeclaration = { requirements, maxFutureSkewSeconds: skew };
      profileDeclarations.push({ profile: profile.reference, declaration });
    }
    context = Object.freeze({ sources, profileDeclarations: Object.freeze(profileDeclarations), provider: input.contextProvider });
  }

  if (factsDeclared && context === undefined) {
    refuse('GOVERNED_ACTION_TRUSTED_CONTEXT_REQUIRED', 'A Governance Profile declares material or restrict-only facts, and no Trusted Context Boundary is configured; a required fact could never be admitted.');
  }
  if (factsDeclared && !input.policyComposed) {
    refuse('GOVERNED_ACTION_CONTEXT_POLICY_REQUIRED', 'A Governance Profile declares facts, and no policy pack is composed; an admitted fact informs deterministic policy, and with none there is nothing to decide with it.');
  }

  let obligations: GovernedTrustComposition['obligations'];
  if (input.obligations !== undefined) {
    const sources = buildObligationSources(input.obligations);
    const profileDeclarations: KernelProfileObligationDeclaration[] = profiles
      .filter((profile) => (profile.definition.obligations ?? []).length > 0)
      .map((profile) => ({
        profile: profile.reference,
        declaration: { requirements: (profile.definition.obligations ?? []).map((obligation) => ({ obligationType: obligation.obligationType, blocking: obligation.blocking })) },
      }));
    obligations = Object.freeze({ sources, profileDeclarations: Object.freeze(profileDeclarations) });
  }
  if (obligationsDeclared && obligations === undefined) {
    refuse('GOVERNED_ACTION_OBLIGATIONS_REQUIRED', 'A Governance Profile declares obligations, and no obligation discharge sources are configured; a blocking obligation could never be satisfied.');
  }

  return Object.freeze({
    ...(context !== undefined ? { context } : {}),
    ...(obligations !== undefined ? { obligations } : {}),
    factClasses: input.governance.factClasses,
  });
}
