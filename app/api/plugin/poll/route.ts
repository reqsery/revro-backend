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

  const { data: activeConnections, error: activeConnectionError } = await supabaseAdmin
    .from('roblox_connections')
    .select('session_id')
    .eq('user_id', userId)
    .eq('is_active', true)
    .order('last_seen_at', { ascending: false })
    .limit(1);

  const activeSessionId = activeConnections?.[0]?.session_id;
  if (activeConnectionError || !activeSessionId) {
    console.error('[Plugin/poll] Active session lookup failed', {
      userId,
      message: activeConnectionError?.message ?? 'No active session row returned',
    });
    return NextResponse.json({ error: 'No active plugin session' }, { status: 409 });
  }

  // Touch last_seen_at so the backend knows the plugin is alive. PostgREST
  // rejects order/limit modifiers on this PATCH, so update the selected session.
  const { error: heartbeatError } = await supabaseAdmin
    .from('roblox_connections')
    .update({ last_seen_at: now, updated_at: now })
    .eq('user_id', userId)
    .eq('session_id', activeSessionId)
    .eq('is_active', true)

  if (heartbeatError) {
    console.error('[Plugin/poll] Heartbeat failed', {
      userId,
      message: heartbeatError.message,
    });
    return NextResponse.json({ error: 'Failed to update plugin heartbeat' }, { status: 500 });
  }
  console.info('[Plugin/poll] Heartbeat updated', { userId, sessionId: activeSessionId });

  // Grab the oldest pending task for this live Studio session.
  const { data: tasks, error } = await supabaseAdmin
    .from('plugin_tasks')
    .select('id, task_type, data')
    .eq('user_id', userId)
    .eq('session_id', activeSessionId)
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

  console.info('[Plugin/poll] Returning task', {
    userId,
    sessionId: activeSessionId,
    taskId: task.id,
    taskType: task.task_type,
  });

  return NextResponse.json({
    task: {
      id:        task.id,
      task_type: task.task_type,
      data:      task.data,
    },
  });
}
