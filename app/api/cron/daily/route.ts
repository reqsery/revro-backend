import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { fireResendEvent } from '@/lib/resend';

export const dynamic = 'force-dynamic';

// Vercel automatically sends Authorization: Bearer <CRON_SECRET> for cron routes
function isAuthorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // No secret configured — allow (useful in dev)
  return request.headers.get('authorization') === `Bearer ${secret}`;
}

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const now = new Date();
  const results = { deleted: 0, reset: 0, errors: [] as string[] };

  // ── 1. Permanently delete users whose deletion_date has passed ────────────

  const { data: toDelete, error: fetchDeleteError } = await supabaseAdmin
    .from('users')
    .select('id, email, display_name')
    .not('deletion_date', 'is', null)
    .lte('deletion_date', now.toISOString());

  if (fetchDeleteError) {
    console.error('[Cron] Failed to fetch deletions:', fetchDeleteError);
    results.errors.push('fetch_deletions: ' + fetchDeleteError.message);
  } else {
    for (const user of (toDelete ?? [])) {
      try {
        // Fire event before deletion so Resend still has the contact
        void fireResendEvent('user.account_deleted', user.email, user.display_name, {
          first_name: user.display_name,
        });

        await supabaseAdmin.from('users').delete().eq('id', user.id);
        await supabaseAdmin.auth.admin.deleteUser(user.id);

        results.deleted++;
        console.log(`[Cron] Deleted ${user.email}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[Cron] Failed to delete ${user.email}:`, msg);
        results.errors.push(`delete_${user.id}: ${msg}`);
      }
    }
  }

  // ── 2. Reset credits for users whose 30-day billing cycle has expired ─────

  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const { data: toReset, error: fetchResetError } = await supabaseAdmin
    .from('users')
    .select('id, email, display_name, plan, credits_used, credits_total, images_generated, billing_cycle_start')
    .lte('billing_cycle_start', thirtyDaysAgo.toISOString())
    .is('deletion_date', null); // Skip users pending deletion

  if (fetchResetError) {
    console.error('[Cron] Failed to fetch credit resets:', fetchResetError);
    results.errors.push('fetch_resets: ' + fetchResetError.message);
  } else {
    for (const user of (toReset ?? [])) {
      try {
        const cycleStart = user.billing_cycle_start;
        const monthName = new Date(cycleStart).toLocaleDateString('en-US', {
          month: 'long', year: 'numeric',
        });
        const nextResetDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)
          .toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

        // Fetch usage stats for the closing cycle
        const { data: logs } = await supabaseAdmin
          .from('usage_log')
          .select('action')
          .eq('user_id', user.id)
          .gte('created_at', cycleStart);

        const entries = logs ?? [];
        const scriptsCount = entries.filter(l => l.action === 'script_generation' || l.action === 'roblox_generation').length;
        const uiCount     = entries.filter(l => l.action === 'ui_generation').length;
        const discordCount = entries.filter(l => l.action === 'discord_generation').length;

        void fireResendEvent('user.monthly_summary', user.email, user.display_name, {
          first_name:    user.display_name,
          month:         monthName,
          credits_used:  user.credits_used,
          credits_total: user.credits_total,
          scripts_count: scriptsCount,
          ui_count:      uiCount,
          images_count:  user.images_generated,
          api_calls:     entries.length,
          discord_count: discordCount,
          reset_date:    nextResetDate,
        });

        await supabaseAdmin
          .from('users')
          .update({
            credits_used:           0,
            images_generated:       0,
            low_credits_email_sent: false,
            billing_cycle_start:    now.toISOString(),
            updated_at:             now.toISOString(),
          })
          .eq('id', user.id);

        results.reset++;
        console.log(`[Cron] Reset credits for ${user.email}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[Cron] Failed to reset credits for ${user.email}:`, msg);
        results.errors.push(`reset_${user.id}: ${msg}`);
      }
    }
  }

  console.log('[Cron] Daily run complete:', results);
  return NextResponse.json({ ok: true, ...results });
}
