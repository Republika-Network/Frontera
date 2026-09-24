# Durable Kernel Authority (Frontera)

> **Applications do not provision themselves during evaluation.**
>
> This is the load-bearing rule of this document. Everything below exists to
> make it a structural property rather than a convention.

The **Kernel Authority Runtime** is Frontera's durable, operator-provisioned
recognition and authority world — the state `AocKernel.evaluate()` decides
against. It closes the gap where Frontera had a real decision engine but no
durable, independently provisioned source of the facts that engine needs.

- Package: `@aoc-enterprise/runtime`
- Public subpath: `@aoc-enterprise/runtime/enterprise`
- Runtime version: `AOC_KERNEL_AUTHORITY_RUNTIME_VERSION`
- Store schema: `aoc.kernel-authority.schema.v1`
- Architecture decision record: [`ADR-DURABLE-KERNEL-AUTHORITY.md`](../architecture/ADR-DURABLE-KERNEL-AUTHORITY.md)

---

## 1. What this is

```text
Operator / Enterprise Authority Administration
                    |
                    v          (provisioning path -- privileged, write)
        Kernel Authority Store (durable, SQLite)
                    |
                    |  hydration: a pure projection, rebuilt from the store
                    v
      Recognition Runtime  +  Authority Graph
                    |
                    v
             RecognitionProvider
                    |
                    v          (evaluation path -- read-only)
              AocKernel.evaluate()
                    |
               allow / deny
                    |
                    v
             External application
```

The store holds seven kinds of operator-provisioned fact, and nothing else:

| Entity kind        | What it records                                               |
| ------------------ | ------------------------------------------------------------- |
| `actor`            | A recognized human, organization, agent, system or external actor, optionally bound to an external application principal |
| `trust-domain`     | The enforcement boundary: which issuers and actor types it accepts |
| `passport`         | An actor's identity credential within a trust domain          |
| `capability-token` | What actions an actor may take, on what resource scopes       |
| `root-issuer`      | Which actor may originate authority in a trust domain         |
| `authority-grant`  | Authority issued to an actor, and whether it may be delegated |
| `delegation-grant` | Authority delegated onward, within the source grant's limits  |

Each was proven necessary by executing the real engine: remove any one of them
and the canonical ALLOW becomes a denial. That measurement is asserted in
`src/enterprise/__tests__/durable-kernel-authority.test.ts`.

## 2. What this is **not**

- **Not a decision engine.** Nothing in this layer evaluates a request,
  interprets a policy, or produces an allow/deny. `AocKernel` decides; this
  layer supplies facts. There is no error code here that means "denied".
- **Not the Governance Store.** That store is the durable record of
  evaluations that already happened. A log of past decisions cannot answer
  "may this actor act now?" without re-deciding, which is exactly what it must
  not do. Authority source-of-truth lives in its own store, its own file, and
  its own schema.
- **Not the Governed Authority Store** (`src/enterprise/authority-governance/`).
  That answers "does this holder control this much of this *right* of this
  resource?" — fractional economic and ownership interests. Different question,
  different failure modes, deliberately not merged. See the ADR.
- **Not a PMFreak component.** Nothing here imports an application, its role
  vocabulary, or its database types. PMFreak is the first consumer, not the
  design constraint.

## 3. Configuration

| Variable | Default | Meaning |
| -------- | ------- | ------- |
| `AOC_ENTERPRISE_KERNEL_AUTHORITY_ENABLED` | `false` | Restore the Kernel's world from the authority store instead of composing an empty one |
| `AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID` | `default` | The organization this deployment decides for |
| `AOC_ENTERPRISE_KERNEL_AUTHORITY_SQLITE_PATH` | `.data/kernel-authority.sqlite` | Store path when `AOC_ENTERPRISE_PERSISTENCE_PROVIDER=sqlite` |
| `AOC_ENTERPRISE_KERNEL_AUTHORITY_REQUIRED` | `true` | An authority-source outage makes the Host not-ready |

`REQUIRED` defaults to `true`, unlike its Passport and Assurance siblings. Those
degrade gracefully because a deployment can still evaluate governance without
them. This one cannot: a Host that answers out of a world it can no longer
verify is not degraded, it is wrong.

**Turning this on allows nothing by itself.** An enabled-but-empty authority
source denies every request with `RECOGNITION_ACTOR_UNKNOWN`, exactly as an
unconfigured deployment does.

## 4. How operators provision

Provisioning is a **trusted operator surface**. Hand it to a bootstrap script, a
CLI, or an authenticated administrative route — never to the code path that
serves evaluations.

```ts
import {
  createSqliteKernelAuthorityStore,
  createKernelAuthorityProvisioningService,
} from '@aoc-enterprise/runtime/enterprise';

const store = await createSqliteKernelAuthorityStore('.data/kernel-authority.sqlite');
const operator = createKernelAuthorityProvisioningService({ store, organizationId: 'org-acme' });

// `system: true` plus a named operator. Every write demands both.
const OPERATOR = { system: true, actorId: 'operator-acme-admin' };

await operator.provisionActor(OPERATOR, { actorId: 'actor-org-acme', type: 'organization', displayName: 'Acme' });
await operator.provisionTrustDomain(OPERATOR, {
  trustDomainId: 'trust-domain-acme',
  name: 'Acme',
  issuerActorId: 'actor-org-acme',
  acceptedIssuerIds: ['actor-org-acme'],
  acceptedActorTypes: ['human', 'organization', 'agent'],
});
// ...actors, passport, capability token, root issuer, authority grant, delegation grant.
```

A deployment that composes through `createEnterprise()` gets the same service on
`enterprise.kernelAuthorityProvisioning`, already scoped to the configured
organization and already wired to re-hydrate the live world after each write.

### Monetary authority (P10)

An authority grant, and a delegation grant, may carry **monetary authority**:
a per-execution ceiling and durable aggregate spending limits, in canonical
decimal text.

```ts
await operator.provisionAuthorityGrant(OPERATOR, {
  // ...the grant's identity, issuer, subject, capability, actions, scopes...
  constraints: [
    { type: 'max_amount', currency: 'USD', value: '100' },
    { type: 'spending_limit', limitId: 'lifetime', currency: 'USD', maximum: '1000', window: { kind: 'lifetime' } },
    { type: 'spending_limit', limitId: 'daily', currency: 'USD', maximum: '500', window: { kind: 'rolling', seconds: 86400 } },
  ],
});
```

These constraints follow the same record lifecycle as the rest of the payload:

- They live in the event payload, so the event digest and chain cover them.
- They are validated on every append, whichever surface wrote them, and again
  on every hydration.
- They replay into the Authority Graph unchanged.
- A malformed one fails the world closed rather than hydrating.

Two rules differ from ordinary fields:

- **Scale.** An asset's scale is never stated here. It comes from the
  deployment's `monetary.assets` registry, which the composition root hands to
  this provisioning service, so an unknown asset or excess precision is refused
  at provisioning.
- **Changing a limit.** Constraints on a live record cannot be edited. Revoke
  the record and provision a new id.

Consumption is never stored here; it lives in the P7 exercise-control ledger.
Governed financial actions resolve this authority on the decision's own
lineage; see `docs/architecture/ADR-AUTHORITY-SOURCED-PAYMENT-CEILINGS.md`.

### Idempotent retries

Provisioning is safe to retry:

- Re-provisioning an entity id **with identical terms** replays: the original
  record comes back and no second event is appended.
- Re-provisioning it **with different terms** is a
  `KERNEL_AUTHORITY_ENTITY_CONFLICT`. Authority is changed by revoking and
  provisioning a new id, never by rewriting a record in place.
- An `idempotencyKey` reused with a **different payload** is a
  `KERNEL_AUTHORITY_IDEMPOTENCY_CONFLICT`, never a second grant.
- A revoked entity id is **terminal**: re-provisioning it is
  `KERNEL_AUTHORITY_ENTITY_REVOKED`, so no retry ordering can resurrect
  withdrawn authority.

## 5. How applications evaluate

The application opens the store, restores the world, and asks. It never imports
the provisioning service and never holds an operator context.

```ts
import { createSqliteKernelAuthorityStore, createDurableKernelProviders } from '@aoc-enterprise/runtime/enterprise';
import { createAocKernel } from '@aoc-enterprise/runtime/kernel';

// Returns a DurableKernelDecisionService: a provider that answers, a clock,
// an id generator, the store, and reload(). It deliberately carries no
// Recognition/Authority runtime handles -- see "The evaluation surface" below.
const store = await createSqliteKernelAuthorityStore('.data/kernel-authority.sqlite');
const providers = await createDurableKernelProviders({ store, organizationId: 'org-acme' });
const kernel = createAocKernel({
  recognitionProvider: providers.recognitionProvider,
  clock: providers.clock,
  idGenerator: providers.idGenerator,
});

const decision = await kernel.evaluate({
  requestId: 'req-1',
  actor: { id: 'actor-agent-1', principalId: 'actor-alice', trustDomainId: 'trust-domain-acme', type: 'agent' },
  action: { type: 'execute.material-action', resourceScope: 'resource-project-1' },
  organization: { id: 'org-acme' },
  requestedAt: new Date().toISOString(),
});
// decision.status === 'allowed' | 'denied' | ...
```

`organization` is **required**. An omitted organization is not read as an
implicit match for the configured one: two organizations may legitimately use
the same actor ids, so "unstated" and "this one" are different claims and only
one is safe to act on. It also matters upstream — organization-scoped API keys
reject a *mismatch*, so treating absence as a match would let a caller skip
that check by simply not naming an organization. The value is taken from the
typed `organization` field only; a `context.organizationId` supplied in the
free-form bag is stripped before evaluation and can never establish scope.

The application does **not** supply passport or capability-token ids. Frontera
resolves the credentials this actor durably holds, subject-bound to that actor
in that trust domain, preferring one that is neither revoked nor expired at
evaluation time, and the unmodified policy chain re-verifies every one of them.
A caller that already knows the ids may still pass them in `context`.

### The evaluation surface

`createDurableKernelProviders()` returns a `DurableKernelDecisionService`, and
what it leaves out is the point: it carries **no** Recognition, Authority,
Approval or Handshake runtime handles. Those are concrete mutable engines whose
public methods include `registerActor`, `issuePassport`, `issueCapabilityToken`,
`registerRootIssuer` and `issueAuthorityGrant`. Handing them to a consumer
alongside a provider would let an application mint itself an actor and a
covering token in the live world, name them in its request, and be allowed —
without an operator context and without the store recording anything. The
handles stay private to the composition that builds the world.

### Binding an external principal

An application's own user id is not a Frontera actor id, and assuming it is
would be inventing identity semantics. The binding is explicit and Frontera
owns it:

```ts
await operator.provisionActor(OPERATOR, {
  actorId: 'actor-alice',
  type: 'human',
  displayName: 'Alice',
  issuerId: 'actor-org-acme',
  trustDomainId: 'trust-domain-acme',
  externalSubject: { system: 'example-app', subjectId: 'external-user-42' },
});

const actor = await operator.findActorByExternalSubject(READ_CONTEXT, { system: 'example-app', subjectId: 'external-user-42' });
```

`(organizationId, system, subjectId)` is unique. The same external subject id
in another organization resolves to a different actor and leaks nothing. The
downstream application keeps no authority mapping table of its own.

## 6. Restart guarantees

| Scenario                 | Before restart | After restart |
| ------------------------ | -------------: | ------------: |
| Valid authority          |          ALLOW |         ALLOW |
| Wrong action             |           DENY |          DENY |
| Wrong resource           |           DENY |          DENY |
| Unknown actor            |           DENY |          DENY |
| Revoked authority        |           DENY |          DENY |
| Cross-organization       |           DENY |          DENY |

Proven three ways, at increasing distance: in-process reopen
(`durable-kernel-authority.test.ts`), separate OS processes
(`tests/durable-authority-process-restart.contract.test.mjs`), and a clean-room
consumer installing the packed `.tgz`
(`npm run check:clean-room-consumer`). The restart is real in all three — no
provider instance, runtime instance, or module-level map is shared.

### Propagation across processes

The hydrated world is a projection of the store, rebuilt whenever the store
changes **through this process**. The supported v1 model is a single writer:

- Provisioning through `createEnterprise()`'s service re-hydrates the live
  world after every committed write, so decisions reflect it immediately.
- A **different** process provisioning against the same file is not observed
  until this process calls `DurableKernelProviderSet.reload()` or restarts.

This is stated rather than papered over. A world that silently lagged its store
would be exactly the kind of thing this layer must not claim to be.

## 7. Revocation

Revoke through the operator surface, naming a reason:

```ts
await operator.revoke(OPERATOR, { entityKind: 'capability-token', entityId: 'cap-agent-1', reason: 'rotated out' });
```

Revocation is terminal and durable. It takes effect in the running process and
in every process that starts afterwards, and survives backup/restore. Actors,
passports, capability tokens, authority grants and delegation grants are all
revocable.

Trust domains and root issuers are deliberately **not** revocable. Revoking
either would leave every credential inside that boundary replayed as live while
the boundary vanished — a *widening* of what the remaining state appears to
mean. Retire a trust domain by revoking the authority inside it, so every
denial names the credential it actually failed on.

## 8. Organization isolation

Two scoping dimensions, and they are not the same thing:

- **Trust domain** is the Kernel's own enforcement boundary. Passports and
  capability tokens must match the request's trust domain; cross-domain
  authority is closed by default.
- **Organization** is the administrative/tenancy boundary. It owns records,
  scopes reads, and decides which world a decision service holds.

One provider set serves exactly one organization. A request naming a different
organization is denied with `RECOGNITION_ORGANIZATION_SCOPE_VIOLATION` rather
than answered out of the wrong world — which matters because two organizations
may legitimately use the same actor ids.

## 9. Fail-closed behaviour

| Condition | Behaviour |
| --------- | --------- |
| Store empty | Every request denied (`RECOGNITION_ACTOR_UNKNOWN`) |
| Organization not stated on a request | Denied (`RECOGNITION_ORGANIZATION_SCOPE_REQUIRED`) |
| Required store unavailable | `createEnterprise()` raises; **never** substituted with an empty in-memory store |
| *Optional* store unavailable (`REQUIRED=false`) | Host starts, module reports unhealthy, Kernel evaluates against the empty fail-closed world — so every request denies |
| Persisted event altered in place | `KERNEL_AUTHORITY_INTEGRITY_FAILED` — digests are recomputed from the event's own fields, never trusted as stored |
| Events lost from the *end* of a chain | `KERNEL_AUTHORITY_INTEGRITY_FAILED` — the reconstructed head is cross-checked against the independently recorded one, so a lost revocation cannot read back as live |
| Store unhealthy at runtime | Module unhealthy; Host not-ready when `REQUIRED=true` |
| Foreign schema version | Store refused at open, and left byte-for-byte untouched |
| Malformed persisted payload | `KERNEL_AUTHORITY_INTEGRITY_FAILED` — never skipped |
| Broken/gapped event chain | `KERNEL_AUTHORITY_INTEGRITY_FAILED` — a dropped revocation must never read as active |
| Unknown entity kind persisted | `KERNEL_AUTHORITY_INTEGRITY_FAILED` — refuse rather than hydrate a partial world |
| Record the engine cannot replay | Startup fails — a world missing records is not a narrower world, it is an unknown one |

No condition in this table produces an ALLOW, and none silently discards
authority state and continues.

Operational failures use `KernelAuthorityError` codes. They are deliberately
**not** governance denials: an infrastructure outage never masquerades as a
policy outcome, and no new Kernel reason code was invented for persistence.

## 10. Backup and restore

The Kernel Authority Store is part of the standard store set:

```bash
npm run backup:v1  -- --output ./backup
npm run restore:v1 -- --backup ./backup --target ./restored
```

It is included in `backup:v1`, `restore:v1`, `check:portability-smoke` and the
clean-room drill **whenever durable authority is enabled**, and there its
inclusion is not optional the way an audit store's would be: a recovery that
restored evaluation history but not the authority world would come back with
every actor unrecognized and every action denied.

A deployment that has *not* enabled durable authority has no such database and
never will, so backup does not ask for one. Requiring it unconditionally would
break every previously-working `backup:v1` invocation on upgrade, and the usual
remedy ("start the Host once, it creates an empty store") cannot help for a
feature that is switched off.

`tests/durable-authority-portability.contract.test.mjs` destroys the original
store outright, restores from the backup alone, and asserts that a legitimate
ALLOW returns, a revocation stays revoked, and the external principal binding
survives.

## 11. Audit trail

Every provisioning action is an immutable, digest-chained event answering:
who provisioned it, what object changed, what authority scope changed, when,
which prior state it superseded (`previousEventDigest`), and whether it was
revoked.

```ts
const events = await operator.listEvents(OPERATOR, 'capability-token', 'cap-agent-1');
```

Historical authority records are never rewritten. The SQLite
`kernel_authority_records` table is a reconstructable projection cache, not a
second source of truth: every read replays the canonical event chain.

## 12. Test and development ergonomics

`createInMemoryKernelAuthorityStore()` is rule-for-rule identical to the SQLite
implementation and is the right choice for unit tests, fixtures and local
demos. It is **not durable**: everything it holds dies with the process, health
reports `durable: false`, and it is never substituted for a configured SQLite
store on failure.

## 13. Public API

All on `@aoc-enterprise/runtime/enterprise`:

| Export | Purpose |
| ------ | ------- |
| `createSqliteKernelAuthorityStore` | Open/create the durable authority source |
| `createInMemoryKernelAuthorityStore` | Non-durable equivalent for tests and demos |
| `createKernelAuthorityProvisioningService` | **Trusted operator** write surface |
| `createDurableKernelProviders` | Restore a world and return the read-only `DurableKernelDecisionService` |
| `hydrateKernelAuthorityWorld` | The pure records-to-world projection |
| `createDurableRecognitionProvider` | The read-only bridge onto the Kernel's port |
| `KernelAuthorityError` / `isKernelAuthorityError` | Operational error taxonomy |
| `KERNEL_AUTHORITY_SCHEMA_VERSION`, `AOC_KERNEL_AUTHORITY_RUNTIME_VERSION` | Version identities |

`createDefaultKernelProviders()` is unchanged and remains valid: a deployment
that has not adopted durable authority keeps its real, empty, fail-closed world
exactly as before.
