import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DelegatedOfferCapabilityError } from '../authority-authenticity/delegated-offer-capability-issuer.js';
import { closeAllWitnesses } from './core07-freshness-fixture.js';
import { executorRig, rawProposal, validatedAction } from './trade04c-execution-fixture.js';
import { testCapabilityIssuer } from './trade04c-s1-capability-fixture.js';

/**
 * TRADE-04D H-1 — mutation qualification of the post-intent outcome mapping.
 * Each mutant edits the compiled executor at one site and must be
 * **detected** by its guard (the guard holds for the shipped module and fails
 * for the mutant). A mutant that survives fails this suite.
 */

const load = createRequire(__filename);
const ENTERPRISE = join(__dirname, '..');
after(async () => {
  await closeAllWitnesses();
});

type ExecutorModule = typeof import('../xrpl-trade-execution/trade-offer-executor.js');
const EXECUTOR = 'xrpl-trade-execution/trade-offer-executor.js';

interface Mutant {
  readonly id: string;
  readonly replacements: readonly (readonly [string, string])[];
  readonly guard: (module: ExecutorModule) => Promise<boolean>;
}

async function qualify(mutant: Mutant): Promise<void> {
  const path = join(ENTERPRISE, EXECUTOR);
  let source = readFileSync(path, 'utf8');
  for (const [search, replace] of mutant.replacements) {
    assert.equal(source.split(search).length - 1, 1, `${mutant.id}: the mutation site occurs exactly once in ${EXECUTOR}: ${search.slice(0, 100)}`);
    source = source.split(search).join(replace);
  }
  const mutantPath = path.replace(/\.js$/, `.mutant-${mutant.id}.js`);
  writeFileSync(mutantPath, source);
  try {
    assert.equal(await mutant.guard(load(path) as ExecutorModule), true, `${mutant.id}: the guard holds for the shipped module`);
    assert.equal(await mutant.guard(load(mutantPath) as ExecutorModule), false, `${mutant.id}: the guard detects the mutation`);
  } finally {
    delete load.cache[load.resolve(mutantPath)];
    rmSync(mutantPath, { force: true });
  }
}

/** One order through an executor built from `m`, with the given issuer and adapter wrapper; answers the outcome. */
async function outcomeOf(m: ExecutorModule, options: { readonly issuer?: ReturnType<typeof testCapabilityIssuer>; readonly wrap?: (options: Parameters<ExecutorModule['createTradeOfferExecutionAdapter']>[0]) => Parameters<ExecutorModule['createTradeOfferExecutionAdapter']>[0] } = {}): Promise<string> {
  const rig = await executorRig({ issuer: options.issuer ?? testCapabilityIssuer(), create: (adapterOptions) => m.createTradeOfferExecutionAdapter(options.wrap === undefined ? adapterOptions : options.wrap(adapterOptions)) });
  try {
    const raw = rawProposal(rig.pairs[0]!);
    rig.book.attest(raw);
    return (await rig.adapter.execute(validatedAction(raw))).outcome;
  } finally {
    await rig.close();
  }
}

/** The signer signed; its answer never reached the Host. */
const responseLost = (options: Parameters<ExecutorModule['createTradeOfferExecutionAdapter']>[0]) => ({
  ...options,
  signer: {
    signDelegatedOffer: async (request: Parameters<typeof options.signer.signDelegatedOffer>[0]) => {
      await options.signer.signDelegatedOffer(request);
      throw new Error('lost');
    },
  },
});

describe('TRADE-04D H-1 mutations — the post-intent outcome mapping', () => {
  const mutants: readonly Mutant[] = [
    {
      id: 'uncertain-refusal-reported-failed',
      replacements: [["return finish(Object.freeze({ outcome: 'unconfirmed', detail: refusal.detail }));", 'return finish(failed(refusal.reason, refusal.detail));']],
      guard: async (m) => (await outcomeOf(m, { wrap: responseLost })) === 'unconfirmed',
    },
    {
      id: 'certainty-flag-never-raised',
      replacements: [['capabilityMayExist = true;', 'capabilityMayExist = false;']],
      guard: async (m) => (await outcomeOf(m, { wrap: responseLost })) === 'unconfirmed',
    },
    {
      id: 'issuance-timeout-treated-as-proven-non-issuance',
      replacements: [["'CAPABILITY_GRANT_REVOKED',", "'CAPABILITY_GRANT_REVOKED', 'CAPABILITY_SIGNING_UNAVAILABLE',"]],
      guard: async (m) => (await outcomeOf(m, { issuer: testCapabilityIssuer({ refuse: () => new DelegatedOfferCapabilityError('CAPABILITY_SIGNING_UNAVAILABLE', 'timed out') }) })) === 'unconfirmed',
    },
    {
      id: 'proven-refusal-reported-uncertain',
      replacements: [['CAPABILITY_NEVER_REQUESTED.has(code))', 'CAPABILITY_NEVER_REQUESTED.has(code) && false)']],
      guard: async (m) => (await outcomeOf(m, { issuer: testCapabilityIssuer({ refuse: () => new DelegatedOfferCapabilityError('CAPABILITY_GRANT_REVOKED', 'revoked') }) })) === 'failed',
    },
    {
      id: 'certainty-flag-raised-before-the-intent',
      replacements: [['let capabilityMayExist = false;', 'let capabilityMayExist = true;']],
      guard: async (m) =>
        (await outcomeOf(m, {
          wrap: (options) => ({
            ...options,
            interlock: {
              ...options.interlock,
              recordIntent: async () => {
                throw new Error('the intent was never recorded');
              },
            },
          }),
        })) === 'failed',
    },
  ];
  for (const mutant of mutants) it(`detected: ${mutant.id}`, () => qualify(mutant));
});
