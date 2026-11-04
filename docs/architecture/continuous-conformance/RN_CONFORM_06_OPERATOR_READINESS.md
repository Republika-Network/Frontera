# RN-CONFORM-06 — Validator Operator Readiness

## 1. Current state

| Item | State | Evidence |
|---|---|---|
| Mechanism (operator registry, two-person approval, authoritative status in the conformance store, one vote per operator, PoP key generations, quarantine, requalification, revocation) | IMPLEMENTED · SYNTHETIC PROOF | [RN_CONFORM_05_IMPLEMENTATION.md](RN_CONFORM_05_IMPLEMENTATION.md) §5–§15, remediation sections |
| Operators | Republika-controlled synthetic labels only (`SYNTHETIC-FEDERATION-NON-PRODUCTION`, `independenceVerification: NOT_VERIFIED`) | RN-05 §4; DECISION_REGISTER.md:50–61 |
| Independent operators contracted | **None** | — |
| Operator agreement, liability, conflict-of-interest, eligibility/identity verification | **Not defined** | CC-D-02 open items |
| Validator transport, custody, deployment | Not implemented (in-process only) | [security gaps](RN_CONFORM_06_SECURITY_GAPS.md) G-04, G-07 |

**Fundamental limit (unchanged):** multiple processes, keys or validator ids do not prove multiple independent
organizations; independence is administrative. Collusion of k genuinely separate operators defeats corroboration
(THREAT_MODEL T03) — a governance and contract control, not a technical one.

## 2. CC-D-02 — what remains to decide

Per [DECISION_REGISTER.md](DECISION_REGISTER.md):50–61, still OPEN for production: operator agreement model;
eligibility and identity verification; conflict-of-interest policy; legal responsibility; liability allocation;
operating geography; minimum operational security; financial and commercial terms. The register's own
recommendation is "Republika + ≥ 1 contracted independent operator before any non-synthetic ACTIVE".

## 3. Readiness by level

| Level | Operator requirement | Ready? |
|---|---|---|
| L0/L1 | Synthetic operators, clearly labelled | **Yes** |
| L2 pilot (recommended config) | **Republika as the only operator**, all results labelled `single-operator`; **no ACTIVE credential** (VALIDATOR_PROTOCOL.md:15–17: a single-operator result cannot activate a credential outside synthetic demonstrations) | Mechanism yes; operational prerequisites in [roadmap](RN_CONFORM_06_IMPLEMENTATION_ROADMAP.md) P1 |
| L3 public network | ≥ 2 contracted, verified independent operators; onboarding programme; transport; custody | **No** |
| L4 commercial | L3 plus liability, insurance, appeal process, audited operations | **No** |

## 4. Onboarding prerequisites for the first independent operator (L3)

From RN-05 §27, made concrete:
1. Founder approval of CC-D-02 (agreement model, eligibility criteria, conflict-of-interest policy, liability).
2. A signed operator agreement (scope, data handling, confidentiality, termination, liability, no token/reward).
3. Legal-entity identity verification producing a verification record other than `NOT_VERIFIED` — this needs a new,
   reviewed field value and process; it must never be self-asserted.
4. Conflict-of-interest declaration against every credentialed platform; recusal rules enforced by assignment
   exclusion. **NOT IMPLEMENTED:** the scheduler supports excluding operators per job, but there is no
   conflict-of-interest record or automatic exclusion in `federation-*.ts`.
5. Operational-security attestation (key custody in the operator's own domain, patching, access control, incident
   contact).
6. Key ceremony with proof of possession (implemented) on a key the operator generated in its own custody.
7. Two-person registry approval (implemented) — by Republika network humans with AUTH-03 passkeys (not yet).
8. Probation: a bounded series of requalification-style challenges against a credential-free fixture before any vote
   counts (mechanism implemented for reinstatement; extend to onboarding).
9. Authenticated transport and endpoint allowlisting in the operator's environment (not implemented).

## 5. Conflicts of interest and collusion — controls to design (not implemented)

- Assignment exclusion of operators with a declared relationship to the platform under test.
- Random, unpredictable assignment among eligible operators (CSPRNG source already injected).
- Statistical divergence monitoring between operators (THREAT_MODEL T03 suggests outlier detection).
- Contractual audit rights and termination; two-person reinstatement review of operator histories.
- Public disclosure of the operator set and its independence basis (CC-D-13 privacy decision interacts).

## 6. Recommendation

Do **not** pursue independent operators for the first design partner. Run the pilot single-operator and
non-credentialing, and use it to produce the operational evidence (custody, transport, DR, monitoring) that an
independent operator would later need to inherit. Start CC-D-02 legal drafting in parallel so Level 3 is not blocked
on paperwork when the technical prerequisites land.
