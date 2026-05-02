import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { PLAN_CONFIG } from '@/lib/credits';
import crypto from 'crypto';

export const dynamic = 'force-dynamic';

// ── Types ─────────────────────────────────────────────────────────────────────

type PlanKey = keyof typeof PLAN_CONFIG;

interface LSSubscriptionAttributes {
  status: string;
  variant_name: string;
  user_email?: string;
  renews_at?: string | null;
  ends_at?: string | null;
  trial_ends_at?: string | null;
}

interface LSPayload {
  meta: {
    event_name: string;
    custom_data?: { user_email?: string };
  };
  data: {
    attributes: LSSubscriptionAttributes;
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Verify the X-Signature header using HMAC-SHA256.
 * LemonSqueezy signs the raw body with your webhook secret.
 */
function verifySignature(rawBody: string, signature: string, secret: string): boolean {
  if (!signature) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  try {
    // timingSafeEqual requires same-length buffers
    const sigBuf = Buffer.from(signature, 'hex');
    const expBuf = Buffer.from(expected, 'hex');
    if (sigBuf.length !== expBuf.length) return false;
    return crypto.timingSafeEqual(sigBuf, expBuf);
  } catch {
    return false;
  }
}

/**
 * Derive the internal plan key from the LemonSqueezy variant name.
 * Checks for the most specific match first (studio before pro).
 */
function parsePlan(variantName: string): PlanKey | null {
  const name = variantName.toLowerCase();
  if (name.includes('studio'))  return 'studio';
  if (name.includes('pro'))     return 'pro';
  if (name.includes('starter')) return 'starter';
  return null;
}

/** Look up a user row by email (case-insensitive). */
async function findUser(email: string) {
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('id, email, plan, credits_used, credits_total')
    .eq('email', email.toLowerCase())
    .single();

  if (error || !data) return null;
  return data;
}

/**
 * Apply a paid plan to a user.
 * @param resetCycle - When true, credits_used / images_generated reset to 0
 *                     and billing_cycle_start is updated. Use on plan changes
 *                     and successful payments.
 */
async function applyPlan(
  userId: string,
  plan: PlanKey,
  resetCycle: boolean,
): Promise<void> {
  const config = PLAN_CONFIG[plan];

  const patch: Record<string, unknown> = {
    plan,
    credits_total: config.credits,
    updated_at:   new Date().toISOString(),
  };

  if (resetCycle) {
    patch.credits_used          = 0;
    patch.images_generated      = 0;
    patch.billing_cycle_start   = new Date().toISOString();
  }

  const { error } = await supabaseAdmin
    .from('users')
    .update(patch)
    .eq('id', userId);

  if (error) throw new Error(`DB update failed: ${error.message}`);
}

/** Downgrade a user to the free plan and reset their cycle. */
async function downgradeToFree(userId: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from('users')
    .update({
      plan:                 'free',
      credits_total:        PLAN_CONFIG.free.credits,
      credits_used:         0,
      images_generated:     0,
      billing_cycle_start:  new Date().toISOString(),
      updated_at:           new Date().toISOString(),
    })
    .eq('id', userId);

  if (error) throw new Error(`DB update failed: ${error.message}`);
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  // Read the raw body first — needed for signature verification before parsing JSON
  const rawBody = await request.text();
  const signature = request.headers.get('x-signature') ?? '';
  const secret    = process.env.LEMONSQUEEZY_WEBHOOK_SECRET ?? '';

  // Guard: secret must be configured
  if (!secret) {
    console.error('[LS] LEMONSQUEEZY_WEBHOOK_SECRET is not set');
    return NextResponse.json({ error: 'Webhook secret not configured' }, { status: 500 });
  }

  // Verify signature before doing anything else
  if (!verifySignature(rawBody, signature, secret)) {
    console.warn('[LS] Rejected: invalid signature');
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  // Parse payload
  let payload: LSPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 });
  }

  const eventName   = payload.meta?.event_name ?? '';
  const attributes  = payload.data?.attributes ?? {} as LSSubscriptionAttributes;

  // Resolve email: prefer attributes.user_email, fall back to custom_data
  const userEmail = (
    attributes.user_email ??
    payload.meta?.custom_data?.user_email ??
    ''
  ).toLowerCase().trim();

  console.log(`[LS] ${eventName} | email: ${userEmail || '(none)'}`);

  if (!userEmail) {
    console.error('[LS] No user email in payload');
    return NextResponse.json({ error: 'No user email in payload' }, { status: 400 });
  }

  try {
    switch (eventName) {

      // ── Subscription created or updated ─────────────────────────────────
      case 'subscription_created':
      case 'subscription_updated': {
        const plan = parsePlan(attributes.variant_name ?? '');
        if (!plan) {
          console.warn(`[LS] Unknown variant "${attributes.variant_name}" — skipping`);
          return NextResponse.json({ received: true, note: 'Unknown variant, skipped' });
        }

        const user = await findUser(userEmail);
        if (!user) {
          console.error(`[LS] User not found: ${userEmail}`);
          return NextResponse.json({ error: 'User not found' }, { status: 404 });
        }

        // Reset the cycle when the plan actually changes; keep credits mid-cycle on same plan
        const planChanged = user.plan !== plan;
        await applyPlan(user.id, plan, planChanged);

        console.log(
          `[LS] ${eventName}: ${userEmail} → ${plan}` +
          (planChanged ? ' (cycle reset)' : ' (same plan, credits kept)'),
        );
        break;
      }

      // ── Payment success = billing cycle renewed ──────────────────────────
      case 'subscription_payment_success': {
        const user = await findUser(userEmail);
        if (!user) {
          console.error(`[LS] User not found: ${userEmail}`);
          return NextResponse.json({ error: 'User not found' }, { status: 404 });
        }

        // Determine plan from variant if present, otherwise keep current plan
        const planFromVariant = parsePlan(attributes.variant_name ?? '');
        const plan = planFromVariant ?? (user.plan as PlanKey);

        if (!PLAN_CONFIG[plan] || plan === 'free') {
          // Free users don't have payment events — something is odd, log and skip
          console.warn(`[LS] payment_success for free/unknown plan (${plan}) — skipping`);
          break;
        }

        // Always reset credits on a successful payment (new billing cycle)
        await applyPlan(user.id, plan, true);
        console.log(`[LS] payment_success: ${userEmail} → credits reset (plan: ${plan})`);
        break;
      }

      // ── Payment failed ───────────────────────────────────────────────────
      case 'subscription_payment_failed': {
        // Do not revoke access immediately — LemonSqueezy will retry and
        // eventually fire subscription_cancelled if it keeps failing.
        // Log so you can follow up manually if needed.
        const user = await findUser(userEmail);
        console.warn(
          `[LS] payment_failed: ${userEmail}` +
          (user ? ` (current plan: ${user.plan})` : ' (user not found)'),
        );
        break;
      }

      // ── Subscription cancelled or expired → downgrade to free ───────────
      case 'subscription_cancelled':
      case 'subscription_expired': {
        const user = await findUser(userEmail);
        if (!user) {
          console.error(`[LS] User not found: ${userEmail}`);
          return NextResponse.json({ error: 'User not found' }, { status: 404 });
        }

        await downgradeToFree(user.id);
        console.log(`[LS] ${eventName}: ${userEmail} → downgraded to free`);
        break;
      }

      // ── Unhandled event ──────────────────────────────────────────────────
      default:
        console.log(`[LS] Unhandled event type: "${eventName}" — acknowledged`);
    }

    return NextResponse.json({ received: true });

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[LS] Error handling "${eventName}":`, message);
    return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 });
  }
}
