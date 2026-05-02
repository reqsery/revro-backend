import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { PLAN_CONFIG } from '@/lib/credits';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const user = await requireAuth(request);

  if (user instanceof NextResponse) {
    return user; // Return error response
  }

  const planConfig = PLAN_CONFIG[user.plan as keyof typeof PLAN_CONFIG];
  const imagesTotal = planConfig?.images_max ?? 0;

  // Fetch the user's primary API key (soft fail — never block the response)
  let apiKey: string | null = null;
  try {
    const { data: keyRow } = await supabaseAdmin
      .from('api_keys')
      .select('key')
      .eq('user_id', user.id)
      .order('created_at', { ascending: true })
      .limit(1)
      .single();
    apiKey = keyRow?.key ?? null;
  } catch {}

  return NextResponse.json({
    user: {
      id: user.id,
      email: user.email,
      display_name: user.display_name,
      plan: user.plan,
      credits_used: user.credits_used,
      credits_total: user.credits_total,
      images_generated: user.images_generated,
      images_total: imagesTotal,
      billing_cycle_start: user.billing_cycle_start,
      created_at: user.created_at,
      deletion_scheduled_at: user.deletion_scheduled_at ?? null,
      deletion_date: user.deletion_date ?? null,
      api_key: apiKey,
    }
  });
}
