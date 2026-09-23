import type { PolicyPack } from '../domain/policy-pack.js';
import type { PolicyPackVersion } from '../domain/policy-pack-version.js';
import type { PolicyPackRule } from '../domain/policy-pack-rule.js';
import type { PolicyCondition, PolicyPredicateCondition } from '../domain/policy-pack-condition.js';
import { PolicyPackValidationError } from '../runtime/policy-pack-runtime-errors.js';
import { isCanonicalDecimal } from '../../monetary-runtime/index.js';

/**
 * P9: the only predicates on `amount` a pack may state, and what they compare
 * against. A threshold is canonical decimal text (`src/features/monetary-runtime`)
 * — never a JavaScript number, whose precision is decided before the pack is
 * ever read — so `amount >= "9007199254740993"` means exactly that.
 */
function isMonetaryPredicateValue(condition: PolicyPredicateCondition): boolean {
  switch (condition.operator) {
    case 'exists':
    case 'not_exists':
      return condition.value === undefined;
    case 'equals':
    case 'not_equals':
    case 'greater_than':
    case 'greater_than_or_equal':
    case 'less_than':
    case 'less_than_or_equal':
      return isCanonicalDecimal(condition.value);
    case 'in':
    case 'not_in':
      return Array.isArray(condition.value) && condition.value.length > 0 && condition.value.every((entry) => isCanonicalDecimal(entry));
    default:
      return false;
  }
}

export interface PolicyPackValidationIssue {
  readonly code: string;
  readonly message: string;
}

export interface PolicyPackValidationResult {
  readonly valid: boolean;
  readonly issues: readonly PolicyPackValidationIssue[];
}

const DENY_LIKE_EFFECTS = new Set([
  'deny',
  'require_evidence',
  'require_approval',
  'require_authority',
  'require_external_standing',
]);

/**
 * Validates policy pack / policy pack version structure deterministically.
 * Never evaluates rule conditions against runtime input -- that is
 * PolicyConditionEvaluator's responsibility.
 */
export class PolicyPackValidator {
  validateVersion(version: PolicyPackVersion): PolicyPackValidationResult {
    const issues: PolicyPackValidationIssue[] = [];

    this.validateRuleIdsUnique(version.rules, issues);
    this.validateSourceReferences(version, issues);
    this.validatePriorityOrdering(version.rules, issues);
    this.validateDemoMetadata(version, issues);

    for (const rule of version.rules) {
      this.validateCondition(rule.condition, rule.id, issues);
      this.validateEffect(rule, issues);
    }

    const result: PolicyPackValidationResult = { valid: issues.length === 0, issues };
    if (!result.valid) {
      throw new PolicyPackValidationError(
        version.id,
        issues.map((issue) => `${issue.code}: ${issue.message}`),
      );
    }
    return result;
  }

  validateActivatable(version: PolicyPackVersion): PolicyPackValidationResult {
    const issues: PolicyPackValidationIssue[] = [];
    if (version.rules.filter((rule) => rule.status === 'active').length === 0) {
      issues.push({ code: 'NO_ACTIVE_RULES', message: `Version ${version.id} has no active rules and cannot be activated.` });
    }
    const result: PolicyPackValidationResult = { valid: issues.length === 0, issues };
    if (!result.valid) {
      throw new PolicyPackValidationError(
        version.id,
        issues.map((issue) => `${issue.code}: ${issue.message}`),
      );
    }
    return result;
  }

  validatePack(pack: PolicyPack): PolicyPackValidationResult {
    const issues: PolicyPackValidationIssue[] = [];
    if (pack.status === 'active' && !pack.versions.some((version) => version.id === pack.currentVersionId && version.status === 'active')) {
      issues.push({ code: 'NO_ACTIVE_CURRENT_VERSION', message: `Pack ${pack.id} is active but has no active current version.` });
    }
    return { valid: issues.length === 0, issues };
  }

  private validateRuleIdsUnique(rules: readonly PolicyPackRule[], issues: PolicyPackValidationIssue[]): void {
    const seen = new Set<string>();
    for (const rule of rules) {
      if (seen.has(rule.id)) {
        issues.push({ code: 'DUPLICATE_RULE_ID', message: `Duplicate rule id: ${rule.id}` });
      }
      seen.add(rule.id);
    }
  }

  private validateSourceReferences(version: PolicyPackVersion, issues: PolicyPackValidationIssue[]): void {
    const sourceIds = new Set(version.sources.map((source) => source.id));
    for (const rule of version.rules) {
      for (const sourceId of rule.sourceIds) {
        if (!sourceIds.has(sourceId)) {
          issues.push({ code: 'MISSING_SOURCE_REFERENCE', message: `Rule ${rule.id} references unknown source ${sourceId}.` });
        }
      }
    }
  }

  private validatePriorityOrdering(rules: readonly PolicyPackRule[], issues: PolicyPackValidationIssue[]): void {
    for (const rule of rules) {
      if (!Number.isFinite(rule.priority)) {
        issues.push({ code: 'INVALID_PRIORITY', message: `Rule ${rule.id} has a non-finite priority.` });
      }
    }
  }

  private validateDemoMetadata(version: PolicyPackVersion, issues: PolicyPackValidationIssue[]): void {
    if (version.demoOnly && version.legalCompleteness === 'verified_by_counsel') {
      issues.push({
        code: 'INCONSISTENT_LEGAL_COMPLETENESS',
        message: `Version ${version.id} is marked demoOnly but claims legalCompleteness=verified_by_counsel.`,
      });
    }
  }

  private validateCondition(condition: PolicyCondition, ruleId: string, issues: PolicyPackValidationIssue[]): void {
    if (condition.type === 'group') {
      if (condition.conditions.length === 0) {
        issues.push({ code: 'EMPTY_CONDITION_GROUP', message: `Rule ${ruleId} has an empty condition group.` });
      }
      for (const nested of condition.conditions) {
        this.validateCondition(nested, ruleId, issues);
      }
      return;
    }
    if (condition.type === 'predicate') {
      if (
        condition.operator !== 'exists' &&
        condition.operator !== 'not_exists' &&
        condition.value === undefined &&
        condition.metadataPath === undefined
      ) {
        issues.push({ code: 'INVALID_PREDICATE', message: `Rule ${ruleId} has a predicate on ${condition.field} missing a value.` });
      }
      if (condition.field === 'amount' && !isMonetaryPredicateValue(condition)) {
        issues.push({
          code: 'INVALID_MONETARY_THRESHOLD',
          message: `Rule ${ruleId} compares amount against something other than canonical decimal text (e.g. "10000", "123.45"). A monetary threshold is never a number.`,
        });
      }
      return;
    }
    issues.push({ code: 'INVALID_CONDITION', message: `Rule ${ruleId} has a condition with an unrecognized type.` });
  }

  private validateEffect(rule: PolicyPackRule, issues: PolicyPackValidationIssue[]): void {
    if (!rule.effect.reasonCode || rule.effect.reasonCode.trim().length === 0) {
      if (DENY_LIKE_EFFECTS.has(rule.effect.type)) {
        issues.push({ code: 'MISSING_REASON_CODE', message: `Rule ${rule.id} has effect ${rule.effect.type} without a reasonCode.` });
      }
    }
    if (!rule.effect.reason || rule.effect.reason.trim().length === 0) {
      if (DENY_LIKE_EFFECTS.has(rule.effect.type)) {
        issues.push({ code: 'MISSING_REASON', message: `Rule ${rule.id} has effect ${rule.effect.type} without a reason.` });
      }
    }
    for (const req of rule.evidenceRequirements) {
      if (!req.description || req.description.trim().length === 0) {
        issues.push({ code: 'MISSING_EVIDENCE_DESCRIPTION', message: `Rule ${rule.id} has an evidence requirement without a description.` });
      }
    }
    for (const req of rule.approvalRequirements) {
      if (!req.description || req.description.trim().length === 0) {
        issues.push({ code: 'MISSING_APPROVAL_DESCRIPTION', message: `Rule ${rule.id} has an approval requirement without a description.` });
      }
    }
  }
}
