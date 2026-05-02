import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { requireAuth } from '@/lib/auth';

export const dynamic = 'force-dynamic';

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY is not configured');
  return new Stripe(key, { apiVersion: '2026-04-22.dahlia' });
}

export async function POST(request: NextRequest) {
  const user = await requireAuth(request);
  if (user instanceof NextResponse) return user;

  try {
    const stripe = getStripe();

    // Find Stripe customer by email
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
    console.error('[Billing portal] Error:', err.message);
    return NextResponse.json({ error: err.message || 'Failed to open billing portal' }, { status: 500 });
  }
}
