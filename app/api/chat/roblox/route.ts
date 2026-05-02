import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { deductCredits, getModelForPlan, CREDIT_COSTS } from '@/lib/credits';
import { callClaude, getActualModelId } from '@/lib/claude';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Extract the first ```lua / ```luau code block from Claude's response. */
function parseRobloxResponse(raw: string): { code?: string; explanation: string } {
  const match = raw.match(/```(?:lua|luau)?\n([\s\S]*?)```/)
  if (match) {
    const code = match[1].trim()
    const explanation = raw.replace(/```(?:lua|luau)?\n[\s\S]*?```/g, '').trim()
    return { code, explanation }
  }
  return { explanation: raw }
}

/** Refine a user's asset description into a DALL-E-ready prompt using Claude. */
async function refineImagePrompt(model: string, userPrompt: string): Promise<string> {
  const system = `You are an expert at writing prompts for AI image generation of Roblox game assets.
Given a user's description, write a concise, vivid DALL-E 3 prompt optimised for game asset creation.
Reply with ONLY the improved prompt — no explanation, no quotes.`

  const result = await callClaude(model, userPrompt, 'roblox', [
    { role: 'user', content: `Write a DALL-E 3 prompt for this Roblox game asset: ${userPrompt}` }
  ])
  // callClaude prepends the user message to history so strip it & return the text
  return result.content.trim()
}

/** Generate an image via OpenAI DALL-E 3. Returns the hosted URL. */
async function generateImage(prompt: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('Image generation is not configured (OPENAI_API_KEY missing)')

  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: 'dall-e-3', prompt, n: 1, size: '1024x1024' }),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error((err as any)?.error?.message ?? `OpenAI error ${res.status}`)
  }

  const data: any = await res.json()
  const url = data?.data?.[0]?.url
  if (!url) throw new Error('No image URL returned from OpenAI')
  return url
}

// ── Route ─────────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const user = await requireAuth(request);
  if (user instanceof NextResponse) return user;

  try {
    const body = await request.json();

    // Support both old field names (message/conversationId) and new ones (prompt/conversation_id)
    const prompt: string        = body.prompt ?? body.message ?? ''
    const type: string          = body.type   ?? 'script'        // 'script' | 'ui' | 'image'
    const step: string          = body.step   ?? 'generate'      // image only: 'refine' | 'generate'
    const conversationId: string | undefined = body.conversation_id ?? body.conversationId

    if (!prompt) {
      return NextResponse.json({ error: 'prompt is required' }, { status: 400 });
    }

    const planModel   = getModelForPlan(user.plan)
    const actualModel = getActualModelId(planModel)

    // Fetch conversation history if continuing
    let history: any[] = []
    if (conversationId) {
      const { data: msgs } = await supabaseAdmin
        .from('messages')
        .select('role, content')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: true })
      history = msgs ?? []
    }

    // ── Image: refine ──────────────────────────────────────────────────────
    if (type === 'image' && step === 'refine') {
      const cost = CREDIT_COSTS.SCRIPT_SIMPLE
      const creditResult = await deductCredits(user.id, cost, 'image_refine', { model: planModel })

      const refinedPrompt = await refineImagePrompt(actualModel, prompt)

      return NextResponse.json({
        response: {
          refined_prompt: refinedPrompt,
          explanation: 'Prompt refined. Click Generate to create the image.',
          credits_used: cost,
          credits_remaining: creditResult.creditsRemaining,
        },
        conversation_id: conversationId ?? null,
        message_id: null,
      })
    }

    // ── Image: generate ────────────────────────────────────────────────────
    if (type === 'image' && step === 'generate') {
      const cost = CREDIT_COSTS.IMAGE
      const creditResult = await deductCredits(user.id, cost, 'image_generation', { model: 'dall-e-3' })

      const imageUrl = await generateImage(prompt)

      return NextResponse.json({
        response: {
          image_url: imageUrl,
          explanation: 'Image generated successfully.',
          credits_used: cost,
          credits_remaining: creditResult.creditsRemaining,
        },
        conversation_id: conversationId ?? null,
        message_id: null,
      })
    }

    // ── Script or UI ──────────────────────────────────────────────────────
    const cost = type === 'ui' ? CREDIT_COSTS.UI_MEDIUM : CREDIT_COSTS.SCRIPT_MEDIUM

    const aiResponse = await callClaude(actualModel, prompt, 'roblox', history)
    const creditResult = await deductCredits(user.id, cost, `${type}_generation`, {
      model: planModel,
      actualModel,
      messageLength: prompt.length,
    })

    const { code, explanation } = parseRobloxResponse(aiResponse.content)

    // Save / create conversation
    let convId = conversationId
    if (!convId) {
      const { data: conv } = await supabaseAdmin
        .from('conversations')
        .insert({ user_id: user.id, title: prompt.substring(0, 50), type: 'roblox' })
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
        code,
        explanation,
        credits_used: cost,
        credits_remaining: creditResult.creditsRemaining,
      },
      conversation_id: convId ?? null,
      message_id: messageId,
    });

  } catch (error: any) {
    console.error('[Roblox chat] Error:', error);
    if (error.message === 'Insufficient credits') {
      return NextResponse.json({ error: 'Insufficient credits' }, { status: 402 });
    }
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
