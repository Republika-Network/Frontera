# XRPL-First Anchoring (PROPOSED — no transaction made, no key used)

## 1. What exists (xrpl-sovereign-access `3f7652f`)

| Component | Path | Reusable for conformance? |
|---|---|---|
| Network deployment guard (`PUBLIC_NETWORK_NOT_AUTHORIZED`, Testnet-only writes) | `packages/network-deployment/src/deployment.ts` `defineNetworkDeployment`; gateway `PREVIEW_FORBIDDEN_NETWORKS` | **Reuse directly** |
| Transaction preparation with `LastLedgerSequence`, fee cap, `NetworkID` | `packages/xrpl-adapter/src/prepare.ts` | Reuse; needs a new transaction class |
| Validated-ledger confirmation (`SUCCESS` only from validated ledger; `tec` final; unreachable = indeterminate) | `packages/xrpl-adapter/src/submit.ts` `resolveValidation` | **Reuse directly** |
| Idempotent operations, lease, identical-blob resubmit, journal | `packages/credential-gateway/src/worker.ts` `OperationWorker`; `storage/journal.ts` | **Reuse pattern / code** |
| Out-of-process signer, single-use operator approvals, closed field table | `apps/signer-service`, `packages/signer-port/src/wire.ts` | Reuse; **field table refuses `Memos`/`URI`** |
| CredentialCreate / CredentialDelete | `prepare.ts`, `projection-writer` | Reuse for an optional *existence marker* |
| Reconciler / episodes / quorum read-back | `packages/reconciler`, `packages/xrpl-adapter/src/quorum.ts` | Reuse for historical reconstruction |
| Authoritative status port | `packages/credential-gateway/src/ports.ts` `AuthoritativeRecordSource.lookupProjectionStatus` | **Natural integration point**: the Status Registry implements it |

## 2. Hard constraints discovered

1. **XRPL Credentials cannot carry mutable status.** ADR-002: an XRPL Credential is a *public existence
   marker*. Suspended / Superseded are structurally inexpressible; presence never means Active and
   absence never means Revoked (INV-13). Re-creating after delete is a new episode.
2. **Digest anchoring is absent by design.** The signer wire table refuses `Memos`, `URI`, `Signers`,
   `SourceTag`; tests enforce it. Anchoring digests on XRPL therefore needs an ADR amendment in
   xrpl-sovereign-access → [CC-D-06](DECISION_REGISTER.md#cc-d-06).
3. Frontera does not depend on xrpl-sovereign-access. Integration must cross the repository boundary
   through an HTTP/port contract, not a package import (consistent with ADR-001 "XRPL remains an external
   execution vertical").

## 3. What to anchor

| Item | Individually or batched | Why |
|---|---|---|
| Credential issuance (T2) | Individually (optional XRPL Credential existence marker + digest anchor) | Discoverability; one per credential |
| Suspension / reinstatement / revocation transitions | **Batched** Merkle root every ≤ 1 h; revocation also individually | Suspension must not wait for chain; history only |
| Accepted evidence digests | Batched Merkle root (daily) | Volume; privacy |
| Status assertions | **Never** | Short-lived, high-volume, current-state only |
| Document content, evidence packages, validator identities beyond ids | **Never** | Privacy (FV + X publication-consent rules) |

## 4. Anchor record (off-chain, in D7)

```ts
interface ConformanceAnchorRecordV1 {
  schema: 'rn.conformance.anchor/1';
  anchorId: string;
  anchorSchemaVersion: 1;
  kind: 'transition' | 'transition-batch' | 'evidence-batch';
  credentialId: string | null;          // for single transitions
  transitionId: string | null;
  merkleRoot: string | null;            // for batches; leaves = transitionDigest / evidenceDigest
  leafCount: number;
  canonicalPayloadDigest: string;       // sha256 of canonical anchor payload
  issuerRef: string;                    // Republika status-issuer key id
  network: { chain: 'xrpl'; networkId: 'testnet'; deploymentId: string };
  transaction: { hash: string | null; ledgerIndex: number | null; lastLedgerSequence: number | null };
  confirmation: 'prepared' | 'submitted' | 'validated' | 'failed_final' | 'indeterminate';
  createdAt: string; confirmedAt: string | null;
}
```

The **on-chain payload** is only `{schema, canonicalPayloadDigest}` (≤ 64 bytes hex + short tag).

## 5. Options for the on-ledger carrier (decision CC-D-06)

| Option | Carrier | Pros | Cons |
|---|---|---|---|
| A (recommended) | Self-payment / `AccountSet` with one `Memo` holding the digest, from a dedicated anchoring account, through a new *anchor* transaction class in xrpl-sovereign-access with its own approval policy | Reuses prepare/sign/confirm/journal; no claim content | Requires ADR amendment to the closed field table |
| B | XRPL Credential existence marker only (no digest) | No ADR change | Proves nothing about content; insufficient for history |
| C | Separate minimal anchoring service outside xrpl-sovereign-access | Isolation | Duplicates confirmation/idempotency code |

## 6. Failure handling

* Anchoring failure **never** blocks or reverts a transition. Records stay `indeterminate`; the worker
  retries the **identical signed blob** until `LastLedgerSequence` passes, then re-prepares (new
  sequence, same `canonicalPayloadDigest`) — the X idempotency model.
* Blockchain outage: the status registry keeps serving; anchors are back-filled. Verifiers are told via
  `anchors[].confirmation = 'pending'`.
* Historical reconstruction: recompute Merkle roots from the transition log and match against validated
  ledger transactions (reconciler read-back).

## 7. EVM adapter

No EVM code exists in any repository. The anchor record is chain-independent (`network.chain`). An EVM
adapter would emit an event `Anchored(bytes32 digest, bytes32 schema)` from a minimal, ownerless-logic
contract or use calldata-only transactions; confirmation = N block finality. **DEFER** until after
RN-CONFORM-03 ([CC-D-16](DECISION_REGISTER.md#cc-d-16)).

## 8. Prohibitions carried forward

No Mainnet writes, no live keys in this or the next mission (synthetic/simulated anchoring only in
RN-CONFORM-02; Testnet only behind the existing signer approval flow in RN-CONFORM-03), no token, no new
chain.
