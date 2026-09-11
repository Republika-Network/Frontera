import { CONTEXT_DERIVED_SOURCE, CONTEXT_DERIVED_SOURCE_ID, validateContextSource, type ContextSource } from '../domain/context-source.js';
import { ContextConfigurationError } from './context-resolution-errors.js';

/**
 * The deployment's configured context sources, and the only place a trust class
 * is ever decided.
 *
 * An observation naming a source that is not in here cannot be classified, and
 * this layer refuses to guess: the observation is discarded and the key
 * resolves `unresolved`. Defaulting it to some class would be the exact
 * fail-open the trust model exists to prevent — an unknown origin is not a
 * low-trust origin, it is no origin at all.
 */
export class ContextSourceRegistry {
  private readonly sources: ReadonlyMap<string, ContextSource>;

  constructor(sources: readonly ContextSource[]) {
    const violations: string[] = [];
    const byId = new Map<string, ContextSource>();

    for (const source of sources) {
      violations.push(...validateContextSource(source));
      if (source.id === CONTEXT_DERIVED_SOURCE_ID) {
        violations.push(`ContextSource '${source.id}' is reserved for Frontera's own derived facts and cannot be configured.`);
        continue;
      }
      if (byId.has(source.id)) violations.push(`ContextSource '${source.id}': registered more than once.`);
      byId.set(source.id, source);
    }

    if (violations.length > 0) throw new ContextConfigurationError('Context source configuration is invalid.', violations);

    byId.set(CONTEXT_DERIVED_SOURCE_ID, CONTEXT_DERIVED_SOURCE);
    this.sources = byId;
  }

  get(sourceId: string): ContextSource | undefined {
    return this.sources.get(sourceId);
  }

  /** Stably ordered by id, so a configuration snapshot is comparable across processes. */
  list(): readonly ContextSource[] {
    return [...this.sources.values()].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  }
}
