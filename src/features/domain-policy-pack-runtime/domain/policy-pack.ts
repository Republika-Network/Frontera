import type { PolicyPackVersion } from './policy-pack-version.js';

export type PolicyPackStatus = 'draft' | 'active' | 'deprecated' | 'revoked' | 'superseded';

export type PolicyPackKind =
  | 'domain'
  | 'jurisdiction'
  | 'industry'
  | 'customer'
  | 'contract'
  | 'data_boundary'
  | 'risk'
  | 'demo';

export type PolicyPackDomain =
  | 'payments'
  | 'procurement'
  | 'sports_event_settlement'
  | 'healthcare_data'
  | 'financial_approval'
  | 'data_boundary'
  | 'general_enterprise'
  | 'legal'
  | 'demo';

export interface PolicyPack {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly kind: PolicyPackKind;
  readonly domain: PolicyPackDomain;
  readonly status: PolicyPackStatus;
  readonly currentVersionId: string;
  readonly versions: readonly PolicyPackVersion[];
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** NB-008: the trusted writer that registered this pack. */
  readonly registeredBy?: string;
  /** NB-008: the trusted writer behind this pack's latest change. */
  readonly lastWrittenBy?: string;
}
