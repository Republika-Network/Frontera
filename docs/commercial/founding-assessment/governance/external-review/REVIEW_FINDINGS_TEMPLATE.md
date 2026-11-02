# R1 Review Findings and Conclusion — BLANK TEMPLATE

> **FINAL COMMERCIAL DECISION: NO-GO.** **STATUS: DRAFT TEMPLATE — every
> reviewer field is intentionally blank.** No finding, opinion or conclusion
> exists. Sections 1–8 are completed **by the reviewer only**. Section 9
> defines how engineering tracks findings **without editing the reviewer's
> text**. Structure follows [`../INDEPENDENT_REVIEW_PROTOCOL.md`](../INDEPENDENT_REVIEW_PROTOCOL.md) §11.

## 1. Reviewer identity and engagement

```text
Reviewer (name):                    ______________________________
Independence declaration reference + SHA-256:  ______________________
Engagement letter reference:        ______________________________
Review stage:                       R1 / R2 / R3
Review period (from – to):          ______________ – ______________
Pinned commit reviewed:             ______________________________
Framework digest(s) reviewed:       ______________________________
Candidate document(s) reviewed:     ______________________________
Fixed fee confirmed (yes/no):       ____
```

## 2. Evidence reviewed

| # | Item (file, document, interview) | Version / commit / date | Reviewed in full / sampled / not reviewed |
| --- | --- | --- | --- |
| | | | |

**Limitations of scope** (what the reviewer was unable or chose not to
examine, and why): `______________________________`

## 3. Tests independently executed

```text
Machine / OS:            ______________________________
Node version:            ______________________________
Clean clone (yes/no):    ____     npm ci (yes/no): ____
```

| # | Command (exact) | Expected (from REPRODUCTION_GUIDE) | Observed | Match? | Notes |
| --- | --- | --- | --- | --- | --- |
| | | | | | |

Reproduction failures and their explanation: `______________________________`

## 4. Methodology findings

One block per finding. IDs are the reviewer's (suggested `M-01`, `M-02`, …).

```text
ID:                  ____
Classification:      Major nonconformity / Minor nonconformity / Observation
Control(s) / area:   ____ (e.g. SV-06; scoring; disclosure)
Finding:             ______________________________
Evidence (file:line, test, command output):  ______________________
Why it matters:      ______________________________
Recommendation:      ______________________________
How closure would be verified:  ______________________________
```

## 5. Security findings

Severity per protocol §9 (Critical / High / Medium / Low-Informational).
Suggested IDs `S-01`, `S-02`, ….

```text
ID:                  ____
Severity:            Critical / High / Medium / Low / Informational
Area:                ____ (e.g. B3 credentials; A10 custody; backups)
Finding:             ______________________________
Evidence:            ______________________________
Related register entry (SR-xx), if any:  ____
Recommendation:      ______________________________
How closure would be verified:  ______________________________
```

## 6. Nonconformity summary

| ID | Type (Major / Minor / Critical / High / Medium / Low) | Area | One-line summary | Remediation required before first engagement? (reviewer's view) |
| --- | --- | --- | --- | --- |
| | | | | |

## 7. Risk-acceptance recommendations

For each residual the reviewer considers acceptable **with conditions** for
one private, internal-use pilot. The reviewer recommends; the risk approver
decides (protocol §9).

| Residual (SR-xx / B-x / A10) | Reviewer's view: acceptable / acceptable with conditions / not acceptable | Conditions | Expiry or trigger the reviewer recommends |
| --- | --- | --- | --- |
| | | | |

## 8. Written review conclusion

### 8.1 Focus question

> *Are the ten controls, their evidence requirements, scoring and limitations
> sufficiently coherent and defensible for the proposed Founding Assessment
> service?*

```text
Answer:    ______________________________
Reasons:   ______________________________
```

### 8.2 Opinion per area (protocol §11.6)

One of: **No objection** · **No objection with conditions** (list) ·
**Objection** (reasons).

| Area | Opinion | Conditions / reasons |
| --- | --- | --- |
| Security residuals for a private pilot | | |
| B7 Option A adequacy | | |
| Methodology of the ten controls and scoring | | |
| Customer-facing claims (methodology view) | | |
| Readiness of the candidate `rn.sv@0.2.0` delta | | |

### 8.3 `rn.sv@0.2.0` questions ([`REVIEWER_BRIEFING.md`](REVIEWER_BRIEFING.md) §6)

| Should `rn.sv@0.2.0`… | Reviewer's answer (yes / no / conditional) | Reasons |
| --- | --- | --- |
| keep the same control methodology? | | |
| change specific controls? (which) | | |
| change scoring or weights? (how) | | |
| add disclosure requirements? (which) | | |
| require signed releases? | | |
| require enhanced reviewer authentication? | | |

### 8.4 What was not examined

`______________________________`

### 8.5 Follow-up review requirements

```text
Findings requiring remediation verification (IDs):  __________________
Proposed verification method for each:              __________________
Events that should trigger R3 re-review:            __________________
Latest date for R3 if no trigger occurs:            __________________
```

### 8.6 Dated reviewer signature

```text
I performed the work described above and the statements in this report are my
own professional opinion.

Reviewer: ____________________________   Signature: ____________________
Date: ______________   Place: ______________
```

## 9. Engineering tracking of findings (Republika-maintained; separate from §1–§8)

**Rule: the reviewer's report is immutable.** Republika never edits,
re-words, re-numbers, re-classifies or summarizes the reviewer's findings in a
way that changes their meaning.

1. **Original custody.** The signed report (PDF or equivalent) is stored
   off-repo by FDR. The repository records only:
   `Report reference: ____  SHA-256: ____  Received by FDR on: ____`.
   Any later copy is verified against this digest.
2. **Tracking table.** Engineering tracks in a **separate** file (proposed:
   `REVIEW_FINDINGS_TRACKER.md`, created only after a report exists), one row
   per reviewer finding, keyed by the reviewer's own ID and quoting the
   reviewer's one-line summary verbatim, in quotation marks:

   | Reviewer ID | Reviewer's summary (verbatim) | Reviewer severity (verbatim) | Register entry | Treatment (decided by risk approver) | Owner | Remediation PR | Reviewer verification (date, reference) | Status |
   | --- | --- | --- | --- | --- | --- | --- | --- | --- |

3. **Disagreement.** If Republika disagrees with a finding, it records its
   response in its own column or a separate response letter. It never changes
   the finding. The reviewer may reply; the reply is appended, not merged.
4. **Closure.** A finding is *closed* only when the reviewer (or a successor
   reviewer under the same independence criteria) records that remediation is
   verified. Engineering may mark it *remediation submitted*, never *closed*.
5. **Risk acceptance.** A finding treated by acceptance cites the approval
   record (`../COMMERCIAL_AUTHORIZATION_PROCEDURE.md` §4) and the register
   entry. The reviewer's original severity stays visible next to it.
6. **Supersession.** A later review (R3) is a new report with its own digest;
   it does not overwrite the earlier one.

**FINAL COMMERCIAL DECISION: NO-GO.**
