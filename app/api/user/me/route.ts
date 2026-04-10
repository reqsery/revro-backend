import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';

export async function GET(request: NextRequest) {
  const user = await requireAuth(request);
  
  if (user instanceof NextResponse) {
    return user; // Return error response
  }

  return NextResponse.json({
    user: {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      plan: user.plan,
      credits: {
        used: user.credits_used,
        total: user.credits_total,
        remaining: user.credits_total - user.credits_used
      },
      imagesGenerated: user.images_generated,
      billingCycleStart: user.billing_cycle_start
    }
  });
}
