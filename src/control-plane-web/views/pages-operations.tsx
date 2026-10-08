import * as React from 'react';

import type { HostFailure } from '../failures.js';
import {
  RESOLUTION_FAILURE_REASONS,
  TRACE_LEVELS,
  type AttentionPage,
  type ExecutionsPage,
  type OperationalExecution,
  type OperationalMetrics,
  type OperationalResolution,
  type OperationalScan,
  type OperationalTrace,
  type OperationsHealth,
  type OperatorResolutionResponse,
  type OrganizationContext,
  type ResolutionChoice,
} from '../wire.js';
import { CsrfField, Empty, FailureNotice, Id, KeyValues, List, Notice, Section, Status, Text, Time } from './components.js';
import { Page } from './layout.js';

/**
 * PROD-03-01 — operational visibility pages: Attention, Executions, Trace and
 * Host Health.
 *
 * Read only. Every value is what the Host's operator plane returned for this
 * render (`/api/admin/operations/...`); the console classifies nothing and
 * counts nothing.
 *
 * PROD-03-02 adds exactly one form: recording an operator resolution of one
 * claimed execution with no definitive outcome (`ResolutionPage`), offered
 * only where the Host says the execution is resolvable and decided by the Host
 * when submitted. It records evidence; nothing here performs, or performs
 * again, the governed action.
 *
 * After a resolution is recorded, the capacity it corrects under the
 * authority's limits is a separate fact (P12's capacity result). The console
 * states it as the Host returned it and never presents an incomplete capacity
 * reconciliation as a plain success (`ResolutionRecordedPage`,
 * `capacityReconciliationMissing`).
 */

export const tracePath = (requestId: string, level?: string): string => `/traces/${encodeURIComponent(requestId)}${level !== undefined && level !== 'AUDITOR' ? `?level=${encodeURIComponent(level)}` : ''}`;

/** PROD-03-02 — the one resolution workflow page of a request. */
export const resolutionPath = (requestId: string): string => `/traces/${encodeURIComponent(requestId)}/resolution`;

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

/** PROD-03-02 — how the definitive answer was reached when it is a resolution: an operator's recorded attestation is never shown as a provider confirmation. */
export const RESOLVED_BY_LABELS: Readonly<Record<string, string>> = {
  'operator-attestation': 'Operator resolution (recorded attestation — not a provider confirmation)',
  'resolution-authority': 'Resolution authority',
};

function Resolution({ resolution }: { readonly resolution: OperationalResolution | null | undefined }): React.ReactElement {
  if (resolution === undefined || resolution === null) return <span className="muted">none recorded</span>;
  return (
    <span data-testid="trace-resolution" data-resolved-by={resolution.resolvedBy ?? 'not-stated'}>
      <Status value={resolution.certainty} />
      {resolution.failure !== null ? (
        <>
          {' '}
          <Id value={resolution.failure} />
        </>
      ) : null}{' '}
      — {resolution.resolvedBy !== null ? (RESOLVED_BY_LABELS[resolution.resolvedBy] ?? resolution.resolvedBy) : 'mechanism not stated at this level'}
      {resolution.attestedBy !== null ? (
        <>
          , attested by <Id value={resolution.attestedBy} />
        </>
      ) : null}
      , <Time value={resolution.resolvedAt} />
    </span>
  );
}

export function TracePage({ context, csrfToken, view, flash }: { readonly context: OrganizationContext; readonly csrfToken: string; readonly view: OperationalTrace; readonly flash?: string }): React.ReactElement {
  const { trace, verification, operational, disclosure } = view;
  const summary = typeof trace.summary === 'object' ? trace.summary : undefined;
  const failing = verification.checks.filter((entry) => entry.status === 'fail');
  return (
    <Page title={`Trace ${view.requestId}`} context={context} csrfToken={csrfToken} active="/traces" {...(flash !== undefined ? { flash } : {})}>
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
        {capacityReconciliationMissing(trace.stages) ? (
          <Notice tone="warning" title="Capacity reconciliation is not on record for this resolution">
            <p data-testid="trace-capacity-unreconciled">{CAPACITY_UNRECONCILED_NOTICE}</p>
            <CapacityReconcileAgain context={context} csrfToken={csrfToken} view={view} />
          </Notice>
        ) : null}
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
            ['Resolution', operational.outcome !== undefined ? <Resolution key="r" resolution={operational.resolution} /> : HIDDEN_HERE],
            ['Final state (trace)', <code key="f">{summary?.finalState ?? verification.finalState}</code>],
          ]}
        />
        {operational.resolvable === true && context.operator.permissions.includes('operations.resolve') ? (
          <p>
            <a className="button" href={resolutionPath(view.requestId)} data-testid="record-resolution">
              Record resolution
            </a>{' '}
            <span className="help">For a claimed execution with no confirmed outcome, after you have established outside Frontera whether it completed.</span>
          </p>
        ) : null}
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

/** PROD-03-02 — what the resolution page says the action is and is not. Shown on every render, above the form. */
export const RESOLUTION_NOTICE = [
  'You are recording what you established outside Frontera about this execution. The Host records it as this execution’s definitive resolution, attributed to you.',
  'Nothing is performed: the governed action is not run, not run again and not undone, no provider is contacted, and the Kernel decision, the issued authority and any approval stay exactly as recorded.',
  'A resolution is permanent and cannot be changed by anyone. If a provider outcome is recorded before you submit, it stands and nothing is recorded.',
  'Recording that the execution did not complete returns the capacity it held under its authority’s limits once the Host reconciles it. The Host tells you, after recording, if that reconciliation is incomplete.',
] as const;

export const RESOLUTION_CHOICE_LABELS = {
  'confirmed-completed': 'Confirm this execution was completed',
  'confirmed-not-completed': 'Confirm this execution was not completed',
} as const;

/**
 * PROD-03-02 — the resolution workflow of one request, always from a fresh
 * Host read at AUDITOR: the immutable context the operator decides on, why the
 * Host allows a resolution, and the closed choice with an explicit
 * confirmation. The hidden `observedOutcome` is the state this page shows; if
 * the Host's state is different when the form is submitted, nothing is
 * recorded.
 */
export function ResolutionPage({
  context,
  csrfToken,
  view,
  failure,
  formError,
}: {
  readonly context: OrganizationContext;
  readonly csrfToken: string;
  readonly view: OperationalTrace;
  readonly failure?: HostFailure;
  /** A refused, contradictory or incomplete form: nothing was sent to the Host, and the form below starts empty again. */
  readonly formError?: string;
}): React.ReactElement {
  const { operational, verification } = view;
  const outcomeStatus = operational.outcome?.status;
  const observed = outcomeStatus === 'unconfirmed' ? 'unconfirmed' : outcomeStatus === 'none' ? 'none' : undefined;
  const resolvable = operational.resolvable === true && operational.executionId !== null && observed !== undefined;
  return (
    <Page title="Record resolution" context={context} csrfToken={csrfToken} active="/attention">
      {failure !== undefined ? <FailureNotice failure={failure} /> : null}
      {formError !== undefined ? (
        <Notice tone="danger" title="Nothing was recorded">
          <p data-testid="resolution-form-error">{formError}</p>
        </Notice>
      ) : null}
      <Notice tone="warning" title="This records evidence. It performs no action.">
        <ul>
          {RESOLUTION_NOTICE.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </Notice>
      <Section title="Execution (re-read from the Host for this page)">
        <KeyValues
          rows={[
            ['Request', <Id key="r" value={view.requestId} />],
            ['Execution', operational.executionId !== null ? <Id key="e" value={operational.executionId} /> : <span key="e" className="muted">none</span>],
            ['Actor', operational.actorId !== undefined ? <Id key="a" value={operational.actorId} /> : HIDDEN_HERE],
            ['Action', operational.actionType !== undefined ? <Id key="t" value={operational.actionType} /> : HIDDEN_HERE],
            [
              'Kernel decision (unchanged by a resolution)',
              operational.decision !== undefined ? (
                <span key="d">
                  <Status value={operational.decision.status} /> {operational.decision.reasonCodes.length > 0 ? <List values={operational.decision.reasonCodes} /> : null}
                </span>
              ) : (
                HIDDEN_HERE
              ),
            ],
            ['Issuance', operational.issuance !== undefined ? <Issuance key="i" issuance={operational.issuance} /> : HIDDEN_HERE],
            [
              'Execution claim',
              operational.execution === undefined ? HIDDEN_HERE : operational.execution.claim === 'recorded' ? <Time key="c" value={operational.execution.claimedAt} /> : <span key="c" className="muted">{operational.execution.claim}</span>,
            ],
            ['Known outcome', operational.outcome !== undefined ? <Outcome key="o" outcome={operational.outcome} claim={operational.execution?.claim} /> : HIDDEN_HERE],
            ['Resolution', <Resolution key="res" resolution={operational.resolution} />],
            [
              'Trace',
              <span key="v">
                {verification.verified ? <Status value="verified" /> : <Status value="verification-failed" />} <code>{verification.finalState}</code>
              </span>,
            ],
            ['Classification', operational.classification !== null ? <code key="k">{operational.classification}</code> : HIDDEN_HERE],
          ]}
        />
        <p className="help" data-testid="resolution-why">
          {resolvable
            ? 'Why a resolution is allowed: this execution was claimed — the write-ahead record was made before the provider was called, so the provider may have been reached — and no definitive outcome and no resolution is recorded for it. Its trace verifies, and no governed call for it is in progress on this Host. The Host checks all of this again when you submit.'
            : 'The Host does not allow a resolution of this execution now: it has a definitive outcome or resolution already, it was never claimed, its records do not verify, or this Host records no operator resolutions.'}
        </p>
      </Section>
      {resolvable ? (
        <form method="post" action={resolutionPath(view.requestId)} className="form" data-testid="resolution-form">
          <CsrfField token={csrfToken} />
          <input type="hidden" name="observedOutcome" value={observed} />
          <fieldset className="field">
            <legend>Resolution (required)</legend>
            {(['confirmed-completed', 'confirmed-not-completed'] as const).map((choice) => (
              <div key={choice} className="field field--check">
                <input id={`resolution-${choice}`} name="resolution" type="radio" value={choice} required />
                <label htmlFor={`resolution-${choice}`}>{RESOLUTION_CHOICE_LABELS[choice]}</label>
              </div>
            ))}
          </fieldset>
          <div className="field">
            <label htmlFor="failure">Reason it did not complete — required when confirming it was not completed; must be left empty (—) when confirming it was completed</label>
            <select id="failure" name="failure" className="input" defaultValue="">
              <option value="">—</option>
              {RESOLUTION_FAILURE_REASONS.map((reason) => (
                <option key={reason} value={reason}>
                  {reason}
                </option>
              ))}
            </select>
          </div>
          <div className="field field--check">
            <input id="confirm" name="confirm" type="checkbox" value="yes" required />
            <label htmlFor="confirm">I established this outside Frontera, and I intend to record it as this execution’s permanent resolution. I understand that no action is performed.</label>
          </div>
          <div className="form__actions">
            <button type="submit" className="button button--danger">
              Record resolution
            </button>
            <a className="button button--quiet" href={tracePath(view.requestId)}>
              Cancel
            </a>
          </div>
        </form>
      ) : (
        <p>
          <a href={tracePath(view.requestId)}>Back to the trace</a>
        </p>
      )}
    </Page>
  );
}

/**
 * PROD-03-02 — what the console says about P12's capacity result once a
 * resolution is recorded, keyed by the Host's closed vocabulary. The
 * resolution stands in every case; only `adjusted` and `no-reservation` mean
 * nothing about capacity is left to do.
 */
export const CAPACITY_RESULT_NOTICES: Readonly<Record<string, { readonly tone: 'success' | 'warning' | 'danger'; readonly title: string; readonly body: string }>> = {
  adjusted: { tone: 'success', title: 'Capacity reconciled', body: 'The capacity this execution held under its authority’s limits was reconciled with the resolution.' },
  'no-reservation': { tone: 'success', title: 'No capacity to reconcile', body: 'This execution held no reservation under its authority’s limits.' },
  pending: {
    tone: 'warning',
    title: 'Resolution recorded. Capacity reconciliation is still pending.',
    body: 'The capacity ledger could not be reached. The resolution stands; the capacity this execution held stays conservatively consumed until its reconciliation completes. Running it again submits the identical resolution: nothing new is recorded, no action is performed, and only the capacity reconciliation runs again.',
  },
  conflict: {
    tone: 'danger',
    title: 'Resolution recorded. Capacity reconciliation is in conflict and requires investigation.',
    body: 'The capacity ledger already holds a different resolution for this execution’s reservation. The recorded resolution stands and capacity was not changed. Investigate the reservation before relying on the remaining limits.',
  },
  inconsistent: {
    tone: 'danger',
    title: 'Resolution recorded. The capacity ledger contradicts it.',
    body: 'The capacity ledger’s own history contradicts this resolution (for example, capacity was already released for an effect now recorded as completed). Nothing was repaired. Treat this as an integrity incident and investigate before relying on the remaining limits.',
  },
  'not-composed': {
    tone: 'warning',
    title: 'Resolution recorded. Capacity reconciliation is unavailable in this Host.',
    body: 'This Host composes no capacity reconciliation, so the capacity this execution held stays conservatively consumed.',
  },
};

/** The capacity results that leave nothing to do: a plain success is truthful only for these. */
export const CAPACITY_RECONCILED: ReadonlySet<string> = new Set(['adjusted', 'no-reservation']);

const UNRECOGNIZED_CAPACITY = {
  tone: 'danger' as const,
  title: 'Resolution recorded. Its capacity result is not one this console recognizes.',
  body: 'The resolution stands. Treat the capacity this execution held as not reconciled and investigate the reservation.',
};

export const CAPACITY_UNRECONCILED_NOTICE =
  'A resolution is recorded for this execution, but its reservation under the authority’s limits holds no matching reconciliation: the capacity it held may still be consumed, or the ledger contradicts the resolution. The resolution stands. Investigate the reservation below.';

const asRecord = (value: unknown): Readonly<Record<string, unknown>> | undefined => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Readonly<Record<string, unknown>>) : undefined);

/**
 * PROD-03-02 — from the disclosed trace alone: a definitive resolution is
 * recorded, the execution holds a P7 reservation, and that reservation carries
 * no reconciliation matching the resolution — the same answer recorded for
 * the same resolution digest. Display only — the Host's
 * classification, attention and counts are unchanged — and silent at a
 * disclosure level that hides either stage.
 */
export function capacityReconciliationMissing(stages: Readonly<Record<string, unknown>>): boolean {
  const reservation = asRecord(stages['reservation']);
  const resolved = asRecord(asRecord(stages['resolution'])?.['resolution']);
  if (reservation === undefined || resolved === undefined || reservation['presence'] !== 'recorded') return false;
  const certainty = resolved['certainty'];
  if (certainty !== 'confirmed-completed' && certainty !== 'confirmed-not-completed') return false;
  if (reservation['resolution'] !== certainty) return true;
  // P7's identity is the answer **and** the digest it was recorded for: a row with the same answer for another resolution is a conflict, not a reconciliation.
  const recordedFor = reservation['resolutionDigest'];
  const digest = resolved['resolutionDigest'];
  return typeof recordedFor === 'string' && typeof digest === 'string' ? recordedFor !== digest : recordedFor === undefined && digest !== undefined;
}

/**
 * PROD-03-02 — the answer to a recorded resolution whose capacity
 * reconciliation is not complete. Both truths are stated: the resolution is
 * durable, and capacity is not reconciled. Only for `pending` — which P12
 * completes when the identical resolution is submitted again — is a second
 * submission offered: the same resolution, so nothing new is recorded and
 * nothing is performed.
 */
export function ResolutionRecordedPage({
  context,
  csrfToken,
  requestId,
  recorded,
  submitted,
}: {
  readonly context: OrganizationContext;
  readonly csrfToken: string;
  readonly requestId: string;
  readonly recorded: OperatorResolutionResponse;
  readonly submitted: { readonly resolution: ResolutionChoice; readonly failure?: string; readonly observedOutcome: 'none' | 'unconfirmed' };
}): React.ReactElement {
  const notice = CAPACITY_RESULT_NOTICES[recorded.capacity] ?? UNRECOGNIZED_CAPACITY;
  return (
    <Page title="Resolution recorded" context={context} csrfToken={csrfToken} active="/attention">
      <Notice tone="info" title={recorded.outcome === 'replayed' ? 'Resolution already recorded (same resolution, unchanged)' : 'Resolution recorded'}>
        <p data-testid="resolution-recorded">
          {recorded.resolution.certainty}
          {recorded.resolution.failure !== null ? ` (${recorded.resolution.failure})` : ''}, attested by {recorded.resolution.attestedBy}. Evidence only — no action was performed.
        </p>
      </Notice>
      <Notice tone={notice.tone} title={notice.title}>
        <p data-testid="resolution-capacity" data-capacity={recorded.capacity}>
          {notice.body}
        </p>
      </Notice>
      <KeyValues
        rows={[
          ['Execution', <Id key="e" value={recorded.executionId} />],
          ['Capacity result (as the Host stated it)', <code key="c">{recorded.capacity}</code>],
          ['Resolution digest', <Id key="d" value={recorded.resolution.resolutionDigest} />],
        ]}
      />
      {recorded.capacity === 'pending' ? <ReconcileAgainForm csrfToken={csrfToken} requestId={requestId} submitted={submitted} /> : null}
      <p>
        <a href={tracePath(requestId)}>Back to the trace</a>
      </p>
    </Page>
  );
}

/** The identical resolution, as hidden fields only: what an operator re-submits to run P12's capacity step again. */
interface IdenticalResolution {
  readonly resolution: ResolutionChoice;
  readonly failure?: string;
  readonly observedOutcome: 'none' | 'unconfirmed';
}

/**
 * PROD-03-02 — the one form that re-submits a resolution: the identical one,
 * hidden fields only, to the same resolution route. P12's `replayed` path
 * records nothing new and performs nothing; it re-runs only the capacity
 * reconciliation.
 */
function ReconcileAgainForm({ csrfToken, requestId, submitted }: { readonly csrfToken: string; readonly requestId: string; readonly submitted: IdenticalResolution }): React.ReactElement {
  return (
    <form method="post" action={resolutionPath(requestId)} className="form" data-testid="capacity-reconcile-again-form">
      <CsrfField token={csrfToken} />
      <input type="hidden" name="resolution" value={submitted.resolution} />
      {submitted.failure !== undefined ? <input type="hidden" name="failure" value={submitted.failure} /> : null}
      <input type="hidden" name="observedOutcome" value={submitted.observedOutcome} />
      <input type="hidden" name="confirm" value="yes" />
      <div className="form__actions">
        <button type="submit" className="button">
          Run capacity reconciliation again
        </button>
      </div>
      <p className="help">Submits the identical resolution again. Nothing new is recorded and no action is performed.</p>
    </form>
  );
}

/**
 * PROD-03-02 — the identical resolution recoverable from the durable trace, so
 * an incomplete capacity reconciliation is not lost with the page that first
 * reported it. Only for a trace that verifies (a contradiction is
 * investigated, never re-run), for the operator who attested it (an identical
 * replay is the same operator's), and only for the basis the trace states.
 * The Host checks all of it again.
 */
export function identicalResolutionOf(view: OperationalTrace, context: OrganizationContext): IdenticalResolution | undefined {
  if (!view.verification.verified || !context.operator.permissions.includes('operations.resolve')) return undefined;
  const resolved = asRecord(asRecord(view.trace.stages['resolution'])?.['resolution']);
  const outcome = asRecord(view.trace.stages['outcome']);
  if (resolved === undefined || outcome === undefined || resolved['attestedBy'] !== `operator:${context.operator.operatorId}`) return undefined;
  const observedOutcome = outcome['presence'] === 'recorded' && outcome['certainty'] === 'unconfirmed' ? 'unconfirmed' : outcome['presence'] === 'unresolved' ? 'none' : undefined;
  if (observedOutcome === undefined) return undefined;
  const certainty = resolved['certainty'];
  const failure = resolved['failure'];
  if (certainty === 'confirmed-completed') return { resolution: certainty, observedOutcome };
  if (certainty === 'confirmed-not-completed' && typeof failure === 'string') return { resolution: certainty, failure, observedOutcome };
  return undefined;
}

function CapacityReconcileAgain({ context, csrfToken, view }: { readonly context: OrganizationContext; readonly csrfToken: string; readonly view: OperationalTrace }): React.ReactElement | null {
  const submitted = identicalResolutionOf(view, context);
  if (submitted !== undefined) return <ReconcileAgainForm csrfToken={csrfToken} requestId={view.requestId} submitted={submitted} />;
  return <p className="help">Only the operator who recorded this resolution can submit it again to complete the capacity reconciliation, and only while its trace verifies.</p>;
}
