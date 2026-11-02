# [DRAFT H] Customer Handoff and Verification Instructions

> **DRAFT.** Complements the `verification-instructions.md` file generated in
> each package (ASSURE-REL-01C); it does not replace it.

## 1. What you receive

One archive with six files (Draft F), exported from the issuer's release
custody. Four of them (`report.md`, `report.json`, `integrity-manifest.json`,
`release-record.json`) are bound by digests to the approval. `limitations.md`
and `verification-instructions.md` are informational companions covered by no
digest. Do **not** open and re-save
`report.md` in an editor: changing line endings or encoding breaks its
digest. Keep the original archive.

## 2. Three different things

| Term | Meaning | How you know |
| --- | --- | --- |
| **Ready** | The report was complete and cleared for release when drafted | `report.json` / `report.md` readiness |
| **Released** | A Republika approver, independent of the reviewers, approved this exact content | `release-record.json`, **confirmed by Republika** |
| **Authentic** | This package is the one Republika issued | **Only by asking Republika.** The package carries no digital signature |

## 3. Confirm the release over a second channel

On delivery we send you, **by a different channel** from the archive (for
example a phone call or a separately agreed secure message), the
`releaseDigest` and `reportId`. Check that they equal the values in
`release-record.json`. If they differ, do not rely on the package, and tell us.

## 4. Verify integrity yourself (optional, offline)

With Node.js and the Republika verifier (provided on request, with its
digest):

```bash
node verify-commercial-package.mjs <unpacked-package-directory>
```

Expect `PASS` for files, artifact integrity, report consistency and approval
consistency, and `external authenticity NOT DEMONSTRATED`. That last line is
expected. It means the tool cannot prove who issued the package; §3 and §5 do.

## 5. Ask Republika to verify authoritatively

Send the package back to [contact]. We check it against our custody record
and answer in writing with one of:

- `RELEASE_MATCHES_AUTHORITY` — the package is the one we released;
- `RELEASE_MISMATCH` — it was altered; we re-deliver the kept version;
- `RELEASE_NOT_IN_CUSTODY` — we have no record of it;
- `AUTHORITY_UNAVAILABLE` — we cannot answer now; we will follow up.

We also tell you whether the approver is still authorized today. That does
not change the original approval.

## 6. After closeout

Authoritative verification is available until the end of the retention
period [D-04]. After deletion, only offline integrity checking remains.
