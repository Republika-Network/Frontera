import { createInMemoryExerciseControlLedger } from '../index.js';
import { describeExerciseControlLedgerContract } from './exercise-control-ledger-contract.js';

/**
 * The process-local ledger against the shared port contract. The same contract
 * runs against the production SQLite ledger in
 * `src/enterprise/__tests__/exercise-control-sqlite.test.ts`, so nothing proven
 * here is weaker than what production enforces.
 */
describeExerciseControlLedgerContract('In-memory exercise-control ledger', async () => ({ ledger: createInMemoryExerciseControlLedger() }));
