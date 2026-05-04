import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';
import { sendDeletionCancelledEmail } from '@/lib/email';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const user = await requireAuth(request);
  if (user instanceof NextResponse) return user;

  const { error } = await supabaseAdmin
    .from('users')
    .update({
      deletion_scheduled_at: null,
      deletion_date: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', user.id);

  if (error) {
    console.error('[Cancel-deletion] Failed to cancel deletion:', error);
    return NextResponse.json({ error: 'Failed to cancel account deletion' }, { status: 500 });
  }

  void sendDeletionCancelledEmail(user.email, user.display_name);

  return NextResponse.json({ message: 'Account deletion cancelled' });
}
