import type { AssuranceControlDefinition, AssuranceEvidenceRequirement, AssuranceFramework, AssuranceSeverityMapping } from '../contracts.js';

/**
 * `rn.sv` 0.1.0 -- the Republika Sovereignty Assessment framework
 * (ASSURE-CAT-01): the ten-control catalog for a professional, human-reviewed
 * digital-sovereignty assessment of a declared scope.
 *
 * Every control is a structured `manual_review`: an attributable reviewer
 * holding `assure.reviewer` answers the control's questions against the
 * collected evidence. Nothing here passes automatically, and nothing here
 * fails merely because evidence is absent -- a reviewer who cannot reach a
 * defensible conclusion records `insufficient_evidence`, which the evaluator
 * maps to `unknown` (scored zero under `unknownPolicy: 'zero'`, finding type
 * `evidence_gap`), never to `fail`.
 *
 * Contract fit (no public contract was extended for this framework):
 * - `AssuranceControlDefinition` has no metadata field, so each control's
 *   risk, protected asset, outcome conditions, limitations, manual-review
 *   condition, missing-evidence treatment, and revalidation criteria live in
 *   the framework-level `metadata.controlProfiles`, keyed by `controlId`.
 * - The criteria deliberately omit `requiredEvidenceRequirementIds`: the
 *   service enforces it for every outcome, which would make an
 *   `insufficient_evidence` review unrecordable when evidence is missing.
 *   Omitting it selects the engine's `control_bound` review policy
 *   (ASSURE-SEC-01A, `manual-review-evidence.ts`): pass/partial/fail must
 *   cite accepted evidence explicitly bound to the control's own requirement,
 *   while `insufficient_evidence` needs none.
 * - Requirements never set `mustBeVerified`: the `verified` flag on manually
 *   supplied evidence is self-declared by its supplier today, so demanding it
 *   would add false confidence rather than assurance.
 * - `eligibilityProfiles` is empty: this framework produces no eligibility
 *   result of any kind. With no profiles, an `eligibility_only` blocking rule
 *   would be inert, so `domain_override` is used: a failed SV-06 or SV-08
 *   marks its domain `unhealthy` regardless of the numeric average.
 *
 * COMMERCIAL USE IS RESTRICTED (see `metadata.commercialUse`): until
 * ASSURE-SEC-01 lands, results recorded under this framework must not be
 * issued as commercial conclusions without controlled external review.
 *
 * `status: 'active'` vs `commercialUse.status: 'restricted'`: `active` is the
 * registry lifecycle state and only means the definition is available to
 * register and to assess against (`resolveFrameworkForAssessment` refuses a
 * `draft`). It is not an authorization to issue commercial assessments.
 * `metadata.commercialUse` is informative only -- no engine component reads
 * or enforces it; the restriction is procedural until ASSURE-SEC-01.
 *
 * Review finding F01 (a `pass` review citing no evidence was accepted and
 * scored) is closed in the engine by ASSURE-SEC-01A: the service rejects it,
 * the evaluator ignores such a stored review, and verification flags a
 * definitive manual result with no bound evidence. Binding is structural; it
 * does not prove evidence authentic or a conclusion correct.
 *
 * This framework version is immutable -- every change to controls, questions,
 * weights, or thresholds requires `rn.sv` 0.2.0+. The golden digest test in
 * `assurance-rn-sv-framework.test.ts` enforces it.
 */

export const RN_SV_FRAMEWORK_ID = 'rn.sv';
export const RN_SV_FRAMEWORK_VERSION = '0.1.0';
export const RN_SV_REVIEWER_ROLE = 'assure.reviewer';

const FRAMEWORK_BINDING = { frameworkId: RN_SV_FRAMEWORK_ID, frameworkVersion: RN_SV_FRAMEWORK_VERSION } as const;

function requirementIdFor(controlId: string): string {
  return `rn.sv.req.${controlId.toLowerCase()}`;
}

/** One evidence requirement per control: manually supplied, organization-bound references, contradictions escalated to a human. */
function evidenceRequirement(controlId: string, description: string): AssuranceEvidenceRequirement {
  return {
    requirementId: requirementIdFor(controlId),
    description,
    acceptedEvidenceTypes: ['external_artifact_reference', 'control_attestation'],
    minimumCount: 1,
    mustBeOrganizationBound: true,
    manualEvidenceAllowed: true,
    contradictionPolicy: 'manual_review',
  };
}

const EVIDENCE_REQUIREMENTS: readonly AssuranceEvidenceRequirement[] = [
  evidenceRequirement('SV-01', 'Role and authority inventory plus a sample of privileged actions with their logs and the grants that authorized them.'),
  evidenceRequirement('SV-02', 'Consent records and revocation records for the sampled data subjects, plus operations observed after each sampled revocation.'),
  evidenceRequirement('SV-03', 'The policy in force with its version history, plus a sample of decisions taken under it.'),
  evidenceRequirement('SV-04', 'The integrity mechanism description (hash chain, signatures) and verification output over the sampled records.'),
  evidenceRequirement('SV-05', 'End-to-end records for the sampled operations: request, decision, execution, and observed outcome.'),
  evidenceRequirement('SV-06', 'Tenant-isolation design documentation and the output of isolation tests executed by the customer, witnessed or recorded.'),
  evidenceRequirement('SV-07', 'A field inventory for the in-scope exports and APIs, plus sample exports or responses.'),
  evidenceRequirement('SV-08', 'A witnessed staging test: authority revoked, the next attempt made, and the denial recorded with timestamps.'),
  evidenceRequirement('SV-09', 'The finding-tracking process and closure evidence for previously identified issues.'),
  evidenceRequirement('SV-10', 'Named accountable owners, a responsibility matrix, review cadence records, and the escalation path.'),
];

const REMEDIATION_GUIDANCE: Readonly<Record<string, string>> = {
  'SV-01': 'Replace shared accounts with named identities, enforce role-based authority, and bound every grant with an expiry.',
  'SV-02': 'Record consent as durable, attributable grants and enforce revocation at the point of use.',
  'SV-03': 'Version the policy, record which version each decision used, and route exceptions through an attributable approval.',
  'SV-04': 'Protect critical records with a verifiable integrity mechanism (hash chain or signatures) and verify it routinely.',
  'SV-05': 'Correlate request, decision, execution, and outcome under one identifier and retain the chain for the agreed period.',
  'SV-06': 'Enforce the tenant scope on every read and write path and cover it with automated isolation tests.',
  'SV-07': 'Define per-audience disclosure profiles and strip every field an audience does not need.',
  'SV-08': 'Make revocation take effect at the enforcement point within a documented bound, including caches.',
  'SV-09': 'Track findings to closure with evidence, and close only after a later check confirms the fix.',
  'SV-10': 'Name accountable owners, document responsibilities, and review the sovereignty posture on a fixed cadence.',
};

interface ControlSpec {
  readonly controlId: string;
  readonly domainId: string;
  readonly title: string;
  readonly description: string;
  readonly objective: string;
  readonly controlType: AssuranceControlDefinition['controlType'];
  readonly criticality: AssuranceControlDefinition['criticality'];
  readonly failSeverity: 'critical' | 'high' | 'medium';
  readonly questions: readonly string[];
}

/** Rule-based severities (mission section 23): a failure carries the control's documented severity; an evidence gap is low; a pending review is informational. */
function severityMappingFor(failSeverity: ControlSpec['failSeverity']): AssuranceSeverityMapping {
  return {
    fail: failSeverity,
    partial: failSeverity === 'medium' ? 'low' : 'medium',
    unknown: 'low',
    manual_review_required: 'informational',
  };
}

function control(spec: ControlSpec): AssuranceControlDefinition {
  const requirementId = requirementIdFor(spec.controlId);
  return {
    controlId: spec.controlId,
    ...FRAMEWORK_BINDING,
    domainId: spec.domainId,
    title: spec.title,
    description: spec.description,
    objective: spec.objective,
    controlType: spec.controlType,
    criticality: spec.criticality,
    evaluationMethod: 'manual_review',
    evidenceRequirementIds: [requirementId],
    criteria: { type: 'manual_review', questions: spec.questions, requiredReviewerRole: RN_SV_REVIEWER_ROLE },
    scoring: { weight: 1, maximumScore: 100 },
    severityMapping: severityMappingFor(spec.failSeverity),
    remediationGuidance: REMEDIATION_GUIDANCE[spec.controlId] ?? '',
    tags: ['rn.sv', 'method:manual_review', 'automation:none', `severity:${spec.failSeverity}`],
  };
}

const CONTROLS: readonly AssuranceControlDefinition[] = [
  control({
    controlId: 'SV-01',
    domainId: 'rn.sv.authority',
    title: 'Actor identity and authority',
    description: 'Every privileged action in scope is attributable to a unique identity that held valid authority when it acted.',
    objective: 'Demonstrate that privileged operations are performed only by identified actors with authority in force.',
    controlType: 'preventive',
    criticality: 'mandatory',
    failSeverity: 'high',
    questions: [
      'Is every sampled privileged action attributable to a unique, named identity (no shared accounts)?',
      'For every sampled action, was the authority that permitted it in force at the time of the action?',
      'Is the source of each authority (grant, role assignment, delegation) recorded and traceable?',
      'Are service accounts inventoried with a named accountable owner?',
    ],
  }),
  control({
    controlId: 'SV-02',
    domainId: 'rn.sv.authority',
    title: 'Consent and revocation',
    description: 'Operations over in-scope data rely on consent in force, and revoked consent stops further operations.',
    objective: 'Demonstrate that data subjects’ consent decisions are recorded and honored, including withdrawal.',
    controlType: 'preventive',
    criticality: 'mandatory',
    failSeverity: 'high',
    questions: [
      'Does every sampled operation rely on a consent record that was in force when it occurred?',
      'Are consent records durable and attributable to the consenting party?',
      'After each sampled revocation, did any operation that relied on the revoked consent occur?',
    ],
  }),
  control({
    controlId: 'SV-03',
    domainId: 'rn.sv.policy-governance',
    title: 'Policy compliance',
    description: 'Decisions in scope are taken under an identified, versioned policy and are consistent with it.',
    objective: 'Demonstrate that the declared policy is the policy actually applied.',
    controlType: 'preventive',
    criticality: 'mandatory',
    failSeverity: 'high',
    questions: [
      'Is the policy in force identified by version, with a recoverable history of changes?',
      'Does each sampled decision record, or allow reconstruction of, the policy version it applied?',
      'Is each sampled decision consistent with that policy version?',
      'Are exceptions approved by an attributable party and recorded?',
    ],
  }),
  control({
    controlId: 'SV-04',
    domainId: 'rn.sv.evidence-traceability',
    title: 'Evidence integrity',
    description: 'Critical records in scope are protected by a verifiable integrity mechanism, and verification succeeds over the sample.',
    objective: 'Demonstrate that recorded evidence cannot be altered without detection.',
    controlType: 'detective',
    criticality: 'mandatory',
    failSeverity: 'high',
    questions: [
      'Is there an integrity mechanism (hash chain, signatures) over the critical records in scope?',
      'Does integrity verification succeed for every sampled record?',
      'Is the verification procedure documented and repeatable by a party other than the record writer?',
    ],
  }),
  control({
    controlId: 'SV-05',
    domainId: 'rn.sv.evidence-traceability',
    title: 'Execution traceability',
    description: 'Each sampled operation can be reconstructed end to end: request, decision, execution, and observed outcome.',
    objective: 'Demonstrate that what was authorized can be connected to what actually happened.',
    controlType: 'detective',
    criticality: 'mandatory',
    failSeverity: 'high',
    questions: [
      'Can each sampled operation be traced from request to decision under a shared identifier?',
      'Is the execution of each sampled decision recorded and linked to that decision?',
      'Is the observed outcome recorded, and is an unconfirmed outcome reported as unconfirmed rather than assumed?',
    ],
  }),
  control({
    controlId: 'SV-06',
    domainId: 'rn.sv.data-boundaries',
    title: 'Isolation between organizations',
    description: 'The design enforces the organization scope on every read and write path in scope, and isolation tests demonstrate it.',
    objective: 'Demonstrate that one organization cannot read or alter another organization’s data.',
    controlType: 'preventive',
    criticality: 'mandatory',
    failSeverity: 'critical',
    questions: [
      'Does the documented design enforce the organization scope on every in-scope read and write path?',
      'Do the customer-executed isolation tests cover cross-organization read and write attempts, and were they all refused?',
      'Are global administrative roles that cross organizations inventoried, justified, and logged?',
    ],
  }),
  control({
    controlId: 'SV-07',
    domainId: 'rn.sv.data-boundaries',
    title: 'Minimal disclosure',
    description: 'In-scope exports and APIs disclose only the fields their audience needs.',
    objective: 'Demonstrate that the platform discloses no more than each audience requires.',
    controlType: 'preventive',
    criticality: 'mandatory',
    failSeverity: 'high',
    questions: [
      'Is there a field inventory for each in-scope export and API, with the intended audience of each?',
      'Do the sampled exports or responses contain only the fields that audience needs?',
      'Are secrets, credentials, and personal data excluded where they are not needed?',
    ],
  }),
  control({
    controlId: 'SV-08',
    domainId: 'rn.sv.authority',
    title: 'Effective revocation of authority',
    description: 'Revoking an authority stops its use at the enforcement point within a documented bound.',
    objective: 'Demonstrate that revocation is effective in practice, not only recorded.',
    controlType: 'preventive',
    criticality: 'mandatory',
    failSeverity: 'critical',
    questions: [
      'In the witnessed staging test, was the first attempt after revocation denied?',
      'Was the denial recorded with a timestamp within the documented revocation bound?',
      'Are caches or replicas that could extend a revoked authority identified and bounded?',
    ],
  }),
  control({
    controlId: 'SV-09',
    domainId: 'rn.sv.remediation',
    title: 'Remediation and revalidation',
    description: 'Identified issues are tracked to closure with evidence, and closure follows a later confirming check.',
    objective: 'Demonstrate that the organization corrects issues and confirms the corrections.',
    controlType: 'corrective',
    criticality: 'recommended',
    failSeverity: 'medium',
    questions: [
      'Is there a tracked process for findings, with owners and target dates?',
      'Does each sampled closed item carry evidence of the correction?',
      'Was each sampled closure confirmed by a check performed after the correction?',
    ],
  }),
  control({
    controlId: 'SV-10',
    domainId: 'rn.sv.policy-governance',
    title: 'Governance and accountability',
    description: 'Named owners are accountable for the sovereignty posture, responsibilities are documented, and the posture is reviewed on a fixed cadence.',
    objective: 'Demonstrate that someone is accountable for sovereignty decisions and that the posture is reviewed.',
    controlType: 'governance',
    criticality: 'mandatory',
    failSeverity: 'medium',
    questions: [
      'Are accountable owners named for each in-scope sovereignty area?',
      'Is there a documented responsibility matrix covering the in-scope controls?',
      'Is there evidence of periodic posture reviews and of a working escalation path?',
    ],
  }),
];

/**
 * Per-control assessment profile: the attributes the control contract has no
 * field for. Severity is not repeated here -- `severityMapping` is canonical.
 */
interface ControlProfile {
  readonly risk: string;
  readonly protectedAsset: string;
  readonly satisfiedWhen: string;
  readonly notSatisfiedWhen: string;
  readonly inconclusiveWhen: string;
  readonly verificationMethods: readonly string[];
  readonly limitations: readonly string[];
  readonly revalidation: string;
}

const MANUAL_REVIEW_CONDITION = 'Always: every rn.sv control requires an attributable review by a reviewer holding the assure.reviewer role; no control passes on automated evidence.';
const MISSING_EVIDENCE_TREATMENT =
  'The reviewer records insufficient_evidence, which evaluates to unknown: scored zero, reported as an evidence gap, never as a failure.';

const CONTROL_PROFILES: Readonly<Record<string, ControlProfile>> = {
  'SV-01': {
    risk: 'Privileged operations performed by unidentified actors or without authority in force.',
    protectedAsset: 'Privileged operations and the resources they act upon.',
    satisfiedWhen: 'Every sampled privileged action maps to a unique identity holding authority in force at the time.',
    notSatisfiedWhen: 'A sampled action used a shared account, or its authority was absent, expired, or untraceable.',
    inconclusiveWhen: 'Logs or grant records for the sample were not provided.',
    verificationMethods: ['customer-provided evidence', 'human review'],
    limitations: ['Sample-based: conclusions cover the sampled actions only.', 'Legitimate service accounts can look like shared accounts without their inventory.'],
    revalidation: 'A new sample drawn from after the correction date.',
  },
  'SV-02': {
    risk: 'Processing personal data without consent in force, or after consent was withdrawn.',
    protectedAsset: 'Data subjects’ data and their consent decisions.',
    satisfiedWhen: 'Every sampled operation relied on consent in force and no operation followed a sampled revocation.',
    notSatisfiedWhen: 'A sampled operation lacked consent in force, or relied on revoked consent.',
    inconclusiveWhen: 'Consent or revocation records for the sample were not provided.',
    verificationMethods: ['customer-provided evidence', 'human review'],
    limitations: ['Consent captured outside the system may be invisible to the sample.'],
    revalidation: 'A new sample of revocations made after the correction date.',
  },
  'SV-03': {
    risk: 'Decisions taken outside the declared policy.',
    protectedAsset: 'The integrity of governed decisions.',
    satisfiedWhen: 'The policy is versioned and every sampled decision is consistent with the version it applied.',
    notSatisfiedWhen: 'A sampled decision contradicts the policy version in force, or an exception lacks attributable approval.',
    inconclusiveWhen: 'The policy version applied by sampled decisions cannot be determined.',
    verificationMethods: ['customer-provided evidence', 'human review'],
    limitations: ['Exceptions approved outside the tooling may appear as inconsistencies.'],
    revalidation: 'A new decision sample under the corrected policy version.',
  },
  'SV-04': {
    risk: 'Records altered without detection.',
    protectedAsset: 'Critical records and the evidence derived from them.',
    satisfiedWhen: 'An integrity mechanism covers the critical records and verification succeeds over the sample.',
    notSatisfiedWhen: 'No integrity mechanism exists, or verification fails for a sampled record.',
    inconclusiveWhen: 'The verification procedure or its output was not provided.',
    verificationMethods: ['customer-provided evidence', 'human review', 'automated digest or signature verification where the format allows'],
    limitations: [
      'Integrity is not truthfulness: a record that was false when written verifies as intact.',
      'Without signatures, a privileged writer can recompute digests consistently.',
    ],
    revalidation: 'Re-run verification over a new sample after the correction.',
  },
  'SV-05': {
    risk: 'Executions that cannot be connected to the decision that authorized them.',
    protectedAsset: 'Accountability for executed operations.',
    satisfiedWhen: 'Each sampled operation is reconstructable from request to observed outcome.',
    notSatisfiedWhen: 'A sampled execution has no linked decision, or a recorded outcome contradicts the execution record.',
    inconclusiveWhen: 'The outcome of a sampled execution is unconfirmed; this is reported as unconfirmed, never as a failure.',
    verificationMethods: ['customer-provided evidence', 'human review'],
    limitations: ['Relies on the customer’s logs; log completeness is not independently established.'],
    revalidation: 'A new end-to-end sample after the correction.',
  },
  'SV-06': {
    risk: 'One organization reading or altering another organization’s data.',
    protectedAsset: 'Each organization’s data and operations.',
    satisfiedWhen: 'The design enforces the organization scope on every in-scope path and every isolation test attempt was refused.',
    notSatisfiedWhen: 'A cross-organization read or write succeeded, or an in-scope path does not enforce the organization scope.',
    inconclusiveWhen: 'Isolation tests were not executed or their output was not provided.',
    verificationMethods: ['human review of design', 'customer-executed tests with witness or recording', 'contractual validation'],
    limitations: [
      'This framework performs no active testing against customer systems; active testing requires separate written authorization and is out of scope for 0.1.0.',
      'Legitimate global administrative roles cross organizations by design.',
    ],
    revalidation: 'Re-execution of the isolation tests after the correction, witnessed or recorded.',
  },
  'SV-07': {
    risk: 'Disclosure of data beyond what an audience needs.',
    protectedAsset: 'Personal data, secrets, and confidential business data.',
    satisfiedWhen: 'Sampled exports and responses contain only the fields their audience needs.',
    notSatisfiedWhen: 'A sampled export or response discloses fields its audience does not need, or any secret or credential.',
    inconclusiveWhen: 'No field inventory or samples were provided.',
    verificationMethods: ['customer-provided evidence', 'human review'],
    limitations: ['Field-level review only; no automated detection of personal data by value.'],
    revalidation: 'A new export sample after the correction.',
  },
  'SV-08': {
    risk: 'A revoked authority remaining usable.',
    protectedAsset: 'The operations a revoked authority could still perform.',
    satisfiedWhen: 'The first attempt after revocation was denied within the documented bound.',
    notSatisfiedWhen: 'An attempt after revocation succeeded beyond the documented bound.',
    inconclusiveWhen: 'The revocation test was not executed or not recorded.',
    verificationMethods: ['customer-executed staging test with witness or recording', 'human review'],
    limitations: [
      'This framework performs no active testing against customer systems; the test is executed by the customer in staging.',
      'Caches with a documented time-to-live can delay denial legitimately.',
    ],
    revalidation: 'Re-execution of the witnessed revocation test after the correction.',
  },
  'SV-09': {
    risk: 'Issues reported as fixed without confirmation.',
    protectedAsset: 'The reliability of the organization’s corrective actions.',
    satisfiedWhen: 'Findings are tracked with owners, and each sampled closure carries correction evidence and a later confirming check.',
    notSatisfiedWhen: 'Sampled items were closed without correction evidence or without a confirming check.',
    inconclusiveWhen: 'No tracking records were provided.',
    verificationMethods: ['customer-provided evidence', 'human review'],
    limitations: ['On a first assessment there may be no prior findings to sample.'],
    revalidation: 'Review of closures made after the correction date.',
  },
  'SV-10': {
    risk: 'No one accountable for sovereignty decisions.',
    protectedAsset: 'The organization’s sovereignty posture as a whole.',
    satisfiedWhen: 'Accountable owners are named, responsibilities are documented, and periodic reviews took place.',
    notSatisfiedWhen: 'No accountable owner exists for an in-scope area, or no review took place in the declared cadence.',
    inconclusiveWhen: 'Governance documents were not provided.',
    verificationMethods: ['customer-provided evidence', 'interview', 'human review'],
    limitations: ['Documentary: the existence of a process does not prove its effectiveness.'],
    revalidation: 'Evidence of the next scheduled review after the correction.',
  },
};

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export const RN_SV_FRAMEWORK_V0_1: AssuranceFramework = deepFreeze<AssuranceFramework>({
  frameworkId: RN_SV_FRAMEWORK_ID,
  frameworkVersion: RN_SV_FRAMEWORK_VERSION,
  name: 'Republika Sovereignty Assessment',
  description:
    'Ten-control, human-reviewed assessment of an organization’s digital-sovereignty posture over a declared scope. Results are framework-bound, scope-bound, and point-in-time; they are not a certification, legal opinion, or guarantee.',
  issuer: 'republika-network',
  issuedAt: '2026-10-28T00:00:00.000Z',
  status: 'active',
  domains: [
    {
      domainId: 'rn.sv.authority',
      name: 'Authority & Consent',
      description: 'Actors are identified and authorized, consent is honored, and revocation is effective.',
      controlIds: ['SV-01', 'SV-02', 'SV-08'],
      weight: 0.3,
      blockingControlIds: ['SV-08'],
    },
    {
      domainId: 'rn.sv.policy-governance',
      name: 'Policy & Governance',
      description: 'Decisions follow a versioned policy and named owners are accountable for the posture.',
      controlIds: ['SV-03', 'SV-10'],
      weight: 0.2,
    },
    {
      domainId: 'rn.sv.evidence-traceability',
      name: 'Evidence & Traceability',
      description: 'Records are integrity-protected and operations are traceable end to end.',
      controlIds: ['SV-04', 'SV-05'],
      weight: 0.2,
    },
    {
      domainId: 'rn.sv.data-boundaries',
      name: 'Data Boundaries',
      description: 'Organizations are isolated from each other and disclosure is minimal.',
      controlIds: ['SV-06', 'SV-07'],
      weight: 0.2,
      blockingControlIds: ['SV-06'],
    },
    {
      domainId: 'rn.sv.remediation',
      name: 'Remediation',
      description: 'Issues are corrected and corrections are confirmed.',
      controlIds: ['SV-09'],
      weight: 0.1,
    },
  ],
  controls: CONTROLS,
  evidenceRequirements: EVIDENCE_REQUIREMENTS,
  scoringModel: {
    methodologyId: 'rn.sv.scoring',
    methodologyVersion: '0.1.0',
    // pass=1, partial=0.5, fail=0. unknown and manual_review_required score
    // zero through the policies below; not_applicable is always excluded.
    statusScores: { pass: 1, partial: 0.5, fail: 0, unknown: null, not_applicable: null, manual_review_required: null },
    domainWeights: {},
    controlWeights: {},
    // An unknown is never shown as demonstrated compliance: it stays in the
    // denominator at zero.
    unknownPolicy: 'zero',
    // Pending reviews score zero and block completion: 'zero' is not
    // 'provisional', so completeAssessment refuses while any review is pending.
    manualReviewPolicy: 'zero',
    blockingRule: 'domain_override',
  },
  eligibilityProfiles: [],
  metadata: {
    reviewerRole: RN_SV_REVIEWER_ROLE,
    reviewOutcomeSemantics: {
      pass: 'pass',
      partial: 'partial',
      fail: 'fail',
      insufficient_evidence: 'unknown (evidence gap; never a failure)',
    },
    manualReviewCondition: MANUAL_REVIEW_CONDITION,
    missingEvidenceTreatment: MISSING_EVIDENCE_TREATMENT,
    controlProfiles: CONTROL_PROFILES,
    localizedTitles: {
      es: {
        'SV-01': 'Identidad y autoridad del actor',
        'SV-02': 'Consentimiento y revocación',
        'SV-03': 'Cumplimiento de políticas',
        'SV-04': 'Integridad de evidencia',
        'SV-05': 'Trazabilidad de ejecución',
        'SV-06': 'Aislamiento entre organizaciones',
        'SV-07': 'Divulgación mínima',
        'SV-08': 'Revocación efectiva',
        'SV-09': 'Remediación y revalidación',
        'SV-10': 'Gobernanza y responsabilidad',
      },
    },
    commercialUse: {
      status: 'restricted',
      statement:
        'Results recorded under rn.sv 0.1.0 must not be issued as commercial conclusions without controlled external review until ASSURE-SEC-01 resolves the known blockers.',
      knownBlockers: [
        'Manually supplied evidence carries a self-declared verified flag.',
        'Attestation metadata can set any metric name, including automated ones.',
        'Reviewer identity and role are taken from the request body, not bound to the caller.',
        'Evidence without an organization is attributed to the assessed organization.',
        'Evidence Bundle v2 verification is invoked without the current trace.',
        'Finding-event write failures at completion are ignored.',
        'Assessments carry integrity digests but no external authenticity (no signature).',
        'Manually supplied evidence is offered to every requirement, not scoped to one control.',
        'Review evidence references are not checked against the assessment’s accepted evidence.',
      ],
    },
    automation: 'none: every control is resolved by an attributable human review; no automated testing against customer systems.',
  },
});
