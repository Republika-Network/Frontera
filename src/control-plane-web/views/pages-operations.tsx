import * as React from 'react';

import type { HostFailure } from '../failures.js';
import { TRACE_LEVELS, type AttentionPage, type ExecutionsPage, type OperationalExecution, type OperationalMetrics, type OperationalScan, type OperationalTrace, type OperationsHealth, type OrganizationContext } from '../wire.js';
import { Empty, FailureNotice, Id, KeyValues, List, Notice, Section, Status, Text, Time } from './components.js';
import { Page } from './layout.js';

/**
 * PROD-03-01 — operational visibility pages: Attention, Executions, Trace and
 * Host Health.
 *
 * Read only. Every value is what the Host's operator plane returned for this
 * render (`/api/admin/operations/...`); the console classifies nothing, counts
 * nothing and offers no control that changes an execution — there is no form
 * here that posts anything.
 */

export const tracePath = (requestId: string, level?: string): string => `/traces/${encodeURIComponent(requestId)}${level !== undefined && level !== 'AUDITOR' ? `?level=${encodeURIComponent(level)}` : ''}`;

const isFailure = <T extends object>(value: T | HostFailure): value is HostFailure => 'kind' in value && 'message' in value;

export const ATTENTION_COVERAGE =
  'Executions this organization claimed (the write-ahead record was made before the provider was called) for which no confirmed outcome is recorded, newest first, each classified by the Host through its ASSURE-01 trace. A claim still in flight appears here too: Frontera defines no execution timeout, so attention is stated from recorded facts only. A Kernel denial, an issuance withholding, a pending approval and a confirmed success or failure never appear here.';

export const EXECUTIONS_COVERAGE =
  'Committed governed requests of this organization, newest first, each classified by the Host from its ASSURE-01 trace: the Kernel decision, whether authority was issued or withheld (and why), whether an execution was claimed, and the outcome recorded for it.';

function Attention({ execution }: { readonly execution: OperationalExecution }): React.ReactElement {
  if (!execution.attentionRequired) return <span className="muted">no</span>;
  return (
    <span className="emphasis" data-attention="required">
      required: <List values={execution.attentionReasons} />
    </span>
  );
}

function Outcome({ outcome, claim }: { readonly outcome: OperationalExecution['outcome']; readonly claim: string | undefined }): React.ReactElement {
  if (outcome.status === 'none') return <span className="muted">{claim === 'recorded' ? 'none recorded' : '—'}</span>;
  return (
    <>
      <Status value={outcome.status} />
      {outcome.failure !== null ? (
        <>
          {' '}
          <Id value={outcome.failure} />
        </>
      ) : null}
      {outcome.reasonCodes.length > 0 ? <List values={outcome.reasonCodes} /> : null}
    </>
  );
}

function Issuance({ issuance }: { readonly issuance: OperationalExecution['issuance'] }): React.ReactElement {
  return (
    <>
      <Status value={issuance.status} />
      {issuance.withheldBy !== null ? (
        <>
          {' '}
          by <Id value={issuance.withheldBy} />
        </>
      ) : null}
      {issuance.reasonCodes.length > 0 ? <List values={issuance.reasonCodes} /> : null}
    </>
  );
}

export function ExecutionTable({ executions, testId }: { readonly executions: readonly OperationalExecution[]; readonly testId: string }): React.ReactElement {
  return (
    <table className="table" data-testid={testId}>
      <thead>
        <tr>
          <th scope="col">Evaluated at</th>
          <th scope="col">Request</th>
          <th scope="col">Actor</th>
          <th scope="col">Action</th>
          <th scope="col">Kernel decision</th>
          <th scope="col">Issuance</th>
          <th scope="col">Execution claim</th>
          <th scope="col">Outcome</th>
          <th scope="col">Classification</th>
          <th scope="col">Attention</th>
        </tr>
      </thead>
      <tbody>
        {executions.map((execution) => (
          <tr key={execution.evaluationId} data-request={execution.requestId} data-classification={execution.classification} className={execution.attentionRequired ? 'row--incomplete' : undefined}>
            <td>
              <Time value={execution.decision.evaluatedAt} />
            </td>
            <td>
              {execution.trace.available ? (
                <a href={tracePath(execution.requestId)}>
                  <Id value={execution.requestId} />
                </a>
              ) : (
                <Id value={execution.requestId} />
              )}
            </td>
            <td>
              <Id value={execution.actorId} />
            </td>
            <td>
              <Id value={execution.actionType} />
            </td>
            <td>
              <Status value={execution.decision.status} />
              {execution.decision.reasonCodes.length > 0 ? <List values={execution.decision.reasonCodes} /> : null}
            </td>
            <td>
              <Issuance issuance={execution.issuance} />
            </td>
            <td>{execution.execution.claim === 'recorded' ? <Time value={execution.execution.claimedAt} /> : <span className="muted">{execution.execution.claim}</span>}</td>
            <td>
              <Outcome outcome={execution.outcome} claim={execution.execution.claim} />
            </td>
            <td>
              <code>{execution.classification}</code>
            </td>
            <td>
              <Attention execution={execution} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function AttentionListPage({ context, csrfToken, page }: { readonly context: OrganizationContext; readonly csrfToken: string; readonly page: AttentionPage | HostFailure }): React.ReactElement {
  return (
    <Page title="Attention" context={context} csrfToken={csrfToken} active="/attention">
      <Section title="Claimed executions without a confirmed outcome">
        <p className="help">{ATTENTION_COVERAGE}</p>
        <p className="help">This console only reads. Nothing on this page changes an execution or its records; open a request’s trace to see every recorded stage.</p>
        {isFailure(page) ? (
          <FailureNotice failure={page} />
        ) : page.attention.length === 0 ? (
          <Empty message="No claimed execution is missing a confirmed outcome." />
        ) : (
          <ExecutionTable executions={page.attention} testId="attention" />
        )}
        {!isFailure(page) && page.nextCursor !== null ? (
          <p>
            <a href={`/attention?cursor=${encodeURIComponent(page.nextCursor)}`}>Next page</a>
          </p>
        ) : null}
      </Section>
    </Page>
  );
}

const DECISION_STATUSES = ['allowed', 'denied', 'approval_required', 'indeterminate'] as const;

export function ExecutionsListPage({
  context,
  csrfToken,
  page,
  filter,
}: {
  readonly context: OrganizationContext;
  readonly csrfToken: string;
  readonly page: ExecutionsPage | HostFailure;
  readonly filter: { readonly status: string; readonly requestId: string };
}): React.ReactElement {
  const next = !isFailure(page) && page.nextCursor !== null ? `/executions?${new URLSearchParams({ ...(filter.status !== '' ? { status: filter.status } : {}), ...(filter.requestId !== '' ? { requestId: filter.requestId } : {}), cursor: page.nextCursor }).toString()}` : undefined;
  return (
    <Page title="Executions" context={context} csrfToken={csrfToken} active="/executions">
      <Section title="Governed requests">
        <p className="help">{EXECUTIONS_COVERAGE}</p>
        <form method="get" action="/executions" className="form form--inline">
          <label htmlFor="executions-status">Kernel decision</label>
          <select id="executions-status" name="status" className="input" defaultValue={filter.status}>
            <option value="">any</option>
            {DECISION_STATUSES.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
          <label htmlFor="executions-request">Request id</label>
          <input id="executions-request" name="requestId" className="input" autoComplete="off" defaultValue={filter.requestId} />
          <button type="submit" className="button">
            Filter
          </button>
        </form>
        {isFailure(page) ? <FailureNotice failure={page} /> : page.executions.length === 0 ? <Empty message="No governed request matches." /> : <ExecutionTable executions={page.executions} testId="executions" />}
        {next !== undefined ? (
          <p>
            <a href={next}>Next page</a>
          </p>
        ) : null}
      </Section>
    </Page>
  );
}

export function TraceIndexPage({ context, csrfToken, failure }: { readonly context: OrganizationContext; readonly csrfToken: string; readonly failure?: HostFailure }): React.ReactElement {
  return (
    <Page title="Trace" context={context} csrfToken={csrfToken} active="/traces">
      <Section title="Authority-to-outcome trace (ASSURE-01)">
        <p className="help">
          One governed request’s trace, rebuilt by the Host from its canonical records on every read and verified as it is read: the decision, the approval and obligations, the authority issued or withheld, the
          execution claim, the outcome and any resolution. It is disclosed at the level you choose, at most AUDITOR.
        </p>
        <form method="get" action="/traces" className="form form--inline">
          <label htmlFor="trace-request">Request id</label>
          <input id="trace-request" name="requestId" className="input" autoComplete="off" />
          <label htmlFor="trace-level">Disclosure level</label>
          <select id="trace-level" name="level" className="input" defaultValue="AUDITOR">
            {TRACE_LEVELS.map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
          <button type="submit" className="button">
            Open trace
          </button>
        </form>
        {failure !== undefined ? <FailureNotice failure={failure} /> : null}
      </Section>
    </Page>
  );
}

/** A disclosed stage, field by field. Nested values are shown as recorded (compact JSON text, escaped by React). */
function StageFields({ value }: { readonly value: unknown }): React.ReactElement {
  if (typeof value !== 'object' || value === null) return <Text value={String(value)} />;
  const rows = Object.entries(value as Record<string, unknown>).map(([key, inner]) => [key, typeof inner === 'object' && inner !== null ? <code className="id">{JSON.stringify(inner)}</code> : <Text value={String(inner)} />] as const);
  return rows.length === 0 ? <span className="muted">no fields</span> : <KeyValues rows={rows} />;
}

/** The stages an operator reads first, in path order, then the rest. */
const STAGE_ORDER = ['decision', 'approval', 'obligations', 'authority', 'execution', 'parameters', 'reservation', 'outcome', 'resolution', 'request', 'events'] as const;
const STAGE_TITLES: Readonly<Record<(typeof STAGE_ORDER)[number], string>> = {
  decision: 'Decision',
  approval: 'Approval',
  obligations: 'Obligations',
  authority: 'Issuance (authority)',
  execution: 'Execution claim',
  parameters: 'Parameters',
  reservation: 'Reservation',
  outcome: 'Outcome',
  resolution: 'Resolution',
  request: 'Request',
  events: 'Event stream',
};

/** A section the disclosure level left out of the operational classification. */
const HIDDEN_HERE = <span className="muted">hidden at this level</span>;

export function TracePage({ context, csrfToken, view }: { readonly context: OrganizationContext; readonly csrfToken: string; readonly view: OperationalTrace }): React.ReactElement {
  const { trace, verification, operational, disclosure } = view;
  const summary = typeof trace.summary === 'object' ? trace.summary : undefined;
  const failing = verification.checks.filter((entry) => entry.status === 'fail');
  return (
    <Page title={`Trace ${view.requestId}`} context={context} csrfToken={csrfToken} active="/traces">
      <Section title="Disclosure">
        <p>
          Disclosed at <strong data-testid="trace-level">{disclosure.level}</strong> (<Id value={disclosure.policyId} />). Other levels:{' '}
          {TRACE_LEVELS.filter((level) => level !== disclosure.level).map((level) => (
            <React.Fragment key={level}>
              <a href={tracePath(view.requestId, level)}>{level}</a>{' '}
            </React.Fragment>
          ))}
        </p>
        {disclosure.hiddenFields.length > 0 ? (
          <p className="muted">
            Hidden at this level: <List values={disclosure.hiddenFields} />
          </p>
        ) : null}
        <KeyValues
          rows={[
            ['Trace digest (disclosed)', <Id key="digest" value={view.traceDigest} />],
            ['Generated at', <Time key="at" value={view.generatedAt} />],
          ]}
        />
      </Section>
      <Section title="Operational classification">
        {operational.attentionRequired ? (
          <Notice tone="warning" title="Attention required">
            <p>
              <List values={operational.attentionReasons} />
            </p>
          </Notice>
        ) : null}
        <KeyValues
          rows={[
            [
              'Classification',
              operational.classification !== null ? (
                <code key="c" data-testid="trace-classification">
                  {operational.classification}
                </code>
              ) : (
                <span key="c" className="muted" data-testid="trace-classification-hidden">
                  not stated at this level
                </span>
              ),
            ],
            ['Kernel decision', operational.decision !== undefined ? <Status key="d" value={operational.decision.status} /> : HIDDEN_HERE],
            ['Issuance', operational.issuance !== undefined ? <Issuance key="i" issuance={operational.issuance} /> : HIDDEN_HERE],
            [
              'Execution claim',
              operational.execution === undefined ? HIDDEN_HERE : operational.execution.claim === 'recorded' ? <Time key="e" value={operational.execution.claimedAt} /> : <span key="e" className="muted">{operational.execution.claim}</span>,
            ],
            ['Outcome', operational.outcome !== undefined ? <Outcome key="o" outcome={operational.outcome} claim={operational.execution?.claim} /> : HIDDEN_HERE],
            ['Final state (trace)', <code key="f">{summary?.finalState ?? verification.finalState}</code>],
          ]}
        />
      </Section>
      <Section title="Verification">
        {verification.verified ? (
          <Notice tone="success" title="Verified">
            <p>
              Every check passed at <Time value={verification.verifiedAt} />.
            </p>
          </Notice>
        ) : (
          <Notice tone="danger" title="Verification FAILED">
            <ul>
              {failing.map((entry) => (
                <li key={`${entry.check}:${entry.category}`}>
                  <code>{entry.check}</code> ({entry.category}){entry.detail !== undefined ? <> — {entry.detail}</> : null}
                </li>
              ))}
            </ul>
          </Notice>
        )}
        <KeyValues rows={Object.entries(verification.categories).map(([category, status]) => [category, <Status key={category} value={status === 'pass' ? 'valid' : 'invalid'} />] as const)} />
        <p className="help">{verification.boundary}</p>
      </Section>
      {STAGE_ORDER.filter((stage) => stage in trace.stages).map((stage) => (
        <Section key={stage} title={STAGE_TITLES[stage]}>
          <div data-stage={stage}>
            <StageFields value={trace.stages[stage]} />
          </div>
        </Section>
      ))}
    </Page>
  );
}

function ScanNote({ scan }: { readonly scan: OperationalScan }): React.ReactElement {
  return scan.complete ? (
    <p className="muted">
      Counted from all {scan.candidates} open claim(s), each classified through its trace.
    </p>
  ) : (
    <p className="emphasis">
      Lower bounds: {scan.examined} of {scan.candidates} open claims were classified on this read (limit {scan.limit}).
    </p>
  );
}

/** Why the Host did not state confirmed outcomes, from the two facts it reports — never one reason when the other holds. */
function unstatedReason(metrics: OperationalMetrics): string {
  const reasons = [...(!metrics.consistent ? ['the records changed while they were counted'] : []), ...(!metrics.scan.complete ? ['scan incomplete'] : [])];
  return `not stated (${reasons.length > 0 ? reasons.join('; ') : 'not derivable from this read'})`;
}

export function HostHealthPage({
  context,
  csrfToken,
  health,
  metrics,
}: {
  readonly context: OrganizationContext;
  readonly csrfToken: string;
  readonly health: OperationsHealth | HostFailure;
  readonly metrics: OperationalMetrics | HostFailure;
}): React.ReactElement {
  return (
    <Page title="Host Health" context={context} csrfToken={csrfToken} active="/host-health">
      <Section title="Host">
        {isFailure(health) ? (
          <FailureNotice failure={health} />
        ) : (
          <>
            <KeyValues
              rows={[
                ['Status', <Status key="s" value={health.health.status} />],
                ['Lifecycle', <Text key="l" value={health.health.lifecycleState} />],
                ['Persistence', <Text key="p" value={`${health.health.persistence.provider} (${health.health.persistence.status})`} />],
                ['Enterprise version', <Text key="v" value={health.health.enterpriseVersion} />],
                ['Kernel version', <Text key="k" value={health.health.kernelVersion} />],
                ['Checked at', <Time key="c" value={health.health.checkedAt} />],
              ]}
            />
            {health.health.posture !== undefined ? (
              <KeyValues rows={Object.entries(health.health.posture).map(([key, value]) => [key, <code key={key}>{String(value)}</code>] as const)} />
            ) : null}
          </>
        )}
      </Section>
      <Section title="Operations">
        {isFailure(health) ? null : (
          <>
            <KeyValues
              rows={[
                ['Unresolved executions', <strong key="u" data-testid="unresolved-count">{health.operations.unresolvedExecutions}</strong>],
                ['Attention required', <strong key="a" data-testid="attention-count">{health.operations.attentionRequired}</strong>],
                ['Checked at', <Time key="c" value={health.operations.checkedAt} />],
              ]}
            />
            <ScanNote scan={health.operations.scan} />
          </>
        )}
      </Section>
      <Section title="Metrics">
        {isFailure(metrics) ? (
          <FailureNotice failure={metrics} />
        ) : (
          <>
            <KeyValues
              rows={[
                ['Decisions', String(metrics.decisions.total)],
                ['Allowed', String(metrics.decisions.allowed)],
                ['Denied', String(metrics.decisions.denied)],
                ['Approval required', String(metrics.decisions.approvalRequired)],
                ['Indeterminate', String(metrics.decisions.indeterminate)],
                ['Issuance withheld', String(metrics.issuanceWithheld)],
                ['Execution claims', String(metrics.executionClaims)],
                ['Confirmed outcomes', metrics.confirmedOutcomes === null ? <span key="n" className="missing" data-testid="confirmed-unstated">{unstatedReason(metrics)}</span> : String(metrics.confirmedOutcomes)],
                ['Unresolved executions', String(metrics.unresolvedExecutions)],
                ['Attention required', String(metrics.attentionRequired)],
                ['Computed at', <Time key="t" value={metrics.computedAt} />],
              ]}
            />
            <ScanNote scan={metrics.scan} />
            {!metrics.consistent ? (
              <p className="emphasis" data-testid="metrics-moving">
                The Host’s records kept changing while these were counted: each counter is as read, and confirmed outcomes are not stated.
              </p>
            ) : null}
          </>
        )}
      </Section>
    </Page>
  );
}
