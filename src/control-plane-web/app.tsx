import * as React from 'react';
import type { IncomingMessage } from 'node:http';
import { renderToStaticMarkup } from 'react-dom/server';

import { lifecycleTransitions } from './activity.js';
import { buildApprovalCommand } from './approval-forms.js';
import type { HostFailure } from './failures.js';
import { buildProvisionRequest, PARAMETER_BOUND_MAX_ROWS } from './forms.js';
import type { HostClient, HostResult } from './host-client.js';
import { ConsoleRequestError, clearCookie, cookieNames, readCookie, readForm, sameOrigin, setCookie, type FormFields } from './security.js';
import { newFormToken, newIdempotencyKey, takeFlash, tokensEqual, type ConsoleSession, type SessionStore } from './session.js';
import { CONSOLE_CSS } from './styles.js';
import { ENTITY_KIND_LABELS, GRANT_REVOCATION_REASONS, isApprovalVerb, isApprovalView, isEntityKind, isTraceLevel, type ApprovalVerb, type EntityKind, type EntityView, type OrganizationContext } from './wire.js';
import { boundsOf, lineageOf } from './views/authority-terms.js';
import { Id, Status } from './views/components.js';
import type { FormValues } from './views/entity-form.js';
import { AgentOnboardPage, AgentPage, AgentsPage } from './views/pages-agents.js';
import { AuthorityPage, EntityPage, ExecutionPage, GrantPage, ProvisionPage } from './views/pages-authority.js';
import { ConfirmPage, CredentialIssuedPage, ErrorPage, LoginPage, OverviewPage } from './views/pages-core.js';
import { ActivityPage, EmergencyPage, EvidenceIndexPage, EvidencePage, ProfilesPage } from './views/pages-records.js';
import { ApprovalCommandPage, ApprovalPage, ApprovalsPage } from './views/pages-approvals.js';
import { AttentionListPage, ExecutionsListPage, HostHealthPage, TraceIndexPage, TracePage, tracePath } from './views/pages-operations.js';

/**
 * CTRL-03 — the Frontera web control plane: request handling.
 *
 * ```
 * browser (HTML + forms, no script)
 *   └─ session cookie (opaque) + CSRF token + same-origin check     this module
 *       └─ HostClient: the operator bearer, server-side only           host-client.ts
 *           └─ Frontera Host operator plane (/api/admin/...)           authenticates + authorizes every call
 *               └─ CTRL-01 / CTRL-02 services → canonical Kernel Authority / governance state
 * ```
 *
 * The console decides nothing. Every page re-reads the operator's context and
 * the state it shows from the Host; every operation is forwarded to the Host,
 * which authorizes it; a success is followed by a fresh read of canonical
 * state (redirect-after-POST), a failure is shown exactly as the Host stated
 * it. Hiding a control is presentation, never authorization: a forged form
 * reaches the Host and is refused there.
 */

export interface ConsoleLogger {
  info(message: string, fields: Readonly<Record<string, string | number>>): void;
}

export interface ConsoleAppOptions {
  readonly host: HostClient;
  readonly sessions: SessionStore;
  /** The exact origin browsers use to reach the console (scheme://host[:port]). State-changing requests must come from it. */
  readonly publicOrigin: string;
  readonly logger?: ConsoleLogger;
}

export interface ConsoleResponse {
  readonly status: number;
  readonly contentType?: string;
  readonly body?: string;
  readonly location?: string;
  readonly cookies?: readonly string[];
}

const html = (status: number, element: React.ReactElement, cookies?: readonly string[]): ConsoleResponse => ({
  status,
  contentType: 'text/html; charset=utf-8',
  body: `<!doctype html>${renderToStaticMarkup(element)}`,
  ...(cookies !== undefined ? { cookies } : {}),
});
const redirect = (location: string, cookies?: readonly string[]): ConsoleResponse => ({ status: 303, location, ...(cookies !== undefined ? { cookies } : {}) });

/** The console's own HTTP status for a Host failure. */
export function statusForFailure(failure: HostFailure): number {
  switch (failure.kind) {
    case 'unauthenticated':
      return 401;
    case 'unauthorized':
      return 403;
    case 'validation':
      return 400;
    case 'idempotency-conflict':
    case 'refused':
      return 409;
    case 'not-found':
      return 404;
    case 'recorded-refresh-failed':
    case 'unavailable':
      return 503;
    case 'integrity-failed':
      return 500;
    case 'unknown':
      return 502;
  }
}

const enc = encodeURIComponent;

interface Authed {
  readonly session: ConsoleSession;
  readonly context: OrganizationContext;
  readonly csrf: string;
}

function formValues(form: FormFields): FormValues {
  const values: Record<string, string> = {};
  for (const name of form.names()) if (name !== 'csrf' && name !== 'credential') values[name] = form.raw(name);
  return values;
}

function flashOf(session: ConsoleSession): { flash?: string } {
  const flash = takeFlash(session);
  return flash !== undefined ? { flash } : {};
}

export function createConsoleApp(options: ConsoleAppOptions): { handle(req: IncomingMessage): Promise<ConsoleResponse> } {
  const { host, sessions, publicOrigin } = options;
  const secure = publicOrigin.startsWith('https://');
  const cookieOptions = { secure };
  const { session: SESSION_COOKIE, login: LOGIN_COOKIE } = cookieNames(secure);

  function sessionCookie(session: ConsoleSession): string {
    return setCookie(SESSION_COOKIE, session.id, cookieOptions);
  }

  function signedOut(reason: 'expired' | 'signed-out'): ConsoleResponse {
    return redirect(`/login?reason=${reason}`, [clearCookie(SESSION_COOKIE, cookieOptions)]);
  }

  /** A Host failure on a page: unauthenticated ends the session; anything else is shown as itself. */
  function failurePage(authed: Authed, title: string, failure: HostFailure, children?: React.ReactNode): ConsoleResponse {
    if (failure.kind === 'unauthenticated') {
      sessions.destroy(authed.session.id);
      return signedOut('expired');
    }
    return html(
      statusForFailure(failure),
      <ErrorPage title={title} failure={failure} context={authed.context} csrfToken={authed.csrf}>
        {children}
      </ErrorPage>,
    );
  }

  async function authenticate(req: IncomingMessage): Promise<{ readonly ok: true; readonly authed: Authed } | { readonly ok: false; readonly response: ConsoleResponse }> {
    const cookie = readCookie(req, SESSION_COOKIE);
    const session = sessions.get(cookie);
    if (session === undefined) return { ok: false, response: cookie === undefined ? redirect('/login') : signedOut('expired') };
    const context = await host.organization(session.bearer);
    if (!context.ok) {
      if (context.failure.kind === 'unauthenticated' || context.failure.kind === 'unauthorized') {
        sessions.destroy(session.id);
        return { ok: false, response: signedOut('expired') };
      }
      return { ok: false, response: html(statusForFailure(context.failure), <ErrorPage title="The Host could not be read" failure={context.failure} />) };
    }
    return { ok: true, authed: { session, context: context.body, csrf: session.csrfToken } };
  }

  /** Every state-changing request: same origin, then the session's CSRF token — before the form is used for anything else. */
  async function authenticatedForm(req: IncomingMessage): Promise<{ readonly ok: true; readonly authed: Authed; readonly form: FormFields } | { readonly ok: false; readonly response: ConsoleResponse }> {
    if (!sameOrigin(req, publicOrigin)) return { ok: false, response: html(403, <ErrorPage title="Request refused: cross-origin" />) };
    const session = sessions.get(readCookie(req, SESSION_COOKIE));
    if (session === undefined) return { ok: false, response: signedOut('expired') };
    const form = await readForm(req);
    if (!tokensEqual(form.text('csrf'), session.csrfToken)) return { ok: false, response: html(403, <ErrorPage title="Request refused: the form token is missing or stale" />) };
    const result = await authenticate(req);
    if (!result.ok) return result;
    return { ok: true, authed: result.authed, form };
  }

  function confirmed(form: FormFields): boolean {
    return form.text('confirm') === 'yes';
  }

  async function dimensionsOf(bearer: string): Promise<readonly string[]> {
    const profiles = await host.profiles(bearer);
    if (!profiles.ok) return [];
    return [...new Set(profiles.body.profiles.flatMap((profile) => (profile.definition.parameters ?? []).map((parameter) => parameter.dimension)))].sort();
  }

  const settle = <T,>(result: HostResult<T>): T | HostFailure => (result.ok ? result.body : result.failure);

  // -- sign-in -------------------------------------------------------------------------

  function loginPage(status: number, extra: { message?: string; failure?: HostFailure } = {}): ConsoleResponse {
    const loginToken = newFormToken();
    return html(status, <LoginPage loginToken={loginToken} {...extra} />, [setCookie(LOGIN_COOKIE, loginToken, { ...cookieOptions, maxAgeSeconds: 600 })]);
  }

  async function login(req: IncomingMessage): Promise<ConsoleResponse> {
    if (!sameOrigin(req, publicOrigin)) return html(403, <ErrorPage title="Request refused: cross-origin" />);
    const form = await readForm(req);
    if (!tokensEqual(form.text('loginToken'), readCookie(req, LOGIN_COOKIE))) return loginPage(403, { message: 'This sign-in form expired. Sign in again.' });
    const credential = form.raw('credential');
    if (credential.length === 0 || credential.length > 512) return loginPage(400, { message: 'Enter your operator credential.' });
    const organization = await host.organization(credential);
    if (!organization.ok) {
      const { failure } = organization;
      const message =
        failure.kind === 'unauthenticated'
          ? 'The Host does not recognize this credential as an operator credential.'
          : failure.kind === 'unauthorized'
            ? 'This credential cannot open the web control plane. Only identified operators declared with a role can; a CTRL-01 administrator credential, an API key or an agent credential cannot.'
            : failure.kind === 'not-found'
              ? 'This Host has no operator plane configured.'
              : 'The Host could not verify the credential.';
      return loginPage(failure.kind === 'unauthenticated' ? 401 : failure.kind === 'unauthorized' ? 403 : statusForFailure(failure), { message, failure });
    }
    // A new sign-in never coexists with an earlier session on this browser.
    sessions.destroy(readCookie(req, SESSION_COOKIE));
    const session = sessions.create(credential, organization.body.operator.operatorId);
    return redirect('/', [sessionCookie(session), clearCookie(LOGIN_COOKIE, cookieOptions)]);
  }

  // -- pages -------------------------------------------------------------------------------

  async function overview(authed: Authed): Promise<ConsoleResponse> {
    const { bearer } = authed.session;
    const [agents, entities, profiles, emergency] = await Promise.all([host.listAgents(bearer), host.listEntities(bearer), host.profiles(bearer), host.emergencyControls(bearer)]);
    for (const result of [agents, entities, profiles, emergency]) if (!result.ok && result.failure.kind === 'unauthenticated') return failurePage(authed, 'Overview', result.failure);
    return html(
      200,
      <OverviewPage
        context={authed.context}
        csrfToken={authed.csrf}
        {...flashOf(authed.session)}
        data={{ agents: agents.ok ? agents.body.agents : agents.failure, entities: entities.ok ? entities.body.entities : entities.failure, profiles: settle(profiles), emergency: settle(emergency) }}
      />,
    );
  }

  /** The agent page — after a failed issue, with that failure shown and the same idempotency key kept, so a retry is the same request. */
  async function agentPage(authed: Authed, actorId: string, issue?: { readonly failure: HostFailure; readonly idempotencyKey: string }): Promise<ConsoleResponse> {
    const { bearer } = authed.session;
    const [agent, entities] = await Promise.all([host.agent(bearer, actorId), host.listEntities(bearer)]);
    if (!agent.ok) return failurePage(authed, `Agent ${actorId}`, issue?.failure ?? agent.failure);
    return html(
      issue === undefined ? 200 : statusForFailure(issue.failure),
      <AgentPage
        context={authed.context}
        csrfToken={authed.csrf}
        agent={agent.body}
        entities={entities.ok ? entities.body.entities : entities.failure}
        issueIdempotencyKey={issue?.idempotencyKey ?? newIdempotencyKey()}
        {...(issue !== undefined ? { failure: issue.failure } : {})}
        {...flashOf(authed.session)}
      />,
    );
  }

  function provisionValues(kind: EntityKind, context: OrganizationContext, query: URLSearchParams, all: readonly EntityView[]): { values: Record<string, string>; source?: { chain: readonly EntityView[] } } {
    const values: Record<string, string> = {};
    const trustDomain = context.organization.trustDomainId;
    if (trustDomain !== null && kind !== 'trust-domain') values['trustDomainId'] = trustDomain;
    const subject = query.get('subject');
    if (subject !== null && subject !== '') values['subjectActorId'] = subject;
    const delegate = query.get('delegate');
    if (kind === 'delegation-grant' && delegate !== null && delegate !== '') {
      values['delegateActorId'] = delegate;
      values['delegateActorType'] = 'agent';
    }
    const sourceId = query.get('source');
    if (kind === 'delegation-grant' && sourceId !== null && sourceId !== '') {
      const source = all.find((entity) => entity.entityKind === 'authority-grant' && entity.entityId === sourceId) ?? all.find((entity) => entity.entityKind === 'delegation-grant' && entity.entityId === sourceId);
      if (source !== undefined) {
        const terms = source.terms;
        values['sourceAuthorityGrantId'] = source.entityId;
        if (typeof source.trustDomainId === 'string') values['trustDomainId'] = source.trustDomainId;
        const delegator = source.entityKind === 'authority-grant' ? terms['subjectActorId'] : terms['delegateActorId'];
        if (typeof delegator === 'string') values['delegatorActorId'] = delegator;
        if (typeof terms['capability'] === 'string') values['capability'] = terms['capability'];
        for (const key of ['actions', 'resourceScopes']) if (Array.isArray(terms[key])) values[key] = (terms[key] as string[]).join('\n');
        // The parent's own bounds, unchanged: the starting point may be kept or narrowed — it never suggests a wider value.
        boundsOf(terms)
          .slice(0, PARAMETER_BOUND_MAX_ROWS)
          .forEach((bound, row) => {
            values[`bound.${row}.dimension`] = String(bound.dimension);
            values[`bound.${row}.form`] = bound.kind === 'maximum' ? 'maximum-integer' : `exact-${String(bound.type)}`;
            values[`bound.${row}.value`] = String(bound.kind === 'maximum' ? bound.limit : bound.value);
          });
        return { values, source: { chain: lineageOf(source, all) } };
      }
    }
    return { values };
  }

  async function provisionForm(authed: Authed, kind: EntityKind, query: URLSearchParams): Promise<ConsoleResponse> {
    const { bearer } = authed.session;
    const [entities, dimensions] = await Promise.all([host.listEntities(bearer), dimensionsOf(bearer)]);
    const all = entities.ok ? entities.body.entities : [];
    const { values, source } = provisionValues(kind, authed.context, query, all);
    return html(
      200,
      <ProvisionPage context={authed.context} csrfToken={authed.csrf} kind={kind} idempotencyKey={newIdempotencyKey()} values={values} errors={{}} dimensions={dimensions} {...(source !== undefined ? { source } : {})} />,
    );
  }

  async function provision(authed: Authed, kind: EntityKind, form: FormFields): Promise<ConsoleResponse> {
    const { bearer } = authed.session;
    const values = formValues(form);
    const idempotencyKey = form.text('idempotencyKey') || newIdempotencyKey();
    const rerender = async (status: number, errors: Readonly<Record<string, string>>, failure?: HostFailure): Promise<ConsoleResponse> =>
      html(
        status,
        <ProvisionPage
          context={authed.context}
          csrfToken={authed.csrf}
          kind={kind}
          idempotencyKey={idempotencyKey}
          values={values}
          errors={errors}
          dimensions={await dimensionsOf(bearer)}
          {...(failure !== undefined ? { failure } : {})}
        />,
      );
    const built = buildProvisionRequest(kind, form);
    if (!built.ok) return rerender(400, built.errors);
    const result = await host.provision(bearer, kind, built.body);
    if (!result.ok) {
      if (result.failure.kind === 'unauthenticated') return failurePage(authed, 'Provision', result.failure);
      return rerender(statusForFailure(result.failure), {}, result.failure);
    }
    authed.session.flash = `${ENTITY_KIND_LABELS[kind]} ${result.body.entity.entityId}: ${result.body.outcome}. The canonical record was re-read from the Host below.`;
    return redirect(`/authority/entities/${enc(result.body.entity.entityKind)}/${enc(result.body.entity.entityId)}`);
  }

  async function onboard(authed: Authed, form: FormFields): Promise<ConsoleResponse> {
    const values = formValues(form);
    const idempotencyKey = form.text('idempotencyKey') || newIdempotencyKey();
    const page = (status: number, errors: Readonly<Record<string, string>>, failure?: HostFailure): ConsoleResponse =>
      html(status, <AgentOnboardPage context={authed.context} csrfToken={authed.csrf} idempotencyKey={idempotencyKey} values={values} errors={errors} {...(failure !== undefined ? { failure } : {})} />);
    if (form.text('type') !== 'agent') return page(400, { type: 'This form onboards agents only.' });
    const built = buildProvisionRequest('actor', form);
    if (!built.ok) return page(400, built.errors);
    const result = await host.provision(authed.session.bearer, 'actor', built.body);
    if (!result.ok) return result.failure.kind === 'unauthenticated' ? failurePage(authed, 'Onboard an agent', result.failure) : page(statusForFailure(result.failure), {}, result.failure);
    authed.session.flash = `Agent actor ${result.body.entity.entityId}: ${result.body.outcome}. Stage 1 of onboarding is recorded; the stages below were re-read from the Host.`;
    return redirect(`/agents/${enc(result.body.entity.entityId)}`);
  }

  async function activity(authed: Authed, query: URLSearchParams): Promise<ConsoleResponse> {
    const { bearer } = authed.session;
    const filter = { actorId: query.get('actorId') ?? '', status: query.get('status') ?? '' };
    const cursor = query.get('cursor') ?? '';
    const [decisions, entities, agents, profiles] = await Promise.all([
      host.decisions(bearer, { ...(filter.actorId !== '' ? { actorId: filter.actorId } : {}), ...(filter.status !== '' ? { status: filter.status } : {}), ...(cursor !== '' ? { cursor } : {}), limit: 50 }),
      host.listEntities(bearer),
      host.listAgents(bearer),
      host.profiles(bearer),
    ]);
    const lifecycleFailure = !entities.ok ? entities.failure : !agents.ok ? agents.failure : !profiles.ok ? profiles.failure : undefined;
    const transitions =
      lifecycleFailure !== undefined || !entities.ok || !agents.ok || !profiles.ok
        ? (lifecycleFailure as HostFailure)
        : lifecycleTransitions({ entities: entities.body.entities, agents: agents.body.agents, profiles: profiles.body.profiles });
    return html(200, <ActivityPage context={authed.context} csrfToken={authed.csrf} decisions={settle(decisions)} filter={filter} transitions={transitions} />);
  }

  async function evidenceIndex(authed: Authed, query: URLSearchParams): Promise<ConsoleResponse> {
    const { bearer } = authed.session;
    const evaluationId = (query.get('evaluationId') ?? '').trim();
    if (evaluationId !== '') return redirect(`/evidence/decisions/${enc(evaluationId)}`);
    const decisionId = (query.get('decisionId') ?? '').trim();
    const requestId = (query.get('requestId') ?? '').trim();
    const recent = await host.decisions(bearer, { limit: 10 });
    if (decisionId !== '' || requestId !== '') {
      const matches = await host.decisions(bearer, { ...(decisionId !== '' ? { decisionId } : {}), ...(requestId !== '' ? { requestId } : {}), limit: 10 });
      if (matches.ok && matches.body.decisions.length === 1 && matches.body.decisions[0] !== undefined) return redirect(`/evidence/decisions/${enc(matches.body.decisions[0].evaluationId)}`);
      return html(
        matches.ok ? 200 : statusForFailure(matches.failure),
        <EvidenceIndexPage context={authed.context} csrfToken={authed.csrf} recent={settle(recent)} {...(matches.ok ? { matches: matches.body } : { failure: matches.failure })} />,
      );
    }
    return html(200, <EvidenceIndexPage context={authed.context} csrfToken={authed.csrf} recent={settle(recent)} />);
  }

  // -- PROD-03-01 operational visibility (reads only) -----------------------------------------

  async function attentionPage(authed: Authed, query: URLSearchParams): Promise<ConsoleResponse> {
    const cursor = query.get('cursor') ?? '';
    const page = await host.attention(authed.session.bearer, { limit: 50, ...(cursor !== '' ? { cursor } : {}) });
    if (!page.ok && page.failure.kind === 'unauthenticated') return failurePage(authed, 'Attention', page.failure);
    return html(page.ok ? 200 : statusForFailure(page.failure), <AttentionListPage context={authed.context} csrfToken={authed.csrf} page={settle(page)} />);
  }

  async function executionsPage(authed: Authed, query: URLSearchParams): Promise<ConsoleResponse> {
    const filter = { status: query.get('status') ?? '', requestId: (query.get('requestId') ?? '').trim() };
    const cursor = query.get('cursor') ?? '';
    const page = await host.executions(authed.session.bearer, { ...(filter.status !== '' ? { status: filter.status } : {}), ...(filter.requestId !== '' ? { requestId: filter.requestId } : {}), ...(cursor !== '' ? { cursor } : {}), limit: 50 });
    if (!page.ok && page.failure.kind === 'unauthenticated') return failurePage(authed, 'Executions', page.failure);
    return html(page.ok ? 200 : statusForFailure(page.failure), <ExecutionsListPage context={authed.context} csrfToken={authed.csrf} page={settle(page)} filter={filter} />);
  }

  async function tracePage(authed: Authed, requestId: string, query: URLSearchParams): Promise<ConsoleResponse> {
    const level = query.get('level') ?? 'AUDITOR';
    if (!isTraceLevel(level)) return html(400, <ErrorPage title="Unknown disclosure level" context={authed.context} csrfToken={authed.csrf} />);
    const view = await host.trace(authed.session.bearer, requestId, level);
    if (!view.ok) return view.failure.kind === 'unauthenticated' ? failurePage(authed, 'Trace', view.failure) : html(statusForFailure(view.failure), <TraceIndexPage context={authed.context} csrfToken={authed.csrf} failure={view.failure} />);
    return html(200, <TracePage context={authed.context} csrfToken={authed.csrf} view={view.body} />);
  }

  async function hostHealthPage(authed: Authed): Promise<ConsoleResponse> {
    const { bearer } = authed.session;
    const [health, metrics] = await Promise.all([host.operationsHealth(bearer), host.operationsMetrics(bearer)]);
    for (const result of [health, metrics]) if (!result.ok && result.failure.kind === 'unauthenticated') return failurePage(authed, 'Host Health', result.failure);
    return html(health.ok ? 200 : statusForFailure(health.failure), <HostHealthPage context={authed.context} csrfToken={authed.csrf} health={settle(health)} metrics={settle(metrics)} />);
  }

  // -- confirmations ------------------------------------------------------------------------

  async function credentialConfirm(authed: Authed, actorId: string, credentialId: string, operation: 'rotate' | 'revoke', failure?: HostFailure, idempotencyKey?: string): Promise<ConsoleResponse> {
    const agent = await host.agent(authed.session.bearer, actorId);
    if (!agent.ok) return failurePage(authed, 'Credential', agent.failure);
    const credential = agent.body.credentials.find((entry) => entry.credentialId === credentialId);
    if (credential === undefined) return html(404, <ErrorPage title="No such credential for this agent" context={authed.context} csrfToken={authed.csrf} />);
    const rotate = operation === 'rotate';
    return html(
      failure === undefined ? 200 : statusForFailure(failure),
      <ConfirmPage
        context={authed.context}
        csrfToken={authed.csrf}
        title={rotate ? 'Rotate agent credential' : 'Revoke agent credential'}
        active="/agents"
        action={`/agents/${enc(actorId)}/credentials/${enc(credentialId)}/${operation}`}
        target={[
          ['Target type', 'agent credential'],
          ['Agent', <Id key="a" value={actorId} />],
          ['Credential', <Id key="c" value={credentialId} />],
          ['Current status', <Status key="s" value={credential.status} />],
          ['Agent actor status', <Status key="as" value={agent.body.status} />],
        ]}
        warning={rotate ? 'Rotation issues a new credential and revokes this one in the same Host transaction.' : 'Revoking this credential is terminal.'}
        consequences={
          rotate
            ? ['The current credential stops authenticating the agent immediately.', 'The new credential is shown exactly once, on the next page.', 'The agent’s authority is unchanged; only its credential changes.']
            : ['This credential stops authenticating the agent immediately and can never be re-activated.', 'The agent’s actor and authority are unchanged; issue a new credential to let it authenticate again.']
        }
        submitLabel={rotate ? 'Rotate credential' : 'Revoke credential'}
        hidden={rotate ? { idempotencyKey: idempotencyKey ?? newIdempotencyKey() } : {}}
        {...(rotate ? {} : { reason: { kind: 'text' as const, required: true } })}
        {...(failure !== undefined ? { failure } : {})}
        cancel={`/agents/${enc(actorId)}`}
      />,
    );
  }

  async function entityRevokeConfirm(authed: Authed, kind: EntityKind, entityId: string, failure?: HostFailure): Promise<ConsoleResponse> {
    const entity = await host.entity(authed.session.bearer, kind, entityId);
    if (!entity.ok) return failurePage(authed, 'Revoke authority', entity.failure);
    return html(
      failure === undefined ? 200 : statusForFailure(failure),
      <ConfirmPage
        context={authed.context}
        csrfToken={authed.csrf}
        title="Revoke authority"
        active="/authority"
        action={`/authority/entities/${enc(kind)}/${enc(entityId)}/revoke`}
        target={[
          ['Target type', ENTITY_KIND_LABELS[kind]],
          ['Target', <Id key="t" value={`${kind}:${entityId}`} />],
          ['Current status', <Status key="s" value={entity.body.status} />],
          ['Provisioned by', <Id key="p" value={entity.body.provisionedBy} />],
        ]}
        warning="Revocation is terminal. There is no un-revoke."
        consequences={[
          'The Kernel Authority records the revocation under your operator identity; it can never be undone.',
          kind === 'actor' ? 'A revoked actor is admitted nowhere, whatever its credentials say, and its id can never be re-onboarded.' : 'Authority under this record stops authorizing new decisions.',
          'Restoring capability later means provisioning new authority under a new id.',
        ]}
        submitLabel="Revoke authority"
        reason={{ kind: 'text', required: true }}
        {...(failure !== undefined ? { failure } : {})}
        cancel={`/authority/entities/${enc(kind)}/${enc(entityId)}`}
      />,
    );
  }

  async function grantRevokeConfirm(authed: Authed, grantId: string, failure?: HostFailure): Promise<ConsoleResponse> {
    const grant = await host.grant(authed.session.bearer, grantId);
    if (!grant.ok) return failurePage(authed, 'Revoke bounded grant', grant.failure);
    return html(
      failure === undefined ? 200 : statusForFailure(failure),
      <ConfirmPage
        context={authed.context}
        csrfToken={authed.csrf}
        title="Revoke bounded grant"
        active="/authority"
        action={`/authority/grants/${enc(grantId)}/revoke`}
        target={[
          ['Target type', 'bounded grant'],
          ['Grant', <Id key="g" value={grantId} />],
          ['Subject', <Id key="s" value={grant.body.subject} />],
          ['Current status', <Status key="st" value={grant.body.revocation === null ? grant.body.status.eligibility : 'revoked'} />],
        ]}
        warning="Revocation of a bounded grant is terminal and signed."
        consequences={['The grant can no longer be exercised; an execution not yet started under it is withheld.', 'There is no un-revoke. New authority comes only from a new governed decision.']}
        submitLabel="Revoke bounded grant"
        reason={{ kind: 'select', options: GRANT_REVOCATION_REASONS }}
        {...(failure !== undefined ? { failure } : {})}
        cancel={`/authority/grants/${enc(grantId)}`}
      />,
    );
  }

  function emergencyTarget(source: { get(name: string): string | null }): { readonly scope: string; readonly value?: string } {
    const scope = (source.get('scope') ?? '').trim();
    const value = (source.get('value') ?? '').trim();
    return value === '' ? { scope } : { scope, value };
  }

  function emergencyConfirm(authed: Authed, operation: 'activate' | 'release', target: { readonly scope: string; readonly value?: string }, failure?: HostFailure): ConsoleResponse {
    const release = operation === 'release';
    return html(
      failure === undefined ? 200 : statusForFailure(failure),
      <ConfirmPage
        context={authed.context}
        csrfToken={authed.csrf}
        title={release ? 'Release emergency control' : 'Declare emergency stop'}
        active="/"
        action={`/emergency/${operation}`}
        target={[
          ['Target type', 'emergency control'],
          ['Scope', <code key="s">{target.scope}</code>],
          ['Value', target.value === undefined ? '—' : <Id key="v" value={target.value} />],
        ]}
        warning={release ? 'Releasing a stop restores execution for everything it covered.' : 'An emergency stop withholds every matching governed action until it is released.'}
        consequences={release ? ['Matching governed actions become executable again under their authority.'] : ['Matching governed actions are withheld before any new authority is issued.', 'Releasing it requires the separate emergency.release permission.']}
        submitLabel={release ? 'Release emergency control' : 'Declare emergency stop'}
        hidden={target.value === undefined ? { scope: target.scope } : { scope: target.scope, value: target.value }}
        {...(failure !== undefined ? { failure } : {})}
        cancel="/emergency"
      />,
    );
  }

  async function profileConfirm(authed: Authed, profileId: string, version: string, operation: 'activate' | 'retire', failure?: HostFailure): Promise<ConsoleResponse> {
    const catalog = await host.profiles(authed.session.bearer);
    if (!catalog.ok) return failurePage(authed, 'Governance Profile', catalog.failure);
    const profile = catalog.body.profiles.find((entry) => entry.profileId === profileId && String(entry.version) === version);
    if (profile === undefined) return html(404, <ErrorPage title="No such Governance Profile version in the catalog" context={authed.context} csrfToken={authed.csrf} />);
    const activeVersion = catalog.body.profiles.find((entry) => entry.profileId === profileId && entry.state === 'active');
    const activate = operation === 'activate';
    return html(
      failure === undefined ? 200 : statusForFailure(failure),
      <ConfirmPage
        context={authed.context}
        csrfToken={authed.csrf}
        title={activate ? 'Activate Governance Profile' : 'Retire Governance Profile'}
        active="/profiles"
        action={`/profiles/${enc(profileId)}/${enc(version)}/${operation}`}
        target={[
          ['Target type', 'Governance Profile version'],
          ['Profile', <Id key="p" value={`${profile.profileId}@${profile.version}`} />],
          ['Content digest (compare-and-set)', <Id key="d" value={profile.digest} />],
          ['Current state', <Status key="s" value={profile.state} />],
          ['Currently active version', activeVersion === undefined ? 'none' : <Id key="a" value={`${activeVersion.profileId}@${activeVersion.version}`} />],
        ]}
        warning={
          activate
            ? 'Activation is a permitting governance operation. It is not harmless: a less-demanding version relaxes this profile’s requirements for future decisions.'
            : 'Retirement is terminal: a retired version is never activated again.'
        }
        consequences={
          activate
            ? [
                'Future decisions classified to this profile are governed by exactly the content with the digest above; activation is refused if the catalog content differs.',
                activeVersion !== undefined ? `Version ${activeVersion.version} is retired in the same transaction (superseded).` : 'No version of this profile is active now.',
                'Activation creates no actor, grant or other authority; Kernel standing authority and independent policy still bind.',
              ]
            : ['Classified requests this version governs are refused until another version is active.', 'Historical decisions stay bound to the version they recorded.']
        }
        submitLabel={activate ? 'Activate profile' : 'Retire profile'}
        hidden={{ digest: profile.digest }}
        reason={{ kind: 'text', required: false }}
        {...(failure !== undefined ? { failure } : {})}
        cancel="/profiles"
      />,
    );
  }

  // -- approvals (CTRL-04) ------------------------------------------------------------------

  /**
   * One verdict's confirmation page, always from a fresh Host read: the hidden
   * subject digest it renders is the subject it displays. After a refusal it
   * re-reads too, so a stale page is replaced by the current subject — and the
   * operator must review it again; the earlier intent is never re-applied.
   */
  async function approvalCommandPage(authed: Authed, approvalRequestId: string, verb: ApprovalVerb, failure?: HostFailure): Promise<ConsoleResponse> {
    const detail = await host.approval(authed.session.bearer, approvalRequestId);
    if (!detail.ok) return failurePage(authed, 'Approval request', failure ?? detail.failure);
    return html(failure === undefined ? 200 : statusForFailure(failure), <ApprovalCommandPage context={authed.context} csrfToken={authed.csrf} detail={detail.body} verb={verb} {...(failure !== undefined ? { failure } : {})} />);
  }

  async function approvalCommand(authed: Authed, approvalRequestId: string, verb: ApprovalVerb, form: FormFields): Promise<ConsoleResponse> {
    if (!confirmed(form)) return approvalCommandPage(authed, approvalRequestId, verb);
    const result = await host.approvalCommand(authed.session.bearer, approvalRequestId, verb, buildApprovalCommand(verb, form));
    if (!result.ok) return result.failure.kind === 'unauthenticated' ? failurePage(authed, 'Approval', result.failure) : approvalCommandPage(authed, approvalRequestId, verb, result.failure);
    // What the Host's approval engine re-read after recording the verdict — then the page below re-reads again.
    const { approval } = result.body;
    authed.session.flash =
      `Verdict '${verb}' recorded by the Host. Status (derived, re-read): ${approval.status}; quorum ${approval.quorum.countedApprovers.length} / ${approval.quorum.minimumApprovals}.` +
      (approval.status === 'approved' ? ' Approval quorum satisfied — the action has NOT been executed: the original requester must retry its governed action.' : '');
    return redirect(`/approvals/${enc(approvalRequestId)}`);
  }

  // -- routing -----------------------------------------------------------------------------

  function segments(pathname: string): readonly string[] {
    return pathname
      .split('/')
      .filter((part) => part.length > 0)
      .map((part) => decodeURIComponent(part));
  }

  async function route(req: IncomingMessage): Promise<ConsoleResponse> {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://console.invalid');
    const parts = segments(url.pathname);
    const query = url.searchParams;

    if (method === 'GET' && url.pathname === '/assets/console.css') return { status: 200, contentType: 'text/css; charset=utf-8', body: CONSOLE_CSS };
    if (method === 'GET' && url.pathname === '/login') {
      if (sessions.get(readCookie(req, SESSION_COOKIE)) !== undefined) return redirect('/');
      const reason = query.get('reason');
      return loginPage(200, reason === 'expired' ? { message: 'Your session ended. Sign in again.' } : reason === 'signed-out' ? { message: 'You are signed out.' } : {});
    }
    if (method === 'POST' && url.pathname === '/login') return login(req);
    if (method === 'POST' && url.pathname === '/logout') {
      if (!sameOrigin(req, publicOrigin)) return html(403, <ErrorPage title="Request refused: cross-origin" />);
      const session = sessions.get(readCookie(req, SESSION_COOKIE));
      if (session !== undefined) {
        const form = await readForm(req);
        if (!tokensEqual(form.text('csrf'), session.csrfToken)) return html(403, <ErrorPage title="Request refused: the form token is missing or stale" />);
        sessions.destroy(session.id);
      }
      return signedOut('signed-out');
    }

    if (method === 'GET') {
      const auth = await authenticate(req);
      if (!auth.ok) return auth.response;
      const authed = auth.authed;
      const { bearer } = authed.session;
      const [first, second, third, fourth, fifth] = parts;

      if (parts.length === 0) return overview(authed);
      if (first === 'agents' && parts.length === 1) {
        const agents = await host.listAgents(bearer);
        return agents.ok ? html(200, <AgentsPage context={authed.context} csrfToken={authed.csrf} agents={agents.body.agents} {...flashOf(authed.session)} />) : failurePage(authed, 'Agents', agents.failure);
      }
      if (first === 'agents' && second === 'new' && parts.length === 2) {
        return html(200, <AgentOnboardPage context={authed.context} csrfToken={authed.csrf} idempotencyKey={newIdempotencyKey()} values={authed.context.organization.trustDomainId !== null ? { trustDomainId: authed.context.organization.trustDomainId } : {}} errors={{}} />);
      }
      if (first === 'agents' && second !== undefined && parts.length === 2) return agentPage(authed, second);
      if (first === 'agents' && second !== undefined && third === 'credentials' && fourth !== undefined && (fifth === 'rotate' || fifth === 'revoke') && parts.length === 5) return credentialConfirm(authed, second, fourth, fifth);

      if (first === 'authority' && parts.length === 1) {
        const filter = { kind: query.get('kind') ?? '', status: query.get('status') ?? '' };
        const entities = await host.listEntities(bearer, { ...(filter.kind !== '' ? { kind: filter.kind } : {}), ...(filter.status !== '' ? { status: filter.status } : {}) });
        return entities.ok ? html(200, <AuthorityPage context={authed.context} csrfToken={authed.csrf} entities={entities.body.entities} filter={filter} {...flashOf(authed.session)} />) : failurePage(authed, 'Authority', entities.failure);
      }
      if (first === 'authority' && second === 'entities' && third !== undefined && isEntityKind(third) && fourth !== undefined && parts.length === 4) {
        const [entity, all] = await Promise.all([host.entity(bearer, third, fourth), host.listEntities(bearer)]);
        return entity.ok ? html(200, <EntityPage context={authed.context} csrfToken={authed.csrf} entity={entity.body} all={all.ok ? all.body.entities : all.failure} {...flashOf(authed.session)} />) : failurePage(authed, 'Authority', entity.failure);
      }
      if (first === 'authority' && second === 'entities' && third !== undefined && isEntityKind(third) && fourth !== undefined && fifth === 'revoke' && parts.length === 5) return entityRevokeConfirm(authed, third, fourth);
      if (first === 'authority' && second === 'new' && third !== undefined && isEntityKind(third) && parts.length === 3) return provisionForm(authed, third, query);
      if (first === 'authority' && second === 'grants' && parts.length === 2) {
        const grantId = (query.get('grantId') ?? '').trim();
        return redirect(grantId === '' ? '/authority' : `/authority/grants/${enc(grantId)}`);
      }
      if (first === 'authority' && second === 'grants' && third !== undefined && parts.length === 3) {
        const grant = await host.grant(bearer, third);
        return grant.ok ? html(200, <GrantPage context={authed.context} csrfToken={authed.csrf} grant={grant.body} {...flashOf(authed.session)} />) : failurePage(authed, 'Bounded grant', grant.failure);
      }
      if (first === 'authority' && second === 'grants' && third !== undefined && fourth === 'revoke' && parts.length === 4) return grantRevokeConfirm(authed, third);
      if (first === 'authority' && second === 'executions' && parts.length === 2) {
        const executionId = (query.get('executionId') ?? '').trim();
        return redirect(executionId === '' ? '/authority' : `/authority/executions/${enc(executionId)}`);
      }
      if (first === 'authority' && second === 'executions' && third !== undefined && parts.length === 3) {
        const execution = await host.execution(bearer, third);
        return execution.ok ? html(200, <ExecutionPage context={authed.context} csrfToken={authed.csrf} execution={execution.body} />) : failurePage(authed, 'Execution', execution.failure);
      }

      if (first === 'emergency' && parts.length === 1) {
        const controls = await host.emergencyControls(bearer);
        return controls.ok ? html(200, <EmergencyPage context={authed.context} csrfToken={authed.csrf} controls={controls.body} {...flashOf(authed.session)} />) : failurePage(authed, 'Emergency controls', controls.failure);
      }
      if (first === 'emergency' && (second === 'activate' || second === 'release') && parts.length === 2) return emergencyConfirm(authed, second, emergencyTarget(query));

      if (first === 'profiles' && parts.length === 1) {
        const catalog = await host.profiles(bearer);
        return catalog.ok ? html(200, <ProfilesPage context={authed.context} csrfToken={authed.csrf} catalog={catalog.body} {...flashOf(authed.session)} />) : failurePage(authed, 'Governance Profiles', catalog.failure);
      }
      if (first === 'profiles' && second !== undefined && third !== undefined && (fourth === 'activate' || fourth === 'retire') && parts.length === 4) return profileConfirm(authed, second, third, fourth);

      if (first === 'approvals' && parts.length === 1) {
        const view = query.get('view') ?? 'pending';
        if (!isApprovalView(view)) return html(400, <ErrorPage title="Unknown approval view" context={authed.context} csrfToken={authed.csrf} />);
        const inbox = await host.approvals(bearer, view);
        if (!inbox.ok && inbox.failure.kind === 'unauthenticated') return failurePage(authed, 'Approvals', inbox.failure);
        return html(inbox.ok ? 200 : statusForFailure(inbox.failure), <ApprovalsPage context={authed.context} csrfToken={authed.csrf} view={view} inbox={settle(inbox)} {...flashOf(authed.session)} />);
      }
      if (first === 'approvals' && second !== undefined && parts.length === 2) {
        const detail = await host.approval(bearer, second);
        return detail.ok ? html(200, <ApprovalPage context={authed.context} csrfToken={authed.csrf} detail={detail.body} {...flashOf(authed.session)} />) : failurePage(authed, 'Approval request', detail.failure);
      }
      if (first === 'approvals' && second !== undefined && third !== undefined && isApprovalVerb(third) && parts.length === 3) return approvalCommandPage(authed, second, third);

      if (first === 'attention' && parts.length === 1) return attentionPage(authed, query);
      if (first === 'executions' && parts.length === 1) return executionsPage(authed, query);
      if (first === 'traces' && parts.length === 1) {
        const requestId = (query.get('requestId') ?? '').trim();
        if (requestId === '') return html(200, <TraceIndexPage context={authed.context} csrfToken={authed.csrf} />);
        const level = query.get('level') ?? 'AUDITOR';
        return redirect(tracePath(requestId, isTraceLevel(level) ? level : 'AUDITOR'));
      }
      if (first === 'traces' && second !== undefined && parts.length === 2) return tracePage(authed, second, query);
      if (first === 'host-health' && parts.length === 1) return hostHealthPage(authed);
      if (first === 'activity' && parts.length === 1) return activity(authed, query);
      if (first === 'evidence' && parts.length === 1) return evidenceIndex(authed, query);
      if (first === 'evidence' && second === 'decisions' && third !== undefined && parts.length === 3) {
        const evidence = await host.decisionEvidence(bearer, third);
        return evidence.ok ? html(200, <EvidencePage context={authed.context} csrfToken={authed.csrf} evidence={evidence.body} />) : failurePage(authed, 'Decision evidence', evidence.failure);
      }
      return html(404, <ErrorPage title="Not found" context={authed.context} csrfToken={authed.csrf} />);
    }

    if (method === 'POST') {
      const auth = await authenticatedForm(req);
      if (!auth.ok) return auth.response;
      const { authed, form } = auth;
      const { bearer } = authed.session;
      const [first, second, third, fourth, fifth] = parts;

      if (first === 'agents' && parts.length === 1) return onboard(authed, form);
      if (first === 'agents' && second !== undefined && third === 'credentials' && parts.length === 3) {
        const idempotencyKey = form.text('idempotencyKey');
        if (idempotencyKey === '') return html(400, <ErrorPage title="The issuing form is incomplete" context={authed.context} csrfToken={authed.csrf} />);
        const issued = await host.issueCredential(bearer, second, idempotencyKey);
        if (!issued.ok) return issued.failure.kind === 'unauthenticated' ? failurePage(authed, 'Issue credential', issued.failure) : agentPage(authed, second, { failure: issued.failure, idempotencyKey });
        return html(200, <CredentialIssuedPage context={authed.context} csrfToken={authed.csrf} result={issued.body} rotated={false} />);
      }
      if (first === 'agents' && second !== undefined && third === 'credentials' && fourth !== undefined && fifth === 'rotate' && parts.length === 5) {
        const idempotencyKey = form.text('idempotencyKey');
        if (!confirmed(form) || idempotencyKey === '') return credentialConfirm(authed, second, fourth, 'rotate', undefined, idempotencyKey || undefined);
        const rotated = await host.rotateCredential(bearer, second, fourth, idempotencyKey);
        if (!rotated.ok) return rotated.failure.kind === 'unauthenticated' ? failurePage(authed, 'Rotate', rotated.failure) : credentialConfirm(authed, second, fourth, 'rotate', rotated.failure, idempotencyKey);
        return html(200, <CredentialIssuedPage context={authed.context} csrfToken={authed.csrf} result={rotated.body} rotated />);
      }
      if (first === 'agents' && second !== undefined && third === 'credentials' && fourth !== undefined && fifth === 'revoke' && parts.length === 5) {
        if (!confirmed(form)) return credentialConfirm(authed, second, fourth, 'revoke');
        const revoked = await host.revokeCredential(bearer, second, fourth, form.text('reason'));
        if (!revoked.ok) return revoked.failure.kind === 'unauthenticated' ? failurePage(authed, 'Revoke', revoked.failure) : credentialConfirm(authed, second, fourth, 'revoke', revoked.failure);
        authed.session.flash = `Credential ${revoked.body.credential.credentialId}: ${revoked.body.outcome}. The agent below was re-read from the Host.`;
        return redirect(`/agents/${enc(second)}`);
      }
      if (first === 'authority' && second === 'new' && third !== undefined && isEntityKind(third) && parts.length === 3) return provision(authed, third, form);
      if (first === 'authority' && second === 'entities' && third !== undefined && isEntityKind(third) && fourth !== undefined && fifth === 'revoke' && parts.length === 5) {
        if (!confirmed(form)) return entityRevokeConfirm(authed, third, fourth);
        const revoked = await host.revokeEntity(bearer, third, fourth, form.text('reason'));
        if (!revoked.ok) return revoked.failure.kind === 'unauthenticated' ? failurePage(authed, 'Revoke', revoked.failure) : entityRevokeConfirm(authed, third, fourth, revoked.failure);
        authed.session.flash = `${ENTITY_KIND_LABELS[third]} ${fourth}: ${revoked.body.outcome}. The canonical record was re-read from the Host below.`;
        return redirect(`/authority/entities/${enc(third)}/${enc(fourth)}`);
      }
      if (first === 'authority' && second === 'grants' && third !== undefined && fourth === 'revoke' && parts.length === 4) {
        if (!confirmed(form)) return grantRevokeConfirm(authed, third);
        const revoked = await host.revokeGrant(bearer, third, form.text('reason'));
        if (!revoked.ok) return revoked.failure.kind === 'unauthenticated' ? failurePage(authed, 'Revoke', revoked.failure) : grantRevokeConfirm(authed, third, revoked.failure);
        authed.session.flash = `Bounded grant ${revoked.body.grantId}: ${revoked.body.outcome}. The grant below was re-read from the Host.`;
        return redirect(`/authority/grants/${enc(third)}`);
      }
      if (first === 'emergency' && (second === 'activate' || second === 'release') && parts.length === 2) {
        const target = emergencyTarget({ get: (name: string) => (form.has(name) ? form.text(name) : null) });
        if (!confirmed(form)) return emergencyConfirm(authed, second, target);
        const result = second === 'activate' ? await host.activateEmergencyControl(bearer, target) : await host.releaseEmergencyControl(bearer, target);
        if (!result.ok) return result.failure.kind === 'unauthenticated' ? failurePage(authed, 'Emergency control', result.failure) : emergencyConfirm(authed, second, target, result.failure);
        authed.session.flash = `Emergency control ${result.body.control.scope}${result.body.control.value !== undefined ? `=${result.body.control.value}` : ''}: ${result.body.outcome}. Re-read from the Host below.`;
        return redirect('/emergency');
      }
      if (first === 'approvals' && second !== undefined && third !== undefined && isApprovalVerb(third) && parts.length === 3) return approvalCommand(authed, second, third, form);
      if (first === 'profiles' && second !== undefined && third !== undefined && (fourth === 'activate' || fourth === 'retire') && parts.length === 4) {
        if (!confirmed(form)) return profileConfirm(authed, second, third, fourth);
        const version = Number(third);
        if (!/^[1-9][0-9]{0,8}$/.test(third)) return html(400, <ErrorPage title="Invalid profile version" context={authed.context} csrfToken={authed.csrf} />);
        const reason = form.text('reason');
        const result = await host.transitionProfile(bearer, second, version, fourth, form.text('digest'), reason === '' ? undefined : reason);
        if (!result.ok) return result.failure.kind === 'unauthenticated' ? failurePage(authed, 'Governance Profile', result.failure) : profileConfirm(authed, second, third, fourth, result.failure);
        authed.session.flash = `Governance Profile ${result.body.profile.profileId}@${result.body.profile.version}: ${result.body.outcome}${result.body.superseded !== null ? ` (superseded ${result.body.superseded.profileId}@${result.body.superseded.version})` : ''}. Re-read from the Host below.`;
        return redirect('/profiles');
      }
      return html(404, <ErrorPage title="Not found" context={authed.context} csrfToken={authed.csrf} />);
    }

    return { status: 405, contentType: 'text/plain; charset=utf-8', body: 'Method not allowed.' };
  }

  return {
    async handle(req: IncomingMessage): Promise<ConsoleResponse> {
      try {
        return await route(req);
      } catch (error) {
        if (error instanceof ConsoleRequestError) return html(error.status, <ErrorPage title={error.message} />);
        if (error instanceof URIError) return html(400, <ErrorPage title="The request path is malformed." />);
        return html(500, <ErrorPage title="The console failed to handle this request." />);
      }
    },
  };
}
