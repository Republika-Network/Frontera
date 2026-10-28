import type { ObservedHttpRequest } from '../reference-executor/admission.js';
import { createReferenceExecutorExecutionFlow, type ReferenceExecutorExecution } from '../reference-executor/execution-flow.js';
import { referenceExecutorStatusOf } from '../reference-executor/gateway.js';
import {
  createReferenceExecutorVerificationPipeline,
  type ReferenceExecutorAssessment,
  type ReferenceExecutorAssessmentCode,
  type ReferenceExecutorEligibleCapability,
  type ReferenceExecutorStage,
  type ReferenceExecutorVerificationPipeline,
} from '../reference-executor/verification-pipeline.js';
import { createAssetGate, defaultDeadlineScheduler, type AssetGateOutcome } from './asset-gate.js';
import {
  GOVERNED_RECEIVER_LIMITS,
  GOVERNED_RECEIVER_MODE,
  isSovereignAssetIdentifier,
  type GovernedReceiverAnswer,
  type GovernedReceiverAssetRefusal,
  type GovernedSovereignReceiver,
  type GovernedSovereignReceiverOptions,
} from './contracts.js';

/**
 * RSDK-02B — the governed sovereign receiver.
 *
 * ```
 * verify     the existing G-02C1A pipeline: admission, credential, presentation, policy, binding rebuilt
 *            from the received bytes, G-02A verification under pinned issuer keys, eligibility. Its one
 *            static check, the resource allow-list, is replaced by the sovereign identifier rule.
 * consumed   by the verified capability and execution ids: an already-consumed capability skips the
 *            asset gate and gets the existing flow's already-consumed answer from durable state
 * asset      the asset gate (asset-gate.ts): load, size, RSDK-01, the receiver's policy — for the
 *            verified capability's resource, and only for an unconsumed synthetic action
 * execute    the existing G-02C1B flow, unchanged, given exactly the verdict computed above: durable
 *            claim, expiry re-check, the one synthetic effect, the forward-only outcome, the receipt
 * ```
 *
 * ## Why the order is safe
 *
 * Nothing is claimed until both the capability and the asset have passed, so
 * a refused asset never spends the authority. The asset stages are the only
 * awaited ones and they run before the claim; the claim itself re-checks the
 * capability's expiry, and the flow re-checks it again before the effect.
 * From the claim to the recorded outcome the existing flow awaits nothing.
 *
 * ## What it never does
 *
 * It mints, signs or holds no capability and no Host key. It does not retry
 * the effect, release a claim or turn an uncertain outcome into a success.
 * A request cannot select the verifier, the policy, the store or the effect.
 * Single use is per consumption ledger: one ledger, one domain.
 */

/** The status a refusal at `stage` with `code` gets — the reference gateway's own mapping. */
function refusedStatusOf(stage: ReferenceExecutorStage, code: ReferenceExecutorAssessmentCode): number {
  return referenceExecutorStatusOf(Object.freeze({ mode: 'verification-only' as const, outcome: 'refused' as const, stage, code, bindingDigest: null }));
}

/** Store and verifier outages are retryable (nothing was consumed); every other asset refusal is final. */
function assetRefusalStatus(code: GovernedReceiverAssetRefusal['code']): number {
  return code.endsWith('_TIMEOUT') || code.endsWith('_FAILED') ? 503 : 403;
}

const PINNED_REFUSAL = Object.freeze({
  assessment: Object.freeze({ mode: 'verification-only' as const, outcome: 'refused' as const, stage: 'verification' as const, code: 'EXECUTOR_FAILURE' as const, bindingDigest: null }) as ReferenceExecutorAssessment,
});

/**
 * A pipeline that answers, once and only for `observed`, with the verdict
 * already computed for it. The existing flow verifies through its pipeline;
 * this makes that the verification the asset gate ran after, not a second one
 * on a clock that has moved.
 *
 * It is safe because the existing flow reads the request only through its
 * pipeline: the claim, the effect and the receipt are derived from the
 * verified capability and its binding digest, never from the request again.
 * The pipeline and the flow are built per request and discarded with it, so
 * no verdict outlives its request. rsdk02-governed-receiver.test.ts pins both
 * (interleaved requests, concurrent duplicates, mutation while suspended).
 */
function pinnedPipeline(
  observed: ObservedHttpRequest,
  verdict: { readonly assessment: ReferenceExecutorAssessment; readonly eligible?: ReferenceExecutorEligibleCapability },
): ReferenceExecutorVerificationPipeline {
  let used = false;
  return Object.freeze({
    assess: (request: ObservedHttpRequest) => (request === observed ? verdict.assessment : PINNED_REFUSAL.assessment),
    verifyForExecution: (request: ObservedHttpRequest) => {
      if (request !== observed || used) return PINNED_REFUSAL;
      used = true;
      return verdict;
    },
  });
}

export function createGovernedSovereignReceiver(options: GovernedSovereignReceiverOptions): GovernedSovereignReceiver {
  // Read once: a later change to the options object changes nothing.
  const { configuration, ledger, effect, clock, receipts, fault, assets, verifyAsset, policy } = options;
  const limits = options.limits ?? {};
  const synthetic = configuration.syntheticExecution;
  if (configuration.mode !== 'synthetic-execution' || synthetic === null) throw new Error('The governed receiver runs only in synthetic-execution mode.');
  if (ledger.audience !== configuration.audience) throw new Error('The consumption ledger is pinned to another audience.');
  if (typeof clock !== 'function' || typeof verifyAsset !== 'function' || typeof policy !== 'function' || typeof assets?.load !== 'function') {
    throw new Error('The governed receiver needs a clock, an asset store, an asset verifier and a policy.');
  }
  const syntheticActions = synthetic.syntheticActions;
  const pipeline = createReferenceExecutorVerificationPipeline(configuration, clock, { resourcePermitted: isSovereignAssetIdentifier });
  const gate = createAssetGate({
    assets,
    verifyAsset,
    policy,
    maximumBundleBytes: limits.maximumBundleBytes ?? GOVERNED_RECEIVER_LIMITS.maximumBundleBytes,
    deadlineMs: limits.assetDeadlineMs ?? GOVERNED_RECEIVER_LIMITS.defaultAssetDeadlineMs,
    clock,
    schedule: options.schedule ?? defaultDeadlineScheduler,
  });

  function refusalOf(outcome: Extract<AssetGateOutcome, { ok: false }>, bindingDigest: string): GovernedReceiverAnswer {
    const record: GovernedReceiverAssetRefusal = Object.freeze({
      mode: GOVERNED_RECEIVER_MODE,
      outcome: 'refused',
      stage: outcome.code.startsWith('ASSET_POLICY') || outcome.code === 'ASSET_INELIGIBLE' ? 'policy' : 'asset',
      code: outcome.code,
      bindingDigest,
      ledgerState: null,
      assetRejection: outcome.assetRejection ?? null,
      ineligibleReason: outcome.ineligibleReason ?? null,
    });
    return Object.freeze({ record, status: assetRefusalStatus(outcome.code), headers: Object.freeze({}) });
  }

  /** The ledger cannot say whether this capability was consumed: nothing is performed, and nothing is stated as final. */
  function unavailable(digest: string): GovernedReceiverAnswer {
    const record: ReferenceExecutorExecution = Object.freeze({ mode: 'synthetic-execution' as const, outcome: 'claim-unavailable' as const, stage: 'claim' as const, code: 'LEDGER_UNAVAILABLE' as const, bindingDigest: digest, ledgerState: null });
    return Object.freeze({ record, status: 503, headers: Object.freeze({}) });
  }

  /** When the existing flow throws, what the ledger says decides the answer: a committed claim is never reported as nothing. */
  function conservative(capabilityId: string | undefined, bindingDigest: string | null): GovernedReceiverAnswer {
    let state: 'absent' | ReferenceExecutorExecution['ledgerState'] = 'absent';
    if (capabilityId !== undefined) {
      try {
        const read = ledger.read(capabilityId);
        state = read.state === 'absent' ? 'absent' : read.state;
      } catch {
        state = 'claimed'; // cannot tell: assume the worst
      }
    }
    const record: ReferenceExecutorExecution =
      state === 'absent'
        ? Object.freeze({ mode: 'synthetic-execution' as const, outcome: 'refused' as const, stage: 'verification' as const, code: 'EXECUTOR_FAILURE' as const, bindingDigest: null, ledgerState: null })
        : Object.freeze({ mode: 'synthetic-execution' as const, outcome: 'attempted-outcome-unknown' as const, stage: 'outcome' as const, code: 'OUTCOME_NOT_RECORDED' as const, bindingDigest, ledgerState: state });
    return Object.freeze({ record, status: state === 'absent' ? 403 : 502, headers: Object.freeze({}) });
  }

  async function handle(observed: ObservedHttpRequest): Promise<GovernedReceiverAnswer> {
    let capabilityId: string | undefined;
    let bindingDigest: string | null = null;
    try {
      // ── verify: the existing pipeline, once ──
      const verdict = pipeline.verifyForExecution(observed);
      const eligible = verdict.eligible;

      // ── asset: only for a capability that verified and would reach the synthetic effect ──
      if (eligible !== undefined && syntheticActions.includes(eligible.capability.action)) {
        const capability = eligible.capability;
        bindingDigest = eligible.bindingDigest;
        capabilityId = capability.capabilityId;
        // ── prior consumption, by the verified identities only ──
        // A capability (or its execution) this ledger already consumed may have been attempted. Its answer is the
        // existing flow's already-consumed one, from durable state; current asset eligibility must never turn that
        // into a definitive refusal, and nothing is loaded, verified or decided again. The atomic claim stays the
        // race-safe enforcement point: an unconsumed capability is still claimed below, or refused there.
        let consumed: boolean;
        try {
          consumed = ledger.read(capability.capabilityId).state !== 'absent' || ledger.readExecution(capability.issuer, capability.executionId).state !== 'absent';
        } catch {
          return unavailable(eligible.bindingDigest);
        }
        if (!consumed) {
          const outcome = await gate.evaluate({ action: capability.action, resource: capability.resource, expiresAtMs: Date.parse(capability.expiresAt) });
          if (!outcome.ok) return refusalOf(outcome, eligible.bindingDigest);
        }
      }

      // ── execute: the existing flow, over exactly this verdict ──
      const flow = createReferenceExecutorExecutionFlow({
        configuration,
        pipeline: pinnedPipeline(observed, verdict),
        ledger,
        effect,
        clock,
        ...(fault !== undefined ? { fault } : {}),
        ...(receipts !== undefined ? { receipts } : {}),
      });
      const record = flow.execute(observed);
      return Object.freeze({ record, status: flow.statusOf(record, refusedStatusOf), headers: flow.answerHeadersOf?.(record) ?? Object.freeze({}) });
    } catch {
      return conservative(capabilityId, bindingDigest);
    }
  }

  return Object.freeze({ handle });
}
