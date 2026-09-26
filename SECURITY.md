# Security Policy

> STATUS: DRAFT — PENDING PROFESSIONAL LEGAL REVIEW.
> This document states the founder-designated initial vulnerability
> reporting channel. It is a governance draft, not legal advice, and has
> not been reviewed by counsel.

## Scope

This policy covers vulnerability reporting for Frontera Systems, the
proprietary software in this repository. It does not cover Soberanía Protocol,
which is a separate repository with its own security policy (see
`docs/legal/PROTOCOL_ENTERPRISE_BOUNDARY.md` for the boundary between
the two projects). If a vulnerability spans both, report it to Soberanía
Enterprise's channel below and it will be routed appropriately.

## Reporting a vulnerability

Security vulnerabilities affecting Frontera Systems must be reported
privately to:

```text
vicvalch@onchainfest.xyz
```

Subject prefix:

```text
[SECURITY REPORT]
```

This email address is the canonical reporting channel. Where GitHub
Private Vulnerability Reporting is enabled for this repository, it may
also be used to submit a report; the email address above remains the
canonical channel regardless.

- **Primary security owner:** Víctor Valverde.
- **Backup security owner:** not yet designated. The absence of a backup
  owner is a pending operational improvement, not a reason to treat the
  channel above as unavailable or invalid.

## Do not open public vulnerability issues

Do not report a suspected vulnerability through any public channel,
including:

- public GitHub issues;
- public GitHub Discussions;
- social media;
- public chat rooms or community channels.

Publicly disclosing an unpatched vulnerability before it has been
triaged and addressed puts users and deployments at risk. Use the email
channel above (or GitHub Private Vulnerability Reporting, where enabled)
instead.

## Response targets

The following are operational targets, not guarantees and not
contractual SLAs:

- human acknowledgment within 2 business days;
- initial triage within 5 business days;
- periodic updates during active investigation;
- coordinated remediation and disclosure.

These targets describe current operational intent. They do not create a
warranty or service-level commitment beyond what is stated in a separate
Commercial Agreement, where one exists.

## Report contents

To help triage a report efficiently, include where known:

- product and repository (Frontera Systems / this repository);
- affected component;
- version, release, or commit;
- description of the issue;
- reproduction steps;
- proof of concept, if available;
- impact assessment;
- environment (e.g. deployment configuration);
- data accessed or potentially exposed, if any;
- suggested mitigation, if any;
- a contact for follow-up;
- your proposed disclosure timeline, if any.

## Sensitive information

Do not include the following in the initial report:

- credentials;
- private keys;
- customer data;
- personal data;
- production secrets or other sensitive material not necessary to
  demonstrate the issue.

If a secure exchange of such material is later needed to complete
triage, it will be coordinated directly with the reporter after initial
contact. No dedicated encrypted-submission mechanism or portal currently
exists beyond the email channel and GitHub Private Vulnerability
Reporting (where enabled) described above.

## Supported versions

| Version | Supported |
|---|---|
| 1.0.x | Yes — current release line (`v1.0.0`, see `CHANGELOG.md` and `release/RELEASE_MANIFEST.json`) |
| 0.1.x (pre-release) | No — superseded by 1.0.0 |

This table reflects the versions actually tagged/released in this
repository as of this document's authoring. It will need to be updated
as new release lines are cut.

## Responsible disclosure expectations

- Report suspected vulnerabilities privately through the channel above
  before any public disclosure.
- A specific disclosure timeline has not yet been formally adopted;
  until one is published here, coordinate timing directly with the
  Onchainfest LLC contact who acknowledges your report.
- Onchainfest LLC will make reasonable efforts to meet the response
  targets above and communicate remediation status.

## Existing security documentation

This repository already maintains detailed, engineering-level security
documentation, which this policy references rather than duplicates:

- `docs/security/THREAT_MODEL_V1.md` — threat model for the Enterprise
  Host runtime and its trust boundaries.
- `docs/security/THREAT_MODEL_V1_ADDENDUM.md` — supplemental coverage of
  digest/canonicalization/versioning attack classes.
- `docs/security/SECURITY_HARDENING_V1.md` — v1.0.0 hardening report
  (what was audited, changed, and left as-is).
- `docs/operations/RUNBOOKS_V1.md` §6 ("Incident response (triage)") —
  the current operational incident-response guidance.

Vulnerability reports and remediation work should be evaluated against
these existing documents where relevant, and the threat model should be
updated when a report reveals a gap in its coverage.

## No warranty

This Software is provided subject to the disclaimer in `LICENSE` §7. The
existence of this security policy does not create a warranty or
service-level commitment beyond what is stated in a separate Commercial
Agreement, where one exists.
