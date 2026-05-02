import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { deductCredits, tokensToCreditCost, getModelForPlan } from '@/lib/credits';
import { callClaude, getActualModelId } from '@/lib/claude';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

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

    const planModel   = getModelForPlan(user.plan);
    const actualModel = getActualModelId(planModel);

    const fullPrompt = `Create a Discord bot named "${botName}". ${prompt}`;
    const aiResponse = await callClaude(actualModel, fullPrompt, 'bot', []);

    const totalTokens = (aiResponse.usage?.input_tokens ?? 0) + (aiResponse.usage?.output_tokens ?? 0);
    const cost = totalTokens > 0 ? tokensToCreditCost(planModel, totalTokens) : 1;

    const creditResult = await deductCredits(user.id, cost, 'bot_generation', {
      model: planModel, actualModel,
      input_tokens: aiResponse.usage?.input_tokens,
      output_tokens: aiResponse.usage?.output_tokens,
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
    if (error.message === 'Insufficient credits') {
      return NextResponse.json({ error: 'Insufficient credits' }, { status: 402 });
    }
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
