# Pilot Acceptance (PROD-03-04)

What a pilot organization proves before a Frontera pilot is accepted, the
evidence that proves it, and how the acceptance status is decided. No payment
rail is required for any criterion.

## 1. Acceptance criteria

Each criterion is proven on the pilot's own deployment, by the means listed.
"Qualified" means the release's acceptance qualification (§4) proves the
mechanism on a reference deployment; the pilot still demonstrates it on its
own.

| # | Criterion | Proven by | Qualified by |
| --- | --- | --- | --- |
| A1 | Reproducible deployment: the image is built from the approved release and identifies it | startup runbook steps 1–2; image label = approved commit | O1, O6 (and PROD-03-03 D1, D5) |
| A2 | Valid configuration check | `config-check` → `RESULT: PASS` | O1 |
| A3 | Readiness | `/live` and `/ready` 200; every required module healthy | O1, O7 |
| A4 | Version identity | `/version` `commit` = approved commit, `build: release` | O6 |
| A5 | Normal governed-action flow | an authorized action from a pilot agent is granted and executed against the pilot's provider; its trace verifies | O12 (the decision path: the qualification's provider is unreachable by design) |
| A6 | Deny / withhold behaviour | an unauthorized action is denied; an action on a stopped resource is withheld | O12 |
| A7 | Emergency control behaviour | a stop is activated, withholds, is released; evidence recorded | O12 |
| A8 | Operator visibility | an observer reads metrics, executions, Attention, traces, health | O7, O10 |
| A9 | Unresolved execution handling | operators walk the resolution runbook; an administrator records a resolution (on a real unresolved execution if one occurs, otherwise in a rehearsal environment) | O10, O11 |
| A10 | Durable restart | state is identical across a restart and a container re-creation | O3 |
| A11 | Backup | a cold backup is created and verified | O4 |
| A12 | Restore | a backup is restored; the Host is ready with the expected records | O5 |
| A13 | Shutdown | a normal shutdown exits 0 after `shutdown_complete`; volumes kept | O2 |
| A14 | Upgrade boundary understood | the pilot owner has read OPERATIONS_RUNBOOK.md §7 and its stop conditions | O14 (documentation), manual |
| A15 | Rollback boundary understood | the pilot owner acknowledges: no schema downgrade; rollback across a schema change = previous release + its backup | O14, manual |
| A16 | Responsibility matrix acknowledged | SHARED_RESPONSIBILITY.md accepted with named owners | manual |
| A17 | Known limits acknowledged | README.md §"Known limits of the pilot" acknowledged | manual |

A5 and A9 depend on the pilot's provider: a qualification run cannot reach a
real provider, so it proves the decision path and the operator-plane
mechanics, and the pilot proves the end-to-end flow with its own provider.

## 2. Acceptance status

| Status | Condition |
| --- | --- |
| **ACCEPTED** | A1–A17 all proven, the acceptance qualification passed for the release, no open deviation |
| **ACCEPTED WITH DOCUMENTED LIMITATIONS** | A1–A13 and A16–A17 proven; any deviation is documented, bounded and accepted in writing by the pilot owner (for example A9 rehearsed rather than exercised on a real unresolved execution, or a degradation of an optional module accepted at go-live) |
| **NOT ACCEPTED** | anything else |

A pilot is never ACCEPTED — with or without limitations — when any of these
holds; no written acceptance overrides them:

- `/ready` is not 200;
- a required module is unhealthy;
- storage is not durable (state on a container layer or `tmpfs`, or a restart
  loses records);
- the release identity is unknown (`build: development`, empty image label)
  or inconsistent with the approved release;
- the configuration check fails;
- backup or restore was never tested;
- the governance flow (A5, A6) was never exercised.

## 3. Acceptance evidence pack

One record per pilot, stored where both parties can retrieve it, with the
access control of backups. It contains **no secret**: no credential, key,
`.env` content, `docker inspect` or `docker compose config` output.

The automatable part is produced by the acceptance qualification
(`--evidence <file>`, §4) or assembled by hand from the evidence bundle
(INCIDENT_TRIAGE.md §3). The human part is filled in by the people named; the
qualification never fills it
and leaves `status` empty.

```json
{
  "schema": "frontera.pilot-acceptance-evidence.v1",
  "pilotOrganization": "<organization name>",
  "organizationId": "<AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID>",
  "environment": "<environment identifier, e.g. pilot-eu-1>",
  "date": "<UTC date>",
  "release": {
    "version": "<from /version>",
    "release": "<from /version>",
    "commit": "<from /version>",
    "build": "release",
    "api": "<api.surface and api.endpointCount from /version>",
    "runtimeVersions": "<runtimeVersions from /version>"
  },
  "configCheck": "PASS",
  "readiness": { "live": 200, "ready": 200 },
  "health": { "status": "healthy", "degradedModules": [] },
  "cases": [
    { "id": "A1", "result": "pass | fail | not-run", "evidence": "<file or reference>", "by": "<operator id or name>" }
  ],
  "backup": { "backupId": "<from the backup report>", "verified": true },
  "restore": { "result": "restored", "backupId": "<restored backupId>", "readyAfterRestore": true },
  "restart": { "statePreserved": true },
  "operatorResolution": { "result": "<recorded | rehearsed | not-applicable>", "requestId": "<if any>" },
  "deviations": [ { "criterion": "<A-number>", "description": "<what>", "acceptedBy": "<name>" } ],
  "approvals": { "pilotOwner": "<name>", "fronteraContact": "<name>" },
  "status": "ACCEPTED | ACCEPTED WITH DOCUMENTED LIMITATIONS | NOT ACCEPTED"
}
```

Attach: the evidence bundle captured at go-live and after the restore test,
the backup verification output, and the qualification output for the
release.

## 4. Acceptance qualification

```text
node scripts/deploy/qualify-pilot-acceptance.mjs (--commit <40-hex> | --from-commit <ref>) [--host-build] [--evidence <file>] [--keep]
```

(CI job `pilot-acceptance`.) It exports exactly the named commit
(`git archive`, never the working tree, so the identity it records is the
code it ran), builds the image and starts the kit in its own Compose project
— and then **executes the command blocks of
[`OPERATIONS_RUNBOOK.md`](OPERATIONS_RUNBOOK.md) and
[`INCIDENT_TRIAGE.md`](INCIDENT_TRIAGE.md) as written** (only the published
port, the project name and the image tag are substituted), checking each
result. Blocks run as an operator's interactive shell runs them, without
`set -e`: their own `&&` chains and failure messages are what is qualified.
A documented command that does not work fails the qualification.

| Case | Proven |
| --- | --- |
| O1 | documented startup: identity, configuration check, volumes, start, `/live`, `/ready`, health, version — the Host is ready |
| O2 | documented shutdown: every service exits 0, `shutdown_complete` logged, both volumes kept |
| O3 | documented restart (service restart and full stop/start): operational state identical |
| O4 | documented backup: a cold backup streamed out, checksums verified, manifest complete, source commit = the release; the archive and the witness archive are mode 600; the archive's checksum file is portable |
| O5 | the restore block refuses while the Host runs and changes nothing; documented restore, after state changed and into a replaced state volume: the Host is ready, the backed-up records are present, the later ones are not |
| O6 | `/version` matches the approved commit and the image label |
| O7 | `/live`, `/ready` and `/health` are distinguishable as documented, and the operator health view adds operations |
| O8 | the witness stopped after startup (documented witness backup): `degraded`, still live and ready; recovers |
| O9 | a required dependency down at boot: refused, never ready (`refused to start`) |
| O10 | documented resolution commands: Attention and inspection answer; a resolution of an executed action is refused (`EXECUTION_OUTCOME_ALREADY_DEFINITIVE`); the withheld one is not resolvable (shown `resolvable: false`, outside Attention, and refused — `409 EXECUTION_NOT_RESOLVABLE` or, withheld before preparation, `404 EXECUTION_NOT_FOUND`, as PROD-03-02's R8); an unknown one `404`; an observer `403` — nothing recorded; with `--host-build`, the PROD-03-02 in-process suite (R1–R8, capacity) passes |
| O11 | capacity reconciliation and Attention are surfaced as documented (operations health `unresolvedExecutions`, `scan`); with `--host-build`, the pending → adjusted path passes in-process |
| O12 | documented emergency control: activate → the resource is withheld → release → no longer withheld; an unauthorized action is denied |
| O13 | the evidence bundle and every output contain no secret, and the bundle identifies the release |
| O14 | the documents promise no schema downgrade and keep `down -v` out of every command |
| O15 | the deployment and the documents require no payment rail |

The upgrade and rollback blocks are executed with the same release as both
"previous" and "new" (no second release exists inside one commit): this
proves the commands and the identity checks, not a cross-release migration.
A claimed execution with no outcome cannot be produced inside a container
without a provider on a public address; that path is qualified in-process by
`src/enterprise/__tests__/prod0302-operator-resolution-host.test.ts`.

The qualification fills only the automatable fields of the evidence pack; it
never records a human acknowledgement (A14–A17) and marks them `not-run`.
