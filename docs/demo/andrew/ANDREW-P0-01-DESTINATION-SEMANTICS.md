# ANDREW-P0-01 — Destination Semantics

| | |
| --- | --- |
| Task | ANDREW-P0-01 — Andrew Demo — Destination Semantics |
| Branch | `feat/andrew-p0-01-destination-semantics` |
| Baseline | `fe277ea5c607ef38f5700b3b698b3299e516fdff` (audited in ANDREW-P0-00) |
| Status | Implemented, uncommitted, not pushed |

> **P0-01 does not implement destination approval.** It introduces the
> vocabulary that later tasks will approve, register, look up and bind. A
> destination created by this module is neither approved nor unapproved: it
> has no governance state at all.

## 1. Objective

Give Frontera a precise, rail-neutral, strongly typed representation of *the
thing a governed action acts upon or sends value to*, with deterministic
identity, so that later tasks can say "this destination is approved for this
organization" without that statement living inside the destination.

The source scenario is "send $75,000 to a wallet that wasn't previously
approved." That sentence mixes three distinct ideas, and this task separates
the first one from the other two:

| idea | example | owner |
| --- | --- | --- |
| **Destination identity** | namespace `network-a`, identifier `abc123` | P0-01 (`destination-runtime`) |
| **Destination address validity** | is `abc123` a valid address on its rail? | rail-specific adapter code (later) |
| **Destination governance state** | known / pending / approved / revoked / expired | registry and governance (P0-02+) |

A syntactically valid address can be an unapproved destination; a registered
destination can be unapproved for a given organization, asset or policy
context. None of that is decidable from identity alone, and identity must not
pretend otherwise.

## 2. Baseline Findings Used

From ANDREW-P0-00 (`ANDREW-P0-00-BASELINE-FREEZE.md` §7, §9, §10, §16):

1. A governed-action pipeline exists (`GovernedAction → Kernel → Grant → execution`) and must not change.
2. There is no first-class destination model, registry, network/address type, approval state or revocation model.
3. `counterparty` exists as an **opaque canonical identifier** and is bound into grants as an `identity` axis.
4. Existing approvals approve a *decision*, not a destination.
5. XRPL is absent; architectural tests deliberately keep rail/wallet vocabulary out of generic CORE.
6. Exact monetary semantics already model a namespaced, registry-resolved asset identifier (`monetary-asset.ts`), which is the closest existing precedent.
7. Two source-scan tests fail on this Windows CRLF checkout for environmental reasons (§10 below).

## 3. Architectural Placement

**Location:** a new pure feature module, `src/features/destination-runtime/`.

Inspected before choosing:

- **Rail-vocabulary bans.** `core08-action-neutrality-structure.test.ts`
  (`GENERIC_CORE_ROOTS`: `src/kernel`, `src/enterprise/governed-action`,
  `grant-runtime`, `execution-runtime`, `governed-parameter-runtime`,
  `governance-profile`, the outcome/reconciliation/resolution stores and
  `domain-policy-pack-runtime`), `structural-boundaries.test.ts`,
  `grant-layer-boundaries.test.ts`, `execution-layer-boundaries.test.ts`,
  `governed-action-neutrality-structure.test.ts`,
  `emergency-control-boundaries.test.ts`, `ctrl02/ctrl03-structure` and others
  ban `xrpl`, `wallet`, `ledger`, `lightning`, etc. in those directories.
  `destination-runtime` is in none of them, and additionally carries its own,
  stricter ban (§10).
- **Feature conventions.** Pure primitives live in `src/features/<name>-runtime/`
  with `domain/`, `index.ts` (barrel), `README.md` and `tests/` containing a
  `*-boundaries.test.ts`. `monetary-runtime` is the model: it imports nothing,
  reads no clock, does no I/O and is consumed by every layer.

Why this is correct:

- **Not in the Kernel, grant, execution or governed-action layers** — P0-01
  wires nothing, so there is no reason to touch any banned root, and putting a
  new concept there now would also widen those layers' surface before it is
  needed.
- **Not inside `monetary-runtime`** — a destination is not money: an API
  resource or a data-export target is a destination too.
- **Not in `src/enterprise/`** — enterprise is the composition/host layer; a
  value object every layer may later import belongs below it, as
  `monetary-runtime` does.
- **Rail-neutral by construction** — the module ships no namespace names, and
  its own boundary test forbids rail vocabulary in its code, so it could be
  added to `GENERIC_CORE_ROOTS` later without change.

Reused primitive: `isSemanticIdentifier` / `SEMANTIC_IDENTIFIER_MAX_LENGTH`
from `governed-parameter-runtime` (the CORE-03 grammar for action classes,
resource classes and profile ids) is the namespace grammar. This is the only
import, in the same direction `grant-runtime` already imports it.

## 4. Destination Model

```ts
interface ExecutionDestination {
  readonly namespace: string;   // where the identifier means something (rail / network / provider)
  readonly identifier: string;  // the external identifier inside that namespace, exact
}
```

Two fields, nothing else. API (`src/features/destination-runtime/index.ts`):

| export | purpose |
| --- | --- |
| `parseExecutionDestination(input: unknown)` | The single ingress from untrusted input. Returns `{ valid: true, destination }` (a new frozen object) or `{ valid: false, violation }`. |
| `isWellFormedExecutionDestination(value)` | Registry-free structural re-check for downstream layers (mirrors `isWellFormedMonetaryAmount`). |
| `executionDestinationKey(destination)` | The canonical key `<namespace>:<identifier>`. Throws on a malformed destination. |
| `sameExecutionDestination(a, b)` | Exact equality on both fields; a malformed destination equals nothing. |
| `isDestinationNamespace`, `isDestinationIdentifier` | Field-level predicates. |
| `EXECUTION_DESTINATION_VIOLATIONS` | `DESTINATION_NOT_A_RECORD`, `DESTINATION_FIELD_UNEXPECTED`, `DESTINATION_NAMESPACE_MALFORMED`, `DESTINATION_IDENTIFIER_MALFORMED`. |
| `DESTINATION_IDENTIFIER_MAX_LENGTH` (191), `DESTINATION_KEY_MAX_LENGTH` (256) | Bounds. |

**Kind and namespace are one concept.** The namespace says which rail, network
or provider resolves the identifier, and that already determines what kind of
destination it is. A separate `kind` field would be a second axis that could
disagree with the namespace (`kind: bank-account` under a ledger namespace),
i.e. two sources of truth for one fact. This follows the precedent of
`monetary-asset.ts`, where the namespace lives in the asset identifier itself.

**Namespace is open, not a closed enum.** CORE ships no rail names; a
deployment's adapters declare the namespaces they serve (later tasks). A
namespace must be specific enough that one identifier in it designates one
thing — if a test network and a production network share an address space they
are two namespaces (`network-a`, `network-a.testnet`).

Conceptually, the scenarios the brief names are all representable — with
namespace names chosen by the deployment, not by this module:

```
namespace = <ledger-a>        identifier = rABC...                 (a ledger address)
namespace = <evm-chain-1>     identifier = 0xABC...                (an account address)
namespace = <provider-x>      identifier = provider-x://destination/123   (a provider resource id, not a wallet)
namespace = <bank-scheme>     identifier = <account reference>
```

### Identity vs. governance state

```
Destination (P0-01 — identity, immutable):
  namespace  = some-network
  identifier = abc123
  key        = some-network:abc123

Destination governance state (P0-02+ — NOT implemented here, NOT stored in the destination):
  key some-network:abc123 → unknown | known | pending approval | approved | revoked | expired
  … scoped to an organization / action / asset / policy context, with who/when/evidence
```

The same identity is usable in every one of those states, because none of
them is part of it.

## 5. Canonical Identity

```
executionDestinationKey({ namespace, identifier }) = namespace + ":" + identifier
```

- **Fields that feed it:** exactly `namespace` and `identifier`, verbatim. No
  label, no description, no state, no timestamp, no randomness, no hash.
- **Unambiguous by grammar:** a namespace cannot contain `:`, so the first `:`
  always ends the namespace; an identifier may itself contain `:` (URIs) without
  ambiguity. Two keys are equal iff both fields are equal.
- **Namespace separation:** `network-a:rABC` ≠ `network-b:rABC`. Approving one
  can never approve the other.
- **No normalization:** `0xABC` and `0xabc` are different destinations here.
  Whether they designate the same account is a rule of one rail (and wrong for
  others), so it is deferred to rail-specific code, which must refuse a
  non-canonical spelling for its rail before a destination is built.
- **Deterministic serialization:** a parsed destination is a new frozen object
  built as `{ namespace, identifier }`, so it has exactly one JSON spelling
  regardless of input property order.
- **No hash.** A digest would need `node:crypto` (breaking the module's
  import-nothing boundary) and would add nothing: the key is already a short,
  exact, collision-free string, exactly like
  `formatGovernanceProfileReference` (`<id>@<version>#<digest>`).

## 6. Validation Rules

Structural only. The module never claims an identifier is valid on its rail.

| field | rule |
| --- | --- |
| input | a plain object (`Object.prototype` or null prototype); arrays, class instances, `Map`, `null`, strings refused (`DESTINATION_NOT_A_RECORD`) |
| fields | exactly `namespace` and `identifier`; any other own key — `approved`, `status`, `label`, a symbol — refused, not stripped (`DESTINATION_FIELD_UNEXPECTED`) |
| accessors | refused (`DESTINATION_NOT_A_RECORD`): a getter could answer differently on a second read |
| `namespace` | CORE-03 semantic identifier: lowercase-ASCII-led, `[A-Za-z0-9]` joined by single `.` `_` `-`, ≤ 64 chars; no `:` `/` whitespace or non-ASCII (`DESTINATION_NAMESPACE_MALFORMED`) |
| `identifier` | 1–191 chars of printable ASCII `!`…`~`; no whitespace, control, zero-width, bidi, combining or look-alike characters (`DESTINATION_IDENTIFIER_MALFORMED`) |

Refused, never repaired: leading/trailing whitespace is not trimmed, case is not
folded, Unicode is not normalized. Restricting identifiers to printable ASCII
removes Unicode homoglyph and normalization-form ambiguity without inventing a
normalization rule; every rail identifier form in scope (ledger addresses,
account references, resource URIs) is ASCII.

**191** = 256 − 64 − 1, so the longest key is exactly 256 characters (§7).

Not validated (rail-specific, later): ledger address grammar/checksums, EVM
EIP-55 checksums, bank routing/IBAN, provider id formats.

## 7. Relationship to Existing Counterparty

Audit of `counterparty` at `fe277ea`:

| stage | where | form |
| --- | --- | --- |
| created | `src/enterprise/governed-action/intent.ts:310` | optional intent field, `isCanonicalCustomerIdentifier` (≤ 256, trim-stable, no control chars) |
| travels | `governed-action/kernel-request.ts:54` → `KernelRequest.action.counterpartyId` (`src/kernel/contracts/kernel-request.ts:52`) → `request-adapter.ts:124` | opaque string |
| bound / signed | `src/kernel/orchestration/grant-adapter.ts:127` → grant scope `counterparty: { kind: 'identity', value }` (`grant-runtime/domain/grant-scope.ts`), part of the serialized, signed scope | exact-match identity bound |
| exercised | `execution-runtime/domain/grant-exercise-assessment.ts:154` | exact equality vs. grant bound |
| handed to adapters | `execution-adapter-port.ts:69`; `generic-http/request-mapper.ts:45` | opaque string |
| approval subject | `approval-authority/subject.ts:50,98` | `counterpartyId` bound into the approval subject |
| persisted | inside the serialized grant / decision / approval subject records | opaque string |
| policy | `domain-policy-pack-runtime` `counterpartyId` condition field | opaque string |

**Decision: coexist, change nothing.** `counterparty` is not touched, renamed,
re-typed or re-validated. No grant wire format, signed artifact, persistence
schema, Kernel contract or approval subject changes.

Designed-in compatibility for later integration: every
`executionDestinationKey` is an admissible `counterparty` value (≤ 256,
trim-stable, no control characters), proven by test against the real
`isCanonicalCustomerIdentifier`. So a later task *can* carry a destination
through the existing pipeline by binding its key as the counterparty — exact
string identity is exactly what the grant's `identity` axis already enforces —
without a grant-format break. Whether it should (versus a dedicated grant axis
under a new semantics marker) is a P0-02+ decision, noted in §12.

## 8. Security Invariants

| # | invariant | how P0-01 supports it |
| --- | --- | --- |
| 1 | A destination cannot become approved because a request says `approved = true` | the model has no approval field; the ingress refuses any field other than `namespace`/`identifier` (tested for `approved`, `approvedBy`, `approvedAt`, `approvalStatus`, `status`, `revokedAt`, `expiresAt`, `known`, `trusted`) |
| 2 | A request cannot self-assert governance state | same: there is nowhere in a destination to put it; governance state will be resolved from trusted registry state (P0-02+) keyed by the canonical key |
| 3 | Approving one destination cannot approve a different rail/network destination with the same text | the namespace is part of identity and of the key; tested with the same identifier under two namespaces, prefix namespaces, and a forged separator |
| 4 | Material identity is not silently mutated after authorization | parsed destinations are new frozen copies; accessors refused; no normalization step exists that could change a value between check and use |
| 5 | Labels/descriptions never substitute for identity | no label field exists; an input carrying one is refused |
| 6 | A display label does not participate in security comparisons | `executionDestinationKey` and `sameExecutionDestination` read only `namespace` and `identifier`; tested with smuggled label/approval properties |

## 9. Explicitly Out of Scope

Not implemented, deliberately: destination registry; approved-destination
storage; approval flow; revocation; expiration; admin API/UI; trusted-context
resolution; policy rules (including the $75,000 policy); authority-ceiling
changes; reevaluation; obligations; any XRPL adapter, SDK or Testnet access;
signing; Lumx or Lightning integration; blockchain execution; migrations;
deployment; external API calls; wiring into `GovernedAction`, the Kernel,
grants or execution.

## 10. Tests

New, in `src/features/destination-runtime/tests/`:

- `execution-destination.test.ts` — creation and freezing; copy semantics;
  provider-URI identifiers; max-length boundary; structural refusals (empty,
  non-string, leading/trailing/interior whitespace, newline, tab, NUL, C1,
  zero-width, NBSP, Cyrillic homoglyph, combining mark, bidi override, 100 000
  chars; malformed namespaces); non-record and accessor inputs; refusal of
  every governance field and of labels; deterministic keys and JSON regardless
  of property order; namespace separation; prefix and separator-forgery
  non-collision; case preserved and distinct; malformed destinations have no
  key and equal nothing; immutability; counterparty admissibility of every
  key, including the 256-char maximum.
- `destination-boundaries.test.ts` — imports only itself and the
  semantic-identifier grammar; no clock, randomness, network, filesystem,
  process or dynamic code; no rail/wallet/ledger/provider vocabulary in code;
  no approval/revocation/expiry/label/status/registry vocabulary in code; no
  trim, case fold or Unicode normalization; no approval/registry export.

Results (WSL2 Linux, Node v22.23.1, same toolchain as P0-00; `npm ci` →
`typecheck` → `lint` → `build` → `test:root` → `test:workspaces`):

| command | result | counts |
| --- | --- | --- |
| `npm run typecheck` | exit 0 | 0 errors |
| `npm run lint` | exit 0 | node16 imports, architecture, public surface all pass |
| `npm run build` | exit 0 | — |
| focused `destination-runtime` tests | pass | 71 tests · 71 pass · 0 fail |
| `npm run test:root` | exit 1 (inherited) | 9002 tests · 8987 pass · **2 fail** · 9 skipped · 4 todo |
| `npm run test:workspaces` | exit 0 | 1089 tests · 1089 pass · 0 fail |
| **Total** | | **10091 tests · 10076 pass · 2 fail · 9 skipped · 4 todo** |

Against P0-00 (10020 · 10005 · 2 · 9 · 4): exactly +71 tests and +71 passes,
the new suites; the same 2 failures; no new failure. Existing grant,
execution, Kernel, counterparty, governed-action and architectural-boundary
suites (`core08-action-neutrality-structure`,
`governed-action-neutrality-structure`, `structural-boundaries` apart from the
inherited case, `grant-layer-boundaries`, `execution-layer-boundaries`,
`monetary-boundaries`, …) pass unchanged.

Inherited environment failures (from P0-00, Windows `core.autocrlf=true`, no
`.gitattributes`): `authority-administration-service.test.ts:334` ("the
administration route matcher exists") and `structural-boundaries.test.ts:282`
("an unset AOC_ENTERPRISE_API_KEYS must resolve to an empty key list…"). Same
tests, same assertions as P0-00. Not modified; no `.gitattributes` added.

## 11. Files Changed

All new; no existing file modified.

| file | purpose |
| --- | --- |
| `src/features/destination-runtime/domain/execution-destination.ts` | the value object, ingress, key, equality |
| `src/features/destination-runtime/domain/index.ts` | domain barrel |
| `src/features/destination-runtime/index.ts` | module barrel (feature convention) |
| `src/features/destination-runtime/README.md` | module README (feature convention) |
| `src/features/destination-runtime/tests/execution-destination.test.ts` | behaviour and adversarial tests |
| `src/features/destination-runtime/tests/destination-boundaries.test.ts` | structural boundary tests |
| `docs/demo/andrew/ANDREW-P0-01-DESTINATION-SEMANTICS.md` | this document |

## 12. Impact on ANDREW-P0-02

P0-02 can reference a destination by `executionDestinationKey` and store
governance state *beside* it. Decisions it inherits:

1. **Registry keying.** Key records by the canonical key. Because namespace
   identity is case-sensitive under the CORE-03 grammar, the registry should
   refuse two namespaces that differ only by case (`semanticIdentifierFold`),
   as existing CORE-03 registries do.
2. **Namespace declaration.** Decide where the set of namespaces a deployment
   accepts is declared (trusted host configuration, alongside adapters), so an
   unknown namespace fails closed — mirroring `MonetaryAssetRegistry`.
3. **Rail canonicalization.** Before a destination is built for a rail with a
   case-insensitive or checksummed address form, that rail's code must refuse
   (not repair) non-canonical spellings; otherwise one account could have two
   keys and an approval of one spelling would not cover the other (fail-closed,
   but confusing).
4. **Pipeline integration.** Choose between (a) binding the key as the existing
   `counterparty` (no format change; but the namespace/identifier structure is
   then opaque downstream, and a legacy free-form counterparty containing `:`
   could textually resemble a key), or (b) a dedicated destination grant axis
   under a new semantics marker (format change; requires its own review). P0-01
   keeps both open and does not force either.
5. **Governance state model.** known / pending / approved / revoked / expired,
   with scope (organization, action, asset, policy context), actor, time and
   evidence — none of which may be accepted from the request.

## 13. Final Verdict

Destination identity is introduced as a pure, rail-neutral, immutable value with
a deterministic canonical key, separate from approval state and from rail
address validity, coexisting with `counterparty` without any change to the
existing pipeline, grant format, persistence or Kernel. No registry, approval,
XRPL, signer or execution was implemented.

Typecheck, lint and build are clean; all 71 new tests pass; the full suite
shows only the 2 inherited CRLF failures and no new failure.

**A. DESTINATION SEMANTICS COMPLETE — READY FOR ANDREW-P0-02**
