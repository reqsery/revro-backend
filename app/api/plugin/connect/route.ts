import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { getPluginApiKey, getUserIdByPluginApiKey } from '@/lib/plugin-auth';
import { randomUUID } from 'crypto';

export const dynamic = 'force-dynamic';
const LATEST_PLUGIN_VERSION = '1.1.2';

// ── Helpers ───────────────────────────────────────────────────────────────────

// ── POST /api/plugin/connect ──────────────────────────────────────────────────
// Called by the Roblox Studio plugin on startup.
// Returns a session_id that the plugin uses for all subsequent calls.

export async function POST(request: NextRequest) {
  const apiKey = getPluginApiKey(request);
  if (!apiKey) {
    return NextResponse.json({ error: 'Missing API key' }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const pluginVersion = typeof body?.plugin_version === 'string' ? body.plugin_version : null;

  const userId = await getUserIdByPluginApiKey(apiKey);
  if (!userId) {
    console.warn('[Plugin/connect] Key not found');
    return NextResponse.json({ error: 'Invalid API key — copy the current key from revro.dev/dashboard/settings?tab=setup' }, { status: 401 });
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

  console.log('[Plugin/connect] Connected', {
    userId,
    sessionId,
    pluginVersion,
    latestPluginVersion: LATEST_PLUGIN_VERSION,
  });
  return NextResponse.json({ session_id: sessionId, ok: true, latest_plugin_version: LATEST_PLUGIN_VERSION });
}

// ── DELETE /api/plugin/connect ────────────────────────────────────────────────
// Called by the plugin on shutdown / disconnect.

export async function DELETE(request: NextRequest) {
  const apiKey = getPluginApiKey(request);
  if (!apiKey) {
    return NextResponse.json({ error: 'Missing API key' }, { status: 401 });
  }

  const userId = await getUserIdByPluginApiKey(apiKey);
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
