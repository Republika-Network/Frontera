export type AuthorityConstraint =
  | {
      readonly type: 'resource_scope';
      readonly allowedScopes: readonly string[];
    }
  | {
      readonly type: 'prohibited_action';
      readonly actions: readonly string[];
    }
  | {
      readonly type: 'max_amount';
      readonly currency: string;
      /**
       * Canonical decimal text (`src/features/monetary-runtime`), never a number (P9).
       *
       * P10: the **per-execution monetary ceiling** of the authority it is
       * attached to, enforced for host-classified financial actions by the
       * Enterprise financial-authority resolver
       * (`src/enterprise/kernel-authority/financial-authority-resolver.ts`).
       * Every `max_amount` on a lineage applies; the narrowest wins.
       */
      readonly value: string;
    }
  | {
      /**
       * P10: a durable **aggregate** spending limit — how much capacity may be
       * consumed across executions under this authority, in exactly one asset.
       *
       * This is authority *definition* only. Consumption lives in the P7
       * exercise-control ledger, keyed to this constraint's identity
       * (`limitId`, `currency`, and the authority record that carries it) —
       * never on this record, which never carries a spent or remaining amount.
       */
      readonly type: 'spending_limit';
      readonly limitId: string;
      readonly currency: string;
      /** Canonical decimal text. */
      readonly maximum: string;
      readonly window: { readonly kind: 'lifetime' } | { readonly kind: 'rolling'; readonly seconds: number };
    }
  | {
      readonly type: 'time_window';
      readonly startsAt?: string;
      readonly endsAt?: string;
    }
  | {
      readonly type: 'data_boundary';
      readonly allowedDataDomains: readonly string[];
      readonly prohibitedDataDomains: readonly string[];
    }
  | {
      readonly type: 'human_approval_required';
      readonly actions: readonly string[];
    };

export type AuthorityGrantStatus = 'active' | 'expired' | 'suspended' | 'revoked';

export type AuthorityActorType = 'human' | 'organization' | 'agent' | 'system';

/**
 * AuthorityGrant represents direct authority, e.g. Datasys grants Victor
 * Project Manager authority for project:HMP-14665.
 */
export interface AuthorityGrant {
  readonly id: string;

  readonly issuerActorId: string;
  readonly subjectActorId: string;
  readonly trustDomainId: string;

  readonly roleId?: string;

  readonly capability: string;
  readonly actions: readonly string[];
  readonly resourceScopes: readonly string[];

  readonly canDelegate: boolean;
  readonly allowedDelegateActorTypes?: readonly AuthorityActorType[];
  readonly maxDelegationDepth?: number;
  readonly nonDelegableActions?: readonly string[];

  readonly constraints?: readonly AuthorityConstraint[];

  readonly status: AuthorityGrantStatus;
  readonly issuedAt: string;
  readonly expiresAt?: string;

  readonly parentGrantId?: string;

  readonly metadata?: Readonly<Record<string, unknown>>;
}
