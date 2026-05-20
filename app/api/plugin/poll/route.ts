import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { getPluginApiKey, getUserIdByPluginApiKey } from '@/lib/plugin-auth';

export const dynamic = 'force-dynamic';

// ── Helpers ───────────────────────────────────────────────────────────────────

// ── GET /api/plugin/poll ──────────────────────────────────────────────────────
// Polled by the Roblox Studio plugin every ~2 seconds.
// Returns the next pending task (or {task: null} if the queue is empty).
// Also refreshes the connection's last_seen_at timestamp.

export async function GET(request: NextRequest) {
  const apiKey = getPluginApiKey(request);
  if (!apiKey) {
    return NextResponse.json({ error: 'Missing API key' }, { status: 401 });
  }

  const userId = await getUserIdByPluginApiKey(apiKey);
  if (!userId) {
    return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
  }

  const now = new Date().toISOString();

  // Touch last_seen_at so the backend knows the plugin is alive
  await supabaseAdmin
    .from('roblox_connections')
    .update({ last_seen_at: now })
    .eq('user_id', userId)
    .eq('is_active', true);

  // Grab the oldest pending task for this user
  const { data: tasks, error } = await supabaseAdmin
    .from('plugin_tasks')
    .select('id, task_type, data')
    .eq('user_id', userId)
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1);

  if (error) {
    console.error('[Plugin/poll] DB error:', error.message);
    return NextResponse.json({ error: 'DB error' }, { status: 500 });
  }

  if (!tasks || tasks.length === 0) {
    return NextResponse.json({ task: null });
  }

  const task = tasks[0];

  // Mark as in-progress so we don't hand the same task to multiple polls
  await supabaseAdmin
    .from('plugin_tasks')
    .update({ status: 'running', updated_at: now })
    .eq('id', task.id);

  return NextResponse.json({
    task: {
      id:        task.id,
      task_type: task.task_type,
      data:      task.data,
    },
  });
}
