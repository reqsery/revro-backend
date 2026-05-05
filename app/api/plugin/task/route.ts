import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { requireAuth } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const VALID_TASK_TYPES = [
  'INSERT_SCRIPT',
  'CREATE_UI',
  'INSERT_INSTANCE',
  'READ_EXPLORER',
  'START_PLAYTEST',
  'AUTO_PLAYTEST',
  'UPLOAD_IMAGE',
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

  const { task_type, data } = body;

  if (!task_type || !(VALID_TASK_TYPES as readonly string[]).includes(task_type)) {
    return NextResponse.json(
      { error: `Invalid task_type. Valid types: ${VALID_TASK_TYPES.join(', ')}` },
      { status: 400 },
    );
  }

  // Verify user has an active plugin connection
  const { data: connection } = await supabaseAdmin
    .from('roblox_connections')
    .select('session_id')
    .eq('user_id', user.id)
    .eq('is_active', true)
    .single();

  if (!connection) {
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
    return NextResponse.json({ error: 'Failed to queue task' }, { status: 500 });
  }

  console.log(`[Plugin/task] queued ${task_type} id=${newTask.id} user=${user.id}`);
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

  const { data: task, error: dbErr } = await supabaseAdmin
    .from('plugin_tasks')
    .select('id, task_type, status, result, error, created_at, updated_at, completed_at')
    .eq('id', taskId)
    .eq('user_id', user.id) // safety: users can only read their own tasks
    .single();

  if (dbErr || !task) {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 });
  }

  return NextResponse.json({ task });
}
