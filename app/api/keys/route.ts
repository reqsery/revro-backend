import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';
import crypto from 'crypto';

export const dynamic = 'force-dynamic';

/** Generate a secure random API key with a readable prefix. */
function generateApiKey(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(32);
  let key = '';
  for (let i = 0; i < 32; i++) key += chars[bytes[i] % chars.length];
  return `revro_${key}`;
}

/** GET /api/keys — list all API keys for the authenticated user (key_preview only, never full key) */
export async function GET(request: NextRequest) {
  const user = await requireAuth(request);
  if (user instanceof NextResponse) return user;

  const { data: keys, error } = await supabaseAdmin
    .from('api_keys')
    .select('id, name, key, created_at, last_used_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('[Keys] GET error:', error.message);
    return NextResponse.json({ error: 'Failed to fetch API keys' }, { status: 500 });
  }

  return NextResponse.json({
    keys: (keys ?? []).map(k => ({
      id: k.id,
      name: k.name,
      key_preview: k.key ? `${k.key.slice(0, 12)}${'•'.repeat(20)}` : '••••••••••••••••••••••••••••••••',
      created_at: k.created_at,
      last_used_at: k.last_used_at ?? null,
    })),
  });
}

/** POST /api/keys — create a new API key */
export async function POST(request: NextRequest) {
  const user = await requireAuth(request);
  if (user instanceof NextResponse) return user;

  const body = await request.json().catch(() => ({}));
  const name: string = (body.name ?? '').trim();

  if (!name) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 });
  }

  // Limit to 5 keys per user
  const { count } = await supabaseAdmin
    .from('api_keys')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user.id);

  if ((count ?? 0) >= 5) {
    return NextResponse.json({ error: 'Maximum of 5 API keys allowed' }, { status: 400 });
  }

  const key = generateApiKey();

  const { data: inserted, error } = await supabaseAdmin
    .from('api_keys')
    .insert({ user_id: user.id, name, key })
    .select('id')
    .single();

  if (error || !inserted) {
    console.error('[Keys] POST error:', error?.message);
    return NextResponse.json({ error: 'Failed to create API key' }, { status: 500 });
  }

  return NextResponse.json({ key, id: inserted.id });
}

/** DELETE /api/keys?id=<id> — delete a specific key */
export async function DELETE(request: NextRequest) {
  const user = await requireAuth(request);
  if (user instanceof NextResponse) return user;

  const id = new URL(request.url).searchParams.get('id');
  if (!id) {
    return NextResponse.json({ error: 'id is required' }, { status: 400 });
  }

  const { error } = await supabaseAdmin
    .from('api_keys')
    .delete()
    .eq('id', id)
    .eq('user_id', user.id);

  if (error) {
    console.error('[Keys] DELETE error:', error.message);
    return NextResponse.json({ error: 'Failed to delete API key' }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
