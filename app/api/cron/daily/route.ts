import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { fireResendEvent } from '@/lib/resend';
import { PLAN_CONFIG } from '@/lib/credits';

export const dynamic = 'force-dynamic';

function isAuthorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  return request.headers.get('authorization') === `Bearer ${secret}`;
}

function nextMonthlyCycleEnd(now: Date): string {
  const end = new Date(now);
  end.setUTCMonth(end.getUTCMonth() + 1);
  return end.toISOString();
}

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const now = new Date();
  const results = { deleted: 0, reset: 0, errors: [] as string[] };

  const { data: toDelete, error: fetchDeleteError } = await supabaseAdmin
    .from('users')
    .select('id, email, display_name')
    .not('deletion_date', 'is', null)
    .lte('deletion_date', now.toISOString());

  if (fetchDeleteError) {
    console.error('[Cron] Failed to fetch deletions:', fetchDeleteError);
    results.errors.push('fetch_deletions: ' + fetchDeleteError.message);
  } else {
    for (const user of toDelete ?? []) {
      try {
        void fireResendEvent('user.account_deleted', user.email, user.display_name, {
          first_name: user.display_name,
        });
        await supabaseAdmin.from('users').delete().eq('id', user.id);
        await supabaseAdmin.auth.admin.deleteUser(user.id);
        results.deleted++;
        console.log('[Cron] Deleted user', { userId: user.id });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[Cron] Failed to delete user', { userId: user.id, message });
        results.errors.push(`delete_${user.id}: ${message}`);
      }
    }
  }

  // Whop renewal webhooks are the primary reset path. This fallback prevents
  // included monthly wallet balance from stacking if a cycle end passes first.
  const { data: toReset, error: fetchResetError } = await supabaseAdmin
    .from('users')
    .select('id, email, display_name, plan, wallet_spent, monthly_wallet_balance, images_generated, billing_cycle_start')
    .lte('billing_cycle_end', now.toISOString())
    .is('deletion_date', null);

  if (fetchResetError) {
    console.error('[Cron] Failed to fetch wallet resets:', fetchResetError);
    results.errors.push('fetch_resets: ' + fetchResetError.message);
  } else {
    for (const user of toReset ?? []) {
      try {
        const config = PLAN_CONFIG[user.plan as keyof typeof PLAN_CONFIG];
        if (!config) {
          console.warn('[Cron] Skipped unknown plan wallet reset', { userId: user.id, plan: user.plan });
          continue;
        }

        const { data: logs } = await supabaseAdmin
          .from('usage_log')
          .select('action_type')
          .eq('user_id', user.id)
          .gte('created_at', user.billing_cycle_start);
        const entries = logs ?? [];

        void fireResendEvent('user.monthly_summary', user.email, user.display_name, {
          first_name: user.display_name,
          wallet_spent: user.wallet_spent,
          wallet_remaining: user.monthly_wallet_balance,
          scripts_count: entries.filter(log => log.action_type === 'script_generation' || log.action_type === 'roblox_generation').length,
          ui_count: entries.filter(log => log.action_type === 'ui_generation').length,
          images_count: user.images_generated,
          api_calls: entries.length,
          discord_count: entries.filter(log => log.action_type === 'discord_generation').length,
          reset_date: nextMonthlyCycleEnd(now),
        });

        const { error } = await supabaseAdmin.from('users').update({
          monthly_wallet_balance: config.wallet_monthly_usd,
          images_generated: 0,
          low_credits_email_sent: false,
          billing_cycle_start: now.toISOString(),
          billing_cycle_end: nextMonthlyCycleEnd(now),
          updated_at: now.toISOString(),
        }).eq('id', user.id);
        if (error) throw error;

        results.reset++;
        console.log('[Cron] Reset included wallet', { userId: user.id, plan: user.plan });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[Cron] Failed to reset wallet', { userId: user.id, message });
        results.errors.push(`reset_${user.id}: ${message}`);
      }
    }
  }

  console.log('[Cron] Daily run complete:', results);
  return NextResponse.json({ ok: true, ...results });
}
