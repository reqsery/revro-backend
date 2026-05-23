import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { PLAN_CONFIG } from '@/lib/credits';
import { type BillingInterval, type PlanKey } from '@/lib/whop-products';

export const dynamic = 'force-dynamic';

function isAuthorized(request: NextRequest): boolean {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return false;
  const header = request.headers.get('x-admin-secret') ?? '';
  return header.length === secret.length && header === secret;
}

function getCycleEnd(interval: BillingInterval): string {
  const end = new Date();
  end.setUTCMonth(end.getUTCMonth() + (interval === 'annual' ? 12 : 1));
  return end.toISOString();
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const revroUserId = String(body.revro_user_id ?? '').trim();
  const membershipId = String(body.whop_membership_id ?? '').trim();
  const plan = body.plan ? String(body.plan) as PlanKey : null;
  const interval = (body.interval === 'annual' ? 'annual' : 'monthly') as BillingInterval;

  if (!revroUserId || !membershipId) {
    return NextResponse.json({ error: 'revro_user_id and whop_membership_id are required' }, { status: 400 });
  }
  if (plan && !PLAN_CONFIG[plan]) {
    return NextResponse.json({ error: 'Unknown plan' }, { status: 400 });
  }

  const entitlementPatch = {
    revro_user_id: revroUserId,
    whop_user_id: body.whop_user_id ? String(body.whop_user_id) : null,
    whop_membership_id: membershipId,
    whop_product_id: body.whop_product_id ? String(body.whop_product_id) : null,
    whop_plan_id: body.whop_plan_id ? String(body.whop_plan_id) : null,
    plan,
    interval: plan ? interval : null,
    status: 'manual_linked',
    source: 'admin_relink',
    updated_at: new Date().toISOString(),
  };

  const { data: existing } = await supabaseAdmin
    .from('whop_entitlements')
    .select('id')
    .eq('whop_membership_id', membershipId)
    .maybeSingle();
  const entitlementQuery = existing?.id
    ? supabaseAdmin.from('whop_entitlements').update(entitlementPatch).eq('id', existing.id)
    : supabaseAdmin.from('whop_entitlements').insert(entitlementPatch);
  const { error: entitlementError } = await entitlementQuery;
  if (entitlementError) {
    console.warn('[Whop/admin-relink] Entitlement upsert failed', { revroUserId, membershipId, message: entitlementError.message });
    return NextResponse.json({ error: 'Could not relink entitlement' }, { status: 500 });
  }

  const userPatch: Record<string, unknown> = {
    whop_user_id: entitlementPatch.whop_user_id,
    whop_membership_id: membershipId,
    whop_product_id: entitlementPatch.whop_product_id,
    whop_plan_id: entitlementPatch.whop_plan_id,
    updated_at: new Date().toISOString(),
  };

  if (plan) {
    const config = PLAN_CONFIG[plan];
    userPatch.plan = plan;
    userPatch.plan_source = 'admin_relink';
    userPatch.monthly_wallet_balance = interval === 'annual'
      ? config.wallet_annual_usd
      : config.wallet_monthly_usd;
    userPatch.billing_cycle_start = new Date().toISOString();
    userPatch.billing_cycle_end = getCycleEnd(interval);
  }

  const { error: userError } = await supabaseAdmin
    .from('users')
    .update(userPatch)
    .eq('id', revroUserId);
  if (userError) {
    console.warn('[Whop/admin-relink] User update failed', { revroUserId, membershipId, message: userError.message });
    return NextResponse.json({ error: 'Could not update Revro user' }, { status: 500 });
  }

  console.log('[Whop/admin-relink] Membership linked', { revroUserId, membershipId, plan, interval });
  return NextResponse.json({ success: true });
}
