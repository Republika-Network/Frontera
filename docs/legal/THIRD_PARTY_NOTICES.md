# Third-Party Notices

> STATUS: DRAFT — PENDING PROFESSIONAL LEGAL REVIEW.
> This file lists third-party software distributed with, or built by,
> Frontera Systems, and the license each is distributed under. It does not
> reproduce full license texts, because this repository does not
> currently have `node_modules` installed (no build artifacts to extract
> verified license text from) — see "Generating verbatim license texts"
> below for how to complete this before external distribution.

Frontera Systems incorporates the following third-party open source
software. Each remains subject to its own license, listed below. See
`docs/legal/OPEN_SOURCE_DEPENDENCIES.md` for the fuller inventory,
classification, and evidence for each entry.

## Direct dependencies distributed with Frontera Systems

| Package | License | Copyright |
|---|---|---|
| better-sqlite3 | MIT | © respective upstream contributors. Exact notice text not reproduced here — see "Generating verbatim license texts" below. |
| react | MIT | © Meta Platforms, Inc. and affiliates. |
| react-dom | MIT | © Meta Platforms, Inc. and affiliates. |
| next | MIT | © Vercel, Inc. |
| stripe (Node SDK) | MIT | © Stripe, Inc. |
| typescript | Apache-2.0 | © Microsoft Corporation. |

Attribution above reflects the publicly known maintaining organization
for each project as of this writing; it is not a substitute for the
verbatim notice each license may require on redistribution.

## Generating verbatim license texts

MIT, Apache-2.0, ISC, and BSD-family licenses generally require that the
original copyright and permission notice be reproduced when the
software (or a substantial portion of it) is redistributed. This
repository does not have `node_modules` installed at the time of writing
this document, so exact upstream `LICENSE` file contents could not be
extracted and verified here.

Before any build artifact containing these dependencies is distributed
externally, run a license-text aggregation step (e.g. `npm ci` followed
by a license-collection tool) as part of the release process, and attach
its output to this file or to the release artifact. This is tracked as
an open item in `docs/legal/IP_DUE_DILIGENCE_CHECKLIST.md`.

## Packages requiring manual license verification

The following packages appear in the dependency tree with no `license`
field recorded in the lockfile. License status requires manual
verification before external distribution:

- `busboy` (transitive, via `next`)
- `streamsearch` (transitive, via `busboy`)

## What is intentionally not listed here

- Dev-only tooling that is never distributed with a built artifact
  (e.g. `typescript`'s compiler itself is used to build the project but
  is not shipped in `dist/`).
- Workspace-internal `@aoc-enterprise/*` packages — these are
  Onchainfest LLC's own proprietary code, not third-party notices.
- Soberanía Protocol (`@aoc/protocol`) — governed by its own, separate license
  as a distinct project; see `docs/legal/PROTOCOL_ENTERPRISE_BOUNDARY.md`.
  This file does not reproduce Soberanía Protocol's license because this
  review did not have verified access to it.

## Questions or corrections

If a dependency's license classification here is believed to be
incorrect, or a required notice is missing, raise it through the
reporting channel in `SECURITY.md` (for security-adjacent concerns) or
directly with the Onchainfest LLC engineering lead responsible for this
repository.
