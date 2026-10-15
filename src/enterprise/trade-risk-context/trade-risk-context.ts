import { contextObservationProvenanceDigest, type ContextFactObservation, type ContextResolutionQuery, type ContextResolverPort } from '../../features/context-resolution-runtime/index.js';
import {
  TRADE_PARAMETER_DIMENSION_IDS,
  TRADE_RISK_FACT_CLASSES,
  TradeConfigurationError,
  TradeProposalRefusedError,
  assessTradingRisk,
  compileTradeProposal,
  createTradeGovernanceBinding,
  isTradeInstant,
  parseTradingRiskProfile,
  tradeActiveOrderScopeKey,
  tradeAssetToken,
  tradeDelegationContextReading,
  tradeDelegationRequestFor,
  tradingRiskContextReadings,
  tradingRiskProfileReference,
  type AcceptedTradeProposal,
  type TradeAsset,
  type TradeContextReading,
  type TradeDelegationVerificationRequest,
  type TradeGovernedActionIntent,
  type TradingRiskAssessmentEvidence,
  type TradingRiskProfile,
} from '../../features/trade-runtime/index.js';
import type { BoundCustomerIdentity } from '../customer-identity/index.js';

/**
 * The TRADE composition edge to CORE-04 (TRADE-03 K1): the one approved place
 * where Frontera composes the trade vertical.
 *
 * It is a **Trusted Context Boundary provider and its in-process ingress** —
 * nothing else. It implements CORE-04's `ContextResolverPort`; it decides,
 * grants, signs, submits and executes nothing, holds no adapter, opens no
 * connection and adds no HTTP route.
 *
 * ## Trust model
 *
 * 1. **Ingress (`admitProposal`).** Trusted in-process code — the deployment's
 *    trading gateway, exactly as for `governedActionOrchestrator` — hands a
 *    `BoundCustomerIdentity` (from customer identity admission) and the raw
 *    proposal. The edge validates it, compiles the `GovernedActionIntent`
 *    **itself** for that identity, and keeps a one-shot binding keyed by
 *    `(organization, Kernel actor, owner resource)`. The applicant never
 *    states a fact, a source, a profile or an assessment; the intent it may
 *    submit is the one returned here.
 * 2. **Provider (`provider.resolveContext`).** For the Kernel's own query
 *    (organization, actor, action, resource — no applicant field), it takes
 *    the binding **at most once** (a second evaluation finds none), recompiles
 *    the stored proposal and checks it still yields the stored intent, reads
 *    every source **now** through the trusted ports, then reads the trusted
 *    clock once — the **reliance instant** (F-1): not before the Kernel's
 *    instant, strictly inside the binding's lifetime — assesses every fact
 *    against it with `assessTradingRisk`, and returns readings only for a
 *    reliable `SATISFIED` assessment and a reliable `AUTHORIZED` delegation,
 *    stated at the Kernel's instant with their windows' absolute ends unchanged.
 * 3. **Policy (`trade-risk-policy.ts`).** Every reading is a material fact;
 *    deny unless each of the request's seven parameters, amount and currency
 *    equals its reading. Together with the query's action, resource and
 *    organization, every field of the compiled intent but its request
 *    identity is bound; the one-shot binding bounds the request identity
 *    (an identical retry is a Governance Store replay that never re-runs the
 *    Kernel; a fresh idempotency key finds no binding and is denied).
 *
 * Digests here are integrity and correlation only. Authentication comes from
 * customer identity admission (who admitted) and from this module running
 * in-process with trusted ports (who assessed) — never from a digest.
 *
 * ## Fail closed
 *
 * A missing port for an enforced control refuses composition. A port that
 * throws, a stale, missing or conflicting reading, an expired or absent
 * binding, a mismatching query, a recompilation that disagrees, or any
 * exception yields **no reading**: the material facts are unresolved and the
 * Kernel denies. A profile that admits simulated sources refuses composition
 * unless the simulation acknowledgement is passed explicitly in code.
 */

/** The only value that lets a profile admitting simulated sources compose. Passed in code by tests — never read from configuration. */
export const TRADE_RISK_SIMULATION_ACKNOWLEDGEMENT = 'simulated-sources-not-for-production' as const;

/** Longest a binding waits for its evaluation. */
export const TRADE_RISK_MAXIMUM_BINDING_SECONDS = 300;
/** Bindings held at once; admission beyond this is refused, never evicting a pending one. */
export const TRADE_RISK_MAXIMUM_PENDING_BINDINGS = 1024;
/** TRADE-04C: longest an attested proposal stays readable by the governed executor (the Host's grant lifetime is at most this). */
export const TRADE_RISK_MAXIMUM_ATTESTATION_SECONDS = 3600;
/** TRADE-04C: attested proposals retained at once; the oldest is forgotten first (its execution then fails closed). */
export const TRADE_RISK_MAXIMUM_ATTESTATIONS = 4096;

export interface TradeMarketReadRequest {
  readonly organizationId: string;
  readonly network: string;
  readonly base: TradeAsset;
  /** Every quote asset the assessment needs a reference for (the pair's quote, a valuation asset, an exposure denomination). */
  readonly quotes: readonly TradeAsset[];
  readonly at: string;
}

export interface TradeExposureReadRequest {
  readonly organizationId: string;
  readonly network: string;
  readonly ownerAccount: string;
  readonly riskBucket: string;
  readonly denomination: TradeAsset;
  readonly at: string;
}

export interface TradeActiveOrderReadRequest {
  readonly organizationId: string;
  readonly network: string;
  readonly scope: string;
  readonly scopeKey: string;
  readonly at: string;
}

/**
 * Trusted, in-process source ports. Each returns what its authoritative
 * source states now — sealed snapshots, or a TRADE-02 assessment — and the
 * assessment re-validates every one of them. A port is required exactly when
 * the profile enforces the control it feeds.
 */
export interface TradeRiskSourcePorts {
  readonly market?: { read(request: TradeMarketReadRequest): Promise<readonly unknown[]> };
  readonly exposure?: { read(request: TradeExposureReadRequest): Promise<unknown> };
  readonly activeOrders?: { read(request: TradeActiveOrderReadRequest): Promise<unknown> };
  /** XLS-75 verification (e.g. TRADE-02's verifier over a reviewed transport). Required: delegation is never optional. */
  readonly delegation: { verify(request: TradeDelegationVerificationRequest): Promise<unknown> };
}

export interface TradeRiskContextOptions {
  /** The Host's authority organization: the only one this edge admits or attests for. */
  readonly organizationId: string;
  /** The governed action identifier OfferCreate is bound to (TRADE-01 binding). */
  readonly action: string;
  /** The trading-risk profile in force (data form; parsed and sealed here). */
  readonly profile: unknown;
  readonly ports: TradeRiskSourcePorts;
  /** The CORE-04 sources the readings are attributed to; they must be registered, authoritative and organization-scoped in the Host's trusted-context configuration. */
  readonly sourceIds: { readonly risk: string; readonly delegation: string };
  /** How long an admitted proposal waits for its evaluation, 1 … 300 s. */
  readonly bindingSeconds: number;
  /**
   * The trusted Host clock — the same time authority as the Kernel's. It times admission and, since F-1, the
   * reliance instant: read once after every source answered, never earlier than the Kernel's evaluation
   * instant and never past the binding's expiry. Never a source's, a provider's or the trading engine's clock.
   */
  readonly clock: () => string;
  /** Required exactly when the profile admits simulated sources. */
  readonly simulation?: typeof TRADE_RISK_SIMULATION_ACKNOWLEDGEMENT;
  /** Receives every sealed assessment, for audit. Errors are swallowed; it can never change a reading. */
  readonly onAssessment?: (evidence: TradingRiskAssessmentEvidence) => void;
  /** TRADE-04C: how long an attested proposal stays readable by the governed executor, 1 … 3600 s. Default 3600. */
  readonly attestationSeconds?: number;
}

/**
 * TRADE-04C — what the edge attested, read back by the governed executor:
 * the exact canonical proposal whose readings this provider returned to the
 * Kernel for a reliable `SATISFIED` assessment and an `AUTHORIZED`
 * delegation, for whom, and when. Retained per proposal digest for a bounded
 * time; never a decision, a grant or an authorization — the executor still
 * requires the grant to name this digest and re-derives every bound term.
 */
export interface TradeAttestedProposal {
  readonly proposalDigest: string;
  readonly proposal: AcceptedTradeProposal['proposal'];
  readonly organizationId: string;
  readonly principalId: string;
  readonly actorId: string;
  readonly action: string;
  readonly resource: string;
  readonly attestedAt: string;
  /** The sealed risk assessment's digest the readings came from. */
  readonly assessmentDigest: string;
  /** The profile admitted simulated sources: never operational execution evidence. */
  readonly simulatedSources: boolean;
}

/** TRADE-04C: the read-only lookup the governed executor composes. */
export interface TradeAttestedProposalSource {
  attestedProposal(proposalDigest: string): TradeAttestedProposal | undefined;
}

export const TRADE_RISK_ADMISSION_REFUSALS = Object.freeze({
  IDENTITY_INVALID: 'TRADE_ADMISSION_IDENTITY_INVALID',
  ORGANIZATION_MISMATCH: 'TRADE_ADMISSION_ORGANIZATION_MISMATCH',
  PROPOSAL_REFUSED: 'TRADE_ADMISSION_PROPOSAL_REFUSED',
  NOT_IN_PROFILE_SCOPE: 'TRADE_ADMISSION_NOT_IN_PROFILE_SCOPE',
  BINDING_PENDING: 'TRADE_ADMISSION_BINDING_PENDING',
  CAPACITY_EXHAUSTED: 'TRADE_ADMISSION_CAPACITY_EXHAUSTED',
  CLOCK_INVALID: 'TRADE_ADMISSION_CLOCK_INVALID',
} as const);

export type TradeRiskAdmissionRefusal = (typeof TRADE_RISK_ADMISSION_REFUSALS)[keyof typeof TRADE_RISK_ADMISSION_REFUSALS];

export type TradeRiskAdmission =
  | { readonly admitted: true; readonly intent: TradeGovernedActionIntent; readonly proposalDigest: string; readonly expiresAt: string }
  | { readonly admitted: false; readonly refusal: TradeRiskAdmissionRefusal };

export interface TradeRiskContext {
  /** CORE-04 provider: pass as the Host's `contextProvider`. */
  readonly provider: ContextResolverPort;
  /** Trusted in-process ingress. Returns the one intent the governed path will accept for this proposal. */
  admitProposal(identity: BoundCustomerIdentity, rawProposal: unknown, envelope?: { readonly expectedGovernanceProfile?: { readonly id: string; readonly version: number } }): TradeRiskAdmission;
  /** Pending bindings (for operations and tests). */
  pendingCount(): number;
  /** TRADE-04C: what this provider attested, by proposal digest. Read-only. */
  readonly attested: TradeAttestedProposalSource;
}

/**
 * R8 — what a genuine edge was composed with, recorded at construction in a module-private registry. Read by
 * `createTradeRiskPolicyPackProvider` only: an object that did not come from `createTradeRiskContext` has no
 * entry, so no policy provider can be bound to it. Frozen data and the edge's own provider/attestation objects.
 */
export interface TradeRiskContextComposition {
  readonly organizationId: string;
  readonly action: string;
  /** `<profileId>@<profileVersion>` of the pinned trading-risk profile — the value its readings carry. */
  readonly profileReference: string;
  readonly network: string;
  readonly ownerAccounts: readonly string[];
  readonly provider: ContextResolverPort;
  readonly attested: TradeAttestedProposalSource;
}

const COMPOSED_EDGES = new WeakMap<object, TradeRiskContextComposition>();

/** The composition of an edge `createTradeRiskContext` produced, or `undefined` for anything else. */
export function tradeRiskContextCompositionOf(edge: unknown): TradeRiskContextComposition | undefined {
  return typeof edge === 'object' && edge !== null ? COMPOSED_EDGES.get(edge) : undefined;
}

export class TradeRiskContextConfigurationError extends Error {
  readonly code = 'TRADE_RISK_CONTEXT_CONFIGURATION_INVALID' as const;

  constructor(message: string) {
    super(message);
    this.name = 'TradeRiskContextConfigurationError';
  }
}

interface Binding {
  readonly organizationId: string;
  readonly principalId: string;
  readonly actorId: string;
  readonly accepted: AcceptedTradeProposal;
  readonly intent: TradeGovernedActionIntent;
  readonly expiresAtMs: number;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;

function refuseConfiguration(message: string): never {
  throw new TradeRiskContextConfigurationError(message);
}

/** Field-by-field equality of two compiled intents (frozen plain data, no functions). */
function sameIntent(left: TradeGovernedActionIntent, right: TradeGovernedActionIntent): boolean {
  const keys = (value: Readonly<Record<string, string>>): string => JSON.stringify(Object.keys(value).sort().map((key) => [key, value[key]]));
  return (
    left.action === right.action &&
    left.resource === right.resource &&
    left.amount.value === right.amount.value &&
    left.amount.currency === right.amount.currency &&
    left.idempotencyKey === right.idempotencyKey &&
    left.correlationId === right.correlationId &&
    keys(left.parameters) === keys(right.parameters)
  );
}

/** Composes the edge, or refuses: every enforced control needs its port; a simulated-source profile needs the acknowledgement. */
export function createTradeRiskContext(options: TradeRiskContextOptions): TradeRiskContext {
  if (typeof options !== 'object' || options === null) refuseConfiguration('Trade risk context options are required.');
  const { organizationId, ports, sourceIds, bindingSeconds, clock } = options;
  if (typeof organizationId !== 'string' || !IDENTIFIER.test(organizationId)) refuseConfiguration('organizationId must be an identifier.');
  let binding: ReturnType<typeof createTradeGovernanceBinding>;
  try {
    binding = createTradeGovernanceBinding({ action: options.action });
  } catch (error) {
    refuseConfiguration(error instanceof TradeConfigurationError ? error.message : 'The trade action is invalid.');
  }
  const parsed = parseTradingRiskProfile(options.profile);
  if (!parsed.valid) refuseConfiguration(`The trading-risk profile is invalid (${parsed.violation} at ${parsed.field}).`);
  const profile: TradingRiskProfile = parsed.profile;
  const profileData = options.profile;
  if (profile.organizationId !== organizationId) refuseConfiguration('The trading-risk profile belongs to another organization.');
  if (profile.action !== binding.action) refuseConfiguration('The trading-risk profile is for another action.');
  if (profile.factProvenance === 'simulated-permitted' && options.simulation !== TRADE_RISK_SIMULATION_ACKNOWLEDGEMENT) {
    refuseConfiguration('A profile that admits simulated sources composes only with the explicit simulation acknowledgement; never in production.');
  }
  if (typeof sourceIds !== 'object' || sourceIds === null || !IDENTIFIER.test(sourceIds.risk) || !IDENTIFIER.test(sourceIds.delegation) || sourceIds.risk === sourceIds.delegation) {
    refuseConfiguration('Two distinct CORE-04 source identifiers are required.');
  }
  if (typeof bindingSeconds !== 'number' || !Number.isSafeInteger(bindingSeconds) || bindingSeconds < 1 || bindingSeconds > TRADE_RISK_MAXIMUM_BINDING_SECONDS) refuseConfiguration('bindingSeconds must be 1 to 300.');
  if (typeof clock !== 'function') refuseConfiguration('A trusted clock is required.');
  if (typeof ports !== 'object' || ports === null || typeof ports.delegation?.verify !== 'function') refuseConfiguration('A delegation verification port is required.');
  const needsMarket = profile.marketReference.mode === 'enforce';
  if (needsMarket && typeof ports.market?.read !== 'function') refuseConfiguration('The profile enforces a market reference: a market port is required.');
  if (profile.exposure.mode === 'enforce' && typeof ports.exposure?.read !== 'function') refuseConfiguration('The profile enforces exposure: an exposure port is required.');
  if (profile.activeOrders.mode === 'enforce' && typeof ports.activeOrders?.read !== 'function') refuseConfiguration('The profile enforces active orders: an active-order port is required.');
  const attestationSeconds = options.attestationSeconds ?? TRADE_RISK_MAXIMUM_ATTESTATION_SECONDS;
  if (typeof attestationSeconds !== 'number' || !Number.isSafeInteger(attestationSeconds) || attestationSeconds < 1 || attestationSeconds > TRADE_RISK_MAXIMUM_ATTESTATION_SECONDS) refuseConfiguration('attestationSeconds must be 1 to 3600.');
  const attestations = new Map<string, { readonly record: TradeAttestedProposal; readonly expiresAtMs: number }>();
  const attest = (record: TradeAttestedProposal): void => {
    const expiresAtMs = Date.parse(record.attestedAt) + attestationSeconds * 1000;
    attestations.delete(record.proposalDigest);
    while (attestations.size >= TRADE_RISK_MAXIMUM_ATTESTATIONS) attestations.delete(attestations.keys().next().value as string);
    attestations.set(record.proposalDigest, Object.freeze({ record: Object.freeze(record), expiresAtMs }));
  };
  const attested: TradeAttestedProposalSource = Object.freeze({
    attestedProposal(proposalDigest: string): TradeAttestedProposal | undefined {
      const entry = typeof proposalDigest === 'string' ? attestations.get(proposalDigest) : undefined;
      const at = now();
      if (entry === undefined || at === undefined || entry.expiresAtMs <= at) return undefined;
      return entry.record;
    },
  });

  const bindings = new Map<string, Binding>();
  const slotOf = (organization: string, actorId: string, resource: string): string => JSON.stringify([organization, actorId, resource]);

  function now(): number | undefined {
    try {
      const instant: unknown = clock();
      return isTradeInstant(instant) ? Date.parse(instant) : undefined;
    } catch {
      return undefined;
    }
  }

  /** The trusted clock's current instant, exactly as it states it, or `undefined`. Never a source's or the engine's time. */
  function trustedInstant(): string | undefined {
    try {
      const instant: unknown = clock();
      return isTradeInstant(instant) ? instant : undefined;
    } catch {
      return undefined;
    }
  }

  function sweep(at: number): void {
    for (const [key, entry] of bindings) if (entry.expiresAtMs <= at) bindings.delete(key);
  }

  function admitProposal(identity: BoundCustomerIdentity, rawProposal: unknown, envelope?: { readonly expectedGovernanceProfile?: { readonly id: string; readonly version: number } }): TradeRiskAdmission {
    const refuse = (refusal: TradeRiskAdmissionRefusal): TradeRiskAdmission => Object.freeze({ admitted: false as const, refusal });
    const principal = identity?.principal;
    const actorId = identity?.actor?.actorId;
    if (principal?.plane !== 'customer' || typeof principal.principalId !== 'string' || typeof actorId !== 'string' || !IDENTIFIER.test(actorId)) return refuse(TRADE_RISK_ADMISSION_REFUSALS.IDENTITY_INVALID);
    if (principal.organizationId !== organizationId) return refuse(TRADE_RISK_ADMISSION_REFUSALS.ORGANIZATION_MISMATCH);
    const at = now();
    if (at === undefined) return refuse(TRADE_RISK_ADMISSION_REFUSALS.CLOCK_INVALID);

    let compiled;
    try {
      // The intent is compiled here, for the authenticated identity — never taken from the applicant.
      compiled = compileTradeProposal(rawProposal, binding, { organizationId: principal.organizationId, principalId: principal.principalId }, envelope);
    } catch (error) {
      if (error instanceof TradeProposalRefusedError || error instanceof TradeConfigurationError) return refuse(TRADE_RISK_ADMISSION_REFUSALS.PROPOSAL_REFUSED);
      throw error;
    }
    const { intent, accepted } = compiled;
    if (accepted.proposal.network !== profile.network || !profile.ownerAccounts.includes(accepted.proposal.ownerAccount)) return refuse(TRADE_RISK_ADMISSION_REFUSALS.NOT_IN_PROFILE_SCOPE);

    sweep(at);
    const slot = slotOf(organizationId, actorId, intent.resource);
    if (bindings.has(slot)) return refuse(TRADE_RISK_ADMISSION_REFUSALS.BINDING_PENDING);
    if (bindings.size >= TRADE_RISK_MAXIMUM_PENDING_BINDINGS) return refuse(TRADE_RISK_ADMISSION_REFUSALS.CAPACITY_EXHAUSTED);
    const expiresAtMs = at + bindingSeconds * 1000;
    bindings.set(slot, Object.freeze({ organizationId, principalId: principal.principalId, actorId, accepted, intent, expiresAtMs }));
    return Object.freeze({ admitted: true as const, intent, proposalDigest: accepted.digest, expiresAt: new Date(expiresAtMs).toISOString() });
  }

  async function settle<T>(work: () => Promise<T>): Promise<T | undefined> {
    try {
      return await work();
    } catch {
      return undefined;
    }
  }

  async function observe(query: ContextResolutionQuery): Promise<readonly ContextFactObservation[]> {
    if (query.organizationId !== organizationId || !isTradeInstant(query.at)) return [];
    const slot = slotOf(organizationId, query.actorId, query.resourceScope);
    const entry = bindings.get(slot);
    // One-shot: the binding is taken before any await, so two evaluations can never both use it.
    bindings.delete(slot);
    if (entry === undefined || entry.expiresAtMs <= Date.parse(query.at)) return [];
    if (query.action !== entry.intent.action || query.resourceScope !== entry.intent.resource || query.actorId !== entry.actorId) return [];

    // Re-derive: the stored proposal must still compile to exactly the stored intent.
    const recompiled = compileTradeProposal(entry.accepted.proposal, binding, { organizationId: entry.organizationId, principalId: entry.principalId }, entry.intent.expectedGovernanceProfile !== undefined ? { expectedGovernanceProfile: entry.intent.expectedGovernanceProfile } : undefined);
    if (!sameIntent(recompiled.intent, entry.intent) || recompiled.accepted.digest !== entry.accepted.digest) return [];
    if (entry.intent.parameters[TRADE_PARAMETER_DIMENSION_IDS.proposalDigest] !== entry.accepted.digest) return [];

    const { proposal, terms } = entry.accepted;
    const at = query.at;
    const quotes: TradeAsset[] = [terms.quote];
    for (const pair of profile.pairs) if (pair.notional.mode === 'enforce') quotes.push(pair.notional.valuationAsset);
    if (profile.exposure.mode === 'enforce') quotes.push(profile.exposure.denomination);
    const uniqueQuotes = quotes.filter((asset, index) => quotes.findIndex((other) => tradeAssetToken(other) === tradeAssetToken(asset)) === index && tradeAssetToken(asset) !== tradeAssetToken(terms.base));

    const request = tradeDelegationRequestFor(proposal, entry.accepted.digest);
    const exposurePolicy = profile.exposure;
    const orderPolicy = profile.activeOrders;
    const [delegation, marketPrices, exposure, activeOrders] = await Promise.all([
      request.valid ? settle(() => ports.delegation.verify(request.request)) : Promise.resolve(undefined),
      needsMarket && ports.market !== undefined ? settle(() => (ports.market as NonNullable<TradeRiskSourcePorts['market']>).read({ organizationId, network: proposal.network, base: terms.base, quotes: uniqueQuotes, at })) : Promise.resolve(undefined),
      exposurePolicy.mode === 'enforce' && ports.exposure !== undefined
        ? settle(() => (ports.exposure as NonNullable<TradeRiskSourcePorts['exposure']>).read({ organizationId, network: proposal.network, ownerAccount: proposal.ownerAccount, riskBucket: exposurePolicy.riskBucket, denomination: exposurePolicy.denomination, at }))
        : Promise.resolve(undefined),
      orderPolicy.mode === 'enforce' && ports.activeOrders !== undefined
        ? settle(() =>
            (ports.activeOrders as NonNullable<TradeRiskSourcePorts['activeOrders']>).read({
              organizationId,
              network: proposal.network,
              scope: orderPolicy.scope,
              scopeKey: tradeActiveOrderScopeKey(orderPolicy.scope, { organizationId, ownerAccount: proposal.ownerAccount, delegateAccount: proposal.delegateAccount, baseToken: tradeAssetToken(terms.base), quoteToken: tradeAssetToken(terms.quote) }),
              at,
            }),
          )
        : Promise.resolve(undefined),
    ]);

    // F-1 — the reliance instant: the trusted Host clock, read once, AFTER every source answered. Every fact is
    // assessed against it (a fact observed after it is from the future; age is measured up to it). It may not
    // precede the Kernel's evaluation instant (a clock regression is refused, never accommodated) and must lie
    // strictly inside the admission binding's lifetime (collection that outlived the binding authorizes nothing).
    const relianceAt = trustedInstant();
    if (relianceAt === undefined) return [];
    const relianceMs = Date.parse(relianceAt);
    if (relianceMs < Date.parse(at) || relianceMs >= entry.expiresAtMs) return [];

    const result = assessTradingRisk({
      proposal,
      identity: { organizationId: entry.organizationId, principalId: entry.principalId },
      binding,
      profile: profileData,
      facts: {
        ...(delegation !== undefined ? { delegation } : {}),
        ...(marketPrices !== undefined ? { marketPrices } : {}),
        ...(exposure !== undefined ? { exposure } : {}),
        ...(activeOrders !== undefined ? { activeOrders } : {}),
      },
      ...(entry.intent.expectedGovernanceProfile !== undefined ? { governanceProfile: entry.intent.expectedGovernanceProfile } : {}),
      assessedAt: relianceAt,
    });
    if (!result.assessed) return [];
    try {
      options.onAssessment?.(result.evidence);
    } catch {
      // Audit observers cannot change a reading.
    }

    const queryBinding = { action: query.action, resourceScope: query.resourceScope, organizationId };
    const readings: { readonly reading: TradeContextReading; readonly sourceId: string }[] = [];
    // Relied on at `relianceAt`; stated to the Trusted Context Boundary at the Kernel's instant `at` (the instant it
    // classifies against), each reading's window ending at the same absolute, fact-derived instant as before.
    const risk = tradingRiskContextReadings(result.evidence, { proposal, profile: profileData, at: relianceAt, readingAt: at, ...(entry.intent.expectedGovernanceProfile !== undefined ? { governanceProfile: entry.intent.expectedGovernanceProfile } : {}) }, queryBinding);
    const delegated = delegation === undefined ? undefined : tradeDelegationContextReading(delegation, { proposal, at: relianceAt, readingAt: at, policy: profile.delegation, action: binding.action }, queryBinding);
    // Both or neither: a risk assessment without a reliable delegation reading, or the reverse, attests nothing.
    if (!risk.projected || delegated?.projected !== true) return [];
    for (const reading of risk.readings) readings.push({ reading, sourceId: sourceIds.risk });
    readings.push({ reading: delegated.reading, sourceId: sourceIds.delegation });
    // TRADE-04C: what was attested, for the governed executor to re-derive the order from (never authority by itself).
    attest({
      proposalDigest: entry.accepted.digest,
      proposal: entry.accepted.proposal,
      organizationId: entry.organizationId,
      principalId: entry.principalId,
      actorId: entry.actorId,
      action: entry.intent.action,
      resource: entry.intent.resource,
      attestedAt: relianceAt,
      assessmentDigest: result.evidence.digest,
      simulatedSources: profile.factProvenance === 'simulated-permitted',
    });

    return readings
      .filter(({ reading }) => query.keys.includes(reading.key))
      .map(({ reading, sourceId }): ContextFactObservation => {
        const base = { key: reading.key, value: reading.value, sourceId, observedAt: reading.observedAt, reference: reading.reference, organizationId, maxAgeSeconds: reading.maxAgeSeconds };
        return Object.freeze({ ...base, provenanceDigest: contextObservationProvenanceDigest(base) });
      });
  }

  const provider: ContextResolverPort = Object.freeze({
    async resolveContext(query: ContextResolutionQuery) {
      try {
        return { observations: await observe(query) };
      } catch {
        return { observations: [] };
      }
    },
  });

  const edge: TradeRiskContext = Object.freeze({ provider, admitProposal, pendingCount: () => bindings.size, attested });
  COMPOSED_EDGES.set(
    edge,
    Object.freeze({
      organizationId,
      action: binding.action,
      profileReference: tradingRiskProfileReference(profile),
      network: profile.network,
      ownerAccounts: Object.freeze([...profile.ownerAccounts]),
      provider,
      attested,
    }),
  );
  return edge;
}

/** Every fact class the edge can attest — the trading profile's `materialFacts`. */
export const TRADE_RISK_MATERIAL_FACTS: readonly string[] = Object.freeze(Object.values(TRADE_RISK_FACT_CLASSES));
