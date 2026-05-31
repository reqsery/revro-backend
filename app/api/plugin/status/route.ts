import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { getLivePluginConnection } from '@/lib/plugin-connection';

export const dynamic = 'force-dynamic';
const LATEST_PLUGIN_VERSION = '1.1.4';

// ── GET /api/plugin/status ────────────────────────────────────────────────────
// Frontend calls this to check whether the user's Roblox Studio plugin
// is currently connected and alive.
//
export async function GET(request: NextRequest) {
  const user = await requireAuth(request);
  if (user instanceof NextResponse) return user;

  try {
    const connection = await getLivePluginConnection(user.id, 'status_route');
    const response = {
      connected: !!connection,
      session_id: connection?.session_id ?? null,
      connected_at: connection?.connected_at ?? null,
      last_seen_at: connection?.last_seen_at ?? null,
      latest_plugin_version: LATEST_PLUGIN_VERSION,
    };

    console.info('[Plugin/status] Response', {
      userId: user.id,
      connected: response.connected,
      sessionId: response.session_id,
      lastSeenAt: response.last_seen_at,
    });

    return NextResponse.json(response);
  } catch {
    return NextResponse.json({ error: 'Failed to check plugin status' }, { status: 500 });
  }
}
