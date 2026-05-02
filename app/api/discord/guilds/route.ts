import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const DISCORD_API = 'https://discord.com/api/v10';

/** GET /api/discord/guilds — list servers Revro's bot is in */
export async function GET(request: NextRequest) {
  const user = await requireAuth(request);
  if (user instanceof NextResponse) return user;

  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    return NextResponse.json({ error: 'Discord bot is not configured' }, { status: 503 });
  }

  // Fetch guilds from Discord API using the shared Revro bot token
  const discordRes = await fetch(`${DISCORD_API}/users/@me/guilds`, {
    headers: { Authorization: `Bot ${token}` },
  });

  if (!discordRes.ok) {
    console.error('[Discord guilds] API error:', discordRes.status);
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
