# Security and Commercial Risk Register — Founding Assessment (ASSURE-GOV-01)

> **FINAL COMMERCIAL DECISION: NO-GO.** **STATUS: DRAFT.** Every
> recommendation below is **PROPOSED**. **Every acceptance is PENDING** until a
> named, authorized human records it under
> [`COMMERCIAL_AUTHORIZATION_PROCEDURE.md`](COMMERCIAL_AUTHORIZATION_PROCEDURE.md) §4.
> No role (FDR, SEC, OPS, GOV, LEG, ENG) has a person assigned. Labels:
> VERIFIED · PROPOSED · PENDING · BLOCKED.

This register supersedes nothing. It extends `../COMMERCIAL_READINESS_ASSESSMENT.md`
§7 (RR-1…RR-12), whose IDs are cross-referenced.

## Scale (assumptions, to be confirmed by SEC)

- **Likelihood** for one private founding engagement on a dedicated Host: Low
  (not expected in the engagement), Medium (plausible), High (expected unless
  treated).
- **Impact**: Low (internal inconvenience), Medium (customer harm, correctable),
  High (customer or third-party reliance on a false statement, disclosure of
  customer data, or legal exposure).
- **Residual severity** = the higher of likelihood and impact after the
  proposed mitigation, adjusted by SEC judgement.

## Summary

| ID | Risk | Residual | Recommendation | Owner | Approver | Status |
| --- | --- | --- | --- | --- | --- | --- |
| SR-01 | B1 manual evidence authenticity | Medium | Accept (disclosed) | GOV | GOV + FDR | PENDING |
| SR-02 | B3 static bearer credentials; credential ≠ person | Medium | Accept with conditions for pilot; R-03 before scale | SEC | SEC + FDR | PENDING |
| SR-03 | B7 no external signatures | Medium | Accept for one internal-use pilot (Option A); R-01 before any other engagement | SEC | SEC + FDR + LEG | PENDING |
| SR-04 | A10 issuer-controlled custody manipulation | Medium | Mitigate (A-3 separation); accept residual | SEC | SEC + FDR | PENDING |
| SR-05 | Independent reviewer assurance limitations | Medium | Mitigate (protocol); accept limits, disclosed | GOV | GOV + FDR | PENDING |
| SR-06 | Customer data storage and encryption preflight | High → Medium | Mitigate (E13 PASS mandatory, witnessed) | OPS | OPS + SEC + LEG | PENDING |
| SR-07 | Credential and key compromise | Medium | Mitigate | SEC | SEC + FDR | PENDING |
| SR-08 | Customer report disclosure | Medium | Mitigate | OPS | OPS + LEG | PENDING |
| SR-09 | Backup and recovery | Medium | Mitigate (backup per release, real drill) | OPS | OPS + SEC | PENDING |
| SR-10 | Unsupported customer claims about certification | Medium | Mitigate (contract + permitted description) | LEG | LEG + FDR | PENDING |
| SR-11 | Scope limitations of the ten controls | Medium | Accept (disclosed) | GOV | GOV + FDR | PENDING |
| SR-12 | Provider-performed review (self-review threat) | Medium | Mitigate (R2 for first engagement) + disclose | GOV | GOV + FDR + LEG | PENDING |
| SR-13 | Overstated Republika claims in delivered artefacts | High → Low | Mitigate before any delivery | LEG | LEG + FDR | PENDING |
| SR-14 | Governance-record ambiguity | Medium → Low | Mitigate | GOV | GOV + FDR | PENDING |

## Entries

Each entry: **Threat** · **Likelihood / impact (assumptions)** · **Existing
mitigation** · **Evidence** · **Proposed additional mitigation** · **Residual** ·
**Recommendation** · **Owner** · **Approver** · **Review / expiry** ·
**Invalidates a prior acceptance** · **Status**.

### SR-01 — Manual evidence authenticity (B1; RR-9)

| Field | Content |
| --- | --- |
| Threat | Customer supplies forged, stale, cherry-picked or irrelevant evidence; reviewer concludes PASS on it |
| Likelihood / impact | Medium / High (a third party shown the report could rely on a false PASS) |
| Existing mitigation | `verified: false` for all manual evidence; supplier claims kept apart; evidence bound to controls; UNKNOWN for gaps; disclosure in report and draft G §6 |
| Evidence | SEC-01C, SEC-01A suites (45/45 this run); `B1_B9_BLOCKER_DISPOSITION.md` |
| Proposed additional mitigation | Customer evidence attestation (draft E) signed by an accountable executive; R2 sampled re-performance; reviewer corroboration where the format allows (for example a witnessed SV-08 test, as its requirement states); internal-use restriction |
| Residual | Medium |
| Recommendation | **Accept**, disclosed as "reviewed-evidence, not verified-evidence" |
| Owner / approver | GOV / GOV + FDR |
| Review / expiry | Before first engagement; then at each R3 or 12 months |
| Invalidates acceptance | Third-party reliance intended; evidence types beyond the two accepted; discovery of forged evidence in any engagement |
| Status | **PENDING** |

### SR-02 — Static bearer credentials; credential ≠ person (B3; RR-3, RR-4)

| Field | Content |
| --- | --- |
| Threat | A leaked secret lets anyone review or release as that operator; one person holding a reviewer and an approver credential defeats separation of duties |
| Likelihood / impact | Low–Medium / High |
| Existing mitigation | Credential-bound identity and roles; reviewer-only mode; constant-time comparison; duplicate-secret refusal; safe reviewer IDs; preflight E11 (no dual-role credential) and E12 (no reuse with a ledger); private-network operation (REL-01D §9) |
| Evidence | SEC-01B, REL-01D, OPS-01 reviewer privacy suites (this run); OPS-02 preflight |
| Proposed additional mitigation | Named holder per credential in an adopted register (`../OPERATOR_ROLES.md` §4); each holder's written attestation of single-person custody; R2 checks the register per release; loopback/SSH-tunnel only; rotation at engagement end. Before scale: R-03 (passkey-bound approval, rate limiting) |
| Residual | Medium |
| Recommendation | **Accept with these conditions** for one private pilot; **mitigate (R-03)** before a second engagement |
| Owner / approver | SEC / SEC + FDR (M2) |
| Review / expiry | Expires at close of the first engagement, or 6 months after acceptance, whichever is first |
| Invalidates acceptance | Any network exposure beyond loopback/private; fewer than two distinct named people for reviewer and approver; suspected secret exposure; register not maintained |
| Status | **PENDING** — note GF-03: REL-01D §10's "Accepted" is not an acceptance |

### SR-03 — No external signatures (B7; RR-2)

| Field | Content |
| --- | --- |
| Threat | Forged or altered package passes offline; customer cannot prove origin to third parties; nothing provable after deletion |
| Likelihood / impact | Low / High for a single internal-use pilot |
| Existing mitigation | Custody, authoritative verification, offline integrity verifier, explicit `NOT DEMONSTRATED` |
| Evidence | PILOT-01 F01 offline test; independent verifier verdict (this run) |
| Proposed additional mitigation | Option A measures A-1…A-5 (`B7_AUTHENTICITY_OPTIONS.md` §3) |
| Residual | Medium |
| Recommendation | **Accept for one private, internal-use pilot**, after R1 concurrence; **mitigate (Option B, R-01)** before any other engagement |
| Owner / approver | SEC / SEC + FDR + LEG |
| Review / expiry | Expires at close of the first engagement |
| Invalidates acceptance | As listed in `B7_AUTHENTICITY_OPTIONS.md` §5 |
| Status | **PENDING** |

### SR-04 — Issuer-controlled custody manipulation (A10; RR-2)

| Field | Content |
| --- | --- |
| Threat | Store administrator (or an attacker with OS access) rewrites a custody row and every digest; verification then confirms the forgery |
| Likelihood / impact | Low / High |
| Existing mitigation | Append-only triggers; corrupted-row detection; Host file access limited to custody administrator (procedural) |
| Evidence | REL-01A `A10 KNOWN LIMITATION` test (reproduced this run) |
| Proposed additional mitigation | A-3: sealed post-release backup held off-host by SEC, with the key separated from OPS; periodic comparison; customer-held A-2 letter quoting `releaseDigest` |
| Residual | Medium (collusion of SEC and OPS remains) |
| Recommendation | **Mitigate**, then accept the collusion residual |
| Owner / approver | SEC / SEC + FDR |
| Review / expiry | With SR-03 |
| Invalidates acceptance | SEC and OPS held by the same person; any custody integrity alarm; loss of the SEC-held copy |
| Status | **PENDING** |

### SR-05 — Independent reviewer assurance limitations

| Field | Content |
| --- | --- |
| Threat | The review is presented or understood as more than it is (an attestation, an audit); reviewer's sample misses a defect; reviewer not truly independent |
| Likelihood / impact | Medium / Medium |
| Existing mitigation | None (no reviewer exists) |
| Evidence | `INDEPENDENT_REVIEW_PROTOCOL.md` (PROPOSED) |
| Proposed additional mitigation | Independence criteria and signed disclosure; fixed fee; reviewer's own reproduction; report states what was not examined; customer wording limits the claim |
| Residual | Medium |
| Recommendation | **Mitigate** via the protocol; **accept** the inherent sampling limit, disclosed |
| Owner / approver | GOV / GOV + FDR |
| Review / expiry | At each R3 |
| Invalidates acceptance | Undisclosed conflict discovered; reviewer withdraws or qualifies opinion; scope reduced after the fact |
| Status | **PENDING** — BLOCKED until a reviewer is engaged |

### SR-06 — Customer data storage and encryption preflight (RR-6, RR-7)

| Field | Content |
| --- | --- |
| Threat | Store, exports, intake or temp files on an unencrypted volume; preflight skipped; evidence artifacts mishandled |
| Likelihood / impact | Medium / High |
| Existing mitigation | OPS-02 preflight E13 detects encryption (BitLocker, dm-crypt, FileVault), fails on NOT_ENCRYPTED; sealed backups; references-only storage; intake procedure |
| Evidence | OPS-02 suite (this run). **The development machine reports NOT_ENCRYPTED; no engagement Host exists** (OPS-02 §4) |
| Proposed additional mitigation | E13 PASS (not attestation) recorded and witnessed by SEC before any evidence is received; `--require-encryption`; artifacts stay with the customer (D-05 option a) |
| Residual | Medium (detection, not enforcement, by the Host) |
| Recommendation | **Mitigate** |
| Owner / approver | OPS / OPS + SEC + LEG |
| Review / expiry | Before each engagement |
| Invalidates acceptance | Host started without a recorded E13 PASS; any evidence file outside the documented intake; change of Host machine |
| Status | **PENDING** — BLOCKED until an engagement Host exists |

### SR-07 — Credential and key compromise

| Field | Content |
| --- | --- |
| Threat | Exposure of a reviewer/approver secret, the engagement backup key, the volume recovery key, or (future) a signing key |
| Likelihood / impact | Low–Medium / High |
| Existing mitigation | Secrets by env reference only; no inline secrets; key per engagement; ENC-03 scan finds no keys in logs or packages (OPS-02 §5) |
| Evidence | OPS-02 suite; REL-01D leakage tests (this run) |
| Proposed additional mitigation | Approved password manager; one holder per secret; documented rotation and revocation; incident procedure adopted (runbook §16); backup key never stored beside backups; for Option B, key ceremony and revocation list |
| Residual | Medium |
| Recommendation | **Mitigate** |
| Owner / approver | SEC / SEC + FDR |
| Review / expiry | Every engagement; on any suspicion |
| Invalidates acceptance | Any secret found in chat, email, ticket or repository; holder change without rotation |
| Status | **PENDING** |

### SR-08 — Customer report disclosure

| Field | Content |
| --- | --- |
| Threat | Report or `export.json` (full report, base64) reaches the wrong person; delivery over an unencrypted channel; operator AI tools ingest report content |
| Likelihood / impact | Low–Medium / High |
| Existing mitigation | Deny-by-default report disclosure; no public route; `no-store`; logs without content |
| Evidence | REP-01, REL-01D leakage tests (this run); OPS-01 §13 residual on `export.json` |
| Proposed additional mitigation | Delivery only to the named contact over an agreed encrypted channel; `export.json` deleted after materialization (checklist item); no customer content in unapproved third-party or AI tools (`../CUSTOMER_DATA_GOVERNANCE.md` §14) |
| Residual | Medium |
| Recommendation | **Mitigate** |
| Owner / approver | OPS / OPS + LEG |
| Review / expiry | Each engagement |
| Invalidates acceptance | Delivery outside the agreed channel; subprocessor list not approved (D-05) |
| Status | **PENDING** |

### SR-09 — Backup and recovery (RR-8)

| Field | Content |
| --- | --- |
| Threat | Restore to an older backup loses later releases, which become re-releasable; backup key co-located; no drill on the real Host |
| Likelihood / impact | Low / Medium |
| Existing mitigation | Sealed engagement-bound backup; verify-by-restore; cross-customer restore refused; restore preserves custody and exports byte-identically (synthetic) |
| Evidence | OPS-02 suite (this run) |
| Proposed additional mitigation | Cold backup immediately after every release (also A-3); restore drill on the real engagement Host witnessed by SEC; post-restore reconciliation against delivered `releaseDigest`s |
| Residual | Low–Medium |
| Recommendation | **Mitigate** |
| Owner / approver | OPS / OPS + SEC |
| Review / expiry | Before first engagement; after each restore |
| Invalidates acceptance | A release without a following backup; a restore without reconciliation |
| Status | **PENDING** — drill BLOCKED until an engagement Host exists |

### SR-10 — Unsupported customer claims about certification (RR-1)

| Field | Content |
| --- | --- |
| Threat | The customer tells third parties it is "certified", "audited" or "sovereignty-compliant" by Republika |
| Likelihood / impact | Medium / High |
| Existing mitigation | Report disclaimers; draft G; SOW exclusions |
| Evidence | `commercial-report.ts` limitations (L406–L408); draft G |
| Proposed additional mitigation | SOW clause: permitted description only (`CUSTOMER_CLAIMS_REVIEW.md` §5); no use of Republika marks without consent; right to publicly correct misrepresentation |
| Residual | Medium |
| Recommendation | **Mitigate** |
| Owner / approver | LEG / LEG + FDR |
| Review / expiry | Each SOW |
| Invalidates acceptance | Evidence of misrepresentation by any customer |
| Status | **PENDING** |

### SR-11 — Scope limitations of the ten controls

| Field | Content |
| --- | --- |
| Threat | The ten controls are read as a complete measure of "digital sovereignty" or of security; areas not covered (for example infrastructure security, supply chain, availability, jurisdictional exposure of providers, model behaviour) are assumed assessed |
| Likelihood / impact | Medium / Medium |
| Existing mitigation | Report scope statement; "not a general trust or security score" limitation; service spec §10 |
| Evidence | `commercial-report.ts:411,416`; `../SERVICE_SPECIFICATION.md` §3, §10 |
| Proposed additional mitigation | An explicit "not covered" list in the report and draft G (methodology reviewer to confirm the list in R1) |
| Residual | Medium |
| Recommendation | **Accept**, disclosed |
| Owner / approver | GOV / GOV + FDR |
| Review / expiry | R1; each framework version |
| Invalidates acceptance | Marketing that describes the result beyond the ten controls |
| Status | **PENDING** |

### SR-12 — Provider-performed review (self-review threat)

| Field | Content |
| --- | --- |
| Threat | Republika authors the framework, builds the tool, performs the review and approves the release; the customer believes the result is independent |
| Likelihood / impact | Medium / Medium |
| Existing mitigation | Separation of duties between reviewer and approver (per credential) |
| Evidence | REL-01D separation-of-duties tests (this run) |
| Proposed additional mitigation | R2 for at least the first engagement; drop "independent" from customer wording (GF-06); disclose the relationship (IND residual in candidate spec §3.2) |
| Residual | Medium |
| Recommendation | **Mitigate and disclose** |
| Owner / approver | GOV / GOV + FDR + LEG |
| Review / expiry | Each engagement |
| Invalidates acceptance | Any customer-facing use of "independent" for the assessment |
| Status | **PENDING** |

### SR-13 — Overstated Republika claims in delivered artefacts

| Field | Content |
| --- | --- |
| Threat | The report cover states that the approver acts as the controlled review (GF-01); drafts claim independence and "prove it" (GF-06) |
| Likelihood / impact | High (present in the text today) / Medium |
| Existing mitigation | None |
| Evidence | `commercial-report.ts:787-791`; drafts A, H; service spec §1 |
| Proposed additional mitigation | Draft corrections per `CUSTOMER_CLAIMS_REVIEW.md`; D-02 decision; generator wording per version (R-06b) |
| Residual | Low after mitigation |
| Recommendation | **Mitigate before any customer delivery** |
| Owner / approver | LEG / LEG + FDR |
| Review / expiry | Before first delivery |
| Invalidates acceptance | Any new artefact with unreviewed claims |
| Status | **PENDING** |

### SR-14 — Governance-record ambiguity

| Field | Content |
| --- | --- |
| Threat | Self-expiring restriction wording (GF-02), an unapproved "Accepted" in REL-01D (GF-03) and an internally inconsistent data policy (GF-04) are read as decisions |
| Likelihood / impact | Medium / Medium |
| Existing mitigation | The GO/NO-GO gate's §4 rule that only attributable records count |
| Evidence | GF-02…GF-04 in `GOVERNANCE_READINESS.md` |
| Proposed additional mitigation | Correct REL-01D §10 wording (R-11); correct `CUSTOMER_DATA_GOVERNANCE.md` during M3; P4 in the version strategy |
| Residual | Low |
| Recommendation | **Mitigate** |
| Owner / approver | GOV / GOV + FDR |
| Review / expiry | At M3 |
| Invalidates acceptance | Not applicable |
| Status | **PENDING** |
