# AUTH-03 — Decision-bound human authority

**Status:** implemented in-process; not exposed. There is no route, no browser
flow and no Host composition yet (AUTH-04). Reference and pilot only: one Host
process, persistent SQLite.

## 1. What this gives

A named human's passkey approves or rejects **one exact CORE-05 subject**:

```
CTO passkey (user-verified WebAuthn assertion)
  └─ over a challenge whose bytes ARE the commitment to
       {org, approvalRequestId, subjectDigest, verdict, operatorId, nonce, issuedAt, expiresAt ≤ 120 s}
      └─ verified by the Host (pinned RP ID + origin, owner, active human & credential, counter, unexpired, unconsumed)
          └─ consumed + decision evidence recorded (signed identity store, CORE-07 witnessed)
              └─ CORE-05 approve | reject with context {operator:<id>, frontera:human-passkey-decision}
                  └─ CORE-05 still judges Kernel-Authority standing, SoD, duplicates, expiry, quorum
```

| Question | Answer |
|---|---|
| Who is this human? | AUTH-02 (passkey recognition) |
| Did this human authorize *this exact* decision? | **yes — AUTH-03** |
| Does their verdict count? | CORE-05, unchanged |
| Can a browser, session or BFF approve by itself? | no |
| Can the static operator bearer approve through this path? | no — it is not an input |
| Is it reachable over HTTP? | no (AUTH-04) |

Files:

- `src/enterprise/human-identity/decision-challenge.ts` — the contract, commitment and evidence.
- `src/enterprise/human-identity/service.ts` — `beginDecision`, `peekDecision`, `authorizeDecision`, `recordDecisionOutcome`, `decision`.
- `src/enterprise/human-identity/sqlite-human-identity-store.ts` — signed, witnessed store (schema v2).
- `src/enterprise/approval-authority/human-decision.ts` — the CORE-05 passkey channel.
- CORE-02: `authority-signature.ts`, `signer.ts`, `verifier.ts` — one new domain and artifact.
- CORE-07: `checkpoint.ts` — one new state kind, `human-identity-state`.

## 2. The decision challenge contract

| Field | Rule |
|---|---|
| `format` | `frontera.human-decision-challenge.v1` |
| `organizationId` | the identity store's (= the Host's) organization. **Never taken from a caller.** An extra `organizationId` in the input is ignored (tested). |
| `approvalRequestId` | the CORE-05 approval request |
| `subjectDigest` | `sha256:<hex>`, the exact CORE-05 subject the human was shown |
| `verdict` | `approve` or `reject` |
| `operatorId` | the human who may answer; only their active passkeys are offered |
| `nonce` | 32 bytes from the CSPRNG |
| `issuedAt` / `expiresAt` | lifetime 1–120 s, default 120; a configuration above 120 is refused |

**Commitment** = `sha256:` hex of `frontera:human-decision-challenge:v1\n` ‖
canonical JSON (sorted keys, no whitespace) of the contract.
**WebAuthn challenge** = base64url of the commitment's 32 bytes.

The authenticator signs WebAuthn client data that contains the challenge, so
its signature covers every bound field. The Host recomputes the commitment
from its own stored contract before believing it: a stored contract altered
after issuance (verdict, subject, request, human, organization) no longer
matches its challenge and is refused (tested for each).

`begin` issues a challenge only when the human's configured CTRL-02 role reaches
the verdict (`approval.approve` / `approval.restrict`) and CORE-05 shows the
request pending, not superseded, with that exact subject digest.

## 3. Signed identity state (CORE-02)

**Founder decision (TD-5 narrowed).** The deployment authority key may sign
exactly one identity artifact: the human identity store's state commitment
`{storeId, organizationId, sequence, chainDigest}`, under the domain
`frontera:authority-artifact:human-identity-state:v1`. Still no passport,
credential issuance or generic signing. The TD-5 structure test is amended to
permit exactly that one operation and nothing else.

- `AuthorityArtifactSigner.signHumanIdentityState?` — optional, like the other
  later operations. The software signer implements it.
- `AuthorityArtifactVerifier.verifyHumanIdentityState` — required.
- **External custody fails closed.** The external signer protocol is not
  extended, so an external signer has no `signHumanIdentityState`, and the
  store refuses to open (`HUMAN_IDENTITY_STORE_UNSUPPORTED`). There is no
  unsigned fallback.

**Verification.** At open and before every write, the store verifies the head
signature against the trusted verification keys and recomputes the chain over
every row. A head under a trusted, non-active key is re-signed unchanged at
open (the CORE-01 rotation rule, as CORE-05 applies it).

**Tested refusals:** a consistent rewrite by a database-only writer (a
revocation deleted, chain and head recomputed, no key); a head signed by an
untrusted key; a tampered or deleted row; a v1 (AUTH-02) file; a signer
without the operation.

### Key custody assumptions

- The authority private key is held as CORE-02 already requires: software
  custody (`AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_PEM`) for the reference/pilot,
  or external custody, which is **not yet usable** for this store (above).
- A holder of the authority signing key can forge any identity state, exactly
  as for approvals and grants. AUTH-03 adds no new key and no new trust root.
- Passkey private keys never reach the Host. Only public keys are stored.
- No new external production dependency or signing service is introduced.

## 4. Freshness and rollback (CORE-07)

New state kind `human-identity-state` — authority material, kept outside the
authority-store enrollment ceremony (it is not one of `AUTHORITY_STORE_KINDS`).
With `freshness` composed:

- a new store's genesis is enrolled at the witness before it is committed;
- the head is compared with the witness at open, before the store is returned;
- every append runs prepare → local synchronous commit → finalize.

**Tested:** restoring the file from before a consumed decision (to replay it),
and from before a revocation (to resurrect a passkey), are both refused at open
with `AUTHORITY_FRESHNESS_ROLLBACK_DETECTED`.

**Scoped (stated, tested):** without a witness, a restored older file is
believed across a restart. The secure composition (AUTH-04) must compose the
witness.

**Not protected:** restoring **both** this file and the witness to a common
older state; and the holder of the authority signing key. No production witness
configuration is changed.

**Refusal discipline.** A commit that fails after `prepare` leaves the store in
pending recovery. So every ordinary refusal is decided against the verified
history before signing and before `prepare`; a commit failure afterwards means
tampering or a second writer.

## 5. One verdict per challenge — atomicity without a cross-store transaction

The identity store and the CORE-05 store are separate SQLite files with
separate signed heads. A single transaction across both would need invasive
changes to CORE-05's transaction semantics, which the authorization forbids.
AUTH-03 uses a **consume-then-record** order instead:

1. `peekDecision` recomputes the commitment; the channel re-runs every
   ordinary pre-check against CORE-05 now (role, pending, subject, not
   superseded, not already approved by this human). **A refusal here consumes
   nothing** (tested).
2. `authorizeDecision` verifies the assertion and, in **one signed append**,
   records one `decision_authorized` row (the evidence, the challenge digest
   and the credential's new counter — CORE-07 advances a store by exactly one
   position per transition, so every append is one row). A unique index and the guard over the verified
   history refuse a second authorization of the same commitment.
3. The channel calls CORE-05 `approve` or `reject`.
4. The outcome (`recorded` / `refused`) is recorded best effort.

| Failure | Result |
|---|---|
| Crash between 2 and 3 | consumed challenge, **zero** verdicts; the human starts a new decision (tested) |
| Replay of the same assertion | `HUMAN_IDENTITY_DECISION_CHALLENGE_CONSUMED`; CORE-05 never reached again (tested, also after restart) |
| Two concurrent submissions | exactly one verdict (tested) |
| CORE-05 recorded but the reply was lost | `outcome()` reads it from CORE-05: the verdict whose `recordedBy` is the passkey channel, whose actor is the human and whose evidence hash is this decision's evidence digest (tested) |
| CORE-05 refuses (no standing, SoD) | challenge consumed, nothing counts, outcome `refused` (tested) |

CORE-05 itself still refuses a duplicate approval by the same approver and any
verdict on a closed request. The guarantee is **fail closed**: a challenge
yields at most one verdict, never one recorded twice, and its outcome is never
guessed. It is an in-process, single-Host-process guarantee; no multi-process
claim is made.

## 6. CORE-05 integration

- Context: `{ authenticated: true, actorId: 'operator:<operatorId>', authenticatedBy: 'frontera:human-passkey-decision' }`,
  built in exactly one function, reached only after `authorizeDecision`
  returned (structure test).
- Command: `{ approvalRequestId, subjectDigest, evidence: [{ type: 'approval_proof', hash: <evidence digest>, uri: 'frontera:human-passkey-decision:<commitment>' }] }`.
- CORE-05 approval semantics, signed approval history, subject binding,
  Kernel-Authority checks, SoD, G-02 guarantees, replay protection and
  emergency stop are unchanged: no CORE-05 source is modified. A passkey
  approval resumes the governed action through the canonical path, executed
  exactly once (tested on the shipped Host).
- The CTRL-04 operator-plane path (static operator bearer) is unchanged behind
  its existing private boundary. It is not an alternative input to this path,
  and AUTH-04 must not expose it as a public bypass around it.

## 7. Evidence semantics

`HumanDecisionEvidence` (`frontera.human-decision-evidence.v1`):
`organizationId, operatorId, actorRef, credentialId, challengeCommitment,
assertionDigest, approvalRequestId, subjectDigest, verdict, decidedAt, rpId,
origin, userVerified: true, backedUp`.

- `assertionDigest` = sha256 over the exact credential id, client data,
  authenticator data and signature received.
- The evidence digest is recorded in the signed identity store row and cited
  as `approval_proof` in the CORE-05 verdict row, whose digest the signed
  approval log commits to — so the approval proof digest (and any resumed
  grant's signed source) transitively binds it.
- **Proves:** the holder of that registered passkey completed a user-verified
  WebAuthn assertion over this exact decision's commitment, at the pinned
  relying party origin, before expiry.
- **Does not prove:** who physically held the authenticator; that the human
  read the subject (AUTH-04 renders it); device integrity (attestation is
  `none`). Biometric verification does not itself sign business semantics: the
  authenticator signs WebAuthn client data, bound to the decision by the
  commitment. No secret, session or raw authenticator output beyond digests is
  stored.

## 8. AUTH-04 route and BFF contract (documentation only — not implemented)

1. **No public approval endpoint without this mechanism.** A future route may
   only (a) begin a decision for the authenticated human and (b) submit the
   WebAuthn assertion to `HumanDecisionChannel.decide`. It never accepts an
   actor, organization, verdict override or bearer secret.
2. **Organization** comes only from Host configuration.
3. **Human identity for `begin`** comes from a recognized passkey session
   (AUTH-02 `finishAuthentication`) or an equivalent server-side session.
   The session can *begin* a decision; it can never *complete* one — only a
   fresh assertion over the decision commitment does.
4. **The browser never holds a static operator bearer secret.** The CTRL-04
   bearer path stays private and must not be proxied by the BFF.
5. **The subject shown** is CORE-05's canonical subject (`describe` / `list`),
   rendered from the same bytes the subject digest covers.
6. **Composition** opens the identity store with the deployment authority
   signer and verifier and the CORE-07 witness (mandatory in the secure
   profile), and takes `roleOf` from the configured CTRL-02 operator registry.
7. **No unrestricted enrolment route.** Enrolment stays
   administrator-authorized (AUTH-02).
8. **Errors**: a consumed decision returns its outcome, never a retry path.

## 9. Not done here (by design)

- No route, BFF, browser UI, mobile flow or Host composition (AUTH-04).
- External signer protocol support for `signHumanIdentityState`.
- Multi-process concurrency guarantees.
- Protection against simultaneous rollback of the identity file and the witness.
