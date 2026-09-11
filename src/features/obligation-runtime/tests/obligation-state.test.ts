import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  OBLIGATION_STATES,
  OBLIGATION_STATE_TRANSITIONS,
  SATISFYING_OBLIGATION_STATES,
  TERMINAL_OBLIGATION_STATES,
  isLegalObligationTransition,
  isTerminalObligationState,
  OBLIGATION_PROGRESS_CHAIN,
  obligationProgressRank,
  obligationStateSatisfies,
  type ObligationState,
} from '../index.js';

/**
 * The lifecycle itself, asserted against the ADR rather than against the
 * implementation's own opinion of it.
 *
 * `ADR-OBLIGATION-DISCHARGE-AND-BOUNDED-GRANT.md` §1 draws seven nodes and
 * seven edges. Six of the edges are transcribed here verbatim; the seventh,
 * `pending → expired`, is this phase's one documented extension and is asserted
 * as such so that nobody has to infer which is which.
 */

/** The ADR's diagram, transcribed. Every edge it draws, and nothing it does not. */
const ADR_EDGES: readonly (readonly [ObligationState, ObligationState])[] = [
  ['required', 'pending'],
  ['required', 'waived'],
  ['required', 'expired'],
  ['pending', 'discharged'],
  ['pending', 'waived'],
  ['discharged', 'verified'],
  ['discharged', 'rejected'],
];

/** Not drawn in the ADR. Added because ADR §6 makes expiry clock-derived, and it can only ever withhold exercise. */
const DOCUMENTED_EXTENSION_EDGES: readonly (readonly [ObligationState, ObligationState])[] = [['pending', 'expired']];

describe('Obligation lifecycle — the ADR state set', () => {
  it('carries exactly the seven nodes the ADR diagram draws', () => {
    assert.deepEqual([...OBLIGATION_STATES].sort(), ['discharged', 'expired', 'pending', 'rejected', 'required', 'verified', 'waived']);
  });

  it('classifies four of them terminal, and no others', () => {
    assert.deepEqual([...TERMINAL_OBLIGATION_STATES].sort(), ['expired', 'rejected', 'verified', 'waived']);
    for (const state of OBLIGATION_STATES) {
      assert.equal(isTerminalObligationState(state), TERMINAL_OBLIGATION_STATES.includes(state), `${state} terminality must agree with the declared set`);
    }
  });

  it('a terminal state has no outgoing transition at all — terminal means terminal', () => {
    for (const state of TERMINAL_OBLIGATION_STATES) {
      assert.deepEqual(OBLIGATION_STATE_TRANSITIONS[state], [], `${state} must not be reopenable`);
    }
  });

  it('only `verified` and `waived` satisfy a blocking obligation — ADR hard invariant 4', () => {
    assert.deepEqual([...SATISFYING_OBLIGATION_STATES].sort(), ['verified', 'waived']);
    for (const state of OBLIGATION_STATES) {
      assert.equal(obligationStateSatisfies(state), state === 'verified' || state === 'waived', `${state}`);
    }
  });

  it('`discharged` does not satisfy — a self-reported discharge is not a confirmed one (ADR §2, hard invariant 5)', () => {
    assert.equal(obligationStateSatisfies('discharged'), false);
  });
});

describe('Obligation lifecycle — legal transitions', () => {
  for (const [from, to] of ADR_EDGES) {
    it(`the ADR draws ${from} → ${to}, and it is legal`, () => {
      assert.equal(isLegalObligationTransition(from, to), true);
    });
  }

  for (const [from, to] of DOCUMENTED_EXTENSION_EDGES) {
    it(`${from} → ${to} is this phase's one documented extension, and it is legal`, () => {
      assert.equal(isLegalObligationTransition(from, to), true);
    });
  }

  it('the transition table contains the ADR edges plus the one documented extension, and nothing else', () => {
    const actual: string[] = [];
    for (const from of OBLIGATION_STATES) {
      for (const to of OBLIGATION_STATE_TRANSITIONS[from]) actual.push(`${from}->${to}`);
    }
    const expected = [...ADR_EDGES, ...DOCUMENTED_EXTENSION_EDGES].map(([from, to]) => `${from}->${to}`);
    assert.deepEqual(actual.sort(), expected.sort(), 'a transition nobody wrote down is a lifecycle nobody reviewed');
  });
});

describe('Obligation lifecycle — illegal transitions', () => {
  it('every pair outside the table is illegal, and there are no silent exceptions', () => {
    const legal = new Set([...ADR_EDGES, ...DOCUMENTED_EXTENSION_EDGES].map(([from, to]) => `${from}->${to}`));
    for (const from of OBLIGATION_STATES) {
      for (const to of OBLIGATION_STATES) {
        if (from === to) continue;
        assert.equal(isLegalObligationTransition(from, to), legal.has(`${from}->${to}`), `${from} → ${to}`);
      }
    }
  });

  it('a discharge cannot skip the lifecycle: required → discharged is not a legal single step', () => {
    assert.equal(isLegalObligationTransition('required', 'discharged'), false);
  });

  it('a discharge cannot be refused before it exists: required → rejected and pending → rejected are illegal', () => {
    assert.equal(isLegalObligationTransition('required', 'rejected'), false);
    assert.equal(isLegalObligationTransition('pending', 'rejected'), false);
  });

  it('nothing reopens a terminal obligation', () => {
    for (const from of TERMINAL_OBLIGATION_STATES) {
      for (const to of OBLIGATION_STATES) {
        assert.equal(isLegalObligationTransition(from, to), false, `${from} → ${to} must be refused`);
      }
    }
  });

  it('an expired obligation cannot step to verified, and a rejected one cannot step to waived', () => {
    assert.equal(isLegalObligationTransition('expired', 'verified'), false);
    assert.equal(isLegalObligationTransition('rejected', 'waived'), false);
  });
});

describe('Obligation lifecycle — the progress chain', () => {
  it('is the four-state spine, and the three exits are not on it', () => {
    assert.deepEqual(OBLIGATION_PROGRESS_CHAIN, ['required', 'pending', 'discharged', 'verified']);
    for (const exit of ['waived', 'rejected', 'expired'] as const) {
      assert.equal(obligationProgressRank(exit), undefined, `${exit} is an exit from the chain, not a position on it`);
    }
  });

  it('ranks the spine in order, so a step already taken is recognizable as one', () => {
    assert.deepEqual(OBLIGATION_PROGRESS_CHAIN.map(obligationProgressRank), [0, 1, 2, 3]);
  });
});
