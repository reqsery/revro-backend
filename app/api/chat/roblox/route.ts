import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import {
  canGenerateImages,
  deductCredits,
  getModelForPlan,
  incrementImageCount,
  tokensToCreditCost,
  CREDIT_COSTS,
} from '@/lib/credits';
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

type ImagePrompt = {
  label: string;
  prompt: string;
};

function parseImagePrompts(raw: string, userPrompt: string): ImagePrompt[] {
  const jsonText = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? raw;

  try {
    const parsed = JSON.parse(jsonText);
    const prompts = Array.isArray(parsed?.prompts) ? parsed.prompts : [];
    const normalized = prompts
      .map((item: any, index: number) => ({
        label: typeof item?.label === 'string' && item.label.trim()
          ? item.label.trim().slice(0, 40)
          : `Asset ${index + 1}`,
        prompt: typeof item?.prompt === 'string' ? item.prompt.trim() : '',
      }))
      .filter((item: ImagePrompt) => item.prompt.length > 0)
      .slice(0, 3);

    if (normalized.length > 0) return normalized;
  } catch {}

  return [{
    label: 'Roblox asset',
    prompt: raw.trim() || userPrompt,
  }];
}

function normalizeImagePrompts(value: unknown, fallbackPrompt: string): ImagePrompt[] {
  if (!Array.isArray(value)) {
    return [{ label: 'Roblox asset', prompt: fallbackPrompt.trim() }].filter(item => item.prompt);
  }

  return value
    .map((item: any, index: number) => ({
      label: typeof item?.label === 'string' && item.label.trim()
        ? item.label.trim().slice(0, 40)
        : `Asset ${index + 1}`,
      prompt: typeof item?.prompt === 'string' ? item.prompt.trim() : '',
    }))
    .filter((item: ImagePrompt) => item.prompt.length > 0)
    .slice(0, 3);
}

async function refineImagePrompt(
  model: string,
  planModel: string,
  userPrompt: string
): Promise<{ prompts: ImagePrompt[]; cost: number }> {
  const result = await callAI(
    model,
    `Plan Roblox image assets for this request: ${userPrompt}

Return JSON only in this exact shape:
{"prompts":[{"label":"Icon","prompt":"..."},{"label":"Menu","prompt":"..."}]}

Rules:
- Produce 1 prompt for one deliverable, 2 prompts when the user asks for separate assets such as "icon and menu", and never more than 3 prompts.
- Target polished Roblox simulator game assets that look usable in-game, not generic sci-fi concept art or a standalone app dashboard.
- For an icon, ask for a clean readable Roblox game icon on transparent or plain removable background with bold shapes and strong silhouette.
- For a menu/panel, ask for a Roblox in-game UI mockup/panel with readable hierarchy, button states, progress/currency rows, and simulator-style proportions.
- Do not put the requested icon inside a menu render unless the user explicitly asks for one combined image.
- Keep each prompt concrete and faithful to the user's subject, colors, and style clues.`,
    'roblox',
    []
  );
  const totalTokens = (result.usage?.input_tokens ?? 0) + (result.usage?.output_tokens ?? 0);
  return {
    prompts: parseImagePrompts(result.content, userPrompt),
    cost: totalTokens > 0 ? tokensToCreditCost(planModel, totalTokens) : 0.1,
  };
}

function getImageOptions(asset: ImagePrompt) {
  const label = asset.label.toLowerCase();
  const prompt = asset.prompt.toLowerCase();
  const isIcon = label.includes('icon') || prompt.includes('icon');
  const isMenu = label.includes('menu') || label.includes('panel') || prompt.includes('menu');

  return {
    background: isIcon ? 'transparent' : 'auto',
    size: isMenu ? '1536x1024' : '1024x1024',
  };
}

async function generateImage(asset: ImagePrompt): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('Image generation is not configured (OPENAI_API_KEY missing)');
  const options = getImageOptions(asset);

  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'gpt-image-1.5',
      prompt: asset.prompt,
      n: 1,
      size: options.size,
      background: options.background,
      output_format: 'png',
      quality: 'high',
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

    const imagePrompts = normalizeImagePrompts(body.prompts, prompt);

    if (!prompt && !(type === 'image' && step === 'generate' && imagePrompts.length > 0)) {
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
      if (!conversation) {
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
      const { prompts: refinedPrompts, cost } = await refineImagePrompt(actualModel, planModel, prompt);
      const creditResult = await deductCredits(user.id, cost, 'image_refine', { model: planModel });
      const promptSummary = refinedPrompts.map(item => `${item.label}: ${item.prompt}`).join('\n\n');
      const { convId, messageId } = await saveMessages(
        user.id,
        conversationId,
        prompt,
        promptSummary,
        planModel,
        cost,
      );

      return NextResponse.json({
        response: {
          refined_prompt: refinedPrompts[0]?.prompt,
          refined_prompts: refinedPrompts,
          image_count: refinedPrompts.length,
          explanation: refinedPrompts.length > 1
            ? `Prepared ${refinedPrompts.length} Roblox assets. Review them, then generate.`
            : 'Prepared a Roblox asset prompt. Review it, then generate.',
          credits_used: cost,
          credits_remaining: creditResult.creditsRemaining,
        },
        conversation_id: convId,
        message_id: messageId,
      });
    }

    // ── Image: generate ───────────────────────────────────────────────────────
    if (type === 'image' && step === 'generate') {
      const prompts = imagePrompts.length > 0
        ? imagePrompts
        : [{ label: 'Roblox asset', prompt }];
      const imageAllowance = await canGenerateImages(user.id, prompts.length);
      if (!imageAllowance.allowed) {
        return NextResponse.json({ error: imageAllowance.reason }, { status: 402 });
      }

      const cost = CREDIT_COSTS.IMAGE * prompts.length;
      const imageUrls = await Promise.all(prompts.map(item => generateImage(item)));
      const creditResult = await deductCredits(user.id, cost, 'image_generation', { model: 'gpt-image-1.5' });
      await incrementImageCount(user.id, prompts.length);
      const { convId, messageId } = await saveMessages(
        user.id,
        conversationId,
        prompt || prompts.map(item => item.prompt).join('\n\n'),
        `Generated ${prompts.length} Roblox image asset${prompts.length === 1 ? '' : 's'}.`,
        planModel,
        cost,
      );

      return NextResponse.json({
        response: {
          image_url: imageUrls[0],
          image_urls: imageUrls,
          image_count: imageUrls.length,
          explanation: `Generated ${imageUrls.length} Roblox image asset${imageUrls.length === 1 ? '' : 's'}.`,
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
