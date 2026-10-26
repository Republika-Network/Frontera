# `vendor/`

Reproducible `npm pack` builds of `@aoc/protocol` from pinned Soberanía Protocol commits. The
**active** artifact is the one `package.json` installs via
`devDependencies["@aoc/protocol"]`; the others are retained as historical evidence and are
referenced by ADRs, source comments and prior release evidence.

| Artifact | State | Protocol version | Pinned commit |
| --- | --- | --- | --- |
| `aoc-protocol-0.2.0-rc.3.tgz` | **active** | `0.2.0-rc.3` (security release candidate) | `fd705f689e04781748e308368a10e52ae32af079` |
| `aoc-protocol-0.2.0-rc.1.tgz` | superseded, retained | `0.2.0-rc.1` (repaired release candidate) | `eec79cdd4019dd42e1767909c5bd4e26d04c6f0f` |
| `aoc-protocol-0.2.0-rc.0.tgz` | **burned**, retained as evidence | `0.2.0-rc.0` | `dde34517d956156a0c735c18a805763a5e712879` |
| `aoc-protocol-0.1.0.tgz` | superseded, retained | `0.1.0` | `ab2ac6ef573c871a029a67b13d33ba9738cb5939` |

`aoc-protocol-0.2.0-rc.0.tgz` is **BURNED — never reinstate it as the active artifact.** Its
canonical-JSON writer truncated exponent digits, so `canonicalizeJSON(7.9e-10)` and
`canonicalizeJSON(7.9e-100)` both produced `"7.9e-1"`: two distinct numbers, one canonical form,
one digest. Soberanía Protocol declared the candidate burned rather than repacking its bytes and cut
`0.2.0-rc.1` (commit `eec79cdd…`) as the repaired successor. The burned tarball stays tracked here
because every Frontera candidate through `1.2.0` really was validated against it and the evidence
has to keep saying so — it is a historical record, not an install target.
`scripts/protocol/check-canonicalization-regression.mjs` (run by `npm test`) fails the build if this
repository ever resolves `0.2.0-rc.0` again.

The active artifact's commit, filename and SHA-256 are pinned in
[`protocol-consumer.lock.json`](../protocol-consumer.lock.json). A superseded artifact is never
deleted and never overwritten: rewriting a tarball in place would falsify the evidence that a prior
Enterprise state was validated against it.

This is the canonical interim dependency mechanism while `@aoc/protocol` remains unpublished (see
`docs/integration/PROTOCOL_PACKAGE_CONSUMPTION.md`, "Registry transition").

Do not hand-edit these files. Rebuild with:

```bash
AOC_PROTOCOL_REPO=<path-or-url> AOC_PROTOCOL_REF=<full 40-character commit SHA> \
  AOC_PROTOCOL_TARBALL_OUT=./vendor \
  node scripts/protocol/build-protocol-tarball.mjs
```

then update `protocol-consumer.lock.json` (`commit`, `expectedVersion`, `tarball.*`) to match, and
run `node scripts/protocol/check-compatibility-lock.mjs` to confirm the lock file is internally
consistent. Once `@aoc/protocol` is published to a real registry, this directory and the `file:`
dependency should be removed in favor of an ordinary registry-resolved version.
