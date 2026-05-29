import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { requireAuth } from '@/lib/auth';
import { getLivePluginConnection } from '@/lib/plugin-connection';

export const dynamic = 'force-dynamic';
const RUNNING_TASK_TIMEOUT_MS = 20_000;

const VALID_TASK_TYPES = [
  'INSERT_SCRIPT',
  'CREATE_UI',
  'INSERT_INSTANCE',
  'CREATE_FOLDER',
  'CREATE_REMOTE_EVENT',
  'CREATE_MODULE_SCRIPT',
  'APPLY_PROPERTIES',
  'READ_EXPLORER',
  'START_PLAYTEST',
  'STOP_PLAYTEST',
  'READ_OUTPUT',
  'AUTO_PLAYTEST',
  'APPLY_IMAGE',
] as const;

// ── POST /api/plugin/task ─────────────────────────────────────────────────────
// Called by the Revro frontend/AI to queue a task for the Roblox Studio plugin.
// The plugin will pick it up on its next poll (/api/plugin/poll).
//
// Body: { task_type: string, data?: object }
// Response: { task_id: string, message: string }

export async function POST(request: NextRequest) {
  const user = await requireAuth(request);
  if (user instanceof NextResponse) return user;

  let body: { task_type?: string; data?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  let { task_type, data } = body;

  if (!task_type || !(VALID_TASK_TYPES as readonly string[]).includes(task_type)) {
    return NextResponse.json(
      { error: `Invalid task_type. Valid types: ${VALID_TASK_TYPES.join(', ')}` },
      { status: 400 },
    );
  }

  if (task_type === 'CREATE_MODULE_SCRIPT') {
    const normalizedData = data && typeof data === 'object' && !Array.isArray(data)
      ? { ...(data as Record<string, unknown>), script_type: 'ModuleScript' }
      : { script_type: 'ModuleScript' };
    task_type = 'INSERT_SCRIPT';
    data = normalizedData;
  }

  const connection = await getLivePluginConnection(user.id, 'task_route');

  if (!connection) {
    console.warn('[Plugin/task] Rejected without live connection', {
      userId: user.id,
      taskType: task_type,
    });
    return NextResponse.json(
      { error: 'No active Roblox Studio connection. Please open the Revro plugin in Studio.' },
      { status: 400 },
    );
  }

  const now = new Date().toISOString();
  const { data: newTask, error: dbErr } = await supabaseAdmin
    .from('plugin_tasks')
    .insert({
      user_id:    user.id,
      session_id: connection.session_id,
      task_type,
      data:       data ?? {},
      status:     'pending',
      created_at: now,
      updated_at: now,
    })
    .select('id')
    .single();

  if (dbErr || !newTask) {
    console.error('[Plugin/task] DB insert error:', dbErr?.message);
    return NextResponse.json({ error: dbErr?.message || 'Failed to queue task' }, { status: 500 });
  }

  console.info('[Plugin/task] Queued', {
    taskType: task_type,
    taskId: newTask.id,
    userId: user.id,
    sessionId: connection.session_id,
  });
  return NextResponse.json({
    task_id: newTask.id,
    message: 'Task queued — the Revro plugin will execute it shortly.',
  });
}

// ── GET /api/plugin/task ──────────────────────────────────────────────────────
// Poll task status from the frontend.
// Query param: ?task_id=<uuid>

export async function GET(request: NextRequest) {
  const user = await requireAuth(request);
  if (user instanceof NextResponse) return user;

  const taskId = request.nextUrl.searchParams.get('task_id');
  if (!taskId) {
    return NextResponse.json({ error: 'Missing task_id query param' }, { status: 400 });
  }

  let { data: task, error: dbErr } = await supabaseAdmin
    .from('plugin_tasks')
    .select('id, task_type, status, result, error, created_at, updated_at, completed_at')
    .eq('id', taskId)
    .eq('user_id', user.id) // safety: users can only read their own tasks
    .single();

  if (dbErr || !task) {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 });
  }

  if (task.status === 'running') {
    const updatedAt = task.updated_at ? new Date(task.updated_at).getTime() : 0;
    const stale = !Number.isFinite(updatedAt) || Date.now() - updatedAt > RUNNING_TASK_TIMEOUT_MS;
    if (stale) {
      const now = new Date().toISOString();
      const message = 'Roblox Studio did not report a result for this task. Retry Insert after checking the plugin.';
      const { data: failedTask, error: failErr } = await supabaseAdmin
        .from('plugin_tasks')
        .update({
          status: 'failed',
          error: message,
          updated_at: now,
          completed_at: now,
        })
        .eq('id', taskId)
        .eq('user_id', user.id)
        .eq('status', 'running')
        .select('id, task_type, status, result, error, created_at, updated_at, completed_at')
        .single();

      if (!failErr && failedTask) {
        console.warn('[Plugin/task] Marked stale running task failed', {
          taskId,
          userId: user.id,
          taskType: task.task_type,
        });
        task = failedTask;
      }
    }
  }

  return NextResponse.json({ task });
}
