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
  isObligationExpiredAt,
  obligationProgressRank,
  obligationStateSatisfies,
  type ObligationState,
} from '../index.js';

/**
 * The lifecycle itself, asserted against the ADR rather than against the
 * implementation's own opinion of it.
 *
 * `ADR-OBLIGATION-DISCHARGE-AND-BOUNDED-GRANT.md` §1 states the state set and
 * the transition graph as two tables. Both are transcribed here verbatim, and
 * the suite asserts the implementation contains exactly them — no extra state,
 * no extra edge, and no edge quietly missing.
 */

/** The ADR's transition table, transcribed. Every edge it declares, and nothing it does not. */
const ADR_EDGES: readonly (readonly [ObligationState, ObligationState])[] = [
  ['required', 'pending'],
  ['required', 'waived'],
  ['required', 'expired'],
  ['pending', 'discharged'],
  ['pending', 'waived'],
  ['pending', 'expired'],
  ['discharged', 'verified'],
  ['discharged', 'expired'],
];

describe('Obligation lifecycle — the ADR state set', () => {
  it('carries exactly the six states the ADR declares, and no seventh', () => {
    assert.deepEqual([...OBLIGATION_STATES].sort(), ['discharged', 'expired', 'pending', 'required', 'verified', 'waived']);
    assert.equal((OBLIGATION_STATES as readonly string[]).includes('rejected'), false, 'the set is closed at six; a refused verification has no state of its own');
  });

  it('classifies three of them terminal, and no others', () => {
    assert.deepEqual([...TERMINAL_OBLIGATION_STATES].sort(), ['expired', 'verified', 'waived']);
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

  it('`discharged` does not satisfy — a supplied discharge is not a verified one (ADR §2, hard invariant 5)', () => {
    assert.equal(obligationStateSatisfies('discharged'), false);
  });

  it('the satisfaction table is exactly the ADR\u2019s, state by state', () => {
    const expected: Readonly<Record<ObligationState, boolean>> = {
      required: false,
      pending: false,
      discharged: false,
      verified: true,
      waived: true,
      expired: false,
    };
    for (const state of OBLIGATION_STATES) assert.equal(obligationStateSatisfies(state), expected[state], state);
  });

  it('terminal and satisfying are different properties — `expired` is terminal and unsatisfying', () => {
    assert.equal(isTerminalObligationState('expired'), true);
    assert.equal(obligationStateSatisfies('expired'), false);
  });
});

describe('Obligation expiry is a deadline, evaluated against a passed-in instant', () => {
  it('is expired at or after the deadline, and not before', () => {
    assert.equal(isObligationExpiredAt('2026-01-01T12:00:00.000Z', '2026-01-01T11:59:59.999Z'), false);
    assert.equal(isObligationExpiredAt('2026-01-01T12:00:00.000Z', '2026-01-01T12:00:00.000Z'), true, 'the ADR rule is `currentTime >= expiresAt`');
    assert.equal(isObligationExpiredAt('2026-01-01T12:00:00.000Z', '2026-01-01T12:00:00.001Z'), true);
  });

  it('an unparseable deadline or instant is not expired — a configuration fault must not silently expire an obligation', () => {
    assert.equal(isObligationExpiredAt('not-a-timestamp', '2026-01-01T12:00:00.000Z'), false);
    assert.equal(isObligationExpiredAt('2026-01-01T12:00:00.000Z', 'not-a-timestamp'), false);
  });
});

describe('Obligation lifecycle — legal transitions', () => {
  for (const [from, to] of ADR_EDGES) {
    it(`the ADR declares ${from} → ${to}, and it is legal`, () => {
      assert.equal(isLegalObligationTransition(from, to), true);
    });
  }

  it('the transition table is exactly the ADR table — no extra edge, none missing', () => {
    const actual: string[] = [];
    for (const from of OBLIGATION_STATES) {
      for (const to of OBLIGATION_STATE_TRANSITIONS[from]) actual.push(`${from}->${to}`);
    }
    const expected = ADR_EDGES.map(([from, to]) => `${from}->${to}`);
    assert.deepEqual(actual.sort(), expected.sort(), 'a transition nobody wrote down is a lifecycle nobody reviewed');
  });
});

describe('Obligation lifecycle — illegal transitions', () => {
  it('every pair outside the table is illegal, and there are no silent exceptions', () => {
    const legal = new Set(ADR_EDGES.map(([from, to]) => `${from}->${to}`));
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

  it('a failed verification has nowhere to go: `discharged` has exactly two exits, and neither reports a refusal', () => {
    assert.deepEqual([...OBLIGATION_STATE_TRANSITIONS.discharged].sort(), ['expired', 'verified']);
  });

  it('nothing reopens a terminal obligation', () => {
    for (const from of TERMINAL_OBLIGATION_STATES) {
      for (const to of OBLIGATION_STATES) {
        assert.equal(isLegalObligationTransition(from, to), false, `${from} → ${to} must be refused`);
      }
    }
  });

  it('a satisfied obligation is never expired: expiry cannot reach `verified` or `waived`', () => {
    assert.equal(isLegalObligationTransition('verified', 'expired'), false);
    assert.equal(isLegalObligationTransition('waived', 'expired'), false);
  });

  it('an expired obligation is never rescued', () => {
    assert.equal(isLegalObligationTransition('expired', 'verified'), false);
    assert.equal(isLegalObligationTransition('expired', 'waived'), false);
    assert.equal(isLegalObligationTransition('expired', 'discharged'), false);
  });
});

describe('Obligation lifecycle — the progress chain', () => {
  it('is the four-state spine, and the three exits are not on it', () => {
    assert.deepEqual(OBLIGATION_PROGRESS_CHAIN, ['required', 'pending', 'discharged', 'verified']);
    for (const exit of ['waived', 'expired'] as const) {
      assert.equal(obligationProgressRank(exit), undefined, `${exit} is an exit from the chain, not a position on it`);
    }
  });

  it('ranks the spine in order, so a step already taken is recognizable as one', () => {
    assert.deepEqual(OBLIGATION_PROGRESS_CHAIN.map(obligationProgressRank), [0, 1, 2, 3]);
  });
});
