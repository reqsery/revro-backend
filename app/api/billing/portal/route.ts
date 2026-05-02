import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { requireAuth } from '@/lib/auth';

export const dynamic = 'force-dynamic';

// ── Helpers ───────────────────────────────────────────────────────────────────

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY is not configured');
  return new Stripe(key, { apiVersion: '2026-04-22.dahlia' });
}

// ── Route ─────────────────────────────────────────────────────────────────────
//
// Supports two billing providers:
//
//   Whop  — if WHOP_WEBHOOK_SECRET is set, returns the Whop customer hub URL.
//           Users manage their subscriptions at https://whop.com/hub
//
//   Stripe — if STRIPE_SECRET_KEY is set, generates a Stripe Billing Portal
//            session and returns the URL.
//
// Whop takes priority since it's the active provider.

export async function POST(request: NextRequest) {
  const user = await requireAuth(request);
  if (user instanceof NextResponse) return user;

  // ── Whop ──────────────────────────────────────────────────────────────────
  if (process.env.WHOP_WEBHOOK_SECRET) {
    // Whop customer portal is a static URL — users log in with their Whop account
    return NextResponse.json({ url: 'https://whop.com/hub' });
  }

  // ── Stripe ────────────────────────────────────────────────────────────────
  if (process.env.STRIPE_SECRET_KEY) {
    try {
      const stripe = getStripe();

      const customers = await stripe.customers.list({ email: user.email, limit: 1 });
      if (!customers.data.length) {
        return NextResponse.json(
          { error: 'No billing account found. Subscribe to a plan first.' },
          { status: 404 }
        );
      }

      const session = await stripe.billingPortal.sessions.create({
        customer: customers.data[0].id,
        return_url: 'https://revro.dev/dashboard/settings?tab=billing',
      });

      return NextResponse.json({ url: session.url });
    } catch (err: any) {
      console.error('[Billing portal] Stripe error:', err.message);
      return NextResponse.json({ error: err.message || 'Failed to open billing portal' }, { status: 500 });
    }
  }

  return NextResponse.json(
    { error: 'No billing provider configured (set WHOP_WEBHOOK_SECRET or STRIPE_SECRET_KEY)' },
    { status: 500 }
  );
}
