import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';
import { createCheckoutMetadata, hashCheckoutToken } from '@/lib/whop-linking';
import { productPlan, topupAmount } from '@/lib/whop-products';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const user = await requireAuth(request);
  if (user instanceof NextResponse) return user;

  const body = await request.json().catch(() => ({}));
  const checkoutId = String(body.checkout_id ?? body.plan_id ?? '').trim();
  if (!checkoutId) {
    return NextResponse.json({ error: 'checkout_id is required' }, { status: 400 });
  }

  const plan = productPlan(checkoutId);
  const topup = topupAmount(checkoutId);
  if (!plan && topup === null) {
    return NextResponse.json({ error: 'Unknown Whop checkout id' }, { status: 400 });
  }

  try {
    const { token, metadata } = createCheckoutMetadata({
      revro_user_id: user.id,
      expected_product_id: checkoutId,
      expected_plan: plan?.plan ?? null,
      expected_plan_id: checkoutId.startsWith('plan_') ? checkoutId : null,
      whop_user_id: user.whop_user_id ?? null,
    });

    const { error } = await supabaseAdmin.from('whop_checkout_sessions').insert({
      revro_user_id: user.id,
      checkout_token_hash: hashCheckoutToken(token),
      expected_plan: plan?.plan ?? null,
      expected_product_id: checkoutId,
      expected_plan_id: checkoutId.startsWith('plan_') ? checkoutId : null,
      expected_wallet_topup: topup,
      whop_user_id: user.whop_user_id ?? null,
      status: 'pending',
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });

    if (error) throw new Error(error.message);

    console.log('[Whop/checkout] Created signed session', {
      userId: user.id,
      checkoutId,
      expectedPlan: plan?.plan ?? null,
      walletTopup: topup,
    });

    return NextResponse.json({
      checkout_id: checkoutId,
      metadata,
      return_url: 'https://revro.dev/checkout/complete',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[Whop/checkout] Failed to create session', { userId: user.id, checkoutId, message });
    return NextResponse.json({ error: 'Failed to create checkout session' }, { status: 500 });
  }
}

