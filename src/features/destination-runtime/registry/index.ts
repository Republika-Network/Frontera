/**
 * Destination registry membership (ANDREW-P0-02): is this exact destination
 * known to Frontera, and who recorded it when?
 *
 * Membership only — `unknown` or `known`. Never approval: see
 * `destination-registry.ts` and
 * `docs/demo/andrew/ANDREW-P0-02-DESTINATION-REGISTRY.md`. The durable
 * implementation is `src/enterprise/destination-registry`.
 *
 * Deliberately a separate entry point from `../index.js`, which remains the
 * pure, import-free P0-01 identity primitive.
 */
export {
  DESTINATION_REGISTRANT_REFERENCE_MAX_LENGTH,
  DestinationRegistryError,
  buildDestinationRegistration,
  isCanonicalRegistrationInstant,
  isDestinationRegistrantReference,
  isDestinationRegistryError,
  knownDestination,
  requireRegisterDestinationInput,
  requireRegistryDestination,
  sampleRegistrationInstant,
  unknownDestination,
} from './destination-registry.js';
export type {
  DestinationLookup,
  DestinationRegisterResult,
  DestinationRegistration,
  DestinationRegistryErrorCode,
  DestinationRegistryPort,
  DestinationRegistryReaderPort,
  RegisterDestinationInput,
} from './destination-registry.js';
export { createInMemoryDestinationRegistry } from './in-memory-destination-registry.js';
export type { CreateInMemoryDestinationRegistryOptions } from './in-memory-destination-registry.js';
