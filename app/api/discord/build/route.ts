import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { deductCredits } from '@/lib/credits';

export const dynamic = 'force-dynamic';

const DISCORD_API = 'https://discord.com/api/v10';

// ── Types ─────────────────────────────────────────────────────────────────────

interface DiscordRole {
  name: string;
  color?: number;
  hoist?: boolean;
  mentionable?: boolean;
  permissions?: string;
}

interface DiscordChannel {
  name: string;
  type: 'text' | 'voice';
  topic?: string;
}

interface DiscordCategory {
  name: string;
  channels: DiscordChannel[];
}

interface BuildPlan {
  roles?: DiscordRole[];
  categories?: DiscordCategory[];
}

interface BuildResult {
  rolesCreated: string[];
  categoriesCreated: string[];
  channelsCreated: string[];
  errors: string[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getBotToken(): string {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error('DISCORD_BOT_TOKEN is not configured');
  return token;
}

async function discordRequest(
  method: string,
  path: string,
  body?: object
): Promise<any> {
  const token = getBotToken();
  const res = await fetch(`${DISCORD_API}${path}`, {
    method,
    headers: {
      Authorization: `Bot ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const message = (err as any)?.message ?? `Discord API error ${res.status}`;
    throw new Error(message);
  }

  return res.json();
}

// Small delay to respect Discord rate limits (5 requests per second per route)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── Route ─────────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const user = await requireAuth(request);
  if (user instanceof NextResponse) return user;

  const body = await request.json().catch(() => ({}));
  const guildId: string = body.guild_id ?? '';
  const plan: BuildPlan = body.plan ?? {};

  if (!guildId) {
    return NextResponse.json({ error: 'guild_id is required' }, { status: 400 });
  }

  if (!plan.roles?.length && !plan.categories?.length) {
    return NextResponse.json({ error: 'plan must have roles or categories' }, { status: 400 });
  }

  // Verify bot is in this guild
  try {
    getBotToken();
    await discordRequest('GET', `/guilds/${guildId}`);
  } catch (err: any) {
    if (err.message?.includes('Missing Access') || err.message?.includes('Unknown Guild')) {
      return NextResponse.json(
        { error: 'Bot is not in this server. Invite it first using the bot invite link.' },
        { status: 403 }
      );
    }
    return NextResponse.json({ error: err.message || 'Cannot connect to Discord' }, { status: 500 });
  }

  // Deduct 3 credits for building a server
  try {
    await deductCredits(user.id, 3, 'discord_build', { guild_id: guildId });
  } catch (err: any) {
    if (err.message === 'Insufficient credits') {
      return NextResponse.json({ error: 'Insufficient credits' }, { status: 402 });
    }
    throw err;
  }

  const result: BuildResult = {
    rolesCreated: [],
    categoriesCreated: [],
    channelsCreated: [],
    errors: [],
  };

  // ── 1. Create roles ────────────────────────────────────────────────────────
  for (const role of (plan.roles ?? [])) {
    try {
      await discordRequest('POST', `/guilds/${guildId}/roles`, {
        name: role.name,
        color: role.color ?? 0,
        hoist: role.hoist ?? false,
        mentionable: role.mentionable ?? false,
        permissions: role.permissions ?? '0',
      });
      result.rolesCreated.push(role.name);
      await sleep(300); // rate limit safety
    } catch (err: any) {
      result.errors.push(`Role "${role.name}": ${err.message}`);
    }
  }

  // ── 2. Create categories + their channels ─────────────────────────────────
  for (const category of (plan.categories ?? [])) {
    let categoryId: string | null = null;

    // Create the category (type 4)
    try {
      const created = await discordRequest('POST', `/guilds/${guildId}/channels`, {
        name: category.name.toUpperCase(),
        type: 4, // GUILD_CATEGORY
      });
      categoryId = created.id;
      result.categoriesCreated.push(category.name);
      await sleep(300);
    } catch (err: any) {
      result.errors.push(`Category "${category.name}": ${err.message}`);
      continue; // skip channels if category failed
    }

    // Create channels inside the category
    for (const channel of (category.channels ?? [])) {
      try {
        const channelType = channel.type === 'voice' ? 2 : 0; // 0=TEXT, 2=VOICE
        await discordRequest('POST', `/guilds/${guildId}/channels`, {
          name: channel.name.toLowerCase().replace(/\s+/g, '-'),
          type: channelType,
          parent_id: categoryId,
          ...(channel.topic && channelType === 0 ? { topic: channel.topic } : {}),
        });
        result.channelsCreated.push(`${category.name}/#${channel.name}`);
        await sleep(300);
      } catch (err: any) {
        result.errors.push(`Channel "${channel.name}": ${err.message}`);
      }
    }
  }

  return NextResponse.json({ success: true, result });
}
