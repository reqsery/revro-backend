import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

const DISCORD_API = 'https://discord.com/api/v10';

/** POST /api/discord/connect — validate and save a Discord bot token */
export async function POST(request: NextRequest) {
  const user = await requireAuth(request);
  if (user instanceof NextResponse) return user;

  const body = await request.json().catch(() => ({}));
  const token: string = (body.token ?? '').trim();

  if (!token) {
    return NextResponse.json({ error: 'Bot token is required' }, { status: 400 });
  }

  // Validate the token against Discord API
  const discordRes = await fetch(`${DISCORD_API}/users/@me`, {
    headers: { Authorization: `Bot ${token}` },
  });

  if (!discordRes.ok) {
    return NextResponse.json(
      { error: 'Invalid bot token — check your Discord developer portal' },
      { status: 400 }
    );
  }

  const botInfo: any = await discordRes.json();

  // Save token to users table (column: discord_bot_token)
  const { error: updateErr } = await supabaseAdmin
    .from('users')
    .update({
      discord_bot_token: token,
      updated_at: new Date().toISOString(),
    })
    .eq('id', user.id);

  if (updateErr) {
    console.error('[Discord connect] DB error:', updateErr.message);
    return NextResponse.json({ error: 'Failed to save bot token' }, { status: 500 });
  }

  return NextResponse.json({
    success: true,
    bot: {
      id: botInfo.id,
      username: botInfo.username,
      avatar: botInfo.avatar
        ? `https://cdn.discordapp.com/avatars/${botInfo.id}/${botInfo.avatar}.png`
        : null,
    },
  });
}

/** DELETE /api/discord/connect — remove the stored bot token */
export async function DELETE(request: NextRequest) {
  const user = await requireAuth(request);
  if (user instanceof NextResponse) return user;

  await supabaseAdmin
    .from('users')
    .update({ discord_bot_token: null, updated_at: new Date().toISOString() })
    .eq('id', user.id);

  return NextResponse.json({ success: true });
}
