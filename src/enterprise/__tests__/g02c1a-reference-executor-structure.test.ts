import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { EXECUTION_CAPABILITY_FIELDS, EXECUTION_CAPABILITY_SIGNING_DOMAIN } from '../execution-capability/index.js';
import { GENERIC_HTTP_REQUEST_BINDING_FORMAT, genericHttpRequestBindingOf } from '../execution-adapters/generic-http/request-binding.js';
import { REFERENCE_EXECUTOR_HTTP_BINDING_FORMAT, admitHttpRequest, parseReferenceExecutorConfiguration, reconstructHttpRequestBinding } from '../reference-executor/index.js';
import { EXECUTOR_ENVIRONMENT, executorConfiguration, hostVector, observedWith } from './g02c1a-reference-executor-fixture.js';

/**
 * G-02C1A structure: the executor stands alone, signs nothing, holds no
 * ledger and no effect, adds no Host surface, and leaves every protected
 * contract as it was. Measured against source, never a line number.
 */

const EXECUTOR = 'src/enterprise/reference-executor';
const PRESENTATION = 'src/enterprise/execution-capability-presentation';

function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

function sourcesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== '__tests__') out.push(...sourcesUnder(path));
    } else if (path.endsWith('.ts')) out.push(path.replace(/\\/g, '/'));
  }
  return out.sort();
}

/** Runtime import specifiers of a file: type-only imports load nothing and are skipped. */
function runtimeSpecifiers(file: string): string[] {
  const code = codeOf(file).replace(/\b(?:import|export)\s+type\b[\s\S]*?\bfrom\s*['"][^'"]+['"]/g, ' ');
  return [...code.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g)].map((match) => match[1] ?? '').filter((specifier) => specifier.length > 0);
}

function closureOf(entries: readonly string[]): { readonly files: ReadonlySet<string>; readonly bare: ReadonlySet<string> } {
  const files = new Set<string>();
  const bare = new Set<string>();
  const pending = [...entries];
  while (pending.length > 0) {
    const file = pending.pop() as string;
    if (files.has(file)) continue;
    files.add(file);
    for (const specifier of runtimeSpecifiers(file)) {
      if (!specifier.startsWith('.')) {
        bare.add(specifier);
        continue;
      }
      const target = normalize(join(dirname(file), specifier)).replace(/\\/g, '/');
      const resolved = target.endsWith('.js') ? `${target.slice(0, -3)}.ts` : `${target}/index.ts`;
      assert.ok(existsSync(resolved), `${file} imports ${specifier}, resolved to ${resolved}`);
      pending.push(resolved);
    }
  }
  return { files, bare };
}

const PRODUCTION = [...sourcesUnder('src')];

describe('G-02C1A structure — the executor stands alone', () => {
  const closure = closureOf([`${EXECUTOR}/index.ts`]);
  // G-02C1B: the verification path itself — what verification-only mode runs — is the G-02C1A closure, unchanged.
  const verificationPath = closureOf([`${EXECUTOR}/admission.ts`, `${EXECUTOR}/binding-reconstruction.ts`, `${EXECUTOR}/configuration.ts`, `${EXECUTOR}/gateway.ts`, `${EXECUTOR}/verification-pipeline.ts`]);

  it('the verification path loads exactly its own modules, the presentation codec, the G-02A verifier and codec, the CORE-02 verification primitives and canonical JSON', () => {
    assert.deepEqual([...verificationPath.files].sort(), [
      'src/enterprise/authority-authenticity/errors.ts',
      'src/enterprise/authority-authenticity/signature-envelope.ts',
      'src/enterprise/authority-authenticity/signature-verification.ts',
      'src/enterprise/execution-capability-presentation/index.ts',
      'src/enterprise/execution-capability-presentation/presentation.ts',
      'src/enterprise/execution-capability/capability.ts',
      'src/enterprise/execution-capability/index.ts',
      'src/enterprise/execution-capability/verifier.ts',
      'src/enterprise/governance-store/canonical-json.ts',
      'src/enterprise/governance-store/digest.ts',
      `${EXECUTOR}/admission.ts`,
      `${EXECUTOR}/binding-reconstruction.ts`,
      `${EXECUTOR}/configuration.ts`,
      `${EXECUTOR}/gateway.ts`,
      `${EXECUTOR}/verification-pipeline.ts`,
    ]);
    assert.deepEqual([...verificationPath.bare].sort(), ['node:crypto', 'node:http', 'node:path']);
    assert.equal(verificationPath.files.has('src/enterprise/execution-capability/reference/consumption-ledger.ts'), false, 'the verification path holds no consumption ledger');
  });

  it('the whole executor adds only the launcher, the G-02C1B execution flow and synthetic effect, and the G-02A reference ledger', () => {
    assert.deepEqual([...closure.files].sort(), [
      'src/enterprise/authority-authenticity/errors.ts',
      'src/enterprise/authority-authenticity/signature-envelope.ts',
      'src/enterprise/authority-authenticity/signature-verification.ts',
      'src/enterprise/execution-capability-presentation/index.ts',
      'src/enterprise/execution-capability-presentation/presentation.ts',
      'src/enterprise/execution-capability/capability.ts',
      'src/enterprise/execution-capability/index.ts',
      'src/enterprise/execution-capability/verifier.ts',
      'src/enterprise/governance-store/canonical-json.ts',
      'src/enterprise/governance-store/digest.ts',
      `${EXECUTOR}/admission.ts`,
      `${EXECUTOR}/binding-reconstruction.ts`,
      `${EXECUTOR}/configuration.ts`,
      `${EXECUTOR}/execution-flow.ts`,
      `${EXECUTOR}/gateway.ts`,
      `${EXECUTOR}/index.ts`,
      `${EXECUTOR}/launcher.ts`,
      `${EXECUTOR}/synthetic-effect.ts`,
      `${EXECUTOR}/verification-pipeline.ts`,
      'src/enterprise/execution-capability/reference/consumption-ledger.ts',
    ].sort());
    assert.deepEqual([...closure.bare].sort(), ['better-sqlite3', 'node:crypto', 'node:fs', 'node:http', 'node:path']);
  });

  it('it reaches no Host, Kernel, orchestrator, grant store, grant runtime, issuance, gate, adapter registry, P11/P12, signer or database', () => {
    const forbidden =
      /^src\/kernel\/|^src\/features\/|^src\/enterprise\/(composition|host|orchestration|governed-action|configuration|api|adapters|registry|bounded-grant-store|execution-governance|execution-capability-issuance|execution-capability-gate|execution-adapters|execution-outcome-store|execution-resolution-store|execution-reconciliation|external-authority-signer|emergency-control)\/|sqlite|-store\.ts$|signer\.ts$|custody\.ts$/;
    assert.deepEqual([...closure.files].filter((file) => forbidden.test(file)), []);
    assert.equal([...verificationPath.bare].some((specifier) => /sqlite|better-sqlite3/.test(specifier)), false, 'the verification path opens no database');
  });

  it('the launcher script loads only the compiled launcher', () => {
    const script = readFileSync('scripts/run-reference-executor.mjs', 'utf8').replace(/^\s*\/\/.*$/gm, '');
    assert.deepEqual([...script.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1]), ['../dist/src/enterprise/reference-executor/launcher.js']);
  });

  it('the binding format is G-02C0’s, restated rather than imported, and the record has exactly the Host record’s fields', () => {
    assert.equal(REFERENCE_EXECUTOR_HTTP_BINDING_FORMAT, GENERIC_HTTP_REQUEST_BINDING_FORMAT);
    const vector = hostVector('structure');
    const configuration = parseReferenceExecutorConfiguration(executorConfiguration(), EXECUTOR_ENVIRONMENT);
    const admission = admitHttpRequest(observedWith(vector), { authority: configuration.origin.authority, methods: configuration.methods, credentialHeader: configuration.credential.header });
    assert.ok(admission.ok);
    const rebuilt = reconstructHttpRequestBinding(admission.request, configuration.origin, configuration.credential.header);
    assert.ok(rebuilt.ok);
    assert.deepEqual(Object.keys(rebuilt.binding).sort(), Object.keys(genericHttpRequestBindingOf(vector.request, 'authorization')).sort());
    assert.deepEqual(Object.keys(rebuilt.binding.origin).sort(), ['hostname', 'port', 'scheme']);
  });
});

describe('G-02C1A structure — verification only: no signing, no ledger, no effect', () => {
  const sources = [...sourcesUnder(EXECUTOR), ...sourcesUnder(PRESENTATION)];

  it('no private key, signing call or HMAC', () => {
    for (const file of sources) assert.equal(/createPrivateKey|privateKey|generateKeyPair|crypto\.sign\b|[^a-zA-Z.]sign\(|createHmac|signBytes|signExecution/i.test(codeOf(file)), false, file);
  });

  it('the verification modules hold no receipt, ledger, claim, database or effect; the gateway reaches the G-02C1B flow only through the one call the launcher enables', () => {
    const verification = [`${EXECUTOR}/admission.ts`, `${EXECUTOR}/binding-reconstruction.ts`, `${EXECUTOR}/verification-pipeline.ts`, ...sourcesUnder(PRESENTATION)];
    for (const file of verification) {
      assert.equal(/receipt|ledger|\.claim\s*\(|better-sqlite3|Database\s*\(|effect|execute\s*\(|perform\s*\(|\bonEligible|\bhandler\s*\(/i.test(codeOf(file)), false, file);
    }
    const gateway = codeOf(`${EXECUTOR}/gateway.ts`);
    assert.equal(/receipt|\bledger\b|\.claim\s*\(|better-sqlite3|effect/i.test(gateway), false);
    assert.equal([...gateway.matchAll(/execution\.execute\(/g)].length, 1);
    assert.ok(gateway.includes('settle(execution === undefined ? pipeline.assess(observed) : execution.execute(observed));'), 'without a flow the gateway is the verification-only gateway');
    assert.equal(/receipt/i.test(sources.map(codeOf).join('\n')), false, 'no receipt anywhere (G-02C1C)');
  });

  it('the pipeline runs its steps in the declared order, and the gateway only answers with the assessment', () => {
    const pipeline = codeOf(`${EXECUTOR}/verification-pipeline.ts`);
    const order = ['admitHttpRequest(', 'credentialMatches(request', 'decodeExecutionCapabilityPresentation(', "'policy', 'ISSUER_NOT_PINNED'", 'reconstructHttpRequestBinding(', 'verifier.verify(', 'readVerifiedExecutionCapability('];
    const positions = order.map((step) => pipeline.indexOf(step));
    assert.ok(positions.every((position) => position !== -1), JSON.stringify(positions));
    assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
    const gateway = codeOf(`${EXECUTOR}/gateway.ts`);
    assert.equal([...gateway.matchAll(/pipeline\.assess\(/g)].length, 1, 'one assessment per request');
    assert.equal([...gateway.matchAll(/createServer\(/g)].length, 1, 'one listener');
    assert.equal(/\b20[0-9]\b/.test(gateway), false, 'no 2xx status anywhere in the gateway');
    for (const file of sources.filter((path) => path !== `${EXECUTOR}/gateway.ts`)) assert.equal(/createServer\(|\.listen\(/.test(codeOf(file)), false, file);
  });

  it('the gateway listens only where the validated configuration says, and the configuration admits loopback only', () => {
    const gateway = codeOf(`${EXECUTOR}/gateway.ts`);
    assert.ok(/server\.listen\(configuration\.listen\.port, host,/.test(gateway));
    assert.ok(/const host = configuration\.listen\.host;/.test(gateway));
    assert.ok(codeOf(`${EXECUTOR}/configuration.ts`).includes("if (host !== '127.0.0.1' && host !== '::1')"));
  });

  it('no ledger, rail or vendor vocabulary', () => {
    for (const file of sources) assert.equal(/xrpl|lightning|stripe|x402|\bmpp\b|offercreate|jwt|cose|macaroon/i.test(codeOf(file)), false, file);
  });
});

describe('G-02C1A structure — no Host surface, no Host change', () => {
  it('no Host module imports the executor or the presentation codec', () => {
    const importers = PRODUCTION.filter((file) => !file.startsWith(`${EXECUTOR}/`) && !file.startsWith(`${PRESENTATION}/`) && /from ['"][^'"]*(reference-executor|execution-capability-presentation)\//.test(codeOf(file)));
    assert.deepEqual(importers, []);
  });

  it('neither is exported from the Enterprise barrel, the package entry or the package exports map, and no route names them', () => {
    for (const file of ['src/enterprise/index.ts', 'src/index.ts', ...sourcesUnder('src/enterprise/api'), ...sourcesUnder('src/enterprise/adapters'), ...sourcesUnder('src/enterprise/host'), ...sourcesUnder('src/enterprise/composition')]) {
      assert.equal(/reference-executor|execution-capability-presentation|ReferenceExecutor|ExecutionCapabilityPresentation/.test(codeOf(file)), false, file);
    }
    assert.equal(/reference-executor|execution-capability-presentation/.test(JSON.stringify((JSON.parse(readFileSync('package.json', 'utf8')) as { exports?: unknown }).exports ?? {})), false);
  });

  it('the Host does not present yet: the mapper reserves nothing new, and the G-02C0 verdict is still proceed-or-withhold (SEC-INV-376)', () => {
    assert.equal(readFileSync('src/enterprise/execution-adapters/generic-http/configuration.ts', 'utf8').includes('frontera-execution-capability'), false, 'D1 is deferred to G-02C1D');
    const adapter = codeOf('src/enterprise/execution-adapters/generic-http/generic-http-execution-adapter.ts');
    assert.ok(adapter.includes('export type GenericHttpPreSendVerdict = { readonly proceed: true } | { readonly proceed: false };'));
    const invariants = readFileSync('docs/security/SECURITY_INVARIANTS.md', 'utf8');
    assert.ok(invariants.includes('| SEC-INV-376 | **The hook can stop a request and never change one.**'));
    for (const file of sourcesUnder('src/enterprise/execution-capability-gate')) assert.equal(/EXECUTION_CAPABILITY_PRESENTATION|execution-capability-presentation|frontera-execution-capability/.test(codeOf(file)), false, file);
  });

  it('the G-02A contract is unchanged: the same eighteen closed fields and the same signing domain', () => {
    assert.deepEqual([...EXECUTION_CAPABILITY_FIELDS], [
      'action',
      'actionBinding',
      'audience',
      'capabilityId',
      'consumption',
      'executionId',
      'expiresAt',
      'format',
      'grantReference',
      'issuedAt',
      'issuer',
      'issuerKeyId',
      'onBehalfOfActorId',
      'organizationId',
      'resource',
      'statusRequirement',
      'subjectActorId',
      'trustDomain',
    ]);
    assert.equal(EXECUTION_CAPABILITY_SIGNING_DOMAIN, 'frontera:authority-artifact:execution-capability:v1\n');
  });

  it('no Kernel, governed path, P11, P12, custody, issuance or rail module names the executor', () => {
    for (const root of [
      'src/kernel',
      'src/enterprise/governed-action',
      'src/features/execution-runtime',
      'src/enterprise/execution-outcome-store',
      'src/enterprise/execution-resolution-store',
      'src/enterprise/execution-reconciliation',
      'src/enterprise/execution-capability-issuance',
      'src/enterprise/authority-authenticity',
      'src/enterprise/external-authority-signer',
      'src/enterprise/xrpl-trade-rail',
      'src/enterprise/xrpl-trade-execution',
      'src/enterprise/xrpl-payment-rail',
      'src/enterprise/lightning-payment-rail',
    ]) {
      for (const file of sourcesUnder(root)) assert.equal(/reference-executor|ReferenceExecutor|execution-capability-presentation/.test(codeOf(file)), false, file);
    }
  });
});
