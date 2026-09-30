/**
 * Kernel Authority Runtime: Frontera's durable, operator-provisioned
 * recognition/authority world.
 *
 * Re-exported wholesale from `../index.ts` onto the package's existing
 * `./enterprise` subpath -- no new public subpath is introduced, because this
 * is composition surface and `./enterprise` is where composition surface
 * already lives.
 */

export {
  AOC_KERNEL_AUTHORITY_RUNTIME_VERSION,
  KERNEL_AUTHORITY_SCHEMA_VERSION,
  KERNEL_AUTHORITY_CONTRACT_IDS,
  KERNEL_AUTHORITY_ENTITY_KINDS,
  KERNEL_AUTHORITY_STORE_PROVIDER_KINDS,
  KERNEL_AUTHORITY_STORE_PROVIDER_PROPERTIES,
  isDurableKernelAuthorityStoreProvider,
} from './contracts.js';
export type {
  KernelAuthorityAccessContext,
  KernelAuthorityActorType,
  KernelAuthorityDelegateActorType,
  KernelAuthorityEntityKind,
  KernelAuthorityEntityStatus,
  KernelAuthorityEvent,
  KernelAuthorityEventType,
  KernelAuthorityExternalSubject,
  KernelAuthorityIdempotency,
  KernelAuthorityPassportType,
  KernelAuthorityRecord,
  KernelAuthorityRecordQuery,
  KernelAuthorityRiskLevel,
  KernelAuthorityStoreHealth,
  KernelAuthorityStoreMigrationState,
  KernelAuthorityStoreProviderKind,
  AppendKernelAuthorityEventInput,
  AppendKernelAuthorityEventResult,
  KernelAuthorityProvisionInput,
  ProvisionActorInput,
  ProvisionAuthorityGrantInput,
  ProvisionCapabilityTokenInput,
  ProvisionDelegationGrantInput,
  ProvisionPassportInput,
  ProvisionRootIssuerInput,
  ProvisionTrustDomainInput,
} from './contracts.js';

export { KernelAuthorityError, isKernelAuthorityError } from './errors.js';
export type { KernelAuthorityErrorCode } from './errors.js';

export type { KernelAuthorityStore } from './kernel-authority-store.js';
export {
  canAccessKernelAuthorityOrganization,
  requireKernelAuthorityOperator,
  requireKernelAuthorityReadAccess,
  requireKernelAuthorityTenantScope,
  reconstructKernelAuthorityRecord,
} from './kernel-authority-store.js';

export { createInMemoryKernelAuthorityStore } from './in-memory-kernel-authority-store.js';
export type { CreateInMemoryKernelAuthorityStoreOptions } from './in-memory-kernel-authority-store.js';
export { createSqliteKernelAuthorityStore } from './sqlite-kernel-authority-store.js';
export type { CreateSqliteKernelAuthorityStoreOptions } from './sqlite-kernel-authority-store.js';

export { hydrateKernelAuthorityWorld } from './hydration.js';
export type { KernelAuthorityHydrationContext, KernelAuthorityHydrationResult } from './hydration.js';

export { createDurableRecognitionProvider, resolveRecognitionCredentials } from './recognition-bridge.js';
export type { DurableRecognitionBridgeOptions, ResolvedRecognitionCredentials } from './recognition-bridge.js';

export { createDurableKernelProviders } from './durable-kernel-providers.js';
export type { CreateDurableKernelProvidersOptions, DurableKernelDecisionService, DurableKernelProviderSet } from './durable-kernel-providers.js';

export { createKernelAuthorityProvisioningService } from './provisioning-service.js';
export type {
  CreateKernelAuthorityProvisioningServiceOptions,
  KernelAuthorityProvisioningOptions,
  KernelAuthorityProvisioningResult,
  KernelAuthorityProvisioningService,
  KernelAuthorityRevocationInput,
} from './provisioning-service.js';
