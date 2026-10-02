import * as React from 'react';

import type { FormErrors } from '../forms.js';
import type { HostFailure } from '../failures.js';
import type { AgentView, AuthorityReference, EntityView, OrganizationContext } from '../wire.js';
import { lineageOf, LineageTable } from './authority-terms.js';
import { ActionLink, CsrfField, Empty, FailureNotice, Id, KeyValues, Notice, Section, Status, Text, Time } from './components.js';
import { EntityForm, type FormValues } from './entity-form.js';
import { may, Page } from './layout.js';

const agentPath = (actorId: string): string => `/agents/${encodeURIComponent(actorId)}`;

export function AgentsPage({ context, csrfToken, agents, flash }: { readonly context: OrganizationContext; readonly csrfToken: string; readonly agents: readonly AgentView[]; readonly flash?: string }): React.ReactElement {
  return (
    <Page title="Agents" context={context} csrfToken={csrfToken} active="/agents" {...(flash !== undefined ? { flash } : {})}>
      <Section title="Agent inventory" actions={may(context, 'authority.provision') ? <ActionLink href="/agents/new">Onboard an agent</ActionLink> : undefined}>
        <p className="help">
          Computed by the Host from the Kernel Authority (actor, passports, capability tokens, grants) and the control-plane store (credentials). The onboarding columns restate those records; they do not say what the agent may do — the
          Kernel decides that on every request.
        </p>
        {agents.length === 0 ? (
          <Empty message="No agent actor is provisioned in this organization." />
        ) : (
          <table className="table" data-testid="agents">
            <thead>
              <tr>
                <th scope="col">Agent</th>
                <th scope="col">Actor</th>
                <th scope="col">Credential</th>
                <th scope="col">Standing authority</th>
                <th scope="col">External subject</th>
                <th scope="col">Provisioned</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((agent) => (
                <tr key={agent.actorId} data-actor={agent.actorId}>
                  <td>
                    <a href={agentPath(agent.actorId)}>{agent.displayName}</a>
                    <br />
                    <Id value={agent.actorId} />
                  </td>
                  <td>
                    <Status value={agent.status} />
                  </td>
                  <td>
                    <Status value={agent.status === 'revoked' ? 'admits no one (actor revoked)' : agent.onboarding.credential} />
                  </td>
                  <td>
                    <Status value={agent.onboarding.standingAuthority} />
                  </td>
                  <td>{agent.externalSubject === null ? <span className="muted">none</span> : <Id value={`${agent.externalSubject.system}/${agent.externalSubject.subjectId}`} />}</td>
                  <td>
                    <Time value={agent.provisionedAt} /> by <Id value={agent.provisionedBy} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </Page>
  );
}

function References({ title, references }: { readonly title: string; readonly references: readonly AuthorityReference[] }): React.ReactElement {
  return (
    <div>
      <h3>{title}</h3>
      {references.length === 0 ? (
        <Empty message={`No ${title.toLowerCase()} name this agent.`} />
      ) : (
        <ul>
          {references.map((reference) => (
            <li key={`${reference.entityKind}:${reference.entityId}`}>
              <a href={`/authority/entities/${encodeURIComponent(reference.entityKind)}/${encodeURIComponent(reference.entityId)}`}>
                <Id value={reference.entityId} />
              </a>{' '}
              <Status value={reference.status} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export interface AgentPageProps {
  readonly context: OrganizationContext;
  readonly csrfToken: string;
  readonly agent: AgentView;
  readonly entities: readonly EntityView[] | HostFailure;
  readonly issueIdempotencyKey: string;
  readonly flash?: string;
  /** A failed credential issue: shown above the canonical (re-read) agent, whose issuing form keeps the same idempotency key. */
  readonly failure?: HostFailure;
}

export function AgentPage({ context, csrfToken, agent, entities, issueIdempotencyKey, flash, failure }: AgentPageProps): React.ReactElement {
  const revoked = agent.status === 'revoked';
  const stages: readonly (readonly [string, boolean, string])[] = [
    ['Actor provisioned', agent.onboarding.actor === 'active', agent.onboarding.actor],
    ['Credential issued', agent.onboarding.credential === 'active', agent.onboarding.credential],
    ['Standing authority assigned', agent.onboarding.standingAuthority === 'assigned', agent.onboarding.standingAuthority],
  ];
  const activePassports = agent.authority.passports.filter((reference) => reference.status === 'active').length;
  const remaining: string[] = [];
  if (!revoked) {
    if (agent.externalSubject === null) remaining.push('The agent has no external subject, so no credential can be issued for it; onboard a new agent with one.');
    if (agent.onboarding.credential !== 'active') remaining.push('Issue a credential so the agent can authenticate to the governed-action API.');
    if (activePassports === 0) remaining.push('No active passport names this agent; the Kernel requires a valid passport before it allows any action.');
    if (agent.onboarding.standingAuthority !== 'assigned') remaining.push('Assign standing authority (a capability token and an authority or delegation grant) — without it the Kernel denies every action.');
  }
  const grants = [...agent.authority.authorityGrants, ...agent.authority.delegationGrants];
  return (
    <Page title={`Agent ${agent.displayName}`} context={context} csrfToken={csrfToken} active="/agents" {...(flash !== undefined ? { flash } : {})}>
      {failure !== undefined ? <FailureNotice failure={failure} /> : null}
      {revoked ? (
        <Notice tone="danger" title="This agent’s actor is revoked.">
          <p>Revocation is terminal. No credential admits this agent, whatever its status below, and it holds no authority. Restoring capability means onboarding a new agent under a new identity.</p>
        </Notice>
      ) : null}
      <Section title="Identity">
        <KeyValues
          rows={[
            ['Actor id', <Id key="a" value={agent.actorId} />],
            ['Display name', agent.displayName],
            ['Actor status', <Status key="s" value={agent.status} />],
            ['External subject', agent.externalSubject === null ? <span key="e" className="muted">none</span> : <Id key="e" value={`${agent.externalSubject.system}/${agent.externalSubject.subjectId}`} />],
            ['Customer principal', <Text key="p" value={agent.principalId} />],
            ['Trust domain', <Text key="t" value={agent.trustDomainId} />],
            ['Provisioned', <span key="pv"><Time value={agent.provisionedAt} /> by <Id value={agent.provisionedBy} /></span>],
            ['Revoked', <span key="rv"><Time value={agent.revokedAt} /> {agent.revokedBy !== null ? <>by <Id value={agent.revokedBy} /></> : null}</span>],
            ['Revocation reason', <Text key="rr" value={agent.revocationReason} />],
          ]}
        />
        {may(context, 'authority.revoke') && !revoked ? <ActionLink href={`/authority/entities/actor/${encodeURIComponent(agent.actorId)}/revoke`}>Revoke agent actor…</ActionLink> : null}
      </Section>
      <Section title="Onboarding stages (as recorded)">
        <p className="help">Onboarding is a sequence of independent, idempotent Host operations — there is no single transaction. Each stage below is what the Host records now; a stage that failed wrote nothing for that stage.</p>
        <ol className="stages" data-testid="onboarding-stages">
          {stages.map(([label, done, value]) => (
            <li key={label} className={done ? 'stage stage--done' : 'stage stage--open'}>
              <span aria-hidden="true">{done ? '✓' : '○'}</span> {label}: <code>{value}</code>
            </li>
          ))}
        </ol>
        {remaining.length > 0 ? (
          <>
            <h3>Not yet recorded</h3>
            <ul>
              {remaining.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </>
        ) : null}
      </Section>
      <Section title="Credentials">
        <p className="help">Metadata only. A credential’s secret is shown once, when it is issued or rotated, and is never stored or shown again.</p>
        {revoked && agent.credentials.some((credential) => credential.status === 'active') ? (
          <p className="emphasis">The actor is revoked: credentials still recorded as active admit no one.</p>
        ) : null}
        {agent.credentials.length === 0 ? (
          <Empty message="No credential has been issued for this agent." />
        ) : (
          <table className="table" data-testid="credentials">
            <thead>
              <tr>
                <th scope="col">Credential</th>
                <th scope="col">Status</th>
                <th scope="col">Issued</th>
                <th scope="col">Revoked</th>
                <th scope="col">Replaces</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {agent.credentials.map((credential) => (
                <tr key={credential.credentialId} data-credential={credential.credentialId}>
                  <td>
                    <Id value={credential.credentialId} />
                  </td>
                  <td>
                    <Status value={credential.status} />
                  </td>
                  <td>
                    <Time value={credential.createdAt} /> by <Id value={credential.createdBy} />
                  </td>
                  <td>
                    {credential.revokedAt !== null ? (
                      <>
                        <Time value={credential.revokedAt} /> by <Id value={credential.revokedBy ?? 'not recorded'} />
                        {credential.revocationReason !== null ? <> — {credential.revocationReason}</> : null}
                      </>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td>
                    <Text value={credential.replacesCredentialId} />
                  </td>
                  <td>
                    {credential.status === 'active' && !revoked && may(context, 'agent-credential.manage') ? (
                      <ActionLink href={`${agentPath(agent.actorId)}/credentials/${encodeURIComponent(credential.credentialId)}/rotate`}>Rotate credential…</ActionLink>
                    ) : null}{' '}
                    {credential.status === 'active' && may(context, 'agent-credential.revoke') ? (
                      <ActionLink href={`${agentPath(agent.actorId)}/credentials/${encodeURIComponent(credential.credentialId)}/revoke`}>Revoke credential…</ActionLink>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!revoked && agent.externalSubject !== null && agent.onboarding.credential !== 'active' && may(context, 'agent-credential.manage') ? (
          <form method="post" action={`${agentPath(agent.actorId)}/credentials`} className="form form--inline" data-testid="issue-credential">
            <CsrfField token={csrfToken} />
            <input type="hidden" name="idempotencyKey" value={issueIdempotencyKey} />
            <p className="help">Issuing reveals a new bearer credential exactly once, on the next page.</p>
            <button type="submit" className="button button--primary">
              Issue credential
            </button>
          </form>
        ) : null}
      </Section>
      <Section
        title="Standing authority naming this agent"
        actions={
          may(context, 'authority.provision') && !revoked ? (
            <span className="action-group">
              <ActionLink href={`/authority/new/passport?subject=${encodeURIComponent(agent.actorId)}`}>Provision passport</ActionLink>{' '}
              <ActionLink href={`/authority/new/capability-token?subject=${encodeURIComponent(agent.actorId)}`}>Provision capability token</ActionLink>{' '}
              <ActionLink href={`/authority/new/delegation-grant?delegate=${encodeURIComponent(agent.actorId)}`}>Provision delegation grant</ActionLink>{' '}
              <ActionLink href={`/authority/new/authority-grant?subject=${encodeURIComponent(agent.actorId)}`}>Provision authority grant</ActionLink>
            </span>
          ) : undefined
        }
      >
        <div className="grid-2">
          <References title="Passports" references={agent.authority.passports} />
          <References title="Capability tokens" references={agent.authority.capabilityTokens} />
          <References title="Authority grants" references={agent.authority.authorityGrants} />
          <References title="Delegation grants" references={agent.authority.delegationGrants} />
        </div>
      </Section>
      <Section title="Limits on this agent’s lineage">
        {Array.isArray(entities) ? (
          grants.length === 0 ? (
            <Empty message="No authority or delegation grant names this agent." />
          ) : (
            grants.map((reference) => {
              const start = (entities as readonly EntityView[]).find((entity) => entity.entityKind === reference.entityKind && entity.entityId === reference.entityId);
              return start === undefined ? (
                <p key={reference.entityId} className="missing">
                  {reference.entityKind}:{reference.entityId} — not returned by the Host’s authority listing (unresolved).
                </p>
              ) : (
                <LineageTable key={reference.entityId} chain={lineageOf(start, entities as readonly EntityView[])} />
              );
            })
          )
        ) : (
          <FailureNotice failure={entities as HostFailure} />
        )}
      </Section>
    </Page>
  );
}

export function AgentOnboardPage(props: {
  readonly context: OrganizationContext;
  readonly csrfToken: string;
  readonly idempotencyKey: string;
  readonly values: FormValues;
  readonly errors: FormErrors;
  readonly failure?: HostFailure;
}): React.ReactElement {
  return (
    <Page title="Onboard an agent" context={props.context} csrfToken={props.csrfToken} active="/agents">
      {props.failure !== undefined ? <FailureNotice failure={props.failure} /> : null}
      <Notice tone="info" title="Stage 1 of onboarding: the agent actor">
        <p>
          This provisions the agent’s Kernel-Authority actor only. It confers no authority and no way to authenticate. The next stages — a credential, a passport, a capability token and an authority or delegation grant — are separate
          operations on the agent’s page. Re-submitting this form replays the same request; it never creates a second agent.
        </p>
      </Notice>
      <EntityForm
        kind="actor"
        action="/agents"
        csrfToken={props.csrfToken}
        idempotencyKey={props.idempotencyKey}
        values={props.values}
        errors={props.errors}
        dimensions={[]}
        fixed={{ type: 'agent' }}
        submitLabel="Provision agent actor"
      />
    </Page>
  );
}
