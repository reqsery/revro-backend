import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { deductCredits, getModelForPlan, CREDIT_COSTS } from '@/lib/credits';
import { callClaude, getActualModelId } from '@/lib/claude';
import { supabaseAdmin } from '@/lib/supabase';

export async function POST(request: NextRequest) {
  const user = await requireAuth(request);
  
  if (user instanceof NextResponse) {
    return user;
  }

  try {
    const { message, conversationId } = await request.json();

    if (!message) {
      return NextResponse.json(
        { error: 'Message is required' },
        { status: 400 }
      );
    }

    // Get model for user's plan
    const planModel = getModelForPlan(user.plan);
    const actualModelId = getActualModelId(planModel);

    // Get conversation history
    let conversationHistory: any[] = [];
    if (conversationId) {
      const { data: messages } = await supabaseAdmin
        .from('messages')
        .select('role, content')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: true });
      
      conversationHistory = messages || [];
    }

    // Estimate credit cost
    const estimatedCost = CREDIT_COSTS.PLANNING;

    // Call Claude API
    const aiResponse = await callClaude(
      actualModelId,
      message,
      'discord',
      conversationHistory
    );

    // Deduct credits
    const creditResult = await deductCredits(
      user.id,
      estimatedCost,
      'discord_generation',
      { 
        model: planModel,
        actualModel: actualModelId,
        messageLength: message.length 
      }
    );

    // Save to conversation
    let convId = conversationId;
    if (!convId) {
      const { data: conv } = await supabaseAdmin
        .from('conversations')
        .insert({
          user_id: user.id,
          title: message.substring(0, 50),
          type: 'discord'
        })
        .select()
        .single();
      convId = conv?.id;
    }

    if (convId) {
      await supabaseAdmin.from('messages').insert([
        {
          conversation_id: convId,
          role: 'user',
          content: message
        },
        {
          conversation_id: convId,
          role: 'assistant',
          content: aiResponse.content,
          model_used: planModel,
          credits_cost: estimatedCost
        }
      ]);
    }

    return NextResponse.json({
      response: aiResponse.content,
      conversationId: convId,
      creditsUsed: estimatedCost,
      creditsRemaining: creditResult.creditsRemaining,
      model: 'Revro AI'
    });

  } catch (error: any) {
    console.error('Discord chat error:', error);
    
    if (error.message === 'Insufficient credits') {
      return NextResponse.json(
        { error: 'Insufficient credits' },
        { status: 402 }
      );
    }

    return NextResponse.json(
      { error: error.message || 'Internal server error' },
      { status: 500 }
    );
  }
}
