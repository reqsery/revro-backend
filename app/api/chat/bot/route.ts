import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { deductCredits, estimateTokenCostUsd, getModelForPlan, hasCredits } from '@/lib/credits';
import { callAI, selectAIModel, estimateInputTokens, getAIRoutingDebug } from '@/lib/codex';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const maxDuration = 60; // Long bot code generation can take up to 60s

export async function POST(request: NextRequest) {
  const user = await requireAuth(request);
  if (user instanceof NextResponse) return user;

  try {
    const body = await request.json();
    const prompt: string = body.prompt ?? '';
    const botName: string = body.bot_name ?? 'My Bot';

    if (!prompt) {
      return NextResponse.json({ error: 'prompt is required' }, { status: 400 });
    }

    const planModel = getModelForPlan(user.plan);
    if (!(await hasCredits(user.id, 0.000001))) {
      return NextResponse.json({ error: 'Insufficient AI Wallet balance' }, { status: 402 });
    }

    const fullPrompt = `Create a Discord bot named "${botName}". ${prompt}`;
    const selection = selectAIModel(planModel, 'bot', fullPrompt);
    console.info('[AI route]', {
      route: 'bot',
      provider: selection.provider,
      model: selection.actualModel,
      selectedModelTier: planModel,
      ...getAIRoutingDebug('bot', fullPrompt, planModel),
      inputTokenEstimate: estimateInputTokens(fullPrompt, []),
    });
    const aiResponse = await callAI(selection, fullPrompt, 'bot', []);

    const cost = estimateTokenCostUsd(
      selection.actualModel,
      aiResponse.usage?.input_tokens ?? 0,
      aiResponse.usage?.output_tokens ?? 0,
    );

    const creditResult = await deductCredits(user.id, cost, 'bot_generation', {
      model: selection.logicalModel,
      actualModel: selection.actualModel,
      provider: selection.provider,
      input_tokens: aiResponse.usage?.input_tokens,
      output_tokens: aiResponse.usage?.output_tokens,
      image_cost: null,
      file_context_cost: null,
      estimated_real_usd_cost: cost,
    });
    console.info('[AI generation]', {
      route: 'bot',
      provider: selection.provider,
      model: selection.actualModel,
      selectedModelTier: planModel,
      ...getAIRoutingDebug('bot', fullPrompt, planModel),
      inputTokenEstimate: estimateInputTokens(fullPrompt, []),
      inputTokens: aiResponse.usage?.input_tokens ?? 0,
      outputTokens: aiResponse.usage?.output_tokens ?? 0,
      imageCost: null,
      fileContextCost: null,
      estimatedRealUsdCost: cost,
      deductedWalletAmount: cost,
      userId: user.id,
    });

    // Extract code block from response
    const codeMatch = aiResponse.content.match(/```(?:javascript|js)?\n([\s\S]*?)```/);
    const code = codeMatch ? codeMatch[1].trim() : null;
    const explanation = aiResponse.content.replace(/```(?:javascript|js)?\n[\s\S]*?```/g, '').trim();

    return NextResponse.json({
      response: {
        explanation,
        code,
        credits_used: cost,
        credits_remaining: creditResult.creditsRemaining,
      },
    });

  } catch (error: any) {
    console.error('[Bot chat] Error:', error);
    if (error.message === 'Insufficient AI Wallet balance') {
      return NextResponse.json({ error: error.message }, { status: 402 });
    }
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
