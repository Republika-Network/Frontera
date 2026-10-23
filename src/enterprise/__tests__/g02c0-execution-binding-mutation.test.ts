import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createEmergencyControlReader, createInMemoryEmergencyControlStore } from '../../features/emergency-control-runtime/index.js';
import type { ValidatedExecutionAction } from '../../features/execution-runtime/index.js';
import type { AuthoritySignature } from '../authority-authenticity/index.js';
import { GENERIC_HTTP_REQUEST_BINDING_FORMAT, genericHttpRequestBinding } from '../execution-adapters/generic-http/request-binding.js';
import { mapGenericHttpRequest, type GenericHttpWireRequest } from '../execution-adapters/generic-http/request-mapper.js';
import { createExecutionCapabilityGate } from '../execution-capability-gate/index.js';
import { executionCapabilityActionBindingDigest, serializeExecutionCapability, type ExecutionCapability } from '../execution-capability/index.js';
import { createExecutionCapabilityIssuer, type ExecutionCapabilityIssuer } from '../execution-capability-issuance/index.js';
import { AUTHORITY_KEY_A, AUTHORITY_KEY_B, testVerifier, trustedKeyOf } from './authority-authenticity-fixture.js';
import { G02B_AUDIENCE, LedgerDirectory, NOW, POLICY, capabilityFor, custodySigner, readerOf, signCapabilityBytes, signedGrant, type SignedGrant } from './g02b-execution-capability-issuance-fixture.js';
import { CREDENTIAL_TOKEN, GATED_ADAPTER_ID, actionFor, countingNetwork, gatedPlan, recordingGate } from './g02c0-execution-binding-fixture.js';

/**
 * G-02C0 mutation qualification, in G-02A's and G-02B's manner: each
 * load-bearing control is removed from the **compiled** module, the mutant is
 * loaded beside the original, and the guarding property must hold for the
 * original and fail for the mutant. Every guard presents a case whose every
 * *other* check agrees, so only the mutated control stands between it and
 * acceptance. Mutation sites name only module-local identifiers and never span
 * a line break the emitter introduces.
 *
 * The verifier's own checks (signature, window, audience, action, resource,
 * binding digest) are G-02A's and qualified there; here the gate's use of the
 * verifier is mutated, not the verifier.
 */

const load = createRequire(__filename);
const ROOT = join(__dirname, '..');
const ledgers = new LedgerDirectory();
after(() => ledgers.cleanup());

interface Mutant<M> {
  readonly id: string;
  readonly file: string;
  readonly replacements: readonly (readonly [string, string])[];
  readonly guard: (module: M) => boolean | Promise<boolean>;
}

async function qualify<M>(mutant: Mutant<M>): Promise<void> {
  const path = join(ROOT, mutant.file);
  let source = readFileSync(path, 'utf8');
  for (const [search, replace] of mutant.replacements) {
    assert.equal(source.split(search).length - 1, 1, `${mutant.id}: the mutation site must occur exactly once in ${mutant.file}: ${search.slice(0, 60)}`);
    source = source.replace(search, replace);
  }
  const mutantPath = path.replace(/\.js$/, `.mutant-g02c0-${mutant.id}.js`);
  writeFileSync(mutantPath, source);
  try {
    assert.equal(await mutant.guard(load(path) as M), true, `${mutant.id}: the guard holds for the shipped module`);
    assert.equal(await mutant.guard(load(mutantPath) as M), false, `${mutant.id}: the guard detects the removed control`);
  } finally {
    delete load.cache[load.resolve(mutantPath)];
    rmSync(mutantPath, { force: true });
  }
}

function requestOf(action: ValidatedExecutionAction): GenericHttpWireRequest {
  const mapped = mapGenericHttpRequest(gatedPlan(), action);
  assert.ok(mapped.ok);
  return mapped.request;
}

const digestOf = (request: GenericHttpWireRequest): string => executionCapabilityActionBindingDigest({ format: GENERIC_HTTP_REQUEST_BINDING_FORMAT, value: genericHttpRequestBinding(gatedPlan(), request) });

/** An in-process issuer that returns `capability` under `key`'s signature, with no ledger: a defect or a compromise above the gate. */
function forgedIssuer(capability: ExecutionCapability, key = AUTHORITY_KEY_A): ExecutionCapabilityIssuer {
  return { issue: async () => ({ capability, canonical: serializeExecutionCapability(capability), signature: signCapabilityBytes(capability, key) as AuthoritySignature }), inspect: () => 'absent' };
}

function exactBinding(action: ValidatedExecutionAction): { readonly actionBinding: { readonly format: string; readonly digest: string } } {
  return { actionBinding: { format: GENERIC_HTTP_REQUEST_BINDING_FORMAT, digest: digestOf(requestOf(action)) } };
}

// ── The gate ────────────────────────────────────────────────────────────────

type GateModule = typeof import('../execution-capability-gate/gate.js');
const GATE = join('execution-capability-gate', 'gate.js');

/** Does the gate built by `m` over `issuer` (and `emergency`) let `action` proceed? */
async function proceeds(m: GateModule, issuer: Pick<ExecutionCapabilityIssuer, 'issue'>, action: ValidatedExecutionAction, options: { readonly adapterId?: string; readonly emergency?: ReturnType<typeof createInMemoryEmergencyControlStore> } = {}): Promise<boolean> {
  const gate = m.createExecutionCapabilityGate({ adapterId: GATED_ADAPTER_ID, audience: G02B_AUDIENCE, policy: POLICY, issuer, clock: () => NOW });
  gate.bind({ issuerKey: trustedKeyOf(AUTHORITY_KEY_A), emergencyControl: options.emergency === undefined ? undefined : createEmergencyControlReader(options.emergency) });
  const verdict = await gate.beforeSend({ adapterId: options.adapterId ?? GATED_ADAPTER_ID, action, binding: genericHttpRequestBinding(gatedPlan(), requestOf(action)) });
  return verdict.proceed;
}

async function realIssuer(signed: SignedGrant, before?: () => void): Promise<ExecutionCapabilityIssuer> {
  const base = custodySigner();
  const signer = {
    ...base,
    signExecutionCapability: async (request: Parameters<NonNullable<typeof base.signExecutionCapability>>[0]): Promise<AuthoritySignature> => {
      before?.();
      return base.signExecutionCapability!(request);
    },
  };
  return createExecutionCapabilityIssuer({ grants: readerOf([signed]), signer, verifier: testVerifier([AUTHORITY_KEY_A]), policy: POLICY, ledger: await ledgers.create(), now: () => NOW });
}

describe('G-02C0 mutation — the gate', () => {
  const mutants: readonly Mutant<GateModule>[] = [
    {
      id: 'skip-post-issuance-verification',
      file: GATE,
      replacements: [
        ["if (verdict.verification !== 'verified')", 'if (false)'],
        ['const capability = verdict.capability;', 'const capability = issued.capability;'],
      ],
      // Exact in every field, signed by a key the gate does not pin: only verification refuses it.
      guard: async (m) => {
        const signed = await signedGrant();
        const action = actionFor(signed);
        return !(await proceeds(m, forgedIssuer(capabilityFor(signed, exactBinding(action), { key: AUTHORITY_KEY_B }).capability, AUTHORITY_KEY_B), action));
      },
    },
    {
      id: 'skip-execution-equality',
      file: GATE,
      replacements: [['if (capability.executionId !== executionId)', 'if (false)']],
      // The verifier does not know the execution; only the gate's comparison refuses another one.
      guard: async (m) => {
        const signed = await signedGrant();
        const action = actionFor(signed);
        return !(await proceeds(m, forgedIssuer(capabilityFor(signed, { ...exactBinding(action), executionId: 'aoc.exec:00000000000000000000000000000000' }).capability), action));
      },
    },
    {
      id: 'skip-subject-equality',
      file: GATE,
      replacements: [['if (capability.subjectActorId !== action.subject)', 'if (false)']],
      guard: async (m) => {
        const signed = await signedGrant();
        const action = actionFor(signed);
        return !(await proceeds(m, forgedIssuer(capabilityFor(signed, { ...exactBinding(action), subjectActorId: 'actor-intruder' }).capability), action));
      },
    },
    {
      id: 'skip-action-window',
      file: GATE,
      replacements: [['if (!(Date.parse(capability.expiresAt) <= Date.parse(action.notAfter)))', 'if (false)']],
      guard: async (m) => {
        const signed = await signedGrant();
        const action = actionFor(signed, { notAfter: new Date(NOW + 10_000).toISOString() });
        return !(await proceeds(m, forgedIssuer(capabilityFor(signed, exactBinding(action)).capability), action));
      },
    },
    {
      id: 'skip-post-issuance-emergency-recheck',
      file: GATE,
      replacements: [['if (!permitted)', 'if (false)']],
      // The stop is declared while custody signs: before issuance it was clear.
      guard: async (m) => {
        const signed = await signedGrant();
        const emergency = createInMemoryEmergencyControlStore();
        const issuer = await realIssuer(signed, () => emergency.activate({ scope: 'adapter', value: GATED_ADAPTER_ID, issuerRef: 'operator:g02c0', declaredAt: new Date(NOW).toISOString() }));
        return !(await proceeds(m, issuer, actionFor(signed), { emergency }));
      },
    },
    {
      id: 'skip-adapter-identity',
      file: GATE,
      replacements: [['if (subject.adapterId !== adapterId)', 'if (false)']],
      guard: async (m) => {
        const signed = await signedGrant();
        return !(await proceeds(m, await realIssuer(signed), actionFor(signed), { adapterId: 'another.adapter' }));
      },
    },
    {
      id: 'bind-another-value',
      file: GATE,
      replacements: [['value: subject.binding }', 'value: {} }']],
      // Issuance and self-verification would agree with each other; the capability must bind the request.
      guard: async (m) => {
        const signed = await signedGrant();
        const action = actionFor(signed);
        let bound: string | undefined;
        const issuer = await realIssuer(signed);
        const spy = {
          issue: async (input: Parameters<ExecutionCapabilityIssuer['issue']>[0]) => {
            bound = input.actionBinding.digest;
            return issuer.issue(input);
          },
        };
        return (await proceeds(m, spy, action)) && bound === digestOf(requestOf(action));
      },
    },
    {
      id: 'audience-format-not-checked',
      file: GATE,
      replacements: [['if (!registered.bindingFormats.includes(', 'if (false && !registered.bindingFormats.includes(']],
      guard: (m) => {
        const policy = { ...POLICY, audiences: [{ audience: G02B_AUDIENCE, actions: ['deploy-release'], bindingFormats: ['frontera.other-binding.v1'] }] };
        try {
          m.createExecutionCapabilityGate({ adapterId: GATED_ADAPTER_ID, audience: G02B_AUDIENCE, policy, issuer: { issue: () => Promise.reject(new Error('unused')) } });
          return false;
        } catch {
          return true;
        }
      },
    },
  ];
  for (const mutant of mutants) it(mutant.id, () => qualify(mutant));

  it('control: the shipped gate proceeds for the exact capability (each guard above is discriminating)', async () => {
    const signed = await signedGrant();
    const action = actionFor(signed);
    const m = load(join(ROOT, GATE)) as GateModule;
    assert.equal(await proceeds(m, forgedIssuer(capabilityFor(signed, exactBinding(action)).capability), action), true);
    assert.equal(typeof createExecutionCapabilityGate, 'function');
  });
});

// ── The adapter hook ────────────────────────────────────────────────────────

type AdapterModule = typeof import('../execution-adapters/generic-http/generic-http-execution-adapter.js');
const ADAPTER = join('execution-adapters', 'generic-http', 'generic-http-execution-adapter.js');

async function sendsWith(m: AdapterModule, verdict: unknown): Promise<number> {
  const network = countingNetwork();
  const { gate } = recordingGate(verdict);
  await m.createGenericHttpExecutionAdapterCore(gatedPlan(), network, gate).execute(actionFor(await signedGrant()));
  return network.sent.length;
}

describe('G-02C0 mutation — the adapter hook', () => {
  const mutants: readonly Mutant<AdapterModule>[] = [
    { id: 'send-despite-refusal', file: ADAPTER, replacements: [['if (!proceeds(verdict))', 'if (false)']], guard: async (m) => (await sendsWith(m, { proceed: false })) === 0 },
    { id: 'truthy-verdict', file: ADAPTER, replacements: [['descriptor.value === true;', '!!descriptor.value;']], guard: async (m) => (await sendsWith(m, { proceed: 'true' })) === 0 && (await sendsWith(m, { proceed: 1 })) === 0 },
    {
      id: 'inherited-or-accessor-verdict',
      file: ADAPTER,
      replacements: [["return descriptor !== undefined && 'value' in descriptor && descriptor.value === true;", 'return verdict.proceed === true;']],
      guard: async (m) => (await sendsWith(m, Object.create({ proceed: true }))) === 0 && (await sendsWith(m, Object.defineProperty({}, 'proceed', { get: () => true }))) === 0,
    },
    {
      id: 'bind-a-copy-not-the-sent-request',
      file: ADAPTER,
      replacements: [['(plan, mapped.request)', '(plan, { ...mapped.request, body: undefined })']],
      guard: async (m) => {
        const network = countingNetwork();
        const { gate, seen } = recordingGate({ proceed: true });
        await m.createGenericHttpExecutionAdapterCore(gatedPlan(), network, gate).execute(actionFor(await signedGrant()));
        const sent = network.sent[0];
        return sent !== undefined && seen[0] !== undefined && digestOf(sent) === executionCapabilityActionBindingDigest({ format: GENERIC_HTTP_REQUEST_BINDING_FORMAT, value: seen[0].binding });
      },
    },
  ];
  for (const mutant of mutants) it(mutant.id, () => qualify(mutant));
});

// ── The binding record ──────────────────────────────────────────────────────

type BindingModule = typeof import('../execution-adapters/generic-http/request-binding.js');
const BINDING = join('execution-adapters', 'generic-http', 'request-binding.js');

async function baseRequest(): Promise<GenericHttpWireRequest> {
  return requestOf(actionFor(await signedGrant()));
}

const digestUnder = (m: BindingModule, request: GenericHttpWireRequest): string => executionCapabilityActionBindingDigest({ format: GENERIC_HTTP_REQUEST_BINDING_FORMAT, value: m.genericHttpRequestBinding(gatedPlan(), request) });

describe('G-02C0 mutation — the binding record', () => {
  const mutants: readonly Mutant<BindingModule>[] = [
    { id: 'credential-in-binding', file: BINDING, replacements: [['.filter(([name]) => credentialHeader === undefined || name !== credentialHeader)', '.filter(() => true)']], guard: async (m) => !JSON.stringify(m.genericHttpRequestBinding(gatedPlan(), await baseRequest())).includes(CREDENTIAL_TOKEN) },
    {
      id: 'body-unbound',
      file: BINDING,
      replacements: [['body: request.body ?? null,', 'body: null,']],
      guard: async (m) => {
        const request = await baseRequest();
        return digestUnder(m, request) !== digestUnder(m, { ...request, body: (request.body ?? '').replace('7500', '75000') });
      },
    },
    {
      id: 'target-unbound',
      file: BINDING,
      replacements: [['target: request.path,', "target: '',"]],
      guard: async (m) => {
        const request = await baseRequest();
        return digestUnder(m, request) !== digestUnder(m, { ...request, path: request.path.replace('rolling', 'recreate') });
      },
    },
    {
      id: 'headers-unbound',
      file: BINDING,
      replacements: [['headers: Object.freeze(headers),', 'headers: Object.freeze([]),']],
      guard: async (m) => {
        const request = await baseRequest();
        return digestUnder(m, request) !== digestUnder(m, { ...request, headers: request.headers.map(([name, value]) => [name, name === 'x-counterparty' ? 'vendor-6666' : value] as const) });
      },
    },
    {
      id: 'port-unbound',
      file: BINDING,
      replacements: [['port: request.port })', 'port: 443 })']],
      guard: async (m) => {
        const request = await baseRequest();
        return digestUnder(m, request) !== digestUnder(m, { ...request, port: 8443 });
      },
    },
    {
      id: 'hostname-unbound',
      file: BINDING,
      replacements: [['hostname: request.hostname,', "hostname: '',"]],
      guard: async (m) => {
        const request = await baseRequest();
        return digestUnder(m, request) !== digestUnder(m, { ...request, hostname: 'api.attacker.example' });
      },
    },
    {
      id: 'method-unbound',
      file: BINDING,
      replacements: [['method: request.method,', "method: 'POST',"]],
      guard: async (m) => {
        const request = await baseRequest();
        return digestUnder(m, request) !== digestUnder(m, { ...request, method: 'DELETE' });
      },
    },
    { id: 'excluded-name-unrecorded', file: BINDING, replacements: [['credentialHeader: credentialHeader ?? null,', 'credentialHeader: null,']], guard: async (m) => m.genericHttpRequestBinding(gatedPlan(), await baseRequest()).credentialHeader === 'authorization' },
  ];
  for (const mutant of mutants) it(mutant.id, () => qualify(mutant));
});
