import {
  GOVERNED_RECEIVER_LIMITS,
  isSovereignAssetIdentifier,
  type GovernedReceiverAssetRefusalCode,
  type GovernedReceiverDeadlineScheduler,
  type SovereignAssetEligibilityPolicy,
  type SovereignAssetStore,
  type SovereignAssetVerifier,
  type StoredSovereignAsset,
  type VerifiedSovereignAsset,
  type VerifiedSovereignClaim,
  type VerifiedSovereignManifest,
} from './contracts.js';

/**
 * RSDK-02B — the sovereign asset gate: run after the capability verified and
 * before anything is claimed.
 *
 * ```
 * identifier   the verified capability's resource is a sovereign asset id
 * load         the trusted store, for exactly that id
 * size         the bundle's UTF-8 length against the limit, before any parsing
 * verify       the trusted RSDK-01 verifier, expectedSovereignAssetId = resource
 * shape        only RSDK-01's verified result for exactly that asset passes
 * policy       the receiver's own decision: exactly { decision: 'eligible' } passes
 * ```
 *
 * ## Deadlines
 *
 * The three asynchronous stages share one budget: the configured deadline,
 * shortened to what is left of the capability's validity. A stage still
 * running when the budget is spent refuses with its own timeout code. This
 * is a deadline, not cancellation: the store, verifier or policy is not
 * stopped, and whatever it answers later is discarded unread.
 */

export type AssetGateOutcome =
  | { readonly ok: true; readonly asset: VerifiedSovereignAsset }
  | { readonly ok: false; readonly code: GovernedReceiverAssetRefusalCode; readonly assetRejection?: readonly string[]; readonly ineligibleReason?: string };

export interface AssetGateRequest {
  readonly action: string;
  /** The verified capability's resource. */
  readonly resource: string;
  /** The verified capability's expiry, ms since the epoch. */
  readonly expiresAtMs: number;
}

export interface AssetGate {
  evaluate(request: AssetGateRequest): Promise<AssetGateOutcome>;
}

export interface AssetGateOptions {
  readonly assets: SovereignAssetStore;
  readonly verifyAsset: SovereignAssetVerifier;
  readonly policy: SovereignAssetEligibilityPolicy;
  readonly maximumBundleBytes: number;
  readonly deadlineMs: number;
  readonly clock: () => number;
  readonly schedule: GovernedReceiverDeadlineScheduler;
}

const RSDK01_PROFILE = 'aoc-enterprise.strict-receiver-verification/1';

type Settled<T> = { readonly settled: 'value'; readonly value: T } | { readonly settled: 'error' } | { readonly settled: 'timeout' };

/** Runs `work` against the remaining budget. A synchronous throw is an error, never an escape. */
function withinDeadline<T>(work: () => T | Promise<T>, ms: number, schedule: GovernedReceiverDeadlineScheduler): Promise<Settled<T>> {
  if (!(ms > 0)) return Promise.resolve({ settled: 'timeout' });
  return new Promise((resolve) => {
    let done = false;
    const finish = (result: Settled<T>): void => {
      if (done) return;
      done = true;
      cancel();
      resolve(result);
    };
    const cancel = schedule(ms, () => finish({ settled: 'timeout' }));
    try {
      Promise.resolve(work()).then(
        (value) => finish({ settled: 'value', value }),
        () => finish({ settled: 'error' }),
      );
    } catch {
      finish({ settled: 'error' });
    }
  });
}

/** An own data property; an accessor or a missing key is `undefined`, so no getter runs. */
function data(record: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
}

const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/** The stored asset, read once into a snapshot; `undefined` when it is not a well-formed stored asset. */
function storedSnapshot(value: unknown): { readonly bundleText: string; readonly contentBytes?: Uint8Array } | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const bundleText = data(value, 'bundleText');
  const contentBytes = data(value, 'contentBytes');
  if (typeof bundleText !== 'string') return undefined;
  if (contentBytes !== undefined && !(contentBytes instanceof Uint8Array)) return undefined;
  return contentBytes === undefined ? { bundleText } : { bundleText, contentBytes };
}

/** UTF-8 length within `limit`, decided without encoding a string that is clearly too long. */
function withinBytes(text: string, limit: number): boolean {
  if (text.length > limit) return false; // every UTF-16 unit is at least one UTF-8 byte
  return Buffer.byteLength(text, 'utf8') <= limit;
}

function claimsOf(value: unknown): readonly VerifiedSovereignClaim[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const claims: VerifiedSovereignClaim[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) return undefined;
    const claimId = data(entry, 'claimId');
    const claimType = data(entry, 'claimType');
    const issuer = data(entry, 'issuer');
    const keyId = data(entry, 'keyId');
    if (!isText(claimId) || !isText(claimType) || !isText(issuer) || !isText(keyId)) return undefined;
    claims.push(Object.freeze({ claimId, claimType, issuer, keyId }));
  }
  return Object.freeze(claims);
}

function manifestsOf(value: unknown): readonly VerifiedSovereignManifest[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const manifests: VerifiedSovereignManifest[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) return undefined;
    const manifestVersion = data(entry, 'manifestVersion');
    const manifestDigest = data(entry, 'manifestDigest');
    const issuer = data(entry, 'issuer');
    const keyId = data(entry, 'keyId');
    const state = data(entry, 'state');
    if (!Number.isSafeInteger(manifestVersion) || !isText(manifestDigest) || !isText(issuer) || !isText(keyId) || !isText(state)) return undefined;
    manifests.push(Object.freeze({ manifestVersion: manifestVersion as number, manifestDigest, issuer, keyId, state }));
  }
  return Object.freeze(manifests);
}

/**
 * RSDK-01's answer, checked against its own contract: a verified result of
 * the strict receiver profile, for exactly `expected`, that evaluates no
 * authorization, revocation or freshness. Rejections carry their closed
 * reasons. Anything else is malformed.
 */
function readVerification(value: unknown, expected: string): { readonly kind: 'verified'; readonly asset: VerifiedSovereignAsset } | { readonly kind: 'rejected'; readonly reasons: readonly string[] } | { readonly kind: 'malformed' } {
  if (typeof value !== 'object' || value === null) return { kind: 'malformed' };
  if (data(value, 'profile') !== RSDK01_PROFILE) return { kind: 'malformed' };
  const notEvaluated = data(value, 'authorization') === 'not_evaluated' && data(value, 'revocation') === 'not_evaluated' && data(value, 'freshness') === 'not_evaluated';
  if (!notEvaluated) return { kind: 'malformed' };
  const outcome = data(value, 'outcome');
  if (outcome === 'rejected') {
    const reasons = data(value, 'reasons');
    if (!Array.isArray(reasons) || reasons.length === 0 || !reasons.every(isText)) return { kind: 'malformed' };
    return { kind: 'rejected', reasons: Object.freeze([...(reasons as string[])]) };
  }
  if (outcome !== 'verified') return { kind: 'malformed' };
  const reasons = data(value, 'reasons');
  const sovereignAssetId = data(value, 'sovereignAssetId');
  const currentManifestVersion = data(value, 'currentManifestVersion');
  const currentManifestBasis = data(value, 'currentManifestBasis');
  const currentIssuer = data(value, 'currentIssuer');
  const currentState = data(value, 'currentState');
  const contentIdentity = data(value, 'contentIdentity');
  const compatibility = data(value, 'compatibility');
  const standings = data(value, 'standings');
  const manifests = manifestsOf(data(value, 'manifests'));
  const claims = claimsOf(data(value, 'claims'));
  const wellFormed =
    Array.isArray(reasons) &&
    reasons.length === 0 &&
    sovereignAssetId === expected &&
    Number.isSafeInteger(currentManifestVersion) &&
    currentManifestBasis === 'highest_version_in_bundle' &&
    isText(currentIssuer) &&
    isText(currentState) &&
    (contentIdentity === 'verified' || contentIdentity === 'not_declared') &&
    compatibility === 'compatible' &&
    (standings === 'none' || standings === 'present_unverified') &&
    manifests !== undefined &&
    claims !== undefined &&
    // The current manifest is in the evidence, and is the one the summary names.
    manifests.some((manifest) => manifest.manifestVersion === currentManifestVersion && manifest.issuer === currentIssuer && manifest.state === currentState);
  if (!wellFormed) return { kind: 'malformed' };
  return {
    kind: 'verified',
    asset: Object.freeze({
      sovereignAssetId: expected,
      currentManifestVersion: currentManifestVersion as number,
      currentIssuer: currentIssuer as string,
      currentState: currentState as string,
      contentIdentity: contentIdentity as 'verified' | 'not_declared',
      standings: standings as 'none' | 'present_unverified',
      manifests,
      claims,
      authorization: 'not_evaluated' as const,
      revocation: 'not_evaluated' as const,
      freshness: 'not_evaluated' as const,
    }),
  };
}

/** Exactly `{ decision: 'eligible' }` or `{ decision: 'ineligible', reason }`, as own data; anything else is invalid. */
function readDecision(value: unknown): { readonly decision: 'eligible' } | { readonly decision: 'ineligible'; readonly reason: string } | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const keys = Reflect.ownKeys(value);
  const decision = data(value, 'decision');
  if (decision === 'eligible' && keys.length === 1) return { decision: 'eligible' };
  const reason = data(value, 'reason');
  if (decision === 'ineligible' && keys.length === 2 && isText(reason)) return { decision: 'ineligible', reason };
  return undefined;
}

export function createAssetGate(options: AssetGateOptions): AssetGate {
  const { assets, verifyAsset, policy, maximumBundleBytes, deadlineMs, clock, schedule } = options;
  if (!Number.isSafeInteger(maximumBundleBytes) || maximumBundleBytes < 1 || maximumBundleBytes > GOVERNED_RECEIVER_LIMITS.maximumBundleBytes) {
    throw new Error(`maximumBundleBytes must be an integer from 1 to ${GOVERNED_RECEIVER_LIMITS.maximumBundleBytes}.`);
  }
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > GOVERNED_RECEIVER_LIMITS.maximumAssetDeadlineMs) {
    throw new Error(`The asset deadline must be an integer from 1 to ${GOVERNED_RECEIVER_LIMITS.maximumAssetDeadlineMs} ms.`);
  }
  const refused = (code: GovernedReceiverAssetRefusalCode): AssetGateOutcome => Object.freeze({ ok: false as const, code });

  async function evaluate(request: AssetGateRequest): Promise<AssetGateOutcome> {
    const { action, resource } = request;
    // ── identifier ──
    if (!isSovereignAssetIdentifier(resource)) return refused('ASSET_IDENTIFIER_INVALID');

    // One budget for the three asynchronous stages, never past the capability's expiry.
    const startedAt = clock();
    const budgetEnd = Math.min(startedAt + deadlineMs, request.expiresAtMs);
    const remaining = (): number => budgetEnd - clock();

    // ── load ──
    const loaded = await withinDeadline<StoredSovereignAsset | undefined>(() => assets.load(resource, Object.freeze({ maximumBundleBytes })), remaining(), schedule);
    if (loaded.settled === 'timeout') return refused('ASSET_STORE_TIMEOUT');
    if (loaded.settled === 'error') return refused('ASSET_STORE_FAILED');
    if (loaded.value === undefined) return refused('ASSET_NOT_FOUND');
    let stored: ReturnType<typeof storedSnapshot>;
    try {
      stored = storedSnapshot(loaded.value);
    } catch {
      stored = undefined;
    }
    if (stored === undefined) return refused('ASSET_MALFORMED');

    // ── size, before RSDK-01 parses anything ──
    if (!withinBytes(stored.bundleText, maximumBundleBytes)) return refused('ASSET_TOO_LARGE');

    // ── verify ──
    const verificationRequest = Object.freeze(stored.contentBytes === undefined ? { expectedSovereignAssetId: resource } : { expectedSovereignAssetId: resource, contentBytes: stored.contentBytes });
    const verified = await withinDeadline(() => verifyAsset(stored.bundleText, verificationRequest), remaining(), schedule);
    if (verified.settled === 'timeout') return refused('ASSET_VERIFICATION_TIMEOUT');
    if (verified.settled === 'error') return refused('ASSET_VERIFICATION_FAILED');
    let reading: ReturnType<typeof readVerification>;
    try {
      reading = readVerification(verified.value, resource);
    } catch {
      reading = { kind: 'malformed' };
    }
    if (reading.kind === 'malformed') return refused('ASSET_VERIFICATION_MALFORMED');
    if (reading.kind === 'rejected') return Object.freeze({ ok: false as const, code: 'ASSET_REJECTED' as const, assetRejection: reading.reasons });
    const asset = reading.asset;

    // ── policy ──
    const input = Object.freeze({ action, resource, asset });
    const decided = await withinDeadline(() => policy(input), remaining(), schedule);
    if (decided.settled === 'timeout') return refused('ASSET_POLICY_TIMEOUT');
    if (decided.settled === 'error') return refused('ASSET_POLICY_FAILED');
    let decision: ReturnType<typeof readDecision>;
    try {
      decision = readDecision(decided.value);
    } catch {
      decision = undefined;
    }
    if (decision === undefined) return refused('ASSET_POLICY_INVALID');
    if (decision.decision === 'ineligible') return Object.freeze({ ok: false as const, code: 'ASSET_INELIGIBLE' as const, ineligibleReason: decision.reason });
    return Object.freeze({ ok: true as const, asset });
  }

  return Object.freeze({ evaluate });
}

/** The default scheduler: a timer that never keeps the process alive on its own. */
export const defaultDeadlineScheduler: GovernedReceiverDeadlineScheduler = (ms, fire) => {
  const timer = setTimeout(fire, ms);
  timer.unref();
  return () => clearTimeout(timer);
};
