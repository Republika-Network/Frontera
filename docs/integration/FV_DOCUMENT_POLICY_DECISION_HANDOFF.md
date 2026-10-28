# FV-P3 → ASSURE: document-use policy decision handoff

**Status:** handoff for discussion. Not a signed record format, not a contract change. Nothing here
changes an ASSURE contract.

FV-P3 adds `evaluateDocumentUsePolicy` to `@aoc-enterprise/sovereign-receiver-verification`. This note
says what a decision is, what it is not, and what later evidence would need from it. Record design and
signing stay with ASSURE.

## The chain, and where a decision sits

```
verified asset (RSDK-01) → eligible terms (FV-P2) → evaluated policy (FV-P3)
  → revocation / freshness check → authorized operation → governed execution → verifiable evidence
```

A decision is the third link only. No link may be skipped or replaced by an earlier one. `ALLOWED` is
an evaluated permission under one eligible terms claim at one host-supplied instant. It is not an
authorization or a capability, it is not proof that nothing was revoked, and it is not an executed
operation. Every decision states this itself:

- `authorization: 'not_evaluated'`
- `revocation: 'not_evaluated'`
- `freshness: 'not_evaluated'`
- `execution: 'not_performed'`

## Decisions and reasons

| `decision` | `reason` (closed set `DOCUMENT_USE_POLICY_REASONS`) |
|---|---|
| `ALLOWED` | `PERMITTED` |
| `WITHHELD` | `OWNER_APPROVAL_REQUIRED` (no approval evidence format exists yet, so this never becomes `ALLOWED`) |
| `DENIED` | inputs: `ELIGIBILITY_UNVERIFIED`, `REQUEST_INVALID`, `CONTEXT_INVALID`, `ACTION_UNKNOWN`, `EVALUATION_TIME_INVALID`, `RECEIVER_IDENTITY_INVALID`, `ASSET_MISMATCH`, `POLICY_REFERENCE_MISMATCH` |
| `DENIED` | applicability: `TERMS_TIME_INVALID`, `TERMS_NOT_YET_EFFECTIVE`, `TERMS_EXPIRED`, `AUDIENCE_UNSUPPORTED`, `AUDIENCE_MISMATCH` |
| `DENIED` | rule semantics: `CONCEPT_UNSUPPORTED`, `EFFECT_UNSUPPORTED`, `EFFECT_MISPLACED`, `RESTRICTED`, `NOT_PERMITTED` |
| `DENIED` | `EVALUATION_ERROR` |

Exactly one reason per decision. `matchedRuleIds` names the terms rules that settled it.

## Fields available for later evidence

| Field | Meaning | Publishable? |
|---|---|---|
| `evaluator` | `aoc-enterprise.document-use-policy-evaluation/1`: the evaluator version | yes |
| `documentProfile` | `soberania.document-use/1` | yes |
| `decision`, `reason`, `matchedRuleIds` | the outcome and what settled it | yes |
| `action` | the requested concept, e.g. `soberania.document:export` | yes |
| `sovereignAssetId` | the evaluated asset (from verified eligibility, never from the request) | an identifier, not content. Whether to disclose it to third parties is ASSURE's call |
| `policy.claimId`, `policy.claimDigest` | the identity of the evaluated terms: the signed claim's digest | yes |
| `evaluationTime` | the instant the host supplied | yes |

A later signed record would also need inputs that FV-P3 does not hold or does not authenticate:
- the receiver identity actually used (the decision omits it deliberately);
- how the host's clock is trusted;
- the RSDK-01 and FV-P2 profile versions;
- the registrant's key id (`eligibility.terms.keyId`);
- a binding to the operation that was eventually authorized or executed.

## Audience semantics

- `Principal`: the receiver identity the host supplies must equal the declared principal exactly.
- `Public` (founder decision, FV-P3.1): the terms are addressed to any receiver. This is not public
  access to the content and not an authorization. Every rule, the time bounds, the asset binding and
  eligibility still apply, and no audience turns a Restriction into a Permission. A Public `ALLOWED`
  is still only an evaluated permission.
- `Custom`: not interpreted, so it is `DENIED` with `AUDIENCE_UNSUPPORTED`.

## Never in a decision or its evidence

Document content, bytes or excerpts; rule `statement` text; private keys; tokens; share links or
any `#key=` decryption fragment; credentials. The decision object carries none of them.

## Trust boundary

- `evaluateDocumentUsePolicy` accepts only an eligible result issued by `verifyDocumentUseEligibility`
  in the same process, recognised by object identity, and deeply frozen. Copies, deserialized results
  or structurally identical objects are refused (`ELIGIBILITY_UNVERIFIED`). A decision therefore cannot
  be produced from evidence that was not verified in that process. It also cannot be replayed across
  processes from a serialized eligibility.
- The trusted context (receiver identity, evaluation time, expected asset, policy reference) comes
  from the host. The evaluator rejects malformed values but cannot authenticate them. The requester
  supplies only the action.

## Open items for ASSURE

1. The signed decision record: format, signer, and binding to the operation and to the receiver identity.
2. The approval evidence format that could satisfy `OWNER_APPROVAL_REQUIRED`. It must be bound to the
   operation, asset, authority and policy digest. Until it exists, `WITHHELD` stays withheld.
3. How `WITHHELD` maps onto governed-action `withheld` / `withheldBy: 'approval'`. Not done here.
