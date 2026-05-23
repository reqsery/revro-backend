import { supabaseAdmin } from './supabase';
import { fireResendEvent } from './resend';

// Legacy export name retained so route interfaces stay stable. Values are AI
// Wallet USD deductions, not customer-facing credits.
export const CREDIT_COSTS = {
  SCRIPT_SIMPLE: 0.002,
  SCRIPT_MEDIUM: 0.005,
  SCRIPT_COMPLEX: 0.01,
  SCRIPT_SYSTEM: 0.015,
  UI_SIMPLE: 0.005,
  UI_MEDIUM: 0.01,
  UI_ADVANCED: 0.015,
  IMAGE: 0.034,
  CHANNEL_CREATE: 0.002,
  ROLE_CREATE: 0.002,
  AUTOROLE: 0.002,
  WELCOME_MESSAGE: 0.004,
  PLANNING: 0.01,
  BLUEPRINT: 0.02,
  DISCORD_BUILD: 0.02,
};

// USD per 1M tokens. Keep these rates in one place so analytics and wallet
// charges use the same cost estimate.
export const MODEL_TOKEN_USD_PER_MILLION: Record<string, { input: number; output: number }> = {
  'codex-mini': { input: 1.5, output: 6 },
  'codex-standard': { input: 1.25, output: 10 },
  'codex-advanced': { input: 1.25, output: 10 },
  'codex-premium': { input: 1.25, output: 10 },
  'codex-mini-latest': { input: 1.5, output: 6 },
  'gpt-5.1-codex': { input: 1.25, output: 10 },
  'gemini-flash': { input: 0.3, output: 2.5 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5 },
  'gemini-2.5-flash-lite': { input: 0.1, output: 0.4 },
  'gemini-3.1-flash-lite': { input: 0.1, output: 0.4 },
};

export function estimateTokenCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const rate = MODEL_TOKEN_USD_PER_MILLION[model] ?? MODEL_TOKEN_USD_PER_MILLION['codex-standard'];
  const cost = ((inputTokens * rate.input) + (outputTokens * rate.output)) / 1_000_000;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

// Compatibility helper for older callers that only pass a total token count.
// New generation routes should prefer estimateTokenCostUsd with real usage.
export function tokensToCreditCost(planModel: string, totalTokens: number): number {
  return estimateTokenCostUsd(planModel, totalTokens, 0);
}

export const PLAN_CONFIG = {
  free: {
    credits: 25,
    wallet_monthly_usd: 0.5,
    wallet_annual_usd: 0.5,
    images_max: 0,
    model: 'codex-mini',
    display_name: 'Basic AI',
  },
  pro: {
    credits: 500,
    wallet_monthly_usd: 10,
    wallet_annual_usd: 120,
    images_max: 50,
    model: 'codex-standard',
    display_name: 'Standard AI',
  },
  dev: {
    credits: 150,
    wallet_monthly_usd: 30,
    wallet_annual_usd: 360,
    images_max: 100,
    model: 'codex-premium',
    display_name: 'Premium AI',
  },
  studio: {
    credits: 1500,
    wallet_monthly_usd: 85,
    wallet_annual_usd: 1020,
    images_max: 150,
    model: 'codex-premium',
    display_name: 'Premium AI',
  },
  // Existing memberships can carry the pre-wallet key until Whop renews them.
  starter: {
    credits: 150,
    wallet_monthly_usd: 30,
    wallet_annual_usd: 360,
    images_max: 100,
    model: 'codex-premium',
    display_name: 'Premium AI',
  },
};

const LOW_WALLET_THRESHOLDS: Partial<Record<keyof typeof PLAN_CONFIG, number>> = {
  pro: 1,
  dev: 3,
  starter: 3,
  studio: 8.5,
};

export function getModelForPlan(plan: string): string {
  const config = PLAN_CONFIG[plan as keyof typeof PLAN_CONFIG];
  return config?.model || 'codex-mini';
}

function roundWallet(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export async function hasCredits(userId: string, cost: number): Promise<boolean> {
  const { data: user } = await supabaseAdmin
    .from('users')
    .select('monthly_wallet_balance, extra_wallet_balance')
    .eq('id', userId)
    .single();

  if (!user) throw new Error('User not found');
  return Number(user.monthly_wallet_balance ?? 0) + Number(user.extra_wallet_balance ?? 0) >= cost;
}

export async function deductCredits(
  userId: string,
  cost: number,
  actionType: string,
  metadata: any = {},
): Promise<{
  success: boolean;
  creditsUsed: number;
  creditsRemaining: number;
  walletDeducted: number;
  walletRemaining: number;
}> {
  const walletCost = roundWallet(Math.max(Number(cost) || 0, 0));
  const { data: walletRow, error: fetchErr } = await supabaseAdmin
    .from('users')
    .select('monthly_wallet_balance, extra_wallet_balance, wallet_spent, email, display_name, plan, billing_cycle_start')
    .eq('id', userId)
    .single();

  if (fetchErr || !walletRow) throw new Error('User not found');

  const monthlyWallet = Number(walletRow.monthly_wallet_balance ?? 0);
  const extraWallet = Number(walletRow.extra_wallet_balance ?? 0);
  const available = monthlyWallet + extraWallet;
  if (available < walletCost) throw new Error('Insufficient AI Wallet balance');

  const fromMonthly = Math.min(monthlyWallet, walletCost);
  const fromExtra = Math.max(walletCost - fromMonthly, 0);
  const nextMonthlyWallet = roundWallet(Math.max(monthlyWallet - fromMonthly, 0));
  const nextExtraWallet = roundWallet(Math.max(extraWallet - fromExtra, 0));
  const remaining = roundWallet(nextMonthlyWallet + nextExtraWallet);

  const { error: updateErr } = await supabaseAdmin
    .from('users')
    .update({
      monthly_wallet_balance: nextMonthlyWallet,
      extra_wallet_balance: nextExtraWallet,
      wallet_spent: roundWallet(Number(walletRow.wallet_spent ?? 0) + walletCost),
      updated_at: new Date().toISOString(),
    })
    .eq('id', userId);

  if (updateErr) throw new Error(`AI Wallet update failed: ${updateErr.message}`);

  const usageMetadata = {
    ...metadata,
    estimated_real_usd_cost: metadata?.estimated_real_usd_cost ?? walletCost,
    deducted_wallet_amount: walletCost,
    wallet_remaining: remaining,
  };

  supabaseAdmin
    .from('usage_log')
    .insert({
      user_id: userId,
      action_type: actionType,
      credits_cost: Math.ceil(walletCost),
      model_used: metadata?.model ?? metadata?.actualModel ?? null,
      metadata: usageMetadata,
    })
    .then(({ error }) => {
      if (error) console.warn('[AI Wallet] Usage log failed:', error.message);
    });

  console.info('[AI Wallet] Charged', {
    userId,
    provider: metadata?.provider ?? null,
    model: metadata?.actualModel ?? metadata?.model ?? null,
    inputTokens: metadata?.input_tokens ?? null,
    outputTokens: metadata?.output_tokens ?? null,
    imageCost: metadata?.image_cost ?? null,
    fileContextCost: metadata?.file_context_cost ?? null,
    estimatedRealUsdCost: usageMetadata.estimated_real_usd_cost,
    deductedWalletAmount: walletCost,
    walletRemaining: remaining,
  });

  void (async () => {
    try {
      if (walletRow.plan === 'free') return;

      const renewalDate = new Date(
        new Date(walletRow.billing_cycle_start).getTime() + 30 * 24 * 60 * 60 * 1000,
      ).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

      if (remaining === 0) {
        void fireResendEvent('user.credits_depleted', walletRow.email, walletRow.display_name, {
          first_name: walletRow.display_name,
          wallet_remaining: 0,
          plan_name: walletRow.plan,
          reset_date: renewalDate,
        });
      }

      const threshold = LOW_WALLET_THRESHOLDS[walletRow.plan as keyof typeof PLAN_CONFIG];
      if (threshold === undefined || remaining <= 0 || remaining > threshold) return;

      const { data: flagRow } = await supabaseAdmin
        .from('users')
        .select('low_credits_email_sent')
        .eq('id', userId)
        .single();

      if (flagRow?.low_credits_email_sent) return;
      await supabaseAdmin
        .from('users')
        .update({ low_credits_email_sent: true })
        .eq('id', userId);

      void fireResendEvent('user.low_credits', walletRow.email, walletRow.display_name, {
        first_name: walletRow.display_name,
        wallet_remaining: remaining,
        plan_name: walletRow.plan,
        renewal_date: renewalDate,
      });
    } catch (error) {
      console.warn('[AI Wallet] Email notification failed:', error);
    }
  })();

  return {
    success: true,
    // Old response aliases now carry AI Wallet USD while the SSE shape stays
    // compatible with existing frontend consumers.
    creditsUsed: walletCost,
    creditsRemaining: remaining,
    walletDeducted: walletCost,
    walletRemaining: remaining,
  };
}

export async function getCreditBalance(userId: string) {
  const { data: user } = await supabaseAdmin
    .from('users')
    .select('monthly_wallet_balance, extra_wallet_balance, wallet_spent, plan')
    .eq('id', userId)
    .single();

  if (!user) throw new Error('User not found');

  const remaining = Number(user.monthly_wallet_balance ?? 0) + Number(user.extra_wallet_balance ?? 0);
  return {
    used: Number(user.wallet_spent ?? 0),
    total: remaining,
    remaining,
    plan: user.plan,
  };
}

export async function canGenerateImages(userId: string, count: number = 1) {
  const { data: user } = await supabaseAdmin
    .from('users')
    .select('plan, images_generated')
    .eq('id', userId)
    .single();

  if (!user) throw new Error('User not found');

  const planConfig = PLAN_CONFIG[user.plan as keyof typeof PLAN_CONFIG];
  if (!planConfig || planConfig.images_max === 0) {
    return { allowed: false, reason: 'Plan does not support image generation' };
  }

  if (user.images_generated + count > planConfig.images_max) {
    return {
      allowed: false,
      reason: `Monthly image limit reached (${planConfig.images_max})`,
      current: user.images_generated,
      max: planConfig.images_max,
    };
  }

  return { allowed: true };
}

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
