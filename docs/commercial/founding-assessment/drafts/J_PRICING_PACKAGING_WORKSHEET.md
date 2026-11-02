# [DRAFT J] Pricing and Packaging Decision Worksheet

> **DRAFT — NO PRICE IS APPROVED.** This is a cost model with scenario
> assumptions for founder decision D-06. Every number is an **input to
> replace** or an illustrative output computed from those inputs. Tax
> treatment, invoicing entity and payment terms need professional advice.

## 1. Cost model

Fully loaded cost of one engagement:

```text
C = (Σ role_days × day_rate) × (1 + contingency)
    + infrastructure + legal_and_insurance_allocation + tooling_allocation
```

Price for a target gross margin `m`, before any founding discount `d`:

```text
P = C / (1 − m)          Founding price = P × (1 − d)
```

## 2. Effort inputs (from the service specification §13; unvalidated)

| Role | Low (days) | Base (days) | High (days) | Driver |
| --- | --- | --- | --- | --- |
| Assessment preparer (scoping, SOW, setup, draft) | 2 | 3 | 5 | Scope complexity |
| Evidence collector | 1 | 2 | 4 | Evidence volume and quality |
| Reviewer (10 controls) | 3 | 4.5 | 6 | Sample size, contradictions |
| Release approver | 1 | 1.5 | 2 | Report length |
| Custody administrator (Host, credentials, backups, closeout) | 1 | 1.5 | 2 | One dedicated Host per customer |
| **Total** | **8** | **12.5** | **19** | |

Contradiction handling adds about **+1–5 days** of elapsed time per
contradicted control. Effort impact: [to measure].

## 3. Other inputs (replace)

| Input | Placeholder | Notes |
| --- | --- | --- |
| Blended day rate | `R` | Founder to set |
| Contingency | 20 % | First engagements carry high variance |
| Infrastructure per engagement (dedicated Host, encrypted storage, backups, through retention) | `I` | Includes retention-period hosting |
| Legal and insurance allocation | `L` | Professional indemnity is not yet assessed |
| Tooling allocation (password manager, transfer, repository) | `T` | |
| Target gross margin | `m` | |
| Founding discount | `d` | In exchange for feedback, case-study rights *only if agreed in writing* |

## 4. Illustrative scenarios (formula outputs, not prices)

Computed with the illustrative values `R = 1.0` (one unit of day rate),
`I + L + T = 3.0` units, and 20 % contingency. Multiply by the real day rate.

| Scenario | Days | Labour × 1.2 | + fixed | Cost `C` (units) | `P` at m = 40 % | `P` at m = 60 % |
| --- | --- | --- | --- | --- | --- | --- |
| Low | 8 | 9.6 | 3.0 | 12.6 | 21.0 | 31.5 |
| Base | 12.5 | 15.0 | 3.0 | 18.0 | 30.0 | 45.0 |
| High | 19 | 22.8 | 3.0 | 25.8 | 43.0 | 64.5 |

## 5. Packaging options (decide)

| Option | Description | Risk |
| --- | --- | --- |
| Fixed fee, capped scope | One price per tier (for example up to N systems, M samples) | Over-run on hard scopes |
| Fixed fee + evidence-gap clause | Time extension or extra fee beyond N contradiction restarts | More contract complexity |
| Time and materials, capped | Day rate with a cap | Less predictable for the buyer |
| Founding unpaid pilot | No fee; feedback agreement | Allowed only under D-01(b); still needs G-INFO, G-LEGAL, G-OPS |

Add-ons to decide: reassessment within N months (D-07); executive readout;
extended retention.

## 6. Decision record

| Field | Value |
| --- | --- |
| Chosen model | [ ] |
| Price or day rate | [ ] |
| Founding discount and conditions | [ ] |
| Reassessment terms | [ ] |
| Approved by (FDR) / date | [ ] |
| Tax and invoicing reviewed by | [ ] |
