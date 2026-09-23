import { canonicalDecimalFromJsonNumberLexeme } from '../../features/monetary-runtime/index.js';

/**
 * Exact v1 monetary compatibility at the protocol boundary (P9).
 *
 * The frozen v1 wire lets a client write a monetary amount as a JSON number
 * (`"amount": {"value": 7500}` on `POST /api/governed-actions`,
 * `"action": {"amount": 7500}` on `POST /api/governance/evaluate`). A plain
 * `JSON.parse` turns that into an IEEE-754 double before anything else sees it
 * — `9007199254740993` arrives as `9007199254740992` — and no downstream
 * exactness can recover it.
 *
 * So these routes parse with the platform's own JSON source-text access
 * (ECMAScript 2025 `JSON.parse` reviver `context.source`, standard in the
 * Node 22 this Host requires): for the **one** monetary location of each
 * route, the exact characters the client wrote are captured during the parse
 * and turned into canonical decimal text by `canonicalDecimalFromJsonNumberLexeme`
 * — text to text, never through `number`. Nothing else in the body is touched,
 * and no custom parser or dependency is involved.
 *
 * Fail-closed in both directions: a lexeme that names no non-negative quantity
 * (`-5`), or a runtime that does not expose the source text, leaves the value a
 * JavaScript number, and every monetary consumer refuses a number.
 */

/** Where the one monetary JSON number of a route lives, if the body has one. */
export type MonetaryLocation = (root: unknown) => { readonly holder: Record<string, unknown>; readonly key: string } | undefined;

interface JsonSourceContext {
  readonly source?: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Parses a request body, replacing the route's monetary JSON number — and only it — with its exact canonical decimal text. Throws exactly what `JSON.parse` throws. */
export function parseJsonWithExactMonetaryNumber(text: string, locate: MonetaryLocation): unknown {
  const lexemes = new WeakMap<object, Map<string, string>>();
  const reviver = function (this: unknown, key: string, value: unknown, context?: JsonSourceContext): unknown {
    if (typeof value === 'number' && typeof context?.source === 'string' && this !== null && typeof this === 'object') {
      let byKey = lexemes.get(this);
      if (byKey === undefined) {
        byKey = new Map();
        lexemes.set(this, byKey);
      }
      byKey.set(key, context.source);
    }
    return value;
  };
  const root = JSON.parse(text, reviver as (this: unknown, key: string, value: unknown) => unknown) as unknown;
  const site = locate(root);
  if (site === undefined || typeof site.holder[site.key] !== 'number') return root;
  const canonical = canonicalDecimalFromJsonNumberLexeme(lexemes.get(site.holder)?.get(site.key));
  if (canonical !== undefined) {
    Object.defineProperty(site.holder, site.key, { value: canonical, enumerable: true, writable: true, configurable: true });
  }
  return root;
}

/** `POST /api/governed-actions`: the intent's `amount.value`. */
export const GOVERNED_ACTION_AMOUNT_LOCATION: MonetaryLocation = (root) => {
  if (!isPlainObject(root)) return undefined;
  const amount = Object.prototype.hasOwnProperty.call(root, 'amount') ? root['amount'] : undefined;
  return isPlainObject(amount) ? { holder: amount, key: 'value' } : undefined;
};

/** `POST /api/governance/evaluate`: the Kernel request's `action.amount`. */
export const GOVERNANCE_EVALUATE_AMOUNT_LOCATION: MonetaryLocation = (root) => {
  if (!isPlainObject(root)) return undefined;
  const action = Object.prototype.hasOwnProperty.call(root, 'action') ? root['action'] : undefined;
  return isPlainObject(action) ? { holder: action, key: 'amount' } : undefined;
};
