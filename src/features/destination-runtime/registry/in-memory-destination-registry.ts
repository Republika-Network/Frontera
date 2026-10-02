import { executionDestinationKey } from '../domain/index.js';
import {
  DestinationRegistryError,
  buildDestinationRegistration,
  knownDestination,
  requireRegisterDestinationInput,
  requireRegistryDestination,
  sampleRegistrationInstant,
  unknownDestination,
  type DestinationLookup,
  type DestinationRegisterResult,
  type DestinationRegistration,
  type DestinationRegistryPort,
  type RegisterDestinationInput,
} from './destination-registry.js';

export interface CreateInMemoryDestinationRegistryOptions {
  /** The injected clock, sampled once per new registration as `registeredAt`. Required. */
  readonly now: () => string;
}

/**
 * A process-local destination registry.
 *
 * **Not durable, and never described as such.** It holds its records in a
 * `Map` and forgets every one on restart; `createSqliteDestinationRegistry`
 * (`src/enterprise/destination-registry`) is the durable implementation. It
 * exists so the registry contract can be proven against two implementations,
 * and it refuses exactly the inputs the durable one refuses.
 */
export function createInMemoryDestinationRegistry(options: CreateInMemoryDestinationRegistryOptions): DestinationRegistryPort {
  if (typeof options?.now !== 'function') throw new DestinationRegistryError('DESTINATION_REGISTRY_UNAVAILABLE', 'The destination registry requires an injected clock.');
  const now = options.now;
  const records = new Map<string, DestinationRegistration>();

  return {
    register(input: RegisterDestinationInput): DestinationRegisterResult {
      const { destination, registeredBy } = requireRegisterDestinationInput(input);
      const key = executionDestinationKey(destination);
      const existing = records.get(key);
      // The first record stands: a retry, with any provenance, gets the original back.
      if (existing !== undefined) return Object.freeze({ outcome: 'existing', registration: existing });
      const registration = buildDestinationRegistration(destination, registeredBy, sampleRegistrationInstant(now));
      records.set(key, registration);
      return Object.freeze({ outcome: 'registered', registration });
    },

    lookup(destination): DestinationLookup {
      const key = executionDestinationKey(requireRegistryDestination(destination));
      const registration = records.get(key);
      return registration === undefined ? unknownDestination(key) : knownDestination(registration);
    },
  };
}
