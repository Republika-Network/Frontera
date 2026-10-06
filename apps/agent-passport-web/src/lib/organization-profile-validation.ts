export interface SanitizedProfile {
  organizationName: string;
  organizationWebsite: string | null;
  organizationCountry: string | null;
  organizationIndustry: string | null;
  organizationSize: string | null;
  organizationUseCase: string | null;
  buyerContactName: string | null;
  buyerContactEmail: string | null;
  buyerContactRole: string | null;
}

export type ProfileValidationResult =
  | { ok: true; profile: SanitizedProfile }
  | { ok: false; error: string; code: string };

function trimField(val: unknown, maxLen: number): string | null {
  if (val == null) return null;
  if (typeof val !== 'string') return null;
  // Strip control characters
  const cleaned = val.replace(/[\x00-\x1F\x7F]/g, '').trim();
  if (!cleaned) return null;
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) : cleaned;
}

function isValidEmail(email: string): boolean {
  if (email.length === 0 || email.length > 254) return false;

  const atIndex = email.indexOf('@');

  if (atIndex <= 0) return false;
  if (atIndex !== email.lastIndexOf('@')) return false;

  const domain = email.slice(atIndex + 1);

  if (domain.length === 0) return false;

  const dotIndex = domain.lastIndexOf('.');

  if (dotIndex <= 0 || dotIndex === domain.length - 1) return false;

  for (let index = 0; index < email.length; index += 1) {
    const code = email.charCodeAt(index);

    if (
      code === 0x20 || // space
      code === 0x09 || // tab
      code === 0x0a || // LF
      code === 0x0d    // CR
    ) {
      return false;
    }
  }

  return true;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function sanitizeOrganizationProfile(input: Record<string, unknown>): SanitizedProfile {
  // Not truncated: an oversized email must be rejected by isValidEmail, not shortened into a different address.
  const rawEmail = trimField(input.buyerContactEmail, Number.MAX_SAFE_INTEGER);
  const buyerContactEmail = rawEmail ? normalizeEmail(rawEmail) : null;

  return {
    organizationName: trimField(input.organizationName, 120) ?? '',
    organizationWebsite: trimField(input.organizationWebsite, 240),
    organizationCountry: trimField(input.organizationCountry, 80),
    organizationIndustry: trimField(input.organizationIndustry, 120),
    organizationSize: trimField(input.organizationSize, 80),
    organizationUseCase: trimField(input.organizationUseCase, 500),
    buyerContactName: trimField(input.buyerContactName, 120),
    buyerContactEmail: buyerContactEmail || null,
    buyerContactRole: trimField(input.buyerContactRole, 120),
  };
}

export function validateOrganizationProfile(input: Record<string, unknown>): ProfileValidationResult {
  const profile = sanitizeOrganizationProfile(input);

  if (!profile.organizationName) {
    return { ok: false, error: 'Organization name is required', code: 'ORGANIZATION_PROFILE_INVALID' };
  }
  if (!profile.buyerContactEmail) {
    return { ok: false, error: 'Buyer contact email is required', code: 'ORGANIZATION_PROFILE_INVALID' };
  }
  if (!isValidEmail(profile.buyerContactEmail)) {
    return { ok: false, error: 'Buyer contact email is not a valid email address', code: 'ORGANIZATION_PROFILE_INVALID' };
  }

  return { ok: true, profile };
}
