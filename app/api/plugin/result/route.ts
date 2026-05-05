import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getUserByApiKey(apiKey: string) {
  const { data, error } = await supabaseAdmin
    .from('api_keys')
    .select('user_id')
    .eq('key', apiKey)
    .single();
  if (error || !data) return null;
  return data.user_id as string;
}

// ── POST /api/plugin/result ───────────────────────────────────────────────────
// Called by the plugin after it finishes executing a task.
// Body: { task_id: string, success: boolean, result?: any, error?: string }

export async function POST(request: NextRequest) {
  const apiKey = request.headers.get('x-api-key') ?? '';
  if (!apiKey) {
    return NextResponse.json({ error: 'Missing x-api-key header' }, { status: 401 });
  }

  const userId = await getUserByApiKey(apiKey);
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

  const { error: dbErr } = await supabaseAdmin
    .from('plugin_tasks')
    .update({
      status,
      result:     result ?? null,
      error:      taskError ?? null,
      updated_at: now,
      completed_at: now,
    })
    .eq('id', task_id)
    .eq('user_id', userId); // safety: users can only update their own tasks

  if (dbErr) {
    console.error('[Plugin/result] DB error:', dbErr.message);
    return NextResponse.json({ error: 'DB error' }, { status: 500 });
  }

  console.log(`[Plugin/result] task=${task_id} status=${status} user=${userId}`);
  return NextResponse.json({ ok: true });
}
