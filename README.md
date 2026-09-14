# Soberanía Enterprise

Sovereign infrastructure for enterprise AI agents, programmable consent, scoped machine access, policy enforcement, and audit trails.

---

## Overview

Soberanía Enterprise is the enterprise orchestration layer built on top of Soberanía Protocol.

It enables organizations to:

- Govern AI agents
- Enforce programmable consent
- Control scoped machine access
- Apply policy runtime enforcement
- Maintain enterprise auditability
- Integrate sovereign trust infrastructure into existing systems

---

## Architecture Layers

```txt
Applications
    ↓
Soberanía Enterprise
    ↓
Soberanía Protocol
    ↓
Storage / Identity / Blockchain / AI Systems
```

---

## v1.0.0 Release Documentation

| Topic | Document |
|---|---|
| Frozen HTTP API surface & versioning policy | `docs/enterprise/API_STABILITY_V1.md` |
| Security invariants (canonical: scope, enforcement, boundary) | `docs/security/SECURITY_INVARIANTS.md` |
| No-bypass execution (canonical: effect-path inventory, what authorizes each effect) | `docs/security/NO_BYPASS_AUTHORITY_CONTROLLED_EXECUTION.md` |
| Trust boundaries & privileged assets (canonical) | `docs/security/TRUST_BOUNDARIES_AND_PRIVILEGED_ASSETS.md` |
| Authoritative grant store (canonical: bounded-grant persistence, durability, integrity) | `docs/security/AUTHORITATIVE_GRANT_STORE.md` |
| Threat model | `docs/security/THREAT_MODEL_V1.md` |
| Agent Passport Web threat model | `docs/security/AGENT_PASSPORT_WEB_THREAT_MODEL.md` |
| Security hardening report | `docs/security/SECURITY_HARDENING_V1.md` |
| Deployment guide | `docs/operations/DEPLOYMENT_GUIDE_V1.md` |
| Operational runbooks | `docs/operations/RUNBOOKS_V1.md` |
| Backup & recovery (RPO/RTO) | `docs/operations/BACKUP_RECOVERY_V1.md` |
| Automated backup command (`backup:v1`) | `docs/operations/AOC_ENTERPRISE_BACKUP_V1.md` |
| Automated restore command (`restore:v1`) | `docs/operations/AOC_ENTERPRISE_RESTORE_V1.md` |
| Clean-room portability drill (`validate:portability:v1`) | `docs/operations/AOC_ENTERPRISE_CLEAN_ROOM_DRILL.md` |
| Store schema & migration review | `docs/enterprise/MIGRATION_REVIEW_V1.md` |
| Test strategy | `docs/testing/TEST_STRATEGY_V1.md` |
| Performance baseline | `docs/performance/BENCHMARK_BASELINE_V1.md` |
| Load test report | `docs/performance/LOAD_TEST_V1.md` |
| Dependency audit | `docs/release/DEPENDENCY_AUDIT_V1.md` |
| Release candidate summary | `docs/release/RELEASE_CANDIDATE_V1.md` |
| Portability discovery (Phase 0) | `docs/release/AOC_ENTERPRISE_V1_PORTABILITY_CURRENT_STATE.md` |
| Portability, backup, restore & clean-room drill report | `docs/release/AOC_ENTERPRISE_V1_PORTABILITY_REPORT.md` |
| v1.0.0 tagging runbook | `docs/release/AOC_ENTERPRISE_V1_TAGGING_RUNBOOK.md` |
| Changelog | `CHANGELOG.md` |
| Release manifest | `release/RELEASE_MANIFEST.json` (regenerate via `node scripts/generate-release-manifest.mjs`) |

## Quick start

```bash
npm ci
npm run build
npm test                  # full suite: compiled root tests + contract suites + workspaces
npm run start:enterprise  # boots the Enterprise Host (see the deployment guide for configuration)
```

Client SDK: `packages/enterprise-host-sdk` (`@aoc-enterprise/enterprise-host-sdk`).

### Technical namespace

Soberanía Enterprise preserves the existing `aoc` and `aoc-enterprise` technical
namespaces for compatibility. Package names, API identifiers, schemas, protocol
identifiers, serialized values, and public code symbols using those namespaces
remain unchanged unless explicitly versioned otherwise.

---

## License and ownership

Soberanía Enterprise is proprietary software. Copyright © 2026 Onchainfest LLC.
All Rights Reserved. Commercial use requires a written agreement. See
`LICENSE` and `NOTICE.md`. Soberanía Protocol has a separate legal and
licensing regime — see `docs/legal/PROTOCOL_ENTERPRISE_BOUNDARY.md`.
