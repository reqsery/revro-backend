import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { sendWelcomeEmail } from '@/lib/email';
import { fireResendEvent } from '@/lib/resend';
import crypto from 'crypto';

function generateApiKey(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let key = '';
  const bytes = crypto.randomBytes(32);
  for (let i = 0; i < 32; i++) key += chars[bytes[i] % chars.length];
  return key;
}

export async function getUser(request: NextRequest) {
  try {
    const authHeader = request.headers.get('authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) return null;

    const token = authHeader.substring(7);
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !user) return null;

    // Try to load existing DB record
    const { data: userData } = await supabaseAdmin
      .from('users')
      .select('*')
      .eq('id', user.id)
      .single();

    if (userData) {
      // If the user had deletion scheduled but they've logged back in with a valid
      // session, treat that as implicit cancellation — clear the deletion flags and
      // let them through normally. The explicit "Cancel Deletion" button in settings
      // still exists for users who want the cancellation confirmation email.
      if (userData.deletion_scheduled_at) {
        await supabaseAdmin
          .from('users')
          .update({ deletion_scheduled_at: null, deletion_date: null, updated_at: new Date().toISOString() })
          .eq('id', user.id)
          .catch(() => {});
        return { ...userData, deletion_scheduled_at: null, deletion_date: null };
      }
      return userData;
    }

    // ── Auto-provision new user on first login ────────────────────────────
    // Safety check: only provision accounts that are genuinely new (< 15 min old).
    // If the auth account is older than 15 min with no DB row, the user was likely
    // deleted directly from the database — don't silently recreate their account.
    const accountAgeMs = Date.now() - new Date(user.created_at ?? 0).getTime()
    if (accountAgeMs > 15 * 60 * 1000) {
      console.warn(`[Auth] Refusing to re-provision ${user.email} — auth account is ${Math.round(accountAgeMs / 60000)}min old but has no DB record. Likely a deleted user.`)
      // Fully revoke their auth session so they're truly signed out
      await supabaseAdmin.auth.admin.signOut(user.id, 'global').catch(() => {})
      return null
    }

    // Covers both OAuth (Google) and email/password users that signed up
    // directly via the Supabase client SDK without hitting /api/auth/signup.
    const email       = user.email ?? ''
    const displayName =
      user.user_metadata?.full_name ??
      user.user_metadata?.name ??
      user.user_metadata?.display_name ??
      email.split('@')[0]
    const apiKey      = generateApiKey()

    const { error: insertErr } = await supabaseAdmin.from('users').insert({
      id: user.id,
      email,
      display_name: displayName,
      plan: 'free',
      credits_total: 25,
      credits_used: 0,
      images_generated: 0,
      billing_cycle_start: new Date().toISOString(),
    })

    if (insertErr) {
      console.error('[Auth] Failed to auto-provision user:', insertErr)
      return null
    }

    const { error: apiKeyErr } = await supabaseAdmin
      .from('api_keys')
      .insert({ user_id: user.id, key: apiKey, name: 'Default API Key' })
    if (apiKeyErr) console.error('[Auth] API key insert failed:', apiKeyErr)

    // Fire welcome email + Resend event — never block the request
    void sendWelcomeEmail(email, displayName, apiKey)
    void fireResendEvent('user.signed_up', email, displayName, { first_name: displayName })

    console.log(`[Auth] Auto-provisioned OAuth user: ${email}`)

    const { data: newUser } = await supabaseAdmin
      .from('users').select('*').eq('id', user.id).single()

    return newUser;
  } catch (error) {
    console.error('Auth error:', error);
    return null;
  }
}

export async function requireAuth(request: NextRequest) {
  const user = await getUser(request);

  if (!user) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401 }
    );
  }

  return user;
}

