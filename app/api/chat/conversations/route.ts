import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const user = await requireAuth(request);
  
  if (user instanceof NextResponse) {
    return user;
  }

  try {
    const { searchParams } = new URL(request.url);
    const type = searchParams.get('type'); // 'roblox' or 'discord'

    let query = supabaseAdmin
      .from('conversations')
      .select('*')
      .eq('user_id', user.id)
      .order('updated_at', { ascending: false });

    if (type) {
      query = query.eq('type', type);
    }

    const { data: conversations, error } = await query;

    if (error) {
      throw error;
    }

    return NextResponse.json(
      { conversations: conversations || [] },
      { headers: { 'Cache-Control': 'no-store' } }
    );

  } catch (error: any) {
    console.error('[Conversations list] Failed:', error?.message ?? 'Unknown error');
    return NextResponse.json(
      { error: 'Failed to fetch conversations' },
      { status: 500 }
    );
  }
}
