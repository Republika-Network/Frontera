# CORE-07-FV-WITNESS — Independent freshness domains for FV identity

**Status: internal and non-operational. Not production-ready.**
- No FV store is enrolled anywhere in production, and the FV executor still composes nothing.
- The FV registration ceremony (the only path that may create and anchor the FV store) is not implemented.
- Bootstrap execution stays disabled (no trusted status source, B6).

This increment closes FV-P4C-2B3C-3's review **M1** at the API, persistence and verification levels: the
FV bootstrap identity store and AUTH-04A's Host identity store no longer compete for one CORE-07 witness
slot. Each now has its own **freshness domain** in the same organization.

## 1. What CORE-07 was (verified on main `560d1260`)
- A witness keys a checkpoint by `(stateKind, organizationId, namespace?)`
  (`authority-state-freshness/checkpoint.ts`) and records the `storeId` inside it.
- The kinds are a **closed** list. A small closed subset is **namespaced** (PAY-09:
  `payment-initiation-reservations`): such a kind *always* names a namespace, every other kind *never*
  does. Namespaced checkpoints serialize under a distinct v2 format, un-namespaced ones byte-for-byte v1.
- Every witness answer is a receipt signed with the witness's own Ed25519 key, over domain-separated
  canonical bytes (`frontera:authority-state-witness:receipt:v2`) that include the caller's fresh 32-byte
  challenge and the full binding. The client checks the signature under the pinned key, the witness id,
  the operation, the challenge and that the binding equals the one it asked about (`witness-client.ts`).
- The reference witness (`reference/reference-witness-service.ts`) stores one row per slot in
  `witness_bindings_v2`, keyed `(state_kind, organization_id, namespace)`, with compare-and-advance
  updates inside `BEGIN IMMEDIATE`, an append-only history, and triggers that refuse deletes, rebinding
  and moving backwards. `state_kind` is free text: the closed list is enforced by the protocol parser.
- AUTH-03 mapped every identity store onto the one kind `human-identity-state`. AUTH-04A's Host store
  anchors there. A second identity store in the same organization (the FV executor's) would therefore
  share the slot: its genesis would adopt the Host's store id, which defeats the FV store-id pin, and each
  store's appends would make the other refuse as a rollback (B3C-3 M1).

## 2. Selected domain identity model
**A domain is a CORE-07 state kind.** The closed list gains exactly one kind:

| Domain | Kind | Owner |
|---|---|---|
| Host identity | `human-identity-state` (legacy, unchanged) | AUTH-04A's Host identity store |
| FV bootstrap identity | `fv-bootstrap-identity-state` (new) | the dedicated FV executor's exclusive bootstrap identity store |

`HUMAN_IDENTITY_STATE_KINDS` names exactly these two. The logical identity is
`(organizationId, stateKind)`: the purpose ("AUTH-03 human identity history") and the owner are folded
into one closed, exact token.

**Why a kind and not a namespace of `human-identity-state`.** The namespace rule is closed per kind.
The Host's slot is un-namespaced. Adding a namespace beside it would need a *mixed* kind in which "no
namespace" means the Host, so an FV caller that omitted its domain would land in the Host's slot: the
downgrade this increment must rule out. With a separate kind:
- there is no default and no fallback: an FV caller must name its kind, and an unknown kind is refused as
  outside the closed set, never mapped to the Host;
- no namespace can be attached to either identity kind (both are un-namespaced);
- the Host's slot, canonical bytes, receipts and records stay exactly as they were.

**Canonical encoding.** Unchanged and already unambiguous: fixed, sorted JSON keys with JSON-quoted
values, so a kind and an organization are separate fields, never concatenated. The kind is compared
exactly; no trimming, case folding or Unicode normalization. Spaces, upper case, Unicode hyphens,
zero-width or control characters, and `:`/`/`/`.` joins are all refused (tested).

**Versioning.** No new checkpoint format, receipt domain or protocol id. No existing byte sequence changes
meaning: a Host checkpoint is byte-for-byte the v1 checkpoint it always was (pinned by a test), and an
FV checkpoint differs exactly in `stateKind`. An older v2 witness that does not know the new kind refuses
every FV request as malformed (its parser rejects kinds outside its list), so it fails closed; it can never
read an FV request as a Host one. A deployment's witness must therefore run this version before an FV store
is anchored at it.

## 3. Cryptographic binding and anti-replay
- The kind is inside every signed receipt (`binding.stateKind`) and every checkpoint the witness holds.
  A receipt about the Host's domain does not answer an FV request, nor the reverse: the client refuses it as
  `AUTHORITY_FRESHNESS_BINDING_MISMATCH` even when the signature, witness id and challenge are genuine
  (tested by re-routing an FV read to the Host's slot at the real witness, with the same challenge).
- Another organization's receipt is refused the same way (tested).
- A recorded receipt replayed to a later call answers another challenge:
  `AUTHORITY_FRESHNESS_WITNESS_UNAUTHENTIC` (tested with a genuine, older FV receipt).
- `storeId`, `sequence` and `stateDigest` stay bound as before.
- Domain identity is selected by trusted code, not by an untrusted caller: the AUTH-03 store maps its head
  onto the domain its owner configured, and the FV composition passes a constant (§5).

## 4. Domain isolation at the witness
Each domain is its own row, with its own genesis store id, committed position, pending successor, conflict
behavior and rollback context (tested on one witness, one organization):
- advancing the Host does not advance FV, and the reverse, including concurrently;
- a rollback of either store is detected by its own domain, while the other keeps opening;
- an FV genesis never adopts the Host's genesis (genesis adoption reads the requested slot only);
- concurrent conflicting FV prepares: exactly one is prepared, the other is a conflict;
- a repeated identical genesis is idempotent; a conflicting genesis is refused; nothing rebinds.

**One store, one domain.** The reference witness now refuses to enroll a store id already bound in
**another identity domain of the same organization**, inside the same immediate transaction. The answer
is a `conflict` with the requested slot still unbound. This rules out:
- the Host's store (or a copy) enrolled as the FV baseline or genesis;
- an FV store copied to the Host's path and enrolled by AUTH-04A's enrollment ceremony.

The rule covers only the two identity kinds; every other kind behaves exactly as before. It is part of the
witness protocol contract (`protocol.ts`): every witness implementation must enforce it atomically with the
enrollment. As defence in depth, the client also reads the other identity domain before a baseline
enrollment and refuses when it holds the same store id. That check is not atomic; only the witness's is.
Either refusal is `AUTHORITY_FRESHNESS_ALREADY_ENROLLED`, naming the other domain, and a refused genesis is
reported the same way (never retried as a lost race).

## 5. AUTH-03 store and FV integration
**AUTH-03 store** (`sqlite-human-identity-store.ts`): `freshness.stateKind` is the store's identity domain.
- Absent: the Host's legacy slot, exactly as before. AUTH-04A passes nothing new and is unchanged.
- `fv-bootstrap-identity-state`: only together with `exclusive` (the dedicated executor's exclusive
  ownership); otherwise `HUMAN_IDENTITY_CONFIGURATION_INVALID`.
- An exclusive owner with freshness must name the FV domain explicitly. Omitting it, or naming the Host's
  kind or any other value, is refused.
- The domain is read once. Every checkpoint (genesis, establish, every read's floor, every transition)
  goes through one mapping with that domain (pinned by a structure test).
- Every field of the freshness option (`boundary`, `enrollment`, `stateKind`) is read exactly once into a
  frozen snapshot, so a getter or Proxy cannot answer the checks one way and the witness another (review
  M1, reproduced and fixed).
- B3C-3's rules stand: an exclusive owner never enrolls; the store-id pin is checked before any write or
  witness contact.

**FV composition** (`protected-host-composition.ts`):
- `identity.freshness` must be `{ boundary, stateKind: 'fv-bootstrap-identity-state' }`. A missing domain,
  the Host's kind, any other spelling, or an `enrollment` is `OPTIONS_INVALID`.
- Each field is read once. The store receives a new frozen `{ boundary, stateKind: <constant> }`, never the
  caller's object, so a Proxy or a later mutation cannot change the domain (B3C-3's snapshot defense kept).
- Another organization's boundary is refused by the store (`IDENTITY_REFUSED`).
- Reopening checks the same domain and the same pinned store id.
- The composition never creates or enrolls its store (pinned by a structure test). An unbound FV slot is
  refused (`AUTHORITY_FRESHNESS_UNBOUND_STORE`, surfaced as `IDENTITY_REFUSED`), never enrolled.

## 6. Enrollment policy
1. **CORE-07 support for the domain:** implemented (the kind, witness isolation, the cross-domain rule).
2. **A narrowly testable genesis contract:** opening the AUTH-03 store with `create: true`, `exclusive`
   and the FV domain enrolls the FV genesis at the witness before the local genesis is committed (the
   standard CORE-07 genesis order). Only tests do this (`createAnchoredFvIdentity` in
   `tests/fv-p4c2b3b-support.mjs`, marked test-only).
3. **The FV registration ceremony:** not implemented. It is the only future path that may create the FV
   store; it must run against the deployment's own witness, record the new store id as the composition's
   pin, and never take an existing store.

Not provided: no production enrollment, no automatic enrollment at startup, no baseline enrollment of an
existing FV store (the exclusive owner refuses `enrollment`), no re-anchoring after a rollback, no reset.

## 7. Crash and uncertainty semantics
Unchanged CORE-07 rules, now per domain (FV cases tested with the real witness and a real FV store):

| Case | Behavior |
|---|---|
| Crash before the domain is enrolled | The FV slot stays unbound; an existing store is refused as unbound, never enrolled |
| Crash between genesis enrollment and the local genesis | The next initialization adopts that same store id (deterministic genesis); per slot only |
| Genesis enrolled, answer lost | A repeated identical genesis is `enrolled` (idempotent) |
| Prepare refused | Nothing is written locally |
| Prepare applied, answer lost | Nothing written locally; the witness holds a successor the store does not. Refused as `pending-recovery` at every start; never cleared automatically |
| Local commit done, finalize answer lost | Local and witness-pending agree; completed safely before the next transition or at the next start |
| Concurrent Host and FV advancement | Independent; both succeed |
| Concurrent conflicting FV advancement | One prepared, one conflict; nothing written for the loser |
| Witness unavailable | The store is refused (no fallback to a process-only floor); restoring the same witness restores it |
| A different key at the witness address | Refused at the handshake under the pinned key |
| Corrupt FV witness record | The FV store is refused as a fork; the Host store keeps opening |
| FV or Host store rollback | Refused by its own domain; the other domain is unaffected |
| Foreign store at the FV path, or a different domain configured | Refused (store-id pin, explicit domain) |
| Duplicate or conflicting genesis | Idempotent, or a conflict; no rebind |

A thrown or timed-out call never counts as "nothing happened": the witness state is read back, and what
cannot be proven safe stays refused for trusted operational recovery.

## 8. Threat model and what this does not provide
A CORE-07 witness gives freshness evidence under CORE-07's existing trust assumptions: its database lives
outside the stores' restore domain, and its receipt key and bearer credential are its own. This increment
adds per-domain separation inside one witness. It does **not** provide:
- **independent global currentness:** both domains trust the same witness. If the witness is restored
  together with the stores, or compromised, neither domain can detect it;
- **protection against coordinated restoration** of every trust component (FV-P4D);
- **trusted issuer status currentness** (B6);
- **Fileverse document enforcement** (FV-P5).

A separate witness per domain is possible (two boundaries), but nothing requires or provides it here.

## 9. Tests and review
- `src/enterprise/__tests__/core07-fv-identity-freshness-domains.test.ts`: domain identity and the
  legacy bytes, spellings, the AUTH-03 domain rules, independence, the one-store-one-domain rule, genesis
  idempotence and conflicts, cross-domain and replayed receipts, lost acknowledgments, outage, key
  substitution, corruption; real reference witness, real AUTH-03 stores.
- `tests/fv-p4c2b3c3-identity-ownership.e2e.test.mjs`: the composition against one witness holding both
  domains (M1 closed), explicit-domain refusals, other-organization refusal, independent rollback, and the
  PR #255 Proxy and late-mutation cases with the domain.
- Updated pinned expectations: the closed kind list (`authority-state-freshness-namespaces.test.ts`
  NS-3, `pay09-stripe-structure.test.ts`) and the AUTH-03 structure test (the genesis now uses the store's
  domain). No security assertion was removed.

**Independent review** (a read-only AI agent of the same model family; **not a human review**):

| Finding | Severity | Resolution |
|---|---|---|
| The AUTH-03 store read `freshness.enrollment` (and `boundary`) more than once, so a stateful getter passed the exclusive owner's "never enrolls" check and then supplied an enrollment: an existing FV store was baseline-enrolled. Reproduced against the real witness. Not reachable through the FV composition (which passes a frozen constant object). | Medium | Fixed: every freshness field is read once into a frozen snapshot. Regression test with a stateful getter; mutant killed |
| The one-store-one-domain rule lived only in the reference witness | Low | Fixed: written into the witness protocol contract; client-side check added before baseline enrollment |
| The closed kind set grew without a protocol bump; the `identity` handshake does not advertise kinds, so an older witness fails only on the first FV call | Low | Accepted: it fails closed and is never read as the Host slot. Documented as a deployment step |
| Any in-process caller of the store library can perform the FV genesis (`create` + `exclusive` + FV domain) | Low | Accepted for now: the composition never creates; the FV registration ceremony must gate it (§6, §10) |
| A cross-domain genesis refusal was reported as a lost race | Info | Fixed: reported as `ALREADY_ENROLLED` |
| "Conflict with an unbound slot" is read as the cross-domain refusal | Info | Accepted: a lying witness can only cause a refusal |

Counts are in the increment report and the CHANGELOG.

## 10. Known limitations
- The FV registration ceremony and FV credential enrollment and revocation do not exist; an FV store
  anchored at a witness exists only in tests.
- The cross-domain store rule is enforced atomically by the witness; the reference witness implements it,
  and a third-party witness must too (the client's own check is not atomic).
- Any trusted in-process caller of the AUTH-03 store library can perform an FV genesis; there is no
  registration capability yet. The FV registration ceremony must provide one.
- The witness handshake does not advertise the kinds it supports.
- A witness older than this version refuses FV requests (fail-closed); upgrading the witness is a
  deployment step.
- B3C-2 (backup and restore), deployment isolation, B6 and FV-P4D remain open. **Operational activation:
  NO-GO.**
