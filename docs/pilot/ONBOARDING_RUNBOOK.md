# Pilot Onboarding Runbook (PROD-03)

How a pilot organization goes from a deployed Frontera Host to an agent
acting under bounded, approved, revocable authority — and back out again —
using only supported surfaces: the deployment kit and its tools, the Host's
operator API, the web console and the documented command-line tools. Nothing
here edits source code, opens a database or relies on anyone who built
Frontera.

**Every command block marked `drill:` is executed as written** by the PROD-03
clean-room pilot drill (`tests/pilot/prod03-clean-room-drill.test.mjs`,
handoff phase), by a second operator team that starts with only this runbook,
its credentials and the deployment's configuration. The drill substitutes only
the Host's address. Blocks marked *reference* say why they are not run there.

Deployment and day-to-day operation are in
[`docs/deployment/PILOT_DEPLOYMENT.md`](../deployment/PILOT_DEPLOYMENT.md) and
[`OPERATIONS_RUNBOOK.md`](OPERATIONS_RUNBOOK.md); what each party owns is in
[`SHARED_RESPONSIBILITY.md`](SHARED_RESPONSIBILITY.md); what Frontera protects
and assumes is in [`SECURITY_POSTURE.md`](SECURITY_POSTURE.md).

## 1. Roles and the smallest safe staffing

The operator roles are a closed set, configured per person in the
governed-action file (`operators[]`). A role decides which operator-plane
commands a credential can reach; it never creates authority by itself.

| Role | Can | Use it for |
| --- | --- | --- |
| `organization-administrator` | everything, including organization bootstrap, emergency release and operator resolution | bootstrap; releasing a stop; recording a resolution |
| `provisioner` | create actors, passports, capability tokens, authority and delegation grants; issue, rotate and revoke agent credentials; revoke | onboarding agents and assigning authority |
| `profile-steward` | activate and retire Governance Profile versions | promoting the profiles the pilot runs under |
| `approver` | read; approve; reject, request changes, escalate, revoke an approval | deciding approvals (with Kernel-Authority standing, §8.1) |
| `responder` | read; revoke authority and credentials; declare an emergency stop | incident response; offboarding |
| `observer` | read everything the operator plane shows | monitoring, audit, the readiness gate |

The smallest safe split for a pilot is **four people**: one
`organization-administrator` (who does not provision or approve day to day),
one `provisioner`, one `approver` who is not the provisioner, and one
`observer`. The reference template also names a `profile-steward` and a
`responder`; one person may hold either alongside another role, never the
provisioner and the approver together. An organization administrator holds
every permission and could, alone, provision an agent, give itself approval
standing and approve a quorum-1 request: keep that role for bootstrap and
release, use a quorum of 2 for consequential approvals, and keep provisioning
and approval with different people.

## 2. The reference pilot deployment

One canonical deployment, all of it existing Frontera components:

| Part | Reference choice | Notes |
| --- | --- | --- |
| Frontera Host | the PROD-03-03 Compose kit (`deploy/pilot/`), secure `production` profile | one Host per organization |
| Configuration | `deploy/pilot/governed-actions.reference-pilot.json`, copied to `governed-actions.json` | the canonical pilot template (§2.1) |
| Authority-state witness | the bundled reference witness, its own volume (`frontera-witness`) | an external `https://` witness is a Host feature, not part of the qualified kit |
| Authority signer custody | software custody (the key in `.env` and the Host process) | external custody is supported by the Host (SECURITY_POSTURE.md §4) |
| Control plane | the operator API under `/api/admin/...`; the web console (§14) | the same Host state either way |
| Durable state | the `frontera-state` volume | every store, one directory |
| Backups | `backup:v1` through the kit (OPERATIONS_RUNBOOK.md §5) | off-host, encrypted by the pilot |
| Secrets | `deploy/pilot/.env`, filled from the pilot's secret manager | never in Git |
| Governed action target | the pilot's own system, reached by the Generic HTTP adapter over `https://` | the target authenticates the adapter itself |
| Observability | `/live`, `/ready`, `/health`, `/version`, the operator health view, structured logs, the readiness gate | OPERATIONS_RUNBOOK.md §9 |
| Pilot administrator | `ops-admin` (`organization-administrator`) | |
| Pilot operators | `ops-provisioner`, `ops-steward`, `ops-approver`, `ops-responder`, `ops-observer` | |
| Agent credential | issued by the operator plane, revealed once (§6) | |
| Evidence and auditor access | an observer credential (operator plane), and optionally an organization-scoped evidence key (§10) | read-only |

### 2.1 The reference pilot use case

A **deployment request to a governed target**: an agent asks to deploy a
release (`deploy-release`) to `staging-cluster` or `production-cluster`, with
two typed parameters — `replicaCount` (integer, at most the bound) and
`deploymentStrategy` (token, exactly the bound). Two Governance Profiles
govern it:

- `deploy-staging` — decided by authority and bounds alone;
- `deploy-production` — the same, and every decision **requires human
  approval** (`approvalPolicy`, one approver holding `approve-deploy` over the
  production cluster).

The template routes `deploy-release` to a Generic HTTP adapter whose origin,
`https://deploy.example.com`, is a placeholder: set it to your target's exact
`https://` origin (the adapter refuses loopback and private addresses) and set
`FRONTERA_PROVIDER_TOKEN` in `.env` to the credential your target issued.
Rename actions, resources, dimensions and profiles to your use case; keep the
shape. The template holds no secret: every credential is named by the
environment variable that holds it. `docker compose run --rm config-check`
validates it, with the rest of the configuration, before anything starts.

**`approvalPolicy`** is the one piece of deterministic policy the shipped Host
reads from the file: per Governance Profile, "a decision governed by this
profile requires human approval". It can only send an otherwise allowed
decision to the approval workflow; it cannot allow, deny or shape authority.
Two things are checked before anything starts (`config-check` and the
launcher refuse otherwise), so that nothing it sends to review is
unresolvable from the first request:

- **every declared version** of the profile it names declares how it is
  approved (`approval`, CORE-05). Under the operator-promoted lifecycle the
  catalog may hold several versions of one profile, and a steward can promote
  any of them; a version without `approval` would turn "requires approval"
  into a review nothing can approve. Versions may declare different approval
  terms — each review is bound to the version in force when it was opened,
  and a review opened under one version is superseded (never executed) once
  another is promoted;
- at least one configured operator's role can reach `approval.approve` —
  `approver` or `organization-administrator` (the operator-plane role policy,
  §1). That is necessary, not sufficient: an approval
  counts only when its operator also holds Kernel-Authority standing for the
  profile's approver action (§8.1).

Any other policy (conditions on amounts,
facts, risk) is in-process composition by an embedder
(`docs/enterprise/AOC_ENTERPRISE_HOST.md`), outside the qualified pilot.

## 3. First boot

The kit's installation is
[`docs/deployment/PILOT_DEPLOYMENT.md`](../deployment/PILOT_DEPLOYMENT.md) §8.
With the reference template:

1. **Prepare the secret source** — your secret manager holds what the
   generator prints, the provider credential and, later, each agent's
   credential. Nothing is generated by anyone outside the pilot.
2. **Copy the configuration** — `cp governed-actions.reference-pilot.json governed-actions.json`,
   then edit the target origin, organization-specific names and operators.
3. **Generate the deployment's keys and operator credentials, once** — one
   `--secret` per operator in `operators[]`:

   <!-- ref: one-time and Compose-specific; the drill runs the same generator (scripts/deploy/generate-pilot-secrets.mjs) directly -->
   ```bash
   docker compose run --rm -T witness-init \
     --secret FRONTERA_OPERATOR_KEY_ADMIN --secret FRONTERA_OPERATOR_KEY_PROVISIONER \
     --secret FRONTERA_OPERATOR_KEY_STEWARD --secret FRONTERA_OPERATOR_KEY_APPROVER \
     --secret FRONTERA_OPERATOR_KEY_RESPONDER --secret FRONTERA_OPERATOR_KEY_OBSERVER >> .env
   ```

   The generator refuses to run twice on one deployment.
4. **Set the organization id and the provider credential** in `.env`
   (`AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID`, `FRONTERA_PROVIDER_TOKEN`).
5. **Validate, start, verify** — OPERATIONS_RUNBOOK.md §2 (configuration check,
   start, `/live`, `/ready`, `/version`).
6. **Run the readiness gate** — OPERATIONS_RUNBOOK.md §9.1. A new deployment is
   `deployment-ready`; its organization level fails until §4 and §5 are done
   (`PR-07`, `PR-09`).
7. **Hand each operator their credential** through your secret channel. Each
   confirms it with `GET /api/admin/organization`, which shows their role.

**Adding an operator later** is a configuration change: add the entry to
`operators[]`, generate only its credential
(`docker compose run --rm -T witness-init --secrets-only --secret FRONTERA_OPERATOR_KEY_NEW >> .env`),
run the configuration check, then `docker compose up -d`. **Removing one**:
delete the entry and its variable, check, `docker compose up -d`; the
credential stops working when the Host restarts. Either change invalidates the
readiness gate's qualification record (PILOT_READINESS.md §5.3).

### 3.1 Operator session

The blocks below expect the operators' credentials as header lines, loaded
without echoing them (the same convention as OPERATIONS_RUNBOOK.md §1.1), and a
private working directory for responses:

<!-- ref: interactive (reads credentials from the operator's terminal); the drill sets the same variables from the deployment's generated credentials -->
```bash
read -rsp 'provisioner credential: ' K; echo; export PROVISIONER="Authorization: Bearer $K"
read -rsp 'approver credential: ' K; echo; export APPROVER="Authorization: Bearer $K"
read -rsp 'observer credential: ' K; echo; export OBSERVER="Authorization: Bearer $K"
unset K
export WORK="$HOME/frontera-onboarding" SECRET_DIR="$HOME/frontera-onboarding/secret"
mkdir -p "$SECRET_DIR" && chmod 700 "$WORK" "$SECRET_DIR"
```

`ADMIN`, `STEWARD` and `RESPONDER` are loaded the same way by the person who
holds that role, only when needed.

## 4. Organization bootstrap

Once per organization, by the `organization-administrator`: the organization's
issuer actor, its trust domain and its root-issuer standing. The values are
the ones in your governed-action file (`trustDomainId`) and your own naming:

<!-- ref: the drill sets these values for its own organization -->
```bash
export ORG_ISSUER=actor-pilot-org TRUST_DOMAIN=trust-domain-pilot ORG_NAME='Pilot Organization'
```

<!-- drill: org-actor -->
```bash
curl -sS -w '\n%{http_code}\n' -X POST -H "$ADMIN" -H 'Content-Type: application/json' --data-binary @- \
  http://127.0.0.1:8787/api/admin/authority/entities/actor <<EOF
{"actorId":"$ORG_ISSUER","type":"organization","displayName":"$ORG_NAME","idempotencyKey":"bootstrap-org-actor"}
EOF
```

<!-- drill: org-trust-domain -->
```bash
curl -sS -w '\n%{http_code}\n' -X POST -H "$ADMIN" -H 'Content-Type: application/json' --data-binary @- \
  http://127.0.0.1:8787/api/admin/authority/entities/trust-domain <<EOF
{"trustDomainId":"$TRUST_DOMAIN","name":"$ORG_NAME","issuerActorId":"$ORG_ISSUER","acceptedIssuerIds":["$ORG_ISSUER"],"acceptedActorTypes":["human","organization","agent"],"idempotencyKey":"bootstrap-trust-domain"}
EOF
```

<!-- drill: org-root-issuer -->
```bash
curl -sS -w '\n%{http_code}\n' -X POST -H "$ADMIN" -H 'Content-Type: application/json' --data-binary @- \
  http://127.0.0.1:8787/api/admin/authority/entities/root-issuer <<EOF
{"trustDomainId":"$TRUST_DOMAIN","actorId":"$ORG_ISSUER","idempotencyKey":"bootstrap-root-issuer"}
EOF
```

Each answers `200` with `"outcome":"provisioned"` and the entity, recorded as
`provisionedBy: operator:<your id>`. Running a block again with the same body
and key is safe: it answers `"outcome":"replayed"` and writes nothing. A
*different* body for an existing id is refused (`409`,
`OPERATOR_OPERATION_REFUSED`, `recorded: false`), so a mistaken second
bootstrap cannot overwrite the first. Only an `organization-administrator` can
bootstrap (`403 OPERATOR_PERMISSION_DENIED` otherwise); the organization is
always the Host's own — a request that names one is refused (`400`).

## 5. Governance Profiles

Two different things, kept apart on purpose:

- **Authoring** a profile — its action and resource classes, parameters,
  approval requirement — is configuration: the governed-action file, reviewed
  like code, applied by a restart. There is no runtime profile editor.
- **Promoting** a version — making a catalog version the one in force — is a
  runtime operation by a `profile-steward` (or administrator), recorded
  durably and bound to the version's content digest. It is permitting: it
  makes that version's requirements the ones that apply.

List the catalog, then activate each version with the digest the list shows:

<!-- drill: profile-list -->
```bash
curl -sS -o "$WORK/profiles.json" -w '%{http_code}\n' -H "$OBSERVER" http://127.0.0.1:8787/api/admin/governance-profiles
```

Read `profiles[].profileId`, `version`, `digest` and `state` in
`$WORK/profiles.json` (a new deployment shows every version as `draft`), then
for each one to promote:

<!-- ref: the drill sets these from the listing it just saved, as the steward reads them -->
```bash
export PROFILE_ID=deploy-staging PROFILE_VERSION=1 PROFILE_DIGEST='sha256:…from the listing…'
```

<!-- drill: profile-activate -->
```bash
curl -sS -w '\n%{http_code}\n' -X POST -H "$STEWARD" -H 'Content-Type: application/json' \
  -d "{\"digest\":\"$PROFILE_DIGEST\",\"reason\":\"pilot go-live\"}" \
  "http://127.0.0.1:8787/api/admin/governance-profiles/$PROFILE_ID/versions/$PROFILE_VERSION/activate"
```

A digest that is not the version's current content is refused
(`PROFILE_DIGEST_MISMATCH`); nothing changes. Typed parameter bounds (§7) are
accepted only on parameters an **active** profile governs, so promote before
assigning authority.

## 6. Agent onboarding

By a `provisioner`. An agent is a Kernel-Authority actor bound to the
identity its own runtime presents (`externalSubject`), with an operator-issued
credential and, separately, standing authority (§7). Set the agent's values:

<!-- ref: the drill sets these for the agent it onboards -->
```bash
export OWNER_ID=actor-release-owner OWNER_NAME='Release owner' AGENT_ID=actor-release-agent AGENT_NAME='Release agent' AGENT_SYSTEM=pilot-ci AGENT_SUBJECT=release-agent-1
```

The human (or team) on whose behalf the agent acts, once:

<!-- drill: agent-owner -->
```bash
curl -sS -w '\n%{http_code}\n' -X POST -H "$PROVISIONER" -H 'Content-Type: application/json' --data-binary @- \
  http://127.0.0.1:8787/api/admin/authority/entities/actor <<EOF
{"actorId":"$OWNER_ID","type":"human","displayName":"$OWNER_NAME","issuerId":"$ORG_ISSUER","trustDomainId":"$TRUST_DOMAIN","idempotencyKey":"onboard-$OWNER_ID"}
EOF
```

The agent:

<!-- drill: agent-actor -->
```bash
curl -sS -w '\n%{http_code}\n' -X POST -H "$PROVISIONER" -H 'Content-Type: application/json' --data-binary @- \
  http://127.0.0.1:8787/api/admin/authority/entities/actor <<EOF
{"actorId":"$AGENT_ID","type":"agent","displayName":"$AGENT_NAME","issuerId":"$ORG_ISSUER","trustDomainId":"$TRUST_DOMAIN","externalSubject":{"system":"$AGENT_SYSTEM","subjectId":"$AGENT_SUBJECT"},"idempotencyKey":"onboard-$AGENT_ID"}
EOF
```

### 6.1 Credential issuance and one-time delivery

The agent's credential is generated by the Host and **revealed exactly once**,
in the response that issues it; the Host keeps only a verifier. Write that
response straight into your private directory, never to the terminal:

<!-- drill: agent-credential -->
```bash
( umask 077 && mkdir -p "$SECRET_DIR" && curl -sS -o "$SECRET_DIR/$AGENT_ID.issued.json" -w '%{http_code}\n' -X POST -H "$PROVISIONER" -H 'Content-Type: application/json' \
  -d "{\"idempotencyKey\":\"credential-$AGENT_ID-1\"}" "http://127.0.0.1:8787/api/admin/agents/$AGENT_ID/credentials" )
```

Turn it into the header file the agent's runtime presents, and delete the
response:

<!-- drill: agent-credential-deliver -->
```bash
( umask 077 && sed -n 's/.*"bearerCredential":"\([^"]*\)".*/Authorization: Bearer \1/p' "$SECRET_DIR/$AGENT_ID.issued.json" > "$SECRET_DIR/$AGENT_ID.header" ) &&
  [ -s "$SECRET_DIR/$AGENT_ID.header" ] && rm -f "$SECRET_DIR/$AGENT_ID.issued.json" &&
  echo "credential header ready for delivery: $SECRET_DIR/$AGENT_ID.header (mode 600)"
```

Deliver `$SECRET_DIR/$AGENT_ID.header` to the agent owner through your secret
channel (the agent's runtime sends it as its `Authorization` header), then
delete your copy. The value must never appear in a log, ticket, chat,
screenshot, backup or evidence file.

- **Lost before delivery?** It cannot be shown again: an issue request with the
  same key answers `"outcome":"replayed"` with `"bearerCredential": null`.
  Rotate (§11.2) to get a new one.
- **Exposed?** Revoke it (§11.2) — a SEV-1 if the agent holds production
  authority (INCIDENT_TRIAGE.md).

Check the onboarding state (an agent with a credential and no authority yet
is admitted and then denied — nothing reaches the target):

<!-- drill: agent-inspect -->
```bash
curl -sS -w '\n%{http_code}\n' -H "$OBSERVER" "http://127.0.0.1:8787/api/admin/agents/$AGENT_ID"
```

## 7. Bounded authority

Authority is Kernel Authority, provisioned over this same API: the owner
holds a standing grant over the actions and resources, with **bounds**, and
delegates it to the agent; the agent also gets a passport and a capability
token. The bounds here are the reference use case's typed parameters —
`replicaCount` at most 3, `deploymentStrategy` exactly `rolling`. For a
monetary action, the bounds are P10 constraints instead (a per-execution
`max_amount` and an aggregate `spending_limit`; both are required, see
`docs/enterprise/AOC_AUTHORITY_ADMINISTRATION_API.md` §10.4).

<!-- ref: the drill sets these for the authority it assigns -->
```bash
export GRANT_ID=authority-release-owner DELEGATION_ID=delegation-release-agent RESOURCES='"staging-cluster","production-cluster"'
export BOUNDS='[{"dimension":"replicaCount","kind":"maximum","type":"integer","limit":3},{"dimension":"deploymentStrategy","kind":"exact","type":"token","value":"rolling"}]'
```

<!-- drill: authority-owner-grant -->
```bash
curl -sS -w '\n%{http_code}\n' -X POST -H "$PROVISIONER" -H 'Content-Type: application/json' --data-binary @- \
  http://127.0.0.1:8787/api/admin/authority/entities/authority-grant <<EOF
{"authorityGrantId":"$GRANT_ID","issuerActorId":"$ORG_ISSUER","subjectActorId":"$OWNER_ID","trustDomainId":"$TRUST_DOMAIN","capability":"release.manage","actions":["deploy-release"],"resourceScopes":[$RESOURCES],"canDelegate":true,"allowedDelegateActorTypes":["agent"],"maxDelegationDepth":1,"parameterBounds":$BOUNDS,"idempotencyKey":"grant-$GRANT_ID"}
EOF
```

<!-- drill: authority-passport -->
```bash
curl -sS -w '\n%{http_code}\n' -X POST -H "$PROVISIONER" -H 'Content-Type: application/json' --data-binary @- \
  http://127.0.0.1:8787/api/admin/authority/entities/passport <<EOF
{"passportId":"passport-$AGENT_ID","type":"agent_passport","subjectActorId":"$AGENT_ID","issuerActorId":"$ORG_ISSUER","trustDomainId":"$TRUST_DOMAIN","idempotencyKey":"passport-$AGENT_ID"}
EOF
```

<!-- drill: authority-capability -->
```bash
curl -sS -w '\n%{http_code}\n' -X POST -H "$PROVISIONER" -H 'Content-Type: application/json' --data-binary @- \
  http://127.0.0.1:8787/api/admin/authority/entities/capability-token <<EOF
{"capabilityTokenId":"capability-$AGENT_ID","subjectActorId":"$AGENT_ID","principalActorId":"$OWNER_ID","issuerActorId":"$OWNER_ID","trustDomainId":"$TRUST_DOMAIN","capability":"release.execute","actions":["deploy-release"],"resourceScopes":[$RESOURCES],"riskLevel":"medium","idempotencyKey":"capability-$AGENT_ID"}
EOF
```

<!-- drill: authority-delegation -->
```bash
curl -sS -w '\n%{http_code}\n' -X POST -H "$PROVISIONER" -H 'Content-Type: application/json' --data-binary @- \
  http://127.0.0.1:8787/api/admin/authority/entities/delegation-grant <<EOF
{"delegationGrantId":"$DELEGATION_ID","delegatorActorId":"$OWNER_ID","delegateActorId":"$AGENT_ID","delegateActorType":"agent","trustDomainId":"$TRUST_DOMAIN","sourceAuthorityGrantId":"$GRANT_ID","capability":"release.execute","actions":["deploy-release"],"resourceScopes":[$RESOURCES],"canRedelegate":false,"parameterBounds":$BOUNDS,"idempotencyKey":"delegation-$DELEGATION_ID"}
EOF
```

A delegation must restate every bound of its source, equal or narrower; a
bound on a parameter no active profile governs is refused (`409`,
`PARAMETER_BOUND_*`) rather than stored as if it constrained something. The
agent's onboarding view (§6, `agent-inspect`) now shows
`"standingAuthority":"assigned"`. **Never provision authority without bounds**
for a pilot agent: the readiness gate fails an agent whose active lineage
carries neither P10 constraints nor typed bounds (`PR-11 AUTHORITY_UNBOUNDED`).

## 8. Human approval

### 8.1 Approver standing

An operator's `approver` role lets them reach the approval commands; whether
their verdict **counts** is decided by Kernel Authority. Give the approver a
human actor whose id is their canonical operator identity,
`operator:<operatorId>`, and a grant for the profile's approver action over
the resources they may approve — never for the governed action itself:

<!-- ref: the drill sets these for its approver -->
```bash
export APPROVER_OPERATOR_ID=ops-approver APPROVER_ACTION=approve-deploy APPROVAL_RESOURCES='"production-cluster"'
```

<!-- drill: approver-actor -->
```bash
curl -sS -w '\n%{http_code}\n' -X POST -H "$PROVISIONER" -H 'Content-Type: application/json' --data-binary @- \
  http://127.0.0.1:8787/api/admin/authority/entities/actor <<EOF
{"actorId":"operator:$APPROVER_OPERATOR_ID","type":"human","displayName":"Approver $APPROVER_OPERATOR_ID","issuerId":"$ORG_ISSUER","trustDomainId":"$TRUST_DOMAIN","idempotencyKey":"approver-actor-$APPROVER_OPERATOR_ID"}
EOF
```

<!-- drill: approver-standing -->
```bash
curl -sS -w '\n%{http_code}\n' -X POST -H "$PROVISIONER" -H 'Content-Type: application/json' --data-binary @- \
  http://127.0.0.1:8787/api/admin/authority/entities/authority-grant <<EOF
{"authorityGrantId":"approval-standing-$APPROVER_OPERATOR_ID","issuerActorId":"$ORG_ISSUER","subjectActorId":"operator:$APPROVER_OPERATOR_ID","trustDomainId":"$TRUST_DOMAIN","capability":"$APPROVER_ACTION.standing","actions":["$APPROVER_ACTION"],"resourceScopes":[$APPROVAL_RESOURCES],"canDelegate":false,"allowedDelegateActorTypes":["human"],"maxDelegationDepth":0,"idempotencyKey":"approval-standing-$APPROVER_OPERATOR_ID"}
EOF
```

### 8.2 Deciding an approval

A request under a profile `approvalPolicy` names answers the agent
`"status":"withheld","withheldBy":"approval"`; nothing reaches the target.
The approver finds it in the inbox (it lists `requestId`, `actorId`, `action`,
`resourceScope` and `approvalRequestId`):

<!-- drill: approval-inbox -->
```bash
curl -sS -o "$WORK/approvals.json" -w '%{http_code}\n' -H "$APPROVER" 'http://127.0.0.1:8787/api/admin/approvals?view=pending'
```

Then reads the one request — its exact canonical subject, the requirement and
the digest a verdict must cite:

<!-- ref: the drill sets these from the inbox it just saved, as the approver reads them -->
```bash
export APPROVAL_ID='approval-request:…from the inbox…'
```

<!-- drill: approval-detail -->
```bash
curl -sS -o "$WORK/approval.json" -w '%{http_code}\n' -H "$APPROVER" "http://127.0.0.1:8787/api/admin/approvals/$APPROVAL_ID"
```

Review `canonicalSubject` (what will be executed, with which parameters, for
whom) and `requirement`; take `subjectDigest` from the same response, then
decide:

<!-- ref: the drill sets this from the detail it just saved -->
```bash
export SUBJECT_DIGEST='sha256:…from the detail…'
```

<!-- drill: approval-approve -->
```bash
curl -sS -w '\n%{http_code}\n' -X POST -H "$APPROVER" -H 'Content-Type: application/json' \
  -d "{\"subjectDigest\":\"$SUBJECT_DIGEST\",\"reason\":\"reviewed: within the change window\"}" \
  "http://127.0.0.1:8787/api/admin/approvals/$APPROVAL_ID/approve"
```

or, to refuse it for good:

<!-- drill: approval-reject -->
```bash
curl -sS -w '\n%{http_code}\n' -X POST -H "$APPROVER" -H 'Content-Type: application/json' \
  -d "{\"subjectDigest\":\"$SUBJECT_DIGEST\",\"reason\":\"rejected: outside the change window\"}" \
  "http://127.0.0.1:8787/api/admin/approvals/$APPROVAL_ID/reject"
```

An approval is not an execution: the response says
`"outcome":"recorded"` and the quorum, and the agent's runtime then submits
its **same request with the same idempotency key** (§9), which resumes that
one decision — once. A rejection is final for that request. The verdict counts
only with live standing (`409 APPROVAL_APPROVER_INELIGIBLE` otherwise), the
requester cannot approve itself, the same approver never counts twice, and a
stale subject is refused (`APPROVAL_SUBJECT_MISMATCH`). The other verbs and
every refusal are in `docs/enterprise/AOC_AUTHORITY_ADMINISTRATION_API.md`
§12. The web console's **Approvals** section does the same, one confirmation
page per verdict (§14).

## 9. The agent's governed request

The agent's runtime — not an operator — calls the governed-action API with its
own credential. For the reference use case:

<!-- ref: the drill sets these for each request its agent makes -->
```bash
export RESOURCE=staging-cluster REPLICAS=2 STRATEGY=rolling REQUEST_KEY=release-2026-10-13-1
```

<!-- drill: agent-request -->
```bash
curl -sS -w '\n%{http_code}\n' -X POST -H @"$SECRET_DIR/$AGENT_ID.header" -H 'Content-Type: application/json' --data-binary @- \
  http://127.0.0.1:8787/api/governed-actions <<EOF
{"action":"deploy-release","resource":"$RESOURCE","parameters":{"replicaCount":$REPLICAS,"deploymentStrategy":"$STRATEGY"},"idempotencyKey":"$REQUEST_KEY"}
EOF
```

`200` with `"status":"executed"` means the target was called once and
answered. `denied`, `withheld` (by `authority-binding`, `approval`,
`emergency-control`, …) mean nothing was sent. `execution_unconfirmed` means
the target may or may not have acted: **never send the request again, and never
ask the target to act again** — an operator establishes the real outcome with
the target and records it (OPERATIONS_RUNBOOK.md §10); the agent's same
request then answers from that record. The idempotency key identifies one
intended action: the same key never causes a second effect, and a new action
always takes a new key.

## 10. Activity and evidence

Any operator can read what was decided and executed:

<!-- drill: evidence-activity -->
```bash
curl -sS -w '\n%{http_code}\n' -H "$OBSERVER" 'http://127.0.0.1:8787/api/admin/activity/decisions?limit=25'
```

and one request's full authority-to-outcome trace (the request id is in the
agent's response and in the activity list):

<!-- ref: the drill sets this from the agent's own response -->
```bash
export REQUEST_ID='aoc.gar:…from the response…'
```

<!-- drill: evidence-trace -->
```bash
curl -sS -o "$WORK/trace-$(printf %s "$REQUEST_ID" | tr ':' '-').json" -w '%{http_code}\n' -H "$OBSERVER" "http://127.0.0.1:8787/api/admin/operations/traces/$REQUEST_ID?level=AUDITOR"
```

An **auditor** who should hold no operator credential at all can be given an
organization-scoped evidence key (`AOC_ENTERPRISE_API_KEYS=<key>:<organization id>`
in `.env`, generated with `witness-init --secrets-only`): it reads
`GET /api/evidence/traces/{requestId}` and verifies it with
`GET /api/evidence/traces/{requestId}/verify` (`"verified": true`, checks by
category), and it can neither reach `/api/admin/...` nor act. Verification is
integrity and correlation; authenticity only where an artifact is signed
(`docs/security/ASSURE-01-UNIFIED-AUTHORITY-OUTCOME-TRACE.md`).

## 11. Revocation, rotation and agent offboarding

### 11.1 Revoking authority

A `responder` (or provisioner, or administrator) revokes the agent's
delegation; the next request is denied and reaches nothing:

<!-- drill: revoke-delegation -->
```bash
curl -sS -w '\n%{http_code}\n' -X POST -H "$RESPONDER" -H 'Content-Type: application/json' \
  -d '{"reason":"authority withdrawn"}' \
  "http://127.0.0.1:8787/api/admin/authority/entities/delegation-grant/$DELEGATION_ID/revoke"
```

Revocation is terminal: there is no un-revoke. It does not cancel a call
already under way; to stop everything at once, declare an emergency stop
(OPERATIONS_RUNBOOK.md §12), which does not depend on the witness or the
signer.

### 11.2 Rotating or revoking a credential

<!-- ref: the drill sets this from the agent inventory -->
```bash
export CREDENTIAL_ID='agc-…from GET /api/admin/agents/$AGENT_ID…'
```

Rotate — the new value replaces the old, which stops working at once, and is
revealed once, like issuance:

<!-- drill: credential-rotate -->
```bash
( umask 077 && mkdir -p "$SECRET_DIR" && curl -sS -o "$SECRET_DIR/$AGENT_ID.issued.json" -w '%{http_code}\n' -X POST -H "$PROVISIONER" -H 'Content-Type: application/json' \
  -d "{\"idempotencyKey\":\"rotate-$AGENT_ID-$CREDENTIAL_ID\"}" "http://127.0.0.1:8787/api/admin/agents/$AGENT_ID/credentials/$CREDENTIAL_ID/rotate" )
```

then deliver it exactly as in §6.1 (`agent-credential-deliver`). Revoke —
terminal; the agent cannot authenticate with it again:

<!-- drill: credential-revoke -->
```bash
curl -sS -w '\n%{http_code}\n' -X POST -H "$PROVISIONER" -H 'Content-Type: application/json' \
  -d '{"reason":"credential offboarded"}' \
  "http://127.0.0.1:8787/api/admin/agents/$AGENT_ID/credentials/$CREDENTIAL_ID/revoke"
```

### 11.3 Offboarding an agent, and restoring authority after a revocation

Offboarding revokes the agent's actor — every credential bound to it stops
admitting it:

<!-- drill: agent-offboard -->
```bash
curl -sS -w '\n%{http_code}\n' -X POST -H "$RESPONDER" -H 'Content-Type: application/json' \
  -d '{"reason":"agent offboarded"}' \
  "http://127.0.0.1:8787/api/admin/authority/entities/actor/$AGENT_ID/revoke"
```

**Restoring an agent's authority after a revocation: onboard it again as a new
identity** (§6 and §7 with a new `AGENT_ID`, `AGENT_SUBJECT` and delegation
id) after offboarding the old one. Do not add a replacement delegation to the
revoked agent: a revoked grant still takes part in the deterministic selection
of the agent's authority lineage, and a replacement whose id sorts after it is
never used — the agent stays denied
(`AUTHORITY_CAPABILITY_REVOKED`), with nothing sent. This fails closed, never
open; it is a known limit (SECURITY_POSTURE.md §9), qualified by the drill.

## 12. Pilot readiness

When the organization, its profiles, an agent that holds both an active
credential and bounded standing authority (the same agent), a backup that
covers every store this deployment requires, a qualified restore of it and
the **pilot owner's** acknowledgement exist, the readiness gate reaches
`pilot-ready`. How to run it with the
evidence, what each check means and how the qualification record works:
OPERATIONS_RUNBOOK.md §9.1 and PILOT_READINESS.md §5.

## 13. Pilot offboarding

In this order — nothing is deleted until the evidence is kept:

1. **Stop new effects**: an emergency stop at the scope you are leaving
   (`global` for the whole pilot) — OPERATIONS_RUNBOOK.md §12.
2. **Revoke every agent's authority and identity**: §11.1, then §11.3 for each
   agent (`GET /api/admin/agents` lists them; every one must read `revoked`).
3. **Revoke or rotate every agent credential** still active (§11.2), and
   remove the agents' header files from every runtime.
4. **Take the final evidence export**: every request's trace (§10) into a
   private directory kept with the pilot's records.
5. **Take the final backup** (OPERATIONS_RUNBOOK.md §5) and keep it under the
   pilot's retention policy.
6. **Remove operator access**: delete the operators from `operators[]` and
   their variables (§3), and revoke approver standing (§8.1 grants).
7. **Disable the target's credential for the adapter** at the target system:
   Frontera cannot do this for you.
8. **Stop the deployment**: `docker compose stop` (OPERATIONS_RUNBOOK.md §3).
   Never `docker compose down -v`: it deletes the evidence and the witness.

The readiness gate then reports the organization level still ready and the
pilot level not ready (`PR-10 NO_PILOT_AGENT`) — the expected end state.

## 14. The web control plane

The console is a separate process operating the Host through this same
operator API; it holds no store or key. The pilot image does not contain it:
run it from the same release's checkout on an operator machine with Node.js 22:

<!-- ref: needs a checkout with npm ci and a build; the drill runs the same launcher (scripts/run-control-plane-web.mjs) against its Host -->
```bash
npm ci && npm run build
FRONTERA_CONSOLE_HOST_URL=https://frontera.internal.example \
FRONTERA_CONSOLE_HTTP_PORT=8788 \
npm run start:control-plane
```

Operators sign in with their own operator credential (held only in the
console's server memory for the session). **Agents** lists the inventory and
onboarding stages; **Authority** shows grants, delegations and bounds;
**Approvals** is the inbox with one confirmation per verdict; **Activity** and
**Evidence** show the Host's own records. Every operation is authorized again
by the Host: the console's buttons are a convenience, not a permission.
Configuration (bind address, public origin, session lifetimes) is in
`docs/enterprise/AOC_AUTHORITY_ADMINISTRATION_API.md` §11.2; put TLS in front of
it as you do for the Host.
