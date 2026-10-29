# FV-P4C-1 → ASSURE: document-use freshness handoff

**Status:** handoff for discussion. It is not a signed record format and not a contract change, and it
changes no ASSURE contract. Record design and signing stay with ASSURE.

FV-P4C-1 adds `checkDocumentUseFreshness` to `@aoc-enterprise/sovereign-receiver-verification`. It
follows the FV-P3 policy decision handoff (`FV_DOCUMENT_POLICY_DECISION_HANDOFF.md`) and adds one link
to the chain:

```
verified asset (RSDK-01) → eligible terms (FV-P2) → evaluated policy (FV-P3)
  → freshness against this receiver's history (FV-P4C-1) → authorized operation → governed execution → evidence
```

A freshness result is not an authorization and not an executed operation. Every result says so:
`authorization: 'not_evaluated'` and `execution: 'not_performed'`.

## Fields available for later evidence

| Field | Meaning | Publishable? |
|---|---|---|
| `gate` | `aoc-enterprise.document-use-freshness/1`: the gate version | yes |
| `operationId` | the host's identifier for the operation being considered | yes, if the host's identifiers are |
| `action`, `policy.claimId`, `policy.claimDigest` | the evaluated action and terms identity | yes |
| `sovereignAssetId` | the asset, from verified eligibility | an identifier, not content. Disclosure to third parties is ASSURE's call |
| `evaluationTime` | the one trusted instant used for policy and freshness | yes |
| `policyDecisionBefore` | the FV-P3 decision; `null` when its provenance was not established | yes |
| `policyDecisionAfterFreshness` | the decision after freshness, never higher than before | yes |
| `freshnessVerdict` | one closed verdict (`DOCUMENT_USE_FRESHNESS_VERDICTS`) | yes |
| `statusRejection` | the FV-P4B reason when the status itself was refused | yes |
| `status.sequence`, `status.statusDigest`, `status.assetStatus`, `status.currentTermsDigest`, `status.issuedAt`, `status.validUntil` | the status checked, by identity | yes |
| `history.initialization` | `ESTABLISHED`, `UNINITIALIZED`, or `UNKNOWN` (store not read or unreadable) | yes |
| `history.before`, `history.after` | the receiver's high-water mark (sequence, status digest) before and after this check | yes |
| `history.transition` | `not_attempted`, `unchanged`, `advanced`, `advanced_with_gap`, `conflict_recorded`, `refused` | yes |
| `maxStatusAgeSeconds` | the maximum age applied for the action | yes |

## How to read a result

- **Decisions.** `ALLOWED` after freshness requires `ALLOWED` before and `FRESH`. `WITHHELD` after
  freshness requires `WITHHELD` before and `FRESH`; it means approval is still pending and is never
  executable. Everything else is `DENIED`.
- **`FRESH` is relative to this receiver.** It means the status is the latest this receiver has trusted,
  names the evaluated terms, the asset is active, and the status is within its signed window and the
  action's maximum age. It does not mean that no newer status exists anywhere.
- **`HISTORY_UNINITIALIZED`.** The receiver had no trusted anchor. No replay protection applied, and the
  operation was refused.
- **`CONTINUITY_UNPROVEN`** is sticky until the host re-anchors the history out of band. Evidence of
  the re-anchor should be kept separately.
- **`CONFLICT_DETECTED`** is terminal within this gate's recovery capabilities. Ordinary checks,
  bootstrap and re-anchor all refuse a conflicted history, and nothing in FV-P4C-1 clears the latch. A
  trusted operator alone is not sufficient evidence to clear an equivocation. Evidence-based recovery,
  with its own authorization boundary and audit evidence, is future work. The conflict is not claimed
  to be permanent beyond this gate.

## Bootstrap evidence

`establishStatusHistory` is the trusted, out-of-band anchoring step. Its trust assumption is that the
host obtained the status through a channel it trusts to be current. That assumption is not verifiable
here. It never re-anchors a history with a latched conflict (`CONFLICT_DETECTED`). A later record of a bootstrap should capture:
- who ran it and through which channel the status was obtained;
- the anchored sequence and digest;
- whether it was a re-anchor, and of what prior mark.

## Durable history (FV-P4C-2A)

A receiver may keep its history in the SQLite store `openSqliteStatusHighWaterMarkStore`
(`src/enterprise/sovereign-status-history/`) instead of the in-memory reference. The gate and its
results are unchanged. These are further fields a later record could carry:

| Field | Meaning | Publishable? |
|---|---|---|
| store kind | `sqlite` or `in-memory`, and the store schema version `frontera.sovereign-status-history.v2` | yes |
| history namespace | the namespace the store file is pinned to | only if non-sensitive; never the file path |
| revision before / after | the store revision the gate read, and the one it wrote | yes |
| compare-and-set outcome | committed, lost a race (recomputed), or failed (`HISTORY_STORE_UNAVAILABLE`) | yes |
| continuity across restart | the history read after a reopen equals the one written before it | yes |
| conflict latch, withdrawal, retired terms, time floor | as stored, after the check | yes |
| integrity result | opened with the expected schema, triggers and integrity check; row validated | yes |

**Bootstrap evidence (FV-P4C-2B1).** From schema v2 on, a history exists only with a bootstrap evidence
record (`frontera.sovereign-status-bootstrap-evidence/1`), committed in the same transaction. A history
whose latest evidence is missing or inconsistent is refused (R2). Contract, authority model and limits:
`FV_TRUSTED_BOOTSTRAP_RECOVERY.md`.

**Storage trust assumptions.** The file is as trustworthy as the host that keeps it.
- **Refused by the store:** deleting a row, rewriting backwards and corruption, at the SQL level and in
  the adapter. Each fails closed.
- **Not detectable without an external anchor:** a whole-file restore of an older copy, or a deleted
  database. These can make the receiver forget statuses it saw.

A record must say so, and must not present the durable store as rollback-proof.

## Never in evidence

Document content, bytes or excerpts; rule `statement` text; private keys; tokens; share links or any
`#key=` decryption fragment; credentials; the signed status text itself when the asset identifier must
stay confidential. The result object carries none of these.

## Limits a record must not overstate

- Only what this receiver observed is known. An external revocation that never reached it is not
  detected.
- The reference store is in memory and process-local. A restart, a second instance or a worker starts
  uninitialized. The SQLite store (FV-P4C-2A) survives restarts and is shared by every connection and
  process using the same file. A rollback or deletion of that whole file is still not detectable without
  an external anchor (FV-P4C-2B).
- The trusted context (time, operation identifier, resolver, store) is supplied by the host and not
  authenticated by the gate.
- After a compromise of the registrant's key, an attacker can sign statuses that pass until the key is
  unpinned.

## Open items for ASSURE

1. The signed freshness record: format, signer, and binding to the operation and to the receiver.
2. Bootstrap and re-anchor evidence, and who may perform them.
3. The design of any evidence-based conflict recovery: what proves which status is legitimate, who may
   authorize it, and what audit record it leaves.
4. How a freshness result joins the FV-P3 decision record and a later authorization record.
