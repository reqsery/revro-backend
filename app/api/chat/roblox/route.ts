import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { deductCredits, getModelForPlan, CREDIT_COSTS } from '@/lib/credits';
import { callClaude, streamClaude, getActualModelId } from '@/lib/claude';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Refine a user's asset description into a DALL-E-ready prompt using Claude. */
async function refineImagePrompt(model: string, userPrompt: string): Promise<string> {
  const result = await callClaude(model, userPrompt, 'roblox', [
    { role: 'user', content: `Write a DALL-E 3 prompt for this Roblox game asset: ${userPrompt}` },
  ]);
  return result.content.trim();
}

/** Generate an image via OpenAI DALL-E 3. Returns the hosted URL. */
async function generateImage(prompt: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('Image generation is not configured (OPENAI_API_KEY missing)');

  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: 'dall-e-3', prompt, n: 1, size: '1024x1024' }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any)?.error?.message ?? `OpenAI error ${res.status}`);
  }

  const data: any = await res.json();
  const url = data?.data?.[0]?.url;
  if (!url) throw new Error('No image URL returned from OpenAI');
  return url;
}

// ── Shared: save conversation + messages ──────────────────────────────────────

async function saveMessages(
  userId: string,
  conversationId: string | undefined,
  prompt: string,
  responseText: string,
  planModel: string,
  cost: number,
): Promise<{ convId: string | null; messageId: string | null }> {
  let convId: string | null = conversationId ?? null;

  if (!convId) {
    const { data: conv } = await supabaseAdmin
      .from('conversations')
      .insert({ user_id: userId, title: prompt.substring(0, 50), type: 'roblox' })
      .select('id')
      .single();
    convId = conv?.id ?? null;
  }

  let messageId: string | null = null;
  if (convId) {
    await supabaseAdmin.from('messages').insert({
      conversation_id: convId,
      role: 'user',
      content: prompt,
    });
    const { data: assistantMsg } = await supabaseAdmin
      .from('messages')
      .insert({
        conversation_id: convId,
        role: 'assistant',
        content: responseText,
        model_used: planModel,
        credits_cost: cost,
      })
      .select('id')
      .single();
    messageId = assistantMsg?.id ?? null;
  }

  return { convId, messageId };
}

// ── Route ─────────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const user = await requireAuth(request);
  if (user instanceof NextResponse) return user;

  try {
    const body = await request.json();
    const prompt: string       = body.prompt ?? body.message ?? '';
    const type: string         = body.type   ?? 'script';   // 'script' | 'ui' | 'image'
    const step: string         = body.step   ?? 'generate'; // image only: 'refine' | 'generate'
    const conversationId: string | undefined = body.conversation_id ?? body.conversationId;

    if (!prompt) {
      return NextResponse.json({ error: 'prompt is required' }, { status: 400 });
    }

    const planModel   = getModelForPlan(user.plan);
    const actualModel = getActualModelId(planModel);

    // Fetch conversation history if continuing
    let history: any[] = [];
    if (conversationId) {
      const { data: msgs } = await supabaseAdmin
        .from('messages')
        .select('role, content')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: true });
      history = msgs ?? [];
    }

    // ── Image: refine (non-streaming) ─────────────────────────────────────────
    if (type === 'image' && step === 'refine') {
      const cost = CREDIT_COSTS.SCRIPT_SIMPLE;
      const creditResult = await deductCredits(user.id, cost, 'image_refine', { model: planModel });
      const refinedPrompt = await refineImagePrompt(actualModel, prompt);

      return NextResponse.json({
        response: {
          refined_prompt: refinedPrompt,
          explanation: 'Prompt refined. Click Generate to create the image.',
          credits_used: cost,
          credits_remaining: creditResult.creditsRemaining,
        },
        conversation_id: conversationId ?? null,
        message_id: null,
      });
    }

    // ── Image: generate (non-streaming) ──────────────────────────────────────
    if (type === 'image' && step === 'generate') {
      const cost = CREDIT_COSTS.IMAGE;
      const creditResult = await deductCredits(user.id, cost, 'image_generation', { model: 'dall-e-3' });
      const imageUrl = await generateImage(prompt);

      return NextResponse.json({
        response: {
          image_url: imageUrl,
          explanation: 'Image generated successfully.',
          credits_used: cost,
          credits_remaining: creditResult.creditsRemaining,
        },
        conversation_id: conversationId ?? null,
        message_id: null,
      });
    }

    // ── Script / UI: streaming SSE ────────────────────────────────────────────
    const cost = type === 'ui' ? CREDIT_COSTS.UI_MEDIUM : CREDIT_COSTS.SCRIPT_MEDIUM;

    // Pre-flight credit check — fail fast before we open a stream
    const { data: creditCheck } = await supabaseAdmin
      .from('users')
      .select('credits_used, credits_total')
      .eq('id', user.id)
      .single();

    if (!creditCheck || (creditCheck.credits_total - creditCheck.credits_used) < cost) {
      return NextResponse.json({ error: 'Insufficient credits' }, { status: 402 });
    }

    const encoder = new TextEncoder();

    const readable = new ReadableStream({
      async start(controller) {
        let fullContent = '';
        try {
          const claudeStream = streamClaude(actualModel, prompt, 'roblox', history);

          for await (const chunk of claudeStream) {
            if (
              chunk.type === 'content_block_delta' &&
              chunk.delta.type === 'text_delta'
            ) {
              fullContent += chunk.delta.text;
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: 'delta', text: chunk.delta.text })}\n\n`
                )
              );
            }
          }

          // Deduct credits after stream completes
          const creditResult = await deductCredits(user.id, cost, `${type}_generation`, {
            model: planModel,
            actualModel,
            messageLength: prompt.length,
          });

          // Save to DB
          const { convId, messageId } = await saveMessages(
            user.id,
            conversationId,
            prompt,
            fullContent,
            planModel,
            cost,
          );

          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                type: 'done',
                credits_used: cost,
                credits_remaining: creditResult.creditsRemaining,
                conversation_id: convId,
                message_id: messageId,
              })}\n\n`
            )
          );
        } catch (err: any) {
          console.error('[Roblox stream] Error:', err.message);
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: 'error', error: err.message || 'Internal server error' })}\n\n`
            )
          );
        } finally {
          controller.close();
        }
      },
    });

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });

  } catch (error: any) {
    console.error('[Roblox chat] Error:', error);
    if (error.message === 'Insufficient credits') {
      return NextResponse.json({ error: 'Insufficient credits' }, { status: 402 });
    }
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
