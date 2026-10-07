import { createHash } from 'node:crypto';

/**
 * LAND-02 — the durable evidence that authority issuance was evaluated and
 * **withheld** for a committed decision. Pure: grammar, digest and parse only.
 *
 * The issuance stage decides (an allowed Kernel decision can still end in no
 * grant: the emergency-control admission, authority binding, financial
 * authority — e.g. the per-execution ceiling — parameter authority, the
 * commit-boundary emergency check, or the grant layer, obligations included).
 * The orchestrator persists **that already-made result**, through
 * the execution ledger, at the exact point it is returned; the ASSURE-01 trace
 * rebuilds the authority stage from the row and verifies its linkage. Nothing
 * here or in the trace re-decides whether the ceiling was exceeded.
 *
 * One `issuance_record` reference row on the decision's own evaluation:
 *
 * | field | value |
 * | --- | --- |
 * | `externalId` | the governed request id (request linkage) |
 * | `externalVersion` | `withheld:<layer>:<CODE,CODE…>` |
 * | `uri` | `urn:aoc:issuance-record:v1;decision=<decisionId>[;requested=<unit>:<value>][;ceiling=<unit>:<value>]` |
 * | `digest` | `sha256:` over the canonical form of every field above |
 *
 * Evidence, never authority: nothing reads it to decide anything.
 */

export interface IssuanceWithheldEvidence {
  readonly requestId: string;
  readonly decisionId: string;
  /** The governed-action withholding layer (`authority-binding`, `emergency-control`, `grant`, `obligations`). */
  readonly withheldBy: string;
  readonly reasonCodes: readonly string[];
  /** The requested amount, exactly as the committed request states it — never re-derived. */
  readonly requested?: { readonly value: string; readonly unit: string };
  /** The authority ceiling the issuance core measured, when the financial layer reports one. */
  readonly ceiling?: { readonly value: string; readonly unit: string };
}

const TOKEN = /^[A-Za-z0-9._:-]{1,200}$/;
const CODE = /^[A-Z0-9_]{1,120}$/;
const LAYER = /^[a-z-]{1,40}$/;
const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/;
const UNIT = /^[A-Za-z0-9:./-]{1,80}$/;

function money(value: { readonly value: string; readonly unit: string } | undefined): string | undefined {
  return value === undefined ? undefined : `${value.unit}:${value.value}`;
}

/** The digest over every field, in a fixed order, so no field can change without the digest changing. */
export function issuanceWithheldDigest(evidence: IssuanceWithheldEvidence): string {
  const canonical = JSON.stringify([
    'aoc.issuance-record.v1',
    evidence.requestId,
    evidence.decisionId,
    evidence.withheldBy,
    [...evidence.reasonCodes],
    money(evidence.requested) ?? null,
    money(evidence.ceiling) ?? null,
  ]);
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

export function issuanceWithheldVersion(evidence: Pick<IssuanceWithheldEvidence, 'withheldBy' | 'reasonCodes'>): string {
  return `withheld:${evidence.withheldBy}:${evidence.reasonCodes.join(',')}`;
}

export function issuanceWithheldUri(evidence: IssuanceWithheldEvidence): string {
  const requested = money(evidence.requested);
  const ceiling = money(evidence.ceiling);
  return `urn:aoc:issuance-record:v1;decision=${evidence.decisionId}${requested !== undefined ? `;requested=${requested}` : ''}${ceiling !== undefined ? `;ceiling=${ceiling}` : ''}`;
}

/** True when the evidence can be written in the row grammar (well-formed identifiers, codes and amounts). */
export function isWellFormedIssuanceWithheldEvidence(evidence: IssuanceWithheldEvidence): boolean {
  const amountOk = (amount: IssuanceWithheldEvidence['requested']) => amount === undefined || (DECIMAL.test(amount.value) && UNIT.test(amount.unit) && !amount.unit.includes(';'));
  return (
    TOKEN.test(evidence.requestId) &&
    TOKEN.test(evidence.decisionId) &&
    LAYER.test(evidence.withheldBy) &&
    evidence.reasonCodes.length > 0 &&
    evidence.reasonCodes.every((code) => CODE.test(code)) &&
    amountOk(evidence.requested) &&
    amountOk(evidence.ceiling)
  );
}

function parseMoney(text: string | undefined): { readonly value: string; readonly unit: string } | undefined | null {
  if (text === undefined) return undefined;
  const at = text.lastIndexOf(':');
  if (at <= 0) return null;
  const unit = text.slice(0, at);
  const value = text.slice(at + 1);
  return DECIMAL.test(value) && UNIT.test(unit) ? { value, unit } : null;
}

/**
 * Parse a row back into evidence, or `undefined` when any part is malformed or
 * the digest does not cover exactly these fields.
 */
export function parseIssuanceWithheldRow(row: { readonly externalId: string; readonly externalVersion?: string; readonly uri?: string; readonly digest?: string }): IssuanceWithheldEvidence | undefined {
  const version = /^withheld:([a-z-]{1,40}):([A-Z0-9_,]{1,2000})$/.exec(row.externalVersion ?? '');
  if (version === null) return undefined;
  const parts = (row.uri ?? '').split(';');
  if (parts[0] !== 'urn:aoc:issuance-record:v1') return undefined;
  const fields = new Map<string, string>();
  for (const part of parts.slice(1)) {
    const eq = part.indexOf('=');
    if (eq <= 0 || fields.has(part.slice(0, eq))) return undefined;
    fields.set(part.slice(0, eq), part.slice(eq + 1));
  }
  for (const key of fields.keys()) if (!['decision', 'requested', 'ceiling'].includes(key)) return undefined;
  const decisionId = fields.get('decision');
  const requested = parseMoney(fields.get('requested'));
  const ceiling = parseMoney(fields.get('ceiling'));
  if (decisionId === undefined || requested === null || ceiling === null) return undefined;
  const evidence: IssuanceWithheldEvidence = {
    requestId: row.externalId,
    decisionId,
    withheldBy: version[1] ?? '',
    reasonCodes: (version[2] ?? '').split(','),
    ...(requested !== undefined ? { requested } : {}),
    ...(ceiling !== undefined ? { ceiling } : {}),
  };
  if (!isWellFormedIssuanceWithheldEvidence(evidence) || issuanceWithheldUri(evidence) !== row.uri || issuanceWithheldDigest(evidence) !== row.digest) return undefined;
  return evidence;
}
