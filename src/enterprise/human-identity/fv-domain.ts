import { createHash } from 'node:crypto';

import { canonicalJson, type HumanIdentityJson, type StoredHumanIdentityRow } from './chain.js';
import { FV_ADMINISTRATOR_ROLE, FV_FIRST_ADMINISTRATOR_RECORDER } from './first-administrator.js';

/**
 * FV-P4C-2B3C-2A2B — the FV identity domain's roles, read **only** from signed, chained rows. A leaf: pure
 * reading of a verified history.
 *
 * - **`fv-administrator`.** A `principal_created` row whose payload says `role: 'fv-administrator'`, recorded by the
 *   first-administrator ceremony, **at sequence 1**. AUTH-03's first-administrator rule appends that row only into a
 *   store holding no row at all, so there is at most one, and nothing later can claim the role.
 * - **`fv-operator`.** A `principal_created` row with `role: 'fv-operator'`, recorded by the operator-enrolment
 *   ceremony, **immediately after** the authorizing `credential_used` row of the FV administrator's credential, whose
 *   stored contract recomputes to the commitment both rows name and names exactly this principal (review M1: the row
 *   alone is not enough). That structure is what AUTH-03 appends under a verified assertion (`fv-operator.ts`); the
 *   assertion itself is re-checked from the store by `verifyFvOperatorRoles` there.
 * - **Anything else** carries no FV role: a principal a Host administrator created, a display name, a position,
 *   a payload field written by another recorder.
 *
 * Roles grant nothing beyond FV identity administration: an administrator may authorize operators; neither role
 * authorizes a document action, a bootstrap decision's verdict or anything in CORE-05.
 */

export const FV_OPERATOR_ROLE = 'fv-operator';
export const FV_OPERATOR_RECORDER = 'fv-operator-enrollment-ceremony';
export type FvRole = typeof FV_ADMINISTRATOR_ROLE | typeof FV_OPERATOR_ROLE;

function payloadOf(row: StoredHumanIdentityRow): Record<string, unknown> {
  try {
    const payload = JSON.parse(row.payload) as unknown;
    return typeof payload === 'object' && payload !== null && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Whether `previous` is the FV administrator's authorizing row for exactly the operator `row` creates. */
function authorizedBy(row: StoredHumanIdentityRow, previous: StoredHumanIdentityRow | undefined, roles: ReadonlyMap<string, FvRole>): boolean {
  if (previous === undefined || previous.kind !== 'credential_used' || previous.recordedBy !== FV_OPERATOR_RECORDER || previous.sequence !== row.sequence - 1) return false;
  const created = payloadOf(row);
  const used = payloadOf(previous);
  const authorization = used['authorization'];
  if (typeof authorization !== 'object' || authorization === null || Array.isArray(authorization)) return false;
  const contract = authorization as Record<string, unknown>;
  const candidate = contract['candidate'] as Record<string, unknown> | undefined;
  const administrator = contract['administrator'] as Record<string, unknown> | undefined;
  const commitment = `sha256:${createHash('sha256').update(canonicalJson(contract as HumanIdentityJson), 'utf8').digest('hex')}`;
  return (
    roles.get(previous.operatorId) === FV_ADMINISTRATOR_ROLE &&
    created['authorizedBy'] === previous.operatorId &&
    created['authorizationCommitment'] === commitment &&
    used['authorizationCommitment'] === commitment &&
    candidate?.['operatorId'] === row.operatorId &&
    administrator?.['operatorId'] === previous.operatorId &&
    administrator?.['credentialId'] === previous.objectId &&
    contract['role'] === FV_OPERATOR_ROLE
  );
}

/** The FV role of the principal `history[index]` creates, by the rules above, given the roles before it; `undefined` for none. */
function roleAt(history: readonly StoredHumanIdentityRow[], index: number, roles: ReadonlyMap<string, FvRole>): FvRole | undefined {
  const row = history[index];
  if (row === undefined || row.kind !== 'principal_created') return undefined;
  const role = payloadOf(row)['role'];
  if (role === FV_ADMINISTRATOR_ROLE && row.recordedBy === FV_FIRST_ADMINISTRATOR_RECORDER && row.sequence === 1) return FV_ADMINISTRATOR_ROLE;
  if (role === FV_OPERATOR_ROLE && row.recordedBy === FV_OPERATOR_RECORDER && authorizedBy(row, history[index - 1], roles)) return FV_OPERATOR_ROLE;
  return undefined;
}

/** Every FV role in a verified history, by operator id. */
export function fvRolesOf(history: readonly StoredHumanIdentityRow[]): ReadonlyMap<string, FvRole> {
  const roles = new Map<string, FvRole>();
  for (const [index, row] of history.entries()) {
    const role = roleAt(history, index, roles);
    if (role !== undefined && !roles.has(row.operatorId)) roles.set(row.operatorId, role);
  }
  return roles;
}

/**
 * FV-P4C-2B3C-2A2B (Codex P2 on PR #267; fix-commit review F1/F2) — whether a verified history ends in an unfinished FV
 * operator plan: its last plan start (an operator-ceremony `credential_used` row whose stored contract recomputes to
 * the commitment it names; a garbage row is no plan start) is not followed by that plan's three other rows, for the
 * contract's candidate. While one is unfinished, nothing else may be appended to the FV store (AUTH-02's writes and
 * any new enrolment are refused), so it stays the history's suffix and its resume can always complete it.
 */
export function fvOperatorPlanUnfinished(history: readonly StoredHumanIdentityRow[]): boolean {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const row = history[index]!;
    if (row.kind !== 'credential_used' || row.recordedBy !== FV_OPERATOR_RECORDER) continue;
    const used = payloadOf(row);
    const contract = used['authorization'];
    if (typeof contract !== 'object' || contract === null || Array.isArray(contract)) continue;
    const commitment = `sha256:${createHash('sha256').update(canonicalJson(contract as HumanIdentityJson), 'utf8').digest('hex')}`;
    if (used['authorizationCommitment'] !== commitment) continue;
    const candidate = ((contract as Record<string, unknown>)['candidate'] as Record<string, unknown> | undefined)?.['operatorId'];
    const rest = history.slice(index + 1, index + 4);
    const kinds = ['principal_created', 'enrolment_authorized', 'credential_registered'];
    return !(rest.length === 3 && rest.every((r, i) => r.kind === kinds[i] && r.recordedBy === FV_OPERATOR_RECORDER && r.operatorId === candidate));
  }
  return false;
}

/**
 * Whether a verified history is an FV identity store's: its first row is the FV administrator's. Durable and signed
 * (the head covers it), unlike how a file happens to be opened. Together with the exclusive (FV) owner's handle, it
 * is what AUTH-02's general administration refuses (`HUMAN_IDENTITY_FV_ADMINISTRATION_REFUSED`).
 */
export function fvOwnedHistory(history: readonly StoredHumanIdentityRow[]): boolean {
  return roleAt(history, 0, new Map()) === FV_ADMINISTRATOR_ROLE;
}
