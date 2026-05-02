import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';

export const dynamic = 'force-dynamic';

// DISCORD_CLIENT_ID must match the Application ID in Discord Developer Portal → General Information
const CLIENT_ID    = process.env.DISCORD_CLIENT_ID ?? '1477250434967011349';
// DISCORD_REDIRECT_URI must be registered in Discord Developer Portal → OAuth2 → Redirects
const REDIRECT_URI = process.env.DISCORD_REDIRECT_URI ?? 'https://revro.dev/auth/discord/callback';

/**
 * GET /api/discord/auth
 * Returns the Discord OAuth URL for the user to visit.
 * Scope: identify + guilds (read user's servers and permissions).
 */
export async function GET(request: NextRequest) {
  const user = await requireAuth(request);
  if (user instanceof NextResponse) return user;

  const params = new URLSearchParams({
    client_id:     CLIENT_ID,
    response_type: 'code',
    redirect_uri:  REDIRECT_URI,
    scope:         'identify guilds',
    state:         user.id, // passed back in callback so we know which Revro user this is
  });

  return NextResponse.json({
    url: `https://discord.com/oauth2/authorize?${params.toString()}`,
  });
}
