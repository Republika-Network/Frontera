# Commercial Authorization Procedure (ASSURE-GOV-01)

> **FINAL COMMERCIAL DECISION: NO-GO.** **STATUS: DRAFT — PROPOSED
> procedure.** It refines `../ASSURE_COMMERCIAL_GO_NO_GO.md` §3–§4, which
> remains the gate. It does not replace it. Adopting this procedure is itself a
> decision for FDR + GOV (PENDING). Labels: VERIFIED · PROPOSED · PENDING ·
> BLOCKED.

## 1. Non-negotiable rules

1. **No AI agent, merged PR, passing test, CI run, script or automation grants
   any approval, acceptance, review or authorization.** An AI agent may prepare
   documents. It cannot be a reviewer, a risk owner, an approver or a signatory.
2. A PR author cannot approve their own PR's governance content. Merging a PR
   records documents; it does not approve them.
3. An instruction to prepare, draft or analyse is not an approval of the
   result.
4. Technical closure (L1) never implies independent validation (L2), risk
   acceptance (L3), framework authorization (L4), legal or operational approval
   (L5), or commercial authorization (L6).
5. Every approval is a **written, dated, attributable record** (§4) by a named
   person holding the role, stored outside the repository, and **cited** by ID
   and digest in a reviewed PR.
6. One person may hold more than one role only where this procedure allows
   it. SEC and OPS must be different people (SR-04). The reviewer and the
   approver of an assessment must be different people (B3).

## 2. Stages

| Stage | Layer | Output | Responsible | Approver | Prerequisite | Status |
| --- | --- | --- | --- | --- | --- | --- |
| S0 | — | Role holders named for FDR, SEC, OPS, GOV, LEG (counsel engaged), ENG | FDR | FDR (record) | — | BLOCKED |
| S1 | L1 Technical | Evidence index re-run at the commit to be authorized | ENG | — (evidence only) | — | VERIFIED at `2e32eb15` (this mission) |
| S2 | L2 Independent validation | R1 report (protocol §11) | Independent reviewer | Received by FDR | D-02; S0 | BLOCKED |
| S3 | L4 (part 1) | D-01.1; R-06a freeze of `rn.sv@0.2.0` (not opted in) | GOV / ENG | GOV + FDR | S2 methodology part | PENDING |
| S4 | L2 confirmation | R1 confirmation on the frozen digest | Independent reviewer | Received by FDR | S3 | BLOCKED |
| S5 | L3 Risk acceptance | M2: accepted register entries with conditions and expiry | SEC | SEC + FDR | S2, S4 | PENDING |
| S6 | L4 (part 2) | M1: framework authorization record binding the exact digest (§4) | GOV | GOV + FDR | S5 | PENDING |
| S7 | L1 (code) | R-06b: opt-in, release gate, generator v3, verifier | ENG | Code review (not an approval of use) | S6 | PENDING |
| S8 | L5 Legal | M3 (data governance, D-04, D-05), M4 (drafts B, D, E, G, H, I; claims review) | LEG | LEG (+ FDR for M3) | S0 | BLOCKED |
| S9 | L5 Operational | M5: operators named, credential register, engagement Host with E13 PASS, restore drill witnessed | OPS | FDR + SEC + OPS | D-08; S0 | BLOCKED |
| S10 | Customer | M6: pricing (D-06), signed SOW, authorization to assess (draft E) | FDR | FDR | S8 | BLOCKED |
| S11 | L6 Final | The dedicated GO line in the format defined in `../ASSURE_COMMERCIAL_GO_NO_GO.md` §4, scoped to one framework version and one customer | FDR | FDR **and** a second role holder | S1–S10 all complete | **NO-GO** |

Per release within an authorized engagement: R2 (if D-02 requires it), then
release approval in the product, then the B7 Option A measures, if accepted.

## 3. What each record must not do

- It must not approve anything not named in it (no "and everything else").
- It must not refer to a document without its digest or commit. A record that
  approves "the risk register" approves the version at that commit only.
- It must not be backdated. The date is the date of signature.

## 4. Approval record format

Stored off-repository (for example a signed PDF or an e-signature envelope).
Its ID and SHA-256 digest are cited in the PR that updates the gate.

```text
Record type:        rn.sv.commercial-authorization.v1 | risk-acceptance.v1 |
                    decision.v1 | legal-signoff.v1 | review-receipt.v1
Record ID:          GOV-<YYYY>-<NNN>
Subject:            exact items decided, each with path + commit, or digest
Framework (if any): frameworkId, frameworkVersion, frameworkDigest
Decision:           approve | approve with conditions | reject | defer
Accepted residuals: register IDs (SR-xx) and their conditions
Permitted use:      e.g. "one private founding engagement, internal-use report"
Conditions:         numbered, each verifiable
Expiry:             date or event
Invalidating events: as in the register, plus any listed here
Independent review: R1 / R2 report references relied on
Decision maker(s):  full name, role, authority basis
Second approver:    full name, role (where required)
Signature method:   wet / qualified or advanced e-signature / other (stated)
Date:               YYYY-MM-DD
```

For an authorization record, the status field (`AUTHORIZED_CONDITIONAL`,
`SUSPENDED`, `REVOKED`, `EXPIRED`) changes only by a new record of type
`decision.v1` that references it. Records are never edited.

## 5. Suspension and revocation

| Trigger | Who may act | Action |
| --- | --- | --- |
| Any invalidating condition in the risk register | SEC or GOV alone (suspension only) | `SUSPENDED` immediately; FDR informed the same day |
| Reviewer withdraws or qualifies the R1/R2 opinion | GOV | `SUSPENDED` pending FDR decision |
| Methodology defect or false customer-facing claim | GOV + FDR | `REVOKED`; customer notification (strategy §6) |
| Expiry without R3 | — (automatic by date, recorded by GOV) | `EXPIRED` |
| Reinstatement | GOV + FDR, with SEC for security triggers | New `AUTHORIZED_CONDITIONAL` record |

Suspension is deliberately easy, and reinstatement deliberately hard.

## 6. Updating the gate

A PR updates `../ASSURE_COMMERCIAL_GO_NO_GO.md`:

1. changes only the statuses that a cited record supports;
2. cites each record by ID and digest;
3. is approved on GitHub by FDR **and** a second role holder, neither of whom is
   the PR author;
4. never changes the final line to GO unless S1–S10 are all cited.
