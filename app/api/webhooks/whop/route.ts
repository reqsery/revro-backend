import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { PLAN_CONFIG } from '@/lib/credits';
import { sendPaymentFailedEmail, sendPaymentConfirmationEmail, sendSubscriptionCancelledEmail } from '@/lib/email';
import { extractWhopMetadata, hashCheckoutToken, verifyCheckoutToken } from '@/lib/whop-linking';
import { productPlan, topupAmount, type ProductPlan } from '@/lib/whop-products';
import crypto from 'crypto';

export const dynamic = 'force-dynamic';

interface WhopUser {
  id?: string;
  username?: string;
  email?: string;
}

interface WhopMembership {
  id?: string;
  product_id?: string;
  plan_id?: string;
  user?: WhopUser;
  valid?: boolean;
  status?: string;
  metadata?: Record<string, unknown>;
}

interface WhopWebhookPayload {
  action: string;
  data: WhopMembership;
}

type ResolvedUser = {
  id: string;
  email: string;
  plan: string;
  extra_wallet_balance: unknown;
  source: 'metadata' | 'existing_link';
};

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

function getCycleEnd(interval: ProductPlan['interval']): string {
  const end = new Date();
  end.setUTCMonth(end.getUTCMonth() + (interval === 'annual' ? 12 : 1));
  return end.toISOString();
}

function productIdFor(membership: WhopMembership): string {
  return membership.plan_id ?? membership.product_id ?? '';
}

function safePayloadForStorage(payload: WhopWebhookPayload): Record<string, unknown> {
  return {
    action: payload.action,
    membership_id: payload.data?.id ?? null,
    product_id: payload.data?.product_id ?? null,
    plan_id: payload.data?.plan_id ?? null,
    whop_user_id: payload.data?.user?.id ?? null,
    status: payload.data?.status ?? null,
    valid: payload.data?.valid ?? null,
    has_email: Boolean(payload.data?.user?.email),
  };
}

async function findUserById(userId: string): Promise<ResolvedUser | null> {
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('id, email, plan, extra_wallet_balance')
    .eq('id', userId)
    .single();
  return error || !data ? null : { ...data, source: 'metadata' };
}

async function findUserByExistingLink(membership: WhopMembership): Promise<ResolvedUser | null> {
  const membershipId = membership.id ?? '';
  const whopUserId = membership.user?.id ?? '';

  let link: { revro_user_id: string | null } | null = null;
  if (membershipId) {
    const { data } = await supabaseAdmin
      .from('whop_entitlements')
      .select('revro_user_id')
      .eq('whop_membership_id', membershipId)
      .not('revro_user_id', 'is', null)
      .maybeSingle();
    link = data ?? null;
  }

  if (!link && whopUserId) {
    const { data } = await supabaseAdmin
      .from('users')
      .select('id')
      .eq('whop_user_id', whopUserId)
      .maybeSingle();
    if (data?.id) link = { revro_user_id: data.id };
  }

  if (!link?.revro_user_id) return null;
  const user = await findUserById(link.revro_user_id);
  return user ? { ...user, source: 'existing_link' } : null;
}

async function resolveUser(payload: WhopWebhookPayload, membership: WhopMembership): Promise<ResolvedUser | null> {
  const metadata = extractWhopMetadata(payload);
  const rawToken = typeof metadata.revro_checkout_token === 'string' ? metadata.revro_checkout_token : '';
  const tokenPayload = rawToken ? verifyCheckoutToken(rawToken) : null;

  if (tokenPayload?.revro_user_id) {
    const tokenHash = hashCheckoutToken(rawToken);
    const { data: session } = await supabaseAdmin
      .from('whop_checkout_sessions')
      .select('id, revro_user_id, expected_product_id, status')
      .eq('checkout_token_hash', tokenHash)
      .maybeSingle();

    if (session?.revro_user_id === tokenPayload.revro_user_id) {
      const actualProductId = productIdFor(membership);
      if (actualProductId && tokenPayload.expected_product_id !== actualProductId) {
        console.warn('[Whop] Metadata product mismatch', {
          expectedProductId: tokenPayload.expected_product_id,
          actualProductId,
        });
      }
      await supabaseAdmin
        .from('whop_checkout_sessions')
        .update({ status: 'claimed', claimed_at: new Date().toISOString() })
        .eq('id', session.id);
      return findUserById(tokenPayload.revro_user_id);
    }

    console.warn('[Whop] Checkout token did not match stored session', {
      hasSession: Boolean(session),
      metadataUserId: tokenPayload.revro_user_id,
    });
  }

  return findUserByExistingLink(membership);
}

async function upsertWhopEntitlement(args: {
  revroUserId: string | null;
  membership: WhopMembership;
  payload: WhopWebhookPayload;
  plan?: ProductPlan | null;
  topup?: number | null;
  status: string;
  source: string;
}): Promise<void> {
  const membershipId = args.membership.id ?? null;
  const patch = {
    revro_user_id: args.revroUserId,
    whop_user_id: args.membership.user?.id ?? null,
    whop_membership_id: membershipId,
    whop_product_id: args.membership.product_id ?? null,
    whop_plan_id: args.membership.plan_id ?? null,
    plan: args.plan?.plan ?? null,
    interval: args.plan?.interval ?? null,
    wallet_topup_amount: args.topup ?? null,
    status: args.status,
    source: args.source,
    last_event_action: args.payload.action,
    last_payload: safePayloadForStorage(args.payload),
    updated_at: new Date().toISOString(),
  };

  if (membershipId) {
    const { data: existing } = await supabaseAdmin
      .from('whop_entitlements')
      .select('id')
      .eq('whop_membership_id', membershipId)
      .maybeSingle();
    const query = existing?.id
      ? supabaseAdmin.from('whop_entitlements').update(patch).eq('id', existing.id)
      : supabaseAdmin.from('whop_entitlements').insert(patch);
    const { error } = await query;
    if (error) console.warn('[Whop] Entitlement upsert failed', { message: error.message });
    return;
  }

  const { error } = await supabaseAdmin.from('whop_entitlements').insert(patch);
  if (error) console.warn('[Whop] Entitlement insert failed', { message: error.message });
}

async function applyPlan(user: ResolvedUser, product: ProductPlan, resetCycle: boolean, membership: WhopMembership): Promise<void> {
  const config = PLAN_CONFIG[product.plan];
  const now = new Date().toISOString();
  const patch: Record<string, unknown> = {
    plan: product.plan,
    plan_source: 'whop',
    monthly_wallet_balance: product.interval === 'annual'
      ? config.wallet_annual_usd
      : config.wallet_monthly_usd,
    billing_cycle_end: getCycleEnd(product.interval),
    whop_user_id: membership.user?.id ?? null,
    whop_membership_id: membership.id ?? null,
    whop_product_id: membership.product_id ?? null,
    whop_plan_id: membership.plan_id ?? null,
    updated_at: now,
  };

  if (resetCycle) {
    patch.images_generated = 0;
    patch.low_credits_email_sent = false;
    patch.billing_cycle_start = now;
  }

  const { error } = await supabaseAdmin.from('users').update(patch).eq('id', user.id);
  if (error) throw new Error(`DB update failed: ${error.message}`);
}

async function downgradeToFree(user: ResolvedUser, membership: WhopMembership): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabaseAdmin.from('users').update({
    plan: 'free',
    plan_source: 'whop_cancelled',
    monthly_wallet_balance: 0,
    images_generated: 0,
    billing_cycle_start: now,
    billing_cycle_end: null,
    whop_membership_id: membership.id ?? null,
    whop_product_id: membership.product_id ?? null,
    whop_plan_id: membership.plan_id ?? null,
    updated_at: now,
  }).eq('id', user.id);
  if (error) throw new Error(`DB update failed: ${error.message}`);
}

async function addTopup(user: ResolvedUser, membership: WhopMembership, walletUsd: number): Promise<void> {
  const { error } = await supabaseAdmin.from('users').update({
    extra_wallet_balance: Number(user.extra_wallet_balance ?? 0) + walletUsd,
    whop_user_id: membership.user?.id ?? null,
    whop_product_id: membership.product_id ?? null,
    updated_at: new Date().toISOString(),
  }).eq('id', user.id);
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
  const productId = productIdFor(membership);
  const whopUserId = membership.user?.id ?? null;
  const userEmail = membership.user?.email?.toLowerCase().trim() ?? '';
  console.log('[Whop] Received', { action, productId, whopUserId, hasEmail: Boolean(userEmail) });

  try {
    const user = await resolveUser(payload, membership);
    const planProduct = productPlan(membership.plan_id) ?? productPlan(membership.product_id);
    const topup = topupAmount(membership.product_id ?? productId);

    if (!user && action !== 'payment.failed') {
      await upsertWhopEntitlement({
        revroUserId: null,
        membership,
        payload,
        plan: planProduct,
        topup,
        status: 'unlinked',
        source: 'webhook_unlinked',
      });
      console.warn('[Whop] Unlinked purchase stored for claim/relink', {
        action,
        productId,
        whopMembershipId: membership.id ?? null,
        whopUserId,
        hasEmail: Boolean(userEmail),
      });
      return NextResponse.json({ received: true, linked: false, note: 'Purchase stored for claim/relink' });
    }

    if (action === 'membership.created' || action === 'membership.went_valid') {
      if (!planProduct) {
        console.warn('[Whop] Unknown plan product ignored', { productId });
        return NextResponse.json({ received: true, note: 'Unknown product, skipped' });
      }
      const changed = user!.plan !== planProduct.plan;
      await applyPlan(user!, planProduct, true, membership);
      await upsertWhopEntitlement({
        revroUserId: user!.id,
        membership,
        payload,
        plan: planProduct,
        status: 'active',
        source: user!.source,
      });
      console.log('[Whop] Plan applied', {
        userId: user!.id,
        plan: planProduct.plan,
        interval: planProduct.interval,
        source: user!.source,
      });
      if (changed && userEmail) {
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
      if (topup !== null) {
        await addTopup(user!, membership, topup);
        await upsertWhopEntitlement({
          revroUserId: user!.id,
          membership,
          payload,
          topup,
          status: 'active',
          source: user!.source,
        });
        console.log('[Whop] Wallet top-up applied', { userId: user!.id, walletUsd: topup, source: user!.source });
      } else if (planProduct && planProduct.plan !== 'free') {
        await applyPlan(user!, planProduct, true, membership);
        await upsertWhopEntitlement({
          revroUserId: user!.id,
          membership,
          payload,
          plan: planProduct,
          status: 'active',
          source: user!.source,
        });
        console.log('[Whop] Included wallet reset', {
          userId: user!.id,
          plan: planProduct.plan,
          interval: planProduct.interval,
          source: user!.source,
        });
      }
    } else if (
      action === 'membership.cancelled'
      || action === 'membership.expired'
      || action === 'membership.went_invalid'
    ) {
      const oldPlan = user!.plan;
      await downgradeToFree(user!, membership);
      await upsertWhopEntitlement({
        revroUserId: user!.id,
        membership,
        payload,
        plan: planProduct,
        status: 'inactive',
        source: user!.source,
      });
      console.log('[Whop] Plan downgraded', { userId: user!.id, oldPlan, source: user!.source });
      if (userEmail) {
        sendSubscriptionCancelledEmail(
          userEmail,
          userEmail.split('@')[0],
          oldPlan.charAt(0).toUpperCase() + oldPlan.slice(1),
          'now',
        ).catch(() => {});
      }
    } else if (action === 'payment.failed') {
      console.warn('[Whop] payment.failed', { whopUserId, hasEmail: Boolean(userEmail), linkedUserId: user?.id ?? null });
      if (userEmail) {
        sendPaymentFailedEmail(
          userEmail,
          userEmail.split('@')[0],
          user ? user.plan.charAt(0).toUpperCase() + user.plan.slice(1) : 'your',
        ).catch(() => {});
      }
    } else {
      console.log('[Whop] Unhandled action acknowledged:', action);
    }

    return NextResponse.json({ received: true, linked: Boolean(user) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[Whop] Error handling action', { action, message });
    return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 });
  }
}
