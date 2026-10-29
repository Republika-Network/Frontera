/** Shared, package-internal readers for untrusted plain data. Not exported from the package. */

export function isPlainObject(value: unknown): value is object {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Reads a plain object's own data properties exactly once. Refuses non-plain
 * objects, accessors, symbol keys, unknown keys and missing required keys, so a
 * getter never runs and an inherited or injected field is never honoured.
 */
export function readPlain(value: unknown, allowed: readonly string[], required: readonly string[]): Map<string, unknown> | undefined {
  if (!isPlainObject(value)) return undefined;
  const values = new Map<string, unknown>();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key)) return undefined;
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) return undefined;
    values.set(key, descriptor.value);
  }
  for (const key of required) if (!values.has(key)) return undefined;
  return values;
}

/** Reads `object[key]` once, where `object` is any non-null object; `undefined` if reading throws. */
export function readOnce(container: object, key: string): unknown {
  try {
    return Reflect.get(container, key);
  } catch {
    return undefined;
  }
}

/**
 * Reads a host-supplied service object's methods once and returns them bound
 * to it, so later reads of the object can never swap the implementation.
 */
export function bindMethods<K extends string>(value: unknown, names: readonly K[]): Record<K, (...args: unknown[]) => unknown> | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const bound = Object.create(null) as Record<K, (...args: unknown[]) => unknown>;
  for (const name of names) {
    let method: unknown;
    try {
      method = Reflect.get(value, name);
    } catch {
      return undefined;
    }
    if (typeof method !== 'function') return undefined;
    const fn = method as (...args: unknown[]) => unknown;
    bound[name] = (...args: unknown[]) => Reflect.apply(fn, value, args);
  }
  return bound;
}

/** A non-empty identifier with no surrounding whitespace, compared exactly. */
export function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && value.trim() === value;
}

const DIGEST = /^[0-9a-f]{64}$/;

/** Lowercase hex SHA-256, unprefixed. */
export function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value);
}

export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
