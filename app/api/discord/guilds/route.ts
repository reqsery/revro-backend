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

type StoredGuild = {
  id: string;
  name?: string;
  icon?: string | null;
};

function json(data: unknown, init?: ResponseInit) {
  const response = NextResponse.json(data, init);
  response.headers.set('Cache-Control', 'no-store, max-age=0');
  return response;
}

function normalizeStoredGuilds(value: unknown): StoredGuild[] {
  const parsedGuilds: unknown = typeof value === 'string'
    ? JSON.parse(value)
    : value;

  if (!Array.isArray(parsedGuilds)) return [];

  return parsedGuilds
    .map((guild: any) => typeof guild === 'string'
      ? { id: guild }
      : {
          id: typeof guild?.id === 'string' ? guild.id : '',
          name: typeof guild?.name === 'string' ? guild.name : undefined,
          icon: typeof guild?.icon === 'string' ? guild.icon : null,
        })
    .filter((guild: StoredGuild) => guild.id);
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
  let storedGuilds: StoredGuild[] | null = null;
  let savedGuildId:   string | null = null;
  let userBotToken:   string | null = null;

  try {
    const { data, error } = await supabaseAdmin
      .from('users')
      .select('discord_guild_ids, discord_guild_id, discord_bot_token')
      .eq('id', user.id)
      .single();

    if (error) throw error;
    storedGuilds = data?.discord_guild_ids ? normalizeStoredGuilds(data.discord_guild_ids) : [];
    savedGuildId   = data?.discord_guild_id ?? null;
    userBotToken   = data?.discord_bot_token ?? null;
  } catch (error) {
    console.warn('[Discord/guilds] List failed', {
      userId: user.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return json({ error: 'Failed to load Discord servers' }, { status: 500 });
  }

  // Try to get bot guild data for enrichment (soft-fail — works without it)
  const botToken = userBotToken
    || process.env.DISCORD_BOT_TOKEN
    || process.env.BOT_TOKEN
    || process.env.DISCORD_TOKEN;

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
  // If the user connected a personal bot token but has not completed OAuth yet,
  // use that token as a live DB-backed source so Settings and Chat agree.
  // Do not expose the global bot guild list as a fallback for users without OAuth.
  if ((!storedGuilds || storedGuilds.length === 0) && userBotToken && botGuildMap.size > 0) {
    const guilds = Array.from(botGuildMap.values()).map(guild => ({
      ...guild,
      botPresent: true,
    }));
    const savedGuildStillValid = savedGuildId ? guilds.some(guild => guild.id === savedGuildId) : true;
    if (!savedGuildStillValid) {
      await supabaseAdmin
        .from('users')
        .update({ discord_guild_id: null, updated_at: new Date().toISOString() })
        .eq('id', user.id);
      savedGuildId = null;
    }
    console.info('[Discord/guilds] Listed', {
      userId: user.id,
      connected: true,
      source: 'user_bot_token',
      storedGuilds: 0,
      botGuilds: botGuildMap.size,
      savedGuildId,
    });
    return json({ guilds, connected: true, savedGuildId });
  }

  // User hasn't connected Discord OAuth or a personal bot token.
  if (!storedGuilds || storedGuilds.length === 0) {
    console.info('[Discord/guilds] Listed', {
      userId: user.id,
      connected: false,
      storedGuilds: 0,
      botGuilds: 0,
      savedGuildId: null,
    });
    return json({ guilds: [], connected: false, savedGuildId: null });
  }

  const guilds = storedGuilds.map(storedGuild => {
    const botGuild = botGuildMap.get(storedGuild.id);
    return {
      id:          storedGuild.id,
      name:        botGuild?.name ?? storedGuild.name ?? `Server ${storedGuild.id}`,
      icon:        botGuild?.icon
        ?? (storedGuild.icon ? `https://cdn.discordapp.com/icons/${storedGuild.id}/${storedGuild.icon}.png` : null),
      memberCount: botGuild?.memberCount ?? null,
      botPresent:  botGuildMap.has(storedGuild.id),
    };
  });

  const savedGuildStillValid = savedGuildId ? guilds.some(guild => guild.id === savedGuildId) : true;
  if (!savedGuildStillValid) {
    console.warn('[Discord/guilds] Clearing stale saved guild', {
      userId: user.id,
      savedGuildId,
      guildCount: guilds.length,
    });
    await supabaseAdmin
      .from('users')
      .update({ discord_guild_id: null, updated_at: new Date().toISOString() })
      .eq('id', user.id);
    savedGuildId = null;
  }

  // Sort: saved guild first, then bot-present guilds, then the rest
  guilds.sort((a, b) => {
    if (a.id === savedGuildId)  return -1;
    if (b.id === savedGuildId)  return  1;
    if (a.botPresent && !b.botPresent) return -1;
    if (!a.botPresent && b.botPresent) return  1;
    return 0;
  });

  console.info('[Discord/guilds] Listed', {
    userId: user.id,
    connected: true,
    storedGuilds: storedGuilds.length,
    botGuilds: botGuildMap.size,
    savedGuildId,
  });

  return json({ guilds, connected: true, savedGuildId });
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
  if (!guild_id || typeof guild_id !== 'string') return json({ error: 'guild_id is required' }, { status: 400 });

  try {
    const { data, error: readError } = await supabaseAdmin
      .from('users')
      .select('discord_guild_ids, discord_bot_token')
      .eq('id', user.id)
      .single();

    if (readError) throw readError;

    const storedGuilds = data?.discord_guild_ids ? normalizeStoredGuilds(data.discord_guild_ids) : [];
    let guildAllowed = storedGuilds.some(guild => guild.id === guild_id);
    if (!guildAllowed && data?.discord_bot_token) {
      try {
        const botGuilds = await fetchBotGuilds(data.discord_bot_token);
        guildAllowed = botGuilds.some(guild => guild.id === guild_id);
      } catch (error) {
        console.warn('[Discord/guilds] User bot guild validation failed', {
          userId: user.id,
          guildId: guild_id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (!guildAllowed) {
      console.warn('[Discord/guilds] Save rejected for unknown guild', {
        userId: user.id,
        guildId: guild_id,
        storedGuilds: storedGuilds.length,
      });
      return json({ error: 'Reconnect Discord or choose a server from your current server list.' }, { status: 404 });
    }

    const { error: updateError } = await supabaseAdmin
      .from('users')
      .update({ discord_guild_id: guild_id, updated_at: new Date().toISOString() })
      .eq('id', user.id);

    if (updateError) throw updateError;

    console.info('[Discord/guilds] Saved selected guild', {
      userId: user.id,
      guildId: guild_id,
    });
  } catch (e) {
    console.warn('[Discord/guilds] Save failed', {
      userId: user.id,
      guildId: guild_id,
      error: e instanceof Error ? e.message : String(e),
    });
    return json({ error: 'Failed to save Discord server selection' }, { status: 500 });
  }

  return json({ ok: true, savedGuildId: guild_id });
}

/**
 * DELETE /api/discord/guilds
 * Clears the user's chosen server.
 */
export async function DELETE(request: NextRequest) {
  const user = await requireAuth(request);
  if (user instanceof NextResponse) return user;

  const { error } = await supabaseAdmin
    .from('users')
    .update({ discord_guild_id: null, updated_at: new Date().toISOString() })
    .eq('id', user.id);

  if (error) {
    console.warn('[Discord/guilds] Clear selected guild failed', {
      userId: user.id,
      error: error.message,
    });
    return json({ error: 'Failed to clear Discord server selection' }, { status: 500 });
  }

  console.info('[Discord/guilds] Cleared selected guild', { userId: user.id });
  return json({ ok: true, savedGuildId: null });
}
