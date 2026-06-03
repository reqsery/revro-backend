import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { deductCredits, estimateTokenCostUsd, getAllowedRequestedModel } from '@/lib/credits';
import { callAI, selectAIModel, estimateInputTokens, getAIRoutingDebug } from '@/lib/codex';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

function getConversationId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  if (value.startsWith('local_') || value.startsWith('pending_')) return undefined
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : undefined
}

const DISCORD_PLAN_FALLBACK = 'I planned the Discord server structure. Review it below before building it.'
const DISCORD_REPLY_FALLBACK = 'I could not finish that Discord server plan cleanly. Send the setup request again and I will rebuild it.'

function looksLikeServerBuildRequest(prompt: string) {
  return /\b(set\s*up|setup|create|make|build|configure|server|roles?|channels?|category|categories|community|vip|support|rules|announcements?)\b/i
    .test(prompt);
}

function cleanDiscordName(value: string) {
  return value
    .replace(/<@!?\d+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^#+/, '')
    .replace(/[.,;:]+$/g, '');
}

function normalizeDiscordName(value: string) {
  return cleanDiscordName(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

function isVoiceChannel(categoryName: string, channelName: string) {
  return /\b(voice|call|duo|trio|vc)\b/i.test(`${categoryName} ${channelName}`);
}

function channelTopic(name: string) {
  const normalized = normalizeDiscordName(name);
  if (normalized.includes('rules')) return 'Server rules and guidelines';
  if (normalized.includes('announcement')) return 'Important announcements and updates';
  if (normalized.includes('prices')) return 'Prices for boosting and account services';
  if (normalized.includes('vouches')) return 'Customer vouches and proof';
  if (normalized.includes('global-chat')) return 'Main community chat';
  if (normalized.includes('german-chat')) return 'German community chat';
  if (normalized.includes('buy-accounts')) return 'Account purchase requests';
  if (normalized.includes('sell-accounts')) return 'Account selling requests';
  if (normalized.includes('account-info')) return 'Account rules, safety notes, and service info';
  if (normalized.includes('ranked-boost')) return 'Ranked boosting orders and questions';
  if (normalized.includes('trophy-push')) return 'Trophy pushing service requests';
  if (normalized.includes('win-streak')) return 'Win streak service requests';
  if (normalized.includes('play-with-us')) return 'Queue to play with staff or boosters';
  if (normalized.includes('orders')) return 'Order updates and service tracking';
  if (normalized.includes('ticket')) return 'Support ticket area';
  return undefined;
}

function roleDefinition(name: string, emoji?: string) {
  const normalized = normalizeDiscordName(name);
  const base = cleanDiscordName(name);
  const roleEmoji = emoji || (
    normalized.includes('owner') ? '👑'
    : normalized.includes('admin') ? '🛡️'
    : normalized.includes('staff') || normalized.includes('mod') ? '🔨'
    : normalized.includes('booster') ? '🚀'
    : normalized.includes('pusher') ? '🏆'
    : normalized.includes('customer') ? '💎'
    : normalized.includes('verified') ? '✅'
    : normalized.includes('member') ? '🎮'
    : '👤'
  );

  const permissions = normalized.includes('owner') || normalized.includes('admin')
    ? '11264'
    : normalized.includes('staff') || normalized.includes('mod')
      ? '11270'
      : '3072';

  return {
    name: base,
    emoji: roleEmoji,
    color: normalized.includes('owner') ? 15844367
      : normalized.includes('admin') ? 15158332
      : normalized.includes('staff') || normalized.includes('mod') ? 3447003
      : normalized.includes('customer') ? 10181046
      : normalized.includes('verified') ? 3066993
      : 0,
    hoist: /owner|admin|staff|booster|pusher/i.test(normalized),
    mentionable: /staff|booster|pusher/i.test(normalized),
    permissions,
  };
}

function extractDiscordStructureFromPrompt(prompt: string) {
  const structuredText = prompt
    .split(/\bRevro\s+Discord Builder\b/i)[0]
    .split(/\b(help me|think of|it's for|its for|for a server)\b/i)[0]
    .replace(/<@!?\d+>/g, ' ')
    .trim();
  const explicitPlan = extractPlainDiscordStructure(structuredText);
  if (explicitPlan) return explicitPlan;
  if (!structuredText.includes('\u30fb') && !structuredText.includes('\u250a') && !structuredText.includes('|')) return null;

  const categories: any[] = [];
  const roles: any[] = [];
  let currentCategory: any | null = null;
  let parsingRoles = false;
  const tokenRegex = /(?:^|\s)([^\s\u30fb\u250a|]+)([\u30fb\u250a|])\s*([\s\S]*?)(?=\s+[^\s\u30fb\u250a|]+[\u30fb\u250a|]|$)/gu;
  let match: RegExpExecArray | null;

  while ((match = tokenRegex.exec(structuredText)) !== null) {
    const marker = match[1].trim();
    const separator = match[2];
    const name = cleanDiscordName(match[3]);
    if (!name) continue;

    if (separator === '\u30fb') {
      parsingRoles = /\broles?\b/i.test(name);
      currentCategory = parsingRoles
        ? null
        : { name: name.toUpperCase(), emoji: marker, channels: [] as any[] };
      if (currentCategory) categories.push(currentCategory);
      continue;
    }

    if (parsingRoles) {
      roles.push(roleDefinition(name, marker));
      continue;
    }

    if (!currentCategory) continue;
    const channelName = normalizeDiscordName(name);
    if (!channelName) continue;
    const privateStaff = /\b(staff|owner|admin)\b/i.test(channelName);
    const privateCustomer = /\b(customer|orders?)\b/i.test(channelName);
    currentCategory.channels.push({
      name: channelName,
      type: isVoiceChannel(currentCategory.name, channelName) ? 'voice' : 'text',
      emoji: marker,
      topic: channelTopic(channelName),
      ...(privateStaff ? { allowed_roles: ['Owner', 'Admin', 'Staff'] } : {}),
      ...(privateCustomer ? { allowed_roles: ['Owner', 'Admin', 'Staff', 'Customer'] } : {}),
      ...(/\b(rules|announcements|prices|vouches|account-info)\b/i.test(channelName) ? { read_only: true } : {}),
    });
  }

  const usableCategories = categories.filter(category => category.channels.length > 0);
  if (usableCategories.length === 0) return null;

  const dedupedRoles = new Map<string, any>();
  for (const role of roles.length ? roles : [
    roleDefinition('Owner', '👑'),
    roleDefinition('Admin', '🛡️'),
    roleDefinition('Staff', '🔨'),
    roleDefinition('Customer', '💎'),
    roleDefinition('Verified', '✅'),
    roleDefinition('Member', '🎮'),
  ]) {
    dedupedRoles.set(normalizeDiscordName(role.name), role);
  }

  return {
    roles: Array.from(dedupedRoles.values()),
    categories: usableCategories,
  };
}

function extractPlainDiscordStructure(prompt: string) {
  const structureMatch = prompt.match(/CHANNEL STRUCTURE:\s*([\s\S]*?)(?:ROLE PERMISSIONS:|CATEGORY PERMISSIONS|IMPORTANT BOT NOTES|IMPORTANT RULES|$)/i);
  if (!structureMatch) return null;

  const structure = structureMatch[1]
    .replace(/<@!?\d+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const categoryRegex = /(?:^|\s)(?:[^\w#]{1,20}\s*)?([A-Z][A-Z0-9 ]{2,})(?=\s+#)\s+((?:#\s*[a-z0-9-]+(?:\s+|$))+)/g;
  const categories: any[] = [];
  let match: RegExpExecArray | null;

  while ((match = categoryRegex.exec(structure)) !== null) {
    const categoryName = cleanDiscordName(match[1]);
    const channelMatches = Array.from(match[2].matchAll(/#\s*([a-z0-9-]+)/gi));
    const channels = channelMatches
      .map(channelMatch => normalizeDiscordName(channelMatch[1]))
      .filter(Boolean)
      .map(channelName => {
        const privateStaff = /\b(staff|logs?)\b/i.test(channelName);
        const privateCustomer = /\b(orders?)\b/i.test(channelName);
        const readOnly = /\b(rules|announcements|prices|proofs|account-info|ranked-boost|trophy-push|prestige|accounts)\b/i.test(channelName);
        return {
          name: channelName,
          type: isVoiceChannel(categoryName, channelName) ? 'voice' : 'text',
          topic: channelTopic(channelName),
          ...(privateStaff ? { allowed_roles: ['Owner', 'Admin', 'Staff'] } : {}),
          ...(privateCustomer ? { allowed_roles: ['Owner', 'Admin', 'Staff', 'Customer'] } : {}),
          ...(readOnly ? { read_only: true } : {}),
        };
      });

    if (channels.length > 0) {
      categories.push({
        name: categoryName.toUpperCase(),
        channels,
      });
    }
  }

  if (categories.length === 0) return null;

  const rolesText = prompt.match(/ROLES:\s*([\s\S]*?)(?:CHANNEL STRUCTURE:|ROLE PERMISSIONS:|$)/i)?.[1] ?? '';
  const explicitRoles = rolesText
    .split(/\s+/)
    .map(cleanDiscordName)
    .filter(name => /^(Owner|Admin|Staff|Booster|Member|Bots?|Customer|Verified|Pusher)$/i.test(name))
    .map(name => roleDefinition(name));
  const roles = explicitRoles.length > 0
    ? explicitRoles
    : ['Owner', 'Admin', 'Staff', 'Booster', 'Member', 'Bots'].map(name => roleDefinition(name));

  return { roles, categories };
}

function fallbackDiscordPlan(prompt: string) {
  const extracted = extractDiscordStructureFromPrompt(prompt);
  if (extracted) return extracted;

  const lower = prompt.toLowerCase();
  const wantsVip = /\b(vip|paid|client|customer|premium|buyer|private)\b/i.test(lower);
  const wantsSupport = /\b(support|ticket|help|staff)\b/i.test(lower);
  const wantsGame = /\b(roblox|game|studio|developer|dev|release|update)\b/i.test(lower);

  const roles = [
    { name: 'Admin', emoji: '🛡️', color: 15158332, hoist: true, mentionable: false, permissions: '11264' },
    { name: 'Moderator', emoji: '🔨', color: 3447003, hoist: true, mentionable: true, permissions: '11270' },
    { name: 'Member', emoji: '👤', color: 3066993, hoist: false, mentionable: false, permissions: '3072' },
    ...(wantsVip ? [{ name: 'VIP', emoji: '⭐', color: 15844367, hoist: true, mentionable: false, permissions: '3072' }] : []),
  ];

  const categories = [
    {
      name: 'INFORMATION',
      emoji: '📢',
      channels: [
        { name: 'rules', type: 'text', emoji: '📜', topic: 'Server rules and guidelines', read_only: true },
        { name: 'announcements', type: 'text', emoji: '📢', topic: 'Important announcements and updates', read_only: true },
      ],
    },
    {
      name: wantsGame ? 'GAME CHAT' : 'COMMUNITY',
      emoji: '💬',
      channels: [
        { name: 'general', type: 'text', emoji: '💬', topic: 'General community chat' },
        { name: wantsGame ? 'game-updates' : 'media', type: 'text', emoji: wantsGame ? '🧩' : '📸', topic: wantsGame ? 'Game updates and changelogs' : 'Share community media' },
        { name: 'voice-chat', type: 'voice', emoji: '🔊' },
      ],
    },
    ...(wantsSupport ? [{
      name: 'SUPPORT',
      emoji: '🎫',
      channels: [
        { name: 'support', type: 'text', emoji: '🎫', topic: 'Ask for help from staff' },
        { name: 'staff-chat', type: 'text', emoji: '🔒', topic: 'Private staff coordination', allowed_roles: ['Admin', 'Moderator'] },
      ],
    }] : []),
    ...(wantsVip ? [{
      name: 'VIP',
      emoji: '🏆',
      channels: [
        { name: 'vip-chat', type: 'text', emoji: '🏆', topic: 'Private VIP chat', allowed_roles: ['VIP'] },
        { name: 'vip-announcements', type: 'text', emoji: '⭐', topic: 'VIP-only updates', allowed_roles: ['VIP'], read_only: true },
      ],
    }] : []),
  ];

  return { roles, categories };
}

function buildStrictDiscordRetryPrompt(fullPrompt: string) {
  return `${fullPrompt}

The previous Discord server setup response was not buildable or did not match the user's request.
Return a Discord server setup for the user's exact request, not a generic template.

Requirements:
- Preserve the user's requested server purpose, role names, channel names, paywall/access rules, and permission intent.
- Return one short sentence, then exactly one valid JSON code block.
- The JSON must include roles and categories with channels.
- Use normal text channels for announcements, rules, forums, tickets, and community areas.
- Include emoji fields, but keep channel names lowercase with hyphens.
- Do not add unrelated generic channels unless the user asked for them.
- Do not write a blueprint essay.
- Do not return prose without JSON.`;
}

function compactExecutionSummary(value: string): string {
  const cleaned = value
    .replace(/\s+/g, ' ')
    .replace(/\b(meticulously|comprehensive|complete blueprint|ready for deployment)\b/gi, '')
    .trim();
  if (!cleaned) return DISCORD_PLAN_FALLBACK;
  const firstSentence = cleaned.match(/^.*?[.!?](?:\s|$)/)?.[0]?.trim() ?? cleaned;
  return firstSentence.length > 180 ? `${firstSentence.slice(0, 177).trim()}...` : firstSentence;
}

/** Try to pull a JSON block out of the AI response, return the rest as explanation. */
function parseDiscordResponse(raw: string): { explanation: string; config?: any } {
  const normalizeConfig = (value: any) => {
    if (!value || typeof value !== 'object') return undefined
    const root = value.config && typeof value.config === 'object' ? value.config : value
    return root?.roles || root?.categories || root?.channels ? root : undefined
  }

  const trimmed = raw.trim()
  const match = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (match) {
    try {
      const config = normalizeConfig(JSON.parse(match[1]))
      if (!config) throw new Error('JSON block is not a Discord plan')
      const explanation = trimmed.replace(match[0], '').trim()
      return {
        explanation: compactExecutionSummary(explanation),
        config,
      }
    } catch {}
  }
  try {
    const config = normalizeConfig(JSON.parse(trimmed))
    if (config) {
      return {
        explanation: DISCORD_PLAN_FALLBACK,
        config,
      }
    }
  } catch {}

  const firstBrace = trimmed.indexOf('{')
  const lastBrace = trimmed.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try {
      const jsonText = trimmed.slice(firstBrace, lastBrace + 1)
      const config = normalizeConfig(JSON.parse(jsonText))
      if (config) {
        const explanation = `${trimmed.slice(0, firstBrace)} ${trimmed.slice(lastBrace + 1)}`.trim()
        return {
          explanation: compactExecutionSummary(explanation),
          config,
        }
      }
    } catch {}
  }

  return { explanation: compactExecutionSummary(trimmed || DISCORD_REPLY_FALLBACK) }
}

export async function POST(request: NextRequest) {
  const user = await requireAuth(request);
  if (user instanceof NextResponse) return user;

  try {
    const body = await request.json();

    // Support both old (message/conversationId) and new (prompt/conversation_id) field names
    const prompt: string  = body.prompt ?? body.message ?? ''
    const guildId: string = body.guild_id ?? ''
    const guildName: string = body.guild_name ?? ''
    const conversationId = getConversationId(body.conversation_id ?? body.conversationId)

    if (!prompt) {
      return NextResponse.json({ error: 'prompt is required' }, { status: 400 });
    }

    const planModel = getAllowedRequestedModel(user.plan, body.model)

    // Fetch conversation history
    let history: any[] = []
    if (conversationId) {
      const { data: conversation, error: conversationErr } = await supabaseAdmin
        .from('conversations')
        .select('id, type')
        .eq('id', conversationId)
        .eq('user_id', user.id)
        .maybeSingle()

      if (conversationErr) throw conversationErr
      if (!conversation) {
        return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
      }
      const { data: msgs } = await supabaseAdmin
        .from('messages')
        .select('role, content')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: false })
        .limit(16)
      history = (msgs ?? []).reverse()
    }

    // Prepend guild context to the prompt so the AI tailors advice to that server
    const fullPrompt = guildName
      ? `[Setting up Discord server: "${guildName}" (ID: ${guildId})]\n\n${prompt}`
      : prompt

    const selection = selectAIModel(planModel, 'discord', fullPrompt)
    console.info('[AI route]', {
      route: 'discord',
      provider: selection.provider,
      model: selection.actualModel,
      selectedModelTier: planModel,
      ...getAIRoutingDebug('discord', fullPrompt, planModel),
      inputTokenEstimate: estimateInputTokens(fullPrompt, history),
    })
    let aiResponse = await callAI(selection, fullPrompt, 'discord', history)

    if (!aiResponse.content.trim()) {
      console.error('[Discord chat] Empty AI response', {
        model: selection.actualModel,
        promptLength: prompt.length,
        historyLength: history.length,
      })
    }

    const directStructurePlan = extractDiscordStructureFromPrompt(prompt)
    let { explanation, config } = parseDiscordResponse(aiResponse.content)
    if (directStructurePlan) {
      config = directStructurePlan
      explanation = 'I extracted the server structure you pasted and mapped it into a safe build plan with roles, channels, and basic permissions. Review it before building.'
      console.info('[Discord chat] Using extracted pasted server structure over AI plan', {
        userId: user.id,
        categories: directStructurePlan.categories?.length ?? 0,
        roles: directStructurePlan.roles?.length ?? 0,
      })
    }

    if (!config && looksLikeServerBuildRequest(prompt)) {
      console.warn('[Discord chat] AI response missing buildable plan; retrying strict Discord setup', {
        userId: user.id,
        model: selection.actualModel,
        promptLength: prompt.length,
        responseLength: aiResponse.content.length,
      })
      const retryResponse = await callAI(selection, buildStrictDiscordRetryPrompt(fullPrompt), 'discord', history)
      const retryParsed = parseDiscordResponse(retryResponse.content)
      aiResponse = {
        content: retryResponse.content,
        usage: {
          input_tokens: (aiResponse.usage?.input_tokens ?? 0) + (retryResponse.usage?.input_tokens ?? 0),
          output_tokens: (aiResponse.usage?.output_tokens ?? 0) + (retryResponse.usage?.output_tokens ?? 0),
          total_tokens: (aiResponse.usage?.total_tokens ?? 0) + (retryResponse.usage?.total_tokens ?? 0),
        },
      }
      explanation = retryParsed.explanation
      config = retryParsed.config
    }

    if (!config && looksLikeServerBuildRequest(prompt)) {
      const extractedPlan = directStructurePlan ?? extractDiscordStructureFromPrompt(prompt)
      config = extractedPlan ?? fallbackDiscordPlan(prompt)
      explanation = extractedPlan
        ? 'I extracted the server structure you pasted and mapped it into a safe build plan with roles, channels, and basic permissions. Review it before building.'
        : 'I could not extract the exact requested setup cleanly, so I generated a safe editable starter structure. Review it before building.'
      console.warn('[Discord chat] Strict retry still missing plan; using safe fallback plan', {
        userId: user.id,
        model: selection.actualModel,
        promptLength: prompt.length,
        responseLength: aiResponse.content.length,
        extractedStructure: !!extractedPlan,
      })
    }
    const cost = estimateTokenCostUsd(
      selection.actualModel,
      aiResponse.usage?.input_tokens ?? 0,
      aiResponse.usage?.output_tokens ?? 0,
    )
    const assistantContent = config
      ? `${explanation}\n\n\`\`\`json\n${JSON.stringify(config, null, 2)}\n\`\`\``
      : (aiResponse.content.trim() || explanation)

    // Save / create conversation
    let convId = conversationId
    if (!convId) {
      const { data: conv, error: convErr } = await supabaseAdmin
        .from('conversations')
        .insert({ user_id: user.id, title: prompt.substring(0, 50), type: 'discord' })
        .select('id')
        .single()
      if (convErr) {
        console.error('[Discord chat] Failed to create conversation:', convErr.message)
        throw convErr
      }
      convId = conv?.id
    }

    let messageId: string | null = null
    if (convId) {
      const { error: userMessageErr } = await supabaseAdmin.from('messages').insert({
        conversation_id: convId,
        role: 'user',
        content: prompt,
      })
      if (userMessageErr) {
        console.error('[Discord chat] Failed to save user message:', userMessageErr.message)
        throw userMessageErr
      }

      const { data: assistantMsg, error: assistantMessageErr } = await supabaseAdmin
        .from('messages')
        .insert({
          conversation_id: convId,
          role: 'assistant',
          content: assistantContent,
          credits_cost: Math.ceil(cost),
          model_used: planModel,
        })
        .select('id')
        .single()
      if (assistantMessageErr) {
        console.error('[Discord chat] Failed to save assistant message:', assistantMessageErr.message)
        throw assistantMessageErr
      }

      const { error: touchErr } = await supabaseAdmin
        .from('conversations')
        .update({ updated_at: new Date().toISOString() })
        .eq('id', convId)
        .eq('user_id', user.id)
      if (touchErr) {
        console.error('[Discord chat] Failed to update conversation timestamp:', touchErr.message)
        throw touchErr
      }

      messageId = assistantMsg?.id ?? null
    }

    const creditResult = await deductCredits(user.id, cost, 'discord_generation', {
      model: selection.logicalModel,
      actualModel: selection.actualModel,
      provider: selection.provider,
      input_tokens:  aiResponse.usage?.input_tokens,
      output_tokens: aiResponse.usage?.output_tokens,
      image_cost: null,
      file_context_cost: null,
      estimated_real_usd_cost: cost,
    })
    console.info('[AI generation]', {
      route: 'discord',
      provider: selection.provider,
      model: selection.actualModel,
      selectedModelTier: planModel,
      ...getAIRoutingDebug('discord', fullPrompt, planModel),
      inputTokenEstimate: estimateInputTokens(fullPrompt, history),
      inputTokens: aiResponse.usage?.input_tokens ?? 0,
      outputTokens: aiResponse.usage?.output_tokens ?? 0,
      imageCost: null,
      fileContextCost: null,
      estimatedRealUsdCost: cost,
      deductedWalletAmount: cost,
      userId: user.id,
    })

    return NextResponse.json({
      response: {
        explanation,
        ...(config ? { config } : {}),
        credits_used: cost,
        credits_remaining: creditResult.creditsRemaining,
      },
      conversation_id: convId ?? null,
      message_id: messageId,
    });

  } catch (error: any) {
    console.error('[Discord chat] Error:', error);
    if (error.message === 'Insufficient AI Wallet balance') {
      return NextResponse.json({ error: error.message }, { status: 402 });
    }
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
