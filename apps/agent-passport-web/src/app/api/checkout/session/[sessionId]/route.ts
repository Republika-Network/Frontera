/**
 * GET /api/checkout/session/[sessionId]
 *
 * Reads the status of a purchase, and for the organization_agent_registry tier
 * a non-secret registry summary.
 *
 * ## This route is UNAUTHENTICATED and therefore READ-ONLY
 *
 * A Stripe checkout session id is a bearer value: it travels in the success
 * URL, so it reaches browser history, shared links and proxy logs. Possession
 * of one is not proof of anything, so this route must never create privileged
 * state and must never disclose a credential.
 *
 * Concretely, and enforced by `__tests__/apw-001-checkout-disclosure.test.ts`:
 *
 *   - it does NOT create a registry;
 *   - it does NOT generate an admin access token or a recovery code;
 *   - it does NOT return either of them, under any key or any tier;
 *   - it performs no privileged state transition of any kind.
 *
 * Registry creation belongs to the Stripe webhook, which authenticates the
 * event by signature (`app/api/stripe/webhook/route.ts`). If the webhook has
 * not run, this route reports `registryPending` and stops. It does not
 * compensate by issuing credentials: an unavailable or misconfigured webhook
 * must fail closed, not fall back to unauthenticated issuance.
 *
 * The buyer's route to administrative access after payment is
 * `POST /api/organization-registry/recover` with `mode: 'checkout_session'`,
 * which requires the session id **and** the buyer contact email, and confirms
 * `payment_status === 'paid'` with Stripe directly before rotating.
 *
 * History: this route previously called `ensureOrganizationRegistry` and
 * returned `adminAccessToken` and `recoveryCode` in cleartext on first
 * creation. That was APW-001 in
 * `docs/security/AGENT_PASSPORT_WEB_THREAT_MODEL.md`.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getPurchaseByStripeSessionId } from '@/lib/purchase-repository';
import { getRegistryByPurchaseId, getEntitlementByRegistryId } from '@/lib/organization-registry-repository';

export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  { params }: { params: { sessionId: string } },
) {
  const { sessionId } = params;

  if (!sessionId) {
    return NextResponse.json({ ok: false, error: 'Missing sessionId' }, { status: 400 });
  }

  const purchase = getPurchaseByStripeSessionId(sessionId);

  if (!purchase) {
    return NextResponse.json(
      { ok: false, error: 'Session not found', canEnroll: false },
      { status: 404 },
    );
  }

  const canEnroll =
    purchase.status === 'completed' &&
    purchase.enrollmentStatus !== 'passport_issued';

  const base = {
    ok: true,
    purchase: {
      id: purchase.id,
      tier: purchase.tier,
      status: purchase.status,
      enrollmentStatus: purchase.enrollmentStatus,
      passportId: purchase.passportId,
    },
    canEnroll,
  };

  if (purchase.tier === 'organization_agent_registry') {
    // Read only. The registry is created by the signature-verified Stripe
    // webhook; this route observes that result and never produces it.
    const registry = getRegistryByPurchaseId(purchase.id);

    if (registry) {
      const entitlement = getEntitlementByRegistryId(registry.registryId);
      return NextResponse.json({
        ...base,
        canEnroll: false,
        registry: {
          registryId: registry.registryId,
          organizationName: registry.organizationName,
          registryStatus: registry.registryStatus,
          maxPassports: registry.maxPassports,
          issuedPassports: registry.issuedPassports,
          remainingPassports: registry.remainingPassports,
          entitlementStatus: entitlement?.status ?? null,
          adminAccessAvailable: false,
          profileCompleted: Boolean(registry.profileCompletedAt),
          message: 'Registry exists. Use the admin URL from your checkout confirmation to access the registry.',
        },
      });
    }

    // Fail closed: no registry yet means the webhook has not run. Reporting
    // that is the whole of this route's job — it does not create one.
    return NextResponse.json({
      ...base,
      canEnroll: false,
      registry: null,
      registryPending: true,
      message:
        'Registry is being prepared. If this persists, recover administrative access at /registry/recover using your checkout session id and buyer contact email, or contact support.',
    });
  }

  return NextResponse.json(base);
}
