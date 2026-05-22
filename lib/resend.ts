import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

async function upsertContact(email: string, firstName: string): Promise<void> {
  const audienceId = process.env.RESEND_AUDIENCE_ID;
  if (!audienceId) return;
  await resend.contacts.create({ audienceId, email, firstName, unsubscribed: false }).catch(() => {});
}

/**
 * Keep lifecycle event calls fire-and-forget. Resend v3.5 has contact upsert
 * APIs but no `contacts.createEvent`, so syncing the audience is the only safe
 * work this helper can do until the automation sender is upgraded.
 */
export async function fireResendEvent(
  eventName: string,
  email: string,
  firstName: string,
  data: Record<string, unknown> = {},
): Promise<void> {
  if (!process.env.RESEND_AUDIENCE_ID) {
    console.warn('[Resend] RESEND_AUDIENCE_ID not set, skipping event', { eventName });
    return;
  }

  try {
    await upsertContact(email, firstName);
    console.log('[Resend] Contact synced for lifecycle event', {
      eventName,
      email,
      dataKeys: Object.keys(data),
    });
  } catch (error) {
    console.error('[Resend] Failed to sync lifecycle contact', { eventName, email, error });
  }
}
