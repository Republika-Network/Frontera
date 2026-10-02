import type { FormFields } from './security.js';
import type { ApprovalCommandBody, ApprovalVerb } from './wire.js';

/**
 * CTRL-04 — the closed approval command form.
 *
 * A verdict form carries exactly: the `subjectDigest` of the subject the page
 * displayed (a hidden field rendered with that page — never re-read and
 * re-applied at submission), the evidence references the operator typed for
 * each required evidence type, and an optional note. It has no field for an
 * actor, approver, organization, role, state, quorum or proof: the Host
 * derives who acts, and CORE-05 derives everything else.
 *
 * Nothing here validates *whether* the command may succeed. A missing or
 * malformed evidence hash is forwarded as typed (an empty row is omitted), so
 * the Host — not the console — refuses it.
 */

/** Evidence rows the form renders: one per type the request's requirement snapshot names. Bounded by the Host's own limit. */
export const APPROVAL_EVIDENCE_MAX_ROWS = 32;

export function buildApprovalCommand(verb: ApprovalVerb, form: FormFields): ApprovalCommandBody {
  const subjectDigest = form.text('subjectDigest');
  const reason = form.text('reason');
  const evidence: { type: string; hash: string; uri?: string }[] = [];
  if (verb === 'approve') {
    for (let row = 0; row < APPROVAL_EVIDENCE_MAX_ROWS; row += 1) {
      const type = form.text(`evidence.${row}.type`);
      if (type === '') continue;
      const hash = form.text(`evidence.${row}.hash`);
      const uri = form.text(`evidence.${row}.uri`);
      if (hash === '' && uri === '') continue;
      evidence.push({ type, hash, ...(uri !== '' ? { uri } : {}) });
    }
  }
  return { subjectDigest, ...(evidence.length > 0 ? { evidence } : {}), ...(reason !== '' ? { reason } : {}) };
}
