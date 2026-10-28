# ASSURE-SEC-01B — Authenticated reviewer identity and role binding

**Invariant:** a caller cannot choose who appears as the reviewer of a manual
Assurance review, or what authority that reviewer holds.

## Before

`recordManualReview(context, input)` recorded `input.reviewerId` and authorized
on `input.reviewerRole`. Both came from the request body. `/api/assurance/*`
authenticated organization API keys only. Those keys carry no actor and no
roles, and with `AOC_ENTERPRISE_REQUIRE_AUTH` off every caller was the system
context. Any holder of an organization key, or any local caller of an
unauthenticated Host, could record a review as any reviewer, with any role.

## Trust boundary

| Step | Where | What it trusts |
| --- | --- | --- |
| Credential | governed-action file `assuranceReviewers: [{ reviewerId, roles, apiKeyEnv }]` (embedders: `authentication.assuranceReviewers`) | Configuration only. The organization is the served organization. Roles are explicit, exact and never implied. |
| Validation | `assertAssuranceReviewerConfiguration` (Host loader **and** composition) | The served organization, a canonical unique id outside `agent:`, ≥ 1 exact role (no patterns), a secret of ≥ 32 characters shared with no other credential of any class. |
| Authentication | `AssuranceService.authenticateReviewer(bearer)` | A constant-time match against configured reviewer secrets. It returns a frozen principal registered in that service instance's private `WeakSet`. |
| HTTP | `POST /api/assurance/manual-reviews` | Only a reviewer bearer. This check runs before (and instead of) organization-key resolution, and also when authentication is off. Missing or non-reviewer credential: `401`. |
| Authorization and binding | `recordManualReview` | `context.reviewer` must be a principal **this** service issued. The context's `organizationId`/`actorId`, when present, must match it. A body `reviewerId`/`reviewerRole`, when present, must match it (refused with `403 ASSURANCE_REVIEWER_UNAUTHORIZED`, never replaced). The control's required role must be among the credential's roles. Every read and the write run in the reviewer's own tenant scope. |
| Record | `AssuranceManualReviewRecord` | `reviewerId` and `reviewerRole` are derived from the credential. `reviewerAuthentication: 'assurance_reviewer_credential'` is covered by `reviewDigest`. The `AssuranceManualReviewCompleted` event carries the same identity. |
| Evaluation | control evaluator | Only reviews with `reviewerAuthentication` resolve a control. Earlier reviews stay on record but are never promoted (`CONTROL_MANUAL_REVIEW_IDENTITY_UNVERIFIED`). |

**What types cannot guarantee.** `AssuranceAccessContext` is a plain structure.
The guarantee is the `WeakSet`: a structural copy, a principal from another
service instance, a `system: true` context, or `actorId`/`roles` fields are all
refused. In-process code that holds a configured reviewer secret can
authenticate as that reviewer, because the secret is the credential. No
internal or system identity is a reviewer. With no reviewer configured, no
manual review can be recorded.

## SEC-01A is preserved

Identity is checked first, then evidence binding. An authenticated reviewer
still needs accepted evidence, bound to the control, for `pass`, `partial` or
`fail`. `insufficient_evidence` still needs none.

## Historical reviews

Records written before SEC-01B have no `reviewerAuthentication`. They are kept
as written: no identity is rewritten and no store is migrated. They never
resolve a control again, so an in-flight assessment that relied on one returns
to `manual_review_required` until an authenticated reviewer records a review.
Completed assessments are immutable and are not re-evaluated.

## Compatibility

`POST /api/assurance/manual-reviews` keeps its URL, method and body shape.
`reviewerId` is now optional. The caller's credential changed: see
`docs/enterprise/API_STABILITY_V1.md` (an intentional v1 security tightening,
as G-01A was). The SDK `ManualReviewRequest.reviewerId` is optional. The SDK
client must use the reviewer credential as its `apiKey`.

## Residual risks

- **SEC-01C:** the `verified` flag on manual evidence is still self-declared, as
  are attestation metrics and `requirementIds`.
- **SEC-01D:** organization attribution of unscoped evidence, and v2 bundle
  verification, remain open.
- **SEC-01E:** finding-event write failures at completion are still ignored.
- **No external authenticity:** a reviewer credential is a static bearer secret,
  not a per-human, phishing-resistant factor such as the AUTH-02 passkeys used
  for approvals. A shared or leaked secret makes its holder that reviewer.
  Rotation is by configuration.
