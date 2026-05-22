import { supabaseAdmin } from '@/lib/supabase';

export const PLUGIN_LIVE_WINDOW_MS = 60_000;

export type ActivePluginConnection = {
  session_id: string;
  connected_at: string;
  last_seen_at: string;
};

export async function getLivePluginConnection(
  userId: string,
  source: string,
): Promise<ActivePluginConnection | null> {
  const { data: connection, error } = await supabaseAdmin
    .from('roblox_connections')
    .select('session_id, connected_at, last_seen_at')
    .eq('user_id', userId)
    .eq('is_active', true)
    .order('last_seen_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error('[Plugin/status] Check failed', { source, userId, message: error.message });
    throw error;
  }

  const lastSeen = connection?.last_seen_at ? new Date(connection.last_seen_at).getTime() : 0;
  const connected = !!connection && Number.isFinite(lastSeen) && Date.now() - lastSeen <= PLUGIN_LIVE_WINDOW_MS;

  console.info('[Plugin/status] Checked', {
    source,
    userId,
    connected,
    lastSeenAgeMs: lastSeen ? Date.now() - lastSeen : null,
  });

  if (!connection || connected) return connection ?? null;

  const { error: staleError } = await supabaseAdmin
    .from('roblox_connections')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('session_id', connection.session_id)
    .eq('user_id', userId);

  if (staleError) {
    console.warn('[Plugin/status] Stale connection cleanup failed', {
      source,
      userId,
      message: staleError.message,
    });
  }

  return null;
}
