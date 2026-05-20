import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { getPluginApiKey, getUserIdByPluginApiKey } from '@/lib/plugin-auth';

export const dynamic = 'force-dynamic';

// ── Helpers ───────────────────────────────────────────────────────────────────

// ── POST /api/plugin/explorer ─────────────────────────────────────────────────
// Plugin pushes the current Roblox Studio explorer tree here.
// Stored on the connection record so the frontend/AI can read it.
// Body: { tree: object }

export async function POST(request: NextRequest) {
  const apiKey = getPluginApiKey(request);
  if (!apiKey) {
    return NextResponse.json({ error: 'Missing API key' }, { status: 401 });
  }

  const userId = await getUserIdByPluginApiKey(apiKey);
  if (!userId) {
    return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
  }

  let body: { tree?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (body.tree === undefined) {
    return NextResponse.json({ error: 'Missing tree' }, { status: 400 });
  }

  const now = new Date().toISOString();
  const { error: dbErr } = await supabaseAdmin
    .from('roblox_connections')
    .update({
      explorer_tree: body.tree,
      last_seen_at:  now,
      updated_at:    now,
    })
    .eq('user_id', userId)
    .eq('is_active', true);

  if (dbErr) {
    console.error('[Plugin/explorer] DB error:', dbErr.message);
    return NextResponse.json({ error: 'DB error' }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

// ── GET /api/plugin/explorer ──────────────────────────────────────────────────
// Frontend/AI reads the latest explorer tree for the authenticated user.
// Uses standard Bearer-token auth (user JWT).

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const token = authHeader.substring(7);
  const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(token);
  if (authErr || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { data: connection, error: dbErr } = await supabaseAdmin
    .from('roblox_connections')
    .select('explorer_tree, last_seen_at, connected_at')
    .eq('user_id', user.id)
    .eq('is_active', true)
    .single();

  if (dbErr || !connection) {
    return NextResponse.json({ connected: false, tree: null });
  }

  return NextResponse.json({
    connected:    true,
    tree:         connection.explorer_tree ?? null,
    last_seen_at: connection.last_seen_at,
    connected_at: connection.connected_at,
  });
}
