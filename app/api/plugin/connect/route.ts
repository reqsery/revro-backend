import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { randomUUID } from 'crypto';

export const dynamic = 'force-dynamic';

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getUserByApiKey(apiKey: string) {
  const { data, error } = await supabaseAdmin
    .from('api_keys')
    .select('user_id')
    .eq('key', apiKey)
    .single();
  if (error || !data) return null;
  return data.user_id as string;
}

// ── POST /api/plugin/connect ──────────────────────────────────────────────────
// Called by the Roblox Studio plugin on startup.
// Returns a session_id that the plugin uses for all subsequent calls.

export async function POST(request: NextRequest) {
  const apiKey = request.headers.get('x-api-key') ?? '';
  if (!apiKey) {
    return NextResponse.json({ error: 'Missing x-api-key header' }, { status: 401 });
  }

  const userId = await getUserByApiKey(apiKey);
  if (!userId) {
    return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
  }

  const sessionId = randomUUID();
  const now = new Date().toISOString();

  // Upsert: one active connection per user (deactivate old ones first)
  await supabaseAdmin
    .from('roblox_connections')
    .update({ is_active: false, updated_at: now })
    .eq('user_id', userId)
    .eq('is_active', true);

  const { error } = await supabaseAdmin
    .from('roblox_connections')
    .insert({
      user_id:      userId,
      session_id:   sessionId,
      is_active:    true,
      connected_at: now,
      last_seen_at: now,
      updated_at:   now,
    });

  if (error) {
    console.error('[Plugin/connect] DB insert error:', error.message);
    return NextResponse.json({ error: 'Failed to create session' }, { status: 500 });
  }

  console.log(`[Plugin/connect] user=${userId} session=${sessionId}`);
  return NextResponse.json({ session_id: sessionId, ok: true });
}

// ── DELETE /api/plugin/connect ────────────────────────────────────────────────
// Called by the plugin on shutdown / disconnect.

export async function DELETE(request: NextRequest) {
  const apiKey = request.headers.get('x-api-key') ?? '';
  if (!apiKey) {
    return NextResponse.json({ error: 'Missing x-api-key header' }, { status: 401 });
  }

  const userId = await getUserByApiKey(apiKey);
  if (!userId) {
    return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
  }

  const now = new Date().toISOString();
  await supabaseAdmin
    .from('roblox_connections')
    .update({ is_active: false, updated_at: now })
    .eq('user_id', userId)
    .eq('is_active', true);

  console.log(`[Plugin/connect] disconnect user=${userId}`);
  return NextResponse.json({ ok: true });
}
