import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';
import { PLAN_CONFIG } from '@/lib/credits';
import { type BillingInterval, type PlanKey } from '@/lib/whop-products';

export const dynamic = 'force-dynamic';

function isSupportUser(email: string | null | undefined): boolean {
  const allowlist = (process.env.REVRO_SUPPORT_EMAILS || process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((item) => item.toLowerCase().trim())
    .filter(Boolean);
  return Boolean(email && allowlist.includes(email.toLowerCase().trim()));
}

function getCycleEnd(interval: BillingInterval): string {
  const end = new Date();
  end.setUTCMonth(end.getUTCMonth() + (interval === 'annual' ? 12 : 1));
  return end.toISOString();
}

function canClaimEntitlement(entitlement: any): boolean {
  const status = String(entitlement.status ?? '').toLowerCase();
  const action = String(entitlement.last_event_action ?? '').toLowerCase();
  if (status === 'inactive' || status === 'cancelled' || status === 'expired') return false;
  if (action.includes('cancelled') || action.includes('expired') || action.includes('went_invalid')) return false;
  return status === 'unlinked'
    || status === 'active'
    || action === 'membership.created'
    || action === 'membership.went_valid'
    || action === 'membership.renewed'
    || action === 'payment.succeeded';
}

export async function POST(request: NextRequest) {
  const user = await requireAuth(request);
  if (user instanceof NextResponse) return user;

  if (!isSupportUser(user.email)) {
    console.warn('[Whop/claim] Rejected non-support claim attempt', { userId: user.id });
    return NextResponse.json(
      { error: 'Purchases are linked automatically by checkout email. Contact support to transfer a purchase.' },
      { status: 403 },
    );
  }

  const body = await request.json().catch(() => ({}));
  const membershipId = String(body.whop_membership_id ?? '').trim();
  if (!membershipId) {
    return NextResponse.json({ error: 'Whop membership ID is required' }, { status: 400 });
  }

  const { data: entitlement, error } = await supabaseAdmin
    .from('whop_entitlements')
    .select('*')
    .eq('whop_membership_id', membershipId)
    .maybeSingle();

  if (error) {
    console.warn('[Whop/claim] Lookup failed', { userId: user.id, membershipId, message: error.message });
    return NextResponse.json({ error: 'Could not look up purchase' }, { status: 500 });
  }

  if (!entitlement) {
    return NextResponse.json({ error: 'Purchase not found yet. Wait a minute after checkout, then try again.' }, { status: 404 });
  }

  if (!canClaimEntitlement(entitlement)) {
    console.warn('[Whop/claim] Inactive purchase cannot be claimed', {
      userId: user.id,
      membershipId,
      status: entitlement.status ?? null,
      lastEventAction: entitlement.last_event_action ?? null,
    });
    return NextResponse.json({ error: 'This purchase is not active and cannot be claimed.' }, { status: 409 });
  }

  if (entitlement.revro_user_id && entitlement.revro_user_id !== user.id) {
    console.warn('[Whop/claim] Already linked to another Revro account', { membershipId, requesterId: user.id });
    return NextResponse.json({ error: 'This purchase is already linked to another Revro account.' }, { status: 409 });
  }

  if (entitlement.revro_user_id === user.id && String(entitlement.status ?? '').toLowerCase() === 'claimed') {
    return NextResponse.json({ success: true, already_claimed: true });
  }

  const patchUser: Record<string, unknown> = {
    whop_user_id: entitlement.whop_user_id ?? null,
    whop_membership_id: entitlement.whop_membership_id ?? null,
    whop_product_id: entitlement.whop_product_id ?? null,
    whop_plan_id: entitlement.whop_plan_id ?? null,
    updated_at: new Date().toISOString(),
  };

  if (entitlement.plan) {
    const plan = entitlement.plan as PlanKey;
    const interval = (entitlement.interval ?? 'monthly') as BillingInterval;
    const config = PLAN_CONFIG[plan];
    if (!config) {
      console.warn('[Whop/claim] Unknown plan on entitlement', { userId: user.id, membershipId, plan });
      return NextResponse.json({ error: 'Purchase has an unknown plan. Contact support to relink it.' }, { status: 400 });
    }
    patchUser.plan = plan;
    patchUser.plan_source = 'whop_claimed';
    patchUser.monthly_wallet_balance = interval === 'annual'
      ? config.wallet_annual_usd
      : config.wallet_monthly_usd;
    patchUser.billing_cycle_start = new Date().toISOString();
    patchUser.billing_cycle_end = getCycleEnd(interval);
  }

  if (Number(entitlement.wallet_topup_amount ?? 0) > 0) {
    patchUser.extra_wallet_balance =
      Number(user.extra_wallet_balance ?? 0) + Number(entitlement.wallet_topup_amount);
  }

  const { error: userUpdateError } = await supabaseAdmin
    .from('users')
    .update(patchUser)
    .eq('id', user.id);
  if (userUpdateError) {
    console.warn('[Whop/claim] User update failed', { userId: user.id, membershipId, message: userUpdateError.message });
    return NextResponse.json({ error: 'Could not attach purchase to account' }, { status: 500 });
  }

  const { error: entitlementError } = await supabaseAdmin
    .from('whop_entitlements')
    .update({
      revro_user_id: user.id,
      status: 'claimed',
      source: 'claim_purchase',
      updated_at: new Date().toISOString(),
    })
    .eq('id', entitlement.id);
  if (entitlementError) {
    console.warn('[Whop/claim] Entitlement update failed', { userId: user.id, membershipId, message: entitlementError.message });
  }

  console.log('[Whop/claim] Purchase claimed', {
    userId: user.id,
    membershipId,
    plan: entitlement.plan ?? null,
    walletTopup: entitlement.wallet_topup_amount ?? null,
  });

  return NextResponse.json({ success: true });
}
