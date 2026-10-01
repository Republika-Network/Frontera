# CTRL-02 — Organizations, Human Operators & Agent Inventory: Qualification

- **Roadmap item:** CTRL-02 (`docs/architecture/FRONTERA-MASTER-PLAN.md` §9)
- **Branch:** `feat/ctrl-02-organizations-operators-agents`, from `main @ 3c56a71`
- **Decision record:** `docs/architecture/ADR-CTRL-02-OPERATOR-AGENT-IDENTITY.md`
- **Exit criterion:** *A pilot organization onboards an agent and assigns it bounded authority without source code, a REPL or direct DB access, as an identified human operator.*

## 1. Discovery inventory (before CTRL-02, `main @ 3c56a71`)

| Area | Finding |
|---|---|
| Human identities | CTRL-01 `administrators[] {operatorId, apiKeyEnv}` (configuration, shared bearer secret, one implicit power set); customer principals (configuration `customerPrincipals[]` → API key with `customerIdentity`); legacy API keys (`AOC_ENTERPRISE_API_KEYS`, optional org scope); approval actors = Kernel-Authority actors (CORE-05, in-process command port); Kernel-Authority write actor = `context.actorId` (`operator:<id>` from CTRL-01); passport-web human accounts (separate product, own DB) |
| Credentials | All Enterprise credentials are configuration (environment references), constant-time matched by `orchestration/credential-matching.ts`; secrets unique across classes (`HOST_CREDENTIALS_AMBIGUOUS`); administrators never merged into `authentication.apiKeys` |
| Organization scoping | One organization per Host (`kernelAuthority.organizationId`, CORE-04); customer keys must be scoped to it |
| Kernel-Authority provisioning | `KernelAuthorityProvisioningService`: actor, trust domain, passport, capability token, root issuer, authority grant, delegation grant, revoke, list/read, `findActorByExternalSubject`; organization-scoped idempotency pinned to the payload digest; P10 shape on append and asset/scale at provisioning; re-hydration after commit. **In-process only** (revocation over HTTP since CTRL-01) |
| Customer admission | `customerPrincipals[]` is parsed at boot and frozen; an agent unknown to the file cannot authenticate → the exit criterion was impossible without editing configuration and restarting |
| Governance Profiles | Trusted-host format (CORE-03); one active version per id; no lifecycle; `provenance.approvedBy` is a configured string |
| Passport shapes | Five, unreconciled (§6) |
| API freeze | 36 endpoints (`release/api-surface.v1.json`) |
| Boundaries to preserve | body read only after authorization; closed schemas; organization server-side; `system: true` never from a request; no un-revoke; no issuance over HTTP; append-only Kernel Authority |

## 2. What was built

See the ADR (D1–D15). In one line each: a first-class operator principal and a closed role model behind one authenticator and one permission policy; CTRL-01 administrators held to exactly CTRL-01; Kernel-Authority provisioning over the operator plane through the existing service, with reference checks and a dry-run replay; an agent inventory computed from the Kernel Authority; operator-issued agent credentials that close the static-admission gap; an operator-promoted Governance Profile lifecycle; an explicit passport reconciliation.

## 6. Passport reconciliation and TD-5

The **Kernel-Authority passport** is the only passport on the governed-action authority path: it is required for a Kernel ALLOW (`ValidPassportPolicy`), owned by the Kernel Authority store, provisioned over the operator plane and shown in the agent inventory. The Enterprise AgentPassport (`/api/passports`) is an identity/evidence record no authority path reads; `packages/agent-governance`, `apps/agent-passport-web` and the PMFreak foundation are separate libraries/products the Enterprise runtime never imports. The canonical governed-action identifier is the Kernel-Authority actor id. Provisioning one shape never creates another; CTRL-02 links none of them (ADR D12).

**TD-5 remains open.** The passport-web / agent-governance issuer signs with HMAC (`createTestSigner`), which is **not publicly verifiable**: any verifier holding the shared secret can also mint. CTRL-02 does not claim otherwise, adds no passport signer or key, and keeps the authority signing key free of any passport operation (ADR D13). A publicly verifiable passport needs its own asymmetric key role.
