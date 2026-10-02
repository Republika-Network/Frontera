/**
 * Destination Runtime — rail-neutral destination identity (ANDREW-P0-01).
 *
 * > **A destination is a namespace and an exact identifier; whether it is
 * > approved is somebody else's fact.**
 *
 * The `ExecutionDestination` value, its single ingress, its canonical key and
 * its equality. Pure data and logic: no registry, no approval state, no rail
 * validation, no clock, no I/O, and no import beyond the semantic-identifier
 * grammar it reuses. See `README.md` and
 * `docs/demo/andrew/ANDREW-P0-01-DESTINATION-SEMANTICS.md`.
 */
export * from './domain/index.js';
