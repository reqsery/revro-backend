import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { requireAuth } from '@/lib/auth';

export const dynamic = 'force-dynamic';

// ── GET /api/plugin/status ────────────────────────────────────────────────────
// Frontend calls this to check whether the user's Roblox Studio plugin
// is currently connected and alive.
//
// A connection is considered "alive" if last_seen_at is within the last 15 seconds
// (plugin polls every 2s, so > 15s means it's gone).

export async function GET(request: NextRequest) {
  const user = await requireAuth(request);
  if (user instanceof NextResponse) return user;

  const { data: connection } = await supabaseAdmin
    .from('roblox_connections')
    .select('session_id, connected_at, last_seen_at')
    .eq('user_id', user.id)
    .eq('is_active', true)
    .single();

  if (!connection) {
    return NextResponse.json({ connected: false });
  }

  const lastSeen = new Date(connection.last_seen_at).getTime();
  const alive    = Date.now() - lastSeen < 15_000;

  // If the connection record is stale, mark it inactive
  if (!alive) {
    await supabaseAdmin
      .from('roblox_connections')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('session_id', connection.session_id);
  }

  return NextResponse.json({
    connected:    alive,
    session_id:   alive ? connection.session_id   : null,
    connected_at: alive ? connection.connected_at : null,
    last_seen_at: alive ? connection.last_seen_at : null,
  });
}
