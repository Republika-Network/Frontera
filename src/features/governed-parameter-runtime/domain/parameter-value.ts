import { isSemanticIdentifier } from './semantic-identifier.js';

/**
 * Typed governed-action parameter values.
 *
 * > Money is one parameter dimension. It does not define the governed-action
 * > model.
 *
 * Three value types and no fourth, because three are what the current
 * non-financial domains need and every one has a total, exact comparison:
 *
 * | type | JavaScript value | accepted from | comparison |
 * | --- | --- | --- | --- |
 * | `integer` | a safe integer, never `-0` | a JSON number that *is* a safe integer | exact integer order |
 * | `token` | an opaque identifier string | a string in the token grammar | exact equality |
 * | `boolean` | `true` / `false` | a JSON boolean | exact equality |
 *
 * Monetary quantities are **not** a type here. Money keeps its own exact
 * representation (`MonetaryAmount`, P9) on its own dimension — the governed
 * action's `amount`, bounded by an authority-sourced ceiling (P10) — so nothing
 * in this module can ever turn money into a JavaScript number.
 *
 * ## No coercion, anywhere
 *
 * `"100"` is not the integer 100, `1` is not `true`, `100.5` is not an integer,
 * `null` is not an absent value and an empty string is not a token. Every
 * mismatch is a refusal naming the violation, never a best-effort conversion:
 * an authority-relevant value that had to be guessed is a value nobody stated.
 */
export const GOVERNED_PARAMETER_TYPES = ['boolean', 'integer', 'token'] as const;
export type GovernedParameterType = (typeof GOVERNED_PARAMETER_TYPES)[number];

export type GovernedParameterValue =
  | { readonly type: 'integer'; readonly value: number }
  | { readonly type: 'token'; readonly value: string }
  | { readonly type: 'boolean'; readonly value: boolean };

/** A typed value bound to the declared dimension it is a value of. */
export type GovernedParameter = { readonly dimension: string } & GovernedParameterValue;

export const GOVERNED_PARAMETER_TOKEN_MAX_LENGTH = 128;

/**
 * An opaque token: an environment name, a release version, a destination
 * reference. ASCII letters, digits and `.`, `_`, `:`, `@`, `-`, starting with a
 * letter or digit; at most 128 characters. No whitespace, no control
 * character, no `/` or `\` — nothing a path, URL or shell could reinterpret.
 */
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;

export function isGovernedParameterToken(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= GOVERNED_PARAMETER_TOKEN_MAX_LENGTH && TOKEN.test(value);
}

/** A safe integer, and never `-0` (which would give one value two spellings). */
export function isGovernedParameterInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0);
}

export function isGovernedParameterType(value: unknown): value is GovernedParameterType {
  return typeof value === 'string' && (GOVERNED_PARAMETER_TYPES as readonly string[]).includes(value);
}

export const GOVERNED_PARAMETER_VIOLATIONS = {
  PARAMETER_VALUE_WRONG_TYPE: 'PARAMETER_VALUE_WRONG_TYPE',
  PARAMETER_INTEGER_NOT_SAFE: 'PARAMETER_INTEGER_NOT_SAFE',
  PARAMETER_TOKEN_MALFORMED: 'PARAMETER_TOKEN_MALFORMED',
} as const;

export type GovernedParameterViolation = (typeof GOVERNED_PARAMETER_VIOLATIONS)[keyof typeof GOVERNED_PARAMETER_VIOLATIONS];

export type GovernedParameterParse = { readonly valid: true; readonly value: GovernedParameterValue } | { readonly valid: false; readonly violation: GovernedParameterViolation };

/**
 * The single ingress from untrusted data to a typed value of a *declared* type.
 * The type is the declaration's, never the caller's: a caller states a value,
 * and the trusted dimension says what that value has to be.
 */
export function parseGovernedParameterValue(type: GovernedParameterType, raw: unknown): GovernedParameterParse {
  switch (type) {
    case 'integer':
      if (typeof raw !== 'number') return { valid: false, violation: GOVERNED_PARAMETER_VIOLATIONS.PARAMETER_VALUE_WRONG_TYPE };
      if (!isGovernedParameterInteger(raw)) return { valid: false, violation: GOVERNED_PARAMETER_VIOLATIONS.PARAMETER_INTEGER_NOT_SAFE };
      return { valid: true, value: { type, value: raw } };
    case 'token':
      if (typeof raw !== 'string') return { valid: false, violation: GOVERNED_PARAMETER_VIOLATIONS.PARAMETER_VALUE_WRONG_TYPE };
      if (!isGovernedParameterToken(raw)) return { valid: false, violation: GOVERNED_PARAMETER_VIOLATIONS.PARAMETER_TOKEN_MALFORMED };
      return { valid: true, value: { type, value: raw } };
    case 'boolean':
      if (typeof raw !== 'boolean') return { valid: false, violation: GOVERNED_PARAMETER_VIOLATIONS.PARAMETER_VALUE_WRONG_TYPE };
      return { valid: true, value: { type, value: raw } };
    default:
      return { valid: false, violation: GOVERNED_PARAMETER_VIOLATIONS.PARAMETER_VALUE_WRONG_TYPE };
  }
}

/** Whether a value is well formed for the type it claims. Total; anything unrecognized is `false`. */
export function isWellFormedGovernedParameterValue(value: GovernedParameterValue): boolean {
  if (value === null || typeof value !== 'object') return false;
  switch (value.type) {
    case 'integer':
      return isGovernedParameterInteger(value.value);
    case 'token':
      return isGovernedParameterToken(value.value);
    case 'boolean':
      return typeof value.value === 'boolean';
    default:
      return false;
  }
}

export function isWellFormedGovernedParameter(parameter: GovernedParameter): boolean {
  return parameter !== null && typeof parameter === 'object' && isSemanticIdentifier(parameter.dimension) && isWellFormedGovernedParameterValue(parameter);
}

/** Two values are equal only when their types are equal and their values are identical. A token `"1"` is never the integer `1`. */
export function governedParameterValuesEqual(left: GovernedParameterValue, right: GovernedParameterValue): boolean {
  return left.type === right.type && left.value === right.value;
}
