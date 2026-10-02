import * as React from 'react';

// Reused from the legacy library (`src/features/aoc-control-plane`): two pure,
// props-only presentation components that fit unchanged — no runtime handle,
// no fixture, no command, no branding. Nothing else from that library is used.
import { AocEmptyState } from '../../features/aoc-control-plane/components/AocEmptyState.js';
import { AocErrorState } from '../../features/aoc-control-plane/components/AocErrorState.js';
import { FAILURE_GUIDANCE, type HostFailure } from '../failures.js';

/** A canonical status value, rendered as text plus a symbol — never colour alone. The value is shown exactly as the Host stated it. */
export function Status({ value }: { readonly value: string }): React.ReactElement {
  const tone = ['active', 'assigned', 'exercisable', 'allowed', 'valid', 'executed'].includes(value)
    ? 'ok'
    : ['revoked', 'retired', 'denied', 'unusable', 'invalid', 'failed'].includes(value)
      ? 'stop'
      : 'neutral';
  const symbol = tone === 'ok' ? '●' : tone === 'stop' ? '✕' : '○';
  return (
    <span className={`status status--${tone}`}>
      <span aria-hidden="true">{symbol}</span> {value}
    </span>
  );
}

/** An identifier: monospace, selectable, never truncated. */
export function Id({ value }: { readonly value: string }): React.ReactElement {
  return <code className="id">{value}</code>;
}

/** A recorded timestamp, exactly as recorded (ISO-8601, UTC). A missing one says so. */
export function Time({ value }: { readonly value: string | null | undefined }): React.ReactElement {
  if (value === null || value === undefined || value === '') return <span className="missing">not recorded</span>;
  return <time dateTime={value}>{value}</time>;
}

export function Text({ value }: { readonly value: string | null | undefined }): React.ReactElement {
  if (value === null || value === undefined || value === '') return <span className="muted">—</span>;
  return <>{value}</>;
}

export function KeyValues({ rows }: { readonly rows: readonly (readonly [string, React.ReactNode])[] }): React.ReactElement {
  return (
    <dl className="kv">
      {rows.map(([label, value]) => (
        <React.Fragment key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

export function Notice({ tone, title, children }: { readonly tone: 'info' | 'warning' | 'danger' | 'success'; readonly title: string; readonly children?: React.ReactNode }): React.ReactElement {
  return (
    <section className={`notice notice--${tone}`} role={tone === 'danger' || tone === 'warning' ? 'alert' : 'status'}>
      <h2 className="notice__title">{title}</h2>
      {children}
    </section>
  );
}

/** A Host failure, by kind, with its exact guidance — and the Host's own code and message. */
export function FailureNotice({ failure }: { readonly failure: HostFailure }): React.ReactElement {
  const { title, guidance } = FAILURE_GUIDANCE[failure.kind];
  return (
    <section className={`notice notice--${failure.kind === 'recorded-refresh-failed' ? 'warning' : 'danger'}`} data-failure-kind={failure.kind}>
      <h2 className="notice__title">{title}</h2>
      <p>{guidance}</p>
      {failure.code !== null ? <AocErrorState message={failure.message} reasonCode={failure.code} /> : <AocErrorState message={failure.message} />}
      {failure.failure !== null ? (
        <p>
          Refusal reason: <Id value={failure.failure} />
        </p>
      ) : null}
      {failure.recorded === true ? <p className="emphasis">The Host states this write was recorded.</p> : null}
      {failure.recorded === false ? <p>The Host states nothing was recorded.</p> : null}
      {failure.status !== null ? <p className="muted">HTTP {failure.status}</p> : null}
    </section>
  );
}

export function Empty({ message }: { readonly message: string }): React.ReactElement {
  return <AocEmptyState message={message} />;
}

export function CsrfField({ token }: { readonly token: string }): React.ReactElement {
  return <input type="hidden" name="csrf" value={token} />;
}

export function FieldError({ message }: { readonly message: string | undefined }): React.ReactElement | null {
  if (message === undefined) return null;
  return (
    <p className="field-error" role="alert">
      {message}
    </p>
  );
}

export function List({ values }: { readonly values: readonly string[] | undefined }): React.ReactElement {
  if (values === undefined || values.length === 0) return <span className="muted">none</span>;
  return (
    <ul className="inline-list">
      {values.map((value) => (
        <li key={value}>
          <Id value={value} />
        </li>
      ))}
    </ul>
  );
}

export function Section({ title, children, actions }: { readonly title: string; readonly children: React.ReactNode; readonly actions?: React.ReactNode }): React.ReactElement {
  return (
    <section className="panel">
      <header className="panel__header">
        <h2>{title}</h2>
        {actions !== undefined ? <div className="panel__actions">{actions}</div> : null}
      </header>
      {children}
    </section>
  );
}

/** A text link styled as an action. Navigation only — every change is a POST form. */
export function ActionLink({ href, children }: { readonly href: string; readonly children: React.ReactNode }): React.ReactElement {
  return (
    <a className="action-link" href={href}>
      {children}
    </a>
  );
}
