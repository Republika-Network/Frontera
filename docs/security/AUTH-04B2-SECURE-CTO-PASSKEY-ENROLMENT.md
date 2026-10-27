# AUTH-04B2 — Secure CTO passkey enrolment

**Status:** implemented and CI-qualified through private in-process fixtures.
Disabled unless the human-decision authority (AUTH-04A) and the Authority
gateway (AUTH-04B) are both explicitly enabled. No invitation has been sent,
nothing has been deployed, and no DNS or TLS exists.

## 1. Lifecycle

```
Organization administrator (CTRL-02 operator bearer, private operator plane)
  POST /api/admin/passkey-humans         {operatorId, displayName}  register the named human (separate act)
  POST /api/admin/passkey-invitations    {operatorId}               → one-time token, shown once (no-store)
  POST /api/admin/passkey-invitations/:enrolmentId/revoke {reason}
  GET  /api/admin/passkey-humans/:operatorId                        state: credentials, invitations (never a token)
          │
          │  out of band: identity verified through an independently trusted channel; token handed over directly
          ▼
Named human (CTO), Safari → Authority gateway (AUTH-04B)
  POST /authority/v1/enrolment/options   {invitation}               → WebAuthn creation options; __Host- ceremony cookie
  POST /authority/v1/enrolment           {invitation, credential}   → 201 {registered: true}; no session
          │
          ▼
  AUTH-02 credential_registered: one chained row, signed by the authority key (AUTH-03 head), advanced at the CORE-07 witness
  Then: ordinary passkey sign-in (AUTH-04B). The passkey says who; CORE-05 still decides what.
```

## 2. Administrative boundary

- The routes exist on the **existing private operator plane** (`/api/admin/…`)
  only when operators are configured and the human-decision authority is
  composed. No new public administration API.
- `passkey-enrolment.administer` is a new permission held by
  `organization-administrator` **only**. Observer, responder, provisioner,
  profile steward, approver, the CTRL-01 legacy administrator and customer keys
  are refused (tested).
- The bearer authenticates the administrator and nothing else. The port
  receives the authenticated principal, never the header (structure test).
  The bearer is never forwarded to the human, a browser, the gateway, an
  invitation, a log or an audit row.
- **Bootstrap trust limitation (stated):** the administrator is authenticated
  by a static CTRL-02 bearer secret, not a passkey. Anyone holding the
  organization administrator's secret can register humans and issue
  invitations, though never approve, grant standing or change policy. Protect
  that secret as a root credential. A passkey-authenticated administrator is a
  later increment.
- **Target human:** explicit `operatorId` that must be a configured CTRL-02
  operator with an existing, active principal of the Host's organization.
  Principal creation is a separate act. Bodies are closed: `role`,
  `organizationId`, `permissions`, `standing` and the like are refused
  (tested). At most **3** open invitations per human, decided against the
  verified history.
- **Nothing granted:** no administrator, no role, no Kernel-Authority standing,
  no approval-policy change, no capability. The operator's permissions and
  CORE-05's verdicts are unchanged by enrolment (tested). A human without
  approver standing still sees an empty inbox after enrolling (tested).

## 3. Invitation

It reuses AUTH-02's enrolment authorization and token contract unchanged:

- **Token:** `fre1.<enrolmentId>.<secret>`, with 256 random bits. Only the
  SHA-256 verifier is stored; there is no plaintext at rest.
- **Lifetime:** at most **15 minutes** (`AOC_ENTERPRISE_HUMAN_AUTHORITY_ENROLMENT_TTL_SECONDS`,
  1–900, default 900), capped by the composition.
- **Scope:** one target principal, one organization (the Host's identity store).
- **One success:** the `credential_registered` row consumes it, inside the same
  signed, witnessed append that registers the passkey.
- **Revocable** before consumption. A revoked, expired or consumed invitation
  is refused.
- **Replay after restart:** consumption is a chained row anchored at the CORE-07
  witness, so restoring an older file to reuse it is refused at startup (tested).
- **Never in a URL:** the token travels only in JSON request bodies, never in a
  path or query (structure test), so referrers, history and analytics never see
  it. It is never logged (a test scans every log line of the run).
- The issuance response is `Cache-Control: no-store`. The admin read returns
  states only, never the token.

## 4. Hand-off (first pilot)

1. The administrator verifies the CTO through an independently trusted channel
   (in person, or a call to a known number), not the channel used to deliver
   the token.
2. The administrator issues the invitation and hands the token over
   **directly**, in person or by voice. No email, chat, ticket or link, and no
   third-party service.
3. The CTO enters the token in the enrolment screen (AUTH-04C) within 15 minutes.
4. If the token is exposed, mistyped, lost or delayed, the administrator revokes
   it and issues a new one.

**Interception threat:** whoever holds an unexpired, unconsumed token can
register *their* passkey as the named human. Mitigations:
- the short lifetime and single use;
- direct hand-off;
- revocation;
- the administrator confirms with the CTO that the registration was theirs
  (`GET …/passkey-humans/:operatorId` shows the new credential);
- an unexpected credential is revoked (AUTH-02).

The token proves possession of the invitation, **not** physical ownership of a
device or the person's identity. That rests on the hand-off.

## 5. Registration on the gateway

- `Host` and `Origin` must be the Authority origin; POST only; `application/json`
  only; bodies bounded to 64 KiB with closed fields.
- **Options:** AUTH-02 `beginRegistration`, with the configured RP ID, user
  verification required, a resident key, `attestation: none`, and the
  predetermined human as `user`. The ceremony is bound to the browser **and** to
  the invitation by a one-shot `__Host-frontera_authority_enrolment` cookie that
  holds a nonce and the invitation's digest (never the token).
- **Registration:** the cookie's ceremony must match the invitation digest and
  the credential's challenge. AUTH-02 `finishRegistration` then verifies:
  - the token;
  - the challenge (stored, of the registration ceremony, for this enrolment);
  - the client data type, origin, RP ID, user presence and user verification;
  - the attestation and the public key;
  - duplicate credentials.

  It records one signed, witnessed row.
- **Response:** `201 {"registered": true}`. No session cookie, no permission,
  no verdict, no capability.
- **One answer for invitation failures:** unknown, malformed, expired,
  revoked, consumed, foreign-Host, or for a revoked or unknown human, all return
  the same `403 AUTHORITY_ENROLMENT_INVALID`, so the gateway is no oracle for
  invitations or humans.
- **Rate limiting:** an `admit(route, req)` hook covers sign-in and enrolment
  and returns `429` (tested). The Host composes none: per-IP limits belong to the
  fronting proxy (to be configured before exposure).

## 6. Signed state and CORE-07

Nothing new: the existing AUTH-02/03 identity store, its signed head, the
existing authority signing key and domain, and the existing witness boundary.
There is no unsigned fallback; human authority already requires the witness in
every profile. Tested:
- a witness outage while the registration would be recorded refuses it, and the
  invitation stays unconsumed;
- after restart with the witness back, the same invitation registers once;
- after enrolment, a restart keeps the passkey and the invitation stays consumed;
- restoring the pre-enrolment file is refused (`AUTHORITY_FRESHNESS_ROLLBACK_DETECTED`).

The witness protocol is unchanged.

## 7. Known operational limitations

- No UI yet (AUTH-04C): the enrolment and sign-in screens are not built.
- The bootstrap administrator is a static bearer (§2).
- There is no in-Host rate limiter; the proxy must provide one.
- The identity store is still outside backup:v1 (AUTH-04A).
- External key custody is still unsupported.
- One Host process.
- The enrolment ceremony state is in memory (lost on restart). The invitation is not: restart and begin again.
