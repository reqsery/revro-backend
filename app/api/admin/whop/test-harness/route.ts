import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { getUser } from '@/lib/auth';
import { PLAN_CONFIG } from '@/lib/credits';
import { supabaseAdmin } from '@/lib/supabase';
import { attachPendingWhopEntitlementsForUser } from '@/lib/whop-entitlements';
import { POST as whopWebhookPOST } from '@/app/api/webhooks/whop/route';

export const dynamic = 'force-dynamic';

type Snapshot = {
  label: string;
  users: unknown[];
  entitlements: unknown[];
};

const TEST_EMAIL_DOMAIN = 'revro-whop-test.local';
const PRO_MONTHLY_PLAN_ID = 'plan_X2F8Ukz2xXIkE';
const STUDIO_MONTHLY_PLAN_ID = 'plan_NJdBfHx3gQxCF';
const TOPUP_PRODUCT_ID = 'prod_bQhlR7Fonc4Oy';

function adminEmails(): string[] {
  return (process.env.ADMIN_EMAILS || process.env.REVRO_SUPPORT_EMAILS || '')
    .split(',')
    .map((email) => email.toLowerCase().trim())
    .filter(Boolean);
}

function isDevAllowed(): boolean {
  return (process.env.NODE_ENV !== 'production' && process.env.VERCEL_ENV !== 'production')
    || process.env.ENABLE_WHOP_TEST_HARNESS === 'true'
    || process.env.DEV_ENABLE_WHOP_TEST_HARNESS === 'true';
}

async function isAuthorized(request: NextRequest): Promise<boolean> {
  const adminSecret = process.env.ADMIN_SECRET;
  const headerSecret = request.headers.get('x-admin-secret') ?? '';
  if (adminSecret && headerSecret.length === adminSecret.length && headerSecret === adminSecret) return true;

  const user = await getUser(request);
  if (!user) return false;
  return adminEmails().includes(String(user.email ?? '').toLowerCase().trim());
}

function assertCondition(condition: unknown, message: string): string {
  if (!condition) throw new Error(message);
  return message;
}

function signBody(rawBody: string): string {
  const secret = process.env.WHOP_WEBHOOK_SECRET;
  if (!secret) throw new Error('WHOP_WEBHOOK_SECRET is required to run the Whop harness');
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

function whopPayload(args: {
  action: string;
  membershipId: string;
  productId?: string;
  planId?: string;
  whopUserId: string;
  email: string;
  status?: string;
  valid?: boolean;
}) {
  return {
    action: args.action,
    data: {
      id: args.membershipId,
      product_id: args.productId,
      plan_id: args.planId,
      status: args.status ?? 'active',
      valid: args.valid ?? true,
      user: {
        id: args.whopUserId,
        email: args.email,
      },
    },
  };
}

async function callRealWebhook(payload: unknown): Promise<{ status: number; body: unknown }> {
  const rawBody = JSON.stringify(payload);
  const request = new NextRequest('http://localhost/api/webhooks/whop', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'whop-signature': signBody(rawBody),
    },
    body: rawBody,
  });
  const response = await whopWebhookPOST(request);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Webhook returned ${response.status}: ${JSON.stringify(body)}`);
  }
  return { status: response.status, body };
}

async function readRows(emails: string[], membershipIds: string[]): Promise<Omit<Snapshot, 'label'>> {
  const { data: users, error: userError } = await supabaseAdmin
    .from('users')
    .select('id, email, plan, plan_source, monthly_wallet_balance, extra_wallet_balance, wallet_spent, whop_user_id, whop_membership_id, whop_product_id, whop_plan_id')
    .in('email', emails)
    .order('email', { ascending: true });
  if (userError) throw new Error(`User snapshot failed: ${userError.message}`);

  const { data: entitlements, error: entitlementError } = await supabaseAdmin
    .from('whop_entitlements')
    .select('id, revro_user_id, buyer_email, whop_user_id, whop_membership_id, whop_product_id, whop_plan_id, plan, interval, wallet_topup_amount, status, source, last_event_action')
    .in('whop_membership_id', membershipIds)
    .order('created_at', { ascending: true });
  if (entitlementError) throw new Error(`Entitlement snapshot failed: ${entitlementError.message}`);

  return { users: users ?? [], entitlements: entitlements ?? [] };
}

async function snapshot(label: string, emails: string[], membershipIds: string[]): Promise<Snapshot> {
  const rows = await readRows(emails, membershipIds);
  return { label, ...rows };
}

async function deleteHarnessRows(emails: string[], membershipIds: string[]): Promise<void> {
  await supabaseAdmin.from('whop_entitlements').delete().in('whop_membership_id', membershipIds);
  await supabaseAdmin.from('users').delete().in('email', emails);
}

async function insertHarnessUser(id: string, email: string, plan = 'free', extraWallet = 0): Promise<void> {
  const { error } = await supabaseAdmin.from('users').insert({
    id,
    email,
    display_name: email.split('@')[0],
    plan,
    plan_source: 'whop_test_harness',
    credits_total: 25,
    credits_used: 0,
    monthly_wallet_balance: PLAN_CONFIG.free.wallet_monthly_usd,
    extra_wallet_balance: extraWallet,
    wallet_spent: 0,
    images_generated: 0,
    billing_cycle_start: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(`Harness user insert failed: ${error.message}`);
}

function byEmail(users: any[], email: string) {
  return users.find((user) => user.email === email);
}

function byMembership(entitlements: any[], membershipId: string) {
  return entitlements.find((entitlement) => entitlement.whop_membership_id === membershipId);
}

export async function POST(request: NextRequest) {
  if (!isDevAllowed() && !(await isAuthorized(request))) {
    return NextResponse.json(
      { error: 'Whop test harness is disabled in production. Enable only for admins/dev environments.' },
      { status: 403 },
    );
  }

  if (!process.env.WHOP_WEBHOOK_SECRET) {
    return NextResponse.json({ error: 'WHOP_WEBHOOK_SECRET is required' }, { status: 500 });
  }

  const runId = crypto.randomUUID().slice(0, 8);
  const existingEmail = `existing-${runId}@${TEST_EMAIL_DOMAIN}`;
  const pendingEmail = `pending-${runId}@${TEST_EMAIL_DOMAIN}`;
  const pendingSignupUserId = crypto.randomUUID();
  const topupEmail = `topup-${runId}@${TEST_EMAIL_DOMAIN}`;
  const inactiveEmail = `inactive-${runId}@${TEST_EMAIL_DOMAIN}`;
  const walletOnlyEmail = `walletonly-${runId}@${TEST_EMAIL_DOMAIN}`;
  const emails = [existingEmail, pendingEmail, topupEmail, inactiveEmail, walletOnlyEmail];

  const membershipIds = {
    existing: `ms_${runId}_existing`,
    pending: `ms_${runId}_pending`,
    topup: `ms_${runId}_topup`,
    inactive: `ms_${runId}_inactive`,
  };
  const membershipIdList = Object.values(membershipIds);

  const existingUserId = crypto.randomUUID();
  const topupUserId = crypto.randomUUID();
  const inactiveUserId = crypto.randomUUID();
  const walletOnlyUserId = crypto.randomUUID();
  const snapshots: Snapshot[] = [];
  const assertions: string[] = [];
  const webhookResponses: Record<string, unknown> = {};

  try {
    await deleteHarnessRows(emails, membershipIdList);
    await insertHarnessUser(existingUserId, existingEmail);
    await insertHarnessUser(topupUserId, topupEmail, 'pro', 2);
    await insertHarnessUser(inactiveUserId, inactiveEmail, 'studio', 4);
    await insertHarnessUser(walletOnlyUserId, walletOnlyEmail, 'free', 3000);

    snapshots.push(await snapshot('before', emails, membershipIdList));

    webhookResponses.existingActivation = await callRealWebhook(whopPayload({
      action: 'membership.went_valid',
      membershipId: membershipIds.existing,
      planId: PRO_MONTHLY_PLAN_ID,
      whopUserId: `wu_${runId}_existing`,
      email: existingEmail,
    }));

    webhookResponses.pendingActivation = await callRealWebhook(whopPayload({
      action: 'membership.went_valid',
      membershipId: membershipIds.pending,
      planId: STUDIO_MONTHLY_PLAN_ID,
      whopUserId: `wu_${runId}_pending`,
      email: pendingEmail,
    }));

    snapshots.push(await snapshot('after activation and pending', emails, membershipIdList));

    await insertHarnessUser(pendingSignupUserId, pendingEmail);
    const attached = await attachPendingWhopEntitlementsForUser(pendingSignupUserId, pendingEmail);
    assertions.push(assertCondition(attached === 1, 'pending entitlement auto-attaches on later signup/login'));

    webhookResponses.topup = await callRealWebhook(whopPayload({
      action: 'payment.succeeded',
      membershipId: membershipIds.topup,
      productId: TOPUP_PRODUCT_ID,
      whopUserId: `wu_${runId}_topup`,
      email: topupEmail,
    }));

    webhookResponses.inactive = await callRealWebhook(whopPayload({
      action: 'membership.went_invalid',
      membershipId: membershipIds.inactive,
      planId: STUDIO_MONTHLY_PLAN_ID,
      whopUserId: `wu_${runId}_inactive`,
      email: inactiveEmail,
      status: 'inactive',
      valid: false,
    }));

    snapshots.push(await snapshot('after attach topup inactive', emails, membershipIdList));
    const finalRows = snapshots[snapshots.length - 1];
    const finalUsers = finalRows.users as any[];
    const finalEntitlements = finalRows.entitlements as any[];
    const existingUser = byEmail(finalUsers, existingEmail);
    const pendingUser = byEmail(finalUsers, pendingEmail);
    const topupUser = byEmail(finalUsers, topupEmail);
    const inactiveUser = byEmail(finalUsers, inactiveEmail);
    const walletOnlyUser = byEmail(finalUsers, walletOnlyEmail);
    const pendingEntitlement = byMembership(finalEntitlements, membershipIds.pending);

    assertions.push(assertCondition(existingUser?.plan === 'pro', 'existing Revro email receives subscription plan'));
    assertions.push(assertCondition(pendingEntitlement?.status === 'claimed', 'direct Whop purchase creates and then claims pending entitlement'));
    assertions.push(assertCondition(pendingUser?.plan === 'studio', 'later signup/login receives pending plan'));
    assertions.push(assertCondition(topupUser?.plan === 'pro', 'top-up does not change plan'));
    assertions.push(assertCondition(Number(topupUser?.extra_wallet_balance ?? 0) === 7, 'top-up increases extra wallet only'));
    assertions.push(assertCondition(inactiveUser?.plan === 'free', 'inactive/cancelled event removes paid access'));
    assertions.push(assertCondition(walletOnlyUser?.plan === 'free', 'large wallet balance never upgrades plan'));

    return NextResponse.json({
      success: true,
      runId,
      note: 'Harness uses the real Whop webhook route plus attachPendingWhopEntitlementsForUser. No membership-ID customer UI is needed.',
      webhookResponses,
      assertions,
      snapshots,
    });
  } catch (error) {
    const failureSnapshot = await snapshot('failure snapshot', emails, membershipIdList).catch((snapshotError) => ({
      label: 'failure snapshot unavailable',
      users: [],
      entitlements: [],
      error: snapshotError instanceof Error ? snapshotError.message : String(snapshotError),
    }));
    return NextResponse.json(
      {
        success: false,
        runId,
        error: error instanceof Error ? error.message : String(error),
        assertions,
        snapshots: [...snapshots, failureSnapshot],
      },
      { status: 500 },
    );
  } finally {
    const keepRows = request.nextUrl.searchParams.get('keep') === '1';
    if (!keepRows) {
      await deleteHarnessRows(emails, membershipIdList).catch((cleanupError) => {
        console.warn('[Whop/test-harness] Cleanup failed', {
          runId,
          message: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        });
      });
    }
  }
}
