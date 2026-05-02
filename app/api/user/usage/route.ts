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
    const limit = parseInt(searchParams.get('limit') || '50');

    const { data: history, error } = await supabaseAdmin
      .from('usage_log')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      throw error;
    }

    return NextResponse.json({
      history: history || []
    });

  } catch (error) {
    console.error('Get usage history error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch usage history' },
      { status: 500 }
    );
  }
}
