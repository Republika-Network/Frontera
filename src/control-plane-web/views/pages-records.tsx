import * as React from 'react';

import { decisionDownstream, type LifecycleTransition } from '../activity.js';
import type { HostFailure } from '../failures.js';
import { EMERGENCY_SCOPES, type DecisionEvidence, type DecisionPage, type EmergencyControls, type OrganizationContext, type ProfileCatalog } from '../wire.js';
import { ActionLink, Empty, FailureNotice, Id, KeyValues, List, Notice, Section, Status, Text, Time } from './components.js';
import { may, Page } from './layout.js';

const evidencePath = (evaluationId: string): string => `/evidence/decisions/${encodeURIComponent(evaluationId)}`;

export const DECISION_COVERAGE =
  'Committed Kernel decisions of this organization, as the Governance Store recorded them, newest first. The status is the Kernel’s decision — not whether a bounded grant was issued or an execution happened: open a decision’s evidence to see which downstream records exist. This is not a complete end-to-end trace of every request (ASSURE-01).';

export const LIFECYCLE_COVERAGE =
  'Lifecycle transitions stated by canonical records — Kernel-Authority entities (provisioned, revoked), agent credentials (issued, revoked) and Governance Profile versions (activated, retired) — with the time, operator and reason each record carries. Assembled from the records’ current lifecycle fields: intermediate events are not listed and this is not a canonical event stream (ASSURE-01). Bounded-grant revocations and emergency stops are not listed here (no listing exists); inspect a grant, or the emergency controls, directly.';

export function DecisionTable({ page }: { readonly page: DecisionPage }): React.ReactElement {
  if (page.decisions.length === 0) return <Empty message="No committed decision matches." />;
  return (
    <table className="table" data-testid="decisions">
      <thead>
        <tr>
          <th scope="col">Evaluated at</th>
          <th scope="col">Actor</th>
          <th scope="col">Action</th>
          <th scope="col">Kernel decision</th>
          <th scope="col">Reason codes</th>
          <th scope="col">Evidence</th>
        </tr>
      </thead>
      <tbody>
        {page.decisions.map((decision) => (
          <tr key={decision.evaluationId} data-evaluation={decision.evaluationId}>
            <td>
              <Time value={decision.evaluatedAt} />
            </td>
            <td>
              <Id value={decision.actorId} />
            </td>
            <td>
              <Id value={decision.actionType} />
            </td>
            <td>
              <Status value={decision.status} />
            </td>
            <td>
              <List values={decision.reasonCodes} />
            </td>
            <td>
              <a href={evidencePath(decision.evaluationId)}>
                <Id value={decision.evaluationId} />
              </a>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export interface ActivityPageProps {
  readonly context: OrganizationContext;
  readonly csrfToken: string;
  readonly decisions: DecisionPage | HostFailure;
  readonly filter: { readonly actorId: string; readonly status: string };
  readonly transitions: readonly LifecycleTransition[] | HostFailure;
}

export function ActivityPage({ context, csrfToken, decisions, filter, transitions }: ActivityPageProps): React.ReactElement {
  const nextHref =
    !('kind' in decisions) && decisions.nextCursor !== null
      ? `/activity?${new URLSearchParams({ ...(filter.actorId !== '' ? { actorId: filter.actorId } : {}), ...(filter.status !== '' ? { status: filter.status } : {}), cursor: decisions.nextCursor }).toString()}`
      : undefined;
  return (
    <Page title="Activity" context={context} csrfToken={csrfToken} active="/activity">
      <Section title="Governed-action decisions">
        <p className="help coverage" data-coverage="decisions">
          {DECISION_COVERAGE}
        </p>
        <form method="get" action="/activity" className="form form--inline">
          <label htmlFor="activity-actor">Actor</label>
          <input id="activity-actor" name="actorId" defaultValue={filter.actorId} className="input" autoComplete="off" />
          <label htmlFor="activity-status">Kernel decision</label>
          <select id="activity-status" name="status" defaultValue={filter.status} className="input">
            <option value="">all</option>
            {['allowed', 'denied', 'approval_required', 'indeterminate'].map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
          <button type="submit" className="button">
            Filter
          </button>
        </form>
        {'kind' in decisions ? <FailureNotice failure={decisions} /> : <DecisionTable page={decisions} />}
        {nextHref !== undefined ? <ActionLink href={nextHref}>Older decisions →</ActionLink> : null}
      </Section>
      <Section title="Recorded lifecycle transitions">
        <p className="help coverage" data-coverage="lifecycle">
          {LIFECYCLE_COVERAGE}
        </p>
        {!Array.isArray(transitions) ? (
          <FailureNotice failure={transitions as HostFailure} />
        ) : transitions.length === 0 ? (
          <Empty message="No lifecycle transition is recorded." />
        ) : (
          <table className="table" data-testid="transitions">
            <thead>
              <tr>
                <th scope="col">Recorded at</th>
                <th scope="col">Transition</th>
                <th scope="col">Target</th>
                <th scope="col">Operator</th>
                <th scope="col">Reason</th>
                <th scope="col">Source record</th>
              </tr>
            </thead>
            <tbody>
              {(transitions as readonly LifecycleTransition[]).map((transition) => (
                <tr key={transition.key} data-transition={transition.key} className={transition.missing.length > 0 ? 'row--incomplete' : undefined}>
                  <td>
                    <Time value={transition.at} />
                  </td>
                  <td>
                    <code>{transition.transition}</code>
                    {transition.missing.length > 0 ? <span className="missing"> — incomplete: {transition.missing.join(', ')} not recorded</span> : null}
                  </td>
                  <td>
                    <a href={transition.link}>
                      <span className="muted">{transition.targetKind}</span> <Id value={transition.targetId} />
                    </a>
                  </td>
                  <td>{transition.by === null ? <span className="missing">not recorded</span> : <Id value={transition.by} />}</td>
                  <td>
                    <Text value={transition.reason} />
                  </td>
                  <td>
                    <code>{transition.source}</code>
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

export function EvidenceIndexPage({
  context,
  csrfToken,
  recent,
  matches,
  failure,
}: {
  readonly context: OrganizationContext;
  readonly csrfToken: string;
  readonly recent: DecisionPage | HostFailure;
  readonly matches?: DecisionPage;
  readonly failure?: HostFailure;
}): React.ReactElement {
  return (
    <Page title="Evidence" context={context} csrfToken={csrfToken} active="/evidence">
      <Section title="Decision evidence">
        <p className="help">
          A decision’s evidence is its Governance Store record — the request, the Kernel decision, its reason codes and the references appended to it (a bounded grant, an execution attempt, an outcome) — and the store’s own
          deterministic verification of that record. Verification is digest-based integrity: it detects modification of stored records; it is not a signature and not a statement of compliance.
        </p>
        <form method="get" action="/evidence" className="form form--inline">
          <label htmlFor="evidence-evaluation">Evaluation id</label>
          <input id="evidence-evaluation" name="evaluationId" className="input" autoComplete="off" />
          <label htmlFor="evidence-decision">or decision id</label>
          <input id="evidence-decision" name="decisionId" className="input" autoComplete="off" />
          <label htmlFor="evidence-request">or request id</label>
          <input id="evidence-request" name="requestId" className="input" autoComplete="off" />
          <button type="submit" className="button">
            Find
          </button>
        </form>
        {failure !== undefined ? <FailureNotice failure={failure} /> : null}
        {matches !== undefined ? <DecisionTable page={matches} /> : null}
      </Section>
      <Section title="Recent decisions">{'kind' in recent ? <FailureNotice failure={recent} /> : <DecisionTable page={recent} />}</Section>
      <Section title="Not shown here">
        <p className="help">
          Evidence bundles (<code>/api/evidence/*</code>) are built and read with customer API credentials and kept in memory only; the operator plane does not expose them. The authority event stream has no read API. A complete,
          independently verifiable request trace is ASSURE-01.
        </p>
      </Section>
    </Page>
  );
}

export function EvidencePage({ context, csrfToken, evidence }: { readonly context: OrganizationContext; readonly csrfToken: string; readonly evidence: DecisionEvidence }): React.ReactElement {
  const { decision, verification, integrity } = evidence;
  const downstream = decisionDownstream(evidence.references);
  return (
    <Page title={`Decision ${decision.evaluationId}`} context={context} csrfToken={csrfToken} active="/evidence">
      <Section title="Verification (Governance Store)">
        {verification.valid ? (
          <Notice tone="success" title="Integrity verified by the Governance Store">
            <p>
              Every digest check on this decision record passed at <Time value={verification.verifiedAt} />. This is digest-based integrity: it detects modification of the stored record; it is not a signature (ASSURE-02) and says
              nothing about compliance.
            </p>
          </Notice>
        ) : (
          <Notice tone="danger" title="Verification FAILED — this record could not be verified">
            <p>
              The Governance Store’s verification at <Time value={verification.verifiedAt} /> reported failures. Treat the record as untrustworthy and follow the incident runbook.
            </p>
            <ul>
              {verification.failures.map((failure) => (
                <li key={`${failure.check}:${failure.message}`}>
                  <code>{failure.check}</code>: {failure.message}
                </li>
              ))}
            </ul>
          </Notice>
        )}
        <table className="table" data-testid="verification-checks">
          <thead>
            <tr>
              <th scope="col">Check</th>
              <th scope="col">Result</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(verification.checks).map(([check, passed]) => (
              <tr key={check}>
                <td>
                  <code>{check}</code>
                </td>
                <td>
                  <Status value={passed ? 'passed' : 'failed'} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <KeyValues
          rows={[
            ['Protected references valid', String(verification.referenceIntegrity.protectedValid)],
            ['Protected references corrupted', String(verification.referenceIntegrity.protectedCorrupted)],
            ['Unsupported-version references', String(verification.referenceIntegrity.protectedUnsupportedVersion)],
            ['Legacy unprotected references', String(verification.referenceIntegrity.legacyUnprotected)],
          ]}
        />
      </Section>
      <Section title="Decision (as recorded)">
        <KeyValues
          rows={[
            ['Evaluation', <Id key="e" value={decision.evaluationId} />],
            ['Decision', <Id key="d" value={decision.decisionId} />],
            ['Request', <Id key="r" value={decision.requestId} />],
            ['Correlation', <Text key="c" value={decision.correlationId} />],
            ['Actor', <Id key="a" value={decision.actorId} />],
            ['Actor type', <Text key="at" value={decision.actorType} />],
            ['Action', <Id key="ac" value={decision.actionType} />],
            ['Resource scope', <Id key="rs" value={decision.resourceScope} />],
            ['Requested at', <Time key="ra" value={decision.requestedAt} />],
            ['Kernel decision', <Status key="s" value={decision.status} />],
            ['Summary (Kernel)', decision.summary],
            ['Reason codes', <List key="rc" values={decision.reasonCodes} />],
            ['Evaluated at', <Time key="ea" value={decision.evaluatedAt} />],
            ['Persisted at', <Time key="pa" value={decision.persistedAt} />],
            ['Kernel version', decision.kernelVersion],
            ['Chain position', String(integrity.chainPosition)],
            ['Aggregate digest', <Id key="ad" value={integrity.aggregateDigest} />],
          ]}
        />
      </Section>
      <Section title="Downstream records on this decision">
        <h3>Bounded grant</h3>
        {downstream.grants.length === 0 ? (
          <p className="missing" data-testid="no-grant">
            No bounded grant is recorded for this decision. The Governance Store does not say why: the request may have been denied, withheld before issuance (for example by standing authority or an emergency control), or the
            issuance not yet recorded. The reason is not recorded here (ASSURE-01).
          </p>
        ) : (
          <ul>
            {downstream.grants.map((grantId) => (
              <li key={grantId}>
                <a href={`/authority/grants/${encodeURIComponent(grantId)}`}>
                  <Id value={grantId} />
                </a>
              </li>
            ))}
          </ul>
        )}
        <h3>Execution</h3>
        {downstream.executions.length === 0 ? (
          <p className="missing" data-testid="no-execution">
            No execution attempt is recorded for this decision.
          </p>
        ) : (
          <ul>
            {downstream.executions.map((execution) => (
              <li key={execution.executionId}>
                <a href={`/authority/executions/${encodeURIComponent(execution.executionId)}`}>
                  <Id value={execution.executionId} />
                </a>{' '}
                — recorded: {execution.recorded.map((entry) => <code key={entry}>{entry} </code>)}
              </li>
            ))}
          </ul>
        )}
        <h3>Reference rows</h3>
        {evidence.references.length === 0 ? (
          <Empty message="No reference is appended to this decision record." />
        ) : (
          <table className="table" data-testid="references">
            <thead>
              <tr>
                <th scope="col">Sequence</th>
                <th scope="col">Type</th>
                <th scope="col">External id</th>
                <th scope="col">Version</th>
                <th scope="col">Digest</th>
                <th scope="col">Created at</th>
              </tr>
            </thead>
            <tbody>
              {evidence.references.map((reference) => (
                <tr key={reference.referenceId}>
                  <td>{reference.sequence === null ? 'legacy' : String(reference.sequence)}</td>
                  <td>
                    <code>{reference.referenceType}</code>
                  </td>
                  <td>
                    <Id value={reference.externalId} />
                  </td>
                  <td>
                    <Text value={reference.externalVersion} />
                  </td>
                  <td>{reference.digest === null ? <span className="muted">—</span> : <Id value={reference.digest} />}</td>
                  <td>
                    <Time value={reference.createdAt} />
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

export function ProfilesPage({ context, csrfToken, catalog, flash }: { readonly context: OrganizationContext; readonly csrfToken: string; readonly catalog: ProfileCatalog; readonly flash?: string }): React.ReactElement {
  const promoted = catalog.lifecycle === 'operator-promoted';
  return (
    <Page title="Governance Profiles" context={context} csrfToken={csrfToken} active="/profiles" {...(flash !== undefined ? { flash } : {})}>
      <Section title="Catalog">
        {promoted ? (
          <p className="help">
            Profile content is trusted configuration, composed when the Host starts: a version is a catalog-backed draft until an identified operator activates it, and retirement is terminal. Content is not authored here; changing
            it is a configuration change and a restart. Activation is a <strong>permitting</strong> governance operation — a less-demanding version relaxes that profile’s own requirements for future decisions.
          </p>
        ) : (
          <Notice tone="info" title="Profiles are declared statically on this Host.">
            <p>Every configured profile is active; there is no lifecycle to transition.</p>
          </Notice>
        )}
        {catalog.profiles.length === 0 ? (
          <Empty message="No Governance Profile is configured on this Host." />
        ) : (
          <table className="table" data-testid="profiles">
            <thead>
              <tr>
                <th scope="col">Profile</th>
                <th scope="col">State</th>
                <th scope="col">Classes</th>
                <th scope="col">Governed parameters</th>
                <th scope="col">Digest</th>
                <th scope="col">Lifecycle record</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {catalog.profiles.map((profile) => (
                <tr key={`${profile.profileId}@${profile.version}`} data-profile={`${profile.profileId}@${profile.version}`}>
                  <td>
                    <Id value={profile.profileId} /> v{profile.version}
                    <br />
                    <span className="muted">
                      owner {profile.owner}; catalog content claims authored by {profile.provenance.authoredBy}, approved by {profile.provenance.approvedBy}
                    </span>
                  </td>
                  <td>
                    <Status value={profile.state} />
                  </td>
                  <td>
                    <code>{profile.actionClass}</code> × <code>{profile.resourceClass}</code>
                  </td>
                  <td>
                    <List values={(profile.definition.parameters ?? []).map((parameter) => `${parameter.dimension}${parameter.required === true ? ' (required)' : ''}`)} />
                  </td>
                  <td>
                    <Id value={profile.digest} />
                  </td>
                  <td>
                    {profile.activatedBy !== null ? (
                      <div>
                        activated <Time value={profile.activatedAt} /> by <Id value={profile.activatedBy} />
                      </div>
                    ) : null}
                    {profile.retiredBy !== null ? (
                      <div>
                        retired <Time value={profile.retiredAt} /> by <Id value={profile.retiredBy} />
                        {profile.retirementReason !== null ? ` — ${profile.retirementReason}` : ''}
                      </div>
                    ) : null}
                    {profile.activatedBy === null && profile.retiredBy === null ? <span className="muted">no lifecycle record</span> : null}
                  </td>
                  <td>
                    {promoted && profile.state === 'draft' && may(context, 'profile.promote') ? (
                      <ActionLink href={`/profiles/${encodeURIComponent(profile.profileId)}/${profile.version}/activate`}>Activate profile…</ActionLink>
                    ) : null}{' '}
                    {promoted && profile.state !== 'retired' && may(context, 'profile.retire') ? (
                      <ActionLink href={`/profiles/${encodeURIComponent(profile.profileId)}/${profile.version}/retire`}>Retire profile…</ActionLink>
                    ) : null}
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

export function EmergencyPage({ context, csrfToken, controls, flash }: { readonly context: OrganizationContext; readonly csrfToken: string; readonly controls: EmergencyControls; readonly flash?: string }): React.ReactElement {
  return (
    <Page title="Emergency controls" context={context} csrfToken={csrfToken} active="/" {...(flash !== undefined ? { flash } : {})}>
      <Section title="Active emergency controls">
        <p className="help">An active control withholds matching governed actions before any new authority is issued. Declaring a stop narrows; releasing one restores execution and is held to a separate permission.</p>
        {controls.active.length === 0 ? (
          <Empty message="No emergency control is active." />
        ) : (
          <table className="table" data-testid="emergency-controls">
            <thead>
              <tr>
                <th scope="col">Scope</th>
                <th scope="col">Value</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {controls.active.map((control) => (
                <tr key={`${control.scope}:${control.value ?? ''}`}>
                  <td>
                    <code>{control.scope}</code>
                  </td>
                  <td>{control.value === undefined ? <span className="muted">—</span> : <Id value={control.value} />}</td>
                  <td>
                    {may(context, 'emergency.release') ? (
                      <ActionLink href={`/emergency/release?${new URLSearchParams({ scope: control.scope, ...(control.value !== undefined ? { value: control.value } : {}) }).toString()}`}>Release emergency control…</ActionLink>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
      {may(context, 'emergency.stop') ? (
        <Section title="Declare an emergency stop">
          <form method="get" action="/emergency/activate" className="form form--inline">
            <label htmlFor="stop-scope">Scope</label>
            <select id="stop-scope" name="scope" className="input">
              {EMERGENCY_SCOPES.map((scope) => (
                <option key={scope} value={scope}>
                  {scope}
                </option>
              ))}
            </select>
            <label htmlFor="stop-value">Value (not for global)</label>
            <input id="stop-value" name="value" className="input" autoComplete="off" />
            <button type="submit" className="button button--danger">
              Review emergency stop…
            </button>
          </form>
        </Section>
      ) : null}
    </Page>
  );
}
