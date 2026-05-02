import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';
import { fireResendEvent } from '@/lib/resend';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const user = await requireAuth(request);
  if (user instanceof NextResponse) return user;

  const now = new Date();
  const deletionDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  const { error } = await supabaseAdmin
    .from('users')
    .update({
      deletion_scheduled_at: now.toISOString(),
      deletion_date: deletionDate.toISOString(),
      updated_at: now.toISOString(),
    })
    .eq('id', user.id);

  if (error) {
    console.error('[Delete] Failed to schedule deletion:', error);
    return NextResponse.json({ error: 'Failed to schedule account deletion' }, { status: 500 });
  }

  const deletionDateStr = deletionDate.toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
  });

  void fireResendEvent('user.deletion_scheduled', user.email, user.display_name, {
    first_name: user.display_name,
    deletion_date: deletionDateStr,
  });

  return NextResponse.json({
    message: 'Account deletion scheduled',
    deletionDate: deletionDate.toISOString(),
  });
}
