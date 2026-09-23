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
      /** Canonical decimal text (`src/features/monetary-runtime`), never a number (P9). Declared only: no evaluator reads this constraint today. */
      readonly value: string;
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
