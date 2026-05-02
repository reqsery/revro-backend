import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

const DISCORD_API = 'https://discord.com/api/v10';

/** Fetch all guilds the Revro bot is currently in. */
async function fetchBotGuilds(token: string) {
  const res = await fetch(`${DISCORD_API}/users/@me/guilds`, {
    headers: { Authorization: `Bot ${token}` },
  });
  if (!res.ok) throw new Error(`Discord API ${res.status}`);
  const raw: any[] = await res.json();
  return raw.map(g => ({
    id: g.id,
    name: g.name,
    icon: g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png` : null,
    memberCount: g.approximate_member_count ?? null,
  }));
}

/**
 * GET /api/discord/guilds
 * Returns guilds the bot is in.
 * If the user has a saved discord_guild_id, that guild is returned first.
 * Other guilds are still included so the user can switch servers.
 */
export async function GET(request: NextRequest) {
  const user = await requireAuth(request);
  if (user instanceof NextResponse) return user;

  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    return NextResponse.json({ error: 'Discord bot is not configured' }, { status: 503 });
  }

  let allGuilds: ReturnType<typeof fetchBotGuilds> extends Promise<infer T> ? T : never;
  try {
    allGuilds = await fetchBotGuilds(token);
  } catch (e) {
    console.error('[Discord guilds] fetch failed:', e);
    return NextResponse.json({ error: 'Failed to fetch servers from Discord' }, { status: 502 });
  }

  // Read user's saved guild (soft-fail if column doesn't exist yet)
  let savedGuildId: string | null = null;
  try {
    const { data } = await supabaseAdmin
      .from('users')
      .select('discord_guild_id')
      .eq('id', user.id)
      .single();
    savedGuildId = data?.discord_guild_id ?? null;
  } catch {}

  // Put the saved guild first so the frontend can pre-select it
  if (savedGuildId) {
    allGuilds.sort((a, b) => (a.id === savedGuildId ? -1 : b.id === savedGuildId ? 1 : 0));
  }

  return NextResponse.json({ guilds: allGuilds, savedGuildId });
}

/**
 * POST /api/discord/guilds
 * Body: { guild_id, guild_name, guild_icon }
 * Saves the user's chosen server to their profile so it persists across sessions.
 */
export async function POST(request: NextRequest) {
  const user = await requireAuth(request);
  if (user instanceof NextResponse) return user;

  const { guild_id, guild_name, guild_icon } = await request.json();
  if (!guild_id) {
    return NextResponse.json({ error: 'guild_id is required' }, { status: 400 });
  }

  // Soft-fail — column may not exist yet on older deployments
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
