import type { PolicyPack } from '../domain/policy-pack.js';
import type { PolicyPackVersion } from '../domain/policy-pack-version.js';
import type { PolicyPackRule } from '../domain/policy-pack-rule.js';
import type { PolicyCondition, PolicyPredicateCondition } from '../domain/policy-pack-condition.js';
import { PolicyPackValidationError } from '../runtime/policy-pack-runtime-errors.js';
import { isCanonicalDecimal } from '../../monetary-runtime/index.js';
import { isSemanticIdentifier } from '../../governed-parameter-runtime/index.js';

/** CORE-03: the operators that order a value. On a parameter they are valid only against a safe-integer threshold. */
const ORDERED_OPERATORS: ReadonlySet<string> = new Set(['greater_than', 'greater_than_or_equal', 'less_than', 'less_than_or_equal']);

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

/** CORE-04: the fact-class grammar policy may name (the Trusted Context Boundary's own). */
const FACT_CLASS = /^[a-z][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+)*$/;

function isFactClass(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 96 && FACT_CLASS.test(value);
}

/** CORE-04: the operators that are true when something is *absent* or *different*. A restrict-only fact may never be read through one. */
const NEGATED_OPERATORS: ReadonlySet<string> = new Set(['not_equals', 'not_includes', 'not_in', 'not_exists']);

/** CORE-04: the effects a rule reading a restrict-only fact may not have — anything that allows, or that decides nothing. */
const NON_RESTRICTIVE_EFFECTS: ReadonlySet<string> = new Set(['allow', 'no_op']);

/** CORE-04: the reserved namespaces trusted context and obligations use inside the deployment metadata bag. Read only through the typed predicates, never by path. */
const RESERVED_METADATA_PREFIXES: readonly string[] = ['aoc.context', 'aoc.obligations'];

function readsReservedMetadata(path: string | undefined): boolean {
  if (typeof path !== 'string') return false;
  const folded = path.toLowerCase();
  return RESERVED_METADATA_PREFIXES.some((prefix) => folded === prefix || folded.startsWith(`${prefix}.`));
}

/** Whether a condition tree reads a restrict-only fact anywhere. */
function readsRestrictiveFact(condition: PolicyCondition): boolean {
  if (condition.type === 'group') return condition.conditions.some(readsRestrictiveFact);
  return condition.field === 'restrictiveFact';
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
      this.validateRestrictiveMonotonicity(rule, issues);
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

  /**
   * CORE-04 — the restrict-only rule (Master Plan §4.4.6; OQ-14, pack half).
   *
   * A restrict-only fact (the admitted form of a RiskSignal) may make a
   * decision equal or more restrictive than its no-fact baseline, never less.
   * Structurally: the fact is read only in monotone position — never under a
   * `not` group and never through a negated operator — so its *presence* can
   * only make a condition true, never false; and the rule that reads it must
   * restrict — never `allow` and never `no_op`. Together these make "adding an
   * admitted restrict-only fact widens authority" inexpressible in a valid pack.
   */
  private validateRestrictiveMonotonicity(rule: PolicyPackRule, issues: PolicyPackValidationIssue[]): void {
    if (!readsRestrictiveFact(rule.condition)) return;
    if (NON_RESTRICTIVE_EFFECTS.has(rule.effect.type)) {
      issues.push({
        code: 'RESTRICTIVE_FACT_WIDENING',
        message: `Rule ${rule.id} reads a restrict-only fact with effect ${rule.effect.type}; a restrict-only fact may only drive a restrictive effect.`,
      });
    }
  }

  private validateCondition(condition: PolicyCondition, ruleId: string, issues: PolicyPackValidationIssue[], negated = false): void {
    if (condition.type === 'group') {
      if (condition.conditions.length === 0) {
        issues.push({ code: 'EMPTY_CONDITION_GROUP', message: `Rule ${ruleId} has an empty condition group.` });
      }
      for (const nested of condition.conditions) {
        this.validateCondition(nested, ruleId, issues, negated || condition.operator === 'not');
      }
      return;
    }
    if (condition.type === 'predicate') {
      if (
        condition.operator !== 'exists' &&
        condition.operator !== 'not_exists' &&
        condition.value === undefined &&
        condition.valueFrom === undefined &&
        condition.metadataPath === undefined
      ) {
        issues.push({ code: 'INVALID_PREDICATE', message: `Rule ${ruleId} has a predicate on ${condition.field} missing a value.` });
      }
      if (condition.field === 'parameter' && !isSemanticIdentifier(condition.parameterId)) {
        issues.push({ code: 'INVALID_PARAMETER_PREDICATE', message: `Rule ${ruleId} reads a parameter without naming its declared dimension (parameterId).` });
      }
      if (condition.field !== 'parameter' && condition.parameterId !== undefined) {
        issues.push({ code: 'INVALID_PARAMETER_PREDICATE', message: `Rule ${ruleId} names a parameterId on a predicate over ${condition.field}; only field 'parameter' reads a parameter.` });
      }
      if (condition.field === 'parameter' && condition.metadataPath !== undefined) {
        issues.push({ code: 'INVALID_PARAMETER_PREDICATE', message: `Rule ${ruleId} gives a parameter predicate a metadataPath; a parameter is read by its exact dimension id, never by path.` });
      }
      if (condition.field === 'parameter' && ORDERED_OPERATORS.has(condition.operator) && !(typeof condition.value === 'number' && Number.isSafeInteger(condition.value))) {
        issues.push({
          code: 'INVALID_PARAMETER_THRESHOLD',
          message: `Rule ${ruleId} orders a parameter against something other than a safe integer. Only integer dimensions are ordered, and a threshold is never text.`,
        });
      }
      if (condition.field === 'governanceProfileVersion' && ORDERED_OPERATORS.has(condition.operator) && !(typeof condition.value === 'number' && Number.isSafeInteger(condition.value))) {
        issues.push({ code: 'INVALID_PARAMETER_THRESHOLD', message: `Rule ${ruleId} orders governanceProfileVersion against something other than a safe integer.` });
      }
      const readsFact = condition.field === 'contextFact' || condition.field === 'restrictiveFact';
      if (readsFact && !isFactClass(condition.factClass)) {
        issues.push({ code: 'INVALID_CONTEXT_PREDICATE', message: `Rule ${ruleId} reads trusted context without naming its fact class (factClass).` });
      }
      if (!readsFact && condition.factClass !== undefined) {
        issues.push({ code: 'INVALID_CONTEXT_PREDICATE', message: `Rule ${ruleId} names a factClass on a predicate over ${condition.field}; only 'contextFact' and 'restrictiveFact' read a fact.` });
      }
      if (readsFact && (condition.metadataPath !== undefined || condition.parameterId !== undefined)) {
        issues.push({ code: 'INVALID_CONTEXT_PREDICATE', message: `Rule ${ruleId} gives a fact predicate a path or parameter id; a fact is read by its exact class, never by path.` });
      }
      if (condition.field === 'metadata' && readsReservedMetadata(condition.metadataPath)) {
        issues.push({
          code: 'INVALID_CONTEXT_PREDICATE',
          message: `Rule ${ruleId} reads the reserved '${condition.metadataPath ?? ''}' namespace by path; trusted context is read only through 'contextFact' / 'restrictiveFact', which see admitted facts and nothing else.`,
        });
      }
      if (condition.valueFrom !== undefined) {
        const from = condition.valueFrom as { readonly field?: unknown; readonly factClass?: unknown };
        if (from.field !== 'contextFact' || !isFactClass(from.factClass) || Object.keys(condition.valueFrom).some((key) => key !== 'field' && key !== 'factClass')) {
          issues.push({ code: 'INVALID_CONTEXT_PREDICATE', message: `Rule ${ruleId} names a comparand other than an admitted material fact ({ field: 'contextFact', factClass }).` });
        }
        if (condition.value !== undefined) {
          issues.push({ code: 'INVALID_CONTEXT_PREDICATE', message: `Rule ${ruleId} states both a literal value and a fact comparand; a predicate compares against one.` });
        }
        if (condition.operator === 'exists' || condition.operator === 'not_exists' || condition.field === 'restrictiveFact') {
          issues.push({ code: 'INVALID_CONTEXT_PREDICATE', message: `Rule ${ruleId} gives a fact comparand to an existence test or a restrict-only fact.` });
        }
      }
      if (condition.field === 'restrictiveFact' && (negated || NEGATED_OPERATORS.has(condition.operator))) {
        issues.push({
          code: 'RESTRICTIVE_FACT_NOT_MONOTONE',
          message: `Rule ${ruleId} reads a restrict-only fact in negated position (${negated ? 'under a not group' : condition.operator}); its presence could then relax the rule.`,
        });
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
