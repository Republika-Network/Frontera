export type AgentPassportTierKey = 'agent_passport_single' | 'governed_agent' | 'organization_agent_registry';

export interface AgentPassportTier {
  key: AgentPassportTierKey;
  name: string;
  priceLabel: string;
  billingLabel: string;
  description: string;
  features: string[];
  stripePriceEnvVar: string;
  ctaLabel: string;
  recommended?: boolean;
}

export const AGENT_PASSPORT_TIERS: AgentPassportTier[] = [
  {
    key: 'agent_passport_single',
    name: 'Agent Passport',
    priceLabel: '$99',
    billingLabel: 'one-time',
    description: 'For founders, builders, and teams that need a verifiable identity and public governance page for one SI agent.',
    features: [
      '1 Agent Passport',
      'Passport ID',
      'Agent Constitution',
      'Policy Manifest',
      'Runtime Seal',
      'Public verification page',
      'QR payload string',
      'Badge snippet',
      'Sample Runtime Guard demo',
      'Basic governance evidence',
    ],
    stripePriceEnvVar: 'STRIPE_PRICE_AGENT_PASSPORT_SINGLE',
    ctaLabel: 'Get Agent Passport',
  },
  {
    key: 'governed_agent',
    name: 'Governed Agent',
    priceLabel: '$299',
    billingLabel: 'one-time',
    description: 'For teams deploying agents that need stronger declared governance, runtime guard readiness, and richer policy documentation.',
    features: [
      'Everything in Agent Passport',
      'Enhanced policy manifest',
      'Runtime Guard readiness report',
      'Human oversight mapping',
      'Prohibited action review',
      'Governance summary',
      'Public verification page',
      'Badge snippet',
      'Runtime Guard simulation',
    ],
    stripePriceEnvVar: 'STRIPE_PRICE_GOVERNED_AGENT',
    ctaLabel: 'Get Governed Agent',
    recommended: true,
  },
  {
    key: 'organization_agent_registry',
    name: 'Organization Agent Registry',
    priceLabel: '$999',
    billingLabel: 'per month',
    description: 'For organizations that want to govern multiple SI agents under a shared registry with a buyer admin view and up to 10 governed agent passports.',
    features: [
      'Up to 10 governed agent passports',
      'Buyer admin registry dashboard',
      'Organization-level registry',
      'Passport capacity tracking',
      'Governance status overview',
      'Registry-level enrollment',
      'Public verification pages',
      'Badge snippets',
      'Runtime Guard readiness across agents',
      'Priority implementation support',
    ],
    stripePriceEnvVar: 'STRIPE_PRICE_ORG_AGENT_REGISTRY',
    ctaLabel: 'Start Organization Registry',
  },
];

export function getTierByKey(key: string): AgentPassportTier | undefined {
  return AGENT_PASSPORT_TIERS.find(t => t.key === key);
}

export function isValidTierKey(key: string): key is AgentPassportTierKey {
  return AGENT_PASSPORT_TIERS.some(t => t.key === key);
}
