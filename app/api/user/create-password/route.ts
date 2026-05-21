import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';
import { sendCreatePasswordEmail } from '@/lib/email';

export const dynamic = 'force-dynamic';

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

    const { data, error } = await supabaseAdmin.auth.admin.generateLink({
      type: 'recovery',
      email: user.email,
      options: {
        redirectTo: `${frontendUrl}/auth/callback`,
      },
    });

    if (error || !data?.properties?.action_link) {
      console.error('[create-password] generateLink error:', error);
      return NextResponse.json({ error: 'Failed to generate password setup link' }, { status: 500 });
    }

    const emailResult = await sendCreatePasswordEmail(user.email, user.display_name, data.properties.action_link);
    if (!emailResult.success) {
      console.error('[create-password] Email send failed:', emailResult.error);
      return NextResponse.json({ error: 'Failed to send password setup email' }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error('[create-password] Unexpected error:', err);
    return NextResponse.json({ error: 'Failed to send password setup email' }, { status: 500 });
  }
}
