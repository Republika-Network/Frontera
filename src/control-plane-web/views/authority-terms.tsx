import * as React from 'react';

import type { EntityView } from '../wire.js';
import { Empty, Id, KeyValues, List, Status, Text, Time } from './components.js';

/**
 * CTRL-03 — how standing authority is shown: the entity's recorded terms,
 * grouped, without reinterpretation.
 *
 * - **Scope**: subject, capability, actions, resource scopes.
 * - **Delegation scope**: whether and to whom it may be delegated, depth, exclusions.
 * - **Monetary limits** (P10): exactly the `max_amount` / `spending_limit` records.
 * - **Typed parameter bounds** (CORE-03): dimension, type, bound, value — generic;
 *   no dimension is given domain meaning here.
 *
 * Any recorded term this view does not group is listed under "Other recorded
 * terms", so nothing the Host returned is hidden.
 */

const SCOPE_KEYS = ['subjectActorId', 'delegateActorId', 'delegatorActorId', 'principalActorId', 'issuerActorId', 'sourceAuthorityGrantId', 'parentGrantId', 'capability', 'actions', 'resourceScopes', 'roleId'];
const DELEGATION_KEYS = ['canDelegate', 'canRedelegate', 'delegable', 'allowedDelegateActorTypes', 'delegateActorType', 'maxDelegationDepth', 'nonDelegableActions', 'prohibitedActions'];
const LIMIT_KEYS = ['constraints', 'parameterBounds'];

const asStrings = (value: unknown): readonly string[] | undefined => (Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? (value as string[]) : undefined);

function TermValue({ value }: { readonly value: unknown }): React.ReactElement {
  if (value === undefined || value === null) return <span className="muted">—</span>;
  if (typeof value === 'boolean') return <>{value ? 'yes' : 'no'}</>;
  if (typeof value === 'number') return <>{String(value)}</>;
  if (typeof value === 'string') return <Id value={value} />;
  const strings = asStrings(value);
  if (strings !== undefined) return <List values={strings} />;
  return <code className="json">{JSON.stringify(value)}</code>;
}

const LABELS: Readonly<Record<string, string>> = {
  subjectActorId: 'Subject',
  delegateActorId: 'Delegate (subject)',
  delegatorActorId: 'Delegator',
  principalActorId: 'Principal',
  issuerActorId: 'Issuer',
  sourceAuthorityGrantId: 'Source grant (parent)',
  parentGrantId: 'Parent grant',
  capability: 'Capability',
  actions: 'Action scope',
  resourceScopes: 'Resource scope',
  roleId: 'Role',
  canDelegate: 'May delegate',
  canRedelegate: 'May re-delegate',
  delegable: 'Delegable',
  allowedDelegateActorTypes: 'Delegate actor types',
  delegateActorType: 'Delegate actor type',
  maxDelegationDepth: 'Maximum delegation depth',
  nonDelegableActions: 'Non-delegable actions',
  prohibitedActions: 'Prohibited actions',
};

function rowsFor(terms: Readonly<Record<string, unknown>>, keys: readonly string[]): (readonly [string, React.ReactNode])[] {
  return keys.filter((key) => terms[key] !== undefined).map((key) => [LABELS[key] ?? key, <TermValue key={key} value={terms[key]} />] as const);
}

interface ParameterBoundRecord {
  readonly dimension?: unknown;
  readonly kind?: unknown;
  readonly type?: unknown;
  readonly value?: unknown;
  readonly limit?: unknown;
}

/** Typed parameter bounds: one row per bound, exactly as recorded. */
export function ParameterBoundsTable({ bounds, caption }: { readonly bounds: readonly ParameterBoundRecord[]; readonly caption?: string }): React.ReactElement {
  if (bounds.length === 0) return <Empty message="No typed parameter bounds are recorded on this authority." />;
  return (
    <table className="table" data-testid="parameter-bounds">
      {caption !== undefined ? <caption>{caption}</caption> : null}
      <thead>
        <tr>
          <th scope="col">Dimension</th>
          <th scope="col">Type</th>
          <th scope="col">Bound</th>
          <th scope="col">Value</th>
        </tr>
      </thead>
      <tbody>
        {bounds.map((bound, index) => {
          const kind = String(bound.kind ?? '');
          const shown = kind === 'maximum' ? bound.limit : bound.value;
          return (
            <tr key={`${String(bound.dimension)}-${index}`} data-dimension={String(bound.dimension ?? '')}>
              <td>
                <Id value={String(bound.dimension ?? '')} />
              </td>
              <td>{String(bound.type ?? '')}</td>
              <td>{kind === 'maximum' ? 'maximum (inclusive)' : kind === 'exact' ? 'exactly' : kind}</td>
              <td>
                <code className="bound-value">{shown === undefined ? 'not recorded' : String(shown)}</code>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

interface MonetaryRecord {
  readonly type?: unknown;
  readonly currency?: unknown;
  readonly value?: unknown;
  readonly limitId?: unknown;
  readonly maximum?: unknown;
  readonly window?: { readonly kind?: unknown; readonly seconds?: unknown };
}

export function MonetaryLimitsTable({ constraints }: { readonly constraints: readonly MonetaryRecord[] }): React.ReactElement {
  if (constraints.length === 0) return <Empty message="No monetary limits are recorded on this authority." />;
  return (
    <table className="table" data-testid="monetary-limits">
      <thead>
        <tr>
          <th scope="col">Limit</th>
          <th scope="col">Asset</th>
          <th scope="col">Amount</th>
          <th scope="col">Window</th>
        </tr>
      </thead>
      <tbody>
        {constraints.map((constraint, index) => (
          <tr key={index}>
            <td>{constraint.type === 'max_amount' ? 'per execution (max_amount)' : constraint.type === 'spending_limit' ? `aggregate (spending_limit ${String(constraint.limitId ?? '')})` : String(constraint.type ?? '')}</td>
            <td>
              <Id value={String(constraint.currency ?? '')} />
            </td>
            <td>
              <code>{String(constraint.type === 'max_amount' ? constraint.value : constraint.maximum)}</code>
            </td>
            <td>{constraint.window === undefined ? '—' : constraint.window.kind === 'rolling' ? `rolling ${String(constraint.window.seconds)} s` : String(constraint.window.kind ?? '')}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function boundsOf(terms: Readonly<Record<string, unknown>>): readonly ParameterBoundRecord[] {
  return Array.isArray(terms['parameterBounds']) ? (terms['parameterBounds'] as ParameterBoundRecord[]) : [];
}

export function constraintsOf(terms: Readonly<Record<string, unknown>>): readonly MonetaryRecord[] {
  return Array.isArray(terms['constraints']) ? (terms['constraints'] as MonetaryRecord[]) : [];
}

/** The full, grouped view of one entity's recorded terms and lifecycle. */
export function EntityTerms({ entity }: { readonly entity: EntityView }): React.ReactElement {
  const terms = entity.terms;
  const grouped = new Set([...SCOPE_KEYS, ...DELEGATION_KEYS, ...LIMIT_KEYS]);
  const other = Object.keys(terms).filter((key) => !grouped.has(key));
  const scope = rowsFor(terms, SCOPE_KEYS);
  const delegation = rowsFor(terms, DELEGATION_KEYS);
  const bounded = entity.entityKind === 'authority-grant' || entity.entityKind === 'delegation-grant';
  return (
    <div className="entity-terms">
      <KeyValues
        rows={[
          ['Kind', <Id key="k" value={entity.entityKind} />],
          ['Id', <Id key="i" value={entity.entityId} />],
          ['Status', <Status key="s" value={entity.status} />],
          ['Trust domain', <Text key="t" value={entity.trustDomainId} />],
          ['Provisioned by', <Id key="pb" value={entity.provisionedBy} />],
          ['Provisioned at', <Time key="pa" value={entity.provisionedAt} />],
          ['Revoked by', <Text key="rb" value={entity.revokedBy} />],
          ['Revoked at', <Time key="ra" value={entity.revokedAt} />],
          ['Revocation reason', <Text key="rr" value={entity.revocationReason} />],
          ['Audit-chain events', String(entity.sequence)],
        ]}
      />
      {scope.length > 0 ? (
        <>
          <h3>Scope</h3>
          <KeyValues rows={scope} />
        </>
      ) : null}
      {delegation.length > 0 ? (
        <>
          <h3>Delegation scope</h3>
          <KeyValues rows={delegation} />
        </>
      ) : null}
      {bounded ? (
        <>
          <h3>Monetary limits</h3>
          <MonetaryLimitsTable constraints={constraintsOf(terms)} />
          <h3>Typed parameter bounds</h3>
          <ParameterBoundsTable bounds={boundsOf(terms)} />
        </>
      ) : null}
      {other.length > 0 ? (
        <>
          <h3>Other recorded terms</h3>
          <KeyValues rows={other.map((key) => [key, <TermValue key={key} value={terms[key]} />] as const)} />
        </>
      ) : null}
    </div>
  );
}

/**
 * The upstream lineage of a grant or delegation, as recorded: this record,
 * then its parent or source, then theirs. Every hop's bounds apply at
 * decision; this view lists each hop and computes no "effective" value.
 */
export function lineageOf(start: EntityView, all: readonly EntityView[]): readonly EntityView[] {
  const chain: EntityView[] = [start];
  let current: EntityView | undefined = start;
  const seen = new Set<string>([`${start.entityKind}:${start.entityId}`]);
  while (current !== undefined && chain.length < 16) {
    const terms: Readonly<Record<string, unknown>> = current.terms;
    const parentId: unknown = current.entityKind === 'authority-grant' ? terms['parentGrantId'] : terms['sourceAuthorityGrantId'];
    if (typeof parentId !== 'string') break;
    const parent: EntityView | undefined =
      all.find((entity) => entity.entityKind === 'authority-grant' && entity.entityId === parentId) ?? all.find((entity) => entity.entityKind === 'delegation-grant' && entity.entityId === parentId);
    if (parent === undefined || seen.has(`${parent.entityKind}:${parent.entityId}`)) break;
    seen.add(`${parent.entityKind}:${parent.entityId}`);
    chain.push(parent);
    current = parent;
  }
  return chain;
}

export function LineageTable({ chain }: { readonly chain: readonly EntityView[] }): React.ReactElement {
  return (
    <table className="table" data-testid="lineage">
      <caption>Every hop’s limits apply at decision. The console lists each hop; it does not compute a combined limit.</caption>
      <thead>
        <tr>
          <th scope="col">Hop</th>
          <th scope="col">Record</th>
          <th scope="col">Status</th>
          <th scope="col">Actions × resources</th>
          <th scope="col">Typed parameter bounds</th>
          <th scope="col">Monetary limits</th>
        </tr>
      </thead>
      <tbody>
        {chain.map((hop, index) => (
          <tr key={`${hop.entityKind}:${hop.entityId}`}>
            <td>{index === 0 ? 'this record' : `upstream ${index}`}</td>
            <td>
              <a href={`/authority/entities/${encodeURIComponent(hop.entityKind)}/${encodeURIComponent(hop.entityId)}`}>
                {hop.entityKind}:{hop.entityId}
              </a>
            </td>
            <td>
              <Status value={hop.status} />
            </td>
            <td>
              <List values={asStrings(hop.terms['actions'])} /> × <List values={asStrings(hop.terms['resourceScopes'])} />
            </td>
            <td>
              {boundsOf(hop.terms).length === 0
                ? 'none'
                : boundsOf(hop.terms)
                    .map((bound) => `${String(bound.dimension)} ${bound.kind === 'maximum' ? '≤' : '='} ${String(bound.kind === 'maximum' ? bound.limit : bound.value)}`)
                    .join('; ')}
            </td>
            <td>{constraintsOf(hop.terms).length === 0 ? 'none' : `${constraintsOf(hop.terms).length} recorded`}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
