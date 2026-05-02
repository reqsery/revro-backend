import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

const DISCORD_API = 'https://discord.com/api/v10';

/** GET /api/discord/guilds — list servers the bot is in */
export async function GET(request: NextRequest) {
  const user = await requireAuth(request);
  if (user instanceof NextResponse) return user;

  // Get the stored bot token
  const { data: userData, error } = await supabaseAdmin
    .from('users')
    .select('discord_bot_token')
    .eq('id', user.id)
    .single();

  if (error || !userData?.discord_bot_token) {
    return NextResponse.json({ error: 'No Discord bot connected' }, { status: 404 });
  }

  const token = userData.discord_bot_token;

  // Fetch guilds from Discord API
  const discordRes = await fetch(`${DISCORD_API}/users/@me/guilds`, {
    headers: { Authorization: `Bot ${token}` },
  });

  if (!discordRes.ok) {
    if (discordRes.status === 401) {
      // Token is invalid — clear it
      await supabaseAdmin
        .from('users')
        .update({ discord_bot_token: null })
        .eq('id', user.id);
      return NextResponse.json({ error: 'Bot token is invalid — please reconnect' }, { status: 401 });
    }
    return NextResponse.json({ error: 'Failed to fetch servers from Discord' }, { status: 502 });
  }

  const guilds: any[] = await discordRes.json();

  return NextResponse.json({
    guilds: guilds.map(g => ({
      id: g.id,
      name: g.name,
      icon: g.icon
        ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png`
        : null,
      memberCount: g.approximate_member_count ?? null,
    })),
  });
}
