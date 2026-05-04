import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

const DISCORD_API = 'https://discord.com/api/v10';

interface BotGuild {
  id: string;
  name: string;
  icon: string | null;
  memberCount: number | null;
}

async function fetchBotGuilds(token: string): Promise<BotGuild[]> {
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
 * Returns the list of servers where the user is admin/owner.
 * For each server, marks whether the Revro bot is present.
 * If the user hasn't connected Discord yet → { guilds: [], connected: false }
 */
export async function GET(request: NextRequest) {
  const user = await requireAuth(request);
  if (user instanceof NextResponse) return user;

  // Read user's stored Discord data
  let storedGuildIds: string[] | null = null;
  let savedGuildId:   string | null = null;
  let userBotToken:   string | null = null;

  try {
    const { data } = await supabaseAdmin
      .from('users')
      .select('discord_guild_ids, discord_guild_id, discord_bot_token')
      .eq('id', user.id)
      .single();

    storedGuildIds = data?.discord_guild_ids ? JSON.parse(data.discord_guild_ids) : null;
    savedGuildId   = data?.discord_guild_id ?? null;
    userBotToken   = data?.discord_bot_token ?? null;
  } catch {}

  // User hasn't connected their Discord account yet
  if (!storedGuildIds || storedGuildIds.length === 0) {
    return NextResponse.json({ guilds: [], connected: false, savedGuildId: null });
  }

  // Try to get bot guild data for enrichment (soft-fail — works without it)
  const botToken = process.env.DISCORD_BOT_TOKEN
    || process.env.BOT_TOKEN
    || process.env.DISCORD_TOKEN
    || userBotToken;

  const botGuildMap = new Map<string, BotGuild>();
  if (botToken) {
    try {
      const botGuilds = await fetchBotGuilds(botToken);
      for (const g of botGuilds) botGuildMap.set(g.id, g);
    } catch (e) {
      console.warn('[Discord guilds] Bot guild fetch failed:', e);
    }
  }

  // Build the guild list — enrich with bot data where available
  const guilds = storedGuildIds.map(id => {
    const botGuild = botGuildMap.get(id);
    return {
      id,
      name:        botGuild?.name ?? `Server ${id}`,
      icon:        botGuild?.icon ?? null,
      memberCount: botGuild?.memberCount ?? null,
      botPresent:  botGuildMap.has(id),
    };
  });

  // Sort: saved guild first, then bot-present guilds, then the rest
  guilds.sort((a, b) => {
    if (a.id === savedGuildId)  return -1;
    if (b.id === savedGuildId)  return  1;
    if (a.botPresent && !b.botPresent) return -1;
    if (!a.botPresent && b.botPresent) return  1;
    return 0;
  });

  return NextResponse.json({ guilds, connected: true, savedGuildId });
}

/**
 * POST /api/discord/guilds
 * Body: { guild_id }
 * Saves the user's chosen server to their profile.
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
    console.warn('[Discord guilds] Could not save guild:', e);
  }

  return NextResponse.json({ ok: true });
}
