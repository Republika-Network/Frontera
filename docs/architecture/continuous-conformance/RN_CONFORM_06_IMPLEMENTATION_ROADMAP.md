# RN-CONFORM-06 — Implementation Roadmap (minimum safe path to the first design partner)

**Proposed, not authorized.** Each initiative is a separate mission and PR, each needs its own founder
authorization. Effort: S ≈ ≤ 1 engineer-week, M ≈ 1–3, L ≈ 3–6 (estimates, not commitments). Gaps referenced as
G-xx are in [RN_CONFORM_06_SECURITY_GAPS.md](RN_CONFORM_06_SECURITY_GAPS.md).

**Objective:** the smallest set of changes that makes the [recommended pilot](RN_CONFORM_06_PRODUCTION_ARCHITECTURE.md)
§3 safe. Independent operators, public status, anchoring and commercial terms are deliberately **not** on the
critical path.

## P0 — before external technical exposure (Level 1)

| Id | Initiative | Repo | Closes | Acceptance criteria | Effort | PR boundary |
|---|---|---|---|---|---|---|
| P0-01 | **Dossier accuracy**: update the continuous-conformance README (implemented status, RN-04/05 index, "synthetic operators" qualifier), XRPL_ANCHORING.md (salted commitment per ADR-009, current pin), record ADR-009's CC-D-06 adoption *as implementation architecture only* in DECISION_REGISTER.md | Frontera (docs) | G-23, G-27 (README) | Every statement matches the merged code; no status of any CC-D changes except recording the founder's ADR-009 decision verbatim | S | one docs PR |
| P0-02 | **Claims and disclosure pack** for synthetic demos: allowed / prohibited statements, mandatory slide disclaimers, demo-report labelling, **third-party brand use** (no Fileverse participation, authorization or endorsement); resolve the "certification" wording collision (Provider Conformance Suite, `'certified'` governance level) by a documented naming rule | Frontera (docs; legal review) | G-26 | Legal review recorded; every external deck/demo references the pack; no "certified", "independent validator" or "Fileverse conformant" wording | S | one docs PR (+ separate code PR only if a public enum is renamed) |

## P1 — before an authorized external pilot (Level 2)

**Boundary rule for every P1 item:** network code (transport, executor) lives in a **separate package or process**
(CC-D-09: a validator package under `packages/`), never in `src/enterprise/conformance/`; the module's
`conformance-structure.test.ts` network ban is **kept, not relaxed** — it is the evidence behind the P2-3
deferral. Each item is its own mission and one PR (code, tests and its runbook together, per MVP plan §4).

| Id | Initiative | Repo | Closes | Acceptance criteria | Effort |
|---|---|---|---|---|---|
| P1-01 | **Authoritative testing authorization** in the conformance store (schema `/4`): authorizations recorded with two-person approval; coordinator refuses issuance outside an authorization's window, scope or operator rules; evidence acceptance refuses observations for challenges without a valid authorization; **immediate revocation** of an authorization (in-flight jobs cancelled, deliveries and observations refused); **per-authorization probe rate and volume caps**; lifecycle reservation of requalification integrations | Frontera `src/enterprise/conformance` | G-01, G-02, G-33 | Direct `coordinator.issue` outside authorization refused; revoked authorization stops all work at once; caps enforced; probation evidence can never be counted by any credential (regressions); explicit `/3` → `/4` migration verified on a historical-code-generated fixture as for `/2` → `/3` | M |
| P1-02 | **PILOT designation** alongside the `synthetic` interlock (store, federation, runtime, report contracts); `AuthorizedEndpoint{url, environment: 'staging', authorizationRef}`; `corroboration` label on every artefact; PILOT can never produce ACTIVE; **no credential record is created in the pilot** (avoids candidate expiry semantics) | Frontera | G-16, G-27 (label) | PILOT cannot transition to ACTIVE (trigger + test); environment `production` still refused; synthetic tests unchanged | M–L |
| P1-03 | **Key custody**: coordinator, registry, **report** and validator signers behind the CORE-02 external-signer protocol (`src/enterprise/external-authority-signer/`) with a **KMS-backed signer service — new work** (the reference service is explicitly "not an HSM, a KMS"; needs a KMS vendor / subprocessor decision and possibly new CORE-02 signing purposes); custody branding prevents software keys in a PILOT composition; documented **key ceremony**; rotation and compromise runbooks; status signers only if the report signer reuses them | Frontera (+ infra) | G-03, G-04, G-06, G-37 | No private key in the conformance process in a PILOT composition (structure test); ceremony and rotation drill recorded | L |
| P1-04 | **AUTH-03 human approvals** for all two-person conformance actions | Frontera | G-05 | Synthetic directory refused in PILOT compositions; 120 s decision lifetime; UV required | M |
| P1-05 | **Private authenticated validator transport** (separate package/process): signed request/response envelopes (CORE-07 / executor-receipt pattern); replay protection by challenge nonce and envelope id; coordinator has no ingress from outside the private network; **validator segment isolated from the coordinator and signer segments** | Frontera `packages/` | G-07, G-08, G-30 | Negative tests: replay, wrong key, expired or revoked authorization; deployment check that the coordinator is unreachable from public interfaces and from the validator egress segment | M–L |
| P1-06 | **Operations**: conformance stores in the backup registry with correct domains (signer journal and rollback pins never restored into the same domain; pins persisted externally); restore drill; alerting on federation events; scheduled `syncFromConformance`; incident runbook; **evidence retention and destruction policy** compatible with append-only stores | Frontera | G-10..G-13, G-32 (retention) | Recorded restore drill with rollback detection; alert tests; retention policy reviewed by legal | M |
| P1-07 | **Partner executor** (separate package): calls only allowlisted partner staging endpoints with **SSRF defences** — redirects refused, DNS resolved once and pinned, private/loopback/link-local addresses refused after resolution (anti-rebinding), response size and time caps, no credential forwarding; rotating probe principals per authorization; partner-issued probe principals held as secrets (never logged, rotated, revocable) | Frontera `packages/` (+ partner-side PEP, owned by the partner) | G-15, G-16, G-17 (mitigation), G-30 | Negative tests for redirect, rebinding to a private address, oversize/slow responses, unlisted host; recognisable-probe limit disclosed in the report | M |
| P1-08 | **Pilot agreement**: written, scoped, time-boxed testing authorization (CC-D-12, generalized to the chosen partner) naming owner, environment, data, contacts and stop conditions; **no fee** (any fee is a separate CC-D-15 decision — a fee makes the pilot commercial); **no public or marketing use of the report and no representation as certification or conformance**, with Republika's right to terminate and disclaim; **findings handling** (notification path, embargo, encrypted transfer, storage, retention, destruction); personal data in staging responses; legal entity of both parties; insurance check | Legal / founder | G-24, G-25, G-32, G-36 | Signed by both parties; stored as the authorization record of P1-01 | — |
| P1-09 | **External human security review** of the **complete** pilot composition (after P1-07, P1-10, P1-11, P1-12; an earlier design review is optional) covering custody, transport, egress, authorization boundary and environment | external | G-29 (pilot scope) | Report with no open critical/high finding in scope — the L2 security dependency | — |
| P1-10 | **Pilot evidence report**: signed, private, labelled PILOT + `single-operator`; the signed payload itself contains the non-claim statement (not a certification, not a conformance statement, staging ≠ production per THREAT_MODEL T07, recognisable-probe and cadence limits); report key delivered to the partner authentically (out of band, fingerprint confirmed) | Frontera | G-34, G-36 | Report verifiable offline by the partner; contains no protected content; the non-claim cannot be stripped without breaking the signature | S |
| P1-11 | **Pilot conformance profile**: a new pinned, digest-frozen profile with two-person approval for the partner's declared operations, explicit exclusions, CR-10/CR-11 marked not covered, real SDK identity (depends on CC-D-10) | Frontera `src/enterprise/conformance/profile.ts` | G-35 | Profile pinned; existing pins unchanged; coverage matrix generated from it | S–M |
| P1-12 | **Pilot environment baseline**: hardened host(s), encryption at rest for every store, privileged-access control and logging (who can reach the stores — raw-writer residuals), log retention, pinned dependencies including native `better-sqlite3`, build provenance for the deployment artefact | Frontera (docs + deploy config) + infra | G-31, G-37 | Preflight check analogous to the Founding Assessment's OPS-02 engagement-host check; included in P1-09 scope | M |

**Critical path:** P0-01 → P1-01 → P1-02 → (P1-03 ∥ P1-04 ∥ P1-05 ∥ P1-06 ∥ P1-11 ∥ P1-12) → P1-07 → P1-10 → P1-09,
with P1-08 (legal) started immediately. Indicative total: roughly 16–26 engineer-weeks plus legal, KMS-vendor and
partner lead time.

## P2 — before production / commercial activation (Levels 3–4)

| Id | Initiative | Repo | Closes |
|---|---|---|---|
| P2-01 | Independent operator programme (CC-D-02): agreements, verification, conflict-of-interest exclusion, probation, divergence monitoring | Frontera + legal | G-28 (partly), operator readiness §4 |
| P2-02 | HSM-backed issuer/registry keys and per-operator custody attestations | Frontera + infra | G-06 |
| P2-03 | Cross-organization authenticated transport and abuse controls | Frontera | G-08, G-30 |
| P2-04 | ACTIVE credentials for multi-operator results only, under CC-D-05 terms | Frontera | — |
| P2-05 | Public minimal status (CC-D-13), production rate limiting, issuer-key distribution | Frontera | G-09 |
| P2-06 | Measured SLOs and capacity testing | Frontera + ops | G-14 |
| P2-07 | Independent deployment attestation for G08; unpredictable test environments; CR-10/CR-11 coverage | Frontera | G-17, G-18, G-19 |
| P2-08 | XRPL Testnet anchoring: close RN-03X P2-3, F-1 (Frontera golden-vector test against `anchor-intent.ts`), F-2..F-6, Frontera confirmed-anchor schema and salt custody, separate founder GO per transaction | xrpl-sovereign-access + Frontera (separate PRs) | G-20, G-21, G-22 |
| P2-09 | Accredited external audit; commercial terms (CC-D-15), insurance, appeal process | external / legal | G-24, G-29 |

## P3 — scalability and enhancements

Open validator network beyond contracted operators; batching scheduler and anchoring SLOs; EVM adapter (CC-D-16);
multi-region stores; statistical collusion detection; signed acceptance receipts (RN-02 P3-F); CC-D-14 registry fixes;
sparse-array canonicalization fix (RN-02 F-1).

## Explicitly not on the path

$SOBE, staking, slashing, rewards (out of scope permanently, DECISION_REGISTER.md:77–83); Mainnet; changing the
Founding Assessment NO-GO (separate Assurance track, CC-D-08).
