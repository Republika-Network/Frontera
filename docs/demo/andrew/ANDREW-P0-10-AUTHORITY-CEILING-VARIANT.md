# ANDREW-P0-10 — Authority Ceiling Variant / No-Chain-Execution Proof

| | |
| --- | --- |
| Branch | `feat/andrew-p0-10-authority-ceiling-variant` (from `feat/andrew-demo` @ `13e8d3d`) |
| Scenario | an otherwise valid request to an **approved** XRPL Testnet destination for **USD 125,000** against a **USD 100,000** bounded financial authority |
| Result | Kernel `allowed` → authority issuance **withheld** (`withheldBy: authority-binding`, `FINANCIAL_AUTHORITY_CEILING_EXCEEDED`) → no grant, no exercise, no adapter, no XRPL connection, signature, submission or attempt record |
| Status | **VERIFIED** — offline on the composed Host with the real P0-08 transport package and a counting scripted ledger. **No real XRPL transaction was sent or attempted for this scenario, by design.** |

## 1. The semantic

Destination approval and financial authority are **independent** gates:

```
request ── Kernel (destination policy: approved ✓) ── decision ALLOWED, committed
        └─ issuance core: financial authority ceiling USD 100,000 vs requested USD 125,000
             → withheld (FINANCIAL_AUTHORITY_CEILING_EXCEEDED) ── no grant ── nothing below runs
```

An approved destination never creates authority. A reconsideration (P0-09) gets
a fresh decision through the same ceiling. The ceiling contract is
**requested ≤ ceiling passes**: USD 100,000 proceeds, and USD 100,000.01 and
USD 125,000 are withheld.

**125,000 RLUSD were never sent, signed or attempted on-chain.** The P0-10 test
composes the real transport package over a scripted ledger that counts
connections, signatures and submissions. All three counts stay at 0 for the
over-ceiling request.

## 2. Phase 0 findings (before any change)

- **Enforcement already existed and was correct.**
  `issuance-core.ts` → `measureFinancialAuthority` compares the request with
  the authority's ceiling through `compareMonetaryAmounts`, never a raw string
  comparison. Above the ceiling, it returns `financial-authority-withheld` with
  `FINANCIAL_AUTHORITY_CEILING_EXCEEDED`. The orchestrator then answers
  `withheld / authority-binding` before any grant.
- **Gap: the durable evidence did not say why.**
  The ASSURE-01 trace of the 125K request showed `authority.presence =
  not-reached`, with no grant and no mention of the ceiling. That implied the
  authority stage was never evaluated, when in fact it was evaluated and
  withheld. The only durable fact was the `allowed` decision.
- **Decision (user):** record the withholding durably, as **evidence only**.

## 3. Implementation — evidence only

Kernel decisions, financial authority evaluation, the ceiling comparison,
grant issuance, destination approval, reconsideration, the XRPL transport and
execution/outcome behaviour are all **unchanged**. The issuance-core result
stays the source of truth.

| File | Change |
| --- | --- |
| `execution-governance/issuance-core.ts`, `contracts.ts` | The `financial-authority-withheld` result also carries the `ceiling` the comparison already used. It is data only: no branch or comparison changed. |
| `governance-store/contracts.ts` | Adds reference type `issuance_record`. It is evidence only and is never read to decide. |
| `governed-action/issuance-record.ts` (new, pure) | Row grammar, digest and parse. Its only import is `node:crypto`. |
| `governed-action/identifiers.ts` | Adds `issuanceWithheldReferenceId(evaluation, version)`, which is deterministic, so a replay that withholds identically records once. |
| `governed-action/execution-ledger.ts` | Adds `recordIssuanceWithheld`, written in the one place evidence is written. A failure to write returns `false`; the withheld answer stands either way. |
| `governed-action/orchestrator.ts` | Every issuance-withheld branch (authority binding, emergency control, financial, parameter, grant/obligations) persists the result it just received, then returns exactly the answer it returned before. |
| `evidence/trace-builder.ts`, `trace-contracts.ts` | The authority stage is rebuilt from the row (`issuance`) and verified under `issuance.*`. |

The row sits on the decision's own evaluation and is sealed into the Governance
Store's per-evaluation reference chain:

| Field | Value (the 125K case) |
| --- | --- |
| `externalId` | the governed request id (request linkage) |
| `externalVersion` | `withheld:authority-binding:FINANCIAL_AUTHORITY_CEILING_EXCEEDED` |
| `uri` | `urn:aoc:issuance-record:v1;decision=<decisionId>;requested=USD:125000;ceiling=USD:100000` |
| `digest` | `sha256:` over every field above, in a fixed order |

`requested` is the committed request's amount. `ceiling` is the value the
issuance core compared against. Neither is re-derived.

### `authority.presence` semantics

- **Issuance evaluated and withheld:** the row exists, `presence` is
  `recorded`, `grants` is `[]`, and `issuance` is `{ outcome: 'withheld',
  withheldBy, reasonCodes, requested, ceiling, recordedAt, records }`. The
  trace's `finalState` stays `not-executed`.
- **Issuance truly never reached** (denied, indeterminate, refused before
  issuance) and **historical traces without the row:** unchanged, still
  `not-reached`, with no `issuance` field and no `issuance.*` checks.

### What ASSURE-01 verifies (never re-deciding the ceiling)

| Check | Meaning |
| --- | --- |
| `issuance.record-well-formed` | The grammar parses, the digest covers exactly these fields, and the reference id is the deterministic id for (evaluation, outcome). |
| `issuance.request-linkage` | The row names this request. |
| `issuance.decision-linkage` | The row names this committed decision. |
| `issuance.requested-amount` | The row's amount equals the committed request payload's amount and currency. |
| `issuance.on-executable-decision` | Withholding at issuance follows only an executable (allowed) decision. |
| `issuance.ceiling-stated-with-ceiling-reason` | A ceiling is stated if and only if the reason is `FINANCIAL_AUTHORITY_CEILING_EXCEEDED`. |
| `issuance.withheld-before-any-authority` | The row precedes any authorization or execution reference. |
| `issuance.no-grant-while-withheld` / `issuance.no-execution-while-withheld` | No grant or claim accompanies it. |

In-place tampering with a row is caught twice:

- the Governance Store's reference-chain integrity check (`integrity.governance-record`);
- the `issuance.*` checks.

A forged row, even one whose integrity has been resealed, fails the linkage
and requested-amount checks.

## 4. Tests

| Suite | Tests | Covers |
| --- | --- | --- |
| `andrew-p010-authority-ceiling-host.test.ts` | 11 | The composed Andrew demo: the real Host, real governance, the real transport package with its settlement gate and env signer, and a scripted ledger that counts every connect, sign and submit. It covers:<br>• preconditions: a Testnet address, `xrpl.testnet` key, `approved` with intact history, and the authority ceiling exactly USD 100,000 (asserted from the within-ceiling grant);<br>• 125K: Kernel `allowed`/`ACTION_ALLOWED`, `withheld/authority-binding/FINANCIAL_AUTHORITY_CEILING_EXCEEDED`, with zero grants, connections, signatures, submissions and attempt rows, no execution id, no provider ref, and approval history unchanged;<br>• the durable row equals the issuance-core result;<br>• no P11 attempt or observation for the would-be execution id;<br>• the trace is rebuilt from the row (`presence: recorded`, `issuance`, `finalState: not-executed`) and verifies, with all 9 `issuance.*` checks passing;<br>• a within-ceiling request is unaffected (no `issuance`);<br>• boundaries 99,999.99 / 100,000 proceed and 100,000.01 / 125,000 are withheld;<br>• a replay records once;<br>• tampering with the reason, ceiling, requested amount, decision linkage or request linkage fails verification (store integrity plus `issuance.*`) and restoring the row restores verification;<br>• forged rows whose digest is recomputed (amount, decision, request) are refused by the specific linkage check alone;<br>• a reconsidered 125K, after approving a previously denied destination, is still withheld by the ceiling, keeps the P0-09 lineage, and its trace verifies;<br>• the recorded P0-09 live evidence is intact. |
| `andrew-p010-issuance-record-unit.test.ts` | 3 | Exact round trip, every field bound by the digest, malformed rows and evidence refused |
| `authority-payment-ceilings.test.ts` | +1 case | USD 100 authority, EUR 125 request → `ASSET_MISMATCH`, never `CEILING_EXCEEDED` |

Assertions narrowed honestly, with intent kept:

- `ctrl03-activity-evidence-host`: "no grant or execution reference" now
  excludes the new evidence row, and the row is asserted
  (`withheld:authority-binding:PARAMETER_AUTHORITY_EXCEEDED`).
- `emergency-control-governed-action`: the same treatment, with the row asserted
  (`withheld:emergency-control:EMERGENCY_CONTROL_ACTIVE`).

These are the "P0-09 / earlier traces change only where the new evidence
legitimately applies" cases.

Structural pin updated: the ASSURE-01 builder import allowlist now includes
`issuance-record.js`, with a new test pinning that module pure (only
`node:crypto`, no store calls, no writes, no clock). The governed-action rules
hold unchanged:

- only `decision-commit.ts` verifies or evaluates;
- only `execution-ledger.ts` appends references.

## 5. Mutation campaign

Each mutant was applied in place, rebuilt, and run against the P0-10 suites
plus `xrpl-execution-adapter-host`, `authority-payment-ceilings`,
`authority-controlled-execution-scenario`,
`kernel-authority-monetary-constraints` and
`destination-approval-policy-host`; every source was restored afterwards.

| # | Mutant | Result |
| --- | --- | --- |
| A1 | ceiling compared with `>=` (an amount equal to the ceiling refused) | killed (16) |
| A2 | ceiling check removed | killed (15) |
| A3 | raw string comparison instead of `compareMonetaryAmounts` | killed (14) |
| A4 | asset unit ignored (ceiling unit assumed) | **equivalent**, see below |
| A5 | ceiling taken from the request | killed (15) |
| A6 | financial authority skipped (destination approval treated as authority) | killed (50) |
| A7 | grant issued after the ceiling failure | killed (24) |
| A8 | an execution fabricated on withholding | killed (16) |
| E1 | evidence records the requested amount as the ceiling | killed (3) |
| E2 | evidence never written | killed (6); the first form only failed to compile and was re-expressed |
| E3 | trace keeps `authority: not-reached` despite the row | killed (1) |
| E4 | trace accepts any digest | killed (1–2) |
| E5 | trace trusts the row's amount over the committed request | killed (1); survived the first run, then a forged-row test (digest recomputed) was added |
| E6 | trace trusts the row's decision linkage | killed (1); survived the first run, killed by the same forged-row test |
| E7 | `finalState` claims execution | killed (1) |

**A4 is equivalent.** An asset mismatch is rejected upstream, before the
ceiling comparison can affect behaviour: the resolver boundary
(`financial-authority.ts`, `snapshotResolution`) returns *unresolved* for any
authority whose ceiling unit differs from the request asset. When the issuance
comparison runs, the units are therefore always equal, and assuming the
ceiling unit changes nothing. The regression case that proves this path was
added
(`authority-payment-ceilings`: USD 100 authority, EUR 125 request →
`FINANCIAL_AUTHORITY_ASSET_MISMATCH`, never `CEILING_EXCEEDED`).

**Result: 14/15 killed; 1/15 equivalent (A4); 0 surviving non-equivalent mutants.**

## 6. Qualification

| Gate | Result |
| --- | --- |
| `npm run build` (`tsc -b`) | pass |
| `npm run lint` (Node16 imports, architecture, public surface) | pass |
| Root suite (`dist/src/**/*.test.js`, `tests/**/*.test.mjs`) | **9,724 tests: 9,708 pass, 3 fail, 9 skipped, 4 todo, 0 cancelled** (1,748 suites) |
| Workspace suites (`npm test --workspaces`) | **1,128 tests: 1,128 pass, 0 fail** |
| `git diff --check` | clean |
| Conflict-marker scan | none |
| Secret scan over the change (XRPL seeds, private keys, secret hex, signed blobs) | 0 / 0 / 0 / 0 |

**The 3 root failures are inherited, not caused by P0-10.** They fail
identically on the untouched base `13e8d3d` (`feat/andrew-demo`), and none of
their sources or tests is touched by this change. All three belong to the same
CRLF source-text family (`core.autocrlf=true` on this Windows checkout):

- `structural-boundaries` — *Provider credential exposure (R004.B)*:
  `loadEnterpriseConfiguration never falls back to a hardcoded, non-empty API key…`
  (the known R004.B issue).
- `credential-matching` — *extractBearerToken — structure*:
  `runs no regular expression over the Authorization header`. The test strips
  import lines with `/^import\s.*$/`; `.` does not match `\r`, so on CRLF the
  `$` anchor fails, the import line survives, and its `/` path trips the regex
  detector.
- `authority-administration-service` — *CTRL-01 structure*:
  `the HTTP adapter mounts administration only through the service…`
  (`the administration route matcher exists`). This is the same per-line
  source-regex technique applied to CRLF text.

The 4 `todo` entries are the documented FRONTERA-PROD-01 F1 `SQLITE_BUSY`
classification cases. They are known and not fixed here.

## 7. Contrast with P0-09 (recorded evidence, not rerun)

| | P0-09 live (recorded) | P0-10 (this task) |
| --- | --- | --- |
| Destination | approved (after reconsideration) | approved |
| Amount | 10 RLUSD (USD 10) | USD 125,000 |
| Authority | within the USD 100,000 ceiling → grant | above the ceiling → **withheld at issuance** |
| Chain | tx `7857B27CC2467B467C6EA5731AE919DBC43866A23C0B467C1AD03815FC76DCAC`, ledger 21304560, `tesSUCCESS` | **nothing**: 0 connections, 0 signatures, 0 submissions, 0 attempt rows |
| ASSURE-01 | `executed-confirmed-completed`, lineage verified | `not-executed`; `authority.presence: recorded`, `issuance: withheld / FINANCIAL_AUTHORITY_CEILING_EXCEEDED / requested USD 125000 / ceiling USD 100000`; verified |

The same agent, the same approved destination and the same governance stack:
the only difference is the amount, and the authority, not the destination,
stops it.
