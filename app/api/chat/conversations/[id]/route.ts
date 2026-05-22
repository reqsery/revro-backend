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

    return NextResponse.json(
      { conversation: conv, messages: messages ?? [] },
      { headers: { 'Cache-Control': 'no-store' } }
    );

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
    console.info('[Conversations delete] Requested', { conversationId: id, userId: user.id });

    const { data: conv, error: convErr } = await supabaseAdmin
      .from('conversations')
      .select('id')
      .eq('id', id)
      .eq('user_id', user.id)
      .single();

    if (convErr || !conv) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    }

    // messages has an ON DELETE CASCADE foreign key. Delete the owned parent
    // row and verify the database actually removed it before reporting success.
    const { data: deleted, error } = await supabaseAdmin
      .from('conversations')
      .delete()
      .eq('id', id)
      .eq('user_id', user.id)
      .select('id');

    if (error) throw error;
    if (!deleted?.length) {
      console.warn('[Conversations delete] Row count', {
        conversationId: id,
        userId: user.id,
        deletedRowCount: 0,
      });
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    }

    console.info('[Conversations delete] Row count', {
      conversationId: id,
      userId: user.id,
      deletedRowCount: deleted.length,
    });

    return NextResponse.json({ success: true, deleted_count: deleted.length });
  } catch (err: any) {
    console.error('[Conversations delete] Failed:', err?.message ?? 'Unknown error');
    return NextResponse.json({ error: 'Failed to delete conversation' }, { status: 500 });
  }
}
