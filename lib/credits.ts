import { supabaseAdmin } from './supabase';

// Credit costs for different actions
export const CREDIT_COSTS = {
  // Roblox
  SCRIPT_SIMPLE: 2,
  SCRIPT_MEDIUM: 5,
  SCRIPT_COMPLEX: 10,
  SCRIPT_SYSTEM: 15,
  UI_SIMPLE: 5,
  UI_MEDIUM: 10,
  UI_ADVANCED: 15,
  IMAGE: 5,
  
  // Discord
  CHANNEL_CREATE: 1,
  ROLE_CREATE: 1,
  AUTOROLE: 1,
  WELCOME_MESSAGE: 2,
  PLANNING: 3,
  BLUEPRINT: 5
};

// Plan configuration with Claude models
export const PLAN_CONFIG = {
  free: {
    credits: 25,
    images_max: 0,
    model: 'claude-sonnet-4-5',
    display_name: 'Standard AI'
  },
  starter: {
    credits: 150,
    images_max: 0,
    model: 'claude-sonnet-4-6',
    display_name: 'Advanced AI'
  },
  pro: {
    credits: 500,
    images_max: 50,
    model: 'claude-opus-4-6',
    display_name: 'Premium AI'
  },
  studio: {
    credits: 1500,
    images_max: 150,
    model: 'claude-opus-4-6',
    display_name: 'Premium AI'
  }
};

// Get Claude model for user's plan
export function getModelForPlan(plan: string): string {
  const config = PLAN_CONFIG[plan as keyof typeof PLAN_CONFIG];
  return config?.model || 'claude-sonnet-4-5';
}

// Check if user has enough credits
export async function hasCredits(userId: string, cost: number): Promise<boolean> {
  const { data: user } = await supabaseAdmin
    .from('users')
    .select('credits_used, credits_total')
    .eq('id', userId)
    .single();

  if (!user) throw new Error('User not found');

  const available = user.credits_total - user.credits_used;
  return available >= cost;
}

// Deduct credits from user
export async function deductCredits(
  userId: string, 
  cost: number, 
  actionType: string, 
  metadata: any = {}
) {
  const { data: user } = await supabaseAdmin
    .from('users')
    .select('credits_used, credits_total')
    .eq('id', userId)
    .single();

  if (!user) throw new Error('User not found');

  const available = user.credits_total - user.credits_used;
  if (available < cost) {
    throw new Error('Insufficient credits');
  }

  // Update credits_used
  await supabaseAdmin
    .from('users')
    .update({ credits_used: user.credits_used + cost })
    .eq('id', userId);

  // Log usage
  await supabaseAdmin
    .from('usage_log')
    .insert({
      user_id: userId,
      action_type: actionType,
      credits_cost: cost,
      model_used: metadata.model || null,
      metadata
    });

  return {
    success: true,
    creditsUsed: user.credits_used + cost,
    creditsRemaining: user.credits_total - (user.credits_used + cost)
  };
}

// Get user's current credit balance
export async function getCreditBalance(userId: string) {
  const { data: user } = await supabaseAdmin
    .from('users')
    .select('credits_used, credits_total, plan')
    .eq('id', userId)
    .single();

  if (!user) throw new Error('User not found');

  return {
    used: user.credits_used,
    total: user.credits_total,
    remaining: user.credits_total - user.credits_used,
    plan: user.plan
  };
}

// Check if user can generate images
export async function canGenerateImages(userId: string, count: number = 1) {
  const { data: user } = await supabaseAdmin
    .from('users')
    .select('plan, images_generated')
    .eq('id', userId)
    .single();

  if (!user) throw new Error('User not found');

  const planConfig = PLAN_CONFIG[user.plan as keyof typeof PLAN_CONFIG];
  if (!planConfig || planConfig.images_max === 0) {
    return { 
      allowed: false, 
      reason: 'Plan does not support image generation' 
    };
  }

  if (user.images_generated + count > planConfig.images_max) {
    return { 
      allowed: false, 
      reason: `Monthly image limit reached (${planConfig.images_max})`,
      current: user.images_generated,
      max: planConfig.images_max
    };
  }

  return { allowed: true };
}

// Increment image generation count
export async function incrementImageCount(userId: string, count: number = 1) {
  const { data: user } = await supabaseAdmin
    .from('users')
    .select('images_generated')
    .eq('id', userId)
    .single();

  if (!user) throw new Error('User not found');

  await supabaseAdmin
    .from('users')
    .update({ images_generated: user.images_generated + count })
    .eq('id', userId);
}
