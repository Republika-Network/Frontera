import {
  applicableEmergencyControlScopes,
  emergencyControlBlocked,
  emergencyControlKey,
  emergencyControlUnavailable,
  isWellFormedEmergencyControlDeclaration,
  isWellFormedEmergencyControlQuery,
  EMERGENCY_CONTROL_CLEAR,
  type EmergencyControlAssessment,
  type EmergencyControlDeclaration,
  type EmergencyControlQuery,
  type EmergencyControlRelease,
  type EmergencyControlScopeMatch,
  type EmergencyControlStorePort,
} from '../domain/index.js';

/**
 * A process-local emergency-control store.
 *
 * **Not durable, and never described as such.** It holds its state in a `Map`
 * and loses every control on restart. Losing a control fails *open* for that
 * control — the stop silently stops stopping — which is exactly why this
 * implementation is for focused tests and single-process development, and why
 * `createSqliteEmergencyControlStore` exists for anything else.
 *
 * It exists for the same reason `createInMemoryBoundedGrantStore` does: to
 * prove the vertical slice against the same contract the durable store
 * implements, so a behavioural difference between them is a bug in one of them
 * rather than a difference in what they were asked.
 */
export interface InMemoryEmergencyControlStore extends EmergencyControlStorePort {
  /** Makes every subsequent read report `unavailable`. The fail-closed path, exercised without corrupting anything. */
  simulateUnavailable(unavailable: boolean): void;
}

export function createInMemoryEmergencyControlStore(): InMemoryEmergencyControlStore {
  const controls = new Map<string, EmergencyControlScopeMatch>();
  let unavailable = false;

  return {
    read(query: EmergencyControlQuery): EmergencyControlAssessment {
      if (unavailable) return emergencyControlUnavailable();
      // A malformed query cannot be matched against anything, and "matched
      // nothing" must never be reported as "no stop applies".
      if (!isWellFormedEmergencyControlQuery(query)) return emergencyControlUnavailable();
      const matched = applicableEmergencyControlScopes(query).filter((scope) => controls.has(emergencyControlKey(scope.scope, scope.value)));
      // Monotonic: one applicable active control blocks, whatever the others say.
      return matched.length > 0 ? emergencyControlBlocked(matched) : EMERGENCY_CONTROL_CLEAR;
    },

    activate(declaration: EmergencyControlDeclaration): void {
      if (!isWellFormedEmergencyControlDeclaration(declaration)) {
        throw new RangeError('An emergency control declaration must state a known scope, a value for every scope but global, an issuerRef and an instant.');
      }
      const key = emergencyControlKey(declaration.scope, declaration.value);
      if (controls.has(key)) return;
      controls.set(key, declaration.scope === 'global' ? { scope: 'global' } : { scope: declaration.scope, value: declaration.value as string });
    },

    release(release: EmergencyControlRelease): void {
      controls.delete(emergencyControlKey(release.scope, release.value));
    },

    active(): readonly EmergencyControlScopeMatch[] {
      return Object.freeze([...controls.values()]);
    },

    simulateUnavailable(next: boolean): void {
      unavailable = next;
    },
  };
}
