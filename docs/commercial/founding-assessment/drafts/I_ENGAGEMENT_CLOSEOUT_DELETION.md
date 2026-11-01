# [DRAFT I] Engagement Closeout and Deletion Checklist

> **DRAFT.** Process only: no purge tool exists. The Assurance Store has no
> delete API and release custody is append-only, so deletion means destroying
> the customer's dedicated store and its backups. Retention values are
> proposals (D-04).

## A. At acceptance

- [ ] Acceptance (Draft F) recorded, or the deemed-acceptance date reached.
- [ ] Open verification requests answered.
- [ ] Engagement record complete: SOW, authorization, credential register
      entries, approver attestation, release `reportId` and `releaseDigest`,
      backup record.
- [ ] Customer told the retention end date and the effect of deletion on
      verification.

## B. Within [30] days of acceptance

- [ ] Republika-held evidence artifact copies deleted from every location
      (repository, transfer staging, operator machines). Locations listed.
- [ ] Every credential on the customer's Host revoked: removed from
      `assuranceReviewers`, secret deleted, Host restarted.
- [ ] Credential register updated with the revocation dates.
- [ ] Host left stopped, or kept only for authoritative verification
      [decision: keep the Host until retention end, or keep a cold backup only].

## C. At retention end

- [ ] Final authoritative-verification window notified to the customer [N days].
- [ ] Assurance Store file destroyed (with its `-wal` and `-shm` sidecars).
- [ ] **Every** backup of it destroyed: on-Host, off-Host and archived copies.
- [ ] Host volume destroyed or securely wiped.
- [ ] Operator logs past their retention [1 year] deleted.
- [ ] Deletion certificate issued.

## Deletion certificate (template)

> Republika confirms that on [date] it destroyed the assessment records,
> backups and evidence copies relating to engagement [SOW reference] for
> [Customer], at the locations listed: [ ]. Records retained under legal
> obligation, if any: [ ] until [ ]. From this date, Republika cannot verify
> the authenticity of report [reportId].
>
> Signed: [custody administrator] · Witnessed: [founder or security lead]
