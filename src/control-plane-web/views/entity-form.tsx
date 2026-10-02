import * as React from 'react';

import { BOUNDED_KINDS, ENTITY_FORM_SPECS, PARAMETER_BOUND_FORM_LABELS, PARAMETER_BOUND_FORMS, parameterBoundRowCount, type FieldSpec, type FormErrors } from '../forms.js';
import { ENTITY_KIND_LABELS, type EntityKind } from '../wire.js';
import { CsrfField, FieldError } from './components.js';

export type FormValues = Readonly<Record<string, string>>;

export interface EntityFormProps {
  readonly kind: EntityKind;
  readonly action: string;
  readonly csrfToken: string;
  readonly idempotencyKey: string;
  readonly values: FormValues;
  readonly errors: FormErrors;
  /** Dimensions the Host's Governance Profiles name — choices only; the Host checks every bound against its declarations. */
  readonly dimensions: readonly string[];
  /** Fields fixed by the page (for example the actor type on agent onboarding): rendered read-only, sent as typed. */
  readonly fixed?: Readonly<Record<string, string>>;
  readonly submitLabel: string;
}

function Field({ spec, value, error, fixed }: { readonly spec: FieldSpec; readonly value: string; readonly error: string | undefined; readonly fixed: boolean }): React.ReactElement {
  const id = `field-${spec.name.replace(/\./g, '-')}`;
  const label = (
    <label htmlFor={id}>
      {spec.label}
      {spec.required ? <span className="required"> (required)</span> : null}
    </label>
  );
  let control: React.ReactElement;
  if (fixed) {
    control = <input id={id} name={spec.name} value={value} readOnly className="input input--fixed" />;
  } else if (spec.kind === 'select') {
    control = (
      <select id={id} name={spec.name} defaultValue={value} className="input" required={spec.required}>
        {spec.required ? null : <option value="">—</option>}
        {(spec.options ?? []).map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  } else if (spec.kind === 'boolean') {
    control = (
      <select id={id} name={spec.name} defaultValue={value} className="input">
        <option value="">not stated</option>
        <option value="true">yes</option>
        <option value="false">no</option>
      </select>
    );
  } else if (spec.kind === 'list') {
    control = <textarea id={id} name={spec.name} defaultValue={value} rows={2} className="input" required={spec.required} />;
  } else {
    control = (
      <input
        id={id}
        name={spec.name}
        defaultValue={value}
        className="input"
        required={spec.required}
        autoComplete="off"
        spellCheck={false}
        {...(spec.kind === 'depth' ? { inputMode: 'numeric' as const } : {})}
        {...(spec.kind === 'instant' ? { placeholder: 'YYYY-MM-DDTHH:MM:SSZ' } : {})}
      />
    );
  }
  return (
    <div className={error !== undefined ? 'field field--error' : 'field'}>
      {label}
      {control}
      {spec.help !== undefined ? <p className="help">{spec.help}</p> : null}
      <FieldError message={error} />
    </div>
  );
}

/** A closed provisioning form for one Kernel-Authority entity kind. */
export function EntityForm(props: EntityFormProps): React.ReactElement {
  const { kind, values, errors } = props;
  const value = (name: string): string => props.fixed?.[name] ?? values[name] ?? '';
  return (
    <form method="post" action={props.action} className="form" data-entity-form={kind}>
      <CsrfField token={props.csrfToken} />
      <input type="hidden" name="idempotencyKey" value={props.idempotencyKey} />
      <fieldset>
        <legend>{ENTITY_KIND_LABELS[kind]}</legend>
        {ENTITY_FORM_SPECS[kind].map((spec) => (
          <Field key={spec.name} spec={spec} value={value(spec.name)} error={errors[spec.name]} fixed={props.fixed?.[spec.name] !== undefined} />
        ))}
        <FieldError message={errors['externalSubject']} />
      </fieldset>
      {BOUNDED_KINDS.includes(kind) ? (
        <>
          <fieldset>
            <legend>Monetary limits (optional)</legend>
            <p className="help">Recorded as P10 constraints. Amounts are canonical decimal text; the asset must be in the Host’s trusted asset registry.</p>
            <div className="field-row">
              <div className="field">
                <label htmlFor="maxAmount-currency">Per-execution ceiling: asset</label>
                <input id="maxAmount-currency" name="maxAmount.currency" defaultValue={value('maxAmount.currency')} className="input" autoComplete="off" />
              </div>
              <div className="field">
                <label htmlFor="maxAmount-value">Per-execution ceiling: amount</label>
                <input id="maxAmount-value" name="maxAmount.value" defaultValue={value('maxAmount.value')} className="input" autoComplete="off" />
              </div>
            </div>
            <FieldError message={errors['maxAmount']} />
            <div className="field-row">
              <div className="field">
                <label htmlFor="spendingLimit-limitId">Aggregate limit: id</label>
                <input id="spendingLimit-limitId" name="spendingLimit.limitId" defaultValue={value('spendingLimit.limitId')} className="input" autoComplete="off" />
              </div>
              <div className="field">
                <label htmlFor="spendingLimit-currency">Aggregate limit: asset</label>
                <input id="spendingLimit-currency" name="spendingLimit.currency" defaultValue={value('spendingLimit.currency')} className="input" autoComplete="off" />
              </div>
              <div className="field">
                <label htmlFor="spendingLimit-maximum">Aggregate limit: maximum</label>
                <input id="spendingLimit-maximum" name="spendingLimit.maximum" defaultValue={value('spendingLimit.maximum')} className="input" autoComplete="off" />
              </div>
              <div className="field">
                <label htmlFor="spendingLimit-window">Window</label>
                <select id="spendingLimit-window" name="spendingLimit.window" defaultValue={value('spendingLimit.window') || 'lifetime'} className="input">
                  <option value="lifetime">lifetime</option>
                  <option value="rolling">rolling</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="spendingLimit-seconds">Rolling window seconds</label>
                <input id="spendingLimit-seconds" name="spendingLimit.seconds" defaultValue={value('spendingLimit.seconds')} className="input" inputMode="numeric" autoComplete="off" />
              </div>
            </div>
            <FieldError message={errors['spendingLimit']} />
          </fieldset>
          <fieldset>
            <legend>Typed parameter bounds (optional)</legend>
            <p className="help">
              Each row bounds one declared governed parameter: a dimension, how it is bounded, and the value. The Host refuses a bound on an undeclared dimension, of the wrong type, or not governed for every action × resource in
              scope — and a delegation that drops or widens an upstream bound.
            </p>
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Dimension</th>
                  <th scope="col">Bound</th>
                  <th scope="col">Value</th>
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: parameterBoundRowCount(values) }, (_, row) => (
                  <tr key={row}>
                    <td>
                      <label className="visually-hidden" htmlFor={`bound-${row}-dimension`}>
                        Bound {row + 1} dimension
                      </label>
                      <select id={`bound-${row}-dimension`} name={`bound.${row}.dimension`} defaultValue={value(`bound.${row}.dimension`)} className="input">
                        <option value="">—</option>
                        {[...new Set([...props.dimensions, ...(value(`bound.${row}.dimension`) !== '' ? [value(`bound.${row}.dimension`)] : [])])].map((dimension) => (
                          <option key={dimension} value={dimension}>
                            {dimension}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <label className="visually-hidden" htmlFor={`bound-${row}-form`}>
                        Bound {row + 1} kind
                      </label>
                      <select id={`bound-${row}-form`} name={`bound.${row}.form`} defaultValue={value(`bound.${row}.form`) || 'maximum-integer'} className="input">
                        {PARAMETER_BOUND_FORMS.map((form) => (
                          <option key={form} value={form}>
                            {PARAMETER_BOUND_FORM_LABELS[form]}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <label className="visually-hidden" htmlFor={`bound-${row}-value`}>
                        Bound {row + 1} value
                      </label>
                      <input id={`bound-${row}-value`} name={`bound.${row}.value`} defaultValue={value(`bound.${row}.value`)} className="input" autoComplete="off" />
                      <FieldError message={errors[`bound.${row}`]} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </fieldset>
        </>
      ) : null}
      <div className="form__actions">
        <button type="submit" className="button button--primary">
          {props.submitLabel}
        </button>
      </div>
    </form>
  );
}
