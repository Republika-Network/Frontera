# Agent Passport Migration V1 (PR-006)

How the new Frontera Systems Agent Passport Runtime
(`src/enterprise/passport/`) relates to the pre-existing Agent Passport
SaaS product. See `AOC_AGENT_PASSPORT_CURRENT_MODEL.md` for the full
inventory this migration analysis is based on.

## Summary

**No migration happens in this PR.** `packages/agent-governance`,
`apps/agent-passport-web`, and `packages/pmfreak-agent-passport-
foundation` are untouched — no code changed, no schema changed, no data
moved. The new Passport Runtime is a structurally independent addition;
this document exists to make that independence, and the eventual path
to convergence if one is ever wanted, explicit.

## Field-by-field separation

### Canonical fields (carried forward conceptually into the new model)

| `agent-governance.AgentPassport` field | New `AgentPassport` equivalent |
|---|---|
| `passportId` | `passportId` |
| `agentName` | `subject.displayName` |
| `status` | `status` (different vocabulary — see below) |
| `issuedAt` | `createdAt` / `provenance.createdAt` |
| `issuer` | `provenance.createdBy` / `organization.recognizedBy` |
| `metadata` | *(none — the new model has no arbitrary metadata bag; every field is typed and named)* |

### Commercial SaaS fields (stay in `apps/agent-passport-web` only)

`purchases`, `stripe_webhook_events`, `organization_registry_
entitlements`, pricing, buyer accounts, team invitations/roles, admin
access recovery. None of these has, or needs, an equivalent in the
Enterprise Passport Runtime — Enterprise Passports are not sold, and the
Runtime has no concept of billing.

### Billing fields

Same as above — `apps/agent-passport-web/src/lib/pricing.ts` and its
Stripe integration are entirely out of scope.

### UI fields

`agent-governance.AgentPassport.qrPayload`, `verificationUrl` — product
presentation concerns with no Enterprise Runtime equivalent. A future
UI layered on top of the Runtime's `AgentPassportView` could derive
similar presentation artifacts, but the Runtime itself carries none.

### Legacy status fields

Three status vocabularies existed before this PR (see item 12 of
`AOC_AGENT_PASSPORT_CURRENT_MODEL.md`): `recognition-runtime`'s `valid`/
`expired`/`suspended`/`revoked`; `agent-governance`'s own transition
guards; and PMFreak's 15-value trust lattice. **None of them is reused
verbatim.** The new `AgentPassportStatus` (`draft`/`active`/`suspended`/
`revoked`/`expired`/`retired`) is a deliberately fresh, minimal
vocabulary chosen for the Enterprise lifecycle model — no automatic
mapping is defined or implied between it and any legacy status field,
because the underlying *meaning* of "active"/"suspended" differs between
a commercial credential's validity window and a governed identity
aggregate's operational eligibility.

### Unsupported history

No historical `agent-governance` or `recognition-runtime` Passport
events are imported, backfilled, or synthesized into the new event
store. **No missing Passport events are invented.** An organization that
wants an Enterprise Agent Passport for an agent that already has a
commercial `agent-governance` Passport issues a *new* one via
`issuePassport()`; the two records coexist, linked only by convention
(e.g. a shared `agentId`), never by data migration.

## Existing SaaS compatibility strategy

`apps/agent-passport-web` **remains functional unmodified** because:

1. **No shared code path.** The Enterprise Runtime lives entirely under
   `src/enterprise/passport/`; `apps/agent-passport-web` continues to
   depend only on `packages/agent-governance`, exactly as before.
2. **No shared storage.** The SaaS app's SQLite database
   (`AOC_AGENT_PASSPORT_DB_PATH`) and the Enterprise Runtime's SQLite
   database (`AOC_ENTERPRISE_PASSPORT_SQLITE_PATH`) are distinct files
   with distinct schemas; neither reads nor writes the other.
3. **No shared HTTP surface.** The SaaS app's Next.js API routes
   (`/api/agent-passports/*`) and the Enterprise Host's routes
   (`/api/passports/*`) are different processes, different route
   namespaces, and are never proxied into one another by this PR.
4. **Verified by structural boundary tests.** `src/enterprise/
   __tests__/structural-boundaries.test.ts`'s "Agent Passport Runtime
   (PR-006)" block asserts the Kernel, Governance Store, and Evidence
   Runtime never import the new Passport module, and the reverse
   direction is checked by construction (the new module only imports
   `../governance-store/*` and `../evidence/*` public contracts — see
   the same test file).

If a future PR wants the two products to converge, the available
strategies (per the mission, none chosen here) are: an **adapter** layer
that translates between `agent-governance.AgentPassport` and the
Enterprise `AgentPassport` at read time; a **shared core contracts**
package both depend on; a **runtime client** the SaaS app calls into
instead of its own store; or a **staged migration** that runs both in
parallel with a defined cutover. This PR deliberately does none of
these — see the ADR's Rejected Alternatives.

## What must remain external (restated from the current-model analysis)

`packages/agent-governance`, `apps/agent-passport-web`,
`packages/pmfreak-agent-passport-foundation`, and
`src/features/recognition-runtime` are all explicitly out of scope for
modification in this PR and remain the systems of record for their
respective concerns (commercial issuance, PMFreak demo enrollment, and
Kernel-facing recognition credentials, respectively).
