import { createHash } from 'node:crypto';

import { EMERGENCY_CONTROL_REASON_CODE_VALUES } from '../../features/emergency-control-runtime/index.js';
import { GRANT_REASON_CODES, GRANT_REASON_CODE_VALUES } from '../../features/grant-runtime/index.js';
import { MONETARY_ASSET_ID_PATTERN, isCanonicalDecimal } from '../../features/monetary-runtime/index.js';
import { AUTHORITY_BINDING_REASON_CODE_VALUES, FINANCIAL_AUTHORITY_REASON_CODE_VALUES, PARAMETER_AUTHORITY_REASON_CODE_VALUES } from '../execution-governance/index.js';

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
 * | `uri` | `urn:aoc:issuance-record:v1;decision=<opaque decisionId>[;requested=<unit>:<value>][;ceiling=<unit>:<value>]` |
 * | `digest` | `sha256:` over the canonical form of every field above |
 *
 * The grammar is never stricter than the contracts whose outputs it records:
 * a decision id is opaque (the Kernel id generator and the Governance Store
 * require only a non-empty string), so it is percent-encoded; a unit is a
 * canonical monetary asset id and a value a canonical decimal (P9), whose
 * grammars admit no URI separator; a layer and its codes are exactly the
 * issuance layers the orchestrator answers with and their closed reason-code
 * vocabularies. The encoding is the identity on `[A-Za-z0-9._:-]`, so every
 * row written before it was introduced is still its own canonical form.
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

/**
 * The issuance layers the orchestrator withholds at, each with exactly the
 * vocabulary it answers with there — the authority-binding layer also carries
 * the financial (P10) and parameter (CTRL-02) authority refusals.
 */
const ISSUANCE_VOCABULARIES: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  'emergency-control': new Set<string>(EMERGENCY_CONTROL_REASON_CODE_VALUES),
  'authority-binding': new Set<string>([...AUTHORITY_BINDING_REASON_CODE_VALUES, ...FINANCIAL_AUTHORITY_REASON_CODE_VALUES, ...PARAMETER_AUTHORITY_REASON_CODE_VALUES]),
  grant: new Set<string>(GRANT_REASON_CODE_VALUES),
  obligations: new Set<string>(GRANT_REASON_CODE_VALUES),
});

/** A layer and its codes as the orchestrator states them: a known layer, non-empty, no duplicates, every code its own — and `obligations` exactly when an obligation was unsatisfied. */
function isIssuanceWithholding(layer: string, codes: readonly string[]): boolean {
  const vocabulary = Object.hasOwn(ISSUANCE_VOCABULARIES, layer) ? ISSUANCE_VOCABULARIES[layer] : undefined;
  if (vocabulary === undefined || codes.length === 0 || new Set(codes).size !== codes.length || !codes.every((code) => vocabulary.has(code))) return false;
  if (layer === 'grant' || layer === 'obligations') return codes.includes(GRANT_REASON_CODES.GRANT_OBLIGATIONS_UNSATISFIED) === (layer === 'obligations');
  return true;
}

const OPAQUE_ENCODED = /^(?:[A-Za-z0-9._:-]|%[0-9A-F]{2})+$/;

/** Percent-encode every UTF-8 byte outside `[A-Za-z0-9._:-]` (upper-case hex): `;`, `=` and `%` can never reach the row unescaped. */
function encodeOpaque(text: string): string {
  const encoder = new TextEncoder();
  return text.replace(/[^A-Za-z0-9._:-]/gu, (char) => [...encoder.encode(char)].map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`).join(''));
}

/** The inverse of `encodeOpaque`, accepting only its canonical output. */
function decodeOpaque(text: string): string | undefined {
  if (!OPAQUE_ENCODED.test(text)) return undefined;
  try {
    const decoded = decodeURIComponent(text);
    return encodeOpaque(decoded) === text ? decoded : undefined;
  } catch {
    return undefined;
  }
}

/** A non-empty opaque identifier that survives the encoding exactly (a lone surrogate does not). */
function isOpaqueIdentifier(value: string): boolean {
  return value.length > 0 && decodeOpaque(encodeOpaque(value)) === value;
}

function isAmount(amount: { readonly value: string; readonly unit: string }): boolean {
  return isCanonicalDecimal(amount.value) && MONETARY_ASSET_ID_PATTERN.test(amount.unit);
}

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
  return `urn:aoc:issuance-record:v1;decision=${encodeOpaque(evidence.decisionId)}${requested !== undefined ? `;requested=${requested}` : ''}${ceiling !== undefined ? `;ceiling=${ceiling}` : ''}`;
}

/** True when the evidence can be written in the row grammar: a governed request id, an opaque decision id, an issuance withholding and canonical amounts. */
export function isWellFormedIssuanceWithheldEvidence(evidence: IssuanceWithheldEvidence): boolean {
  const amountOk = (amount: IssuanceWithheldEvidence['requested']) => amount === undefined || isAmount(amount);
  return (
    TOKEN.test(evidence.requestId) &&
    isOpaqueIdentifier(evidence.decisionId) &&
    isIssuanceWithholding(evidence.withheldBy, evidence.reasonCodes) &&
    amountOk(evidence.requested) &&
    amountOk(evidence.ceiling)
  );
}

function parseMoney(text: string | undefined): { readonly value: string; readonly unit: string } | undefined | null {
  if (text === undefined) return undefined;
  const at = text.lastIndexOf(':');
  if (at <= 0) return null;
  const amount = { value: text.slice(at + 1), unit: text.slice(0, at) };
  return isAmount(amount) ? amount : null;
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
  const decisionId = decodeOpaque(fields.get('decision') ?? '');
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
