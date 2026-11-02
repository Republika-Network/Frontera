# B7 — Report Authenticity: Threat Model and Options (ASSURE-GOV-01)

> **FINAL COMMERCIAL DECISION: NO-GO.** **STATUS: DRAFT — analysis and
> recommendation only.** Nothing here implements signing, and no option is
> selected. The choice is founder decision D-03, with SEC and LEG approval and
> an independent security reviewer's opinion (R1). Labels: VERIFIED · PROPOSED ·
> PENDING · BLOCKED.

**What any option can and cannot prove.** A signature, a timestamp or an anchor
can show *who issued* a package and *when*, and that it was not changed
afterwards. **None of them shows that the customer-supplied evidence is genuine,
or that the reviewer's conclusions are correct** (B1). Customer-facing
language must never suggest otherwise.

## 1. Current architecture (VERIFIED by code and document reading)

| Element | Fact | Source |
| --- | --- | --- |
| Integrity digests | SHA-256 digests bind assessment, framework, generator, content, Markdown and release (`releaseDigest`) | `commercial-report.ts`, `AOC_ASSURANCE_COMMERCIAL_REPORT.md` |
| Release record | Unsigned JSON; approver = the credential the Host authenticated | REL-01A §5 |
| Custody | One append-only SQLite table on the issuer's Host; triggers refuse UPDATE/DELETE; v2 records keep the approved artifacts | REL-01A §6, §16a |
| Authoritative verification | `POST /api/assurance/commercial-releases/verify`: integrity and authority separately; `externalSignature: EXTERNAL_SIGNATURE_NOT_AVAILABLE` always | REL-01A §10, REL-01D §4 |
| Offline verification | `verify-commercial-package.mjs`: integrity and consistency; with `--store-copy`, compares to an `UNAUTHENTICATED_COPY`; verdict ends `external authenticity NOT DEMONSTRATED` | REL-01A §11; reproduced in this mission |
| Backups | Engagement backups sealed with AES-256-GCM (symmetric); verify-by-restore | OPS-02 §4, §7 |
| Existing signing code (not used by Assurance) | Ed25519 authority-artifact signer and verifier with a closed algorithm registry, key IDs and custody registration | `src/enterprise/authority-authenticity/` (`signer.ts`, `verifier.ts`, `signature-envelope.ts`), `docs/security/AUTHORITY_ARTIFACT_AUTHENTICITY.md` |

## 2. Threat model

Adversaries extend REL-01A §2 (A1–A10). "Detected" means a party performing
the stated verification would notice.

| # | Threat | Today (unsigned) | Notes |
| --- | --- | --- | --- |
| T1 | **Unsigned release records**: a third party edits a package and recomputes every digest | Offline: **not detected**. Against custody: detected | REL-01A A2/A3; PILOT-01 F01 test |
| T2 | **SHA-256 digests treated as authenticity** by a recipient | Misreading risk; digests are self-referential | Disclosed in report cover limitation and draft G §11 |
| T3 | **Issuer-controlled SQLite custody**: custody is Republika's own record | No non-repudiation independent of the issuer | REL-01A §2 trust levels |
| T4 | **Recomputed manifests**: a writer rewrites a custody row and every digest coherently | **Not detected**; exported as `RELEASE_MATCHES_AUTHORITY` | A10, pinned test |
| T5 | **Store administrator compromise** (insider or stolen OS access) | Same as T4; plus can read all engagement data | Volume encryption does not help against a live admin |
| T6 | **Backup rollback**: restore to an older backup | Later releases become `RELEASE_NOT_IN_CUSTODY` and re-releasable | REL-01A §12 |
| T7 | **Forged release approvals**: a release attributed to an approver who did not approve | Over the API: refused (credential-bound). By store writer: T4. By leaked credential: indistinguishable | B3 residual |
| T8 | **Offline package verification** by a customer or third party without Republika | Integrity only; authenticity impossible | By design today |
| T9 | **Independent verification against Host custody**: verifier given a store copy | Copy is unauthenticated; a forger supplies a matching copy | REL-01A §11 |
| T10 | **Customer reliance on the delivered report** with a third party | The customer cannot prove origin without Republika; after deletion, no one can | `../CUSTOMER_DATA_GOVERNANCE.md` §11 |
| T11 | **Issuer equivocation**: Republika (or a compromised Republika) shows different versions to different parties | Not detectable by either party | Only external anchoring addresses this |
| T12 | **Backdating**: a report produced later claims an earlier issue date | Not detectable offline; custody holds `approvedAt` set by the Host clock | Timestamps address this |

## 3. Options

### Option A — Controlled private pilot with unsigned reports

Issuer-side verification, plus custody that someone other than the store
administrator corroborates independently, explicit limitations and a documented
residual risk. **No code change.** The procedural measures A-1…A-5 are
PROPOSED.

| Measure | Content |
| --- | --- |
| A-1 Second-channel digest confirmation | The customer confirms `releaseDigest` with Republika over a channel independent of delivery (draft H). Existing proposal. |
| A-2 **Delivery confirmation letter** | An ordinary business letter, signed by FDR with the organization's normal e-signature or wet signature, quoting `reportId`, `releaseDigest`, framework version and date. The customer keeps it. It gives the customer an attributable issuer statement **outside the Host**. It is a commercial document, not a cryptographic system signature. Wording: LEG. |
| A-3 Corroborated custody | After every release, a sealed cold backup (OPS-02) is copied off-host and held by a person **other than** the store administrator (SEC), with the backup key held separately. A later rewrite by the store administrator is then detectable by comparing with SEC's copy. Limitation: whoever holds the symmetric key can forge a sealed backup (OPS-02 §15), so key and store administration must be separated. |
| A-4 Internal-use restriction | The SOW limits use to the customer's internal governance. No third-party reliance (T10) without Republika's written consent per instance. |
| A-5 Disclosure | Draft G §11 and the report cover limitation, plus the B7 sentence in [`CUSTOMER_CLAIMS_REVIEW.md`](CUSTOMER_CLAIMS_REVIEW.md) §4. |

### Option B — Digitally signed releases

Republika signs `releaseDigest` (or the whole release record) with an issuer
private key. The package carries the signature and key ID. The verifier checks it
against a public key that the customer obtains **independently of the package**.

| Element | Design requirement |
| --- | --- |
| Algorithm | Ed25519, reusing the closed-registry pattern in `authority-authenticity/` (VERIFIED to exist; reuse not yet assessed in detail). No algorithm agility from the artifact. |
| Key identifiers | `keyId` in the signature; a published key set listing `keyId`, public key, validity start, and status. |
| Public verification | The public-key fingerprint appears in the **signed SOW annex** and on a Republika-controlled publication point (for example, a static page). The verifier needs no Host access. |
| Private-key custody | Held by SEC, **not** by the store administrator (OPS), so that T4/T5 require collusion. Software key on an encrypted, access-controlled device for a pilot; KMS or HSM for scale. Signing at release time needs either an online key (on or reachable from the Host, which weakens separation) or an offline signing step after release (manual, which keeps separation). PROPOSED: offline signing step for the pilot. |
| Rotation | New key per year or per N engagements; old public keys stay published for verification. |
| Revocation | A revocation list with **effective compromise time**. Without a trusted timestamp (Option C), every signature by a revoked key becomes doubtful, because a forger with the key can claim an earlier date. |
| Verifier | `verify-commercial-package.mjs` gains signature verification; the authoritative route reports `externalSignature` truthfully. |
| Code | Backlog R-01 (code + key management). Not in this mission. |

### Option C — Signed releases plus external timestamp or independent anchoring

Option B, plus one of:

- **C-1 RFC 3161 trusted timestamp** over the signature, from a timestamp
  authority (TSA). It proves the signed digest existed at time *t*. It
  addresses backdating (T12) and keeps pre-compromise signatures verifiable
  after revocation.
- **C-2 Independent anchoring** of `releaseDigest` in an append-only log that
  Republika does not control (a public transparency log, or a third-party
  escrow). It addresses equivocation and unilateral rewriting (T4, T11): a
  rewritten report would need a new anchor with a later time, contradicting the
  customer's copy.

Disclosure concern for C-2: publishing a digest reveals that a release occurred,
and when, even though it does not reveal the content. This needs LEG and customer
consent. **Not assessed for any specific provider.**

## 4. Comparison

| | Option A | Option B | Option C |
| --- | --- | --- | --- |
| **Security guarantees** | Integrity offline; authenticity only by asking Republika; A-2 gives an attributable issuer statement; A-3 makes unilateral store rewriting detectable by a second Republika role | Offline origin authenticity: "the holder of key K signed this release". Survives rollback (the customer's signed copy stays provable) | B, plus proof of existence at time *t* (C-1) and/or resistance to rewriting and equivocation (C-2) |
| **Threats mitigated** | T2 (disclosure), T6 partly (A-3), T4/T5 partly (A-3, separation), T10 partly (A-4 limits reliance) | T1, T8, T9, T10; T4/T5 only if key custody is separated from store administration; T6 for already-delivered copies | B's, plus T12 (C-1); T11 and T4 by a key holder (C-2) |
| **Threats remaining** | T1, T8, T9 (offline forgery), T11, T12; collusion of SEC and OPS; B1 | Key-holder forgery (insider with key); T11, T12; key compromise before revocation; B1; T7 by leaked approver credential (signature is the issuer's, not the person's) | Collusion that controls both key and timestamp/anchor requests before delivery; B1; T7 (person-level approval needs R-03 passkeys) |
| **Dependencies** | None new; FDR availability to sign letters; a second person (SEC) for A-3 | R-01 code mission; a key-custody procedure; a publication point; SOW annex | B; a TSA or log provider; LEG on publication |
| **Operational complexity** | Low: about four manual steps per release | Medium: key ceremony, signing step, rotation, revocation list, verifier updates | Medium–high: adds provider integration, token storage, provider availability |
| **Key-management obligations** | Backup key separated from backups and from store admin (exists in OPS-02) | Generation ceremony witnessed by SEC; custody; backup of the private key; rotation; revocation; publication | B's, plus TSA trust anchors / log keys to keep for verification over the retention period |
| **Incremental operating cost — verified** | None identified: no new software or service | Software: none (Node `crypto` and the in-repo signer exist — VERIFIED). No service price was verified | No provider price was verified |
| **Incremental operating cost — assumptions** (unverified; check vendor pricing before budgeting) | ~0.5 h FDR + ~0.5 h SEC per release (ASSUMPTION) | Engineering: one to two missions for R-01 (ASSUMPTION). Pilot custody on an encrypted device: no recurring fee (ASSUMPTION). A cloud KMS key typically has a low monthly fee plus per-operation charges; a dedicated HSM costs substantially more (ASSUMPTION — no figures verified) | Free public TSAs exist without service guarantees; commercial TSA subscriptions carry recurring fees; public transparency logs may charge nothing but impose publication (ASSUMPTION — no figures verified) |
| **Customer experience** | Must contact Republika to confirm; keeps a signed letter | Runs the verifier offline with the public key from the SOW | As B, plus timestamp or anchor check (more tooling to explain) |
| **Implementation effort** | Procedure and LEG wording only | R-01: signer integration, release-record v3, verifier, key-set format, tests | R-01, plus a provider client, token verification and long-term validation |
| **Suitability: first Founding Assessment** | **Suitable**, if internal-use only, single engagement, conditions A-1…A-5 met and accepted (PENDING) | Suitable; preferable if the customer wants third-party reliance | Not necessary for one private engagement |
| **Suitability: future scalable service** | **Not suitable**: relies on Republika's availability and honesty; does not scale; dies at deletion | **Required** minimum | Recommended where reports are shown to third parties or retained longer than a key's lifetime |

## 5. Recommendation (PROPOSED)

1. **Minimum defensible approach for the first Founding Assessment: Option A
   with measures A-1…A-5**, under these conditions: a single, private,
   internal-use engagement; no third-party reliance; disclosure in the report,
   draft G and the SOW; the second Republika role (SEC) holds the corroborating
   custody copy and the backup key separately from the store administrator.
2. **B7 can remain an explicitly accepted limitation for that private pilot**,
   but only after:
   - the independent security reviewer (R1) states in their report that
     Option A's conditions are adequate for that use, or names what is missing;
   - SEC and FDR accept SR-03 and SR-04 in writing (M2);
   - LEG approves the disclosure wording and the A-2 letter.

   Until all three exist, B7 is **not accepted**.
3. **Option B (R-01) is a prerequisite for any second engagement**, any
   engagement with third-party reliance, and any public description of the
   report as verifiable without Republika.
4. **Option C** is re-evaluated when Option B is designed: C-1 first (cheapest,
   addresses revocation), and C-2 only with LEG and customer agreement on
   publication.

**Invalidating conditions** for an accepted Option A (any one voids the
acceptance): the customer intends third-party reliance; a second concurrent
engagement; any custody integrity alarm, `RELEASE_MISMATCH` or unexplained
`RELEASE_NOT_IN_CUSTODY`; suspected compromise of store administration, a
reviewer credential or the backup key; SEC and OPS held by the same person;
or the independent reviewer withdraws or qualifies their opinion.
