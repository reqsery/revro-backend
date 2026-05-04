import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

/** GET /api/chat/conversations/[id] — fetch messages for a conversation */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await requireAuth(request);
  if (user instanceof NextResponse) return user;

  const { id } = await params;

  try {
    // Verify the conversation belongs to this user
    const { data: conv, error: convErr } = await supabaseAdmin
      .from('conversations')
      .select('id, title, type')
      .eq('id', id)
      .eq('user_id', user.id)
      .single();

    if (convErr || !conv) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    }

    const { data: messages, error: msgErr } = await supabaseAdmin
      .from('messages')
      .select('id, role, content, created_at')
      .eq('conversation_id', id)
      .order('created_at', { ascending: true });

    if (msgErr) throw msgErr;

    return NextResponse.json({ conversation: conv, messages: messages ?? [] });

  } catch (err: any) {
    console.error('[Conversations] Error fetching messages:', err.message);
    return NextResponse.json({ error: 'Failed to fetch messages' }, { status: 500 });
  }
}

/** DELETE /api/chat/conversations/[id] — delete a conversation */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await requireAuth(request);
  if (user instanceof NextResponse) return user;

  const { id } = await params;

  try {
    const { error } = await supabaseAdmin
      .from('conversations')
      .delete()
      .eq('id', id)
      .eq('user_id', user.id);

    if (error) throw error;

    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ error: 'Failed to delete conversation' }, { status: 500 });
  }
}
