import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { sendWelcomeEmail } from '@/lib/email';
import { fireResendEvent } from '@/lib/resend';
import crypto from 'crypto';

export const dynamic = 'force-dynamic';

// Generate secure random API key
function generateApiKey(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let apiKey = '';
  const randomBytes = crypto.randomBytes(32);
  
  for (let i = 0; i < 32; i++) {
    apiKey += chars[randomBytes[i] % chars.length];
  }
  
  return apiKey;
}

export async function POST(request: NextRequest) {
  try {
    const { email, password, displayName } = await request.json();

    // Validation
    if (!email || !password) {
      return NextResponse.json(
        { error: 'Email and password are required' },
        { status: 400 }
      );
    }

    if (password.length < 8) {
      return NextResponse.json(
        { error: 'Password must be at least 8 characters' },
        { status: 400 }
      );
    }

    // Create user with Supabase Auth
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: false // Set to true to skip email verification for now
    });

    if (authError) {
      console.error('Signup error:', authError);
      return NextResponse.json(
        { error: authError.message },
        { status: 400 }
      );
    }

    const userId = authData.user.id;

    // Generate API key
    const apiKey = generateApiKey();

    // Create user record in users table
    const { error: dbError } = await supabaseAdmin
      .from('users')
      .insert({
        id: userId,
        email,
        display_name: displayName || email.split('@')[0],
        plan: 'free',
        credits_total: 25,
        credits_used: 0,
        images_generated: 0,
        billing_cycle_start: new Date().toISOString()
      });

    if (dbError) {
      console.error('DB insert error:', dbError);
      // Rollback auth user creation
      await supabaseAdmin.auth.admin.deleteUser(userId);
      return NextResponse.json(
        { error: 'Failed to create user profile' },
        { status: 500 }
      );
    }

    // Create API key record
    const { error: apiKeyError } = await supabaseAdmin
      .from('api_keys')
      .insert({
        user_id: userId,
        key: apiKey,
        name: 'Default API Key'
      });

    if (apiKeyError) {
      console.error('API key creation error:', apiKeyError);
      // Rollback user creation
      await supabaseAdmin.from('users').delete().eq('id', userId);
      await supabaseAdmin.auth.admin.deleteUser(userId);
      return NextResponse.json(
        { error: 'Failed to create API key' },
        { status: 500 }
      );
    }

    // Fire Resend events and welcome email — fire-and-forget, never block signup
const userName = displayName || email.split('@')[0];

void fireResendEvent('user.signed_up', email, userName, {
  first_name: userName,
});

console.log('About to send welcome email to:', email);
sendWelcomeEmail(email, userName, apiKey)
  .then(result => console.log('Email send result:', result))
  .catch(error => console.error('Failed to send welcome email:', error));

return NextResponse.json({
  message: 'Account created successfully',
  user: {
    id: userId,
    email: authData.user.email,
    displayName: userName
  },
  apiKey: apiKey
}, { status: 201 });

  } catch (error) {
    console.error('Signup error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
