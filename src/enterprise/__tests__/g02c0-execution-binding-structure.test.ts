import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { EXECUTION_CAPABILITY_FIELDS, EXECUTION_CAPABILITY_FORMAT } from '../execution-capability/index.js';
import { EXECUTION_CAPABILITY_ISSUER_FAILURES } from '../execution-capability-issuance/index.js';
import { GENERIC_HTTP_REQUEST_BINDING_FORMAT } from '../execution-adapters/generic-http/request-binding.js';

/**
 * G-02C0 structure: the gate is internal and opt-in, composed only by the
 * composition root; the adapter hook can only stop a request, runs after the
 * mapping and before DNS, and is reached through no public surface; nothing
 * presents a capability; the protected contracts are unchanged. Measured
 * against source (comments stripped), never a line number.
 */

const GATE_DIR = 'src/enterprise/execution-capability-gate';
const GENERIC_HTTP = 'src/enterprise/execution-adapters/generic-http';

function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => {
      const index = line.indexOf('//');
      return index === -1 ? line : line.slice(0, index);
    })
    .join('\n');
}

function sourcesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === '__tests__' || name === 'tests') continue;
      out.push(...sourcesUnder(path));
    } else if (path.endsWith('.ts')) {
      out.push(path.replace(/\\/g, '/'));
    }
  }
  return out.sort();
}

const PRODUCTION = ['src/enterprise', 'src/features', 'src/kernel', 'src/runtime'].flatMap(sourcesUnder);

describe('G-02C0 structure — the gate is internal, opt-in and composed only by the composition root', () => {
  it('the measured sources exist', () => {
    assert.deepEqual(sourcesUnder(GATE_DIR), [`${GATE_DIR}/gate.ts`, `${GATE_DIR}/index.ts`]);
    assert.ok(existsSync(`${GENERIC_HTTP}/request-binding.ts`));
  });

  it('only the composition root imports the gate', () => {
    const importers = PRODUCTION.filter((file) => !file.startsWith(`${GATE_DIR}/`) && /from ['"][^'"]*execution-capability-gate\//.test(codeOf(file)));
    assert.deepEqual(importers, ['src/enterprise/composition/composition-root.ts']);
  });

  it('only the composition root builds a gated adapter, and neither the gated factory, the hook nor the binding leaves the Generic HTTP module', () => {
    const builders = PRODUCTION.filter((file) => /createGenericHttpExecutionAdapterWithPreSendGates\s*\(/.test(codeOf(file)) && !file.startsWith(`${GENERIC_HTTP}/`));
    assert.deepEqual(builders, ['src/enterprise/composition/composition-root.ts']);
    const index = codeOf(`${GENERIC_HTTP}/index.ts`);
    for (const name of ['createGenericHttpExecutionAdapterWithPreSendGates', 'GenericHttpPreSendGate', 'request-binding', 'genericHttpRequestBinding']) assert.equal(index.includes(name), false, name);
    for (const file of ['src/enterprise/index.ts', 'src/index.ts', ...sourcesUnder('src/enterprise/api'), ...sourcesUnder('src/enterprise/adapters')]) {
      assert.equal(/PreSendGate|execution-capability-gate|request-binding|ExecutionCapabilityGate/.test(codeOf(file)), false, file);
    }
  });

  it('the Host composes no gate without the issuance section: the gate list comes only from executionCapabilities.adapters', () => {
    const root = codeOf('src/enterprise/composition/composition-root.ts');
    assert.equal(root.split('createExecutionCapabilityGate(').length - 1, 1, 'one construction site');
    assert.ok(root.includes('options.authorityControlledExecution?.executionCapabilities?.adapters'));
    assert.ok(root.includes('preSendGates.size === 0 ? createGenericHttpExecutionAdapter(entry)'), 'with no gate listed the adapters are built exactly as before');
    // Bound to the same emergency-control reader every other checkpoint reads.
    assert.ok(root.includes('gate.bind({ issuerKey: capabilityGateIssuerKey, emergencyControl })'));
  });
});

describe('G-02C0 structure — the hook can stop a request and never change one', () => {
  const adapter = codeOf(`${GENERIC_HTTP}/generic-http-execution-adapter.ts`);

  it('the verdict carries nothing but proceed', () => {
    const declaration = /export type GenericHttpPreSendVerdict = ([^;]*);/.exec(adapter)?.[1] ?? '';
    assert.equal(declaration.trim(), '{ readonly proceed: true } | { readonly proceed: false }');
    const subject = /export interface GenericHttpPreSendSubject \{([\s\S]*?)\n\}/.exec(adapter)?.[1] ?? '';
    assert.deepEqual([...subject.matchAll(/readonly (\w+)/g)].map((match) => match[1]), ['adapterId', 'action', 'binding'], 'no request, header, credential or runtime is handed to a gate');
  });

  it('the gate is called once, after mapping and before resolution, and the request sent is the request bound', () => {
    assert.equal(adapter.split('await gate(').length - 1, 1);
    const mapping = adapter.indexOf('mapGenericHttpRequest(plan, action)');
    const gating = adapter.indexOf('await gate(');
    const resolution = adapter.indexOf('runtime.resolve(');
    const sending = adapter.indexOf('runtime.send(mapped.request');
    assert.ok(mapping > 0 && mapping < gating && gating < resolution && resolution < sending, 'map → gate → resolve → send');
    assert.ok(adapter.includes('genericHttpRequestBinding(plan, mapped.request)'), 'the binding is computed from the object that is sent');
    assert.equal(adapter.split('mapGenericHttpRequest(').length - 1, 1, 'the request is mapped once — no re-mapping for the gate');
  });

  it('the binding module is pure and imports nothing at runtime', () => {
    const binding = codeOf(`${GENERIC_HTTP}/request-binding.ts`);
    const runtimeImports = [...binding.matchAll(/^import (?!type)[^;]*;/gm)];
    assert.deepEqual(runtimeImports, []);
    assert.equal(/Date\.|process\.|require\(|await |fetch\(/.test(binding), false);
    assert.equal(GENERIC_HTTP_REQUEST_BINDING_FORMAT, 'frontera.http-request-binding.v1');
    // Exactly one exclusion: the credential header, by name.
    assert.equal(binding.split('.filter(').length - 1, 1);
    assert.ok(binding.includes('.filter(([name]) => credentialHeader === undefined || name !== credentialHeader)'));
  });
});

describe('G-02C0 structure — the gate issues, verifies and withholds; it presents nothing and holds no signing capability', () => {
  const gate = codeOf(`${GATE_DIR}/gate.ts`);

  it('every answer of the gate is PROCEED or WITHHOLD — no capability, signature or request leaves it', () => {
    const body = gate.slice(gate.indexOf('async function beforeSend'), gate.indexOf('return Object.freeze({'));
    const answers = [...body.matchAll(/\breturn\s+([A-Za-z_]+)/g)].map((match) => match[1]);
    assert.ok(answers.length >= 6);
    assert.deepEqual([...new Set(answers)].sort(), ['PROCEED', 'WITHHOLD']);
    assert.equal(body.split('return PROCEED').length - 1, 1, 'one way through');
  });

  it('issues once, then verifies, then re-reads the stop — in that order', () => {
    const issue = gate.indexOf('await issuer.issue(');
    const verify = gate.indexOf('bound.verifier.verify(');
    const stop = gate.indexOf('readEmergencyControl(');
    const proceed = gate.indexOf('return PROCEED');
    assert.equal(gate.split('issuer.issue(').length - 1, 1);
    assert.ok(issue > 0 && issue < verify && verify < stop && stop < proceed);
    assert.equal(gate.slice(stop, proceed).includes('await '), false, 'nothing is awaited between the stop re-check and proceeding');
  });

  it('holds no signer, key material, network client or adapter invocation', () => {
    for (const file of sourcesUnder(GATE_DIR)) {
      const code = codeOf(file);
      assert.equal(/AuthorityArtifactSigner|createSoftwareAuthorityArtifactSigner|signExecutionCapability|signGrant|privateKeyPem|createPrivateKey|node:https|node:net|node:dns|\.execute\(|runtime\.send/.test(code), false, file);
    }
  });

  it('the gate verifies with the standalone executor verifier, pinned to one issuer and one key', () => {
    assert.ok(gate.includes('createExecutionCapabilityVerifier({'));
    assert.ok(gate.includes('trustedIssuers: [{ issuer: policy.issuer, keys: [next.issuerKey] }]'));
  });
});

describe('G-02C0 structure — protected contracts are unchanged', () => {
  it('the G-02A wire contract: format and fields', () => {
    assert.equal(EXECUTION_CAPABILITY_FORMAT, 'frontera.execution-capability.v1');
    assert.equal(EXECUTION_CAPABILITY_FIELDS.length, 18);
  });

  it('the G-02B issuer contract: its failure vocabulary and its input', () => {
    assert.equal(EXECUTION_CAPABILITY_ISSUER_FAILURES.length, 13);
    const issuer = codeOf('src/enterprise/execution-capability-issuance/issuer.ts');
    const input = /export interface ExecutionCapabilityIssuanceInput \{([\s\S]*?)\n\}/.exec(issuer)?.[1] ?? '';
    assert.deepEqual([...input.matchAll(/readonly (\w+)/g)].map((match) => match[1]), ['executionId', 'boundedGrantId', 'audience', 'action', 'resource', 'actionBinding', 'format', 'digest']);
  });

  it('the validated execution action carries no capability, binding or digest', () => {
    const port = codeOf('src/features/execution-runtime/domain/execution-adapter-port.ts');
    const action = /export interface ValidatedExecutionAction \{([\s\S]*?)\n\}/.exec(port)?.[1] ?? '';
    assert.ok(action.includes('boundedGrantId'));
    assert.equal(/capabilit|binding|digest/i.test(action), false);
  });

  it('no Kernel, orchestrator, exercise gate, registry, P11 or P12 module names the gate or the hook', () => {
    for (const root of ['src/kernel', 'src/enterprise/governed-action', 'src/features/execution-runtime', 'src/enterprise/execution-outcome-store', 'src/enterprise/execution-resolution-store', 'src/enterprise/execution-reconciliation']) {
      for (const file of sourcesUnder(root)) assert.equal(/PreSendGate|beforeSend|execution-capability-gate|request-binding/.test(codeOf(file)), false, file);
    }
  });
});
