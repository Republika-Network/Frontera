import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * PAY-07 — the qualified CORE source manifest (§11.2 criterion 2: "CORE source
 * is byte-identical between the two runs").
 *
 * The manifest is an explicit, reviewed list of **include roots** — the
 * generic layers both rail runs execute — each with the reason it belongs.
 * Every `.ts` source under a root is included automatically (a new file under
 * a CORE root can never escape the proof); test code (`__tests__/`, `tests/`,
 * `fixtures/`, `*.test.ts`) is not CORE and is skipped. Rail-specific code
 * (`rails/xrpl`, `rails/lightning`, `rails/stripe`, `xrpl-payment-rail`,
 * `lightning-payment-rail`, `stripe-payment-rail`) and the Host composition edge are classified
 * outside it (`CORE_SOURCE_CLASSIFICATION`), and every directory beside a root
 * must be classified one way or the other — an unclassified new directory
 * fails `pay07-multi-rail-structure.test.ts`.
 *
 * ## Canonical form
 *
 * ```
 * line   = <relative posix path> SP <sha256 hex of the file's LF-normalized bytes> LF
 * text   = MANIFEST_VERSION LF line*        (lines in lexicographic path order)
 * digest = "sha256:" sha256(text)
 * ```
 *
 * No timestamp, no absolute path, no environment. Line endings: a CRLF pair is
 * read as LF — exactly the transformation `core.autocrlf=true` applies on a
 * Windows checkout, so a Windows working copy and a Linux CI checkout of the
 * same commit produce the same digest. Nothing else is normalized: a lone CR,
 * a BOM, whitespace or any other byte changes the digest.
 */

export const CORE_SOURCE_MANIFEST_VERSION = 'frontera.core-source-manifest.v1';

export interface CoreSourceRoot {
  readonly root: string;
  readonly layer: string;
  readonly why: string;
}

/** The qualified CORE: every layer the governed payment path executes for every rail, unchanged. */
export const CORE_SOURCE_ROOTS: readonly CoreSourceRoot[] = Object.freeze([
  { root: 'src/kernel', layer: 'Kernel', why: 'the decision engine every governed payment is evaluated by' },
  { root: 'src/kernel-host', layer: 'Kernel', why: 'the Kernel host surface (PAY-06 CORE-purity scope)' },
  { root: 'src/enterprise/kernel-authority', layer: 'P10 authority', why: 'the financial authority resolver: ceilings and lifetime limits' },
  { root: 'src/features/authority-graph', layer: 'P10 authority', why: 'authority lineage and monetary constraints' },
  { root: 'src/features/recognition-runtime', layer: 'Kernel', why: 'recognition the Kernel decides over' },
  { root: 'src/features/context-resolution-runtime', layer: 'Kernel', why: 'trusted context resolution in the decision closure' },
  { root: 'src/features/action-enforcement', layer: 'Kernel', why: 'the enforcement runtime in the decision closure' },
  { root: 'packages/governed-authority/src', layer: 'authority packages', why: 'governed authority the Kernel imports' },
  { root: 'packages/governed-authorization/src', layer: 'authority packages', why: 'governed authorization the Kernel imports' },
  { root: 'src/features/domain-policy-pack-runtime', layer: 'policy', why: 'generic policy (PAY-06 CORE-purity scope)' },
  { root: 'src/features/policy-pack-foundation', layer: 'policy', why: 'generic policy foundation (PAY-06 CORE-purity scope)' },
  { root: 'src/enterprise/governance-profile', layer: 'CORE-03', why: 'Governance Profiles and the reserved-key registry the payment profile uses' },
  { root: 'src/features/grant-runtime', layer: 'grant', why: 'bounded grants: issuance, exercise, revocation' },
  { root: 'src/enterprise/bounded-grant-store', layer: 'grant', why: 'the authoritative grant stores' },
  { root: 'src/enterprise/version.ts', layer: 'governed path', why: 'the enterprise version the Governance Store records with every decision (runtime-imported by the governed path)' },
  { root: 'src/enterprise/governed-action', layer: 'governed path', why: 'the orchestrator: envelope, committed decision, write-ahead claim, replay' },
  { root: 'src/enterprise/execution-governance', layer: 'governed path', why: 'authority-controlled execution: issuance core, exercise gate' },
  { root: 'src/enterprise/orchestration', layer: 'governed path', why: 'governance access contexts in the orchestrator closure' },
  { root: 'src/enterprise/customer-identity', layer: 'governed path', why: 'the bound customer identity a payment is requested under' },
  { root: 'src/enterprise/governance-store', layer: 'governed path', why: 'the Governance Store: committed decisions and the execution ledger' },
  { root: 'src/features/emergency-control-runtime', layer: 'governed path', why: 'the operational interlock at every checkpoint' },
  { root: 'src/features/execution-runtime', layer: 'governed path', why: 'the execution adapter port the PAY-01 bridge implements' },
  { root: 'src/features/governed-parameter-runtime', layer: 'governed path', why: 'typed governed parameters (purpose, reference, rail)' },
  { root: 'src/features/exercise-control-runtime', layer: 'P7', why: 'exercise controls and reservation (capacity) settlement' },
  { root: 'src/enterprise/exercise-control-ledger', layer: 'P7', why: 'the durable reservation ledger' },
  { root: 'src/features/monetary-runtime', layer: 'P9', why: 'exact money: amounts, assets, comparison' },
  { root: 'src/enterprise/execution-outcome-store', layer: 'P11', why: 'durable execution outcomes and provider certainty' },
  { root: 'src/enterprise/execution-resolution-store', layer: 'P12', why: 'durable resolutions' },
  { root: 'src/enterprise/execution-reconciliation', layer: 'P12', why: 'the reconciliation service and the resolution-authority port' },
  { root: 'src/features/obligation-runtime', layer: 'CORE-04', why: 'the obligation lifecycle' },
  { root: 'src/enterprise/obligation-discharge', layer: 'CORE-04', why: 'obligation discharge recording' },
  { root: 'src/enterprise/authority-state-freshness', layer: 'CORE-07', why: 'the freshness boundary both rails anchor their durable interlocks at' },
  { root: 'src/enterprise/authority-event-stream', layer: 'P8 / ASSURE-01', why: 'the authority event stream the trace verifies' },
  { root: 'src/enterprise/evidence', layer: 'ASSURE-01', why: 'the trace builder, verifier and disclosure' },
  { root: 'src/features/payment-runtime/index.ts', layer: 'PAY generic', why: 'the payment vertical entry point' },
  { root: 'src/features/payment-runtime/domain', layer: 'PAY generic', why: 'PaymentIntent, the rail port, execution request, protocol port, settlement and finality port' },
  { root: 'src/features/payment-runtime/services', layer: 'PAY generic', why: 'the one bridge that invokes a rail' },
  { root: 'src/enterprise/payment-settlement', layer: 'PAY-05', why: 'settlement, receipts, obligation bridge, refunds — rail-neutral' },
  { root: 'src/enterprise/payment-protocol-ingress', layer: 'PAY-04', why: 'the protocol ingress and business-operation store both representative flows enter through' },
  { root: 'src/features/payment-runtime/protocols/mpp', layer: 'PAY-04', why: 'the MPP adapter: shared, unchanged, by both representative flows' },
]);

/**
 * Every directory directly beside a CORE root, classified. `core` entries are
 * covered by `CORE_SOURCE_ROOTS`; `outside` entries carry the reason they are
 * not part of the qualified CORE. A directory that appears in neither fails
 * the drift test.
 */
export const CORE_SOURCE_CLASSIFICATION: Readonly<Record<string, { readonly scope: readonly string[]; readonly outside: Readonly<Record<string, string>> }>> = Object.freeze({
  'src/features/payment-runtime': {
    scope: ['domain', 'services', 'protocols', 'index.ts'],
    outside: {
      rails: 'rail-specific code below the PAY-01 port (XRPL, Lightning)',
      tests: 'test-only code, including the PAY-07 canonical conformance suite',
      'README.md': 'documentation',
    },
  },
  'src/features/payment-runtime/protocols': {
    scope: ['mpp'],
    outside: {
      x402: 'PAY-08: the x402 protocol adapter — a second protocol below the PAY-04 port, not executed by the rail-qualification runs (they enter through MPP); held to its own boundary test',
    },
  },
  'src/enterprise': {
    scope: [
      'kernel-authority',
      'governance-profile',
      'bounded-grant-store',
      'governed-action',
      'execution-governance',
      'orchestration',
      'customer-identity',
      'governance-store',
      'exercise-control-ledger',
      'execution-outcome-store',
      'execution-resolution-store',
      'execution-reconciliation',
      'obligation-discharge',
      'authority-state-freshness',
      'authority-event-stream',
      'evidence',
      'payment-settlement',
      'payment-protocol-ingress',
      'version.ts',
    ],
    outside: {
      'xrpl-payment-rail': 'rail-specific: the PAY-03 XRPL composition edge (external signer, interlock, P12 and finality authorities)',
      'lightning-payment-rail': 'rail-specific: the PAY-06 Lightning composition edge (LND adapter, interlock, P12 and finality authorities)',
      'stripe-payment-rail': 'rail-specific: the PAY-09 Stripe composition edge (HTTPS adapter, interlock, P12 and finality authorities, webhook signals)',
      'x402-payment-protocol': 'protocol-and-rail-specific: the PAY-08 x402 composition edge (the lnbtc binding over Lightning, presentation, post-settlement proof); not executed by the qualified runs',
      'trade-risk-context': 'vertical-specific: the TRADE-03 composition edge (a CORE-04 trusted-context provider over the trade vertical); not on the governed payment path',
      'xrpl-trade-rail': 'vertical-and-rail-specific: the TRADE-04B delegated OfferCreate signer edge (closed signer protocol, Host-side verification, EP-073 transport, client, reference signer process); composed only by the TRADE-04C governed trade executor edge, not on the governed payment path',
      'xrpl-trade-execution': 'vertical-and-rail-specific: the TRADE-04C governed delegated OfferCreate executor edge (execution adapter, durable trade sequence interlock, P12 trade resolution authority, evidence, Host configuration and composition; EP-074); a trade vertical edge, not on the governed payment path',
      __tests__: 'test-only code, including the PAY-07 shared world, rail edges and this manifest',
      host: 'Host composition edge: composes configured modules (the shipped Host composes the PAY-03 XRPL rail); not executed by either qualified run',
      composition: 'Host composition root: the composition edge where rail-specific composition belongs; the qualified runs compose the same generic stores directly',
      configuration: 'Host configuration: knows the PAY-03 XRPL Host section; a composition edge, type-only reachable from evidence',
      'access-governance': 'outside the governed payment path',
      adapters: 'outside the governed payment path (non-payment adapters)',
      api: 'HTTP API surface; not executed by the qualified runs',
      'approval-authority': 'CORE-05 approvals: not reached by the qualified scenarios (no approval required)',
      assurance: 'assurance assessments, not the ASSURE-01 trace',
      'authority-administration': 'operator administration surface',
      'authority-authenticity': 'signed authority artifacts; the qualified runs use the in-memory grant store',
      'authority-governance': 'outside the governed payment path',
      'collateralization-governance': 'outside the governed payment path',
      'content-protection': 'outside the governed payment path',
      'emergency-control': 'Host emergency-control service; the shared runtime port is in src/features/emergency-control-runtime',
      'encumbrance-release-governance': 'outside the governed payment path',
      events: 'Host event publisher',
      'execution-adapters': 'non-payment execution adapters',
      'external-authority-signer': 'CORE-02 external signer; not composed by the qualified runs',
      health: 'Host health surface',
      lifecycle: 'Host lifecycle',
      'license-governance': 'outside the governed payment path',
      modules: 'Host module registry',
      operations: 'Host operations',
      'operator-control': 'operator control plane',
      passport: 'agent passports',
      persistence: 'Host persistence wiring',
      providers: 'non-payment providers',
      registry: 'Host adapter registry',
      telemetry: 'Host telemetry',
      'tokenization-governance': 'outside the governed payment path',
      'transfer-governance': 'outside the governed payment path',
      'trusted-context': 'Host trusted-context sources; the runtime is in src/features/context-resolution-runtime',
      'index.ts': 'package entry point',
    },
  },
  'src/features': {
    scope: [
      'authority-graph',
      'recognition-runtime',
      'context-resolution-runtime',
      'action-enforcement',
      'domain-policy-pack-runtime',
      'policy-pack-foundation',
      'grant-runtime',
      'emergency-control-runtime',
      'execution-runtime',
      'governed-parameter-runtime',
      'exercise-control-runtime',
      'monetary-runtime',
      'obligation-runtime',
      'payment-runtime',
    ],
    outside: {
      'aoc-control-plane': 'control-plane UI feature',
      'aoc-enterprise-demo': 'demo scenarios',
      'aoc-enterprise-pilot-template': 'pilot templates',
      'aoc-integrations': 'integration examples',
      'approval-runtime': 'approval runtime: not reached by the qualified scenarios',
      'evidence-source-runtime': 'evidence sources outside the trace',
      'external-agent-handshake': 'agent handshake',
      'trade-runtime': 'TRADE: a separate governed-action vertical (delegated OfferCreate), not a payment layer; no qualified payment run executes it, nothing in CORE imports it, and it is held to its own boundary tests (trade-vertical-structure.test.ts)',
      'verifiable-export-package': 'export packaging',
      'xrpl-transport': 'TRADE-04A: the shared, transaction-neutral XRPL transport primitives (grammar, network identity, validated reads, submission reading, sequence safety) below the XRPL rails — rail infrastructure, not a governed-path layer; held to its own boundary test (xrpl-transport-boundaries.test.ts)',
    },
  },
});

const SKIPPED_DIRECTORIES = new Set(['__tests__', 'tests', 'fixtures', 'node_modules', 'dist']);

const isSource = (name: string): boolean => (name.endsWith('.ts') || name.endsWith('.tsx')) && !name.endsWith('.test.ts') && !name.endsWith('.d.ts');

function walk(repoRoot: string, relative: string, out: string[]): void {
  const absolute = join(repoRoot, relative);
  const stat = statSync(absolute);
  if (stat.isFile()) {
    if (isSource(relative)) out.push(relative);
    return;
  }
  for (const name of readdirSync(absolute).sort()) {
    const child = `${relative}/${name}`;
    if (statSync(join(repoRoot, child)).isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(name)) walk(repoRoot, child, out);
    } else if (isSource(name)) {
      out.push(child);
    }
  }
}

/** Every CORE source, as repository-relative posix paths, in lexicographic order. */
export function listCoreSources(repoRoot = '.', roots: readonly CoreSourceRoot[] = CORE_SOURCE_ROOTS): readonly string[] {
  const out: string[] = [];
  for (const { root } of roots) {
    if (!existsSync(join(repoRoot, root))) throw new Error(`core-root-missing:${root}`);
    walk(repoRoot, root, out);
  }
  return Object.freeze([...new Set(out)].sort());
}

/** LF-normalizes CRLF pairs only — `core.autocrlf=true`'s checkout transformation, reversed. Nothing else changes. */
export function normalizeLineEndings(bytes: Uint8Array): Buffer {
  const source = Buffer.from(bytes);
  const out = Buffer.alloc(source.length);
  let length = 0;
  for (let index = 0; index < source.length; index += 1) {
    const byte = source[index] as number;
    if (byte === 0x0d && source[index + 1] === 0x0a) continue;
    out[length] = byte;
    length += 1;
  }
  return out.subarray(0, length);
}

const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');

export interface CoreSourceManifestEntry {
  readonly path: string;
  readonly sha256: string;
}

export interface CoreSourceManifest {
  readonly version: typeof CORE_SOURCE_MANIFEST_VERSION;
  readonly entries: readonly CoreSourceManifestEntry[];
  /** The canonical manifest text the digest is computed over. */
  readonly text: string;
  readonly digest: string;
}

export interface CoreSourceManifestOptions {
  readonly roots?: readonly CoreSourceRoot[];
  /** Reads one file's bytes. Defaults to the working tree; a test may substitute a variant. */
  readonly read?: (path: string) => Uint8Array;
}

/** Builds the manifest over the given repository root. Deterministic: the same committed tree gives the same digest on every platform. */
export function buildCoreSourceManifest(repoRoot = '.', options: CoreSourceManifestOptions = {}): CoreSourceManifest {
  const read = options.read ?? ((path: string) => readFileSync(join(repoRoot, path)));
  const entries = listCoreSources(repoRoot, options.roots).map((path) => Object.freeze({ path, sha256: sha256(normalizeLineEndings(read(path))) }));
  return manifestOf(entries);
}

/** The canonical text and digest of a list of entries (sorted here, whatever order they arrive in). */
export function manifestOf(entries: readonly CoreSourceManifestEntry[]): CoreSourceManifest {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const text = `${CORE_SOURCE_MANIFEST_VERSION}\n${sorted.map((entry) => `${entry.path} ${entry.sha256}\n`).join('')}`;
  return Object.freeze({ version: CORE_SOURCE_MANIFEST_VERSION, entries: Object.freeze(sorted), text, digest: `sha256:${sha256(text)}` });
}
