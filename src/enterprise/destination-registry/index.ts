/**
 * The durable destination registry (ANDREW-P0-02): which destinations
 * Frontera knows, who recorded each and when — and nothing about whether any
 * of them is approved.
 *
 * See `docs/demo/andrew/ANDREW-P0-02-DESTINATION-REGISTRY.md`. The port, the
 * record and the in-memory implementation live in
 * `src/features/destination-runtime/registry`. Not re-exported from
 * `src/enterprise/index.ts`: nothing is composed into the Host yet.
 */
export { DESTINATION_REGISTRY_SCHEMA_VERSION, createSqliteDestinationRegistry } from './sqlite-destination-registry.js';
export type { CreateSqliteDestinationRegistryOptions, DurableDestinationRegistry } from './sqlite-destination-registry.js';
