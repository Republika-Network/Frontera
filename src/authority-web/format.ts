import type { DecisionState } from './contracts.js';
import type { Tone } from './controller.js';

/**
 * AUTH-04C — deterministic, locale-independent presentation helpers.
 * Timestamps are shown in UTC with the exact ISO value in `datetime`, so what
 * a reviewer sees never depends on the device's locale or time zone setting.
 */

export function utc(iso: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;
  const date = new Date(time);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${String(date.getUTCFullYear())}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}

/** "in 14 min", "in 2 h 5 min", "passed" — relative to `nowMs`. */
export function remaining(iso: string, nowMs: number): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return '';
  const minutes = Math.floor((time - nowMs) / 60_000);
  if (minutes < 0) return 'passed';
  if (minutes < 1) return 'in under a minute';
  if (minutes < 60) return `in ${String(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  return `in ${String(hours)} h ${String(minutes % 60)} min`;
}

/** A digest split into groups of 8 hex characters, so a long value wraps readably and can be compared by eye. */
export function grouped(digest: string): string {
  const split = digest.indexOf(':') + 1;
  const prefix = digest.slice(0, split);
  const hex = digest.slice(split);
  return `${prefix}${(hex.match(/.{1,8}/g) ?? [hex]).join(' ')}`;
}

export const DECISION_LABELS: Readonly<Record<DecisionState, { readonly label: string; readonly tone: Tone; readonly detail: string }>> = {
  challenge_open: { label: 'Awaiting passkey confirmation', tone: 'info', detail: 'The decision was prepared but not yet confirmed with your passkey. Nothing has been recorded.' },
  challenge_expired: { label: 'Expired — not recorded', tone: 'warning', detail: 'The decision window closed before confirmation. No decision was recorded.' },
  approved: { label: 'Approval recorded', tone: 'success', detail: 'Frontera Authority recorded your approval for this exact request.' },
  rejected: { label: 'Rejection recorded', tone: 'success', detail: 'Frontera Authority recorded your rejection for this exact request.' },
  refused: { label: 'Not recorded — refused by policy', tone: 'error', detail: 'Your passkey was verified, but Frontera Authority did not accept the decision (for example, your approval standing changed). It counts for nothing.' },
  abandoned: { label: 'Not recorded — interrupted', tone: 'warning', detail: 'The decision was interrupted before it could be recorded. It will never be recorded later. Start a new decision if the request is still pending.' },
  unsettled: { label: 'Being confirmed', tone: 'info', detail: 'Frontera Authority is still settling this decision. Check again shortly. Nothing will be sent twice.' },
  unknown: { label: 'Status unknown', tone: 'warning', detail: 'The status could not be determined. Check again shortly.' },
};

export const REQUEST_STATUS_LABELS: Readonly<Record<string, string>> = {
  pending: 'Pending',
  approved: 'Approved',
  rejected: 'Rejected',
  revoked: 'Revoked',
  'request-expired': 'Request expired',
  'approval-expired': 'Approval expired',
};

export const VERDICT_LABELS: Readonly<Record<'approve' | 'reject', string>> = { approve: 'Approve', reject: 'Reject' };
