export class PolicyPackRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class PolicyPackNotFoundError extends PolicyPackRuntimeError {
  constructor(policyPackId: string) {
    super(`Policy pack not found: ${policyPackId}`);
  }
}

export class PolicyPackVersionNotFoundError extends PolicyPackRuntimeError {
  constructor(policyPackVersionId: string) {
    super(`Policy pack version not found: ${policyPackVersionId}`);
  }
}

export class PolicyPackDuplicateIdError extends PolicyPackRuntimeError {
  constructor(kind: string, id: string) {
    super(`Duplicate ${kind} id: ${id}`);
  }
}

export class PolicyPackInvalidStatusTransitionError extends PolicyPackRuntimeError {
  constructor(policyPackVersionId: string, from: string, to: string) {
    super(`Invalid policy pack version status transition for ${policyPackVersionId}: ${from} -> ${to}`);
  }
}

export class PolicyPackValidationError extends PolicyPackRuntimeError {
  constructor(policyPackVersionId: string, issues: readonly string[]) {
    super(`Policy pack version ${policyPackVersionId} failed validation: ${issues.join('; ')}`);
  }
}

export class PolicyPackDecisionNotFoundError extends PolicyPackRuntimeError {
  constructor(decisionId: string) {
    super(`Policy pack decision not found: ${decisionId}`);
  }
}

export class PolicyPackProofNotFoundError extends PolicyPackRuntimeError {
  constructor(proofId: string) {
    super(`Policy pack proof not found: ${proofId}`);
  }
}

/** NB-008: a policy-pack write without a trusted writer context, or after the registry was frozen. Nothing was changed. */
export class PolicyPackWriteRefusedError extends PolicyPackRuntimeError {
  constructor(
    readonly code: 'POLICY_PACK_WRITER_REQUIRED' | 'POLICY_PACK_REGISTRY_FROZEN',
    message: string,
  ) {
    super(message);
  }
}
