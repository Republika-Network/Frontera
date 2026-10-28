import type { ExecutionCapabilityConsumptionLedger } from '../execution-capability/reference/consumption-ledger.js';
import type { ObservedHttpRequest } from '../reference-executor/admission.js';
import type { ReferenceExecutorConfiguration, ReferenceExecutorFaultPoint } from '../reference-executor/configuration.js';
import type { ReferenceExecutorExecution, ReferenceExecutorExecutionFlowOptions } from '../reference-executor/execution-flow.js';
import type { SyntheticDeploymentEffect } from '../reference-executor/synthetic-effect.js';

/**
 * RSDK-02B — the governed sovereign receiver's contracts.
 *
 * The receiver is a G-02 executor that also refuses to act on a sovereign
 * asset it cannot verify and its own policy does not accept. Authority to act
 * is the Frontera execution capability alone: verifying the asset decides
 * whether this receiver is willing to use that authority, never whether the
 * authority exists. `verified` is never an authorization.
 *
 * Every port below is a trusted deployment dependency, composed once at
 * startup. Nothing in a request selects, replaces or configures any of them.
 * In particular the sovereign verifier is RSDK-01 composed by the deployment
 * with its own key resolver and consumer support: this module never imports
 * RSDK-01 or `@aoc/protocol`, so the shipped runtime keeps `@aoc/protocol`
 * type-only.
 */

export const GOVERNED_RECEIVER_MODE = 'governed-sovereign-receiver';

/**
 * The integration profile's resource convention: `capability.resource` is the
 * sovereign asset identifier. Restated from the Protocol identity module
 * (`aoc:sovereign-asset:` and a version 1–8 UUID) as a structural pre-check;
 * the injected verifier re-validates it as `expectedSovereignAssetId`.
 */
export const SOVEREIGN_ASSET_IDENTIFIER_PATTERN = /^aoc:sovereign-asset:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isSovereignAssetIdentifier(value: unknown): value is string {
  return typeof value === 'string' && SOVEREIGN_ASSET_IDENTIFIER_PATTERN.test(value);
}

export const GOVERNED_RECEIVER_LIMITS = Object.freeze({
  /** The ceiling on a serialized bundle (UTF-8 bytes). A deployment may configure less, never more. */
  maximumBundleBytes: 1_048_576,
  /** The asset gate's whole budget when none is configured: store, verifier and policy together. */
  defaultAssetDeadlineMs: 5_000,
  /** The longest asset-gate budget a deployment may configure. The capability's own expiry bounds it further. */
  maximumAssetDeadlineMs: 30_000,
});

/** A bundle and, when its current manifest commits to content, the content bytes. */
export interface StoredSovereignAsset {
  readonly bundleText: string;
  readonly contentBytes?: Uint8Array;
}

/** Where the receiver keeps the bundles it was given. Asked only for a capability-verified resource. */
export interface SovereignAssetStore {
  /** `undefined` when the asset is unknown. `maximumBundleBytes` lets a store refuse an oversized bundle before reading it. */
  load(sovereignAssetId: string, limits: { readonly maximumBundleBytes: number }): StoredSovereignAsset | undefined | Promise<StoredSovereignAsset | undefined>;
}

export interface SovereignAssetVerificationRequest {
  /** Always the verified capability's resource. */
  readonly expectedSovereignAssetId: string;
  readonly contentBytes?: Uint8Array;
}

/**
 * RSDK-01 `verifyReceivedSovereignAsset`, composed by the deployment with its
 * own trusted key resolver and consumer support. The answer is read
 * structurally and fails closed on any shape other than RSDK-01's verified
 * result for exactly the expected asset.
 */
export type SovereignAssetVerifier = (bundleText: string, request: SovereignAssetVerificationRequest) => Promise<unknown>;

export interface VerifiedSovereignClaim {
  readonly claimId: string;
  readonly claimType: string;
  readonly issuer: string;
  readonly keyId: string;
}

export interface VerifiedSovereignManifest {
  readonly manifestVersion: number;
  readonly manifestDigest: string;
  readonly issuer: string;
  readonly keyId: string;
  readonly state: string;
}

/**
 * What the receiver's policy sees: the facts RSDK-01 verified, copied out of
 * its result. Freshness and revocation are not evaluated by anyone here.
 */
export interface VerifiedSovereignAsset {
  readonly sovereignAssetId: string;
  /** The highest version in the stored bundle; not a claim that no newer version exists. */
  readonly currentManifestVersion: number;
  readonly currentIssuer: string;
  readonly currentState: string;
  readonly contentIdentity: 'verified' | 'not_declared';
  /** Unsigned standings are reported, never verified, and never grant anything. */
  readonly standings: 'none' | 'present_unverified';
  readonly manifests: readonly VerifiedSovereignManifest[];
  readonly claims: readonly VerifiedSovereignClaim[];
  readonly authorization: 'not_evaluated';
  readonly revocation: 'not_evaluated';
  readonly freshness: 'not_evaluated';
}

export interface SovereignAssetEligibilityInput {
  readonly action: string;
  readonly resource: string;
  readonly asset: VerifiedSovereignAsset;
}

/** The only answers a policy may give. Anything else, including a throw, refuses. */
export type SovereignAssetEligibilityDecision = { readonly decision: 'eligible' } | { readonly decision: 'ineligible'; readonly reason: string };

/** The receiver's own decision whether a verified asset may be used for this action. */
export type SovereignAssetEligibilityPolicy = (input: SovereignAssetEligibilityInput) => SovereignAssetEligibilityDecision | Promise<SovereignAssetEligibilityDecision>;

/** Every way the asset gate refuses, in the order its stages run. Nothing is claimed for any of them. */
export const GOVERNED_RECEIVER_ASSET_REFUSALS = Object.freeze([
  'ASSET_IDENTIFIER_INVALID',
  'ASSET_STORE_FAILED',
  'ASSET_STORE_TIMEOUT',
  'ASSET_NOT_FOUND',
  'ASSET_MALFORMED',
  'ASSET_TOO_LARGE',
  'ASSET_VERIFICATION_FAILED',
  'ASSET_VERIFICATION_TIMEOUT',
  'ASSET_VERIFICATION_MALFORMED',
  'ASSET_REJECTED',
  'ASSET_POLICY_FAILED',
  'ASSET_POLICY_TIMEOUT',
  'ASSET_POLICY_INVALID',
  'ASSET_INELIGIBLE',
] as const);
export type GovernedReceiverAssetRefusalCode = (typeof GOVERNED_RECEIVER_ASSET_REFUSALS)[number];

/** A refusal by the asset gate: the capability verified, and was left unclaimed. */
export interface GovernedReceiverAssetRefusal {
  readonly mode: typeof GOVERNED_RECEIVER_MODE;
  readonly outcome: 'refused';
  readonly stage: 'asset' | 'policy';
  readonly code: GovernedReceiverAssetRefusalCode;
  /** The digest the capability verified against. */
  readonly bindingDigest: string;
  readonly ledgerState: null;
  /** RSDK-01's closed rejection reasons, for `ASSET_REJECTED` only. */
  readonly assetRejection: readonly string[] | null;
  /** The policy's stated reason, for `ASSET_INELIGIBLE` only. */
  readonly ineligibleReason: string | null;
}

export type GovernedReceiverRecord = ReferenceExecutorExecution | GovernedReceiverAssetRefusal;

export interface GovernedReceiverAnswer {
  readonly record: GovernedReceiverRecord;
  readonly status: number;
  /** At most the one executor-receipt header the existing flow adds. */
  readonly headers: Readonly<Record<string, string>>;
}

/** Schedules `fire` after `ms`; returns a cancel. Injected by tests for deterministic deadlines. */
export type GovernedReceiverDeadlineScheduler = (ms: number, fire: () => void) => () => void;

export interface GovernedSovereignReceiverOptions {
  /** A parsed reference-executor configuration in `synthetic-execution` mode: issuers, audience, credential, actions, origin. */
  readonly configuration: ReferenceExecutorConfiguration;
  /** The existing G-02A ledger, pinned to the configuration's audience. One consumption domain. */
  readonly ledger: ExecutionCapabilityConsumptionLedger;
  /** The existing synthetic effect: the one protected operation this profile supports. */
  readonly effect: SyntheticDeploymentEffect;
  readonly clock: () => number;
  /** The existing G-02C1C receipt issuer, when receipts are configured. */
  readonly receipts?: ReferenceExecutorExecutionFlowOptions['receipts'];
  /** Crash-injection points of the existing flow, for qualification only. */
  readonly fault?: (point: ReferenceExecutorFaultPoint) => void;
  readonly assets: SovereignAssetStore;
  readonly verifyAsset: SovereignAssetVerifier;
  readonly policy: SovereignAssetEligibilityPolicy;
  readonly limits?: { readonly maximumBundleBytes?: number; readonly assetDeadlineMs?: number };
  readonly schedule?: GovernedReceiverDeadlineScheduler;
}

export interface GovernedSovereignReceiver {
  /** One governed request, as this receiver's HTTP parser received it. Never throws. */
  handle(observed: ObservedHttpRequest): Promise<GovernedReceiverAnswer>;
}
