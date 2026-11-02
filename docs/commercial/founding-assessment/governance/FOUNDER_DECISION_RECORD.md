# Founder Decision Record — Commercial Governance (ASSURE-GOV-01)

> **FINAL COMMERCIAL DECISION: NO-GO.** **STATUS: DRAFT — every decision is
> PENDING.** No decision below has been made. The founder's instruction to
> *prepare* this work is **not** a decision on any item and **not** an approval
> to launch. A decision exists only when its "Decision" block is completed by
> the named decision maker and recorded under
> [`COMMERCIAL_AUTHORIZATION_PROCEDURE.md`](COMMERCIAL_AUTHORIZATION_PROCEDURE.md) §4.
> Labels: VERIFIED · PROPOSED · PENDING · BLOCKED.

Decisions D-06 (pricing), D-07 (reassessment terms) and D-09 (entity,
jurisdiction, insurance) remain as defined in
`../COMMERCIAL_READINESS_ASSESSMENT.md` §9 and are not re-analysed here.

---

## D-01 — Create and authorize a successor framework version

**Question.** How will commercial use of `rn.sv` be authorized, if at all?

| Option | Tradeoffs |
| --- | --- |
| **(a) Create `rn.sv@0.2.0` as specified in the candidate, then authorize it by a separate authorization record (recommended)** | + Reports state accurate governance; + history untouched; + suspension possible without editing frozen bytes. − Requires the R-06 code mission (GF-07); − needs R1 first |
| (b) Keep `0.1.0`; record an off-framework authorization | + No code. − Reports keep saying "restricted" next to an authorized release; contradictory for customers. Acceptable only for an **unpaid**, explicit pilot |
| (c) Do not authorize yet | + No risk taken. − No revenue or founding evidence; the gate stays NO-GO |
| (d) Edit `0.1.0` to lift the restriction | **Rejected**: breaks the golden digest and every historical report bound to it; rewrites history |

**Recommendation (PROPOSED).** (a), in two steps: D-01.1 authorizes **creating**
the candidate (R-06a, after R1 methodology review); D-01.2, later, authorizes
**commercial use** of the exact frozen digest (M1). Approving D-01.1 does not
approve D-01.2.

**Prerequisites.** R1 methodology review (BLOCKED: no reviewer).

**Decision makers.** GOV + FDR.

```text
Decision: ____________   Decided by: ____________ (name, role)   Date: ________
Record ID: ____________  Conditions: ____________
```

**Status: PENDING**

---

## D-02 — Independent review requirements

**Question.** Who performs the "controlled external review" the restriction
requires, and when?

| Option | Tradeoffs |
| --- | --- |
| **(a) A named external reviewer per [`INDEPENDENT_REVIEW_PROTOCOL.md`](INDEPENDENT_REVIEW_PROTOCOL.md): R1 once, R2 for each release of at least the first engagement (recommended)** | + Matches the restriction's wording; + makes the independence statement truthful. − Cost and lead time (fixed-fee reviewer: price not known); − customer evidence access must be consented |
| (b) The internal release approver acts as the controlled review | + No cost. − It is internal and not external; − it is what the report generator already says (GF-01), which would then be true only by definition; − weak for any third party |
| (c) R1 only; no per-release R2 | + Cheaper. − No external check of any actual conclusion |
| (d) Defer until R-01 signing | − Confuses authenticity (B7) with review independence: signing does not review anything |

**Recommendation (PROPOSED).** (a). If (b) is chosen, record that choice
explicitly, so that the existing report wording becomes a stated policy and
not an engineering default, and remove "independent" from all customer
wording (GF-06).

**Decision makers.** FDR + GOV.

```text
Decision: ____________   Decided by: ____________   Date: ________
Reviewer engaged (name, date of engagement letter): ____________
Record ID: ____________
```

**Status: PENDING** — BLOCKED for implementation until a reviewer exists.

---

## D-03 — Disposition of B7, A10 and credential risk

**Question.** Are the security residuals acceptable for one private founding
pilot, and under what conditions?

| Option | Tradeoffs |
| --- | --- |
| **(a) Accept SR-02, SR-03 and SR-04 for one private, internal-use engagement, with B7 Option A measures A-1…A-5 and the SR-02 conditions, after R1 concurrence (recommended)** | + Allows a first engagement without new code. − Residuals remain; acceptance expires at engagement close |
| (b) Require R-01 (signing) and R-03 (passkey approval, rate limiting) first | + Stronger; scalable. − Two more code missions before any engagement |
| (c) Require R-01 only | + Closes B7 offline. − Leaves credential residual |
| (d) Accept without R1 concurrence | **Not recommended**: no independent view of the residuals |

**Recommendation (PROPOSED).** (a) for the first engagement only; (b) before
any second engagement or any third-party reliance.

**Decision makers.** SEC + FDR (M2); LEG for B7 disclosure wording.

```text
Decision: ____________   Decided by: ____________   Date: ________
Accepted register entries and conditions: ____________
Expiry: ____________     Record ID: ____________
```

**Status: PENDING**

---

## D-04 — Customer retention periods

**Question.** How long are records kept, and what happens at the end?

Proposed values are in `../CUSTOMER_DATA_GOVERNANCE.md` §10 (artifacts ≤ 30
days after acceptance if held; store and backups engagement + 3 years; operator
logs 1 year). Enforcement tooling exists (OPS-02 lifecycle and gated
offboarding); the tool requires a policy reference and enforces no period.

| Option | Tradeoffs |
| --- | --- |
| **(a) Approve the proposed values subject to counsel's advice on limitation periods and the customer's jurisdiction (recommended)** | + Lets verification against custody work for a defined period. − Longer retention means longer exposure |
| (b) Shorter store retention (for example 1 year) | + Less exposure. − Republika cannot confirm the package after deletion (B7 makes this sharper under Option A) |
| (c) Customer-chosen period per SOW | + Flexible. − Operational variance; each needs LEG |

**Interaction with D-03.** Under Option A, deletion ends the customer's only
means of proving authenticity. The A-2 letter mitigates this; Option B removes
it.

**Decision makers.** LEG + FDR (M3).

```text
Decision: ____________   Decided by: ____________   Date: ________   Record ID: ____________
```

**Status: PENDING**

---

## D-05 — Evidence custody model, subprocessors and cross-border handling

| Sub-question | Options | Recommendation (PROPOSED) |
| --- | --- | --- |
| Evidence artifacts | **(a) Stay with the customer; reviewer inspects in a customer-controlled session; Host records references and digests only (recommended)** / (b) per-engagement encrypted repository under `<root>/intake/` (OPS-02 procedure) | (a). (b) only where the customer cannot host a session, with the intake procedure and destruction with the root |
| Host location | Republika-controlled machine / customer-region cloud VM / customer premises | Decided per engagement with LEG, matching the customer's residency requirements |
| Subprocessors | Inventory to complete: hosting provider, password manager, delivery channel, e-signature (A-2), the independent reviewer (R2 access), any AI tooling used by operators | Approve a closed list before the engagement. Rule: no customer evidence or report content in tools outside the list |
| Cross-border | No position taken in this repository | LEG determines transfer mechanisms per engagement |

**Decision makers.** LEG + FDR (M3), OPS for the Host.

```text
Decision: ____________   Subprocessor list (reference): ____________
Decided by: ____________   Date: ________   Record ID: ____________
```

**Status: PENDING**

---

## D-08 — Single-customer Host isolation model

| Option | Tradeoffs |
| --- | --- |
| **(a) One dedicated Host and engagement root per customer engagement, on its own encrypted volume, destroyed at disposition (recommended)** | + Deletion is possible (store is append-only); + no cross-customer data path; + matches OPS-02 tooling and tests. − Per-engagement setup cost |
| (b) One Host per customer across its engagements | + Reassessments share custody. − Retention of one engagement extends to all; deletion only at the end of the relationship |
| (c) Shared Host for several customers | **Not supported**: a Host serves exactly one organization (REL-01D §2); deletion impossible per customer |

**Recommendation (PROPOSED).** (a). It is also a condition of B4's residual
and of SR-06.

**Decision makers.** FDR + OPS, with SEC.

```text
Decision: ____________   Decided by: ____________   Date: ________   Record ID: ____________
```

**Status: PENDING**

---

## Decision dependency summary

| Decision | Depends on | Unblocks |
| --- | --- | --- |
| D-02 | — | R1, then D-01.1 and D-03 |
| D-01.1 | R1 methodology | R-06a (freeze candidate) |
| D-03 | R1 security | M2, G-TECH |
| D-04, D-05 | LEG engaged | M3, G-INFO |
| D-08 | — | Engagement Host provisioning, SR-06, G-OPS |
| D-01.2 | R-06a, R1 confirmation, M2 | M1, R-06b, G-FRAMEWORK |
