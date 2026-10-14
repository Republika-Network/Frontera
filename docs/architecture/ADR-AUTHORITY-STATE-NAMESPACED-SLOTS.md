# ADR — Namespaced Authority-State Slots (CORE-07 v2, PAY-09 multi-rail hardening)

- **Status:** accepted — PAY-09 multi-rail hardening (branch `feat/pay-09-stripe-fiat-rail`, PR #185)
- **Amends:** `ADR-AUTHORITY-STATE-FRESHNESS-AND-ROLLBACK-DETECTION.md` (CORE-07) §2.3, §2.4, §3, §5
- **Protocol:** `frontera.authority-state-witness.v2` (supersedes v1)

## 1. Context — the defect, reproduced

CORE-07 keyed every witness slot by `(stateKind, organizationId)` and bound one
`storeId` inside it. PAY-06 (Lightning) and PAY-09 (Stripe) each keep their own
durable, append-only payment-initiation interlock, and both anchored it under
the one rail-neutral kind `payment-initiation-reservations`. Under one
organization the second interlock to open therefore met a slot already bound
to the other rail's store:

```
same org, Lightning interlock opened, then Stripe:   Stripe refused
same org, Stripe interlock opened, then Lightning:   Lightning refused
code: AUTHORITY_FRESHNESS_ROLLBACK_DETECTED (at genesisStoreId — the slot held
      another store's genesis, whose digest is not this store's)
```

Reproduced on the merged tree before any change (`5cea24e`), both orders. The
pre-hardening PAY-09 suite recorded it as `SIL-12` — fail closed, never a
shared or replaced store, but **not** a multi-rail architecture: one
organization could compose only one payment-initiation rail, and PAY-07's
canonical suite (one rail per world, each with its own witness) could never
see it.

## 2. Decision — a generic, closed namespace dimension

```
AuthorityStateBinding {
  stateKind       closed set (unchanged)
  organizationId
  namespace?      present EXACTLY when stateKind is namespaced
}
NAMESPACED_AUTHORITY_STATE_KINDS = ['payment-initiation-reservations']   (closed)
```

- **A namespaced kind** is a family of independent histories in one
  organization, each kept by its own store, each needing its own slot. Its
  binding always names a namespace. **Every other kind** never does; its slot
  is exactly the CORE-07 slot.
- **The namespace** is a bounded canonical token
  (`^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`, ≤ 64): lowercase words joined by single
  hyphens — no dot, colon, slash, underscore, space or upper case, so never a
  path, a URL or a second spelling of the same value. It is validated before it
  is written or sent, compared exactly, never trimmed or case-folded, not
  secret and not executable.
- **CORE gives it no meaning.** CORE-07 knows only "a separate slot of this
  kind"; it names no rail, provider or protocol
  (`authority-state-freshness-structure.test.ts`). The **caller** chooses the
  namespace — and for payment initiation the caller is the trusted composition
  that opens the interlock: each interlock anchors under its **configured,
  validated rail id** (`scope.railId`, `isPaymentRailId` at configuration, then
  `isAuthorityStateNamespace` at open). Never anything from a payment request,
  the provider or the node. A non-canonical rail id refuses the interlock
  before any file or slot exists.
- **The binding type stays closed** — one optional field, no property bag.

So, for one organization:

```
(payment-initiation-reservations, ORG, lightning-btc) → Lightning interlock store
(payment-initiation-reservations, ORG, stripe-usd)    → Stripe interlock store
(xrpl-submission-reservations,    ORG)                → XRPL interlock store   (unchanged)
(bounded-grant-revocation-state,  ORG)                → grant store            (unchanged)
… every other kind                                     unchanged
```

### 2.1 Where the namespace is inside the security boundary

| Object | How the namespace is bound |
|---|---|
| checkpoint bytes | `serializeAuthorityStateCheckpoint`: an un-namespaced checkpoint is byte-for-byte v1 (`frontera.authority-state-checkpoint.v1`); a namespaced one serializes only under `…checkpoint.v2`, with `"namespace"` in the sorted keys — v1 bytes can never denote a namespaced slot |
| request bodies | `read.binding`, and every `enroll` / `prepare` / `finalize` checkpoint, carry `namespace` for a namespaced kind; parsed with exact keys; a namespaced kind without it, a namespace on any other kind, `""`, or a non-canonical value is refused (HTTP 422), never defaulted |
| `prepare` | `expected` and `proposed` must name the same namespace — a transition never moves between slots |
| receipts | `binding.namespace` is in the canonical, domain-separated, signed receipt bytes (receipt domain `…receipt:v2`) |
| client verification | `sameBinding` compares kind, organization **and** namespace; an authentic receipt about namespace A answering a question about B is `AUTHORITY_FRESHNESS_BINDING_MISMATCH`; a receipt relabelled from A to B no longer verifies (`…WITNESS_UNAUTHENTIC`) |
| session | one session per slot: its floor, sticky failure, pending state, outstanding finalize and queue belong to that binding only; its status carries `namespace` |
| witness storage | `PRIMARY KEY (state_kind, organization_id, namespace)`; every statement that reads or moves a binding filters on the namespace |

The namespace is **not** in `stateDigest` — the digest is each store's own
already-witnessed head and does not change. It is in every object that
establishes *which slot* was operated on, which is what slot isolation needs.

### 2.2 Versioning

`frontera.authority-state-witness.v1` → **v2**: protocol id, receipt signing
domain and the five paths (`/v2/…`) all changed. A v1 witness is refused at the
identity handshake (`AUTHORITY_FRESHNESS_MALFORMED_RESPONSE`), never spoken to
as if it understood a namespace; a v1 request is refused by a v2 witness. No
old version string is reused for the new semantics.

## 3. Legacy and default semantics — never inferred

- **Un-namespaced kinds** (grants, discharges, approvals, XRPL reservations,
  business operations, refunds) resolve to the **same** slot, the same
  canonical checkpoint bytes and the same witnessed state as under v1
  (`LEGACY-1`, `LEGACY-4`, and every pre-existing CORE-07 / PAY suite, run
  unchanged). In storage their slot is `namespace = ''` — a value no namespace
  can take — so the un-namespaced slot and a namespaced one can never alias
  (`SCOPE-6`).
- **A v1 binding of `payment-initiation-reservations`** (a Lightning interlock
  anchored before this change) keeps exactly its v1 meaning: the un-namespaced
  slot of a namespaced kind, which **no v2 request can name**. It is never read
  as `lightning-btc` or any other namespace (`LEGACY-2`, `MIG-1`). The
  interlock it belongs to is refused at open (`AUTHORITY_FRESHNESS_UNBOUND_STORE`)
  until an operator moves the slot explicitly (§4.2). Fail closed, never
  silently adopted.

## 4. The reference witness — migration and rescope

### 4.1 v1 → v2 database migration (automatic, atomic, lossless)

On start, a v1 database is migrated in place, once, inside **one**
`BEGIN IMMEDIATE` transaction, before anything is answered:

1. `witness_history` gains `namespace TEXT NOT NULL DEFAULT ''` (every v1 event
   keeps `''`);
2. `witness_bindings_v2` is created and every v1 row is copied into it with
   `namespace = ''` — exact store id, committed sequence and digest, pending
   sequence and digest — and then **verified row by row** against the v1 table;
3. the v1 table `witness_bindings` is **kept** with every row and **frozen**
   (triggers refuse insert and update; delete was already refused);
4. the migration is recorded in append-only `witness_migrations`; `witness_meta.protocol`
   becomes v2.

No table is dropped or recreated. Any failure rolls the whole transaction back
— the database is left exactly v1 — and the witness refuses to serve
(`MIG-3`). A database of another witness, of an unknown protocol, or holding
witness tables with no meta row is refused (`MIG-4`). Restarting never migrates
twice.

### 4.2 Rescope of a legacy payment-initiation binding (explicit operator act)

`rescopeLegacyAuthorityStateBinding(databasePath, { witnessId, stateKind,
organizationId, storeId, namespace, operator: { operatorId, attestation:
'legacy-binding-belongs-to-namespace' } })` — trusted, in-process, offline
(witness stopped), no route; like the enrollment ceremony. One immediate
transaction; refused with nothing written unless the database is this
witness's at v2, the kind is namespaced, the namespace canonical, the legacy
slot exists, binds **exactly the stated store** and has no pending
transition, the target slot is empty, and that store was never rescoped
(`witness_rescopes`, append-only, `UNIQUE (kind, organization, store)`). The
new slot carries the legacy store id, committed sequence and digest exactly, so
rollback detection continues from the witnessed head — nothing is re-baselined
(`RESCOPE-1 … RESCOPE-3`). The legacy row stays, unaddressable.

## 5. XRPL — unchanged, deliberately

PAY-03's XRPL interlock keeps its own un-namespaced kind
`xrpl-submission-reservations`. It already has its own slot, one per
organization, and a Host composes one XRPL rail per organization; it does not
collide with payment initiation. Migrating it into the namespaced family would
change a qualified, deployed slot for symmetry only — a risk with no safety
gain. If an organization ever needs two XRPL interlocks, that is a separate,
deliberate change.

## 6. Rejected alternatives

| Alternative | Why not |
|---|---|
| One state kind per rail (`stripe-payment-initiation-reservations`, …) | teaches CORE rail vocabulary; one CORE change per rail; the closed kind list would grow with every provider |
| One shared multi-rail initiation store per organization (rail-scoped entries in one chain) | moves Lightning and Stripe semantics (payment hash, payer node, PaymentIntent, idempotency keys) into one schema, rewrites both qualified interlocks, and serializes unrelated rails' writes through one chain; the per-rail stores are operationally simpler and already qualified |
| An optional namespace on every kind | lets a legacy kind be namespaced by mistake and a namespaced kind fall back to the legacy slot; the closed per-kind rule makes both impossible |
| Deriving the namespace from the stored store id prefix, or migrating v1 payment-initiation rows into a namespace automatically | silent inference from data CORE does not own; the rescope is explicit and operator-attested instead |

## 7. What is unchanged, and what is still not claimed

Rollback, fork, store-substitution, pending-transition and outage semantics are
exactly CORE-07's — now **per slot**. A refusal in one namespace never touches
another (`SCOPE-4`, `SCOPE-5`, `COEX-5 … COEX-14`). The witness's trust
assumption is unchanged and stated once: **if an authority store and the
witness are restored together to the same earlier consistent snapshot, nothing
can detect it** — the witness database must never share a restore domain with
the stores it anchors.

## 8. Evidence

- `src/enterprise/__tests__/authority-state-freshness-namespaces.test.ts` — NS-1 … NS-3, LEGACY-1 … LEGACY-4, SCOPE-1 … SCOPE-6, MIG-1 … MIG-4, RESCOPE-1 … RESCOPE-3
- `src/enterprise/__tests__/authority-state-freshness-structure.test.ts` — CORE-07 names no rail concept; the binding is closed; every witness statement filters the namespace; the migration drops nothing
- `src/enterprise/__tests__/pay07-multi-rail-coexistence.test.ts` — COEX-1 … COEX-4, COEX-7, COEX-8, COEX-15, COEX-16 (XRPL, Lightning and Stripe edges, one organization, one witness)
- `src/enterprise/__tests__/pay09-multi-rail-coexistence.test.ts` — COEX-5, COEX-6, COEX-9 … COEX-14, pending isolation, namespace provenance
- `src/enterprise/__tests__/pay09-stripe-interlock.test.ts` — SIL-12 (inverted: the second rail opens; a second store under the same rail id is still refused)
- Mutations M-C1 … M-C9 — `docs/payments/PAY-09-STRIPE-FIAT-RAIL.md` §17
