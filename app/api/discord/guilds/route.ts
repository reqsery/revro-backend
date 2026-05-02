import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

const DISCORD_API = 'https://discord.com/api/v10';

async function fetchBotGuilds(token: string) {
  const res = await fetch(`${DISCORD_API}/users/@me/guilds`, {
    headers: { Authorization: `Bot ${token}` },
  });
  if (!res.ok) throw new Error(`Discord API ${res.status}`);
  const raw: any[] = await res.json();
  return raw.map(g => ({
    id:          g.id,
    name:        g.name,
    icon:        g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png` : null,
    memberCount: g.approximate_member_count ?? null,
  }));
}

/**
 * GET /api/discord/guilds
 *
 * If the user has connected their Discord account (discord_guild_ids stored),
 * returns only the servers where BOTH conditions are true:
 *   - The user is admin/owner (from their OAuth guilds)
 *   - The Revro bot is already in that server
 *
 * If not connected, returns { guilds: [], connected: false } so the frontend
 * shows a "Connect Discord" prompt instead of a server list.
 */
export async function GET(request: NextRequest) {
  const user = await requireAuth(request);
  if (user instanceof NextResponse) return user;

  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    return NextResponse.json({ error: 'Discord bot is not configured' }, { status: 503 });
  }

  // Read user's stored data (soft-fail if columns not yet migrated)
  let storedGuildIds: string[] | null = null;
  let savedGuildId:   string | null = null;
  try {
    const { data } = await supabaseAdmin
      .from('users')
      .select('discord_guild_ids, discord_guild_id')
      .eq('id', user.id)
      .single();
    if (data?.discord_guild_ids) {
      storedGuildIds = JSON.parse(data.discord_guild_ids);
    }
    savedGuildId = data?.discord_guild_id ?? null;
  } catch {}

  // User hasn't connected their Discord account yet
  if (!storedGuildIds) {
    return NextResponse.json({ guilds: [], connected: false, savedGuildId: null });
  }

  // Fetch all servers the bot is in
  let botGuilds: Awaited<ReturnType<typeof fetchBotGuilds>>;
  try {
    botGuilds = await fetchBotGuilds(token);
  } catch (e) {
    console.error('[Discord guilds] fetch failed:', e);
    return NextResponse.json({ error: 'Failed to fetch servers from Discord' }, { status: 502 });
  }

  // Intersection: only show guilds where user is admin AND bot is present
  const botGuildSet = new Set(botGuilds.map(g => g.id));
  const guilds = botGuilds.filter(g => storedGuildIds!.includes(g.id) && botGuildSet.has(g.id));

  // Put the saved (previously selected) guild first
  if (savedGuildId) {
    guilds.sort((a, b) => (a.id === savedGuildId ? -1 : b.id === savedGuildId ? 1 : 0));
  }

  return NextResponse.json({ guilds, connected: true, savedGuildId });
}

/**
 * POST /api/discord/guilds
 * Body: { guild_id }
 * Saves the user's chosen server to their profile for persistence.
 */
export async function POST(request: NextRequest) {
  const user = await requireAuth(request);
  if (user instanceof NextResponse) return user;

  const { guild_id } = await request.json();
  if (!guild_id) return NextResponse.json({ error: 'guild_id is required' }, { status: 400 });

  try {
    await supabaseAdmin
      .from('users')
      .update({ discord_guild_id: guild_id, updated_at: new Date().toISOString() })
      .eq('id', user.id);
  } catch (e) {
    console.warn('[Discord guilds] Could not save guild (column may be missing):', e);
  }

  return NextResponse.json({ ok: true });
}
