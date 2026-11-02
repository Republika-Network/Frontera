# [DRAFT C] Evidence Submission Guidelines

> **DRAFT.** For customers of the Founding Assessment. Subject to privacy
> review. Not for use with real customers while the launch gate is NO-GO.

## Before you send anything

- The **Authorization to Assess** (Draft E) is signed.
- You are entitled to share each item with Republika for this assessment.
- You have **minimized** each item to what the control needs.

## What to send

For each control SV-01 … SV-10, the evidence described in its requirement
(listed in your engagement pack). For example:

- the policy in force with its version history, plus a sample of decisions
  taken under it (SV-03);
- configuration exports showing isolation settings, **with secrets removed** (SV-06);
- redacted log extracts showing a revocation taking effect (SV-08).

For each item, tell us:

| Field | Example |
| --- | --- |
| Which control(s) it supports | SV-03 |
| What it shows and why it is relevant | "Policy v4 and 20 decisions sampled from March" |
| Its identifier and version | `POL-ACCESS-v4` |
| When it was produced | 2026-10-01 |
| Who in your organization can vouch for it (a **role**, not a name) | "Head of IAM" |

We record a **digest** (fingerprint) of each file. If you later send a
different version, it is a different item.

## What never to send

- **Passwords, API keys, tokens, private keys, certificates with keys, or any
  credential** — not even expired ones. If one arrives, we delete it and tell you.
- **Special-category personal data** (health, biometrics, religion, …),
  **payment-card data**, government identifiers.
- Personal data of individuals beyond what a control needs. **Pseudonymize
  actors** in samples ("user-0042", not a name or email).
- Production database exports, full mailboxes, backups.
- Executables, scripts or macros.
- Anything you are not entitled to share (for example a supplier's
  confidential document without its consent).

## Conflicting evidence

If two items disagree (for example two versions of the same policy), tell us
which is authoritative. A control with unresolved contradictory evidence is
never concluded. We may need to restart the attempt with the authoritative
item.

## Missing evidence

If you cannot provide evidence for a control, that control is reported as
**UNKNOWN — evidence gap**. It is not a failure, but it scores zero.

## How to send

[Channel to be decided under D-05: an encrypted transfer to the engagement
repository, or a customer-hosted review session where you keep the files.]
Do not send evidence by ordinary email.
