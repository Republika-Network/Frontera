// FV-P4C-2B3C-2A1-HF01 — two post-merge findings of PR #262, as regressions:
//   1. an authentic witness receipt about *another* slot (organization, state kind, namespace) is not evidence
//      about this registration: it never quarantines it, and never completes it;
//   2. a registration settles only the ledger claims its own record proves it made: never another
//      organization's or another registration's in-flight claim on a shared consumption ledger.
// Real reference witnesses, real AUTH-03 stores, the real G-02A verifier and ledger, real child processes.
// Synthetic organizations, test-only keys and owned temporary directories only.
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, rmSync } from 'node:fs';

import { createHttpAuthorityStateWitnessTransport } from '../dist/src/enterprise/authority-state-freshness/index.js';
import { openExecutionCapabilityConsumptionLedger } from '../dist/src/enterprise/execution-capability/reference/consumption-ledger.js';
import { readFvIdentityRegistration, registerFvIdentity, resumeFvIdentityRegistration, verifyFvIdentityRegistration } from '../dist/src/enterprise/sovereign-status-history/identity-registration.js';
import { WITNESS_TOKEN, closeAllWitnesses, startWitness, witnessKey, witnessRows } from '../dist/src/enterprise/__tests__/core07-freshness-fixture.js';
import { trustedRegistrationIssuers } from '../dist/src/enterprise/__tests__/fv-identity-registration-issuer-fixture.js';
import { AUDIENCE, FV_DOMAIN, TRUST_DOMAIN, bindingFor, own, pausedChild, registerRequest, registrarOptions, registrationWorld, removeOwnedDirectories, resumeRequest, runChild } from './fv-p4c2b3c2a-support.mjs';

after(async () => {
  await closeAllWitnesses();
  removeOwnedDirectories();
});
const started = async (options) => {
  const witness = await startWitness(options);
  own(witness.directory);
  return witness;
};
const ORG_A = 'org-fv-hf01-a';
const ORG_B = 'org-fv-hf01-b';
const world = (org) => registrationWorld({ org });
const register = (w, witness, request, overrides) => registerFvIdentity(registrarOptions(w, witness, overrides), request);
const resume = (w, witness, request, overrides) => resumeFvIdentityRegistration(registrarOptions(w, witness, overrides), request);
const issue = (w, witness, binding = bindingFor(w, witness)) => ({ binding, ...registerRequest(binding, { organizationId: w.org }) });
const resumeOf = (w, binding) => resumeRequest(binding, { organizationId: w.org });
const stateOf = async (w) => (await readFvIdentityRegistration(w.paths.record, w.org))?.state;
const fvSlots = async (witness) => (await witnessRows(witness.databasePath)).filter((r) => r.state_kind === FV_DOMAIN).map((r) => [r.organization_id, r.store_id, r.committed_sequence]);

/** Every ledger claim: organization, execution, state (the exact rows, in claim order). */
async function ledgerRows(path) {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return db.prepare('SELECT capability_id AS capabilityId, organization_id AS organizationId, execution_id AS executionId, state FROM execution_capability_consumptions ORDER BY claimed_at, capability_id').all();
  } finally {
    db.close();
  }
}
async function ledgerState(path, capabilityId) {
  const ledger = await openExecutionCapabilityConsumptionLedger(path, { audience: AUDIENCE, clock: () => Date.now() });
  try {
    return ledger.read(capabilityId).state;
  } finally {
    ledger.close();
  }
}

/**
 * A transport to `witness` that, while `route.on`, answers this registration's FV-slot reads with `route.answer`
 * (an authentic receipt from somewhere else). Everything else passes through.
 */
function routed(witness, route) {
  const http = createHttpAuthorityStateWitnessTransport({ endpoint: witness.endpoint, credential: WITNESS_TOKEN });
  return {
    async call(request, options) {
      if (route.on && request.operation === 'read' && request.binding.stateKind === FV_DOMAIN && request.binding.organizationId === route.org) {
        route.hits += 1;
        return route.answer(request, options, http);
      }
      return http.call(request, options);
    },
  };
}
/** The registrar's options with `route` in front of its witness, switched on at `onAt`. */
function routedOptions(w, witness, route, onAt) {
  return { witness: { ...registrarOptions(w, witness).witness, transport: routed(witness, route) }, observer: (step) => step === onAt && (route.on = true) };
}
/** The same witness's signed answer about another slot, to this request's challenge. */
const MISROUTES = {
  'another organization': (b) => ({ ...b, organizationId: ORG_B }),
  'another state kind (the Host identity slot)': (b) => ({ stateKind: 'human-identity-state', organizationId: b.organizationId }),
  'another state kind and namespace': (b) => ({ stateKind: 'payment-initiation-reservations', organizationId: b.organizationId, namespace: 'hf01' }),
};

describe('HF01 finding 1 — an authentic receipt about another slot is not evidence about this registration', () => {
  for (const at of ['store-file-reserved', 'store-genesis-committed']) {
    for (const [name, rewrite] of Object.entries(MISROUTES)) {
      it(`${name}, answered from ${at}: pending, never quarantined, never registered; correct routing then completes the same genesis`, async () => {
        const witness = await started();
        // B's slot is bound at the same witness, so an authentic receipt about B exists to be misrouted.
        const b = world(ORG_B);
        assert.equal((await register(b, witness, issue(b, witness).request)).outcome, 'registered');
        const a = world(ORG_A);
        const { binding, request, capability } = issue(a, witness);
        const route = { org: ORG_A, on: false, hits: 0, answer: (req, o, http) => http.call({ ...req, binding: rewrite(req.binding) }, o) };
        const outcome = await register(a, witness, request, routedOptions(a, witness, route, at));
        assert.ok(route.hits > 0, 'the misrouted answer was actually served');
        assert.equal(outcome.outcome, 'pending', JSON.stringify(outcome));
        assert.equal(outcome.reason, 'WITNESS_UNAVAILABLE');
        assert.notEqual(await stateOf(a), 'quarantined');
        assert.notEqual(await stateOf(a), 'registered');
        // Never ready while pending, and A's real slot still holds exactly its genesis.
        const gate = await verifyFvIdentityRegistration({ recordPath: a.paths.record, organizationId: a.org, storePath: a.paths.store, storeId: binding.storeId, witnessId: witness.witnessId, trustedIssuers: trustedRegistrationIssuers(), audience: AUDIENCE, trustDomain: TRUST_DOMAIN });
        assert.deepEqual(gate, { verified: false, failure: 'REGISTRATION_PENDING' });
        // Still misrouted: a resume stays pending (it consumes its own capability; it never completes).
        route.on = true;
        const still = await resume(a, witness, resumeOf(a, binding).request, routedOptions(a, witness, route, undefined));
        assert.equal(still.outcome, 'pending', JSON.stringify(still));
        const registerClaim = capability.capabilityId;
        assert.equal(await ledgerState(a.paths.ledger, registerClaim), 'outcome-unknown', 'pending (the register said so); a pending resume settles nothing final');
        // Routed correctly again: a fresh resume capability completes it; the witness re-confirms the same genesis.
        assert.equal((await resume(a, witness, resumeOf(a, binding).request)).outcome, 'registered');
        assert.equal(await ledgerState(a.paths.ledger, registerClaim), 'completed', 'the completing resume settles it');
        assert.deepEqual((await fvSlots(witness)).filter(([org]) => org === ORG_A), [[ORG_A, binding.storeId, 0]]);
      });
    }
  }

  it('an answer signed by another witness key, or a replayed earlier answer: pending, then completes (unchanged)', async () => {
    for (const mode of ['another witness key', 'a replayed answer']) {
      const witness = await started();
      const impostor = await started({ witnessId: witness.witnessId });
      const a = world(ORG_A);
      const { binding, request } = issue(a, witness);
      const impostorHttp = createHttpAuthorityStateWitnessTransport({ endpoint: impostor.endpoint, credential: WITNESS_TOKEN });
      let earlier;
      const route = { org: ORG_A, on: false, hits: 0, answer: async (req, o, http) => (mode === 'another witness key' ? impostorHttp.call(req, o) : (earlier ??= await http.call({ ...req, challenge: `${req.challenge.slice(0, -4)}0000` }, o))) };
      const outcome = await register(a, witness, request, routedOptions(a, witness, route, 'store-file-reserved'));
      assert.equal(outcome.outcome, 'pending', `${mode}: ${JSON.stringify(outcome)}`);
      assert.equal((await resume(a, witness, resumeOf(a, binding).request)).outcome, 'registered', mode);
    }
  });

  it('an authoritative contradiction is still evidence: the pinned witness signs that this slot binds another store — quarantined, never adopted', async () => {
    const key = witnessKey();
    const witness = await started({ key });
    // The same witness identity and key, whose FV slot for A binds another store S′ (what a genuinely
    // conflicting witness state looks like to the registrar: authentic, and about exactly this slot).
    const conflicting = await started({ key, witnessId: witness.witnessId });
    const elsewhere = world(ORG_A);
    const other = issue(elsewhere, conflicting);
    assert.equal((await register(elsewhere, conflicting, other.request)).outcome, 'registered');
    const a = world(ORG_A);
    const { binding, request } = issue(a, witness);
    const conflictingHttp = createHttpAuthorityStateWitnessTransport({ endpoint: conflicting.endpoint, credential: WITNESS_TOKEN });
    const route = { org: ORG_A, on: false, hits: 0, answer: (req, o) => conflictingHttp.call(req, o) };
    // From the readback (the store S exists): the open under freshness meets S′, and the confirming read of this
    // very slot, verified, says S′ too.
    const outcome = await register(a, witness, request, routedOptions(a, witness, route, 'store-genesis-committed'));
    assert.deepEqual(outcome, { outcome: 'quarantined', reason: 'WITNESS_BOUND_TO_ANOTHER_STORE', registrationId: binding.registrationId, storeId: binding.storeId });
    assert.equal(await stateOf(a), 'quarantined');
    // Terminal: no resume, no new registration, no adoption of S′.
    assert.equal((await resume(a, witness, resumeOf(a, binding).request)).reason, 'REGISTRATION_QUARANTINED');
    assert.notEqual(binding.storeId, other.binding.storeId);
  });
});

describe('HF01 finding 2 — a shared consumption ledger: each registration settles only its own claims', () => {
  /** Two organizations' registrations at one witness, sharing A's ledger file. */
  async function sharedLedger() {
    const witness = await started();
    const a = world(ORG_A);
    const b = world(ORG_B);
    b.paths.ledger = a.paths.ledger;
    return { witness, a, b };
  }

  for (const [first, second] of [['a', 'b'], ['b', 'a']]) {
    it(`${first.toUpperCase()} in flight (paused after its intent) while ${second.toUpperCase()} registers: ${first.toUpperCase()}'s claim is untouched, and both end completed`, async () => {
      const ctx = await sharedLedger();
      const x = ctx[first];
      const y = ctx[second];
      const ix = issue(x, ctx.witness);
      const iy = issue(y, ctx.witness);
      const paused = await pausedChild(x, ctx.witness, { request: ix.request, pauseAt: 'intent-recorded' });
      try {
        assert.equal(await ledgerState(x.paths.ledger, ix.capability.capabilityId), 'claimed');
        assert.equal((await register(y, ctx.witness, iy.request)).outcome, 'registered');
        assert.equal(await ledgerState(x.paths.ledger, ix.capability.capabilityId), 'claimed', 'the other registration never settles a claim it does not own');
      } finally {
        paused.release();
      }
      assert.equal((await paused.done).outcome, 'registered');
      assert.deepEqual(
        (await ledgerRows(x.paths.ledger)).map((r) => [r.organizationId, r.executionId, r.state]).sort(),
        [[x.org, ix.binding.registrationId, 'completed'], [y.org, iy.binding.registrationId, 'completed']].sort(),
      );
    });
  }

  it('the same organization, another deployment’s registrar on the shared ledger: its in-flight claim is not this record’s either', async () => {
    const witness = await started();
    const first = world(ORG_A);
    const second = world(ORG_A);
    second.paths.ledger = first.paths.ledger;
    const i1 = issue(first, witness);
    const paused = await pausedChild(first, witness, { request: i1.request, pauseAt: 'intent-recorded' });
    let outcome;
    try {
      // The second registrar races to be first at the witness (B3C-2A1: at most one genesis); its cleanup must not touch the first's claim.
      outcome = await register(second, witness, issue(second, witness).request);
      assert.equal(await ledgerState(first.paths.ledger, i1.capability.capabilityId), 'claimed', 'a same-organization claim this record never made is left as it is');
    } finally {
      paused.release();
    }
    assert.equal(outcome.outcome, 'registered');
    const loser = await paused.done;
    assert.equal(loser.outcome, 'quarantined', JSON.stringify(loser));
    assert.equal(loser.reason, 'WITNESS_BOUND_TO_ANOTHER_STORE', 'the loser never adopts the winner’s store');
    assert.equal((await fvSlots(witness)).length, 1, 'one genesis');
  });

  it('A crashed after its intent while B registers: A’s claim stays claimed (not failed); A resumes and settles it completed', async () => {
    const { witness, a, b } = await sharedLedger();
    const ia = issue(a, witness);
    assert.equal((await runChild(a, witness, { operation: 'register', request: ia.request, killAt: 'intent-recorded' })).killed, true);
    assert.equal((await register(b, witness, issue(b, witness).request)).outcome, 'registered');
    assert.equal(await ledgerState(a.paths.ledger, ia.capability.capabilityId), 'claimed');
    const completion = resumeOf(a, ia.binding);
    assert.equal((await resume(a, witness, completion.request)).outcome, 'registered');
    assert.equal(await ledgerState(a.paths.ledger, ia.capability.capabilityId), 'completed', 'the register claim the record holds is settled by its own resume');
    assert.equal(await ledgerState(a.paths.ledger, completion.capability.capabilityId), 'completed');
  });

  it('a resume refused partway (an unsafe store file) leaves the register claim unsettled; the completing resume settles it', async () => {
    const { witness, a } = await sharedLedger();
    const ia = issue(a, witness);
    assert.equal((await runChild(a, witness, { operation: 'register', request: ia.request, killAt: 'store-created' })).killed, true);
    chmodSync(a.paths.store, 0o666);
    const refusedResume = await resume(a, witness, resumeOf(a, ia.binding).request);
    assert.equal(refusedResume.reason, 'PATH_REFUSED', JSON.stringify(refusedResume));
    assert.equal(await ledgerState(a.paths.ledger, ia.capability.capabilityId), 'claimed', 'a refusal is not this registration’s final outcome');
    chmodSync(a.paths.store, 0o600);
    assert.equal((await resume(a, witness, resumeOf(a, ia.binding).request)).outcome, 'registered');
    assert.equal(await ledgerState(a.paths.ledger, ia.capability.capabilityId), 'completed');
  });

  it('both crashed after consuming but before any intent; both retry at once: each settles only its own orphan, and both register', async () => {
    const { witness, a, b } = await sharedLedger();
    const ia = issue(a, witness);
    const ib = issue(b, witness);
    assert.equal((await runChild(a, witness, { operation: 'register', request: ia.request, killAt: 'capability-claimed' })).killed, true);
    assert.equal((await runChild(b, witness, { operation: 'register', request: ib.request, killAt: 'capability-claimed' })).killed, true);
    // A settles first (B's orphan is not A's, so it is left claimed), then both retry concurrently in separate processes.
    assert.equal((await register(a, witness, issue(a, witness).request)).outcome, 'registered');
    assert.equal(await ledgerState(a.paths.ledger, ia.capability.capabilityId), 'failed');
    assert.equal(await ledgerState(a.paths.ledger, ib.capability.capabilityId), 'claimed', 'B’s orphan is B’s to settle');
    const [rb, again] = await Promise.all([runChild(b, witness, { operation: 'register', request: issue(b, witness).request }), register(a, witness, issue(a, witness).request)]);
    assert.equal(rb.outcome, 'registered', JSON.stringify(rb));
    assert.equal(again.reason, 'ALREADY_REGISTERED');
    assert.equal(await ledgerState(a.paths.ledger, ib.capability.capabilityId), 'failed');
    assert.deepEqual((await fvSlots(witness)).map(([org]) => org).sort(), [ORG_A, ORG_B], 'one genesis each');
  });

  it('a claim the ledger refused is not this record’s: a later registration on the same record leaves it unchanged', async () => {
    const { witness, a } = await sharedLedger();
    const ia = issue(a, witness);
    // Consumed by a ceremony that died before recording anything, whose record is then lost.
    assert.equal((await runChild(a, witness, { operation: 'register', request: ia.request, killAt: 'capability-claimed' })).killed, true);
    rmSync(a.paths.record);
    // The same capability presented again: refused by the ledger (single use); the refusal is recorded.
    assert.deepEqual(await register(a, witness, ia.request), { outcome: 'refused', reason: 'CAPABILITY_NOT_CLAIMED', detail: 'CAPABILITY_CONSUMED' });
    // A new capability registers; the refused claim is never inferred to be this record's.
    assert.equal((await register(a, witness, issue(a, witness).request)).outcome, 'registered');
    assert.equal(await ledgerState(a.paths.ledger, ia.capability.capabilityId), 'claimed');
  });

  it('cross-organization: B’s capability is refused at A’s registrar before anything is claimed; a consumed capability never registers twice', async () => {
    const { witness, a, b } = await sharedLedger();
    const ib = issue(b, witness);
    const atA = await register(a, witness, { ...ib.request });
    assert.equal(atA.reason, 'CAPABILITY_REJECTED', JSON.stringify(atA));
    assert.equal((await register(b, witness, ib.request)).outcome, 'registered', 'B’s capability was not consumed by the attempt at A');
    assert.equal((await register(b, witness, ib.request)).reason, 'ALREADY_REGISTERED');
    assert.deepEqual((await ledgerRows(a.paths.ledger)).map((r) => [r.organizationId, r.state]), [[ORG_B, 'completed']]);
  });
});
