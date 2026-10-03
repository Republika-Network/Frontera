import type { GovernanceRecord } from '../governance-store/contracts.js';
import { computeDigest } from '../governance-store/digest.js';
import { EVIDENCE_BUNDLE_SCHEMA_VERSION, EVIDENCE_BUNDLE_SCHEMA_VERSION_V2, type EvidenceBundle, type EvidenceFieldKey, type EvidenceIntegrityFailure, type EvidenceVerificationResult } from './contracts.js';
import { bundleDigestInput, bundleDigestInputV2, verificationDigestInput, verificationDigestInputV2 } from './projector.js';
import { findDisclosurePolicyById } from './disclosure-policies.js';
import type { AuthorityTraceVerification } from './trace-contracts.js';
import { compareDisclosedTraces, disclosedTraceDigest, findDisclosurePolicyV2ById, type DisclosedAuthorityTrace, type EvidenceFieldKeyV2 } from './trace-disclosure.js';

/**
 * The Evidence Verifier (mission section "Verification"). Answers, without
 * ever trusting a stored digest at face value:
 *
 * - Does this Bundle's content match its own claimed digest? (`bundleDigest`)
 * - Does its digest binding hold together? (`verificationDigest`)
 * - Does it match the Governance Record it claims to project, when one is
 *   supplied? (`recordDigest`)
 * - Does its disclosure policy match a real, registered policy? (`policyMatch`)
 * - Is it missing any field its own policy requires? (`complete`)
 * - Is its `bundleVersion` one this build understands? (`versionSupported`)
 */

function fieldValue(bundle: EvidenceBundle, field: EvidenceFieldKey): unknown {
  switch (field) {
    case 'source.organizationId':
      return bundle.source.organizationId;
    case 'subject.actionType':
      return bundle.subject.actionType;
    case 'subject.resourceScope':
      return bundle.subject.resourceScope;
    case 'subject.description':
      return bundle.subject.description;
    case 'evidence.status':
      return bundle.evidence.status;
    case 'evidence.summary':
      return bundle.evidence.summary;
    case 'evidence.reasonCodes':
      return bundle.evidence.reasonCodes;
    case 'evidence.trace':
      return bundle.evidence.trace;
    case 'evidence.events':
      return bundle.evidence.events;
    case 'evidence.metadata':
      return bundle.evidence.metadata;
  }
}

function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * What the canonical records say now, for a v2 bundle: the trace rebuilt from
 * them, disclosed under the bundle's own policy, and its structured
 * verification. Absent when it could not be rebuilt.
 */
export interface EvidenceBundleCurrentTrace {
  readonly disclosed: DisclosedAuthorityTrace;
  readonly verification: AuthorityTraceVerification;
}

export interface VerifyEvidenceBundleOptions {
  readonly record?: GovernanceRecord;
  readonly now: () => string;
  /** v2 only. */
  readonly currentTrace?: EvidenceBundleCurrentTrace;
}

export function verifyEvidenceBundle(bundle: EvidenceBundle, options: VerifyEvidenceBundleOptions): EvidenceVerificationResult {
  if (bundle.bundleVersion === EVIDENCE_BUNDLE_SCHEMA_VERSION_V2) return verifyEvidenceBundleV2(bundle, options);
  const failures: EvidenceIntegrityFailure[] = [];

  // -- bundle content integrity --
  const { integrity, ...withoutIntegrity } = bundle;
  const recomputedBundleDigest = computeDigest(bundleDigestInput(withoutIntegrity));
  const bundleDigestOk = recomputedBundleDigest === integrity.bundleDigest;
  if (!bundleDigestOk) {
    failures.push({ check: 'bundleDigest', message: 'Recomputed bundle digest does not match integrity.bundleDigest; the Bundle content was modified after it was built.' });
  }

  // -- digest binding (bundleDigest + recordDigest + policy identity) --
  const recomputedVerificationDigest = computeDigest(
    verificationDigestInput({
      bundleDigest: recomputedBundleDigest,
      recordDigest: integrity.recordDigest,
      policyId: bundle.disclosure.policyId,
      policyVersion: bundle.disclosure.policyVersion,
      bundleVersion: bundle.bundleVersion,
    }),
  );
  const verificationDigestOk = recomputedVerificationDigest === integrity.verificationDigest;
  if (!verificationDigestOk) {
    failures.push({ check: 'verificationDigest', message: 'Recomputed verification digest does not match integrity.verificationDigest; the digest binding between bundle, record, and policy is broken.' });
  }

  // -- match against the source Governance Record, when supplied --
  let recordDigestOk: boolean | undefined;
  if (options.record !== undefined) {
    recordDigestOk = options.record.integrity.aggregateDigest === integrity.recordDigest;
    if (!recordDigestOk) {
      failures.push({ check: 'recordDigest', message: 'integrity.recordDigest does not match the aggregateDigest of the supplied Governance Record.' });
    }
    if (options.record.evaluation.evaluationId !== bundle.source.evaluationId) {
      recordDigestOk = false;
      failures.push({ check: 'recordDigest', message: 'The supplied Governance Record is not the one this Bundle claims as its source (evaluationId mismatch).' });
    }
  }

  // -- disclosure policy match --
  const registeredPolicy = findDisclosurePolicyById(bundle.disclosure.policyId);
  let policyMatchOk = registeredPolicy !== undefined;
  if (registeredPolicy === undefined) {
    failures.push({ check: 'policyMatch', message: `disclosure.policyId '${bundle.disclosure.policyId}' does not name a registered DisclosurePolicy.` });
  } else {
    if (registeredPolicy.level !== bundle.disclosure.level) {
      policyMatchOk = false;
      failures.push({ check: 'policyMatch', message: `disclosure.level '${bundle.disclosure.level}' does not match the registered level '${registeredPolicy.level}' for policy '${bundle.disclosure.policyId}'.` });
    }
    if (registeredPolicy.version !== bundle.disclosure.policyVersion) {
      policyMatchOk = false;
      failures.push({ check: 'policyMatch', message: `disclosure.policyVersion '${bundle.disclosure.policyVersion}' does not match the registered version '${registeredPolicy.version}'.` });
    }
    if (!sameStringArray(registeredPolicy.visibleFields, bundle.disclosure.visibleFields) ||
      !sameStringArray(registeredPolicy.hiddenFields, bundle.disclosure.hiddenFields) ||
      !sameStringArray(registeredPolicy.redactedFields, bundle.disclosure.redactedFields)) {
      policyMatchOk = false;
      failures.push({ check: 'policyMatch', message: `The Bundle's disclosed field classification does not match the registered policy '${bundle.disclosure.policyId}'.` });
    }
  }

  // -- completeness against the policy's own required fields --
  let completeOk = true;
  if (registeredPolicy !== undefined) {
    for (const field of registeredPolicy.requiredFields) {
      if (fieldValue(bundle, field) === undefined) {
        completeOk = false;
        failures.push({ check: 'complete', message: `Required field '${field}' (per disclosure policy '${bundle.disclosure.policyId}') is missing from this Bundle.` });
      }
    }
  } else {
    completeOk = false;
  }

  // -- version --
  let versionSupportedOk = bundle.bundleVersion === EVIDENCE_BUNDLE_SCHEMA_VERSION;
  if (!versionSupportedOk) {
    failures.push({ check: 'versionSupported', message: `bundleVersion '${bundle.bundleVersion}' is not supported by this build (expected '${EVIDENCE_BUNDLE_SCHEMA_VERSION}' or '${EVIDENCE_BUNDLE_SCHEMA_VERSION_V2}').` });
  } else if (bundle.trace !== undefined || bundle.integrity.traceDigest !== undefined) {
    // ASSURE-01: a v1 digest does not cover a trace, so a trace attached to a
    // v1 bundle is unauthenticated content — refused, never believed.
    versionSupportedOk = false;
    failures.push({ check: 'versionSupported', message: 'A v1 bundle carries v2 trace content its digests do not cover.' });
  }

  return {
    bundleId: bundle.bundleId,
    valid: failures.length === 0,
    checks: {
      bundleDigest: bundleDigestOk,
      verificationDigest: verificationDigestOk,
      ...(recordDigestOk !== undefined ? { recordDigest: recordDigestOk } : {}),
      policyMatch: policyMatchOk,
      versionSupported: versionSupportedOk,
      complete: completeOk,
    },
    verifiedAt: options.now(),
    failures,
  };
}

function fieldValueV2(bundle: EvidenceBundle, field: EvidenceFieldKeyV2): unknown {
  if (!field.startsWith('trace.')) return fieldValue(bundle, field as EvidenceFieldKey);
  if (field === 'trace.summary') return bundle.trace?.summary;
  const stage = field.slice('trace.'.length);
  return (bundle.trace?.stages as Record<string, unknown> | undefined)?.[stage];
}

/**
 * ASSURE-01 — verifies a v2 (trace-bearing) bundle. Everything v1 checks, plus:
 * the carried trace recomputes to `integrity.traceDigest`, the digest binding
 * covers it, the canonical trace rebuilt now does not contradict it, and that
 * canonical trace itself verifies. Integrity and freshness are reported apart:
 * a bundle whose request has since moved on is `valid` and
 * `superseded-by-later-facts`, never silently re-dated.
 */
function verifyEvidenceBundleV2(bundle: EvidenceBundle, options: VerifyEvidenceBundleOptions): EvidenceVerificationResult {
  const failures: EvidenceIntegrityFailure[] = [];
  const { integrity, ...withoutIntegrity } = bundle;

  const recomputedBundleDigest = computeDigest(bundleDigestInputV2(withoutIntegrity));
  const bundleDigestOk = recomputedBundleDigest === integrity.bundleDigest;
  if (!bundleDigestOk) failures.push({ check: 'bundleDigest', message: 'Recomputed bundle digest does not match integrity.bundleDigest; the Bundle content was modified after it was built.' });

  const trace = bundle.trace;
  const recomputedTraceDigest = trace === undefined ? undefined : disclosedTraceDigest(trace);
  const traceDigestOk = recomputedTraceDigest !== undefined && recomputedTraceDigest === integrity.traceDigest;
  if (!traceDigestOk) failures.push({ check: 'traceDigest', message: 'The carried trace is absent or does not recompute to integrity.traceDigest.' });

  const recomputedVerificationDigest = computeDigest(
    verificationDigestInputV2({
      bundleDigest: recomputedBundleDigest,
      recordDigest: integrity.recordDigest,
      traceDigest: recomputedTraceDigest ?? '',
      policyId: bundle.disclosure.policyId,
      policyVersion: bundle.disclosure.policyVersion,
      bundleVersion: bundle.bundleVersion,
    }),
  );
  const verificationDigestOk = recomputedVerificationDigest === integrity.verificationDigest;
  if (!verificationDigestOk) failures.push({ check: 'verificationDigest', message: 'Recomputed verification digest does not match integrity.verificationDigest; the binding between bundle, record, trace and policy is broken.' });

  let recordDigestOk: boolean | undefined;
  if (options.record !== undefined) {
    recordDigestOk = options.record.integrity.aggregateDigest === integrity.recordDigest && options.record.evaluation.evaluationId === bundle.source.evaluationId && options.record.request.requestId === bundle.source.requestId;
    if (!recordDigestOk) failures.push({ check: 'recordDigest', message: 'The bundle does not match the Governance Record of its request (digest or identity).' });
  }
  if (trace !== undefined && (trace.requestId !== bundle.source.requestId || trace.evaluationId !== bundle.source.evaluationId || trace.decisionId !== bundle.source.decisionId)) {
    failures.push({ check: 'traceDigest', message: 'The carried trace names a different request, evaluation or decision than the bundle source.' });
  }

  const registered = findDisclosurePolicyV2ById(bundle.disclosure.policyId);
  let policyMatchOk = registered !== undefined;
  if (registered === undefined) failures.push({ check: 'policyMatch', message: `disclosure.policyId '${bundle.disclosure.policyId}' does not name a registered v2 DisclosurePolicy.` });
  else if (
    registered.level !== bundle.disclosure.level ||
    registered.version !== bundle.disclosure.policyVersion ||
    !sameStringArray(registered.visibleFields, bundle.disclosure.visibleFields) ||
    !sameStringArray(registered.hiddenFields, bundle.disclosure.hiddenFields) ||
    !sameStringArray(registered.redactedFields, bundle.disclosure.redactedFields)
  ) {
    policyMatchOk = false;
    failures.push({ check: 'policyMatch', message: `The Bundle's disclosure metadata does not match the registered policy '${bundle.disclosure.policyId}'.` });
  }

  let completeOk = registered !== undefined;
  if (registered !== undefined) {
    for (const field of registered.requiredFields) {
      if (fieldValueV2(bundle, field) === undefined) {
        completeOk = false;
        failures.push({ check: 'complete', message: `Required field '${field}' (per disclosure policy '${bundle.disclosure.policyId}') is missing from this Bundle.` });
      }
    }
    // A hidden field must be absent: a hidden stage that reappears is a disclosure breach, not extra evidence.
    for (const field of registered.hiddenFields) {
      if (field.startsWith('trace.') && fieldValueV2(bundle, field) !== undefined) {
        policyMatchOk = false;
        failures.push({ check: 'policyMatch', message: `Field '${field}' is hidden by policy '${bundle.disclosure.policyId}' but present in this Bundle.` });
      }
    }
  }

  let traceConsistent: boolean | undefined;
  let freshness: EvidenceVerificationResult['freshness'] = 'unknown';
  let comparison: ReturnType<typeof compareDisclosedTraces> | undefined;
  let sourceTraceVerified: boolean | undefined;
  const current = options.currentTrace;
  if (current !== undefined && trace !== undefined) {
    comparison = compareDisclosedTraces(trace, current.disclosed);
    traceConsistent = comparison.result !== 'contradicted';
    freshness = comparison.result === 'matches' ? 'current' : comparison.result === 'progressed' ? 'superseded-by-later-facts' : 'unknown';
    if (!traceConsistent) failures.push({ check: 'traceConsistent', message: 'The canonical records now contradict a fact this Bundle disclosed.' });
    sourceTraceVerified = current.verification.verified;
    if (!sourceTraceVerified) failures.push({ check: 'sourceTraceVerified', message: 'The canonical trace of this request does not verify now; see sourceTrace.checks.' });
  } else {
    failures.push({ check: 'traceConsistent', message: 'The canonical trace of this request could not be rebuilt in this scope; the Bundle cannot be checked against its sources.' });
    traceConsistent = false;
  }

  return {
    bundleId: bundle.bundleId,
    valid: failures.length === 0,
    checks: {
      bundleDigest: bundleDigestOk,
      verificationDigest: verificationDigestOk,
      ...(recordDigestOk !== undefined ? { recordDigest: recordDigestOk } : {}),
      policyMatch: policyMatchOk,
      versionSupported: true,
      complete: completeOk,
      traceDigest: traceDigestOk,
      traceConsistent,
      ...(sourceTraceVerified !== undefined ? { sourceTraceVerified } : {}),
    },
    verifiedAt: options.now(),
    failures,
    freshness,
    ...(comparison !== undefined ? { traceComparison: comparison } : {}),
    ...(current !== undefined ? { sourceTrace: current.verification } : {}),
  };
}
