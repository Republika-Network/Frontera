import { createInMemoryExerciseControlLedger } from '../index.js';
import { describeExerciseReservationResolutionContract, describeExerciseReservationResolutionRules } from './exercise-reservation-resolution-contract.js';

/**
 * P12 — the process-local ledger against the shared resolution contract. The
 * same contract runs against the production SQLite ledger in
 * `src/enterprise/__tests__/exercise-control-resolution-sqlite.test.ts`.
 */
describeExerciseReservationResolutionRules();
describeExerciseReservationResolutionContract('In-memory exercise-control ledger', async (now) => ({ ledger: createInMemoryExerciseControlLedger({ now }) }));
