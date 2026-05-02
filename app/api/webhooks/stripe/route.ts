import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
// Import the full Stripe namespace from the core module so sub-types like
// Stripe.Customer, Stripe.Subscription, etc. are accessible.
import type { Stripe as StripeTypes } from 'stripe/cjs/stripe.core';
import { supabaseAdmin } from '@/lib/supabase';
import { PLAN_CONFIG } from '@/lib/credits';

export const dynamic = 'force-dynamic';

// ── Stripe client ─────────────────────────────────────────────────────────────

type StripeInstance = InstanceType<typeof Stripe>;

// Initialised lazily so the module doesn't crash at import time if the key
// isn't set (e.g. when LemonSqueezy is used instead).
function getStripe(): StripeInstance {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY is not configured');
  return new Stripe(key, { apiVersion: '2026-04-22.dahlia' });
}

// ── Types ─────────────────────────────────────────────────────────────────────

type PlanKey = keyof typeof PLAN_CONFIG;

// ── Plan mapping ──────────────────────────────────────────────────────────────
//
// Stripe identifies plans by Price ID (e.g. price_abc123).
// Map your Price IDs to internal plan keys via environment variables so nothing
// is hard-coded here.
//
// Required env vars (add to .env.local and Vercel):
//   STRIPE_PRICE_STARTER   – Price ID for the Starter plan
//   STRIPE_PRICE_PRO       – Price ID for the Pro plan
//   STRIPE_PRICE_STUDIO    – Price ID for the Studio plan
//
// One price per plan is enough for monthly billing. If you offer annual prices
// as well, add STRIPE_PRICE_STARTER_ANNUAL etc. and extend the map below.

function buildPriceMap(): Record<string, PlanKey> {
  const map: Record<string, PlanKey> = {};

  const pairs: [string, PlanKey][] = [
    ['STRIPE_PRICE_STARTER',        'starter'],
    ['STRIPE_PRICE_STARTER_ANNUAL', 'starter'],
    ['STRIPE_PRICE_PRO',            'pro'],
    ['STRIPE_PRICE_PRO_ANNUAL',     'pro'],
    ['STRIPE_PRICE_STUDIO',         'studio'],
    ['STRIPE_PRICE_STUDIO_ANNUAL',  'studio'],
  ];

  for (const [envKey, plan] of pairs) {
    const priceId = process.env[envKey];
    if (priceId) map[priceId] = plan;
  }

  return map;
}

function planFromPriceId(priceId: string): PlanKey | null {
  return buildPriceMap()[priceId] ?? null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function findUser(email: string) {
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('id, email, plan, credits_used, credits_total')
    .eq('email', email.toLowerCase())
    .single();

  if (error || !data) return null;
  return data;
}

async function applyPlan(
  userId: string,
  plan: PlanKey,
  resetCycle: boolean,
): Promise<void> {
  const config = PLAN_CONFIG[plan];

  const patch: Record<string, unknown> = {
    plan,
    credits_total: config.credits,
    updated_at:   new Date().toISOString(),
  };

  if (resetCycle) {
    patch.credits_used        = 0;
    patch.images_generated    = 0;
    patch.billing_cycle_start = new Date().toISOString();
  }

  const { error } = await supabaseAdmin
    .from('users')
    .update(patch)
    .eq('id', userId);

  if (error) throw new Error(`DB update failed: ${error.message}`);
}

async function downgradeToFree(userId: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from('users')
    .update({
      plan:                 'free',
      credits_total:        PLAN_CONFIG.free.credits,
      credits_used:         0,
      images_generated:     0,
      billing_cycle_start:  new Date().toISOString(),
      updated_at:           new Date().toISOString(),
    })
    .eq('id', userId);

  if (error) throw new Error(`DB update failed: ${error.message}`);
}

// Resolve a customer email from a Stripe customer ID or object.
async function resolveEmail(
  stripe: StripeInstance,
  customer: string | StripeTypes.Customer | StripeTypes.DeletedCustomer | null,
): Promise<string | null> {
  if (!customer) return null;

  // Already expanded
  if (typeof customer === 'object' && 'email' in customer) {
    return (customer as StripeTypes.Customer).email?.toLowerCase() ?? null;
  }

  // Fetch by ID
  try {
    const c = await stripe.customers.retrieve(customer as string);
    if (c.deleted) return null;
    return (c as StripeTypes.Customer).email?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET ?? '';

  if (!webhookSecret) {
    console.error('[Stripe] STRIPE_WEBHOOK_SECRET is not set');
    return NextResponse.json({ error: 'Webhook secret not configured' }, { status: 500 });
  }

  // Read raw body — required for Stripe signature verification
  const rawBody = await request.text();
  const signature = request.headers.get('stripe-signature') ?? '';

  let stripe: StripeInstance;
  let event: StripeTypes.Event;

  try {
    stripe = getStripe();
    // constructEvent throws if the signature is invalid
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret) as StripeTypes.Event;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[Stripe] Signature verification failed: ${message}`);
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  console.log(`[Stripe] ${event.type} | id: ${event.id}`);

  try {
    switch (event.type) {

      // ── Subscription created ───────────────────────────────────────────
      case 'customer.subscription.created': {
        const sub = event.data.object as StripeTypes.Subscription;
        const priceId = sub.items.data[0]?.price?.id ?? '';
        const plan    = planFromPriceId(priceId);

        if (!plan) {
          console.warn(`[Stripe] Unknown price ID "${priceId}" — skipping`);
          break;
        }

        const email = await resolveEmail(stripe, sub.customer);
        if (!email) { console.error('[Stripe] Could not resolve customer email'); break; }

        const user = await findUser(email);
        if (!user) { console.error(`[Stripe] User not found: ${email}`); break; }

        await applyPlan(user.id, plan, true);
        console.log(`[Stripe] subscription.created: ${email} → ${plan}`);
        break;
      }

      // ── Subscription updated (upgrade / downgrade) ─────────────────────
      case 'customer.subscription.updated': {
        const sub     = event.data.object as StripeTypes.Subscription;
        const priceId = sub.items.data[0]?.price?.id ?? '';
        const plan    = planFromPriceId(priceId);

        if (!plan) {
          console.warn(`[Stripe] Unknown price ID "${priceId}" — skipping`);
          break;
        }

        const email = await resolveEmail(stripe, sub.customer);
        if (!email) { console.error('[Stripe] Could not resolve customer email'); break; }

        const user = await findUser(email);
        if (!user) { console.error(`[Stripe] User not found: ${email}`); break; }

        const planChanged = user.plan !== plan;
        await applyPlan(user.id, plan, planChanged);
        console.log(
          `[Stripe] subscription.updated: ${email} → ${plan}` +
          (planChanged ? ' (cycle reset)' : ' (same plan, credits kept)'),
        );
        break;
      }

      // ── Subscription deleted / cancelled ───────────────────────────────
      case 'customer.subscription.deleted': {
        const sub   = event.data.object as StripeTypes.Subscription;
        const email = await resolveEmail(stripe, sub.customer);
        if (!email) { console.error('[Stripe] Could not resolve customer email'); break; }

        const user = await findUser(email);
        if (!user) { console.error(`[Stripe] User not found: ${email}`); break; }

        await downgradeToFree(user.id);
        console.log(`[Stripe] subscription.deleted: ${email} → downgraded to free`);
        break;
      }

      // ── Invoice paid = billing cycle renewed ───────────────────────────
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object as StripeTypes.Invoice;

        // Only act on subscription renewals, not one-time charges
        if (invoice.billing_reason !== 'subscription_cycle' &&
            invoice.billing_reason !== 'subscription_create') break;

        const email = (invoice.customer_email ?? '').toLowerCase();
        if (!email) { console.error('[Stripe] No customer email on invoice'); break; }

        const user = await findUser(email);
        if (!user) { console.error(`[Stripe] User not found: ${email}`); break; }

        // Determine plan from the invoice line item (Stripe v22: pricing.price_details.price)
        const rawPrice = invoice.lines?.data?.[0]?.pricing?.price_details?.price;
        const priceId = typeof rawPrice === 'string' ? rawPrice : (rawPrice as StripeTypes.Price | undefined)?.id ?? '';
        const planFromInvoice = planFromPriceId(priceId);
        const plan = planFromInvoice ?? (user.plan as PlanKey);

        if (!PLAN_CONFIG[plan] || plan === 'free') break;

        await applyPlan(user.id, plan, true); // always reset on payment
        console.log(`[Stripe] invoice.paid: ${email} → credits reset (plan: ${plan})`);
        break;
      }

      // ── Invoice payment failed ─────────────────────────────────────────
      case 'invoice.payment_failed': {
        // Stripe will retry automatically. Access is not revoked here —
        // subscription.deleted fires if all retries are exhausted.
        const invoice = event.data.object as StripeTypes.Invoice;
        const email   = (invoice.customer_email ?? '').toLowerCase();
        console.warn(`[Stripe] invoice.payment_failed: ${email || '(unknown)'}`);
        break;
      }

      default:
        console.log(`[Stripe] Unhandled event type: "${event.type}" — acknowledged`);
    }

    return NextResponse.json({ received: true });

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Stripe] Error handling "${event.type}":`, message);
    return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 });
  }
}
