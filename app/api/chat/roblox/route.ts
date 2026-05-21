import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { deductCredits, tokensToCreditCost, getModelForPlan, CREDIT_COSTS } from '@/lib/credits';
// CREDIT_COSTS is only used for IMAGE; everything else is token-based
import { callAI, streamAI, getActualModelId } from '@/lib/codex';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

// ── Helpers ───────────────────────────────────────────────────────────────────

function getConversationId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (value.startsWith('local_') || value.startsWith('pending_')) return undefined;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : undefined;
}

async function refineImagePrompt(
  model: string,
  planModel: string,
  userPrompt: string
): Promise<{ content: string; cost: number }> {
  const result = await callAI(
    model,
    `Write a concise, vivid image prompt for this Roblox game asset request: ${userPrompt}. Output only the image prompt, no explanation.`,
    'roblox',
    []
  );
  const totalTokens = (result.usage?.input_tokens ?? 0) + (result.usage?.output_tokens ?? 0);
  return {
    content: result.content.trim(),
    cost: totalTokens > 0 ? tokensToCreditCost(planModel, totalTokens) : 0.1,
  };
}

async function generateImage(prompt: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('Image generation is not configured (OPENAI_API_KEY missing)');

  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'gpt-image-1.5',
      prompt,
      n: 1,
      size: '1024x1024',
      output_format: 'png',
      quality: 'medium',
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any)?.error?.message ?? `OpenAI error ${res.status}`);
  }

  const data: any = await res.json();
  const image = data?.data?.[0];
  if (image?.b64_json) return `data:image/png;base64,${image.b64_json}`;
  if (image?.url) return image.url;
  throw new Error('No image output returned from OpenAI');
}

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
    const { data: conv, error: convErr } = await supabaseAdmin
      .from('conversations')
      .insert({ user_id: userId, title: prompt.substring(0, 50), type: 'roblox' })
      .select('id')
      .single();

    if (convErr) {
      console.error('[Roblox chat] Failed to create conversation:', convErr.message);
      throw convErr;
    }
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
        credits_cost: Math.ceil(cost),
        model_used: planModel,
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
    const prompt: string  = body.prompt ?? body.message ?? '';
    const type: string    = body.type   ?? 'script';
    const step: string    = body.step   ?? 'generate';
    const conversationId = getConversationId(body.conversation_id ?? body.conversationId);

    if (!prompt) {
      return NextResponse.json({ error: 'prompt is required' }, { status: 400 });
    }

    const planModel   = getModelForPlan(user.plan);
    const actualModel = getActualModelId(planModel);

    let history: any[] = [];
    if (conversationId) {
      const { data: conversation, error: conversationErr } = await supabaseAdmin
        .from('conversations')
        .select('id, type')
        .eq('id', conversationId)
        .eq('user_id', user.id)
        .maybeSingle();

      if (conversationErr) throw conversationErr;
      if (!conversation || conversation.type !== 'roblox') {
        return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
      }

      const { data: msgs } = await supabaseAdmin
        .from('messages')
        .select('role, content')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: true });
      history = msgs ?? [];
    }

    // ── Image: refine ─────────────────────────────────────────────────────────
    if (type === 'image' && step === 'refine') {
      const { content: refinedPrompt, cost } = await refineImagePrompt(actualModel, planModel, prompt);
      const creditResult = await deductCredits(user.id, cost, 'image_refine', { model: planModel });
      const { convId, messageId } = await saveMessages(
        user.id,
        conversationId,
        prompt,
        refinedPrompt,
        planModel,
        cost,
      );

      return NextResponse.json({
        response: {
          refined_prompt: refinedPrompt,
          explanation: 'Prompt refined. Click Generate to create the image.',
          credits_used: cost,
          credits_remaining: creditResult.creditsRemaining,
        },
        conversation_id: convId,
        message_id: messageId,
      });
    }

    // ── Image: generate ───────────────────────────────────────────────────────
    if (type === 'image' && step === 'generate') {
      const cost = CREDIT_COSTS.IMAGE;
      const imageUrl = await generateImage(prompt);
      const creditResult = await deductCredits(user.id, cost, 'image_generation', { model: 'gpt-image-1.5' });
      const { convId, messageId } = await saveMessages(
        user.id,
        conversationId,
        prompt,
        'Image generated successfully.',
        planModel,
        cost,
      );

      return NextResponse.json({
        response: {
          image_url: imageUrl,
          explanation: 'Image generated successfully.',
          credits_used: cost,
          credits_remaining: creditResult.creditsRemaining,
        },
        conversation_id: convId,
        message_id: messageId,
      });
    }

    // ── Script / UI: streaming SSE with token-based billing ───────────────────

    // Pre-flight: user must have at least 1 credit
    const { data: creditCheck } = await supabaseAdmin
      .from('users')
      .select('credits_used, credits_total')
      .eq('id', user.id)
      .single();

    if (!creditCheck || (creditCheck.credits_total - creditCheck.credits_used) <= 0) {
      return NextResponse.json({ error: 'Insufficient credits' }, { status: 402 });
    }

    const encoder = new TextEncoder();
    let clientCancelled = false;

    const readable = new ReadableStream({
      async start(controller) {
        let fullContent  = '';
        let inputTokens  = 0;
        let outputTokens = 0;

        try {
          const aiStream = streamAI(actualModel, prompt, 'roblox', history);

          for await (const chunk of aiStream) {
            // Stop if client disconnected — don't charge
            if (clientCancelled) break;

            if (chunk.type === 'message_start') {
              inputTokens = chunk.message?.usage?.input_tokens ?? 0;
            } else if (chunk.type === 'message_delta') {
              outputTokens = (chunk as any).usage?.output_tokens ?? 0;
            } else if (
              chunk.type === 'content_block_delta' &&
              chunk.delta.type === 'text_delta'
            ) {
              fullContent += chunk.delta.text;
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ type: 'delta', text: chunk.delta.text })}\n\n`)
              );
            }
          }

          // Client cancelled mid-stream — don't charge, don't save
          if (clientCancelled) {
            controller.close();
            return;
          }

          // Calculate token-based cost
          const totalTokens = inputTokens + outputTokens;
          const tokenCost   = totalTokens > 0
            ? tokensToCreditCost(planModel, totalTokens)
            : 0.1; // near-zero fallback if token data somehow missing

          const creditResult = await deductCredits(user.id, tokenCost, `${type}_generation`, {
            model: planModel,
            actualModel,
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            total_tokens: totalTokens,
          });

          const { convId, messageId } = await saveMessages(
            user.id,
            conversationId,
            prompt,
            fullContent,
            planModel,
            tokenCost,
          );

          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                type: 'done',
                credits_used: tokenCost,
                credits_remaining: creditResult.creditsRemaining,
                conversation_id: convId,
                message_id: messageId,
                tokens: { input: inputTokens, output: outputTokens, total: totalTokens },
              })}\n\n`
            )
          );

        } catch (err: any) {
          if (!clientCancelled) {
            console.error('[Roblox stream] Error:', err.message);
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ type: 'error', error: err.message || 'Internal server error' })}\n\n`
              )
            );
          }
        } finally {
          controller.close();
        }
      },

      // Called when the client disconnects (fetch aborted)
      cancel() {
        clientCancelled = true;
        console.log('[Roblox stream] Client disconnected — not charging credits');
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
