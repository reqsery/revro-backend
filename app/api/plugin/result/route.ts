import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { getPluginApiKey, getUserIdByPluginApiKey } from '@/lib/plugin-auth';

export const dynamic = 'force-dynamic';

// ── Helpers ───────────────────────────────────────────────────────────────────

// ── POST /api/plugin/result ───────────────────────────────────────────────────
// Called by the plugin after it finishes executing a task.
// Body: { task_id: string, success: boolean, result?: any, error?: string }

export async function POST(request: NextRequest) {
  const apiKey = getPluginApiKey(request);
  if (!apiKey) {
    return NextResponse.json({ error: 'Missing API key' }, { status: 401 });
  }

  const userId = await getUserIdByPluginApiKey(apiKey);
  if (!userId) {
    return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
  }

  let body: { task_id?: string; success?: boolean; result?: unknown; error?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { task_id, success, result, error: taskError } = body;
  if (!task_id) {
    return NextResponse.json({ error: 'Missing task_id' }, { status: 400 });
  }

  const now = new Date().toISOString();
  const status = success ? 'done' : 'failed';

  const { data: updatedRows, error: dbErr } = await supabaseAdmin
    .from('plugin_tasks')
    .update({
      status,
      result:     result ?? null,
      error:      taskError ?? null,
      updated_at: now,
      completed_at: now,
    })
    .eq('id', task_id)
    .eq('user_id', userId) // safety: users can only update their own tasks
    .select('id');

  if (dbErr) {
    console.error('[Plugin/result] DB error:', dbErr.message);
    return NextResponse.json({ error: 'DB error' }, { status: 500 });
  }

  if (!updatedRows || updatedRows.length === 0) {
    console.warn('[Plugin/result] Task not found for result', { taskId: task_id, userId });
    return NextResponse.json({ error: 'Task not found' }, { status: 404 });
  }

  console.log(`[Plugin/result] task=${task_id} status=${status} user=${userId}`);
  return NextResponse.json({ ok: true });
}
