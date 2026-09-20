import { emergencyControlUnavailable, type EmergencyControlQuery, type EmergencyControlReaderPort } from '../domain/index.js';

/**
 * Narrows a store to the **read capability alone**, as a fresh object.
 *
 * The same move `createKernelAuthoritySubjectBindingReader` already makes for
 * customer admission, and for the same reason. Typing an execution component
 * against `EmergencyControlReaderPort` makes `activate` and `release`
 * unreachable *to the compiler*; handing it the store itself leaves them
 * reachable to a cast. This closes that: the object handed downstream has one
 * method and no reference a caller can walk back to the writer.
 *
 * It still reads the same store, so there is exactly one emergency-control
 * world — which is the property that matters. What changes is that the four
 * checkpoints hold a capability rather than a store.
 *
 * Total, like every reader on this path: a store that raises becomes
 * `unavailable`, which withholds.
 */
export function createEmergencyControlReader(store: EmergencyControlReaderPort): EmergencyControlReaderPort {
  return Object.freeze({
    read(query: EmergencyControlQuery) {
      try {
        return store.read(query);
      } catch {
        return emergencyControlUnavailable();
      }
    },
  });
}
