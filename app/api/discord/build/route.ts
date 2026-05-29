import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { CREDIT_COSTS, deductCredits, hasCredits } from '@/lib/credits';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

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
  type: 'text' | 'voice' | 'announcement' | 'forum';
  emoji?: string;
  topic?: string;
  allowed_roles?: string[];
  denied_roles?: string[];
  read_only?: boolean;
}

interface DiscordCategory {
  name: string;
  emoji?: string;
  channels: DiscordChannel[];
}

interface PermissionOverwrite {
  id: string;
  type: 0;
  allow: string;
  deny: string;
}

interface CreatedRole {
  id: string;
  name: string;
  permissions: string;
}

interface BuildPlan {
  roles?: DiscordRole[];
  categories?: DiscordCategory[];
}

interface BuildResult {
  rolesCreated: string[];
  rolesReused: string[];
  rolesUpdated: string[];
  categoriesCreated: string[];
  categoriesReused: string[];
  categoriesUpdated: string[];
  channelsCreated: string[];
  channelsReused: string[];
  channelsUpdated: string[];
  channelsDeleted: string[];
  skipped: string[];
  failed: string[];
  errors: string[];
}

interface ExistingChannel {
  id: string;
  name: string;
  type: number;
  parent_id?: string | null;
}

interface ExistingRole {
  id: string;
  name: string;
  permissions: string;
}

interface DiscordGuildState {
  rules_channel_id?: string | null;
  public_updates_channel_id?: string | null;
}

interface BuildPreview {
  channels: { id: string; name: string }[];
  categories: { id: string; name: string }[];
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
  body?: object,
  attempt = 0
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

  if (res.status === 429 && attempt < 3) {
    const rateLimit = await res.json().catch(() => ({}));
    const retryAfterMs = Math.ceil(Number((rateLimit as any)?.retry_after ?? 1) * 1000);
    await sleep(Math.max(retryAfterMs, 250));
    return discordRequest(method, path, body, attempt + 1);
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const message = (err as any)?.message ?? `Discord API error ${res.status}`;
    console.error('[Discord API] Validation error', {
      method,
      path,
      status: res.status,
      body: err,
    });
    throw new Error(`${message}: ${JSON.stringify(err)}`);
  }

  if (res.status === 204) return null;
  return res.json();
}

// Small delay to respect Discord rate limits (5 requests per second per route)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const CHANNEL_PERMISSION_MASK = BigInt(1024) | BigInt(2048) | BigInt(8192);
const MODERATION_PERMISSION_MASK = BigInt(2) | BigInt(4) | BigInt(8192);
const MEMBER_CHANNEL_PERMISSIONS = BigInt(1024) | BigInt(2048);
const MODERATOR_CHANNEL_PERMISSIONS = MEMBER_CHANNEL_PERMISSIONS | BigInt(8192);
const ADMINISTRATOR_PERMISSION = BigInt(8);

function getChannelPermissionBits(value: string | undefined): string {
  try {
    return String(BigInt(value ?? '0') & CHANNEL_PERMISSION_MASK);
  } catch {
    return '0';
  }
}

function normalizeRolePermissions(value: string | undefined): string {
  try {
    const permissions = BigInt(value ?? '0') & ~ADMINISTRATOR_PERMISSION;
    if ((permissions & MODERATION_PERMISSION_MASK) !== BigInt(0)) {
      return String(permissions | MODERATOR_CHANNEL_PERMISSIONS);
    }
    if ((permissions & BigInt(2048)) === BigInt(2048)) {
      return String(permissions | MEMBER_CHANNEL_PERMISSIONS);
    }
    return String(permissions);
  } catch {
    return '0';
  }
}

function buildChannelOverwrites(guildId: string, roles: CreatedRole[], channel?: DiscordChannel): PermissionOverwrite[] {
  const allowed = new Set((channel?.allowed_roles ?? []).map(normalizeName));
  const denied = new Set((channel?.denied_roles ?? []).map(normalizeName));
  const isPrivate = allowed.size > 0;
  const isReadOnly = channel?.read_only === true;

  const roleOverwrites = roles
    .map((role) => ({
      id: role.id,
      type: 0 as const,
      allow: allowed.has(normalizeName(role.name))
        ? String(MEMBER_CHANNEL_PERMISSIONS)
        : isPrivate
          ? '0'
          : getChannelPermissionBits(role.permissions),
      deny: denied.has(normalizeName(role.name))
        ? String(MEMBER_CHANNEL_PERMISSIONS)
        : isReadOnly
          ? '2048'
          : '0',
    }))
    .filter((overwrite) => overwrite.allow !== '0' || overwrite.deny !== '0');

  return [
    // Guild id is the @everyone role id in Discord permission overwrites.
    {
      id: guildId,
      type: 0,
      allow: isPrivate ? '0' : '1024',
      deny: isPrivate ? '1024' : isReadOnly ? '2048' : '0',
    },
    ...roleOverwrites,
  ];
}

function recordBuildError(result: BuildResult, step: string, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  const detail = `${step}: ${message}`;
  result.failed.push(detail);
  result.errors.push(detail);
  console.error('[Discord build] Step failed', { step, message });
}

function recordBuildStep(operation: string, detail: string) {
  console.info('[Discord build] Step complete', { operation, detail });
}

function successfulOperationCount(result: BuildResult): number {
  return [
    result.rolesCreated,
    result.rolesReused,
    result.rolesUpdated,
    result.categoriesCreated,
    result.categoriesReused,
    result.categoriesUpdated,
    result.channelsCreated,
    result.channelsReused,
    result.channelsUpdated,
    result.channelsDeleted,
  ].reduce((count, items) => count + items.length, 0);
}

function getChannelType(channel: DiscordChannel): number {
  if (channel.type === 'voice') return 2; // GUILD_VOICE
  // Safe mode defaults every non-voice channel to normal text. Announcement,
  // forum, rules, and community channel types can fail on guild feature gates.
  return 0; // GUILD_TEXT
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

function normalizeChannelName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '-');
}

function channelEmoji(channel: DiscordChannel): string {
  if (channel.emoji?.trim()) return channel.emoji.trim();
  const normalized = normalizeName(channel.name);
  if (normalized.includes('announcement') || normalized.includes('update') || normalized.includes('news')) return '📢';
  if (normalized.includes('rule')) return '📜';
  if (normalized.includes('general') || normalized.includes('chat')) return '💬';
  if (normalized.includes('support') || normalized.includes('ticket')) return '🎫';
  if (normalized.includes('vip') || normalized.includes('premium')) return '🏆';
  if (normalized.includes('voice')) return '🔊';
  if (normalized.includes('faq') || normalized.includes('help')) return '❓';
  if (normalized.includes('suggest')) return '💡';
  if (normalized.includes('welcome')) return '👋';
  return '•';
}

function displayChannelName(channel: DiscordChannel): string {
  const base = normalizeChannelName(channel.name).replace(/^[^\w]+[・|-]?/, '');
  return `${channelEmoji(channel)}・${base}`;
}

function getUniqueChannelName(name: string, existingNames: Set<string>): string {
  if (!existingNames.has(normalizeName(name))) return name;

  let suffix = 2;
  while (existingNames.has(normalizeName(`${name}-${suffix}`))) suffix += 1;
  return `${name}-${suffix}`;
}

async function scanExistingChannels(guildId: string): Promise<BuildPreview> {
  const channels: ExistingChannel[] = await discordRequest('GET', `/guilds/${guildId}/channels`);
  return channels.reduce<BuildPreview>((preview, channel) => {
    const item = { id: channel.id, name: channel.name };
    if (channel.type === 4) preview.categories.push(item);
    else preview.channels.push(item);
    return preview;
  }, { channels: [], categories: [] });
}

// ── Route ─────────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const user = await requireAuth(request);
  if (user instanceof NextResponse) return user;

  const body = await request.json().catch(() => ({}));
  const guildId: string = body.guild_id ?? '';
  const plan: BuildPlan = body.plan ?? {};
  const previewOnly = body.preview === true;
  const requestedReplaceChannels = body.replace_channels === true;
  const replaceChannels = requestedReplaceChannels && body.destructive_confirm === 'DELETE_EXISTING_CHANNELS';

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

  if (previewOnly) {
    try {
      return NextResponse.json({ success: true, preview: await scanExistingChannels(guildId) });
    } catch (err: any) {
      return NextResponse.json({ error: err.message || 'Failed to scan server' }, { status: 500 });
    }
  }

  try {
    if (!(await hasCredits(user.id, CREDIT_COSTS.DISCORD_BUILD))) {
      return NextResponse.json({ error: 'Insufficient AI Wallet balance' }, { status: 402 });
    }
  } catch (err: any) {
    if (err.message === 'Insufficient AI Wallet balance') {
      return NextResponse.json({ error: err.message }, { status: 402 });
    }
    throw err;
  }

  const result: BuildResult = {
    rolesCreated: [],
    rolesReused: [],
    rolesUpdated: [],
    categoriesCreated: [],
    categoriesReused: [],
    categoriesUpdated: [],
    channelsCreated: [],
    channelsReused: [],
    channelsUpdated: [],
    channelsDeleted: [],
    skipped: [],
    failed: [],
    errors: [],
  };
  const createdRoles: CreatedRole[] = [];

  if (requestedReplaceChannels && !replaceChannels) {
    const detail = 'Destructive replace ignored: explicit confirmation missing. Safe mode will only create, reuse, and update resources.';
    result.skipped.push(detail);
    console.warn('[Discord build] Destructive replace ignored without explicit confirmation', {
      userId: user.id,
      guildId,
    });
  }

  // Replacing channels is destructive, so it only runs after an explicit
  // confirmation token from the frontend. Safe mode must never delete channels.
  if (replaceChannels) {
    try {
      const guild: DiscordGuildState = await discordRequest('GET', `/guilds/${guildId}`);
      const protectedChannelIds = new Set(
        [guild.rules_channel_id, guild.public_updates_channel_id].filter(Boolean)
      );
      const preview = await scanExistingChannels(guildId);
      for (const channel of [...preview.channels, ...preview.categories]) {
        if (protectedChannelIds.has(channel.id)) {
          const detail = `Protected Community channel kept: "${channel.name}"`;
          result.skipped.push(detail);
          console.warn('[Discord build] Step skipped', { operation: 'delete_channel', detail });
          continue;
        }
        try {
          await discordRequest('DELETE', `/channels/${channel.id}`);
          result.channelsDeleted.push(channel.name);
          recordBuildStep('delete_channel', channel.name);
          await sleep(125);
        } catch (err: any) {
          recordBuildError(result, `Delete channel "${channel.name}"`, err);
        }
      }
    } catch (err: any) {
      recordBuildError(result, 'Scan existing channels', err);
    }
  }

  let existingChannels: ExistingChannel[] = [];
  let existingRoles: ExistingRole[] = [];
  try {
    [existingChannels, existingRoles] = await Promise.all([
      discordRequest('GET', `/guilds/${guildId}/channels`),
      discordRequest('GET', `/guilds/${guildId}/roles`),
    ]);
  } catch (err) {
    recordBuildError(result, 'Read existing Discord resources', err);
  }

  // ── 1. Create roles ────────────────────────────────────────────────────────
  for (const role of (plan.roles ?? [])) {
    try {
      const permissions = normalizeRolePermissions(role.permissions);
      const existingRole = existingRoles.find(item => normalizeName(item.name) === normalizeName(role.name));
      if (existingRole) {
        const patch: Record<string, unknown> = {};
        if (existingRole.permissions !== permissions) patch.permissions = permissions;
        if (role.color !== undefined) patch.color = role.color;
        if (role.hoist !== undefined) patch.hoist = role.hoist;
        if (role.mentionable !== undefined) patch.mentionable = role.mentionable;
        if (Object.keys(patch).length > 0) {
          await discordRequest('PATCH', `/guilds/${guildId}/roles/${existingRole.id}`, patch);
          existingRole.permissions = permissions;
          result.rolesUpdated.push(existingRole.name);
          recordBuildStep('update_role', existingRole.name);
          await sleep(125);
        }
        createdRoles.push({
          id: existingRole.id,
          name: existingRole.name,
          permissions,
        });
        result.rolesReused.push(existingRole.name);
        recordBuildStep('reuse_role', existingRole.name);
        continue;
      }

      const created = await discordRequest('POST', `/guilds/${guildId}/roles`, {
        name: role.name,
        color: role.color ?? 0,
        hoist: role.hoist ?? false,
        mentionable: role.mentionable ?? false,
        permissions,
      });
      existingRoles.push(created);
      createdRoles.push({
        id: created.id,
        name: role.name,
        permissions,
      });
      result.rolesCreated.push(role.name);
      recordBuildStep('create_role', role.name);
      await sleep(125); // rate limit safety
    } catch (err: any) {
      recordBuildError(result, `Role "${role.name}"`, err);
    }
  }

  const permissionOverwrites = buildChannelOverwrites(guildId, createdRoles);

  // ── 2. Create categories + their channels ─────────────────────────────────
  for (const category of (plan.categories ?? [])) {
    let categoryId: string | null = null;
    const desiredCategoryName = category.name.toUpperCase();
    const existingCategory = existingChannels.find(channel =>
      channel.type === 4 && normalizeName(channel.name) === normalizeName(desiredCategoryName)
    );

    if (existingCategory) {
      categoryId = existingCategory.id;
      result.categoriesReused.push(category.name);
      recordBuildStep('reuse_category', category.name);
      try {
        await discordRequest('PATCH', `/channels/${existingCategory.id}`, {
          permission_overwrites: permissionOverwrites,
        });
        result.categoriesUpdated.push(category.name);
        recordBuildStep('update_category_permissions', category.name);
        await sleep(125);
      } catch (err) {
        recordBuildError(result, `Update category "${category.name}" permissions`, err);
      }
    } else {
      try {
        const existingNames = new Set(existingChannels.map(channel => normalizeName(channel.name)));
        const categoryName = getUniqueChannelName(desiredCategoryName, existingNames);
        const created = await discordRequest('POST', `/guilds/${guildId}/channels`, {
          name: categoryName,
          type: 4, // GUILD_CATEGORY
          permission_overwrites: permissionOverwrites,
        });
        categoryId = created.id;
        existingChannels.push(created);
        result.categoriesCreated.push(categoryName === desiredCategoryName ? category.name : categoryName);
        recordBuildStep('create_category', categoryName);
        await sleep(125);
      } catch (err: any) {
        recordBuildError(result, `Category "${category.name}"`, err);
        continue; // skip channels if category failed
      }
    }

    // Create channels inside the category
    for (const channel of (category.channels ?? [])) {
      try {
        const channelType = getChannelType(channel);
        const desiredChannelName = displayChannelName(channel);
        const plainChannelName = normalizeChannelName(channel.name);
        const reusableChannel = existingChannels.find(item =>
          item.type === channelType
          && item.parent_id === categoryId
          && (
            normalizeName(item.name) === normalizeName(desiredChannelName)
            || normalizeName(item.name) === normalizeName(plainChannelName)
          )
        );
        if (reusableChannel) {
          const reusedName = `${category.name}/${channelType === 2 ? '' : '#'}${reusableChannel.name}`;
          result.channelsReused.push(reusedName);
          recordBuildStep('reuse_channel', reusedName);
          try {
            const patchBody = {
              name: desiredChannelName,
              permission_overwrites: buildChannelOverwrites(guildId, createdRoles, channel),
              ...(channel.topic && channelType !== 2 ? { topic: channel.topic.slice(0, 1024) } : {}),
            };
            try {
              await discordRequest('PATCH', `/channels/${reusableChannel.id}`, patchBody);
            } catch (err) {
              console.warn('[Discord build] Decorated channel update failed, retrying plain text channel', {
                channel: channel.name,
                error: err instanceof Error ? err.message : String(err),
              });
              await discordRequest('PATCH', `/channels/${reusableChannel.id}`, {
                name: plainChannelName,
                permission_overwrites: buildChannelOverwrites(guildId, createdRoles, channel),
                ...(channel.topic && channelType !== 2 ? { topic: channel.topic.slice(0, 1024) } : {}),
              });
              reusableChannel.name = plainChannelName;
            }
            if (reusableChannel.name !== plainChannelName) reusableChannel.name = desiredChannelName;
            result.channelsUpdated.push(reusedName);
            recordBuildStep('update_channel', reusedName);
            await sleep(125);
          } catch (err) {
            recordBuildError(result, `Update channel "${channel.name}"`, err);
          }
          continue;
        }

        const existingNames = new Set(existingChannels.map(item => normalizeName(item.name)));
        const channelName = getUniqueChannelName(desiredChannelName, existingNames);
        let created: ExistingChannel;
        try {
          created = await discordRequest('POST', `/guilds/${guildId}/channels`, {
            name: channelName,
            type: channelType,
            parent_id: categoryId,
            permission_overwrites: buildChannelOverwrites(guildId, createdRoles, channel),
            ...(channel.topic && channelType !== 2 ? { topic: channel.topic.slice(0, 1024) } : {}),
          });
        } catch (err) {
          console.warn('[Discord build] Decorated channel create failed, retrying plain text channel', {
            channel: channel.name,
            error: err instanceof Error ? err.message : String(err),
          });
          const fallbackName = getUniqueChannelName(plainChannelName, existingNames);
          created = await discordRequest('POST', `/guilds/${guildId}/channels`, {
            name: fallbackName,
            type: channelType,
            parent_id: categoryId,
            permission_overwrites: buildChannelOverwrites(guildId, createdRoles, channel),
            ...(channel.topic && channelType !== 2 ? { topic: channel.topic.slice(0, 1024) } : {}),
          });
        }
        existingChannels.push(created);
        const createdName = `${category.name}/${channelType === 2 ? '' : '#'}${created.name ?? channelName}`;
        result.channelsCreated.push(createdName);
        recordBuildStep('create_channel', createdName);
        await sleep(125);
      } catch (err: any) {
        recordBuildError(result, `Channel "${channel.name}"`, err);
      }
    }
  }

  if (successfulOperationCount(result) > 0) {
    try {
      await deductCredits(user.id, CREDIT_COSTS.DISCORD_BUILD, 'discord_build', {
        guild_id: guildId,
        provider: 'discord',
        model: 'builder',
        estimated_real_usd_cost: CREDIT_COSTS.DISCORD_BUILD,
        successful_operations: successfulOperationCount(result),
        failed_operations: result.failed.length,
      });
    } catch (err: any) {
      if (err.message === 'Insufficient AI Wallet balance') {
        result.failed.push('AI Wallet charge failed after Discord operations completed. Contact support.');
        result.errors.push('AI Wallet charge failed after Discord operations completed. Contact support.');
      } else {
        throw err;
      }
    }
  } else if (result.failed.length > 0) {
    console.warn('[Discord build] No charge applied because no Discord operations completed', {
      userId: user.id,
      guildId,
      failed: result.failed.length,
    });
  }

  return NextResponse.json({ success: result.failed.length === 0, result });
}
