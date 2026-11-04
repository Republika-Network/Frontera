# RN-CONFORM-06 — Target Architecture (pilot first, production later)

**PROPOSED design only.** Nothing here is built or authorized. It reuses the components of
[SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md) (D1–D7, TB-1..TB-7) and the patterns already in the repository;
it introduces no new trust model.

## 1. Today (as implemented)

All of D1–D6 run in one process, in-memory keys, synthetic humans, in-process validator transport, SQLite stores
with `synthetic = 1` interlocks, no listener except a loopback-only, token-gated status test server, no ledger
calls. D7 is a `prepared`-only anchor intent. See [readiness assessment](RN_CONFORM_06_READINESS_ASSESSMENT.md) §4.

## 2. Design principles for any non-synthetic step

1. **Interlocks are replaced by designations, not removed.** A `PILOT` designation (non-commercial,
   non-credentialing by default) joins `SYNTHETIC`; nothing becomes `PRODUCTION` without a separate founder decision.
2. **Authority stays where it is today.** The conformance store remains the authoritative trust boundary for
   operator eligibility, evidence and transitions; the federation store remains an operational view.
3. **Keys leave the process before anything leaves the building.** Every signing key moves behind the existing
   CORE-02 external-signer protocol before any external party sees an artefact signed by it.
4. **No public ingress for the coordinator or validators.** Only signed artefacts leave; the coordinator is never
   internet-reachable (closes the exposure precondition of RN-05 P2-3).
5. **Every artefact carries its limits**: designation, `corroboration: single-operator | multi-operator`, environment,
   authorization reference, and an explicit "not a certification" statement.

## 3. Pilot architecture (Level 2, recommended)

```
 Republika private network (no public ingress)                               Design partner (staging)
 ┌───────────────────────────────────────────────────────────────┐           ┌───────────────────────────┐
 │ Coordinator + registry + engine + lifecycle  (D1–D5)          │           │ Partner PEP / staging app │
 │   conformance store /4 (PILOT designation, authorizations)    │           │  (partner-owned, FV-P5-   │
 │   federation store (rollback pin persisted externally)        │           │   equivalent enforcement) │
 │        │  signed challenge envelopes (CORE-07-style transport) │           └────────────▲──────────────┘
 │        ▼                                                      │                        │ allowlisted,
 │ Validator runtime(s) — Republika operator, separate processes │── authorized probes ──┘ authorization-
 │   ObservationSigner → external signer                         │   (staging only,         bound, rotating
 │                                                               │    CC-D-12 window)       principals
 │ External signer process (CORE-02 protocol; KMS-backed key     │
 │   for coordinator, registry, report signing; journal outside  │
 │   the restore domain)                                         │
 │ AUTH-03 passkey approvals for two-person actions              │
 │ Backup (store registry entries) · alerting on federation      │
 │   events · scheduled syncFromConformance                      │
 └───────────────────────────────┬───────────────────────────────┘
                                 │ signed pilot evidence report (private delivery, no public status)
                                 ▼
                         Partner security team
```

Key properties:
- **Scope:** one partner, one integration version, its staging endpoints only, under a signed, scoped, time-boxed
  testing authorization (CC-D-12) stored in the conformance store and enforced by the coordinator and evidence
  acceptance (closes RN-05 P2-3 at the authoritative boundary).
- **No credential.** No credential record is created; the deliverable is a signed **pilot evidence report**
  (coverage matrix, findings, limits, and a signed non-claim: not a certification, staging ≠ production). No ACTIVE
  status, no stapled assertions, no public status endpoint.
- **Segmentation and egress.** The validator egress segment is isolated from the coordinator and signer segments;
  the executor refuses redirects, pins DNS, refuses private/loopback addresses after resolution and caps response
  size and time. Network code lives in a separate package/process; the conformance module stays network-free.
- **Custody.** The KMS-backed CORE-02 signer service is new work (the reference service is not a KMS); report keys
  are generated in a recorded ceremony and delivered to the partner out of band.
- **Single operator, labelled.** Republika validators only; every report and record says `single-operator`.
- **Probe hardening.** Principals and request shapes rotate per authorization window to reduce the
  recognisable-probe limit (RN-04 P2-3); the limit is still disclosed in the report.
- **No XRPL.** Anchoring is out of pilot scope (RN-03X P2-3 open).
- **No production data.** Staging data only; data handling under the pilot agreement (CC-D-13 informs disclosure).

## 4. Production delta (Levels 3–4, after the pilot)

| Area | Pilot | Production delta |
|---|---|---|
| Operators | Republika only | ≥ 2 contracted, verified independent operators (CC-D-02), onboarding programme, conflict-of-interest exclusion |
| Custody | External signer process, KMS-backed | HSM-backed issuer and registry keys; rotation and compromise runbooks; per-operator custody attestations |
| Transport | Private network, signed envelopes | Authenticated cross-organization transport, endpoint allowlists in each operator domain, abuse controls |
| Status | Private report | Public minimal status (CC-D-13), production rate limiting, authenticated verifier distribution of issuer keys |
| Credential | None activated | ACTIVE credentials under CC-D-05 terms and CC-D-15 contracts, multi-operator corroboration only |
| Anchoring | None | XRPL Testnet first (ADR-009 §17 gates, P2-3 closed, F-2..F-6), then a separate decision; Mainnet needs a new ADR |
| Assurance | — | Never dependent on `rn.sv` commercial authorization (CC-D-08); Founding Assessment NO-GO is a separate track |
| Evidence integrity | Rollback pins persisted externally | Independent anchoring of history heads; signed acceptance receipts (RN-02 P3-F) |
| Review | Scoped external human review | Accredited external audit, recurring |

## 5. Trust boundaries that change in the pilot

- **TB-1 (platform ↔ validators)** becomes real: partner staging endpoints, authorization-bound and allowlisted.
- **TB-4 (status-signing key)** moves to the external signer; in the pilot it signs reports, not public status.
- **TB-5 (human decisions)** moves to AUTH-03 passkeys.
- **TB-2 (operators distinct)** is explicitly *not* satisfied in the pilot and is disclosed as such.
- **TB-6 (public read-only)** and **TB-7 (anchoring)** stay closed.
