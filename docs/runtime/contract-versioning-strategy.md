# Contract Versioning Strategy

## Versioning Philosophy

Canonical runtime contracts follow **semantic versioning** with an emphasis on backward compatibility within major versions.

The current version is tracked in `packages/canonical-runtime-contracts/src/version.ts`:

```typescript
export const CANONICAL_CONTRACTS_VERSION = '0.1.0';
export const CANONICAL_CONTRACTS_SCHEMA_DATE = '2026-05-21';
```

Both values are `as const` and available at runtime for compatibility assertions.

## Version Boundaries

### Patch (0.0.x)
- Adding new optional fields to existing interfaces
- Adding new entries to existing const maps
- New type aliases that don't replace existing ones

### Minor (0.x.0)
- New sub-modules added to the package
- New reason code domains
- New event envelope types
- New feature flags or billing plan entries

### Major (x.0.0)
- Renaming existing reason code values (breaks existing serialized data)
- Removing fields from interfaces
- Changing the type of existing fields
- Restructuring module exports that break import paths

## Backward Compatibility Contract

The `backwardCompatibleFrom` field in `CONTRACT_VERSION_METADATA` declares the oldest version that is wire-compatible with the current version. Consumers should assert this at startup:

```typescript
import { CONTRACT_VERSION_METADATA } from '@aoc-enterprise/canonical-runtime-contracts';

function assertContractCompatibility(requiredVersion: string) {
  const { version, backwardCompatibleFrom } = CONTRACT_VERSION_METADATA;
  // Use semver comparison in practice
  if (backwardCompatibleFrom > requiredVersion) {
    throw new Error(
      `Contract version ${version} is not compatible with ${requiredVersion} ` +
      `(compatible from ${backwardCompatibleFrom})`
    );
  }
}
```

## Federation Preparation

When Frontera Systems federates across trust domains or exposes external SDKs, contract versioning becomes a cross-org concern:

1. **External SDKs** must pin to a minimum contract version and receive changelogs on breaking changes.
2. **Federated runtimes** negotiate a compatible contract version range during `RuntimeNegotiationType.FEDERATION_EXPANSION`.
3. **Sovereign adapters** may pin to a specific contract schema date for audit reproducibility.

The `ContractVersionMetadata` type is designed to be serialized into runtime negotiation payloads so that compatibility can be verified without out-of-band coordination.

## Adding New Contracts

When adding a new semantic concept:

1. Define it in the appropriate sub-module of `canonical-runtime-contracts`
2. Export it from that module's `index.ts`
3. Re-export it from `src/index.ts`
4. If it's a reason code, add it to the domain const map and update `ALL_REASON_CODES`
5. If it's a feature flag, add it to `FEATURE_FLAGS` and update `PLAN_FEATURE_ENTITLEMENTS`
6. Bump the patch version in `version.ts`
7. Run `npm run typecheck` from the repo root to verify no breakage

## Deprecation Policy

Deprecated exports:
- Stay in the package for one full minor version after deprecation
- Are annotated with `@deprecated` JSDoc
- Are removed in the next major version

No breaking changes are made without a major version bump.
