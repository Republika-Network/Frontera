import type { FormFields } from './security.js';
import type { EntityKind } from './wire.js';

/**
 * CTRL-03 — closed provisioning forms.
 *
 * One declarative spec per Kernel-Authority entity kind, mirroring the Host's
 * closed request schema for that kind (`POST /api/admin/authority/entities/{kind}`)
 * field for field. The builder reads **only** the fields a spec names and
 * emits **only** the canonical request DTO: there is no free-form JSON, no
 * pass-through of unknown form fields, and no field for an organization, an
 * operator, `system`, provenance, a digest, a signature or a bounded grant —
 * those are never the browser's to state.
 *
 * Parsing is strict and never "fixes up" input: an integer bound is an integer
 * as typed (no `3.0`, no `+3`), a half-filled bound row or monetary limit is an
 * error rather than silently dropped, and every value is sent as typed for the
 * Host to judge. The Host's validation is authoritative; its refusal is shown
 * as it is.
 */

export type FieldKind = 'id' | 'text' | 'list' | 'select' | 'boolean' | 'depth' | 'instant';

export interface FieldSpec {
  readonly name: string;
  readonly label: string;
  readonly kind: FieldKind;
  readonly required: boolean;
  readonly options?: readonly string[];
  readonly help?: string;
}

const ACTOR_TYPES = ['human', 'agent', 'organization', 'system'];
const DELEGATE_TYPES = ['human', 'organization', 'agent', 'system'];

const id = (name: string, label: string, required = true, help?: string): FieldSpec => ({ name, label, kind: 'id', required, ...(help !== undefined ? { help } : {}) });
const text = (name: string, label: string, required = true, help?: string): FieldSpec => ({ name, label, kind: 'text', required, ...(help !== undefined ? { help } : {}) });
const list = (name: string, label: string, required = true, help?: string): FieldSpec => ({
  name,
  label,
  kind: 'list',
  required,
  help: help ?? 'One identifier per line (or comma-separated).',
});
const select = (name: string, label: string, options: readonly string[], required = true): FieldSpec => ({ name, label, kind: 'select', required, options });
const flag = (name: string, label: string): FieldSpec => ({ name, label, kind: 'boolean', required: false });

/** The closed field set per kind — the Host's `FIELDS` table, nothing more. */
export const ENTITY_FORM_SPECS: Readonly<Record<EntityKind, readonly FieldSpec[]>> = {
  actor: [
    id('actorId', 'Actor id'),
    select('type', 'Actor type', ACTOR_TYPES),
    text('displayName', 'Display name'),
    id('issuerId', 'Issuer actor id', false),
    id('trustDomainId', 'Trust domain id', false),
    text('jurisdiction', 'Jurisdiction', false),
    text('externalSubject.system', 'External subject: system', false, 'Required for an agent that will receive a credential: the identity system that names it.'),
    text('externalSubject.subjectId', 'External subject: subject id', false),
  ],
  'trust-domain': [
    id('trustDomainId', 'Trust domain id'),
    text('name', 'Name'),
    id('issuerActorId', 'Issuer actor id'),
    list('acceptedIssuerIds', 'Accepted issuer actor ids'),
    list('acceptedActorTypes', 'Accepted actor types', true, `One per line, from: ${ACTOR_TYPES.join(', ')}.`),
    text('jurisdiction', 'Jurisdiction', false),
    list('policyPackIds', 'Policy pack ids', false),
  ],
  'root-issuer': [id('trustDomainId', 'Trust domain id'), id('actorId', 'Issuer actor id')],
  passport: [
    id('passportId', 'Passport id'),
    select('type', 'Passport type', ['agent_passport', 'human_passport', 'organization_passport', 'system_passport']),
    id('subjectActorId', 'Subject actor id'),
    id('issuerActorId', 'Issuer actor id'),
    id('trustDomainId', 'Trust domain id'),
    { name: 'expiresAt', label: 'Expires at (UTC)', kind: 'instant', required: false },
  ],
  'capability-token': [
    id('capabilityTokenId', 'Capability token id'),
    id('subjectActorId', 'Subject actor id'),
    id('principalActorId', 'Principal actor id'),
    id('issuerActorId', 'Issuer actor id'),
    id('trustDomainId', 'Trust domain id'),
    text('capability', 'Capability'),
    list('actions', 'Actions'),
    list('resourceScopes', 'Resource scopes'),
    select('riskLevel', 'Risk level', ['low', 'medium', 'high', 'critical', 'prohibited']),
    list('prohibitedActions', 'Prohibited actions', false),
    flag('delegable', 'Delegable'),
    { name: 'maxDelegationDepth', label: 'Maximum delegation depth', kind: 'depth', required: false },
    text('jurisdiction', 'Jurisdiction', false),
    { name: 'expiresAt', label: 'Expires at (UTC)', kind: 'instant', required: false },
  ],
  'authority-grant': [
    id('authorityGrantId', 'Authority grant id'),
    id('issuerActorId', 'Issuer actor id'),
    id('subjectActorId', 'Subject actor id'),
    id('trustDomainId', 'Trust domain id'),
    text('capability', 'Capability'),
    list('actions', 'Actions'),
    list('resourceScopes', 'Resource scopes'),
    id('roleId', 'Role id', false),
    flag('canDelegate', 'May delegate'),
    list('allowedDelegateActorTypes', 'Allowed delegate actor types', false, `One per line, from: ${DELEGATE_TYPES.join(', ')}.`),
    { name: 'maxDelegationDepth', label: 'Maximum delegation depth', kind: 'depth', required: false },
    list('nonDelegableActions', 'Non-delegable actions', false),
    { name: 'expiresAt', label: 'Expires at (UTC)', kind: 'instant', required: false },
    id('parentGrantId', 'Parent authority grant id', false),
  ],
  'delegation-grant': [
    id('delegationGrantId', 'Delegation grant id'),
    id('delegatorActorId', 'Delegator actor id'),
    id('delegateActorId', 'Delegate actor id'),
    select('delegateActorType', 'Delegate actor type', DELEGATE_TYPES),
    id('trustDomainId', 'Trust domain id'),
    id('sourceAuthorityGrantId', 'Source grant id (authority or delegation)'),
    text('capability', 'Capability'),
    list('actions', 'Actions'),
    list('resourceScopes', 'Resource scopes'),
    id('principalActorId', 'Principal actor id', false),
    flag('canRedelegate', 'May re-delegate'),
    list('nonDelegableActions', 'Non-delegable actions', false),
    { name: 'expiresAt', label: 'Expires at (UTC)', kind: 'instant', required: false },
  ],
};

/** Kinds whose form carries monetary constraints and typed parameter bounds. */
export const BOUNDED_KINDS: readonly EntityKind[] = ['authority-grant', 'delegation-grant'];

/** Typed-parameter-bound rows: a form offers at least this many, and one more than the highest row in use. */
export const PARAMETER_BOUND_MIN_ROWS = 4;
/** The Host's own ceiling on bounds per record; every row up to it is read, so a prefilled lineage is never truncated. */
export const PARAMETER_BOUND_MAX_ROWS = 32;

/** How many bound rows to render for these form values: every row in use, plus one empty row, at least the minimum. */
export function parameterBoundRowCount(values: Readonly<Record<string, string>>): number {
  let highest = -1;
  for (const name of Object.keys(values)) {
    const match = /^bound\.(\d+)\./.exec(name);
    if (match !== null && (values[name] ?? '') !== '') highest = Math.max(highest, Number(match[1]));
  }
  return Math.min(PARAMETER_BOUND_MAX_ROWS, Math.max(PARAMETER_BOUND_MIN_ROWS, highest + 2));
}

/**
 * The bound forms an operator may choose — the canonical CORE-03 bound shapes,
 * named by what the Host accepts: an integer maximum, or an exact integer,
 * token or boolean. The dimension's declared type is the Host's to check.
 */
export const PARAMETER_BOUND_FORMS = ['maximum-integer', 'exact-integer', 'exact-token', 'exact-boolean'] as const;
export type ParameterBoundForm = (typeof PARAMETER_BOUND_FORMS)[number];
export const PARAMETER_BOUND_FORM_LABELS: Readonly<Record<ParameterBoundForm, string>> = {
  'maximum-integer': 'maximum (integer, inclusive)',
  'exact-integer': 'exactly (integer)',
  'exact-token': 'exactly (token)',
  'exact-boolean': 'exactly (boolean)',
};

export type FormErrors = Readonly<Record<string, string>>;
export type BuildResult = { readonly ok: true; readonly body: Readonly<Record<string, unknown>> } | { readonly ok: false; readonly errors: FormErrors };

const INTEGER = /^-?(?:0|[1-9][0-9]*)$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function listOf(value: string): readonly string[] {
  return value
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** A strict decimal integer, exactly as typed: no sign but `-`, no leading zeros, no fraction, no exponent, safe range only. */
export function parseStrictInteger(value: string): number | undefined {
  if (!INTEGER.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && !Object.is(parsed, -0) ? parsed : undefined;
}

/** Builds the canonical typed parameter bound list from the form's bound rows. A half-filled row is an error, never dropped. */
export function buildParameterBounds(form: FormFields, errors: Record<string, string>): readonly Record<string, unknown>[] {
  const bounds: Record<string, unknown>[] = [];
  for (let row = 0; row < PARAMETER_BOUND_MAX_ROWS; row += 1) {
    const dimension = form.text(`bound.${row}.dimension`);
    const shape = form.text(`bound.${row}.form`);
    // The value is taken exactly as typed — not trimmed — for the strict parse below and for the Host.
    const value = form.raw(`bound.${row}.value`);
    if (dimension === '' && value === '') continue;
    const where = `bound.${row}`;
    if (dimension === '') {
      errors[where] = 'A bound needs a dimension.';
      continue;
    }
    if (value === '') {
      errors[where] = `The bound on '${dimension}' needs a value.`;
      continue;
    }
    switch (shape) {
      case 'maximum-integer': {
        const limit = parseStrictInteger(value);
        if (limit === undefined) errors[where] = `The maximum for '${dimension}' must be a whole number as typed (for example 3).`;
        else bounds.push({ dimension, kind: 'maximum', type: 'integer', limit });
        break;
      }
      case 'exact-integer': {
        const exact = parseStrictInteger(value);
        if (exact === undefined) errors[where] = `The exact value for '${dimension}' must be a whole number as typed.`;
        else bounds.push({ dimension, kind: 'exact', type: 'integer', value: exact });
        break;
      }
      case 'exact-token':
        bounds.push({ dimension, kind: 'exact', type: 'token', value });
        break;
      case 'exact-boolean':
        if (value !== 'true' && value !== 'false') errors[where] = `The exact value for '${dimension}' must be true or false.`;
        else bounds.push({ dimension, kind: 'exact', type: 'boolean', value: value === 'true' });
        break;
      default:
        errors[where] = 'Choose how the dimension is bounded.';
    }
  }
  return bounds;
}

/** P10 monetary constraints, as canonical text. Each limit is all-or-nothing. */
export function buildMonetaryConstraints(form: FormFields, errors: Record<string, string>): readonly Record<string, unknown>[] {
  const constraints: Record<string, unknown>[] = [];
  const maxCurrency = form.text('maxAmount.currency');
  const maxValue = form.text('maxAmount.value');
  if (maxCurrency !== '' || maxValue !== '') {
    if (maxCurrency === '' || maxValue === '') errors['maxAmount'] = 'A per-execution ceiling needs both an asset and an amount.';
    else constraints.push({ type: 'max_amount', currency: maxCurrency, value: maxValue });
  }
  const limitId = form.text('spendingLimit.limitId');
  const limitCurrency = form.text('spendingLimit.currency');
  const limitMaximum = form.text('spendingLimit.maximum');
  const window = form.text('spendingLimit.window');
  const seconds = form.text('spendingLimit.seconds');
  if (limitId !== '' || limitCurrency !== '' || limitMaximum !== '' || seconds !== '') {
    if (limitId === '' || limitCurrency === '' || limitMaximum === '') {
      errors['spendingLimit'] = 'An aggregate limit needs a limit id, an asset and a maximum.';
    } else if (window === 'rolling') {
      const parsed = parseStrictInteger(seconds);
      if (parsed === undefined) errors['spendingLimit'] = 'A rolling window needs a whole number of seconds.';
      else constraints.push({ type: 'spending_limit', limitId, currency: limitCurrency, maximum: limitMaximum, window: { kind: 'rolling', seconds: parsed } });
    } else if (window === 'lifetime') {
      if (seconds !== '') errors['spendingLimit'] = 'A lifetime window takes no seconds.';
      else constraints.push({ type: 'spending_limit', limitId, currency: limitCurrency, maximum: limitMaximum, window: { kind: 'lifetime' } });
    } else {
      errors['spendingLimit'] = 'Choose the aggregate limit’s window.';
    }
  }
  return constraints;
}

/**
 * Builds the canonical provisioning request for `kind` from a submitted form.
 * Only the spec's fields (plus `idempotencyKey`, and for bounded kinds the
 * constraint and bound rows) are read; everything else in the form is ignored
 * by construction — it is never copied into the request.
 */
export function buildProvisionRequest(kind: EntityKind, form: FormFields): BuildResult {
  const errors: Record<string, string> = {};
  const body: Record<string, unknown> = {};
  const subject: Record<string, string> = {};
  for (const field of ENTITY_FORM_SPECS[kind]) {
    const raw = form.text(field.name);
    if (raw === '') {
      if (field.required) errors[field.name] = `${field.label} is required.`;
      continue;
    }
    let value: unknown;
    switch (field.kind) {
      case 'id':
      case 'text':
        value = raw;
        break;
      case 'select':
        if (field.options !== undefined && !field.options.includes(raw)) {
          errors[field.name] = `${field.label} must be one of: ${field.options.join(', ')}.`;
          continue;
        }
        value = raw;
        break;
      case 'list': {
        const entries = listOf(raw);
        if (entries.length === 0) {
          if (field.required) errors[field.name] = `${field.label} is required.`;
          continue;
        }
        value = entries;
        break;
      }
      case 'boolean':
        if (raw !== 'true' && raw !== 'false') {
          errors[field.name] = `${field.label} must be yes or no.`;
          continue;
        }
        value = raw === 'true';
        break;
      case 'depth': {
        const depth = parseStrictInteger(raw);
        if (depth === undefined) {
          errors[field.name] = `${field.label} must be a whole number.`;
          continue;
        }
        value = depth;
        break;
      }
      case 'instant':
        if (!INSTANT.test(raw)) {
          errors[field.name] = `${field.label} must be an ISO-8601 UTC instant (YYYY-MM-DDTHH:MM:SSZ).`;
          continue;
        }
        value = raw;
        break;
    }
    if (field.name.startsWith('externalSubject.')) subject[field.name.slice('externalSubject.'.length)] = raw;
    else body[field.name] = value;
  }
  if (Object.keys(subject).length > 0) {
    if (subject['system'] === undefined || subject['subjectId'] === undefined) errors['externalSubject'] = 'An external subject needs both its system and its subject id.';
    else body['externalSubject'] = { system: subject['system'], subjectId: subject['subjectId'] };
  }
  if (BOUNDED_KINDS.includes(kind)) {
    const constraints = buildMonetaryConstraints(form, errors);
    if (constraints.length > 0) body['constraints'] = constraints;
    const bounds = buildParameterBounds(form, errors);
    if (bounds.length > 0) body['parameterBounds'] = bounds;
  }
  const idempotencyKey = form.text('idempotencyKey');
  if (idempotencyKey !== '') body['idempotencyKey'] = idempotencyKey;
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, body };
}
