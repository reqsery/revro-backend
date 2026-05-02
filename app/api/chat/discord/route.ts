import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { deductCredits, getModelForPlan, CREDIT_COSTS } from '@/lib/credits';
import { callClaude, getActualModelId } from '@/lib/claude';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

/** Try to pull a JSON block out of Claude's response, return the rest as explanation. */
function parseDiscordResponse(raw: string): { explanation: string; config?: any } {
  const match = raw.match(/```(?:json)?\n([\s\S]*?)```/)
  if (match) {
    try {
      const config = JSON.parse(match[1])
      const explanation = raw.replace(/```(?:json)?\n[\s\S]*?```/g, '').trim()
      return { explanation, config }
    } catch {}
  }
  return { explanation: raw }
}

export async function POST(request: NextRequest) {
  const user = await requireAuth(request);
  if (user instanceof NextResponse) return user;

  try {
    const body = await request.json();

    // Support both old (message/conversationId) and new (prompt/conversation_id) field names
    const prompt: string       = body.prompt ?? body.message ?? ''
    const conversationId: string | undefined = body.conversation_id ?? body.conversationId

    if (!prompt) {
      return NextResponse.json({ error: 'prompt is required' }, { status: 400 });
    }

    const planModel   = getModelForPlan(user.plan)
    const actualModel = getActualModelId(planModel)

    // Fetch conversation history
    let history: any[] = []
    if (conversationId) {
      const { data: msgs } = await supabaseAdmin
        .from('messages')
        .select('role, content')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: true })
      history = msgs ?? []
    }

    const cost = CREDIT_COSTS.PLANNING

    const aiResponse  = await callClaude(actualModel, prompt, 'discord', history)
    const creditResult = await deductCredits(user.id, cost, 'discord_generation', {
      model: planModel,
      actualModel,
      messageLength: prompt.length,
    })

    const { explanation, config } = parseDiscordResponse(aiResponse.content)

    // Save / create conversation
    let convId = conversationId
    if (!convId) {
      const { data: conv } = await supabaseAdmin
        .from('conversations')
        .insert({ user_id: user.id, title: prompt.substring(0, 50), type: 'discord' })
        .select('id')
        .single()
      convId = conv?.id
    }

    let messageId: string | null = null
    if (convId) {
      await supabaseAdmin.from('messages').insert({
        conversation_id: convId,
        role: 'user',
        content: prompt,
      })
      const { data: assistantMsg } = await supabaseAdmin
        .from('messages')
        .insert({
          conversation_id: convId,
          role: 'assistant',
          content: aiResponse.content,
          model_used: planModel,
          credits_cost: cost,
        })
        .select('id')
        .single()
      messageId = assistantMsg?.id ?? null
    }

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
    if (error.message === 'Insufficient credits') {
      return NextResponse.json({ error: 'Insufficient credits' }, { status: 402 });
    }
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
