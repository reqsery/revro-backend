import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

const CLIENT_ID    = process.env.DISCORD_CLIENT_ID    || '1477250434967011349';
// Must exactly match the redirect_uri used in /api/discord/auth AND registered in Discord Dev Portal
const REDIRECT_URI = process.env.DISCORD_REDIRECT_URI || 'https://revro.dev/auth/discord/callback';
const DISCORD_API   = 'https://discord.com/api/v10';

interface DiscordGuildRaw {
  id: string;
  name: string;
  icon: string | null;
  owner: boolean;
  permissions: string; // bitfield as string
}

/**
 * POST /api/discord/exchange
 * Body: { code: string }
 * Exchanges the Discord OAuth code for an access token, fetches the user's
 * guilds where they are owner or admin, and stores those guild IDs on their profile.
 */
export async function POST(request: NextRequest) {
  const user = await requireAuth(request);
  if (user instanceof NextResponse) return user;

  const { code } = await request.json();
  if (!code) return NextResponse.json({ error: 'code is required' }, { status: 400 });

  const clientSecret = process.env.DISCORD_CLIENT_SECRET || process.env.DISCORD_SECRET;
  if (!clientSecret) {
    console.error('[Discord exchange] DISCORD_CLIENT_SECRET env var is not set. Add it in Vercel → Backend project → Settings → Environment Variables');
    return NextResponse.json({ error: 'Discord integration is not configured. Contact support.' }, { status: 503 });
  }

  // ── 1. Exchange code for access token ─────────────────────────────────────
  const tokenRes = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     CLIENT_ID,
      client_secret: clientSecret,
      grant_type:    'authorization_code',
      code,
      redirect_uri:  REDIRECT_URI,
    }),
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.json().catch(() => ({}));
    console.error('[Discord exchange] Token error:', JSON.stringify(err));
    const msg = (err.error_description as string) || (err.error as string) || 'Failed to exchange Discord code';
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  const { access_token } = await tokenRes.json();

  // ── 2. Fetch user's guilds (where they are owner or have Admin permission) ──
  const guildsRes = await fetch(`${DISCORD_API}/users/@me/guilds`, {
    headers: { Authorization: `Bearer ${access_token}` },
  });

  if (!guildsRes.ok) {
    return NextResponse.json({ error: 'Failed to fetch Discord guilds' }, { status: 502 });
  }

  const allGuilds: DiscordGuildRaw[] = await guildsRes.json();

  // Filter to servers where the user is owner OR has Administrator bit (0x8)
  const ADMIN_BIT = BigInt(0x8);
  const adminGuilds = allGuilds.filter(g => {
    if (g.owner) return true;
    try { return (BigInt(g.permissions) & ADMIN_BIT) === ADMIN_BIT; } catch { return false; }
  });

  const guildsForProfile = adminGuilds.map(g => ({
    id: g.id,
    name: g.name,
    icon: g.icon,
  }));

  // ── 3. Fetch Discord user info to store their Discord user ID ──────────────
  let discordUserId: string | null = null;
  try {
    const meRes = await fetch(`${DISCORD_API}/users/@me`, {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    if (meRes.ok) {
      const me = await meRes.json();
      discordUserId = me.id ?? null;
    }
  } catch {}

  // ── 4. Save to user profile ────────────────────────────────────────────────
  const { error: discordUpdateErr } = await supabaseAdmin
    .from('users')
    .update({
      discord_guild_ids:  JSON.stringify(guildsForProfile),
      discord_user_id:    discordUserId,
      updated_at:         new Date().toISOString(),
    })
    .eq('id', user.id);

  if (discordUpdateErr) {
    console.error('[Discord exchange] Failed to save guild IDs:', discordUpdateErr.message);
    return NextResponse.json({
      error: `Discord connection failed — missing DB columns. Run the discord migration SQL in Supabase. Details: ${discordUpdateErr.message}`,
    }, { status: 500 });
  }

  return NextResponse.json({
    ok:          true,
    guildsFound: adminGuilds.length,
    guildIds: guildsForProfile.map(g => g.id),
  });
}
