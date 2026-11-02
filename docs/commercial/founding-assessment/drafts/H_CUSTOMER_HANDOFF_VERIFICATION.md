# [DRAFT H] Customer Handoff and Verification Instructions

> **DRAFT.** Complements the `verification-instructions.md` file generated in
> each package (ASSURE-REL-01C); it does not replace it. Wording corrected by
> ASSURE-CLAIMS-01 (GF-06); **subject to qualified legal review**.

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
| **Released** | A different authorized Republika approver approved this exact report content for release | `release-record.json`, **confirmed by Republika** |
| **Authentic** | This package is the one Republika issued | **Only by asking Republika.** The package carries no digital signature |

**Who approved it.** The approver works for Republika (as an employee or an
authorized contractor); they are not external to Republika and not an
independent reviewer. Internal separation of duties means the approval was
made with a separate approved credential that recorded none of the control
reviews: the Host enforces that per credential. That the approver is also a
different person from the reviewers is enforced by Republika's operating
procedure; it is not cryptographically proven. Internal approval is not an
external review and does not certify anything.

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
expected. It means the tool cannot establish who issued the package. The
package is not digitally signed, and its digests show only that the files are
unchanged. To corroborate that Republika issued it, use §3 and §5: both rely
on confirmation from Republika over a separate, trusted channel.

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
