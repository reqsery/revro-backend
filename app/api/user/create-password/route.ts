import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';
import { sendCreatePasswordEmail } from '@/lib/email';

export const dynamic = 'force-dynamic';
const PASSWORD_EMAIL_TIMEOUT_MS = 12_000;

function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), PASSWORD_EMAIL_TIMEOUT_MS)),
  ]);
}

/**
 * POST /api/user/create-password
 * Generates a Supabase password-recovery link and sends it via Resend
 * with a custom "Set up your password" email (for OAuth-only users).
 */
export async function POST(request: NextRequest) {
  const user = await requireAuth(request);
  if (user instanceof NextResponse) return user;

  try {
    const frontendUrl = process.env.NEXT_PUBLIC_FRONTEND_URL ?? 'https://revro.dev';

    const { data, error } = await withTimeout(supabaseAdmin.auth.admin.generateLink({
      type: 'recovery',
      email: user.email,
      options: {
        redirectTo: `${frontendUrl}/auth/callback?flow=recovery`,
      },
    }), 'Password link generation timed out');

    if (error || !data?.properties?.action_link) {
      console.error('[create-password] generateLink error:', error);
      return NextResponse.json({ error: 'Failed to generate password setup link' }, { status: 500 });
    }

    const emailResult = await withTimeout(
      sendCreatePasswordEmail(user.email, user.display_name, data.properties.action_link),
      'Password setup email timed out',
    );
    if (!emailResult.success) {
      console.error('[create-password] Email send failed:', emailResult.error);
      return NextResponse.json({ error: 'Failed to send password setup email' }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error('[create-password] Unexpected error:', err);
    const timedOut = typeof err?.message === 'string' && err.message.includes('timed out');
    return NextResponse.json(
      { error: timedOut ? err.message : 'Failed to send password setup email' },
      { status: timedOut ? 504 : 500 },
    );
  }
}
