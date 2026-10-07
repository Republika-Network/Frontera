import * as React from 'react';

import type { OrganizationContext } from '../wire.js';
import { CsrfField, Id } from './components.js';

export const NAVIGATION = [
  { path: '/', label: 'Overview' },
  { path: '/agents', label: 'Agents' },
  { path: '/authority', label: 'Authority' },
  { path: '/approvals', label: 'Approvals' },
  { path: '/attention', label: 'Attention' },
  { path: '/executions', label: 'Executions' },
  { path: '/activity', label: 'Activity' },
  { path: '/evidence', label: 'Evidence' },
  { path: '/traces', label: 'Trace' },
  { path: '/host-health', label: 'Host Health' },
  { path: '/profiles', label: 'Governance Profiles' },
] as const;

/**
 * Whether the Host reported this permission for the signed-in operator.
 *
 * **UX only.** It decides which controls are shown; the Host decides — on every
 * request, again — whether an operation is allowed. A hidden control is never
 * evidence that an operation is refused, and a shown one never that it is
 * permitted. There is no role table in the console: the permission list is the
 * Host's own answer to `GET /api/admin/organization`.
 */
export function may(context: OrganizationContext, permission: string): boolean {
  return context.operator.permissions.includes(permission);
}

export interface PageProps {
  readonly title: string;
  readonly context?: OrganizationContext;
  readonly csrfToken?: string;
  readonly active?: string;
  readonly flash?: string;
  readonly children: React.ReactNode;
}

export function Page({ title, context, csrfToken, active, flash, children }: PageProps): React.ReactElement {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="referrer" content="same-origin" />
        <title>{`${title} — Frontera Control Plane`}</title>
        <link rel="stylesheet" href="/assets/console.css" />
      </head>
      <body>
        <header className="topbar">
          <a className="brand" href="/">
            Frontera <span className="brand__product">Control Plane</span>
          </a>
          {context !== undefined ? (
            <div className="context" aria-label="Control context">
              <span>
                Organization <Id value={context.organization.organizationId} />
              </span>
              {context.organization.trustDomainId !== null ? (
                <span>
                  Trust domain <Id value={context.organization.trustDomainId} />
                </span>
              ) : null}
              <span>
                Operator <Id value={context.operator.operatorId} /> <span className="role">({context.operator.role})</span>
              </span>
              {csrfToken !== undefined ? (
                <form method="post" action="/logout" className="inline-form">
                  <CsrfField token={csrfToken} />
                  <button type="submit" className="button button--quiet">
                    Sign out
                  </button>
                </form>
              ) : null}
            </div>
          ) : null}
        </header>
        {context !== undefined ? (
          <nav className="nav" aria-label="Sections">
            <ul>
              {NAVIGATION.map((item) => (
                <li key={item.path}>
                  <a href={item.path} aria-current={active === item.path ? 'page' : undefined} className={active === item.path ? 'nav__item nav__item--active' : 'nav__item'}>
                    {item.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        ) : null}
        <main className="main">
          <h1>{title}</h1>
          {flash !== undefined ? (
            <p className="flash" role="status">
              {flash}
            </p>
          ) : null}
          {children}
        </main>
        <footer className="footer">
          <p>
            Every value on this page was read from the Frontera Host over its operator API when the page was rendered. The console holds no authority: the Host authorizes every operation again.
          </p>
        </footer>
      </body>
    </html>
  );
}
