import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { PLAN_CONFIG } from '@/lib/credits';
import { sendPaymentFailedEmail, sendPaymentConfirmationEmail, sendSubscriptionCancelledEmail } from '@/lib/email';
import crypto from 'crypto';

export const dynamic = 'force-dynamic';

// ── Types ─────────────────────────────────────────────────────────────────────

type PlanKey = keyof typeof PLAN_CONFIG;

interface WhopUser {
  id: string;
  username?: string;
  email?: string;
}

interface WhopMembership {
  id: string;
  product_id: string;
  plan_id?: string;
  user: WhopUser;
  valid: boolean;
  status?: string;
  metadata?: Record<string, unknown>;
}

interface WhopPayment {
  id: string;
  membership_id?: string;
  user: WhopUser;
  amount?: number;
  status?: string;
}

interface WhopWebhookPayload {
  action: string;
  data: WhopMembership | WhopPayment;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Verify Whop webhook signature.
 * Whop sends HMAC-SHA256 of the raw body, hex-encoded, in the "whop-signature" header.
 */
function verifySignature(rawBody: string, signature: string, secret: string): boolean {
  if (!signature || !secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  try {
    const sigBuf = Buffer.from(signature, 'hex');
    const expBuf = Buffer.from(expected, 'hex');
    if (sigBuf.length !== expBuf.length) return false;
    return crypto.timingSafeEqual(sigBuf, expBuf);
  } catch {
    return false;
  }
}

/**
 * Map a Whop product_id or plan_id to an internal plan key.
 *
 * Set these env vars in Vercel:
 *   WHOP_PRODUCT_STARTER   – product_id for the Starter plan
 *   WHOP_PRODUCT_PRO       – product_id for the Pro plan
 *   WHOP_PRODUCT_STUDIO    – product_id for the Studio plan
 *
 * If you have separate annual products, add:
 *   WHOP_PRODUCT_STARTER_ANNUAL, WHOP_PRODUCT_PRO_ANNUAL, WHOP_PRODUCT_STUDIO_ANNUAL
 */
function buildProductMap(): Record<string, PlanKey> {
  const map: Record<string, PlanKey> = {};
  const pairs: [string, PlanKey][] = [
    ['WHOP_PRODUCT_STARTER',        'starter'],
    ['WHOP_PRODUCT_STARTER_ANNUAL', 'starter'],
    ['WHOP_PRODUCT_PRO',            'pro'],
    ['WHOP_PRODUCT_PRO_ANNUAL',     'pro'],
    ['WHOP_PRODUCT_STUDIO',         'studio'],
    ['WHOP_PRODUCT_STUDIO_ANNUAL',  'studio'],
  ];
  for (const [envKey, plan] of pairs) {
    const id = process.env[envKey];
    if (id) map[id] = plan;
  }
  return map;
}

function planFromProductId(productId: string): PlanKey | null {
  return buildProductMap()[productId] ?? null;
}

async function findUser(email: string) {
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('id, email, plan, credits_used, credits_total')
    .eq('email', email.toLowerCase())
    .single();
  if (error || !data) return null;
  return data;
}

async function applyPlan(userId: string, plan: PlanKey, resetCycle: boolean): Promise<void> {
  const config = PLAN_CONFIG[plan];
  const patch: Record<string, unknown> = {
    plan,
    credits_total: config.credits,
    updated_at: new Date().toISOString(),
  };
  if (resetCycle) {
    patch.credits_used        = 0;
    patch.images_generated    = 0;
    patch.billing_cycle_start = new Date().toISOString();
  }
  const { error } = await supabaseAdmin.from('users').update(patch).eq('id', userId);
  if (error) throw new Error(`DB update failed: ${error.message}`);
}

async function downgradeToFree(userId: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from('users')
    .update({
      plan:                'free',
      credits_total:       PLAN_CONFIG.free.credits,
      credits_used:        0,
      images_generated:    0,
      billing_cycle_start: new Date().toISOString(),
      updated_at:          new Date().toISOString(),
    })
    .eq('id', userId);
  if (error) throw new Error(`DB update failed: ${error.message}`);
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const secret    = process.env.WHOP_WEBHOOK_SECRET ?? '';
  const rawBody   = await request.text();
  const signature = request.headers.get('whop-signature') ?? '';

  if (!secret) {
    console.error('[Whop] WHOP_WEBHOOK_SECRET is not set');
    return NextResponse.json({ error: 'Webhook secret not configured' }, { status: 500 });
  }

  if (!verifySignature(rawBody, signature, secret)) {
    console.warn('[Whop] Rejected: invalid signature');
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  let payload: WhopWebhookPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { action, data } = payload;
  const membership = data as WhopMembership;
  const userEmail  = membership.user?.email?.toLowerCase().trim() ?? '';

  console.log(`[Whop] ${action} | email: ${userEmail || '(none)'}`);

  if (!userEmail) {
    console.error('[Whop] No user email in payload');
    return NextResponse.json({ error: 'No user email in payload' }, { status: 400 });
  }

  try {
    switch (action) {

      // ── membership.created / membership.went_valid ───────────────────────
      // New purchase: upgrade plan and reset billing cycle
      case 'membership.created':
      case 'membership.went_valid': {
        const plan = planFromProductId(membership.product_id ?? '');
        if (!plan) {
          console.warn(`[Whop] Unknown product_id "${membership.product_id}" — skipping`);
          return NextResponse.json({ received: true, note: 'Unknown product, skipped' });
        }

        const user = await findUser(userEmail);
        if (!user) {
          console.error(`[Whop] User not found: ${userEmail}`);
          return NextResponse.json({ error: 'User not found' }, { status: 404 });
        }

        const planChanged = user.plan !== plan;
        await applyPlan(user.id, plan, planChanged);
        console.log(`[Whop] ${action}: ${userEmail} → ${plan}${planChanged ? ' (cycle reset)' : ''}`);

        // Send payment confirmation email on new purchase
        if (planChanged) {
          sendPaymentConfirmationEmail(
            userEmail,
            userEmail.split('@')[0],
            plan.charAt(0).toUpperCase() + plan.slice(1),
            '',   // amount not in webhook
            'Monthly',
            'Next billing cycle',
            membership.id ?? '',
          ).catch(() => {});
        }
        break;
      }

      // ── membership.renewed / payment.succeeded ────────────────────────────
      // Billing cycle renewed: reset credits
      case 'membership.renewed':
      case 'payment.succeeded': {
        const user = await findUser(userEmail);
        if (!user) {
          console.error(`[Whop] User not found: ${userEmail}`);
          return NextResponse.json({ error: 'User not found' }, { status: 404 });
        }

        const plan = planFromProductId(membership.product_id ?? '') ?? (user.plan as PlanKey);
        if (!PLAN_CONFIG[plan] || plan === 'free') break;

        await applyPlan(user.id, plan, true);
        console.log(`[Whop] ${action}: ${userEmail} → credits reset (plan: ${plan})`);
        break;
      }

      // ── membership.cancelled / membership.expired / membership.went_invalid
      // Downgrade to free plan
      case 'membership.cancelled':
      case 'membership.expired':
      case 'membership.went_invalid': {
        const user = await findUser(userEmail);
        if (!user) {
          console.error(`[Whop] User not found: ${userEmail}`);
          return NextResponse.json({ error: 'User not found' }, { status: 404 });
        }

        const oldPlan = user.plan;
        await downgradeToFree(user.id);
        console.log(`[Whop] ${action}: ${userEmail} → downgraded to free`);

        // Send cancellation email
        sendSubscriptionCancelledEmail(
          userEmail,
          userEmail.split('@')[0],
          oldPlan.charAt(0).toUpperCase() + oldPlan.slice(1),
          'now',
        ).catch(() => {});
        break;
      }

      // ── payment.failed ────────────────────────────────────────────────────
      // Notify user — Whop handles retries, don't revoke access yet
      case 'payment.failed': {
        console.warn(`[Whop] payment.failed: ${userEmail}`);
        const user = await findUser(userEmail);
        sendPaymentFailedEmail(
          userEmail,
          user ? (userEmail.split('@')[0]) : userEmail,
          user ? (user.plan.charAt(0).toUpperCase() + user.plan.slice(1)) : 'your',
        ).catch(() => {});
        break;
      }

      default:
        console.log(`[Whop] Unhandled action "${action}" — acknowledged`);
    }

    return NextResponse.json({ received: true });

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Whop] Error handling "${action}":`, message);
    return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 });
  }
}
