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

function fallbackDiscordPlan(prompt: string) {
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
    const aiResponse = await callAI(selection, fullPrompt, 'discord', history)

    // Token-based billing — same model as Roblox routes, minimum 1 credit
    const cost = estimateTokenCostUsd(
      selection.actualModel,
      aiResponse.usage?.input_tokens ?? 0,
      aiResponse.usage?.output_tokens ?? 0,
    )

    if (!aiResponse.content.trim()) {
      console.error('[Discord chat] Empty AI response', {
        model: selection.actualModel,
        promptLength: prompt.length,
        historyLength: history.length,
      })
    }

    let { explanation, config } = parseDiscordResponse(aiResponse.content)
    if (!config && looksLikeServerBuildRequest(prompt)) {
      config = fallbackDiscordPlan(prompt)
      explanation = DISCORD_PLAN_FALLBACK
      console.warn('[Discord chat] AI response missing buildable plan; using safe fallback plan', {
        userId: user.id,
        model: selection.actualModel,
        promptLength: prompt.length,
        responseLength: aiResponse.content.length,
      })
    }
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
