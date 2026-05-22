import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { PLAN_CONFIG } from '@/lib/credits';
import { sendPaymentFailedEmail, sendPaymentConfirmationEmail, sendSubscriptionCancelledEmail } from '@/lib/email';
import crypto from 'crypto';

export const dynamic = 'force-dynamic';

type PlanKey = keyof typeof PLAN_CONFIG;
type BillingInterval = 'monthly' | 'annual';
type ProductPlan = { plan: PlanKey; interval: BillingInterval };

interface WhopUser {
  id: string;
  username?: string;
  email?: string;
}

interface WhopMembership {
  id: string;
  product_id?: string;
  plan_id?: string;
  user: WhopUser;
  valid: boolean;
  status?: string;
  metadata?: Record<string, unknown>;
}

interface WhopWebhookPayload {
  action: string;
  data: WhopMembership;
}

function verifySignature(rawBody: string, signature: string, secret: string): boolean {
  if (!signature || !secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  try {
    const signatureBuffer = Buffer.from(signature, 'hex');
    const expectedBuffer = Buffer.from(expected, 'hex');
    return signatureBuffer.length === expectedBuffer.length
      && crypto.timingSafeEqual(signatureBuffer, expectedBuffer);
  } catch {
    return false;
  }
}

const PLAN_ID_MAP: Record<string, ProductPlan> = {
  // Legacy Starter IDs now grant the new Dev entitlement.
  plan_yCxCQdTcuq3PB: { plan: 'dev', interval: 'monthly' },
  plan_A3XtiQtFwUQO2: { plan: 'dev', interval: 'annual' },
  plan_X2F8Ukz2xXIkE: { plan: 'pro', interval: 'monthly' },
  plan_TF2t36B0XIYCy: { plan: 'pro', interval: 'annual' },
  plan_NJdBfHx3gQxCF: { plan: 'studio', interval: 'monthly' },
  plan_Ynaroe3Otw4QK: { plan: 'studio', interval: 'annual' },
};

const LEGACY_TOPUP_PRODUCTS: Record<string, number> = {
  prod_bQhlR7Fonc4Oy: 5,
  prod_ii4z8el4KTeXA: 10,
  prod_ykaAhgAMdOI7Y: 25,
};

function buildProductMap(): Record<string, ProductPlan> {
  const map: Record<string, ProductPlan> = {};
  const entries: [string, PlanKey, BillingInterval][] = [
    ['WHOP_PRODUCT_DEV', 'dev', 'monthly'],
    ['WHOP_PRODUCT_DEV_ANNUAL', 'dev', 'annual'],
    ['WHOP_PRODUCT_STARTER', 'dev', 'monthly'],
    ['WHOP_PRODUCT_STARTER_ANNUAL', 'dev', 'annual'],
    ['WHOP_PRODUCT_PRO', 'pro', 'monthly'],
    ['WHOP_PRODUCT_PRO_ANNUAL', 'pro', 'annual'],
    ['WHOP_PRODUCT_STUDIO', 'studio', 'monthly'],
    ['WHOP_PRODUCT_STUDIO_ANNUAL', 'studio', 'annual'],
  ];
  for (const [envKey, plan, interval] of entries) {
    const productId = process.env[envKey];
    if (productId) map[productId] = { plan, interval };
  }
  return map;
}

function buildTopupMap(): Record<string, number> {
  const map = { ...LEGACY_TOPUP_PRODUCTS };
  const entries: [string, number][] = [
    ['WHOP_TOPUP_5', 5],
    ['WHOP_TOPUP_10', 10],
    ['WHOP_TOPUP_25', 25],
    ['WHOP_TOPUP_50', 50],
    // Keep existing production env names valid during Whop product migration.
    ['WHOP_PACK_SMALL', 5],
    ['WHOP_PACK_MEDIUM', 10],
    ['WHOP_PACK_LARGE', 25],
  ];
  for (const [envKey, walletUsd] of entries) {
    const productId = process.env[envKey];
    if (productId) map[productId] = walletUsd;
  }
  return map;
}

function productPlan(productId: string): ProductPlan | null {
  return PLAN_ID_MAP[productId] ?? buildProductMap()[productId] ?? null;
}

function getCycleEnd(interval: BillingInterval): string {
  const end = new Date();
  end.setUTCMonth(end.getUTCMonth() + (interval === 'annual' ? 12 : 1));
  return end.toISOString();
}

async function findUser(email: string) {
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('id, email, plan, extra_wallet_balance')
    .eq('email', email.toLowerCase())
    .single();
  return error || !data ? null : data;
}

async function applyPlan(userId: string, product: ProductPlan, resetCycle: boolean): Promise<void> {
  const config = PLAN_CONFIG[product.plan];
  const now = new Date().toISOString();
  const patch: Record<string, unknown> = {
    plan: product.plan,
    plan_source: 'whop',
    monthly_wallet_balance: product.interval === 'annual'
      ? config.wallet_annual_usd
      : config.wallet_monthly_usd,
    billing_cycle_end: getCycleEnd(product.interval),
    updated_at: now,
  };

  if (resetCycle) {
    patch.images_generated = 0;
    patch.low_credits_email_sent = false;
    patch.billing_cycle_start = now;
  }

  const { error } = await supabaseAdmin.from('users').update(patch).eq('id', userId);
  if (error) throw new Error(`DB update failed: ${error.message}`);
}

async function downgradeToFree(userId: string): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabaseAdmin.from('users').update({
    plan: 'free',
    plan_source: 'whop_cancelled',
    monthly_wallet_balance: 0,
    images_generated: 0,
    billing_cycle_start: now,
    billing_cycle_end: null,
    updated_at: now,
  }).eq('id', userId);
  if (error) throw new Error(`DB update failed: ${error.message}`);
}

async function addTopup(userId: string, currentExtraWallet: unknown, walletUsd: number): Promise<void> {
  const { error } = await supabaseAdmin.from('users').update({
    extra_wallet_balance: Number(currentExtraWallet ?? 0) + walletUsd,
    updated_at: new Date().toISOString(),
  }).eq('id', userId);
  if (error) throw new Error(`DB update failed: ${error.message}`);
}

export async function POST(request: NextRequest) {
  const secret = process.env.WHOP_WEBHOOK_SECRET ?? '';
  const rawBody = await request.text();
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

  const { action, data: membership } = payload;
  const userEmail = membership.user?.email?.toLowerCase().trim() ?? '';
  const productId = membership.plan_id ?? membership.product_id ?? '';
  console.log('[Whop] Received', { action, email: userEmail || '(none)', productId });
  if (!userEmail) return NextResponse.json({ error: 'No user email in payload' }, { status: 400 });

  try {
    const user = await findUser(userEmail);
    if (!user && action !== 'payment.failed') {
      console.error('[Whop] User not found:', userEmail);
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    if (action === 'membership.created' || action === 'membership.went_valid') {
      const planProduct = productPlan(membership.plan_id ?? '') ?? productPlan(membership.product_id ?? '');
      if (!planProduct) {
        console.warn('[Whop] Unknown plan product ignored', { productId });
        return NextResponse.json({ received: true, note: 'Unknown product, skipped' });
      }
      const changed = user!.plan !== planProduct.plan;
      await applyPlan(user!.id, planProduct, true);
      console.log('[Whop] Plan applied', { userId: user!.id, plan: planProduct.plan, interval: planProduct.interval });
      if (changed) {
        sendPaymentConfirmationEmail(
          userEmail,
          userEmail.split('@')[0],
          planProduct.plan.charAt(0).toUpperCase() + planProduct.plan.slice(1),
          '',
          planProduct.interval === 'annual' ? 'Annual' : 'Monthly',
          'Next billing cycle',
          membership.id ?? '',
        ).catch(() => {});
      }
    } else if (action === 'membership.renewed' || action === 'payment.succeeded') {
      const topup = buildTopupMap()[membership.product_id ?? productId];
      if (topup !== undefined) {
        await addTopup(user!.id, user!.extra_wallet_balance, topup);
        console.log('[Whop] Wallet top-up applied', { userId: user!.id, walletUsd: topup });
      } else {
        const planProduct = productPlan(membership.plan_id ?? '') ?? productPlan(productId);
        if (planProduct && planProduct.plan !== 'free') {
          await applyPlan(user!.id, planProduct, true);
          console.log('[Whop] Included wallet reset', {
            userId: user!.id,
            plan: planProduct.plan,
            interval: planProduct.interval,
          });
        }
      }
    } else if (
      action === 'membership.cancelled'
      || action === 'membership.expired'
      || action === 'membership.went_invalid'
    ) {
      const oldPlan = user!.plan;
      await downgradeToFree(user!.id);
      console.log('[Whop] Plan downgraded', { userId: user!.id, oldPlan });
      sendSubscriptionCancelledEmail(
        userEmail,
        userEmail.split('@')[0],
        oldPlan.charAt(0).toUpperCase() + oldPlan.slice(1),
        'now',
      ).catch(() => {});
    } else if (action === 'payment.failed') {
      console.warn('[Whop] payment.failed:', userEmail);
      sendPaymentFailedEmail(
        userEmail,
        userEmail.split('@')[0],
        user ? user.plan.charAt(0).toUpperCase() + user.plan.slice(1) : 'your',
      ).catch(() => {});
    } else {
      console.log('[Whop] Unhandled action acknowledged:', action);
    }

    return NextResponse.json({ received: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[Whop] Error handling action', { action, message });
    return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 });
  }
}
