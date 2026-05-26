import { PLAN_CONFIG } from '@/lib/credits';
import { supabaseAdmin } from '@/lib/supabase';
import { type BillingInterval, type PlanKey } from '@/lib/whop-products';

type Entitlement = {
  id: string;
  revro_user_id: string | null;
  whop_user_id: string | null;
  whop_membership_id: string | null;
  whop_product_id: string | null;
  whop_plan_id: string | null;
  plan: PlanKey | null;
  interval: BillingInterval | null;
  wallet_topup_amount: number | string | null;
  status: string | null;
  source: string | null;
  last_event_action: string | null;
};

function getCycleEnd(interval: BillingInterval): string {
  const end = new Date();
  end.setUTCMonth(end.getUTCMonth() + (interval === 'annual' ? 12 : 1));
  return end.toISOString();
}

export function isClaimableWhopEntitlement(entitlement: Pick<Entitlement, 'status' | 'last_event_action'>): boolean {
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

async function applyEntitlement(userId: string, entitlement: Entitlement): Promise<boolean> {
  if (!isClaimableWhopEntitlement(entitlement)) return false;

  const { data: user, error: userError } = await supabaseAdmin
    .from('users')
    .select('id, extra_wallet_balance')
    .eq('id', userId)
    .single();

  if (userError || !user) {
    console.warn('[Whop/entitlements] User lookup failed', {
      userId,
      entitlementId: entitlement.id,
      message: userError?.message ?? 'not found',
    });
    return false;
  }

  const now = new Date().toISOString();
  const patchUser: Record<string, unknown> = {
    whop_user_id: entitlement.whop_user_id ?? null,
    whop_membership_id: entitlement.whop_membership_id ?? null,
    whop_product_id: entitlement.whop_product_id ?? null,
    whop_plan_id: entitlement.whop_plan_id ?? null,
    updated_at: now,
  };

  const topup = Number(entitlement.wallet_topup_amount ?? 0);
  if (topup > 0) {
    patchUser.extra_wallet_balance = Number(user.extra_wallet_balance ?? 0) + topup;
  } else if (entitlement.plan) {
    const plan = entitlement.plan;
    const config = PLAN_CONFIG[plan];
    if (!config) {
      console.warn('[Whop/entitlements] Unknown plan skipped', { userId, entitlementId: entitlement.id, plan });
      return false;
    }
    const interval = entitlement.interval ?? 'monthly';
    patchUser.plan = plan;
    patchUser.plan_source = 'whop_auto_linked';
    patchUser.monthly_wallet_balance = interval === 'annual'
      ? config.wallet_annual_usd
      : config.wallet_monthly_usd;
    patchUser.billing_cycle_start = now;
    patchUser.billing_cycle_end = getCycleEnd(interval);
    patchUser.images_generated = 0;
    patchUser.low_credits_email_sent = false;
  }

  const { error: updateError } = await supabaseAdmin
    .from('users')
    .update(patchUser)
    .eq('id', userId);
  if (updateError) {
    console.warn('[Whop/entitlements] User update failed', { userId, entitlementId: entitlement.id, message: updateError.message });
    return false;
  }

  const { error: entitlementError } = await supabaseAdmin
    .from('whop_entitlements')
    .update({
      revro_user_id: userId,
      status: 'claimed',
      source: topup > 0 ? 'auto_email_topup' : 'auto_email_plan',
      updated_at: now,
    })
    .eq('id', entitlement.id);
  if (entitlementError) {
    console.warn('[Whop/entitlements] Entitlement mark claimed failed', {
      userId,
      entitlementId: entitlement.id,
      message: entitlementError.message,
    });
  }

  console.log('[Whop/entitlements] Pending entitlement attached', {
    userId,
    entitlementId: entitlement.id,
    plan: entitlement.plan ?? null,
    walletTopup: topup || null,
  });
  return true;
}

export async function attachPendingWhopEntitlementsForUser(userId: string, email: string | null | undefined): Promise<number> {
  const buyerEmail = String(email ?? '').toLowerCase().trim();
  if (!buyerEmail) return 0;

  const { data, error } = await supabaseAdmin
    .from('whop_entitlements')
    .select('*')
    .eq('buyer_email', buyerEmail)
    .is('revro_user_id', null)
    .in('status', ['unlinked', 'active'])
    .order('created_at', { ascending: true });

  if (error) {
    console.warn('[Whop/entitlements] Pending lookup failed', { userId, hasEmail: true, message: error.message });
    return 0;
  }

  let attached = 0;
  for (const entitlement of (data ?? []) as Entitlement[]) {
    if (await applyEntitlement(userId, entitlement)) attached += 1;
  }
  return attached;
}
