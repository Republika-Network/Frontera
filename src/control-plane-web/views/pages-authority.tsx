import * as React from 'react';

import type { FormErrors } from '../forms.js';
import type { HostFailure } from '../failures.js';
import { ENTITY_KIND_LABELS, ENTITY_KINDS, type EntityKind, type EntityView, type ExecutionGrantView, type GrantView, type OrganizationContext, type ParameterBoundView } from '../wire.js';
import { boundsOf, constraintsOf, EntityTerms, lineageOf, LineageTable, ParameterBoundsTable } from './authority-terms.js';
import { ActionLink, Empty, FailureNotice, Id, KeyValues, List, Notice, Section, Status, Text, Time } from './components.js';
import { EntityForm, type FormValues } from './entity-form.js';
import { may, Page } from './layout.js';

/** Kinds that are organization bootstrap: the Host holds them to `authority.bootstrap`. */
const BOOTSTRAP_KINDS: readonly EntityKind[] = ['trust-domain', 'root-issuer'];
/** The Kernel Authority never revokes these kinds. */
const NOT_REVOCABLE: readonly EntityKind[] = ['trust-domain', 'root-issuer'];

const entityPath = (kind: string, id: string): string => `/authority/entities/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`;
const strings = (value: unknown): readonly string[] | undefined => (Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? (value as string[]) : undefined);

export function provisionPermission(kind: EntityKind): string {
  return BOOTSTRAP_KINDS.includes(kind) ? 'authority.bootstrap' : 'authority.provision';
}

export function AuthorityPage({
  context,
  csrfToken,
  entities,
  filter,
  flash,
}: {
  readonly context: OrganizationContext;
  readonly csrfToken: string;
  readonly entities: readonly EntityView[];
  readonly filter: { readonly kind: string; readonly status: string };
  readonly flash?: string;
}): React.ReactElement {
  const provisionable = ENTITY_KINDS.filter((kind) => may(context, provisionPermission(kind)));
  return (
    <Page title="Authority" context={context} csrfToken={csrfToken} active="/authority" {...(flash !== undefined ? { flash } : {})}>
      <Section title="Standing authority and limits">
        <p className="help">
          Every Kernel-Authority record of this organization, as the Host lists it. Limits are shown as recorded: P10 monetary constraints and CORE-03 typed parameter bounds. Revocation is terminal; there is no un-revoke.
        </p>
        <form method="get" action="/authority" className="form form--inline">
          <label htmlFor="filter-kind">Kind</label>
          <select id="filter-kind" name="kind" defaultValue={filter.kind} className="input">
            <option value="">all</option>
            {ENTITY_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </select>
          <label htmlFor="filter-status">Status</label>
          <select id="filter-status" name="status" defaultValue={filter.status} className="input">
            <option value="">all</option>
            <option value="active">active</option>
            <option value="revoked">revoked</option>
          </select>
          <button type="submit" className="button">
            Filter
          </button>
        </form>
        {entities.length === 0 ? (
          <Empty message="No Kernel-Authority record matches." />
        ) : (
          <table className="table" data-testid="entities">
            <thead>
              <tr>
                <th scope="col">Record</th>
                <th scope="col">Status</th>
                <th scope="col">Subject</th>
                <th scope="col">Actions × resources</th>
                <th scope="col">Limits</th>
                <th scope="col">Provisioned</th>
              </tr>
            </thead>
            <tbody>
              {entities.map((entity) => {
                const subject = entity.terms['subjectActorId'] ?? entity.terms['delegateActorId'] ?? entity.terms['actorId'];
                const bounds = boundsOf(entity.terms);
                const constraints = constraintsOf(entity.terms);
                return (
                  <tr key={`${entity.entityKind}:${entity.entityId}`} data-entity={`${entity.entityKind}:${entity.entityId}`}>
                    <td>
                      <span className="muted">{entity.entityKind}</span>
                      <br />
                      <a href={entityPath(entity.entityKind, entity.entityId)}>
                        <Id value={entity.entityId} />
                      </a>
                    </td>
                    <td>
                      <Status value={entity.status} />
                    </td>
                    <td>{typeof subject === 'string' ? <Id value={subject} /> : <span className="muted">—</span>}</td>
                    <td>
                      {strings(entity.terms['actions']) !== undefined ? (
                        <>
                          <List values={strings(entity.terms['actions'])} /> × <List values={strings(entity.terms['resourceScopes'])} />
                        </>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>
                      {bounds.length === 0 && constraints.length === 0 ? (
                        <span className="muted">—</span>
                      ) : (
                        <>
                          {bounds.map((bound) => (
                            <div key={String(bound.dimension)}>
                              <code>
                                {String(bound.dimension)} {bound.kind === 'maximum' ? '≤' : '='} {String(bound.kind === 'maximum' ? bound.limit : bound.value)}
                              </code>
                            </div>
                          ))}
                          {constraints.length > 0 ? <div>{constraints.length} monetary limit(s)</div> : null}
                        </>
                      )}
                    </td>
                    <td>
                      <Time value={entity.provisionedAt} />
                      <br />
                      <Id value={entity.provisionedBy} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Section>
      {provisionable.length > 0 ? (
        <Section title="Provision standing authority">
          <ul className="action-list">
            {provisionable.map((kind) => (
              <li key={kind}>
                <ActionLink href={`/authority/new/${kind}`}>Provision {ENTITY_KIND_LABELS[kind].toLowerCase()}</ActionLink>
                {BOOTSTRAP_KINDS.includes(kind) ? <span className="muted"> (organization bootstrap)</span> : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      <Section title="Inspect a bounded grant or an execution">
        <p className="help">Bounded grants are minted only from a committed Kernel decision; there is no listing and no way to create one here. Find a grant by its id, or by the execution that ran under it.</p>
        <form method="get" action="/authority/grants" className="form form--inline">
          <label htmlFor="grant-id">Grant id</label>
          <input id="grant-id" name="grantId" className="input" placeholder="aoc.grant:…" autoComplete="off" />
          <button type="submit" className="button">
            Inspect grant
          </button>
        </form>
        <form method="get" action="/authority/executions" className="form form--inline">
          <label htmlFor="execution-id">Execution id</label>
          <input id="execution-id" name="executionId" className="input" autoComplete="off" />
          <button type="submit" className="button">
            Find grant for execution
          </button>
        </form>
      </Section>
    </Page>
  );
}

export function EntityPage({
  context,
  csrfToken,
  entity,
  all,
  flash,
}: {
  readonly context: OrganizationContext;
  readonly csrfToken: string;
  readonly entity: EntityView;
  readonly all: readonly EntityView[] | HostFailure;
  readonly flash?: string;
}): React.ReactElement {
  const kind = entity.entityKind as EntityKind;
  const grantLike = kind === 'authority-grant' || kind === 'delegation-grant';
  const canRevoke = entity.status === 'active' && !NOT_REVOCABLE.includes(kind) && may(context, 'authority.revoke');
  return (
    <Page title={`${ENTITY_KIND_LABELS[kind] ?? entity.entityKind} ${entity.entityId}`} context={context} csrfToken={csrfToken} active="/authority" {...(flash !== undefined ? { flash } : {})}>
      {entity.status === 'revoked' ? (
        <Notice tone="danger" title="Revoked — terminal.">
          <p>This authority cannot be restored. Restoring capability requires provisioning new authority under a new id.</p>
        </Notice>
      ) : null}
      <Section
        title="Recorded terms"
        actions={
          <span className="action-group">
            {canRevoke ? <ActionLink href={`${entityPath(entity.entityKind, entity.entityId)}/revoke`}>Revoke authority…</ActionLink> : null}{' '}
            {grantLike && entity.status === 'active' && may(context, 'authority.provision') ? (
              <ActionLink href={`/authority/new/delegation-grant?source=${encodeURIComponent(entity.entityId)}`}>Delegate (narrower) from this grant</ActionLink>
            ) : null}
          </span>
        }
      >
        <EntityTerms entity={entity} />
      </Section>
      {grantLike ? (
        <Section title="Lineage">
          {Array.isArray(all) ? <LineageTable chain={lineageOf(entity, all)} /> : <FailureNotice failure={all as HostFailure} />}
        </Section>
      ) : null}
    </Page>
  );
}

export interface ProvisionPageProps {
  readonly context: OrganizationContext;
  readonly csrfToken: string;
  readonly kind: EntityKind;
  readonly idempotencyKey: string;
  readonly values: FormValues;
  readonly errors: FormErrors;
  readonly dimensions: readonly string[];
  readonly failure?: HostFailure;
  /** For a delegation: the source record and its recorded lineage, read from the Host for this page. */
  readonly source?: { readonly chain: readonly EntityView[] };
}

export function ProvisionPage(props: ProvisionPageProps): React.ReactElement {
  const label = ENTITY_KIND_LABELS[props.kind];
  return (
    <Page title={`Provision ${label.toLowerCase()}`} context={props.context} csrfToken={props.csrfToken} active="/authority">
      {props.failure !== undefined ? <FailureNotice failure={props.failure} /> : null}
      {props.source !== undefined && props.source.chain[0] !== undefined ? (
        <Section title="Parent lineage (inherited limits)">
          <Notice tone="info" title="A delegation may only narrow.">
            <p>
              Every bound below applies to the delegate at decision, whatever this delegation states. The form starts from the parent’s own bounds; you may keep or narrow them and add new ones. The Host refuses a delegation that drops
              or widens an upstream bound (<code>PARAMETER_BOUND_REMOVED</code>, <code>PARAMETER_BOUND_WIDENED</code>).
            </p>
          </Notice>
          <LineageTable chain={props.source.chain} />
          <ParameterBoundsTable bounds={boundsOf(props.source.chain[0].terms)} caption="The parent’s typed parameter bounds" />
        </Section>
      ) : null}
      <EntityForm
        kind={props.kind}
        action={`/authority/new/${props.kind}`}
        csrfToken={props.csrfToken}
        idempotencyKey={props.idempotencyKey}
        values={props.values}
        errors={props.errors}
        dimensions={props.dimensions}
        submitLabel={`Provision ${label.toLowerCase()}`}
      />
    </Page>
  );
}

function boundRows(bounds: GrantView['bounds']): (readonly [string, React.ReactNode])[] {
  return Object.entries(bounds)
    .filter(([key]) => key !== 'parameters')
    .map(([key, bound]) => {
      const value = bound as { kind?: string; value?: string; values?: string[]; limit?: string; unit?: string; notAfter?: string };
      const shown =
        value.kind === 'identity' ? value.value : value.kind === 'set' ? (value.values ?? []).join(', ') : value.kind === 'ceiling' ? `≤ ${value.limit ?? ''} ${value.unit ?? ''}` : value.kind === 'window' ? `not after ${value.notAfter ?? ''}` : JSON.stringify(bound);
      return [key, <code key={key}>{shown}</code>] as const;
    });
}

export function GrantPage({ context, csrfToken, grant, flash }: { readonly context: OrganizationContext; readonly csrfToken: string; readonly grant: GrantView; readonly flash?: string }): React.ReactElement {
  const parameters = Array.isArray(grant.bounds['parameters']) ? (grant.bounds['parameters'] as readonly ParameterBoundView[]) : [];
  const revocable = grant.revocation === null && may(context, 'authority.revoke');
  return (
    <Page title={`Bounded grant ${grant.grantId}`} context={context} csrfToken={csrfToken} active="/authority" {...(flash !== undefined ? { flash } : {})}>
      <Section title="Grant" actions={revocable ? <ActionLink href={`/authority/grants/${encodeURIComponent(grant.grantId)}/revoke`}>Revoke bounded grant…</ActionLink> : undefined}>
        <KeyValues
          rows={[
            ['Grant id', <Id key="g" value={grant.grantId} />],
            ['Subject', <Id key="s" value={grant.subject} />],
            ['Exercise status (grant runtime)', <Status key="st" value={grant.status.eligibility} />],
            ['Status reason codes', <List key="rc" values={grant.status.reasonCodes} />],
            ['Assessed at', <Time key="aa" value={grant.status.assessedAt} />],
            ['Issued at', <Time key="i" value={grant.issuedAt} />],
            ['Expires at', <Time key="e" value={grant.expiresAt} />],
            ['From decision', <a key="d" href={`/evidence?decisionId=${encodeURIComponent(grant.provenance.decisionId)}`}><Id value={grant.provenance.decisionId} /></a>],
            ['Request', <Id key="r" value={grant.provenance.requestId} />],
            ['Action', <Id key="a" value={grant.provenance.action} />],
            ['Resource scope', <Id key="rs" value={grant.provenance.resourceScope} />],
            ['Semantics format', <Text key="sf" value={grant.semanticsFormat} />],
            ['Revocation', grant.revocation === null ? 'not revoked' : <span key="rv">{grant.revocation.reason} at <Time value={grant.revocation.revokedAt} /> by <Id value={grant.revocation.revokedBy} /></span>],
          ]}
        />
        <h3>Signed bounds</h3>
        <KeyValues rows={boundRows(grant.bounds)} />
        <h3>Typed parameter bounds</h3>
        <ParameterBoundsTable bounds={parameters} />
      </Section>
    </Page>
  );
}

export function ExecutionPage({ context, csrfToken, execution }: { readonly context: OrganizationContext; readonly csrfToken: string; readonly execution: ExecutionGrantView }): React.ReactElement {
  return (
    <Page title={`Execution ${execution.executionId}`} context={context} csrfToken={csrfToken} active="/authority">
      <Section title="Which grant this execution ran under (P11 outcome record)">
        <KeyValues
          rows={[
            ['Execution', <Id key="e" value={execution.executionId} />],
            ['Grant', <a key="g" href={`/authority/grants/${encodeURIComponent(execution.grantId)}`}><Id value={execution.grantId} /></a>],
            ['Request', <Id key="r" value={execution.requestId} />],
            ['Decision', <Id key="d" value={execution.decisionId} />],
            ['Action', <Id key="a" value={execution.action} />],
            ['Prepared at', <Time key="p" value={execution.preparedAt} />],
          ]}
        />
      </Section>
    </Page>
  );
}
