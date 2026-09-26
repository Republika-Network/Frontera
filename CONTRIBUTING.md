# Contributing to Frontera Systems

> STATUS: DRAFT — PENDING PROFESSIONAL LEGAL REVIEW.

Frontera Systems is proprietary software owned by Onchainfest LLC (see
`LICENSE`, `NOTICE.md`, `COPYRIGHT.md`). This is **not** an open source
project, and this document does not use an open-contribution model.

## Contributions require prior authorization

Frontera Systems does not accept unsolicited public contributions (e.g.
unsolicited pull requests from outside contributors). All contributions
— code, documentation, schemas, tests, or other materials merged into
this repository — require prior authorization from Onchainfest LLC and
must be covered by one of the following, in writing:

- an employment agreement with Onchainfest LLC that assigns work product
  to Onchainfest LLC;
- a services agreement or statement of work with Onchainfest LLC that
  addresses IP ownership of deliverables;
- an IP assignment agreement specific to the contribution;
- a Contributor License Agreement (CLA) accepted by Onchainfest LLC; or
- another written instrument accepted by Onchainfest LLC that
  establishes Onchainfest LLC's rights in the contribution.

A contribution merged into this repository without one of the above in
place does not, by itself, transfer ownership to Onchainfest LLC and may
be rejected, reverted, or held pending execution of the appropriate
instrument.

## What a contributor represents

By submitting a contribution under an accepted instrument above, the
contributor represents that:

- they have the right to submit the contribution (e.g., it is their own
  original work, or they otherwise hold the rights necessary to
  contribute it);
- the contribution does not knowingly include third-party code that is
  incompatible with this repository's proprietary licensing (for
  example, copyleft-licensed code included without authorization);
- any third-party dependency, snippet, or reference material used in
  preparing the contribution is disclosed, including its license and
  provenance;
- the contribution accurately discloses whether, and how, AI-assisted
  tools were used to generate or modify the contributed material, so
  provenance and third-party-license risk can be assessed.

## Contributions may be rejected

Onchainfest LLC may reject, request changes to, or decline to merge any
contribution for any reason, including incomplete provenance
documentation, licensing risk, architectural misalignment (see
`docs/architecture/`), or absence of a required written instrument under
the section above. Onchainfest LLC may also require execution of a CLA
or IP Assignment Agreement as a condition of accepting a specific
contribution, even from an existing contributor.

## Required contributor documentation

Before a contribution is merged, the following should be confirmed and,
where applicable, recorded:

- [ ] **Contributor identity** — who is submitting the contribution
      (name, affiliation).
- [ ] **Contractual relationship** — which instrument covers this
      contribution (employment agreement / services agreement / IP
      assignment / CLA / other), and where it is on file.
- [ ] **Confirmation of ownership** — the contributor has the right to
      submit this contribution and it is not encumbered by a third
      party's claim.
- [ ] **Third-party licenses** — any third-party code, libraries, or
      material included or referenced, with their licenses identified.
- [ ] **AI tool usage** — whether AI-assisted tools were used to
      generate or substantially modify the contribution, and which
      tools.
- [ ] **Provenance** — where the contributed material originated (new
      work, adapted from an existing internal module, adapted from a
      public source, etc.).
- [ ] **Internal approval** — sign-off from the designated Onchainfest
      LLC reviewer/owner responsible for this area of the codebase.

## Technical contribution guidance

Independent of the IP requirements above, contributions should follow
this repository's existing architectural and process conventions:

- Respect the layering rules in `docs/architecture/foundation.md`,
  `docs/architecture/protocol-integration.md`, and
  `docs/architecture/repo-boundaries.md` — in particular, Frontera Systems
  code must not redefine Soberanía Protocol primitive semantics.
- Follow the test and validation conventions in
  `docs/testing/TEST_STRATEGY_V1.md`.
- Do not introduce new production dependencies without documenting them
  per `docs/legal/OPEN_SOURCE_DEPENDENCIES.md`.

## Questions

For questions about whether a specific contribution requires a CLA or IP
Assignment Agreement, or which instrument applies to a given
relationship, contact:

```text
vicvalch@onchainfest.xyz
```

using the subject prefix:

```text
[CONTRIBUTOR GOVERNANCE]
```

before submitting the contribution.
