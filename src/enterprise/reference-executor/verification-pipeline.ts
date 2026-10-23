import { createHash, timingSafeEqual } from 'node:crypto';

import {
  createExecutionCapabilityVerifier,
  executionCapabilityActionBindingDigest,
  parseExecutionCapability,
  readVerifiedExecutionCapability,
  type ExecutionCapabilityVerificationFailure,
} from '../execution-capability/index.js';
import { decodeExecutionCapabilityPresentation, type ExecutionCapabilityPresentationFailure } from '../execution-capability-presentation/index.js';
import { admitHttpRequest, type ObservedHttpRequest, type ReferenceExecutorAdmissionRefusal } from './admission.js';
import { REFERENCE_EXECUTOR_HTTP_BINDING_FORMAT, reconstructHttpRequestBinding } from './binding-reconstruction.js';
import type { ReferenceExecutorConfiguration } from './configuration.js';

/**
 * G-02C1A — the reference executor's **verification-only** pipeline.
 *
 * ```
 * 1 admission      the request as this executor's HTTP parser received it
 * 2 credential     the gateway client credential, constant-time
 * 3 presentation   the one presentation header, decoded (codec; no signature check)
 * 4 policy         pinned issuer, audience, organization, trust domain, action and resource allow-lists, binding format
 * 5 binding        frontera.http-request-binding.v1, rebuilt from the received request
 * 6 verification   the standalone G-02A verifier, with the rebuilt record and pinned keys
 * 7 eligibility    offline-permitted only; status-required is never eligible before G-02D
 * 8 assessment     returned — nothing is claimed, consumed or performed
 * ```
 *
 * ## Four questions this answers, and three it never does
 *
 * It answers: is the capability signature valid under a pinned key; does this
 * executor's own policy accept it; does it bind exactly the received request;
 * and would it be eligible to be claimed. `assessed-eligible` is that last
 * assessment and nothing more. This pipeline holds no ledger and no effect
 * handler, so it never claims a capability, never performs anything, and never
 * produces a receipt (G-02C1B, G-02C1C).
 *
 * Every step refuses outright with a closed code; none falls through to a
 * weaker one. A throw anywhere is `EXECUTOR_FAILURE`, never a pass. The
 * assessment carries no credential, capability text, header value or body.
 */

export const REFERENCE_EXECUTOR_STAGES = Object.freeze(['admission', 'credential', 'presentation', 'policy', 'binding', 'verification', 'eligibility'] as const);
export type ReferenceExecutorStage = (typeof REFERENCE_EXECUTOR_STAGES)[number];

export type ReferenceExecutorPolicyRefusal =
  | 'BINDING_FORMAT_NOT_PERMITTED'
  | 'ISSUER_NOT_PINNED'
  | 'AUDIENCE_NOT_THIS_EXECUTOR'
  | 'ORGANIZATION_NOT_PERMITTED'
  | 'TRUST_DOMAIN_NOT_PERMITTED'
  | 'ACTION_NOT_PERMITTED'
  | 'RESOURCE_NOT_PERMITTED';

export type ReferenceExecutorAssessmentCode =
  | ReferenceExecutorAdmissionRefusal
  | 'CLIENT_UNAUTHENTICATED'
  | ExecutionCapabilityPresentationFailure
  | ReferenceExecutorPolicyRefusal
  | 'FRAMING_UNEXPECTED'
  | 'BINDING_UNREPRESENTABLE'
  | ExecutionCapabilityVerificationFailure
  | 'STATUS_REQUIRED_UNAVAILABLE'
  | 'VERIFICATION_ONLY'
  | 'EXECUTOR_FAILURE';

/**
 * What the executor concluded. `mode` is always `verification-only`.
 * `assessed-eligible` means "would be eligible to be claimed", never "claimed"
 * and never "performed".
 */
export interface ReferenceExecutorAssessment {
  readonly mode: 'verification-only';
  readonly outcome: 'refused' | 'assessed-ineligible' | 'assessed-eligible';
  readonly stage: ReferenceExecutorStage;
  readonly code: ReferenceExecutorAssessmentCode;
  /** The digest of the record this executor rebuilt, only once a capability verified against it (assessed outcomes); otherwise `null`. Never a digest taken from the request. */
  readonly bindingDigest: string | null;
}

export interface ReferenceExecutorVerificationPipeline {
  assess(observed: ObservedHttpRequest): ReferenceExecutorAssessment;
}

function assessment(outcome: ReferenceExecutorAssessment['outcome'], stage: ReferenceExecutorStage, code: ReferenceExecutorAssessmentCode, bindingDigest: string | null = null): ReferenceExecutorAssessment {
  return Object.freeze({ mode: 'verification-only' as const, outcome, stage, code, bindingDigest });
}

/** Constant-time comparison of the presented credential with the configured digest. */
function credentialMatches(presented: string, expectedDigest: string): boolean {
  const actual = createHash('sha256').update(presented, 'utf8').digest();
  const expected = Buffer.from(expectedDigest, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function createReferenceExecutorVerificationPipeline(configuration: ReferenceExecutorConfiguration, clock: () => number): ReferenceExecutorVerificationPipeline {
  const verifier = createExecutionCapabilityVerifier({
    trustedIssuers: configuration.trustedIssuers,
    executor: { audience: configuration.audience, organizationIds: configuration.organizationIds, trustDomain: configuration.trustDomain },
    clock,
    maximumLifetimeMs: configuration.maximumLifetimeMs,
    maximumClockSkewMs: configuration.maximumClockSkewMs,
  });
  const pinnedIssuers = configuration.trustedIssuers.map((entry) => entry.issuer);
  const admissionPolicy = Object.freeze({ authority: configuration.origin.authority, methods: configuration.methods, credentialHeader: configuration.credential.header });

  function assess(observed: ObservedHttpRequest): ReferenceExecutorAssessment {
    try {
      // 1 — admission
      const admission = admitHttpRequest(observed, admissionPolicy);
      if (!admission.ok) return assessment('refused', 'admission', admission.refusal);
      const request = admission.request;

      // 2 — the gateway client credential
      const authenticated = credentialMatches(request.credential, configuration.credential.expectedDigest);
      if (!authenticated) return assessment('refused', 'credential', 'CLIENT_UNAUTHENTICATED');

      // 3 — the presentation (structure only)
      const decoded = decodeExecutionCapabilityPresentation(request.presentation);
      if (!decoded.ok) return assessment('refused', 'presentation', decoded.failure);
      const presentation = decoded.presentation;
      const parsed = parseExecutionCapability(presentation.capability);
      if (!parsed.ok) return assessment('refused', 'presentation', 'PRESENTATION_CAPABILITY_INVALID');
      const capability = parsed.capability;

      // 4 — this executor's own policy, over the (not yet verified) capability: early, specific refusals; step 6 decides
      const formatPermitted = configuration.bindingFormats.includes(presentation.bindingFormat);
      if (!formatPermitted) return assessment('refused', 'policy', 'BINDING_FORMAT_NOT_PERMITTED');
      if (!pinnedIssuers.includes(capability.issuer)) return assessment('refused', 'policy', 'ISSUER_NOT_PINNED');
      if (capability.audience !== configuration.audience) return assessment('refused', 'policy', 'AUDIENCE_NOT_THIS_EXECUTOR');
      if (!configuration.organizationIds.includes(capability.organizationId)) return assessment('refused', 'policy', 'ORGANIZATION_NOT_PERMITTED');
      if (capability.trustDomain !== configuration.trustDomain) return assessment('refused', 'policy', 'TRUST_DOMAIN_NOT_PERMITTED');
      const actionPermitted = configuration.permittedActions.includes(capability.action);
      if (!actionPermitted) return assessment('refused', 'policy', 'ACTION_NOT_PERMITTED');
      const resourcePermitted = configuration.permittedResources.includes(capability.resource);
      if (!resourcePermitted) return assessment('refused', 'policy', 'RESOURCE_NOT_PERMITTED');

      // 5 — the binding, rebuilt from what was received
      const reconstruction = reconstructHttpRequestBinding(request, configuration.origin, configuration.credential.header);
      if (!reconstruction.ok) return assessment('refused', 'binding', reconstruction.refusal);
      const bindingValue = reconstruction.binding;
      let bindingDigest: string;
      try {
        bindingDigest = executionCapabilityActionBindingDigest({ format: REFERENCE_EXECUTOR_HTTP_BINDING_FORMAT, value: bindingValue });
      } catch {
        return assessment('refused', 'binding', 'BINDING_UNREPRESENTABLE');
      }

      // 6 — G-02A, standalone: pinned keys, this executor's context, the rebuilt record
      const verification = verifier.verify({
        presentation: { capability: presentation.capability, signature: { ...presentation.signature } },
        action: capability.action,
        resource: capability.resource,
        actionBinding: { format: REFERENCE_EXECUTOR_HTTP_BINDING_FORMAT, value: bindingValue },
      });
      // No digest on a refusal: the record holds every header value, so a caller must not get to test guesses against it.
      if (verification.verification !== 'verified') return assessment('refused', 'verification', verification.failure);

      // 7 — eligibility: a verified result of this runtime's verifier, offline-permitted, under the offline-only policy
      const verified = readVerifiedExecutionCapability(verification);
      const eligible = verified !== undefined && verified.consumptionEligible && verified.capability.statusRequirement === 'offline-permitted' && configuration.statusPolicy === 'offline-only';
      if (!eligible) return assessment('assessed-ineligible', 'eligibility', 'STATUS_REQUIRED_UNAVAILABLE', bindingDigest);

      // 8 — an assessment, not an act
      return assessment('assessed-eligible', 'eligibility', 'VERIFICATION_ONLY', bindingDigest);
    } catch {
      return assessment('refused', 'verification', 'EXECUTOR_FAILURE');
    }
  }

  return Object.freeze({ assess });
}
