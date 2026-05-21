import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';
import { PLAN_CONFIG } from '@/lib/credits';

export const dynamic = 'force-dynamic';

export async function PUT(request: NextRequest) {
  const user = await requireAuth(request);
  if (user instanceof NextResponse) return user;

  try {
    const body = await request.json();
    const displayName = body.displayName ?? body.display_name;

    if (!displayName || typeof displayName !== 'string') {
      return NextResponse.json({ error: 'displayName is required' }, { status: 400 });
    }

    const { data: updated, error } = await supabaseAdmin
      .from('users')
      .update({ display_name: displayName.trim(), updated_at: new Date().toISOString() })
      .eq('id', user.id)
      .select('*')
      .single();

    if (error || !updated) {
      console.error('[Update user] DB error:', error);
      return NextResponse.json({ error: 'Failed to update profile' }, { status: 500 });
    }

    try {
      const { data: authData } = await supabaseAdmin.auth.admin.getUserById(user.id);
      const authError = (await supabaseAdmin.auth.admin.updateUserById(user.id, {
        user_metadata: {
          ...(authData?.user?.user_metadata ?? {}),
          display_name: updated.display_name,
          full_name: updated.display_name,
        },
      })).error;
      if (authError) console.warn('[Update user] Auth metadata sync failed:', authError.message);
    } catch (authErr) {
      console.warn('[Update user] Auth metadata sync error:', authErr);
    }

    const planConfig = PLAN_CONFIG[updated.plan as keyof typeof PLAN_CONFIG];

    return NextResponse.json({
      user: {
        id: updated.id,
        email: updated.email,
        display_name: updated.display_name,
        plan: updated.plan,
        credits_used: updated.credits_used,
        credits_total: updated.credits_total,
        images_generated: updated.images_generated,
        images_total: planConfig?.images_max ?? 0,
        billing_cycle_start: updated.billing_cycle_start,
        created_at: updated.created_at,
        deletion_scheduled_at: updated.deletion_scheduled_at ?? null,
        deletion_date: updated.deletion_date ?? null,
      }
    });
  } catch (err) {
    console.error('[Update user] Error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
