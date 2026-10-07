import { EMERGENCY_CONTROL_REASON_CODE_VALUES } from '../../features/emergency-control-runtime/index.js';
import { EXERCISE_CONTROL_REASON_CODE_VALUES } from '../../features/exercise-control-runtime/index.js';
import { EXECUTION_FAILURE_REASON_VALUES, GRANT_EXERCISE_REASON_CODE_VALUES, isRecordableExecutionAdapterId } from '../../features/execution-runtime/index.js';

/**
 * The recorded grammar of an `execution_record` row's `externalVersion` — the
 * one definition, read by the execution ledger's replay (`execution-ledger.ts`)
 * and by the Governance Store's governed-path selection (PROD-03-01), so the
 * two can never disagree about which forms a row may take.
 *
 * Decoding only, and pure: no store, no clock, no I/O. The ledger's writer
 * produces exactly these forms; anything else is undecodable and states no
 * outcome.
 */
/**
 * Which layer withheld an effect. Three layers can, they own different
 * vocabularies, and a replay must report the one that actually did.
 *
 * `exercise-control` (P7) is the aggregate / velocity and exercise-time
 * authority-binding layer. Its row is **evidence** that an effect was withheld
 * and why — never the consumption state the admission was decided from, which
 * lives in the separate exercise-control ledger and is never reconstructed
 * from here.
 */
export type WithholdingLayer = 'grant-exercise' | 'emergency-control' | 'exercise-control';

/**
 * A withheld effect is recorded as `withheld:<layer>:<CODE>,<CODE>…` — the
 * layer that withheld it, then that layer's reason codes in their own stable
 * order.
 *
 * The format is deterministic and bounded: a layer drawn from a closed
 * three-member set, at least one code, every code drawn from **that layer's own**
 * closed vocabulary, none repeated, so at most one entry per vocabulary member.
 * Anything else is not encoded and never decoded: a replay reports only reasons
 * that were recorded, and the ledger records nothing it could not later read
 * back exactly.
 *
 * The layer is part of the record rather than inferred from the codes, because
 * inferring it would make the two vocabularies' disjointness a *correctness*
 * requirement of the replay path rather than a hygiene property — and a code
 * added to the wrong constant would then silently re-label history.
 *
 * ## The Prompt 3 form still reads
 *
 * Rows written before this phase carry `withheld:<CODE>,<CODE>…` with no layer,
 * and only the grant-exercise layer could write one. They decode as
 * `grant-exercise`, unchanged. The two forms cannot be confused: a layer token
 * is lowercase and hyphenated, a reason code is upper-snake, and neither
 * vocabulary contains the other's spellings.
 *
 * The codes explain a refusal. They are evidence of why nothing ran, and they
 * cannot permit anything. **The ledger is never read to decide whether a new
 * action is allowed** — its only behavioural use stays negative: this execution
 * identity was already attempted, so do not attempt it again.
 */
export const WITHHELD_PREFIX = 'withheld:';

/**
 * The performing adapter is appended to an effect-bearing outcome as
 * `…@<adapterId>`.
 *
 * Deterministic and bounded on both sides: the id is recorded only when
 * `isRecordableExecutionAdapterId` accepts it — bounded length, and no `@` to
 * collide with the delimiter — so the recorded string decodes back to exactly
 * the id that was written. The registry refuses a non-recordable child at
 * composition, so the routed path always carries attribution; a host that
 * composed one adapter directly with an exotic identity records the outcome
 * without it rather than failing to record the outcome at all, because losing
 * the *fact* of execution is far worse than losing its label.
 *
 * `@` is split from the right, so an id containing `:` — as the reason-code and
 * layer delimiters do — is still unambiguous.
 */
export const ADAPTER_DELIMITER = '@';

/**
 * The canonical recorded form of an adapter-reported unconfirmed effect,
 * before its `@<adapterId>` suffix.
 *
 * A separate token rather than a flavour of `execution-failed:` on purpose: a
 * replay that decoded it as a failure would tell a caller the effect did not
 * happen, which nobody knows. Only this exact body decodes as unconfirmed;
 * anything longer, shorter or decorated is an undecodable row, which replays
 * as "attempted, outcome not on record" — still unconfirmed, never executed,
 * never failed, and never a second invocation.
 */
export const EXECUTION_UNCONFIRMED_OUTCOME = 'execution-unconfirmed';

export function splitAdapter(recorded: string): { readonly body: string; readonly adapterId?: string } {
  const at = recorded.lastIndexOf(ADAPTER_DELIMITER);
  if (at === -1) return { body: recorded };
  const adapterId = recorded.slice(at + 1);
  // A suffix that is not a recordable identity is not one this ledger wrote,
  // and is never decoded into an attribution.
  return isRecordableExecutionAdapterId(adapterId) ? { body: recorded.slice(0, at), adapterId } : { body: recorded };
}

export const WITHHOLDING_VOCABULARIES: Readonly<Record<WithholdingLayer, ReadonlySet<string>>> = Object.freeze({
  'grant-exercise': new Set(GRANT_EXERCISE_REASON_CODE_VALUES),
  'emergency-control': new Set(EMERGENCY_CONTROL_REASON_CODE_VALUES),
  'exercise-control': new Set(EXERCISE_CONTROL_REASON_CODE_VALUES),
});

export function isWithholdingLayer(value: string): value is WithholdingLayer {
  return value === 'grant-exercise' || value === 'emergency-control' || value === 'exercise-control';
}

/** Deterministic, bounded, and closed against the layer's own vocabulary. A code from another layer is not canonical here, which is what keeps the two from bleeding together. */
export function isCanonicalWithheldCodes(layer: WithholdingLayer, codes: readonly string[]): boolean {
  const vocabulary = WITHHOLDING_VOCABULARIES[layer];
  return codes.length > 0 && codes.length <= vocabulary.size && new Set(codes).size === codes.length && codes.every((code) => vocabulary.has(code));
}

export function decodeWithheldOutcome(recorded: string): { readonly layer: WithholdingLayer; readonly reasonCodes: readonly string[] } | undefined {
  if (!recorded.startsWith(WITHHELD_PREFIX)) return undefined;
  const body = recorded.slice(WITHHELD_PREFIX.length);
  const separator = body.indexOf(':');
  const head = separator === -1 ? '' : body.slice(0, separator);
  // Layered form when the head names a layer; otherwise the Prompt 3 form,
  // which only the grant-exercise layer could have written. A head that looks
  // like neither decodes as nothing at all.
  const layer: WithholdingLayer = isWithholdingLayer(head) ? head : 'grant-exercise';
  const codes = (isWithholdingLayer(head) ? body.slice(separator + 1) : body).split(',');
  return isCanonicalWithheldCodes(layer, codes) ? { layer, reasonCodes: Object.freeze([...codes]) } : undefined;
}

/** What a definitive outcome row states, decoded. `undefined` from the decoder: not a form the ledger writes. */
export type DefinitiveExecutionSummary =
  | { readonly kind: 'executed'; readonly adapterId?: string }
  | { readonly kind: 'execution-failed'; readonly failure: string; readonly adapterId?: string }
  | { readonly kind: 'withheld'; readonly layer: WithholdingLayer; readonly reasonCodes: readonly string[] }
  | { readonly kind: 'resolved'; readonly certainty: 'confirmed-completed' | 'confirmed-not-completed'; readonly failure?: string };

const EXECUTION_FAILED_PREFIX = 'execution-failed:';
const RESOLVED_COMPLETED = 'resolved:confirmed-completed';
const RESOLVED_NOT_COMPLETED_PREFIX = 'resolved:confirmed-not-completed:';

function isExecutionFailureReason(value: string): boolean {
  return (EXECUTION_FAILURE_REASON_VALUES as readonly string[]).includes(value);
}

/** The P12 resolution row, as the ledger records it. */
export function encodeResolutionSummary(certainty: 'confirmed-completed' | 'confirmed-not-completed', failure: string | undefined): string {
  return certainty === 'confirmed-completed' ? RESOLVED_COMPLETED : `${RESOLVED_NOT_COMPLETED_PREFIX}${failure ?? ''}`;
}

/**
 * A row that states a definitive answer for its execution, decoded exactly:
 * `executed` and `execution-failed:<reason>` (each with an optional recordable
 * `@<adapterId>`), `withheld:[<layer>:]<CODE>,…` in that layer's own
 * vocabulary, and the P12 resolution forms. The write-ahead claim
 * (`attempt`), the unconfirmed answer and every malformed row — a
 * `withheld:` with no decodable reason, an `execution-failed:` with no known
 * reason, a `resolved:` with no known certainty — decode as `undefined`.
 */
export function decodeDefinitiveExecutionSummary(recorded: string): DefinitiveExecutionSummary | undefined {
  if (recorded === RESOLVED_COMPLETED) return { kind: 'resolved', certainty: 'confirmed-completed' };
  if (recorded.startsWith(RESOLVED_NOT_COMPLETED_PREFIX)) {
    const failure = recorded.slice(RESOLVED_NOT_COMPLETED_PREFIX.length);
    return isExecutionFailureReason(failure) ? { kind: 'resolved', certainty: 'confirmed-not-completed', failure } : undefined;
  }
  if (recorded.startsWith(WITHHELD_PREFIX)) {
    const withheld = decodeWithheldOutcome(recorded);
    return withheld === undefined ? undefined : { kind: 'withheld', layer: withheld.layer, reasonCodes: withheld.reasonCodes };
  }
  const { body, adapterId } = splitAdapter(recorded);
  const attribution = adapterId !== undefined ? { adapterId } : {};
  if (body === 'executed') return { kind: 'executed', ...attribution };
  if (body.startsWith(EXECUTION_FAILED_PREFIX)) {
    const failure = body.slice(EXECUTION_FAILED_PREFIX.length);
    return isExecutionFailureReason(failure) ? { kind: 'execution-failed', failure, ...attribution } : undefined;
  }
  return undefined;
}

/** Whether a recorded row decodes as a definitive answer. `undefined` (no row value) never does. */
export function isDefinitiveExecutionSummary(recorded: string | undefined): boolean {
  return recorded !== undefined && decodeDefinitiveExecutionSummary(recorded) !== undefined;
}
