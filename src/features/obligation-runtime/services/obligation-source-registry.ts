import { validateObligationDischargeSource, type ObligationDischargeSource } from '../domain/obligation-source.js';
import { ObligationConfigurationError } from './obligation-configuration-errors.js';

/**
 * The deployment's configured discharge sources, and the only place a
 * verification class is ever decided.
 *
 * An observation naming a source that is not in here cannot be classified, and
 * this layer refuses to guess: the observation is discarded and the obligation
 * stays exactly where it was. Defaulting it to `self_reported` would be almost
 * as wrong as defaulting it to `independent` — it would let an unregistered
 * origin move an obligation out of `required`, which an unknown origin has no
 * standing to do.
 */
export class ObligationDischargeSourceRegistry {
  private readonly sources: ReadonlyMap<string, ObligationDischargeSource>;

  constructor(sources: readonly ObligationDischargeSource[]) {
    const violations: string[] = [];
    const byId = new Map<string, ObligationDischargeSource>();

    for (const source of sources) {
      violations.push(...validateObligationDischargeSource(source));
      if (byId.has(source.id)) violations.push(`ObligationDischargeSource '${source.id}': registered more than once.`);
      byId.set(source.id, source);
    }

    if (violations.length > 0) throw new ObligationConfigurationError('Obligation discharge source configuration is invalid.', violations);
    this.sources = byId;
  }

  get(sourceId: string): ObligationDischargeSource | undefined {
    return this.sources.get(sourceId);
  }

  /** Stably ordered by id, so a configuration snapshot is comparable across processes. */
  list(): readonly ObligationDischargeSource[] {
    return [...this.sources.values()].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  }
}
