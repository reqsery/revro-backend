import { supabaseAdmin } from './supabase';
import { fireResendEvent } from './resend';

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

// Tokens per 1 credit, by model
export const TOKEN_RATES: Record<string, number> = {
  'claude-haiku-4-5':  2000,
  'claude-sonnet-4-5': 1000,
  'claude-sonnet-4-6':  800,
  'claude-opus-4-5':    600,
  'claude-opus-4-6':    500,
};

/**
 * Convert raw token count to exact decimal credits for a given plan model.
 * Returns a float rounded to 4 decimal places — e.g. 700 tokens on free plan = 0.7 credits.
 * No rounding up, no minimum — you pay exactly for what you use.
 */
export function tokensToCreditCost(planModel: string, totalTokens: number): number {
  const rate = TOKEN_RATES[planModel] ?? 1000;
  return Math.round((totalTokens / rate) * 10000) / 10000; // 4dp precision
}

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

// Credits remaining at which a low-credits warning is sent per plan.
const LOW_CREDIT_THRESHOLDS: Partial<Record<keyof typeof PLAN_CONFIG, number>> = {
  free:    5,
  starter: 20,
  pro:     50,
  studio:  150,
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
  return (user.credits_total - user.credits_used) >= cost;
}

/**
 * Deduct credits from user.
 *
 * Uses two separate queries so a missing optional column (e.g. low_credits_email_sent
 * if not yet added to the schema) never blocks the actual credit deduction.
 * Usage-log insert and email notifications are soft-fail — they never prevent the
 * primary credit update from succeeding.
 */
export async function deductCredits(
  userId: string,
  cost: number,
  actionType: string,
  metadata: any = {}
): Promise<{ success: boolean; creditsUsed: number; creditsRemaining: number }> {

  // ── 1. Read current balance (minimal columns only) ─────────────────────────
  const { data: creditRow, error: fetchErr } = await supabaseAdmin
    .from('users')
    .select('credits_used, credits_total')
    .eq('id', userId)
    .single();

  if (fetchErr || !creditRow) throw new Error('User not found');

  const available = creditRow.credits_total - creditRow.credits_used;
  if (available < cost) throw new Error('Insufficient credits');

  // Cap so credits_used never exceeds credits_total
  const newCreditsUsed = Math.min(creditRow.credits_used + cost, creditRow.credits_total);
  const remaining      = creditRow.credits_total - newCreditsUsed;

  // ── 2. Write new balance ───────────────────────────────────────────────────
  // Try with exact decimal first (works once credits_used column is NUMERIC).
  // Fall back to Math.ceil if Postgres rejects the decimal (INTEGER column still in use).
  let { error: updateErr } = await supabaseAdmin
    .from('users')
    .update({ credits_used: newCreditsUsed, updated_at: new Date().toISOString() })
    .eq('id', userId);

  if (updateErr?.message?.includes('invalid input syntax') || updateErr?.code === '22P02') {
    const rounded = Math.ceil(newCreditsUsed);
    const retry = await supabaseAdmin
      .from('users')
      .update({ credits_used: rounded, updated_at: new Date().toISOString() })
      .eq('id', userId);
    updateErr = retry.error;
  }

  if (updateErr) throw new Error(`Credits update failed: ${updateErr.message}`);

  // ── 3. Log usage (soft fail — wrong schema never blocks credits) ───────────
  supabaseAdmin
    .from('usage_log')
    .insert({ user_id: userId, action: actionType, credits_used: cost, metadata })
    .then(({ error }) => {
      if (error) console.warn('[Credits] Usage log failed:', error.message);
    });

  // ── 4. Email notifications (fully soft-fail — two independent queries) ──────
  //
  // Query A: basic columns (email, name, plan) — always exists, used for both emails
  // Query B: optional low_credits_email_sent — only used for the low-credits gate
  // This way emails fire even if the migration for low_credits_email_sent hasn't run yet.

  void (async () => {
    try {
      // Query A — columns that always exist
      const { data: baseRow } = await supabaseAdmin
        .from('users')
        .select('email, display_name, plan, billing_cycle_start')
        .eq('id', userId)
        .single();

      if (!baseRow) return;

      const renewalDate = new Date(
        new Date(baseRow.billing_cycle_start).getTime() + 30 * 24 * 60 * 60 * 1000
      ).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

      // ── Credits depleted ─────────────────────────────────────────────────
      if (remaining === 0) {
        void fireResendEvent('user.credits_depleted', baseRow.email, baseRow.display_name, {
          first_name:    baseRow.display_name,
          credits_total: creditRow.credits_total,
          plan_name:     baseRow.plan,
          reset_date:    renewalDate,
        });
      }

      // ── Low credits warning ──────────────────────────────────────────────
      const plan      = baseRow.plan as keyof typeof PLAN_CONFIG;
      const threshold = LOW_CREDIT_THRESHOLDS[plan];

      if (threshold !== undefined && remaining > 0 && remaining <= threshold) {
        // Query B — optional column (soft fail if migration not yet run)
        let alreadySent = false;
        try {
          const { data: flagRow } = await supabaseAdmin
            .from('users')
            .select('low_credits_email_sent')
            .eq('id', userId)
            .single();
          alreadySent = flagRow?.low_credits_email_sent ?? false;
        } catch {}

        if (!alreadySent) {
          // Best-effort update of the flag; ignore failure if column missing
          try {
            await supabaseAdmin
              .from('users')
              .update({ low_credits_email_sent: true })
              .eq('id', userId);
          } catch {}

          void fireResendEvent('user.low_credits', baseRow.email, baseRow.display_name, {
            first_name:       baseRow.display_name,
            credits_remaining: remaining,
            plan_name:        baseRow.plan,
            renewal_date:     renewalDate,
          });
        }
      }
    } catch (e) {
      console.warn('[Credits] Email notification failed:', e);
    }
  })();

  return { success: true, creditsUsed: newCreditsUsed, creditsRemaining: remaining };
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
    return { allowed: false, reason: 'Plan does not support image generation' };
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
