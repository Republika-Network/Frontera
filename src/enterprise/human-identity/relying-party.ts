import { HumanIdentityError } from './contracts.js';

/**
 * AUTH-02 — the WebAuthn relying party: explicit deployment configuration,
 * validated once, frozen, and never extended by a request.
 *
 * The intended production RP ID is `authority.frontera-systems.com`. That is a
 * configuration value, not evidence that the domain exists or is served: this
 * increment changes no DNS and deploys nothing.
 *
 * Origins are an explicit allow-list. A ceremony whose client data names any
 * other origin is refused; nothing here accepts a caller-supplied origin.
 *
 * - Every origin is `https://` with a host equal to the RP ID or one of its
 *   subdomains (the WebAuthn registrable-suffix rule), no path, query,
 *   fragment or credentials, and the default port unless one is named.
 * - `mode: 'test-loopback-only'` is the one exception: RP ID exactly
 *   `localhost`, origins `http://localhost[:port]` only. It exists for isolated
 *   tests and refuses every non-loopback value, so it cannot be used to
 *   weaken a real deployment.
 */

export interface RelyingPartyInput {
  readonly rpId: string;
  readonly rpName: string;
  readonly allowedOrigins: readonly string[];
  /** Omitted: production rules. `'test-loopback-only'`: isolated test configuration, `localhost` only. */
  readonly mode?: 'production' | 'test-loopback-only';
}

export interface RelyingPartyConfiguration {
  readonly rpId: string;
  readonly rpName: string;
  readonly allowedOrigins: readonly string[];
  readonly mode: 'production' | 'test-loopback-only';
}

export const INTENDED_PRODUCTION_RP_ID = 'authority.frontera-systems.com';

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_ORIGINS = 8;

function invalid(message: string): never {
  throw new HumanIdentityError('HUMAN_IDENTITY_CONFIGURATION_INVALID', message);
}

function isDomainName(value: string): boolean {
  if (value.length === 0 || value.length > 253 || value !== value.toLowerCase()) return false;
  const labels = value.split('.');
  if (labels.length < 2) return false;
  if (labels.every((label) => /^[0-9]+$/.test(label))) return false;
  return labels.every((label) => LABEL.test(label));
}

function parseOrigin(origin: string): URL {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return invalid(`'${origin}' is not a URL.`);
  }
  if (url.origin !== origin) invalid(`'${origin}' is not a bare origin (no path, query, fragment, credentials or trailing slash; default port omitted).`);
  return url;
}

export function createRelyingPartyConfiguration(input: RelyingPartyInput): RelyingPartyConfiguration {
  if (input === null || typeof input !== 'object') invalid('The relying-party configuration must be an object.');
  for (const key of Object.keys(input)) {
    if (!['rpId', 'rpName', 'allowedOrigins', 'mode'].includes(key)) invalid(`The relying-party configuration does not accept '${key}'.`);
  }
  const mode = input.mode ?? 'production';
  if (mode !== 'production' && mode !== 'test-loopback-only') invalid('mode must be production or test-loopback-only.');
  if (typeof input.rpName !== 'string' || input.rpName.trim() !== input.rpName || input.rpName.length === 0 || input.rpName.length > 64) invalid('rpName must be a non-empty trimmed string of at most 64 characters.');
  if (!Array.isArray(input.allowedOrigins) || input.allowedOrigins.length === 0 || input.allowedOrigins.length > MAX_ORIGINS) invalid(`allowedOrigins must list between 1 and ${String(MAX_ORIGINS)} origins.`);
  if (new Set(input.allowedOrigins).size !== input.allowedOrigins.length) invalid('allowedOrigins lists an origin twice.');

  if (mode === 'test-loopback-only') {
    if (input.rpId !== 'localhost') invalid("test-loopback-only requires rpId 'localhost'.");
    for (const origin of input.allowedOrigins) {
      const url = parseOrigin(origin);
      if (url.protocol !== 'http:' || url.hostname !== 'localhost') invalid(`test-loopback-only accepts only http://localhost origins, not '${origin}'.`);
    }
  } else {
    if (typeof input.rpId !== 'string' || !isDomainName(input.rpId)) invalid('rpId must be a lowercase registrable domain name (no scheme, port, path or IP address).');
    for (const origin of input.allowedOrigins) {
      const url = parseOrigin(origin);
      if (url.protocol !== 'https:') invalid(`'${origin}' is not https.`);
      if (url.hostname !== input.rpId && !url.hostname.endsWith(`.${input.rpId}`)) invalid(`'${origin}' is not on the RP ID '${input.rpId}' or one of its subdomains.`);
    }
  }
  return Object.freeze({ rpId: input.rpId, rpName: input.rpName, allowedOrigins: Object.freeze([...input.allowedOrigins]), mode });
}
