import * as React from 'react';

import type { HostFailure } from '../failures.js';
import { ENTITY_KINDS, type AgentView, type CredentialIssueResult, type EmergencyControls, type EntityView, type OrganizationContext, type ProfileCatalog } from '../wire.js';
import { ActionLink, CsrfField, Empty, FailureNotice, Id, KeyValues, Notice, Section, Status } from './components.js';
import { may, Page } from './layout.js';

export function LoginPage({ loginToken, message, failure }: { readonly loginToken: string; readonly message?: string; readonly failure?: HostFailure }): React.ReactElement {
  return (
    <Page title="Sign in">
      <section className="panel panel--narrow">
        {message !== undefined ? <Notice tone="info" title={message} /> : null}
        {failure !== undefined ? <FailureNotice failure={failure} /> : null}
        <form method="post" action="/login" className="form" autoComplete="off">
          <input type="hidden" name="loginToken" value={loginToken} />
          <div className="field">
            <label htmlFor="credential">Operator credential</label>
            <input id="credential" name="credential" type="password" className="input" required autoComplete="off" spellCheck={false} />
            <p className="help">
              Your Frontera operator bearer credential. It is sent once to this console’s server, verified with the Host, and then held only in the server’s memory for this session. It is never stored in your browser, never placed in a
              URL and never shown again. Only identified operators (declared with a role) can sign in; CTRL-01 administrator credentials and agent credentials cannot. Single sign-on and MFA are not part of this release.
            </p>
          </div>
          <div className="form__actions">
            <button type="submit" className="button button--primary">
              Sign in
            </button>
          </div>
        </form>
      </section>
    </Page>
  );
}

export interface OverviewData {
  readonly agents: readonly AgentView[] | HostFailure;
  readonly entities: readonly EntityView[] | HostFailure;
  readonly profiles: ProfileCatalog | HostFailure;
  readonly emergency: EmergencyControls | HostFailure;
}

const isFailure = (value: unknown): value is HostFailure => typeof value === 'object' && value !== null && 'kind' in value && 'message' in value && !Array.isArray(value);

export function OverviewPage({ context, csrfToken, flash, data }: { readonly context: OrganizationContext; readonly csrfToken: string; readonly flash?: string; readonly data: OverviewData }): React.ReactElement {
  const { organization, operator } = context;
  return (
    <Page title="Overview" context={context} csrfToken={csrfToken} active="/" {...(flash !== undefined ? { flash } : {})}>
      <Section title="Control context">
        <KeyValues
          rows={[
            ['Organization', <Id key="o" value={organization.organizationId} />],
            ['Governed-action trust domain', organization.trustDomainId === null ? 'not composed' : <Id key="t" value={organization.trustDomainId} />],
            ['Agent credentials', organization.agentCredentials],
            ['Governance Profile lifecycle', organization.profileLifecycle],
            ['Operator', <Id key="op" value={operator.operatorId} />],
            ['Role', operator.role],
            ['Credential class', operator.credentialClass],
            ['Permissions (reported by the Host)', <ul key="p" className="inline-list">{operator.permissions.map((permission) => <li key={permission}><code>{permission}</code></li>)}</ul>],
          ]}
        />
        <p className="help">One organization per Host. The organization and your identity are the Host’s own answer; nothing on this page can select another.</p>
      </Section>
      <Section title="Agents">
        {isFailure(data.agents) ? (
          <FailureNotice failure={data.agents} />
        ) : (
          <KeyValues
            rows={[
              ['Agent actors', String(data.agents.length)],
              ['Actor active', String(data.agents.filter((agent) => agent.status === 'active').length)],
              ['Actor revoked', String(data.agents.filter((agent) => agent.status === 'revoked').length)],
              ['With an active credential', String(data.agents.filter((agent) => agent.onboarding.credential === 'active').length)],
              ['With standing authority assigned', String(data.agents.filter((agent) => agent.onboarding.standingAuthority === 'assigned').length)],
            ]}
          />
        )}
      </Section>
      <Section title="Standing authority (Kernel Authority records)">
        {isFailure(data.entities) ? (
          <FailureNotice failure={data.entities} />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Kind</th>
                <th scope="col">Active</th>
                <th scope="col">Revoked</th>
              </tr>
            </thead>
            <tbody>
              {ENTITY_KINDS.map((kind) => {
                const entities = data.entities as readonly EntityView[];
                return (
                  <tr key={kind}>
                    <td>
                      <a href={`/authority?kind=${kind}`}>{kind}</a>
                    </td>
                    <td>{entities.filter((entity) => entity.entityKind === kind && entity.status === 'active').length}</td>
                    <td>{entities.filter((entity) => entity.entityKind === kind && entity.status === 'revoked').length}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Section>
      <Section title="Governance Profiles">
        {isFailure(data.profiles) ? (
          <FailureNotice failure={data.profiles} />
        ) : (
          <KeyValues
            rows={[
              ['Lifecycle', data.profiles.lifecycle],
              ['Versions in the catalog', String(data.profiles.profiles.length)],
              ['Active', String(data.profiles.profiles.filter((profile) => profile.state === 'active').length)],
              ['Draft', String(data.profiles.profiles.filter((profile) => profile.state === 'draft').length)],
              ['Retired', String(data.profiles.profiles.filter((profile) => profile.state === 'retired').length)],
            ]}
          />
        )}
      </Section>
      <Section title="Emergency controls" actions={may(context, 'emergency.stop') || may(context, 'emergency.release') ? <ActionLink href="/emergency">Manage emergency controls</ActionLink> : undefined}>
        {isFailure(data.emergency) ? (
          <FailureNotice failure={data.emergency} />
        ) : data.emergency.active.length === 0 ? (
          <Empty message="No emergency control is active." />
        ) : (
          <ul>
            {data.emergency.active.map((control) => (
              <li key={`${control.scope}:${control.value ?? ''}`}>
                <Status value="stopped" /> scope <code>{control.scope}</code>
                {control.value !== undefined ? (
                  <>
                    {' '}
                    = <Id value={control.value} />
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </Page>
  );
}

export function ErrorPage({ title, failure, context, csrfToken, children }: { readonly title: string; readonly failure?: HostFailure; readonly context?: OrganizationContext; readonly csrfToken?: string; readonly children?: React.ReactNode }): React.ReactElement {
  return (
    <Page title={title} {...(context !== undefined ? { context } : {})} {...(csrfToken !== undefined ? { csrfToken } : {})}>
      {failure !== undefined ? <FailureNotice failure={failure} /> : null}
      {children}
    </Page>
  );
}

/**
 * The one place an agent credential secret is ever rendered: the response to
 * the request that created it. It is not stored anywhere — not in the session,
 * not in a cookie, not in a URL — so this page cannot be produced again.
 */
export function CredentialIssuedPage({ context, csrfToken, result, rotated }: { readonly context: OrganizationContext; readonly csrfToken: string; readonly result: CredentialIssueResult; readonly rotated: boolean }): React.ReactElement {
  const agentPath = `/agents/${encodeURIComponent(result.actorId)}`;
  return (
    <Page title={rotated ? 'Agent credential rotated' : 'Agent credential issued'} context={context} csrfToken={csrfToken} active="/agents">
      {result.bearerCredential !== null ? (
        <>
          <Notice tone="warning" title="Store this credential now. It is shown exactly once and cannot be recovered.">
            <p>
              The Host keeps only a verifier of this secret. Neither the Host nor this console can show it again: reloading or returning to this page will not reveal it. If it is lost, rotate the credential to replace it. Nothing has been
              copied anywhere for you; select the text below yourself.
            </p>
          </Notice>
          <section className="panel secret-panel" aria-label="One-time agent credential">
            <p>
              Bearer credential for agent <Id value={result.actorId} /> (credential <Id value={result.credential.credentialId} />):
            </p>
            <pre className="secret" data-testid="one-time-secret">
              {result.bearerCredential}
            </pre>
            <p className="help">Configure it as the agent runtime’s <code>Authorization: Bearer</code> credential for governed actions. It identifies the agent; it carries no authority of its own.</p>
          </section>
        </>
      ) : (
        <Notice tone="info" title="This request was already processed — the credential cannot be shown again.">
          <p>
            The Host answered with a replay of an earlier, identical request (outcome <code>{result.outcome}</code>). The secret was revealed only in the first response and was never stored. If it was not captured, rotate the credential to
            issue a new one.
          </p>
        </Notice>
      )}
      <Section title="Recorded credential metadata">
        <KeyValues
          rows={[
            ['Outcome', <code key="o">{result.outcome}</code>],
            ['Agent', <Id key="a" value={result.actorId} />],
            ['Principal', <Id key="p" value={result.principalId} />],
            ['Credential', <Id key="c" value={result.credential.credentialId} />],
            ['Status', <Status key="s" value={result.credential.status} />],
            ['Issued by', <Id key="b" value={result.credential.createdBy} />],
            ['Issued at', result.credential.createdAt],
          ]}
        />
        {result.replaced !== undefined ? (
          <p>
            The previous credential <Id value={result.replaced.credentialId} /> is now <Status value={result.replaced.status} /> and no longer authenticates the agent.
          </p>
        ) : null}
      </Section>
      <p>
        <a className="button" href={agentPath}>
          I have stored the credential — continue to the agent
        </a>
      </p>
    </Page>
  );
}

export interface ConfirmPageProps {
  readonly context: OrganizationContext;
  readonly csrfToken: string;
  readonly title: string;
  readonly active: string;
  readonly action: string;
  /** The exact target, its type and current status — read from the Host for this page. */
  readonly target: readonly (readonly [string, React.ReactNode])[];
  readonly warning: string;
  readonly consequences: readonly string[];
  readonly submitLabel: string;
  readonly hidden?: Readonly<Record<string, string>>;
  readonly reason?: { readonly kind: 'text'; readonly required: boolean } | { readonly kind: 'select'; readonly options: readonly string[] };
  readonly failure?: HostFailure;
  readonly cancel: string;
}

/** The deliberate confirmation step for every destructive or permitting operation. Nothing happens until its form is submitted. */
export function ConfirmPage(props: ConfirmPageProps): React.ReactElement {
  return (
    <Page title={props.title} context={props.context} csrfToken={props.csrfToken} active={props.active}>
      {props.failure !== undefined ? <FailureNotice failure={props.failure} /> : null}
      <Section title="Target">
        <KeyValues rows={props.target} />
      </Section>
      <Notice tone="warning" title={props.warning}>
        <ul>
          {props.consequences.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </Notice>
      <form method="post" action={props.action} className="form">
        <CsrfField token={props.csrfToken} />
        {Object.entries(props.hidden ?? {}).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
        {props.reason?.kind === 'text' ? (
          <div className="field">
            <label htmlFor="reason">Reason{props.reason.required ? <span className="required"> (required)</span> : null}</label>
            <input id="reason" name="reason" className="input" required={props.reason.required} maxLength={512} autoComplete="off" />
          </div>
        ) : null}
        {props.reason?.kind === 'select' ? (
          <div className="field">
            <label htmlFor="reason">Reason (required)</label>
            <select id="reason" name="reason" className="input" required>
              {props.reason.options.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <div className="field field--check">
          <input id="confirm" name="confirm" type="checkbox" value="yes" required />
          <label htmlFor="confirm">I have checked the target above and intend this operation.</label>
        </div>
        <div className="form__actions">
          <button type="submit" className="button button--danger">
            {props.submitLabel}
          </button>
          <a className="button button--quiet" href={props.cancel}>
            Cancel
          </a>
        </div>
      </form>
    </Page>
  );
}
