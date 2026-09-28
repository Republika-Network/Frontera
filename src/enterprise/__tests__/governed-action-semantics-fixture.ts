import type { GovernanceConfiguration } from '../governance-profile/index.js';

/**
 * CORE-03 test fixture: a synthetic deployment's semantic configuration.
 *
 * Two non-financial domains, declared **only** as data — parameter
 * dimensions, action classes, resource classes and Governance Profiles — so
 * every test that uses it measures what CORE does with configuration it has
 * never heard of:
 *
 * - **Data:** `read` vs `export` over one customer dataset, distinguished by a
 *   non-monetary quantity (`recordCount`) and a destination.
 * - **DevOps:** `deploy` to a production environment, with a release version
 *   and a rollback-availability flag.
 *
 * Money stays where P9 put it: `payment.send` is financial and unprofiled, and
 * governs exactly as before CORE-03 in the same deployment.
 *
 * No real customer data, environment or credential appears anywhere.
 */
export const READ_ACTION = 'read-customer-records';
export const EXPORT_ACTION = 'export-customer-records';
export const DEPLOY_ACTION = 'deploy-release';
export const PAYMENT_ACTION = 'payment.send';

export const CUSTOMER_DATA = 'customer-data-example';
export const PRODUCTION_ENVIRONMENT = 'production-environment-example';
export const TREASURY = 'resource-treasury-1';

export const APPROVED_DESTINATION = 'approved-archive';

export const SEMANTIC_CONFIGURATION: GovernanceConfiguration = {
  parameterDimensions: [
    { id: 'recordCount', type: 'integer', bound: 'maximum' },
    { id: 'destination', type: 'token', bound: 'exact' },
    { id: 'releaseVersion', type: 'token', bound: 'exact' },
    { id: 'rollbackAvailable', type: 'boolean', bound: 'exact' },
  ],
  actionClasses: [
    { id: 'read', actions: [READ_ACTION] },
    { id: 'export', actions: [EXPORT_ACTION] },
    { id: 'deploy', actions: [DEPLOY_ACTION] },
  ],
  resourceClasses: [
    { id: 'customer_dataset', resources: [CUSTOMER_DATA] },
    { id: 'production_environment', resources: [PRODUCTION_ENVIRONMENT] },
  ],
  profiles: [
    {
      profileId: 'customer-data-read',
      version: 1,
      owner: 'org-a',
      provenance: { authoredBy: 'operator:data-governance', approvedBy: 'operator:security' },
      actionClass: 'read',
      resourceClass: 'customer_dataset',
      parameters: [{ dimension: 'recordCount', required: true }],
      materialFacts: [],
      relevantPolicies: ['customer-data-policy'],
    },
    {
      profileId: 'customer-data-export',
      version: 2,
      owner: 'org-a',
      provenance: { authoredBy: 'operator:data-governance', approvedBy: 'operator:security' },
      actionClass: 'export',
      resourceClass: 'customer_dataset',
      parameters: [
        { dimension: 'destination', required: true },
        { dimension: 'recordCount', required: true },
      ],
      materialFacts: ['destinationClassification', 'dataResidency'],
      relevantPolicies: ['customer-data-policy'],
    },
    {
      profileId: 'production-deploy',
      version: 1,
      owner: 'org-a',
      provenance: { authoredBy: 'operator:platform', approvedBy: 'operator:security' },
      actionClass: 'deploy',
      resourceClass: 'production_environment',
      parameters: [
        { dimension: 'releaseVersion', required: true },
        { dimension: 'rollbackAvailable', required: true },
      ],
      materialFacts: ['approvedChangeWindow', 'incidentStatus'],
      relevantPolicies: ['change-management-policy'],
    },
  ],
};
