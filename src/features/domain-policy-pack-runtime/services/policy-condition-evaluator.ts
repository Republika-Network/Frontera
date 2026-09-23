import { canonicalDecimalFromNumber, compareCanonicalDecimals, isCanonicalDecimal } from '../../monetary-runtime/index.js';
import type { PolicyCondition, PolicyPredicateCondition, PolicyPredicateField } from '../domain/policy-pack-condition.js';
import type { PolicyEvaluationInput } from '../domain/policy-pack-evaluation.js';

export interface PolicyConditionEvaluationResult {
  readonly matched: boolean;
  readonly reason: string;
}

/**
 * Evaluates PolicyCondition trees against a PolicyEvaluationInput
 * deterministically. No eval/new Function, no regex, no LLM calls -- every
 * operator is a plain, total function over the input's known fields.
 */
export class PolicyConditionEvaluator {
  evaluate(condition: PolicyCondition, input: PolicyEvaluationInput): PolicyConditionEvaluationResult {
    if (condition.type === 'group') {
      return this.evaluateGroup(condition.operator, condition.conditions, input);
    }
    return this.evaluatePredicate(condition, input);
  }

  private evaluateGroup(
    operator: 'all' | 'any' | 'not',
    conditions: readonly PolicyCondition[],
    input: PolicyEvaluationInput,
  ): PolicyConditionEvaluationResult {
    const results = conditions.map((condition) => this.evaluate(condition, input));

    if (operator === 'all') {
      const matched = results.every((result) => result.matched);
      return { matched, reason: matched ? 'all conditions matched' : 'not all conditions matched' };
    }
    if (operator === 'any') {
      const matched = results.some((result) => result.matched);
      return { matched, reason: matched ? 'at least one condition matched' : 'no condition matched' };
    }
    // not: true only when every nested condition is false (canonical NOR semantics for a group).
    const matched = results.every((result) => !result.matched);
    return { matched, reason: matched ? 'no nested condition matched' : 'a nested condition matched' };
  }

  private evaluatePredicate(condition: PolicyPredicateCondition, input: PolicyEvaluationInput): PolicyConditionEvaluationResult {
    const fieldValue = this.getFieldValue(condition, input);
    const matched = this.applyOperator(condition.operator, fieldValue, condition.value);
    return {
      matched,
      reason: `${condition.field}${condition.metadataPath ? `.${condition.metadataPath}` : ''} ${condition.operator} ${JSON.stringify(condition.value)} -> ${String(matched)}`,
    };
  }

  private getFieldValue(condition: PolicyPredicateCondition, input: PolicyEvaluationInput): unknown {
    if (condition.field === 'metadata') {
      if (!condition.metadataPath) {
        return input.metadata;
      }
      return this.readMetadataPath(input.metadata, condition.metadataPath);
    }
    return this.readKnownField(condition.field, input);
  }

  private readKnownField(field: PolicyPredicateField, input: PolicyEvaluationInput): unknown {
    switch (field) {
      case 'trustDomainId':
        return input.trustDomainId;
      case 'actorId':
        return input.actorId;
      case 'actorType':
        return input.actorType;
      case 'principalActorId':
        return input.principalActorId;
      case 'action':
        return input.action;
      case 'capability':
        return input.capability;
      case 'resourceScope':
        return input.resourceScope;
      case 'riskLevel':
        return input.riskLevel;
      case 'jurisdiction':
        return input.jurisdiction;
      case 'country':
        return input.country;
      case 'industry':
        return input.industry;
      case 'domain':
        return input.domain;
      case 'amount':
        return input.amount;
      case 'currency':
        return input.currency;
      case 'counterpartyId':
        return input.counterpartyId;
      case 'dataDomains':
        return input.dataDomains;
      case 'sideEffectType':
        return input.sideEffectType;
      case 'hasApprovalProof':
        return input.hasApprovalProof;
      case 'hasAuthorityProof':
        return input.hasAuthorityProof;
      case 'hasHandshakeProof':
        return input.hasHandshakeProof;
      case 'hasRequiredEvidence':
        return input.hasRequiredEvidence;
      case 'metadata':
        return input.metadata;
      default:
        return undefined;
    }
  }

  private readMetadataPath(metadata: Readonly<Record<string, unknown>> | undefined, path: string): unknown {
    if (!metadata) {
      return undefined;
    }
    const segments = path.split('.').filter((segment) => segment.length > 0);
    let current: unknown = metadata;
    for (const segment of segments) {
      if (current === null || typeof current !== 'object') {
        return undefined;
      }
      current = (current as Record<string, unknown>)[segment];
    }
    return current;
  }

  private applyOperator(operator: PolicyPredicateCondition['operator'], fieldValue: unknown, expected: unknown): boolean {
    switch (operator) {
      case 'equals':
        return fieldValue === expected;
      case 'not_equals':
        return fieldValue !== expected;
      case 'includes':
        return this.collectionIncludes(fieldValue, expected);
      case 'not_includes':
        return !this.collectionIncludes(fieldValue, expected);
      case 'starts_with':
        return typeof fieldValue === 'string' && typeof expected === 'string' && fieldValue.startsWith(expected);
      case 'ends_with':
        return typeof fieldValue === 'string' && typeof expected === 'string' && fieldValue.endsWith(expected);
      case 'in':
        return Array.isArray(expected) && expected.includes(fieldValue);
      case 'not_in':
        return !(Array.isArray(expected) && expected.includes(fieldValue));
      case 'greater_than':
        return this.compareOrdered(fieldValue, expected, (order) => order > 0);
      case 'greater_than_or_equal':
        return this.compareOrdered(fieldValue, expected, (order) => order >= 0);
      case 'less_than':
        return this.compareOrdered(fieldValue, expected, (order) => order < 0);
      case 'less_than_or_equal':
        return this.compareOrdered(fieldValue, expected, (order) => order <= 0);
      case 'exists':
        return fieldValue !== undefined && fieldValue !== null;
      case 'not_exists':
        return fieldValue === undefined || fieldValue === null;
      default:
        return false;
    }
  }

  private collectionIncludes(fieldValue: unknown, expected: unknown): boolean {
    if (Array.isArray(fieldValue)) {
      return fieldValue.includes(expected);
    }
    if (typeof fieldValue === 'string' && typeof expected === 'string') {
      return fieldValue.includes(expected);
    }
    return false;
  }

  /**
   * An ordered comparison, exact wherever the field is a monetary quantity.
   *
   * A canonical decimal field (`amount`, since P9) is compared with `BigInt`
   * arithmetic against the policy's threshold — itself canonical decimal text,
   * or a finite number literal read as the exact decimal its author wrote
   * (`10000` → `"10000"`). Nothing here turns the field into a number. Any
   * other pairing of a number with a number compares as before; every other
   * pairing does not match.
   */
  private compareOrdered(fieldValue: unknown, expected: unknown, accepts: (order: -1 | 0 | 1) => boolean): boolean {
    if (isCanonicalDecimal(fieldValue)) {
      if (typeof expected === 'number' && Number.isFinite(expected) && expected < 0) return accepts(1);
      const threshold = typeof expected === 'number' ? canonicalDecimalFromNumber(expected) : isCanonicalDecimal(expected) ? expected : undefined;
      return threshold !== undefined && accepts(compareCanonicalDecimals(fieldValue, threshold));
    }
    if (typeof fieldValue !== 'number' || typeof expected !== 'number') {
      return false;
    }
    return accepts(fieldValue < expected ? -1 : fieldValue > expected ? 1 : 0);
  }
}
